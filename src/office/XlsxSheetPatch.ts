import { createHash } from 'node:crypto';
import type { SaxesTagNS } from 'saxes';
import { SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute, spreadsheetStringXml } from '../content/WorkbookXml';
import { xlsxAddress, xlsxRange, XLSX_COLUMNS, XLSX_ROWS } from '../content/XlsxSheet';
import { columnName, type WorkbookRange } from '../content/WorkbookPage';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import { scanXlsxXml, applyXlsxPatches, xlsxEditOpening, xlsxXmlText, xlsxOpeningAttributes, type XlsxXmlText, type XlsxXmlPatch } from './XlsxXmlScan';

export interface XlsxCellFormula { mode: string; si?: string; ref?: string; text: string }
export interface XlsxCellNode { ref: string; row: number; column: number; start: number; openEnd: number; end: number; selfClosing: boolean; hasR: boolean;
  style?: number; type?: string; formula?: XlsxCellFormula; children: Array<{ local: string; start: number; end: number }> }
export interface XlsxRowNode { row: number; start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean; hasR: boolean;
  style?: number; customFormat: boolean; cells: XlsxCellNode[] }
export interface XlsxSheetLayout {
  value: XlsxXmlText; prefix: string; rows: XlsxRowNode[]; byRef: Map<string, XlsxCellNode>;
  sheetData: { start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean };
  dimension?: { start: number; openEnd: number; ref?: string };
  protected: boolean; merges: WorkbookRange[]; columnStyles: Array<{ min: number; max: number; style: number }>; tableRelationships: string[];
}
export type XlsxCellContent = { kind: 'string'; text: string } | { kind: 'number'; raw: string } | { kind: 'boolean'; value: boolean }
  | { kind: 'clear' } | { kind: 'formula'; text: string }
  /** A recalculated cached result for an existing formula cell: the formula is kept, only the value and its type change. */
  | { kind: 'cached'; type: 'n' | 'str' | 'b' | 'e'; text: string };
/** One final cell change. `style` replaces the cell's s; undefined keeps it (or the base style chosen for a new cell). */
export interface XlsxCellWrite { row: number; column: number; content?: XlsxCellContent; style?: number }
export const xlsxCellKey = (row: number, column: number) => row * (XLSX_COLUMNS + 1) + column;

const integer = (raw: string | undefined) => raw !== undefined && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
const truthy = (raw: string | undefined) => raw === '1' || raw === 'true';
const REL_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];

