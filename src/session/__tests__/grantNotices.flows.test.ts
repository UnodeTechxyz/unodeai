import { rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointStore, deleteRestorePoint } from '../../backend/Checkpoints';
import { PreChangeCheckpoints } from '../../backend/PreChangeCheckpoints';
import { RawCheckpointStore } from '../../backend/RawCheckpointStore';
import { SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { TeamTools } from '../../backend/TeamTools';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';
import type { GrantNoticeReport } from '../GrantNotices';
import { grantNoticeLine } from '../../host/grantNoticeText';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';

/**
 * v0.9.100: telling agents about file-access grants, through the real SessionManager, MessageBus, RunLedger and task
 * accounting. The model is a scripted backend, and usage figures are scripted input: these flows prove attribution,
 * not any real figure. Each flow reads its end state from the real records.
 */
class ScriptedBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void {}
  isAlive(): boolean { return this.alive; }
  readonly snapshotKind = 'openai-compat' as const;
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): boolean { return true; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

/** A route with confirmed steering. Each notice has its own receipt, answered when and how the test says. */
class SteeredBackend extends ScriptedBackend {
  receipts: Array<{ text: string; answer: (accepted: boolean) => void }> = [];
  steerNotice(text: string): Promise<boolean> {
    return new Promise((resolve) => { this.receipts.push({ text, answer: resolve }); });
  }
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, costUsd: 0.01 });
const config = (id: string, role = 'senior-dev'): AgentConfig => ({
  id, name: id, role: role as AgentConfig['role'], skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'K' },
  model: 'claude-sonnet-4-20250514', systemPrompt: '', autoApprove: true, allowedTools: [],
});
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness(options: { steered?: boolean; held?: () => boolean; onTurnComplete?: () => Promise<void> } = {}) {
  const bus = new MessageBus();
  const backends = new Map<string, ScriptedBackend>();
  let ledger = new RunLedger();
  const log: Message[] = [];
  const mgr = new SessionManager(5, bus, {
    createBackend: (cfg) => {
      const made = options.steered ? new SteeredBackend(cfg) : new ScriptedBackend(cfg);
      backends.set(cfg.id, made);
      return made;
    },
    resolveEnv: async () => ({}),
    coordinatorHeld: options.held,
    onTurnComplete: options.onTurnComplete,
    continuationDecided: (coordinatorId, correlationId) => ledger.beginContinuation(coordinatorId, correlationId),
    continuationAbandoned: (coordinatorId, correlationId) => ledger.abandonContinuation(coordinatorId, correlationId),
    threadRunOpen: (coordinatorId, correlationId) => ledger.threadRunOpen(coordinatorId, correlationId),
    replyEndsContinuation: (coordinatorId, correlationId, replyCorrelationId) => ledger.replyEndsContinuation(coordinatorId, correlationId, replyCorrelationId),
  });
  bus.subscribe({}, (message) => { log.push(message); ledger.observeMessage(message); });
  const agent = async (id: string, role?: string) => {
    mgr.create(config(id, role));
    await mgr.start(id, { pin: 'take' });
    backends.get(id)!.emit({ kind: 'ready' });
    return backends.get(id)! as SteeredBackend;
  };
  const tell = (id: string, requestId: string, text: string) => {
    const reports: GrantNoticeReport[] = [];
    mgr.tellFileAccessGrant(id, requestId, text, (report) => reports.push(report));
    return reports;
  };
  const finish = (backend: ScriptedBackend, text = 'done', extra: Record<string, unknown> = {}) =>
    backend.emit({ kind: 'turn_complete', result: { text, isError: false, ...extra } } as BackendEvent);
  /** The agent opens a run in this thread, with one worker, as a real dispatch does. */
  const dispatch = (coordinator: string, correlationId: string, handle: string, agentId = 'dev') =>
    ledger.recordDelegationDispatched({ coordinatorId: coordinator, handle, agentId, requestedAgent: agentId,
      instruction: 'do the work', attemptId: `attempt-${handle}`, originCorrelationId: correlationId });
  const settle = (handle: string, agentId = 'dev') => ledger.recordDelegationEvidence({ handle, agentId, outcome: 'no-evidence', evidence: {
    outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false } } });
  const run = () => ledger.snapshot()[0];
  const reloadLedger = () => { ledger = new RunLedger(ledger.snapshot()); return ledger; };
  const replies = (from: string) => log.filter((message) => message.from === from && (message.type === 'task.complete' || message.type === 'task.partial'));
  return { bus, mgr, backends, agent, tell, finish, dispatch, settle, run, reloadLedger, replies, log, ledger: () => ledger };
}

const correlationOf = (log: Message[], instruction: string) => {
  const message = log.find((row) => row.payload.instruction === instruction);
  return message!.correlationId ?? message!.id;
};

