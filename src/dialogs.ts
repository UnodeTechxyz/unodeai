/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Dialogs (extracted from extension.ts, P1#8)
 *  All the QuickPick/InputBox flows (add agent, default team, send message, run workflow, set key)
 *  plus the model picker. Pulled out of extension.ts to keep the entry point a thin orchestrator.
 *  Dependencies are passed in via DialogDeps rather than reaching for module globals.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentConfig, AgentBackendKind, ContextWindowMeasurement, Message, ProviderRef } from './types';
import { SessionManager } from './session/SessionManager';
import { MessageBus } from './bus/MessageBus';
import { WorkflowEngine } from './workflow/WorkflowEngine';
import { SecretsManager } from './secrets/SecretsManager';
import { ModelCatalog, ModelInfo } from './models/ModelCatalog';
import { intentionallyUnknownPriceLabel, ModelPricing } from './models/ModelPricing';
import { resolveModelCatalogBaseUrl } from './models/modelCatalogBaseUrl';
import { CommandPolicy } from './backend/CommandPolicy';
import { promptCommandApproval } from './backend/CommandApprovalPrompter';
import { apiKeySecretNameForProvider } from './backend/backendKind';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  connectionIdForProviderId,
  connectionProfile,
  legacyProviderIdForConnectionId,
  providerRefForConnectionId,
  routeForConnectionId,
} from './routes/ConnectionRegistry';
import {
  canCoordinateTeam,
  capabilityViolations,
  connectionProfileForAgent,
  supportedAllowedTools,
  supportedModelParams,
} from './routes/CapabilityGuard';
import {
  AgentConfigBuilder,
  ROLE_TEMPLATES,
  TEAM_PRESETS,
  TeamPreset,
  modelForRole,
} from './roles/RoleConfig';
import { distinctAgentIcon } from './roles/agentIconPalette';
import { stableProviderSort } from './routes/stableProviderSort';

/** Icons the roster is already wearing. Read fresh at each creation, because a crew preset creates
 *  its agents one at a time and each must see the ones before it. */
function rosterIcons(d: DialogDeps): string[] {
  return d.sessionManager.getAll().map((s) => s.config.icon).filter((icon): icon is string => !!icon);
}

export interface DialogDeps {
  sessionManager: SessionManager;
  messageBus: MessageBus;
  workflowEngine: WorkflowEngine;
  secrets: SecretsManager;
  modelCatalog: ModelCatalog;
  pricing: ModelPricing;
  commandPolicy: CommandPolicy;
  output: vscode.LogOutputChannel;
  /** `scope` narrows the refresh to one provider's own price source — picker paths must pass it. */
  refreshPrices: (opts?: { scope?: string }) => Promise<void> | void;
  /**
   * The one host-owned write boundary for a credential the user just supplied.  It stores the
   * secret, asks for a connection's price coefficient, then invalidates credential-derived data.
   */
  storeUserInitiatedProviderKey: (secretName: string, value: string, connectionId?: string) => Promise<void>;
  /** Ask (once per host, user-initiated only) for the metadata hosts THIS provider's picker will contact. */
  ensureModelPickerConsent: (providerId: string, baseUrl?: string) => Promise<void>;
  defaultBackendKind: (c: AgentConfig) => AgentBackendKind;
  /** `unode.defaultProvider` — the provider new agents are created with (set by the setup wizard and the
   *  Settings → Providers "set as default" action). Must be READ here: it was previously written-only,
   *  so picking Claude Headless silently still produced Unode agents. */
  defaultProvider: () => string;
  /** The current host-owned registry snapshot. Dynamic connections must never use a module-global map. */
  connectionResolver?: ConnectionResolver;
  /** The one user-initiated Connection / Pay through chooser used by every creation path. */
  chooseConnection?: (items: readonly ConnectionPick[], title: string) => PromiseLike<ConnectionPick | undefined>;
  /** Persist the roster + refresh the team view after an in-place edit (P2#14). */
  onRosterChanged?: () => void;
  /** Real extension-host fixtures have no human to answer post-create modals. Never enabled in production. */
  suppressInteractivePostCreatePrompts?: boolean;
  /** Fixtures clear the roster explicitly and must not wait for the confirmation modal if it rehydrates. */
  skipExistingTeamWarning?: boolean;
  /** Fixtures use the saved default connection instead of a QuickPick that has no human respondent. */
  useDefaultConnection?: boolean;
  /**
   * Called after the user confirms a roster-replacing switch and before any session is removed.
   *
   * The host snapshots the outgoing team here. It is on this side of the confirmation on purpose: taking it
   * before the user has chosen would write a backup for a switch that never happened and, ten of those
   * later, prune a real restore point. Returning `false` aborts the switch.
   */
  beforeReplaceRoster?: () => Promise<boolean>;
}

/** A team-unique agent name: returns `base`, or `base 2`, `base 3`… if already taken. */
export function uniqueAgentName(d: DialogDeps, base: string): string {
  const existing = new Set(d.sessionManager.getAll().map((s) => s.config.name));
  if (!existing.has(base)) { return base; }
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) { return candidate; }
  }
}

export type ConnectionPick = vscode.QuickPickItem & { providerKey: string; connectionId: string };

/** The registry is the only source for Agent Builder/Add Agent connection presentation and billing copy. */
function connectionPickItems(defaultProviderId: string, resolver: ConnectionResolver): ConnectionPick[] {
  const defaultRank = (providerId: string) => providerId === defaultProviderId ? -1 : 0;
  return resolver.profiles
    .flatMap((profile) => {
      if (profile.availability !== 'available') { return []; }
      // Resolve against the SAME registry the picker was built from. Defaulting to the built-in
      // registry (as the missing argument did) drops every custom:<id> profile, so named gateways
      // never appeared in Add Agent / Solo / team-preset pickers.
      const providerKey = legacyProviderIdForConnectionId(profile.id, resolver);
      if (!providerKey) { return []; }
      return [{
        label: `${providerKey === defaultProviderId ? '$(check) ' : ''}${profile.presentation.displayName}`,
        description: `${profile.presentation.runtimeLabel} · ${profile.presentation.billingLabel}`,
        detail: profile.presentation.privacySummary,
        providerKey,
        connectionId: profile.id,
      }];
    })
    .sort((a, b) => defaultRank(a.providerKey) - defaultRank(b.providerKey) || a.label.localeCompare(b.label));
}

