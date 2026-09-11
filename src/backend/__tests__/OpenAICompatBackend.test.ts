import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChatMessage, OpenAICompatBackend, FetchFn, StreamFetchFn, sanitizeToolCallPairing, normalizeEmptyContent, splitParallelToolCalls, toolPairingTrace, composeUserContent, isImageRejectionError, stripImageBlocks, flattenToolHistory, enforceUsageInvariants } from '../OpenAICompatBackend';
import { AgentConfig } from '../../types';
import { TokenCounter } from '../TokenCounter';
import { MIN_OBSERVED_CONTEXT_BOUND_TOKENS } from '../../contextWindowDefaults';
import { BackendEvent } from '../AgentBackend';
import { MCPHub } from '../../mcp/MCPHub';
import { TeamTools } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { TurnAttachments } from '../AgentBackend';
import { TaskClaimRegistry } from '../TaskClaimRegistry';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { validateTeamFile } from '../../state/TeamFileSchema';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';
import { DECLARED_PROTOCOL_LEAK_MODEL_HINTS } from '../../capabilities/CapabilityProfile';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { MediaCapabilityCache } from '../../media/MediaCapability';
import { HostExecutionHooks } from '../ExecutionHooks';
import { TaskInputResolver } from '../TaskContract';

describe('OpenAI-compatible execution hook points', () => {
  it('fires PreTool, PostWrite, on-failure, and EndTurn through the live host source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-openai-hooks-'));
    const fired: string[] = [];
    const declaration = (id: string, point: 'PreTool' | 'PostWrite' | 'EndTurn' | 'on-failure') => ({
      id, point, appliedBy: 'human' as const, timeoutMs: 100, maxOutputBytes: 100, onFailure: 'block' as const,
    });
    const hooks = new HostExecutionHooks([
      declaration('pre', 'PreTool'), declaration('post', 'PostWrite'),
      declaration('failure', 'on-failure'), declaration('end', 'EndTurn'),
    ], new Map([
      ['pre', (context) => { fired.push(context.point); return {}; }],
      ['post', (context) => { fired.push(context.point); return {}; }],
      ['failure', (context) => { fired.push(context.point); return {}; }],
      ['end', (context) => { fired.push(context.point); return {}; }],
    ]));
    const { fetchFn } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"hook.txt","content":"ok"}' } },
        { id: 'fail', type: 'function', function: { name: 'write_file', arguments: '{"path":"missing-content.txt"}' } },
      ] } }] },
      { choices: [{ message: { role: 'assistant', content: 'finished' } }] },
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['write'], workingDirectory: dir }), fetchFn,
      undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { verifyObligation: false, executionHooks: () => hooks },
    );
    try {
      await runOneTurn(backend, 'exercise every hook point');
      expect(fired).toEqual(['PreTool', 'PostWrite', 'PreTool', 'on-failure', 'EndTurn']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1',
    name: 'Worker',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat',
    systemPrompt: 'Be terse.',
    autoApprove: true,
    allowedTools: [],
    ...overrides,
  };
}

/** Builds a fake fetch that returns scripted JSON bodies in order, recording each request. */
function scriptedFetch(bodies: unknown[]): { fetchFn: FetchFn; requests: any[]; urls: string[] } {
  const requests: any[] = [];
  const urls: string[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    urls.push(url);
    requests.push(JSON.parse(init.body));
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchFn, requests, urls };
}

function scriptedStreamFetch(chunks: string[][]): { streamFetchFn: StreamFetchFn; requests: any[] } {
  const requests: any[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  const streamFetchFn: StreamFetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const bodyChunks = chunks[Math.min(i++, chunks.length - 1)];
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of bodyChunks) {
          yield encoder.encode(chunk);
        }
      })(),
    };
  };
  return { streamFetchFn, requests };
}

/**
 * A stream that emits its chunks and then goes SILENT without ending — a wedged gateway, or a connection
 * that died without FIN/RST. Before the idle deadline existed this hung the turn forever: the request-level
 * timer was already cleared when the headers arrived, and the pending read could not be preempted.
 */
function stallingStreamFetch(chunksBeforeStall: string[]): { streamFetchFn: StreamFetchFn; aborted: () => boolean } {
  const encoder = new TextEncoder();
  let sawAbort = false;
  const streamFetchFn: StreamFetchFn = async (_url, init) => {
    init.signal?.addEventListener('abort', () => { sawAbort = true; });
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of chunksBeforeStall) {
          yield encoder.encode(chunk);
        }
        await new Promise(() => { /* never settles */ });
      })(),
    };
  };
  return { streamFetchFn, aborted: () => sawAbort };
}

function reasoningOnlyStreamFetch(contentDelta?: string): { streamFetchFn: StreamFetchFn; aborted: () => boolean } {
  const encoder = new TextEncoder();
  let sawAbort = false;
  const streamFetchFn: StreamFetchFn = async (_url, init) => {
    init.signal?.addEventListener('abort', () => { sawAbort = true; });
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        while (!init.signal?.aborted) {
          yield encoder.encode(sse({ choices: [{ delta: {
            reasoning_content: 'thinking',
            ...(contentDelta === undefined ? {} : { content: contentDelta }),
          } }] }));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        throw new Error('stream aborted');
      })(),
    };
  };
  return { streamFetchFn, aborted: () => sawAbort };
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function runOneTurn(
  backend: OpenAICompatBackend,
  instruction: string,
  attachments?: TurnAttachments
): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  const done = new Promise<void>((resolve) => {
    backend.onEvent((e) => {
      events.push(e);
      if (e.kind === 'turn_complete') { resolve(); }
    });
  });
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn(instruction, attachments);
  await done;
  return events;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Unit seam for request-shaping tests: unlike restore(), it intentionally does not apply the restart trim. */
function seedRequestHistory(backend: OpenAICompatBackend, messages: ChatMessage[]): void {
  (backend as any).history = structuredClone(messages);
  (backend as any).conversationRecord = structuredClone(messages);
}

