import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock('vscode', () => vscodeMock);

import {
  isMarketplaceInstallAction, MarketplacePanel, mcpApprovalClassification, mcpPrerequisiteHint,
  ownIntegrationCards, renderMarketplaceHtml,
} from '../MarketplacePanel';
import { MarketplaceCatalog } from '../../marketplace/catalog';
import { bootWebviewScript } from './support/webviewBoot';

const catalog: MarketplaceCatalog = {
  agents: [{
    id: 'dev',
    name: 'Developer',
    role: 'developer',
    summary: 'Writes code',
    icon: 'D',
    skills: ['review', 'missing-skill'],
    model: 'claude-sonnet-4-20250514',
    tier: 'standard',
    systemPrompt: 'You write code.',
  }, {
    id: 'plain',
    name: 'Plain Agent',
    role: 'developer',
    summary: 'No declared skills',
    icon: 'P',
    model: 'claude-sonnet-4-20250514',
    tier: 'standard',
    systemPrompt: 'You write code.',
  } as MarketplaceCatalog['agents'][number],
  {
    id: 'empty',
    name: 'Empty Skills Agent',
    role: 'developer',
    summary: 'Empty skills list',
    icon: 'E',
    skills: [],
    model: 'claude-sonnet-4-20250514',
    tier: 'standard',
    systemPrompt: 'You write code.',
  }],
  mcp: [{
    id: 'github',
    name: 'GitHub',
    summary: 'Works with issues and pull requests',
    transport: 'stdio',
    command: 'npx',
    args: ['@example/github-mcp'],
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    source: 'https://github.com/example/github-mcp',
    maintenanceState: 'community',
    lastVerified: '2026-09-11',
    installIdentity: { ecosystem: 'npm', value: '@example/github-mcp' },
  }, {
    id: 'git',
    name: 'Git',
    summary: 'Works with local repositories',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    prerequisite: 'uv',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    maintenanceState: 'reference',
    lastVerified: '2026-09-11',
    installIdentity: { ecosystem: 'pypi', value: 'mcp-server-git' },
  }],
  skills: [{
    id: 'review',
    name: 'Review',
    summary: 'Reviews changes',
    category: 'development',
    capabilities: ['read'],
  }],
};

function documentBody(html: string): string {
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('Marketplace renderer did not emit a body.');
  // A CSP nonce is deliberately fresh every render; the snapshot protects the body structure, not entropy.
  return match[1].replace(/nonce="[^"]+"/g, 'nonce="<nonce>"').replace(/[ \t]+(?=\r?\n)/g, '');
}

describe('MarketplacePanel action validation', () => {
  it('accepts scoped agent and MCP install actions for known entries', () => {
    expect(isMarketplaceInstallAction({ kind: 'agent', entryId: 'dev', target: 'current-team' }, catalog)).toBe(true);
    expect(isMarketplaceInstallAction({ kind: 'agent', entryId: 'dev', target: 'new-team' }, catalog)).toBe(true);
    expect(isMarketplaceInstallAction({ kind: 'mcp', entryId: 'github', scope: 'extension' }, catalog)).toBe(true);
    expect(isMarketplaceInstallAction({ kind: 'mcp', entryId: 'github', scope: 'current-team' }, catalog)).toBe(true);
    expect(isMarketplaceInstallAction({ kind: 'mcp', entryId: 'git', scope: 'current-team' }, catalog)).toBe(true);
  });

  it('rejects unknown entries and malformed scopes', () => {
    expect(isMarketplaceInstallAction({ kind: 'agent', entryId: 'missing', target: 'current-team' }, catalog)).toBe(false);
    expect(isMarketplaceInstallAction({ kind: 'agent', entryId: 'dev', target: 'global' }, catalog)).toBe(false);
    expect(isMarketplaceInstallAction({ kind: 'mcp', entryId: 'github', scope: 'project' }, catalog)).toBe(false);
    expect(isMarketplaceInstallAction({ kind: 'skill', entryId: 'review', scope: 'project' }, catalog)).toBe(false);
  });
});