async function chooseConnectionForNewAgent(d: DialogDeps, title: string): Promise<string> {
  const defaultProviderId = d.defaultProvider();
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  if (!d.chooseConnection) {
    return defaultProviderId;
  }
  const picked = await d.chooseConnection(connectionPickItems(defaultProviderId, resolver), title);
  return picked?.providerKey ?? defaultProviderId;
}

function selectedConnection(d: DialogDeps, providerKey: string): { connectionId: string; profile: NonNullable<ReturnType<ConnectionResolver['connectionProfile']>>; provider: ProviderRef } {
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  const connectionId = connectionIdForProviderId(providerKey, resolver);
  const profile = connectionId ? connectionProfile(connectionId, resolver) : undefined;
  const provider = connectionId ? providerRefForConnectionId(connectionId, resolver) : undefined;
  if (!connectionId || !profile || !provider) {
    throw new Error(`Unknown connection "${providerKey}".`);
  }
  return { connectionId, profile, provider };
}

function applySelectedConnection(config: AgentConfig, selection: ReturnType<typeof selectedConnection>, d: DialogDeps): AgentConfig {
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  config.provider = selection.provider;
  config.backend = selection.profile.backendKind;
  config.route = routeForConnectionId(selection.connectionId, config.model, resolver);
  if (selection.profile.kind === 'openai-compatible') {
    config.baseUrl = selection.profile.presentation.endpointDefault;
  } else {
    delete config.baseUrl;
  }
  return config;
}

function initialModelForConnection(
  template: Parameters<typeof modelForRole>[0],
  providerKey: string,
  selection: ReturnType<typeof selectedConnection>,
): string {
  const tierModel = modelForRole(template, providerKey);
  // The static role tier table intentionally has no entries for custom:<opaque-id>; never let its
  // legacy Roam fallback route a new gateway selection to an unrelated model list.
  return selection.connectionId.startsWith('custom:')
    ? selection.profile.catalogModels[0]?.id ?? template.model
    : tierModel;
}

function isDynamicCustomConnection(connectionId: string): boolean {
  return connectionId.startsWith('custom:');
}

/**
 * Templates may ask for write/command tools, while a user can deliberately choose a read-only
 * connection. This is an explicit creation-time adaptation (and is reported to the user), not a
 * persistence bypass: hand-edited or webview configurations still fail the host assertion.
 */