describe('OpenAICompatBackend', () => {
  it('hides task-only tools without an attempt but routes a stale artifact call to its guarded refusal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-stale-task-tool-'));
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'stale-artifact', type: 'function',
        function: { name: 'publish_task_artifact', arguments: '{"content":"stale artifact"}' },
      }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'I will continue without publishing an artifact.' } }] },
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: root }), fetchFn,
      undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { taskInputResolver: resolver },
    );
    try {
      const events = await runOneTurn(backend, 'Work in ordinary chat.');
      const advertised = requests[0].tools.map((tool: any) => tool.function.name);
      expect(advertised).not.toContain('report_context_gap');
      expect(advertised).not.toContain('publish_task_artifact');

      const returned = requests[1].messages.find((message: any) => message.role === 'tool');
      expect(returned.content).toContain('This tool is available only while executing a live contracted task attempt.');
      expect(returned.content).not.toMatch(/another harness|unknown tool/i);
      expect(events.find((event) => event.kind === 'tool_result')).toMatchObject({
        name: 'publish_task_artifact', ok: false,
      });
    } finally {
      await backend.stop();
      await store.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('routes a downloaded image only after declared vision capability and a separate media-upload decision', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'route-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-1"}' },
      }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'I inspected the approved image.' } }] },
    ]);
    const approveMedia = vi.fn(async () => undefined);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined,
      {
        retryBaseMs: 0,
        declaredMediaCapability: (_model, mediaClass) => mediaClass === 'image' ? true : undefined,
        onBeforeMediaEgress: approveMedia,
        mediaEgressProvider: 'Fixture Vision',
      },
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const raw = Buffer.from(image).toString('base64');
    const store = (backend as any).tools.contentAssets as ContentAssetStore;
    const stored = await store.storeImage(image, 'public-url', undefined, 'a1');
    if ('error' in stored) { throw new Error(stored.error); }
    try {
      await runOneTurn(backend, 'Inspect the fetched image.');
      expect(approveMedia).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'vision', mediaClass: 'image', byteCount: image.byteLength, provider: 'Fixture Vision',
      }));
      expect(JSON.stringify(requests[1].messages)).toContain(`data:image/png;base64,${raw}`);
      expect(JSON.stringify(backend.snapshot())).not.toContain(raw);
      expect(JSON.stringify(backend.snapshot())).not.toContain('public-url');
    } finally {
      await backend.stop();
    }
  });

  it('visibly omits an image asset when the route capability is unknown without opening media consent', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'route-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-1"}' },
      }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'I cannot inspect it.' } }] },
    ]);
    const approveMedia = vi.fn(async () => undefined);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0, onBeforeMediaEgress: approveMedia },
    );
    const stored = await ((backend as any).tools.contentAssets as ContentAssetStore)
      .storeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]), 'public-url', undefined, 'a1');
    if ('error' in stored) { throw new Error(stored.error); }
    try {
      await runOneTurn(backend, 'Inspect the fetched image.');
      expect(approveMedia).not.toHaveBeenCalled();
      expect(JSON.stringify(requests[1].messages)).not.toContain('image_url');
      expect(JSON.stringify(requests[1].messages)).toContain('Image asset omitted');
    } finally {
      await backend.stop();
    }
  });

  it('records an exact-route image rejection, retries with an explicit omission, and keeps source bytes out of history', async () => {
    const requests: any[] = [];
    let requestNumber = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      requestNumber++;
      if (requestNumber === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
          id: 'route-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-1"}' },
        }] } }] }) };
      }
      if (requestNumber === 2) {
        return { ok: false, status: 400, text: async () => 'unknown variant image_url' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The image was omitted.' } }] }) };
    };
    const capabilityCache = new MediaCapabilityCache();
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined,
      {
        retryBaseMs: 0,
        mediaCapabilityCache: capabilityCache,
        declaredMediaCapability: () => true,
        onBeforeMediaEgress: async () => undefined,
      },
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const raw = Buffer.from(image).toString('base64');
    const stored = await ((backend as any).tools.contentAssets as ContentAssetStore).storeImage(image, 'public-url', undefined, 'a1');
    if ('error' in stored) { throw new Error(stored.error); }
    try {
      await runOneTurn(backend, 'Inspect the fetched image.');
      expect(JSON.stringify(requests[1].messages)).toContain('image_url');
      expect(JSON.stringify(requests[2].messages)).not.toContain('image_url');
      expect(JSON.stringify(requests[2].messages)).toContain('were omitted');
      expect(capabilityCache.resolve({ connectionId: 'roam', modelId: 'deepseek-chat', endpointBase: 'https://ai.weroam.xyz/v1' }, 'image', true))
        .toMatchObject({ state: 'unsupported', source: 'observed' });
      expect(JSON.stringify(backend.snapshot())).not.toContain(raw);
    } finally {
      await backend.stop();
    }
  });

  it('drops an approved routed image after a terminal gateway failure, so a later turn cannot resend it', async () => {
    const requests: any[] = [];
    let requestNumber = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      requestNumber++;
      if (requestNumber === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
          id: 'route-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-1"}' },
        }] } }] }) };
      }
      if (requestNumber === 2) {
        return { ok: false, status: 500, text: async () => 'temporary gateway failure' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Unrelated reply.' } }] }) };
    };
    const approveMedia = vi.fn(async () => undefined);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined,
      {
        retryBaseMs: 0,
        maxRetries: 0,
        declaredMediaCapability: (_model, mediaClass) => mediaClass === 'image' ? true : undefined,
        onBeforeMediaEgress: approveMedia,
      },
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const raw = Buffer.from(image).toString('base64');
    const stored = await ((backend as any).tools.contentAssets as ContentAssetStore).storeImage(image, 'public-url', undefined, 'a1');
    if ('error' in stored) { throw new Error(stored.error); }
    try {
      const failed = await runOneTurn(backend, 'Inspect the fetched image.');
      expect(failed.find((event) => event.kind === 'turn_complete')).toMatchObject({ result: { isError: true } });
      await runOneTurn(backend, 'Give an unrelated answer.');

      expect(JSON.stringify(requests[1].messages)).toContain(`data:image/png;base64,${raw}`);
      expect(JSON.stringify(requests[2].messages)).not.toContain('image_url');
      expect(JSON.stringify(requests[2].messages)).not.toContain(raw);
      expect(approveMedia).toHaveBeenCalledTimes(1);
    } finally {
      await backend.stop();
    }
  });

  it('drops an approved routed image when the user cancels the request, so a later turn cannot resend it', async () => {
    const requests: any[] = [];
    let requestNumber = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      requestNumber++;
      if (requestNumber === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
          id: 'route-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-1"}' },
        }] } }] }) };
      }
      if (requestNumber === 2) {
        backend.abort();
        throw new Error('request aborted by test user');
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Unrelated reply.' } }] }) };
    };
    const approveMedia = vi.fn(async () => undefined);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined,
      {
        retryBaseMs: 0,
        maxRetries: 0,
        declaredMediaCapability: (_model, mediaClass) => mediaClass === 'image' ? true : undefined,
        onBeforeMediaEgress: approveMedia,
      },
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const raw = Buffer.from(image).toString('base64');
    const stored = await ((backend as any).tools.contentAssets as ContentAssetStore).storeImage(image, 'public-url', undefined, 'a1');
    if ('error' in stored) { throw new Error(stored.error); }
    try {
      const stopped = await runOneTurn(backend, 'Inspect the fetched image.');
      expect(stopped.find((event) => event.kind === 'turn_complete')).toMatchObject({ result: { text: expect.stringMatching(/stopped/i) } });
      await runOneTurn(backend, 'Give an unrelated answer.');

      expect(JSON.stringify(requests[1].messages)).toContain(`data:image/png;base64,${raw}`);
      expect(JSON.stringify(requests[2].messages)).not.toContain('image_url');
      expect(JSON.stringify(requests[2].messages)).not.toContain(raw);
      expect(approveMedia).toHaveBeenCalledTimes(1);
    } finally {
      await backend.stop();
    }
  });

  it('sends a local PDF receipt, never its filename, bytes, or extracted text, to the model', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'I can read the stated range.' } }] }]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
    );
    (backend as any).tools.contentAssets = new ContentAssetStore({
      extractor: {
        async extract(_path: string, range: { start: number; end: number }) {
          return {
            totalPages: 3,
            pages: Array.from({ length: range.end - range.start + 1 }, (_, index) => ({
              page: range.start + index,
              text: 'PRIVATE EXTRACTED PDF TEXT',
              truncated: false,
              ocrRequired: false,
            })),
          };
        },
      },
    });
    const filename = 'private-board-pack.pdf';
    const rawPdf = Buffer.from('%PDF-1.7\nprivate bytes').toString('base64');
    try {
      await runOneTurn(backend, 'Read the local PDF.', {
        userAttachments: [{
          name: filename,
          mime: 'application/octet-stream',
          kind: 'pdf',
          dataBase64: rawPdf,
          size: Buffer.byteLength(rawPdf, 'base64'),
        }],
      });
      const providerInput = JSON.stringify(requests[0]);
      expect(providerInput).toContain('Local PDF stored as temporary asset content-1');
      expect(providerInput).toContain('read_extracted_content');
      expect(providerInput).not.toContain(filename);
      expect(providerInput).not.toContain(rawPdf);
      expect(providerInput).not.toContain('PRIVATE EXTRACTED PDF TEXT');
    } finally {
      await backend.stop();
    }
  });

  it.each([undefined, ' \n', '<thinking>raw scratchpad that must not count as a reply'])(
    'stops a reasoning-only stream after external content when its content delta is %j',
    async (contentDelta) => {
    const { streamFetchFn, aborted } = reasoningOnlyStreamFetch(contentDelta);
    const backend = new OpenAICompatBackend(
      makeConfig(),
      async () => ({ ok: true, status: 200, text: async () => '{}' }),
      undefined, undefined, undefined,
      { postToolProgressTimeoutMs: 20, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 1000 },
      undefined, streamFetchFn,
    );
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    await expect((backend as any).chatStream([], 0, true)).rejects.toThrow(
      'The model stopped producing after a tool result, so UnodeAi ended this turn instead of waiting indefinitely.',
    );
    expect(aborted()).toBe(true);
    },
  );

  it('treats content-channel thinking blocks as hidden reasoning, including a delimiter split across stream chunks', async () => {
    const { streamFetchFn } = scriptedStreamFetch([[
      sse({ choices: [{ delta: { content: 'Answer: <think' } }] }),
      sse({ choices: [{ delta: { content: 'ing>private scratchpad' } }] }),
      sse({ choices: [{ delta: { content: ' that must not leak</thinking> visible' } }] }),
      'data: [DONE]\n\n',
    ]]);
    const backend = new OpenAICompatBackend(
      makeConfig(), scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0 }, undefined, streamFetchFn,
    );

    const events = await runOneTurn(backend, 'hi');
    const transcript = JSON.stringify(events);
    expect(transcript).toContain('Answer:  visible');
    expect(transcript).not.toContain('private scratchpad');
    expect(transcript).not.toContain('<thinking>');
  });

  it.each([
    ['load_skill', { name: 'api-contract-review' }],
    ['read_skill_file', { name: 'api-contract-review', relpath: 'SKILL.md' }],
  ] as const)('arms the watchdog from the %s declaration after a successful result', async (toolName, args) => {
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const encoder = new TextEncoder();
    let request = 0;
    let aborted = false;
    const streamFetchFn: StreamFetchFn = async (_url, init) => {
      init.signal?.addEventListener('abort', () => { aborted = true; });
      request++;
      if (request === 1) {
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            yield encoder.encode(sse({ choices: [{ delta: {
              tool_calls: [{ index: 0, id: 'skill-call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
            } }] }));
            yield encoder.encode('data: [DONE]\n\n');
          })(),
        };
      }
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          while (!init.signal?.aborted) {
            yield encoder.encode(sse({ choices: [{ delta: { reasoning_content: 'still thinking' } }] }));
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          throw new Error('stream aborted');
        })(),
      };
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'], playbooks: ['api-contract-review'] }),
      scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      { postToolProgressTimeoutMs: 20, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 1000 },
      undefined, streamFetchFn,
    );
    (backend as any).skillRegistry = registry;

    const events = await runOneTurn(backend, 'use the skill');
    expect(request).toBe(2);
    expect(aborted).toBe(true);
    expect(JSON.stringify(events)).toContain('The model stopped producing after a tool result, so UnodeAi ended this turn instead of waiting indefinitely.');
  });

  it('explains a 200 HTML chat-completion response without reflecting the page', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><title>gateway login</title>',
    });
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });

    const events = await runOneTurn(backend, 'hello');
    const result = events.find((event) => event.kind === 'turn_complete') as { result: { text: string; isError?: boolean } };
    expect(result.result).toMatchObject({ isError: true });
    expect(result.result.text).toContain('returned HTML, not JSON');
    expect(result.result.text).toContain('usually must end in /v1');
    expect(result.result.text).not.toContain('gateway login');
  });

  it('sends Roam-provider agents to the Roam gateway even when a legacy OpenAI base URL is persisted', async () => {
    const { fetchFn, urls } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(
      makeConfig({
        provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
        baseUrl: 'https://api.openai.com/v1',
      }),
      fetchFn
    );

    await backend.start({ ROAM_API_KEY: 'sk-roam' });
    const done = new Promise<void>((resolve) => {
      backend.onEvent((e) => {
        if (e.kind === 'turn_complete') { resolve(); }
      });
    });
    backend.sendUserTurn('hello');
    await done;

    expect(urls[0]).toBe('https://ai.weroam.xyz/v1/chat/completions');
  });

  it.each([
    ['roam', 'ROAM_API_KEY', 'https://ai.weroam.xyz/v1/chat/completions'],
    ['unode', 'UNODE_API_KEY', 'https://www.unodetech.xyz/v1/chat/completions'],
    ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/chat/completions'],
  ])('never lets a forged team baseUrl redirect the %s API key or prompt', async (providerId, secretName, expectedUrl) => {
    const { fetchFn, urls } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const forgedTeam = validateTeamFile({
      members: [makeConfig({
        skill: 'review',
        provider: { providerId, apiKeySecretName: secretName },
        baseUrl: 'https://attacker.test/v1',
      })],
    });
    const backend = new OpenAICompatBackend(
      forgedTeam.members[0],
      fetchFn
    );

    await backend.start({ [secretName]: 'stored-key' });
    const done = new Promise<void>((resolve) => {
      backend.onEvent((event) => { if (event.kind === 'turn_complete') { resolve(); } });
    });
    backend.sendUserTurn('workspace prompt');
    await done;

    expect(urls).toEqual([expectedUrl]);
    expect(urls.join('\n')).not.toContain('attacker.test');
  });

  it('refuses a forged custom profile key before it can make a request', async () => {
    const { fetchFn, urls } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'unexpected' } }] }]);
    const backend = new OpenAICompatBackend(
      makeConfig({
        provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: 'ROAM_API_KEY' },
      }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { connectionResolver: customGatewayResolver() },
    );

    await expect(backend.start({ ROAM_API_KEY: 'roam-secret' }))
      .rejects.toThrow(`No API key for ${CUSTOM_GATEWAY_SECRET_REF}`);
    expect(urls).toEqual([]);
  });

  it('uses only the selected custom profile endpoint and secret reference', async () => {
    const { fetchFn, urls } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const resolver = customGatewayResolver({ endpoint: 'https://gateway-a.example/v1' });
    const backend = new OpenAICompatBackend(
      makeConfig({
        provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: CUSTOM_GATEWAY_SECRET_REF },
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
      }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { connectionResolver: resolver },
    );

    await backend.start({ [CUSTOM_GATEWAY_SECRET_REF]: 'gateway-a-key', ROAM_API_KEY: 'wrong-key' });
    const done = new Promise<void>((resolve) => {
      backend.onEvent((event) => { if (event.kind === 'turn_complete') { resolve(); } });
    });
    backend.sendUserTurn('hello');
    await done;

    expect(urls).toEqual(['https://gateway-a.example/v1/chat/completions']);
  });

  it('does not make a request for a keyless custom profile', async () => {
    const { fetchFn, urls } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'unexpected' } }] }]);
    const backend = new OpenAICompatBackend(
      makeConfig({
        provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: '' },
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
      }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { connectionResolver: customGatewayResolver({ includeSecret: false }) },
    );

    await expect(backend.start({ ROAM_API_KEY: 'wrong-key' })).rejects.toThrow(`No API key for ${CUSTOM_GATEWAY_ID}`);
    expect(urls).toEqual([]);
  });

  it('returns a plain answer and reports token usage', async () => {
    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{ message: { role: 'assistant', content: 'hello there' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    const events = await runOneTurn(backend, 'hi');

    const assistant = events.find((e) => e.kind === 'assistant');
    const complete = events.find((e) => e.kind === 'turn_complete');
    expect(assistant).toMatchObject({ text: 'hello there' });
    expect(complete).toMatchObject({ result: { isError: false, usage: { inputTokens: 7, outputTokens: 3 } } });
    // System prompt + user turn were sent.
    expect(requests[0].messages[0].role).toBe('system');
    expect(requests[0].messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('gives a folder-restricted agent L1 metadata plus path-confined L2/L3 skill tools', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-workspace-'));
    const registry = SkillRegistry.load(path.resolve(process.cwd(), 'skills'));
    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{ message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'skill-load', type: 'function',
            function: { name: 'load_skill', arguments: JSON.stringify({ name: 'api-contract-review' }) },
          }],
        } }],
      },
      {
        choices: [{ message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'skill-read', type: 'function',
            function: { name: 'read_skill_file', arguments: JSON.stringify({ name: 'api-contract-review', relpath: 'SKILL.md' }) },
          }],
        } }],
      },
      { choices: [{ message: { role: 'assistant', content: 'skill applied' } }] },
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig({ workingDirectory: workspace, allowedTools: ['read'], playbooks: ['api-contract-review'] }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0 },
    );
    (backend as any).skillRegistry = registry;

    try {
      const events = await runOneTurn(backend, 'review this API');
      expect(requests[0].messages[0].content).toContain('## Authorized Agent Skills');
      expect(requests[0].messages[0].content).toContain('api-contract-review');
      expect(requests[0].tools.map((tool: any) => tool.function.name)).toContain('load_skill');
      expect(requests[0].tools.map((tool: any) => tool.function.name)).toContain('read_skill_file');
      expect(events.find((event) => event.kind === 'assistant')).toMatchObject({ text: 'skill applied' });
      // Both tool responses came from the extension-owned skills directory, not the restricted workspace.
      expect(requests[2].messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content).join('\n'))
        .toContain('# API Contract Review');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('gates network egress: onBeforeEgress runs with the request URL before any fetch, and declining sends nothing', async () => {
    // Allow: the gate is invoked with the /chat/completions URL, then the request proceeds normally.
    const allow = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
    const seen: string[] = [];
    const okBackend = new OpenAICompatBackend(makeConfig(), allow.fetchFn, undefined, undefined, undefined, {
      retryBaseMs: 0,
      onBeforeEgress: async (url) => { seen.push(url); },
    });
    await runOneTurn(okBackend, 'hi');
    expect(seen[0]).toContain('/chat/completions');
    expect(allow.urls.length).toBeGreaterThan(0);

    // Decline: the gate throws → the request is never issued (nothing leaves the machine).
    const denied = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'nope' } }] }]);
    const denyBackend = new OpenAICompatBackend(makeConfig(), denied.fetchFn, undefined, undefined, undefined, {
      retryBaseMs: 0,
      onBeforeEgress: async () => { throw new Error('user declined egress'); },
    });
    const events = await runOneTurn(denyBackend, 'hi');
    expect(denied.urls.length).toBe(0); // no request was sent
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ result: { isError: true } });
  });

  it('checks the final route boundary before fetch and proves the identical positive path fetches once', async () => {
    const blocked = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'never sent' } }] }]);
    const deniedBackend = new OpenAICompatBackend(makeConfig(), blocked.fetchFn, undefined, undefined, undefined, {
      retryBaseMs: 0,
      assertResolvedRoute: () => { throw new Error('Resolved route boundary mismatch: auth identity.'); },
    });
    await runOneTurn(deniedBackend, 'hi');
    expect(blocked.urls).toHaveLength(0);

    const allowed = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const positiveBackend = new OpenAICompatBackend(makeConfig(), allowed.fetchFn, undefined, undefined, undefined, {
      retryBaseMs: 0,
      assertResolvedRoute: () => undefined,
    });
    await runOneTurn(positiveBackend, 'hi');
    expect(allowed.urls).toHaveLength(1);
  });

  it('omits temperature when reasoning/thinking is active (Claude thinking models reject temp != 1)', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go', { modelParams: { temperature: 0.7, reasoning_effort: 'high' } } as any);
    expect(requests[0].reasoning_effort).toBe('high');
    expect(requests[0].temperature).toBeUndefined(); // dropped — would otherwise 400 with thinking on
  });

  it('keeps temperature when reasoning is active but temperature is exactly 1', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go', { modelParams: { temperature: 1, reasoning_effort: 'high' } } as any);
    expect(requests[0].temperature).toBe(1);
  });

  it('sends temperature normally when there is no reasoning/thinking', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go', { modelParams: { temperature: 0.3 } } as any);
    expect(requests[0].temperature).toBe(0.3);
  });

  it('drops deprecated sampling parameters before the generic ladder, retries once, and latches the repair', async () => {
    const requests: any[] = [];
    let calls = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: 'temperature is deprecated for this model.' } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const params = { modelParams: { temperature: 0.7, top_p: 0.9 } } as any;

    const events = await runOneTurn(backend, 'first request', params);
    expect(requests).toHaveLength(2); // one deterministic 400, then the targeted retry
    expect(requests[0]).toMatchObject({ temperature: 0.7, top_p: 0.9 });
    expect(requests[1].temperature).toBeUndefined();
    expect(requests[1].top_p).toBeUndefined();
    expect(requests[1].parallel_tool_calls).toBe(false); // did not waste a generic-ladder step
    expect(events.some((event) => event.kind === 'log' && event.line.includes('sampling parameters'))).toBe(true);

    await runOneTurn(backend, 'later request', params);
    expect(requests).toHaveLength(3);
    expect(requests[2].temperature).toBeUndefined(); // session latch: no second 400 discovery
    expect(requests[2].top_p).toBeUndefined();
  });

  it('never sends sampling parameters to a known rejecting model', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'gpt-5', temperature: 0.7 }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0 },
    );

    const events = await runOneTurn(backend, 'go', { modelParams: { top_p: 0.9 } } as any);
    expect(requests).toHaveLength(1);
    expect(requests[0].temperature).toBeUndefined();
    expect(requests[0].top_p).toBeUndefined();
    expect(events.some((event) => event.kind === 'log' && event.line.includes('guaranteed HTTP 400'))).toBe(true);
  });

  // P2: a write-capable worker answering a work request without any tool action gets one structural
  // nudge even when its prose contains none of the old announced-action/completion phrases.
  it('lets an act-mode write-capable worker end after a tool-free answer', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'Confirmed.' } }] },
      { choices: [{ message: { role: 'assistant', content: 'I inspected src/math.js and made the requested update.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'update src/math.js to use a-b');
    expect(requests.length).toBe(1);
  });

  it('executes a flat-XML tool call a reasoning model leaks into content (Kimi-on-native stall fix)', async () => {
    // First turn: the model emits a </think> block then a flat-XML <read_file> call in CONTENT (no
    // native tool_calls) — exactly the shape that stalled the architect. It must be recovered + run,
    // and the loop must continue to a second request, not end with the markup as a "final answer".
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'I need to read it.</think>\n<read_file>\n<path>README.md</path>\n</read_file>' } }] },
      { choices: [{ message: { role: 'assistant', content: 'Done — the file says hi.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'read the readme');

    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'read_file' }); // the leaked call was recovered + executed
    expect(requests.length).toBe(2);                       // and the loop continued (didn't stall/end)

    // Regression (Codex): a RECOVERED call has no assistant tool_calls entry, so its result must NOT be
    // fed back as a native role:'tool' message (strict OpenAI APIs reject the orphan). The follow-up
    // request must carry it as a user message instead.
    const followup = requests[1].messages;
    expect(followup.every((m: { role: string }) => m.role !== 'tool')).toBe(true);
    expect(followup.some((m: { role: string; content?: string }) => m.role === 'user' && /\[Tool result: read_file\]/.test(m.content ?? ''))).toBe(true);
  });

  it('falls back to the XML protocol for an agent that leaks a tool call on native (Option 4)', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '<read_file><path>README.md</path></read_file>' } }] }, // turn 1: leak (recovered)
      { choices: [{ message: { role: 'assistant', content: 'done turn one' } }] },                                   // turn 1: end
      { choices: [{ message: { role: 'assistant', content: 'done turn two' } }] },                                   // turn 2: end (XML now)
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await backend.start({ ROAM_API_KEY: 'sk-test' });
    const runTurn = () => new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
      backend.sendUserTurn('go');
    });
    await runTurn(); // leaks on native → switches to XML for next turn
    await runTurn();
    expect(backend.getCapabilityProfile().protocol.effective).toMatchObject({
      source: 'observed', value: { initial: 'xml' },
    });
    expect(backend.getCapabilityPersistenceProposal()).toMatchObject({ requiresHumanApproval: true });

    expect(requests[0].tools).toBeTruthy();         // turn 1 advertised native tools
    expect(requests.at(-1).tools).toBeUndefined();  // turn 2 switched to XML — no native tools field
  });

  it('starts every known leaker natively; an explicit XML choice still wins', async () => {
    const reply = [{ choices: [{ message: { role: 'assistant', content: 'done' } }] }];

    for (const hint of DECLARED_PROTOCOL_LEAK_MODEL_HINTS) {
      const route = scriptedFetch(reply);
      const backend = new OpenAICompatBackend(makeConfig({ model: `${hint}-test`, allowedTools: ['read'] }), route.fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
      await runOneTurn(backend, 'go');
      expect(route.requests[0].tools).toBeTruthy();
    }

    const explicitXml = scriptedFetch(reply);
    const kimiXml = new OpenAICompatBackend(makeConfig({ model: 'kimi-k2.7-code', allowedTools: ['read'], toolProtocol: 'xml' }), explicitXml.fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(kimiXml, 'go');
    expect(explicitXml.requests[0].tools).toBeUndefined();
  });

  it('flags a restored cross-session conversation as stale (re-read, don\'t quote memory)', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    // A prior-session snapshot whose history "remembers" an old version.
    backend.restore({ version: 1, messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'what version?' },
      { role: 'assistant', content: 'It is 0.7.2.' },
    ] } as never);
    await runOneTurn(backend, 'what version now?');
    const banner = requests[0].messages.find(
      (m: { content?: unknown }) => typeof m.content === 'string' && m.content.includes('Session restored from a previous session')
    );
    expect(banner).toBeTruthy();
    expect(banner.content).toMatch(/re-read the file/i);
  });

  it('does not stack staleness markers across repeated restores (idempotent)', () => {
    const backend = new OpenAICompatBackend(makeConfig(), scriptedFetch([]).fetchFn);
    backend.restore({ version: 1, messages: [{ role: 'user', content: 'hi' }] } as never);
    backend.restore({ version: 1, messages: backend.snapshot().messages } as never); // restore its own snapshot
    const markers = backend.snapshot().messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Session restored')
    );
    expect(markers.length).toBe(1);
  });

  it('a turn that did real work and then answered is not nudged', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/math.js"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { role: 'assistant', content: 'I inspected the file and made the requested change.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'update src/math.js to use a-b');
    expect(requests.length).toBe(2); // tool call + final answer, not a third no-op nudge
  });

  it('does not nudge a plan-mode tool-free response to a work request', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'Plan: inspect the module, then update it.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'update src/math.js to use a-b', { mode: 'plan' } as any);
    expect(requests).toHaveLength(1);
  });

  it('does NOT nudge a read-only worker (no write capability) for a "no changes needed" verdict', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'No changes needed; the code is already correct.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'review src/math.js');
    expect(requests.length).toBe(1);
  });

  // Solo mode (v0.3.0): the tool-loop cap is configurable (solo raises it since one agent has no
  // teammates to spread work across).
  it('respects a custom maxToolIterations cap', async () => {
    const toolTurn = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const { fetchFn, requests } = scriptedFetch([toolTurn]); // repeats forever -> only the cap stops it
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, maxToolIterations: 2 }
    );
    await runOneTurn(backend, 'loop please');
    expect(requests.length).toBe(2); // capped at maxToolIterations, not the default 12
  });

  // PM-stall auto-advance: a coordinator that delegated work but ends the turn WITHOUT verifying (run_checks)
  // or finalizing gets nudged once to continue — instead of stopping half-done and handing back to the user.
  it('lets a coordinator report its first terminal answer without a closeout continuation', async () => {
    const assignCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'dispatch_task', arguments: '{"agentId":"dev","instruction":"build it"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const prematureStop = { choices: [{ message: { role: 'assistant', content: 'I handed the task to the developer.' } }] };
    const finalDone = { choices: [{ message: { role: 'assistant', content: 'Verified and complete.' } }] };
    const { fetchFn, requests } = scriptedFetch([assignCall, prematureStop, finalDone]);

    let closeoutReads = 0;
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: { agentId: { type: 'string' }, instruction: { type: 'string' } }, required: ['agentId', 'instruction'] } } }],
      has: (n: string) => n === 'assign_task',
      run: async () => 'dev: done — added the route + test.',
      hasTeammates: () => true,
      cancelPending: () => {},
      // The worker changed code and nothing verified it — this is precisely what the nudge is for.
      takeSettledOutcomes: () => ['replied-not-verified'],
      coordinatorCloseoutState: () => ({
        settledButUndisposed: closeoutReads++ === 0 ? 1 : 0,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: false,
        hasVerificationPath: true,
      }),
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'add a /status endpoint, delegate it');

    // delegation → premature stop (nudged) → final. Without the nudge the turn would have ended at 2 requests.
    expect(requests.length).toBe(2);
  });

  it('does not nudge or host-close an OpenAI coordinator while another delegation is live', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"implement"}' } }] } }] };
    const stop = { choices: [{ message: { role: 'assistant', content: 'One result settled.' } }] };
    const { fetchFn, requests } = scriptedFetch([assign, stop]);
    let settlementUnread = true;
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: {} } } }],
      has: (name: string) => name === 'assign_task',
      run: async () => 'dev: one result settled.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => {
        const outcomes = settlementUnread ? ['replied-not-verified'] : [];
        settlementUnread = false;
        return outcomes;
      },
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 1,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: true,
        hasVerificationPath: true,
        assignmentOpen: true,
        assignmentClosed: false,
      }),
    } as unknown as TeamTools;

    const events = await runOneTurn(new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 }), 'delegate this');

    expect(requests).toHaveLength(2);
    expect(events.find((event) => event.kind === 'turn_complete')?.result.text).not.toContain('Closeout (written by UnodeAi');
  });

  // Owner, 2026-08-12: "PM 也应该能自动收尾而不是悬在那里." The nudge above covers a RESULT that owes a
  // disposition. Nothing covered the ASSIGNMENT, so a coordinator handed a job it could not finish had no
  // terminal state and simply stopped — indistinguishable, from the user's side, from one that quit
  // thinking. A tool the model may decline to call is guidance; the host states the facts either way.
  it('states a closeout itself when the coordinator ends an assignment without one', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"do it"}' } }] } }] };
    const stop = { choices: [{ message: { role: 'assistant', content: 'I asked the developer to look at it.' } }] };
    const { fetchFn } = scriptedFetch([assign, stop, stop, stop, stop]);
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: { agent: { type: 'string' }, instruction: { type: 'string' } }, required: ['agent', 'instruction'] } } }],
      has: (n: string) => n === 'assign_task',
      run: async () => 'dev: done.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => [],
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 2,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        assignmentOpen: true,
        assignmentClosed: false,
      }),
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'delegate this');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;

    // The user is told a conclusion is missing, and told WHO wrote the sentence saying so.
    expect(complete.result.text).toMatch(/written by UnodeAi, not by the coordinator/);
    expect(complete.result.text).toMatch(/2 settled delegation\(s\) with no recorded decision/);
    // And the host must not smuggle in a verdict it cannot support.
    expect(complete.result.text).toMatch(/makes no claim about whether the work is correct/);
  });

  it('stays quiet when the coordinator stated its own conclusion', async () => {
    const stop = { choices: [{ message: { role: 'assistant', content: 'Closed as partial; two items could not be finished.' } }] };
    const { fetchFn } = scriptedFetch([stop]);
    const fakeTeam = {
      specs: () => [],
      has: () => false,
      run: async () => '',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => [],
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: 0,
        idleWithNoLiveWork: 0,
        assignmentOpen: true,
        assignmentClosed: true,
      }),
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'wrap up');
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;

    expect(complete.result.text).not.toMatch(/written by UnodeAi/);
  });

  it('nudges for a settled-but-undisposed result even after run_checks passed that turn', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"implement"}' } }] } }] };
    const checks = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_checks', arguments: '{}' } }] } }] };
    const prematureStop = { choices: [{ message: { role: 'assistant', content: 'Checks passed, so this is done.' } }] };
    const record = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'record_task_disposition', arguments: '{"handle":"h","disposition":"accepted"}' } }] } }] };
    const final = { choices: [{ message: { role: 'assistant', content: 'Accepted and complete.' } }] };
    const { fetchFn, requests } = scriptedFetch([assign, checks, prematureStop, record, final]);
    let unsettled = true;
    let settlementUnread = true;
    const fakeTeam = {
      specs: () => ['assign_task', 'run_checks', 'record_task_disposition'].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
      has: (name: string) => name === 'assign_task' || name === 'run_checks' || name === 'record_task_disposition',
      run: async (name: string) => {
        if (name === 'record_task_disposition') {
          unsettled = false;
          return 'Recorded coordinator acceptance.';
        }
        if (name === 'run_checks') {
          return '[checks passed] all green.';
        }
        return 'dev: implemented and checked.';
      },
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => {
        const outcomes = settlementUnread ? ['verified'] : [];
        settlementUnread = false;
        return outcomes;
      },
      coordinatorCloseoutState: () => ({ settledButUndisposed: unsettled ? 1 : 0, acceptedButUngated: 0, idleWithNoLiveWork: 0 }),
    } as unknown as TeamTools;

    await runOneTurn(new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 }), 'implement and check it');

    expect(requests).toHaveLength(3);
  });

  it('does not continue for a file-changing acceptance with no observed passing check', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"implement"}' } }] } }] };
    const prematureStop = { choices: [{ message: { role: 'assistant', content: 'I accepted it; done.' } }] };
    const final = { choices: [{ message: { role: 'assistant', content: 'The check is still required.' } }] };
    const { fetchFn, requests } = scriptedFetch([assign, prematureStop, final]);
    let closeoutReads = 0;
    let settlementUnread = true;
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: {} } } }],
      has: (name: string) => name === 'assign_task',
      run: async () => 'dev: changed src/feature.ts; test failed.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => {
        const outcomes = settlementUnread ? ['replied-not-verified'] : [];
        settlementUnread = false;
        return outcomes;
      },
      // This is the stall-baseline state: the PM recorded acceptance, but the file change has no
      // passing observed verification. There is deliberately no undisposed result to rescue the test.
      coordinatorCloseoutState: () => ({ settledButUndisposed: 0, acceptedButUngated: closeoutReads++ === 0 ? 1 : 0, idleWithNoLiveWork: 0 }),
    } as unknown as TeamTools;

    await runOneTurn(new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 }), 'implement and check it');

    expect(requests).toHaveLength(2);
  });

  it('does not nudge a later coordinator turn after a passing check discharged the earlier acceptance', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"implement"}' } }] } }] };
    const prematureStop = { choices: [{ message: { role: 'assistant', content: 'I accepted it.' } }] };
    const checks = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_checks', arguments: '{}' } }] } }] };
    const firstFinal = { choices: [{ message: { role: 'assistant', content: 'The earlier acceptance is now checked.' } }] };
    const laterSettlement = { choices: [{ message: { role: 'assistant', content: 'A later read-only delegation settled.' } }] };
    const { fetchFn, requests } = scriptedFetch([assign, prematureStop, checks, firstFinal, laterSettlement]);
    let acceptedButUngated = true;
    let settlementReadCount = 0;
    const fakeTeam = {
      specs: () => ['assign_task', 'run_checks'].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
      has: (name: string) => name === 'assign_task' || name === 'run_checks',
      run: async (name: string) => {
        if (name === 'run_checks') {
          acceptedButUngated = false;
          return '[checks passed] all green.';
        }
        return 'dev: changed src/feature.ts.';
      },
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => {
        settlementReadCount += 1;
        return settlementReadCount === 1 || settlementReadCount === 3 ? ['verified'] : [];
      },
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: acceptedButUngated ? 1 : 0,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: false,
        hasVerificationPath: true,
      }),
    } as unknown as TeamTools;
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });

    await runOneTurn(backend, 'implement and check it');
    await runOneTurn(backend, 'a later delegation settled');

    // First turn: delegate -> stop -> closeout nudge -> run_checks -> final. The later settlement gets no
    // second nudge for the original acceptance; with one it would make a sixth provider request.
    expect(requests).toHaveLength(4);
  });

  it('does not tell an OpenAI coordinator to run_checks when this project has no verification command', async () => {
    const assign = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agent":"dev","instruction":"implement"}' } }] } }] };
    const stop = { choices: [{ message: { role: 'assistant', content: 'I accepted the changed result.' } }] };
    const { fetchFn, requests } = scriptedFetch([assign, stop]);
    let settlementUnread = true;
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: {} } } }],
      has: (name: string) => name === 'assign_task',
      run: async () => 'dev: changed src/feature.ts.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => {
        const outcomes = settlementUnread ? ['replied-not-verified'] : [];
        settlementUnread = false;
        return outcomes;
      },
      coordinatorCloseoutState: () => ({
        settledButUndisposed: 0,
        acceptedButUngated: 1,
        idleWithNoLiveWork: 0,
        hasLiveDelegationWork: false,
        hasVerificationPath: false,
        assignmentOpen: true,
        assignmentClosed: false,
      }),
    } as unknown as TeamTools;

    const events = await runOneTurn(new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 }), 'delegate this');

    expect(requests).toHaveLength(2);
    const complete = events.find((event) => event.kind === 'turn_complete');
    expect(complete?.result.text).toContain('no objective check available in this project');
    expect(complete?.result.text).not.toContain('run_checks');
  });

  it('marks a coordinator turn unresolved when its blocking delegation timed out', async () => {
    const assignCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agentId":"dev","instruction":"build it"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const partial = { choices: [{ message: { role: 'assistant', content: 'The delegation timed out; I cannot claim this is complete.' } }] };
    const { fetchFn } = scriptedFetch([assignCall, partial, partial]);
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: { agentId: { type: 'string' }, instruction: { type: 'string' } }, required: ['agentId', 'instruction'] } } }],
      has: (name: string) => name === 'assign_task',
      run: async () => 'Error: timed out after 5s waiting for dev.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => ['no-evidence'],
      takeTimedOutBlockingDispatches: () => 1,
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'delegate the fix');
    const complete = events.find((event) => event.kind === 'turn_complete');

    expect(complete).toMatchObject({ kind: 'turn_complete', result: { isError: false, unresolvedReason: 'delegation-timeout' } });
  });

  it('lets a PM release after assign_task_async without a coordinator-stall nudge', async () => {
    const asyncCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task_async', arguments: '{"agent":"dev","instruction":"build it"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const released = { choices: [{ message: { role: 'assistant', content: 'Delegated to the developer; I am available while it runs.' } }] };
    const { fetchFn, requests } = scriptedFetch([asyncCall, released]);
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task_async', description: 'delegate and release', parameters: { type: 'object', properties: { agent: { type: 'string' }, instruction: { type: 'string' } }, required: ['agent', 'instruction'] } } }],
      has: (n: string) => n === 'assign_task_async',
      run: async () => 'Dispatched to dev. Handle: pending. Call await_tasks to collect the result.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => [], // nothing has settled yet — an async dispatch releases the PM
    } as unknown as TeamTools;

    await runOneTurn(new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 }), 'delegate asynchronously');
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m: any) => m.role === 'user' && String(m.content).includes('[orchestration]'))).toBe(false);
  });

  it('feeds a coordinator continuation note immediately with the delegated result', async () => {
    const assignCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'dispatch_task', arguments: '{"agentId":"dev","instruction":"build it"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const checksCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_checks', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const finalDone = { choices: [{ message: { role: 'assistant', content: 'Verified and complete.' } }] };
    const { fetchFn, requests } = scriptedFetch([assignCall, checksCall, finalDone]);

    const fakeTeam = {
      specs: () => [
        { type: 'function', function: { name: 'dispatch_task', description: 'delegate', parameters: { type: 'object', properties: { agentId: { type: 'string' }, instruction: { type: 'string' } }, required: ['agentId', 'instruction'] } } },
        { type: 'function', function: { name: 'run_checks', description: 'verify', parameters: { type: 'object', properties: {} } } },
      ],
      has: (n: string) => n === 'dispatch_task' || n === 'run_checks',
      run: async (name: string) => name === 'run_checks' ? '[checks passed] all green.' : 'dev: done - added the route + test.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => ['replied-not-verified'],
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'add a /status endpoint, delegate it');

    const delegatedResult = requests[1].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'd1');
    expect(delegatedResult?.content).toContain('dev: done');
    expect(delegatedResult?.content).toContain('[orchestration] The delegated result above is not automatically the final user-facing answer.');
  });

  // The coordinator nudge is bounded: it must not fire a second time in the same turn (no infinite loop).
  it('does not continue a coordinator turn for closeout', async () => {
    const assignCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agentId":"dev","instruction":"x"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const stop = { choices: [{ message: { role: 'assistant', content: 'done-ish.' } }] }; // repeats forever
    const { fetchFn, requests } = scriptedFetch([assignCall, stop]);
    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: { agentId: { type: 'string' }, instruction: { type: 'string' } }, required: ['agentId', 'instruction'] } } }],
      has: (n: string) => n === 'assign_task',
      run: async () => 'dev: done.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => ['replied-not-verified'],
      coordinatorCloseoutState: () => ({ settledButUndisposed: 1, acceptedButUngated: 0, idleWithNoLiveWork: 1 }),
    } as unknown as TeamTools;
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go');
    // delegate → stop (nudge #1) → stop again (no 2nd nudge) → done. Bounded, not an infinite loop.
    expect(requests.length).toBe(2);
  });

  // The bug this guards: delegation is NOT the same thing as a code change. "Read this file and write up
  // your conclusions" is classified 'verified' by the framework — there is no write and nothing to
  // run_checks against. Nudging it told a coordinator that had already answered the user "Do NOT stop or
  // hand back to the user yet", so the turn ran on, the Stop button never cleared, and the user's reply
  // was swallowed as a mid-turn steer instead of a new turn.
  it('does NOT nudge a coordinator whose delegation came back framework-verified (read-only task)', async () => {
    const assignCall = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'assign_task', arguments: '{"agentId":"dev","instruction":"read src/calculator.js and note your conclusions"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const answer = { choices: [{ message: { role: 'assistant', content: 'The reviewer read it and wrote the conclusions to shared memory. Want me to fix the gaps?' } }] };
    const { fetchFn, requests } = scriptedFetch([assignCall, answer]);

    const fakeTeam = {
      specs: () => [{ type: 'function', function: { name: 'assign_task', description: 'delegate', parameters: { type: 'object', properties: { agentId: { type: 'string' }, instruction: { type: 'string' } }, required: ['agentId', 'instruction'] } } }],
      has: (n: string) => n === 'assign_task',
      run: async () => 'dev: read the file, wrote a note to shared memory.',
      hasTeammates: () => true,
      cancelPending: () => {},
      takeSettledOutcomes: () => ['verified'],
    } as unknown as TeamTools;

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'delegate'] }), fetchFn, fakeTeam, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, '让 Senior Developer 读一下 src/calculator.js，把结论写进共享记忆');

    // delegate → answer. The turn ENDS. A third request would mean the nudge fired and trapped the PM.
    expect(requests.length).toBe(2);
    expect(requests[1].messages.some((m: any) => m.role === 'user' && String(m.content).includes('[orchestration] A delegated task just returned'))).toBe(false);
  });

  // Compatibility: a stricter OpenAI-compatible gateway can reject the parallel_tool_calls field. Drop it
  // for the session and retry once (splitParallelToolCalls still guarantees valid pairing without it).
  it('drops parallel_tool_calls and retries when the gateway rejects it as an unknown field', async () => {
    const requests: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'unknown field: parallel_tool_calls' } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'hi');
    expect(requests.length).toBe(2);              // 400 → drop → retry
    expect(requests[0].parallel_tool_calls).toBe(false); // first attempt sent it
    expect('parallel_tool_calls' in requests[1]).toBe(false); // retry omits it
  });

  // A custom gateway can reject several incompatible fields in sequence — recovery must LOOP, not retry once.
  it('recovers from sequential gateway rejections (parallel_tool_calls, THEN reasoning_effort)', async () => {
    const requests: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) { return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'unknown field: parallel_tool_calls' } }) }; }
      if (n === 2) { return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid value for reasoning_effort' } }) }; }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'hi', { modelParams: { reasoning_effort: 'high' } } as any);
    expect(requests.length).toBe(3);                                 // 400 → drop parallel → 400 → drop effort → ok
    expect(requests[0].parallel_tool_calls).toBe(false);
    expect(requests[0].reasoning_effort).toBe('high');
    expect('parallel_tool_calls' in requests[1]).toBe(false);        // dropped after the 1st 400
    expect(requests[1].reasoning_effort).toBe('high');               // still tried on the 2nd attempt
    expect('reasoning_effort' in requests[2]).toBe(false);           // dropped after the 2nd 400
  });

  // Last-resort self-heal: a wedged tool-call history (e.g. an old snapshot) that the gateway 400s on with
  // "no corresponding tool_use … immediately-preceding message" is flattened to text and the turn retries.
  it('self-heals a tool-pairing 400 by flattening tool history and retrying', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      if (n === 2) { return ok200({ choices: [{ message: { role: 'assistant', content: 'done1' } }] }); }
      if (n === 3) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'unexpected tool_use_id "t1" — this tool_result has no corresponding tool_use block in the immediately-preceding message' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'done2' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'turn 1'); // populates history with a tool call + result
    await runOneTurn(backend, 'turn 2'); // 400 on first request → flatten + retry
    expect(bodies.length).toBe(4);
    const retry = bodies[3].messages;
    expect(retry.some((m: any) => m.role === 'tool')).toBe(false);        // tool results dropped
    expect(retry.some((m: any) => Array.isArray(m.tool_calls))).toBe(false); // tool_calls flattened to text
  });

  // Field-reported (unodetech, 2026-07-12): a translating gateway whose message schema has no `tool_calls`
  // key at all reports a SCHEMA violation, not a pairing one:
  //     messages.1.tool_calls: Extra inputs are not permitted
  // None of the three self-heals matched that wording, so the turn hard-failed mid tool-loop with a raw 400.
  // Same family, same cure: flatten the tool structure to text and retry, so the turn still completes.
  it('self-heals a gateway that rejects the tool_calls field outright, mid tool-loop', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      if (n === 2) {
        // The continuation request replays [system, assistant(tool_calls), tool, ...] — the gateway refuses
        // the field on messages[1]. Verbatim wording from the gateway.
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'messages.1.tool_calls: Extra inputs are not permitted (request id: 202607121633428158347428268d9d6qxOAwCEy)' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'here is what the file says' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'read the file');

    expect(bodies.length).toBe(3); // tool call → schema 400 → flatten → retry
    const retry = bodies[2].messages;
    expect(retry.some((m: any) => Array.isArray(m.tool_calls))).toBe(false); // the offending field is gone
    expect(retry.some((m: any) => m.role === 'tool')).toBe(false);
    // ...and the turn COMPLETES rather than dying on the 400.
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { text: string; isError?: boolean } };
    expect(done.result.isError).toBeFalsy();
    expect(done.result.text).toContain('here is what the file says');
  });

  // ...but a parallel_tool_calls rejection must NOT be routed here: that is a REQUEST field with a cheaper,
  // LOSSLESS fix (drop the field). Flattening the history for it would throw away tool detail for nothing.
  it('does not flatten history when the gateway only rejects the parallel_tool_calls request field', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'parallel_tool_calls: Extra inputs are not permitted' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go');

    expect(bodies.length).toBe(2);
    expect(bodies[0].parallel_tool_calls).toBe(false);
    expect('parallel_tool_calls' in bodies[1]).toBe(false); // dropped — the lossless fix, not the lossy one
  });

  // ─── Prompt-cache prefix stability ───────────────────────────────────────────────────────────────────
  //
  // Every provider we reach caches automatically, by prefix, with nothing to opt into: the ONLY lever is
  // keeping model+tools+system byte-identical. Nothing observed that until now, and a coordinator turned
  // out to be running at 0% cache while its teammate hit 55% on the same work. These tests make the prefix
  // an asserted property rather than an assumption.

  it('keeps the cacheable prefix byte-identical across turns and across a tool loop', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    // Two turns, and the volatile per-turn context CHANGES between them — that is the whole point: project
    // context rides at the message tail, so it must not disturb anything before it.
    await runOneTurn(backend, 'turn 1', { projectContext: 'shared memory note A' } as TurnAttachments);
    await runOneTurn(backend, 'turn 2', { projectContext: 'shared memory note B (a teammate just wrote this)' } as TurnAttachments);

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    const prefixOf = (b: any) => JSON.stringify({ model: b.model, tools: b.tools, system: b.messages[0] });
    const prefixes = new Set(bodies.map(prefixOf));
    expect(prefixes.size).toBe(1); // one prefix, every request — nothing invalidated the cache
  });

  it('advertises the same tool list in plan mode as in act mode (a mode switch must not reprice the session)', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'plan it', { mode: 'plan' } as TurnAttachments);
    await runOneTurn(backend, 'do it', { mode: 'act' } as TurnAttachments);

    expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(bodies[1].tools));
  });

  // ─── Anthropic cache breakpoints ─────────────────────────────────────────────────────────────────────
  //
  // The assumption the whole cache design was built on — "every provider caches the prefix automatically,
  // there are no markers to send" — is true of DeepSeek, OpenAI, Kimi, GLM, Qwen, Grok and Gemini, and
  // FALSE of Anthropic. Claude caches nothing without an explicit cache_control breakpoint. Live, this
  // showed up as a deepseek teammate caching 55% of its prompt while the claude-opus-4-8 coordinator — the
  // longest-context, most expensive, runs-every-turn agent — cached exactly 0, forever.

  it('sends Anthropic cache breakpoints for a Claude model, on the system prompt and the last stable message', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    await runOneTurn(backend, 'hello', { projectContext: 'a teammate wrote a note' } as TurnAttachments);

    const msgs = bodies[0].messages;
    const system = msgs[0];
    expect(system.role).toBe('system');
    expect(system.content[0].cache_control).toEqual({ type: 'ephemeral' }); // caches tools + system
    // ...and the last message of the HISTORY, so the conversation is cached too. The volatile per-turn
    // context is appended AFTER it — the whole reason it was moved to the tail — so it stays outside.
    const marked = msgs.filter((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.cache_control));
    expect(marked).toHaveLength(2);
    const tail = msgs[msgs.length - 1];
    expect(tail.role).toBe('system');                                        // the volatile context...
    expect(String(JSON.stringify(tail))).not.toContain('cache_control');     // ...is NOT cached
  });

  it('sends no cache_control to a model that caches automatically', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ model: 'deepseek-v4-pro' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'hello');

    expect(JSON.stringify(bodies[0])).not.toContain('cache_control'); // DeepSeek needs nothing; sending it is just risk
  });

  // The model name is a PRIOR, never a verdict. A hardcoded /claude|opus|sonnet/ is the same mistake as a
  // hardcoded error-message regex — it works until the next model ships, and nobody can know in advance how
  // "muse-spark-1" or whatever comes next decides to cache. We don't have to know: caching is OBSERVABLE.
  // These two tests are the general mechanism, and neither model in them appears anywhere in the source.

  it('discovers that an UNKNOWN model needs explicit breakpoints, from the wire alone', async () => {
    const bodies: any[] = [];
    // A big, stable prefix, and the gateway reports zero cached — every turn. A hit was possible (the prefix
    // never changed) and permitted (the prompt is well past any minimum), so zero is a MEASUREMENT.
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse((init as any).body);
      bodies.push(body);
      const cachesNow = JSON.stringify(body).includes('cache_control'); // ...this model only caches when asked
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 20000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cachesNow ? 18000 : 0 } },
        }),
      };
    };
    const backend = new OpenAICompatBackend(makeConfig({ model: 'muse-spark-1' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    for (let i = 0; i < 4; i++) {
      await runOneTurn(backend, 'same question, stable prefix');
    }

    expect(JSON.stringify(bodies[0])).not.toContain('cache_control'); // starts on the safe default: send nothing
    // Two provable misses later it tries breakpoints — with no entry in any model list.
    const escalated = bodies.findIndex((b) => JSON.stringify(b).includes('cache_control'));
    expect(escalated).toBeGreaterThan(0);
    // ...and once they land, it keeps them.
    expect(JSON.stringify(bodies[bodies.length - 1])).toContain('cache_control');
  });

  it('reports — but does not silently accept — a route that caches under neither scheme', async () => {
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 20000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
        }),
      };
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'muse-spark-1' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });
    for (let i = 0; i < 7; i++) {
      await runOneTurn(backend, 'same question, stable prefix');
    }

    // It discovered the route does not cache automatically, tried explicit breakpoints, and got nothing
    // back from those either — so it says so. A missing cache does not error, does not degrade the answer,
    // and shows up nowhere. It only bills. If we don't say it, nobody finds out until the invoice.
    expect(logs.join('\n')).toContain('does not cache automatically');
    expect(logs.join('\n')).toContain('reports NO prompt caching');
    // But it does NOT withdraw the breakpoints. "Reports zero" is not "proves zero" — the gateway may be
    // caching and simply not reporting it, which is a failure mode this very operator has already shipped
    // (an entire model family's cache ratio missing from their config). Keeping them costs a few bytes;
    // dropping them on a guess would destroy a real 10x discount. When uncertain, never guess in the
    // direction that costs the user money.
    expect(JSON.stringify(bodies[bodies.length - 1])).toContain('cache_control');
  });

  // The wire, verbatim (2026-07-13, claude-opus-4-8 via unodetech). One turn, one tool call, two requests:
  //
  //     request 1 (cold): prompt_tokens = 20098   cached = 0
  //     request 2 (hot):  prompt_tokens =     2   cached = 0    ← the SAME conversation, plus a tool result
  //
  // A 20,000-token request reported as 2 tokens. The gateway is relaying Anthropic's `input_tokens` — the
  // UNCACHED REMAINDER — and dropping the cache_read counter that completes it. So the cache is WORKING, and
  // the report says the exact opposite.
  //
  // Believed at face value this is wrong in every dangerous direction at once: tokens and cost under-reported
  // ten-thousand-fold, a 20k conversation shown as 2 tokens of context, and the cache probe reading a PERFECT
  // HIT as "prompt too small to cache" — on its way to concluding the route cannot cache and (in an earlier
  // draft) withdrawing the very breakpoints that were making it work.
  it('reconstructs a usage report that is secretly counting in Anthropic units', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) {
        return ok({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20098, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } },
        });
      }
      return ok({
        choices: [{ message: { role: 'assistant', content: 'result() returns this.value' } }],
        usage: { prompt_tokens: 2, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 0 } },
      });
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });
    const events = await runOneTurn(backend, 'read src/calculator.js');

    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number } } };
    // The INVARIANT: the uncached part of the bill is EXACTLY what the gateway reported (20098 + 2). It holds
    // however the full prompt is reconstructed, which is why it — and not any particular arithmetic — is the
    // thing to pin. Everything else in request 2 was served from cache and must be credited, not lost.
    const input = done.result.usage!.inputTokens;
    const cached = done.result.usage!.cachedInputTokens ?? 0;
    expect(input - cached).toBe(20098 + 2);
    expect(cached).toBeGreaterThan(0);               // the cached prefix is on the books...
    expect(done.result.usage!.estimated).toBe(true); // ...and marked reconstructed, not billed
    expect(logs.join('\n')).toContain("reports usage in Anthropic's units");
    expect(logs.join('\n')).toContain('Your prompt cache IS working');
    // And the probe must NOT read this as a miss. It is the opposite of a miss.
    expect(logs.join('\n')).not.toContain('MISS');
    expect(logs.join('\n')).not.toContain('too small');
  });

  // Anthropic's ephemeral cache lives ~5 MINUTES, and a human takes longer than that to read a reply and
  // type the next question. So a real, working Claude route genuinely misses on the first request of nearly
  // every hand-typed turn — and the probe, counting those, would have announced "this gateway reports NO
  // prompt caching" about the very gateway we had just watched serve 21,020 cached tokens. A route that has
  // cached ONCE has proved it can; nothing later un-proves it. A miss after a proven hit is the clock.
  it('never calls a route uncacheable after it has been seen to cache — that is the TTL, not the gateway', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const usage = (prompt: number, cached: number) => ({ prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: cached } });
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      // Turn 1 hits (the cache is warm). Every turn after it misses — the user thought for six minutes.
      return ok({ choices: [{ message: { role: 'assistant', content: `reply ${n}` } }], usage: n === 1 ? usage(20000, 19000) : usage(20000, 0) });
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });
    for (let i = 0; i < 5; i++) {
      await runOneTurn(backend, 'a slow, hand-typed question');
    }

    const log = logs.join('\n');
    expect(log).toContain('the cached prefix EXPIRED');   // it names the real cause...
    expect(log).not.toContain('MISS');                    // ...and never counts it toward a verdict
    expect(log).not.toContain('NO prompt caching');       // ...so it never libels a working gateway
  });

  // Codex, v0.9.29 re-review — the UNDER-report path, and the one direction this codebase may not be wrong in.
  //
  // On a proven-inverted route the gateway reports only the UNCACHED remainder. Turn 1 establishes the full
  // prompt P. Turn 2 adds a large tool result D and the gateway reports D. The first reconstruction returned
  // `prompt = P` and `cached = P - D` — dropping D entirely. The uncached part of the bill is EXACTLY
  // `reportedPrompt`, so the only estimated quantity is `cached`, and cost rises with `cached` under any
  // rate: leaving D out under-reported the bill by the size of the file the agent had just read.
  it('does not lose the new delta when reconstructing an inverted usage report', async () => {
    // A REAL workspace, in a temp dir. makeConfig has no workingDirectory, so the backend falls back to
    // process.cwd() — the repo — and an agent with `write` would write into it for real. (It did: an earlier
    // draft of the test below left an 80 KB a.txt in the working tree, which the NEXT test then read,
    // silently inflating its numbers. A unit test that touches the repo is a bug, not a detail.)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-usage-'));
    await fs.writeFile(path.join(root, 'big.txt'), 'y'.repeat(40_000), 'utf8'); // ~10k tokens: the delta D

    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) { return ok({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: usage(20000) }); }
      if (n === 2) {
        // Turn 2 request 1: the cache hits, so the gateway reports only the small uncached remainder.
        return ok({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }] }, finish_reason: 'tool_calls' }], usage: usage(50) });
      }
      // Turn 2 request 2: the 40k-char file is now IN the request. The cache still hits, so the gateway
      // reports only the delta — and the delta is the file. The old code threw it away.
      return ok({ choices: [{ message: { role: 'assistant', content: 'read it' } }], usage: usage(10000) });
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read'], workingDirectory: root }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );

    await runOneTurn(backend, 'hello');
    const events = await runOneTurn(backend, 'read big.txt');

    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number; estimated?: boolean } } };
    const cached = done.result.usage!.cachedInputTokens ?? 0;
    const input = done.result.usage!.inputTokens;

    // INVARIANT, not arithmetic: the uncached part of the bill is EXACTLY what the gateway reported for
    // turn 2's two requests — 50 + 10,000. Everything else in those requests came from cache. This holds no
    // matter how the full prompt is reconstructed, which is precisely why it is the thing to assert.
    expect(input - cached).toBe(50 + 10_000);

    // And the reconstruction must SEE the 40,000-character file the agent just read — ~13k tokens on the
    // cautious estimator. It is IN the request, so it is billed, whether it was served from cache or not.
    // The first version of this code dropped it entirely, under-reporting the bill by the size of the file:
    // that version yields input ≈ 11,900 (the uncached report plus a small first request). Anything at or
    // below the file's own token count means it fell off the books again.
    expect(input).toBeGreaterThan(13_000);
    // Model history is deliberately capped before the provider request; this fixture must account for the
    // bounded result, not demand that the old unbounded 40k file re-enter context.
    expect(cached).toBeGreaterThan(3_000);
    expect(done.result.usage!.estimated).toBe(true); // reconstructed, and it says so
    await fs.rm(root, { recursive: true, force: true });
  });

  // Codex, v0.9.29 re-review #1 — a warm cache on the FIRST request has no floor to compare against.
  //
  // An agent restart re-hydrates its whole conversation from the snapshot. If the upstream cache is still
  // warm, request #1 is already a hit — and an inverted gateway reports only the tail. `lastPromptTokens`
  // is 0, so the exact "prompt shrank" test cannot fire, and the entire cached prefix leaves the accounting
  // without a trace. The independent witness is what we KNOW we sent.
  // ─── The usage state machine, enumerated ────────────────────────────────────────────────────────────
  //
  // Five review rounds found five bugs in this one function, and every one of them was a state COMBINATION I
  // had never enumerated: a floor that outlived a trim, a verdict that outlived a model switch, a proof
  // persisted without the thing it was proved against. Fixing each instance as it was named is how you get a
  // sixth. So enumerate the space and assert the INVARIANTS in every cell — the general fix for the general
  // mistake.
  //
  // reconcileUsage is driven directly here, on purpose: the state machine is the unit under test, not the
  // HTTP plumbing around it.
  describe('usage reconciliation — invariants across the whole state space', () => {
    // `msgs` is the number of conversation messages in the request — the append-only witness. Growing it is
    // an append; shrinking or rewriting it is a trim/compaction, which we can no longer prove anything from.
    type Obs = { estimate: number; reported: number; cache: number; msgs?: number };
    const drive = (backend: OpenAICompatBackend, seq: Obs[]): Array<{ prompt: number; cached: number }> =>
      seq.map((o, i) => {
        (backend as any).pendingRequestEstimate = o.estimate;
        const n = o.msgs ?? i + 1; // default: an ordinary, append-only conversation
        (backend as any).pendingRequestShape = { head: 'H', messages: Array.from({ length: n }, (_, k) => `m${k}`) };
        return (backend as any).reconcileUsage(o.reported, o.cache);
      });

    const fresh = (model = 'claude-opus-4-8'): OpenAICompatBackend =>
      new OpenAICompatBackend(makeConfig({ model }), (async () => ({ ok: true, status: 200, text: async () => '{}' })) as any,
        undefined, undefined, undefined, { retryBaseMs: 0 });

    // Every request the model was charged for, in every state. These two hold unconditionally, and together
    // they are the whole safety property: the gateway's uncached figure is authoritative and is never
    // discounted, and nothing we report can come out BELOW what it charged us for.
    it('never reports a prompt below what the gateway charged, and never discounts the uncached part', () => {
      const grows = [1000, 2000, 3000, 8000, 20000, 40000];
      const cases: Obs[][] = [
        // honest gateway, no caching: reported tracks the request
        grows.map((e) => ({ estimate: e, reported: e, cache: 0 })),
        // honest gateway that caches AND says so
        grows.map((e) => ({ estimate: e, reported: e, cache: Math.floor(e / 2) })),
        // inverted gateway: reports only the uncached tail, which collapses as the cache warms
        [{ estimate: 5000, reported: 5000, cache: 0 }, { estimate: 9000, reported: 30, cache: 0 }, { estimate: 20000, reported: 40, cache: 0 }],
        // a conversation that legitimately SHRINKS mid-stream (trim, compaction, flatten)
        [{ estimate: 30000, reported: 30000, cache: 0, msgs: 9 }, { estimate: 4000, reported: 4000, cache: 0, msgs: 2 }, { estimate: 5000, reported: 5000, cache: 0, msgs: 3 }],
        // an honest gateway whose tokenizer simply beats our guess (Codex's whitespace counterexample)
        [{ estimate: 4096, reported: 128, cache: 0 }, { estimate: 4200, reported: 130, cache: 0 }],
        // a gateway that starts inverted and is then FIXED by its operator mid-session
        [{ estimate: 5000, reported: 5000, cache: 0 }, { estimate: 9000, reported: 20, cache: 0 }, { estimate: 9500, reported: 9500, cache: 9000 }],
      ];
      for (const seq of cases) {
        const results = drive(fresh(), seq);
        results.forEach((r, i) => {
          expect(r.prompt).toBeGreaterThanOrEqual(seq[i].reported); // never below the gateway's own figure
          expect(r.prompt - r.cached).toBeGreaterThanOrEqual(0);
          expect(r.cached).toBeGreaterThanOrEqual(0);
        });
      }
    });

    // The one way a route may be declared inverted: the report SHRANK while the request did NOT. Anything
    // else — a smaller request, a tokenizer better than our estimate, a first observation — must leave an
    // honest gateway believed, exactly as reported.
    it('only ever declares a route inverted on a proof, never on a guess', () => {
      const honest: Array<[string, Obs[]]> = [
        ['tokenizer beats our estimate (whitespace)', [{ estimate: 4096, reported: 128, cache: 0 }, { estimate: 4200, reported: 130, cache: 0 }]],
        ['the conversation legitimately shrank', [{ estimate: 30000, reported: 30000, cache: 0, msgs: 9 }, { estimate: 4000, reported: 4000, cache: 0, msgs: 2 }]],
        ['a single observation, however small', [{ estimate: 50000, reported: 10, cache: 0 }]],
        ['it reports its cache, so its prompt is inclusive', [{ estimate: 9000, reported: 9000, cache: 8000 }, { estimate: 9500, reported: 300, cache: 0 }]],
      ];
      for (const [why, seq] of honest) {
        const results = drive(fresh(), seq);
        results.forEach((r, i) => {
          expect(`${why}: ${r.prompt}`).toBe(`${why}: ${seq[i].reported}`); // believed, verbatim
          expect(r.cached).toBe(seq[i].cache);                              // nothing conjured
        });
      }
      // ...and the proof itself DOES fire: the report shrank while the request grew.
      const proven = drive(fresh(), [{ estimate: 5000, reported: 5000, cache: 0 }, { estimate: 9000, reported: 25, cache: 0 }]);
      expect(proven[1].cached).toBeGreaterThan(0);
      expect(proven[1].prompt - proven[1].cached).toBe(25);
    });

    // The verdict is a fact about the GATEWAY. Move the same conversation to another model and none of it
    // travels — Smart Mode does exactly this, per turn.
    it('does not carry a verdict across a model switch', () => {
      const backend = fresh();
      drive(backend, [{ estimate: 5000, reported: 5000, cache: 0 }, { estimate: 9000, reported: 25, cache: 0 }]); // prove it on claude
      (backend as any).currentModel = 'deepseek-v4-pro';                                                          // Smart Mode moves the turn
      const [after] = drive(backend, [{ estimate: 9500, reported: 400, cache: 0 }]);
      expect(after.prompt).toBe(400); // believed exactly — DeepSeek did nothing wrong
      expect(after.cached).toBe(0);
    });
  });

  // Codex, v0.9.29 review — the missing-usage synthesis lived in the STREAMING path only.
  //
  // A stream that fails before any content falls back to chat(), which returns the gateway's JSON verbatim.
  // If that JSON has no `usage`, runTurn's `if (data.usage)` skipped the whole block: the turn finished at
  // ZERO tokens, zero cost, and unflagged. Same for any non-streaming gateway that simply omits usage.
  // Repairing money inside one transport is how the other transport gets missed — so it is done once, at the
  // point both pass through.
  it('books a turn honestly when the stream dies and the JSON fallback reports no usage at all', async () => {
    // The stream dies before a single delta — a connection reset, a 502 from a proxy, anything.
    const streamFetchFn: StreamFetchFn = async () => { throw new Error('ECONNRESET'); };
    let jsonCalls = 0;
    const jsonFetch: FetchFn = async () => {
      jsonCalls++;
      // The fallback answers, with NO usage field anywhere.
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'answered anyway' } }] }) } as any;
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), jsonFetch, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn
    );
    const events = await runOneTurn(backend, 'hi');
    const done = events.find((e) => e.kind === 'turn_complete') as any;

    expect(jsonCalls).toBeGreaterThan(0);                       // we really went down the fallback path
    expect(done.result.usage.inputTokens).toBeGreaterThan(0);   // ...and did NOT book the turn at zero
    expect(done.result.usage.outputTokens).toBeGreaterThan(0);
    expect(done.result.usage.estimated).toBe(true);             // reconstructed, and it says so
  });

  // The degenerate repair (`cached > prompt` — nonsense, cached is a subset) rewrites the gateway's number.
  // A rewritten number is no longer its bill; it is our estimate, and the Dashboard must be told.
  it('flags a repaired nonsense usage report as an estimate rather than showing it as a bill', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchFn: FetchFn = async () => ok({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 9 } }, // cached > prompt
    });
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');
    const done = events.find((e) => e.kind === 'turn_complete') as any;

    expect(done.result.usage.inputTokens).toBe(9);       // repaired upward: cached cannot exceed the prompt
    expect(done.result.usage.cachedInputTokens).toBe(9);
    expect(done.result.usage.estimated).toBe(true);      // ...and NOT presented as the gateway's own figure
  });

  // Codex, v0.9.29 re-review #7 — the "byte-exact" witness stored a 32-bit HASH of the bytes, not the bytes.
  // Collisions at 32 bits need no adversary: 'Aa' and 'BB' hash identically under h*31 (the full JSON forms
  // collide at ffd0572c), so a same-length rewrite of real user content could read as "unchanged", satisfy
  // the append-only witness, and latch the route `exclusive` off an honest gateway's honest report —
  // fabricating cache forever. The witness now stores the canonical strings themselves, compared with ===.
  //
  // This test goes through the REAL buildChatBody with the real colliding pair. Every earlier witness test
  // injected hand-written shapes directly, which is exactly why the hash between content and witness was
  // never once exercised. (Codex's finding was about the tests as much as the code.)
  it('does not mistake a hash-colliding rewrite (Aa→BB) for an append-only request', () => {
    const backend = new OpenAICompatBackend(
      makeConfig(), (async () => { throw new Error('this test never fetches'); }) as unknown as FetchFn,
      undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    const b = backend as any;

    b.history = [
      { role: 'user', content: 'Aa' },
      { role: 'assistant', content: 'the reply' },
    ];
    b.buildChatBody([], false);
    const first = b.pendingRequestShape as { head: string; messages: string[] };
    b.pendingRequestEstimate = 5000;
    b.reconcileUsage(5000, 0); // the route now holds lastReported=5000 and lastShape=first

    // A same-length rewrite of the user's message. Under the 32-bit hash these two witnesses were IDENTICAL.
    b.history = [
      { role: 'user', content: 'BB' },
      { role: 'assistant', content: 'the reply' },
      { role: 'user', content: 'next question' },
    ];
    b.buildChatBody([], false);
    const second = b.pendingRequestShape as { head: string; messages: string[] };
    expect(second.messages[0]).not.toBe(first.messages[0]); // the witness itself must SEE the rewrite

    // The gateway honestly reports the (smaller) rewritten request. A rewrite proves nothing about its
    // units, so it must be believed verbatim. The collision read this as "the report shrank while the
    // request grew", latched exclusive, and invented ~5k cached tokens that were never served.
    b.pendingRequestEstimate = 5200;
    expect(b.reconcileUsage(30, 0)).toEqual({ prompt: 30, cached: 0 });
  });

  // ─── Model-based conformance: the independent method ────────────────────────────────────────────────
  //
  // Hand-picked cases — even the "enumerated" block above — only cover what someone thought to encode, and
  // five review rounds proved the dangerous cases are exactly the unencoded ones. This suite removes the
  // author's imagination from the loop with two independent artifacts and a completeness argument:
  //
  //   1. A REFERENCE MODEL: a ~25-line transcription of the spec below, written from the prose, not from the
  //      implementation. Two independently written artifacts must agree EVERYWHERE they are compared.
  //   2. A COMPLETE finite abstraction: reconcileUsage's branching depends only on ORDER RELATIONS
  //      (cache > 0, reported > 0, reported < lastReported, estimated >= lastEstimate, estimated vs
  //      reported) — never on magnitudes — and its outputs are selections/differences of its inputs. So a
  //      small alphabet realizing every order-type, swept EXHAUSTIVELY over all sequences to depth 4, covers
  //      the whole machine. That is enumeration as COVERAGE, not enumeration as sampling.
  //   3. The abstraction claim itself (comparisons only) is the one thing taken on inspection, so a seeded
  //      fuzz with arbitrary magnitudes, route switches and real snapshot()/restore() cycles guards it.
  //
  // The spec (the reference model implements THIS text, not the code):
  //   Per route (baseUrl|model), semantics starts 'unknown'.
  //   - reportedCache > 0            => semantics = 'inclusive' (irrevocable proof; from any state).
  //   - else, from 'unknown' only: reported < lastReported AND the request is PROVABLY append-only (same
  //     model+tools, and the previous request's message list reproduced byte-identically at the head of this
  //     one) AND both reported and lastReported > 0
  //                                  => semantics = 'exclusive'.
  //     The append-only witness is EXACT — bytes, not tokens. The estimate must never be asked whether the
  //     request grew: ceil(ascii/3) is not order-preserving, so a request can lose a token while the estimate
  //     stays equal, and an honest gateway's honest one-token drop would latch the route as a liar forever.
  //     Codex caught that the FIRST version of this spec had encoded exactly that false premise — and that
  //     the reference model, transcribed from the spec, had faithfully copied it. Enumeration then proved
  //     only that the implementation conformed to a wrong assumption. Two independent artifacts cannot save
  //     you from a shared premise; only attacking the premise can.
  //     And a second premise, caught a round later: this sweep runs ABOVE the content→witness encoding (it
  //     injects abstract shapes directly), so its completeness silently assumes that encoding is INJECTIVE —
  //     distinct billable content, distinct witness. A 32-bit hash is not injective ('Aa'/'BB' collide under
  //     h*31), so the witness stores the canonical request bytes THEMSELVES, compared with `===`; the
  //     collision regression above drives the real builder with the real colliding pair to pin that down.
  //   Output: 'exclusive'  => prompt = max(estimated, reported), cached = prompt - reported;
  //           otherwise    => prompt = max(reported, reportedCache), cached = reportedCache. (The max exists
  //             for one degenerate input THIS SUITE forced the spec to define: a gateway reporting
  //             cached > prompt is talking nonsense — cached is a subset of prompt — and nonsense is repaired
  //             UPWARD, per the safety property. For all sane input it is `reported`, verbatim.)
  //   A restart zeroes lastReported/lastEstimate and keeps semantics. Safety, in every state:
  //   prompt >= reported; cached >= reportedCache; prompt - cached === max(0, reported - reportedCache).
  describe('usage reconciliation — reference-model conformance', () => {
    type Sem = 'unknown' | 'inclusive' | 'exclusive';
    class ReferenceModel {
      m = new Map<string, { sem: Sem; lastRep: number; lastShape?: string[] }>();
      restart(): void {
        for (const s of this.m.values()) { s.lastRep = 0; s.lastShape = undefined; }
      }
      clone(): ReferenceModel {
        const copy = new ReferenceModel();
        copy.m = new Map([...this.m].map(([k, v]) => [k, { ...v, lastShape: v.lastShape ? [...v.lastShape] : undefined }]));
        return copy;
      }
      step(route: string, estimated: number, reported: number, cache: number, shape: string[]): { prompt: number; cached: number } {
        let s = this.m.get(route);
        if (!s) { s = { sem: 'unknown', lastRep: 0 }; this.m.set(route, s); }
        const prev = s.lastShape;
        const appendOnly = !!prev && shape.length >= prev.length && prev.every((h, i) => h === shape[i]);
        if (cache > 0) {
          s.sem = 'inclusive';
        } else if (s.sem === 'unknown' && reported > 0 && s.lastRep > 0 && reported < s.lastRep && appendOnly) {
          s.sem = 'exclusive';
        }
        s.lastRep = reported; s.lastShape = shape;
        if (s.sem !== 'exclusive') { return { prompt: Math.max(reported, cache), cached: cache }; }
        const p = Math.max(estimated, reported);
        return { prompt: p, cached: p - reported };
      }
    }

    const ROUTE_MODELS = ['claude-opus-4-8', 'deepseek-v4-pro'];
    const fetchNever: FetchFn = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as FetchFn;
    // Spec item, load-bearing: in normal operation the runtime invariant guard NEVER fires. Without this
    // assertion the guard makes some mutations equivalent (it silently repairs their damage back to the
    // reference answer), and a mutation the tests cannot see is a mutation the next editor cannot see either.
    const internalViolations: string[] = [];
    const fresh = (): OpenAICompatBackend => {
      const b = new OpenAICompatBackend(makeConfig({ model: ROUTE_MODELS[0] }), fetchNever, undefined, undefined, undefined, { retryBaseMs: 0 });
      b.onEvent((e) => { if (e.kind === 'log' && e.line.includes('INTERNAL: a usage-accounting invariant')) { internalViolations.push(e.line); } });
      return b;
    };
    // The request SHAPE is now an input dimension in its own right — the append-only witness is the thing the
    // whole detector rests on, so the sweep must exercise it directly rather than assume it.
    const SHAPES: Record<string, string[]> = {
      empty: [],
      a: ['a'],
      ab: ['a', 'b'],       // append-only extension of `a`
      abc: ['a', 'b', 'c'], // ...and of `ab`
      ax: ['a', 'x'],       // same length as `ab`, but rewritten: NOT append-only
      b: ['b'],             // shorter and different: a trim/compaction
    };
    const driveOne = (b: OpenAICompatBackend, routeIdx: number, estimated: number, reported: number, cache: number, shape: string[]) => {
      (b as any).currentModel = ROUTE_MODELS[routeIdx];
      (b as any).pendingRequestEstimate = estimated;
      (b as any).pendingRequestShape = { head: 'H', messages: shape };
      return (b as any).reconcileUsage(reported, cache) as { prompt: number; cached: number };
    };
    const assertSafety = (r: { prompt: number; cached: number }, reported: number, cache: number, label: string): void => {
      const uncached = Math.max(0, reported - cache);
      if (r.prompt < reported || r.cached < cache || r.prompt - r.cached !== uncached) {
        throw new Error(`safety violated at ${label}: prompt=${r.prompt} cached=${r.cached} for reported=${reported} cache=${cache}`);
      }
    };

    // 1.27M paths of pure arithmetic take ~4s alone but have been measured at 8.8s under full-suite load
    // on Windows with a cold antivirus cache over a fresh node_modules; the invariant is agreement on
    // every sequence, not wall-clock, so the budget is sized to the slow case rather than the default 5s.
    it('agrees with the reference model on EVERY sequence to depth 4 over the order-type alphabet', { timeout: 30_000 }, () => {
      // {0,3,9} realizes every order relation (<, =, >, zero/nonzero) against a previous value from the same
      // set; cache branches only on zero/nonzero; and the six shapes realize every append-only relation to a
      // previous shape (extension, identity, rewrite, truncation, empty). 108 observations per step, ALL
      // sequences of length 1..3: 108 + 108^2 + 108^3 = 1.27M paths of pure arithmetic. Exhaustive.
      const V = [0, 3, 9];
      const C = [0, 2];
      const S = ['empty', 'a', 'ab', 'abc', 'ax', 'b']; // every append-only relation to a previous shape
      const obs: Array<[number, number, number, string]> = [];
      for (const e of V) for (const r of V) for (const c of C) for (const sh of S) obs.push([e, r, c, sh]);

      const backend = fresh();
      const acc = () => (backend as any).accounting as Map<string, { semantics: Sem; lastReported: number; lastShape?: unknown }>;
      const walk = (depth: number, ref: ReferenceModel, trail: string): void => {
        if (depth === 0) { return; }
        for (const [e, r, c, sh] of obs) {
          const saved = new Map([...acc()].map(([k, v]) => [k, { ...v }])); // backtrack point for the impl
          const refBranch = ref.clone();
          const got = driveOne(backend, 0, e, r, c, SHAPES[sh]);
          const want = refBranch.step('ref|0', e, r, c, SHAPES[sh]);
          const label = `${trail}(e=${e},r=${r},c=${c},s=${sh})`;
          if (got.prompt !== want.prompt || got.cached !== want.cached) {
            throw new Error(`diverged from reference at ${label}: impl ${got.prompt}/${got.cached}, ref ${want.prompt}/${want.cached}`);
          }
          assertSafety(got, r, c, label);
          walk(depth - 1, refBranch, label);
          (backend as any).accounting = saved;
        }
      };
      walk(3, new ReferenceModel(), '');
      expect(internalViolations).toEqual([]); // the guard never fired: the implementation needed no repairs
    });

    it('agrees with the reference model under arbitrary magnitudes, route switches, and restarts (seeded fuzz)', () => {
      // The exhaustive sweep is complete ONLY relative to the inspection claim that branching never uses
      // magnitudes. This guards that claim: 8,000 seeded-random sequences, values to 10^9, two routes, and
      // REAL snapshot()/restore() cycles against the model's one-line restart from the spec.
      let x = 20260713; // deterministic LCG — this suite must never be flaky
      const rnd = (): number => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
      const pick = (max: number): number => Math.floor(rnd() * max);
      const magnitudes = [0, 1, 2, 40, 128, 4096, 20_000, 999_999_937];

      for (let seq = 0; seq < 8000; seq++) {
        let backend = fresh();
        const ref = new ReferenceModel();
        const len = 1 + pick(10);
        for (let i = 0; i < len; i++) {
          if (rnd() < 0.12) {
            const snap = backend.snapshot();
            backend = fresh();
            backend.restore(snap);
            ref.restart();
          }
          const routeIdx = pick(2);
          const e = magnitudes[pick(magnitudes.length)];
          const r = magnitudes[pick(magnitudes.length)];
          const c = rnd() < 0.3 ? magnitudes[pick(magnitudes.length)] : 0;
          const shapeKey = Object.keys(SHAPES)[pick(Object.keys(SHAPES).length)];
          const got = driveOne(backend, routeIdx, e, r, c, SHAPES[shapeKey]);
          const want = ref.step(`ref|${routeIdx}`, e, r, c, SHAPES[shapeKey]);
          const label = `seq ${seq} step ${i} route ${routeIdx} (e=${e},r=${r},c=${c},s=${shapeKey})`;
          if (got.prompt !== want.prompt || got.cached !== want.cached) {
            throw new Error(`diverged from reference at ${label}: impl ${got.prompt}/${got.cached}, ref ${want.prompt}/${want.cached}`);
          }
          assertSafety(got, r, c, label);
        }
      }
      expect(internalViolations).toEqual([]); // normal operation, arbitrary inputs: the guard never fires
    });

    // The runtime layer: the same safety property is enforced in PRODUCTION, on every request, independent of
    // any test. Drive the guard with violating candidates directly — today's reconcileUsage never produces
    // one by construction, which is exactly why the guard exists: for the future edit that changes that.
    it('repairs an invariant-violating candidate upward, never letting it reach the bill', () => {
      const under = enforceUsageInvariants({ prompt: 100, cached: 0 }, 500, 0); // under-reports the prompt
      expect(under.violated).toBe(true);
      expect(under.result.prompt).toBeGreaterThanOrEqual(500);
      expect(under.result.prompt - under.result.cached).toBe(500); // the uncached part restored exactly

      const discounted = enforceUsageInvariants({ prompt: 900, cached: 100 }, 900, 300); // discounts reported cache
      expect(discounted.violated).toBe(true);
      expect(discounted.result.cached).toBeGreaterThanOrEqual(300);
      expect(discounted.result.prompt - discounted.result.cached).toBe(600);

      const fine = enforceUsageInvariants({ prompt: 900, cached: 300 }, 900, 300);
      expect(fine.violated).toBe(false);
      expect(fine.result).toEqual({ prompt: 900, cached: 300 });
    });
  });
  // Codex, v0.9.29 review #5 — the floor alone is unsound, and persisting it alone re-creates the heuristic.
  //
  // A long, HONEST conversation establishes a floor of 100k. Then the conversation legitimately shrinks — a
  // hard trim, a compaction, a shortened system prompt — and the snapshot is taken. On restore the request is
  // genuinely smaller, and an honest gateway honestly reports 60k. Against a floor of 100k with nothing to
  // compare it to, that reads as "the prompt shrank, therefore the gateway is lying" — and we latch a truthful
  // gateway as inverted and fabricate 40k of cache that never existed.
  //
  // The floor is only meaningful next to the size we measured it AGAINST. Persist both, and the shrink is
  // visible on the very first request after the restore.
  it('does not latch an honest gateway as inverted when the conversation legitimately shrank before the snapshot', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchFn: FetchFn = async () => ok({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 60_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    });
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });

    // The snapshot carries NO numeric baseline — that is the redesign. There is therefore no stale floor for
    // an honestly-smaller prompt to be measured against, and nothing to mistake an honest report for a lie.
    backend.restore({
      version: 1,
      messages: [{ role: 'user', content: 'a'.repeat(40_000) }] as any, // the conversation has since been trimmed
      // Nothing numeric survives the snapshot, so there is no stale floor to mistake an honest report for a
      // lie. The route was never proven exclusive, so it is simply believed.
      usageBaseline: { routes: [] },
    });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const events = await runOneTurn(backend, 'go');
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number; estimated?: boolean } } };

    expect(logs.join('\n')).not.toContain("Anthropic's units"); // the gateway is truthful and stays believed
    expect(done.result.usage!.inputTokens).toBe(60_000);        // exactly what it reported
    expect(done.result.usage!.cachedInputTokens).toBe(0);       // no 40k of cache conjured from a stale floor
    expect(done.result.usage!.estimated).toBeFalsy();
  });

  // Codex, v0.9.29 review #6 — the verdict belongs to the ROUTE, not the agent.
  //
  // Smart Mode picks a model per turn; a fallback escalates; an Agent Builder edit changes provider. The same
  // conversation then lands on an ordinary OpenAI-compatible model while carrying a verdict proved about
  // Claude-via-gateway. Reused blindly, it fabricates cache hits on a gateway doing nothing wrong.
  it('does not carry an inverted-usage verdict onto a different model', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchFn: FetchFn = async () => ok({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    });
    const backend = new OpenAICompatBackend(makeConfig({ model: 'deepseek-v4-pro' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    // A verdict proved on the CLAUDE route, restored onto an agent now running DeepSeek. It must not apply.
    backend.restore({
      version: 1,
      messages: [{ role: 'user', content: 'hi' }] as any,
      usageBaseline: { routes: [{ route: 'https://ai.weroam.xyz/v1|claude-opus-4-8', semantics: 'exclusive' }] },
    });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const events = await runOneTurn(backend, 'go');
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number; estimated?: boolean } } };

    expect(done.result.usage!.inputTokens).toBe(500);      // DeepSeek is believed, not "reconstructed" to 90k
    expect(done.result.usage!.cachedInputTokens).toBe(0);
    expect(done.result.usage!.estimated).toBeFalsy();
  });

  it('carries the proven usage baseline across a restart, so a warm cache is not lost on request #1', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchFn: FetchFn = async () => ok({
      choices: [{ message: { role: 'assistant', content: 'sure' } }],
      // Restart, still-warm upstream cache: the gateway reports only the uncached tail of request #1.
      usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    });
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    // Exactly what SessionManager restores: the conversation AND what the previous session PROVED about this
    // gateway's accounting. The proof is a fact, not a guess — and it is the only thing that can close this
    // window, because no character heuristic can tell an inverted gateway from an honest tokenizer.
    backend.restore({
      version: 1,
      messages: [{ role: 'user', content: 'a'.repeat(60_000) }, { role: 'assistant', content: 'ok' }] as any,
      // Only the FACT is carried: this route reports the UNCACHED remainder. No numeric baseline exists to
      // go stale, which is the entire point of the redesign.
      usageBaseline: { routes: [{ route: 'https://ai.weroam.xyz/v1|claude-opus-4-8', semantics: 'exclusive' }] },
    });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const events = await runOneTurn(backend, 'carry on');
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number; estimated?: boolean } } };

    // 40 tokens is what MISSED. The restored conversation was served from cache and must stay on the books —
    // believing the 40 would have erased it.
    expect(done.result.usage!.inputTokens).toBeGreaterThan(20_000);
    expect(done.result.usage!.cachedInputTokens).toBeGreaterThan(20_000);
    expect(done.result.usage!.estimated).toBe(true); // ...and it is flagged as reconstructed, not billed
  });

  // Codex's counterexample, v0.9.29 re-review. THE reason the first request may not be adjudicated by a
  // character heuristic: our estimate is not an independent witness, it is another guess about the same
  // quantity. Restore 16k of ASCII whitespace — we estimate ~4,096 tokens; an HONEST gateway whose tokenizer
  // collapses whitespace runs reports 128, with cached: 0. The old "reported * 4 < estimated" test fired,
  // latched invertedUsage PERMANENTLY, and fabricated a 4,000-token cache hit that never happened —
  // poisoning the cost, the hit rate, and everCached, on a gateway doing nothing wrong.
  it('never calls an honest gateway inverted just because its tokenizer beats our guess', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchFn: FetchFn = async () => ok({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 128, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    });
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });
    backend.restore({ version: 1, messages: [{ role: 'user', content: ' '.repeat(16_384) }] as any }); // no baseline: nothing was ever proven
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const events = await runOneTurn(backend, 'hi');
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number; estimated?: boolean } } };

    expect(logs.join('\n')).not.toContain("Anthropic's units"); // no verdict was reached, because none could be
    expect(done.result.usage!.inputTokens).toBe(128);           // the gateway is believed, exactly as reported
    expect(done.result.usage!.cachedInputTokens).toBe(0);       // no cache hit is conjured from a guess
    expect(done.result.usage!.estimated).toBeFalsy();           // and nothing is flagged as reconstructed
  });

  // Codex, v0.9.29 re-review #2 — the delta is an ESTIMATE, and the estimate had no guarded direction.
  //
  // 4 chars/token is an English-ASCII rule. CJK runs ~1–1.5 chars/token, so a flat /4 under-counts Chinese
  // by three to four times. Under-counting the delta under-credits `cached`, and cost rises with `cached`
  // under any rate — so the bill comes out light. Every existing test used ASCII, which sits right on the
  // 4:1 rule and therefore could never have caught this.
  it('does not under-count a CJK delta — the estimate must err upward, not downward', async () => {
    const cjk = '这是一段中文的工具输出内容。'.repeat(2000); // ~28k chars; a flat /4 would call it ~7k tokens
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-cjk-'));
    await fs.writeFile(path.join(root, 'big.md'), cjk, 'utf8');

    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      // A SMALL anchor on purpose: a big one would swamp the delta and the assertion would pass either way.
      if (n === 1) { return ok({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: usage(5000) }); }
      if (n === 2) {
        return ok({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.md"}' } }] }, finish_reason: 'tool_calls' }], usage: usage(50) });
      }
      return ok({ choices: [{ message: { role: 'assistant', content: 'read' } }], usage: usage(100) });
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read'], workingDirectory: root }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );

    await runOneTurn(backend, 'hello');
    const events = await runOneTurn(backend, 'read big.md');
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number } } };

    // Turn 2 credits the anchor (~5,000) twice, plus the file once. With the flat /4 rule the 28,000-char
    // CJK file counts as ~7,000 tokens → cached ≈ 17,000. Counting non-ASCII properly it is ~28,000 →
    // cached ≈ 38,000. The gap between them IS the half of the file that used to fall off the bill.
    const cached = done.result.usage!.cachedInputTokens ?? 0;
    expect(cached).toBeGreaterThan(25_000);
    await fs.rm(root, { recursive: true, force: true });
  });

  // Codex, v0.9.29 review — BLOCKING, and the existing shrink test could not see it.
  //
  // On a `write_file` turn the entire file lives in `tool_calls[].function.arguments` and `content` is null.
  // estimateMessages counted only `content`, so when the degradation ladder FLATTENED the tool history — a
  // real shrink of tens of thousands of tokens — our estimate did not fall. It ROSE, because the flatten
  // leaves a short text note behind. The floor therefore survived a genuine shrink, the next honestly-smaller
  // prompt was read as an Anthropic cache collapse, and we invented cached tokens that were never served:
  // inflated hit rate, inflated input, inflated cost, and `everCached` latched true off a fabricated hit —
  // permanently disabling the probe's ability to ever call a route uncacheable.
  //
  // The old test shrank history by clearing CONTENT, which the estimate could see. This one shrinks it the
  // way the ladder actually does.
  it('abandons the prompt floor when a flatten drops tool_calls, whose payload the estimate could not see', async () => {
    const bigWrite = 'x'.repeat(80_000); // a real write_file argument: ~20k tokens, none of it in `content`
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    let n = 0;
    const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) {
        return ok({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: bigWrite }) } }] }, finish_reason: 'tool_calls' }],
          usage: usage(4500),
        });
      }
      if (n === 2) {
        // Turn 1, request 2: the big write is now IN the history, so the prompt grows honestly. Floor = 25000.
        return ok({ choices: [{ message: { role: 'assistant', content: 'written' } }], usage: usage(25000) });
      }
      // Turn 2, after the flatten dropped the tool_calls payload: this prompt is HONESTLY much smaller.
      return ok({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: usage(4000) });
    };
    const logs: string[] = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-flatten-')); // the write is REAL — keep it out of the repo
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read', 'write'], workingDirectory: root }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });

    await runOneTurn(backend, 'write the file');
    (backend as any).history = flattenToolHistory((backend as any).history); // exactly what ladder step 3/4 does
    const events = await runOneTurn(backend, 'and now?');

    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number } } };
    expect(done.result.usage!.inputTokens).toBe(4000);          // the honest number, NOT floored back up to 25000
    expect(done.result.usage!.cachedInputTokens).toBeFalsy();   // and no 21,000-token cache hit conjured out of a flatten
    expect(logs.join('\n')).not.toContain("Anthropic's units");
    await fs.rm(root, { recursive: true, force: true });
  });

  // The reconstruction rests on "the conversation only grows" — and SIX code paths shrink it (hard trim,
  // rolling-summary compaction, two flatten recoveries, the XML degradation, the image strip). If the floor
  // survives one of those, a legitimately smaller prompt is read as a cache hit and we invent tens of
  // thousands of tokens that were never served from anywhere — inflating the reported hit rate and
  // UNDER-reporting the bill. So the floor watches our own estimate of the conversation and abandons itself
  // when that shrinks, rather than trusting six call sites to remember to say so.
  it('abandons the prompt floor when the conversation shrinks, whoever shrank it', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      return ok({ choices: [{ message: { role: 'assistant', content: `reply ${n}` } }], usage: usage(n === 1 ? 20000 : 500) });
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });

    await runOneTurn(backend, 'x'.repeat(60_000)); // a big turn: the gateway honestly reports 20,000 tokens
    (backend as any).history = [(backend as any).history[0]]; // ...then something drops the conversation
    const events = await runOneTurn(backend, 'y');            // and the next prompt is honestly SMALL

    const done = events.find((e) => e.kind === 'turn_complete') as { result: { usage?: { inputTokens: number; cachedInputTokens?: number } } };
    expect(done.result.usage!.inputTokens).toBe(500);      // believed, not floored to 20,000
    expect(done.result.usage!.cachedInputTokens).toBeFalsy(); // and NOT credited as a 19,500-token cache hit
    expect(logs.join('\n')).not.toContain("Anthropic's units");
  });

  // The exact field shape (2026-07-13, claude-opus-4-8 via unodetech): turn 1 makes a tool call, so TWO
  // requests; turn 2 answers directly, so ONE. The gateway reports cached: 0 every time, and the prefix
  // never moves. That is three requests, two of which had a repeated prefix — the verdict must land.
  it('reaches the no-caching verdict on a Claude route that silently ignores the breakpoints', async () => {
    const usage = { prompt_tokens: 7000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } };
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    let n = 0;
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }], usage });
      }
      return ok({ choices: [{ message: { role: 'assistant', content: 'here you go' } }], usage });
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'claude-opus-4-8', allowedTools: ['read'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });

    await runOneTurn(backend, 'read the file and write me a list'); // 2 requests
    await runOneTurn(backend, 'and where should divide live?');     // 1 request

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0])).toContain('cache_control'); // the Opus prior sends them from request 1

    // It narrates every provable miss on the way to the verdict. Request 1 establishes the prefix (a miss is
    // not yet possible); requests 2 and 3 re-send it unchanged and get nothing back.
    const log = logs.join('\n');
    expect(log).toContain('prompt-cache MISS 1/2');
    expect(log).toContain('prompt-cache MISS 2/2');
    expect(log).toContain('NO prompt caching');

    // ...and it KEEPS sending the breakpoints. "Reports no cache" is not "proves no cache": the gateway may
    // be caching and simply not mapping the upstream counter back into the OpenAI usage fields — this
    // operator has already been caught with a whole model family's cache ratio missing from their config.
    // Keeping the breakpoints on a route that truly cannot cache costs a few bytes; dropping them on one
    // that silently can would destroy a 10x discount with our own hands. Never guess in the direction that
    // costs the user money.
    await runOneTurn(backend, 'one more');
    expect(JSON.stringify(bodies[3])).toContain('cache_control');
  });

  it('never mistakes a small prompt for a broken cache', async () => {
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          // Under every provider's minimum cacheable size, so 0 is CORRECT here and means nothing.
          usage: { prompt_tokens: 300, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
        }),
      };
    };
    const backend = new OpenAICompatBackend(makeConfig({ model: 'muse-spark-1' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    for (let i = 0; i < 5; i++) {
      await runOneTurn(backend, 'hi');
    }

    expect(bodies.every((b) => !JSON.stringify(b).includes('cache_control'))).toBe(true); // no false escalation
  });

  it('drops cache_control and says what it costs when the gateway will not relay it', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'messages.0.content.0.cache_control: Extra inputs are not permitted' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const logs: string[] = [];
    const backend = new OpenAICompatBackend(makeConfig({ model: 'claude-opus-4-8' }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    backend.onEvent((e) => { if (e.kind === 'log') { logs.push(e.line); } });
    await runOneTurn(backend, 'hello');

    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[0])).toContain('cache_control');     // tried...
    expect(JSON.stringify(bodies[1])).not.toContain('cache_control'); // ...dropped, and the turn survives
    // The failure mode here is silence: no caching does not break anything, it just bills. Say so.
    expect(logs.join('\n')).toContain('billed in full');
  });

  // ─── The degradation ladder: recovering WITHOUT understanding the error ──────────────────────────────
  //
  // Every targeted handler is regex(error text) → repair, which does not scale: each gateway invents its own
  // wording, so an unforeseen phrase is an unrecoverable hard failure. These tests use wordings NO regex in
  // this file matches, on purpose. If someone later "fixes" the ladder by adding a regex for them, these
  // tests still pass for the wrong reason — so each one asserts the SHAPE that came back, not the log.

  it('recovers from a rejection whose wording no handler recognizes, by simplifying the request', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      // Gibberish, by design: it names no field and matches no regex we ship.
      if (n === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: '请求参数校验失败：字段组合不受支持 (code 40031)' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go');

    expect(bodies.length).toBe(2);                              // it retried instead of hard-failing
    expect(bodies[0].parallel_tool_calls).toBe(false);
    expect('parallel_tool_calls' in bodies[1]).toBe(false);     // step 1: optional request fields dropped
  });

  it('falls all the way back to the XML tool protocol for a gateway that cannot take native tools at all', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse((init as any).body);
      bodies.push(body);
      // This gateway refuses ANY request carrying native tools — and says so in a way we don't parse.
      if (body.tools) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'schema violation at $.tools (E_UNSUPPORTED_1147)' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'answered without native tools' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'go');

    const final = bodies[bodies.length - 1];
    expect(final.tools).toBeUndefined();               // native tools abandoned...
    const system = final.messages.find((m: any) => m.role === 'system');
    expect(String(system.content)).toContain('read_file'); // ...but the tools are still THERE, via the XML guide
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { isError?: boolean } };
    expect(done.result.isError).toBeFalsy();
  });

  // The guard rail. The ladder is blind to wording, so it must never be let loose on a 4xx that MEANS
  // something: simplifying the body cannot fix a full context window or a dead API key, and four wasted
  // requests followed by a mangled report is strictly worse than telling the user the truth immediately.
  it('does NOT degrade a context-length 400 — that needs less history, not a simpler shape', async () => {
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. However, you requested 131204." } }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'go');

    expect(bodies.length).toBe(1); // one request, then the truth — no ladder walk
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { text: string; isError?: boolean } };
    expect(done.result.isError).toBe(true);
    expect(done.result.text).toContain('maximum context length');
  });

  // Codex, v0.9.29 review. The guard filtered by WORDING, and `Your organization must be verified to use
  // this model` matches none of the semantic phrases — so a 403 was taken for a request-shape problem and the
  // ladder walked all the way down to flattening the tool history, destroying the conversation to "fix" an
  // account that simply is not verified. The status code is the part a gateway cannot phrase creatively:
  // only 400 and 422 are ABOUT the body. Nothing else is.
  it('does NOT touch the request body on a 403 — an unverified org is not a bad request', async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      return { ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'Your organization must be verified to use this model.' } }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'go');

    expect(bodies.length).toBe(2); // the 403 ends it — no ladder walk
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { text: string; isError?: boolean } };
    expect(done.result.isError).toBe(true);
    expect(done.result.text).toContain('organization must be verified'); // the real problem, reported intact
    // ...and the tool history is untouched, not flattened to "fix" an account problem.
    expect(backend.snapshot().messages.some((m: any) => Array.isArray(m.tool_calls))).toBe(true);
  });

  it('does NOT degrade an auth/credit 400 — a simpler body cannot buy credit', async () => {
    const bodies: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Insufficient balance. Please top up your account.' } }) };
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'go');

    expect(bodies.length).toBe(1);
    const done = events.find((e) => e.kind === 'turn_complete') as { result: { text: string; isError?: boolean } };
    expect(done.result.isError).toBe(true);
    expect(done.result.text).toContain('Insufficient balance');
  });

  // Some gateways/models (e.g. claude-sonnet-4-6 via the translation) reject a conversation that ends with
  // a tool_result/assistant turn ("no assistant prefill; must end with a user message"). Self-heal by
  // appending a user message so the convo ends with user, then retry.
  it('self-heals an assistant-prefill 400 by ending the conversation with a user message', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      if (n === 2) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'model claude-sonnet-4-6 does not support assistant message prefill; the conversation must end with a user message' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'go');
    expect(bodies.length).toBe(3); // tool call → continue 400 → self-heal → retry
    const retry = bodies[2].messages;
    expect(retry[retry.length - 1].role).toBe('user');               // conversation now ends with a user message
    expect(retry.some((m: any) => m.role === 'tool')).toBe(false);   // tool history flattened (no trailing tool_result)
    // No two consecutive same-role turns (valid Anthropic alternation after the merge).
    for (let k = 1; k < retry.length; k++) { expect(retry[k].role).not.toBe(retry[k - 1].role); }
  });

  // Thinking-model gateways 400 when a prior assistant turn's reasoning_content is missing — same flatten
  // recovery as the prefill case (the reviewer hit this on unodetech).
  it('recovers a rejected trailing system context, keeps policy context ephemeral, and latches the compatible shape', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }] });
      }
      if (n === 2) {
        // Existing, known conversation-shape wording: do not invent an unprobed "system role" regex.
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'conversation must end with a user message' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: n === 3 ? 'first complete' : 'second complete' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const firstEvents = await runOneTurn(backend, 'inspect the workspace', { projectContext: 'team-note-one' });

    // The dangerous live shape is real: the tool-result request originally ended tool -> system.
    expect(bodies[1].messages.at(-2)).toMatchObject({ role: 'tool' });
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'system' });

    // Recovery changes the actual retry shape, not only persisted history: no trailing system remains and
    // the exact project context reaches the model in the request-only, explicitly marked user content.
    const retry = bodies[2].messages;
    expect(retry.at(-1).role).not.toBe('system');
    const contextUser = [...retry].reverse().find((message: any) => message.role === 'user');
    expect(contextUser.content).toContain('SYSTEM-AUTHORED PROJECT CONTEXT');
    expect(contextUser.content).toContain('team-note-one');
    expect(JSON.stringify(backend.snapshot().messages)).not.toContain('team-note-one');
    expect(firstEvents).toContainEqual(expect.objectContaining({
      kind: 'log',
      line: expect.stringMatching(/rejected the trailing system context.*reduces prompt-cache reuse/i),
    }));

    // Session latch: a later turn never probes the rejected trailing-system shape again.
    await runOneTurn(backend, 'continue', { projectContext: 'team-note-two' });
    const later = bodies[3].messages;
    expect(later.at(-1).role).not.toBe('system');
    expect(JSON.stringify(later)).toContain('team-note-two');
    expect(bodies).toHaveLength(4);
  });

  it('self-heals a "reasoning_content must be passed back" 400 by flattening + retrying', async () => {
    const ok200 = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return ok200({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      }
      if (n === 2) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API.' } }) };
      }
      return ok200({ choices: [{ message: { role: 'assistant', content: 'reviewed: PASS' } }] });
    };
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'review it');
    expect(bodies.length).toBe(3); // tool call → reasoning_content 400 → flatten self-heal → retry
    expect(bodies[2].messages.some((m: any) => m.role === 'tool')).toBe(false); // flattened
  });

  // Model-variance: a Claude model calls its native `Edit` (file_path/old_string/new_string) tool name,
  // which doesn't exist here. The alias shim maps it to apply_edit + args so the edit just lands.
  it('aliases a Claude-style Edit tool call to apply_edit and edits the real file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-alias-'));
    await fs.writeFile(path.join(root, 'README.md'), 'line one\nlast line\n', 'utf8');
    const editTurn = {
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'README.md', old_string: 'last line', new_string: 'last line — Canada vs Qatar' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const doneTurn = { choices: [{ message: { role: 'assistant', content: 'Edited.' } }] };
    const { fetchFn } = scriptedFetch([editTurn, doneTurn]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: root }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'add Canada vs Qatar to the last line');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('line one\nlast line — Canada vs Qatar\n');
  });

  // With teammates present, native self-do tools require a host-selected coordinator attempt. Keeping the
  // tool in the set lets the refusal explain the contract path instead of looking like model/tool variance.
  it('gates the PM\'s own write tools until a strict contract authorises coordinator execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-gate-'));
    await fs.writeFile(path.join(root, 'README.md'), 'hello\n', 'utf8');
    const editTurn = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edit', arguments: JSON.stringify({ path: 'README.md', old_string: 'hello', new_string: 'hi' }) } }] }, finish_reason: 'tool_calls' }] };
    const { fetchFn, requests } = scriptedFetch([editTurn, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const team = new TeamTools('pm', { list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'idle' }, { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' }], resolve: () => ({ id: 'dev' }) }, new MessageBus());
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: root }), fetchFn, team, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'edit it');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('hello\n'); // gated → file unchanged
    expect(JSON.stringify(requests[1].messages.find((m: any) => m.role === 'tool'))).toMatch(/strict task contract/);
  });

  it('never turns repeated self-do attempts into authority without a contract', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-gate-escape-'));
    await fs.writeFile(path.join(root, 'README.md'), 'hello\n', 'utf8');
    // Distinct new_string values prove varying the call cannot recreate the removed bounce-count bypass.
    const editTurn = (to: string) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edit', arguments: JSON.stringify({ path: 'README.md', old_string: 'hello', new_string: to }) } }] }, finish_reason: 'tool_calls' }] });
    // All three stay refused: persistence is not an authority source.
    const { fetchFn, requests } = scriptedFetch([editTurn('a'), editTurn('b'), editTurn('hi'), { choices: [{ message: { role: 'assistant', content: 'done' } }] }]);
    const team = new TeamTools('pm', { list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'idle' }, { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' }], resolve: () => ({ id: 'dev' }) }, new MessageBus());
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: root }), fetchFn, team, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'edit it');
    const lastTool = (i: number) => JSON.stringify(requests[i].messages.filter((m: any) => m.role === 'tool').at(-1));
    expect(lastTool(1)).toMatch(/strict task contract/);
    expect(lastTool(2)).toMatch(/strict task contract/);
    expect(lastTool(3)).toMatch(/strict task contract/);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('lets the PM\'s write tools execute as a fallback when it has NO teammates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-gate-solo-'));
    await fs.writeFile(path.join(root, 'README.md'), 'hello\n', 'utf8');
    const editTurn = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edit', arguments: JSON.stringify({ path: 'README.md', old_string: 'hello', new_string: 'hi' }) } }] }, finish_reason: 'tool_calls' }] };
    const { fetchFn } = scriptedFetch([editTurn, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const team = new TeamTools('pm', { list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'idle' }], resolve: () => undefined }, new MessageBus()); // only self → no teammates
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: root }), fetchFn, team, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'edit it');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('hi\n'); // no teammate → executes
  });

  // Model-variance: a Claude model calling `Bash`/`Read` gets mapped to run_command/read_file (the args
  // key `command`/`file_path` is shimmed) instead of an "unknown tool" error.
  it('aliases Read (file_path arg) to read_file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-alias-r-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'secret-token-42', 'utf8');
    const readTurn = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'note.txt' }) } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const { fetchFn, requests } = scriptedFetch([readTurn, { choices: [{ message: { role: 'assistant', content: 'done' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: root }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'read note.txt');
    // The tool result fed back to the model contains the file content (alias resolved + executed).
    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('secret-token-42');
  });

  // Robustness: a model that keeps re-issuing the SAME failing tool call (e.g. write_file with empty
  // args) is circuit-broken — executed a couple of times, then blocked, then the turn ends, instead of
  // burning every tool iteration on the same dead end.
  it('circuit-breaks a repeated identical failing tool call instead of looping to the iteration cap', async () => {
    const failing = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const { fetchFn, requests } = scriptedFetch([failing]); // model re-emits the same bad call forever
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['write'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 } // default maxToolIterations = 12
    );
    const events = await runOneTurn(backend, 'go');

    // Runs it twice (fail, fail), blocks the next two, then ends the turn — well short of the 12 cap.
    expect(requests.length).toBe(4);
    expect(events.some((e) => e.kind === 'tool_result' && (e as { summary?: string }).summary === 'blocked: repeated failing call')).toBe(true);
  });

  // Anti-spin: a model that keeps re-issuing the SAME *succeeding* call (the PM looping list_dir/list_agents
  // instead of delegating) used to burn all 12 iterations and stall. Now it's blocked after REPEAT_CALL_LIMIT.
  it('stops a repeated identical SUCCEEDING tool call instead of looping to the iteration cap', async () => {
    const spin = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const { fetchFn, requests } = scriptedFetch([spin]); // model re-emits the same succeeding call forever
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 } // default cap = 12
    );
    const events = await runOneTurn(backend, 'spin please');

    expect(requests.length).toBeLessThan(12); // stopped well before the cap
    expect(events.some((e) => e.kind === 'tool_result' && (e as { summary?: string }).summary === 'blocked: repeated identical call')).toBe(true);
  });

  // Robustness: reasoning_effort is model-specific (e.g. 'max' on deepseek vs Kimi's xhigh/…/none).
  // If the gateway rejects the value, drop it and retry instead of failing the whole turn.
  it('drops reasoning_effort and retries when the model rejects the value', async () => {
    const requests: any[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.reasoning_effort) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: '***.effort: Invalid option: expected one of "xhigh"|"high"|"medium"|"low"|"minimal"|"none"', code: 400 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi', { modelParams: { reasoning_effort: 'max' } });

    expect(requests[0].reasoning_effort).toBe('max');     // first try sent it
    expect(requests[1].reasoning_effort).toBeUndefined();  // retry dropped it
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ result: { text: 'ok', isError: false } });
  });

  // Weak-model robustness: a model that announces an action ("let me check:") but issues no tool call
  // is nudged to follow through in the same turn, instead of stopping half-done.
  it('does not infer a continuation from a model action announcement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-announce-'));
    await fs.writeFile(path.join(dir, 'foo.txt'), 'BODY', 'utf8');

    const announce = { choices: [{ message: { role: 'assistant', content: '让我查一下 foo.txt：' } }], usage: { prompt_tokens: 2, completion_tokens: 2 } };
    const toolCall = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo.txt"}' } }] }, finish_reason: 'tool_calls' }] };
    const finalAnswer = { choices: [{ message: { role: 'assistant', content: 'It says BODY.' } }] };
    const { fetchFn, requests } = scriptedFetch([announce, toolCall, finalAnswer]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: dir }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    const events = await runOneTurn(backend, 'what version');

    // Instead of stopping after the announcement, it was nudged → made the tool call → answered.
    expect(requests.length).toBe(1);
    expect(events.find((e) => e.kind === 'tool_use')).toBeUndefined();

    await fs.rm(dir, { recursive: true, force: true });
  });

  // Design C: with toolProtocol 'xml', the model calls tools as XML in its content. The backend must
  // parse it, run the tool, feed the result back as a user message, and NOT advertise native tools —
  // instead injecting the tool guide into the system prompt.
  it('XML tool protocol: parses an XML tool call, runs it, sends no native tools + a prompt guide', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-xml-proto-'));
    await fs.writeFile(path.join(dir, 'foo.txt'), 'XMLBODY', 'utf8');

    const xmlCall = {
      choices: [{ message: { role: 'assistant', content: '<use_tool>\n<tool>read_file</tool>\n<path>foo.txt</path>\n</use_tool>' } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    };
    const finalAnswer = {
      choices: [{ message: { role: 'assistant', content: 'I read it.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    const { fetchFn, requests } = scriptedFetch([xmlCall, finalAnswer]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'], toolProtocol: 'xml', workingDirectory: dir }),
      fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }
    );
    const events = await runOneTurn(backend, 'read foo');

    // The XML call was parsed and executed.
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'read_file' });
    // No native tools advertised; the XML tool guide rode in the system prompt instead.
    expect(requests[0].tools).toBeUndefined();
    const sys = requests[0].messages.find((m: { role: string }) => m.role === 'system');
    expect(sys.content).toContain('XML tool calling protocol');
    // The tool result was fed back as a user text block (not a role:'tool' message).
    expect(requests[1].messages.some(
      (m: { role: string; content?: string }) => m.role === 'user' && String(m.content).includes('[Tool result: read_file]\nXMLBODY')
    )).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  // F8: empty cold-start turn (200 OK, no content, no tool_calls) is retried once.
  it('retries once when the first response is an empty turn, then returns the real answer', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
      { choices: [{ message: { role: 'assistant', content: 'real answer' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');

    expect(requests).toHaveLength(2); // empty -> retry -> success
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ result: { text: 'real answer', isError: false } });
  });

  it('does NOT retry when the first response already has content', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'straight answer' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    await runOneTurn(backend, 'hi');
    expect(requests).toHaveLength(1);
  });

  it('retries an empty turn at most once (a second empty is accepted, not looped)', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
      { choices: [{ message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');
    expect(requests).toHaveLength(2); // one retry only, then accept the empty result
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ result: { isError: false } });
  });

  // Codex, v0.9.29 re-review #3. A gateway that sends no usage chunk gets its prompt synthesized by us — and
  // that synthesized number feeds the same cost chain as a real one. It was taken from the HISTORY, which
  // omits the tool definitions, the trailing project context, the XML tool guide and the cache breakpoints:
  // everything we are billed for but do not store. On such a gateway every single turn was under-reported.
  it('synthesizes a missing streamed usage from the REQUEST, tools included — not from the history', async () => {
    const { streamFetchFn } = scriptedStreamFetch([[
      sse({ choices: [{ delta: { role: 'assistant' } }] }),
      sse({ choices: [{ delta: { content: 'ok' } }] }),
      'data: [DONE]\n\n', // no usage chunk at all
    ]]);
    const textFetch = scriptedFetch([]).fetchFn;
    // `read` gives this agent a real tool schema — several KB of JSON that goes on the wire and is billed,
    // and that appears nowhere in `this.history`.
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), textFetch, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn
    );
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    const historyOnly = new TokenCounter().estimateMessages(backend.snapshot().messages);
    // The billed prompt is strictly larger than the conversation, because the tools went with it.
    expect(complete.result.usage.inputTokens).toBeGreaterThan(historyOnly);
  });

  it('streams assistant deltas and returns the final reconstructed answer', async () => {
    const { streamFetchFn, requests } = scriptedStreamFetch([[
      sse({ choices: [{ delta: { role: 'assistant' } }] }),
      sse({ choices: [{ delta: { content: 'hel' } }] }),
      sse({ choices: [{ delta: { content: 'lo' } }] }),
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]]);
    const textFetch = scriptedFetch([]).fetchFn;
    const backend = new OpenAICompatBackend(makeConfig(), textFetch, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn);
    const events = await runOneTurn(backend, 'hi');

    expect(requests[0].stream).toBe(true);
    expect(requests[0].stream_options).toEqual({ include_usage: true });
    expect(events.filter((e) => e.kind === 'assistant_delta').map((e: any) => e.delta)).toEqual(['hel', 'lo']);
    expect(events.find((e) => e.kind === 'assistant')).toMatchObject({ text: 'hello' });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      result: { text: 'hello', isError: false, usage: { inputTokens: 5, outputTokens: 2 } },
    });
  });

  it('streams tool call chunks without breaking the tool loop', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-stream-'));
    await fs.writeFile(path.join(dir, 'foo.txt'), 'STREAMFILE', 'utf8');
    const { streamFetchFn, requests } = scriptedStreamFetch([
      [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"' },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'foo.txt"}' } }] } }] }),
        sse({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } }),
        'data: [DONE]\n\n',
      ],
      [
        sse({ choices: [{ delta: { content: 'saw STREAMFILE' } }] }),
        sse({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } }),
        'data: [DONE]\n\n',
      ],
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'], workingDirectory: dir }),
      scriptedFetch([]).fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0 },
      undefined,
      streamFetchFn
    );

    const events = await runOneTurn(backend, 'read foo');

    expect(requests).toHaveLength(2);
    expect(requests[1].messages.find((m: any) => m.role === 'tool').content).toContain('STREAMFILE');
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'read_file' });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      result: { text: 'saw STREAMFILE', usage: { inputTokens: 10, outputTokens: 5 } },
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('falls back to non-streaming chat when streaming fails before any delta', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'fallback answer' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]);
    const streamFetchFn: StreamFetchFn = async () => {
      throw new Error('stream unavailable');
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn);
    const events = await runOneTurn(backend, 'hi');

    expect(requests[0].stream).toBe(false);
    expect(events.some((e) => e.kind === 'assistant_delta')).toBe(false);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      result: { text: 'fallback answer', isError: false },
    });
  });

  it('aborts an in-flight streaming turn and resets for the next turn', async () => {
    const encoder = new TextEncoder();
    let firstSignal: AbortSignal | undefined;
    let calls = 0;
    const streamFetchFn: StreamFetchFn = async (_url, init) => {
      calls++;
      if (calls === 1) {
        firstSignal = init.signal;
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            yield encoder.encode(sse({ choices: [{ delta: { content: 'partial' } }] }));
            if (init.signal?.aborted) {
              throw new Error('aborted');
            }
            await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
          })(),
        };
      }
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield encoder.encode(sse({ choices: [{ delta: { content: 'next ok' } }] }));
          yield encoder.encode('data: [DONE]\n\n');
        })(),
      };
    };
    const backend = new OpenAICompatBackend(makeConfig(), scriptedFetch([]).fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn);
    const events: BackendEvent[] = [];
    backend.onEvent((e) => {
      events.push(e);
      if (e.kind === 'assistant_delta' && e.delta === 'partial') {
        backend.abort();
      }
    });

    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('stop me');
    await new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => {
        if (e.kind === 'turn_complete') { off(); resolve(); }
      });
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      result: { text: '[Stopped by user]', isError: true },
    });

    const secondDone = new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => {
        events.push(e);
        if (e.kind === 'turn_complete') { off(); resolve(); }
      });
    });
    backend.sendUserTurn('next');
    await secondDone;

    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ result: { text: 'next ok', isError: false } });
  });

  it('passes resolved modelParams into the request body, omitting unset fields (F1)', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    await new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
      backend.sendUserTurn('hi', {
        modelParams: {
          temperature: 1, // must be 1 here: thinking is enabled below, and temp != 1 is dropped (see thinking-temp tests)
          top_p: 0.9,
          max_tokens: 8000,
          presence_penalty: 0.5,
          frequency_penalty: -0.5,
          reasoning_effort: 'high',
          response_format: { type: 'json_object' },
          thinking: { type: 'enabled', budget_tokens: 1200 },
          stop: ['END'],
        },
      });
    });

    const body = requests[0];
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(8000);
    expect(body.presence_penalty).toBe(0.5);
    expect(body.frequency_penalty).toBe(-0.5);
    expect(body.reasoning_effort).toBe('high');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1200 });
    expect(body.stop).toEqual(['END']);
    expect(body.stream).toBe(false); // tool loop is always non-streaming
    // Unset fields must not appear.
    expect('tool_choice' in body).toBe(false);
  });

  it('uses a per-turn model override without mutating the configured model', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'smart' } }] },
      { choices: [{ message: { role: 'assistant', content: 'base' } }] },
    ]);
    const config = makeConfig({ model: 'base-model' });
    const backend = new OpenAICompatBackend(config, fetchFn);

    await runOneTurn(backend, 'smart turn', { model: 'smart-model' });
    backend.sendUserTurn('base turn');
    await new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => {
        if (e.kind === 'turn_complete') {
          off();
          resolve();
        }
      });
    });

    expect(requests[0].model).toBe('smart-model');
    expect(requests[1].model).toBe('base-model');
    expect(config.model).toBe('base-model');
  });

  it('passes tool_choice only when tools are available', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    await new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
      backend.sendUserTurn('hi', { modelParams: { tool_choice: 'none' } });
    });

    expect(requests[0].tools.length).toBeGreaterThan(0);
    expect(requests[0].tool_choice).toBe('none');
  });

  it('abort cancels pending team delegations even when no model request is in flight', async () => {
    const bus = new MessageBus();
    const claims = new TaskClaimRegistry();
    const team = new TeamTools(
      'a1',
      {
        list: () => [
          { id: 'a1', role: 'pm', name: 'PM', status: 'idle' },
          { id: 'dev', role: 'developer', name: 'Dev', status: 'idle' },
        ],
        resolve: (ref) => ref === 'dev' ? { id: 'dev' } : undefined,
      },
      bus,
      { timeoutMs: 60_000, claims }
    );
    await team.run('assign_task_async', { agent: 'dev', instruction: 'work', files: ['src/auth/**'] });
    expect(claims.activeClaims()).toHaveLength(1);

    const backend = new OpenAICompatBackend(makeConfig(), scriptedFetch([]).fetchFn, team);
    backend.abort();

    expect(claims.activeClaims()).toEqual([]);
    await expect(team.run('assign_task_async', { agent: 'dev', instruction: 'again', files: ['src/auth/x.ts'] }))
      .resolves.toMatch(/Dispatched/);
  });

  it('keeps the full stable tool list in Plan mode while refusing forced write/run/delegation calls', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-plan-'));
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'create_pr', description: 'create a PR' }]; },
      async callTool() { return 'should not run'; },
      async close() {},
    }));
    await hub.register({ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx' });
    const team = new TeamTools(
      'a1',
      {
        list: () => [{ id: 'dev', role: 'developer', name: 'Dev', status: 'idle' }],
        resolve: () => ({ id: 'dev' }),
      },
      new MessageBus(),
      { verifyCommand: 'npm test', runCommand: async () => ({ code: 0, output: 'should not run' }) }
    );

    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"pwn.txt","content":"bad"}' } },
              { id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm test"}' } },
              { id: 'c3', type: 'function', function: { name: 'dispatch_task', arguments: '{"agent":"dev","instruction":"change files"}' } },
              { id: 'c4', type: 'function', function: { name: 'github__create_pr', arguments: '{"title":"bad"}' } },
            ],
          },
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      {
        choices: [{ message: { role: 'assistant', content: 'plan only' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      },
    ]);

    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read', 'write', 'execute'], workingDirectory: dir }),
      fetchFn,
      team,
      undefined,
      undefined,
      {},
      { hub, grants: [{ serverId: 'github', toolFilter: 'all' }] }
    );
    const events = await runOneTurn(backend, 'make a plan', { mode: 'plan' });

    expect(requests[0].messages.at(-1).content).toContain('[PLAN MODE]');
    const offered = requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual([...offered].sort());
    expect(offered).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command', 'dispatch_task', 'github__create_pr']));
    expect(JSON.stringify(requests[1].tools)).toBe(JSON.stringify(requests[0].tools));
    expect(await exists(path.join(dir, 'pwn.txt'))).toBe(false);
    const toolMessages = requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    expect(toolMessages).toEqual([
      "[Plan mode] 'write_file' is disabled. Switch to Act mode to make changes.",
      "[Plan mode] 'run_command' is disabled. Switch to Act mode to make changes.",
      "[Plan mode] 'dispatch_task' is disabled. Switch to Act mode to make changes.",
      "[Plan mode] 'github__create_pr' is disabled. Switch to Act mode to make changes.",
    ]);
    expect(events.filter((e) => e.kind === 'tool_result').map((e: any) => e.ok)).toEqual([false, false, false, false]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps tool declarations byte-stable across a Plan to Act switch', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'plan complete' } }] },
      { choices: [{ message: { role: 'assistant', content: 'act complete' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write', 'execute'] }), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const run = (instruction: string, mode: 'plan' | 'act') => new Promise<void>((resolve) => {
      const off = backend.onEvent((event) => {
        if (event.kind === 'turn_complete') {
          off();
          resolve();
        }
      });
      backend.sendUserTurn(instruction, { mode });
    });
    await run('plan the change', 'plan');
    await run('make the change', 'act');

    expect(JSON.stringify(requests[1].tools)).toBe(JSON.stringify(requests[0].tools));
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toContain('write_file');
  });

  it('executes a sandboxed tool call and feeds the result back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-'));
    await fs.writeFile(path.join(dir, 'foo.txt'), 'FILECONTENT', 'utf8');

    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo.txt"}' } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
      {
        choices: [{ message: { role: 'assistant', content: 'the file says FILECONTENT' } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      },
    ]);

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), fetchFn);
    const events = await runOneTurn(backend, 'read foo.txt');

    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'read_file' });

    // The second request must contain the tool result with the file content.
    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('FILECONTENT');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.text).toBe('the file says FILECONTENT');
    // Usage accumulates across both calls.
    expect(complete.result.usage).toEqual({ inputTokens: 22, outputTokens: 10 });

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('emits tool_result cards with an edit diff while preserving the tool-loop message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-diff-'));
    await fs.writeFile(path.join(dir, 'foo.txt'), 'old line\n', 'utf8');

    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"foo.txt","content":"new line\\n"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      {
        choices: [{ message: { role: 'assistant', content: 'updated' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      },
    ]);

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['write'], workingDirectory: dir }), fetchFn);
    const events = await runOneTurn(backend, 'update foo');

    const result = events.find((e) => e.kind === 'tool_result');
    expect(result).toMatchObject({ name: 'write_file', ok: true });
    expect((result as any).diff).toContain('-old line');
    expect((result as any).diff).toContain('+new line');
    expect(requests[1].messages.find((m: any) => m.role === 'tool').content).toBe('Wrote 9 bytes to foo.txt.');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports real context usage on turn_complete', async () => {
    const { fetchFn } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 1000 }), fetchFn);
    const events = await runOneTurn(backend, 'hello');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.context.window).toBe(1000);
    expect(complete.result.context.tokens).toBeGreaterThan(0);
    expect(complete.result.context.ratio).toBeGreaterThan(0);
    expect(complete.result.context.source).toBe('configured');
  });

  it('reports a gateway-advertised window as measured, not assumed', () => {
    const { fetchFn } = scriptedFetch([]);
    const backend = new OpenAICompatBackend(makeConfig({
      model: 'gateway-model',
      measuredContextWindow: { model: 'gateway-model', tokens: 128_000, field: 'context_length' },
    }), fetchFn);
    expect(backend.contextUsage()).toMatchObject({ window: 128_000, source: 'measured' });
  });

  it('blocks path traversal outside the sandbox and ends the turn terminally (G-003)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-'));
    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"../../etc/passwd"}' } }],
          },
        }],
      },
      { choices: [{ message: { role: 'assistant', content: 'should not be reached' } }] },
    ]);

    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), fetchFn);
    const events = await runOneTurn(backend, 'read secrets');

    // Terminal block: the turn ends after the boundary violation — no second LLM round-trip, no flailing.
    expect(requests.length).toBe(1);
    const complete = events.find((e) => e.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }>;
    expect(complete.result.text).toMatch(/outside my working folder/);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps a task-scope refusal recoverable so the next turn iteration can read a granted input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-'));
    const granted = path.join(dir, 'granted');
    await fs.mkdir(granted);
    await fs.writeFile(path.join(granted, 'brief.md'), 'GRANTED RESEARCH INPUT', 'utf8');
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'list-root', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
      ] } }] },
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'read-granted', type: 'function', function: { name: 'read_file', arguments: '{"path":"granted/brief.md"}' } },
      ] } }] },
      { choices: [{ message: { role: 'assistant', content: 'Research input read.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), fetchFn);
    const events = await runOneTurn(backend, 'Read the granted research input.', {
      taskWorkspaceAccess: { pathBase: dir, commandCwd: dir, readRoots: [granted], writeRoots: [] },
    });

    expect(requests).toHaveLength(3);
    const recovery = requests[1].messages.find((message: any) => message.role === 'tool')?.content ?? '';
    expect(recovery).toContain('task-scope');
    expect(recovery).toContain('inputs granted in the task card');
    expect(recovery).not.toContain(dir);
    expect(recovery).not.toContain('User consent was not granted');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'list_dir', ok: false }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'read_file', ok: true }));
    expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toBe('Research input read.');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('circuit-breaks repeated task-scope refusals instead of reintroducing a terminal boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-repeat-'));
    const granted = path.join(dir, 'granted');
    await fs.mkdir(granted);
    const repeated = {
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [
          { id: 'list-root', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
        ] },
      }],
    };
    const { fetchFn, requests } = scriptedFetch([repeated]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), fetchFn);
    const events = await runOneTurn(backend, 'Do not list outside the task scope.', {
      taskWorkspaceAccess: { pathBase: dir, commandCwd: dir, readRoots: [granted], writeRoots: [] },
    });

    expect(requests).toHaveLength(4);
    expect(events.some((event) => event.kind === 'tool_result' && (event as { summary?: string }).summary === 'blocked: repeated failing call')).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps a write inside the configured workspace but outside a task scope recoverable, while a real write escape remains terminal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-write-'));
    const granted = path.join(dir, 'granted');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-write-out-'));
    await fs.mkdir(granted);
    const scoped = { pathBase: dir, commandCwd: granted, readRoots: [granted], writeRoots: [granted] };
    try {
      const { fetchFn, requests } = scriptedFetch([
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'write-task-outside', type: 'function', function: { name: 'write_file', arguments: '{"path":"not-granted.txt","content":"no"}' } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'write-granted', type: 'function', function: { name: 'write_file', arguments: '{"path":"granted/allowed.txt","content":"yes"}' } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: 'Wrote the granted file.' } }] },
      ]);
      const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: dir }), fetchFn);
      const events = await runOneTurn(backend, 'Write only in the granted folder.', { taskWorkspaceAccess: scoped });

      expect(requests).toHaveLength(3);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'write_file', ok: false }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'write_file', ok: true }));
      expect(await fs.readFile(path.join(granted, 'allowed.txt'), 'utf8')).toBe('yes');

      const terminal = scriptedFetch([
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'write-escape', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: path.join(outside, 'escape.txt'), content: 'no' }) } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: 'should not be reached' } }] },
      ]);
      const terminalBackend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read', 'write'], workingDirectory: dir }), terminal.fetchFn);
      const terminalEvents = await runOneTurn(terminalBackend, 'Attempt an outside write.', { taskWorkspaceAccess: scoped });

      expect(terminal.requests).toHaveLength(1);
      expect((terminalEvents.find((event) => event.kind === 'turn_complete') as any).result.text).toMatch(/outside my working folder/);
      await expect(fs.stat(path.join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('distinguishes task-scope and real-escape symlink targets without weakening the physical-path boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-link-'));
    const granted = path.join(dir, 'granted');
    const configuredOnly = path.join(dir, 'configured-only');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-task-scope-link-out-'));
    await fs.mkdir(granted);
    await fs.mkdir(configuredOnly);
    await fs.writeFile(path.join(granted, 'allowed.md'), 'ALLOWED', 'utf8');
    await fs.writeFile(path.join(configuredOnly, 'internal.md'), 'CONFIGURED ONLY', 'utf8');
    await fs.writeFile(path.join(outside, 'outside.md'), 'OUTSIDE', 'utf8');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(configuredOnly, path.join(granted, 'internal-link'), linkType);
    await fs.symlink(outside, path.join(granted, 'outside-link'), linkType);
    const scoped = { pathBase: dir, commandCwd: dir, readRoots: [granted], writeRoots: [] };
    try {
      const recoverable = scriptedFetch([
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'read-internal-link', type: 'function', function: { name: 'read_file', arguments: '{"path":"granted/internal-link/internal.md"}' } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'read-allowed', type: 'function', function: { name: 'read_file', arguments: '{"path":"granted/allowed.md"}' } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: 'Read the allowed input.' } }] },
      ]);
      const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), recoverable.fetchFn);
      const events = await runOneTurn(backend, 'Read a task input.', { taskWorkspaceAccess: scoped });

      expect(recoverable.requests).toHaveLength(3);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'read_file', ok: false }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', name: 'read_file', ok: true }));

      const terminal = scriptedFetch([
        { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'read-outside-link', type: 'function', function: { name: 'read_file', arguments: '{"path":"granted/outside-link/outside.md"}' } },
        ] } }] },
        { choices: [{ message: { role: 'assistant', content: 'should not be reached' } }] },
      ]);
      const terminalBackend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'], workingDirectory: dir }), terminal.fetchFn);
      const terminalEvents = await runOneTurn(terminalBackend, 'Read an escaped file.', { taskWorkspaceAccess: scoped });

      expect(terminal.requests).toHaveLength(1);
      expect((terminalEvents.find((event) => event.kind === 'turn_complete') as any).result.text).toMatch(/outside my working folder/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps an unavailable image asset recoverable and never renders it as a directory-boundary failure', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'route-missing-image', type: 'function', function: { name: 'send_image_asset_to_model', arguments: '{"assetId":"content-404"}' } },
      ] } }] },
      { choices: [{ message: { role: 'assistant', content: 'The image is unavailable; continuing without it.' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn);
    const events = await runOneTurn(backend, 'Inspect this image if possible.');

    expect(requests).toHaveLength(2);
    const receipt = requests[1].messages.find((message: any) => message.role === 'tool')?.content ?? '';
    expect(receipt).toContain('temporary asset is not-available');
    expect(receipt).not.toContain('outside my working folder');
    expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toContain('continuing without it');
  });

  it('tells the agent its workspace root in the system prompt (G-003)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-root-'));
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig({ workingDirectory: dir }), fetchFn);
    await runOneTurn(backend, 'hi');

    const sys = requests[0].messages.find((m: any) => m.role === 'system');
    expect(sys.content).toContain('Your workspace root is');
    expect(sys.content).toContain(dir);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('asks OpenAI-compatible agents to narrate before tool calls exactly once', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn);
    await runOneTurn(backend, 'inspect package.json');

    const sys = requests[0].messages.find((m: any) => m.role === 'system');
    const marker = 'Before each tool call, state in ONE short sentence';
    expect(sys.content).toContain(marker);
    expect((sys.content.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
    expect(sys.content).toContain('After a result that changes your plan, say so in one sentence.');
    expect(sys.content).toContain('Do not narrate trivial repetition');
  });

  it('errors clearly when no API key is present', async () => {
    const backend = new OpenAICompatBackend(makeConfig(), scriptedFetch([{}]).fetchFn);
    await expect(backend.start({} as NodeJS.ProcessEnv)).rejects.toThrow(/No API key/);
  });

  it('bounds conversation history at a valid turn boundary as turns accumulate', async () => {
    // The fake returns the same simple answer for every turn (index is clamped).
    const fetchFn = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]).fetchFn;
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    for (let i = 0; i < 70; i++) {
      await new Promise<void>((resolve) => {
        const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
        backend.sendUserTurn(`turn ${i}`);
      });
    }

    const msgs = (backend as any).history as any[];
    // CONTRACT CHANGED 2026-07-13. This used to assert `<= 61` — i.e. that the 60-message cap was the
    // binding constraint. That cap was destroying the prompt cache: it tripped after ~6 agentic turns (one
    // tool call = TWO messages) and then EVERY turn dropped from the middle, rewriting the prefix forever,
    // while under 1% of the token budget was in use.
    //
    // The bound is now the TOKEN budget, with a high message backstop purely against unbounded arrays. So
    // 70 cheap turns must be RETAINED IN FULL — that retention is the whole point (a trim re-reads the
    // surviving tail at full price on the next request).
    expect(msgs.length).toBe(141);                                  // system + 70 × (user, assistant)
    expect(msgs.length).toBeLessThanOrEqual(601);                   // still bounded by the backstop
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('turn 0');                    // nothing was dropped from the middle
    // The first retained non-system message is a clean user turn (no orphaned tool result).
    expect(msgs[1].role).toBe('user');
    // ANCHOR preserved: the original task ("turn 0") is still present, not dropped by the window.
    expect(msgs[1].content).toContain('turn 0');
    // …and the most recent turn is retained somewhere in the kept tail.
    expect(JSON.stringify(msgs)).toContain('turn 69');
  });

  it('emergency-trims by TOKENS down to the hard budget, keeping the anchor', async () => {
    const fetchFn = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]).fetchFn;
    // Tiny context window so a handful of long messages blow past the soft (70%) limit by tokens.
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 2000 }), fetchFn);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const big = 'x'.repeat(4000); // ~1000 tokens each — only a few fit under 70% of 2000
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((resolve) => {
        const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
        backend.sendUserTurn(`task ${i} ${big}`);
      });
    }

    const msgs = (backend as any).history as any[];
    const tokens = msgs.reduce((n, m) => n + Math.ceil((typeof m.content === 'string' ? m.content.length : 0) / 4), 0);
    expect(tokens).toBeLessThanOrEqual(Math.floor(2000 * 0.8)); // under the hard budget
    expect(msgs[1].content).toContain('task 0'); // anchor (original goal) preserved
    // The durable record independently retains the middle that the provider history must trim.
    expect(JSON.stringify(backend.snapshot().messages)).toContain('task 3');
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'log',
      stream: 'stderr',
      // The log must name the limit that ACTUALLY fired — here, genuinely the token budget. It used to
      // blame the token budget unconditionally, which sent us hunting a context-window problem when the
      // real cause was the message-count backstop.
      line: expect.stringMatching(/history hard-trim dropped .*token context budget.*re-read at full price/is),
    }));
  });

  it('compacts soft-limit history into a rolling summary before a new turn', async () => {
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 2000 }), scriptedFetch([]).fetchFn);
    seedRequestHistory(backend, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'anchor: use strict TypeScript' },
        { role: 'assistant', content: 'old answer ' + 'x'.repeat(2000) },
        { role: 'user', content: 'old task ' + 'y'.repeat(2000) },
        { role: 'assistant', content: 'old result ' + 'z'.repeat(2000) },
        { role: 'user', content: 'recent task' },
        { role: 'assistant', content: 'recent result' },
      ] as ChatMessage[]);

    const dropped: ChatMessage[][] = [];
    await backend.compactHistory(
      {
        summarize: async (_io, toDrop) => {
          dropped.push(toDrop as ChatMessage[]);
          return 'Summary: strict TypeScript decision retained; old task finished.';
        },
      },
      { chatCompletion: async () => 'unused' },
      'deepseek-v4-flash'
    );

    const msgs = (backend as any).history as ChatMessage[];
    expect(dropped[0].some((m) => m.content?.includes('old answer'))).toBe(true);
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'system prompt' });
    expect(msgs[1].content).toContain('Rolling summary');
    expect(msgs[1].content).toContain('strict TypeScript decision');
    expect(msgs[2].content).toContain('anchor: use strict TypeScript');
    expect(JSON.stringify(msgs)).toContain('recent task');
    expect(JSON.stringify(msgs)).not.toContain('old answer');
  });

  it('emits a structured compaction event when soft-limit summarization runs', async () => {
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 2000 }), scriptedFetch([]).fetchFn);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    seedRequestHistory(backend, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'anchor' },
        { role: 'assistant', content: 'old ' + 'x'.repeat(7000) },
        { role: 'user', content: 'recent' },
      ] as ChatMessage[]);

    await backend.compactHistory(
      { summarize: async () => 'Compressed old work.' },
      { chatCompletion: async () => 'unused' },
      'cheap-model'
    );

    expect(events).toContainEqual({ kind: 'compacted', dropped: 1, model: 'cheap-model' });
  });

  it('passes an existing rolling summary into the next incremental compaction', async () => {
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 2000 }), scriptedFetch([]).fetchFn);
    const firstHistory = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'anchor task' },
      { role: 'assistant', content: 'first old ' + 'x'.repeat(6000) },
      { role: 'user', content: 'recent one' },
    ] as ChatMessage[];
    seedRequestHistory(backend, firstHistory);

    await backend.compactHistory(
      { summarize: async () => 'First summary.' },
      { chatCompletion: async () => 'unused' },
      'cheap'
    );

    const withMoreHistory = [
      ...((backend as any).history as ChatMessage[]),
      { role: 'assistant', content: 'second old ' + 'y'.repeat(6000) },
      { role: 'user', content: 'recent two' },
    ] as ChatMessage[];
    seedRequestHistory(backend, withMoreHistory);

    let existing: string | undefined;
    await backend.compactHistory(
      {
        summarize: async (_io, _toDrop, existingSummary) => {
          existing = existingSummary;
          return `${existingSummary}\n---\nSecond summary.`;
        },
      },
      { chatCompletion: async () => 'unused' },
      'cheap'
    );

    expect(existing).toBe('First summary.');
    const compacted = JSON.stringify((backend as any).history);
    expect(compacted).toContain('First summary');
    expect(compacted).toContain('Second summary');
    expect(compacted).not.toContain('first old');
  });

  it('preserves the rolling summary when hard-limit trimming runs', async () => {
    const { fetchFn } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 1000 }), fetchFn);
    backend.restore({
      version: 1,
      messages: [
        { role: 'system', content: 'system prompt' },
        {
          role: 'system',
          content:
            '[Rolling summary of older conversation turns. Use it as memory; recent messages below remain authoritative.]\n' +
            'Early decision: keep strict TypeScript.',
        },
        { role: 'user', content: 'anchor task' },
        { role: 'assistant', content: 'middle answer ' + 'x'.repeat(3000) },
        { role: 'user', content: 'recent task' },
        { role: 'assistant', content: 'recent answer' },
      ] as ChatMessage[],
    });

    await runOneTurn(backend, 'one more turn');

    const compacted = (backend as any).history as ChatMessage[];
    expect(compacted[0]).toMatchObject({ role: 'system', content: 'system prompt' });
    expect(compacted[1].content).toContain('Early decision: keep strict TypeScript.');
    expect(JSON.stringify(compacted)).toContain('anchor task');
    expect(JSON.stringify(compacted)).not.toContain('middle answer');
  });

  it('snapshots conversation and restores it without duplicating the system message', async () => {
    const first = new OpenAICompatBackend(makeConfig(), scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'remembered' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]).fetchFn);
    await runOneTurn(first, 'remember this');

    const snap = first.snapshot();
    // system + user + assistant
    expect(snap.messages).toHaveLength(3);
    expect((snap.messages[0] as any).role).toBe('system');

    // A fresh backend restores the snapshot, then starts — must not add a 2nd system message.
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'still here' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const second = new OpenAICompatBackend(makeConfig(), fetchFn);
    second.restore(snap);
    await runOneTurn(second, 'are you still there?');

    const systemCount = requests[0].messages.filter((m: any) => m.role === 'system').length;
    expect(systemCount).toBe(1);
    // Prior turn's content is present in the restored context.
    expect(JSON.stringify(requests[0].messages)).toContain('remembered');
  });

  it('keeps a durable middle across restart without changing the trimmed provider request', async () => {
    const beforeRestart = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const original = new OpenAICompatBackend(
      makeConfig({ contextWindowTokens: 2_000 }), beforeRestart.fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0 },
    );
    const long = 'x'.repeat(4_000);
    for (let index = 0; index < 8; index++) {
      await runOneTurn(original, `durable turn ${index} ${long}`);
    }
    const snapshot = original.snapshot();
    const durable = JSON.stringify(snapshot.messages);
    const requestHistory = JSON.stringify((original as any).history);
    expect(durable).toContain('durable turn 3');
    expect(requestHistory).not.toContain('durable turn 3');

    await runOneTurn(original, 'same next turn');
    const expected = beforeRestart.requests.at(-1).messages as ChatMessage[];

    const afterRestart = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const restored = new OpenAICompatBackend(
      makeConfig({ contextWindowTokens: 2_000 }), afterRestart.fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0 },
    );
    restored.restore(snapshot);
    await runOneTurn(restored, 'same next turn');
    const actual = (afterRestart.requests.at(-1).messages as ChatMessage[])
      .filter((message) => !(typeof message.content === 'string' && message.content.startsWith('[Session restored from a previous session.]')));

    // The staleness note is a pre-existing restart safety message. Apart from it, restart replays exactly
    // the same trimmed provider input; its durable record never changes the model-window policy.
    expect(actual).toEqual(expected);
  });

  it('keeps the system prefix stable while refreshing project context at the request tail (P1)', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'one' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ message: { role: 'assistant', content: 'two' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ systemPrompt: 'Be terse.\n\n<project_context>\nold\n</project_context>' }), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    for (const ctx of [
      '<shared_memory>\n- [2026-07-12T00:00:00.000Z] [dev] first team note\n</shared_memory>',
      '<shared_memory>\n- [2026-07-12T00:00:01.000Z] [dev] second team note\n</shared_memory>',
    ]) {
      await new Promise<void>((resolve) => {
        const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
        backend.sendUserTurn('hi', { projectContext: ctx });
      });
    }

    const firstSystem = requests[0].messages[0].content;
    const secondSystem = requests[1].messages[0].content;
    expect(secondSystem).toBe(firstSystem);
    expect(firstSystem).not.toContain('<project_context>');
    expect(firstSystem).not.toContain('<project_context>\nold\n</project_context>');

    const firstTail = requests[0].messages.at(-1);
    const secondTail = requests[1].messages.at(-1);
    expect(firstTail).toMatchObject({ role: 'system' });
    expect(firstTail.content).toContain('<project_context>');
    expect(firstTail.content).toContain('first team note');
    expect(secondTail).toMatchObject({ role: 'system' });
    expect(secondTail.content).toContain('<project_context>');
    expect(secondTail.content).toContain('second team note');
    expect(secondTail.content).not.toContain('first team note');
    // The tail is request-only, never added to the persisted conversation.
    expect(JSON.stringify(backend.snapshot().messages)).not.toContain('second team note');
  });

  it('preserves the already-sent prefix across turns in trailing-system mode', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'first answer' } }] },
      { choices: [{ message: { role: 'assistant', content: 'second answer' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);

    await runOneTurn(backend, 'first user turn', { projectContext: 'team-note-one' });
    await runOneTurn(backend, 'second user turn', { projectContext: 'team-note-two' });

    const firstWithoutTail = requests[0].messages.slice(0, -1);
    expect(requests[0].messages.at(-1)).toMatchObject({ role: 'system' });
    // The messages that were already sent in turn one must be byte-identical at the start of turn two.
    // The first newly appended message is turn one's assistant reply; the second is the new user turn.
    expect(requests[1].messages.slice(0, firstWithoutTail.length)).toEqual(firstWithoutTail);
    expect(requests[1].messages[firstWithoutTail.length]).toMatchObject({ role: 'assistant' });
    expect(requests[1].messages[firstWithoutTail.length + 1]).toMatchObject({ role: 'user', content: 'second user turn' });
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'system' });
  });

  it('permanently records that the user-content fallback is not cross-turn prefix-stable', async () => {
    const bodies: any[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      n += 1;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'conversation must end with a user message' } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: n === 2 ? 'first answer' : 'second answer' } }] }) };
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });

    await runOneTurn(backend, 'first user turn', { projectContext: 'team-note-one' });
    await runOneTurn(backend, 'second user turn', { projectContext: 'team-note-two' });

    const firstFallbackRequest = bodies[1].messages;
    const overlappingPrefixOnNextTurn = bodies[2].messages.slice(0, firstFallbackRequest.length);
    expect(firstFallbackRequest[1].content).toContain('team-note-one');
    // Do not weaken this to a passing equality assertion: the fallback's request-only user injection means
    // the same historical user message is plain on turn two, so this gateway loses message-prefix reuse.
    expect(overlappingPrefixOnNextTurn).not.toEqual(firstFallbackRequest);
    expect(overlappingPrefixOnNextTurn[1].content).not.toContain('team-note-one');
  });

  it('removes legacy project context from a restored system prefix before attaching the current tail', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    backend.restore({
      version: 1,
      messages: [
        { role: 'system', content: 'Be terse.\n\n<project_context>\nlegacy note\n</project_context>' },
        { role: 'user', content: 'earlier task' },
      ],
    });

    await runOneTurn(backend, 'continue', { projectContext: '<shared_memory>\ncurrent note\n</shared_memory>' });

    const system = requests[0].messages[0].content as string;
    const tail = requests[0].messages.at(-1).content as string;
    expect(system).toBe('Be terse.');
    expect(tail).toContain('current note');
    expect(tail).not.toContain('legacy note');
  });

  it('completion-gates a forever-red coordinator, then emits terminal handoff and stops', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'Initial done claim.' } }] },
      { choices: [{ message: { role: 'assistant', content: 'Retry done claim.' } }] },
      { choices: [{ message: { role: 'assistant', content: 'Escalated done claim.' } }] },
      { choices: [{ message: { role: 'assistant', content: 'should not be requested' } }] },
    ]);
    const run = vi.fn(async () => ({ ok: false, output: 'FAIL src/app.ts' }));
    const backend = new OpenAICompatBackend(
      makeConfig({ id: 'pm', role: 'pm' }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0, maxToolIterations: 10 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { completionGate: { command: 'npm test', run, cfg: { maxSelfRetries: 1, maxRedelegations: 1 } } }
    );

    const events = await runOneTurn(backend, 'finish the goal');

    expect(requests).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(requests[1].messages.at(-1).content).toContain('Verification gate');
    expect(requests[2].messages.at(-1).content).toContain('STILL failing');
    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.text).toContain('Blocked');
    expect(complete.result.text).toContain('needs a human');
  });

  it('completion gate passes a green coordinator normally', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'All done.' } }] },
    ]);
    const run = vi.fn(async () => ({ ok: true, output: 'PASS' }));
    const backend = new OpenAICompatBackend(
      makeConfig({ id: 'pm', role: 'pm' }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { completionGate: { command: 'npm test', run, cfg: { maxSelfRetries: 1, maxRedelegations: 0 } } }
    );

    const events = await runOneTurn(backend, 'finish the goal');

    expect(requests).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ result: { text: 'All done.', isError: false } });
  });

  it('resets completion gate attempts between user turns', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'first red' } }] },
      { choices: [{ message: { role: 'assistant', content: 'first green' } }] },
      { choices: [{ message: { role: 'assistant', content: 'second red' } }] },
      { choices: [{ message: { role: 'assistant', content: 'second green' } }] },
    ]);
    const verdicts = [false, true, false, true];
    const run = vi.fn(async () => ({ ok: verdicts.shift() ?? true, output: 'status' }));
    const backend = new OpenAICompatBackend(
      makeConfig({ id: 'pm', role: 'pm' }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0, maxToolIterations: 10 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { completionGate: { command: 'npm test', run, cfg: { maxSelfRetries: 1, maxRedelegations: 0 } } }
    );
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const turn = (instruction: string) => new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => {
        if (e.kind === 'turn_complete') {
          off();
          resolve();
        }
      });
      backend.sendUserTurn(instruction);
    });

    await turn('first goal');
    await turn('second goal');

    expect(requests).toHaveLength(4);
    expect(requests[1].messages.at(-1).content).toContain('Verification gate');
    expect(requests[3].messages.at(-1).content).toContain('Verification gate');
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not gate when the verification command is blocked/unrunnable', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'Done despite blocked checks.' } }] },
      { choices: [{ message: { role: 'assistant', content: 'should not be requested' } }] },
    ]);
    const run = vi.fn(async () => ({ ok: false, blocked: true, output: 'command not approved' }));
    const backend = new OpenAICompatBackend(
      makeConfig({ id: 'pm', role: 'pm' }),
      fetchFn,
      undefined,
      undefined,
      undefined,
      { retryBaseMs: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { completionGate: { command: 'npm test', run, cfg: { maxSelfRetries: 1, maxRedelegations: 0 } } }
    );

    const events = await runOneTurn(backend, 'finish the goal');

    expect(requests).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.text).toContain('Done despite blocked checks.');
    // A policy-blocked verify command must read as NOT verified (not a silent skip) — but still end the
    // turn without looping (no deadlock) since the gate can't run the command or prompt mid-turn.
    expect(complete.result.text).toContain('NOT verified');
    expect(complete.result.text).toMatch(/blocked by your command policy/i);
  });
});

