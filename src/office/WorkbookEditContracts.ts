import type { XlsxManifest } from '../content/XlsxWorkbook';
import type { WorkbookBindingInput } from '../content/WorkbookBinding';
import { xlsxAddress, xlsxRange, XLSX_ROWS, XLSX_COLUMNS } from '../content/XlsxSheet';
import { xlsxFormulaIssue, type XlsxFormulaEffect } from './XlsxFormulaEffects';

/** A cell value from the model. `from` names exact host data; the host fills it, never the model's copy of it. */
export type WorkbookCellValue = string | number | boolean | null | { date: string } | { from: { transformation_ref: string; field: string; row: number } };
export interface WorkbookSetCellsEdit { op: 'set_cells'; sheet_id: string; range: string; values: WorkbookCellValue[][]; number_format?: string }
export interface WorkbookSetFormulasEdit { op: 'set_formulas'; sheet_id: string; cells: Record<string, string>; number_format?: string }
export interface WorkbookSetNumberFormatEdit { op: 'set_number_format'; sheet_id: string; range: string; number_format: string }
export interface WorkbookAppendRowsEdit { op: 'append_rows'; sheet_id: string; rows: WorkbookCellValue[][]; formulas?: Record<string, string>; number_formats?: Record<string, string> }
export type WorkbookEdit = WorkbookSetCellsEdit | WorkbookSetFormulasEdit | WorkbookSetNumberFormatEdit | WorkbookAppendRowsEdit;
export interface WorkbookEditRequest { schema_version: 1; path: string; snapshot_ref: string; edits: WorkbookEdit[] }
export interface WorkbookSheetSpec { name: string; columns?: Array<{ width?: number; number_format?: string }>; header?: string[];
  rows: WorkbookCellValue[][]; formulas?: Record<string, string>; freeze_header?: boolean }
export interface WorkbookCreateRequest { schema_version: 1; path: string; sheets: WorkbookSheetSpec[] }

export interface WorkbookEditInput { source: string; sourceSha256: string; directory: string; manifest: XlsxManifest; edits: WorkbookEdit[]; bindings?: WorkbookBindingInput[] }
export interface WorkbookCreateInput { directory: string; sheets: WorkbookSheetSpec[]; bindings?: WorkbookBindingInput[] }
export interface WorkbookFormulaFact { sheet_id: string; cell: string; formula: string }
export interface WorkbookFormulaEffectFact { sheet_id: string; cell: string; effects: XlsxFormulaEffect[] }
export interface WorkbookDataSourceFact { sheet_id: string; cell: string; transformation_ref: string; field: string; row: number; source_sha256: string[] }
export interface WorkbookWriteResult {
  kind: 'workbook-edited' | 'workbook-created'; bytes: Uint8Array; sha256: string; sourceSha256?: string;
  sheets: Array<{ sheet_id: string; name: string }>;
  cells_written: number; values_written: string[]; formulas_written: WorkbookFormulaFact[]; formats_written: number;
  number_formats_added: number; calc_chain_removed: boolean; full_calc_on_load: boolean; calc_mode_manual: boolean;
  array_cells_cleared: string[]; calculated_column_notes: string[]; formula_effects: WorkbookFormulaEffectFact[];
  tables_extended: string[]; data_sources: WorkbookDataSourceFact[]; template_converted: boolean;
  preserved_parts: number; changed_parts: number; added_parts: number; removed_parts: number; untouched_cells_checked: number; preservation_digest: string;
}

export const WORKBOOK_EDIT_CODES = ['invalid-workbook-edits', 'invalid-formula', 'invalid-cell-ref', 'snapshot-unavailable', 'source-changed', 'source-unreadable',
  'source-unavailable', 'unavailable-worksheet', 'workbook-output-check-failed', 'workbook-macros-unsupported', 'workbook-signed', 'sheet-protected',
  'formula-range-partial', 'table-structure-unsupported', 'workbook-structure-unsupported', 'merged-cell-covered', 'workbook-data-unavailable',
  'destination-extension-mismatch', 'unsupported-workbook-package', 'unsupported-xml-dtd', 'unsupported-xml-encoding', 'cancelled', 'out-of-memory',
  'worker-unavailable', 'workbook-edit-failed'] as const;
