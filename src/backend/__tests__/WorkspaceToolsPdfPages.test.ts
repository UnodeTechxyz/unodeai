import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { join } from 'node:path';
import UPNG from '@pdf-lib/upng';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { saveHost } from './attachmentSaveFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { makePdf, sha } from '../../office/pdf/__tests__/pdfFixtures';
import { PdfSignatureStore } from '../../office/pdf/PdfSignatureStore';
import { WindowsPdfRasterizer } from '../../office/WindowsPdfRasterizer';
import { pdfPageRasterPlatform } from '../../office/platform/PdfPageRasterPlatform';
import { decodePng } from '../../office/PngDecode';
import type { WindowsPowerShellDocumentRequest, WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';
import type { SessionPathAccessGrant } from '../localReadScope';

/** Solid red pages of the given pixel size, written by a fake helper; the real rasterizer stages, decodes and delivers them. */
const red = (width: number, height: number) => Buffer.from(UPNG.encode([new Uint8Array(width * height * 4).map((_v, at) => [220, 20, 20, 255][at % 4]).buffer], width, height, 0));
function windowsPlatform(pageCount: number, size: [number, number] = [30, 40]) {
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    for (let page = 1; page <= pageCount; page++) await fs.writeFile(join(job.output, `page-${page}.png`), red(...size));
    return { status: 'exited', code: 0, signal: null, stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', page_count: pageCount, completed_pages: pageCount }), stderr: '' };
  });
  // A Windows-form system root on every host; executable resolution is the identity so no host file is needed.
  return { execute, platform: pdfPageRasterPlatform('win32', { SystemRoot: path.win32.join(path.win32.sep, 'Windows') }, new WindowsPdfRasterizer({ execute, memoryBudget: () => 64 * 1024 * 1024 }), command => command) };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });

async function pagesHost(options: { commands?: 'all' | 'none'; pageCount?: number; size?: [number, number]; platform?: 'windows' | 'none' } = {}) {
  const h = await saveHost({ decide: async () => 'once' });
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [h.root, new Set(['read', 'write', 'execute']), 'dev', undefined, new CommandPolicy(options.commands ?? 'all')];
  parameters[22] = h.assets; const tools = new WorkspaceTools(...parameters); tools.setFileWrites(h.fileWrites('dev'));
  const fake = windowsPlatform(options.pageCount ?? 3, options.size);
  tools.setPdfPageRasterPlatform(() => options.platform === 'none' ? undefined : fake.platform);
  const store = new PdfSignatureStore(join(await temporaryFolder('unode-pages-signature-'), 'signature')); tools.setPdfSignatures(store);
  tools.beginTurn(); cleanup.push(async () => { tools.retire(); await h.assets.dispose(); });
  return { ...h, tools, store, execute: fake.execute };
}
const pixel = (png: Buffer, x: number, y: number) => { const decoded = decodePng(png, 1 << 26); const at = (y * decoded.width + x) * 4; return [...decoded.pixels.subarray(at, at + 4)]; };

it('view_pdf_pages renders the selected pages through the gated Windows renderer and registers them for view_office_images', async () => {
  const h = await pagesHost(); await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'One' }, { text: 'Two' }, { text: 'Three' }]));
  expect(h.tools.specs().some(spec => spec.function.name === 'view_pdf_pages')).toBe(true);
  const result = await h.tools.run('view_pdf_pages', { path: 'in.pdf', pages: '1,3' });
  expect(result.status, result.output).toBe('success'); const output = JSON.parse(result.output);
  expect(output).toMatchObject({ state: 'rendered', renderer: 'windows-pdf', total_pages: 3, pages: [{ page: 1, width: 30, height: 40 }, { page: 3 }] });
  expect(h.execute).toHaveBeenCalledTimes(1);
  const viewed = await h.tools.run('view_office_images', { asset_ids: output.pages.map((page: any) => page.asset_id) });
  expect(viewed.status, viewed.output).toBe('success');
  const tooMany = await h.tools.run('view_pdf_pages', { path: 'in.pdf', pages: '1-11' }); expect(tooMany.output).toContain('invalid-pages');
  const outside = await h.tools.run('view_pdf_pages', { path: 'in.pdf', pages: '7' }); expect(outside.status).toBe('failed'); expect(outside.output).toContain('the PDF has 3 pages');
});

it('view_pdf_pages is platform-unsupported without an adapter and refused when Commands are Off, without running anything', async () => {
  const none = await pagesHost({ platform: 'none' }); await fs.writeFile(join(none.root, 'in.pdf'), await makePdf([{ text: 'One' }]));
  const unsupported = await none.tools.run('view_pdf_pages', { path: 'in.pdf', pages: '1' });
  expect(unsupported.status).toBe('success'); expect(JSON.parse(unsupported.output)).toMatchObject({ state: 'not-run', reason: 'platform-unsupported' });
  expect(pdfPageRasterPlatform('darwin')).toBeUndefined(); expect(pdfPageRasterPlatform('linux')).toBeUndefined();
  const off = await pagesHost({ commands: 'none' }); await fs.writeFile(join(off.root, 'in.pdf'), await makePdf([{ text: 'One' }]));
  const refused = await off.tools.run('view_pdf_pages', { path: 'in.pdf', pages: '1' });
  expect(refused.status).toBe('refused'); expect(off.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(refused)).toContain('PDF page images run the Windows page renderer, which needs Commands');
});

