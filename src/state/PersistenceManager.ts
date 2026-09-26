/*---------------------------------------------------------------------------------------------
 *  UnodeAi - PersistenceManager
 *  Persists the team roster (agent configs) and usage stats so the team survives reloads.
 *
 *  Agent CONFIGS live in workspaceState (and optionally a versionable `.unode/team.json`).
 *  API KEYS never go here — they live in SecretStorage (see SecretsManager). The two are joined
 *  at runtime via AgentConfig.provider.apiKeySecretName.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { AgentConfig, MCPServerConfig, Message, WorkflowConfig, WorkflowInstance } from '../types';
import { ConversationSnapshot } from '../backend/AgentBackend';
import { SerializedCheckpoints } from '../backend/Checkpoints';
import { PendingDelegationResult } from './PendingDelegationResults';
import {
  RUN_OWNER_LEASE_MS,
  RunLedger,
  type RunHostIdentity,
  type RunRecord,
} from '../observability/RunLedger';
import { AGENT_CONFIG_FIELDS, clearLegacyImmediateAuthorityFields, TeamFileDocument, TeamFileValidationError, validateTeamFile } from './TeamFileSchema';
import { TeamLibraryEntry, TeamLibraryRef, TeamLibraryScope, isAutomaticSnapshotSlug } from './TeamLibrary';
import { BUILTIN_CONNECTION_REGISTRY, ConnectionResolver, assertRegisteredRoute } from '../routes/ConnectionRegistry';
import {
  assertRepairableCustomRoute,
  exportVersionedAgentConfig,
  migrateAgentConfigOrRepair,
  type VersionedAgentConfig,
} from '../routes/RouteMigration';
import { showResultNotice } from '../resultNotice';
import { approvalKey } from '../mcp/McpApproval';
import { normalizeCodexPermissionProfile } from '../backend/CodexPermissionProfile';

const AGENTS_KEY = 'roam.agents';
const SNAPSHOT_PREFIX = 'roam.snapshot.';
const MESSAGES_KEY = 'roam.messages';
const WORKFLOWS_KEY = 'roam.workflows';
const APPROVED_MCP_KEY = 'unode.approvedMcpServers';
const HOST_MCP_SERVERS_KEY = 'unode.hostMcpServers.v1';
const LEGACY_APPROVED_MCP_KEY = 'roam.approvedMcpServers';
const LEGACY_HOST_MCP_SERVERS_KEY = 'roam.hostMcpServers.v1';
const MCP_STATE_MIGRATION_KEY = 'unode.migration.mcpState.v0_9_81';
const AGENT_AUTHORITY_MIGRATION_KEY = 'unode.migration.projectAgentAuthority.v0_9_81';
const CHECKPOINTS_KEY = 'roam.checkpoints';
const PENDING_DELEGATION_RESULTS_KEY = 'roam.pendingDelegationResults';
const RUNS_KEY = 'roam.runs';
const RUNS_MERGED_KEY = 'roam.runs.merged.v8';
const RUNS_HOST_PREFIX = 'roam.runs.host.';
const WORKSPACE_TEAM_FINGERPRINTS_KEY = 'unode.teamLibrary.workspaceFingerprints.v1';
const MAX_WORKSPACE_TEAM_FINGERPRINTS = 200;

export interface SavedTeamLoadResult {
  /** Always safe to load immediately. Project files have already lost every widening permission. */
  document: TeamFileDocument;
  /** Host-validated declarations used only to populate an explicit permission confirmation/review. */
  permissionSource?: readonly AgentConfig[];
  /** True only for the exact bytes at the exact path previously written by this UnodeAi installation. */
  fingerprintMatched: boolean;
}

interface WorkspaceTeamFingerprintRecord {
  /** SHA-256 of the exact bytes written. */
  sha256: string;
  /** Hashed physical identity prevents an exact copied/cloned file from inheriting the original grant. */
  locationSha256: string;
}

/** True when an error means "the file simply isn't there" — across Node fs and vscode.fs shapes. */
export function isFileNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOENT' || code === 'FileNotFound' || code === 'EntryNotFound') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /\bENOENT\b|FileNotFound|EntryNotFound/i.test(message);
}

export interface PersistedState {
  agents: AgentConfig[];
}

export interface LegacyMcpStateMigration {
  importedApprovedIds: readonly string[];
  ignoredUnapprovedIds: readonly string[];
  renamedLegacyKeys: boolean;
}

export class PersistenceManager {
  private readonly runWriterId?: string;
  private readonly runHost?: RunHostIdentity;
  private readonly workspaceState: vscode.Memento;
  private readonly surfacedTeamFileWarnings = new Set<string>();

