import { officeWordRegionSpan } from './OfficeWordRegionSpan';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { OFFICE_NS, type OfficeKind } from './OfficePackage';
import { OfficeTableInventory } from './OfficeTableInventory';

export interface OfficeTextTarget { kind: 'object' | 'paragraph' | 'cell' | 'region'; ref: string; slideRef?: string }
interface XmlEncoding { xml: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; bom: boolean }
interface Frame { name: string; start: number; content: number; end: number; tag?: SaxesTagNS; parent?: Frame; children: number;
  skip: boolean; body: boolean; selected: boolean; text: string; shape?: boolean; paragraph?: boolean; tableEvents?: boolean }
interface Piece { text: string; frame?: Frame }
const ns = (tag: SaxesTagNS | undefined, key: keyof typeof OFFICE_NS) => !!tag && OFFICE_NS[key].includes(tag.uri);
const shapes = ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'];
const fieldOrEquation = (tag: SaxesTagNS) => (ns(tag, 'w') && tag.local === 'fldSimple') || (ns(tag, 'a') && tag.local === 'fld')
  || (tag.local === 'oMath' && ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math'].includes(tag.uri));
export class OfficeTextFailure extends Error {}
const fail = (code: string): never => { throw new OfficeTextFailure(code); };

export function decodeOfficeXml(bytes: Buffer): XmlEncoding {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 'utf-8'
    : bytes.subarray(0, 2).equals(Buffer.from([255, 254])) ? 'utf-16le' : bytes.subarray(0, 2).equals(Buffer.from([254, 255])) ? 'utf-16be' : undefined;
  const encoding = bom ?? (bytes[0] === 0 && bytes[1] === 60 && bytes[2] === 0 && bytes[3] === 63 ? 'utf-16be'
    : bytes[0] === 60 && bytes[1] === 0 && bytes[2] === 63 && bytes[3] === 0 ? 'utf-16le' : 'utf-8');
  return { xml: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding, bom: !!bom };
}
export function encodeOfficeXml(value: XmlEncoding): Buffer {
  let bytes = Buffer.from(value.xml, value.encoding === 'utf-8' ? 'utf8' : 'utf16le'); if (value.encoding === 'utf-16be') bytes = bytes.swap16();
  return value.bom ? Buffer.concat([Buffer.from(value.encoding === 'utf-8' ? [239, 187, 191] : value.encoding === 'utf-16le' ? [255, 254] : [254, 255]), bytes]) : bytes;
}

/** Uses the same namespace/object/paragraph/cell ordinals as the inspected immutable package. */
function textPieces(value: XmlEncoding, kind: OfficeKind, target: OfficeTextTarget, progress: () => void): Piece[] {
  const parser = new SaxesParser({ xmlns: true }); const frames: Frame[] = []; const pieces: Piece[] = [];
  const objects: Array<{ ref: string; paragraphs: number }> = []; const paragraphs: string[] = [];
  let objectCount = 0; let paragraphCount = 0; let cellParagraphs = 0;
  const tables = new OfficeTableInventory(kind, '', '', () => {}, () => objects.at(-1)?.ref);
  const region = kind === 'docx' && target.kind === 'region' ? officeWordRegionSpan(value.xml, target.ref, progress) : undefined;
  let regionParagraphs = region?.initialParagraph ? 1 : 0;
  const selected = () => target.kind === 'region' ? !!region && !!frames.at(-1)?.body && frames.at(-1)!.start >= region.start && frames.at(-1)!.content <= region.end : target.kind === 'object' ? objects.at(-1)?.ref === target.ref
    : target.kind === 'paragraph' ? paragraphs.at(-1) === target.ref : tables.cellRef === target.ref;
  parser.on('doctype', () => fail('unsupported-xml-dtd'));
  parser.on('xmldecl', declaration => {
    const declared = declaration.encoding?.toLowerCase();
    if (declared && declared !== value.encoding && !(declared === 'utf-16' && value.encoding.startsWith('utf-16'))) fail('unsupported-xml-encoding');
  });
  parser.on('opentagstart', tag => {
    const parent = frames.at(-1); if (parent) parent.children++;
    frames.push({ name: tag.name, start: value.xml.lastIndexOf('<', parser.position - 1), content: 0, end: 0, parent,
      children: 0, skip: parent?.skip ?? false, body: parent?.body ?? false, selected: false, text: '' });
  });
  parser.on('opentag', tag => {
    const frame = frames.at(-1)!; frame.tag = tag; frame.content = parser.position;
    frame.skip ||= tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && tag.local === 'AlternateContent';
    if (frame.skip) {
      if (!frame.parent?.skip && frame.parent?.selected && ns(frame.parent.tag, kind === 'docx' ? 'w' : 'a')
        && ['r', 'p'].includes(frame.parent.tag!.local)) pieces.push({ text: '' });
      return;
    }
    if (kind === 'docx' && ns(tag, 'w') && tag.local === 'body') frame.body = true;
    if (kind === 'pptx' && ns(tag, 'p') && shapes.includes(tag.local)) {
      frame.shape = true; objects.push({ ref: `${target.slideRef}-O${++objectCount}`, paragraphs: 0 });
    }
    frame.tableEvents = kind === 'pptx' || frame.body; if (frame.tableEvents) tables.open(tag);
    if (kind === 'docx' && frame.body && ns(tag, 'w') && tag.local === 'p') { frame.paragraph = true; paragraphs.push(`D${++paragraphCount}`); }
    frame.selected = selected(); if (!frame.selected) return;
    if (target.kind === 'object' && ns(tag, 'a') && tag.local === 'p' && objects.at(-1)!.paragraphs++) pieces.push({ text: '\n' });
    if (target.kind === 'cell' && ns(tag, kind === 'docx' ? 'w' : 'a') && tag.local === 'p' && cellParagraphs++) pieces.push({ text: '\n' });
    if (target.kind === 'region' && ns(tag, 'w') && tag.local === 'p' && regionParagraphs++) pieces.push({ text: '\n' });
    if (target.kind === 'region' && ns(tag, 'w') && tag.local === 'sdt') pieces.push({ text: '' });
    const parent = frame.parent?.tag;
    // Zero-width boundaries retain literal offsets while preventing a replacement from moving a field/object.
    if (fieldOrEquation(tag)
      || (ns(parent, kind === 'docx' ? 'w' : 'a') && parent!.local === 'r'
        && !(ns(tag, kind === 'docx' ? 'w' : 'a') && ['rPr', 't', 'tab', 'br', 'cr', 'lastRenderedPageBreak'].includes(tag.local)))) pieces.push({ text: '' });
    if (ns(tag, 'w') && ns(parent, 'w') && parent!.local === 'r') {
      if (tag.local === 'tab') pieces.push({ text: '\t' }); if (tag.local === 'br' || tag.local === 'cr') pieces.push({ text: '\n' });
    }
    if (ns(tag, 'a') && ns(parent, 'a') && parent!.local === 'p' && tag.local === 'br') pieces.push({ text: '\n' });
  });
  const text = (text: string) => { const frame = frames.at(-1); if (frame?.selected && !frame.skip && frame.tag?.local === 't'
    && ns(frame.tag, kind === 'docx' ? 'w' : 'a')) frame.text += text; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', tag => {
    const frame = frames.pop()!; frame.end = parser.position; if (frame.skip) return;
    if (frame.selected && tag.local === 't' && ns(tag, kind === 'docx' ? 'w' : 'a')) {
      if (frame.children) fail('unsupported-text-child'); pieces.push({ text: frame.text, frame });
    }
    if (frame.selected && (fieldOrEquation(tag) || target.kind === 'region' && ns(tag, 'w') && tag.local === 'sdt')) pieces.push({ text: '' });
    if (frame.tableEvents) tables.close(tag);
    if (frame.shape) objects.pop(); if (frame.paragraph) paragraphs.pop();
  });
  for (let at = 0; at < value.xml.length; at += 65536) { progress(); parser.write(value.xml.slice(at, at + 65536)); }
  parser.close(); return pieces;
}
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
/** Fixed internal readback of one current stored Word region; no XML XPath or binding resolution. */
export function readOfficeRegionText(bytes: Buffer, ref: string, progress = () => {}) {
  return textPieces(decodeOfficeXml(bytes), 'docx', { kind: 'region', ref }, progress).map(piece => piece.text).join('');
}

