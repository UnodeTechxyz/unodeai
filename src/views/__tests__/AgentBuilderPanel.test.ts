import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const panels: any[] = [];
  return {
    ViewColumn: { One: 1 },
    panels,
    window: {
      createWebviewPanel: vi.fn(() => {
        const webview: any = {
          cspSource: 'test:',
          html: '',
          postMessage: vi.fn(),
          onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
            webview.messageHandler = handler;
            return { dispose: vi.fn() };
          }),
        };
        const panel: any = {
          webview,
          title: '',
          visible: true,
          dispose: vi.fn(),
          reveal: vi.fn(),
          onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
          onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        };
        panels.push(panel);
        return panel;
      }),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
  };
});

vi.mock('vscode', () => vscodeMock);

import {
  canSelectPlaybook,
  describeAgentBuilderSaveProblem,
  parseAgentBuilderSavePayload,
  renderAgentBuilderHtml,
  selectVisibleSkills,
  AgentBuilderPanel,
  AgentBuilderViewModel,
} from '../AgentBuilderPanel';
import { bootWebviewScript } from './support/webviewBoot';

const view: AgentBuilderViewModel = {
  mode: 'new',
  roles: [{
    id: 'senior-dev',
    name: 'Senior Developer',
    role: 'senior-dev',
    systemPrompt: 'Write production code.',
    skillIds: ['code-generation', 'testing'],
    playbookIds: ['root-cause-analysis', 'commit-message-quality'],
    providerId: 'roam',
    model: 'deepseek-v4-pro',
  }, {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    systemPrompt: 'Review independently.',
    skillIds: ['code-review'],
    playbookIds: ['pr-review-checklist', 'diff-risk-triage'],
    providerId: 'roam',
    model: 'deepseek-v4-pro',
  }],
  providers: [{
    id: 'roam',
    connectionId: 'roam',
    name: 'Roam',
    baseUrl: 'https://www.unodetech.xyz/v1',
    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', price: '$0.12/$0.24 per 1M' }],
    runtimeLabel: 'OpenAI-compatible',
    billingLabel: 'Your Roam connection',
    privacySummary: 'Prompts and included workspace content go to Roam.',
    capabilitySummary: 'Plan available; Act available; commands unode-mediated.',
  }],
  capabilities: [{
    id: 'code-generation',
    name: 'Code Generation',
    description: 'Write code',
    category: 'development',
  }, {
    id: 'testing',
    name: 'Testing',
    description: 'Write tests',
    category: 'development',
  }],
  mcpServers: [{
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    connected: false,
    requiresApproval: true,
  }],
  catalog: {
    agents: [],
    mcp: [],
    skills: [{
      id: 'code-generation',
      name: 'Implementation Playbook',
      summary: 'Builds features carefully',
      category: 'development',
      capabilities: ['read', 'write'],
      body: '# Implement',
    }, {
      id: 'code-review',
      name: 'Review Playbook',
      summary: 'Checks changes for regressions',
      category: 'development',
      capabilities: ['read'],
      body: '# Review',
    }, {
      id: 'accessibility-audit',
      name: 'Accessibility Audit',
      summary: 'Checks labels and keyboard flow',
      category: 'design',
      capabilities: ['read', 'write', 'search'],
    }, {
      id: 'ci-pipeline-review',
      name: 'CI Pipeline Review',
      summary: 'Reviews release automation',
      category: 'infrastructure',
      capabilities: ['read', 'execute'],
    }],
  },
  skillLibraryUrl: 'https://github.com/UnodeTechxyz/unode-skills',
};

/**
 * What a first-time user is asked to read before they can create one agent.
 *
 * The page carried eleven panels, every one already at a working default. Five of them are decisions that
 * are genuinely the user's; the other four are settings that exist for the case where the default is wrong,
 * and they were spending a new user's attention on questions they did not have to answer.
 *
 * Pinned as a test because "which of these is advanced" is exactly the judgement that erodes: the next
 * person adding a panel has to decide where it goes, and this list is where that decision is recorded.
 */
