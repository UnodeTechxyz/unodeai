import { describe, expect, it } from 'vitest';
import { TeamTools, TeamView } from '../TeamTools';
import { hostAuthoredCloseout } from '../OpenAICompatBackend';
import { MessageBus } from '../../bus/MessageBus';

const view: TeamView = {
  list: () => [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' },
  ],
  resolve: (ref) => (ref === 'dev' || ref === 'senior-dev' ? { id: 'dev' } : ref === 'pm' ? { id: 'pm' } : undefined),
} as TeamView;

function coordinatorTools() {
  const bus = new MessageBus();
  const events: unknown[] = [];
  const tools = new TeamTools('pm', view, bus, {
    timeoutMs: 1000,
    evidenceEnabled: true,
    onAssignmentCloseout: (event) => { events.push(event); },
  });
  return { tools, events, bus };
}

/**
 * The vocabulary covered a delegate's RESULT and nothing else: nine dispositions, all about a task that came
 * back. A coordinator handed an impossible or under-specified job had no terminal state at all, so it stopped
 * — which from the user's side is a coordinator that quit thinking. (Owner, 2026-08-12.)
 */
describe('a coordinator can conclude work it could not finish', () => {
  it('accepts partial and blocked as real outcomes, with per-item reasons', async () => {
    const { tools, events } = coordinatorTools();

    const partial = await tools.run('close_assignment', {
      outcome: 'partial',
      summary: 'Job 2 confirmed and documented.',
      incomplete: [
        { item: 'Job 1 field observation', reason: 'the fault did not occur while under observation' },
        { item: 'Job 3 run accounting', reason: 'no run opened this round, so no pack could be exported' },
      ],
    });

    expect(partial).toMatch(/closed as partial with 2 unresolved item/);
    // It must not read as a failure to be retried before answering: that is what makes a coordinator loop.
    expect(partial).toMatch(/does not need to be retried/);
    expect(events).toHaveLength(1);
  });

  it('refuses a bare label the way a rejection does', async () => {
    const { tools } = coordinatorTools();

    expect(await tools.run('close_assignment', { outcome: 'blocked', summary: 'could not proceed' }))
      .toMatch(/requires an incomplete list/);
    expect(await tools.run('close_assignment', {
      outcome: 'partial',
      summary: 'some of it',
      incomplete: [{ item: 'Job 1', reason: '' }],
    })).toMatch(/needs both an item and a concrete reason/);
    expect(await tools.run('close_assignment', { outcome: 'finished', summary: 'x' }))
      .toMatch(/outcome must be one of/);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: '   ' }))
      .toMatch(/summary is required/);
  });

  it('reports the assignment as open only once work was actually taken on', () => {
    const { tools } = coordinatorTools();
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: false, assignmentClosed: false });
  });
});

/**
 * The mechanism half. A tool the model may decline to call is guidance, not a mechanism (standing rule 20),
 * so when no conclusion is stated the host states the facts it observed — and only those.
 */
