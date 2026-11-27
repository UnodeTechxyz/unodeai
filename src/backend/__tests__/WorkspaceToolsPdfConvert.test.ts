import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../CodexBackend';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { isToolAllowedInPlan } from '../planMode';
import { HOST_WORKSPACE_TOOL_NAMES } from '../HostToolNames';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { activityTool } from '../../observability/TurnActivity';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';
import { OfficeReader } from '../../office/OfficeReader';
import { NativeOfficeRenderer } from '../../office/NativeOfficeRenderer';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../../office/WindowsOfficeScript';
import { WINDOWS_WORD_PDF_CONVERT_SCRIPT } from '../../office/WindowsWordPdfScript';
import { EXPORT_PDF_TOOL } from '../../office/OfficeExportTool';
import { CONVERT_PDF_TO_DOCX_TOOL } from '../../office/pdf/PdfConvertTool';
import { PdfSignatureStore } from '../../office/pdf/PdfSignatureStore';
import { WORD_PDF_NOTICE_KEY } from '../../office/platform/WordPdfNoticeSetting';
import type { PdfEditor } from '../../office/pdf/PdfEditor';
import type { WindowsPowerShellDocumentRequest, WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';
import type { AgentConfig } from '../../types';
import { makePdf } from '../../office/pdf/__tests__/pdfFixtures';
import { officeRouteDocument, officeRouteEditor, officeRouteReader } from './officeInventoryRouteFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { runPersonPdfExport } from '../../host/personOfficeExport';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { managedCodexTransport, managedClaudeTransport } from './managedNativeFixtures';
import { fixedCodexProgram } from './codexProgramFixture';

// P4b route 2 through the real host entry: admission, the Word PDF-notice adapter (only its fixed registry query is a
// fixture), PDF read and text-layer check, command gate, operation queue, renderer stage, the DOCX package check and
// the common write boundary with a real OfficeArtifactHistory. The fake helper writes a real DOCX where Word would.
const lookup = vi.hoisted(() => ({ executable: '' }));
vi.mock('../../security/HostExecutableResolver', async importOriginal => ({ ...await importOriginal<any>(), resolveHostExecutable: (file: string) => /reg\.exe$/i.test(file) ? file : lookup.executable }));
const digest = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
let worker: string; let reader: Awaited<ReturnType<typeof officeRouteReader>>; let pdfEditor: PdfEditor; let converted: Buffer;
const owned: WorkspaceTools[] = []; const stores: ContentAssetStore[] = []; const backends: Array<{ stop(): Promise<unknown> }> = [];
beforeAll(async () => {
  reader = await officeRouteReader(); pdfEditor = await pdfRouteEditor();
  worker = join(dirname((reader as any).worker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  converted = await officeRouteDocument();
});
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  for (const tools of owned.splice(0)) { tools.retire(); await tools.disposeBackground(); } for (const store of stores.splice(0)) await store.dispose(); vi.unstubAllEnvs();
});
afterAll(async () => { await reader.dispose(); await removeTemporaryFolders(); });

type Notice = string | undefined | (() => string | undefined);
const queryOutput = (value: string) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Office\\16.0\\Word\\Options\r\n    DisableConvertPdfWarning    REG_DWORD    ${value}\r\n\r\n`;
async function host(options: { notice?: Notice; mode?: 'all' | 'none'; platform?: NodeJS.Platform; helper?: (job: any) => Promise<WindowsPowerShellDocumentResult | void> } = {}) {
  const root = await temporaryFolder('unode-pdf-convert-');
  lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture'); vi.stubEnv('SystemRoot', root);
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); }, saved: () => records });
  const assets = new ContentAssetStore({ officeHistory: history }); stores.push(assets);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(['read', 'write', 'execute']), 'agent'];
  parameters[4] = new CommandPolicy(options.mode ?? 'all', []); parameters[5] = 120000; parameters[22] = assets;
  const tools = new WorkspaceTools(...parameters); owned.push(tools);
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.setOfficeEditor(await officeRouteEditor()); tools.setPdfEditor(pdfEditor);
  tools.setOfficeAuthoring(() => ({ trackChangesDefault: true, authorName: '', memberName: 'agent' }));
  const signatures = new PdfSignatureStore(join(root, '.signature-store')); tools.setPdfSignatures(signatures);
  // Only the adapter's fixed read-only query is simulated: absent value (reg fails), 0x0 or 0x1.
  const query = vi.fn(async (_executable: string, _args: readonly string[]) => {
    const value = typeof options.notice === 'function' ? options.notice() : options.notice; return value === undefined ? undefined : queryOutput(value);
  });
  // The simulated Windows boundary: the notice read and the command proposal both use this platform and environment.
  tools.setWordPdfPlatform({ platform: options.platform ?? 'win32', env: { SystemRoot: root }, query });
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    const script = Buffer.from(request.encodedCommand, 'base64').toString('utf16le'); const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    const custom = await options.helper?.(job); if (custom) return custom;
    if (job.intent === 'convert-docx') { expect(script).toBe(WINDOWS_WORD_PDF_CONVERT_SCRIPT); await fs.writeFile(job.docx, converted); }
    else { expect(script).toBe(WINDOWS_OFFICE_RENDER_SCRIPT); await fs.writeFile(job.pdf, await makePdf([{ text: 'Exported again' }])); }
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', page_count: 0,
      completed_pages: 0, document_closed: true, app_version: '16.0', native_app: 'quit-by-helper', stage_released: true }) };
  });
  tools.useNativeOfficeRenderer(new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(worker), execute,
    catalog: { candidate: vi.fn(async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: join(root, 'inert-' + id + '.exe'), sha256: 'a'.repeat(64), bytes: 1 })) } }));
  tools.beginTurn();
  await fs.writeFile(join(root, 'contract.pdf'), await makePdf([{ text: 'Contract term twelve months' }, { text: 'Payment in thirty days' }]));
  const convert = (fields: object = {}) => tools.run(CONVERT_PDF_TO_DOCX_TOOL, { source: { path: 'contract.pdf' }, destination: 'contract.docx', ...fields });
  return { root, tools, history, records, query, execute, signatures, convert };
}

it.each([['absent', undefined], ['0', '0x0'], ['2', '0x2']])('with the Word PDF notice on (value %s) the call is refused before Word starts, with the user\u2019s steps', async (_name, notice) => {
  const h = await host({ notice }); const gate = vi.spyOn(h.tools as any, 'normalizeAndGate'); const read = vi.spyOn(h.tools as any, 'readPdfSource');
  const outcome = await h.convert();
  expect(outcome.status, outcome.output).toBe('success');
  // Refused before the PDF is read or the user is asked to approve a command.
  expect(gate).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  const result = JSON.parse(outcome.output);
  expect(result).toMatchObject({ state: 'not-run', reason: 'word-pdf-prompt-on' });
  expect(result.scope).toContain('Don\u2019t show this message again'); expect(result.scope).toContain('never changes it'); expect(result.scope).toContain('export_pdf');
  expect(h.query).toHaveBeenCalledWith(win32.join(h.root, 'System32', 'reg.exe'), ['query', WORD_PDF_NOTICE_KEY, '/v', 'DisableConvertPdfWarning']);
  expect(h.execute).not.toHaveBeenCalled(); await expect(fs.access(join(h.root, 'contract.docx'))).rejects.toThrow();
});

it('with the notice off, converts through the real entry, saves the checked DOCX with a conversion lineage, and the route continues to a new PDF', async () => {
  const h = await host({ notice: '0x1' }); const gate = vi.spyOn(h.tools as any, 'normalizeAndGate');
  const outcome = await h.convert(); expect(outcome.status, outcome.output).toBe('success');
  const saved = await fs.readFile(join(h.root, 'contract.docx')); expect(saved).toEqual(converted);
  const pdf = await fs.readFile(join(h.root, 'contract.pdf'));
  expect(JSON.parse(outcome.output)).toMatchObject({ kind: 'pdf-converted', path: 'contract.docx', sha256: digest(saved), source_sha256: digest(pdf),
    source_pages: 2, source_text_pages: 2, engine: 'word', effect: 'created', native_stop: { operation: 'completed', output: 'kept' }, note: expect.stringContaining('layout may differ') });
  const job = JSON.parse(Buffer.from(h.execute.mock.calls[0][0].input, 'base64').toString());
  expect(job).toMatchObject({ intent: 'convert-docx', kind: 'pdf' }); expect(job.docx).toMatch(/converted\.docx$/); expect(job.source).toMatch(/render-copy\.pdf$/);
  expect(String(gate.mock.calls[0][0])).toContain(Buffer.from(WINDOWS_WORD_PDF_CONVERT_SCRIPT, 'utf16le').toString('base64'));
  // The setting is read before the approval and again after it, never cached.
  expect(h.query.mock.calls.length).toBeGreaterThanOrEqual(2);
  await h.history.flush();
  expect(h.records.filter(record => record.kind === 'file').flatMap(record => record.derivations))
    .toContainEqual({ fromSha256: digest(pdf), toSha256: digest(saved), kind: 'pdf-conversion' });
  expect(await fs.readFile(join(h.root, 'contract.pdf'))).toEqual(pdf);
  // Route: tracked edit of the converted DOCX, then export_pdf.
  const snapshot = JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx' })).output).snapshot_ref;
  const edited = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: snapshot, path: 'contract.docx', edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Revised term' }] });
  expect(edited.status, edited.output).toBe('success');
  const exported = await h.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx' })).output).snapshot_ref, path: 'contract-v2.pdf', adapter_id: 'word' });
  expect(exported.status, exported.output).toBe('success'); expect(JSON.parse(exported.output)).toMatchObject({ kind: 'pdf-exported' });
});

it('a notice turned back on during the approval wait stops the conversion before Word starts', async () => {
  let reads = 0; const h = await host({ notice: () => ++reads === 1 ? '0x1' : undefined });
  const outcome = await h.convert();
  expect(JSON.parse(outcome.output)).toMatchObject({ state: 'not-run', reason: 'word-pdf-prompt-on' });
  expect(h.execute).not.toHaveBeenCalled(); await expect(fs.access(join(h.root, 'contract.docx'))).rejects.toThrow();
});

it('the helper\u2019s own check right before Word starts is reported as the same not-run outcome', async () => {
  const h = await host({ notice: '0x1', helper: async job => ({ status: 'exited', code: 0, signal: null, stderr: '',
    stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'not-run', error: 'word-pdf-prompt-on', page_count: 0, completed_pages: 0,
      document_closed: false, native_app: 'not-started', native_reason: 'application-not-created', stage_released: true }) }) });
  expect(JSON.parse((await h.convert()).output)).toMatchObject({ state: 'not-run', reason: 'word-pdf-prompt-on' });
  await expect(fs.access(join(h.root, 'contract.docx'))).rejects.toThrow();
});

it.each([['not a package', async () => Buffer.from('not a docx')],
  ['a presentation package', async () => Buffer.from(await (() => { const deck = new PptxGenJS(); deck.addSlide().addText('Deck', { x: 1, y: 1, w: 4, h: 1 }); return deck.write({ outputType: 'nodebuffer' }); })() as Buffer)],
])('never saves a helper output that is not a Word document (%s)', async (_name, output) => {
  const bytes = await output();
  const h = await host({ notice: '0x1', helper: async job => {
    await fs.writeFile(job.docx, bytes);
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', page_count: 0,
      completed_pages: 0, document_closed: true, app_version: '16.0', native_app: 'quit-by-helper', stage_released: true }) };
  } });
  const outcome = await h.convert(); expect(outcome.status).toBe('failed');
  expect(JSON.parse(outcome.output)).toMatchObject({ kind: 'pdf-conversion-not-saved', engine: 'word' });
  await expect(fs.access(join(h.root, 'contract.docx'))).rejects.toThrow();
});

it('refuses a scan, an encrypted PDF, a non-PDF, the source as destination and malformed input before Word starts', async () => {
  const h = await host({ notice: '0x1' });
  await fs.writeFile(join(h.root, 'scan.pdf'), await makePdf([{ text: '' }]));
  expect((await h.convert({ source: { path: 'scan.pdf' } })).output).toContain('pdf-no-text-layer');
  await fs.writeFile(join(h.root, 'locked.pdf'), Buffer.concat([Buffer.from(await makePdf([{ text: 'Locked' }])), Buffer.from('\ntrailer\n<< /Encrypt 9 0 R >>\n')]));
  expect((await h.convert({ source: { path: 'locked.pdf' } })).output).toContain('pdf-encrypted');
  await fs.writeFile(join(h.root, 'notes.pdf'), 'plain text');
  expect((await h.convert({ source: { path: 'notes.pdf' } })).output).toContain('pdf-invalid');
  await fs.writeFile(join(h.root, 'same.docx.pdf'), await makePdf([{ text: 'x' }]));
  for (const input of [{ destination: 'contract.pdf' }, { source: { path: 'a.pdf', source_ref: 'content-1' } }, { source: 'contract.pdf' }, { extra: true }]) {
    expect((await h.convert(input)).status).toBe('failed');
  }
  expect(h.execute).not.toHaveBeenCalled();
});

it('Commands Off refuses, and other platforms report platform-unsupported, before anything is read or started', async () => {
  const off = await host({ notice: '0x1', mode: 'none' });
  expect((await off.convert()).status).toBe('refused'); expect(off.query).not.toHaveBeenCalled();
  const linux = await host({ notice: '0x1', platform: 'linux' });
  expect(JSON.parse((await linux.convert()).output)).toMatchObject({ state: 'not-run', reason: 'platform-unsupported' });
  expect(linux.query).not.toHaveBeenCalled(); expect(linux.execute).not.toHaveBeenCalled();
  expect(isToolAllowedInPlan(CONVERT_PDF_TO_DOCX_TOOL)).toBe(false);
});

it('13.13: a PDF UnodeAi signed converts, but no page images are made of the DOCX or of a PDF exported from it', async () => {
  const h = await host({ notice: '0x1' }); const pdf = await fs.readFile(join(h.root, 'contract.pdf'));
  await h.signatures.setRecords(digest(pdf), [{ page: 1, page_ref: '3 0 R', page_content_sha256: 'b'.repeat(64), page_size: [300, 400], rect: [10, 10, 80, 30], signature_sha256: 'c'.repeat(64), receipt_id: 'r1' }]);
  const outcome = await h.convert(); expect(outcome.status, outcome.output).toBe('success');
  expect(JSON.parse(outcome.output)).toMatchObject({ signatures: 'derived-from-signed', note: expect.stringContaining('not sent to models') });
  const snapshot = JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx' })).output).snapshot_ref;
  const rendered = await h.tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'word' });
  expect(JSON.parse(rendered.output)).toMatchObject({ state: 'not-run', reason: 'derived-from-signed' });
  // Local delivery is not blocked: the DOCX still exports to a PDF file.
  const exported = await h.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'contract-v2.pdf', adapter_id: 'word' });
  expect(exported.status, exported.output).toBe('success');
  h.tools.setPdfPageRasterPlatform(() => ({ renderer: 'windows-pdf', command: () => { throw Error('no page images may be made'); }, rasterize: async () => { throw Error('no page images may be made'); } }));
  const viewed = await h.tools.run('view_pdf_pages', { path: 'contract-v2.pdf', pages: '1' });
  expect(JSON.parse(viewed.output)).toMatchObject({ state: 'not-run', reason: 'derived-from-signed' });
  // render_office never started a native page render.
  expect(h.execute.mock.calls.filter(([request]) => JSON.parse(Buffer.from(request.input, 'base64').toString()).intent === undefined)).toHaveLength(0);
});

it('13.13: converted signed pages merged after another PDF or put in with replace_pages are still withheld from page images', async () => {
  const h = await host({ notice: '0x1' }); const pdf = await fs.readFile(join(h.root, 'contract.pdf'));
  await h.signatures.setRecords(digest(pdf), [{ page: 1, page_ref: '3 0 R', page_content_sha256: 'b'.repeat(64), page_size: [300, 400], rect: [10, 10, 80, 30], signature_sha256: 'c'.repeat(64), receipt_id: 'r1' }]);
  expect((await h.convert()).status).toBe('success');
  const snapshot = JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx' })).output).snapshot_ref;
  expect((await h.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'converted.pdf', adapter_id: 'word' })).status).toBe('success');
  await fs.writeFile(join(h.root, 'cover.pdf'), await makePdf([{ text: 'Cover page' }]));
  await fs.writeFile(join(h.root, 'base.pdf'), await makePdf([{ text: 'Base page one' }, { text: 'Base page two' }]));
  const proposals = vi.fn(() => ({ unavailable: 'powershell-unavailable' as const }));
  h.tools.setPdfPageRasterPlatform(() => ({ renderer: 'windows-pdf', command: proposals, rasterize: async () => { throw Error('no page images may be made'); } }));
  // (a) the converted PDF as the second merge input; (b) as the replace_pages source.
  const merged = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'packet.pdf', inputs: [{ path: 'cover.pdf' }, { path: 'converted.pdf' }], operations: [{ op: 'merge' }] });
  expect(merged.status, merged.output).toBe('success');
  const replaced = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'replaced.pdf', inputs: [{ path: 'base.pdf' }],
    operations: [{ op: 'replace_pages', pages: '1', from: { path: 'converted.pdf' } }] });
  expect(replaced.status, replaced.output).toBe('success');
  for (const [path, pages] of [['packet.pdf', '2'], ['replaced.pdf', '1']]) {
    expect(JSON.parse((await h.tools.run('view_pdf_pages', { path, pages })).output), path).toMatchObject({ state: 'not-run', reason: 'derived-from-signed' });
  }
  expect(proposals).not.toHaveBeenCalled();
  // Local delivery stays available, and a PDF made only of unsigned inputs still reaches the page renderer.
  expect(await fs.readFile(join(h.root, 'packet.pdf'))).toBeTruthy();
  const plain = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'plain.pdf', inputs: [{ path: 'cover.pdf' }, { path: 'base.pdf' }], operations: [{ op: 'merge' }] });
  expect(plain.status, plain.output).toBe('success');
  expect(JSON.parse((await h.tools.run('view_pdf_pages', { path: 'plain.pdf', pages: '2' })).output)).toMatchObject({ state: 'not-run', reason: 'powershell-unavailable' });
  expect(proposals).toHaveBeenCalledTimes(1);
});

it('is a governed, trusted-workspace host write offered with Read, Write and Commands', async () => {
  expect(HOST_WORKSPACE_TOOL_NAMES).toContain(CONVERT_PDF_TO_DOCX_TOOL); expect(isGovernedWorkspaceTool(CONVERT_PDF_TO_DOCX_TOOL)).toBe(true);
  expect(activityTool(CONVERT_PDF_TO_DOCX_TOOL)).toBe(CONVERT_PDF_TO_DOCX_TOOL);
  const h = await host({ notice: '0x1' }); expect(h.tools.specs().map(spec => spec.function.name)).toContain(CONVERT_PDF_TO_DOCX_TOOL);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [h.root, new Set(['read', 'write']), 'agent'];
  const noCommands = new WorkspaceTools(...parameters); owned.push(noCommands);
  expect(noCommands.specs().map(spec => spec.function.name)).not.toContain(CONVERT_PDF_TO_DOCX_TOOL);
});

function config(root: string, backend: AgentConfig['backend']): AgentConfig {
  return { id: 'converter', name: 'Converter', role: 'developer', backend, workingDirectory: root, allowedTools: ['read', 'write', 'execute'],
    provider: { providerId: backend === 'claude' ? 'anthropic' : backend === 'codex' ? 'codex' : 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: backend === 'codex' ? CODEX_CLI_DEFAULT_MODEL : backend === 'claude' ? 'sonnet' : 'deepseek-chat', autoApprove: true, systemPrompt: 'Work.', toolProtocol: 'native' };
}
it('the HTTP backend offers convert_pdf_to_docx in its model request tools', async () => {
  const h = await host();
  const backend = new OpenAICompatBackend(config(h.root, 'openai-compat'), async () => { throw Error('No model request expected'); }, undefined, undefined, new CommandPolicy('all', []));
  backends.push(backend);
  expect((backend as any).turnToolSpecs().map((spec: { function: { name: string } }) => spec.function.name)).toContain(CONVERT_PDF_TO_DOCX_TOOL);
});
it('Codex dynamic tools offer convert_pdf_to_docx and its call reaches the host handler', async () => {
  const h = await host({ notice: undefined }); const transport = managedCodexTransport();
  const backend = new CodexBackend(config(h.root, 'codex'), undefined, { hostFileTools: h.tools, spawn: transport.spawn, launchProgram: fixedCodexProgram(join(h.root, 'tools', 'codex.exe')),
    hostReadFile: true, access: () => ({ trusted: true, restricted: false, readRoots: [h.root], writeRoots: [h.root] }),
    sessionNetwork: () => ({ allowed: true, revision: 1 }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Convert the PDF.');
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  expect(transport.messages.find(m => m.method === 'thread/start').params.dynamicTools.map((t: any) => t.name)).toContain(CONVERT_PDF_TO_DOCX_TOOL);
  const response = await transport.call(CONVERT_PDF_TO_DOCX_TOOL, { source: { path: 'contract.pdf' }, destination: 'codex.docx' }, 'convert');
  expect(JSON.stringify(response)).toContain('word-pdf-prompt-on');
});
it('the Claude files bridge offers convert_pdf_to_docx and its call reaches the host handler', async () => {
  const h = await host(); const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(config(h.root, 'claude'), undefined, undefined, { hostFileTools: h.tools, spawn: transport.spawn,
    writeRoots: [h.root], terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Convert the PDF.');
  const settings = JSON.parse(await fs.readFile((backend as any).mcpConfigPath, 'utf8'));
  const server = settings.mcpServers[Object.keys(settings.mcpServers).find(name => name.startsWith('unode_files_'))!];
  const call = async (id: number, method: string, params: unknown = {}) => (await fetch(server.url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json() as Promise<any>;
  expect((await call(1, 'tools/list')).result.tools.map((t: any) => t.name)).toContain(CONVERT_PDF_TO_DOCX_TOOL);
  const response = await call(2, 'tools/call', { name: CONVERT_PDF_TO_DOCX_TOOL, arguments: { source: { path: 'contract.pdf' }, destination: 'claude.docx' } });
  expect(response.result.isError, JSON.stringify(response)).not.toBe(true); expect(JSON.stringify(response.result)).toMatch(/not-run/);
});
it('the conversion script keeps the private-instance, read-only setting and no-force-kill rules', () => {
  const script = WINDOWS_WORD_PDF_CONVERT_SCRIPT;
  expect(script).toContain("OpenSubKey('Software\\Microsoft\\Office\\16.0\\Word\\Options', $false)");
  expect(script).not.toMatch(/SetValue|CreateSubKey|DeleteValue|Stop-Process|\.Kill\(|taskkill/i);
  expect(script.indexOf("errorCode = 'word-pdf-prompt-on'")).toBeLessThan(script.indexOf('New-Object -ComObject Word.Application'));
  expect(script.indexOf('$app.DisplayAlerts = 0')).toBeGreaterThan(script.indexOf('$applicationOwned = $true'));
  expect(script).toContain('[void]$document.SaveAs2($job.docx, 16)');
  expect(script).toContain('foreach ($path in @($job.source, $job.docx))');
});

/*
 * v0.9.108 (Codex's composed audit of d6bd7b86, finding 1): the person's Export PDF records its DOCX -> PDF edge in the
 * same Office history the model tools read. A PDF the person exports from a DOCX converted from a signed PDF is still
 * "derived from signed", so view_pdf_pages stops before the page renderer; local delivery of the PDF still succeeds.
 * Unsigned control: the same flow without signature records goes on to the renderer.
 */
it.each([[true], [false]])('the person’s Export PDF keeps the conversion ancestry for later page views (signed source: %s)', async (signed) => {
  const h = await host({ notice: '0x1' });
  const original = await fs.readFile(join(h.root, 'contract.pdf'));
  if (signed) await h.signatures.setRecords(digest(original), [{ page: 1, page_ref: '3 0 R', page_content_sha256: 'b'.repeat(64), page_size: [300, 400], rect: [10, 10, 80, 30], signature_sha256: 'c'.repeat(64), receipt_id: 'person-export-signature' }]);
  expect((await h.convert()).status).toBe('success');
  const docx = await fs.readFile(join(h.root, 'contract.docx'));
  const catalog = { candidate: vi.fn(async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: join(h.root, 'inert-' + id + '.exe'), sha256: 'a'.repeat(64), bytes: 1 })) };
  const renderer = new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(worker), execute: h.execute, catalog });
  const personReader = new OfficeReader((reader as any).worker);
  try {
    const outcome = await runPersonPdfExport({ root: h.root, agentId: 'agent', allowed: ['read', 'write', 'execute'],
      commandPolicy: new CommandPolicy('all', []), approveCommand: async () => ({ allow: true }), approveWrite: async () => 'once',
      writeApprovalAsk: () => false, recordCheckpoint: vi.fn(), readRoots: [], writeRoots: [h.root], isTrusted: () => true,
      nativeOfficeRenderer: renderer, officeApplicationCatalog: catalog, nativePolicy: () => undefined, officeHistory: h.history, officeReader: personReader,
    }, join(h.root, 'contract.docx'), join(h.root, 'person-export.pdf'));
    // Local delivery is not blocked.
    expect(outcome.status, outcome.output).toBe('success');
    const saved = await fs.readFile(join(h.root, 'person-export.pdf'));
    expect(h.history.convertedFrom(digest(saved))).toContain(digest(original));
    await h.history.flush();
    expect(h.records.filter(record => record.kind === 'file').flatMap(record => record.derivations).some(edge => edge.fromSha256 === digest(docx) && edge.toSha256 === digest(saved))).toBe(true);
    const proposals = vi.fn(() => ({ unavailable: 'powershell-unavailable' as const }));
    h.tools.setPdfPageRasterPlatform(() => ({ renderer: 'windows-pdf', command: proposals, rasterize: async () => { throw Error('no page is rasterized in this test'); } }));
    const view = JSON.parse((await h.tools.run('view_pdf_pages', { path: 'person-export.pdf', pages: '1' })).output);
    if (signed) { expect(view).toMatchObject({ state: 'not-run', reason: 'derived-from-signed' }); expect(proposals).not.toHaveBeenCalled(); }
    else { expect(view).toMatchObject({ state: 'not-run', reason: 'powershell-unavailable' }); expect(proposals).toHaveBeenCalledTimes(1); }
  } finally { await personReader.dispose(); await renderer.dispose(); }
});
