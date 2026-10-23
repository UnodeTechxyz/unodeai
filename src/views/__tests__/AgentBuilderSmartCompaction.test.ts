import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const panels: any[] = [];
  return {
    ViewColumn: { One: 1, Active: -1 },
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
  AgentBuilderPanel,
  describeAgentBuilderSaveProblem,
  parseAgentBuilderSavePayload,
  parseSmartCompactionChoice,
  parseSmartCompactionForm,
  renderAgentBuilderHtml,
  type AgentBuilderSmartCompactionView,
  type AgentBuilderViewModel,
} from '../AgentBuilderPanel';
import { bootWebviewScript } from './support/webviewBoot';

const preview = {
  summary: 'Smart · Research & synthesis · auto-compact at 200,000',
  rule: 'Advertised window 1,048,576 · 70% = 734,003 · profile ceiling 275,000 · route evidence cap 200,000 · auto-compact at 200,000.',
  sizing: 'After compacting, it keeps up to 60,000 recent tokens word for word and aims for about 90,000 in total.',
  autoLabel: 'Auto: Research & synthesis — Market Researcher template',
  unavailable: false,
};

function smartCompaction(fields: Partial<AgentBuilderSmartCompactionView> = {}): AgentBuilderSmartCompactionView {
  return {
    mode: 'smart',
    profile: '',
    customDefaults: { windowPercent: 70, ceilingTokens: 250_000 },
    profiles: [
      { id: 'balanced', label: 'Balanced', typicalWork: 'Mixed work' },
      { id: 'deep-build', label: 'Deep build', typicalWork: 'Architecture' },
    ],
    preview,
    ...fields,
  };
}

function view(fields: Partial<AgentBuilderViewModel> = {}): AgentBuilderViewModel {
  return {
    mode: 'new',
    roles: [{
      id: 'market-researcher', name: 'Market Researcher', role: 'custom', systemPrompt: 'Research.',
      skillIds: [], playbookIds: [], providerId: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813',
    }],
    providers: [{ id: 'openrouter', connectionId: 'openrouter', name: 'OpenRouter', models: [] }],
    capabilities: [{ id: 'research', name: 'Research', description: 'Research', category: 'data' }],
    mcpServers: [],
    catalog: { agents: [], mcp: [], skills: [] },
    skillLibraryUrl: 'https://github.com/UnodeTechxyz/unode-skills',
    smartCompaction: smartCompaction(),
    ...fields,
  };
}

const webview = { cspSource: 'test:' } as any;

function section(html: string): string {
  const start = html.indexOf('<details class="section-advanced" id="smartCompactionAdvanced"');
  return html.slice(start, html.indexOf('</details>', start));
}

describe('Agent Builder Smart compaction group', () => {
  it('renders collapsed on Smart with the Auto resolution, the full rule and the non-blocking promise', () => {
    const html = section(renderAgentBuilderHtml(webview, view()));
    expect(html).not.toMatch(/id="smartCompactionAdvanced"[^>]*\sopen/);
    const escaped = (text: string) => text.replace(/&/g, '&amp;');
    expect(html).toContain(escaped(preview.summary));
    expect(html).toContain('<option value="smart" selected>');
    expect(html).toContain(`<option value="" selected>${escaped(preview.autoLabel)}</option>`);
    expect(html).toContain(preview.rule);
    expect(html).toContain('This schedules compaction; it does not block tasks.');
    expect(html).toContain('Edit team profile table…');
    // Custom's inputs exist (the save reads them by id) but stay hidden until Custom is chosen.
    expect(html).toMatch(/id="sc_percent_field" hidden/);
    expect(html).toMatch(/id="sc_ceiling_field" hidden/);
    expect(html).toContain('min="10" max="90"');
    expect(html).toContain('min="16384" max="2000000"');
  });

  it('shows a Custom agent\'s own numbers and the Reset Custom action', () => {
    const html = section(renderAgentBuilderHtml(webview, view({
      smartCompaction: smartCompaction({ mode: 'custom', windowPercent: 60, ceilingTokens: 200_000 }),
    })));
    expect(html).toContain('<option value="custom" selected>');
    expect(html).toMatch(/id="sc_window_percent"[^>]*value="60"/);
    expect(html).toMatch(/id="sc_ceiling_tokens"[^>]*value="200000"/);
    expect(html).not.toMatch(/id="sc_reset_custom" hidden/);
    expect(html).toMatch(/id="sc_profile_field" hidden/);
  });

  it('disables Custom with its reason when the policy file cannot supply its starting values', () => {
    const html = section(renderAgentBuilderHtml(webview, view({
      smartCompaction: smartCompaction({ customDefaults: undefined, customUnavailable: 'customDefaults.windowPercent must be a whole percent' }),
    })));
    expect(html).toMatch(/<option value="custom" disabled title="customDefaults\.windowPercent must be a whole percent">/);
  });

  it('opens only when the user asked for this group, and the script still boots', () => {
    const html = renderAgentBuilderHtml(webview, view({ focus: 'smart-compaction' }));
    expect(section(html)).toMatch(/id="smartCompactionAdvanced" open/);
    const boot = bootWebviewScript(html);
    expect(boot.listeners.change?.length).toBeGreaterThan(0);
  });
});

