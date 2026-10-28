import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDocx, type DocumentZip } from '../../content/document/DocxRenderer';
import { DocumentFailure, type CanonicalDocumentRequest } from '../../content/document/DocumentContracts';
import { DOCUMENT_LAYOUT_WARNING_TEXT } from '../../content/document/DocumentWrite';
import { validateDocumentRequest } from '../../content/document/DocumentValidation';
import { DocumentRenderer } from '../../content/document/DocumentRenderer';
import { readTargetState, type HostObservedFileEffect } from '../fileWritePolicy';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { MAY_MUTATE_WORKSPACE_TOOLS, requiresTrustedWorkspace, WorkspaceTools } from '../WorkspaceTools';
import { saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { hostToolFailed } from '../toolSummary';
import { renderPdf } from '../../content/document/PdfRenderer';
import { pdfTestFont } from '../../content/document/__tests__/pdfTestFont';

afterEach(removeTemporaryFolders);
const input = () => ({ schema_version: 1, path: 'out/contract.docx', format: 'docx', template: 'contract-v1',
  document: { title: 'Contract < & >', language: 'en', blocks: [
    { type: 'clause', label: '1.01', content: [{ text: '  Compute 123.00\nSecond line  ' }] },
  ] } });
// Test-only renderer executes the real finite ZIP writer. Production only uses the isolated host queue.
const render = async (request: CanonicalDocumentRequest) => {
  const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
  return renderDocx(request, () => new yazl.ZipFile());
};
async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const effects: HostObservedFileEffect[] = [];
  const h = await saveHost({ ...options, onEffect: effect => { effects.push(effect); options.onEffect?.(effect); } });
  const tools = h.tools();
  const renderer = { render: vi.fn(render) };
  tools.setDocumentRenderer(renderer);
  tools.beginTurn();
  return { ...h, tools, renderer, effects };
}

