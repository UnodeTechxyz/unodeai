import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { MCPHub } from '../../mcp/MCPHub';
import type { AgentConfig } from '../../types';
import type { BackendEvent } from '../AgentBackend';
import { boundToolResultWithContinuation, MODEL_TOOL_RESULT_MAX_CHARS } from '../boundToolResultForModel';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { WorkspaceTools } from '../WorkspaceTools';

// v0.9.99: a long tool or web result is kept whole for the agent that received it; the model reads the rest from that
// copy through read_extracted_content, and nothing is run or fetched again. All payloads are synthetic.

const CONTINUATION = /read_extracted_content\(\{ assetId: "([^"]+)", pages: \{ start: (\d+)(?:, end: \d+)? \}(?:, offset: (\d+))? \}\)/;

function config(): AgentConfig {
  return {
    id: 'agent-a',
    name: 'Worker',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat',
    systemPrompt: 'Be terse.',
    autoApprove: true,
    allowedTools: ['read'],
    workingDirectory: process.cwd(),
  };
}

/**
 * A model that calls `first`, then follows every continuation the host names until a result contains `until`, then
 * answers. It records every request it was sent.
 */
function followingModel(first: { name: string; args: Record<string, unknown> }, until: string): { fetchFn: FetchFn; requests: any[] } {
  const requests: any[] = [];
  let step = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const tools = request.messages.filter((m: any) => m.role === 'tool');
    const last = tools[tools.length - 1]?.content as string | undefined;
    let message: any;
    if (step === 0) {
      message = { role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: first.name, arguments: JSON.stringify(first.args) } }] };
    } else if (last && !last.includes(until) && CONTINUATION.test(last) && step < 20) {
      const [, assetId, page, offset] = CONTINUATION.exec(last)!;
      const args = { assetId, pages: { start: Number(page) }, ...(offset ? { offset: Number(offset) } : {}) };
      message = { role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'read_extracted_content', arguments: JSON.stringify(args) } }] };
    } else {
      message = { role: 'assistant', content: 'done' };
    }
    step++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  return { fetchFn, requests };
}

async function runTurn(backend: OpenAICompatBackend, instruction: string): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  const done = new Promise<void>((resolve) => backend.onEvent((event) => {
    events.push(event);
    if (event.kind === 'turn_complete') resolve();
  }));
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn(instruction);
  await done;
  return events;
}

function backendWith(store: ContentAssetStore, fetchFn: FetchFn, hub?: MCPHub): OpenAICompatBackend {
  return new OpenAICompatBackend(
    config(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, noProgressBackoffMs: 0 },
    hub ? { hub, grants: [{ serverId: 'github', toolFilter: 'all' }] } : undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { delegationContentAssets: store },
  );
}

/** Another agent's tool surface on the same store. */
function otherAgentTools(store: ContentAssetStore): WorkspaceTools {
  return new WorkspaceTools(
    process.cwd(), new Set(['read']), 'agent-b', undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, 'apply-edit', store,
  );
}

function toolMessages(requests: any[]): string[] {
  const last = requests[requests.length - 1];
  return last.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
}

afterEach(() => vi.unstubAllGlobals());

