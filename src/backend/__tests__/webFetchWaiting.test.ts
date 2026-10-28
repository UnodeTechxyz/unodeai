import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types';
import type { BackendEvent } from '../AgentBackend';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { WEB_FETCH_STOPPED_ERROR, webFetch } from '../webFetch';
import { WorkspaceTools } from '../WorkspaceTools';

// v0.9.99: fetch_url has no deadline of its own. A slow page completes, the turn's Stop ends a fetch at once, and the
// public-only checks still refuse a private address. Synthetic responses only; no network.

function tools(): WorkspaceTools {
  return new WorkspaceTools(process.cwd(), new Set(['read']), 'agent-web');
}

/** A global fetch that answers after `delayMs` (or never), and rejects as soon as its signal aborts. */
function slowWeb(delayMs: number | undefined, body = 'slow page text') {
  const signals: AbortSignal[] = [];
  const web = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (delayMs !== undefined) {
      setTimeout(() => resolve(new Response(body, { headers: { 'content-type': 'text/plain' } })), delayMs);
    }
  }));
  return { web, signals };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('v0.9.99 fetch_url waits for a slow page and stops on Stop', () => {
  it('a page that takes 30 seconds arrives whole through the real tool', async () => {
    vi.useFakeTimers();
    const { web } = slowWeb(30_000);
    vi.stubGlobal('fetch', web);
    const pending = tools().run('fetch_url', { url: 'https://93.184.216.34/slow' });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.status).toBe('success');
    expect(result.output).toBe('slow page text');
    expect(web).toHaveBeenCalledTimes(1);
  });

  it("the tool's Stop signal ends a fetch that would otherwise keep waiting", async () => {
    vi.useFakeTimers();
    const { web, signals } = slowWeb(undefined);
    vi.stubGlobal('fetch', web);
    const stop = new AbortController();
    let settled = false;
    const pending = tools().run('fetch_url', { url: 'https://93.184.216.34/never' }, { signal: stop.signal })
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    stop.abort();
    const result = await pending;
    expect(result.output).toBe(WEB_FETCH_STOPPED_ERROR);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('Stop on the OpenAI-compatible turn ends a fetch in flight', async () => {
    const { web, signals } = slowWeb(undefined);
    vi.stubGlobal('fetch', web);
    let step = 0;
    const fetchFn: FetchFn = async () => {
      const message = step++ === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'fetch_url', arguments: '{"url":"https://93.184.216.34/never"}' } }] }
        : { role: 'assistant', content: 'done' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    };
    const config: AgentConfig = {
      id: 'agent-web', name: 'Worker', role: 'senior-dev', skill: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat',
      systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read'], workingDirectory: process.cwd(),
    };
    const backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events: BackendEvent[] = [];
    const done = new Promise<void>((resolve) => backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'tool_use' && event.name === 'fetch_url') setTimeout(() => backend.abort(), 20);
      if (event.kind === 'turn_complete') resolve();
    }));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('read the page');
    await done;
    expect(web).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(events.find((event) => event.kind === 'tool_result' && event.name === 'fetch_url')).toBeDefined();
  });

  describe('Stop while the address is still being looked up', () => {
    const pause = (ms: number) => new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms));

    /** A resolver whose answer the test gives, or never gives. */
    function heldResolver() {
      let answer!: (ips: string[]) => void;
      let fail!: (error: Error) => void;
      const lookups: string[] = [];
      const resolve = vi.fn((hostname: string) => {
        lookups.push(hostname);
        return new Promise<string[]>((ok, ko) => { answer = ok; fail = ko; });
      });
      return { resolve, lookups, answer: (ips: string[]) => answer(ips), fail: (error: Error) => fail(error) };
    }

    it('a lookup that never answers: Stop ends the fetch at once, and no request is sent', async () => {
      const { web } = slowWeb(0);
      vi.stubGlobal('fetch', web);
      const dns = heldResolver();
      const stop = new AbortController();
      const request = webFetch('https://example.com/never', { signal: stop.signal, resolve: dns.resolve });
      await Promise.resolve();
      expect(dns.lookups).toEqual(['example.com']);
      stop.abort();
      expect(await Promise.race([request, pause(30)])).toBe(WEB_FETCH_STOPPED_ERROR);
      expect(web).not.toHaveBeenCalled();
    });

    it('a lookup that answers after Stop starts no request, public or private', async () => {
      const { web } = slowWeb(0);
      vi.stubGlobal('fetch', web);
      for (const late of [['93.184.216.34'], ['10.0.0.5']]) {
        const dns = heldResolver();
        const stop = new AbortController();
        const request = webFetch('https://example.com/late', { signal: stop.signal, resolve: dns.resolve });
        await Promise.resolve();
        stop.abort();
        expect(await Promise.race([request, pause(30)])).toBe(WEB_FETCH_STOPPED_ERROR);
        dns.answer(late);
        await pause(10);
      }
      expect(web).not.toHaveBeenCalled();
    });

    it('a lookup that fails after Stop is consumed: no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { web } = slowWeb(0);
        vi.stubGlobal('fetch', web);
        const dns = heldResolver();
        const stop = new AbortController();
        const request = webFetch('https://example.com/fails', { signal: stop.signal, resolve: dns.resolve });
        await Promise.resolve();
        stop.abort();
        expect(await Promise.race([request, pause(30)])).toBe(WEB_FETCH_STOPPED_ERROR);
        dns.fail(new Error('ENOTFOUND example.com'));
        await pause(20);
        expect(unhandled).toEqual([]);
        expect(web).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('a fetch already stopped looks nothing up and sends nothing', async () => {
      const { web } = slowWeb(0);
      vi.stubGlobal('fetch', web);
      const dns = heldResolver();
      const stop = new AbortController();
      stop.abort();
      expect(await Promise.race([webFetch('https://example.com/stopped', { signal: stop.signal, resolve: dns.resolve }), pause(30)]))
        .toBe(WEB_FETCH_STOPPED_ERROR);
      expect(dns.resolve).not.toHaveBeenCalled();
      expect(web).not.toHaveBeenCalled();
    });

    it("Stop during a redirect target's lookup ends the fetch at once, and the target is not requested", async () => {
      const web = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://next.example/page' } }));
      vi.stubGlobal('fetch', web);
      let answerNext: ((ips: string[]) => void) | undefined;
      const resolve = vi.fn((hostname: string) => hostname === 'next.example'
        ? new Promise<string[]>((ok) => { answerNext = ok; })
        : Promise.resolve(['93.184.216.34']));
      const stop = new AbortController();
      const request = webFetch('https://first.example/start', { signal: stop.signal, resolve });
      for (let wait = 0; wait < 50 && !answerNext; wait++) await pause(1);
      expect(resolve.mock.calls.map(([hostname]) => hostname)).toEqual(['first.example', 'next.example']);
      stop.abort();
      expect(await Promise.race([request, pause(30)])).toBe(WEB_FETCH_STOPPED_ERROR);
      answerNext!(['93.184.216.34']);
      await pause(10);
      expect(web).toHaveBeenCalledTimes(1);
    });

    it('without Stop, the lookup is still checked: a private answer is refused before any request', async () => {
      const { web } = slowWeb(0);
      vi.stubGlobal('fetch', web);
      const dns = heldResolver();
      const stop = new AbortController();
      const request = webFetch('https://example.com/inside', { signal: stop.signal, resolve: dns.resolve });
      await Promise.resolve();
      dns.answer(['10.0.0.5']);
      expect(await request).toBe('Error: URL not allowed - resolves to a private network');
      expect(web).not.toHaveBeenCalled();
    });
  });

  it('a private address is still refused before any request', async () => {
    vi.useFakeTimers();
    const { web } = slowWeb(30_000);
    vi.stubGlobal('fetch', web);
    const loopback = await tools().run('fetch_url', { url: 'http://127.0.0.1:8080/admin' });
    const metadata = await tools().run('fetch_url', { url: 'http://169.254.169.254/latest/meta-data' });
    expect(loopback.output).toBe('Error: URL not allowed - private network');
    expect(metadata.output).toBe('Error: URL not allowed - private network');
    expect(web).not.toHaveBeenCalled();
  });
});
