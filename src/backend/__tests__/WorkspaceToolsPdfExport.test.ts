import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument } from 'pdf-lib';
import { WorkspaceTools, type CommandApprover, type WriteApprover } from '../WorkspaceTools';
import { pdfExportDestination, personPdfExportResult } from '../../host/fileActions';
import { runPersonPdfExport, type PersonPdfExportPorts } from '../../host/personOfficeExport';
import type { ChatMode } from '../../types';
import { CommandPolicy } from '../CommandPolicy';
import { CodexBackend } from '../CodexBackend';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { CODEX_CLI_DEFAULT_MODEL } from '../CodexBackend';
import { OfficeReader } from '../../office/OfficeReader';
import { NativeOfficeRenderer } from '../../office/NativeOfficeRenderer';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../../office/WindowsOfficeScript';
import { WINDOWS_PDF_RASTER_SCRIPT } from '../../office/WindowsPdfScript';
import { EXPORT_PDF_TOOL } from '../../office/OfficeExportTool';
import { isToolAllowedInPlan } from '../planMode';
import type { WindowsPowerShellDocumentRequest, WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';
import type { AgentConfig } from '../../types';
import { officeRouteReader } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { managedCodexTransport, managedClaudeTransport } from './managedNativeFixtures';
import { fixedCodexProgram } from './codexProgramFixture';

// Real host entry: source reader/worker, admission, command gate, operation queue, renderer stage and copy worker,
// PDF.js page count and the common file-write boundary. Only the native helper transport and executable lookup are fixtures:
// the fake helper writes a real PDF where the native application would.
const lookup = vi.hoisted(() => ({ executable: '' }));
vi.mock('../../security/HostExecutableResolver', async importOriginal => ({ ...await importOriginal<any>(), resolveHostExecutable: () => lookup.executable }));
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let reader: Awaited<ReturnType<typeof officeRouteReader>>; let worker: string; let source: Buffer; let pdf: Buffer;
const roots = new Set<string>(); const owned: WorkspaceTools[] = []; const backends: Array<{ stop(): Promise<unknown> }> = [];
beforeAll(async () => {
  const ppt = new PptxGenJS(); ppt.addSlide().addText('Exported deck', { x: 1, y: 1, w: 6, h: 1 }); ppt.addSlide().addText('Second', { x: 1, y: 1, w: 6, h: 1 });
  source = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer); reader = await officeRouteReader(); roots.add(dirname((reader as any).worker));
  worker = join(dirname((reader as any).worker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const doc = await PDFDocument.create(); doc.addPage(); doc.addPage(); pdf = Buffer.from(await doc.save());
});
afterEach(async () => { for (const backend of backends.splice(0)) await backend.stop(); for (const tools of owned.splice(0)) { tools.retire(); await tools.disposeBackground(); } vi.unstubAllEnvs(); });
afterAll(async () => {
  await reader.dispose();
  for (const root of roots) { const real = await fs.realpath(root); expect(dirname(real)).toBe(await fs.realpath(tmpdir())); expect(basename(real)).toMatch(/^unode-(?:pdf-export-|office-route-worker-)/); }
  await removeTemporaryFolders();
});
type Helper = (job: any, request: WindowsPowerShellDocumentRequest) => Promise<WindowsPowerShellDocumentResult | void>;
const answer = (job: any, fields: object = {}): WindowsPowerShellDocumentResult => ({ status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1,
  operation_id: job.operationId, status: 'passed', page_count: 0, completed_pages: 0, document_closed: true, app_version: '16.0', native_app: 'quit-by-helper', stage_released: true, ...fields }) });
