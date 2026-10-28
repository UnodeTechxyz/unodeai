import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamTools, type DelegationExecutionObservation, type TeamRosterEntry, type TeamToolsOptions, type TeamView } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver, type TaskAttemptCard } from '../TaskContract';
import { RunLedger } from '../../observability/RunLedger';
import { TaskCheckpointProgressTracker, type CheckpointProgressSnapshot } from '../../session/TaskCheckpointProgress';
import { incrementalProposal, settleStoreWrites, temporaryCheckpointStore } from './checkpointFixtures';

/*
 * v0.9.97 L1: what the coordinator sees of a task that delivers in batches, and what it may do with them.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 7.2).
 */

const TIMEOUT_MS = 100;
const LATE_WINDOW_MS = TIMEOUT_MS * 2;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(options: { progress?: (handle: string) => CheckpointProgressSnapshot | undefined } = {}) {
  const bus = new MessageBus();
  const ledger = new RunLedger();
  const assets = new ContentAssetStore();
  const resolver = new TaskInputResolver(assets, process.cwd());
  const checkpoints = await temporaryCheckpointStore();
  resolver.setCheckpointStore(checkpoints.store);
  cleanups.push(async () => { await assets.dispose(); await checkpoints.dispose(); });
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'running' },
  ];
  const executions = new Map<string, DelegationExecutionObservation>();
  const view: TeamView = {
    list: () => roster,
    resolve: (ref) => roster.find((entry) => entry.id === ref || entry.name === ref),
    preflightTaskScope: () => undefined,
    execution: (agentId, handle) => executions.get(`${agentId}:${handle}`) ?? { state: 'not-running' },
    ...(options.progress ? { workProgress: (_agentId: string, handle: string) => options.progress!(handle) } : {}),
  };
  const tools = (selfId = 'pm', extra: TeamToolsOptions = {}) => new TeamTools(selfId, view, bus, {
    coordinatorId: selfId,
    timeoutMs: TIMEOUT_MS,
    evidenceEnabled: true,
    cwd: process.cwd(),
    taskInputResolver: resolver,
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'root-turn' }),
    onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    onDelegationInterrupted: (event) => ledger.recordDelegationInterrupted(event),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus(selfId, handles),
    cancelDelegatedWorker: () => true,
    stopTeammate: () => true,
    onAsyncResultReady: () => true,
    ...extra,
  });
  return { bus, resolver, executions, tools, store: checkpoints.store };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function dispatch(h: Harness, team: TeamTools, overrides: Record<string, unknown> = {}): Promise<{ handle: string; attempt: TaskAttemptCard }> {
  let assignment: Message | undefined;
  const off = h.bus.onType('task.assign', (message) => { assignment = message; });
  const out = await team.run('dispatch_task', { agent: 'writer', instruction: 'Draft the article.', contract: incrementalProposal(overrides) });
  off();
  const handle = out.match(/Handle: ([0-9a-f-]+)/i)?.[1];
  if (!handle || !assignment) throw new Error(`dispatch failed: ${out}`);
  h.executions.set(`writer:${handle}`, { state: 'running' });
  return { handle, attempt: assignment.payload.taskAttempt as TaskAttemptCard };
}

const save = (h: Harness, attempt: TaskAttemptCard, sequence: number, section: string, text: string) =>
  h.resolver.saveCheckpoint(attempt.attemptId, 'writer', { sequence, section, text });

