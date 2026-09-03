/* Central connection registry. This is the source of truth for backend/auth/billing/capability identity. */

import { customGatewayDisplayNameKey } from '../connections/CustomGatewayProfile';
import type { CustomGatewayRegistrySnapshot } from '../connections/CustomGatewayProfile';
import { LEGACY_CUSTOM_PROVIDER_ID } from '../connections/LegacyCustomGatewayMigration';
import type { AgentBackendKind, AgentConfig, ProviderRef } from '../types';
import {
  AGENT_ROUTE_VERSION,
  AgentRoute,
  canonicalEndpointBase,
  ConnectionPresentation,
  ConnectionModel,
  ConnectionProfile,
  ConnectionSetupGroup,
  RuntimeCapabilities,
  assertAgentRoute,
  assertRuntimeCapabilities,
} from './RouteContracts';

const OPENAI_COMPAT_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  plan: true, act: true, read: true, write: true, command: true, commandApproval: 'unode-mediated',
  delegation: true, coordinator: true, mcp: true, skills: true, folderAccess: true, toolProtocol: true, smartMode: true, worktrees: true, verification: true,
  stop: true, steer: true, resume: true,
  modelParams: new Set(['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'thinking', 'reasoning_effort', 'max_tokens', 'stop', 'response_format', 'tool_choice', 'stream']),
});

const CLAUDE_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  plan: true, act: true, read: true, write: true, command: true, commandApproval: 'unode-mediated',
  delegation: true, coordinator: true, mcp: true, skills: true, folderAccess: true, toolProtocol: false, smartMode: false, worktrees: true, verification: true,
  stop: true, steer: true, resume: true,
  modelParams: new Set(['reasoning_effort']),
});

/** E0 records Track A truthfully. E5 changes only proven values with E4 probe references. */
const CODEX_TRACK_A_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  plan: true, act: false, read: true, write: false, command: false, commandApproval: 'runtime-sandbox',
  delegation: false, coordinator: false, mcp: false, skills: false, folderAccess: false, toolProtocol: false, smartMode: false, worktrees: false, verification: true,
  stop: true, steer: false, resume: true,
  modelParams: new Set(['reasoning_effort']),
});

function profile(profile: ConnectionProfile): ConnectionProfile {
  assertRuntimeCapabilities(profile.capabilities);
  if (profile.authKind !== 'api-key' && profile.apiKeySecretName) {
    throw new Error(`CLI-authenticated connection ${profile.id} must not declare an API key.`);
  }
  return Object.freeze(profile);
}

function gatewayPresentation(
  displayName: string,
  billingLabel: string,
  endpointDefault?: string,
  links?: Pick<ConnectionPresentation, 'signupUrl' | 'pricingUrl' | 'balanceAvailable'>,
): ConnectionPresentation {
  return {
    displayName,
    runtimeLabel: 'OpenAI-compatible',
    billingLabel,
    endpointDefault,
    privacySummary: 'Prompts and any included workspace content go to this connection endpoint. The model processor depends on the model selected there.',
    ...links,
    setup: { kind: 'api-key', actionLabel: 'Set API key' },
  };
}

function cliPresentation(args: {
  displayName: string;
  runtimeLabel: string;
  billingLabel: string;
  installCommand: string;
  loginCommand: string;
  terminalName: string;
  requiredSetting?: string;
  privacySummary: string;
}): ConnectionPresentation {
  return {
    displayName: args.displayName,
    runtimeLabel: args.runtimeLabel,
    billingLabel: args.billingLabel,
    privacySummary: args.privacySummary,
    setup: {
      kind: 'cli',
      actionLabel: `Set up ${args.runtimeLabel}`,
      installCommand: args.installCommand,
      loginCommand: args.loginCommand,
      terminalName: args.terminalName,
      requiredSetting: args.requiredSetting,
    },
  };
}

