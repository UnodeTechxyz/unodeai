import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, realpath, lstat, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import UPNG from '@pdf-lib/upng';
import { Document, Packer, Paragraph } from 'docx';
import { OfficeRenderPureHost } from '../OfficeRenderPureHost';
import type { OfficeRenderCopy } from '../OfficeRenderCopy';
import type { OfficeImagePreview } from '../OfficeImagePreview';
import { decodePng } from '../PngDecode';
import { PRESENTATION_PNG } from '../../backend/__tests__/presentationImageFixtures';
import { assertOfficeRenderPureWorkerBundleGraph } from '../../../scripts/office-render-pure-worker-bundle.mjs';

let root: string; let host: OfficeRenderPureHost; let source: string; let original: Buffer;
const budget = 64 * 1024 * 1024;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'unode-pure-render-test-')));
  const worker = join(root, 'OfficeRenderPureWorker.cjs');
  // The single affected worker fixture only, not a product/candidate build.
  const bundled = await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', metafile: true });
  assertOfficeRenderPureWorkerBundleGraph(bundled.metafile!);
  host = new OfficeRenderPureHost(worker); source = join(root, 'source.docx');
  original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Actual isolated render copy')] }] }));
  await writeFile(source, original);
});
afterAll(async () => {
  if (!root) return;
  if (await realpath(root) !== root || dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('unode-pure-render-test-') || (await lstat(root)).isSymbolicLink()) throw Error('Unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
});
it('runs the production copy builder in a real worker, returns actual ZIP bytes and leaves source unchanged', async () => {
  const result = await host.run<OfficeRenderCopy>({ operation: 'copy', source, memoryBudget: budget }, original.length, new AbortController().signal, () => true);
  const bytes = Buffer.from(result.bytes); const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Actual isolated render copy');
  expect(result.fact.render_copy_sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(await readFile(source)).toEqual(original);
});
it('decodes real PNG bytes and rejects corrupt images with a bounded reason', async () => {
  const result = await host.run({ operation: 'png', bytes: PRESENTATION_PNG, memoryBudget: budget }, PRESENTATION_PNG.length, new AbortController().signal, () => true);
  expect(result).toMatchObject({ width: 2, height: 1, sha256: createHash('sha256').update(PRESENTATION_PNG).digest('hex') });
  await expect(host.run({ operation: 'png', bytes: Buffer.from('bad'), memoryBudget: budget }, 3, new AbortController().signal, () => true)).rejects.toThrow('invalid-image');
});
it('waits for an actual newly started worker to terminate on Stop, and refuses late results after retirement', async () => {
  const controller = new AbortController();
  const stopped = host.run({ operation: 'copy', source, memoryBudget: budget }, original.length, controller.signal, () => true);
  controller.abort(); await expect(stopped).rejects.toThrow('cancelled');
  let current = true;
  const retired = host.run({ operation: 'copy', source, memoryBudget: budget }, original.length, new AbortController().signal, () => current);
  current = false; await expect(retired).rejects.toThrow('cancelled'); expect(await readFile(source)).toEqual(original);
});
it('does not start an already-cancelled worker and reports a missing fixed worker without a native fallback', async () => {
  const stopped = new AbortController(); stopped.abort();
  await expect(host.run({ operation: 'png', bytes: PRESENTATION_PNG, memoryBudget: budget }, 10, stopped.signal, () => true)).rejects.toThrow('cancelled');
  await expect(new OfficeRenderPureHost(join(root, 'missing-worker.cjs')).run({ operation: 'png', bytes: PRESENTATION_PNG, memoryBudget: budget }, 10, new AbortController().signal, () => true)).rejects.toThrow('render-worker-failed');
});
it('keeps an image that fits byte-exact in the actual preview worker and reports both image identities', async () => {
  const preview = await host.run<OfficeImagePreview>({ operation: 'preview', bytes: PRESENTATION_PNG, maxBytes: 1024, memoryBudget: budget },
    PRESENTATION_PNG.length, new AbortController().signal, () => true);
  expect(Buffer.from(preview.bytes)).toEqual(PRESENTATION_PNG); expect(preview).toMatchObject({ width: 2, height: 1, original_width: 2, original_height: 1, resized: false, reencoded: false });
  expect(preview.sha256).toBe(preview.original_sha256);
});
it('makes an actually decodable bounded preview in its worker without changing the retained original', async () => {
  const pixels = new Uint8Array(64 * 32 * 4); let seed = 1977;
  for (let at = 0; at < pixels.length; at++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[at] = at % 4 === 3 ? 255 : seed & 255; }
  const original = Buffer.from(UPNG.encode([pixels.buffer], 64, 32, 0)); const hash = createHash('sha256').update(original).digest('hex');
  const preview = await host.run<OfficeImagePreview>({ operation: 'preview', bytes: original, maxBytes: 512, memoryBudget: budget }, original.length, new AbortController().signal, () => true);
  expect(preview.bytes.byteLength).toBeLessThanOrEqual(512); expect(preview).toMatchObject({ original_width: 64, original_height: 32, original_sha256: hash, resized: true, reencoded: true });
  const decoded = decodePng(preview.bytes, budget); expect(decoded.width).toBe(preview.width); expect(decoded.height).toBe(preview.height); expect(decoded.sha256).toBe(preview.sha256);
  expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
});
