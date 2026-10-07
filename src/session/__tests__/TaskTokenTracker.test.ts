import { describe, it, expect } from 'vitest';
import { TaskTokenTracker } from '../TaskTokenTracker';

describe('TaskTokenTracker', () => {
  it('does NOT cross-count two user tasks running concurrently on different agents', () => {
    const t = new TaskTokenTracker();
    // Two user tasks open at the same time, each rooted on a different PM agent.
    t.startRoot('PM_A', 'task A');
    t.startRoot('PM_B', 'task B');

    // Task A: PM_A does a turn, then delegates to Dev (Dev inherits task A).
    t.attribute('PM_A', 'PM-A', 10, 20, 0.001);
    t.startInherited('Dev', 'PM_A');
    t.attribute('Dev', 'Dev', 100, 200, 0.01);
    expect(t.endTurn('Dev')).toBeUndefined(); // Dev is not a root → no record yet

    // Task B: PM_B does a turn (concurrently).
    t.attribute('PM_B', 'PM-B', 5, 5, 0.0005);

    // Finalize B first, then A.
    const recB = t.endTurn('PM_B')!;
    const recA = t.endTurn('PM_A')!;

    // Task B counts ONLY PM_B — not PM_A's or Dev's tokens (the old all-sessions diff double-counted).
    expect(recB.agents.map((a) => a.name)).toEqual(['PM-B']);
    expect(recB.totalTokens).toBe(10);

    // Task A counts PM_A + Dev (its real participants), and NOT PM_B.
    expect(recA.agents.map((a) => a.name).sort()).toEqual(['Dev', 'PM-A']);
    expect(recA.agents.find((a) => a.name === 'PM-B')).toBeUndefined();
    expect(recA.totalTokens).toBe(330); // 10+20 + 100+200
    expect(recA.agents[0].name).toBe('Dev'); // sorted by token spend, Dev first
  });

  it('still counts an async delegation that finishes AFTER the root (PM) turn ends', () => {
    const t = new TaskTokenTracker();
    t.startRoot('PM', 'task');
    t.attribute('PM', 'PM', 10, 10, 0.001);
    // PM dispatches assign_task_async to a worker, then its own turn ends WITHOUT awaiting.
    t.startInherited('W', 'PM');
    expect(t.endTurn('PM')).toBeUndefined(); // root ended, but the worker is still active → not finalized
    // The worker finishes later.
    t.attribute('W', 'Worker', 100, 200, 0.02);
    const rec = t.endTurn('W')!;
    expect(rec).toBeDefined(); // now finalized
    expect(rec.agents.map((a) => a.name).sort()).toEqual(['PM', 'Worker']);
    expect(rec.totalTokens).toBe(320); // worker's 300 was NOT dropped
  });

  it('counts an async delegation to a STOPPED worker that starts after the PM finishes (dispatch-time binding)', () => {
    const t = new TaskTokenTracker();
    t.startRoot('PM', 'task');
    t.attribute('PM', 'PM', 10, 10, 0.001);
    // PM async-dispatches to a STOPPED worker: bind at DISPATCH (markPending reserves a slot), but the
    // worker's turn hasn't started yet — it's queued.
    const taskId = t.taskIdOf('PM')!;
    t.markPending(taskId);
    expect(t.endTurn('PM')).toBeUndefined(); // PM finishes; the dispatched worker is still pending → not finalized
    // The worker starts LATER and inherits by the EXPLICIT task id captured at dispatch (PM's tag is gone).
    t.startInheritedByTask('W', taskId);
    t.attribute('W', 'Worker', 100, 200, 0.02);
    const rec = t.endTurn('W')!;
    expect(rec.agents.map((a) => a.name).sort()).toEqual(['PM', 'Worker']);
    expect(rec.totalTokens).toBe(320); // the queued worker's 300 tokens were NOT dropped
  });

  it('releases a reserved slot when a dispatched worker never runs (cancelPending)', () => {
    const t = new TaskTokenTracker();
    t.startRoot('PM', 'task');
    t.attribute('PM', 'PM', 5, 5, 0);
    const taskId = t.taskIdOf('PM')!;
    t.markPending(taskId);                 // dispatched to a worker…
    expect(t.endTurn('PM')).toBeUndefined(); // …PM ends, worker still pending
    const rec = t.cancelPending(taskId)!;  // worker removed before running → release the slot
    expect(rec.agents.map((a) => a.name)).toEqual(['PM']); // task finalizes with just the PM
  });

  it('accumulates multiple turns by the same agent within a task', () => {
    const t = new TaskTokenTracker();
    t.startRoot('S', 'task');
    t.attribute('S', 'Solo', 10, 10, 0.001);
    t.startInherited('W', 'S');
    t.attribute('W', 'Worker', 50, 50, 0.005);
    t.endTurn('W');
    // Worker delegated again in the same task.
    t.startInherited('W', 'S');
    t.attribute('W', 'Worker', 30, 20, 0.003);
    t.endTurn('W');
    const rec = t.endTurn('S')!;
    const worker = rec.agents.find((a) => a.name === 'Worker')!;
    expect(worker.inputTokens).toBe(80);
    expect(worker.outputTokens).toBe(70);
  });

  it('ignores a delegated turn whose delegator has no open task', () => {
    const t = new TaskTokenTracker();
    t.startInherited('B', 'A'); // A never rooted a task
    t.attribute('B', 'B', 100, 100, 0.01);
    expect(t.endTurn('B')).toBeUndefined();
    expect(t.recent(10)).toEqual([]);
  });

  it('returns recent tasks newest-first and honors the cap', () => {
    const t = new TaskTokenTracker(2); // cap 2
    for (const name of ['t1', 't2', 't3']) {
      t.startRoot(name, name);
      t.attribute(name, name, 1, 1, 0);
      t.endTurn(name);
    }
    expect(t.recent(10).map((r) => r.title)).toEqual(['t3', 't2']); // t1 evicted, newest first
  });

  it('drops an open task when its root session is removed', () => {
    const t = new TaskTokenTracker();
    t.startRoot('S', 'task');
    t.attribute('S', 'Solo', 5, 5, 0);
    t.removeSession('S');
    expect(t.endTurn('S')).toBeUndefined(); // task is gone, nothing finalized
    expect(t.recent(10)).toEqual([]);
  });

  it('attributes human approval wait and denials to the requesting task, not another concurrent task', () => {
    const t = new TaskTokenTracker();
    t.startRoot('PM_A', 'task A');
    t.startRoot('PM_B', 'task B');
    t.recordApproval('PM_A', 1_275, true);
    t.recordApproval('PM_A', 250, false);
    t.attribute('PM_A', 'PM A', 1, 1, 0);
    t.attribute('PM_B', 'PM B', 1, 1, 0);

    const b = t.endTurn('PM_B')!;
    const a = t.endTurn('PM_A')!;
    expect(a).toMatchObject({ approvalWaitMs: 1_525, approvalDenials: 1 });
    expect(b).toMatchObject({ approvalWaitMs: 0, approvalDenials: 0 });
  });

  it('keeps an approval-only task measurable when a backend did not report tokens', () => {
    const t = new TaskTokenTracker();
    t.startRoot('PM', 'needs consent');
    t.recordApproval('PM', 500, true);

    expect(t.endTurn('PM')).toMatchObject({ totalTokens: 0, approvalWaitMs: 500, approvalDenials: 1 });
  });
});