const ROAM_GATEWAY_MODELS: readonly ConnectionModel[] = Object.freeze([
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (cheap)' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'qwen-max', name: 'Qwen Max' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (premium)', vision: true },
  { id: 'gpt-4o', name: 'GPT-4o', vision: true },
]);
const OPENAI_MODELS: readonly ConnectionModel[] = Object.freeze([
  { id: 'gpt-4o', name: 'GPT-4o', vision: true },
  { id: 'gpt-4.1', name: 'GPT-4.1', vision: true },
]);
const OPENROUTER_MODELS: readonly ConnectionModel[] = Object.freeze([
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', vision: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', vision: true },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', vision: true },
  { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
]);
/**
 * Claude Headless runs the user's CLI, and the CLI has no model-list command to ask: as of 2.1.209
 * there is no `claude models`, and an unknown `--model` prints "it may not exist" and still exits 0,
 * so an id can be neither discovered nor validated from here.  A pinned list therefore cannot be kept
 * current by probing, and every release it is not edited it is wrong — which is how `claude-opus-5`
 * came to be missing from the picker while typing it by hand worked fine.
 *
 * So this list is no longer the authority, and mostly not even a list of ids.  Three things stand
 * between it and the user, in priority order (see ModelCatalog): the `unode.extraModels` setting, a
 * hosted catalog at `unode.modelCatalogUrl`, then this.  And the entries below lead with the CLI's own
 * always-latest ALIASES, which are documented in `claude --help` (fable/opus/sonnet; haiku is accepted
 * too — probed against 2.1.209).  An alias is resolved by the CLI at spawn time, so it needs no
 * release, no network, and no host anyone has to trust in order to name the newest model.
 *
 * The pinned ids stay for the case the aliases cannot serve: a run someone needs to reproduce later.
 */
const CLAUDE_MODELS: readonly ConnectionModel[] = Object.freeze([
  { id: 'opus', name: 'Opus — always the latest', vision: true },
  { id: 'sonnet', name: 'Sonnet — always the latest', vision: true },
  { id: 'haiku', name: 'Haiku — always the latest', vision: true },
  { id: 'fable', name: 'Fable — always the latest', vision: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5 (pinned)', vision: true },
  { id: 'claude-fable-5', name: 'Claude Fable 5 (pinned)', vision: true },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 (pinned)', vision: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (pinned)', vision: true },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (pinned)', vision: true },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7 (pinned)', vision: true },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (pinned)', vision: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (pinned)', vision: true },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (pinned)', vision: true },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (pinned)', vision: true },
]);
const CODEX_MODELS: readonly ConnectionModel[] = Object.freeze([
  { id: 'gpt-5-codex', name: 'Codex CLI default (recommended)', vision: true },
]);

