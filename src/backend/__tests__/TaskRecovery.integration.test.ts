/*
 * v0.9.110 R2: Revert to before a request, Undo revert and Redo revert, from real host changes through the real restore
 * checks, the shared raw-v2 restore points, the writer leases and the task history's journal.
 */
import { createHash, randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../Checkpoints';
import { FileWritePolicy } from '../fileWritePolicy';
import { PreChangeCheckpoints } from '../PreChangeCheckpoints';
import { RawCheckpointStore } from '../RawCheckpointStore';
import { WorkspaceTools } from '../WorkspaceTools';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import { taskRecoveryPorts } from '../TaskRecoveryHost';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { GenerationLease } from '../../history/GenerationLease';
import { FileWriterLeases } from '../../history/FileWriterLeases';
import { HistoryService } from '../../history/HistoryService';
import { HistoryStore } from '../../history/HistoryStore';
import { releasableRecoveryOperations, TaskRecovery, undoRedoReachableRequests } from '../../history/TaskRecovery';
import { recoveryNoticeText } from '../../history/RecoveryNotice';
import type { ChatHistoryMessage } from '../../views/chatHistory';
import type { HistoryEventBody } from '../../history/HistoryRecords';
import type { ProcessIdentityAdapter, ProcessLiveness } from '../../host/processIdentity/ProcessIdentityHost';

const pendingIdle: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const idle of pendingIdle.splice(0)) await idle();
  await removeTemporaryFolders();
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const liveness = new Map<number, ProcessLiveness>();
const identity: ProcessIdentityAdapter = {
  platform: 'linux', self: async () => 'unknown', identityOf: async () => 'unknown',
  liveness: async (records) => records.map((record) => liveness.get(record.pid) ?? 'unknown'),
};
const me = { pid: 1, startToken: '1', bootToken: 'boot', platform: 'linux' as const };

