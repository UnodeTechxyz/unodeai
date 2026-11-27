import { afterEach, expect, it, vi } from 'vitest';
import { NativeRenderOperations } from '../NativeRenderOperations';
import type { NativeOfficeRenderJob, NativeOfficeRenderResult } from '../NativeOfficeRenderer';

afterEach(() => vi.useRealTimers());
const job = (renderer: 'word' | 'powerpoint' = 'powerpoint') => ({ source: Buffer.from('captured'), kind: renderer === 'word' ? 'docx' as const : 'pptx' as const,
  renderer, current: () => true, beforeStart: async () => {}, onPage: () => {} });
const result = (j: NativeOfficeRenderJob): NativeOfficeRenderResult => ({ operation_id: j.operation_id!, renderer: j.renderer, source_sha256: 'a'.repeat(64),
  state: j.signal.aborted ? 'outcome-unknown' : 'passed', application_export: j.signal.aborted ? 'unknown' : 'completed',
  document_closed: !j.signal.aborted, pages: [], staging_cleanup: 'not-removed', scope: 'Test transport only', ...(j.signal.aborted ? { helper_stop: 'stopped' as const } : {}) });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }

it('queues the same application across agent owners, while another application can run', async () => {
  const gate = deferred(); const calls: string[] = [];
  const render = vi.fn(async (j: NativeOfficeRenderJob) => { calls.push(j.operation_id!); if (calls.length === 1) await gate.promise; return result(j); });
  const a = new NativeRenderOperations({ render }); const b = new NativeRenderOperations({ render });
  const first = a.start(job()); const second = b.start(job()); const word = b.start(job('word'));
  expect(first.state).toBe('running'); expect(second.state).toBe('queued'); expect(calls).toHaveLength(2);
  await b.wait(word.operation_id); expect(calls).not.toContain(second.operation_id);
  gate.resolve(); await a.wait(first.operation_id); await b.wait(second.operation_id);
  expect(calls).toEqual([first.operation_id, word.operation_id, second.operation_id]);
  await a.dispose(); await b.dispose();
});

it('returns the same running operation after 120 seconds without stopping or rerendering', async () => {
  vi.useFakeTimers(); const gate = deferred(); let nativeJob!: NativeOfficeRenderJob;
  const render = vi.fn(async (j: NativeOfficeRenderJob) => { nativeJob = j; await gate.promise; return result(j); });
  const service = new NativeRenderOperations({ render }); const first = service.start(job());
  const wait = service.wait(first.operation_id); await vi.advanceTimersByTimeAsync(120_000);
  expect(await wait).toMatchObject({ operation_id: first.operation_id, state: 'running', stop_requested: false });
  expect(nativeJob.signal.aborted).toBe(false); expect(render).toHaveBeenCalledTimes(1);
  gate.resolve(); expect(await service.wait(first.operation_id)).toMatchObject({ state: 'finished', result: { state: 'passed' } });
  await service.dispose();
});

it('cancels a queued operation immediately without invoking the native runner', async () => {
  const gate = deferred(); const render = vi.fn(async (j: NativeOfficeRenderJob) => { await gate.promise; return result(j); });
  const service = new NativeRenderOperations({ render }); const first = service.start(job()); const queued = service.start(job());
  expect(service.stop(queued.operation_id)).toMatchObject({ state: 'cancelled', stop_requested: true });
  expect(await service.wait(queued.operation_id)).toMatchObject({ state: 'cancelled' }); expect(render).toHaveBeenCalledTimes(1);
  gate.resolve(); await service.wait(first.operation_id); await service.dispose(); expect(render).toHaveBeenCalledTimes(1);
});

it('separates a stopped waiter from an explicit operation Stop, and preserves unknown application outcome', async () => {
  const gate = deferred(); let nativeJob!: NativeOfficeRenderJob;
  const service = new NativeRenderOperations({ render: async j => { nativeJob = j; await gate.promise; return result(j); } });
  const first = service.start(job()); const waiter = new AbortController(); const waiting = service.wait(first.operation_id, waiter.signal);
  waiter.abort(); expect(await waiting).toMatchObject({ state: 'running', stop_requested: false }); expect(nativeJob.signal.aborted).toBe(false);
  service.stop(first.operation_id); expect(nativeJob.signal.aborted).toBe(true); gate.resolve();
  expect(await service.wait(first.operation_id)).toMatchObject({ state: 'finished', stop_requested: true, result: { state: 'outcome-unknown', application_export: 'unknown', helper_stop: 'stopped' } });
  await service.dispose();
});

it('captures input bytes, keeps trusted gate failure private and prevents cross-owner status access', async () => {
  const gate = deferred(); const refusal = { officeRenderGateOutcome: { output: 'Existing permission outcome' } }; let captured = '';
  const service = new NativeRenderOperations({ render: async j => { await gate.promise; captured = j.source.toString(); throw refusal; } });
  const input = job(); const first = service.start(input); input.source.fill(0); gate.resolve();
  expect(await service.wait(first.operation_id)).toMatchObject({ state: 'failed' }); expect(captured).toBe('captured');
  expect(service.failure(first.operation_id)).toBe(refusal); expect(JSON.stringify(service.inspect(first.operation_id))).not.toContain('Existing permission');
  const other = new NativeRenderOperations(); expect(other.inspect(first.operation_id)).toBeUndefined(); expect(other.stop(first.operation_id)).toBeUndefined();
  await service.dispose(); await other.dispose();
});