export const CONNECTION_PROFILES: readonly ConnectionProfile[] = Object.freeze([
  profile({ id: 'unode', revision: 1, kind: 'openai-compatible', availability: 'available', backendKind: 'openai-compat', billingKind: 'gateway-balance', authKind: 'api-key', catalogKind: 'openai-models', catalogModels: ROAM_GATEWAY_MODELS, capabilities: OPENAI_COMPAT_CAPABILITIES, apiKeySecretName: 'UNODE_API_KEY', presentation: gatewayPresentation('Unode', 'Your Unode connection', 'https://www.unodetech.xyz/v1', { signupUrl: 'https://www.unodetech.xyz/login', pricingUrl: 'https://www.unodetech.xyz/pricing', balanceAvailable: true }) }),
  profile({ id: 'roam', revision: 1, kind: 'openai-compatible', availability: 'available', backendKind: 'openai-compat', billingKind: 'gateway-balance', authKind: 'api-key', catalogKind: 'openai-models', catalogModels: ROAM_GATEWAY_MODELS, capabilities: OPENAI_COMPAT_CAPABILITIES, apiKeySecretName: 'ROAM_API_KEY', presentation: gatewayPresentation('Roam', 'Your Roam connection', 'https://ai.weroam.xyz/v1', { signupUrl: 'https://ai.weroam.xyz/login?lang=en', pricingUrl: 'https://ai.weroam.xyz/pricing', balanceAvailable: true }) }),
  profile({ id: 'openrouter', revision: 1, kind: 'openai-compatible', availability: 'available', backendKind: 'openai-compat', billingKind: 'gateway-balance', authKind: 'api-key', catalogKind: 'openai-models', catalogModels: OPENROUTER_MODELS, capabilities: OPENAI_COMPAT_CAPABILITIES, apiKeySecretName: 'OPENROUTER_API_KEY', presentation: gatewayPresentation('OpenRouter', 'Your OpenRouter connection', 'https://openrouter.ai/api/v1', { signupUrl: 'https://openrouter.ai/keys', pricingUrl: 'https://openrouter.ai/models' }) }),
  profile({ id: 'openai', revision: 1, kind: 'openai-compatible', availability: 'available', backendKind: 'openai-compat', billingKind: 'api-account', authKind: 'api-key', catalogKind: 'openai-models', catalogModels: OPENAI_MODELS, capabilities: OPENAI_COMPAT_CAPABILITIES, apiKeySecretName: 'OPENAI_API_KEY', presentation: gatewayPresentation('OpenAI API', 'Your OpenAI API account', 'https://api.openai.com/v1', { signupUrl: 'https://platform.openai.com/api-keys', pricingUrl: 'https://openai.com/api/pricing/' }) }),
  profile({ id: 'claude-cli', revision: 1, kind: 'claude-headless', availability: 'available', backendKind: 'claude', billingKind: 'cli-account', authKind: 'claude-cli', catalogKind: 'claude-cli', catalogModels: CLAUDE_MODELS, capabilities: CLAUDE_CAPABILITIES, presentation: cliPresentation({ displayName: 'Claude Headless', runtimeLabel: 'Claude Headless', billingLabel: 'Your Claude account (as configured in the CLI)', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude login', terminalName: 'UnodeAi — Claude CLI', privacySummary: 'Prompts and any included workspace content are sent through your logged-in Claude CLI.' }) }),
  // Retain the known route for lossless migration, but do not offer or start it in v0.9.30.
  profile({ id: 'codex-cli', revision: 1, kind: 'codex-headless', availability: 'coming-soon', availabilityMessage: 'Codex Headless is coming soon and is not available in this release.', backendKind: 'codex', billingKind: 'cli-account', authKind: 'codex-cli', catalogKind: 'codex-cli', catalogModels: CODEX_MODELS, capabilities: CODEX_TRACK_A_CAPABILITIES, presentation: cliPresentation({ displayName: 'Codex Headless', runtimeLabel: 'Codex Headless', billingLabel: 'Your OpenAI account (as configured in the CLI)', installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login', terminalName: 'UnodeAi — Codex CLI', requiredSetting: 'unode.codexCliPath', privacySummary: 'Codex Headless is not available in this release.' }) }),
]);

/**
 * The three user-visible setup doors.  Individual connections, credentials, and runtime facts stay
 * on CONNECTION_PROFILES; this only supplies the category labels shared by their peer doors.
 */
export const CONNECTION_SETUP_GROUPS: readonly ConnectionSetupGroup[] = Object.freeze([
  { kind: 'openai-compatible', displayName: 'OpenAI-compatible connection', description: 'Use a gateway or API connection and select a model available on it.' },
  { kind: 'claude-headless', displayName: 'Claude Headless', description: 'Use your logged-in Claude CLI subscription.' },
  { kind: 'codex-headless', displayName: 'Codex Headless', description: 'This connection is planned but not available in this release.' },
]);

for (const group of CONNECTION_SETUP_GROUPS) {
  if (!CONNECTION_PROFILES.some((profile) => profile.kind === group.kind)) {
    throw new Error(`Setup group ${group.kind} has no registered connection.`);
  }
}

const LEGACY_PROVIDER_TO_CONNECTION: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'claude-cli',
  codex: 'codex-cli',
});
const CONNECTION_TO_LEGACY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  'claude-cli': 'anthropic',
  'codex-cli': 'codex',
});

/**
 * A revisioned, host-owned view of every runnable connection. Pure consumers receive this object
 * explicitly so a workspace document cannot smuggle a second custom-profile authority into route
 * validation, endpoint resolution, or credential ownership.
 */
export interface ConnectionResolver {
  readonly revision: number;
  readonly profiles: readonly ConnectionProfile[];
  connectionProfile(connectionId: string): ConnectionProfile | undefined;
  connectionIdForProviderId(providerId: string): string | undefined;
  legacyProviderIdForConnectionId(connectionId: string): string | undefined;
}

/**
 * Runtime identity captured when a backend is constructed. A custom profile's display name is
 * deliberately absent: rename is presentation-only, while endpoint/key/lifecycle changes must
 * stop a stale backend before its next model-content request.
 */
export interface ActiveConnectionProfile {
  connectionId: string;
  revision: number;
  endpointBase?: string;
  apiKeySecretName?: string;
}

/** Built-ins plus one validated C1 store snapshot. Construct a new instance after a store reload. */
export class EffectiveConnectionRegistry implements ConnectionResolver {
  readonly revision: number;
  readonly profiles: readonly ConnectionProfile[];
  private readonly profilesById: ReadonlyMap<string, ConnectionProfile>;

  constructor(customSnapshot?: Pick<CustomGatewayRegistrySnapshot, 'registryRevision' | 'profiles'>) {
    const customProfiles = (customSnapshot?.profiles ?? []).map((item) => profile({
      id: item.connectionId,
      revision: item.revision,
      kind: 'openai-compatible',
      availability: 'available',
      backendKind: 'openai-compat',
      billingKind: 'custom-account',
      authKind: 'api-key',
      catalogKind: 'openai-models',
      catalogModels: Object.freeze([]),
      capabilities: OPENAI_COMPAT_CAPABILITIES,
      ...(item.secretRef === undefined ? {} : { apiKeySecretName: item.secretRef }),
      presentation: gatewayPresentation(
        item.displayName,
        'This user-configured connection',
        item.endpointBase,
      ),
    }));
    this.profiles = Object.freeze([...CONNECTION_PROFILES, ...customProfiles]);
    this.profilesById = new Map(this.profiles.map((item) => [item.id, item]));
    if (this.profilesById.size !== this.profiles.length) {
      throw new Error('Effective connection registry contains duplicate connection ids.');
    }
    const displayNames = new Set<string>();
    for (const item of this.profiles) {
      const displayName = customGatewayDisplayNameKey(item.presentation.displayName);
      if (displayNames.has(displayName)) {
        throw new Error(`Effective connection registry contains duplicate display name "${item.presentation.displayName}".`);
      }
      displayNames.add(displayName);
    }
    this.revision = customSnapshot?.registryRevision ?? 0;
  }

  connectionProfile(connectionId: string): ConnectionProfile | undefined {
    return this.profilesById.get(connectionId);
  }

  connectionIdForProviderId(providerId: string): string | undefined {
    const trimmed = providerId.trim();
    // Opaque custom ids are exact identities. Never case-fold or otherwise normalize them.
    if (this.profilesById.has(trimmed)) {
      return trimmed;
    }
    const normalized = trimmed.toLowerCase();
    return this.profilesById.has(normalized) ? normalized : LEGACY_PROVIDER_TO_CONNECTION[normalized];
  }

  legacyProviderIdForConnectionId(connectionId: string): string | undefined {
    if (!this.profilesById.has(connectionId)) {
      return undefined;
    }
    return CONNECTION_TO_LEGACY_PROVIDER[connectionId] ?? connectionId;
  }
}

/** Built-in fallback for legacy call sites. C2 consumers receive a current EffectiveConnectionRegistry. */
export const BUILTIN_CONNECTION_REGISTRY: ConnectionResolver = new EffectiveConnectionRegistry();

export function connectionProfile(
  connectionId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): ConnectionProfile | undefined {
  return resolver.connectionProfile(connectionId);
}

export function connectionIdForProviderId(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string | undefined {
  return resolver.connectionIdForProviderId(providerId);
}

/**
 * The sole presentation boundary for legacy provider ids. A provider id remains the opaque
 * action/route identity, but people should see the registry-owned connection name whenever one
 * is available. Tombstoned or otherwise unknown ids intentionally fall back to themselves so
 * they remain actionable in repair and support flows.
 */
export function displayNameForProviderId(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string {
  const connectionId = resolver.connectionIdForProviderId(providerId);
  return connectionId
    ? resolver.connectionProfile(connectionId)?.presentation.displayName ?? providerId
    : providerId;
}

/** Compatibility-only adapter for existing AgentConfig/provider based call sites. */
export function legacyProviderIdForConnectionId(
  connectionId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string | undefined {
  return resolver.legacyProviderIdForConnectionId(connectionId);
}

export function isSupportedProviderOrConnectionId(
  id: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): boolean {
  return connectionIdForProviderId(id, resolver) !== undefined;
}

export function defaultBackendForProviderId(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentBackendKind | undefined {
  const id = connectionIdForProviderId(providerId, resolver);
  return id ? resolver.connectionProfile(id)?.backendKind : undefined;
}

/** Compatibility projection for old AgentConfig fields. The route remains the connection authority. */
export function providerRefForConnectionId(
  connectionId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): ProviderRef | undefined {
  const profile = resolver.connectionProfile(connectionId);
  const providerId = profile ? legacyProviderIdForConnectionId(connectionId, resolver) : undefined;
  if (!profile || !providerId) {
    return undefined;
  }
  return {
    providerId,
    // A keyless custom profile is visibly non-runnable. Never invent a SecretStorage name or borrow one.
    apiKeySecretName: profile.apiKeySecretName
      ?? (profile.authKind === 'claude-cli' ? 'CLAUDE_CLI_AUTH' : profile.authKind === 'codex-cli' ? 'CODEX_CLI_AUTH' : ''),
  };
}

/** Construct the closed AgentRoute form for an already-resolved connection identity. */
export function routeForConnectionId(
  connectionId: string,
  modelId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentRoute {
  const profile = resolver.connectionProfile(connectionId);
  if (!profile) {
    throw new Error(`Connection "${connectionId}" is not registered.`);
  }
  if (!modelId.trim()) {
    throw new Error('Agent route has no model id. Choose a model before continuing.');
  }
  if (profile.kind === 'claude-headless') {
    return { routeVersion: AGENT_ROUTE_VERSION, kind: 'claude-headless', connectionId: 'claude-cli', modelId };
  }
  if (profile.kind === 'codex-headless') {
    return { routeVersion: AGENT_ROUTE_VERSION, kind: 'codex-headless', connectionId: 'codex-cli', modelId };
  }
  return { routeVersion: AGENT_ROUTE_VERSION, kind: 'openai-compatible', connectionId: profile.id, modelId };
}

export function agentRouteFromLegacyConfig(
  config: Pick<AgentConfig, 'provider' | 'model' | 'backend' | 'route'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentRoute {
  if (config.route) {
    assertRegisteredRoute(config.route, resolver);
    return config.route;
  }
  return routeFromLegacyFields(config, resolver);
}

/** The one credential identity an API-key route may use. CLI routes have a local identity label instead. */
export function authIdentityRefForRoute(
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string {
  assertRegisteredRoute(route, resolver);
  const profile = resolver.connectionProfile(route.connectionId)!;
  if (profile.apiKeySecretName) {
    return profile.apiKeySecretName;
  }
  if (profile.authKind === 'api-key') {
    throw new Error(`Connection "${profile.id}" has no API key configured.`);
  }
  return profile.authKind === 'claude-cli' ? 'CLAUDE_CLI_AUTH' : 'CODEX_CLI_AUTH';
}

/** API-key routes only. `undefined` means the route authenticates through its local CLI account. */
export function apiKeySecretNameForRoute(
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string | undefined {
  assertRegisteredRoute(route, resolver);
  return resolver.connectionProfile(route.connectionId)!.apiKeySecretName;
}

/** Capture the machine-owned profile facts a backend may rely on for later model egress. */
export function captureActiveConnectionProfile(
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): ActiveConnectionProfile {
  assertRegisteredRoute(route, resolver);
  const profile = resolver.connectionProfile(route.connectionId)!;
  const endpointBase = route.kind === 'openai-compatible'
    ? profile.presentation.endpointDefault
    : undefined;
  return Object.freeze({
    connectionId: profile.id,
    revision: profile.revision,
    ...(endpointBase === undefined ? {} : { endpointBase: canonicalEndpointBase(endpointBase) }),
    ...(profile.apiKeySecretName === undefined ? {} : { apiKeySecretName: profile.apiKeySecretName }),
  });
}

/**
 * Reject a backend whose host-owned profile changed after it was constructed. This is intentionally
 * checked at model egress instead of relying on a watcher: a watcher only improves UI freshness and
 * cannot make a stale endpoint/key snapshot safe.
 */
export function assertActiveConnectionProfile(
  expected: ActiveConnectionProfile,
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): void {
  assertRegisteredRoute(route, resolver);
  const profile = resolver.connectionProfile(route.connectionId)!;
  if (profile.id !== expected.connectionId || profile.revision !== expected.revision) {
    throw new Error(`Connection "${expected.connectionId}" changed or is unavailable. Restart the agent before sending another request.`);
  }
  const endpointBase = route.kind === 'openai-compatible'
    ? profile.presentation.endpointDefault
    : undefined;
  if (
    (expected.endpointBase === undefined) !== (endpointBase === undefined) ||
    (endpointBase !== undefined && canonicalEndpointBase(endpointBase) !== expected.endpointBase)
  ) {
    throw new Error(`Connection "${expected.connectionId}" endpoint changed. Restart the agent before sending another request.`);
  }
  if (profile.apiKeySecretName !== expected.apiKeySecretName) {
    throw new Error(`Connection "${expected.connectionId}" credential identity changed. Restart the agent before sending another request.`);
  }
}

/**
 * Host-side defense for in-memory callers that bypass TeamFileSchema. A registered API-key route
 * must not read a different connection's SecretStorage entry just because a config object says so.
 */
export function assertAgentConfigApiKeyOwnership(
  config: Pick<AgentConfig, 'provider' | 'model' | 'backend' | 'route'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): void {
  const route = agentRouteFromLegacyConfig(config, resolver);
  const expected = apiKeySecretNameForRoute(route, resolver);
  if (expected && config.provider.apiKeySecretName !== expected) {
    throw new Error(
      `Route "${route.connectionId}" must use SecretStorage key "${expected}", not "${config.provider.apiKeySecretName}".`
    );
  }
}

/**
 * Deterministically convert legacy provider/backend fields.  This deliberately knows nothing
 * about model spelling: a Claude- or Codex-looking model on an OpenAI-compatible gateway stays
 * on that gateway.  A contradictory hand-edited pair is rejected for the caller to show, never
 * "fixed" by guessing which field the user meant.
 */
export function routeFromLegacyFields(
  config: Pick<AgentConfig, 'provider' | 'model' | 'backend'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentRoute {
  const providerId = config.provider?.providerId?.trim().toLowerCase();
  const connectionId = providerId ? connectionIdForProviderId(providerId, resolver) : undefined;
  const profile = connectionId ? resolver.connectionProfile(connectionId) : undefined;
  if (!profile) {
    throw new Error(`Legacy route has an unknown provider "${config.provider?.providerId ?? ''}". Choose a connection before continuing.`);
  }
  if (!config.model?.trim()) {
    throw new Error('Legacy route has no model id. Choose a model before continuing.');
  }
  // An absent backend was the legacy default only for the original gateway/Claude records.
  // Codex was introduced as an explicit backend; treating an omitted value as Codex would turn a
  // hand-edited or malformed record into a new subscription route without the user's choice.
  if (profile.kind === 'codex-headless' && config.backend !== 'codex') {
    throw new Error('Legacy route for provider "codex" requires backend "codex". Choose the connection explicitly before continuing.');
  }
  if (config.backend !== undefined && config.backend !== profile.backendKind) {
    throw new Error(
      `Legacy route conflicts: provider "${config.provider.providerId}" requires ${profile.backendKind}, ` +
      `but backend is ${config.backend}. Choose the connection explicitly before continuing.`
    );
  }
  return routeForConnectionId(profile.id, config.model, resolver);
}

/** Validate the route's closed shape and that its connection exists with the same registered kind. */
export function assertRegisteredRoute(
  route: unknown,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): asserts route is AgentRoute {
  assertAgentRoute(route);
  const profile = resolver.connectionProfile(route.connectionId);
  if (!profile || profile.kind !== route.kind) {
    throw new Error(`Agent route names an unknown or incompatible connection "${route.connectionId}".`);
  }
}

export function manifestDefaultConnectionIds(
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string[] {
  // Known-but-unavailable routes remain migratable, but must never be offered as configuration defaults.
  return resolver.profiles.filter((item) => item.availability === 'available').map((item) => item.id);
}

/**
 * Normalize a persisted default through the same availability contract as Settings and the
 * creation dialogs. This is intentionally pure so historic `google`/`ollama` values are tested as
 * behavior, not merely mentioned in a release note.
 */
export function resolveAvailableDefaultProviderId(
  configured: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): {
  providerId: string;
  repairMessage?: string;
} {
  if (configured.trim().toLowerCase() === LEGACY_CUSTOM_PROVIDER_ID) {
    // The singleton is migration input only. Returning it with a repair message lets the host block
    // default-driven creation instead of silently changing a user's default to an unrelated gateway.
    return {
      providerId: LEGACY_CUSTOM_PROVIDER_ID,
      repairMessage: 'legacy Custom default requires migration and an explicit named gateway selection.',
    };
  }
  const connectionId = connectionIdForProviderId(configured, resolver);
  const profile = connectionId ? connectionProfile(connectionId, resolver) : undefined;
  const legacyProviderId = profile ? legacyProviderIdForConnectionId(profile.id, resolver) : undefined;
  if (profile?.availability === 'available' && legacyProviderId) {
    return { providerId: legacyProviderId };
  }
  const fallback = legacyProviderIdForConnectionId('unode', resolver);
  if (!fallback) {
    throw new Error('The Unode fallback connection is not registered.');
  }
  return {
    providerId: fallback,
    repairMessage: profile?.availabilityMessage ?? `unsupported default connection "${configured}".`,
  };
}