  constructor(
    private context: vscode.ExtensionContext,
    private readonly connectionResolver: () => ConnectionResolver = () => BUILTIN_CONNECTION_REGISTRY,
    private readonly hasWorkspace: () => boolean = () => !!vscode.workspace.workspaceFolders?.[0],
    runHost?: RunHostIdentity | string,
    private readonly runOwnerLeaseMs = RUN_OWNER_LEASE_MS,
    workspaceState?: vscode.Memento,
  ) {
    this.runWriterId = typeof runHost === 'string' ? runHost : runHost?.hostInstanceId;
    this.runHost = typeof runHost === 'string' ? undefined : runHost;
    this.workspaceState = workspaceState ?? context.workspaceState;
  }

  loadAgents(): AgentConfig[] {
    if (!this.hasWorkspace()) return [];
    return this.workspaceState.get<AgentConfig[]>(AGENTS_KEY, []).map(normalizeStoredCodexPermission);
  }

  async saveAgents(agents: AgentConfig[]): Promise<void> {
    this.requireWorkspace('saving the team roster');
    const resolver = this.connectionResolver();
    const normalized = normalizePersistedAgents(agents, resolver);
    assertSerializableRoutes(normalized, resolver);
    // Repair explanations are derived from the live local registry on every restore, never trusted
    // from a prior workspaceState write.
    await this.workspaceState.update(AGENTS_KEY, normalized.map(({ routeRepair: _repair, ...agent }) => agent));
  }

  /**
   * v0.9.80 did not record whether workspaceState was authored by the UI or copied from team.json. Remove
   * only the two fields that can execute code or bypass approval without another user decision. Skills,
   * routes, MCP grants, and presentation/runtime preferences are user data and remain intact.
   */
  async migrateLegacyAgentAuthority(): Promise<readonly string[]> {
    if (!this.hasWorkspace() || this.workspaceState.get<boolean>(AGENT_AUTHORITY_MIGRATION_KEY, false)) return [];
    const existing = this.loadAgents();
    const validated = clearLegacyImmediateAuthorityFields(existing);
    if (existing.length > 0) {
      await this.workspaceState.update(AGENTS_KEY, validated.members);
    }
    await this.workspaceState.update(AGENT_AUTHORITY_MIGRATION_KEY, true);
    return validated.validationWarnings ?? [];
  }

  loadHostMcpServers(): MCPServerConfig[] {
    if (!this.hasWorkspace()) return [];
    const value = this.workspaceState.get<unknown>(HOST_MCP_SERVERS_KEY)
      ?? this.workspaceState.get<unknown>(LEGACY_HOST_MCP_SERVERS_KEY, []);
    return Array.isArray(value) ? value as MCPServerConfig[] : [];
  }

  async saveHostMcpServers(servers: MCPServerConfig[]): Promise<void> {
    this.requireWorkspace('saving integration configuration');
    await this.workspaceState.update(HOST_MCP_SERVERS_KEY, servers);
  }

  /**
   * Carry the two MCP workspace-state keys to the UnodeAi namespace and recover only exact legacy
   * team-file launch specs that this workspace already approved. The approval fingerprint is host-owned
   * proof of the user's decision; an edited or never-approved project entry cannot cross this boundary.
   */
  async migrateLegacyMcpState(): Promise<LegacyMcpStateMigration> {
    const empty: LegacyMcpStateMigration = {
      importedApprovedIds: [], ignoredUnapprovedIds: [], renamedLegacyKeys: false,
    };
    if (!this.hasWorkspace() || this.workspaceState.get<boolean>(MCP_STATE_MIGRATION_KEY, false)) return empty;

    const state = this.workspaceState;
    const newApprovals = stringArray(state.get<unknown>(APPROVED_MCP_KEY, []));
    const legacyApprovals = stringArray(state.get<unknown>(LEGACY_APPROVED_MCP_KEY, []));
    const approvals = [...new Set([...newApprovals, ...legacyApprovals])];
    const approvedSet = new Set(approvals);
    const newHostServers = mcpServerArray(state.get<unknown>(HOST_MCP_SERVERS_KEY, []));
    const legacyHostServers = mcpServerArray(state.get<unknown>(LEGACY_HOST_MCP_SERVERS_KEY, []));
    const { approved, ignored } = await this.loadApprovedLegacyTeamMcpServers(approvedSet);
    const merged = new Map<string, MCPServerConfig>();
    // A host-store entry wins over the retired project-file copy with the same id. A current UnodeAi
    // entry wins over the short-lived pre-release Roam-named host key.
    for (const server of [...approved, ...legacyHostServers, ...newHostServers]) merged.set(server.id, server);

    await state.update(APPROVED_MCP_KEY, approvals);
    await state.update(HOST_MCP_SERVERS_KEY, [...merged.values()]);
    await state.update(LEGACY_APPROVED_MCP_KEY, undefined);
    await state.update(LEGACY_HOST_MCP_SERVERS_KEY, undefined);
    await state.update(MCP_STATE_MIGRATION_KEY, true);
    return {
      importedApprovedIds: approved.map((server) => server.id),
      ignoredUnapprovedIds: ignored,
      renamedLegacyKeys: legacyApprovals.length > 0 || legacyHostServers.length > 0,
    };
  }

