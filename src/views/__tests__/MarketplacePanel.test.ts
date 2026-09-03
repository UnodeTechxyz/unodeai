import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { isMarketplaceInstallAction, mcpPrerequisiteHint, renderMarketplaceHtml } from '../MarketplacePanel';
import { MarketplaceCatalog } from '../../marketplace/catalog';

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
    source: 'https://github.com/modelcontextprotocol/servers',
  }, {
    id: 'git',
    name: 'Git',
    summary: 'Works with local repositories',
    transport: 'stdio',
    command: 'uvx',
    prerequisite: 'uv',
  }],
  skills: [{
    id: 'review',
    name: 'Review',
    summary: 'Reviews changes',
    category: 'development',
    capabilities: ['read'],
  }],
};

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
    expect(html).toContain('Build an agent');
    expect(html).toContain('Add MCP server');
    expect(html).toContain('https://github.com/modelcontextprotocol/servers');
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
    expect(html).toContain('Adds to this team');
  });

  it('wires the install button to the real result instead of a blind timer', () => {
    const webview = { cspSource: 'vscode-resource:' } as never;
    const html = renderMarketplaceHtml(webview, catalog);

    // No fixed reset-after-1200ms; the host posts an installResult the webview honors per-card.
    expect(html).not.toContain("setTimeout(() => { button.textContent = 'Add'; }, 1200)");
    expect(html).toContain("m.command !== 'installResult'");
    expect(html).toContain("m.ok ? 'Added ✓' : 'Retry'");
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
