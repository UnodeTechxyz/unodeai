import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';

/**
 * The closed classification list. Locations come from the host's actual stores and CLI launch;
 * no .claude, CODEX_HOME, storage or settings directory is protected as an undifferentiated tree.
 * This classifier is for model-mediated effects, never routine host/CLI persistence.
 */
export const SECURITY_CONTROL_ARTIFACTS = {
  'user-settings': { format: 'jsonc', keys: [
    'unode.autonomy',
    'unode.allowedCommands', 'unode.commandApproval', 'unode.writeApproval',
    'unode.allowCrossProviderDispatchWithoutApproval', 'unode.verifyCommand',
    'unode.additionalRoots', 'unode.localReadScope', 'unode.baseUrl', 'unode.unodeBaseUrl',
    'unode.webAccess', 'unode.claudeCliPath', 'unode.codexCliPath',
    'unode.marketplace.catalogUrl', 'unode.marketplace.fetchCatalog', 'unode.marketplace.skillLibraryUrl',
    'unode.gate.enabled', 'unode.gate.maxSelfRetries', 'unode.gate.maxRedelegations',
    'unode.engine.verifyObligation', 'unode.worktree.autoMerge', 'unode.worktree.verifyBeforeMerge',
    'unode.worktree.verifyTimeoutSeconds', 'unode.requestLimits.providerTurns', 'unode.requestLimits.tokens',
  ] },
  'global-state': { format: 'json', keys: [
    'unode.autonomy.fullAccessDefault.v1',
    'unode.egressConsentHosts', 'unode.codexEgressConsentHosts.v1', 'unode.egressConsentDeclines.v1',
    'unode.mediaEgressConsent', 'unode.metadataConsentHosts', 'unode.cliRunAnyway.v1',
  ] },
  'workspace-state': { format: 'json', keys: [
    'roam.agents', 'unode.projectCommandApprovals.v1', 'unode.projectCommandApprovals.v2',
    'unode.approvedMcpServers', 'unode.hostMcpServers.v1', 'roam.approvedMcpServers',
    'roam.hostMcpServers.v1', 'unode.executionHooks.approval.v1', 'unode.repositoryCliTrust.v1',
    'unode.teamLibrary.workspaceFingerprints.v1',
  ] },
  'gateway-profiles': { format: 'json', keys: ['profiles', 'operation'] },
  'saved-global-team': { format: 'json', keys: ['members'] },
  'claude-gate-settings': { format: 'raw' },
  'claude-gate-wrapper': { format: 'raw' },
  'claude-mcp-config': { format: 'raw' },
  'codex-config': { format: 'raw' },
  'codex-auth': { format: 'raw' },
} as const;

export type SecurityControlArtifactKind = keyof typeof SECURITY_CONTROL_ARTIFACTS;

export interface SecurityControlArtifactLocation {
  readonly kind: SecurityControlArtifactKind;
  /** Individual actual host-owned file, not a directory or a model-supplied location. */
  readonly path: string;
  /** VS Code state.vscdb is mixed binary data; raw mediated replacement cannot be separated by key. */
  readonly binaryState?: boolean;
}

export interface ClassifiedSecurityControlChange {
  readonly kind: SecurityControlArtifactKind;
  /** Host-private physical effect target; never a log/ledger field. */
  readonly physicalPath: string;
  readonly changed: boolean;
  readonly comparison: 'fields' | 'raw';
}

export type SecurityControlFileEffect = 'write' | 'replace' | 'remove';

/**
 * Compare the named effect target to the finite host list by real path. A new file is resolved
 * through its nearest existing parent. A move/rename must classify BOTH source removal and destination
 * replacement. `write` modifies an existing referent in place; `replace` replaces the named entry;
 * `remove` removes that entry. Callers must describe the actual operation, including atomic saves.
 * No file content is read; only physical-path/file-identity metadata is inspected.
 * Authority and identity must still be revalidated by the shared writer after any approval wait.
 */