  private async loadApprovedLegacyTeamMcpServers(
    approvedKeys: ReadonlySet<string>,
  ): Promise<{ approved: MCPServerConfig[]; ignored: string[] }> {
    const folder = this.workspaceFolder();
    if (!folder) return { approved: [], ignored: [] };
    const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
    let parsed: unknown;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      // The normal project-file loader below owns the visible parse/read warning. This compatibility
      // pass stays silent so a malformed file is not reported twice during the same activation.
      return { approved: [], ignored: [] };
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.mcpServers)) return { approved: [], ignored: [] };

    const approved: MCPServerConfig[] = [];
    const ignored: string[] = [];
    for (const [index, raw] of parsed.mcpServers.entries()) {
      const id = isPlainRecord(raw) && typeof raw.id === 'string' && raw.id.trim() ? raw.id : `entry ${index + 1}`;
      try {
        const validated = validateTeamFile(
          { members: [], workflows: [], mcpServers: [raw] },
          this.connectionResolver(),
          { authority: 'host-owned' },
        ).mcpServers[0];
        if (validated && approvedKeys.has(approvalKey(validated, folder.uri.fsPath))) {
          approved.push(validated);
        } else {
          ignored.push(id);
        }
      } catch {
        ignored.push(id);
      }
    }
    return { approved, ignored };
  }

  // ─── Conversation snapshots (L2 crash recovery) ──────────────────────

  loadSnapshot(agentId: string): ConversationSnapshot | undefined {
    if (!this.hasWorkspace()) return undefined;
    return this.workspaceState.get<ConversationSnapshot>(SNAPSHOT_PREFIX + agentId);
  }

  saveSnapshot(agentId: string, snapshot: ConversationSnapshot): void {
    if (!this.hasWorkspace()) return;
    // Fire-and-forget; workspaceState.update returns a Thenable we don't need to await per-turn.
    void this.workspaceState.update(SNAPSHOT_PREFIX + agentId, snapshot);
  }

  clearSnapshot(agentId: string): void {
    if (!this.hasWorkspace()) return;
    void this.workspaceState.update(SNAPSHOT_PREFIX + agentId, undefined);
  }

  // ─── Message history (P1#5) ──────────────────────────────────────────

  loadMessages(): Message[] {
    if (!this.hasWorkspace()) return [];
    return this.workspaceState.get<Message[]>(MESSAGES_KEY, []);
  }

  saveMessages(messages: Message[]): void {
    if (!this.hasWorkspace()) return;
    void this.workspaceState.update(MESSAGES_KEY, messages);
  }

  // ─── Run ledger (v0.9.49) ────────────────────────────────────────────

  /**
   * Deliberately unvalidated storage. `RunLedger` normalizes these values before any consumer can
   * receive a RunRecord; a named shape here would promise that validation already happened.
   */
  async loadRuns(observedAt = new Date().toISOString()): Promise<unknown[]> {
    if (!this.hasWorkspace()) return [];
    const workspaceState = this.workspaceState;
    const hostShards = workspaceState.keys()
      .filter((key) => key.startsWith(RUNS_HOST_PREFIX))
      .map((key) => ({ key, snapshot: workspaceState.get<unknown>(key, []) }));
    const currentShardKey = this.runWriterId ? `${RUNS_HOST_PREFIX}${this.runWriterId}` : undefined;
    // Read this host's shard first. Together with the host-aware merge, that makes this process's
    // live row authoritative even when a stalled observer wrote a terminal copy elsewhere.
    hostShards.sort((left, right) => Number(right.key === currentShardKey) - Number(left.key === currentShardKey));
    const mergedBaseline = workspaceState.get<unknown>(RUNS_MERGED_KEY, []);
    const snapshots = [
      ...hostShards.map(({ snapshot }) => snapshot),
      mergedBaseline,
      // v0.9.79 and older read this key. It remains a read-only migration input so rollback keeps
      // the history that existed before v0.9.80 was installed.
      workspaceState.get<unknown>(RUNS_KEY, []),
    ];
    const ledger = new RunLedger([], { host: this.runHost, ownerLeaseMs: this.runOwnerLeaseMs });
    for (const snapshot of snapshots) {
      if (!Array.isArray(snapshot)) continue;
      ledger.snapshotForPersistence(snapshot);
    }
    const merged = ledger.snapshot();
    await this.consolidateRunShards(merged, mergedBaseline, hostShards, currentShardKey, Date.parse(observedAt));
    return merged;
  }

  async saveRuns(runs: RunRecord[]): Promise<void> {
    if (!this.hasWorkspace()) return;
    // A host-specific key prevents concurrent editor windows from racing one whole-array value. loadRuns()
    // merges every shard by run/delegation identity, so a second window cannot erase the first window's row.
    const key = this.runWriterId ? `${RUNS_HOST_PREFIX}${this.runWriterId}` : RUNS_KEY;
    await this.workspaceState.update(key, runs);
  }

  // ─── Settled delegation results (FA-7 recovery) ────────────────────────

  loadPendingDelegationResults(): PendingDelegationResult[] {
    if (!this.hasWorkspace()) return [];
    const value = this.workspaceState.get<unknown>(PENDING_DELEGATION_RESULTS_KEY, []);
    return Array.isArray(value) ? value.filter(isPendingDelegationResult) : [];
  }

  savePendingDelegationResults(results: PendingDelegationResult[]): Thenable<void> {
    if (!this.hasWorkspace()) return Promise.resolve();
    return this.workspaceState.update(PENDING_DELEGATION_RESULTS_KEY, results);
  }

  // ─── Checkpoints (V1: per-write restore points) ──────────────────────

  loadCheckpoints(): SerializedCheckpoints | undefined {
    if (!this.hasWorkspace()) return undefined;
    return this.workspaceState.get<SerializedCheckpoints>(CHECKPOINTS_KEY);
  }

  saveCheckpoints(data: SerializedCheckpoints): void {
    if (!this.hasWorkspace()) return;
    void this.workspaceState.update(CHECKPOINTS_KEY, data);
  }

  // ─── In-flight workflow instances (L3 recovery, P1#5) ────────────────

  loadWorkflows(): WorkflowInstance[] {
    if (!this.hasWorkspace()) return [];
    return this.workspaceState.get<WorkflowInstance[]>(WORKFLOWS_KEY, []);
  }

  saveWorkflows(instances: WorkflowInstance[]): void {
    if (!this.hasWorkspace()) return;
    void this.workspaceState.update(WORKFLOWS_KEY, instances);
  }

  // ─── Approved (sensitive) MCP servers (P1#4) ─────────────────────────

  loadApprovedMcpServers(): string[] {
    if (!this.hasWorkspace()) return [];
    const value = this.workspaceState.get<unknown>(APPROVED_MCP_KEY)
      ?? this.workspaceState.get<unknown>(LEGACY_APPROVED_MCP_KEY, []);
    return stringArray(value);
  }

  async saveApprovedMcpServers(ids: string[]): Promise<void> {
    this.requireWorkspace('saving integration approvals');
    await this.workspaceState.update(APPROVED_MCP_KEY, ids);
  }

  // ─── Reset (P2: "UnodeAi: Reset Workspace State") ──────────────────

  /**
   * Wipe every value in the current root namespace. The scoped memento's keys() deliberately cannot
   * enumerate another root, so reset cannot erase a sibling project from an editor-reused bucket.
   * Secrets (API keys) are NOT touched here — those live in SecretStorage and are cleared separately.
   */
  async resetWorkspaceState(): Promise<void> {
    this.requireWorkspace('resetting workspace state');
    const ws = this.workspaceState;
    for (const key of ws.keys()) {
      await ws.update(key, undefined);
    }
  }

  private async consolidateRunShards(
    merged: RunRecord[],
    mergedBaseline: unknown,
    hostShards: Array<{ key: string; snapshot: unknown }>,
    currentShardKey: string | undefined,
    observedAtMs: number,
  ): Promise<void> {
    const workspaceState = this.workspaceState;
    // Avoid serializing and rewriting the retained ledger on every five-second active maintenance tick.
    // An identical baseline is already the durable prerequisite for the shard deletions below.
    if (!sameStoredSnapshot(mergedBaseline, merged)) {
      await workspaceState.update(RUNS_MERGED_KEY, merged);
    }
    if (!currentShardKey) return;

    const safeObservedAtMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    for (const shard of hostShards) {
      const isCurrentShard = shard.key === currentShardKey;
      if ((isCurrentShard && runShardHasOwnerHeartbeat(shard.snapshot))
          || !runShardLeaseExpired(shard.snapshot, safeObservedAtMs, this.runOwnerLeaseMs)) {
        continue;
      }
      // The baseline is now byte-identical to the merged view (either pre-existing or just written).
      // Re-read before deletion so a resumed foreign host cannot lose a heartbeat or terminal event.
      const latest = workspaceState.get<unknown>(shard.key, []);
      if (!sameStoredSnapshot(latest, shard.snapshot)
          || (isCurrentShard && runShardHasOwnerHeartbeat(latest))
          || !runShardLeaseExpired(latest, safeObservedAtMs, this.runOwnerLeaseMs)) {
        continue;
      }
      await workspaceState.update(shard.key, undefined);
    }
  }

  /**
   * Delete the versionable team file (<workspace>/.unode/team.json). Part of a full workspace reset:
   * otherwise an empty workspaceState would re-seed the just-cleared roster from this file on reload.
   * Best-effort — silently ignores an absent file or no workspace.
   */
  async deleteTeamFile(): Promise<void> {
    const folder = this.workspaceFolder();
    if (!folder) {
      return;
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Absent or unreadable — nothing to delete.
    }
  }

  /**
   * Best-effort load of a versionable team file at <workspace>/.unode/team.json.
   * Returns undefined if absent or malformed (caller falls back to workspaceState).
   */
  async loadTeamFile(): Promise<AgentConfig[] | undefined> {
    const doc = await this.loadTeamConfig();
    return doc?.members;
  }

  /** Load and validate the full versionable .unode/team.json document. */
  async loadTeamConfig(): Promise<TeamFileDocument | undefined> {
    const folder = this.workspaceFolder();
    if (!folder) {
      return undefined;
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const document = validateTeamFile(parsed, this.connectionResolver(), { workspaceRoot: folder.uri.fsPath });
      if ((document.validationWarnings?.length ?? 0) > 0) {
        const warning = document.validationWarnings!.join('; ');
        if (!this.surfacedTeamFileWarnings.has(warning)) {
          this.surfacedTeamFileWarnings.add(warning);
          void vscode.window.showWarningMessage(`UnodeAi adjusted .unode/team.json: ${warning}`);
        }
      }
      return document;
    } catch (err) {
      this.warnTeamFileIgnored(err);
      return undefined;
    }
  }

  async saveTeamConfig(doc: TeamFileDocument): Promise<void> {
    const folder = this.workspaceFolder();
    if (!folder) {
      throw new Error('Open a workspace before saving .unode/team.json.');
    }
    const dir = vscode.Uri.joinPath(folder.uri, '.unode');
    const uri = vscode.Uri.joinPath(dir, 'team.json');
    await vscode.workspace.fs.createDirectory(dir);
    const normalized: TeamFileDocument = {
      version: doc.version ?? '1.0',
      members: normalizePersistedAgents(doc.members ?? [], this.connectionResolver()),
      mcpServers: [],
      workflows: doc.workflows ?? [],
    };
    assertSerializableRoutes(normalized.members, this.connectionResolver());
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(serializeVersionedTeamFile(normalized, this.connectionResolver()), 'utf8'),
    );
  }

  // ─── Saved teams (.unode/teams/*.json + host-owned global library) ───────
  // Workspace teams use the repository boundary. Global teams live under globalStorageUri and retain the
  // capabilities the user saved; their reader still validates every declared field before restoration.

  private teamsDir(scope: TeamLibraryScope): vscode.Uri | undefined {
    if (scope === 'global') {
      return this.context.globalStorageUri ? vscode.Uri.joinPath(this.context.globalStorageUri, 'teams') : undefined;
    }
    const folder = this.workspaceFolder();
    return folder ? vscode.Uri.joinPath(folder.uri, '.unode', 'teams') : undefined;
  }

  /** Every saved team, newest first. A file that no longer validates is skipped, never silently repaired. */
  async listSavedTeams(): Promise<TeamLibraryEntry[]> {
    const scoped = await Promise.all((['workspace', 'global'] as const).map((scope) => this.listSavedTeamsInScope(scope)));
    return scoped.flat().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private async listSavedTeamsInScope(scope: TeamLibraryScope): Promise<TeamLibraryEntry[]> {
    const dir = this.teamsDir(scope);
    if (!dir) { return []; }
    let names: [string, vscode.FileType][];
    try {
      names = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return []; // no teams saved yet
    }
    const entries: TeamLibraryEntry[] = [];
    const skipped: string[] = [];
    for (const [name, type] of names) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) { continue; }
      const slug = name.slice(0, -'.json'.length);
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
        const document = validateTeamFile(
          parsed,
          this.connectionResolver(),
          scope === 'global'
            ? { authority: 'host-owned' }
            : { workspaceRoot: currentWorkspaceRoot() },
        );
        entries.push({
          scope,
          slug,
          label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label : slug,
          savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
          memberCount: document.members.length,
          ...(scope === 'workspace' && isAutomaticSnapshotSlug(slug) ? { automatic: true } : {}),
        });
      } catch (err) {
        // A saved team that no longer validates is not offered: restoring it would produce a roster the
        // user did not save. But it is not dropped in silence either — the first version of this loop
        // swallowed the reason, so a file that saved fine and then failed to validate presented as "you
        // have no saved teams", with nothing anywhere saying otherwise. The reason is what makes that
        // difference visible.
        skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    if (skipped.length > 0) {
      this.warnSavedTeamsSkipped(skipped);
    }
    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /** Named separately so a test can observe that an unreadable saved team is reported, not swallowed. */
  protected warnSavedTeamsSkipped(reasons: readonly string[]): void {
    void showResultNotice('warning', `${reasons.length} saved team file(s) could not be read and are not offered: ${reasons.join('; ')}`);
  }

  async saveTeamToLibrary(
    ref: TeamLibraryRef,
    label: string,
    members: readonly AgentConfig[],
    savedAt = new Date().toISOString(),
  ): Promise<void> {
    const { scope, slug } = ref;
    if (scope === 'global' && isAutomaticSnapshotSlug(slug)) {
      throw new Error('Automatic team snapshots are always stored in the workspace library.');
    }
    const dir = this.teamsDir(scope);
    if (!dir) {
      throw new Error('Open a workspace before saving a team.');
    }
    const normalized = normalizePersistedAgents([...members], this.connectionResolver());
    assertSerializableRoutes(normalized, this.connectionResolver());
    await vscode.workspace.fs.createDirectory(dir);
    // A saved team is the roster and nothing else. The first version copied the workspace's `mcpServers`
    // and `workflows` in, which was wrong twice over: restoring only ever applies `members`, so they were
    // dead weight the file promised and did not deliver; and a file meant to travel through git to a
    // colleague would have carried this workspace's server command lines with it. Empty here is not a
    // placeholder for later — restoring a team must not silently replace workspace-wide configuration.
    const serialized = scope === 'global'
      ? serializeHostOwnedTeamLibrary({ version: '1.0', members: normalized, mcpServers: [], workflows: [] })
      : serializeWorkspaceTeamLibrary(
          { version: '1.0', members: normalized, mcpServers: [], workflows: [] },
          this.connectionResolver(),
        );
    // label/savedAt ride alongside the validated document: validateTeamFile ignores unknown top-level
    // keys, so the file stays loadable by the same reader that loads team.json.
    const document = { label, savedAt, ...JSON.parse(serialized) as Record<string, unknown> };
    const uri = vscode.Uri.joinPath(dir, `${slug}.json`);
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
    if (scope === 'workspace') {
      await this.rememberWorkspaceTeamFingerprint(workspaceTeamFingerprint(uri.fsPath, bytes));
    }
  }

  async loadSavedTeam(ref: TeamLibraryRef): Promise<TeamFileDocument | undefined> {
    return (await this.loadSavedTeamWithTrust(ref))?.document;
  }

  async loadSavedTeamWithTrust(ref: TeamLibraryRef): Promise<SavedTeamLoadResult | undefined> {
    const dir = this.teamsDir(ref.scope);
    if (!dir) { return undefined; }
    try {
      const uri = vscode.Uri.joinPath(dir, `${ref.slug}.json`);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const document = validateTeamFile(
        parsed,
        this.connectionResolver(),
        ref.scope === 'global'
          ? { authority: 'host-owned' }
          : { workspaceRoot: currentWorkspaceRoot() },
      );
      if (ref.scope === 'global') {
        return { document, permissionSource: document.members, fingerprintMatched: true };
      }
      // Parsing the same bytes as host-owned does not grant anything. It merely gives the UI a typed,
      // validated description of what the file asks to restore; `document` above remains the only roster
      // that may be loaded without a fresh user decision.
      const permissionSource = validateTeamFile(
        parsed,
        this.connectionResolver(),
        { authority: 'host-owned' },
      ).members;
      const fingerprint = workspaceTeamFingerprint(uri.fsPath, bytes);
      const fingerprints = this.context.globalState?.get<unknown>(WORKSPACE_TEAM_FINGERPRINTS_KEY, []);
      return {
        document,
        permissionSource,
        fingerprintMatched: Array.isArray(fingerprints) && fingerprints.some((value) =>
          isWorkspaceTeamFingerprintRecord(value)
          && value.sha256 === fingerprint.sha256
          && value.locationSha256 === fingerprint.locationSha256
        ),
      };
    } catch (err) {
      this.warnTeamFileIgnored(err);
      return undefined;
    }
  }

  private async rememberWorkspaceTeamFingerprint(fingerprint: WorkspaceTeamFingerprintRecord): Promise<void> {
    const state = this.context.globalState;
    if (!state) return;
    const prior = state.get<unknown>(WORKSPACE_TEAM_FINGERPRINTS_KEY, []);
    const values = Array.isArray(prior) ? prior.filter(isWorkspaceTeamFingerprintRecord) : [];
    const next = [fingerprint, ...values.filter((value) =>
      value.sha256 !== fingerprint.sha256 || value.locationSha256 !== fingerprint.locationSha256
    )]
      .slice(0, MAX_WORKSPACE_TEAM_FINGERPRINTS);
    await state.update(WORKSPACE_TEAM_FINGERPRINTS_KEY, next);
  }

  /** A deleted project save must not leave a stale host-owned trust record behind. */
  private async forgetWorkspaceTeamFingerprint(filePath: string): Promise<void> {
    const state = this.context.globalState;
    if (!state) return;
    const prior = state.get<unknown>(WORKSPACE_TEAM_FINGERPRINTS_KEY, []);
    const values = Array.isArray(prior) ? prior.filter(isWorkspaceTeamFingerprintRecord) : [];
    const locationSha256 = workspaceTeamLocationSha256(filePath);
    const next = values.filter((value) => value.locationSha256 !== locationSha256);
    if (next.length !== values.length) {
      await state.update(WORKSPACE_TEAM_FINGERPRINTS_KEY, next);
    }
  }

  async deleteSavedTeam(ref: TeamLibraryRef): Promise<void> {
    const dir = this.teamsDir(ref.scope);
    if (!dir) { return; }
    const uri = vscode.Uri.joinPath(dir, `${ref.slug}.json`);
    try {
      await vscode.workspace.fs.delete(uri);
      if (ref.scope === 'workspace') {
        await this.forgetWorkspaceTeamFingerprint(uri.fsPath);
      }
    } catch (err) {
      if (ref.scope === 'workspace' && isFileNotFound(err)) {
        // A missing file is also no longer a valid saved-team authority. Clear a record left by a manual
        // deletion or an interrupted previous delete so recreating the name can never revive old trust.
        await this.forgetWorkspaceTeamFingerprint(uri.fsPath);
      }
      /* already gone */
    }
  }

  async saveCustomWorkflows(workflows: WorkflowConfig[]): Promise<void> {
    const current = await this.loadTeamConfig();
    await this.saveTeamConfig({
      version: current?.version ?? '1.0',
      members: current?.members ?? this.loadAgents(),
      mcpServers: [],
      workflows,
    });
  }

  /** Host-owned MCP registry. Repository team files cannot populate this process-execution authority. */
  async loadTeamMcpServers(): Promise<MCPServerConfig[]> {
    return this.loadHostMcpServers();
  }

  private warnTeamFileIgnored(err: unknown): void {
    // "File absent" is the normal case (no team.json yet) — never warn. We must cover both error
    // shapes: a Node ErrnoException (code 'ENOENT') and a vscode.FileSystemError, whose code is
    // 'FileNotFound' (or 'Unknown' wrapping a raw ENOENT, in which case only the message carries it).
    if (isFileNotFound(err)) {
      return;
    }
    const message = err instanceof TeamFileValidationError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    void vscode.window.showWarningMessage(`UnodeAi ignored .unode/team.json: ${message}`);
  }

  private requireWorkspace(action: string): void {
    if (!this.hasWorkspace()) {
      throw new Error(`Open a workspace folder and reload the window before ${action}; no project state was written.`);
    }
  }

  private workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.hasWorkspace() ? vscode.workspace.workspaceFolders?.[0] : undefined;
  }
}

