import { SaxesParser, type SaxesTagNS } from 'saxes';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';

export type XlsxXmlText = ReturnType<typeof decodeOfficeXml>;
export interface XlsxXmlNode { tag: SaxesTagNS; parents: readonly SaxesTagNS[]; start: number; openEnd: number; closeStart: number; end: number; text?: string }
export interface XlsxXmlPatch { start: number; end: number; text: string }

/**
 * Lexical element offsets over the decoded part, for byte-preserving splices. DTDs and a declared encoding that differs
 * from the actual one are refused; nothing is resolved or fetched.
 */
export function scanXlsxXml(value: XlsxXmlText, progress: () => void, visit: {
  open?(tag: SaxesTagNS, parents: readonly SaxesTagNS[], start: number, openEnd: number): boolean | void;
  close?(node: XlsxXmlNode): void;
}): void {
  const parser = new SaxesParser({ xmlns: true }); const stack: Array<{ tag: SaxesTagNS; start: number; openEnd: number; text?: string[] }> = [];
  let start = 0;
  parser.on('doctype', () => { throw new WorkbookEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => {
    const declared = declaration.encoding?.toLowerCase();
    if (declared && declared !== value.encoding && !(declared === 'utf-16' && value.encoding.startsWith('utf-16'))) throw new WorkbookEditFailure('unsupported-xml-encoding');
  });
  parser.on('opentagstart', () => { start = value.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const parents = stack.map(frame => frame.tag);
    const wantText = visit.open?.(tag, parents, start, parser.position) === true;
    stack.push({ tag, start, openEnd: parser.position, ...(wantText ? { text: [] } : {}) });
  });
  const text = (chunk: string) => { for (const frame of stack) frame.text?.push(chunk); };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', tag => {
    const frame = stack.pop()!; const end = parser.position;
    const closeStart = tag.isSelfClosing ? end : value.xml.lastIndexOf('</', end - 1);
    visit.close?.({ tag, parents: stack.map(item => item.tag), start: frame.start, openEnd: frame.openEnd, closeStart, end, ...(frame.text ? { text: frame.text.join('') } : {}) });
  });
  for (let at = 0; at < value.xml.length; at += 65536) { progress(); parser.write(value.xml.slice(at, at + 65536)); }
  parser.close();
}

export function applyXlsxPatches(value: XlsxXmlText, patches: XlsxXmlPatch[]): Buffer {
  const chunks: string[] = []; let at = 0;
  for (const patch of [...patches].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (patch.start < at) throw new WorkbookEditFailure('workbook-edit-failed');
    chunks.push(value.xml.slice(at, patch.start), patch.text); at = patch.end;
  }
  chunks.push(value.xml.slice(at)); return encodeOfficeXml({ ...value, xml: chunks.join('') });
}

export const xlsxXmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const xlsxXmlAttributeValue = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');

/** Lexical attributes of one opening tag, in source order, so unchanged attributes keep their exact spelling. */
export function xlsxOpeningAttributes(opening: string): { name: string; attributes: Array<{ name: string; raw: string }>; selfClosing: boolean } {
  let at = 1; while (at < opening.length && !/[\s/>]/.test(opening[at])) at++;
  const name = opening.slice(1, at); const attributes: Array<{ name: string; raw: string }> = [];
  while (at < opening.length) {
    while (/\s/.test(opening[at])) at++;
    if (opening[at] === '/' || opening[at] === '>') break;
    const begin = at; while (at < opening.length && !/[\s=]/.test(opening[at])) at++; const key = opening.slice(begin, at);
    while (/\s/.test(opening[at])) at++; if (opening[at++] !== '=') throw new WorkbookEditFailure('workbook-edit-failed');
    while (/\s/.test(opening[at])) at++; const quote = opening[at++]; if (quote !== '"' && quote !== "'") throw new WorkbookEditFailure('workbook-edit-failed');
    while (at < opening.length && opening[at] !== quote) at++; if (at >= opening.length) throw new WorkbookEditFailure('workbook-edit-failed');
    at++; attributes.push({ name: key, raw: opening.slice(begin, at) });
  }
  return { name, attributes, selfClosing: /\/\s*>$/.test(opening) };
}
export function xlsxOpening(name: string, attributes: Array<{ name: string; raw: string }>, selfClosing: boolean): string {
  return `<${name}${attributes.map(attribute => ' ' + attribute.raw).join('')}${selfClosing ? '/>' : '>'}`;
}
/** Set (or add at the end) and remove attributes of one opening tag; all others keep their exact source text. */
export function xlsxEditOpening(opening: string, set: Record<string, string | undefined>, selfClosing?: boolean): string {
  const parsed = xlsxOpeningAttributes(opening); const attributes = [...parsed.attributes];
  for (const [key, value] of Object.entries(set)) {
    const index = attributes.findIndex(attribute => attribute.name === key);
    if (value === undefined) { if (index >= 0) attributes.splice(index, 1); continue; }
    const raw = `${key}="${xlsxXmlAttributeValue(value)}"`;
    if (index >= 0) attributes[index] = { name: key, raw }; else attributes.push({ name: key, raw });
  }
  return xlsxOpening(parsed.name, attributes, selfClosing ?? parsed.selfClosing);
}
