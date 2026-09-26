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
        turnTiming: { settledAt: today.toISOString(), durationMs: 21_000, approvalWaitMs: 0 },
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