function runShardLeaseExpired(snapshot: unknown, observedAtMs: number, ownerLeaseMs: number): boolean {
  if (!Array.isArray(snapshot)) return false;
  if (snapshot.length === 0) return true;
  const newestHeartbeatMs = newestRunShardHeartbeatMs(snapshot);
  // A valid array with no owner heartbeat is a pre-v0.9.80 migration shard. Once its exact bytes
  // are in the baseline it has no live lease to protect and can be collected immediately.
  return newestHeartbeatMs === undefined || observedAtMs - newestHeartbeatMs >= ownerLeaseMs;
}

function runShardHasOwnerHeartbeat(snapshot: unknown): boolean {
  return Array.isArray(snapshot) && newestRunShardHeartbeatMs(snapshot) !== undefined;
}

function newestRunShardHeartbeatMs(snapshot: unknown[]): number | undefined {
  let newestHeartbeatMs: number | undefined;
  for (const run of snapshot) {
    if (!run || typeof run !== 'object' || !Array.isArray((run as { delegations?: unknown }).delegations)) continue;
    for (const delegation of (run as { delegations: unknown[] }).delegations) {
      if (!delegation || typeof delegation !== 'object') continue;
      const owner = (delegation as { owner?: unknown }).owner;
      if (!owner || typeof owner !== 'object') continue;
      const heartbeatAt = (owner as { heartbeatAt?: unknown }).heartbeatAt;
      if (typeof heartbeatAt !== 'string') continue;
      const heartbeatMs = Date.parse(heartbeatAt);
      if (!Number.isFinite(heartbeatMs)) continue;
      newestHeartbeatMs = newestHeartbeatMs === undefined
        ? heartbeatMs
        : Math.max(newestHeartbeatMs, heartbeatMs);
    }
  }
  return newestHeartbeatMs;
}

