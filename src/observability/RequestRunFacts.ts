/*---------------------------------------------------------------------------------------------
 *  UnodeAi - request run facts (v0.9.94)
 *  What a request closeout says about the coordinated run its turn belongs to: the run's state and its
 *  tasks by state. A pure reading of one run record; it changes nothing and takes no text of a task.
 *--------------------------------------------------------------------------------------------*/
import type { RequestRunObservation } from './RequestCloseout';
import { MAX_REQUEST_COUNT, MAX_RUN_HANDLES, boundedObservations } from './RequestCloseoutBounds';

const HANDLE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The fields of a run this reads. A run record has them; a test can give just these. */
export interface RequestRunSource {
  id: string;
  status: 'open' | 'closed';
  delegations: ReadonlyArray<{ handle: string; state: 'active' | 'settled' | 'cancelled' | 'interrupted' }>;
  refusedDispatches: ReadonlyArray<{ taskState?: 'no-executor' | 'policy-refused' }>;
}

export function requestRunObservation(run: RequestRunSource): RequestRunObservation {
  const tasks = { active: 0, settled: 0, cancelled: 0, interrupted: 0 };
  const running: string[] = [];
  for (const delegation of run.delegations) {
    tasks[delegation.state] = Math.min(MAX_REQUEST_COUNT, tasks[delegation.state] + 1);
    // A handle the record could not carry is counted with the tasks that are not listed.
    if (delegation.state === 'active' && HANDLE.test(delegation.handle) && !running.includes(delegation.handle)) running.push(delegation.handle);
  }
  // The handles name the tasks that run, one each. A repeated handle is counted as a task and listed once.
  const handles = boundedObservations(running, MAX_RUN_HANDLES);
  return {
    runId: run.id,
    state: run.status,
    tasks,
    refusedDispatches: Math.min(MAX_REQUEST_COUNT, run.refusedDispatches.length),
    policyRefused: Math.min(MAX_REQUEST_COUNT, run.refusedDispatches.filter((refusal) => refusal.taskState === 'policy-refused').length),
    handles: handles.kept,
    omittedHandles: tasks.active - handles.kept.length,
  };
}
