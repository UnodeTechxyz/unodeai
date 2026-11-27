import { XlsxPointReader, xlsxRangeContains } from './XlsxPointReader';
import type { XlsxManifest, XlsxIndexedSheet } from './XlsxWorkbook';
import { appendWorkbookJsonItem } from './WorkbookJsonPage';
import { columnName, workbookOutputSize, type CellPosition, type WorkbookRange, type PageBudget } from './WorkbookPage';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface XlsxPage { schema_version: 1; format: 'xlsx'; snapshot_ref: string; source_sha256: string; sheet_id: string;
  delivery_ref?: string;
  source: { date1904: boolean; cache: string }; range: string; visibility: 'all' | 'visible-only'; selection: 'saved-hidden-state-only'; delivery: 'prepared';
  prepared_fragments: unknown[]; remaining: CellPosition | null; next_cursor: string | null }
const address = (row: number, column: number) => `${columnName(column)}${row}`;
const rangeName = (firstRow: number, firstColumn: number, lastRow: number, lastColumn: number) => `${address(firstRow, firstColumn)}:${address(lastRow, lastColumn)}`;

/** Stored cells, absent rectangles and saved visibility are paged without materializing a whole sheet/grid. */
export function readXlsxPage(directory: string, manifest: XlsxManifest, sheet: XlsxIndexedSheet, range: WorkbookRange, start: CellPosition,
  snapshotRef: string, cursor: string, visibility: 'all' | 'visible-only', budget: PageBudget, progress: () => void): XlsxPage {
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0) throw new Error('invalid-budget');
  if (!sheet.directory || !sheet.metadata || sheet.gap) throw new Error('unavailable-worksheet');
  const page: XlsxPage = { schema_version: 1, format: 'xlsx', snapshot_ref: snapshotRef, source_sha256: manifest.sha256, sheet_id: sheet.sheetId,
    source: { date1904: manifest.date1904, cache: manifest.cache }, range: range.lastRow && range.lastColumn ? rangeName(range.firstRow, range.firstColumn, range.lastRow, range.lastColumn) : 'empty',
    visibility, selection: 'saved-hidden-state-only', delivery: 'prepared', delivery_ref: `workbook-delivery-${randomUUID()}`, prepared_fragments: [], remaining: { ...start }, next_cursor: cursor };
  const fits = () => workbookOutputSize(JSON.stringify(page), budget) + budget.reserved <= budget.limit;
  if (!fits()) throw new Error('route-bound-too-small');
  if (![start.row, start.column, start.byte].every(Number.isSafeInteger) || start.row < range.firstRow || start.column < range.firstColumn
    || (range.lastColumn > 0 && start.column > range.lastColumn) || start.byte < 0) throw new Error('invalid-cursor');
  const reader = new XlsxPointReader(directory, join(directory, sheet.directory), sheet.metadata, manifest.date1904);
  let position = { ...start };
  const update = () => { page.remaining = position.row > range.lastRow ? null : { ...position }; page.next_cursor = page.remaining ? cursor : null; };
  const advance = (lastRow = position.row, lastColumn = position.column) => {
    position.byte = 0; if (lastColumn < range.lastColumn) position.column = lastColumn + 1;
    else { position.row = lastRow + 1; position.column = range.firstColumn; } update();
  };
  const appendBlock = (record: object, endRow: number, endColumn: number) => {
    const before = { ...position }; page.prepared_fragments.push(record); advance(endRow, endColumn);
    if (fits()) return true; page.prepared_fragments.pop(); position = before; update();
    if (!page.prepared_fragments.length) throw new Error('route-bound-too-small'); return false;
  };
  try {
    const regions = [...reader.merges.map(item => ({ ...item, kind: 'merged-range' })), ...reader.arrays.map(item => ({ ...item, kind: 'unresolved-array-range' }))];
    while (position.row <= range.lastRow && range.lastColumn > 0) {
      progress(); const { row, column } = position; const sourceRow = reader.row(row); const rowHidden = reader.rowHidden(row);
      let endRow = sourceRow ? row : Math.min(range.lastRow, (reader.nextRow(row) ?? range.lastRow + 1) - 1);
      for (const region of regions) {
        if (region.range.firstRow > row) endRow = Math.min(endRow, region.range.firstRow - 1);
        else if (region.range.lastRow >= row) endRow = Math.min(endRow, region.range.lastRow, region.range.firstRow === row ? row : range.lastRow);
      }
      if (visibility === 'visible-only' && rowHidden) {
        if (!appendBlock({ kind: 'excluded-range', range: rangeName(row, column, endRow, range.lastColumn), reason: 'saved-hidden-row' }, endRow, range.lastColumn)) return page;
        continue;
      }
      if (visibility === 'visible-only' && reader.hiddenColumns[column]) {
        let end = column; while (end < range.lastColumn && reader.hiddenColumns[end + 1]) end++;
        if (!appendBlock({ kind: 'excluded-range', range: rangeName(row, column, endRow, end), reason: 'saved-hidden-column' }, endRow, end)) return page;
        continue;
      }
      const stored = reader.stored(row, column); const active = regions.filter(region => xlsxRangeContains(region.range, row, column));
      if (stored || active.some(region => region.sourceCell === address(row, column))) {
        const cell = reader.cell(row, column)!; const before = { ...position };
        const result = appendWorkbookJsonItem(page, 'cell', cell.cell, cell, position.byte, budget, (end, total) => {
          position = { ...before }; if (end === total) advance(); else { position.byte = end; update(); }
        });
        if (result !== 'whole') return page;
        continue;
      }
      // No stored value: a rectangle may cover many absent rows without visiting every empty cell.
      let endColumn = range.lastColumn;
      const nextCell = sourceRow?.cells.find(([sourceColumn]) => sourceColumn > column); if (nextCell) endColumn = Math.min(endColumn, nextCell[0] - 1);
      if (visibility === 'visible-only') for (let number = column + 1; number <= endColumn; number++) if (reader.hiddenColumns[number]) { endColumn = number - 1; break; }
      for (const region of regions) if (row >= region.range.firstRow && row <= region.range.lastRow) {
        if (region.range.firstColumn > column) endColumn = Math.min(endColumn, region.range.firstColumn - 1);
        else if (region.range.lastColumn >= column) endColumn = Math.min(endColumn, region.range.lastColumn);
      }
      const fragment = active.length > 1 ? { kind: 'unresolved-range', reason: 'overlapping-source-regions' }
        : active[0] ? { kind: active[0].kind, source_cell: active[0].sourceCell } : { kind: 'absent-range' };
      if (!appendBlock({ ...fragment, range: rangeName(row, column, endRow, endColumn) }, endRow, endColumn)) return page;
    }
    page.remaining = null; page.next_cursor = null; return page;
  } finally { reader.close(); }
}
