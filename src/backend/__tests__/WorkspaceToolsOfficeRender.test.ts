import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { officeRouteReader, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { PRESENTATION_PNG } from './presentationImageFixtures';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../../office/WindowsOfficeScript';
import { WINDOWS_PDF_RASTER_SCRIPT } from '../../office/WindowsPdfScript';
import { OfficeReader } from '../../office/OfficeReader';
import type { NativeOfficeRenderJob, NativeOfficeRenderResult } from '../../office/NativeOfficeRenderer';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../CodexBackend';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { OpenAICompatBackend, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import { managedCodexTransport, managedClaudeTransport } from './managedNativeFixtures';
import { fixedCodexProgram } from './codexProgramFixture';
import type { AgentConfig } from '../../types';
import { admitUserTurn, attachment, attachmentIds } from './attachmentSaveFixtures';
import { recheckNativeRenderAuthorities } from '../../office/NativeRenderOperations';
import { build } from 'esbuild';
import { OfficeVisualDelivery } from '../../office/OfficeVisualDelivery';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';
import { NativeOfficeRenderer } from '../../office/NativeOfficeRenderer';
import { WINDOWS_LIBREOFFICE_RENDER_SCRIPT } from '../../office/WindowsLibreOfficeScript';
import type { OfficeRendererPreference } from '../../office/OfficeRendererSelection';

// Only native application transport and executable lookup are fixtures. Real host entry, source reader/worker,
// command policy/approval gate, operation queue, byte-version check and asset store remain production modules.
const lookup = vi.hoisted(() => ({ executable: '' }));
vi.mock('../../security/HostExecutableResolver', async importOriginal => ({ ...await importOriginal<any>(), resolveHostExecutable: () => lookup.executable }));
const owned: WorkspaceTools[] = []; let source: Buffer; let reader: Awaited<ReturnType<typeof officeRouteReader>>;
const backends: Array<{ stop(): Promise<unknown> }> = [];
const fixtureRoots = new Set<string>();
let previewWorker: string; const sharedStores: ContentAssetStore[] = [];
beforeAll(async () => {
  const ppt = new PptxGenJS(); ppt.addSlide().addText('Owned public render source', { x: 1, y: 1, w: 6, h: 1 });
  source = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer); reader = await officeRouteReader();
  fixtureRoots.add(dirname((reader as any).worker));
  previewWorker = join(dirname((reader as any).worker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: previewWorker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterEach(async () => { for (const backend of backends.splice(0)) await backend.stop(); for (const host of owned.splice(0)) { host.retire(); await host.disposeBackground(); }
  for (const store of sharedStores.splice(0)) await store.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await reader.dispose();
  for (const root of fixtureRoots) {
    const canonical = await fs.realpath(root); expect(dirname(canonical)).toBe(await fs.realpath(tmpdir()));
    expect(basename(canonical)).toMatch(/^unode-(?:public-render-|office-route-worker-)/); expect((await fs.lstat(root)).isSymbolicLink()).toBe(false);
  }
  await removeTemporaryFolders();
});
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
async function host(options: { mode?: 'all' | 'ask' | 'none'; approve?: (command: string, context: any) => Promise<{ allow: boolean }>; pages?: number; gate?: ReturnType<typeof deferred>; source?: Buffer; helperStop?: 'stopped' | 'unconfirmed'; assets?: ContentAssetStore } = {}) {
  const root = await temporaryFolder('unode-public-render-'); lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture');
  fixtureRoots.add(root);
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const policy = new CommandPolicy(options.mode ?? 'all', []);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(['read', 'execute']), 'renderer', undefined, policy, 120000, options.approve];
  parameters[22] = options.assets; const tools = new WorkspaceTools(...parameters);
  tools.useOfficeVisualDelivery(new OfficeVisualDelivery((tools as any).contentAssets, new OfficeRenderPureHost(previewWorker)));
  const input = options.source ?? source; const filename = options.source ? 'source.docx' : 'source.pptx';
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.beginTurn(); owned.push(tools); await fs.writeFile(join(root, filename), input);
  const nativeStarted = deferred();
  const render = vi.fn(async (job: NativeOfficeRenderJob): Promise<NativeOfficeRenderResult> => {
    expect(digest(job.source)).toBe(digest(input));
    await job.beforeStart({ renderer: job.renderer, source_sha256: digest(input), render_copy_sha256: 'b'.repeat(64), fixed_script_sha256: digest(job.renderer === 'libreoffice' ? WINDOWS_LIBREOFFICE_RENDER_SCRIPT : WINDOWS_OFFICE_RENDER_SCRIPT),
      ...(job.kind === 'docx' || job.renderer === 'libreoffice' ? { pdf_raster_script_sha256: digest(WINDOWS_PDF_RASTER_SCRIPT) } : {}) });
    nativeStarted.resolve();
    if (options.gate) await Promise.race([options.gate.promise, new Promise<void>(resolve => {
      if (job.signal.aborted) resolve(); else job.signal.addEventListener('abort', () => resolve(), { once: true });
    })]);
    const pages = [];
    if (job.current()) for (let page = 1; page <= (options.pages ?? 1); page++) {
      const fact = { page, bytes: PRESENTATION_PNG.length, sha256: digest(PRESENTATION_PNG), width: 2, height: 1 };
      await job.onPage({ ...fact, data: PRESENTATION_PNG }); pages.push(fact);
    }
    return { operation_id: job.operation_id!, renderer: job.renderer, source_sha256: digest(input), state: job.signal.aborted ? 'outcome-unknown' : 'passed',
      application_export: job.signal.aborted ? 'unknown' : 'completed', document_closed: !job.signal.aborted, pages, total_pages: options.pages ?? 1,
      staging_cleanup: 'removed', scope: 'Explicitly mocked native transport; no native application qualification.', ...(job.signal.aborted ? { helper_stop: options.helperStop ?? 'stopped' } : {}) };
  });
  tools.useNativeOfficeRenderer({ render });
  const inspected = await tools.run('inspect_office', { path: filename }); expect(inspected.status, inspected.output).toBe('success');
  return { root, tools, render, policy, nativeStarted: nativeStarted.promise, snapshot: JSON.parse(inspected.output).snapshot_ref };
}

it('explains an unavailable render ref and succeeds with the actual inspected Office ref without guessing or rerendering', async () => {
  const f = await host();
  const failed = await f.tools.run('render_office', { snapshot_ref: 'workbook-' + digest(source), adapter_id: 'auto' });
  expect(failed.status).toBe('failed'); expect(failed.output).toContain('Copy its returned snapshot_ref exactly');
  expect(failed.output).toContain('Do not build a ref'); expect(f.render).not.toHaveBeenCalled();
  const malformed = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'automatic' });
  expect(malformed.output).toContain('render_office.adapter_id');
  const pages = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto', pages: { start: 2, end: 1 } });
  expect(pages.output).toContain('render_office.pages');
  const actual = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' });
  expect(actual.status, actual.output).toBe('success'); expect(JSON.parse(actual.output)).toMatchObject({ state: 'finished', result: { state: 'passed' } });
  expect(f.render).toHaveBeenCalledTimes(1);
});

it('persists render source/copy/original/preview byte edges and actual viewer transport facts without restoring image authority', async () => {
  const historyRoot = await temporaryFolder('unode-public-render-history-'); fixtureRoots.add(historyRoot);
  let failOnce = true; const failed = vi.fn();
  const history = new OfficeArtifactHistory({ failed, write: async (key, record) => {
    if (failOnce) { failOnce = false; throw Error('private storage failure'); }
    await fs.writeFile(join(historyRoot, key + '.json'), JSON.stringify(record), { flag: 'wx' });
  } });
  const assets = new ContentAssetStore({ officeHistory: history }); sharedStores.push(assets);
  const f = await host({ assets });
  const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  const id = rendered.images[0].asset_id;
  const reviewRoot = await temporaryFolder('unode-public-render-history-reviewer-'); fixtureRoots.add(reviewRoot);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [reviewRoot, new Set(['read']), 'history-reviewer']; parameters[22] = assets;
  const reviewer = new WorkspaceTools(...parameters); owned.push(reviewer);
  reviewer.useOfficeVisualDelivery(new OfficeVisualDelivery(assets, new OfficeRenderPureHost(previewWorker)));
  reviewer.setDelegationContentSources([{ assetId: id } as any]); assets.holdForUserRequest('history-reviewer', [id]);
  const viewed = await reviewer.run('view_office_images', { asset_ids: [id] });
  const packet = (await reviewer.takeOfficeVisualPacket(viewed, 'claude', 'review-model', true, 'claude-cli'))!;
  const sentImage = packet.images[0];
  packet.submitted();
  await assets.dispose(); // Already submitted bytes can be acknowledged after the source cache ends.
  packet.observeClaudeResult([{ type: 'text', text: 'I saw it' }]);
  expect(JSON.parse(packet.text()).deliveries[0].viewed).toBe('unknown');
  packet.observeClaudeResult([{ type: 'image', source: { type: 'base64', media_type: sentImage.mimeType, data: sentImage.base64 } }]);
  await history.flush();
  const records = async () => Promise.all((await fs.readdir(historyRoot)).map(async name => JSON.parse(await fs.readFile(join(historyRoot, name), 'utf8')) as OfficeArtifactRecord));
  const stored = (await records()).filter(record => record.kind === 'image');
  expect(failed).toHaveBeenCalledTimes(1); expect(history.pendingWrites).toBe(0);
  const origin = stored.find(record => !record.delivery)!;
  expect(origin).toBeDefined();
  expect(origin.agentId).toBe('renderer');
  expect(origin.assetRef).toBe(`${rendered.operation_id}:${id}`);
  expect(origin.versions).toContainEqual({ sha256: digest(source), kind: 'office-source' });
  expect(origin.derivations).toContainEqual({ fromSha256: digest(source), toSha256: 'b'.repeat(64), kind: 'passive-copy' });
  expect(origin.derivations).toContainEqual({ fromSha256: 'b'.repeat(64), toSha256: digest(PRESENTATION_PNG), kind: 'render-page' });
  const observations = stored.filter(record => record.delivery);
  expect(observations.every(record => record.agentId === 'history-reviewer')).toBe(true);
  expect(observations.some(record => record.delivery?.state === 'prepared')).toBe(true);
  expect(observations.some(record => record.delivery?.state === 'payload-submitted' && record.delivery.viewed === 'unknown')).toBe(true);
  const accepted = observations.find(record => record.delivery?.viewed === 'observed')!;
  expect(accepted).toBeDefined();
  expect(accepted.delivery).toMatchObject({ route: 'claude', connection_id: 'claude-cli', model: 'review-model', provider_result: 'accepted', visual_review: 'not-run', transport: { submitted: 1, accepted: 1, rejected: 0 } });
  expect(accepted.derivations).toContainEqual({ fromSha256: digest(PRESENTATION_PNG), toSha256: accepted.delivery!.preview.sha256, kind: 'transport-preview' });
  packet.observeClaudeResult([{ type: 'image', source: { type: 'base64', media_type: sentImage.mimeType, data: sentImage.base64 } }]);
  await history.flush(); expect(await records()).toHaveLength(stored.length);
  const serialized = JSON.stringify(stored);
  expect(serialized).not.toContain(sentImage.base64); expect(serialized).not.toContain('physical_key'); expect(serialized).not.toContain(f.root);
  const reopened = new ContentAssetStore({ officeHistory: new OfficeArtifactHistory({ failed, write: async () => {} }) }); sharedStores.push(reopened);
  expect(reopened.officeImageProvenance(id)).toBeUndefined();
});

it.each(['pptx', 'docx'] as const)('auto uses the Owner-approved default for %s and falls back only when that candidate is unavailable', async kind => {
  const f = await host(kind === 'docx' ? { source: await officeRouteDocument() } : {}); const native = kind === 'docx' ? 'word' : 'powerpoint'; let nativeAvailable = true;
  const candidate = vi.fn(async (id: any) => id === native && !nativeAvailable ? undefined : { id, path: 'inert-candidate', sha256: 'a'.repeat(64), bytes: 1 });
  f.tools.setOfficeApplicationCatalog({ candidate }); // No preference getter override: use the actual production default.
  const selected = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).output);
  expect(selected.result).toMatchObject({ renderer: native, state: 'passed' }); expect(candidate.mock.calls.map(call => call[0])).toEqual([native]);
  nativeAvailable = false; candidate.mockClear();
  const fallback = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).output);
  expect(fallback.result).toMatchObject({ renderer: 'libreoffice', state: 'passed' }); expect(candidate.mock.calls.map(call => call[0])).toEqual([native, 'libreoffice']);
  f.policy.reload('none', []); candidate.mockClear();
  expect((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).status).toBe('refused');
  expect(candidate).not.toHaveBeenCalled(); expect(f.render).toHaveBeenCalledTimes(2);
});

