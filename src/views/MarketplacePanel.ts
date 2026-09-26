/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MarketplacePanel
 *  Renderer-only marketplace browser for v0.6 M2. Real install handlers land in M4.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  AgentCatalogEntry,
  CatalogSourceName,
  MarketplaceCatalog,
  MarketplaceInstallAction,
  McpCatalogEntry,
  isCatalogVerificationOverdue,
} from '../marketplace/catalog';
import { RawCatalog, resolveCatalog, CATALOG_PUBLIC_KEY_PEM } from '../marketplace/catalogSource';
import { esc, escAttr, sanitizeHref } from './webviewSecurity';
import { renderWebviewDocument } from './webviewDocument';
import { MarketplaceWebviewOutboundMessage, parseMarketplaceWebviewInboundMessage } from './marketplaceWebviewProtocol';
import { byDisplayName } from './displayOrder';
import { readUnodeSetting } from '../settings/AuthoritySettings';
import { roleTemplateCatalogEntries } from '../marketplace/roleTemplateCatalog';
import { shouldRequireApproval } from '../mcp/McpApproval';
import { toMcpServerConfig } from '../marketplace/install';
import { IntegrationLifecycle } from '../mcp/IntegrationLifecycle';
import { showResultNotice } from '../resultNotice';

const EMPTY_CATALOG: MarketplaceCatalog = { agents: [], mcp: [], skills: [] };

/** The marketplace's top-level tabs; callers can deep-link straight to one (e.g. Settings → MCP). */
export type MarketplaceTab = 'agents' | 'mcp';
const MARKETPLACE_TABS: readonly MarketplaceTab[] = ['agents', 'mcp'];
export function asMarketplaceTab(value: unknown): MarketplaceTab {
  return MARKETPLACE_TABS.includes(value as MarketplaceTab) ? (value as MarketplaceTab) : 'agents';
}

/** Performs a chosen install and reports a user-facing result. Implemented in extension.ts (M4). */
export type MarketplaceInstallHandler = (action: MarketplaceInstallAction) => Promise<{ ok: boolean; message: string }>;
type RenderedMarketplaceInstallAction = Exclude<MarketplaceInstallAction, { kind: 'skill' }>;

export interface MarketplaceRosterAgent {
  id: string;
  name: string;
  roleTemplateKey?: string;
  systemPromptSource?: 'template' | 'custom';
}

export interface MarketplaceViewState {
  agents: MarketplaceRosterAgent[];
  integrations: Record<string, IntegrationLifecycle>;
  ownedIntegrations?: Array<{
    id: string;
    name: string;
    connection: 'awaiting approval' | 'mounted' | 'failed' | 'unmounted';
    reason?: string;
    grantedAgents: string[];
  }>;
}

const EMPTY_VIEW_STATE: MarketplaceViewState = { agents: [], integrations: {} };

export class MarketplacePanel {
  public static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private catalog: MarketplaceCatalog = EMPTY_CATALOG;
  private initialTab: MarketplaceTab = 'agents';

  /** Push current host facts into an open panel without replacing its document or UI position. */
  static refreshCurrent(): void {
    MarketplacePanel.current?.postViewState();
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    onInstall: MarketplaceInstallHandler,
    initialTab: MarketplaceTab = 'agents',
    getViewState: () => MarketplaceViewState = () => EMPTY_VIEW_STATE,
    onRemoveIntegration?: (serverId: string) => Promise<{ ok: boolean; message: string }>,
  ): void {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.onInstall = onInstall;
      MarketplacePanel.current.initialTab = initialTab;
      MarketplacePanel.current.getViewState = getViewState;
      MarketplacePanel.current.onRemoveIntegration = onRemoveIntegration;
      MarketplacePanel.current.panel.reveal();
      void MarketplacePanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeMarketplace',
      'UnodeAi Marketplace',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    MarketplacePanel.current = new MarketplacePanel(panel, extensionUri, onInstall, initialTab, getViewState, onRemoveIntegration);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private onInstall: MarketplaceInstallHandler,
    initialTab: MarketplaceTab = 'agents',
    private getViewState: () => MarketplaceViewState = () => EMPTY_VIEW_STATE,
    private onRemoveIntegration?: (serverId: string) => Promise<{ ok: boolean; message: string }>,
  ) {
    this.panel = panel;
    this.initialTab = initialTab;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    void this.render();
  }