function sameStoredSnapshot(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    // workspaceState should contain serializable values. If it does not, retain the shard rather than
    // deleting something whose post-merge identity cannot be proved.
    return false;
  }
}

/** Canonical project root for repository-owned team-library validation. */
function currentWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    return realpathSync(folder.uri.fsPath);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mcpServerArray(value: unknown): MCPServerConfig[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is MCPServerConfig => isPlainRecord(entry) && typeof entry.id === 'string')
    : [];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPendingDelegationResult(value: unknown): value is PendingDelegationResult {
  if (!value || typeof value !== 'object') { return false; }
  const entry = value as Record<string, unknown>;
  return typeof entry.coordinatorId === 'string' && entry.coordinatorId.trim().length > 0
    && typeof entry.handle === 'string' && entry.handle.trim().length > 0
    && typeof entry.ref === 'string' && entry.ref.trim().length > 0
    && typeof entry.text === 'string' && entry.text.length > 0;
}

/** WorkspaceState and team.json both persist plain objects; validate optional E0 routes before either sink. */
function assertSerializableRoutes(
  agents: readonly AgentConfig[],
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): void {
  for (const agent of agents) {
    if (agent.route !== undefined) {
      if (agent.routeRepair) {
        assertRepairableCustomRoute(agent.route);
      } else {
        assertRegisteredRoute(agent.route, resolver);
      }
    }
  }
}

