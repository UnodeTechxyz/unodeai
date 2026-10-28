import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionManagerDeps } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import { createTurnContextManifest } from '../TurnContextManifest';

// v0.9.99 P5 and P4, through the real run ledger: a result the PM received and left without a decision gets one
// automatic review turn, consumed at admission; the PM status under each reply says so from typed state.
const AS_OF = new Date('2026-10-27T08:00:00.000Z');

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  contexts: Array<TurnAttachments | undefined> = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void { this.turns.push(instruction); this.contexts.push(attachments); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

const config = (id: string, role: AgentConfig['role']): AgentConfig => ({
  id, name: id === 'pm' ? 'PM' : 'Dev', role, skill: '',
  provider: { providerId: 'openai', apiKeySecretName: 'K' } as AgentConfig['provider'],
  model: 'm', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'openai-compat',
});

const evidence = { outcome: 'tool-activity-recorded' as const, changedFiles: [], hadToolActions: true,
  verification: { ran: false, passed: false }, unrecordedWrites: false };

/** One delegated result, settled and delivered to the PM at `deliveredAt`, among older finished noise. */
function ledgerWithDeliveredResult(deliveredAt: string, handle = 'h-result-0001'): RunLedger {
  const ledger = new RunLedger();
  for (let i = 0; i < 30; i++) {
    const noise = `h-noise-${i}`;
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: noise, requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Old work.', dispatchedAt: '2026-10-27T06:00:00.000Z' });
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: noise, agentId: 'dev', reason: 'Not needed.', cancelledAt: '2026-10-27T06:30:00.000Z' });
  }
  ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev',
    instruction: 'Review the contract.', dispatchedAt: '2026-10-27T07:00:00.000Z' });
  ledger.recordDelegationEvidence({ handle, agentId: 'dev', outcome: 'tool-activity-recorded', evidence });
  ledger.recordResultSettlement(ledger.resultIdentity('pm', handle)!, 'ready');
  ledger.recordDeliveryDelivered(handle, 'auto-wake', deliveredAt);
  return ledger;
}

