// Excel 4 (XLM) macro sheets in a native recalculation. Owner decision (2026-11-22): a macro sheet alone does not stop
// a recalculation. Excel's AutomationSecurity force-disable does not cover XLM macros, so XLM non-execution is made
// operation-local: the engine's private copy never contains a macro sheet, nor a defined name that lives on one, points
// at one or would run on open (Auto_Open and its kind). The person's own file and their Office settings are untouched.
// A formula that may depend on what was removed is reported unrecalculated (depends-on-macro-sheet), never cached.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { ReadOnlyOpc, opcRelationshipsPart } from '../content/OpcReadPackage';
import { inspectXlsxInventory, SHEET_NS } from '../content/XlsxInventory';
import { xmlAttribute } from '../content/WorkbookXml';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import type { WorkbookRecalcTarget } from './WorkbookRecalcContracts';
import { xlsxFormulaCode } from './XlsxFormulaEffects';
import { editXlsxContentTypes, editXlsxRelationships, readXlsxContentTypes, readXlsxRelationships, XLSX_DOCUMENT_REL, type XlsxRelationships } from './XlsxPackageParts';
import { applyXlsxPatches, scanXlsxXml, xlsxEditOpening, type XlsxXmlPatch } from './XlsxXmlScan';

const MACRO_REL = /\/(?:macrosheet|xlMacrosheet|xlIntlMacrosheet)$/i;
const MACRO_CONTENT = new Set(['application/vnd.ms-excel.macrosheet+xml', 'application/vnd.ms-excel.intlmacrosheet+xml']);
/** Names Excel runs or evaluates on its own when a workbook opens, closes or is activated. */
const AUTO_NAME = /^(?:_xlnm\.)?auto_(?:open|close|activate|deactivate)/i;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A sheet part is an Excel 4 macro sheet by its relationship type or by its declared content type. */
export function isMacroSheetPart(relationshipType: string, contentType: string | undefined): boolean {
  return MACRO_REL.test(relationshipType) || !!contentType && MACRO_CONTENT.has(contentType.toLowerCase());
}
/** Workbook-level relationships of macro sheets (never external). */
export function macroSheetRelationships(rels: XlsxRelationships | undefined, typeOf: (part: string) => string | undefined) {
  return (rels?.items ?? []).filter(item => !item.external && item.part && isMacroSheetPart(item.type, typeOf(item.part)));
}

