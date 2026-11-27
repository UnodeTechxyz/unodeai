import { describe, expect, it, vi } from 'vitest';
import { UnodeSearchHost, type SearchTurn, type UnodeSearchPorts } from '../UnodeSearchHost';
import { parseUnodeSearchResponse } from '../UnodeSearchResponse';
import { unodeSearchCost, unodeSearchUnitPrice } from '../UnodeSearchPricing';
import { WorkspaceTools } from '../WorkspaceTools';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { MAX_OPERATION_HISTORY_RECORDS, BoundedOperationHistory } from '../../state/BoundedOperationHistory';

const response = {
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'server_tool_use', name: 'web_search', id: 'call', input: { query: 'rewritten private query' } },
    { type: 'web_search_tool_result', tool_use_id: 'call', content: [
      { type: 'web_search_result', title: 'Public source', url: 'https://www.example.com/article', encrypted_content: 'opaque-blob' },
      { type: 'web_search_result', title: 'Local address', url: 'http://localhost/read' },
    ] },
    { type: 'web_search_tool_result', tool_use_id: 'unmatched', content: [
      { type: 'web_search_result', title: 'Unmatched', url: 'https://www.example.com/unmatched' },
    ] },
    { type: 'text', text: 'Search answer.', citations: [
      { type: 'web_search_result_location', url: 'https://www.example.com/article', cited_text: 'A visible quotation', encrypted_index: 'opaque-index' },
      { type: 'web_search_result_location', url: 'https://www.example.com/unmatched', cited_text: 'Unattributed quotation' },
    ] },
  ],
  usage: {
    input_tokens: 2_857, output_tokens: 185, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 1 },
  },
};

function fixture(overrides: Partial<UnodeSearchPorts> = {}) {
  const controller = new AbortController();
  const turn: SearchTurn = { agentId: 'researcher', turn: {}, signal: controller.signal, current: () => true };
  const ports = {
    connection: () => ({ connectionId: 'unode', revision: 1, endpointBase: 'https://gateway.example/v1', secretName: 'UNODE_API_KEY' }),
    secret: async () => 'search-key-fixture',
    policy: () => undefined,
    approve: vi.fn(async () => ({ allow: true })),
    egress: vi.fn(async () => true),
    egressCurrent: () => true,
    activity: vi.fn(),
    started: vi.fn(),
    settled: vi.fn(),
    fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { headers: { 'x-request-id': 'test-request' } })),
    ...overrides,
  };
  const host = new UnodeSearchHost(ports);
  return { host, ports, turn, controller };
}