async function host(options: { allowed?: string[]; mode?: 'all' | 'ask' | 'none'; helper?: Helper; policy?: () => string | undefined;
  approveCommand?: CommandApprover; approveWrite?: WriteApprover } = {}) {
  const root = await temporaryFolder('unode-pdf-export-'); roots.add(root);
  lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture'); vi.stubEnv('SystemRoot', 'C:\\Windows');
  const policy = new CommandPolicy(options.mode ?? 'all', []);
  const tools = new WorkspaceTools(root, new Set(options.allowed ?? ['read', 'write', 'execute']), 'exporter', undefined, policy, 120000,
    options.approveCommand, undefined, undefined, undefined, undefined, options.approveWrite ? () => true : undefined, options.approveWrite); owned.push(tools);
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.beginTurn(); await fs.writeFile(join(root, 'deck.pptx'), source);
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_OFFICE_RENDER_SCRIPT); expect(request.helperClosesApplication).toBe(true);
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    const custom = await options.helper?.(job, request); if (custom) return custom;
    await fs.writeFile(job.pdf, pdf); return answer(job);
  });
  const catalog = { candidate: vi.fn(async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: join(root, 'inert-' + id + '.exe'), sha256: 'a'.repeat(64), bytes: 1 })) };
  const renderer = new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(worker), execute, catalog });
  tools.useNativeOfficeRenderer(renderer);
  // v0.9.108 (L1): automatic selection (the person's Export PDF) finds the same installed fixtures.
  tools.setOfficeApplicationCatalog(catalog as never);
  if (options.policy) (tools as any).nativeRenderPolicy = options.policy;
  const inspected = await tools.run('inspect_office', { path: 'deck.pptx' }); expect(inspected.status, inspected.output).toBe('success');
  return { root, tools, execute, renderer, catalog, snapshot: JSON.parse(inspected.output).snapshot_ref as string };
}

