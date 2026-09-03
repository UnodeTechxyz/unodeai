/*---------------------------------------------------------------------------------------------
 *  Provider route contracts
 *
 *  This module deliberately has no VS Code, credential, fetch, or child-process dependency.
 *  It defines the values that may cross a model-content boundary; the boundary assertion below
 *  is load-bearing, while type restrictions and tests are defence in depth.
 *--------------------------------------------------------------------------------------------*/

import type { AgentBackendKind } from '../types';

export const AGENT_ROUTE_VERSION = 1 as const;

export type ConnectionKind = 'openai-compatible' | 'claude-headless' | 'codex-headless';
/** A known connection may be retained for migration while not yet offered for use. */
export type ConnectionAvailability = 'available' | 'coming-soon';
export type BillingKind = 'gateway-balance' | 'api-account' | 'cli-account' | 'custom-account';
export type AuthKind = 'api-key' | 'claude-cli' | 'codex-cli';
export type CommandApprovalKind = 'unode-mediated' | 'runtime-sandbox' | 'none';

/** UI data belongs to the connection profile, not a provider-id branch in a webview. */
export interface ConnectionSetup {
  kind: 'api-key' | 'cli';
  actionLabel: string;
  /** Informational only. Setup never executes this command. */
  installCommand?: string;
  /** Pre-filled, not executed, in a user-initiated integrated terminal. */
  loginCommand?: string;
  terminalName?: string;
  /** A required user-visible VS Code setting, never a credential value. */
  requiredSetting?: string;
}

export interface ConnectionPresentation {
  displayName: string;
  runtimeLabel: string;
  billingLabel: string;
  /** Built-in endpoint offered by this connection, if it has one. Never a credential. */
  endpointDefault?: string;
  /** What the user should assume about prompt/workspace-content egress for this route. */
  privacySummary: string;
  /** Built-in navigation targets only. Custom profiles never inherit another connection's links. */
  signupUrl?: string;
  pricingUrl?: string;
  /** The host may request a live balance only when this exact profile advertises support. */
  balanceAvailable?: boolean;
  setup: ConnectionSetup;
}

/** A peer setup door. Its members and capability copy are resolved from connection profiles. */
export interface ConnectionSetupGroup {
  kind: ConnectionKind;
  displayName: string;
  description: string;
}

/** Non-sensitive offline model metadata. Dynamic custom connections begin empty and populate from /models. */
export interface ConnectionModel {
  id: string;
  name: string;
  vision?: boolean;
}

/** Persisted route selection. It intentionally has no endpoint, auth value, token, or CLI-home field. */
export type AgentRoute =
  | {
      routeVersion: typeof AGENT_ROUTE_VERSION;
      kind: 'openai-compatible';
      connectionId: string;
      modelId: string;
    }
  | {
      routeVersion: typeof AGENT_ROUTE_VERSION;
      kind: 'claude-headless';
      connectionId: 'claude-cli';
      modelId: string;
    }
  | {
      routeVersion: typeof AGENT_ROUTE_VERSION;
      kind: 'codex-headless';
      connectionId: 'codex-cli';
      modelId: string;
    };

type CapabilityBase = {
  plan: boolean;
  act: boolean;
  read: boolean;
  write: boolean;
  delegation: boolean;
  coordinator: boolean;
  mcp: boolean;
  skills: boolean;
  /** Per-agent folder grants actually constrain the route's accessible filesystem surface. */
  folderAccess: boolean;
  /** The route consumes UnodeAi's native/XML tool-protocol setting. */
  toolProtocol: boolean;
  /** The route consumes UnodeAi Smart Mode tier selection. */
  smartMode: boolean;
  worktrees: boolean;
  verification: boolean;
  stop: boolean;
  steer: boolean;
  resume: boolean;
  modelParams: ReadonlySet<string>;
};

/**
 * A command-capable profile must name a non-`none` approval mechanism. The union makes the
 * invalid literal unconstructable; `assertRuntimeCapabilities` protects dynamic/JSON input.
 */
export type RuntimeCapabilities = CapabilityBase & (
  | { command: true; commandApproval: Exclude<CommandApprovalKind, 'none'> }
  | { command: false; commandApproval: CommandApprovalKind }
);

