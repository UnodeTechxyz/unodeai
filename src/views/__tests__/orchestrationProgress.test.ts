import { describe, expect, it } from 'vitest';

import { MessageBus } from '../../bus/MessageBus';
import { OrchestrationProgressTracker } from '../orchestrationProgress';
import { RunLedger } from '../../observability/RunLedger';

describe('OrchestrationProgressTracker', () => {
  it('tracks coordinator fan-out as done/total progress', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => ({ pm: 'PM', dev: 'Developer', qa: 'QA' }[id] ?? id));

    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    const dev = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build the fix' }, 'high', 'dev-task');
    const qa = bus.send('pm', 'qa', 'task.assign', { instruction: 'Test the fix' }, 'high', 'qa-task');

    let [summary] = tracker.snapshot();
    expect(summary.total).toBe(2);
    expect(summary.working).toBe(2);
    expect(summary.done).toBe(0);
    expect(summary.items.map((item) => item.agentName)).toEqual(['Developer', 'QA']);

    bus.send('dev', 'pm', 'task.complete', { instruction: 'done' }, 'normal', dev.correlationId);
    bus.send('qa', 'pm', 'system.error', { instruction: 'tests failed' }, 'normal', qa.correlationId);

    [summary] = tracker.snapshot();
    expect(summary.working).toBe(0);
    expect(summary.done).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.completedAt).toBeDefined();

    const states = tracker.agentStates();
    expect(states.find((state) => state.agentId === 'dev')?.status).toBe('done');
    expect(states.find((state) => state.agentId === 'qa')?.status).toBe('blocked');

    bus.dispose();
  });

  it('records partial as its own completion state and counter even when evidence is verified', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (message) => tracker.recordMessage(message));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build it' }, 'high', 'partial-task');

    bus.send('dev', 'pm', 'task.partial', {
      instruction: 'Implemented the core.',
      metadata: { completionState: 'partial', unfinishedActivity: 'Run integration checks.' },
    }, 'normal', task.correlationId);
    tracker.recordEvidence(task.correlationId!, 'verified');
    tracker.recordDisposition(task.correlationId!, 'accepted', undefined, '2026-08-31T12:00:00.000Z');

    const [summary] = tracker.snapshot();
    expect(summary).toMatchObject({ working: 0, done: 0, partial: 1, blocked: 0 });
    expect(summary.items[0]).toMatchObject({
      completionState: 'partial', status: 'coordinator-accepted', evidenceOutcome: 'verified', coordinatorDisposition: 'accepted',
    });
    expect(tracker.agentStates()[0]).toMatchObject({ completionState: 'partial', status: 'coordinator-accepted' });
    bus.dispose();
  });

  it('ignores direct user assignments because they are not crew delegation', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    bus.send('user', 'dev', 'task.assign', { instruction: 'Do this' }, 'normal');

    expect(tracker.snapshot()).toEqual([]);
    bus.dispose();
  });

  it('records a delegated status as current activity without completing the task', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Implement the fix' }, 'high', 'dev-task');
    bus.send('dev', 'pm', 'task.status', {
      instruction: 'Provider request open.', metadata: { phase: 'request-open' },
    }, 'low', task.correlationId);

    const [summary] = tracker.snapshot();
    expect(summary.working).toBe(1);
    expect(summary.done).toBe(0);
    expect(summary.items[0]).toMatchObject({ status: 'working', activity: 'Provider request open.', phase: 'request-open' });
    expect(tracker.agentStates().find((state) => state.agentId === 'dev')?.task).toBe('Provider request open.');
    bus.dispose();
  });

  it('counts cancellation as its own terminal receipt, never as done, blocked, or a coordinator decision', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build the fix' }, 'high', 'dev-task');
    // Both callbacks can race the cancellation bus receipt. Neither may rewrite its terminal state.
    tracker.recordEvidence(task.correlationId!, 'verified');
    tracker.recordDisposition(task.correlationId!, 'rejected', 'not a result', '2026-08-10T12:00:00.000Z');
    bus.send('dev', 'pm', 'system.error', {
      instruction: 'Stopped by user.', metadata: { cancelled: true },
    }, 'normal', task.correlationId);

    const [summary] = tracker.snapshot();
    expect(summary).toMatchObject({ total: 1, working: 0, done: 0, blocked: 0, cancelled: 1 });
    expect(summary.items[0]).toMatchObject({ status: 'cancelled' });
    expect(summary.items[0].coordinatorDisposition).toBeUndefined();
    expect(summary.items[0].evidenceOutcome).toBeUndefined();
    expect(tracker.agentStates().find((state) => state.agentId === 'dev')?.status).toBe('cancelled');
    bus.dispose();
  });

  it('shows an explicit temporary folder scope on the delegation card data', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    bus.send('pm', 'dev', 'task.assign', {
      instruction: 'Review the implementation.',
      taskScope: { folderAccess: [{ path: 'src', permission: 'read' }] },
    }, 'high', 'scoped-task');

    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      scope: 'read-only src',
      scopeMode: 'per-turn-requested',
    });
    expect(tracker.recordTaskScopeApplied('scoped-task')).toBe(true);
    expect(tracker.snapshot()[0].items[0].scopeMode).toBe('per-turn-enforced');
    bus.dispose();
  });

  it('labels an unscoped delegation as fixed session permissions rather than isolation', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    bus.send('pm', 'writer', 'task.assign', { instruction: 'Write the paragraph.' }, 'high', 'unscoped-task');

    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      scope: undefined,
      scopeMode: 'fixed-session-permissions',
    });
    bus.dispose();
  });

  it('replaces a raw Done with a framework evidence verdict on agent state', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build the fix' }, 'high', 'dev-task');
    // TeamTools can report before the task.complete bus listener sees completion.
    tracker.recordEvidence(task.correlationId!, 'replied-not-verified');
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Done' }, 'normal', task.correlationId);

    const [summary] = tracker.snapshot();
    expect(summary.items[0].status).toBe('replied-not-verified');
    expect(tracker.agentStates()[0].status).toBe('replied-not-verified');
    // Completion accounting must still be correct even though evidence arrived first: `working` decremented
    // and the item marked complete. Guards the evidence-before-completion ordering from sticking the busy card.
    expect(summary.working).toBe(0);
    expect(summary.items[0].completedAt).toBeDefined();
    bus.dispose();
  });

  it('keeps context-gap as an independent task state across the evidence-before-completion race', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Use the owner brief.' }, 'high', 'gap-task');
    tracker.recordEvidence(task.correlationId!, 'tool-activity-recorded');
    tracker.recordTaskState(task.correlationId!, {
      kind: 'context-gap', inputId: 'brief', reason: 'unreadable', purpose: 'Owner acceptance boundary',
      reportedAt: '2026-08-25T12:00:00.000Z',
    });
    bus.send('dev', 'pm', 'task.complete', { instruction: 'The input is unreadable.' }, 'normal', task.correlationId);

    const item = tracker.snapshot()[0].items[0];
    expect(item.status).toBe('tool-activity-recorded');
    expect(item.taskState).toMatchObject({ kind: 'context-gap', reason: 'unreadable', purpose: 'Owner acceptance boundary' });
    expect(tracker.agentStates()[0]).toMatchObject({
      status: 'tool-activity-recorded',
      task: expect.stringContaining('Context gap unreadable'),
    });
    bus.dispose();
  });

  it('visibly amends a displayed framework verdict when the coordinator later rejects it', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build the release evidence' }, 'high', 'dev-task');
    tracker.recordEvidence(task.correlationId!, 'verified');
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Done' }, 'normal', task.correlationId);
    expect(tracker.snapshot()[0].items[0].status).toBe('verified');

    tracker.recordDisposition(task.correlationId!, 'rejected', 'The acceptance table is missing.', '2026-08-09T09:17:17.000Z');
    const [summary] = tracker.snapshot();
    expect(summary.items[0]).toMatchObject({
      status: 'coordinator-rejected',
      evidenceOutcome: 'verified',
      amendedFrom: 'verified',
      dispositionReason: 'The acceptance table is missing.',
    });
    expect(tracker.agentStates()[0]).toMatchObject({
      status: 'coordinator-rejected',
      task: 'Amended from verified: The acceptance table is missing.',
    });
    bus.dispose();
  });

  it('hydrates terminal lifecycle from the Run Ledger so reload cannot show settled work as Working (T2m)', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'settled-h', requestedAgent: 'dev', agentId: 'dev', instruction: 'Done task.' });
    ledger.recordDelegationEvidence({
      handle: 'settled-h', agentId: 'dev', outcome: 'tool-activity-recorded', evidence: {
        outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
      },
    });
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'cancelled-h', requestedAgent: 'qa', agentId: 'qa', instruction: 'Stopped task.' });
    ledger.recordDelegationCancelled({
      coordinatorId: 'pm', handle: 'cancelled-h', agentId: 'qa', reason: 'owner stopped it',
      cancelledAt: '2026-08-29T02:00:00.000Z',
    });
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'policy-h', requestedAgent: 'reviewer',
      reason: 'Choose a reviewer with a different reported model id.',
      taskState: 'policy-refused', policyId: 'artifact-review-different-reported-model-v1',
      recordedAt: '2026-08-29T02:01:00.000Z',
    });

    const tracker = new OrchestrationProgressTracker((id) => id);
    tracker.hydrate(new RunLedger(ledger.snapshot()).snapshot());

    const items = tracker.snapshot().flatMap((summary) => summary.items);
    expect(items.find((item) => item.id === 'settled-h')?.status).toBe('tool-activity-recorded');
    expect(items.find((item) => item.id === 'cancelled-h')?.status).toBe('cancelled');
    expect(items.find((item) => item.id === 'policy-h')).toMatchObject({
      status: 'policy-refused',
      result: 'Choose a reviewer with a different reported model id.',
    });
    expect(items.some((item) => item.status === 'working')).toBe(false);
  });
});

describe('v0.9.60 verification outcomes', () => {
  it('keeps no-applicable, not-run, and failed verification outcomes distinct on the team card state', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (message) => { tracker.recordMessage(message); });
    const outcomes = ['no-applicable-sensor', 'replied-not-verified', 'verification-failed'] as const;
    for (const [index, outcome] of outcomes.entries()) {
      const id = `plan-${index}`;
      bus.send('pm', 'dev', 'task.assign', { instruction: `Task ${index}` }, 'high', id);
      tracker.recordEvidence(id, outcome);
      bus.send('dev', 'pm', 'task.complete', { instruction: 'Done' }, 'normal', id);
    }
    expect(tracker.snapshot().flatMap((summary) => summary.items.map((item) => item.status))).toEqual(outcomes);
  });
});
