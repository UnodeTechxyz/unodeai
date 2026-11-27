import { ReadOnlyOpc, opcPartName, opcRelationshipTarget, opcRelationshipsPart } from './OpcReadPackage';
import { xmlAttribute, spreadsheetString } from './WorkbookXml';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCUMENT = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/', 'http://purl.oclc.org/ooxml/officeDocument/relationships/'];
export const SHEET_NS = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']);
const MAIN_TYPES = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'application/vnd.ms-excel.sheet.macroenabled.main+xml', 'application/vnd.ms-excel.template.macroenabled.main+xml']);
interface Relationship { id: string; type: string; external: boolean; part?: string }
export interface XlsxSheetInfo { sheetId: string; position: number; name: string; state: 'visible' | 'hidden' | 'veryHidden'; kind: string; part?: string; gap?: string }
export interface XlsxInventory { format: 'xlsx'; workbookPart: string; date1904: boolean; sheets: XlsxSheetInfo[]; sharedStringsPart?: string;
  stylesPart?: string; externalLinksPresent: boolean; macroContentPresent: boolean; calculation: Record<string, string>; cache: 'saved-results-not-recalculated' }
async function types(pkg: ReadOnlyOpc) {
  const defaults = new Map<string, string>(); const overrides = new Map<string, string>(); let root = false; let depth = 0;
  await pkg.xml('/[Content_Types].xml', { open(tag) {
    depth++;
    if (depth === 1) { if (tag.local !== 'Types' || tag.uri !== CT) throw new Error('invalid-office-content-types'); root = true; }
    if (depth !== 2 || tag.uri !== CT) return;
    const mime = xmlAttribute(tag, 'ContentType'); if (!mime) throw new Error('invalid-office-content-types');
    if (tag.local === 'Default') { const extension = xmlAttribute(tag, 'Extension')?.toLowerCase(); if (!extension || defaults.has(extension)) throw new Error('ambiguous-office-content-type'); defaults.set(extension, mime.toLowerCase()); }
    if (tag.local === 'Override') { const part = xmlAttribute(tag, 'PartName'); if (!part) throw new Error('invalid-office-content-types'); const key = opcPartName(part);
      if (overrides.has(key)) throw new Error('ambiguous-office-content-type'); overrides.set(key, mime.toLowerCase()); }
  }, close() { depth--; } });
  if (!root) throw new Error('missing-office-content-types');
  return (part: string) => overrides.get(opcPartName(part)) ?? defaults.get(part.slice(part.lastIndexOf('.') + 1).toLowerCase());
}
async function relationships(pkg: ReadOnlyOpc, source: string): Promise<Map<string, Relationship>> {
  const file = source === '/' ? '/_rels/.rels' : opcRelationshipsPart(source); const result = new Map<string, Relationship>(); let depth = 0;
  await pkg.xml(file, { open(tag) { depth++;
    if (depth === 1 && (tag.local !== 'Relationships' || tag.uri !== REL)) throw new Error('invalid-office-relationships');
    if (depth !== 2 || tag.uri !== REL || tag.local !== 'Relationship') return;
    const id = xmlAttribute(tag, 'Id'); const type = xmlAttribute(tag, 'Type'); const target = xmlAttribute(tag, 'Target'); const mode = xmlAttribute(tag, 'TargetMode');
    if (!id || !type || target === undefined || result.has(id) || (mode !== undefined && mode !== 'External' && mode !== 'Internal')) throw new Error('invalid-office-relationship');
    const external = mode === 'External'; result.set(id, { id, type, external, ...(external ? {} : { part: opcRelationshipTarget(source, target) }) });
  }, close() { depth--; } }); return result;
}
const relationshipKind = (type: string) => DOCUMENT.find(base => type.startsWith(base)) ? type.slice(type.lastIndexOf('/') + 1) : undefined;
/** Selected package/relationship checks, not a complete ECMA schema validator or application open test. */
export async function inspectXlsxInventory(pkg: ReadOnlyOpc): Promise<XlsxInventory> {
  const contentType = await types(pkg); const roots = [...(await relationships(pkg, '/')).values()].filter(rel => relationshipKind(rel.type) === 'officeDocument');
  if (roots.length !== 1 || roots[0].external || !roots[0].part || !MAIN_TYPES.has(contentType(roots[0].part) ?? '')) throw new Error('unsupported-workbook-package');
  const main = roots[0].part; const rels = await relationships(pkg, main); const sheets: XlsxSheetInfo[] = []; let date1904 = false; let depth = 0; let root = false;
  const calculation: Record<string, string> = {}; let externalReference = false;
  await pkg.xml(main, { open(tag) { depth++;
    if (depth === 1) { if (tag.local !== 'workbook' || !SHEET_NS.has(tag.uri)) throw new Error('invalid-workbook-root'); root = true; }
    if (!SHEET_NS.has(tag.uri)) return;
    if (tag.local === 'workbookPr' && depth === 2) { const value = xmlAttribute(tag, 'date1904'); if (value !== undefined && !['0', '1', 'true', 'false'].includes(value)) throw new Error('invalid-workbook-epoch'); date1904 = value === '1' || value === 'true'; }
    if (tag.local === 'calcPr' && depth === 2) for (const name of ['calcId', 'calcMode', 'fullCalcOnLoad', 'forceFullCalc', 'iterate']) { const value = xmlAttribute(tag, name); if (value !== undefined) calculation[name] = value; }
    if (tag.local === 'externalReference') externalReference = true;
    if (tag.local === 'sheet' && depth === 3) {
      const name = xmlAttribute(tag, 'name'); const state = xmlAttribute(tag, 'state') ?? 'visible';
      const relationshipId = DOCUMENT.map(base => xmlAttribute(tag, 'id', base.slice(0, -1))).find(value => value !== undefined);
      if (name === undefined || !['visible', 'hidden', 'veryHidden'].includes(state)) throw new Error('invalid-workbook-sheet');
      const relationship = relationshipId === undefined ? undefined : rels.get(relationshipId); const kind = relationship ? relationshipKind(relationship.type) ?? 'unknown' : 'unknown';
      const gap = !relationship ? 'missing-sheet-relationship' : relationship.external ? 'external-sheet-target-not-read'
        : !relationship.part || !pkg.has(relationship.part) ? 'missing-sheet-part' : !['worksheet', 'chartsheet', 'dialogsheet', 'macrosheet'].includes(kind) ? 'unsupported-sheet-relationship' : undefined;
      const contentGap = !gap && kind === 'worksheet' && contentType(relationship!.part!) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
        ? 'worksheet-content-type-mismatch' : undefined;
      sheets.push({ sheetId: `sheet-${sheets.length + 1}`, position: sheets.length + 1, name: spreadsheetString(name).text, state: state as XlsxSheetInfo['state'], kind,
        ...(relationship?.part ? { part: relationship.part } : {}), ...(gap || contentGap ? { gap: gap ?? contentGap } : {}) });
    }
  }, close() { depth--; } });
  if (!root) throw new Error('missing-workbook-root');
  const partFor = (kind: string) => {
    const found = [...rels.values()].filter(rel => relationshipKind(rel.type) === kind);
    if (found.length > 1 || found.some(rel => rel.external)) throw new Error('ambiguous-workbook-metadata');
    const part = found[0]?.part;
    if (part && contentType(part) !== `application/vnd.openxmlformats-officedocument.spreadsheetml.${kind.toLowerCase()}+xml`) throw new Error('workbook-metadata-content-type-mismatch');
    return part;
  };
  return { format: 'xlsx', workbookPart: main, date1904, sheets, sharedStringsPart: partFor('sharedStrings'), stylesPart: partFor('styles'), calculation,
    externalLinksPresent: externalReference || [...rels.values()].some(rel => relationshipKind(rel.type) === 'externalLink'),
    macroContentPresent: [...rels.values()].some(rel => relationshipKind(rel.type) === 'vbaProject') || [...rels.values()].some(rel => /\/vbaProject$/.test(rel.type)), cache: 'saved-results-not-recalculated' };
}
