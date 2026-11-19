import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatBackend, type BackendNetworkOptions, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import { EgressConsentDeclinedError, type BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';

const config = (): AgentConfig => ({ id: 'dev', name: 'Dev', role: 'senior-dev', skill: '',
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', systemPrompt: '',
  workingDirectory: process.cwd(), allowedTools: ['read'], autoApprove: true });
const answer = { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 100, completion_tokens: 2 } };
const backends: OpenAICompatBackend[] = [];
afterEach(async () => { await Promise.all(backends.splice(0).map(backend => backend.stop())); vi.useRealTimers(); });
async function backend(fetch: FetchFn, net: BackendNetworkOptions, stream?: StreamFetchFn) {
  const instance = new OpenAICompatBackend(config(), fetch, undefined, undefined, undefined, { retryBaseMs: 0, ...net }, undefined, stream);
  backends.push(instance); await instance.start({ ROAM_API_KEY: 'PRIVATE_KEY' }); return instance;
}
function turn(instance: OpenAICompatBackend, observe?: (event: BackendEvent) => void) {
  const events: BackendEvent[] = [];
  const complete = new Promise<Extract<BackendEvent, { kind: 'turn_complete' }>>(resolve => {
    instance.onEvent(event => { events.push(event); observe?.(event); if (event.kind === 'turn_complete') resolve(event); });
  });
  instance.sendUserTurn('go');
  return { events, complete };
}

