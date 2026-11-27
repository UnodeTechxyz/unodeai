import { SaxesParser, type SaxesTagNS } from 'saxes';
import { TextDecoder } from 'node:util';
export interface WorkbookXmlEvents { open?(tag: SaxesTagNS): void; close?(tag: SaxesTagNS): void; text?(text: string): void }
/** Fixed XML parser: namespaces are preserved, DTDs refused, no resolver or application invocation. */
export async function readWorkbookXml(chunks: AsyncIterable<Uint8Array>, events: WorkbookXmlEvents, progress: () => void = () => {}) {
  const parser = new SaxesParser({ xmlns: true });
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8'; let decoder: TextDecoder | undefined; let initial = Buffer.alloc(0);
  parser.on('doctype', () => { throw new Error('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => {
    const declared = declaration.encoding?.toLowerCase();
    if (declared && declared !== encoding && !(declared === 'utf-16' && encoding.startsWith('utf-16'))) throw new Error('unsupported-xml-encoding');
  });
  parser.on('opentag', tag => events.open?.(tag)); parser.on('closetag', tag => events.close?.(tag));
  parser.on('text', text => events.text?.(text)); parser.on('cdata', text => events.text?.(text));
  const begin = (bytes: Buffer) => {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else if (bytes[0] === 0 && bytes[1] === 60 && bytes[2] === 0 && bytes[3] === 63) encoding = 'utf-16be';
    else if (bytes[0] === 60 && bytes[1] === 0 && bytes[2] === 63 && bytes[3] === 0) encoding = 'utf-16le';
    decoder = new TextDecoder(encoding, { fatal: true }); return decoder.decode(bytes, { stream: true });
  };
  for await (const chunk of chunks) {
    progress();
    if (!decoder) { initial = Buffer.concat([initial, chunk]); if (initial.length < 4) continue; parser.write(begin(initial)); initial = Buffer.alloc(0); }
    else parser.write(decoder.decode(chunk, { stream: true }));
  }
  if (!decoder) parser.write(begin(initial));
  parser.write(decoder!.decode()); parser.close(); return { encoding };
}
export function xmlAttribute(tag: SaxesTagNS, local: string, namespace = ''): string | undefined {
  return Object.values(tag.attributes).find(attribute => attribute.local === local && attribute.uri === namespace)?.value;
}
/** OOXML ST_Xstring escapes UTF-16 code units once; an escaped underscore must never trigger recursive decoding. */
export function spreadsheetString(source: string) {
  const decoded = source.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  for (let index = 0; index < decoded.length; index++) {
    const code = decoded.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = decoded.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return { text: source, escapedCodeUnitsUnresolved: true };
    } else if (code >= 0xdc00 && code <= 0xdfff) return { text: source, escapedCodeUnitsUnresolved: true };
  }
  return { text: decoded, escapedCodeUnitsUnresolved: false };
}

/** Shared ST_Xstring text in worksheet cells and chart c:v (ISO 29500 §22.9.2.19).
 * Preserve literal escape-looking text before encoding CR and XML-illegal control code units.
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/d34ae755-c53f-4a44-a363-c6dd3ee018a4
 */
export function spreadsheetStringXml(source: string): string {
  return source.replace(/_(?=x[0-9a-f]{4}(?:_|[\u0000-\u0008\u000b-\u001f\ufffe\uffff]))/gi, '_x005F_')
    .replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\ufffe\uffff]/gu, char => `_x${char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