describe('host public search', () => {
  it('records retrieval from the fetch outcome even when the page starts with Error:', async () => {
    const url = 'https://192.0.2.1/article';
    const searchResponse = JSON.stringify(response).replaceAll('https://www.example.com/article', url);
    const f = fixture({ fetch: async () => new Response(searchResponse) });
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'researcher');
    tools.setWebSearch({ host: f.host, turnId: () => 'search-turn' });
    const fetchPage = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('Not found', { status: 404 }))
      .mockImplementationOnce(async () => new Response('Error: Ways to interpret experiment results'));
    try {
      const search = (query: string) => tools.run('web_search', { query });
      expect((await search('Find the source')).output).toContain('"source_status":"search-result"');
      expect(await tools.run('fetch_url', { url })).toMatchObject({ status: 'failed', output: 'Error: HTTP 404' });
      expect((await search('Check the source after the failed fetch')).output).toContain('"source_status":"search-result"');
      expect(await tools.run('fetch_url', { url })).toMatchObject({ status: 'success',
        output: '[Public search source: body retrieved by fetch_url]\nError: Ways to interpret experiment results' });
      expect((await search('Check the fetched source')).output).toContain('"source_status":"body-retrieved"');
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      fetchPage.mockRestore();
      tools.retire();
    }
  });

  it('dispatches web_search from the OpenAI-compatible backend and returns results to the model', async () => {
    const f = fixture();
    const modelCalls = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const toolResults = body.messages.filter((message: { role: string }) => message.role === 'tool');
      const message = toolResults.length === 0
        ? { role: 'assistant', content: null, tool_calls: [{
          id: 'search-call', type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'Current public research' }) },
        }] }
        : { role: 'assistant', content: 'Search complete.' };
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('web_search');
      if (toolResults.length) expect(JSON.stringify(toolResults)).toContain('https://www.example.com/article');
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
    });
    const params: ConstructorParameters<typeof OpenAICompatBackend> = [{
      id: 'researcher', name: 'Researcher', role: 'developer', skill: '', systemPrompt: 'Research.',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'fixture-model',
      workingDirectory: process.cwd(), autoApprove: true, allowedTools: ['read'], toolProtocol: 'native',
    }, modelCalls];
    params[16] = { webSearch: { host: f.host, turnId: () => 'search-turn' } };
    const backend = new OpenAICompatBackend(...params);
    try {
      const done = new Promise<boolean>(resolve => backend.onEvent(event => {
        if (event.kind === 'turn_complete') resolve(event.result.isError);
      }));
      await backend.start({ ROAM_API_KEY: 'fixture-chat-key' });
      backend.sendUserTurn('Look up current public research.');
      expect(await done).toBe(false);
      expect(modelCalls).toHaveBeenCalledTimes(2);
      expect(f.ports.fetch).toHaveBeenCalledOnce();
    } finally { await backend.stop(); }
  });

  it.each(['approval', 'egress'] as const)('checks a request limit reached during the paid search %s wait', async pausedAt => {
    let reached = false;
    const f = fixture({
      policy: () => 'ask',
      approve: async () => { if (pausedAt === 'approval') reached = true; return { allow: true }; },
      egress: async () => { if (pausedAt === 'egress') reached = true; return true; },
    });
    f.turn.boundary = async () => reached ? 'stopped' : 'proceed';
    expect(await f.host.search({ query: 'public data' }, f.turn)).toMatchObject({ state: 'refused', reason: 'request-limit' });
    expect(f.ports.started).not.toHaveBeenCalled();
    expect(f.ports.fetch).not.toHaveBeenCalled();
  });
  it('offers the API tool under Allow and keeps the Codex declaration while refusing stale calls', async () => {
    let policy = 'allow';
    let turnId = 'turn-1';
    let nativeOff = false;
    const f = fixture({ policy: () => policy });
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'researcher');
    tools.setWebSearch({ host: f.host, turnId: () => turnId });
    expect(tools.specs().map(spec => spec.function.name)).toContain('web_search');
    expect(await tools.run('web_search', { query: 'private test' })).toMatchObject({ status: 'success',
      output: expect.stringContaining('Estimated search fee: USD $0.01') });
    policy = 'off';
    expect(tools.specs().map(spec => spec.function.name)).not.toContain('web_search');
    expect(await tools.run('web_search', { query: 'would leak' })).toMatchObject({ status: 'refused' });
    tools.setWebSearch({ host: f.host, turnId: () => turnId, nativeOff: () => nativeOff, cliCanRead: () => true });
    expect(tools.specs().map(spec => spec.function.name)).toContain('web_search');
    policy = 'allow';
    expect(await tools.run('web_search', { query: 'native route active' })).toMatchObject({ status: 'refused' });
    nativeOff = true;
    turnId = 'turn-2';
    tools.beginTurn();
    expect(await tools.run('web_search', { query: 'native route off' })).toMatchObject({ status: 'success' });
    expect(f.ports.fetch).toHaveBeenCalledTimes(2);
    tools.retire();
  });

  it.each(['max_tokens', 'pause_turn'])('marks structured sources partial after %s', stop_reason => {
    expect(parseUnodeSearchResponse({ ...response, stop_reason })?.result)
      .toMatchObject({ state: 'partial', sources: [expect.objectContaining({ title: 'Public source' })] });
  });
  it('attributes only structured results and strips queries, encrypted fields and unmatched citations from model output', () => {
    const parsed = parseUnodeSearchResponse(response)!;
    expect(parsed.queries).toEqual(['rewritten private query']);
    expect(parsed.result).toMatchObject({ state: 'completed', answer: 'Search answer.', sources: [{
      title: 'Public source', url: 'https://www.example.com/article', source_status: 'search-result', cited_text: ['A visible quotation'],
    }], usage: { web_search_requests: 1 } });
    expect(JSON.stringify(parsed.result)).not.toMatch(/opaque|rewritten|Unattributed|Local address/);
    const off = parseUnodeSearchResponse({ ...response, content: [{ type: 'text', text: 'https://www.example.com/article' }], usage: {} })!;
    expect(off.result).toMatchObject({ state: 'no-search-executed', sources: [], usage: { web_search_requests: 0 } });
    expect(parseUnodeSearchResponse({ ...response, content: [], })?.result.state).toBe('no-structured-sources');
    const max = parseUnodeSearchResponse({ ...response, content: [...response.content, {
      type: 'web_search_tool_result', tool_use_id: 'call', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    }] })!;
    expect(max.result).toMatchObject({ state: 'partial', error: 'max-uses' });
  });

  it('shares the dated price entry across Ask, Allow activity, and search cost', async () => {
    const f = fixture({ policy: () => 'ask' });
    const result = await f.host.search({ query: 'private search terms' }, f.turn);
    expect(f.ports.approve).toHaveBeenCalledExactlyOnceWith(f.turn, 'private search terms', 'USD $0.01/search at list (Unode Usage Logs, 2026-11-23)');
    expect(f.ports.activity).toHaveBeenCalledWith(f.turn, expect.stringContaining(unodeSearchUnitPrice() + ' · 1/10'));
    expect(f.ports.activity).not.toHaveBeenCalledWith(f.turn, expect.stringContaining('private search terms'));
    expect(result).toMatchObject({ state: 'completed', details: { searchFeeNanoUsd: '10000000',
      estimatedSearchFee: expect.stringContaining('discount observed on 2026-11-23: 40%. It can change.'),
      total: { nanoUsd: '10378200', sourceDate: '2026-11-23', basis: 'unode-reference' } } });
    expect(unodeSearchCost({})).toEqual({ total: { basis: 'unavailable' } });
    expect(f.ports.settled).toHaveBeenCalledWith(f.turn, expect.objectContaining({ requestId: 'test-request' }), result, ['rewritten private query']);
  });

  it.each([
    { reported: undefined, fee: '10000000', amount: '$0.01' },
    { reported: 0, fee: '0', amount: '$0.000000' },
    { reported: 2, fee: '20000000', amount: '$0.02' },
  ])('prices matched search results when the gateway reports $reported searches', async ({ reported, fee, amount }) => {
    const { server_tool_use: _reported, ...usage } = response.usage;
    const f = fixture({ fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...response,
      content: [...response.content, response.content[1]],
      usage: { ...usage, ...(reported === undefined ? {} : { server_tool_use: { web_search_requests: reported } }) },
    }))) });
    const result = await f.host.search({ query: 'public search terms' }, f.turn);
    expect(result).toMatchObject({ state: 'completed', details: {
      sources: [expect.objectContaining({ url: 'https://www.example.com/article' })],
      searchFeeNanoUsd: fee,
      estimatedSearchFee: expect.stringContaining(`USD ${amount} at list`),
    } });
    if (!('details' in result)) throw new Error('Expected search details');
    if (reported === undefined) {
      expect(result.details.estimatedSearchCount).toBe(1);
      expect(result.details.usage).not.toHaveProperty('web_search_requests');
      expect(result.details.estimatedSearchFee).toContain('Upper-bound estimate at the dated list price from the response. The gateway did not report a search count. The Unode bill is final.');
    } else {
      expect(result.details.usage.web_search_requests).toBe(reported);
      expect(result.details).not.toHaveProperty('estimatedSearchCount');
      expect(result.details.estimatedSearchFee).not.toContain('from the response');
    }
  });

  it('does not infer fees from unpaired search blocks', () => {
    const parsed = parseUnodeSearchResponse({ ...response, content: [response.content[2]], usage: {} })!;
    expect(parsed.result).toMatchObject({ state: 'no-structured-sources', sources: [], usage: {} });
    expect(parsed.result).not.toHaveProperty('estimatedSearchCount');
  });

  it.each([undefined, 0])('reports an unsourced answer and records tokens without retry when the search count is %s', async searches => {
    const f = fixture({ fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Astral maintains uv.' }],
      usage: { input_tokens: 344, output_tokens: 92,
        ...(searches === undefined ? {} : { server_tool_use: { web_search_requests: searches } }) },
    }))) });
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'researcher');
    tools.setWebSearch({ host: f.host, turnId: () => 'search-turn' });
    try {
      const result = await tools.run('web_search', { query: 'which company maintains the Python package manager uv' });
      expect(result.status).toBe('success');
      expect(result.output).toContain('no-search-executed');
      expect(result.output).toContain('The search service answered without searching. There are no sources; this answer must not be presented as sourced.');
      expect(result.output).toContain('Estimated search fee: USD $0');
      expect(f.ports.settled).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
        state: 'no-search-executed', details: expect.objectContaining({ sources: [], searchFeeNanoUsd: '0',
          usage: { input_tokens: 344, output_tokens: 92, web_search_requests: 0 } }),
      }), []);
      expect(f.ports.fetch).toHaveBeenCalledOnce();
    } finally { tools.retire(); }
  });

  it('warns of possible cost after a send becomes stale and withholds the old response', async () => {
    let policy = 'allow';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      policy = 'off';
      return new Response(JSON.stringify(response));
    });
    const f = fixture({ fetch, policy: () => policy });
    const result = await f.host.search({ query: 'test' }, f.turn);
    expect(result).toMatchObject({ state: 'outcome-unknown', may_have_cost: true, message: expect.stringContaining('may have cost money') });
    expect(result).not.toHaveProperty('details');
    expect(f.ports.settled).toHaveBeenCalledWith(f.turn, expect.anything(), expect.objectContaining({ state: 'completed' }), ['rewritten private query']);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['unode.webSearch.v1.', 'unode.transcription.v1.'])('bounds %s history across concurrent writes and prunes legacy records', async prefix => {
    const data = new Map<string, unknown>([
      [prefix + 'old', { privateMetadata: 'old record' }],
      ['another.setting', true],
    ]);
    const history = new BoundedOperationHistory({
      keys: () => [...data.keys()],
      get: <T>(key: string, fallback?: T) => (data.get(key) ?? fallback) as T,
      update: async (key, value) => { if (value === undefined) data.delete(key); else data.set(key, value); },
    }, prefix);
    await Promise.all(Array.from({ length: MAX_OPERATION_HISTORY_RECORDS + 2 }, (_, i) =>
      history.write({ operationId: 'operation-' + i, queries: ['private query ' + i] })));
    expect([...data.keys()].filter(key => key.startsWith(prefix))).toHaveLength(MAX_OPERATION_HISTORY_RECORDS);
    expect(data.has(prefix + 'old')).toBe(false);
    expect(data.has(prefix + 'operation-1')).toBe(false);
    expect(data.get(prefix + 'operation-2')).toMatchObject({ queries: ['private query 2'] });
    expect(data.get('another.setting')).toBe(true);
  });

  it('uses the default Allow without a card and atomically refuses the eleventh call until next turn', async () => {
    const f = fixture();
    const calls = await Promise.all(Array.from({ length: 11 }, () => f.host.search({ query: 'weekly news' }, f.turn)));
    expect(f.ports.approve).not.toHaveBeenCalled();
    expect(f.ports.fetch).toHaveBeenCalledTimes(10);
    const request = vi.mocked(f.ports.fetch).mock.calls[0];
    expect(request[0]).toBe('https://gateway.example/v1/messages');
    expect(request[1]).toMatchObject({ redirect: 'manual', headers: { 'x-api-key': 'search-key-fixture', 'anthropic-version': '2023-06-01' } });
    const body = JSON.parse(request[1]!.body as string);
    expect(body).toMatchObject({ model: 'claude-haiku-5-5',
      system: 'You are a public web search service. Always call web_search at least once before answering, even when you think you know the answer. Answer only from the search results and cite them.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] });
    expect(body.tool_choice === undefined || body.tool_choice.type === 'auto').toBe(true);
    expect(calls[10]).toMatchObject({ state: 'refused', message: expect.stringContaining('continue next turn') });
    expect(await f.host.search({ query: 'new turn' }, { ...f.turn, turn: {} })).toMatchObject({ state: 'completed' });
  });

  it('never sends after Stop, Off, a declined Ask, or a credential change during approval', async () => {
    for (const blocked of ['stop', 'off', 'decline', 'key']) {
      let policy = 'ask';
      let key = 'before';
      const f = fixture({
        policy: () => policy,
        secret: async () => key,
        approve: async () => {
          if (blocked === 'stop') f.controller.abort();
          if (blocked === 'off') policy = 'off';
          if (blocked === 'key') key = 'after';
          return { allow: blocked !== 'decline' };
        },
      });
      expect(await f.host.search({ query: 'test' }, f.turn), blocked).toMatchObject({ state: 'refused' });
      expect(f.ports.fetch).not.toHaveBeenCalled();
    }
  });

  it('keeps the call-limit and missing-key guidance in the model-facing tool refusal', async () => {
    const f = fixture();
    const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'researcher');
    tools.setWebSearch({ host: f.host, turnId: () => 'turn' });
    try {
      await Promise.all(Array.from({ length: 10 }, () => tools.run('web_search', { query: 'test' })));
      const limit = await tools.run('web_search', { query: 'test' });
      expect(limit).toMatchObject({ status: 'refused', output: expect.stringContaining('continue next turn') });
      const missing = fixture({ secret: async () => undefined });
      tools.setWebSearch({ host: missing.host, turnId: () => 'turn' });
      expect(await tools.run('web_search', { query: 'test' })).toMatchObject({ status: 'refused', output: expect.stringContaining('Providers > Unode') });
    } finally { tools.retire(); }
  });

  it('starts its 120 second timer after approval and does not repeat an unknown send', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const f = fixture({
        policy: () => 'ask',
        approve: async () => { expect(timeout).not.toHaveBeenCalled(); return { allow: true }; },
        fetch: vi.fn<typeof fetch>(async () => { throw new Error('transport lost'); }),
      });
      expect(await f.host.search({ query: 'test' }, f.turn)).toMatchObject({ state: 'outcome-unknown', may_have_cost: true });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(120_000);
      expect(f.ports.fetch).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });
});
