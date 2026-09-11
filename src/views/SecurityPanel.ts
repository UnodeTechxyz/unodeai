/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SecurityPanel
 *  A one-screen, read-only summary of the extension's current security posture: Workspace Trust,
 *  network egress (which gateway hosts you've approved + catalog opt-in), shell-command and file-write
 *  approval modes, mounted MCP servers, and which providers have a key stored (never the value).
 *  Makes the safe-by-default behavior visible and auditable — and lets you revoke an approved egress host.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentBackendKind, FolderGrant } from '../types';
import { ConsentGrant, ConsentGrantKind, MediaConsentKind } from '../security/ConsentGrants';
import { nonce, csp, esc } from './webviewSecurity';

export interface SecuritySnapshot {
  workspaceTrusted: boolean;
  virtualWorkspace: boolean;
  /** unode.commandApproval: none | ask | allowlist | all */
  commandApproval: string;
  /** unode.writeApproval: none | ask */
  writeApproval: string;
  /** unode.concurrencyStrategy: optimistic | worktree */
  concurrencyStrategy: string;
  /** unode.marketplace.fetchCatalog — hosted-catalog network fetch opt-in */
  fetchCatalog: boolean;
  /**
   * The EFFECTIVE hosted-catalog state, from `describeHostedCatalogStatus` — the setting AND the bundled
   * signing key AND what the last attempt actually did.
   *
   * The panel used to render `fetchCatalog: true` as "Catalog fetch: ON". In the state this build ships in
   * (no signing key) the code refuses to make the request at all, so the panel told the user the opposite of
   * what the extension does. This screen is the one a user checks precisely because they do not want to read
   * the code; it must report behaviour, never intent. (Codex, v0.9.29 review.)
   */
  catalogStatus?: { text: string; ok: boolean };
  /** MODEL-egress grants — prompts + workspace files may go here, with provenance. */
  egressGrants: ConsentGrant[];
  /**
   * Hosts approved for METADATA ONLY — price list, discount tier, balance. No prompt, no code, ever.
   * Listed separately because showing them in the same list would tell the user their code may be sent to
   * a host they never approved for that. A weaker grant must never be displayed as a stronger one.
   */
  metadataGrants?: ConsentGrant[];
  /** Class-specific remote-media grants. A normal model or web grant never appears here. */
  mediaGrants?: ConsentGrant[];
  mcpServers: Array<{ id: string; name: string; ready: boolean; toolCount: number }>;
  agents?: Array<{
    id: string;
    name: string;
    backend?: AgentBackendKind;
    folderAccess?: FolderGrant[];
    mcpServers?: string[];
  }>;
  providers: Array<{ providerId: string; hasApiKey: boolean }>;
}

export interface SecurityPanelDeps {
  getState: () => Promise<SecuritySnapshot>;
  /** Registry-owned presentation label; raw ids remain available as titles for repair and support. */
  displayNameForProviderId?: (providerId: string) => string;
  /**
   * Forget ONE grant for a host (it will be re-prompted before the next request of that kind).
   *
   * `kind` is required because the two grants are genuinely different: a host may hold model-egress
   * (prompts + code) AND metadata (prices/balance), and revoking one must not silently revoke the other.
   * The first version took only a host and deleted both, which over-revoked and contradicted the promise
   * that they are separately revocable. (Codex, v0.9.29 review.)
   */
  revokeEgressHost: (host: string, kind: ConsentGrantKind, mediaKind?: MediaConsentKind) => void;
  openSettings: () => void;
}

export class SecurityPanel {
  private static current: SecurityPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(deps: SecurityPanelDeps): void {
    if (SecurityPanel.current) {
      SecurityPanel.current.panel.reveal();
      SecurityPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unode.security',
      'UnodeAi Security',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    SecurityPanel.current = new SecurityPanel(panel, deps);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly deps: SecurityPanelDeps) {
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    // Re-render when the user grants/revokes Workspace Trust while the panel is open.
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void this.render()));
    void this.render();
  }

  private onMessage(msg: { command?: string; host?: unknown; kind?: unknown; mediaKind?: unknown }): void {
    if (msg?.command === 'revokeEgress' && typeof msg.host === 'string') {
      // Default to 'model' — the stronger grant — if the webview somehow omits the kind. Over-revoking the
      // strong grant is the safe direction; silently keeping it would not be.
      const kind: ConsentGrantKind = msg.kind === 'metadata' ? 'metadata' : msg.kind === 'media' ? 'media' : 'model';
      const mediaKind: MediaConsentKind | undefined = msg.mediaKind === 'vision' || msg.mediaKind === 'transcription'
        ? msg.mediaKind
        : undefined;
      // A malformed media revoke must not broaden into a host-wide revocation.
      if (kind !== 'media' || mediaKind) {
        this.deps.revokeEgressHost(msg.host, kind, mediaKind);
      }
      void this.render();
    } else if (msg?.command === 'openSettings') {
      this.deps.openSettings();
    } else if (msg?.command === 'refresh') {
      void this.render();
    }
  }

  private async render(): Promise<void> {
    const scriptNonce = nonce();
    const state = await this.deps.getState();
    this.panel.webview.html = renderSecurityHtml(
      state,
      csp(this.panel.webview, scriptNonce),
      scriptNonce,
      this.deps.displayNameForProviderId,
    );
  }

  private dispose(): void {
    SecurityPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }

}

