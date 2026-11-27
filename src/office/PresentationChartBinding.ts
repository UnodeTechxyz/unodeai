import { readWorkbookBinding, validateWorkbookDataSelection, workbookExactText, type WorkbookBindingInput, type WorkbookDataSelection, type WorkbookBoundCell } from '../content/WorkbookBinding';
import { WorkbookExactNumber } from '../content/WorkbookExactNumber';
import type { PresentationDeck } from './PresentationContracts';
import { PresentationInputFailure, validatePresentationRequest } from './PresentationContracts';
import { PresentationDataFailure } from './PresentationDataFailure';
export interface PresentationChartSource { transformation_ref: string; label_field: string; value_fields: string[]; rows?: { first: number; last: number } }
export interface PresentationChartPoint { row: number; field: string; exact_text: string; kind: string; value: number | null; binary_exact: boolean; unresolved: boolean;
  display_text?: string; format_code?: string; display_precision?: number; series_index?: number }
export interface BoundChartValues { labels: string[]; series: Array<{ name: string; labels: string[]; values: Array<number | null> }>;
  points: PresentationChartPoint[]; unknownLabels: number; partial: boolean; exactNote: string }
const invalid = (): never => { throw new Error('invalid-chart-data-selection'); };
export function validatePresentationChartSource(input: unknown): PresentationChartSource {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(); const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['transformation_ref', 'label_field', 'value_fields', 'rows'].includes(key))
    || typeof raw.label_field !== 'string' || !raw.label_field || !Array.isArray(raw.value_fields) || !raw.value_fields.length
    || raw.value_fields.some(field => typeof field !== 'string' || !field)) return invalid();
  const selected = validateWorkbookDataSelection({ transformation_ref: raw.transformation_ref,
    fields: [...new Set([raw.label_field, ...raw.value_fields])], ...(raw.rows === undefined ? {} : { rows: raw.rows }) });
  return { transformation_ref: selected.transformation_ref, label_field: raw.label_field, value_fields: [...raw.value_fields] as string[], ...(selected.rows ? { rows: selected.rows } : {}) };
}
export function presentationChartSelection(source: PresentationChartSource): WorkbookDataSelection {
  return { transformation_ref: source.transformation_ref, fields: [...new Set([source.label_field, ...source.value_fields])], ...(source.rows ? { rows: source.rows } : {}) };
}
/** JSON ASCII retains exact text without introducing Office escape sequences or XML-unsafe source characters. */
const noteRecord = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff_]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
function number(cell: WorkbookBoundCell) {
  if (cell.state !== 'known' || cell.value.kind !== 'number') return { value: null, exact: false };
  return new WorkbookExactNumber(BigInt(cell.value.exact.numerator), BigInt(cell.value.exact.denominator)).chartNumber();
}
/** Actual private table -> fixed native chart arrays. Missing/non-numeric/overflow is blank, never a guessed zero. */
export function bindPresentationChart(input: WorkbookBindingInput, source: PresentationChartSource, progress: () => void = () => {}): BoundChartValues {
  const labels: string[] = []; const points: PresentationChartPoint[] = []; let unknownLabels = 0;
  const values = source.value_fields.map(() => [] as Array<number | null>); const retained: unknown[] = [];
  const selection = presentationChartSelection(source); const fields = selection.fields;
  for (const block of readWorkbookBinding(input, selection, progress)) {
    const label = block.cells[fields.indexOf(source.label_field)];
    for (let repeat = 0; repeat < block.repeat; repeat++) {
      progress(); const row = block.firstRow + repeat; labels.push(label.text); if (label.state !== 'known') unknownLabels++;
      for (const [index, field] of source.value_fields.entries()) {
        const cell = block.cells[fields.indexOf(field)]; const plotted = number(cell); values[index].push(plotted.value);
        const exactText = cell.value.kind === 'number' ? workbookExactText(new WorkbookExactNumber(BigInt(cell.value.exact.numerator), BigInt(cell.value.exact.denominator))) : cell.text;
        const format = cell.value.display?.format_code ?? (cell.display_precision === undefined ? undefined : '0.' + '#'.repeat(cell.display_precision));
        const point: PresentationChartPoint = { row, field, series_index: index, exact_text: exactText, kind: cell.value.kind, value: plotted.value, binary_exact: plotted.exact, unresolved: cell.state !== 'known' || cell.value.kind !== 'number',
          ...(format ? { display_text: cell.text, format_code: format } : {}), ...(cell.display_precision === undefined ? {} : { display_precision: cell.display_precision }) };
        points.push(point);
        retained.push({ row, label: label.text, field, exact_text: exactText, kind: cell.value.kind,
          ...(cell.value.kind === 'number' ? { exact: cell.value.exact } : {}), ...(format ? { display_text: cell.text, format_code: format } : {}) });
      }
    }
  }
  const series = source.value_fields.map((field, index) => ({ name: field, labels, values: values[index] }));
  return { labels, series, points, unknownLabels, partial: input.manifest.table.partial === true,
    exactNote: retained.length ? 'UnodeAi exact source values (JSON strings; chart Number precision may differ):\n' + retained.map(noteRecord).join('\n') : '' };
}

