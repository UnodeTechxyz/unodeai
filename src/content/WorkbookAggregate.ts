import { WorkbookExactNumber, type ExactValue } from './WorkbookExactNumber';
import { workbookNumberDisplay, type WorkbookDisplay } from './WorkbookDisplay';
export type WorkbookDatum = ({ kind: 'number'; exact: ExactValue } | { kind: 'string'; text: string; escapedCodeUnitsUnresolved?: boolean }
  | { kind: 'boolean'; value: boolean } | { kind: 'missing'; reason: string } | { kind: 'error'; code: string }
  | { kind: 'merged'; from: string; anchor?: WorkbookDatum } | { kind: 'excluded'; reason: string }
  | { kind: 'date-serial'; raw: string; epoch: '1900' | '1904'; excelLeapDay: boolean } | { kind: 'iso-date'; raw: string }) & { display?: WorkbookDisplay };
export type WorkbookRow = Record<string, WorkbookDatum>;
export interface WorkbookRowBlock { cells: WorkbookRow; repeat: number; uncertain?: string }
export interface WorkbookAggregateField { operation: 'sum' | 'count' | 'min' | 'max' | 'average'; field?: string; as: string }
export interface WorkbookAggregateSpec { group_by: string[]; fields: WorkbookAggregateField[]; missing: 'propagate' | 'exclude-with-counts' }
interface State { accepted: number; missing: number; errors: number; unsupported: number; merged: number; excluded: number; filterUnknown: number; groupUnknown: number;
  total: WorkbookExactNumber; minimum?: WorkbookExactNumber; maximum?: WorkbookExactNumber; formatCode?: string; formatSeen?: boolean; formatMixed?: boolean }
