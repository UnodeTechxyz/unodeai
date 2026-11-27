import { readWorkbookBinding, validateWorkbookDataSelection, workbookBindingBounds, workbookExactText, type WorkbookBindingInput, type WorkbookBoundCell } from '../content/WorkbookBinding';
import { WorkbookExactNumber } from '../content/WorkbookExactNumber';
import type { ChartSheetCell } from './OfficeChartSheet';
export type OfficeChartKind = 'barChart' | 'lineChart' | 'pieChart' | 'scatterChart';
export interface OfficeChartSeries { name: string; values: Array<number | null>; labels?: string[]; x_values?: Array<number | null> }
export interface OfficeChartSource { transformation_ref: string; label_field?: string; x_field?: string; value_fields: string[]; rows?: { first: number; last: number } }
export interface OfficeChartEdit { op: 'update_chart_data'; target_ref: string; series: OfficeChartSeries[]; data_from?: OfficeChartSource }
export interface OfficeChartFact { target_ref: string; chart_type: OfficeChartKind; data_origin: 'supplied' | 'host-transformation'; transformation_ref?: string;
  sources: Array<{ snapshot_ref: string; sha256: string }>; points: number; blank_points: number; precision_loss: number; unknown_labels: number;
  partial: boolean; supplied_differences: number }
