import { expect, it } from 'vitest';
import { officeRenderFailureHint, officeRenderInputIssue } from '../OfficeToolDiagnostics';
it('keeps input validation independent of guessed reference validity and names the malformed field', () => {
  expect(officeRenderInputIssue({ snapshot_ref: 'invented', adapter_id: 'auto' })).toBeUndefined();
  expect(officeRenderInputIssue({ snapshot_ref: 42, adapter_id: 'auto' })).toContain('snapshot_ref');
  expect(officeRenderInputIssue({ snapshot_ref: 'x', adapter_id: 'auto', pages: { start: 0, end: 1 } })).toContain('pages');
  expect(officeRenderInputIssue({ snapshot_ref: 'x', adapter_id: 'auto', final: true })).toContain('final');
});
it('distinguishes unavailable refs, unknown preparation errors and already admitted operations without leaking raw failures', () => {
  expect(officeRenderFailureHint(Error('snapshot-unavailable'))).toContain('inspect_office');
  expect(officeRenderFailureHint(Error('render-script-changed'))).toContain('changed before execution');
  const unknown = officeRenderFailureHint(Error('SECRET_PRIVATE_BACKEND_DIAGNOSTIC'));
  expect(unknown).toContain('specific cause is not confirmed'); expect(unknown).not.toContain('SECRET_PRIVATE');
  expect(unknown).not.toContain('snapshot, source version or current authority is unavailable');
  const admitted = officeRenderFailureHint(Error('render-source-changed'), 'operation-123');
  expect(admitted).toContain('inspect_operation'); expect(admitted).toContain('completion is not confirmed');
  expect(admitted).not.toContain('could not start');
});
