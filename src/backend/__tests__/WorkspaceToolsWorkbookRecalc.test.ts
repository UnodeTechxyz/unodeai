import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { SessionWebAccessApprover, type WebAccessApprovalRequest, type WebAccessPolicyGate } from '../WebAccessPolicy';
import { workbookRouteReader, workbookRouteEditor } from './workbookRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { WorkbookRecalcEngine } from '../../office/WorkbookRecalcEngine';
import { LIBREOFFICE_RECALC_PROFILE } from '../../office/platform/LibreOfficeRecalc';
import { WINDOWS_EXCEL_RECALC_SCRIPT, windowsExcelRecalcLaunch } from '../../office/platform/WindowsExcelRecalc';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorkbookPackage } from '../../office/WorkbookCreate';
import { validateWorkbookCreateRequest } from '../../office/WorkbookEditContracts';
import { CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../../content/ContentAssetStore';

// Only the LibreOffice process is a fixture: it writes the cached results a real engine would. Host entry, native admission,
// command gate, Web access policy, worker scan/read/cache, source-version binding and the host commit are production code.
const owned: Array<{ tools: WorkspaceTools; close(): Promise<void> }> = [];
afterEach(async () => { for (const item of owned.splice(0)) { item.tools.retire(); await item.close(); } await removeTemporaryFolders(); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fakeLibreOffice(values: Record<string, string>, calls: string[][], during?: () => void) {
  return (_command: string, args: readonly string[]) => {
    calls.push([...args]); during?.(); const proc = new EventEmitter() as any; proc.pid = 4242;
    setTimeout(async () => {
      const copy = args.at(-1)!; const output = args[args.indexOf('--outdir') + 1];
      const zip = await JSZip.loadAsync(await fs.readFile(copy)); const name = 'xl/worksheets/sheet1.xml';
      let xml = await zip.file(name)!.async('string');
      for (const [cell, value] of Object.entries(values)) xml = xml.replace(new RegExp(`(<c r="${cell}"[^>]*>)(<f>[^<]*</f>)(?:<v>[^<]*</v>)?</c>`), `$1$2<v>${value}</v></c>`);
      zip.file(name, xml); await fs.writeFile(join(output, basename(copy)), await zip.generateAsync({ type: 'nodebuffer' }));
      proc.emit('exit', 0);
    }, 5);
    return proc;
  };
}
async function host(options: { values?: Record<string, string>; web?: WebAccessPolicyGate; nativePolicy?: () => string | undefined; allowed?: string[]; duringCommandApproval?: () => void; duringWriteApproval?: (preview: string) => void; duringEngine?: () => void; commands?: 'all' | 'ask' } = {}) {
  const root = await temporaryFolder('unode-recalc-route-'); const soffice = join(root, 'soffice-fixture.exe'); await fs.writeFile(soffice, 'inert fixture');
  const approvals: string[] = []; const spawned: string[][] = [];
  // 'all' asks only when the command analysis escalates (on Windows the engine's paths do, on Linux they do not); a test
  // that needs the command approval to happen uses 'ask', where an unlisted command always asks on every platform.
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(options.allowed ?? ['read', 'write', 'execute']), 'calc', undefined, new CommandPolicy(options.commands ?? 'all', []), 120000,
    async (command: string) => { approvals.push(command); options.duringCommandApproval?.(); return { allow: true }; }];
  if (options.duringWriteApproval) { parameters[11] = () => true; parameters[12] = async (request: { preview: string }) => { options.duringWriteApproval!(request.preview); return 'once' as const; }; }
  parameters[20] = options.web; const tools = new WorkspaceTools(...parameters);
  const reader = await workbookRouteReader(); tools.setWorkbookReader(reader); tools.setWorkbookEditor(await workbookRouteEditor()); tools.beginTurn();
  const catalog = { candidate: async (id: string) => id === 'libreoffice' ? { id: 'libreoffice' as const, path: soffice, sha256: 'a'.repeat(64), bytes: 13 } : undefined };
  tools.setOfficeApplicationCatalog(catalog);
  const engine = new WorkbookRecalcEngine({ catalog, readText: async () => 'buildid=0123456789abcdef\n', libreOffice: { spawn: fakeLibreOffice(options.values ?? {}, spawned, options.duringEngine) as any } });
  tools.setWorkbookRecalcEngine(engine); if (options.nativePolicy) tools.setNativeRenderPolicy(options.nativePolicy);
  owned.push({ tools, close: async () => { await engine.dispose(); await reader.dispose(); } });
  const created = await createWorkbookPackage({ directory: root, sheets: validateWorkbookCreateRequest({ schema_version: 1, path: 'x.xlsx', sheets: [{ name: 'Data', rows: [[null, 1], [5], [6]], formulas: { A1: 'B1+1' } }] }).sheets },
    CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES, () => {});
  await fs.writeFile(join(root, 'book.xlsx'), created.bytes);
  return { root, tools, approvals, spawned, engine };
}
async function edit(h: Awaited<ReturnType<typeof host>>, cells: Record<string, string>) {
  const inspected = await h.tools.run('read_workbook', { path: 'book.xlsx' }); expect(inspected.status, inspected.output).toBe('success');
  const result = await h.tools.run('edit_workbook', { schema_version: 1, path: 'book.xlsx', snapshot_ref: JSON.parse(inspected.output).snapshot_ref, edits: [
    { op: 'set_cells', sheet_id: 'sheet-1', range: 'B1', values: [[10]] }, { op: 'set_formulas', sheet_id: 'sheet-1', cells }] });
  expect(result.status, result.output).toBe('success'); return result.workbookWrite!.receipt!.workbook_edit_ref!;
}

it('recalculates the formula cells of an edit receipt through the actual handler, command approval and worker, then writes only their cache', async () => {
  const h = await host({ values: { A1: '11', E1: '21', E2: '11' }, commands: 'ask' }); const ref = await edit(h, { E1: 'A1+B1', E2: 'SUM(A2:A3)' });
  expect(h.tools.specs().some(spec => spec.function.name === 'recalculate_workbook')).toBe(true);
  const report = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  expect(report.status, report.output).toBe('success'); const evidence = JSON.parse(report.output);
  expect(evidence).toMatchObject({ kind: 'workbook-recalculation', state: 'passed', recalculated: true, cache_written: false, engine: 'libreoffice build 0123456789ab', native_app: 'ended', staging_cleanup: 'removed' });
  expect(evidence.values.map((value: any) => [value.cell, value.type, value.value, value.recalculated])).toEqual([['E1', 'n', '21', true], ['E2', 'n', '11', true]]);
  expect(h.approvals).toHaveLength(1); expect(h.approvals[0]).toContain('soffice-fixture'); expect(h.approvals[0]).toContain('--convert-to');
  const before = await fs.readFile(join(h.root, 'book.xlsx'));
  const cached = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', write_cache: true, targets: { from_receipt: ref } });
  expect(cached.status, cached.output).toBe('success'); expect(JSON.parse(cached.output)).toMatchObject({ cache_written: true, cache_cells: ['sheet-1!E1', 'sheet-1!E2'] });
  const after = await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx'))); const sheet = await after.file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('<c r="E1"><f>A1+B1</f><v>21</v></c>'); expect(sheet).toContain('<c r="E2"><f>SUM(A2:A3)</f><v>11</v></c>'); expect(sheet).toContain('<c r="A1"><f>B1+1</f></c>');
  const original = await JSZip.loadAsync(before);
  for (const name of ['xl/workbook.xml', 'xl/styles.xml', '[Content_Types].xml']) expect(await after.file(name)!.async('string'), name).toBe(await original.file(name)!.async('string'));
  // The same receipt is bound to the bytes it saved: after the cache write the file changed, so it no longer runs.
  const stale = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  expect(stale.status).toBe('failed'); expect(stale.output).toContain('source-changed'); expect(h.spawned).toHaveLength(2);
});

it('does not start an engine for local code, Commands Off or a native policy; formula writing still succeeds', async () => {
  const h = await host(); const ref = await edit(h, { E1: 'CALL("user32","MessageBoxA","JJCCJ",0,"x","y",0)' });
  const native = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', targets: { from_receipt: ref } });
  expect(native.status).toBe('success'); expect(JSON.parse(native.output)).toMatchObject({ state: 'recalc-not-run', recalculated: false, reasons: [{ location: 'Data!E1' }] });
  expect(native.output).toContain('runs local code'); expect(h.spawned).toHaveLength(0); expect(h.approvals).toHaveLength(0);
  const off = await host({ allowed: ['read', 'write'] });
  expect(off.tools.specs().some(spec => spec.function.name === 'recalculate_workbook')).toBe(false);
  expect(await off.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1'] }] } })).toMatchObject({ status: 'refused', reason: 'capability' });
  const plan = await host({ nativePolicy: () => 'Native Office rendering cannot run under this agent’s current Plan/read-only execution policy.' });
  const notRun = await plan.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1'] }] } });
  expect(JSON.parse(notRun.output)).toMatchObject({ state: 'not-run' }); expect(plan.spawned).toHaveLength(0);
});

// Security re-audit finding 1, Owner 2026-11-22: RTD starts the COM server registered under its ProgID, so it is local code.
// With Web access Allow (the default) nothing is asked, no engine starts and the formula stays saved.
it('RTD is local code: with Web access Allow no engine starts, no Web ask is made, and the formula is still written', async () => {
  const requestApproval = vi.fn(async () => ({ allow: true }));
  const h = await host({ web: { policy: () => 'allow', requestApproval } as WebAccessPolicyGate });
  const ref = await edit(h, { E1: 'RTD("Some.RtdServer",,"x")' });
  const outcome = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  expect(outcome.status).toBe('success');
  expect(JSON.parse(outcome.output)).toMatchObject({ state: 'recalc-not-run', recalculated: false, reasons: [{ location: 'Data!E1' }] });
  expect(outcome.output).toContain('runs local code (CALL, REGISTER.ID, RTD or DDE)'); expect(outcome.output).not.toContain('reads the web');
  expect(h.spawned).toHaveLength(0); expect(h.approvals).toHaveLength(0); expect(requestApproval).not.toHaveBeenCalled();
});

it('routes a formula with a computed web address through the existing Web access ask, reuses a remembered session approval, and keeps Off and a denial unrun', async () => {
  const asked: WebAccessApprovalRequest[] = []; let answer = { allow: false } as { allow: boolean; remember?: boolean }; let setting: unknown = 'ask';
  const approver = new SessionWebAccessApprover(async request => { asked.push(request); return answer; });
  const web: WebAccessPolicyGate = { policy: () => setting, requestApproval: approver.requestApproval };
  const h = await host({ web, values: { E1: '"ok"' } }); const ref = await edit(h, { E1: 'WEBSERVICE("https://example.invalid/q?x="&A1)' });
  const target = { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } };
  const denied = await h.tools.run('recalculate_workbook', target);
  expect(JSON.parse(denied.output)).toMatchObject({ state: 'recalc-not-run', reasons: [{ location: 'Data!E1' }] }); expect(h.spawned).toHaveLength(0);
  expect(asked).toHaveLength(1); expect(asked[0]).toMatchObject({ toolName: 'recalculate_workbook' }); expect(asked[0].url).toBeUndefined();
  expect(asked[0].purpose).toContain('the target address is generated by a formula at Data!E1');
  answer = { allow: true, remember: true };
  expect(JSON.parse((await h.tools.run('recalculate_workbook', target)).output)).toMatchObject({ state: 'passed', network_reads: ['Data!E1'] }); expect(asked).toHaveLength(2);
  expect(JSON.parse((await h.tools.run('recalculate_workbook', target)).output)).toMatchObject({ state: 'passed' }); expect(asked).toHaveLength(2);
  setting = 'off';
  const off = await h.tools.run('recalculate_workbook', target);
  expect(JSON.parse(off.output)).toMatchObject({ state: 'recalc-not-run' }); expect(off.output).toContain('Team panel > Permissions > Web access'); expect(h.spawned).toHaveLength(2);
});

it('does not start the engine when native admission is withdrawn while the Web access ask is open', async () => {
  const admission: { policy?: string } = {}; let release!: (value: { allow: boolean }) => void;
  const web: WebAccessPolicyGate = { policy: () => 'ask', requestApproval: () => new Promise(resolve => { release = resolve; }) };
  const h = await host({ web, nativePolicy: () => admission.policy }); const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
  const running = h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  await vi.waitFor(() => expect(release).toBeDefined());
  admission.policy = 'Native Office rendering cannot run under this agent’s current Plan/read-only execution policy.'; release({ allow: true });
  const result = await running; expect(result.status).toBe('failed'); expect(result.output).toContain('No cached value was written'); expect(h.spawned).toHaveLength(0); expect(h.approvals).toHaveLength(0);
  void sha;
});

it('audit F1: Web access turned Off while its ask is open stops the launch even though the ask is then allowed', async () => {
  const live = { setting: 'ask' as unknown }; let release!: (value: { allow: boolean }) => void;
  const web: WebAccessPolicyGate = { policy: () => live.setting, requestApproval: () => new Promise(resolve => { release = resolve; }) };
  const h = await host({ web, values: { E1: '1' } }); const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
  const running = h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  await vi.waitFor(() => expect(release).toBeDefined());
  live.setting = 'off'; release({ allow: true });
  const result = await running;
  expect(JSON.parse(result.output)).toMatchObject({ state: 'recalc-not-run', recalculated: false, reasons: [{ location: 'Data!E1' }] });
  expect(result.output).toContain('Team panel > Permissions > Web access'); expect(h.spawned).toHaveLength(0);
});

it('audit F1: Web access turned Off during the command approval stops the launch', async () => {
  const live = { setting: 'allow' as unknown };
  const web: WebAccessPolicyGate = { policy: () => live.setting, requestApproval: async () => ({ allow: true }) };
  const h = await host({ web, values: { E1: '1' }, commands: 'ask', duringCommandApproval: () => { live.setting = 'off'; } }); const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
  const result = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  expect(h.approvals).toHaveLength(1);
  expect(JSON.parse(result.output)).toMatchObject({ state: 'recalc-not-run', recalculated: false, reasons: [{ location: 'Data!E1' }] });
  expect(result.output).toContain('Team panel > Permissions > Web access'); expect(h.spawned).toHaveLength(0);
});

it('audit F3: Web access turned Off while the cache save waits for Write approval still saves the values already computed', async () => {
  const live = { setting: 'allow' as unknown }; const previews: string[] = [];
  const web: WebAccessPolicyGate = { policy: () => live.setting, requestApproval: async () => ({ allow: true }) };
  const h = await host({ web, values: { E1: '11' }, duringWriteApproval: preview => { previews.push(preview); if (preview.startsWith('Write recalculated cached values')) live.setting = 'off'; } });
  const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
  const result = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', write_cache: true, targets: { from_receipt: ref } });
  expect(h.spawned).toHaveLength(1); expect(live.setting).toBe('off');
  expect(result.status, result.output).toBe('success');
  expect(JSON.parse(result.output)).toMatchObject({ state: 'passed', cache_written: true, cache_cells: ['sheet-1!E1'], values: [{ cell: 'E1', value: '11', recalculated: true }] });
  const sheet = await (await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx')))).file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('<c r="E1"><f>WEBSERVICE(A1)</f><v>11</v></c>');
});

it('audit F3: Web access turned Off while the engine runs returns the values it produced, never "not run"', async () => {
  const live = { setting: 'allow' as unknown };
  const web: WebAccessPolicyGate = { policy: () => live.setting, requestApproval: async () => ({ allow: true }) };
  const h = await host({ web, values: { E1: '11' }, duringEngine: () => { live.setting = 'off'; } }); const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
  const result = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { from_receipt: ref } });
  expect(h.spawned).toHaveLength(1); expect(result.status, result.output).toBe('success');
  expect(JSON.parse(result.output)).toMatchObject({ state: 'passed', recalculated: true, values: [{ cell: 'E1', value: '11' }] });
});

/** Adds an Excel 4 macro sheet holding `formula` to the host's book.xlsx. */
async function addMacroSheet(root: string, formula: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'book.xlsx')));
  const book = await zip.file('xl/workbook.xml')!.async('string'); const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const relNs = /xmlns:r="([^"]+)"/.exec(book)![1];
  zip.file('xl/workbook.xml', book.replace('</sheets>', '<sheet name="Macro1" sheetId="9" r:id="rMacro"/></sheets>'));
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rMacro" Type="${relNs}/macrosheet" Target="macrosheets/sheet9.xml"/></Relationships>`));
  zip.file('xl/macrosheets/sheet9.xml', `<xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>${formula}</f></c></row><row r="2"><c r="A2"><f>RETURN()</f></c></row></sheetData></xm:macrosheet>`);
  await fs.writeFile(join(root, 'book.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

it('Owner decision: an Excel 4 macro sheet alone does not stop a recalculation, and the engine still runs with macros disabled', async () => {
  let profile = ''; let settings = '';
  const h = await host({ values: { A1: '11' }, duringEngine: () => {
    profile = h.spawned.at(-1)![0];
    settings = readFileSync(join(fileURLToPath(profile.slice('-env:UserInstallation='.length)), 'user', 'registrymodifications.xcu'), 'utf8');
  } });
  await addMacroSheet(h.root, 'GET.CELL(48,Data!A1)');
  const inspected = await h.tools.run('read_workbook', { path: 'book.xlsx' }); expect(inspected.status, inspected.output).toBe('success');
  const report = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1'] }] } });
  expect(report.status, report.output).toBe('success');
  expect(JSON.parse(report.output)).toMatchObject({ state: 'passed', recalculated: true, values: [{ cell: 'A1', value: '11', recalculated: true }] });
  expect(report.output).not.toContain('runs local code'); expect(h.spawned).toHaveLength(1);
  // The private profile the engine started with keeps macros disabled.
  expect(profile).toMatch(/^-env:UserInstallation=file:/); expect(settings).toBe(LIBREOFFICE_RECALC_PROFILE);
  expect(settings).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>');
  // The Excel helper forces VBA macros off before it opens the copy (AutomationSecurity 3 = msoAutomationSecurityForceDisable);
  // that does not cover Excel 4 macros, which are left out of the engine's copy instead (X2 audit item 3 tests below).
  expect(WINDOWS_EXCEL_RECALC_SCRIPT).toContain('$app.AutomationSecurity = 3');
  // A CALL inside the macro sheet is still local code: nothing starts.
  const call = await host();
  await addMacroSheet(call.root, 'CALL("user32","MessageBoxA","JJCCJ",0,"x","y",0)');
  const refused = await call.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'libreoffice', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1'] }] } });
  expect(JSON.parse(refused.output)).toMatchObject({ state: 'recalc-not-run', reasons: [{ location: 'Macro1 (Excel 4 macro sheet)' }] });
  expect(refused.output).toContain('runs local code (CALL, REGISTER.ID, RTD or DDE)'); expect(call.spawned).toHaveLength(0);
});

/** An Excel engine on the host whose only fixture is the helper process: it answers `values` and counts its starts. */
function excelEngine(h: Awaited<ReturnType<typeof host>>, values: Array<{ i: number; kind: string; value?: string; code?: number }>) {
  const program = join(h.root, 'soffice-fixture.exe'); const starts: string[] = [];
  const catalog = { candidate: async (id: string) => id === 'excel' ? { id: 'excel' as const, path: program, sha256: 'a'.repeat(64), bytes: 13 } : undefined };
  const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog, excelLaunch: () => windowsExcelRecalcLaunch({ env: { SystemRoot: 'system-root-fixture' }, resolve: () => program,
    execute: async request => {
      const job = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')); starts.push(job.operationId);
      return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', native_app: 'quit-by-helper', app_version: '16.0', values }) };
    } }) });
  h.tools.setOfficeApplicationCatalog(catalog); h.tools.setWorkbookRecalcEngine(engine);
  owned.push({ tools: h.tools, close: () => engine.dispose() });
  return { engine, starts };
}

