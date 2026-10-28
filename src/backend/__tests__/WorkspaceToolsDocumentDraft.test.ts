/*
 * v0.9.99 CF-1: a long contract becomes ONE Word/PDF file. No whole-document length ceiling refuses it, and a model
 * may send it in draft parts that the host assembles in order. Real worker renderer, real DOCX reader, synthetic text.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractWorkspaceDocument } from '../../content/ContentAssetStore';
import { documentPlainText, documentTexts, DocumentFailure } from '../../content/document/DocumentContracts';
import { validateDocumentRequest } from '../../content/document/DocumentValidation';
import { renderPdf } from '../../content/document/PdfRenderer';
import { DocumentRenderer } from '../../content/document/DocumentRenderer';
import { Worker } from 'node:worker_threads';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { saveHost } from './attachmentSaveFixtures';
import { documentRouteRenderer } from './documentRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);
// Each test starts the real isolated render worker; give it room when the machine is busy.
vi.setConfig({ testTimeout: 60_000 });

const CONTRACT_CHARACTERS = 126_490;
const words = ['Provider', 'Customer', 'shall', 'deliver', 'the', 'Services', 'under', 'this', 'Agreement', 'within',
  'thirty', 'days', 'of', 'written', 'notice', 'and', 'subject', 'to', 'applicable', 'law', 'including', 'confidentiality'];
const sentence = (seed: number, length: number) => {
  const out: string[] = []; let used = 0; let i = seed;
  while (used <= length) { const word = words[i++ % words.length]; out.push(word); used += word.length + 1; }
  const text = out.join(' ').slice(0, length);
  return text.endsWith(' ') ? `${text.slice(0, -1)}x` : text;
};

/** A synthetic contract of exactly 126,490 characters: articles, clauses, a fee table, signatures and attachments. */
function syntheticContract(format: 'docx' | 'pdf') {
  const blocks: any[] = [];
  for (let article = 1; article <= 12; article++) {
    blocks.push({ type: 'heading', level: 1, content: [{ text: `Article ${article} MARK-A${article}` }] });
    for (let clause = 1; clause <= 6; clause++) {
      blocks.push({ type: 'clause', label: `${article}.${clause}`,
        content: [{ text: `${sentence(article * 7 + clause, 1300)} MARK-C${article}-${clause}` }] });
    }
  }
  blocks.push({ type: 'heading', level: 1, content: [{ text: 'Schedule of Fees MARK-TABLE' }] });
  blocks.push({ type: 'table', headers: ['Item', 'Description', 'Amount'], rows: Array.from({ length: 40 }, (_, i) =>
    [`Item ${i + 1}`, `${sentence(i, 60)} MARK-ROW${i + 1}`, `${(i + 1) * 100}.00`]) });
  blocks.push({ type: 'signature', parties: [{ label: 'PROVIDER MARK-SIGN1', name: 'Example Provider Ltd' },
    { label: 'CUSTOMER MARK-SIGN2', name: 'Example Customer Inc' }, { label: 'WITNESS MARK-SIGN3' }, { label: 'GUARANTOR MARK-SIGN4' }] });
  blocks.push({ type: 'page-break' });
  blocks.push({ type: 'heading', level: 1, content: [{ text: 'Attachment A Data Processing Terms MARK-ATTA' }] });
  for (let i = 0; i < 6; i++) blocks.push({ type: 'paragraph', content: [{ text: `${sentence(i * 3, 1500)} MARK-ATTA${i + 1}` }] });
  blocks.push({ type: 'heading', level: 1, content: [{ text: 'Attachment B Service Levels MARK-ATTB' }] });
  const request = { schema_version: 1, path: `out/contract.${format}`, format, template: 'contract-v1',
    document: { title: 'Master Services Agreement', language: 'en', footer: 'Confidential', blocks } };
  const used = documentTexts(validateDocumentRequest(request).document).reduce((n, text) => n + documentPlainText(text).length, 0);
  const tail = ' MARK-END';
  blocks.push({ type: 'paragraph', content: [{ text: `${sentence(5, CONTRACT_CHARACTERS - used - tail.length)}${tail}` }] });
  const total = documentTexts(validateDocumentRequest(request).document).reduce((n, text) => n + documentPlainText(text).length, 0);
  if (total !== CONTRACT_CHARACTERS) throw new Error(`synthetic contract is ${total} characters`);
  return request;
}
const markers = (request: ReturnType<typeof syntheticContract>) =>
  JSON.stringify(request.document.blocks).match(/MARK-[A-Z0-9-]+/g)!;