/** A successful chat-completion body the loop treats as a finished turn. */
function okBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

describe('OpenAICompatBackend network resilience', () => {
  it('retries a 5xx response and then succeeds', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      return calls < 3
        ? { ok: false, status: 503, text: async () => 'overloaded' }
        : { ok: true, status: 200, text: async () => okBody('recovered') };
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.text).toBe('recovered');
    expect(complete.result.isError).toBe(false);
    expect(calls).toBe(3); // two 503s + one success
  });

  it('retries a network error and then succeeds', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      if (calls < 2) { throw new Error('ECONNRESET'); }
      return { ok: true, status: 200, text: async () => okBody('back online') };
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.text).toBe('back online');
    expect(calls).toBe(2);
  });

  // The contract for a 4xx is NOT "never retry" — the degradation ladder deliberately retries with a
  // strictly simpler body, which is how an unrecognized gateway rejection stops being a hard failure. What
  // must still hold is the reason we never blindly retried a 4xx in the first place: **a 4xx is
  // deterministic**, so re-sending the SAME body can only waste a request. Every attempt must differ, the
  // walk must be bounded, and when the ladder runs out the gateway's own error must reach the user intact.
  it('never retries a 4xx with the same body — it either simplifies the request or surfaces the error', async () => {
    const sent: string[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      sent.push((init as any).body);
      return { ok: false, status: 400, text: async () => 'bad request' };
    };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.isError).toBe(true);
    expect(complete.result.text).toMatch(/HTTP 400/); // the raw gateway error, never swallowed
    expect(new Set(sent).size).toBe(sent.length);     // no two attempts were the same request
    expect(sent.length).toBeLessThanOrEqual(5);       // and the walk is bounded
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => { calls++; return { ok: false, status: 500, text: async () => 'err' }; };
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, maxRetries: 2 });
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.isError).toBe(true);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('aborts a hung request after timeoutMs and reports a timeout', async () => {
    let calls = 0;
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls++;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn, undefined, undefined, undefined, {
      retryBaseMs: 0,
      timeoutMs: 20,
      maxRetries: 1,
    });
    const events = await runOneTurn(backend, 'hi');

    const complete = events.find((e) => e.kind === 'turn_complete') as any;
    expect(complete.result.isError).toBe(true);
    expect(complete.result.text).toMatch(/timed out/);
    expect(calls).toBe(2); // initial attempt + one retry, both timed out
  });
});

