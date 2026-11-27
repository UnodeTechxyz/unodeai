import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml, readOfficeRegionText } from './OfficeTextPatch';
import { officeXmlOpening } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
export interface OfficeControlTextEdit { op: 'set_control_text'; target_ref: string; text: string }
export function validateControlTextEdit(raw: Record<string, unknown>): OfficeControlTextEdit {
  if (Object.keys(raw).some(key => !['op', 'target_ref', 'text'].includes(key)) || raw.op !== 'set_control_text' || typeof raw.target_ref !== 'string' || !/^(?:P[1-9]\d*-)?C[1-9]\d*$/.test(raw.target_ref)
    || typeof raw.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(raw.text)) throw new OfficeEditFailure('invalid-office-edits');
  return { op: 'set_control_text', target_ref: raw.target_ref, text: raw.text };
}
const w = (element: OfficeXmlElement | undefined, local: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && element.tag.local === local;
function withinBody(element: OfficeXmlElement) { let body = false; for (let current: OfficeXmlElement | undefined = element; current; current = current.parent) { if (current.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && current.tag.local === 'AlternateContent') return false; if (w(current, 'body')) body = true; } return body; }
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fail = (): never => { throw new OfficeEditFailure('unsupported-control-text'); };
/** Whole stored text assignment for one ordinary text/rich-text control, retaining its structure and metadata. */
export function setOfficeControlText(bytes: Buffer, edit: OfficeControlTextEdit, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml;
  const controls = parsed.elements.filter(element => w(element, 'sdt') && withinBody(element)); const control = controls[Number(edit.target_ref.slice(1)) - 1]; if (!control) return fail();
  const properties = control.children.find(element => w(element, 'sdtPr')); const contents = control.children.filter(element => w(element, 'sdtContent')); if (contents.length > 1) return fail(); const content = contents[0];
  if (properties?.children.some(element => OFFICE_NS.w.includes(element.tag.uri) && ['date', 'comboBox', 'dropDownList', 'picture', 'docPartObj', 'docPartList', 'group', 'citation', 'bibliography', 'equation'].includes(element.tag.local)
    || element.tag.uri === 'http://schemas.microsoft.com/office/word/2010/wordml' && element.tag.local === 'checkbox'
    || element.tag.uri === 'http://schemas.microsoft.com/office/word/2012/wordml' && ['repeatingSection', 'repeatingSectionItem'].includes(element.tag.local))) return fail();
  const descendants = content ? parsed.elements.filter(element => element.start >= content.openEnd && element.end <= content.end && element !== content) : [];
  const paragraphs = descendants.filter(element => w(element, 'p')); if (paragraphs.length > 1 || paragraphs.some(element => element.parent !== content)
    || descendants.some(element => ['sdt', 'tbl', 'fldSimple', 'fldChar', 'instrText', 'del', 'moveFrom'].some(local => w(element, local)))) return fail();
  const paragraph = paragraphs[0]; const normalized = edit.text.replace(/\r\n?/g, '\n'); const uri = control.tag.uri;
  let prefix = 'unodeValue'; while (parsed.elements.some(element => element.tag.prefix === prefix || Object.values(element.tag.attributes).some(attribute => attribute.name === 'xmlns:' + prefix))) prefix += 'v';
  const namespace = `xmlns:${prefix}="${uri}"`;
  const textElement = (value: string, original?: OfficeXmlElement) => original
    ? `${officeXmlOpening(xml.slice(original.start, original.openEnd), 'xml:space', 'preserve').replace(/\/>$/, '>')}${escape(value)}</${original.tag.name}>`
    : `<${prefix}:t ${namespace} xml:space="preserve">${escape(value)}</${prefix}:t>`;
  const textRun = (original?: OfficeXmlElement) => normalized.split(/([\n\t])/).map(piece => piece === '\n' ? `<${prefix}:br ${namespace}/>` : piece === '\t' ? `<${prefix}:tab ${namespace}/>` : textElement(piece, original)).join('');
  const texts = descendants.filter(element => w(element, 't') && w(element.parent, 'r')); if (texts.some(element => element.children.length)) return fail();
  const dataControls = descendants.filter(element => w(element.parent, 'r') && ['tab', 'br', 'cr', 'lastRenderedPageBreak', 'noBreakHyphen', 'softHyphen'].some(local => w(element, local)));
  const placeholder = properties?.children.filter(element => w(element, 'showingPlcHdr')) ?? [];
  const sameText = !!content && readOfficeRegionText(bytes, edit.target_ref, progress) === normalized;
  if (sameText && !placeholder.length) return { bytes, normalized, characters: normalized.length, paragraphsAdded: 0,
    paragraphInsertionOrdinal: 1, placeholderFlagRemoved: false, bindingPresent: !!properties?.children.some(element => w(element, 'dataBinding')), lineEndingsNormalized: normalized !== edit.text };
  const patches: Array<{ start: number; end: number; text: string }> = placeholder.map(element => ({ start: element.start, end: element.end, text: '' }));
  let added = 0; const insertionAt = content?.openEnd ?? control.openEnd;
  if (sameText) { /* The explicit assignment still clears a placeholder flag, without flattening matching rich text. */ }
  else if (texts.length) {
    for (const [index, element] of texts.entries()) patches.push({ start: element.start, end: element.end, text: index ? xml.slice(element.start, element.openEnd).replace(/\/>$/, '>') + `</${element.tag.name}>` : textRun(element) });
    for (const element of dataControls) patches.push({ start: element.start, end: element.end, text: '' });
  } else {
    for (const element of dataControls) patches.push({ start: element.start, end: element.end, text: '' });
    const run = descendants.find(element => w(element, 'r'));
    const defaultFormat = properties?.children.find(element => w(element, 'rPr')) ?? control.children.find(element => w(element, 'sdtEndPr'))?.children.find(element => w(element, 'rPr'));
    const declarations = Object.values(defaultFormat?.parent?.tag.attributes ?? {}).filter(attribute => attribute.uri === 'http://www.w3.org/2000/xmlns/')
      .map(attribute => ` ${attribute.name}="${escape(attribute.value).replaceAll('"', '&quot;')}"`).join('');
    const format = defaultFormat ? `${xml.slice(defaultFormat.start, defaultFormat.openEnd).replace(/\/>$/, '>')}${defaultFormat.children.filter(element => !OFFICE_NS.w.includes(element.tag.uri) || !['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(element.tag.local)).map(element => xml.slice(element.start, element.end)).join('')}</${defaultFormat.tag.name}>` : '';
    const newRun = `<${prefix}:r ${namespace}${declarations}>${format}${textRun()}</${prefix}:r>`;
    if (run) {
      if (run.tag.isSelfClosing) patches.push({ start: run.start, end: run.end, text: xml.slice(run.start, run.openEnd).replace(/\/>$/, '>') + textRun() + `</${run.tag.name}>` });
      else { const at = run.children.find(element => w(element, 'rPr'))?.end ?? run.openEnd; patches.push({ start: at, end: at, text: textRun() }); }
    } else if (content && !content.tag.isSelfClosing && paragraph) {
      let at = paragraph.children.find(element => w(element, 'pPr'))?.end ?? paragraph.openEnd;
      for (const child of paragraph.children) { if (child.end <= at) continue; if (['bookmarkStart', 'commentRangeStart', 'permStart', 'proofErr'].some(local => w(child, local))) at = child.end; else break; }
      if (paragraph.tag.isSelfClosing) patches.push({ start: paragraph.start, end: paragraph.end, text: xml.slice(paragraph.start, paragraph.openEnd).replace(/\/>$/, '>') + newRun + `</${paragraph.tag.name}>` });
      else patches.push({ start: at, end: at, text: newRun });
    } else {
      const inline = (() => { for (let at = control.parent; at; at = at.parent) if (w(at, 'p')) return true; return false; })();
      if (content && !content.tag.isSelfClosing && content.children.length && !inline) return fail();
      const value = inline ? newRun : `<${prefix}:p ${namespace}>${newRun}</${prefix}:p>`; added = Number(!inline);
      if (content && !content.tag.isSelfClosing) patches.push({ start: content.openEnd, end: content.openEnd, text: value });
      else if (content) patches.push({ start: content.start, end: content.end, text: xml.slice(content.start, content.openEnd).replace(/\/>$/, '>') + value + `</${content.tag.name}>` });
      else {
        const valueContent = `<${prefix}:sdtContent ${namespace}>${value}</${prefix}:sdtContent>`;
        if (control.tag.isSelfClosing) patches.push({ start: control.start, end: control.end, text: xml.slice(control.start, control.openEnd).replace(/\/>$/, '>') + valueContent + `</${control.tag.name}>` });
        else { const at = xml.lastIndexOf('</', control.end - 1); patches.push({ start: at, end: at, text: valueContent }); }
      }
    }
  }
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start || a.end - b.end)) { if (patch.start < at) return fail(); chunks.push(xml.slice(at, patch.start), patch.text); at = patch.end; }
  chunks.push(xml.slice(at)); const output = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
  const checked = officeXmlElements(output, progress); const current = checked.elements.filter(element => w(element, 'sdt') && withinBody(element))[Number(edit.target_ref.slice(1)) - 1];
  if (current.children.find(element => w(element, 'sdtPr'))?.children.some(element => w(element, 'showingPlcHdr'))) throw new OfficeEditFailure('office-output-check-failed');
  if (readOfficeRegionText(output, edit.target_ref, progress) !== normalized || checked.elements.filter(element => w(element, 'sdt') && withinBody(element)).length !== controls.length
    || checked.elements.filter(element => w(element, 'p') && withinBody(element)).length !== parsed.elements.filter(element => w(element, 'p') && withinBody(element)).length + added) throw new OfficeEditFailure('office-output-check-failed');
  return { bytes: output, normalized, characters: normalized.length, paragraphsAdded: added,
    paragraphInsertionOrdinal: parsed.elements.filter(element => w(element, 'p') && withinBody(element) && element.start < insertionAt).length + 1,
    placeholderFlagRemoved: placeholder.length > 0, bindingPresent: !!properties?.children.some(element => w(element, 'dataBinding')), lineEndingsNormalized: normalized !== edit.text };
}
