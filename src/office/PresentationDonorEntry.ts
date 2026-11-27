import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { officeXmlElements } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
import { officeXmlAttribute } from './OfficeXmlMutations';
const order = ['sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz', 'smartTags', 'embeddedFontLst', 'custShowLst', 'photoAlbum', 'custDataLst', 'kinsoku', 'defaultTextStyle', 'modifyVerifier', 'extLst'];
const fail = (): never => { throw new OfficeEditFailure('unsupported-package-preservation'); };
/** Add a primary list child in schema order, retaining every existing entry and unrelated XML lexical. */
export function appendPresentationList(bytes: Buffer, listName: string, entry: string, progress: () => void, after?: number) {
  const parsed = officeXmlElements(bytes, progress); const root = parsed.elements[0];
  if (!root || !OFFICE_NS.p.includes(root.tag.uri) || root.tag.local !== 'presentation') return fail();
  const lists = root.children.filter(element => element.tag.uri === root.tag.uri && element.tag.local === listName); if (lists.length > 1) return fail(); const list = lists[0];
  let start: number; let end: number; let replacement = entry;
  if (list) {
    const children = list.children.filter(element => element.tag.uri === root.tag.uri && element.tag.local !== 'extLst'); const index = after ?? children.length;
    if (!Number.isSafeInteger(index) || index < 0 || index > children.length) return fail();
    if (list.tag.isSelfClosing) { start = list.start; end = list.end; replacement = parsed.decoded.xml.slice(list.start, list.openEnd - 2) + '>' + entry + `</${list.tag.name}>`; }
    else { start = index ? children[index - 1].end : list.openEnd; end = start; }
  } else {
    if (after !== undefined && after !== 0) return fail();
    const position = order.indexOf(listName); if (position < 0) return fail();
    start = root.children.find(element => element.tag.uri === root.tag.uri && order.indexOf(element.tag.local) > position)?.start ?? parsed.decoded.xml.lastIndexOf('</', root.end - 1); end = start;
    replacement = `<oi:${listName} xmlns:oi="${root.tag.uri}">${entry}</oi:${listName}>`;
  }
  return encodeOfficeXml({ ...parsed.decoded, xml: parsed.decoded.xml.slice(0, start) + replacement + parsed.decoded.xml.slice(end) });
}
export function insertPresentationDonorEntry(bytes: Buffer, relationship: string, after: number, reserved: ReadonlySet<string>, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const root = parsed.elements[0]; if (!root || !OFFICE_NS.p.includes(root.tag.uri)) return fail();
  const entries = parsed.elements.filter(element => element.parent?.tag.local === 'sldIdLst' && element.parent.parent === root && element.tag.uri === root.tag.uri && element.tag.local === 'sldId');
  const used = new Set([...reserved, ...entries.flatMap(element => Object.values(element.tag.attributes).filter(attribute => !attribute.uri && attribute.local === 'id').map(attribute => attribute.value))]);
  let id = 256n; while (used.has(String(id))) id++; if (id >= 2147483648n) return fail();
  const rel = root.tag.uri === OFFICE_NS.p[1] ? OFFICE_REL[1] : OFFICE_REL[0];
  const entry = `<oi:sldId xmlns:oi="${root.tag.uri}" xmlns:or="${rel}" id="${id}" or:id="${officeXmlAttribute(relationship)}"/>`;
  return { bytes: appendPresentationList(bytes, 'sldIdLst', entry, progress, after), id: String(id), before: entries.length, after: entries.length + 1, order: after + 1, relationshipBase: rel, presentationNamespace: root.tag.uri };
}