async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options);
  const tools = h.tools();
  const real = await documentRouteRenderer();
  const renderer = { render: vi.fn((...args: Parameters<typeof real.render>) => real.render(...args)) };
  tools.setDocumentRenderer(renderer);
  tools.beginTurn();
  return { ...h, tools, renderer, real };
}
/** The product's own Word reader (the read_file path), through its isolated worker. */
async function readDocx(file: string): Promise<string> {
  const extracted = await extractWorkspaceDocument(await fs.readFile(file));
  if (!extracted.text) throw new Error(`DOCX not readable: ${extracted.error}`);
  return extracted.text;
}
function expectInOrder(text: string, expected: string[]) {
  let at = -1;
  for (const marker of expected) {
    const next = text.indexOf(marker, at + 1);
    expect(next, marker).toBeGreaterThan(at); at = next;
  }
}
const draftFiles = async (tools: any): Promise<string[]> => {
  const root = await (tools.documentDrafts as any).root;
  return root ? fs.readdir(root).catch(() => []) : [];
};

describe('v0.9.99 CF-1: one complete document, no length ceiling', () => {
  it('writes the 126,490-character contract as ONE DOCX in one call; every section reads back in order', async () => {
    const h = await host(); const input = syntheticContract('docx');
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(126_490);
    const result = await h.tools.run('write_document', input);
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { format: 'docx', tables: 1 } } });
    expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['contract.docx']);
    const text = await readDocx(path.join(h.root, input.path));
    expectInOrder(text, markers(input));
    for (const block of input.document.blocks) {
      if (block.type === 'paragraph' || block.type === 'clause') expect(text).toContain(block.content[0].text);
    }
    expect(text).toContain('Example Customer Inc'); expect(text).toContain('6.6');
  }, 60_000);

  it('writes the same contract as ONE PDF of every section with the real worker renderer', async () => {
    const h = await host(); const input = syntheticContract('pdf');
    const result = await h.tools.run('write_document', input);
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { format: 'pdf' } } });
    if (result.documentWrite?.code !== 'written') throw new Error('not written');
    const pages = result.documentWrite.receipt.pages!;
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const reader = await getDocument({ data: Uint8Array.from(await fs.readFile(path.join(h.root, input.path))), useSystemFonts: false }).promise;
    try {
      expect(reader.numPages).toBe(pages);
      let all = '';
      for (let page = 1; page <= reader.numPages; page++) {
        all += (await (await reader.getPage(page)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join('');
      }
      expectInOrder(all, markers(input));
      expect(all).toContain(`Confidential ${pages} / ${pages}`);
    } finally { await reader.destroy(); }
  }, 120_000);

  it('assembles five draft calls into ONE DOCX in call order and removes the draft once written', async () => {
    const h = await host(); const full = syntheticContract('docx'); const blocks = full.document.blocks;
    const cuts = [0, 20, 45, 70, 80, blocks.length];
    const parts = cuts.slice(0, -1).map((start, i) => blocks.slice(start, cuts[i + 1]));
    for (let i = 0; i < 4; i++) {
      const result = await h.tools.run('write_document', { ...full, draft: 'msa', document: { ...full.document, blocks: parts[i] } });
      expect(result).toMatchObject({ status: 'success', kind: 'unknown' });
      expect(result.output).toContain(`part ${i + 1} added`); expect(result.output).toContain('No file has been written yet');
      expect(result).not.toHaveProperty('path'); expect(result).not.toHaveProperty('documentWrite');
      expect(await fs.readdir(h.root)).toEqual([]);
    }
    expect(await draftFiles(h.tools)).toHaveLength(1);
    expect(h.renderer.render).not.toHaveBeenCalled();
    const final = await h.tools.run('write_document', { ...full, draft: 'msa', final: true, document: { ...full.document, blocks: parts[4] } });
    expect(final).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { blocks: blocks.length } } });
    expect(h.renderer.render).toHaveBeenCalledOnce();
    expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['contract.docx']);
    expectInOrder(await readDocx(path.join(h.root, full.path)), markers(full));
    expect(await draftFiles(h.tools)).toEqual([]);
    // Written means gone: the same final again finds no draft and never writes a shorter document.
    expect(await h.tools.run('write_document', { ...full, draft: 'msa', final: true, document: { ...full.document, blocks: [] } }))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found', targetEffect: 'none' } });
  }, 60_000);

  it('accepts input over every former threshold in one DOCX: JSON size, text, runs, distinct Han characters, blocks and cells', async () => {
    const h = await host();
    const han = Array.from({ length: 4_097 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const blocks: any[] = [
      { type: 'paragraph', content: [{ text: `${han} HAN-END`, language: 'zh-Hans' }] },
      { type: 'paragraph', content: Array.from({ length: 4_097 }, (_, i) => ({ text: `run${i} ` })) },
      { type: 'table', headers: Array(8).fill('H'), rows: Array.from({ length: 501 }, (_, i) => Array(8).fill(`cell${i}`)) },
      ...Array.from({ length: 1_001 }, (_, i) => ({ type: 'paragraph', content: [{ text: `block${i} ${'x'.repeat(1_100)}` }] })),
    ];
    const input = { schema_version: 1, path: 'big.docx', format: 'docx', template: 'report-v1', document: { title: 'Thresholds', blocks } };
    const json = Buffer.byteLength(JSON.stringify(input));
    expect(json).toBeGreaterThan(1_048_576);
    expect(documentTexts(validateDocumentRequest(input).document).reduce((n, t) => n + documentPlainText(t).length, 0)).toBeGreaterThan(262_144);
    const result = await h.tools.run('write_document', input);
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { blocks: 1_004, tables: 1 } } });
    const text = await readDocx(path.join(h.root, 'big.docx'));
    expect(text).toContain(`${han} HAN-END`); expect(text).toContain('run4096'); expect(text).toContain('cell500');
    expect(text).toContain('block1000 ');
  }, 60_000);
});

