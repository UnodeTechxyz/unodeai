import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO as RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES as FLOOR } from '../../content/ContentAssetStore';
import { scanWorkbookForRecalc, readRecalculatedCopy, writeRecalculatedCache, stripRecalcCopy } from '../WorkbookRecalcPackage';
import { parseXlsxSnapshot } from '../../content/XlsxWorkbook';
import { MacroSheetDependencies } from '../WorkbookMacroSheets';
import { WorkbookRecalcEngine } from '../WorkbookRecalcEngine';
import { NativeStageCleanup } from '../NativeStageCleanup';
import { fileURLToPath } from 'node:url';
import { windowsExcelRecalcLaunch } from '../platform/WindowsExcelRecalc';
import { validateWorkbookRecalcRequest } from '../WorkbookRecalcContracts';
import { libreOfficeRecalcArguments, runLibreOfficeRecalc, LIBREOFFICE_RECALC_PROFILE } from '../platform/LibreOfficeRecalc';
import { workbookFixture, MAIN, REL, PACKAGE } from './workbookEditFixtures';

const folders: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function folder() { const value = await mkdtemp(join(tmpdir(), 'unode-recalc-test-')); folders.push(value); return value; }
async function file(bytes: Buffer) { const root = await folder(); const path = join(root, 'book.xlsx'); await writeFile(path, bytes); return { root, path }; }
async function withSheet(sheet1: string, extra: (zip: JSZip) => Promise<void> = async () => {}) {
  const zip = await JSZip.loadAsync(await workbookFixture({ sheet1 })); await extra(zip); return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>;
}

