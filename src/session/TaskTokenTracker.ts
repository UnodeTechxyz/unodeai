/*---------------------------------------------------------------------------------------------
 *  TaskTokenTracker — attributes token usage to the user task that caused it, broken down by agent.
 *
 *  A "task" is rooted at the session that received a user turn (`from: 'user'`). A delegated turn
 *  INHERITS the task of the agent that delegated it, so a turn's tokens always land on the right task —
 *  even when two user tasks run concurrently on different agents (no cross-task double-counting). The
 *  root session's turn completing means the whole orchestration (root + everything it delegated) is done,
 *  so the per-task record is finalized then.
 *--------------------------------------------------------------------------------------------*/

/** One user-initiated task's token spend, broken down by the agents that participated. */
export interface TaskTokenRecord {
  id: string;
  title: string;
  startedAt: string;
  finishedAt: string;
  agents: Array<{ agentId: string; name: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  totalTokens: number;
  totalCostUsd: number;
  /** Time a human approval surface held this task, measured in the extension host. */
  approvalWaitMs: number;
  /** Explicit denials and timed-out approval windows; an approval is one human intervention. */
  approvalDenials: number;
}

interface OpenTask {
  rootSessionId: string;
  title: string;
  startedAt: string;
  perAgent: Map<string, { name: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  /** In-flight turns tagged with this task (root + inherited). Finalize only when this reaches 0 AND the
   *  root has ended — so an async delegation (assign_task_async) that outlives the PM's turn is still counted. */
  active: number;
  rootEnded: boolean;
  approvalWaitMs: number;
  approvalDenials: number;
}

export class TaskTokenTracker {
  private log: TaskTokenRecord[] = [];
  private open = new Map<string, OpenTask>();
  /** sessionId → the task id its in-flight turn belongs to (its own root task or an inherited one). */
  private current = new Map<string, string>();
  private seq = 0;

  constructor(private readonly max = 50, private readonly clock: () => number = () => Date.now()) {}

  /** A user turn roots a NEW task on `sessionId`. */
  startRoot(sessionId: string, title: string): void {
    const taskId = `task-${this.clock()}-${++this.seq}`;
    this.open.set(taskId, {
      rootSessionId: sessionId,
      title,
      startedAt: new Date(this.clock()).toISOString(),
      perAgent: new Map(),
      active: 1,
      rootEnded: false,
      approvalWaitMs: 0,
      approvalDenials: 0,
    });
    this.current.set(sessionId, taskId);
  }

  /** The task id a session's in-flight turn belongs to — used to bind a delegation to its root task at
   *  DISPATCH time (the delegator is still in its turn then), so a queued/async worker inherits correctly. */
  taskIdOf(sessionId: string): string | undefined {
    return this.current.get(sessionId);
  }

  /** Reserve an active slot for a turn that has been DISPATCHED but not started yet (e.g. an async
   *  delegation queued for a stopped worker). This keeps the root task from finalizing while a dispatched
   *  worker is still pending — balanced by the later endTurn (or cancelPending if the worker never runs). */
  markPending(taskId: string): void {
    const t = this.open.get(taskId);
    if (t) { t.active += 1; }
  }

  /** Release a reserved slot for a dispatched turn that will never run (e.g. the worker was removed). */
  cancelPending(taskId: string): TaskTokenRecord | undefined {
    const t = this.open.get(taskId);
    if (!t) { return undefined; }
    t.active = Math.max(0, t.active - 1);
    return t.rootEnded && t.active === 0 ? this.finalize(taskId, t) : undefined;
  }

  /** Bind a (possibly previously-queued) delegated turn to the explicit task id captured at dispatch. Sets
   *  the current tag WITHOUT incrementing active — markPending already reserved the slot at dispatch. */
  startInheritedByTask(sessionId: string, taskId: string | undefined): void {
    if (taskId && this.open.has(taskId)) { this.current.set(sessionId, taskId); } else { this.current.delete(sessionId); }
  }

