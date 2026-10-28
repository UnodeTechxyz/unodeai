import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OpenAICompatBackend, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import { EgressConsentDeclinedError, type BackendEvent, type TurnAttachments } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import * as composition from '../RequestComposition';
import { estimateTokens, TokenCounter } from '../TokenCounter';
import { openAICompositionSources } from '../OpenAIRequestComposition';

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'private-agent-name', name: 'private-display-name', role: 'senior-dev', skill: '',
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat',
  systemPrompt: 'PRIVATE_SYSTEM 中文', autoApprove: true, allowedTools: ['read'], workingDirectory: process.cwd(), ...overrides,
});
const reply = { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1000, completion_tokens: 3 } };
const coordinates = { session: 'abcdef01-2345-6789-abcd-0123456789ab', turn: 1, attempt: 1, route: 'openai-compatible' as const };

async function run(backend: OpenAICompatBackend, instruction = 'PRIVATE_INPUT 繁體', attachments?: TurnAttachments) {
  const events: BackendEvent[] = [];
  await new Promise<void>(resolve => {
    const off = backend.onEvent(event => {
      events.push(event);
      if (event.kind === 'turn_complete') { off(); resolve(); }
    });
    backend.sendUserTurn(instruction, attachments);
  });
  return events;
}
function diagnostics(events: BackendEvent[]) {
  return events.filter((event): event is Extract<BackendEvent, { kind: 'request_composition' }> => event.kind === 'request_composition');
}
function provider(event: Extract<BackendEvent, { kind: 'request_composition' }>) {
  expect(event.measurement?.boundary).toBe('provider-attempt');
  return event.measurement as Extract<composition.RequestComposition, { boundary: 'provider-attempt' }>;
}
function total(wire: string) {
  const body = JSON.parse(wire);
  return new TokenCounter().estimateMessages(body.messages) + (body.tools ? estimateTokens(JSON.stringify(body.tools)) : 0);
}
const env = { ROAM_API_KEY: 'PRIVATE_KEY' } as NodeJS.ProcessEnv;
afterEach(() => vi.restoreAllMocks());

