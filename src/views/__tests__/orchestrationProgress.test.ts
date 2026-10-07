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
    expect(summary.items.map((item) => ({ stepCount: item.stepCount, updatedAt: item.updatedAt }))).toEqual([
      { stepCount: 0, updatedAt: undefined },
      { stepCount: 0, updatedAt: undefined },
    ]);
    expect(tracker.agentStates().find((state) => state.agentId === 'dev')?.liveState).toBe('assigned');

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

  it('shows a late rework reply until the PM accepts it after rework', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    bus.on('message.sent', (message) => tracker.recordMessage(message));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Implement the fix' }, 'high', 'rework-task');
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Initial result.' }, 'normal', task.correlationId);
    tracker.recordDisposition(task.correlationId!, 'needs-rework', 'Cover the empty state.', '2026-09-25T22:11:07.000Z');

    expect(tracker.recordLateReworkReply(task.correlationId!, '2026-09-25T22:11:13.000Z'))
      .toBe("UnodeAi: Developer replied to the PM's rework request. Ask the PM to review it.");
    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      coordinatorDisposition: 'needs-rework', reworkReplyAt: '2026-09-25T22:11:13.000Z',
    });
    expect(tracker.agentStates()[0].task)
      .toBe("UnodeAi: Developer replied to the PM's rework request. Ask the PM to review it.");

    tracker.recordDisposition(task.correlationId!, 'accepted-after-rework', undefined, '2026-09-25T22:11:20.000Z');
    expect(tracker.snapshot()[0].items[0]).toMatchObject({ coordinatorDisposition: 'accepted-after-rework' });
    expect(tracker.snapshot()[0].items[0].reworkReplyAt).toBeUndefined();
    bus.dispose();
  });

  it('keeps a host safety stop distinct from an ordinary partial result', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (message) => tracker.recordMessage(message));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Inspect everything' }, 'high', 'stopped-task');
    bus.send('dev', 'pm', 'task.partial', {
      instruction: 'Inspected the core files; integration checks remain.',
      metadata: { completionState: 'partial', stopped: true, stopReason: 'step-safety-limit' },
    }, 'normal', task.correlationId);

    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      completionState: 'partial', stopped: true, stopReason: 'step-safety-limit',
    });
    expect(tracker.agentStates()[0]).toMatchObject({ stopped: true, stopReason: 'step-safety-limit' });
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
      instruction: 'Provider request open: Implement the fix.', metadata: { phase: 'request-open' },
    }, 'low', task.correlationId);

    let [summary] = tracker.snapshot();
    expect(summary.working).toBe(1);
    expect(summary.done).toBe(0);
    expect(summary.items[0]).toMatchObject({
      status: 'working', activity: 'Provider request open: Implement the fix.', phase: 'request-open', stepCount: 1,
      waitingOn: 'model provider',
    });
    expect(tracker.agentStates().find((state) => state.agentId === 'dev')?.task).toBe('Provider request open: Implement the fix.');

    bus.send('dev', 'pm', 'task.status', { instruction: 'Streaming response.' }, 'low', task.correlationId);
    [summary] = tracker.snapshot();
    expect(summary.items[0]).toMatchObject({
      status: 'working', activity: 'Streaming response.', stepCount: 1,
    });
    expect(summary.items[0].waitingOn).toBeUndefined();
    bus.dispose();
  });

  it('records a host approval as a known wait and clears it when the decision closes', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Apply the fix' }, 'high', 'approval-task');

    bus.send('dev', 'pm', 'task.status', {
      instruction: 'Waiting on your approval.', metadata: { phase: 'host-wait' },
    }, 'low', task.correlationId);
    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      phase: 'host-wait', waitingOn: 'your approval', status: 'working',
    });
    expect(tracker.agentStates()[0].liveState).toBe('waiting');

    bus.send('dev', 'pm', 'task.status', {
      instruction: 'Approval wait ended.', metadata: { phase: 'host-wait-ended' },
    }, 'low', task.correlationId);
    expect(tracker.snapshot()[0].items[0].waitingOn).toBeUndefined();
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

  it('names an empty reply with its observed cause, live and after a reload, and a rejection keeps that cause (v0.9.90 §7.3)', () => {
    const emptyReply = {
      kind: 'empty-reply',
      attempts: [1, 2].map((attempt) => ({ attempt, gateway: 'openrouter', inputBasis: 'reported', inputTokens: 246_668, finishSignal: 'stop' })),
    };
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => ({ pm: 'PM', dev: 'Developer' }[id] ?? id));
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Write the file' }, 'high', 'empty-task');
    bus.send('dev', 'pm', 'task.complete', { instruction: '', metadata: { responseOutcome: emptyReply } }, 'normal', task.correlationId);
    tracker.recordEvidence(task.correlationId!, 'no-evidence');
    expect(tracker.snapshot()[0].items[0]).toMatchObject({
      status: 'no-evidence',
      emptyReply: 'the model returned an empty reply at about 246,668 input tokens',
    });
    expect(tracker.snapshot()[0].items[0].result).toMatch(/^The model returned an empty reply after 2 attempts\./);
    tracker.recordDisposition(task.correlationId!, 'rejected', 'Rework it.', '2026-09-29T09:00:00.000Z');
    expect(tracker.agentStates()[0].task).toBe('Rejected — the model returned an empty reply at about 246,668 input tokens. Coordinator: Rework it.');
    bus.dispose();

    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'empty-h', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write the file' });
    ledger.recordDelegationEvidence({
      handle: 'empty-h', agentId: 'dev', outcome: 'no-evidence', evidence: {
        outcome: 'no-evidence', changedFiles: [], hadToolActions: false,
        verification: { ran: false, passed: false }, unrecordedWrites: false, responseOutcome: emptyReply as any,
      },
    });
    const restored = new OrchestrationProgressTracker((id) => id);
    restored.hydrate(new RunLedger(ledger.snapshot()).snapshot());
    expect(restored.snapshot().flatMap((summary) => summary.items).find((item) => item.id === 'empty-h'))
      .toMatchObject({ status: 'no-evidence', emptyReply: 'the model returned an empty reply at about 246,668 input tokens' });
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

  // F7-20 (v0.9.88): one card per run, live and after a reload.
  it('keeps one card per run while two requests overlap, and a woken turn joins its run\'s card', () => {
    const bus = new MessageBus();
    let currentRun = 'origin-a';
    const tracker = new OrchestrationProgressTracker((id) => id, () => currentRun);
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Async job for request A' }, 'high', 'h-a1');
    currentRun = 'origin-b';
    // The previous run still has an async worker when the PM dispatches in its next turn.
    bus.send('pm', 'qa', 'task.assign', { instruction: 'Job for request B' }, 'high', 'h-b1');
    currentRun = 'origin-a';
    bus.send('pm', 'writer', 'task.assign', { instruction: 'Follow-up after the wake' }, 'high', 'h-a2');

    const cards = tracker.snapshot();
    expect(cards.map((card) => card.id)).toEqual(['delegation-run-origin-a', 'delegation-run-origin-b']);
    expect(cards[0].items.map((item) => item.id)).toEqual(['h-a1', 'h-a2']);
    expect(cards[1].items.map((item) => item.id)).toEqual(['h-b1']);
  });

  it('rebuilds the same run cards after a reload, marked restored, and names them once the roster loads', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-a1', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Async job for request A', originCorrelationId: 'origin-a', dispatchedAt: '2026-09-26T10:00:00.000Z',
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-b1', requestedAgent: 'qa', agentId: 'qa',
      instruction: 'Job for request B', originCorrelationId: 'origin-b', dispatchedAt: '2026-09-26T10:01:00.000Z',
    });
    const roster = new Map<string, string>();
    const tracker = new OrchestrationProgressTracker((id) => roster.get(id) ?? `Removed agent (${id.slice(0, 8)})`);
    tracker.hydrate(ledger.snapshot());

    let cards = tracker.snapshot();
    expect(cards.map((card) => [card.id, card.restored])).toEqual([
      ['delegation-run-origin-a', true],
      ['delegation-run-origin-b', true],
    ]);
    // Hydration runs before the roster: no bare ids, and the names arrive with the roster.
    expect(cards[0].items[0].agentName).toBe('Removed agent (dev)');
    roster.set('pm', 'Project Manager').set('dev', 'Developer').set('qa', 'QA');
    expect(tracker.refreshNames()).toBe(true);
    expect(tracker.refreshNames()).toBe(false);
    cards = tracker.snapshot();
    expect(cards.map((card) => [card.coordinatorName, card.items[0].agentName])).toEqual([
      ['Project Manager', 'Developer'],
      ['Project Manager', 'QA'],
    ]);
  });

  it('hydrates an interrupted task without a running timer and retains its replacement link', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'lost-handle', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Build it.', originCorrelationId: 'root-lost', dispatchedAt: '2026-09-11T13:00:00.000Z',
    });
    ledger.reconcileRestoredActiveDelegations('2026-09-11T13:05:00.000Z');
    ledger.recordDisposition({
      handle: 'lost-handle', agentId: 'dev', outcome: 'no-evidence', disposition: 'superseded',
      reason: 'A replacement was admitted.', replacementHandle: 'new-handle', recordedAt: '2026-09-11T13:06:00.000Z',
    });
    const tracker = new OrchestrationProgressTracker((id) => id);
    tracker.hydrate(ledger.snapshot());

    const [summary] = tracker.snapshot();
    expect(summary).toMatchObject({ total: 1, working: 0, blocked: 1, completedAt: '2026-09-11T13:05:00.000Z' });
    expect(summary.items[0]).toMatchObject({
      status: 'interrupted',
      activity: 'Interrupted — no active worker', completedAt: '2026-09-11T13:05:00.000Z',
      coordinatorDisposition: 'superseded', replacementHandle: 'new-handle',
    });
    expect(summary.items[0].interruption).toEqual({
      reason: 'host-restarted',
      lastObservedAt: '2026-09-11T13:00:00.000Z',
      detectedAt: '2026-09-11T13:05:00.000Z',
    });
    expect(summary.items[0]).not.toHaveProperty('completionState');
    expect(tracker.agentStates()[0]).toMatchObject({
      status: 'interrupted', task: expect.stringMatching(
        /Reason: host-restarted\. Last observed: 2026-09-11T13:00:00\.000Z\. Detected: 2026-09-11T13:05:00\.000Z\..*Replacement: new-handle\./,
      ),
    });
  });

  it('settles a live Activity row from an interruption receipt instead of classifying a worker reply', () => {
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id);
    bus.on('message.sent', (message) => tracker.recordMessage(message));
    const task = bus.send('pm', 'dev', 'task.assign', { instruction: 'Build it.' }, 'high', 'lost-live');
    bus.send('dev', 'pm', 'system.error', {
      instruction: 'Worker stopped.',
      metadata: {
        interrupted: true, interruptionReason: 'worker-lost',
        lastObservedAt: '2026-09-11T14:01:00.000Z', detectedAt: '2026-09-11T14:02:00.000Z',
      },
    }, 'normal', task.correlationId);

    const [summary] = tracker.snapshot();
    expect(summary).toMatchObject({ working: 0, blocked: 1, done: 0, completedAt: '2026-09-11T14:02:00.000Z' });
    expect(summary.items[0]).toMatchObject({
      status: 'interrupted', completionState: 'not-observed',
      updatedAt: '2026-09-11T14:01:00.000Z', completedAt: '2026-09-11T14:02:00.000Z',
    });
    bus.dispose();
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

// Field test 2026-09-26: the ledger closed a stopped run as partial, but its card showed it only after a reload.
describe('OrchestrationProgressTracker run closeouts', () => {
  it('shows a run the ledger closes on its card at once, live or restored, and only once', () => {
    const host = { hostInstanceId: 'window-1', epoch: 'activation-1' };
    const ledger = new RunLedger([], { host });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-a', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write long.txt.',
      originCorrelationId: 'origin-a', dispatchedAt: '2026-09-26T10:00:00.000Z',
    });
    const bus = new MessageBus();
    const tracker = new OrchestrationProgressTracker((id) => id, () => 'origin-a');
    bus.on('message.sent', (msg) => tracker.recordMessage(msg));
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Write long.txt.' }, 'high', 'h-a');
    const card = () => tracker.snapshot().find((summary) => summary.id === 'delegation-run-origin-a');
    expect(card()?.closeoutCompletionState).toBeUndefined();

    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-a', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: '2026-09-26T10:01:00.000Z' });
    expect(tracker.applyRunCloseouts(ledger.closedRunCloseouts())).toBe(false);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-b', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write long.txt again.',
      originCorrelationId: 'origin-b', dispatchedAt: '2026-09-26T10:02:00.000Z',
    });
    expect(tracker.applyRunCloseouts(ledger.closedRunCloseouts())).toBe(true);
    expect(card()?.closeoutCompletionState).toBe('partial');
    expect(tracker.applyRunCloseouts(ledger.closedRunCloseouts())).toBe(false);

    const restored = new OrchestrationProgressTracker((id) => id);
    const reopened = new RunLedger(ledger.snapshot());
    restored.hydrate(reopened.snapshot());
    expect(restored.snapshot().find((summary) => summary.id === 'delegation-run-origin-a')?.closeoutCompletionState).toBe('partial');
  });
});
