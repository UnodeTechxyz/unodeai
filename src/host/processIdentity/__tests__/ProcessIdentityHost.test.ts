import { describe, expect, it } from 'vitest';
import { judgeProcessRecord, parseProcessIdentityRecord, processIdentityHost, type ProcessIdentityRecord } from '../ProcessIdentityHost';
import { linuxProcessIdentityAdapter, linuxStartTicks } from '../linuxProcessIdentity';
import { darwinProcessIdentityAdapter, parseDarwinBootTime, parseDarwinPsAnswer } from '../darwinProcessIdentity';
import { windowsProcessIdentityAdapter } from '../windowsProcessIdentity';
import type { WindowsPowerShellRequest, WindowsPowerShellRunResult } from '../../windowsPowerShell';
import * as path from 'node:path';
import * as os from 'node:os';

const BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

function stat(pid: number, comm: string, ticks: string): string {
  // Fields 3..21 then field 22 (starttime).
  const middle = Array.from({ length: 19 }, (_, i) => String(i)).join(' ');
  return `${pid} (${comm}) ${middle} ${ticks} 0 0`;
}

describe('judgeProcessRecord', () => {
  const record: ProcessIdentityRecord = { pid: 42, startToken: '100', bootToken: 'boot-a', platform: 'linux' };
  it('is gone only on proof, and never on another platform or an unknown read', () => {
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'boot-a', current: { startToken: '100' } })).toBe('alive');
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'boot-a', current: { startToken: '101' } })).toBe('gone');
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'boot-a', current: undefined })).toBe('gone');
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'boot-b', current: { startToken: '100' } })).toBe('gone');
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'unknown', current: undefined })).toBe('unknown');
    expect(judgeProcessRecord(record, { platform: 'linux', bootToken: 'boot-a', current: 'unknown' })).toBe('unknown');
    expect(judgeProcessRecord(record, { platform: 'darwin', bootToken: 'boot-a', current: undefined })).toBe('unknown');
  });

  it('parses a stored record whole or not at all', () => {
    expect(parseProcessIdentityRecord(record)).toEqual(record);
    expect(parseProcessIdentityRecord({ ...record, pid: 0 })).toBeUndefined();
    expect(parseProcessIdentityRecord({ ...record, startToken: 'a\nb' })).toBeUndefined();
    expect(parseProcessIdentityRecord({ pid: 1, platform: 'linux' })).toBeUndefined();
  });

  it('answers unknown for everything on a platform without an adapter', async () => {
    const host = processIdentityHost({ platform: 'aix' });
    expect(await host.self()).toBe('unknown');
    expect(await host.liveness([record])).toEqual(['unknown']);
  });
});