it('X2 audit F1: Web access is read again after the pending-stage record is written; Off starts no engine, an unchanged Allow starts one', async () => {
  for (const adapter of ['libreoffice', 'excel'] as const) for (const revoke of [false, true]) {
    let setting: unknown = 'allow';
    const h = await host({ values: { E1: '11' }, web: { policy: () => setting, requestApproval: async () => ({ allow: true }) } });
    const ref = await edit(h, { E1: 'WEBSERVICE(A1)' });
    const excel = adapter === 'excel' ? excelEngine(h, [{ i: 0, kind: 'n', value: '11' }]) : undefined;
    const engine = excel?.engine ?? h.engine; const stages = (engine as unknown as { stages: { defer(...args: unknown[]): Promise<void>; release(...args: unknown[]): Promise<boolean> } }).stages;
    // Web access turns Off exactly while the new pending-stage record is written, after every earlier launch check.
    const defer = stages.defer.bind(stages); let recorded = 0;
    stages.defer = async (...args: unknown[]) => { await defer(...args); recorded++; if (revoke) setting = 'off'; };
    const release = stages.release.bind(stages); const released: boolean[] = [];
    stages.release = async (...args: unknown[]) => { const removed = await release(...args); released.push(removed); return removed; };
    const result = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter, targets: { from_receipt: ref } });
    const starts = excel ? excel.starts.length : h.spawned.length;
    expect(recorded, `${adapter} ${revoke}`).toBe(1);
    if (revoke) {
      expect(starts, `${adapter} Off`).toBe(0);
      // The recorded but never started stage is released on the host's own not-started observation.
      expect(released, `${adapter} Off release`).toEqual([true]);
      expect(JSON.parse(result.output)).toMatchObject({ state: 'recalc-not-run' }); expect(result.output).toContain('Team panel > Permissions > Web access');
    } else {
      expect(starts, `${adapter} Allow`).toBe(1); expect(JSON.parse(result.output)).toMatchObject({ state: 'passed', recalculated: true });
    }
  }
});

