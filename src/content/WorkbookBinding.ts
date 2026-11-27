import { join } from 'node:path';
import { WorkbookTableReader } from './WorkbookTable';
import { WorkbookExactNumber } from './WorkbookExactNumber';
import { workbookDateDisplay, workbookRoundedText, WORKBOOK_DISPLAY_PRECISION } from './WorkbookDisplay';
import type { WorkbookDatum } from './WorkbookAggregate';
import type { WorkbookTransformManifest } from './WorkbookTransform';

/** Public coordinates only. A ref identifies data; it never grants source access. */
export interface WorkbookDataSelection {
  transformation_ref: string;
  fields: string[];
  rows?: { first: number; last: number };
}
/** Created by WorkbookReader after live source authorization. Never accepted from model input. */
export interface WorkbookBindingInput {
  transformationRef: string; dataRef: string; directory: string; manifest: WorkbookTransformManifest; bytes: number;
}
export interface WorkbookBoundCell {
  text: string;
  state: 'known' | 'unresolved' | 'structural';
  value: WorkbookDatum;
  display_precision?: number;
}
export interface WorkbookBoundRow { firstRow: number; repeat: number; cells: WorkbookBoundCell[]; uncertain?: string }
const invalid = (): never => { throw new Error('invalid-data-selection'); };
export function validateWorkbookDataSelection(input: unknown): WorkbookDataSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['transformation_ref', 'fields', 'rows'].includes(key))
    || typeof raw.transformation_ref !== 'string' || !raw.transformation_ref
    || !Array.isArray(raw.fields) || !raw.fields.length || raw.fields.some(value => typeof value !== 'string' || !value)
    || new Set(raw.fields).size !== raw.fields.length) return invalid();
  let rows: WorkbookDataSelection['rows'];
  if (raw.rows !== undefined) {
    if (!raw.rows || typeof raw.rows !== 'object' || Array.isArray(raw.rows)) return invalid();
    const range = raw.rows as Record<string, unknown>;
    if (Object.keys(range).some(key => !['first', 'last'].includes(key)) || !Number.isSafeInteger(range.first) || !Number.isSafeInteger(range.last)
      || (range.first as number) < 1 || (range.last as number) < (range.first as number)) return invalid();
    rows = { first: range.first as number, last: range.last as number };
  }
  return { transformation_ref: raw.transformation_ref, fields: [...raw.fields] as string[], ...(rows ? { rows } : {}) };
}

/** Exact terminating decimals stay decimal; repeating rationals retain their exact fraction, never a guessed rounding. */
export function workbookExactText(value: WorkbookExactNumber): string {
  let remaining = value.denominator; let twos = 0; let fives = 0;
  while (remaining % 2n === 0n) { remaining /= 2n; twos++; }
  while (remaining % 5n === 0n) { remaining /= 5n; fives++; }
  if (remaining !== 1n) return `${value.numerator}/${value.denominator}`;
  const scale = Math.max(twos, fives);
  const negative = value.numerator < 0n;
  const magnitude = negative ? -value.numerator : value.numerator;
  const digits = (magnitude * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives)).toString().padStart(scale + 1, '0');
  return (negative ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
export function workbookBoundCell(value: WorkbookDatum, uncertain?: string): WorkbookBoundCell {
  let text: string; let state: WorkbookBoundCell['state'] = 'known'; let displayPrecision: number | undefined;
  switch (value.kind) {
    case 'number': {
      const exact = new WorkbookExactNumber(BigInt(value.exact.numerator), BigInt(value.exact.denominator)); text = workbookExactText(exact);
      if (value.display?.status === 'formatted') text = value.display.text;
      else if (text.includes('/')) { text = workbookRoundedText(exact); displayPrecision = WORKBOOK_DISPLAY_PRECISION; }
      break;
    }
    case 'string': text = value.text; if (value.escapedCodeUnitsUnresolved) state = 'unresolved'; break;
    case 'boolean': text = value.value ? 'TRUE' : 'FALSE'; break;
    case 'date-serial': {
      const display = value.display?.status === 'formatted' ? value.display : workbookDateDisplay(value.raw, value.epoch);
      text = display.text; break;
    }
    case 'iso-date': text = value.raw; break;
    case 'merged': text = `[Merged: ${value.from}]`; state = 'structural'; break;
    case 'missing': text = ['blank-cell', 'absent-cell', 'absent-column'].includes(value.reason) ? '' : `[Missing: ${value.reason}]`; state = 'unresolved'; break;
    case 'error': text = `[Error: ${value.code}]`; state = 'unresolved'; break;
    case 'excluded': text = `[Excluded: ${value.reason}]`; state = 'structural'; break;
  }
  return { text, state: uncertain ? 'unresolved' : state, value, ...(displayPrecision === undefined ? {} : { display_precision: displayPrecision }) };
}

/** The fixed render worker reads the actual private table. No whole-table transfer through the extension host. */
export function* readWorkbookBinding(input: WorkbookBindingInput, selection: WorkbookDataSelection, progress: () => void): Generator<WorkbookBoundRow> {
  const table = input.manifest.table;
  const { first, last } = workbookBindingBounds(input, selection);
  const reader = new WorkbookTableReader(join(input.directory, table.directory), table.columns);
  try {
    for (let at = 0; at < table.blocks; at++) {
      progress(); const block = reader.block(at, selection.fields); if (!block) throw new Error('invalid-workbook-index');
      if (block.firstRow > last) break;
      const begin = Math.max(first, block.firstRow); const end = Math.min(last, block.firstRow + block.repeat - 1);
      if (end < begin) continue;
      const cells = selection.fields.map(field => { progress(); return workbookBoundCell(block.cells[field], block.uncertain); });
      yield { firstRow: begin, repeat: end - begin + 1, cells, ...(block.uncertain ? { uncertain: block.uncertain } : {}) };
    }
  } finally { reader.close(); }
}

export function workbookBindingBounds(input: WorkbookBindingInput, selection: WorkbookDataSelection) {
  const columns = new Set(input.manifest.table.columns);
  if (selection.transformation_ref !== input.transformationRef || selection.fields.some(field => !columns.has(field))) return invalid();
  const first = selection.rows?.first ?? 1; const last = selection.rows?.last ?? input.manifest.table.rows;
  if (selection.rows && last > input.manifest.table.rows) return invalid();
  return { first, last };
}

/** Differences are facts about model input, distinct from the host-filled output and its later package check. */
export function workbookSuppliedValueMatches(supplied: string | number, expected: WorkbookBoundCell): boolean {
  if (expected.value.kind !== 'number') return String(supplied) === expected.text;
  if (typeof supplied === 'number' && !Number.isFinite(supplied)) return false;
  if (String(supplied) === expected.text) return true;
  try { return WorkbookExactNumber.parse(String(supplied)).compare(new WorkbookExactNumber(BigInt(expected.value.exact.numerator), BigInt(expected.value.exact.denominator))) === 0; }
  catch { return false; }
}
