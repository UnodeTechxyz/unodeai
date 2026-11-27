import * as path from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { expect } from 'vitest';
import { PresentationRenderer } from '../../office/PresentationRenderer';
import { temporaryFolder } from './pathSafetyFixtures';

export const presentationInput = (target = 'out/result.pptx') => ({ schema_version: 1, path: target,
  deck: { title: '报告 & Revenue', slides: [{ notes: 'Presenter notes', objects: [
    { type: 'text', x: 0.5, y: 0.2, w: 10, h: 0.5, text: '季度报告 & Revenue 🌍' },
    { type: 'table', x: 0.5, y: 1, w: 4, h: 2, rows: [['Quarter', 'Revenue'], ['Q1', 12], ['Q2', 34]] },
    { type: 'chart', x: 5, y: 1, w: 6, h: 4, chartType: 'bar', series: [{ name: 'Revenue', labels: ['Q1', 'Q2'], values: [12, 34] }] },
    { type: 'shape', x: 0.5, y: 4, w: 1, h: 1, shape: 'rect', fill: '0000FF' },
  ] }] } });

export const boundPresentationInput = (ref: string) => ({ schema_version: 1, path: 'out/bound.pptx', deck: { slides: [{ objects: [
  { type: 'table', x: 1, y: 1, w: 8, h: 4, data_from: { transformation_ref: ref, fields: ['team', 'total'] } },
  { type: 'chart', chartType: 'bar', x: 1, y: 5, w: 8, h: 2,
    data_from: { transformation_ref: ref, label_field: 'team', value_fields: ['total'] } },
] }] } });
export async function assertBoundPresentation(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml).toContain('<a:t>0.3</a:t>'); expect(xml).toContain('<a:t>9007199254740994</a:t>'); expect(xml).toContain('<a:tbl>');
  expect(xml).toContain('<c:chart');
  const chartPart = Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!;
  expect(await zip.file(chartPart)!.async('string')).toContain('<c:v>0.3</c:v>');
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('9007199254740994');
}

/** Only the affected worker is bundled, never the product/candidate/release build. */
export async function presentationRouteRenderer() {
  const root = await temporaryFolder('unode-ppt-worker-');
  const worker = path.join(root, 'PresentationWorker.cjs');
  const result = await build({ entryPoints: ['src/office/PresentationWorker.ts'], outfile: worker,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true });
  const { assertPresentationWorkerBundleGraph } = await import('../../../scripts/presentation-worker-bundle.mjs');
  assertPresentationWorkerBundleGraph(result.metafile);
  return new PresentationRenderer(worker);
}

export async function assertEditablePresentation(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(slide).toContain('季度报告 &amp; Revenue 🌍');
  expect(slide).toContain('<a:tbl>'); expect(slide).toContain('<c:chart'); expect(slide).toContain('prst="rect"');
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('Presenter notes');
  const chart = await zip.file('ppt/charts/chart1.xml')!.async('string');
  expect(chart).toContain('<c:v>12</c:v>'); expect(chart).toContain('<c:v>34</c:v>');
  const workbook = Object.keys(zip.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'))!;
  const xlsx = await JSZip.loadAsync(await zip.file(workbook)!.async('nodebuffer'));
  const sheet = await xlsx.file('xl/worksheets/sheet1.xml')!.async('string');
  expect(sheet).toContain('<v>12</v>'); expect(sheet).toContain('<v>34</v>');
}
