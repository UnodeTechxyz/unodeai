import { describe, expect, it } from 'vitest';
import { coordinatorSelfDo, COORDINATOR_SELF_DO_REMINDER } from '../CoordinatorSelfDo';

// v0.9.99 (B15): how a coordinator's own write or command proceeds. Only a contract it filed can refuse it; with no
// contract in force its own permissions decide, which the route's tools still apply after this.
describe('coordinatorSelfDo (v0.9.99)', () => {
  it('a solo agent is unaffected', () => {
    expect(coordinatorSelfDo(undefined, 'write_file')).toBe('solo');
    expect(coordinatorSelfDo({ hasTeammates: () => false, canCoordinatorExecute: () => false }, 'write_file')).toBe('solo');
  });

  it('with teammates and no contract in force, the coordinator acts under its own permissions', () => {
    expect(coordinatorSelfDo({ hasTeammates: () => true, currentCoordinatorTaskAttempt: () => undefined, canCoordinatorExecute: () => false }, 'run_command'))
      .toBe('own-authority');
  });

  it('a contract that covers the action authorises it; one that does not refuses it', () => {
    const attempt = { contractId: 'contract-1' };
    expect(coordinatorSelfDo({ hasTeammates: () => true, currentCoordinatorTaskAttempt: () => attempt, canCoordinatorExecute: () => true }, 'write_file'))
      .toBe('contract');
    expect(coordinatorSelfDo({ hasTeammates: () => true, currentCoordinatorTaskAttempt: () => attempt, canCoordinatorExecute: () => false }, 'write_file'))
      .toBe('refused');
  });

  it('the reminder still prefers delegation for larger work and names no internal term', () => {
    expect(COORDINATOR_SELF_DO_REMINDER).toContain('dispatch_task');
    expect(COORDINATOR_SELF_DO_REMINDER).not.toMatch(/admission|fence|receipt|quarantine/i);
  });
});