/** Offsets of rows and cells in one worksheet part, with the structure a writer must respect. */
export function readXlsxSheetLayout(bytes: Buffer, progress: () => void): XlsxSheetLayout {
  const value = decodeOfficeXml(bytes); const rows: XlsxRowNode[] = []; const byRef = new Map<string, XlsxCellNode>();
  let sheetData: XlsxSheetLayout['sheetData'] | undefined; let dimension: XlsxSheetLayout['dimension']; let prefix = ''; let isProtected = false;
  const merges: WorkbookRange[] = []; const columnStyles: XlsxSheetLayout['columnStyles'] = []; const tableRelationships: string[] = [];
  let row: XlsxRowNode | undefined; let cell: XlsxCellNode | undefined; let previousRow = 0; let previousColumn = 0; let rootSeen = false;
  const inSheet = (tag: SaxesTagNS) => SHEET_NS.has(tag.uri);
  const path = (parents: readonly SaxesTagNS[], tag: SaxesTagNS) => [...parents, tag].map(item => inSheet(item) ? item.local : '?').join('/');
  scanXlsxXml(value, progress, {
    open(tag, parents, start, openEnd) {
      if (!parents.length) { if (!inSheet(tag) || tag.local !== 'worksheet') throw new WorkbookEditFailure('unavailable-worksheet'); rootSeen = true; return; }
      const at = path(parents, tag);
      if (at === 'worksheet/sheetData') prefix = tag.prefix ? tag.prefix + ':' : '';
      if (at === 'worksheet/dimension') dimension = { start, openEnd, ref: xmlAttribute(tag, 'ref') };
      if (at === 'worksheet/sheetProtection' && truthy(xmlAttribute(tag, 'sheet'))) isProtected = true;
      if (at === 'worksheet/mergeCells/mergeCell') { try { merges.push(xlsxRange(xmlAttribute(tag, 'ref') ?? '')); } catch { throw new WorkbookEditFailure('workbook-structure-unsupported'); } }
      if (at === 'worksheet/cols/col') {
        const min = integer(xmlAttribute(tag, 'min')); const max = integer(xmlAttribute(tag, 'max')); const style = integer(xmlAttribute(tag, 'style'));
        if (min && max && style !== undefined) columnStyles.push({ min, max, style });
      }
      if (at === 'worksheet/tableParts/tablePart') { const id = REL_NS.map(ns => xmlAttribute(tag, 'id', ns)).find(Boolean); if (id) tableRelationships.push(id); }
      if (at === 'worksheet/sheetData/row') {
        const declared = xmlAttribute(tag, 'r'); const number = declared === undefined ? previousRow + 1 : integer(declared);
        if (!number || number > XLSX_ROWS || number <= previousRow) throw new WorkbookEditFailure('workbook-structure-unsupported');
        row = { row: number, start, openEnd, closeStart: openEnd, end: openEnd, selfClosing: tag.isSelfClosing, hasR: declared !== undefined,
          style: integer(xmlAttribute(tag, 's')), customFormat: truthy(xmlAttribute(tag, 'customFormat')), cells: [] };
        previousRow = number; previousColumn = 0;
      }
      if (at === 'worksheet/sheetData/row/c' && row) {
        const declared = xmlAttribute(tag, 'r'); let address: { row: number; column: number; cell: string };
        try { address = declared === undefined ? xlsxAddress(`${columnName(previousColumn + 1)}${row.row}`) : xlsxAddress(declared); }
        catch { throw new WorkbookEditFailure('workbook-structure-unsupported'); }
        // Strictly increasing cells in their own row are what a splice position needs; anything else is not rewritten.
        if (address.row !== row.row || address.column <= previousColumn || byRef.has(address.cell)) throw new WorkbookEditFailure('workbook-structure-unsupported');
        previousColumn = address.column;
        cell = { ref: address.cell, row: address.row, column: address.column, start, openEnd, end: openEnd, selfClosing: tag.isSelfClosing, hasR: declared !== undefined,
          style: integer(xmlAttribute(tag, 's')), type: xmlAttribute(tag, 't'), children: [] };
      }
      if (at === 'worksheet/sheetData/row/c/f') return true;
      return undefined;
    },
    close(node) {
      const at = path(node.parents, node.tag);
      if (at === 'worksheet/sheetData') sheetData = { start: node.start, openEnd: node.openEnd, closeStart: node.closeStart, end: node.end, selfClosing: node.tag.isSelfClosing };
      if (at === 'worksheet/sheetData/row/c/f' && cell) cell.formula = { mode: xmlAttribute(node.tag, 't') ?? 'normal', si: xmlAttribute(node.tag, 'si'), ref: xmlAttribute(node.tag, 'ref'), text: node.text ?? '' };
      if (node.parents.length === 4 && cell && path(node.parents, node.tag).startsWith('worksheet/sheetData/row/c/')) cell.children.push({ local: inSheet(node.tag) ? node.tag.local : '?', start: node.start, end: node.end });
      if (at === 'worksheet/sheetData/row/c' && cell && row) { cell.end = node.end; row.cells.push(cell); byRef.set(cell.ref, cell); cell = undefined; }
      if (at === 'worksheet/sheetData/row' && row) { row.closeStart = node.closeStart; row.end = node.end; rows.push(row); row = undefined; }
    },
  });
  if (!rootSeen || !sheetData) throw new WorkbookEditFailure('unavailable-worksheet');
  return { value, prefix, rows, byRef, sheetData, dimension, protected: isProtected, merges, columnStyles, tableRelationships };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Address-bound digests of every cell element not in `written`, in document order, from the actual part text. */
export function xlsxUntouchedCells(layout: XlsxSheetLayout, written: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const row of layout.rows) for (const cell of row.cells) if (!written.has(cell.ref)) result.push(`${cell.ref}:${sha(layout.value.xml.slice(cell.start, cell.end))}`);
  return result;
}