it('auto follows the live application preference without changing source or execution authority', async () => {
  const f = await host(); let preferred: OfficeRendererPreference = 'word-powerpoint';
  f.tools.setOfficeRenderPreferences(() => ({ preferred, automaticWindowsCom: false }));
  const candidate = vi.fn(async (id: any) => ({ id, path: 'inert-candidate', sha256: 'a'.repeat(64), bytes: 1 }));
  f.tools.setOfficeApplicationCatalog({ candidate });
  const native = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).output);
  expect(f.render.mock.calls[0][0].require_private_application).toBe(true);
  expect(native.result).toMatchObject({ renderer: 'powerpoint', state: 'passed' });
  preferred = 'libreoffice';
  const libre = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).output);
  expect(libre.result).toMatchObject({ renderer: 'libreoffice', state: 'passed' });
  expect(f.render).toHaveBeenCalledTimes(2); expect(await fs.readFile(join(f.root, 'source.pptx'))).toEqual(source);
  f.policy.reload('none', []); const priorProbes = candidate.mock.calls.length;
  expect((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).status).toBe('refused');
  expect(candidate).toHaveBeenCalledTimes(priorProbes); expect(f.render).toHaveBeenCalledTimes(2);
});
it('an unavailable automatic candidate does not block the existing explicit adapter request', async () => {
  const f = await host(); // No host catalog: no default detector or executable resolution may be created.
  expect(JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'auto' })).output)).toMatchObject({ state: 'not-run', reason: 'automatic-renderer-unavailable' });
  expect(f.render).not.toHaveBeenCalled();
  expect(JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output).result.state).toBe('passed');
});
it.each([false, true])('the public LibreOffice adapter preserves capture and routes verified passive native charts (chart=%s)', async withChart => {
  let input = source;
  if (withChart) {
    const ppt = new PptxGenJS(); ppt.addSlide().addChart(ppt.ChartType.bar,
      [{ name: 'Sales', labels: ['North', 'South'], values: [15, 20] }], { x: 1, y: 1, w: 6, h: 3 });
    input = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  }
  const approve = vi.fn(async () => ({ allow: true })); const f = await host({ mode: 'ask', approve, ...(withChart ? { source: input } : {}) });
  const app = join(f.root, 'inert-libreoffice.exe'); await fs.writeFile(app, 'inert LibreOffice transport fixture');
  const pdf = Buffer.from('%PDF-1.7\nexplicit conversion/PDF transport fixture\n'); let home: string | undefined;
  const execute = vi.fn(async (request: any) => {
    expect(approve).toHaveBeenCalledTimes(1); home = request.cwd;
    expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_LIBREOFFICE_RENDER_SCRIPT);
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    expect(job).toMatchObject({ executable: app, executableSha256: digest('inert LibreOffice transport fixture') });
    await fs.writeFile(job.pdf, pdf); await fs.writeFile(job.phase, 'private-profile-process-exited');
    return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
      status: 'passed', app_version: '26.8.2', document_closed: true, page_count: 0, completed_pages: 0, native_app: 'ended', stage_released: true }) };
  });
  f.tools.useNativeOfficeRenderer(new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(previewWorker), execute,
    catalog: { candidate: async () => ({ id: 'libreoffice', path: app, sha256: digest('inert LibreOffice transport fixture'), bytes: Buffer.byteLength('inert LibreOffice transport fixture') }) },
    pdf: { rasterize: async (bytes: Buffer, _signal: AbortSignal, _current: () => boolean, onPage: (page: any) => Promise<void>) => {
      expect(bytes).toEqual(pdf); const page = { page: 1, sha256: digest(PRESENTATION_PNG), bytes: PRESENTATION_PNG.length, width: 2, height: 1 };
      await onPage({ ...page, data: PRESENTATION_PNG });
      return { renderer: 'windows-pdf', source_sha256: digest(bytes), state: 'passed', pages: [page], total_pages: 1, staging_cleanup: 'removed', scope: 'Explicit conversion/PDF transport fixture, no installed LibreOffice qualification.' };
    } } as any }));
  try {
    const response = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'libreoffice' });
    expect(response.status, response.output).toBe('success'); const result = JSON.parse(response.output);
    expect(result.result).toMatchObject({ renderer: 'libreoffice', state: 'passed', source_sha256: digest(input), total_pages: 1 });
    if (withChart) expect(result.result).toMatchObject({ chart_display: { state: 'not-verified', charts: 1 } });
    const provenance = (f.tools as any).contentAssets.officeImageProvenance(result.images[0].asset_id);
    expect(provenance.fact).toMatchObject({ renderer: 'libreoffice', source_sha256: digest(input), sha256: digest(PRESENTATION_PNG) });
    expect(approve).toHaveBeenCalledTimes(1); expect(approve.mock.calls[0][0]).toContain(Buffer.from(WINDOWS_LIBREOFFICE_RENDER_SCRIPT, 'utf16le').toString('base64'));
    expect(approve.mock.calls[0][0]).toContain(Buffer.from(WINDOWS_PDF_RASTER_SCRIPT, 'utf16le').toString('base64'));
    expect(execute).toHaveBeenCalledTimes(1); expect(await fs.readFile(join(f.root, withChart ? 'source.docx' : 'source.pptx'))).toEqual(input);
  } finally {
    if (home) await expect(fs.access(home)).rejects.toThrow();
  }
});
it('enters the public render tool through a real inspected source and actual command gate, retains exact image bytes and bounded page facts', async () => {
  const f = await host({ pages: 7 }); expect(f.tools.specs().map(s => s.function.name)).toContain('render_office');
  const result = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' }); expect(result.status, result.output).toBe('success');
  const batch = JSON.parse(result.output); expect(batch).toMatchObject({ state: 'finished', source_sha256: digest(source), source_current: true,
    result: { state: 'passed', captured_pages: 7 }, model_delivery: 'not-run', visual_review: 'not-run', retained_image_pages: 7 });
  expect(batch.images.map((p: any) => p.page)).toEqual([1, 2, 3, 4]); expect(batch.result.pages).toBeUndefined(); expect(batch.next_cursor).toBeTypeOf('string');
  const bytes = await (f.tools as any).contentAssets.imageBytesForDocument(batch.images[0].asset_id); expect(bytes.bytes).toEqual(PRESENTATION_PNG);
  const more = JSON.parse((await f.tools.run('inspect_operation', { operation_id: batch.operation_id, cursor: batch.next_cursor })).output);
  expect(more.images.map((p: any) => p.page)).toEqual([5, 6, 7]); expect(more.next_cursor).toBeNull(); expect(f.render).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(join(f.root, 'source.pptx'))).toEqual(source);
});

