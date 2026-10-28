import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CHECKPOINT_RETENTION_MS,
  CHECKPOINT_WORKSPACE_RECLAIM_BYTES,
  checkpointFinalCheck,
  formatSavedBatches,
  nodeCheckpointFileSystem,
  parseCheckpointRequest,
  parseDeliveryPlan,
  TaskCheckpointStore,
  type CheckpointAttemptContext,
  type CheckpointFileSystem,
  type CheckpointRequest,
  type IncrementalDeliveryPlan,
  type TaskCheckpointRecord,
} from '../TaskCheckpoints';

/*
 * v0.9.97 L1: a long task delivers in batches, and every batch the host confirms is durable before it is confirmed.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 7.2).
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unode-task-checkpoints-'));
  roots.push(dir);
  return dir;
}

const PLAN: IncrementalDeliveryPlan = {
  mode: 'incremental',
  sections: [{ key: 'intro', title: 'Introduction' }, { key: 'body' }, { key: 'close' }],
};

function context(overrides: Partial<CheckpointAttemptContext> = {}): CheckpointAttemptContext {
  return {
    attemptId: `attempt-${randomUUID()}`,
    agentId: 'writer',
    coordinatorId: 'pm',
    contractId: 'contract-1',
    handle: 'handle-1',
    objective: 'Draft the article.',
    plan: PLAN,
    requiredInputCount: 0,
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function batch(sequence: number, sectionKey: string, text: string, extra: Partial<CheckpointRequest> = {}): CheckpointRequest {
  return { sequence, sectionKey, text, revision: 1, finalCandidate: false, ...extra };
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The real file system, with one operation replaced. */
function failingFs(overrides: Partial<CheckpointFileSystem>): CheckpointFileSystem {
  return { ...nodeCheckpointFileSystem, ...overrides };
}

describe('the delivery plan in a task contract (§7.1)', () => {
  // §7.1: "协调任务卡可声明 deliveryMode: incremental、预期章节/阶段、每批目标大小、总截止/费用预算与最终验收条件".
  it('accepts an incremental plan with ordered sections, and absence or single mode as one final reply', () => {
    expect(parseDeliveryPlan(undefined)).toEqual({});
    expect(parseDeliveryPlan({ mode: 'single' })).toEqual({});
    expect(parseDeliveryPlan({
      mode: 'incremental',
      sections: [{ key: 'intro', title: ' Introduction ' }, { key: 'body' }],
      batch_target: 'one complete section, about 800-1,200 words',
      final_acceptance: 'every section saved',
      time_budget_minutes: 20,
    })).toEqual({
      plan: {
        mode: 'incremental',
        sections: [{ key: 'intro', title: 'Introduction' }, { key: 'body' }],
        batchTarget: 'one complete section, about 800-1,200 words',
        finalAcceptance: 'every section saved',
        timeBudgetMinutes: 20,
      },
    });
  });

  it('refuses a plan without sections, with a repeated or malformed key, or with a field it does not define', () => {
    expect(parseDeliveryPlan({ mode: 'incremental' }).error).toMatch(/sections must list at least one/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [] }).error).toMatch(/sections must list/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [{ key: 'a' }, { key: 'a' }] }).error).toMatch(/repeats key "a"/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [{ key: 'Bad Key' }] }).error).toMatch(/key must be/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [{ key: 'a', words: 9 }] }).error).toMatch(/only key and title/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [{ key: 'a' }], budget_usd: 3 }).error).toMatch(/unsupported field "budget_usd"/);
    expect(parseDeliveryPlan({ mode: 'single', sections: [{ key: 'a' }] }).error).toMatch(/takes no other field/);
    expect(parseDeliveryPlan({ mode: 'incremental', sections: [{ key: 'a' }], time_budget_minutes: 0 }).error).toMatch(/1 to 240/);
    expect(parseDeliveryPlan({ mode: 'batch' }).error).toMatch(/must be "single" or "incremental"/);
  });
});

describe('what the model may send (§7.2)', () => {
  // §7.2: "模型只能给正文/章节元数据，不能伪造 host 身份和 receipt".
  it('takes only text and section metadata, and refuses a host-made field by name', () => {
    expect(parseCheckpointRequest({ sequence: 1, section: 'intro', text: 'Hello.' }).request).toEqual({
      sequence: 1, sectionKey: 'intro', text: 'Hello.', revision: 1, finalCandidate: false,
    });
    for (const forged of ['attempt_id', 'checkpointId', 'sha256', 'covered_sections', 'remaining_sections', 'agent']) {
      expect(parseCheckpointRequest({ sequence: 1, section: 'intro', text: 'x', [forged]: 'host' }).error)
        .toMatch(new RegExp(`"${forged}" is not an argument.*the host makes the attempt, the digest and the receipt`));
    }
    expect(parseCheckpointRequest({ sequence: 0, section: 'intro', text: 'x' }).error).toMatch(/sequence must be/);
    expect(parseCheckpointRequest({ sequence: 1.5, section: 'intro', text: 'x' }).error).toMatch(/sequence must be/);
    expect(parseCheckpointRequest({ sequence: 1, section: 'intro', text: '   ' }).error).toMatch(/non-empty/);
    expect(parseCheckpointRequest({ sequence: 1, section: 'intro', text: 'x', revision: 0 }).error).toMatch(/revision/);
    expect(parseCheckpointRequest({ sequence: 1, section: 'intro', text: 'x', final_candidate: 'yes' }).error).toMatch(/true or false/);
  });
});

