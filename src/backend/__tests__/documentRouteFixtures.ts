import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { build } from 'esbuild';
import { DocumentRenderer } from '../../content/document/DocumentRenderer';
import { pdfTestFont } from '../../content/document/__tests__/pdfTestFont';
import { temporaryFolder } from './pathSafetyFixtures';
import JSZip from 'jszip';
import { expect } from 'vitest';

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
export const boundDocumentInput = (ref: string) => ({ schema_version: 1, path: 'out/bound.docx', format: 'docx', template: 'report-v1',
  document: { title: 'Source totals', language: 'en', blocks: [{ type: 'table', headers: ['TEAM', 'TOTAL'], rows: [['wrong', '999']] }] },
  source_bindings: [{ block_index: 0, target: { row: 1, column: 1 }, data_from: { transformation_ref: ref, fields: ['team', 'total'] } }] });
export async function assertBoundDocument(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('>0.3</w:t>'); expect(xml).toContain('>9007199254740994</w:t>'); expect(xml).not.toContain('>999</w:t>');
}