export type WorkbookEditCode = typeof WORKBOOK_EDIT_CODES[number];
export const isWorkbookEditCode = (value: string): value is WorkbookEditCode => (WORKBOOK_EDIT_CODES as readonly string[]).includes(value);
export class WorkbookEditFailure extends Error {
  constructor(code: WorkbookEditCode, public readonly inputIssue?: { location: string; issue: string }) { super(code); }
}

/** Bound on cells one request may target, so a single range cannot exhaust the worker's memory. */
export const WORKBOOK_MAX_TARGET_CELLS = 1_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (location: string, issue: string): never => { throw new WorkbookEditFailure('invalid-workbook-edits', { location, issue }); };
const COLUMN = /^[A-Za-z]{1,3}$/;

export function workbookNumberFormatIssue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return 'must be a nonempty number format code such as 0.00, 0%, #,##0 or yyyy-mm-dd';
  if (value.length > 255) return 'must be at most 255 characters';
  if (/[\u0000-\u001f￾￿]/u.test(value)) return 'contains a control character';
  return undefined;
}
/** A model formula is stored as text without the leading equals sign that a formula bar shows. */
export function workbookFormulaText(location: string, value: unknown): string {
  if (typeof value !== 'string') return invalid(location, 'must be formula text such as B2+C2+D2');
  const text = value.startsWith('=') ? value.slice(1) : value;
  const issue = xlsxFormulaIssue(text); if (issue) throw new WorkbookEditFailure('invalid-formula', { location, issue: `formula ${issue}` });
  return text;
}
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
export function validateWorkbookValue(location: string, value: unknown): WorkbookCellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) return invalid(location, 'numbers must be finite'); return value; }
  if (object(value) && Object.keys(value).length === 1 && typeof value.date === 'string') {
    const match = ISO_DATE.exec(value.date); if (!match) return invalid(location, 'date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS');
    const [year, month, day, hour = '0', minute = '0', second = '0'] = match.slice(1).map(part => part ?? '0');
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return invalid(location, 'date is not a real calendar date');
    return { date: value.date };
  }
  if (object(value) && Object.keys(value).length === 1 && object(value.from)) {
    const from = value.from;
    if (Object.keys(from).some(key => !['transformation_ref', 'field', 'row'].includes(key)) || typeof from.transformation_ref !== 'string' || !from.transformation_ref
      || typeof from.field !== 'string' || !from.field || !Number.isSafeInteger(from.row) || (from.row as number) < 1) return invalid(location, 'from needs transformation_ref, field and a row number starting at 1 from this agent’s transform_workbook result');
    return { from: { transformation_ref: from.transformation_ref, field: from.field, row: from.row as number } };
  }
  return invalid(location, 'use a string, number, boolean, null, {date} or {from}');
}
function formulaMap(location: string, value: unknown, keys: 'cells' | 'columns' | 'both'): Record<string, string> {
  if (!object(value) || !Object.keys(value).length) return invalid(location, 'must be a nonempty object');
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    const column = COLUMN.test(key); let canonical: string;
    if (keys !== 'cells' && column) {
      let number = 0; for (const char of key.toUpperCase()) number = number * 26 + char.charCodeAt(0) - 64;
      if (number > XLSX_COLUMNS) throw new WorkbookEditFailure('invalid-cell-ref', { location: `${location}.${key}`, issue: 'column is beyond XFD' });
      canonical = key.toUpperCase();
    } else if (keys !== 'columns') {
      try { canonical = xlsxAddress(key).cell; } catch { throw new WorkbookEditFailure('invalid-cell-ref', { location: `${location}.${key}`, issue: 'use an A1 cell reference within XFD1048576' }); }
    } else return invalid(`${location}.${key}`, 'use a column letter such as D');
    if (result[canonical] !== undefined) return invalid(`${location}.${key}`, 'names the same cell or column twice');
    result[canonical] = workbookFormulaText(`${location}.${key}`, text);
  }
  return result;
}
function formatMap(location: string, value: unknown): Record<string, string> {
  if (!object(value) || !Object.keys(value).length) return invalid(location, 'must be a nonempty object keyed by column letter');
  const result: Record<string, string> = {};
  for (const [key, format] of Object.entries(value)) {
    if (!COLUMN.test(key)) return invalid(`${location}.${key}`, 'use a column letter such as D');
    const issue = workbookNumberFormatIssue(format); if (issue) return invalid(`${location}.${key}`, issue);
    result[key.toUpperCase()] = format as string;
  }
  return result;
}
function rangeOf(location: string, value: unknown) {
  if (typeof value !== 'string') return invalid(location, 'use an A1 range such as B2:D4');
  try { return xlsxRange(value); } catch { throw new WorkbookEditFailure('invalid-cell-ref', { location, issue: 'use an ordered A1 range within XFD1048576' }); }
}
function valueRows(location: string, value: unknown, rectangular: boolean): WorkbookCellValue[][] {
  if (!Array.isArray(value) || !value.length) return invalid(location, 'must be a nonempty array of rows');
  const rows = value.map((row, index) => {
    if (!Array.isArray(row) || !row.length) return invalid(`${location}[${index}]`, 'must be a nonempty array of values');
    if (row.length > XLSX_COLUMNS) throw new WorkbookEditFailure('invalid-cell-ref', { location: `${location}[${index}]`, issue: 'is wider than XFD' });
    return row.map((cell, column) => validateWorkbookValue(`${location}[${index}][${column}]`, cell));
  });
  if (rectangular && rows.some(row => row.length !== rows[0].length)) return invalid(location, 'every row must have the same number of values');
  return rows;
}
const sheetId = (location: string, value: unknown) => typeof value === 'string' && /^sheet-[1-9]\d*$/.test(value) ? value
  : invalid(location, 'use a sheet_id from read_workbook inspect, such as sheet-1');

