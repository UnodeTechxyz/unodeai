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

    expect(text).toMatch(/written by UnodeAi, not by the coordinator/);
    expect(text).toMatch(/ended without a stated conclusion/);
    expect(text).toMatch(/2 settled delegation\(s\) with no recorded decision/);
    expect(text).toMatch(/1 accepted file-changing result\(s\) with no observed passing check/);
    expect(text).toMatch(/close_assignment/);
  });

  it('never claims the work was correct or complete, in either branch', () => {
    for (const state of [
      { settledButUndisposed: 0, recordedDispositionCount: 0, acceptedButUngated: 0 },
      { settledButUndisposed: 3, recordedDispositionCount: 0, acceptedButUngated: 0 },
    ]) {
      const text = hostAuthoredCloseout(state);
      expect(text).toMatch(/makes no claim about whether the work is correct or/);
      expect(text).not.toMatch(/\bsuccessful\b|\bdone correctly\b|\bverified\b/);
    }
    expect(hostAuthoredCloseout({ settledButUndisposed: 0, recordedDispositionCount: 0, acceptedButUngated: 0 }))
      .toMatch(/No settled delegation result was observed/);
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
    expect(text).toMatch(/recorded decisions for 1 settled delegation/);
    expect(text).toMatch(/did not formally close the assignment/);
    expect(text).not.toMatch(/stopped before saying so|without a stated conclusion or any recorded delegation decision/);
  });

  it('reports an ungated acceptance plainly when no objective check is available', () => {
    const state = {
      settledButUndisposed: 0,
      recordedDispositionCount: 1,
      acceptedButUngated: 1,
      hasLiveDelegationWork: false,
      hasVerificationPath: false,
    };

    expect(hostAuthoredCloseout(state)).toContain('no objective check available in this project');
  });
});
