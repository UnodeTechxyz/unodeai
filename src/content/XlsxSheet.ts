import type { SaxesTagNS } from 'saxes';
import { ReadOnlyOpc } from './OpcReadPackage';
import { SHEET_NS } from './XlsxInventory';
import { xmlAttribute } from './WorkbookXml';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import { WorkbookSparseLookup } from './WorkbookSparseLookup';
import { XlsxStringCollector } from './XlsxSharedStrings';
import type { XlsxRichString } from './XlsxCell';
import { columnName, type WorkbookRange } from './WorkbookPage';

export const XLSX_ROWS = 1048576; export const XLSX_COLUMNS = 16384;
export interface XlsxStoredCell { cell: string; type?: string; raw?: string; valuePresent: boolean; inline?: XlsxRichString; styleIndex?: number;
  formula?: { storedText: string; mode: string; sharedIndex?: string; range?: string } }
export interface XlsxStoredRow { row: number; hidden?: boolean; styleIndex?: number; customFormat?: boolean; cells: Array<[number, number]> }
export interface XlsxStoredColumns { min: number; max: number; hidden?: boolean; styleIndex?: number }
export interface XlsxRangeRecord { range: WorkbookRange; sourceCell: string }
export interface XlsxSheetMetadata { rows: number; columns: number; rowRecords: number; cellRecords: number; merges: number; arrayFormulas: number;
  sharedMasters: number; columnDefinitions: number; hiddenRowRecords: number; hiddenRowOverrides: number; defaultRowHidden: boolean; declaredDimension?: string;
  autoFilter?: { range?: string; criteriaPresent: boolean }; arrayRangeUnresolved: boolean }
const integer = (raw: string | undefined) => raw === undefined ? undefined : /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : NaN;
const boolean = (raw: string | undefined) => raw === undefined ? undefined : raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : (() => { throw new Error('invalid-workbook-boolean'); })();
export function xlsxAddress(source: string): { row: number; column: number; cell: string } {
  const match = /^\$?([a-z]+)\$?([1-9]\d*)$/i.exec(source); if (!match) throw new Error('invalid-worksheet-reference');
  let column = 0; for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]); if (column > XLSX_COLUMNS || row > XLSX_ROWS || !Number.isSafeInteger(row)) throw new Error('invalid-worksheet-reference');
  return { row, column, cell: `${columnName(column)}${row}` };
}
export function xlsxRange(source: string): WorkbookRange {
  const parts = source.split(':'); if (parts.length > 2) throw new Error('invalid-worksheet-reference');
  const first = xlsxAddress(parts[0]); const last = xlsxAddress(parts[1] ?? parts[0]);
  if (first.row > last.row || first.column > last.column) throw new Error('invalid-worksheet-reference');
  return { firstRow: first.row, lastRow: last.row, firstColumn: first.column, lastColumn: last.column };
}

