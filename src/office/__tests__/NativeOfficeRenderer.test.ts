import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, realpath, lstat, rm, readFile, readdir, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { NativeOfficeRenderer, libreOfficeTimeoutAlternative } from '../NativeOfficeRenderer';
import { NativeStageCleanup } from '../NativeStageCleanup';
import { OfficeRenderPureHost } from '../OfficeRenderPureHost';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../WindowsOfficeScript';
import { WINDOWS_LIBREOFFICE_RENDER_SCRIPT } from '../WindowsLibreOfficeScript';
import { WINDOWS_PDF_RASTER_SCRIPT } from '../WindowsPdfScript';
import { WINDOWS_WORD_PDF_CONVERT_SCRIPT } from '../WindowsWordPdfScript';
import { PRESENTATION_PNG } from '../../backend/__tests__/presentationImageFixtures';
import { encodePowerShellScript, WINDOWS_POWERSHELL_ARGS, type WindowsPowerShellDocumentRequest, type WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';

let root: string; let pure: OfficeRenderPureHost; let source: Buffer;
const retained = new Set<string>(); const homes = new Set<string>();
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'unode-renderer-test-')));
  const worker = join(root, 'pure.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  pure = new OfficeRenderPureHost(worker); const ppt = new PptxGenJS(); ppt.addSlide().addText('Actual source copy', { x: 1, y: 1, w: 6, h: 1 });
  source = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
});
afterAll(async () => {
  // All helper transports in this file are fakes; no Office or native process has these fixture files open.
  for (const path of [...retained, root]) {
    if (!path) continue;
    try { await lstat(path); } catch { continue; } // A later sweep in the test already removed this retained stage.
    if (await realpath(path) !== path || dirname(path) !== await realpath(tmpdir()) || !/^(?:unode-native-render-|unode-renderer-test-)/.test(basename(path)) || (await lstat(path)).isSymbolicLink()) throw Error('Unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
function fixture(change?: (job: any) => Promise<void | WindowsPowerShellDocumentResult>, nativeTimeoutMs?: number, options: { stagingLedger?: string; ownerRunning?: (pid: number) => boolean } = {}) {
  let stage = ''; const candidate = { id: 'powerpoint' as const, path: 'C:\\inert-fixture\\POWERPNT.EXE', sha256: 'a'.repeat(64), bytes: 1 };
  const catalog = { candidate: vi.fn(async () => candidate) };
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    homes.add(request.cwd); expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_OFFICE_RENDER_SCRIPT);
    expect(request).not.toHaveProperty('timeoutMs'); const job = JSON.parse(Buffer.from(request.input, 'base64').toString()); stage = dirname(job.source);
    const zip = await JSZip.loadAsync(await readFile(job.source)); expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('Actual source copy');
    await writeFile(join(job.output, 'page-1.png'), PRESENTATION_PNG); await writeFile(job.phase, 'opened');
    const override = await change?.(job); if (override) return override;
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', page_count: 1, completed_pages: 1, document_closed: true, app_version: '16.0', native_app: 'quit-by-helper', native_reason: 'inventory-empty-at-close', stage_released: true }) };
  });
  const renderer = new NativeOfficeRenderer({ platform: 'win32', catalog, pure, execute, memoryBudget: () => 64 * 1024 * 1024, retainStage: path => retained.add(path), nativeTimeoutMs, ...options });
  const beforeStart = vi.fn(async () => {}); const onPage = vi.fn(async (_page: any) => {});
  const job = { source, kind: 'pptx' as const, renderer: 'powerpoint' as const, signal: new AbortController().signal, current: () => true, beforeStart, onPage };
  return { renderer, catalog, execute, job, stage: () => stage || dirname([...homes].at(-1) ?? '') };
}
const jobOf = (request: WindowsPowerShellDocumentRequest) => JSON.parse(Buffer.from(request.input, 'base64').toString());
async function appears(file: string): Promise<string> {
  for (let i = 0; i < 2000; i++) { try { return await readFile(file, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
  throw Error('marker never appeared');
}
const helperAnswer = (job: any, fields: object): WindowsPowerShellDocumentResult => ({ status: 'exited', code: 0, signal: null, stderr: '',
  stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'failed', page_count: 0, completed_pages: 0, document_closed: true, ...fields }) });
it('skips an existing PowerPoint application for an automatic request and preserves a clear not-run reason', async () => {
  const f = fixture(async job => {
    expect(job.requirePrivateApplication).toBe(true); expect(job.nativeTimeoutMs).toBe(300000);
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
      status: 'not-run', error: 'powerpoint-already-running' }) };
  });
  expect(await f.renderer.render({ ...f.job, require_private_application: true })).toMatchObject({ state: 'not-run',
    error: 'powerpoint-already-running', application_export: 'not-started', pages: [] });
  expect(f.job.onPage).not.toHaveBeenCalled();
});
it('settles a stuck native stage as a timeout without ending its helper, never uses its late output and permits a later render', async () => {
  const f = fixture(undefined, 1); let marker = '';
  f.execute.mockImplementationOnce(async request => {
    homes.add(request.cwd); expect(request.helperClosesApplication).toBe(true); const job = jobOf(request);
    marker = await appears(job.stop); await writeFile(join(job.output, 'page-1.png'), PRESENTATION_PNG);
    return helperAnswer(job, { status: 'partial', error: 'native-stage-timeout', page_count: 1, completed_pages: 1, native_app: 'quit-by-helper', stage_released: true });
  });
  const result = await f.renderer.render(f.job);
  expect(result).toMatchObject({ state: 'failed', error: 'native-stage-timeout', application_export: 'unknown', pages: [],
    native_stop: { operation: 'timed-out', helper: 'closing', native_app: 'unknown', output: 'none', staging: 'kept-until-app-ends' } });
  expect(result.native_stop!.summary).toContain('five-minute limit');
  // Word/PowerPoint are never force-ended; LibreOffice's own identified conversion is, and no next-start deadline is promised.
  expect(result.native_stop!.summary).toContain('UnodeAi never force-ends Word or PowerPoint; for LibreOffice the helper ends only the conversion processes it started');
  expect(result.native_stop!.summary).toContain('tries to remove it only after the helper and the application are seen to have exited'); expect(result.native_stop!.summary).not.toMatch(/next starts|at the latest/);
  await f.renderer.closingSettled(); expect(marker).toBe('deadline');
  expect(result).toMatchObject({ state: 'failed', error: 'native-stage-timeout', pages: [], native_stop: { operation: 'timed-out', helper: 'exited', native_app: 'quit-by-helper', output: 'none', staging: 'removed' } });
  expect(f.job.onPage).not.toHaveBeenCalled();
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'passed', pages: [{ page: 1 }], native_stop: { operation: 'completed', native_app: 'quit-by-helper', output: 'kept', staging: 'removed' } });
}, 15000);
function libreFixture(stopped = false, nativeTimeoutMs?: number) {
  const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const pdfBytes = Buffer.from('%PDF-1.7\nexplicit native/PDF transport fixture\n');
  const candidate = { id: 'libreoffice' as const, path: 'C:\\inert-fixture\\soffice.exe', sha256: 'a'.repeat(64), bytes: 1 };
  const catalog = { candidate: vi.fn(async () => candidate) };
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    homes.add(request.cwd);
    expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_LIBREOFFICE_RENDER_SCRIPT);
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    expect(job).toMatchObject({ executable: candidate.path, executableSha256: candidate.sha256, helperHome: request.cwd });
    await mkdir(join(dirname(job.source), 'libreoffice-profile', 'user'), { recursive: true }); await writeFile(join(dirname(job.source), 'libreoffice-profile', 'user', 'registrymodifications.xcu'), 'private profile');
    expect(await readFile(job.source)).not.toEqual(source); // Actual passive worker copy has normalized ZIP bytes.
    if (stopped) {
      // The helper sees the stop marker, ends its own recorded conversion processes, and its late PDF is never used.
      await appears(job.stop); await writeFile(job.pdf, pdfBytes);
      return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'failed',
        error: 'native-stop-requested', document_closed: false, page_count: 0, completed_pages: 0, native_app: 'ended', native_reason: 'ended-at-stop', stage_released: true }) };
    }
    await writeFile(job.pdf, pdfBytes); await writeFile(job.phase, 'private-profile-process-exited');
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
      status: 'passed', app_version: '26.8.2', document_closed: true, page_count: 0, completed_pages: 0, native_app: 'ended', native_reason: 'conversion-exited', stage_released: true }) };
  });
  const rasterize = vi.fn(async (bytes: Buffer, _signal: AbortSignal, _current: () => boolean, onPage: (page: any) => Promise<void>, acceptPageCount?: (count: number) => boolean) => {
    expect(bytes).toEqual(pdfBytes);
    if (acceptPageCount && !acceptPageCount(1)) return { renderer: 'windows-pdf', source_sha256: hash(bytes), state: 'partial', pages: [], total_pages: 1, error: 'raster-page-count-mismatch', staging_cleanup: 'removed', scope: 'Explicit mismatched count fixture.' };
    const decoded = await pure.run<any>({ operation: 'png', bytes: PRESENTATION_PNG, memoryBudget: 16 * 1024 * 1024 }, PRESENTATION_PNG.length, new AbortController().signal, () => true);
    const page = { page: 1, bytes: PRESENTATION_PNG.length, sha256: decoded.sha256, width: decoded.width, height: decoded.height };
    await onPage({ ...page, data: PRESENTATION_PNG });
    return { renderer: 'windows-pdf', source_sha256: hash(bytes), state: 'passed', pages: [page], total_pages: 1, staging_cleanup: 'removed', scope: 'Explicit PDF transport fixture.' };
  });
  const renderer = new NativeOfficeRenderer({ platform: 'win32', catalog, pure, execute, pdf: { rasterize } as any, retainStage: stage => retained.add(stage), nativeTimeoutMs });
  const job = { source, kind: 'pptx' as const, renderer: 'libreoffice' as const, signal: new AbortController().signal, current: () => true,
    beforeStart: vi.fn(async () => {}), onPage: vi.fn(async () => {}) };
  return { renderer, job, execute, rasterize, catalog };
}
it('routes LibreOffice PPTX through the fixed private-profile helper then the existing internal PDF raster path', async () => {
  const f = libreFixture(); const result = await f.renderer.render(f.job);
  expect(JSON.parse(Buffer.from(f.execute.mock.calls[0][0].input, 'base64').toString()).passiveChartCopy).toBe(false);
  expect(result).toMatchObject({ renderer: 'libreoffice', state: 'passed', application_export: 'completed', document_closed: true, total_pages: 1, pages: [{ page: 1, width: 2, height: 1 }] });
  expect(f.job.beforeStart).toHaveBeenCalledWith(expect.objectContaining({ fixed_script_sha256: createHash('sha256').update(WINDOWS_LIBREOFFICE_RENDER_SCRIPT).digest('hex'), pdf_raster_script_sha256: createHash('sha256').update(WINDOWS_PDF_RASTER_SCRIPT).digest('hex') }));
  expect(f.job.onPage.mock.calls[0][0].data).toEqual(PRESENTATION_PNG); expect(f.execute).toHaveBeenCalledTimes(1); expect(f.rasterize).toHaveBeenCalledTimes(1);
});
it('permits native charts only for the verified passive chart copy and retains visual-review honesty', async () => {
  const f = libreFixture(); const ppt = new PptxGenJS();
  ppt.addSlide().addChart(ppt.ChartType.bar, [{ name: 'Sales', labels: ['North', 'South'], values: [15, 20] }], { x: 1, y: 1, w: 6, h: 3 });
  const chartSource = Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  const result = await f.renderer.render({ ...f.job, source: chartSource });
  expect(result).toMatchObject({ state: 'passed', application_export: 'completed',
    chart_display: { state: 'not-verified', charts: 1 }, pages: [{ page: 1 }] });
  expect(result.chart_display!.reason).toContain('not independent visual verification');
  const input = JSON.parse(Buffer.from(f.execute.mock.calls[0][0].input, 'base64').toString());
  expect(input).toMatchObject({ passiveChartCopy: true, renderCopySha256: result.render_copy!.render_copy_sha256 }); expect(f.job.onPage).toHaveBeenCalledTimes(1);
  expect(result.render_copy!.native_charts).toBe(1);
});
it('removes OLE packages and external targets before permitting the native chart engine', async () => {
  const f = libreFixture(); const ppt = new PptxGenJS();
  ppt.addSlide().addChart(ppt.ChartType.bar, [{ name: 'Sales', labels: ['North'], values: [15] }], { x: 1, y: 1, w: 6, h: 3 });
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  const relationships = 'ppt/slides/_rels/slide1.xml.rels';
  zip.file(relationships, (await zip.file(relationships)!.async('string')).replace('</Relationships>', '<Relationship Id="badOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/canary.bin"/><Relationship Id="badLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/NEVER_FETCH" TargetMode="External"/></Relationships>'));
  zip.file('ppt/embeddings/canary.bin', 'DO_NOT_RENDER');
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/embeddings/canary.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>'));
  zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml')!.async('string')).replace('</p:spTree>', '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="99" name="OLE"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj r:id="badOle"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree>'));
  const execute = f.execute.getMockImplementation()!;
  f.execute.mockImplementation(async request => {
    const input = JSON.parse(Buffer.from(request.input, 'base64').toString()); const bytes = await readFile(input.source);
    const copy = await JSZip.loadAsync(bytes); expect(input.passiveChartCopy).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.renderCopySha256);
    expect(Object.keys(copy.files).some(name => /embeddings|\.bin$|\.xlsx$/.test(name))).toBe(false);
    const all = (await Promise.all(Object.values(copy.files).map(file => file.async('string')))).join('');
    expect(all).not.toMatch(/DO_NOT_RENDER|NEVER_FETCH|oleObj|TargetMode="External"/);
    expect(all).toContain('numCache'); return execute(request);
  });
  const result = await f.renderer.render({ ...f.job, source: await zip.generateAsync({ type: 'nodebuffer' }) });
  expect(result.state).toBe('passed'); expect(f.execute).toHaveBeenCalledTimes(1);
});
it('settles LibreOffice Stop at once without signalling its helper, then records that the helper ended its own conversion', async () => {
  const f = libreFixture(true); const controller = new AbortController();
  const pending = f.renderer.render({ ...f.job, signal: controller.signal });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1), { timeout: 30_000 }); controller.abort();
  const result = await pending; expect(f.execute.mock.calls[0][0].helperClosesApplication).toBe(true);
  expect(result).toMatchObject({ state: 'cancelled', error: 'cancelled', application_export: 'unknown', pages: [],
    native_stop: { operation: 'stopped', helper: 'closing', native_app: 'unknown', output: 'none', staging: 'kept-until-app-ends' } });
  expect(result.native_stop!.summary).toMatch(/^The render request was cancelled; no output from it is used\. The helper is still closing this operation’s copy/);
  await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', pages: [], native_stop: { helper: 'exited', native_app: 'ended', native_reason: 'ended-at-stop', output: 'none', staging: 'removed' } });
  expect(f.rasterize).not.toHaveBeenCalled(); expect(f.job.onPage).not.toHaveBeenCalled();
});
it('reports missing LibreOffice without starting a helper or asking for execution', async () => {
  const f = libreFixture(); f.catalog.candidate.mockResolvedValueOnce(undefined as any);
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'not-run', error: 'renderer-not-detected', application_export: 'not-started', pages: [] });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.job.beforeStart).not.toHaveBeenCalled();
});
it('rejects a batch-script LibreOffice candidate before the execution proposal', async () => {
  const f = libreFixture(); f.catalog.candidate.mockResolvedValueOnce({ id: 'libreoffice', path: 'C:\\inert-fixture\\soffice.cmd', sha256: 'a'.repeat(64), bytes: 1 });
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'not-run', error: 'renderer-native-executable-required', application_export: 'not-started' });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.job.beforeStart).not.toHaveBeenCalled();
});
it('never publishes a LibreOffice PDF page under a guessed original slide ordinal after a count mismatch', async () => {
  const f = libreFixture(); const result = await f.renderer.render({ ...f.job, source_slide_count: 3 });
  expect(result).toMatchObject({ state: 'partial', error: 'raster-page-count-mismatch', total_pages: 1, pages: [] });
  expect(f.job.onPage).not.toHaveBeenCalled();
});
it('does not treat a failed LibreOffice PPTX export as a PowerPoint PNG export', async () => {
  const f = libreFixture();
  f.execute.mockImplementationOnce(async request => { homes.add(request.cwd); const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
      status: 'failed', document_closed: true, page_count: 0, completed_pages: 0, native_app: 'ended', stage_released: true }) }; });
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'failed', error: 'native-export-failed', pages: [] });
  expect(f.rasterize).not.toHaveBeenCalled(); expect(f.job.onPage).not.toHaveBeenCalled();
});
it('uses real pure-worker copy/PNG capture around a mocked native transport, keeps source binding and deletes only its known files', async () => {
  const f = fixture(); const result = await f.renderer.render(f.job);
  expect(result).toMatchObject({ state: 'passed', application_export: 'completed', document_closed: true, staging_cleanup: 'removed', total_pages: 1, pages: [{ page: 1, width: 2, height: 1 }] });
  expect(f.job.beforeStart).toHaveBeenCalledWith(expect.objectContaining({ source_sha256: createHash('sha256').update(source).digest('hex') }));
  expect(f.job.onPage.mock.calls[0][0].data).toEqual(PRESENTATION_PNG);
  expect(JSON.stringify(result)).not.toContain(f.stage()); expect(JSON.stringify(result)).not.toContain('inert-fixture'); await expect(access(f.stage())).rejects.toThrow();
});
it('preserves an unknown user-canary file instead of recursively deleting its stage', async () => {
  const f = fixture(async job => { await writeFile(join(dirname(job.source), 'user-canary.txt'), 'keep this unknown file'); });
  const result = await f.renderer.render(f.job);
  expect(result.state).toBe('passed'); expect(result.staging_cleanup).toBe('not-removed'); expect(await readFile(join(f.stage(), 'user-canary.txt'), 'utf8')).toBe('keep this unknown file');
});
it('uses a fresh operation-private helper cwd and removes native compiler scratch after completion', async () => {
  const f = fixture(async job => { await writeFile(join(dirname(job.source), 'tmp', 'compiler.tmp'), 'native scratch'); });
  expect((await f.renderer.render(f.job)).staging_cleanup).toBe('removed');
  const first = f.execute.mock.calls[0][0].cwd;
  expect(basename(first)).toBe('helper-home'); expect(basename(dirname(first))).toMatch(/^unode-native-render-/);
  await expect(access(first)).rejects.toThrow();
  expect((await f.renderer.render(f.job)).staging_cleanup).toBe('removed');
  expect(f.execute).toHaveBeenCalledTimes(2); expect(f.execute.mock.calls[1][0].cwd).not.toBe(first);
});
it('does not deliver a late native result when source authority retired', async () => {
  let current = true; const f = fixture(async () => { current = false; });
  const result = await f.renderer.render({ ...f.job, current: () => current });
  expect(result).toMatchObject({ state: 'cancelled', pages: [] }); expect(f.job.onPage).not.toHaveBeenCalled();
});
it('does not deliver pixels if source authority changes as the real decoder worker finishes', async () => {
  let current = true; const f = fixture(); const run = pure.run.bind(pure);
  const intercepted = vi.spyOn(pure, 'run').mockImplementation(async (...args: any[]) => {
    const value = await (run as any)(...args); if (args[0].operation === 'png') current = false; return value;
  });
  try {
    expect(await f.renderer.render({ ...f.job, current: () => current })).toMatchObject({ state: 'cancelled', pages: [] });
    expect(f.job.onPage).not.toHaveBeenCalled();
  } finally { intercepted.mockRestore(); }
});
it('keeps potentially active staging when a helper ended without a readable answer, and reports the application as unknown', async () => {
  const f = fixture(async () => ({ status: 'stopped', reason: 'output-limit', helper: 'stopped', stdout: '', stderr: '' }));
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'failed', error: 'native-output-limit', application_export: 'unknown', document_closed: false, staging_cleanup: 'not-removed', pages: [],
    native_stop: { operation: 'completed', helper: 'exited', native_app: 'unknown', native_reason: 'helper-output-limit', staging: 'kept-until-app-ends' } });
  expect(f.job.onPage).not.toHaveBeenCalled(); expect(await readFile(join(f.stage(), 'render-copy.pptx'))).not.toHaveLength(0);
});
it('keeps the stage when a helper answer lacks its own release facts: a missing field is never read as released', async () => {
  const f = fixture(async job => helperAnswer(job, { status: 'passed', page_count: 1, completed_pages: 1, document_closed: true }));
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'passed', staging_cleanup: 'not-removed', native_stop: { native_app: 'unknown', staging: 'kept-until-app-ends' } });
  expect(await readFile(join(f.stage(), 'render-copy.pptx'))).not.toHaveLength(0);
});
it('removes the stage when the helper was never started', async () => {
  const f = fixture(async () => ({ status: 'stopped', reason: 'cancelled', helper: 'not-started', stdout: '', stderr: '' }));
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'cancelled', application_export: 'not-started', staging_cleanup: 'removed', native_stop: { helper: 'not-started', native_app: 'not-started' } });
  await expect(access(f.stage())).rejects.toThrow();
});
it('rejects native claimed success with invalid page bytes before any page delivery', async () => {
  const f = fixture(async job => { await writeFile(join(job.output, 'page-1.png'), 'invalid PNG'); });
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'failed', pages: [] }); expect(f.job.onPage).not.toHaveBeenCalled();
});
it('preserves the existing authority-gate outcome and does not invoke a native helper on refusal', async () => {
  const f = fixture(); const refusal = { officeRenderGateOutcome: 'original trusted host refusal' };
  await expect(f.renderer.render({ ...f.job, beforeStart: async () => { throw refusal; } })).rejects.toBe(refusal); expect(f.execute).not.toHaveBeenCalled();
});
it('rechecks installed binding after authorization and does not use an obsolete candidate', async () => {
  const f = fixture(); f.catalog.candidate.mockResolvedValueOnce({ id: 'powerpoint', path: 'C:\\inert-fixture\\POWERPNT.EXE', sha256: 'b'.repeat(64), bytes: 1 });
  expect(await f.renderer.render(f.job)).toMatchObject({ state: 'failed', error: 'renderer-binding-changed' }); expect(f.execute).not.toHaveBeenCalled();
});