export async function classifySecurityControlFileChange(
  target: string,
  before: string | undefined,
  after: string | undefined,
  locations: readonly SecurityControlArtifactLocation[],
  effect: SecurityControlFileEffect,
): Promise<ClassifiedSecurityControlChange | undefined> {
  const followsFinalLink = effect === 'write';
  const physicalPath = await physicalEffectPath(target, followsFinalLink);
  for (const location of locations) {
    const configuredName = await physicalEffectPath(location.path, false);
    const referent = await physicalEffectPath(location.path);
    if (!samePath(physicalPath, configuredName) && !samePath(physicalPath, referent)
      && !(effect === 'write' && await sameExistingFile(physicalPath, referent))) continue;
    const definition = SECURITY_CONTROL_ARTIFACTS[location.kind];
    const parsedBefore = parseDocument(before, definition.format);
    const parsedAfter = parseDocument(after, definition.format);
    const fields = definition.format !== 'raw' && !location.binaryState && parsedBefore.ok && parsedAfter.ok;
    return {
      kind: location.kind, physicalPath,
      changed: fields
        ? securityControlValueChanged(location.kind, parsedBefore.value, parsedAfter.value)
        : before !== after,
      comparison: fields ? 'fields' : 'raw',
    };
  }
  return undefined;
}

async function sameExistingFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    return a.isFile() && b.isFile() && a.ino > 0n && b.ino > 0n && a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Compare actual deserialized host records without interrupting harmless fields in a mixed store. */
export function securityControlValueChanged(kind: SecurityControlArtifactKind, before: unknown, after: unknown): boolean {
  return !isDeepStrictEqual(authorityProjection(kind, before), authorityProjection(kind, after));
}

function authorityProjection(kind: SecurityControlArtifactKind, value: unknown): unknown {
  const definition = SECURITY_CONTROL_ARTIFACTS[kind];
  if (value === undefined) return 'keys' in definition ? {} : undefined;
  if (!('keys' in definition) || !record(value)) return value;
  const projected = select(value, definition.keys);
  if (kind === 'workspace-state' && 'roam.agents' in projected) projected['roam.agents'] = agents(projected['roam.agents']);
  if (kind === 'saved-global-team' && 'members' in projected) projected.members = agents(projected.members);
  if (kind === 'gateway-profiles') {
    if (Array.isArray(projected.profiles)) projected.profiles = byIdentity(projected.profiles.map((profile) => record(profile)
      ? select(profile, ['connectionId', 'state', 'endpointBase', 'secretRef', 'billingKind']) : profile), 'connectionId');
    // An in-progress key/endpoint/lifecycle transaction is authority-bearing; normal revision bumps are not.
  }
  return projected;
}

function agents(value: unknown): unknown {
  return Array.isArray(value) ? byIdentity(value.map((agent) => {
    if (!record(agent)) return agent;
    const projected = select(agent, [
      'id', 'autoApprove', 'autonomyMode', 'codexPermissionProfile', 'allowedTools', 'toolCeiling', 'executePreference',
      'folderAccess', 'commandNarrowing', 'disableNativeSubagents', 'mcpServers', 'backend', 'baseUrl',
      'env', 'workingDirectory',
    ]);
    if (record(agent.provider)) projected.provider = select(agent.provider, ['providerId', 'apiKeySecretName']);
    if (record(agent.route)) projected.route = select(agent.route, ['routeVersion', 'kind', 'connectionId']);
    // Skills can supply executable tools or MCP grants. Their prose/name changes are ordinary work.
    if (Array.isArray(agent.skills)) projected.skills = agent.skills.map((skill) => record(skill)
      ? select(skill, ['implementation']) : skill);
    return projected;
  }), 'id') : value;
}

/** These stores resolve agents/profiles by stable identity, not array position. Malformed duplicates stay raw. */
function byIdentity(values: unknown[], key: string): unknown[] {
  const identities = values.map((value) => record(value) ? value[key] : undefined);
  if (identities.some((id) => typeof id !== 'string' || id.length === 0) || new Set(identities).size !== values.length) return values;
  return [...values].sort((a, b) => {
    const left = (a as Record<string, string>)[key];
    const right = (b as Record<string, string>)[key];
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function select(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key];
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDocument(text: string | undefined, format: 'json' | 'jsonc' | 'raw'): { ok: boolean; value?: unknown } {
  if (text === undefined) return { ok: true };
  if (format === 'raw') return { ok: false };
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { disallowComments: format === 'json', allowTrailingComma: format === 'jsonc' });
  return { ok: errors.length === 0 && record(value), value };
}

async function physicalEffectPath(target: string, followsFinalLink = true): Promise<string> {
  if (!followsFinalLink) return path.join(await physicalEffectPath(path.dirname(path.resolve(target))), path.basename(target));
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
