import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { saveHost } from './attachmentSaveFixtures';
import { readOfficeShapeText } from '../../office/OfficeShapeText';
import { PRESENTATION_PNG } from './presentationImageFixtures';

const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function host() {
  const root = await temporaryFolder('unode-slide-copy-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.beginTurn();
  const h = { root, reader, editor, tools }; owned.push(h); return h;
}
async function collect(h: Awaited<ReturnType<typeof host>>, path: string) {
  const records: any[] = []; let cursor: string | undefined; let snapshot = '';
  for (let count = 0; ; count++) {
    expect(count).toBeLessThan(100); const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) });
    expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); snapshot = page.snapshot_ref;
    records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot }; cursor = page.next_cursor;
  }
}
async function source(sameRelationship = false) {
  const deck = new PptxGenJS(); const slide = deck.addSlide(); slide.addText('Shared title', { x: 1, y: 1, w: 5, h: 1, bold: true }); slide.addNotes('Actual shared notes.');
  slide.addChart(deck.ChartType.bar, [{ name: 'Series', labels: ['Q1'], values: [12] }], { x: 1, y: 2, w: 5, h: 3 });
  deck.addSlide().addText('Unreferenced source slide', { x: 1, y: 1, w: 5, h: 1 });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer); zip.file('custom/keep.bin', Buffer.from([0, 255, 2, 7]));
  const main = await zip.file('ppt/presentation.xml')!.async('string'); const ids = [...main.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]); expect(ids).toHaveLength(2);
  if (sameRelationship) {
    zip.file('ppt/presentation.xml', main.replace(`r:id="${ids[1]}"`, () => `xmlns:q="urn:fixture" q:keep='literal &gt; $&amp;' r:id='${ids[0]}'`));
    for (const name of ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', '[Content_Types].xml']) {
      const xml = (await zip.file(name)!.async('string')).replace(/encoding="UTF-8"/i, 'encoding="UTF-16"')
        .replaceAll('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"', 'Type="http://purl.oclc.org/ooxml/officeDocument/relationships/slide"');
      zip.file(name, Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]));
    }
  } else {
    const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
    zip.file('ppt/_rels/presentation.xml.rels', rels.replace(/(<Relationship\b[^>]*\bId="[^"]+"[^>]*\bTarget=")slides\/slide2\.xml("[^>]*\/>)/, '$1slides/slide1.xml$2'));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
const textEdit = (ref: string, find: string, replace: string) => ({ op: 'replace_text', target_ref: ref, find, replace });
async function preserved(before: Buffer, after: Buffer, allowed: string[]) {
  const old = await JSZip.loadAsync(before); const output = await JSZip.loadAsync(after);
  for (const [name, entry] of Object.entries(old.files)) if (!entry.dir && !allowed.includes(name)) expect(hash(await output.file(name)!.async('nodebuffer')), name).toBe(hash(await entry.async('nodebuffer')));
  return { output, added: Object.keys(output.files).filter(name => !output.files[name].dir && !old.files[name]) };
}

it.each([false, true])('isolates the requested shared slide and its notes with same relationship=%s', async same => {
  const h = await host(); const bytes = await source(same); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const beforeSlides = initial.records.filter(record => record.kind === 'slide'); expect(beforeSlides[0].record.part_ref).toBe(beforeSlides[1].record.part_ref);
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [textEdit('S2-O1', 'Shared title', 'Isolated title')] });
  expect(saved.status, saved.output).toBe('success');
  const readback = await collect(h, 'copy.pptx'); const titles = readback.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp');
  expect(titles.map(record => [record.id, record.record.text])).toEqual([['S1-O1', 'Shared title'], ['S2-O1', 'Isolated title']]);
  expect(saved.output).toContain('Added parts: 4');
  const slides = readback.records.filter(record => record.kind === 'slide'); expect(slides[0].record.part_ref).not.toBe(slides[1].record.part_ref);
  const noteRef = (slide: any) => readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === slide.record.part_ref && record.record.relationship_kind === 'notesSlide').record.target_part;
  const firstNotes = noteRef(slides[0]); const secondNotes = noteRef(slides[1]); expect(firstNotes).not.toBe(secondNotes);
  expect(readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === secondNotes && record.record.relationship_kind === 'slide').record.target_part).toBe(slides[1].record.part_ref);
  const output = await fs.readFile(join(h.root, 'copy.pptx')); const checked = await preserved(bytes, output, ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels', ...(same ? ['ppt/presentation.xml'] : [])]);
  expect(checked.added).toHaveLength(4); expect(await fs.readFile(join(h.root, 'source.pptx'))).toEqual(bytes);
  if (same) {
    const main = await checked.output.file('ppt/presentation.xml')!.async('nodebuffer'); expect([...main.subarray(0, 2)]).toEqual([255, 254]); expect(main.toString('utf16le')).toContain("q:keep='literal &gt; $&amp;'");
    const newId = /r:id='(rId_[^']+)'/.exec(main.toString('utf16le'))![1];
    expect((await checked.output.file('ppt/_rels/presentation.xml.rels')!.async('nodebuffer')).toString('utf16le')).toContain(`Id="${newId}" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/slide"`);
    for (const name of ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels']) expect([...(await checked.output.file(name)!.async('nodebuffer')).subarray(0, 2)]).toEqual([255, 254]);
  }
});