describe('a grant during a turn that cannot be steered (Claude)', () => {
  it('shows the current state, continues the same request after the turn, and starts no request of its own', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'read the report' });
    const request = h.mgr.currentRequestId('dev')!;
    const reports = h.tell('dev', request, 'Host scope update: Read access.');
    expect(reports).toEqual([{ kind: 'waiting' }]);
    expect(dev.turns).toEqual(['read the report']);

    const gap: boolean[] = [];
    h.bus.subscribe({ to: 'user' }, () => gap.push(h.mgr.requestRunning(request)));
    h.finish(dev, 'I could not read it');
    // The grant is still the request's between the reply and the next turn.
    expect(gap[0]).toBe(true);
    expect(reports).toEqual([{ kind: 'waiting' }, { kind: 'continues' }]);
    expect(dev.turns).toHaveLength(2);
    expect(dev.turns[1]).toContain('Host scope update: Read access.');
    expect(h.mgr.currentRequestId('dev')).toBe(request);
    expect(h.replies('dev')[0].payload.metadata).toMatchObject({ continuesInTurn: true });

    h.finish(dev, 'read it');
    await tick();
    expect(dev.turns).toHaveLength(2);
    expect(h.mgr.requestRunning(request)).toBe(false);
    expect(h.replies('dev')[1].payload.metadata).not.toHaveProperty('continuesInTurn');
  });

  it('a For this request grant works in the continuation, ends with the request, and both turns name the turn the person started', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const request = h.mgr.currentRequestId('dev')!;
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const file = path.join(os.tmpdir(), `unode-grant-notice-${process.pid}.txt`);
    writeFileSync(file, 'outside');
    try {
      await owner.requestPathAccess(file, { requestId: request, isCurrent: () => true, requestCurrent: () => h.mgr.requestRunning(request) },
        async () => ({ permission: 'read', lifetime: 'request' }));
      h.tell('dev', request, 'Host scope update: Read access.');
      const origins: string[] = [];
      h.mgr.on('session.requestCloseout', (event) => { if (event.data) origins.push(event.data.record.originTurnId); });
      // Between the reply and the next turn, another agent's file call must not end the grant.
      const inTheGap: boolean[] = [];
      const unsubscribe = h.bus.subscribe({ to: 'user' }, () => { owner.pathAccessFor('another-request'); inTheGap.push(h.mgr.requestRunning(request)); });
      h.finish(dev);
      unsubscribe();
      expect(inTheGap).toEqual([true]);
      expect(owner.pathAccessFor(h.mgr.currentRequestId('dev'))).toHaveLength(1);
      h.finish(dev);
      await tick();
      expect(h.mgr.requestRunning(request)).toBe(false);
      expect(owner.pathAccessFor(request)).toHaveLength(0);
      expect(origins).toHaveLength(2);
      expect(new Set(origins).size).toBe(1);
    } finally { rmSync(file, { force: true }); }
  });

  it('a notice that gives way holds nothing: the restore point of its request can be deleted at once', async () => {
    const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-grant-notice-')));
    const h = harness();
    try {
      const dev = await h.agent('dev');
      h.bus.send('user', 'dev', 'ask.question', { instruction: 'first' });
      const r1 = h.mgr.currentRequestId('dev')!;
      const pre = new PreChangeCheckpoints({ open: async () => (await RawCheckpointStore.open({ directory: dir, workspaceId: 'ws' })).store,
        isRequestRunning: (id) => h.mgr.requestRunning(id) });
      const target = path.resolve('/ws/a.txt');
      const kept = await pre.capture({ agentId: 'dev', requestId: r1, path: 'a.txt', target, physical: target, bytes: Buffer.from('before') });
      if (kept.status !== 'kept') throw new Error(kept.reason);
      const reference = await kept.checkpoint.settle({ kind: 'committed', after: { exists: true, size: 5, sha256: 'a'.repeat(64) } });
      const records = new CheckpointStore();
      const cp = records.record({ agentId: 'dev', agentName: 'dev', tool: 'write_file', path: 'a.txt', target, before: 'old', after: 'new', raw: reference as never } as never)!;
      const opened = await pre.store();
      if (!('store' in opened)) throw new Error(opened.unavailable);
      h.tell('dev', r1, 'Host scope update: Read access.');
      h.bus.send('user', 'dev', 'ask.question', { instruction: 'second' });
      expect(await deleteRestorePoint(records, opened.store, cp.id, () => pre.releaseEndedRequests())).toBe('in-use');
      h.finish(dev);
      expect(dev.turns).toEqual(['first', 'second']);
      expect(h.mgr.requestRunning(r1)).toBe(false);
      expect(await deleteRestorePoint(records, opened.store, cp.id, () => pre.releaseEndedRequests())).toBe('deleted');
    } finally {
      h.mgr.dispose();
      h.bus.dispose();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('is never shown as the person\'s words', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    const fromUser: Message[] = [];
    h.bus.subscribe({ from: 'user' }, (message) => fromUser.push(message));
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    h.finish(dev);
    expect(fromUser).toHaveLength(1);
    expect(h.log.find((message) => message.payload.metadata?.autoWake === 'scope-update')?.from).toBe('unode');
  });

  it('a message the person already queued goes first, and the notice gives way', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'first' });
    const request = h.mgr.currentRequestId('dev')!;
    const reports = h.tell('dev', request, 'Host scope update: Read access.');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'second' });
    h.finish(dev);
    expect(reports.at(-1)).toEqual({ kind: 'not-told', reason: 'queued-message' });
    expect(dev.turns).toEqual(['first', 'second']);
    expect(h.mgr.requestRunning(request)).toBe(false);
    expect(h.replies('dev')[0].payload.metadata).not.toHaveProperty('continuesInTurn');
  });

  it('a message arriving after the decision waits for the continuation, which outranks it', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ onTurnComplete: () => hold });
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'first' });
    h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    h.finish(dev);
    // Closing work holds the turn's end, so this message arrives between the decision and the send.
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'second' });
    expect(dev.turns).toEqual(['first']);
    release();
    await vi.waitFor(() => expect(dev.turns).toHaveLength(2));
    expect(dev.turns[1]).toContain('Read access.');
    h.finish(dev);
    await vi.waitFor(() => expect(dev.turns[2]).toBe('second'));
  });

  it.each([
    ['an error', { isError: true }, 'turn-failed'],
    ['an unresolved end', { unresolvedReason: 'no reply' }, 'turn-failed'],
    ['a stopped result', { stop: { state: 'stopped', reason: 'limit' } }, 'turn-failed'],
  ] as const)('a turn ending in %s gets no continuation', async (_name, extra, reason) => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    h.finish(dev, 'x', extra);
    await tick();
    expect(reports.at(-1)).toEqual({ kind: 'not-told', reason });
    expect(dev.turns).toEqual(['work']);
  });

  it('the process dying mid-turn tells nothing and continues nothing', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    dev.emit({ kind: 'exit', code: 1 });
    await tick();
    expect(reports.at(-1)).toEqual({ kind: 'not-told', reason: 'turn-failed' });
    expect(dev.turns).toEqual(['work']);
  });

  it('a held coordinator is not resumed', async () => {
    const h = harness({ held: () => true });
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    h.finish(dev);
    await tick();
    expect(reports.at(-1)).toEqual({ kind: 'not-told', reason: 'held' });
    expect(dev.turns).toEqual(['work']);
  });
});

describe('which turn may hear a grant', () => {
  it('another request\'s running turn never does, and says so', async () => {
    const h = harness({ steered: true });
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'first request' });
    const r1 = h.mgr.currentRequestId('pm')!;
    h.finish(pm);
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'second request' });
    const reports = h.tell('pm', r1, 'Host scope update: for the first request.');
    expect(reports).toEqual([{ kind: 'not-told', reason: 'other-request' }]);
    expect(pm.receipts).toEqual([]);
    h.finish(pm);
    await tick();
    expect(pm.turns.join('\n')).not.toContain('for the first request');
  });

  it('a delegated worker that can be steered is told; one that cannot is not continued', async () => {
    for (const steered of [true, false]) {
      const h = harness({ steered });
      const pm = await h.agent('pm', 'project-manager');
      const dev = await h.agent('dev');
      h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
      h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' });
      const request = h.mgr.currentRequestId('dev')!;
      const reports = h.tell('dev', request, 'Host scope update: Read access.');
      if (steered) {
        dev.receipts[0].answer(true);
        await tick();
        expect(reports).toEqual([{ kind: 'told' }]);
      } else {
        expect(reports).toEqual([{ kind: 'not-told', reason: 'worker' }]);
      }
      h.finish(dev);
      await tick();
      expect(dev.turns).toEqual(['do it']);
      void pm;
    }
  });

  it('a steerable worker whose turn ends before the answer: not told, and the late answer changes nothing', async () => {
    const h = harness({ steered: true });
    await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    h.finish(dev);
    expect(reports).toEqual([{ kind: 'not-told', reason: 'worker' }]);
    dev.receipts[0].answer(true);
    await tick();
    expect(reports).toEqual([{ kind: 'not-told', reason: 'worker' }]);
    expect(dev.turns).toEqual(['do it']);
  });

  it('an idle agent is not continued for a request other than its last one, though that one is still open', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    h.dispatch('pm', correlationOf(h.log, 'plan'), 'w1');
    h.finish(pm, 'waiting for the worker');
    expect(h.tell('pm', 'an-earlier-request', 'Host scope update: Read access.')).toEqual([{ kind: 'not-told', reason: 'no-turn' }]);
    await tick();
    expect(pm.turns).toEqual(['plan']);
  });

  it('a steerable worker refused is not continued either', async () => {
    const h = harness({ steered: true });
    await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Host scope update: Read access.');
    dev.receipts[0].answer(false);
    await tick();
    expect(reports).toEqual([{ kind: 'not-told', reason: 'worker' }]);
    h.finish(dev);
    await tick();
    expect(dev.turns).toEqual(['do it']);
  });

  it('an idle agent whose last top-level turn is this open request continues it; once the request is over it does not', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlation, 'w1');
    h.finish(pm, 'waiting for the worker');
    const reports = h.tell('pm', request, 'Host scope update: Read access.');
    expect(reports).toEqual([{ kind: 'continues' }]);
    expect(pm.turns).toHaveLength(2);
    expect(pm.turns[1]).toContain('Read access.');
    h.finish(pm);
    await tick();

    const solo = harness();
    const dev = await solo.agent('dev');
    solo.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const over = solo.mgr.currentRequestId('dev')!;
    solo.finish(dev);
    expect(solo.tell('dev', over, 'Host scope update: Read access.')).toEqual([{ kind: 'not-told', reason: 'no-turn' }]);
    expect(dev.turns).toEqual(['work']);
  });
});

