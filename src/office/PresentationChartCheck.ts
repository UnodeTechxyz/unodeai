import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { parse, member, relationship, chartValues, sheetValues } from './PresentationChartZero';
import { columnName } from '../content/WorkbookPage';
import type { PresentationChartExpectation, PresentationChartFact } from './PresentationChartBinding';
import { presentationTableComparisonText } from './PresentationDataCheck';
import { presentationChartDisplayDifferences } from './PresentationChartDisplay';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function sharedStrings(xml: string): string[] {
  const strings: string[] = []; let current: string | undefined; let text = false;
  parse(xml, tag => { if (tag.uri !== S) return; if (tag.local === 'si') current = ''; else if (tag.local === 't') text = true; },
    tag => { if (tag.uri !== S) return; if (tag.local === 't') text = false; else if (tag.local === 'si') { strings.push(current ?? ''); current = undefined; } },
    value => { if (text && current !== undefined) current += value; }); return strings;
}
function categories(xml: string): Array<{ labels: Map<number, string>; name: string }> {
  const series: Array<{ labels: Map<number, string>; name: string }> = []; let current: typeof series[number] | undefined;
  let cat = false; let tx = false; let point: number | undefined; let text = false; let value = '';
  parse(xml, tag => { if (tag.uri !== C) return;
    if (tag.local === 'ser') { current = { labels: new Map(), name: '' }; series.push(current); }
    else if (tag.local === 'cat') cat = true;
    else if (tag.local === 'tx' && current) tx = true;
    else if (tag.local === 'pt' && cat) { const index = Object.values(tag.attributes).find(attribute => attribute.local === 'idx')?.value; point = index !== undefined && /^\d+$/.test(index) ? Number(index) : undefined; }
    else if (tag.local === 'v' && (cat || tx)) { text = true; value = ''; }
  }, tag => { if (tag.uri !== C) return;
    if (tag.local === 'v' && text) {
      if (cat && point !== undefined) { if (current!.labels.has(point)) throw new Error('duplicate-chart-label'); current!.labels.set(point, value); }
      else if (tx) current!.name += value;
      text = false;
    }
    else if (tag.local === 'pt') point = undefined;
    else if (tag.local === 'cat') cat = false;
    else if (tag.local === 'tx') tx = false;
    else if (tag.local === 'ser') current = undefined;
  }, chunk => { if (text) value += chunk; }); return series;
}
function notesBody(xml: string): string {
  let body = false; let text = false; const parts: string[] = [];
  parse(xml, tag => {
    if (tag.uri === P && tag.local === 'sp') body = false;
    if (tag.uri === P && tag.local === 'ph' && Object.values(tag.attributes).some(attribute => attribute.local === 'type' && attribute.value === 'body')) body = true;
    if (body && tag.uri === A && tag.local === 't') text = true;
  }, tag => { if (tag.uri === A && tag.local === 't') text = false; if (tag.uri === P && tag.local === 'sp') body = false; },
  value => { if (body && text) parts.push(value); }); return parts.join('');
}
const numeric = (text: string | undefined, expected: number | null) => expected === null ? text === ''
  : text !== undefined && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) === expected;
const sameText = (actual: string | undefined, expected: string) => actual !== undefined && presentationTableComparisonText(actual) === presentationTableComparisonText(expected);

/** Compare both the actual native chart cache and the linked editable XLSX; retain source precision separately. */
export async function checkPresentationCharts(bytes: Buffer, expected: readonly PresentationChartExpectation[]): Promise<PresentationChartFact[]> {
  if (!expected.length) return [];
  const digest = createHash('sha256').update(bytes).digest('hex'); const zip = await JSZip.loadAsync(bytes); const facts: PresentationChartFact[] = [];
  for (const item of expected) {
    let differences = 0;
    try {
      const slide = `ppt/slides/slide${item.fact.slide}.xml`; const ids: string[] = [];
      parse(await member(zip, slide), tag => { if (tag.uri === C && tag.local === 'chart') {
        const id = Object.values(tag.attributes).find(attribute => attribute.uri === R && attribute.local === 'id')?.value; if (id) ids.push(id);
      } });
      const chart = await relationship(zip, slide, ids[item.fact.chart - 1], 'chart'); const xml = await member(zip, chart);
      const cache = chartValues(xml); const labels = categories(xml);
      const embedded = await relationship(zip, chart, cache.embedded, 'package'); const workbook = await JSZip.loadAsync(await zip.file(embedded)!.async('nodebuffer'));
      differences += await presentationChartDisplayDifferences(xml, workbook, item);
      const cells = sheetValues(await member(workbook, 'xl/worksheets/sheet1.xml')); const strings = sharedStrings(await member(workbook, 'xl/sharedStrings.xml'));
      const stringCell = (ref: string) => { const cell = cells.get(ref); return cell?.type === 's' && /^\d+$/.test(cell.value) ? strings[Number(cell.value)] : undefined; };
      differences += Math.abs(cache.series.length - item.values.series.length);
      for (const [index, series] of item.values.series.entries()) {
        const cached = cache.series[index]; differences += Math.abs((cached?.size ?? 0) - series.values.length);
        if (!sameText(stringCell(`${columnName(index + 2)}1`), series.name)) differences++;
        if (!sameText(labels[index]?.name, series.name) || labels[index]?.labels.size !== series.labels.length) differences++;
        for (let point = 0; point < series.values.length; point++) {
          if (!numeric(cached?.get(point), series.values[point])) differences++;
          const cell = cells.get(`${columnName(index + 2)}${point + 2}`);
          if (!cell || (cell.type !== undefined && cell.type !== 'n') || !numeric(cell.value, series.values[point])) differences++;
          if (!sameText(stringCell(`A${point + 2}`), series.labels[point])) differences++;
          if (!sameText(labels[index]?.labels.get(point), series.labels[point])) differences++;
        }
      }
      if (item.values.exactNote) {
        let notesId: string | undefined;
        const rels = slide.replace(/([^/]+)$/, '_rels/$1.rels');
        parse(await member(zip, rels), tag => {
          const attributes = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.local, attribute.value]));
          if (tag.local === 'Relationship' && attributes.Type === R + '/notesSlide') notesId = attributes.Id;
        });
        const notes = notesId ? await relationship(zip, slide, notesId, 'notesSlide') : '';
        if (!notes || !notesBody(await member(zip, notes)).includes(`Chart ${item.fact.chart}\n${item.values.exactNote}`)) differences++;
      }
    } catch { differences++; }
    const partial = item.fact.partial || item.fact.precision_loss > 0 || item.fact.blank_points > 0 || item.fact.unknown_labels > 0;
    facts.push({ ...item.fact, output: { status: differences ? 'failed' : !item.fact.points ? 'not-performed' : partial ? 'partial' : 'passed', differences, package_sha256: digest, text_comparison: 'powerpoint-line-breaks' } });
  }
  return facts;
}
