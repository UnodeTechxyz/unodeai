import { openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { CsvManifest } from './CsvWorkbook';
import { workbookNumericLiteral, type WorkbookRow, type WorkbookRowBlock } from './WorkbookAggregate';
export interface WorkbookSourceColumn { column: number; as: string; as_number: boolean }
/** Private source adapter: exact field text, explicit numeric conversion and sparse absent-row runs. */
export async function* csvWorkbookRows(directory: string, source: CsvManifest, firstRow: number, lastRow: number,
  columns: WorkbookSourceColumn[], digitAllowance: number | undefined, progress: () => void): AsyncGenerator<WorkbookRowBlock> {
  if (![firstRow, lastRow].every(Number.isSafeInteger) || firstRow < 1 || lastRow < 0 || (lastRow && lastRow < firstRow)
    || columns.some(column => !Number.isSafeInteger(column.column) || column.column < 1 || !column.as)
    || new Set(columns.map(column => column.as)).size !== columns.length) throw new Error('invalid-source-selection');
  const files: number[] = [];
  const open = (name: string) => { const file = openSync(join(directory, name), 'r'); files.push(file); return file; };
  const read = (file: number, offset: number, length: number) => {
    if (![offset, length].every(Number.isSafeInteger) || offset < 0 || length < 0) throw new Error('invalid-workbook-index');
    const bytes = Buffer.alloc(length); let at = 0;
    while (at < length) { const count = readSync(file, bytes, at, length - at, offset + at); if (!count) throw new Error('invalid-workbook-index'); at += count; }
    return bytes;
  };
  try {
    if (!columns.length) { if (lastRow >= firstRow) { progress(); yield { cells: Object.create(null), repeat: lastRow - firstRow + 1 }; } return; }
    const rows = open('rows.index'); const cells = open('cells.index'); const values = open('values.utf8');
    const lastStored = Math.min(source.rows, lastRow);
    for (let row = firstRow; row <= lastStored; row++) {
      progress(); const record = read(rows, (row - 1) * 16, 16); const firstCell = Number(record.readBigUInt64LE()); const count = Number(record.readBigUInt64LE(8));
      const result: WorkbookRow = Object.create(null);
      for (const column of columns) {
        if (column.column > count) { result[column.as] = { kind: 'missing', reason: 'absent-field' }; continue; }
        const entry = read(cells, (firstCell + column.column - 1) * 16, 16);
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(read(values, Number(entry.readBigUInt64LE()), Number(entry.readBigUInt64LE(8))));
        result[column.as] = column.as_number ? workbookNumericLiteral(raw, digitAllowance) : { kind: 'string', text: raw };
      }
      yield { cells: result, repeat: 1 };
    }
    const absentStart = Math.max(firstRow, source.rows + 1);
    if (absentStart <= lastRow) {
      progress(); const result: WorkbookRow = Object.create(null);
      for (const column of columns) result[column.as] = { kind: 'missing', reason: 'absent-row' };
      yield { cells: result, repeat: lastRow - absentStart + 1 };
    }
  } finally { for (const file of files) closeSync(file); }
}