function adaptGeneratedConfigToConnection(d: DialogDeps, config: AgentConfig): string[] {
  const profile = connectionProfileForAgent(config, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
  if (!profile) {
    throw new Error(`Unknown connection "${config.provider.providerId}".`);
  }
  const beforeTools = config.allowedTools ?? [];
  const compatibleTools = supportedAllowedTools(profile.capabilities, beforeTools);
  const removedTools = beforeTools.filter((tool) => !compatibleTools.includes(tool));
  config.allowedTools = compatibleTools;
  const beforeParams = config.modelParams;
  config.modelParams = supportedModelParams(profile.capabilities, beforeParams);
  const removedParams = Object.keys(beforeParams ?? {}).filter((key) => !profile.capabilities.modelParams.has(key));
  const removed: string[] = [];
  if (!profile.capabilities.skills && ((config.skills?.length ?? 0) > 0 || (config.playbooks?.length ?? 0) > 0)) {
    config.skills = [];
    config.playbooks = [];
    removed.push('skill and playbook grants');
  }
  if (!profile.capabilities.folderAccess && (config.folderAccess?.length ?? 0) > 0) {
    config.folderAccess = undefined;
    removed.push('Folder Access grants');
  }
  if (!profile.capabilities.toolProtocol && config.toolProtocol) {
    config.toolProtocol = undefined;
    removed.push('tool-calling method');
  }
  if (!profile.capabilities.smartMode && config.tier) {
    config.tier = undefined;
    removed.push('Smart Mode tier');
  }
  return [
    ...removedTools.map((tool) => `${tool} tool`),
    ...removedParams.map((key) => `${key} model parameter`),
    ...removed,
  ];
}

function assertCreatableConfig(d: DialogDeps, config: AgentConfig): string | undefined {
  const violations = capabilityViolations(config, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
  return violations.length > 0 ? violations.map((violation) => violation.message).join(' ') : undefined;
}

function modelCatalogBaseUrl(providerKey: string, resolver: ConnectionResolver): string | undefined {
  return resolveModelCatalogBaseUrl(providerKey, resolver);
}

function priceProviderLabel(providerId?: string): string {
  const id = providerId?.trim().toLowerCase();
  const known: Record<string, string> = { roam: 'Roam', unode: 'Unode', openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic' };
  return (id && known[id]) || (providerId?.trim() || 'Default');
}

/**
 * Model picker for the add-agent dialog. Opens immediately with the static list, then asynchronously
 * fills in the live catalog (gateway /v1/models + optional Roam-hosted catalog) via ModelCatalog.
 * Always accepts a free-typed model id too, so an empty/slow catalog never blocks the user.
 */
export interface PickedModel {
  id: string;
  measuredContextWindow?: ContextWindowMeasurement;
}

/** Apply a picker observation without ever overwriting a number the user explicitly configured. */
function applyPickedContextWindow(config: AgentConfig, picked: PickedModel, providerName: string): void {
  const measurement = picked.measuredContextWindow;
  if (config.contextWindowTokens !== undefined) {
    if (measurement && measurement.tokens !== config.contextWindowTokens) {
      void vscode.window.showWarningMessage(
        `Kept your explicit ${config.contextWindowTokens.toLocaleString()}-token context window; `
        + `${providerName} reported ${measurement.tokens.toLocaleString()} via ${measurement.field}.`,
      );
    }
    return;
  }
  if (measurement?.model === config.model) {
    config.measuredContextWindow = measurement;
    void vscode.window.showInformationMessage(
      `Using the ${measurement.tokens.toLocaleString()}-token context window advertised by ${providerName} via ${measurement.field}.`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `${providerName} did not advertise a context window for ${config.model}; using the assumed 1,048,576-token default.`,
  );
}

export async function pickModel(
  d: DialogDeps,
  providerKey: string,
  defaultModel: string,
  baseUrl?: string,
  apiKey?: string
): Promise<PickedModel | undefined> {
  // The Add-Agent picker is user-initiated, so offer metadata consent before asking either the model
  // endpoint/catalog or this provider's live price source. A decline leaves the consent gate closed;
  // the non-blocking calls below then fall straight back to the built-in static model/price data.
  const resolvedBaseUrl = modelCatalogBaseUrl(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
  await d.ensureModelPickerConsent(providerKey, resolvedBaseUrl);
  // Scoped: selecting a model for ONE provider refreshes only that provider's own price source. Approved but
  // unrelated gateways are not contacted by this action.
  void d.refreshPrices({ scope: providerKey });

  const priceLabel = (id: string): string => {
    const resolved = d.pricing?.priceInfoFor(id, providerKey);
    if (!resolved) { return intentionallyUnknownPriceLabel(id) ?? ''; }
    const p = resolved.price;
    return `$${p.input}/$${p.output} per 1M · ${priceProviderLabel(providerKey)} (${resolved.source})`;
  };
  const toItem = (m: ModelInfo): vscode.QuickPickItem => ({
    label: m.id,
    description: [
      m.name,
      m.id === defaultModel ? 'recommended' : '',
      m.vision ? 'vision' : '',
      m.source === 'endpoint' ? 'live' : '',
      priceLabel(m.id),
    ].filter(Boolean).join(' · '),
  });

  return new Promise<PickedModel | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = 'UnodeAi — Model  ·  browse models & pricing: https://www.unodetech.xyz/pricing?lang=en';
    qp.placeholder = 'Pick a model or type a custom model id (e.g. deepseek-v4-flash, gpt-4o)';
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;

    let catalogItems: vscode.QuickPickItem[] = [];
    const modelById = new Map<string, ModelInfo>();
    let done = false;

    const rebuild = (): void => {
      const typed = qp.value.trim();
      const exists = catalogItems.some((i) => i.label === typed);
      qp.items = typed && !exists ? [{ label: typed, description: 'custom model id' }, ...catalogItems] : catalogItems;
    };
    const finish = (val: string | undefined): void => {
      if (done) { return; }
      done = true;
      const model = val ? modelById.get(val) : undefined;
      resolve(val ? { id: val, measuredContextWindow: model?.measuredContextWindow } : undefined);
      qp.hide();
    };

    qp.onDidChangeValue(rebuild);
    qp.onDidAccept(() => finish(qp.selectedItems[0]?.label ?? (qp.value.trim() || undefined)));
    qp.onDidHide(() => {
      if (!done) { done = true; resolve(undefined); }
      qp.dispose();
    });

    qp.busy = true;
    qp.show();

    d.modelCatalog
      .list(providerKey, resolvedBaseUrl, apiKey)
      .then((models) => {
        if (done) { return; }
        for (const model of models) {
          modelById.set(model.id, model);
        }
        // If nothing came from a live source (curated catalog or the gateway /models endpoint), the
        // list is the built-in static fallback — surface that non-blockingly instead of silently
        // showing only a handful of models (looks like a regression; usually a missing key/base URL).
        const liveOk = models.some((m) => m.source !== 'static');
        const notice: vscode.QuickPickItem[] = liveOk ? [] : [{
          label: 'Live model list unavailable — showing built-in defaults (check API key / base URL)',
          kind: vscode.QuickPickItemKind.Separator,
        }];
        catalogItems = [...notice, ...models.map(toItem)];
        rebuild();
        const recommended = catalogItems.find((i) => i.label === defaultModel);
        if (recommended) {
          qp.activeItems = [recommended];
        } else if (defaultModel && !qp.value) {
          qp.value = defaultModel;
          rebuild();
        }
      })
      .catch((err) => d.output.warn(`Model catalog fetch failed: ${String(err)}`))
      .finally(() => {
        if (!done) { qp.busy = false; }
      });
  });
}

/**
 * One-click onboarding: stand up a ready-to-run PM + Architect + Senior Developer + Reviewer team
 * on Roam, so a new user sees the core "PM orchestrates a crew" value in seconds.
 */
/** Shared: instantiate a team of the given roles on Roam, then prompt for API key + command enablement. */
export async function instantiateTeam(
  d: DialogDeps,
  roleKeys: (keyof typeof ROLE_TEMPLATES)[],
  label: string
): Promise<AgentConfig[]> {
  // Every team ships with a standalone Solo agent (a no-delegate generalist) so the user always has a
  // fast, single-agent option for a simple one-off alongside the PM-orchestrated crew. Solo is NOT a
  // crew member the PM delegates to — TeamTools excludes role 'solo' from the delegation roster.
  const roster = roleKeys.includes('solo') ? roleKeys : [...roleKeys, 'solo'];
  // Honor the configured default provider (set by the setup wizard / Settings → Providers). Previously
  // hardcoded to 'unode', which silently discarded a Claude Headless choice.
  const providerKey = await chooseConnectionForNewAgent(d, 'UnodeAi — Connection / Pay through');
  const selection = selectedConnection(d, providerKey);
  if (roleKeys.includes('pm') && !canCoordinateTeam(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY)) {
    await vscode.window.showWarningMessage(
      'The selected connection cannot run a Project Manager or delegate tasks. Choose a coordinator-capable connection to create this team.'
    );
    return [];
  }
  // Custom gateways ship no built-in model catalog, so every preset role would otherwise fall back to the
  // template's Claude-tier id and 404 on the first turn. Ask once for a model (the same consent-gated
  // picker the single-agent flow uses) and apply it to the whole crew; if the user cancels, create nothing
  // rather than a broken team. Built-in gateways keep their per-role tier resolution below, unchanged.
  let crewModelOverride: string | undefined;
  let crewMeasuredContextWindow: ContextWindowMeasurement | undefined;
  if (isDynamicCustomConnection(selection.connectionId)) {
    const apiKey = selection.provider.apiKeySecretName ? await d.secrets.get(selection.provider.apiKeySecretName) : undefined;
    const picked = await pickModel(d, providerKey, '', selection.profile.presentation.endpointDefault, apiKey);
    if (!picked) {
      d.output.info(`Team creation cancelled: no model chosen for ${selection.profile.presentation.displayName}.`);
      return [];
    }
    crewModelOverride = picked.id;
    crewMeasuredContextWindow = picked.measuredContextWindow;
  }
  const created: AgentConfig[] = [];
  for (const roleKey of roster) {
    const template = ROLE_TEMPLATES[roleKey];
    // No setWorkingDirectory: the runtime resolves the root per session (SessionInfo.runtimeWorkingDirectory).
    const config = new AgentConfigBuilder(template.role)
      .fromTemplate(roleKey)
      .setName(uniqueAgentName(d, template.name))
      .setIcon(distinctAgentIcon(template.icon, rosterIcons(d)))
      .setProviderRef(selection.provider)
      // Provider-aware: for 'anthropic' this resolves the role's tier to a Claude model. For a custom
      // gateway, crewModelOverride is the one model the user chose above (applied to every role).
      .setModel(crewModelOverride ?? initialModelForConnection(template, providerKey, selection))
      .setAutoApprove(false)
      .build();
    if (crewMeasuredContextWindow?.model === config.model) {
      config.measuredContextWindow = crewMeasuredContextWindow;
    }
    applySelectedConnection(config, selection, d);
    const removed = adaptGeneratedConfigToConnection(d, config);
    const rejected = assertCreatableConfig(d, config);
    if (rejected) {
      throw new Error(rejected);
    }
    d.sessionManager.create(config);
    created.push(config);
    if (removed.length > 0) {
      d.output.info(`${config.name}: ${removed.join(', ')} omitted because this connection is read-only.`);
    }
  }
  d.output.info(`Created team: ${label} (provider: ${providerKey}).`);

  // Claude Headless authenticates through the user's own `claude` CLI login. It DOES have an
  // ANTHROPIC_API_KEY entry, but prompting for one here would make the CLI bill per-token instead of
  // drawing on the user's Pro/Max plan — so never prompt for a CLI-auth provider.
  if (!d.suppressInteractivePostCreatePrompts) {
    const secretName = apiKeySecretNameForProvider(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
    if (secretName && !(await d.secrets.has(secretName))) {
      const choice = await vscode.window.showInformationMessage(
        `Team created (${label}). Set your provider API key to start working.`, 'Set API Key'
      );
      if (choice === 'Set API Key') {
        await promptAndStoreProviderKey(d, secretName);
      }
    } else {
      vscode.window.showInformationMessage(`Team created: ${label}. Send the PM a task to begin.`);
    }
    // F2: after creating a team, proactively suggest enabling commands.
    const accepted = await promptCommandApproval(d.commandPolicy.approvalMode);
    if (accepted) {
      const cfg = vscode.workspace.getConfiguration('unode');
      d.commandPolicy.reload(
        cfg.get<'none' | 'allowlist' | 'all'>('commandApproval', 'none') as any,
        cfg.get<string[]>('allowedCommands', [])
      );
    }
  }
  return created;
}

export async function createDefaultTeam(d: DialogDeps): Promise<AgentConfig[]> {
  if (!d.skipExistingTeamWarning && d.sessionManager.getAll().length > 0) {
    const choice = await vscode.window.showWarningMessage(
      'You already have agents. Add the default PM + Architect + Developer + Reviewer team anyway?', 'Add', 'Cancel'
    );
    if (choice !== 'Add') { return []; }
  }
  return instantiateTeam(d, ['pm', 'architect', 'senior-dev', 'reviewer'], 'PM + Architect + Developer + Reviewer');
}

/**
 * D1 UI: create a new team from a preset, or switch by replacing the current one.
 * Persistence model note: UnodeAi currently stores ONE active roster in workspaceState,
 * optionally mirrored/seeded by one `.unode/team.json`; there is no multi-team profile store.
 */
export type TeamPresetItem = vscode.QuickPickItem & {
  roles: (keyof typeof ROLE_TEMPLATES)[];
  teamLabel: string;
  presetKind: NonNullable<TeamPreset['kind']>;
  verifyCommand?: string;
};

function isTeamPresetItem(item: vscode.QuickPickItem): item is TeamPresetItem {
  return Array.isArray((item as TeamPresetItem).roles);
}

export function teamPresetItems(): vscode.QuickPickItem[] {
  const specialists = (roles: (keyof typeof ROLE_TEMPLATES)[]) =>
    roles.filter((r) => r !== 'pm').map((r) => ROLE_TEMPLATES[r]?.name ?? r).join(', ');
  const software: TeamPresetItem = {
    label: '$(organization) Software Team',
    description: 'PM + Architect + Developer + Reviewer',
    detail: 'Full coding crew with an independent review gate.',
    roles: ['pm', 'architect', 'senior-dev', 'reviewer'],
    teamLabel: 'Software Team (PM + Architect + Developer + Reviewer)',
    presetKind: 'software',
  };
  const fromPreset = (p: TeamPreset): TeamPresetItem => ({
    label: `${p.kind === 'pack' ? '$(tools)' : '$(briefcase)'} ${p.label}`,
    description: p.description ?? `PM + ${specialists(p.roles)}`,
    detail: `Roles: PM + ${specialists(p.roles)}${p.verifyCommand ? ` | Verify: ${p.verifyCommand}` : ''}`,
    roles: p.roles,
    teamLabel: p.label,
    presetKind: p.kind ?? 'knowledge',
    verifyCommand: p.verifyCommand,
  });
  const presets = Object.values(TEAM_PRESETS);
  return [
    { label: 'Software', kind: vscode.QuickPickItemKind.Separator },
    software,
    // Software-kind presets from the catalog render here; without this filter they exist in
    // TEAM_PRESETS but never appear in the picker at all.
    ...presets.filter((p) => p.kind === 'software').map(fromPreset),
    { label: 'Task Packs', kind: vscode.QuickPickItemKind.Separator },
    ...presets.filter((p) => p.kind === 'pack').map(fromPreset),
    { label: 'Knowledge Work', kind: vscode.QuickPickItemKind.Separator },
    ...presets.filter((p) => (p.kind ?? 'knowledge') === 'knowledge').map(fromPreset),
  ];
}

async function pickTeamPreset(title: string, placeHolder: string): Promise<TeamPresetItem | undefined> {
  const pick = await vscode.window.showQuickPick(teamPresetItems(), { title, placeHolder, matchOnDetail: true });
  return pick && isTeamPresetItem(pick) ? pick : undefined;
}

async function createPickedTeam(d: DialogDeps, pick: TeamPresetItem): Promise<AgentConfig[]> {
  const created = await instantiateTeam(d, pick.roles, pick.teamLabel);
  if (created.length > 0) {
    await maybeOfferVerifyCommand(pick);
  }
  return created;
}

async function maybeOfferVerifyCommand(pick: TeamPresetItem): Promise<void> {
  const command = pick.verifyCommand?.trim();
  if (!command) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('unode');
  const current = cfg.get<string>('verifyCommand', '').trim();
  if (current === command) {
    // Already configured — confirm it so the user knows the gate is wired for this crew (no silent no-op).
    void vscode.window.showInformationMessage(`${pick.teamLabel}: verification gate is set to "${command}". ✓`);
    return;
  }
  // Modal so it can't be missed in the notification corner — configuring the verify gate is the point of
  // a Team Pack, and it changes how the PM reports "done" (verified-only). The user still decides.
  if (!current) {
    const choice = await vscode.window.showInformationMessage(
      `${pick.teamLabel} works best with a verification command so "only verified work lands". Set unode.verifyCommand to "${command}"?`,
      { modal: true },
      'Use Verify Command',
      'Skip'
    );
    if (choice === 'Use Verify Command') {
      await cfg.update('verifyCommand', command, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(`unode.verifyCommand set to "${command}" for ${pick.teamLabel}.`);
    }
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `unode.verifyCommand is already "${current}". Replace it with "${command}" for ${pick.teamLabel}?`,
    { modal: true },
    'Replace',
    'Keep Existing'
  );
  if (choice === 'Replace') {
    await cfg.update('verifyCommand', command, vscode.ConfigurationTarget.Workspace);
  }
}

export async function createTeamFromPreset(d: DialogDeps): Promise<AgentConfig[]> {
  type ActionItem = vscode.QuickPickItem & ({ action: 'create' } | { action: 'switch'; preset: TeamPresetItem });
  const currentCount = d.sessionManager.getAll().length;
  const actions: ActionItem[] = [
    {
      label: '$(plus) Create a new team...',
      description: 'Pick a preset and add it to the current roster',
      detail: 'Keeps existing agents unless you cancel at the add confirmation.',
      action: 'create',
    },
    ...teamPresetItems().filter(isTeamPresetItem).map((preset): ActionItem => ({
      ...preset,
      description: currentCount > 0 ? `Switch - replace ${currentCount} current agent(s)` : 'Switch to this preset',
      detail: currentCount > 0 ? `Replaces your active roster with ${preset.teamLabel}.` : `Creates ${preset.teamLabel}.`,
      action: 'switch',
      preset,
    })),
  ];
  const action = await vscode.window.showQuickPick(actions, {
    title: 'Create or Switch Team',
    placeHolder: 'Create a new team, or switch by replacing the current active roster',
  });
  if (!action) { return []; }

  if (action.action === 'create') {
    const pick = await pickTeamPreset('Create a Team', 'Pick a team to create');
    if (!pick) { return []; }
    if (currentCount > 0) {
      const choice = await vscode.window.showWarningMessage(
        `You already have agents. Add the "${pick.teamLabel}" team anyway?`,
        'Add',
        'Cancel'
      );
      if (choice !== 'Add') { return []; }
    }
    return createPickedTeam(d, pick);
  }

  if (currentCount > 0) {
    const choice = await vscode.window.showWarningMessage(
      `This replaces your current ${currentCount} agent(s) with "${action.preset.teamLabel}". Continue?`,
      { modal: true },
      'Continue',
      'Cancel'
    );
    if (choice !== 'Continue') { return []; }
    if (d.beforeReplaceRoster && !(await d.beforeReplaceRoster())) { return []; }
    for (const session of [...d.sessionManager.getAll()]) {
      await d.sessionManager.remove(session.id);
    }
  }
  return createPickedTeam(d, action.preset);
}
/**
 * Solo / Fast mode (v0.3.0): create the single generalist "Solo" agent on Roam. One agent that does
 * the whole task itself (no delegation, no review gate) — the fast path for simple/everyday work.
 * Returns the existing solo agent if there already is one (idempotent).
 */
/**
 * Pick the folder a Solo agent will read/write/run inside (G-003c). Defaults to the open workspace
 * folder(s) but lets the user choose any folder on disk — so you can point the agent at a project
 * without having to open it as the VS Code workspace. Returns undefined if the user cancels.
 */
export async function resolveSoloWorkingDirectory(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const CHOOSE = 'choose';
  const items: (vscode.QuickPickItem & { value: string })[] = folders.map((f) => ({
    label: `$(folder) ${f.name}`,
    description: f.uri.fsPath,
    value: f.uri.fsPath,
  }));
  items.push({
    label: '$(folder-opened) Choose another folder…',
    description: 'Pick any folder on disk for this agent to work in',
    value: CHOOSE,
  });

  let chosen: string;
  if (folders.length === 0) {
    chosen = CHOOSE; // no workspace open → go straight to the folder picker
  } else {
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Solo agent — working folder',
      placeHolder: 'Where should this agent read, write, and run commands?',
    });
    if (!pick) { return undefined; }
    chosen = pick.value;
  }

  if (chosen === CHOOSE) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Choose the Solo agent's working folder",
      openLabel: 'Work here',
      defaultUri: folders[0]?.uri,
    });
    if (!picked || picked.length === 0) { return undefined; }
    return picked[0].fsPath;
  }
  return chosen;
}