export function validateWorkbookEditRequest(value: unknown): WorkbookEditRequest {
  if (!object(value)) return invalid('request', 'must be an object');
  const extra = Object.keys(value).filter(key => !['schema_version', 'path', 'snapshot_ref', 'edits'].includes(key));
  if (extra.length) return invalid('request', `unsupported fields ${extra.join(', ')}`);
  if (value.schema_version !== 1) return invalid('schema_version', 'must be 1');
  if (typeof value.path !== 'string' || !value.path.trim()) return invalid('path', 'must be the destination .xlsx path');
  if (typeof value.snapshot_ref !== 'string' || !value.snapshot_ref) return invalid('snapshot_ref', 'use the snapshot_ref from read_workbook inspect of this workbook');
  if (!Array.isArray(value.edits) || !value.edits.length) return invalid('edits', 'must be a nonempty array');
  let cells = 0;
  const edits = value.edits.map((raw, index): WorkbookEdit => {
    const at = `edits[${index}]`; if (!object(raw)) return invalid(at, 'must be an object');
    const allowed: Record<string, string[]> = { set_cells: ['op', 'sheet_id', 'range', 'values', 'number_format'], set_formulas: ['op', 'sheet_id', 'cells', 'number_format'],
      set_number_format: ['op', 'sheet_id', 'range', 'number_format'], append_rows: ['op', 'sheet_id', 'rows', 'formulas', 'number_formats'] };
    const keys = allowed[raw.op as string]; if (!keys) return invalid(`${at}.op`, 'use set_cells, set_formulas, set_number_format or append_rows');
    const unknown = Object.keys(raw).filter(key => !keys.includes(key)); if (unknown.length) return invalid(at, `unsupported fields ${unknown.join(', ')} for ${raw.op as string}`);
    const sheet = sheetId(`${at}.sheet_id`, raw.sheet_id);
    const format = (key: string, required: boolean) => {
      if (raw[key] === undefined && !required) return undefined;
      const issue = workbookNumberFormatIssue(raw[key]); if (issue) return invalid(`${at}.${key}`, issue); return raw[key] as string;
    };
    if (raw.op === 'set_cells') {
      const range = rangeOf(`${at}.range`, raw.range); const values = valueRows(`${at}.values`, raw.values, true);
      if (values.length !== range.lastRow - range.firstRow + 1 || values[0].length !== range.lastColumn - range.firstColumn + 1) return invalid(`${at}.values`, `must have exactly ${range.lastRow - range.firstRow + 1} rows of ${range.lastColumn - range.firstColumn + 1} values to fill ${raw.range as string}`);
      cells += values.length * values[0].length; const number_format = format('number_format', false);
      return { op: 'set_cells', sheet_id: sheet, range: raw.range as string, values, ...(number_format ? { number_format } : {}) };
    }
    if (raw.op === 'set_formulas') {
      const formulas = formulaMap(`${at}.cells`, raw.cells, 'cells'); cells += Object.keys(formulas).length; const number_format = format('number_format', false);
      return { op: 'set_formulas', sheet_id: sheet, cells: formulas, ...(number_format ? { number_format } : {}) };
    }
    if (raw.op === 'set_number_format') {
      const range = rangeOf(`${at}.range`, raw.range); cells += (range.lastRow - range.firstRow + 1) * (range.lastColumn - range.firstColumn + 1);
      return { op: 'set_number_format', sheet_id: sheet, range: raw.range as string, number_format: format('number_format', true)! };
    }
    const rows = valueRows(`${at}.rows`, raw.rows, false); cells += rows.reduce((sum, row) => sum + row.length, 0);
    const formulas = raw.formulas === undefined ? undefined : formulaMap(`${at}.formulas`, raw.formulas, 'columns');
    const number_formats = raw.number_formats === undefined ? undefined : formatMap(`${at}.number_formats`, raw.number_formats);
    if (formulas) cells += rows.length * Object.keys(formulas).length;
    return { op: 'append_rows', sheet_id: sheet, rows, ...(formulas ? { formulas } : {}), ...(number_formats ? { number_formats } : {}) };
  });
  if (cells > WORKBOOK_MAX_TARGET_CELLS) return invalid('edits', `target at most ${WORKBOOK_MAX_TARGET_CELLS} cells per request; split larger changes into several requests`);
  return { schema_version: 1, path: value.path, snapshot_ref: value.snapshot_ref, edits };
}