/** SAX cells are stored by reference. Shared strings and styles are resolved only for the value currently needed. */
export async function indexXlsxSheet(pkg: ReadOnlyOpc, part: string, directory: string): Promise<XlsxSheetMetadata> {
  const opened: Array<{ close(): void }> = [];
  const create = <T>(name: string) => { const index = new WorkbookJsonIndex<T>(directory, name, true); opened.push(index); return index; };
  try {
  const cells = create<XlsxStoredCell>('cells'); const rows = create<XlsxStoredRow>('rows');
  const cols = create<XlsxStoredColumns>('columns'); const merges = create<XlsxRangeRecord>('merges'); const arrays = create<XlsxRangeRecord>('arrays');
  const hiddenOverrides = create<{ row: number; hidden: boolean }>('hidden-row-overrides');
  const rowPositions = new Uint32Array(XLSX_ROWS + 1); const columnRecords = new Float64Array(XLSX_COLUMNS + 1);
  const touched = new Uint16Array(XLSX_COLUMNS); let touchedCount = 0; const masters = new Map<number, number>();
  const path: string[] = []; let row: XlsxStoredRow | undefined; let cell: XlsxStoredCell | undefined; let column = 0; let previousRow = 0; let lastRow = 0;
  let text: string[] = []; let collector: XlsxStringCollector | undefined;
  const metadata: XlsxSheetMetadata = { rows: 0, columns: 0, rowRecords: 0, cellRecords: 0, merges: 0, arrayFormulas: 0, sharedMasters: 0,
    columnDefinitions: 0, hiddenRowRecords: 0, hiddenRowOverrides: 0, defaultRowHidden: false, arrayRangeUnresolved: false };
  const attr = (tag: SaxesTagNS, name: string) => xmlAttribute(tag, name);
    await pkg.xml(part, { open(tag) {
      path.push(SHEET_NS.has(tag.uri) ? tag.local : '?');
      if (path.length === 1 && path[0] !== 'worksheet') throw new Error('unsupported-sheet-root');
      if (!SHEET_NS.has(tag.uri)) { collector?.open(tag); return; }
      if (path.length === 2 && tag.local === 'dimension') metadata.declaredDimension = attr(tag, 'ref');
      if (path.length === 2 && tag.local === 'sheetFormatPr') metadata.defaultRowHidden = boolean(attr(tag, 'zeroHeight')) ?? false;
      if (path.length === 3 && path[1] === 'cols' && tag.local === 'col') {
        const min = integer(attr(tag, 'min')); const max = integer(attr(tag, 'max')); const styleIndex = integer(attr(tag, 'style'));
        if (!min || !max || min > max || max > XLSX_COLUMNS || (styleIndex !== undefined && !Number.isSafeInteger(styleIndex))) throw new Error('invalid-worksheet-columns');
        cols.append({ min, max, hidden: boolean(attr(tag, 'hidden')), styleIndex });
      }
      if (path.length === 3 && path[1] === 'sheetData' && tag.local === 'row') {
        const number = integer(attr(tag, 'r')) ?? previousRow + 1; const styleIndex = integer(attr(tag, 's'));
        if (!Number.isSafeInteger(number) || number < 1 || number > XLSX_ROWS || rowPositions[number] || (styleIndex !== undefined && !Number.isSafeInteger(styleIndex))) throw new Error('invalid-worksheet-row');
        row = { row: number, hidden: boolean(attr(tag, 'hidden')), styleIndex, customFormat: boolean(attr(tag, 'customFormat')), cells: [] }; column = 0;
      }
      if (path.length === 4 && path[1] === 'sheetData' && path[2] === 'row' && tag.local === 'c') {
        if (!row) throw new Error('invalid-worksheet-cell'); const address = attr(tag, 'r') ? xlsxAddress(attr(tag, 'r')!) : xlsxAddress(`${columnName(column + 1)}${row.row}`);
        const styleIndex = integer(attr(tag, 's')); if (address.row !== row.row || columnRecords[address.column] || (styleIndex !== undefined && !Number.isSafeInteger(styleIndex))) throw new Error('ambiguous-worksheet-cell');
        column = address.column; cell = { cell: address.cell, type: attr(tag, 't'), styleIndex, valuePresent: false };
      }
      if (cell && path.length === 5 && (tag.local === 'v' || tag.local === 'f')) {
        text = []; if (tag.local === 'v') cell.valuePresent = true;
        else cell.formula = { storedText: '', mode: attr(tag, 't') ?? 'normal', sharedIndex: attr(tag, 'si'), range: attr(tag, 'ref') };
      }
      if (cell && path.length === 5 && tag.local === 'is') collector = new XlsxStringCollector();
      collector?.open(tag);
      if (path.length === 3 && path[1] === 'mergeCells' && tag.local === 'mergeCell') { const range = xlsxRange(attr(tag, 'ref') ?? ''); merges.append({ range, sourceCell: `${columnName(range.firstColumn)}${range.firstRow}` });
        metadata.rows = Math.max(metadata.rows, range.lastRow); metadata.columns = Math.max(metadata.columns, range.lastColumn); }
      if (path.length === 2 && tag.local === 'autoFilter') metadata.autoFilter = { range: attr(tag, 'ref'), criteriaPresent: false };
      if (metadata.autoFilter && path.includes('autoFilter') && tag.local === 'filterColumn') metadata.autoFilter.criteriaPresent = true;
    }, text(value) {
      collector?.text(value); if (cell && path.length === 5 && (path[4] === 'v' || path[4] === 'f')) text.push(value);
    }, close() {
      collector?.close(); const name = path[path.length - 1];
      if (cell && path.length === 5 && name === 'v') cell.raw = text.join('');
      if (cell?.formula && path.length === 5 && name === 'f') cell.formula.storedText = text.join('');
      if (cell && path.length === 5 && name === 'is' && collector) { cell.inline = collector.value(); collector = undefined; }
      if (cell && row && path.length === 4 && name === 'c') {
        const index = cells.append(cell); columnRecords[column] = index + 1; touched[touchedCount++] = column;
        metadata.rows = Math.max(metadata.rows, row.row); metadata.columns = Math.max(metadata.columns, column);
        if (cell.formula?.mode === 'shared' && cell.formula.storedText) { const id = integer(cell.formula.sharedIndex);
          if (id !== undefined && id <= 0xffffffff && Number.isSafeInteger(id)) { const packed = (row.row - 1) * XLSX_COLUMNS + column - 1;
            if (masters.has(id)) throw new Error('ambiguous-shared-formula'); masters.set(id, packed); } }
        if (cell.formula?.mode === 'array' && cell.formula.range) {
          let range: WorkbookRange | undefined;
          try { range = xlsxRange(cell.formula.range); } catch { metadata.arrayRangeUnresolved = true; }
          if (range) arrays.append({ range, sourceCell: cell.cell });
        }
        cell = undefined;
      }
      if (row && path.length === 3 && name === 'row') {
        const columns = touched.subarray(0, touchedCount); columns.sort(); for (const number of columns) { row.cells.push([number, columnRecords[number] - 1]); columnRecords[number] = 0; }
        rowPositions[row.row] = rows.append(row) + 1; previousRow = row.row; lastRow = Math.max(lastRow, row.row);
        if (row.hidden) metadata.hiddenRowRecords++;
        if (row.hidden !== undefined) hiddenOverrides.append({ row: row.row, hidden: row.hidden });
        touchedCount = 0; row = undefined;
      }
      path.pop();
    } });
    function* rowLookup(): Generator<[number, number]> { for (let row = 1; row <= lastRow; row++) if (rowPositions[row]) yield [row, rowPositions[row] - 1]; }
    WorkbookSparseLookup.write(directory, 'rows', rowLookup());
    const keys = Uint32Array.from(masters.keys()); keys.sort();
    WorkbookSparseLookup.write(directory, 'shared-masters', (function* (): Generator<[number, number]> { for (const key of keys) yield [key, masters.get(key)!]; })());
    return { ...metadata, rowRecords: rows.count, cellRecords: cells.count, merges: merges.count, arrayFormulas: arrays.count, sharedMasters: masters.size,
      columnDefinitions: cols.count, hiddenRowOverrides: hiddenOverrides.count };
  } finally { for (const index of opened) index.close(); }
}
