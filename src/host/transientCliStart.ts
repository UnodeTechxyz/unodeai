/*---------------------------------------------------------------------------------------------
 *  UnodeAi - a short use of Codex that belongs to no session, such as loading its model list (v0.9.97)
 *  The use runs through the resolver's transient start, so managed Codex is started through its admission and under
 *  a lease on its version. The lease is given up only once the use's process tree was seen to stop; a stop that was
 *  not confirmed keeps it, so the version is not collected while something it started may still run.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import { treeSeenStopped, type ProcessTerminationOutcome } from '../backend/processTree';
import type { CliSpawn, ResolvedCliStart } from './cliRuntimeResolver';

/** What a use is handed: the program to run, where its process is reported, and where its stop is. */
export interface TransientUse {
  executable: string;
  /** The process the use created; it settles the start. */
  spawned(child: ChildProcess): void;
  /** How the stop of the use's process tree ended. */
  stopped(outcome: ProcessTerminationOutcome): void;
}

export async function runTransientCliUse<T>(
  start: (spawn: CliSpawn) => Promise<ResolvedCliStart>,
  use: (program: TransientUse) => Promise<T>,
  log: (line: string) => void,
): Promise<{ value: T; started: ResolvedCliStart }> {
  let running: Promise<T> | undefined;
  let stop: ProcessTerminationOutcome | undefined;
  // A use that fails before its process exists fails the start, and the start gives up what it held.
  const started = await start((program) => new Promise<ChildProcess>((resolveChild, rejectChild) => {
    running = use({ executable: program.executable, spawned: resolveChild, stopped: (outcome) => { stop = outcome; } });
    running.catch(rejectChild);
  }));
  try {
    if (!running) throw new Error('The program was started without its use.');
    return { value: await running, started };
  } finally {
    if (started.mode === 'managed') {
      if (stop && treeSeenStopped(stop)) started.release();
      else log(`Managed Codex ${started.version ?? ''} stays protected until this window closes: the stop of its model-list process was ${stop ? `not confirmed (${stop.status === 'unknown' ? stop.detail : 'it had ended before the stop'})` : 'never reported'}.`);
    }
  }
}
