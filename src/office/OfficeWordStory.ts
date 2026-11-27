import { randomUUID } from 'node:crypto';
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
import type { OfficeRecord } from './OfficeInventory';
export interface OfficeWordStoryCounts { part_ref: string; story: 'header' | 'footer'; paragraphs: number; tables: number; bookmarks: number; controls: number; pictures: number }
/** Prefix only typed reference fields; content such as the literal text D1 must never be rewritten. */
export function prefixWordStoryRecord(item: OfficeRecord, part: string, story: 'header' | 'footer'): OfficeRecord {
  const reference = (value: unknown) => typeof value === 'string' && /^(?:[DBCIR][1-9]\d*|T[1-9]\d*(?:-[RCG][1-9]\d*)*)$/.test(value) ? `${part}-${value}` : value;
  const keys = ['paragraph_ref', 'table_ref', 'cell_ref', 'bookmark_ref', 'control_ref', 'object_ref', 'parent_cell', 'revision_ref', 'nested_in']; const record = { ...item.record };
  for (const key of keys) if (record[key] !== undefined) record[key] = reference(record[key]);
  for (const key of ['paragraph_refs', 'nested_table_refs']) if (Array.isArray(record[key])) record[key] = (record[key] as unknown[]).map(reference);
  if (record.selector && typeof record.selector === 'object') { const selector = { ...record.selector as Record<string, unknown> }; for (const key of keys) if (selector[key] !== undefined) selector[key] = reference(selector[key]); record.selector = selector; }
  if (record.content_scope === 'stored-main-body') record.content_scope = `stored-${story}`;
  return { ...item, id: `${part}-${item.id}`, record: { ...record, part_ref: part, local_ref: item.id, story } };
}
/** Internal header/footer adapter for existing body-only fixed editors. No public XML input. */
export function officeWordStory(bytes: Buffer, story: 'header' | 'footer', progress: () => void) {
  const source = officeXmlElements(bytes, progress); const root = source.elements.find(element => !element.parent); const expected = story === 'header' ? 'hdr' : 'ftr';
  if (!root || !OFFICE_NS.w.includes(root.tag.uri) || root.tag.local !== expected) throw new OfficeEditFailure('unsupported-edit-target');
  const bodyName = root.tag.prefix ? root.tag.prefix + ':body' : 'body'; const originalName = root.tag.name; const xml = source.decoded.xml;
  let prefix = 'unodeStory'; while (source.elements.some(element => element.tag.prefix === prefix || Object.values(element.tag.attributes).some(attribute => attribute.name === 'xmlns:' + prefix))) prefix += 'v';
  const nonce = randomUUID(); const documentName = prefix + ':document';
  const opening = `<${documentName} xmlns:${prefix}="${root.tag.uri}" data-unode-story="${nonce}">`;
  const bodyOpening = xml.slice(root.start, root.openEnd).replace('<' + originalName, '<' + bodyName);
  const body = root.tag.isSelfClosing ? bodyOpening : bodyOpening + xml.slice(root.openEnd, xml.lastIndexOf('</', root.end - 1)) + `</${bodyName}>`;
  const staged = encodeOfficeXml({ ...source.decoded, xml: xml.slice(0, root.start) + opening + body + `</${documentName}>` + xml.slice(root.end) });
  return { bytes: staged, finish(updated: Buffer) {
    const parsed = officeXmlElements(updated, progress); const temporary = parsed.elements.find(element => !element.parent);
    if (!temporary || temporary.tag.name !== documentName || temporary.tag.attributes['data-unode-story']?.value !== nonce || temporary.children.length !== 1) throw new OfficeEditFailure('office-output-check-failed');
    const body = temporary.children[0]; if (!OFFICE_NS.w.includes(body.tag.uri) || body.tag.local !== 'body') throw new OfficeEditFailure('office-output-check-failed');
    const value = parsed.decoded.xml; const restoredOpening = value.slice(body.start, body.openEnd).replace('<' + body.tag.name, '<' + originalName);
    const restored = body.tag.isSelfClosing ? restoredOpening : restoredOpening + value.slice(body.openEnd, value.lastIndexOf('</', body.end - 1)) + `</${originalName}>`;
    const output = encodeOfficeXml({ ...parsed.decoded, xml: value.slice(0, temporary.start) + restored + value.slice(temporary.end) });
    const checked = officeXmlElements(output, progress); const actual = checked.elements.find(element => !element.parent);
    if (actual?.tag.uri !== root.tag.uri || actual.tag.name !== originalName || checked.elements.some(element => element.tag.attributes['data-unode-story']?.value === nonce)) throw new OfficeEditFailure('office-output-check-failed');
    return output;
  } };
}