it('does not fork shared slides for a byte-identical text edit', async () => {
  const h = await host(); const bytes = await source(); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'same.pptx', edits: [textEdit('S2-O1', 'Shared title', 'Shared title')] });
  expect(saved.status, saved.output).toBe('success'); expect((await fs.readFile(join(h.root, 'same.pptx'))).equals(bytes)).toBe(true); expect(saved.output).toContain('Added parts: 0');
});

it('converts a shared-slide template copy while preserving original source and chart parts', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source());
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('presentationml.presentation.main+xml', 'presentationml.template.main+xml'));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.potx'), bytes); const initial = await collect(h, 'source.potx');
  const result = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [textEdit('S2-O1', 'Shared title', 'Template copy')] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('regular');
  const output = await fs.readFile(join(h.root, 'copy.pptx')); const checked = await preserved(bytes, output, ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels']);
  expect(await checked.output.file('[Content_Types].xml')!.async('string')).not.toContain('presentationml.template.main+xml');
  expect(await fs.readFile(join(h.root, 'source.potx'))).toEqual(bytes);
});

it('withholds a valid forked package when worker added-part bookkeeping is inconsistent', async () => {
  const h = await host(); const bytes = await source(); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); return { ...result, addedParts: result.addedParts + 1 }; });
  const result = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [textEdit('S2-O1', 'Shared title', 'Isolated title')] });
  expect(result).toMatchObject({ status: 'failed', officeEdit: { code: 'office-output-check-failed' } }); await expect(fs.stat(join(h.root, 'copy.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('routes sequential edits to each current logical slide and forks only once', async () => {
  const h = await host(); const bytes = await source(); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'both.pptx', edits: [
    textEdit('S2-O1', 'Shared title', 'First'), textEdit('S2-O1', 'First', 'Final second'), textEdit('S1-O1', 'Shared title', 'Changed first'),
  ] });
  expect(saved.status, saved.output).toBe('success'); expect(saved.output).toContain('Added parts: 4');
  const result = await collect(h, 'both.pptx'); expect(result.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text)).toEqual(['Changed first', 'Final second']);
  await preserved(bytes, await fs.readFile(join(h.root, 'both.pptx')), ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide1.xml']);
});

it.each([false, true])('duplicates owned chart, workbook and notes without sharing editable parts, same-rId=%s', async same => {
  const h = await host(); const bytes = await source(same); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S1' }] });
  expect(saved.status, saved.output).toBe('success'); expect(saved.output).toContain('slide count 2 to 3'); expect(saved.output).toContain('Matched text spans: 0');
  const readback = await collect(h, 'copy.pptx'); const slides = readback.records.filter(record => record.kind === 'slide'); expect(slides).toHaveLength(3);
  expect(new Set(slides.map(slide => slide.record.slide_id)).size).toBe(3); expect(slides[0].record.part_ref).not.toBe(slides[1].record.part_ref);
  expect(slides[0].record.part_ref).toBe(slides[2].record.part_ref);
  const relation = (owner: string, kind: string) => readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === owner && record.record.relationship_kind === kind)?.record.target_part;
  const first = slides[0].record.part_ref; const second = slides[1].record.part_ref;
  const chart1 = relation(first, 'chart'); const chart2 = relation(second, 'chart'); expect(chart1).toBeTruthy(); expect(chart2).toBeTruthy(); expect(chart1).not.toBe(chart2);
  expect(relation(chart1, 'package')).not.toBe(relation(chart2, 'package'));
  const notes = relation(second, 'notesSlide'); expect(notes).not.toBe(relation(first, 'notesSlide')); expect(relation(notes, 'slide')).toBe(second);
  expect(relation(first, 'slideLayout')).toBe(relation(second, 'slideLayout'));
  const output = await fs.readFile(join(h.root, 'copy.pptx')); const checked = await preserved(bytes, output, ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/app.xml']);
  expect(await checked.output.file('docProps/app.xml')!.async('string')).toContain('<Slides>3</Slides>'); expect(await fs.readFile(join(h.root, 'source.pptx'))).toEqual(bytes);
  if (same) expect([...(await checked.output.file('ppt/presentation.xml')!.async('nodebuffer')).subarray(0, 2)]).toEqual([255, 254]);
});

