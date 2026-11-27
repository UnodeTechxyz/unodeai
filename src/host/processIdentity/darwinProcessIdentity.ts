/*---------------------------------------------------------------------------------------------
 *  UnodeAi - macOS process identity adapter (v0.9.110). Not verified on macOS.
 *  Start: `/bin/ps -o pid=,lstart= -p <pids>` under the C locale. Boot: `/usr/sbin/sysctl -n kern.boottime`.
 *  Both run without a shell, from fixed absolute paths, with fixed arguments. An answer that does not list this
 *  process itself proves nothing.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { judgeProcessRecord, type ProcessIdentityAdapter, type ProcessIdentityRecord, type ProcessLiveness } from './ProcessIdentityHost';

export interface DarwinProcessIdentityDeps {
  run?: (file: string, args: readonly string[]) => Promise<string>;
  selfPid?: number;
}

const PS = '/bin/ps';
const SYSCTL = '/usr/sbin/sysctl';
const MAX_OUTPUT = 64 * 1024;
const LSTART_LINE = /^\s*(\d{1,10})\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s*$/;
const BOOTTIME = /^\{ sec = (\d{1,20}), usec = (\d{1,7}) \}/;

function defaultRun(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { env: { LC_ALL: 'C', LANG: 'C' }, timeout: 5_000, maxBuffer: MAX_OUTPUT, windowsHide: true },
      (error, stdout) => (error ? reject(Object.assign(error, { stdout: String(stdout) })) : resolve(String(stdout))));
  });
}

export function parseDarwinBootTime(output: string): string | undefined {
  const match = BOOTTIME.exec(output.trim());
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/** pid → start text; undefined when the answer is malformed. */
export function parseDarwinPsAnswer(output: string): Map<number, string> | undefined {
  const starts = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = LSTART_LINE.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    if (starts.has(pid)) return undefined;
    starts.set(pid, match[2].replace(/\s+/g, ' '));
  }
  return starts;
}

export function darwinProcessIdentityAdapter(deps: DarwinProcessIdentityDeps = {}): ProcessIdentityAdapter {
  const run = deps.run ?? defaultRun;
  const selfPid = deps.selfPid ?? process.pid;

  async function boot(): Promise<string | 'unknown'> {
    try { return parseDarwinBootTime(await run(SYSCTL, ['-n', 'kern.boottime'])) ?? 'unknown'; } catch { return 'unknown'; }
  }

  async function starts(pids: readonly number[]): Promise<Map<number, string> | 'unknown'> {
    const asked = [...new Set([selfPid, ...pids])];
    let output: string;
    try {
      output = await run(PS, ['-o', 'pid=,lstart=', '-p', asked.join(',')]);
    } catch (error) {
      // ps exits 1 when some numbers do not run; its output is still the answer for the ones that do.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout !== 'string' || (error as { code?: unknown }).code !== 1) return 'unknown';
      output = stdout;
    }
    const answer = parseDarwinPsAnswer(output);
    if (!answer || !answer.has(selfPid) || [...answer.keys()].some((pid) => !asked.includes(pid))) return 'unknown';
    return answer;
  }

  async function identityOf(pid: number): Promise<ProcessIdentityRecord | 'unknown'> {
    const [bootToken, answer] = await Promise.all([boot(), starts([pid])]);
    const start = answer === 'unknown' ? undefined : answer.get(pid);
    if (bootToken === 'unknown' || !start) return 'unknown';
    return { pid, startToken: start, bootToken, platform: 'darwin' };
  }

  return {
    platform: 'darwin',
    self: () => identityOf(selfPid),
    identityOf,
    async liveness(records: readonly ProcessIdentityRecord[]): Promise<ProcessLiveness[]> {
      const [bootToken, answer] = await Promise.all([boot(), starts(records.map((record) => record.pid))]);
      return records.map((record) => {
        if (record.platform !== 'darwin' || record.bootToken === undefined) return 'unknown';
        if (bootToken !== 'unknown' && bootToken !== record.bootToken) return 'gone';
        if (answer === 'unknown') return 'unknown';
        const start = answer.get(record.pid);
        return judgeProcessRecord(record, { platform: 'darwin', bootToken, current: start === undefined ? undefined : { startToken: start } });
      });
    },
  };
}
