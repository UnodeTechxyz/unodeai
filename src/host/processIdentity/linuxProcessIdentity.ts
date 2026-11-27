/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Linux process identity adapter (v0.9.110)
 *  Boot: /proc/sys/kernel/random/boot_id. Start: field 22 of /proc/<pid>/stat (clock ticks since boot), which is
 *  unique only within one boot, so the boot token is always recorded with it.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'node:fs';
import { judgeProcessRecord, type ProcessIdentityAdapter, type ProcessIdentityRecord, type ProcessLiveness } from './ProcessIdentityHost';

export interface LinuxProcessIdentityDeps {
  readFile?: (file: string) => Promise<string>;
  selfPid?: number;
}

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
const BOOT_ID_PATTERN = /^[0-9a-f-]{36}$/;

/** Field 22 of a stat line. The command name (field 2) may hold spaces and parentheses, so fields count from the last ')'. */
export function linuxStartTicks(statLine: string): string | undefined {
  const close = statLine.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 is fields[19].
  const ticks = fields[19];
  return ticks !== undefined && /^\d{1,20}$/.test(ticks) ? ticks : undefined;
}

export function linuxProcessIdentityAdapter(deps: LinuxProcessIdentityDeps = {}): ProcessIdentityAdapter {
  const read = deps.readFile ?? ((file: string) => fsp.readFile(file, 'utf8'));
  const selfPid = deps.selfPid ?? process.pid;

  async function bootToken(): Promise<string | 'unknown'> {
    try {
      const value = (await read(BOOT_ID_FILE)).trim();
      return BOOT_ID_PATTERN.test(value) ? value : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function start(pid: number): Promise<{ startToken: string } | undefined | 'unknown'> {
    try {
      const ticks = linuxStartTicks(await read(`/proc/${pid}/stat`));
      return ticks ? { startToken: ticks } : 'unknown';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unknown';
    }
  }

  async function identityOf(pid: number): Promise<ProcessIdentityRecord | 'unknown'> {
    const boot = await bootToken();
    const own = await start(pid);
    if (boot === 'unknown' || !own || own === 'unknown') return 'unknown';
    return { pid, startToken: own.startToken, bootToken: boot, platform: 'linux' };
  }

  return {
    platform: 'linux',
    self: () => identityOf(selfPid),
    identityOf,
    async liveness(records: readonly ProcessIdentityRecord[]): Promise<ProcessLiveness[]> {
      const boot = await bootToken();
      // The proof must cover this process too: a host that cannot read its own entry proves nothing gone.
      const own = await start(selfPid);
      if (!own || own === 'unknown') return records.map(() => 'unknown');
      const answers: ProcessLiveness[] = [];
      for (const record of records) {
        if (record.platform !== 'linux' || record.bootToken === undefined) { answers.push('unknown'); continue; }
        // Another boot proves the process gone without reading its number, which may belong to anyone now.
        if (boot !== 'unknown' && boot !== record.bootToken) { answers.push('gone'); continue; }
        answers.push(judgeProcessRecord(record, { platform: 'linux', bootToken: boot, current: await start(record.pid) }));
      }
      return answers;
    },
  };
}
