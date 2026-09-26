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
import { existsSync, realpathSync } from 'node:fs';
import * as pathUtil from 'node:path';
import { normalizeCodexPermissionProfile } from '../backend/CodexPermissionProfile';

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
const TEAM_FILE_NARROW_TOOL_CEILING = new Set(['read', 'search', 'message']);
const MCP_TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);
export type TeamFileFieldClass = 'data' | 'narrow-only' | 'host-only';

export interface TeamFileValidationContext {
  /** Physical workspace boundary used to prove that Folder Access only narrows the current root. */
  workspaceRoot?: string;
  /** Global Team Library files are extension-owned user state, not repository authority. */
  authority?: 'project-file' | 'host-owned';
}
/**
 * Workspace files are untrusted input, so an agent is rebuilt from named fields rather than from a spread.
 *
 * The list this replaced was a hand-maintained array with a comment telling the next person to keep it in
 * lockstep with `AgentConfig`. It did not stay in lockstep — `editToolDialect` and `commandNarrowing` were
 * both missing, which meant a roster using either wrote a team file this validator then refused. Written as
 * a map over `keyof AgentConfig`, the compiler fails the build until a newly added field is given an answer,
 * so the question can no longer be skipped by forgetting it exists.
 *
 * `host-only` is a real answer, not an omission. Those fields may live in workspaceState after the user
 * changes them in UnodeAi's UI, but a repository file can neither load nor persist them.
 */
export const AGENT_CONFIG_FIELD_AUTHORITY: { [K in keyof Required<AgentConfig>]: TeamFileFieldClass } = {
  id: 'data',
  name: 'data',
  role: 'data',
  skill: 'data',
  // Skill implementations can grant builtin tools or MCP servers. A team file may describe its primary
  // skill label, but only the Agent Builder may attach executable capability declarations.
  skills: 'host-only',
  provider: 'data',
  model: 'data',
  route: 'data',
  routeRepair: 'host-only',
  systemPrompt: 'data',
  roleTemplateKey: 'data',
  systemPromptSource: 'data',
  systemPromptTemplateAtFork: 'data',
  systemPromptDismissedTemplateHash: 'data',
  systemPromptUndo: 'data',
  description: 'data',
  icon: 'data',
  color: 'data',
  autoApprove: 'host-only',
  codexPermissionProfile: 'host-only',
  allowedTools: 'narrow-only',
  toolCeiling: 'host-only',
  maxTokens: 'data',
  temperature: 'data',
  modelParams: 'data',
  tier: 'data',
  // No creation path may pin this — `dialogs.presets.test.ts` asserts it as a runtime invariant, and the
  // Agent Builder says why: a directory pinned at save time goes stale the moment the agent runs somewhere
  // else, and the user gets "outside working folder" for a folder they never chose. The runtime resolves the
  // root per session and records it on `SessionInfo.runtimeWorkingDirectory`. Persisting it here would let a
  // legacy or hand-written file reintroduce exactly the pin the rest of the code refuses to create.
  workingDirectory: 'host-only',
  env: 'host-only',
  backend: 'host-only',
  baseUrl: 'host-only',
  autoRestart: 'host-only',
  fallbackModel: 'data',
  contextWindowTokens: 'data',
  measuredContextWindow: 'data',
  observedContextWindow: 'data',
  mcpServers: 'host-only',
  // These select extension-owned executable tools and the parsers/edit surfaces that may invoke them.
  // A repository may describe an agent, but it may not attach or switch those execution mechanisms.
  playbooks: 'host-only',
  toolProtocol: 'host-only',
  editToolDialect: 'host-only',
  folderAccess: 'narrow-only',
  commandNarrowing: 'narrow-only',
  disableNativeSubagents: 'narrow-only',
};

/** Not an `AgentConfig` field, but a legacy team file may carry it and must stay loadable. */
const NON_AGENT_CONFIG_TEAM_FILE_FIELDS = ['legacyCustomRepair'] as const;