describe('the builder opens on the decisions that are the user\'s', () => {
  const html = () => renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);

  function mainColumn(): string {
    const source = html();
    return source.slice(source.indexOf('<main class="main">'), source.indexOf('<aside class="side">'));
  }

  it('keeps common choices visible and gives each section its own closed advanced fold', () => {
    const main = mainColumn();
    expect(main.match(/<details class="section-advanced"/g)).toHaveLength(7);
    for (const id of ['identityAdvanced', 'modelAdvanced', 'skillFullList', 'toolFullList',
                       'folderAccessAdvanced', 'commandAccessAdvanced', 'mcpAdvanced']) {
      expect(main).toContain(`id="${id}"`);
    }
    expect(main).toContain('Icon and colour — usually left at the role default');
    expect(main).toContain('Routing, sampling and tier — usually left at connection defaults');
    expect(main).toContain('Usually inherits the global policy');
    expect(main).not.toMatch(/<details[^>]+\sopen(?:\s|>)/);
  });

  // Every field stays in the DOM, so the save handler — which reads them by id — is untouched by the move.
  it('keeps every advanced field addressable, because the save collects them by id', () => {
    const main = mainColumn();
    for (const id of ['mp_temperature', 'mp_max_tokens', 'mp_reasoning_effort', 'mp_context_window',
                      'mp_tier', 'folderAccessRows', 'commandNarrowingList', 'mcpChecks']) {
      expect(main, id).toContain(`id="${id}"`);
    }
  });

  it('reports actionable notices on the affected closed summary and has no auto-open path', () => {
    const source = html();
    for (const id of ['modelAdvancedSummary', 'folderAccessAdvancedSummary', 'mcpAdvancedSummary']) {
      expect(source).toContain(`id="${id}"`);
    }
    expect(source).toContain("summary.textContent = count === 1 ? '⚠ 1 issue'");
    expect(source).not.toContain('MutationObserver');
    expect(source).not.toMatch(/\.open\s*=\s*true/);
  });

  it('keeps a disclosure closed across a second notice update', () => {
    const boot = bootWebviewScript(html());
    const disclosure = { open: false } as any;
    boot.elements.set('folderAccessAdvanced', disclosure);
    const provider = boot.elements.get('provider')!;
    provider.id = 'provider';
    provider.value = 'codex'; // adds the Folder Access warning through the real change handler
    for (const listener of boot.listeners.change ?? []) { listener({ target: provider }); }
    provider.value = 'roam'; // a second event clears it; neither event owns the disclosure state
    for (const listener of boot.listeners.change ?? []) { listener({ target: provider }); }

    expect(disclosure.open).toBe(false);
  });

  it('keeps the common model choices above the model fold and filters the context override by connection', () => {
    const main = mainColumn();
    const source = html();
    const fold = main.indexOf('id="modelAdvanced"');
    expect(main.indexOf('id="model"')).toBeLessThan(fold);
    expect(main.indexOf('id="mp_context_window"')).toBeLessThan(fold);
    expect(main.indexOf('id="mp_reasoning_effort"')).toBeLessThan(fold);
    expect(main).toContain('data-model-connection="context-window"');
    expect(source).toContain('contextWindowAvailable');
    expect(source).toContain('moveModelRoutingControls');
  });

  it('keeps selected skills and tools out of the folded full lists, and hoists search matches without opening them', () => {
    const source = html();
    for (const id of ['selectedSkillGrid', 'skillSearchMatches', 'selectedCapabilityChecks', 'selectedPlaybooksEmpty', 'selectedToolsEmpty']) {
      expect(source).toContain(`id="${id}"`);
    }
    expect(source).toContain('selectedGrid.appendChild(card)');
    expect(source).toContain('searchMatches.appendChild(card)');
    expect(source).toContain('syncCapabilityCards()');
    expect(source).not.toMatch(/skillFullList\.open|toolFullList\.open/);
  });
});