describe('OpenAICompatBackend MCP integration', () => {
  async function hubWith(toolName: string, onCall: (args: any) => Promise<string>): Promise<MCPHub> {
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: toolName, description: 'a tool' }]; },
      async callTool(_name, args) { return onCall(args); },
      async close() {},
    }));
    await hub.register({ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx' });
    return hub;
  }

  it('exposes granted MCP tools to the model and routes the call to the Hub', async () => {
    const hub = await hubWith('create_pr', async (args) => `PR created: ${args.title}`);
    const { fetchFn, requests } = scriptedFetch([
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'github__create_pr', arguments: '{"title":"Add MCP"}' } }],
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      { choices: [{ message: { role: 'assistant', content: 'opened the PR' } }], usage: { prompt_tokens: 6, completion_tokens: 3 } },
    ]);

    const backend = new OpenAICompatBackend(
      makeConfig(), fetchFn, undefined, undefined, undefined, {},
      { hub, grants: [{ serverId: 'github', toolFilter: 'all' }] }
    );
    const events = await runOneTurn(backend, 'open a PR');

    // The namespaced MCP tool was advertised to the model.
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain('github__create_pr');
    // It was invoked and its result fed back as a tool message.
    const toolUse = events.find((e) => e.kind === 'tool_use') as any;
    expect(toolUse.name).toBe('github__create_pr');
    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe('PR created: Add MCP');
    expect((events.find((e) => e.kind === 'turn_complete') as any).result.text).toBe('opened the PR');
  });

  it('default-deny: with no grants, MCP tools are neither advertised nor routed', async () => {
    const hub = await hubWith('create_pr', async () => 'should not happen');
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig(), fetchFn, undefined, undefined, undefined, {},
      { hub, grants: [] }
    );
    await runOneTurn(backend, 'hi');
    // No MCP tools advertised; memory_note is a global workspace tool even with no grants.
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['memory_note', 'select_workflow_branch']);
  });

  // ─── G-001 mid-run steering (interject) ─────────────────────────────────
  it('folds an interjection into the running turn at the next iteration, after the tool result', async () => {
    const toolCall = (id: string, p: string) => ({
      id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: p }) },
    });
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'reading', tool_calls: [toolCall('t1', 'a.txt')] } }] },
      { choices: [{ message: { role: 'assistant', content: 'again', tool_calls: [toolCall('t2', 'b.txt')] } }] },
      { choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: ['read'] }), fetchFn);
    let interjected = false;
    backend.onEvent((e) => {
      if (e.kind === 'tool_result' && !interjected) {
        interjected = true;
        backend.interject('use read_file on c.txt instead');
      }
    });

    await runOneTurn(backend, 'read the files');

    // The 2nd gateway request (turn 2) carries the steer as a user message...
    const msgs = requests[1].messages as ChatMessage[];
    const idxSteer = msgs.findIndex(
      (m) => typeof m.content === 'string' && m.content.includes('[User interjected mid-task] use read_file on c.txt instead')
    );
    expect(idxSteer).toBeGreaterThan(-1);
    // ...and it sits AFTER a tool answer — the ordering invariant (tool_calls answered before a user turn).
    expect(msgs.slice(0, idxSteer).some((m) => m.role === 'tool')).toBe(true);
  });

  it('interject REFUSES (returns false) when the agent is idle, so the caller must deliver it another way', async () => {
    // It used to log "interject ignored: agent is idle" and DROP the text. In the race where the session
    // still reads 'running' but the turn just ended, that lost the user's message outright. Refusing lets
    // SessionManager fall back and deliver it as a normal turn — a user message is never dropped.
    const { fetchFn } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);

    expect(backend.interject('nobody is running')).toBe(false);
  });

  it('keeps the turn alive for a steer that arrives on the final (no-tool) response', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'all done' } }] },
      { choices: [{ message: { role: 'assistant', content: 'ok, adjusted' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    let interjected = false;
    backend.onEvent((e) => {
      if (e.kind === 'assistant' && e.text === 'all done' && !interjected) {
        interjected = true;
        backend.interject('one more thing');
      }
    });

    await runOneTurn(backend, 'do it');

    // The first response had no tool call (would normally end the turn); the steer kept it alive for a
    // second request, which carries the interjected message instead of dropping it.
    expect(requests.length).toBe(2);
    const carried = (requests[1].messages as ChatMessage[]).some(
      (m) => typeof m.content === 'string' && m.content.includes('one more thing')
    );
    expect(carried).toBe(true);
  });

  // ─── Cline #2: proactive workspace context injection ────────────────────
  const sysOf = (req: any): string =>
    (req.messages as ChatMessage[]).find((m) => m.role === 'system')?.content as string ?? '';
  const tailOf = (req: any): string =>
    (req.messages as ChatMessage[]).at(-1)?.content as string ?? '';

  it('injects workspaceContext at the request tail without changing the system prefix', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'a' } }] },
      { choices: [{ message: { role: 'assistant', content: 'b' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);

    const turn = () => new Promise<void>((resolve) => {
      const off = backend.onEvent((e) => { if (e.kind === 'turn_complete') { off(); resolve(); } });
    });
    let done = turn();
    backend.sendUserTurn('one', { workspaceContext: 'ACTIVE FILE src/foo.ts\nexport const x = 1;' });
    await done;
    done = turn();
    backend.sendUserTurn('two'); // no workspaceContext this time
    await done;

    expect(sysOf(requests[1])).toBe(sysOf(requests[0]));
    expect(tailOf(requests[0])).toContain('Workspace state');
    expect(tailOf(requests[0])).toContain('ACTIVE FILE src/foo.ts');
    // Ephemeral: it must NOT carry over into the next turn's request.
    expect(tailOf(requests[1])).not.toContain('ACTIVE FILE src/foo.ts');
  });

  it('does not inject workspace state when workspaceContext is absent', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    await runOneTurn(backend, 'do it');
    expect(tailOf(requests[0])).not.toContain('Workspace state');
  });

  it('caps an oversized workspaceContext (backstop)', async () => {
    const { fetchFn, requests } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);
    await runOneTurn(backend, 'do it', { workspaceContext: 'x'.repeat(20000) });
    const tail = tailOf(requests[0]);
    expect(tail).toContain('[workspace context truncated]');
    expect(tail.length).toBeLessThan(20000);
  });
});