describe('the host concludes when the coordinator does not', () => {
  it('says that no assignment close was recorded, and names what was left undecided', () => {
    const text = hostAuthoredCloseout({ settledButUndisposed: 2, recordedDispositionCount: 0 });

    expect(text).toBe('UnodeAi: No assignment close was recorded; 2 delegation results still need a decision. '
      + 'Review the timeline and decide whether to continue or retry.');
    expect(text).not.toMatch(/close_assignment|disposition|settled delegation/);
    // A normal reply is not described as silence or as a missing conclusion.
    expect(text).not.toMatch(/ended without|stated conclusion/);
  });

  it('uses singular and plural verbs for the decisions that are owed', () => {
    expect(hostAuthoredCloseout({ settledButUndisposed: 1, recordedDispositionCount: 0 }))
      .toMatch(/1 delegation result still needs a decision/);
    expect(hostAuthoredCloseout({ settledButUndisposed: 3, recordedDispositionCount: 0 }))
      .toMatch(/3 delegation results still need a decision/);
  });

  it('never gives a verdict on completion or on a check, whatever the closeout state holds', () => {
    // The Job outcome that follows reports completion and checks. This text is written before the run closes
    // and cannot see that card, so it owns neither: facts about checks in the state change nothing here.
    const withCheckFacts = {
      settledButUndisposed: 3, recordedDispositionCount: 1, hasVerificationPath: true,
      acceptedButUngated: 2, verificationNotRun: 1, verificationFailed: 1, noApplicableSensor: 1,
    };
    for (const state of [
      { settledButUndisposed: 0, recordedDispositionCount: 0 },
      { settledButUndisposed: 3, recordedDispositionCount: 0 },
      withCheckFacts,
      { ...withCheckFacts, hasVerificationPath: false },
    ]) {
      const text = hostAuthoredCloseout(state);
      expect(text).not.toMatch(/\bsuccessful\b|\bdone correctly\b|\bverified\b|\bcomplete\b/i);
      expect(text).not.toMatch(/\bcheck|\bpass|\bfail|verif|not run/i);
    }
    expect(hostAuthoredCloseout(withCheckFacts)).toBe(hostAuthoredCloseout({ settledButUndisposed: 3, recordedDispositionCount: 1 }));
    expect(hostAuthoredCloseout({ settledButUndisposed: 0, recordedDispositionCount: 0 }))
      .toBe('UnodeAi: No assignment close was recorded; no delegation result was recorded. '
        + 'Review the timeline and decide whether to continue or retry.');
  });

  it('reports recorded dispositions as a missing formal close, not as abandoned result judgement', async () => {
    const { tools, bus } = coordinatorTools();
    bus.onType('task.assign', (message) => {
      bus.send('dev', message.from, 'task.complete', {
        instruction: 'Read-only review completed with a caveat.',
        metadata: {
          delegationEvidence: {
            hadToolActions: true,
            changedFiles: [],
            verification: { ran: false, passed: false },
          },
        },
      }, 'normal', message.correlationId);
    });

    const result = await tools.run('assign_task', { agent: 'dev', instruction: 'review it' });
    const handle = /Handle: ([^\s.]+)/.exec(result)?.[1];
    expect(handle).toBeTruthy();
    expect(tools.coordinatorCloseoutState()).toMatchObject({
      settledButUndisposed: 1,
      recordedDispositionCount: 0,
    });
    expect(await tools.run('record_task_disposition', {
      handle,
      disposition: 'accepted-with-caveat',
      reason: 'The telemetry discrepancy remains unresolved.',
    })).toMatch(/acceptance with caveat/i);

    const state = tools.coordinatorCloseoutState();
    expect(state).toMatchObject({ settledButUndisposed: 0, recordedDispositionCount: 1 });
    const text = hostAuthoredCloseout(state);
    expect(text).toBe('');
  });

  it('keeps needs-rework quiet because the host has already sent the rework turn', () => {
    expect(hostAuthoredCloseout({
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'needs-rework' }],
    })).toBe('');
  });

  it.each([
    ['rejected', "UnodeAi: The PM rejected Dev's result and sent no new task; nothing is running."],
    ['deferred', "UnodeAi: The PM deferred Dev's result; nothing is running."],
  ] as const)(
    'names the agent when a %s disposition has no live follow-up',
    (disposition, expected) => {
      const state = {
        settledButUndisposed: 0,
        recordedDispositionCount: 1,
        latestDispositions: [{ agentName: 'Dev', disposition }],
      };
      expect(hostAuthoredCloseout(state)).toBe(expected);
      expect(hostAuthoredCloseout({ ...state, hasLiveDelegationWork: true })).toBe('');
    },
  );

  it.each(['accepted', 'accepted-with-caveat', 'needs-human'] as const)(
    'keeps a %s disposition quiet both with and without a live follow-up',
    (disposition) => {
      const state = {
        settledButUndisposed: 0,
        recordedDispositionCount: 1,
        latestDispositions: [{ agentName: 'Dev', disposition }],
      };
      expect(hostAuthoredCloseout(state)).toBe('');
      expect(hostAuthoredCloseout({ ...state, hasLiveDelegationWork: true })).toBe('');
    },
  );

  it('waits for the user or a live follow-up rather than reporting an unsent rework', () => {
    const rework = {
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'needs-rework' }],
    } as const;
    expect(hostAuthoredCloseout({
      ...rework,
      latestDispositions: [{ agentName: 'Dev', disposition: 'needs-human' }],
    })).toBe('');
  });

  it('stays silent when every standing result is accepted, with or without a passing check', () => {
    const accepted = {
      settledButUndisposed: 0,
      recordedDispositionCount: 2,
      latestDispositions: [
        { agentName: 'Dev', disposition: 'accepted' },
        { agentName: 'PM', disposition: 'accepted-with-caveat' },
      ],
    };
    expect(hostAuthoredCloseout(accepted)).toBe('');
    // An accepted change without a passing check used to be reported here, beside a Job outcome that said the
    // task's own checks had passed. Whether a check passed is that card's to say.
    expect(hostAuthoredCloseout({ ...accepted, acceptedButUngated: 1 })).toBe('');
    expect(hostAuthoredCloseout({ ...accepted, verificationNotRun: 1, verificationFailed: 1 })).toBe('');
    expect(hostAuthoredCloseout({ ...accepted, acceptedButUngated: 1, hasVerificationPath: false })).toBe('');
  });

  it('still speaks when an accepted result stands beside one that has no decision', () => {
    expect(hostAuthoredCloseout({
      settledButUndisposed: 1,
      recordedDispositionCount: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'accepted' }],
    })).toMatch(/No assignment close was recorded; 1 delegation result still needs a decision/);
  });
});