it('retains only selected original slide ordinals and rejects a cursor from another operation', async () => {
  const f = await host({ pages: 7 }); const first = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  const selected = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint', pages: { start: 5, end: 6 } })).output);
  expect(selected.images.map((p: any) => p.page)).toEqual([5, 6]); expect(selected.result.captured_pages).toBe(7);
  expect((await f.tools.run('inspect_operation', { operation_id: selected.operation_id, cursor: first.next_cursor })).status).toBe('failed');
});

it('honors Commands Off and the caller’s exact Ask refusal before any native transport', async () => {
  const f = await host({ mode: 'none' }); expect((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).status).toBe('refused');
  expect(f.render).not.toHaveBeenCalled();
  const approve = vi.fn(async () => ({ allow: false })); const ask = await host({ mode: 'ask', approve });
  const refusal = await ask.tools.run('render_office', { snapshot_ref: ask.snapshot, adapter_id: 'powerpoint' });
  expect(refusal.status, refusal.output).toBe('refused'); expect(approve).toHaveBeenCalledTimes(1); expect(refusal.output).toContain('did not approve');
});

it('Word’s chosen Ask mode proposes the native export and internal PDF capture together, with one ordinary decision', async () => {
  const approve = vi.fn(async (_command: string) => ({ allow: true })); const f = await host({ mode: 'ask', approve, source: await officeRouteDocument() });
  const rendered = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'word' });
  expect(JSON.parse(rendered.output).result.state).toBe('passed'); expect(approve).toHaveBeenCalledTimes(1);
  expect(approve.mock.calls[0][0].match(/-EncodedCommand/g)).toHaveLength(2);
});