describe('v0.9.99 tool results past the model bound keep a readable remainder', () => {
  it('an MCP result of 30,004 characters reaches TAIL through the kept copy, and the tool runs exactly once', async () => {
    const payload = 'x'.repeat(30_000) + 'TAIL';
    let calls = 0;
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'report', description: 'a long report' }]; },
      async callTool() { calls++; return payload; },
      async close() {},
    }));
    await hub.register({ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx' });
    const store = new ContentAssetStore();
    try {
      const { fetchFn, requests } = followingModel({ name: 'github__report', args: {} }, 'TAIL');
      const events = await runTurn(backendWith(store, fetchFn, hub), 'get the report');

      expect(calls).toBe(1);
      const [first, ...rest] = toolMessages(requests);
      expect(first).not.toContain('TAIL');
      expect(first).toMatch(/^\[Result shortened: the first 23,000 of 30,004 characters follow\. The complete result is kept for you as content-\d+; reading it does not run the tool again\./);
      expect(first.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
      expect(first).toContain(payload.slice(0, 23_000));
      expect(first).not.toContain('Tool result truncated');
      expect(rest.length).toBeGreaterThan(0);
      const read = rest[rest.length - 1];
      expect(read).toContain('Untrusted tool result');
      // The preview and the read together are the whole result, with nothing skipped or repeated.
      expect(read).toContain(`: ${payload.slice(23_000)}`);
      expect(events.some((event) => event.kind === 'tool_result' && event.name === 'read_extracted_content'
        && event.outcome.status === 'success')).toBe(true);
      expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toBe('done');

      // Per-agent authority: another agent on the same store cannot read the kept copy.
      const assetId = CONTINUATION.exec(first)![1];
      const other = await otherAgentTools(store).run('read_extracted_content', { assetId, pages: { start: 2 } });
      expect(other.status).toBe('refused');
      expect(other.output).not.toContain('TAIL');
    } finally {
      await store.dispose();
    }
  });

  it('a 100,004-character web text is kept whole; its tail is read from the kept copy without fetching again', async () => {
    const payload = 'y'.repeat(100_000) + 'TAIL';
    const web = vi.fn(async () => new Response(payload, { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', web);
    const store = new ContentAssetStore();
    try {
      const { fetchFn, requests } = followingModel({ name: 'fetch_url', args: { url: 'https://93.184.216.34/long' } }, 'TAIL');
      await runTurn(backendWith(store, fetchFn), 'read the page');

      expect(web).toHaveBeenCalledTimes(1);
      const [first, ...reads] = toolMessages(requests);
      expect(first).not.toContain('TAIL');
      expect(first).toContain('[Result shortened: the first 20,000 of 100,004 characters follow.');
      expect(first).toContain('reading it does not fetch the page again');
      expect(first.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
      // Pages 2 to 6 follow one by one; the last holds TAIL. Every character after the preview is read once.
      expect(reads).toHaveLength(5);
      expect(reads[reads.length - 1]).toContain('Untrusted remote content');
      expect(reads[reads.length - 1]).toContain('TAIL');
      const readText = reads.map((text) => /\nPage \d+: ([y]*(?:TAIL)?)/.exec(text)?.[1] ?? '').join('');
      expect(readText).toBe(payload.slice(20_000));
    } finally {
      await store.dispose();
    }
  });

  it('a result that fits the bound is unchanged, and nothing is kept for it', async () => {
    const keep = vi.fn(async () => 'content-1');
    const fits = 'z'.repeat(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(await boundToolResultWithContinuation('mcp__example__report', fits, keep)).toBe(fits);
    expect(keep).not.toHaveBeenCalled();
  });

  it('a result nothing can keep is cut with the old warning rather than lost silently', async () => {
    const output = await boundToolResultWithContinuation('mcp__example__report', 'x'.repeat(30_000) + 'TAIL', async () => undefined);
    expect(output).toContain('[Tool result truncated. Omitted content was not read; do not claim complete coverage.]');
    expect(output).not.toContain('TAIL');
  });

  it('a preview never ends between the two halves of a surrogate pair', async () => {
    const output = 'a'.repeat(22_999) + '\u{1F600}' + 'b'.repeat(2_000);
    const bounded = await boundToolResultWithContinuation('mcp__example__report', output, async () => 'content-9');
    expect(bounded).toContain('the first 22,999 of 25,001 characters follow');
    expect(bounded).toContain('pages: { start: 2 }, offset: 2999');
    expect(bounded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('an agent without read permission keeps nothing', async () => {
    const store = new ContentAssetStore();
    try {
      const tools = new WorkspaceTools(
        process.cwd(), new Set([]), 'agent-c', undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, 'apply-edit', store,
      );
      expect(await tools.keepToolResultSource('x'.repeat(30_000))).toBeUndefined();
    } finally {
      await store.dispose();
    }
  });
});