/**
 * A rework reply wakes an idle PM, and a woken PM may request rework again. That loop needs a person to end it,
 * so only MAX_AUTOMATIC_REWORK_ROUNDS requests per handle are sent after the user last wrote (Owner, 2026-09-26).
 */
describe('automatic rework is bounded until the user writes', () => {
  it('sends two rounds, holds the third with a host line, ignores wakes, and re-arms on a user message', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onAsyncResultReady: () => true,
    });
    bus.onType('task.assign', (message) => {
      bus.send('dev', 'pm', 'task.complete', {
        instruction: 'Initial result.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
      }, 'normal', message.correlationId);
    });
    const reworkMessages: string[] = [];
    bus.onType('agent.message', (message) => {
      if (message.from === 'pm' && message.to === 'dev') reworkMessages.push(String(message.payload.instruction));
    });
    const settle = async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    };
    const first = await tools.run('assign_task', { agent: 'dev', instruction: 'Draft the release note.' });
    const handle = /Handle: ([^\s.]+)/.exec(first)?.[1]!;
    const requestRework = () => tools.run('record_task_disposition', {
      handle, disposition: 'needs-rework', reason: 'Quote the exact command output.',
    });
    const reply = async () => {
      bus.send('dev', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
      await settle();
    };

    await requestRework();
    await reply();
    await requestRework();
    await reply();
    expect(reworkMessages).toHaveLength(2);
    expect(tools.coordinatorCloseoutState().reworkHeldAtCap).toEqual([]);

    const held = await requestRework();
    expect(held).toMatch(/was NOT sent/);
    expect(reworkMessages).toHaveLength(2);
    const state = tools.coordinatorCloseoutState();
    expect(state.hasLiveDelegationWork).toBe(false);
    expect(state.reworkHeldAtCap).toEqual([{ agentName: 'Dev', rounds: 3 }]);
    expect(hostAuthoredCloseout(state)).toBe(
      'UnodeAi: The PM has asked Dev to rework this task 3 times. Automatic rework stopped; accept the result, '
      + 'or ask the PM for another round.',
    );

    // The host's async-result wake is not the user: it must not re-arm automatic rework.
    bus.send('unode', 'pm', 'ask.question', { instruction: 'Async delegation result arrived.' });
    await requestRework();
    expect(reworkMessages).toHaveLength(2);

    // The person's message does.
    bus.send('user', 'pm', 'ask.question', { instruction: 'Ask Dev for one more round.' });
    await requestRework();
    expect(reworkMessages).toHaveLength(3);
    expect(tools.coordinatorCloseoutState().reworkHeldAtCap).toEqual([]);
  });

  it('drops a held rework from the closeout once the PM records another decision', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true, onAsyncResultReady: () => true });
    bus.onType('task.assign', (message) => {
      bus.send('dev', 'pm', 'task.complete', {
        instruction: 'Initial result.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
      }, 'normal', message.correlationId);
    });
    const first = await tools.run('assign_task', { agent: 'dev', instruction: 'Draft the release note.' });
    const handle = /Handle: ([^\s.]+)/.exec(first)?.[1]!;
    for (let round = 0; round < 3; round += 1) {
      await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Be exact.' });
      bus.send('dev', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    expect(tools.coordinatorCloseoutState().reworkHeldAtCap).toHaveLength(1);

    await tools.run('record_task_disposition', { handle, disposition: 'accepted-with-caveat', reason: 'Good enough.' });
    expect(tools.coordinatorCloseoutState().reworkHeldAtCap).toEqual([]);
  });
});