/** Preserve every opening-tag attribute, including quotes containing > or the literal text xml:space. */
function preserveOpening(opening: string): string {
  let at = 1; while (at < opening.length && !/[ \t\r\n/>]/.test(opening[at])) at++;
  while (at < opening.length) {
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at] === '/' || opening[at] === '>') break;
    const start = at; while (at < opening.length && !/[ \t\r\n=]/.test(opening[at])) at++; const name = opening.slice(start, at);
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at++] !== '=') return fail('invalid-text-opening'); while (/[ \t\r\n]/.test(opening[at])) at++;
    const quote = opening[at++]; if (quote !== '"' && quote !== "'") return fail('invalid-text-opening');
    const value = at; while (at < opening.length && opening[at] !== quote) at++;
    if (name === 'xml:space') return opening.slice(0, value) + 'preserve' + opening.slice(at); at++;
  }
  return opening.replace(/[ \t\r\n]*\/?[ \t\r\n]*>$/, ' xml:space="preserve">');
}
function control(frame: Frame, local: 'br' | 'tab'): string {
  const prefix = frame.parent!.tag!.prefix; const name = prefix ? `${prefix}:${local}` : local;
  return `<${name} ${prefix ? `xmlns:${prefix}` : 'xmlns'}="${frame.tag!.uri}"/>`;
}
function changedTextElement(xml: string, frame: Frame, text: string, kind: OfficeKind): string {
  const opening = preserveOpening(xml.slice(frame.start, frame.content)); const element = (text: string) => `${opening}${escape(text)}</${frame.name}>`;
  if (!/[\n\t]/.test(text)) return element(text);
  if (kind === 'docx') {
    if (!ns(frame.parent?.tag, 'w') || frame.parent!.tag!.local !== 'r') return fail('unsupported-text-controls');
    return text.split(/([\n\t])/).map(part => part === '\n' ? control(frame, 'br') : part === '\t' ? control(frame, 'tab') : element(part)).join('');
  }
  if (!text.includes('\n')) return element(text);
  const run = frame.parent;
  if (!ns(run?.tag, 'a') || run!.tag!.local !== 'r' || !ns(run!.parent?.tag, 'a') || run!.parent!.tag!.local !== 'p') return fail('unsupported-field-line-break');
  const prefix = xml.slice(run!.start, frame.start); // Original run attributes and rPr, reapplied only to inserted runs.
  const properties = xml.slice(run!.content, frame.start);
  const primaryNamespace = run!.tag!.prefix ? `xmlns:${run!.tag!.prefix}` : 'xmlns';
  const namespaces = Object.values(run!.tag!.attributes).filter(attribute => attribute.uri === 'http://www.w3.org/2000/xmlns/' && attribute.name !== primaryNamespace)
    .map(attribute => ` ${attribute.name}="${escape(attribute.value).replaceAll('"', '&quot;')}"`).join('');
  const breakName = run!.tag!.prefix ? `${run!.tag!.prefix}:br` : 'br';
  const lineBreak = control(frame, 'br').replace(/\/>$/, () => `${namespaces}>${properties}</${breakName}>`);
  return text.split('\n').map(element).join(`</${run!.name}>${lineBreak}${prefix}`);
}