it('copies current edits and keeps original selectors stable after inserting first and after another slide', async () => {
  const h = await host(); const bytes = await source(true); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [
    textEdit('S2-O1', 'Shared title', 'Second current'), { op: 'duplicate_slide', target_ref: 'S2', after_ref: null },
    textEdit('S2-O1', 'Second current', 'Second later'), { op: 'duplicate_slide', target_ref: 'S1', after_ref: 'S2' },
    textEdit('S1-O1', 'Shared title', 'First later'),
  ] });
  expect(saved.status, saved.output).toBe('success'); const result = await collect(h, 'copy.pptx');
  expect(result.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text)).toEqual(['Second current', 'First later', 'Second later', 'Shared title']);
});

it.each(['S999', 'S1-O1'])('leaves the existing destination intact for unavailable or invalid duplicate anchor %s', async after_ref => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const initial = await collect(h, 'source.pptx');
  await fs.writeFile(join(h.root, 'copy.pptx'), 'existing');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S1', after_ref }] });
  expect(saved.status).toBe('failed'); expect(await fs.readFile(join(h.root, 'copy.pptx'), 'utf8')).toBe('existing');
});

it('rejects inconsistent duplicate count facts before saving', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const initial = await collect(h, 'source.pptx');
  const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); result.slides![0].after++; return result; });
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S1' }] });
  expect(saved.officeEdit?.code).toBe('office-output-check-failed'); await expect(fs.stat(join(h.root, 'copy.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains opaque owned dependency bytes, cycles, external links and relationship suffixes in a duplicate', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source()); const payload = Buffer.from([0, 255, 8, 2]);
  zip.file('custom/keep.bin', payload); zip.file('custom/_rels/keep.bin.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="back" Type="urn:fixture:back" Target="../ppt/slides/slide1.xml"/></Relationships>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', (await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="opaque" Type="urn:fixture:opaque" Target="../../custom/keep.bin?view=1#anchor"/><Relationship Id="web" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/untouched" TargetMode="External"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/custom/keep.bin" ContentType="application/x-fixture"/></Types>'));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S1' }] });
  expect(saved.status, saved.output).toBe('success'); const output = await JSZip.loadAsync(await fs.readFile(join(h.root, 'copy.pptx')));
  const owned = Object.keys(output.files).filter(name => /^custom\/unode-.*\.bin$/.test(name)); expect(owned).toHaveLength(1); expect(await output.file(owned[0])!.async('nodebuffer')).toEqual(payload);
  const newSlide = Object.keys(output.files).find(name => /^ppt\/slides\/unode-.*\.xml$/.test(name))!;
  const rels = await output.file(newSlide.replace('/slides/', '/slides/_rels/') + '.rels')!.async('string');
  expect(rels).toContain('?view=1#anchor'); expect(rels).toContain('https://example.invalid/untouched'); expect(rels).toContain('TargetMode="External"');
  const backlink = await output.file(owned[0].replace('custom/', 'custom/_rels/') + '.rels')!.async('string'); expect(backlink).toContain(newSlide.slice('ppt/slides/'.length));
  await preserved(bytes, await fs.readFile(join(h.root, 'copy.pptx')), ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/app.xml']);
});

it('duplicates a UTF-16 template with strict primary entries while keeping original lexical attributes', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source(true));
  const main = (await zip.file('ppt/presentation.xml')!.async('nodebuffer')).subarray(2).toString('utf16le')
    .replaceAll('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main')
    .replace(/<p:sldId\b[^>]*\/>/g, entry => entry.slice(0, -2) + '></p:sldId>');
  zip.file('ppt/presentation.xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(main, 'utf16le')]));
  const types = (await zip.file('[Content_Types].xml')!.async('nodebuffer')).subarray(2).toString('utf16le').replace('presentationml.presentation.main+xml', 'presentationml.template.main+xml');
  zip.file('[Content_Types].xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(types, 'utf16le')]));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.potx'), bytes); const initial = await collect(h, 'source.potx');
  const result = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S2', after_ref: null }] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('regular'); const readback = await collect(h, 'copy.pptx');
  expect(readback.records.filter(record => record.kind === 'slide')).toHaveLength(3);
  const output = await preserved(bytes, await fs.readFile(join(h.root, 'copy.pptx')), ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/app.xml']);
  const xml = (await output.output.file('ppt/presentation.xml')!.async('nodebuffer')).subarray(2).toString('utf16le');
  expect(xml.match(/q:keep='literal &gt; \$&amp;'/g)).toHaveLength(2); expect(xml).toContain('http://purl.oclc.org/ooxml/presentationml/main');
});

it.each(['read', 'write'])('withholds a completed slide duplicate after %s is turned Off', async permission => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const initial = await collect(h, 'source.pptx');
  await fs.writeFile(join(h.root, 'copy.pptx'), 'existing');
  const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); h.tools.setAllowedTools(new Set([permission === 'read' ? 'write' : 'read'])); return result; });
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [{ op: 'duplicate_slide', target_ref: 'S1' }] });
  expect(saved.status).not.toBe('success'); expect(await fs.readFile(join(h.root, 'copy.pptx'), 'utf8')).toBe('existing');
});