describe('each grant settles once (Codex receipts, in any order)', () => {
  async function steering() {
    const h = harness({ steered: true });
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const request = h.mgr.currentRequestId('dev')!;
    const a = h.tell('dev', request, 'Grant A');
    const b = h.tell('dev', request, 'Grant B');
    expect(dev.receipts.map((receipt) => receipt.text)).toEqual(['Grant A', 'Grant B']);
    return { h, dev, request, a, b };
  }

  it('A accepted does not take B with it, whichever receipt comes first', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const { h, dev, a, b } = await steering();
      for (const index of order) dev.receipts[index].answer(index === 0);
      await tick();
      expect(a).toEqual([{ kind: 'told' }]);
      expect(b).toEqual([{ kind: 'waiting' }]);
      h.finish(dev);
      expect(a).toEqual([{ kind: 'told' }]);
      expect(b).toEqual([{ kind: 'waiting' }, { kind: 'continues' }]);
      // The continuation carries only what the turn was not told, and there is one of it.
      expect(dev.turns).toHaveLength(2);
      expect(dev.turns[1]).toContain('Grant B');
      expect(dev.turns[1]).not.toContain('Grant A');
    }
  });

  it('both accepted: no continuation', async () => {
    const { h, dev, a, b } = await steering();
    dev.receipts.forEach((receipt) => receipt.answer(true));
    await tick();
    h.finish(dev);
    await tick();
    expect([a, b]).toEqual([[{ kind: 'told' }], [{ kind: 'told' }]]);
    expect(dev.turns).toEqual(['work']);
    expect(h.replies('dev')[0].payload.metadata).not.toHaveProperty('continuesInTurn');
  });

  it('B\'s receipt still out when the turn ends: one continuation, and the late receipts change nothing', async () => {
    for (const late of [true, false]) {
      const { h, dev, a, b } = await steering();
      dev.receipts[0].answer(true);
      await tick();
      h.finish(dev);
      expect(b).toEqual([{ kind: 'continues' }]);
      expect(dev.turns).toHaveLength(2);
      dev.receipts[1].answer(late);
      await tick();
      expect(a).toEqual([{ kind: 'told' }]);
      expect(b).toEqual([{ kind: 'continues' }]);
      h.finish(dev);
      await tick();
      expect(dev.turns).toHaveLength(2);
    }
  });

  it('a refusal is no turn error', async () => {
    const { h, dev } = await steering();
    const errors = vi.fn();
    h.mgr.on('session.error', errors);
    dev.receipts.forEach((receipt) => receipt.answer(false));
    await tick();
    expect(errors).not.toHaveBeenCalled();
    expect(h.mgr.get('dev')!.status).toBe('running');
  });

  it('a backend that rejects counts as refused', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    (dev as unknown as { steerNotice: () => Promise<boolean> }).steerNotice = () => Promise.reject(new Error('gone'));
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const reports = h.tell('dev', h.mgr.currentRequestId('dev')!, 'Grant');
    await tick();
    expect(reports).toEqual([{ kind: 'waiting' }]);
  });
});

describe('who a continuation belongs to', () => {
  it('coordinator: the last result is in, the reply does not end the run, and the continuation\'s reply ends it once, with its cost in the task', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlation, 'w1');
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', request, 'Host scope update: Read access.');

    h.finish(pm, 'first answer', { usage: usage(100, 10) });
    expect(h.run().status).toBe('open');
    expect(h.run().continuationPending?.reply).toMatchObject({ type: 'task.complete' });
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
    expect(h.mgr.currentRequestId('pm')).toBe(request);

    const firstTurn = h.replies('pm')[0].payload.metadata?.turnId;
    h.finish(pm, 'final report', { usage: usage(50, 5) });
    const closed = h.run();
    expect(closed).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(closed.continuationPending).toBeUndefined();
    expect(closed.closingTurnId).toBe(h.replies('pm')[1].payload.metadata?.turnId);
    expect(closed.closingTurnId).not.toBe(firstTurn);
    expect(h.ledger().snapshot().filter((row) => row.status === 'closed')).toHaveLength(1);
    // Scripted usage: both turns count in the one task, and the task was finalized once.
    const tasks = h.mgr.getRecentTaskTokens(5);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: request, totalTokens: 165 });
  });

  it('an agent that delegated nothing: same request, same task', async () => {
    const h = harness();
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    const request = h.mgr.currentRequestId('dev')!;
    h.tell('dev', request, 'Host scope update: Read access.');
    h.finish(dev, 'first', { usage: usage(100, 10) });
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
    h.finish(dev, 'second', { usage: usage(50, 5) });
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 165 })]);
    expect(h.ledger().snapshot()).toEqual([]);
  });

  it('a worker the continuation dispatches belongs to the original task, which closes once', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlation, 'w1');
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', request, 'Host scope update: Read access.');
    h.finish(pm, 'first', { usage: usage(100, 10) });

    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'more work' }, 'normal', 'w2');
    h.dispatch('pm', correlation, 'w2');
    expect(h.mgr.currentRequestId('dev')).toBe(request);
    h.finish(pm, 'waiting', { usage: usage(10, 1) });
    // The worker is out: this reply cannot end the run.
    expect(h.run()).toMatchObject({ status: 'open' });
    expect(h.run().continuationPending?.endedAt).toBeDefined();
    h.finish(dev, 'worker done', { usage: usage(20, 2) });
    await tick();
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 143 })]);
  });

  // Audit of 254ccc8b (A1). Usage figures are scripted input.
  describe('a coordinator between turns, its worker still out', () => {
    async function idle() {
      const h = harness();
      const pm = await h.agent('pm', 'project-manager');
      const dev = await h.agent('dev');
      h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
      const correlation = correlationOf(h.log, 'plan');
      const request = h.mgr.currentRequestId('pm')!;
      h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' }, 'normal', 'w1');
      h.dispatch('pm', correlation, 'w1');
      h.finish(pm, 'waiting', { usage: usage(100, 10) });
      expect(h.tell('pm', request, 'Host scope update: Read access.')).toEqual([{ kind: 'continues' }]);
      expect(pm.turns).toHaveLength(2);
      return { h, pm, dev, request, correlation };
    }

    it('the worker finishes first: the task waits for the continuation, and counts all three', async () => {
      const { h, pm, dev, request } = await idle();
      h.finish(dev, 'worker done', { usage: usage(20, 2) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
      h.finish(pm, 'read it', { usage: usage(50, 5) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
    });

    it('the continuation finishes first: the task waits for the worker, and counts all three', async () => {
      const { h, pm, dev, request } = await idle();
      h.finish(pm, 'read it', { usage: usage(50, 5) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
      h.finish(dev, 'worker done', { usage: usage(20, 2) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
    });

    it('the continuation dispatches again: that worker counts too, and the task ends once', async () => {
      const { h, pm, dev, request } = await idle();
      const reviewer = await h.agent('reviewer', 'reviewer');
      h.bus.send('pm', 'reviewer', 'task.assign', { instruction: 'check it' }, 'normal', 'w2');
      expect(h.mgr.currentRequestId('reviewer')).toBe(request);
      h.finish(pm, 'read it', { usage: usage(50, 5) });
      h.finish(dev, 'worker done', { usage: usage(20, 2) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
      h.finish(reviewer, 'checked', { usage: usage(10, 1) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 198 })]);
    });

    it('Stop before the continuation is sent gives its slot back', async () => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const h = harness({ onTurnComplete: () => hold });
      const pm = await h.agent('pm', 'project-manager');
      h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
      const correlation = correlationOf(h.log, 'plan');
      const request = h.mgr.currentRequestId('pm')!;
      h.dispatch('pm', correlation, 'w1');
      h.settle('w1');
      h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
      h.tell('pm', request, 'Grant');
      h.finish(pm, 'first', { usage: usage(100, 10) });
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([]);
      h.mgr.interrupt('pm');
      release();
      await tick();
      expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 110 })]);
    });
  });

  it('a task already settled, its result still due: the continuation keeps its request, and the finished record does not change', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' }, 'normal', 'w1');
    h.dispatch('pm', correlation, 'w1');
    h.finish(pm, 'waiting', { usage: usage(100, 10) });
    h.finish(dev, 'worker done', { usage: usage(20, 2) });
    const settled = h.mgr.getRecentTaskTokens(5);
    expect(settled).toEqual([expect.objectContaining({ id: request, totalTokens: 132 })]);
    // The run is still open: its worker's result has not reached the coordinator.
    expect(h.ledger().threadRunOpen('pm', correlation)).toBe(true);
    expect(h.tell('pm', request, 'Host scope update: Read access.')).toEqual([{ kind: 'continues' }]);
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    h.finish(pm, 'read it', { usage: usage(50, 5) });
    await tick();
    expect(h.mgr.getRecentTaskTokens(5)).toEqual(settled);
  });

  it('a second open task of the same coordinator is not touched', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'other job' });
    const otherCorrelation = correlationOf(h.log, 'other job');
    h.dispatch('pm', otherCorrelation, 'other');
    h.finish(pm, 'other out');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'this job' });
    const correlation = correlationOf(h.log, 'this job');
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlation, 'w1');
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', request, 'Host scope update: Read access.');
    h.finish(pm, 'first');
    const runs = () => Object.fromEntries(h.ledger().snapshot().map((row) => [row.delegations[0].handle, row]));
    expect(runs().other.continuationPending).toBeUndefined();
    expect(runs().w1.continuationPending).toBeDefined();
    h.finish(pm, 'second');
    expect(runs().w1.status).toBe('closed');
    expect(runs().other.status).toBe('open');
  });
});