describe('renderMarketplaceHtml', () => {
  it('renders connection, failure reason, grants, and a bounded remove action for owned integrations', () => {
    const html = ownIntegrationCards([{
      id: 'private-docs', name: 'Private docs', connection: 'failed',
      reason: 'Required secret DOCS_TOKEN is not configured.', grantedAgents: ['Researcher', 'Writer'],
    }]);
    expect(html).toContain('Connection: failed');
    expect(html).toContain('Required secret DOCS_TOKEN is not configured.');
    expect(html).toContain('Granted agents: Researcher, Writer');
    expect(html).toContain('data-command="removeIntegration"');
    expect(html).toContain('data-server-id="private-docs"');
  });
  it('keeps the body equal to the pre-shell snapshot captured at 6feb05d', () => {
    const html = renderMarketplaceHtml({ cspSource: 'vscode-resource:' } as never, catalog);
    expect(documentBody(html)).toMatchSnapshot('body at 6feb05d');
  });

  it('uses exactly one CSP whose nonce authorizes its one script', () => {
    const html = renderMarketplaceHtml({ cspSource: 'vscode-resource:' } as never, catalog);
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g) ?? [];
    const script = html.match(/<script nonce="([^"]+)">/g) ?? [];
    expect(csp).toHaveLength(1);
    expect(script).toHaveLength(1);
    const nonce = script[0].match(/nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp[0]).toContain(`script-src 'nonce-${nonce}'`);
  });

  it('renders live Agents and MCP tabs without the dead Skills tab', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog);

    expect(html).toContain('data-tab="agents"');
    expect(html).toContain('data-tab="mcp"');
    expect(html).not.toContain('data-tab="skills"');
    expect(html).not.toContain('id="skills"');
    expect(html).toContain('data-install-kind="agent"');
    expect(html).toContain('data-install-kind="mcp"');
    expect(html).toContain('data-command="openAgentBuilder"');
    expect(html).toContain('data-command="addMcpServer"');
    expect(html).toContain('data-owned-integrations');
    expect(html).toContain('Your integrations');
    expect(html).toContain("command === 'removeIntegration'");
    expect(html).toContain('Build an agent');
    expect(html).toContain('Add MCP server');
    expect(html).toContain('https://github.com/example/github-mcp');
    expect(html).not.toContain('Coming in Phase 3');
  });

  it('defaults to the Agents tab, and deep-links to MCP when asked', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const def = renderMarketplaceHtml(webview, catalog);
    expect(def).toContain('class="tab active" data-tab="agents"');
    expect(def).toContain('class="section active" id="agents"');
    expect(def).toContain("let activeTab = 'agents'");

    const mcp = renderMarketplaceHtml(webview, catalog, 'mcp');
    expect(mcp).toContain('class="tab active" data-tab="mcp"');
    expect(mcp).toContain('class="section active" id="mcp"');
    expect(mcp).toContain('class="tab" data-tab="agents"'); // agents no longer active
    expect(mcp).toContain("let activeTab = 'mcp'");

    // An unknown/garbage tab falls back to Agents, never blanks both.
    const bogus = renderMarketplaceHtml(webview, catalog, 'nope' as never);
    expect(bogus).toContain('class="tab active" data-tab="agents"');
  });

  it('drops the no-op MCP scope dropdown but keeps the agent install-target one', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog);

    // Agent cards still choose current-team / new-team.
    expect(html).toContain('aria-label="Agent install target"');
    expect(html).toContain('value="new-team"');
    // The MCP scope <select> (Extension / Current team) is gone — it did nothing.
    expect(html).not.toContain('aria-label="MCP install scope"');
    expect(html).not.toContain('>Extension<');
    expect(html).toContain('Adds configuration to this team; grants no agent access');
  });

  it('wires the install button to the real result instead of a blind timer', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog);

    // No fixed reset-after-1200ms; the host posts an installResult the webview honors per-card.
    expect(html).not.toContain("setTimeout(() => { button.textContent = 'Add'; }, 1200)");
    expect(html).toContain("m.command !== 'installResult'");
    expect(html).toContain("m.kind === 'mcp' ? 'Configured' : 'Added'");
    expect(html).toContain('Adding configuration…');
    expect(html).toContain("btn.textContent = installLabel(m.kind, btn.closest('[data-entry-id]'))");
    expect(html).toContain("m.command === 'viewState'");
  });

  it('wraps Integration actions so the scope note owns a full row', () => {
    const html = renderMarketplaceHtml({ cspSource: 'vscode-resource:' } as never, catalog, 'mcp');
    expect(html).toContain('.actions { display: flex; flex-wrap: wrap;');
    expect(html).toContain('.scope-note { flex: 1 1 100%;');
  });

  it('keeps the Integrations tab and result feedback while live state updates in place', () => {
    vi.useFakeTimers();
    try {
      const exercisedClasses = new Set<string>();
      const exercisedChip = {
        dataset: { lifecycleState: 'exercised' },
        textContent: 'exercised',
        classList: { toggle: (name: string, enabled: boolean) => enabled ? exercisedClasses.add(name) : exercisedClasses.delete(name) },
      };
      const succeededClasses = new Set<string>();
      const succeededChip = {
        dataset: { lifecycleState: 'succeeded' },
        textContent: 'succeeded',
        classList: { toggle: (name: string, enabled: boolean) => enabled ? succeededClasses.add(name) : succeededClasses.delete(name) },
      };
      const button = { dataset: {} as Record<string, string>, disabled: true, textContent: '', closest: () => card };
      const card = {
        dataset: { entryId: 'github', configured: 'false', search: 'github' },
        hidden: false,
        querySelector: () => button,
        querySelectorAll: (selector: string) => selector === '[data-lifecycle-state]' ? [exercisedChip, succeededChip] : [],
      };
      const search = { value: '', addEventListener() {} };
      const filteredSelectors: string[] = [];
      const boot = bootWebviewScript(
        renderMarketplaceHtml({ cspSource: 'test:' } as never, catalog, 'mcp'),
        {
          document: {
            querySelector: (selector) => selector === '.search' ? search : undefined,
            querySelectorAll: (selector) => {
              if (selector === '#mcp [data-entry-id]') return [card];
              if (selector === '#mcp [data-search]') {
                filteredSelectors.push(selector);
                return [card];
              }
              return [];
            },
          },
        },
      );
      const onMessage = boot.listeners.message[0];

      onMessage({ data: { command: 'installResult', kind: 'mcp', entryId: 'github', ok: true } });
      expect(button.textContent).toBe('Configured');
      onMessage({
        data: {
          command: 'viewState', agentsHtml: '',
          integrations: { github: { listed: true, configured: true, approved: true, mounted: true, exercised: true, succeeded: false } },
        },
      });

      expect(filteredSelectors).toEqual(['#mcp [data-search]']);
      expect(button.textContent).toBe('Configured');
      expect(exercisedClasses.has('done')).toBe(true);
      expect(exercisedChip.textContent).toBe('exercised ✓');
      expect(succeededClasses.has('done')).toBe(false);
      expect(succeededChip.textContent).toBe('succeeded');
      vi.advanceTimersByTime(2200);
      expect(button.textContent).toBe('Reconfigure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders resolved skill names as an Includes line on agent cards only when present', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog);

    expect(html).toContain('Includes: Review');
    expect(html).not.toContain('missing-skill');
    expect(html).not.toContain('Includes: </div>');
    expect(html.match(/Includes:/g)).toHaveLength(1);
  });

  it('shows MCP prerequisites for uvx entries but not npx entries', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog, 'mcp');

    expect(html).toContain('&#9888; Requires uv');
    expect(html.match(/Requires uv/g)).toHaveLength(1);
    expect(html).toContain('GitHub');
    expect(html).not.toContain('Requires Node');
  });

  it('derives non-ubiquitous MCP prerequisites from command when metadata is absent', () => {
    expect(mcpPrerequisiteHint({ command: 'uvx' })).toBe('uv');
    expect(mcpPrerequisiteHint({ command: 'docker' })).toBe('Docker');
    expect(mcpPrerequisiteHint({ command: 'npx' })).toBeUndefined();
    expect(mcpPrerequisiteHint({ command: 'uvx', prerequisite: '<uv>' })).toBe('<uv>');
  });
});

