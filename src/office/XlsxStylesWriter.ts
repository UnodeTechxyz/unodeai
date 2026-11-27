import { SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute } from '../content/WorkbookXml';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import { scanXlsxXml, applyXlsxPatches, xlsxEditOpening, xlsxXmlAttributeValue, type XlsxXmlText, type XlsxXmlPatch } from './XlsxXmlScan';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
/** Built-in codes whose display does not depend on the user's locale; date built-ins (14-22) do, so dates get their own code. */
export const XLSX_BUILTIN_NUMBER_FORMATS: ReadonlyMap<string, number> = new Map([['General', 0], ['0', 1], ['0.00', 2], ['#,##0', 3], ['#,##0.00', 4],
  ['0%', 9], ['0.00%', 10], ['0.00E+00', 11], ['# ?/?', 12], ['# ??/??', 13], ['mm:ss', 45], ['[h]:mm:ss', 46], ['mmss.0', 47], ['##0.0E+0', 48], ['@', 49]]);
export const XLSX_MINIMAL_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>`
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

interface Element { start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean; prefix: string }
/** Appends number formats and cell formats; every existing style record keeps its source text and index. */
export class XlsxStylesWriter {
  private readonly value: XlsxXmlText; private readonly formats = new Map<number, string>(); private readonly xfs: Array<{ start: number; end: number; numFmtId?: number; applied: boolean }> = [];
  private root?: Element; private numFmts?: Element; private cellXfs?: Element;
  private readonly addedFormats: Array<{ id: number; code: string }> = []; private readonly addedXfs: string[] = [];
  private readonly pairs = new Map<string, number>(); readonly created: boolean;
  constructor(bytes: Buffer | undefined, progress: () => void) {
    this.created = !bytes; this.value = decodeOfficeXml(bytes ?? Buffer.from(XLSX_MINIMAL_STYLES));
    const element = (node: { start: number; openEnd: number; closeStart: number; end: number; tag: { isSelfClosing: boolean; prefix: string } }): Element =>
      ({ start: node.start, openEnd: node.openEnd, closeStart: node.closeStart, end: node.end, selfClosing: node.tag.isSelfClosing, prefix: node.tag.prefix ? node.tag.prefix + ':' : '' });
    scanXlsxXml(this.value, progress, { close: node => {
      const depth = node.parents.length; const own = SHEET_NS.has(node.tag.uri);
      if (depth === 0) { if (!own || node.tag.local !== 'styleSheet') throw new WorkbookEditFailure('workbook-structure-unsupported'); this.root = element(node); return; }
      if (!own) return;
      if (depth === 1 && node.tag.local === 'numFmts') this.numFmts = element(node);
      if (depth === 1 && node.tag.local === 'cellXfs') this.cellXfs = element(node);
      if (depth === 2 && node.parents[1].local === 'numFmts' && node.tag.local === 'numFmt') {
        const id = Number(xmlAttribute(node.tag, 'numFmtId')); const code = xmlAttribute(node.tag, 'formatCode');
        if (Number.isSafeInteger(id) && code !== undefined) this.formats.set(id, code);
      }
      if (depth === 2 && node.parents[1].local === 'cellXfs' && node.tag.local === 'xf') {
        const raw = xmlAttribute(node.tag, 'numFmtId'); const apply = xmlAttribute(node.tag, 'applyNumberFormat');
        this.xfs.push({ start: node.start, end: node.end, applied: apply !== '0' && apply !== 'false', ...(raw !== undefined && /^\d+$/.test(raw) ? { numFmtId: Number(raw) } : {}) });
      }
    } });
    if (!this.root || !this.cellXfs || !this.xfs.length) throw new WorkbookEditFailure('workbook-structure-unsupported');
  }
  get numberFormatsAdded(): number { return this.addedFormats.length; }
  get stylesAdded(): number { return this.addedXfs.length; }
  /** The cell format id of the base format with this number format; one appended record per request-wide combination. */
  styleFor(base: number, code: string): number {
    const baseIndex = base >= 0 && base < this.xfs.length ? base : 0; const key = JSON.stringify([baseIndex, code]);
    const known = this.pairs.get(key); if (known !== undefined) return known;
    const id = this.formatId(code);
    if (this.xfs[baseIndex].numFmtId === id && this.xfs[baseIndex].applied && base === baseIndex) { this.pairs.set(key, baseIndex); return baseIndex; }
    const source = this.value.xml.slice(this.xfs[baseIndex].start, this.xfs[baseIndex].end); const openEnd = source.indexOf('>') + 1;
    const opening = xlsxEditOpening(source.slice(0, openEnd), { numFmtId: String(id), applyNumberFormat: '1' });
    this.addedXfs.push(opening + source.slice(openEnd)); const index = this.xfs.length + this.addedXfs.length - 1; this.pairs.set(key, index); return index;
  }
  private formatId(code: string): number {
    const builtin = XLSX_BUILTIN_NUMBER_FORMATS.get(code); if (builtin !== undefined) return builtin;
    for (const [id, existing] of this.formats) if (existing === code) return id;
    const added = this.addedFormats.find(format => format.code === code); if (added) return added.id;
    const id = Math.max(163, ...this.formats.keys(), ...this.addedFormats.map(format => format.id)) + 1;
    this.addedFormats.push({ id, code }); return id;
  }
  /** Changed part bytes, or undefined when nothing was appended to an existing part. */
  finish(): Buffer | undefined {
    if (!this.created && !this.addedXfs.length && !this.addedFormats.length) return undefined;
    const patches: XlsxXmlPatch[] = []; const xml = this.value.xml; const root = this.root!; const cellXfs = this.cellXfs!;
    if (this.addedFormats.length) {
      const entries = (prefix: string) => this.addedFormats.map(format => `<${prefix}numFmt numFmtId="${format.id}" formatCode="${xlsxXmlAttributeValue(format.code)}"/>`).join('');
      const count = String(this.formats.size + this.addedFormats.length);
      if (this.numFmts) {
        const opening = xml.slice(this.numFmts.start, this.numFmts.openEnd);
        if (this.numFmts.selfClosing) patches.push({ start: this.numFmts.start, end: this.numFmts.end, text: `${xlsxEditOpening(opening, { count }, false)}${entries(this.numFmts.prefix)}</${this.numFmts.prefix}numFmts>` });
        else { patches.push({ start: this.numFmts.start, end: this.numFmts.openEnd, text: xlsxEditOpening(opening, { count }) }); patches.push({ start: this.numFmts.closeStart, end: this.numFmts.closeStart, text: entries(this.numFmts.prefix) }); }
      } else patches.push({ start: root.openEnd, end: root.openEnd, text: `<${root.prefix}numFmts count="${count}">${entries(root.prefix)}</${root.prefix}numFmts>` });
    }
    if (this.addedXfs.length) {
      const opening = xml.slice(cellXfs.start, cellXfs.openEnd);
      patches.push({ start: cellXfs.start, end: cellXfs.openEnd, text: xlsxEditOpening(opening, { count: String(this.xfs.length + this.addedXfs.length) }) });
      patches.push({ start: cellXfs.closeStart, end: cellXfs.closeStart, text: this.addedXfs.join('') });
    }
    return applyXlsxPatches(this.value, patches);
  }
}