describe('recalculation scan, read-back and cache write', () => {
  it('finds network, local-code, macro-sheet, defined-name and refresh-on-load connection effects before any engine runs', async () => {
    const sheet1 = `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><f>WEBSERVICE("https://Api.Example.com/x")</f></c><c r="B1"><f>WEBSERVICE(A9&amp;"x")</f></c>`
      + `<c r="C1"><f>REGISTER.ID("kernel32","GetTickCount","J")</f></c><c r="D1"><f>[1]Other!A1</f></c><c r="E1"><f>SUM(A2:A3)</f></c><c r="F1"><f>RTD("Some.RtdServer",,"x")</f></c></row></sheetData></worksheet>`;
    const bytes = await withSheet(sheet1, async zip => {
      const book = await zip.file('xl/workbook.xml')!.async('string');
      zip.file('xl/workbook.xml', book.replace('</sheets>', '</sheets><definedNames><definedName name="Feed">STOCKHISTORY("MSFT",TODAY())</definedName></definedNames>'));
      const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
      zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', `<Relationship Id="cn" Type="${REL}/connections" Target="connections.xml"/></Relationships>`));
      zip.file('xl/connections.xml', `<connections xmlns="${MAIN}"><connection id="1" name="Sales DB" type="1" refreshOnLoad="1"><dbPr connection="DSN=Sales"/></connection>`
        + '<connection id="2" name="Rates" type="4" refreshOnLoad="1"><webPr url="https://rates.example.org/feed"/></connection><connection id="3" name="Idle" type="1"><dbPr connection="DSN=x"/></connection></connections>');
    });
    const { path } = await file(bytes);
    const scan = await scanWorkbookForRecalc({ operation: 'recalc-scan', source: path, targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1:B1', 'E1'] }] } }, RATIO, FLOOR, () => {});
    expect(scan.sha256).toBe(sha(bytes)); expect(scan.targets.map(target => target.cell)).toEqual(['A1', 'B1', 'E1']);
    expect(scan.network).toEqual([{ location: 'Data!A1', hosts: ['api.example.com'], dynamic: false }, { location: 'Data!B1', hosts: [], dynamic: true }, { location: 'name Feed', hosts: [], dynamic: true }]);
    // RTD starts a registered COM server: local code, never a web read (Owner, 2026-11-22).
    expect(scan.native).toEqual(['Data!C1', 'Data!F1']);
    expect(scan.connections).toEqual([{ name: 'Sales DB', location: 'connection Sales DB', kind: 'local', hosts: [] }, { name: 'Rates', location: 'connection Rates', kind: 'web', hosts: ['rates.example.org'] }]);
    await expect(scanWorkbookForRecalc({ operation: 'recalc-scan', source: path, targets: { cells: [{ sheet_id: 'sheet-9', refs: ['A1'] }] } }, RATIO, FLOOR, () => {})).rejects.toThrow('unavailable-worksheet');
  });

  it('reads an engine copy, converts date serials to the original date system and does not mark an engine #NAME? as recalculated', async () => {
    const styles = `<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;
    const copy = await workbookFixture({ styles, sheet1: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" s="1"><f>B1+1</f><v>46054</v></c><c r="B1" t="e"><f>X()</f><v>#NAME?</v></c>`
      + `<c r="C1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="D1" t="str"><f>"a"</f><v>a</v></c><c r="E1" t="b"><f>TRUE</f><v>1</v></c></row></sheetData></worksheet>` });
    const { root, path } = await file(copy);
    const targets = ['A1', 'B1', 'C1', 'D1', 'E1'].map(cell => ({ sheet_id: 'sheet-1', position: 1, cell }));
    const values = await readRecalculatedCopy({ operation: 'recalc-read', source: path, directory: root, targets, date1904: true }, () => {});
    expect(values.map(value => [value.cell, value.type, value.value, value.recalculated, value.error])).toEqual([
      ['A1', 'n', '44592', true, undefined], ['B1', 'e', '#NAME?', false, 'engine-unsupported-function'], ['C1', 'e', '#DIV/0!', true, undefined],
      ['D1', 'str', 'a', true, undefined], ['E1', 'b', '1', true, undefined]]);
  });

  it('X2 audit F2: a #BLOCKED! read from an engine copy is unrecalculated, and the cache never writes one even if marked recalculated', async () => {
    const copy = await workbookFixture({ sheet1: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="e"><f>GET.CELL(48,B1)</f><v>#BLOCKED!</v></c>`
      + '<c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>' });
    const { root, path } = await file(copy);
    const values = await readRecalculatedCopy({ operation: 'recalc-read', source: path, directory: root, targets: ['A1', 'B1'].map(cell => ({ sheet_id: 'sheet-1', position: 1, cell })), date1904: false }, () => {});
    expect(values.map(value => [value.cell, value.value, value.recalculated, value.error])).toEqual([['A1', '#BLOCKED!', false, 'engine-evaluation-blocked'], ['B1', '#DIV/0!', true, undefined]]);
    const source = await workbookFixture(); const target = await file(source);
    const cached = await writeRecalculatedCache({ operation: 'recalc-cache', source: target.path, sourceSha256: sha(source), directory: target.root, values: [
      { sheet_id: 'sheet-1', cell: 'A1', type: 'e', value: '#BLOCKED!', recalculated: true }, { sheet_id: 'sheet-1', cell: 'D2', type: 'e', value: '#NAME?', recalculated: true },
      { sheet_id: 'sheet-1', cell: 'B2', type: 'e', value: '#DIV/0!', recalculated: true }] }, RATIO, FLOOR, () => {});
    expect(cached.written).toEqual(['sheet-1!B2']); expect(cached.skipped).toEqual(['sheet-1!A1', 'sheet-1!D2']);
  });

  it('X2 audit item 3: the engine copy leaves out an Excel 4 macro sheet and its names; dependent cells are found, the source is unchanged', async () => {
    // Excel's own form: an xlMacrosheet relationship and content type, placed before the worksheets.
    const sheet1 = `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><f>B1+1</f></c><c r="B1"><v>1</v></c>`
      + '<c r="E1"><f>Feed*2</f></c><c r="F1"><f>Macro1!A2+1</f></c><c r="G1"><f>E1+1</f></c><c r="H1"><f>SUM(A1:B1)</f></c></row></sheetData></worksheet>';
    const bytes = await withSheet(sheet1, async zip => {
      const book = await zip.file('xl/workbook.xml')!.async('string');
      zip.file('xl/workbook.xml', book.replace('<sheets>', '<bookViews><workbookView activeTab="2"/></bookViews><sheets><sheet name="Macro1" sheetId="9" r:id="m1" state="hidden"/>')
        .replace('</sheets>', '</sheets><definedNames><definedName name="Auto_Open">Macro1!$A$1</definedName><definedName name="Feed">Macro1!$A$2</definedName>'
          + '<definedName name="Helper" localSheetId="0">$A$3</definedName><definedName name="Rate" localSheetId="1">Data!$B$1</definedName>'
          // Excel runs an Auto_Close name on its own even when it points at a worksheet cell.
          + '<definedName name="Auto_Close">Data!$A$1</definedName></definedNames>'));
      const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
      zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="m1" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet1.xml"/></Relationships>'));
      const types = await zip.file('[Content_Types].xml')!.async('string');
      zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>'));
      zip.file('xl/macrosheets/sheet1.xml', '<xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData><row r="1"><c r="A1"><f>ALERT("hi")</f></c></row><row r="2"><c r="A2"><f>GET.CELL(48,Data!A1)</f></c></row><row r="3"><c r="A3"><f>RETURN()</f></c></row></sheetData></xm:macrosheet>');
    });
    const { root, path } = await file(bytes);
    const scan = await scanWorkbookForRecalc({ operation: 'recalc-scan', source: path, targets: { cells: [{ sheet_id: 'sheet-2', refs: ['A1', 'E1:H1'] }] } }, RATIO, FLOOR, () => {});
    expect(scan.native).toEqual([]); expect(scan.macro_sheets).toEqual(['Macro1']);
    // E1 names a removed name, F1 the macro sheet, G1 depends on E1; A1 and H1 do not depend on the macro sheet.
    expect(scan.macro_dependent).toEqual(['sheet-2!E1', 'sheet-2!F1', 'sheet-2!G1']);
    const stripped = await stripRecalcCopy({ operation: 'recalc-strip', source: path, sourceSha256: sha(bytes), directory: root, targets: scan.targets }, RATIO, FLOOR, () => {});
    expect(stripped.removed_sheets).toEqual(['Macro1']); expect(stripped.removed_names).toEqual(['Auto_Open', 'Feed', 'Helper', 'Auto_Close']);
    expect(stripped.targets.map(target => [target.sheet_id, target.position, target.cell])).toEqual(['A1', 'E1', 'F1', 'G1', 'H1'].map(cell => ['sheet-2', 1, cell]));
    expect(await readFile(path)).toEqual(bytes); // the person's file is never changed
    const copy = await JSZip.loadAsync(stripped.bytes);
    expect(Object.keys(copy.files).filter(name => /macrosheet|calc\/chain/i.test(name))).toEqual([]);
    const book = await copy.file('xl/workbook.xml')!.async('string');
    expect(book).not.toContain('Macro1"'); expect(book).not.toMatch(/Auto_Open|Auto_Close|"Feed"|"Helper"/); expect(book).toContain('<definedName name="Rate" localSheetId="0">Data!$B$1</definedName>');
    expect(book).toContain('<workbookView activeTab="1"/>');
    expect(await copy.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toMatch(/xlMacrosheet|calcChain/);
    expect(await copy.file('[Content_Types].xml')!.async('string')).not.toMatch(/macrosheet|calcChain/);
    // The copy reads back as a valid workbook through the existing reader, with every worksheet in order.
    const copyFile = join(root, 'engine-copy.xlsx'); await writeFile(copyFile, stripped.bytes);
    const snapshot = await parseXlsxSnapshot(copyFile, await folder(), () => {});
    expect(snapshot.sheets.map(sheet => [sheet.name, sheet.position])).toEqual([['Data', 1], ['Locked', 2]]);
    // A workbook without a macro sheet is handed over byte for byte.
    const plain = await workbookFixture(); const plainFile = await file(plain);
    const same = await stripRecalcCopy({ operation: 'recalc-strip', source: plainFile.path, sourceSha256: sha(plain), directory: plainFile.root, targets: [] }, RATIO, FLOOR, () => {});
    expect(Buffer.from(same.bytes).equals(plain)).toBe(true); expect(same.removed_sheets).toEqual([]);
  });

  it('X2 re-audit 1: references resolved from text or at run time count as macro-sheet dependent and propagate', () => {
    const deps = new MacroSheetDependencies(new Set(['macro1']));
    const at = (row: number, column: number) => ({ row, column });
    deps.formula('Data', 'IFERROR(INDIRECT("Macro"&"1!A1"),99)', at(1, 1));          // A1: INDIRECT, computed text
    deps.formula('Data', 'LEN("see Macro1 notes")', at(1, 2));                        // B1: the sheet named inside a string
    deps.formula('Data', 'Calc*2', at(1, 3));                                         // C1: a name built on EVALUATE
    deps.formula('Data', 'SUM(OFFSET(H8,0,5))', at(2, 1));                            // A2: OFFSET, whatever its base
    deps.formula('Data', 'C1+1', at(2, 2));                                           // B2: through C1
    deps.formula('Data', 'SUM(D1:D9)', at(2, 3));                                     // C2: independent
    deps.formula('Other', 'SUM(OFFSET(Anchor,0,1))', at(1, 1));                       // Other!A1: OFFSET from a clean name on a clean sheet
    deps.formula('Other', 'SUM(INDEX(B1:B3,2),CHOOSE(1,C1,C2))', at(1, 2));           // Other!B1: INDEX/CHOOSE over clean cells
    deps.definedName('Anchor', 'Other!$B$1');
    deps.definedName('Calc', 'EVALUATE("1+1")');
    deps.settle();
    expect([at(1, 1), at(1, 2), at(1, 3), at(2, 1), at(2, 2), at(2, 3)].map(cell => deps.dependent('Data', cell))).toEqual([true, true, true, true, true, false]);
    expect(deps.dependent('Other', at(1, 1))).toBe(true); expect(deps.dependent('Other', at(1, 2))).toBe(false);
  });

  it('writes cached results only into formula cells and keeps every formula, other cell and part', async () => {
    const source = await workbookFixture(); const { root, path } = await file(source);
    const result = await writeRecalculatedCache({ operation: 'recalc-cache', source: path, sourceSha256: sha(source), directory: root, values: [
      { sheet_id: 'sheet-1', cell: 'A1', type: 'n', value: '11', recalculated: true }, { sheet_id: 'sheet-1', cell: 'B1', type: 'n', value: '10', recalculated: true },
      { sheet_id: 'sheet-1', cell: 'D2', type: 'e', value: '#N/A', recalculated: true }, { sheet_id: 'sheet-1', cell: 'B3', type: 'str', value: 'x', recalculated: false }] }, RATIO, FLOOR, () => {});
    expect(result.written).toEqual(['sheet-1!A1', 'sheet-1!D2']); expect(result.skipped).toEqual(['sheet-1!B1', 'sheet-1!B3']);
    const zip = await JSZip.loadAsync(result.bytes); const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<c r="A1"><f>B1+1</f><v>11</v></c>'); expect(sheet).toContain('<c r="D2" t="e"><f t="array" ref="D2:D3">A2:A3*3</f><v>#N/A</v></c>');
    expect(sheet).toContain('<c r="B3"><f t="shared" si="0"/><v>12</v></c>');
    const before = await JSZip.loadAsync(source); expect(await zip.file('xl/workbook.xml')!.async('string')).toBe(await before.file('xl/workbook.xml')!.async('string'));
    expect(zip.file('xl/calc/chain.xml')).not.toBeNull();
    await expect(writeRecalculatedCache({ operation: 'recalc-cache', source: path, sourceSha256: '0'.repeat(64), directory: root, values: [] }, RATIO, FLOOR, () => {})).rejects.toThrow('source-changed');
  });

  it('validates targets and limits', () => {
    expect(validateWorkbookRecalcRequest({ schema_version: 1, path: 'a.xlsx', targets: { from_receipt: 'workbook-edit-1' } })).toMatchObject({ adapter: 'auto', write_cache: false });
    expect(() => validateWorkbookRecalcRequest({ schema_version: 1, path: 'a.xlsx', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1:Z1000'] }] } })).toThrow('invalid-workbook-edits');
    expect(() => validateWorkbookRecalcRequest({ schema_version: 1, path: 'a.xlsx', targets: {} })).toThrow('invalid-workbook-edits');
  });
});

describe('native engines (process fixtures only)', () => {
  const catalog = (path: string) => ({ candidate: async (id: string) => ({ id: id as 'excel', path, sha256: 'c'.repeat(64), bytes: 1 }) });
  const target = [{ sheet_id: 'sheet-1', position: 1, cell: 'A1' }, { sheet_id: 'sheet-1', position: 1, cell: 'B1' }];
  // The real Windows adapter around a fixture transport: only the PowerShell process itself is replaced.
  const excel = (execute: any) => () => windowsExcelRecalcLaunch({ env: { SystemRoot: 'system-root-fixture' }, resolve: command => command, execute });
  const job = (source: Buffer, signal = new AbortController().signal) => ({ source, engine: 'excel' as const, targets: target, date1904: false, signal, current: () => !signal.aborted,
    authorize: vi.fn(async () => {}), readCopy: async () => [] });
  it('maps Excel values and CVErr codes, reports the helper-owned quit, and refuses an instance it cannot prove private', async () => {
    const executePowerShell = vi.fn(async (request: any) => {
      const input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8'));
      expect(request.signal.aborted).toBe(false); expect(input.targets).toEqual([{ i: 0, position: 1, cell: 'A1' }, { i: 1, position: 1, cell: 'B1' }]);
      return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'passed', app_version: '16.0',
        native_app: 'quit-by-helper', values: [{ i: 0, kind: 'n', value: '11' }, { i: 1, kind: 'e', code: 2007 }] }) };
    });
    const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(executePowerShell) });
    const passed = await engine.run(job(Buffer.from('workbook')));
    expect(passed).toMatchObject({ state: 'passed', engine_version: '16.0', native_app: 'quit-by-helper', staging_cleanup: 'removed' });
    expect(passed.values.map(value => [value.type, value.value, value.recalculated])).toEqual([['n', '11', true], ['e', '#DIV/0!', true]]);
    let notPrivateSource = '';
    const notPrivate = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(async (request: any) => {
      const input = JSON.parse(Buffer.from(request.input, 'base64').toString()); notPrivateSource = input.source;
      return { status: 'exited' as const, code: 0, signal: null, stderr: '',
        stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'not-run', error: 'office-instance-not-private', native_app: 'unknown', values: [] }) };
    }) });
    // An Excel instance the helper could not prove private is in an unknown state: its stage is kept, not cleaned at once.
    expect(await notPrivate.run(job(Buffer.from('workbook')))).toMatchObject({ state: 'not-run', error: 'office-instance-not-private', staging_cleanup: 'not-removed' });
    await removeStage(dirname(notPrivateSource));
    expect(await new WorkbookRecalcEngine({ platform: 'linux', catalog: catalog('excel') }).run(job(Buffer.from('x')))).toMatchObject({ state: 'not-run', error: 'platform-unsupported' });
    // Without Windows PowerShell the adapter offers no launch, and nothing is approved or started.
    expect(windowsExcelRecalcLaunch({ env: {}, resolve: command => command })).toBeUndefined();
    const noShell = job(Buffer.from('x'));
    expect(await new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: () => undefined }).run(noShell)).toMatchObject({ state: 'not-run', error: 'recalc-engine-unavailable' });
    expect(noShell.authorize).not.toHaveBeenCalled();
    const launch = excel(executePowerShell)()!; expect(launch.command).toContain('powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -EncodedCommand ');
    expect(executePowerShell.mock.calls[0][0]).toMatchObject({ inputVariable: 'UNODE_WORKBOOK_RECALC_JOB' });
  });

  it('reports an Excel #NAME? (a function it cannot run, such as a macro-sheet one with macros disabled) as not recalculated', async () => {
    const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(async (request: any) => {
      const input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8'));
      return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'passed', app_version: '16.0',
        native_app: 'quit-by-helper', values: [{ i: 0, kind: 'e', code: 2029 }, { i: 1, kind: 'e', code: 2042 }] }) };
    }) });
    const result = await engine.run(job(Buffer.from('workbook')));
    expect(result.values.map(value => [value.value, value.recalculated, value.error])).toEqual([['#NAME?', false, 'engine-unsupported-function'], ['#N/A', true, undefined]]);
  });

  it('on Stop or the time limit only writes the helper stop marker: the helper is never killed and the stage waits for its exit', async () => {
    let finishHelper!: () => void; let stopFile = ''; let helperSignal: AbortSignal | undefined;
    const executePowerShell = vi.fn((request: any) => new Promise<any>(resolve => {
      const input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')); stopFile = input.stop; helperSignal = request.signal;
      finishHelper = () => resolve({ status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'stopped', error: 'cancelled', native_app: 'quit-by-helper', values: [] }) });
    }));
    const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(executePowerShell) });
    const stop = new AbortController(); const running = engine.run(job(Buffer.from('workbook'), stop.signal));
    await vi.waitFor(() => expect(executePowerShell).toHaveBeenCalled()); stop.abort();
    const result = await running; expect(result).toMatchObject({ state: 'cancelled', error: 'cancelled', staging_cleanup: 'after-helper-exit' });
    expect(await readFile(stopFile, 'utf8')).toBe('cancelled'); expect(helperSignal!.aborted).toBe(false);
    finishHelper(); await engine.dispose(); await expect(access(stopFile)).rejects.toMatchObject({ code: 'ENOENT' });
    let exitSlow!: () => void; let slowStop = '';
    const slow = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), nativeTimeoutMs: 1, excelLaunch: excel(vi.fn((request: any) => new Promise<any>(resolve => {
      slowStop = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')).stop;
      exitSlow = () => resolve({ status: 'exited', code: 0, signal: null, stderr: '', stdout: '{}' });
    }))) });
    expect(await slow.run(job(Buffer.from('workbook')))).toMatchObject({ state: 'failed', error: 'native-stage-timeout', native_app: 'unknown', staging_cleanup: 'after-helper-exit' });
    expect(await readFile(slowStop, 'utf8')).toBe('timeout');
    // The stage outlives the deadline until the helper itself exits. An unreadable answer and no receipt prove nothing
    // about Excel, so the stage stays for a later sweep instead of being reclaimed when the helper exits.
    exitSlow(); await slow.dispose(); expect(await access(slowStop)).toBeUndefined();
    await removeStage(dirname(dirname(slowStop)));
  });

  // The native staging lease for recalculation stages (a host may exit mid-run; Excel may outlive its helper).
  const ledgerFiles = async (ledger: string) => (await readdir(ledger)).sort();
  async function removeStage(stage: string) {
    if (dirname(stage) !== await realpath(tmpdir()) || !/^unode-recalc-/.test(basename(stage))) throw Error('unsafe fixture cleanup');
    await rm(stage, { recursive: true, force: true });
  }
  const excelReceipt = (input: { operationId: string; hostPid: number }, fields: object) => ({ version: 1, operation_id: input.operationId, host_pid: input.hostPid,
    helper_pid: 7001, process_name: 'EXCEL', ...fields });

  it('records an Excel stage as pending before the helper starts, so a sweep after a host exit finds it and cleans it only once helper and Excel are gone', async () => {
    const ledger = await folder(); const live = new Set<number>([7001, 7002]); let input: any; let pendingAtLaunch: string[] | undefined;
    const execute = vi.fn(async (request: any) => {
      input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')); pendingAtLaunch = await ledgerFiles(ledger);
      request.onSpawn?.(7001);
      // The host "exits" mid-run: the helper never answers this host.
      return new Promise<never>(() => {});
    });
    const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(execute), stagingLedger: ledger, ownerRunning: pid => live.has(pid) });
    const host = new AbortController(); void engine.run(job(Buffer.from('workbook'), host.signal));
    // The ledger is listed inside the launch, after an await: wait for that listing, not only for the call. Disk work
    // under a full parallel suite can take longer than waitFor's 1 s default.
    const pending = await vi.waitFor(() => { expect(pendingAtLaunch).toBeDefined(); return pendingAtLaunch!; }, { timeout: 10_000 });
    expect(pending.filter(name => name.endsWith('.pending.json'))).toHaveLength(1);
    expect(input).toMatchObject({ hostPid: process.pid, receipt: join(ledger, input.operationId + '.owner.json') });
    expect(input.operationId).toMatch(/^workbook-recalc-/);
    const record = JSON.parse(await readFile(join(ledger, pending.find(name => name.endsWith('.pending.json'))!), 'utf8'));
    expect(record.native).toMatchObject({ operation_id: input.operationId, receipt: input.receipt });
    // noteHelper's write is not awaited by the engine; a lost write never appears, so this still fails then.
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(ledger, pending.find(name => name.endsWith('.pending.json'))!), 'utf8')).native.helper_pid).toBe(7001), { timeout: 10_000 });
    const stage = dirname(input.source);
    // Another host sweeps. Its own host check sees this host as gone (the fixture's liveness answers for every pid).
    const sweep = () => new NativeStageCleanup(ledger, pid => live.has(pid)).recover();
    // A receipt from before Excel was identified names no native process: never read as "not started".
    await writeFile(input.receipt, JSON.stringify(excelReceipt(input, { phase: 'launching', native_app: 'not-started' })));
    live.delete(7001); await sweep(); expect(await access(stage)).toBeUndefined();
    // Excel identified and still running after its helper ended: kept, and nothing is ended.
    await writeFile(input.receipt, JSON.stringify(excelReceipt(input, { phase: 'unknown', native_app: 'left-running', native_pid: 7002 })));
    await sweep(); expect(await access(stage)).toBeUndefined();
    // Host, helper and Excel all gone: one claim cleans the stage and its records.
    live.delete(7002); await sweep();
    await expect(access(stage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await ledgerFiles(ledger)).toEqual([]);
    host.abort();
  });

  it('keeps the stage when the helper returns normally but Excel was left running or its state is unknown; a quit Excel releases it', async () => {
    for (const nativeApp of ['left-running', 'unknown', 'quit-by-helper'] as const) {
      const ledger = await folder(); const live = new Set<number>([7002]); let input: any;
      const execute = vi.fn(async (request: any) => {
        input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8'));
        await writeFile(input.receipt, JSON.stringify(excelReceipt(input, { phase: nativeApp === 'quit-by-helper' ? 'closed' : 'unknown', native_app: nativeApp, native_pid: 7002 })));
        return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'passed', app_version: '16.0',
          native_app: nativeApp, values: [{ i: 0, kind: 'n', value: '1' }, { i: 1, kind: 'n', value: '2' }] }) };
      });
      const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('excel.exe'), excelLaunch: excel(execute), stagingLedger: ledger, ownerRunning: pid => live.has(pid) });
      const result = await engine.run(job(Buffer.from('workbook')));
      const stage = dirname(input.source);
      if (nativeApp === 'quit-by-helper') {
        expect(result).toMatchObject({ state: 'passed', native_app: 'quit-by-helper', staging_cleanup: 'removed' });
        await expect(access(stage)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await ledgerFiles(ledger)).toEqual([]);
        continue;
      }
      expect(result).toMatchObject({ state: 'passed', native_app: nativeApp, staging_cleanup: 'not-removed' });
      expect(await access(stage)).toBeUndefined();
      expect((await ledgerFiles(ledger)).filter(name => name.endsWith('.pending.json'))).toHaveLength(1);
      // Once the Excel the receipt names has exited, the next sweep cleans the stage.
      live.delete(7002); await new NativeStageCleanup(ledger, pid => live.has(pid)).recover();
      await expect(access(stage)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await ledgerFiles(ledger)).toEqual([]);
    }
  });

  it('records a LibreOffice stage as pending before it starts and keeps it when the process tree could not be confirmed ended', async () => {
    const ledger = await folder(); const { EventEmitter } = await import('node:events'); let pendingAtSpawn: Promise<string[]> | undefined; let profile = '';
    const spawn = vi.fn((_command: string, args: string[]) => {
      profile = args[0]; pendingAtSpawn = ledgerFiles(ledger);
      return new EventEmitter();
    });
    const engine = new WorkbookRecalcEngine({ platform: 'linux', catalog: catalog('soffice'), stagingLedger: ledger, readText: async () => '',
      libreOffice: { spawn: spawn as any, terminate: vi.fn(async () => ({ status: 'unknown' as const, detail: 'fixture' })) as any, timeoutMs: 5 } });
    const result = await engine.run({ ...job(Buffer.from('workbook')), engine: 'libreoffice' });
    expect(result).toMatchObject({ state: 'failed', error: 'native-stage-timeout', native_app: 'left-running', staging_cleanup: 'not-removed' });
    // The listing started at spawn; its result is awaited rather than read whenever it happened to land.
    expect((await pendingAtSpawn!).filter(name => name.endsWith('.pending.json'))).toHaveLength(1);
    expect((await ledgerFiles(ledger)).filter(name => name.endsWith('.pending.json'))).toHaveLength(1);
    const stage = dirname(fileURLToPath(profile.slice('-env:UserInstallation='.length)));
    expect(basename(stage)).toMatch(/^unode-recalc-/); expect(await access(stage)).toBeUndefined();
    await removeStage(await realpath(stage));
  });


  it('does not start either engine when the host withdraws launch authority at the last check', async () => {
    const execute = vi.fn(); const spawn = vi.fn();
    for (const engine of ['excel', 'libreoffice'] as const) {
      const recalc = new WorkbookRecalcEngine({ platform: 'win32', catalog: catalog('engine.exe'), excelLaunch: excel(execute), libreOffice: { spawn: spawn as any } });
      const authorize = vi.fn(async () => {});
      const result = await recalc.run({ ...job(Buffer.from('workbook')), engine, authorize, launchAllowed: () => false });
      expect(authorize).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ state: 'cancelled', native_app: 'not-started', staging_cleanup: 'removed' });
    }
    expect(execute).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it('starts LibreOffice without a shell in a private always-recalculate profile and ends only that process tree on its time limit', async () => {
    expect(LIBREOFFICE_RECALC_PROFILE).toContain('<prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop>');
    expect(LIBREOFFICE_RECALC_PROFILE).toContain('<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>');
    const args = libreOfficeRecalcArguments(join(tmpdir(), 'p'), join(tmpdir(), 'o'), join(tmpdir(), 'c.xlsx'));
    expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\//); expect(args.slice(-4)).toEqual(['xlsx:Calc Office Open XML', '--outdir', join(tmpdir(), 'o'), join(tmpdir(), 'c.xlsx')]);
    const { EventEmitter } = await import('node:events'); const proc = new EventEmitter() as any; let options: any;
    const terminate = vi.fn(async () => ({ status: 'confirmed-stopped' as const }));
    const run = await runLibreOfficeRecalc({ executable: 'soffice', args, cwd: tmpdir(), signal: new AbortController().signal },
      { spawn: ((_command: string, _args: string[], spawnOptions: any) => { options = spawnOptions; return proc; }) as any, terminate: terminate as any, timeoutMs: 5 });
    expect(options.shell).toBe(false); expect(terminate).toHaveBeenCalledWith(proc); expect(run).toEqual({ status: 'timeout', native_app: 'ended' });
  });
});
void PACKAGE;