describe('a result wake already waiting', () => {
  const queueWake = (mgr: SessionManager, handle: string, requestId: string) => {
    (mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest(handle, requestId);
    mgr.queueAsyncDelegationWake('pm', { handle, ref: 'dev', text: `result of ${handle}`, runId: `run-${handle}` } as never, () => true, () => true);
  };

  it('of the same request: the notice rides on it, no turn of its own, no review spent', async () => {
    const consume = vi.fn(async () => ({ consumed: [], saved: true }));
    const h = harness();
    (h.mgr as unknown as { deps: { consumeReviewContinuationDurably: unknown } }).deps.consumeReviewContinuationDurably = consume;
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    const reports = h.tell('pm', request, 'Host scope update: Read access.');
    queueWake(h.mgr, 'w1', request);
    h.finish(pm, 'first');
    expect(reports.at(-1)).toEqual({ kind: 'continues' });
    expect(h.replies('pm')[0].payload.metadata?.continuesInTurn).toBe(true);
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('result of w1');
    expect(pm.turns[1]).toContain('Host scope update: Read access.');
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    expect(consume).not.toHaveBeenCalled();
    h.finish(pm, 'second');
    await tick();
    expect(pm.turns).toHaveLength(2);
  });

  it('a wake gone right after the decision: the notice takes a turn of its own', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    h.tell('pm', request, 'Host scope update: Read access.');
    let ready = true;
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w1', request);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result', runId: 'run-w1' } as never, () => ready, () => true);
    await tick();
    h.finish(pm, 'first');
    expect(pm.turns).toHaveLength(1);
    ready = false;
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Host scope update: Read access.');
    expect(pm.turns[1]).not.toContain('result');
    expect(h.mgr.currentRequestId('pm')).toBe(request);
  });

  it('a claimed wake of another request does not cost the notice its turn', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const reports = h.tell('pm', h.mgr.currentRequestId('pm')!, 'Host scope update: Read access.');
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w1', 'another-request');
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result', runId: 'run-w1' } as never, () => false, () => true);
    h.finish(pm, 'first');
    expect(reports.at(-1)).toEqual({ kind: 'continues' });
    expect(pm.turns[1]).toContain('Read access');
  });

  it('of another request: the notice gives way', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const reports = h.tell('pm', h.mgr.currentRequestId('pm')!, 'Host scope update: Read access.');
    queueWake(h.mgr, 'w1', 'another-request');
    h.finish(pm, 'first');
    expect(reports.at(-1)).toEqual({ kind: 'not-told', reason: 'other-request' });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).not.toContain('Read access');
  });
});

describe('a wake that cannot be counted on', () => {
  /**
   * A coordinator in its turn, with one worker still out and another's result waiting for a wake of this request. The
   * grant comes during the turn. Usage: the coordinator's first turn 110, the worker 22, the turn that follows 55.
   */
  async function waiting(options: { hold?: Promise<void>; prepare?: () => Promise<void>; runless?: boolean } = {}) {
    const h = harness(options.hold ? { onTurnComplete: () => options.hold! } : {});
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' }, 'normal', 'w1');
    h.dispatch('pm', correlation, 'w1');
    h.dispatch('pm', correlation, 'w2', 'other');
    h.settle('w2', 'other');
    let ready = true;
    const collect = () => { ready = false; h.ledger().recordDeliveryDelivered('w2', 'blocking-tool'); };
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w2', request);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w2', ref: 'other', text: 'result of w2', ...(options.runless ? {} : { runId: h.run().id }) } as never,
      () => ready, () => { collect(); return true; }, options.prepare);
    await tick();
    const reports = h.tell('pm', request, 'Grant');
    const workerDone = () => {
      h.finish(dev, 'worker done', { usage: usage(20, 2) });
      h.settle('w1');
      h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    };
    return { h, pm, dev, correlation, request, reports, collect, workerDone };
  }
  const recorded = (h: ReturnType<typeof harness>) => h.mgr.getRecentTaskTokens(5);

  it('the wake is gone before the turn ends: the notice has its own turn, its slot and its mark, and the task counts all three', async () => {
    const { h, pm, request, reports, collect, workerDone } = await waiting();
    collect();
    h.finish(pm, 'first', { usage: usage(100, 10) });
    expect(reports.at(-1)).toEqual({ kind: 'continues' });
    expect(h.replies('pm')[0].payload.metadata?.continuesInTurn).toBe(true);
    expect(h.run().continuationPending).toMatchObject({ reply: { type: 'task.complete' } });
    expect(pm.turns).toHaveLength(2);
    expect(pm.turns[1]).not.toContain('result of w2');
    workerDone();
    expect(recorded(h)).toEqual([]);
    h.finish(pm, 'second', { usage: usage(50, 5) });
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
  });

  it('the wake goes after the decision and the worker finishes first: the task waits, and counts all three', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { h, pm, request, collect, workerDone } = await waiting({ hold });
    h.finish(pm, 'first', { usage: usage(100, 10) });
    expect(h.replies('pm')[0].payload.metadata?.continuesInTurn).toBe(true);
    collect();
    workerDone();
    expect(recorded(h)).toEqual([]);
    expect(h.run().status).toBe('open');
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Grant');
    expect(pm.turns[1]).not.toContain('result of w2');
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    h.finish(pm, 'second', { usage: usage(50, 5) });
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(h.run().continuationPending).toBeUndefined();
  });

  it('the wake goes after the decision and the turn finishes first: the task waits for the worker, and counts all three', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { h, pm, request, collect, workerDone } = await waiting({ hold });
    h.finish(pm, 'first', { usage: usage(100, 10) });
    collect();
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    h.finish(pm, 'second', { usage: usage(50, 5) });
    expect(recorded(h)).toEqual([]);
    expect(h.run().status).toBe('open');
    workerDone();
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
  });

  it('the wake carries the notice: one turn, in the task, and its reply ends the run', async () => {
    const { h, pm, request, workerDone } = await waiting();
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('result of w2');
    expect(pm.turns[1]).toContain('Grant');
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    workerDone();
    expect(recorded(h)).toEqual([]);
    expect(h.run().continuationPending?.endedAt).toBeUndefined();
    h.finish(pm, 'second', { usage: usage(50, 5) });
    await tick();
    expect(pm.turns).toHaveLength(2);
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 187 })]);
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(h.run().continuationPending).toBeUndefined();
  });

  it('a wake with no run of its own ends the mark too', async () => {
    const { h, pm, workerDone } = await waiting({ runless: true });
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('result of w2');
    expect(pm.turns[1]).toContain('Grant');
    workerDone();
    h.finish(pm, 'second', { usage: usage(50, 5) });
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    expect(h.run().status).toBe('closed');
  });

  it('a wake that arrives after the decision carries the notice too: one turn, not two', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ onTurnComplete: () => hold });
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    h.tell('pm', request, 'Grant');
    h.finish(pm, 'first', { usage: usage(100, 10) });
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w1', request);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result of w1', runId: 'run-w1' } as never, () => true, () => true);
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('result of w1');
    expect(pm.turns[1]).toContain('Grant');
    h.finish(pm, 'second', { usage: usage(50, 5) });
    await tick();
    expect(pm.turns).toHaveLength(2);
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 165 })]);
  });

  it('its own turn errors: the run ends as partial', async () => {
    const { h, pm, workerDone } = await waiting();
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    workerDone();
    h.finish(pm, 'failed', { isError: true });
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
  });

  it.each([
    ['Stop', (h: ReturnType<typeof harness>) => h.mgr.interrupt('pm')],
    ['Clear', (h: ReturnType<typeof harness>) => h.mgr.forgetFileAccessNotices('pm')],
  ] as const)('%s before the send: the slot goes back and the task does not wait for a turn that will not come', async (_name, withdraw) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { h, pm, request, collect, workerDone } = await waiting({ hold });
    h.finish(pm, 'first', { usage: usage(100, 10) });
    collect();
    withdraw(h);
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    workerDone();
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 132 })]);
    release();
    await tick();
    expect(pm.turns).toHaveLength(1);
    expect(h.ledger().hasOwedContinuations()).toBe(false);
  });

  it('a reload while the notice waits for its wake: the result is still owed, so the run stays open for it', async () => {
    const { h, pm } = await waiting();
    h.finish(pm, 'first', { usage: usage(100, 10) });
    const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
    restored.reconcileRestoredActiveDelegations();
    expect(restored.reconcileRestoredContinuations()).toBe(0);
    expect(restored.snapshot()[0].status).toBe('open');
    expect(restored.hasOwedContinuations()).toBe(false);
  });

  it('a reload during the turn of its own: read from the stored record alone, the run ends as partial', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { h, pm, collect, workerDone } = await waiting({ hold });
    h.finish(pm, 'first', { usage: usage(100, 10) });
    const firstTurn = h.replies('pm')[0].payload.metadata?.turnId;
    collect();
    workerDone();
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
    expect(restored.reconcileRestoredContinuations()).toBe(1);
    expect(restored.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: firstTurn });
  });

  it('the host refuses the wake: the slot goes back and the run does not wait for the notice', async () => {
    const { h, pm, request, workerDone } = await waiting();
    const manager = h.mgr as unknown as { deliverTurn(sessionId: string, message: Message): void };
    const deliverTurn = manager.deliverTurn;
    let refused = 0;
    manager.deliverTurn = function (this: unknown, sessionId: string, message: Message) {
      if (message.payload.metadata?.autoWake === 'async-delegation-result' && refused++ === 0) return;
      deliverTurn.call(this, sessionId, message);
    };
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await tick();
    expect(refused).toBe(1);
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    workerDone();
    expect(recorded(h)).toEqual([expect.objectContaining({ id: request, totalTokens: 132 })]);
    expect(pm.turns.join()).not.toContain('Grant');
  });

  it('the wake goes away while its result is being saved: the notice still gets its turn', async () => {
    let collect!: () => void;
    const { h, pm, reports, ...rest } = await waiting({ prepare: async () => { collect(); } });
    collect = rest.collect;
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Grant');
    expect(pm.turns[1]).not.toContain('result of w2');
    expect(reports.at(-1)).toEqual({ kind: 'continues' });
  });

  it('the wake goes away while its review is being saved: the notice still gets its turn', async () => {
    const { h, pm, collect } = await waiting();
    const manager = h.mgr as unknown as { pendingReviewContinuations: Map<string, unknown[]>;
      consumeReviewDurably(info: unknown, refs: unknown[]): Promise<unknown[]>; deps: { consumeReviewContinuationDurably: unknown } };
    manager.pendingReviewContinuations.set('pm', [{ handle: 'w2', revision: 1 }]);
    manager.deps.consumeReviewContinuationDurably = async () => ({ consumed: [], saved: true });
    manager.consumeReviewDurably = async (_info, refs) => { collect(); return refs; };
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Grant');
    expect(pm.turns[1]).not.toContain('result of w2');
  });

  it('a wake that lost its race with nothing owed waits for the next idle transition, as before', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    let ready = true;
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w1', request);
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w2', request);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result of w1', runId: 'run' } as never, () => ready, () => true, async () => { ready = false; });
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w2', ref: 'dev', text: 'result of w2', runId: 'run' } as never, () => true, () => true);
    await tick();
    h.finish(pm, 'first');
    await tick();
    await tick();
    expect(pm.turns).toHaveLength(1);
    expect(h.mgr.pendingAsyncDelegationWakeCount('pm')).toBe(2);
  });
});

