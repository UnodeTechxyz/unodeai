import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { CsvManifest } from './CsvWorkbook';
import { randomUUID } from 'node:crypto';

export interface CellPosition { row: number; column: number; byte: number }
export interface WorkbookRange { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }
export interface WorkbookFragment { cell: string; kind: 'string' | 'absent'; text?: string; start_byte: number; end_byte: number; total_bytes: number; whole_value: boolean }
export interface WorkbookPage { schema_version: 1; snapshot_ref: string; source_sha256: string; sheet_id: 'csv:1';
  delivery_ref?: string;
  source: CsvManifest; range: string; visibility: 'all'; delivery: 'prepared';
  prepared_fragments: WorkbookFragment[]; next_cursor: string | null; remaining: CellPosition | null }
export interface PageBudget { unit: 'bytes' | 'chars'; limit: number; reserved: number;
  /** Additional escaping in the actual route carrier is counted, not just raw data text. */
  carrier: 'text' | 'mcp' | 'codex' }
export function columnName(column: number): string {
  let text = ''; for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) text = String.fromCharCode(65 + (value - 1) % 26) + text;
  return text;
}
export function columnNumber(text: string): number {
  let value = 0; for (const char of text) { value = value * 26 + char.charCodeAt(0) - 64; if (!Number.isSafeInteger(value)) throw new Error('invalid-range'); } return value;
}
export function parseWorkbookRange(input: string | undefined, source: CsvManifest): WorkbookRange {
  if (input === undefined) return { firstRow: 1, lastRow: source.rows, firstColumn: 1, lastColumn: source.columns };
  const match = /^([A-Z]+)([1-9][0-9]*)(?::([A-Z]+)([1-9][0-9]*))?$/i.exec(input);
  if (!match) throw new Error('invalid-range');
  const result = { firstRow: Number(match[2]), lastRow: Number(match[4] ?? match[2]),
    firstColumn: columnNumber(match[1].toUpperCase()), lastColumn: columnNumber((match[3] ?? match[1]).toUpperCase()) };
  if (!Number.isSafeInteger(result.firstRow) || !Number.isSafeInteger(result.lastRow) || result.firstRow > result.lastRow
    || result.firstColumn > result.lastColumn) throw new Error('invalid-range');
  return result;
}
export function workbookOutputSize(text: string, budget: PageBudget): number {
  const carrier = budget.carrier === 'mcp' ? JSON.stringify({ content: [{ type: 'text', text }] })
    : budget.carrier === 'codex' ? JSON.stringify({ contentItems: [{ type: 'inputText', text }] }) : text;
  return budget.unit === 'bytes' ? Buffer.byteLength(carrier, 'utf8') : carrier.length;
}
/** Reads only the required index records and current value fragment; no whole table in the host heap. */
export async function readCsvPage(directory: string, source: CsvManifest, range: WorkbookRange, start: CellPosition,
  snapshotRef: string, cursor: string, budget: PageBudget, progress: () => void): Promise<WorkbookPage> {
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0) throw new Error('invalid-budget');
  const page: WorkbookPage = { schema_version: 1, snapshot_ref: snapshotRef, source_sha256: source.sha256, sheet_id: 'csv:1', source,
    range: source.rows ? `${columnName(range.firstColumn)}${range.firstRow}:${columnName(range.lastColumn)}${range.lastRow}` : 'empty',
    visibility: 'all', delivery: 'prepared', delivery_ref: `workbook-delivery-${randomUUID()}`, prepared_fragments: [], next_cursor: cursor, remaining: { ...start } };
  const fits = () => workbookOutputSize(JSON.stringify(page), budget) + budget.reserved <= budget.limit;
  if (!fits()) throw new Error('route-bound-too-small');
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const acquire = async (name: string) => { const file = await open(join(directory, name), 'r'); handles.push(file); return file; };
  const read = async (file: Awaited<ReturnType<typeof open>>, offset: number, length: number) => {
    const bytes = Buffer.alloc(length); let at = 0;
    while (at < length) { const result = await file.read(bytes, at, length - at, offset + at); if (!result.bytesRead) throw new Error('snapshot-index-incomplete'); at += result.bytesRead; }
    return bytes;
  };
  let position = { ...start };
  const advance = () => { position.byte = 0; if (position.column < range.lastColumn) position.column++; else { position.column = range.firstColumn; position.row++; } };
  try {
    const rows = await acquire('rows.index'); const cells = await acquire('cells.index'); const values = await acquire('values.utf8');
    if (start.row < range.firstRow || start.column < range.firstColumn || start.column > range.lastColumn || start.byte < 0
      || ![start.row, start.column, start.byte].every(Number.isSafeInteger)) throw new Error('invalid-cursor');
    while (position.row <= range.lastRow && source.rows > 0) {
      progress(); let offset = 0; let length = 0; let absent = true;
      if (position.row <= source.rows) {
        const row = await read(rows, (position.row - 1) * 16, 16); const count = Number(row.readBigUInt64LE(8));
        if (position.column <= count) {
          const index = Number(row.readBigUInt64LE()) + position.column - 1; const cell = await read(cells, index * 16, 16);
          offset = Number(cell.readBigUInt64LE()); length = Number(cell.readBigUInt64LE(8)); absent = false;
        }
      }
      if (position.byte > length) throw new Error('invalid-cursor');
      const fragment: WorkbookFragment = { cell: `${columnName(position.column)}${position.row}`, kind: absent ? 'absent' : 'string',
        start_byte: position.byte, end_byte: position.byte, total_bytes: length, whole_value: absent || length === 0, ...(absent ? {} : { text: '' }) };
      const available = Math.min(length - position.byte, budget.limit * 4);
      const raw = available ? await read(values, offset + position.byte, available) : Buffer.alloc(0);
      // stream:true holds an incomplete final UTF-8 sequence for the next fragment, instead of replacing it.
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw, { stream: available < length - position.byte });
      page.prepared_fragments.push(fragment);
      const before = { ...position };
      const set = (end: number) => {
        if (end > 0 && end < decoded.length && decoded.charCodeAt(end - 1) >= 0xd800 && decoded.charCodeAt(end - 1) <= 0xdbff) end--;
        const text = decoded.slice(0, end); fragment.text = absent ? undefined : text;
        fragment.end_byte = before.byte + Buffer.byteLength(text, 'utf8'); fragment.whole_value = before.byte === 0 && fragment.end_byte === length;
        position = { ...before }; if (fragment.end_byte === length) advance(); else position.byte = fragment.end_byte;
        page.remaining = position.row > range.lastRow ? null : { ...position }; page.next_cursor = page.remaining ? cursor : null;
      };
      set(decoded.length);
      if (!fits()) {
        let low = 0; let high = decoded.length;
        while (low < high) { const middle = Math.ceil((low + high) / 2); set(middle); if (fits()) low = middle; else high = middle - 1; }
        set(low);
        if (!fits() || (length > before.byte && fragment.end_byte === before.byte)) {
          page.prepared_fragments.pop(); page.remaining = before; page.next_cursor = cursor;
          if (!page.prepared_fragments.length) throw new Error('route-bound-too-small');
        }
        return page;
      }
    }
    page.next_cursor = null; page.remaining = null; return page;
  } finally { await Promise.allSettled(handles.map(file => file.close())); }
}
