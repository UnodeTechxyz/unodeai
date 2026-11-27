import { SaxesParser } from 'saxes';
import { officeXmlElements, removeOfficeElements, type OfficeXmlElement } from './OfficeXmlElements';
import { OFFICE_NS } from './OfficePackage';
import { xmlAttribute } from '../content/WorkbookXml';

export const layoutField = (value: string) => /^\s*(?:PAGE|NUMPAGES|SECTION|SECTIONPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|CHARFORMAT|ARABIC|ROMAN|ALPHABETIC))*\s*$/i.test(value);

/** Decide on the final surviving XML stream, never on text/field marks hidden in removed branches. */
export function closeRenderLayoutFields(bytes: Buffer, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress);
  const bad = new Set(parsed.elements.filter(element => OFFICE_NS.w.includes(element.tag.uri) && ['fldChar', 'instrText'].includes(element.tag.local)));
  const parser = new SaxesParser({ xmlns: true }); const open: OfficeXmlElement[] = [];
  const fields: Array<{ marks: OfficeXmlElement[]; code: string; inCode: boolean; valid: boolean }> = [];
  let index = 0;
  const word = (element: OfficeXmlElement | undefined, name: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && element.tag.local === name;
  parser.on('doctype', () => { throw Error('render-copy-field-xml'); });
  parser.on('opentag', () => {
    const element = parsed.elements[index++]; if (!element) throw Error('render-copy-field-xml');
    const parent = open.at(-1); open.push(element);
    if (word(element, 'fldChar')) {
      const type = xmlAttribute(element.tag, 'fldCharType', element.tag.uri);
      if (type === 'begin') {
        const nested = fields.length > 0; if (nested) fields.at(-1)!.valid = false;
        fields.push({ marks: [element], code: '', inCode: true, valid: !nested && !element.children.length && word(parent, 'r') && word(parent?.parent, 'p') });
      } else if (fields.length) {
        const field = fields.at(-1)!; field.marks.push(element);
        if (element.children.length || !word(parent, 'r') || !word(parent?.parent, 'p')) field.valid = false;
        if (type === 'separate') { if (!field.inCode) field.valid = false; field.inCode = false; }
        else if (type === 'end') {
          fields.pop(); if (field.valid && layoutField(field.code)) for (const mark of field.marks) bad.delete(mark);
        } else field.valid = false;
      }
      return;
    }
    const field = fields.at(-1); if (!field) return;
    if (word(element, 'instrText')) {
      field.marks.push(element);
      if (!field.inCode || !word(parent, 'r') || !word(parent?.parent, 'p') || open.some(ancestor => word(ancestor, 'rPr')) || element.children.length) field.valid = false;
      return;
    }
    if (field.inCode) {
      const property = open.some(ancestor => word(ancestor, 'rPr'));
      if (word(element, 't') || word(element, 'delText') || word(element, 'r') && !word(parent, 'p') || !word(element, 'r') && !property) field.valid = false;
    }
  });
  const text = (value: string) => {
    const field = fields.at(-1); if (!field?.inCode) return;
    if (word(open.at(-1), 'instrText') && word(open.at(-2), 'r')) field.code += value;
    else if (value.trim()) field.valid = false;
  };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => { open.pop(); });
  for (let at = 0; at < parsed.decoded.xml.length; at += 65536) { progress(); parser.write(parsed.decoded.xml.slice(at, at + 65536)); }
  parser.close(); if (index !== parsed.elements.length) throw Error('render-copy-field-xml');
  // Unclosed groups never removed their marks from bad. Cached visible text remains, with no executable field delimiters.
  const result = bad.size ? removeOfficeElements(parsed, bad) : bytes;
  officeXmlElements(result, progress);
  return { bytes: result, removedElements: bad.size };
}