describe('two runs of one request', () => {
  /**
   * The real send_message gives the coordinator a turn in a new thread of the same request, and what it dispatches there
   * is a run of its own. So: run A, its worker back and its wake running; run B, whose result waits for a wake; and run C,
   * of another thread altogether. The grant comes during A's wake.
   */
  async function twoRuns(options: { extraResultInA?: boolean } = {}) {
    const gate: { current: Promise<void> } = { current: Promise.resolve() };
    const h = harness({ onTurnComplete: () => gate.current });
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    const reviewer = await h.agent('reviewer', 'reviewer');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    const thread = () => h.mgr.currentTurnCorrelationId('pm');
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' }, 'normal', 'w1');
    const runA = h.dispatch('pm', correlationOf(h.log, 'plan'), 'w1') as unknown as string;
    const runC = h.dispatch('pm', 'another-thread', 'x1', 'other') as unknown as string;
    const tools = new WorkspaceTools(process.cwd(), new Set(['message']), 'dev', undefined, undefined, undefined, undefined, h.bus as never);
    expect(await tools.runText('send_message', { target: 'pm', message: 'Coordinate this.' })).toMatch(/Message sent/);
    h.finish(pm, 'first', { usage: usage(100, 10) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    h.bus.send('pm', 'reviewer', 'task.assign', { instruction: 'review it' }, 'normal', 'r1');
    const runB = h.dispatch('pm', thread()!, 'r1', 'reviewer') as unknown as string;
    expect(runB).not.toBe(runA);
    h.finish(pm, 'answered', { usage: usage(1, 1) });
    await tick();
    h.finish(dev, 'worker done', { usage: usage(20, 2) });
    await tick();
    h.settle('w1');
    const wake = (handle: string, agent: string, text: string, runId: string) => {
      let ready = true;
      (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest(handle, request);
      h.mgr.queueAsyncDelegationWake('pm', { handle, ref: agent, text, runId } as never, () => ready,
        () => { ready = false; h.ledger().recordDeliveryDelivered(handle, 'blocking-tool'); return true; });
    };
    wake('w1', 'dev', 'result of w1', runA);
    await vi.waitFor(() => expect(thread()).toBe(runA));
    const reports = h.tell('pm', request, 'Grant');
    h.finish(reviewer, 'reviewed', { usage: usage(3, 1) });
    await tick();
    h.settle('r1', 'reviewer');
    wake('r1', 'reviewer', 'result of r1', runB);
    if (options.extraResultInA) {
      h.dispatch('pm', runA, 'w2');
      h.settle('w2');
      wake('w2', 'dev', 'result of w2', runA);
    }
    await tick();
    const runOf = (id: string) => h.ledger().snapshot().find((row) => row.id === id)!;
    const owes = (id: string) => { const mark = runOf(id).continuationPending; return !!mark && !mark.endedAt; };
    return { h, pm, gate, request, thread, reports, runA, runB, runC, runOf, owes };
  }

  it('the notice takes its own turn in its own run, and the other run\'s wake comes after it without it', async () => {
    const { h, pm, request, thread, reports, runA, runB, runC, runOf, owes } = await twoRuns();
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    expect(reports.at(-1)).toEqual({ kind: 'continues' });
    expect(owes(runA)).toBe(true);
    expect(thread()).toBe(runA);
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    expect(pm.turns.at(-1)).toContain('Grant');
    expect(pm.turns.at(-1)).not.toContain('result of r1');
    const told = h.mgr.currentTurnCorrelationId('pm');
    h.finish(pm, 'told', { usage: usage(7, 1) });
    expect(told).toBe(runA);
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf(runA).continuationPending).toBeUndefined();
    expect(runOf(runB).status).toBe('open');
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 2));
    expect(thread()).toBe(runB);
    expect(pm.turns.at(-1)).toContain('result of r1');
    expect(pm.turns.at(-1)).not.toContain('Grant');
    h.finish(pm, 'read r1', { usage: usage(9, 1) });
    await tick();
    expect(runOf(runB)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf(runC).status).toBe('open');
    expect(runOf(runC).continuationPending).toBeUndefined();
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    expect(h.mgr.requestRunning(request)).toBe(false);
    // The first turn, the message's, the worker's and the reviewer's. The reviewer was the last of the task, before the
    // turn the decision ended: a task already settled takes no slot, and what follows counts in the request's spend.
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 110 + 2 + 22 + 4 })]);
  });

  it('a wake of the other run goes first without it, and a wake of the notice\'s own run carries it', async () => {
    const { h, pm, thread, runA, runB, runOf, owes } = await twoRuns({ extraResultInA: true });
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    expect(thread()).toBe(runB);
    expect(pm.turns.at(-1)).toContain('result of r1');
    expect(pm.turns.at(-1)).not.toContain('Grant');
    h.finish(pm, 'read r1', { usage: usage(9, 1) });
    expect(runOf(runB).status).toBe('closed');
    expect(owes(runA)).toBe(true);
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 2));
    expect(thread()).toBe(runA);
    expect(pm.turns.at(-1)).toContain('result of w2');
    expect(pm.turns.at(-1)).toContain('Grant');
    h.finish(pm, 'read w2', { usage: usage(7, 1) });
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf(runA).continuationPending).toBeUndefined();
    await tick();
    expect(pm.turns).toHaveLength(before + 2);
  });

  it('its own turn errors: its run ends as partial, and the other run goes on', async () => {
    const { h, pm, runA, runB, runC, runOf } = await twoRuns();
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    h.finish(pm, 'failed', { isError: true });
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 2));
    expect(pm.turns.at(-1)).toContain('result of r1');
    h.finish(pm, 'read r1');
    await tick();
    expect(runOf(runB)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf(runC).status).toBe('open');
  });

  it('its own turn is stopped: its run ends as partial, and no other run is closed by it', async () => {
    const { h, pm, runA, runB, runC, runOf } = await twoRuns();
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    h.mgr.interrupt('pm');
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    expect(runOf(runB).status).toBe('open');
    expect(runOf(runC).status).toBe('open');
    expect(h.ledger().hasOwedContinuations()).toBe(false);
  });

  it('Stop before the send: the reply before it ends its run, and the other run is not closed by it', async () => {
    const { h, pm, gate, runA, runB, runC, runOf } = await twoRuns();
    let release!: () => void;
    gate.current = new Promise<void>((resolve) => { release = resolve; });
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    h.mgr.interrupt('pm');
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    gate.current = Promise.resolve();
    release();
    await tick();
    expect(pm.turns.slice(before).join()).not.toContain('Grant');
    expect(runOf(runB).status).toBe('open');
    expect(runOf(runC).status).toBe('open');
    expect(h.ledger().hasOwedContinuations()).toBe(false);
  });

  it('Clear before the send: the reply before it ends its run, and the other run\'s wake still runs without the notice', async () => {
    const { h, pm, gate, runA, runB, runC, runOf } = await twoRuns();
    let release!: () => void;
    gate.current = new Promise<void>((resolve) => { release = resolve; });
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    expect(pm.turns).toHaveLength(before);
    h.mgr.forgetFileAccessNotices('pm');
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf(runB).status).toBe('open');
    gate.current = Promise.resolve();
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    expect(pm.turns.at(-1)).toContain('result of r1');
    expect(pm.turns.at(-1)).not.toContain('Grant');
    h.finish(pm, 'read r1');
    await tick();
    expect(runOf(runB).status).toBe('closed');
    expect(runOf(runC).status).toBe('open');
    expect(h.ledger().hasOwedContinuations()).toBe(false);
  });

  it('a reload during its own turn: its run ends as partial, the other run still has its result to come', async () => {
    const { h, pm, runA, runB, runC } = await twoRuns();
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
    restored.reconcileRestoredActiveDelegations();
    expect(restored.reconcileRestoredContinuations()).toBe(1);
    const runOf = (id: string) => restored.snapshot().find((row) => row.id === id)!;
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    expect(runOf(runB).status).toBe('open');
    expect(runOf(runC).status).toBe('open');
    expect(restored.hasOwedContinuations()).toBe(false);
  });

  it('a ledger that cannot answer costs one more turn, not a mark left owing', async () => {
    const { h, pm, thread, runA } = await twoRuns({ extraResultInA: true });
    (h.mgr as unknown as { deps: { replyEndsContinuation: () => boolean } }).deps.replyEndsContinuation = () => { throw new Error('gone'); };
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    expect(thread()).toBe(runA);
    expect(pm.turns.at(-1)).toContain('Grant');
    expect(pm.turns.at(-1)).not.toContain('result of');
  });

  it('a grant in the other run\'s turn joins the turn owed: one turn, one mark, and each run ends by its own reply', async () => {
    const { h, pm, request, thread, runA, runB, runOf, owes } = await twoRuns({ extraResultInA: true });
    const before = pm.turns.length;
    h.finish(pm, 'read w1', { usage: usage(5, 1) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 1));
    expect(thread()).toBe(runB);
    const second = h.tell('pm', request, 'Second grant');
    h.finish(pm, 'read r1', { usage: usage(9, 1) });
    expect(second.at(-1)).toEqual({ kind: 'continues' });
    expect(h.replies('pm').at(-1)!.payload.metadata).not.toHaveProperty('continuesInTurn');
    expect(runOf(runB)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(owes(runA)).toBe(true);
    await vi.waitFor(() => expect(pm.turns).toHaveLength(before + 2));
    expect(thread()).toBe(runA);
    expect(pm.turns.at(-1)).toContain('result of w2');
    expect(pm.turns.at(-1)).toContain('Grant');
    expect(pm.turns.at(-1)).toContain('Second grant');
    h.finish(pm, 'read w2', { usage: usage(7, 1) });
    expect(runOf(runA)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    await tick();
    expect(pm.turns).toHaveLength(before + 2);
    expect(h.mgr.requestRunning(request)).toBe(false);
  });

  it('the ledger looks only at this coordinator\'s runs that owe this thread a turn', () => {
    const ledger = new RunLedger();
    const open = (coordinatorId: string, handle: string, thread: string) => ledger.recordDelegationDispatched({ coordinatorId, handle, agentId: 'dev',
      requestedAgent: 'dev', instruction: 'x', attemptId: `attempt-${handle}`, originCorrelationId: thread });
    open('pm', 'a', 'thread-a');
    open('pm', 'b', 'thread-b');
    open('other', 'c', 'thread-c');
    expect(ledger.replyEndsContinuation('pm', 'thread-a', 'thread-b')).toBe(true);
    ledger.beginContinuation('pm', 'thread-a');
    expect(ledger.replyEndsContinuation('pm', 'thread-a', 'thread-b')).toBe(false);
    expect(ledger.replyEndsContinuation('pm', 'thread-a', 'thread-a')).toBe(true);
    expect(ledger.replyEndsContinuation('pm', 'thread-b', 'thread-a')).toBe(true);
    expect(ledger.replyEndsContinuation('other', 'thread-a', 'thread-b')).toBe(true);
    ledger.abandonContinuation('pm', 'thread-a');
    expect(ledger.replyEndsContinuation('pm', 'thread-a', 'thread-b')).toBe(true);
  });
});

