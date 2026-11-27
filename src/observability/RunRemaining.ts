/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Unfinished work of one run (v0.9.100)
 *  Which logical tasks of a run did not finish, and why, from the run's stored delegations alone. The Job
 *  outcome lists them, and the run's own closeout state reads them, so a closed run never says Complete beside
 *  a task that did not finish.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import type { RunDelegation, RunRecord } from './RunLedger';
import { projectRetryTopology } from './RetryTopology';

export type JobRemainingReason =
  | 'interrupted'
  | 'stopped'
  | 'abandoned'
  | 'still-active'
  | 'timed-out'
  | 'partial-result'
  | 'changes-refused'
  | 'result-not-observed'
  | 'needs-rework'
  | 'rejected'
  | 'needs-human'
  | 'deferred';

export interface LogicalTask {
  /** The last attempt: the one whose result stands for the task. */
  final: RunDelegation;
  attempts: RunDelegation[];
}

export function logicalTasks(run: RunRecord): { tasks: LogicalTask[]; retryChains: number; gaps: number; conflict: boolean } {
  const topology = projectRetryTopology(run.delegations);
  const byHandle = new Map(run.delegations.map((delegation) => [delegation.handle, delegation]));
  const tasks = topology.tasks.map((task) => {
    const attempts = task.attempts.map((handle) => byHandle.get(handle)!).filter(Boolean);
    return { final: attempts[attempts.length - 1], attempts };
  }).filter((task) => task.final);
  return {
    tasks,
    retryChains: topology.retryChains,
    gaps: topology.gaps.length,
    conflict: topology.gaps.some((gap) => gap.gap === 'conflict'),
  };
}

type TerminalDisposition = 'superseded' | 'abandoned';

/** The first superseded or abandoned decision: such a decision is final, and a later entry cannot undo it. */
export function terminalDisposition(delegation: RunDelegation): TerminalDisposition | undefined {
  const entry = delegation.dispositions.find((candidate) =>
    candidate.disposition === 'superseded' || candidate.disposition === 'abandoned');
  return entry?.disposition as TerminalDisposition | undefined;
}

/** Why a task is not finished, or undefined when its result stands. A superseded task was replaced, not left. */
export function remainingReason(delegation: RunDelegation): JobRemainingReason | undefined {
  const terminal = terminalDisposition(delegation);
  if (terminal === 'superseded') return undefined;
  if (terminal === 'abandoned') return 'abandoned';
  switch (delegation.state) {
    case 'active': return 'still-active';
    case 'interrupted': return 'interrupted';
    case 'cancelled': return 'stopped';
    case 'settled': break;
    default: return unreachable(delegation.state);
  }
  const latest = delegation.dispositions[delegation.dispositions.length - 1]?.disposition;
  if (latest === 'needs-rework') return 'needs-rework';
  if (latest === 'rejected') return 'rejected';
  if (latest === 'needs-human') return 'needs-human';
  if (latest === 'deferred') return 'deferred';
  if (delegation.evidence?.outcome === 'timed-out') return 'timed-out';
  if (delegation.evidence?.completionState === 'partial') return 'partial-result';
  if (!delegation.evidence || delegation.evidence.completionState === 'not-observed') return 'result-not-observed';
  // The host refused a file change this task asked for and the task never made it. Whatever the reply says,
  // that work is not done. This is the host's own tool result, counted by target.
  if ((delegation.evidence.refusedEffects ?? 0) > 0) return 'changes-refused';
  return undefined;
}

/** Whether any logical task of the run did not finish: the count the Job outcome shows as unfinished. */
export function hasUnfinishedTask(run: RunRecord): boolean {
  return logicalTasks(run).tasks.some((task) => remainingReason(task.final) !== undefined);
}

/**
 * v0.9.101 (G3): whether one settled attempt did the work its contract required, by the host's own facts about its
 * result: its remaining reason, the outcome and the declared checks the host evaluated, its standing result, and each
 * required output among the files it changed. A reply's words are never read. A retry is offered for an attempt that
 * did not, and a replacement counts toward Complete only when it did.
 */
