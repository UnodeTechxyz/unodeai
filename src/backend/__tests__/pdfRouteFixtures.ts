import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { PdfEditor } from '../../office/pdf/PdfEditor';
import { pdfTestFont } from '../../content/document/__tests__/pdfTestFont';
import { temporaryFolder } from './pathSafetyFixtures';

/** The real PDF edit worker bundle, and a test font outside every workspace/writable root as the only font candidate. */
export async function pdfRouteEditor(extraGlyphs = '草稿'): Promise<PdfEditor> {
  // The font broker requires each candidate to equal its real path, and a runner's TEMP can be an 8.3 short name.
  const root = await fs.realpath(await temporaryFolder('unode-pdf-edit-worker-')); const worker = join(root, 'PdfEditWorker.cjs');
  await build({ entryPoints: ['src/office/pdf/PdfEditWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  const font = join(root, 'UnodeTest.ttf'); await fs.writeFile(font, pdfTestFont(false, extraGlyphs));
  return new PdfEditor(worker, () => [{ file: font, family: 'UnodeTest', style: 'regular' }]);
}
