import JSZip from 'jszip';
import { DocumentFailure } from '../content/document/DocumentContracts';
import type { PresentationDeck } from './PresentationContracts';
import { columnName } from '../content/WorkbookPage';
import { parse, member, relationship, chartValues, sheetValues } from './PresentationChartZero';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const failed = (): never => { throw new DocumentFailure('worker-exit'); };
const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
type Chart = Extract<PresentationDeck['slides'][number]['objects'][number], { type: 'chart' }>;
const needsRepair = (chart: Chart) => chart.series.some(series => !series.name || series.name.includes('X-Axis') || series.labels.some(label => label === ''));

/** Pinned SDK drops empty categories and rewrites X-Axis names in SST, while sheet references keep the original indices. */
export async function preservePresentationChartStrings(bytes: Buffer, deck: PresentationDeck): Promise<Buffer> {
  if (!deck.slides.some(slide => slide.objects.some(object => object.type === 'chart' && needsRepair(object)))) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  for (const [slideIndex, slide] of deck.slides.entries()) {
    const charts = slide.objects.filter(object => object.type === 'chart'); if (!charts.some(needsRepair)) continue;
    const part = `ppt/slides/slide${slideIndex + 1}.xml`; const ids: string[] = [];
    parse(await member(zip, part), tag => { if (tag.uri === C && tag.local === 'chart') {
      const id = Object.values(tag.attributes).find(attribute => attribute.uri === R && attribute.local === 'id')?.value;
      if (!id) return failed(); ids.push(id);
    } });
    if (ids.length !== charts.length) return failed();
    for (const [ordinal, chart] of charts.entries()) {
      if (!needsRepair(chart)) continue;
      const chartPart = await relationship(zip, part, ids[ordinal], 'chart'); const cache = chartValues(await member(zip, chartPart));
      const embeddedPart = await relationship(zip, chartPart, cache.embedded, 'package');
      const workbook = await JSZip.loadAsync(await zip.file(embeddedPart)!.async('nodebuffer'));
      const cells = sheetValues(await member(workbook, 'xl/worksheets/sheet1.xml'));
      // Only the known generated flat category worksheet is repaired, never an arbitrary input workbook.
      const expected = new Map<string, number>([['A1', 0]]);
      chart.series.forEach((_series, index) => expected.set(`${columnName(index + 2)}1`, index + 1));
      chart.series[0].labels.forEach((_label, index) => expected.set(`A${index + 2}`, chart.series.length + index + 1));
      const strings = ['', ...chart.series.map(series => series.name), ...chart.series[0].labels];
      const actualStrings = [...cells].filter(([, cell]) => cell.type === 's');
      if (actualStrings.length !== expected.size || actualStrings.some(([ref, cell]) => !expected.has(ref) || String(expected.get(ref)) !== cell.value)) return failed();
      const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${S}" count="${strings.length}" uniqueCount="${strings.length}">`
        + strings.map(text => `<si><t xml:space="preserve">${xmlText(text)}</t></si>`).join('') + '</sst>';
      // Reparse before publishing. Numeric values, cell coordinates and all non-SST workbook members stay intact.
      let count = 0; parse(sst, tag => { if (tag.uri === S && tag.local === 'si') count++; }); if (count !== strings.length) return failed();
      workbook.file('xl/sharedStrings.xml', sst); zip.file(embeddedPart, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
