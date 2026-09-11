import { AgentConfig, MCPServerConfig, WorkflowBranch, WorkflowConfig, WorkflowStep } from '../types';
import { migrateWorkflowBranchLabel } from '../workflow/GatedWorkflow';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  apiKeySecretNameForRoute,
  assertRegisteredRoute,
  connectionIdForProviderId,
  connectionProfile,
} from '../routes/ConnectionRegistry';
import { assertRepairableCustomRoute, legacyFieldsForRoute } from '../routes/RouteMigration';
import {
  isLegacySingletonCustomAgent,
  LEGACY_CUSTOM_MISSING_MODEL_REPAIR,
  LEGACY_CUSTOM_PROVIDER_ID,
} from '../connections/LegacyCustomGatewayMigration';
import { assertAgentRoute, type AgentRoute } from '../routes/RouteContracts';
import { isCoordinator, resolveCoordinatorId } from '../session/CoordinatorIdentity';

export interface TeamFileDocument {
  version?: string;
  members: AgentConfig[];
  mcpServers: MCPServerConfig[];
  workflows: WorkflowConfig[];
  /** Non-fatal unsafe fields stripped while loading. Persistence surfaces these to the user. */
  validationWarnings?: readonly string[];
}

export class TeamFileValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid .unode/team.json: ${issues.slice(0, 5).join('; ')}`);
  }
}

const ROLES = new Set([
  'architect', 'developer', 'reviewer', 'qa', 'pm', 'product-manager', 'devops', 'tech-writer',
  'security', 'data-engineer', 'senior-dev', 'tester', 'solo', 'custom',
]);
const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);
/**
 * Workspace files are untrusted input, so an agent is rebuilt from named fields rather than from a spread.
 *
 * The list this replaced was a hand-maintained array with a comment telling the next person to keep it in
 * lockstep with `AgentConfig`. It did not stay in lockstep — `editToolDialect` and `commandNarrowing` were
 * both missing, which meant a roster using either wrote a team file this validator then refused. Written as
 * a map over `keyof AgentConfig`, the compiler fails the build until a newly added field is given an answer,
 * so the question can no longer be skipped by forgetting it exists.
 *
 * `false` is a real answer, not an omission: `routeRepair` is host-authored and deliberately never persisted.
 */
const AGENT_CONFIG_FIELD_PERSISTENCE: { [K in keyof Required<AgentConfig>]: boolean } = {
  id: true,
  name: true,
  role: true,
  skill: true,
  skills: true,
  provider: true,
  model: true,
  route: true,
  routeRepair: false,   // host-authored repair note; a workspace file must never assert one
  systemPrompt: true,
  roleTemplateKey: true,
  systemPromptSource: true,
  systemPromptTemplateAtFork: true,
  systemPromptDismissedTemplateHash: true,
  systemPromptUndo: true,
  description: true,
  icon: true,
  color: true,
  autoApprove: true,
  allowedTools: true,
  maxTokens: true,
  temperature: true,
  modelParams: true,
  tier: true,
  // No creation path may pin this — `dialogs.presets.test.ts` asserts it as a runtime invariant, and the
  // Agent Builder says why: a directory pinned at save time goes stale the moment the agent runs somewhere
  // else, and the user gets "outside working folder" for a folder they never chose. The runtime resolves the
  // root per session and records it on `SessionInfo.runtimeWorkingDirectory`. Persisting it here would let a
  // legacy or hand-written file reintroduce exactly the pin the rest of the code refuses to create.
  workingDirectory: false,
  env: true,
  backend: true,
  baseUrl: true,
  autoRestart: true,
  fallbackModel: true,
  contextWindowTokens: true,
  measuredContextWindow: true,
  observedContextWindow: true,
  mcpServers: true,
  playbooks: true,
  toolProtocol: true,
  editToolDialect: true,
  folderAccess: true,
  commandNarrowing: true,
  disableNativeSubagents: true,
};

/** Not an `AgentConfig` field, but a legacy team file may carry it and must stay loadable. */
const NON_AGENT_CONFIG_TEAM_FILE_FIELDS = ['legacyCustomRepair'] as const;

export const AGENT_CONFIG_FIELDS = new Set<string>([
  ...Object.entries(AGENT_CONFIG_FIELD_PERSISTENCE).filter(([, persisted]) => persisted).map(([field]) => field),
  ...NON_AGENT_CONFIG_TEAM_FILE_FIELDS,
]);

export function validateTeamFile(
  raw: unknown,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): TeamFileDocument {
  const issues: string[] = [];
  const validationWarnings: string[] = [];
  if (!isRecord(raw)) {
    throw new TeamFileValidationError(['root must be a JSON object']);
  }

  const membersRaw = Array.isArray(raw.members) ? raw.members : Array.isArray(raw.agents) ? raw.agents : [];
  if (raw.members !== undefined && !Array.isArray(raw.members)) {
    issues.push('members must be an array');
  }
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) {
    issues.push('agents must be an array');
  }
  if (raw.mcpServers !== undefined && !Array.isArray(raw.mcpServers)) {
    issues.push('mcpServers must be an array');
  }
  if (raw.workflows !== undefined && !Array.isArray(raw.workflows)) {
    issues.push('workflows must be an array');
  }

  const members = Array.isArray(membersRaw)
    ? membersRaw.map((m, i) => validateAgent(m, `members[${i}]`, issues, validationWarnings, resolver)).filter(Boolean) as AgentConfig[]
    : [];
  normalizeCoordinatorDelegation(members, validationWarnings);
  const mcpServersRaw = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  const mcpServers = mcpServersRaw
    .map((s, i) => validateMcpServer(s, `mcpServers[${i}]`, issues))
    .filter(Boolean) as MCPServerConfig[];
  const workflowsRaw = Array.isArray(raw.workflows) ? raw.workflows : [];
  const workflows = workflowsRaw
    .map((w, i) => validateWorkflow(w, `workflows[${i}]`, issues, validationWarnings))
    .filter(Boolean) as WorkflowConfig[];

  if (issues.length > 0) {
    throw new TeamFileValidationError(issues);
  }
  return {
    version: typeof raw.version === 'string' ? raw.version : undefined,
    members,
    mcpServers,
    workflows,
    validationWarnings,
  };
}

/** Keep legacy teams loadable while removing retired non-coordinator delegation in memory. */
function normalizeCoordinatorDelegation(members: AgentConfig[], validationWarnings: string[]): void {
  const coordinatorId = resolveCoordinatorId(members);
  const secondaryPms = members.filter((member) => member.role === 'pm' && !isCoordinator(member, coordinatorId));
  for (const member of members) {
    if (isCoordinator(member, coordinatorId) || !member.allowedTools.includes('delegate')) continue;
    member.allowedTools = member.allowedTools.filter((tool) => tool !== 'delegate');
    validationWarnings.push(`member "${member.name}" (${member.id}) dropped retired delegate capability: only the coordinator may dispatch.`);
  }
  for (const member of secondaryPms) {
    validationWarnings.push(`member "${member.name}" (${member.id}) is an additional PM and no longer receives dispatch tools; coordinator is "${coordinatorId}".`);
  }
}

function validateAgent(
  raw: unknown,
  path: string,
  issues: string[],
  validationWarnings: string[],
  resolver: ConnectionResolver,
): AgentConfig | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  // An unsupported field is stripped below and never reaches runtime, so rejecting the whole file on top of
  // that is a second refusal for a risk the first one already removed — and it cost more than it bought. Our
  // own writer emitted two such fields for years, which made every team file it produced unreadable by this
  // function: a fatal issue turned that into "you have no saved teams" with the reason nowhere. It is a
  // warning now. Sanitisation is the boundary; the warning is how a reader learns something was dropped.
  const unsupportedFields = Object.keys(raw).filter((field) => !AGENT_CONFIG_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    validationWarnings.push(`${path} dropped unsupported field${unsupportedFields.length === 1 ? '' : 's'}: ${unsupportedFields.join(', ')}`);
  }
  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([field]) => AGENT_CONFIG_FIELDS.has(field))
  );
  requireString(raw, 'id', path, issues);
  requireString(raw, 'name', path, issues);
  requireString(raw, 'role', path, issues);
  if (typeof raw.role === 'string' && !ROLES.has(raw.role)) {
    issues.push(`${path}.role has unsupported value "${raw.role}"`);
  }
  requireString(raw, 'skill', path, issues);
  requireString(raw, 'systemPrompt', path, issues);
  let validRoute: AgentRoute | undefined;
  let routeRepair: string | undefined;
  const missingModelLegacyRepair = raw.legacyCustomRepair === LEGACY_CUSTOM_MISSING_MODEL_REPAIR;
  if (raw.legacyCustomRepair !== undefined && !missingModelLegacyRepair) {
    issues.push(`${path}.legacyCustomRepair has unsupported value`);
  }
  if (missingModelLegacyRepair) {
    delete sanitized.legacyCustomRepair;
    sanitized.provider = { providerId: LEGACY_CUSTOM_PROVIDER_ID, apiKeySecretName: '' };
    sanitized.model = '';
    sanitized.backend = 'openai-compat';
    routeRepair = 'Legacy Custom gateway route has no model id. Choose a model while repairing this agent.';
    validationWarnings.push(`${path} needs repair: ${routeRepair}`);
  }
  if (raw.route !== undefined) {
    const rawRoute = raw.route;
    try {
      // Route objects are deliberately closed: endpoint credentials and CLI auth material are never
      // accepted into versionable workspace state, even if a caller bypassed TypeScript.
      assertAgentRoute(rawRoute);
      assertRegisteredRoute(rawRoute, resolver);
      validRoute = rawRoute;
    } catch (error) {
      if (isLegacySingletonCustomAgent({ provider: raw.provider as AgentConfig['provider'], route: rawRoute as AgentConfig['route'] })) {
        try {
          assertAgentRoute(rawRoute);
          validRoute = rawRoute;
          routeRepair = 'Legacy Custom gateway migration is required. Trust this workspace and review the host migration preview before starting this agent.';
          validationWarnings.push(`${path}.route needs repair: ${routeRepair}`);
        } catch (legacyRouteError) {
          // Keep the legacy fields importable, but never pass an untyped route to the migration
          // planner. A malformed modelId previously reached `.trim()` during activation.
          delete sanitized.route;
          routeRepair = 'Legacy Custom gateway route is malformed. Repair its model and review the host migration preview before starting this agent.';
          validationWarnings.push(`${path}.route needs repair: ${routeRepair} (${legacyRouteError instanceof Error ? legacyRouteError.message : String(legacyRouteError)})`);
        }
      } else {
        try {
          assertAgentRoute(rawRoute);
          assertRepairableCustomRoute(rawRoute);
          validRoute = rawRoute;
          routeRepair = `Custom gateway "${rawRoute.connectionId}" is unavailable on this machine. Repair or rebind this agent before starting it.`;
          validationWarnings.push(`${path}.route needs repair: ${routeRepair}`);
        } catch {
          issues.push(`${path}.route is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const connectionId = validRoute?.connectionId ?? (
    isRecord(raw.provider) && typeof raw.provider.providerId === 'string'
      ? connectionIdForProviderId(raw.provider.providerId, resolver)
      : undefined
  );
  const expectedSecretName = routeRepair
    ? undefined
    : validRoute
    ? apiKeySecretNameForRoute(validRoute, resolver)
    : connectionId ? connectionProfile(connectionId, resolver)?.apiKeySecretName : undefined;
  if (
    expectedSecretName
    && isRecord(raw.provider)
    && raw.provider.apiKeySecretName !== undefined
    && raw.provider.apiKeySecretName !== expectedSecretName
  ) {
    issues.push(
      `${path}.provider.apiKeySecretName must be "${expectedSecretName}" for connection "${connectionId}".`
    );
  }
  if (raw.baseUrl !== undefined) {
    // A workspace record may never redirect a built-in or machine-local custom connection. The
    // host resolver owns every endpoint; preserve the rest of the team file and make removal visible.
    delete sanitized.baseUrl;
    validationWarnings.push(`${path}.baseUrl was ignored: endpoints are owned by the local connection registry.`);
  }
  // v1 exports carry only `route`; old files remain importable for one compatibility window.
  if (validRoute) {
    // A supplied legacy field is validated but not trusted: route is the only authority.
    if (raw.provider !== undefined && !isRecord(raw.provider)) {
      issues.push(`${path}.provider must be an object when supplied`);
    }
    if (raw.model !== undefined && typeof raw.model !== 'string') {
      issues.push(`${path}.model must be a string when supplied`);
    }
  } else if (!missingModelLegacyRepair) {
    requireString(raw, 'model', path, issues);
    if (!isRecord(raw.provider)) {
      issues.push(`${path}.provider must be an object`);
    } else {
      requireString(raw.provider, 'providerId', `${path}.provider`, issues);
      requireString(raw.provider, 'apiKeySecretName', `${path}.provider`, issues);
    }
  }
  if (raw.allowedTools !== undefined && !isStringArray(raw.allowedTools)) {
    issues.push(`${path}.allowedTools must be an array of strings`);
  }
  if (raw.mcpServers !== undefined && !isStringArray(raw.mcpServers)) {
    issues.push(`${path}.mcpServers must be an array of strings`);
  }
  if (raw.backend !== undefined && raw.backend !== 'claude' && raw.backend !== 'codex' && raw.backend !== 'openai-compat') {
    issues.push(`${path}.backend must be "claude", "codex", or "openai-compat"`);
  }
  if (raw.disableNativeSubagents !== undefined && typeof raw.disableNativeSubagents !== 'boolean') {
    issues.push(`${path}.disableNativeSubagents must be a boolean`);
  }
  if (raw.measuredContextWindow !== undefined) {
    if (!isRecord(raw.measuredContextWindow)) {
      issues.push(`${path}.measuredContextWindow must be an object`);
    } else {
      const measurement = raw.measuredContextWindow;
      if (typeof measurement.model !== 'string' || !measurement.model.trim()) {
        issues.push(`${path}.measuredContextWindow.model must be a non-empty string`);
      }
      if (typeof measurement.tokens !== 'number' || !Number.isSafeInteger(measurement.tokens) || measurement.tokens <= 0) {
        issues.push(`${path}.measuredContextWindow.tokens must be a positive integer`);
      }
      if (
        measurement.field !== 'context_length'
        && measurement.field !== 'max_context_length'
        && measurement.field !== 'context_window'
      ) {
        issues.push(`${path}.measuredContextWindow.field has unsupported value`);
      }
    }
  }
  if (raw.observedContextWindow !== undefined) {
    if (!isRecord(raw.observedContextWindow)) {
      issues.push(`${path}.observedContextWindow must be an object`);
    } else {
      const bound = raw.observedContextWindow;
      if (typeof bound.model !== 'string' || !bound.model.trim()) {
        issues.push(`${path}.observedContextWindow.model must be a non-empty string`);
      }
      if (typeof bound.tokens !== 'number' || !Number.isSafeInteger(bound.tokens) || bound.tokens <= 0) {
        issues.push(`${path}.observedContextWindow.tokens must be a positive integer`);
      }
      // The instant is what separates a ceiling this gateway proved last week from one proved a year ago on
      // a model that has since been resized. A bound with no provenance is a number nobody can audit.
      if (typeof bound.observedAt !== 'string' || Number.isNaN(Date.parse(bound.observedAt))) {
        issues.push(`${path}.observedContextWindow.observedAt must be an ISO-8601 timestamp`);
      }
    }
  }
  if (raw.systemPromptSource !== undefined && raw.systemPromptSource !== 'template' && raw.systemPromptSource !== 'custom') {
    issues.push(`${path}.systemPromptSource must be "template" or "custom"`);
  }
  if (raw.roleTemplateKey !== undefined && typeof raw.roleTemplateKey !== 'string') {
    issues.push(`${path}.roleTemplateKey must be a string`);
  }
  if (raw.systemPromptTemplateAtFork !== undefined && typeof raw.systemPromptTemplateAtFork !== 'string') {
    issues.push(`${path}.systemPromptTemplateAtFork must be a string`);
  }
  if (raw.systemPromptDismissedTemplateHash !== undefined && typeof raw.systemPromptDismissedTemplateHash !== 'string') {
    issues.push(`${path}.systemPromptDismissedTemplateHash must be a string`);
  }
  if (raw.systemPromptUndo !== undefined) {
    if (!isRecord(raw.systemPromptUndo) || typeof raw.systemPromptUndo.prompt !== 'string') {
      issues.push(`${path}.systemPromptUndo must contain a prompt string`);
    } else if (
      (raw.systemPromptUndo.templateAtFork !== undefined && typeof raw.systemPromptUndo.templateAtFork !== 'string') ||
      (raw.systemPromptUndo.dismissedTemplateHash !== undefined && typeof raw.systemPromptUndo.dismissedTemplateHash !== 'string')
    ) {
      issues.push(`${path}.systemPromptUndo template metadata must be strings`);
    }
  }
  if (raw.folderAccess !== undefined) {
    if (!Array.isArray(raw.folderAccess)) {
      issues.push(`${path}.folderAccess must be an array`);
    } else {
      raw.folderAccess.forEach((grant, i) => {
        if (!isRecord(grant)) {
          issues.push(`${path}.folderAccess[${i}] must be an object`);
          return;
        }
        if (typeof grant.path !== 'string' || grant.path.trim() === '') {
          issues.push(`${path}.folderAccess[${i}].path must be a non-empty string`);
        }
        if (grant.permission !== 'read' && grant.permission !== 'readwrite') {
          issues.push(`${path}.folderAccess[${i}].permission must be "read" or "readwrite"`);
        }
      });
    }
  }
  if (!validRoute) {
    return { ...sanitized, ...(routeRepair === undefined ? {} : { routeRepair }) } as unknown as AgentConfig;
  }
  if (routeRepair) {
    return {
      ...sanitized,
      route: validRoute,
      provider: { providerId: validRoute.connectionId, apiKeySecretName: '' },
      model: validRoute.modelId,
      backend: 'openai-compat',
      routeRepair,
    } as unknown as AgentConfig;
  }
  return { ...sanitized, route: validRoute, ...legacyFieldsForRoute(validRoute, resolver) } as unknown as AgentConfig;
}