describe('D1 uses the existing binary approval/checkpoint/commit/read-back boundary', () => {
  it('repairs a Chinese run in an English document and then writes the same content as PDF, not Word', async () => {
    const h = await host(); const notices: string[] = [];
    h.tools.setDocumentFallbackObserver(text => notices.push(text));
    const args = { ...input(), path: 'out/contract.pdf', format: 'pdf', document: { title: 'Contract', language: 'en',
      blocks: [{ type: 'paragraph', content: [{ text: 'Party 中国', language: 'en' }] }] } };
    const first = await h.tools.run('write_document', args);
    expect(first).toMatchObject({ status: 'failed', documentWrite: { code: 'document-language-required' } });
    expect(first.output).toContain('U+4E2D in block 1');
    expect(first.output).toContain('Set the language of that text (or the document) to zh-Hans, zh-Hant, ja or ko as appropriate, and try PDF again.');
    expect(first.output).not.toContain('write the same document');
    expect(first.output).not.toContain('asked the agent to save it as Word');
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(notices).toEqual([]);
    expect(await fs.readdir(h.root)).toEqual([]);

    // Real renderer/subsetter, with original synthetic glyphs, not a visual Chinese-font qualification.
    h.renderer.render.mockImplementationOnce(request => renderPdf(request, async (_language, style) => {
      const bytes = Uint8Array.from(pdfTestFont(style === 'bold', '中国')).buffer;
      return [{ bytes, sha256: sha(Buffer.from(bytes)), family: 'UnodeTest' }];
    }));
    args.document.blocks[0].content[0].language = 'zh-Hans';
    const second = await h.tools.run('write_document', args);
    const bytes = await fs.readFile(path.join(h.root, args.path));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(second).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: {
      format: 'pdf', path: args.path, bytes: bytes.length, sha256: sha(bytes),
    } } });
    expect(h.renderer.render.mock.calls[0][0].document.blocks[0]).toMatchObject({ content: [{ text: 'Party 中国', language: 'zh-Hans' }] });
    expect(notices).toEqual([]); expect(h.effects).toHaveLength(1);
    expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['contract.pdf']);
  });
  it.each(['invalid-input', 'extension-mismatch', 'out-of-memory', 'draft-not-found', 'draft-storage-failed',
    'render-stop-unconfirmed', 'effect-uncertain', 'target-changed', 'checkpoint-failed',
    'not-committed'] as const)('keeps the original PDF failure text and posts no Word reminder for %s', async code => {
    const h = await host(); const notices: string[] = [];
    h.tools.setDocumentFallbackObserver(text => notices.push(text));
    h.renderer.render.mockRejectedValueOnce(new DocumentFailure(code));
    const result = await h.tools.run('write_document', { ...input(), path: 'out/contract.pdf', format: 'pdf' });
    const extra = code === 'render-stop-unconfirmed'
      ? ' The previous worker stop was not confirmed. Nothing was committed; the next document request uses a fresh worker.'
      : code === 'out-of-memory' ? ' The document renderer ran out of memory on this machine, so nothing was written. '
        + 'Ask the user to close other programs and try again.' : '';
    expect(result.output).toBe(`Document not written: ${code}.${extra}`);
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code } });
    expect(notices).toEqual([]); expect(h.effects).toEqual([]);
  });

  it('keeps a failed (not refused) undecided write as denied without suggesting Word', async () => {
    const h = await host(); const notices: string[] = [];
    h.tools.setDocumentFallbackObserver(text => notices.push(text));
    // Exercise the defensive denied-code path independently of the ordinary consent-refused outcome.
    const decision = vi.spyOn(h.tools as any, 'askBoundDecision').mockResolvedValueOnce(hostToolFailed('Save was not approved.'));
    const result = await h.tools.run('write_document', { ...input(), path: 'out/contract.pdf', format: 'pdf' });
    expect(decision).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', output: 'Save was not approved.', documentWrite: { code: 'denied' } });
    expect(notices).toEqual([]); expect(h.effects).toEqual([]);
  });

  it('does not add a PDF failure reminder when Stop causes a worker-exit during rendering', async () => {
    const h = await host(); const abort = new AbortController(); const notices: string[] = [];
    h.tools.setDocumentFallbackObserver(text => notices.push(text));
    h.renderer.render.mockImplementationOnce(async () => { abort.abort(); throw new DocumentFailure('worker-exit'); });
    const result = await h.tools.run('write_document', { ...input(), path: 'out/contract.pdf', format: 'pdf' }, { signal: abort.signal });
    expect(abort.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'failed', output: 'Document not written: worker-exit.', documentWrite: { code: 'worker-exit' } });
    expect(notices).toEqual([]); expect(h.effects).toEqual([]);
  });
  it.each(['font-unavailable', 'unsupported-glyph', 'layout-unrepresentable', 'worker-exit', 'font-budget'] as const)(
    'gives a Word fallback and exactly one host reminder after PDF %s, without writing another file', async code => {
      const h = await host(); const notices: string[] = [];
      h.tools.setDocumentFallbackObserver(text => notices.push(text));
      h.renderer.render.mockRejectedValueOnce(new DocumentFailure(code));
      const result = await h.tools.run('write_document', { ...input(), path: 'out/contract.pdf', format: 'pdf' });
      expect(result).toMatchObject({ status: 'failed', documentWrite: { code, targetEffect: 'none' } });
      expect(result.output).toContain('write the same document now with format docx');
      expect(result.output).toContain('out/contract.docx');
      for (const text of ['1. Open the Word file', 'File → Save As', '2. Or open it in LibreOffice', 'File → Export as PDF']) {
        expect(result.output).toContain(text); expect(notices[0]).toContain(text);
      }
      expect(notices).toHaveLength(1); expect(notices[0]).toContain('asked the agent');
      expect(h.effects).toEqual([]); expect(await fs.readdir(h.root)).toEqual([]);
    });
  it.each(['permission', 'stop', 'denied', 'docx'] as const)('does not suggest a fallback after %s', async kind => {
    const h = await host({ ask: kind === 'denied', approve: async () => 'deny' });
    const notices: string[] = []; h.tools.setDocumentFallbackObserver(text => notices.push(text));
    const abort = new AbortController();
    if (kind === 'stop') abort.abort();
    if (kind === 'permission') h.tools.setDocumentRenderer(undefined);
    if (kind === 'docx') h.renderer.render.mockRejectedValueOnce(new DocumentFailure('font-unavailable'));
    const result = await h.tools.run('write_document', kind === 'docx' ? input()
      : { ...input(), path: 'out/contract.pdf', format: 'pdf' }, { signal: abort.signal });
    expect(result.status).not.toBe('success'); expect(result.output).not.toContain('write the same document');
    expect(notices).toEqual([]); expect(h.effects).toEqual([]);
  });
  it('names the unsupported PDF code point and block without leaking surrounding text', async () => {
    const h = await host(); const args = input();
    args.document.blocks[0].content = [{ text: '\u0627 private-contract-text' }];
    const result = await h.tools.run('write_document', { ...args, path: 'out/contract.pdf', format: 'pdf' });
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code: 'unsupported-text-layout' } });
    expect(result.output).toContain('U+0627 in block 1'); expect(result.output).toContain('write the same document now with format docx');
    expect(result.output).not.toContain('private-contract-text'); expect(h.renderer.render).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });
  it('writes real DOCX bytes and a host receipt of the same read-back effect, not a model claim', async () => {
    const h = await host();
    const result = await h.tools.run('write_document', input());
    const bytes = await fs.readFile(path.join(h.root, input().path));
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: {
      kind: 'document-written', version: 1, format: 'docx', template: 'contract-v1', path: input().path,
      bytes: bytes.length, sha256: sha(bytes), effect: 'created', blocks: 1, headings: 0, clauses: 1, tables: 0,
      rendererRevision: 2, layoutAdmissionPolicy: 'pdf-layout-v1/ucd-17.0.0', layoutWarnings: [],
    } } });
    if (result.documentWrite?.code !== 'written') throw Error('no receipt');
    expect(result.documentWrite.receipt).not.toHaveProperty('pages');
    expect(result.output).toContain(sha(bytes));
    expect(result.output).not.toContain(h.root);
    expect(result.output).not.toContain('Compute 123.00');
    expect(h.effects).toHaveLength(1);
    expect(h.effects[0]).toMatchObject({ path: input().path, grade: 'host-verified', requestId: 'r1', agentId: 'dev' });
    expect(h.text.list()[0]).toMatchObject({ path: input().path, before: null, afterSha256: sha(bytes) });
  });

  it('keeps exact bytes before replacing and does not invent an effect or restore point for unchanged output', async () => {
    const h = await host();
    const target = path.join(h.root, 'old.docx');
    const old = Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x31]);
    await fs.writeFile(target, old);
    const args = { ...input(), path: 'old.docx' };
    const first = await h.tools.run('write_document', args);
    const bytes = await fs.readFile(target);
    const store = await h.rawStore(); const [point] = store.list();
    expect(first).toMatchObject({ status: 'success', documentWrite: { receipt: { effect: 'replaced', restorePointId: point.id } } });
    expect(await store.readBefore(point.id)).toEqual({ status: 'read', bytes: old });
    const again = await h.tools.run('write_document', args);
    expect(again).toMatchObject({ status: 'success', documentWrite: { receipt: { effect: 'unchanged', bytes: bytes.length, sha256: sha(bytes) } } });
    if (again.documentWrite?.code !== 'written') throw Error('no receipt');
    expect(again.documentWrite.receipt).not.toHaveProperty('restorePointId');
    expect(h.effects).toHaveLength(1); expect(h.text.list()).toHaveLength(1); expect(store.list()).toHaveLength(1);
  });

  it('explicit Ask shows format/template/path/size/hash and overwrite consequence on the ordinary write card', async () => {
    const h = await host({ ask: true, approve: async () => 'deny' });
    await fs.writeFile(path.join(h.root, 'old.docx'), 'old');
    const result = await h.tools.run('write_document', { ...input(), path: 'old.docx' });
    expect(result).toMatchObject({ status: 'refused', documentWrite: { code: 'denied', targetEffect: 'none' } });
    expect(h.state.decisions).toHaveLength(0);
    expect(h.state.approvals).toHaveLength(1);
    const preview = h.state.approvals[0].preview!;
    for (const token of ['DOCX', 'old.docx', 'contract-v1', 'Size:', 'SHA-256:', 'exact bytes must be kept first']) expect(preview).toContain(token);
    expect(await fs.readFile(path.join(h.root, 'old.docx'), 'utf8')).toBe('old');
    expect(h.effects).toEqual([]); expect(h.text.list()).toEqual([]);
  });

  it('denial of a new document creates neither parent directory nor checkpoint', async () => {
    const h = await host({ ask: true, approve: async () => 'deny' });
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'refused', documentWrite: { code: 'denied' } });
    expect(await fs.readdir(h.root)).toEqual([]); expect(h.effects).toEqual([]);
  });

  // v0.9.99 (A3): when the existing file's exact bytes cannot be kept, the document is still written; its receipt names
  // no restore point and the result says it has none.
  it('writes the document when existing exact bytes cannot be kept, names no restore point, and says so', async () => {
    const h = await host({ limits: { maxPayloadBytes: 4 } });
    await fs.writeFile(path.join(h.root, 'old.docx'), 'older bytes');
    const result = await h.tools.run('write_document', { ...input(), path: 'old.docx' });
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { effect: 'replaced' } } });
    expect(result.documentWrite?.receipt).not.toHaveProperty('restorePointId');
    expect(result.output).toMatch(/No exact restore point for this change to "old\.docx": UnodeAi could not keep a copy of its bytes/);
    expect(await fs.readFile(path.join(h.root, 'old.docx'), 'utf8')).not.toBe('older bytes');
    expect(h.effects).toHaveLength(1);
    expect(h.state.notices.filter((line) => line.includes('restore point for this change'))).toHaveLength(1);
  });

  it('never returns a success receipt when read-back differs and records the actual uncertain effect', async () => {
    const h = await host({ readState: async physical => {
      const seen = await readTargetState(physical);
      return seen.state.exists ? { state: { ...seen.state, sha256: sha('different') } } : seen;
    } });
    const result = await h.tools.run('write_document', input());
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code: 'effect-uncertain', targetEffect: 'uncertain' } });
    expect(result.documentWrite).not.toHaveProperty('receipt');
    expect(h.effects).toHaveLength(1); expect(h.effects[0].grade).toBe('effect-uncertain');
  });

  it('still requires the team read-before-write check', async () => {
    const h = await host({ coordinator: new OptimisticFileCoordinator() });
    await fs.writeFile(path.join(h.root, 'old.docx'), 'a teammate\'s file');
    const result = await h.tools.run('write_document', { ...input(), path: 'old.docx' });
    expect(result).toMatchObject({ status: 'failed', documentWrite: { code: 'target-refused' } });
    expect(h.effects).toEqual([]); expect(h.state.decisions).toEqual([]);
  });
});