it('keeps a 120-second background render across a normal new turn and queries the same operation without reusing a turn-abort signal', async () => {
  const gate = deferred(); const f = await host({ gate }); vi.useFakeTimers(); const pending = f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' });
  await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(120_000); const ongoing = JSON.parse((await pending).output);
  expect(ongoing.state).toBe('running'); f.tools.beginTurn();
  const status = JSON.parse((await f.tools.run('inspect_operation', { operation_id: ongoing.operation_id })).output); expect(status.state).toBe('running');
  expect(f.render.mock.calls[0][0].signal.aborted).toBe(false); gate.resolve();
  const finished = JSON.parse((await f.tools.run('inspect_operation', { operation_id: ongoing.operation_id, wait: true })).output);
  expect(finished).toMatchObject({ state: 'finished', source_current: true }); expect(finished.images).toHaveLength(1); expect(f.render).toHaveBeenCalledTimes(1);
});

it('Stop through the public render entry cancels at once, never ends the Office helper, and appends its later close facts', async () => {
  const f = await host(); let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; }); let helperRequest: any;
  const execute = vi.fn(async (request: any) => {
    helperRequest = request; const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_OFFICE_RENDER_SCRIPT);
    for (let i = 0; i < 2000; i++) { try { await fs.access(job.stop); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
    await gate; await fs.writeFile(join(job.output, 'page-1.png'), PRESENTATION_PNG);
    return { status: 'exited' as const, code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'failed', error: 'native-stop-requested',
      document_closed: true, page_count: 1, completed_pages: 1, native_app: 'quit-by-helper', native_reason: 'inventory-empty-at-close', stage_released: true }) };
  });
  const renderer = new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(previewWorker), execute,
    catalog: { candidate: async () => ({ id: 'powerpoint', path: join(f.root, 'inert-powerpnt.exe'), sha256: 'a'.repeat(64), bytes: 1 }) } });
  f.tools.useNativeOfficeRenderer(renderer); const waiter = new AbortController();
  const pending = f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' }, { signal: waiter.signal });
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 30_000 }); waiter.abort(); const operation = JSON.parse((await pending).output);
    expect(JSON.parse((await f.tools.run('stop_operation', { operation_id: operation.operation_id })).output).stop_requested).toBe(true);
    const settled = JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id, wait: true })).output);
    expect(settled).toMatchObject({ state: 'finished', images: [], result: { state: 'cancelled', captured_pages: 0,
      native_stop: { operation: 'stopped', helper: 'closing', native_app: 'unknown', output: 'none', staging: 'kept-until-app-ends' } } });
    expect(settled.result.native_stop.summary).toContain('still closing'); expect(helperRequest.helperClosesApplication).toBe(true);
    resume(); await renderer.closingSettled();
    const closed = JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id })).output);
    expect(closed).toMatchObject({ images: [], result: { state: 'cancelled', captured_pages: 0, native_stop: { helper: 'exited', native_app: 'quit-by-helper', output: 'none', staging: 'removed' } } });
    expect(await f.tools.disposeBackground()).toEqual({ unconfirmed: [] });
  } finally { resume(); await pending; }
});

it('keeps Stop/query available after Commands is switched Off and reports application uncertainty separately', async () => {
  const gate = deferred(); const f = await host({ gate }); const waiter = new AbortController();
  const pending = f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' }, { signal: waiter.signal });
  try {
    // Mock entry precedes the asynchronous beforeStart authority check. Revoke only after that check completes.
    await f.nativeStarted; expect(f.render).toHaveBeenCalledTimes(1); waiter.abort(); const operation = JSON.parse((await pending).output);
    f.policy.reload('none', []); recheckNativeRenderAuthorities();
    expect(f.render.mock.calls[0][0].signal.aborted).toBe(true); expect(f.tools.specs().map(s => s.function.name)).toContain('stop_operation');
    const stopped = JSON.parse((await f.tools.run('stop_operation', { operation_id: operation.operation_id })).output); expect(stopped.stop_requested).toBe(true);
    gate.resolve(); const final = JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id, wait: true })).output);
    expect(final.result).toMatchObject({ state: 'outcome-unknown', application_export: 'unknown', helper_stop: 'stopped' }); expect(final.images).toEqual([]);
  } finally { gate.resolve(); await pending; }
});

it('withholds retained images once the original byte version changes, and exposes no guessed operation', async () => {
  const f = await host(); const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  await fs.writeFile(join(f.root, 'source.pptx'), Buffer.from('changed original'));
  const changed = JSON.parse((await f.tools.run('inspect_operation', { operation_id: rendered.operation_id })).output);
  expect(changed.source_current).toBe(false); expect(changed.images).toEqual([]);
  expect((await f.tools.run('inspect_operation', { operation_id: 'office-render-guessed' })).status).toBe('refused');
});

it('Stop while a captured image waits for storage cannot mint a late readable asset', async () => {
  const f = await host(); const entered = deferred(); const release = deferred(); const assets = (f.tools as any).contentAssets;
  const store = assets.storeDocumentImage.bind(assets);
  const intercepted = vi.spyOn(assets, 'storeDocumentImage').mockImplementation(async (...args: any[]) => { entered.resolve(); await release.promise; return store(...args); });
  const waiter = new AbortController(); const pending = f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' }, { signal: waiter.signal });
  await entered.promise; waiter.abort(); const operation = JSON.parse((await pending).output);
  await f.tools.run('stop_operation', { operation_id: operation.operation_id }); release.resolve();
  expect(JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id, wait: true })).output).images).toEqual([]);
  expect(assets.assets.size).toBe(0); intercepted.mockRestore();
  // Real store write, with cancellation first observed after it: the private file never enters the asset registry.
  let checks = 0; expect(await store(PRESENTATION_PNG, 'renderer', () => ++checks === 1)).toHaveProperty('error'); expect(assets.assets.size).toBe(0);
});

it('reports an unimplementable explicit native-child network policy as not-run without starting a renderer or blocking ordinary reads', async () => {
  const f = await host(); f.tools.setNativeRenderPolicy(() => 'Explicit child network Off cannot be enforced by interactive Office.');
  const skipped = await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' }); expect(JSON.parse(skipped.output).state).toBe('not-run');
  expect(f.render).not.toHaveBeenCalled(); expect((await f.tools.run('inspect_office', { path: 'source.pptx' })).status).toBe('success');
});

it('prepares actual pixel blocks with protected page provenance, keeps bytes out of metadata and records submission separately', async () => {
  const f = await host(); const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  const prepared = await f.tools.run('view_office_images', { asset_ids: [rendered.images[0].asset_id] });
  const metadata = JSON.parse(prepared.output); expect(metadata.deliveries[0]).toMatchObject({ state: 'prepared', viewed: 'unknown', visual_review: 'not-run',
    origin: { kind: 'rendered-page', page: 1, source_sha256: digest(source), render_copy_sha256: 'b'.repeat(64) } });
  const packet = await f.tools.takeOfficeVisualPacket(prepared, 'http', 'vision-fixture', true); expect(packet!.images).toHaveLength(1);
  expect(Buffer.from(packet!.images[0].base64, 'base64')).toEqual(PRESENTATION_PNG);
  expect(prepared.output).not.toContain(f.root); expect(prepared.output).not.toContain(PRESENTATION_PNG.toString('base64'));
  packet!.submitted(); const status = await f.tools.run('view_office_images', { operation: 'inspect', delivery_ids: packet!.deliveryIds });
  expect(JSON.parse(status.output).deliveries[0]).toMatchObject({ state: 'payload-submitted', route: 'http', viewed: 'unknown', visual_review: 'not-run' });
  expect(await f.tools.takeOfficeVisualPacket(prepared, 'http', 'vision-fixture', true)).toBeUndefined();
});

