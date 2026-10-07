import { describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ panels: [] as any[] }));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    createWebviewPanel: vi.fn(() => {
      const webview = {
        cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      };
      const panel = {
        webview,
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn(),
      };
      vscodeState.panels.push(panel);
      return panel;
    }),
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { MessageBus } from '../../bus/MessageBus';
import { renderAgentBuilderHtml } from '../AgentBuilderPanel';
import { CHAT_REASONING_LIMIT, ChatViewProvider, delegationRenderKey } from '../ChatViewProvider';
import { CHAT_HISTORY_LIMIT } from '../chatHistory';
import { CHAT_TOOLS_LIMIT } from '../chatToolHistory';
import { renderMarketplaceHtml } from '../MarketplacePanel';
import { MessageLogProvider } from '../MessageLogProvider';
import { OnboardingWizard } from '../OnboardingWizard';
import { DELEGATION_PROGRESS_SUMMARY_LIMIT } from '../orchestrationProgress';
import { renderSecurityHtml } from '../SecurityPanel';
import { SettingsPanel } from '../SettingsPanel';
import { TeamViewProvider } from '../TeamViewProvider';
import { openTeamRulesPanel } from '../TeamRulesPanel';
import { WorkflowEditor } from '../WorkflowEditor';
import { renderHtml as renderWorktreeHtml } from '../WorktreePanel';
import { blockingDialogCalls, bootWebviewScript, inlineWebviewScript } from './support/webviewBoot';

type Panel = { name: string; listeners: readonly string[]; html: () => string | Promise<string> };

function panelHtml(panel: any): string {
  if (!panel?.webview?.html) { throw new Error('The test panel did not render webview HTML.'); }
  return panel.webview.html as string;
}

