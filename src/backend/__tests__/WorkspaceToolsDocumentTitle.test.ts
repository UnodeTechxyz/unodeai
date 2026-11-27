import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { saveHost, sha } from './attachmentSaveFixtures';
import { documentRouteRenderer } from './documentRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { validateDocumentRequest } from '../../content/document/DocumentValidation';

const owned: Array<Awaited<ReturnType<typeof host>>> = [];
async function host() {
  const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer()); tools.beginTurn();
  const result = { ...h, tools }; owned.push(result); return result;
}
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.tools.disposeBackground(); await h.assets.dispose(); } await removeTemporaryFolders(); });
const heading = (text = 'TITLE TOKEN', level = 1) => ({ type: 'heading', level, content: [{ text }] });
const body = { type: 'paragraph', content: [{ text: 'BODY TOKEN' }] };
const input = (format: string, document: object) => ({ schema_version: 1, format, template: 'report-v1', path: `out/untitled.proof.${format}`, document: { language: 'en', ...document } });
it.each(['', '   ', [{ text: '' }]])('an explicitly blank title is still rejected: %j', title => {
  expect(() => validateDocumentRequest(input('docx', { title, blocks: [heading(), body] }), { finalizeTitle: true })).toThrow('invalid-input');
});
async function inspect(bytes: Buffer, format: string) {
  if (format === 'docx') {
    const zip = await JSZip.loadAsync(bytes),xml = await zip.file('word/document.xml')!.async('string');
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join(' ');
    return { text: text.replace(/\s+/g, ' '), metadata: await zip.file('docProps/core.xml')!.async('string'), xml };
  }
  const pdf = await PDFDocument.load(bytes),{ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false }).promise;
  try { const text: string[] = []; for (let p = 1; p <= doc.numPages; p++) text.push((await (await doc.getPage(p)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' '));
    return { text: text.join(' ').replace(/\s+/g, ' '), metadata: pdf.getTitle() ?? '', xml: '' };
  } finally { await doc.destroy(); }
}
for (const format of ['docx', 'pdf']) {
  it.each([
    { name: 'promotes a missing title', document: { blocks: [heading(), body] }, titles: 1 },
    { name: 'deduplicates whitespace-equivalent title', document: { title: ' TITLE  TOKEN ', blocks: [heading('TITLE TOKEN'), body] }, titles: 1 },
    { name: 'preserves a different heading', document: { title: 'TITLE TOKEN', blocks: [heading('DIFFERENT'), body] }, titles: 1, other: 'DIFFERENT' },
    { name: 'compares case sensitively', document: { title: 'TITLE TOKEN', blocks: [heading('title token'), body] }, titles: 1, other: 'title token' },
    { name: 'normalizes only once across host and worker', document: { title: 'TITLE TOKEN', blocks: [heading(), heading(), body] }, titles: 2 },
    { name: 'supports a title-only document', document: { blocks: [heading()] }, titles: 1 },
  ])(`${format}: $name through the registered writer and real worker`, async c => {
    const h = await host(),request = input(format, c.document); const result = await h.tools.run('write_document', request);
    expect(result.status, result.output).toBe('success'); const proof = await inspect(await fs.readFile(join(h.root, request.path)), format);
    expect(proof.text.match(/TITLE TOKEN/g) ?? []).toHaveLength(c.titles); if (c.other) expect(proof.text).toContain(c.other);
    if (c.name === 'deduplicates whitespace-equivalent title') {
      if (format === 'pdf') expect(proof.metadata).toBe(' TITLE  TOKEN ');
      else expect(proof.xml).toContain('> TITLE  TOKEN </w:t>');
    }
  });
  it(`${format}: omitted title without leading H1 writes only body and filename metadata`, async () => {
    const h = await host(),request = input(format, { blocks: [body] }); const result = await h.tools.run('write_document', request);
    expect(result.status, result.output).toBe('success'); const proof = await inspect(await fs.readFile(join(h.root, request.path)), format);
    expect(proof.text.trim()).toBe(format === 'pdf' ? 'BODY TOKEN 1 / 1' : 'BODY TOKEN'); expect(proof.metadata).toContain('untitled.proof');
    if (format === 'docx') expect(proof.xml.match(/<w:p>/g)).toHaveLength(1);
  });
  it.each([false, true])(`${format}: draft parts preserve headings until final assembly, different=%s`, async different => {
    const h = await host(),first = input(format, { blocks: [heading(different ? 'DIFFERENT' : 'TITLE TOKEN'), body] });
    expect((await h.tools.run('write_document', { ...first, draft: 'title-parts', final: false })).status).toBe('success');
    const last = input(format, { title: 'TITLE TOKEN', blocks: different ? [heading()] : [] });
    const saved = await h.tools.run('write_document', { ...last, draft: 'title-parts', final: true });
    expect(saved.status, saved.output).toBe('success'); const proof = await inspect(await fs.readFile(join(h.root, last.path)), format);
    expect(proof.text.match(/TITLE TOKEN/g) ?? []).toHaveLength(different ? 2 : 1); expect(proof.text).toContain('BODY TOKEN');
    if (different) expect(proof.text).toContain('DIFFERENT');
  });
  it(`${format}: preserves source-bound table targets when the first H1 is removed`, async () => {
    const h = await host(),reader = await workbookRouteReader(); h.tools.setWorkbookReader(reader);
    try {
      await fs.writeFile(join(h.root, 'sales.csv'), 'Region,Sales\nNorth,15\nSouth,20\n');
      const read = await h.tools.run('read_workbook', { path: 'sales.csv' }); expect(read.status).toBe('success');
      const transformed = await h.tools.run('transform_workbook', { sources: [{ name: 's', snapshot_ref: JSON.parse(read.output).snapshot_ref, range: 'A2:B3' }], steps: [{ id: 'v', input: 's', operation: 'select', columns: [{ column: 'A', as: 'region' }, { column: 'B', as: 'sales', as_number: true }] }] });
      expect(transformed.status, transformed.output).toBe('success');
      const request = { ...input(format, { title: 'TITLE TOKEN', blocks: [heading(), { type: 'table', headers: ['Region', 'Sales'], rows: [['wrong', '999']] }] }), source_bindings: [{ block_index: 1, target: { row: 1, column: 1 }, data_from: { transformation_ref: JSON.parse(transformed.output).transformation_ref, fields: ['region', 'sales'] } }] };
      const result = await h.tools.run('write_document', request); expect(result.status, result.output).toBe('success');
      const proof = await inspect(await fs.readFile(join(h.root, request.path)), format); expect(proof.text).toContain('North'); expect(proof.text).toContain('15'); expect(proof.text).toContain('South'); expect(proof.text).toContain('20'); expect(proof.text).not.toContain('999');
    } finally { await reader.dispose(); }
  });
}
// Immutable a12a2d4c byte goldens; local to this proof, not shared data for unrelated mutation cases.
const golden = { cases: [
  { format: 'docx', kind: 'paragraph', sha256: 'f2e0a0dd6ea0228471cd9951997c0866fd865df8a0de07bc4e09f8fbf7e82e36' },
  { format: 'docx', kind: 'different-h1', sha256: 'e1311eeb474749c07a17e1f0a3942e038546f6d8db908bf1e23b785183269782' },
  { format: 'docx', kind: 'same-h2', sha256: '33b778ad2ef434e6344786e157e1a87ac10ad875631e05ce1de4291c36082a92' },
  { format: 'pdf', kind: 'paragraph', sha256: '1956c566e36c9f24d283e3306d808cdfc45e07d6a83e6584b07ed46fe91c06fd' },
  { format: 'pdf', kind: 'different-h1', sha256: 'ce006d819570dc1b753b01813dff4e3bd4c7e75f3745881bf8d0b74703824385' },
  { format: 'pdf', kind: 'same-h2', sha256: '59eed344ca2d15c536f36bfda4184d191fe46a5bcf2c5e7af47d56bd2ebc138d' },
] };
it.each(golden.cases)('legacy byte golden $format/$kind matches a12a2d4c', async c => {
  const h = await host(),request = { ...input(c.format, { title: 'LEGACY TITLE', blocks: [...(c.kind === 'paragraph' ? [] : [heading(c.kind === 'different-h1' ? 'OTHER' : 'LEGACY TITLE', c.kind === 'different-h1' ? 1 : 2)]), { type: 'paragraph', content: [{ text: 'UNCHANGED BODY' }] }] }), path: `legacy.${c.format}` };
  const result = await h.tools.run('write_document', request); expect(result.status, result.output).toBe('success'); expect(sha(await fs.readFile(join(h.root, request.path)))).toBe(c.sha256);
});