describe('renderAgentBuilderHtml', () => {
  it('renders the required builder sections and message hooks', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);

    expect(html).toContain('Identity');
    expect(html).toContain('Model');
    expect(html).toContain('Instructions');
    expect(html).toContain('Skill Playbooks');
    expect(html).toContain('Tools');
    expect(html).toContain('Folder Access');
    expect(html).toContain('MCP Grants');
    expect(html).toContain('Backup model');
    expect(html).toContain('Tool calling method');
    expect(html).toContain('Connection / Pay through');
    expect(html).toContain('id="connectionDetails"');
    expect(html).toContain('data-icon="$(robot)"');
    expect(html).toContain('id="iconPreview"');
    expect(html).toContain('data-command="agentBuilderPickIcon"');
    expect(html).toContain("command === 'iconPicked'");
    expect(html).toContain('data-command="browseSkillLibrary"');
    expect(html).toContain('data-command="addMcpServer"');
    expect(html).toContain("command: 'pickFolderAccessFolder'");
    expect(html).toContain("command === 'folderAccessFolderPicked'");
    expect(html).toContain("command: 'validateFolderAccess'");
    expect(html).toContain("command === 'folderAccessIssues'");
    expect(html).toContain("command: 'listModels'");
    expect(html).toContain("command: 'formDirty'");
    expect(html).toContain('document.addEventListener(\'input\', markFormDirty)');
    expect(html).toContain('data-playbook-id="code-generation"');
  });

  it('keeps model catalogs and connection facts scoped to the selected connection', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      providers: [
        ...view.providers,
        {
          id: 'codex', connectionId: 'codex-cli', name: 'Codex Headless', models: [{ id: 'codex-cli-default', name: 'Codex default' }],
          runtimeLabel: 'Codex Headless', billingLabel: 'Your OpenAI account',
          privacySummary: 'Prompts and included workspace content go through the logged-in Codex CLI.',
          availability: 'coming-soon',
          availabilityMessage: 'Codex Headless is coming soon and is not available in this release.',
          allowedModelParamKeys: ['reasoning_effort'],
          skillsAvailable: false,
          folderAccessAvailable: false,
          toolProtocolAvailable: false,
          smartModeAvailable: false,
          mcpAvailable: false,
          capabilitySummary: 'Plan available; Act unavailable; commands unavailable.',
        },
      ],
      defaultProviderId: 'codex',
    });

    expect(html).toContain('<option value="codex" selected disabled>Codex Headless — Coming soon</option>');
    expect(html).toContain('modelCatalog.get(provider?.id)');
    expect(html).toContain("vscode.postMessage({ command: 'listModels', providerId, baseUrl: provider.baseUrl })");
    expect(html).toContain('Your OpenAI account');
    expect(html).toContain('syncModelParamControls(provider)');
    expect(html).toContain('data-model-param="temperature"');
    expect(html).toContain('removeLegacyModelParams');
    expect(html).toContain('Existing selections are preserved');
    expect(html).not.toContain('selectedSkills.delete(');
    expect(html).not.toContain('selectedMcp.clear()');
    expect(html).toContain('syncSkillPlaybookControls(provider)');
    expect(html).toContain('syncFolderAccessControls(provider)');
    expect(html).toContain('syncToolProtocolControl(provider)');
    expect(html).toContain('syncSmartModeControl(provider)');
    expect(html).toContain("provider.availability === 'coming-soon'");
    expect(html).not.toContain('claude login');
  });

  it('a NEW agent opens on the provider chosen in Setup, not whichever is first in the list', () => {
    // Field report: set up with Roam (or any non-default provider), then build an agent — the Provider field
    // came back as something else. `unode.defaultProvider` was simply never read here; the builder took
    // view.providers[0]. Same class of bug as the one resolveDefaultProvider()'s comment warns about.
    const twoProviders = {
      ...view,
      defaultProviderId: 'openai',
      providers: [
        ...view.providers,   // 'roam' is first in the list…
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
      ],
    };
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, twoProviders);

    // …but the user chose OpenAI, so that is what must be selected.
    expect(html).toContain('<option value="openai" selected>');
    expect(html).not.toContain('<option value="roam" selected>');
  });

  it('an EXISTING agent keeps its own provider, whatever the default is', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      defaultProviderId: 'openai',
      agent: {
        id: 'a1', name: 'Rev', role: 'reviewer', roleKey: 'reviewer', providerId: 'roam',
        model: 'deepseek-v4-pro', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [],
      },
    });
    expect(html).toContain('<option value="roam" selected>');   // the agent's own provider wins
  });

  it('a NEW agent opens blank: no role pre-picked, no Name, no Instructions', () => {
    // Pre-selecting the first role made the panel look configured when nothing had been chosen, and it meant
    // every role pick had to overwrite text that was already sitting in the box. Picking a role is what fills
    // the form in.
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    expect(html).toContain('<option value="" selected>Select a role…</option>');
    expect(html).toContain('<input id="name" value="">');
    expect(html).toContain('<textarea id="systemPrompt"></textarea>');
    expect(html).not.toContain('<option value="senior-dev" selected>');
    // (the role templates are still embedded in the script — that is how picking a role fills the form in;
    //  what must not happen is one of them being pre-loaded into the textarea, asserted above.)
  });

  it('an EXISTING agent still opens on its own role and prompt', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      agent: {
        id: 'a1', name: 'Rev', role: 'reviewer', roleKey: 'reviewer', providerId: 'roam',
        model: 'deepseek-v4-pro', systemPrompt: 'My own words.', skillIds: [], playbooks: [], mcpServers: [],
      },
    });
    expect(html).not.toContain('Select a role…');
    expect(html).toContain('<option value="reviewer" selected>');
    expect(html).toContain('My own words.');
  });

  it('never uses a blocking browser dialog — a VS Code webview stubs confirm/alert/prompt out', () => {
    // window.confirm() returned undefined in the real panel, which the role handler read as "cancelled" and
    // used to snap the dropdown back: the role could never be changed at all. Any blocking dialog is a dead
    // branch here; a user decision must go through the host (postMessage) or an in-panel control.
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1] ?? '';
    const code = script.replace(/\/\/[^\n]*/g, ''); // strip line comments: the ban is on calls, not on prose
    expect(code).not.toMatch(/\bwindow\.(confirm|alert|prompt)\s*\(/);
    expect(code).not.toMatch(/(^|[^.\w])(confirm|alert)\s*\(/m);
  });

  it('a role change adopts the template and offers the replaced text back', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    expect(html).toContain("if (event.target.id === 'role')");
    expect(html).toContain('syncRoleDefaults(true, Boolean(nextRole))');                 // the switch ALWAYS applies
    expect(html).toContain('roleTemplateAdopted');
    expect(html).toContain('syncTierDefaultLabel()');
    expect(html).toContain('syncToolProtocolAutoLabel()');
    expect(html).toContain("byId('systemPrompt').value = role.systemPrompt");            // instructions update
    expect(html).toContain('selectedModel = role.model');                                // model updates too
    expect(html).toContain('stashedPrompt = previousPrompt');                            // …and nothing is lost
    expect(html).toContain('id="roleSwitchRestore"');
  });

  it('includes a custom-role instructions-required hint (hidden for a non-custom default role)', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    expect(html).toContain('id="instructionsReq"');
    expect(html).toMatch(/required for a custom role/i);
    // default role here is senior-dev → the hint starts hidden (JS reveals it when "Custom role" is picked)
    expect(html).toMatch(/id="instructionsReq"[^>]*hidden/);
  });

  it('renders resolved default labels while preserving blank option values', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      roles: view.roles.map((role) => ({ ...role, tier: role.id === 'reviewer' ? 'economy' : 'standard' })),
    });

    expect(html).toContain('<option value="" selected>medium (default)</option>');
    expect(html).toContain('<option value="" selected>Provider default</option>');
    expect(html).toContain('<option value="" selected>on (default)</option>');
    expect(html).toContain('Use role default — standard');
    expect(html).toContain('Auto — native for deepseek-v4-pro');
    expect(html).toContain('placeholder="0.7 (default)"');
    expect(html).toContain('placeholder="Provider default"');
    expect(html).toContain('placeholder="32768 (default)"');
    expect(html).toContain('placeholder="1048576"');
    expect(html).not.toContain('Default (medium)');
    expect(html).not.toContain('Auto (recommended)');
    expect(html).not.toContain('provider default (default)');
  });

  it('omits response format by default for new agents while preserving explicit text and JSON choices', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    expect(html).toContain('<option value="" selected>Text (provider default)</option>');
    expect(html).toContain('<option value="text" >Text</option>');
    expect(html).toContain('JSON object (structured output)');
    expect(html).toContain('JSON object is for a downstream program consumer and may not combine with tools.');

    const base = {
      name: 'Dev',
      roleKey: 'senior-dev',
      providerId: 'roam',
      model: 'deepseek-v4-pro',
      systemPrompt: 'Write production code.',
      skillIds: [],
      playbooks: [],
      mcpServers: [],
    };
    expect(parseAgentBuilderSavePayload({
      ...base,
      modelParams: { response_format: '' },
    }, view)?.modelParams).toBeUndefined();
    expect(parseAgentBuilderSavePayload({
      ...base,
      modelParams: { response_format: 'text' },
    }, view)?.modelParams?.response_format).toEqual({ type: 'text' });
    expect(parseAgentBuilderSavePayload({
      ...base,
      modelParams: { response_format: 'json_object' },
    }, view)?.modelParams?.response_format).toEqual({ type: 'json_object' });
  });

  it('keeps an existing blank response format as the text-equivalent provider default', () => {
    const editView = {
      ...view,
      mode: 'edit' as const,
      agent: {
        id: 'a1', name: 'Dev', role: 'senior-dev', roleKey: 'senior-dev', providerId: 'roam',
        model: 'deepseek-v4-pro', systemPrompt: 'Write production code.', skillIds: [], playbooks: [], mcpServers: [],
      },
    };
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, editView);
    expect(html).toContain('<option value="" selected>Text (provider default)</option>');
    expect(parseAgentBuilderSavePayload({
      name: 'Dev', roleKey: 'senior-dev', providerId: 'roam', model: 'deepseek-v4-pro', systemPrompt: 'Write production code.',
      skillIds: [], playbooks: [], mcpServers: [], modelParams: { response_format: '' },
    }, editView)?.modelParams).toBeUndefined();
  });

  it('names native as the auto tool-calling default and renders the known-leaker warning in the body', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      agent: {
        id: 'a1', name: 'Dev', role: 'senior-dev', roleKey: 'senior-dev', providerId: 'roam',
        model: 'kimi-k2.7-code', systemPrompt: 'Write production code.',
        skillIds: [], playbooks: [], mcpServers: [],
      },
    });

    const body = html.slice(html.indexOf('<body>'), html.indexOf('<script'));
    expect(body).toContain('Auto — native for kimi-k2.7-code');
    expect(body).toContain('the first tool use may visibly retry');
    expect(html).toContain('declaredProtocolProfileForModel(model)');

    const ordinary = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      agent: {
        id: 'a2', name: 'Dev', role: 'senior-dev', roleKey: 'senior-dev', providerId: 'roam',
        model: 'claude-opus-5', systemPrompt: 'Write production code.',
        skillIds: [], playbooks: [], mcpServers: [],
      },
    });
    const ordinaryBody = ordinary.slice(ordinary.indexOf('<body>'), ordinary.indexOf('<script'));
    expect(ordinaryBody).not.toContain('the first tool use may visibly retry');
  });

  it('renders edit mode without truncating a user-authored Playbooks heading', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      agent: {
        id: 'a1',
        name: 'Existing',
        role: 'senior-dev',
        roleLabel: 'senior-dev',
        providerId: 'roam',
        model: 'deepseek-v4-pro',
        fallbackModel: 'qwen-plus',
        toolProtocol: 'xml',
        systemPrompt: 'Base prompt\n\n## Playbooks\n### Old\nbody',
        skillIds: ['testing'],
        playbooks: ['code-review'],
        mcpServers: ['github'],
        folderAccess: [{ path: 'src', permission: 'readwrite' }],
        folderAccessIssues: [{ kind: 'missing', path: 'src', message: 'Folder does not exist: src' }],
      },
    });

    expect(html).toContain('Base prompt');
    expect(html).toContain('### Old');
    expect(html).toContain('data-playbook-id="code-review" checked');
    expect(html).toContain('const initialFallbackModel = "qwen-plus"');
    expect(html).toContain('<option value="xml" selected>XML</option>');
    expect(html).toContain('"path":"src"');
    expect(html).toContain('Folder does not exist: src');
  });

  it('shows prompt provenance, template-only diff, and explicit keep/reset/undo controls', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      mode: 'edit',
      agent: {
        id: 'a1', name: 'Existing', role: 'senior-dev', roleLabel: 'senior-dev',
        providerId: 'roam', model: 'deepseek-v4-pro', systemPrompt: 'My custom instructions.',
        skillIds: [], playbooks: [], mcpServers: [],
        promptTemplate: {
          state: 'custom-outdated',
          label: 'Customized (default has since changed)',
          detail: 'Your instructions are untouched.',
          showUpdateNotice: true,
          diff: '--- Default guidance when you customized\n+++ Current default guidance\n-old\n+new',
          canReset: true,
          canUndo: true,
        },
      },
    });

    expect(html).toContain('Customized (default has since changed)');
    expect(html).toContain('Show default guidance diff');
    expect(html).toContain('+new');
    expect(html).not.toContain('My custom instructions.\n+new');
    expect(html).toContain('data-prompt-template-action="dismiss"');
    expect(html).toContain('data-prompt-template-action="adopt"');
    expect(html).toContain('data-prompt-template-action="undo"');
    expect(html).toContain("command: 'promptTemplateAction'");
  });
});

