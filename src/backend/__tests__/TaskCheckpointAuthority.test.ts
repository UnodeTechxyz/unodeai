import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { ContentAssetStore, CONTENT_ASSET_TTL_MS } from '../../content/ContentAssetStore';
import {
  compileTaskContract,
  formatTaskAttemptCard,
  preflightInputGrants,
  TaskInputResolver,
  type TaskAttemptCard,
} from '../TaskContract';
import { nodeCheckpointFileSystem, TaskCheckpointStore } from '../TaskCheckpoints';
import { WorkspaceTools } from '../WorkspaceTools';
import {
  candidateFor,
  incrementalContract,
  incrementalProposal,
  settleStoreWrites,
  temporaryCheckpointStore,
} from './checkpointFixtures';

/*
 * v0.9.97 L1: the authority to save a batch is the task attempt's own, the same as for a published artifact, and a
 * stop, a closed result window or a host interruption ends it before anything of a later batch is kept.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, sections 7.1 to 7.3).
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(options: { store?: TaskCheckpointStore; assets?: ContentAssetStore } = {}) {
  const assets = options.assets ?? new ContentAssetStore();
  const resolver = new TaskInputResolver(assets, process.cwd());
  const temporary = options.store ? undefined : await temporaryCheckpointStore();
  const store = options.store ?? temporary!.store;
  const saved = vi.fn();
  resolver.setCheckpointStore(store, { saved });
  cleanups.push(async () => { await assets.dispose(); await temporary?.dispose(); });
  return { assets, resolver, store, saved, root: temporary?.root };
}

async function begin(resolver: TaskInputResolver, agentId = 'writer', overrides: Record<string, unknown> = {}): Promise<TaskAttemptCard> {
  const started = await resolver.beginAttempt(incrementalContract(overrides), candidateFor(resolver, agentId), 'pm');
  if (!started.card) throw new Error(started.error);
  resolver.bindAttemptHandle(started.card.attemptId, `handle-${agentId}`);
  return started.card;
}

const batch = (sequence: number, section: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ sequence, section, text, ...extra });

describe('the delivery plan is part of the task contract and grants nothing (§7.1)', () => {
  // §7.1: "属于原任务授权的增量工件，不增加写工作区、发送外部消息或读别的资料的权限".
  it('compiles the plan into the contract and needs no capability of its own', () => {
    const contract = incrementalContract();
    expect(contract.delivery).toEqual({
      mode: 'incremental',
      sections: [{ key: 'intro', title: 'Introduction' }, { key: 'body' }, { key: 'close' }],
      batchTarget: 'one complete section',
    });
    expect(contract.requiredCapabilities.capabilities).toEqual([]);
    // A candidate with no capability at all can take it: the plan asks for none.
    const resolver = new TaskInputResolver(new ContentAssetStore(), process.cwd());
    expect(preflightInputGrants(contract, candidateFor(resolver, 'writer', { capabilities: { read: false, write: false, shell: false } })).ok).toBe(true);
    expect(compileTaskContract(incrementalProposal({ delivery: { mode: 'incremental' } }), 'pm').error).toMatch(/sections must list/);
  });

  it('shows the executor the plan on its task card, and an ordinary task nothing of it', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    const text = formatTaskAttemptCard(card);
    expect(text).toContain('Delivery: in batches. Save each completed section with save_task_checkpoint as soon as it is ready');
    expect(text).toContain('Expected sections, in order: intro (Introduction), body, close');
    expect(text).toContain('Saving extends no wait, budget or deadline and grants no file, command or network authority.');
    const ordinary = await resolver.beginAttempt(incrementalContract({ delivery: undefined }), candidateFor(resolver, 'other'), 'pm');
    expect(formatTaskAttemptCard(ordinary.card!)).not.toContain('save_task_checkpoint');
  });
});

describe('who may save a batch (§7.2)', () => {
  // §7.2: "host 校验大小/身份/权限".
  it('saves for the live attempt of the agent executing it, and tells the host that a batch was saved', async () => {
    const { resolver, saved } = await setup();
    const card = await begin(resolver);
    const result = await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Intro.'));
    expect(result).toMatchObject({ status: 'saved', receipt: { sequence: 1, coveredSections: ['intro'] } });
    expect(saved).toHaveBeenCalledWith(card.attemptId, expect.objectContaining({ sequence: 1 }));
    expect(resolver.checkpointSummaryForHandle('handle-writer')).toMatchObject({ attemptId: card.attemptId, batches: 1, state: 'running', pinned: true });
  });

  it('refuses another agent, a task not dispatched for batches, a window without storage, and a forged field', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    expect(await resolver.saveCheckpoint(card.attemptId, 'intruder', batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'no-attempt' });
    expect(await resolver.saveCheckpoint('attempt-unknown', 'writer', batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'no-attempt' });
    const ordinary = (await resolver.beginAttempt(incrementalContract({ delivery: undefined }), candidateFor(resolver, 'plain'), 'pm')).card!;
    expect(await resolver.saveCheckpoint(ordinary.attemptId, 'plain', batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'not-incremental' });
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', { ...batch(1, 'intro', 'x'), attempt_id: card.attemptId }))
      .toMatchObject({ status: 'refused', reason: 'invalid' });

    const bare = new TaskInputResolver(new ContentAssetStore(), process.cwd());
    const bareCard = (await bare.beginAttempt(incrementalContract(), candidateFor(bare, 'writer'), 'pm')).card!;
    expect(await bare.saveCheckpoint(bareCard.attemptId, 'writer', batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'unavailable' });
    bare.setCheckpointStore(new TaskCheckpointStore({}));
    expect(await bare.saveCheckpoint(bareCard.attemptId, 'writer', batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'unavailable' });
  });

  // §6 / §7.2: "旧 attempt 输出" never lands on another attempt; the model names no attempt.
  it('keeps an old attempt\'s batch out of the new attempt of the same agent', async () => {
    const { resolver } = await setup();
    const old = await begin(resolver);
    await resolver.saveCheckpoint(old.attemptId, 'writer', batch(1, 'intro', 'Old intro.'));
    resolver.endAttempt(old.attemptId, 'settled');
    const next = (await resolver.beginAttempt(incrementalContract(), candidateFor(resolver, 'writer'), 'pm')).card!;
    expect(await resolver.saveCheckpoint(old.attemptId, 'writer', batch(2, 'body', 'Late body.'))).toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    // The host's tools save to the attempt bound to the current turn, and nothing names another.
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'writer');
    tools.setTaskInputResolver(resolver);
    tools.setTaskAttempt(next);
    expect((await tools.run('save_task_checkpoint', batch(1, 'intro', 'New intro.'))).status).toBe('success');
    expect(resolver.checkpointSummary(next.attemptId)?.batches).toBe(1);
    expect(resolver.checkpointSummary(old.attemptId)?.batches).toBe(1);
  });
});

describe('the end of an attempt comes first (§7.2, L0 §6)', () => {
  // §7.2: "取消先行就拒绝进入正式交付；已持久且取消前确认的批次保留为 cancelled-task draft".
  it('refuses a batch after a stop, and keeps the batches confirmed before it as a stopped task\'s draft', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Before the stop.'));
    resolver.endAttempt(card.attemptId, 'cancelled');
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(2, 'body', 'After the stop.'))).toMatchObject({
      status: 'refused', reason: 'attempt-ended',
      message: expect.stringContaining('Batches the host confirmed before that are kept for the person.'),
    });
    await settleStoreWrites();
    expect(resolver.checkpointSummary(card.attemptId)).toMatchObject({ state: 'cancelled', batches: 1, pinned: false });
    // The coordinator is not given a stopped task's draft; only the person recovers it.
    expect(resolver.savedBatchesForCoordinator('handle-writer', 'pm')).toEqual({
      error: expect.stringMatching(/was stopped\. Its 1 saved batch\(es\) are a stopped task's draft: only the person can open or recover them/),
    });
  });

  it('writes nothing at all for an attempt that ended before its first batch', async () => {
    const { resolver, root } = await setup();
    const card = await begin(resolver);
    resolver.endAttempt(card.attemptId, 'cancelled');
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'After the stop.')))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    expect(await readdir(root!)).toEqual([]);
  });

  it('keeps nothing of a batch whose attempt was stopped while it was being written', async () => {
    const live: { resolver?: TaskInputResolver; card?: TaskAttemptCard } = {};
    const { store, root, dispose } = await temporaryCheckpointStore({
      ...nodeCheckpointFileSystem,
      writeDurable: async (file, text) => {
        await nodeCheckpointFileSystem.writeDurable(file, text);
        // The Stop arrives after the batch is flushed and before it is renamed into place.
        if (/\d{6}\.json/.test(file)) live.resolver!.endAttempt(live.card!.attemptId, 'cancelled');
      },
    });
    cleanups.push(dispose);
    const { resolver } = await setup({ store });
    const card = await begin(resolver);
    Object.assign(live, { resolver, card });
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Racing the stop.')))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await settleStoreWrites();
    expect(await readdir(join(root, card.attemptId))).toEqual(['attempt.json']);
    // No batch was confirmed, so the store holds nothing a listing could show.
    expect(resolver.checkpointSummary(card.attemptId)).toBeUndefined();
  });

  it('takes back a batch the store confirmed when the attempt ended before the host answered', async () => {
    const live: { resolver?: TaskInputResolver; card?: TaskAttemptCard } = {};
    class EndingStore extends TaskCheckpointStore {
      override async save(...args: Parameters<TaskCheckpointStore['save']>) {
        const result = await super.save(...args);
        live.resolver!.endAttempt(live.card!.attemptId, 'cancelled');
        return result;
      }
    }
    const temporary = await temporaryCheckpointStore();
    cleanups.push(temporary.dispose);
    const { resolver } = await setup({ store: new EndingStore({ root: temporary.root }) });
    const card = await begin(resolver);
    Object.assign(live, { resolver, card });
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Answered too late.')))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await settleStoreWrites();
    expect((await readdir(join(temporary.root, card.attemptId))).filter((file) => file !== 'attempt.json')).toEqual([]);
    expect(resolver.checkpointSummary(card.attemptId)?.batches).toBe(0);
  });

  /*
   * L0 open question 3, answered here: an attempt past its result windows keeps no checkpoint right. The window's
   * close ends the attempt's grants (L0 deviation 2), and a batch is one of them. What it saved before the close
   * stays, is recorded as "result windows closed" (not a stop), and its coordinator can still read it.
   */
  it('refuses a batch after the result windows closed, and lets the coordinator read what was saved before', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Saved inside the windows.'));
    resolver.endAttempt(card.attemptId, 'cancelled', 'late-window-closed');
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(2, 'body', 'Past the windows.')))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await settleStoreWrites();
    expect(resolver.checkpointSummary(card.attemptId)?.state).toBe('window-closed');
    const read = resolver.savedBatchesForCoordinator('handle-writer', 'pm');
    expect('batches' in read && read.batches.map((record) => record.text)).toEqual(['Saved inside the windows.']);
  });

  // §6: a host restart or a lost worker revokes the attempt's grants as well.
  it('refuses a batch of an interrupted attempt, and reads it as interrupted work, not a stop', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Before the loss.'));
    resolver.endAttempt(card.attemptId, 'interrupted');
    expect(await resolver.saveCheckpoint(card.attemptId, 'writer', batch(2, 'body', 'x'))).toMatchObject({ reason: 'attempt-ended' });
    await settleStoreWrites();
    expect(resolver.checkpointSummary(card.attemptId)?.state).toBe('interrupted');
    expect('batches' in resolver.savedBatchesForCoordinator('handle-writer', 'pm')).toBe(true);
  });

  it('gives no coordinator but the dispatching one any batch of the handle', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Secret draft.'));
    expect(resolver.savedBatchesForCoordinator('handle-writer', 'other-pm')).toEqual({ error: 'no saved batches are known for handle handle-writer' });
    expect(await resolver.publishSavedBatchesArtifact('handle-writer', 'other-pm')).toEqual({ error: 'no saved batches are known for handle handle-writer' });
  });
});