export interface PresentationChartFact {
  slide: number; object: number; chart: number; transformation_ref: string; selection: PresentationChartSource;
  sources: Array<{ snapshot_ref: string; sha256: string }>;
  points: number; precision_loss: number; blank_points: number; unknown_labels: number; partial: boolean;
  supplied: { present: boolean; differences: number };
  output?: { status: 'passed' | 'partial' | 'failed' | 'not-performed'; differences: number; package_sha256: string; text_comparison?: 'powerpoint-line-breaks' };
}
export interface PresentationChartExpectation { values: BoundChartValues; fact: PresentationChartFact }
export function bindPresentationCharts(deck: PresentationDeck, inputs: readonly WorkbookBindingInput[]) {
  const available = new Map(inputs.map(input => [input.transformationRef, input])); const expectations: PresentationChartExpectation[] = [];
  if (!deck.slides.some(slide => slide.objects.some(object => object.type === 'chart' && object.data_from))) return { deck, expectations };
  const slides = deck.slides.map((slide, slideIndex) => {
    let chart = 0; const notes: string[] = [];
    const objects = slide.objects.map((object, objectIndex) => {
      if (object.type !== 'chart') return object;
      chart++; if (!object.data_from) return object;
      const selection = object.data_from; const input = available.get(selection.transformation_ref);
      if (!input) throw new PresentationInputFailure('data_from', 'Use a transformation_ref returned by this agent’s transform_workbook.');
      const values = bindPresentationChart(input, selection); const present = object.series.length > 0; let differences = 0;
      if (present) {
        differences += Math.abs(object.series.length - values.series.length);
        for (const [index, expected] of values.series.entries()) {
          const supplied = object.series[index];
          if (!supplied) continue;
          if (supplied.name !== expected.name) differences++;
          differences += Math.abs(supplied.values.length - expected.values.length);
          for (let point = 0; point < expected.values.length; point++) {
            if (supplied.labels[point] !== expected.labels[point]) differences++;
            if (supplied.values[point] !== expected.values[point]) differences++;
          }
        }
      }
      const sources: PresentationChartFact['sources'] = [];
      for (const source of input.manifest.source_reads) {
        const record = source as { snapshot_ref?: unknown; source_sha256?: unknown };
        if (typeof record.snapshot_ref === 'string' && typeof record.source_sha256 === 'string' && !sources.some(source => source.snapshot_ref === record.snapshot_ref))
          sources.push({ snapshot_ref: record.snapshot_ref, sha256: record.source_sha256 });
      }
      expectations.push({ values, fact: { slide: slideIndex + 1, object: objectIndex + 1, chart, transformation_ref: input.transformationRef, selection, sources,
        points: values.points.length, precision_loss: values.points.filter(point => !point.binary_exact && !point.unresolved).length,
        blank_points: values.points.filter(point => point.value === null).length, unknown_labels: values.unknownLabels, partial: values.partial,
        supplied: { present, differences } } });
      if (values.exactNote) notes.push(`Chart ${chart}\n${values.exactNote}`);
      return { ...object, series: values.series };
    });
    return { ...slide, objects, ...(notes.length ? { notes: [slide.notes, ...notes].filter(Boolean).join('\n\n') } : {}) };
  });
  try { return { deck: validatePresentationRequest({ schema_version: 1, path: 'bound.pptx', deck: { ...deck, slides } }).deck, expectations }; }
  catch (error) { if (expectations.length && error instanceof PresentationInputFailure) throw new PresentationDataFailure(); throw error; }
}
