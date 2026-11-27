import JSZip from 'jszip';
import { columnName } from '../content/WorkbookPage';
import { member, parse, relationship, chartValues } from './PresentationChartZero';
import { officeXmlElements, removeOfficeElements, type OfficeXmlElement } from './OfficeXmlElements';
import { officeXmlAttribute, officeXmlOpening } from './OfficeXmlMutations';
import { encodeOfficeXml } from './OfficeTextPatch';
import type { PresentationChartExpectation } from './PresentationChartBinding';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function seriesCache(node: OfficeXmlElement | undefined): OfficeXmlElement | undefined {
  return node?.children.find(child => child.tag.uri === C && child.tag.local === 'val')?.children
    .find(child => child.tag.uri === C && child.tag.local === 'numRef')?.children
    .find(child => child.tag.uri === C && child.tag.local === 'numCache');
}
function seriesFormat(points: PresentationChartExpectation['values']['points']): string {
  const codes = new Set(points.filter(point => point.value !== null).map(point => point.format_code || 'General'));
  // A numeric cache has one format for its series. Mixed formats retain their explicit per-point labels.
  return codes.size === 1 ? [...codes][0] : 'General';
}
function insertChildren(bytes: Buffer, namespace: string, local: string, xml: string): Buffer {
  const parsed = officeXmlElements(bytes, () => {}); const target = parsed.elements.find(element => element.tag.uri === namespace && element.tag.local === local);
  if (!target) throw Error('generated-chart-style-unavailable');
  const children = target.children.length; const added = (xml.match(/<(?:xf|numFmt)\b/g) ?? []).length;
  const opening = officeXmlOpening(parsed.decoded.xml.slice(target.start, target.openEnd), 'count', String(children + added));
  const body = target.tag.isSelfClosing ? opening.replace(/\/>$/, '>') + xml + `</${target.tag.name}>`
    : opening + parsed.decoded.xml.slice(target.openEnd, parsed.decoded.xml.lastIndexOf('</', target.end - 1)) + xml + `</${target.tag.name}>`;
  return encodeOfficeXml({ ...parsed.decoded, xml: parsed.decoded.xml.slice(0, target.start) + body + parsed.decoded.xml.slice(target.end) });
}