/**
 * The closeout state fed a host notice that counted a superseded attempt's unrun check while the Job outcome,
 * which reads the work as it stands, said the task's checks had passed. Both now read the same projection.
 */
describe('the closeout state counts the work as it stands', () => {
  function settling(evidenceOf: (instruction: string) => Record<string, unknown>) {
    const { tools, bus } = coordinatorTools();
    bus.onType('task.assign', (message) => {
      const instruction = String(message.payload.instruction);
      bus.send('dev', message.from, 'task.complete', {
        instruction: `Result of ${instruction}.`,
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false }, ...evidenceOf(instruction) } },
      }, 'normal', message.correlationId);
    });
    const handleOf = (result: string) => /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    return { tools, bus, handleOf };
  }

  it('owes no decision for a superseded result, and reports only its replacement', async () => {
    const { tools, bus, handleOf } = settling(() => ({}));
    const old = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'first try' }));
    const replacement = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'second try' }));
    expect(tools.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 2, recordedDispositionCount: 0 });

    expect(await tools.run('record_task_disposition', {
      handle: old, disposition: 'superseded', reason: 'The second try replaces it.', replacement_handle: replacement,
    })).toMatch(/superseded/);

    const afterSupersession = tools.coordinatorCloseoutState();
    expect(afterSupersession).toMatchObject({ settledButUndisposed: 1, recordedDispositionCount: 0, latestDispositions: [] });
    expect(hostAuthoredCloseout(afterSupersession)).toMatch(/1 delegation result still needs a decision/);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);

    expect(await tools.run('record_task_disposition', { handle: replacement, disposition: 'accepted' })).toMatch(/acceptance/);
    const closed = tools.coordinatorCloseoutState();
    expect(closed).toMatchObject({
      settledButUndisposed: 0, recordedDispositionCount: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'accepted' }],
    });
    expect(hostAuthoredCloseout(closed)).toBe('');

    const metrics = await tools.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 1.');
    expect(metrics).toContain('superseded or retried attempts kept as history, not counted as tasks: 1.');
    expect(metrics).toContain('complete deliveries: 1.');
    expect(metrics).toContain('coordinator-accepted: 1/1.');
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).not.toMatch(/^Error/);
    bus.dispose();
  });

  it('counts a result whose every file change was refused as blocked, and one that changed something as partial', async () => {
    const { tools, bus, handleOf } = settling((instruction) => instruction === 'all refused' ? { refusedEffects: 2 }
      : instruction === 'half refused' ? { refusedEffects: 1, changedFiles: ['src/a.ts'] }
        : instruction === 'forged' ? { refusedEffects: '3' }
          : {});
    for (const instruction of ['all refused', 'half refused', 'forged', 'read only']) {
      handleOf(await tools.run('assign_task', { agent: 'dev', instruction }));
    }

    const metrics = await tools.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 4.');
    // The forged value is not a count the host wrote and is not read; the reader used no write authority.
    expect(metrics).toContain('complete deliveries: 2.');
    expect(metrics).toContain('partial deliveries: 1.');
    expect(metrics).toContain('deliveries blocked because every file change they asked for was refused: 1.');
    bus.dispose();
  });
});

/**
 * A close used to stand for the rest of the coordinator's session. In the v0.9.95 field run one assignment was
 * closed, the next one in the same session was not, and no host line said so.
 */
