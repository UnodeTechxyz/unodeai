import { describe, expect, it, vi } from 'vitest';
import { registerOrchestrationCommands } from '../OrchestrationCommandRegistration';

describe('registerOrchestrationCommands', () => {
  it('retains the bounded orchestration and evidence command ids', () => {
    const register = vi.fn();
    const reviewRun = vi.fn();
    const coordinatorCancelTask = vi.fn();

    registerOrchestrationCommands(register, { reviewRun, coordinatorCancelTask });

    expect(register.mock.calls.map(([id]) => id)).toEqual([
      'unode.reviewRun',
      'unode.coordinatorCancelTask',
    ]);
    expect(register.mock.calls.map(([, handler]) => handler)).toEqual([reviewRun, coordinatorCancelTask]);
  });
});