  private async render(): Promise<void> {
    this.catalog = await loadBundledCatalog(this.extensionUri);
    this.panel.webview.html = renderMarketplaceHtml(this.panel.webview, this.catalog, this.initialTab, this.getViewState());
  }

  private postViewState(): void {
    const state = this.getViewState();
    const response: MarketplaceWebviewOutboundMessage = {
      command: 'viewState',
      agentsHtml: ownAgentCards(state.agents, this.catalog.agents),
      ownedIntegrationsHtml: ownIntegrationCards(state.ownedIntegrations ?? []),
      integrations: state.integrations,
    };
    void this.panel.webview.postMessage(response);
  }

  private onMessage(value: unknown): void {
    const parsed = parseMarketplaceWebviewInboundMessage(value);
    if (!parsed.ok) return;
    const msg = parsed.message;
    if (msg.command === 'openAgentBuilder') {
      void vscode.commands.executeCommand('unode.openAgentBuilder');
      return;
    }
    if (msg.command === 'editAgent') {
      void vscode.commands.executeCommand('unode.openAgentBuilder', msg.agentId);
      return;
    }
    if (msg.command === 'addMcpServer') {
      void vscode.commands.executeCommand('unode.addMcpServer');
      return;
    }
    if (msg.command === 'removeIntegration') {
      if (!this.onRemoveIntegration) return;
      void this.onRemoveIntegration(msg.serverId).then((result) => {
        if (result.ok) void showResultNotice('information', `UnodeAi Marketplace: ${result.message}`);
        else void showResultNotice('warning', `UnodeAi Marketplace: ${result.message}`);
        this.postViewState();
      }, (error) => {
        void showResultNotice('error', `UnodeAi Marketplace: removal failed — ${String(error)}`);
      });
      return;
    }
    if (msg.command === 'checkIntegration') {
      const entry = this.catalog.mcp.find((candidate) => candidate.id === msg.entryId);
      if (!entry) {
        void showResultNotice('warning', 'UnodeAi Marketplace: unknown integration. Nothing was changed.');
        return;
      }
      const state = this.getViewState().integrations[entry.id] ?? {
        listed: true, configured: false, approved: false, mounted: false, exercised: false, succeeded: false,
      };
      const reached = (Object.keys(state) as Array<keyof IntegrationLifecycle>)
        .filter((name) => state[name])
        .join(', ');
      void showResultNotice('information', `UnodeAi Marketplace: ${entry.name} setup state: ${reached || 'listed'}. `
        + 'This check did not configure, approve, mount, exercise, or grant the integration.');
      return;
    }
    if (msg.command !== 'install') {
      return;
    }
    if (!isMarketplaceInstallAction(msg.action, this.catalog)) {
      void showResultNotice('warning', 'UnodeAi Marketplace: invalid install request.');
      return;
    }
    const action = msg.action;
    const reportToButton = (ok: boolean) => {
      const response: MarketplaceWebviewOutboundMessage = { command: 'installResult', kind: action.kind, entryId: action.entryId, ok };
      void this.panel.webview.postMessage(response);
    };
    void this.onInstall(action).then((result) => {
      if (result.ok) {
        void showResultNotice('information', `UnodeAi Marketplace: ${result.message}`);
      } else {
        void showResultNotice('warning', `UnodeAi Marketplace: ${result.message}`);
      }
      reportToButton(result.ok); // a cancelled/declined install reports ok:false → button shows "Retry"
      this.postViewState();
    }, (err) => {
      void showResultNotice('error', `UnodeAi Marketplace: install failed — ${String(err)}`);
      reportToButton(false);
    });
  }

