import * as vscode from 'vscode';
import { DemoTask } from '../state/DemoTasks';
import { BUILTIN_CONNECTION_REGISTRY, CONNECTION_SETUP_GROUPS, ConnectionResolver } from '../routes/ConnectionRegistry';
import type { ConnectionKind, ConnectionProfile } from '../routes/RouteContracts';
import { stableProviderSort } from '../routes/stableProviderSort';
import { csp, nonce, sanitizeHref } from './webviewSecurity';

const PRICING_URL = 'https://www.unodetech.xyz/pricing?lang=en';
const ADD_CUSTOM_GATEWAY_OPTION = '__unode_add_custom_gateway__';

export interface OnboardingDeps {
  getCurrentConnectionId: () => string;
  saveProvider: (connectionId: string, apiKey: string | undefined) => Promise<void>;
  /**
   * Returns how many agents the flow actually created. The host path opens a native preset picker
   * (D1), and a picker can be dismissed — so "I ran the command" is not "a team exists", and the
   * wizard's status must be derived from this count, never assumed. That assumption is exactly how
   * the wizard once said "Quick Start team created." to a user with no team (Owner, 2026-07-30).
   */
  createQuickStartTeam: () => Promise<number>;
  /** True when a Solo agent is actually ready afterwards — the create dialog can be cancelled. */
  createSolo: () => Promise<boolean>;
  createCustomAgent: () => Promise<void>;
  runDemoTask: (taskId: string) => Promise<void>;
  complete: () => Promise<void>;
  openCommand: (command: string) => Promise<void>;
  openExternal: (href: string) => Promise<void>;
  /** User-initiated only: expose the selected connection's setup action without executing it. */
  openConnectionSetup: (connectionId: string) => Promise<void>;
  /** Native host-only flow; returns the newly created opaque profile id or undefined on cancel. */
  addCustomGateway: () => Promise<string | undefined>;
  /** Current host-owned snapshot; it may change while the retained webview is open. */
  connectionResolver?: () => ConnectionResolver;
  demoTasks: DemoTask[];
}

type WizardMessage =
  | { command: 'saveProvider'; apiKey?: unknown; connectionId?: unknown }
  | { command: 'addCustomGateway' }
  | { command: 'openConnectionSetup'; connectionId?: unknown }
  | { command: 'createTeam'; mode?: unknown }
  | { command: 'runDemo'; taskId?: unknown }
  | { command: 'finish' | 'skip' }
  | { command: 'openCommand'; target?: unknown }
  | { command: 'openExternal'; href?: unknown };

type WizardConnection = Pick<ConnectionProfile, 'id' | 'authKind' | 'catalogKind' | 'presentation' | 'availability' | 'availabilityMessage'> & {
  capabilitySummary: string;
};

type WizardConnectionGroup = {
  kind: ConnectionKind;
  displayName: string;
  description: string;
  connections: WizardConnection[];
};

function wizardConnectionGroups(resolver: ConnectionResolver): WizardConnectionGroup[] {
  return CONNECTION_SETUP_GROUPS.map((group) => ({
    ...group,
    connections: stableProviderSort(resolver.profiles
      .filter((profile) => profile.kind === group.kind)
      .map((profile) => ({
        id: profile.id,
        authKind: profile.authKind,
        catalogKind: profile.catalogKind,
        availability: profile.availability,
        availabilityMessage: profile.availabilityMessage,
        presentation: profile.presentation,
        capabilitySummary: capabilitySummary(profile),
      })), (profile) => profile.id),
  }));
}

function currentResolver(deps: OnboardingDeps): ConnectionResolver {
  return deps.connectionResolver?.() ?? BUILTIN_CONNECTION_REGISTRY;
}

function capabilitySummary(profile: ConnectionProfile): string {
  const c = profile.capabilities;
  const command = c.command
    ? `commands use ${c.commandApproval}`
    : 'commands are unavailable';
  return `Plan ${c.plan ? 'available' : 'unavailable'}; Act ${c.act ? 'available' : 'unavailable'}; ` +
    `read ${c.read ? 'available' : 'unavailable'}; write ${c.write ? 'available' : 'unavailable'}; ${command}.`;
}

