import { DocumentFailure } from '../content/document/DocumentContracts';
import { validateWorkbookDataSelection, type WorkbookDataSelection } from '../content/WorkbookBinding';
import type { PresentationDataFact } from './PresentationDataBinding';
import { validatePresentationChartSource, type PresentationChartSource, type PresentationChartFact } from './PresentationChartBinding';

export interface Box { x: number; y: number; w: number; h: number }
export type PresentationObject =
  | (Box & { type: 'image'; asset_ref: string; altText: string })
  | (Box & { type: 'text'; text: string; fontSize: number; bold: boolean; color: string })
  | (Box & { type: 'table'; rows: string[][]; fontSize: number; data_from?: WorkbookDataSelection })
  | (Box & { type: 'chart'; chartType: 'bar' | 'line' | 'pie'; series: Array<{ name: string; labels: string[]; values: Array<number | null> }>; data_from?: PresentationChartSource })
  | (Box & { type: 'shape'; shape: 'rect' | 'ellipse'; fill: string; line: string });
export interface PresentationDeck {
  title: string;
  layout: 'wide' | 'standard';
  slides: Array<{ objects: PresentationObject[]; notes?: string }>;
}
export interface PresentationRequest { schema_version: 1; path: string; deck: PresentationDeck }
export interface PresentationImageInput { assetRef: string; bytes: Buffer; sha256: string }
export interface PresentationImageReceipt { assetRef: string; sha256: string; width: number; height: number; placements: number;
  embeddedSha256?: string; sourceMimeType?: 'image/png' | 'image/jpeg'; orientation?: number;
  colorProfile?: 'none' | 'preserved-rgb' | 'unverified' }