// Regression: a Stop/cancel mid tool-loop (or a snapshot restored at that moment) can leave an
// assistant `tool_calls` message with unanswered tool_call_ids — the gateway then 400s with
// HTTP 400 "messages: text content blocks must be non-empty" — an Anthropic-translating gateway rejects
// an assistant tool-call turn carrying content "" (and an empty tool result). normalizeEmptyContent fixes it.
describe('normalizeEmptyContent', () => {
  const toolCall = { id: 't1', type: 'function', function: { name: 'list_agents', arguments: '{}' } } as any;

  it('nulls empty content on an assistant message that carries tool_calls (no empty text block)', () => {
    const out = normalizeEmptyContent([
      { role: 'assistant', content: '', tool_calls: [toolCall] },
      { role: 'tool', content: 'roster', tool_call_id: 't1' },
    ]);
    expect(out[0].content).toBeNull();
    expect(out[0].tool_calls).toHaveLength(1);
    expect(out[1].content).toBe('roster'); // non-empty tool result untouched
  });

  it('gives an empty tool result a marker so its tool_result block is non-empty', () => {
    const out = normalizeEmptyContent([{ role: 'tool', content: '', tool_call_id: 't1' }]);
    expect(out[0].content).toBe('(no output)');
  });

  it('leaves real content and plain text turns alone, and is idempotent', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'It will be a neobanking project' },
      { role: 'assistant', content: 'Sure, here is the plan' },
      { role: 'assistant', content: '', tool_calls: [toolCall] },
      { role: 'tool', content: 'ok', tool_call_id: 't1' },
    ];
    const once = normalizeEmptyContent(msgs);
    expect(once[0].content).toBe('It will be a neobanking project');
    expect(once[1].content).toBe('Sure, here is the plan');
    expect(once[2].content).toBeNull();
    expect(normalizeEmptyContent(once)).toEqual(once); // idempotent
  });
});

