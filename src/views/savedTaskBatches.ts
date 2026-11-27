/*---------------------------------------------------------------------------------------------
 *  v0.9.97: what the person sees of saved task batches: one pick per task, and the draft a pick opens.
 *
 *  Pure presentation over the host's records. Opening a draft shows it in an unsaved editor and sends nothing:
 *  recovery of a stopped task's work is the person's explicit choice, never an automatic resend or re-run.
 *--------------------------------------------------------------------------------------------*/

import {
  describeFinalCheck,
  formatSavedBatches,
  type CheckpointAttemptSummary,
  type CheckpointAttemptView,
  type TaskCheckpointRecord,
} from '../backend/TaskCheckpoints';

const STATE_LABELS: Record<CheckpointAttemptView, string> = {
  running: 'running',
  settled: 'finished',
  cancelled: 'stopped — draft',
  interrupted: 'interrupted',
  'window-closed': 'result windows closed',
  'not-running-here': 'not running in this window',
};

export function savedBatchesStateLabel(summary: CheckpointAttemptSummary): string {
  if (!summary.removed) return STATE_LABELS[summary.state];
  // v0.9.99: a finished task's batches can be removed automatically to keep this workspace's history small.
  return summary.removed.reason === 'reclaimed' ? 'removed automatically' : summary.removed.reason;
}

/** One quick-pick row. Nothing in it is model text except the task's objective, which the dispatcher wrote. */
export function savedBatchesPick(summary: CheckpointAttemptSummary, agentName: string): { label: string; description: string; detail: string } {
  const objective = summary.objective.replace(/\s+/g, ' ').trim();
  const shortObjective = objective.length > 70 ? `${objective.slice(0, 69)}…` : objective;
  const kib = (summary.bytes / 1024).toFixed(summary.bytes < 10 * 1024 ? 1 : 0);
  if (summary.removed) {
    return {
      label: `$(archive) ${agentName} · ${shortObjective}`,
      description: `${savedBatchesStateLabel(summary)} ${summary.removed.at}`,
      detail: 'Its saved batches are no longer available.',
    };
  }
  return {
    label: `$(archive) ${agentName} · ${shortObjective}`,
    description: `${savedBatchesStateLabel(summary)} · ${summary.batches} batch(es) · ${kib} KiB`,
    detail: `Covered ${summary.coveredSections.join(', ') || 'none'} · remaining ${summary.remainingSections.join(', ') || 'none'}`
      + `${summary.lastSavedAt ? ` · last saved ${summary.lastSavedAt}` : ''}`
      + `${summary.pinned ? ' · kept while the task runs' : summary.expiresAt ? ` · kept until ${summary.expiresAt}` : ''}`,
  };
}

/**
 * The draft a person opens: what it is, where it stands, then the exact section revisions the final check selected.
 * A stopped task's draft says so at the top, so it is never mistaken for a delivered result.
 */
export function savedBatchesDocument(summary: CheckpointAttemptSummary, agentName: string, batches: readonly TaskCheckpointRecord[]): string {
  const header = [
    `<!-- UnodeAi saved batches, opened by you. Nothing here was sent anywhere. -->`,
    `<!-- Task: ${summary.objective.replace(/-->/g, '- ->')} -->`,
    `<!-- Agent: ${agentName} · state: ${savedBatchesStateLabel(summary)} · final check: ${describeFinalCheck(summary.finalCheck)} -->`,
    ...(summary.state === 'cancelled'
      ? ['<!-- This task was stopped. These are the batches UnodeAi confirmed before the stop: a draft, not a delivered result. -->']
      : []),
  ].join('\n');
  return `${header}\n\n${formatSavedBatches(summary.handle, summary, batches)}\n`;
}

/**
 * The Team panel's few words about a running task that delivers in batches: how many are saved and how much of the
 * plan they cover, or that none is, and whether one is due. The person can wait or press Stop as for any task.
 */
export function workProductLabel(
  progress: { state: 'on-track' | 'checkpoint-due' | 'no-recoverable-product'; activeMsSinceProduct: number },
  summary: CheckpointAttemptSummary | undefined,
): string {
  const saved = summary && summary.batches > 0
    ? `batch ${summary.batches} saved · ${summary.coveredSections.length}/${summary.plan.sections.length} sections`
      + `${summary.lastSavedAt ? ` · last saved ${summary.lastSavedAt.slice(11, 19)} UTC` : ''}`
    : progress.state === 'no-recoverable-product'
      ? `no recoverable work product yet after ${Math.floor(progress.activeMsSinceProduct / 60_000)} min`
      : 'no batch saved yet';
  return `${saved}${progress.state === 'checkpoint-due' ? ' · a batch is due' : ''}`;
}

/** What a delete would remove, said in the confirmation before it happens. */
export function savedBatchesDeletePrompt(summary: CheckpointAttemptSummary): string {
  return `Delete the ${summary.batches} saved batch(es) of "${summary.objective.slice(0, 80)}"? They are removed from this `
    + 'machine and cannot be recovered.';
}
