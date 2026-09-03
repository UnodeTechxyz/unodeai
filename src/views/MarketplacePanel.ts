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
} from '../marketplace/catalog';
import { RawCatalog, resolveCatalog, CATALOG_PUBLIC_KEY_PEM } from '../marketplace/catalogSource';
import { csp, esc, escAttr, nonce, sanitizeHref } from './webviewSecurity';
import { byDisplayName } from './displayOrder';

const EMPTY_CATALOG: MarketplaceCatalog = { agents: [], mcp: [], skills: [] };

/** The marketplace's top-level tabs; callers can deep-link straight to one (e.g. Settings → MCP). */
export type MarketplaceTab = 'agents' | 'mcp';
const MARKETPLACE_TABS: readonly MarketplaceTab[] = ['agents', 'mcp'];
export function asMarketplaceTab(value: unknown): MarketplaceTab {
  return MARKETPLACE_TABS.includes(value as MarketplaceTab) ? (value as MarketplaceTab) : 'agents';
}

/** Performs a chosen install and reports a user-facing result. Implemented in extension.ts (M4). */
export type MarketplaceInstallHandler = (action: MarketplaceInstallAction) => Promise<{ ok: boolean; message: string }>;

export class MarketplacePanel {
  public static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private catalog: MarketplaceCatalog = EMPTY_CATALOG;
  private initialTab: MarketplaceTab = 'agents';

  static createOrShow(extensionUri: vscode.Uri, onInstall: MarketplaceInstallHandler, initialTab: MarketplaceTab = 'agents'): void {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.onInstall = onInstall;
      MarketplacePanel.current.initialTab = initialTab;
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
    MarketplacePanel.current = new MarketplacePanel(panel, extensionUri, onInstall, initialTab);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private onInstall: MarketplaceInstallHandler,
    initialTab: MarketplaceTab = 'agents'
  ) {
    this.panel = panel;
    this.initialTab = initialTab;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    void this.render();
  }

  private async render(): Promise<void> {
    this.catalog = await loadBundledCatalog(this.extensionUri);
    this.panel.webview.html = renderMarketplaceHtml(this.panel.webview, this.catalog, this.initialTab);
  }

