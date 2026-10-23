import { describe, expect, it } from 'vitest';
import {
  FIRST_ACTION_SILENCE_BUDGET_MS, FirstActionGuard, firstActionToolOf,
} from '../FirstActionGuard';
import { TurnTimingTracker } from '../TurnTiming';

describe('FirstActionGuard', () => {
  it('is off until a coordinator turn arms it, and then expires on one silence of the budget', () => {
    const guard = new FirstActionGuard();
    expect(guard.state).toBe('off');
    expect(guard.expireIfSilent(10 * FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);

    guard.arm();
    expect(guard.state).toBe('armed');
    // No request has been sent yet, and a silence one millisecond short of the budget is not the budget.
    expect(guard.expireIfSilent(undefined)).toBe(false);
    expect(guard.expireIfSilent(FIRST_ACTION_SILENCE_BUDGET_MS - 1)).toBe(false);
    expect(guard.expireIfSilent(FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(true);
    expect(guard.state).toBe('expired');
    // It fires once.
    expect(guard.expireIfSilent(2 * FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);
  });

  it('takes an accepted dispatch or an accepted close as the first action', () => {
    for (const [tool, kind] of [['dispatch_task', 'delegation-accepted'], ['close_assignment', 'assignment-closed']] as const) {
      const guard = new FirstActionGuard();
      guard.arm();
      expect(guard.callArrived()).toBe(true);
      expect(guard.state).toBe('candidate');
      // The provider has acted; however long the host takes to decide, nothing expires.
      expect(guard.expireIfSilent(10 * FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);
      expect(guard.callAnswered(tool, true)).toBe(kind);
      expect(guard.state).toBe('satisfied');
      // After the first action the guard is done with the turn: no deadline, and a later call is not a first one.
      expect(guard.expireIfSilent(10 * FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);
      expect(guard.callArrived()).toBe(true);
      expect(guard.callAnswered(tool, true)).toBeUndefined();
      expect(guard.turnEnded(true)).toBeUndefined();
      expect(guard.state).toBe('off');
    }
  });

  it('returns to armed when the host refuses the call, and only when no other call is open', () => {
    const guard = new FirstActionGuard();
    guard.arm();
    guard.callArrived();
    expect(guard.callAnswered('dispatch_task', false)).toBeUndefined();
    expect(guard.state).toBe('armed');
    // A refusal is not a first action: the deadline applies again.
    expect(guard.expireIfSilent(FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(true);

    const parallel = new FirstActionGuard();
    parallel.arm();
    parallel.callArrived();
    parallel.callArrived();
    expect(parallel.callAnswered('dispatch_task', false)).toBeUndefined();
    expect(parallel.state).toBe('candidate');
    expect(parallel.expireIfSilent(FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);
    expect(parallel.callAnswered('close_assignment', false)).toBeUndefined();
    expect(parallel.state).toBe('armed');

    // One accepted call is the first action whatever the others come to.
    parallel.callArrived();
    parallel.callArrived();
    expect(parallel.callAnswered('dispatch_task', true)).toBe('delegation-accepted');
    expect(parallel.callAnswered('dispatch_task', false)).toBeUndefined();
    expect(parallel.state).toBe('satisfied');
  });

  it('takes a reply that ends the turn as the first action, and an ending without one as none', () => {
    const replied = new FirstActionGuard();
    replied.arm();
    expect(replied.turnEnded(true)).toBe('terminal-reply');
    expect(replied.state).toBe('off');

    const failed = new FirstActionGuard();
    failed.arm();
    expect(failed.turnEnded(false)).toBeUndefined();
    expect(failed.state).toBe('off');
  });

  it('goes off on a stop, which is not a deadline', () => {
    for (const withCall of [false, true]) {
      const guard = new FirstActionGuard();
      guard.arm();
      if (withCall) guard.callArrived();
      guard.stopped();
      expect(guard.state).toBe('off');
      expect(guard.expireIfSilent(10 * FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(false);
      expect(guard.callArrived()).toBe(true);
    }
  });

  it('refuses a call that arrives from an expired attempt until the next turn arms the guard', () => {
    const guard = new FirstActionGuard();
    guard.arm();
    expect(guard.expireIfSilent(FIRST_ACTION_SILENCE_BUDGET_MS)).toBe(true);
    expect(guard.callArrived()).toBe(false);
    // Neither the late end of that attempt nor a stop makes its calls acceptable again.
    expect(guard.turnEnded(true)).toBeUndefined();
    guard.stopped();
    expect(guard.state).toBe('expired');
    expect(guard.callArrived()).toBe(false);

    guard.arm();
    expect(guard.state).toBe('armed');
    expect(guard.callArrived()).toBe(true);
  });

  it('names the two first-action tools as each route calls them, and nothing else', () => {
    const suffix = 'a5'.repeat(16);
    expect(firstActionToolOf('dispatch_task')).toBe('dispatch_task');
    expect(firstActionToolOf('close_assignment')).toBe('close_assignment');
    expect(firstActionToolOf(`mcp__unode_team_bridge_${suffix}__dispatch_task`)).toBe('dispatch_task');
    expect(firstActionToolOf(`mcp__unode_team_bridge_${suffix}__close_assignment`)).toBe('close_assignment');
    for (const other of [
      'list_agents', 'collect_ready_tasks', `mcp__unode_team_bridge_${suffix}__list_agents`,
      // A bridge-like name the host did not issue, another server's tool of the same name, and a longer name.
      'mcp__unode_team_bridge__dispatch_task', `mcp__unode_files_${suffix}__dispatch_task`,
      'mcp__github__dispatch_task', `mcp__unode_team_bridge_${suffix}__dispatch_task_now`, 'my_dispatch_task',
    ]) {
      expect(firstActionToolOf(other)).toBeUndefined();
    }
  });

  it('reads the tracker: tools and approvals pause the budget, and a refused call does not renew it', () => {
    const state = { now: 0 };
    const tracker = new TurnTimingTracker(() => state.now);
    const guard = new FirstActionGuard();
    const tick = () => guard.expireIfSilent(tracker.providerSilenceMs('pm'));
    tracker.begin('pm', undefined);
    guard.arm();
    tracker.modelRequest('pm');

    // 50 s of silence, then the provider reads a file for two minutes and a person decides for five.
    state.now += 50_000; expect(tick()).toBe(false);
    tracker.toolStarted('pm', 'read-1');
    state.now += 120_000; expect(tick()).toBe(false);
    tracker.toolFinished('pm', 'read-1');
    state.now += 30_000;
    tracker.approvalStarted('pm', 'approval-1');
    state.now += 300_000; expect(tick()).toBe(false);
    tracker.approvalFinished('pm', 'approval-1');

    // A dispatch arrives after 45 s of silence. The host takes 40 s to refuse it: none of that is the provider's.
    state.now += 15_000; expect(tick()).toBe(false);
    tracker.toolStarted('pm', 'dispatch-1', true);
    expect(guard.callArrived()).toBe(true);
    state.now += 40_000; expect(tick()).toBe(false);
    expect(guard.callAnswered('dispatch_task', false)).toBeUndefined();
    tracker.toolFinished('pm', 'dispatch-1', guard.state === 'armed');
    // 45 s were used before the call; the refusal bought no new minute.
    state.now += 14_999; expect(tick()).toBe(false);
    state.now += 1; expect(tick()).toBe(true);
    expect(guard.state).toBe('expired');
  });
});