// --- Formula references, read from text only (string literals removed). Conservative: a superset is fine. ---------------
interface Area { sheet: string; r1: number; c1: number; r2: number; c2: number }
interface FormulaRefs {
  sheets: string[]; areas: Area[]; names: string[];
  /**
   * A reference resolved from text or computed at run time (INDIRECT, EVALUATE) or moved from its base to cells the
   * text does not name (OFFSET, whatever its base, a defined name included): where it leads is not known from the text.
   */
  dynamic: boolean;
  /** Double-quoted string literals, lower case: a sheet named inside one may be reached through text. */
  literals: string[];
}
const DYNAMIC_REFERENCE = /(?:^|[^A-Za-z0-9_.])(?:_xlfn\.)?(?:INDIRECT|EVALUATE|OFFSET)\s*\(/i;
function stringLiterals(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    let value = '';
    for (index++; index < text.length; index++) {
      if (text[index] === '"') { if (text[index + 1] === '"') { value += '"'; index++; continue; } break; }
      value += text[index];
    }
    found.push(value.toLowerCase());
  }
  return found;
}
const MAX_ROW = 1_048_576; const MAX_COLUMN = 16_384;
const IDENT = '[A-Za-z_\\\\\\u00C0-\\uFFFF][\\w.\\u00C0-\\uFFFF]*';
const CELL = '\\$?[A-Za-z]{1,3}\\$?\\d{1,7}';
const AREA = `(?:${CELL}(?::${CELL})?|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}|\\$?\\d{1,7}:\\$?\\d{1,7})`;
const QUALIFIED = new RegExp(`(?:'((?:[^']|'')+)'|(${IDENT}(?::${IDENT})?))!(${AREA}|${IDENT})?`, 'g');
const UNQUALIFIED = new RegExp(`(?<![\\w.\\u00C0-\\uFFFF$])(${AREA})(?![\\w.(\\u00C0-\\uFFFF])`, 'g');
const NAME_TOKEN = new RegExp(IDENT, 'g');
const column = (text: string) => [...text.replaceAll('$', '').toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
function area(sheet: string, text: string): Area | undefined {
  const [a, b = a] = text.replaceAll('$', '').split(':');
  const cell = /^([A-Za-z]{1,3})(\d{1,7})$/;
  const p = cell.exec(a); const q = cell.exec(b);
  if (p && q) return { sheet, r1: Math.min(+p[2], +q[2]), r2: Math.max(+p[2], +q[2]), c1: Math.min(column(p[1]), column(q[1])), c2: Math.max(column(p[1]), column(q[1])) };
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) return { sheet, r1: 1, r2: MAX_ROW, c1: Math.min(column(a), column(b)), c2: Math.max(column(a), column(b)) };
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return { sheet, r1: Math.min(+a, +b), r2: Math.max(+a, +b), c1: 1, c2: MAX_COLUMN };
  return undefined;
}
/** Sheets, areas and identifiers a formula names; `own` is the sheet an unqualified reference means. */
export function formulaReferences(text: string, own: string): FormulaRefs {
  let code = xlsxFormulaCode(text);
  const refs: FormulaRefs = { sheets: [], areas: [], names: [], dynamic: DYNAMIC_REFERENCE.test(code), literals: stringLiterals(text) };
  code = code.replace(QUALIFIED, (_match, quoted: string | undefined, bare: string | undefined, target: string | undefined) => {
    const sheets = (quoted !== undefined ? quoted.replaceAll("''", "'") : bare!).split(':').map(name => name.toLowerCase());
    refs.sheets.push(...sheets);
    if (target) {
      const found = area(sheets[0], target);
      if (found) for (const sheet of sheets) refs.areas.push({ ...found, sheet }); else refs.names.push(target.toLowerCase());
    }
    return ' ';
  });
  code = code.replace(UNQUALIFIED, (_match, target: string) => { const found = area(own, target); if (found) refs.areas.push(found); return ' '; });
  for (const match of code.matchAll(NAME_TOKEN)) refs.names.push(match[0].toLowerCase().replace(/^_xlnm\./, ''));
  return refs;
}
const overlaps = (a: Area, b: Area) => a.sheet === b.sheet && a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

/**
 * Which formulas may depend on removed macro sheets or names: those naming a macro sheet or a removed name, then, until
 * nothing changes, those naming a cell area or a name that does. A shared or array formula counts for its whole range.
 */
