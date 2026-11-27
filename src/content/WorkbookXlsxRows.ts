import { join } from 'node:path';
import { XlsxPointReader, xlsxRangeContains } from './XlsxPointReader';
import { columnName } from './WorkbookPage';
import { XLSX_COLUMNS, XLSX_ROWS, xlsxAddress } from './XlsxSheet';
import type { XlsxManifest, XlsxIndexedSheet } from './XlsxWorkbook';
import { workbookNumericLiteral, type WorkbookDatum, type WorkbookRow, type WorkbookRowBlock } from './WorkbookAggregate';
import { WorkbookExactNumber } from './WorkbookExactNumber';
import { workbookDateDisplay, workbookNumberDisplay } from './WorkbookDisplay';
import type { WorkbookSourceColumn } from './WorkbookCsvRows';
export interface WorkbookSourceCounts { includedRows: number; excludedRows: number; hiddenRows: number; hiddenColumns: number; excludedColumns: number;
  mergeAnchorCells?: number; hiddenAnchorRows?: number; hiddenAnchorColumns?: number }
/** Stored cache values only. Covered merge cells remain structural, never duplicated numeric anchors. */
export async function* xlsxWorkbookRows(directory: string, manifest: XlsxManifest, sheet: XlsxIndexedSheet, firstRow: number, lastRow: number,
  columns: WorkbookSourceColumn[], visibility: 'all' | 'visible-only', counts: WorkbookSourceCounts, progress: () => void): AsyncGenerator<WorkbookRowBlock> {
  if (!sheet.directory || !sheet.metadata || sheet.gap) throw new Error('unavailable-worksheet');
  if (![firstRow, lastRow].every(Number.isSafeInteger) || firstRow < 1 || lastRow < 0 || lastRow > XLSX_ROWS || (lastRow && lastRow < firstRow)
    || columns.some(column => !Number.isSafeInteger(column.column) || column.column < 1 || column.column > XLSX_COLUMNS || !column.as)
    || new Set(columns.map(column => column.as)).size !== columns.length) throw new Error('invalid-source-selection');
  const reader = new XlsxPointReader(directory, join(directory, sheet.directory), sheet.metadata, manifest.date1904);
  const anchors = new Map<string, WorkbookDatum>(); const anchorCells = new Set<string>(); const hiddenAnchorRows = new Set<number>(); const hiddenAnchorColumns = new Set<number>();
  const scalar = (row: number, column: WorkbookSourceColumn, memo: Map<string, WorkbookDatum>): WorkbookDatum => {
    if (visibility === 'visible-only' && reader.hiddenColumns[column.column]) return { kind: 'excluded', reason: 'saved-hidden-column' };
    const merged = reader.merges.filter(item => xlsxRangeContains(item.range, row, column.column));
    if (merged.length > 1) return { kind: 'missing', reason: 'ambiguous-merged-ranges' };
    if (merged[0] && merged[0].sourceCell !== `${columnName(column.column)}${row}`) {
      const from = merged[0].sourceCell; const address = xlsxAddress(from); const key = `${from}:${column.as_number}`; let anchor = anchors.get(key);
      if (!anchor) {
        if (visibility === 'visible-only' && (reader.rowHidden(address.row) || reader.hiddenColumns[address.column])) anchor = { kind: 'excluded', reason: 'saved-hidden-merge-anchor' };
        else {
          anchor = scalar(address.row, { ...column, column: address.column }, new Map()); anchorCells.add(from); counts.mergeAnchorCells = anchorCells.size;
          if (reader.rowHidden(address.row) && (address.row < firstRow || address.row > lastRow)) hiddenAnchorRows.add(address.row);
          if (reader.hiddenColumns[address.column] && !columns.some(column => column.column === address.column)) hiddenAnchorColumns.add(address.column);
          counts.hiddenAnchorRows = hiddenAnchorRows.size; counts.hiddenAnchorColumns = hiddenAnchorColumns.size;
        }
        anchors.set(key, anchor);
      }
      return { kind: 'merged', from, anchor };
    }
    const stored = reader.stored(row, column.column); const key = stored?.type === 's' && stored.valuePresent ? `${stored.raw}:${column.as_number}` : undefined;
    const prior = key === undefined ? undefined : memo.get(key); if (prior) return prior;
    const cell = reader.cell(row, column.column); const value = cell?.value; if (!value) return { kind: 'missing', reason: 'absent-cell' };
    if (value.kind === 'number') {
      const numeric = workbookNumericLiteral(value.raw.trim());
      const display = workbookNumberDisplay(WorkbookExactNumber.parse(value.raw.trim()), cell!.numberFormat, manifest.date1904);
      return display ? { ...numeric, display } : numeric;
    }
    if (value.kind === 'date-serial') return { ...value, display: workbookDateDisplay(value.raw, value.epoch, cell!.numberFormat) };
    if (value.kind === 'string' || value.kind === 'rich-string') {
      const result: WorkbookDatum = column.as_number ? workbookNumericLiteral(value.text) : { kind: 'string', text: value.text, ...(value.escapedCodeUnitsUnresolved ? { escapedCodeUnitsUnresolved: true } : {}) };
      if (key !== undefined) memo.set(key, result); return result;
    }
    if (value.kind === 'blank') return { kind: 'missing', reason: 'blank-cell' };
    if (value.kind === 'unresolved') return { kind: 'missing', reason: value.reason };
    if (value.kind === 'boolean') return { kind: 'boolean', value: value.value };
    if (value.kind === 'merged' || value.kind === 'error' || value.kind === 'iso-date') return value;
    throw new Error('unsupported-workbook-value');
  };
  try {
    counts.hiddenColumns = new Set(columns.filter(column => reader.hiddenColumns[column.column]).map(column => column.column)).size;
    counts.excludedColumns = visibility === 'visible-only' ? counts.hiddenColumns : 0;
    const regions = [...reader.merges, ...reader.arrays];
    for (let row = firstRow; row <= lastRow;) {
      progress(); const stored = reader.row(row); let end = stored ? row : Math.min(lastRow, (reader.nextRow(row) ?? lastRow + 1) - 1);
      for (const region of regions) {
        if (region.range.firstRow > row) end = Math.min(end, region.range.firstRow - 1);
        else if (region.range.lastRow >= row) end = Math.min(end, region.range.lastRow, region.range.firstRow === row ? row : lastRow);
      }
      const repeat = end - row + 1; const hidden = reader.rowHidden(row); if (hidden) counts.hiddenRows += repeat;
      if (visibility === 'visible-only' && hidden) counts.excludedRows += repeat;
      else {
        const cells: WorkbookRow = Object.create(null); const memo = new Map<string, WorkbookDatum>();
        for (const column of columns) { progress(); cells[column.as] = scalar(row, column, memo); }
        counts.includedRows += repeat; yield { cells, repeat };
      }
      row = end + 1;
    }
  } finally { reader.close(); }
}
