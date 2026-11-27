/** Diagnostics only: no reference lookup, permission change or source read. */
export function officeRenderInputIssue(args: Record<string, unknown>): string | undefined {
  const extra = Object.keys(args).filter(key => !['snapshot_ref', 'adapter_id', 'pages'].includes(key));
  if (extra.length) return `Unexpected render_office fields ${extra.join(', ')}. Use only snapshot_ref, adapter_id and optional pages.`;
  if (typeof args.snapshot_ref !== 'string') return 'render_office.snapshot_ref must be the string returned by inspect_office on the target DOCX/PPTX.';
  const pages = args.pages as { start: number; end: number } | undefined;
  if (pages !== undefined && (!pages || typeof pages !== 'object' || Object.keys(pages).some(key => !['start', 'end'].includes(key))
    || !Number.isSafeInteger(pages.start) || !Number.isSafeInteger(pages.end) || pages.start < 1 || pages.end < pages.start)) {
    return 'render_office.pages needs ordered one-based integer start and end, for example {start:1,end:3}; omit pages for all pages.';
  }
  if (!['auto', 'word', 'powerpoint', 'libreoffice'].includes(String(args.adapter_id))) return 'render_office.adapter_id must be auto, word, powerpoint or libreoffice.';
  return undefined;
}
export const OFFICE_SNAPSHOT_RECOVERY = 'Call inspect_office with the authorized target path or source_ref first. '
  + 'Copy its returned snapshot_ref exactly into render_office.snapshot_ref (or edit_office.snapshot_ref). '
  + 'Do not build a ref from a SHA-256, read_workbook or transform_workbook result.';
export function officeRenderFailureHint(error: unknown, operationId?: string): string {
  if (operationId) return `Office render operation ${operationId} could not be observed. Use inspect_operation with that operation_id before starting another render; completion is not confirmed.`;
  const code = error instanceof Error ? error.message : '';
  if (['snapshot-unavailable', 'render-source-unavailable', 'render-source-changed'].includes(code)) {
    return 'Office render could not start: the inspected snapshot, source version or current authority is unavailable. ' + OFFICE_SNAPSHOT_RECOVERY;
  }
  if (code === 'cancelled' || (error instanceof Error && error.name === 'AbortError')) return 'Office render preparation stopped. No render operation was admitted.';
  if (code === 'render-image-unavailable') return 'Office render preparation could not retain a captured image. No successful image delivery is confirmed.';
  if (['render-script-changed', 'render-command-changed'].includes(code)) return 'Office render preparation changed before execution. No successful render is confirmed; use the installed renderer integration again once it is consistent.';
  return 'Office render preparation could not finish; the specific cause is not confirmed. No successful render is confirmed. '
    + OFFICE_SNAPSHOT_RECOVERY + ' If a fresh inspected reference fails, report the preparation failure; do not keep repeating the same call.';
}