export class MacroSheetDependencies {
  private readonly formulas: Array<{ area: Area; refs: FormulaRefs; tainted: boolean }> = [];
  private readonly names = new Map<string, { refs: FormulaRefs[]; tainted: boolean }>();
  private readonly tainted: Area[] = [];
  private readonly removedNames = new Set<string>();
  constructor(private readonly macroSheets: ReadonlySet<string>) {}
  /** A defined name the engine's copy drops; formulas naming it depend on the macro sheets. */
  removedName(name: string): void { this.removedNames.add(name.toLowerCase().replace(/^_xlnm\./, '')); }
  /** A worksheet formula at `cell` (or covering `range` for a shared/array master). */
  formula(sheet: string, text: string, cell: { row: number; column: number }, range?: string): void {
    const own = sheet.toLowerCase(); const covered = range ? area(own, range) : undefined;
    const refs = formulaReferences(text, own);
    // A shared formula's later cells shift its relative references down and right: widen them by the range.
    if (covered) for (const item of refs.areas) { item.r2 = Math.min(MAX_ROW, item.r2 + covered.r2 - covered.r1); item.c2 = Math.min(MAX_COLUMN, item.c2 + covered.c2 - covered.c1); }
    this.formulas.push({ area: covered ?? { sheet: own, r1: cell.row, r2: cell.row, c1: cell.column, c2: cell.column }, refs, tainted: false });
  }
  definedName(name: string, text: string): void {
    const key = name.toLowerCase().replace(/^_xlnm\./, ''); const entry = this.names.get(key) ?? { refs: [], tainted: false };
    entry.refs.push(formulaReferences(text, '')); this.names.set(key, entry);
  }
  private reaches(refs: FormulaRefs): boolean {
    // With a macro sheet left out of the copy, a reference built from text, at run time or by OFFSET may lead into it
    // or to a dependent cell, and a macro sheet named inside a string may be reached through text: all count as dependent.
    return refs.dynamic || refs.literals.some(literal => [...this.macroSheets].some(sheet => literal.includes(sheet)))
      || refs.sheets.some(sheet => this.macroSheets.has(sheet)) || refs.names.some(name => this.removedNames.has(name) || this.names.get(name)?.tainted === true)
      || refs.areas.some(item => this.tainted.some(bad => overlaps(item, bad)));
  }
  /** Settles the dependency closure; past `maxPasses` every formula that names anything is treated as dependent. */
  settle(maxPasses = 64): void {
    for (let pass = 0, changed = true; changed; pass++) {
      changed = false;
      if (pass >= maxPasses) {
        for (const formula of this.formulas) if (!formula.tainted && (formula.refs.areas.length || formula.refs.names.length || formula.refs.sheets.length)) { formula.tainted = true; this.tainted.push(formula.area); }
        return;
      }
      for (const entry of this.names.values()) if (!entry.tainted && entry.refs.some(refs => this.reaches(refs))) { entry.tainted = true; changed = true; }
      for (const formula of this.formulas) if (!formula.tainted && this.reaches(formula.refs)) { formula.tainted = true; this.tainted.push(formula.area); changed = true; }
    }
  }
  dependent(sheet: string, cell: { row: number; column: number }): boolean {
    const point = { sheet: sheet.toLowerCase(), r1: cell.row, r2: cell.row, c1: cell.column, c2: cell.column };
    return this.tainted.some(bad => overlaps(point, bad));
  }
}

/** Defined names that the engine's copy drops: on a macro sheet, naming one, or run by Excel on its own. */
export function removedDefinedName(name: { name: string; localSheetId?: number; text: string }, macroIndexes: ReadonlySet<number>, macroNames: ReadonlySet<string>): boolean {
  if (AUTO_NAME.test(name.name)) return true;
  if (name.localSheetId !== undefined && macroIndexes.has(name.localSheetId)) return true;
  return formulaReferences(name.text, '').sheets.some(sheet => macroNames.has(sheet));
}

export interface MacroSheetStrip { bytes: Uint8Array; sha256: string; removed_sheets: string[]; removed_names: string[]; targets: WorkbookRecalcTarget[] }

/**
 * The engine's private copy without macro sheets. Removes each macro sheet part, its relationships, its workbook
 * <sheet> entry and content-type override, the defined names `removedDefinedName` selects and the calculation chain
 * (rebuilt by the engine). Later sheets' localSheetId and the window's tab indexes follow the removal; target positions
 * are returned for the copy. The result is reopened and checked before it is returned. A workbook without a macro sheet
 * is returned byte for byte.
 */