describe('AgentBuilderPanel registry refresh', () => {
  it('preserves unsaved form HTML after the webview reports a dirty form', async () => {
    AgentBuilderPanel.current = undefined;
    vscodeMock.panels.length = 0;
    const getViewModel = vi.fn(async () => view);
    AgentBuilderPanel.createOrShow({} as never, {
      getViewModel,
      listModels: async () => [],
      save: async () => ({ ok: true, message: 'saved' }),
      pickIcon: async () => undefined,
      pickFolderAccessFolder: async () => undefined,
      resolveFolderAccessIssues: async () => [],
      openSkillLibrary: async () => {},
      addMcpServer: async () => {},
    });

    await vi.waitFor(() => expect(vscodeMock.panels[0]?.webview.html).toContain('id="systemPrompt"'));
    const panel = vscodeMock.panels[0];
    const unsavedHtml = panel.webview.html;

    await panel.webview.messageHandler({ command: 'formDirty' });
    AgentBuilderPanel.refreshCurrent();

    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ command: 'mcpServers', servers: view.mcpServers }));
    expect(panel.webview.html).toBe(unsavedHtml);
  });
});

describe('skill picker logic', () => {
  it('allows any number of progressive playbooks', () => {
    expect(canSelectPlaybook(['a', 'b', 'c', 'd', 'e'], 'f')).toBe(true);
    expect(canSelectPlaybook(['a', 'b', 'c', 'd', 'e'], 'b')).toBe(true);
    expect(canSelectPlaybook(['a', 'b', 'c', 'd'], 'e')).toBe(true);
  });

  it('narrows by search, category, role, and sort mode', () => {
    expect(selectVisibleSkills(view.catalog.skills, { query: 'keyboard' }).map((s) => s.id))
      .toEqual(['accessibility-audit']);
    expect(selectVisibleSkills(view.catalog.skills, { category: 'infrastructure' }).map((s) => s.id))
      .toEqual(['ci-pipeline-review']);
    expect(selectVisibleSkills(view.catalog.skills, { role: 'reviewer' }, view.roles).map((s) => s.id))
      .toEqual(['code-review']);
    expect(selectVisibleSkills(view.catalog.skills, { sort: 'newest' }).map((s) => s.id)[0])
      .toBe('ci-pipeline-review');
    expect(selectVisibleSkills(view.catalog.skills, { sort: 'most-used' }).map((s) => s.id)[0])
      .toBe('accessibility-audit');
  });
});