const number = (value: ExactValue) => new WorkbookExactNumber(BigInt(value.numerator), BigInt(value.denominator));
const cell = (row: WorkbookRow, field: string): WorkbookDatum => Object.hasOwn(row, field) ? row[field] : { kind: 'missing', reason: 'absent-column' };
/** Streaming input and group output; the caller appends results to private indices. */
export interface WorkbookGroupCounts { inputRows: number; excludedGroupRows: number; visibilityExcludedGroupRows: number; missingGroupKeys: number; errorGroupKeys: number; unresolvedGroupKeys: number }
export async function* aggregateWorkbookRows(rows: AsyncIterable<WorkbookRowBlock>, spec: WorkbookAggregateSpec, progress: () => void,
  counts: WorkbookGroupCounts = { inputRows: 0, excludedGroupRows: 0, visibilityExcludedGroupRows: 0, missingGroupKeys: 0, errorGroupKeys: 0, unresolvedGroupKeys: 0 }) {
  if (!['propagate', 'exclude-with-counts'].includes(spec.missing) || !spec.fields.length
    || spec.fields.some(field => !['sum', 'count', 'min', 'max', 'average'].includes(field.operation) || !field.as || (field.operation !== 'count' && !field.field))
    || new Set([...spec.group_by, ...spec.fields.map(field => field.as)]).size !== spec.group_by.length + spec.fields.length) throw new Error('invalid-aggregate-spec');
  const groups = new Map<string, { keys: WorkbookDatum[]; rows: number; states: State[] }>();
  const create = (keys: WorkbookDatum[]) => ({ keys, rows: 0, states: spec.fields.map(() => ({ accepted: 0, missing: 0, errors: 0, unsupported: 0, merged: 0, excluded: 0, filterUnknown: 0, groupUnknown: 0, total: new WorkbookExactNumber(0n) })) });
  if (!spec.group_by.length) groups.set('[]', create([]));
  for await (const block of rows) {
    const { cells: row, repeat } = block;
    if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('invalid-row-repeat');
    progress(); counts.inputRows += repeat;
    const keys = spec.group_by.map(field => { const value = cell(row, field); return value.kind === 'merged' && value.anchor ? value.anchor : value; });
    const missingKeys = keys.filter(value => value.kind === 'missing').length; const errorKeys = keys.filter(value => value.kind === 'error').length;
    const unresolvedKeys = keys.filter(value => value.kind === 'merged' || (value.kind === 'string' && value.escapedCodeUnitsUnresolved)).length;
    counts.missingGroupKeys += missingKeys * repeat; counts.errorGroupKeys += errorKeys * repeat; counts.unresolvedGroupKeys += unresolvedKeys * repeat;
    if (keys.some(value => value.kind === 'excluded')) { counts.visibilityExcludedGroupRows += repeat; continue; }
    const unknownGroup = missingKeys + errorKeys + unresolvedKeys > 0;
    if (unknownGroup && spec.missing === 'exclude-with-counts') { counts.excludedGroupRows += repeat; continue; }
    const key = JSON.stringify(keys, (name, value) => name === 'display' ? undefined : value);
    let group = groups.get(key); if (!group) { group = create(keys); groups.set(key, group); } group.rows += repeat;
    for (let index = 0; index < spec.fields.length; index++) {
      const field = spec.fields[index]; const state = group.states[index];
      if (block.uncertain) state.filterUnknown += repeat;
      if (unknownGroup) state.groupUnknown += repeat;
      if (field.operation === 'count' && field.field === undefined) { state.accepted += repeat; continue; }
      if (field.field === undefined) throw new Error('aggregate-field-required');
      const value = cell(row, field.field);
      if (value.kind === 'merged') { state.merged += repeat; continue; }
      if (value.kind === 'excluded') { state.excluded += repeat; continue; }
      if (value.kind === 'missing') { state.missing += repeat; continue; }
      if (value.kind === 'error') { state.errors += repeat; continue; }
      if (field.operation === 'count') { state.accepted += repeat; continue; }
      if (value.kind !== 'number') { state.unsupported += repeat; continue; }
      const format = value.display?.format_code;
      if (state.formatSeen && state.formatCode !== format) state.formatMixed = true;
      if (!state.formatSeen) { state.formatSeen = true; state.formatCode = format; }
      const numeric = number(value.exact); state.accepted += repeat; state.total = state.total.add(numeric.multiply(new WorkbookExactNumber(BigInt(repeat))));
      if (!state.minimum || numeric.compare(state.minimum) < 0) state.minimum = numeric;
      if (!state.maximum || numeric.compare(state.maximum) > 0) state.maximum = numeric;
    }
  }
  for (const group of groups.values()) {
    progress(); const output: WorkbookRow = Object.create(null); const facts = [];
    for (let index = 0; index < spec.group_by.length; index++) output[spec.group_by[index]] = group.keys[index];
    for (let index = 0; index < spec.fields.length; index++) {
      const field = spec.fields[index]; const state = group.states[index];
      const invalid = state.missing + state.errors + state.unsupported + state.filterUnknown + state.groupUnknown;
      const partial = spec.missing === 'exclude-with-counts' && invalid > 0;
      facts.push({ field: field.as, operation: field.operation, input_field: field.field ?? null, input_rows: group.rows,
        accepted: state.accepted, missing: state.missing, errors: state.errors, unsupported: state.unsupported, merged: state.merged, excluded: state.excluded,
        filter_unknown: state.filterUnknown, group_unknown: state.groupUnknown, partial });
      if (state.groupUnknown) { output[field.as] = { kind: 'missing', reason: 'group-key-unresolved' }; continue; }
      if (state.filterUnknown) { output[field.as] = { kind: 'missing', reason: 'filter-inclusion-unresolved' }; continue; }
      if (invalid && spec.missing === 'propagate') {
        output[field.as] = { kind: 'missing', reason: 'aggregate-input-missing-or-error' }; continue;
      }
      const result = field.operation === 'count' ? new WorkbookExactNumber(BigInt(state.accepted))
        : field.operation === 'sum' ? state.total : field.operation === 'min' ? state.minimum : field.operation === 'max' ? state.maximum
        : state.accepted ? state.total.divide(new WorkbookExactNumber(BigInt(state.accepted))) : undefined;
      const display = result && field.operation !== 'count' && !state.formatMixed && state.formatCode
        ? workbookNumberDisplay(result, { id: -1, code: state.formatCode, interpretation: 'number' }) : undefined;
      output[field.as] = result ? { kind: 'number', exact: result.json(), ...(display ? { display } : {}) } : { kind: 'missing', reason: 'empty-aggregate' };
    }
    yield { row: output, facts };
  }
}
/** CSV numeric conversion is explicit and recorded by the future select step, never automatic locale coercion. */
export function workbookNumericLiteral(raw: string, digitAllowance?: number): WorkbookDatum {
  try { return { kind: 'number', exact: WorkbookExactNumber.parse(raw, digitAllowance).json() }; }
  catch (error) {
    if (error instanceof Error && error.message === 'ambiguous-or-nonnumeric-literal') return { kind: 'error', code: 'nonnumeric-literal' };
    throw error;
  }
}
export function workbookSelectNumber(value: WorkbookDatum, digitAllowance?: number): WorkbookDatum {
  return value.kind === 'string' ? workbookNumericLiteral(value.text, digitAllowance)
    : value.kind === 'merged' && value.anchor ? { ...value, anchor: workbookSelectNumber(value.anchor, digitAllowance) } : value;
}
export function workbookUnitConvert(value: WorkbookDatum, factor: string, offset: string, digitAllowance?: number): WorkbookDatum {
  return workbookUnitConverter(factor, offset, digitAllowance)(value);
}
export function workbookUnitConverter(factor: string, offset: string, digitAllowance?: number): (value: WorkbookDatum) => WorkbookDatum {
  const multiplier = WorkbookExactNumber.parse(factor, digitAllowance); const addition = WorkbookExactNumber.parse(offset, digitAllowance);
  const convert = (value: WorkbookDatum): WorkbookDatum => value.kind === 'number' ? { kind: 'number', exact: number(value.exact).multiply(multiplier).add(addition).json() }
    : value.kind === 'merged' ? { ...value, ...(value.anchor ? { anchor: convert(value.anchor) } : {}) }
    : value.kind === 'missing' || value.kind === 'error' || value.kind === 'excluded' ? value : { kind: 'error', code: 'unit-conversion-nonnumeric' };
  return convert;
}
