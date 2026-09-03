import type { ContextMeterState } from '../types';

/** Why a compaction could not run. Absent when one did run, whether or not it dropped anything. */
export type CompactUnavailableReason = 'unknown-session' | 'not-started' | 'unsupported';

export interface CompactOutcome {
  supported: boolean;
  compacted: boolean;
  dropped: number;
  reason?: CompactUnavailableReason;
}

/**
 * The sentence a user gets after asking for a compaction, derived from what actually happened.
 *
 * This exists as a pure function because the wrong sentence was chosen in a branch no test could reach.
 * `compactSession` returned a bare `supported: false` for two unrelated conditions — a runtime that owns its
 * own context, and an agent that had not been started — and both call sites rendered the first. The composer
 * meter said "start the agent" while pressing the same action said "this backend manages its own context":
 * two host surfaces contradicting each other about one agent. (Codex audit, 2026-08-11.)
 */
export function compactOutcomeMessage(outcome: CompactOutcome, agentName?: string): string {
  const who = agentName ? `${agentName} ` : 'This agent ';
  if (outcome.reason === 'not-started') {
    return `${who}is not running, so there is no conversation held here to compact. Start it and try again.`;
  }
  if (outcome.reason === 'unsupported') {
    return `${who}runs on a backend that manages its own context; there is nothing for UnodeAi to compact.`;
  }
  if (outcome.reason === 'unknown-session') {
    return 'That agent is no longer on the roster.';
  }
  if (outcome.compacted) {
    const plural = outcome.dropped === 1 ? '' : 's';
    return `Compacted ${outcome.dropped} older message${plural} into a rolling summary. Recent messages are unchanged.`;
  }
  // Reached only when a compaction really ran and planned nothing. Naming the likeliest cause matters here:
  // this is the answer a user gets while a gateway is still rejecting the turn.
  return 'Nothing could be compacted — this conversation has no older turns beyond the ones kept as anchors. '
    + 'If a gateway is still rejecting it as too large, the context window set for this agent is larger '
    + 'than the model actually accepts.';
}

/** The meter and the action must agree about one agent; both read the same runtime fact. */
export function unavailableReasonForMeter(meter: ContextMeterState | undefined): CompactUnavailableReason | undefined {
  if (!meter) { return 'unknown-session'; }
  return meter.kind === 'not-started' ? 'not-started' : meter.kind === 'unsupported' ? 'unsupported' : undefined;
}