it('exports the inspected deck through the native path and saves the exact PDF with a receipt and source lineage', async () => {
  const f = await host(); const written = vi.spyOn((f.tools as any).contentAssets, 'noteOfficeWritten');
  expect(f.tools.specs().map(spec => spec.function.name)).toContain(EXPORT_PDF_TOOL);
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'out/deck.pdf', adapter_id: 'powerpoint' });
  expect(outcome.status, outcome.output).toBe('success');
  expect(await fs.readFile(join(f.root, 'out', 'deck.pdf'))).toEqual(pdf);
  const receipt = JSON.parse(outcome.output);
  expect(receipt).toMatchObject({ kind: 'pdf-exported', path: 'out/deck.pdf', bytes: pdf.length, sha256: digest(pdf), pages: 2, engine: 'powerpoint',
    source_sha256: digest(source), copy_partial: expect.any(Boolean), removed: { parts: expect.any(Number), part_names: expect.any(Array) }, effect: 'created',
    native_stop: { operation: 'completed', native_app: 'quit-by-helper', output: 'kept', staging: 'removed' } });
  const job = JSON.parse(Buffer.from(f.execute.mock.calls[0][0].input, 'base64').toString());
  expect(job).toMatchObject({ intent: 'deliver-pdf', kind: 'pptx', requirePrivateApplication: false });
  expect(written).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf', sourceSha256: digest(source), sha256: digest(pdf) }));
  expect(await fs.readFile(join(f.root, 'deck.pptx'))).toEqual(source);
});
it('never saves over its own inspected source, even when the Office package is named .pdf', async () => {
  const f = await host(); await fs.writeFile(join(f.root, 'original.pdf'), source);
  const snapshot = JSON.parse((await f.tools.run('inspect_office', { path: 'original.pdf' })).output).snapshot_ref;
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'original.pdf', adapter_id: 'powerpoint' });
  expect(outcome.status).toBe('failed'); expect(outcome.output).toContain('Choose a different destination path ending in .pdf');
  expect(f.execute).not.toHaveBeenCalled(); expect(await fs.readFile(join(f.root, 'original.pdf'))).toEqual(source);
  // A distinct destination from the same misnamed source still exports, with its receipt and lineage.
  const written = vi.spyOn((f.tools as any).contentAssets, 'noteOfficeWritten');
  const other = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'exported.pdf', adapter_id: 'powerpoint' });
  expect(other.status, other.output).toBe('success'); expect(JSON.parse(other.output)).toMatchObject({ kind: 'pdf-exported', path: 'exported.pdf', sha256: digest(pdf), source_sha256: digest(source) });
  expect(written).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf', sourceSha256: digest(source), sha256: digest(pdf) }));
  expect(await fs.readFile(join(f.root, 'original.pdf'))).toEqual(source); expect(await fs.readFile(join(f.root, 'exported.pdf'))).toEqual(pdf);
});
it('rechecks source identity at the commit: a destination redirected onto the source during the export saves nothing', async () => {
  let root = '';
  const f = await host({ helper: async job => {
    // While the native stage runs, the destination folder becomes a junction to the folder holding the source.
    await fs.rm(join(root, 'out'), { recursive: true }); await fs.symlink(root, join(root, 'out'), 'junction');
    await fs.writeFile(job.pdf, pdf); return answer(job);
  } });
  root = f.root; await fs.mkdir(join(root, 'out')); await fs.writeFile(join(root, 'deck-copy.pdf'), source);
  const snapshot = JSON.parse((await f.tools.run('inspect_office', { path: 'deck-copy.pdf' })).output).snapshot_ref;
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'out/deck-copy.pdf', adapter_id: 'powerpoint' });
  expect(f.execute).toHaveBeenCalledTimes(1); expect(outcome.status).not.toBe('success');
  expect(outcome.output).toContain('Choose a different destination path ending in .pdf'); expect(await fs.readFile(join(root, 'deck-copy.pdf'))).toEqual(source);
  await fs.unlink(join(root, 'out'));
});
it('proposes only the native export script for approval, never the page-capture script', async () => {
  const f = await host(); const gate = vi.spyOn(f.tools as any, 'normalizeAndGate');
  expect((await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' })).status).toBe('success');
  const command = String(gate.mock.calls[0][0]);
  expect(command).toContain(Buffer.from(WINDOWS_OFFICE_RENDER_SCRIPT, 'utf16le').toString('base64'));
  expect(command).not.toContain(Buffer.from(WINDOWS_PDF_RASTER_SCRIPT, 'utf16le').toString('base64'));
  expect(String(gate.mock.calls[0][2])).toContain('PDF export');
});
it('saves nothing when the native export fails, and offers the alternatives instead of switching engines', async () => {
  const f = await host({ helper: async job => answer(job, { status: 'failed', error: 'native-export-failed' }) });
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' });
  expect(outcome.status).toBe('failed'); expect(JSON.parse(outcome.output)).toMatchObject({ kind: 'pdf-export-not-saved', engine: 'powerpoint', state: 'failed' });
  expect(outcome.output).toContain('another installed adapter_id'); expect(outcome.output).toContain('write_document');
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow(); expect(f.execute).toHaveBeenCalledTimes(1);
});
it('never saves a non-PDF or empty native output', async () => {
  const f = await host({ helper: async job => { await fs.writeFile(job.pdf, 'not a pdf'); return answer(job); } });
  expect((await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' })).status).toBe('failed');
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
});
it('never saves a PDF whose pages PDF.js cannot read', async () => {
  const f = await host({ helper: async job => { await fs.writeFile(job.pdf, ['%PDF-1.7', '%%EOF', ''].join('\n')); return answer(job); } });
  expect((await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' })).status).toBe('failed');
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
});
it('Stop ends the export request at once without saving, and the helper later closes its own copy', async () => {
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  const f = await host({ helper: async job => {
    for (let i = 0; i < 2000; i++) { try { await fs.access(job.stop); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
    await gate; await fs.writeFile(job.pdf, pdf); return answer(job, { error: 'native-stop-requested', status: 'failed' });
  } });
  const stop = new AbortController();
  const pending = f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' }, { signal: stop.signal });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1), { timeout: 30_000 }); stop.abort();
  const outcome = await pending; expect(outcome.status).toBe('failed');
  expect(JSON.parse(outcome.output)).toMatchObject({ state: 'cancelled', native_stop: { operation: 'stopped', helper: 'closing', output: 'none' } });
  resume(); await f.renderer.closingSettled(); await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
});
it.each([
  ['Commands Off', { mode: 'none' as const }, 'refused'],
  ['no Write capability', { allowed: ['read', 'execute'] }, 'refused'],
  ['the native policy', { policy: () => 'native-child network is Off for this session' }, 'success'],
])('%s stops the export before any native helper starts', async (_name, options, status) => {
  const f = await host(options);
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.pdf', adapter_id: 'powerpoint' });
  expect(outcome.status).toBe(status); if (status === 'success') expect(JSON.parse(outcome.output)).toMatchObject({ state: 'not-run' });
  expect(f.execute).not.toHaveBeenCalled(); await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
});
it('rejects a destination that is not a PDF without starting anything', async () => {
  const f = await host(); const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'deck.docx', adapter_id: 'powerpoint' });
  expect(outcome.status).toBe('failed'); expect(outcome.output).toContain('ending in .pdf'); expect(f.execute).not.toHaveBeenCalled();
});
it('Plan mode refuses export_pdf like every other write', () => { expect(isToolAllowedInPlan(EXPORT_PDF_TOOL)).toBe(false); });
it('is not offered without Commands, and is offered with Read, Write and Commands', async () => {
  expect((await host({ allowed: ['read', 'write'] })).tools.specs().map(spec => spec.function.name)).not.toContain(EXPORT_PDF_TOOL);
  expect((await host()).tools.specs().map(spec => spec.function.name)).toContain(EXPORT_PDF_TOOL);
});

function config(root: string, backend: AgentConfig['backend']): AgentConfig {
  return { id: 'exporter', name: 'Exporter', role: 'developer', backend, workingDirectory: root, allowedTools: ['read', 'write', 'execute'],
    provider: { providerId: backend === 'claude' ? 'anthropic' : backend === 'codex' ? 'codex' : 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: backend === 'codex' ? CODEX_CLI_DEFAULT_MODEL : backend === 'claude' ? 'sonnet' : 'deepseek-chat', autoApprove: true, systemPrompt: 'Work.', toolProtocol: 'native' };
}
it('the HTTP backend offers export_pdf in the tools of its model request', async () => {
  const f = await host();
  const backend = new OpenAICompatBackend(config(f.root, 'openai-compat'), async () => { throw Error('No model request expected'); }, undefined, undefined, new CommandPolicy('all', []));
  backends.push(backend);
  expect((backend as any).turnToolSpecs().map((spec: { function: { name: string } }) => spec.function.name)).toContain(EXPORT_PDF_TOOL);
});
it('Codex dynamic tools offer export_pdf and its call saves the real PDF', async () => {
  const f = await host(); const transport = managedCodexTransport();
  const backend = new CodexBackend(config(f.root, 'codex'), undefined, { hostFileTools: f.tools, spawn: transport.spawn, launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    hostReadFile: true, access: () => ({ trusted: true, restricted: false, readRoots: [f.root], writeRoots: [f.root] }),
    sessionNetwork: () => ({ allowed: true, revision: 1 }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Export the deck.');
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  expect(transport.messages.find(m => m.method === 'thread/start').params.dynamicTools.map((t: any) => t.name)).toContain(EXPORT_PDF_TOOL);
  const readTools: WorkspaceTools = (backend as any).hostReadToolsForTurn((backend as any).currentAccess()); readTools.setOfficeReader(new OfficeReader((reader as any).worker));
  const snapshot = JSON.parse((await transport.call('inspect_office', { path: 'deck.pptx' }, 'inspect')).result.contentItems[0].text).snapshot_ref;
  const response = await transport.call(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'codex.pdf', adapter_id: 'powerpoint' }, 'export');
  expect(response.result.success, JSON.stringify(response)).toBe(true); expect(await fs.readFile(join(f.root, 'codex.pdf'))).toEqual(pdf);
});
it('the Claude files bridge offers export_pdf and its call saves the real PDF', async () => {
  const f = await host(); const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(config(f.root, 'claude'), undefined, undefined, { hostFileTools: f.tools, spawn: transport.spawn,
    writeRoots: [f.root], terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Export the deck.');
  const settings = JSON.parse(await fs.readFile((backend as any).mcpConfigPath, 'utf8'));
  const server = settings.mcpServers[Object.keys(settings.mcpServers).find(name => name.startsWith('unode_files_'))!];
  const call = async (id: number, method: string, params: unknown = {}) => (await fetch(server.url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json() as Promise<any>;
  expect((await call(1, 'tools/list')).result.tools.map((t: any) => t.name)).toContain(EXPORT_PDF_TOOL);
  ((backend as any).filesBridgeTools as WorkspaceTools).setOfficeReader(new OfficeReader((reader as any).worker));
  const snapshot = JSON.parse((await call(2, 'tools/call', { name: 'inspect_office', arguments: { path: 'deck.pptx' } })).result.content[0].text).snapshot_ref;
  const response = await call(3, 'tools/call', { name: EXPORT_PDF_TOOL, arguments: { snapshot_ref: snapshot, path: 'claude.pdf', adapter_id: 'powerpoint' } });
  expect(response.result.isError, JSON.stringify(response)).not.toBe(true); expect(await fs.readFile(join(f.root, 'claude.pdf'))).toEqual(pdf);
});
it('export_pdf failure hints speak of export_pdf, never of render_office', async () => {
  const f = await host();
  const outcome = await f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: 'office-snapshot-not-issued', path: 'deck.pdf', adapter_id: 'powerpoint' });
  expect(outcome.status).toBe('failed'); expect(outcome.output).toContain('export_pdf.snapshot_ref');
  expect(outcome.output).not.toMatch(/render_office|Office render/); expect(f.execute).not.toHaveBeenCalled();
});

/*
 * v0.9.108 (L1): the person's Export PDF button runs this agent's own export: inspect_office for the snapshot, then
 * export_pdf (auto) through `run`, so the command approval to start the application, the file-write approval and every
 * refusal apply exactly as to the model's call. The real path writes the actual PDF beside its source.
 */
it('L1: the person export runs the real inspect + export path, asks both approvals, and saves the PDF beside its source', async () => {
  const asked: string[] = [];
  const f = await host({ mode: 'ask',
    approveCommand: async command => { asked.push('command'); expect(command).toContain(Buffer.from(WINDOWS_OFFICE_RENDER_SCRIPT, 'utf16le').toString('base64')); return { allow: true }; },
    approveWrite: async request => { asked.push('write'); expect(request.preview).toContain('Save the PDF exported by powerpoint'); return 'once'; } });
  const sourcePath = join(f.root, 'deck.pptx'); const destination = pdfExportDestination(sourcePath);
  expect(destination).toBe(join(f.root, 'deck.pdf'));
  const outcome = await f.tools.exportPdfForPerson(sourcePath, destination);
  expect(outcome.status, outcome.output).toBe('success');
  expect(asked, outcome.output).toEqual(['command', 'write']);
  expect(await fs.readFile(destination)).toEqual(pdf);
  expect(await fs.readFile(sourcePath)).toEqual(source);
  const job = JSON.parse(Buffer.from(f.execute.mock.calls[0][0].input, 'base64').toString());
  expect(job).toMatchObject({ intent: 'deliver-pdf', kind: 'pptx', requirePrivateApplication: true });
  const shown = personPdfExportResult(outcome, 'deck.pptx', 'Exporter');
  expect(shown.saved).toBe(true);
  expect(shown.message).toMatch(/^The PDF of deck\.pptx saved to deck\.pdf: 2 pages, exported by PowerPoint\./);
  expect(shown.message).toContain('deck.pptx is unchanged.');
});

it.each([
  ['the command approval is denied', { mode: 'ask' as const, approveCommand: async () => ({ allow: false }) }, 'stopped: it was not approved, so nothing was saved.', true],
  ['the file-write approval is denied', { approveWrite: async () => 'deny' as const }, 'stopped: it was not approved, so nothing was saved.', true],
  ['Commands are Off', { mode: 'none' as const }, 'did not run. Native PDF export requires Commands. To change your choice if desired: 1. Open UnodeAi Settings > Team > Permissions > Commands.', false],
  ['the agent has no Write', { allowed: ['read', 'execute'] }, 'did not run. Exporter needs Read, Write and Run commands', false],
  ['the native policy does not allow it', { policy: () => 'Native Office rendering cannot run under this agent’s current Plan/read-only execution policy.' },
    'did not run. Native Office rendering cannot run under this agent’s current Plan/read-only execution policy.', false],
])('L1: the person export saves nothing when %s, and says so in the person\'s words', async (_name, options, said, started) => {
  const f = await host(options);
  const outcome = await f.tools.exportPdfForPerson(join(f.root, 'deck.pptx'), join(f.root, 'deck.pdf'));
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
  // A denied command approval starts nothing; a denied save comes after the application exported its copy.
  expect(f.execute.mock.calls.length > 0).toBe(started && _name.includes('file-write'));
  const shown = personPdfExportResult(outcome, 'deck.pptx', 'Exporter');
  expect(shown.saved).toBe(false);
  expect(shown.message).toContain(`PDF export of deck.pptx ${said}`);
  expect(shown.message).not.toMatch(/export_pdf|snapshot_ref|adapter_id|retry/);
});

it('L1: without this agent\'s Read the person export does not inspect or start anything', async () => {
  const f = await host();
  (f.tools as any).allowed.delete('read');
  const outcome = await f.tools.exportPdfForPerson(join(f.root, 'deck.pptx'), join(f.root, 'deck.pdf'));
  expect(outcome.status).toBe('refused');
  expect(f.execute).not.toHaveBeenCalled();
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
});
/*
 * v0.9.108 (L1 fix, Codex's audit of ab94eb4b, F1 and F2): the person's Export PDF is an operation of its own. It
 * builds host tools for itself with the agent's authority (runPersonPdfExport), and reads the agent's native
 * restrictions for the mode the chat shows now, never the mode of the agent's last model turn.
 */
type Fixture = Awaited<ReturnType<typeof host>>;
function personPorts(f: Fixture, overrides: Partial<PersonPdfExportPorts> = {}): PersonPdfExportPorts {
  return { root: f.root, agentId: 'exporter', allowed: ['read', 'write', 'execute'], commandPolicy: new CommandPolicy('all', []),
    approveCommand: async () => ({ allow: true }), approveWrite: async () => 'once', writeApprovalAsk: () => false, recordCheckpoint: vi.fn(),
    readRoots: [], writeRoots: [f.root], isTrusted: () => true, nativeOfficeRenderer: f.renderer, officeApplicationCatalog: f.catalog as never,
    nativePolicy: () => undefined, officeHistory: undefined, officeReader: new OfficeReader((reader as any).worker), ...overrides };
}

it('L1 (F2): after a completed Claude Plan turn, the person who chose Act exports without a new model request; in Plan it still does not run', async () => {
  const f = await host(); const transport = managedClaudeTransport(); let proc: any;
  const backend = new ClaudeHeadlessBackend(config(f.root, 'claude'), undefined, undefined, { hostFileTools: f.tools,
    spawn: ((...args: any[]) => { proc = (transport.spawn as any)(...args); return proc; }) as any,
    writeRoots: [f.root], terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); const events: any[] = []; backend.onEvent(event => events.push(event));
  await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Plan the deck.', { mode: 'plan' } as never);
  proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'The plan is ready.' }) + '\n');
  await vi.waitFor(() => expect(events.some(event => event.kind === 'turn_complete')).toBe(true));
  // The model's own tools keep that turn's Plan, as before: their native stage does not run.
  expect((f.tools as any).nativeRenderPolicy()).toContain('current Plan or restricted-shell policy');
  // The person's export reads the chat's mode now: Act saves the PDF, with no model request in between.
  let chatMode: ChatMode = 'act';
  // One click, one operation: each export gets its ports (and its own source reader) afresh, as the extension does.
  const ports = () => personPorts(f, { nativePolicy: () => backend.personNativeOfficePolicy(chatMode) });
  const saved = await runPersonPdfExport(ports(), join(f.root, 'deck.pptx'), join(f.root, 'deck.pdf'));
  expect(saved.status, saved.output).toBe('success');
  expect(await fs.readFile(join(f.root, 'deck.pdf'))).toEqual(pdf);
  expect(f.execute).toHaveBeenCalledTimes(1);
  // The chat back in Plan (a request Plan would refuse first; this is the native check itself): nothing starts.
  chatMode = 'plan'; await fs.rm(join(f.root, 'deck.pdf'));
  const planned = await runPersonPdfExport(ports(), join(f.root, 'deck.pptx'), join(f.root, 'deck.pdf'));
  expect(JSON.parse(planned.output)).toMatchObject({ state: 'not-run', reason: expect.stringContaining('current Plan or restricted-shell policy') });
  expect(f.execute).toHaveBeenCalledTimes(1);
  await expect(fs.access(join(f.root, 'deck.pdf'))).rejects.toThrow();
  expect(events.filter(event => event.kind === 'turn_complete')).toHaveLength(1);
});

it('L1 (F2): each route reads its live restrictions for the person\'s mode: Plan, a restricted shell, read-only or network Off still refuse', async () => {
  const f = await host();
  const claude = (restrictShell: boolean) => new ClaudeHeadlessBackend(config(f.root, 'claude'), undefined, undefined, { restrictShell, writeRoots: [f.root] });
  expect(claude(false).personNativeOfficePolicy('act')).toBeUndefined();
  expect(claude(false).personNativeOfficePolicy('plan')).toContain('Plan or restricted-shell');
  expect(claude(true).personNativeOfficePolicy('act')).toContain('Plan or restricted-shell');
  const codex = (network: boolean, profile?: string) => new CodexBackend({ ...config(f.root, 'codex'), ...(profile ? { codexPermissionProfile: profile } : {}) } as AgentConfig, undefined, {
    access: () => ({ trusted: true, restricted: false, readRoots: [f.root], writeRoots: [f.root] }), sessionNetwork: () => ({ allowed: network, revision: 1 }) } as never);
  expect(codex(true).personNativeOfficePolicy('act')).toBeUndefined();
  expect(codex(true).personNativeOfficePolicy('plan')).toContain('Plan/read-only');
  expect(codex(false).personNativeOfficePolicy('act')).toContain('session network is Off');
  const http = new OpenAICompatBackend(config(f.root, 'openai-compat'), async () => { throw Error('No model request expected'); }, undefined, undefined, new CommandPolicy('all', []));
  backends.push(http);
  expect(http.personNativeOfficePolicy('act')).toBeUndefined();
  expect(http.personNativeOfficePolicy('plan')).toContain('Plan mode');
});

it('L1 (F1): a person export completes while a model call of the agent waits, and touches none of that request\'s state', async () => {
  const f = await host();
  // The agent's model is mid-call: its export_pdf waits at the request boundary (a reached limit) for the person.
  let decide!: (outcome: 'proceed' | 'stopped') => void;
  const boundary = vi.fn(() => new Promise<'proceed' | 'stopped'>(resolve => { decide = resolve; }));
  f.tools.setRequestBoundary(boundary);
  const modelChanged = vi.fn(); f.tools.observeFileChanges(modelChanged);
  const modelCall = f.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: f.snapshot, path: 'model.pdf', adapter_id: 'powerpoint' });
  await vi.waitFor(() => expect(boundary).toHaveBeenCalledTimes(1));
  const recordCheckpoint = vi.fn();
  const outcome = await runPersonPdfExport(personPorts(f, { recordCheckpoint }), join(f.root, 'deck.pptx'), join(f.root, 'deck.pdf'));
  expect(outcome.status, outcome.output).toBe('success');
  expect(await fs.readFile(join(f.root, 'deck.pdf'))).toEqual(pdf);
  // Not the request's: its limit was not asked again, its changed files and per-call result are untouched, and the
  // restore point of the person's file is recorded by the person's own recorder.
  expect(boundary).toHaveBeenCalledTimes(1);
  expect(modelChanged).not.toHaveBeenCalled();
  expect(f.tools.takeLastRunResult()).toBeUndefined();
  expect(recordCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'exporter', path: join(f.root, 'deck.pdf'), before: null }));
  // The model's call is still its own: it goes on when the person answers its limit.
  decide('proceed');
  const model = await modelCall;
  expect(model.status, model.output).toBe('success');
  expect(JSON.parse(model.output)).toMatchObject({ kind: 'pdf-exported', path: 'model.pdf' });
  expect(f.tools.takeLastRunResult()?.output).toBe(model.output);
});