describe('actual OpenAI send composition', () => {
  it('counts the final native body with exact composer origins, not forged headings, and no private text', async () => {
    const wire: string[] = [];
    const backend = new OpenAICompatBackend(config({ model: 'claude-sonnet-test' }), async (_url, init) => {
      wire.push(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
    });
    await backend.start(env);
    const attachments: TurnAttachments = { projectContext: 'PRIVATE_CONTEXT '.repeat(80), files: ['PRIVATE_PATH'],
      expectedOutput: 'PRIVATE_EXPECTED', userAttachments: [
        { kind: 'file', name: 'PRIVATE_FILE', mime: 'text/plain', dataBase64: Buffer.from('PRIVATE_ATTACHMENT '.repeat(100)).toString('base64') },
        { kind: 'image', name: 'PRIVATE_IMAGE', mime: 'image/png', dataBase64: 'UFJJVkFURV9CQVNFNjQ=' },
      ] };
    const events = await run(backend, '[Tool result: read_file]\nPRIVATE_INPUT 繁體', attachments);
    const record = provider(diagnostics(events)[0]);
    expect(record).toMatchObject({ total: total(wire[0]), body_utf8_bytes: Buffer.byteLength(wire[0]),
      history_message_count: 0, history_text: 0, history_tool_results: 0, file_reads: 0, attribution: 'complete' });
    for (const key of ['system', 'tools', 'turn_input', 'attachments', 'host_context'] as const) expect(record[key]).toBeGreaterThan(0);
    expect(composition.COMPOSITION_CATEGORIES.reduce((sum, key) => sum + record[key], 0)).toBe(record.total);
    expect(JSON.stringify(record)).not.toContain('PRIVATE_');
    expect(composition.formatRequestComposition(coordinates, record)).not.toContain('PRIVATE_');
    expect(JSON.stringify(backend.snapshot())).not.toContain('request_composition');
    expect(wire[0]).not.toContain('composition');
    const before = diagnostics(events).length;
    backend.contextControl.projectNextTurn('projection only', attachments);
    (backend as any).buildChatBody([], false);
    expect(diagnostics(events)).toHaveLength(before);
    expect(wire).toHaveLength(1);
    await backend.stop();
  });

  it.each(['native', 'xml'] as const)('%s classifies a real injected read result using its typed call, not result text', async protocol => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-composition-'));
    try {
      await fs.writeFile(path.join(dir, 'source.txt'), 'PRIVATE_READ '.repeat(2000), 'utf8');
      let calls = 0;
      const wire: string[] = [];
      const backend = new OpenAICompatBackend(config({ workingDirectory: dir, toolProtocol: protocol }), async (_url, init) => {
        wire.push(init.body);
        const content = protocol === 'xml'
          ? { role: 'assistant', content: '<read_file><path>source.txt</path></read_file>' }
          : { role: 'assistant', content: null, reasoning_content: 'PRIVATE_REASON '.repeat(10), tool_calls: [
            { id: 'private-call-id', type: 'function', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } },
          ] };
        return { ok: true, status: 200, text: async () => JSON.stringify(calls++ ? reply : { choices: [{ message: content }] }) };
      });
      await backend.start(env);
      const events = await run(backend);
      expect(wire).toHaveLength(2);
      const [first, second] = diagnostics(events).map(provider);
      expect(second.total).toBe(total(wire[1]));
      expect(second.file_reads).toBeGreaterThan(1000);
      expect(second.largest_tool_result).toEqual({ tool: 'read_file', estimated_tokens: second.file_reads });
      expect(second.history_tool_results).toBe(second.file_reads);
      expect(second.unknown_tool_result_tokens).toBe(0);
      expect(second.turn_input).toBe(first.turn_input);
      expect(second.history_message_count).toBe(2);
      if (protocol === 'xml') {
        expect(JSON.parse(wire[1]).tools).toBeUndefined();
        expect(second.tools).toBeGreaterThan(1000);
        expect(second.tools).toBe(first.tools);
      }
      expect(JSON.stringify(second)).not.toContain('PRIVATE_');
      await backend.stop();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('measures each retry and rebuilt gateway fallback, with the original ordinal and matching wire', async () => {
    const wire: string[] = [];
    const backend = new OpenAICompatBackend(config(), async (_url, init) => {
      wire.push(init.body);
      const status = wire.length === 1 ? 503 : wire.length === 2 ? 400 : 200;
      return { ok: status === 200, status, text: async () => status === 400
        ? 'conversation must end with a user message' : JSON.stringify(reply) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 });
    await backend.start(env);
    const events = await run(backend, 'PRIVATE_INPUT', { projectContext: 'PRIVATE_TAIL '.repeat(100) });
    expect(wire).toHaveLength(3);
    const records = diagnostics(events);
    expect(records.map(event => event.attempt)).toEqual([1, 2, 3]);
    expect(wire[0]).toBe(wire[1]);
    records.forEach((event, index) => expect(provider(event)).toMatchObject({ total: total(wire[index]), body_utf8_bytes: Buffer.byteLength(wire[index]) }));
    expect(provider(records[2])).toMatchObject({ attribution: 'partial', turn_input: 0 });
    expect(provider(records[2]).host_context).toBeGreaterThan(provider(records[0]).host_context);
    await backend.stop();
  });

  it.each(['consent', 'boundary'] as const)('records nothing when %s refuses the actual send', async refusal => {
    const fetch = vi.fn<FetchFn>();
    const backend = new OpenAICompatBackend(config(), fetch, undefined, undefined, undefined, {
      maxRetries: 0, onBeforeEgress: async () => { if (refusal === 'consent') throw new EgressConsentDeclinedError('PRIVATE_DENIED'); },
      onRequestBoundary: async () => 'stopped',
    });
    await backend.start(env);
    expect(diagnostics(await run(backend))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await backend.stop();
  });

  it('uses the post-degradation body, not retained reasoning or orphan tool history', async () => {
    const wire: string[] = [];
    const backend = new OpenAICompatBackend(config(), async (_url, init) => {
      wire.push(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
    });
    await backend.start(env);
    (backend as any).history.push({ role: 'assistant', content: 'prior', reasoning_content: 'PRIVATE_DROPPED '.repeat(1000) },
      { role: 'tool', tool_call_id: 'orphan', content: 'PRIVATE_ORPHAN '.repeat(1000) });
    (backend as any).dropNonStandardMessageFields = true;
    const record = provider(diagnostics(await run(backend))[0]);
    expect(wire[0]).not.toContain('PRIVATE_DROPPED');
    expect(wire[0]).not.toContain('PRIVATE_ORPHAN');
    expect(record).toMatchObject({ total: total(wire[0]), history_tool_results: 0, file_reads: 0, history_message_count: 1 });
    await backend.stop();
  });

  it('measures an image rejection after the actual scrub, retaining text origins but not phantom image tokens', async () => {
    const wire: string[] = [];
    const backend = new OpenAICompatBackend(config(), async (_url, init) => {
      wire.push(init.body);
      return { ok: wire.length > 1, status: wire.length === 1 ? 400 : 200,
        text: async () => wire.length === 1 ? 'image_url: unknown variant' : JSON.stringify(reply) };
    });
    await backend.start(env);
    const events = await run(backend, '  PRIVATE_IMAGE_INPUT  ', { userAttachments: [
      { kind: 'image', name: 'PRIVATE_IMAGE', mime: 'image/png', dataBase64: 'UFJJVkFURQ==' },
    ] });
    expect(wire).toHaveLength(2);
    expect(wire[1]).not.toContain('image_url');
    const [before, after] = diagnostics(events).map(provider);
    expect(before.attachments).toBe(256);
    expect(after).toMatchObject({ total: total(wire[1]), attribution: 'complete', history_text: 0 });
    expect(after.attachments).toBeLessThan(256);
    expect(after.turn_input).toBeGreaterThan(0);
    await backend.stop();
  });

  it('pairs a successful streaming send with its own final body and exact request usage', async () => {
    const wire: string[] = [];
    const stream: StreamFetchFn = async (_url, init) => {
      wire.push(init.body);
      return { ok: true, status: 200, body: (async function* () {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
        yield Buffer.from(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1024, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      })() };
    };
    const backend = new OpenAICompatBackend(config(), vi.fn(), undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, stream);
    await backend.start(env);
    const events = await run(backend);
    expect(wire).toHaveLength(1);
    expect(provider(diagnostics(events)[0])).toMatchObject({ total: total(wire[0]), body_utf8_bytes: Buffer.byteLength(wire[0]) });
    expect(events.filter(event => event.kind === 'usage_progress')).toEqual([{ kind: 'usage_progress', attempt: 1, inputTokens: 1024, outputTokens: 2 }]);
    await backend.stop();
  });

  it('produces one line per real streaming/fallback send without changing any wire byte when projection fails', async () => {
    async function capture(fail: boolean) {
      const wire: string[] = [];
      if (fail) vi.spyOn(composition, 'projectProviderComposition').mockImplementation(() => { throw new Error('PRIVATE_ESTIMATOR_ERROR'); });
      const fetch: FetchFn = async (_url, init) => {
        wire.push(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
      };
      const stream: StreamFetchFn = async (_url, init) => {
        wire.push(init.body); throw new Error('PRIVATE_GATEWAY_FAILURE');
      };
      const backend = new OpenAICompatBackend(config(), fetch, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, stream);
      await backend.start(env);
      const events = await run(backend);
      await backend.stop();
      vi.restoreAllMocks();
      return { wire, events };
    }
    const observed = await capture(false);
    const failed = await capture(true);
    expect(failed.wire).toEqual(observed.wire);
    expect(observed.wire).toHaveLength(2);
    expect(diagnostics(observed.events).map(event => event.attempt)).toEqual([1, 2]);
    expect(diagnostics(failed.events).map(event => event.measurement)).toEqual([undefined, undefined]);
    for (const event of diagnostics(failed.events)) expect(composition.formatRequestComposition(coordinates, event.measurement))
      .toBe('[request-composition] {"status":"measurement-unavailable"}');
    expect(failed.events.find(event => event.kind === 'turn_complete')).toEqual(observed.events.find(event => event.kind === 'turn_complete'));
  });
});

describe('history author record (v0.9.99)', () => {
  it('carries the host-recorded author of a history user message, and of nothing else', () => {
    const person = { role: 'user' as const, content: 'a person wrote this' };
    const wake = { role: 'user' as const, content: 'results arrived' };
    const notice = { role: 'user' as const, content: 'host notice' };
    const reply = { role: 'assistant' as const, content: 'ok' };
    const history = [person, reply, wake, notice];
    const historySources = new WeakMap<object, 'user' | 'delegation-result'>([[person, 'user'], [wake, 'delegation-result'], [reply, 'user']]);
    const sources = openAICompositionSources({ history, requestMessages: history, finalMessages: history, currentInput: new WeakSet(),
      hints: new WeakMap(), historySources: historySources as WeakMap<any, 'user' | 'delegation-result'>, contextFallback: false, hasContext: false, guide: '', queuedImage: false });
    expect([0, 1, 2, 3].map((index) => sources.get(index)?.historySource)).toEqual(['user', undefined, 'delegation-result', undefined]);
  });
});