describe('the final check reads the attempt\'s own input receipts (§7.2)', () => {
  // §7.2: "缺章、冲突、未满足 required inputs 仍不算完成".
  it('is incomplete while a required input has no observed read, even with every section saved', async () => {
    const assets = new ContentAssetStore();
    const { resolver } = await setup({ assets });
    const source = await assets.storeText('Source facts.', 'user-attachment');
    if ('error' in source) throw new Error('not stored');
    const card = (await resolver.beginAttempt(incrementalContract({
      inputs: [{
        input_id: 'facts', kind: 'contentAsset', asset_id: source.assetId, purpose: 'Facts to use', required: true,
        freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      }],
      required_capabilities: { version: 1, capabilities: ['read'] },
    }), candidateFor(resolver, 'writer', { authorizedContentAssetIds: [source.assetId], liveContentAssetIds: [source.assetId] }), 'pm')).card!;
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'I.'));
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(2, 'body', 'B.'));
    const unread = await resolver.saveCheckpoint(card.attemptId, 'writer', batch(3, 'close', 'C.', { final_candidate: true }));
    expect(unread).toMatchObject({ status: 'saved', receipt: { finalCheck: { status: 'incomplete', missingSections: [], requiredInputsNotRead: 1 } } });
    resolver.noteRead(card.attemptId, 'writer', source.assetId);
    expect(resolver.checkpointSummary(card.attemptId)?.finalCheck).toMatchObject({ status: 'complete', requiredInputsNotRead: 0 });
  });
});