export async function createSoloAgent(d: DialogDeps): Promise<AgentConfig | undefined> {
  const existing = d.sessionManager.getAll().find((s) => s.config.role === 'solo');
  if (existing) { return existing.config; }

  // No working dir is pinned: the runtime resolves the root per session (the agent works in the open
  // workspace, or its worktree). If a task references a file outside that root, the out-of-root handler in
  // extension.ts asks the user (in context) to switch.
  const template = ROLE_TEMPLATES['solo'];
  const providerKey = await chooseConnectionForNewAgent(d, 'UnodeAi Solo — Connection / Pay through');
  const selection = selectedConnection(d, providerKey);
  // Custom gateways have no built-in catalog, so initialModelForConnection would pin the solo template's
  // fixed id and 404. Ask for a model (same picker the Add-Agent flow uses); abort on cancel. Built-in
  // gateways keep their tier-resolved model with no extra prompt.
  let soloModel = initialModelForConnection(template, providerKey, selection);
  let soloPickedModel: PickedModel | undefined;
  if (isDynamicCustomConnection(selection.connectionId)) {
    const apiKey = selection.provider.apiKeySecretName ? await d.secrets.get(selection.provider.apiKeySecretName) : undefined;
    const picked = await pickModel(d, providerKey, '', selection.profile.presentation.endpointDefault, apiKey);
    if (!picked) { return undefined; }
    soloModel = picked.id;
    soloPickedModel = picked;
  }
  const config = new AgentConfigBuilder(template.role)
    .fromTemplate('solo')
    .setName(uniqueAgentName(d, template.name))
    .setIcon(distinctAgentIcon(template.icon, rosterIcons(d)))
    .setProviderRef(selection.provider)
    .setModel(soloModel)
    .setAutoApprove(false)
    .build();
  if (soloPickedModel) { applyPickedContextWindow(config, soloPickedModel, config.name); }
  applySelectedConnection(config, selection, d);
  const removed = adaptGeneratedConfigToConnection(d, config);
  const rejected = assertCreatableConfig(d, config);
  if (rejected) {
    await vscode.window.showWarningMessage(rejected);
    return undefined;
  }
  d.sessionManager.create(config);
  d.output.info(`Solo agent created: ${config.name} (model ${config.model}).`);
  if (removed.length > 0) {
    void vscode.window.showInformationMessage(
      `${config.name} uses a read-only connection. ${removed.join(', ')} will not be available.`
    );
  }

  const secretName = apiKeySecretNameForProvider(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
  if (secretName && !(await d.secrets.has(secretName))) {
    const choice = await vscode.window.showInformationMessage(
      'Solo agent created. Set your provider API key to start working.', 'Set API Key'
    );
    if (choice === 'Set API Key') {
      await promptAndStoreProviderKey(d, secretName);
    }
  }
  return config;
}

export async function showAddAgentDialog(d: DialogDeps): Promise<AgentConfig | undefined> {
  const roleKeys = Object.keys(ROLE_TEMPLATES) as (keyof typeof ROLE_TEMPLATES)[];

  const rolePick = await vscode.window.showQuickPick(
    roleKeys.map((key) => ({
      label: `${ROLE_TEMPLATES[key].icon ?? '🤖'} ${ROLE_TEMPLATES[key].name}`,
      description: ROLE_TEMPLATES[key].description ?? '',
      detail: `Skills: ${ROLE_TEMPLATES[key].skills.map((s) => s.name).join(', ')}`,
      roleKey: key,
    })),
    { placeHolder: 'Select agent role', title: 'Add UnodeAi Agent — Choose Role' }
  );
  if (!rolePick) { return undefined; }

  // The configured default connection sorts first. All labels/billing/privacy facts come from the registry.
  const providerKey = await chooseConnectionForNewAgent(d, 'UnodeAi — Connection / Pay through');
  const selection = selectedConnection(d, providerKey);

  const template = ROLE_TEMPLATES[rolePick.roleKey];

  const nameInput = await vscode.window.showInputBox({
    title: 'UnodeAi — Agent Name',
    prompt: 'Name for this agent (shown in the team panel and message log).',
    value: uniqueAgentName(d, template.name),
    ignoreFocusOut: true,
  });
  if (nameInput === undefined) { return undefined; }
  const agentName = uniqueAgentName(d, nameInput.trim() || template.name);

  // No setWorkingDirectory: the runtime resolves the root per session (SessionInfo.runtimeWorkingDirectory).
  const builder = new AgentConfigBuilder(template.role)
    .fromTemplate(rolePick.roleKey)
    .setName(agentName)
    .setProviderRef(selection.provider)
    .setAutoApprove(false);

  // Provider-aware in every case: for 'anthropic' this resolves the role's tier to the CURRENT Claude model
  // (e.g. claude-sonnet-5) rather than leaving the template's stale hardcoded `model`.
  builder.setModel(initialModelForConnection(template, providerKey, selection));

  const config = builder.build();
  applySelectedConnection(config, selection, d);
  const removed = adaptGeneratedConfigToConnection(d, config);
  const rejected = assertCreatableConfig(d, config);
  if (rejected) {
    await vscode.window.showWarningMessage(rejected);
    return undefined;
  }

  if (config.backend === 'openai-compat') {
    if (template.modelRationale) {
      d.output.info(`Recommended model for ${template.role}: ${config.model} — ${template.modelRationale}`);
    }
    const apiKey = config.provider.apiKeySecretName ? await d.secrets.get(config.provider.apiKeySecretName) : undefined;
    const model = await pickModel(d, providerKey, config.model, selection.profile.presentation.endpointDefault, apiKey);
    if (!model) { return undefined; }
    config.model = model.id;
    applyPickedContextWindow(config, model, selection.profile.presentation.displayName);
  } else {
    const models = selection.profile.catalogModels;
    const modelPick = await vscode.window.showQuickPick(
      models.map((model) => ({ label: model.id, description: model.name })),
      {
        title: `UnodeAi — Model available on ${selection.profile.presentation.displayName}`,
        placeHolder: `${selection.profile.presentation.runtimeLabel} · ${selection.profile.presentation.billingLabel}`,
      }
    );
    if (!modelPick) { return undefined; }
    config.model = modelPick.label;
  }
  config.route = routeForConnectionId(selection.connectionId, config.model, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);

  d.sessionManager.create(config);
  d.output.info(`Agent added: ${config.name} (${config.role})`);
  if (removed.length > 0) {
    void vscode.window.showInformationMessage(
      `${config.name} uses a read-only connection. ${removed.join(', ')} will not be available.`
    );
  }

  const secretName = apiKeySecretNameForProvider(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
  if (secretName && !(await d.secrets.has(secretName))) {
    const choice = await vscode.window.showInformationMessage(
      `Agent "${config.name}" added. No API key stored for ${secretName}.`,
      'Set API Key'
    );
    if (choice === 'Set API Key') {
      await promptAndStoreProviderKey(d, secretName);
    }
  } else {
    vscode.window.showInformationMessage(`Agent "${config.name}" added to your team`);
  }
  return config;
}

/**
 * Edit an existing agent in place (P2#14) — previously you had to delete & re-create. Lets the user
 * rename, change the model (takes effect next turn for in-process agents), or set a fallback model.
 */
export async function showEditAgentDialog(d: DialogDeps, agentId: string): Promise<void> {
  const info = d.sessionManager.get(agentId);
  if (!info) {
    vscode.window.showWarningMessage('Agent not found.');
    return;
  }
  const cfg = info.config;

  const field = await vscode.window.showQuickPick(
    [
      { label: '✏ Rename', detail: `Current: ${cfg.name}`, key: 'name' },
      { label: '🤖 Change model', detail: `Current: ${cfg.model}`, key: 'model' },
      { label: '↪ Set fallback model', detail: cfg.fallbackModel ? `Current: ${cfg.fallbackModel}` : 'none', key: 'fallback' },
      { label: '🔧 Tool calling', detail: `Current: ${cfg.toolProtocol ?? 'native'} (OpenAI-compatible agents)`, key: 'toolProtocol' },
    ],
    { title: `Edit ${cfg.name}`, placeHolder: 'What do you want to change?' }
  );
  if (!field) { return; }

  if (field.key === 'name') {
    const name = await vscode.window.showInputBox({
      title: 'UnodeAi — Rename Agent', value: cfg.name, ignoreFocusOut: true,
    });
    if (name === undefined) { return; }
    cfg.name = uniqueAgentName(d, name.trim() || cfg.name);
  } else if (field.key === 'toolProtocol') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Native function calling', detail: 'Default — best for strong models (Claude, GPT, …).', value: 'native' as const },
        { label: 'XML tool calling', detail: 'For weaker models (e.g. DeepSeek) that misuse native calls — Cline-style.', value: 'xml' as const },
      ],
      { title: 'Tool calling protocol', placeHolder: 'How should this OpenAI-compatible agent call tools?' }
    );
    if (!pick) { return; }
    cfg.toolProtocol = pick.value;
  } else {
    // Resolve provider key for the model picker; fall back to the agent's provider id.
    const providerKey = cfg.provider.providerId;
    const connectionId = cfg.route?.connectionId ?? connectionIdForProviderId(providerKey, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY);
    const profile = connectionId ? connectionProfile(connectionId, d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY) : undefined;
    const apiKey = cfg.provider.apiKeySecretName ? await d.secrets.get(cfg.provider.apiKeySecretName) : undefined;
    const picked = await pickModel(d, providerKey, cfg.model, profile?.presentation.endpointDefault, apiKey);
    if (!picked) { return; }
    if (field.key === 'model') {
      // setModel updates the live config so the change applies on the next turn (in-process).
      if (!d.sessionManager.setModel(agentId, picked.id)) { cfg.model = picked.id; }
      applyPickedContextWindow(cfg, picked, profile?.presentation.displayName ?? providerKey);
    } else {
      cfg.fallbackModel = picked.id;
    }
  }

  d.onRosterChanged?.();
  d.output.info(`Edited agent ${cfg.name} (${field.key}).`);
  vscode.window.showInformationMessage(`Updated ${cfg.name}.`);
}

