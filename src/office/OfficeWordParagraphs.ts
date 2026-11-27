// Fixed incremental Word paragraphs and original snapshot selector ordering.
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
import { SaxesParser } from 'saxes';
export interface OfficeWordParagraphInsert { op: 'insert_paragraphs'; target_ref: string; paragraphs: string[]; position: 'before' | 'after' }
export function validateWordParagraphInsert(raw: Record<string, unknown>): OfficeWordParagraphInsert {
  if (Object.keys(raw).some(key => !['op', 'target_ref', 'paragraphs', 'position'].includes(key)) || raw.op !== 'insert_paragraphs'
    || typeof raw.target_ref !== 'string' || !/^(?:P[1-9]\d*-)?D[1-9]\d*$/.test(raw.target_ref) || !Array.isArray(raw.paragraphs) || !raw.paragraphs.length
    || raw.paragraphs.some(text => typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text))
    || raw.position !== undefined && raw.position !== 'before' && raw.position !== 'after') throw new OfficeEditFailure('invalid-office-edits');
  return { op: 'insert_paragraphs', target_ref: raw.target_ref, paragraphs: [...raw.paragraphs], position: raw.position === 'before' ? 'before' : 'after' };
}
/** Structural inserts never make an original D# selector address a newly inserted paragraph. */
export class OfficeWordParagraphOrder {
  private readonly ordinals: number[];
  constructor(originalCount: number) { this.ordinals = Array.from({ length: originalCount }, (_, index) => index + 1); }
  current(ref: string) {
    const match = /^D([1-9]\d*)$/.exec(ref); const ordinal = match ? this.ordinals[Number(match[1]) - 1] : undefined;
    if (!ordinal) throw new OfficeEditFailure('edit-target-unavailable'); return ordinal;
  }
  inserted(at: number, count: number) { for (let index = 0; index < this.ordinals.length; index++) if (this.ordinals[index] >= at) this.ordinals[index] += count; }
  /** A removed paragraph's original selector becomes unavailable; later ones move up. Ordinal 0 never matches a paragraph. */
  removed(at: number) {
    for (let index = 0; index < this.ordinals.length; index++) { if (this.ordinals[index] === at) this.ordinals[index] = 0; else if (this.ordinals[index] > at) this.ordinals[index]--; }
  }
}
const w = (element: OfficeXmlElement | undefined, local: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && element.tag.local === local;
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\t', '&#9;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');
function withinBody(element: OfficeXmlElement) {
  let body = false;
  for (let at: OfficeXmlElement | undefined = element; at; at = at.parent) {
    if (at.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && at.tag.local === 'AlternateContent') return false;
    if (w(at, 'body')) body = true;
  }
  return body;
}
function paragraphTexts(parsed: ReturnType<typeof officeXmlElements>, progress: () => void) {
  const paragraphs = parsed.elements.filter(element => w(element, 'p') && withinBody(element)); const starts = new Map(paragraphs.map((element, index) => [element.openEnd, index])); const texts = paragraphs.map(() => '');
  const full = new SaxesParser({ xmlns: true }); const stack: Array<{ index?: number; inText: boolean }> = []; const parents: Array<{ uri: string; local: string }> = [];
  full.on('opentag', tag => {
    const parent = parents.at(-1); parents.push(tag);
    if (!OFFICE_NS.w.includes(tag.uri)) return;
    if (tag.local === 'p') stack.push({ index: starts.get(full.position), inText: false });
    const current = stack.at(-1); if (current?.index === undefined) return;
    const inRun = parent?.local === 'r' && OFFICE_NS.w.includes(parent.uri);
    if (tag.local === 't' && inRun) current.inText = true; else if (tag.local === 'tab' && inRun) texts[current.index] += '\t'; else if ((tag.local === 'br' || tag.local === 'cr') && inRun) texts[current.index] += '\n';
  });
  const text = (value: string) => { const current = stack.at(-1); if (current?.index !== undefined && current.inText) texts[current.index] += value; };
  full.on('text', text); full.on('cdata', text); full.on('closetag', tag => { parents.pop(); if (!OFFICE_NS.w.includes(tag.uri)) return; if (tag.local === 'p') stack.pop(); else if (tag.local === 't' && stack.length) stack.at(-1)!.inText = false; });
  for (let at = 0; at < parsed.decoded.xml.length; at += 65536) { progress(); full.write(parsed.decoded.xml.slice(at, at + 65536)); } full.close(); return texts;
}
export function readOfficeWordParagraphText(bytes: Buffer, ordinal: number, progress: () => void) {
  const texts = paragraphTexts(officeXmlElements(bytes, progress), progress); if (ordinal < 1 || ordinal > texts.length) throw new OfficeEditFailure('unsupported-edit-target'); return texts[ordinal - 1];
}
/** Ordinals agree with immutable document inventory, including nested text-box paragraphs and excluding MC. */
export function insertOfficeWordParagraphs(bytes: Buffer, ordinal: number, texts: string[], position: 'before' | 'after', progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const paragraphs = parsed.elements.filter(element => w(element, 'p') && withinBody(element));
  const anchor = paragraphs[ordinal - 1]; if (!anchor || !texts.length) throw new OfficeEditFailure('unsupported-edit-target');
  const xml = parsed.decoded.xml; const fragment = (element: OfficeXmlElement) => xml.slice(element.start, element.end);
  const declarations = (element: OfficeXmlElement) => Object.values(element.tag.attributes).filter(attribute => attribute.uri === 'http://www.w3.org/2000/xmlns/').map(attribute => ` ${attribute.name}="${escaped(attribute.value)}"`).join('');
  const properties = anchor.children.find(element => w(element, 'pPr')); const firstRun = anchor.children.find(element => w(element, 'r')); const runProperties = firstRun?.children.find(element => w(element, 'rPr'));
  // New content inherits formatting, never the old section break, revision history, bookmark or paragraph/run identities.
  const noRevision = (element: OfficeXmlElement) => !OFFICE_NS.w.includes(element.tag.uri) || !['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(element.tag.local);
  const runFormatting = (element: OfficeXmlElement) => `${xml.slice(element.start, element.openEnd).replace(/\/>$/, '>')}${element.children.filter(noRevision).map(fragment).join('')}</${element.tag.name}>`;
  const pPr = properties ? `${xml.slice(properties.start, properties.openEnd).replace(/\/>$/, '>')}${properties.children.filter(element => !w(element, 'sectPr') && !w(element, 'pPrChange')).map(element => w(element, 'rPr') ? runFormatting(element) : fragment(element)).join('')}</${properties.tag.name}>` : '';
  const rPr = runProperties ? runFormatting(runProperties) : '';
  const uri = anchor.tag.uri; const rName = firstRun?.tag.name ?? 'uw:r'; const rDeclarations = firstRun ? declarations(firstRun) : ` xmlns:uw="${uri}"`;
  const normalized = texts.map(text => text.replace(/\r\n?/g, '\n'));
  const content = normalized.map(text => {
    progress(); const pieces = text.split(/([\n\t])/).map(piece => piece === '\n' ? `<uw:br xmlns:uw="${uri}"/>` : piece === '\t' ? `<uw:tab xmlns:uw="${uri}"/>` : `<uw:t xmlns:uw="${uri}" xml:space="preserve">${escaped(piece)}</uw:t>`).join('');
    return `<${anchor.tag.name}${declarations(anchor)}>${pPr}<${rName}${rDeclarations}>${rPr}${pieces}</${rName}></${anchor.tag.name}>`;
  }).join('');
  const at = position === 'before' ? anchor.start : anchor.end; const output = encodeOfficeXml({ ...parsed.decoded, xml: xml.slice(0, at) + content + xml.slice(at) });
  const checkedDocument = officeXmlElements(output, progress); const checked = checkedDocument.elements.filter(element => w(element, 'p') && withinBody(element));
  if (checked.length !== paragraphs.length + texts.length) throw new OfficeEditFailure('office-output-check-failed');
  const insertionOrdinal = paragraphs.filter(element => element.start < at).length + 1;
  const actualTexts = paragraphTexts(checkedDocument, progress);
  for (let index = 0; index < normalized.length; index++) if (actualTexts[insertionOrdinal + index - 1] !== normalized[index]) throw new OfficeEditFailure('office-output-check-failed');
  return { bytes: output, insertionOrdinal, inserted: texts.length, normalized };
}