describe('linux adapter', () => {
  it('reads field 22 after the last parenthesis, whatever the command name holds', () => {
    expect(linuxStartTicks(stat(7, 'a b) (c', '98765'))).toBe('98765');
    expect(linuxStartTicks('garbage')).toBeUndefined();
  });

  it('proves gone by a missing entry, another start or another boot; keeps unknown when its own entry cannot be read', async () => {
    const files: Record<string, string> = {
      '/proc/sys/kernel/random/boot_id': `${BOOT}\n`,
      '/proc/1/stat': stat(1, 'node', '50'),
      '/proc/2/stat': stat(2, 'node', '60'),
      '/proc/3/stat': stat(3, 'node', '71'),
    };
    const readFile = async (file: string) => {
      if (file in files) return files[file];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    const adapter = linuxProcessIdentityAdapter({ readFile, selfPid: 1 });
    expect(await adapter.self()).toEqual({ pid: 1, startToken: '50', bootToken: BOOT, platform: 'linux' });
    const rec = (pid: number, start: string, boot = BOOT): ProcessIdentityRecord => ({ pid, startToken: start, bootToken: boot, platform: 'linux' });
    expect(await adapter.liveness([rec(2, '60'), rec(3, '70'), rec(4, '80'), rec(2, '60', 'f'.repeat(8) + BOOT.slice(8))]))
      .toEqual(['alive', 'gone', 'gone', 'gone']);
    const blind = linuxProcessIdentityAdapter({ readFile: async (file) => (file.includes('boot_id') ? BOOT : Promise.reject(new Error('EACCES'))), selfPid: 1 });
    expect(await blind.liveness([rec(4, '80')])).toEqual(['unknown']);
  });
});

describe('darwin adapter (not verified on macOS)', () => {
  it('parses boot time and ps lines strictly', () => {
    expect(parseDarwinBootTime('{ sec = 1764000000, usec = 123456 } Tue Nov 25 08:00:00 2026')).toBe('1764000000.123456');
    expect(parseDarwinBootTime('nonsense')).toBeUndefined();
    expect(parseDarwinPsAnswer('  11 Tue Nov 25 08:00:01 2026\n  12 Tue Nov  5 08:00:02 2026\n')).toEqual(new Map([[11, 'Tue Nov 25 08:00:01 2026'], [12, 'Tue Nov 5 08:00:02 2026']]));
    expect(parseDarwinPsAnswer('11 yesterday')).toBeUndefined();
  });

  it('proves nothing from an answer that does not list this process, and treats ps exit 1 as a partial answer', async () => {
    const boot = '{ sec = 1764000000, usec = 1 } x';
    const run = async (file: string, args: readonly string[]) => {
      if (file === '/usr/sbin/sysctl') return boot;
      expect(file).toBe('/bin/ps');
      expect(args.slice(0, 3)).toEqual(['-o', 'pid=,lstart=', '-p']);
      throw Object.assign(new Error('exit 1'), { code: 1, stdout: '  11 Tue Nov 25 08:00:01 2026\n' });
    };
    const adapter = darwinProcessIdentityAdapter({ run, selfPid: 11 });
    const rec = (pid: number): ProcessIdentityRecord => ({ pid, startToken: 'Tue Nov 25 08:00:01 2026', bootToken: '1764000000.1', platform: 'darwin' });
    expect(await adapter.liveness([rec(12)])).toEqual(['gone']);
    const withoutSelf = darwinProcessIdentityAdapter({ run, selfPid: 99 });
    expect(await withoutSelf.liveness([rec(12)])).toEqual(['unknown']);
  });
});

describe('windows adapter', () => {
  const folder = path.win32.join('X:\\', 'owned');
  function answer(lines: string[]): WindowsPowerShellRunResult {
    return { status: 'exited', code: 0, signal: null, stdout: ['UNODE-PC1:BEGIN', ...lines, 'UNODE-PC1:END', ''].join('\r\n'), stderr: '' } as WindowsPowerShellRunResult;
  }

  it('uses the creation time as the start token and proves gone by a missing number or another creation', async () => {
    const asked: string[] = [];
    const runPowerShell = async (request: WindowsPowerShellRequest) => {
      const list = Buffer.from(request.input ?? '', 'base64').toString('ascii');
      asked.push(list);
      const running: Record<string, string> = { 100: '2026-11-25T08:00:00.0000001Z', 200: '2026-11-25T08:00:00.0000002Z' };
      return answer(list.split(',').filter((pid) => pid in running).map((pid) => `UNODE-PC1:${pid} ${running[pid]}`));
    };
    const adapter = windowsProcessIdentityAdapter({ request: { ownedFolder: folder, ownedTmp: folder }, deps: { platform: 'win32', selfPid: 100, runPowerShell } });
    expect(await adapter.self()).toEqual({ pid: 100, startToken: '2026-11-25T08:00:00.0000001Z', platform: 'win32' });
    const rec = (pid: number, start: string): ProcessIdentityRecord => ({ pid, startToken: start, platform: 'win32' });
    expect(await adapter.liveness([rec(200, '2026-11-25T08:00:00.0000002Z'), rec(200, '2026-11-25T07:00:00.0000002Z'), rec(300, '2026-11-25T08:00:00.0000003Z')]))
      .toEqual(['alive', 'gone', 'gone']);
    expect(asked.at(-1)).toBe('100,200,300');
  });

  it('is unknown when the query is unavailable', async () => {
    const adapter = windowsProcessIdentityAdapter({
      request: { ownedFolder: folder, ownedTmp: folder },
      deps: { platform: 'win32', selfPid: 100, runPowerShell: async () => ({ status: 'exited', code: 4, signal: null, stdout: 'UNODE-PC1:ERR', stderr: '' } as WindowsPowerShellRunResult) },
    });
    expect(await adapter.liveness([{ pid: 5, startToken: '2026-11-25T08:00:00.0000003Z', platform: 'win32' }])).toEqual(['unknown']);
    expect(os.EOL.length).toBeGreaterThan(0);
  });
});