describe('one turn owed at a time', () => {
  /**
   * The first request owes a turn, and the result wake that would carry it has not run. A new request gets in first,
   * behind the post-turn work or while the result is being saved, and takes the old result with the real tool. The wake
   * can no longer carry the notice, and the new request is granted access too.
   */
  async function overtaken(boundary: 'post-turn' | 'prepare') {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let gate = Promise.resolve();
    const h = harness({ onTurnComplete: () => gate });
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'first' });
    const first = h.mgr.currentRequestId('pm')!;
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'work' }, 'normal', 'w1');
    const run = h.dispatch('pm', correlationOf(h.log, 'first'), 'w1') as unknown as string;
    h.finish(dev, 'worker done', { usage: usage(20, 2) });
    await tick();
    h.settle('w1');
    const ledger = h.ledger();
    ledger.recordResultSettlement(ledger.resultIdentity('pm', 'w1')!, 'ready');
    const team = new TeamTools('pm', { list: () => [], resolve: () => undefined } as never, h.bus as never, {
      recoveredAsyncResults: [{ handle: 'w1', ref: 'dev', text: 'RESULT' }],
      onAsyncResultDelivered: (handle: string, via: 'blocking-tool') => ledger.recordDeliveryDelivered(handle, via),
    } as never);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'RESULT', runId: run } as never,
      () => team.isAsyncResultReady('w1'), () => team.consumeAsyncResult('w1'), boundary === 'prepare' ? () => hold : undefined);
    await tick();
    const firstGrant = h.tell('pm', first, 'Grant one');
    if (boundary === 'post-turn') gate = hold;
    h.finish(pm, 'first reply', { usage: usage(100, 10) });
    await tick();
    expect(firstGrant.at(-1)).toEqual({ kind: 'continues' });
    expect(pm.turns).toHaveLength(1);
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'second' });
    release();
    await vi.waitFor(() => expect(pm.turns.at(-1)).toBe('second'));
    const second = h.mgr.currentRequestId('pm')!;
    expect(second).not.toBe(first);
    expect(await team.run('collect_ready_tasks', { handles: ['w1'] })).toContain('RESULT');
    const secondGrant = h.tell('pm', second, 'Grant two');
    const runOf = () => h.ledger().snapshot().find((row) => row.id === run)!;
    return { h, pm, first, second, secondGrant, run, runOf, thread: correlationOf(h.log, 'first') };
  }

  it.each(['post-turn', 'prepare'] as const)('a new request overtakes it (%s): the new grant gives way, and the turn owed still runs and settles', async (boundary) => {
    const { h, pm, first, second, secondGrant, runOf, thread } = await overtaken(boundary);
    h.finish(pm, 'second reply', { usage: usage(20, 2) });
    await vi.waitFor(() => expect(pm.turns).toHaveLength(3));
    expect(secondGrant).toEqual([{ kind: 'waiting' }, { kind: 'not-told', reason: 'other-request' }]);
    expect(h.replies('pm').at(-1)!.payload.metadata).not.toHaveProperty('continuesInTurn');
    expect(pm.turns[2]).toContain('Grant one');
    expect(pm.turns[2]).not.toContain('Grant two');
    expect(h.mgr.currentRequestId('pm')).toBe(first);
    expect(h.mgr.currentTurnCorrelationId('pm')).toBe(thread);
    expect(runOf().status).toBe('open');
    h.finish(pm, 'told', { usage: usage(50, 5) });
    await tick();
    expect(pm.turns).toHaveLength(3);
    expect(runOf()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(runOf().continuationPending).toBeUndefined();
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    expect(h.mgr.requestRunning(first)).toBe(false);
    expect(h.mgr.requestRunning(second)).toBe(false);
    const tasks = h.mgr.getRecentTaskTokens(5);
    expect(tasks.find((task) => task.id === first)?.totalTokens).toBe(110 + 22 + 55);
    expect(tasks.find((task) => task.id === second)?.totalTokens).toBe(22);
  });

  it('Clear during the new request withdraws the turn owed: its slot goes back and its run ends by the reply before', async () => {
    const { h, pm, first, secondGrant, runOf } = await overtaken('post-turn');
    h.mgr.forgetFileAccessNotices('pm');
    expect(secondGrant.at(-1)).toEqual({ kind: 'not-told', reason: 'stopped' });
    h.finish(pm, 'second reply', { usage: usage(20, 2) });
    await tick();
    expect(pm.turns).toHaveLength(2);
    expect(runOf()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(h.ledger().hasOwedContinuations()).toBe(false);
    expect(h.mgr.getRecentTaskTokens(5).find((task) => task.id === first)?.totalTokens).toBe(110 + 22);
  });

  // No path starts this turn today, because a wake of the run carries the notice itself. A scripted host turn holds the
  // rule: a reply that reaches the mark must not end it before the turn owed.
  it('a grant in a turn of the same thread joins the turn owed, and that turn\'s reply leaves the mark to it', async () => {
    let release!: () => void;
    let gate = Promise.resolve();
    const h = harness({ onTurnComplete: () => gate });
    const pm = await h.agent('pm', 'project-manager');
    const dev = await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    const thread = correlationOf(h.log, 'plan');
    h.bus.send('pm', 'dev', 'task.assign', { instruction: 'do it' }, 'normal', 'w1');
    const run = h.dispatch('pm', thread, 'w1') as unknown as string;
    h.finish(dev, 'worker done');
    await tick();
    h.settle('w1');
    let ready = true;
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result of w1', runId: run } as never, () => ready,
      () => { ready = false; h.ledger().recordDeliveryDelivered('w1', 'blocking-tool'); return true; });
    await tick();
    h.tell('pm', request, 'Grant one');
    gate = new Promise<void>((resolve) => { release = resolve; });
    h.finish(pm, 'first reply');
    await tick();
    (h.mgr as unknown as { pendingWakeRequest: Map<string, string> }).pendingWakeRequest.set('pm', request);
    h.bus.send('unode', 'pm', 'ask.question', { instruction: 'a host turn' }, 'normal', thread);
    release();
    await vi.waitFor(() => expect(pm.turns.at(-1)).toBe('a host turn'));
    expect(h.mgr.currentRequestId('pm')).toBe(request);
    const second = h.tell('pm', request, 'Grant two');
    h.finish(pm, 'answered');
    expect(second.at(-1)).toEqual({ kind: 'continues' });
    expect(h.replies('pm').at(-1)!.payload.metadata).toMatchObject({ continuesInTurn: true });
    const mark = () => h.ledger().snapshot().find((row) => row.id === run)!.continuationPending;
    expect(mark()).toBeDefined();
    expect(mark()!.endedAt).toBeUndefined();
    await vi.waitFor(() => expect(pm.turns.at(-1)).toContain('result of w1'));
    expect(pm.turns.at(-1)).toContain('Grant one');
    expect(pm.turns.at(-1)).toContain('Grant two');
  });

  it('nothing replaces the turn owed: another continuation takes neither its place nor a mark', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ onTurnComplete: () => gate });
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlationOf(h.log, 'plan'), 'w1');
    const other = h.dispatch('pm', 'other-thread', 'x1') as unknown as string;
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', request, 'Grant A');
    h.finish(pm, 'first', { usage: usage(100, 10) });
    (h.mgr as unknown as { oweGrantContinuation(sessionId: string, requestId: string, correlationId: string, texts: string[]): void })
      .oweGrantContinuation('pm', 'another-request', 'other-thread', ['Grant B']);
    expect(h.ledger().snapshot().find((row) => row.id === other)!.continuationPending).toBeUndefined();
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Grant A');
    expect(pm.turns[1]).not.toContain('Grant B');
    expect(h.mgr.currentRequestId('pm')).toBe(request);
  });
});