describe('describeAgentBuilderSaveProblem (specific save errors)', () => {
  const ok = {
    name: 'CEO', roleKey: 'custom', customRole: 'Chief Exec', providerId: 'roam',
    model: 'deepseek-v4-pro', systemPrompt: 'Lead the company.',
  };

  it('returns undefined for a valid payload', () => {
    expect(describeAgentBuilderSaveProblem(ok, view)).toBeUndefined();
  });

  it('names a custom agent missing its system prompt (the CEO repro)', () => {
    const msg = describeAgentBuilderSaveProblem({ ...ok, systemPrompt: '   ' }, view);
    expect(msg).toMatch(/System prompt/);
  });

  it('names a missing custom role name', () => {
    const msg = describeAgentBuilderSaveProblem({ ...ok, customRole: '' }, view);
    expect(msg).toMatch(/Custom role name/);
  });

  it('lists multiple missing required fields together', () => {
    const msg = describeAgentBuilderSaveProblem({ roleKey: 'custom' }, view) ?? '';
    expect(msg).toMatch(/Name/);
    expect(msg).toMatch(/Model/);
    expect(msg).toMatch(/System prompt/);
  });

  it('flags an unknown provider specifically', () => {
    expect(describeAgentBuilderSaveProblem({ ...ok, providerId: 'nope' }, view)).toMatch(/unknown provider/i);
  });
});

