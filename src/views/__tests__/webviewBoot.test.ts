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
import { ChatViewProvider } from '../ChatViewProvider';
import { CHAT_HISTORY_LIMIT } from '../chatHistory';
import { renderMarketplaceHtml } from '../MarketplacePanel';
import { MessageLogProvider } from '../MessageLogProvider';
import { OnboardingWizard } from '../OnboardingWizard';
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
