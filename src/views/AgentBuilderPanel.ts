/*---------------------------------------------------------------------------------------------
 *  UnodeAi - AgentBuilderPanel
 *  Form webview for composing a custom agent: identity, model, instructions, capability tools,
 *  skill playbooks, and MCP grants. Host-side save wiring lives in extension.ts.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  SkillCategory, AgentModelParams, ModelTier, FolderGrant, AgentBackendKind,
  AgentCommandNarrowing, CommandApprovalMode,
} from '../types';
import { MarketplaceCatalog, SkillCatalogEntry } from '../marketplace/catalog';
import { stripPlaybooks } from '../marketplace/install';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import { byDisplayName } from './displayOrder';
import { AGENT_ICON_PALETTE } from '../roles/agentIconPalette';
import { MAX_AGENT_ICON_DATA_URI_LENGTH, sanitizeAgentIcon } from './agentIcon';
import { sanitizeParams, sanitizeContextWindow } from '../params/sanitizeModelParams';
import {
  capabilityProfile,
  DECLARED_PROTOCOL_LEAK_MODEL_HINTS,
  DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY,
  omitIncompatibleSamplingParameters,
  SAMPLING_PARAMETER_KEYS,
  SAMPLING_PARAMETER_REJECTION_REASON,
} from '../capabilities/CapabilityProfile';
import {
  DEFAULT_MODEL_PARAM_DEFAULT_LABELS,
  formatModelParamDefaultLabel,
  ModelParamDefaultLabels,
  PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
} from '../params/ModelParamResolver';
import { AgentBuilderFormRefreshGate } from './PanelRefreshControl';
import { stableProviderSort } from '../routes/stableProviderSort';

export interface AgentBuilderRoleOption {
  id: string;
  name: string;
  role: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt: string;
  skillIds: string[];
  playbookIds: string[];
  model: string;
  providerId: string;
  tier?: ModelTier;
}

export interface AgentBuilderProviderOption {
  id: string;
  /** Canonical registry id; id remains the legacy persistence adapter until E3 migration. */
  connectionId?: string;
  name: string;
  baseUrl?: string;
  models: AgentBuilderModelOption[];
  runtimeLabel?: string;
  billingLabel?: string;
  privacySummary?: string;
  /** A retained legacy route can be shown, but cannot be selected or fetched. */
  availability?: 'available' | 'coming-soon';
  availabilityMessage?: string;
  /** Registry capability map, copied into the webview only for visibility filtering. */
  allowedModelParamKeys?: readonly string[];
  /** Context-window overrides are a route capability, not a model sampling parameter. */
  contextWindowAvailable?: boolean;
  supportedToolKeys?: readonly string[];
  skillsAvailable?: boolean;
  folderAccessAvailable?: boolean;
  toolProtocolAvailable?: boolean;
  smartModeAvailable?: boolean;
  mcpAvailable?: boolean;
  coordinatorAvailable?: boolean;
  capabilitySummary?: string;
}

export interface AgentBuilderModelOption {
  id: string;
  name: string;
  price?: string;
}

export interface AgentBuilderCapabilityOption {
  id: string;
  name: string;
  description: string;
  category: string;
  /** High-level tool tokens this skill would grant; host-derived, never browser-authored. */
  requiredTools?: readonly string[];
}

export interface AgentBuilderMcpOption {
  id: string;
  name: string;
  transport: string;
  connected: boolean;
  requiresApproval: boolean;
}

export interface AgentBuilderInitialAgent {
  id: string;
  name: string;
  role: string;
  /** Stable shipped-template identity; differs from `role` for knowledge-work templates. */
  roleKey?: string;
  roleLabel: string;
  icon?: string;
  color?: string;
  providerId: string;
  model: string;
  fallbackModel?: string;
  toolProtocol?: 'auto' | 'native' | 'xml';
  systemPrompt: string;
  skillIds: string[];
  playbooks: string[];
  mcpServers: string[];
  /** Per-agent model fine-tuning (sampling/effort), pre-filled into the editable section. */
  modelParams?: AgentModelParams;
  /** Per-agent context-window override (tokens); 0/undefined = the default context window. */
  contextWindowTokens?: number;
  /** Per-agent Smart Mode tier override ('' = follow the role/default tier). */
  tier?: ModelTier | '';
  /** Whether Smart Mode is enabled globally (read-only context for the tier section). */
  smartModeEnabled?: boolean;
  /** Runtime backend used for backend-specific access warnings. */
  backend?: AgentBackendKind;
  /** Per-agent filesystem access grants. Absent/empty = workspace default. */
  folderAccess?: FolderGrant[];
  /** Host-resolved folder access issues for the saved grants. */
  folderAccessIssues?: Array<{ kind: string; path: string; message: string }>;
  /** Optional per-agent ceiling over the workspace command policy. */
  commandNarrowing?: AgentCommandNarrowing;
  /** Template provenance and any available default-to-default update diff. */
  promptTemplate?: {
    state: 'template-current' | 'custom-current' | 'custom-outdated' | 'custom-origin-unknown' | 'custom-no-template';
    label: string;
    detail: string;
    showUpdateNotice: boolean;
    diff?: string;
    canReset: boolean;
    canUndo: boolean;
  };
}

export interface AgentBuilderViewModel {
  mode: 'new' | 'edit';
  agent?: AgentBuilderInitialAgent;
  /**
   * `unode.defaultProvider` — the provider the user picked in Setup / "Set as default". A new agent must open
   * on it. Without this the builder fell back to whichever provider happened to be first in the list, so
   * setting up with Roam or Claude Headless and then building an agent silently handed you a different one.
   */
  defaultProviderId?: string;
  roles: AgentBuilderRoleOption[];
  providers: AgentBuilderProviderOption[];
  capabilities: AgentBuilderCapabilityOption[];
  mcpServers: AgentBuilderMcpOption[];
  catalog: MarketplaceCatalog;
  skillLibraryUrl: string;
  /** The only command templates an agent may be offered to select. */
  globalCommandPolicy?: { approvalMode: CommandApprovalMode; allowedCommands: string[] };
}

export interface AgentBuilderSavePayload {
  id?: string;
  name: string;
  roleKey: string;
  /** True only when the USER set the icon — a preset click, an upload, or typing in the field. The panel
   *  fills the field with the role's default on every role switch, so `icon` alone cannot distinguish a
   *  choice from a default, and de-duplication has to know which it is. */
  iconExplicit?: boolean;
  /** The user confirmed replacing their existing instructions while switching templates. */
  roleTemplateAdopted?: boolean;
  /**
   * Instructions text a role switch replaced and the user did not restore in-panel. It must travel with the
   * save: it used to live only in webview memory, so a NEW agent's hand-written prompt died with the panel.
   */
  roleSwitchStashedPrompt?: string;
  customRole?: string;
  icon?: string;
  color?: string;
  providerId: string;
  model: string;
  fallbackModel?: string;
  toolProtocol?: 'auto' | 'native' | 'xml';
  systemPrompt: string;
  skillIds: string[];
  playbooks: string[];
  mcpServers: string[];
  /** Per-agent model fine-tuning, parsed from the editable section. */
  modelParams?: AgentModelParams;
  removeLegacyModelParams?: boolean;
  /** Per-agent context-window override (tokens); undefined = the default context window. */
  contextWindowTokens?: number;
  /** Per-agent Smart Mode tier override (undefined = follow the role/default tier). */
  tier?: ModelTier;
  /** Per-agent filesystem access grants. Undefined/empty = workspace default. */
  folderAccess?: FolderGrant[];
  /** Per-agent command ceiling. Undefined = inherit the global command policy. */
  commandNarrowing?: AgentCommandNarrowing;
}

export interface AgentBuilderPanelDeps {
  getViewModel: (agentId?: string) => Promise<AgentBuilderViewModel> | AgentBuilderViewModel;
  listModels: (providerId: string, baseUrl?: string) => Promise<AgentBuilderModelOption[]> | AgentBuilderModelOption[];
  save: (payload: AgentBuilderSavePayload) => Promise<{ ok: boolean; message: string }>;
  pickIcon: () => Promise<string | undefined> | string | undefined;
  pickFolderAccessFolder: () => Promise<string | undefined> | string | undefined;
  resolveFolderAccessIssues: (grants: FolderGrant[]) => Promise<Array<{ kind: string; path: string; message: string }>> | Array<{ kind: string; path: string; message: string }>;
  /** Host-resolved labels for blank model-param options. The option value still stays empty/unset. */
  modelParamDefaultLabels?: () => ModelParamDefaultLabels;
  openSkillLibrary: () => Promise<void> | void;
  addMcpServer: () => Promise<void> | void;
  /** Explicit choices for a customized prompt whose role template has changed. */
  promptTemplateAction?: (
    agentId: string,
    action: 'dismiss' | 'adopt' | 'undo'
  ) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string };
}

export class AgentBuilderPanel {
  public static current: AgentBuilderPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private viewModel: AgentBuilderViewModel | undefined;
  private readonly formRefreshGate = new AgentBuilderFormRefreshGate();

