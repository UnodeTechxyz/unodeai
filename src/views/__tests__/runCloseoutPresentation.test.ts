import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { RunRecord, RunSummary } from '../../observability/RunLedger';
import {
  acceptanceRunPickerDescription,
  markdownRunExportPickerLabel,
  portableRunExportPickerLabel,
  runAcceptanceEvidence,
  runCloseoutPresentation,
  runEvidenceExportConfirmation,
} from '../runCloseoutPresentation';

function run(closeoutCompletionState: 'complete' | 'partial'): RunRecord {
  return {
    schemaVersion: 7,
    id: 'run-1',
    coordinatorId: 'pm',
    correlationIds: ['root-1'],
    status: 'closed',
    startedAt: '2026-08-31T00:00:00.000Z',
    endedAt: '2026-08-31T00:01:00.000Z',
    closeoutCompletionState,
    delegations: [],
    refusedDispatches: [],
    permissions: [],
    contextReceipts: [],
    activity: [],
    droppedActivityItems: 0,
  };
}

function summary(closeoutCompletionState: 'complete' | 'partial'): RunSummary {
  const value = run(closeoutCompletionState);
  return {
    id: value.id,
    coordinatorId: value.coordinatorId,
    status: value.status,
    startedAt: value.startedAt,
    closeoutCompletionState,
  };
}

describe('run closeout presentation', () => {
  it('keeps partial distinct from both open and complete', () => {
    expect(runCloseoutPresentation({ status: 'open' })).toEqual({ icon: '$(clock)', label: 'open' });
    expect(runCloseoutPresentation(run('complete'))).toEqual({ icon: '$(check)', label: 'closed · complete' });
    expect(runCloseoutPresentation(run('partial'))).toEqual({ icon: '$(warning)', label: 'closed · partial' });
  });

  it('shows partial in the human acceptance evidence', () => {
    const rendered = runAcceptanceEvidence(run('partial'));
    expect(rendered).toContain('Run run-1 is closed · partial.');
    expect(rendered).not.toContain('closed · complete');
  });

  it('shows partial in the acceptance picker description', () => {
    const rendered = acceptanceRunPickerDescription(summary('partial'));
    expect(rendered).toContain('closed · partial');
    expect(rendered).not.toContain('closed · complete');
  });

  it('does not give a partial Markdown export a complete icon or label', () => {
    const rendered = markdownRunExportPickerLabel(summary('partial'), 'PM');
    expect(rendered).toBe('$(warning) PM - closed · partial');
    expect(rendered).not.toContain('$(check)');
    expect(rendered).not.toContain('complete');
  });

  it('does not give a partial portable export a complete icon or label', () => {
    const rendered = portableRunExportPickerLabel(summary('partial'), 'PM');
    expect(rendered).toBe('$(warning) PM - closed · partial');
    expect(rendered).not.toContain('$(check)');
    expect(rendered).not.toContain('complete');
  });

  it('uses a partial-specific Markdown export confirmation', () => {
    expect(runEvidenceExportConfirmation(run('partial'))).toBe('Exported partial-closeout run evidence pack.');
    expect(runEvidenceExportConfirmation(run('complete'))).toBe('Exported complete run evidence pack.');
  });

  it('keeps every high-consequence extension surface wired to its explicit projection', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('description: acceptanceRunPickerDescription(candidate)');
    expect(source).toContain('runAcceptanceEvidence(run)');
    expect(source).toContain('label: markdownRunExportPickerLabel(run, resolveAgentName(run.coordinatorId))');
    expect(source).toContain('label: portableRunExportPickerLabel(run, resolveAgentName(run.coordinatorId))');
    expect(source).toContain('showInformationMessage(runEvidenceExportConfirmation(run))');
  });
});