class State {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

async function folder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

async function workspace(options: { failJournalAfter?: (body: HistoryEventBody) => boolean } = {}) {
  liveness.set(1, 'alive');
  // This window's history writer is process 5; other windows' writers use other process ids.
  liveness.set(5, 'alive');
  const root = await folder('unode-r2-ws-');
  const storage = await folder('unode-r2-storage-');
  const historyDir = path.join(storage, 'history');
  /** Runs each time the raw store commits its index, as in a capture. */
  const hooks = { duringCapture: undefined as undefined | (() => Promise<void>) };
  const openStore = (pid = 5) => HistoryStore.open({ directory: historyDir, workspaceId: 'w'.repeat(8), writerId: randomUUID(),
    identity: { ...identity, self: async () => ({ ...me, pid, startToken: String(pid) }) } });
  const history = new HistoryService({ open: () => openStore(), state: new State() });
  const text = new CheckpointStore();
  let raw: RawCheckpointStore | undefined;
  const directory = path.join(storage, 'raw-v2');
  const checkpoints = new PreChangeCheckpoints({
    open: async () => {
      const { store } = await RawCheckpointStore.open({
        directory, workspaceId: 'w',
        coordination: {
          lease: new GenerationLease(path.join(directory, 'lock'), { hostInstanceId: 'host-me', selfIdentity: async () => me, identity }),
          hostInstanceId: 'host-me', hostsGone: async () => new Set(),
        },
        onRemoved: (ids) => { text.dropRaw(ids); },
        beforeIndexCommit: async () => { await hooks.duringCapture?.(); },
      });
      raw = store;
      return store;
    },
    isRequestRunning: (id) => running.has(id),
    recovery: { captured: (capture) => history.recoveryCaptured(capture), settled: (settle) => history.recoverySettled(settle) },
  });
  const running = new Set<string>();
  const leasesRoot = path.join(storage, 'file-leases');
  const leases = new FileWriterLeases(leasesRoot, { hostInstanceId: 'host-me', selfIdentity: async () => me, identity });
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', isRequestRunning: (id) => running.has(id), checkpoints, fileLeases: leases });
  const dirty = new Set<string>();
  const agent = (agentId: string) => {
    let request = '';
    const tools = new WorkspaceTools(
      root, new Set(['read', 'write']), agentId, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (entry) => { text.record({ ...entry, agentName: agentId, operation: entry.operation ?? 'write' }); },
      () => false, undefined, undefined, undefined, undefined, [], () => true, [root],
    );
    tools.setFileWrites(policy.forAgent({ agentId, requestId: () => request, decide: async () => 'once', notice: () => {} }));
    /**
     * One request of the person to this member: its message, its admission, then the member's tool calls. `via`: the
     * window whose history admits it (this one by default).
     */
    const ask = async (goal: string, calls: Array<[string, Record<string, unknown>]>, via: HistoryService = history) => {
      const messageId = randomUUID();
      const historyId = randomUUID();
      request = `req-${randomUUID()}`;
      const message: ChatHistoryMessage = { role: 'user', text: goal, ts: new Date().toISOString(), messageId };
      via.messageAppended(agentId, message, { historyId });
      via.requestAdmitted(agentId, historyId, request);
      await via.flush();
      for (const [name, args] of calls) {
        const result = await tools.run(name, args);
        expect(result.status, `${name} ${JSON.stringify(args)}: ${result.output}`).toBe('success');
      }
      await history.flush();
      return { historyId, requestId: request };
    };
    return { ask, tools };
  };
  /** The engine of this window, or of another window's `store`; `beforePrepare` runs before each target's checks. */
  const recovery = async (other: { store?: HistoryStore; beforePrepare?: (physical: string) => Promise<void>;
    /** The window stops after the intent is recorded and before the file is written. */
    stopBeforeWrite?: boolean } = {}) => {
    const store = other.store ?? (await history.store())!;
    const ports = taskRecoveryPorts({
      store: options.failJournalAfter && !other.store ? failingJournal(store, options.failJournalAfter) : store,
      raw: async () => { await checkpoints.store(); return raw; },
      leases,
      authority: { isTrusted: () => true, writeRoots: () => [root], hasUnsavedChanges: (file) => dirty.has(file) },
      isRequestRunning: (id) => running.has(id),
      newId: () => randomUUID(),
    });
    const prepare = ports.prepare;
    ports.prepare = async (input) => {
      const ready = await prepare(input);
      await other.beforePrepare?.(input.physicalTarget);
      if (other.stopBeforeWrite && ready.status === 'ready') {
        return { status: 'ready', restore: { ...ready.restore, commit: async () => { await ready.restore.release(); throw new Error('window stopped'); } } };
      }
      return ready;
    };
    return new TaskRecovery(ports);
  };
  pendingIdle.push(async () => { await raw?.idle(); await history.flush(); });
  const otherWindow = (pid: number) => new FileWriterLeases(leasesRoot, {
    hostInstanceId: `host-${pid}`, selfIdentity: async () => ({ ...me, pid, startToken: String(pid) }), identity,
  });
  return { root, agent, recovery, history, dirty, running, otherWindow, openStore, policy, hooks };
}

/** A store whose journal fails once `fail(body)` says so, for the journal-first rule. */
function failingJournal(store: HistoryStore, fail: (body: HistoryEventBody) => boolean) {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'append') {
        return (body: any, options?: any) => (fail(body) && String(body.kind).startsWith('recovery-')
          ? Promise.resolve({ status: 'failed', reason: 'disk full' }) : target.append(body, options));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const read = (root: string, name: string) => fs.readFile(path.join(root, name));
const exists = (root: string, name: string) => fs.access(path.join(root, name)).then(() => true, () => false);

describe('R2: Revert to before a request, Undo revert, Redo revert', () => {
  it('puts back the exact bytes of every file the requests changed, removes what they created, and Undo/Redo move each file', async () => {
    const w = await workspace();
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('keep\r\nthese\r\nbytes\r\n')]);
    await fs.writeFile(path.join(w.root, 'a.txt'), original);
    const dev = w.agent('dev');
    await dev.tools.run('read_file', { path: 'a.txt' });
    const first = await dev.ask('first', [['write_file', { path: 'a.txt', content: 'first change\n' }], ['write_file', { path: 'b.txt', content: 'created\n' }]]);
    await dev.tools.run('read_file', { path: 'a.txt' });
    await dev.ask('second', [['apply_edit', { path: 'a.txt', old_string: 'first', new_string: 'second' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    expect('refused' in preview).toBe(false);
    if ('refused' in preview) return;
    expect(preview.targets.map((t) => [path.basename(t.physicalTarget), t.action])).toEqual([['a.txt', 'restore'], ['b.txt', 'remove']]);
    const report = await recovery.apply(preview.previewId);
    expect(report.targets.map((t) => t.outcome)).toEqual(['applied', 'applied']);
    expect(report.branchId).toBeDefined();
    expect(await read(w.root, 'a.txt')).toEqual(original);
    expect(await exists(w.root, 'b.txt')).toBe(false);

    const undo = await recovery.undo(report.operationId!);
    expect(undo.targets.map((t) => t.outcome)).toEqual(['applied', 'applied']);
    expect((await read(w.root, 'a.txt')).toString()).toBe('second change\n');
    expect((await read(w.root, 'b.txt')).toString()).toBe('created\n');

    // A reload: a new engine over the same history finds where each file stands.
    const reloaded = await w.recovery();
    const positions = await reloaded.positions(report.operationId!);
    expect([...positions.values()].map((p) => p.position)).toEqual(['undone', 'undone']);
    const redo = await reloaded.redo(report.operationId!);
    expect(redo.targets.map((t) => t.outcome)).toEqual(['applied', 'applied']);
    expect(await read(w.root, 'a.txt')).toEqual(original);
    expect(await exists(w.root, 'b.txt')).toBe(false);
    // The journal recorded each step durably.
    const store = await w.openStore();
    const operation = store.recoveryOperation(report.operationId!)!;
    expect(operation.targets.every((t) => t.phase === 'applied' && t.inverse && t.restoreTo && t.observed)).toBe(true);
    expect(store.activeBranch).toBe(report.branchId);
  });

  it('leaves a file another member changed in between as a conflict, and restores the rest', async () => {
    const w = await workspace();
    await fs.writeFile(path.join(w.root, 'shared.txt'), 'base\n');
    const dev = w.agent('dev');
    const qa = w.agent('qa');
    await dev.tools.run('read_file', { path: 'shared.txt' });
    const first = await dev.ask('dev change', [['write_file', { path: 'shared.txt', content: 'dev\n' }], ['write_file', { path: 'own.txt', content: 'own\n' }]]);
    await qa.tools.run('read_file', { path: 'shared.txt' });
    await qa.ask('qa change', [['write_file', { path: 'shared.txt', content: 'qa\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const shared = preview.targets.find((t) => t.physicalTarget.endsWith('shared.txt'))!;
    expect(shared).toMatchObject({ action: 'conflict' });
    expect(shared.reason).toMatch(/another request changed this file/);
    const report = await recovery.apply(preview.previewId);
    expect(report.targets.find((t) => t.displayPath.includes('own'))!.outcome).toBe('applied');
    expect((await read(w.root, 'shared.txt')).toString()).toBe('qa\n');
    expect(await exists(w.root, 'own.txt')).toBe(false);
  });

  it('leaves outside edits, unsaved editors and a file another window is writing as conflicts, without waiting', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('three files', [
      ['write_file', { path: 'edited.txt', content: 'agent\n' }],
      ['write_file', { path: 'dirty.txt', content: 'agent\n' }],
      ['write_file', { path: 'busy.txt', content: 'agent\n' }],
      ['write_file', { path: 'fine.txt', content: 'agent\n' }],
    ]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    await fs.writeFile(path.join(w.root, 'edited.txt'), 'the person edited this\n');
    w.dirty.add(path.join(w.root, 'dirty.txt'));
    liveness.set(7, 'alive');
    const other = await w.otherWindow(7).acquire(path.join(w.root, 'busy.txt'), { waitMs: 0 });
    expect(other.status).toBe('held');
    // An outside edit is not in the history: the plan stands, and the file's own restore check leaves it as a conflict.
    const started = Date.now();
    const report = await recovery.apply(preview.previewId);
    expect(Date.now() - started).toBeLessThan(3_000);
    const outcome = (name: string) => report.targets.find((t) => t.displayPath.includes(name))!;
    expect(outcome('edited').outcome).toBe('conflict');
    expect(outcome('dirty').outcome).toBe('conflict');
    expect(outcome('busy').outcome).toBe('conflict');
    expect(outcome('busy').reason).toMatch(/another UnodeAi window is writing this file/);
    expect(outcome('fine').outcome).toBe('applied');
    expect((await read(w.root, 'edited.txt')).toString()).toBe('the person edited this\n');
    expect(await exists(w.root, 'fine.txt')).toBe(false);
    if (other.status === 'held') await other.release();
  });

  it('refuses a preview the history has moved past, and changes nothing', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('first', [['write_file', { path: 'p.txt', content: 'one\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    await dev.tools.run('read_file', { path: 'p.txt' });
    await dev.ask('second', [['write_file', { path: 'p.txt', content: 'two\n' }]]);
    const report = await recovery.apply(preview.previewId);
    expect(report.refused).toMatch(/changed since the preview/);
    expect((await read(w.root, 'p.txt')).toString()).toBe('two\n');
  });

  it('tells every member once, at its next request, which files were restored, naming only what it may read', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('two files', [['write_file', { path: 'seen.txt', content: 'x\n' }], ['write_file', { path: 'secret/hidden.txt', content: 'y\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const report = await recovery.apply(preview.previewId);
    expect(report.targets.every((t) => t.outcome === 'applied')).toBe(true);
    await w.history.flush();
    const pending = await w.history.pendingRecoveryNotices('dev');
    expect(pending).toHaveLength(1);
    const text = recoveryNoticeText(pending, (physical) => !physical.includes(`${path.sep}secret${path.sep}`));
    expect(text).toMatch(/^\[UnodeAi host note — not from the person\]/);
    expect(text).toContain('seen.txt: removed (it did not exist before that request)');
    expect(text).not.toContain('hidden.txt');
    expect(text).toContain('1 more file outside your current file access');
    // Delivered with dev's next request: gone for dev, still pending for qa.
    w.history.recoveryNoticesDelivered('dev', pending.map((notice) => notice.noticeId), 'req-next');
    await w.history.flush();
    expect(await w.history.pendingRecoveryNotices('dev')).toEqual([]);
    expect(await w.history.pendingRecoveryNotices('qa')).toHaveLength(1);
  });

  it('tells a member in another window at its next request, without that window writing anything first', async () => {
    const w = await workspace();
    // The other window opened its history before the revert and has recorded nothing since.
    const other = new HistoryService({ open: w.openStore, state: new State() });
    expect(await other.pendingRecoveryNotices('qa')).toEqual([]);
    const dev = w.agent('dev');
    const first = await dev.ask('one file', [['write_file', { path: 'w2.txt', content: 'x\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    expect((await recovery.apply(preview.previewId)).targets[0].outcome).toBe('applied');
    await w.history.flush();
    const pending = await other.pendingRecoveryNotices('qa');
    expect(pending).toHaveLength(1);
    expect(recoveryNoticeText(pending, () => true)).toContain('w2.txt: removed');
  });

  it('changes no file when the history cannot record the operation', async () => {
    let failing = false;
    const w = await workspace({ failJournalAfter: () => failing });
    const dev = w.agent('dev');
    const first = await dev.ask('one file', [['write_file', { path: 'x.txt', content: 'agent\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    failing = true;
    const report = await recovery.apply(preview.previewId);
    expect(report.refused).toMatch(/could not record this operation/);
    expect((await read(w.root, 'x.txt')).toString()).toBe('agent\n');
  });

  it('leaves the files of a request that is still running', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('running', [['write_file', { path: 'r.txt', content: 'agent\n' }]]);
    w.running.add(first.requestId);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    expect(preview.targets[0]).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/still running/) });
  });

  it('F1: once a newer request starts, an earlier Redo revert is history and changes nothing', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'f.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    expect(await exists(w.root, 'f.txt')).toBe(false);
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await exists(w.root, 'f.txt')).toBe(true);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(true);
    await dev.ask('newer work', [['write_file', { path: 'new.txt', content: 'n\n' }]]);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
    const redo = await recovery.redo(revert.operationId!);
    expect(redo.refused).toMatch(/now history/);
    expect((await read(w.root, 'f.txt')).toString()).toBe('made\n');
  });

  it('F1: a later Undo of the rest does not bring back a Redo a newer request already made history', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('two files', [['write_file', { path: 'a.txt', content: 'a\n' }], ['write_file', { path: 'b.txt', content: 'b\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    // b.txt has unsaved changes, so the first Undo puts back only a.txt.
    w.dirty.add(path.join(w.root, 'b.txt'));
    expect((await recovery.undo(revert.operationId!)).targets.map((t) => t.outcome)).toEqual(['applied', 'conflict']);
    await dev.ask('newer work', [['write_file', { path: 'new.txt', content: 'n\n' }]]);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
    // The editor is saved; the rest of the Undo is still allowed.
    w.dirty.clear();
    expect((await recovery.undo(revert.operationId!)).targets.map((t) => t.outcome)).toEqual(['applied']);
    expect(await exists(w.root, 'b.txt')).toBe(true);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
    expect((await recovery.redo(revert.operationId!)).refused).toMatch(/now history/);
    expect((await read(w.root, 'a.txt')).toString()).toBe('a\n');
    expect((await read(w.root, 'b.txt')).toString()).toBe('b\n');
    expect((await read(w.root, 'new.txt')).toString()).toBe('n\n');
    // It stays history after a reload.
    await w.history.flush();
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    expect(await next.redoAvailable(revert.operationId!)).toBe(false);
    await reopened.dispose();
  });

  it('F1: a request that started while a Redo was running from the undone files keeps the chain history afterwards', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'r.txt', content: 'made\n' }]]);
    let admitDuringRedo = false;
    const recovery = await w.recovery({ beforePrepare: async () => {
      if (!admitDuringRedo) return;
      admitDuringRedo = false;
      await dev.ask('started meanwhile', [['write_file', { path: 'meanwhile.txt', content: 'm\n' }]]);
    } });
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    // The Redo was allowed when it began; a request is admitted while it runs.
    admitDuringRedo = true;
    expect((await recovery.redo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await exists(w.root, 'meanwhile.txt')).toBe(true);
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
  });

  it('F1: a request that started while the Undo was running makes its Redo history', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'u.txt', content: 'made\n' }]]);
    let admitDuringStep = false;
    const recovery = await w.recovery({ beforePrepare: async () => {
      if (!admitDuringStep) return;
      admitDuringStep = false;
      await dev.ask('started meanwhile', [['write_file', { path: 'during-undo.txt', content: 'm\n' }]]);
    } });
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    admitDuringStep = true;
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await exists(w.root, 'during-undo.txt')).toBe(true);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
    expect((await recovery.redo(revert.operationId!)).refused).toMatch(/now history/);
  });

  it('F1: a request made while the revert stands does not retire a later Undo and its Redo', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'f.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    await dev.ask('work after the revert', [['write_file', { path: 'other.txt', content: 'o\n' }]]);
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(true);
    expect((await recovery.redo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await exists(w.root, 'f.txt')).toBe(false);
    // Undone and redone again, then a request while it stands reverted: the next Undo can still be redone.
    await dev.ask('more work', [['write_file', { path: 'other.txt', content: 'o2\n' }]]);
    expect((await recovery.undo(revert.operationId!)).targets[0].outcome).toBe('applied');
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(true);
  });

  it('F2: a finished revert whose notice could not be recorded gets it once the history works again, once', async () => {
    let failing = true;
    const w = await workspace({ failJournalAfter: (body) => failing && body.kind === 'recovery-notice' });
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'n.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const report = await recovery.apply(preview.previewId);
    expect(report.incomplete).toBeDefined();
    expect(await exists(w.root, 'n.txt')).toBe(false);
    const store = (await w.history.store())!;
    await store.refresh();
    expect(store.recoveryOperation(report.operationId!)?.closed?.applied).toBe(1);
    expect(store.hasRecoveryNotice(report.operationId!)).toBe(false);
    // Storage works again: the same window repairs it at its next look, and only once.
    failing = false;
    await recovery.settle();
    await recovery.settle();
    expect(store.pendingRecoveryNotices('dev')).toHaveLength(1);
    expect(store.pendingRecoveryNotices('dev')[0]).toMatchObject({ operationId: report.operationId, branchId: report.branchId });
    expect(store.pendingRecoveryNotices('dev')[0].targets).toHaveLength(1);
    // A finished operation with its notice is left as it is; no file is touched by the repair.
    expect(await exists(w.root, 'n.txt')).toBe(false);
  });

  it('F2: a finished revert missing its notice is repaired by the next window once its own window is gone', async () => {
    let failing = true;
    const w = await workspace({ failJournalAfter: (body) => failing && body.kind === 'recovery-notice' });
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'm.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const report = await recovery.apply(preview.previewId);
    failing = false;
    await w.history.flush();
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    // Its window is still alive: it repairs its own notice, so this one waits.
    await next.settle();
    expect(reopened.hasRecoveryNotice(report.operationId!)).toBe(false);
    liveness.set(5, 'gone');
    await next.settle();
    expect(reopened.pendingRecoveryNotices('dev')).toHaveLength(1);
    await reopened.dispose();
  });

  it('F2: a revert whose journal failed after a file was written is completed from the files by the next window', async () => {
    let armed = false;
    let failing = false;
    const w = await workspace({ failJournalAfter: (body) => {
      if (armed && body.kind === 'recovery-target' && body.phase === 'applied') failing = true;
      return failing;
    } });
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'g.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    armed = true;
    const report = await recovery.apply(preview.previewId);
    expect(report.targets[0].outcome).toBe('applied');
    expect(report.incomplete).toMatch(/could not record all of this operation/);
    expect(report.branchId).toBeUndefined();
    expect(await exists(w.root, 'g.txt')).toBe(false);
    // The window stops; another one opens the history after it is proven gone.
    await w.history.flush();
    liveness.set(5, 'gone');
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    const positions = await next.positions(report.operationId!);
    expect([...positions.values()].map((p) => p.position)).toEqual(['reverted']);
    expect(reopened.activeBranch).not.toBe('main');
    expect(reopened.pendingRecoveryNotices('dev')).toHaveLength(1);
    expect((await next.undo(report.operationId!)).targets[0].outcome).toBe('applied');
    expect((await read(w.root, 'g.txt')).toString()).toBe('made\n');
    await reopened.dispose();
  });

  it('F2: when only a target\'s result could not be recorded, no branch is claimed and the same window completes it later', async () => {
    let armed = false;
    let failed = false;
    const w = await workspace({ failJournalAfter: (body) => {
      if (!armed || failed || body.kind !== 'recovery-target' || body.phase !== 'applied') return false;
      failed = true;
      return true;
    } });
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'k.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    armed = true;
    const report = await recovery.apply(preview.previewId);
    expect(report.incomplete).toMatch(/could not record all of this operation/);
    expect(report.branchId).toBeUndefined();
    const store = (await w.history.store())!;
    await store.refresh();
    expect(store.recoveryOperation(report.operationId!)?.closed).toBeUndefined();
    // The journal works again: the next look completes it from the file, here.
    expect([...(await recovery.positions(report.operationId!)).values()].map((p) => p.position)).toEqual(['reverted']);
    expect(store.activeBranch).not.toBe('main');
  });

  it('F2: a target whose window stopped after the intent and before the write is completed as not written', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'm.txt', content: 'made\n' }]]);
    const recovery = await w.recovery({ stopBeforeWrite: true });
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    await expect(recovery.apply(preview.previewId)).rejects.toThrow(/window stopped/);
    expect(await exists(w.root, 'm.txt')).toBe(true);
    await w.history.flush();
    liveness.set(5, 'gone');
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    const operationId = reopened.recoveryOperations().at(-1)!.operationId;
    expect((await next.positions(operationId)).size).toBe(0);
    const operation = reopened.recoveryOperation(operationId)!;
    expect(operation.closed).toMatchObject({ applied: 0 });
    expect(operation.targets[0]).toMatchObject({ phase: 'failed', reason: expect.stringMatching(/not written/) });
    expect(reopened.activeBranch).toBe('main');
    await reopened.dispose();
  });

  it('F2: a window still running its operation keeps it; nothing is completed for it', async () => {
    let armed = false;
    const w = await workspace({ failJournalAfter: (body) => armed && body.kind === 'recovery-target' && body.phase === 'applied' || armed && body.kind === 'recovery-closed' });
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'h.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    armed = true;
    const report = await recovery.apply(preview.previewId);
    await w.history.flush();
    // Process 5 (the first window) is alive: the other window leaves its operation alone.
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    expect((await next.positions(report.operationId!)).size).toBe(0);
    expect(reopened.recoveryOperation(report.operationId!)?.closed).toBeUndefined();
    await reopened.dispose();
  });

  it('F3: a request another window admitted keeps its files until that window is proven gone', async () => {
    const w = await workspace();
    liveness.set(7, 'alive');
    const otherWindow = new HistoryService({ open: () => w.openStore(7), state: new State() });
    const otherStore = (await otherWindow.store())!;
    await otherStore.publishIdentityNow();
    const dev = w.agent('dev');
    const first = await dev.ask('in the other window', [['write_file', { path: 'o.txt', content: 'x\n' }]], otherWindow);
    const recovery = await w.recovery();
    const live = await recovery.preview('dev', first.historyId);
    if ('refused' in live) throw new Error(live.refused);
    expect(live.targets[0]).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/another UnodeAi window/) });
    liveness.set(7, 'gone');
    const ended = await recovery.preview('dev', first.historyId);
    if ('refused' in ended) throw new Error(ended.refused);
    expect(ended.targets[0]).toMatchObject({ action: 'remove' });
    expect((await recovery.apply(ended.previewId)).targets[0].outcome).toBe('applied');
    expect(await exists(w.root, 'o.txt')).toBe(false);
    await otherWindow.flush();
    await otherStore.dispose();
  });

  it('F4: a file another request changes after the plan, even back to the same bytes, is a conflict; the rest is restored', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const qa = w.agent('qa');
    const first = await dev.ask('two files', [['write_file', { path: 'a.txt', content: 'dev a\n' }], ['write_file', { path: 'b.txt', content: 'dev b\n' }]]);
    let once = false;
    const recovery = await w.recovery({ beforePrepare: async (physical) => {
      if (once || !physical.endsWith('a.txt')) return;
      once = true;
      // While a.txt is being restored, another member changes b.txt and puts the same bytes back.
      await qa.ask('qa', [['write_file', { path: 'b.txt', content: 'qa work\n' }], ['write_file', { path: 'b.txt', content: 'dev b\n' }]]);
    } });
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    expect(preview.targets.map((t) => t.action)).toEqual(['remove', 'remove']);
    const report = await recovery.apply(preview.previewId);
    const byName = Object.fromEntries(report.targets.map((t) => [t.displayPath, t]));
    expect(byName['a.txt'].outcome).toBe('applied');
    expect(byName['b.txt']).toMatchObject({ outcome: 'conflict', reason: expect.stringMatching(/changed it after the preview/) });
    expect((await read(w.root, 'b.txt')).toString()).toBe('dev b\n');
  });
});