describe('parseAgentBuilderSavePayload', () => {
  it('accepts a save payload with backup model and tool protocol', () => {
    const parsed = parseAgentBuilderSavePayload({
      name: 'Feature Builder',
      roleKey: 'senior-dev',
      providerId: 'roam',
      model: 'new-live-model',
      fallbackModel: 'backup-live-model',
      toolProtocol: 'xml',
      systemPrompt: 'Build carefully.',
      skillIds: ['code-generation', 'testing', 'unknown'],
      playbooks: ['code-generation', 'code-review', 'accessibility-audit', 'ci-pipeline-review'],
      mcpServers: ['github', 'missing'],
      folderAccess: [{ path: 'src', permission: 'readwrite' }, { path: 'docs', permission: 'read' }],
      icon: 'F',
      color: '#336699',
    }, view);

    expect(parsed).toMatchObject({
      name: 'Feature Builder',
      roleKey: 'senior-dev',
      providerId: 'roam',
      model: 'new-live-model',
      fallbackModel: 'backup-live-model',
      toolProtocol: 'xml',
      skillIds: ['code-generation', 'testing'],
      playbooks: ['code-generation', 'code-review', 'accessibility-audit', 'ci-pipeline-review'],
      mcpServers: ['github'],
      folderAccess: [{ path: 'src', permission: 'readwrite' }, { path: 'docs', permission: 'read' }],
      icon: 'F',
      color: '#336699',
    });
  });

  it('accepts small data URI image icons and rejects oversized image icons', () => {
    const icon = 'data:image/png;base64,eA==';
    const base = {
      name: 'Feature Builder',
      roleKey: 'senior-dev',
      providerId: 'roam',
      model: 'new-live-model',
      systemPrompt: 'Build carefully.',
      skillIds: [],
      playbooks: [],
      mcpServers: [],
    };

    expect(parseAgentBuilderSavePayload({ ...base, icon }, view)?.icon).toBe(icon);
    expect(parseAgentBuilderSavePayload({ ...base, icon: `data:image/png;base64,${'A'.repeat(100_000)}` }, view)?.icon)
      .toBeUndefined();
  });

  it('rejects malformed folder access rows instead of widening the sandbox', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    expect(parseAgentBuilderSavePayload({ ...base, folderAccess: [{ path: 'src', permission: 'read' }] }, view)?.folderAccess)
      .toEqual([{ path: 'src', permission: 'read' }]);
    expect(parseAgentBuilderSavePayload({ ...base, folderAccess: [{ path: 42, permission: 'read' }] }, view)).toBeUndefined();
    expect(parseAgentBuilderSavePayload({ ...base, folderAccess: [{ path: 'src', permission: 'admin' }] }, view)).toBeUndefined();
    expect(describeAgentBuilderSaveProblem({ ...base, folderAccess: [{ path: 'src', permission: 'admin' }] }, view))
      .toMatch(/folder access/i);
  });

  it('offers only global command templates when an agent narrows command access', () => {
    const scopedView: AgentBuilderViewModel = {
      ...view,
      globalCommandPolicy: { approvalMode: 'allowlist', allowedCommands: ['npm test', 'git status'] },
    };
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    const parsed = parseAgentBuilderSavePayload({
      ...base,
      commandNarrowing: { approvalMode: 'allowlist', allowedCommands: ['npm test'] },
    }, scopedView);
    expect(parsed?.commandNarrowing).toEqual({ approvalMode: 'allowlist', allowedCommands: ['npm test'] });
    expect(parseAgentBuilderSavePayload({
      ...base,
      commandNarrowing: { approvalMode: 'allowlist', allowedCommands: ['npm run arbitrary'] },
    }, scopedView)).toBeUndefined();
    const html = renderAgentBuilderHtml({ cspSource: 'test:' } as any, scopedView);
    expect(html).toContain('Inherit global');
    expect(html).toContain('Restrict to selected');
    expect(html).toContain('globalCommandTemplates');
    expect(html).not.toContain('Add command');
  });

  it('defaults tool protocol to "auto" (so the backend can pick XML for leakers); keeps explicit choices', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    expect(parseAgentBuilderSavePayload({ ...base }, view)?.toolProtocol).toBe('auto');            // missing → auto
    expect(parseAgentBuilderSavePayload({ ...base, toolProtocol: 'auto' }, view)?.toolProtocol).toBe('auto');
    expect(parseAgentBuilderSavePayload({ ...base, toolProtocol: 'native' }, view)?.toolProtocol).toBe('native');
    expect(parseAgentBuilderSavePayload({ ...base, toolProtocol: 'xml' }, view)?.toolProtocol).toBe('xml');
    expect(parseAgentBuilderSavePayload({ ...base, toolProtocol: 'garbage' }, view)?.toolProtocol).toBe('auto'); // unknown → auto
  });

  it('parses + clamps per-agent model fine-tuning (incl. response_format/thinking/stop/tool_choice) and the tier', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    const p = parseAgentBuilderSavePayload({
      ...base,
      modelParams: {
        temperature: '0.7', top_p: '0.9', max_tokens: '2048', reasoning_effort: 'high',
        presence_penalty: '0.5', frequency_penalty: '1', response_format: 'json_object',
        thinking_type: 'enabled', thinking_budget_tokens: '4096', tool_choice: 'auto',
        stream: 'disabled', stop: 'END\n###\n',
      },
      contextWindowTokens: '200000',
      tier: 'economy',
    }, view);
    // Regression (Codex): an agent saved through the builder must keep EVERY Settings tuning field — none
    // silently dropped. Same shapes the Settings panel produces (both route through sanitizeParams).
    expect(p?.modelParams).toEqual({
      temperature: 0.7, top_p: 0.9, max_tokens: 2048, reasoning_effort: 'high',
      presence_penalty: 0.5, frequency_penalty: 1, response_format: { type: 'json_object' },
      thinking: { type: 'enabled', budget_tokens: 4096 }, tool_choice: 'auto', stream: false,
      stop: ['END', '###'],
    });
    expect(p?.contextWindowTokens).toBe(200000);
    expect(p?.tier).toBe('economy');
  });

  it('removes sampling fields from a known incompatible model even when a forged webview payload includes them', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'gpt-5', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    const p = parseAgentBuilderSavePayload({
      ...base,
      modelParams: { temperature: '0.7', top_p: '0.9', max_tokens: '2048', reasoning_effort: 'high' },
    }, view);

    expect(p?.modelParams).toEqual({ max_tokens: 2048, reasoning_effort: 'high' });
  });

  it('ships the model-specific sampling disablement and explanation into the Builder webview', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    expect(html).toContain('function modelRejectsSamplingParameters(model)');
    expect(html).toContain('samplingParameterRejectionReason');
    expect(html).toContain('control.disabled = !allowed || rejectedByModel');
  });

  it('clamps an out-of-range fine-tuning value rather than dropping it', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    const p = parseAgentBuilderSavePayload({ ...base, modelParams: { top_p: '5', temperature: 'abc' } }, view);
    expect(p?.modelParams).toEqual({ top_p: 1 }); // top_p clamped to its 0–1 max; non-numeric temperature omitted
  });

  it('omits modelParams when all fine-tuning fields are blank, and ignores an invalid tier', () => {
    const base = { name: 'A', roleKey: 'senior-dev', providerId: 'roam', model: 'm', systemPrompt: 'x', skillIds: [], playbooks: [], mcpServers: [] };
    const p = parseAgentBuilderSavePayload({
      ...base,
      modelParams: {
        temperature: '', top_p: '', max_tokens: '', reasoning_effort: '',
        presence_penalty: '', frequency_penalty: '', response_format: '',
        thinking_type: '', thinking_budget_tokens: '', tool_choice: '',
        stream: '', stop: '',
      },
      tier: '',
    }, view);
    expect(p?.modelParams).toBeUndefined(); // → agent uses global defaults
    expect(p?.tier).toBeUndefined();        // → agent follows the role/default tier
  });

  it('requires a custom role label for custom agents', () => {
    expect(parseAgentBuilderSavePayload({
      name: 'CEO Agent',
      roleKey: 'custom',
      providerId: 'roam',
      model: 'deepseek-v4-pro',
      systemPrompt: 'Lead the crew.',
      skillIds: [],
      playbooks: [],
      mcpServers: [],
    }, view)).toBeUndefined();

    expect(parseAgentBuilderSavePayload({
      name: 'CEO Agent',
      roleKey: 'custom',
      customRole: 'CEO',
      providerId: 'roam',
      model: 'custom-live-model',
      systemPrompt: 'Lead the crew.',
      skillIds: [],
      playbooks: [],
      mcpServers: [],
    }, view)?.customRole).toBe('CEO');
  });
});