async function distinctSource(sharedChart = false) {
  const deck = new PptxGenJS(); const first = deck.addSlide(); first.addText('Remove first', { x: 1, y: 1, w: 4, h: 1 }); first.addNotes('First private notes');
  first.addChart(deck.ChartType.bar, [{ name: 'Original', labels: ['Q1'], values: [12] }], { x: 1, y: 2, w: 4, h: 3 });
  const second = deck.addSlide(); second.addText('Keep second', { x: 1, y: 1, w: 4, h: 1 }); second.addNotes('Second notes');
  if (sharedChart) second.addChart(deck.ChartType.bar, [{ name: 'Unused own chart', labels: ['Q2'], values: [7] }], { x: 1, y: 2, w: 4, h: 3 });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  if (sharedChart) {
    const first = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string'); const second = await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string');
    const target = /Type="[^"]+\/chart" Target="([^"]+)"/.exec(first)![1];
    zip.file('ppt/slides/_rels/slide2.xml.rels', second.replace(/(Type="[^"]+\/chart" Target=")[^"]+"/, '$1' + target + '"'));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
const removeSlide = (target_ref: string) => ({ op: 'remove_slide', target_ref });
async function removeFlow(h: Awaited<ReturnType<typeof host>>, bytes: Buffer, edits: any[]) {
  await fs.writeFile(join(h.root, 'source.pptx'), bytes); const initial = await collect(h, 'source.pptx');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits });
  expect(saved.status, saved.output).toBe('success'); expect(await fs.readFile(join(h.root, 'source.pptx'))).toEqual(bytes);
  return { saved, output: await JSZip.loadAsync(await fs.readFile(join(h.root, 'copy.pptx'))), readback: await collect(h, 'copy.pptx') };
}
it('removes a requested slide, exclusive chart/workbook and notes, and edits the remaining original selector', async () => {
  const h = await host(); const bytes = await distinctSource(); const out = await removeFlow(h, bytes, [removeSlide('S1'), textEdit('S2-O1', 'Keep second', 'Kept current')]);
  expect(out.readback.records.filter(record => record.kind === 'slide')).toHaveLength(1);
  expect(out.readback.records.filter(record => record.kind === 'object').map(record => record.record.text)).toEqual(['Kept current']);
  expect(out.output.file('ppt/slides/slide1.xml')).toBeNull(); expect(out.output.file('ppt/notesSlides/notesSlide1.xml')).toBeNull();
  expect(Object.keys(out.output.files).filter(name => /^ppt\/(?:charts|embeddings)\/[^/]+\.(?:xml|xlsx)$/.test(name))).toHaveLength(0);
  expect(out.saved.output).toContain('Removed exclusive original parts: 7'); expect(out.saved.output).toContain('Matched text spans: 1');
  expect(await out.output.file('docProps/app.xml')!.async('string')).toContain('<Slides>1</Slides>');
  const old = await JSZip.loadAsync(bytes);
  for (const [name, entry] of Object.entries(old.files)) if (!entry.dir && out.output.file(name) && !['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', '[Content_Types].xml', 'docProps/app.xml', 'ppt/slides/slide2.xml'].includes(name)) expect(await out.output.file(name)!.async('nodebuffer'), name).toEqual(await entry.async('nodebuffer'));
});
it('refreshes cached title lists and removes the first-page thumbnail after removing that page', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await distinctSource());
  const app = (await zip.file('docProps/app.xml')!.async('string')).replace('>Slide 1<', '>SECRET FIRST TITLE<').replace('>Slide 2<', '>KEEP SECOND TITLE<');
  expect(app).toContain('SECRET FIRST TITLE'); zip.file('docProps/app.xml', app);
  zip.file('docProps/thumbnail.png', PRESENTATION_PNG);
  zip.file('_rels/.rels', (await zip.file('_rels/.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="thumbnail" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/docProps/thumbnail.png" ContentType="image/png"/></Types>'));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const removed = await removeFlow(h, bytes, [removeSlide('S1')]);
  const after = await removed.output.file('docProps/app.xml')!.async('string'); expect(after).not.toContain('SECRET FIRST TITLE'); expect(after).toContain('KEEP SECOND TITLE');
  expect(after).toContain('<Slides>1</Slides>'); expect(removed.output.file('docProps/thumbnail.png')).toBeNull();
  expect(await removed.output.file('_rels/.rels')!.async('string')).not.toContain('metadata/thumbnail');
  const edited = await removeFlow(h, bytes, [textEdit('S1-O1', 'Remove first', 'Revised first')]);
  expect(edited.output.file('docProps/thumbnail.png')).toBeNull();
  const later = await removeFlow(h, bytes, [textEdit('S2-O1', 'Keep second', 'Revised second')]);
  expect(await later.output.file('docProps/thumbnail.png')!.async('nodebuffer')).toEqual(PRESENTATION_PNG);
  const inspected = await collect(h, 'source.pptx'); const theme = inspected.records.find(record => record.kind === 'part' && record.record.content_type?.endsWith('officedocument.theme+xml'))!.id;
  const themed = await removeFlow(h, bytes, [{ op: 'set_theme_tokens', target_ref: theme, colors: { accent1: '123ABC' } }]);
  expect(themed.output.file('docProps/thumbnail.png')).toBeNull();
  zip.file('docProps/app.xml', app.replace('>Slide Titles<', '>Unknown localized heading<'));
  const unknown = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1')]);
  const unknownApp = await unknown.output.file('docProps/app.xml')!.async('string');
  expect(unknownApp).not.toContain('SECRET FIRST TITLE'); expect(unknownApp).not.toContain('TitlesOfParts'); expect(unknownApp).toContain('<Slides>1</Slides>');
  zip.file('docProps/app.xml', app);
  zip.file('ppt/slides/_rels/slide2.xml.rels', (await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).replace('</Relationships>',
    '<Relationship Id="sharedThumbnailImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../docProps/thumbnail.png"/></Relationships>'));
  const shared = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1')]);
  expect(await shared.output.file('docProps/thumbnail.png')!.async('nodebuffer')).toEqual(PRESENTATION_PNG);
  expect(await shared.output.file('_rels/.rels')!.async('string')).not.toContain('metadata/thumbnail');
});
it.each([false, true])('retains a shared slide dependency and notes after removing one logical alias same-rId=%s', async same => {
  const h = await host(); const out = await removeFlow(h, await source(same), [removeSlide('S1'), textEdit('S2-O1', 'Shared title', 'Only remaining')]);
  expect(out.output.file('ppt/slides/slide1.xml')).not.toBeNull(); expect(out.output.file('ppt/notesSlides/notesSlide1.xml')).not.toBeNull();
  expect(out.readback.records.filter(record => record.kind === 'slide')).toHaveLength(1); expect(out.saved.output).toContain('Removed exclusive original parts: 0');
  expect(out.readback.records.find(record => record.kind === 'object' && record.record.object_kind === 'sp')?.record.text).toBe('Only remaining');
});
it('retains an actual chart and editable workbook still referenced from another slide', async () => {
  const h = await host(); const out = await removeFlow(h, await distinctSource(true), [removeSlide('S1')]);
  const chartObject = out.readback.records.find(record => record.kind === 'object' && record.record.object_kind === 'graphicFrame'); expect(chartObject).toBeTruthy();
  expect(out.saved.output).toContain('Removed exclusive original parts: 4');
  const id = chartObject!.record.chart_relationships[0]; const chart = out.readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === chartObject!.record.part_ref && record.record.relationship_id === id)?.record.target_part;
  expect(chart).toBeTruthy(); expect(out.readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === chart && record.record.relationship_kind === 'package')?.record.target_part).toBeTruthy();
});
it('can duplicate current content, remove both original pages, and leave only the independent new page', async () => {
  const h = await host(); const out = await removeFlow(h, await distinctSource(), [textEdit('S1-O1', 'Remove first', 'Duplicate stays'), { op: 'duplicate_slide', target_ref: 'S1' }, removeSlide('S1'), removeSlide('S2')]);
  expect(out.readback.records.filter(record => record.kind === 'slide')).toHaveLength(1); expect(out.readback.records.find(record => record.kind === 'object' && record.record.object_kind === 'sp')?.record.text).toBe('Duplicate stays');
  expect(out.output.file('ppt/slides/slide1.xml')).toBeNull(); expect(out.output.file('ppt/slides/slide2.xml')).toBeNull();
});
it('can remove every slide without silently retaining a page or rejecting an empty deck', async () => {
  const h = await host(); const out = await removeFlow(h, await distinctSource(), [removeSlide('S1'), removeSlide('S2')]);
  expect(out.readback.records.filter(record => record.kind === 'slide')).toHaveLength(0); expect(await out.output.file('ppt/presentation.xml')!.async('string')).not.toContain('p:sldIdLst');
});
it('withholds all edits if an original selector is used after its slide has been removed', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await distinctSource()); const initial = await collect(h, 'source.pptx'); await fs.writeFile(join(h.root, 'copy.pptx'), 'existing');
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [removeSlide('S1'), textEdit('S1-O1', 'Remove first', 'Wrong')] });
  expect(saved.status).toBe('failed'); expect(await fs.readFile(join(h.root, 'copy.pptx'), 'utf8')).toBe('existing');
});

