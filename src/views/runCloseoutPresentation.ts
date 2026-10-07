import type { RunRecord, RunSummary } from '../observability/RunLedger';

type RunCloseoutCarrier = Pick<RunRecord, 'status' | 'closeoutCompletionState'>;

/** A closed run can still be an incomplete delivery; keep that fact ahead of the generic closed state. */
export function runCloseoutPresentation(
  run: RunCloseoutCarrier,
): { icon: '$(clock)' | '$(warning)' | '$(check)'; label: string } {
  if (run.status === 'open') return { icon: '$(clock)', label: 'open' };
  if (run.closeoutCompletionState === 'partial') return { icon: '$(warning)', label: 'closed · partial' };
  return { icon: '$(check)', label: 'closed · complete' };
}

/** What a person reviews before giving a human verdict. These are framework receipts, never agent prose. */
export function runAcceptanceEvidence(run: RunRecord): string {
  const settled = run.delegations.filter((delegation) => delegation.state === 'settled');
  const outcomes = settled.length
    ? settled.map((delegation) => `${delegation.handle}: ${delegation.evidence?.outcome ?? 'no evidence'}`).join('; ')
    : 'no settled delegations';
  const changed = settled.reduce((count, delegation) => count + (delegation.evidence?.changedFiles.length ?? 0), 0);
  const verified = settled.filter((delegation) => delegation.evidence?.verification.passed).length;
  const dispositions = settled.flatMap((delegation) => delegation.dispositions.map((event) => event.disposition));
  const closeout = runCloseoutPresentation(run);
  return [
    `Run ${run.id} is ${closeout.label}.`,
    `Framework outcomes: ${outcomes}.`,
    `Observed writes: ${changed} file(s); passing verification: ${verified}/${settled.length} settled delegation(s).`,
    `Coordinator dispositions: ${dispositions.length ? dispositions.join(', ') : 'none recorded'}.`,
    'This is evidence for your review, not a verdict. Declining to judge records nothing.',
  ].join('\n\n');
}

export function acceptanceRunPickerDescription(run: RunSummary): string {
  return `${runCloseoutPresentation(run).label} · ${new Date(run.startedAt).toLocaleString()}`;
}

export function markdownRunExportPickerLabel(run: RunSummary, coordinatorName: string): string {
  const closeout = runCloseoutPresentation(run);
  return `${closeout.icon} ${coordinatorName} - ${closeout.label}`;
}

export function portableRunExportPickerLabel(run: RunSummary, coordinatorName: string): string {
  const closeout = runCloseoutPresentation(run);
  return `${closeout.icon} ${coordinatorName} - ${closeout.label}`;
}

export function runEvidenceExportConfirmation(run: Pick<RunRecord, 'closeoutCompletionState' | 'droppedActivityItems'>): string {
  if (run.droppedActivityItems > 0) {
    return `Exported run evidence pack; ${run.droppedActivityItems} activity item(s) were omitted and declared in the pack.`;
  }
  return run.closeoutCompletionState === 'partial'
    ? 'Exported partial-closeout run evidence pack.'
    : 'Exported complete run evidence pack.';
}
