// Fixed literal shape-text assignment with inherited formatting and actual output text readback.
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
import { SaxesParser } from 'saxes';
const is = (element: OfficeXmlElement | undefined, key: 'p' | 'a', local: string) => !!element && OFFICE_NS[key].includes(element.tag.uri) && element.tag.local === local;
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const alternate = (element: OfficeXmlElement): boolean => {
  for (let current: OfficeXmlElement | undefined = element; current; current = current.parent) if (current.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && current.tag.local === 'AlternateContent') return true;
  return false;
};
function selected(elements: OfficeXmlElement[], target: string) {
  const ordinal = /-O([1-9]\d*)$/.exec(target); if (!ordinal) throw new OfficeEditFailure('unsupported-edit-target');
  const shapes = elements.filter(element => OFFICE_NS.p.includes(element.tag.uri) && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(element.tag.local) && !alternate(element));
  const shape = shapes[Number(ordinal[1]) - 1]; if (!is(shape, 'p', 'sp')) throw new OfficeEditFailure('unsupported-edit-target'); return shape;
}
export function readOfficeShapeText(bytes: Buffer, target: string, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const shape = selected(parsed.elements, target); const body = shape.children.find(element => is(element, 'p', 'txBody'));
  const paragraphs = body?.children.filter(element => is(element, 'a', 'p')) ?? []; const starts = new Map(paragraphs.map((paragraph, index) => [paragraph.openEnd, index]));
  const lines = paragraphs.map(() => ''); const parser = new SaxesParser({ xmlns: true }); let paragraph: number | undefined; let inText = false;
  parser.on('opentag', tag => {
    if (starts.has(parser.position)) paragraph = starts.get(parser.position);
    if (paragraph === undefined || !OFFICE_NS.a.includes(tag.uri)) return;
    if (tag.local === 't') inText = true; else if (tag.local === 'br') lines[paragraph] += '\n';
  });
  parser.on('text', text => { if (inText && paragraph !== undefined) lines[paragraph] += text; });
  parser.on('cdata', text => { if (inText && paragraph !== undefined) lines[paragraph] += text; });
  parser.on('closetag', tag => { if (!OFFICE_NS.a.includes(tag.uri)) return; if (tag.local === 't') inText = false; if (tag.local === 'p') paragraph = undefined; });
  for (let at = 0; at < parsed.decoded.xml.length; at += 65536) { progress(); parser.write(parsed.decoded.xml.slice(at, at + 65536)); } parser.close();
  return { text: lines.join('\n'), paragraphs: paragraphs.length };
}
export function setOfficeShapeText(bytes: Buffer, target: string, text: string, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const shape = selected(parsed.elements, target); const bodies = shape.children.filter(element => is(element, 'p', 'txBody'));
  if (bodies.length > 1) throw new OfficeEditFailure('unsupported-edit-target');
  const body = bodies[0]; const paragraphs = body?.children.filter(element => is(element, 'a', 'p')) ?? []; const first = paragraphs[0];
  const xml = parsed.decoded.xml; const fragment = (element?: OfficeXmlElement) => element ? xml.slice(element.start, element.end) : '';
  const firstRun = first?.children.find(element => is(element, 'a', 'r') || is(element, 'a', 'fld')); const style = firstRun?.children.find(element => is(element, 'a', 'rPr')) ?? first?.children.find(element => is(element, 'a', 'endParaRPr'));
  const a = body?.children.find(element => OFFICE_NS.a.includes(element.tag.uri))?.tag.uri ?? (shape.tag.uri === OFFICE_NS.p[1] ? OFFICE_NS.a[1] : OFFICE_NS.a[0]);
  let runStyle = fragment(style);
  if (style) {
    if (style.tag.local === 'endParaRPr') {
      const name = style.tag.prefix ? style.tag.prefix + ':rPr' : 'rPr';
      runStyle = runStyle.replace(/^<[^\s/>]+/, '<' + name);
      const closing = `</${style.tag.name}>`; if (runStyle.endsWith(closing)) runStyle = runStyle.slice(0, -closing.length) + `</${name}>`;
    }
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  const ordinary = !!body && !parsed.elements.some(element => element.start >= body.start && element.end <= body.end
    && (element.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' || is(element, 'a', 'fld')));
  const before = ordinary ? readOfficeShapeText(bytes, target, progress) : undefined;
  if (before?.text === normalized && before.paragraphs) return { bytes, normalized, paragraphs: before.paragraphs, characters: normalized.length, lineEndingsNormalized: normalized !== text };
  const pOpening = first ? xml.slice(first.start, first.openEnd).replace(/\/>$/, '>') : `<oa:p xmlns:oa="${a}">`;
  const namespaces = Object.values(firstRun?.tag.attributes ?? {}).filter(attribute => attribute.uri === 'http://www.w3.org/2000/xmlns/' && attribute.name !== 'xmlns:oa')
    .map(attribute => ` ${attribute.name}="${escaped(attribute.value).replaceAll('"', '&quot;')}"`).join('');
  const plainRun = is(firstRun, 'a', 'r');
  const pName = first?.tag.name ?? 'oa:p'; const rOpening = plainRun ? xml.slice(firstRun!.start, firstRun!.openEnd).replace(/\/>$/, '>') : `<oa:r xmlns:oa="${a}"${namespaces}>`;
  const rName = plainRun ? firstRun!.tag.name : 'oa:r';
  const pPr = fragment(first?.children.find(element => is(element, 'a', 'pPr'))); const end = fragment(first?.children.find(element => is(element, 'a', 'endParaRPr')));
  const replacement = normalized.split('\n').map(line => { progress(); return `${pOpening}${pPr}${rOpening}${runStyle}<oa:t xmlns:oa="${a}" xml:space="preserve">${escaped(line)}</oa:t></${rName}>${end}</${pName}>`; }).join('');
  let result: string;
  if (body && !body.tag.isSelfClosing) {
    const chunks: string[] = []; let at = 0;
    // A whole-text assignment replaces paragraph content, including markup-compatible alternatives,
    // while leaving the current body/list formatting and all content outside this text body lexical.
    const content = body.children.filter(element => !is(element, 'a', 'bodyPr') && !is(element, 'a', 'lstStyle'));
    if (content.length) for (const [index, paragraph] of content.entries()) { chunks.push(xml.slice(at, paragraph.start), index ? '' : replacement); at = paragraph.end; }
    else { const close = xml.lastIndexOf('</', body.end - 1); chunks.push(xml.slice(0, close), replacement); at = close; }
    chunks.push(xml.slice(at)); result = chunks.join('');
  } else {
    const name = body?.tag.name ?? (shape.tag.prefix ? shape.tag.prefix + ':txBody' : 'txBody');
    const opening = body ? xml.slice(body.start, body.openEnd).replace(/\/>$/, '>') : `<${name}>`;
    const content = `${opening}<oa:bodyPr xmlns:oa="${a}"/><oa:lstStyle xmlns:oa="${a}"/>${replacement}</${name}>`;
    const start = body?.start ?? shape.children.find(element => is(element, 'p', 'extLst'))?.start ?? xml.lastIndexOf('</', shape.end - 1);
    result = xml.slice(0, start) + content + xml.slice(body?.end ?? start);
  }
  const output = encodeOfficeXml({ ...parsed.decoded, xml: result });
  if (readOfficeShapeText(output, target, progress).text !== normalized) throw new OfficeEditFailure('edited-text-check-failed');
  return { bytes: output, normalized, paragraphs: normalized.split('\n').length, characters: normalized.length, lineEndingsNormalized: normalized !== text };
}
