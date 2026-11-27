import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { build } from 'esbuild';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import type { AgentConfig } from '../../types';
import { OfficeReader } from '../../office/OfficeReader';
import { NativeOfficeRenderer } from '../../office/NativeOfficeRenderer';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { WindowsPdfRasterizer } from '../../office/WindowsPdfRasterizer';
import { WINDOWS_LIBREOFFICE_RENDER_SCRIPT } from '../../office/WindowsLibreOfficeScript';
import { officeRouteReader } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { PRESENTATION_PNG } from './presentationImageFixtures';

const lookup = vi.hoisted(() => ({ executable: '' }));
vi.mock('../../security/HostExecutableResolver', async original => ({ ...await original<any>(), resolveHostExecutable: () => lookup.executable }));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
let reader: OfficeReader; let worker: string; let source: Buffer;
const ownedRoots = new Set<string>(); const helperHomes = new Set<string>(); const toolsToClose: WorkspaceTools[] = [];
beforeAll(async () => {
  reader = await officeRouteReader(); const root = dirname((reader as any).worker); ownedRoots.add(root); worker = join(root, 'hidden-copy-worker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const deck = new PptxGenJS(); for (const text of ['First', 'Hidden backup', 'Third original slide']) deck.addSlide().addText(text, { x: 1, y: 1, w: 6, h: 1 });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  zip.file('ppt/slides/slide2.xml', (await zip.file('ppt/slides/slide2.xml')!.async('string')).replace('<p:sld ', '<p:sld show="0" '));
  source = await zip.generateAsync({ type: 'nodebuffer' });
});
afterAll(async () => {
  for (const tools of toolsToClose) { tools.retire(); await tools.disposeBackground(); }
  await reader.dispose();
  for (const root of ownedRoots) { const canonical = await fs.realpath(root); expect(dirname(canonical)).toBe(await fs.realpath(tmpdir()));
    expect(basename(canonical)).toMatch(/^unode-(?:hidden-slides-|office-route-worker-)/); expect((await fs.lstat(root)).isSymbolicLink()).toBe(false); }
  await removeTemporaryFolders();
  for (const home of helperHomes) await expect(fs.access(home)).rejects.toThrow();
  vi.unstubAllEnvs();
});
it.each(['powerpoint', 'auto'] as const)('the HTTP backend uses the hosted renderer binding and preference for %s', async adapter => {
  const root = await temporaryFolder('unode-hidden-slides-'); ownedRoots.add(root);
  lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture'); vi.stubEnv('SystemRoot', 'C:\\Windows');
  await fs.writeFile(join(root, 'source.pptx'), source);
  const render = vi.fn(async (job: any) => ({ operation_id: job.operation_id, renderer: job.renderer, source_sha256: hash(job.source),
    state: 'not-run', application_export: 'not-started', document_closed: false, pages: [], staging_cleanup: 'removed', scope: 'Hosted renderer binding fixture only.' }));
  const config: AgentConfig = { id: 'hosted', name: 'Hosted', role: 'custom', skill: '', systemPrompt: '', backend: 'openai-compat',
    provider: { providerId: 'roam', apiKeySecretName: 'unused-fixture-key' }, model: 'fixture-model', workingDirectory: root, allowedTools: ['read', 'execute'], autoApprove: true };
  const parameters: ConstructorParameters<typeof OpenAICompatBackend> = [config, async () => { throw Error('No model request expected'); }, undefined, undefined, new CommandPolicy('all', [])];
  const preferences = vi.fn(() => ({ preferred: 'word-powerpoint' as const, automaticWindowsCom: false }));
  const candidate = vi.fn(async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: 'host-scoped-inert-candidate', sha256: 'a'.repeat(64), bytes: 1 }));
  parameters[16] = { nativeOfficeRenderer: { render }, officeRenderPreferences: preferences, officeApplicationCatalog: { candidate } };
  const backend = new OpenAICompatBackend(...parameters); const tools = (backend as any).tools as WorkspaceTools;
  tools.setOfficeReader(new OfficeReader((reader as any).worker));
  try {
    const inspected = await tools.run('inspect_office', { path: 'source.pptx' }); expect(inspected.status, inspected.output).toBe('success');
    const outcome = await tools.run('render_office', { snapshot_ref: JSON.parse(inspected.output).snapshot_ref, adapter_id: adapter });
    expect(outcome.status, outcome.output).toBe('success'); const result = JSON.parse(outcome.output);
    expect(result.result).toMatchObject({ state: 'not-run', scope: 'Hosted renderer binding fixture only.' });
    expect(render).toHaveBeenCalledTimes(1); expect(render.mock.calls[0][0].source_slide_count).toBe(3);
    if (adapter === 'auto') { expect(preferences).toHaveBeenCalled(); expect(candidate).toHaveBeenCalledExactlyOnceWith('powerpoint'); }
    else expect(candidate).not.toHaveBeenCalled();
  } finally { await backend.stop(); }
});
it('keeps hidden slide ordinals, and withholds every image if a converter silently omitted the hidden slide', async () => {
  const root = await temporaryFolder('unode-hidden-slides-'); ownedRoots.add(root);
  lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture'); vi.stubEnv('SystemRoot', 'C:\\Windows');
  const tools = new WorkspaceTools(root, new Set(['read', 'execute']), 'reviewer', undefined, new CommandPolicy('all', [])); toolsToClose.push(tools);
  tools.setOfficeReader(reader); tools.beginTurn(); await fs.writeFile(join(root, 'source.pptx'), source);
  const inspected = await tools.run('inspect_office', { path: 'source.pptx' }); expect(inspected.status, inspected.output).toBe('success');
  const snapshot = JSON.parse(inspected.output).snapshot_ref; let pdfPages = 2;
  const pdf = new WindowsPdfRasterizer({ execute: async request => {
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    for (let page = 1; page <= pdfPages; page++) await fs.writeFile(join(job.output, `page-${page}.png`), PRESENTATION_PNG);
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
      status: 'passed', page_count: pdfPages, completed_pages: pdfPages }) };
  } });
  tools.useNativeOfficeRenderer(new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(worker), pdf,
    catalog: { candidate: async () => ({ id: 'libreoffice', path: join(root, 'inert-soffice.exe'), sha256: 'a'.repeat(64), bytes: 1 }) },
    execute: async request => {
      helperHomes.add(request.cwd); expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_LIBREOFFICE_RENDER_SCRIPT);
      const job = JSON.parse(Buffer.from(request.input, 'base64').toString()); const copy = await JSZip.loadAsync(await fs.readFile(job.source));
      expect(await copy.file('ppt/slides/slide2.xml')!.async('string')).toContain('show="0"');
      await fs.writeFile(job.pdf, '%PDF-explicit native conversion fixture'); await fs.writeFile(job.phase, 'private-profile-process-exited');
      return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId,
        status: 'passed', document_closed: true, page_count: 0, completed_pages: 0, native_app: 'ended', stage_released: true }) };
    } }));
  const mismatched = JSON.parse((await tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'libreoffice', pages: { start: 3, end: 3 } })).output);
  expect(mismatched.result).toMatchObject({ state: 'partial', error: 'raster-page-count-mismatch', total_pages: 2 }); expect(mismatched.images).toEqual([]);
  pdfPages = 3;
  const matched = JSON.parse((await tools.run('render_office', { snapshot_ref: snapshot, adapter_id: 'libreoffice', pages: { start: 3, end: 3 } })).output);
  expect(matched.result).toMatchObject({ state: 'passed', total_pages: 3 }); expect(matched.images.map((image: any) => image.page)).toEqual([3]);
  const provenance = (tools as any).contentAssets.officeImageProvenance(matched.images[0].asset_id);
  expect(provenance.fact).toMatchObject({ page: 3, source_sha256: hash(source) }); expect(await fs.readFile(join(root, 'source.pptx'))).toEqual(source);
});
