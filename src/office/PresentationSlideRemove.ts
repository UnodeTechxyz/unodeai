// Fixed primary-page removal and known auxiliary-reference cleanup.
import { officeXmlElements, removeOfficeElements, type OfficeXmlElement } from './OfficeXmlElements';
import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { OfficeEditFailure } from './OfficeEditContracts';
const p = (element: OfficeXmlElement | undefined, local: string) => !!element && OFFICE_NS.p.includes(element.tag.uri) && element.tag.local === local;
const attribute = (element: OfficeXmlElement, local: string, uris: string[] = ['']) => Object.values(element.tag.attributes).find(a => a.local === local && uris.includes(a.uri))?.value;
const sectionNamespace = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const section = (element: OfficeXmlElement | undefined, local: string) => !!element && element.tag.uri === sectionNamespace && element.tag.local === local;
export function removePresentationEntry(bytes: Buffer, order: number, relationship: string, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const entries = parsed.elements.filter(element => p(element, 'sldId') && p(element.parent, 'sldIdLst') && p(element.parent?.parent, 'presentation'));
  const source = entries[order - 1];
  if (!Number.isSafeInteger(order) || !source || attribute(source, 'id', OFFICE_REL) !== relationship) throw new OfficeEditFailure('edit-target-unavailable');
  const numericId = attribute(source, 'id'); const remaining = entries.filter(entry => entry !== source);
  const retireRelationship = !remaining.some(entry => attribute(entry, 'id', OFFICE_REL) === relationship);
  const retireNumericId = numericId !== undefined && !remaining.some(entry => attribute(entry, 'id') === numericId);
  const cuts = new Set<OfficeXmlElement>([entries.length === 1 ? source.parent! : source]); let auxiliary = 0;
  for (const element of parsed.elements) {
    if (retireRelationship && p(element, 'sld') && p(element.parent, 'sldLst') && p(element.parent?.parent, 'custShow') && attribute(element, 'id', OFFICE_REL) === relationship) { cuts.add(element); auxiliary++; }
    if (retireNumericId && section(element, 'sldId') && section(element.parent, 'sldIdLst') && section(element.parent?.parent, 'section') && attribute(element, 'id') === numericId) { cuts.add(element); auxiliary++; }
  }
  // Remove empty known shows/sections and their lists; preserve unrelated extension content.
  for (const element of [...parsed.elements].reverse()) {
    const knownList = p(element, 'sldLst') && p(element.parent, 'custShow') || p(element, 'custShowLst')
      || section(element, 'sldIdLst') && section(element.parent, 'section') || section(element, 'sectionLst');
    const knownOwner = p(element, 'custShow') || section(element, 'section');
    if (knownList && element.children.length && element.children.every(child => cuts.has(child))) cuts.add(element);
    if (knownOwner && element.children.some(child => cuts.has(child) && (p(child, 'sldLst') || section(child, 'sldIdLst')))) cuts.add(element);
    if ((p(element, 'ext') || p(element, 'extLst')) && element.children.length && element.children.every(child => cuts.has(child))) cuts.add(element);
  }
  return { bytes: removeOfficeElements(parsed, cuts), id: numericId, before: entries.length, after: entries.length - 1, order, retireRelationship, auxiliary };
}
