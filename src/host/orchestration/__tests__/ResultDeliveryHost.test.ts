import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
import { ResultDeliveryHost, resultDeliveryMarkerMatches, type ResultDeliveryHostPort } from '../ResultDeliveryHost';
import { MessageBus } from '../../../bus/MessageBus';
import { SessionManager } from '../../../session/SessionManager';
import type { AgentBackend } from '../../../backend/AgentBackend';
import type { AgentConfig } from '../../../types';
import { TeamTools } from '../../../backend/TeamTools';
import { PersistenceManager } from '../../../state/PersistenceManager';
import { DelegationResultBodyStore } from '../../../state/DelegationResultBodyStore';
import { RunLedger } from '../../../observability/RunLedger';
import { projectJobOutcome } from '../../../observability/JobOutcome';
import { TaskInputResolver } from '../../../backend/TaskContract';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { DelegationResultMailbox } from '../../../state/DelegationResultMailbox';
import { workspaceRootIdentity } from '../../../state/WorkspaceRootIdentity';

const base = path.join(process.cwd(), '.audit-repro', 'result-consumer');
const dirs: string[] = [];
// A heavy case that times out keeps running in the background; restore its prototype spies so they cannot leak into later cases.
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) {
  if (path.dirname(dir) !== base || !path.basename(dir).startsWith('case-')) throw new Error('Invalid cleanup');
  await fs.rm(dir, { recursive: true, force: true });
} });

async function setup() {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-')); dirs.push(dir);
  const data = new Map<string, unknown>();
  let fail = false; let current = true;
  let heldLedger: Promise<void> | undefined;
  const state = { get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, keys: () => [...data.keys()],
    update: async (key: string, value: unknown) => { if (fail) throw new Error('storage failed');
      if (value === undefined) data.delete(key); else data.set(key, structuredClone(value)); } };
  const persistence = new PersistenceManager({ workspaceState: state } as never, undefined, () => '/workspace');
  let ledger = new RunLedger();
  const markers = new Map<string, string>(); let persistedRuns: unknown[] = [];
  const recoveryReady = vi.fn();
  const archives = new Map<string, string>();
  const archive = vi.fn((_identity, text: string) => { const messageId = `archive-${archives.size + 1}`;
    archives.set(messageId, text); return { conversationId: 'pm', messageId }; }); const notice = vi.fn();
  const port = (): ResultDeliveryHostPort => ({ persistence, ledger, storageUri: { scheme: 'file', fsPath: dir },
    workspaceId: workspaceRootIdentity(dir), assertCurrent: () => { if (!current) throw new Error('stale'); }, owns: () => true,
    archive, hasDelivery: (id, digest) => markers.get(id.settledEventId) === digest,
    recordDelivery: async (id, digest) => { if (fail) throw new Error('marker save failed'); markers.set(id.settledEventId, digest); },
    saveArchive: async () => { if (fail) throw new Error('archive save failed'); },
    saveLedger: async () => { await heldLedger; if (fail) throw new Error('run save failed'); persistedRuns = ledger.snapshot(); }, notice, recoveryReady });
  let host = new ResultDeliveryHost(port()); await host.open();
  const dispatch = (handle = 'h') => { ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle, agentId: 'dev',
    requestedAgent: 'dev', instruction: 'do the work', attemptId: `attempt-${handle}`, originCorrelationId: 'user-task' }); host.reserve('pm', handle); };
  const settle = async (handle = 'h', text = 'worker answer') => {
    ledger.recordDelegationEvidence({ handle, agentId: 'dev', outcome: 'no-evidence', evidence: {
      outcome: 'no-evidence', changedFiles: [], hadToolActions: false, unrecordedWrites: false,
      verification: { ran: false } } });
    host.retain('pm', { handle, ref: 'dev', text }); await host.drain();
  };
  return { dispatch, settle, data, markers, notice, archive, dir, persistence, recoveryReady,
    host: () => host, ledger: () => ledger, fail: (value: boolean) => { fail = value; }, stale: () => { current = false; },
    holdLedger: (value: Promise<void> | undefined) => { heldLedger = value; },
    reload: async () => { await host.drain(); host.close(); ledger = new RunLedger(persistedRuns); host = new ResultDeliveryHost(port()); await host.open(); await host.drain(); } };
}