const bad = (): never => { throw new Error('invalid-office-edits'); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && !/[\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
const numbers = (value: unknown): value is Array<number | null> => Array.isArray(value) && value.every(value => value === null || typeof value === 'number' && Number.isFinite(value));
export function officeChartSelection(source: OfficeChartSource) {
  return { transformation_ref: source.transformation_ref, fields: [...new Set([source.label_field ?? source.x_field!, ...source.value_fields])], ...(source.rows ? { rows: source.rows } : {}) };
}
export function validateOfficeChartBindings(edits: readonly OfficeChartEdit[], inputs: readonly WorkbookBindingInput[]): void {
  for (const edit of edits) if (edit.data_from) {
    const input = inputs.find(input => input.transformationRef === edit.data_from!.transformation_ref); if (!input) throw new Error('snapshot-unavailable');
    workbookBindingBounds(input, officeChartSelection(edit.data_from));
  }
}
export function validOfficeChartFacts(edits: readonly OfficeChartEdit[], inputs: readonly WorkbookBindingInput[], raw: unknown): raw is OfficeChartFact[] {
  if (!Array.isArray(raw) || raw.length !== edits.length) return false;
  return raw.every((fact: OfficeChartFact, index) => {
    const edit = edits[index]; const source = edit.data_from; const input = source && inputs.find(input => input.transformationRef === source.transformation_ref);
    const rows = source && input ? source.rows ? source.rows.last - source.rows.first + 1 : input.manifest.table.rows : 0;
    const points = source ? rows * source.value_fields.length : edit.series.reduce((sum, series) => sum + series.values.length, 0);
    const sources = new Map<string, string>(); for (const raw of input?.manifest.source_reads ?? []) {
      const item = raw as { snapshot_ref?: unknown; source_sha256?: unknown };
      if (typeof item.snapshot_ref === 'string' && typeof item.source_sha256 === 'string') sources.set(item.snapshot_ref, item.source_sha256);
    }
    return !!fact && fact.target_ref === edit.target_ref && ['barChart', 'lineChart', 'pieChart', 'scatterChart'].includes(fact.chart_type)
      && fact.data_origin === (source ? 'host-transformation' : 'supplied') && fact.transformation_ref === source?.transformation_ref
      && fact.points === points && Number.isSafeInteger(fact.blank_points) && fact.blank_points >= 0 && fact.blank_points <= points
      && Number.isSafeInteger(fact.precision_loss) && fact.precision_loss >= 0 && fact.precision_loss <= points * 2
      && Number.isSafeInteger(fact.unknown_labels) && fact.unknown_labels >= 0 && fact.unknown_labels <= rows
      && [0, 1].includes(fact.supplied_differences) && (source && edit.series.length || fact.supplied_differences === 0)
      && fact.partial === (input?.manifest.table.partial === true || fact.blank_points > 0 || fact.precision_loss > 0 || fact.unknown_labels > 0)
      && Array.isArray(fact.sources) && fact.sources.length === sources.size && new Set(fact.sources.map(source => source?.snapshot_ref)).size === sources.size
      && fact.sources.every(source => source && sources.get(source.snapshot_ref) === source.sha256);
  });
}
export function validateOfficeChartEdit(value: Record<string, unknown>): OfficeChartEdit {
  if (value.op !== 'update_chart_data' || Object.keys(value).some(key => !['op', 'target_ref', 'series', 'data_from'].includes(key)) || typeof value.target_ref !== 'string'
    || (value.series === undefined && value.data_from === undefined) || (value.series !== undefined && !Array.isArray(value.series))) return bad();
  const series = ((value.series ?? []) as unknown[]).map((item): OfficeChartSeries => {
    if (!object(item) || Object.keys(item).some(key => !['name', 'labels', 'values', 'x_values'].includes(key)) || !string(item.name) || !numbers(item.values)
      || (item.labels === undefined) === (item.x_values === undefined)) return bad();
    if (item.labels !== undefined) {
      if (!Array.isArray(item.labels) || !item.labels.every(string) || item.labels.length !== item.values.length) return bad();
      return { name: item.name, values: [...item.values], labels: [...item.labels] };
    }
    if (!numbers(item.x_values) || item.x_values.length !== item.values.length) return bad();
    return { name: item.name, values: [...item.values], x_values: [...item.x_values] };
  });
  let data_from: OfficeChartSource | undefined;
  if (value.data_from !== undefined) {
    const raw = value.data_from;
    if (!object(raw) || Object.keys(raw).some(key => !['transformation_ref', 'label_field', 'x_field', 'value_fields', 'rows'].includes(key))
      || typeof raw.transformation_ref !== 'string' || !raw.transformation_ref || (raw.label_field === undefined) === (raw.x_field === undefined)
      || typeof (raw.label_field ?? raw.x_field) !== 'string' || !(raw.label_field ?? raw.x_field)
      || !Array.isArray(raw.value_fields) || !raw.value_fields.length || raw.value_fields.some(field => typeof field !== 'string' || !field)
      || new Set(raw.value_fields).size !== raw.value_fields.length) return bad();
    data_from = { transformation_ref: raw.transformation_ref, value_fields: [...raw.value_fields] as string[],
      ...(raw.label_field !== undefined ? { label_field: raw.label_field as string } : { x_field: raw.x_field as string }) };
    const selection = validateWorkbookDataSelection({ ...officeChartSelection(data_from), ...(raw.rows === undefined ? {} : { rows: raw.rows }) });
    if (selection.rows) data_from.rows = selection.rows;
  }
  return { op: 'update_chart_data', target_ref: value.target_ref, series, ...(data_from ? { data_from } : {}) };
}
const numeric = (cell: WorkbookBoundCell) => cell.state === 'known' && cell.value.kind === 'number'
  ? new WorkbookExactNumber(BigInt(cell.value.exact.numerator), BigInt(cell.value.exact.denominator)).chartNumber() : { value: null, exact: false };
const exactText = (cell: WorkbookBoundCell) => cell.value.kind === 'number'
  ? workbookExactText(new WorkbookExactNumber(BigInt(cell.value.exact.numerator), BigInt(cell.value.exact.denominator)))
  : cell.value.kind === 'missing' ? `[Missing: ${cell.value.reason}]`
    : cell.value.kind === 'date-serial' ? `${cell.value.raw} (Excel ${cell.value.epoch} date serial)` : cell.text;

/** Private host transformation cells override supplied series. Raw exact text stays in the editable data worksheet. */
export function officeChartData(edit: OfficeChartEdit, kind: OfficeChartKind, inputs: readonly WorkbookBindingInput[], progress: () => void) {
  let series = edit.series; const source = edit.data_from; const scatter = kind === 'scatterChart';
  const fact: OfficeChartFact = { target_ref: edit.target_ref, chart_type: kind, data_origin: source ? 'host-transformation' : 'supplied', sources: [],
    points: 0, blank_points: 0, precision_loss: 0, unknown_labels: 0, partial: false, supplied_differences: 0, ...(source ? { transformation_ref: source.transformation_ref } : {}) };
  const exact: string[][] = [];
  if (source) {
    if (scatter !== (source.x_field !== undefined)) throw new Error('invalid-source-selection');
    const input = inputs.find(input => input.transformationRef === source.transformation_ref); if (!input) throw new Error('snapshot-unavailable');
    const selection = officeChartSelection(source); const coordinate = selection.fields.indexOf(source.label_field ?? source.x_field!);
    series = source.value_fields.map(name => ({ name, values: [], ...(scatter ? { x_values: [] } : { labels: [] }) }));
    for (const block of readWorkbookBinding(input, selection, progress)) for (let repeat = 0; repeat < block.repeat; repeat++) {
      progress(); const axis = block.cells[coordinate]; if (!scatter && axis.state !== 'known') fact.unknown_labels++;
      const x = scatter ? numeric(axis) : undefined;
      for (const [index, field] of source.value_fields.entries()) {
        const cell = block.cells[selection.fields.indexOf(field)]; const plotted = numeric(cell); series[index].values.push(plotted.value);
        if (scatter) series[index].x_values!.push(x!.value); else series[index].labels!.push(axis.text);
        if (plotted.value !== null && !plotted.exact) fact.precision_loss++;
        if (scatter && x!.value !== null && !x!.exact) fact.precision_loss++;
        (exact[index] ??= []).push(JSON.stringify({ row: block.firstRow + repeat, axis: exactText(axis), value: exactText(cell),
          axis_display_text: axis.text, display_text: cell.text, axis_state: axis.state, value_state: cell.state }));
      }
    }
    for (const raw of input.manifest.source_reads) {
      const item = raw as { snapshot_ref?: unknown; source_sha256?: unknown };
      if (typeof item.snapshot_ref === 'string' && typeof item.source_sha256 === 'string' && !fact.sources.some(source => source.snapshot_ref === item.snapshot_ref))
        fact.sources.push({ snapshot_ref: item.snapshot_ref, sha256: item.source_sha256 });
    }
    fact.partial = input.manifest.table.partial === true;
    if (edit.series.length && JSON.stringify(edit.series) !== JSON.stringify(series)) fact.supplied_differences = 1;
  }
  if (series.some(item => scatter ? !item.x_values || item.labels !== undefined : !item.labels || item.x_values !== undefined)) return bad();
  if (kind === 'pieChart' && series.length > 1 || (kind === 'barChart' || kind === 'lineChart')
    && series.some(item => JSON.stringify(item.labels) !== JSON.stringify(series[0]?.labels))) return bad();
  const stride = source ? 3 : 2; const columns = Math.max(1, series.length * stride); const points = series.reduce((largest, item) => Math.max(largest, item.values.length), 0);
  const rows: ChartSheetCell[][] = [series.length ? series.flatMap(item => [scatter ? 'X' : 'Category', item.name, ...(source ? ['Exact source values (JSON)'] : [])]) : ['Category']];
  for (let point = 0; point < points; point++) {
    const row: ChartSheetCell[] = Array(columns).fill(null);
    for (const [index, item] of series.entries()) if (point < item.values.length) {
      row[index * stride] = scatter ? item.x_values![point] : item.labels![point]; row[index * stride + 1] = item.values[point];
      if (source) row[index * stride + 2] = exact[index][point];
      fact.points++; if (item.values[point] === null || scatter && item.x_values![point] === null) fact.blank_points++;
    }
    rows.push(row); progress();
  }
  fact.partial ||= fact.blank_points > 0 || fact.precision_loss > 0 || fact.unknown_labels > 0;
  return { series, rows, stride, fact };
}