export function finishedRequiredWork(delegation: RunDelegation): boolean {
  if (delegation.state !== 'settled' || remainingReason(delegation) !== undefined) return false;
  const evidence = delegation.evidence;
  if (!evidence) return false;
  if (evidence.outcome === 'verification-failed' || evidence.outcome === 'required-input-read-not-observed'
    || evidence.outcome === 'timed-out') return false;
  // A declared check that failed or did not run is a required check not passed.
  if (evidence.verificationPlanStatus === 'failed' || evidence.verificationPlanStatus === 'not-run') return false;
  const standing = delegation.resultHistory?.find((row) => row.ref.revision === delegation.currentResultRevision);
  if (standing?.state === 'failed') return false;
  // v0.9.103 (field smoke of d71485c5): an output a command made, observed on disk at settlement, is there too.
  const changed = [...evidence.changedFiles, ...(delegation.diffDigest?.files.map((file) => file.path) ?? []),
    ...(evidence.outputsObservedOnDisk?.map((output) => output.path) ?? [])];
  return requiredOutputsNotWritten(delegation.contract?.outputs, changed, delegation.pathBases).length === 0;
}

/**
 * v0.9.102 (field fix 4): the required outputs of a contract that none of these changed files is, by path identity: a
 * relative changed file is in the teammate's own folder (`bases.changes`), a relative output in the contract's. The
 * same rule decides a retry's finished work above and a settling attempt's result (TeamTools), so a file written in the
 * workspace under the output's name is never taken for an output the contract names outside it.
 */
export function requiredOutputsNotWritten<Output extends { path: string; kind: 'file' | 'directory'; required: boolean }>(
  outputs: readonly Output[] | undefined,
  changedFiles: readonly string[],
  bases: { contract?: string; changes?: string } | undefined,
): Output[] {
  const changed = changedFiles.map((file) => pathIdentity(file, bases?.changes));
  return (outputs ?? []).filter((output) => output.required && !written(output));
  function written(output: Output): boolean {
    // v0.9.101 (audit R5b): a relative output is a place in the task's workspace. The teammate writes it in the
    // workspace it was dispatched to, its own isolated worktree included, from which a merge brings it to the
    // coordinator's: both spellings are that output. An absolute output outside the workspace resolves to itself under
    // either folder, so it is met only by that destination.
    const wanted = [pathIdentity(output.path, bases?.contract),
      ...(bases?.changes ? [pathIdentity(output.path, bases.changes)] : [])];
    return changed.some((file) => wanted.some((target) => output.kind === 'directory' ? sameOrInside(target, file) : target === file));
  }
}

/**
 * v0.9.101 (G3, audit R5): the identity of a recorded path, by spelling alone and without any disk call. A relative
 * spelling is resolved under the folder the host recorded for it at dispatch: the contract's for an output, the
 * teammate's own for a changed file. One with no recorded folder stays relative and equals only the same relative
 * spelling; it never matches an absolute path by its ending. Separators unified, letter case ignored on Windows.
 */
function pathIdentity(value: string, base: string | undefined): string {
  // A drive or UNC spelling is read by Windows rules on any host, as the contract compiler reads it.
  const api = /^[a-z]:[\\/]|^[\\/]{2}/i.test(value) ? path.win32 : path;
  const absolute = api.isAbsolute(value);
  const resolved = absolute ? api.resolve(value) : base ? api.resolve(base, value) : api.normalize(value);
  const unified = resolved.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return `${absolute || base ? 'abs' : 'rel'}:${process.platform === 'win32' ? unified.toLowerCase() : unified}`;
}

function sameOrInside(folder: string, file: string): boolean {
  if (folder === file) return true;
  const slash = file.lastIndexOf('/');
  return slash > file.indexOf(':') + 1 && sameOrInside(folder, file.slice(0, slash));
}

function unreachable(value: never): never {
  throw new Error(`Unhandled job outcome state: ${JSON.stringify(value)}`);
}