export interface ConnectionProfile {
  id: string;
  /** Changes when a machine-owned custom connection changes its runtime identity. Built-ins use 1. */
  revision: number;
  kind: ConnectionKind;
  /** Product availability is enforced by the host, not just rendered by webviews. */
  availability: ConnectionAvailability;
  /** User-facing reason when the registered route is intentionally not runnable. */
  availabilityMessage?: string;
  backendKind: AgentBackendKind;
  billingKind: BillingKind;
  authKind: AuthKind;
  catalogKind: 'openai-models' | 'claude-cli' | 'codex-cli';
  /** Offline catalog entries belong to the connection identity, never a provider-name shadow map. */
  catalogModels: readonly ConnectionModel[];
  capabilities: RuntimeCapabilities;
  /** API-key routes only. This is a SecretStorage key name, never a key value. Absent means no key is set. */
  apiKeySecretName?: string;
  presentation: ConnectionPresentation;
}

/** Exact canonical form of the endpoint authority a model-content request/process is selected for. */
export interface ExecutionDomain {
  /** Canonical scheme + lower-case host + effective port + base path. Never a hash. */
  canonicalEndpointBase: string;
}

/**
 * The known processor/retention domain for the exact model + execution domain. E0 has no remote
 * privacy registry, so unchanged manual routes use the explicit non-inheritable sentinel.
 */
export interface PrivacyDomain {
  id: string;
  status: 'known' | 'unknown' | 'unresolved-user-selected';
}

/** Immutable values that must remain selected through the final model egress boundary. */
export interface ResolvedAgentRoute {
  authority: 'user-selected';
  route: AgentRoute;
  connectionId: string;
  connectionKind: ConnectionKind;
  backendKind: AgentBackendKind;
  modelId: string;
  billingKind: BillingKind;
  /** Opaque SecretStorage key / local-CLI identity label, never a credential value. */
  authIdentityRef: string;
  executionDomain: ExecutionDomain;
  privacyDomain: PrivacyDomain;
  toolProtocol?: string;
}

export interface ResolvedAgentRouteInput {
  route: AgentRoute;
  profile: Pick<ConnectionProfile, 'kind' | 'backendKind' | 'billingKind'>;
  endpointBase: string;
  authIdentityRef: string;
  toolProtocol?: string;
  privacyDomain?: PrivacyDomain;
}

/**
 * Canonicalize without percent-decoding or URL-path normalization. URL's normalizer folds `%2e`
 * and dot-segments, which would create a false equality at a security boundary.
 */
export function canonicalEndpointBase(input: string): string {
  const value = input.trim();
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!match) {
    throw new Error('Route endpoint must be an absolute URL without query or fragment.');
  }
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(`Route endpoint scheme is not supported: ${scheme}.`);
  }
  const authority = match[2];
  if (authority.includes('@')) {
    throw new Error('Route endpoint must not contain credentials.');
  }
  const { host, port } = splitAuthority(authority);
  let path = match[3] || '/';
  // Exactly one deterministic trailing-slash rule: /v1 and /v1/ compare equal; /v1// remains distinct.
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  const effectivePort = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')
    ? undefined
    : port;
  return `${scheme}://${host}${effectivePort ? `:${effectivePort}` : ''}${path}`;
}

/** Custom model egress is HTTPS-only and never accepts embedded credentials, queries, or fragments. */
export function requireHttpsCustomEndpoint(value: string): string {
  const endpoint = canonicalEndpointBase(value);
  if (!endpoint.startsWith('https://')) {
    throw new Error('Custom OpenAI-compatible endpoint must be HTTPS and contain no credentials, query, or fragment.');
  }
  return endpoint;
}

function splitAuthority(authority: string): { host: string; port?: string } {
  if (!authority || /\s/.test(authority)) {
    throw new Error('Route endpoint host is invalid.');
  }
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end <= 1) { throw new Error('Route endpoint host is invalid.'); }
    const host = authority.slice(0, end + 1).toLowerCase();
    const tail = authority.slice(end + 1);
    if (!tail) { return { host }; }
    if (!/^:\d+$/.test(tail)) { throw new Error('Route endpoint port is invalid.'); }
    return { host, port: assertPort(tail.slice(1)) };
  }
  const pieces = authority.split(':');
  if (pieces.length > 2 || !pieces[0]) { throw new Error('Route endpoint host is invalid.'); }
  if (pieces.length === 1) { return { host: pieces[0].toLowerCase() }; }
  return { host: pieces[0].toLowerCase(), port: assertPort(pieces[1]) };
}

function assertPort(value: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Route endpoint port is invalid.');
  }
  return String(parsed);
}

export function unresolvedUserSelectedPrivacyDomain(route: AgentRoute, executionDomain: ExecutionDomain): PrivacyDomain {
  return {
    // This sentinel is exact: a different model/domain creates a different domain rather than inheriting trust.
    id: `unresolved-user-selected:${executionDomain.canonicalEndpointBase}|${route.modelId}`,
    status: 'unresolved-user-selected',
  };
}