describe('the one automatic review turn for a result without a decision', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let backends: Map<string, FakeBackend>;
  let ledger: RunLedger;
  let held: boolean;
  // What a reload restores, the save of the consumed mark in flight, and whether that save fails.
  let disk: unknown;
  let saveGate: Promise<void> | undefined;
  let saveFails: boolean;
  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  async function startTeam(deps: Partial<SessionManagerDeps> = {}): Promise<void> {
    bus = new MessageBus();
    backends = new Map();
    manager = new SessionManager(5, bus, {
      createBackend: (agent) => { const backend = new FakeBackend(agent); backends.set(agent.id, backend); return backend; },
      resolveEnv: async () => ({}),
      getTurnContextBundle: () => ({ projectContext: '', contextManifest: createTurnContextManifest([]) }),
      coordinatorTaskStatus: (id, keep) => ledger.inspectTaskStatusWhere(id, keep),
      coordinatorDispatchOutcomes: (id, from, to, correlationId) => ledger.dispatchOutcomesBetween(id, from, to, correlationId),
      coordinatorHeld: () => held,
      recordReviewContinuation: (id, ref, state) => ledger.recordReviewContinuation(id, ref, state),
      // As the extension wires it: mark consumed, then wait for the run snapshot to be saved.
      consumeReviewContinuationDurably: async (id, refs) => {
        const consumed = refs.filter((ref) => ledger.recordReviewContinuation(id, ref, 'consumed'));
        if (!consumed.length) return { consumed, saved: true };
        if (saveFails) return { consumed, saved: false };
        const snapshot = JSON.parse(JSON.stringify(ledger.snapshot()));
        await (saveGate ?? Promise.resolve());
        disk = snapshot;
        return { consumed, saved: true };
      },
      releaseReviewContinuation: (id, ref) => { ledger.releaseReviewContinuation(id, ref); },
      ...deps,
    });
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']] as const) {
      manager.create(config(id, role as AgentConfig['role']));
      await manager.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
    await settle();
  }

  const pm = () => backends.get('pm')!;
  const finishPmTurn = async (text = 'Looked at it.') => {
    pm().emit({ kind: 'turn_complete', result: { text, isError: false, responseOutcome: { kind: 'reply' } } } as BackendEvent);
    await settle();
  };
  const lastPmReply = (): Message => bus.query({ from: 'pm' }).filter((m) => ['task.complete', 'task.partial', 'system.error'].includes(m.type)).at(-1)!;
  const pmStatus = () => (lastPmReply().payload.metadata as { pmStatus?: { row: number; state: string; next?: string } }).pmStatus;
  const continuation = () => ledger.inspectTaskStatusWhere('pm', () => true).find((t) => t.handle === 'h-result-0001')?.result?.reviewContinuation;
  const reviewTurns = () => bus.query({ from: 'unode', to: 'pm' })
    .filter((m) => (m.payload.metadata as { autoWake?: string } | undefined)?.autoWake === 'result-review');

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AS_OF); held = false; disk = undefined; saveGate = undefined; saveFails = false; });
  afterEach(() => { manager?.dispose(); vi.useRealTimers(); });

  it('schedules it at the close, runs it once, marks it consumed at admission, and never runs it again', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();

    // The reply that left the result undecided says the one turn is coming.
    expect(pmStatus()).toMatchObject({ row: 7, state: 'Awaiting PM review' });
    expect(pmStatus()?.next).toBe('The PM gets one automatic turn to review dev (h-result) rev 1.');
    // The turn started at once, with the ladder and the handle, and was consumed before any model output.
    expect(reviewTurns()).toHaveLength(1);
    expect(pm().turns.at(-1)).toContain('Delegated results still have no recorded decision: dev (h-result) rev 1.');
    expect(pm().turns.at(-1)).toContain('3. Record the decision with record_task_disposition.');
    expect(continuation()).toBe('consumed');

    // The automatic turn also ends without a decision: the status says so, and nothing more is started.
    await finishPmTurn('Still thinking.');
    expect(pmStatus()).toMatchObject({ row: 8, state: 'Awaiting PM review',
      next: 'No further automatic turn. The team continues when you send a message.' });
    expect(reviewTurns()).toHaveLength(1);
    expect(pm().turns).toHaveLength(2);
  });

  it('starts none when the PM records a decision', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Review it.', mode: 'act' });
    ledger.recordDisposition({ coordinatorId: 'pm', handle: 'h-result-0001', disposition: 'accepted', recordedAt: new Date().toISOString() } as never);
    await finishPmTurn('Accepted.');
    expect(reviewTurns()).toHaveLength(0);
    expect(pmStatus()).toMatchObject({ row: 11, state: 'Idle' });
  });

  it('starts none while the person has a message waiting; that turn runs instead', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'First.', mode: 'act' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Second, while you work.', mode: 'act' });
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBeUndefined();
    expect(pm().turns.at(-1)).toContain('Second, while you work.');
  });

  it('starts none after Stop, and the status promises no automatic turn', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Go.', mode: 'act' });
    held = true;
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBeUndefined();
    expect(pmStatus()).toMatchObject({ row: 1, state: 'Stopped', next: 'No automatic PM turn is scheduled. Your next message resumes the team.' });
  });

  it('starts none for a result delivered before this window opened', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T07:30:00.000Z');
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'Hello.', mode: 'act' });
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    expect(pmStatus()).toMatchObject({ row: 8, next: 'No automatic turn is scheduled. The team continues when you send a message.' });
  });

  it('after a reload, runs a scheduled turn that was never admitted exactly once', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    ledger.recordReviewContinuation('pm', { handle: 'h-result-0001', revision: 1 }, 'scheduled');
    // The reload: a new ledger from the saved snapshot, and a new host.
    ledger = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
    expect(continuation()).toBe('scheduled');
    await startTeam();
    expect(reviewTurns()).toHaveLength(1);
    expect(continuation()).toBe('consumed');
    await finishPmTurn();
    manager.dispose();

    ledger = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
    await startTeam();
    expect(reviewTurns()).toHaveLength(0);
    expect(pm().turns).toHaveLength(0);
  });

  it('keeps a turn Stop dropped: after the person resumes, it runs once at the close of their turn', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'First.', mode: 'act' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Second.', mode: 'act' });
    // The first close cannot schedule (the person is waiting); the second can.
    await finishPmTurn();
    expect(continuation()).toBeUndefined();
    held = true;
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    held = false;
    ledger.recordReviewContinuation('pm', { handle: 'h-result-0001', revision: 1 }, 'scheduled');
    bus.send('user', 'pm', 'ask.question', { instruction: 'Resume.', mode: 'act' });
    await finishPmTurn();
    expect(pmStatus()).toMatchObject({ row: 7 });
    expect(reviewTurns()).toHaveLength(1);
    expect(continuation()).toBe('consumed');
  });

  it('starts none for a result whose rework was requested, and says rework is not running', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Review it.', mode: 'act' });
    ledger.recordDisposition({ coordinatorId: 'pm', handle: 'h-result-0001', disposition: 'needs-rework', reason: 'Clause 4 is missing.', recordedAt: new Date().toISOString() } as never);
    await finishPmTurn('Asked for rework.');
    expect(reviewTurns()).toHaveLength(0);
    expect(pmStatus()).toMatchObject({ row: 8.5, why: 'rework was requested but no rework is running' });
  });

  it('reads Complete only from a close recorded in this turn', async () => {
    ledger = new RunLedger();
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'Wrap up.', mode: 'act' });
    manager.noteAssignmentCloseout('pm', 'complete');
    await finishPmTurn('Closed.');
    expect(pmStatus()).toMatchObject({ row: 10, state: 'Complete' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Anything else?', mode: 'act' });
    await finishPmTurn('No.');
    expect(pmStatus()).toMatchObject({ row: 11, state: 'Idle' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Close it partially.', mode: 'act' });
    manager.noteAssignmentCloseout('pm', 'partial');
    await finishPmTurn('Partial.');
    expect(pmStatus()?.row).toBe(11);
  });

  // v0.9.99 (audit M4): records that cannot be read give a truthful status, not none and not an invented empty one.
  it('says Status unavailable when the task records cannot be read, and still ends the turn', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam({ coordinatorTaskStatus: () => { throw new Error('records unavailable'); } });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();
    expect(lastPmReply().type).toBe('task.complete');
    expect(pmStatus()).toMatchObject({ row: 12, state: 'Status unavailable',
      now: 'UnodeAi could not read its task records for this turn.',
      next: 'UnodeAi cannot confirm whether work is still running.' });
    expect(reviewTurns()).toHaveLength(0);
  });

  it('gives a worker turn no PM status', async () => {
    ledger = new RunLedger();
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'Fix it.', mode: 'act' });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'Fixed.', isError: false, responseOutcome: { kind: 'reply' } } } as BackendEvent);
    const reply = bus.query({ from: 'dev' }).filter((m) => m.type === 'task.complete').at(-1)!;
    expect((reply.payload.metadata as { pmStatus?: unknown }).pmStatus).toBeUndefined();
  });

  it('rides on a result wake already queued, instead of a turn of its own', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Go.', mode: 'act' });
    manager.queueAsyncDelegationWake('pm', { handle: 'h-other', ref: 'dev', text: 'Other result.' } as never, () => true, () => true);
    await finishPmTurn();
    await Promise.resolve(); await Promise.resolve();
    expect(reviewTurns()).toHaveLength(0);
    const wake = bus.query({ from: 'unode', to: 'pm' }).filter((m) => (m.payload.metadata as { autoWake?: string }).autoWake === 'async-delegation-result');
    expect(wake).toHaveLength(1);
    expect(String(wake[0].payload.instruction)).toContain('Delegated results still have no recorded decision: dev (h-result) rev 1.');
    expect(continuation()).toBe('consumed');
  });

  // v0.9.99 (audit I1): the review is sent only after its consumed mark is saved. A host that ends while that save is
  // still pending has sent nothing, so the reload that restores the older "scheduled" snapshot runs it exactly once.
  it('sends nothing until the consumed mark is saved, so a reload during the save runs the review exactly once', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    ledger.recordReviewContinuation('pm', { handle: 'h-result-0001', revision: 1 }, 'scheduled');
    disk = JSON.parse(JSON.stringify(ledger.snapshot()));
    saveGate = new Promise<void>(() => { /* the save never finishes in this window */ });
    await startTeam();
    expect(continuation()).toBe('consumed');
    expect(reviewTurns()).toHaveLength(0);
    expect(pm().turns).toHaveLength(0);
    manager.dispose();

    // The reload restores what was saved: still scheduled.
    ledger = new RunLedger(JSON.parse(JSON.stringify(disk)));
    expect(continuation()).toBe('scheduled');
    saveGate = undefined;
    await startTeam();
    expect(reviewTurns()).toHaveLength(1);
    expect(pm().turns).toHaveLength(1);
    expect(continuation()).toBe('consumed');
    await finishPmTurn('Still thinking.');
    manager.dispose();

    ledger = new RunLedger(JSON.parse(JSON.stringify(disk)));
    await startTeam();
    expect(reviewTurns()).toHaveLength(0);
    expect(pm().turns).toHaveLength(0);
  });

  it('when the consumed mark cannot be saved, starts no review, says so, and the result stays owed', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    saveFails = true;
    await startTeam();
    const said: string[] = [];
    manager.on('session.output', (event) => {
      if (event.sessionId === 'pm') said.push(String((event.data as { content?: string } | undefined)?.content ?? ''));
    });
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBe('scheduled');
    expect(said).toContain("UnodeAi could not save that it started the PM's automatic review of dev (h-result) rev 1, so it did "
      + "not start it. The results still wait for the PM's decision; send the PM a message to continue.");
    expect(pm().turns).toHaveLength(1);
  });

  it('a review riding on a result wake waits for its consumed mark to be saved, then rides', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => { release = resolve; });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Go.', mode: 'act' });
    manager.queueAsyncDelegationWake('pm', { handle: 'h-other', ref: 'dev', text: 'Other result.' } as never, () => true, () => true);
    await finishPmTurn();
    const wakes = () => bus.query({ from: 'unode', to: 'pm' }).filter((m) => (m.payload.metadata as { autoWake?: string }).autoWake === 'async-delegation-result');
    expect(wakes()).toHaveLength(0);
    release();
    await settle();
    expect(wakes()).toHaveLength(1);
    expect(String(wakes()[0].payload.instruction)).toContain('Delegated results still have no recorded decision: dev (h-result) rev 1.');
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBe('consumed');
  });

  it('a message of the person that arrives during the save runs first; the review follows once after it', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => { release = resolve; });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
    bus.send('user', 'pm', 'ask.question', { instruction: 'One more thing.', mode: 'act' });
    expect(pm().turns.at(-1)).toContain('One more thing.');
    release();
    await settle();
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBe('scheduled');
    saveGate = undefined;
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(1);
    expect(continuation()).toBe('consumed');
  });

  it('a Stop during the save starts no review; the result stays owed', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => { release = resolve; });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();
    held = true;
    release();
    await settle();
    expect(reviewTurns()).toHaveLength(0);
    expect(continuation()).toBe('scheduled');
  });

  it('a decision recorded during the save means no review of that revision is sent', async () => {
    ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    await startTeam();
    vi.setSystemTime(new Date(AS_OF.getTime() + 10_000));
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => { release = resolve; });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Where are we?', mode: 'act' });
    await finishPmTurn();
    ledger.recordDisposition({ coordinatorId: 'pm', handle: 'h-result-0001', disposition: 'accepted', recordedAt: new Date().toISOString() } as never);
    release();
    await settle();
    expect(reviewTurns()).toHaveLength(0);
    bus.send('user', 'pm', 'ask.question', { instruction: 'Next.', mode: 'act' });
    await finishPmTurn();
    expect(reviewTurns()).toHaveLength(0);
  });
});

