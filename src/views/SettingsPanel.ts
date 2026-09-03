/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SettingsPanel (P1#4b)
 *  A single webview panel that surfaces what VS Code's native Settings can't: API-key VISIBILITY
 *  (which provider keys are set — never the values), the MCP server registry, and a jump to the
 *  native settings for single-value options (we don't re-implement those — see Settings_Panel_Design v2).
 *
 *  SECURITY: API-key values are never sent to the webview. We render only "set / not set"; setting
 *  a key uses a masked InputBox (SecretsManager), and the value goes straight to SecretStorage.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SettingsBridge, ProviderStatus, McpServerStatus } from '../settings/SettingsBridge';
import { AgentBackendKind, AgentModelParams, ModelTier } from '../types';
import { sanitizeParams, sanitizeContextWindow } from '../params/sanitizeModelParams';
import {
  DEFAULT_MODEL_PARAM_DEFAULT_LABELS,
  formatModelParamDefaultLabel,
  ModelParamDefaultLabels,
  PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
} from '../params/ModelParamResolver';
import { ROLE_TEMPLATES } from '../roles/RoleConfig';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import { isModelTier, parseModelTierCellPatch } from './settingsSmartValidation';
import { BalanceInfo } from '../models/BalanceService';
import { CUSTOM_GATEWAY_EDIT_HELP, CUSTOM_GATEWAY_REMOVE_HELP } from '../connections/CustomGatewayHelp';
import { stableProviderSort } from '../routes/stableProviderSort';
import type { CapabilityEvidence, CapabilityFact, CapabilityProfile } from '../capabilities/CapabilityProfile';

/** Live Roam balance + the low-balance threshold, as handed to the panel (0.9.7). Numbers only — no key. */
export type BalanceView = BalanceInfo & { thresholdUsd: number };

export type SettingsPanelTab = 'providers' | 'account' | 'tuning' | 'smart' | 'mcp' | 'more';

const SETTINGS_PANEL_TABS = new Set<SettingsPanelTab>(['providers', 'account', 'tuning', 'smart', 'mcp', 'more']);

/** Smart Mode state the panel renders (F3). */
export interface SmartModeView {
  enabled: boolean;
  defaultTier: ModelTier;
  /** role → tier override. */
  roleTiers: Record<string, ModelTier>;
  /** message type → tier hint. */
  taskTierHints: Record<string, ModelTier>;
  /** Resolved tier → provider → model table (defaults merged with the user override). */
  modelTiers: Record<ModelTier, Record<string, string>>;
  /** Provider columns to show in the tier matrix. */
  providerIds: string[];
}

/** A single Smart Mode edit from the webview. */
export type SmartModePatch =
  | { kind: 'enabled'; value: boolean }
  | { kind: 'defaultTier'; value: ModelTier }
  | { kind: 'roleTier'; role: string; value?: ModelTier }
  | { kind: 'modelTierCell'; tier: ModelTier; provider: string; value: string }
  | { kind: 'taskTierHints'; value: Record<string, ModelTier> };

/** One agent's tunable model settings, surfaced in the Model Tuning tab (F1/F1b). */
export interface AgentTuning {
  id: string;
  name: string;
  role: string;
  /** The agent's provider (roam / openai / anthropic / openrouter / custom). Agents can each use a
   *  different provider — Smart Mode resolves each agent's tier → model via ITS provider, so you can put
   *  model A on the provider that's cheapest for it and model B on another. Shown for transparency. */
  providerId: string;
  /** Resolved backend kind ('claude' | 'openai-compat') — drives which params are applicable. */
  backend: AgentBackendKind;
  model: string;
  modelParams?: AgentModelParams;
  /** Registry-derived allowlist. Omitted only for old embedders/tests, where the legacy UI remains broad. */
  allowedModelParamKeys?: readonly string[];
  /** Per-agent context window for the 70%/80% gate (F1b). Empty = default context window. */
  contextWindowTokens?: number;
  /** Connection × model profile, including declared/user/session provenance. */
  capabilityProfile?: CapabilityProfile;
}

export interface SettingsPanelDeps {
  bridge: SettingsBridge;
  /** Prompt (masked) for a secret and store it; returns true if stored. */
  promptAndStoreSecret: (secretName: string) => Promise<boolean>;
  /** Open the .unode/team.json file (where MCP servers are configured). */
  openTeamFile: () => void;
  /** Wipe this workspace's Roam state (roster/chat/messages/snapshots/workflows). Optional. */
  resetWorkspace?: () => void;
  /** List current agents and their tunable params (F1). Optional — tab hidden if absent. */
  listAgentTunings?: () => AgentTuning[];
  /** Persist an agent's model params + context window, applying live where possible (F1). */
  setAgentTuning?: (id: string, modelParams: AgentModelParams, contextWindowTokens?: number, removeLegacyModelParams?: boolean) => Promise<void>;
  /** Current Smart Mode state for the tab (F3). Optional — tab hidden if absent. */
  getSmartMode?: () => SmartModeView;
  /** Persist one Smart Mode edit (F3). */
  updateSmartMode?: (patch: SmartModePatch) => Promise<void>;
  /** Host-resolved labels for blank model-param options. The option value still stays empty/unset. */
  modelParamDefaultLabels?: () => ModelParamDefaultLabels;
  /** List a provider's live models (for the tier-matrix model-id pickers). Same source the Agent Builder
   *  uses, so each provider column suggests that provider's REAL ids (naming differs across providers). */
  listModels?: (providerId: string, baseUrl?: string) => Promise<SettingsModelOption[]> | SettingsModelOption[];
  /** Live account balance for a provider's Providers-tab card (0.9.8: any gateway, not just Roam). Resolved
   *  host-side from that provider's stored key; returns undefined when no key, the endpoint is absent, or it
   *  can't be read (the card shows nothing) — so non-new-api providers (OpenAI/Anthropic) just stay blank. */
  getProviderBalance?: (providerId: string) => Promise<BalanceView | undefined>;
  /** Registry-routed user-initiated CLI setup. The connection id was rendered from the same registry. */
  openConnectionSetup?: (connectionId: string) => void;
  /** `unode.defaultProvider` — the provider new agents are created with. */
  getDefaultProvider?: () => string;
  /** Persist a new default provider. Must work for key-less, CLI-authenticated providers (Anthropic /
   *  Claude Headless) — that is the only post-setup path to switch to it. */
  setDefaultProvider?: (providerId: string) => Promise<void>;
  /** Registry-owned presentation label. The webview keeps raw provider ids only for action identifiers. */
  displayNameForProviderId?: (providerId: string) => string;
  /** Host-mediated custom gateway actions. The panel never receives or posts an API-key value. */
  addCustomGateway?: () => Promise<void>;
  /** Native host flow: Name → Endpoint → optional key action. */
  editCustomGateway?: (connectionId: string) => Promise<void>;
  renameCustomGateway?: (connectionId: string) => Promise<void>;
  updateCustomGatewayEndpoint?: (connectionId: string) => Promise<void>;
  replaceCustomGatewayKey?: (connectionId: string) => Promise<void>;
  clearCustomGatewayKey?: (connectionId: string) => Promise<void>;
  /** Metadata-only `/models` test for registered API-key/OpenAI-models connections. */
  testConnection?: (connectionId: string) => Promise<void>;
  archiveCustomGateway?: (connectionId: string) => Promise<void>;
}

export interface SettingsModelOption {
  id: string;
  name: string;
  price?: string;
}

export class SettingsPanel {
  public static current: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private allowedSecretNames = new Set<string>();
  private knownProviderIds = new Set<string>();
  private lastProviders = new Map<string, ProviderStatus>();

  static createOrShow(extensionUri: vscode.Uri, deps: SettingsPanelDeps, initialTab: SettingsPanelTab = 'providers'): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.showTab(initialTab);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeSettings',
      'UnodeAi Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    SettingsPanel.current = new SettingsPanel(panel, deps, initialTab);
  }

  static refreshCurrent(): void {
    if (SettingsPanel.current) {
      void SettingsPanel.current.render();
    }
  }

  private activeTab: SettingsPanelTab;

  private constructor(panel: vscode.WebviewPanel, private deps: SettingsPanelDeps, initialTab: SettingsPanelTab) {
    this.panel = panel;
    this.activeTab = initialTab;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    void this.render();
  }

  private showTab(tab: SettingsPanelTab): void {
    if (!SETTINGS_PANEL_TABS.has(tab)) {
      return;
    }
    this.activeTab = tab;
    this.panel.reveal();
    void this.panel.webview.postMessage({ command: 'selectTab', tab });
  }

  private providerDisplayName(providerId: string): string {
    return this.deps.displayNameForProviderId?.(providerId) ?? providerId;
  }

  private async onMessage(msg: {
    command?: unknown;
    secretName?: unknown;
    key?: string;
    value?: unknown;
    agentId?: unknown;
    params?: unknown;
    contextWindowTokens?: unknown;
    removeLegacyModelParams?: unknown;
    patch?: unknown;
    linkKey?: unknown;
    providerId?: unknown;
    baseUrl?: unknown;
  }): Promise<void> {
    if (!msg || typeof msg.command !== 'string') {
      return;
    }
    try {
      switch (msg.command) {
        case 'refresh':
          break;
        case 'saveTuning':
          await this.saveTuning(msg.agentId, msg.params, msg.contextWindowTokens, msg.removeLegacyModelParams);
          return;
        case 'saveSmart':
          // Persist the tier edit WITHOUT a full re-render: each smart-mode control already holds its own
          // value client-side, so re-rendering would just reset the active tab back to Providers — that's
          // the "jumps back to the Provider page after every tier pick" bug. Keep the user on Smart Mode.
          await this.saveSmart(msg.patch);
          return;
        case 'listModels': {
          // Feed a provider's live models to the tier-matrix datalists (no re-render — just postMessage).
          const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
          const baseUrl = typeof msg.baseUrl === 'string' ? msg.baseUrl : undefined;
          const known = new Set(this.deps.getSmartMode?.()?.providerIds ?? []);
          if (this.deps.listModels && known.has(providerId)) {
            const models = await this.deps.listModels(providerId, baseUrl);
            void this.panel.webview.postMessage({ command: 'models', providerId, models });
          }
          return;
        }
        case 'closePanel':
          this.panel.dispose();
          return;
        case 'setKey':
          if (this.isAllowedSecretName(msg.secretName)) {
            await this.deps.promptAndStoreSecret(msg.secretName);
          }
          break;
        case 'deleteKey':
          if (this.isAllowedSecretName(msg.secretName)) {
            const ok = await vscode.window.showWarningMessage(
              `Delete stored key ${msg.secretName}?`, 'Delete', 'Cancel'
            );
            if (ok === 'Delete') {
              await this.deps.bridge.deleteApiKey(msg.secretName);
            }
          }
          break;
        case 'setDefaultProvider':
          // Host validates the id against the providers it rendered, so a compromised webview can't write an
          // arbitrary value into `unode.defaultProvider`.
          if (this.deps.setDefaultProvider && this.isKnownProviderId(msg.providerId)) {
            await this.deps.setDefaultProvider(msg.providerId);
            vscode.window.showInformationMessage(`New agents will use the ${msg.providerId} provider.`);
          }
          break;
        case 'addCustomGateway':
          await this.deps.addCustomGateway?.();
          break;
        case 'editCustomGateway': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.editCustomGateway?.(provider.connectionId!);
          }
          break;
        }
        case 'renameCustomGateway': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.renameCustomGateway?.(provider.connectionId!);
          }
          break;
        }
        case 'updateCustomGatewayEndpoint': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.updateCustomGatewayEndpoint?.(provider.connectionId!);
          }
          break;
        }
        case 'replaceCustomGatewayKey': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.replaceCustomGatewayKey?.(provider.connectionId!);
          }
          break;
        }
        case 'clearCustomGatewayKey': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.clearCustomGatewayKey?.(provider.connectionId!);
          }
          break;
        }
        case 'testConnection': {
          const provider = typeof msg.providerId === 'string' ? this.lastProviders.get(msg.providerId) : undefined;
          if (
            provider?.authKind === 'api-key'
            && provider.catalogKind === 'openai-models'
            && this.deps.testConnection
          ) {
            await this.deps.testConnection(provider.connectionId ?? provider.providerId);
          }
          break;
        }
        case 'archiveCustomGateway': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider) {
            await this.deps.archiveCustomGateway?.(provider.connectionId!);
          }
          break;
        }
        case 'listCustomGatewayModels': {
          const provider = this.customProviderForMessage(msg.providerId);
          if (provider && this.deps.listModels) {
            const models = await this.deps.listModels(provider.connectionId!);
            void this.panel.webview.postMessage({ command: 'customGatewayModels', providerId: provider.providerId, models });
          }
          return;
        }
        // Navigation / external actions below change NOTHING the panel displays, so they must NOT fall
        // through to the trailing render() — re-rendering rebuilds the webview HTML and wipes any unsaved
        // edits (e.g. in-progress model-tuning fields). Same class of bug as the Agent Builder form wipe.
        case 'openSignup': {
          // The current host snapshot owns URLs; a webview can name an id but cannot supply a URL.
          const url = this.providerForMessage(msg.linkKey)?.presentation.signupUrl;
          if (url) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          return;
        }
        case 'openPricing': {
          // The current host snapshot owns URLs; a webview can name an id but cannot supply a URL.
          const url = this.providerForMessage(msg.linkKey)?.presentation.pricingUrl;
          if (url) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          return;
        }
        case 'openConnectionSetup': {
          const connectionId = typeof msg.providerId === 'string' ? msg.providerId : '';
          if (this.isKnownProviderId(connectionId)) {
            this.deps.openConnectionSetup?.(connectionId);
          }
          return;
        }
        case 'requestBalance': {
          // 0.9.8: resolve a provider's live balance host-side (key never crosses to the webview) and post
          // back just the numbers. MUST return — re-rendering would wipe in-progress edits (bug class above).
          const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
          const balance = providerId && this.isKnownProviderId(providerId) && this.deps.getProviderBalance
            ? await this.deps.getProviderBalance(providerId)
            : undefined;
          void this.panel.webview.postMessage({ command: 'balance', providerId, balance });
          return;
        }
        case 'openSetupWizard':
          // The Providers tab is where a user comes back to change their mind, so it must offer the same
          // wizard the first run used — otherwise the only post-setup path to switch gateway/base URL is
          // editing raw settings. Opens the wizard; the panel shows nothing new, so do NOT fall through
          // to render().
          await vscode.commands.executeCommand('unode.onboarding');
          return;
        case 'openMcpMarketplace':
          await vscode.commands.executeCommand('unode.openMarketplace', 'mcp');
          return;
        case 'openNativeSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:unode.unodeai');
          return;
        case 'openTeamFile':
          this.deps.openTeamFile();
          return;
        case 'resetWorkspace':
          this.deps.resetWorkspace?.();
          return;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`UnodeAi Settings: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.render();
  }

  /** Validate + persist a Model Tuning save from the (untrusted) webview. */
  private async saveTuning(agentId: unknown, rawParams: unknown, rawCtx: unknown, rawRemoveLegacy: unknown): Promise<void> {
    if (!this.deps.setAgentTuning || typeof agentId !== 'string') {
      return;
    }
    const tuning = (this.deps.listAgentTunings?.() ?? []).find((a) => a.id === agentId);
    if (!tuning) {
      return;
    }
    const params = sanitizeParams(rawParams);
    if (tuning.allowedModelParamKeys) {
      const unsupported = Object.keys(params).filter((key) => !tuning.allowedModelParamKeys!.includes(key));
      if (unsupported.length > 0) {
        throw new Error(`This connection does not accept: ${unsupported.join(', ')}. No settings were changed.`);
      }
    }
    const ctx = sanitizeContextWindow(rawCtx);
    await this.deps.setAgentTuning(agentId, params, ctx, rawRemoveLegacy === true);
  }

  /** Validate + persist one Smart Mode edit from the (untrusted) webview. */
  private async saveSmart(raw: unknown): Promise<void> {
    if (!this.deps.updateSmartMode || !raw || typeof raw !== 'object') {
      return;
    }
    const p = raw as Record<string, unknown>;
    const smart = this.deps.getSmartMode?.();
    const knownRoles = new Set((this.deps.listAgentTunings?.() ?? []).map((a) => a.role));
    const knownProviders = new Set(smart?.providerIds ?? []);
    switch (p.kind) {
      case 'enabled':
        await this.deps.updateSmartMode({ kind: 'enabled', value: !!p.value });
        break;
      case 'defaultTier':
        if (isModelTier(p.value)) {
          await this.deps.updateSmartMode({ kind: 'defaultTier', value: p.value });
        }
        break;
      case 'roleTier':
        if (typeof p.role === 'string' && knownRoles.has(p.role)) {
          // empty/“(default)” clears the override
          await this.deps.updateSmartMode({ kind: 'roleTier', role: p.role, value: isModelTier(p.value) ? p.value : undefined });
        }
        break;
      case 'modelTierCell': {
        const patch = parseModelTierCellPatch(p, knownProviders);
        if (patch) {
          await this.deps.updateSmartMode(patch);
        }
        break;
      }
      case 'taskTierHints': {
        if (!p.value || typeof p.value !== 'object' || Array.isArray(p.value)) {
          break;
        }
        const out: Record<string, ModelTier> = {};
        for (const [msgType, tier] of Object.entries(p.value as Record<string, unknown>)) {
          const cleanType = msgType.trim();
          if (cleanType && isModelTier(tier)) {
            out[cleanType] = tier;
          }
        }
        await this.deps.updateSmartMode({ kind: 'taskTierHints', value: out });
        break;
      }
    }
  }

  private async render(): Promise<void> {
    const snapshot = await this.deps.bridge.getSnapshot();
    this.allowedSecretNames = new Set(
      snapshot.providers
        .filter((p) => p.authKind === 'api-key' && p.canManageApiKey)
        .map((p) => p.apiKeySecretName)
        .filter((name): name is string => !!name)
    );
    // Includes CLI-auth providers (Anthropic), but never a retained Coming Soon route.
    // The host still validates availability independently before it persists or starts anything.
    this.knownProviderIds = new Set(snapshot.providers
      .filter((p) => (p.availability ?? 'available') === 'available')
      .map((p) => p.providerId));
    this.lastProviders = new Map(snapshot.providers.map((provider) => [provider.providerId, provider]));
    const agents = this.deps.listAgentTunings?.() ?? [];
    const smart = this.deps.getSmartMode?.();
    this.panel.webview.html = this.html(snapshot.providers, snapshot.mcpServers, agents, smart);
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  private html(providers: ProviderStatus[], mcp: McpServerStatus[], agents: AgentTuning[], smart?: SmartModeView): string {
    const scriptNonce = nonce();
    const inUseProviders = new Set(agents.map((a) => a.providerId).filter(Boolean));
    const sortedProviders = stableProviderSort(providers, (p) => p.providerId);
    const sortedSmart = smart
      ? { ...smart, providerIds: stableProviderSort(smart.providerIds, (id) => id) }
      : undefined;
    const signupProviderIds = sortedProviders
      .filter((provider) => !!provider.presentation.signupUrl)
      .map((provider) => provider.providerId);
    const providerCards = sortedProviders.map((p) => this.providerCard(p, inUseProviders.has(p.providerId))).join('');
    const accountSection = this.accountSection(sortedProviders.find((provider) => provider.providerId === 'unode'));
    const mcpRows = mcp.length === 0
      ? '<div class="empty">No MCP servers registered. Configure them in .unode/team.json.</div>'
      : mcp.map((m) => this.mcpRow(m)).join('');
    const smartSection = sortedSmart ? this.smartModeSection(sortedSmart, agents) : '<div class="empty">Smart Mode unavailable.</div>';
    const defaultLabels = this.deps.modelParamDefaultLabels?.() ?? DEFAULT_MODEL_PARAM_DEFAULT_LABELS;
    const tuningCards = agents.length === 0
      ? '<div class="empty">No agents yet. Add an agent, then tune its model parameters here.</div>'
      : agents.map((a) => this.agentTuningCard(a, defaultLabels)).join('');
    const isActive = (tab: SettingsPanelTab) => this.activeTab === tab ? ' active' : '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(this.panel.webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Settings</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--vscode-foreground); padding: 20px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
    .topbar .subtitle { margin-bottom: 0; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 16px; }
    .tab { padding: 8px 14px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: #7c4dff; }
    .section { display: none; }
    .section.active { display: block; }
    .card { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .name { font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
    .pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
    .pill.set { background: #28a74522; color: #28a745; }
    .pill.unset { background: #ffc10722; color: #ffc107; }
    .tuning-summary { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .grid.tuning-quick { margin-top: 10px; }
    details.tuning-advanced { margin-top: 10px; }
    details.tuning-advanced > summary {
      cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 0;
      color: var(--vscode-textLink-foreground); user-select: none;
    }
    .pill.info { background: #6c757d22; color: var(--vscode-descriptionForeground); }
    .balance { margin-top: 8px; font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .balance .bal-label { color: var(--vscode-descriptionForeground); }
    .balance.low { color: #ffc107; }
    .balance .bal-warn { color: #ffc107; font-weight: 600; }
    .balance .bal-topup { padding: 2px 10px; font-size: 11px; }
    .pill.inuse { background: #2ea04322; color: #2ea043; }
    .card.inuse { border-left: 3px solid #2ea043; }
    .card.coming-soon { opacity: 0.62; border-style: dashed; }
    .btn { font-size: 12px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
    .btn.danger { background: var(--vscode-errorForeground); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600; }
    .btn.danger:hover { background: var(--vscode-errorForeground); opacity: 0.85; }
    .actions { display: flex; gap: 6px; }
    .signup-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; background: var(--vscode-textBlockQuote-background, #7c4dff14); border: 1px solid #7c4dff66; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
    .signup-banner .actions { flex-shrink: 0; flex-wrap: wrap; }
    .empty { color: var(--vscode-descriptionForeground); padding: 12px 0; }
    .approval { color: #ffc107; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-top: 12px; }
    .field { display: flex; flex-direction: column; gap: 3px; }
    .field label { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; }
    .field input, .field select, .field textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
    /* Dropdowns use the dropdown theme tokens so the option popup stays legible in dark themes (Cursor). */
    .field select { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); }
    select option { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); }
    .field textarea { resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
    .field input:disabled, .field select:disabled, .field textarea:disabled { opacity: 0.45; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    details.ref { display: inline; }
    details.ref > summary { cursor: pointer; list-style: none; display: inline-flex; width: 15px; height: 15px; align-items: center; justify-content: center; border-radius: 50%; background: #6c757d33; color: var(--vscode-foreground); font-size: 10px; font-weight: 700; user-select: none; }
    details.ref > summary::-webkit-details-marker { display: none; }
    /* The badge above is sized for ONE character — it is the "i" reference marker. The capability profile
       reuses details.ref for its body styling but its summary is a sentence, and a sentence laid out inside a
       15x15 circle spills out of it: the Owner saw a bare fragment of a connection id floating above
       Temperature with no label (2026-08-19). A summary that is text gets text layout. */
    details.capability-profile { display: block; }
    details.capability-profile > summary {
      width: auto; height: auto; border-radius: 4px; justify-content: flex-start;
      display: block; padding: 2px 6px; font-size: 11px; font-weight: 600;
      color: var(--vscode-descriptionForeground); overflow-wrap: anywhere;
    }
    details.ref[open] > .refbody { display: block; }
    .refbody { margin-top: 8px; padding: 10px; border-left: 2px solid #7c4dff; background: var(--vscode-textBlockQuote-background, #6c757d11); font-size: 12px; line-height: 1.5; }
    .refbody ul { margin: 6px 0 0; padding-left: 18px; }
    table.matrix { border-collapse: collapse; margin-top: 10px; width: 100%; }
    table.matrix th, table.matrix td { border: 1px solid var(--vscode-panel-border); padding: 5px 8px; text-align: left; font-size: 12px; }
    table.matrix th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    table.matrix input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 5px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>UnodeAi Settings</h1>
      <p class="subtitle">API keys never leave SecretStorage; this panel only shows whether each is set.</p>
    </div>
    <button class="btn" data-command="closePanel">Close</button>
  </div>
  <div class="tabs">
    <div class="tab${isActive('providers')}" data-tab="providers">Providers</div>
    <div class="tab${isActive('account')}" data-tab="account">Unode Account</div>
    <div class="tab${isActive('tuning')}" data-tab="tuning">Model Tuning</div>
    <div class="tab${isActive('smart')}" data-tab="smart">Smart Mode</div>
    <div class="tab${isActive('mcp')}" data-tab="mcp">MCP Servers</div>
    <div class="tab${isActive('more')}" data-tab="more">More</div>
  </div>

  <div class="section${isActive('providers')}" id="providers">
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <span class="meta">Each provider's key lives in VS Code SecretStorage. A CLI-authenticated provider
        (Claude Headless) stores no key here and uses its own login.</span>
      <div class="actions">
        ${this.deps.addCustomGateway ? '<button class="btn primary" data-command="addCustomGateway">Add custom gateway</button>' : ''}
        <button class="btn" data-command="openSetupWizard"
          title="Re-run the first-run setup: pick the provider and gateway, paste a key, and choose the default. Nothing is erased — it walks the same steps again so you can change your mind after the initial setup.">↻ Run Setup Wizard again</button>
      </div>
    </div>
    ${providerCards}
  </div>

  <div class="section${isActive('account')}" id="account">
    ${accountSection}
  </div>

  <div class="section${isActive('tuning')}" id="tuning">
    <p class="meta">Per-agent model &amp; sampling parameters. Saved to <code>.unode/team.json</code>. Sampling
    params apply on the agent's next turn (OpenAI-compatible backends); context window applies on next start.</p>
    ${tuningCards}
  </div>

  <div class="section${isActive('smart')}" id="smart">
    ${smartSection}
  </div>

  <div class="section${isActive('mcp')}" id="mcp">
    <div class="signup-banner">
      <div>
        <div class="name">Add MCP servers from the Marketplace</div>
        <p class="meta">Browse curated MCP servers and install them in one click — they appear here, ready to grant to an agent. You can still hand-edit <code>.unode/team.json</code> for custom servers.</p>
      </div>
      <div class="actions">
        <button class="btn primary" data-command="openMcpMarketplace">Browse MCP Marketplace</button>
      </div>
    </div>
    ${mcpRows}
    <div style="margin-top:12px"><button class="btn" data-command="openTeamFile">Open .unode/team.json</button></div>
  </div>

  <div class="section${isActive('more')}" id="more">
    <div class="card">
      <div class="name">Single-value settings</div>
      <p class="meta">Concurrency, security, logging and provider defaults are managed by VS Code's native settings (with validation), so they have one source of truth.</p>
      <div style="margin-top:10px"><button class="btn primary" data-command="openNativeSettings">⚙ Open UnodeAi native settings</button></div>
    </div>
    <div class="card">
      <div class="name">Reset workspace</div>
      <p class="meta">Permanently clears this workspace's team roster, chat history, message log, saved conversations, workflows, and approved MCP servers, then reloads. Use this if an old team or old chats carried over. Cannot be undone.</p>
      <div style="margin-top:10px"><button class="btn danger" data-command="resetWorkspace">Reset workspace state…</button></div>
    </div>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const settingsTabs = new Set(['providers', 'account', 'tuning', 'smart', 'mcp', 'more']);
    function requestBalances() {
      document.querySelectorAll('[data-balance]').forEach(function (el) {
        vscode.postMessage({ command: 'requestBalance', providerId: el.getAttribute('data-provider') });
      });
    }
    function activateTab(tab) {
      if (!settingsTabs.has(tab)) return;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
      document.querySelectorAll('.section').forEach((x) => x.classList.toggle('active', x.id === tab));
      if (tab === 'providers') requestBalances();
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      vscode.postMessage({ command: button.dataset.command, secretName: button.dataset.secretName, linkKey: button.dataset.linkKey, providerId: button.dataset.providerId });
    });
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));
    // Model Tuning: collect a card's fields and save.
    document.addEventListener('click', (event) => {
      const save = event.target.closest('button[data-save]');
      if (!save) return;
      const card = save.closest('[data-agent]');
      if (!card) return;
      const params = {};
      let contextWindowTokens;
      card.querySelectorAll('[data-field]').forEach((el) => {
        if (el.closest('[hidden]')) return;
        const wrap = el.closest('[data-field-wrap]');
        if (wrap?.querySelector('[data-use-default]')?.checked) return;
        const f = el.dataset.field;
        const raw = el.value;
        if (raw === '' || raw === undefined) return;
        if (f === 'contextWindowTokens') { contextWindowTokens = Number(raw); return; }
        if (f === 'thinking_budget_tokens') return;
        if (f === 'thinking_type') {
          params.thinking = raw === 'enabled'
            ? { type: 'enabled' }
            : { type: 'disabled' };
          const budget = card.querySelector('[data-field="thinking_budget_tokens"]')?.value;
          if (raw === 'enabled' && budget !== '' && budget !== undefined) params.thinking.budget_tokens = Number(budget);
          return;
        }
        if (f === 'stop') { params.stop = raw.split('\\n').map((s) => s.trim()).filter(Boolean); return; }
        if (f === 'stream') { params.stream = raw === 'true'; return; }
        if (f === 'response_format' || f === 'reasoning_effort') { params[f] = raw; return; }
        if (f === 'tool_choice') { params[f] = raw; return; }
        params[f] = Number(raw);
      });
      vscode.postMessage({
        command: 'saveTuning',
        agentId: card.dataset.agent,
        params,
        contextWindowTokens,
        removeLegacyModelParams: card.querySelector('[data-remove-legacy]')?.checked === true,
      });
    });
    document.querySelectorAll('[data-use-default]').forEach((box) => {
      const sync = () => {
        const wrap = box.closest('[data-field-wrap]');
        wrap?.querySelectorAll('[data-field]').forEach((el) => { if (el.dataset.field !== 'contextWindowTokens') el.disabled = box.checked || el.dataset.forceDisabled === 'true'; });
      };
      box.addEventListener('change', sync);
      sync();
    });
    // Smart Mode: each control saves on change.
    document.addEventListener('change', (event) => {
      const el = event.target.closest('[data-smart]');
      if (!el) return;
      const kind = el.dataset.smart;
      let patch;
      if (kind === 'enabled') patch = { kind, value: el.checked };
      else if (kind === 'defaultTier') patch = { kind, value: el.value };
      else if (kind === 'roleTier') patch = { kind, role: el.dataset.role, value: el.value || undefined };
      else if (kind === 'modelTierCell') patch = { kind, tier: el.dataset.tier, provider: el.dataset.provider, value: el.value };
      if (patch) vscode.postMessage({ command: 'saveSmart', patch });
      recomputeSmartRows(); // keep the per-agent "→ model / ⚠ warning" labels fresh without a re-render
    });

    // Recompute each agent's resolved-model / warning label from the LIVE DOM (role-tier selects + matrix
    // cells), since saveSmart doesn't re-render. Mirrors the server-side exact-provider-match logic.
    function recomputeSmartRows() {
      const defTier = document.querySelector('[data-smart="defaultTier"]')?.value || 'standard';
      document.querySelectorAll('[data-smart-row]').forEach((row) => {
        const role = row.dataset.smartRole;
        const provider = row.dataset.smartProvider;
        const providerName = smartProviderNames[provider] || provider;
        const roleSel = document.querySelector('[data-smart="roleTier"][data-role="' + (window.CSS && CSS.escape ? CSS.escape(role) : role) + '"]');
        const tier = (roleSel && roleSel.value) ? roleSel.value : defTier;
        const cell = document.querySelector('[data-smart="modelTierCell"][data-tier="' + tier + '"][data-provider="' + (window.CSS && CSS.escape ? CSS.escape(provider) : provider) + '"]');
        const model = cell ? cell.value.trim() : '';
        const target = row.querySelector('[data-smart-model]');
        if (!target) return;
        if (model) {
          target.textContent = ' → ' + model;
          target.style.color = '';
        } else {
          target.textContent = ' → ⚠ no ' + providerName + ' model for “' + tier + '” — set it in the tier matrix below';
          target.style.color = 'var(--vscode-errorForeground)';
        }
      });
    }
    document.addEventListener('click', (event) => {
      const saveHints = event.target.closest('button[data-save-task-hints]');
      if (!saveHints) return;
      const raw = document.querySelector('[data-task-tier-hints]')?.value || '{}';
      try {
        vscode.postMessage({ command: 'saveSmart', patch: { kind: 'taskTierHints', value: JSON.parse(raw) } });
      } catch {
        vscode.postMessage({ command: 'saveSmart', patch: { kind: 'taskTierHints', value: {} } });
      }
    });
    // Tier-matrix model pickers: pull each provider's live models into its <datalist> so users pick the
    // provider's EXACT id (model ids differ across providers) instead of typing — same source as the Agent Builder.
    const smartProviders = ${JSON.stringify((sortedSmart?.providerIds ?? []).map((id) => ({ id, name: this.providerDisplayName(id), baseUrl: sortedProviders.find((p) => p.providerId === id)?.baseUrl ?? '' }))).replace(/</g, '\\u003c')};
    const smartProviderNames = Object.fromEntries(smartProviders.map((provider) => [provider.id, provider.name]));
    function populateModelList(providerId, models) {
      const dl = document.getElementById('models-' + providerId);
      if (!dl) return;
      dl.replaceChildren();
      for (const m of (models || [])) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.label = (m.name && m.name !== m.id ? m.name + ' / ' + m.id : m.id) + (m.price ? ' - ' + m.price : '');
        dl.appendChild(opt);
      }
    }
    // 0.9.8: fill a PROVIDER's balance slot from the host's 'balance' reply. Numbers only (no key). Hidden
    // until resolved; stays hidden if that provider's balance can't be read (degrades silently).
    function renderBalance(providerId, balance) {
      const el = document.querySelector('[data-balance][data-provider="' + providerId + '"]');
      renderAccountBalance(providerId, balance);
      if (!el) return;
      if (!balance) { el.hidden = true; return; }
      if (balance.unlimited) {
        el.hidden = false;
        el.className = 'balance';
        el.innerHTML = '<span class="bal-label">Balance:</span> <strong>Unlimited</strong>';
        return;
      }
      const remaining = typeof balance.remainingUsd === 'number' ? balance.remainingUsd : null;
      if (remaining === null) { el.hidden = true; return; }
      const low = typeof balance.thresholdUsd === 'number' && balance.thresholdUsd > 0 && remaining < balance.thresholdUsd;
      el.hidden = false;
      el.className = low ? 'balance low' : 'balance';
      const used = typeof balance.usedUsd === 'number' ? ' · $' + balance.usedUsd.toFixed(2) + ' used' : '';
      // Shown as an APPROXIMATE figure — gateway limit/quota semantics for finite accounts are still being
      // validated, so don't present it as an authoritative remaining-credit number.
      let html = '<span class="bal-label" title="Approximate — read from the gateway billing endpoint; treat as an estimate, not an exact remaining-credit figure.">Balance (approx.):</span> <strong>$' + remaining.toFixed(2) + '</strong>' + used;
      if (low) {
        html += ' <span class="bal-warn">⚠ Low balance</span>';
        // Top-up only for providers we promote a sign-up link for.
        if (${JSON.stringify(signupProviderIds).replace(/</g, '\\u003c')}.includes(providerId)) {
          html += ' <button class="btn primary bal-topup" data-command="openSignup" data-link-key="' + providerId + '">Top up</button>';
        }
      }
      el.innerHTML = html;
    }
    function renderAccountBalance(providerId, balance) {
      if (providerId !== 'unode') return;
      const el = document.querySelector('[data-account-balance]');
      if (!el) return;
      if (!balance || (balance.unlimited !== true && typeof balance.remainingUsd !== 'number')) {
        el.className = 'balance low';
        el.textContent = 'Balance unavailable — no approved metadata response was available from Unode.';
        return;
      }
      if (balance.unlimited) {
        el.className = 'balance';
        el.textContent = 'Balance: Unlimited';
        return;
      }
      const low = typeof balance.thresholdUsd === 'number' && balance.thresholdUsd > 0 && balance.remainingUsd < balance.thresholdUsd;
      el.className = low ? 'balance low' : 'balance';
      el.textContent = (low ? 'Low balance: ' : 'Balance (approx.): ') + '$' + balance.remainingUsd.toFixed(2);
    }
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.command === 'selectTab' && typeof msg.tab === 'string') activateTab(msg.tab);
      if (msg && msg.command === 'models' && typeof msg.providerId === 'string') populateModelList(msg.providerId, msg.models);
      if (msg && msg.command === 'balance' && typeof msg.providerId === 'string') renderBalance(msg.providerId, msg.balance);
      if (msg && msg.command === 'customGatewayModels' && typeof msg.providerId === 'string') {
        const target = Array.from(document.querySelectorAll('[data-custom-gateway-models]'))
          .find((el) => el.getAttribute('data-custom-gateway-models') === msg.providerId);
        if (target) {
          const ids = (msg.models || []).slice(0, 12).map((model) => model.name || model.id).join(', ');
          target.textContent = ids ? 'Models: ' + ids : 'No models returned by this gateway.';
        }
      }
    });
    for (const p of smartProviders) vscode.postMessage({ command: 'listModels', providerId: p.id, baseUrl: p.baseUrl });
    // Opening the Account tab is local-only. Provider balances are requested only when the Providers tab
    // is active or when the user explicitly clicks "Check available balance" in the Account tab.
    if (document.querySelector('.tab.active')?.dataset.tab === 'providers') requestBalances();
  </script>
</body>
</html>`;
  }

  private accountSection(unode: ProviderStatus | undefined): string {
    if (!unode) {
      return /* html */`
        <div class="card" data-account-state="unavailable">
          <div class="name">Unode account is unavailable</div>
          <p class="meta">The built-in Unode connection is not registered in this extension host. Other providers remain usable.</p>
        </div>`;
    }

    const accountActions = [
      unode.presentation.signupUrl
        ? '<button class="btn primary" data-command="openSignup" data-link-key="unode">Create account / sign in</button>'
        : '',
      unode.presentation.signupUrl
        ? '<button class="btn" data-command="openSignup" data-link-key="unode">Manage account, credits &amp; usage</button>'
        : '',
      unode.presentation.pricingUrl
        ? '<button class="btn" data-command="openPricing" data-link-key="unode">Models &amp; pricing</button>'
        : '',
    ].filter(Boolean).join('');
    const keyAction = unode.canManageApiKey && unode.apiKeySecretName
      ? `<button class="btn primary" data-command="setKey" data-secret-name="${escAttr(unode.apiKeySecretName)}">Connect an API key</button>`
      : '';

    if (!unode.hasApiKey) {
      return /* html */`
        <div class="card" data-account-state="no-key">
          <div class="name">No Unode API key configured</div>
          <p class="meta">You can create an account, top up, or connect a key here. UnodeAi does not store a password or payment detail, and every other provider remains usable without a Unode account.</p>
          <div class="actions" style="margin-top:10px">${keyAction}${accountActions}</div>
        </div>`;
    }

    return /* html */`
      <div class="card" data-account-state="api-key">
        <div class="row"><span class="name">Connected via API key</span><span class="pill set">Key configured</span></div>
        <p class="meta">Connected via API key — not signed in. This local extension has no account identity, password, payment detail, or cloud session.</p>
        <div class="balance" data-account-balance>Balance has not been checked in this view.</div>
        <div class="actions" style="margin-top:10px">
          <button class="btn" data-command="requestBalance" data-provider-id="unode">Check available balance</button>
          ${accountActions}
        </div>
      </div>`;
  }

  private providerCard(p: ProviderStatus, inUse = false): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const availability = p.availability ?? 'available';
    // Mark the provider(s) actually assigned to an agent, so it's obvious which are live (green accent + pill).
    const inUsePill = inUse ? '<span class="pill inuse">● in use</span>' : '';
    const cardCls = `${inUse ? 'card inuse' : 'card'}${availability === 'coming-soon' ? ' coming-soon' : ''}`;
    // Which provider new agents are created with. Settable from every card — including CLI-auth ones, which
    // have no key to set and were previously unselectable (no post-setup path to Claude Headless).
    const isDefault = availability === 'available' && this.deps.getDefaultProvider?.() === p.providerId;
    const defaultPill = isDefault ? '<span class="pill set">★ Default for new agents</span>' : '';
    const defaultAction = this.deps.setDefaultProvider && !isDefault
      ? `<button class="btn" data-command="setDefaultProvider" data-provider-id="${escAttr(p.providerId)}">Set as default</button>`
      : '';
    const isCustomGateway = (p.connectionId ?? p.providerId).startsWith('custom:');
    const providerId = escAttr(p.providerId);
    if (availability === 'coming-soon') {
      const retained = inUse
        ? '<p class="meta">Existing agent configuration is preserved. Choose an available connection before starting it.</p>'
        : '';
      return /* html */`
        <div class="${cardCls}">
          <div class="row"><span class="name">${esc(p.name)}</span><span>${inUsePill}<span class="pill info">Coming soon</span></span></div>
          <p class="meta">${esc(p.availabilityMessage ?? 'This connection is not available in this release.')}</p>
          ${retained}
        </div>`;
    }
    if (p.authKind === 'claude-cli' || p.authKind === 'codex-cli') {
      const setup = p.presentation.setup;
      const setupAction = this.deps.openConnectionSetup
        ? `<button class="btn primary" data-command="openConnectionSetup" data-provider-id="${escAttr(p.providerId)}">${esc(setup.actionLabel)}</button>`
        : '';
      const install = setup.installCommand ? ` Install it with <code>${esc(setup.installCommand)}</code>, then run <code>${esc(setup.loginCommand ?? '')}</code>.` : '';
      const requiredSetting = setup.requiredSetting ? ` Set <code>${esc(setup.requiredSetting)}</code> to the exact executable.` : '';
      const meta = /* html */`<p class="meta"><strong>Runtime:</strong> ${esc(p.presentation.runtimeLabel)}. <strong>Billing:</strong> ${esc(p.presentation.billingLabel)}. <strong>Egress:</strong> ${esc(p.presentation.privacySummary ?? '')} No API key is stored here.${install}${requiredSetting}</p>`;
      return /* html */`
        <div class="${cardCls}">
          <div class="row"><span class="name">${esc(p.name)}</span><span>${inUsePill}${defaultPill}<span class="pill info">CLI auth</span></span></div>
          ${meta}
          <div class="actions">${setupAction}${defaultAction}</div>
      </div>`;
    }
    const pill = p.hasApiKey ? '<span class="pill set">✓ Key set</span>' : '<span class="pill unset">⚠ Not set</span>';
    const testAction = this.deps.testConnection && p.authKind === 'api-key' && p.catalogKind === 'openai-models'
      ? `<button class="btn primary" data-command="testConnection" data-provider-id="${providerId}">Test connection</button>`
      : '';
    if (isCustomGateway) {
      const actions = [
        testAction,
        this.deps.editCustomGateway ? `<button class="btn" data-command="editCustomGateway" data-provider-id="${providerId}" title="${escAttr(CUSTOM_GATEWAY_EDIT_HELP)}">Edit</button>` : '',
        defaultAction,
        this.deps.listModels ? `<button class="btn" data-command="listCustomGatewayModels" data-provider-id="${providerId}" title="Models are loaded only on request.">Load models</button>` : '',
        this.deps.archiveCustomGateway ? `<button class="btn danger" data-command="archiveCustomGateway" data-provider-id="${providerId}" title="${escAttr(CUSTOM_GATEWAY_REMOVE_HELP)}">Remove</button>` : '',
      ].filter(Boolean).join('');
      return /* html */`
        <div class="${cardCls}">
          <div class="row"><span class="name">${esc(p.name)}</span><span>${inUsePill}${defaultPill}${pill}</span></div>
          <p class="meta"><strong>Runtime:</strong> ${esc(p.presentation.runtimeLabel)}. <strong>Billing:</strong> ${esc(p.presentation.billingLabel)}. <strong>Egress:</strong> ${esc(p.presentation.privacySummary ?? '')}</p>
          <p class="meta"><strong>Credential:</strong> managed by UnodeAi · Endpoint: ${esc(p.baseUrl ?? '')}</p>
          <div class="meta" data-custom-gateway-models="${providerId}"></div>
          <div class="actions" style="margin-top:10px">${actions}</div>
        </div>`;
    }
    const secret = escAttr(p.apiKeySecretName ?? '');
    const hasSignup = !!p.presentation.signupUrl;
    const hasPricing = !!p.presentation.pricingUrl;
    const actions = !p.canManageApiKey
      ? '<span class="meta">Manage this gateway key from Settings &gt; Providers.</span>'
      : p.hasApiKey
      ? `<button class="btn" data-command="setKey" data-secret-name="${secret}">Edit</button>
         <button class="btn" data-command="deleteKey" data-secret-name="${secret}">Clear key</button>`
      : `<button class="btn primary" data-command="setKey" data-secret-name="${secret}">Set key</button>`;
    // Gateways let you top up a balance; a direct provider just issues you a key. Don't call OpenAI a gateway.
    const isGateway = p.billingKind === 'gateway-balance';
    const signupLabel = isGateway ? `${esc(p.name)} Gateway — Sign up / Top up` : `Get a ${esc(p.name)} API key`;
    const gatewayActions = [
      hasSignup ? `<button class="btn primary" data-command="openSignup" data-link-key="${providerId}">${signupLabel}</button>` : '',
      hasPricing ? `<button class="btn" data-command="openPricing" data-link-key="${providerId}">Check pricing</button>` : '',
    ].filter(Boolean).join('');
    // 0.9.8: live balance slot, only for providers that actually expose a readable account balance (Roam,
    // Unode). Filled async via the 'balance' message; hidden until it resolves, and stays hidden if the
    // endpoint can't be read — so we don't render a slot that could never resolve (e.g. custom/OpenAI).
    const balanceSlot = p.hasApiKey && p.presentation.balanceAvailable
      ? `<div class="balance" data-balance data-provider="${escAttr(p.providerId)}" hidden></div>`
      : '';
    return /* html */`
      <div class="${cardCls}">
        <div class="row"><span class="name">${esc(p.name)}</span><span>${inUsePill}${defaultPill}${pill}</span></div>
        <p class="meta"><strong>Runtime:</strong> ${esc(p.presentation.runtimeLabel)}. <strong>Billing:</strong> ${esc(p.presentation.billingLabel)}. <strong>Egress:</strong> ${esc(p.presentation.privacySummary ?? '')}</p>
        <p class="meta"><strong>Credential:</strong> ${esc(p.apiKeySecretName ?? '')}${p.baseUrl ? ' · Endpoint: ' + esc(p.baseUrl) : ''}</p>
        ${balanceSlot}
        <div class="actions" style="margin-top:10px">${testAction}${actions}${defaultAction}${gatewayActions}</div>
      </div>`;
  }

  private agentTuningCard(a: AgentTuning, defaultLabels: ModelParamDefaultLabels): string {
    const p = a.modelParams ?? {};
    const isClaude = a.backend === 'claude';
    const allowed = new Set(a.allowedModelParamKeys ?? (isClaude
      ? ['reasoning_effort']
      : ['temperature', 'top_p', 'max_tokens', 'reasoning_effort', 'presence_penalty', 'frequency_penalty', 'response_format', 'stream', 'thinking', 'tool_choice', 'stop']));
    const paramVisibility = (key: string): string => allowed.has(key) ? '' : 'hidden';
    // A card that opens on fourteen advanced knobs, every one already at a sensible default, spends a first
    // user's attention on decisions they do not have to make. So the card opens on a state line plus the two
    // controls that are genuinely reached for: reasoning effort (Owner, 2026-08-20 — "常用") and the context
    // window, the one value here whose being wrong produces a visible failure rather than a subtle one.
    // Everything else is a disclosure away. Note the save handler collects `[data-field]` from the whole
    // card, so promoting a control out of the grid changes where it sits and nothing else.
    const tunedCount = Object.keys(p).filter((key) => p[key as keyof typeof p] !== undefined).length;
    const legacyKeys = Object.keys(p).filter((key) => !allowed.has(key));
    // Claude headless has no CLI flag for these — disable them so users aren't misled (F1 matrix).
    const v = (x: number | undefined): string => (x === undefined || x === null ? '' : String(x));
    const ph = (label: string): string => escAttr(formatModelParamDefaultLabel(label));
    const checkedDefault = (isUnset: boolean) => isUnset ? 'checked' : '';
    const defaultToggle = (isUnset: boolean) =>
      `<label class="hint" style="flex-direction:row"><input type="checkbox" data-use-default ${checkedDefault(isUnset)}> Use global default</label>`;
    // Effort values are backend-specific. `max` is a Claude-CLI thing (low/medium/high/xhigh/max; older
    // Claude models fall back xhigh→high). OpenAI-compatible reasoning models top out at `xhigh` (Kimi)
    // and never accept `max` — offering it there just gets dropped, silently losing the user's intent.
    // Providers that use their own thinking controls (GLM/Qwen/Gemini) ignore reasoning_effort entirely.
    const baseEfforts = isClaude
      ? ['', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    // Keep a previously-saved out-of-list value visible (e.g. an old OpenAI-compat agent set to `max`) so
    // the dropdown reflects reality and the user can change it down, rather than silently showing default.
    const effortValues = p.reasoning_effort && !baseEfforts.includes(p.reasoning_effort)
      ? [...baseEfforts, p.reasoning_effort]
      : baseEfforts;
    const effortOpts = effortValues
      .map((o) => `<option value="${escAttr(o)}" ${p.reasoning_effort === o || (o === '' && !p.reasoning_effort) ? 'selected' : ''}>${o ? esc(o) : esc(formatModelParamDefaultLabel(defaultLabels.reasoningEffort))}</option>`)
      .join('');
    const rf = p.response_format?.type ?? '';
    const rfOpts = ['', 'text', 'json_object']
      .map((o) => `<option value="${escAttr(o)}" ${rf === o ? 'selected' : ''}>${o ? esc(o) : esc(formatModelParamDefaultLabel(defaultLabels.responseFormat))}</option>`)
      .join('');
    const stream = p.stream === undefined ? '' : String(p.stream);
    const streamOpts = ['', 'true', 'false']
      .map((o) => `<option value="${escAttr(o)}" ${stream === o ? 'selected' : ''}>${o ? esc(o) : esc(formatModelParamDefaultLabel(defaultLabels.stream))}</option>`)
      .join('');
    const thinkingType = p.thinking?.type ?? '';
    const thinkingOpts = ['', 'enabled', 'disabled']
      .map((o) => `<option value="${escAttr(o)}" ${thinkingType === o ? 'selected' : ''}>${o ? esc(o) : esc(formatModelParamDefaultLabel(defaultLabels.thinking))}</option>`)
      .join('');
    const thinkingBudget = p.thinking?.type === 'enabled' ? p.thinking.budget_tokens : undefined;
    const stopValue = Array.isArray(p.stop) ? p.stop.join('\n') : (p.stop ?? '');
    const claudeHint = isClaude
      ? '<p class="hint">Claude backend: only <b>Reasoning Effort</b> and <b>Context Window</b> apply (the others have no CLI flag and are ignored).</p>'
      : '';
    const capabilityHint = a.allowedModelParamKeys
      ? `<p class="hint">This connection accepts: <b>${esc([...allowed].join(', ') || 'no model parameters')}</b>. Fields not listed are not sent.</p>`
      : claudeHint;
    const legacyNotice = legacyKeys.length > 0
      ? `<p class="hint"><b>Legacy values preserved:</b> ${esc(legacyKeys.join(', '))}. They are not sent on this route. <label><input type="checkbox" data-remove-legacy> Remove these values when I save</label></p>`
      : '';
    const profile = this.capabilityProfileCard(a.capabilityProfile);
    const contextSummary = a.contextWindowTokens
      ? `context window ${a.contextWindowTokens.toLocaleString()}`
      : 'context window: default';
    const tuningSummary = tunedCount > 0
      ? `<span class="pill set">${tunedCount} parameter${tunedCount === 1 ? '' : 's'} tuned</span> <span class="hint">${esc(contextSummary)}</span>`
      : `<span class="pill unset">All defaults</span> <span class="hint">${esc(contextSummary)} — nothing here needs changing to start</span>`;
    const ref = /* html */`<details class="ref"><summary>i</summary><div class="refbody">
      <b>Context window</b> = max tokens a model considers at once. It <b>varies by model</b> — there is no universal default.
      <ul>
        <li><b>Find yours</b>: check your provider's model docs/spec page. Rough ranges (verify for your exact model — they change often): many GPT/Claude 128K–200K; Gemini up to 1M+; some open models 32K–64K.</li>
        <li><b>Why set it</b>: UnodeAi compacts at 70% and stops new tool calls at 80% of this number, to avoid the degradation band near the limit. Set it to the model's real window.</li>
        <li><b>Bigger isn't free</b>: a larger window holds more context but costs more tokens/latency per call and asks the model to reason over more — set the model's actual limit, don't inflate it.</li>
      </ul></div></details>`;
    return /* html */`
      <div class="card" data-agent="${escAttr(a.id)}">
        <div class="row">
          <span class="name">${esc(a.name)} <span class="meta">${esc(a.role)} · <span title="${escAttr(a.providerId)}">${esc(this.providerDisplayName(a.providerId))}</span> · ${esc(a.backend)} · ${esc(a.model)}</span></span>
          <button class="btn primary" data-save="${escAttr(a.id)}">Save</button>
        </div>
        <div class="tuning-summary">${tuningSummary}</div>
        <div class="grid tuning-quick">
          <div class="field" data-field-wrap ${paramVisibility('reasoning_effort')}><label title="Reasoning effort (model-dependent).">Reasoning Effort</label><select data-field="reasoning_effort">${effortOpts}</select>${defaultToggle(p.reasoning_effort === undefined)}</div>
          <div class="field"><label>Context Window (tokens) ${ref}</label><input type="number" data-field="contextWindowTokens" min="1" step="1000" placeholder="${escAttr(defaultLabels.contextWindow)}" value="${v(a.contextWindowTokens)}"></div>
        </div>
        <details class="tuning-advanced">
          <summary>Advanced model parameters</summary>
        ${capabilityHint}
        ${profile}
        ${legacyNotice}
        <div class="grid">
          <div class="field" data-field-wrap ${paramVisibility('temperature')}><label title="Sampling randomness, 0-2.">Temperature</label><input type="number" data-field="temperature" min="0" max="2" step="0.1" value="${v(p.temperature)}" placeholder="${ph(defaultLabels.temperature)}">${defaultToggle(p.temperature === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('top_p')}><label title="Nucleus sampling, 0-1.">Top P</label><input type="number" data-field="top_p" min="0" max="1" step="0.05" value="${v(p.top_p)}" placeholder="${ph(defaultLabels.topP)}">${defaultToggle(p.top_p === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('max_tokens')}><label title="Maximum output tokens.">Max Tokens</label><input type="number" data-field="max_tokens" min="1" step="1" value="${v(p.max_tokens)}" placeholder="${ph(defaultLabels.maxTokens)}">${defaultToggle(p.max_tokens === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('presence_penalty')}><label title="Encourage/discourage new topics.">Presence Penalty</label><input type="number" data-field="presence_penalty" min="-2" max="2" step="0.1" value="${v(p.presence_penalty)}" placeholder="${ph(defaultLabels.presencePenalty)}">${defaultToggle(p.presence_penalty === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('frequency_penalty')}><label title="Discourage repeated tokens.">Frequency Penalty</label><input type="number" data-field="frequency_penalty" min="-2" max="2" step="0.1" value="${v(p.frequency_penalty)}" placeholder="${ph(defaultLabels.frequencyPenalty)}">${defaultToggle(p.frequency_penalty === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('response_format')}><label title="Text or JSON object output.">Response Format</label><select data-field="response_format">${rfOpts}</select>${defaultToggle(p.response_format === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('stream')}><label title="Streaming request preference where supported.">Stream</label><select data-field="stream">${streamOpts}</select>${defaultToggle(p.stream === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('thinking')}><label title="Provider thinking mode where supported.">Thinking</label><select data-field="thinking_type">${thinkingOpts}</select>${defaultToggle(p.thinking === undefined)}</div>
          <div class="field" ${paramVisibility('thinking')}><label title="Optional thinking budget tokens.">Thinking Budget</label><input type="number" data-field="thinking_budget_tokens" min="1" step="1" value="${v(thinkingBudget)}" placeholder="${formatModelParamDefaultLabel(PROVIDER_DEFAULT_MODEL_PARAM_LABEL)}"></div>
          <div class="field" data-field-wrap ${paramVisibility('tool_choice')}><label title="Tool-choice preference: auto, none, or provider-specific value.">Tool Choice</label><input type="text" data-field="tool_choice" value="${escAttr(p.tool_choice ?? '')}" placeholder="${ph(defaultLabels.toolChoice)}">${defaultToggle(p.tool_choice === undefined)}</div>
          <div class="field" data-field-wrap ${paramVisibility('stop')}><label title="One stop sequence per line, max 4.">Stop Sequences</label><textarea data-field="stop" rows="3" placeholder="${ph(defaultLabels.stop)}">${esc(stopValue)}</textarea>${defaultToggle(p.stop === undefined)}</div>
        </div>
        </details>
      </div>`;
  }

  private capabilityProfileCard(profile: CapabilityProfile | undefined): string {
    if (!profile) return '';
    const rows = [
      this.capabilityFactRow('Tool protocol', profile.protocol, (value) => {
        const protocol = value as CapabilityProfile['protocol']['effective']['value'];
        return `${protocol.initial}; text-leak fallback: ${protocol.fallbackAfterTextLeak}${protocol.knownNativeToolLeakRisk ? '; declared leak risk' : ''}`;
      }),
      this.capabilityFactRow('Sampling parameters', profile.samplingParameters, (value) => String(value)),
      this.capabilityFactRow('Context window', profile.contextWindow, (value) => {
        const context = value as CapabilityProfile['contextWindow']['effective']['value'];
        return `${context.tokens ? `${context.tokens} tokens; ` : ''}compact at ${context.compactionThreshold * 100}%, stop tools at ${context.toolStopThreshold * 100}%`;
      }),
      this.capabilityFactRow('Recovery', profile.recovery, (value) => {
        const recovery = value as CapabilityProfile['recovery']['effective']['value'];
        return `${recovery.samplingParameter400}; ${recovery.textToolCall}; ${recovery.requestShape}`;
      }),
    ].join('');
    return /* html */`
      <details class="ref capability-profile" data-capability-profile="${escAttr(profile.key)}">
        <summary>Capability profile — ${esc(this.providerDisplayName(profile.connectionId))} × ${esc(profile.modelId)}</summary>
        <div class="refbody"><p class="hint">Effective facts use <b>user override → observed this session → declared</b>. Observations are not saved automatically.</p><ul>${rows}</ul></div>
      </details>`;
  }

  private capabilityFactRow<T>(label: string, fact: CapabilityFact<T>, format: (value: T) => string): string {
    const evidence = [fact.userOverride, fact.observed, fact.declared].filter((item): item is CapabilityEvidence<T> => !!item);
    const facts = evidence.map((item) => {
      const at = item.observedAt ? ` (${item.observedAt})` : '';
      return `<li><b>${esc(item.source)}</b>: ${esc(format(item.value))}${esc(at)} — ${esc(item.detail)}</li>`;
    }).join('');
    return `<li><b>${esc(label)}</b> <span class="pill info">effective: ${esc(fact.effective.source)}</span><ul>${facts}</ul></li>`;
  }

  private smartModeSection(s: SmartModeView, agents: AgentTuning[]): string {
    const tiers: ModelTier[] = ['premium', 'standard', 'economy'];
    const tierSelect = (current: string, dataAttrs: string, withDefault: boolean, roleDefault?: ModelTier): string => {
      const opts = [...(withDefault ? [''] : []), ...tiers]
        .map((t) => `<option value="${t}" ${current === t ? 'selected' : ''}>${t || `${roleDefault ?? s.defaultTier} (role default)`}</option>`)
        .join('');
      return `<select ${dataAttrs}>${opts}</select>`;
    };

    // Editable tier → provider → model matrix.
    const header = `<tr><th>Tier</th>${s.providerIds.map((p) => `<th title="${escAttr(p)}">${esc(this.providerDisplayName(p))}</th>`).join('')}</tr>`;
    const rows = tiers.map((t) => {
      const cells = s.providerIds
        .map((prov) => {
          const model = s.modelTiers[t]?.[prov] ?? '';
          return `<td><input type="text" value="${escAttr(model)}" data-smart="modelTierCell" data-tier="${t}" data-provider="${escAttr(prov)}" list="models-${escAttr(prov)}" autocomplete="off" placeholder="model id"></td>`;
        })
        .join('');
      return `<tr><td class="name">${t}</td>${cells}</tr>`;
    }).join('');

    const roleRows = agents.length === 0
      ? '<div class="meta">Add agents to set per-role tiers.</div>'
      : agents
          .map((a) => {
            // Show which provider this agent uses + the model its tier resolves to ON that provider, so the
            // per-agent / per-provider cost arbitrage is visible (each agent's tier → its provider's model).
            const tier = s.roleTiers[a.role] ?? s.defaultTier;
            const roleDefault = ROLE_TEMPLATES[a.role]?.tier ?? s.defaultTier;
            // Model ids are PROVIDER-SPECIFIC (e.g. claude-opus-4-8 vs anthropic/claude-opus-4). Only an
            // EXACT provider+tier entry is correct; modelForTier's cross-provider fallback would 400 here,
            // so flag it as "not set for this provider" rather than showing a wrong id as if it'll work.
            const exact = s.modelTiers[tier]?.[a.providerId];
            const providerName = this.providerDisplayName(a.providerId);
            // The model/warning text lives in a data-smart-model span so the webview can recompute it in
            // place after a tier/matrix edit (saveSmart doesn't re-render, to avoid the tab jump).
            const modelText = exact
              ? ` → ${esc(exact)}`
              : ` → ⚠ no ${esc(providerName)} model for “${esc(tier)}” — set it in the tier matrix below`;
            const warnStyle = exact ? '' : ' style="color:var(--vscode-errorForeground)"';
            return `<div class="row" data-smart-row data-smart-role="${escAttr(a.role)}" data-smart-provider="${escAttr(a.providerId)}" style="margin:6px 0">
            <span>${esc(a.name)} <span class="meta">${esc(a.role)} · <span title="${escAttr(a.providerId)}">${esc(providerName)}</span><span data-smart-model${warnStyle}>${modelText}</span></span></span>
            ${tierSelect(s.roleTiers[a.role] ?? '', `data-smart="roleTier" data-role="${escAttr(a.role)}"`, true, roleDefault)}
          </div>`;
          })
          .join('');
    const hintsJson = esc(JSON.stringify(s.taskTierHints ?? {}, null, 2));

    return /* html */`
      <div class="card">
        <div class="row">
          <span class="name">Smart Mode</span>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-smart="enabled" ${s.enabled ? 'checked' : ''}> Enabled
          </label>
        </div>
        <p class="meta">Auto-pick a model tier per task instead of a fixed model per agent. Precedence:
        explicit task tier → task-type hint → role override → role template → default tier. Applies on the
        agent's next turn (OpenAI-compatible backends). Saved to VS Code settings (<code>unode.smartMode.*</code>).</p>
        <div class="field" style="max-width:220px;margin-top:8px">
          <label>Default tier</label>
          ${tierSelect(s.defaultTier, 'data-smart="defaultTier"', false)}
        </div>
      </div>

      <div class="card">
        <div class="name">Tier → model matrix</div>
        <p class="meta">Each tier's model per provider (the "2–3 models" each role can run). Edits save to
        <code>unode.modelTiers</code>; blanks fall back to the built-in defaults.</p>
        <p class="meta" style="color:var(--vscode-errorForeground)">⚠ Use each provider's <b>exact</b> model id — the
        same model is named differently per provider (e.g. <code>claude-opus-4-8</code> on Roam/Anthropic vs
        <code>anthropic/claude-opus-4</code> on OpenRouter). A blank cell falls back to another provider's id, which
        won't resolve there — fill the column for every provider your agents use.</p>
        <table class="matrix"><thead>${header}</thead><tbody>${rows}</tbody></table>
        ${s.providerIds.map((p) => `<datalist id="models-${escAttr(p)}"></datalist>`).join('')}
      </div>

      <div class="card">
        <div class="name">Per-role tier</div>
        <p class="meta">Override the tier for an agent's role (blank = use the role's template tier).</p>
        ${roleRows}
      </div>

      <div class="card">
        <div class="name">Task tier hints</div>
        <p class="meta">Map message types to tiers, for example <code>{ "review.request": "economy" }</code>.</p>
        <textarea data-task-tier-hints rows="5" style="width:100%;font-family:var(--vscode-editor-font-family, monospace)">${hintsJson}</textarea>
        <div style="margin-top:8px"><button class="btn" data-save-task-hints="1">Save hints</button></div>
      </div>`;
  }

  private mcpRow(m: McpServerStatus): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const conn = m.connected ? `<span class="pill set">connected · ${m.toolCount} tools</span>` : '<span class="pill info">not connected</span>';
    const approval = m.requiresApproval ? '<span class="pill unset approval">requires approval</span>' : '';
    const granted = m.grantedTo.length > 0 ? `granted to: ${m.grantedTo.map(esc).join(', ')}` : 'not granted to any agent';
    return /* html */`
      <div class="card">
        <div class="row"><span class="name">${esc(m.name)} <span class="meta">${esc(m.transport)}</span></span><span>${conn} ${approval}</span></div>
        <p class="meta">${granted}</p>
      </div>`;
  }

  private isAllowedSecretName(secretName: unknown): secretName is string {
    return typeof secretName === 'string' && this.allowedSecretNames.has(secretName);
  }

  private isKnownProviderId(providerId: unknown): providerId is string {
    return typeof providerId === 'string' && this.knownProviderIds.has(providerId);
  }

  private providerForMessage(providerId: unknown): ProviderStatus | undefined {
    return typeof providerId === 'string' ? this.lastProviders.get(providerId) : undefined;
  }

  private customProviderForMessage(providerId: unknown): ProviderStatus | undefined {
    const provider = this.providerForMessage(providerId);
    return provider?.connectionId?.startsWith('custom:') ? provider : undefined;
  }
}
