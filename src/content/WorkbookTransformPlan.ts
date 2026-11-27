import type { WorkbookAggregateField } from './WorkbookAggregate';
export type WorkbookMissingPolicy = 'propagate' | 'exclude-with-counts';
export interface WorkbookPlanSource { name: string; snapshot_ref: string; sheet_id?: string; range?: string; visibility: 'all' | 'visible-only' }
export interface WorkbookSelectColumn { column: string; as: string; as_number: boolean }
export type WorkbookPredicate = { column: string; operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'is-missing' | 'is-error';
  value?: { kind: 'number' | 'string'; value: string } | { kind: 'boolean'; value: boolean } };
export type WorkbookPlanStep = { id: string; input: string } & (
  { operation: 'select'; columns: WorkbookSelectColumn[] } | { operation: 'filter'; predicate: WorkbookPredicate; missing: WorkbookMissingPolicy }
  | { operation: 'group'; by: string[] } | { operation: 'aggregate'; fields: WorkbookAggregateField[]; missing: WorkbookMissingPolicy }
  | { operation: 'unit-convert'; column: string; as: string; factor: string; offset: string; from_unit: string; to_unit: string });
export interface WorkbookTransformPlan { sources: WorkbookPlanSource[]; steps: WorkbookPlanStep[]; output: string }
export class WorkbookTransformPlanError extends Error {
  constructor(readonly detail: string) { super('invalid-transform-plan'); }
}
const fail = (detail = 'Use the documented fields and value types for this operation.'): never => { throw new WorkbookTransformPlanError(detail); };
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected an object.');
  const unexpected = Object.keys(value).filter(key => !keys.includes(key));
  if (unexpected.length) return fail(`Unexpected fields ${unexpected.join(', ')}. Allowed fields: ${keys.join(', ')}.`);
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : fail();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const missing = (value: unknown): WorkbookMissingPolicy => value === undefined ? 'propagate' : value === 'propagate' || value === 'exclude-with-counts' ? value : fail();
const optionalString = (value: unknown) => value === undefined ? undefined : string(value);
/** Validate shape/reference order in the host, but never perform numeric allocations or model-supplied code there. */
export function validateWorkbookTransformPlan(value: unknown): WorkbookTransformPlan {
  const input = object(value, ['sources', 'steps', 'output']); const names = new Set<string>();
  const sources = array(input.sources).map(value => {
    const source = object(value, ['name', 'snapshot_ref', 'sheet_id', 'range', 'visibility']); const name = string(source.name);
    if (names.has(name)) return fail(); names.add(name);
    const visibility = source.visibility ?? 'all'; if (visibility !== 'all' && visibility !== 'visible-only') return fail();
    return { name, snapshot_ref: string(source.snapshot_ref), sheet_id: optionalString(source.sheet_id), range: optionalString(source.range), visibility } as WorkbookPlanSource;
  });
  const steps = array(input.steps).map((value, index): WorkbookPlanStep => {
    try {
    const item = object(value, ['id', 'input', 'operation', 'columns', 'predicate', 'missing', 'by', 'fields', 'column', 'as', 'factor', 'offset', 'from_unit', 'to_unit']);
    const id = string(item.id); const input = string(item.input); if (names.has(id) || !names.has(input)) return fail(); names.add(id);
    const base = { id, input };
    const only = (keys: string[]) => {
      const unexpected = Object.keys(item).filter(key => !['id', 'input', 'operation', ...keys].includes(key));
      if (unexpected.length) fail(`${String(item.operation)} accepts only ${keys.join(', ')} in addition to id, input, operation; remove ${unexpected.join(', ')}.`
        + (item.operation === 'group' ? ' For sums, add a following aggregate step with fields; its input is this group step id.' : ''));
    };
    if (item.operation === 'select') {
      only(['columns']); const columns = array(item.columns).map(value => {
        const selected = object(value, ['column', 'as', 'as_number']); const column = string(selected.column);
        if (selected.as_number !== undefined && typeof selected.as_number !== 'boolean') return fail();
        return { column, as: selected.as === undefined ? column : string(selected.as), as_number: selected.as_number === true };
      });
      if (new Set(columns.map(column => column.as)).size !== columns.length) return fail();
      return { ...base, operation: 'select', columns };
    }
    if (item.operation === 'group') { only(['by']); const by = array(item.by).map(string); if (new Set(by).size !== by.length) return fail(); return { ...base, operation: 'group', by }; }
    if (item.operation === 'aggregate') {
      only(['fields', 'missing']); const fields = array(item.fields).map((value): WorkbookAggregateField => {
        const field = object(value, ['operation', 'field', 'as']); const operation = field.operation;
        if (operation !== 'sum' && operation !== 'count' && operation !== 'min' && operation !== 'max' && operation !== 'average') return fail();
        if (operation !== 'count' && field.field === undefined) return fail();
        return { operation, field: optionalString(field.field), as: string(field.as) };
      });
      if (!fields.length || new Set(fields.map(field => field.as)).size !== fields.length) return fail();
      return { ...base, operation: 'aggregate', fields, missing: missing(item.missing) };
    }
    if (item.operation === 'unit-convert') {
      only(['column', 'as', 'factor', 'offset', 'from_unit', 'to_unit']); const column = string(item.column);
      return { ...base, operation: 'unit-convert', column, as: item.as === undefined ? column : string(item.as), factor: string(item.factor),
        offset: item.offset === undefined ? '0' : string(item.offset), from_unit: string(item.from_unit), to_unit: string(item.to_unit) };
    }
    if (item.operation === 'filter') {
      only(['predicate', 'missing']); const raw = object(item.predicate, ['column', 'operator', 'value']); const operator = raw.operator;
      if (operator !== 'eq' && operator !== 'ne' && operator !== 'lt' && operator !== 'lte' && operator !== 'gt' && operator !== 'gte' && operator !== 'is-missing' && operator !== 'is-error') return fail();
      let literal: WorkbookPredicate['value'];
      if (operator === 'is-missing' || operator === 'is-error') { if (raw.value !== undefined) return fail(); }
      else {
        const value = object(raw.value, ['kind', 'value']);
        if (value.kind === 'boolean' && typeof value.value === 'boolean') literal = { kind: 'boolean', value: value.value };
        else if ((value.kind === 'number' || value.kind === 'string') && typeof value.value === 'string') literal = { kind: value.kind, value: value.value };
        else return fail();
      }
      return { ...base, operation: 'filter', predicate: { column: string(raw.column), operator, ...(literal ? { value: literal } : {}) }, missing: missing(item.missing) };
    }
    return fail('operation must be select, filter, group, aggregate or unit-convert.');
    } catch (error) {
      if (error instanceof WorkbookTransformPlanError) throw new WorkbookTransformPlanError(`steps[${index}]: ${error.detail}`);
      throw error;
    }
  });
  const output = input.output === undefined ? steps.at(-1)?.id : string(input.output);
  if (!sources.length || !steps.length || !output || !names.has(output)) return fail();
  return { sources, steps, output };
}
/** Caller-supplied selectors only: a checklist, not a claim that every selector is invalid. */
export function workbookTransformColumnHint(plan: WorkbookTransformPlan): string {
  const selectors = plan.steps.flatMap((step, index) => {
    const prefix = `steps[${index}]`;
    if (step.operation === 'select') return step.columns.map((item, i) => `${prefix}.columns[${i}].column=${JSON.stringify(item.column)}`);
    if (step.operation === 'group') return step.by.map((column, i) => `${prefix}.by[${i}]=${JSON.stringify(column)}`);
    if (step.operation === 'aggregate') return step.fields.flatMap((item, i) => item.field === undefined ? [] : [`${prefix}.fields[${i}].field=${JSON.stringify(item.field)}`]);
    return [`${prefix}.${step.operation === 'filter' ? 'predicate.column' : 'column'}=${JSON.stringify(step.operation === 'filter' ? step.predicate.column : step.column)}`];
  });
  return `Unknown input column. Check requested selectors: ${selectors.join('; ')}. Source inputs use A/B/C within the selected range, not header text. To use Region or Sales, first select the source letters with as aliases (as_number: true for numeric CSV strings), then reference those aliases from that select step. Earlier-step inputs use fields that step actually returned.`;
}
export function workbookPlanDependencies(plan: WorkbookTransformPlan) {
  const needed = new Set<string>(); const pending = [plan.output]; const steps = new Map(plan.steps.map(step => [step.id, step]));
  while (pending.length) { const name = pending.pop()!; if (needed.has(name)) continue; needed.add(name); const step = steps.get(name); if (step) pending.push(step.input); }
  return { sources: plan.sources.filter(source => needed.has(source.name)), steps: plan.steps.filter(step => needed.has(step.id)) };
}