/**
 * Same rule as the Agent Builder: a catalogue a person scans by eye is ordered by name, not by whatever
 * order the catalogue file happens to list. Asserted on the emitted HTML, not on the comparator.
 */
describe('marketplace lists render alphabetically', () => {
  it('orders agent cards and MCP cards by name', () => {
    const agents = renderMarketplaceHtml({ cspSource: 'vscode-resource:' } as never, catalog);
    const section = agents.slice(agents.indexOf('id="agents"'), agents.indexOf('id="mcp"'));
    const names = [...section.matchAll(/<div class="name">([^<]+)<\/div>/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(1);
    expect([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })))
      .toEqual(names);
  });
});

describe('governed Marketplace state', () => {
  it('shows Your Agents with truthful template, custom, and unknown origins', () => {
    const html = renderMarketplaceHtml({ cspSource: 'test:' } as never, catalog, 'agents', {
      integrations: {},
      agents: [
        { id: 'a', name: 'Template Agent', roleTemplateKey: 'dev', systemPromptSource: 'template' },
        { id: 'b', name: 'Forked Agent', roleTemplateKey: 'dev', systemPromptSource: 'custom' },
        { id: 'c', name: 'Legacy Agent' },
      ],
    });
    expect(html).toContain('Role Templates');
    expect(html).toContain('Your Agents');
    expect(html).toContain('Based on Developer · template instructions');
    expect(html).toContain('Based on Developer · custom instructions');
    expect(html).toContain('origin not recorded');
    expect(html).toContain('Open in Agent Builder');
  });

  it('uses the host approval classifier and renders every lifecycle state separately', () => {
    expect(mcpApprovalClassification(catalog.mcp[0])).toBe(true);
    const html = renderMarketplaceHtml({ cspSource: 'test:' } as never, catalog, 'mcp', {
      agents: [],
      integrations: {
        github: { listed: true, configured: true, approved: false, mounted: false, exercised: true, succeeded: false },
      },
    });
    expect(html).toContain('approval required');
    expect(html).toContain('stdio / local process / approval required');
    expect(html).toContain('Credentials: GITHUB_TOKEN');
    for (const state of ['listed', 'configured', 'approved', 'mounted', 'exercised', 'succeeded']) {
      expect(html).toContain(`>${state}`);
    }
    expect(html).toContain('grants no agent access');
    expect(html).toContain('Check setup');
    expect(html).toContain("vscode.postMessage({ command, entryId: card.dataset.entryId })");
  });

  it('labels overdue verification without hiding the Integration', () => {
    const overdue = {
      ...catalog,
      mcp: [{ ...catalog.mcp[0], lastVerified: '2020-01-01' }],
    };
    const html = renderMarketplaceHtml({ cspSource: 'test:' } as never, overdue, 'mcp');
    expect(html).toContain('GitHub');
    expect(html).toContain('verification overdue');
  });
});