export async function showSendMessageDialog(
  d: DialogDeps,
  targets: AgentConfig[],
  request?: unknown
): Promise<Message | undefined> {
  const direct = parseDirectSendRequest(request, targets);
  if (direct) {
    const message = d.messageBus.send(
      'user',
      direct.targetId,
      'task.assign',
      { instruction: direct.instruction, files: direct.files },
      'normal'
    );
    d.output.info(`Message sent to ${direct.targetId}: ${direct.instruction.slice(0, 80)}`);
    return message;
  }

  const targetPick = await vscode.window.showQuickPick(
    [
      { label: 'Broadcast to All', description: 'Send to every agent', targetId: '*' },
      ...targets.map((a) => ({ label: a.name, description: a.role, detail: `Model: ${a.model}`, targetId: a.id })),
    ],
    { placeHolder: 'Select target agent', title: 'Send Message to Agent' }
  );
  if (!targetPick) { return undefined; }

  const message = await vscode.window.showInputBox({
    prompt: 'Enter your task instruction',
    placeHolder: 'e.g., Implement the authentication middleware for Express',
  });
  if (!message) { return undefined; }

  const files = vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri.fsPath] : [];
  const sent = d.messageBus.send('user', targetPick.targetId, 'task.assign', { instruction: message, files }, 'normal');
  d.output.info(`Message sent to ${targetPick.targetId}: ${message.slice(0, 80)}`);
  return sent;
}