function validateMcpServer(raw: unknown, path: string, issues: string[]): MCPServerConfig | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  requireString(raw, 'id', path, issues);
  requireString(raw, 'name', path, issues);
  requireString(raw, 'transport', path, issues);
  if (typeof raw.transport === 'string' && !TRANSPORTS.has(raw.transport)) {
    issues.push(`${path}.transport has unsupported value "${raw.transport}"`);
  }
  if (raw.transport === 'stdio' && typeof raw.command !== 'string') {
    issues.push(`${path}.command is required for stdio MCP servers`);
  }
  if ((raw.transport === 'streamable-http' || raw.transport === 'sse') && typeof raw.url !== 'string') {
    issues.push(`${path}.url is required for remote MCP servers`);
  }
  if (raw.args !== undefined && !isStringArray(raw.args)) {
    issues.push(`${path}.args must be an array of strings`);
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    issues.push(`${path}.env must be an object whose values are strings`);
  }
  if (raw.timeoutMs !== undefined && typeof raw.timeoutMs !== 'number') {
    issues.push(`${path}.timeoutMs must be a number`);
  }
  if (raw.requiresApproval !== undefined && typeof raw.requiresApproval !== 'boolean') {
    issues.push(`${path}.requiresApproval must be a boolean`);
  }
  return raw as unknown as MCPServerConfig;
}