describe('the webview script must actually RUN (not just be present)', () => {
  // Field report: Save did nothing and the Role dropdown did nothing, while typing still worked. Root cause:
  // `let lastRoleKey = byId('role').value;` sat ABOVE `const byId = …`, so the Temporal Dead Zone threw
  // "Cannot access 'byId' before initialization" at script top level. That killed the ENTIRE script, so no
  // event handler was ever registered — the panel rendered fine but was completely inert (the textarea is
  // native, so typing still worked and it LOOKED healthy). Every existing test only inspected the HTML
  // string, so nothing caught a script that never runs.
  // A permissive DOM stub: any unknown property resolves to a no-op function, so the test asserts "the script
  // RUNS", not "the script only touches the DOM methods I happened to stub". Real errors (TDZ, syntax,
  // referencing an undefined variable) still surface.
  const stubEl = (): Record<string, unknown> =>
    new Proxy(
      { value: '', textContent: '', innerHTML: '', hidden: false, checked: false, disabled: false,
        style: {}, dataset: {}, children: [], length: 0 } as Record<string, unknown>,
      {
        get(target, prop) {
          if (prop in target) { return target[prop as string]; }
          if (prop === Symbol.iterator) { return [][Symbol.iterator]; }
          return () => stubEl();
        },
        set(target, prop, value) { target[prop as string] = value; return true; },
      }
    ) as Record<string, unknown>;

  it('evaluates its top-level script without throwing', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    const sharedBoot = bootWebviewScript(html);
    expect(sharedBoot.listeners.click, 'the shared harness must see the Save click listener').toBeTruthy();
    expect(sharedBoot.listeners.change, 'the shared harness must see the Role change listener').toBeTruthy();
    const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1];
    expect(script, 'no script block found in the panel HTML').toBeTruthy();

    // A syntax error surfaces at construction…
    expect(() => new Function('document', 'window', 'acquireVsCodeApi', script!)).not.toThrow();

    // …but the TDZ bug parsed FINE and only threw on execution. This is the assertion that would have
    // caught it: run the top level exactly as the webview does.
    const document = {
      getElementById: () => stubEl(),
      querySelector: () => stubEl(),
      querySelectorAll: () => [],
      createElement: () => stubEl(),
      addEventListener() {},
      body: stubEl(),
    };
    expect(
      () => new Function('document', 'window', 'acquireVsCodeApi', script!)(
        document,
        // NOTE: confirm() returns undefined, exactly as a real VS Code webview does — it stubs the blocking
        // dialogs out. Do not "helpfully" make it return true here; that hides the bug this file exists for.
        { addEventListener() {}, confirm: () => undefined, matchMedia: () => ({ matches: false, addEventListener() {} }) },
        () => ({ postMessage() {}, getState: () => undefined, setState() {} })
      ),
      'the webview script threw at top level — every event handler would be dead (Save and Role do nothing)'
    ).not.toThrow();
  });
});