/** All new persistence emits routeVersion: 1; a conflicting legacy record fails visibly rather than guessing. */
function normalizePersistedAgents(
  agents: readonly AgentConfig[],
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentConfig[] {
  return agents.map((agent) => normalizeStoredCodexPermission(migrateAgentConfigOrRepair(agent, resolver).config));
}

function normalizeStoredCodexPermission(agent: AgentConfig): AgentConfig {
  return agent.backend === 'codex'
    ? { ...agent, codexPermissionProfile: normalizeCodexPermissionProfile(agent.codexPermissionProfile) }
    : agent;
}

/** New versionable exports have one connection/model authority: `route`. */
/**
 * Write only fields this file's own reader accepts.
 *
 * `AgentConfig` objects in memory can carry more than the interface declares — `RoleTemplateBuilder`
 * spread whole role templates into them, so every agent created from a template arrived with
 * `modelRationale` and `modelOverride` attached. Spreading that straight to disk produced a file
 * `validateTeamFile` then rejected as containing unsupported fields: the writer and the reader disagreed
 * about the same format, and the roster survived only because it also lives in workspace state.
 *
 * Filtering here makes the two agree by construction. A stray runtime field is dropped at the boundary
 * instead of poisoning a file, whatever future code attaches it.
 */
function persistableAgentFields(config: VersionedAgentConfig): VersionedAgentConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([field]) => AGENT_CONFIG_FIELDS.has(field)),
  ) as VersionedAgentConfig;
}