function validateWorkflow(
  raw: unknown,
  path: string,
  issues: string[],
  validationWarnings: string[],
): WorkflowConfig | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  requireString(raw, 'id', path, issues);
  requireString(raw, 'name', path, issues);
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    issues.push(`${path}.description must be a string`);
  }
  if (!Array.isArray(raw.steps)) {
    issues.push(`${path}.steps must be an array`);
    return undefined;
  }
  const steps = raw.steps
    .map((s, i) => validateWorkflowStep(s, `${path}.steps[${i}]`, issues, validationWarnings))
    .filter(Boolean) as WorkflowStep[];
  return { ...(raw as unknown as WorkflowConfig), steps };
}

function validateWorkflowStep(
  raw: unknown,
  path: string,
  issues: string[],
  validationWarnings: string[],
): WorkflowStep | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  requireString(raw, 'id', path, issues);
  requireString(raw, 'from', path, issues);
  requireString(raw, 'to', path, issues);
  requireString(raw, 'action', path, issues);
  if (raw.autoTransition !== undefined && typeof raw.autoTransition !== 'boolean') {
    issues.push(`${path}.autoTransition must be a boolean`);
  }
  if (raw.condition !== undefined && typeof raw.condition !== 'string') {
    issues.push(`${path}.condition must be a string`);
  }
  let branches: WorkflowBranch[] | undefined;
  if (raw.branches !== undefined && !Array.isArray(raw.branches)) {
    issues.push(`${path}.branches must be an array`);
  } else if (Array.isArray(raw.branches)) {
    branches = raw.branches
      .map((b, i) => validateWorkflowBranch(b, `${path}.branches[${i}]`, issues, validationWarnings))
      .filter(Boolean) as WorkflowBranch[];
  }
  return {
    ...(raw as unknown as WorkflowStep),
    autoTransition: raw.autoTransition !== false,
    ...(branches ? { branches } : {}),
  };
}

