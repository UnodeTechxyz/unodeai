import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenAICompatBackend, type BackendNetworkOptions, type StreamFetchFn } from '../OpenAICompatBackend';
import { type BackendEvent, EgressConsentDeclinedError } from '../AgentBackend';
import type { AgentConfig } from '../../types';

const sse = (data: unknown) => Buffer.from(`data: ${JSON.stringify(data)}\n\n`);
const content = (text: string) => sse({ choices: [{ delta: { content: text } }] });
const usage = (input: number, output: number) => sse({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });
const done = Buffer.from('data: [DONE]\n\n');
const backends: OpenAICompatBackend[] = []; const directories: string[] = [];
afterEach(async () => { await Promise.all(backends.splice(0).map(backend => backend.stop()));
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });
async function backend(stream: StreamFetchFn, net: BackendNetworkOptions = {}, folder = process.cwd()) {
  const config: AgentConfig = { id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', systemPrompt: '', model: 'deepseek-chat',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, workingDirectory: folder, allowedTools: ['read', 'write'], autoApprove: true };
  const json = vi.fn(async () => { throw new Error('Unexpected JSON fallback'); });
  const instance = new OpenAICompatBackend(config, json, undefined, undefined, undefined, { maxRetries: 2, retryBaseMs: 0, ...net }, undefined, stream);
  backends.push(instance); await instance.start({ ROAM_API_KEY: 'PRIVATE_KEY' }); return { instance, json };
}
function turn(instance: OpenAICompatBackend, observe?: (event: BackendEvent) => void) {
  const events: BackendEvent[] = [];
  const complete = new Promise<Extract<BackendEvent, { kind: 'turn_complete' }>>(resolve => instance.onEvent(event => {
    events.push(event); observe?.(event); if (event.kind === 'turn_complete') resolve(event);
  }));
  instance.sendUserTurn('do the task'); return { events, complete };
}

describe('safe resend of only the interrupted OpenAI response', () => {
  it.each([false, true].flatMap(visible => [
    'event: error\ndata: {"message":"overloaded"}\n\n', 'event: error\n\n',
    'event: error', 'event: error\ndata: [DONE]\n\n',
    'data: {"type":"error","code":"overloaded"}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n',
    'data: {"error":[{"message":"overloaded"}]}\n\n',
  ].map(frame => ({ visible, frame }))))('fails closed without replay on real SSE metadata/error termination: %j', async ({ visible, frame }) => {
    let sends = 0;
    const { instance, json } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      if (visible) yield content('partial answer');
      // Split the event field as well as data; EOF-only and data-less events must remain errors.
      yield Buffer.from(frame.slice(0, 4)); yield Buffer.from(frame.slice(4));
    })() }; }, { maxRetries: 3 });
    const running = turn(instance); const result = (await running.complete).result;
    expect(result).toMatchObject({ isError: true, interruption: { kind: 'provider-error', attempts: 1 } });
    expect(result.responseOutcome?.kind).not.toBe('reply'); expect(result.responseOutcome?.kind).not.toBe('empty-reply');
    expect(sends).toBe(1); expect(json).not.toHaveBeenCalled();
    expect(running.events.filter(event => event.kind === 'turn_complete')).toHaveLength(1);
    expect(running.events.some(event => event.kind === 'response_retry')).toBe(false);
  });
  it.each([false, true])('a structured SSE provider error (visible=%s) is not an empty response, transport retry or JSON fallback', async visible => {
    let sends = 0;
    const { instance, json } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      if (visible) yield content('partial');
      yield usage(10, 2);
      yield sse({ error: { message: 'PRIVATE_PROVIDER_ERROR PRIVATE_KEY api_key=OTHER_SECRET', code: 'UND_ERR_BODY_TIMEOUT', name: 'TimeoutError' } });
      yield done;
    })() }; }, { maxRetries: 3 });
    const { events, complete } = turn(instance); const result = (await complete).result;
    expect(result.isError).toBe(true);
    expect(result.interruption).toMatchObject({ kind: 'provider-error', phase: 'reading-response', retry: 'not-retryable', attempts: 1 });
    expect(result.text).not.toContain('PRIVATE_');
    expect(result.interruptionDetail?.message).toBe('PRIVATE_PROVIDER_ERROR [redacted credential] api_key=[redacted]');
    expect(result.interruptionDetail?.code).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, usageBasis: 'reported-partial', attributedAttempts: 0 });
    expect(sends).toBe(1); expect(json).not.toHaveBeenCalled();
    expect(events.some(event => event.kind === 'response_retry' || event.kind === 'tool_use' || event.kind === 'usage_progress')).toBe(false);
    expect(events.filter(event => event.kind === 'turn_complete')).toHaveLength(1);
    expect(JSON.stringify(instance.snapshot())).not.toContain('PRIVATE_PROVIDER_ERROR');
  });

  it.each([{ error: 'PRIVATE_PROVIDER_ERROR' }, { type: 'error', message: 'PRIVATE_PROVIDER_ERROR' }, { error: { code: 'PRIVATE_CODE' } }])(
    'recognises the explicit provider error-frame shape %j without promoting arbitrary codes', async frame => {
    let sends = 0;
    const { instance, json } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield sse(frame); yield done;
    })() }; });
    const result = (await turn(instance).complete).result;
    expect(result).toMatchObject({ isError: true, interruption: { kind: 'provider-error', phase: 'reading-response', attempts: 1 } });
    expect(result.text).not.toContain('PRIVATE_'); expect(result.interruptionDetail?.code).toBeUndefined();
    expect(sends).toBe(1); expect(json).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('an absent/null error field %j on an ordinary SSE chunk does not manufacture an interruption', async error => {
    const { instance, json } = await backend(async () => ({ ok: true, status: 200, body: (async function* () {
      yield sse({ choices: [{ delta: { content: 'normal reply' } }], metadata: [], error }); yield usage(10, 2); yield done;
    })() }));
    const result = (await turn(instance).complete).result;
    expect(result).toMatchObject({ text: 'normal reply', isError: false }); expect(result.interruption).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('preserves a visible fragment, sends byte-identical admitted input, and accounts reported partial usage only once', async () => {
    const wires: string[] = []; const signals: AbortSignal[] = [];
    const { instance, json } = await backend(async (_url, init) => {
      wires.push(init.body); signals.push(init.signal!);
      const first = wires.length === 1;
      if (!first) expect(signals[0].aborted).toBe(true);
      return { ok: true, status: 200, body: (async function* () {
        yield content(first ? 'abandoned fragment' : 'final answer'); yield usage(first ? 10 : 20, first ? 2 : 3);
        if (first) { instance.interject('PRIVATE_NEW_INSTRUCTION'); throw new TypeError('terminated'); }
        yield done;
      })() };
    });
    // A later host-context snapshot must not be recomposed into this already admitted response's resend.
    let contextRevision = 0;
    vi.spyOn(instance as any, 'requestContext').mockImplementation(() => `HOST_CONTEXT_REVISION_${++contextRevision}`);
    const { events, complete } = turn(instance);
    const result = (await complete).result;
    // The interjection is applied only at the next model response. Give that response its normal answer too.
    expect(wires[1]).toBe(wires[0]); expect(wires[1]).not.toContain('PRIVATE_NEW_INSTRUCTION');
    expect(wires[0]).toContain('HOST_CONTEXT_REVISION_1'); expect(wires[2]).toContain('HOST_CONTEXT_REVISION_2');
    expect(result.isError).toBe(false); expect(result.text).toBe('final answer');
    expect(events.filter(event => event.kind === 'response_retry')).toEqual([
      { kind: 'response_retry', retry: { previousAttempt: 1, attempt: 2, reason: 'connection-lost' } },
    ]);
    expect(events.filter(event => event.kind === 'turn_complete')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'usage_progress').map(event => event.attempt)).toEqual([2, 3]);
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 8, usageBasis: 'reported-partial', attributedAttempts: 2 });
    expect(json).not.toHaveBeenCalled();
    const saved = JSON.stringify(instance.snapshot());
    expect(saved).not.toContain('abandoned fragment'); expect(saved).toContain('final answer');
    expect(saved).toContain('PRIVATE_NEW_INSTRUCTION');
  });

  it('does not re-execute a tool from an earlier complete response, and drops interrupted orphan tool JSON', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-itr-')); directories.push(folder);
    await fs.writeFile(path.join(folder, 'input.txt'), 'read me');
    const wires: string[] = []; let calls = 0;
    const { instance } = await backend(async (_url, init) => {
      wires.push(init.body); const call = ++calls;
      return { ok: true, status: 200, body: (async function* () {
        if (call === 1) yield sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) } }] } }] });
        else if (call === 2) {
          yield content('half reply');
          yield sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'orphan', type: 'function', function: { name: 'write_file', arguments: '{"path":"bad.txt","content":' } }] } }] });
          throw new TypeError('terminated');
        } else yield content('finished from the existing read result');
        yield usage(20, 3); yield done;
      })() };
    }, {}, folder);
    const { events, complete } = turn(instance); expect((await complete).result.isError).toBe(false);
    expect(calls).toBe(3); expect(wires[2]).toBe(wires[1]);
    expect(events.filter(event => event.kind === 'tool_use').map(event => event.name)).toEqual(['read_file']);
    expect(events.filter(event => event.kind === 'tool_result')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'response_retry')).toEqual([
      { kind: 'response_retry', retry: { previousAttempt: 2, attempt: 3, reason: 'connection-lost' } },
    ]);
    await expect(fs.stat(path.join(folder, 'bad.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(instance.snapshot())).not.toContain('orphan');
  });

  it('caps repeated interrupted responses at the one existing retry allowance and retains actual partial usage on failure', async () => {
    let sends = 0;
    const { instance, json } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield content('partial'); yield usage(10, 2);
      // Bound the fresh-budget mutant too; a third request fails assertions rather than hanging a runner.
      if (sends > 2) throw new SyntaxError('fixture retry sentinel');
      throw new TypeError('terminated');
    })() }; }, { maxRetries: 1 });
    const { events, complete } = turn(instance); const result = (await complete).result;
    expect(sends).toBe(2); expect(result.isError).toBe(true); expect(json).not.toHaveBeenCalled();
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, usageBasis: 'reported-partial', attributedAttempts: 0 });
    expect(events.filter(event => event.kind === 'response_retry')).toHaveLength(1);
    expect(events.some(event => event.kind === 'usage_progress')).toBe(false);
    expect(events.filter(event => event.kind === 'turn_complete')).toHaveLength(1);
    expect(JSON.stringify(instance.snapshot())).not.toContain('partial');
  });

  it('keeps actual source diagnostics separate, masking the resolved credential without adding them to conversation history', async () => {
    const { instance } = await backend(async () => ({ ok: true, status: 200, body: (async function* () {
      yield content('partial'); throw new Error('PRIVATE_DIAGNOSTIC credential PRIVATE_KEY api_key=OTHER_SECRET');
    })() }), { maxRetries: 0 });
    const running = turn(instance); const result = (await running.complete).result;
    expect(result.interruptionDetail?.message).toBe('PRIVATE_DIAGNOSTIC credential [redacted credential] api_key=[redacted]');
    expect(result.text).not.toContain('PRIVATE_DIAGNOSTIC');
    expect(JSON.stringify(instance.snapshot())).not.toMatch(/PRIVATE_DIAGNOSTIC|OTHER_SECRET/);
    expect(JSON.stringify(running.events.filter(event => event.kind === 'error'))).not.toMatch(/PRIVATE_KEY|OTHER_SECRET/);
  });

  it('a hostile diagnostic accessor cannot throw out of the actual failed-response terminal path', async () => {
    const error = Object.defineProperty(new Error('PRIVATE_MESSAGE'), 'message', { get() { throw new Error('PRIVATE_GETTER'); } });
    const { instance } = await backend(async () => { throw error; }, { maxRetries: 0 });
    const result = (await turn(instance).complete).result;
    expect(result.isError).toBe(true); expect(result.interruption?.kind).toBe('unknown');
    expect(result.text).not.toContain('PRIVATE_'); expect(result.interruptionDetail?.message).toBeUndefined();
  });

  it('does not turn an unknown/parser failure after visible output into an automatic replay', async () => {
    let sends = 0;
    const { instance, json } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield content('partial'); yield Buffer.from('data: INVALID_JSON\n\n');
    })() }; });
    const { events, complete } = turn(instance); expect((await complete).result.isError).toBe(true);
    expect(sends).toBe(1); expect(json).not.toHaveBeenCalled(); expect(events.some(event => event.kind === 'response_retry')).toBe(false);
  });

  it('a host refusal at the next boundary makes no resend and emits no false retried marker', async () => {
    let gates = 0; let sends = 0;
    const { instance } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield content('partial'); yield usage(10, 2); throw new TypeError('terminated');
    })() }; }, { onBeforeEgress: async () => { if (++gates > 1) throw new EgressConsentDeclinedError('fixture'); } });
    const { events, complete } = turn(instance); const result = (await complete).result;
    expect(result.isError).toBe(true); expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, usageBasis: 'reported-partial' });
    expect(sends).toBe(1); expect(gates).toBe(2); expect(events.some(event => event.kind === 'response_retry')).toBe(false);
  });

  it('rechecks route authority after the next awaited gate before resending frozen input', async () => {
    let gates = 0; let sends = 0; let stale = false;
    const { instance } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield content('partial'); throw new TypeError('terminated');
    })() }; }, { onBeforeEgress: async () => { if (++gates === 2) stale = true; },
      assertResolvedRoute: () => { if (stale) throw new Error('PRIVATE_CHANGED_ROUTE'); } });
    const { events, complete } = turn(instance); expect((await complete).result.isError).toBe(true);
    expect(sends).toBe(1); expect(gates).toBe(2); expect(events.some(event => event.kind === 'response_retry')).toBe(false);
  });

  it('stream idle retries consume the same total time instead of renewing it for each partial reply', async () => {
    vi.useFakeTimers(); let sends = 0; const aborted: boolean[] = [];
    const { instance } = await backend(async (_url, init) => {
      const index = sends++; aborted[index] = false;
      init.signal?.addEventListener('abort', () => { aborted[index] = true; });
      return { ok: true, status: 200, body: (async function* () { yield content('partial'); await new Promise(() => {}); })() };
    }, { maxRetries: 3, streamIdleTimeoutMs: 20, requestTotalTimeoutMs: 60 });
    const running = turn(instance); await vi.advanceTimersByTimeAsync(59);
    expect(sends).toBe(3); expect(running.events.some(event => event.kind === 'turn_complete')).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await running.complete).result.isError).toBe(true);
    expect(sends).toBe(3); expect(aborted).toEqual([true, true, true]);
    expect(running.events.filter(event => event.kind === 'response_retry')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart the host post-tool progress guard across transient retries or send after it expired in backoff', async () => {
    vi.useFakeTimers(); let sends = 0;
    const { instance } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield sse({ choices: [{ delta: { reasoning_content: 'hidden only' } }] });
      await new Promise(resolve => setTimeout(resolve, 10)); throw new TypeError('terminated');
    })() }; }, { postToolProgressTimeoutMs: 25, retryBaseMs: 30 });
    const error = (instance as any).chatStream([], 0, true).catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(40);
    expect((await error).message).toContain('stopped producing after a tool result');
    expect(sends).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('Stop cancels transient backoff immediately without another send or resetting provider silence', async () => {
    vi.useFakeTimers(); let sends = 0;
    const { instance } = await backend(async () => { sends++; return { ok: true, status: 200, body: (async function* () {
      yield content('partial'); throw new TypeError('terminated');
    })() }; }, { retryBaseMs: 10_000 });
    const running = turn(instance); await vi.advanceTimersByTimeAsync(0);
    expect(sends).toBe(1); const activity = running.events.filter(event => event.kind === 'provider_activity').length;
    instance.abort(); await vi.advanceTimersByTimeAsync(0);
    expect((await running.complete).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(sends).toBe(1); expect(running.events.filter(event => event.kind === 'provider_activity')).toHaveLength(activity);
    expect(running.events.some(event => event.kind === 'response_retry')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
