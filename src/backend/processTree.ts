/*---------------------------------------------------------------------------------------------
 *  UnodeAi - processTree
 *  Kill a spawned command AND its descendants. We spawn verify/run_checks commands with `shell:true`,
 *  so on Windows the child is `cmd.exe`; `child.kill()` terminates the shell but leaves the actual
 *  runner (npm/node/pytest) alive — a watch-mode or input-waiting command then orphans on a timeout.
 *  `taskkill /T /F` kills the whole tree. On POSIX, SIGKILL of the shell child is sufficient for the
 *  simple commands we run. Best-effort; never throws. (Audit N2/N9.)
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import { resolveHostExecutable } from '../security/HostExecutableResolver';

const PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;
type HostExecutableResolver = (command: string) => string;

function killPidDirectly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone / best effort */
  }
}

/**
 * Kill a process tree when the owner only has a PID (VS Code terminals expose no ChildProcess).
 * Unlike Terminal.dispose(), the Windows path deliberately waits for `taskkill /T` to finish before
 * its caller closes the terminal tab, so a nested shell cannot be orphaned when the root shell exits.
 */
export async function killProcessTreeByPid(pid: number, resolveExecutable: HostExecutableResolver = resolveHostExecutable): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return; }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      let killer: ChildProcess | undefined;
      const finish = (fallback: boolean) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (fallback) { killPidDirectly(pid); }
        resolve();
      };
      const timer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); } catch { /* best effort */ }
        finish(true);
      }, PROCESS_TREE_KILL_TIMEOUT_MS);
      try {
        killer = spawn(resolveExecutable('taskkill'), ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => finish(true));
        killer.once('exit', (code) => finish(code !== 0));
      } catch {
        finish(true);
      }
    });
    return;
  }

  // Terminal children may have their own process group, so killing only the shell (or only its group)
  // can leave a foreground nested shell alive. Snapshot the parent graph and kill leaves first.
  const descendants = await new Promise<number[]>((resolve) => {
    let output = '';
    let settled = false;
    let listing: ChildProcess | undefined;
    const finish = (rows: number[]) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(rows);
    };
    const timer = setTimeout(() => {
      try { listing?.kill('SIGKILL'); } catch { /* best effort */ }
      finish([]);
    }, PROCESS_TREE_KILL_TIMEOUT_MS);
    try {
      listing = spawn(resolveExecutable('ps'), ['-e', '-o', 'pid=', '-o', 'ppid='], { stdio: ['ignore', 'pipe', 'ignore'] });
      listing.stdout?.on('data', (chunk) => { output += String(chunk); });
      listing.once('error', () => finish([]));
      listing.once('close', (code) => {
        if (code !== 0) { finish([]); return; }
        const children = new Map<number, number[]>();
        for (const line of output.split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (!match) { continue; }
          const child = Number(match[1]);
          const parent = Number(match[2]);
          const siblings = children.get(parent) ?? [];
          siblings.push(child);
          children.set(parent, siblings);
        }
        const rows: number[] = [];
        const visit = (parent: number) => {
          for (const child of children.get(parent) ?? []) {
            visit(child);
            rows.push(child);
          }
        };
        visit(pid);
        finish(rows);
      });
    } catch {
      finish([]);
    }
  });
  for (const childPid of descendants) { killPidDirectly(childPid); }
  killPidDirectly(pid);
}

export function killProcessTree(proc: ChildProcess, resolveExecutable: HostExecutableResolver = resolveHostExecutable): void {
  const pid = proc.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      // /T = tree (kill children too), /F = force. `spawn` reports a missing taskkill asynchronously,
      // so fall back to the direct child only when taskkill could not run or reports failure. Killing
      // the shell immediately would race taskkill's tree enumeration and could orphan its children.
      const killer = spawn(resolveExecutable('taskkill'), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      const killDirectChild = () => {
        try { proc.kill('SIGKILL'); } catch { /* best effort */ }
      };
      killer.once('error', killDirectChild);
      killer.once('exit', (code) => {
        if (code !== 0) {
          killDirectChild();
        }
      });
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* best effort */
  }
}