function cellChildren(prefix: string, content: XlsxCellContent): { type?: string; xml: string } {
  switch (content.kind) {
    case 'string': return { type: 'inlineStr', xml: `<${prefix}is><${prefix}t xml:space="preserve">${spreadsheetStringXml(content.text)}</${prefix}t></${prefix}is>` };
    case 'number': return { xml: `<${prefix}v>${content.raw}</${prefix}v>` };
    case 'boolean': return { type: 'b', xml: `<${prefix}v>${content.value ? 1 : 0}</${prefix}v>` };
    case 'formula': return { xml: `<${prefix}f>${xlsxXmlText(content.text)}</${prefix}f>` };
    case 'clear': return { xml: '' };
    case 'cached': return { ...(content.type === 'n' ? {} : { type: content.type }),
      xml: `<${prefix}v>${content.type === 'str' ? spreadsheetStringXml(content.text) : xlsxXmlText(content.text)}</${prefix}v>` };
  }
}

/** The rewritten cell: original attributes kept except the type and value metadata that described the old content. */
function rewrittenCell(layout: XlsxSheetLayout, node: XlsxCellNode, write: XlsxCellWrite): string {
  const opening = layout.value.xml.slice(node.start, node.openEnd);
  if (!write.content) return write.style === undefined ? layout.value.xml.slice(node.start, node.end)
    : xlsxEditOpening(opening, { s: String(write.style) }) + layout.value.xml.slice(node.openEnd, node.end);
  const children = cellChildren(layout.prefix, write.content); const cached = write.content.kind === 'cached';
  const raw = (local: string) => node.children.filter(child => child.local === local).map(child => layout.value.xml.slice(child.start, child.end)).join('');
  const kept = node.children.filter(child => !['f', 'v', 'is'].includes(child.local)).map(child => layout.value.xml.slice(child.start, child.end)).join('');
  const body = (cached ? raw('f') : '') + children.xml + kept;
  // A cached result keeps the formula and its cell metadata; any other content change drops metadata of the old content.
  const head = xlsxEditOpening(opening, { r: node.ref, t: children.type, ...(cached ? {} : { cm: undefined }), vm: undefined, ...(write.style === undefined ? {} : { s: String(write.style) }) }, !body);
  return body ? `${head}${body}</${xlsxOpeningAttributes(opening).name}>` : head;
}
export function xlsxNewCellXml(prefix: string, write: XlsxCellWrite): string {
  const ref = `${columnName(write.column)}${write.row}`; const children = write.content ? cellChildren(prefix, write.content) : { xml: '' };
  const attributes = `r="${ref}"${write.style ? ` s="${write.style}"` : ''}${children.type ? ` t="${children.type}"` : ''}`;
  return children.xml ? `<${prefix}c ${attributes}>${children.xml}</${prefix}c>` : `<${prefix}c ${attributes}/>`;
}

/** Base style of a cell that has no element yet: its row's custom style, else its column style, else the default. */
export function xlsxNewCellStyle(layout: XlsxSheetLayout, row: number, column: number): number {
  const record = layout.rows.find(item => item.row === row);
  if (record?.customFormat && record.style !== undefined) return record.style;
  return layout.columnStyles.find(item => column >= item.min && column <= item.max)?.style ?? 0;
}