describe('between the decision and the send', () => {
  async function decided() {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ onTurnComplete: () => hold });
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    const request = h.mgr.currentRequestId('pm')!;
    h.dispatch('pm', correlation, 'w1');
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', request, 'Grant A');
    h.finish(pm, 'first', { usage: usage(100, 10) });
    expect(pm.turns).toHaveLength(1);
    return { h, pm, request, release };
  }

  it('a grant of the same request joins it; another request\'s is not told', async () => {
    const { h, pm, request, release } = await decided();
    expect(h.tell('pm', request, 'Grant B')).toEqual([{ kind: 'continues' }]);
    expect(h.tell('pm', 'another-request', 'Grant C')).toEqual([{ kind: 'not-told', reason: 'other-request' }]);
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('Grant A');
    expect(pm.turns[1]).toContain('Grant B');
    expect(pm.turns[1]).not.toContain('Grant C');
  });

  it('Stop: no turn follows, the slot goes back, and the reply before it ends the run', async () => {
    const { h, pm, request, release } = await decided();
    h.mgr.interrupt('pm');
    release();
    await tick();
    expect(pm.turns).toHaveLength(1);
    expect(h.mgr.requestRunning(request)).toBe(false);
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    expect(h.run().continuationPending).toBeUndefined();
    expect(h.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: request, totalTokens: 110 })]);
  });

  it('the spend reminder\'s Stop this request does the same', async () => {
    const { h, pm, request, release } = await decided();
    h.mgr.stopRequest(request);
    release();
    await tick();
    expect(pm.turns).toHaveLength(1);
    expect(h.mgr.requestRunning(request)).toBe(false);
    expect(h.run().status).toBe('closed');
  });

  it('the agent removed: no turn follows and the run does not wait', async () => {
    const { h, pm, release } = await decided();
    await h.mgr.remove('pm');
    release();
    await tick();
    expect(pm.turns).toHaveLength(1);
    expect(h.run().status).toBe('closed');
  });

  it('Stop this request reaches a notice waiting to ride on a wake, which has no live turn to stop', async () => {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const request = h.mgr.currentRequestId('pm')!;
    h.tell('pm', request, 'Host scope update: Read access.');
    (h.mgr as unknown as { rememberCorrelationRequest(handle: string, requestId: string): void }).rememberCorrelationRequest('w1', request);
    h.mgr.queueAsyncDelegationWake('pm', { handle: 'w1', ref: 'dev', text: 'result of w1', runId: 'run-w1' } as never, () => true, () => true);
    h.finish(pm, 'first');
    h.mgr.stopRequest(request);
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    expect(pm.turns[1]).toContain('result of w1');
    expect(pm.turns[1]).not.toContain('Host scope update');
  });

  it('holds its request, so reachability and restore points see it, and releases it when it ends', async () => {
    const { h, pm, request, release } = await decided();
    expect(h.mgr.requestRunning(request)).toBe(true);
    expect(h.mgr.reachableRequestIds().has(request)).toBe(true);
    release();
    await vi.waitFor(() => expect(pm.turns).toHaveLength(2));
    h.finish(pm, 'second');
    await tick();
    expect(h.mgr.requestRunning(request)).toBe(false);
  });
});

