import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { build } from 'esbuild';
import { DocumentRenderer } from '../../content/document/DocumentRenderer';
import { pdfTestFont } from '../../content/document/__tests__/pdfTestFont';
import { temporaryFolder } from './pathSafetyFixtures';

/** A real isolated generation worker, with original synthetic fonts only for hermetic English PDF tests. */
export async function documentRouteRenderer() {
  // The font broker requires each candidate to equal its real path, and a runner's TEMP can be an 8.3 short name.
  const root = await fs.realpath(await temporaryFolder('unode-d3-render-'));
  const worker = path.join(root, 'DocumentRenderWorker.cjs');
  await build({ entryPoints: ['src/content/document/DocumentRenderWorker.ts'], outfile: worker,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  for (const bold of [false, true]) await fs.writeFile(path.join(root, `${bold ? 'bold' : 'regular'}.ttf`), pdfTestFont(bold));
  return new DocumentRenderer(worker, undefined, { forbiddenRoots: () => [],
    candidates: (_language, style) => [{ family: 'UnodeTest', style, file: path.join(root, `${style}.ttf`) }] });
}
export const documentInput = (format: 'docx' | 'pdf', text = 'CONTRACT 123') => ({ schema_version: 1,
  path: `out/result.${format}`, format, template: 'contract-v1', document: { title: 'CONTRACT', language: 'en', blocks: [
    { type: 'heading', level: 1, content: [{ text: 'TERMS' }] }, { type: 'paragraph', content: [{ text }] },
  ] } });