  /** Immediate (synchronous) inherit: reserve the slot AND bind the session in one step. */
  startInherited(sessionId: string, delegatorSessionId: string): void {
    const taskId = this.current.get(delegatorSessionId);
    if (taskId && this.open.has(taskId)) {
      this.markPending(taskId);
      this.startInheritedByTask(sessionId, taskId);
    } else {
      this.current.delete(sessionId);
    }
  }

  /** Add one completed turn's usage to the task `sessionId` is working on, under that agent. */
  attribute(sessionId: string, name: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    const taskId = this.current.get(sessionId);
    const task = taskId ? this.open.get(taskId) : undefined;
    if (!task) { return; }
    const agg = task.perAgent.get(sessionId) ?? { name, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    agg.inputTokens += inputTokens;
    agg.outputTokens += outputTokens;
    agg.costUsd += costUsd;
    task.perAgent.set(sessionId, agg);
  }

  /** Attribute one completed human approval wait to the user task the requesting session belongs to. */
  recordApproval(sessionId: string, waitMs: number, denied: boolean): void {
    const taskId = this.current.get(sessionId);
    const task = taskId ? this.open.get(taskId) : undefined;
    if (!task) { return; }
    task.approvalWaitMs += Math.max(0, Math.round(Number.isFinite(waitMs) ? waitMs : 0));
    if (denied) { task.approvalDenials += 1; }
  }

  /** End `sessionId`'s current turn. If that session ROOTS the task, the orchestration is finished →
   *  finalize and return the record (else undefined). */
  endTurn(sessionId: string): TaskTokenRecord | undefined {
    const taskId = this.current.get(sessionId);
    this.current.delete(sessionId);
    if (!taskId) { return undefined; }
    const task = this.open.get(taskId);
    if (!task) { return undefined; }
    task.active = Math.max(0, task.active - 1);
    if (sessionId === task.rootSessionId) { task.rootEnded = true; }
    // Finalize only once the root has ended AND no inherited turns are still running. This keeps an async
    // delegation that finishes AFTER the PM's turn (assign_task_async without await) in the record.
    return task.rootEnded && task.active === 0 ? this.finalize(taskId, task) : undefined;
  }

  /** Drop a removed session's in-flight tag and any task it roots, so nothing leaks or mis-attributes. A
   *  removed NON-root participant decrements its task's active count so the root can still finalize later. */
  removeSession(sessionId: string): void {
    const taskId = this.current.get(sessionId);
    this.current.delete(sessionId);
    if (taskId) {
      const t = this.open.get(taskId);
      if (t && t.rootSessionId !== sessionId) { t.active = Math.max(0, t.active - 1); }
    }
    for (const [tid, t] of [...this.open]) {
      if (t.rootSessionId === sessionId) { this.open.delete(tid); } // removed root can't complete → discard
    }
  }

  /** Most recent finalized tasks, newest first. */
  recent(limit: number): TaskTokenRecord[] {
    const n = Math.max(0, Math.floor(limit));
    return this.log.slice(-n).reverse();
  }

  private finalize(taskId: string, task: OpenTask): TaskTokenRecord | undefined {
    this.open.delete(taskId);
    const agents = [...task.perAgent.entries()]
      .map(([agentId, a]) => ({ agentId, name: a.name, inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd }))
      .filter((a) => a.inputTokens + a.outputTokens > 0)
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
    if (agents.length === 0 && task.approvalWaitMs === 0 && task.approvalDenials === 0) {
      return undefined; // nothing measurable (e.g. usage not reported by gateway)
    }
    const record: TaskTokenRecord = {
      id: taskId,
      title: task.title || '(task)',
      startedAt: task.startedAt,
      finishedAt: new Date(this.clock()).toISOString(),
      agents,
      totalTokens: agents.reduce((sum, a) => sum + a.inputTokens + a.outputTokens, 0),
      totalCostUsd: agents.reduce((sum, a) => sum + a.costUsd, 0),
      approvalWaitMs: task.approvalWaitMs,
      approvalDenials: task.approvalDenials,
    };
    this.log.push(record);
    if (this.log.length > this.max) { this.log.shift(); }
    return record;
  }
}
