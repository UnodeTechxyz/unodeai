import { SaxesParser, type SaxesTagNS } from 'saxes';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlOpening, officeXmlAttribute, mutateOfficeXml } from './OfficeXmlMutations';
import { OFFICE_REL, OFFICE_NS } from './OfficePackage';
import { OfficeEditFailure } from './OfficeEditContracts';
import type { OfficeChartKind, OfficeChartSeries } from './OfficeChartData';
import { columnName } from '../content/WorkbookPage';
import { spreadsheetString, spreadsheetStringXml } from '../content/WorkbookXml';
const C = ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart'];
const kinds: OfficeChartKind[] = ['barChart', 'lineChart', 'pieChart', 'scatterChart'];
const fail = (): never => { throw new OfficeEditFailure('unsupported-edit-target'); };
interface Node { tag: SaxesTagNS; start: number; openEnd: number; end: number; text: string; parent?: Node; children: Node[] }
interface ChartModel { decoded: ReturnType<typeof decodeOfficeXml>; nodes: Node[]; root: Node; group: Node; kind: OfficeChartKind; series: Node[];
  external?: Node; embedded?: { name: string; value: string; uri: string } }
const child = (node: Node, local: string) => node.children.filter(child => C.includes(child.tag.uri) && child.tag.local === local);
const one = (nodes: Node[]) => nodes.length === 1 ? nodes[0] : fail();
const value = (node: Node, local: string) => Object.values(node.tag.attributes).find(attr => !attr.uri && attr.local === local)?.value;
const text = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');

export function patchOfficeChartReference(bytes: Buffer, target: string, relationship: string, progress: () => void): Buffer {
  let order = 0; let selected: SaxesTagNS | undefined; let matched = 0;
  const output = mutateOfficeXml(bytes, (tag, parents) => {
    if (parents.some(parent => parent.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && parent.local === 'AlternateContent')) return;
    if (OFFICE_NS.p.includes(tag.uri) && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(tag.local)) {
      if (`O${++order}` === target.split('-').at(-1)) { if (tag.local !== 'graphicFrame') return fail(); selected = tag; }
    }
    if (!selected || !parents.includes(selected) || !C.includes(tag.uri) || tag.local !== 'chart') return;
    const id = Object.values(tag.attributes).find(attr => OFFICE_REL.includes(attr.uri) && attr.local === 'id'); if (!id) return fail();
    matched++; return { name: id.name, value: relationship };
  }, progress);
  if (matched !== 1) return fail(); return output;
}

