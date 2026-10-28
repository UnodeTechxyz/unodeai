import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TeamTools,
  type DelegationExecutionObservation,
  type TeamRosterEntry,
  type TeamToolsOptions,
  type TeamView,
} from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import { RunLedger } from '../../observability/RunLedger';

/*
 * v0.9.97 L0: a long task's wait, its execution and its delivery are three facts, each bound to the task's own
 * handle. Field incident (2026-10-19): a delegated Claude task's wait timed out, the user had it cancelled, the
 * same agent was later running a new direct-user turn, and the coordinator then read the agent-wide `running` as
 * the old handle's state, could not record a decision on the old handle after its tools were rebuilt, and a stop
 * of a handle could end whatever turn the agent was in.
 *
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 6).
 */

function taskContract(): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Draft the article.',
    expected_deliverable: 'Return the draft.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
  };
}

const TIMEOUT_MS = 100;
/** The late window is two further wait windows. */
const LATE_WINDOW_MS = TIMEOUT_MS * 2;

interface Harness {
  bus: MessageBus;
  ledger: RunLedger;
  resolver: TaskInputResolver;
  roster: TeamRosterEntry[];
  /** What the host reports for (agent, handle); `undefined` leaves the host without an execution view. */
  executions: Map<string, DelegationExecutionObservation>;
  cancelled: Array<{ handle: string; agentId: string }>;
  hostCancel: { reach: boolean };
  stopTeammate: ReturnType<typeof vi.fn>;
  woke: ReturnType<typeof vi.fn>;
  evidence: Array<{ handle: string; outcome: string; executionEnded?: boolean }>;
  tools(options?: TeamToolsOptions, withExecutionView?: boolean): TeamTools;
}

function harness(): Harness {
  const bus = new MessageBus();
  const ledger = new RunLedger();
  const resolver = new TaskInputResolver(new ContentAssetStore(), process.cwd());
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'idle' },
  ];
  const executions = new Map<string, DelegationExecutionObservation>();
  const cancelled: Array<{ handle: string; agentId: string }> = [];
  const hostCancel = { reach: true };
  const stopTeammate = vi.fn(() => true);
  const woke = vi.fn(() => true);
  const evidence: Harness['evidence'] = [];
  const h: Harness = {
    bus, ledger, resolver, roster, executions, cancelled, hostCancel, stopTeammate, woke, evidence,
    tools(options = {}, withExecutionView = true) {
      const view: TeamView = {
        list: () => roster,
        resolve: (ref) => roster.find((entry) => entry.id === ref || entry.name === ref) ? { id: roster.find((entry) => entry.id === ref || entry.name === ref)!.id } : undefined,
        preflightTaskScope: () => undefined,
        ...(withExecutionView
          ? { execution: (agentId: string, handle: string) => executions.get(`${agentId}:${handle}`) ?? { state: 'not-running' as const } }
          : {}),
      };
      return new TeamTools('pm', view, bus, {
        timeoutMs: TIMEOUT_MS,
        evidenceEnabled: true,
        cwd: process.cwd(),
        taskInputResolver: resolver,
        onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'root-turn' }),
        onDelegationEvidence: (event) => {
          evidence.push({ handle: event.handle, outcome: event.outcome, executionEnded: event.executionEnded });
          ledger.recordDelegationEvidence(event);
        },
        onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
        onDelegationInterrupted: (event) => ledger.recordDelegationInterrupted(event),
        onDelegationDisposition: (event) => ledger.recordDisposition(event),
        inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
        cancelDelegatedWorker: (event) => {
          cancelled.push({ handle: event.handle, agentId: event.agentId });
          return hostCancel.reach;
        },
        stopTeammate,
        onAsyncResultReady: woke,
        ...options,
      });
    },
  };
  return h;
}

async function dispatch(h: Harness, team: TeamTools): Promise<{ handle: string; assignment: Message }> {
  let assignment: Message | undefined;
  const off = h.bus.onType('task.assign', (message) => { assignment = message; });
  const out = await team.run('dispatch_task', { agent: 'writer', instruction: 'Draft the article.', contract: taskContract() });
  off();
  const handle = out.match(/Handle: ([0-9a-f-]+)/i)?.[1];
  if (!handle || !assignment) throw new Error(`dispatch failed: ${out}`);
  // The assignment is what the host would now be running for this agent.
  h.executions.set(`writer:${handle}`, { state: 'running' });
  return { handle, assignment };
}