// "insufficient tool messages following tool_calls message". sanitizeToolCallPairing backfills the gap.
describe('sanitizeToolCallPairing', () => {
  const asst = (ids: string[]): ChatMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })) as any,
  });
  const toolMsg = (id: string): ChatMessage => ({ role: 'tool', content: 'result', tool_call_id: id });

  it('backfills a fully-unanswered assistant tool_calls message (interrupted before any ran)', () => {
    const out = sanitizeToolCallPairing([
      { role: 'user', content: 'go' },
      asst(['call_A', 'call_B']),
      // interrupted here — no tool results at all
    ]);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools.map((t) => t.tool_call_id)).toEqual(['call_A', 'call_B']);
    expect(tools.every((t) => typeof t.content === 'string' && t.content.includes('interrupted'))).toBe(true);
  });

  it('backfills only the MISSING id and preserves the real result', () => {
    const out = sanitizeToolCallPairing([
      asst(['call_A', 'call_B']),
      toolMsg('call_A'), // A answered; B was interrupted
    ]);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools.map((t) => t.tool_call_id)).toEqual(['call_A', 'call_B']);
    expect(tools.find((t) => t.tool_call_id === 'call_A')!.content).toBe('result'); // untouched
    expect(tools.find((t) => t.tool_call_id === 'call_B')!.content).toContain('interrupted');
  });

  it('is a no-op on an already-valid history (idempotent)', () => {
    const valid: ChatMessage[] = [
      { role: 'user', content: 'go' },
      asst(['call_A']),
      toolMsg('call_A'),
      { role: 'assistant', content: 'done' },
    ];
    const once = sanitizeToolCallPairing(valid);
    expect(once).toEqual(valid);
    expect(sanitizeToolCallPairing(once)).toEqual(once);
  });

  it('drops an ORPHAN tool result (id with no matching tool_use) — the "unexpected tool_use_id" 400', () => {
    const out = sanitizeToolCallPairing([
      asst(['call_A']),
      toolMsg('call_A'),
      toolMsg('call_GHOST'), // orphan: no assistant tool_use has this id
    ]);
    const ids = out.filter((m) => m.role === 'tool').map((t) => t.tool_call_id);
    expect(ids).toEqual(['call_A']); // ghost dropped, A kept
  });

  it('drops a tool result that is not preceded by an assistant tool_calls run', () => {
    const out = sanitizeToolCallPairing([
      { role: 'user', content: 'hi' },
      toolMsg('call_ORPHAN'), // a tool message with no preceding tool_use at all
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out.some((m) => m.role === 'tool')).toBe(false); // orphan removed
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('toolPairingTrace', () => {
  it('renders the role/tool_use_id sequence and flags an orphan tool_result', () => {
    const trace = toolPairingTrace([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_A', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } as any,
      { role: 'tool', content: 'r', tool_call_id: 'toolu_A' },
      { role: 'tool', content: 'r', tool_call_id: 'toolu_GHOST' },
    ]);
    expect(trace).toContain('asst[tool_use:toolu_A]');
    expect(trace).toContain('tool_result(toolu_A)');
    expect(trace).toContain('tool_result(toolu_GHOST) ⚠ORPHAN');
    expect(trace).not.toContain('tool_result(toolu_A) ⚠ORPHAN'); // the paired one is not flagged
  });
});

describe('splitParallelToolCalls', () => {
  const asst = (ids: string[], content: string | null = null): ChatMessage => ({
    role: 'assistant',
    content,
    tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })) as any,
  });
  const toolMsg = (id: string): ChatMessage => ({ role: 'tool', content: `result-${id}`, tool_call_id: id });

  it('splits a parallel turn into sequential assistant→result pairs (strict adjacency)', () => {
    const out = splitParallelToolCalls([
      { role: 'user', content: 'go' },
      asst(['A', 'B', 'C'], 'doing three things'),
      toolMsg('A'), toolMsg('B'), toolMsg('C'),
    ]);
    // Each tool_result is now IMMEDIATELY preceded by an assistant carrying exactly its tool_use.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    for (let k = 2; k < out.length; k += 2) {
      const result = out[k];
      const prev = out[k - 1];
      expect(prev.role).toBe('assistant');
      expect((prev.tool_calls ?? []).map((c: any) => c.id)).toEqual([result.tool_call_id]);
    }
    // Assistant text rides on the FIRST split message only.
    const assts = out.filter((m) => m.role === 'assistant');
    expect(assts[0].content).toBe('doing three things');
    expect(assts[1].content).toBeNull();
  });

  it('preserves reasoning_content on EVERY split segment (thinking-model gateways require it)', () => {
    const thinking = { ...asst(['A', 'B'], 'doing two'), reasoning_content: 'because X' } as ChatMessage;
    const out = splitParallelToolCalls([{ role: 'user', content: 'go' }, thinking, toolMsg('A'), toolMsg('B')]);
    const assts = out.filter((m) => m.role === 'assistant');
    expect(assts).toHaveLength(2);
    expect(assts.every((m) => (m as any).reasoning_content === 'because X')).toBe(true);
  });

  it('leaves a single-call turn unchanged (idempotent)', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'go' }, asst(['A']), toolMsg('A')];
    const once = splitParallelToolCalls(msgs);
    expect(once).toEqual(msgs);
    expect(splitParallelToolCalls(once)).toEqual(once);
  });
});