/**
 * A branch is migrated, not rejected, when it comes from a pre-0.9.70 file. Rejecting it would fail the
 * whole team file -- members and all -- for a workflow shape the previous editor itself wrote.
 * Genuinely corrupt data (wrong types, missing `goto`, an explicitly empty new-format label) is still an
 * issue, because there is no old meaning to preserve.
 */
function validateWorkflowBranch(
  raw: unknown,
  path: string,
  issues: string[],
  validationWarnings: string[],
): WorkflowBranch | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  requireString(raw, 'goto', path, issues);
  if (typeof raw.goto !== 'string') {
    return undefined;
  }
  if (raw.label !== undefined) {
    // New format: an explicitly supplied label must be real. This is not the legacy shape and is not repaired.
    if (typeof raw.label !== 'string' || raw.label.length === 0) {
      issues.push(`${path}.label must be a non-empty string`);
      return undefined;
    }
  } else if (raw.whenResultContains !== undefined && typeof raw.whenResultContains !== 'string') {
    issues.push(`${path}.whenResultContains must be a string`);
    return undefined;
  }
  const migrated = migrateWorkflowBranchLabel(raw);
  if (raw.label === undefined) {
    validationWarnings.push(migrated.fallback
      ? `${path} had no branch condition, which used to mean "always". It now runs only when the agent `
        + 'selects no matching label, and it is never offered to the agent as a choice.'
      : `${path} migrated whenResultContains "${String(raw.whenResultContains)}" to the exact label `
        + `"${migrated.label}"; the agent must now select that label.`);
  }
  return { ...migrated, goto: raw.goto };
}

function requireString(obj: Record<string, unknown>, key: string, path: string, issues: string[]): void {
  if (typeof obj[key] !== 'string' || obj[key] === '') {
    issues.push(`${path}.${key} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}