/* v0.9.110 (deviation 8): housekeeping keeps a task an Undo revert or Redo revert can still reach. */
describe('Housekeeping and Undo/Redo', () => {
  /** Housekeeping with no room for any ended task, so only what is protected stays; what it deleted. */
  async function tightHousekeeping(w: Awaited<ReturnType<typeof workspace>>): Promise<string[]> {
    const store = (await w.history.store())!;
    const real = store.housekeep.bind(store);
    const deleted: string[] = [];
    (store as any).housekeep = async (_limits: unknown, protect: never) => {
      const outcome = await real({ maxAgeMs: 30 * 86_400_000, maxEndedTasks: 0, maxBytes: 1 << 30 }, protect);
      deleted.push(...outcome.deleted);
      return outcome;
    };
    await w.history.housekeep(true);
    (store as any).housekeep = real;
    return deleted;
  }

  it('keeps the reverted requests while Undo can reach them, and lets them go once neither Undo nor Redo can', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('first', [['write_file', { path: 'h1.txt', content: 'one\n' }]]);
    const second = await dev.ask('second', [['write_file', { path: 'h2.txt', content: 'two\n' }]]);
    const unrelated = await w.agent('qa').ask('unrelated', [['write_file', { path: 'qa.txt', content: 'qa\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    expect(revert.targets.map((t) => t.outcome)).toEqual(['applied', 'applied']);
    // Undo can put both back: both requests stay; the other member's task does not.
    const store = (await w.history.store())!;
    expect(releasableRecoveryOperations(store)).toEqual([]);
    let deleted = await tightHousekeeping(w);
    expect(deleted).toContain(unrelated.historyId);
    expect(deleted).not.toContain(first.historyId);
    expect(deleted).not.toContain(second.historyId);
    // Undone, then a newer request: Redo is history and nothing stands reverted, so neither can reach them.
    const undo = await recovery.undo(revert.operationId!);
    expect(undo.targets.map((t) => t.outcome)).toEqual(['applied', 'applied']);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(true);
    // Redo can still use what the revert kept: nothing is released.
    expect(releasableRecoveryOperations(store)).toEqual([]);
    deleted = await tightHousekeeping(w);
    expect(deleted).not.toContain(first.historyId);
    await dev.ask('newer', [['write_file', { path: 'h3.txt', content: 'three\n' }]]);
    expect(await recovery.redoAvailable(revert.operationId!)).toBe(false);
    // Neither Undo nor Redo can use the revert's or the Undo's restore points any more.
    expect(releasableRecoveryOperations(store).sort()).toEqual([revert.operationId!, undo.operationId!].sort());
    deleted = await tightHousekeeping(w);
    expect(deleted).toEqual(expect.arrayContaining([first.historyId, second.historyId]));
    // Housekeeping removes conversations only: the files are as the Undo left them.
    expect((await read(w.root, 'h1.txt')).toString()).toBe('one\n');
    expect((await read(w.root, 'h2.txt')).toString()).toBe('two\n');
  });
});

/* v0.9.110: deleting the restore points of reverted requests retires the revert (design §5). */
describe('Deleting restore points of a reverted request', () => {
  /** A revert of one created file, and the store it is recorded in. */
  async function reverted(file: string) {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: file, content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    return { w, first, recovery, op: revert.operationId!, store: (await w.history.store())! };
  }

  it('removing only the conversation keeps Undo revert, and stops telling the notice that names it', async () => {
    const { w, first, recovery, op, store } = await reverted('view-only.txt');
    const done = await store.deleteTasks({ historyIds: [first.historyId], scope: 'view', reason: 'explicit' });
    if (done.status !== 'deleted') throw new Error(done.reason);
    expect(store.recoveryRetired(op)).toBe(false);
    expect(store.pendingRecoveryNotices('dev').some((notice) => notice.operationId === op)).toBe(false);
    expect((await recovery.undo(op)).targets[0].outcome).toBe('applied');
    expect((await read(w.root, 'view-only.txt')).toString()).toBe('made\n');
  });

  it('Delete all takes a task whose conversation was removed before once it has ended; one with no recorded end keeps its revert', async () => {
    const { first, recovery, op, store } = await reverted('hidden-task.txt');
    expect((await store.deleteTasks({ historyIds: [first.historyId], scope: 'view', reason: 'explicit' })).status).toBe('deleted');
    // No end recorded for it: it may still be running, so Delete all leaves what it owns.
    expect((await store.deleteTasks({ historyIds: [], scope: 'both', reason: 'delete-all' })).status).toBe('deleted');
    expect(store.recoveryRetired(op)).toBe(false);
    // Its end is recorded: Delete all retires its revert.
    await store.append({ kind: 'outcome-reference', historyId: first.historyId, outcomeRef: 'outcome-hidden', terminal: 'completed',
      verification: 'unknown', endedAt: new Date().toISOString() });
    const done = await store.deleteTasks({ historyIds: [], scope: 'both', reason: 'delete-all' });
    if (done.status !== 'deleted') throw new Error(done.reason);
    expect(store.recoveryRetired(op)).toBe(true);
    expect(done.result.historyIds).toEqual([]);
    expect((await recovery.redo(op)).refused).toMatch(/restore points of this revert were deleted/);
  });

  it('Delete all in a window that opened the history after the conversation was removed still retires the revert', async () => {
    const { w, first, op, store } = await reverted('hidden-reopen.txt');
    const recovery = await w.recovery();
    expect((await recovery.undo(op)).targets[0].outcome).toBe('applied');
    expect((await read(w.root, 'hidden-reopen.txt')).toString()).toBe('made\n');
    await store.append({ kind: 'outcome-reference', historyId: first.historyId, outcomeRef: 'outcome-reopen', terminal: 'completed',
      verification: 'unknown', endedAt: new Date().toISOString() });
    expect((await store.deleteTasks({ historyIds: [first.historyId], scope: 'view', reason: 'explicit' })).status).toBe('deleted');
    await w.history.flush();
    // Another window opens the history: the message that began the task is gone from it.
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    expect(reopened.requestState(first.requestId).ended).toBe(true);
    const done = await reopened.deleteTasks({ historyIds: [], scope: 'both', reason: 'delete-all' });
    if (done.status !== 'deleted') throw new Error(done.reason);
    expect(done.result.historyIds).toEqual([]);
    expect(reopened.recoveryRetired(op)).toBe(true);
    const next = await w.recovery({ store: reopened });
    expect((await next.redo(op)).refused).toBeDefined();
    expect((await read(w.root, 'hidden-reopen.txt')).toString()).toBe('made\n');
    await reopened.dispose();
    // And a third reading agrees: no record of the revert is left.
    liveness.set(7, 'alive');
    const third = await w.openStore(7);
    expect(third.recoveryOperation(op)).toBeUndefined();
    await third.dispose();
  });

  it('deleting only the restore points retires the revert; its notice, about files really put back, is still told', async () => {
    const { w, first, recovery, op, store } = await reverted('points-only.txt');
    const done = await store.deleteTasks({ historyIds: [first.historyId], scope: 'restore-points', reason: 'explicit' });
    if (done.status !== 'deleted') throw new Error(done.reason);
    expect(store.recoveryRetired(op)).toBe(true);
    expect((await recovery.undo(op)).refused).toMatch(/restore points of this revert were deleted/);
    expect(store.pendingRecoveryNotices('dev').some((notice) => notice.operationId === op)).toBe(true);
    // Its conversation stays, so its record does too: a window that opens the history again knows it, retired.
    await w.history.flush();
    const reopened = await w.openStore(6);
    expect(reopened.recoveryOperation(op)?.closed?.applied).toBe(1);
    expect(reopened.recoveryRetired(op)).toBe(true);
    await reopened.dispose();
  });

  it('retires its revert: no Undo or Redo, its kept bytes are owed for removal, nothing protects it, its notice is not told or repaired', async () => {
    const w = await workspace();
    const dev = w.agent('dev');
    const first = await dev.ask('create', [['write_file', { path: 'deleted-revert.txt', content: 'made\n' }]]);
    const recovery = await w.recovery();
    const preview = await recovery.preview('dev', first.historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    const revert = await recovery.apply(preview.previewId);
    const op = revert.operationId!;
    expect(await exists(w.root, 'deleted-revert.txt')).toBe(false);
    const store = (await w.history.store())!;
    // What the revert kept of the file before it removed it, for Undo revert.
    const inverse = store.recoveryOperation(op)!.targets.map((target) => target.inverse)
      .flatMap((state) => (state?.kind === 'file' && state.payloadRef ? [state.payloadRef] : []));
    expect(inverse).toHaveLength(1);
    expect(store.pendingRecoveryNotices('dev').some((notice) => notice.operationId === op)).toBe(true);
    const done = await store.deleteTasks({ historyIds: [first.historyId], scope: 'both', reason: 'explicit' });
    if (done.status !== 'deleted') throw new Error(done.reason);
    expect(done.result.payloadRefs).toEqual(expect.arrayContaining(inverse));
    expect(store.recoveryRetired(op)).toBe(true);
    expect((await recovery.undo(op)).refused).toMatch(/restore points of this revert were deleted/);
    expect(await recovery.redoAvailable(op)).toBe(false);
    expect(releasableRecoveryOperations(store)).toContain(op);
    expect(undoRedoReachableRequests(store).has(first.requestId)).toBe(false);
    expect(store.pendingRecoveryNotices('dev').some((notice) => notice.operationId === op)).toBe(false);
    expect(await exists(w.root, 'deleted-revert.txt')).toBe(false);
    // A window that opens the history after this one is gone finds no notice, and records none again.
    await w.history.flush();
    liveness.set(5, 'gone');
    liveness.set(6, 'alive');
    const reopened = await w.openStore(6);
    const next = await w.recovery({ store: reopened });
    await next.settle();
    expect(reopened.hasRecoveryNotice(op)).toBe(false);
    // Its conversation and restore points are both gone: no record of the revert is left, so nothing can step it.
    expect(reopened.recoveryOperation(op)).toBeUndefined();
    expect((await next.undo(op)).refused).toMatch(/no finished revert/);
    await reopened.dispose();
  });
});

/*
 * v0.9.110 R1b: Claude's native file tools. The exact before bytes are kept at the PreToolUse hook, while Claude still
 * waits on it, and settled from the read-back of the file once the call's result (or the turn's end) comes.
 */
describe('R1b: native Claude changes keep their exact before bytes', () => {
  function claude(w: Awaited<ReturnType<typeof workspace>>, notices: string[] = []) {
    let request = '';
    const fileWrites = w.policy.forAgent({ agentId: 'claude-1', requestId: () => request, decide: async () => 'once', notice: (line) => { notices.push(line); } });
    const config: AgentConfig = {
      id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
      provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
      model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'],
      backend: 'claude', workingDirectory: w.root,
    };
    const backend = new ClaudeHeadlessBackend(config, undefined, undefined, { fileWrites, writeApprovalAsk: () => false });
    const gate = async (tool: string, input: Record<string, unknown>, id: string) =>
      (backend as any).handlePreToolUse({ tool_name: tool, tool_input: input, tool_use_id: id }) as Promise<{ allow: boolean; reason?: string }>;
    /** Claude runs the tool after an allow; the stream then reports the call and, unless `noResult`, its result. */
    const ran = async (tool: string, input: Record<string, unknown>, id: string, effect: () => Promise<void>, result: 'ok' | 'error' | 'none' = 'ok') => {
      await (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
      await effect();
      if (result !== 'none') {
        await (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
          content: result === 'ok' ? 'ok' : 'Error: the tool failed', ...(result === 'error' ? { is_error: true } : {}) }] } });
      }
      for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const begin = (goal: string) => {
      const historyId = randomUUID();
      request = `req-${randomUUID()}`;
      w.history.messageAppended('claude-1', { role: 'user', text: goal, ts: new Date().toISOString(), messageId: randomUUID() }, { historyId });
      w.history.requestAdmitted('claude-1', historyId, request);
      return historyId;
    };
    return { backend, gate, ran, begin, request: () => request };
  }
  const settleWrites = async (w: Awaited<ReturnType<typeof workspace>>) => {
    for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    await w.history.flush();
  };

  it('Revert puts back the exact bytes of a native Edit (BOM, CRLF) and a native Write over a binary file, and removes a created one', async () => {
    const w = await workspace();
    const c = claude(w);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const text = Buffer.concat([bom, Buffer.from('line one\r\nline two\r\n')]);
    const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f, 0x00, 0x01]);
    await fs.writeFile(path.join(w.root, 'bom.txt'), text);
    await fs.writeFile(path.join(w.root, 'blob.bin'), binary);
    const historyId = c.begin('native changes');
    const edit = { file_path: path.join(w.root, 'bom.txt'), old_string: 'line two', new_string: 'line 2' };
    expect((await c.gate('Edit', edit, 'toolu_edit')).allow).toBe(true);
    await c.ran('Edit', edit, 'toolu_edit', () => fs.writeFile(path.join(w.root, 'bom.txt'), Buffer.concat([bom, Buffer.from('line one\r\nline 2\r\n')])));
    const over = { file_path: path.join(w.root, 'blob.bin'), content: 'text now\n' };
    expect((await c.gate('Write', over, 'toolu_over')).allow).toBe(true);
    await c.ran('Write', over, 'toolu_over', () => fs.writeFile(path.join(w.root, 'blob.bin'), 'text now\n'));
    const created = { file_path: path.join(w.root, 'made.txt'), content: 'made\n' };
    expect((await c.gate('Write', created, 'toolu_made')).allow).toBe(true);
    await c.ran('Write', created, 'toolu_made', () => fs.writeFile(path.join(w.root, 'made.txt'), 'made\n'));
    await settleWrites(w);

    const recovery = await w.recovery();
    const preview = await recovery.preview('claude-1', historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    expect(preview.targets.map((t) => t.action).sort()).toEqual(['remove', 'restore', 'restore']);
    const report = await recovery.apply(preview.previewId);
    expect(report.targets.every((t) => t.outcome === 'applied'), JSON.stringify(report.targets)).toBe(true);
    expect((await read(w.root, 'bom.txt')).equals(text)).toBe(true);
    expect((await read(w.root, 'blob.bin')).equals(binary)).toBe(true);
    expect(await exists(w.root, 'made.txt')).toBe(false);
  });

  it('the line after a native Edit of a file UnodeAi did not write says its exact restore point was kept', async () => {
    const w = await workspace();
    const notices: string[] = [];
    const c = claude(w, notices);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fs.writeFile(path.join(w.root, 'claude.txt'), Buffer.concat([bom, Buffer.from('claude-before\r\nkeep\r\n')]));
    c.begin('native edit of a file written outside UnodeAi');
    const edit = { file_path: path.join(w.root, 'claude.txt'), old_string: 'claude-before', new_string: 'claude-after' };
    expect((await c.gate('Edit', edit, 'toolu_notice')).allow).toBe(true);
    await c.ran('Edit', edit, 'toolu_notice', () => fs.writeFile(path.join(w.root, 'claude.txt'), Buffer.concat([bom, Buffer.from('claude-after\r\nkeep\r\n')])));
    await settleWrites(w);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/claude\.txt" had changes UnodeAi did not make\. A restore point was kept; ⟲ undoes this\.$/);
  });

  it('a change let go whose result never came is read back at the end of the turn and can be reverted', async () => {
    const w = await workspace();
    const c = claude(w);
    await fs.writeFile(path.join(w.root, 'cut.txt'), 'before\n');
    const historyId = c.begin('cut short');
    const input = { file_path: path.join(w.root, 'cut.txt'), content: 'after\n' };
    expect((await c.gate('Write', input, 'toolu_cut')).allow).toBe(true);
    await c.ran('Write', input, 'toolu_cut', () => fs.writeFile(path.join(w.root, 'cut.txt'), 'after\n'), 'none');
    (c.backend as any).emitTurnComplete({ text: '' });
    await settleWrites(w);
    const recovery = await w.recovery();
    const preview = await recovery.preview('claude-1', historyId);
    if ('refused' in preview) throw new Error(preview.refused);
    expect(preview.targets).toHaveLength(1);
    expect((await recovery.apply(preview.previewId)).targets[0].outcome).toBe('applied');
    expect((await read(w.root, 'cut.txt')).toString()).toBe('before\n');
  });

  it('a target another writer changes while its before is kept is refused, and nothing is recorded for it', async () => {
    const w = await workspace();
    const c = claude(w);
    const target = path.join(w.root, 'raced.txt');
    await fs.writeFile(target, 'before\n');
    const historyId = c.begin('raced');
    w.hooks.duringCapture = async () => { w.hooks.duringCapture = undefined; await fs.writeFile(target, 'someone else\n'); };
    const decision = await c.gate('Write', { file_path: target, content: 'claude\n' }, 'toolu_raced');
    expect(decision.allow).toBe(false);
    expect((await fs.readFile(target)).toString()).toBe('someone else\n');
    await settleWrites(w);
    const recovery = await w.recovery();
    const preview = await recovery.preview('claude-1', historyId);
    const targets = 'refused' in preview ? [] : preview.targets;
    expect(targets).toEqual([]);
  });

  it('a call that failed and left its file as it was records no file change', async () => {
    const w = await workspace();
    const c = claude(w);
    await fs.writeFile(path.join(w.root, 'kept.txt'), 'as it was\n');
    c.begin('failed call');
    const input = { file_path: path.join(w.root, 'kept.txt'), content: 'never written\n' };
    expect((await c.gate('Write', input, 'toolu_failed')).allow).toBe(true);
    await c.ran('Write', input, 'toolu_failed', async () => {}, 'error');
    const store = (await w.history.store())!;
    // The read-back settles it once the restore point taken for it is given back.
    await vi.waitFor(async () => {
      await w.history.flush();
      await store.refresh();
      expect(store.recoveryManifest(c.request())).toMatchObject({ files: [], label: 'No recorded file changes' });
    }, { timeout: 10_000, interval: 20 });
  });

  it('a change another member also made meanwhile is not recorded as this request\'s result', async () => {
    const w = await workspace();
    const c = claude(w);
    const dev = w.agent('dev');
    await fs.writeFile(path.join(w.root, 'shared.txt'), 'before\n');
    c.begin('contested');
    const input = { file_path: path.join(w.root, 'shared.txt'), content: 'claude\n' };
    expect((await c.gate('Write', input, 'toolu_shared')).allow).toBe(true);
    const claudeRequest = c.request();
    await c.ran('Write', input, 'toolu_shared', async () => {
      await fs.writeFile(path.join(w.root, 'shared.txt'), 'claude\n');
      // Another member writes the same file before Claude's result is read back.
      await dev.ask('dev too', [['write_file', { path: 'shared.txt', content: 'dev\n' }]]);
    });
    const store = (await w.history.store())!;
    await vi.waitFor(async () => {
      await w.history.flush();
      await store.refresh();
      expect(store.recoveryManifest(claudeRequest)?.files[0]?.reason).toMatch(/could not be read back/);
    }, { timeout: 10_000, interval: 20 });
    const manifest = store.recoveryManifest(claudeRequest);
    expect(manifest?.files).toHaveLength(1);
    expect(manifest!.files[0].before).toMatchObject({ kind: 'file', sha256: sha('before\n') });
    expect(manifest!.files[0].after).toBeUndefined();
  });
});
