// Internal fixed-worker element cuts preserve all unselected XML and encoding.
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
export interface OfficeXmlElement { tag: SaxesTagNS; start: number; openEnd: number; end: number; parent?: OfficeXmlElement; children: OfficeXmlElement[] }
export interface OfficeXmlDocument { decoded: ReturnType<typeof decodeOfficeXml>; elements: OfficeXmlElement[] }
export function officeXmlElements(bytes: Buffer, progress: () => void): OfficeXmlDocument {
  const decoded = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const elements: OfficeXmlElement[] = []; const stack: OfficeXmlElement[] = []; let start = 0;
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => {
    const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== decoded.encoding && !(encoding === 'utf-16' && decoded.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding');
  });
  parser.on('opentagstart', () => { start = decoded.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1); const element: OfficeXmlElement = { tag, start, openEnd: parser.position, end: parser.position, parent, children: [] };
    parent?.children.push(element); elements.push(element); stack.push(element);
  });
  parser.on('closetag', () => { stack.pop()!.end = parser.position; });
  for (let at = 0; at < decoded.xml.length; at += 65536) { progress(); parser.write(decoded.xml.slice(at, at + 65536)); } parser.close();
  return { decoded, elements };
}
/** Drop selected typed elements lexically, coalescing a parent and its selected descendants. */
export function removeOfficeElements(parsed: ReturnType<typeof officeXmlElements>, selected: Iterable<OfficeXmlElement>): Buffer {
  const chunks: string[] = []; let at = 0;
  for (const element of [...selected].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (element.start < at) { if (element.end <= at) continue; throw new OfficeEditFailure('unsupported-package-preservation'); }
    chunks.push(parsed.decoded.xml.slice(at, element.start)); at = element.end;
  }
  chunks.push(parsed.decoded.xml.slice(at)); return encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
}