function parseDirectSendRequest(
  request: unknown,
  targets: AgentConfig[]
): { targetId: string | '*'; instruction: string; files: string[] } | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const raw = request as { targetId?: unknown; instruction?: unknown; files?: unknown };
  if (typeof raw.targetId !== 'string' || typeof raw.instruction !== 'string' || !raw.instruction.trim()) {
    return undefined;
  }
  const targetIds = new Set(['*', ...targets.map((a) => a.id)]);
  if (!targetIds.has(raw.targetId)) {
    return undefined;
  }
  const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [];
  return { targetId: raw.targetId, instruction: raw.instruction, files };
}

export async function showRunWorkflowDialog(d: DialogDeps): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    d.workflowEngine.getWorkflowTemplates().map((w) => ({
      label: w.name,
      description: w.description,
      detail: `${w.steps.length} steps`,
      id: w.id,
    })),
    { placeHolder: 'Select workflow to run' }
  );
  if (!pick) { return; }

  const seed = await vscode.window.showInputBox({
    prompt: 'Describe the task to seed this workflow',
    placeHolder: 'e.g., Add rate limiting to the public API',
  });
  if (seed === undefined) { return; }

  await d.workflowEngine.run(pick.id, { request: seed });
  d.output.info(`Workflow "${pick.label}" started`);
  vscode.window.showInformationMessage(`Workflow "${pick.label}" is running`);
}

