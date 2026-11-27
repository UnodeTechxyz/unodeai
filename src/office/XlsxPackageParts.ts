import { opcPartName, opcRelationshipTarget } from '../content/OpcReadPackage';
import { SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute } from '../content/WorkbookXml';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import { scanXlsxXml, applyXlsxPatches, xlsxEditOpening, xlsxXmlAttributeValue, type XlsxXmlText } from './XlsxXmlScan';

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const XLSX_DOCUMENT_REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/', 'http://purl.oclc.org/ooxml/officeDocument/relationships/'];
export const xlsxRelationshipKind = (type: string) => XLSX_DOCUMENT_REL.some(base => type.startsWith(base)) ? type.slice(type.lastIndexOf('/') + 1) : undefined;
interface Span { start: number; end: number }

export interface XlsxContentTypes { value: XlsxXmlText; overrides: Array<Span & { part: string; type: string }>; defaults: Map<string, string>; closeStart: number; prefix: string;
  typeOf(part: string): string | undefined }
export function readXlsxContentTypes(bytes: Buffer, progress: () => void): XlsxContentTypes {
  const value = decodeOfficeXml(bytes); const overrides: XlsxContentTypes['overrides'] = []; const defaults = new Map<string, string>(); let closeStart = -1; let prefix = '';
  scanXlsxXml(value, progress, { close: node => {
    if (!node.parents.length) { if (node.tag.uri !== CT || node.tag.local !== 'Types' || node.tag.isSelfClosing) throw new WorkbookEditFailure('unsupported-workbook-package'); closeStart = node.closeStart; prefix = node.tag.prefix ? node.tag.prefix + ':' : ''; return; }
    if (node.parents.length !== 1 || node.tag.uri !== CT) return;
    const type = xmlAttribute(node.tag, 'ContentType')?.toLowerCase(); if (!type) throw new WorkbookEditFailure('unsupported-workbook-package');
    if (node.tag.local === 'Override') { const name = xmlAttribute(node.tag, 'PartName'); if (!name) throw new WorkbookEditFailure('unsupported-workbook-package'); overrides.push({ part: opcPartName(name), type, start: node.start, end: node.end }); }
    if (node.tag.local === 'Default') { const extension = xmlAttribute(node.tag, 'Extension')?.toLowerCase(); if (extension) defaults.set(extension, type); }
  } });
  return { value, overrides, defaults, closeStart, prefix,
    typeOf: part => overrides.find(item => item.part === opcPartName(part))?.type ?? defaults.get(part.slice(part.lastIndexOf('.') + 1).toLowerCase()) };
}

export interface XlsxRelationship extends Span { id: string; type: string; kind?: string; external: boolean; part?: string }
export interface XlsxRelationships { value: XlsxXmlText; items: XlsxRelationship[]; root: Span & { openEnd: number; closeStart: number; selfClosing: boolean; prefix: string } }
export function readXlsxRelationships(bytes: Buffer, source: string, progress: () => void): XlsxRelationships {
  const value = decodeOfficeXml(bytes); const items: XlsxRelationship[] = []; let root: XlsxRelationships['root'] | undefined;
  scanXlsxXml(value, progress, { close: node => {
    if (!node.parents.length) {
      if (node.tag.uri !== PKG || node.tag.local !== 'Relationships') throw new WorkbookEditFailure('unsupported-workbook-package');
      root = { start: node.start, end: node.end, openEnd: node.openEnd, closeStart: node.closeStart, selfClosing: node.tag.isSelfClosing, prefix: node.tag.prefix ? node.tag.prefix + ':' : '' }; return;
    }
    if (node.parents.length !== 1 || node.tag.uri !== PKG || node.tag.local !== 'Relationship') return;
    const id = xmlAttribute(node.tag, 'Id'); const type = xmlAttribute(node.tag, 'Type'); const target = xmlAttribute(node.tag, 'Target'); const external = xmlAttribute(node.tag, 'TargetMode') === 'External';
    if (!id || !type || target === undefined) throw new WorkbookEditFailure('unsupported-workbook-package');
    let part: string | undefined; if (!external) { try { part = opcRelationshipTarget(source === '/' ? '/' : source, target); } catch { part = undefined; } }
    items.push({ id, type, kind: xlsxRelationshipKind(type), external, start: node.start, end: node.end, ...(part ? { part } : {}) });
  } });
  if (!root) throw new WorkbookEditFailure('unsupported-workbook-package');
  return { value, items, root };
}
/** Remove listed elements and append new ones; every other relationship keeps its exact text. */
export function editXlsxRelationships(rels: XlsxRelationships, remove: readonly string[], add: Array<{ id: string; type: string; target: string }>): Buffer {
  const patches = rels.items.filter(item => remove.includes(item.id)).map(item => ({ start: item.start, end: item.end, text: '' }));
  if (add.length) {
    const text = add.map(item => `<${rels.root.prefix}Relationship Id="${xlsxXmlAttributeValue(item.id)}" Type="${xlsxXmlAttributeValue(item.type)}" Target="${xlsxXmlAttributeValue(item.target)}"/>`).join('');
    if (rels.root.selfClosing) {
      const opening = rels.value.xml.slice(rels.root.start, rels.root.end);
      patches.push({ start: rels.root.start, end: rels.root.end, text: `${xlsxEditOpening(opening, {}, false)}${text}</${rels.root.prefix}Relationships>` });
    } else patches.push({ start: rels.root.closeStart, end: rels.root.closeStart, text });
  }
  return applyXlsxPatches(rels.value, patches);
}
export function editXlsxContentTypes(types: XlsxContentTypes, remove: readonly string[], add: Array<{ part: string; type: string }>, retype: Array<{ part: string; type: string }> = []): Buffer {
  const patches = types.overrides.filter(item => remove.includes(item.part)).map(item => ({ start: item.start, end: item.end, text: '' }));
  for (const change of retype) {
    const item = types.overrides.find(override => override.part === opcPartName(change.part)); if (!item) throw new WorkbookEditFailure('unsupported-workbook-package');
    const source = types.value.xml.slice(item.start, item.end); const openEnd = source.indexOf('>') + 1;
    patches.push({ start: item.start, end: item.start + openEnd, text: xlsxEditOpening(source.slice(0, openEnd), { ContentType: change.type }) });
  }
  if (add.length) patches.push({ start: types.closeStart, end: types.closeStart,
    text: add.map(item => `<${types.prefix}Override PartName="${xlsxXmlAttributeValue(item.part)}" ContentType="${xlsxXmlAttributeValue(item.type)}"/>`).join('') });
  return applyXlsxPatches(types.value, patches);
}