describe('v0.9.99 CF-1: drafts are separate from the final target', () => {
  const part = (blocks: any[], extra: object = {}) => ({ schema_version: 1, path: 'out/contract.docx', format: 'docx',
    template: 'contract-v1', draft: 'd1', document: { title: 'Contract', language: 'en', blocks }, ...extra });
  const para = (text: string) => ({ type: 'paragraph', content: [{ text }] });

  it('Stop during assembly publishes nothing, ends the draft and leaves no worker running', async () => {
    const h = await host(); const abort = new AbortController();
    await fs.mkdir(path.join(h.root, 'out')); await fs.writeFile(path.join(h.root, 'out/contract.docx'), 'existing bytes');
    for (let i = 0; i < 4; i++) expect((await h.tools.run('write_document', part([para(`PART ${i}`)]))).status).toBe('success');
    // The real worker, stopped the moment it exists: Stop reaches the render while the document is being assembled.
    const workers: Worker[] = [];
    const stopping = new DocumentRenderer((h.real as any).workerPath, (file, limits) => {
      const worker = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb } });
      workers.push(worker); queueMicrotask(() => abort.abort()); return worker;
    }, (h.real as any).fontEnvironment);
    h.renderer.render.mockImplementationOnce((request, signal, current) => stopping.render(request, signal, current));
    const result = await h.tools.run('write_document', part([para('LAST')], { final: true }), { signal: abort.signal });
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code: 'cancelled', targetEffect: 'none' } });
    expect(workers).toHaveLength(1); expect(workers[0].threadId).toBe(-1);
    expect(await fs.readFile(path.join(h.root, 'out/contract.docx'), 'utf8')).toBe('existing bytes');
    expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['contract.docx']);
    expect(await draftFiles(h.tools)).toEqual([]);
    expect(await h.tools.run('write_document', part([], { final: true }))).toMatchObject({ documentWrite: { code: 'draft-not-found' } });
  });

  it('Stop between parts ends the draft: a later final is never written as a shorter document', async () => {
    const h = await host(); const turn = new AbortController();
    expect((await h.tools.run('write_document', part([para('ONE')]), { signal: turn.signal })).status).toBe('success');
    expect((await h.tools.run('write_document', part([para('TWO')]), { signal: turn.signal })).status).toBe('success');
    turn.abort(); await vi.waitFor(async () => expect(await draftFiles(h.tools)).toEqual([]));
    const result = await h.tools.run('write_document', part([para('THREE')], { final: true }));
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found', targetEffect: 'none' } });
    expect(result.output).toContain('Send the document again'); expect(await fs.readdir(h.root)).toEqual([]);
  });

  it('a real render failure preserves the existing target and keeps the draft for a Word retry without resending parts', async () => {
    const h = await host(); const notices: string[] = []; h.tools.setDocumentFallbackObserver(text => notices.push(text));
    await fs.mkdir(path.join(h.root, 'out')); await fs.writeFile(path.join(h.root, 'out/contract.pdf'), 'previous pdf');
    const pdf = { path: 'out/contract.pdf', format: 'pdf' };
    for (const text of ['FIRST', 'SECOND', 'THIRD']) expect((await h.tools.run('write_document', part([para(text)], pdf))).status).toBe('success');
    // The actual PDF renderer with no usable font: a genuine font failure, not a mocked code.
    h.renderer.render.mockImplementationOnce(request => renderPdf(request, async () => []));
    const failed = await h.tools.run('write_document', part([para('FOURTH')], { ...pdf, final: true }));
    expect(failed).toMatchObject({ status: 'failed', documentWrite: { code: 'font-unavailable', targetEffect: 'none' } });
    expect(failed.output).toContain('write the same document now with format docx');
    expect(failed.output).toContain('The draft "d1" is kept with every part'); expect(notices).toHaveLength(1);
    expect(await fs.readFile(path.join(h.root, 'out/contract.pdf'), 'utf8')).toBe('previous pdf');
    // The approved Word fallback: same draft, final again, format docx, no blocks resent.
    const word = await h.tools.run('write_document', part([], { final: true }));
    expect(word).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { format: 'docx', blocks: 4 } } });
    expectInOrder(await readDocx(path.join(h.root, 'out/contract.docx')), ['FIRST', 'SECOND', 'THIRD', 'FOURTH']);
    expect(await fs.readFile(path.join(h.root, 'out/contract.pdf'), 'utf8')).toBe('previous pdf');
  });

  it('a draft part is not a request effect, but the final write still waits at an explicit request limit', async () => {
    const h = await host(); const asked: string[] = [];
    h.tools.setRequestBoundary(async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; });
    expect(isGovernedWorkspaceTool('write_document', part([]))).toBe(false);
    expect(isGovernedWorkspaceTool('write_document', part([], { final: true }))).toBe(true);
    expect(isGovernedWorkspaceTool('write_document', { ...part([]), draft: undefined })).toBe(true);
    expect((await h.tools.run('write_document', part([para('ONE')]))).status).toBe('success');
    expect(asked).toEqual([]);
    expect(await h.tools.run('write_document', part([para('TWO')], { final: true }))).toMatchObject({ status: 'refused', reason: 'safety-limit' });
    expect(asked).toEqual(['write_document']); expect(h.renderer.render).not.toHaveBeenCalled(); expect(await fs.readdir(h.root)).toEqual([]);
  });

  it('keeps the floors: no draft without write capability, trust or a valid name; retire removes every draft', async () => {
    const h = await host();
    const readOnly = new (h.tools.constructor as any)(h.root, new Set(['read'])); readOnly.setDocumentRenderer(h.renderer);
    expect(await readOnly.run('write_document', part([para('X')]))).toMatchObject({ status: 'refused' });
    expect(await draftFiles(readOnly)).toEqual([]);
    const untrusted = await host({ trusted: () => false });
    expect(await untrusted.tools.run('write_document', part([para('X')]))).toMatchObject({ status: 'refused', reason: 'trust' });
    for (const draft of ['', ' ', 'a\u0001b', 7]) {
      expect(await h.tools.run('write_document', { ...part([para('X')]), draft })).toMatchObject({ documentWrite: { code: 'invalid-input' } });
    }
    expect(await h.tools.run('write_document', { ...part([para('X')]), final: 'yes' })).toMatchObject({ documentWrite: { code: 'invalid-input' } });
    expect((await h.tools.run('write_document', part([para('X')]))).status).toBe('success');
    expect((await h.tools.run('write_document', part([para('Y')], { draft: 'd2' }))).status).toBe('success');
    expect(await draftFiles(h.tools)).toHaveLength(2);
    const root = await (h.tools as any).documentDrafts.root;
    h.tools.retire();
    await vi.waitFor(async () => expect(await fs.stat(root).then(() => true, () => false)).toBe(false));
  });

  it('reports a PDF part with text PDF cannot lay out at once, without storing it, so the part can be corrected', async () => {
    const h = await host(); const pdf = { path: 'out/contract.pdf', format: 'pdf' };
    expect((await h.tools.run('write_document', part([para('ONE')], pdf))).status).toBe('success');
    const bad = await h.tools.run('write_document', part([para('OK'), { type: 'paragraph', content: [{ text: 'Party \u4e2d', language: 'en' }] }], pdf));
    expect(bad).toMatchObject({ status: 'failed', documentWrite: { code: 'document-language-required', stage: 'input' } });
    expect(bad.output).toContain('U+4E2D in block 2'); expect(bad.output).toContain('of this part');
    expect(bad.output).toContain('Set the language of that text');
    const fixed = await h.tools.run('write_document', part([{ type: 'paragraph', content: [{ text: 'Party \u4e2d', language: 'zh-Hans' }] }], pdf));
    expect(fixed).toMatchObject({ status: 'success' }); expect(fixed.output).toContain('part 2 added');
  });
  it('validates the assembled document as a whole, and a storage failure never yields a silently shorter document', async () => {
    const h = await host();
    expect((await h.tools.run('write_document', part([para('ONE'), { type: 'page-break' }]))).status).toBe('success');
    expect(await h.tools.run('write_document', part([{ type: 'page-break' }, para('TWO')], { final: true })))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'invalid-input', stage: 'input' } });
    const store = (h.tools as any).documentDrafts;
    vi.spyOn(store, 'read').mockRejectedValueOnce(new DocumentFailure('draft-storage-failed'));
    const broken = await h.tools.run('write_document', part([para('TWO')], { final: true }));
    expect(broken).toMatchObject({ status: 'failed', documentWrite: { code: 'draft-storage-failed', targetEffect: 'none' } });
    expect(await fs.readdir(h.root)).toEqual([]);
    expect(await h.tools.run('write_document', part([], { final: true }))).toMatchObject({ documentWrite: { code: 'draft-not-found' } });
  });
});
