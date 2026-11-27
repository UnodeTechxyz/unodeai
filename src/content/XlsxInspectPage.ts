import type { XlsxManifest } from './XlsxWorkbook';
import { appendWorkbookJsonItem } from './WorkbookJsonPage';
import { workbookOutputSize, type CellPosition, type PageBudget } from './WorkbookPage';
import { XlsxInspectRecords } from './XlsxInspectRecords';
import { randomUUID } from 'node:crypto';
export function inspectXlsxPage(directory: string, manifest: XlsxManifest, start: CellPosition, snapshotRef: string, cursor: string, budget: PageBudget) {
  const page = { schema_version: 1, format: 'xlsx', snapshot_ref: snapshotRef, source_sha256: manifest.sha256,
    delivery: 'prepared', delivery_ref: `workbook-delivery-${randomUUID()}`, prepared_fragments: [] as unknown[], remaining: { ...start } as CellPosition | null, next_cursor: cursor as string | null };
  if (start.column !== 1 || start.row < 1 || !Number.isSafeInteger(start.row)) throw new Error('invalid-cursor');
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0) throw new Error('invalid-budget');
  if (workbookOutputSize(JSON.stringify(page), budget) + budget.reserved > budget.limit) throw new Error('route-bound-too-small');
  const records = new XlsxInspectRecords(directory, manifest);
  try {
    for (let index = start.row - 1; index < records.count; index++) {
      const item = records.get(index)!;
      const result = appendWorkbookJsonItem(page, item.kind, item.id, item.record, index === start.row - 1 ? start.byte : 0, budget, (end, total) => {
        page.remaining = end === total ? index === records.count - 1 ? null : { row: index + 2, column: 1, byte: 0 }
          : { row: index + 1, column: 1, byte: end };
        page.next_cursor = page.remaining ? cursor : null;
      });
      if (result !== 'whole') return page;
    }
    page.remaining = null; page.next_cursor = null; return page;
  } finally { records.close(); }
}