/** Splice final cell writes into the part. Untouched cells, rows and every non-cell element keep their source text. */
export function patchXlsxSheet(layout: XlsxSheetLayout, writes: XlsxCellWrite[]): { bytes: Buffer; dimension?: string } {
  const { value, prefix } = layout; const patches: XlsxXmlPatch[] = [];
  const byRow = new Map<number, XlsxCellWrite[]>();
  for (const write of writes) { const list = byRow.get(write.row) ?? []; list.push(write); byRow.set(write.row, list); }
  const rowNumbers = [...byRow.keys()].sort((left, right) => left - right); const pendingRows = new Map<number, string[]>();
  let first = Infinity; let last = 0; let firstColumn = Infinity; let lastColumn = 0;
  const extent = (row: number, column: number) => { first = Math.min(first, row); last = Math.max(last, row); firstColumn = Math.min(firstColumn, column); lastColumn = Math.max(lastColumn, column); };
  for (const number of rowNumbers) {
    const list = byRow.get(number)!.sort((left, right) => left.column - right.column);
    const existing = layout.rows.find(row => row.row === number);
    for (const write of list) extent(write.row, write.column);
    if (!existing) {
      const later = layout.rows.find(row => row.row > number);
      if (later && layout.rows.some(row => row.row >= later.row && !row.hasR)) throw new WorkbookEditFailure('workbook-structure-unsupported');
      const xml = `<${prefix}row r="${number}">${list.map(write => xlsxNewCellXml(prefix, write)).join('')}</${prefix}row>`;
      const at = later ? later.start : -1; const key = at;
      pendingRows.set(key, [...(pendingRows.get(key) ?? []), xml]); continue;
    }
    const inserts = new Map<number, string[]>(); let maxColumn = 0; let minColumn = Infinity;
    for (const write of list) {
      const node = existing.cells.find(cell => cell.column === write.column);
      if (node) { patches.push({ start: node.start, end: node.end, text: rewrittenCell(layout, node, write) }); continue; }
      const next = existing.cells.find(cell => cell.column > write.column);
      if (next && existing.cells.some(cell => cell.column >= next.column && !cell.hasR)) throw new WorkbookEditFailure('workbook-structure-unsupported');
      const at = next ? next.start : existing.closeStart; inserts.set(at, [...(inserts.get(at) ?? []), xlsxNewCellXml(prefix, write)]);
      maxColumn = Math.max(maxColumn, write.column); minColumn = Math.min(minColumn, write.column);
    }
    const opening = value.xml.slice(existing.start, existing.openEnd); const spans = /\bspans\s*=\s*["'](\d+):(\d+)["']/.exec(opening);
    const newSpans = spans && inserts.size ? `${Math.min(Number(spans[1]), minColumn)}:${Math.max(Number(spans[2]), maxColumn)}` : undefined;
    if (existing.selfClosing) {
      if (!inserts.size) continue;
      const head = xlsxEditOpening(opening, newSpans ? { spans: newSpans } : {}, false);
      patches.push({ start: existing.start, end: existing.end, text: `${head}${[...inserts.values()].flat().join('')}</${xlsxOpeningAttributes(opening).name}>` }); continue;
    }
    if (newSpans && newSpans !== `${spans![1]}:${spans![2]}`) patches.push({ start: existing.start, end: existing.openEnd, text: xlsxEditOpening(opening, { spans: newSpans }) });
    for (const [at, cells] of inserts) patches.push({ start: at, end: at, text: cells.join('') });
  }
  for (const [at, xml] of pendingRows) {
    if (at >= 0) { patches.push({ start: at, end: at, text: xml.join('') }); continue; }
    if (layout.sheetData.selfClosing) {
      const opening = value.xml.slice(layout.sheetData.start, layout.sheetData.end);
      patches.push({ start: layout.sheetData.start, end: layout.sheetData.end, text: `${xlsxEditOpening(opening, {}, false)}${xml.join('')}</${xlsxOpeningAttributes(opening).name}>` });
    } else patches.push({ start: layout.sheetData.closeStart, end: layout.sheetData.closeStart, text: xml.join('') });
  }
  let dimension: string | undefined;
  if (layout.dimension && writes.length) {
    let range: WorkbookRange | undefined; try { if (layout.dimension.ref) range = xlsxRange(layout.dimension.ref); } catch { range = undefined; }
    if (!range) for (const row of layout.rows) for (const cell of row.cells) range = range ? { firstRow: Math.min(range.firstRow, cell.row), lastRow: Math.max(range.lastRow, cell.row),
      firstColumn: Math.min(range.firstColumn, cell.column), lastColumn: Math.max(range.lastColumn, cell.column) } : { firstRow: cell.row, lastRow: cell.row, firstColumn: cell.column, lastColumn: cell.column };
    const merged = range ? { firstRow: Math.min(range.firstRow, first), lastRow: Math.max(range.lastRow, last), firstColumn: Math.min(range.firstColumn, firstColumn), lastColumn: Math.max(range.lastColumn, lastColumn) }
      : { firstRow: first, lastRow: last, firstColumn, lastColumn };
    const text = merged.firstRow === merged.lastRow && merged.firstColumn === merged.lastColumn ? `${columnName(merged.firstColumn)}${merged.firstRow}`
      : `${columnName(merged.firstColumn)}${merged.firstRow}:${columnName(merged.lastColumn)}${merged.lastRow}`;
    if (text !== layout.dimension.ref) { dimension = text; patches.push({ start: layout.dimension.start, end: layout.dimension.openEnd, text: xlsxEditOpening(value.xml.slice(layout.dimension.start, layout.dimension.openEnd), { ref: text }) }); }
  }
  return { bytes: applyXlsxPatches(value, patches), ...(dimension ? { dimension } : {}) };
}
