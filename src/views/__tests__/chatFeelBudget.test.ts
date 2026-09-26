import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { renderMarkdown, setMarkdownRenderHookForTest } from '../markdown';

const agent: ChatAgent = {
  id: 'agent-1',
  name: 'Dev',
  role: 'Developer',
  backend: 'openai',
};

function depsFor(agents: ChatAgent[] = [agent]): ChatViewDeps {
  const store = new Map<string, unknown>();
  return {
    listAgents: () => agents,
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as ChatViewDeps;
}

function providerWith(deps = depsFor()): ChatViewProvider {
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(agent.id);
  return provider;
}

function attachView(provider: ChatViewProvider): unknown[] {
  const posts: unknown[] = [];
  const disposable = { dispose: vi.fn() };
  const webview = {
    cspSource: 'test:',
    options: {},
    html: '',
    onDidReceiveMessage: vi.fn(() => disposable),
    postMessage: vi.fn((msg: unknown) => {
      posts.push(msg);
      return Promise.resolve(true);
    }),
  };
  provider.resolveWebviewView({
    visible: true,
    webview,
    onDidChangeVisibility: vi.fn(() => disposable),
    show: vi.fn(),
  } as never);
  return posts;
}

function seedHistory(provider: ChatViewProvider, count: number): void {
  const fixture = (i: number) => [
    `Message ${i}: here is some prose explaining the change.`,
    '',
    '```ts',
    `const value${i} = ${i};`,
    '```',
    '',
    '- read the file',
    '- update the plan',
  ].join('\n');
  const messages = Array.from({ length: count }, (_, i) => ({
    role: 'agent',
    text: fixture(i),
    ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    seq: i,
    fromName: agent.name,
  }));
  (provider as any).presentation.replaceTranscript(agent.id, messages);
  (provider as any).initializedSeqs.delete(agent.id);
  (provider as any).nextSeqs.delete(agent.id);
  (provider as any).clearRenderedMarkdownCache(agent.id);
}

function jsonBytes(value: unknown): number {
  return JSON.stringify(value).length;
}

afterEach(() => {
  setMarkdownRenderHookForTest(undefined);
  vi.useRealTimers();
});

describe('chat feel budget', () => {
  it('keeps tool event payload and markdown work O(1) in transcript history', () => {
    const sizes: number[] = [];
    for (const historySize of [10, 500]) {
      const provider = providerWith();
      seedHistory(provider, historySize);
      // Warm the immutable message-block cache the same way an opened chat view does.
      (provider as any).currentState();
      const posts = attachView(provider);
      posts.length = 0;

      let renderCalls = 0;
      setMarkdownRenderHookForTest(() => { renderCalls++; });
      provider.appendToolActivity(agent.id, { phase: 'use', name: 'read_file', input: { path: 'ARCHITECTURE.md' } });
      setMarkdownRenderHookForTest(undefined);

      const toolPost = posts.find((p: any) => p.command === 'toolAppended');
      expect(toolPost).toBeTruthy();
      expect(renderCalls).toBe(0);
      const bytes = jsonBytes(toolPost);
      expect(bytes).toBeLessThanOrEqual(8 * 1024);
      sizes.push(bytes);

      posts.length = 0;
      renderCalls = 0;
      setMarkdownRenderHookForTest(() => { renderCalls++; });
      provider.appendToolActivity(agent.id, { phase: 'result', name: 'read_file', ok: true, summary: 'Read 242 lines' });
      setMarkdownRenderHookForTest(undefined);
      const updatePost = posts.find((p: any) => p.command === 'toolUpdated');
      expect(updatePost).toBeTruthy();
      expect(renderCalls).toBe(0);
      expect(jsonBytes(updatePost)).toBeLessThanOrEqual(8 * 1024);
    }
    expect(Math.abs(sizes[1] - sizes[0])).toBeLessThan(1024);
  });

  it('coalesces streamed markdown deltas into one render per frame', () => {
    vi.useFakeTimers();
    const provider = providerWith();
    const posts = attachView(provider);
    posts.length = 0;

    let renderCalls = 0;
    let renderChars = 0;
    setMarkdownRenderHookForTest((source) => { renderCalls++; renderChars += source.length; });
    const chunks = ['## Update\n', '\n', '- first\n', '- second\n', '\n```ts\n', 'const ok = true;\n'];
    for (const chunk of chunks) {
      provider.appendDelta(agent.id, chunk);
    }

    expect(renderCalls).toBe(0);
    expect(posts.some((p: any) => p.command === 'liveBlocks')).toBe(false);
    vi.advanceTimersByTime(16);
    setMarkdownRenderHookForTest(undefined); // stop counting before the assertions below render anything

    // THE property: six deltas produce ONE frame. Unchanged, and still the point of this test.
    const frames = posts.filter((p: any) => p.command === 'liveBlocks');
    expect(frames).toHaveLength(1);
    // This used to assert renderCalls === 1. That was a proxy for "the work in a frame is bounded", and it
    // was a bad one: it passed just as happily on the version that re-parsed the ENTIRE buffer every frame
    // at 60fps — the version that OOM'd the extension host at a 4 GB heap. LiveMarkdown now parses the
    // settled region once and the live tail once, so a frame makes up to two calls. Assert the budget
    // itself, in characters: a frame may not do more work than reading the document once.
    expect(renderCalls).toBeLessThanOrEqual(2);
    expect(renderChars).toBeLessThanOrEqual(chunks.join('').length);
    expect(jsonBytes(frames[0])).toBeLessThanOrEqual(8 * 1024);
  });

  it('coalesces streamed reasoning markdown through the same liveBlocks path', () => {
    vi.useFakeTimers();
    const provider = providerWith();
    const posts = attachView(provider);
    posts.length = 0;

    const source = '## Analysis\n\n- inspect\n- patch\n';
    let renderCalls = 0;
    let renderChars = 0;
    setMarkdownRenderHookForTest((s) => { renderCalls++; renderChars += s.length; });
    provider.appendReasoning(agent.id, '## Analysis\n\n');
    provider.appendReasoning(agent.id, '- inspect\n');
    provider.appendReasoning(agent.id, '- patch\n');

    expect(renderCalls).toBe(0);
    vi.advanceTimersByTime(16);
    setMarkdownRenderHookForTest(undefined); // stop counting before the assertions below render anything

    const frames = posts.filter((p: any) => p.command === 'liveBlocks');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'reasoning', replaceFrom: 0 });
    expect(frames[0].blocks).toEqual(renderMarkdown(source));
    // See the note in the message test above: a frame settles once and parses the live tail once, so the
    // budget is characters, not calls.
    expect(renderCalls).toBeLessThanOrEqual(2);
    expect(renderChars).toBeLessThanOrEqual(source.length);
  });

  it('makes the final streamed markdown frame deep-equal to the finalized transcript item', () => {
    vi.useFakeTimers();
    const provider = providerWith();
    const posts = attachView(provider);
    posts.length = 0;
    const firstPart = [
      '## Update',
      '',
      '| Area | Status |',
      '|---|---|',
      '| Streaming | **fixed** |',
      '',
      '- no final reflow',
      '- no raw markdown flash',
    ].join('\n');
    const secondPart = [
      '',
      '```ts',
      'const smooth = true;',
      '```',
    ].join('\n');
    const text = firstPart + secondPart;
    const renderedBlocks: ReturnType<typeof renderMarkdown> = [];
    const applyFrame = (frame: any) => {
      renderedBlocks.splice(frame.replaceFrom, renderedBlocks.length - frame.replaceFrom, ...(frame.blocks || []));
    };

    provider.appendDelta(agent.id, firstPart);
    vi.advanceTimersByTime(16);
    applyFrame(posts.find((p: any) => p.command === 'liveBlocks'));

    posts.length = 0;
    provider.appendDelta(agent.id, secondPart);
    vi.advanceTimersByTime(16);
    applyFrame(posts.find((p: any) => p.command === 'liveBlocks'));

    expect(renderedBlocks).toEqual(renderMarkdown(text));

    (provider as any).onReply({ from: agent.id, fromName: agent.name, text, isError: false });
    const statePost = posts.slice().reverse().find((p: any) => p.command === 'state') as any;
    const finalized = statePost.state.messages.find((m: any) => m.kind === 'message' && m.role === 'agent');

    expect(finalized.blocks).toEqual(renderedBlocks);
  });

  it('keeps live markdown frame payload bounded when a small tail follows a large stable prefix', () => {
    vi.useFakeTimers();
    const provider = providerWith();
    const posts = attachView(provider);
    posts.length = 0;
    const prefix = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with enough prose to make the prefix large.`).join('\n\n');
    provider.appendDelta(agent.id, prefix);
    vi.advanceTimersByTime(16);
    const prefixBlockCount = renderMarkdown(prefix).length;
    posts.length = 0;

    provider.appendDelta(agent.id, '\n\nTiny tail.');
    vi.advanceTimersByTime(16);

    const frame = posts.find((p: any) => p.command === 'liveBlocks') as any;
    expect(frame.replaceFrom).toBe(prefixBlockCount);
    expect(frame.blocks).toEqual(renderMarkdown('Tiny tail.'));
    expect(jsonBytes(frame)).toBeLessThanOrEqual(1024);
  });

  it('keeps update_todos as a plan refresh without emitting a tool card', () => {
    const provider = providerWith();
    const posts = attachView(provider);
    posts.length = 0;

    provider.appendToolActivity(agent.id, {
      phase: 'use',
      name: 'update_todos',
      input: { todos: [{ content: 'Measure chat feel', status: 'in_progress' }] },
    });

    expect(posts.some((p: any) => p.command === 'toolAppended' || p.command === 'toolUpdated')).toBe(false);
    const statePost = posts.find((p: any) => p.command === 'state') as any;
    expect(statePost.state.todos).toEqual([{ content: 'Measure chat feel', status: 'in_progress' }]);
  });
});
