/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Windows process identity adapter (v0.9.110)
 *  Reuses the reviewed Win32_Process CreationDate query (managedCli/processIdentity.ts): the creation time is an
 *  absolute UTC time with 100 ns precision, so it already differs across boots and no boot token is recorded.
 *  The query costs about a second; it runs only when an owner must be proven gone, never on a write.
 *--------------------------------------------------------------------------------------------*/

import {
  judgeProcessIdentity,
  queryProcessCreations,
  type ProcessCreationQueryDeps,
  type ProcessCreationQueryRequest,
} from '../managedCli/processIdentity';
import type { ProcessIdentityAdapter, ProcessIdentityRecord, ProcessLiveness } from './ProcessIdentityHost';

export interface WindowsProcessIdentityOptions {
  request: ProcessCreationQueryRequest;
  deps?: ProcessCreationQueryDeps;
}

export function windowsProcessIdentityAdapter(options: WindowsProcessIdentityOptions): ProcessIdentityAdapter {
  const selfPid = options.deps?.selfPid ?? process.pid;
  async function identityOf(pid: number): Promise<ProcessIdentityRecord | 'unknown'> {
    try {
      const answer = await queryProcessCreations([pid], options.request, options.deps);
      const creation = answer === 'unavailable' ? undefined : answer.get(pid);
      return creation ? { pid, startToken: creation, platform: 'win32' } : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  return {
    platform: 'win32',
    self: () => identityOf(selfPid),
    identityOf,
    async liveness(records: readonly ProcessIdentityRecord[]): Promise<ProcessLiveness[]> {
      const own = records.filter((record) => record.platform === 'win32');
      if (own.length === 0) return records.map(() => 'unknown');
      let answer: Awaited<ReturnType<typeof queryProcessCreations>>;
      try {
        answer = await queryProcessCreations(own.map((record) => record.pid), options.request, options.deps);
      } catch {
        return records.map(() => 'unknown');
      }
      return records.map((record) => {
        if (record.platform !== 'win32') return 'unknown';
        const judged = judgeProcessIdentity({ pid: record.pid, creation: record.startToken }, answer);
        return judged === 'dead' ? 'gone' : judged;
      });
    },
  };
}