function sidebarView() {
  return {
    visible: true,
    title: '',
    webview: {
      cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function renderedText(root: unknown): string[] {
  if (!root || typeof root !== 'object') return [];
  const element = root as { textContent?: unknown; children?: unknown[] };
  return [
    ...(typeof element.textContent === 'string' && element.textContent ? [element.textContent] : []),
    ...(Array.isArray(element.children) ? element.children.flatMap(renderedText) : []),
  ];
}

const captured: Record<string, any> = {};

const PANELS: readonly Panel[] = [
  {
    name: 'Agent Builder', listeners: ['click', 'change', 'message'],
    html: () => renderAgentBuilderHtml({ cspSource: 'test:' } as never, {
      mode: 'new', roles: [], providers: [], capabilities: [], mcpServers: [],
      catalog: { agents: [], mcp: [], skills: [] },
    }),
  },
  {
    name: 'Chat', listeners: ['click', 'keydown', 'change', 'message'],
    html: () => {
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      return (provider as any).getHtml({ cspSource: 'test:' });
    },
  },
  {
    name: 'Settings', listeners: ['click', 'change', 'message'],
    html: async () => {
      if (!captured.settings) {
        SettingsPanel.createOrShow({} as never, {
          bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) },
          promptAndStoreSecret: async () => false, openTeamFile() {},
        } as never);
        captured.settings = vscodeState.panels.at(-1);
        await vi.waitFor(() => expect(panelHtml(captured.settings)).toContain('<script'));
      }
      return panelHtml(captured.settings);
    },
  },
  {
    name: 'Security', listeners: ['click'],
    html: () => renderSecurityHtml({
      workspaceTrusted: true, virtualWorkspace: false, commandApproval: 'ask', writeApproval: 'none',
      concurrencyStrategy: 'optimistic', fetchCatalog: false, egressGrants: [], mcpServers: [], agents: [], providers: [],
    }, "default-src 'none'", 'nonce'),
  },
  {
    name: 'Marketplace', listeners: ['click', 'input', 'message'],
    html: () => renderMarketplaceHtml({ cspSource: 'test:' } as never, { agents: [], mcp: [], skills: [] }),
  },
  {
    name: 'Worktree', listeners: ['click', 'scroll'],
    html: () => renderWorktreeHtml({ cspSource: 'test:' } as never, {
      base: 'main', integrationBranch: 'unode/integration', hasIntegration: false, lanes: [], integrationFiles: [],
    }),
  },
  {
    name: 'Message Log', listeners: ['click', 'message'],
    html: () => {
      const provider = new MessageLogProvider(new MessageBus());
      const view = sidebarView();
      provider.resolveWebviewView(view as never);
      return view.webview.html;
    },
  },
  {
    // No 'message' listener: a status change alters the row's label, controls and metrics together, so the
    // host re-renders the roster instead of patching it. The old per-agent patch listener targeted element
    // ids the redesigned row no longer renders (UX3-R).
    name: 'Team', listeners: ['click'],
    html: () => {
      const provider = new TeamViewProvider({} as never, { getAll: () => [] } as never, new MessageBus());
      const view = sidebarView();
      provider.resolveWebviewView(view as never, {} as never, {} as never);
      return view.webview.html;
    },
  },
  {
    name: 'Team Rules', listeners: ['click', 'message'],
    html: async () => {
      if (!captured.teamRules) {
        await openTeamRulesPanel({ rulesFilePath: 'C:/definitely-not-present/.unode/rules.md', initialContent: '' });
        captured.teamRules = vscodeState.panels.at(-1);
      }
      return panelHtml(captured.teamRules);
    },
  },
  {
    name: 'Workflow Editor', listeners: ['click', 'message'],
    html: () => {
      if (!captured.workflow) {
        WorkflowEditor.createOrShow({} as never, {
          listWorkflows: async () => [], listAgents: () => [], saveWorkflow: async () => ({ ok: true }), deleteWorkflow: async () => {},
        });
        captured.workflow = vscodeState.panels.at(-1);
      }
      return panelHtml(captured.workflow);
    },
  },
  {
    name: 'Onboarding', listeners: ['click', 'message'],
    html: () => {
      if (!captured.onboarding) {
        OnboardingWizard.createOrShow({} as never, {
          getCurrentConnectionId: () => 'unode', saveProvider: async () => {}, createQuickStartTeam: async () => {},
          createSolo: async () => {}, createCustomAgent: async () => {}, runDemoTask: async () => {}, complete: async () => {},
          openCommand: async () => {}, openExternal: async () => {}, openConnectionSetup: async () => {},
          addCustomGateway: async () => undefined, demoTasks: [],
        });
        captured.onboarding = vscodeState.panels.at(-1);
      }
      return panelHtml(captured.onboarding);
    },
  },
];

describe('inline webview boot harness', () => {
  // Dashboard / Mission Control is deliberately absent: it renders plain HTML and has no <script> block.
  // Keep this explicit so adding a script there requires adding it to this execution inventory.
  it('keeps the complete inline-script panel inventory explicit', () => {
    expect(PANELS.map((panel) => panel.name)).toEqual([
      'Agent Builder', 'Chat', 'Settings', 'Security', 'Marketplace', 'Worktree', 'Message Log', 'Team',
      'Team Rules', 'Workflow Editor', 'Onboarding',
    ]);
  });

  for (const panel of PANELS) {
    describe(panel.name, () => {
      it('executes its top-level script and registers its key listeners', async () => {
        const booted = bootWebviewScript(await panel.html());
        for (const type of panel.listeners) {
          expect(booted.listeners[type], `${panel.name} did not register a ${type} listener`).toBeTruthy();
        }
      });

      it('does not call a blocking browser dialog', async () => {
        const script = inlineWebviewScript(await panel.html());
        expect(blockingDialogCalls(script), `${panel.name} calls a VS Code-stubbed browser dialog`).toBeNull();
      });
    });
  }

  it('renders local finish time beside turn duration, with a full date for an earlier day', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 41, 16);
    const earlier = new Date(2020, 0, 2, 3, 4, 5);
    const base = (provider as any).currentState();
    const messages = [
      {
        role: 'agent', kind: 'message', text: 'today', ts: today.toISOString(), seq: 1,
        turnTiming: {
          settledAt: today.toISOString(), durationMs: 21_000, approvalWaitMs: 0,
          phases: {
            queuedMs: 0, hostMs: 1_000, providerWaitMs: 15_000, reasoningMs: 2_000, respondingMs: 2_000, toolMs: 1_000,
            providerWaitCount: 2, longestProviderWaitMs: 13_000,
          },
        },
      },
      {
        role: 'agent', kind: 'message', text: 'earlier', ts: earlier.toISOString(), seq: 2,
        turnTiming: { settledAt: earlier.toISOString(), durationMs: 65_000, approvalWaitMs: 2_000 },
      },
    ];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages } } });
    const text = renderedText(booted.elements.get('transcript')).join('\n');
    const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
    const earlierDate = earlier.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    expect(text).toContain(`Finished ${today.toLocaleTimeString(undefined, timeOptions)} · Turn time: 21s`);
    expect(text).toContain(`Finished ${earlierDate} ${earlier.toLocaleTimeString(undefined, timeOptions)} · Turn time: 1m 5s · human approval: 2s excluded`);
    // Where the time went, as the host observed it; a phase that took no time is not listed.
    expect(text).toContain('Observed: waiting for provider 15s (2 waits, longest 13s) · reasoning 2s · responding 2s · tools 1s · host 1s');
    // The earlier turn was recorded before phases existed: it gets no breakdown line, and never one of zeroes.
    expect(text.match(/Observed:/g)).toHaveLength(1);
    expect(text).not.toMatch(/queued|not recorded/);
  });

  it('shows the live turn clock by the measure the footer reports, and holds it while a decision is open', () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-10-02T12:00:00.000Z');
      vi.setSystemTime(new Date(now));
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'claude' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      provider.selectAgent('dev');
      const base = (provider as any).currentState();
      const at = (msAgo: number) => new Date(now - msAgo).toISOString();
      // The turn began 100 s ago. Its provider wait began 69 s ago and a person took the first 60 s of it to
      // decide: at the last event, 9 s ago, the host had 31 s of turn time and none of this phase yet.
      const phase = {
        phase: 'provider-wait', phaseStartedAt: at(69_000), turnStartedAt: at(100_000), openTools: 0,
        activeMs: 31_000, phaseActiveMs: 0, observedAt: at(9_000), approvalPending: false, provider: 'Claude',
      };
      const liveLine = (turnPhase: Record<string, unknown>) => {
        const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
        booted.listeners.message?.[0]?.({
          data: { command: 'state', state: { ...base, runningAgentIds: ['dev'], turnPhases: { dev: turnPhase }, messages: [] } },
        });
        return renderedText(booted.elements.get('transcript')).join('');
      };

      const running = liveLine(phase);
      expect(running).toContain('Waiting for Claude – 9s · turn 40s');
      expect(running).not.toMatch(/100s|69s/);

      const waiting = liveLine({ ...phase, phase: 'tool', openTools: 1, approvalPending: true, approvalStartedAt: at(20_000) });
      expect(waiting).toContain('Waiting for your approval – 20s · turn 31s (paused)');
    } finally {
      vi.useRealTimers();
    }
  });

  // Field run, 2026-10-02: in a ~280px sidebar the approval wait wrapped into three columns and its last line,
  // "(paused)", sat below the visible transcript. The line wraps as text, and a reader at the bottom stays there.
  it('keeps the live line in view when its phase changes, for a reader at the bottom only', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const base = (provider as any).currentState();
    const html = (provider as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
    expect(html.slice(html.indexOf('    .thinking {'), html.indexOf('    .thinking .dots {'))).not.toContain('display: flex');
    const phase = {
      phase: 'tool', phaseStartedAt: new Date().toISOString(), turnStartedAt: new Date().toISOString(), openTools: 1,
      phaseToolCalls: 1, activeMs: 4_000, phaseActiveMs: 0, observedAt: new Date().toISOString(), approvalPending: true,
      approvalStartedAt: new Date().toISOString(), provider: 'Gateway',
    };
    const scrolledAfterPhase = (scrollTop: number) => {
      const booted = bootWebviewScript(html);
      const listener = booted.listeners.message?.[0];
      listener?.({ data: { command: 'state', state: { ...base, runningAgentIds: ['dev'], messages: [] } } });
      const transcript = booted.elements.get('transcript') as Record<string, unknown>;
      const scrollTo = vi.fn();
      Object.assign(transcript, { scrollHeight: 500, clientHeight: 100, scrollTop, scrollTo });
      listener?.({ data: { command: 'turnPhase', agentId: 'dev', turnPhase: phase } });
      return scrollTo.mock.calls;
    };
    expect(scrolledAfterPhase(400)).toEqual([[{ top: 500, behavior: 'auto' }]]);
    expect(scrolledAfterPhase(0)).toEqual([]);
  });

  // Field run, 2026-10-02: "List ." read "Running – 12s" while the read-scope dialog was open and "Done · 40.2s"
  // after it, under a footer that excluded the same 40 s as a person's decision.
  it('leaves a person\'s decision out of a tool card\'s clock, and says so', () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-10-02T12:00:00.000Z');
      vi.setSystemTime(new Date(now));
      const at = (msAgo: number) => new Date(now - msAgo).toISOString();
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      provider.selectAgent('dev');
      const base = (provider as any).currentState();
      const render = (messages: unknown[], turnPhase?: Record<string, unknown>) => {
        const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
        booted.listeners.message?.[0]?.({
          data: {
            command: 'state',
            state: { ...base, runningAgentIds: turnPhase ? ['dev'] : [], turnPhases: turnPhase ? { dev: turnPhase } : {}, messages },
          },
        });
        return renderedText(booted.elements.get('transcript')).join(' | ');
      };
      const card = { kind: 'tool', id: 't1', callId: 'c1', name: 'list_dir', title: 'List .', category: 'list', summary: '' };
      const toolPhase = {
        phase: 'tool', phaseStartedAt: at(12_000), turnStartedAt: at(16_000), openTools: 1, phaseToolCalls: 1,
        activeMs: 4_000, phaseActiveMs: 0, observedAt: at(12_000), provider: 'Gateway',
      };

      const waiting = render([{ ...card, phase: 'use', ts: at(12_000) }],
        { ...toolPhase, approvalPending: true, approvalStartedAt: at(12_000) });
      expect(waiting).toContain('List . | Waiting for your approval');
      expect(waiting).not.toContain('Running');

      // After the decision the card counts the call's own time, which the host's phase holds: 0.3 s, not 12.3 s.
      const resumed = render([{ ...card, phase: 'use', ts: at(12_300) }],
        { ...toolPhase, approvalPending: false, phaseActiveMs: 300, observedAt: at(0) });
      expect(resumed).toContain('List . | 0s');
      expect(resumed).not.toContain('12s');

      const done = render([{ ...card, phase: 'result', ts: at(40_500), completedAt: at(0), humanWaitMs: 40_000 }]);
      expect(done).toContain('Done · 0.5s · human approval 40.0s excluded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders one conclusion per turn with one footer, and never "not recorded"', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const settled = new Date(2020, 0, 2, 3, 4, 5);
    const timing = { settledAt: settled.toISOString(), durationMs: 39_000, approvalWaitMs: 0 };
    const base = (provider as any).currentState();
    const messages = [
      // A working line flushed before a tool call: finalized, but not the answer.
      { role: 'agent', kind: 'message', text: 'Reading the file now.', ts: settled.toISOString(), seq: 1 },
      {
        role: 'agent', kind: 'message', text: 'The file has two lines.', ts: settled.toISOString(), seq: 2,
        turnFinal: true, turnTiming: timing, delegationReceipt: { accepted: 1, refused: 2, pending: 1 },
      },
      // A row written before v0.9.88: no marker, but its recorded timing proves it ended a turn.
      { role: 'agent', kind: 'message', text: 'Older answer.', ts: settled.toISOString(), seq: 3, turnTiming: timing },
      // Older builds persisted null for "not recorded", and the old separate receipt card looked like this.
      { role: 'agent', kind: 'message', text: 'Delegations this turn: 0 accepted · 0 refused.', ts: settled.toISOString(), seq: 4, turnTiming: null, fromName: 'UnodeAi' },
      // A turn that ended in an error keeps the error style but still carries its footer.
      {
        role: 'agent', kind: 'message', text: 'Stopped by user.', ts: settled.toISOString(), seq: 5,
        isError: true, turnFinal: true, turnTiming: timing,
      },
    ];
    for (const message of messages as Array<Record<string, unknown>>) {
      message.blocks = [{ type: 'paragraph', spans: [{ type: 'text', text: message.text }] }];
    }
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages } } });
    // Message nodes sit inside the transcript's wrappers; collect them in render order. (The fake DOM keeps a
    // paragraph's text in a text node it does not expose, so nodes are identified by position, not by text.)
    const nodes: any[] = [];
    const collect = (node: any) => {
      if (String(node?.className ?? '').startsWith('msg ')) { nodes.push(node); return; }
      for (const child of node?.children ?? []) collect(child);
    };
    collect(booted.elements.get('transcript'));
    const [segment, answer, older, oldReceiptCard, stopped] = nodes;
    const footerOf = (node: any) => node.children.find((child: any) => child.className === 'turn-footer');
    const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
    const finished = `Finished ${settled.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${settled.toLocaleTimeString(undefined, timeOptions)} · Turn time: 39s`;

    expect(nodes).toHaveLength(5);
    expect(segment.className).not.toContain('conclusion');
    expect(footerOf(segment)).toBeUndefined();

    expect(answer.className).toContain('conclusion');
    expect(answer.getAttribute('role')).toBe('group');
    expect(answer.getAttribute('aria-label')).toBe('Conclusion');
    expect(renderedText(footerOf(answer))).toEqual([
      'Delegations this turn: 1 accepted · 2 refused · 1 pending.',
      finished,
    ]);

    expect(older.className).toContain('conclusion');
    expect(oldReceiptCard.className).not.toContain('conclusion');
    expect(footerOf(oldReceiptCard)).toBeUndefined();

    expect(stopped.className).toContain('error');
    expect(stopped.className).not.toContain('conclusion');
    expect(renderedText(footerOf(stopped))).toEqual([finished]);

    const text = renderedText(booted.elements.get('transcript')).join(' ');
    expect(text).not.toContain('not recorded');
  });

  // v0.9.88 §5.5: host-published exact content renders in a labelled <pre>, never as Markdown.
  it('renders a verbatim block as its caption and a pre holding the exact text', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const exact = 'first version\nrework ok\n# not a heading';
    const messages = [{
      role: 'agent', kind: 'message', text: `Here:\n\n${exact}`, ts: new Date(2020, 0, 2).toISOString(), seq: 1, turnFinal: true,
      blocks: [
        { type: 'paragraph', spans: [{ type: 'text', text: 'Here:' }] },
        { type: 'verbatim', text: exact, caption: 'Exact content' },
      ],
    }];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...(provider as any).currentState(), messages } } });
    const found: any[] = [];
    const collect = (node: any) => {
      if (node?.className === 'code verbatim') found.push(node);
      for (const child of node?.children ?? []) collect(child);
    };
    collect(booted.elements.get('transcript'));
    expect(found).toHaveLength(1);
    expect(found[0].getAttribute('role')).toBe('group');
    expect(found[0].getAttribute('aria-label')).toBe('Exact content');
    // The fake DOM does not record tag names: the block is its caption head, then the pre.
    const [head, pre] = found[0].children;
    expect(head.className).toBe('code-head');
    expect(renderedText(head)).toEqual(['Exact content']);
    expect(pre.textContent).toBe(exact);
  });

  it('names what woke the PM in the first footer line, one worker or several', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const source = (name: string, reason: string) => ({ agentId: name.replace(/s/g, '-'), agentName: name, reason });
    const woken = (seq: number, turnTrigger: unknown) => ({
      role: 'agent', kind: 'message', text: 'Reviewed.', ts: '2026-09-26T00:00:00.000Z', seq, turnFinal: true, turnTrigger,
      delegationReceipt: { accepted: 0, refused: 0, pending: 0 },
    });
    const messages = [
      woken(1, { sources: [source('Frontend Engineer', 'rework-reply')], more: 0 }),
      woken(2, { sources: [source('Frontend Engineer', 'delegation-result')], more: 0 }),
      woken(3, { sources: [source('Frontend Engineer', 'delegation-result'), source('Reviewer', 'delegation-result')], more: 0 }),
      woken(4, { sources: ['Frontend Engineer', 'Reviewer', 'Tester', 'Writer'].map((name) => source(name, 'delegation-result')), more: 2 }),
      { ...woken(5, undefined), turnTrigger: undefined },
    ];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages } } });
    const footers: string[][] = [];
    const collect = (node: any) => {
      if (node?.className === 'turn-footer') { footers.push(renderedText(node)); return; }
      for (const child of node?.children ?? []) collect(child);
    };
    collect(booted.elements.get('transcript'));

    expect(footers.map((lines) => lines[0])).toEqual([
      "Triggered by Frontend Engineer's rework reply",
      "Triggered by Frontend Engineer's result",
      'Triggered by results from Frontend Engineer and Reviewer',
      'Triggered by 6 results (Frontend Engineer, Reviewer, +4 more)',
      // A user-started turn has no trigger line; its footer starts with the receipt.
      'Delegations this turn: 0 accepted · 0 refused.',
    ]);
  });

  it('classifies a middle rendered transcript omission as unexplained', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    (provider as any).append('dev', { role: 'agent', text: 'Head', ts: '2026-08-12T00:00:00.000Z' });
    (provider as any).append('dev', { role: 'agent', text: 'Middle', ts: '2026-08-12T00:00:01.000Z' });
    (provider as any).append('dev', { role: 'agent', text: 'Tail', ts: '2026-08-12T00:00:02.000Z' });
    const initial = (provider as any).currentState();
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const message = booted.listeners.message?.[0];
    expect(message).toBeTypeOf('function');

    message!({ data: { command: 'state', state: { ...initial, messages: [initial.messages[0], initial.messages[2]], turnEpochs: { dev: 2 } } } });

    const report = booted.postedMessages.find((entry: any) => entry.command === 'renderedTranscriptItemsMissing');
    expect(report).toEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      agentId: 'dev',
      cause: 'unexplained',
      previousItemCount: 3,
      nextItemCount: 2,
      missing: [{ id: expect.stringMatching(/^msg:/), delivery: 'committed' }],
      epochChanged: true,
    }));
    expect(report).not.toHaveProperty('previousItemIds');
    expect(report).not.toHaveProperty('nextItemIds');
  });

  it('observes a missing streaming row but not its normal committed replacement', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const base = (provider as any).currentState();
    const live = { role: 'agent', kind: 'message', text: 'streaming', ts: '2026-09-11T00:00:00.000Z', seq: 7, live: true };
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const message = booted.listeners.message?.[0]!;

    message({ data: { command: 'state', state: { ...base, messages: [live] } } });
    message({ data: { command: 'state', state: { ...base, messages: [{ ...live, live: false }] } } });
    expect(booted.postedMessages.filter((entry: any) => entry.command === 'renderedTranscriptItemsMissing')).toEqual([]);

    message({ data: { command: 'state', state: { ...base, messages: [live] } } });
    message({ data: { command: 'state', state: { ...base, messages: [] } } });
    expect(booted.postedMessages).toContainEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      missing: [{ id: 'msg:7', delivery: 'live' }],
      cause: 'unexplained',
    }));
  });

  it('does not report normal tool-card phase or delegation-status replacements as disappearances', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const initial = {
      ...(provider as any).currentState(),
      messages: [
        { kind: 'tool', id: 'tool-1', phase: 'use', name: 'read_file', ts: '2026-08-12T00:00:00.000Z' },
        { kind: 'delegation', id: 'run-1', renderKey: 'delegation:run-1:working', ts: '2026-08-12T00:00:01.000Z', items: [] },
      ],
    };
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const message = booted.listeners.message?.[0];
    message!({ data: { command: 'state', state: initial } });
    message!({ data: { command: 'state', state: {
      ...initial,
      messages: [
        { ...initial.messages[0], phase: 'result', completedAt: '2026-08-12T00:00:02.000Z', ok: true },
        { ...initial.messages[1], renderKey: 'delegation:run-1:done', done: 1 },
      ],
    } } });

    expect(booted.postedMessages.filter((entry: any) => entry.command === 'renderedTranscriptItemsMissing')).toEqual([]);
  });

  it.each(['sidebar', 'workbench'] as const)(
    'renders interruption facts and retains Interrupted beside a replacement in %s',
    (surface) => {
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'pm', backend: 'openai' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      provider.selectAgent('pm');
      const summary = {
        kind: 'delegation' as const,
        id: 'interrupted-summary', coordinatorId: 'pm', coordinatorName: 'Project Manager',
        startedAt: '2026-09-11T13:00:00.000Z', total: 1, done: 0, partial: 0, blocked: 1, working: 0,
        items: [{
          id: 'lost-handle', coordinatorId: 'pm', coordinatorName: 'Project Manager', agentId: 'dev',
          agentName: 'Developer', instruction: 'Build it.', scopeMode: 'fixed-session-permissions' as const,
          status: 'interrupted' as const, startedAt: '2026-09-11T13:00:00.000Z',
          coordinatorDisposition: 'superseded' as const, dispositionReason: 'Replacement admitted.',
          replacementHandle: 'replacement-handle', interruption: {
            reason: 'host-restarted' as const,
            lastObservedAt: '2026-09-11T13:01:00.000Z',
            detectedAt: '2026-09-11T13:02:00.000Z',
          },
        }],
      };
      const message = { ...summary, renderKey: delegationRenderKey(summary) };
      const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, surface));
      booted.listeners.message?.[0]?.({
        data: { command: 'state', state: { ...(provider as any).currentState(), messages: [message] } },
      });

      const text = renderedText(booted.elements.get('transcript')).join('\n');
      expect(text).toContain('Interrupted — no active worker · Coordinator superseded task');
      expect(text).toContain('Reason: host-restarted. Last observed: 2026-09-11T13:01:00.000Z. Detected: 2026-09-11T13:02:00.000Z.');
      expect(text).toContain('Replacement: replacement-handle.');
    },
  );

  it.each(['sidebar', 'workbench'] as const)('keeps a committed transcript row through queued, working, and complete delegation pushes in %s', (surface) => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'pm', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const transcriptRow = {
      role: 'agent', kind: 'message', text: 'Delegation summary remains visible.',
      ts: '2026-09-11T00:00:00.000Z', seq: 42, live: true,
    };
    const phases = [
      { status: 'working' as const, activity: 'Queued for Developer', done: 0, working: 1 },
      { status: 'working' as const, activity: 'Running verification', done: 0, working: 1 },
      { status: 'verified' as const, activity: 'Checks passed', done: 1, working: 0 },
    ];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, surface));
    const message = booted.listeners.message?.[0]!;

    for (const [index, phase] of phases.entries()) {
      const summary = {
        kind: 'delegation' as const,
        id: 'run-field-signature', coordinatorId: 'pm', coordinatorName: 'Project Manager',
        startedAt: '2026-09-11T00:00:01.000Z', total: 1, done: phase.done, partial: 0,
        blocked: 0, working: phase.working,
        items: [{
          id: 'real-delegation-handle', coordinatorId: 'pm', coordinatorName: 'Project Manager',
          agentId: 'dev', agentName: 'Developer', instruction: 'Run the release checks.',
          scopeMode: 'fixed-session-permissions' as const, status: phase.status, activity: phase.activity,
          startedAt: '2026-09-11T00:00:01.000Z',
          ...(phase.status === 'verified' ? { completionState: 'complete' as const } : {}),
        }],
      };
      message({ data: { command: 'state', state: {
        ...base,
        messages: [
          { ...transcriptRow, live: index === 0 },
          { ...summary, renderKey: delegationRenderKey(summary) },
        ],
      } } });
    }

    expect(booted.postedMessages.filter((entry: any) => entry.command === 'renderedTranscriptItemsMissing')).toEqual([]);

    const completed = phases.at(-1)!;
    const completedSummary = {
      kind: 'delegation' as const,
      id: 'run-field-signature', coordinatorId: 'pm', coordinatorName: 'Project Manager',
      startedAt: '2026-09-11T00:00:01.000Z', total: 1, done: completed.done, partial: 0,
      blocked: 0, working: completed.working,
      items: [{
        id: 'real-delegation-handle', coordinatorId: 'pm', coordinatorName: 'Project Manager',
        agentId: 'dev', agentName: 'Developer', instruction: 'Run the release checks.',
        scopeMode: 'fixed-session-permissions' as const, status: completed.status, activity: completed.activity,
        completionState: 'complete' as const, startedAt: '2026-09-11T00:00:01.000Z',
      }],
    };
    message({ data: { command: 'state', state: {
      ...base,
      messages: [{ ...completedSummary, renderKey: delegationRenderKey(completedSummary) }],
    } } });
    expect(booted.postedMessages).toContainEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      missing: [{ id: 'msg:42', delivery: 'committed' }],
      cause: 'unexplained',
    }));
  });

  it('classifies a full chat-window advance as a window trim', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    for (let i = 0; i < CHAT_HISTORY_LIMIT; i += 1) {
      (provider as any).append('dev', { role: 'agent', text: `Message ${i}`, ts: `2026-08-12T00:00:${String(i).padStart(2, '0')}.000Z` });
    }
    const initial = (provider as any).currentState();
    const next = {
      ...initial,
      messages: [
        ...initial.messages.slice(1),
        { role: 'agent', text: 'Newest message', ts: '2026-08-12T00:01:00.000Z', seq: CHAT_HISTORY_LIMIT + 1 },
      ],
      turnEpochs: { dev: 2 },
    };
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const message = booted.listeners.message?.[0];
    expect(message).toBeTypeOf('function');

    message!({ data: { command: 'state', state: next } });

    expect(booted.postedMessages).toContainEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      agentId: 'dev',
      cause: 'window-trim',
      previousItemCount: CHAT_HISTORY_LIMIT,
      nextItemCount: CHAT_HISTORY_LIMIT,
      missing: [{ id: expect.stringMatching(/^msg:/), delivery: 'committed' }],
      epochChanged: true,
    }));
  });

  it('attributes interleaved bounded-stream removals to their real windows after the Workbench DOM drops them', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const base = (provider as any).currentState();
    const ts = '2026-09-18T12:00:00.000Z';
    const messages = Array.from({ length: CHAT_HISTORY_LIMIT }, (_, index) => ({
      role: 'user', kind: 'message', text: index === 0 ? '[evicted message]' : `Message ${index}`,
      ts, seq: 100 + (index * 4),
    }));
    const reasoning = Array.from({ length: CHAT_REASONING_LIMIT }, (_, index) => ({
      kind: 'reasoning', id: `reason-${index}`, text: `Reasoning ${index}`, ts, seq: 101 + (index * 4),
    }));
    const tools = Array.from({ length: CHAT_TOOLS_LIMIT }, (_, index) => ({
      kind: 'tool', id: `tool-${index}`, phase: 'result', name: 'edit_file', category: 'edit',
      title: `Tool ${index}`, summary: `Tool summary ${index}`, ok: true, ts, seq: 102 + (index * 4),
    }));
    const delegations = Array.from({ length: DELEGATION_PROGRESS_SUMMARY_LIMIT }, (_, index) => ({
      kind: 'delegation', id: `delegation-${index}`, renderKey: `delegation-${index}:complete`,
      coordinatorId: 'dev', coordinatorName: 'Developer', startedAt: ts, completedAt: ts,
      total: 0, done: 0, partial: 0, blocked: 0, working: 0, items: [], ts, seq: 103 + (index * 4),
    }));
    const stableMarker = { kind: 'marker', id: 'stable-marker', text: 'Older retained marker', ts, seq: 0 };
    const ordered = (items: any[]) => items.sort((a, b) => a.seq - b.seq);
    const initialMessages = ordered([stableMarker, ...messages, ...reasoning, ...tools, ...delegations]);
    const nextMessages = ordered([
      stableMarker,
      ...messages.slice(1),
      { role: 'user', kind: 'message', text: '[replacement message]', ts, seq: 10_000 },
      ...reasoning.slice(1),
      { kind: 'reasoning', id: 'reason-new', text: 'Replacement reasoning', ts, seq: 10_001 },
      ...tools.slice(1),
      { kind: 'tool', id: 'tool-new', phase: 'result', name: 'edit_file', category: 'edit', title: 'New tool', summary: 'Replacement tool', ok: true, ts, seq: 10_002 },
      ...delegations.slice(1),
      { kind: 'delegation', id: 'delegation-new', renderKey: 'delegation-new:complete', coordinatorId: 'dev', coordinatorName: 'Developer', startedAt: ts, completedAt: ts, total: 0, done: 0, partial: 0, blocked: 0, working: 0, items: [], ts, seq: 10_003 },
    ]);
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
    const message = booted.listeners.message?.[0]!;

    message({ data: { command: 'state', state: { ...base, messages: initialMessages, turnEpochs: { dev: 7 } } } });
    message({ data: { command: 'state', state: { ...base, messages: nextMessages, turnEpochs: { dev: 7 } } } });

    expect(booted.postedMessages).toContainEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      cause: 'window-trim',
      missing: [
        { id: 'msg:100', delivery: 'committed' },
        { id: 'reasoning:101', delivery: 'committed' },
        { id: 'tool:tool-0', delivery: 'committed' },
        { id: 'delegation:delegation-0', delivery: 'committed' },
      ],
    }));
    const text = renderedText(booted.elements.get('transcript')).join('\n');
    expect(text).not.toContain('[evicted message]');
    expect(text).toContain('[replacement message]');
  });

  it('still logs a planted middle loss when a real bounded message trim occurs beside it', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const base = (provider as any).currentState();
    const ts = '2026-09-18T12:10:00.000Z';
    const messages = Array.from({ length: CHAT_HISTORY_LIMIT }, (_, index) => ({
      role: 'user', kind: 'message', text: index === 20 ? '[planted genuine loss]' : `Retained ${index}`,
      ts, seq: index + 1,
    }));
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
    const message = booted.listeners.message?.[0]!;
    message({ data: { command: 'state', state: { ...base, messages, turnEpochs: { dev: 9 } } } });
    const nextMessages = [
      ...messages.slice(1, 20),
      ...messages.slice(21),
      { role: 'user', kind: 'message', text: 'Replacement A', ts, seq: 1_000 },
      { role: 'user', kind: 'message', text: 'Replacement B', ts, seq: 1_001 },
    ];
    message({ data: { command: 'state', state: { ...base, messages: nextMessages, turnEpochs: { dev: 9 } } } });

    expect(booted.postedMessages).toContainEqual(expect.objectContaining({
      command: 'renderedTranscriptItemsMissing',
      cause: 'unexplained',
      missing: expect.arrayContaining([
        { id: 'msg:1', delivery: 'committed' },
        { id: 'msg:21', delivery: 'committed' },
      ]),
    }));
    expect(renderedText(booted.elements.get('transcript')).join('\n')).not.toContain('[planted genuine loss]');
  });

  it('renders the retained-result count behind a running PM turn', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'pm', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      delegationWaitingResults: () => 2,
    } as never);
    provider.selectAgent('pm');
    (provider as any).runningAgentIds.add('pm');

    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));

    expect(booted.elements.get('steerHint')?.textContent).toBe(
      '2 delegated results are waiting behind this turn. The PM will handle them when this turn ends.',
    );
  });

  it('mutation check: a top-level throw makes the Agent Builder boot guard fail', async () => {
    const html = await PANELS[0].html();
    const broken = html.replace(/(<script\b[^>]*>)/i, '$1\nthrow new Error("intentional boot mutation");');
    expect(() => bootWebviewScript(broken)).toThrow('intentional boot mutation');
  });
});