it('a signed page is masked in the registered image after the signed file was rotated and reordered (13.13)', async () => {
  const h = await pagesHost({ pageCount: 2, size: [80, 60] }); h.tools.setPdfEditor(await pdfRouteEditor());
  const pixels = new Uint8Array(4 * 2 * 4); for (let at = 0; at < pixels.length; at += 4) pixels.set([10, 20, 120, at < 16 ? 255 : 0], at);
  expect((await h.store.save(Buffer.from(UPNG.encode([pixels.buffer], 4, 2, 0)))).ok).toBe(true);
  await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Sign here' }, { text: 'Annex' }]));
  expect((await h.tools.run('edit_pdf', { schema_version: 1, destination: 'signed.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [40, 300, 120, 60] }] })).status).toBe('success');
  expect((await h.tools.run('edit_pdf', { schema_version: 1, destination: 'turned.pdf', inputs: [{ path: 'signed.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }, { op: 'reorder_pages', order: [2, 1] }] })).status).toBe('success');
  const result = await h.tools.run('view_pdf_pages', { path: 'turned.pdf', pages: '1-2' }); expect(result.status, result.output).toBe('success');
  const output = JSON.parse(result.output); expect(output.note).toContain('hidden'); expect(output.pages.map((page: any) => page.signatures_hidden)).toEqual([0, 1]);
  // Turned page 2 is 400 x 300 pt shown as 80 x 60 px; the signature moved to [40, 40, 60, 120] pt = [8, 8, 12, 24] px.
  const stored = await h.assets.imageBytesForDocument(output.pages[1].asset_id); if ('error' in stored) throw new Error(stored.error);
  expect(sha(stored.bytes)).toBe(output.pages[1].sha256);
  expect(pixel(Buffer.from(stored.bytes), 12, 20)).toEqual([255, 255, 255, 255]); expect(pixel(Buffer.from(stored.bytes), 70, 50)).toEqual([220, 20, 20, 255]);
  const plain = await h.assets.imageBytesForDocument(output.pages[0].asset_id); if ('error' in plain) throw new Error(plain.error);
  expect(pixel(Buffer.from(plain.bytes), 12, 20)).toEqual([220, 20, 20, 255]);
});

it('a Read grant revoked while the page-render command waits for approval is named as the cause, not a skill change', async () => {
  const h = await saveHost({ decide: async () => 'once' });
  const outside = await fs.realpath(await temporaryFolder('unode-pages-granted-')); await fs.writeFile(join(outside, 'granted.pdf'), await makePdf([{ text: 'One' }]));
  let granted = true;
  const grant: SessionPathAccessGrant = { id: 'grant-pages', permission: 'read', lifetime: 'session', current: () => granted,
    target: { kind: 'directory', permission: 'read', lexicalPath: outside, realPath: outside, realParent: path.dirname(outside) } };
  const approve = vi.fn(async () => { granted = false; return { allow: true }; });
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [h.root, new Set(['read', 'write', 'execute']), 'dev', undefined, new CommandPolicy('ask'), undefined, approve];
  parameters[22] = h.assets; const tools = new WorkspaceTools(...parameters); tools.setFileWrites(h.fileWrites('dev'));
  tools.setLivePathAccess(() => granted ? [grant] : []);
  // The fixed renderer's executable must be a real file for its resource scope to bind (production resolves the real
  // Windows PowerShell); the helper process itself stays a fixture.
  const executable = join(await fs.realpath(await temporaryFolder('unode-pages-shell-')), 'powershell.exe'); await fs.writeFile(executable, 'fixture');
  const fake = windowsPlatform(1);
  const platform = pdfPageRasterPlatform('win32', { SystemRoot: path.win32.join(path.win32.sep, 'Windows') }, new WindowsPdfRasterizer({ execute: fake.execute, memoryBudget: () => 64 * 1024 * 1024 }), () => executable);
  tools.setPdfPageRasterPlatform(() => platform);
  tools.beginTurn(); cleanup.push(async () => { tools.retire(); await h.assets.dispose(); });
  const result = await tools.run('view_pdf_pages', { path: join(outside, 'granted.pdf'), pages: '1' });
  expect(approve).toHaveBeenCalledTimes(1); expect(fake.execute).not.toHaveBeenCalled();
  expect(result.status, result.output).toBe('refused');
  const text = JSON.stringify(result);
  expect(text).not.toMatch(/skill/i);
  expect(text).toContain('Read access');
});