describe('partial work as the next task\'s input is the coordinator\'s explicit choice (§7.2)', () => {
  // §7.2: "partial 能否作下一任务输入需 coordinator 明确选择、保留不完整标记和既有 grant，不能自动扩大可见范围".
  it('publishes the selection with the producing task\'s provenance and an incomplete mark that the next card shows', async () => {
    const assets = new ContentAssetStore();
    const { resolver } = await setup({ assets });
    const source = await assets.storeText('Private source.', 'user-attachment');
    if ('error' in source) throw new Error('not stored');
    const card = (await resolver.beginAttempt(incrementalContract({
      inputs: [{
        input_id: 'facts', kind: 'contentAsset', asset_id: source.assetId, purpose: 'Facts', required: false,
        freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      }],
      required_capabilities: { version: 1, capabilities: ['read'] },
    }), candidateFor(resolver, 'writer', { authorizedContentAssetIds: [source.assetId], liveContentAssetIds: [source.assetId] }), 'pm')).card!;
    resolver.bindAttemptHandle(card.attemptId, 'handle-writer');
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Intro draft.'));
    // Nothing becomes an input by being saved.
    expect(resolver.readyArtifacts()).toEqual([]);
    const published = await resolver.publishSavedBatchesArtifact('handle-writer', 'pm');
    const artifact = published.artifact!;
    expect(artifact).toMatchObject({
      producerAttemptId: card.attemptId, delegableByAgentIds: ['pm'],
      provenance: [{ producerAttemptId: card.attemptId, inputId: 'facts', kind: 'contentAsset' }],
      partialWork: { completeness: 'incomplete', finalCheck: expect.stringMatching(/^INCOMPLETE: missing body, close/) },
    });

    // The next task gets the artifact, marked, and nothing of the producing task's own grants.
    const next = (await resolver.beginAttempt(incrementalContract({
      inputs: [{
        input_id: 'draft', kind: 'upstreamArtifact', artifact_id: artifact.artifactId, purpose: 'Continue the draft', required: true,
        freshness: 'artifact-ready', provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [artifact.artifactId],
      required_capabilities: { version: 1, capabilities: ['read'] },
    }), candidateFor(resolver, 'editor'), 'pm')).card!;
    expect(next.grants.map((grant) => grant.inputId)).toEqual(['draft']);
    expect(resolver.canReadContentAsset(next.attemptId, 'editor', source.assetId)).toBe(false);
    expect(next.grants[0].partialWork).toEqual(artifact.partialWork);
    expect(formatTaskAttemptCard(next)).toMatch(/- draft \[upstreamArtifact; required\]: Continue the draft — read with extracted-content tools as content-\d+ — partial work from saved batches, final check INCOMPLETE: missing body, close/);
  });

  it('refuses to publish a stopped task\'s draft, and a handle with nothing saved', async () => {
    const { resolver } = await setup();
    const card = await begin(resolver);
    expect(await resolver.publishSavedBatchesArtifact('handle-writer', 'pm')).toEqual({ error: 'no saved batches are known for handle handle-writer' });
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Draft.'));
    resolver.endAttempt(card.attemptId, 'cancelled');
    await settleStoreWrites();
    expect((await resolver.publishSavedBatchesArtifact('handle-writer', 'pm')).error).toMatch(/stopped task's draft/);
  });
});

describe('a temporary content asset is not a saved batch (§7.2)', () => {
  // §7.2: "不能借 ephemeral asset 的30分钟TTL伪装成持久保存".
  it('lets a published artifact expire with its 30-minute asset while the saved batches stay', async () => {
    let now = 1_000_000;
    const assets = new ContentAssetStore({ now: () => now });
    const { resolver } = await setup({ assets });
    const card = await begin(resolver);
    await resolver.publishArtifact(card.attemptId, 'writer', 'Whole draft as an artifact.');
    await resolver.saveCheckpoint(card.attemptId, 'writer', batch(1, 'intro', 'Saved intro.'));
    resolver.endAttempt(card.attemptId, 'settled');
    const fromBatches = (await resolver.publishSavedBatchesArtifact('handle-writer', 'pm')).artifact!;
    expect(resolver.readyArtifacts().length).toBe(2);

    now += CONTENT_ASSET_TTL_MS + 1;
    expect(resolver.readyArtifacts()).toEqual([]);
    expect(resolver.liveContentAssetIds([fromBatches.contentAssetId])).toEqual([]);
    const read = resolver.savedBatchesForCoordinator('handle-writer', 'pm');
    expect('batches' in read && read.batches.map((record) => record.text)).toEqual(['Saved intro.']);
    // And the selection can be published again from the durable batches.
    expect((await resolver.publishSavedBatchesArtifact('handle-writer', 'pm')).artifact).toBeDefined();
  });
});


describe('the reminder that a batch is due rides on a host tool result (§7.1)', () => {
  // §7.1: "有可读成果即在下个受支持安全工具边界提交"; no stdin, no extra turn, no resend.
  it('adds the reminder once to the next result of a host tool, never to a refusal or to the save itself', async () => {
    const { resolver, store } = await setup();
    const due = vi.fn(() => '[host] A batch is due: test.');
    resolver.setCheckpointStore(store, { due });
    const card = await begin(resolver);
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'writer');
    tools.setTaskInputResolver(resolver);
    tools.setTaskAttempt(card);

    const saved = await tools.run('save_task_checkpoint', batch(1, 'intro', 'Intro.'));
    expect(saved.output).not.toContain('[host] A batch is due');
    const refused = await tools.run('write_file', { path: 'x.txt', content: 'x' });
    expect(refused.status).toBe('refused');
    expect(refused.output).not.toContain('[host] A batch is due');
    const listed = await tools.run('list_dir', { path: '.' });
    expect(listed.output.endsWith('\n\n[host] A batch is due: test.')).toBe(true);
    expect(due).toHaveBeenCalledWith(card.attemptId);

    // An ordinary task is never reminded.
    const plain = (await resolver.beginAttempt(incrementalContract({ delivery: undefined }), candidateFor(resolver, 'writer'), 'pm')).card!;
    due.mockClear();
    tools.setTaskAttempt(plain);
    expect((await tools.run('list_dir', { path: '.' })).output).not.toContain('[host] A batch is due');
    expect(due).not.toHaveBeenCalled();
  });
});