describe('D1 rendering is target-free and authority-bound across every wait', () => {
  it('joins the actual host queue: a worker reply cannot start approval or a write before observed exit', async () => {
    const h = await host({ ask: true });
    class Worker extends EventEmitter {
      posted: any;
      postMessage(value: unknown) { this.posted = value; }
      async terminate() { this.emit('exit', 1); return 1; }
    }
    const worker = new Worker();
    h.tools.setDocumentRenderer(new DocumentRenderer('/host/test-only-worker.cjs', () => worker));
    const pending = h.tools.run('write_document', input());
    await vi.waitFor(() => expect(worker.posted?.jobId).toEqual(expect.any(String)));
    expect(worker.posted).not.toHaveProperty('path');
    const rendered = await render(validateDocumentRequest(input()));
    worker.emit('message', { jobId: worker.posted.jobId, ok: true,
      bytes: Uint8Array.from(rendered.bytes).buffer, stats: rendered.stats });
    await Promise.resolve(); await Promise.resolve();
    expect(h.state.approvals).toEqual([]); expect(await fs.readdir(h.root)).toEqual([]);
    worker.emit('exit', 0);
    expect(await pending).toMatchObject({ status: 'success', documentWrite: { receipt: { sha256: sha(rendered.bytes) } } });
    expect(h.state.approvals).toHaveLength(1);
  });
  it.each(['invalid-input', 'extension-mismatch'] as const)('rejects %s before rendering or target creation', async mode => {
    const h = await host(); const args: any = input();
    if (mode === 'invalid-input') args.document.rawXml = '<w:document/>';
    if (mode === 'extension-mismatch') args.path = 'out/contract.txt';
    expect(await h.tools.run('write_document', args)).toMatchObject({ status: 'failed', documentWrite: { targetEffect: 'none' } });
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(await fs.readdir(h.root)).toEqual([]);
  });
  it.each(['out-of-memory', 'worker-exit', 'render-stop-unconfirmed'] as const)('leaves no target effect on %s', async code => {
    const h = await host(); h.renderer.render.mockRejectedValueOnce(new DocumentFailure(code));
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'failed', documentWrite: { code, stage: 'render', targetEffect: 'none' } });
    expect(await fs.readdir(h.root)).toEqual([]); expect(h.effects).toEqual([]);
  });
  it.each(['new-turn', 'request-changed', 'permission-revoked', 'retired', 'cancelled'] as const)('rejects %s during render', async change => {
    const h = await host(); const abort = new AbortController();
    h.renderer.render.mockImplementationOnce(async request => {
      expect(await fs.readdir(h.root)).toEqual([]);
      if (change === 'new-turn') h.tools.beginTurn();
      if (change === 'request-changed') h.state.request = 'r2';
      if (change === 'permission-revoked') h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [] });
      if (change === 'retired') h.tools.retire();
      if (change === 'cancelled') abort.abort();
      return render(request);
    });
    expect(await h.tools.run('write_document', input(), { signal: abort.signal })).toMatchObject({
      status: 'failed', documentWrite: { code: 'cancelled', targetEffect: 'none' },
    });
    expect(await fs.readdir(h.root)).toEqual([]); expect(h.effects).toEqual([]); expect(h.state.approvals).toEqual([]);
  });
  it.each(['new-turn', 'request-changed', 'permission-revoked', 'cancelled', 'target-changed'] as const)('rejects %s during approval', async change => {
    const abort = new AbortController();
    const h = await host({ ask: true, approve: async req => {
      expect(req.signal).toBe(abort.signal);
      if (change === 'new-turn') h.tools.beginTurn();
      if (change === 'request-changed') h.state.request = 'r2';
      if (change === 'permission-revoked') h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [] });
      if (change === 'cancelled') abort.abort();
      if (change === 'target-changed') { await fs.mkdir(path.join(h.root, 'out')); await fs.writeFile(path.join(h.root, input().path), 'someone else'); }
      return 'once';
    } });
    const result = await h.tools.run('write_document', input(), { signal: abort.signal });
    expect(result).toMatchObject({ status: 'failed', documentWrite: { targetEffect: 'none' } });
    expect(h.effects).toEqual([]); expect(h.text.list()).toEqual([]);
    const left = await fs.readFile(path.join(h.root, input().path), 'utf8').catch(() => undefined);
    expect(left).toBe(change === 'target-changed' ? 'someone else' : undefined);
  });
  it('rejects a stopped call that waited for the per-target lock before starting a checkpoint', async () => {
    const h = await host(); const abort = new AbortController();
    const writes = (h.tools as any).fileWrites;
    let entered!: () => void; let unlock!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const target = path.join(h.root, 'locked.docx'); await fs.writeFile(target, 'old');
    const holding = writes.serialize(target, async () => { entered(); await release; });
    await locked;
    const serializing = vi.spyOn(writes, 'serialize');
    const pending = h.tools.run('write_document', { ...input(), path: 'locked.docx' }, { signal: abort.signal });
    // Wait until the actual commit boundary has joined the held lock, not merely until render starts.
    await vi.waitFor(() => expect(serializing).toHaveBeenCalledOnce());
    abort.abort(); unlock(); await holding;
    expect(await pending).toMatchObject({ status: 'failed', documentWrite: { targetEffect: 'none' } });
    expect(await fs.readFile(target, 'utf8')).toBe('old'); expect(h.text.list()).toEqual([]);
  });
  it('computes Unicode layout warnings on the host and carries them in both receipt and tool text', async () => {
    const h = await host(); const args = input(); args.document.blocks[0].content[0].text = 'العقد \u202e';
    const result = await h.tools.run('write_document', args);
    expect(result).toMatchObject({ status: 'success', documentWrite: { receipt: { layoutWarnings: [{
      code: 'reader-layout-unverified', scripts: ['Arab'], reasons: ['format-control', 'script'],
    }] } } });
    expect(result.output).toContain(DOCUMENT_LAYOUT_WARNING_TEXT);
    // Caller/worker cannot supply an asserted layout qualification.
    expect(validateDocumentRequest(args).document.blocks[0]).toMatchObject({ content: [{ text: 'العقد \u202e' }] });
  });
  it('captures the request before a held request boundary, not when it eventually resumes', async () => {
    const h = await host();
    h.tools.setRequestBoundary(async () => { h.tools.beginTurn(); return 'proceed'; });
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'failed', documentWrite: { code: 'cancelled' } });
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(await fs.readdir(h.root)).toEqual([]);
  });
  it('does not revive an old approval after write authority is revoked then restored', async () => {
    const h = await host({ ask: true, approve: async () => {
      h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [] });
      h.tools.setTurnWorkspaceAccess(undefined);
      return 'once';
    } });
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'failed', documentWrite: { code: 'cancelled', targetEffect: 'none' } });
    expect(h.effects).toEqual([]); expect(await fs.readdir(h.root)).toEqual([]);
  });
  it('rechecks after the checkpoint await and preserves the original bytes when the turn changes', async () => {
    let changed = false;
    const h = await host({ duringCapture: () => { if (!changed) { changed = true; h.tools.beginTurn(); } } });
    const target = path.join(h.root, 'old.docx'); await fs.writeFile(target, 'original');
    expect(await h.tools.run('write_document', { ...input(), path: 'old.docx' })).toMatchObject({
      status: 'failed', documentWrite: { targetEffect: 'none' },
    });
    expect(await fs.readFile(target, 'utf8')).toBe('original'); expect(h.effects).toEqual([]);
  });
  it('settles an already committed file even when its call is cancelled during read-back', async () => {
    const abort = new AbortController();
    let advanceRequest = () => {};
    const h = await host({ readState: async physical => {
      const seen = await readTargetState(physical);
      if (seen.state.exists) { abort.abort(); advanceRequest(); }
      return seen;
    } });
    advanceRequest = () => { h.state.request = 'r2'; };
    const reported = vi.fn(); h.tools.setDocumentObserver(reported);
    const result = await h.tools.run('write_document', input(), { signal: abort.signal });
    expect(abort.signal.aborted).toBe(true);
    expect(reported).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'document-written', effect: 'created' }), 'r1');
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { effect: 'created' } } });
    const bytes = await fs.readFile(path.join(h.root, input().path));
    expect(h.effects).toHaveLength(1); expect(result.output).toContain(sha(bytes));
  });
  it('serializes the whole document call, captures queued input, and keeps each caller\'s own receipt', async () => {
    let approve!: () => void;
    const approval = new Promise<void>(resolve => { approve = resolve; });
    const h = await host({ ask: true, approve: async () => { await approval; return 'once'; } });
    const executing = vi.spyOn(h.tools as any, 'writeDocumentCurrent');
    const first = h.tools.run('write_document', input());
    await vi.waitFor(() => expect(h.state.approvals).toHaveLength(1));
    const secondInput = { ...input(), path: 'out/second.docx' };
    const second = h.tools.run('write_document', secondInput);
    secondInput.document.title = 'mutated after enqueue';
    // Observe the actual execution boundary synchronously: an incorrectly started second render can still
    // be in async path preflight here, so counting only renderer calls would miss a broken lane.
    const startsBeforeApproval = executing.mock.calls.length;
    approve();
    const [a, b] = await Promise.all([first, second]);
    expect(startsBeforeApproval).toBe(1);
    expect(a).toMatchObject({ status: 'success', documentWrite: { receipt: { path: input().path } } });
    expect(b).toMatchObject({ status: 'success', documentWrite: { receipt: { path: 'out/second.docx' } } });
    expect(h.renderer.render.mock.calls[1][0].document.title[0].text).toBe('Contract < & >');
    expect(h.effects.map(effect => effect.path)).toEqual([input().path, 'out/second.docx']);
  });
  // v0.9.99: routine load queues cooperatively. A fifth waiter is not refused as busy; Stop still removes waiters.
  it('queues host writes past the former four waiters, removes cancelled entries at once, and writes every live one', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = await host({ ask: true, approve: async () => { await hold; return 'once'; } });
    const first = h.tools.run('write_document', input());
    await vi.waitFor(() => expect(h.state.approvals).toHaveLength(1));
    const abort = new AbortController();
    const cancelled = Array.from({ length: 4 }, (_, i) => h.tools.run('write_document', { ...input(), path: `cancelled-${i}.docx` }, { signal: abort.signal }));
    const live = Array.from({ length: 6 }, (_, i) => h.tools.run('write_document', { ...input(), path: `queued-${i}.docx` }));
    const stopped = new AbortController(); stopped.abort();
    const notices: string[] = []; h.tools.setDocumentFallbackObserver(text => notices.push(text));
    expect(await h.tools.run('write_document', { ...input(), path: 'stopped.pdf', format: 'pdf' }, { signal: stopped.signal }))
      .toMatchObject({ documentWrite: { code: 'cancelled' } });
    expect(notices).toEqual([]);
    abort.abort();
    for (const result of await Promise.all(cancelled)) expect(result).toMatchObject({ documentWrite: { code: 'cancelled' } });
    release(); expect((await first).status).toBe('success');
    for (const result of await Promise.all(live)) expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(h.renderer.render).toHaveBeenCalledTimes(7);
    expect((await fs.readdir(h.root)).filter(name => name.startsWith('cancelled-'))).toEqual([]);
  });
  it('keeps a queued host write waiting past the former 30 s queue deadline and then writes it', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = await host({ ask: true, approve: async () => { await hold; return 'once'; } });
    const first = h.tools.run('write_document', input());
    await vi.waitFor(() => expect(h.state.approvals).toHaveLength(1));
    vi.useFakeTimers();
    let queued: ReturnType<typeof h.tools.run>;
    try {
      queued = h.tools.run('write_document', { ...input(), path: 'waited.docx' });
      let settled = false; void queued.finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).toBe(false); expect(h.renderer.render).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); release(); }
    await first;
    expect(await queued!).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { path: 'waited.docx' } } });
  });
  it('refuses an untrusted workspace before rendering or asking for document approval', async () => {
    const h = await host({ trusted: () => false });
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'refused', reason: 'trust' });
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(h.state.approvals).toEqual([]);
  });
  it('does not render without host wiring, write authority, trust or an unheld request boundary', async () => {
    const h = await host();
    const unwired = new WorkspaceTools(h.root, new Set(['write']));
    expect(h.tools.specs().some(spec => spec.function.name === 'write_document')).toBe(true);
    expect(unwired.specs().some(spec => spec.function.name === 'write_document')).toBe(false);
    expect(await unwired.run('write_document', input())).toMatchObject({ status: 'refused', documentWrite: { code: 'permission-refused' } });
    const readOnly = new WorkspaceTools(h.root, new Set(['read'])); readOnly.setDocumentRenderer(h.renderer);
    expect(await readOnly.run('write_document', input())).toMatchObject({ status: 'refused' });
    h.tools.setRequestBoundary(async () => 'stopped');
    expect(await h.tools.run('write_document', input())).toMatchObject({ status: 'refused', reason: 'safety-limit' });
    expect(h.renderer.render).not.toHaveBeenCalled();
    expect(isGovernedWorkspaceTool('write_document')).toBe(true);
    expect(requiresTrustedWorkspace('write_document')).toBe(true);
    expect(MAY_MUTATE_WORKSPACE_TOOLS).toContain('write_document');
  });
});