it('image viewing needs no Commands and rechecks source version on the actual outgoing packet and legacy vision path', async () => {
  const f = await host(); const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  const asset = rendered.images[0].asset_id; f.policy.reload('none', []);
  const first = await f.tools.run('view_office_images', { asset_ids: [asset] }); expect((await f.tools.takeOfficeVisualPacket(first, 'claude', 'sonnet', true))!.images).toHaveLength(1);
  const prepared = await f.tools.run('view_office_images', { asset_ids: [asset] }); await fs.writeFile(join(f.root, 'source.pptx'), 'different original');
  const packet = await f.tools.takeOfficeVisualPacket(prepared, 'codex', 'vision-fixture', true); expect(packet!.images).toEqual([]);
  expect(JSON.parse(packet!.text()).deliveries[0].state).toBe('omitted'); expect(await f.tools.imageAssetForVision(asset)).toHaveProperty('error');
});

it('a reviewer’s explicit derivative grant permits that exact historical image after the creator stops, without granting the source file', async () => {
  const assets = new ContentAssetStore(); sharedStores.push(assets); const f = await host({ assets });
  const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output); const id = rendered.images[0].asset_id;
  const root = await temporaryFolder('unode-public-render-reviewer-'); fixtureRoots.add(root);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(['read']), 'reviewer']; parameters[22] = assets;
  const reviewer = new WorkspaceTools(...parameters); owned.push(reviewer);
  reviewer.useOfficeVisualDelivery(new OfficeVisualDelivery(assets, new OfficeRenderPureHost(previewWorker)));
  const denied = JSON.parse((await reviewer.run('view_office_images', { asset_ids: [id] })).output); expect(denied.deliveries).toEqual([]);
  reviewer.setDelegationContentSources([{ assetId: id } as any]); assets.holdForUserRequest('reviewer', [id]);
  f.tools.retire(); await f.tools.disposeBackground();
  const accepted = await reviewer.run('view_office_images', { asset_ids: [id] }); const packet = await reviewer.takeOfficeVisualPacket(accepted, 'claude', 'sonnet', true);
  expect(packet!.images).toHaveLength(1); expect(JSON.parse(packet!.text()).deliveries[0].origin.source_sha256).toBe(digest(source));
  expect((await reviewer.run('read_file', { path: join(f.root, 'source.pptx') })).status).toBe('refused');
});

it('does not give unregistered images Office provenance or claim images were viewed on an unknown vision route', async () => {
  const f = await host(); const assets = (f.tools as any).contentAssets;
  const arbitrary = await assets.storeImage(PRESENTATION_PNG, 'tool-result', 'image/png', 'renderer');
  expect(JSON.parse((await f.tools.run('view_office_images', { asset_ids: [arbitrary.assetId] })).output).deliveries).toEqual([]);
  const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  const prepared = await f.tools.run('view_office_images', { asset_ids: [rendered.images[0].asset_id] });
  const packet = await f.tools.takeOfficeVisualPacket(prepared, 'http', 'unknown-model', undefined); expect(packet!.images).toEqual([]);
  expect(JSON.parse(packet!.text()).deliveries[0]).toMatchObject({ state: 'omitted', viewed: 'unknown', visual_review: 'not-run' });
  expect(JSON.parse(packet!.text()).deliveries[0].connection_id).toBeUndefined();
});

it('v2 visual close binds the actual captured original page and preview, and a rejected request cannot establish its citation', async () => {
  const f = await host(); const resolver = new TaskInputResolver((f.tools as any).contentAssets, f.root);
  const compiled = compileTaskContract({ version: 1, objective: 'Review the presentation.', expected_deliverable: 'Scoped review.',
    effects: { read_files: [], expected_file_effect: 'none' }, inputs: [{ input_id: 'target', kind: 'workspacePath', path: 'source.pptx', purpose: 'Review target', required: true,
      freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } }], constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required', review: { input_id: 'target' } }, 'pm');
  expect(compiled.error).toBeUndefined();
  const begun = await resolver.beginAttempt(compiled.contract!, { agentId: 'renderer', capabilities: { read: true, write: false, shell: true }, taskScope: 'per-turn',
    verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [] }, 'pm');
  expect(begun.error).toBeUndefined(); const card = begun.card!;
  resolver.recordReviewAdmission(card.attemptId, evaluateReviewPolicy({ review: card.contract.review, policy: { version: 1, requireDifferentReportedModelForArtifactReview: false } }));
  f.tools.setTaskInputResolver(resolver); f.tools.setTaskAttempt(card);
  const inspected = await f.tools.run('inspect_office', { path: 'source.pptx' }); expect(inspected.status, inspected.output).toBe('success');
  const rendered = await f.tools.run('render_office', { snapshot_ref: JSON.parse(inspected.output).snapshot_ref, adapter_id: 'powerpoint' });
  expect(rendered.status, rendered.output).toBe('success'); const image = JSON.parse(rendered.output).images[0];
  const view = async (accepted: boolean) => {
    const result = await f.tools.run('view_office_images', { asset_ids: [image.asset_id] });
    const packet = await f.tools.takeOfficeVisualPacket(result, 'http', 'review-model', true); expect(packet?.images).toHaveLength(1);
    packet!.submitted(); packet!.providerResponse(accepted);
    return { kind: 'render-page', receiptId: packet!.deliveryIds[0], assetId: image.asset_id, sourceSha256: digest(source), page: 1,
      imageSha256: image.sha256, previewSha256: JSON.parse(packet!.text()).deliveries[0].preview.sha256 };
  };
  const input = (citation: unknown) => ({ schemaVersion: 2, coverage: 'partial', findings: [{ classification: 'observed', statement: 'Check this rendered page.', citations: [citation] }] });
  const rejected = await f.tools.run('close_assignment', { review_evidence: input(await view(false)) });
  expect(rejected.status).toBe('failed'); expect(rejected.output).toContain('rejected or unknown');
  const citation = await view(true);
  expect((await f.tools.run('close_assignment', { review_evidence: input({ ...citation, page: 2 }) })).status).toBe('failed');
  const closed = await f.tools.run('close_assignment', { review_evidence: input(citation) }); expect(closed.status, closed.output).toBe('success');
  expect(resolver.reviewReportForAttempt(card.attemptId)).toMatchObject({ evidenceVersion: 2, findings: [{ citations: [], officeCitations: [citation] }] });
});

it('an admitted background source survives replacement of a CLI’s disposable read surface without granting a new snapshot', async () => {
  const gate = deferred(); const f = await host({ gate });
  let active: WorkspaceTools;
  const fresh = () => { const tools = new WorkspaceTools(f.root, new Set(['read']), 'renderer'); tools.shareWorkbookDataWith(f.tools);
    tools.setOfficeReader(new OfficeReader((reader as any).worker)); owned.push(tools); return tools; };
  active = fresh(); f.tools.setWorkbookReadAuthorityProvider(() => active);
  const snapshot = JSON.parse((await active.run('inspect_office', { path: 'source.pptx' })).output).snapshot_ref;
  const waiter = new AbortController(); const pending = f.tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'powerpoint' }, { signal: waiter.signal });
  await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1)); waiter.abort(); const operation = JSON.parse((await pending).output);
  active.retire(); f.tools.beginTurn(); active = fresh(); gate.resolve();
  const resumed = JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id, wait: true })).output);
  expect(resumed).toMatchObject({ state: 'finished', source_current: true, images: [{ page: 1 }] }); expect(f.render).toHaveBeenCalledTimes(1);
  expect((await f.tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'powerpoint' })).status).toBe('failed');
});

