import { SaxesParser } from 'saxes';
import { officeXmlElements, removeOfficeElements, type OfficeXmlElement } from './OfficeXmlElements';
import { officeXmlOpening, officeXmlAttribute } from './OfficeXmlMutations';
import { encodeOfficeXml } from './OfficeTextPatch';
const EP = ['http://schemas.openxmlformats.org/officeDocument/2006/extended-properties', 'http://purl.oclc.org/ooxml/officeDocument/extendedProperties'];
const VT = ['http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes', 'http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes'];
/** Cached title lists only; document slide content is never inferred from these metadata strings. */
export function presentationApplicationTitles(bytes: Buffer, orders: Array<number | undefined>, progress: () => void): Buffer {
  const parsed = officeXmlElements(bytes, progress); const root = parsed.elements[0];
  const caches = root.children.filter(node => EP.includes(node.tag.uri) && ['HeadingPairs', 'TitlesOfParts'].includes(node.tag.local));
  if (!caches.length) return bytes;
  const discard = () => removeOfficeElements(parsed, caches);
  const headings = caches.find(node => node.tag.local === 'HeadingPairs')?.children.find(node => VT.includes(node.tag.uri) && node.tag.local === 'vector');
  const titles = caches.find(node => node.tag.local === 'TitlesOfParts')?.children.find(node => VT.includes(node.tag.uri) && node.tag.local === 'vector');
  if (caches.length !== 2 || !headings || !titles || headings.children.length % 2) return discard();
  const text = (node: OfficeXmlElement) => {
    if (node.tag.isSelfClosing) return '';
    let value = ''; const parser = new SaxesParser(); parser.on('text', chunk => { value += chunk; });
    parser.write('<v>' + parsed.decoded.xml.slice(node.openEnd, parsed.decoded.xml.lastIndexOf('</', node.end - 1)) + '</v>').close(); return value;
  };
  let offset = 0; let found: { offset: number; count: number; node: OfficeXmlElement } | undefined;
  for (let at = 0; at < headings.children.length; at += 2) {
    const label = headings.children[at].children[0]; const count = headings.children[at + 1].children[0];
    if (!label || !count || !VT.includes(label.tag.uri) || !['lpstr', 'lpwstr'].includes(label.tag.local) || !VT.includes(count.tag.uri) || count.tag.local !== 'i4') return discard();
    const raw = text(count).trim(); if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return discard();
    const amount = Number(raw);
    if (/^(?:Slide Titles|Slides)$/i.test(text(label))) { if (found) return discard(); found = { offset, count: amount, node: count }; }
    offset += amount;
  }
  if (!found || offset !== titles.children.length || titles.children.some(node => !VT.includes(node.tag.uri) || !['lpstr', 'lpwstr'].includes(node.tag.local))) return discard();
  const originalTitles = titles.children.slice(found.offset, found.offset + found.count);
  const titleXml = orders.map((order, index) => order !== undefined && order >= 1 && order <= originalTitles.length
    ? parsed.decoded.xml.slice(originalTitles[order - 1].start, originalTitles[order - 1].end)
    : `<vt:lpstr xmlns:vt="${VT[0]}">${officeXmlAttribute('Slide ' + (index + 1))}</vt:lpstr>`).join('');
  const retained = (nodes: OfficeXmlElement[]) => nodes.map(node => parsed.decoded.xml.slice(node.start, node.end)).join('');
  const vectorOpening = officeXmlOpening(parsed.decoded.xml.slice(titles.start, titles.openEnd), 'size', String(offset - found.count + orders.length)).replace(/\/>$/, '>');
  const vector = vectorOpening + retained(titles.children.slice(0, found.offset)) + titleXml + retained(titles.children.slice(found.offset + found.count)) + `</${titles.tag.name}>`;
  const countOpening = parsed.decoded.xml.slice(found.node.start, found.node.openEnd).replace(/\/>$/, '>');
  const patches = [{ start: titles.start, end: titles.end, text: vector },
    { start: found.node.start, end: found.node.end, text: countOpening + orders.length + `</${found.node.tag.name}>` }];
  let xml = parsed.decoded.xml; for (const patch of patches.sort((a, b) => b.start - a.start)) xml = xml.slice(0, patch.start) + patch.text + xml.slice(patch.end);
  return encodeOfficeXml({ ...parsed.decoded, xml });
}