  private onMessage(msg: { command?: unknown; action?: unknown }): void {
    if (!msg || typeof msg.command !== 'string') {
      return;
    }
    if (msg.command === 'openAgentBuilder') {
      void vscode.commands.executeCommand('unode.openAgentBuilder');
      return;
    }
    if (msg.command === 'addMcpServer') {
      void vscode.commands.executeCommand('unode.addMcpServer');
      return;
    }
    if (msg.command !== 'install') {
      return;
    }
    if (!isMarketplaceInstallAction(msg.action, this.catalog)) {
      void vscode.window.showWarningMessage('UnodeAi Marketplace: invalid install request.');
      return;
    }
    const action = msg.action;
    const reportToButton = (ok: boolean) =>
      void this.panel.webview.postMessage({ command: 'installResult', kind: action.kind, entryId: action.entryId, ok });
    void this.onInstall(action).then((result) => {
      const show = result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void show(`UnodeAi Marketplace: ${result.message}`);
      reportToButton(result.ok); // a cancelled/declined install reports ok:false → button shows "Retry"
    }, (err) => {
      void vscode.window.showErrorMessage(`UnodeAi Marketplace: install failed — ${String(err)}`);
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
    agents: await readBundledJson(extensionUri, 'agents'),
    mcp: await readBundledJson(extensionUri, 'mcp'),
    skills: await readBundledJson(extensionUri, 'skills'),
  };
  // v0.6.1a: optionally merge a Roam-hosted catalog (off until a catalogUrl is configured). Each
  // section is parsed resiliently and a hosted-fetch failure falls back to the bundled set.
  const cfg = vscode.workspace.getConfiguration('unode');
  const url = cfg.get<string>('marketplace.catalogUrl', '').trim();
  const hosted = cfg.get<boolean>('marketplace.fetchCatalog', false) && url
    ? { url, timeoutMs: 5000, verify: { publicKeyPem: CATALOG_PUBLIC_KEY_PEM } }
    : undefined;
  return resolveCatalog({
    bundled,
    hosted,
    warn: (m) => console.warn(`UnodeAi Marketplace: ${m}`),
  });
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

export function isMarketplaceInstallAction(value: unknown, catalog: MarketplaceCatalog): value is MarketplaceInstallAction {
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

export function renderMarketplaceHtml(webview: vscode.Webview, catalog: MarketplaceCatalog, initialTab: MarketplaceTab = 'agents'): string {
  const scriptNonce = nonce();
  const tab = asMarketplaceTab(initialTab);
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Marketplace</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 18px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
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
    .prerequisite { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); font-weight: 600; }
    .actions { display: flex; gap: 6px; margin-top: auto; align-items: center; }
    .scope-note { flex: 1; font-style: italic; }
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
  </style>
</head>
<body>
  <div class="topbar">
    <h1>Marketplace</h1>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab${tab === 'agents' ? ' active' : ''}" data-tab="agents" type="button">Agents</button>
    <button class="tab${tab === 'mcp' ? ' active' : ''}" data-tab="mcp" type="button">MCP</button>
  </div>
  <div class="toolbar">
    <input class="search" type="search" placeholder="Search" aria-label="Search marketplace">
  </div>
  <section class="section${tab === 'agents' ? ' active' : ''}" id="agents">
    <div class="tab-action"><button class="btn" type="button" data-command="openAgentBuilder">Build an agent</button></div>
    ${agentCards(catalog.agents, catalog.skills)}
  </section>
  <section class="section${tab === 'mcp' ? ' active' : ''}" id="mcp">
    <div class="tab-action"><button class="btn" type="button" data-command="addMcpServer">Add MCP server</button></div>
    ${mcpCards(catalog.mcp)}
  </section>
  <script nonce="${scriptNonce}">
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

    document.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab[data-tab]:not(:disabled)');
      if (tab) {
        setTab(tab.dataset.tab);
        return;
      }
      const commandButton = event.target.closest('button[data-command]');
      if (commandButton) {
        vscode.postMessage({ command: commandButton.dataset.command });
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
      button.textContent = 'Installing…';
      vscode.postMessage({ command: 'install', action });
    });
    search.addEventListener('input', filterCards);

    // The host replies with the true result for the exact card; update only that button.
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || m.command !== 'installResult') return;
      const sectionId = m.kind === 'mcp' ? 'mcp' : 'agents';
      let btn = null;
      document.querySelectorAll('#' + sectionId + ' [data-entry-id]').forEach((c) => {
        if (c.dataset.entryId === m.entryId) btn = c.querySelector('button[data-install-kind]');
      });
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = m.ok ? 'Added ✓' : 'Retry';
      setTimeout(() => { btn.textContent = 'Add'; }, 2200);
    });
  </script>
</body>
</html>`;
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
    const search = searchText(entry.name, entry.summary, ...includedSkills);
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

function mcpCards(entries: McpCatalogEntry[]): string {
  if (entries.length === 0) {
    return '<div class="empty">No MCP servers in the bundled catalog yet.</div>';
  }
  return `<div class="grid">${[...entries].sort((a, b) => byDisplayName(a.name, b.name)).map((entry) => {
    const source = entry.source ? sourceLink(entry.source) : '';
    const prerequisite = mcpPrerequisiteHint(entry);
    const search = searchText(entry.name, entry.summary);
    return /* html */`
      <article class="card" data-entry-id="${escAttr(entry.id)}" data-search="${escAttr(search)}">
        <div class="card-head">
          <span class="icon">${esc(entry.icon ?? 'M')}</span>
          <div>
            <div class="name">${esc(entry.name)}</div>
            <div class="meta">${esc(entry.transport)}${entry.requiresApproval ? ' / approval' : ''}${entry.urlPrompt ? ' / URL on install' : ''}</div>
          </div>
        </div>
        <p class="summary">${esc(entry.summary)}</p>
        ${prerequisite ? `<div class="meta prerequisite">&#9888; Requires ${esc(prerequisite)}</div>` : ''}
        ${source ? `<div class="meta">${source}</div>` : ''}
        <div class="actions">
          <span class="meta scope-note">Adds to this team</span>
          <button class="btn" type="button" data-install-kind="mcp">Add</button>
        </div>
      </article>`;
  }).join('')}</div>`;
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