function wizardConnection(connectionId: unknown, resolver: ConnectionResolver): WizardConnection | undefined {
  if (typeof connectionId !== 'string') { return undefined; }
  return wizardConnectionGroups(resolver).flatMap((group) => group.connections).find((item) => item.id === connectionId);
}

export class OnboardingWizard {
  public static current: OnboardingWizard | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** Preserve a host-confirmed selection across registry-driven panel refreshes. */
  private selectedConnectionId: string;

  static createOrShow(extensionUri: vscode.Uri, deps: OnboardingDeps): void {
    if (OnboardingWizard.current) {
      OnboardingWizard.current.panel.reveal(vscode.ViewColumn.Active);
      OnboardingWizard.current.postInitialData();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeOnboarding',
      'UnodeAi Setup',
      // Open as a normal tab in the active editor group (not a forced split into column one).
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    OnboardingWizard.current = new OnboardingWizard(panel, deps);
  }

  /** Registry changes are host-originated and safe to re-render from the current dependency snapshot. */
  static refreshCurrent(): void {
    OnboardingWizard.current?.postInitialData();
  }

  private constructor(panel: vscode.WebviewPanel, private deps: OnboardingDeps) {
    this.panel = panel;
    this.selectedConnectionId = this.deps.getCurrentConnectionId();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg as WizardMessage), null, this.disposables);
    this.panel.webview.html = this.html();
  }

  private async onMessage(msg: WizardMessage): Promise<void> {
    if (!msg || typeof msg.command !== 'string') {
      return;
    }
    try {
      switch (msg.command) {
        case 'saveProvider': {
          const connection = wizardConnection(msg.connectionId, currentResolver(this.deps));
          if (!connection) { return; }
          if (connection.availability !== 'available') {
            this.postStatus(connection.availabilityMessage ?? 'This connection is not available in this release.', true);
            return;
          }
          await this.deps.saveProvider(
            connection.id,
            typeof msg.apiKey === 'string' && msg.apiKey.trim() ? msg.apiKey.trim() : undefined,
          );
          this.postStatus(connection.authKind === 'api-key'
            ? `${connection.presentation.displayName} settings saved.`
            : `${connection.presentation.displayName} selected. UnodeAi will use its logged-in CLI.`);
          break;
        }
        case 'addCustomGateway': {
          // The webview trigger carries no profile fields or credential. The native host flow owns
          // name, endpoint, and masked-key collection, then returns only the opaque connection id.
          const connectionId = await this.deps.addCustomGateway();
          if (!connectionId) { return; }
          const connection = wizardConnection(connectionId, currentResolver(this.deps));
          if (!connection || !connection.id.startsWith('custom:')) {
            throw new Error('The newly added custom gateway was not available after the registry reload.');
          }
          this.postInitialData(connection.id);
          this.postStatus(`${connection.presentation.displayName} added and selected.`);
          break;
        }
        case 'createTeam':
          // Every branch reports what HAPPENED, not what was attempted. The team path opens a native
          // picker over this webview; dismissing it (or clicking back into the wizard, which closes a
          // QuickPick) creates nothing — and a success message on that path sends the user through the
          // rest of setup believing a team exists (Owner hit exactly this, 2026-07-30).
          if (msg.mode === 'solo') {
            if (await this.deps.createSolo()) {
              this.postStatus('Solo agent ready — opening chat.');
            } else {
              this.postStatus('Solo setup was cancelled — nothing was created. Choose Solo to try again.', true);
            }
          } else if (msg.mode === 'custom') {
            await this.deps.createCustomAgent();
            this.postStatus('Custom agent flow opened.');
          } else {
            const created = await this.deps.createQuickStartTeam();
            if (created > 0) {
              this.postStatus(`Team created — ${created} agents on the roster.`);
            } else {
              this.postStatus('No team was created — the team picker closed without a choice. Choose Team to pick again.', true);
            }
          }
          break;
        case 'runDemo':
          if (typeof msg.taskId === 'string') {
            await this.deps.runDemoTask(msg.taskId);
            this.postStatus('Demo task sent to the Project Manager.');
          }
          break;
        case 'openCommand':
          if (typeof msg.target === 'string' && allowedWizardCommand(msg.target)) {
            await this.deps.openCommand(msg.target);
          }
          break;
        case 'openExternal':
          if (typeof msg.href === 'string') {
            const href = sanitizeHref(msg.href);
            if (href) {
              await this.deps.openExternal(href);
            }
          }
          break;
        case 'openConnectionSetup': {
          const connection = wizardConnection(msg.connectionId, currentResolver(this.deps));
          if (!connection || connection.presentation.setup.kind !== 'cli') { return; }
          if (connection.availability !== 'available') {
            this.postStatus(connection.availabilityMessage ?? 'This connection is not available in this release.', true);
            return;
          }
          await this.deps.openConnectionSetup(connection.id);
          this.postStatus(`Opened setup for ${connection.presentation.displayName}. Run: ${connection.presentation.setup.loginCommand}.`);
          break;
        }
        case 'finish':
        case 'skip':
          await this.deps.complete();
          this.panel.dispose();
          break;
      }
    } catch (err) {
      this.postStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  private postInitialData(currentConnectionId = this.selectedConnectionId): void {
    this.selectedConnectionId = currentConnectionId;
    void this.panel.webview.postMessage({
      command: 'initialData',
      currentConnectionId,
      pricingUrl: sanitizeHref(PRICING_URL) ?? PRICING_URL,
      demoTasks: this.deps.demoTasks.slice(0, 3),
      connectionGroups: wizardConnectionGroups(currentResolver(this.deps)),
    });
  }

  private postStatus(text: string, isError = false): void {
    void this.panel.webview.postMessage({ command: 'status', text, isError });
  }

  private dispose(): void {
    OnboardingWizard.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  private html(): string {
    const scriptNonce = nonce();
    const initial = safeJson({
      currentConnectionId: this.selectedConnectionId,
      pricingUrl: sanitizeHref(PRICING_URL) ?? PRICING_URL,
      demoTasks: this.deps.demoTasks.slice(0, 3),
      connectionGroups: wizardConnectionGroups(currentResolver(this.deps)),
    });
    const addCustomGatewayOption = safeJson(ADD_CUSTOM_GATEWAY_OPTION);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(this.panel.webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Setup</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
    }
    .shell { min-height: 100vh; display: grid; grid-template-rows: 1fr auto; }
    main { width: min(760px, calc(100vw - 40px)); margin: 0 auto; padding: 42px 0 24px; }
    section { display: none; }
    section.active { display: block; }
    h1 { font-size: 26px; margin: 0 0 8px; letter-spacing: 0; }
    h2 { font-size: 20px; margin: 0 0 8px; letter-spacing: 0; }
    p { line-height: 1.55; }
    .lead { color: var(--vscode-descriptionForeground); font-size: 14px; margin: 0 0 22px; }
    .safety { list-style: none; padding: 0; margin: 0 0 14px; display: flex; flex-direction: column; gap: 10px; }
    .safety li { position: relative; padding-left: 26px; font-size: 13px; line-height: 1.45; }
    .safety li::before { content: "✓"; position: absolute; left: 0; top: 0; font-weight: 700; color: var(--vscode-testing-iconPassed, #3fb950); }
    .safety b { font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .card {
      position: relative;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-input-background);
      border-radius: 8px;
      padding: 14px;
      cursor: pointer;
      min-height: 118px;
    }
    .card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .card.selected {
      border-color: var(--vscode-charts-yellow, #f5c542);
      background: rgba(245, 197, 66, 0.16);
      color: var(--vscode-foreground);
      box-shadow: inset 3px 0 0 var(--vscode-charts-yellow, #f5c542), 0 0 0 1px var(--vscode-charts-yellow, #f5c542);
    }
    .card.selected .card-text {
      color: var(--vscode-foreground);
    }
    /* Solo ⚡: muted until its card is selected, then a glowing yellow bolt. */
    .card .zap { filter: grayscale(0.7); opacity: 0.7; transition: filter 0.15s ease, opacity 0.15s ease; }
    .card.selected .zap {
      filter: drop-shadow(0 0 4px var(--vscode-charts-yellow, gold)) drop-shadow(0 0 9px var(--vscode-charts-yellow, gold)) brightness(1.15);
      opacity: 1;
    }
    .card-title { font-weight: 700; margin-bottom: 6px; }
    .card-text { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
    label { display: block; font-weight: 600; margin: 14px 0 5px; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      max-width: 560px;
      display: block;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 8px;
    }
    .connection-summary { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .connection-route { text-align: left; }
    .connection-route[aria-pressed="true"] { border-color: var(--vscode-focusBorder); box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
    .radio-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 4px; }
    .radio-row label { margin: 0; font-weight: 500; display: flex; align-items: center; gap: 6px; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status { min-height: 18px; margin-top: 14px; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
    footer {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px 20px;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      background: var(--vscode-sideBar-background);
    }
    .dots { display: flex; gap: 6px; align-items: center; }
    /* The safety promises were a screen of their own that asked for no decision. They are true whether or
       not anyone reads them, so they belong where someone can choose to read them. */
    .safety-note { margin-top: 14px; }
    .safety-note > summary { cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); }
    .safety-note > summary:hover { color: var(--vscode-foreground); }
    .safety-note[open] > summary { margin-bottom: 8px; color: var(--vscode-foreground); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.45; }
    .dot.active { opacity: 1; background: var(--vscode-focusBorder); }
    .actions { display: flex; gap: 8px; }
    button {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 7px 12px;
      cursor: pointer;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.primary { border: none; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.ghost { background: transparent; color: var(--vscode-foreground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    button:disabled { opacity: 0.45; cursor: default; }
  </style>
</head>
<body>
  <div class="shell">
    <main>
      <section class="active" data-step="0">
        <h1>Welcome to UnodeAi</h1>
        <p class="lead">AI agents that work together, right in VS Code. Setup is three steps.</p>
        <h2>Connect a model</h2>
        <p class="lead">Choose a connection first, then select a model available on that connection.</p>
        <div id="connection-routes" class="grid" aria-label="Connection type"></div>
        <div id="compat-fields">
          <label for="connection-id">Connection / Pay through</label>
          <select id="connection-id" aria-label="OpenAI-compatible connection"></select>
          <div id="connection-summary" class="connection-summary"></div>
          <div id="api-key-fields">
            <label for="api-key">API Key</label>
            <input id="api-key" type="password" autocomplete="off" placeholder="Paste your key or skip for now">
          </div>
          <p><a id="pricing-link" href="#">Browse models &amp; pricing</a></p>
        </div>
        <div id="headless-note" style="display:none">
          <p id="headless-summary" class="lead" style="margin:12px 0 0"></p>
        </div>
        <div class="row" style="gap:8px; align-items:center">
          <button data-action="saveProvider" id="saveConnectionBtn">Save Connection</button>
          <button data-action="openConnectionSetup" id="openConnectionSetupBtn" class="ghost" style="display:none" title="Open a terminal with the connection's login command pre-filled">Set up connection</button>
        </div>
      </section>

      <section data-step="1">
        <h2>How do you want to work?</h2>
        <p class="lead">Solo is one fast agent for everyday asks. Team is a PM-led crew with an independent review gate for complex, multi-file work. You can switch or add more anytime.</p>
        <div class="grid" id="team-options">
          <button class="card selected" data-team-mode="solo" type="button">
            <div class="card-title"><span class="zap">⚡</span> Solo — one agent, fast</div>
            <p class="card-text">A single full-stack agent that codes the whole task itself (read → edit → run → verify). Best for simple/everyday work.</p>
          </button>
          <button class="card" data-team-mode="quick" type="button">
            <div class="card-title">👥 Team — PM + specialists + review</div>
            <p class="card-text">PM + Architect + Developer + Reviewer. Best for complex, multi-file work that wants an independent review gate.</p>
          </button>
          <button class="card" data-team-mode="custom" type="button">
            <div class="card-title">Custom</div>
            <p class="card-text">Open the standard Add Agent flow.</p>
          </button>
        </div>
        <details class="safety-note">
          <summary>Safe by default — what is already protecting you</summary>
          <ul class="safety">
          <li><b>Commands ask first.</b> An agent can't run a shell command without your approval (ask / deny by default).</li>
          <li><b>Untrusted workspaces are read-only.</b> Open an unfamiliar repo and nothing runs, writes, edits, or mounts until you trust it.</li>
          <li><b>No network until you approve it.</b> Before an agent sends your prompt or code, you approve the destination gateway — once per host.</li>
          <li><b>MCP servers are default-deny.</b> Each external tool server needs your approval before it can mount.</li>
          <li><b>Keys stay in SecretStorage.</b> API keys never touch disk, settings, or exports — and their values are never shown.</li>
        </ul>
          <button class="card" data-open-command="unode.showSecurity" type="button" style="margin-top:6px"><div class="card-title">🛡️ Open the Security panel</div><p class="card-text">See and manage all of this anytime — approved gateways, trust state, approval modes, and keys.</p></button>
        </details>
      </section>

      <section data-step="2">
        <h2>Ready to work</h2>
        <p class="lead">The Workbench is where you give a team a task and follow its work. Finish opens it when your team is ready; otherwise we will take you to create one.</p>
        <div class="grid">
          <button class="card" data-open-command="unode.openWorkbench" type="button"><div class="card-title">Open Workbench</div><p class="card-text">Give your selected agent a task and follow its progress in the Workbench.</p></button>
        </div>
        <p class="lead" style="margin-top:14px">Or try it first — one demo task through the normal message path.</p>
        <div class="grid" id="demo-grid"></div>
        <button class="primary" data-action="finish" style="margin-top:14px">Finish and continue</button>
      </section>
      <div id="status" class="status" role="status"></div>
    </main>
    <footer>
      <div class="dots" id="dots" aria-label="Setup progress"></div>
      <div class="actions">
        <button data-action="back">Back</button>
        <button data-action="skip" title="Close setup without configuring anything. You can run the wizard again from the Command Palette.">Skip setup</button>
        <button class="primary" data-action="next">Next</button>
      </div>
    </footer>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const initial = ${initial};
    const addCustomGatewayOption = ${addCustomGatewayOption};
    let step = 0;
    let teamMode = 'solo';
    // Three steps: connect, choose how you work, start. The wizard used to have six — a welcome screen
    // listing the other five, an optional demo on a screen of its own, and a safety screen the user had to
    // pass through to reach the end. None of them asked for a decision.
    const maxStep = 2;
    const sections = Array.from(document.querySelectorAll('section[data-step]'));
    const dots = document.getElementById('dots');
    const statusEl = document.getElementById('status');
    const nextButton = document.querySelector('button[data-action="next"]');
    const backButton = document.querySelector('button[data-action="back"]');
    const apiKey = document.getElementById('api-key');
    const pricingLink = document.getElementById('pricing-link');
    pricingLink.href = initial.pricingUrl || '#';

    // The three setup doors and their copy come from the host's connection registry. The webview may
    // choose only a registry id; the host validates it again before it changes any setting.
    const compatFields = document.getElementById('compat-fields');
    const headlessNote = document.getElementById('headless-note');
    const headlessSummary = document.getElementById('headless-summary');
    const connectionRoutes = document.getElementById('connection-routes');
    const connectionSelector = document.getElementById('connection-id');
    const connectionSummary = document.getElementById('connection-summary');
    const openConnectionSetupBtn = document.getElementById('openConnectionSetupBtn');
    const saveConnectionBtn = document.getElementById('saveConnectionBtn');
    const apiKeyFields = document.getElementById('api-key-fields');
    let connectionGroups = Array.isArray(initial.connectionGroups) ? initial.connectionGroups : [];
    let selectedConnectionId = initial.currentConnectionId || 'unode';
    let selectedRouteKind = (connectionGroups.find((group) => (group.connections || [])
      .some((connection) => connection.id === selectedConnectionId)) || {}).kind || 'openai-compatible';

    function selectedGroup() {
      return connectionGroups.find((group) => group.kind === selectedRouteKind) || connectionGroups[0];
    }
    function selectedConnection() {
      const group = selectedGroup();
      return group && (group.connections || []).find((connection) => connection.id === selectedConnectionId);
    }
    function renderConnectionRoutes() {
      connectionRoutes.replaceChildren();
      connectionGroups.forEach((group) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card connection-route';
        button.dataset.routeKind = group.kind;
        const isAvailable = (group.connections || []).some((connection) => connection.availability === 'available');
        button.disabled = !isAvailable;
        button.setAttribute('aria-pressed', String(group.kind === selectedRouteKind));
        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = group.displayName + (isAvailable ? '' : ' — Coming soon');
        const description = document.createElement('p');
        description.className = 'card-text';
        description.textContent = group.description;
        button.append(title, description);
        (group.connections || []).forEach((connection) => {
          const detail = document.createElement('p');
          detail.className = 'card-text';
          detail.textContent = connection.presentation.runtimeLabel + ' · ' + connection.presentation.billingLabel;
          button.appendChild(detail);
        });
        connectionRoutes.appendChild(button);
      });
    }
    function syncConnection() {
      const group = selectedGroup();
      if (!group) { return; }
      const connections = group.connections || [];
      if (!connections.some((connection) => connection.id === selectedConnectionId)) {
        selectedConnectionId = connections[0] ? connections[0].id : '';
      }
      const connection = selectedConnection();
      const isAvailable = connection?.availability === 'available';
      const isCompatible = group.kind === 'openai-compatible';
      const isCustomGateway = selectedConnectionId.startsWith('custom:');
      compatFields.style.display = isCompatible ? '' : 'none';
      apiKeyFields.style.display = isCompatible && !isCustomGateway ? '' : 'none';
      headlessNote.style.display = isCompatible ? 'none' : '';
      openConnectionSetupBtn.style.display = isCompatible ? 'none' : '';
      saveConnectionBtn.disabled = !isAvailable;
      openConnectionSetupBtn.disabled = !isAvailable;
      connectionSelector.replaceChildren();
      connections.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.presentation.displayName;
        option.selected = item.id === selectedConnectionId;
        connectionSelector.appendChild(option);
      });
      if (group.kind === 'openai-compatible') {
        const addCustomGateway = document.createElement('option');
        addCustomGateway.value = addCustomGatewayOption;
        addCustomGateway.textContent = '＋ Add custom gateway…';
        connectionSelector.appendChild(addCustomGateway);
      }
      if (!connection) { return; }
      const summary = isAvailable
        ? 'Runtime: ' + connection.presentation.runtimeLabel + '. Billing: ' +
          connection.presentation.billingLabel + '. Endpoint: ' +
          (connection.presentation.endpointDefault || 'local CLI account') + '. ' + connection.presentation.privacySummary
        : (connection.availabilityMessage || 'This connection is coming soon and is not available in this release.');
      connectionSummary.textContent = summary;
      if (!isCompatible) {
        const setup = connection.presentation.setup;
        headlessSummary.textContent = isAvailable
          ? summary + ' Install: ' + setup.installCommand + '. Sign in: ' +
            setup.loginCommand + '. ' + (setup.requiredSetting ? 'Required setting: ' + setup.requiredSetting + '. ' : '') +
            connection.capabilitySummary
          : summary;
        openConnectionSetupBtn.textContent = isAvailable ? setup.actionLabel : 'Coming soon';
      }
      renderConnectionRoutes();
    }
    connectionSelector.addEventListener('change', () => {
      if (connectionSelector.value === addCustomGatewayOption) {
        // Do not replace the selected connection while the native flow is open. On cancellation the
        // current selection therefore remains intact, and no profile or key was webview-owned.
        connectionSelector.value = selectedConnectionId;
        vscode.postMessage({ command: 'addCustomGateway' });
        return;
      }
      selectedConnectionId = connectionSelector.value;
      syncConnection();
    });
    syncConnection();

    function setStatus(text, isError) {
      statusEl.textContent = text || '';
      statusEl.classList.toggle('error', !!isError);
    }

    function renderDots() {
      dots.replaceChildren();
      for (let i = 0; i <= maxStep; i += 1) {
        const dot = document.createElement('span');
        dot.className = i === step ? 'dot active' : 'dot';
        dots.appendChild(dot);
      }
    }

    function renderStep() {
      sections.forEach((section) => section.classList.toggle('active', Number(section.dataset.step) === step));
      backButton.disabled = step === 0;
      nextButton.textContent = step === maxStep ? 'Finish' : 'Next';
      renderDots();
    }

    function renderDemos(tasks) {
      const grid = document.getElementById('demo-grid');
      grid.replaceChildren();
      tasks.forEach((task) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card';
        button.dataset.taskId = task.id;
        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = task.title;
        const desc = document.createElement('p');
        desc.className = 'card-text';
        desc.textContent = task.description;
        const outcome = document.createElement('p');
        outcome.className = 'card-text';
        outcome.textContent = task.expectedOutcome;
        button.append(title, desc, outcome);
        grid.appendChild(button);
      });
    }

    document.addEventListener('click', (event) => {
      const target = event.target;
      const action = target.closest('[data-action]')?.dataset.action;
      if (action === 'next') {
        if (step === maxStep) {
          vscode.postMessage({ command: 'finish' });
          return;
        }
        step = Math.min(maxStep, step + 1);
        setStatus('');
        renderStep();
      } else if (action === 'back') {
        step = Math.max(0, step - 1);
        setStatus('');
        renderStep();
      } else if (action === 'skip') {
        vscode.postMessage({ command: 'skip' });
      } else if (action === 'openConnectionSetup') {
        vscode.postMessage({ command: 'openConnectionSetup', connectionId: selectedConnectionId });
      } else if (action === 'saveProvider') {
        const apiKeyValue = selectedConnectionId.startsWith('custom:') ? undefined : apiKey.value;
        vscode.postMessage({ command: 'saveProvider', connectionId: selectedConnectionId, apiKey: apiKeyValue });
      } else if (action === 'createTeam') {
        vscode.postMessage({ command: 'createTeam', mode: teamMode });
      } else if (action === 'finish') {
        vscode.postMessage({ command: 'finish' });
      }

      const route = target.closest('[data-route-kind]');
      if (route) {
        selectedRouteKind = route.dataset.routeKind || 'openai-compatible';
        syncConnection();
      }

      const team = target.closest('[data-team-mode]');
      if (team) {
        teamMode = team.dataset.teamMode || 'quick';
        document.querySelectorAll('[data-team-mode]').forEach((card) => card.classList.toggle('selected', card === team));
        // A work-style choice is the action. The old separate Start button was easy to miss and made a
        // selected card look like it had already started setup when it had only armed another control.
        vscode.postMessage({ command: 'createTeam', mode: teamMode });
        return;
      }

      const demo = target.closest('[data-task-id]');
      if (demo) {
        vscode.postMessage({ command: 'runDemo', taskId: demo.dataset.taskId });
      }

      const open = target.closest('[data-open-command]');
      if (open) {
        vscode.postMessage({ command: 'openCommand', target: open.dataset.openCommand });
      }

      // Welcome-screen overview cards jump to their step (they looked clickable but did nothing before).
    });

    pricingLink.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ command: 'openExternal', href: pricingLink.href });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'status') {
        setStatus(msg.text, msg.isError);
      } else if (msg.command === 'initialData') {
        const initialConnectionId = typeof msg.currentConnectionId === 'string' ? msg.currentConnectionId : selectedConnectionId;
        selectedConnectionId = initialConnectionId;
        pricingLink.href = msg.pricingUrl || '#';
        connectionGroups = Array.isArray(msg.connectionGroups) ? msg.connectionGroups : connectionGroups;
        selectedRouteKind = (connectionGroups.find((group) => (group.connections || [])
          .some((connection) => connection.id === selectedConnectionId)) || {}).kind || 'openai-compatible';
        syncConnection();
        renderDemos(msg.demoTasks || []);
      }
    });

    renderDemos(initial.demoTasks || []);
    renderStep();
  </script>
</body>
</html>`;
  }
}

function allowedWizardCommand(command: string): boolean {
  return command === 'unode.showSecurity' || command === 'unode.openWorkbench';
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