describe('changing the Role actually changes the role (field bug: it snapped back to the first role)', () => {
  // Root cause of the snap-back: the handler gated the switch on window.confirm(), which a VS Code webview
  // stubs out. It returned undefined, the handler read that as "the user cancelled", and reset the dropdown
  // to the previous role. So the Role select was immovable and Instructions never followed it. These tests
  // DRIVE the handler against a DOM whose confirm() behaves like the real one.
  type El = {
    id: string; value: string; hidden: boolean; textContent: string; checked: boolean;
    dataset: Record<string, string>; style: Record<string, string>;
    closest(sel: string): El | null;
    addEventListener(): void; appendChild(): void; remove(): void; setAttribute(): void;
    querySelectorAll(): El[];
  };

  function boot(initialPrompt: string) {
    const els = new Map<string, El>();
    const el = (id: string): El => {
      const found = els.get(id);
      if (found) { return found; }
      // The state we assert on is real; every other DOM method the panel happens to call resolves to a no-op,
      // so this test stays about behaviour and not about which methods I remembered to stub.
      const state: Record<string, unknown> = {
        id, value: '', hidden: false, textContent: '', checked: false, disabled: false,
        dataset: {}, style: {}, children: [], length: 0,
        closest(sel: string) { return sel === '#' + id ? made : null; },
        querySelectorAll: () => [],
      };
      const made = new Proxy(state, {
        get(target, prop) {
          if (prop in target) { return target[prop as string]; }
          if (prop === Symbol.iterator) { return [][Symbol.iterator]; }
          return () => undefined;
        },
        set(target, prop, value) { target[prop as string] = value; return true; },
      }) as unknown as El;
      els.set(id, made);
      return made;
    };
    el('role').value = 'senior-dev';       // the panel opens on the first role, as it does in the field
    el('systemPrompt').value = initialPrompt;
    el('roleSwitchNotice').hidden = true;  // the markup ships it hidden

    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const document = {
      getElementById: (id: string) => el(id),
      querySelector: () => el('__q'),
      querySelectorAll: () => [] as El[],
      createElement: () => el('__c'),
      addEventListener(type: string, fn: (e: unknown) => void) { (listeners[type] ??= []).push(fn); },
      body: el('__body'),
    };
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1];
    new Function('document', 'window', 'acquireVsCodeApi', script!)(
      document,
      { addEventListener() {}, confirm: () => undefined, matchMedia: () => ({ matches: false, addEventListener() {} }) },
      () => ({ postMessage() {}, getState: () => undefined, setState() {} })
    );
    const fire = (type: string, target: El) => listeners[type]?.forEach((fn) => fn({ target }));
    return { el, fire };
  }

  it('adopts the picked role: the dropdown stays put and Name + Instructions follow it', () => {
    const { el, fire } = boot('Write production code.');   // untouched Senior Developer template
    el('role').value = 'reviewer';
    fire('change', el('role'));

    expect(el('role').value, 'the Role dropdown snapped back — the switch was cancelled').toBe('reviewer');
    expect(el('systemPrompt').value).toBe('Review independently.');
    expect(el('name').value).toBe('Reviewer');
  });

  it('when it replaces text the user wrote, the text is offered back — and Restore returns it', () => {
    const { el, fire } = boot('我手写的PM指令：永远先问我再动手。');
    el('role').value = 'reviewer';
    fire('change', el('role'));

    expect(el('role').value).toBe('reviewer');
    expect(el('systemPrompt').value).toBe('Review independently.');
    expect(el('roleSwitchNotice').hidden, 'the replaced text was dropped with no way back').toBe(false);
    expect(el('roleSwitchNoticeText').textContent).toContain('Reviewer');

    fire('click', el('roleSwitchRestore'));
    expect(el('systemPrompt').value).toBe('我手写的PM指令：永远先问我再动手。');
    expect(el('roleSwitchNotice').hidden).toBe(true);
    expect(el('role').value, 'Restore returns the text, not the role').toBe('reviewer');
  });

  it('does not nag when it only replaced an untouched role template', () => {
    const { el, fire } = boot('Write production code.');
    el('role').value = 'reviewer';
    fire('change', el('role'));
    expect(el('roleSwitchNotice').hidden).toBe(true);
  });
});

/**
 * Catalogue order is authoring order. It means something to whoever wrote the catalogue and nothing to
 * someone hunting for one playbook in a list of ninety — which is what the Owner reported.
 *
 * Asserted on the emitted HTML rather than on the comparator, because a sort helper that no renderer calls
 * is the shape this project keeps finding: correct code, nothing proving it is used.
 */
describe('catalogue lists render alphabetically', () => {
  const positionsIn = (html: string, marker: string, names: string[]): number[] =>
    names.map((name) => html.indexOf(`>${name}<`, html.indexOf(marker)));

  it('orders every playbook card by name, whatever order the catalogue supplies', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, view);
    // The fixture supplies Implementation, Review, Accessibility, CI — deliberately not alphabetical.
    const order = positionsIn(html, 'id="skillGrid"', [
      'Accessibility Audit', 'CI Pipeline Review', 'Implementation Playbook', 'Review Playbook',
    ]);
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('orders every tool row by name', () => {
    const html = renderAgentBuilderHtml({ cspSource: 'vscode-resource:' } as never, {
      ...view,
      capabilities: [
        { id: 'testing', name: 'Testing', description: 'Write tests', category: 'development' },
        { id: 'code-generation', name: 'Code Generation', description: 'Write code', category: 'development' },
      ],
    });
    const order = positionsIn(html, 'id="capabilityChecks"', ['Code Generation', 'Testing']);
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
