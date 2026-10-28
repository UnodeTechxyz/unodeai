import { describe, expect, it } from 'vitest';
import { OpenAICompatBackend, FetchFn, StreamFetchFn } from '../OpenAICompatBackend';
import { BackendEvent } from '../AgentBackend';
import { AgentConfig } from '../../types';

/* v0.9.89 §9: exact per-response progress, attempt ordinals and what a Stop keeps. */

function config(): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read'],
    workingDirectory: process.cwd(),
  };
}

function scriptedFetch(bodies: unknown[]): FetchFn {
  let i = 0;
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]) });
}

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

function turn(backend: OpenAICompatBackend, instruction: string, onEvent?: (event: BackendEvent) => void): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  return new Promise((resolve) => {
    const off = backend.onEvent((event) => {
      events.push(event);
      onEvent?.(event);
      if (event.kind === 'turn_complete') { off(); resolve(events); }
    });
    backend.sendUserTurn(instruction);
  });
}

const toolCall = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
] } }] };

describe('OpenAI-compatible usage progress', () => {
  it('emits one exact progress per completed response, named by its request ordinal', async () => {
    const backend = new OpenAICompatBackend(config(), scriptedFetch([
      { ...toolCall, usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } },
      { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 150, completion_tokens: 5 } },
    ]), undefined, undefined, undefined, { retryBaseMs: 0 });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const events = await turn(backend, 'go');
    expect(events.filter((event) => event.kind === 'model_request')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'usage_progress')).toEqual([
      { kind: 'usage_progress', attempt: 1, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
      // This response reported no cache field, so none is claimed for it.
      { kind: 'usage_progress', attempt: 2, inputTokens: 150, outputTokens: 5 },
    ]);
    const done = events.find((event) => event.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(done.result.usage).toMatchObject({ inputTokens: 250, outputTokens: 15, usageBasis: 'reported', attributedAttempts: 2 });
  });

  it('never reports a reconstructed response as progress', async () => {
    const backend = new OpenAICompatBackend(config(), scriptedFetch([
      toolCall,
      { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 50_000, completion_tokens: 5 } },
    ]), undefined, undefined, undefined, { retryBaseMs: 0 });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const events = await turn(backend, 'go');
    // The first response carried no usage (reconstructed): only the second, reported one is progress.
    expect(events.filter((event) => event.kind === 'usage_progress').map((event) => (event as { attempt: number }).attempt)).toEqual([2]);
    const done = events.find((event) => event.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(done.result.usage?.usageBasis).toBe('reconstructed');
  });

  it('counts a streaming request as a provider attempt and reports its usage chunk as progress', async () => {
    const encoder = new TextEncoder();
    const streamFetchFn: StreamFetchFn = async () => ({
      ok: true, status: 200,
      body: (async function* () {
        yield encoder.encode(sse({ choices: [{ delta: { content: 'hi' } }] }));
        yield encoder.encode(sse({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 3 } }));
        yield encoder.encode('data: [DONE]\n\n');
      })(),
    });
    const backend = new OpenAICompatBackend(config(), scriptedFetch([]), undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const events = await turn(backend, 'go');
    expect(events.filter((event) => event.kind === 'model_request')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'usage_progress')).toEqual([
      { kind: 'usage_progress', attempt: 1, inputTokens: 17, outputTokens: 3 },
    ]);
  });

  function stoppedStream(chunks: string[]): StreamFetchFn {
    const encoder = new TextEncoder();
    return async (_url, init) => ({
      ok: true, status: 200,
      body: (async function* () {
        for (const chunk of chunks) yield encoder.encode(chunk);
        // Like a real fetch body, the pending read rejects once the request is aborted.
        await new Promise<void>((_resolve, reject) => {
          if (init.signal?.aborted) { reject(new Error('aborted')); return; }
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      })(),
    });
  }

  it('keeps a stopped response\'s usage chunk as partial, display-only usage', async () => {
    const backend = new OpenAICompatBackend(config(), scriptedFetch([]), undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0 }, undefined,
      stoppedStream([sse({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } } }), sse({ choices: [{ delta: { content: 'partial' } }] })]));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const events = await turn(backend, 'go', (event) => { if (event.kind === 'assistant_delta') backend.abort(); });
    const done = events.find((event) => event.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(done.result.usage).toMatchObject({ inputTokens: 23, outputTokens: 1, cachedInputTokens: 5, usageBasis: 'reported-partial', attributedAttempts: 0 });
    expect(events.some((event) => event.kind === 'usage_progress')).toBe(false);
  });

  it('reconstructs only the sent request and streamed output when a stopped response showed no usage', async () => {
    const backend = new OpenAICompatBackend(config(), scriptedFetch([]), undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0 }, undefined,
      stoppedStream([sse({ choices: [{ delta: { content: 'some streamed words' } }] })]));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const events = await turn(backend, 'go', (event) => { if (event.kind === 'assistant_delta') backend.abort(); });
    const done = events.find((event) => event.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(done.result.usage?.usageBasis).toBe('reconstructed');
    expect(done.result.usage?.inputTokens).toBeGreaterThan(0);
    expect(done.result.usage?.outputTokens).toBeGreaterThan(0);
  });
});