describe('T2b actual host consumer with real body files and PersistenceManager', () => {
  it.each([
    ['assign_task', 'task.complete', 0], ['dispatch_task', 'task.complete', 0], ['dispatch_task', 'task.partial', 1],
  ] as const)('F4: %s timeout then late %s leaves %s unfinished', async (tool, completion, unfinished) => {
    const h = await setup(); const bus = new MessageBus();
    const mailboxSettlement = vi.spyOn(DelegationResultMailbox.prototype, 'settle');
    let handle = '';
    const team = new TeamTools('pm', { list: () => [{ id: 'dev', name: 'Dev', role: 'custom', status: 'idle' }],
      resolve: () => ({ id: 'dev' }) }, bus, {
      timeoutMs: 100, evidenceEnabled: true, cwd: process.cwd(),
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
      onDelegationDispatched: event => {
        handle = event.handle;
        h.ledger().recordDelegationDispatched({ ...event, originCorrelationId: 'user-task' });
        h.host().reserve('pm', event.handle);
      },
      onDelegationEvidence: event => h.ledger().recordDelegationEvidence(event),
      onAsyncResultRetained: result => { h.host().retain('pm', result); },
      resultRevisionFor: value => h.ledger().resultIdentity('pm', value)?.ref.revision,
      isAsyncResultEligible: (value, revision) => h.host().canDeliver('pm', value, revision),
      prepareAsyncResultDelivery: (value, revision) => h.host().prepare('pm', value, revision),
      onAsyncResultDelivered: (value, via, revision) => {
        h.host().delivered('pm', value, via, revision); h.ledger().recordDeliveryDelivered(value, via);
      },
    });
    vi.useFakeTimers();
    try {
      const waiting = team.run(tool, { agent: 'dev', instruction: 'Return the draft.', contract: {
        version: 1, objective: 'Return the draft.', expected_deliverable: 'The draft.',
        effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
        required_capabilities: { version: 1, capabilities: [] }, execution_strategy: 'delegate-required',
      } });
      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toContain(tool === 'assign_task' ? 'ended only the wait' : 'Dispatched contract');
      expect(h.ledger().snapshot()[0].delegations[0]).toMatchObject({ state: 'active', evidence: { outcome: 'timed-out' } });
      bus.send('dev', 'pm', completion, { instruction: 'The completed late draft.' }, 'normal', handle);
      await Promise.resolve(); await Promise.resolve();
    } finally { vi.useRealTimers(); }
    try {
      await h.host().drain();
      expect(await team.run('collect_ready_tasks', {})).toContain('The completed late draft.');
      await h.host().drain();
      expect(h.notice).not.toHaveBeenCalled();
      expect(mailboxSettlement.mock.results.map(row => row.value)).toEqual(['settled']);
      expect(h.ledger().inspectTaskStatus('pm', [handle])[0]).toMatchObject({ lifecycle: 'settled', delivery: { state: 'delivered' } });
      if (tool === 'dispatch_task') {
        expect(h.ledger().snapshot()[0].delegations[0].evidence?.receiptSnapshots).toMatchObject({
          timeout: { requiredInputCount: 0 }, terminal: { requiredInputCount: 0 },
        });
      }
      h.ledger().observeMessage(bus.send('pm', 'user', 'task.complete', { instruction: 'Used the late draft.' }, 'normal', 'user-task'));
      const run = h.ledger().snapshot()[0];
      expect(projectJobOutcome(run.id, run, () => undefined)).toMatchObject({ work: { unfinished } });
    } finally { mailboxSettlement.mockRestore(); team.cancelPending('test cleanup'); bus.dispose(); }
  });
  it('reopens 256 cleanup-pending files, reclaims them, and actually stores the next result', async () => {
    const h = await setup();
    const busy = vi.spyOn(DelegationResultBodyStore.prototype, 'reclaimArchived').mockRejectedValue(new Error('busy'));
    try {
      for (let i = 0; i < 256; i++) {
        const handle = `old-${i}`; h.dispatch(handle); await h.settle(handle);
        await h.host().prepare('pm', handle); h.host().delivered('pm', handle, 'collect-ready'); await h.host().drain();
        h.ledger().recordDisposition({ handle, disposition: 'accepted', recordedAt: new Date().toISOString() });
        h.host().archiveDecided('pm', handle); await h.host().drain();
      }
      expect(h.persistence.archivedResultBodies()).toHaveLength(256);
    } finally { busy.mockRestore(); }
    await h.reload(); expect(h.persistence.archivedResultBodies()).toHaveLength(0); h.notice.mockClear();
    h.dispatch('after-reclaim'); await h.settle('after-reclaim');
    expect(h.persistence.loadResultMailboxIndex()).toHaveLength(1);
    expect(h.notice).not.toHaveBeenCalled();
    await h.reload(); expect(h.host().recover('pm')).toEqual([expect.objectContaining({ handle: 'after-reclaim', text: 'worker answer' })]);
  // 256 real files: about 13 s alone, but over 120 s in the complete Node 22 suite on a busy Windows disk.
  }, 600_000);
  it.each(['shutdown', 'config-edit', 'user-stop'] as const)('%s preserves the right pending-result delivery scope through reload', async cause => {
    const h = await setup(); h.dispatch(); await h.settle();
    const bus = new MessageBus();
    const turns: string[] = [];
    const manager = new SessionManager(1, bus, { resolveEnv: async () => ({}), createBackend: config => ({
      agentId: config.id, onEvent: () => () => {}, start: async () => {}, stop: async () => {},
      sendUserTurn(instruction: string) { turns.push(instruction); }, isAlive: () => true,
    } as AgentBackend) });
    manager.create({ id: 'pm', name: 'PM', role: 'senior-dev', skill: '', provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
      model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [] } as AgentConfig);
    manager.on('session.stopped', event => {
      if (event.data?.resultScope === 'suspend') h.host().scope('pm', 'coordinator-stopped');
    });
    try {
      await manager.start('pm', { pin: 'take' });
      if (cause === 'shutdown') await manager.shutdown();
      else if (cause === 'config-edit') {
        manager.get('pm')!.status = 'idle'; // The model route has finished its ready handshake.
        await manager.configEdited('pm', { backendKindChanged: false });
      }
      else await manager.stop('pm');
      await h.reload();
      if (cause === 'user-stop') {
        expect(h.host().canDeliver('pm', 'h')).toBe(false); expect(h.recoveryReady).not.toHaveBeenCalled();
      } else {
        expect(h.recoveryReady).toHaveBeenCalledExactlyOnceWith('pm', [expect.objectContaining({ handle: 'h' })]);
        expect(h.host().canDeliver('pm', 'h')).toBe(true);
        await manager.start('pm', { pin: 'take' });
        manager.get('pm')!.status = 'idle'; // Complete the fake model's ready handshake after host startup.
        const result = h.host().recover('pm')[0];
        const offer = () => manager.queueAsyncDelegationWake('pm', result, () => h.host().canDeliver('pm', result.handle),
          () => { if (!h.host().canDeliver('pm', result.handle)) return false; h.host().delivered('pm', result.handle, 'auto-wake'); return true; },
          () => h.host().prepare('pm', result.handle));
        offer();
        await vi.waitFor(() => { expect(turns).toHaveLength(1); expect(turns[0]).toContain('worker answer'); });
        await h.host().drain();
        offer(); await new Promise(resolve => setTimeout(resolve, 0)); expect(turns).toHaveLength(1);
        await h.reload(); expect(h.recoveryReady).toHaveBeenCalledTimes(1);
      }
    } finally { await manager.shutdown(); manager.dispose(); bus.dispose(); }
  });
  it('retries an interrupted archive cleanup on window reload without another owner or journal proof', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'collect-ready'); await h.host().drain();
    h.ledger().recordDisposition({ handle: 'h', disposition: 'accepted', recordedAt: new Date().toISOString() });
    const reclaim = vi.spyOn(DelegationResultBodyStore.prototype, 'reclaimArchived').mockRejectedValueOnce(new Error('busy'));
    try {
      h.host().archiveDecided('pm', 'h'); await h.host().drain();
      expect(h.persistence.archivedResultBodies()).toHaveLength(1);
      await h.reload();
      expect(h.persistence.archivedResultBodies()).toHaveLength(0);
      expect(reclaim).toHaveBeenCalledTimes(2);
    } finally { reclaim.mockRestore(); }
  });
  // v0.9.99 (Owner, 2026-10-27): a save that is only slow is not reported. The handoff still waits 500 ms; a save still
  // pending 30 s after its work was created gives one reminder, and a failed one is reported by its own path.
  describe('the recovery-pending reminder', () => {
    async function held() {
      const h = await setup(); h.dispatch(); await h.settle();
      let release!: () => void; h.holdLedger(new Promise<void>(resolve => { release = resolve; }));
      vi.useFakeTimers();
      return { h, release: () => release() };
    }
    const finish = async (h: Awaited<ReturnType<typeof setup>>, release: () => void) => {
      release(); h.holdLedger(undefined); vi.useRealTimers(); await h.host().drain();
    };

    it('does not keep delivery waiting, says nothing at 29,999 ms and once at 30,000 ms', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(500); await preparing;
        expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
        expect(h.notice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(29_499);
        expect(h.notice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.notice).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).toHaveBeenCalledTimes(1);
      } finally { await finish(h, release); }
    });

    it.each([600, 29_000])('says nothing for a save that completes at %i ms, and clears its deadline', async (at) => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(at); await preparing;
        release();
        // The rest of the save is real file I/O, which fake time does not advance: wait for the work itself.
        await h.host().drain();
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).not.toHaveBeenCalled();
      } finally { await finish(h, release); }
    });

    it('reports a save that fails at 600 ms once, from the failure path, and the deadline adds nothing', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(600); await preparing;
        h.fail(true); release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.notice).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).toHaveBeenCalledTimes(1);
      } finally { h.fail(false); await finish(h, release); }
    });

    it('says nothing after close(), and a prepare after close() sets no deadline', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(500); await preparing;
        h.host().close();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).not.toHaveBeenCalled();
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
      } finally { await finish(h, release); }
    });

    it('sets no deadline for a prepare after close()', async () => {
      const h = await setup(); h.dispatch('h'); h.dispatch('h2'); await h.settle('h'); await h.settle('h2');
      let release!: () => void; h.holdLedger(new Promise<void>(resolve => { release = resolve; }));
      vi.useFakeTimers();
      try {
        h.host().close();
        const preparing = h.host().prepare('pm', 'h2', 1);
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000); await preparing;
        expect(h.notice).not.toHaveBeenCalled();
      } finally { await finish(h, () => release()); }
    });

    it('keeps one deadline for two prepares of the same result', async () => {
      const { h, release } = await held();
      try {
        const first = h.host().prepare('pm', 'h', 1);
        const second = h.host().prepare('pm', 'h', 1);
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(1);
        await vi.advanceTimersByTimeAsync(500); await first; await second;
      } finally { await finish(h, release); }
    });
  });
  it('joins a saved marker to an entry by exact identity, not extra body fields or JSON order', async () => {
    const h = await setup(); h.dispatch(); const identity = h.ledger().resultIdentity('pm', 'h')!;
    const bus = new MessageBus();
    try {
      const digest = 'a'.repeat(64); const message = bus.send('unode', 'pm', 'system.heartbeat', {
        metadata: { resultDelivery: identity, sourceDigest: digest } });
      expect(resultDeliveryMarkerMatches(message, { ...identity, state: 'ready' } as typeof identity, digest)).toBe(true);
      expect(resultDeliveryMarkerMatches(message, { ...identity, ref: { handle: 'h', revision: 2 } }, digest)).toBe(false);
      expect(resultDeliveryMarkerMatches({ ...message, from: 'dev' }, identity, digest)).toBe(false);
      expect(resultDeliveryMarkerMatches(message, identity, 'b'.repeat(64))).toBe(false);
    } finally { bus.dispose(); }
  });

  it('two rebuilt tool instances cannot collect the same recovered result, or mistake an old revision for rework', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); await h.reload();
    const bus = new MessageBus();
    try {
      const make = () => new TeamTools('pm', { list: () => [], resolve: () => undefined }, bus, {
        recoveredAsyncResults: h.host().recover('pm'),
        prepareAsyncResultDelivery: (handle, revision) => h.host().prepare('pm', handle, revision),
        isAsyncResultEligible: (handle, revision) => h.host().canDeliver('pm', handle, revision),
        onAsyncResultDelivered: (handle, via, revision) => { h.host().delivered('pm', handle, via, revision); h.ledger().recordDeliveryDelivered(handle, via); },
        resultCloseoutBlockers: () => h.ledger().resultCloseoutBlockers('pm'),
      });
      const first = make(); const stale = make();
      expect(await first.run('collect_ready_tasks', {})).toContain('worker answer');
      expect(await first.run('close_assignment', { outcome: 'complete', summary: 'done' })).toContain('still needs');
      h.ledger().recordDisposition({ handle: 'h', disposition: 'needs-human', reason: 'need a person', recordedAt: new Date().toISOString() });
      expect(h.ledger().inspectTaskStatus('pm', ['h'])[0].result?.state).toBe('awaiting-human');
      expect(await first.run('close_assignment', { outcome: 'complete', summary: 'done' })).toContain('still needs');
      expect(await stale.run('collect_ready_tasks', {})).not.toContain('worker answer');
      await h.host().drain(); await h.host().prepare('pm', 'h', 1);
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      h.ledger().beginResultRework('pm', 'h'); h.host().reserve('pm', 'h');
      h.host().retain('pm', { handle: 'h', ref: 'dev', text: 'second revision' }); await h.host().drain();
      expect(h.host().canDeliver('pm', 'h', 1)).toBe(false); expect(h.host().canDeliver('pm', 'h', 2)).toBe(true);
      expect(await stale.run('collect_ready_tasks', {})).not.toContain('worker answer');
      expect(h.host().canDeliver('pm', 'h', 2)).toBe(true);
    } finally { bus.dispose(); }
  });

  it('reclaims 300 decided results in one process without storageOwner or a retained journal copy', async () => {
    const h = await setup();
    for (let i = 0; i < 300; i++) {
      const handle = `full-${i}`; h.dispatch(handle); await h.settle(handle);
      await h.host().prepare('pm', handle); h.host().delivered('pm', handle, 'collect-ready'); await h.host().drain();
      h.ledger().recordDisposition({ handle, disposition: 'accepted', recordedAt: new Date().toISOString() });
      h.host().archiveDecided('pm', handle); await h.host().drain();
      expect(h.persistence.archivedResultBodies()).toHaveLength(0);
      expect(h.notice).not.toHaveBeenCalled();
    }
    expect(h.persistence.loadResultMailboxIndex()).toEqual([]);
    await h.reload(); expect(h.persistence.archivedResultBodies()).toHaveLength(0);
    h.dispatch('after-full'); await h.settle('after-full'); expect(h.host().recover('pm')[0].handle).toBe('after-full');
  // This deliberately creates/retires 300 real files in one host without an editor identity.
  // A busy Windows disk must not turn the capacity regression into a scheduling race (52 s in the complete Node 22 suite).
  }, 600_000);

  it('retires only a completely proven legacy source and keeps an ambiguous legacy result unchanged', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    const old = [{ coordinatorId: 'pm', handle: 'h', ref: 'dev', text: 'worker answer' }];
    await h.persistence.savePendingDelegationResults(old); await h.reload();
    expect(h.persistence.loadPendingDelegationResults()).toEqual([]); expect(h.host().recover('pm')).toHaveLength(1);
    const ambiguous = [{ coordinatorId: 'pm', handle: 'unknown', ref: 'dev', text: 'irreplaceable old answer' }];
    await h.persistence.savePendingDelegationResults(ambiguous); await h.reload();
    expect(h.persistence.loadPendingDelegationResults()).toEqual(ambiguous);
  });
  it('does not hand off a ready result after the coordinator already decided to abandon it', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
    h.ledger().recordDisposition({ handle: 'h', disposition: 'abandoned', recordedAt: new Date().toISOString() });
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    h.host().archiveDecided('pm', 'h'); await h.host().drain();
    expect(h.host().recover('pm')).toEqual([]);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    await h.reload(); expect(h.host().recover('pm')).toEqual([]);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    expect(h.markers.size).toBe(0); // Closing an undelivered result never invents a delivery acknowledgement.
  });
  it('restores an undelivered body, delivers once, then never reoffers it on a second reload', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    await h.reload(); expect(h.host().recover('pm')).toEqual([{ handle: 'h', ref: 'dev', text: 'worker answer', resultRevision: 1 }]);
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'collect-ready'); await h.host().drain();
    expect(h.markers.size).toBe(1); await h.reload(); expect(h.host().recover('pm')).toEqual([]);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
  });
  it('crash between persisted handoff intent and observed delivery is unknown, not automatically replayed', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); await h.host().prepare('pm', 'h');
    await h.reload(); expect(h.host().recover('pm')).toEqual([]); expect(h.markers.size).toBe(0);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('delivery-unknown');
  });
  it('keeps a delivered result queryable for a decision; needs-rework gets a different preallocated completion', async () => {
    const h = await setup(); h.dispatch(); const first = h.ledger().resultIdentity('pm', 'h')!; await h.settle();
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain();
    h.ledger().recordDisposition({ handle: 'h', disposition: 'needs-rework', reason: 'fix the output', recordedAt: new Date().toISOString() });
    h.ledger().beginResultRework('pm', 'h'); h.host().reserve('pm', 'h');
    const second = h.ledger().resultIdentity('pm', 'h')!;
    expect(second.ref.revision).toBe(2); expect(second.settledEventId).not.toBe(first.settledEventId);
    h.host().retain('pm', { handle: 'h', ref: 'dev', text: 'revised answer' }); await h.host().drain();
    await h.reload(); expect(h.host().recover('pm')[0].text).toBe('revised answer');
    expect(h.ledger().snapshot()[0].delegations[0].resultHistory).toHaveLength(2);
  });
  it('does not run a stale completion after Stop/removal, or resurrect its scope on a replacement start', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); h.host().scope('pm', 'coordinator-stopped');
    expect(h.host().recover('pm')).toEqual([]); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain(); expect(h.markers.size).toBe(0);
    await h.reload(); expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    h.host().scope('pm', 'explicit-resume'); expect(h.host().recover('pm')).toHaveLength(1);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
    h.host().scope('pm', 'coordinator-removed'); h.host().scope('pm', 'explicit-resume');
    await h.reload(); expect(h.host().recover('pm')).toEqual([]);
  });
  it('retains live work and gives one reminder when storage fails; does not revive the old whole-array writer', async () => {
    const h = await setup(); h.dispatch(); h.fail(true); await h.settle();
    expect(h.host().recover('pm')[0].text).toBe('worker answer'); await h.host().prepare('pm', 'h');
    expect(h.notice).toHaveBeenCalledTimes(1); expect(h.data.has('roam.pendingDelegationResults')).toBe(false);
  });
  it('uses original ledger identities and never imports a body for a different coordinator', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); expect(h.host().recover('other')).toEqual([]);
    h.stale(); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain(); expect(h.markers.size).toBe(0);
  });
});