describe('a recorded close ends its assignment, and the next request of the person begins another', () => {
  function crew() {
    const { tools, bus } = coordinatorTools();
    bus.onType('task.assign', (message) => {
      bus.send('dev', message.from, 'task.complete', {
        instruction: `Result of ${String(message.payload.instruction)}.`,
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false } } },
      }, 'normal', message.correlationId);
    });
    const handleOf = (result: string) => /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    const ask = (from = 'user', to = 'pm') => bus.send(from, to, 'ask.question', { instruction: 'Next, please.' });
    return { tools, bus, handleOf, ask };
  }

  it('owes the host line again once the person asks for more and work is taken on', async () => {
    const { tools, bus, handleOf, ask } = crew();
    // The first assignment is closed as partial, with its result still undecided.
    handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'first job' }));
    expect(await tools.run('close_assignment', {
      outcome: 'partial', summary: 'First job returned.', incomplete: [{ item: 'first job', reason: 'its result was not reviewed' }],
    })).toMatch(/closed as partial/);
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: true });

    ask();
    // The new assignment has taken nothing on and owes nothing; the closed one's result owes it no decision.
    expect(tools.coordinatorCloseoutState()).toMatchObject({
      assignmentOpen: false, assignmentClosed: false, settledButUndisposed: 0, recordedDispositionCount: 0,
    });

    const second = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'second job' }));
    const open = tools.coordinatorCloseoutState();
    expect(open).toMatchObject({ assignmentOpen: true, assignmentClosed: false, settledButUndisposed: 1 });
    expect(hostAuthoredCloseout(open)).toBe('UnodeAi: No assignment close was recorded; 1 delegation result still needs a decision. '
      + 'Review the timeline and decide whether to continue or retry.');
    // A question in the middle of this assignment, with no close recorded, does not begin yet another one.
    ask();
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: false, settledButUndisposed: 1 });
    // The session's own metrics still count every result of the session.
    const metrics = await tools.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 2.');
    expect(metrics).toContain('settled-but-undisposed: 2.');

    // The earlier assignment's undecided result does not hold back the close of this one.
    expect(await tools.run('record_task_disposition', { handle: second, disposition: 'accepted' })).toMatch(/acceptance/);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Second job delivered.' })).toMatch(/closed as complete/);
    bus.dispose();
  });

  it('keeps one assignment through a question of the person while no close is recorded', async () => {
    const { tools, bus, ask } = crew();
    await tools.run('assign_task', { agent: 'dev', instruction: 'the job' });
    ask();
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: false, settledButUndisposed: 1 });
    bus.dispose();
  });

  it('begins a new assignment only on a request of the person to this coordinator', async () => {
    const { tools, bus, handleOf, ask } = crew();
    const handle = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'the job' }));
    await tools.run('record_task_disposition', { handle, disposition: 'accepted' });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Delivered.' })).toMatch(/closed as complete/);
    ask('dev', 'pm');
    ask('user', 'dev');
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: true });
    bus.dispose();
  });

  const ONE_OWED = 'UnodeAi: No assignment close was recorded; 1 delegation result still needs a decision. '
    + 'Review the timeline and decide whether to continue or retry.';
  const stillRunning = { outcome: 'partial', summary: 'Stopping here.', incomplete: [{ item: 'the long job', reason: 'still running' }] };
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** A teammate that replies only when the test says so, so that work can still be running at a close. */
  function liveCrew() {
    const { tools, bus } = coordinatorTools();
    const handleOf = (result: string) => /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    const ask = () => bus.send('user', 'pm', 'ask.question', { instruction: 'Next, please.' });
    const reply = async (handle: string) => {
      bus.send('dev', 'pm', 'task.complete', {
        instruction: 'The late result.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false } } },
      }, 'normal', handle);
      await later();
    };
    return { tools, bus, handleOf, ask, reply };
  }

  it('owes a result that returned after the close a decision, and carries it into the next assignment', async () => {
    const { tools, bus, handleOf, ask, reply } = liveCrew();
    const late = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the long job' }));
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    await reply(late);
    // Until the person writes, the close stands; it did not see this result, which is owed a decision.
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentClosed: true, hasLiveDelegationWork: false, settledButUndisposed: 1 });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);

    ask();
    // The new assignment has dispatched nothing, but the result is its own: the line is owed.
    const carried = tools.coordinatorCloseoutState();
    expect(carried).toMatchObject({ assignmentOpen: true, assignmentClosed: false, hasLiveDelegationWork: false, settledButUndisposed: 1 });
    expect(hostAuthoredCloseout(carried)).toBe(ONE_OWED);
    bus.dispose();
  });

  it('owes work still running through the next request a decision when it returns, with no new dispatch', async () => {
    const { tools, bus, handleOf, ask, reply } = liveCrew();
    const late = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the long job' }));
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    ask();
    // The new assignment holds the running work; while it runs, it owns the next step and no line is due.
    const running = tools.coordinatorCloseoutState();
    expect(running).toMatchObject({ assignmentOpen: true, assignmentClosed: false, hasLiveDelegationWork: true, settledButUndisposed: 0 });
    expect(hostAuthoredCloseout(running)).toBe('');

    await reply(late);
    const returned = tools.coordinatorCloseoutState();
    expect(returned).toMatchObject({ assignmentOpen: true, assignmentClosed: false, hasLiveDelegationWork: false, settledButUndisposed: 1 });
    expect(hostAuthoredCloseout(returned)).toBe(ONE_OWED);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);
    expect(await tools.run('record_task_disposition', { handle: late, disposition: 'accepted' })).toMatch(/acceptance/);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).toMatch(/closed as complete/);
    bus.dispose();
  });

  it('does not let a close cover a timed-out wait whose teammate was still working', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', view, bus, { timeoutMs: 20, evidenceEnabled: true });
    let handle = '';
    bus.onType('task.assign', (message) => { handle = message.correlationId!; });
    expect(await tools.run('assign_task', { agent: 'dev', instruction: 'the long job' })).toMatch(/^Error: timed out/);
    // The wait is recorded as timed out, and the teammate is still working on the task.
    expect(tools.coordinatorCloseoutState()).toMatchObject({ hasLiveDelegationWork: true, settledButUndisposed: 1 });
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    bus.send('dev', 'pm', 'task.complete', { instruction: 'The late result.' }, 'normal', handle);
    await later();
    bus.send('user', 'pm', 'ask.question', { instruction: 'Next, please.' });
    const carried = tools.coordinatorCloseoutState();
    expect(carried).toMatchObject({ assignmentOpen: true, assignmentClosed: false, hasLiveDelegationWork: false, settledButUndisposed: 1 });
    expect(hostAuthoredCloseout(carried)).toBe(ONE_OWED);
    bus.dispose();
  });

  /** The returned rework is a result with no decision on it: the line is owed, and `complete` waits for one. */
  const undecided = { hasLiveDelegationWork: false, settledButUndisposed: 1, recordedDispositionCount: 0, latestDispositions: [] };

  it('carries a rework that was running at the close into the next assignment', async () => {
    const { tools, bus, handleOf, ask } = crew();
    const handle = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'the job' }));
    await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Quote the output.' });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).toMatch(/^Error: delegated work is still running/);
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
    await later();
    ask();
    const carried = tools.coordinatorCloseoutState();
    expect(carried).toMatchObject({ assignmentOpen: true, assignmentClosed: false, ...undecided });
    expect(hostAuthoredCloseout(carried)).toBe(ONE_OWED);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);
    expect(await tools.run('record_task_disposition', { handle, disposition: 'accepted-after-rework' })).toMatch(/acceptance after rework/);
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).toMatch(/closed as complete/);
    bus.dispose();
  });

  it('gives a rework asked for after a close to the assignment that asked for it', async () => {
    const { tools, bus, handleOf, ask } = crew();
    const handle = handleOf(await tools.run('assign_task', { agent: 'dev', instruction: 'the job' }));
    const rework = async () => {
      await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Quote the output.' });
      bus.send('dev', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
      await later();
    };
    // Asked for after the close and before the person's next request: the close did not cover it.
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    await rework();
    ask();
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, ...undecided });

    // Asked for in a later assignment, of a result an earlier close did cover.
    await tools.run('record_task_disposition', { handle, disposition: 'deferred', reason: 'Later.' });
    expect(await tools.run('close_assignment', stillRunning)).toMatch(/closed as partial/);
    ask();
    expect(tools.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: false, recordedDispositionCount: 0, latestDispositions: [] });
    await rework();
    const reworked = tools.coordinatorCloseoutState();
    expect(reworked).toMatchObject({ assignmentOpen: true, ...undecided });
    expect(hostAuthoredCloseout(reworked)).toBe(ONE_OWED);
    bus.dispose();
  });
});