  static createOrShow(extensionUri: vscode.Uri, deps: AgentBuilderPanelDeps, agentId?: string): void {
    if (AgentBuilderPanel.current) {
      AgentBuilderPanel.current.deps = deps;
      AgentBuilderPanel.current.agentId = agentId;
      AgentBuilderPanel.current.panel.reveal();
      void AgentBuilderPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeAgentBuilder',
      agentId ? 'Edit Agent' : 'Build an Agent',
      vscode.ViewColumn.One,
      // Narrowed to the single command the panel links to (the "Manage in Settings →" link), rather than
      // enabling ALL command URIs in a webview that renders dynamic catalog/agent content.
      { enableScripts: true, enableCommandUris: ['unode.openSettings'], retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    AgentBuilderPanel.current = new AgentBuilderPanel(panel, deps, agentId);
  }

  static refreshCurrent(): void {
    if (AgentBuilderPanel.current) {
      void AgentBuilderPanel.current.refreshForRegistryChange();
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private deps: AgentBuilderPanelDeps,
    private agentId?: string
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    // When the builder regains focus (e.g. after installing a server in the MCP Marketplace), refresh just
    // the MCP grant list so the new server appears — WITHOUT re-rendering the form (preserves unsaved edits).
    this.panel.onDidChangeViewState(() => { if (this.panel.visible) { void this.refreshMcpServers(); } }, null, this.disposables);
    void this.render();
  }

  /** Re-fetch the registered MCP servers and push them to the webview, preserving current selections. */
  private async refreshMcpServers(): Promise<void> {
    if (!this.viewModel) {
      return;
    }
    try {
      const vm = await this.deps.getViewModel(this.agentId);
      this.viewModel = vm; // keep validation sets (mcpIds) in sync so a newly-installed server saves
      void this.panel.webview.postMessage({ command: 'mcpServers', servers: vm.mcpServers });
    } catch {
      /* best-effort refresh */
    }
  }

  private async onMessage(msg: { command?: unknown; payload?: unknown; rowId?: unknown; action?: unknown }): Promise<void> {
    if (!msg || typeof msg.command !== 'string') {
      return;
    }
    try {
      if (msg.command === 'formDirty') {
        this.formRefreshGate.markDirty();
        return;
      }
      if (msg.command === 'cancel') {
        this.panel.dispose();
        return;
      }
      if (msg.command === 'browseSkillLibrary') {
        await this.deps.openSkillLibrary();
        return;
      }
      if (msg.command === 'addMcpServer') {
        // Open the MCP Marketplace (non-blocking — returns as soon as it opens). Do NOT re-render here: the
        // builder's webview is kept alive (retainContextWhenHidden) so the in-progress form survives the
        // round-trip; when the user returns, onDidChangeViewState refreshes just the MCP grant list.
        await this.deps.addMcpServer();
        return;
      }
      if (msg.command === 'agentBuilderPickIcon') {
        const icon = await this.deps.pickIcon();
        if (icon) {
          void this.panel.webview.postMessage({ command: 'iconPicked', icon });
        }
        return;
      }
      if (msg.command === 'pickFolderAccessFolder') {
        const rowId = typeof msg.rowId === 'string' ? msg.rowId : '';
        const folderPath = await this.deps.pickFolderAccessFolder();
        if (folderPath && rowId) {
          void this.panel.webview.postMessage({ command: 'folderAccessFolderPicked', rowId, path: folderPath });
        }
        return;
      }
      if (msg.command === 'validateFolderAccess') {
        const grants = parseFolderAccess(msg.payload);
        const seq = typeof (msg as { seq?: unknown }).seq === 'number' ? (msg as { seq: number }).seq : 0;
        const issues = grants ? await this.deps.resolveFolderAccessIssues(grants) : [];
        void this.panel.webview.postMessage({ command: 'folderAccessIssues', seq, issues });
        return;
      }
      if (msg.command === 'listModels' && this.viewModel) {
        const providerId = typeof (msg as { providerId?: unknown }).providerId === 'string'
          ? (msg as { providerId: string }).providerId
          : '';
        const baseUrl = typeof (msg as { baseUrl?: unknown }).baseUrl === 'string'
          ? (msg as { baseUrl: string }).baseUrl
          : undefined;
        if (!this.viewModel.providers.some((p) => p.id === providerId)) {
          return;
        }
        const models = await this.deps.listModels(providerId, baseUrl);
        void this.panel.webview.postMessage({ command: 'models', providerId, models });
        return;
      }
      if (msg.command === 'promptTemplateAction' && this.agentId && this.deps.promptTemplateAction) {
        const action = msg.action === 'dismiss' || msg.action === 'adopt' || msg.action === 'undo'
          ? msg.action
          : undefined;
        if (!action) {
          return;
        }
        const result = await this.deps.promptTemplateAction(this.agentId, action);
        const show = result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
        void show(`UnodeAi Agent Builder: ${result.message}`);
        if (result.ok) {
          await this.render();
        }
        return;
      }
      if (msg.command === 'save' && this.viewModel) {
        const payload = parseAgentBuilderSavePayload(msg.payload, this.viewModel);
        if (!payload) {
          const reason = describeAgentBuilderSaveProblem(msg.payload, this.viewModel) ?? 'some fields are missing or invalid.';
          void vscode.window.showWarningMessage(`UnodeAi Agent Builder: ${reason}`);
          return;
        }
        const result = await this.deps.save(payload);
        const show = result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
        void show(`UnodeAi Agent Builder: ${result.message}`);
        if (result.ok) {
          this.panel.dispose();
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`UnodeAi Agent Builder: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A registry refresh must preserve uncommitted webview state; only its MCP list is safe to patch. */
  private async refreshForRegistryChange(): Promise<void> {
    if (this.formRefreshGate.isDirty) {
      await this.refreshMcpServers();
      return;
    }
    await this.render(true);
  }

  private async render(preserveUnsaved = false): Promise<void> {
    const revision = this.formRefreshGate.currentRevision;
    const viewModel = await this.deps.getViewModel(this.agentId);
    if (preserveUnsaved && !this.formRefreshGate.canReplaceHtml(revision)) {
      this.viewModel = viewModel;
      return;
    }
    this.viewModel = viewModel;
    this.panel.title = this.viewModel.mode === 'edit' ? `Edit ${this.viewModel.agent?.name ?? 'Agent'}` : 'Build an Agent';
    this.panel.webview.html = renderAgentBuilderHtml(this.panel.webview, this.viewModel, this.deps.modelParamDefaultLabels?.() ?? DEFAULT_MODEL_PARAM_DEFAULT_LABELS);
    this.formRefreshGate.markRendered();
  }

  private dispose(): void {
    AgentBuilderPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

export function renderAgentBuilderHtml(
  webview: vscode.Webview,
  view: AgentBuilderViewModel,
  defaultLabels: ModelParamDefaultLabels = DEFAULT_MODEL_PARAM_DEFAULT_LABELS
): string {
  const scriptNonce = nonce();
  const initial = initialFormState(view);
  const initialProvider = view.providers.find((provider) => provider.id === initial.providerId);
  const initialToolProtocolNotice = toolProtocolCapabilityNotice(
    initial.model,
    initialProvider?.toolProtocolAvailable !== false,
  );
  const categories = uniqueCategories(view.catalog.skills);
  const roleOptions = view.roles.map((r) =>
    `<option value="${escAttr(r.id)}" ${initial.roleKey === r.id ? 'selected' : ''}>${esc(r.name)}</option>`
  ).join('');
  const sortedProviders = stableProviderSort(view.providers, (p) => p.id);
  const providerOptions = sortedProviders.map((p) =>
    `<option value="${escAttr(p.id)}"${initial.providerId === p.id ? ' selected' : ''}${p.availability === 'coming-soon' ? ' disabled' : ''}>${esc(p.name)}${p.availability === 'coming-soon' ? ' — Coming soon' : ''}</option>`
  ).join('');
  const categoryOptions = categories.map((c) => `<option value="${escAttr(c)}">${esc(labelForCategory(c))}</option>`).join('');
  const initialRoleDefaultTier = view.roles.find((r) => r.id === initial.roleKey)?.tier ?? 'standard';
  const responseFormat = initial.modelParams.response_format?.type ?? '';
  const responseFormatOptions: Array<[string, string]> = [
    ['', 'Text (provider default)'],
    ['text', 'Text'],
    ['json_object', 'JSON object (structured output)'],
  ];
  // The whole palette, not a sample of it: picking an icon is how you stop two agents looking alike,
  // and you cannot pick from glyphs you were never shown. Codicons stay at the front as the neutral
  // option for anyone who does not want an emoji.
  const iconPresets = ['$(robot)', '$(beaker)', '$(shield)', ...AGENT_ICON_PALETTE];
  const promptTemplate = promptTemplateStatusCard(initial.promptTemplate);

  return withAgentBuilderDefaultLabels(/* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${view.mode === 'edit' ? 'Edit Agent' : 'Build an Agent'}</title>
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
    h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    h2 { margin: 0 0 10px; font-size: 14px; }
    .topbar { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
    .subtitle { margin: 4px 0 0; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
    .main { display: flex; flex-direction: column; gap: 12px; }
    /* Every section owns its less-common choices. A closed disclosure is informative by itself and its
       state always remains the user's choice. */
    .section-advanced { margin-top: 12px; }
    .section-advanced > summary {
      cursor: pointer; list-style: none; user-select: none;
      display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
      font-weight: 600;
    }
    .section-advanced > summary::-webkit-details-marker { display: none; }
    .section-advanced > summary::before { content: '\\25B8'; font-weight: 400; }
    .section-advanced[open] > summary::before { content: '\\25BE'; }
    .section-advanced > summary:hover { background: var(--vscode-list-hoverBackground); }
    .section-advanced > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .advanced-hint { font-weight: 400; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .advanced-notice { color: var(--vscode-inputValidation-warningForeground, #b58100); font-size: 12px; }
    .section-advanced[open] > summary { margin-bottom: 8px; }
    .selection-heading { margin: 12px 0 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }

    .panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-input-background);
      padding: 14px;
    }
    .command-narrowing { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border); }
    .command-narrowing h3 { margin: 0 0 6px; font-size: 13px; }
    .command-narrowing-options { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0; }
    .command-narrowing-options label { display: inline-flex; align-items: center; gap: 5px; }
    .command-narrowing-options input { width: auto; min-height: 0; }
    .command-narrowing-list { display: grid; gap: 5px; max-height: 180px; overflow-y: auto; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
    .command-narrowing-list label { display: flex; align-items: center; gap: 7px; }
    .command-narrowing-list input { width: auto; min-height: 0; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .icon-picker { display: flex; flex-direction: column; gap: 6px; }
    .icon-row { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: start; }
    .icon-preview {
      width: 42px;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      overflow: hidden;
      font-size: 20px;
      line-height: 1;
    }
    .icon-preview img { width: 100%; height: 100%; object-fit: cover; }
    .icon-controls { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .icon-input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    /* 60+ choices: wrap them and bound the height, so the palette cannot push the rest of the form
       off the screen. */
    .icon-presets { display: flex; flex-wrap: wrap; gap: 4px; max-height: 132px; overflow-y: auto; padding-right: 2px; }
    .icon-choice {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font: inherit;
    }
    .icon-choice:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .icon-choice.codicon { width: auto; min-width: 56px; padding: 0 6px; font-size: 11px; }
    label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    input, select, textarea {
      width: 100%;
      min-height: 28px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 5px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }
    /* Dropdowns must use the dedicated dropdown theme tokens, not the generic input ones — otherwise the
       option popup renders unreadable (white background / grey text) in Cursor and other dark themes. */
    select { color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); }
    select option { color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); }
    textarea { min-height: 180px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.45; }
    .help { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .prompt-template-status { margin: 0 0 10px; padding: 9px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .prompt-template-status[data-prompt-template-state="custom-outdated"] { border-color: var(--vscode-inputValidation-warningBorder, #b58100); }
    .prompt-template-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .prompt-template-diff { margin-top: 8px; }
    .prompt-template-diff summary { color: var(--vscode-textLink-foreground); cursor: pointer; }
    .prompt-template-diff pre { max-height: 260px; overflow: auto; margin: 7px 0 0; padding: 8px; white-space: pre-wrap; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); }
    .toolbar { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(110px, .8fr) minmax(110px, .8fr) minmax(110px, .8fr); gap: 8px; margin-bottom: 10px; }
    .skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
    .skill-card {
      min-height: 118px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .skill-card.selected { border-color: var(--vscode-focusBorder); }
    .skill-head { display: flex; gap: 8px; align-items: flex-start; }
    .skill-title { font-weight: 700; line-height: 1.25; }
    .summary { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.35; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .tagline { display: flex; flex-wrap: wrap; gap: 5px; margin-top: auto; }
    .tag { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; }
    .check { display: flex; align-items: flex-start; gap: 7px; padding: 6px; border-radius: 6px; }
    .check:hover { background: var(--vscode-list-hoverBackground); }
    .check input { width: auto; min-height: auto; margin-top: 2px; }
    .folder-access-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .folder-access-row { display: grid; grid-template-columns: minmax(0, 1fr) 130px auto auto; gap: 6px; align-items: end; }
    .folder-access-row .btn { min-width: 0; white-space: nowrap; }
    .folder-issues { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .folder-issue { color: var(--vscode-editorWarning-foreground); font-size: 12px; line-height: 1.35; }
    .side { position: sticky; top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .selected-list { display: flex; flex-direction: column; gap: 6px; }
    .selected-item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 7px; }
    .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
    .status-line { min-height: 17px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .btn {
      min-height: 28px;
      padding: 5px 11px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:active { transform: translateY(1px); }
    .btn.primary { border-color: transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn.link { width: 100%; text-align: left; color: var(--vscode-textLink-foreground); background: transparent; }
    .count { font-weight: 700; }
    [hidden] { display: none !important; }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
      .side { position: static; }
      .toolbar, .grid, .folder-access-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>${view.mode === 'edit' ? 'Edit Agent' : 'Build an Agent'}</h1>
      <p class="subtitle">Compose identity, model, instructions, tools, playbooks, and MCP grants in one place.</p>
    </div>
    <button class="btn" type="button" data-command="cancel">Cancel</button>
  </div>

  <div class="layout">
    <main class="main">
      <section class="panel">
        <h2>Identity</h2>
        <div class="grid">
          <div class="field"><label for="name">Name</label><input id="name" value="${escAttr(initial.name)}"></div>
          <div class="field"><label for="role">Role</label><select id="role">${initial.roleKey ? '' : '<option value="" selected>Select a role…</option>'}${roleOptions}<option value="custom" ${initial.roleKey === 'custom' ? 'selected' : ''}>Custom role</option></select></div>
          <div class="field" id="customRoleWrap"><label for="customRole">Custom Role</label><input id="customRole" value="${escAttr(initial.customRole)}" placeholder="CEO"></div>
        </div>
        <details class="section-advanced" id="identityAdvanced">
          <summary><span>Appearance</span><span class="advanced-hint">Icon and colour — usually left at the role default</span></summary>
          <div class="grid">
          <div class="field icon-picker">
            <label for="icon">Icon</label>
            <div class="icon-row">
              <div class="icon-preview" id="iconPreview" aria-hidden="true"></div>
              <div class="icon-controls">
                <div class="icon-presets">${iconPresets.map((icon) => `<button class="icon-choice ${icon.startsWith('$(') ? 'codicon' : ''}" type="button" data-icon="${escAttr(icon)}">${esc(icon)}</button>`).join('')}</div>
                <div class="icon-input-row">
                  <input id="icon" value="${escAttr(initial.icon)}" maxlength="${MAX_AGENT_ICON_DATA_URI_LENGTH}" placeholder="A or $(robot)">
                  <button class="btn" type="button" data-command="agentBuilderPickIcon">Upload image...</button>
                </div>
              </div>
            </div>
          </div>
          <div class="field"><label for="color">Color</label><input id="color" type="color" value="${escAttr(initial.color)}"></div>
          </div>
        </details>
      </section>

      <section class="panel">
        <h2>Model</h2>
        <div class="grid">
          <div class="field"><label for="provider">Connection / Pay through</label><select id="provider">${providerOptions}</select><p class="help" id="connectionDetails"></p></div>
          <div class="field" id="toolProtocolField"><label for="toolProtocol">Tool calling method</label><select id="toolProtocol"><option value="auto" ${!initial.toolProtocol || initial.toolProtocol === 'auto' ? 'selected' : ''}>${esc(toolProtocolAutoLabel(initial.model))}</option><option value="native" ${initial.toolProtocol === 'native' ? 'selected' : ''}>Native</option><option value="xml" ${initial.toolProtocol === 'xml' ? 'selected' : ''}>XML</option></select><p class="help" id="toolProtocolCapabilityNotice" role="status">${esc(initialToolProtocolNotice)}</p></div>
          <div class="field">
            <label for="model">Model</label>
            <input id="model" list="modelOptions" autocomplete="off" spellcheck="false" placeholder="Type to filter models…">
            <datalist id="modelOptions"></datalist>
          </div>
          <div class="field">
            <label for="fallbackModel">Backup model</label>
            <input id="fallbackModel" list="fallbackModelOptions" autocomplete="off" spellcheck="false" placeholder="Optional — type to filter…">
            <datalist id="fallbackModelOptions"></datalist>
          </div>
          <div class="field" data-model-connection="context-window"><label for="mp_context_window">Context window (tokens)</label><input id="mp_context_window" type="number" step="1000" min="1" value="${initial.contextWindowTokens || ''}" placeholder="${escAttr(defaultLabels.contextWindow)}"><p class="help" id="contextWindowCapabilityNotice" role="status"></p></div>
          <div class="field" data-model-param="reasoning_effort"><label for="mp_reasoning_effort">Reasoning effort</label><select id="mp_reasoning_effort">${reasoningEffortOptions(initial.modelParams.reasoning_effort, defaultLabels.reasoningEffort)}</select></div>
        </div>
        <div class="status-line" id="modelStatus" role="status"></div>
      </section>

      <section class="panel" id="instructionsSection">
        <h2>Instructions <span id="instructionsReq" style="color: var(--vscode-errorForeground); font-size: 12px; font-weight: 600;" ${initial.roleKey === 'custom' ? '' : 'hidden'}>— required for a custom role: describe what this agent does, or it can't be created</span></h2>
        ${promptTemplate}
        <div class="prompt-template-status" id="roleSwitchNotice" data-prompt-template-state="custom-outdated" hidden>
          <div id="roleSwitchNoticeText"></div>
          <div class="prompt-template-actions">
            <button class="btn" type="button" id="roleSwitchRestore">Restore my previous Instructions</button>
          </div>
        </div>
        <textarea id="systemPrompt">${esc(stripPlaybooks(initial.systemPrompt))}</textarea>
        <p class="help">Playbooks are mounted from the picker on save; this editor stays focused on your base instructions.</p>
      </section>

      <section class="panel" id="skillPlaybooksSection">
        <h2>Skill Playbooks</h2>
        <p class="help">Claude agents with read-only or restricted folder access keep Bash disabled and use these skill summaries without loading plugin files.</p>
        <p class="help" id="skillCapabilityNotice" role="status"></p>
        <div class="toolbar">
          <input id="skillSearch" type="search" placeholder="Search playbooks" aria-label="Search playbooks">
          <select id="categoryFilter" aria-label="Filter by category"><option value="">All categories</option>${categoryOptions}</select>
          <select id="roleFilter" aria-label="Filter by role"><option value="">All roles</option>${view.roles.map((r) => `<option value="${escAttr(r.id)}">${esc(r.name)}</option>`).join('')}</select>
          <select id="sortMode" aria-label="Sort playbooks"><option value="relevant">Relevant</option><option value="newest">Newest</option><option value="most-used">Most used</option></select>
        </div>
        <p class="selection-heading" id="selectedPlaybooksHeading">Selected playbooks</p>
        <div class="skill-grid" id="selectedSkillGrid"></div>
        <div class="empty" id="selectedPlaybooksEmpty">No playbooks selected yet. Open All playbooks to add one.</div>
        <div class="skill-grid" id="skillSearchMatches" hidden></div>
        <details class="section-advanced" id="skillFullList">
          <summary><span>All playbooks</span><span class="advanced-hint" id="skillFullListHint">${Math.max(0, view.catalog.skills.length - initial.playbooks.length)} unselected; usually left unselected</span></summary>
          <div class="skill-grid" id="skillGrid">${skillCards(view.catalog.skills, view.roles, initial.playbooks)}</div>
        </details>
      </section>

      <section class="panel">
        <h2>Tools</h2>
        <p class="help" id="capabilityNotice" role="status"></p>
        <p class="selection-heading" id="selectedToolsHeading">Selected tools</p>
        <div class="checks" id="selectedCapabilityChecks"></div>
        <div class="empty" id="selectedToolsEmpty">No tools selected yet. Open All tools to add one.</div>
        <details class="section-advanced" id="toolFullList">
          <summary><span>All tools</span><span class="advanced-hint" id="toolFullListHint">${Math.max(0, view.capabilities.length - initial.skillIds.length)} unselected; usually left unselected</span></summary>
          <div class="checks" id="capabilityChecks">${capabilityChecks(view.capabilities, initial.skillIds)}</div>
        </details>
      </section>

      <details class="section-advanced" id="modelAdvanced">
        <summary>
          <span>More model controls</span>
          <span class="advanced-hint">Routing, sampling and tier — usually left at connection defaults</span>
          <span class="advanced-notice" id="modelAdvancedSummary" role="status" hidden></span>
        </summary>
        <section class="panel">
          <h2>Model fine-tuning</h2>
          <p class="help">Per-agent sampling &amp; reasoning settings. This connection shows only parameters it accepts. Leave a field blank to use the global default.</p>
          <p class="help" id="modelParamCapabilityNotice" role="status"></p>
          <div class="grid" id="modelRoutingFields"></div>
          <div class="grid">
            <div class="field" data-model-param="temperature"><label for="mp_temperature">Temperature (0–2)</label><input id="mp_temperature" type="number" step="0.1" min="0" max="2" value="${mpVal(initial.modelParams.temperature)}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.temperature))}"></div>
            <div class="field" data-model-param="top_p"><label for="mp_top_p">Top P (0–1)</label><input id="mp_top_p" type="number" step="0.05" min="0" max="1" value="${mpVal(initial.modelParams.top_p)}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.topP))}"></div>
            <div class="field" data-model-param="max_tokens"><label for="mp_max_tokens">Max output tokens</label><input id="mp_max_tokens" type="number" step="1" min="1" value="${mpVal(initial.modelParams.max_tokens)}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.maxTokens))}"></div>
            <div class="field" data-model-param="presence_penalty"><label for="mp_presence_penalty">Presence penalty (-2–2)</label><input id="mp_presence_penalty" type="number" step="0.1" min="-2" max="2" value="${mpVal(initial.modelParams.presence_penalty)}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.presencePenalty))}"></div>
            <div class="field" data-model-param="frequency_penalty"><label for="mp_frequency_penalty">Frequency penalty (-2–2)</label><input id="mp_frequency_penalty" type="number" step="0.1" min="-2" max="2" value="${mpVal(initial.modelParams.frequency_penalty)}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.frequencyPenalty))}"></div>
            <div class="field" data-model-param="response_format"><label for="mp_response_format">Response format</label><select id="mp_response_format">${mpSelect(responseFormatOptions, responseFormat)}</select><p class="help">JSON object is for a downstream program consumer and may not combine with tools.</p></div>
            <div class="field" data-model-param="thinking"><label for="mp_thinking">Thinking</label><select id="mp_thinking">${mpSelect([['', formatModelParamDefaultLabel(defaultLabels.thinking)], ['enabled', 'Enabled'], ['disabled', 'Disabled']], initial.modelParams.thinking?.type ?? '')}</select></div>
            <div class="field" data-model-param="thinking"><label for="mp_thinking_budget">Thinking budget (tokens)</label><input id="mp_thinking_budget" type="number" step="1" min="1" value="${mpVal(initial.modelParams.thinking?.type === 'enabled' ? initial.modelParams.thinking.budget_tokens : undefined)}" placeholder="${formatModelParamDefaultLabel(PROVIDER_DEFAULT_MODEL_PARAM_LABEL)}"></div>
            <div class="field" data-model-param="tool_choice"><label for="mp_tool_choice">Tool choice</label><input id="mp_tool_choice" type="text" value="${escAttr(initial.modelParams.tool_choice ?? '')}" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.toolChoice))}"></div>
            <div class="field" data-model-param="stream"><label for="mp_stream">Stream</label><select id="mp_stream">${mpSelect([['', formatModelParamDefaultLabel(defaultLabels.stream)], ['enabled', 'Enabled'], ['disabled', 'Disabled']], initial.modelParams.stream === true ? 'enabled' : initial.modelParams.stream === false ? 'disabled' : '')}</select></div>
            <div class="field" data-model-param="stop"><label for="mp_stop">Stop sequences (one per line, max 4)</label><textarea id="mp_stop" rows="2" placeholder="${escAttr(formatModelParamDefaultLabel(defaultLabels.stop))}">${esc(Array.isArray(initial.modelParams.stop) ? initial.modelParams.stop.join('\n') : (initial.modelParams.stop ?? ''))}</textarea></div>
          </div>
        </section>

        <section class="panel" id="smartModeSection">
          <h2>Smart Mode tier</h2>
          <p class="help">Smart Mode is currently <b>${initial.smartModeEnabled ? 'On' : 'Off'}</b> (global). When on, this agent runs on the model mapped to its tier. Pick a tier for <b>this agent</b> — it overrides the role tier, so two same-role agents can differ.</p>
          <p class="help" id="smartModeCapabilityNotice" role="status"></p>
          <div class="grid">
            <div class="field"><label for="mp_tier">Tier for this agent</label><select id="mp_tier">${tierOptions(initial.tier)}</select></div>
          </div>
          <p class="help">The tier → model mapping (and global defaults) live in <a href="command:unode.openSettings">Settings → Smart Mode →</a></p>
        </section>

      </details>

      <details class="section-advanced" id="folderAccessAdvanced">
        <summary>
          <span>Folder Access</span>
          <span class="advanced-hint" id="folderAccessSummary">Inherit workspace default (full access)</span>
          <span class="advanced-notice" id="folderAccessAdvancedSummary" role="status" hidden></span>
        </summary>
        <section class="panel" id="folderAccessSection">
          <h2>Folder Access</h2>
          <div class="folder-access-list" id="folderAccessRows"></div>
          <div class="actions" style="justify-content:flex-start; margin-top: 8px;">
            <button class="btn" type="button" data-folder-add>Add folder</button>
          </div>
          <div class="folder-issues" id="folderAccessIssues" role="status"></div>
        </section>
      </details>

      <details class="section-advanced" id="commandAccessAdvanced">
        <summary>
          <span>Command Access</span>
          <span class="advanced-hint" id="commandAccessAdvancedHint">Usually inherits the global policy</span>
        </summary>
        <section class="panel">
          <div class="command-narrowing" id="commandNarrowingSection">
            <h3>Command Access</h3>
            <p class="help" id="commandNarrowingSummary"></p>
            <div class="command-narrowing-options" role="radiogroup" aria-label="Command access scope">
              <label><input type="radio" name="commandNarrowing" value="inherit"> Inherit global</label>
              <label><input type="radio" name="commandNarrowing" value="restrict"> Restrict to selected</label>
            </div>
            <div class="command-narrowing-list" id="commandNarrowingList"></div>
          </div>
        </section>
      </details>

      <details class="section-advanced" id="mcpAdvanced">
        <summary>
          <span>MCP Grants</span>
          <span class="advanced-hint" id="mcpAdvancedHint">${initial.mcpServers.length} selected; usually left at connection default</span>
          <span class="advanced-notice" id="mcpAdvancedSummary" role="status" hidden></span>
        </summary>
        <section class="panel">
          <h2>MCP Grants</h2>
          <p class="help" id="mcpCapabilityNotice" role="status"></p>
          <div class="checks" id="mcpChecks">${mcpChecks(view.mcpServers, initial.mcpServers)}</div>
          <button class="btn link" type="button" data-command="addMcpServer">Browse MCP Marketplace...</button>
        </section>
      </details>

    </main>

    <aside class="side">
      <section class="panel">
        <h2>Attached Playbooks <span class="count" id="playbookCount">0</span></h2>
        <div class="selected-list" id="selectedPlaybooks"></div>
      </section>
      <section class="panel">
        <h2>Includes Preview</h2>
        <div class="selected-list" id="includesPreview"></div>
        <button class="btn link" type="button" data-command="browseSkillLibrary">Need more? Browse the full skill library...</button>
      </section>
      <div class="actions">
        <button class="btn" type="button" data-command="cancel">Cancel</button>
        <button class="btn primary" type="button" id="saveButton">Save</button>
      </div>
    </aside>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    let formDirtySent = false;
    function markFormDirty() {
      if (!formDirtySent) {
        formDirtySent = true;
        vscode.postMessage({ command: 'formDirty' });
      }
    }
    const providers = ${jsonForScript(view.providers)};
    const roles = ${jsonForScript(view.roles)};
    const editingExistingAgent = ${jsonForScript(view.mode === 'edit')};
    const initialModel = ${jsonForScript(initial.model)};
    const initialFallbackModel = ${jsonForScript(initial.fallbackModel)};
    const initialModelParams = ${jsonForScript(initial.modelParams)};
    const samplingParameterKeys = ${jsonForScript(SAMPLING_PARAMETER_KEYS)};
    const declaredSamplingProfileSeed = ${jsonForScript(DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY)};
    const samplingParameterRejectionReason = ${jsonForScript(SAMPLING_PARAMETER_REJECTION_REASON)};
    const initialFolderAccess = ${jsonForScript(initial.folderAccess)};
    const initialFolderAccessIssues = ${jsonForScript(initial.folderAccessIssues)};
    const globalCommandPolicy = ${jsonForScript(view.globalCommandPolicy ?? { approvalMode: 'ask', allowedCommands: [] })};
    const initialCommandNarrowing = ${jsonForScript(initial.commandNarrowing)};
    // Mutable so a provider switch can drop a stale cross-provider selection (otherwise an OpenAI agent
    // could keep a Roam/DeepSeek model as a "custom" option). Updated on manual change; reset on switch.
    let selectedModel = initialModel;
    let selectedFallback = initialFallbackModel;
    let activeModelParamKeys = new Set();
    let roleTemplateAdopted = false;
    // Editing starts true: the stored icon was already settled, and an unrelated edit must not re-pick it.
    let iconChosenByUser = ${initial.id ? 'true' : 'false'};
    // Text a role switch overwrote, held so the user can take it back. null = nothing to restore.
    let stashedPrompt = null;

    const byId = (id) => document.getElementById(id);
    // MUST come after byId is defined. It used to sit above it, and because a const declaration sits in the
    // Temporal Dead Zone this threw "Cannot access byId before initialization" at script top level — which
    // killed the ENTIRE webview script, so no event handler was ever registered: Save did nothing and the Role
    // dropdown did nothing. The panel looked fine (the textarea is native) but was completely inert.
    let lastRoleKey = byId('role').value;
    const selectedPlaybooks = new Set(${jsonForScript(initial.playbooks)});
    const selectedSkills = new Set(${jsonForScript(initial.skillIds)});
    const selectedMcp = new Set(${jsonForScript(initial.mcpServers)});
    const modelCatalog = new Map(providers.map((provider) => [provider.id, provider.models || []]));
    const loadedProviders = new Set();
    const loadingProviders = new Set();
    const dataImagePattern = /^data:image\\/(?:png|jpeg|webp|svg\\+xml);base64,/;
    const declaredProtocolProfileSeed = ${jsonForScript(DECLARED_PROTOCOL_LEAK_MODEL_HINTS)};
    let folderGrantSeq = 0;
    let folderAccessDirty = false;
    let folderValidationSeq = 0;
    let folderValidationTimer = 0;
    let hostFolderAccessIssues = Array.isArray(initialFolderAccessIssues) ? initialFolderAccessIssues : [];
    const folderGrants = (Array.isArray(initialFolderAccess) ? initialFolderAccess : [])
      .filter((grant) => grant && typeof grant.path === 'string' && (grant.permission === 'read' || grant.permission === 'readwrite'))
      .map((grant) => ({ id: 'folderGrant_' + (++folderGrantSeq), path: grant.path, permission: grant.permission }));
    let restrictCommands = !!initialCommandNarrowing;
    const globalCommandTemplates = [...new Set((Array.isArray(globalCommandPolicy.allowedCommands) ? globalCommandPolicy.allowedCommands : [])
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => entry.trim().toLowerCase()))];
    const selectedCommandTemplates = new Set((initialCommandNarrowing?.allowedCommands || [])
      .filter((entry) => globalCommandTemplates.includes(String(entry).trim().toLowerCase()))
      .map((entry) => String(entry).trim().toLowerCase()));

    function declaredProtocolProfileForModel(model) {
      const m = String(model || '').toLowerCase();
      const knownNativeToolLeakRisk = !!m && declaredProtocolProfileSeed.some((hint) => m.includes(String(hint).toLowerCase()));
      return { protocol: { effective: { source: 'declared', value: { initial: 'native', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk } } } };
    }

    function toolProtocolCapabilityNotice(model, available) {
      if (!available) return "This connection does not use UnodeAi's Native/XML tool-calling setting.";
      if (!declaredProtocolProfileForModel(model).protocol.effective.value.knownNativeToolLeakRisk) return '';
      return 'This model starts with native tool calling. If it emits a tool call as text, UnodeAi switches to XML once for this session; the first tool use may visibly retry, and tool following may be weaker.';
    }

    // The webview is isolated from extension imports. Keep this tiny predicate in sync with the shared
    // host/backend policy, serialized above so model generation thresholds are still defined in one place.
    function modelRejectsSamplingParameters(model) {
      const id = String(model || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!id) return false;
      if (declaredSamplingProfileSeed.latestAliases.includes(id)) return true;
      const hasVersionPrefix = (prefix) => id === prefix
        || id.startsWith(prefix + '-')
        || id.includes('-' + prefix + '-')
        || id.endsWith('-' + prefix);
      if (declaredSamplingProfileSeed.versionFivePrefixes.some(hasVersionPrefix)) return true;
      const marker = declaredSamplingProfileSeed.claudeOpusFourPrefix;
      const markerIndex = id.indexOf(marker);
      if (markerIndex < 0) return false;
      const minor = Number(id.slice(markerIndex + marker.length).split('-')[0]);
      return Number.isInteger(minor) && minor >= declaredSamplingProfileSeed.claudeOpusFourMinimumMinor;
    }

    function syncToolProtocolAutoLabel() {
      const opt = byId('toolProtocol').querySelector('option[value="auto"]');
      if (!opt) return;
      const model = byId('model').value.trim();
      const target = model || 'this model';
      opt.textContent = 'Auto — native for ' + target;
    }

    function syncTierDefaultLabel() {
      const opt = byId('mp_tier').querySelector('option[value=""]');
      if (!opt) return;
      const role = roles.find((r) => r.id === byId('role').value);
      opt.textContent = 'Use role default — ' + (role?.tier || 'standard');
    }

    function syncIconPreview() {
      const preview = byId('iconPreview');
      const icon = byId('icon').value.trim();
      preview.replaceChildren();
      if (dataImagePattern.test(icon)) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        preview.appendChild(img);
        return;
      }
      const text = document.createElement('span');
      text.textContent = icon || 'A';
      preview.appendChild(text);
    }

    // A user-initiated role pick updates role defaults. Instructions are intentionally handled
    // separately: the change handler obtains confirmation before replacing user text.
    function syncRoleDefaults(userInitiated, adoptTemplatePrompt) {
      const roleKey = byId('role').value;
      const isCustom = roleKey === 'custom';
      byId('customRoleWrap').hidden = !isCustom;
      const reqHint = document.getElementById('instructionsReq');
      if (reqHint) { reqHint.hidden = !isCustom; } // a custom role has no default prompt → make it clearly required
      const role = roles.find((r) => r.id === roleKey);
      if (!role) {
        // Selecting Custom does not erase existing instructions; they remain user-owned text.
        roleTemplateAdopted = false;
        syncIconPreview();
        return;
      }
      if (userInitiated) {
        // Explicit role pick = adopt the role's template. Preserve a user-typed custom NAME (only replace an
        // empty or auto-filled role name) and a user-uploaded image ICON; everything else follows the role.
        const roleNames = new Set(roles.map((r) => r.name));
        const curName = byId('name').value.trim();
        if (!curName || roleNames.has(curName)) { byId('name').value = role.name; }
        if (!dataImagePattern.test(byId('icon').value.trim()) && role.icon) { byId('icon').value = role.icon; }
        if (role.color) { byId('color').value = role.color; }
        if (adoptTemplatePrompt) {
          byId('systemPrompt').value = role.systemPrompt || '';
          roleTemplateAdopted = true;
        } else {
          roleTemplateAdopted = false;
        }
        if (role.providerId) { byId('provider').value = role.providerId; }
        if (role.model) { selectedModel = role.model; byId('model').value = role.model; }
        // Tools: check exactly this role's capability skills.
        const want = new Set(role.skillIds || []);
        selectedSkills.clear();
        want.forEach((id) => selectedSkills.add(id));
        document.querySelectorAll('[data-capability-id]').forEach((box) => { box.checked = want.has(box.dataset.capabilityId); });
        const wantPlaybooks = new Set(role.playbookIds || []);
        selectedPlaybooks.clear();
        wantPlaybooks.forEach((id) => selectedPlaybooks.add(id));
        syncCapabilityCards();
        syncSkillCards();
        requestModels(); // refresh the model datalist/prices for the (possibly new) provider
      } else {
        if (!byId('name').value.trim()) { byId('name').value = role.name; }
        if (!byId('icon').value.trim() && role.icon) { byId('icon').value = role.icon; }
        if (role.color && (!byId('color').value || byId('color').value === '#000000')) { byId('color').value = role.color; }
      }
      syncIconPreview();
    }

    function modelOptionText(model) {
      const label = model.name && model.name !== model.id ? model.name + ' / ' + model.id : model.id;
      return model.price ? label + ' - ' + model.price : label;
    }

    // Combobox: fill a <datalist> with the provider's models. The bound <input> holds the model id,
    // filters as you type (native), and still accepts a hand-typed custom id. value=id, label=friendly.
    function populateModelDatalist(datalist, models) {
      datalist.replaceChildren();
      for (const model of models) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.label = modelOptionText(model);
        datalist.appendChild(opt);
      }
    }

    function syncModels() {
      const providerId = byId('provider').value;
      const provider = providers.find((p) => p.id === providerId) || providers[0];
      const models = modelCatalog.get(provider?.id) || [];
      populateModelDatalist(byId('modelOptions'), models);
      populateModelDatalist(byId('fallbackModelOptions'), models);
      // Keep the chosen ids across re-renders (provider switch / live-price refresh).
      if (byId('model').value !== selectedModel) { byId('model').value = selectedModel || ''; }
      if (byId('fallbackModel').value !== selectedFallback) { byId('fallbackModel').value = selectedFallback || ''; }
      const details = byId('connectionDetails');
      if (details) {
        details.textContent = provider
          ? (provider.availability === 'coming-soon'
            ? (provider.availabilityMessage || (provider.name + ' is coming soon and is not available in this release.'))
            : 'Runtime: ' + (provider.runtimeLabel || 'Unknown') + '. Billing: ' +
              (provider.billingLabel || 'Unknown') + '. ' + (provider.privacySummary || '') + ' ' +
              (provider.capabilitySummary || ''))
          : '';
      }
      syncModelParamControls(provider);
      syncCapabilityControls(provider);
      syncSkillPlaybookControls(provider);
      syncFolderAccessControls(provider);
      syncToolProtocolControl(provider);
      syncSmartModeControl(provider);
      syncMcpControls(provider);
      syncPmRoleControl(provider);
      syncToolProtocolAutoLabel();
      if (loadingProviders.has(providerId)) {
        byId('modelStatus').textContent = 'Loading live models and prices...';
      } else if (loadedProviders.has(providerId)) {
        byId('modelStatus').textContent = models.length ? 'Live priced catalog loaded.' : 'No live models returned.';
      } else {
        byId('modelStatus').textContent = models.length ? 'Showing bundled models until live prices load.' : '';
      }
    }

    function syncModelParamControls(provider) {
      activeModelParamKeys = new Set(Array.isArray(provider?.allowedModelParamKeys)
        ? provider.allowedModelParamKeys
        : []);
      const rejectsSamplingParameters = modelRejectsSamplingParameters(byId('model').value);
      document.querySelectorAll('[data-model-param]').forEach((field) => {
        const allowed = activeModelParamKeys.has(field.dataset.modelParam);
        const rejectedByModel = rejectsSamplingParameters && samplingParameterKeys.includes(field.dataset.modelParam);
        field.hidden = !allowed;
        field.querySelectorAll('input, select, textarea').forEach((control) => {
          control.disabled = !allowed || rejectedByModel;
          control.title = rejectedByModel ? samplingParameterRejectionReason : '';
        });
      });
      const contextWindowAvailable = provider?.contextWindowAvailable !== false;
      document.querySelectorAll('[data-model-connection="context-window"]').forEach((field) => {
        field.hidden = !contextWindowAvailable;
        field.querySelectorAll('input').forEach((control) => { control.disabled = !contextWindowAvailable; });
      });
      const contextNotice = byId('contextWindowCapabilityNotice');
      if (contextNotice) {
        contextNotice.textContent = contextWindowAvailable
          ? ''
          : 'This connection does not accept an explicit context-window override.';
      }
      const legacy = Object.keys(initialModelParams || {}).filter((key) => !activeModelParamKeys.has(key));
      const notice = byId('modelParamCapabilityNotice');
      if (!notice) return;
      const accepted = [...activeModelParamKeys];
      if (legacy.length) {
        notice.textContent = 'Legacy parameters preserved but not sent: ' + legacy.join(', ') + '.';
        const confirm = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'removeLegacyModelParams';
        confirm.append(box, ' Remove those legacy values when saving');
        notice.append(' ', confirm);
      } else {
        notice.textContent = accepted.length
          ? 'Accepted by this connection: ' + accepted.join(', ') + '.'
          : 'This connection accepts no per-model parameters.';
      }
      if (rejectsSamplingParameters) {
        notice.append(' ', samplingParameterRejectionReason);
      }
      setAdvancedIssue('model-parameters', legacy.length > 0 || rejectsSamplingParameters);
    }

    function moveModelRoutingControls() {
      const target = byId('modelRoutingFields');
      const fallback = byId('fallbackModel').closest('.field');
      [byId('toolProtocolField'), fallback].filter(Boolean).forEach((field) => target.appendChild(field));
    }

    // Model fine-tuning belongs immediately after Model. The server template keeps its large advanced
    // subtree near the other disclosures; relocate that existing node once before the user can focus it.
    // This is a move, not a re-render, so controls and their listeners remain the same elements.
    function positionModelAdvancedSection() {
      const modelAdvanced = byId('modelAdvanced');
      const instructions = byId('instructionsSection');
      const parent = instructions.parentElement;
      if (parent && typeof parent.insertBefore === 'function') {
        parent.insertBefore(modelAdvanced, instructions);
      }
    }

    function syncCapabilityControls(provider) {
      const supported = new Set(Array.isArray(provider?.supportedToolKeys) ? provider.supportedToolKeys : []);
      const skillsAvailable = provider?.skillsAvailable !== false;
      let unavailable = 0;
      document.querySelectorAll('[data-capability-id]').forEach((box) => {
        const required = String(box.dataset.capabilityTools || '').split(',').filter(Boolean);
        const available = skillsAvailable && required.every((tool) => supported.has(tool));
        box.disabled = !available;
        const limit = box.closest('label')?.querySelector('[data-capability-limit]');
        if (limit) limit.hidden = available;
        if (!available) {
          unavailable += 1;
        }
      });
      const notice = byId('capabilityNotice');
      if (notice) {
        notice.textContent = unavailable
          ? unavailable === 1
            ? '1 skill capability is unavailable on this connection. Existing selections are preserved; choose a compatible connection to change them.'
            : unavailable + ' skill capabilities are unavailable on this connection. Existing selections are preserved; choose a compatible connection to change them.'
          : 'All listed skill capabilities are available on this connection.';
      }
      syncCapabilityCards();
    }

    function syncSkillPlaybookControls(provider) {
      const available = provider?.skillsAvailable !== false;
      document.querySelectorAll('[data-playbook-id]').forEach((box) => { box.disabled = !available; });
      const notice = byId('skillCapabilityNotice');
      if (notice) {
        notice.textContent = available
          ? ''
          : 'This connection does not load UnodeAi skill or playbook grants. Existing selections are preserved; choose a compatible connection to change them.';
      }
      if (!available && !editingExistingAgent) {
        selectedPlaybooks.clear();
        selectedSkills.clear();
        document.querySelectorAll('[data-capability-id]').forEach((box) => { box.checked = false; });
      }
      syncSkillCards();
      syncCapabilityCards();
    }

    function syncFolderAccessControls(provider) {
      const available = provider?.folderAccessAvailable !== false;
      document.querySelectorAll('[data-folder-add], [data-folder-browse], [data-folder-remove], [data-folder-path], [data-folder-permission]')
        .forEach((control) => { control.disabled = !available; });
      const summary = byId('folderAccessSummary');
      if (!available && summary) {
        summary.textContent = 'Unavailable on this connection: Folder Access does not confine its reads. Existing grants are preserved.';
      }
      setAdvancedIssue('folder-access', !available || byId('folderAccessIssues').childElementCount > 0);
    }

    function syncToolProtocolControl(provider) {
      const available = provider?.toolProtocolAvailable !== false;
      byId('toolProtocol').disabled = !available;
      const notice = byId('toolProtocolCapabilityNotice');
      if (notice) {
        const model = byId('model').value.trim();
        notice.textContent = toolProtocolCapabilityNotice(model, available);
      }
    }

    function syncSmartModeControl(provider) {
      const available = provider?.smartModeAvailable !== false;
      byId('mp_tier').disabled = !available;
      const notice = byId('smartModeCapabilityNotice');
      if (notice) {
        notice.textContent = available ? '' : 'This connection does not use UnodeAi Smart Mode tiers.';
      }
      setAdvancedIssue('smart-mode', !available);
    }

    function syncMcpControls(provider) {
      const available = provider?.mcpAvailable === true;
      document.querySelectorAll('[data-mcp-id]').forEach((box) => {
        box.disabled = !available;
      });
      document.querySelectorAll('button[data-command="addMcpServer"]').forEach((button) => { button.disabled = !available; });
      const notice = byId('mcpCapabilityNotice');
      if (notice) {
        notice.textContent = available
          ? 'MCP grants are available on this connection.'
          : 'MCP grants are unavailable on this connection. Existing selections are preserved; choose a compatible connection to change them.';
      }
      setAdvancedIssue('mcp', !available);
      syncMcpSummary();
    }

    function syncMcpSummary() {
      const selected = document.querySelectorAll('[data-mcp-id]:checked').length;
      byId('mcpAdvancedHint').textContent = selected + ' selected; usually left at connection default';
    }

    function syncPmRoleControl(provider) {
      const pm = byId('role').querySelector('option[value="pm"]');
      if (pm) pm.disabled = provider?.coordinatorAvailable !== true;
    }

    function requestModels() {
      const providerId = byId('provider').value;
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      if (provider.availability === 'coming-soon') {
        syncModels();
        byId('modelStatus').textContent = provider.availabilityMessage || 'This connection is coming soon and cannot be used yet.';
        return;
      }
      loadingProviders.add(providerId);
      syncModels();
      vscode.postMessage({ command: 'listModels', providerId, baseUrl: provider.baseUrl });
    }

    function syncFolderGrantStateFromDom() {
      document.querySelectorAll('[data-folder-row]').forEach((row) => {
        const grant = folderGrants.find((g) => g.id === row.dataset.folderRow);
        if (!grant) return;
        grant.path = row.querySelector('[data-folder-path]')?.value || '';
        grant.permission = row.querySelector('[data-folder-permission]')?.value === 'readwrite' ? 'readwrite' : 'read';
      });
    }

    // A notice must be visible while its section stays closed. Track actionable issues explicitly instead
    // of watching every mutation and stealing the disclosure state from the person reading it.
    const advancedIssues = new Map();
    function setAdvancedIssue(key, present) {
      const section = key === 'folder-access' ? 'folder' : key === 'mcp' ? 'mcp' : 'model';
      const issues = advancedIssues.get(section) || new Set();
      if (present) issues.add(key); else issues.delete(key);
      advancedIssues.set(section, issues);
      const summary = byId(section === 'folder' ? 'folderAccessAdvancedSummary'
        : section === 'mcp' ? 'mcpAdvancedSummary' : 'modelAdvancedSummary');
      if (!summary) return;
      const count = issues.size;
      summary.hidden = count === 0;
      summary.textContent = count === 1 ? '⚠ 1 issue' : '⚠ ' + count + ' issues';
    }

    function collectFolderAccess() {
      syncFolderGrantStateFromDom();
      return folderGrants
        .map((grant) => ({ path: String(grant.path || '').trim(), permission: grant.permission === 'readwrite' ? 'readwrite' : 'read' }))
        .filter((grant) => grant.path);
    }

    function requestFolderAccessValidation() {
      clearTimeout(folderValidationTimer);
      folderValidationTimer = setTimeout(() => {
        const seq = ++folderValidationSeq;
        vscode.postMessage({ command: 'validateFolderAccess', seq, payload: collectFolderAccess() });
      }, 180);
    }

    function addFolderGrant(path, permission) {
      folderGrants.push({
        id: 'folderGrant_' + (++folderGrantSeq),
        path: path || '',
        permission: permission === 'readwrite' ? 'readwrite' : 'read',
      });
      folderAccessDirty = true;
      renderFolderAccess();
      requestFolderAccessValidation();
    }

    function renderFolderAccess() {
      const rows = byId('folderAccessRows');
      rows.replaceChildren();
      byId('folderAccessSummary').textContent = folderGrants.length
        ? folderGrants.length + ' folder grant' + (folderGrants.length === 1 ? '' : 's')
        : 'Inherit workspace default (full access)';
      for (const grant of folderGrants) {
        const row = document.createElement('div');
        row.className = 'folder-access-row';
        row.dataset.folderRow = grant.id;

        const pathField = document.createElement('div');
        pathField.className = 'field';
        const pathLabel = document.createElement('label');
        pathLabel.textContent = 'Folder path';
        const pathInput = document.createElement('input');
        pathInput.value = grant.path || '';
        pathInput.placeholder = 'src or C:\\\\path\\\\to\\\\folder';
        pathInput.dataset.folderPath = '1';
        pathField.append(pathLabel, pathInput);

        const permField = document.createElement('div');
        permField.className = 'field';
        const permLabel = document.createElement('label');
        permLabel.textContent = 'Permission';
        const perm = document.createElement('select');
        perm.dataset.folderPermission = '1';
        for (const option of [['read', 'Read'], ['readwrite', 'Read+Write']]) {
          const node = document.createElement('option');
          node.value = option[0];
          node.textContent = option[1];
          if (grant.permission === option[0]) node.selected = true;
          perm.appendChild(node);
        }
        permField.append(permLabel, perm);

        const browse = document.createElement('button');
        browse.className = 'btn';
        browse.type = 'button';
        browse.textContent = 'Browse...';
        browse.dataset.folderBrowse = grant.id;

        const remove = document.createElement('button');
        remove.className = 'btn';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.dataset.folderRemove = grant.id;

        row.append(pathField, permField, browse, remove);
        rows.appendChild(row);
      }
      syncFolderAccessIssues();
    }

    function renderCommandNarrowing() {
      const inherited = !restrictCommands;
      document.querySelector('input[name="commandNarrowing"][value="inherit"]').checked = inherited;
      document.querySelector('input[name="commandNarrowing"][value="restrict"]').checked = !inherited;
      const summary = byId('commandNarrowingSummary');
      summary.textContent = inherited
        ? 'Inherit global command policy (' + (globalCommandPolicy.approvalMode || 'ask') + ').'
        : 'Restrict this agent to ' + selectedCommandTemplates.size + ' of ' + globalCommandTemplates.length + ' globally configured command template' + (globalCommandTemplates.length === 1 ? '.' : 's.');
      byId('commandAccessAdvancedHint').textContent = inherited
        ? 'Inherits the global policy'
        : 'Restricts to ' + selectedCommandTemplates.size + ' selected command template' + (selectedCommandTemplates.size === 1 ? '' : 's');
      const list = byId('commandNarrowingList');
      list.replaceChildren();
      if (globalCommandTemplates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'help';
        empty.textContent = 'No global command templates are configured. Add them in Settings before selecting a narrower command set.';
        list.appendChild(empty);
      }
      for (const template of globalCommandTemplates) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.commandAllow = template;
        check.checked = selectedCommandTemplates.has(template);
        check.disabled = inherited;
        const text = document.createElement('code');
        text.textContent = template;
        label.append(check, text);
        list.appendChild(label);
      }
    }

    function syncFolderAccessIssues() {
      syncFolderGrantStateFromDom();
      const out = [];
      const grants = folderGrants.map((grant) => ({
        path: String(grant.path || '').trim(),
        permission: grant.permission === 'readwrite' ? 'readwrite' : 'read',
      }));
      grants.forEach((grant, index) => {
        if (!grant.path) out.push('Folder row ' + (index + 1) + ' needs a path.');
      });
      const seen = new Map();
      for (const grant of grants) {
        if (!grant.path) continue;
        const key = grant.path.replace(/[\\\\/]+$/, '').toLowerCase();
        const prior = seen.get(key);
        if (prior && prior !== grant.permission) {
          out.push('Duplicate folder has conflicting permissions: ' + grant.path);
        }
        seen.set(key, grant.permission);
      }
      const readwrite = grants.filter((grant) => grant.permission === 'readwrite' && grant.path);
      const readOnly = grants.filter((grant) => grant.permission === 'read' && grant.path);
      for (const readGrant of readOnly) {
        const child = readGrant.path.replace(/[\\\\/]+$/, '').toLowerCase();
        const parent = readwrite.find((grant) => {
          const root = grant.path.replace(/[\\\\/]+$/, '').toLowerCase();
          return child !== root && (child.startsWith(root + '/') || child.startsWith(root + '\\\\'));
        });
        if (parent) {
          out.push('Read-only folder is inside a Read+Write folder: ' + readGrant.path);
        }
      }
      if (byId('provider').value === 'anthropic' && readwrite.length > 1) {
        out.push('Claude Headless can use at most one Read+Write folder. Keep one writable folder or switch extra rows to Read.');
      }
      if (byId('provider').value === 'codex' && grants.length) {
        out.push('Codex read-only sandbox does not confine reads to these folders: it can read any file your user account can read, and context may be sent to OpenAI.');
      }
      if (!folderAccessDirty && Array.isArray(initialFolderAccessIssues)) {
        hostFolderAccessIssues.forEach((issue) => {
          if (issue && typeof issue.message === 'string') out.push(issue.message);
        });
      } else if (folderAccessDirty && Array.isArray(hostFolderAccessIssues)) {
        hostFolderAccessIssues.forEach((issue) => {
          if (issue && typeof issue.message === 'string') out.push(issue.message);
        });
      }
      const target = byId('folderAccessIssues');
      target.replaceChildren();
      [...new Set(out)].forEach((message) => {
        const item = document.createElement('div');
        item.className = 'folder-issue';
        item.textContent = message;
        target.appendChild(item);
      });
      setAdvancedIssue('folder-access', out.length > 0 || byId('provider').value === 'codex');
    }

    function skillMatches(card) {
      const q = byId('skillSearch').value.trim().toLowerCase();
      const category = byId('categoryFilter').value;
      const role = byId('roleFilter').value;
      if (q && !card.dataset.search.includes(q)) return false;
      if (category && card.dataset.category !== category) return false;
      if (role && !card.dataset.roles.split(',').includes(role)) return false;
      return true;
    }

    function syncSkillCards() {
      const cards = [...document.querySelectorAll('[data-skill-id]')];
      const sort = byId('sortMode').value;
      cards.sort((a, b) => {
        const aSel = selectedPlaybooks.has(a.dataset.skillId) ? 1 : 0;
        const bSel = selectedPlaybooks.has(b.dataset.skillId) ? 1 : 0;
        if (sort === 'relevant' && aSel !== bSel) return bSel - aSel;
        if (sort === 'newest') return Number(b.dataset.index) - Number(a.dataset.index);
        if (sort === 'most-used') {
          const caps = Number(b.dataset.capabilities) - Number(a.dataset.capabilities);
          if (caps) return caps;
          const body = Number(b.dataset.hasBody) - Number(a.dataset.hasBody);
          if (body) return body;
        }
        return a.dataset.name.localeCompare(b.dataset.name);
      });
      const selectedGrid = byId('selectedSkillGrid');
      const searchMatches = byId('skillSearchMatches');
      const grid = byId('skillGrid');
      const hasFilter = Boolean(byId('skillSearch').value.trim() || byId('categoryFilter').value || byId('roleFilter').value);
      let selectedCount = 0;
      let matchingUnselectedCount = 0;
      cards.forEach((card) => {
        const selected = selectedPlaybooks.has(card.dataset.skillId);
        const matches = skillMatches(card);
        card.classList.toggle('selected', selected);
        const box = card.querySelector('input[type="checkbox"]');
        box.checked = selected;
        box.disabled = providers.find((provider) => provider.id === byId('provider').value)?.skillsAvailable === false;
        if (selected) {
          selectedCount += 1;
          card.hidden = false;
          selectedGrid.appendChild(card);
        } else if (hasFilter && matches) {
          matchingUnselectedCount += 1;
          card.hidden = false;
          searchMatches.appendChild(card);
        } else {
          card.hidden = hasFilter && !matches;
          grid.appendChild(card);
        }
      });
      searchMatches.hidden = !hasFilter || matchingUnselectedCount === 0;
      byId('selectedPlaybooksHeading').textContent = selectedCount
        ? 'Selected playbooks (' + selectedCount + ')'
        : 'Selected playbooks (none)';
      byId('selectedPlaybooksEmpty').hidden = selectedCount > 0;
      byId('skillFullListHint').textContent = cards.length - selectedCount + ' available; usually left unselected';
      syncPreview();
    }

    function syncCapabilityCards() {
      const fullList = byId('capabilityChecks');
      const selectedList = byId('selectedCapabilityChecks');
      const boxes = [...document.querySelectorAll('[data-capability-id]')];
      let selectedCount = 0;
      boxes.forEach((box) => {
        const row = box.closest('label');
        if (!row) return;
        if (box.checked) {
          selectedCount += 1;
          selectedList.appendChild(row);
        } else {
          fullList.appendChild(row);
        }
      });
      byId('selectedToolsHeading').textContent = selectedCount
        ? 'Selected tools (' + selectedCount + ')'
        : 'Selected tools (none)';
      byId('selectedToolsEmpty').hidden = selectedCount > 0;
      byId('toolFullListHint').textContent = boxes.length - selectedCount + ' available; usually left unselected';
    }

    function syncPreview() {
      byId('playbookCount').textContent = String(selectedPlaybooks.size);
      const selected = [...document.querySelectorAll('[data-skill-id]')].filter((card) => selectedPlaybooks.has(card.dataset.skillId));
      const renderInto = (target, emptyText, withSummary) => {
        const node = byId(target);
        node.replaceChildren();
        if (!selected.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = emptyText;
          node.appendChild(empty);
          return;
        }
        selected.forEach((card) => {
          const item = document.createElement('div');
          item.className = 'selected-item';
          const title = document.createElement('div');
          title.className = 'skill-title';
          title.textContent = card.dataset.label;
          item.appendChild(title);
          if (withSummary) {
            const summary = document.createElement('div');
            summary.className = 'meta';
            summary.textContent = card.dataset.summary;
            item.appendChild(summary);
          }
          node.appendChild(item);
        });
      };
      renderInto('selectedPlaybooks', 'No playbooks attached yet.', false);
      renderInto('includesPreview', 'Includes: no playbooks yet.', true);
    }

    document.addEventListener('click', (event) => {
      if (event.target.closest('#roleSwitchRestore')) {
        if (stashedPrompt !== null) {
          byId('systemPrompt').value = stashedPrompt;
          roleTemplateAdopted = false; // it is the user's text again, not the role template
          stashedPrompt = null;
        }
        byId('roleSwitchNotice').hidden = true;
        return;
      }
      const commandButton = event.target.closest('button[data-command]');
      if (commandButton) {
        vscode.postMessage({ command: commandButton.dataset.command });
        return;
      }
      const promptTemplateAction = event.target.closest('button[data-prompt-template-action]');
      if (promptTemplateAction) {
        vscode.postMessage({ command: 'promptTemplateAction', action: promptTemplateAction.dataset.promptTemplateAction });
        return;
      }
      const folderBrowse = event.target.closest('button[data-folder-browse]');
      if (folderBrowse) {
        vscode.postMessage({ command: 'pickFolderAccessFolder', rowId: folderBrowse.dataset.folderBrowse });
        return;
      }
      const folderRemove = event.target.closest('button[data-folder-remove]');
      if (folderRemove) {
        const id = folderRemove.dataset.folderRemove;
        const index = folderGrants.findIndex((grant) => grant.id === id);
        if (index >= 0) folderGrants.splice(index, 1);
        folderAccessDirty = true;
        renderFolderAccess();
        requestFolderAccessValidation();
        return;
      }
      if (event.target.closest('button[data-folder-add]')) {
        addFolderGrant('', 'read');
        return;
      }
      const iconButton = event.target.closest('button[data-icon]');
      if (iconButton) {
        byId('icon').value = iconButton.dataset.icon || '';
        iconChosenByUser = true;
        syncIconPreview();
        return;
      }
      if (event.target.closest('#saveButton')) {
        const rejectsSamplingParameters = modelRejectsSamplingParameters(byId('model').value);
        const modelParamValue = (key, id) => activeModelParamKeys.has(key)
          && !(rejectsSamplingParameters && samplingParameterKeys.includes(key)) ? byId(id).value : undefined;
        const payload = {
          id: ${jsonForScript(initial.id)},
          name: byId('name').value,
          roleKey: byId('role').value,
          roleTemplateAdopted,
          // Send the text a role switch replaced, so the host can retain it as Undo. Holding it only here
          // meant it died with the panel — for a new agent that was the ONLY copy of the user's prompt.
          roleSwitchStashedPrompt: stashedPrompt || undefined,
          customRole: byId('customRole').value,
          icon: byId('icon').value,
          // Whether the value above is a CHOICE or just what this panel typed in on the user's behalf.
          // A role switch fills the field with the role's default, so the value alone cannot tell the
          // host which it is — and without that, a new agent silently keeps a duplicate icon.
          iconExplicit: iconChosenByUser,
          color: byId('color').value,
          providerId: byId('provider').value,
          model: byId('model').value,
          fallbackModel: byId('fallbackModel').value || undefined,
          toolProtocol: byId('toolProtocol').value,
          systemPrompt: byId('systemPrompt').value,
          modelParams: {
            temperature: modelParamValue('temperature', 'mp_temperature'),
            top_p: modelParamValue('top_p', 'mp_top_p'),
            max_tokens: modelParamValue('max_tokens', 'mp_max_tokens'),
            reasoning_effort: modelParamValue('reasoning_effort', 'mp_reasoning_effort'),
            presence_penalty: modelParamValue('presence_penalty', 'mp_presence_penalty'),
            frequency_penalty: modelParamValue('frequency_penalty', 'mp_frequency_penalty'),
            response_format: modelParamValue('response_format', 'mp_response_format'),
            thinking_type: modelParamValue('thinking', 'mp_thinking'),
            thinking_budget_tokens: modelParamValue('thinking', 'mp_thinking_budget'),
            tool_choice: modelParamValue('tool_choice', 'mp_tool_choice'),
            stream: modelParamValue('stream', 'mp_stream'),
            stop: modelParamValue('stop', 'mp_stop'),
          },
          removeLegacyModelParams: byId('removeLegacyModelParams')?.checked === true,
          contextWindowTokens: byId('mp_context_window').value,
          tier: (!editingExistingAgent && providers.find((provider) => provider.id === byId('provider').value)?.smartModeAvailable === false)
            ? undefined
            : byId('mp_tier').value,
          folderAccess: collectFolderAccess(),
          commandNarrowing: restrictCommands ? {
            approvalMode: 'allowlist',
            allowedCommands: [...selectedCommandTemplates],
          } : undefined,
          skillIds: [...document.querySelectorAll('[data-capability-id]:checked')].map((el) => el.dataset.capabilityId),
          playbooks: [...selectedPlaybooks],
          mcpServers: [...document.querySelectorAll('[data-mcp-id]:checked')].map((el) => el.dataset.mcpId),
        };
        vscode.postMessage({ command: 'save', payload });
      }
    });

    document.addEventListener('change', (event) => {
      const playbook = event.target.closest('[data-playbook-id]');
      if (playbook) {
        if (playbook.checked) selectedPlaybooks.add(playbook.dataset.playbookId);
        else selectedPlaybooks.delete(playbook.dataset.playbookId);
        syncSkillCards();
        return;
      }
      const capability = event.target.closest('[data-capability-id]');
      if (capability) {
        syncCapabilityCards();
        return;
      }
      const mcp = event.target.closest('[data-mcp-id]');
      if (mcp) {
        if (mcp.checked) selectedMcp.add(mcp.dataset.mcpId);
        else selectedMcp.delete(mcp.dataset.mcpId);
        syncMcpSummary();
        return;
      }
      if (event.target.id === 'role') {
        // Do NOT gate this on window.confirm(). A VS Code webview stubs out confirm/alert/prompt, so it
        // returns undefined — which read as "the user cancelled" and snapped the dropdown straight back to
        // the previous role. The role could never be changed at all. Instead the switch always applies (that
        // is what picking a role means) and any text we replaced is offered back with one click.
        const nextRole = roles.find((r) => r.id === byId('role').value);
        const previousPrompt = byId('systemPrompt').value;
        const previousRole = roles.find((r) => r.id === lastRoleKey);
        // Worth rescuing only if it is text the user actually owns: non-empty and not simply the outgoing
        // role's own untouched template.
        const wasEdited = previousPrompt.trim() !== ''
          && previousPrompt !== (previousRole ? (previousRole.systemPrompt || '') : '');
        syncRoleDefaults(true, Boolean(nextRole));
        if (nextRole && wasEdited && byId('systemPrompt').value !== previousPrompt) {
          stashedPrompt = previousPrompt;
          byId('roleSwitchNoticeText').textContent =
            'Instructions were replaced with the ' + nextRole.name + ' template. Your previous text is one click away.';
          byId('roleSwitchNotice').hidden = false;
        }
        lastRoleKey = byId('role').value;
        syncTierDefaultLabel();
        syncToolProtocolAutoLabel();
      }
      if (event.target.id === 'provider') {
        // New provider → drop the previous provider's model so it can't be saved against this one.
        selectedModel = '';
        selectedFallback = '';
        byId('model').value = '';
        byId('fallbackModel').value = '';
        requestModels();
        syncToolProtocolAutoLabel();
        syncFolderAccessIssues();
      }
      if (event.target.closest('[data-folder-row]')) {
        folderAccessDirty = true;
        syncFolderAccessIssues();
        requestFolderAccessValidation();
      }
      if (event.target.matches('input[name="commandNarrowing"]')) {
        restrictCommands = event.target.value === 'restrict';
        renderCommandNarrowing();
      }
      if (event.target.matches('[data-command-allow]')) {
        const template = event.target.dataset.commandAllow;
        if (template) {
          if (event.target.checked) selectedCommandTemplates.add(template);
          else selectedCommandTemplates.delete(template);
          renderCommandNarrowing();
        }
      }
      // Remember a manual model choice so re-renders (search/price refresh) keep it.
      if (event.target.id === 'model') {
        selectedModel = byId('model').value;
        syncToolProtocolAutoLabel();
        syncToolProtocolControl(providers.find((provider) => provider.id === byId('provider').value));
        syncModelParamControls(providers.find((provider) => provider.id === byId('provider').value));
      }
      if (event.target.id === 'fallbackModel') selectedFallback = byId('fallbackModel').value;
    });
    ['skillSearch', 'categoryFilter', 'roleFilter', 'sortMode'].forEach((id) => byId(id).addEventListener('input', syncSkillCards));
    ['categoryFilter', 'roleFilter', 'sortMode'].forEach((id) => byId(id).addEventListener('change', syncSkillCards));
    // Track the chosen ids as the user types/picks in the model comboboxes (so re-renders keep them).
    byId('model').addEventListener('input', () => {
      selectedModel = byId('model').value;
      syncToolProtocolAutoLabel();
      syncToolProtocolControl(providers.find((provider) => provider.id === byId('provider').value));
      syncModelParamControls(providers.find((provider) => provider.id === byId('provider').value));
    });
    byId('fallbackModel').addEventListener('input', () => { selectedFallback = byId('fallbackModel').value; });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) {
        return;
      }
      if (msg.command === 'iconPicked' && typeof msg.icon === 'string') {
        byId('icon').value = msg.icon;
        iconChosenByUser = true;
        syncIconPreview();
        return;
      }
      if (msg.command === 'folderAccessFolderPicked' && typeof msg.rowId === 'string' && typeof msg.path === 'string') {
        const grant = folderGrants.find((g) => g.id === msg.rowId);
        if (grant) {
          grant.path = msg.path;
          folderAccessDirty = true;
          renderFolderAccess();
          requestFolderAccessValidation();
        }
        return;
      }
      if (msg.command === 'folderAccessIssues' && typeof msg.seq === 'number' && Array.isArray(msg.issues)) {
        if (msg.seq === folderValidationSeq) {
          hostFolderAccessIssues = msg.issues;
          syncFolderAccessIssues();
        }
        return;
      }
      if (msg.command === 'mcpServers' && Array.isArray(msg.servers)) {
        const container = document.getElementById('mcpChecks');
        if (!container) { return; }
        const checked = new Set([...container.querySelectorAll('[data-mcp-id]:checked')].map((el) => el.dataset.mcpId));
        container.replaceChildren();
        if (msg.servers.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No MCP servers registered yet.';
          container.appendChild(empty);
          return;
        }
        for (const s of msg.servers) {
          const label = document.createElement('label');
          label.className = 'check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.mcpId = s.id;
          if (checked.has(s.id)) { cb.checked = true; }
          const span = document.createElement('span');
          const title = document.createElement('span');
          title.className = 'skill-title';
          title.textContent = s.name;
          const meta = document.createElement('span');
          meta.className = 'meta';
          meta.textContent = ' ' + (s.transport || '') + (s.connected ? ' / connected' : '') + (s.requiresApproval ? ' / approval' : '');
          span.append(title, meta);
          label.append(cb, span);
          container.appendChild(label);
        }
        syncMcpSummary();
        return;
      }
      if (msg.command !== 'models' || typeof msg.providerId !== 'string' || !Array.isArray(msg.models)) {
        return;
      }
      const activeProvider = byId('provider').value;
      loadingProviders.delete(msg.providerId);
      loadedProviders.add(msg.providerId);
      modelCatalog.set(msg.providerId, msg.models.filter((model) => model && typeof model.id === 'string'));
      if (msg.providerId === activeProvider) {
        syncModels();
      }
    });

    moveModelRoutingControls();
    positionModelAdvancedSection();
    syncRoleDefaults();
    syncTierDefaultLabel();
    requestModels();
    syncSkillCards();
    renderFolderAccess();
    renderCommandNarrowing();
    byId('icon').addEventListener('input', () => { iconChosenByUser = true; syncIconPreview(); });
    document.addEventListener('input', markFormDirty);
    document.addEventListener('change', markFormDirty);
    syncToolProtocolAutoLabel();
    syncIconPreview();
  </script>
</body>
</html>`, defaultLabels, initialRoleDefaultTier, initial.model);
}

function withAgentBuilderDefaultLabels(
  html: string,
  defaults: ModelParamDefaultLabels,
  roleDefaultTier: string,
  model: string
): string {
  let out = html;
  out = replaceBlankOption(out, 'mp_reasoning_effort', formatModelParamDefaultLabel(defaults.reasoningEffort));
  out = replaceBlankOption(out, 'mp_thinking', formatModelParamDefaultLabel(defaults.thinking));
  out = replaceBlankOption(out, 'mp_stream', formatModelParamDefaultLabel(defaults.stream));
  out = replaceBlankOption(out, 'mp_tier', `Use role default — ${roleDefaultTier}`);
  out = replaceOption(out, 'toolProtocol', 'auto', toolProtocolAutoLabel(model));
  out = replacePlaceholder(out, 'mp_temperature', formatModelParamDefaultLabel(defaults.temperature));
  out = replacePlaceholder(out, 'mp_top_p', formatModelParamDefaultLabel(defaults.topP));
  out = replacePlaceholder(out, 'mp_max_tokens', formatModelParamDefaultLabel(defaults.maxTokens));
  out = replacePlaceholder(out, 'mp_presence_penalty', formatModelParamDefaultLabel(defaults.presencePenalty));
  out = replacePlaceholder(out, 'mp_frequency_penalty', formatModelParamDefaultLabel(defaults.frequencyPenalty));
  out = replacePlaceholder(out, 'mp_thinking_budget', formatModelParamDefaultLabel(PROVIDER_DEFAULT_MODEL_PARAM_LABEL));
  out = replacePlaceholder(out, 'mp_tool_choice', formatModelParamDefaultLabel(defaults.toolChoice));
  out = replacePlaceholder(out, 'mp_context_window', defaults.contextWindow);
  out = replacePlaceholder(out, 'mp_stop', formatModelParamDefaultLabel(defaults.stop));
  return out;
}

function replaceBlankOption(html: string, selectId: string, label: string): string {
  return replaceOption(html, selectId, '', label);
}

function replaceOption(html: string, selectId: string, value: string, label: string): string {
  const re = new RegExp(`(<select id="${escapeRegExp(selectId)}"[\\s\\S]*?<option value="${escapeRegExp(value)}"[^>]*>)[^<]*(</option>)`);
  return html.replace(re, `$1${esc(label)}$2`);
}

function replacePlaceholder(html: string, id: string, placeholder: string): string {
  const re = new RegExp(`(<(?:input|textarea) id="${escapeRegExp(id)}"[^>]*placeholder=")[^"]*(")`);
  return html.replace(re, `$1${escAttr(placeholder)}$2`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toolProtocolAutoLabel(model: string | undefined): string {
  const target = model && model.trim() ? model.trim() : 'this model';
  return `Auto — native for ${target}`;
}

export function toolProtocolCapabilityNotice(model: string | undefined, available = true): string {
  if (!available) {
    return "This connection does not use UnodeAi's Native/XML tool-calling setting.";
  }
  if (capabilityProfile({ connectionId: 'builder-preview', modelId: model ?? '' }).protocol.effective.value.knownNativeToolLeakRisk) {
    return 'This model starts with native tool calling. If it emits a tool call as text, UnodeAi switches to XML once for this session; the first tool use may visibly retry, and tool following may be weaker.';
  }
  return '';
}

export function parseAgentBuilderSavePayload(raw: unknown, view: AgentBuilderViewModel): AgentBuilderSavePayload | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && view.mode === 'edit' && r.id === view.agent?.id ? r.id : undefined;
  const name = cleanText(r.name, 80);
  const roleKey = cleanText(r.roleKey, 80);
  const providerId = cleanText(r.providerId, 80);
  const model = cleanText(r.model, 180);
  const fallbackModel = cleanText(r.fallbackModel, 180);
  const toolProtocol = r.toolProtocol === 'xml' ? 'xml' : r.toolProtocol === 'native' ? 'native' : 'auto';
  const systemPrompt = typeof r.systemPrompt === 'string' ? r.systemPrompt.slice(0, 60_000) : '';
  if (!name || !roleKey || !providerId || !model || !systemPrompt.trim()) {
    return undefined;
  }
  const roleIds = new Set([...view.roles.map((role) => role.id), 'custom']);
  const provider = view.providers.find((p) => p.id === providerId);
  if (!roleIds.has(roleKey) || !provider) {
    return undefined;
  }
  const capabilityIds = new Set(view.capabilities.map((s) => s.id));
  const playbookIds = new Set(view.catalog.skills.map((s) => s.id));
  const mcpIds = new Set(view.mcpServers.map((s) => s.id));
  const skillIds = cleanStringArray(r.skillIds, capabilityIds, 12);
  const playbooks = cleanStringArray(r.playbooks, playbookIds, playbookIds.size);
  const mcpServers = cleanStringArray(r.mcpServers, mcpIds, 20);
  const customRole = cleanText(r.customRole, 80);
  const roleTemplateAdopted = r.roleTemplateAdopted === true;
  const stashed = typeof r.roleSwitchStashedPrompt === 'string' ? r.roleSwitchStashedPrompt.slice(0, 60_000) : '';
  const roleSwitchStashedPrompt = stashed.trim() && stashed !== systemPrompt ? stashed : undefined;
  if (roleKey === 'custom' && !customRole) {
    return undefined;
  }
  const modelParams = omitIncompatibleSamplingParameters(model, parseModelParams(r.modelParams));
  const removeLegacyModelParams = r.removeLegacyModelParams === true;
  const contextWindowTokens = sanitizeContextWindow(r.contextWindowTokens);
  const tier = r.tier === 'premium' || r.tier === 'standard' || r.tier === 'economy' ? r.tier : undefined;
  const folderAccess = parseFolderAccess(r.folderAccess);
  if (!folderAccess) {
    return undefined;
  }
  const commandNarrowing = parseCommandNarrowing(r.commandNarrowing, view.globalCommandPolicy);
  if (r.commandNarrowing !== undefined && commandNarrowing === undefined) {
    return undefined;
  }
  return {
    id,
    name,
    roleKey,
    roleTemplateAdopted,
    roleSwitchStashedPrompt,
    customRole: customRole || undefined,
    icon: sanitizeAgentIcon(r.icon),
    color: /^#[0-9a-fA-F]{6}$/.test(String(r.color ?? '')) ? String(r.color) : undefined,
    providerId,
    model,
    fallbackModel: fallbackModel || undefined,
    toolProtocol,
    systemPrompt,
    modelParams,
    removeLegacyModelParams,
    contextWindowTokens,
    tier,
    folderAccess: folderAccess.length ? folderAccess : undefined,
    commandNarrowing,
    skillIds,
    playbooks,
    mcpServers,
  };
}

/**
 * Human-readable reason a save payload is rejected — so the Agent Builder tells the user exactly what to
 * fix (e.g. "Please fill in: System prompt") instead of a generic "invalid save payload". Mirrors the
 * required-field checks in parseAgentBuilderSavePayload. Returns undefined when nothing obvious is wrong.
 */
export function describeAgentBuilderSaveProblem(raw: unknown, view: AgentBuilderViewModel): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'the form could not be read — reopen the Agent Builder and try again.';
  }
  const r = raw as Record<string, unknown>;
  const missing: string[] = [];
  if (!cleanText(r.name, 80)) { missing.push('Name'); }
  const roleKey = cleanText(r.roleKey, 80);
  if (!roleKey) { missing.push('Role'); }
  if (roleKey === 'custom' && !cleanText(r.customRole, 80)) { missing.push('Custom role name'); }
  if (!cleanText(r.providerId, 80)) { missing.push('Provider'); }
  if (!cleanText(r.model, 180)) { missing.push('Model'); }
  if (!(typeof r.systemPrompt === 'string' && r.systemPrompt.trim())) { missing.push('System prompt'); }
  if (missing.length > 0) {
    return `please fill in: ${missing.join(', ')}.`;
  }
  // Structural mismatches (shouldn't happen via the UI, but be specific if they do).
  const roleIds = new Set([...view.roles.map((role) => role.id), 'custom']);
  if (roleKey && !roleIds.has(roleKey)) { return `unknown role "${roleKey}".`; }
  const providerId = cleanText(r.providerId, 80);
  if (providerId && !view.providers.some((p) => p.id === providerId)) { return `unknown provider "${providerId}" — pick one from the list.`; }
  if (parseFolderAccess(r.folderAccess) === undefined) {
    return 'folder access rows need a folder path and either Read or Read+Write permission.';
  }
  if (r.commandNarrowing !== undefined && parseCommandNarrowing(r.commandNarrowing, view.globalCommandPolicy) === undefined) {
    return 'command access must select only command templates configured in the global policy.';
  }
  return undefined;
}

export function canSelectPlaybook(_currentIds: string[], _id: string): boolean {
  return true;
}

export function selectVisibleSkills(
  skills: SkillCatalogEntry[],
  controls: { query?: string; category?: string; role?: string; sort?: 'relevant' | 'newest' | 'most-used'; selected?: string[] },
  roles: AgentBuilderRoleOption[] = []
): SkillCatalogEntry[] {
  const q = (controls.query ?? '').trim().toLowerCase();
  const selected = new Set(controls.selected ?? []);
  const visible = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.summary} ${skill.category}`.toLowerCase();
    if (q && !haystack.includes(q)) {
      return false;
    }
    if (controls.category && skill.category !== controls.category) {
      return false;
    }
    if (controls.role) {
      const role = roles.find((r) => r.id === controls.role);
      if (role && !role.playbookIds.includes(skill.id) && !role.skillIds.includes(skill.id) && !role.skillIds.some((id) => id.includes(skill.category))) {
        return false;
      }
    }
    return true;
  });
  return visible.sort((a, b) => {
    if ((controls.sort ?? 'relevant') === 'newest') {
      return skills.indexOf(b) - skills.indexOf(a);
    }
    if (controls.sort === 'most-used') {
      const caps = b.capabilities.length - a.capabilities.length;
      if (caps) { return caps; }
      const body = Number(!!b.body) - Number(!!a.body);
      if (body) { return body; }
    }
    const selectedDelta = Number(selected.has(b.id)) - Number(selected.has(a.id));
    return selectedDelta || a.name.localeCompare(b.name);
  });
}

function initialFormState(view: AgentBuilderViewModel): Omit<Required<AgentBuilderInitialAgent>, 'commandNarrowing'> & {
  commandNarrowing?: AgentCommandNarrowing;
  roleKey: string;
  customRole: string;
} {
  const firstRole = view.roles[0];
  const firstProvider = view.providers.find((provider) => provider.availability !== 'coming-soon') ?? view.providers[0];
  const agent = view.agent;
  const roleMatch = agent
    ? (agent.roleKey ? view.roles.find((r) => r.id === agent.roleKey) : undefined)
      // Legacy custom configs are ambiguous by design; never guess the first custom template.
      ?? (agent.role === 'custom' ? undefined : view.roles.find((r) => r.role === agent.role || r.id === agent.role))
    : firstRole;
  // A NEW agent starts with no role picked: blank Name, blank Instructions, a "Select a role…" placeholder.
  // Picking a role is what populates the form. Pre-selecting the first role made the panel look configured
  // when it was not, and it meant every role switch had to overwrite text that was already sitting there.
  const roleKey = agent ? (roleMatch?.id ?? 'custom') : '';
  // Provider/model still get a working default — picking a role overrides them. Only the three fields the
  // role owns (Name, Role, Instructions) start blank.
  // The default provider is the one the user chose in Setup, NOT whichever happens to sit first in the list.
  const defaultProvider = view.providers.find((p) => p.id === view.defaultProviderId) ?? firstProvider;
  const providerId = agent?.providerId ?? defaultProvider?.id ?? 'roam';
  const model = agent?.model ?? defaultProvider?.models[0]?.id ?? '';
  return {
    id: agent?.id ?? '',
    name: agent?.name ?? '',
    role: agent?.role ?? 'custom',
    roleLabel: agent?.roleLabel ?? '',
    roleKey,
    customRole: roleKey === 'custom' ? agent?.roleLabel ?? agent?.role ?? '' : '',
    icon: agent?.icon ?? 'A',
    color: agent?.color ?? '#4f7cac',
    providerId,
    model,
    fallbackModel: agent?.fallbackModel ?? '',
    toolProtocol: agent?.toolProtocol ?? 'auto',
    systemPrompt: agent?.systemPrompt ?? '',
    skillIds: agent?.skillIds ?? [],
    playbooks: agent?.playbooks ?? [],
    mcpServers: agent?.mcpServers ?? [],
    modelParams: agent?.modelParams ?? {},
    contextWindowTokens: agent?.contextWindowTokens ?? 0, // 0 = unset → rendered blank
    tier: agent?.tier ?? '',
    smartModeEnabled: agent?.smartModeEnabled ?? false,
    backend: agent?.backend ?? (providerId === 'anthropic' ? 'claude' : providerId === 'codex' ? 'codex' : 'openai-compat'),
    folderAccess: agent?.folderAccess ?? [],
    folderAccessIssues: agent?.folderAccessIssues ?? [],
    commandNarrowing: agent?.commandNarrowing,
    promptTemplate: agent?.promptTemplate ?? {
      state: 'template-current',
      label: 'Current role template',
      detail: 'This agent follows the latest default guidance for its role.',
      showUpdateNotice: false,
      canReset: false,
      canUndo: false,
    },
  };
}

/** Browser-originated command choices are a subset only; no text field can mint a new template. */
function parseCommandNarrowing(
  value: unknown,
  global: AgentBuilderViewModel['globalCommandPolicy'],
): AgentCommandNarrowing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.approvalMode !== 'allowlist' || !Array.isArray(raw.allowedCommands)) {
    return undefined;
  }
  const available = new Set((global?.allowedCommands ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const selected = raw.allowedCommands
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase());
  if (selected.length > 100 || selected.some((entry) => !entry || !available.has(entry))) {
    return undefined;
  }
  return { approvalMode: 'allowlist', allowedCommands: [...new Set(selected)] };
}

function promptTemplateStatusCard(prompt: NonNullable<AgentBuilderInitialAgent['promptTemplate']>): string {
  const update = prompt.showUpdateNotice
    ? '<strong>Updated default available.</strong> '
    : '';
  const diff = prompt.diff
    ? `<details class="prompt-template-diff"><summary>Show default guidance diff</summary><pre>${esc(prompt.diff)}</pre></details>`
    : '';
  const actions = [
    prompt.showUpdateNotice
      ? '<button class="btn" type="button" data-prompt-template-action="dismiss">Keep mine</button>'
      : '',
    prompt.canReset
      ? '<button class="btn" type="button" data-prompt-template-action="adopt">Reset to current template…</button>'
      : '',
    prompt.canUndo
      ? '<button class="btn" type="button" data-prompt-template-action="undo">Undo template reset</button>'
      : '',
  ].join('');
  return /* html */`
    <div class="prompt-template-status" data-prompt-template-state="${escAttr(prompt.state)}">
      <div>${update}<strong>${esc(prompt.label)}</strong> — ${esc(prompt.detail)}</div>
      ${diff}
      ${actions ? `<div class="prompt-template-actions">${actions}</div>` : ''}
    </div>`;
}

function skillCards(skills: SkillCatalogEntry[], roles: AgentBuilderRoleOption[], selected: string[]): string {
  if (skills.length === 0) {
    return '<div class="empty">No playbooks in the active catalog yet.</div>';
  }
  const selectedSet = new Set(selected);
  // Alphabetical by name so a long unselected list can be scanned. `data-index` deliberately stays the
  // catalogue position: the "Newest" sort reads it, and re-basing it here would silently turn that option
  // into reverse-alphabetical.
  const ordered = skills
    .map((skill, index) => ({ skill, index }))
    .sort((a, b) => byDisplayName(a.skill.name, b.skill.name));
  return ordered.map(({ skill, index }) => {
    const roleIds = rolesForSkill(skill, roles).join(',');
    const checked = selectedSet.has(skill.id) ? 'checked' : '';
    return /* html */`
      <article class="skill-card ${checked ? 'selected' : ''}"
        data-skill-id="${escAttr(skill.id)}"
        data-index="${index}"
        data-name="${escAttr(skill.name.toLowerCase())}"
        data-label="${escAttr(skill.name)}"
        data-summary="${escAttr(skill.summary)}"
        data-search="${escAttr(`${skill.name} ${skill.summary} ${skill.category}`.toLowerCase())}"
        data-category="${escAttr(skill.category)}"
        data-roles="${escAttr(roleIds)}"
        data-has-body="${skill.body ? '1' : '0'}"
        data-capabilities="${skill.capabilities.length}">
        <label class="skill-head">
          <input type="checkbox" data-playbook-id="${escAttr(skill.id)}" ${checked}>
          <span>
            <span class="skill-title">${esc(skill.name)}</span>
            <span class="meta">${esc(labelForCategory(skill.category))}</span>
          </span>
        </label>
        <p class="summary">${esc(skill.summary)}</p>
        <div class="tagline">${skill.capabilities.slice(0, 4).map((cap) => `<span class="tag">${esc(cap)}</span>`).join('')}</div>
      </article>`;
  }).join('');
}

function capabilityChecks(capabilities: AgentBuilderCapabilityOption[], selected: string[]): string {
  if (capabilities.length === 0) {
    return '<div class="empty">No tool capabilities available.</div>';
  }
  const selectedSet = new Set(selected);
  // Alphabetical for the same reason as the playbook grid. Selected/unselected partitioning in
  // syncCapabilityCards preserves relative order, so sorting once here orders both lists.
  const ordered = [...capabilities].sort((a, b) => byDisplayName(a.name, b.name));
  return ordered.map((cap) => /* html */`
    <label class="check">
      <input type="checkbox" data-capability-id="${escAttr(cap.id)}" data-capability-tools="${escAttr((cap.requiredTools ?? []).join(','))}" ${selectedSet.has(cap.id) ? 'checked' : ''}>
      <span><span class="skill-title">${esc(cap.name)}</span><span class="meta"> ${esc(cap.category)}</span><br><span class="meta">${esc(cap.description)}</span><br><span class="meta" data-capability-limit hidden>Unavailable on this connection.</span></span>
    </label>`
  ).join('');
}

function mcpChecks(servers: AgentBuilderMcpOption[], selected: string[]): string {
  if (servers.length === 0) {
    return '<div class="empty">No MCP servers registered yet.</div>';
  }
  const selectedSet = new Set(selected);
  return servers.map((server) => /* html */`
    <label class="check">
      <input type="checkbox" data-mcp-id="${escAttr(server.id)}" ${selectedSet.has(server.id) ? 'checked' : ''}>
      <span><span class="skill-title">${esc(server.name)}</span><span class="meta"> ${esc(server.transport)}${server.connected ? ' / connected' : ''}${server.requiresApproval ? ' / approval' : ''}</span></span>
    </label>`
  ).join('');
}

function rolesForSkill(skill: SkillCatalogEntry, roles: AgentBuilderRoleOption[]): string[] {
  return roles
    .filter((role) => role.playbookIds.includes(skill.id) || role.skillIds.includes(skill.id) || role.skillIds.some((id) => id.includes(skill.category)))
    .map((role) => role.id);
}

function uniqueCategories(skills: SkillCatalogEntry[]): SkillCategory[] {
  return [...new Set(skills.map((s) => s.category))].sort();
}

function labelForCategory(category: string): string {
  return category.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Render a model-fine-tuning number input's value (blank when unset, so the placeholder shows). */
function mpVal(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** <option>s for the reasoning-effort select, with the current value selected. */
function reasoningEffortOptions(current: string | undefined, defaultLabel = 'medium'): string {
  const opts: Array<[string, string]> = [
    ['', formatModelParamDefaultLabel(defaultLabel)], ['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'],
    ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'X-High'], ['max', 'Max'],
  ];
  return opts.map(([v, label]) => `<option value="${v}" ${current === v || (!current && v === '') ? 'selected' : ''}>${label}</option>`).join('');
}

/** Generic <option>s helper for the model-tuning selects, with the current value selected. */
function mpSelect(opts: Array<[string, string]>, current: string): string {
  return opts.map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`).join('');
}

/** <option>s for the per-agent tier select ('' = follow the role/default tier). */
function tierOptions(current: ModelTier | '', roleDefault = 'standard'): string {
  const opts: Array<[string, string]> = [
    ['', `Use role default — ${roleDefault}`], ['premium', 'Premium'], ['standard', 'Standard'], ['economy', 'Economy'],
  ];
  return opts.map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`).join('');
}

/** Parse the model fine-tuning fields from the (untrusted) webview into AgentModelParams. Reuses the SAME
 *  `sanitizeParams` the Settings panel uses, so both entry points produce IDENTICAL params (the fields stay
 *  in sync). Blank fields are omitted so the agent falls back to global defaults; undefined when nothing set. */
function parseModelParams(raw: unknown): AgentModelParams | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
  const r = raw as Record<string, unknown>;
  const assembled: Record<string, unknown> = {
    temperature: r.temperature,
    top_p: r.top_p,
    max_tokens: r.max_tokens,
    reasoning_effort: r.reasoning_effort,
    presence_penalty: r.presence_penalty,
    frequency_penalty: r.frequency_penalty,
    response_format: r.response_format,
    tool_choice: r.tool_choice,
    stop: typeof r.stop === 'string' ? r.stop.split(/\r?\n/) : r.stop, // one stop sequence per line
    stream: r.stream === 'enabled' ? true : r.stream === 'disabled' ? false : undefined,
  };
  if (r.thinking_type === 'enabled') {
    assembled.thinking = { type: 'enabled', budget_tokens: r.thinking_budget_tokens };
  } else if (r.thinking_type === 'disabled') {
    assembled.thinking = { type: 'disabled' };
  }
  const out = sanitizeParams(assembled);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseFolderAccess(raw: unknown): FolderGrant[] | undefined {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: FolderGrant[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return undefined;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.path !== 'string') {
      return undefined;
    }
    const folderPath = r.path.trim().slice(0, 1000);
    if (!folderPath || (r.permission !== 'read' && r.permission !== 'readwrite')) {
      return undefined;
    }
    out.push({ path: folderPath, permission: r.permission });
    if (out.length >= 40) {
      break;
    }
  }
  return out;
}

function cleanStringArray(value: unknown, known: Set<string>, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw === 'string' && known.has(raw) && !out.includes(raw)) {
      out.push(raw);
      if (out.length >= max) {
        break;
      }
    }
  }
  return out;
}

function jsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').replace(/</g, '\\u003c');
}