it('X2 audit F2: an Excel #BLOCKED! or #NAME? is reported as observed but unrecalculated and never cached; #DIV/0! stays a computed result', async () => {
  for (const [code, text, reason] of [[2047, '#BLOCKED!', 'engine-evaluation-blocked'], [2029, '#NAME?', 'engine-unsupported-function'], [2007, '#DIV/0!', undefined]] as const) {
    const h = await host(); const ref = await edit(h, { E1: 'GET.CELL(48,A1)' }); const excel = excelEngine(h, [{ i: 0, kind: 'e', code }]);
    const result = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'excel', write_cache: true, targets: { from_receipt: ref } });
    expect(result.status, result.output).toBe('success'); expect(excel.starts).toHaveLength(1);
    const output = JSON.parse(result.output);
    const sheet = await (await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx')))).file('xl/worksheets/sheet1.xml')!.async('string');
    if (reason) {
      expect(output.values).toEqual([expect.objectContaining({ cell: 'E1', type: 'e', value: text, recalculated: false, error: reason })]);
      expect(output.recalculated).toBe(false); expect(output.cache_cells).toEqual([]); expect(output.cache_skipped).toEqual(['sheet-1!E1']); expect(sheet).not.toContain(text);
    } else {
      expect(output.values).toEqual([expect.objectContaining({ cell: 'E1', type: 'e', value: text, recalculated: true })]);
      expect(output.cache_cells).toEqual(['sheet-1!E1']); expect(sheet).toContain(`<c r="E1" t="e"><f>GET.CELL(48,A1)</f><v>${text}</v></c>`);
    }
  }
});

