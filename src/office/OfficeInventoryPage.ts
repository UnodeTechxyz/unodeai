import { WorkbookJsonIndex } from '../content/WorkbookJsonIndex';
import { appendWorkbookJsonItem } from '../content/WorkbookJsonPage';
import { workbookOutputSize, type CellPosition, type PageBudget } from '../content/WorkbookPage';
import type { OfficeInventoryManifest, OfficeRecord } from './OfficeInventory';
import { randomUUID } from 'node:crypto';
import type { WordView } from './word/WordRevisionViews';

/** Paragraph records keep every revision view; a page carries only the requested one, in the text field. */
export function projectOfficeRecord(item: OfficeRecord, view: WordView): OfficeRecord {
  if (item.kind !== 'paragraph' || !item.record.views || typeof item.record.views !== 'object') return item;
  const { views, ...rest } = item.record as Record<string, unknown> & { views: Record<string, unknown> };
  return { ...item, record: { ...rest, text: view === 'current' ? rest.text : views[view], view,
    ...(view !== 'markup' && views[`${view}_joins_next`] ? { joins_next_in_view: true } : {}),
    ...(view !== 'markup' && views[`${view}_omitted`] ? { omitted_in_view: true } : {}) } };
}

const WORD_REVISION_COVERAGE = 'body+header/footer; property-diffs, footnotes, endnotes not read';
/** A cursor is host-owned; this fixed worker only consumes its validated index/byte position. */
export function officeInventoryPage(directory: string, manifest: OfficeInventoryManifest, snapshot: string, start: CellPosition, cursor: string, budget: PageBudget, view: WordView = 'current') {
  const page = { schema_version: 1, kind: manifest.kind, snapshot_ref: snapshot, source_sha256: manifest.sha256,
    delivery_ref: `office-delivery-${randomUUID()}`,
    summary: { slides: manifest.slides, objects: manifest.objects, paragraphs: manifest.paragraphs, tables: manifest.tables, gaps: manifest.gaps, bookmarks: manifest.bookmarks ?? 0, controls: manifest.controls ?? 0,
      template: manifest.template, macro_enabled: manifest.macro_enabled, header_footer_parts: manifest.stories?.length ?? 0,
      ...(manifest.kind === 'docx' ? { revisions: manifest.revisions ?? 0, comments: manifest.comments ?? 0, revision_authors: manifest.revision_authors ?? 0 } : {}) },
    ...(manifest.kind === 'docx' ? { view } : {}),
    coverage: { relationships: 'package', text: 'main-document-explicit-runs', table_cells: 'stored-row-cell-ordinals',
      tracked_changes: manifest.kind === 'docx' ? 'revisions-read' : 'stored-revision-text-not-resolved',
      ...(manifest.kind === 'docx' ? { revisions: WORD_REVISION_COVERAGE } : {}),
      bookmarks: 'stored-body-and-header-footer-marker-spans', content_controls: 'stored-body-and-header-footer; bindings-not-resolved', header_footer: 'declared-parts; section-use-inheritance-not-resolved; P#-local-refs', inherited_styles: 'not-resolved', chart_data: 'not-inspected', native_visual_check: 'not-performed' },
    delivery: 'prepared', prepared_fragments: [] as unknown[], next_cursor: cursor as string | null, remaining: { ...start } as CellPosition | null };
  if (start.column !== 1 || !Number.isSafeInteger(start.row) || start.row < 1 || start.row > manifest.records
    || !Number.isSafeInteger(start.byte) || start.byte < 0) throw new Error('invalid-cursor');
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0) throw new Error('invalid-budget');
  if (workbookOutputSize(JSON.stringify(page), budget) + budget.reserved > budget.limit) throw new Error('route-bound-too-small');
  const records = new WorkbookJsonIndex<OfficeRecord>(directory, 'inventory');
  try {
    if (records.count !== manifest.records) throw new Error('invalid-office-index');
    for (let index = start.row - 1; index < records.count; index++) {
      const item = projectOfficeRecord(records.get(index)!, view);
      const result = appendWorkbookJsonItem(page, item.kind, item.id, item.record, index === start.row - 1 ? start.byte : 0, budget, (end, total) => {
        page.remaining = end === total ? index === records.count - 1 ? null : { row: index + 2, column: 1, byte: 0 } : { row: index + 1, column: 1, byte: end };
        page.next_cursor = page.remaining ? cursor : null;
      });
      if (result !== 'whole') return page;
    }
    page.remaining = null; page.next_cursor = null; return page;
  } finally { records.close(); }
}