export function createResolvedAgentRoute(input: ResolvedAgentRouteInput): ResolvedAgentRoute {
  assertAgentRoute(input.route);
  const executionDomain: ExecutionDomain = { canonicalEndpointBase: canonicalEndpointBase(input.endpointBase) };
  return Object.freeze({
    authority: 'user-selected' as const,
    route: Object.freeze({ ...input.route }),
    connectionId: input.route.connectionId,
    connectionKind: input.profile.kind,
    backendKind: input.profile.backendKind,
    modelId: input.route.modelId,
    billingKind: input.profile.billingKind,
    authIdentityRef: assertOpaqueIdentityRef(input.authIdentityRef),
    executionDomain: Object.freeze(executionDomain),
    privacyDomain: Object.freeze(input.privacyDomain ?? unresolvedUserSelectedPrivacyDomain(input.route, executionDomain)),
    toolProtocol: input.toolProtocol,
  });
}

/**
 * Compare destinations for coordinator-authored prose. Known and explicitly unknown privacy
 * domains are their own equality space; a manual unresolved domain may not inherit that equality,
 * so it falls back to its exact canonical execution endpoint.
 */
export function coordinatorBriefEgressDestinationKey(route: ResolvedAgentRoute): string {
  return route.privacyDomain.status === 'unresolved-user-selected'
    ? `execution:${route.executionDomain.canonicalEndpointBase}`
    : `privacy:${route.privacyDomain.id}`;
}

function assertOpaqueIdentityRef(value: string): string {
  if (!value || /[\r\n]/.test(value)) { throw new Error('Route auth identity reference is invalid.'); }
  return value;
}

export function assertRuntimeCapabilities(capabilities: RuntimeCapabilities): void {
  // Widen deliberately: untyped configuration/plugin input can reach this runtime validator even though
  // the TypeScript union rejects the same invalid literal at construction time.
  const approval: CommandApprovalKind = capabilities.commandApproval;
  if (capabilities.command && approval === 'none') {
    throw new Error('A command-capable connection must declare a non-none command approval mechanism.');
  }
}

/** Rejects extra fields so raw credentials cannot be smuggled into a persisted route object. */
export function assertAgentRoute(value: unknown): asserts value is AgentRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent route must be an object.');
  }
  const route = value as Record<string, unknown>;
  const expected = new Set(['routeVersion', 'kind', 'connectionId', 'modelId']);
  if (Object.keys(route).some((key) => !expected.has(key))) {
    throw new Error('Agent route contains an unsupported field.');
  }
  if (route.routeVersion !== AGENT_ROUTE_VERSION || typeof route.connectionId !== 'string' || !route.connectionId ||
      typeof route.modelId !== 'string' || !route.modelId) {
    throw new Error('Agent route is invalid.');
  }
  if (route.kind === 'claude-headless' && route.connectionId !== 'claude-cli') {
    throw new Error('Claude Headless must use the claude-cli connection.');
  }
  if (route.kind === 'codex-headless' && route.connectionId !== 'codex-cli') {
    throw new Error('Codex Headless must use the codex-cli connection.');
  }
  if (route.kind !== 'openai-compatible' && route.kind !== 'claude-headless' && route.kind !== 'codex-headless') {
    throw new Error('Agent route kind is invalid.');
  }
}

export function serializeAgentRoute(route: AgentRoute): string {
  assertAgentRoute(route);
  return JSON.stringify(route);
}

/**
 * Load-bearing final boundary. It compares complete strings and opaque identity references, never
 * hashes/host-only shortcuts. Call immediately before model-content fetch/spawn; it throws first.
 */
export function assertResolvedRoute(selected: ResolvedAgentRoute, envelope: ResolvedAgentRoute): void {
  const comparisons: Array<[string, unknown, unknown]> = [
    ['authority', selected.authority, envelope.authority],
    ['route kind', selected.route.kind, envelope.route.kind],
    ['connection', selected.connectionId, envelope.connectionId],
    ['model', selected.modelId, envelope.modelId],
    ['backend', selected.backendKind, envelope.backendKind],
    ['billing', selected.billingKind, envelope.billingKind],
    ['auth identity', selected.authIdentityRef, envelope.authIdentityRef],
    ['endpoint base', selected.executionDomain.canonicalEndpointBase, envelope.executionDomain.canonicalEndpointBase],
    ['privacy domain', selected.privacyDomain.id, envelope.privacyDomain.id],
    ['privacy status', selected.privacyDomain.status, envelope.privacyDomain.status],
    ['tool protocol', selected.toolProtocol, envelope.toolProtocol],
  ];
  for (const [label, expected, actual] of comparisons) {
    if (expected !== actual) {
      throw new Error(`Resolved route boundary mismatch: ${label}.`);
    }
  }
}