describe('MarketplacePanel live state delivery', () => {
  it('keeps the document in place after install and sends result before the fresh host state', async () => {
    const postMessage = vi.fn();
    const panel = Object.create(MarketplacePanel.prototype) as any;
    panel.catalog = catalog;
    panel.panel = { webview: { html: 'integrations-tab-document', postMessage } };
    panel.getViewState = () => ({
      agents: [{ id: 'agent-1', name: 'Live Agent', roleTemplateKey: 'dev', systemPromptSource: 'template' }],
      integrations: {
        github: { listed: true, configured: true, approved: true, mounted: true, exercised: false, succeeded: false },
      },
    });
    panel.onInstall = vi.fn(async () => ({ ok: true, message: 'configured' }));
    panel.render = vi.fn();

    panel.onMessage({ command: 'install', action: { kind: 'mcp', entryId: 'github', scope: 'current-team' } });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

    expect(panel.panel.webview.html).toBe('integrations-tab-document');
    expect(panel.render).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0]).toEqual({ command: 'installResult', kind: 'mcp', entryId: 'github', ok: true });
    expect(postMessage.mock.calls[1][0]).toMatchObject({
      command: 'viewState',
      integrations: { github: { configured: true, mounted: true } },
    });
    expect(postMessage.mock.calls[1][0].agentsHtml).toContain('Live Agent');
  });

  it('pushes roster and lifecycle refreshes without replacing the open document', () => {
    const postMessage = vi.fn();
    const panel = Object.create(MarketplacePanel.prototype) as any;
    panel.catalog = catalog;
    panel.panel = { webview: { html: 'keep-me', postMessage } };
    panel.getViewState = () => ({ agents: [], integrations: {} });
    MarketplacePanel.current = panel;

    MarketplacePanel.refreshCurrent();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'viewState' }));
    expect(panel.panel.webview.html).toBe('keep-me');
    MarketplacePanel.current = undefined;
  });
});