describe('a saved batch is durable before it is confirmed (§7.2)', () => {
  // §7.2: "host 校验大小/身份/权限并持久提交后才返回 checkpointId/hash/bytes/revision".
  it('writes the batch to disk before it returns the host-made receipt', async () => {
    const dir = await root();
    const store = new TaskCheckpointStore({ root: dir });
    const ctx = context();
    const saved = await store.save(ctx, batch(1, 'intro', 'The first section.'));
    if (saved.status !== 'saved') throw new Error(saved.message);
    expect(saved.receipt).toMatchObject({
      sequence: 1, sectionKey: 'intro', revision: 1, bytes: 18, contentSha256: sha('The first section.'),
      coveredSections: ['intro'], remainingSections: ['body', 'close'], batchesSaved: 1, replay: false,
    });
    expect(saved.receipt.checkpointId).toMatch(/^ckpt-[0-9a-f-]{36}$/);
    // On disk exactly as confirmed, with no temporary file left beside it.
    const files = await readdir(join(dir, ctx.attemptId));
    expect(files.sort()).toEqual(['000001.json', 'attempt.json']);
    const record = JSON.parse(await readFile(join(dir, ctx.attemptId, '000001.json'), 'utf8')) as TaskCheckpointRecord;
    expect(record).toMatchObject({ checkpointId: saved.receipt.checkpointId, text: 'The first section.', contentSha256: sha('The first section.') });
  });

  // §7.2: "同一 (attempt, sequence, digest) 重试幂等".
  it('answers a retry of the same batch with the same receipt and writes nothing new', async () => {
    const dir = await root();
    const store = new TaskCheckpointStore({ root: dir });
    const ctx = context();
    const first = await store.save(ctx, batch(1, 'intro', 'Same text.'));
    const again = await store.save(ctx, batch(1, 'intro', 'Same text.'));
    if (first.status !== 'saved' || again.status !== 'saved') throw new Error('not saved');
    expect(again.receipt.checkpointId).toBe(first.receipt.checkpointId);
    expect(again.receipt.replay).toBe(true);
    expect(store.summary(ctx.attemptId)?.batches).toBe(1);
    expect((await readdir(join(dir, ctx.attemptId))).filter((file) => file !== 'attempt.json')).toEqual(['000001.json']);
  });

  // §7.2: "同序不同内容拒绝".
  it('refuses the same sequence with other content, and keeps the batch already confirmed', async () => {
    const dir = await root();
    const store = new TaskCheckpointStore({ root: dir });
    const ctx = context();
    const first = await store.save(ctx, batch(1, 'intro', 'Original.'));
    const conflict = await store.save(ctx, batch(1, 'intro', 'Rewritten.'));
    expect(conflict).toMatchObject({ status: 'refused', reason: 'sequence-conflict' });
    if (conflict.status === 'refused') expect(conflict.message).toMatch(/already saved with different content.*Send a new batch as sequence 2/);
    // The same text under another section is a different batch too.
    expect(await store.save(ctx, batch(1, 'body', 'Original.'))).toMatchObject({ status: 'refused', reason: 'sequence-conflict' });
    const kept = store.selectedBatches(ctx.attemptId);
    expect(kept.map((record) => [record.sequence, record.text])).toEqual([[1, 'Original.']]);
    expect(first.status === 'saved' && kept[0].checkpointId === first.receipt.checkpointId).toBe(true);
  });

  it('refuses a batch out of order and names the next sequence', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const ctx = context();
    expect(await store.save(ctx, batch(2, 'intro', 'Skipped one.'))).toMatchObject({ status: 'refused', reason: 'sequence-out-of-order' });
    await store.save(ctx, batch(1, 'intro', 'First.'));
    const late = await store.save(ctx, batch(3, 'body', 'Third.'));
    expect(late).toMatchObject({ status: 'refused', reason: 'sequence-out-of-order' });
    if (late.status === 'refused') expect(late.message).toMatch(/the next batch of this task is sequence 2, not 3/);
  });

  it('refuses a section the plan does not expect', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const refused = await store.save(context(), batch(1, 'appendix', 'Extra.'));
    expect(refused).toMatchObject({ status: 'refused', reason: 'unknown-section' });
    if (refused.status === 'refused') expect(refused.message).toMatch(/Expected: intro, body, close/);
  });

  // §7.2: "修订已有章节使用显式新 revision 和 supersedes，不重复追加".
  it('revises a saved section only with the next revision naming the one it supersedes', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const ctx = context();
    const first = await store.save(ctx, batch(1, 'intro', 'Draft one.'));
    if (first.status !== 'saved') throw new Error('not saved');
    // Saving the section again as if it were new is refused, not appended.
    const duplicate = await store.save(ctx, batch(2, 'intro', 'Draft two.'));
    expect(duplicate).toMatchObject({ status: 'refused', reason: 'revision-conflict' });
    if (duplicate.status === 'refused') expect(duplicate.message).toContain(`send revision 2 with supersedes "${first.receipt.checkpointId}"`);
    expect(await store.save(ctx, batch(2, 'intro', 'Draft two.', { revision: 2, supersedes: 'ckpt-not-it' })))
      .toMatchObject({ status: 'refused', reason: 'revision-conflict' });
    expect(await store.save(ctx, batch(2, 'intro', 'Draft two.', { revision: 3, supersedes: first.receipt.checkpointId })))
      .toMatchObject({ status: 'refused', reason: 'revision-conflict' });
    expect(await store.save(ctx, batch(2, 'body', 'Body.', { revision: 2, supersedes: first.receipt.checkpointId })))
      .toMatchObject({ status: 'refused', reason: 'revision-conflict' });
    const revised = await store.save(ctx, batch(2, 'intro', 'Draft two.', { revision: 2, supersedes: first.receipt.checkpointId }));
    expect(revised).toMatchObject({ status: 'saved', receipt: { revision: 2, coveredSections: ['intro'] } });
    // The final check selects the latest revision; the superseded one is kept but not selected.
    expect(store.selectedBatches(ctx.attemptId).map((record) => [record.sectionKey, record.revision, record.text]))
      .toEqual([['intro', 2, 'Draft two.']]);
    expect(store.summary(ctx.attemptId)?.batches).toBe(2);
  });
});

