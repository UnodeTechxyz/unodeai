import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import JSZip from 'jszip';
import { Document, Packer, Paragraph } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { makeOfficeRenderCopy } from '../OfficeRenderCopy';
import { OfficePackage, OFFICE_REL } from '../OfficePackage';
import { PRESENTATION_PNG } from '../../backend/__tests__/presentationImageFixtures';

const roots: string[] = [];
async function stage() { const value = await realpath(await mkdtemp(join(tmpdir(), 'unode-render-copy-test-'))); roots.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) {
  if (await realpath(root) !== root || dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('unode-render-copy-test-') || (await lstat(root)).isSymbolicLink()) throw Error('unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
} });
async function copy(bytes: Buffer) {
  const root = await stage(); const source = join(root, 'source.zip'); await writeFile(source, bytes);
  const output = await makeOfficeRenderCopy(source, () => {}); expect(await readFile(source)).toEqual(bytes);
  const target = join(root, 'copy.zip'); await writeFile(target, output.bytes);
  const pkg = await OfficePackage.open(target, 200, 64 * 1024 * 1024, () => {});
  return { ...output, source, pkg, zip: await JSZip.loadAsync(output.bytes) };
}
it('builds real generated Word and PowerPoint passive copies that remain valid OPC with their visible text', async () => {
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Visible Word result')] }] }));
  const ppt = new PptxGenJS(); ppt.addSlide().addText('Visible slide result', { x: 1, y: 1, w: 5, h: 1 });
  for (const [bytes, text] of [[word, 'Visible Word result'], [Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer), 'Visible slide result']] as const) {
    const result = await copy(bytes);
    try {
      expect(result.pkg.macroEnabled).toBe(false); expect(result.fact.render_copy_sha256).toMatch(/^[a-f0-9]{64}$/);
      const all = await Promise.all(Object.values(result.zip.files).map(file => file.async('string'))); expect(all.join('')).toContain(text);
      for (const part of result.pkg.parts.filter(part => !part.name.includes('/_RELS/'))) for (const relation of await result.pkg.relations(part.name)) {
        expect(relation.external).toBe(false); expect(relation.target && result.pkg.zip.has(relation.target)).toBe(true);
      }
    } finally { result.pkg.close(); }
  }
});
it('removes macro, DDE, attached template, active payloads and external links while retaining cached visible field text', async () => {
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Visible original')] }] }));
  const zip = await JSZip.loadAsync(word); const rel = OFFICE_REL[0];
  const doc = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', doc.replace('?>', '?><?xml-stylesheet type="text/xsl" href="https://example.invalid/style"?>').replace('</w:body>', '<w:p><w:fldSimple w:instr="DDEAUTO dangerous"><w:r><w:t>Cached field result</w:t></w:r></w:fldSimple><w:r><w:instrText>DDEAUTO hidden</w:instrText></w:r><w:object>ACTIVE</w:object><w:altChunk r:id="remote"/><w:hyperlink r:id="remote"><w:r><w:t>Visible link label</w:t></w:r></w:hyperlink></w:p></w:body>'));
  const relationships = await zip.file('word/_rels/document.xml.rels')!.async('string');
  zip.file('word/_rels/document.xml.rels', relationships.replace('</Relationships>', `<Relationship Id="remote" Type="${rel}/hyperlink" Target="https://example.invalid/private" TargetMode="External"/><Relationship Id="template" Type="${rel}/attachedTemplate" Target="https://example.invalid/template" TargetMode="External"/><Relationship Id="macro" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>`));
  const ct = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', ct.replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/vnd.ms-word.document.macroEnabled.main+xml').replace('</Types>', '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
  zip.file('word/vbaProject.bin', 'inert macro canary, never executed');
  const result = await copy(await zip.generateAsync({ type: 'nodebuffer' }));
  try {
    expect(result.fact).toMatchObject({ macro_source: true, partial: true }); expect(result.fact.removed_relationships).toBeGreaterThanOrEqual(3);
    const text = await result.zip.file('word/document.xml')!.async('string');
    expect(text).toContain('Cached field result'); expect(text).toContain('Visible link label');
    expect(text).not.toMatch(/DDEAUTO|w:object|w:altChunk|w:hyperlink|w:fldSimple/);
    expect(Object.keys(result.zip.files)).not.toContain('word/vbaProject.bin');
    const all = (await Promise.all(Object.values(result.zip.files).map(file => file.async('string')))).join('');
    expect(all).not.toContain('example.invalid'); expect(result.pkg.macroEnabled).toBe(false);
  } finally { result.pkg.close(); }
});
it('bounds source bytes and rejects a source changed after the real ZIP writer completes, at the final hash check', async () => {
  const root = await stage(); const source = join(root, 'source.docx'); const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Original')] }] })); await writeFile(source, word);
  await expect(makeOfficeRenderCopy(source, () => {}, 1)).rejects.toThrow('render-copy-memory-limited');
  const generate = JSZip.prototype.generateAsync;
  vi.spyOn(JSZip.prototype, 'generateAsync').mockImplementation(async function (this: JSZip, ...args: any[]) {
    const actual = await generate.apply(this, args as any); await writeFile(source, Buffer.alloc(word.length)); return actual;
  } as any);
  await expect(makeOfficeRenderCopy(source, () => {})).rejects.toThrow('render-copy-source-changed');
});
it('keeps cached charts and strictly typed main relationships, and distinguishes omitted metadata', async () => {
  const ppt = new PptxGenJS(); ppt.addSlide().addChart(ppt.ChartType.bar, [{ name: 'Sales', labels: ['A', 'B'], values: [12, 24] }], { x: 1, y: 1, w: 6, h: 4 });
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  const root = await zip.file('_rels/.rels')!.async('string'); zip.file('_rels/.rels', root.replace(OFFICE_REL[0] + '/officeDocument', OFFICE_REL[1] + '/officeDocument'));
  const result = await copy(await zip.generateAsync({ type: 'nodebuffer' }));
  try {
    expect((await result.pkg.relations('/'))[0].type).toBe(OFFICE_REL[1] + '/officeDocument');
    expect(result.fact.native_charts).toBe(1);
    const chart = await result.zip.file('ppt/charts/chart1.xml')!.async('string'); expect(chart).toContain('<c:f>'); expect(chart).toContain('numCache'); expect(chart).not.toContain('externalData');
    expect(Object.keys(result.zip.files).some(name => name.endsWith('.xlsx'))).toBe(false); expect(result.fact.removed_metadata_parts).toBeGreaterThan(0);
  } finally { result.pkg.close(); }
});
it('drops an invalid image and keeps the rest of the real presentation instead of failing the whole copy', async () => {
  const ppt = new PptxGenJS(); const slide = ppt.addSlide(); slide.addText('Other content survives', { x: 1, y: 1, w: 5, h: 1 });
  slide.addImage({ data: 'data:image/png;base64,' + PRESENTATION_PNG.toString('base64'), x: 1, y: 2, w: 1, h: 1 });
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: 'nodebuffer' }) as Buffer);
  const image = Object.keys(zip.files).find(name => name.startsWith('ppt/media/') && !zip.files[name].dir)!; zip.file(image, 'invalid image bytes');
  const result = await copy(await zip.generateAsync({ type: 'nodebuffer' }));
  try {
    expect(result.fact.partial).toBe(true); expect(result.zip.file(image)).toBeNull();
    expect(await result.zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('Other content survives');
  } finally { result.pkg.close(); }
});
it('F1 produces an inert actual Word ZIP when literal field-code run text precedes an allowed instruction', async () => {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Ordinary content')] }] })));
  const xml = await zip.file('word/document.xml')!.async('string');
  const field = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>INCLUDEPICTURE &quot;\\\\inert.invalid\\fixture.png&quot; \\d</w:t></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Cached result remains</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  zip.file('word/document.xml', xml.replace('<w:sectPr>', field + '<w:sectPr>'));
  const result = await copy(await zip.generateAsync({ type: 'nodebuffer' }));
  try {
    const text = await result.zip.file('word/document.xml')!.async('string');
    expect(text).not.toMatch(/w:(?:fldChar|instrText)/); expect(text).toContain('Cached result remains'); expect(text).toContain('Ordinary content');
    expect(result.fact.partial).toBe(true);
  } finally { result.pkg.close(); }
});
it('W3 keeps Word comments and only the named thread elements of their metadata parts in the render copy', async () => {
  const fixture = await readFile(join(__dirname, 'testdata', 'word-revisions', 'word-revisions.docx'));
  const zip = await JSZip.loadAsync(fixture);
  zip.file('word/commentsExtended.xml', (await zip.file('word/commentsExtended.xml')!.async('string')).replace('</w15:commentsEx>', '<w15:other w15:paraId="1"/><w16:extLst xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"/></w15:commentsEx>'));
  const result = await copy(await zip.generateAsync({ type: 'nodebuffer' }));
  const extended = await result.zip.file('word/commentsExtended.xml')!.async('string'); const ids = await result.zip.file('word/commentsIds.xml')!.async('string');
  expect(extended.match(/<w15:commentEx /g)).toHaveLength(3); expect(extended).toContain('w15:paraIdParent="1A000002"'); expect(extended).not.toContain('w15:other'); expect(extended).not.toContain('extLst');
  expect(ids.match(/<w16cid:commentId /g)).toHaveLength(3);
  expect(await result.zip.file('word/comments.xml')!.async('string')).toContain('First comment line.');
  expect((await result.pkg.relations('/word/document.xml')).map(relation => relation.kind)).toEqual(expect.arrayContaining(['comments', 'commentsExtended', 'commentsIds']));
});