export const AGENT_CONFIG_FIELDS = new Set<string>([
  ...Object.entries(AGENT_CONFIG_FIELD_AUTHORITY).filter(([, fieldClass]) => fieldClass !== 'host-only').map(([field]) => field),
  ...NON_AGENT_CONFIG_TEAM_FILE_FIELDS,
]);
const KNOWN_AGENT_CONFIG_FIELDS = new Set<string>([
  ...Object.keys(AGENT_CONFIG_FIELD_AUTHORITY),
  ...NON_AGENT_CONFIG_TEAM_FILE_FIELDS,
]);

/**
 * v0.9.80 did not retain the provenance of a workspaceState roster. On the one-time v0.9.81
 * migration remove only `env` and `autoApprove`, the fields that can execute code or bypass an
 * approval without another user decision. The strict project-file boundary remains separate below.
 */
export function clearLegacyImmediateAuthorityFields(
  members: readonly AgentConfig[],
): { members: AgentConfig[]; validationWarnings: string[] } {
  const immediateAuthorityFields = new Set<keyof AgentConfig>(['env', 'autoApprove']);
  const validationWarnings: string[] = [];
  const cleaned = members.map((member, index) => {
    const record = member as unknown as Record<string, unknown>;
    const removed = Object.keys(record).filter(
      (field) => immediateAuthorityFields.has(field as keyof AgentConfig),
    );
    if (removed.length > 0) {
      validationWarnings.push(`legacy members[${index}] cleared source-unknown immediate-authority fields: ${removed.join(', ')}`);
    }
    return Object.fromEntries(
      Object.entries(record).filter(
        ([field]) => !immediateAuthorityFields.has(field as keyof AgentConfig),
      ),
    ) as unknown as AgentConfig;
  });
  return { members: cleaned, validationWarnings };
}

