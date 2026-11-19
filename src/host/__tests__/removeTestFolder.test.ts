import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTestFolder } from './support/removeTestFolder';

// The test folder cleanup: a folder Windows still holds after the retries fails the test only when one of the test's
// processes still runs. The held folder is simulated through the remove port; a real held folder is checked on Windows.

const held = (code: string) => () => { throw Object.assign(new Error(`${code}: folder held`), { code }); };

describe('removing a test folder that Windows may still hold', () => {
  it('removes the folder when it is free', () => {
    const removed: string[] = [];
    removeTestFolder('C:\\t\\a', [1], { remove: (folder) => removed.push(folder), alive: () => true });
    expect(removed).toEqual(['C:\\t\\a']);
  });

  it.each(['EPERM', 'EBUSY'])('fails on %s when a process of the test still runs, and names it', (code) => {
    expect(() => removeTestFolder('C:\\t\\a', [7, undefined, 9, 9], { remove: held(code), alive: (pid) => pid === 9, platform: 'win32' }))
      .toThrow(/still held and process 9 still runs/);
  });

  it.each(['EPERM', 'EBUSY'])('leaves a folder held with %s on Windows when every process of the test has ended', (code) => {
    expect(() => removeTestFolder('C:\\t\\a', [7, undefined], { remove: held(code), alive: () => false, platform: 'win32' })).not.toThrow();
  });

  it.each(['linux', 'darwin'] as const)('fails on EPERM and EBUSY on %s: there they are a permission or mount problem', (platform) => {
    for (const code of ['EPERM', 'EBUSY']) {
      expect(() => removeTestFolder('/t/a', [], { remove: held(code), alive: () => false, platform })).toThrow(code);
    }
  });

  it('fails on any other error, whatever runs', () => {
    expect(() => removeTestFolder('C:\\t\\a', [], { remove: held('ENOTDIR'), alive: () => false, platform: 'win32' })).toThrow(/ENOTDIR/);
  });

  // The held folder is made deterministic: a child opens a file in it with no sharing at all (FileShare.None, so no
  // delete sharing either) and says so before the folder is removed. Node's own file opens always share delete.
  it.runIf(process.platform === 'win32')('a real folder held by a running process fails, then is removed once it ends', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'unode-held-'));
    const file = path.join(folder, 'held.txt');
    writeFileSync(file, 'held');
    const script = `$h = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('ready')) resolve(); });
      child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held the file`)));
    });
    const once = (target: string) => rmSync(target, { recursive: true, force: true });
    try {
      expect(() => removeTestFolder(folder, [child.pid], { remove: once })).toThrow(/still runs/);
      expect(existsSync(file)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once('exit', resolve)));
    }
    removeTestFolder(folder, [child.pid]);
    expect(existsSync(folder)).toBe(false);
  }, 60_000);
});