describe('a pasted image on a text-only model must not brick the session', () => {
  // Field report (2026-07-12), deepseek-v4-pro via the Roam gateway:
  //   HTTP 400 ... messages[36]: unknown variant `image_url`, expected `text`
  // Note the INDEX: the image is in HISTORY. Without a self-heal, every later request resends it and 400s
  // again — one mis-paste kills the session for good, and the history is persisted so a reload does not help.
  it('recognizes the gateway rejecting an image block', () => {
    expect(isImageRejectionError(
      'Failed to deserialize the JSON body into the target type: messages[36]: unknown variant `image_url`, expected `text`'
    )).toBe(true);
    expect(isImageRejectionError('image_url is not supported by this model')).toBe(true);
    // …and does not fire on unrelated 400s, which would strip images for no reason.
    expect(isImageRejectionError('unknown variant `parallel_tool_calls`')).toBe(false);
    expect(isImageRejectionError('unexpected tool_use_id')).toBe(false);
  });

  it('strips every image from history and says what was lost, instead of dropping the turn', () => {
    const history: any[] = [
      { role: 'system', content: 'You are a dev.' },
      { role: 'user', content: [
        { type: 'text', text: 'what is wrong with this screenshot?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [
        { type: 'text', text: 'and these two?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,CCC' } },
      ] },
    ];

    expect(stripImageBlocks(history)).toBe(3);
    expect(JSON.stringify(history)).not.toContain('image_url');   // nothing left to 400 on
    expect(history[1].content).toContain('what is wrong with this screenshot?'); // the user's words survive
    expect(history[1].content).toContain('has no vision');                       // and the model is told why
    expect(history[3].content).toContain('2 images attached');
    expect(history[0].content).toBe('You are a dev.');            // untouched
  });

  it('does not attach an image to a model already known to reject them', () => {
    const attachments: any = {
      userAttachments: [{ kind: 'image', mime: 'image/png', dataBase64: 'AAA', name: 'a.png' }],
    };
    const withVision = composeUserContent('look', attachments, true);
    expect(Array.isArray(withVision)).toBe(true);

    const without = composeUserContent('look', attachments, false);
    expect(typeof without, 'a text-only model must never receive an image_url block').toBe('string');
    expect(without).toContain('look');
    expect(without).toContain('has no vision');
  });
});