export function validateTeamFile(
  raw: unknown,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
  context: TeamFileValidationContext = {},
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
    ? membersRaw.map((m, i) => validateAgent(m, `members[${i}]`, issues, validationWarnings, resolver, context)).filter(Boolean) as AgentConfig[]
    : [];
  normalizeCoordinatorDelegation(members, validationWarnings);
  const hostOwned = context.authority === 'host-owned';
  const mcpServers = hostOwned && Array.isArray(raw.mcpServers)
    ? raw.mcpServers.map((server, index) => validateMcpServer(server, `mcpServers[${index}]`, issues)).filter(Boolean) as MCPServerConfig[]
    : [];
  if (!hostOwned && Array.isArray(raw.mcpServers) && raw.mcpServers.length > 0) {
    validationWarnings.push('root ignored host-only field mcpServers. Configure integrations in UnodeAi Settings instead.');
  }
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
    if (isCoordinator(member, coordinatorId) || !member.allowedTools?.includes('delegate')) continue;
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
  context: TeamFileValidationContext,
): AgentConfig | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const hostOwned = context.authority === 'host-owned';
  // An unsupported field is stripped below and never reaches runtime, so rejecting the whole file on top of
  // that is a second refusal for a risk the first one already removed — and it cost more than it bought. Our
  // own writer emitted two such fields for years, which made every team file it produced unreadable by this
  // function: a fatal issue turned that into "you have no saved teams" with the reason nowhere. It is a
  // warning now. Sanitisation is the boundary; the warning is how a reader learns something was dropped.
  const hostOnlyFields = hostOwned ? [] : Object.keys(raw).filter(
    (field) => AGENT_CONFIG_FIELD_AUTHORITY[field as keyof AgentConfig] === 'host-only'
  );
  if (hostOnlyFields.length > 0) {
    validationWarnings.push(
      `${path} ignored host-only fields: ${hostOnlyFields.join(', ')}. Configure trusted capabilities in `
      + 'UnodeAi\'s Agent Builder, and approvals in the chat controls; project files cannot set a process environment.',
    );
  }
  const unsupportedFields = Object.keys(raw).filter((field) => !KNOWN_AGENT_CONFIG_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    validationWarnings.push(`${path} dropped unsupported field${unsupportedFields.length === 1 ? '' : 's'}: ${unsupportedFields.join(', ')}`);
  }
  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([field]) => hostOwned ? KNOWN_AGENT_CONFIG_FIELDS.has(field) : AGENT_CONFIG_FIELDS.has(field))
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
    routeRepair = 'Legacy Custom gateway route has no model id. Choose a model while repairing this agent.';
    validationWarnings.push(`${path} needs repair: ${routeRepair}`);
  }
  const requestedTools = raw.allowedTools === undefined
    ? undefined
    : isStringArray(raw.allowedTools) ? raw.allowedTools : [];
  const allowedTools = requestedTools === undefined
    ? undefined
    : hostOwned ? requestedTools : requestedTools.filter((tool) => TEAM_FILE_NARROW_TOOL_CEILING.has(tool));
  const wideningTools = requestedTools?.filter((tool) => !TEAM_FILE_NARROW_TOOL_CEILING.has(tool)) ?? [];
  if (allowedTools === undefined) delete sanitized.allowedTools;
  else sanitized.allowedTools = allowedTools;
  if (!hostOwned && wideningTools.length > 0) {
    validationWarnings.push(`${path}.allowedTools ignored widening values: ${wideningTools.join(', ')}. Enable broader capabilities in UnodeAi's Agent Builder.`);
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
  if (connectionId === 'codex-cli') {
    if (hostOwned && raw.toolCeiling === undefined && allowedTools?.length === 0) {
      // Host-owned v0.9.84 records used [] to mean "leave Codex native tools alone".
      sanitized.toolCeiling = 'native-default';
    } else if (!hostOwned) {
      // Every project file is an untrusted narrowing source. Missing or empty tools must never regain
      // Codex native defaults merely because the repository omitted the field.
      sanitized.toolCeiling = 'bounded';
      sanitized.allowedTools = allowedTools ?? [];
    }
  }
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
  if (raw.toolCeiling !== undefined && raw.toolCeiling !== 'native-default' && raw.toolCeiling !== 'bounded') {
    issues.push(`${path}.toolCeiling must be native-default or bounded`);
  }
  if (hostOwned) {
    validateHostOwnedAgentFields(raw, path, issues);
  }
  if (raw.disableNativeSubagents !== undefined && typeof raw.disableNativeSubagents !== 'boolean') {
    issues.push(`${path}.disableNativeSubagents must be a boolean`);
  } else if (!hostOwned && raw.disableNativeSubagents === false) {
    delete sanitized.disableNativeSubagents;
    validationWarnings.push(`${path}.disableNativeSubagents=false was ignored because a project file may only disable native subagents.`);
  }
  if (raw.commandNarrowing !== undefined) {
    if (!isRecord(raw.commandNarrowing) || !isStringArray(raw.commandNarrowing.allowedCommands)) {
      issues.push(`${path}.commandNarrowing must contain an allowedCommands string array`);
    }
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
      const valid = raw.folderAccess.filter((grant) => isRecord(grant) && typeof grant.path === 'string'
        && (grant.permission === 'read' || grant.permission === 'readwrite'));
      const kept = hostOwned
        ? valid
        : valid.filter((grant) => projectFolderGrantNarrows(context.workspaceRoot, grant.path as string));
      if (!hostOwned && kept.length !== raw.folderAccess.length) {
        validationWarnings.push(`${path}.folderAccess ignored ${raw.folderAccess.length - kept.length} grant(s) that were not proven inside this workspace.`);
      }
      sanitized.folderAccess = kept;
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
      routeRepair,
    } as unknown as AgentConfig;
  }
  const canonicalRouteFields = legacyFieldsForRoute(validRoute, resolver);
  if (hostOwned) {
    // Host-owned does not mean internally inconsistent: a saved backend must still agree with the
    // closed route. The route is authoritative, while non-route host choices remain preserved.
    const hostConfig = { ...sanitized, route: validRoute, ...canonicalRouteFields } as unknown as AgentConfig;
    if (hostConfig.backend === 'codex') {
      hostConfig.codexPermissionProfile = normalizeCodexPermissionProfile(hostConfig.codexPermissionProfile);
    }
    return hostConfig;
  }
  const { backend: _backend, ...projectRouteData } = canonicalRouteFields;
  return { ...sanitized, route: validRoute, ...projectRouteData } as unknown as AgentConfig;
}