const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/;
export function validateWorkbookCreateRequest(value: unknown): WorkbookCreateRequest {
  if (!object(value)) return invalid('request', 'must be an object');
  const extra = Object.keys(value).filter(key => !['schema_version', 'path', 'sheets'].includes(key));
  if (extra.length) return invalid('request', `unsupported fields ${extra.join(', ')}`);
  if (value.schema_version !== 1) return invalid('schema_version', 'must be 1');
  if (typeof value.path !== 'string' || !value.path.trim()) return invalid('path', 'must be the destination .xlsx path');
  if (!Array.isArray(value.sheets) || !value.sheets.length || value.sheets.length > 255) return invalid('sheets', 'must be an array of 1 to 255 sheets');
  const names = new Set<string>(); let cells = 0;
  const sheets = value.sheets.map((raw, index): WorkbookSheetSpec => {
    const at = `sheets[${index}]`; if (!object(raw)) return invalid(at, 'must be an object');
    const unknown = Object.keys(raw).filter(key => !['name', 'columns', 'header', 'rows', 'formulas', 'freeze_header'].includes(key));
    if (unknown.length) return invalid(at, `unsupported fields ${unknown.join(', ')}`);
    const name = raw.name;
    if (typeof name !== 'string' || !name || name.length > 31 || SHEET_NAME_FORBIDDEN.test(name) || name.startsWith("'") || name.endsWith("'")
      || /[\u0000-\u001f]/.test(name) || name.toLowerCase() === 'history') return invalid(`${at}.name`, 'use 1 to 31 characters without [ ] : * ? / \\, not starting or ending with an apostrophe');
    if (names.has(name.toLowerCase())) return invalid(`${at}.name`, 'sheet names must be unique (case-insensitive)'); names.add(name.toLowerCase());
    let header: string[] | undefined;
    if (raw.header !== undefined) {
      if (!Array.isArray(raw.header) || !raw.header.length || raw.header.some(cell => typeof cell !== 'string')) return invalid(`${at}.header`, 'must be a nonempty array of strings');
      header = raw.header as string[];
    }
    const rows = raw.rows === undefined ? [] : Array.isArray(raw.rows) && raw.rows.length === 0 ? [] : valueRows(`${at}.rows`, raw.rows, false);
    if ((header ? 1 : 0) + rows.length > XLSX_ROWS) throw new WorkbookEditFailure('invalid-cell-ref', { location: `${at}.rows`, issue: 'more rows than a worksheet holds' });
    let columns: WorkbookSheetSpec['columns'];
    if (raw.columns !== undefined) {
      if (!Array.isArray(raw.columns) || raw.columns.length > XLSX_COLUMNS) return invalid(`${at}.columns`, 'must be an array of column settings');
      columns = raw.columns.map((column, position) => {
        if (!object(column) || Object.keys(column).some(key => !['width', 'number_format'].includes(key))) return invalid(`${at}.columns[${position}]`, 'use {width?, number_format?}');
        if (column.width !== undefined && (typeof column.width !== 'number' || !Number.isFinite(column.width) || column.width < 0 || column.width > 255)) return invalid(`${at}.columns[${position}].width`, 'must be a number from 0 to 255');
        if (column.number_format !== undefined) { const issue = workbookNumberFormatIssue(column.number_format); if (issue) return invalid(`${at}.columns[${position}].number_format`, issue); }
        return { ...(column.width !== undefined ? { width: column.width as number } : {}), ...(column.number_format !== undefined ? { number_format: column.number_format as string } : {}) };
      });
    }
    const formulas = raw.formulas === undefined ? undefined : formulaMap(`${at}.formulas`, raw.formulas, 'both');
    if (raw.freeze_header !== undefined && typeof raw.freeze_header !== 'boolean') return invalid(`${at}.freeze_header`, 'must be true or false');
    cells += rows.reduce((sum, row) => sum + row.length, 0) + (header?.length ?? 0) + (formulas ? Object.keys(formulas).length * Math.max(1, rows.length) : 0);
    return { name, rows, ...(header ? { header } : {}), ...(columns ? { columns } : {}), ...(formulas ? { formulas } : {}), ...(raw.freeze_header !== undefined ? { freeze_header: raw.freeze_header as boolean } : {}) };
  });
  if (cells > WORKBOOK_MAX_TARGET_CELLS) return invalid('sheets', `write at most ${WORKBOOK_MAX_TARGET_CELLS} cells per request; add more rows later with edit_workbook append_rows`);
  return { schema_version: 1, path: value.path, sheets };
}

/** Days from the workbook epoch, using the 1900 system's historical leap day exactly as spreadsheet applications store it. */
export function workbookDateSerial(iso: string, date1904: boolean): string | undefined {
  const match = ISO_DATE.exec(iso); if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? '0'));
  const days = Date.UTC(year, month - 1, day) / 86400000;
  let serial: number;
  if (date1904) { serial = days - Date.UTC(1904, 0, 1) / 86400000; if (serial < 0) return undefined; }
  else {
    const fromBase = days - Date.UTC(1899, 11, 31) / 86400000; if (fromBase < 1) return undefined;
    serial = fromBase >= 60 ? fromBase + 1 : fromBase;
  }
  const seconds = hour * 3600 + minute * 60 + second;
  return seconds ? String(serial + seconds / 86400) : String(serial);
}
