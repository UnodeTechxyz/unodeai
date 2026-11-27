import { posix } from 'node:path';
import JSZip from 'jszip';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { DocumentFailure } from '../content/document/DocumentContracts';
import type { PresentationDeck } from './PresentationContracts';
import { columnName } from '../content/WorkbookPage';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const failed = (): never => { throw new DocumentFailure('worker-exit'); };
const attribute = (tag: SaxesTagNS, name: string, namespace = '') => Object.values(tag.attributes).find(value => value.local === name && value.uri === namespace)?.value;
export function parse(xml: string, open: (tag: SaxesTagNS) => void, close: (tag: SaxesTagNS) => void = () => {}, text: (value: string) => void = () => {}) {
  const parser = new SaxesParser({ xmlns: true }); parser.on('doctype', failed);
  parser.on('opentag', open); parser.on('closetag', close); parser.on('text', text); parser.on('cdata', text); parser.write(xml).close();
}
export async function member(zip: JSZip, name: string): Promise<string> { const file = zip.file(name); return file ? file.async('string') : failed(); }
export async function relationship(zip: JSZip, owner: string, id: string, type: string): Promise<string> {
  const rels = posix.join(posix.dirname(owner), '_rels', posix.basename(owner) + '.rels'); let target: string | undefined;
  parse(await member(zip, rels), tag => {
    if (tag.uri !== P || tag.local !== 'Relationship' || attribute(tag, 'Id') !== id) return;
    if (target !== undefined || attribute(tag, 'Type') !== R + '/' + type || attribute(tag, 'TargetMode') === 'External') return failed();
    const raw = attribute(tag, 'Target'); if (!raw || raw.includes('\\')) return failed();
    target = posix.normalize(raw.startsWith('/') ? raw.slice(1) : posix.join(posix.dirname(owner), raw));
    if (target.startsWith('../') || target === '..') return failed();
  });
  return target ?? failed();
}
export function chartValues(xml: string) {
  const series: Map<number, string>[] = []; let current: Map<number, string> | undefined; let inValues = false; let inCache = false;
  let point: number | undefined; let value: string | undefined; let embedded: string | undefined;
  parse(xml, tag => {
    if (tag.uri !== C) return;
    if (tag.local === 'ser') { current = new Map(); series.push(current); }
    else if (tag.local === 'val' && current) inValues = true;
    else if (tag.local === 'numCache' && inValues) inCache = true;
    else if (tag.local === 'pt' && inCache) { const raw = attribute(tag, 'idx'); point = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined; }
    else if (tag.local === 'v' && point !== undefined && inCache) value = '';
    else if (tag.local === 'externalData') { if (embedded) return failed(); embedded = attribute(tag, 'id', R); }
  }, tag => {
    if (tag.uri !== C) return;
    if (tag.local === 'v' && value !== undefined && point !== undefined) { current!.set(point, value); value = undefined; }
    else if (tag.local === 'pt') point = undefined;
    else if (tag.local === 'numCache') inCache = false;
    else if (tag.local === 'val') inValues = false;
    else if (tag.local === 'ser') current = undefined;
  }, text => { if (value !== undefined) value += text; });
  return { series, embedded: embedded ?? failed() };
}
export function sheetValues(xml: string) {
  const cells = new Map<string, { type?: string; value: string }>(); let ref: string | undefined; let type: string | undefined;
  let reading = false; let value = '';
  parse(xml, tag => {
    if (tag.uri !== S) return;
    if (tag.local === 'c') { ref = attribute(tag, 'r'); type = attribute(tag, 't'); value = ''; }
    else if (tag.local === 'v' && ref) reading = true;
  }, tag => {
    if (tag.uri !== S) return;
    if (tag.local === 'v') reading = false;
    else if (tag.local === 'c' && ref) { if (cells.has(ref)) return failed(); cells.set(ref, { type, value }); ref = undefined; }
  }, text => { if (reading) value += text; });
  return cells;
}
const zero = (value: string | undefined) => value !== undefined && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(value);

/** PptxGenJS4.0.1 writes numeric zero as blank in its embedded XLSX. Repair only those known generated cells. */
export async function preservePresentationChartZeros(bytes: Buffer, deck: PresentationDeck): Promise<Buffer> {
  if (!deck.slides.some(slide => slide.objects.some(object => object.type === 'chart' && object.series.some(series => series.values.some(value => value === 0))))) return bytes;
  const zip = await JSZip.loadAsync(bytes); let changed = false;
  for (const [index, slide] of deck.slides.entries()) {
    const charts = slide.objects.filter(object => object.type === 'chart');
    if (!charts.some(chart => chart.series.some(series => series.values.some(value => value === 0)))) continue;
    const part = `ppt/slides/slide${index + 1}.xml`; const ids: string[] = [];
    parse(await member(zip, part), tag => { if (tag.uri === C && tag.local === 'chart') { const id = attribute(tag, 'id', R); if (!id) return failed(); ids.push(id); } });
    if (ids.length !== charts.length) return failed();
    for (const [ordinal, chart] of charts.entries()) {
      if (!chart.series.some(series => series.values.some(value => value === 0))) continue;
      const chartPart = await relationship(zip, part, ids[ordinal], 'chart'); const cached = chartValues(await member(zip, chartPart));
      if (cached.series.length !== chart.series.length) return failed();
      const embeddedPart = await relationship(zip, chartPart, cached.embedded, 'package'); const embedded = zip.file(embeddedPart); if (!embedded) return failed();
      const workbook = await JSZip.loadAsync(await embedded.async('nodebuffer')); const sheetPart = 'xl/worksheets/sheet1.xml';
      let xml = await member(workbook, sheetPart); const cells = sheetValues(xml); const needed = new Set<string>();
      for (const [seriesIndex, series] of chart.series.entries()) for (const [point, value] of series.values.entries()) {
        if (value !== 0) continue;
        if (!zero(cached.series[seriesIndex].get(point))) return failed();
        const ref = `${columnName(seriesIndex + 2)}${point + 2}`; const cell = cells.get(ref);
        if (!cell || (cell.type !== undefined && cell.type !== 'n')) return failed();
        if (zero(cell.value)) continue;
        needed.add(ref);
      }
      if (needed.size) {
        // One pass over the known generated sheet, rather than one whole-sheet scan per zero.
        const repaired = new Set<string>();
        xml = xml.replace(/(<c\b[^>]*\br=(["'])([A-Z]+[1-9]\d*)\2[^>]*>)([\s\S]*?)(<\/c>)/g,
          (whole, open: string, _quote: string, ref: string, body: string, close: string) => {
            if (!needed.has(ref)) return whole;
            if (repaired.has(ref) || !/<v>[\s\S]*?<\/v>/.test(body)) return failed(); repaired.add(ref);
            return open + body.replace(/<v>[\s\S]*?<\/v>/, '<v>0</v>') + close;
          });
        const checked = sheetValues(xml); if (repaired.size !== needed.size || [...needed].some(ref => !zero(checked.get(ref)?.value))) return failed();
        workbook.file(sheetPart, xml); zip.file(embeddedPart, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); changed = true;
      }
    }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : bytes;
}
