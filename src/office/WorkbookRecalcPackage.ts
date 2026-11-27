// Fixed worker steps around a native recalculation: a passive scan before it, a read of its copy after it, and the
// cache write-back. Nothing here evaluates a formula, refreshes a link or starts an application.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { ReadOnlyOpc, opcPartName, opcRelationshipsPart } from '../content/OpcReadPackage';
import { inspectXlsxInventory, SHEET_NS } from '../content/XlsxInventory';
import { parseXlsxSnapshot } from '../content/XlsxWorkbook';
import { XlsxPointReader } from '../content/XlsxPointReader';
import { xlsxAddress, xlsxRange } from '../content/XlsxSheet';
import { columnName } from '../content/WorkbookPage';
import { xmlAttribute } from '../content/WorkbookXml';
import { WorkbookExactNumber } from '../content/WorkbookExactNumber';
import { workbookExactText } from '../content/WorkbookBinding';
import { decodeOfficeXml } from './OfficeTextPatch';
import { WorkbookEditFailure } from './WorkbookEditContracts';
import { XLSX_UNAVAILABLE_ERRORS, type WorkbookRecalcScan, type WorkbookRecalcTarget, type WorkbookRecalcValue } from './WorkbookRecalcContracts';
import { xlsxFormulaEffects, xlsxFormulaNetworkHosts } from './XlsxFormulaEffects';
import { readXlsxSheetLayout, patchXlsxSheet, xlsxUntouchedCells, type XlsxCellWrite } from './XlsxSheetPatch';
import { readXlsxContentTypes, readXlsxRelationships, type XlsxRelationships } from './XlsxPackageParts';
import { MacroSheetDependencies, macroSheetRelationships, removedDefinedName, stripMacroSheetsForEngine } from './WorkbookMacroSheets';
import { scanXlsxXml } from './XlsxXmlScan';
import { verifyWorkbookOutput } from './WorkbookEdits';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type WorkbookRecalcWorkerInput =
  | { operation: 'recalc-scan'; source: string; targets: { cells: Array<{ sheet_id: string; refs: string[] }> } | { formulas: Array<{ sheet_id: string; cell: string }> } }
  | { operation: 'recalc-read'; source: string; directory: string; targets: WorkbookRecalcTarget[]; date1904: boolean }
  | { operation: 'recalc-cache'; source: string; sourceSha256: string; directory: string; values: WorkbookRecalcValue[] }
  | { operation: 'recalc-strip'; source: string; sourceSha256: string; directory: string; targets: WorkbookRecalcTarget[] };

/** The engine's private copy without Excel 4 macro sheets (see WorkbookMacroSheets); the person's file is never changed. */
export async function stripRecalcCopy(input: Extract<WorkbookRecalcWorkerInput, { operation: 'recalc-strip' }>, ratio: number, floor: number, progress: () => void) {
  return await stripMacroSheetsForEngine(input, ratio, floor, progress);
}

async function bytesOf(pkg: ReadOnlyOpc, part: string, progress: () => void) {
  const chunks: Buffer[] = []; for await (const chunk of pkg.bytes(part)) { chunks.push(Buffer.from(chunk)); progress(); } return Buffer.concat(chunks);
}
const hostsOf = (url: string | undefined) => { try { const parsed = new URL(url ?? ''); return /^https?:$/.test(parsed.protocol) ? [parsed.hostname.toLowerCase()] : []; } catch { return []; } };