// Stop and host exit for Word/PowerPoint: only the helper closes its own document; the host never ends it.
const receiptFor = (job: any, fields: object) => writeFile(job.receipt, JSON.stringify({ version: 1, operation_id: job.operationId,
  host_pid: job.hostPid, helper_pid: 7001, process_name: 'POWERPNT', ...fields }));
const none = () => false;
function stoppable(fields: object, options: { receipt?: object; gate?: Promise<void>; pages?: boolean; running?: number[] } = {}) {
  const stagingLedger = join(root, 'ledger-' + randomUUID()); const controller = new AbortController();
  const f = fixture(undefined, undefined, { stagingLedger, ownerRunning: pid => (options.running ?? []).includes(pid) });
  f.execute.mockImplementationOnce(async request => {
    homes.add(request.cwd); const job = jobOf(request); expect(request.helperClosesApplication).toBe(true);
    expect(await appears(job.stop)).toBe('stop'); await options.gate;
    if (options.pages) await writeFile(join(job.output, 'page-1.png'), PRESENTATION_PNG);
    if (options.receipt) await receiptFor(job, options.receipt);
    return helperAnswer(job, fields);
  });
  const render = async () => {
    const pending = f.renderer.render({ ...f.job, signal: controller.signal });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1), { timeout: 30_000 }); controller.abort(); return pending;
  };
  return { ...f, stagingLedger, render };
}
it('normal completion removes the helper receipt and the stage, and a later Stop changes nothing', async () => {
  const stagingLedger = join(root, 'ledger-' + randomUUID()); const controller = new AbortController();
  const f = fixture(async job => {
    expect(job.receipt).toBe(join(stagingLedger, job.operationId + '.owner.json')); expect(job.hostPid).toBe(process.pid); expect(job.nativeTimeoutMs).toBe(300000);
    await receiptFor(job, { phase: 'closed', native_app: 'quit-by-helper', native_pid: 7002 });
  }, undefined, { stagingLedger, ownerRunning: none });
  const result = await f.renderer.render({ ...f.job, signal: controller.signal });
  expect(result).toMatchObject({ state: 'passed', staging_cleanup: 'removed', native_stop: { operation: 'completed', helper: 'exited', native_app: 'quit-by-helper', output: 'kept', staging: 'removed' } });
  expect(await readdir(stagingLedger)).toEqual([]); await expect(access(f.stage())).rejects.toThrow();
  controller.abort(); await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'passed', native_stop: { operation: 'completed', native_app: 'quit-by-helper' } }); expect(f.job.onPage).toHaveBeenCalledTimes(1);
});
it('Stop settles at once and the helper, after its fresh inventory, quits only its own empty private application', async () => {
  const f = stoppable({ error: 'native-stop-requested', native_app: 'quit-by-helper', native_reason: 'inventory-empty-at-close', application_quit: true, stage_released: true },
    { receipt: { phase: 'closed', native_app: 'quit-by-helper', native_pid: 7002 } });
  const result = await f.render();
  expect(result).toMatchObject({ state: 'cancelled', error: 'cancelled', pages: [], native_stop: { operation: 'stopped', helper: 'closing', native_app: 'unknown' } });
  await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', pages: [], native_stop: { helper: 'exited', native_app: 'quit-by-helper', output: 'none', staging: 'removed' } });
  expect(result.native_stop!.summary).toContain('closed after a fresh check'); expect(await readdir(f.stagingLedger)).toEqual([]);
});
it('Stop before the success commit never uses the helper output that arrives later', async () => {
  const f = stoppable({ status: 'passed', error: null, page_count: 1, completed_pages: 1, native_app: 'quit-by-helper', stage_released: true }, { pages: true });
  const result = await f.render(); await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', application_export: 'unknown', pages: [], native_stop: { operation: 'stopped', output: 'none', native_app: 'quit-by-helper' } });
  expect(f.job.onPage).not.toHaveBeenCalled();
});
it('Stop after another document joined the application: only this copy is closed and the application is reported left running', async () => {
  const f = stoppable({ error: 'native-stop-requested', native_app: 'left-running', native_reason: 'shared-at-stop', application_quit: false, stage_released: true },
    { receipt: { phase: 'closed', native_app: 'left-running', native_reason: 'shared-at-stop', native_pid: 7002 } });
  const result = await f.render(); await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', native_stop: { helper: 'exited', native_app: 'left-running', native_reason: 'shared-at-stop' } });
  expect(result.application_quit).toBeUndefined(); expect(result.native_stop!.summary).toContain('other documents were open at the stop');
  expect(result.native_stop!.summary).not.toMatch(/closed after|ended/);
});
it('an unresponsive helper is never ended: the application stays unknown and the stage is kept until it exits', async () => {
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  const f = stoppable({ error: 'native-stop-requested', document_closed: false, native_app: 'unknown', native_reason: 'own-document-not-closed', stage_released: false },
    { gate, running: [7002], receipt: { phase: 'unknown', native_app: 'unknown', native_reason: 'own-document-not-closed', native_pid: 7002 } });
  const result = await f.render();
  expect(result).toMatchObject({ state: 'cancelled', native_stop: { helper: 'closing', native_app: 'unknown', staging: 'kept-until-app-ends' } });
  await f.renderer.dispose(); expect(await access(f.stage())).toBeUndefined();
  expect((await readdir(f.stagingLedger)).some(name => name.endsWith('.pending.json'))).toBe(true);
  resume(); await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', native_stop: { helper: 'exited', native_app: 'unknown', staging: 'kept-until-app-ends' } });
  expect(result.native_stop!.summary).toContain('unknown; UnodeAi does not force-end it'); expect(await access(f.stage())).toBeUndefined();
  await new NativeStageCleanup(f.stagingLedger, pid => pid === 7002).recover(); expect(await access(f.stage())).toBeUndefined();
  await new NativeStageCleanup(f.stagingLedger, none).recover(); await expect(access(f.stage())).rejects.toThrow();
});
it('Stop during startup before ownership was confirmed records the application as unknown and keeps the stage', async () => {
  const f = stoppable({ error: 'native-stop-requested', document_closed: false, native_app: 'unknown', native_reason: 'ownership-not-confirmed', application_owned: false, stage_released: false },
    { receipt: { phase: 'unknown', native_app: 'unknown', native_reason: 'ownership-not-confirmed' } });
  const result = await f.render(); await f.renderer.closingSettled();
  expect(result).toMatchObject({ state: 'cancelled', native_stop: { helper: 'exited', native_app: 'unknown', native_reason: 'ownership-not-confirmed', staging: 'kept-until-app-ends' } });
  await new NativeStageCleanup(f.stagingLedger, none).recover(); expect(await access(f.stage())).toBeUndefined();
});
it('keeps every fixed native helper launchable: its encoded script fits the Windows command line', () => {
  // CreateProcess accepts at most 32767 characters; allow a full MAX_PATH for the system PowerShell path and its quotes.
  for (const script of [WINDOWS_OFFICE_RENDER_SCRIPT, WINDOWS_LIBREOFFICE_RENDER_SCRIPT, WINDOWS_PDF_RASTER_SCRIPT, WINDOWS_WORD_PDF_CONVERT_SCRIPT]) {
    expect(260 + 3 + WINDOWS_POWERSHELL_ARGS.join(' ').length + 1 + encodePowerShellScript(script).length).toBeLessThan(32767);
  }
});
it('runs a PDF only as a Word conversion, and a conversion only of a PDF with Word', async () => {
  const job = { source: Buffer.from('%PDF-1.7'), signal: new AbortController().signal, current: () => true, beforeStart: vi.fn(async () => {}), onPage: vi.fn() };
  for (const wrong of [{ kind: 'pdf' as const, renderer: 'word' as const }, { kind: 'pdf' as const, renderer: 'libreoffice' as const, intent: 'convert-docx' as const },
    { kind: 'docx' as const, renderer: 'word' as const, intent: 'convert-docx' as const }]) {
    expect(await new NativeOfficeRenderer({ platform: 'win32' }).render({ ...job, ...wrong })).toMatchObject({ state: 'not-run', error: 'render-kind-mismatch' });
  }
  expect(job.beforeStart).not.toHaveBeenCalled();
});
it('names the document-type alternative when LibreOffice reports its own time limit', async () => {
  expect(libreOfficeTimeoutAlternative('docx')).toMatch(/Word \(adapter_id word\).*split it into smaller documents/);
  expect(libreOfficeTimeoutAlternative('pptx')).toMatch(/PowerPoint \(adapter_id powerpoint\) if it is installed.*split it into smaller presentations/);
  const f = libreFixture();
  f.execute.mockImplementationOnce(async request => { homes.add(request.cwd);
    return helperAnswer(jobOf(request), { error: 'native-stage-timeout', document_closed: false, native_app: 'ended', native_reason: 'ended-at-timeout', stage_released: true }); });
  const result = await f.renderer.render(f.job);
  expect(result).toMatchObject({ state: 'failed', error: 'native-stage-timeout', pages: [], native_stop: { operation: 'timed-out', next: libreOfficeTimeoutAlternative('pptx') } });
  expect(result.native_stop!.summary).toContain('PowerPoint (adapter_id powerpoint) if it is installed');
});
it('names the document-type alternative when the host deadline ends a LibreOffice stage, and keeps it after the helper ends', async () => {
  const f = libreFixture(false, 1);
  f.execute.mockImplementationOnce(async request => { homes.add(request.cwd); const job = jobOf(request); await appears(job.stop);
    return helperAnswer(job, { error: 'native-stage-timeout', document_closed: false, native_app: 'ended', native_reason: 'ended-at-timeout', stage_released: true }); });
  const result = await f.renderer.render(f.job);
  expect(result).toMatchObject({ state: 'failed', error: 'native-stage-timeout', native_stop: { operation: 'timed-out', helper: 'closing', next: libreOfficeTimeoutAlternative('pptx') } });
  await f.renderer.closingSettled();
  expect(result.native_stop).toMatchObject({ helper: 'exited', native_app: 'ended', next: libreOfficeTimeoutAlternative('pptx') });
  expect(result.native_stop!.summary).toContain('split it into smaller presentations');
}, 15000);
it('a Word/PowerPoint time limit names no LibreOffice alternative', async () => {
  const f = fixture(async job => helperAnswer(job, { status: 'failed', error: 'native-stage-timeout', native_app: 'quit-by-helper', stage_released: true }));
  const result = await f.renderer.render(f.job);
  expect(result).toMatchObject({ error: 'native-stage-timeout', native_stop: { operation: 'timed-out' } }); expect(result.native_stop!.next).toBeUndefined();
});
