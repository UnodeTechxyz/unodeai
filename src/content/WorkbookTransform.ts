import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbookExactNumber, workbookArithmeticDigitAllowance } from './WorkbookExactNumber';
import { aggregateWorkbookRows, workbookSelectNumber, workbookUnitConverter, type WorkbookDatum, type WorkbookRow, type WorkbookRowBlock, type WorkbookGroupCounts } from './WorkbookAggregate';
import { WorkbookTableReader, WorkbookTableWriter, type WorkbookTableInfo } from './WorkbookTable';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import { csvWorkbookRows } from './WorkbookCsvRows';
import { xlsxWorkbookRows, type WorkbookSourceCounts } from './WorkbookXlsxRows';
import { columnName, columnNumber, parseWorkbookRange, type WorkbookRange } from './WorkbookPage';
import { xlsxRange, XLSX_COLUMNS, XLSX_ROWS } from './XlsxSheet';
import { workbookPlanDependencies, type WorkbookTransformPlan, type WorkbookPredicate, type WorkbookPlanSource } from './WorkbookTransformPlan';
import type { WorkbookSnapshotSource } from './WorkbookReader';

export interface WorkbookTransformInput { name: string; snapshot: Omit<WorkbookSnapshotSource, 'physicalKey' | 'sourcePath'> }
export interface WorkbookTransformManifest { schema_version: 1; computation: 'host-run'; computation_version: 1; plan: WorkbookTransformPlan;
  executed_steps: string[]; table: WorkbookTableInfo; source_reads: unknown[]; operations: unknown[]; factLists: Array<{ step: string; name: string; count: number }> }
interface View { columns(): string[]; canonical(column: string): string; read(selected: string[], operation: string): AsyncIterable<WorkbookRowBlock>;
  groupBy: string[]; partial: boolean; units: NonNullable<WorkbookTableInfo['units']>; info?: WorkbookTableInfo }