describe('a gateway that is strict ONLY on its streaming endpoint must still self-heal', () => {
  // Observed live 2026-07-13, deepseek-v4-pro via ai.weroam.xyz. A pasted image poisoned the persisted
  // history. Every turn logged:
  //     streaming request failed before content; falling back to non-streaming chat: HTTP 400 …
  //     messages[35]: unknown variant `image_url`, expected `text` … column 44526
  // …with the IDENTICAL index and column each time, and NOT ONE recovery log.
  //
  // Root cause: the recovery chain lived only in chat(). chatStream() "handled" a failure by falling back to
  // chat() — and weroam's NON-streaming relay accepts image_url, so chat() SUCCEEDED. No handler ever ran,
  // the poison was never stripped, and every turn burned a wasted streaming 400 and dropped to non-streaming
  // — permanently killing the streaming UX for that session behind an innocuous "falling back" log line.
  //
  // My earlier end-to-end test passed because its mock rejected on BOTH paths. That symmetry assumption was
  // the bug. This test encodes the asymmetry.
  const imageHistory = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [
      { type: 'text', text: 'what is in this screenshot?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] },
  ];

  it('repairs the body and RETRIES THE STREAM instead of silently degrading to non-streaming forever', async () => {
    const streamBodies: any[] = [];
    const chatBodies: any[] = [];

    // The gateway: streaming rejects image_url; non-streaming happily accepts it.
    const streamFetchFn: any = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      streamBodies.push(body);
      if (JSON.stringify(body.messages).includes('image_url')) {
        throw new Error('HTTP 400 from https://ai.weroam.xyz/v1: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 44526"}}');
      }
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield encoder.encode('data: {"choices":[{"delta":{"content":"streamed ok"},"finish_reason":"stop"}]}\n\n');
          yield encoder.encode('data: [DONE]\n\n');
        })(),
      };
    };
    const fetchFn: FetchFn = async (_url, init) => {
      chatBodies.push(JSON.parse((init as any).body));   // the lenient path — must NOT be reached
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'non-streamed' } }] }) } as any;
    };

    const backend = new OpenAICompatBackend(
      makeConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetchFn
    );
    const logs: string[] = [];
    backend.onEvent((e: any) => { if (e.kind === 'log') { logs.push(e.line); } });
    backend.restore({ version: 1, messages: imageHistory } as never);

    await runOneTurn(backend, 'read the files');

    // The image is stripped and the STREAM is retried — streaming is not sacrificed.
    expect(logs.join('\n'), 'the self-heal must run on the streaming path').toContain('has no vision');
    expect(streamBodies).toHaveLength(2);
    expect(JSON.stringify(streamBodies[0].messages)).toContain('image_url');   // the poisoned attempt
    expect(JSON.stringify(streamBodies[1].messages)).not.toContain('image_url'); // the repaired retry
    expect(chatBodies, 'must not concede the stream when the body is repairable').toHaveLength(0);

    // …and the poison is gone from history, so it cannot come back through the next snapshot.
    expect(JSON.stringify(backend.snapshot()!.messages)).not.toContain('image_url');
  });
});

describe('the message-count backstop must never be the binding constraint', () => {
  // Observed live 2026-07-13, in a tiny sandbox conversation:
  //   history hard-trim dropped 6 message(s) to stay within the 419430-token limit
  // The token budget was nowhere near exhausted. The real cause was MAX_HISTORY_MESSAGES = 60 — and 60 is
  // nothing in an agentic loop, where ONE tool call costs TWO messages (assistant turn + tool result).
  //
  // The steady state that produced: from ~turn six on, EVERY turn overflowed, EVERY turn dropped from the
  // MIDDLE, so EVERY turn rewrote the prompt prefix and the provider cache collapsed to ~0 — permanently,
  // while under 1% of the token budget was in use. Our 3-turn cache probe measured 98% hits only because it
  // was too short to reach this. A trim is not free: the surviving tail is re-read at FULL price.
  function toolTurn(id: string) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
      { role: 'tool', tool_call_id: id, content: 'file contents' },
    ];
  }

  it('keeps a long agentic history intact while the token budget has room', async () => {
    const { fetchFn, requests } = scriptedFetch([
      { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    ]);
    const backend = new OpenAICompatBackend(makeConfig(), fetchFn);

    // 40 tool calls = 80 messages, plus the anchor. Far past the OLD 60-message cap, but tiny in tokens.
    const messages: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'the original goal' }];
    for (let i = 0; i < 40; i++) { messages.push(...toolTurn(`t${i}`)); }
    messages.push({ role: 'assistant', content: 'done' });
    const logs: string[] = [];
    backend.onEvent((e: any) => { if (e.kind === 'log') { logs.push(e.line); } });
    backend.restore({ version: 1, messages } as never);
    await runOneTurn(backend, 'next task');

    // Nothing was dropped: the tokens are fine, so the prefix — and the provider's cache — survives.
    expect(logs.join('\n'), 'a short, cheap conversation must not be trimmed on message count')
      .not.toContain('hard-trim');
    // The original goal is still the anchor, and the tool history is all still there.
    expect(JSON.stringify(requests[0].messages)).toContain('the original goal');
    expect(requests[0].messages.filter((m: any) => m.role === 'tool')).toHaveLength(40);
  });

  it('when a trim IS necessary, the log names the limit that actually fired', async () => {
    const { fetchFn } = scriptedFetch([{ choices: [{ message: { role: 'assistant', content: 'ok' } }] }]);
    // A tiny context window forces the TOKEN budget to bite, not the message backstop.
    const backend = new OpenAICompatBackend(makeConfig({ contextWindowTokens: 2000 }), fetchFn);
    const messages: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'goal' }];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'y'.repeat(2000) });
    }
    const logs: string[] = [];
    backend.onEvent((e: any) => { if (e.kind === 'log') { logs.push(e.line); } });
    backend.restore({ version: 1, messages } as never);
    await runOneTurn(backend, 'next');

    const trim = logs.find((l) => l.includes('hard-trim'));
    expect(trim, 'a token-budget overflow must trim').toBeTruthy();
    expect(trim, 'the log must blame the TOKEN budget, not the message backstop').toContain('token context budget');
    expect(trim).toContain('re-read at full price');
  });
});

describe('user-forced compaction', () => {
  // Field transcript, 2026-08-10: a PM hit HTTP 502 "exceeds the context window" repeatedly. The Compact
  // control could not have rescued it — compaction planned against a threshold derived from the ASSUMED
  // window, which had not tripped, so it dropped nothing. A user pressing Compact is the trigger; making
  // them satisfy a threshold computed from a number already known to be wrong is the whole bug.
  it('compacts on request even when the assumed threshold has not tripped, and reports what it dropped', async () => {
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      // A window far larger than the conversation: the automatic threshold can never trip here.
      { retryBaseMs: 0, maxRetries: 0 }
    );
    for (let i = 0; i < 8; i++) {
      (backend as any).history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} `.repeat(40) });
    }
    const summarizer = { summarize: async () => 'Summary of earlier turns.' };

    const unforced = await backend.compactHistory(summarizer as any, {} as any, 'economy');
    const forced = await backend.compactHistory(summarizer as any, {} as any, 'economy', { force: true });

    expect(unforced).toEqual({ compacted: false, dropped: 0 });
    expect(forced.compacted).toBe(true);
    expect(forced.dropped).toBeGreaterThan(0);
  });
});

describe('context overflow', () => {
  // Field report, 2026-08-10: HTTP 502 carrying "Your input exceeds the context window of this model."
  // The existing overflow vocabulary was gated behind HTTP 400|422 and did not contain the words
  // "context window" — so the most common phrasing of the most common cause matched nothing, and a 5xx
  // was classified retryable. The same oversized body was resent and billed each time.
  it('does not retry an oversized request, whatever status the gateway used', async () => {
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      return {
        ok: false,
        status: 502,
        text: async () => JSON.stringify({
          error: { message: 'Your input exceeds the context window of this model.', type: 'upstream_error' },
        }),
      };
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn as any, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 3 }
    );

    const events = await runOneTurn(backend, 'hi');
    const text = JSON.stringify(events);

    expect(attempts).toBe(1);
    // It must also say the one thing the user can act on: the window we assumed, which is invisible otherwise.
    expect(text).toMatch(/assumed window of/);
    expect(text).toMatch(/Not retried/);
  });
  const refusesForSize = () => {
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      return {
        ok: false,
        status: 502,
        text: async () => JSON.stringify({
          error: { message: 'Your input exceeds the context window of this model.', type: 'upstream_error' },
        }),
      };
    };
    return { fetchFn, attempts: () => attempts };
  };

  const withLongHistory = (backend: OpenAICompatBackend, messages = 20) => {
    for (let i = 0; i < messages; i++) {
      (backend as any).history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} `.repeat(300) });
    }
  };

  // The defect this closes: the refusal proves the model accepts less than we sent, and nothing recorded it.
  // The guard kept deriving its threshold from the disproved 1M assumption, so automatic compaction never
  // fired and the SAME conversation overflowed at the SAME place — the loop in the 2026-08-10 transcript,
  // where recovery existed only as a button the user had to press again every turn.
  it('turns the refusal into the window, so the next turn compacts without being asked', async () => {
    const { fetchFn } = refusesForSize();
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'gateway-model', allowedTools: ['read'] }), fetchFn as any, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 3 }
    );
    withLongHistory(backend);
    const before = backend.contextUsage();

    const events = await runOneTurn(backend, 'hi');
    const learned = events.find((e) => e.kind === 'context_overflow') as any;
    const after = backend.contextUsage();

    expect(before.source).toBe('assumed');
    expect(learned).toMatchObject({ model: 'gateway-model' });
    expect(learned.tokens).toBeGreaterThanOrEqual(MIN_OBSERVED_CONTEXT_BOUND_TOKENS);
    expect(Date.parse(learned.observedAt)).not.toBeNaN();
    // The guard now measures against what the provider proved, not against what we hoped.
    expect(after).toMatchObject({ source: 'observed', window: learned.tokens });
    expect(after.ratio).toBeGreaterThanOrEqual(0.7); // i.e. the automatic soft limit is now tripped
    expect(JSON.stringify(events)).toMatch(/will compact on its own/);
  });

  it('does not overwrite a window the user stated, and says so instead', async () => {
    const { fetchFn } = refusesForSize();
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'gateway-model', allowedTools: ['read'], contextWindowTokens: 200_000 }),
      fetchFn as any, undefined, undefined, undefined, { retryBaseMs: 0, maxRetries: 0 }
    );
    withLongHistory(backend);

    const events = await runOneTurn(backend, 'hi');

    expect(events.find((e) => e.kind === 'context_overflow')).toBeUndefined();
    expect(backend.contextUsage()).toMatchObject({ source: 'configured', window: 200_000 });
    expect(JSON.stringify(events)).toMatch(/explicit Context window setting/);
  });

  // A request carries the system prompt, the tool schemas and any attached project knowledge as well as the
  // conversation. When the conversation is tiny, believing it was the cause would drive compaction into a
  // loop that summarises every turn, costs money, and still cannot make the request fit.
  it('declines to learn a ceiling from an overflow the conversation cannot explain', async () => {
    const { fetchFn } = refusesForSize();
    const backend = new OpenAICompatBackend(
      makeConfig({ model: 'gateway-model', allowedTools: ['read'] }), fetchFn as any, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0 }
    );

    const events = await runOneTurn(backend, 'hi');

    expect(events.find((e) => e.kind === 'context_overflow')).toBeUndefined();
    expect(backend.contextUsage().source).toBe('assumed');
    expect(JSON.stringify(events)).toMatch(/too small to explain this rejection/);
  });
});

describe('streamed response deadlines', () => {
  // The field symptom was "Thinking..." forever, most often after a search or read tool call — the requests
  // that carry the largest bodies, so the ones with the longest wait for a first token. Two defects stacked:
  // fetchStreamOnce cleared its timer in a `finally` that ran when the async iterable was RETURNED, before
  // a byte of the body was read; and the iterator's only abort check ran between reads, so it could never
  // preempt the read that was already pending.
  it('ends a stream that goes silent mid-body, and aborts it rather than abandoning it', async () => {
    const { streamFetchFn, aborted } = stallingStreamFetch([
      sse({ choices: [{ delta: { role: 'assistant' } }] }),
      sse({ choices: [{ delta: { content: 'partial' } }] }),
    ]);
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0, streamIdleTimeoutMs: 20, timeoutMs: 20 }, undefined, streamFetchFn
    );

    const events = await runOneTurn(backend, 'hi');
    const text = JSON.stringify(events);

    expect(text).toMatch(/stalled: no data for 20ms mid-stream/);
    // Aborting is the half that costs money: a stream we walk away from without tearing down leaves the
    // provider generating, and billing, output that can never reach us.
    expect(aborted()).toBe(true);
  });

  // The idle timeout bounds a DEAD stream. This bounds a LIVE one that never ends: a gateway emitting a
  // token every few seconds forever passes every idle check and still never returns an answer. The team's
  // field report — "worker still running after thousands of seconds" — is equally consistent with this
  // shape as with a dead connection, so both had to be bounded before either could be ruled out.
  it('ends a stream that keeps producing but never finishes', async () => {
    const encoder = new TextEncoder();
    let sawAbort = false;
    const streamFetchFn: StreamFetchFn = async (_url, init) => {
      init.signal?.addEventListener('abort', () => { sawAbort = true; });
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield encoder.encode(sse({ choices: [{ delta: { role: 'assistant' } }] }));
          // Never yields [DONE]: always something, never an ending.
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield encoder.encode(sse({ choices: [{ delta: { content: '.' } }] }));
          }
        })(),
      };
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0, streamIdleTimeoutMs: 500, streamTotalTimeoutMs: 60, timeoutMs: 500 },
      undefined, streamFetchFn
    );

    const events = await runOneTurn(backend, 'hi');
    const text = JSON.stringify(events);

    expect(text).toMatch(/exceeded its 60ms ceiling while still producing output/);
    expect(sawAbort).toBe(true);
  });

  // A per-attempt timeout is not a bound on the request: the worst case is timeout x (maxRetries + 1) plus
  // backoff. The Anthropic SDK documents that same relationship for its own client; nobody here had
  // computed our version of the product, which is the reason it is enforced rather than written down.
  // Non-streaming path only: `requestWithRetry` has exactly one caller, and `chatStream` has no
  // transient-failure retry at all — so the multiplied wait was never reachable on the streaming path
  // that production actually uses. Bound it where it exists rather than implying it was everywhere.
  it('gives up on the retry chain once the total request budget is spent', async () => {
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw new Error('ECONNRESET');
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn as any, undefined, undefined, undefined,
      { retryBaseMs: 5, maxRetries: 20, requestTotalTimeoutMs: 90, timeoutMs: 500 }
    );

    const events = await runOneTurn(backend, 'hi');
    const text = JSON.stringify(events);

    expect(text).toMatch(/exceeding the 90ms total budget/);
    // The point of the budget is that the attempt COUNT stops being what bounds the wait.
    expect(attempts).toBeLessThan(21);
  });

  // Audit, 2026-08-10: the budget was checked before the backoff sleep and never again, so the sleep plus a
  // full-length attempt could run past the ceiling — a budget shorter than one attempt's timeout could not
  // be honoured at all. The wall clock, not the attempt count, is what this bounds.
  it('honours a total budget smaller than a single attempt timeout', async () => {
    const started = Date.now();
    const fetchFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw new Error('ECONNRESET');
    };
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), fetchFn as any, undefined, undefined, undefined,
      { retryBaseMs: 60, maxRetries: 5, requestTotalTimeoutMs: 120, timeoutMs: 5000 }
    );

    await runOneTurn(backend, 'hi');

    // With the ceiling enforced on both sides of the sleep and applied to the attempt itself, the whole
    // chain fits in a small multiple of the budget instead of maxRetries x timeoutMs.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not cut off a slow but live stream — silence ends a turn, slowness does not', async () => {
    const encoder = new TextEncoder();
    const streamFetchFn: StreamFetchFn = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of [
          sse({ choices: [{ delta: { role: 'assistant' } }] }),
          sse({ choices: [{ delta: { content: 'still' } }] }),
          sse({ choices: [{ delta: { content: ' here' } }] }),
          'data: [DONE]\n\n',
        ]) {
          // Each gap is under the idle budget, but the total run time is well over it. A total-duration
          // timeout would kill this; an idle timeout must not.
          await new Promise((resolve) => setTimeout(resolve, 15));
          yield encoder.encode(chunk);
        }
      })(),
    });
    const backend = new OpenAICompatBackend(
      makeConfig({ allowedTools: ['read'] }), scriptedFetch([]).fetchFn, undefined, undefined, undefined,
      { retryBaseMs: 0, maxRetries: 0, streamIdleTimeoutMs: 60, timeoutMs: 60 }, undefined, streamFetchFn
    );

    const events = await runOneTurn(backend, 'hi');
    const text = JSON.stringify(events);

    expect(text).not.toMatch(/stalled/);
    expect(text).toContain('still here');
  });

  it('publishes a 15.8 KB host receipt as assistant text, never as a tool receipt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-turn-delivery-'));
    const source = `# Article\n\n${'x'.repeat(16 * 1024)}`;
    await fs.writeFile(path.join(dir, 'article.md'), source, 'utf8');
    const requests: any[] = [];
    let receiptId = '';
    const fetchFn: FetchFn = async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const callCount = requests.length;
      if (callCount === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"article.md"}' } }] } }] }) };
      }
      if (callCount === 2) {
        const history = JSON.stringify(request.messages);
        receiptId = /host content receipt: (receipt-[a-f0-9-]+)/i.exec(history)?.[1] ?? '';
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'publish', type: 'function', function: { name: 'publish_content_receipt', arguments: JSON.stringify({ receipt_id: receiptId, state: 'shown', framing: 'Here is the article:' }) } }] } }] }) };
      }
      throw new Error(`unexpected request ${callCount}`);
    };
    const team = new TeamTools('a1', { list: () => [{ id: 'a1', role: 'pm', name: 'PM', status: 'idle' }], resolve: () => undefined }, new MessageBus());
    const backend = new OpenAICompatBackend(makeConfig({ role: 'pm', allowedTools: ['read'], workingDirectory: dir }), fetchFn, team, undefined, undefined, { retryBaseMs: 0 });
    try {
      const events = await runOneTurn(backend, 'Show me the article.');
      const assistant = events.filter((event) => event.kind === 'assistant').map((event) => event.text);
      expect(receiptId).toMatch(/^receipt-/);
      expect(assistant).toEqual([`Here is the article:\n\n${source}`]);
      expect(Buffer.byteLength(assistant[0], 'utf8')).toBeGreaterThanOrEqual(15_800);
      expect(requests).toHaveLength(2);
      const terminalUse = events.find((event) => event.kind === 'tool_use' && event.name === 'publish_content_receipt');
      expect(terminalUse).toMatchObject({
        input: { receipt_id: receiptId, state: 'shown', framing: 'Here is the article:' },
      });
      expect((terminalUse as any)?.input).not.toHaveProperty('content');
      expect(JSON.stringify(events.filter((event) => event.kind === 'tool_result'))).toContain('publish_content_receipt');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
