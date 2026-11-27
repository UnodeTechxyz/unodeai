import { describe, expect, it, onTestFinished, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ panels: [] as any[] }));
// These times are compared with the runtime's own clock; systemClock.test.ts covers a runtime that has no zone.
vi.mock('../systemClock', () => ({ systemClockBias: () => undefined, systemClockZone: () => undefined, onSystemClock: (when: number | string | Date) => new Date(when),
  correctionFor: (bias: number | undefined, offset: number) => (bias !== undefined && bias !== offset ? bias : undefined) }));

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
import { DELEGATION_PROGRESS_SUMMARY_LIMIT } from '../orchestrationProgress';
import { renderSecurityHtml } from '../SecurityPanel';
import { SettingsPanel } from '../SettingsPanel';
import { SetupGuidePanel } from '../SetupGuidePanel';
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
    // v0.9.106 (setup guide): clicks are delegated through data-command; the connection choice is a select.
    name: 'Setup Guide', listeners: ['click', 'change', 'message'],
    html: () => {
      if (!captured.setupGuide) {
        SetupGuidePanel.createOrShow({ log() {} } as never);
        captured.setupGuide = vscodeState.panels.at(-1);
      }
      return panelHtml(captured.setupGuide);
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
];

describe('inline webview boot harness', () => {
  // Dashboard / Mission Control is deliberately absent: it renders plain HTML and has no <script> block.
  // Keep this explicit so adding a script there requires adding it to this execution inventory.
  it('keeps the complete inline-script panel inventory explicit', () => {
    expect(PANELS.map((panel) => panel.name)).toEqual([
      'Agent Builder', 'Chat', 'Settings', 'Security', 'Marketplace', 'Worktree', 'Message Log', 'Team',
      'Team Rules', 'Setup Guide', 'Workflow Editor',
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

  // v0.9.104 (ROADMAP items 1 and 2, clock L1 and L2): the page reports its clock as it loads and when its window
  // regains focus (at most once a minute); the host answers with Windows' bias as just read. A page whose runtime
  // disagrees with Windows corrects its times and redraws them, with no Reload Window; one that agrees changes nothing.
  it('corrects and redraws its times when the host reads a Windows bias that differs from its runtime, and only then', async () => {
    let reading: number | undefined;
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      onClockReport: async () => reading,
    } as never);
    provider.selectAgent('dev');
    // v0.9.105 (chain on 911158bf, run at 23:10 local): the clock is pinned to noon. On the real clock, in the last hour
    // of a day the page's clock moved an hour east is already tomorrow, and it rightly showed this turn with its date.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 16, 12, 0, 0) });
    onTestFinished(() => { vi.useRealTimers(); });
    const now = new Date();
    const settled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 41, 16);
    const base = (provider as any).currentState();
    const messages = [{ role: 'agent', kind: 'message', text: 'done', ts: settled.toISOString(), seq: 1,
      turnTiming: { settledAt: settled.toISOString(), durationMs: 21_000, approvalWaitMs: 0 } }];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const send = (data: unknown) => booted.listeners.message?.[0]?.({ data });
    const hostPosts: any[] = [];
    (provider as any).sidebarView = { visible: true, webview: { postMessage: (message: unknown) => { hostPosts.push(message); send(message); return Promise.resolve(true); } } };
    send({ command: 'state', state: { ...base, messages } });
    const footer = () => renderedText(booted.elements.get('transcript')).join('\n');
    const finished = (at: Date) => `Finished ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · Turn time: 21s`;
    const reports = () => booted.postedMessages.filter((message: any) => message.command === 'clockReport');
    // Each page report goes to the host as the sidebar's, and its answer back to the page.
    const deliver = async () => {
      (provider as any).onMessage(reports()[0], 'sidebar');
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    expect(footer()).toContain(finished(settled));
    expect(reports()).toHaveLength(1); // as it loaded

    // Windows agrees with this runtime: the host answers, and nothing on screen changes.
    const offset = settled.getTimezoneOffset();
    reading = offset;
    await deliver();
    expect(hostPosts.filter((message) => message.command === 'systemClock')).toEqual([{ command: 'systemClock', windowsBias: offset }]);
    expect(footer()).toContain(finished(settled));

    // A failed read sends nothing.
    reading = undefined;
    (provider as any).onMessage(reports()[0], 'sidebar');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostPosts.filter((message) => message.command === 'systemClock')).toHaveLength(1);

    // Windows moves an hour east (a DST change, or zone rules newer than this runtime's). Focus within the minute
    // reports nothing; after it, the page reports again and redraws at Windows' clock.
    reading = offset - 60;
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(now.getTime() + 30_000);
      booted.listeners.focus?.forEach((listener) => listener({}));
      expect(booted.postedMessages.filter((message: any) => message.command === 'clockReport')).toHaveLength(1);
      nowSpy.mockReturnValue(now.getTime() + 120_000);
      booted.listeners.focus?.forEach((listener) => listener({}));
      expect(booted.postedMessages.filter((message: any) => message.command === 'clockReport')).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
    (provider as any).onMessage(booted.postedMessages.filter((message: any) => message.command === 'clockReport')[1], 'sidebar');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(footer()).toContain(finished(new Date(settled.getTime() + 60 * 60_000)));
  });

  // v0.9.104 (L2): a window that keeps focus across a daylight-saving change gets no focus event; the page reports its
  // clock every ten minutes as well.
  it('reports its clock every ten minutes, also while its window keeps focus', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      provider.selectAgent('dev');
      const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
      const reports = () => booted.postedMessages.filter((message: any) => message.command === 'clockReport').length;
      expect(reports()).toBe(1);
      vi.advanceTimersByTime(9 * 60_000);
      expect(reports()).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(reports()).toBe(2);
      vi.advanceTimersByTime(10 * 60_000);
      expect(reports()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // v0.9.104 (ROADMAP item 4): the person's place in the transcript is kept by these listeners; ChatViewProvider.test.ts
  // runs the handlers themselves.
  it('registers the handlers that keep the person\'s place: a press, Tab, a pointer press, focus, the page getting focus', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const named = (type: string) => (booted.listeners[type] ?? []).map((listener) => listener.name);
    expect(named('click')).toContain('keepPressedPlace');
    expect(named('keydown')).toContain('resumeTabFromKeptPlace');
    expect(named('pointerdown')).toContain('dropKeptTabStart');
    expect(named('focusin')).toContain('dropKeptTabStart');
    expect(named('focus')).toContain('restorePendingTranscriptFocus');
  });

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
            providerWaitCount: 2, longestProviderWaitMs: 13_000, preparingToolMs: 9_000,
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
    expect(text).toContain('Observed: waiting for provider 15s (2 waits, longest 13s) · reasoning 2s · responding 2s · of which writing tool calls 9s · running tools 1s · host 1s');
    // The earlier turn was recorded before phases existed: it gets no breakdown line, and never one of zeroes.
    expect(text.match(/Observed:/g)).toHaveLength(1);
    expect(text).not.toMatch(/queued/);
    expect(text).toContain('compacting not recorded');
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
      expect(running).toContain('Working: waiting for Claude – 9s · turn 40s');
      expect(running).not.toMatch(/100s|69s/);
      expect(liveLine({ ...phase, lastActivityAt: at(19_000) })).toContain('Working: waiting for Claude');
      expect(liveLine({ ...phase, lastActivityAt: at(20_000) })).toContain('No response for 20 s');
      const quiet = liveLine({ ...phase, lastActivityAt: at(600_000), progressSummary: 'Still running. Files read: a.ts. Pending: model reply.' });
      expect(quiet).toContain('No response for 600 s');
      expect(quiet).toContain('Still running. Files read: a.ts. Pending: model reply.');
      expect(quiet).not.toContain('600 s – 0s');
      expect(liveLine({ ...phase, lastActivityAt: at(0), phase: 'responding' })).toContain('Working: writing a reply');
      expect(liveLine({ ...phase, lastActivityAt: at(0), phase: 'reasoning' })).toContain('Working: thinking');
      expect(liveLine({ ...phase, lastActivityAt: at(0), preparingTool: true })).toContain('Working: preparing a tool call');
      // v0.9.99 P7: the call being written, its target once known, and the amount so far.
      expect(liveLine({ ...phase, lastActivityAt: at(0), preparingTool: true, toolInput: { tool: 'write_file', target: 'contract_v2.docx', bytes: 12_400 } }))
        .toContain('Working: writing contract_v2.docx · 12 KB so far');
      expect(liveLine({ ...phase, lastActivityAt: at(0), preparingTool: true, toolInput: { tool: 'write_document', bytes: 900 } }))
        .toContain('Working: preparing write_document · 900 B so far');
      expect(liveLine({ ...phase, lastActivityAt: at(0), preparingTool: true, toolInput: { bytes: 3 * 1024 * 1024 } }))
        .toContain('Working: preparing a tool call · 3.0 MB so far');
      // A route that sends a call only when complete says so, waiting or quiet; another route does not.
      expect(liveLine({ ...phase, lastActivityAt: at(0), toolInputNotStreamed: true }))
        .toContain('Working: waiting for Claude · this route does not show progress while the model writes a tool call');
      expect(liveLine({ ...phase, lastActivityAt: at(45_000), toolInputNotStreamed: true }))
        .toContain('No response for 45 s · this route does not show progress while the model writes a tool call');
      expect(liveLine({ ...phase, lastActivityAt: at(45_000) })).not.toContain('this route does not show');
      expect(liveLine({ ...phase, phase: 'tool', phaseToolCalls: 1, openTools: 1 })).toContain('Working: running a tool');
      expect(liveLine({ ...phase, phase: 'compacting' })).toContain('Working: compacting the conversation – 9s · turn 40s');

      const waiting = liveLine({ ...phase, phase: 'tool', openTools: 1, approvalPending: true, approvalStartedAt: at(20_000) });
      expect(waiting).toContain('Working: waiting for your approval – 20s · turn 31s (paused)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a measured compaction bucket separately from provider waiting in the actual footer', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'claude' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev'); const base = (provider as any).currentState();
    const boot = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    boot.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: [{
      role: 'agent', kind: 'message', text: 'Done', ts: '2026-10-24T12:00:45.000Z', seq: 1,
      turnTiming: { durationMs: 45000, approvalWaitMs: 0, settledAt: '2026-10-24T12:00:45.000Z', phases: {
        queuedMs: 0, hostMs: 0, providerWaitMs: 3000, reasoningMs: 0, respondingMs: 0, toolMs: 0,
        compactingMs: 42000, providerWaitCount: 1, longestProviderWaitMs: 3000,
      } },
    }] } } });
    expect(renderedText(boot.elements.get('transcript')).join(' ')).toContain('Observed: waiting for provider 3s · compacting 42s');
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

  // v0.9.102 (the Owner's decision): a reply's footer holds only its turn's facts. A PM status an earlier version saved
  // on a reply is never drawn, so no reply shows a state that is no longer true.
  it('draws only turn facts in a reply footer, never a PM status', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const messages = [{
      role: 'agent', kind: 'message', text: 'QA is checking it.', ts: '2026-10-27T08:00:00.000Z', seq: 1, turnFinal: true,
      delegationReceipt: { accepted: 1, refused: 0, pending: 0 },
      pmStatus: { row: 6, state: 'Running in background', now: 'Running: QA (run-aaaa).', why: 'waiting for background results' },
      blocks: [{ type: 'paragraph', spans: [{ type: 'text', text: 'QA is checking it.' }] }],
    }];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages } } });
    const footers: string[][] = [];
    const collect = (node: any) => {
      if (node?.className === 'turn-footer') { footers.push(renderedText(node)); return; }
      for (const child of node?.children ?? []) collect(child);
    };
    collect(booted.elements.get('transcript'));
    expect(footers).toEqual([['Delegations this turn: 1 accepted · 0 refused.']]);
  });

  // Smoke of c2ec1f79: the host patches a finished reply's late receipt in place. The open chat shows the new facts: the
  // reply's node is rebuilt, not reused from before the patch.
  it('redraws a finished reply whose receipt was patched in place', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const reply = (accepted: number, pending: number) => [{
      role: 'agent', kind: 'message', text: 'Dispatched.', ts: '2026-11-08T08:00:00.000Z', seq: 1, turnFinal: true,
      delegationReceipt: { accepted, refused: 0, pending },
      blocks: [{ type: 'paragraph', spans: [{ type: 'text', text: 'Dispatched.' }] }],
    }];
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    const footer = () => {
      const found: string[][] = [];
      const collect = (node: any) => {
        if (node?.className === 'turn-footer') { found.push(renderedText(node)); return; }
        for (const child of node?.children ?? []) collect(child);
      };
      collect(booted.elements.get('transcript'));
      return found;
    };
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: reply(0, 1) } } });
    expect(footer()).toEqual([['Delegations this turn: 0 accepted · 0 refused · 1 pending.']]);
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: reply(1, 0) } } });
    expect(footer()).toEqual([['Delegations this turn: 1 accepted · 0 refused.']]);
    // The redrawn reply is the same reply: the page reports nothing missing.
    expect(booted.postedMessages.filter((message: any) => message?.command === 'renderedTranscriptItemsMissing')).toEqual([]);
  });

  // v0.9.102 (the PM live strip, the Owner's decision): what the selected PM's team is doing now, above the message box,
  // in the sidebar and the Workbench alike. Minutes count in the page; Continue only fills the message box.
  for (const container of ['sidebar', 'workbench'] as const) {
    it(`draws the PM live strip above the message box (${container}); Continue fills the box and sends nothing`, () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-12T10:12:30.000Z'));
        const provider = new ChatViewProvider({} as never, {
          listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
          send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
          state: { get: () => undefined, update: async () => {} },
          getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
        } as never);
        provider.selectAgent('pm');
        const base = (provider as any).currentState();
        const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, container));
        // v0.9.103 (slice 3 §4.4): the lines are in #pmLiveLines inside the plain #pmLive wrapper, which hides when empty.
        const strip = () => booted.elements.get('pmLiveLines') as any;
        const wrapper = () => booted.elements.get('pmLive') as any;
        const show = (pmLive: unknown) => booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: [], pmLive } } });
        expect((provider as any).getHtml({ cspSource: 'test:' }, container)).toMatch(
          /<div class="composer-dock" id="composerDock">\s*<div class="pm-live" id="pmLive" hidden><div id="pmLiveLines" role="status" aria-live="polite"><\/div><div id="pmLiveQuiet" role="status" aria-live="polite" hidden><\/div><\/div>/);

        show({ lines: [
          { kind: 'running', tasks: [{ agent: 'Dev', since: '2026-11-12T10:00:00.000Z' }, { agent: 'QA', since: '2026-11-12T10:12:10.000Z' }, { agent: 'Writer' }] },
          { kind: 'promise', text: 'The PM reports here when results come back.' },
        ] });
        expect(wrapper().hidden).toBe(false);
        expect(renderedText(strip())).toEqual(['Running: Dev (12 min), QA (under 1 min), Writer.', 'The PM reports here when results come back.']);
        // The minutes move on in the page, with no message from the host.
        vi.advanceTimersByTime(60_000);
        expect(renderedText(strip())[0]).toBe('Running: Dev (13 min), QA (1 min), Writer.');

        show({ lines: [{ kind: 'continue', text: 'Dev finished, but the PM has not reported on it.', prompt: 'Please review the finished results and report to me.' }] });
        const row = strip().children[0];
        const button = row.children.find((child: any) => child.tagName === 'BUTTON' || child.type === 'button');
        expect(button.textContent).toBe('Continue');
        const input = booted.elements.get('input') as any;
        input.value = 'Also check the budget.';
        const posted = booted.postedMessages.length;
        booted.dispatchElementEvent(button, 'click');
        expect(input.value).toBe('Also check the budget.\n\nPlease review the finished results and report to me.');
        expect(booted.postedMessages.slice(posted).filter((message: any) => message?.command === 'send')).toEqual([]);

        show(undefined);
        expect(wrapper().hidden).toBe(true);
        expect(strip().children).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // v0.9.102 (the Owner, 2026-11-13: every leftover item can be resolved): each open item has the button that starts
    // its action. A button fills the box or asks the host to run its own command; nothing is sent.
    it(`gives each open item on the PM strip its button (${container}): Ask the PM, Continue rework, Review Delivered Work, Show all`, () => {
      const provider = new ChatViewProvider({} as never, {
        listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
        send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
        state: { get: () => undefined, update: async () => {} },
        getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
      } as never);
      provider.selectAgent('pm');
      const base = (provider as any).currentState();
      const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, container));
      booted.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: [], pmLive: { lines: [
        { kind: 'decision', text: 'Needs your decision: Dev\'s task — Which law?.', review: true },
        { kind: 'continue', text: 'Rework requested from Dev, but none is running.', prompt: 'Please start the rework you requested, or tell me why not.', button: 'Continue rework' },
        { kind: 'elsewhere', text: 'Dev\'s task is being handled in another UnodeAi window.' },
        { kind: 'reminder', text: 'Reminder: Dev\'s task: it was interrupted when its window closed or reloaded.', prompt: 'Please look at Dev\'s task (handle h1): …' },
        { kind: 'more', text: '1 more task needs a decision.', items: [], prompt: 'Please look at these 3 tasks and settle each one:' },
      ] } } } });
      const rows = (booted.elements.get('pmLiveLines') as any).children;
      const buttons = (index: number) => rows[index].children.filter((child: any) => child.type === 'button');
      expect(rows.map((row: any) => buttons(rows.indexOf(row)).map((button: any) => button.textContent))).toEqual([
        ['Review Delivered Work'], ['Continue rework'], [], ['Ask the PM'], ['Show all', 'Ask the PM about all'],
      ]);
      const input = booted.elements.get('input') as any;
      const posted = booted.postedMessages.length;
      booted.dispatchElementEvent(buttons(3)[0], 'click');
      expect(input.value).toBe('Please look at Dev\'s task (handle h1): …');
      input.value = '';
      booted.dispatchElementEvent(buttons(4)[1], 'click');
      expect(input.value).toBe('Please look at these 3 tasks and settle each one:');
      booted.dispatchElementEvent(buttons(0)[0], 'click');
      booted.dispatchElementEvent(buttons(4)[0], 'click');
      const sent = booted.postedMessages.slice(posted);
      expect(sent).toContainEqual({ command: 'pmLiveReview' });
      expect(sent).toContainEqual({ command: 'pmLiveShowAll' });
      expect(sent.filter((message: any) => message?.command === 'send')).toEqual([]);
    });
  }

  // v0.9.102 (smoke of 8d12721b: Ask the PM did nothing in the Workbench). The Workbench dock floats over the transcript
  // and lets clicks through; every part of it the person can press must take them back. v0.9.103 (the Owner,
  // 2026-11-14): on the PM strip only the buttons do; its text lets clicks reach the message behind it.
  it('in the Workbench, every part of the floating composer dock catches clicks, the PM strip included', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    const html: string = (provider as any).getHtml({ cspSource: 'test:' }, 'workbench');
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((match) => ({ selectors: match[1].split(',').map((selector) => selector.trim()), body: match[2] }));
    const pointerEvents = (selector: string) => rules
      .filter((rule) => rule.selectors.includes(selector))
      .map((rule) => /pointer-events:\s*([a-z]+)/.exec(rule.body)?.[1])
      .filter(Boolean).at(-1);
    expect(pointerEvents('body.container-workbench .composer-dock')).toBe('none');
    // The dock's direct children, by their first class.
    const dockStart = html.indexOf('<div class="composer-dock" id="composerDock">');
    expect(dockStart).toBeGreaterThan(-1);
    const children: string[] = [];
    let depth = 0;
    for (const tag of html.slice(dockStart).matchAll(/<(\/?)div\b([^>]*)>/g)) {
      if (tag[1]) { depth -= 1; if (depth === 0) break; continue; }
      depth += 1;
      if (depth === 2) children.push(/class="([^" ]+)/.exec(tag[2])?.[1] ?? '');
    }
    expect(children).toEqual(['pm-live', 'composer-shell']);
    // Each part of the dock catches clicks itself (the card), or through its buttons (the strip).
    for (const child of children) {
      const own = pointerEvents(`body.container-workbench .${child}`);
      const buttons = pointerEvents(`body.container-workbench .${child} button`);
      expect(own === 'auto' || buttons === 'auto', `.${child} in the Workbench dock`).toBe(true);
    }
    expect(pointerEvents('body.container-workbench .composer-shell')).toBe('auto');
    expect(pointerEvents('body.container-workbench .pm-live button')).toBe('auto');
    expect(pointerEvents('body.container-workbench .pm-live')).toBeUndefined();
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

  it('v0.9.103: names a teammate\'s message on its task, and a wake with results and messages as updates', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const source = (name: string, reason: string) => ({ agentId: name.toLowerCase(), agentName: name, reason });
    const woken = (seq: number, turnTrigger: unknown) => ({
      role: 'agent', kind: 'message', text: 'Read.', ts: '2026-11-14T00:00:00.000Z', seq, turnFinal: true, turnTrigger,
      delegationReceipt: { accepted: 0, refused: 0, pending: 0 },
    });
    const messages = [
      woken(1, { sources: [source('Dev', 'task-message')], more: 0 }),
      woken(2, { sources: [source('Dev', 'task-message'), source('Writer', 'delegation-result')], more: 0 }),
      woken(3, { sources: ['Dev', 'Writer', 'Tester', 'Reviewer'].map((name) => source(name, name === 'Tester' ? 'task-message' : 'delegation-result')), more: 1 }),
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
      "Triggered by Dev's message",
      'Triggered by updates from Dev and Writer',
      'Triggered by 5 updates (Dev, Writer, +3 more)',
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

  // v0.9.104 (ROADMAP item 3): a delegation card with a task still working is kept outside the 12-card window, so the
  // window that trims is the finished cards'. The oldest finished card leaving is a trim even with an older running
  // card before it; a running card that disappears is never one.
  it('judges delegation trims among finished cards only: an older running card neither breaks nor hides a trim', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Developer', role: 'Developer', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('dev');
    const base = (provider as any).currentState();
    const ts = '2026-09-18T12:00:00.000Z';
    const card = (id: string, seq: number, working: boolean) => ({
      kind: 'delegation', id, renderKey: `${id}:${working ? 'working' : 'complete'}`, coordinatorId: 'dev', coordinatorName: 'Developer',
      startedAt: ts, ...(working ? {} : { completedAt: ts }), total: 1, done: working ? 0 : 1, partial: 0, blocked: 0, working: working ? 1 : 0,
      items: [{ id: `${id}-task`, agentId: 'dev', agentName: 'Developer', status: working ? 'working' : 'done', instruction: 'x' }], ts, seq,
    });
    const running = card('delegation-running', 1, true);
    const finished = Array.from({ length: DELEGATION_PROGRESS_SUMMARY_LIMIT }, (_, index) => card(`delegation-${index}`, 10 + index, false));
    const newer = card('delegation-new', 100, false);
    const missingEvents = (booted: any) => booted.postedMessages.filter((m: any) => m.command === 'renderedTranscriptItemsMissing');

    const trimmed = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
    const send = (booted: any, messages: any[]) => booted.listeners.message?.[0]!({ data: { command: 'state', state: { ...base, messages, turnEpochs: { dev: 7 } } } });
    send(trimmed, [running, ...finished]);
    send(trimmed, [running, ...finished.slice(1), newer]);
    expect(missingEvents(trimmed)).toEqual([expect.objectContaining({ cause: 'window-trim', missing: [{ id: 'delegation:delegation-0', delivery: 'committed' }] })]);

    const lost = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
    send(lost, [running, ...finished]);
    send(lost, [...finished.slice(1), newer]);
    expect(missingEvents(lost)).toEqual([expect.objectContaining({ cause: 'unexplained' })]);
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

// v0.9.105 S8: the `liveRows` model answers getElementById for a streaming row by walking up each node's one recorded
// parent instead of searching every looked-up element's subtree. These cases pin what it answers: the row exactly when
// it is, at any depth, under an element the script looked up by id, and null when it was never attached, sits under a
// detached wrapper, was removed, or was cleared away with its parent.
describe('the liveRows model finds a streaming row only while it is in the page', () => {
  it('answers by where the row is, through nesting, a fragment, removal and clearing', () => {
    const page = bootWebviewScript(`<script>
      const vscode = acquireVsCodeApi();
      const transcript = document.getElementById('transcript');
      const live = () => document.getElementById('live-message');
      const row = document.createElement('div');
      row.id = 'live-message';
      const seen = [];
      seen.push(['never attached', live() === null]);
      const wrap = document.createElement('div');
      wrap.appendChild(row);
      seen.push(['under a detached wrapper', live() === null]);
      transcript.appendChild(wrap);
      seen.push(['nested under the transcript', live() === row]);
      row.remove();
      seen.push(['removed', live() === null]);
      const fragment = document.createDocumentFragment();
      fragment.appendChild(row);
      transcript.appendChild(fragment);
      seen.push(['in a fragment in the transcript', live() === row]);
      transcript.replaceChildren();
      seen.push(['its parent cleared away', live() === null]);
      wrap.appendChild(row);
      transcript.insertBefore(wrap, null);
      seen.push(['moved back in', live() === row]);
      vscode.postMessage(seen);
    </script>`, { liveRows: true });
    expect(page.postedMessages).toEqual([[
      ['never attached', true], ['under a detached wrapper', true], ['nested under the transcript', true],
      ['removed', true], ['in a fragment in the transcript', true], ['its parent cleared away', true], ['moved back in', true],
    ]]);
  });
});