/** Generated packages only: retain numeric values, apply stored display codes to native labels and editable data cells. */
export async function preservePresentationChartDisplay(bytes: Buffer, expected: readonly PresentationChartExpectation[]): Promise<Buffer> {
  if (!expected.some(item => item.values.points.some(point => point.format_code && point.value !== null))) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  for (const item of expected) {
    const formatted = item.values.points.filter(point => point.format_code && point.value !== null); if (!formatted.length) continue;
    const slide = `ppt/slides/slide${item.fact.slide}.xml`; const ids: string[] = [];
    parse(await member(zip, slide), tag => { if (tag.uri === C && tag.local === 'chart') {
      const id = Object.values(tag.attributes).find(attribute => attribute.uri === R && attribute.local === 'id')?.value; if (id) ids.push(id);
    } });
    const chartPart = await relationship(zip, slide, ids[item.fact.chart - 1], 'chart');
    let chartBytes: Buffer = Buffer.from(await member(zip, chartPart));
    // PptxGenJS source has no model-controlled label options. Typed per-point formats support mixed units without changing raw values.
    let parsed = officeXmlElements(chartBytes, () => {});
    chartBytes = removeOfficeElements(parsed, parsed.elements.filter(element => element.tag.uri === C && element.tag.local === 'dLbls'
      && element.parent?.tag.uri === C && element.parent.tag.local === 'ser'));
    parsed = officeXmlElements(chartBytes, () => {});
    const series = parsed.elements.filter(element => element.tag.uri === C && element.tag.local === 'ser');
    const patches: Array<{ start: number; end: number; xml: string }> = [];
    for (const [index, field] of item.fact.selection.value_fields.entries()) {
      const points = item.values.points.filter(point => point.series_index === undefined ? point.field === field : point.series_index === index);
      const labels = points.flatMap((point, at) => point.format_code && point.value !== null
        ? [`<c:dLbl><c:idx val="${at}"/><c:numFmt formatCode="${officeXmlAttribute(point.format_code)}" sourceLinked="0"/><c:showVal val="1"/></c:dLbl>`] : []);
      if (!labels.length) continue;
      const node = series[index]; if (!node) throw Error('generated-chart-series-unavailable');
      // PowerPoint's first paint uses the cache format, before opening Edit Data refreshes workbook styles.
      const cache = seriesCache(node); if (!cache) throw Error('generated-chart-cache-unavailable');
      const format = cache.children.find(child => child.tag.uri === C && child.tag.local === 'formatCode');
      patches.push({ start: format?.start ?? cache.openEnd, end: format?.end ?? cache.openEnd,
        xml: `<c:formatCode>${officeXmlAttribute(seriesFormat(points))}</c:formatCode>` });
      const before = node.children.find(child => child.tag.uri === C && ['trendline', 'errBars', 'cat', 'val', 'xVal', 'yVal', 'bubbleSize', 'shape', 'smooth', 'extLst'].includes(child.tag.local));
      const at = before?.start ?? parsed.decoded.xml.lastIndexOf('</', node.end - 1);
      patches.push({ start: at, end: at,
        xml: `<c:dLbls xmlns:c="${C}">${labels.join('')}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>` });
    }
    let chartXml = parsed.decoded.xml;
    for (const patch of patches.sort((a, b) => b.start - a.start)) chartXml = chartXml.slice(0, patch.start) + patch.xml + chartXml.slice(patch.end);
    const embeddedPart = await relationship(zip, chartPart, chartValues(chartXml).embedded, 'package');
    const workbook = await JSZip.loadAsync(await zip.file(embeddedPart)!.async('nodebuffer'));
    let styles: Buffer = Buffer.from(await member(workbook, 'xl/styles.xml'));
    let styleTree = officeXmlElements(styles, () => {}); const root = styleTree.elements[0];
    if (!styleTree.elements.some(element => element.tag.uri === S && element.tag.local === 'numFmts')) {
      styles = encodeOfficeXml({ ...styleTree.decoded, xml: styleTree.decoded.xml.slice(0, root.openEnd)
        + `<numFmts xmlns="${S}" count="0"/>` + styleTree.decoded.xml.slice(root.openEnd) });
    }
    styleTree = officeXmlElements(styles, () => {});
    if (!styleTree.elements.some(element => element.tag.uri === S && element.tag.local === 'cellXfs')) {
      const styleRoot = styleTree.elements[0];
      const next = styleRoot.children.find(element => ['cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst'].includes(element.tag.local));
      const at = next?.start ?? styleTree.decoded.xml.lastIndexOf('</', styleRoot.end - 1);
      styles = encodeOfficeXml({ ...styleTree.decoded, xml: styleTree.decoded.xml.slice(0, at)
        + `<cellXfs xmlns="${S}" count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>` + styleTree.decoded.xml.slice(at) });
      styleTree = officeXmlElements(styles, () => {});
    }
    const codes = [...new Set(formatted.map(point => point.format_code!))];
    const used = styleTree.elements.filter(element => element.tag.uri === S && element.tag.local === 'numFmt').map(element => Number(element.tag.attributes.numFmtId?.value));
    const firstFormat = Math.max(164, ...used.map(id => id + 1));
    const firstStyle = styleTree.elements.filter(element => element.tag.uri === S && element.tag.local === 'xf' && element.parent?.tag.local === 'cellXfs').length;
    styles = insertChildren(styles, S, 'numFmts', codes.map((code, index) => `<numFmt xmlns="${S}" numFmtId="${firstFormat + index}" formatCode="${officeXmlAttribute(code)}"/>`).join(''));
    styles = insertChildren(styles, S, 'cellXfs', codes.map((_, index) => `<xf xmlns="${S}" numFmtId="${firstFormat + index}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`).join(''));
    const cells = new Map<string, number>();
    for (const [seriesIndex, field] of item.fact.selection.value_fields.entries()) {
      const points = item.values.points.filter(point => point.series_index === undefined ? point.field === field : point.series_index === seriesIndex);
      points.forEach((point, at) => { if (point.format_code && point.value !== null) cells.set(`${columnName(seriesIndex + 2)}${at + 2}`, firstStyle + codes.indexOf(point.format_code)); });
    }
    const sheet = officeXmlElements(Buffer.from(await member(workbook, 'xl/worksheets/sheet1.xml')), () => {}); let sheetXml = sheet.decoded.xml;
    for (const cell of sheet.elements.filter(element => element.tag.uri === S && element.tag.local === 'c' && cells.has(element.tag.attributes.r?.value)).reverse()) {
      const opening = officeXmlOpening(sheet.decoded.xml.slice(cell.start, cell.openEnd), 's', String(cells.get(cell.tag.attributes.r.value)));
      sheetXml = sheetXml.slice(0, cell.start) + opening + sheetXml.slice(cell.openEnd);
    }
    workbook.file('xl/styles.xml', styles); workbook.file('xl/worksheets/sheet1.xml', encodeOfficeXml({ ...sheet.decoded, xml: sheetXml }));
    zip.file(embeddedPart, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); zip.file(chartPart, chartXml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Independent readback of actual native label formats and styles referenced by generated numeric cells. */
export async function presentationChartDisplayDifferences(chart: string, workbook: JSZip, item: PresentationChartExpectation): Promise<number> {
  if (!item.values.points.some(point => point.format_code && point.value !== null)) return 0;
  const chartNodes = officeXmlElements(Buffer.from(chart), () => {}).elements;
  const series = chartNodes.filter(node => node.tag.uri === C && node.tag.local === 'ser');
  const styleNodes = officeXmlElements(Buffer.from(await member(workbook, 'xl/styles.xml')), () => {}).elements;
  const formats = new Map(styleNodes.filter(node => node.tag.uri === S && node.tag.local === 'numFmt').map(node => [node.tag.attributes.numFmtId.value, node.tag.attributes.formatCode.value]));
  const styles = styleNodes.filter(node => node.tag.uri === S && node.tag.local === 'xf' && node.parent?.tag.local === 'cellXfs');
  const cells = officeXmlElements(Buffer.from(await member(workbook, 'xl/worksheets/sheet1.xml')), () => {}).elements.filter(node => node.tag.uri === S && node.tag.local === 'c');
  let differences = 0;
  for (const [index, field] of item.fact.selection.value_fields.entries()) {
    const points = item.values.points.filter(point => point.series_index === undefined ? point.field === field : point.series_index === index);
    const labels = series[index]?.children.find(node => node.tag.uri === C && node.tag.local === 'dLbls')?.children ?? [];
    if (points.some(point => point.format_code && point.value !== null)) {
      const format = seriesCache(series[index])?.children.find(node => node.tag.uri === C && node.tag.local === 'formatCode');
      if (!format || chart.slice(format.openEnd, chart.lastIndexOf('</', format.end - 1)) !== officeXmlAttribute(seriesFormat(points))) differences++;
    }
    points.forEach((point, at) => {
      if (!point.format_code || point.value === null) return;
      const label = labels.find(node => node.tag.local === 'dLbl' && node.children.some(child => child.tag.local === 'idx' && child.tag.attributes.val?.value === String(at)));
      if (label?.children.find(child => child.tag.local === 'numFmt')?.tag.attributes.formatCode?.value !== point.format_code) differences++;
      const ref = `${columnName(index + 2)}${at + 2}`; const cell = cells.find(node => node.tag.attributes.r?.value === ref);
      const style = cell?.tag.attributes.s?.value;
      if (style === undefined || formats.get(styles[Number(style)]?.tag.attributes.numFmtId?.value ?? '') !== point.format_code) differences++;
    });
  }
  return differences;
}