type SecretPick = vscode.QuickPickItem & { custom?: boolean; secretName?: string };

function connectionIdForSecret(d: DialogDeps, secretName: string): string | undefined {
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  return resolver.profiles.find((profile) => profile.apiKeySecretName === secretName)?.id;
}

/** Prompt for a built-in provider key, then cross the one user-initiated storage boundary. */
export async function promptAndStoreProviderKey(d: DialogDeps, secretName: string): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: `UnodeAi – Set ${secretName}`,
    prompt: `Paste the value for ${secretName}. Stored encrypted in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? undefined : 'Paste a non-empty value, or press Esc to cancel.',
  });
  if (!value || !value.trim()) {
    return false;
  }
  await d.storeUserInitiatedProviderKey(secretName, value.trim(), connectionIdForSecret(d, secretName));
  return true;
}

export async function showSetApiKeyDialog(d: DialogDeps): Promise<void> {
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  // Same order as every other connection picker. This list was the one surface W7 missed, so a user
  // who was told "Unode first, Roam second" everywhere else met the opposite here, in the dialog that
  // decides which account they are about to pay for.
  const secretNames = stableProviderSort(
    resolver.profiles.filter((profile) => profile.authKind === 'api-key' && !isDynamicCustomConnection(profile.id)),
    (profile) => profile.id,
  ).flatMap((profile) => profile.apiKeySecretName ? [profile.apiKeySecretName] : []);
  // QuickPickItem objects with an explicit `custom` flag — more robust than comparing the returned
  // label against an emoji string constant (that equality silently failed for some users, skipping the
  // name step and dropping them straight into the value box).
  const items: SecretPick[] = [
    ...secretNames.map((n) => ({ label: n, secretName: n })),
    { label: '➕ Custom secret name…', detail: 'e.g. GITHUB_TOKEN for an MCP server', custom: true },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Which key/secret do you want to set?',
    title: 'UnodeAi — Set Provider API Key',
  });
  if (!pick) { return; }

  // Custom path: store an arbitrary-named secret (e.g. GITHUB_TOKEN), not just the built-in provider
  // keys. Resolved by name from SecretStorage (incl. MCP ${VAR}).
  let secretName: string;
  if (pick.custom) {
    const name = await vscode.window.showInputBox({
      title: 'UnodeAi — Set Provider API Key (Step 1 of 2: secret NAME)',
      prompt: 'Name to store the secret under (e.g. GITHUB_TOKEN). Referenced as ${NAME} by MCP servers.',
      placeHolder: 'GITHUB_TOKEN',
      ignoreFocusOut: true,
      validateInput: (v) => (/^\w+$/.test(v.trim()) ? undefined : 'Use letters, digits, and underscores only.'),
    });
    if (!name) { return; }
    secretName = name.trim();
    // The name box and the value box open back-to-back; a short gap lets the Enter that confirmed the
    // name fully dismiss the first box so it doesn't "bleed" through and auto-accept the value box.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } else {
    secretName = pick.secretName!;
  }

  // A stored key could only be removed by the workspace reset, which also deletes the team file and
  // reloads the window — so "take my key off this machine" cost a user their roster. Custom gateways
  // already had keep/replace/clear; built-in providers now offer the same choice, and only when there is
  // something to clear, so the common path stays one step.
  if (await d.secrets.has(secretName)) {
    const REPLACE = 'Replace the stored value';
    const CLEAR = 'Clear the stored value';
    const action = await vscode.window.showQuickPick([REPLACE, CLEAR], {
      title: `UnodeAi — ${secretName} is already set`,
      placeHolder: 'This secret already has a value on this machine',
    });
    if (!action) { return; }
    if (action === CLEAR) {
      await d.secrets.delete(secretName);
      vscode.window.showInformationMessage(`${secretName} removed from this machine. Agents on that connection will ask for it again.`);
      return;
    }
  }

  const value = await vscode.window.showInputBox({
    title: `UnodeAi — Set Provider API Key (Step 2 of 2: value for ${secretName})`,
    prompt: `Paste the value for ${secretName}. Stored encrypted in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Paste a non-empty value, or press Esc to cancel.'),
  });
  if (!value || !value.trim()) { return; }
  const connectionId = connectionIdForSecret(d, secretName);
  await d.storeUserInitiatedProviderKey(
    secretName,
    value.trim(),
    connectionId,
  );
  vscode.window.showInformationMessage(connectionId
    ? `Stored ${secretName} in SecretStorage. Prices and the model list were refreshed for this connection.`
    : `Stored ${secretName} in SecretStorage.`);
}