describe('Agent Builder Smart compaction choice parsing', () => {
  it('accepts Smart with or without a profile, Custom with both numbers, and Off', () => {
    expect(parseSmartCompactionChoice({ mode: 'smart', profile: '' })).toEqual({ mode: 'smart' });
    expect(parseSmartCompactionChoice({ mode: 'smart', profile: 'deep-build' })).toEqual({ mode: 'smart', profile: 'deep-build' });
    expect(parseSmartCompactionChoice({ mode: 'custom', windowPercent: '70', ceilingTokens: '250000' }))
      .toEqual({ mode: 'custom', windowPercent: 70, ceilingTokens: 250_000 });
    expect(parseSmartCompactionChoice({ mode: 'off', windowPercent: 'x', profile: 'deep-build' })).toEqual({ mode: 'off' });
  });

  it('refuses an unknown mode or profile and a Custom choice missing a valid number', () => {
    expect(parseSmartCompactionChoice({ mode: 'turbo' })).toBeUndefined();
    expect(parseSmartCompactionChoice({ mode: 'smart', profile: 'fast' })).toBeUndefined();
    expect(parseSmartCompactionChoice({ mode: 'custom', windowPercent: '70', ceilingTokens: '' })).toBeUndefined();
    expect(parseSmartCompactionChoice({ mode: 'custom', windowPercent: '95', ceilingTokens: '250000' })).toBeUndefined();
    expect(parseSmartCompactionChoice({ mode: 'custom', windowPercent: '70', ceilingTokens: '250000.5' })).toBeUndefined();
  });

  it('carries the choice in a save and explains a refused Custom save', () => {
    const base = {
      name: 'Researcher', roleKey: 'market-researcher', providerId: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813',
      systemPrompt: 'Research.', skillIds: [], playbooks: [], mcpServers: [], folderAccess: [],
    };
    expect(parseAgentBuilderSavePayload({ ...base, smartCompaction: { mode: 'off' } }, view())?.smartCompaction).toEqual({ mode: 'off' });
    expect(parseAgentBuilderSavePayload(base, view())?.smartCompaction).toBeUndefined();
    const bad = { ...base, smartCompaction: { mode: 'custom', windowPercent: '5', ceilingTokens: '250000' } };
    expect(parseAgentBuilderSavePayload(bad, view())).toBeUndefined();
    expect(describeAgentBuilderSaveProblem(bad, view())).toBe(
      'Custom compaction needs a whole window share from 10 to 90% and a practical ceiling from 16,384 to 2,000,000 tokens.',
    );
  });

  it('parses the preview form for a known connection only', () => {
    const form = { roleKey: 'market-researcher', skillIds: ['research', 'forged'], providerId: 'openrouter', model: 'm', mode: 'custom', windowPercent: '5' };
    expect(parseSmartCompactionForm(form, view())).toEqual({
      roleKey: 'market-researcher', skillIds: ['research'], providerId: 'openrouter', model: 'm',
      contextWindowTokens: undefined, mode: 'custom', windowPercent: 5,
    });
    expect(parseSmartCompactionForm({ ...form, providerId: 'elsewhere' }, view())).toBeUndefined();
  });
});

describe('Agent Builder panel Smart compaction messages', () => {
  function openPanel(focus?: 'smart-compaction') {
    AgentBuilderPanel.current = undefined;
    const deps = {
      getViewModel: vi.fn(() => view()),
      listModels: vi.fn(() => []),
      save: vi.fn(async () => ({ ok: true, message: 'saved' })),
      pickIcon: vi.fn(),
      pickFolderAccessFolder: vi.fn(),
      resolveFolderAccessIssues: vi.fn(() => []),
      openSkillLibrary: vi.fn(),
      addMcpServer: vi.fn(),
      previewSmartCompaction: vi.fn(() => ({ ...preview, summary: 'Off · manual only' })),
      openCompactionProfileTable: vi.fn(),
    };
    AgentBuilderPanel.createOrShow({} as any, deps, 'agent-1', focus);
    return { deps, panel: vscodeMock.panels[vscodeMock.panels.length - 1] };
  }

  it('recalculates the preview on the host and answers with the same sequence number', async () => {
    const { deps, panel } = openPanel();
    await vi.waitFor(() => expect(panel.webview.html).toContain('smartCompactionAdvanced'));
    await panel.webview.messageHandler({
      command: 'smartCompactionPreview', seq: 7,
      form: { roleKey: 'market-researcher', skillIds: [], providerId: 'openrouter', model: 'm', mode: 'off' },
    });
    expect(deps.previewSmartCompaction).toHaveBeenCalledWith(expect.objectContaining({ mode: 'off', providerId: 'openrouter' }), 'agent-1');
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'smartCompactionPreview', seq: 7, preview: expect.objectContaining({ summary: 'Off · manual only' }),
    }));
  });

  it('opens the one shared team table editor', async () => {
    const { deps, panel } = openPanel();
    await vi.waitFor(() => expect(panel.webview.html).toContain('smartCompactionAdvanced'));
    await panel.webview.messageHandler({ command: 'editCompactionProfileTable' });
    expect(deps.openCompactionProfileTable).toHaveBeenCalledOnce();
  });

  it('focuses the group on the render the roster gear asked for, and not on a later refresh', async () => {
    const { panel } = openPanel('smart-compaction');
    await vi.waitFor(() => expect(section(panel.webview.html)).toMatch(/id="smartCompactionAdvanced" open/));
    AgentBuilderPanel.refreshCurrent();
    await vi.waitFor(() => expect(panel.webview.html).toContain('smartCompactionAdvanced'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(section(panel.webview.html)).not.toMatch(/id="smartCompactionAdvanced" open/);
  });
});
