import { describe, expect, it } from 'vitest';
import { MAX_RUN_HANDLES, parseRequestCloseoutRecord } from '../RequestCloseout';
import { requestRunObservation, type RequestRunSource } from '../RequestRunFacts';

const run = (overrides: Partial<RequestRunSource> = {}): RequestRunSource => ({
  id: 'run-1',
  status: 'open',
  delegations: [],
  refusedDispatches: [],
  ...overrides,
});

describe('requestRunObservation', () => {
  it('counts tasks by state and names the running ones', () => {
    expect(requestRunObservation(run({
      delegations: [
        { handle: 'h-1', state: 'active' }, { handle: 'h-2', state: 'settled' }, { handle: 'h-3', state: 'cancelled' },
        { handle: 'h-4', state: 'interrupted' }, { handle: 'h-5', state: 'active' },
      ],
      refusedDispatches: [{ taskState: 'no-executor' }, { taskState: 'policy-refused' }, {}],
    }))).toEqual({
      runId: 'run-1',
      state: 'open',
      tasks: { active: 2, settled: 1, cancelled: 1, interrupted: 1 },
      refusedDispatches: 3,
      policyRefused: 1,
      handles: ['h-1', 'h-5'],
      omittedHandles: 0,
    });
  });

  it('bounds the handles and keeps their number equal to the running tasks', () => {
    const delegations = Array.from({ length: MAX_RUN_HANDLES + 6 }, (_unused, index) => ({ handle: `h-${index}`, state: 'active' as const }));
    const observed = requestRunObservation(run({ delegations }));
    expect(observed.handles).toHaveLength(MAX_RUN_HANDLES);
    expect(observed.handles.at(-1)).toBe(`h-${MAX_RUN_HANDLES + 5}`);
    expect(observed.handles.length + observed.omittedHandles).toBe(observed.tasks.active);
  });

  it('counts a handle it cannot carry, and a repeated one, without listing them twice', () => {
    const observed = requestRunObservation(run({
      delegations: [{ handle: 'h 1 with spaces', state: 'active' }, { handle: 'h-2', state: 'active' }, { handle: 'h-2', state: 'active' }],
    }));
    expect(observed).toMatchObject({ tasks: { active: 3 }, handles: ['h-2'], omittedHandles: 2 });
  });

  it('gives a value the record parser accepts', () => {
    const observed = requestRunObservation(run({ status: 'closed', delegations: [{ handle: 'h-1', state: 'settled' }] }));
    const record = parseRequestCloseoutRecord({
      schemaVersion: 1, recordId: 'request-closeout:req-1:turn-1', requestId: 'req-1', rootAgentId: 'pm',
      originTurnId: 'turn-1', terminalTurnId: 'turn-1', recordedAt: '2026-10-08T01:00:00.000Z', revision: 1,
      terminal: { kind: 'answered' }, usageUnitIds: [],
      observations: {
        changes: { coverage: 'complete', files: [], omitted: 0, droppedPaths: 0 },
        checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0 },
        approvals: { coverage: 'complete', decisions: [] },
        context: { coverage: 'complete', sources: 0, estimatedTextTokens: 0 },
        routes: { coverage: 'unavailable', agents: [], omitted: 0 },
        run: observed,
        reasoning: { visibleItems: 0 },
      },
      coverage: { events: 'complete', limited: ['tools', 'routes', 'timing'] },
    });
    expect(record?.observations.run).toEqual(observed);
  });
});
