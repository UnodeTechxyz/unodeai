import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import { WorkbookSparseLookup } from './WorkbookSparseLookup';
import { xlsxScalar, type XlsxCellRecord, type XlsxNumberFormat, type XlsxRichString } from './XlsxCell';
import { XLSX_COLUMNS, type XlsxStoredCell, type XlsxStoredRow, type XlsxStoredColumns, type XlsxRangeRecord, type XlsxSheetMetadata } from './XlsxSheet';
import { columnName } from './WorkbookPage';
import { WorkbookValueCache } from './WorkbookValueCache';

export const xlsxRangeContains = (range: XlsxRangeRecord['range'], row: number, column: number) =>
  row >= range.firstRow && row <= range.lastRow && column >= range.firstColumn && column <= range.lastColumn;

/** Resolves only one current cell, retaining SST/style references in storage instead of multiplying their bytes. */
export class XlsxPointReader {
  private readonly rowLookup: WorkbookSparseLookup; private readonly rows: WorkbookJsonIndex<XlsxStoredRow>;
  private readonly cells: WorkbookJsonIndex<XlsxStoredCell>; private readonly masters: WorkbookSparseLookup;
  private readonly shared: WorkbookJsonIndex<XlsxRichString>; private readonly formats: WorkbookJsonIndex<XlsxNumberFormat>;
  readonly merges: XlsxRangeRecord[] = []; readonly arrays: XlsxRangeRecord[] = [];
  readonly hiddenColumns = new Uint8Array(XLSX_COLUMNS + 1); private readonly columnStyles = new Float64Array(XLSX_COLUMNS + 1).fill(-1);
  private lastRow?: XlsxStoredRow; private lastRowNumber = -1;
  private readonly sharedCache = new WorkbookValueCache<XlsxRichString>();
  private readonly formatCache = new WorkbookValueCache<XlsxNumberFormat>();
  constructor(workbook: string, directory: string, readonly metadata: XlsxSheetMetadata, private readonly date1904: boolean) {
    try {
    this.rowLookup = new WorkbookSparseLookup(directory, 'rows'); this.rows = new WorkbookJsonIndex(directory, 'rows'); this.cells = new WorkbookJsonIndex(directory, 'cells');
    this.masters = new WorkbookSparseLookup(directory, 'shared-masters'); this.shared = new WorkbookJsonIndex(workbook, 'shared-strings'); this.formats = new WorkbookJsonIndex(workbook, 'number-formats');
    const cols = new WorkbookJsonIndex<XlsxStoredColumns>(directory, 'columns'); const merges = new WorkbookJsonIndex<XlsxRangeRecord>(directory, 'merges'); const arrays = new WorkbookJsonIndex<XlsxRangeRecord>(directory, 'arrays');
    try {
      for (let index = 0; index < cols.count; index++) { const col = cols.get(index)!; for (let number = col.min; number <= col.max; number++) {
        if (col.hidden !== undefined) this.hiddenColumns[number] = col.hidden ? 1 : 0; if (col.styleIndex !== undefined) this.columnStyles[number] = col.styleIndex;
      } }
      for (let index = 0; index < merges.count; index++) this.merges.push(merges.get(index)!);
      for (let index = 0; index < arrays.count; index++) this.arrays.push(arrays.get(index)!);
    } finally { cols.close(); merges.close(); arrays.close(); }
    } catch (error) { this.close(); throw error; }
  }
  row(number: number): XlsxStoredRow | undefined {
    if (this.lastRowNumber !== number) { this.lastRowNumber = number; const index = this.rowLookup.get(number); this.lastRow = index === undefined ? undefined : this.rows.get(index); }
    return this.lastRow;
  }
  nextRow(number: number): number | undefined { return this.rowLookup.lowerBound(number)?.key; }
  rowHidden(number: number): boolean { return this.row(number)?.hidden ?? this.metadata.defaultRowHidden; }
  stored(row: number, column: number): XlsxStoredCell | undefined {
    const items = this.row(row)?.cells; if (!items) return undefined;
    let low = 0; let high = items.length; while (low < high) { const mid = Math.floor((low + high) / 2); if (items[mid][0] < column) low = mid + 1; else high = mid; }
    return items[low]?.[0] === column ? this.cells.get(items[low][1]) : undefined;
  }
  cell(row: number, column: number): XlsxCellRecord | undefined {
    const stored = this.stored(row, column); const name = `${columnName(column)}${row}`;
    const merged = this.merges.filter(item => xlsxRangeContains(item.range, row, column)); const array = this.arrays.find(item => xlsxRangeContains(item.range, row, column));
    if (!stored && !merged.length && !array) return undefined;
    const sourceRow = this.row(row); const rowStyle = sourceRow?.customFormat ? sourceRow.styleIndex : undefined;
    const colStyle = this.columnStyles[column] >= 0 ? this.columnStyles[column] : undefined;
    const styleIndex = stored ? stored.styleIndex ?? 0 : rowStyle ?? colStyle ?? 0;
    const format = this.formatCache.get(styleIndex, () => this.formats.get(styleIndex)) ?? { id: -1, interpretation: 'uninterpreted' as const };
    let value = xlsxScalar(stored?.type, stored?.raw, stored?.inline, index => this.sharedCache.get(index, () => this.shared.get(index)), format, this.date1904);
    const result: XlsxCellRecord = { cell: name, value, sourceCellPresent: stored !== undefined, styleIndex, numberFormat: format,
      hiddenRow: this.rowHidden(row), hiddenColumn: !!this.hiddenColumns[column],
      styleSource: stored ? stored.styleIndex !== undefined ? 'cell' : 'default' : rowStyle !== undefined ? 'row' : colStyle !== undefined ? 'column' : 'default' };
    if (stored?.formula) {
      const formula = stored.formula; const id = formula.sharedIndex === undefined ? NaN : Number(formula.sharedIndex);
      const master = Number.isInteger(id) && id >= 0 && id <= 0xffffffff ? this.masters.get(id) : undefined;
      result.formula = { ...formula, expanded: false, cachePresent: stored.valuePresent,
        ...(stored.valuePresent ? { cachedResult: value } : {}), ...(master === undefined ? {} : { sourceCell: `${columnName(master % XLSX_COLUMNS + 1)}${Math.floor(master / XLSX_COLUMNS) + 1}` }) };
      if (!stored.valuePresent) value = { kind: 'unresolved', reason: 'formula-cache-missing' };
    }
    if (array && array.sourceCell !== name) { result.arrayFormulaFrom = array.sourceCell; if (!stored?.valuePresent) value = { kind: 'unresolved', reason: 'array-cache-missing' }; }
    if (merged.length > 1) value = { kind: 'unresolved', reason: 'ambiguous-merged-ranges' };
    else if (merged[0] && merged[0].sourceCell !== name) { result.mergedFrom = merged[0].sourceCell;
      if (stored) result.coveredSourceValue = value; value = { kind: 'merged', from: merged[0].sourceCell }; }
    result.value = value; return result;
  }
  close(): void { for (const resource of [this.rowLookup, this.rows, this.cells, this.masters, this.shared, this.formats]) resource?.close(); }
}
