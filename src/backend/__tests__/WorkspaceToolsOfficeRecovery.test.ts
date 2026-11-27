import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { saveHost, sha } from './attachmentSaveFixtures';
import { presentationInput, presentationRouteRenderer } from './presentationRouteFixtures';
import { documentInput, documentRouteRenderer } from './documentRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { isGovernedWorkspaceTool } from '../requestBoundary';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
async function host(capabilities?: readonly string[]) {
  const h = await saveHost({ capabilities }); const tools = h.tools();
  tools.setPresentationRenderer(await presentationRouteRenderer()); tools.setDocumentRenderer(await documentRouteRenderer());
  const reader = await workbookRouteReader(); tools.setWorkbookReader(reader); tools.beginTurn();
  const result = { ...h, tools, reader }; owned.push(result); return result;
}
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.tools.disposeBackground(); await h.reader.dispose(); await h.assets.dispose(); } await removeTemporaryFolders(); });
async function slideTexts(file: string) {
  const z = await JSZip.loadAsync(await fs.readFile(file));
  return Promise.all(z.file(/^ppt\/slides\/slide\d+\.xml$/).map(p => p.async('string')));
}
it.each([undefined, true, false])('writes complete Word and PPT with no draft and final=%s through normal effect approval', async final => {
  const h = await host(); const boundary = vi.fn(async () => 'proceed' as const); h.tools.setRequestBoundary(boundary);
  const marker = final === undefined ? {} : { final };
  const ppt = { ...presentationInput(), ...marker }; expect(isGovernedWorkspaceTool('write_presentation', ppt)).toBe(true);
  const written = await h.tools.run('write_presentation', ppt); expect(written.status, written.output).toBe('success');
  expect(written.presentationWrite?.receipt?.slides).toBe(1);
  const word = await h.tools.run('write_document', { ...documentInput('docx', 'ONE BODY'), ...marker });
  expect(word.status, word.output).toBe('success');
  const z = await JSZip.loadAsync(await fs.readFile(join(h.root, 'out/result.docx')));
  expect((await z.file('word/document.xml')!.async('string')).match(/ONE BODY/g)).toHaveLength(1);
  expect(boundary).toHaveBeenCalledTimes(2); expect(h.state.approvals.length).toBe(0);
});
it('preserves held slides across independent one-shot requests and then saves every part exactly once', async () => {
  const h = await host(); const make = (text: string) => ({ ...presentationInput(), deck: { slides: [{ objects: [{ type: 'text', text, x: 1, y: 1, w: 5, h: 1 }] }] } });
  expect((await h.tools.run('write_presentation', { ...make('HELD FIRST'), draft: 'held', final: false })).status).toBe('success');
  for (const final of [true, false]) expect((await h.tools.run('write_presentation', { ...make('INDEPENDENT'), path: `independent-${final}.pptx`, final })).status).toBe('success');
  const saved = await h.tools.run('write_presentation', { ...make('HELD LAST'), path: 'held.pptx', draft: 'held', final: true });
  expect(saved.status, saved.output).toBe('success'); const slides = await slideTexts(join(h.root, 'held.pptx'));
  expect(slides).toHaveLength(2); expect(slides.join('')).not.toContain('INDEPENDENT');
  expect(slides.join('').match(/HELD FIRST/g)).toHaveLength(1); expect(slides.join('').match(/HELD LAST/g)).toHaveLength(1);
});
it('keeps Write Off identical for compatible full requests and points malformed draft flags at the fields', async () => {
  const h = await host(['read']);
  for (const tool of ['write_presentation', 'write_document']) {
    const input = tool === 'write_presentation' ? presentationInput() : documentInput('docx');
    const plain = await h.tools.run(tool, input);
    for (const final of [true, false]) expect(await h.tools.run(tool, { ...input, final })).toMatchObject({ status: plain.status, reason: 'capability' });
  }
  expect(await fs.readdir(h.root)).toEqual([]);
  const enabled = await host();
  const invalid = await enabled.tools.run('write_presentation', { ...presentationInput(), final: 'yes' });
  expect(invalid.status).toBe('failed'); expect(invalid.output).toContain('final must be boolean');
  const missing = await enabled.tools.run('write_presentation', { ...presentationInput(), draft: 'not-held', final: true, deck: { slides: [] } });
  expect(missing.output).toContain('No presentation draft is held');
  expect((await enabled.tools.run('write_presentation', presentationInput())).status).toBe('success');
});
it('replays the actual installed three-slide input with a real replacement transformation and exact native chart values', async () => {
  const h = await host(); const fixture = join('src', 'backend', '__tests__', 'fixtures', 'office-recovery');
  const source = await fs.readFile(join(fixture, 'sales.csv')); expect(sha(source)).toBe('a51c92e2b2f3195852144317f90d84ffeb9f51b7232b80c1576e998dcc2096f5');
  await fs.writeFile(join(h.root, 'sales.csv'), source);
  const read = await h.tools.run('read_workbook', { path: 'sales.csv' }); expect(read.status).toBe('success');
  // Replacement plan: original successful transform arguments were not captured, only its returned ref.
  const transformed = await h.tools.run('transform_workbook', { sources: [{ name: 'sales', snapshot_ref: JSON.parse(read.output).snapshot_ref, range: 'A2:B4' }], steps: [
    { id: 'named', input: 'sales', operation: 'select', columns: [{ column: 'A', as: 'Region' }, { column: 'B', as: 'Sales', as_number: true }] },
    { id: 'groups', input: 'named', operation: 'group', by: ['Region'] },
    { id: 'totals', input: 'groups', operation: 'aggregate', fields: [{ field: 'Sales', operation: 'sum', as: 'TotalSales' }] },
  ] });
  expect(transformed.status, transformed.output).toBe('success');
  const input = JSON.parse(await fs.readFile(join(fixture, 'field-deck.json'), 'utf8'));
  expect(input.final).toBe(true); expect(input.draft).toBeUndefined(); expect(input.deck.layout).toBe('standard');
  input.deck.slides[2].objects[1].data_from.transformation_ref = JSON.parse(transformed.output).transformation_ref;
  const result = await h.tools.run('write_presentation', input); expect(result.status, result.output).toBe('success');
  expect(result.presentationWrite?.receipt?.slides).toBe(3);
  const bytes = await fs.readFile(join(h.root, input.path)),z = await JSZip.loadAsync(bytes);
  expect(await slideTexts(join(h.root, input.path))).toHaveLength(3);
  const charts = z.file(/^ppt\/charts\/chart\d+\.xml$/); expect(charts).toHaveLength(1);
  const chart = await charts[0].async('string'); expect(chart).toContain('<c:v>15</c:v>'); expect(chart).toContain('<c:v>20</c:v>');
  expect(chart).toContain('North'); expect(chart).toContain('South'); expect(z.file(/^ppt\/embeddings\/.*\.xlsx$/)).toHaveLength(1);
  expect(await fs.readFile(join(h.root, 'sales.csv'))).toEqual(source);
});
it('returns field-specific Word and edit guidance, then accepts the corrected Word payload', async () => {
  const h = await host(); const input = documentInput('docx');
  const bad = await h.tools.run('write_document', { ...input, document: { ...input.document, blocks: [{ type: 'paragraph', content: 'WRONG STRING' }] } });
  expect(bad.status).toBe('failed'); expect(bad.output).toContain('document.blocks[0].content'); expect(bad.output).toContain('{text:');
  const good = await h.tools.run('write_document', { ...input, document: { ...input.document, blocks: [{ type: 'paragraph', content: [{ text: 'CORRECTED' }] }] } });
  expect(good.status, good.output).toBe('success');
  const inspect = await h.tools.run('inspect_office', { snapshot_ref: 'invented' });
  expect(inspect.status).toBe('failed'); expect(inspect.output).toContain('snapshot_ref is an output');
  const edit = await h.tools.run('edit_office', { schema_version: 1, path: 'out/result.docx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ op: 'invented', target_ref: 'D1' }] });
  expect(edit.status).toBe('failed'); expect(edit.output).toContain('edits[0].op');
});