function validateHostOwnedAgentFields(raw: Record<string, unknown>, path: string, issues: string[]): void {
  if (raw.autoApprove !== undefined && typeof raw.autoApprove !== 'boolean') {
    issues.push(`${path}.autoApprove must be a boolean`);
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    issues.push(`${path}.env must be an object whose values are strings`);
  }
  if (raw.backend !== undefined && raw.backend !== 'claude' && raw.backend !== 'codex' && raw.backend !== 'openai-compat') {
    issues.push(`${path}.backend must be "claude", "codex", or "openai-compat"`);
  }
  if (raw.baseUrl !== undefined && typeof raw.baseUrl !== 'string') {
    issues.push(`${path}.baseUrl must be a string`);
  }
  if (raw.autoRestart !== undefined && typeof raw.autoRestart !== 'boolean') {
    issues.push(`${path}.autoRestart must be a boolean`);
  }
  for (const field of ['mcpServers', 'playbooks'] as const) {
    if (raw[field] !== undefined && !isStringArray(raw[field])) {
      issues.push(`${path}.${field} must be an array of strings`);
    }
  }
  if (raw.toolProtocol !== undefined && raw.toolProtocol !== 'native' && raw.toolProtocol !== 'xml') {
    issues.push(`${path}.toolProtocol must be "native" or "xml"`);
  }
  if (raw.editToolDialect !== undefined && raw.editToolDialect !== 'apply-edit' && raw.editToolDialect !== 'apply-patch') {
    issues.push(`${path}.editToolDialect must be "apply-edit" or "apply-patch"`);
  }
  if (raw.workingDirectory !== undefined && typeof raw.workingDirectory !== 'string') {
    issues.push(`${path}.workingDirectory must be a string`);
  }
  if (raw.routeRepair !== undefined && typeof raw.routeRepair !== 'string') {
    issues.push(`${path}.routeRepair must be a string`);
  }
  if (raw.skills !== undefined && !Array.isArray(raw.skills)) {
    issues.push(`${path}.skills must be an array`);
  }
}

function validateMcpServer(raw: unknown, path: string, issues: string[]): MCPServerConfig | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  requireString(raw, 'id', path, issues);
  requireString(raw, 'name', path, issues);
  requireString(raw, 'transport', path, issues);
  if (typeof raw.transport === 'string' && !MCP_TRANSPORTS.has(raw.transport)) {
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
  return {
    id: raw.id as string,
    name: raw.name as string,
    transport: raw.transport as MCPServerConfig['transport'],
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(isStringArray(raw.args) ? { args: raw.args } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(isStringRecord(raw.env) ? { env: raw.env } : {}),
    ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
    ...(typeof raw.requiresApproval === 'boolean' ? { requiresApproval: raw.requiresApproval } : {}),
  };
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
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function projectFolderGrantNarrows(workspaceRoot: string | undefined, requestedPath: string): boolean {
  if (!workspaceRoot) return false;
  const requestedAbsolute = pathUtil.resolve(workspaceRoot, requestedPath);
  // Canonicalise the nearest existing ancestor as well as an existing target. This keeps a future
  // in-workspace folder usable while still exposing a symlink ancestor that escapes the workspace.
  const root = canonicalProspectivePath(workspaceRoot);
  const candidate = canonicalProspectivePath(requestedAbsolute);
  const relative = pathUtil.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathUtil.isAbsolute(relative));
}

function canonicalProspectivePath(candidate: string): string {
  const absolute = pathUtil.resolve(candidate);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = pathUtil.dirname(existing);
    if (parent === existing) return absolute;
    suffix.unshift(pathUtil.basename(existing));
    existing = parent;
  }
  return pathUtil.resolve(canonicalExistingPath(existing), ...suffix);
}

function canonicalExistingPath(candidate: string): string {
  const absolute = pathUtil.resolve(candidate);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