  private dispose(): void {
    MarketplacePanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

async function loadBundledCatalog(extensionUri: vscode.Uri): Promise<MarketplaceCatalog> {
  const bundled: RawCatalog = {
    agents: roleTemplateCatalogEntries(),
    mcp: await readBundledJson(extensionUri, 'mcp'),
    skills: await readBundledJson(extensionUri, 'skills'),
  };
  // v0.6.1a: optionally merge a Roam-hosted catalog (off until a catalogUrl is configured). Each
  // section is parsed resiliently and a hosted-fetch failure falls back to the bundled set.
  const cfg = vscode.workspace.getConfiguration('unode');
  const url = readUnodeSetting(cfg, 'marketplace.catalogUrl', '').trim();
  const hosted = readUnodeSetting(cfg, 'marketplace.fetchCatalog', false) && url
    ? { url, timeoutMs: 5000, verify: { publicKeyPem: CATALOG_PUBLIC_KEY_PEM } }
    : undefined;
  const resolved = await resolveCatalog({
    bundled,
    hosted,
    warn: (m) => console.warn(`UnodeAi Marketplace: ${m}`),
  });
  return { ...resolved, agents: roleTemplateCatalogEntries() };
}

async function readBundledJson(extensionUri: vscode.Uri, name: CatalogSourceName): Promise<unknown> {
  const uri = vscode.Uri.joinPath(extensionUri, 'marketplace', `${name}.json`);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    console.warn(`UnodeAi Marketplace ${name}.json unavailable: ${String(err)}`);
    return [];
  }
}

export function isMarketplaceInstallAction(value: unknown, catalog: MarketplaceCatalog): value is RenderedMarketplaceInstallAction {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const action = value as Partial<MarketplaceInstallAction>;
  if (action.kind === 'agent') {
    return typeof action.entryId === 'string'
      && (action.target === 'current-team' || action.target === 'new-team')
      && catalog.agents.some((entry) => entry.id === action.entryId);
  }
  if (action.kind === 'mcp') {
    return typeof action.entryId === 'string'
      && (action.scope === 'extension' || action.scope === 'current-team')
      && catalog.mcp.some((entry) => entry.id === action.entryId);
  }
  return false;
}

export function renderMarketplaceHtml(
  webview: vscode.Webview,
  catalog: MarketplaceCatalog,
  initialTab: MarketplaceTab = 'agents',
  viewState: MarketplaceViewState = EMPTY_VIEW_STATE,
): string {
  const tab = asMarketplaceTab(initialTab);
  return renderWebviewDocument(webview, {
    title: 'UnodeAi Marketplace',
    styles: /* css */`
    body {
      margin: 0;
      padding: 18px;
    }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
    .tab {
      min-height: 30px;
      padding: 6px 12px;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .toolbar { margin-bottom: 12px; }
    .tab-action {
      display: flex;
      justify-content: flex-start;
      margin-bottom: 12px;
    }
    .search {
      width: min(460px, 100%);
      min-height: 28px;
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    .section { display: none; }
    .section.active { display: block; }
    .subsection-title { margin: 18px 0 8px; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .card {
      min-height: 150px;
      /* A flex item will not shrink below its content unless told to, and a catalog URL has no break
         opportunity — so a long source link ran out of the card and collided with the action row
         (Owner, 2026-08-19, the Everything reference server). Both halves are needed: the card must be
         allowed to shrink, and the text must be allowed to break. */
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-input-background);
    }
    .card-head { display: flex; align-items: flex-start; gap: 8px; }
    .icon { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
    .name { font-weight: 700; line-height: 1.25; }
    .summary { color: var(--vscode-descriptionForeground); line-height: 1.4; margin: 0; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; min-width: 0; overflow-wrap: anywhere; }
    .meta a { overflow-wrap: anywhere; }
    .lifecycle { display: flex; flex-wrap: wrap; gap: 4px; }
    .state { padding: 2px 5px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 11px; opacity: .65; }
    .state.done { opacity: 1; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .protocol { padding: 1px 5px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 10px; }
    .prerequisite { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; align-items: center; }
    .scope-note { flex: 1 1 100%; font-style: italic; }
    select {
      min-width: 0;
      flex: 1;
      min-height: 26px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
    }
    select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
    .btn {
      min-height: 26px;
      padding: 4px 10px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .empty {
      padding: 18px 0;
      color: var(--vscode-descriptionForeground);
    }
    a { color: var(--vscode-textLink-foreground); }
`,
    body: /* html */`
  <div class="topbar">
    <h1>Marketplace</h1>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab${tab === 'agents' ? ' active' : ''}" data-tab="agents" type="button">Agents</button>
    <button class="tab${tab === 'mcp' ? ' active' : ''}" data-tab="mcp" type="button">Integrations</button>
  </div>
  <div class="toolbar">
    <input class="search" type="search" placeholder="Search" aria-label="Search marketplace">
  </div>
  <section class="section${tab === 'agents' ? ' active' : ''}" id="agents">
    <div class="tab-action"><button class="btn" type="button" data-command="openAgentBuilder">Build an agent</button></div>
    <h2 class="subsection-title">Role Templates</h2>
    ${agentCards(catalog.agents, catalog.skills)}
    <h2 class="subsection-title">Your Agents</h2>
    <div data-marketplace-roster>${ownAgentCards(viewState.agents, catalog.agents)}</div>
  </section>
  <section class="section${tab === 'mcp' ? ' active' : ''}" id="mcp">
    <div class="tab-action"><button class="btn" type="button" data-command="addMcpServer">Add MCP server</button></div>
    <h2 class="subsection-title">Your integrations</h2>
    <div data-owned-integrations>${ownIntegrationCards(viewState.ownedIntegrations ?? [])}</div>
    <h2 class="subsection-title">Catalog</h2>
    ${mcpCards(catalog.mcp, viewState.integrations)}
  </section>
  `,
    script: /* js */`
    const vscode = acquireVsCodeApi();
    const search = document.querySelector('.search');
    let activeTab = '${tab}';

    function setTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node.dataset.tab === tab));
      document.querySelectorAll('.section').forEach((node) => node.classList.toggle('active', node.id === tab));
      filterCards();
    }

    function filterCards() {
      const q = (search.value || '').trim().toLowerCase();
      document.querySelectorAll('#' + activeTab + ' [data-search]').forEach((card) => {
        card.hidden = q !== '' && !card.dataset.search.includes(q);
      });
    }

    function installLabel(kind, card) {
      return kind === 'mcp'
        ? (card?.dataset.configured === 'true' ? 'Reconfigure' : 'Add configuration')
        : 'Add';
    }

    function applyViewState(message) {
      const roster = document.querySelector('[data-marketplace-roster]');
      if (roster && typeof message.agentsHtml === 'string') roster.innerHTML = message.agentsHtml;
      const owned = document.querySelector('[data-owned-integrations]');
      if (owned && typeof message.ownedIntegrationsHtml === 'string') owned.innerHTML = message.ownedIntegrationsHtml;
      const integrations = message.integrations || {};
      document.querySelectorAll('#mcp [data-entry-id]').forEach((card) => {
        const state = integrations[card.dataset.entryId] || {
          listed: true, configured: false, approved: false, mounted: false, exercised: false, succeeded: false,
        };
        card.dataset.configured = state.configured === true ? 'true' : 'false';
        card.querySelectorAll('[data-lifecycle-state]').forEach((chip) => {
          const name = chip.dataset.lifecycleState;
          const done = state[name] === true;
          chip.classList.toggle('done', done);
          chip.textContent = name + (done ? ' ✓' : '');
        });
        const button = card.querySelector('button[data-install-kind="mcp"]');
        if (button && button.dataset.feedback !== 'true') button.textContent = installLabel('mcp', card);
      });
      filterCards();
    }

    document.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab[data-tab]:not(:disabled)');
      if (tab) {
        setTab(tab.dataset.tab);
        return;
      }
      const commandButton = event.target.closest('button[data-command]');
      if (commandButton) {
        const command = commandButton.dataset.command;
        if (command === 'editAgent') {
          vscode.postMessage({ command, agentId: commandButton.dataset.agentId });
        } else if (command === 'removeIntegration') {
          vscode.postMessage({ command, serverId: commandButton.dataset.serverId });
        } else if (command === 'checkIntegration') {
          const card = commandButton.closest('[data-entry-id]');
          if (card) vscode.postMessage({ command, entryId: card.dataset.entryId });
        } else {
          vscode.postMessage({ command });
        }
        return;
      }
      const button = event.target.closest('button[data-install-kind]');
      if (!button || button.disabled) return;
      const card = button.closest('[data-entry-id]');
      if (!card) return;
      const kind = button.dataset.installKind;
      const entryId = card.dataset.entryId;
      let action;
      if (kind === 'agent') {
        const scope = card.querySelector('[data-scope]')?.value;
        if (!scope) return;
        action = { kind, entryId, target: scope };
      } else {
        action = { kind, entryId, scope: 'current-team' }; // MCP installs into the current team
      }
      // Reflect the real outcome (see 'installResult' below) instead of a blind timer: lock the button
      // while the host works, then show success/retry.
      button.disabled = true;
      button.dataset.feedback = 'true';
      button.textContent = kind === 'mcp' ? 'Adding configuration…' : 'Adding agent…';
      vscode.postMessage({ command: 'install', action });
    });
    search.addEventListener('input', filterCards);

    // The host replies with the true result for the exact card; update only that button.
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m) return;
      if (m.command === 'viewState') {
        applyViewState(m);
        return;
      }
      if (m.command !== 'installResult') return;
      const sectionId = m.kind === 'mcp' ? 'mcp' : 'agents';
      let btn = null;
      document.querySelectorAll('#' + sectionId + ' [data-entry-id]').forEach((c) => {
        if (c.dataset.entryId === m.entryId) btn = c.querySelector('button[data-install-kind]');
      });
      if (!btn) return;
      btn.disabled = false;
      btn.dataset.feedback = 'true';
      btn.textContent = m.ok ? (m.kind === 'mcp' ? 'Configured' : 'Added') : 'Retry';
      setTimeout(() => {
        delete btn.dataset.feedback;
        btn.textContent = installLabel(m.kind, btn.closest('[data-entry-id]'));
      }, 2200);
    });`,
  });
}

function agentCards(entries: AgentCatalogEntry[], skills: MarketplaceCatalog['skills']): string {
  if (entries.length === 0) {
    return '<div class="empty">No agent presets in the bundled catalog yet.</div>';
  }
  const skillNamesById = new Map(skills.map((skill) => [skill.id, skill.name]));
  return `<div class="grid">${[...entries].sort((a, b) => byDisplayName(a.name, b.name)).map((entry) => {
    const includedSkills = (entry.skills ?? [])
      .map((id) => skillNamesById.get(id))
      .filter((name): name is string => !!name);
    const includes = includedSkills.length > 0
      ? `<div class="meta includes">Includes: ${includedSkills.map(esc).join(', ')}</div>`
      : '';
    const suggestions = entry.suggestedMcpServers?.length
      ? `<div class="meta">Suggested integrations (not granted): ${entry.suggestedMcpServers.map(esc).join(', ')}</div>`
      : '';
    const search = searchText(entry.name, entry.summary, ...includedSkills, ...(entry.suggestedMcpServers ?? []));
    return /* html */`
      <article class="card" data-entry-id="${escAttr(entry.id)}" data-search="${escAttr(search)}">
        <div class="card-head">
          <span class="icon">${esc(entry.icon ?? 'A')}</span>
          <div>
            <div class="name">${esc(entry.name)}</div>
            <div class="meta">${esc(entry.role)} / ${esc(entry.tier)}</div>
          </div>
        </div>
        <p class="summary">${esc(entry.summary)}</p>
        <div class="meta">Model: ${esc(entry.model)}</div>
        ${includes}
        ${suggestions}
        <div class="actions">
          <select data-scope aria-label="Agent install target">
            <option value="current-team">Current team</option>
            <option value="new-team">New team</option>
          </select>
          <button class="btn" type="button" data-install-kind="agent">Add</button>
        </div>
      </article>`;
  }).join('')}</div>`;
}

function ownAgentCards(entries: MarketplaceRosterAgent[], templates: AgentCatalogEntry[]): string {
  if (entries.length === 0) {
    return '<div class="empty">No agents in the current roster.</div>';
  }
  const templateNames = new Map(templates.map((template) => [template.id, template.name]));
  return `<div class="grid">${[...entries].sort((a, b) => byDisplayName(a.name, b.name)).map((entry) => {
    const templateName = entry.roleTemplateKey ? templateNames.get(entry.roleTemplateKey) : undefined;
    const origin = templateName
      ? `Based on ${templateName} · ${entry.systemPromptSource === 'custom' ? 'custom instructions' : 'template instructions'}`
      : 'origin not recorded';
    return /* html */`
      <article class="card" data-search="${escAttr(searchText(entry.name, origin))}">
        <div class="card-head"><span class="icon">A</span><div><div class="name">${esc(entry.name)}</div><div class="meta">${esc(origin)}</div></div></div>
        <div class="actions">
          <button class="btn" type="button" data-command="editAgent" data-agent-id="${escAttr(entry.id)}">Open in Agent Builder</button>
        </div>
      </article>`;
  }).join('')}</div>`;
}

function mcpCards(entries: McpCatalogEntry[], lifecycle: Record<string, IntegrationLifecycle>): string {
  if (entries.length === 0) {
    return '<div class="empty">No MCP servers in the bundled catalog yet.</div>';
  }
  return `<div class="grid">${[...entries].sort((a, b) => byDisplayName(a.name, b.name)).map((entry) => {
    const source = entry.source ? sourceLink(entry.source) : '';
    const prerequisite = mcpPrerequisiteHint(entry);
    const search = searchText(entry.name, entry.summary);
    const states = lifecycle[entry.id] ?? {
      listed: true, configured: false, approved: false, mounted: false, exercised: false, succeeded: false,
    };
    const lifecycleHtml = (Object.keys(states) as Array<keyof IntegrationLifecycle>)
      .map((state) => `<span class="state${states[state] ? ' done' : ''}" data-lifecycle-state="${escAttr(state)}">${esc(state)}${states[state] ? ' ✓' : ''}</span>`)
      .join('');
    const approval = mcpApprovalClassification(entry) ? 'approval required' : 'no approval required';
    const effect = entry.transport === 'stdio' ? 'local process' : 'network endpoint';
    const credentials = Object.keys(entry.env ?? {});
    return /* html */`
      <article class="card" data-entry-id="${escAttr(entry.id)}" data-search="${escAttr(search)}" data-configured="${states.configured ? 'true' : 'false'}">
        <div class="card-head">
          <span class="icon">${esc(entry.icon ?? 'M')}</span>
          <div>
            <div class="name">${esc(entry.name)} <span class="protocol">MCP</span></div>
            <div class="meta">${esc(entry.transport)} / ${effect} / ${approval}${entry.urlPrompt ? ' / URL on configuration' : ''}</div>
          </div>
        </div>
        <p class="summary">${esc(entry.summary)}</p>
        ${prerequisite ? `<div class="meta prerequisite">&#9888; Requires ${esc(prerequisite)}</div>` : ''}
        ${credentials.length > 0 ? `<div class="meta">Credentials: ${credentials.map(esc).join(', ')}</div>` : ''}
        ${source ? `<div class="meta">${source}</div>` : ''}
        <div class="meta">${esc(entry.maintenanceState)} · verified ${esc(entry.lastVerified)}${isCatalogVerificationOverdue(entry.lastVerified) ? ' (verification overdue)' : ''} · ${esc(entry.installIdentity.ecosystem)}:${esc(entry.installIdentity.value)}</div>
        <div class="lifecycle" aria-label="Integration lifecycle">${lifecycleHtml}</div>
        <div class="actions">
          <span class="meta scope-note">Adds configuration to this team; grants no agent access</span>
          <button class="btn" type="button" data-command="checkIntegration">Check setup</button>
          <button class="btn" type="button" data-install-kind="mcp">${states.configured ? 'Reconfigure' : 'Add configuration'}</button>
        </div>
      </article>`;
  }).join('')}</div>`;
}

export function ownIntegrationCards(entries: NonNullable<MarketplaceViewState['ownedIntegrations']>): string {
  if (entries.length === 0) return '<div class="empty">No integrations configured for this workspace.</div>';
  return `<div class="grid">${[...entries].sort((a, b) => byDisplayName(a.name, b.name)).map((entry) => {
    const grants = entry.grantedAgents.length > 0 ? entry.grantedAgents.join(', ') : 'none';
    const reason = entry.reason ? `<div class="meta prerequisite">${esc(entry.reason)}</div>` : '';
    return `<article class="card" data-search="${escAttr(searchText(entry.name, entry.id, entry.connection, ...entry.grantedAgents))}">
      <div class="card-head"><span class="icon">M</span><div><div class="name">${esc(entry.name)} <span class="protocol">MCP</span></div>
      <div class="meta">Connection: ${esc(entry.connection)}</div></div></div>
      ${reason}<div class="meta">Granted agents: ${esc(grants)}</div>
      <div class="actions"><button class="btn" type="button" data-command="removeIntegration" data-server-id="${escAttr(entry.id)}">Remove</button></div>
    </article>`;
  }).join('')}</div>`;
}

/** The card and the mount gate consume this exact host-derived answer. */
export function mcpApprovalClassification(entry: McpCatalogEntry): boolean {
  return shouldRequireApproval(toMcpServerConfig(entry));
}

export function mcpPrerequisiteHint(entry: Pick<McpCatalogEntry, 'command' | 'prerequisite'>): string | undefined {
  if (entry.prerequisite) {
    return entry.prerequisite;
  }
  const command = entry.command?.toLowerCase();
  if (command === 'uvx' || command === 'uv') {
    return 'uv';
  }
  if (command === 'docker') {
    return 'Docker';
  }
  return undefined;
}

function sourceLink(raw: string): string {
  const href = sanitizeHref(raw);
  if (!href) {
    return `Source: ${esc(raw)}`;
  }
  return `Source: <a href="${escAttr(href)}">${esc(href)}</a>`;
}

function searchText(...parts: string[]): string {
  return parts.join(' ').toLowerCase().replace(/"/g, '&quot;');
}
