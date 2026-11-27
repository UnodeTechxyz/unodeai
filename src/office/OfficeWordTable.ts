// Fixed incremental Word table construction and original table selector ordering.
import { OFFICE_NS } from './OfficePackage';
import { officeXmlElements, type OfficeXmlElement } from './OfficeXmlElements';
import { encodeOfficeXml } from './OfficeTextPatch';
import { OfficeEditFailure } from './OfficeEditContracts';
import { SaxesParser } from 'saxes';
export interface OfficeWordTableInsert { op: 'insert_table'; target_ref: string; rows: string[][]; position: 'before' | 'after'; header_row: boolean; style_id?: string }
const validText = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
export function validateWordTableInsert(raw: Record<string, unknown>): OfficeWordTableInsert {
  if (Object.keys(raw).some(key => !['op', 'target_ref', 'rows', 'position', 'header_row', 'style_id'].includes(key)) || raw.op !== 'insert_table'
    || typeof raw.target_ref !== 'string' || !/^(?:P[1-9]\d*-)?D[1-9]\d*$/.test(raw.target_ref) || !Array.isArray(raw.rows) || !raw.rows.length
    || !Array.isArray(raw.rows[0]) || !raw.rows[0].length || raw.rows.some(row => !Array.isArray(row) || row.length !== (raw.rows as unknown[][])[0].length || row.some(value => !validText(value)))
    || raw.position !== undefined && raw.position !== 'before' && raw.position !== 'after' || raw.header_row !== undefined && typeof raw.header_row !== 'boolean'
    || raw.style_id !== undefined && (!validText(raw.style_id) || !raw.style_id)) throw new OfficeEditFailure('invalid-office-edits');
  return { op: 'insert_table', target_ref: raw.target_ref, rows: (raw.rows as string[][]).map(row => [...row]), position: raw.position === 'before' ? 'before' : 'after', header_row: raw.header_row === true,
    ...(raw.style_id === undefined ? {} : { style_id: raw.style_id as string }) };
}
export class OfficeWordTableOrder {
  private readonly ordinals: number[];
  constructor(originalCount: number) { this.ordinals = Array.from({ length: originalCount }, (_, index) => index + 1); }
  /** Original row ordinals removed from each original table by an accepted or rejected row revision. */
  private readonly removedRows = new Map<number, number[]>();
  currentCell(ref: string) {
    const match = /^T([1-9]\d*)-R([1-9]\d*)(-C[1-9]\d*)$/.exec(ref); const value = match ? this.ordinals[Number(match[1]) - 1] : undefined;
    if (value === undefined) throw new OfficeEditFailure('edit-target-unavailable');
    const row = Number(match![2]); const removed = this.removedRows.get(Number(match![1])) ?? [];
    if (removed.includes(row)) throw new OfficeEditFailure('edit-target-unavailable');
    return 'T' + value + '-R' + (row - removed.filter(item => item < row).length) + match![3];
  }
  inserted(at: number) { for (let index = 0; index < this.ordinals.length; index++) if (this.ordinals[index] >= at) this.ordinals[index]++; }
  /** A row removed from the current table `table` at current position `row`; its cell selectors become unavailable. */
  removedRow(table: number, row: number) {
    const original = this.ordinals.indexOf(table) + 1; if (!original) return;
    const removed = this.removedRows.get(original) ?? []; let candidate = row;
    while (removed.includes(candidate) || candidate - removed.filter(item => item < candidate).length < row) candidate++;
    removed.push(candidate); this.removedRows.set(original, removed);
  }
}
const w = (element: OfficeXmlElement | undefined, local: string) => !!element && OFFICE_NS.w.includes(element.tag.uri) && element.tag.local === local;
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
function withinBody(element: OfficeXmlElement) {
  let body = false; for (let at: OfficeXmlElement | undefined = element; at; at = at.parent) { if (at.tag.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && at.tag.local === 'AlternateContent') return false; if (w(at, 'body')) body = true; } return body;
}
/** New rectangular table uses Word AutoFit and existing default table/font styles, never guessed page widths. */
export function insertOfficeWordTable(bytes: Buffer, ordinal: number, edit: OfficeWordTableInsert, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const paragraphs = parsed.elements.filter(element => w(element, 'p') && withinBody(element)); const tables = parsed.elements.filter(element => w(element, 'tbl') && withinBody(element));
  const anchor = paragraphs[ordinal - 1]; if (!anchor) throw new OfficeEditFailure('unsupported-edit-target'); const at = edit.position === 'before' ? anchor.start : anchor.end; const uri = anchor.tag.uri;
  const rows = edit.rows.map(row => row.map(text => text.replace(/\r\n?/g, '\n')));
  const text = (value: string) => value.split(/([\n\t])/).map(piece => piece === '\n' ? '<ut:br/>' : piece === '\t' ? '<ut:tab/>' : `<ut:t xml:space="preserve">${escaped(piece)}</ut:t>`).join('');
  const extraParagraph = w(anchor.parent, 'tc') && !anchor.parent!.children.some(element => element.start >= at);
  const xml = `<ut:tbl xmlns:ut="${uri}"><ut:tblPr>${edit.style_id ? `<ut:tblStyle ut:val="${escaped(edit.style_id)}"/>` : ''}<ut:tblW ut:w="0" ut:type="auto"/><ut:tblLayout ut:type="autofit"/></ut:tblPr><ut:tblGrid>${rows[0].map(() => '<ut:gridCol/>').join('')}</ut:tblGrid>`
    + rows.map((row, index) => { progress(); return `<ut:tr>${edit.header_row && !index ? '<ut:trPr><ut:tblHeader/></ut:trPr>' : ''}${row.map(value => `<ut:tc><ut:tcPr><ut:tcW ut:w="0" ut:type="auto"/></ut:tcPr><ut:p><ut:r>${edit.header_row && !index ? '<ut:rPr><ut:b/></ut:rPr>' : ''}${text(value)}</ut:r></ut:p></ut:tc>`).join('')}</ut:tr>`; }).join('') + '</ut:tbl>' + (extraParagraph ? `<ut:p xmlns:ut="${uri}"/>` : '');
  const output = encodeOfficeXml({ ...parsed.decoded, xml: parsed.decoded.xml.slice(0, at) + xml + parsed.decoded.xml.slice(at) });
  const checked = officeXmlElements(output, progress); const table = checked.elements.find(element => element.start === at && w(element, 'tbl'));
  const actualRows = table?.children.filter(element => w(element, 'tr')) ?? []; const cells = actualRows.flatMap(row => row.children.filter(element => w(element, 'tc')));
  if (actualRows.length !== rows.length || actualRows.some(row => row.children.filter(element => w(element, 'tc')).length !== rows[0].length)) throw new OfficeEditFailure('office-output-check-failed');
  const values = cells.map(() => ''); const starts = new Map(cells.map((cell, index) => [cell.openEnd, index])); const parser = new SaxesParser({ xmlns: true }); let cell: number | undefined; let inText = false;
  parser.on('opentag', tag => { if (starts.has(parser.position)) cell = starts.get(parser.position); if (cell === undefined || !OFFICE_NS.w.includes(tag.uri)) return; if (tag.local === 't') inText = true; else if (tag.local === 'tab') values[cell] += '\t'; else if (tag.local === 'br') values[cell] += '\n'; });
  const value = (text: string) => { if (cell !== undefined && inText) values[cell] += text; }; parser.on('text', value); parser.on('cdata', value);
  parser.on('closetag', tag => { if (!OFFICE_NS.w.includes(tag.uri)) return; if (tag.local === 't') inText = false; if (tag.local === 'tc') cell = undefined; });
  for (let offset = 0; offset < checked.decoded.xml.length; offset += 65536) { progress(); parser.write(checked.decoded.xml.slice(offset, offset + 65536)); } parser.close();
  if (JSON.stringify(values) !== JSON.stringify(rows.flat()) || checked.elements.filter(element => w(element, 'p') && withinBody(element)).length !== paragraphs.length + cells.length + Number(extraParagraph)
    || checked.elements.filter(element => w(element, 'tbl') && withinBody(element)).length !== tables.length + 1) throw new OfficeEditFailure('office-output-check-failed');
  return { bytes: output, paragraphInsertionOrdinal: paragraphs.filter(element => element.start < at).length + 1, insertedParagraphs: cells.length + Number(extraParagraph),
    tableInsertionOrdinal: tables.filter(element => element.start < at).length + 1, rows: rows.length, columns: rows[0].length, trailingParagraph: extraParagraph,
    lineEndingsNormalized: edit.rows.some(row => row.some(value => /\r/.test(value))) };
}