/** The former v0.9.97 limits, kept here only to test the old totals plus continued work. */
const FORMER_BATCH_MAX_BYTES = 256 * 1024;
const FORMER_ATTEMPT_MAX_BYTES = 2 * 1024 * 1024;
const FORMER_MAX_SECTIONS = 32;

describe('v0.9.99: saved batches never stop the work they protect', () => {
  it('saves a batch past the former 256 KiB limit, and a new window reads it back whole', async () => {
    const dir = await root();
    const store = new TaskCheckpointStore({ root: dir });
    const ctx = context();
    // Two bytes per character: one more byte than the former limit, counted in UTF-8.
    const wide = 'é'.repeat(FORMER_BATCH_MAX_BYTES / 2) + 'a';
    const saved = await store.save(ctx, batch(1, 'intro', wide));
    expect(saved).toMatchObject({ status: 'saved', receipt: { bytes: FORMER_BATCH_MAX_BYTES + 1 } });

    const reopened = new TaskCheckpointStore({ root: dir });
    expect(await reopened.load()).toMatchObject({ batches: 1, damaged: 0 });
    expect(reopened.selectedBatches(ctx.attemptId).map((record) => record.text)).toEqual([wide]);
  });

  it('keeps receiving a task\'s batches past the former 2 MiB total, and the final check completes', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const sections = Array.from({ length: 9 }, (_, index) => ({ key: `s${index + 1}` }));
    const ctx = context({ plan: { mode: 'incremental', sections } });
    const full = 'x'.repeat(FORMER_BATCH_MAX_BYTES);
    for (let sequence = 1; sequence <= 8; sequence++) {
      expect(await store.save(ctx, batch(sequence, `s${sequence}`, full))).toMatchObject({ status: 'saved' });
    }
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 8, bytes: FORMER_ATTEMPT_MAX_BYTES });
    // The batch the former total refused.
    const ninth = await store.save(ctx, batch(9, 's9', 'one more', { finalCandidate: true }));
    expect(ninth).toMatchObject({ status: 'saved', receipt: { batchesSaved: 9, remainingSections: [], finalCheck: { status: 'complete' } } });
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 9, bytes: FORMER_ATTEMPT_MAX_BYTES + 8 });
  });

  it('accepts a plan of more sections than the former 32, and saves every one', async () => {
    const sections = Array.from({ length: FORMER_MAX_SECTIONS + 8 }, (_, index) => ({ key: `part-${index + 1}` }));
    const { plan, error } = parseDeliveryPlan({ mode: 'incremental', sections });
    expect(error).toBeUndefined();
    expect(plan!.sections).toHaveLength(40);
    const store = new TaskCheckpointStore({ root: await root() });
    const ctx = context({ plan: plan! });
    for (const [index, section] of sections.entries()) {
      expect(await store.save(ctx, batch(index + 1, section.key, `Text of ${section.key}.`))).toMatchObject({ status: 'saved' });
    }
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 40, remainingSections: [], finalCheck: { status: 'complete' } });
  });

  // Past the housekeeping point: finished history nothing refers to goes first; drafts, running and referenced tasks
  // stay; and the new batch is saved whatever is left.
  it('past the former 16 MiB workspace total, reclaims only finished unreferenced history and saves the batch', async () => {
    let referenced = '';
    const dir = await root();
    const store = new TaskCheckpointStore({ root: dir, isReferenced: (attemptId) => attemptId === referenced });
    const quarter = CHECKPOINT_WORKSPACE_RECLAIM_BYTES / 4;
    const sections = [{ key: 's1' }, { key: 's2' }, { key: 's3' }, { key: 's4' }];
    const plan: IncrementalDeliveryPlan = { mode: 'incremental', sections };
    const fill = async (ctx: CheckpointAttemptContext, at: number) => {
      // Four batches of a quarter of a quarter each: one quarter of the housekeeping point per attempt.
      for (let sequence = 1; sequence <= 4; sequence++) {
        const text = String.fromCharCode(96 + at).repeat(quarter / 4);
        expect(await store.save(ctx, batch(sequence, `s${sequence}`, text))).toMatchObject({ status: 'saved' });
      }
    };
    const finishedOld = context({ plan, startedAt: new Date(1).toISOString() });
    const finishedReferenced = context({ plan, startedAt: new Date(2).toISOString() });
    const stopped = context({ plan, startedAt: new Date(3).toISOString() });
    const running = context({ plan, startedAt: new Date(4).toISOString() });
    await fill(finishedOld, 1);
    await fill(finishedReferenced, 2);
    await fill(stopped, 3);
    await fill(running, 4);
    await store.attemptEnded(finishedOld.attemptId, 'settled');
    await store.attemptEnded(finishedReferenced.attemptId, 'settled');
    await store.attemptEnded(stopped.attemptId, 'cancelled');
    referenced = finishedReferenced.attemptId;
    expect(store.list().reduce((sum, entry) => sum + entry.bytes, 0)).toBe(CHECKPOINT_WORKSPACE_RECLAIM_BYTES);

    // The batch the former workspace total refused.
    const next = context({ plan });
    const saved = await store.save(next, batch(1, 's1', 'small'));
    expect(saved).toMatchObject({ status: 'saved' });
    expect(store.summary(finishedOld.attemptId)?.removed).toMatchObject({ reason: 'reclaimed' });
    expect(store.summary(finishedReferenced.attemptId)).toMatchObject({ batches: 4 });
    expect(store.summary(stopped.attemptId)).toMatchObject({ batches: 4, state: 'cancelled' });
    expect(store.summary(running.attemptId)).toMatchObject({ batches: 4, pinned: true });
    // Its files are gone from disk; the record that says so stays, and a new window reads it.
    expect((await readdir(join(dir, finishedOld.attemptId))).sort()).toEqual(['attempt.json']);
    const reopened = new TaskCheckpointStore({ root: dir });
    await reopened.load();
    expect(reopened.summary(finishedOld.attemptId)?.removed).toMatchObject({ reason: 'reclaimed' });

    // Nothing more is eligible: the drafts and the referenced task stay, and work is still received.
    for (let sequence = 2; sequence <= 4; sequence++) {
      expect(await store.save(next, batch(sequence, `s${sequence}`, 'n'.repeat(quarter / 2)))).toMatchObject({ status: 'saved' });
    }
    expect(store.list().reduce((sum, entry) => sum + entry.bytes, 0)).toBeGreaterThan(CHECKPOINT_WORKSPACE_RECLAIM_BYTES);
    expect(store.summary(finishedReferenced.attemptId)).toMatchObject({ batches: 4 });
    expect(store.summary(stopped.attemptId)).toMatchObject({ batches: 4 });
    expect(store.summary(next.attemptId)).toMatchObject({ batches: 4, remainingSections: [] });
  // Writes about 20 MiB of real files.
  }, 30_000);

  it('keeps a finished task\'s batches when it cannot tell whether something still refers to them', async () => {
    const store = new TaskCheckpointStore({ root: await root(), isReferenced: () => { throw new Error('not known'); } });
    const finished = context();
    await store.save(finished, batch(1, 'intro', 'f'.repeat(CHECKPOINT_WORKSPACE_RECLAIM_BYTES)));
    await store.attemptEnded(finished.attemptId, 'settled');
    expect(await store.save(context(), batch(1, 'intro', 'next'))).toMatchObject({ status: 'saved' });
    expect(store.summary(finished.attemptId)).toMatchObject({ batches: 1 });
    expect(store.summary(finished.attemptId)?.removed).toBeUndefined();
  }, 30_000);

  it('never tells anyone to delete saved batches', async () => {
    const source = await readFile(join(__dirname, '..', 'TaskCheckpoints.ts'), 'utf8');
    expect(source).not.toMatch(/delete (old )?saved batches/i);
    expect(source).not.toMatch(/Split the section/);
  });
});

