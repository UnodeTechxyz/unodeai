import { officeXmlElements, removeOfficeElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlOpening } from './OfficeXmlMutations';
import { xmlAttribute } from '../content/WorkbookXml';
import { OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { layoutField, closeRenderLayoutFields } from './OfficeRenderLayoutFields';
import { passiveChartFormulas } from './OfficeRenderChartFormula';

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const namespaces = new Set([
  ...OFFICE_NS.w, ...OFFICE_NS.p, ...OFFICE_NS.a,
  'http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
  'http://schemas.openxmlformats.org/drawingml/2006/picture', 'http://purl.oclc.org/ooxml/drawingml/picture',
  'http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
]);
const blockedWord = new Set(['object', 'control', 'altChunk', 'subDoc', 'attachedTemplate', 'mailMerge', 'dataBinding', 'updateFields', 'instrText', 'delInstrText', 'fldChar', 'fldData', 'saveThroughXslt', 'movie']);
const blockedDrawing = new Set(['hlinkClick', 'hlinkMouseOver', 'audioFile', 'videoFile', 'quickTimeFile', 'wavAudioFile', 'audioCd', 'extLst']);
const blockedPresentation = new Set(['oleObj', 'control', 'timing', 'transition', 'showPr', 'custDataLst', 'extLst']);
// Only layout counters; no links, include, DDE, DOCVARIABLE, expression evaluation or arbitrary switches.

/** Resolve passive compatibility branches and layout fields before removing active/unsupported markup. */
/** `allowed` names extra elements (`uri|local`) kept in one part, e.g. Word comment thread metadata, without admitting their namespace. */
export function filterOfficeRenderXml(bytes: Buffer, ids: Set<string>, progress: () => void, allowed?: ReadonlySet<string>) {
  const parsed = officeXmlElements(bytes, progress); const removed = new Set<OfficeXmlElement>(); const unwrap = new Set<OfficeXmlElement>();
  const safeFields = new Set<OfficeXmlElement>(); let compatibilityFallbacks = 0; let compatibilityResolutions = 0;
  const fields: Array<{ marks: OfficeXmlElement[]; instruction: string; nested: boolean }> = [];
  for (const element of parsed.elements) {
    const tag = element.tag; if (!OFFICE_NS.w.includes(tag.uri)) continue;
    if (tag.local === 'fldSimple' && layoutField(xmlAttribute(tag, 'instr', tag.uri) ?? '')) safeFields.add(element);
    if (tag.local === 'fldChar') {
      const type = xmlAttribute(tag, 'fldCharType', tag.uri);
      if (type === 'begin') { if (fields.length) fields.at(-1)!.nested = true; fields.push({ marks: [element], instruction: '', nested: false }); }
      else if (fields.length) {
        const field = fields.at(-1)!; field.marks.push(element);
        if (type === 'end') { fields.pop(); if (!field.nested && layoutField(field.instruction)) for (const mark of field.marks) safeFields.add(mark); }
      }
    } else if (tag.local === 'instrText' && fields.length) {
      const field = fields.at(-1)!; field.marks.push(element);
      field.instruction += parsed.decoded.xml.slice(element.openEnd, parsed.decoded.xml.lastIndexOf('</', element.end - 1));
    }
  }
  const prefixUri = (element: OfficeXmlElement, prefix: string): string | undefined => {
    for (let cursor: OfficeXmlElement | undefined = element; cursor; cursor = cursor.parent) {
      const attribute = Object.values(cursor.tag.attributes).find(item => item.name === 'xmlns:' + prefix);
      if (attribute) return attribute.value;
    }
    return undefined;
  };
  for (const element of parsed.elements) if (element.tag.uri === MC && element.tag.local === 'AlternateContent') {
    const choices = element.children.filter(child => child.tag.uri === MC && child.tag.local === 'Choice');
    const chosen = choices.find(child => {
      const required = xmlAttribute(child.tag, 'Requires')?.trim().split(/\s+/);
      return required?.length && required.every(prefix => namespaces.has(prefixUri(child, prefix) ?? ''));
    }) ?? element.children.find(child => child.tag.uri === MC && child.tag.local === 'Fallback');
    if (!chosen) { removed.add(element); continue; }
    compatibilityResolutions++; if (chosen.tag.local === 'Fallback') compatibilityFallbacks++;
    unwrap.add(element); unwrap.add(chosen);
    for (const child of element.children) if (child !== chosen) removed.add(child);
  }
  for (const element of parsed.elements) {
    const tag = element.tag; const word = OFFICE_NS.w.includes(tag.uri); const drawing = OFFICE_NS.a.includes(tag.uri); const ppt = OFFICE_NS.p.includes(tag.uri);
    if (unwrap.has(element) || safeFields.has(element)) continue;
    if (word && ['fldSimple', 'hyperlink'].includes(tag.local)) { unwrap.add(element); continue; }
    const missingReference = Object.values(tag.attributes).some(attribute => OFFICE_REL.includes(attribute.uri) && !ids.has(attribute.value));
    if (!namespaces.has(tag.uri) && !allowed?.has(`${tag.uri}|${tag.local}`) || word && blockedWord.has(tag.local) || drawing && blockedDrawing.has(tag.local)
      || ppt && blockedPresentation.has(tag.local) || tag.local === 'externalData' || tag.local === 'extLst' || missingReference) removed.add(element);
  }
  const patches: Array<{ start: number; end: number; text: string }> = [];
  const visibleNamespaces = new Map<OfficeXmlElement, Map<string, string>>();
  const hasRemovedParent = (element: OfficeXmlElement) => { for (let p = element.parent; p; p = p.parent) if (removed.has(p)) return true; return false; };
  let removedElements = 0;
  for (const element of parsed.elements) {
    if (hasRemovedParent(element)) continue;
    const inherited = element.parent ? visibleNamespaces.get(element.parent) ?? new Map<string, string>() : new Map<string, string>();
    if (removed.has(element)) { patches.push({ start: element.start, end: element.end, text: '' }); removedElements++; continue; }
    if (unwrap.has(element)) {
      visibleNamespaces.set(element, inherited);
      patches.push({ start: element.start, end: element.openEnd, text: '' });
      if (!element.tag.isSelfClosing) patches.push({ start: parsed.decoded.xml.lastIndexOf('</', element.end - 1), end: element.end, text: '' });
      if (element.tag.uri !== MC) removedElements++;
      continue;
    }
    // Explicit local declarations keep descendants valid when their namespace-declaring wrapper was unwrapped.
    let opening = parsed.decoded.xml.slice(element.start, element.openEnd);
    const visible = new Map(inherited);
    for (const attribute of Object.values(element.tag.attributes)) if (attribute.uri === XMLNS) visible.set(attribute.name, attribute.value);
    const declarations = new Map<string, string>(); declarations.set(element.tag.prefix ? 'xmlns:' + element.tag.prefix : 'xmlns', element.tag.uri);
    for (const attribute of Object.values(element.tag.attributes)) if (attribute.prefix && attribute.prefix !== 'xml' && attribute.uri !== XMLNS) declarations.set('xmlns:' + attribute.prefix, attribute.uri);
    for (const [name, value] of declarations) if (visible.get(name) !== value) { opening = officeXmlOpening(opening, name, value); visible.set(name, value); }
    visibleNamespaces.set(element, visible);
    patches.push({ start: element.start, end: element.openEnd, text: opening });
  }
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    if (patch.start < at) throw Error('render-copy-xml-overlap'); chunks.push(parsed.decoded.xml.slice(at, patch.start), patch.text); at = patch.end;
  }
  chunks.push(parsed.decoded.xml.slice(at)); let output = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
  const filtered = officeXmlElements(output, progress); const emptyGraphics = new Set<OfficeXmlElement>();
  for (const element of filtered.elements) if (OFFICE_NS.a.includes(element.tag.uri) && element.tag.local === 'graphicData' && !element.children.length) {
    let container = element.parent ?? element;
    for (let parent = element.parent; parent; parent = parent.parent) if (OFFICE_NS.w.includes(parent.tag.uri) && parent.tag.local === 'drawing'
      || OFFICE_NS.p.includes(parent.tag.uri) && parent.tag.local === 'graphicFrame') { container = parent; break; }
    emptyGraphics.add(container);
  }
  if (emptyGraphics.size) { output = removeOfficeElements(filtered, emptyGraphics); removedElements += emptyGraphics.size; officeXmlElements(output, progress); }
  const chart = passiveChartFormulas(output, progress); output = chart.bytes;
  const fieldsClosed = closeRenderLayoutFields(output, progress); output = fieldsClosed.bytes; removedElements += fieldsClosed.removedElements;
  return { bytes: output, removedElements, compatibilityFallbacks, compatibilityResolutions, neutralizedChartFormulas: chart.neutralized };
}
