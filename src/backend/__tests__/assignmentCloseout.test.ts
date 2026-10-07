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
  it('says the assignment ended without a conclusion, and names what was left undecided', () => {
    const text = hostAuthoredCloseout({ settledButUndisposed: 2, recordedDispositionCount: 0, acceptedButUngated: 1 });

    expect(text.startsWith('UnodeAi:')).toBe(true);
    expect(text).toMatch(/ended without a stated conclusion/);
    expect(text).toMatch(/2 delegation results still need a decision/);
    expect(text).toMatch(/1 accepted file change has no observed passing check/);
    expect(text).not.toMatch(/close_assignment|disposition|settled delegation/);
    expect(text).not.toContain('\n');
  });

  it('uses singular and plural verbs in closeout facts', () => {
    expect(hostAuthoredCloseout({ settledButUndisposed: 1, recordedDispositionCount: 0, acceptedButUngated: 0 }))
      .toMatch(/1 delegation result still needs a decision/);
    expect(hostAuthoredCloseout({ settledButUndisposed: 0, recordedDispositionCount: 0, acceptedButUngated: 2 }))
      .toMatch(/2 accepted file changes have no observed passing check/);
  });

  it('never claims the work was correct or complete, in either branch', () => {
    for (const state of [
      { settledButUndisposed: 0, recordedDispositionCount: 0, acceptedButUngated: 0 },
      { settledButUndisposed: 3, recordedDispositionCount: 0, acceptedButUngated: 0 },
    ]) {
      const text = hostAuthoredCloseout(state);
      expect(text).not.toMatch(/\bsuccessful\b|\bdone correctly\b|\bverified\b|\bcomplete\b/);
    }
    expect(hostAuthoredCloseout({ settledButUndisposed: 0, recordedDispositionCount: 0, acceptedButUngated: 0 }))
      .toMatch(/no delegation result or conclusion was recorded/);
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
      acceptedButUngated: 0,
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
        acceptedButUngated: 0,
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
        acceptedButUngated: 0,
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
      acceptedButUngated: 0,
      latestDispositions: [{ agentName: 'Dev', disposition: 'needs-rework' }],
    } as const;
    expect(hostAuthoredCloseout({
      ...rework,
      latestDispositions: [{ agentName: 'Dev', disposition: 'needs-human' }],
    })).toBe('');
  });

  it('stays silent only for accepted latest dispositions with no unverified change', () => {
    expect(hostAuthoredCloseout({
      settledButUndisposed: 0,
      recordedDispositionCount: 2,
      acceptedButUngated: 0,
      latestDispositions: [
        { agentName: 'Dev', disposition: 'accepted' },
        { agentName: 'PM', disposition: 'accepted-with-caveat' },
      ],
    })).toBe('');
    expect(hostAuthoredCloseout({
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      acceptedButUngated: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'accepted' }],
    })).not.toBe('');
    expect(hostAuthoredCloseout({
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      acceptedButUngated: 0,
      verificationNotRun: 1,
      latestDispositions: [{ agentName: 'Dev', disposition: 'accepted' }],
    })).toContain('objective check has not run');
  });

  it('reports an ungated acceptance plainly when no objective check is available', () => {
    const state = {
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      acceptedButUngated: 1,
      hasLiveDelegationWork: false,
      hasVerificationPath: false,
    };

    expect(hostAuthoredCloseout(state)).toContain('no objective check available');
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
