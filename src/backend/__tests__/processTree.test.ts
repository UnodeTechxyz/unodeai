import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { killProcessTree, killProcessTreeByPid } from '../processTree';

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

  it('kills a nested shell before it can perform a delayed side effect', async () => {
    const marker = join(tmpdir(), `unode-terminal-tree-${process.pid}-${Date.now()}.txt`);
    const powershellPath = marker.replace(/'/g, "''");
    const nested = process.platform === 'win32'
      ? {
          executable: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Sleep -Milliseconds 1000; [IO.File]::WriteAllText('${powershellPath}', 'stale'); while ($true) { Start-Sleep -Seconds 1 }`,
          ],
        }
      : {
          executable: process.execPath,
          args: ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'stale'), 1000); setInterval(() => {}, 1000);`],
        };
    const parentCode = [
      "const { spawn } = require('child_process');",
      `const child = spawn(${JSON.stringify(nested.executable)}, ${JSON.stringify(nested.args)}, { stdio: 'ignore' });`,
      "child.once('spawn', () => process.stdout.write(String(child.pid) + '\\n'));",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let nestedPid: number | undefined;
    try {
      nestedPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nested process did not start')), 5000);
        parent.stdout?.once('data', (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
        parent.once('error', reject);
      });
      await killProcessTreeByPid(parent.pid!);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(existsSync(marker)).toBe(false);
    } finally {
      killProcessTree(parent);
      if (nestedPid) {
        try { process.kill(nestedPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(marker, { force: true });
    }
  }, 15000);
});