it.each(['hlinkClick', 'hlinkHover'])('cleans actual custom-show, section and %s references to a retired page while keeping other pages', async linkTag => {
  const h = await host(); const zip = await JSZip.loadAsync(await distinctSource()); const main = await zip.file('ppt/presentation.xml')!.async('string');
  const entries = [...main.matchAll(/<p:sldId\b[^>]*\bid="([^"]+)"[^>]*\br:id="([^"]+)"/g)]; expect(entries).toHaveLength(2);
  const shows = `<p:custShowLst><p:custShow name="Removed show" id="1"><p:sldLst><p:sld r:id="${entries[0][2]}"/></p:sldLst></p:custShow><p:custShow name="Keep show" id="2"><p:sldLst><p:sld r:id="${entries[1][2]}"/></p:sldLst></p:custShow></p:custShowLst>`;
  const sections = `<p:extLst><p:ext uri="fixture"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Remove section" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst><p14:sldId id="${entries[0][1]}"/></p14:sldIdLst></p14:section><p14:section name="Keep section" id="{22222222-2222-2222-2222-222222222222}"><p14:sldIdLst><p14:sldId id="${entries[1][1]}"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>`;
  zip.file('ppt/presentation.xml', main.replace('<p:defaultTextStyle>', shows + '<p:defaultTextStyle>').replace('</p:presentation>', sections + '</p:presentation>'));
  const slide = await zip.file('ppt/slides/slide2.xml')!.async('string');
  zip.file('ppt/slides/slide2.xml', slide.replace(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/, run => run.endsWith('/>') ? run.slice(0, -2) + `><a:${linkTag} r:id="retiredPage" action="ppaction://hlinksldjump"/></a:rPr>` : run.replace('</a:rPr>', `<a:${linkTag} r:id="retiredPage" action="ppaction://hlinksldjump"/></a:rPr>`)));
  expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('retiredPage');
  zip.file('ppt/slides/_rels/slide2.xml.rels', (await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="retiredPage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide1.xml"/></Relationships>'));
  const out = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1')]); const xml = await out.output.file('ppt/presentation.xml')!.async('string');
  expect(xml).not.toContain('Removed show'); expect(xml).not.toContain('Remove section'); expect(xml).toContain('Keep show'); expect(xml).toContain('Keep section');
  expect(await out.output.file('ppt/slides/slide2.xml')!.async('string')).not.toContain('retiredPage'); expect(await out.output.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).not.toContain('retiredPage');
  expect(out.output.file('ppt/slides/slide1.xml')).toBeNull(); expect(out.saved.output).toContain('auxiliary references cleaned 2');
  const all = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1'), removeSlide('S2')]);
  const empty = await all.output.file('ppt/presentation.xml')!.async('string'); expect(empty).not.toContain('<p:ext'); expect(empty).not.toContain('sectionLst');
});
it('preserves custom-show relationships still naming a remaining alias of the same slide', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source(true)); const original = await zip.file('ppt/presentation.xml')!.async('nodebuffer');
  const main = original.subarray(2).toString('utf16le'); const rid = /<p:sldId\b[^>]*\br:id="([^"]+)"/.exec(main)![1];
  const shows = `<p:custShowLst><p:custShow name="Remaining alias show" id="1"><p:sldLst><p:sld r:id="${rid}"/></p:sldLst></p:custShow></p:custShowLst>`;
  zip.file('ppt/presentation.xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(main.replace('<p:defaultTextStyle>', shows + '<p:defaultTextStyle>'), 'utf16le')]));
  const out = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1')]);
  expect((await out.output.file('ppt/presentation.xml')!.async('nodebuffer')).subarray(2).toString('utf16le')).toContain('Remaining alias show');
});
it.each(['bad-count', 'bad-removed-parts', 'read-Off', 'write-Off'])('withholds a removal with %s after actual worker completion', async issue => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await distinctSource()); const initial = await collect(h, 'source.pptx'); await fs.writeFile(join(h.root, 'copy.pptx'), 'existing');
  const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
    const result = await real(...args);
    if (issue === 'bad-count') result.removedSlides![0].after++;
    else if (issue === 'bad-removed-parts') result.removedParts!.push(result.removedParts![0]);
    else h.tools.setAllowedTools(new Set([issue === 'read-Off' ? 'write' : 'read']));
    return result;
  });
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [removeSlide('S1')] });
  expect(saved.status).not.toBe('success'); expect(await fs.readFile(join(h.root, 'copy.pptx'), 'utf8')).toBe('existing');
  if (issue.startsWith('bad-')) expect(saved.officeEdit?.code).toBe('office-output-check-failed');
});
it('removes a transient copy-on-write page without deleting its independent duplicate or original alias', async () => {
  const h = await host(); const out = await removeFlow(h, await source(true), [textEdit('S2-O1', 'Shared title', 'Transient current'), { op: 'duplicate_slide', target_ref: 'S2' }, removeSlide('S2')]);
  expect(out.readback.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text)).toEqual(['Shared title', 'Transient current']);
  expect(out.saved.output).toContain('Removed exclusive original parts: 0');
  const slides = Object.keys(out.output.files).filter(name => /^ppt\/slides\/[^/]+\.xml$/.test(name));
  expect(slides.filter(name => name.includes('unode-'))).toHaveLength(1);
});
it('keeps a retained opaque package reference truthful rather than deleting bytes it still uses', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await distinctSource());
  zip.file('ppt/slides/_rels/slide2.xml.rels', (await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="opaque" Type="urn:fixture:owned-reference" Target="slide1.xml"/></Relationships>'));
  const out = await removeFlow(h, await zip.generateAsync({ type: 'nodebuffer' }), [removeSlide('S1')]);
  expect(out.readback.records.filter(record => record.kind === 'slide')).toHaveLength(1); expect(out.output.file('ppt/slides/slide1.xml')).not.toBeNull();
  expect(out.saved.output).toContain('Owned parts retained for remaining package references: 7');
});
it('preserves exact original presentation bytes in a real restore point for in-place page removal', async () => {
  const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = h.tools();
  tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.beginTurn(); const bytes = await distinctSource(); await fs.writeFile(join(h.root, 'source.pptx'), bytes);
  try {
    const inspected = await tools.run('inspect_office', { path: 'source.pptx' }); expect(inspected.status, inspected.output).toBe('success');
    const saved = await tools.run('edit_office', { schema_version: 1, snapshot_ref: JSON.parse(inspected.output).snapshot_ref, path: 'source.pptx', edits: [removeSlide('S1')] });
    expect(saved.status, saved.output).toBe('success'); const store = await h.rawStore(); const [point] = store.list(); expect(point).toBeDefined();
    expect(await store.readBefore(point.id)).toEqual({ status: 'read', bytes }); expect(saved.officeEdit?.receipt?.restorePointId).toBe(point.id);
    const output = await JSZip.loadAsync(await fs.readFile(join(h.root, 'source.pptx'))); expect(output.file('ppt/slides/slide1.xml')).toBeNull();
  } finally { tools.retire(); await reader.dispose(); await h.assets.dispose(); }
});
it('never reuses a retired numeric slide id during remove-then-duplicate in the same request', async () => {
  const h = await host(); const bytes = await distinctSource(); const old = await JSZip.loadAsync(bytes); const original = [...(await old.file('ppt/presentation.xml')!.async('string')).matchAll(/<p:sldId\b[^>]*\sid="(\d+)"/g)].map(match => match[1]);
  const out = await removeFlow(h, bytes, [removeSlide('S1'), { op: 'duplicate_slide', target_ref: 'S2' }]);
  const actual = out.readback.records.filter(record => record.kind === 'slide').map(record => record.record.slide_id);
  expect(actual).toHaveLength(2); expect(actual[0]).toBe(original[1]); expect(actual[1]).not.toBe(original[0]); expect(actual[1]).not.toBe(original[1]);
});

