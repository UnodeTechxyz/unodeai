import { beforeEach, describe, expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({ once: vi.fn(), on: vi.fn(), off: vi.fn(), postMessage: vi.fn(), close: vi.fn() }));
vi.mock('node:worker_threads', () => ({ parentPort: port }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

async function renderPdf(text: string, language = 'en', jobId = 'pdf-admission') {
  // Import the real worker entry and invoke its actual one-shot message handler; do not duplicate its error ordering.
  await import('../DocumentRenderWorker');
  expect(port.once).toHaveBeenCalledOnce();
  expect(port.once.mock.calls[0][0]).toBe('message');
  const onMessage = port.once.mock.calls[0][1] as (job: unknown) => Promise<void>;
  port.postMessage.mockImplementation(message => {
    if (message?.kind === 'font-read') {
      const listener = port.on.mock.calls.at(-1)![1];
      listener({ kind: 'font-data', jobId, requestId: message.requestId, sources: [] });
    }
  });
  await onMessage({ jobId, format: 'pdf', template: 'report-v1',
    document: { title: 'Proof', language, blocks: [{ type: 'paragraph', content: [{ text }] }] } });
  const replies = port.postMessage.mock.calls.filter(([value]) => value.ok !== undefined);
  expect(replies).toHaveLength(1);
  expect(port.close).toHaveBeenCalledOnce();
  return replies[0][0];
}

describe('PDF admission ordering at the real document worker boundary', () => {
  it.each(['\u1019\u103c\u1014\u103a\u1019\u102c', 'abc\u202e'])('reports unsupported layout before the closed font path for %j', async text => {
    expect(await renderPdf(text)).toEqual({ jobId: 'pdf-admission', ok: false, code: 'unsupported-text-layout' });
  });
  it.each(['\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac', '\u041a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430'])('admits simple LTR letters before asking for a font: %j', async text => {
    expect(await renderPdf(text)).toEqual({ jobId: 'pdf-admission', ok: false, code: 'font-unavailable' });
  });
  it('reports a missing Han region before the closed font path', async () => {
    expect(await renderPdf('\u5408\u540c', 'und')).toEqual({ jobId: 'pdf-admission', ok: false, code: 'document-language-required' });
  });
  it('reports font-unavailable when the host supplies no fonts rather than producing DOCX or bytes', async () => {
    expect(await renderPdf('English 123 / fran\u00e7ais')).toEqual({ jobId: 'pdf-admission', ok: false, code: 'font-unavailable' });
  });
  it('rejects invalid job identity before layout admission', async () => {
    expect(await renderPdf('\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac', 'en', '')).toEqual({ jobId: '', ok: false, code: 'invalid-input' });
  });
});