describe('a write that fails confirms nothing (§7.2)', () => {
  // §7.2: "写入失败无确认".
  it('refuses with the disk error when the batch cannot be written, and saves the same batch once the disk recovers', async () => {
    const dir = await root();
    let full = true;
    const store = new TaskCheckpointStore({
      root: dir,
      fs: failingFs({
        writeDurable: async (file, text) => {
          if (full && /\d{6}\.json/.test(file)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          await nodeCheckpointFileSystem.writeDurable(file, text);
        },
      }),
    });
    const ctx = context();
    const refused = await store.save(ctx, batch(1, 'intro', 'Lost if not saved.'));
    expect(refused).toMatchObject({ status: 'refused', reason: 'persist-failed' });
    if (refused.status === 'refused') {
      expect(refused.message).toMatch(/\(ENOSPC\)\. It was NOT saved/);
      // v0.9.99: the model is told to go on with the task, not to stop or ask.
      expect(refused.message).toMatch(/Continue the task: keep this section and deliver it in your reply/);
    }
    expect(store.summary(ctx.attemptId)).toBeUndefined();
    expect((await readdir(join(dir, ctx.attemptId))).filter((file) => file !== 'attempt.json')).toEqual([]);

    full = false;
    expect(await store.save(ctx, batch(1, 'intro', 'Lost if not saved.'))).toMatchObject({ status: 'saved', receipt: { replay: false } });
  });

  it('removes the flushed temporary file when the rename into place fails', async () => {
    const dir = await root();
    const store = new TaskCheckpointStore({
      root: dir,
      fs: failingFs({
        rename: async (from, to) => {
          if (/\d{6}\.json$/.test(to)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
          await nodeCheckpointFileSystem.rename(from, to);
        },
      }),
    });
    const ctx = context();
    expect(await store.save(ctx, batch(1, 'intro', 'Text.'))).toMatchObject({ status: 'refused', reason: 'persist-failed' });
    expect(await readdir(join(dir, ctx.attemptId))).toEqual(['attempt.json']);
  });

  it('says so when this window has no workspace storage', async () => {
    const store = new TaskCheckpointStore({});
    expect(store.available).toBe(false);
    expect(await store.save(context(), batch(1, 'intro', 'x'))).toMatchObject({ status: 'refused', reason: 'unavailable' });
  });
});

describe('crashes and reloads (§7.2)', () => {
  // §7.2: "确认前 crash 与确认后回调丢失各有测试".
  it('after a crash before the confirm, the next window removes the partial write and lists nothing of it', async () => {
    const dir = await root();
    const ctx = context();
    const first = new TaskCheckpointStore({ root: dir });
    await first.save(ctx, batch(1, 'intro', 'Confirmed.'));
    // The host died after flushing batch 2 to its temporary name, before the rename that confirms it.
    await writeFile(join(dir, ctx.attemptId, `000002.json.tmp-${randomUUID()}`), JSON.stringify({ text: 'Never confirmed.' }));
    const reloaded = new TaskCheckpointStore({ root: dir });
    expect(await reloaded.load()).toMatchObject({ attempts: 1, batches: 1, discardedUnconfirmed: 1, damaged: 0 });
    expect(reloaded.selectedBatches(ctx.attemptId).map((record) => record.text)).toEqual(['Confirmed.']);
    expect((await readdir(join(dir, ctx.attemptId))).sort()).toEqual(['000001.json', 'attempt.json']);
  });

  it('after the confirm was lost, a retry gets the same receipt, and a new window still lists the batch', async () => {
    const dir = await root();
    const ctx = context();
    const store = new TaskCheckpointStore({ root: dir });
    const confirmed = await store.save(ctx, batch(1, 'intro', 'Saved, answer lost.'));
    // The model never saw the answer and sends the batch again.
    const retry = await store.save(ctx, batch(1, 'intro', 'Saved, answer lost.'));
    if (confirmed.status !== 'saved' || retry.status !== 'saved') throw new Error('not saved');
    expect(retry.receipt).toMatchObject({ checkpointId: confirmed.receipt.checkpointId, replay: true });

    const reloaded = new TaskCheckpointStore({ root: dir });
    await reloaded.load();
    expect(reloaded.summaryForHandle('handle-1')).toMatchObject({
      attemptId: ctx.attemptId, batches: 1, coordinatorId: 'pm',
      // The record says running, but no attempt of the new window has its id.
      state: 'not-running-here', pinned: false,
    });
  });

  it('never lists a batch whose text does not match its digest, and leaves it on disk', async () => {
    const dir = await root();
    const ctx = context();
    await new TaskCheckpointStore({ root: dir }).save(ctx, batch(1, 'intro', 'Original.'));
    const file = join(dir, ctx.attemptId, '000001.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...record, text: 'Edited on disk.' }));
    const reloaded = new TaskCheckpointStore({ root: dir });
    expect(await reloaded.load()).toMatchObject({ batches: 0, damaged: 1 });
    expect(reloaded.selectedBatches(ctx.attemptId)).toEqual([]);
    expect(await readFile(file, 'utf8')).toContain('Edited on disk.');
  });

  it('keeps the attempt\'s end on disk, with its retention period from then', async () => {
    let now = 1_000;
    const dir = await root();
    const ctx = context();
    const store = new TaskCheckpointStore({ root: dir, now: () => now });
    await store.save(ctx, batch(1, 'intro', 'Before the stop.'));
    expect(store.summary(ctx.attemptId)).toMatchObject({ state: 'running', pinned: true });
    expect(store.summary(ctx.attemptId)?.expiresAt).toBeUndefined();
    now = 5_000;
    await store.attemptEnded(ctx.attemptId, 'cancelled');
    const reloaded = new TaskCheckpointStore({ root: dir, now: () => now });
    await reloaded.load();
    expect(reloaded.summary(ctx.attemptId)).toMatchObject({
      state: 'cancelled', endedAt: new Date(5_000).toISOString(), pinned: false,
      expiresAt: new Date(5_000 + CHECKPOINT_RETENTION_MS).toISOString(),
    });
  });
});

describe('the person deletes, and retention removes, only what the record then says is gone (§7.2)', () => {
  // §7.2: "提供查看/删除 … 删除/过期后清楚显示 unavailable".
  it('deletes an ended task\'s batches on request, refuses while it runs, and records the deletion', async () => {
    const dir = await root();
    const ctx = context();
    const store = new TaskCheckpointStore({ root: dir });
    await store.save(ctx, batch(1, 'intro', 'Work.'));
    expect(await store.deleteAttempt(ctx.attemptId)).toBe('running');
    expect(store.summary(ctx.attemptId)?.batches).toBe(1);
    await store.attemptEnded(ctx.attemptId, 'settled');
    expect(await store.deleteAttempt(ctx.attemptId)).toBe('deleted');
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 0, removed: { reason: 'deleted' } });
    expect(store.selectedBatches(ctx.attemptId)).toEqual([]);
    expect((await readdir(join(dir, ctx.attemptId)))).toEqual(['attempt.json']);
    // A new window says the same.
    const reloaded = new TaskCheckpointStore({ root: dir });
    await reloaded.load();
    expect(reloaded.list()).toEqual([expect.objectContaining({ attemptId: ctx.attemptId, removed: expect.objectContaining({ reason: 'deleted' }) })]);
  });

  // §7.2: "完成/取消后最多保留 30 天".
  it('removes an ended task\'s batches 30 days after its end, never a running task\'s', async () => {
    let now = 0;
    const store = new TaskCheckpointStore({ root: await root(), now: () => now });
    const ended = context();
    const running = context();
    await store.save(ended, batch(1, 'intro', 'Ended task.'));
    await store.save(running, batch(1, 'intro', 'Running task.'));
    await store.attemptEnded(ended.attemptId, 'settled');
    now = CHECKPOINT_RETENTION_MS - 1;
    expect(await store.pruneExpired()).toBe(0);
    now = CHECKPOINT_RETENTION_MS * 3;
    expect(await store.pruneExpired()).toBe(1);
    expect(store.summary(ended.attemptId)?.removed).toMatchObject({ reason: 'expired' });
    expect(store.summary(running.attemptId)).toMatchObject({ batches: 1, pinned: true });
  });

  /**
   * Codex's audit of the first L1 commit: a deletion asked while an attempt's first save held its lock was decided
   * before that save pinned the attempt, then ran after it and removed the batch the save had just confirmed. §7.2:
   * "running attempt 的 checkpoints 被 pin". The order is set by holding the record's write open, never by timing.
   */
  function heldRecordWrite() {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    let hold = false;
    const fs = failingFs({
      writeDurable: async (file, text) => {
        await nodeCheckpointFileSystem.writeDurable(file, text);
        if (hold && /\d{6}\.json/.test(file)) {
          hold = false;
          reached();
          await released;
        }
      },
    });
    /** The next batch write stops once it is flushed, with the save holding the attempt's lock, until `release`. */
    const holdNext = () => { hold = true; return writing; };
    return { fs, holdNext, release };
  }

  /** Resolves to the promise's value if it settles on microtasks alone, else to 'still waiting'. */
  function settledNow<T>(promise: Promise<T>): Promise<T | 'still waiting'> {
    return Promise.race([promise, new Promise<'still waiting'>((resolve) => setImmediate(() => resolve('still waiting')))]);
  }

  it('keeps a first batch that a deletion asked during its save would have removed, and deletes it once the task ended', async () => {
    const dir = await root();
    const held = heldRecordWrite();
    const store = new TaskCheckpointStore({ root: dir, fs: held.fs });
    const ctx = context();
    const writing = held.holdNext();
    const saving = store.save(ctx, batch(1, 'intro', 'Confirmed while the deletion waited.'));
    await writing;
    // Asked while the first save holds the lock: the attempt is not pinned yet, so the deletion waits for the lock.
    const deleting = store.deleteAttempt(ctx.attemptId);
    expect(await settledNow(deleting)).toBe('still waiting');
    held.release();

    expect(await saving).toMatchObject({ status: 'saved', receipt: { sequence: 1 } });
    expect(await deleting).toBe('running');
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 1, pinned: true, state: 'running' });
    expect(store.selectedBatches(ctx.attemptId).map((record) => record.text)).toEqual(['Confirmed while the deletion waited.']);
    expect((await readdir(join(dir, ctx.attemptId))).sort()).toEqual(['000001.json', 'attempt.json']);

    await store.attemptEnded(ctx.attemptId, 'settled');
    expect(await store.deleteAttempt(ctx.attemptId)).toBe('deleted');
  });

  it('answers at once that a running task\'s batches are kept when a deletion is asked during a later save', async () => {
    const dir = await root();
    const held = heldRecordWrite();
    const store = new TaskCheckpointStore({ root: dir, fs: held.fs });
    const ctx = context();
    await store.save(ctx, batch(1, 'intro', 'First.'));
    const writing = held.holdNext();
    const saving = store.save(ctx, batch(2, 'body', 'Second.'));
    await writing;

    expect(await settledNow(store.deleteAttempt(ctx.attemptId))).toBe('running');
    held.release();
    expect(await saving).toMatchObject({ status: 'saved', receipt: { sequence: 2 } });
    expect(store.summary(ctx.attemptId)).toMatchObject({ batches: 2, pinned: true });
    expect((await readdir(join(dir, ctx.attemptId))).sort()).toEqual(['000001.json', '000002.json', 'attempt.json']);
  });

  it('deletes when the task\'s end, queued before the deletion, unpinned it first', async () => {
    const dir = await root();
    const held = heldRecordWrite();
    const store = new TaskCheckpointStore({ root: dir, fs: held.fs });
    const ctx = context();
    let live = true;
    await store.save(ctx, batch(1, 'intro', 'Kept until deleted.'), () => live);
    const writing = held.holdNext();
    const saving = store.save(ctx, batch(2, 'body', 'Arrived during the stop.'), () => live);
    await writing;
    // As TaskInputResolver.endAttempt does it: the attempt stops being live, then the store hears of the end.
    live = false;
    const ending = store.attemptEnded(ctx.attemptId, 'cancelled');
    const deleting = store.deleteAttempt(ctx.attemptId);
    held.release();

    expect(await saving).toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await ending;
    expect(await deleting).toBe('deleted');
    expect(store.summary(ctx.attemptId)).toMatchObject({ state: 'cancelled', batches: 0, pinned: false, removed: { reason: 'deleted' } });
    expect(await readdir(join(dir, ctx.attemptId))).toEqual(['attempt.json']);
  });

  it('refuses a batch for an attempt whose record says it ended or whose batches were removed', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const ctx = context();
    await store.save(ctx, batch(1, 'intro', 'Before.'));
    await store.attemptEnded(ctx.attemptId, 'window-closed');
    expect(await store.save(ctx, batch(2, 'body', 'After.'))).toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await store.deleteAttempt(ctx.attemptId);
    expect(await store.save(ctx, batch(2, 'body', 'After.'))).toMatchObject({ status: 'refused', reason: 'removed' });
  });

  // §7.2 / L0: "取消先行就拒绝进入正式交付". The store asks the attempt's authority after the flush.
  it('writes nothing in place when the attempt ended while the batch was being flushed', async () => {
    const dir = await root();
    let live = true;
    const renamed: string[] = [];
    const store = new TaskCheckpointStore({
      root: dir,
      fs: failingFs({
        writeDurable: async (file, text) => {
          await nodeCheckpointFileSystem.writeDurable(file, text);
          if (/\d{6}\.json/.test(file)) live = false;
        },
        rename: async (from, to) => {
          renamed.push(to);
          await nodeCheckpointFileSystem.rename(from, to);
        },
      }),
    });
    const ctx = context();
    expect(await store.save(ctx, batch(1, 'intro', 'Arrived during the stop.'), () => live))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    // Not even for a moment: a crash right after a rename would have left it looking confirmed.
    expect(renamed.filter((file) => /\d{6}\.json$/.test(file))).toEqual([]);
    expect(await readdir(join(dir, ctx.attemptId))).toEqual(['attempt.json']);
    expect(store.summary(ctx.attemptId)).toBeUndefined();
  });

  it('takes the batch back when the attempt ended between the rename and the answer', async () => {
    const dir = await root();
    let live = true;
    const store = new TaskCheckpointStore({
      root: dir,
      fs: failingFs({
        rename: async (from, to) => {
          await nodeCheckpointFileSystem.rename(from, to);
          if (/\d{6}\.json$/.test(to)) live = false;
        },
      }),
    });
    const ctx = context();
    expect(await store.save(ctx, batch(1, 'intro', 'Arrived during the stop.'), () => live))
      .toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    expect(await readdir(join(dir, ctx.attemptId))).toEqual(['attempt.json']);
  });
});

