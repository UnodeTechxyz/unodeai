import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('vscode', () => ({}));

import { ChatAgent, ChatReply, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';

/**
 * UX7 row 3 — "streaming text, one tool execution, one approval, one delegation, one verifier result,
 * one error, one cancellation all proven **in the Workbench**".
 *
 * The row used to be justified by naming the unit test for each event kind plus the shared-renderer test
 * in `ChatViewProvider.test.ts`. That justification does not hold: `chatToolHistory`, `approvals`,
 * `orchestrationProgress`, `transcriptPort` and `parallelConsoleModel` never construct a
 * `ChatViewProvider` at all — they exercise the models and queues that sit UNDER the renderer, so they
 * cannot show that an event ever reaches a mounted surface, let alone the Workbench one.
 *
 * This file closes that gap directly: mount both containers on one provider, drive each of the seven
 * event kinds through the same host API the backends use, and assert that the Workbench panel and the
 * sidebar view each received a message actually carrying that event. The boundary asserted is the
 * host→webview `postMessage`; the renderer beyond it is shared by both containers, which
 * `ChatViewProvider.test.ts` ("uses one renderer for sidebar and Workbench") pins separately.
 */

const AGENT: ChatAgent = { id: 'agent-1', name: 'Dev', role: 'Developer', backend: 'openai' };

type Posted = Record<string, any>;

interface EmittedNode {
  className: string;
  title: string;
  textContent: string;
  children: EmittedNode[];
  append: (...children: EmittedNode[]) => void;
  appendChild: (child: EmittedNode) => EmittedNode;
  setAttribute: () => void;
}

function emittedDelegationRenderer(html: string): (summary: unknown) => EmittedNode {
  const source = `${emittedFunction(html, 'statusDot')}\n${emittedFunction(html, 'coordinatorDispositionLabel')}\n${emittedFunction(html, 'coordinatorDispositionTask')}\n${emittedFunction(html, 'delegationStatusLabel')}\n${emittedFunction(html, 'renderDelegation')}\nreturn renderDelegation;`;
  const document = {
    createElement: (): EmittedNode => {
      const node: EmittedNode = {
        className: '', title: '', textContent: '', children: [],
        append: (...children) => { node.children.push(...children); },
        appendChild: (child) => { node.children.push(child); return child; },
        setAttribute: () => undefined,
      };
      return node;
    },
  };
  // This runs the exact function emitted in the mounted webview, against the minimal DOM it requires.
  return new Function('document', source)(document) as (summary: unknown) => EmittedNode;
}

function emittedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`webview did not emit ${name}`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') { depth++; }
    if (source[index] === '}' && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`webview emitted an unclosed ${name}`);
}

function visibleText(node: EmittedNode): string {
  return [node.textContent, ...node.children.map(visibleText)].filter(Boolean).join('\n');
}