/** Children of workbook that the schema places after calcPr; a new calcPr goes before the first of them. */
const AFTER_CALC = new Set(['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']);
export interface XlsxWorkbookCalc { calcMode?: string; fullCalcOnLoad?: string }
export function readXlsxWorkbookCalc(bytes: Buffer, progress: () => void): XlsxWorkbookCalc {
  const value = decodeOfficeXml(bytes); let result: XlsxWorkbookCalc = {};
  scanXlsxXml(value, progress, { open: (tag, parents) => {
    if (parents.length === 1 && SHEET_NS.has(tag.uri) && tag.local === 'calcPr') result = { calcMode: xmlAttribute(tag, 'calcMode'), fullCalcOnLoad: xmlAttribute(tag, 'fullCalcOnLoad') };
  } });
  return result;
}
/** Ask the application to recalculate on open; the user's calculation mode and other settings stay unchanged. */
export function setXlsxFullCalcOnLoad(bytes: Buffer, progress: () => void): { bytes: Buffer; calcMode?: string } {
  const value = decodeOfficeXml(bytes); let calc: { start: number; openEnd: number; calcMode?: string } | undefined;
  let insertAt: number | undefined; let rootClose = -1; let prefix = '';
  scanXlsxXml(value, progress, {
    open: (tag, parents, start, openEnd) => {
      if (!parents.length) { if (!SHEET_NS.has(tag.uri) || tag.local !== 'workbook') throw new WorkbookEditFailure('unsupported-workbook-package'); prefix = tag.prefix ? tag.prefix + ':' : ''; }
      if (parents.length !== 1) return;
      if (SHEET_NS.has(tag.uri) && tag.local === 'calcPr') calc = { start, openEnd, calcMode: xmlAttribute(tag, 'calcMode') };
      else if (insertAt === undefined && SHEET_NS.has(tag.uri) && AFTER_CALC.has(tag.local)) insertAt = start;
    },
    close: node => { if (!node.parents.length) rootClose = node.closeStart; },
  });
  if (calc) {
    const opening = value.xml.slice(calc.start, calc.openEnd);
    return { bytes: applyXlsxPatches(value, [{ start: calc.start, end: calc.openEnd, text: xlsxEditOpening(opening, { fullCalcOnLoad: '1' }) }]), ...(calc.calcMode ? { calcMode: calc.calcMode } : {}) };
  }
  const at = insertAt ?? rootClose; if (at < 0) throw new WorkbookEditFailure('unsupported-workbook-package');
  return { bytes: applyXlsxPatches(value, [{ start: at, end: at, text: `<${prefix}calcPr fullCalcOnLoad="1"/>` }]) };
}
