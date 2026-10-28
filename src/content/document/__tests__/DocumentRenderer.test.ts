import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentRenderer, documentWorkerHeapMb } from '../DocumentRenderer';
import { validateDocumentRequest } from '../DocumentValidation';

const request = () => validateDocumentRequest({ schema_version: 1, path: 'proof.docx', format: 'docx', template: 'report-v1',
  document: { title: 'Proof', blocks: [{ type: 'paragraph', content: [{ text: 'body' }] }] } });
class FakeWorker extends EventEmitter {
  posted: any;
  autoExit = true;
  postMessage(value: unknown) { this.posted = value; }
  terminate = vi.fn(async () => { if (this.autoExit) this.emit('exit', 1); return 1; });
  reply(extra: Record<string, unknown> = {}) {
    this.emit('message', { jobId: this.posted.jobId, ok: true, bytes: Uint8Array.of(1, 2, 3).buffer,
      stats: { format: 'docx', template: 'report-v1', rendererRevision: 2, blocks: 1, headings: 0, clauses: 0, tables: 0,
        fontManifestDigest: 'a'.repeat(64) }, ...extra });
  }
}
const fixture = () => {
  const workers: FakeWorker[] = [];
  const renderer = new DocumentRenderer('/host/worker.cjs', () => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  return { renderer, workers };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bounded document render queue and observed worker exit', () => {
  it.each([0, 2, -1])('rejects out-of-order first font request %s at the production host boundary', async requestId => {
    const workers: FakeWorker[] = [];
    const renderer = new DocumentRenderer('/host/worker.cjs', () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      { forbiddenRoots: () => [], candidates: () => [] });
    const pdf = validateDocumentRequest({ ...request(), format: 'pdf', path: 'proof.pdf', document: { ...request().document, language: 'en' } });
    const pending = renderer.render(pdf, new AbortController().signal, () => true);
    const checked = pending.then(() => ({ code: 'unexpected-success' }), error => error);
    workers[0].emit('message', { kind: 'font-read', jobId: workers[0].posted.jobId, requestId, language: 'en', style: 'regular' });
    await vi.advanceTimersByTimeAsync(30_000); expect(await checked).toMatchObject({ code: 'font-resource-invalid' });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('passes no target path to the worker and waits for real exit before releasing the next slot', async () => {
    const { renderer, workers } = fixture(); const signal = new AbortController().signal;
    const first = renderer.render(request(), signal, () => true);
    const secondRequest = request(); const second = renderer.render(secondRequest, signal, () => true);
    secondRequest.document.title[0].text = 'mutated';
    expect(workers).toHaveLength(1); expect(workers[0].posted).not.toHaveProperty('path');
    let delivered = false; void first.then(() => { delivered = true; });
    workers[0].reply(); await Promise.resolve();
    expect(delivered).toBe(false); expect(workers).toHaveLength(1);
    workers[0].emit('exit', 0); await first; await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2); expect(workers[1].posted.document.title[0].text).toBe('Proof');
    workers[1].reply(); workers[1].emit('exit', 0); await second;
  });
  // v0.9.99: no render deadline. A slow render still finishes; Stop terminates it and waits for an observed exit.
  it('lets a slow render run past the former 30 s budget, and Stop still ends it after an observed exit', async () => {
    const { renderer, workers } = fixture();
    const slow = renderer.render(request(), new AbortController().signal, () => true);
    let settled = false; void slow.finally(() => { settled = true; }).catch(() => {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false); expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply(); workers[0].emit('exit', 0); await expect(slow).resolves.toHaveProperty('bytes');
    const abort = new AbortController(); const stopped = renderer.render(request(), abort.signal, () => true);
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(5 * 60_000);
    const checked = expect(stopped).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort(); await vi.advanceTimersByTimeAsync(0); await checked;
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
  it('reports an unconfirmed stop but starts a fresh worker for the next document without reloading', async () => {
    const { renderer, workers } = fixture(); const abort = new AbortController();
    const pending = renderer.render(request(), abort.signal, () => true); workers[0].autoExit = false;
    const checked = expect(pending).rejects.toMatchObject({ code: 'render-stop-unconfirmed' });
    abort.abort(); await vi.advanceTimersByTimeAsync(2000); await checked;
    await vi.advanceTimersByTimeAsync(0);
    const next = renderer.render(request(), new AbortController().signal, () => true);
    expect(workers).toHaveLength(2);
    workers[0].reply(); // A late reply belongs to the failed job, not the replacement.
    workers[1].reply(); workers[1].emit('exit', 0); await expect(next).resolves.toHaveProperty('bytes');
  });
  it('a valid message followed by a nonzero exit is not a successful render', async () => {
    const { renderer, workers } = fixture();
    const pending = renderer.render(request(), new AbortController().signal, () => true);
    workers[0].reply(); workers[0].emit('exit', 1);
    await expect(pending).rejects.toMatchObject({ code: 'worker-exit' });
  });
  it('removes queued cancellation immediately and refuses stale identities before spawning', async () => {
    const { renderer, workers } = fixture(); const signal = new AbortController().signal;
    const first = renderer.render(request(), signal, () => true);
    const abort = new AbortController(); const waiting = renderer.render(request(), abort.signal, () => true);
    abort.abort(); await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    await expect(renderer.render(request(), signal, () => false)).rejects.toMatchObject({ code: 'cancelled' });
    workers[0].reply(); workers[0].emit('exit', 0); await first;
    expect(workers).toHaveLength(1);
  });
  it('cancellation after the reply but before exit discards bytes instead of allowing a commit', async () => {
    const { renderer, workers } = fixture(); const abort = new AbortController();
    const pending = renderer.render(request(), abort.signal, () => true);
    workers[0].reply(); abort.abort(); workers[0].emit('exit', 0);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('rejects wrong job, forged stats, fabricated DOCX pages and duplicate replies', async () => {
    for (const extra of [{ jobId: 'other-job' }, { stats: { format: 'pdf' } },
      { stats: { format: 'docx', template: 'report-v1', blocks: 1, headings: 0, clauses: 0, tables: 0, rendererRevision: 2, fontManifestDigest: 'a'.repeat(64), pages: 99 } }]) {
      const { renderer, workers } = fixture();
      const pending = renderer.render(request(), new AbortController().signal, () => true);
      workers[0].reply(extra); workers[0].reply(); workers[0].emit('exit', 0);
      await expect(pending).rejects.toMatchObject({ code: 'worker-exit' });
    }
  });
  // v0.9.99: routine load queues cooperatively: no busy refusal at a fifth waiter and no queue deadline.
  it('queues six waiting jobs past the former limit of four and renders each in order, one worker at a time', async () => {
    const { renderer, workers } = fixture(); const signal = new AbortController().signal;
    const jobs = Array.from({ length: 7 }, () => renderer.render(request(), signal, () => true));
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < jobs.length; i++) {
      await vi.waitFor(() => expect(workers).toHaveLength(i + 1));
      workers[i].reply(); workers[i].emit('exit', 0);
      await expect(jobs[i]).resolves.toHaveProperty('bytes');
    }
    expect(workers).toHaveLength(7);
  });
  it('sizes the worker heap from the input and reports a worker that runs out of memory as out-of-memory', async () => {
    const limits: number[] = []; const workers: FakeWorker[] = [];
    const renderer = new DocumentRenderer('/host/worker.cjs', (_path, given) => { limits.push(given.maxOldGenerationSizeMb);
      const worker = new FakeWorker(); workers.push(worker); return worker; });
    const large = validateDocumentRequest({ ...request(), document: { ...request().document,
      blocks: [{ type: 'paragraph', content: [{ text: 'x'.repeat(8 * 1_048_576) }] }] } });
    const pending = renderer.render(large, new AbortController().signal, () => true);
    const checked = expect(pending).rejects.toMatchObject({ code: 'out-of-memory' });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    expect(limits[0]).toBe(documentWorkerHeapMb(large)); expect(limits[0]).toBeGreaterThan(256);
    workers[0].emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })); workers[0].emit('exit', 1);
    await checked;
    expect(documentWorkerHeapMb(request())).toBe(256);
    const pdf = validateDocumentRequest({ ...large, format: 'pdf', path: 'proof.pdf' });
    expect(documentWorkerHeapMb(pdf, 64 * 1024 ** 3)).toBeGreaterThan(documentWorkerHeapMb(large, 64 * 1024 ** 3));
    // The heap never asks for more than half of the machine's memory; beyond that a real out-of-memory is reported.
    expect(documentWorkerHeapMb(pdf, 4 * 1024 ** 3)).toBe(2048);
  });
});
