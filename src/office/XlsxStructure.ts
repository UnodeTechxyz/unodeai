import { SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute } from '../content/WorkbookXml';
import { xlsxRange } from '../content/XlsxSheet';
import { columnName, type WorkbookRange } from '../content/WorkbookPage';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import { scanXlsxXml, applyXlsxPatches, xlsxEditOpening, type XlsxXmlPatch } from './XlsxXmlScan';

export interface XlsxTableInfo { part: string; name?: string; range: WorkbookRange; headerRows: number; totalsRows: number;
  columns: Array<{ name: string; formula?: string }>; autoFilter?: WorkbookRange }
const count = (raw: string | undefined, fallback: number) => raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : (() => { throw new WorkbookEditFailure('table-structure-unsupported'); })();
const range = (raw: string | undefined) => { try { return xlsxRange(raw ?? ''); } catch { throw new WorkbookEditFailure('table-structure-unsupported'); } };
export const xlsxRangeText = (value: WorkbookRange) => `${columnName(value.firstColumn)}${value.firstRow}:${columnName(value.lastColumn)}${value.lastRow}`;

/** Only the table fields a cell writer must respect: its area, header/totals rows and calculated column text. */
export function readXlsxTable(bytes: Buffer, part: string, progress: () => void): XlsxTableInfo {
  let info: XlsxTableInfo | undefined; let column: { name: string; formula?: string } | undefined;
  scanXlsxXml(decodeOfficeXml(bytes), progress, {
    open(tag, parents) {
      if (!parents.length) {
        if (!SHEET_NS.has(tag.uri) || tag.local !== 'table') throw new WorkbookEditFailure('table-structure-unsupported');
        info = { part, name: xmlAttribute(tag, 'displayName') ?? xmlAttribute(tag, 'name'), range: range(xmlAttribute(tag, 'ref')),
          headerRows: count(xmlAttribute(tag, 'headerRowCount'), 1), totalsRows: count(xmlAttribute(tag, 'totalsRowCount'), 0), columns: [] };
        return undefined;
      }
      if (!SHEET_NS.has(tag.uri) || !info) return undefined;
      if (parents.length === 1 && tag.local === 'autoFilter' && xmlAttribute(tag, 'ref')) info.autoFilter = range(xmlAttribute(tag, 'ref'));
      if (parents.length === 2 && parents[1].local === 'tableColumns' && tag.local === 'tableColumn') { column = { name: xmlAttribute(tag, 'name') ?? '' }; info.columns.push(column); }
      return parents.length === 3 && tag.local === 'calculatedColumnFormula' ? true : undefined;
    },
    close(node) { if (node.parents.length === 3 && node.tag.local === 'calculatedColumnFormula' && SHEET_NS.has(node.tag.uri) && column) column.formula = node.text ?? ''; },
  });
  if (!info) throw new WorkbookEditFailure('table-structure-unsupported');
  if (info.columns.length !== info.range.lastColumn - info.range.firstColumn + 1) throw new WorkbookEditFailure('table-structure-unsupported');
  return info;
}

/** Grow the table (and its filter) down to `lastRow`; every other table byte stays as stored. */
export function extendXlsxTable(bytes: Buffer, table: XlsxTableInfo, lastRow: number, progress: () => void): Buffer {
  const value = decodeOfficeXml(bytes); const patches: XlsxXmlPatch[] = [];
  scanXlsxXml(value, progress, { open(tag, parents, start, openEnd) {
    const opening = () => value.xml.slice(start, openEnd);
    if (!parents.length) patches.push({ start, end: openEnd, text: xlsxEditOpening(opening(), { ref: xlsxRangeText({ ...table.range, lastRow }) }) });
    else if (parents.length === 1 && SHEET_NS.has(tag.uri) && tag.local === 'autoFilter' && table.autoFilter)
      patches.push({ start, end: openEnd, text: xlsxEditOpening(opening(), { ref: xlsxRangeText({ ...table.autoFilter, lastRow: Math.max(table.autoFilter.lastRow, lastRow) }) }) });
  } });
  return applyXlsxPatches(value, patches);
}

export function readXlsxPivotLocation(bytes: Buffer, progress: () => void): WorkbookRange {
  let location: WorkbookRange | undefined;
  scanXlsxXml(decodeOfficeXml(bytes), progress, { open(tag, parents) {
    if (parents.length === 1 && SHEET_NS.has(tag.uri) && tag.local === 'location') { try { location = xlsxRange(xmlAttribute(tag, 'ref') ?? ''); } catch { location = undefined; } }
  } });
  if (!location) throw new WorkbookEditFailure('workbook-structure-unsupported');
  return location;
}
