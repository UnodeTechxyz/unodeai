/*---------------------------------------------------------------------------------------------
 *  UnodeAi - when a real agent start of a managed Codex version fails (v0.9.97)
 *  A failure of the program itself (it did not spawn, never answered `initialize`, spoke malformed JSON-RPC, reported
 *  another version, or exited before it was ready) leads to one immediate check of that version, through the same
 *  final admission as every other check: nothing runs while the external CLI is selected, while suspended, or for a
 *  version with any `disabled` entry. If that check also fails, the version is marked `local-bad`. If it passes, the
 *  failure came from the environment (login, the user's own configuration, the workspace): it is shown, and the
 *  version is not marked. Any other failure is environmental without a check. Nothing is retried.
 *--------------------------------------------------------------------------------------------*/

import type { InstanceRef, StoreId, VersionKey } from '../contracts';
import { boundedDetail } from './keyFacts';
import { recordFailure, recordStopUnconfirmed, runProbeOnce, type QualificationDeps } from './qualification';

export type AgentStartFailureKind =
  | 'spawn-error' | 'no-initialize-response' | 'malformed-json-rpc' | 'version-mismatch' | 'exit-before-ready'
  | 'login' | 'configuration' | 'workspace' | 'other';

export interface AgentStartFailure {
  readonly kind: AgentStartFailureKind;
  readonly detail: string;
}

const PROGRAM_LEVEL: ReadonlySet<AgentStartFailureKind> = new Set<AgentStartFailureKind>([
  'spawn-error', 'no-initialize-response', 'malformed-json-rpc', 'version-mismatch', 'exit-before-ready',
]);

/** Whether a failure is the program's own (and so worth one check of the version) or the environment's. */
export function classifyAgentStartFailure(failure: AgentStartFailure): 'program' | 'environment' {
  return PROGRAM_LEVEL.has(failure.kind) ? 'program' : 'environment';
}

export type AgentStartFailureOutcome =
  /** Shown as the environment's failure; the version is not marked. `checked` says whether a check ran and passed. */
  | { outcome: 'environmental'; checked: boolean; detail: string }
  /** The check failed too: the version is marked `local-bad`. */
  | { outcome: 'local-bad'; detail: string; recorded: boolean }
  /** The check's process may still run; recorded as an unconfirmed stop, which only Check again passes. */
  | { outcome: 'stop-unconfirmed'; detail: string; recorded: boolean }
  /** No check could start (for example while the external CLI is selected); nothing is marked. */
  | { outcome: 'not-checked'; detail: string };

/** One immediate check after a program-level failure of a real agent start of `key`. */
export async function checkAfterAgentStartFailure(
  deps: QualificationDeps,
  ref: InstanceRef,
  key: VersionKey,
  failure: AgentStartFailure,
): Promise<AgentStartFailureOutcome> {
  if (classifyAgentStartFailure(failure) === 'environment') {
    return { outcome: 'environmental', checked: false, detail: boundedDetail(failure.detail) };
  }
  const run = await runProbeOnce(deps, ref, key, 'qualification');
  if (!run.ran) return { outcome: 'not-checked', detail: run.outcome.detail };
  if (run.result.result === 'stop-unconfirmed') {
    const recorded = await recordStopUnconfirmed(deps, run);
    return { outcome: 'stop-unconfirmed', detail: recorded.outcome === 'stop-unconfirmed' ? recorded.detail : '', recorded: recorded.outcome === 'stop-unconfirmed' && recorded.recorded };
  }
  if (run.result.result === 'fail') {
    const recorded = await recordFailure(deps, run, 'local-bad');
    return { outcome: 'local-bad', detail: boundedDetail(`${failure.detail}; its check failed too (${run.result.detail ?? 'no detail'})`), recorded: recorded.outcome === 'failed' && recorded.recorded };
  }
  try { await deps.instance.removeWorkFolder(run.work); } catch { /* best effort */ }
  try { deps.instance.releaseLease(run.start.lease); } catch { /* counts as alive until collected */ }
  return { outcome: 'environmental', checked: true, detail: boundedDetail(failure.detail) };
}

/**
 * The checks after failed agent starts in this window: one at a time per version, and a failure that arrives while
 * that version's check runs is answered by the same check. Nothing is retried.
 */
export class AgentStartFailureChecks {
  private readonly running = new Map<string, Promise<AgentStartFailureOutcome>>();

  constructor(private readonly deps: QualificationDeps) {}

  check(storeId: StoreId, key: VersionKey, failure: AgentStartFailure): Promise<AgentStartFailureOutcome> {
    if (classifyAgentStartFailure(failure) === 'environment') {
      return Promise.resolve({ outcome: 'environmental', checked: false, detail: boundedDetail(failure.detail) });
    }
    const id = `${storeId}|${key}`;
    const running = this.running.get(id);
    if (running) return running;
    const open = this.deps.instance.open(storeId);
    if (!open.ok) return Promise.resolve({ outcome: 'not-checked', detail: boundedDetail(open.detail) });
    const check = checkAfterAgentStartFailure(this.deps, open.ref, key, failure).finally(() => this.running.delete(id));
    this.running.set(id, check);
    return check;
  }
}
