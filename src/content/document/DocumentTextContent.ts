import { DocumentFailure } from './DocumentContracts';
/** Existing Word/PDF canonical text policy, shared with fixed source-cell filling. */
export function canonicalDocumentTextContent(raw: string, multiline = false): string {
  const content = raw.replace(/\r\n/g, '\n')
    .replace(/[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?(?![\u11a8-\u11ff\ud7cb-\ud7fb])/g, syllable => syllable.normalize('NFC'));
  for (const char of content) {
    const point = char.codePointAt(0)!;
    if (!(point === 0xA && multiline) && !(point >= 0x20 && point <= 0xD7FF)
      && !(point >= 0xE000 && point <= 0xFFFD) && !(point >= 0x10000 && point <= 0x10FFFF)) throw new DocumentFailure('invalid-input');
  }
  return content;
}
