import { ReadOnlyOpc } from './OpcReadPackage';
import { SHEET_NS } from './XlsxInventory';
import { xmlAttribute } from './WorkbookXml';
import { xlsxNumberFormat, type XlsxNumberFormat } from './XlsxCell';

export async function readXlsxStyles(pkg: ReadOnlyOpc, part: string | undefined): Promise<XlsxNumberFormat[]> {
  if (!part) return [xlsxNumberFormat(0)];
  const formats = new Map<number, string>(); const bases: number[] = []; const cells: Array<{ id?: number; base?: number; apply?: string }> = []; const path: string[] = [];
  const number = (raw: string | undefined) => raw === undefined ? undefined : /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : NaN;
  await pkg.xml(part, { open(tag) {
    path.push(SHEET_NS.has(tag.uri) ? tag.local : '?');
    if (path.length === 1 && path[0] !== 'styleSheet') throw new Error('invalid-workbook-styles');
    if (!SHEET_NS.has(tag.uri)) return;
    if (path.length === 3 && path[1] === 'numFmts' && tag.local === 'numFmt') {
      const id = number(xmlAttribute(tag, 'numFmtId')); const code = xmlAttribute(tag, 'formatCode');
      if (id === undefined || !Number.isSafeInteger(id) || code === undefined || formats.has(id)) throw new Error('invalid-number-format'); formats.set(id, code);
    }
    if (path.length === 3 && path[1] === 'cellStyleXfs' && tag.local === 'xf') bases.push(number(xmlAttribute(tag, 'numFmtId')) ?? 0);
    if (path.length === 3 && path[1] === 'cellXfs' && tag.local === 'xf') cells.push({ id: number(xmlAttribute(tag, 'numFmtId')), base: number(xmlAttribute(tag, 'xfId')), apply: xmlAttribute(tag, 'applyNumberFormat') });
  }, close() { path.pop(); } });
  return cells.length ? cells.map(cell => {
    const id = cell.apply === '0' || cell.apply === 'false' ? cell.base === undefined ? 0 : bases[cell.base]
      : cell.id ?? (cell.base === undefined ? 0 : bases[cell.base]);
    return id === undefined || !Number.isSafeInteger(id) ? { id: -1, interpretation: 'uninterpreted' } : xlsxNumberFormat(id, formats.get(id));
  }) : [xlsxNumberFormat(0)];
}
