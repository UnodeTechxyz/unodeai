import { describe, expect, it } from 'vitest';
import { FirstActionGuard, firstActionToolOf } from '../FirstActionGuard';

describe('first-action measurement without a deadline', () => {
  it('takes an accepted dispatch or an accepted close as the first action', () => {
    for (const [tool, kind] of [['dispatch_task', 'delegation-accepted'], ['close_assignment', 'assignment-closed']] as const) {
      const guard = new FirstActionGuard();
      guard.arm();
      expect(guard.callArrived()).toBe(true);
      expect(guard.state).toBe('candidate');
      // The provider has acted; however long the host takes to decide, nothing expires.
      expect(guard.callAnswered(tool, true)).toBe(kind);
      expect(guard.state).toBe('satisfied');
      // After the first action the guard is done with the turn: no deadline, and a later call is not a first one.
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
    // A refusal is not a first action; measurement waits for an accepted action or a reply.

    const parallel = new FirstActionGuard();
    parallel.arm();
    parallel.callArrived();
    parallel.callArrived();
    expect(parallel.callAnswered('dispatch_task', false)).toBeUndefined();
    expect(parallel.state).toBe('candidate');
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
      expect(guard.callArrived()).toBe(true);
    }
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


});