export function serializeVersionedTeamFile(
  doc: TeamFileDocument,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string {
  const { validationWarnings: _validationWarnings, ...persisted } = doc;
  return `${JSON.stringify({
    ...persisted,
    mcpServers: [],
    members: persisted.members.map((member) => persistableAgentFields(exportVersionedAgentConfig(member, resolver))),
  }, null, 2)}\n`;
}

/**
 * A project-library save carries permission declarations so the Agent Builder can show an exact restore
 * preview. They are deliberately not part of the ordinary versionable team writer and the project-file
 * validator still strips them. Only an explicit host-side decision can turn these declarations into grants.
 */
function serializeWorkspaceTeamLibrary(
  doc: TeamFileDocument,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string {
  const base = JSON.parse(serializeVersionedTeamFile(doc, resolver)) as TeamFileDocument;
  return `${JSON.stringify({
    ...base,
    members: base.members.map((member, index) => {
      const source = doc.members[index];
      return {
        ...member,
        ...(source.skills ? { skills: source.skills } : {}),
        ...(source.playbooks ? { playbooks: source.playbooks } : {}),
        ...(source.allowedTools ? { allowedTools: source.allowedTools } : {}),
      };
    }),
  }, null, 2)}\n`;
}

/** Bind the exact bytes to their physical save path so a copied/cloned repository never inherits trust. */
function workspaceTeamFingerprint(filePath: string, bytes: Uint8Array): WorkspaceTeamFingerprintRecord {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    locationSha256: workspaceTeamLocationSha256(filePath),
  };
}

function workspaceTeamLocationSha256(filePath: string): string {
  let canonical = path.resolve(filePath);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // In-memory/test file systems and a just-created virtual provider may not have a Node-visible path.
  }
  if (process.platform === 'win32') canonical = canonical.toLocaleLowerCase('en-US');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function isWorkspaceTeamFingerprintRecord(value: unknown): value is WorkspaceTeamFingerprintRecord {
  return !!value && typeof value === 'object'
    && typeof (value as WorkspaceTeamFingerprintRecord).sha256 === 'string'
    && typeof (value as WorkspaceTeamFingerprintRecord).locationSha256 === 'string';
}

/** Global Team Library is host-owned user state, so it preserves the complete validated AgentConfig. */
function serializeHostOwnedTeamLibrary(doc: TeamFileDocument): string {
  const { validationWarnings: _validationWarnings, ...persisted } = doc;
  return `${JSON.stringify(persisted, null, 2)}\n`;
}