/** Puts an Excel 4 macro sheet (Excel's own xlMacrosheet form) before the worksheets and adds Data!E1 = Macro1!A1*2. */
async function addLeadingMacroSheet(root: string, cells = '<c r="E1"><f>Macro1!A1*2</f></c>', names = '') {
  const zip = await JSZip.loadAsync(await fs.readFile(join(root, 'book.xlsx')));
  const book = await zip.file('xl/workbook.xml')!.async('string'); const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const types = await zip.file('[Content_Types].xml')!.async('string'); const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  zip.file('xl/workbook.xml', book.replace(/<sheets>/, '<sheets><sheet name="Macro1" sheetId="9" r:id="rMacro" state="hidden"/>')
    .replace('</sheets>', names ? `</sheets><definedNames>${names}</definedNames>` : '</sheets>'));
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rMacro" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet9.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/macrosheets/sheet9.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>'));
  zip.file('xl/macrosheets/sheet9.xml', '<xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>ALERT("hi")</f></c></row></sheetData></xm:macrosheet>');
  zip.file('xl/worksheets/sheet1.xml', sheet.replace('</row>', `${cells}</row>`));
  await fs.writeFile(join(root, 'book.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

it('X2 audit item 3: the engine opens a private copy without the macro sheet; a dependent cell is unrecalculated and uncached, an independent one computed', async () => {
  const h = await host(); await addLeadingMacroSheet(h.root);
  let copyParts: string[] = []; let input: any;
  const program = join(h.root, 'soffice-fixture.exe');
  const catalog = { candidate: async (id: string) => id === 'excel' ? { id: 'excel' as const, path: program, sha256: 'a'.repeat(64), bytes: 13 } : undefined };
  const engine = new WorkbookRecalcEngine({ platform: 'win32', catalog, excelLaunch: () => windowsExcelRecalcLaunch({ env: { SystemRoot: 'system-root-fixture' }, resolve: () => program,
    execute: async request => {
      input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')); copyParts = Object.keys((await JSZip.loadAsync(await fs.readFile(input.source))).files);
      return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: input.operationId, status: 'passed', native_app: 'quit-by-helper', app_version: '16.0',
        values: [{ i: 0, kind: 'n', value: '11' }, { i: 1, kind: 'e', code: 2023 }] }) };
    } }) });
  h.tools.setOfficeApplicationCatalog(catalog); h.tools.setWorkbookRecalcEngine(engine); owned.push({ tools: h.tools, close: () => engine.dispose() });
  const before = await fs.readFile(join(h.root, 'book.xlsx'));
  const target = { schema_version: 1, path: 'book.xlsx', adapter: 'excel', targets: { cells: [{ sheet_id: 'sheet-2', refs: ['A1', 'E1'] }] } };
  const report = await h.tools.run('recalculate_workbook', target); expect(report.status, report.output).toBe('success');
  const output = JSON.parse(report.output);
  expect(output).toMatchObject({ state: 'passed', macro_sheets_left_out_of_engine_copy: ['Macro1'] });
  expect(output.values.map((value: any) => [value.cell, value.value, value.recalculated, value.error])).toEqual([['A1', '11', true, undefined], ['E1', '#REF!', false, 'depends-on-macro-sheet']]);
  // The engine saw only the stripped copy, with positions of that copy; the person's file did not change.
  expect(copyParts.filter(name => /macrosheet/i.test(name))).toEqual([]); expect(input.targets.map((item: any) => item.position)).toEqual([1, 1]);
  expect((await fs.readFile(join(h.root, 'book.xlsx'))).equals(before)).toBe(true);
  // The cache keeps the dependent cell out and leaves the macro sheet in the person's workbook.
  const cached = await h.tools.run('recalculate_workbook', { ...target, write_cache: true }); expect(cached.status, cached.output).toBe('success');
  expect(JSON.parse(cached.output)).toMatchObject({ cache_cells: ['sheet-2!A1'], cache_skipped: ['sheet-2!E1'] });
  const saved = await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx')));
  expect(saved.file('xl/macrosheets/sheet9.xml')).not.toBeNull(); expect(await saved.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<c r="E1"><f>Macro1!A1*2</f></c>');
});

it('X2 re-audit 1: with a macro sheet left out, a reference built from text (INDIRECT) is unrecalculated and uncached like a direct one; an independent cell is computed', async () => {
  const h = await host();
  await addLeadingMacroSheet(h.root, '<c r="E1"><f>IFERROR(INDIRECT("Macro1!A1"),99)</f></c><c r="F1"><f>IFERROR(Macro1!A1,99)</f></c><c r="G1"><f>E1+1</f></c>');
  // The engine (Excel transport faked) answers the plausible fallbacks the stripped copy gives.
  const excel = excelEngine(h, [{ i: 0, kind: 'n', value: '11' }, { i: 1, kind: 'n', value: '99' }, { i: 2, kind: 'n', value: '99' }, { i: 3, kind: 'n', value: '100' }]);
  const report = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'excel', write_cache: true, targets: { cells: [{ sheet_id: 'sheet-2', refs: ['A1', 'E1:G1'] }] } });
  expect(report.status, report.output).toBe('success'); expect(excel.starts).toHaveLength(1);
  const output = JSON.parse(report.output);
  expect(output.values.map((value: any) => [value.cell, value.value, value.recalculated, value.error])).toEqual([
    ['A1', '11', true, undefined], ['E1', '99', false, 'depends-on-macro-sheet'], ['F1', '99', false, 'depends-on-macro-sheet'], ['G1', '100', false, 'depends-on-macro-sheet']]);
  expect(output).toMatchObject({ cache_cells: ['sheet-2!A1'], cache_skipped: ['sheet-2!E1', 'sheet-2!F1', 'sheet-2!G1'] });
  const sheet = await (await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx')))).file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('<c r="E1"><f>IFERROR(INDIRECT("Macro1!A1"),99)</f></c>'); expect(sheet).not.toMatch(/<v>99<\/v>/);
  // Ordinary calculation is unchanged: without a macro sheet, an INDIRECT formula is computed and cached.
  const plain = await host(); const ref = await edit(plain, { E1: 'INDIRECT("B1")+1' }); const plainExcel = excelEngine(plain, [{ i: 0, kind: 'n', value: '11' }]);
  const computed = await plain.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'excel', write_cache: true, targets: { from_receipt: ref } });
  expect(computed.status, computed.output).toBe('success'); expect(plainExcel.starts).toHaveLength(1);
  expect(JSON.parse(computed.output)).toMatchObject({ values: [{ cell: 'E1', value: '11', recalculated: true }], cache_cells: ['sheet-1!E1'] });
});