/** Every effect this one recalculation could have, from formulas, defined names, relationships and connection parts. */
export async function scanWorkbookForRecalc(input: Extract<WorkbookRecalcWorkerInput, { operation: 'recalc-scan' }>, ratio: number, floor: number, progress: () => void): Promise<WorkbookRecalcScan> {
  const source = await readFile(input.source); const pkg = await ReadOnlyOpc.open(input.source, ratio, floor, progress);
  try {
    let inventory: Awaited<ReturnType<typeof inspectXlsxInventory>>;
    try { inventory = await inspectXlsxInventory(pkg); } catch { throw new WorkbookEditFailure('unsupported-workbook-package'); }
    const scan: WorkbookRecalcScan = { sha256: sha(source), date1904: inventory.date1904, sheets: inventory.sheets.map(sheet => ({ sheet_id: sheet.sheetId, name: sheet.name, position: sheet.position })),
      targets: [], network: [], native: [], external_links: 0, connections: [], macro_sheets: [], macro_dependent: [] };
    const note = (text: string, location: string) => {
      const effects = xlsxFormulaEffects(text);
      if (effects.includes('network')) { const found = xlsxFormulaNetworkHosts(text); scan.network.push({ location, hosts: found.hosts, dynamic: found.dynamic || !found.hosts.length }); }
      if (effects.includes('native-code')) scan.native.push(location);
    };
    const quoted = (name: string) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
    const rels = pkg.has(opcRelationshipsPart(inventory.workbookPart)) ? readXlsxRelationships(await bytesOf(pkg, opcRelationshipsPart(inventory.workbookPart), progress), inventory.workbookPart, progress) : undefined;
    const refreshed = new Set<string>(); const sheetRels = new Map<string, XlsxRelationships | undefined>();
    // Excel 4 macro sheets, by relationship type or content type (Excel's own xlMacrosheet relationship included).
    const types = readXlsxContentTypes(await bytesOf(pkg, '/[Content_Types].xml', progress), progress);
    const macroParts = new Set(macroSheetRelationships(rels, part => types.typeOf(part)).map(item => item.part!));
    const macroSheets = inventory.sheets.filter(sheet => sheet.kind === 'macrosheet' || !!sheet.part && macroParts.has(sheet.part));
    scan.macro_sheets = macroSheets.map(sheet => sheet.name);
    const dependencies = macroSheets.length ? new MacroSheetDependencies(new Set(scan.macro_sheets.map(name => name.toLowerCase()))) : undefined;
    const definedNames: Array<{ name: string; localSheetId?: number; text: string }> = [];
    for (const sheet of inventory.sheets) {
      if (macroSheets.includes(sheet)) {
        // Owner decision (2026-11-22): an Excel 4 macro sheet alone does not stop a recalculation; the engine's private
        // copy leaves it out (WorkbookMacroSheets), so nothing in it runs. Its formulas are still checked for CALL,
        // REGISTER.ID and DDE.
        if (sheet.part && pkg.has(sheet.part)) scanXlsxXml(decodeOfficeXml(await bytesOf(pkg, sheet.part, progress)), progress, {
          open: tag => tag.local === 'f' ? true : undefined,
          close: node => { if (node.tag.local === 'f' && node.text) note(node.text, `${quoted(sheet.name)} (Excel 4 macro sheet)`); },
        });
        continue;
      }
      if (sheet.kind !== 'worksheet' || !sheet.part || sheet.gap) continue;
      const layout = readXlsxSheetLayout(await bytesOf(pkg, sheet.part, progress), progress);
      for (const row of layout.rows) for (const cell of row.cells) if (cell.formula?.text) {
        note(cell.formula.text, `${quoted(sheet.name)}!${cell.ref}`);
        dependencies?.formula(sheet.name, cell.formula.text, xlsxAddress(cell.ref), cell.formula.mode !== 'normal' ? cell.formula.ref : undefined);
      }
      const relsPart = opcRelationshipsPart(sheet.part);
      const items = pkg.has(relsPart) ? readXlsxRelationships(await bytesOf(pkg, relsPart, progress), sheet.part, progress) : undefined; sheetRels.set(sheet.sheetId, items);
      for (const rel of items?.items ?? []) if (rel.kind === 'queryTable' && rel.part && pkg.has(rel.part)) {
        scanXlsxXml(decodeOfficeXml(await bytesOf(pkg, rel.part, progress)), progress, { open(tag, parents) {
          if (!parents.length && SHEET_NS.has(tag.uri) && ['1', 'true'].includes(xmlAttribute(tag, 'refreshOnLoad') ?? '')) refreshed.add(xmlAttribute(tag, 'connectionId') ?? '');
        } });
      }
    }
    scanXlsxXml(decodeOfficeXml(await bytesOf(pkg, inventory.workbookPart, progress)), progress, {
      open: (tag, parents) => parents.length === 2 && SHEET_NS.has(tag.uri) && tag.local === 'definedName' ? true : undefined,
      close: node => {
        if (node.parents.length !== 2 || !SHEET_NS.has(node.tag.uri) || node.tag.local !== 'definedName' || !node.text) return;
        note(node.text, `name ${xmlAttribute(node.tag, 'name') ?? ''}`);
        const local = xmlAttribute(node.tag, 'localSheetId');
        definedNames.push({ name: xmlAttribute(node.tag, 'name') ?? '', ...(local !== undefined && /^\d+$/.test(local) ? { localSheetId: Number(local) } : {}), text: node.text });
      },
    });
    for (const rel of rels?.items ?? []) {
      if (rel.kind === 'externalLink') scan.external_links++;
      if (rel.kind === 'pivotCacheDefinition' && rel.part && pkg.has(rel.part)) {
        let refresh = false;
        scanXlsxXml(decodeOfficeXml(await bytesOf(pkg, rel.part, progress)), progress, { open(tag, parents) {
          if (!parents.length && SHEET_NS.has(tag.uri)) refresh = ['1', 'true'].includes(xmlAttribute(tag, 'refreshOnLoad') ?? '');
          if (parents.length === 1 && SHEET_NS.has(tag.uri) && tag.local === 'cacheSource' && refresh) refreshed.add(xmlAttribute(tag, 'connectionId') ?? '');
        } });
      }
    }
    for (const rel of rels?.items ?? []) if (rel.kind === 'connections' && rel.part && pkg.has(rel.part)) {
      let current: { id: string; name: string; refresh: boolean; kind: 'web' | 'local'; hosts: string[] } | undefined;
      scanXlsxXml(decodeOfficeXml(await bytesOf(pkg, rel.part, progress)), progress, {
        open(tag, parents) {
          if (!SHEET_NS.has(tag.uri)) return;
          if (parents.length === 1 && tag.local === 'connection') current = { id: xmlAttribute(tag, 'id') ?? '', name: xmlAttribute(tag, 'name') ?? '', kind: 'local', hosts: [],
            refresh: ['1', 'true'].includes(xmlAttribute(tag, 'refreshOnLoad') ?? '') };
          if (parents.length === 2 && current && tag.local === 'webPr') { current.kind = 'web'; current.hosts = hostsOf(xmlAttribute(tag, 'url')); }
        },
        close(node) {
          if (node.parents.length === 1 && current && node.tag.local === 'connection') {
            if (current.refresh || refreshed.has(current.id)) scan.connections.push({ name: current.name, location: `connection ${current.name || current.id}`, kind: current.kind, hosts: current.hosts });
            current = undefined;
          }
        },
      });
    }
    const sheetFor = (id: string, location: string) => {
      const sheet = inventory.sheets.find(item => item.sheetId === id);
      if (!sheet || sheet.kind !== 'worksheet' || sheet.gap) throw new WorkbookEditFailure('unavailable-worksheet', { location, issue: `${id} is not a readable worksheet of this workbook` });
      return sheet;
    };
    if (dependencies) {
      const indexes = new Set(macroSheets.map(sheet => sheet.position - 1)); const names = new Set(scan.macro_sheets.map(name => name.toLowerCase()));
      for (const name of definedNames) if (removedDefinedName(name, indexes, names)) dependencies.removedName(name.name);
      for (const name of definedNames) dependencies.definedName(name.name, name.text);
      dependencies.settle();
    }
    if ('cells' in input.targets) for (const [index, item] of input.targets.cells.entries()) {
      const sheet = sheetFor(item.sheet_id, `targets.cells[${index}].sheet_id`);
      for (const ref of item.refs) {
        const range = xlsxRange(ref);
        for (let row = range.firstRow; row <= range.lastRow; row++) for (let column = range.firstColumn; column <= range.lastColumn; column++) {
          const cell = `${columnName(column)}${row}`;
          if (!scan.targets.some(target => target.sheet_id === sheet.sheetId && target.cell === cell)) scan.targets.push({ sheet_id: sheet.sheetId, position: sheet.position, cell });
        }
      }
    } else for (const formula of input.targets.formulas) {
      const sheet = sheetFor(formula.sheet_id, 'targets.from_receipt'); scan.targets.push({ sheet_id: sheet.sheetId, position: sheet.position, cell: xlsxAddress(formula.cell).cell });
    }
    if (dependencies) scan.macro_dependent = scan.targets.filter(target => dependencies.dependent(inventory.sheets.find(sheet => sheet.sheetId === target.sheet_id)!.name, xlsxAddress(target.cell)))
      .map(target => `${target.sheet_id}!${target.cell}`);
    return scan;
  } finally { pkg.close(); }
}

