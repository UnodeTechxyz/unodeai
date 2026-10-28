import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatBackend, toAsyncIterable, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import { classifyTurnInterruption } from '../TurnInterruption';
import { parseSseEvents } from '../sseParser';
import type { AgentConfig } from '../../types';

const context = { phase: 'unknown', retry: 'not-available' } as const;
const fact = (error: unknown) => classifyTurnInterruption(error, context);
const limits = { firstChunkMs: 100, idleMs: 100, totalMs: 1000, label: 'fixture' };
const instances: OpenAICompatBackend[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.stop())); vi.useRealTimers(); });
async function caught(operation: () => Promise<unknown>) {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Fixture must fail');
}
async function instance(fetch: FetchFn, stream?: StreamFetchFn) {
  const config: AgentConfig = { id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', systemPrompt: '', model: 'deepseek-chat',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, workingDirectory: process.cwd(), allowedTools: ['read'], autoApprove: true };
  const backend = new OpenAICompatBackend(config, fetch, undefined, undefined, undefined, { timeoutMs: 100, maxRetries: 0 }, undefined, stream);
  instances.push(backend); await backend.start({ ROAM_API_KEY: 'PRIVATE_KEY' }); return backend as any;
}

describe('actual OpenAI body readers own the transport observation', () => {
  it.each(['async', 'reader'] as const)('tags only the actual %s rejection and tears down the old reader', async branch => {
    const controller = new AbortController(); const error = new TypeError('terminated');
    const close = vi.fn(async () => ({ done: true, value: undefined }));
    const release = vi.fn();
    const body = branch === 'async' ? { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error), return: close }) }
      : { getReader: () => ({ read: () => Promise.reject(error), cancel: close, releaseLock: release }) };
    const observed = await caught(async () => { for await (const _ of toAsyncIterable(body as any, controller, limits)) { /* none */ } });
    expect(fact(error)?.kind).toBe('unknown');
    expect(fact(observed)).toMatchObject({ kind: 'connection-lost', phase: 'reading-response' });
    expect((observed as Error).cause).toBe(error); expect((observed as Error).message).toBe('terminated');
    expect(controller.signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
    if (branch === 'reader') expect(release).toHaveBeenCalledOnce();
  });

  it('also catches a synchronous iterator.next throw at the reader boundary', async () => {
    const body = { [Symbol.asyncIterator]: () => ({ next: () => { throw new TypeError('terminated'); } }) };
    const error = await caught(async () => { for await (const _ of toAsyncIterable(body, new AbortController(), limits)) { /* none */ } });
    expect(fact(error)?.kind).toBe('connection-lost');
  });

  it('never tags parser syntax failures as a disconnected socket, and closes the parser-abandoned body', async () => {
    const controller = new AbortController(); const close = vi.fn(async () => ({ done: true, value: undefined }));
    const body = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: Buffer.from('data: INVALID_JSON\n\n') }), return: close }) };
    const error = await caught(async () => { for await (const _ of parseSseEvents(toAsyncIterable(body, controller, limits))) { /* none */ } });
    expect(error).toBeInstanceOf(SyntaxError); expect(fact(error)?.kind).toBe('unknown');
    expect(controller.signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
  });

  it('the host body deadline wins over its secondary abort rejection and leaves no timer', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const close = vi.fn(async () => ({ done: true, value: undefined }));
    const body = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true });
    }), return: close }) };
    const result = caught(async () => { for await (const _ of toAsyncIterable(body, controller, limits)) { /* none */ } });
    await vi.advanceTimersByTimeAsync(100);
    expect(fact(await result)).toMatchObject({ kind: 'provider-timeout', phase: 'reading-response' });
    expect(close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not turn a user/host abort rejection into a trusted body-read observation', async () => {
    const controller = new AbortController();
    const body = { [Symbol.asyncIterator]: () => ({ next: async () => { controller.abort(); throw new TypeError('terminated'); } }) };
    const error = await caught(async () => { for await (const _ of toAsyncIterable(body, controller, limits)) { /* none */ } });
    expect(fact(error)?.kind).toBe('unknown');
  });

  it('tags JSON res.text rejection without tagging a pre-header bare TypeError', async () => {
    const backend = await instance(async () => ({ ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } }));
    expect(fact(await caught(() => backend.fetchOnce('https://fixture.invalid', '{}'))))
      .toMatchObject({ kind: 'connection-lost', phase: 'reading-response' });
    const before = await instance(async () => { throw new TypeError('terminated'); });
    expect(fact(await caught(() => before.fetchOnce('https://fixture.invalid', '{}')))?.kind).toBe('unknown');
  });

  it('the JSON body timeout keeps its actual phase and original timeout message', async () => {
    vi.useFakeTimers(); let signal: AbortSignal;
    const backend = await instance(async (_url, init) => { signal = init.signal!; return { ok: true, status: 200,
      text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true })) }; });
    const pending = caught(() => backend.fetchOnce('https://fixture.invalid', '{}'));
    await vi.advanceTimersByTimeAsync(100);
    const error = await pending;
    expect(fact(error)).toMatchObject({ kind: 'provider-timeout', phase: 'reading-response' });
    expect((error as Error).message).toContain('timed out after 100ms');
  });

  it('keeps HTTP errors typed while preserving the message used by existing request-shape repairs', async () => {
    const backend = await instance(vi.fn(), async () => ({ ok: false, status: 400, text: async () => 'parallel_tool_calls not supported' }));
    const error = await caught(() => backend.fetchStreamOnce('https://fixture.invalid', '{}'));
    expect(fact(error)).toMatchObject({ kind: 'provider-error', phase: 'before-response' });
    expect((error as Error).message).toContain('parallel_tool_calls not supported');
  });
});
