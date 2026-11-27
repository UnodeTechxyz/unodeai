import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { SaxesParser } from 'saxes';
import { saveHost, sha } from './attachmentSaveFixtures';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { decodeOfficeXml } from '../../office/OfficeTextPatch';

// The real edit_office route: inventory worker, edit worker, host checks, commit and read-back of the saved file.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function host() {
  const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const workbook = await workbookRouteReader(); const tools = h.tools('dev');
  tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setWorkbookReader(workbook); tools.beginTurn();
  cleanup.push(async () => { tools.retire(); await reader.dispose(); await workbook.dispose(); await h.assets.dispose(); }); return { ...h, tools };
}
type Host = Awaited<ReturnType<typeof host>>;
/** S1: O1 titled bar chart, O2 untitled bar chart, O3 text. sharedChart: O2 shows O1's chart part. sharedSlide: S2 is S1's slide part. */
async function deck(options: { sharedChart?: boolean; sharedSlide?: boolean } = {}) {
  const pptx = new PptxGenJS(); const slide = pptx.addSlide(); const series = [{ name: 'Sales', labels: ['Q1', 'Q2'], values: [3, 4] }];
  slide.addChart(pptx.ChartType.bar, series, { x: 1, y: 1, w: 4, h: 3, showTitle: true, title: 'Old title', titleFontSize: 21, titleColor: 'FF0000' });
  slide.addChart(pptx.ChartType.bar, series, { x: 6, y: 1, w: 4, h: 3 }); slide.addText('Keep text', { x: 1, y: 5, w: 4, h: 1 });
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }) as Buffer);
  if (options.sharedChart) { const xml = await zip.file('ppt/slides/slide1.xml')!.async('string'); const ids = [...xml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]);
    zip.file('ppt/slides/slide1.xml', xml.replace(`r:id="${ids[1]}"`, `r:id="${ids[0]}"`)); }
  if (options.sharedSlide) { const main = await zip.file('ppt/presentation.xml')!.async('string'); const entry = /<p:sldId\b[^>]*\/>/.exec(main)![0];
    zip.file('ppt/presentation.xml', main.replace('</p:sldIdLst>', entry.replace(/ id="[^"]+"/, ' id="257"') + '</p:sldIdLst>')); }
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Host, path = 'source.pptx') {
  const records: any[] = []; let cursor: string | undefined; let snapshot = '';
  do { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); records.push(...page.prepared_fragments); snapshot = page.snapshot_ref; cursor = page.next_cursor; } while (cursor);
  return { records, snapshot, object: (id: string) => records.find(item => item.id === id)?.record };
}
async function run(h: Host, bytes: Buffer, edits: unknown[], name = 'source.pptx', destination = 'edited.pptx') {
  await fs.writeFile(join(h.root, name), bytes); const page = await inspect(h, name);
  return h.tools.run('edit_office', { schema_version: 1, path: destination, snapshot_ref: page.snapshot, edits });
}
async function apply(h: Host, bytes: Buffer, edits: unknown[]) {
  const result = await run(h, bytes, edits); expect(result.status, result.output).toBe('success');
  expect((await fs.readFile(join(h.root, 'source.pptx'))).equals(bytes)).toBe(true);
  return { result, before: await JSZip.loadAsync(bytes), zip: await JSZip.loadAsync(await fs.readFile(join(h.root, 'edited.pptx'))) };
}
const text = async (zip: JSZip, member: string) => decodeOfficeXml(await zip.file(member)!.async('nodebuffer')).xml;
function relationships(xml: string) {
  const found: Array<{ id: string; target: string }> = []; const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => { if (tag.local === 'Relationship') found.push({ id: String(tag.attributes.Id.value), target: String(tag.attributes.Target.value) }); });
  parser.write(xml).close(); return found;
}
/** The chart part an actual slide frame shows (slide = presentation order, ordinal = chart frame order on it). */
async function shownChart(zip: JSZip, slide = 1, ordinal = 0) {
  const main = await text(zip, 'ppt/presentation.xml'); const slideIds = [...main.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]);
  const slidePart = posix.join('ppt', relationships(await text(zip, 'ppt/_rels/presentation.xml.rels')).find(item => item.id === slideIds[slide - 1])!.target);
  const slideXml = await text(zip, slidePart); const ids = [...slideXml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]);
  const rels = await text(zip, posix.join(posix.dirname(slidePart), '_rels', posix.basename(slidePart) + '.rels'));
  const target = relationships(rels).find(item => item.id === ids[ordinal])!.target;
  const part = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(slidePart), target));
  return { part, xml: await text(zip, part), rels: await text(zip, posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')) };
}
const titleOf = (xml: string) => /<c:chart>([\s\S]*?)<c:plotArea>/.exec(xml)![1];
async function unchangedExcept(out: { before: JSZip; zip: JSZip }, changed: string[]) {
  for (const [name, entry] of Object.entries(out.before.files)) if (!entry.dir && !changed.includes(name))
    expect(sha(await out.zip.file(name)!.async('nodebuffer')), name).toBe(sha(await entry.async('nodebuffer')));
}

it('sets the title of an unshared chart in its own part, reusing the old title formatting, and inspect reads it back', async () => {
  const h = await host(); const out = await apply(h, await deck(), [{ op: 'set_chart_title', target_ref: 'S1-O1', title: 'New title & <more>' }]);
  const before = await shownChart(out.before); const after = await shownChart(out.zip);
  expect(after.part).toBe(before.part); expect(after.rels).toBe(before.rels);
  expect(titleOf(after.xml)).toContain('<a:t>New title &amp; &lt;more&gt;</a:t>'); expect(titleOf(after.xml)).not.toContain('Old title');
  expect(titleOf(after.xml)).toMatch(/<a:rPr sz="2100"[^>]*>\s*<a:solidFill><a:srgbClr val="FF0000"\/>/);
  expect(titleOf(after.xml)).toMatch(/<\/c:title><c:autoTitleDeleted val="0"\/>\s*$/);
  expect(after.xml.slice(after.xml.indexOf('<c:plotArea>'))).toBe(before.xml.slice(before.xml.indexOf('<c:plotArea>')));
  await unchangedExcept(out, [before.part]); expect(Object.keys(out.zip.files).sort()).toEqual(Object.keys(out.before.files).sort());
  expect(out.result.output).toContain('Set chart title S1-O1: 1 paragraph'); expect(out.result.output).toContain('the embedded workbook was not copied');
  expect(out.result.output).toContain('Matched text spans: 0;'); expect(h.state.approvals).toEqual([]);
  const readback = await inspect(h, 'edited.pptx');
  expect(readback.object('S1-O1')).toMatchObject({ chart_kind: 'barChart', title: 'New title & <more>', title_source: 'rich' });
  expect(readback.object('S1-O2')).toMatchObject({ chart_kind: 'barChart', title: null, title_source: 'deleted' });
  expect(readback.object('S1-O3')).not.toHaveProperty('chart_kind');
});

it('deletes a title, and a later multi-line title on the same frame edits the same part', async () => {
  const h = await host(); const out = await apply(h, await deck(), [{ op: 'set_chart_title', target_ref: 'S1-O1', title: null },
    { op: 'set_chart_title', target_ref: 'S1-O2', title: 'Line one\r\nLine two' }]);
  const first = await shownChart(out.zip, 1, 0); const second = await shownChart(out.zip, 1, 1);
  expect(first.part).toBe((await shownChart(out.before, 1, 0)).part); expect(titleOf(first.xml)).toBe('<c:autoTitleDeleted val="1"/>');
  expect(titleOf(second.xml)).toContain('<a:t>Line one</a:t></a:r></a:p><a:p><a:r><a:t>Line two</a:t>'); expect(titleOf(second.xml)).toContain('<c:autoTitleDeleted val="0"/>');
  expect(out.result.output).toContain('Deleted chart title S1-O1; automatic title turned off.');
  expect(out.result.output).toContain('Set chart title S1-O2: 2 paragraphs; line endings normalized true.');
  const readback = await inspect(h, 'edited.pptx');
  expect(readback.object('S1-O1')).toMatchObject({ title: null, title_source: 'deleted' }); expect(readback.object('S1-O2')).toMatchObject({ title: 'Line one\nLine two', title_source: 'rich' });
});

it('gives a frame its own chart copy when the chart part is shared, without copying the embedded workbook', async () => {
  const h = await host(); const bytes = await deck({ sharedChart: true }); const before = await JSZip.loadAsync(bytes);
  const original = await shownChart(before, 1, 0); expect((await shownChart(before, 1, 1)).part).toBe(original.part);
  const out = await apply(h, bytes, [{ op: 'set_chart_title', target_ref: 'S1-O2', title: 'Only the second' }]);
  const kept = await shownChart(out.zip, 1, 0); const copied = await shownChart(out.zip, 1, 1);
  expect(kept.part).toBe(original.part); expect(kept.xml).toBe(original.xml); expect(copied.part).not.toBe(original.part);
  expect(posix.dirname(copied.part)).toBe(posix.dirname(original.part)); expect(copied.rels).toBe(original.rels);
  expect(titleOf(copied.xml)).toContain('<a:t>Only the second</a:t>');
  expect(Object.keys(out.zip.files).filter(name => name.endsWith('.xlsx')).sort()).toEqual(Object.keys(before.files).filter(name => name.endsWith('.xlsx')).sort());
  expect(out.result.output).toContain('this frame now uses its own chart copy');
  const readback = await inspect(h, 'edited.pptx');
  expect(readback.object('S1-O1')).toMatchObject({ title: 'Old title' }); expect(readback.object('S1-O2')).toMatchObject({ title: 'Only the second' });
});

it('isolates a slide shared by two slide entries before giving its chart a title', async () => {
  const h = await host(); const out = await apply(h, await deck({ sharedSlide: true }), [{ op: 'set_chart_title', target_ref: 'S2-O1', title: 'Second entry' }]);
  expect(titleOf((await shownChart(out.zip, 1)).xml)).toContain('<a:t>Old title</a:t>'); expect(titleOf((await shownChart(out.zip, 2)).xml)).toContain('<a:t>Second entry</a:t>');
  const readback = await inspect(h, 'edited.pptx');
  expect(readback.object('S1-O1')).toMatchObject({ title: 'Old title' }); expect(readback.object('S2-O1')).toMatchObject({ title: 'Second entry' });
});

it('keeps a title and new chart data together in either order within one request', async () => {
  const h = await host(); const data = { op: 'update_chart_data', target_ref: 'S1-O1', series: [{ name: 'New series', labels: ['A'], values: [9] }] };
  for (const edits of [[{ op: 'set_chart_title', target_ref: 'S1-O1', title: 'Both' }, data], [data, { op: 'set_chart_title', target_ref: 'S1-O1', title: 'Both' }]]) {
    const out = await apply(h, await deck(), edits); const shown = await shownChart(out.zip);
    expect(titleOf(shown.xml)).toContain('<a:t>Both</a:t>'); expect(shown.xml).toContain('<c:v>New series</c:v>'); expect(shown.xml).not.toContain('<c:v>Sales</c:v>');
  }
});

// Audit F1: deleting a title from a compact chart that has no autoTitleDeleted flag, through the real route.
it.each(['', '\n'])('deletes the title of a chart without a flag regardless of whitespace (%j)', async gap => {
  const h = await host(); const zip = await JSZip.loadAsync(await deck()); const part = (await shownChart(zip)).part;
  const xml = await text(zip, part); expect(xml).toContain('<c:chart><c:title>'); expect(xml).toContain('</c:title><c:autoTitleDeleted val="0"/>');
  zip.file(part, xml.replace('<c:autoTitleDeleted val="0"/>', '').replace('<c:chart><c:title>', `<c:chart>${gap}<c:title>`));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const before = await text(await JSZip.loadAsync(bytes), part);
  const out = await apply(h, bytes, [{ op: 'set_chart_title', target_ref: 'S1-O1', title: null }]);
  const after = await shownChart(out.zip); expect(after.part).toBe(part);
  expect(titleOf(after.xml)).toBe(gap + '<c:autoTitleDeleted xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" val="1"/>');
  expect(after.xml.replace(/<c:autoTitleDeleted[^>]*\/>/, '')).toBe(before.replace(/<c:title>[\s\S]*?<\/c:title>/, ''));
  await unchangedExcept(out, [part]);
  expect((await inspect(h, 'edited.pptx')).object('S1-O1')).toMatchObject({ title: null, title_source: 'deleted' });
});

// v0.9.108 S3(c): a package without folder entries gets none from parts the edit adds in new or existing folders.
it('adds no ZIP folder entries the source package did not have', async () => {
  const h = await host(); const plain = new JSZip(); const source = await JSZip.loadAsync(await deck({ sharedChart: true }));
  for (const [name, entry] of Object.entries(source.files)) if (!entry.dir) plain.file(name, await entry.async('nodebuffer'), { createFolders: false });
  const bytes = await plain.generateAsync({ type: 'nodebuffer' }); expect(Object.keys((await JSZip.loadAsync(bytes)).files).filter(name => name.endsWith('/'))).toEqual([]);
  const out = await apply(h, bytes, [{ op: 'set_chart_title', target_ref: 'S1-O2', title: 'Copied' },
    { op: 'update_chart_data', target_ref: 'S1-O1', series: [{ name: 'New', labels: ['A'], values: [1] }] }]);
  expect(Object.keys(out.zip.files).length).toBeGreaterThan(Object.keys(out.before.files).length);
  expect(Object.keys(out.zip.files).filter(name => name.endsWith('/'))).toEqual([]);
});

it('refuses non-chart objects and Word targets with unsupported-edit-target and writes nothing', async () => {
  const h = await host();
  const shape = await run(h, await deck(), [{ op: 'set_chart_title', target_ref: 'S1-O3', title: 'x' }]);
  expect(shape).toMatchObject({ officeEdit: { code: 'unsupported-edit-target', targetEffect: 'none' } }); expect(shape.output).toContain('No destination was written.');
  const word = await run(h, await officeRouteDocument(), [{ op: 'set_chart_title', target_ref: 'D1', title: 'x' }], 'source.docx', 'edited.docx');
  expect(word).toMatchObject({ officeEdit: { code: 'unsupported-edit-target', targetEffect: 'none' } }); expect(word.output).toContain('No destination was written.');
  await expect(fs.stat(join(h.root, 'edited.pptx'))).rejects.toThrow(); await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toThrow();
});