function parseOfficeChart(bytes: Buffer, progress: () => void): { decoded: ReturnType<typeof decodeOfficeXml>; nodes: Node[]; root: Node } {
  const decoded = decodeOfficeXml(bytes); const nodes: Node[] = []; const stack: Node[] = []; let start = 0;
  const parser = new SaxesParser({ xmlns: true }); parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => { const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== decoded.encoding && !(encoding === 'utf-16' && decoded.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding'); });
  parser.on('opentagstart', () => { start = decoded.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => { const node: Node = { tag, start, openEnd: parser.position, end: parser.position, text: '', parent: stack.at(-1), children: [] };
    node.parent?.children.push(node); nodes.push(node); stack.push(node); });
  parser.on('text', text => { const node = stack.at(-1); if (node) node.text += text; });
  parser.on('cdata', text => { const node = stack.at(-1); if (node) node.text += text; });
  parser.on('closetag', () => { stack.pop()!.end = parser.position; });
  for (let at = 0; at < decoded.xml.length; at += 65536) { progress(); parser.write(decoded.xml.slice(at, at + 65536)); } parser.close();
  const root = nodes[0]; if (!root || !C.includes(root.tag.uri) || root.tag.local !== 'chartSpace') return fail();
  return { decoded, nodes, root };
}

export function readOfficeChart(bytes: Buffer, progress: () => void): ChartModel {
  const { decoded, nodes, root } = parseOfficeChart(bytes, progress);
  const area = one(child(one(child(root, 'chart')), 'plotArea'));
  const groups = area.children.filter(node => C.includes(node.tag.uri) && node.tag.local.endsWith('Chart'));
  if (groups.length !== 1 || !kinds.includes(groups[0].tag.local as OfficeChartKind)) return fail();
  const group = groups[0]; const external = child(root, 'externalData'); if (external.length > 1) return fail();
  const embedded = external[0] && Object.values(external[0].tag.attributes).find(attr => OFFICE_REL.includes(attr.uri) && attr.local === 'id');
  return { decoded, nodes, root, group, kind: group.tag.local as OfficeChartKind, series: child(group, 'ser'), external: external[0], embedded };
}

/** Replace only series data/index fields in the original chart. All chart axes, geometry and unknown siblings stay lexical. */
export function patchOfficeChart(bytes: Buffer, series: readonly OfficeChartSeries[], stride: number, sheet: string, packageId: string, progress: () => void): Buffer {
  const model = readOfficeChart(bytes, progress); const { decoded, root, group } = model; const namespace = root.tag.uri;
  const scatter = model.kind === 'scatterChart'; const used = new Set<string>();
  for (const ser of model.series) { const idx = value(one(child(ser, 'idx')), 'val'); if (!idx || !/^\d+$/.test(idx) || used.has(String(BigInt(idx)))) return fail(); used.add(String(BigInt(idx))); }
  let next = 0n;
  const points = (values: readonly (string | number | null)[]) => values.map((value, index) => `<c:pt idx="${index}"><c:v>${value === null ? '' : spreadsheetStringXml(String(value))}</c:v></c:pt>`).join('');
  const rendered = series.map((data, index) => {
    const template = model.series[Math.min(index, model.series.length - 1)];
    const sourceFormat = (role: string) => {
      const data = template && child(template, role)[0];
      return data && model.nodes.find(node => node.tag.local === 'formatCode' && C.includes(node.tag.uri) && node.start > data.start && node.end < data.end)?.text;
    };
    const local: Array<{ start: number; end: number; text: string }> = [];
    const formula = (column: number, first: number, last = first) => text(`'${sheet.replaceAll("'", "''")}'!$${columnName(column)}$${first}`
      + (first === last ? '' : `:$${columnName(column)}$${last}`));
    const count = data.values.length; const end = Math.max(2, count + 1); const column = index * stride + 1;
    const numeric = (role: string, values: readonly (number | null)[], col: number, format: string) => `<c:${role} xmlns:c="${namespace}"><c:numRef><c:f>${formula(col, 2, end)}</c:f><c:numCache>`
      + `<c:formatCode>${text(format)}</c:formatCode><c:ptCount val="${values.length}"/>${points(values)}</c:numCache></c:numRef></c:${role}>`;
    const name = `<c:tx xmlns:c="${namespace}"><c:strRef><c:f>${formula(column + 1, 1)}</c:f><c:strCache><c:ptCount val="1"/>${points([data.name])}</c:strCache></c:strRef></c:tx>`;
    const labels = scatter ? numeric('xVal', data.x_values!, column, sourceFormat('xVal') ?? 'General')
      : `<c:cat xmlns:c="${namespace}"><c:strRef><c:f>${formula(column, 2, end)}</c:f><c:strCache><c:ptCount val="${count}"/>${points(data.labels!)}</c:strCache></c:strRef></c:cat>`;
    const oldValues = template && child(template, scatter ? 'yVal' : 'val')[0];
    const values = numeric(scatter ? 'yVal' : 'val', data.values, column + 1, sourceFormat(scatter ? 'yVal' : 'val') ?? 'General');
    let idx: string;
    if (index < model.series.length) idx = value(one(child(template, 'idx')), 'val')!;
    else { while (used.has(String(next))) next++; if (next > 4294967295n) return fail(); idx = String(next++); used.add(idx); }
    if (!template) return `<c:ser xmlns:c="${namespace}"><c:idx val="${idx}"/><c:order val="${index}"/>${name}${labels}${values}</c:ser>`;
    const patch = (node: Node, replacement: string) => local.push({ start: node.start, end: node.end, text: replacement });
    const indexNode = one(child(template, 'idx')); const order = one(child(template, 'order'));
    patch(indexNode, officeXmlOpening(decoded.xml.slice(indexNode.start, indexNode.openEnd), 'val', idx) + decoded.xml.slice(indexNode.openEnd, indexNode.end));
    patch(order, officeXmlOpening(decoded.xml.slice(order.start, order.openEnd), 'val', String(index)) + decoded.xml.slice(order.openEnd, order.end));
    const oldName = child(template, 'tx'); if (oldName.length > 1) return fail();
    if (oldName.length) patch(oldName[0], name); else local.push({ start: order.end, end: order.end, text: name });
    const coordinate = child(template, scatter ? 'xVal' : 'cat'); if (coordinate.length > 1) return fail();
    if (!oldValues) return fail(); patch(oldValues, (coordinate.length ? '' : labels) + values);
    if (coordinate.length) patch(coordinate[0], labels);
    let at = template.start; const chunks: string[] = [];
    for (const part of local.sort((a, b) => a.start - b.start)) { if (part.start < at) return fail(); chunks.push(decoded.xml.slice(at, part.start), part.text); at = part.end; }
    chunks.push(decoded.xml.slice(at, template.end)); return chunks.join('');
  }).join('');
  const patches: Array<{ start: number; end: number; text: string }> = [];
  if (model.series.length) for (const [index, node] of model.series.entries()) patches.push({ start: node.start, end: node.end, text: index === 0 ? rendered : '' });
  else if (group.tag.isSelfClosing) patches.push({ start: group.start, end: group.end,
    text: decoded.xml.slice(group.start, group.openEnd - 2) + '>' + rendered + `</${group.tag.name}>` });
  else {
    // A chart with no series receives data immediately after its leading chart-specific properties.
    const following = group.children.find(node => C.includes(node.tag.uri) && ['dLbls', 'dropLines', 'hiLowLines', 'upDownBars', 'marker', 'smooth', 'gapWidth', 'gapDepth', 'overlap', 'serLines', 'firstSliceAng', 'holeSize', 'axId', 'extLst'].includes(node.tag.local));
    const at = following?.start ?? decoded.xml.lastIndexOf('</', group.end - 1); if (at < group.openEnd) return fail(); patches.push({ start: at, end: at, text: rendered });
  }
  if (model.external && model.embedded) patches.push({ start: model.external.start, end: model.external.openEnd,
    text: officeXmlOpening(decoded.xml.slice(model.external.start, model.external.openEnd), model.embedded.name, packageId) });
  else {
    if (model.external) return fail();
    const after = root.children.find(node => C.includes(node.tag.uri) && ['printSettings', 'userShapes', 'extLst'].includes(node.tag.local));
    const at = after?.start ?? decoded.xml.lastIndexOf('</', root.end - 1); const rel = namespace.includes('purl.oclc.org') ? OFFICE_REL[1] : OFFICE_REL[0];
    patches.push({ start: at, end: at, text: `<c:externalData xmlns:c="${namespace}" xmlns:r="${rel}" r:id="${officeXmlAttribute(packageId)}"><c:autoUpdate val="0"/></c:externalData>` });
  }
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) { if (patch.start < at) return fail(); chunks.push(decoded.xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(decoded.xml.slice(at)); const output = encodeOfficeXml({ ...decoded, xml: chunks.join('') });
  const checked = readOfficeChart(output, progress); if (checked.kind !== model.kind || checked.series.length !== series.length || checked.embedded?.value !== packageId) return fail();
  for (const [index, expected] of series.entries()) {
    const ser = checked.series[index]; const fields: Array<[string, readonly (string | number | null)[]]> = [['tx', [expected.name]],
      [scatter ? 'xVal' : 'cat', scatter ? expected.x_values! : expected.labels!], [scatter ? 'yVal' : 'val', expected.values]];
    for (const [role, values] of fields) {
      const data = one(child(ser, role)); const ref = one(child(data, role === 'cat' || role === 'tx' ? 'strRef' : 'numRef'));
      const column = index * stride + (role === 'tx' || role === 'val' || role === 'yVal' ? 2 : 1); const first = role === 'tx' ? 1 : 2;
      const last = role === 'tx' ? 1 : Math.max(2, values.length + 1);
      const formula = `'${sheet.replaceAll("'", "''")}'!$${columnName(column)}$${first}` + (first === last ? '' : `:$${columnName(column)}$${last}`);
      if (one(child(ref, 'f')).text !== formula) return fail();
      const cache = one(child(ref, role === 'cat' || role === 'tx' ? 'strCache' : 'numCache'));
      if (value(one(child(cache, 'ptCount')), 'val') !== String(values.length)) return fail();
      const points = child(cache, 'pt'); if (points.length !== values.length) return fail();
      for (const [point, node] of points.entries()) if (value(node, 'idx') !== String(point) || spreadsheetString(one(child(node, 'v')).text).text !== (values[point] === null ? '' : String(values[point]))) return fail();
    }
  }
  return output;
}

const DRAWING = ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'];
const drawingChild = (node: Node | undefined, local: string) => node?.children.filter(item => DRAWING.includes(item.tag.uri) && item.tag.local === local) ?? [];
export interface OfficeChartTitleResult { bytes: Buffer; paragraphs: number; lineEndingsNormalized: boolean }

/**
 * Set (string) or delete (null) the chart's own title. Only c:title and c:autoTitleDeleted change: c:title is the first
 * child of c:chart and c:autoTitleDeleted follows it. Existing title body/list/paragraph/run properties are reused;
 * every other byte of the chart part stays lexical and is checked after the edit.
 */
export function setOfficeChartTitle(bytes: Buffer, title: string | null, progress: () => void): OfficeChartTitleResult {
  const { decoded, root } = parseOfficeChart(bytes, progress); const chart = one(child(root, 'chart'));
  const namespace = chart.tag.uri; const drawing = namespace.includes('purl.oclc.org') ? DRAWING[1] : DRAWING[0];
  const titles = child(chart, 'title'); const deletions = child(chart, 'autoTitleDeleted'); if (titles.length > 1 || deletions.length > 1) return fail();
  // Schema order (CT_Chart): title first, then autoTitleDeleted. The read-back below refuses any other order.
  const old = titles[0]; const deleted = deletions[0];
  const lex = (node: Node | undefined) => node ? decoded.xml.slice(node.start, node.end) : '';
  const patches: Array<{ start: number; end: number; text: string }> = [];
  const setDeleted = (flag: '0' | '1', at: number) => patches.push(deleted
    ? { start: deleted.start, end: deleted.end, text: officeXmlOpening(decoded.xml.slice(deleted.start, deleted.openEnd), 'val', flag) + decoded.xml.slice(deleted.openEnd, deleted.end) }
    : { start: at, end: at, text: `<c:autoTitleDeleted xmlns:c="${namespace}" val="${flag}"/>` });
  const normalized = title?.replace(/\r\n?/g, '\n'); const lines = normalized === undefined ? [] : normalized.split('\n');
  if (normalized === undefined) {
    if (old) patches.push({ start: old.start, end: old.end, text: '' });
    // A missing flag goes where the removed title ended, so the two patches never overlap even with no whitespace.
    setDeleted('1', old ? old.end : chart.openEnd);
  } else {
    const oldText = old && child(old, 'tx'); if (oldText && oldText.length > 1) return fail();
    const rich = oldText?.[0] && child(oldText[0], 'rich')[0]; const properties = old && child(old, 'txPr')[0];
    const body = rich ?? properties; const paragraph = drawingChild(body, 'p')[0];
    const run = rich && drawingChild(paragraph, 'r')[0];
    const content = (bodyPr: string) => `<c:tx xmlns:c="${namespace}" xmlns:a="${drawing}"><c:rich>${bodyPr}${lex(drawingChild(body, 'lstStyle')[0]) || '<a:lstStyle/>'}`
      + lines.map(line => `<a:p>${lex(drawingChild(paragraph, 'pPr')[0])}${line ? `<a:r>${lex(drawingChild(run, 'rPr')[0])}<a:t>${text(line)}</a:t></a:r>` : ''}</a:p>`).join('') + '</c:rich></c:tx>';
    const tx = content(lex(drawingChild(body, 'bodyPr')[0]) || '<a:bodyPr/>');
    if (!old) patches.push({ start: chart.openEnd, end: chart.openEnd, text: `<c:title xmlns:c="${namespace}">${tx}<c:overlay val="0"/></c:title>` });
    else if (oldText?.[0]) patches.push({ start: oldText[0].start, end: oldText[0].end, text: tx });
    else if (old.tag.isSelfClosing) patches.push({ start: old.start, end: old.end, text: decoded.xml.slice(old.start, old.openEnd - 2) + '>' + tx + `</${old.tag.name}>` });
    else patches.push({ start: old.openEnd, end: old.openEnd, text: tx });
    setDeleted('0', old ? old.end : chart.openEnd);
  }
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) { if (patch.start < at) return fail(); chunks.push(decoded.xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(decoded.xml.slice(at)); const output = encodeOfficeXml({ ...decoded, xml: chunks.join('') });
  // Read back: the stored title and flag are exactly as requested and nothing outside them changed.
  let checked: ReturnType<typeof parseOfficeChart>;
  try { checked = parseOfficeChart(output, progress); } catch (error) { if (error instanceof OfficeEditFailure) throw error; return fail(); }
  const after = one(child(checked.root, 'chart')); const flag = child(after, 'autoTitleDeleted'); const stored = child(after, 'title');
  if (flag.length !== 1 || after.children[stored.length] !== flag[0] || value(flag[0], 'val') !== (normalized === undefined ? '1' : '0')) return fail();
  if (normalized === undefined ? stored.length : stored.length !== 1 || after.children[0] !== stored[0]) return fail();
  if (normalized !== undefined) {
    const paragraphs = drawingChild(one(child(one(child(stored[0], 'tx')), 'rich')), 'p');
    const read = paragraphs.map(paragraph => checked.nodes.filter(node => DRAWING.includes(node.tag.uri) && node.tag.local === 't' && node.start > paragraph.start && node.end <= paragraph.end)
      .map(node => node.text).join('')).join('\n');
    if (paragraphs.length !== lines.length || read !== normalized) return fail();
  }
  const outside = (xml: string, node: Node) => { let rest = xml.slice(0, node.openEnd); let from = node.openEnd;
    for (const item of node.children) if (C.includes(item.tag.uri) && (item.tag.local === 'title' || item.tag.local === 'autoTitleDeleted')) { rest += xml.slice(from, item.start); from = item.end; }
    return rest + xml.slice(from); };
  if (outside(decoded.xml, chart) !== outside(checked.decoded.xml, after)) return fail();
  return { bytes: output, paragraphs: lines.length, lineEndingsNormalized: normalized !== undefined && normalized !== title };
}