describe('the coordinator sees and reads its own handle\'s saved batches (§7.2)', () => {
  // §7.2: "PM/UI 能看到'已保存第 N 批、已覆盖/剩余、最后保存时间'".
  it('shows saved batches, covered and remaining sections and the last save time in inspect_task_status', async () => {
    const tracker = new TaskCheckpointProgressTracker();
    // What the host would report for the running handle: 2.5 min active, half a minute of it waiting for a person.
    const h = await harness({ progress: () => tracker.snapshot('writer', { activeMs: 150_000, approvalWaitMs: 30_000 }) });
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    // The contract the worker received carries the plan; no extra call decided it.
    expect(attempt.contract.delivery?.sections.map((section) => section.key)).toEqual(['intro', 'body', 'close']);
    tracker.begin('writer', attempt.attemptId, handle);
    const before = await team.run('inspect_task_status', { handles: [handle] });
    expect(before).toContain('saved batches: none yet');

    const saved = await save(h, attempt, 1, 'intro', 'The introduction.');
    const savedAt = saved.status === 'saved' ? saved.receipt.savedAt : '';
    const status = await team.run('inspect_task_status', { handles: [handle] });
    expect(status).toContain(`saved batches: 1 · covered 1 of 3 (intro@1) · remaining: body, close · last saved at ${savedAt}`);
    expect(status).toContain(`final check: INCOMPLETE: missing body, close · read them with read_saved_batches handle "${handle}"`);
    expect(status).toMatch(/work product: a batch is due \(elapsed\) · 2m 30s active since the task began · approval wait 0m 30s \(not counted\) · generated tokens: unavailable/);
    team.cancelPending('test cleanup');
  });

  it('reads the latest revision of each section under the final check, by section if asked', async () => {
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Intro text.');
    await save(h, attempt, 2, 'body', 'Body text.');
    const all = await team.run('read_saved_batches', { handle });
    expect(all).toMatch(/^\[host: saved batches of handle [0-9a-f-]+ · attempt state running · 2 batch\(es\) saved · final check INCOMPLETE: missing close\./);
    expect(all.indexOf('Intro text.')).toBeLessThan(all.indexOf('Body text.'));
    const body = await team.run('read_saved_batches', { handle, sections: ['body'] });
    expect(body).toContain('Body text.');
    expect(body).not.toContain('Intro text.');
    expect(await team.run('read_saved_batches', { handle, sections: ['appendix'] })).toMatch(/^Error: not expected sections of handle .*: appendix\./);
    team.cancelPending('test cleanup');
  });

  // v0.9.99: one read returns about 60,000 characters. A longer section is not cut off with advice to open the draft:
  // the read names the exact read_saved_batches call that returns the rest, and following it returns the whole text.
  describe('a section longer than one read continues through read_saved_batches (v0.9.99)', () => {
    /** 150,000 characters of numbered lines, so any lost, repeated or reordered stretch shows. */
    const longText = Array.from({ length: 15_000 }, (_, i) => `line ${String(i).padStart(5, '0')}`).join('');
    const CONTINUE = /call read_saved_batches\(\{ handle: "([^"]+)", sections: \["([^"]+)"\], revision: (\d+), offset: (\d+) \}\)/;
    /** The section text one read shows, by the character span its section line states. */
    const shownText = (read: string, section: string) => {
      const header = new RegExp(`\\[section ${section} · revision \\d+ · checkpoint [^\\]]+ · characters (\\d+)-(\\d+) of (\\d+)\\]\\n`).exec(read);
      if (!header) throw new Error(`no span for ${section} in: ${read.slice(0, 400)}`);
      const [from, to] = [Number(header[1]), Number(header[2])];
      const start = header.index + header[0].length;
      return { from, to, of: Number(header[3]), text: read.slice(start, start + to - from) };
    };

    it('returns the whole of a 150,000-character section by following the continuation each read names', async () => {
      const h = await harness();
      const team = h.tools();
      const { handle, attempt } = await dispatch(h, team);
      await save(h, attempt, 1, 'intro', 'Intro text.');
      await save(h, attempt, 2, 'body', longText);
      let read = await team.run('read_saved_batches', { handle, sections: ['body'] });
      let assembled = '';
      let reads = 0;
      for (;;) {
        reads++;
        const shown = shownText(read, 'body');
        expect(shown.from).toBe(assembled.length);
        expect(shown.of).toBe(longText.length);
        assembled += shown.text;
        expect(read).not.toMatch(/open the whole draft/);
        const next = CONTINUE.exec(read);
        if (!next) break;
        expect(next.slice(1)).toEqual([handle, 'body', '1', String(assembled.length)]);
        read = await team.run('read_saved_batches', { handle, sections: ['body'], revision: 1, offset: Number(next[4]) });
      }
      expect(assembled).toBe(longText);
      expect(reads).toBe(3);
      team.cancelPending('test cleanup');
    });

    it('an unsectioned read whose first section fills it names the call for the rest and for the sections after it', async () => {
      const h = await harness();
      const team = h.tools();
      const { handle, attempt } = await dispatch(h, team);
      await save(h, attempt, 1, 'intro', longText);
      await save(h, attempt, 2, 'body', 'Body text.');
      const read = await team.run('read_saved_batches', { handle });
      expect(read).toMatch(new RegExp(`section intro continues at character [\\d,]+ of 150,000\\. To read the rest, call read_saved_batches\\(\\{ handle: "${handle}", sections: \\["intro"\\], revision: 1, offset: \\d+ \\}\\)`));
      expect(read).toContain(`not shown to stay within this read's size: body. To read them, call read_saved_batches({ handle: "${handle}", sections: ["body"] }).`);
      expect(await team.run('read_saved_batches', { handle, sections: ['body'] })).toContain('Body text.');
      team.cancelPending('test cleanup');
    });

    it('says so when the section was saved again since the read the offset came from, and when the offset is past its end', async () => {
      const h = await harness();
      const team = h.tools();
      const { handle, attempt } = await dispatch(h, team);
      const saved = await save(h, attempt, 1, 'body', longText);
      if (saved.status !== 'saved') throw new Error('fixture save failed');
      const first = await team.run('read_saved_batches', { handle, sections: ['body'] });
      const next = CONTINUE.exec(first)!;
      expect(await h.resolver.saveCheckpoint(attempt.attemptId, 'writer', {
        sequence: 2, section: 'body', text: `REVISED ${longText}`, revision: 2, supersedes: saved.receipt.checkpointId,
      })).toMatchObject({ status: 'saved' });
      const continued = await team.run('read_saved_batches', { handle, sections: ['body'], revision: 1, offset: Number(next[4]) });
      expect(continued).toMatch(/\[host: section body was saved again since: this read continues revision 2, not revision 1 that offset \d+ came from\. Read it again without offset for one consistent revision\.\]/);
      expect(shownText(continued, 'body').from).toBe(Number(next[4]));

      const past = await team.run('read_saved_batches', { handle, sections: ['body'], offset: 999_999 });
      expect(past).toMatch(/· characters 150008-150008 of 150008\]/);
      expect(past).toContain('[host: section body has 150,008 characters; nothing follows offset 999,999.]');
      expect(await team.run('read_saved_batches', { handle, offset: -1 })).toMatch(/^Error: offset must be a whole number of characters, 0 or more\./);
      team.cancelPending('test cleanup');
    });
  });

  it('gives another coordinator nothing of the handle, and a worker no read at all', async () => {
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Private.');
    expect(await h.tools('pm-2').run('read_saved_batches', { handle })).toBe(`Error: no saved batches are known for handle ${handle}.`);
    const worker = h.tools('writer', { coordinatorId: 'pm' });
    expect(worker.specs().map((spec) => spec.function.name)).not.toContain('read_saved_batches');
    expect(await worker.run('read_saved_batches', { handle })).toMatch(/dispatch belongs to the coordinator/);
    team.cancelPending('test cleanup');
  });

  // §7.2: "checkpoint 是可审阅的部分产品，不是完整 task result" - the result names its batches beside it.
  it('names the saved batches and the final check beside the delegated result', async () => {
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'I.');
    h.bus.send('writer', 'pm', 'task.complete', { instruction: 'Here is the article.' }, 'normal', handle);
    let collected = '';
    await vi.waitFor(async () => {
      collected = await team.run('collect_ready_tasks', { handles: [handle] });
      expect(collected).toContain('Here is the article.');
    });
    expect(collected).toMatch(/\[saved batches: 1 · covered 1 of 3 \(intro@1\) · remaining: body, close · last saved at [^·]+ · final check: INCOMPLETE: missing body, close/);
    expect(await team.run('inspect_task_status', { handles: [handle] })).toMatch(/saved batches: 1 · covered 1 of 3 \(intro@1\)/);
  });
});

