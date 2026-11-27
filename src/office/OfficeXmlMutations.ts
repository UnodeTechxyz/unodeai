import { SaxesParser, type SaxesTagNS } from 'saxes';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';

export const officeXmlAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
export function officeXmlOpening(opening: string, name: string, value: string): string {
  let at = 1; while (at < opening.length && !/[ \t\r\n/>]/.test(opening[at])) at++;
  while (at < opening.length) {
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at] === '/' || opening[at] === '>') break;
    const start = at; while (at < opening.length && !/[ \t\r\n=]/.test(opening[at])) at++; const key = opening.slice(start, at);
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at++] !== '=') break; while (/[ \t\r\n]/.test(opening[at])) at++;
    const quote = opening[at++]; if (quote !== '"' && quote !== "'") break; const begin = at;
    while (at < opening.length && opening[at] !== quote) at++;
    if (at === opening.length) break;
    if (key === name) return opening.slice(0, begin) + officeXmlAttribute(value) + opening.slice(at); at++;
  }
  const end = opening.search(/\/?\s*>$/);
  if (end < 0) throw new OfficeEditFailure('unsupported-package-preservation');
  return opening.slice(0, end) + ` ${name}="${officeXmlAttribute(value)}"` + opening.slice(end);
}

/** Internal fixed-worker mutations only: namespace-selected attributes and root children, preserving all other lexical bytes. */
export function mutateOfficeXml(bytes: Buffer, choose: (tag: SaxesTagNS, parents: readonly SaxesTagNS[]) => { name: string; value: string } | undefined,
  progress: () => void, append?: { namespace: string; local: string; xml: string }): Buffer {
  const value = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const parents: SaxesTagNS[] = [];
  const patches: Array<{ start: number; end: number; text: string }> = []; let start = 0; let close = -1;
  let emptyRoot: { start: number; end: number; name: string } | undefined;
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('xmldecl', declaration => {
    const declared = declaration.encoding?.toLowerCase();
    if (declared && declared !== value.encoding && !(declared === 'utf-16' && value.encoding.startsWith('utf-16'))) throw new OfficeEditFailure('unsupported-xml-encoding');
  });
  parser.on('opentagstart', () => { start = value.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    if (!parents.length && append && tag.isSelfClosing && tag.uri === append.namespace && tag.local === append.local) emptyRoot = { start, end: parser.position, name: tag.name };
    const change = choose(tag, parents);
    if (change) {
      if (!Object.values(tag.attributes).some(attribute => attribute.name === change.name)) throw new OfficeEditFailure('unsupported-package-preservation');
      patches.push({ start, end: parser.position, text: officeXmlOpening(value.xml.slice(start, parser.position), change.name, change.value) });
    }
    parents.push(tag);
  });
  parser.on('closetag', tag => {
    if (parents.length === 1 && append && !tag.isSelfClosing && tag.uri === append.namespace && tag.local === append.local) close = value.xml.lastIndexOf('</', parser.position - 1);
    parents.pop();
  });
  for (let at = 0; at < value.xml.length; at += 65536) { progress(); parser.write(value.xml.slice(at, at + 65536)); } parser.close();
  if (append?.xml) {
    if (emptyRoot) patches.push({ start: emptyRoot.start, end: emptyRoot.end,
      text: value.xml.slice(emptyRoot.start, emptyRoot.end - 2) + '>' + append.xml + `</${emptyRoot.name}>` });
    else { if (close < 0) throw new OfficeEditFailure('unsupported-package-preservation'); patches.push({ start: close, end: close, text: append.xml }); }
  }
  const chunks: string[] = []; let at = 0;
  for (const patch of patches.sort((left, right) => left.start - right.start)) {
    if (patch.start < at) throw new OfficeEditFailure('unsupported-package-preservation');
    chunks.push(value.xml.slice(at, patch.start), patch.text); at = patch.end;
  }
  chunks.push(value.xml.slice(at)); return encodeOfficeXml({ ...value, xml: chunks.join('') });
}
