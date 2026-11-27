import { SaxesParser, type SaxesTagNS } from 'saxes';
import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlOpening } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
interface Frame { tag: SaxesTagNS; start: number; openEnd: number; end: number }
const p = (tag: SaxesTagNS | undefined, local: string) => !!tag && OFFICE_NS.p.includes(tag.uri) && tag.local === local;
const fail = (): never => { throw new OfficeEditFailure('unsupported-package-preservation'); };

/** Insert a new primary entry without rewriting any original entry or its auxiliary references. */
export function duplicatePresentationEntry(bytes: Buffer, sourceOrder: number, sourceRelationship: string, afterOrder: number, relationship: string, progress: () => void, reserved: ReadonlySet<string> = new Set()) {
  const decoded = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const stack: Frame[] = []; const entries: Frame[] = [];
  let list: Frame | undefined; let start = 0;
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => { const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== decoded.encoding && !(encoding === 'utf-16' && decoded.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding'); });
  parser.on('opentagstart', () => { start = decoded.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const frame = { tag, start, openEnd: parser.position, end: parser.position };
    if (stack.length === 1 && p(stack[0].tag, 'presentation') && p(tag, 'sldIdLst')) { if (list) return fail(); list = frame; }
    if (stack.length === 2 && p(stack[0].tag, 'presentation') && p(stack[1].tag, 'sldIdLst') && p(tag, 'sldId')) entries.push(frame);
    stack.push(frame);
  });
  parser.on('closetag', () => { stack.pop()!.end = parser.position; });
  for (let at = 0; at < decoded.xml.length; at += 65536) { progress(); parser.write(decoded.xml.slice(at, at + 65536)); } parser.close();
  if (!Number.isSafeInteger(sourceOrder) || !Number.isSafeInteger(afterOrder) || sourceOrder < 1 || sourceOrder > entries.length || afterOrder < 0 || afterOrder > entries.length || !list || list.tag.isSelfClosing) return fail();
  const source = entries[sourceOrder - 1]; const ids = Object.values(source.tag.attributes).filter(attribute => attribute.local === 'id' && OFFICE_REL.includes(attribute.uri));
  if (!ids.length || ids[0].value !== sourceRelationship) throw new OfficeEditFailure('edit-target-unavailable');
  const used = new Set([...reserved, ...entries.flatMap(entry => {
    const id = Object.values(entry.tag.attributes).find(attribute => !attribute.uri && attribute.local === 'id')?.value;
    return id && /^\d+$/.test(id) ? [String(BigInt(id))] : [];
  })]);
  let id = 256n; while (used.has(String(id))) id++; if (id >= 2147483648n) return fail();
  let opening = officeXmlOpening(decoded.xml.slice(source.start, source.openEnd), 'id', String(id));
  for (const attribute of ids) opening = officeXmlOpening(opening, attribute.name, relationship);
  const entry = opening + decoded.xml.slice(source.openEnd, source.end); const insert = afterOrder ? entries[afterOrder - 1].end : list.openEnd;
  return { bytes: encodeOfficeXml({ ...decoded, xml: decoded.xml.slice(0, insert) + entry + decoded.xml.slice(insert) }),
    id: String(id), order: afterOrder + 1, before: entries.length, after: entries.length + 1 };
}

/** Keep the optional known cached application slide count accurate; other metadata remains lexical. */
export function presentationApplicationCount(bytes: Buffer, count: number, progress: () => void): Buffer {
  const decoded = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const stack: Frame[] = []; let start = 0; const selected: Frame[] = [];
  const namespaces = ['http://schemas.openxmlformats.org/officeDocument/2006/extended-properties', 'http://purl.oclc.org/ooxml/officeDocument/extendedProperties'];
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => { const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== decoded.encoding && !(encoding === 'utf-16' && decoded.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding'); });
  parser.on('opentagstart', () => { start = decoded.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => { const frame = { tag, start, openEnd: parser.position, end: parser.position };
    if (stack.length === 1 && namespaces.includes(tag.uri) && tag.local === 'Slides' && stack[0].tag.uri === tag.uri && stack[0].tag.local === 'Properties') selected.push(frame);
    stack.push(frame);
  });
  parser.on('closetag', () => { stack.pop()!.end = parser.position; });
  for (let at = 0; at < decoded.xml.length; at += 65536) { progress(); parser.write(decoded.xml.slice(at, at + 65536)); } parser.close();
  if (!selected.length) return bytes; if (selected.length > 1) return fail(); const frame = selected[0];
  const replacement = frame.tag.isSelfClosing ? decoded.xml.slice(frame.start, frame.openEnd - 2) + '>' + count + `</${frame.tag.name}>`
    : decoded.xml.slice(frame.start, frame.openEnd) + count + `</${frame.tag.name}>`;
  return encodeOfficeXml({ ...decoded, xml: decoded.xml.slice(0, frame.start) + replacement + decoded.xml.slice(frame.end) });
}