/**
 * Ask for the coefficient the gateway will not tell us.
 *
 * A gateway's pricing endpoint publishes what a model costs. What the holder of a particular key is charged
 * is a coefficient settled internally, and it is frequently not reported at all — so UnodeAi shows list
 * price and is wrong for anyone on a discount. Field report, 2026-08-21: a key swapped into another price
 * group changed the model range immediately and the prices not at all, because there was no number to
 * change them by.
 *
 * Asked here because this is the one moment the user is holding the fact. A setting nobody is prompted for
 * is a setting nobody knows exists, and the cost display would stay quietly wrong.
 *
 * **Every key ends up with a stated value.** Dismissing the prompt stores 1 rather than leaving the setting
 * absent: "this key pays list price" is a fact, "nobody has said" is not, and only one of the two can be
 * read back later. Most keys really are at list price, so the default costs nothing to accept.
 */
/**
 * The one rule for what a typed price coefficient means.
 *
 * It is exported and shared because the box had two copies of it — `validateInput` decided what to accept
 * and the line after the await decided what to store — and they disagreed. Both called
 * `Number(input.trim())`, and `Number('')` is `0`, so clearing the pre-filled `1` and pressing Enter passed
 * validation and stored "this key is free". Every model then displayed a cost of zero. Codex review,
 * 2026-08-21.
 *
 * Blank explicitly means list price. This preserves the blank initial value that prevents an Enter
 * bleed-through from the preceding key prompt, while `0` remains the explicit way to say the key is free.
 */
export type PriceCoefficientInput =
  | { ok: true; value: number }
  | { ok: false; reason: string };

export function parsePriceCoefficient(input: string): PriceCoefficientInput {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: true, value: 1 };
  }
  const n = Number(trimmed);
  // 0 is legitimate: a free or internally-settled key costs nothing, and refusing it would force the
  // user to state a price they do not pay.
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, reason: 'Enter 0 or a positive number, e.g. 1, 0.33, or 0.' };
  }
  if (n > 1) {
    return { ok: false, reason: 'A coefficient above 1 would charge more than list price. Check the number.' };
  }
  return { ok: true, value: n };
}

export async function promptForKeyPriceMultiplier(
  d: DialogDeps,
  secretName: string | undefined,
  connectionId?: string,
): Promise<void> {
  const resolver = d.connectionResolver ?? BUILTIN_CONNECTION_REGISTRY;
  const owner = connectionId
    ? resolver.profiles.find((profile) => profile.id === connectionId)
    : resolver.profiles.find((profile) => profile.apiKeySecretName === secretName);
  const ownerId = connectionId ?? owner?.id;
  if (!ownerId) { return; }

  const raw = await vscode.window.showInputBox({
    // Intentionally no `value`: this box opens blank to avoid Enter bleed-through from the key prompt.
    title: `Price coefficient for this ${ownerId} key`,
    prompt: 'What fraction of the published price does this key pay? 1 = list price. '
      + 'Leave this blank or press Esc for 1 if you do not know — the gateway does not report this, so UnodeAi cannot check it.',
    ignoreFocusOut: true,
    validateInput: (input) => {
      const parsed = parsePriceCoefficient(input);
      return parsed.ok ? undefined : parsed.reason;
    },
  });

  // Dismissal and a submitted blank both parse as list price. Anything the box could not have accepted
  // still lands on 1: an unparseable value must never become a cheaper one, because too-cheap is the
  // direction nobody notices.
  const parsed = parsePriceCoefficient(raw ?? '');
  const multiplier = parsed.ok ? parsed.value : 1;
  const cfg = vscode.workspace.getConfiguration('unode');
  const current = cfg.get<unknown>('priceMultiplier');
  // Always store the map form: a coefficient belongs to the key, and writing a bare number here would
  // silently reprice every other connection the user has.
  const next: Record<string, number> = typeof current === 'object' && current
    ? { ...(current as Record<string, number>) }
    : {};
  next[ownerId] = multiplier;
  await cfg.update('priceMultiplier', next, vscode.ConfigurationTarget.Global);
}