const ERROR_CODES = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#CONNECT!', '#BLOCKED!', '#UNKNOWN!', '#FIELD!']);
/** Cached results of the targets in an engine-saved copy, converted to the original workbook's date system. */
export async function readRecalculatedCopy(input: Extract<WorkbookRecalcWorkerInput, { operation: 'recalc-read' }>, progress: () => void): Promise<WorkbookRecalcValue[]> {
  const directory = join(input.directory, `recalc-read-${randomUUID()}`); await mkdir(directory);
  try {
    let manifest: Awaited<ReturnType<typeof parseXlsxSnapshot>>;
    try { manifest = await parseXlsxSnapshot(input.source, directory, progress); } catch { throw new WorkbookEditFailure('workbook-output-check-failed'); }
    const values: WorkbookRecalcValue[] = [];
    for (const target of input.targets) {
      const sheet = manifest.sheets.find(item => item.position === target.position);
      if (!sheet?.metadata || !sheet.directory) { values.push({ sheet_id: target.sheet_id, cell: target.cell, type: 'blank', value: null, recalculated: false, error: 'engine-sheet-missing' }); continue; }
      const reader = new XlsxPointReader(directory, join(directory, sheet.directory), sheet.metadata, manifest.date1904);
      try {
        const address = xlsxAddress(target.cell); const record = reader.cell(address.row, address.column); const value = record?.formula?.cachedResult ?? record?.value;
        const base = { sheet_id: target.sheet_id, cell: target.cell };
        if (!value || value.kind === 'blank') values.push({ ...base, type: 'blank', value: null, recalculated: true });
        else if (value.kind === 'number') values.push({ ...base, type: 'n', value: value.raw.trim(), recalculated: true });
        else if (value.kind === 'date-serial') {
          let serial = WorkbookExactNumber.parse(value.raw.trim(), 4096);
          if (manifest.date1904 !== input.date1904) serial = serial.add(new WorkbookExactNumber(manifest.date1904 ? 1462n : -1462n));
          values.push({ ...base, type: 'n', value: workbookExactText(serial), recalculated: true });
        } else if (value.kind === 'string' || value.kind === 'rich-string') values.push({ ...base, type: 'str', value: value.text, recalculated: true });
        else if (value.kind === 'boolean') values.push({ ...base, type: 'b', value: value.value ? '1' : '0', recalculated: true });
        else if (value.kind === 'error') {
          // An engine-only function gap or a blocked evaluation must not be presented as the workbook's calculated result.
          const unavailable = XLSX_UNAVAILABLE_ERRORS.get(value.code);
          values.push({ ...base, type: 'e', value: ERROR_CODES.has(value.code) ? value.code : '#VALUE!', recalculated: !unavailable, ...(unavailable ? { error: unavailable } : {}) });
        } else values.push({ ...base, type: 'blank', value: null, recalculated: false, error: 'engine-value-unreadable' });
      } finally { reader.close(); }
    }
    return values;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Write only the recalculated cached values of formula cells; formulas, other cells and other parts keep their bytes. */
export async function writeRecalculatedCache(input: Extract<WorkbookRecalcWorkerInput, { operation: 'recalc-cache' }>, ratio: number, floor: number, progress: () => void): Promise<{ bytes: Uint8Array; sha256: string; written: string[]; skipped: string[] }> {
  const source = await readFile(input.source); if (sha(source) !== input.sourceSha256) throw new WorkbookEditFailure('source-changed');
  const pkg = await ReadOnlyOpc.open(input.source, ratio, floor, progress); const scratch = join(input.directory, `recalc-cache-${randomUUID()}`); await mkdir(scratch);
  try {
    const inventory = await inspectXlsxInventory(pkg); const before = new Map<string, { member: string; hash: string }>();
    for (const name of pkg.names().sort()) { const hash = createHash('sha256'); for await (const chunk of pkg.bytes(name)) hash.update(chunk); before.set(name, { member: pkg.memberName(name), hash: hash.digest('hex') }); }
    const changed = new Map<string, Buffer>(); const written: string[] = []; const skipped: string[] = []; const untouched = new Map<string, string[]>();
    const record = new Map<string, Map<string, { write: XlsxCellWrite }>>();
    for (const sheet of inventory.sheets) {
      const values = input.values.filter(value => value.sheet_id === sheet.sheetId && value.recalculated && value.type !== 'blank'
        && !(value.type === 'e' && value.value !== null && XLSX_UNAVAILABLE_ERRORS.has(value.value)));
      if (!values.length || !sheet.part || sheet.kind !== 'worksheet') { skipped.push(...input.values.filter(value => value.sheet_id === sheet.sheetId).map(value => `${value.sheet_id}!${value.cell}`)); continue; }
      const layout = readXlsxSheetLayout(await bytesOf(pkg, sheet.part, progress), progress); const writes: XlsxCellWrite[] = []; const cells = new Map<string, { write: XlsxCellWrite }>();
      for (const value of input.values.filter(item => item.sheet_id === sheet.sheetId)) {
        const node = layout.byRef.get(value.cell);
        // An unavailable evaluation is never cached, whatever its recalculated flag says.
        if (!value.recalculated || value.type === 'blank' || !node?.formula || value.value === null
          || value.type === 'e' && XLSX_UNAVAILABLE_ERRORS.has(value.value)) { skipped.push(`${value.sheet_id}!${value.cell}`); continue; }
        const write: XlsxCellWrite = { row: node.row, column: node.column, content: { kind: 'cached', type: value.type, text: value.value } };
        writes.push(write); cells.set(value.cell, { write }); written.push(`${value.sheet_id}!${value.cell}`);
      }
      if (!writes.length) continue;
      untouched.set(sheet.part, xlsxUntouchedCells(layout, new Set(cells.keys())));
      changed.set(sheet.part, patchXlsxSheet(layout, writes).bytes); record.set(sheet.sheetId, cells);
    }
    for (const [name, bytes] of [...changed]) if (before.get(name)?.hash === sha(bytes)) changed.delete(name);
    const zip = await JSZip.loadAsync(source, { createFolders: false });
    for (const [name, bytes] of changed) zip.file(before.get(opcPartName(name))!.member, bytes);
    const output = changed.size ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress()) : source;
    const file = join(scratch, 'cache.xlsx'); await writeFile(file, output, { flag: 'wx' });
    await verifyWorkbookOutput(file, { before, changed, added: new Map(), removed: new Set(), ratio, floor, progress, written: record, untouched, content: false, scratch,
      manifestSheets: inventory.sheets.map(sheet => ({ id: sheet.sheetId, part: sheet.part })) });
    return { bytes: output, sha256: sha(output), written, skipped };
  } finally { pkg.close(); await rm(scratch, { recursive: true, force: true }); }
}