it('an admitted original attachment is retained only for its existing operation across a normal turn', async () => {
  const gate = deferred(); const f = await host({ gate });
  const sources = await admitUserTurn((f.tools as any).contentAssets, [attachment('source.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file', source)]);
  (f.tools as any).contentAssets.holdForUserRequest('renderer', sources.map(item => item.assetId));
  f.tools.setDelegationContentSources(sources); const sourceRef = attachmentIds(sources)[0];
  const snapshot = JSON.parse((await f.tools.run('inspect_office', { source_ref: sourceRef })).output).snapshot_ref;
  expect(snapshot).toBeTypeOf('string'); const waiter = new AbortController();
  const pending = f.tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'powerpoint' }, { signal: waiter.signal });
  await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1)); waiter.abort(); const operation = JSON.parse((await pending).output);
  f.tools.beginTurn(); f.tools.setDelegationContentSources([]); (f.tools as any).contentAssets.holdForUserRequest('renderer', []); gate.resolve();
  expect(JSON.parse((await f.tools.run('inspect_operation', { operation_id: operation.operation_id, wait: true })).output))
    .toMatchObject({ state: 'finished', source_current: true, images: [{ page: 1 }] });
  expect((await f.tools.run('inspect_office', { source_ref: sourceRef })).status).toBe('failed');
});

function config(root: string, backend: AgentConfig['backend']): AgentConfig {
  return { id: 'renderer', name: 'Renderer', role: 'developer', backend, workingDirectory: root, allowedTools: ['read', 'write', 'execute'],
    provider: { providerId: backend === 'claude' ? 'anthropic' : backend === 'codex' ? 'codex' : 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: backend === 'codex' ? CODEX_CLI_DEFAULT_MODEL : backend === 'claude' ? 'sonnet' : 'deepseek-chat', autoApprove: true, systemPrompt: 'Work.', toolProtocol: 'native' };
}
it.each([false, true])('Codex actual dynamic entry preserves session network allowed=%s and carries the real host render result', async network => {
  const f = await host(); const transport = managedCodexTransport({ imageModels: ['fixture-vision'] });
  const backend = new CodexBackend({ ...config(f.root, 'codex'), model: 'fixture-vision' }, undefined, { hostFileTools: f.tools, spawn: transport.spawn, launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    hostReadFile: true, access: () => ({ trusted: true, restricted: false, readRoots: [f.root], writeRoots: [f.root] }),
    sessionNetwork: () => ({ allowed: network, revision: 1 }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Inspect and render.');
  const codexEvents: any[] = []; backend.onEvent(e => codexEvents.push(e));
  await vi.waitFor(() => expect((backend as any).turnId, JSON.stringify(codexEvents.filter(e => ['error', 'log'].includes(e.kind)))).toBe('turn-native'));
  const readTools: WorkspaceTools = (backend as any).hostReadToolsForTurn((backend as any).currentAccess()); readTools.setOfficeReader(new OfficeReader((reader as any).worker));
  expect(transport.messages.find(m => m.method === 'thread/start').params.dynamicTools.map((t: any) => t.name)).toContain('render_office');
  const inspected = await transport.call('inspect_office', { path: 'source.pptx' }, 'inspect');
  const snapshot = JSON.parse(inspected.result.contentItems[0].text).snapshot_ref;
  expect(readTools.workbookDeliveryFacts()).toEqual([expect.objectContaining({ id: expect.stringMatching(/^office-delivery-/), state: 'payload-submitted', route: 'codex',
    scope: expect.objectContaining({ sourceVersion: snapshot, sourceSha256: digest(source) }), submitted_units: expect.arrayContaining(['object:S1-O1']), observed_units: [] })]);
  const response = await transport.call('render_office', { snapshot_ref: snapshot, adapter_id: 'powerpoint' }, 'render');
  const rendered = JSON.parse(response.result.contentItems[0].text); expect(response.result.success).toBe(true);
  expect(rendered.state).toBe(network ? 'finished' : 'not-run'); expect(f.render).toHaveBeenCalledTimes(network ? 1 : 0);
  if (network) {
    expect(rendered.images).toHaveLength(1); f.policy.reload('none', []);
    const viewed = await transport.call('view_office_images', { asset_ids: [rendered.images[0].asset_id] }, 'view');
    expect(viewed.result.success).toBe(true);
    expect(viewed.result.contentItems[1]).toMatchObject({ type: 'inputImage', imageUrl: `data:image/png;base64,${PRESENTATION_PNG.toString('base64')}` });
    const facts = JSON.parse(viewed.result.contentItems[0].text.split('\n')[0]);
    const receipt = await transport.call('view_office_images', { operation: 'inspect', delivery_ids: [facts.deliveries[0].delivery_id] }, 'receipt');
    expect(JSON.parse(receipt.result.contentItems[0].text).deliveries[0]).toMatchObject({ state: 'payload-submitted', route: 'codex', connection_id: 'codex-cli', model: 'fixture-vision', viewed: 'unknown', visual_review: 'not-run' });
  } else expect(rendered.reason).toContain('network is Off');
});

it.each(['observed', 'text-only', 'wrong-image', 'error', 'unjoined'] as const)('Claude real private MCP entry renders and joins exact image observation: %s', async observation => {
  const f = await host(); const transport = managedClaudeTransport();
  const backend = new ClaudeHeadlessBackend(config(f.root, 'claude'), undefined, undefined, { hostFileTools: f.tools, spawn: transport.spawn,
    officeVisionCapability: model => model === 'sonnet',
    writeRoots: [f.root], terminateProcessTree: async child => { child.kill(); return { status: 'confirmed-stopped' }; } });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Inspect and render.');
  const readTools: WorkspaceTools = (backend as any).filesBridgeTools; readTools.setOfficeReader(new OfficeReader((reader as any).worker));
  const settings = JSON.parse(await fs.readFile((backend as any).mcpConfigPath, 'utf8'));
  const server = settings.mcpServers[Object.keys(settings.mcpServers).find(name => name.startsWith('unode_files_'))!];
  const call = async (id: number, method: string, params: unknown = {}) => (await fetch(server.url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json() as Promise<any>;
  const names = (await call(1, 'tools/list')).result.tools.map((t: any) => t.name); expect(names).toContain('render_office');
  const inspectName = `mcp__${(backend as any).bridgeIds.files}__inspect_office`;
  (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'office-inspect', name: inspectName, input: { path: 'source.pptx' } }] } });
  const inspected = await call(2, 'tools/call', { name: 'inspect_office', arguments: { path: 'source.pptx' }, _meta: { 'claudecode/toolUseId': 'office-inspect' } });
  (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'office-inspect', content: inspected.result.content }] } });
  await (backend as any).eventChain;
  expect(readTools.workbookDeliveryFacts()).toEqual([expect.objectContaining({ state: 'observed', route: 'claude',
    scope: expect.objectContaining({ sourceSha256: digest(source) }), observed_units: expect.arrayContaining(['object:S1-O1']) })]);
  const snapshot = JSON.parse(inspected.result.content[0].text).snapshot_ref;
  const response = await call(3, 'tools/call', { name: 'render_office', arguments: { snapshot_ref: snapshot, adapter_id: 'powerpoint' } });
  expect(response.result.isError, JSON.stringify(response)).not.toBe(true);
  expect(JSON.parse(response.result.content[0].text)).toMatchObject({ state: 'finished', result: { captured_pages: 1 }, images: [{ page: 1 }] });
  const imageId = JSON.parse(response.result.content[0].text).images[0].asset_id; f.policy.reload('none', []);
  const toolUseId = 'office-view'; const viewName = `mcp__${(backend as any).bridgeIds.files}__view_office_images`;
  (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: viewName, input: { asset_ids: [imageId] } }] } });
  const viewed = await call(4, 'tools/call', { name: 'view_office_images', arguments: { asset_ids: [imageId] },
    ...(observation === 'unjoined' ? {} : { _meta: { 'claudecode/toolUseId': toolUseId } }) });
  expect(viewed.result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PRESENTATION_PNG.toString('base64') });
  expect(JSON.stringify(viewed)).not.toContain(f.root);
  const deliveryId = JSON.parse(viewed.result.content[0].text).deliveries[0].delivery_id;
  const receipt = await call(5, 'tools/call', { name: 'view_office_images', arguments: { operation: 'inspect', delivery_ids: [deliveryId] } });
  expect(JSON.parse(receipt.result.content[0].text).deliveries[0]).toMatchObject({ state: 'payload-submitted', route: 'claude', connection_id: 'claude-cli', model: 'sonnet', viewed: 'unknown', visual_review: 'not-run' });
  const content = [viewed.result.content[0], ...(observation === 'text-only' ? [] : [{ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: observation === 'wrong-image' ? 'different-image-bytes' : viewed.result.content[1].data } }])];
  (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId,
    ...(observation === 'error' ? { is_error: true } : {}), content }] } });
  await (backend as any).eventChain;
  const after = await call(6, 'tools/call', { name: 'view_office_images', arguments: { operation: 'inspect', delivery_ids: [deliveryId] } });
  expect(JSON.parse(after.result.content[0].text).deliveries[0]).toMatchObject({
    viewed: observation === 'observed' ? 'observed' : 'unknown', visual_review: 'not-run',
    provider_result: observation === 'observed' ? 'accepted' : 'unknown',
    transport: { submitted: 1, accepted: observation === 'observed' ? 1 : 0, rejected: 0 } });
});

