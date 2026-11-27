// Fixed bookmark value adapter; temporary markup stays private and is checked out of the actual output.
import { randomUUID } from 'node:crypto';
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml, readOfficeRegionText } from './OfficeTextPatch';
import { officeWordRegionSpan } from './OfficeWordRegionSpan';
import { setOfficeControlText } from './OfficeControlText';
import { OfficeEditFailure } from './OfficeEditContracts';
export interface OfficeBookmarkTextEdit { op: 'set_bookmark_text'; target_ref: string; text: string }
export function validateBookmarkTextEdit(raw: Record<string, unknown>): OfficeBookmarkTextEdit {
  if (Object.keys(raw).some(key => !['op', 'target_ref', 'text'].includes(key)) || raw.op !== 'set_bookmark_text' || typeof raw.target_ref !== 'string' || !/^(?:P[1-9]\d*-)?B[1-9]\d*$/.test(raw.target_ref)
    || typeof raw.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(raw.text)) throw new OfficeEditFailure('invalid-office-edits');
  return { op: 'set_bookmark_text', target_ref: raw.target_ref, text: raw.text };
}
const w = (element: OfficeXmlElement | undefined, local: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && element.tag.local === local;
function withinBody(element: OfficeXmlElement) { let body = false; for (let current: OfficeXmlElement | undefined = element; current; current = current.parent) { if (current.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && current.tag.local === 'AlternateContent') return false; if (w(current, 'body')) body = true; } return body; }
const fail = (): never => { throw new OfficeEditFailure('unsupported-bookmark-text'); };
/** Wrap only the already-selected sibling span in a private temporary control, reuse the proven value writer, then unwrap it.
 * No temporary tag, property or selector is admitted from the model or survives the final output.
 */
export function setOfficeBookmarkText(bytes: Buffer, edit: OfficeBookmarkTextEdit, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml; const span = officeWordRegionSpan(xml, edit.target_ref, progress);
  const first = parsed.elements.find(element => w(element, 'bookmarkStart') && element.end === span.start); const last = parsed.elements.find(element => w(element, 'bookmarkEnd') && element.start === span.end);
  if (!first || !last || !first.parent || first.parent !== last.parent || ['r', 'tbl', 'tr'].some(local => w(first.parent, local))) return fail();
  let prefix = 'unodeBookmark'; while (parsed.elements.some(element => element.tag.prefix === prefix || Object.values(element.tag.attributes).some(attribute => attribute.name === 'xmlns:' + prefix))) prefix += 'v';
  const nonce = randomUUID(); const opening = `<${prefix}:sdt xmlns:${prefix}="${first.tag.uri}" data-unode-private="${nonce}"><${prefix}:sdtContent>`;
  const closing = `</${prefix}:sdtContent></${prefix}:sdt>`;
  const wrapped = encodeOfficeXml({ ...parsed.decoded, xml: xml.slice(0, span.start) + opening + xml.slice(span.start, span.end) + closing + xml.slice(span.end) });
  const staged = officeXmlElements(wrapped, progress); const stagedControls = staged.elements.filter(element => w(element, 'sdt') && withinBody(element));
  const ordinal = stagedControls.findIndex(element => element.start === span.start && element.tag.attributes['data-unode-private']?.value === nonce) + 1; if (!ordinal) return fail();
  let assigned: ReturnType<typeof setOfficeControlText>;
  try { assigned = setOfficeControlText(wrapped, { op: 'set_control_text', target_ref: 'C' + ordinal, text: edit.text }, progress); }
  catch (error) { if (error instanceof OfficeEditFailure && error.message === 'unsupported-control-text') return fail(); throw error; }
  const edited = officeXmlElements(assigned.bytes, progress); const temporary = edited.elements.find(element => w(element, 'sdt') && element.start === span.start && element.tag.attributes['data-unode-private']?.value === nonce);
  const content = temporary?.children.filter(element => w(element, 'sdtContent')); if (!temporary || content?.length !== 1) return fail();
  const from = content[0].openEnd; const to = edited.decoded.xml.lastIndexOf('</', content[0].end - 1);
  const output = encodeOfficeXml({ ...edited.decoded, xml: edited.decoded.xml.slice(0, temporary.start) + edited.decoded.xml.slice(from, to) + edited.decoded.xml.slice(temporary.end) });
  const checked = officeXmlElements(output, progress);
  if (readOfficeRegionText(output, edit.target_ref, progress) !== assigned.normalized || checked.elements.some(element => element.tag.attributes['data-unode-private']?.value === nonce)
    || checked.elements.filter(element => w(element, 'sdt') && withinBody(element)).length !== parsed.elements.filter(element => w(element, 'sdt') && withinBody(element)).length
    || checked.elements.filter(element => w(element, 'bookmarkStart') && withinBody(element)).length !== parsed.elements.filter(element => w(element, 'bookmarkStart') && withinBody(element)).length
    || checked.elements.filter(element => w(element, 'p') && withinBody(element)).length !== parsed.elements.filter(element => w(element, 'p') && withinBody(element)).length + assigned.paragraphsAdded) throw new OfficeEditFailure('office-output-check-failed');
  return { bytes: output, normalized: assigned.normalized, characters: assigned.characters, paragraphsAdded: assigned.paragraphsAdded,
    paragraphInsertionOrdinal: assigned.paragraphInsertionOrdinal, lineEndingsNormalized: assigned.lineEndingsNormalized };
}