/** Exact replacement inside one inspected target, with unedited run/property/XML bytes retained. */
export function replaceOfficeText(bytes: Buffer, kind: OfficeKind, target: OfficeTextTarget, find: string, replacement: string, all = true, progress = () => {}) {
  if (!find) return fail('empty-text-match');
  const value = decodeOfficeXml(bytes); const pieces = textPieces(value, kind, target, progress); let at = 0;
  const ranges = pieces.map(piece => { const start = at; at += piece.text.length; return { ...piece, start, end: at, value: piece.text }; });
  const original = pieces.map(piece => piece.text).join(''); const matches: number[] = [];
  for (let offset = 0; ; ) { progress(); const start = original.indexOf(find, offset); if (start < 0) break; matches.push(start); if (!all) break; offset = start + find.length; }
  if (!matches.length) return fail('text-not-found');
  const normalized = replacement.replace(/\r\n?/g, '\n');
  if (find === normalized) return { bytes: Buffer.from(bytes), replacements: matches.length, changedTextNodes: 0, lineEndingsNormalized: normalized !== replacement };
  const changed = new Set<typeof ranges[number]>();
  let right = ranges.length;
  for (const start of [...matches].reverse()) {
    const end = start + find.length; let inserted = false;
    while (right > 0 && ranges[right - 1].start >= end) right--;
    let left = right; while (left > 0 && ranges[left - 1].end > start) left--;
    for (let index = left; index < right; index++) { const range = ranges[index]; if (range.start >= end || range.end <= start) continue;
      if (!range.frame) return fail('text-match-crosses-structural-control');
      const left = Math.max(0, start - range.start); const right = Math.min(range.text.length, end - range.start);
      range.value = range.value.slice(0, left) + (inserted ? '' : normalized) + range.value.slice(right); inserted = true; changed.add(range);
    }
    progress();
  }
  const chunks: string[] = []; let offset = 0;
  for (const range of [...changed].sort((left, right) => left.frame!.start - right.frame!.start)) {
    const frame = range.frame!; chunks.push(value.xml.slice(offset, frame.start), changedTextElement(value.xml, frame, range.value, kind)); offset = frame.end; progress();
  }
  chunks.push(value.xml.slice(offset)); const xml = chunks.join('');
  const expected = all ? original.split(find).join(normalized) : original.replace(find, () => normalized);
  const encoded = encodeOfficeXml({ ...value, xml });
  const actual = textPieces(decodeOfficeXml(encoded), kind, target, progress).map(piece => piece.text).join('');
  if (actual !== expected) return fail('edited-text-check-failed');
  return { bytes: encoded, replacements: matches.length, changedTextNodes: changed.size, lineEndingsNormalized: normalized !== replacement };
}