/** Pure renderer for the Security panel — no vscode dependency beyond the CSP string, so it's unit-testable. */
export function renderSecurityHtml(
  s: SecuritySnapshot,
  cspContent: string,
  scriptNonce: string,
  displayNameForProviderId: (providerId: string) => string = (providerId) => providerId,
): string {
    const warn = (t: string) => `<span class="badge warn">${esc(t)}</span>`;
    const good = (t: string) => `<span class="badge ok">${esc(t)}</span>`;

    const trustRow = s.workspaceTrusted
      ? good('Trusted')
      : warn('Untrusted — read-only');
    const trustDetail = s.workspaceTrusted
      ? 'Agents may run commands, write files, and use MCP servers (still subject to the approvals below).'
      : 'Read-only mode: shell commands, file writes/edits/deletes, MCP servers, and the verify command are ALL disabled until you trust this workspace.';

    const cmd = s.commandApproval;
    const cmdBadge = cmd === 'ask' ? good('Ask each (default)')
      : cmd === 'none' ? good('Disabled')
      : cmd === 'allowlist' ? good('Allowlist only')
      : warn('All allowed (dangerous)');
    const writeBadge = s.writeApproval === 'ask' ? good('Diff approval') : good('Checkpointed');
    // Report what the code DOES, not what the setting says. With no signing key bundled — the state this
    // build ships in — `fetchCatalog: true` still fetches nothing, so "Catalog fetch: ON" was a false badge.
    const catalog = s.catalogStatus ?? {
      text: s.fetchCatalog ? 'Hosted catalog enabled.' : 'Hosted catalog off — bundled catalog only.',
      ok: true,
    };
    const netBadge = catalog.ok ? good('No unapproved network') : warn('Catalog unverified');

    // Model egress (prompts + code) and metadata (prices/balance/models) are DIFFERENT grants, so they get
    // one row EACH — including when the same host holds both. Collapsing a dual-granted host into a single
    // row hid the metadata grant and made the one visible "revoke" delete both, which over-revoked and broke
    // the promise that the two are separately revocable. Every row states what it actually permits, so this
    // list can never be read as "my code goes to all of these".
    const grants: Array<ConsentGrant & { kind: ConsentGrantKind; what: string }> = [
      ...s.egressGrants.map((grant) => ({ ...grant, kind: 'model' as const, what: 'prompts + workspace files' })),
      ...(s.metadataGrants ?? []).map((grant) => ({
        ...grant, kind: 'metadata' as const, what: 'prices, balance &amp; model list only — no code is sent',
      })),
      ...(s.mediaGrants ?? []).map((grant) => ({
        ...grant,
        kind: 'media' as const,
        what: `${grant.mediaKind ?? 'media'} upload only — separate from prompts, code &amp; public downloads`,
      })),
    ];
    const egressList = grants.length
      ? grants.map(({ host, kind, what, grantedAt, requester, mediaKind }) =>
        `<li><code>${esc(host)}</code> <span class="muted">${what}</span> `
        + `<div class="provenance muted">${grantProvenance(grantedAt, requester)}</div>`
        + `<button class="link" data-revoke="${esc(host)}" data-kind="${kind}"${mediaKind ? ` data-media-kind="${mediaKind}"` : ''}>revoke</button></li>`).join('')
      : '<li class="muted">No gateway approved yet — you\'ll be asked before anything is sent.</li>';

    const mcpList = s.mcpServers.length
      ? s.mcpServers.map((m) => `<li><code>${esc(m.name)}</code> — ${m.ready ? good('mounted') : warn('not ready')} <span class="muted">${m.toolCount} tool(s)</span></li>`).join('')
      : '<li class="muted">No MCP servers mounted (default-deny; each requires approval).</li>';

    const agentAccessList = s.agents?.length
      ? s.agents.map((agent) => {
        const folders = agent.backend === 'codex'
          ? '<span class="muted">Folder grants do not limit Codex reads. This agent can read any file your user account can read; its read-only sandbox prevents writes only.</span>'
          : agent.folderAccess?.length
          ? agent.folderAccess.map((grant) => `<span class="grant ${grant.permission === 'readwrite' ? 'write' : ''}">${esc(grant.permission === 'readwrite' ? 'Read+Write' : 'Read')}: <code>${esc(grant.path)}</code></span>`).join('')
          : '<span class="muted">Workspace default</span>';
        const mcps = agent.mcpServers?.length
          ? agent.mcpServers.map((id) => `<code>${esc(id)}</code>`).join(' ')
          : '<span class="muted">No agent MCP grants</span>';
        return `<li class="agent-access">
          <div class="row"><strong>${esc(agent.name)}</strong> <span class="muted">${esc(agent.backend ?? 'default')}</span></div>
          <div class="grant-grid"><div><span class="muted">Folders</span><div>${folders}</div></div><div><span class="muted">MCP</span><div>${mcps}</div></div></div>
        </li>`;
      }).join('')
      : '<li class="muted">No agents configured.</li>';

    const provList = s.providers.length
      ? s.providers.map((p) => `<li><code title="${esc(p.providerId)}">${esc(displayNameForProviderId(p.providerId))}</code> — ${p.hasApiKey ? good('key set') : '<span class="muted">no key</span>'}</li>`).join('')
      : '<li class="muted">No providers configured.</li>';

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${cspContent}">
<style>
  body { font: var(--vscode-font-size)/1.5 var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h1 { font-size: 1.25rem; margin: 0 0 2px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 18px; font-size: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; margin: 0 0 12px; }
  .card h2 { font-size: .95rem; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; }
  .card p { margin: 4px 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin: 3px 0; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px; }
  .badge.ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 22%, transparent); color: var(--vscode-testing-iconPassed, #3fb950); }
  .badge.warn { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 22%, transparent); color: var(--vscode-editorWarning-foreground, #d29922); }
  .muted { color: var(--vscode-descriptionForeground); }
  .provenance { font-size: 11px; margin: 1px 0 2px; }
  .agent-access { list-style: none; margin: 8px 0; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .grant-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 6px; }
  .grant { display: inline-block; margin: 3px 5px 3px 0; font-size: 12px; }
  .grant.write { font-weight: 600; }
  button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0 0 0 6px; text-decoration: underline; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .actions { margin-top: 14px; }
  button.btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
  button.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style></head>
<body>
  <h1>🛡️ UnodeAi Security</h1>
  <p class="sub">Locked down by default — a live view of what's allowed, what's gated, and where data can go.</p>

  <div class="card">
    <h2>Workspace Trust ${trustRow}</h2>
    <p>${esc(trustDetail)}</p>
    ${s.virtualWorkspace ? '<p>⚠️ Virtual workspace — UnodeAi needs a real filesystem + git and is unsupported here.</p>' : ''}
  </div>

  <div class="card">
    <h2>Network egress ${netBadge}</h2>
    <p>Nothing is sent to a provider until you approve its host. Approved gateways:</p>
    <ul id="egress">${egressList}</ul>
    <p>${esc(catalog.text)}</p>
  </div>

  <div class="card">
    <h2>Execution &amp; writes</h2>
    <p class="row"><span>Shell commands (<code>unode.commandApproval</code>)</span> ${cmdBadge}</p>
    <p class="row"><span>File writes (<code>unode.writeApproval</code>)</span> ${writeBadge}</p>
    <p class="row"><span>Concurrency</span> ${good(esc(s.concurrencyStrategy))}</p>
    <p>Plan mode removes write/run/delegate/MCP tools at the tool layer — analysis can't mutate anything.</p>
  </div>

  <div class="card">
    <h2>MCP servers <span class="badge ok">default-deny</span></h2>
    <ul>${mcpList}</ul>
  </div>

  <div class="card">
    <h2>Agent grants <span class="badge ok">explicit</span></h2>
    <p>Folder scopes and MCP grants are reviewed per agent. MCP tools may access their own external systems outside the folder sandbox.</p>
    <ul class="agent-list">${agentAccessList}</ul>
  </div>

  <div class="card">
    <h2>Provider keys <span class="badge ok">SecretStorage</span></h2>
    <p>Keys live in VS Code SecretStorage — never on disk, in settings, or in exports. Values are never shown.</p>
    <ul>${provList}</ul>
  </div>

  <div class="actions">
    <button class="btn" id="openSettings">Open Settings</button>
    <button class="btn" id="refresh">Refresh</button>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-revoke]').forEach((b) =>
      b.addEventListener('click', () => vscode.postMessage({
        command: 'revokeEgress',
        host: b.getAttribute('data-revoke'),
        kind: b.getAttribute('data-kind'),
        mediaKind: b.getAttribute('data-media-kind'),
      })));
    document.getElementById('openSettings').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  </script>
</body></html>`;
}

function grantProvenance(grantedAt: string | undefined, requester: string | undefined): string {
  const when = grantedAt
    ? `Granted ${esc(grantedAt.replace('T', ' ').replace(/Z$/, ' UTC'))}`
    : 'Granted before 0.9.35 — date unknown';
  const why = requester ? `Requested by ${esc(requester)}` : 'Requester unknown (legacy grant)';
  return `${when} · ${why}`;
}