describe('the persisted review-continuation mark', () => {
  it('goes scheduled then consumed, never back, and only on an open run', () => {
    const ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    const ref = { handle: 'h-result-0001', revision: 1 };
    expect(ledger.recordReviewContinuation('pm', ref, 'scheduled')).toBe(true);
    expect(ledger.recordReviewContinuation('pm', ref, 'scheduled')).toBe(false);
    expect(ledger.recordReviewContinuation('pm', ref, 'consumed')).toBe(true);
    expect(ledger.recordReviewContinuation('pm', ref, 'scheduled')).toBe(false);
    expect(ledger.recordReviewContinuation('pm', { ...ref, revision: 2 }, 'scheduled')).toBe(false);
    expect(ledger.recordReviewContinuation('other-pm', ref, 'scheduled')).toBe(false);
    const reloaded = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
    expect(reloaded.inspectTaskStatusWhere('pm', () => true).find((t) => t.handle === ref.handle)?.result?.reviewContinuation).toBe('consumed');
  });

  it('goes back from consumed to scheduled only when released, and never from scheduled', () => {
    const ledger = ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z');
    const ref = { handle: 'h-result-0001', revision: 1 };
    expect(ledger.releaseReviewContinuation('pm', ref)).toBe(false);
    ledger.recordReviewContinuation('pm', ref, 'scheduled');
    expect(ledger.releaseReviewContinuation('pm', ref)).toBe(false);
    ledger.recordReviewContinuation('pm', ref, 'consumed');
    expect(ledger.releaseReviewContinuation('pm', ref)).toBe(true);
    expect(ledger.inspectTaskStatusWhere('pm', () => true).find((t) => t.handle === ref.handle)?.result?.reviewContinuation).toBe('scheduled');
  });

  it('changes nothing on a closed run', () => {
    const snapshot = JSON.parse(JSON.stringify(ledgerWithDeliveredResult('2026-10-27T08:00:05.000Z').snapshot()));
    for (const run of snapshot) run.status = 'closed';
    const closed = new RunLedger(snapshot);
    expect(closed.recordReviewContinuation('pm', { handle: 'h-result-0001', revision: 1 }, 'scheduled')).toBe(false);
  });

  it('keeps consumed when two copies of the same result revision are merged', async () => {
    const { mergeStandingResults } = await import('../../backend/DelegationResultProjection');
    const row = { ref: { handle: 'h', revision: 1 }, attemptId: 'a', settledEventId: 's', state: 'ready' as const, delivery: 'delivered' as const };
    expect(mergeStandingResults([{ ...row, reviewContinuation: 'scheduled' }], [{ ...row, reviewContinuation: 'consumed' }])[0].reviewContinuation).toBe('consumed');
    expect(mergeStandingResults([{ ...row, reviewContinuation: 'consumed' }], [{ ...row }])[0].reviewContinuation).toBe('consumed');
    expect(mergeStandingResults([{ ...row }], [{ ...row, reviewContinuation: 'scheduled' }])[0].reviewContinuation).toBe('scheduled');
    expect(mergeStandingResults([], [{ ...row, reviewContinuation: 'bogus' as never }])[0].reviewContinuation).toBeUndefined();
  });
});