describe('a stop, and the end of the result windows (§7.2, L0 §6)', () => {
  // §7.2: "已持久且取消前确认的批次保留为 cancelled-task draft；恢复须用户主动选择，绝不自动发送或重新执行".
  it('says on cancel_task that the saved batches stay as the person\'s draft, and then gives the coordinator none', async () => {
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Before the stop.');
    const reply = await team.run('cancel_task', { handle, reason: 'The user asked to stop.' });
    expect(reply).toMatch(/kept as a stopped task's draft: only the person can open or recover it \(UnodeAi: Saved Task Batches\); nothing of it was delivered\]$/);
    expect(await save(h, attempt, 2, 'body', 'After.')).toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await settleStoreWrites();
    expect(await team.run('read_saved_batches', { handle })).toMatch(/was stopped\. Its 1 saved batch\(es\) are a stopped task's draft/);
    expect(await team.run('read_saved_batches', { handle, as_task_input: true })).toMatch(/stopped task's draft/);
    const status = await team.run('inspect_task_status', { handles: [handle] });
    expect(status).toContain('kept as a stopped task\'s draft');
    expect(status).not.toContain('read them with read_saved_batches');
  });

  /*
   * L0 open question 3: an attempt past its result windows keeps no checkpoint right. Its batches saved before the
   * close are kept, and the coordinator can still read them and choose to use them.
   */
  it('refuses a batch after the result windows closed, and keeps the earlier ones readable', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Inside the windows.');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LATE_WINDOW_MS);
    expect(await save(h, attempt, 2, 'body', 'Past the windows.')).toMatchObject({ status: 'refused', reason: 'attempt-ended' });
    await vi.waitFor(() => expect(h.resolver.checkpointSummary(attempt.attemptId)?.state).toBe('window-closed'));
    expect(await team.run('read_saved_batches', { handle })).toContain('Inside the windows.');
    team.cancelPending('test cleanup');
  });

  // §6: a wait timeout ends the wait, not the attempt: inside its result windows it still saves batches.
  it('keeps saving inside the result windows after a wait timeout, and shows the batches in the task status', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Before the timeout.');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await save(h, attempt, 2, 'body', 'Inside the late window.')).toMatchObject({ status: 'saved' });
    const status = await team.run('inspect_task_status', { handles: [handle] });
    expect(status).toContain('wait state: timed-out-window-open');
    expect(status).toMatch(/saved batches: 2 · covered 2 of 3 \(intro@1, body@1\) · remaining: close/);
    team.cancelPending('test cleanup');
  });
});

describe('partial work becomes a task input only by the coordinator\'s choice (§7.2)', () => {
  // §7.2: "partial 能否作下一任务输入需 coordinator 明确选择、保留不完整标记和既有 grant".
  it('publishes the selection as an artifact marked incomplete, which a later contract can declare', async () => {
    const h = await harness();
    const team = h.tools();
    const { handle, attempt } = await dispatch(h, team);
    await save(h, attempt, 1, 'intro', 'Intro text.');
    const out = await team.run('read_saved_batches', { handle, as_task_input: true });
    const artifactId = out.match(/Published partial-work artifact (artifact-[a-z0-9-]+)/)?.[1];
    expect(artifactId).toBeDefined();
    expect(out).toContain('Final check: INCOMPLETE: missing body, close.');
    expect(out).toContain('marks it incomplete partial work, and it grants nothing else.');
    expect(h.resolver.readyArtifacts().find((artifact) => artifact.artifactId === artifactId)).toMatchObject({
      delegableByAgentIds: ['pm'], partialWork: { completeness: 'incomplete' },
    });
    team.cancelPending('test cleanup');
  });
});
