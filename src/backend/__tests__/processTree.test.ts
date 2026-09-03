import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { killProcessTree } from '../processTree';

describe('killProcessTree', () => {
  it('terminates a long-running child process (audit N2)', async () => {
    // A process that would otherwise run forever (stands in for a watch-mode test command).
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolve) => proc.once('spawn', () => resolve()));

    const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
    killProcessTree(proc);

    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('process did not exit after killProcessTree')), 8000)),
    ]);
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true); // it actually exited
  }, 15000);

  it('does not throw on an already-exited process', async () => {
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => proc.once('close', () => resolve()));
    expect(() => killProcessTree(proc)).not.toThrow();
  }, 10000);
});