/**
 * `complete` says that everything asked for was delivered. Work still running has delivered nothing yet, and a
 * rework reply is a new result: the `needs-rework` that asked for it is no decision on it (Codex's audit of
 * `387d74b`).
 */
describe('complete needs every result decided and nothing running', () => {
  function crew() {
    const { tools, bus } = coordinatorTools();
    const handleOf = (result: string) => /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const reply = async (handle: string, text = 'The result.') => {
      bus.send('dev', 'pm', 'task.complete', {
        instruction: text,
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false } } },
      }, 'normal', handle);
      await later();
    };
    return { tools, bus, handleOf, reply };
  }
  const notDone = (outcome: 'partial' | 'blocked') => ({
    outcome, summary: 'Not done yet.', incomplete: [{ item: 'the job', reason: 'it is still running' }],
  });

  it('refuses complete while a dispatched task runs, and takes partial and blocked', async () => {
    const { tools, bus, handleOf, reply } = crew();
    const handle = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the job' }));
    expect(tools.coordinatorCloseoutState()).toMatchObject({ hasLiveDelegationWork: true, settledButUndisposed: 0 });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: delegated work is still running, including any rework\./);
    expect(await tools.run('close_assignment', notDone('partial'))).toMatch(/closed as partial/);
    expect(await tools.run('close_assignment', notDone('blocked'))).toMatch(/closed as blocked/);

    await reply(handle);
    await tools.run('record_task_disposition', { handle, disposition: 'accepted' });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).toMatch(/closed as complete/);
    bus.dispose();
  });

  it('refuses complete while a rework runs', async () => {
    const { tools, bus, handleOf, reply } = crew();
    const handle = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the job' }));
    await reply(handle);
    await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Quote the output.' });
    // The rework request is a decision on the first result; the rework itself is running.
    expect(tools.coordinatorCloseoutState()).toMatchObject({ hasLiveDelegationWork: true, settledButUndisposed: 0 });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: delegated work is still running/);
    expect(await tools.run('close_assignment', notDone('partial'))).toMatch(/closed as partial/);
    bus.dispose();
  });

  it('owes a returned rework a decision of its own, with no close recorded, and complete waits for it', async () => {
    const { tools, bus, handleOf, reply } = crew();
    const handle = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the job' }));
    await reply(handle);
    await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Quote the output.' });
    await reply(handle, 'Reworked result.');
    const returned = tools.coordinatorCloseoutState();
    expect(returned).toMatchObject({
      assignmentOpen: true, assignmentClosed: false, hasLiveDelegationWork: false,
      settledButUndisposed: 1, recordedDispositionCount: 0, latestDispositions: [],
    });
    expect(hostAuthoredCloseout(returned)).toBe('UnodeAi: No assignment close was recorded; 1 delegation result still '
      + 'needs a decision. Review the timeline and decide whether to continue or retry.');
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);
    // The decisions so far stay in the history; the session's metrics count the result as undecided too.
    expect(await tools.run('delegation_metrics', {})).toContain('settled-but-undisposed: 1.');

    // Another round is a decision too, and its reply owes one again.
    await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'One more detail.' });
    expect(tools.coordinatorCloseoutState()).toMatchObject({ hasLiveDelegationWork: true, settledButUndisposed: 0 });
    await reply(handle, 'Reworked again.');
    expect(tools.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 1, latestDispositions: [] });

    expect(await tools.run('record_task_disposition', { handle, disposition: 'accepted-after-rework' })).toMatch(/acceptance after rework/);
    expect(tools.coordinatorCloseoutState()).toMatchObject({
      settledButUndisposed: 0, recordedDispositionCount: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'accepted-after-rework' }],
    });
    expect(hostAuthoredCloseout(tools.coordinatorCloseoutState())).toBe('');
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' })).toMatch(/closed as complete/);
    bus.dispose();
  });

  it('owes a decision on a rework that ended without a reply', async () => {
    const { tools, bus, handleOf, reply } = crew();
    const handle = handleOf(await tools.run('assign_task_async', { agent: 'dev', instruction: 'the job' }));
    await reply(handle);
    await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Quote the output.' });
    bus.send('dev', 'pm', 'system.error', { instruction: 'The rework turn failed.', metadata: { isError: true } }, 'normal', handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(tools.coordinatorCloseoutState()).toMatchObject({ hasLiveDelegationWork: false, settledButUndisposed: 1 });
    expect(await tools.run('close_assignment', { outcome: 'complete', summary: 'Done.' }))
      .toMatch(/^Error: 1 settled delegation\(s\) still have no disposition/);
    bus.dispose();
  });
});