export async function stripMacroSheetsForEngine(input: { source: string; sourceSha256: string; directory: string; targets: WorkbookRecalcTarget[] },
  ratio: number, floor: number, progress: () => void): Promise<MacroSheetStrip> {
  const source = await readFile(input.source); if (sha(source) !== input.sourceSha256) throw new WorkbookEditFailure('source-changed');
  const pkg = await ReadOnlyOpc.open(input.source, ratio, floor, progress);
  const bytesOf = async (part: string) => { const chunks: Buffer[] = []; for await (const chunk of pkg.bytes(part)) { chunks.push(Buffer.from(chunk)); progress(); } return Buffer.concat(chunks); };
  let output: Buffer; let removedSheets: string[]; let removedNames: string[]; let removedPositions: number[];
  try {
    let inventory: Awaited<ReturnType<typeof inspectXlsxInventory>>;
    try { inventory = await inspectXlsxInventory(pkg); } catch { throw new WorkbookEditFailure('unsupported-workbook-package'); }
    const workbook = inventory.workbookPart; const relsPart = opcRelationshipsPart(workbook);
    const types = readXlsxContentTypes(await bytesOf('/[Content_Types].xml'), progress);
    const rels = pkg.has(relsPart) ? readXlsxRelationships(await bytesOf(relsPart), workbook, progress) : undefined;
    const macroRels = macroSheetRelationships(rels, part => types.typeOf(part));
    if (!macroRels.length) return { bytes: source, sha256: input.sourceSha256, removed_sheets: [], removed_names: [], targets: input.targets };
    const macroIds = new Set(macroRels.map(item => item.id));
    const value = decodeOfficeXml(await bytesOf(workbook));
    const sheets: Array<{ name: string; macro: boolean; start: number; end: number }> = [];
    const names: Array<{ name: string; localSheetId?: number; text: string; start: number; end: number; openEnd: number; opening: string }> = [];
    const views: Array<{ start: number; openEnd: number; activeTab?: number; firstSheet?: number }> = [];
    scanXlsxXml(value, progress, {
      open: (tag, parents) => parents.length === 2 && SHEET_NS.has(tag.uri) && tag.local === 'definedName' ? true : undefined,
      close: node => {
        if (node.parents.length !== 2 || !SHEET_NS.has(node.tag.uri)) return;
        const parent = node.parents[1].local;
        if (parent === 'sheets' && node.tag.local === 'sheet') {
          const id = XLSX_DOCUMENT_REL.map(base => xmlAttribute(node.tag, 'id', base.slice(0, -1))).find(item => item !== undefined);
          sheets.push({ name: xmlAttribute(node.tag, 'name') ?? '', macro: id !== undefined && macroIds.has(id), start: node.start, end: node.end });
        } else if (parent === 'definedNames' && node.tag.local === 'definedName') {
          const local = xmlAttribute(node.tag, 'localSheetId');
          names.push({ name: xmlAttribute(node.tag, 'name') ?? '', ...(local !== undefined && /^\d+$/.test(local) ? { localSheetId: Number(local) } : {}), text: node.text ?? '',
            start: node.start, end: node.end, openEnd: node.openEnd, opening: value.xml.slice(node.start, node.openEnd) });
        } else if (parent === 'bookViews' && node.tag.local === 'workbookView') {
          const tab = xmlAttribute(node.tag, 'activeTab'); const first = xmlAttribute(node.tag, 'firstSheet');
          views.push({ start: node.start, openEnd: node.openEnd, ...(tab && /^\d+$/.test(tab) ? { activeTab: Number(tab) } : {}), ...(first && /^\d+$/.test(first) ? { firstSheet: Number(first) } : {}) });
        }
      },
    });
    const macroIndexes = new Set(sheets.flatMap((sheet, index) => sheet.macro ? [index] : []));
    if (!macroIndexes.size || macroIndexes.size === sheets.length) throw new WorkbookEditFailure('workbook-structure-unsupported');
    const macroNames = new Set(sheets.filter(sheet => sheet.macro).map(sheet => sheet.name.toLowerCase()));
    const shift = (index: number) => index - [...macroIndexes].filter(removed => removed < index).length;
    const patches: XlsxXmlPatch[] = sheets.filter(sheet => sheet.macro).map(sheet => ({ start: sheet.start, end: sheet.end, text: '' }));
    removedNames = [];
    for (const name of names) {
      if (removedDefinedName(name, macroIndexes, macroNames)) { patches.push({ start: name.start, end: name.end, text: '' }); removedNames.push(name.name); continue; }
      if (name.localSheetId !== undefined && shift(name.localSheetId) !== name.localSheetId) {
        patches.push({ start: name.start, end: name.openEnd, text: xlsxEditOpening(name.opening, { localSheetId: String(shift(name.localSheetId)) }) });
      }
    }
    const kept = sheets.length - macroIndexes.size;
    for (const view of views) {
      const opening = value.xml.slice(view.start, view.openEnd); const set: Record<string, string> = {};
      for (const key of ['activeTab', 'firstSheet'] as const) {
        const index = view[key]; if (index === undefined) continue;
        const next = macroIndexes.has(index) ? 0 : Math.min(shift(index), kept - 1); if (next !== index) set[key] = String(next);
      }
      if (Object.keys(set).length) patches.push({ start: view.start, end: view.openEnd, text: xlsxEditOpening(opening, set) });
    }
    patches.sort((a, b) => a.start - b.start);
    const chain = (rels?.items ?? []).filter(item => item.kind === 'calcChain' && item.part && !item.external);
    const removedParts = new Set<string>([...macroRels, ...chain].map(item => item.part!));
    // A macro-sheet part no relationship names is not loaded, but it is not carried into the engine's copy either.
    for (const name of pkg.names()) if (isMacroSheetPart('', types.typeOf(name))) removedParts.add(name);
    for (const part of [...removedParts]) if (pkg.has(opcRelationshipsPart(part))) removedParts.add(opcRelationshipsPart(part));
    const changed = new Map<string, Buffer>([
      [workbook, applyXlsxPatches(value, patches)],
      [relsPart, editXlsxRelationships(rels!, [...macroIds, ...chain.map(item => item.id)], [])],
      ['/[Content_Types].xml', editXlsxContentTypes(types, [...removedParts], [])],
    ]);
    const zip = await JSZip.loadAsync(source, { createFolders: false });
    const members = [...removedParts].filter(part => pkg.has(part)).map(part => pkg.memberName(part));
    for (const member of members) zip.remove(member);
    // A folder entry left empty by the removal goes too (xl/macrosheets/).
    for (const folder of new Set(members.map(member => member.slice(0, member.lastIndexOf('/') + 1)).filter(Boolean))) {
      if (zip.files[folder]?.dir && !Object.keys(zip.files).some(name => name !== folder && name.startsWith(folder))) zip.remove(folder);
    }
    for (const [part, bytes] of changed) zip.file(pkg.memberName(part), bytes);
    output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress());
    removedSheets = sheets.filter(sheet => sheet.macro).map(sheet => sheet.name);
    removedPositions = [...macroIndexes].map(index => index + 1);
  } finally { pkg.close(); }
  // Read the copy back: it opens, holds no macro sheet and keeps every other sheet in order.
  const file = join(input.directory, `recalc-engine-copy-${randomUUID()}.xlsx`); await writeFile(file, output, { flag: 'wx', mode: 0o600 });
  const check = await ReadOnlyOpc.open(file, ratio, floor, progress);
  try {
    const inventory = await inspectXlsxInventory(check);
    const checkTypes = readXlsxContentTypes(await (async () => { const chunks: Buffer[] = []; for await (const chunk of check.bytes('/[Content_Types].xml')) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); })(), progress);
    const relsPart = opcRelationshipsPart(inventory.workbookPart);
    const checkRels = check.has(relsPart) ? readXlsxRelationships(await (async () => { const chunks: Buffer[] = []; for await (const chunk of check.bytes(relsPart)) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); })(), inventory.workbookPart, progress) : undefined;
    if (macroSheetRelationships(checkRels, part => checkTypes.typeOf(part)).length || check.names().some(name => isMacroSheetPart('', checkTypes.typeOf(name)))
      || inventory.sheets.some(sheet => removedSheets.includes(sheet.name))) throw new WorkbookEditFailure('workbook-output-check-failed');
  } catch (error) { throw error instanceof WorkbookEditFailure ? error : new WorkbookEditFailure('workbook-output-check-failed'); } finally { check.close(); }
  const targets = input.targets.map(target => removedPositions.includes(target.position) ? target
    : { ...target, position: target.position - removedPositions.filter(position => position < target.position).length });
  return { bytes: output, sha256: sha(output), removed_sheets: removedSheets, removed_names: removedNames, targets };
}
