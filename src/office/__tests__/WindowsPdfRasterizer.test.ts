import { describe, expect, it, vi } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from '@pdf-lib/upng';
import { WindowsPdfRasterizer } from '../WindowsPdfRasterizer';
import type { WindowsPowerShellDocumentRequest, WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';

const png = () => Buffer.from(UPNG.encode([Uint8Array.from([200, 30, 60, 255]).buffer], 1, 1, 0));
const source = Buffer.from('%PDF-owned fixture');
function fixture(change?: (job: any, request: WindowsPowerShellDocumentRequest) => Promise<Partial<any> | void>) {
  let stage = '';
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    stage = request.cwd;
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    expect(await readFile(job.source)).toEqual(source);
    await writeFile(join(job.output, 'page-1.png'), png());
    const response = { version: 1, operation_id: job.operationId, status: 'passed', page_count: 1, completed_pages: 1, ...await change?.(job, request) };
    return { status: 'exited', code: 0, signal: null, stdout: JSON.stringify(response), stderr: '' };
  });
  return { execute, stage: () => stage, raster: new WindowsPdfRasterizer({ execute, memoryBudget: () => 1024 * 1024 }) };
}
describe('owned native PDF capture (helper transport mocked; real files and PNG decoding)', () => {
  it('withholds every source-indexed page when the observed PDF count cannot map the original units', async () => {
    const f = fixture(); const deliver = vi.fn();
    const result = await f.raster.rasterize(source, new AbortController().signal, () => true, deliver, count => count === 3);
    expect(result).toMatchObject({ state: 'partial', error: 'raster-page-count-mismatch', total_pages: 1, pages: [] });
    expect(deliver).not.toHaveBeenCalled();
  });
  it('captures exact decoded pages, awaits delivery, removes its stage, and passes no deadline', async () => {
    const f = fixture(); const delivered: any[] = [];
    const result = await f.raster.rasterize(source, new AbortController().signal, () => true, async page => { delivered.push(page); });
    expect(result).toMatchObject({ state: 'passed', total_pages: 1, staging_cleanup: 'removed', pages: [{ page: 1, width: 1, height: 1 }] });
    expect(delivered[0].data).toEqual(png()); expect(delivered[0].sha256).toBe(result.pages[0].sha256);
    expect(f.execute.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
    await expect(access(f.stage())).rejects.toThrow();
  });
  it('rejects claimed success with corrupt image bytes before delivery', async () => {
    const f = fixture(async job => { await writeFile(join(job.output, 'page-1.png'), 'not an image'); }); const deliver = vi.fn();
    expect(await f.raster.rasterize(source, new AbortController().signal, () => true, deliver)).toMatchObject({ state: 'failed', error: 'raster-page-invalid', pages: [] });
    expect(deliver).not.toHaveBeenCalled();
  });
  it('keeps exact earlier page facts when a later declared page is invalid', async () => {
    const f = fixture(async job => { await writeFile(join(job.output, 'page-2.png'), 'broken'); return { page_count: 2, completed_pages: 2 }; });
    const deliver = vi.fn(); const result = await f.raster.rasterize(source, new AbortController().signal, () => true, deliver);
    expect(result).toMatchObject({ state: 'partial', total_pages: 2, pages: [{ page: 1 }] }); expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('does not publish late output after request retirement', async () => {
    let current = true; const f = fixture(async () => { current = false; }); const deliver = vi.fn();
    expect(await f.raster.rasterize(source, new AbortController().signal, () => current, deliver)).toMatchObject({ state: 'cancelled', pages: [] });
    expect(deliver).not.toHaveBeenCalled();
  });
  it('rejects source replacement and forged or incomplete response identity', async () => {
    for (const change of [async (job: any) => { await writeFile(job.source, 'replacement'); }, async () => ({ operation_id: 'other' }), async () => ({ completed_pages: 0 })]) {
      const f = fixture(change); const deliver = vi.fn();
      expect((await f.raster.rasterize(source, new AbortController().signal, () => true, deliver)).state).toBe('failed'); expect(deliver).not.toHaveBeenCalled();
    }
  });
  it('distinguishes unavailable native runtime from a document failure', async () => {
    const f = fixture(async () => ({ status: 'not-run', error: 'windows-pdf-unavailable' }));
    expect(await f.raster.rasterize(source, new AbortController().signal, () => true)).toMatchObject({ state: 'not-run', error: 'windows-pdf-unavailable', pages: [] });
  });
  it('does no staging or launch for an already stopped request or over-budget input', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect((await f.raster.rasterize(source, controller.signal, () => true)).state).toBe('cancelled');
    const small = new WindowsPdfRasterizer({ execute: f.execute, memoryBudget: () => 1 });
    expect((await small.rasterize(source, new AbortController().signal, () => true)).error).toBe('pdf-memory-limited'); expect(f.execute).not.toHaveBeenCalled();
  });
});