it.each(['stopped', 'unconfirmed'] as const)('Codex backend Stop awaits owned host render disposal and projects helper %s independently of unknown Office export', async helperStop => {
  const gate = deferred(); const f = await host({ gate, helperStop }); const transport = managedCodexTransport();
  const backend = new CodexBackend(config(f.root, 'codex'), undefined, { hostFileTools: f.tools, spawn: transport.spawn,
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'), hostReadFile: true,
    access: () => ({ trusted: true, restricted: false, readRoots: [f.root], writeRoots: [f.root] }),
    sessionNetwork: () => ({ allowed: true, revision: 1 }), killProcessTree: transport.stop });
  backends.push(backend); await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Render then stop.');
  await vi.waitFor(() => expect((backend as any).turnId).toBe('turn-native'));
  const readTools: WorkspaceTools = (backend as any).hostReadToolsForTurn((backend as any).currentAccess()); readTools.setOfficeReader(new OfficeReader((reader as any).worker));
  const snapshot = JSON.parse((await transport.call('inspect_office', { path: 'source.pptx' }, 'stop-inspect')).result.contentItems[0].text).snapshot_ref;
  const pending = transport.call('render_office', { snapshot_ref: snapshot, adapter_id: 'powerpoint' }, 'stop-render');
  await f.nativeStarted; backend.abort();
  const operation = JSON.parse((await pending).result.contentItems[0].text); expect(operation.state).toBe('running');
  const disposed = vi.spyOn(f.tools, 'disposeBackground'); const release = vi.spyOn((f.tools as any).contentAssets, 'release');
  const stopped = await backend.stop();
  expect(disposed).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledWith(expect.stringMatching(/^office-render-source-/));
  expect(stopped.stopped).toBe(helperStop === 'stopped');
  if (helperStop === 'unconfirmed') expect(stopped.detail).toContain('owned host command/render helper');
  const result = (f.tools as any).nativeRenderOperations.inspect(operation.operation_id);
  expect(result.result).toMatchObject({ application_export: 'unknown', helper_stop: helperStop });
});

it.each([false, true])('HTTP model tool loop enters inspect/render with coordinator contract restriction=%s', async restricted => {
  const f = await host(); let received: any; let requests = 0; let active = false;
  const team = restricted ? { has: () => false, hasTeammates: () => true, canCoordinatorExecute: () => false, specs: () => [], interruptPending: () => {},
    currentCoordinatorTaskAttempt: () => active ? { contractId: 'restricted-contract' } : undefined } as any : undefined;
  const backend = new OpenAICompatBackend(config(f.root, 'openai-compat'), async (_url, init) => {
    const body = JSON.parse(init.body); const outputs = body.messages.filter((m: any) => m.role === 'tool'); requests++;
    if (requests > 3) throw Error('Render fixture did not converge');
    const text = (m: any) => typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join('\n');
    if (outputs.length === 1) active = restricted;
    const call = outputs.length === 0 ? { name: 'inspect_office', args: { path: 'source.pptx' } }
      : outputs.length === 1 ? { name: 'render_office', args: { snapshot_ref: JSON.parse(text(outputs[0])).snapshot_ref, adapter_id: 'powerpoint' } } : undefined;
    if (!call) { const output = text(outputs.at(-1)); received = output.startsWith('{') ? JSON.parse(output) : { refused_text: output }; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: call ? { role: 'assistant', content: null,
      tool_calls: [{ id: 'render-' + requests, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: 'Render facts received; visual review not performed.' } }] }) };
  }, team, undefined, new CommandPolicy('all'));
  const events: any[] = []; backend.onEvent(event => events.push(event));
  backends.push(backend); const tools: WorkspaceTools = (backend as any).tools;
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.useNativeOfficeRenderer({ render: f.render });
  const complete = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
  await backend.start({ ROAM_API_KEY: 'fixture-only-chat-key' }); backend.sendUserTurn('Render.'); await complete;
  if (restricted) { expect(received.refused_text).toContain('outside the task contract'); expect(f.render).not.toHaveBeenCalled(); }
  else { expect(received, JSON.stringify({ requests, events: events.filter(e => ['error', 'turn_complete', 'tool_result'].includes(e.kind)) })).toMatchObject({ state: 'finished', source_sha256: digest(source), images: [{ page: 1 }], model_delivery: 'not-run' }); expect(f.render).toHaveBeenCalledTimes(1); }
  expect(tools.workbookDeliveryFacts()).toEqual([expect.objectContaining({ state: 'payload-submitted', route: 'http',
    scope: expect.objectContaining({ sourceSha256: digest(source) }), submitted_units: expect.arrayContaining(['object:S1-O1']) })]);
});