describe('a continuation that cannot finish', () => {
  async function continuing() {
    const h = harness();
    const pm = await h.agent('pm', 'project-manager');
    await h.agent('dev');
    h.bus.send('user', 'pm', 'ask.question', { instruction: 'plan' });
    const correlation = correlationOf(h.log, 'plan');
    h.dispatch('pm', correlation, 'w1');
    h.settle('w1');
    h.ledger().recordDeliveryDelivered('w1', 'blocking-tool');
    h.tell('pm', h.mgr.currentRequestId('pm')!, 'Grant A');
    h.finish(pm, 'first');
    expect(pm.turns).toHaveLength(2);
    return { h, pm, correlation };
  }

  it('its own turn errors: the run ends as partial, under the reply before it', async () => {
    const { h, pm } = await continuing();
    const firstTurn = h.replies('pm')[0].payload.metadata?.turnId;
    h.finish(pm, 'failed', { isError: true });
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: firstTurn });
  });

  it('it is stopped: the run ends as partial', async () => {
    const { h } = await continuing();
    h.mgr.interrupt('pm');
    expect(h.run()).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
  });

  it('a reload after the decision: read from the stored record alone, the run ends as partial, once', async () => {
    const { h } = await continuing();
    const stored = JSON.parse(JSON.stringify(h.ledger().snapshot()));
    // No clean-up ran. This is all a crash leaves.
    const restored = new RunLedger(stored);
    expect(restored.snapshot()[0].continuationPending?.reply?.type).toBe('task.complete');
    expect(restored.reconcileRestoredContinuations()).toBe(1);
    expect(restored.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    expect(restored.snapshot()[0].continuationPending).toBeUndefined();
    const again = new RunLedger(JSON.parse(JSON.stringify(restored.snapshot())));
    expect(again.reconcileRestoredContinuations()).toBe(0);
    expect(again.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
  });

  it('a reload with a worker the continuation dispatched: the worker is interrupted and the task waits for its coordinator', async () => {
    const { h, correlation } = await continuing();
    h.dispatch('pm', correlation, 'w2');
    const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
    restored.reconcileRestoredActiveDelegations();
    expect(restored.reconcileRestoredContinuations()).toBe(0);
    const run = restored.snapshot()[0];
    expect(run.status).toBe('open');
    expect(run.continuationPending?.endedAt).toBeDefined();
    expect(run.delegations.find((row) => row.handle === 'w2')?.state).toBe('interrupted');
  });

  it('a damaged stored mark is dropped', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'w1', agentId: 'dev', requestedAgent: 'dev', instruction: 'x', attemptId: 'a', originCorrelationId: 'c' });
    const stored = JSON.parse(JSON.stringify(ledger.snapshot()));
    stored[0].continuationPending = { at: 42 };
    expect(new RunLedger(stored).snapshot()[0].continuationPending).toBeUndefined();
  });
});

describe('Stop tells the host whether a turn was running', () => {
  it('a running turn, and then an idle agent', async () => {
    const h = harness();
    const stopped: Array<boolean | undefined> = [];
    h.mgr.on('session.stopped', (event) => stopped.push(event.data.turnStopped));
    const dev = await h.agent('dev');
    h.bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
    h.mgr.interrupt('dev');
    expect(stopped).toEqual([true]);
    const other = await h.agent('idle');
    await h.mgr.stop('idle');
    expect(stopped).toEqual([true, false]);
    void dev; void other;
  });
});

describe('the host wiring', () => {
  it('the ledger hears of a continuation and reconciles it at startup, after the interrupted rows', async () => {
    const source = await fsp.readFile('src/extension.ts', 'utf8');
    expect(source).toContain('runLedger.beginContinuation(coordinatorId, correlationId);');
    expect(source).toContain('runLedger.abandonContinuation(coordinatorId, correlationId);');
    expect(source).toContain('threadRunOpen: (coordinatorId, correlationId) => runLedger.threadRunOpen(coordinatorId, correlationId),');
    expect(source).toContain('replyEndsContinuation: (coordinatorId, correlationId, replyCorrelationId) => runLedger.replyEndsContinuation(coordinatorId, correlationId, replyCorrelationId),');
    const interrupted = source.indexOf('runLedger.reconcileRestoredActiveDelegations(');
    const continuations = source.indexOf('runLedger.reconcileRestoredContinuations(runOwnershipActivatedAt);');
    expect(interrupted).toBeGreaterThan(0);
    expect(continuations).toBeGreaterThan(interrupted);
    expect(source).toContain("resultDeliveryHost.scope(event.sessionId, 'coordinator-stopped', event.data.turnStopped === true)");
  });
});

describe('what the person reads', () => {
  it('the current state promises no outcome, and each ending says what happened', () => {
    const waiting = grantNoticeLine({ kind: 'waiting' }, 'request')!;
    expect(waiting).toContain('has not been told yet');
    expect(waiting).toContain('will check whether');
    expect(grantNoticeLine({ kind: 'told' }, 'request')).toContain('The next matching file call can use it.');
    expect(grantNoticeLine({ kind: 'continues' }, 'request')).toContain('continue this request');
    expect(grantNoticeLine({ kind: 'not-told', reason: 'worker' }, 'request')).toContain('Its coordinator can use the access');
    expect(grantNoticeLine({ kind: 'not-told', reason: 'stopped' }, 'request')).toBeUndefined();
  });

  it('not told: it says what the lifetime means for sending the request again', () => {
    for (const reason of ['other-request', 'turn-failed', 'queued-message', 'held', 'no-turn'] as const) {
      expect(grantNoticeLine({ kind: 'not-told', reason }, 'request')).toContain('only while the original request runs');
      expect(grantNoticeLine({ kind: 'not-told', reason }, 'session')).toContain('stays for this session');
    }
  });
});
