/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which writer process is still running, by an identity the operating system gives (v0.9.110, §3.4)
 *
 *  A process is named by its number, its operating-system start token and, where the start token is only unique
 *  within one boot, the boot token. A process number alone, a heartbeat age or a lease's age is never an identity.
 *
 *  Gone only on proof: the same execution host reports another boot, no process with that number, or one with a
 *  different start token. Anything the adapter cannot prove is `unknown`, and unknown is never treated as gone.
 *  Operating-system calls live only in the named adapters beside this file.
 *--------------------------------------------------------------------------------------------*/

import { linuxProcessIdentityAdapter } from './linuxProcessIdentity';
import { darwinProcessIdentityAdapter } from './darwinProcessIdentity';
import { windowsProcessIdentityAdapter, type WindowsProcessIdentityOptions } from './windowsProcessIdentity';

export interface ProcessIdentityRecord {
  pid: number;
  /** What the operating system reports as the process's start, exactly as reported; never a clock estimate. */
  startToken: string;
  /** Present when `startToken` is unique only within one boot. */
  bootToken?: string;
  platform: NodeJS.Platform;
}

export type ProcessLiveness = 'alive' | 'gone' | 'unknown';

export interface ProcessIdentityAdapter {
  readonly platform: NodeJS.Platform;
  /** This process's own identity, or `unknown` when the platform cannot give one. */
  self(): Promise<ProcessIdentityRecord | 'unknown'>;
  /** The identity of the process running under `pid` now; `unknown` when it cannot be read or none runs. */
  identityOf(pid: number): Promise<ProcessIdentityRecord | 'unknown'>;
  /** One answer per record, in order. Records of another platform are `unknown`. */
  liveness(records: readonly ProcessIdentityRecord[]): Promise<ProcessLiveness[]>;
}

export interface ProcessIdentityHostOptions {
  platform?: NodeJS.Platform;
  windows?: WindowsProcessIdentityOptions;
}

/** The adapter for this platform; a platform without one answers `unknown` for everything. */
export function processIdentityHost(options: ProcessIdentityHostOptions = {}): ProcessIdentityAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && options.windows) return windowsProcessIdentityAdapter(options.windows);
  if (platform === 'linux') return linuxProcessIdentityAdapter();
  if (platform === 'darwin') return darwinProcessIdentityAdapter();
  return unsupportedProcessIdentityAdapter(platform);
}

export function unsupportedProcessIdentityAdapter(platform: NodeJS.Platform): ProcessIdentityAdapter {
  return {
    platform,
    self: async () => 'unknown',
    identityOf: async () => 'unknown',
    liveness: async (records) => records.map(() => 'unknown' as const),
  };
}

const TOKEN_PATTERN = /^[A-Za-z0-9 ._:+-]{1,128}$/;

export function parseProcessIdentityRecord(value: unknown): ProcessIdentityRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const pid = candidate.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined;
  if (typeof candidate.startToken !== 'string' || !TOKEN_PATTERN.test(candidate.startToken)) return undefined;
  if (candidate.bootToken !== undefined && (typeof candidate.bootToken !== 'string' || !TOKEN_PATTERN.test(candidate.bootToken))) {
    return undefined;
  }
  if (typeof candidate.platform !== 'string' || candidate.platform.length > 20) return undefined;
  return {
    pid,
    startToken: candidate.startToken,
    ...(candidate.bootToken !== undefined ? { bootToken: candidate.bootToken as string } : {}),
    platform: candidate.platform as NodeJS.Platform,
  };
}

/**
 * The shared judgement once an adapter has read the current facts. `current` is what runs now under that number
 * (undefined: nothing runs under it), or `unknown` when the read failed.
 */
export function judgeProcessRecord(
  record: ProcessIdentityRecord,
  facts: { platform: NodeJS.Platform; bootToken?: string | 'unknown'; current: { startToken: string } | undefined | 'unknown' },
): ProcessLiveness {
  if (record.platform !== facts.platform) return 'unknown';
  if (record.bootToken !== undefined) {
    if (facts.bootToken === undefined || facts.bootToken === 'unknown') return 'unknown';
    if (facts.bootToken !== record.bootToken) return 'gone';
  }
  if (facts.current === 'unknown') return 'unknown';
  if (facts.current === undefined) return 'gone';
  return facts.current.startToken === record.startToken ? 'alive' : 'gone';
}