it.each([
  { legacy: false, revoke: false, vision: true, streaming: false },
  { legacy: true, revoke: false, vision: true, streaming: false },
  { legacy: false, revoke: true, vision: true, streaming: false },
  { legacy: false, revoke: false, vision: undefined, streaming: false },
  { legacy: false, revoke: false, vision: true, streaming: true },
  { legacy: false, revoke: true, vision: true, streaming: true },
  { legacy: false, revoke: false, vision: true, streaming: false, reject: true },
  { legacy: false, revoke: false, vision: true, streaming: false, media: 'decline' },
  { legacy: true, revoke: false, vision: true, streaming: false, media: 'missing' },
])('HTTP Office image loop submits only a current supported one-request preview %j', async testCase => {
  const { legacy, revoke, vision, streaming } = testCase; const reject = 'reject' in testCase && testCase.reject;
  const media = 'media' in testCase ? testCase.media : 'allow';
  const mediaGate = vi.fn(async () => { if (media === 'decline') throw Error('existing media choice refused'); });
  const f = await host(); let requests = 0; let lastBody: any; let deliveryId = '';
  const policy = new CommandPolicy('all');
  const fetchFn: FetchFn = async (_url, init) => {
    const body = JSON.parse(init.body); requests++; if (requests > 5) throw Error('Office image fixture did not converge');
    const results = body.messages.filter((m: any) => m.role === 'tool');
    const text = (m: any) => typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join('\n');
    const call = results.length === 0 ? { name: 'inspect_office', args: { path: 'source.pptx' } }
      : results.length === 1 ? { name: 'render_office', args: { snapshot_ref: JSON.parse(text(results[0])).snapshot_ref, adapter_id: 'powerpoint' } }
      : results.length === 2 ? { name: legacy ? 'send_image_asset_to_model' : 'view_office_images',
        args: legacy ? { assetId: JSON.parse(text(results[1])).images[0].asset_id } : { asset_ids: [JSON.parse(text(results[1])).images[0].asset_id] } } : undefined;
    if (!call) { lastBody = body; deliveryId = JSON.parse(text(results.at(-1))).deliveries[0].delivery_id; }
    if (reject && requests === 4) return { ok: false, status: 400, text: async () => 'image_url input is not supported by this model' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'visual-' + requests, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: 'Payload facts received; visual review not claimed.' } }] }) };
  };
  const streamFn: StreamFetchFn = async (url, init) => {
    const response = await fetchFn(url, init); const message = JSON.parse(await response.text()).choices[0].message;
    const delta = { ...(message.content ? { content: message.content } : {}), ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((call: any, index: number) => ({ ...call, index })),
    } : {}) };
    return { ok: true, status: 200, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    })() };
  };
  const backend = new OpenAICompatBackend(config(f.root, 'openai-compat'), fetchFn, undefined, undefined, policy, {
    declaredMediaCapability: () => vision,
    onBeforeEgress: async () => { if (requests === 3) {
      policy.reload('none', []);
      if (revoke) await fs.writeFile(join(f.root, 'source.pptx'), 'new version after image preparation');
    } },
    onBeforeMediaEgress: media === 'missing' ? undefined : mediaGate,
  }, undefined, streaming ? streamFn : undefined);
  backends.push(backend); const tools: WorkspaceTools = (backend as any).tools;
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.useNativeOfficeRenderer({ render: f.render });
  tools.useOfficeVisualDelivery(new OfficeVisualDelivery((tools as any).contentAssets, new OfficeRenderPureHost(previewWorker)));
  const complete = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
  await backend.start({ ROAM_API_KEY: 'fixture-only-chat-key' }); backend.sendUserTurn('Render and view.'); await complete;
  expect(requests).toBe(reject ? 5 : 4); expect(lastBody).toBeDefined();
  const images = lastBody.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'image_url') : []);
  expect(images).toHaveLength(vision && !revoke && !reject && media === 'allow' ? 1 : 0);
  if (images.length) expect(images[0].image_url.url).toBe(`data:image/png;base64,${PRESENTATION_PNG.toString('base64')}`);
  const receipt = JSON.parse((await tools.run('view_office_images', { operation: 'inspect', delivery_ids: [deliveryId] })).output).deliveries[0];
  expect(receipt).toMatchObject({ state: vision && !revoke && media === 'allow' ? 'payload-submitted' : 'omitted', route: 'http', connection_id: 'roam', viewed: 'unknown', visual_review: 'not-run' });
  const sent = !!vision && !revoke && media === 'allow';
  expect(receipt).toMatchObject({ provider_result: sent ? reject ? 'rejected' : 'accepted' : 'unknown',
    transport: { submitted: sent ? 1 : 0, accepted: sent && !reject ? 1 : 0, rejected: sent && reject ? 1 : 0 } });
  expect(mediaGate).toHaveBeenCalledTimes(vision && media !== 'missing' ? 1 : 0);
  if (vision && media !== 'missing') expect(mediaGate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'vision', mediaClass: 'image', byteCount: PRESENTATION_PNG.length }));
  expect(JSON.stringify((backend as any).history)).not.toContain(PRESENTATION_PNG.toString('base64'));
  expect((backend as any).pendingOfficeVisuals).toEqual([]); expect(f.render).toHaveBeenCalledTimes(1);
});

it('HTTP Plan permits reading a captured Office image without Commands or Write and still uses the existing media choice', async () => {
  const f = await host(); const rendered = JSON.parse((await f.tools.run('render_office', { snapshot_ref: f.snapshot, adapter_id: 'powerpoint' })).output);
  f.policy.reload('none', []); const mediaGate = vi.fn(async () => {});
  const backend = new OpenAICompatBackend(config(f.root, 'openai-compat'), undefined, undefined, undefined, f.policy,
    { declaredMediaCapability: () => true, onBeforeMediaEgress: mediaGate });
  backends.push(backend); await backend.start({ ROAM_API_KEY: 'fixture-only-chat-key' });
  (backend as any).tools = f.tools; (backend as any).currentMode = 'plan';
  const viewed = await (backend as any).routeToolCall('view_office_images', { asset_ids: [rendered.images[0].asset_id] });
  expect(viewed.ok, viewed.output).toBe(true); expect(JSON.parse(viewed.output).deliveries[0]).toMatchObject({ state: 'prepared' });
  expect((backend as any).pendingOfficeVisuals[0].images).toHaveLength(1); expect(mediaGate).toHaveBeenCalledTimes(1);
});