const setText = (target_ref: string, text: string) => ({ op: 'set_shape_text', target_ref, text });
it.each([false, true])('sets whole text only on the selected current logical slide with same-rId=%s', async same => {
  const h = await host(); const bytes = await source(same); const text = 'New <&> title\r\n第二段\tvalue\n'; const out = await removeFlow(h, bytes, [setText('S2-O1', text)]);
  const objects = out.readback.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp'); expect(objects[0].record.text).toBe('Shared title'); expect(objects[1].record.text).toContain('第二段');
  const added = Object.keys(out.output.files).filter(name => /^ppt\/slides\/unode-.*\.xml$/.test(name)); expect(added).toHaveLength(1);
  const xml = await out.output.file(added[0])!.async('nodebuffer'); expect(readOfficeShapeText(xml, 'S2-O1', () => {}).text).toBe(text.replace(/\r\n?/g, '\n')); expect(xml.toString()).toContain('b="1"');
  expect(out.saved.output).toContain('Matched text spans: 0'); expect(out.saved.output).toContain('3 paragraphs; line endings normalized true');
  await preserved(bytes, await fs.readFile(join(h.root, 'copy.pptx')), ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
});
it('keeps an exact whole-text no-op byte-identical without flattening original run formatting or forking', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source(true)); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace(/<a:r\b[\s\S]*?<\/a:r>/, run => run.replace('Shared title', 'Shared') + run.replace('Shared title', ' title').replace('b="1"', 'i="1"')));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const out = await removeFlow(h, bytes, [setText('S2-O1', 'Shared title')]);
  expect((await fs.readFile(join(h.root, 'copy.pptx'))).equals(bytes)).toBe(true); expect(out.saved.output).toContain('Added parts: 0');
});
it.each(['empty', 'missing-body', 'field-style', 'field-noop', 'end-style', 'hyperlink', 'alternate', 'utf16-strict'])('assigns literal shape text with %s while preserving source and unrelated content', async mode => {
  const h = await host(); const zip = await JSZip.loadAsync(await source()); let xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  if (mode === 'missing-body') xml = xml.replace(/<p:txBody\b[\s\S]*?<\/p:txBody>/, '');
  if (mode === 'field-style' || mode === 'field-noop') xml = xml.replace(/<p:txBody\b[\s\S]*?<\/p:txBody>/, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{11111111-1111-1111-1111-111111111111}" type="datetime" xmlns:q="http://schemas.openxmlformats.org/drawingml/2006/main"><q:rPr sz="2800" b="1"/><a:t>Old date</a:t></a:fld></a:p></p:txBody>');
  if (mode === 'end-style') xml = xml.replace(/<p:txBody\b[\s\S]*?<\/p:txBody>/, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr sz="2400" b="1"/></a:p></p:txBody>');
  if (mode === 'alternate') xml = xml.replace(/<p:txBody\b[\s\S]*?<\/p:txBody>/, '<p:txBody><a:bodyPr/><a:lstStyle/><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p"><a:p><a:r><a:t>Choice</a:t></a:r></a:p></mc:Choice><mc:Fallback><a:p><a:r><a:t>Fallback</a:t></a:r></a:p></mc:Fallback></mc:AlternateContent></p:txBody>');
  if (mode === 'hyperlink') {
    const link = '<a:hlinkClick r:id="rId_fixture_link"/>';
    xml = xml.replace(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/, properties => properties.endsWith('/>') ? properties.slice(0, -2) + '>' + link + '</a:rPr>' : properties.replace('</a:rPr>', link + '</a:rPr>'));
    zip.file('ppt/slides/_rels/slide1.xml.rels', (await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="rId_fixture_link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/source" TargetMode="External"/></Relationships>'));
  }
  if (mode === 'utf16-strict') {
    xml = xml.replaceAll('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main').replaceAll('http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main').replace('encoding="UTF-8"', 'encoding="UTF-16"');
    zip.file('ppt/slides/slide1.xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]));
  } else zip.file('ppt/slides/slide1.xml', xml);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const text = mode === 'empty' ? '' : mode === 'field-noop' ? 'Old date' : 'Literal 中文\nsecond'; const out = await removeFlow(h, bytes, [setText('S2-O1', text)]);
  const added = Object.keys(out.output.files).find(name => /^ppt\/slides\/unode-.*\.xml$/.test(name))!; expect(added).toBeDefined(); const actual = await out.output.file(added)!.async('nodebuffer');
  expect(readOfficeShapeText(actual, 'S2-O1', () => {}).text).toBe(text);
  if (mode === 'field-style' || mode === 'field-noop') { expect(actual.toString()).toContain('sz="2800"'); expect(actual.toString()).not.toContain('<a:fld'); }
  if (mode === 'end-style') expect(actual.toString()).toContain('sz="2400"');
  if (mode === 'alternate') expect(actual.toString()).not.toContain('AlternateContent');
  if (mode === 'hyperlink') expect(actual.toString()).toContain('r:id="rId_fixture_link"');
  if (mode === 'utf16-strict') expect([...actual.subarray(0, 2)]).toEqual([255, 254]);
  await preserved(bytes, await fs.readFile(join(h.root, 'copy.pptx')), ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
});
it('whole-text assignment, duplication, later partial edit and removal all use the current logical slide contents', async () => {
  const h = await host(); const out = await removeFlow(h, await source(true), [setText('S2-O1', 'Whole current'), { op: 'duplicate_slide', target_ref: 'S2', after_ref: null },
    textEdit('S2-O1', 'Whole current', 'Later source'), removeSlide('S2')]);
  expect(out.readback.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text)).toEqual(['Whole current', 'Shared title']);
});
it.each(['bad-fact', 'read-Off', 'write-Off', 'chart-target'])('withholds whole-text edits with %s and leaves an existing destination intact', async issue => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const initial = await collect(h, 'source.pptx'); await fs.writeFile(join(h.root, 'copy.pptx'), 'existing');
  if (issue !== 'chart-target') { const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
    const result = await real(...args); if (issue === 'bad-fact') result.shapes![0].characters++; else h.tools.setAllowedTools(new Set([issue === 'read-Off' ? 'write' : 'read'])); return result;
  }); }
  const saved = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'copy.pptx', edits: [setText(issue === 'chart-target' ? 'S2-O2' : 'S2-O1', 'Whole replacement')] });
  expect(saved.status).not.toBe('success'); expect(await fs.readFile(join(h.root, 'copy.pptx'), 'utf8')).toBe('existing'); if (issue === 'bad-fact') expect(saved.officeEdit?.code).toBe('office-output-check-failed');
});