const numeric = (datum: Extract<WorkbookDatum, { kind: 'number' }>) => new WorkbookExactNumber(BigInt(datum.exact.numerator), BigInt(datum.exact.denominator));
function predicate(value: WorkbookDatum, test: WorkbookPredicate, literalNumber?: WorkbookExactNumber): boolean | undefined {
  if (test.operator === 'is-missing') return value.kind === 'missing'; if (test.operator === 'is-error') return value.kind === 'error';
  if (value.kind === 'string' && value.escapedCodeUnitsUnresolved) return undefined;
  const literal = test.value!; let comparison: number;
  if (value.kind === 'number' && literal.kind === 'number') comparison = numeric(value).compare(literalNumber!);
  else if (value.kind === 'string' && literal.kind === 'string') comparison = value.text < literal.value ? -1 : value.text > literal.value ? 1 : 0;
  else if (value.kind === 'boolean' && literal.kind === 'boolean') comparison = Number(value.value) - Number(literal.value);
  else return undefined;
  return test.operator === 'eq' ? comparison === 0 : test.operator === 'ne' ? comparison !== 0 : test.operator === 'lt' ? comparison < 0
    : test.operator === 'lte' ? comparison <= 0 : test.operator === 'gt' ? comparison > 0 : comparison >= 0;
}
function sourceView(input: WorkbookTransformInput, query: WorkbookPlanSource, facts: unknown[], progress: () => void): View {
  const manifest = input.snapshot.source;
  const sheet = manifest.format === 'xlsx' ? manifest.sheets.find(sheet => sheet.sheetId === (query.sheet_id ?? manifest.sheets.find(sheet => !!sheet.metadata && !sheet.gap)?.sheetId)) : undefined;
  let range: WorkbookRange;
  if (manifest.format === 'csv') {
    if ((query.sheet_id !== undefined && query.sheet_id !== 'csv:1') || query.visibility !== 'all') throw new Error('invalid-source-selection');
    range = parseWorkbookRange(query.range, manifest);
  } else {
    if (!sheet?.metadata || sheet.gap) throw new Error('unavailable-worksheet');
    try { range = query.range === undefined ? { firstRow: 1, lastRow: sheet.metadata.rows, firstColumn: 1, lastColumn: sheet.metadata.columns } : xlsxRange(query.range); }
    catch { throw new Error('invalid-range'); }
    if (range.lastRow > XLSX_ROWS || range.lastColumn > XLSX_COLUMNS) throw new Error('invalid-source-selection');
  }
  const canonical = (column: string) => {
    if (!/^[A-Z]+$/i.test(column)) throw new Error('unknown-transform-column'); const number = columnNumber(column.toUpperCase());
    if (number < range.firstColumn || number > range.lastColumn) throw new Error('unknown-transform-column'); return columnName(number);
  };
  return { groupBy: [], partial: false, units: Object.create(null), canonical,
    columns: () => { const columns: string[] = []; for (let column = range.firstColumn; column <= range.lastColumn; column++) columns.push(columnName(column)); return columns; },
    async *read(selected, operation) {
      const counts: WorkbookSourceCounts = { includedRows: 0, excludedRows: 0, hiddenRows: 0, hiddenColumns: 0, excludedColumns: 0 };
      const columns = [...new Set(selected)].map(column => ({ column: columnNumber(canonical(column)), as: column, as_number: false }));
      facts.push({ operation, snapshot_ref: input.snapshot.snapshotRef, source_sha256: input.snapshot.sourceSha256, sheet_id: sheet?.sheetId ?? 'csv:1',
        range, columns: selected, visibility: query.visibility, selection: 'saved-hidden-state-only', merge_anchors: 'same-snapshot labels; covered values remain structural',
        source_format: manifest.format, parse_settings: manifest.format === 'csv'
          ? { encoding: manifest.encoding, delimiter: manifest.delimiter, delimiter_selection: manifest.delimiterSelection, newline: manifest.newline, warnings: manifest.warnings }
          : { date1904: manifest.date1904, external_links_present: manifest.externalLinksPresent, calculation: manifest.calculation },
        cache: manifest.format === 'xlsx' ? manifest.cache : 'literal-strings', counts });
      if (manifest.format === 'csv') {
        for await (const row of csvWorkbookRows(input.snapshot.directory, manifest, range.firstRow, range.lastRow, columns, undefined, progress)) { counts.includedRows += row.repeat; yield row; }
      } else yield* xlsxWorkbookRows(input.snapshot.directory, manifest, sheet!, range.firstRow, range.lastRow, columns, query.visibility, counts, progress);
    } };
}
function materialized(directory: string, info: WorkbookTableInfo): View {
  return { columns: () => info.columns, canonical: column => { if (!info.columns.includes(column)) throw new Error('unknown-transform-column'); return column; },
    groupBy: info.groupBy ?? [], partial: info.partial === true, units: info.units ?? Object.create(null), info,
    async *read(selected) { const reader = new WorkbookTableReader(join(directory, info.directory), info.columns); try { yield* reader.read(selected); } finally { reader.close(); } } };
}
/** Fixed algorithms over private captured bytes. Model arguments name steps/selectors, never executable code or values claimed as results. */
export async function executeWorkbookTransform(directory: string, inputs: WorkbookTransformInput[], plan: WorkbookTransformPlan, progress: () => void): Promise<WorkbookTransformManifest> {
  const digitAllowance = workbookArithmeticDigitAllowance();
  const needed = workbookPlanDependencies(plan); const views = new Map<string, View>(); const sourceReads: unknown[] = []; const operations: unknown[] = [];
  const factLists: WorkbookTransformManifest['factLists'] = [];
  for (const query of needed.sources) { const input = inputs.find(input => input.name === query.name); if (!input) throw new Error('snapshot-unavailable'); views.set(query.name, sourceView(input, query, sourceReads, progress)); }
  const write = async (name: string, columns: string[], rows: AsyncIterable<WorkbookRowBlock>, input: View): Promise<View> => {
    const target = join(directory, name); await mkdir(target); const writer = new WorkbookTableWriter(target, columns, progress);
    try { for await (const row of rows) { progress(); writer.append(row); } return materialized(directory, { ...writer.info(name), groupBy: input.groupBy, partial: input.partial, units: input.units }); }
    finally { writer.close(); }
  };
  for (let index = 0; index < needed.steps.length; index++) {
    const step = needed.steps[index]; const input = views.get(step.input)!; const name = `step-${index + 1}`;
    if (step.operation === 'group') {
      const groupBy = step.by.map(column => input.canonical(column)); views.set(step.id, { ...input, groupBy, ...(input.info ? { info: { ...input.info, groupBy } } : {}) }); operations.push({ id: step.id, operation: step.operation, group_by: groupBy }); continue;
    }
    if (step.operation === 'select') {
      const columns = step.columns.map(column => ({ ...column, column: input.canonical(column.column) }));
      const view: View = { ...input, groupBy: input.groupBy.map(column => columns.find(selected => selected.column === column)?.as).filter((column): column is string => !!column),
        units: Object.fromEntries(columns.filter(column => Object.hasOwn(input.units, column.column)).map(column => [column.as, input.units[column.column]])) };
      const rows = (async function* () {
        for await (const block of input.read(columns.map(column => column.column), step.id)) {
          progress();
          const cells: WorkbookRow = Object.create(null);
          for (const column of columns) { const value = block.cells[column.column]; cells[column.as] = column.as_number ? workbookSelectNumber(value, digitAllowance) : value; }
          yield { ...block, cells };
        }
      })();
      views.set(step.id, await write(name, columns.map(column => column.as), rows, view)); operations.push({ id: step.id, operation: step.operation, columns, group_by: view.groupBy }); continue;
    }
    if (step.operation === 'aggregate') {
      const fields = step.fields.map(field => ({ ...field, field: field.field === undefined ? undefined : input.canonical(field.field) }));
      const columns = [...input.groupBy, ...fields.map(field => field.as)]; if (new Set(columns).size !== columns.length) throw new Error('invalid-transform-plan');
      const required = [...new Set([...input.groupBy, ...fields.flatMap(field => field.field === undefined ? [] : [field.field])])];
      const listName = `${name}-facts`; const facts = new WorkbookJsonIndex(directory, listName, true); const output: View = { ...input, groupBy: [],
        units: Object.fromEntries(fields.filter(field => field.operation !== 'count' && field.field !== undefined && Object.hasOwn(input.units, field.field)).map(field => [field.as, input.units[field.field!]])) };
      const groupCounts: WorkbookGroupCounts = { inputRows: 0, excludedGroupRows: 0, visibilityExcludedGroupRows: 0, missingGroupKeys: 0, errorGroupKeys: 0, unresolvedGroupKeys: 0 };
      const rows = (async function* () {
        let row = 0;
        for await (const result of aggregateWorkbookRows(input.read(required, step.id), { group_by: input.groupBy, fields, missing: step.missing }, progress, groupCounts)) {
          facts.append({ row: ++row, fields: result.facts }); if (result.facts.some(fact => fact.partial)) output.partial = true;
          yield { cells: result.row, repeat: 1 };
        }
      })();
      try { views.set(step.id, await write(name, columns, rows, output)); factLists.push({ step: step.id, name: listName, count: facts.count }); }
      finally { facts.close(); }
      if (groupCounts.excludedGroupRows) { const view = views.get(step.id)!; view.partial = true; view.info!.partial = true; }
      operations.push({ id: step.id, operation: step.operation, missing: step.missing, group_counts: groupCounts }); continue;
    }
    const columns = [...input.columns()];
    if (step.operation === 'unit-convert') {
      const column = input.canonical(step.column); const as = step.as === step.column ? column : step.as;
      if (!columns.includes(as)) columns.push(as);
      const output: View = { ...input, units: { ...input.units, [as]: { from: step.from_unit, to: step.to_unit, declared: true } } };
      const convert = workbookUnitConverter(step.factor, step.offset, digitAllowance);
      const rows = (async function* () {
        for await (const block of input.read(input.columns(), step.id)) { progress(); yield { ...block, cells: { ...block.cells, [as]: convert(block.cells[column]) } }; }
      })();
      views.set(step.id, await write(name, columns, rows, output)); operations.push({ id: step.id, operation: step.operation, column, as, unit_source: 'declared-parameter', from_unit: step.from_unit, to_unit: step.to_unit });
    } else {
      const test = { ...step.predicate, column: input.canonical(step.predicate.column) }; const counts = { accepted: 0, excluded: 0, unknown: 0 };
      const output: View = { ...input };
      const literal = test.value?.kind === 'number' ? WorkbookExactNumber.parse(test.value.value, digitAllowance) : undefined;
      const rows = (async function* () {
        for await (const block of input.read(columns, step.id)) {
          progress(); const keep = predicate(block.cells[test.column], test, literal);
          if (keep === true) { counts.accepted += block.repeat; yield block; }
          else if (keep === false) counts.excluded += block.repeat;
          else {
            counts.unknown += block.repeat;
            output.partial = true;
            if (step.missing === 'exclude-with-counts') { output.partial = true; counts.excluded += block.repeat; }
            else yield { ...block, uncertain: 'filter-predicate-unresolved' };
          }
        }
      })();
      views.set(step.id, await write(name, columns, rows, output)); operations.push({ id: step.id, operation: step.operation, missing: step.missing, counts });
    }
  }
  let output = views.get(plan.output)!; if (!output.info) output = await write('output', output.columns(), output.read(output.columns(), 'output'), output);
  return { schema_version: 1, computation: 'host-run', computation_version: 1, plan, executed_steps: needed.steps.map(step => step.id), table: output.info!,
    source_reads: sourceReads, operations, factLists };
}