export interface PresentationRender { bytes: Buffer; slides: number; images?: PresentationImageReceipt[]; dataBindings?: PresentationDataFact[]; chartBindings?: PresentationChartFact[] }
export interface PresentationReceipt {
  kind: 'presentation-written'; version: 1; path: string; bytes: number; sha256: string; slides: number;
  effect: 'created' | 'replaced' | 'unchanged'; restorePointId?: string;
  images?: PresentationImageReceipt[];
  dataBindings?: PresentationDataFact[];
  chartBindings?: PresentationChartFact[];
}
export interface PresentationWriteFact { code: string; receipt?: PresentationReceipt; targetEffect?: 'none' | 'uncertain' }
export class PresentationInputFailure extends DocumentFailure {
  constructor(public readonly location: string, public readonly issue: string) { super('invalid-input'); }
}
export class PresentationImageFailure extends DocumentFailure {
  constructor(public readonly imageIssue: 'invalid-image' | 'unsupported-image' | 'out-of-memory' | 'image-unavailable') {
    super(imageIssue === 'out-of-memory' ? 'out-of-memory' : 'invalid-input');
  }
}
const bad = (issue = 'Check the required fields and allowed values.'): never => { throw new PresentationInputFailure('', issue); };
function at<T>(location: string, work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof PresentationInputFailure) throw new PresentationInputFailure(location + (error.location ? `.${error.location}` : ''), error.issue);
    throw error;
  }
}
const illegalXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u;
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key));
  if (unexpected.length) return bad(`Unexpected fields ${unexpected.join(', ')}. Allowed fields: ${allowed.join(', ')}.`);
  return record;
}
function text(value: unknown): string { if (typeof value !== 'string' || illegalXml.test(value)) return bad(); return value; }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return bad('Use a finite JSON number.'); return value; }
function positive(value: unknown): number { const number = finite(value); return number > 0 ? number : bad('Use a number greater than zero.'); }
function color(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^#?[a-f0-9]{6}$/i.test(value)) return bad();
  return value.replace(/^#/, '').toUpperCase();
}
function box(value: Record<string, unknown>): Box {
  return { x: at('x', () => finite(value.x)), y: at('y', () => finite(value.y)), w: at('w', () => positive(value.w)), h: at('h', () => positive(value.h)) };
}
function element(input: unknown): PresentationObject {
  const common = ['type', 'x', 'y', 'w', 'h'];
  const raw = object(input, [...common, 'text', 'fontSize', 'bold', 'color', 'rows', 'chartType', 'series', 'shape', 'fill', 'line', 'asset_ref', 'altText', 'data_from']);
  if (raw.type === 'image') {
    object(raw, [...common, 'asset_ref', 'altText']);
    const ref = text(raw.asset_ref);
    if (!/^content-[1-9]\d*$/.test(ref)) return bad('Use a current image asset_ref supplied by the host, never a URL or file path.');
    return { ...box(raw), type: 'image', asset_ref: ref, altText: text(raw.altText ?? '') };
  }
  if (raw.type === 'text') {
    object(raw, [...common, 'text', 'fontSize', 'bold', 'color']);
    if (raw.bold !== undefined && typeof raw.bold !== 'boolean') return bad();
    return { ...box(raw), type: 'text', text: text(raw.text), fontSize: positive(raw.fontSize ?? 18), bold: raw.bold === true,
      color: color(raw.color, '202020') };
  }
  if (raw.type === 'table') {
    object(raw, [...common, 'rows', 'fontSize', 'data_from']);
    let binding: WorkbookDataSelection | undefined;
    if (raw.data_from !== undefined) {
      try { binding = validateWorkbookDataSelection(raw.data_from); }
      catch { return bad('data_from needs a transformation_ref, selected fields and optional ordered one-based rows {first,last}.'); }
    }
    const supplied = raw.rows ?? (binding ? [] : undefined);
    if (!Array.isArray(supplied) || (!binding && supplied.length === 0)) return bad();
    const rows = supplied.map(row => {
      if (!Array.isArray(row) || row.length === 0) return bad();
      return row.map(cell => typeof cell === 'number' ? String(finite(cell)) : text(cell));
    });
    if (rows.some(row => row.length !== rows[0].length)) return bad('Table rows must have the same number of cells.');
    return { ...box(raw), type: 'table', rows, fontSize: positive(raw.fontSize ?? 18), ...(binding ? { data_from: binding } : {}) };
  }
  if (raw.type === 'chart') {
    object(raw, [...common, 'chartType', 'series', 'data_from']);
    let binding: PresentationChartSource | undefined;
    if (raw.data_from !== undefined) {
      try { binding = validatePresentationChartSource(raw.data_from); }
      catch { return bad('Chart data_from needs transformation_ref, label_field, value_fields and optional one-based rows {first,last}.'); }
    }
    if (raw.chartType !== 'bar' && raw.chartType !== 'line' && raw.chartType !== 'pie') return bad();
    const supplied = raw.series ?? (binding ? [] : undefined);
    if (!Array.isArray(supplied) || (!binding && supplied.length === 0)) return bad();
    const series = supplied.map((value, index) => at(`series[${index}]`, () => {
      const row = object(value, ['name', 'labels', 'values']);
      if (!Array.isArray(row.labels) || !Array.isArray(row.values) || (!binding && !row.labels.length) || row.labels.length !== row.values.length) return bad('Each chart series needs one finite numeric value per label.');
      return { name: text(row.name), labels: row.labels.map(text), values: row.values.map(value => binding && value === null ? null : finite(value)) };
    }));
    if (raw.chartType === 'pie' && (binding ? binding.value_fields.length !== 1 : series.length !== 1)) return bad('A native pie chart uses one series. Use one pie chart object per series, or a bar/line chart.');
    if (series.some(row => JSON.stringify(row.labels) !== JSON.stringify(series[0].labels))) return bad('Series in one category chart must use the same labels in the same order. Use separate chart objects for different categories.');
    return { ...box(raw), type: 'chart', chartType: raw.chartType, series, ...(binding ? { data_from: binding } : {}) };
  }
  if (raw.type === 'shape') {
    object(raw, [...common, 'shape', 'fill', 'line']);
    if (raw.shape !== 'rect' && raw.shape !== 'ellipse') return bad();
    return { ...box(raw), type: 'shape', shape: raw.shape, fill: color(raw.fill, 'FFFFFF'), line: color(raw.line, '202020') };
  }
  return bad();
}

/** Canonical data only: no script, URL, raw XML, file input or arbitrary library options reach the worker. */
export function validatePresentationRequest(input: unknown, options: { part?: boolean } = {}): PresentationRequest {
  const request = object(input, ['schema_version', 'path', 'deck']);
  if (request.schema_version !== 1) return at('schema_version', () => bad('Use schema_version:1.'));
  const target = text(request.path);
  if (!target.trim() || !/\.pptx$/i.test(target)) throw new DocumentFailure('extension-mismatch');
  const rawDeck = at('deck', () => object(request.deck, ['title', 'layout', 'slides']));
  if (rawDeck.layout !== undefined && rawDeck.layout !== 'wide' && rawDeck.layout !== 'standard') return at('deck.layout', () => bad('Use wide or standard.'));
  if (!Array.isArray(rawDeck.slides)) return at('deck.slides', () => bad('Supply an array of slides with objects arrays.'));
  const slides = rawDeck.slides.map((value, index) => at(`deck.slides[${index}]`, () => {
    const slide = object(value, ['objects', 'notes']);
    if (!Array.isArray(slide.objects)) return bad();
    return { objects: slide.objects.map((value, objectIndex) => at(`objects[${objectIndex}]`, () => element(value))), ...(slide.notes === undefined ? {} : { notes: text(slide.notes) }) };
  }));
  return { schema_version: 1, path: target, deck: { title: text(rawDeck.title ?? ''), layout: rawDeck.layout ?? 'wide',
    slides: slides.length || options.part ? slides : [{ objects: [] }] } };
}