describe('one actual response budget across OpenAI transports', () => {
  it.each(['buffered-headers', 'buffered-body', 'stream-headers', 'stream-first-byte', 'stream-between-bytes'] as const)(
    '%s waits twenty minutes by default, then accepts the result without retry', async stage => {
      vi.useFakeTimers(); let release!: () => void; let sends = 0;
      const wait = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        release = resolve;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
      const encode = (content: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      const fetch: FetchFn = async (_url, init) => {
        sends++; if (stage === 'buffered-headers') await wait(init.signal);
        return { ok: true, status: 200, text: async () => {
          if (stage === 'buffered-body') await wait(init.signal);
          return JSON.stringify(answer);
        } };
      };
      const stream: StreamFetchFn = async (_url, init) => {
        sends++; if (stage === 'stream-headers') await wait(init.signal);
        return { ok: true, status: 200, body: (async function* () {
          if (stage === 'stream-between-bytes') yield encode('part ');
          if (stage !== 'stream-headers') await wait(init.signal);
          yield encode('done'); yield new TextEncoder().encode('data: [DONE]\n\n');
        })() };
      };
      const instance = await backend(fetch, {}, stage.startsWith('stream') ? stream : undefined);
      const running = turn(instance); await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(sends).toBe(1);
      expect(running.events.some(event => event.kind === 'turn_complete' || event.kind === 'response_retry')).toBe(false);
      release(); const result = await running.complete;
      expect(result.result.isError).toBe(false); expect(result.result.text).toMatch(/done$/);
      expect(sends).toBe(1);
    });

  it('does not impose the old post-tool progress timeout on a quiet default stream', async () => {
    vi.useFakeTimers(); let release!: () => void; let settled = false;
    const instance = await backend(vi.fn(), {}, async (_url, init) => ({ ok: true, status: 200, body: (async function* () {
      yield new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
      await new Promise<void>((resolve, reject) => {
        release = resolve; init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n');
    })() }));
    const pending = (instance as any).chatStream([], 0, true).then(
      (result: any) => { settled = true; return { result }; },
      (error: unknown) => { settled = true; return { error }; },
    );
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(1_200_000);
    expect(settled).toBe(false); release();
    expect((await pending).result.choices[0].message.content).toBe('done');
  });

  it.each(['stream', 'readable-stream', 'buffered'] as const)('Stop still ends a %s response whose read never settles', async transport => {
    vi.useFakeTimers(); let sends = 0;
    const wait = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
    const fetch: FetchFn = async (_url, init) => {
      sends++; return { ok: true, status: 200, text: () => wait(init.signal) };
    };
    const stream: StreamFetchFn = async (_url, _init) => {
      sends++; return { ok: true, status: 200, body: transport === 'readable-stream' ? new ReadableStream<Uint8Array>()
        : { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } };
    };
    const instance = await backend(fetch, {}, transport !== 'buffered' ? stream : undefined);
    const running = turn(instance); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_200_000); expect(sends).toBe(1);
    instance.abort(); expect((await running.complete).result.responseOutcome).toMatchObject({ kind: 'stopped' });
    expect(sends).toBe(1); expect(running.events.some(event => event.kind === 'response_retry')).toBe(false);
  });

  it.each([2, 3])('ordinary repair then fallback shares maxRetries=%i rather than resetting the JSON allowance', async maxRetries => {
    const sent: Array<{ kind: string; wire: string }> = [];
    let streamCalls = 0; let jsonCalls = 0;
    const instance = await backend(async (_url, init) => {
      sent.push({ kind: 'json', wire: init.body }); jsonCalls++;
      return { ok: jsonCalls > 1, status: jsonCalls === 1 ? 503 : 200, text: async () => JSON.stringify(answer) };
    }, { maxRetries }, async (_url, init) => {
      sent.push({ kind: 'stream', wire: init.body }); streamCalls++;
      if (streamCalls === 1) return { ok: false, status: 400, text: async () => 'parallel_tool_calls not supported' };
      throw new Error('Streaming is unavailable on this fixture');
    });
    const { events, complete } = turn(instance);
    const result = await complete;
    expect(sent.map(item => item.kind)).toEqual(maxRetries === 2 ? ['stream', 'stream', 'json'] : ['stream', 'stream', 'json', 'json']);
    expect(JSON.parse(sent[0].wire).parallel_tool_calls).toBe(false);
    expect(JSON.parse(sent[1].wire).parallel_tool_calls).toBeUndefined();
    expect(result.result.isError).toBe(maxRetries === 2);
    if (maxRetries === 3) expect(result.result.text).toBe('done');
    expect(events.filter(event => event.kind === 'model_request')).toHaveLength(maxRetries + 1);
    expect(events.filter(event => event.kind === 'request_composition').map(event => event.attempt)).toEqual(maxRetries === 2 ? [1, 2, 3] : [1, 2, 3, 4]);
  });

  it('maxRetries=0 permits neither a stream-to-JSON fallback nor an extra unchanged blank send', async () => {
    let jsonCalls = 0;
    const instance = await backend(async () => { jsonCalls++; return { ok: true, status: 200, text: async () => JSON.stringify(answer) }; },
      { maxRetries: 0 }, async () => { throw new Error('fixture stream failure'); });
    const stopped = await turn(instance).complete;
    expect(stopped.result.isError).toBe(true); expect(jsonCalls).toBe(0);
    const blank = await backend(async () => { jsonCalls++; return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }) }; }, { maxRetries: 0 });
    const empty = await turn(blank).complete;
    expect(jsonCalls).toBe(1);
    expect(empty.result.responseOutcome).toMatchObject({ kind: 'empty-reply', attempts: [{ attempt: 1 }] });
  });

  it.each(['json', 'stream'] as const)('%s does not retry, repair or loop when the host refuses before a network attempt', async transport => {
    let gates = 0;
    const fetch = vi.fn<FetchFn>(); const stream = vi.fn<StreamFetchFn>();
    const instance = await backend(fetch, { maxRetries: 3, onBeforeEgress: async () => {
      gates++;
      // Bounds the intentional mutant too: a missing pre-send guard fails the assertion, not the test runner.
      if (gates > 2) throw new EgressConsentDeclinedError('fixture-stop');
      throw new Error('PRIVATE_HOST_REFUSAL');
    } }, transport === 'stream' ? stream : undefined);
    const { events, complete } = turn(instance);
    expect((await complete).result.isError).toBe(true);
    expect(gates).toBe(1); expect(fetch).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(events.some(event => event.kind === 'model_request' || event.kind === 'request_composition')).toBe(false);
  });

  it('rechecks route authority after an awaited host gate and sends nothing under the stale route', async () => {
    let changed = false;
    const fetch = vi.fn<FetchFn>();
    const instance = await backend(fetch, { maxRetries: 2, assertResolvedRoute: () => { if (changed) throw new Error('PRIVATE_STALE_ROUTE'); },
      onBeforeEgress: async () => { changed = true; } });
    expect((await turn(instance).complete).result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an existing host consent wait does not consume the remaining provider time during fallback', async () => {
    vi.useFakeTimers();
    let gates = 0; let sends = 0;
    const instance = await backend(async () => { sends++; return { ok: true, status: 200, text: async () => JSON.stringify(answer) }; }, {
      maxRetries: 1, requestTotalTimeoutMs: 100, timeoutMs: 1000,
      onBeforeEgress: async () => { if (++gates === 2) vi.advanceTimersByTime(60_000); },
    }, async () => { sends++; vi.advanceTimersByTime(20); throw new Error('stream unsupported'); });
    const running = turn(instance);
    await vi.advanceTimersByTimeAsync(0);
    expect((await running.complete).result.isError).toBe(false);
    expect(gates).toBe(2); expect(sends).toBe(2);
  });

  it('Stop during retry backoff cancels the wait and permits no next egress', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const instance = await backend(async () => { calls++; throw new Error('fixture network failure'); }, { maxRetries: 3, retryBaseMs: 10_000 });
    let waiting = false;
    const running = turn(instance, event => { if (event.kind === 'log' && event.line.startsWith('retry ')) waiting = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toBe(true); expect(calls).toBe(1);
    instance.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((await running.complete).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(calls).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the actual stream body by the remaining response time, not a fresh full stream allowance', async () => {
    vi.useFakeTimers();
    let calls = 0; let aborted = false;
    const instance = await backend(vi.fn(), { maxRetries: 0, requestTotalTimeoutMs: 100,
      timeoutMs: 1000, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 10_000 }, async (_url, init) => {
      calls++; init.signal?.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200, body: (async function* () { await new Promise(() => undefined); yield Buffer.from('never'); })() };
    });
    let finished = false;
    const running = turn(instance, event => { if (event.kind === 'turn_complete') finished = true; });
    await vi.advanceTimersByTimeAsync(99); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(finished).toBe(true);
    expect((await running.complete).result.isError).toBe(true);
    expect(calls).toBe(1); expect(aborted).toBe(true);
  });

  it('headers plus body plus JSON fallback consume one real wall-clock ceiling', async () => {
    vi.useFakeTimers();
    const sends: string[] = [];
    const instance = await backend(async (_url, init) => {
      sends.push('json');
      return await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('fixture abort'))));
    }, { maxRetries: 3, requestTotalTimeoutMs: 100, timeoutMs: 1000, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 10_000 },
    async () => {
      sends.push('stream'); await new Promise(resolve => setTimeout(resolve, 40));
      return { ok: true, status: 200, body: (async function* () {
        // A protocol/body-format failure retains the ordinary JSON fallback. A source-typed socket
        // rejection now correctly resends the identical stream instead (covered in interrupted replay).
        await new Promise(resolve => setTimeout(resolve, 40)); throw new SyntaxError('fixture body format failure');
        yield Buffer.from('unreachable');
      })() };
    });
    let finished = false;
    const running = turn(instance, event => { if (event.kind === 'turn_complete') finished = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(sends).toEqual(['stream', 'json']); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(finished).toBe(true);
    expect((await running.complete).result).toMatchObject({ interruption: { kind: 'provider-timeout', retry: 'exhausted', attempts: 2 } });
    expect(running.events.some(event => event.kind === 'error' && event.message.includes('exceeding the 100ms total budget'))).toBe(true);
    expect(sends).toEqual(['stream', 'json']);
  });

  it('continuous stream activity cannot renew the shared response ceiling', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const instance = await backend(vi.fn(), { maxRetries: 3, requestTotalTimeoutMs: 100,
      timeoutMs: 1000, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 10_000 }, async (_url, init) => {
      init.signal?.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200, body: (async function* () {
        while (!init.signal?.aborted) {
          await new Promise(resolve => setTimeout(resolve, 10));
          yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' } }] })}\n\n`);
        }
      })() };
    });
    let finished = false;
    const running = turn(instance, event => { if (event.kind === 'turn_complete') finished = true; });
    await vi.advanceTimersByTimeAsync(99); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(finished).toBe(true);
    expect((await running.complete).result.isError).toBe(true);
    expect(aborted).toBe(true);
  });
});