function recorded(h: Harness, handle: string) {
  return h.ledger.snapshot().flatMap((run) => run.delegations).find((delegation) => delegation.handle === handle)!;
}

describe('a long task attempt: wait, execution and delivery stay separate and bound to its handle (L0)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // §6: "等待超时不是执行已终止，也不是完成" - a wait timeout is neither the end of execution nor completion.
  it('records a wait timeout without ending the attempt, so a later cancellation is still recorded', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(recorded(h, handle)).toMatchObject({ state: 'active', evidence: { outcome: 'timed-out' } });
    expect(h.evidence.at(-1)).toMatchObject({ handle, outcome: 'timed-out', executionEnded: false });

    await team.run('cancel_task', { handle, reason: 'The user asked to stop.' });
    // The timeout fact stays; the cancellation is now on the record instead of being dropped by a settled row.
    expect(recorded(h, handle)).toMatchObject({ state: 'cancelled', evidence: { outcome: 'timed-out' } });
  });

  // §6: "soft wait timeout 只结束该次等待 ... 明确显示'仍在执行'或'执行状态未知'".
  it('says a timed-out wait ended only the wait and names what the host knows of the execution', async () => {
    const h = harness();
    const team = h.tools();
    let handle = '';
    h.bus.onType('task.assign', (message) => {
      handle = message.correlationId!;
      h.executions.set(`writer:${handle}`, { state: 'running' });
    });
    const waiting = team.run('assign_task', { agent: 'writer', instruction: 'Draft it.' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const out = await waiting;
    expect(out).toMatch(/timed out after 0s waiting for writer/);
    expect(out).toContain('ended only the wait');
    expect(out).toContain('still running');
    expect(out).not.toMatch(/\bcompleted?\b/i);
    team.cancelPending('test cleanup');

    const blind = harness();
    const unseen = blind.tools({}, false);
    const waitingBlind = unseen.run('assign_task', { agent: 'writer', instruction: 'Draft it.' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await waitingBlind).toContain('execution state is unknown');
    unseen.cancelPending('test cleanup');
  });

  // §6: "旧 handle 不得借用当前 roster 的 running".
  it('never shows the teammate-wide running of a later turn as the old handle\'s state', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + LATE_WINDOW_MS);
    // The old attempt is gone from the host, and the same agent now runs a new direct-user turn.
    h.executions.set(`writer:${handle}`, { state: 'not-running' });
    h.roster[1].status = 'running';

    const status = await team.run('inspect_task_status', { handles: [handle] });
    expect(status).toContain('wait state: timed-out-window-expired');
    expect(status).toContain('execution state: not running');
    expect(status).toContain('teammate activity: busy, not with this task');
    expect(status).not.toMatch(/worker state: running/);
    expect(status).not.toMatch(/execution state: running/);
  });

  // §6: "没有新终态事实不能把 unknown 渲染成 stopped".
  it('renders an execution the host cannot observe as unknown, never as running or stopped', async () => {
    const h = harness();
    const team = h.tools({}, false);
    const { handle } = await dispatch(h, team);
    h.roster[1].status = 'running';
    const live = await team.run('inspect_task_status', { handles: [handle] });
    expect(live).toContain('execution state: unknown');
    expect(live).toContain('teammate activity: running (agent-wide; this task cannot be told apart)');

    await team.run('cancel_task', { handle });
    const afterCancel = await team.run('inspect_task_status', { handles: [handle] });
    expect(afterCancel).toContain('execution state: unknown');
    expect(afterCancel).not.toContain('execution state: stopped');
  });

  // §6: "cancel(handle) 只停止这个 attempt；无匹配运行实例就如实说明，不杀同 agent 后来的 turn".
  it('cancels only the handle\'s own attempt and never stops a later turn of the same teammate', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    // The host finds no running or queued instance of this handle: the agent is in another turn.
    h.hostCancel.reach = false;
    h.executions.set(`writer:${handle}`, { state: 'not-running' });
    h.roster[1].status = 'running';

    const out = await team.run('cancel_task', { handle, reason: 'Stop the old draft.' });
    expect(h.cancelled).toEqual([{ handle, agentId: 'writer' }]);
    expect(h.stopTeammate).not.toHaveBeenCalled();
    expect(out).toContain('found no running or queued instance');
    expect(out).toContain('nothing was stopped');
    expect(out).not.toContain('stopped its teammate');
  });

  it('reports a reached cancellation as a stop under way, not as a confirmed stop', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    // The host's cancellation reaches the running turn; the stop of its process is still under way.
    h.executions.set(`writer:${handle}`, { state: 'stopping' });

    const out = await team.run('cancel_task', { handle });
    expect(h.stopTeammate).not.toHaveBeenCalled();
    expect(out).toContain(`Cancelled ${handle}`);
    expect(out).toContain('its stop is not confirmed yet');
    expect(out).not.toMatch(/turn is ended/);
  });

  // §6: "late window 结束不能丢执行所有权/停止能力".
  it('keeps the ability to stop the attempt after its late-result window has closed', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + LATE_WINDOW_MS);
    expect(await team.run('inspect_task_status', { handles: [handle] })).toContain('wait state: timed-out-window-expired');

    const out = await team.run('cancel_task', { handle, reason: 'User stop.' });
    expect(h.cancelled).toEqual([{ handle, agentId: 'writer' }]);
    expect(out).toContain(`Cancelled ${handle}`);
    expect(recorded(h, handle)).toMatchObject({ state: 'cancelled', evidence: { outcome: 'timed-out' } });
  });

  // §6: "late window 结束不能丢执行所有权" - the coordinator's own Stop (cancelPending) still reaches the attempt.
  it('keeps the attempt in the coordinator\'s Stop and cancel_task all after its late window closed', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + LATE_WINDOW_MS);

    expect(team.cancelPending('The user pressed Stop.')).toBe(1);
    expect(h.cancelled).toEqual([{ handle, agentId: 'writer' }]);
    expect(recorded(h, handle)).toMatchObject({ state: 'cancelled', evidence: { outcome: 'timed-out' } });
  });

  // §6: "已被取消的输出永不自动完成任务、发布最终工件、发送用户消息、开始下一次 turn 或覆盖新任务结果".
  it('records a reply that arrives after the window closed as the attempt\'s end, and delivers nothing', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + LATE_WINDOW_MS);
    const messagesToPm = () => h.bus.query().filter((message) => message.to === 'pm' && message.type !== 'task.complete').length;
    const before = messagesToPm();

    h.bus.send('writer', 'pm', 'task.complete', { instruction: 'The whole late article.' }, 'normal', handle);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.woke).not.toHaveBeenCalled();
    expect(await team.run('collect_ready_tasks', {})).toMatch(/No delegated result is ready/);
    expect(messagesToPm()).toBe(before);
    expect(h.evidence.at(-1)).toMatchObject({ handle, outcome: 'timed-out', executionEnded: true });
    expect(recorded(h, handle)).toMatchObject({ state: 'settled', evidence: { outcome: 'timed-out' } });
    expect(recorded(h, handle).delivery?.state).not.toBe('delivered');
    // Its end is now observed: the coordinator is no longer told the attempt may still be stoppable.
    expect(await team.run('cancel_task', { handle })).toMatch(/already terminal/);
  });

  it('never lets a cancelled attempt\'s late reply complete it, wake the coordinator or replace a newer result', async () => {
    const h = harness();
    const team = h.tools();
    const first = await dispatch(h, team);
    await team.run('cancel_task', { handle: first.handle });
    const second = await dispatch(h, team);
    h.bus.send('writer', 'pm', 'task.complete', { instruction: 'Newer result.' }, 'normal', second.handle);
    await vi.advanceTimersByTimeAsync(0);
    h.woke.mockClear();

    h.bus.send('writer', 'pm', 'task.complete', { instruction: 'Late reply of the cancelled attempt.' }, 'normal', first.handle);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.woke).not.toHaveBeenCalled();
    expect(recorded(h, first.handle).state).toBe('cancelled');
    const collected = await team.run('collect_ready_tasks', {});
    expect(collected).toContain('Newer result.');
    expect(collected).not.toContain('Late reply of the cancelled attempt.');
  });

  // §6: "仍运行的不得用 deferred 伪装为停止".
  it('refuses a disposition while the timed-out attempt is still running', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    const out = await team.run('record_task_disposition', { handle, disposition: 'deferred', reason: 'Decide later.' });
    expect(out).toMatch(/^Error: .*still running/);
    expect(recorded(h, handle).dispositions).toEqual([]);

    await vi.advanceTimersByTimeAsync(LATE_WINDOW_MS);
    expect(await team.run('record_task_disposition', { handle, disposition: 'deferred', reason: 'Decide later.' }))
      .toMatch(/^Error: .*still running/);
    expect(recorded(h, handle).dispositions).toEqual([]);
  });

  // §6: "host 重建后不因内存记录丢失就拒绝已持久确定的终态。修改处置不改变原始超时事实".
  it('lets rebuilt team tools record a decision on a persisted, ended timed-out attempt, keeping the timeout fact', async () => {
    const h = harness();
    const original = h.tools();
    const { handle } = await dispatch(h, original);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await original.run('cancel_task', { handle, reason: 'User stop.' });
    expect(recorded(h, handle).state).toBe('cancelled');

    // The coordinator's tools are rebuilt: nothing of the first instance's memory is available.
    const rebuilt = h.tools();
    h.executions.set(`writer:${handle}`, { state: 'stopped' });
    const out = await rebuilt.run('record_task_disposition', {
      handle, disposition: 'deferred', reason: 'Re-dispatched as a narrower task.',
    });
    expect(out).toContain(`Recorded deferred for ${handle}`);
    expect(recorded(h, handle)).toMatchObject({
      state: 'cancelled',
      evidence: { outcome: 'timed-out' },
      dispositions: [expect.objectContaining({ disposition: 'deferred', outcome: 'timed-out' })],
    });
    expect(await rebuilt.run('inspect_task_status', { handles: [handle] }))
      .toMatch(/state: timed-out[\s\S]*execution state: stopped[\s\S]*evidence: timed-out[\s\S]*disposition: deferred/);
  });

  it('after a rebuild, neither disposes nor calls terminal a persisted attempt the host still runs, and can stop it', async () => {
    const h = harness();
    const original = h.tools();
    const { handle } = await dispatch(h, original);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(recorded(h, handle).state).toBe('active');

    const rebuilt = h.tools();
    expect(await rebuilt.run('record_task_disposition', { handle, disposition: 'deferred', reason: 'Later.' }))
      .toMatch(/^Error: .*still running/);
    const out = await rebuilt.run('cancel_task', { handle, reason: 'User stop.' });
    expect(out).not.toMatch(/already terminal|Nothing is running/);
    expect(h.cancelled).toContainEqual({ handle, agentId: 'writer' });
    expect(recorded(h, handle).state).toBe('cancelled');
    expect(h.stopTeammate).not.toHaveBeenCalled();
    original.cancelPending('test cleanup');
  });

  it('keeps refusing a decision on a cancellation that never had a result, with the real reason', async () => {
    const h = harness();
    const original = h.tools();
    const { handle } = await dispatch(h, original);
    await original.run('cancel_task', { handle });
    const rebuilt = h.tools();
    expect(await rebuilt.run('record_task_disposition', { handle, disposition: 'deferred', reason: 'Later.' }))
      .toMatch(/^Error: .*cancelled before any result/);
  });

  // §6: "停止请求先使效果授权失效" - the field CLI's publish_task_artifact after Stop must be refused by the host.
  it('refuses a late artifact from a cancelled attempt, and from one whose late window closed', async () => {
    const h = harness();
    const team = h.tools();
    const first = await dispatch(h, team);
    const firstAttempt = first.assignment.payload.taskAttempt!.attemptId;
    expect(h.resolver.isAttemptLive(firstAttempt, 'writer')).toBe(true);
    await team.run('cancel_task', { handle: first.handle });
    expect(await h.resolver.publishArtifact(firstAttempt, 'writer', 'The whole late article.'))
      .toEqual({ error: 'no live task attempt can publish this artifact' });

    const second = await dispatch(h, team);
    const secondAttempt = second.assignment.payload.taskAttempt!.attemptId;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(h.resolver.isAttemptLive(secondAttempt, 'writer')).toBe(true);
    await vi.advanceTimersByTimeAsync(LATE_WINDOW_MS);
    expect(await h.resolver.publishArtifact(secondAttempt, 'writer', 'The whole late article.'))
      .toEqual({ error: 'no live task attempt can publish this artifact' });
    team.cancelPending('test cleanup');
  });

  it('settles an interruption that arrives after the wait timed out, instead of leaving the attempt owned forever', async () => {
    const h = harness();
    const team = h.tools();
    const { handle } = await dispatch(h, team);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    h.bus.send('writer', 'pm', 'system.error', {
      instruction: 'Worker session stopped before a terminal result was observed.',
      metadata: { interrupted: true, interruptionReason: 'worker-lost', detectedAt: '2026-10-19T04:30:00.000Z' },
    }, 'normal', handle);
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded(h, handle).state).toBe('interrupted');
    expect(await team.run('cancel_task', { handle })).toMatch(/already terminal/);
  });
});