function harness() {
  const store = new Map<string, unknown>();
  let replyTo: ((reply: ChatReply) => void) | undefined;
  const deps = {
    listAgents: () => [AGENT],
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: (cb: (reply: ChatReply) => void) => { replyTo = cb; return vi.fn(); },
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as unknown as ChatViewDeps;

  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(AGENT.id);

  const sidebarPosts: Posted[] = [];
  const workbenchPosts: Posted[] = [];
  let sidebarMessage: ((message: unknown) => void) | undefined;
  const noop = () => ({ dispose: vi.fn() });

  const sidebar = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {},
      postMessage: (m: Posted) => { sidebarPosts.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { sidebarMessage = listener; return { dispose: vi.fn() }; },
    },
    onDidChangeVisibility: noop,
    onDidDispose: noop,
    show: vi.fn(),
  };
  const workbench: any = {
    visible: true,
    viewColumn: 1,
    webview: {
      cspSource: 'test:', html: '', options: {},
      postMessage: (m: Posted) => { workbenchPosts.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: () => ({ dispose: vi.fn() }),
    },
    reveal: vi.fn(),
    onDidChangeViewState: noop,
    onDidDispose: noop,
    dispose: vi.fn(),
  };

  provider.resolveWebviewView(sidebar as never);
  provider.restoreWorkbench(workbench as never);
  sidebarPosts.length = 0;
  workbenchPosts.length = 0;

  return {
    provider,
    deps,
    sidebarPosts,
    workbenchPosts,
    workbenchHtml: () => workbench.webview.html,
    fromSidebar: (message: unknown) => sidebarMessage?.(message),
    reply: (reply: ChatReply) => replyTo?.(reply),
  };
}

type Harness = ReturnType<typeof harness>;

/** Every `state` payload the surface received, newest last. */
const states = (posts: Posted[]) => posts.filter((m) => m.command === 'state').map((m) => m.state);

interface EventCase {
  /** The UX7 row-3 event kind, worded as the row words it. */
  kind: string;
  inject: (h: Harness) => void;
  /** True when THIS surface's own message stream carries the event. Run against each container. */
  carries: (posts: Posted[]) => boolean;
  /** What a failure here would mean for a user sitting in front of the Workbench. */
  ifMissing: string;
}

const CASES: EventCase[] = [
  {
    kind: 'streaming text',
    inject: (h) => {
      h.provider.appendDelta(AGENT.id, 'Rewriting the auth middleware now.');
      vi.advanceTimersByTime(500);
    },
    carries: (posts) => posts.some((m) =>
      m.command === 'liveBlocks' && JSON.stringify(m.blocks ?? []).includes('Rewriting the auth middleware now.')),
    ifMissing: 'the reply streams into one surface and the other shows a silent, apparently idle agent',
  },
  {
    kind: 'one tool execution',
    inject: (h) => {
      h.provider.appendToolActivity(AGENT.id, { phase: 'use', name: 'edit_file', input: { path: 'src/auth.ts' } });
      h.provider.appendToolActivity(AGENT.id, { phase: 'result', name: 'edit_file', ok: true, summary: 'Edited src/auth.ts' });
    },
    carries: (posts) =>
      posts.some((m) => m.command === 'toolAppended' && m.item?.name === 'edit_file') &&
      posts.some((m) => m.command === 'toolUpdated' && m.item?.summary === 'Edited src/auth.ts'),
    ifMissing: 'a tool card either never appears or never resolves, so the work looks stuck mid-call',
  },
  {
    kind: 'one approval',
    inject: (h) => {
      void h.provider.requestApproval({ kind: 'tool', agentName: 'Dev', toolName: 'Web access' });
    },
    carries: (posts) => states(posts).some((s) =>
      (s.pendingApprovals ?? []).some((a: Posted) => a.toolName === 'Web access')),
    ifMissing: 'the decision is invisible on that surface and the run blocks on a card nobody can see',
  },
  {
    kind: 'one delegation',
    inject: (h) => {
      h.provider.setDelegationProgress([{
        id: 'del-1', coordinatorId: AGENT.id, coordinatorName: 'Dev',
        startedAt: '2026-08-01T00:00:00.000Z', total: 1, done: 0, blocked: 0, working: 1,
        items: [{
          id: 'item-1', coordinatorId: AGENT.id, coordinatorName: 'Dev',
          agentId: 'agent-2', agentName: 'Reviewer', instruction: 'review the diff',
          status: 'working', startedAt: '2026-08-01T00:00:00.000Z',
        }],
      }]);
    },
    carries: (posts) => states(posts).some((s) =>
      s.delegatingCounts?.[AGENT.id] === 1 &&
      (s.messages ?? []).some((m: Posted) => m.kind === 'delegation' && m.items?.[0]?.agentName === 'Reviewer')),
    ifMissing: 'a coordinator that has farmed work out reads as idle, which is the exact confusion 0.9.28 fixed',
  },
  {
    kind: 'one verifier result',
    inject: (h) => {
      h.provider.setDelegationProgress([{
        id: 'del-1', coordinatorId: AGENT.id, coordinatorName: 'Dev',
        startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:01:00.000Z',
        total: 1, done: 1, blocked: 0, working: 0, verified: 1,
        items: [{
          id: 'item-1', coordinatorId: AGENT.id, coordinatorName: 'Dev',
          agentId: 'agent-2', agentName: 'Reviewer', instruction: 'review the diff',
          status: 'verified', startedAt: '2026-08-01T00:00:00.000Z',
          completedAt: '2026-08-01T00:01:00.000Z', result: 'Tests pass; diff matches the request.',
        }],
      }]);
    },
    carries: (posts) => states(posts).some((s) =>
      (s.messages ?? []).some((m: Posted) =>
        m.kind === 'delegation' && m.verified === 1 &&
        m.items?.[0]?.status === 'verified' &&
        m.items?.[0]?.result === 'Tests pass; diff matches the request.')),
    ifMissing: 'the surface still shows raw completion, and "done" gets mistaken for "checked"',
  },
  {
    kind: 'one error',
    inject: (h) => {
      h.reply({ from: AGENT.id, text: 'The connection refused the request (HTTP 400).', isError: true } as ChatReply);
    },
    carries: (posts) => states(posts).some((s) =>
      (s.messages ?? []).some((m: Posted) => m.isError === true && m.text === 'The connection refused the request (HTTP 400).')),
    ifMissing: 'a failed turn reads as an ordinary reply, or as no reply at all',
  },
  {
    kind: 'one cancellation',
    inject: (h) => {
      // Cancellation is the one event a surface ORIGINATES. Drive it from the sidebar so the assertion
      // on the Workbench is a genuine cross-surface claim, not the same surface hearing itself.
      h.fromSidebar({ command: 'send', agentId: AGENT.id, text: 'start the long job' });
      h.fromSidebar({ command: 'interrupt', agentId: AGENT.id });
    },
    carries: (posts) => states(posts).some((s) =>
      (s.messages ?? []).some((m: Posted) => m.text === 'Stopped by user.')),
    ifMissing: 'the user stops a run on one surface and the other keeps presenting it as live',
  },
];

describe('UX7 row 3 — each event kind reaches BOTH the sidebar and the Workbench', () => {
  afterEach(() => { vi.useRealTimers(); });

  for (const c of CASES) {
    it(`${c.kind} — delivered to the Workbench panel, not only the sidebar`, () => {
      vi.useFakeTimers();
      const h = harness();

      c.inject(h);

      expect(h.workbenchPosts.length, `the Workbench received nothing at all for "${c.kind}"`).toBeGreaterThan(0);
      expect(c.carries(h.workbenchPosts), `Workbench is missing "${c.kind}": ${c.ifMissing}`).toBe(true);
      expect(c.carries(h.sidebarPosts), `sidebar is missing "${c.kind}": ${c.ifMissing}`).toBe(true);
    });
  }

  it('covers exactly the seven event kinds the row names', () => {
    expect(CASES.map((c) => c.kind)).toEqual([
      'streaming text',
      'one tool execution',
      'one approval',
      'one delegation',
      'one verifier result',
      'one error',
      'one cancellation',
    ]);
  });

  it('pushes task.status activity into the mounted Workbench delegation card state, not merely a changed key (T10)', () => {
    const h = harness();
    h.provider.setDelegationProgress([{
      id: 'del-status', coordinatorId: AGENT.id, coordinatorName: 'Dev',
      startedAt: '2026-08-01T00:00:00.000Z', total: 1, done: 0, blocked: 0, working: 1,
      items: [{
        id: 'item-status', coordinatorId: AGENT.id, coordinatorName: 'Dev', agentId: 'agent-2', agentName: 'Reviewer',
        instruction: 'review the diff', status: 'working', startedAt: '2026-08-01T00:00:00.000Z',
      }],
    }]);
    h.provider.setDelegationProgress([{
      id: 'del-status', coordinatorId: AGENT.id, coordinatorName: 'Dev',
      startedAt: '2026-08-01T00:00:00.000Z', total: 1, done: 0, blocked: 0, working: 1,
      items: [{
        id: 'item-status', coordinatorId: AGENT.id, coordinatorName: 'Dev', agentId: 'agent-2', agentName: 'Reviewer',
        instruction: 'review the diff', activity: 'Reading project context.', updatedAt: '2026-08-01T00:00:05.000Z',
        status: 'working', startedAt: '2026-08-01T00:00:00.000Z',
      }],
    }]);

    for (const posts of [h.sidebarPosts, h.workbenchPosts]) {
      const newest = states(posts).at(-1);
      const card = newest?.messages?.find((message: Posted) => message.kind === 'delegation');
      expect(card?.items?.[0]?.activity).toBe('Reading project context.');
    }
  });

  it('changes visible text when the emitted webview delegation renderer receives task.status (T10)', () => {
    const h = harness();
    const render = emittedDelegationRenderer(h.workbenchHtml());
    const base = {
      coordinatorName: 'Dev', total: 1, done: 0, blocked: 0, working: 1,
      items: [{ agentName: 'Reviewer', instruction: 'review the diff', status: 'working' }],
    };
    const afterStatus = {
      ...base,
      items: [{ ...base.items[0], activity: 'Reading project context.' }],
    };

    const beforeText = visibleText(render(base));
    const afterText = visibleText(render(afterStatus));
    expect(beforeText).not.toContain('Reading project context.');
    expect(afterText).toContain('Reading project context.');
    expect(afterText).not.toBe(beforeText);
  });

  it.each(['missing', 'expired', 'outside-task-scope'] as const)(
    'renders a %s context gap without an invented Unreadable diagnosis',
    (reason) => {
      const h = harness();
      const render = emittedDelegationRenderer(h.workbenchHtml());
      const text = visibleText(render({
        coordinatorName: 'PM', total: 1, done: 0, partial: 0, blocked: 1, working: 0,
        items: [{
          agentName: 'Reviewer', instruction: 'Review the source', status: 'blocked',
          taskState: { kind: 'context-gap', inputId: 'source', reason, purpose: 'Inspect the source.' },
        }],
      }));
      expect(text).toContain(`Context gap · ${reason}`);
      expect(text).not.toContain('Unreadable');
    },
  );

  it('renders an unknown delegation status as Unknown rather than silently claiming Done', () => {
    const h = harness();
    const render = emittedDelegationRenderer(h.workbenchHtml());
    const text = visibleText(render({
      coordinatorName: 'PM', total: 1, done: 0, partial: 0, blocked: 0, working: 0,
      items: [{ agentName: 'Reviewer', instruction: 'Review the source', status: 'future-status' }],
    }));
    expect(text).toContain('Unknown');
    expect(text).not.toContain('Done');
  });
});