it('X2 re-audit 2: with a macro sheet left out, OFFSET from a clean defined name counts as dependent like a direct base; its dependents follow', async () => {
  const h = await host();
  await addLeadingMacroSheet(h.root, '<c r="E1"><f>IFERROR(Macro1!A1,99)</f></c><c r="F1"><f>OFFSET(Anchor,0,3)+1</f></c><c r="G1"><f>F1+1</f></c>',
    '<definedName name="Anchor">Data!$B$1</definedName>');
  const excel = excelEngine(h, [{ i: 0, kind: 'n', value: '11' }, { i: 1, kind: 'n', value: '99' }, { i: 2, kind: 'n', value: '100' }, { i: 3, kind: 'n', value: '101' }]);
  const report = await h.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'excel', write_cache: true, targets: { cells: [{ sheet_id: 'sheet-2', refs: ['A1', 'E1:G1'] }] } });
  expect(report.status, report.output).toBe('success'); expect(excel.starts).toHaveLength(1);
  const output = JSON.parse(report.output);
  expect(output.values.map((value: any) => [value.cell, value.value, value.recalculated, value.error])).toEqual([
    ['A1', '11', true, undefined], ['E1', '99', false, 'depends-on-macro-sheet'], ['F1', '100', false, 'depends-on-macro-sheet'], ['G1', '101', false, 'depends-on-macro-sheet']]);
  expect(output).toMatchObject({ cache_cells: ['sheet-2!A1'], cache_skipped: ['sheet-2!E1', 'sheet-2!F1', 'sheet-2!G1'] });
  const sheet = await (await JSZip.loadAsync(await fs.readFile(join(h.root, 'book.xlsx')))).file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('<c r="F1"><f>OFFSET(Anchor,0,3)+1</f></c>'); expect(sheet).not.toMatch(/<v>(?:99|100|101)<\/v>/);
  // Ordinary calculation is unchanged: without a macro sheet, OFFSET is computed and cached.
  const plain = await host(); const ref = await edit(plain, { E1: 'OFFSET(B1,0,0)+1' }); const plainExcel = excelEngine(plain, [{ i: 0, kind: 'n', value: '11' }]);
  const computed = await plain.tools.run('recalculate_workbook', { schema_version: 1, path: 'book.xlsx', adapter: 'excel', write_cache: true, targets: { from_receipt: ref } });
  expect(computed.status, computed.output).toBe('success'); expect(plainExcel.starts).toHaveLength(1);
  expect(JSON.parse(computed.output)).toMatchObject({ values: [{ cell: 'E1', value: '11', recalculated: true }], cache_cells: ['sheet-1!E1'] });
});