describe('the final check selects an explicit set; it never strings batches together (§7.2)', () => {
  function record(sequence: number, sectionKey: string, revision: number, finalCandidate = false): TaskCheckpointRecord {
    const text = `${sectionKey} r${revision}`;
    return {
      schemaVersion: 1, checkpointId: `ckpt-${sequence}`, attemptId: 'attempt-x', sequence, sectionKey, revision,
      finalCandidate, contentSha256: sha(text), requestDigest: 'd', bytes: text.length, savedAt: new Date(sequence).toISOString(), text,
    };
  }

  // §7.2: "最终交付只引用明确的章节版本集合和最终校验 … 缺章、冲突、未满足 required inputs 仍不算完成".
  it('is complete only with every section, no conflict and every required input read', () => {
    const all = [record(1, 'intro', 1), record(2, 'body', 1), record(3, 'intro', 2), record(4, 'close', 1, true)];
    expect(checkpointFinalCheck(PLAN, all, 0)).toEqual({
      status: 'complete',
      selection: [
        { sectionKey: 'intro', revision: 2, checkpointId: 'ckpt-3', contentSha256: sha('intro r2'), bytes: 8 },
        { sectionKey: 'body', revision: 1, checkpointId: 'ckpt-2', contentSha256: sha('body r1'), bytes: 7 },
        { sectionKey: 'close', revision: 1, checkpointId: 'ckpt-4', contentSha256: sha('close r1'), bytes: 8 },
      ],
      missingSections: [], conflicts: [], requiredInputsNotRead: 0, finalCandidateSequence: 4,
    });
    expect(checkpointFinalCheck(PLAN, all.slice(0, 3), 0)).toMatchObject({ status: 'incomplete', missingSections: ['close'] });
    expect(checkpointFinalCheck(PLAN, [...all, { ...record(5, 'body', 1), checkpointId: 'ckpt-5' }], 0))
      .toMatchObject({ status: 'incomplete', conflicts: ['body revision 1 is claimed by 2 batches'] });
    expect(checkpointFinalCheck(PLAN, all, 1)).toMatchObject({ status: 'incomplete', requiredInputsNotRead: 1 });
    expect(checkpointFinalCheck(PLAN, all, 'unknown')).toMatchObject({ status: 'incomplete', requiredInputsNotRead: 'unknown' });
  });

  it('formats the selection with each section\'s exact revision and a header that says it is partial work', async () => {
    const store = new TaskCheckpointStore({ root: await root() });
    const ctx = context();
    await store.save(ctx, batch(1, 'intro', 'Intro text.'));
    await store.save(ctx, batch(2, 'body', 'Body text.'));
    const text = formatSavedBatches('handle-1', store.summary(ctx.attemptId)!, store.selectedBatches(ctx.attemptId));
    expect(text).toMatch(/^\[host: saved batches of handle handle-1 · attempt state running · 2 batch\(es\) saved · final check INCOMPLETE: missing close\. Partial work: it is not the task result/);
    expect(text).toMatch(/\[section intro · revision 1 · checkpoint ckpt-[0-9a-f-]+ · sha256 [0-9a-f]{64}\]\nIntro text\.\n\n\[section body · revision 1/);
    // A bounded read names what it left out.
    const bounded = formatSavedBatches('handle-1', store.summary(ctx.attemptId)!, store.selectedBatches(ctx.attemptId), 420);
    expect(bounded).toContain('Intro text.');
    expect(bounded).not.toContain('Body text.');
    expect(bounded).toMatch(/not shown to stay within this read's size: body/);
    // v0.9.99: a first section larger than the whole read is shown in part with its span, and the read names the exact
    // call that returns the rest (it moves on by at least one character), and the call for the sections left out.
    const cut = formatSavedBatches('handle-1', store.summary(ctx.attemptId)!, store.selectedBatches(ctx.attemptId), 300);
    expect(cut).not.toContain('Intro text.');
    expect(cut).toMatch(/\[section intro · revision 1 · checkpoint [^\]]+ · characters 0-1 of 11\]\nI\n/);
    expect(cut).toContain('[host: section intro continues at character 1 of 11. To read the rest, call read_saved_batches({ handle: "handle-1", sections: ["intro"], revision: 1, offset: 1 }).]');
    expect(cut).toContain('[host: not shown to stay within this read\'s size: body. To read them, call read_saved_batches({ handle: "handle-1", sections: ["body"] }).]');
    // The continuation returns the rest, and says nothing more follows once it is all read.
    const rest = formatSavedBatches('handle-1', store.summary(ctx.attemptId)!, store.selectedBatches(ctx.attemptId, ['intro']), 10_000, { offset: 1, revision: 1 });
    expect(rest).toMatch(/· characters 1-11 of 11\]\nntro text\.$/);
    // The person's view has no handle to name a call with.
    expect(formatSavedBatches(undefined, store.summary(ctx.attemptId)!, store.selectedBatches(ctx.attemptId), 300))
      .toContain('[host: section intro continues at character 1 of 11.]');
  });
});
