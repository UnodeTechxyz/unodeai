/*---------------------------------------------------------------------------------------------
 *  UnodeAi - PersistenceManager
 *  Persists the team roster (agent configs) and usage stats so the team survives reloads.
 *
 *  Agent CONFIGS live in workspaceState (and optionally a versionable `.unode/team.json`).
 *  API KEYS never go here — they live in SecretStorage (see SecretsManager). The two are joined
 *  at runtime via AgentConfig.provider.apiKeySecretName.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ResultRecoveryStatus } from './ResultBodyRecovery';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentConfig, MCPServerConfig, Message, WorkflowConfig, WorkflowInstance } from '../types';
import { ConversationSnapshot } from '../backend/AgentBackend';
import { SerializedCheckpoints } from '../backend/Checkpoints';
import { PendingDelegationResult } from './PendingDelegationResults';
import { RESULT_MAILBOX_LIMITS, resultMailboxKey, type ResultMailboxEntry, type ResultArchiveReceipt } from './DelegationResultMailbox';
import type { DelegationResultBodyStore } from './DelegationResultBodyStore';
import { RESULT_MAILBOX_INDEX_KEY, resultMailboxItemKey, parseResultMailboxIndex, parseResultMailboxMetadata,
  resultMailboxMetadata, type ResultMailboxMetadata } from './ResultMailboxMetadata';
import {
  RUN_OWNER_LEASE_MS,
  RunLedger,
  type RunHostIdentity,
  type RunRecord,
} from '../observability/RunLedger';
import { AGENT_CONFIG_FIELDS, clearLegacyImmediateAuthorityFields, completionVerificationFields, TeamFileDocument, TeamFileValidationError, TeamVerificationConfigurationError, validateTeamFile } from './TeamFileSchema';
import type { SmartCompactionProfileOverrides } from '../compaction/SmartCompactionPolicy';
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
import { activeDocumentForSavedTeam } from './TeamRosterRestore';

const AGENTS_KEY = 'roam.agents';
const SNAPSHOT_PREFIX = 'roam.snapshot.';
const RUNTIME_PIN_PREFIX = 'unode.runtimePin.v1.';
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
  /** Ephemeral direct-operation target check, not a persistent team identity or verification binding. */
  sourceVersion?: string;
}

export class TeamReplacementRecoveryError extends Error {
  constructor() { super('The team switch could not be completed. UnodeAi will reload the current team file; other work can continue.'); }
}

export interface SavedTeamReplacement {
  currentMembers(): AgentConfig[];
  assertCurrent(): void;
  snapshotOutgoing(document: TeamFileDocument | undefined): Promise<boolean>;
  stopAndPrepare(): Promise<void>;
  /** Only for incoming publication, never required to restore the original roster during recovery. */
  beforeIncomingPublish?: () => Promise<void>;
  publish(members: AgentConfig[]): Promise<void>;
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

/** Startup can restore host-owned agents without treating an invalid policy as missing configuration. */
export type StartupTeamConfig =
  | { kind: 'ready'; document: TeamFileDocument | undefined }
  | { kind: 'configuration-invalid'; error: TeamVerificationConfigurationError };

export interface LegacyMcpStateMigration {
  importedApprovedIds: readonly string[];
  ignoredUnapprovedIds: readonly string[];
  renamedLegacyKeys: boolean;
}

export class PersistenceManager {
  /** Display-only live status; not a second result index, permission or persisted body. */
  private resultRecoveryStatus?: ResultRecoveryStatus;
  setResultRecoveryStatus(status: ResultRecoveryStatus): void { this.resultRecoveryStatus = { ...status }; }
  getResultRecoveryStatus(): ResultRecoveryStatus | undefined {
    return this.resultRecoveryStatus ? { ...this.resultRecoveryStatus } : undefined;
  }
  private readonly runWriterId?: string;
  private readonly runHost?: RunHostIdentity;
  private readonly workspaceState: vscode.Memento;
  private readonly surfacedTeamFileWarnings = new Set<string>();
  private teamConfigurationTail: Promise<void> = Promise.resolve();
  private resultMailboxTail: Promise<unknown> = Promise.resolve();
  /**
   * v0.9.99: the project root this window's project state belongs to. The host passes the activation-time root
   * (FirstWorkspaceBinding), so a later change or reorder of the editor's first folder never moves a team file,
   * a saved team or a verification policy read into another project. Without a provider, the first folder seen
   * when this manager first needs one is kept; it is never followed afterwards.
   */
  private readonly boundWorkspaceRoot: () => string | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private readonly connectionResolver: () => ConnectionResolver = () => BUILTIN_CONNECTION_REGISTRY,
    workspaceRoot?: () => string | undefined,
    runHost?: RunHostIdentity | string,
    private readonly runOwnerLeaseMs = RUN_OWNER_LEASE_MS,
    workspaceState?: vscode.Memento,
  ) {
    this.runWriterId = typeof runHost === 'string' ? runHost : runHost?.hostInstanceId;
    this.runHost = typeof runHost === 'string' ? undefined : runHost;
    this.workspaceState = workspaceState ?? context.workspaceState;
    let firstSeen: { root: string | undefined } | undefined;
    this.boundWorkspaceRoot = workspaceRoot
      ?? (() => (firstSeen ??= { root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }).root);
  }

  private hasWorkspace(): boolean {
    return this.boundWorkspaceRoot() !== undefined;
  }

  loadAgents(): AgentConfig[] {
    if (!this.hasWorkspace()) return structuredClone(this.windowOnlyAgents).map(normalizeStoredCodexPermission);
    return this.workspaceState.get<AgentConfig[]>(AGENTS_KEY, []).map(normalizeStoredCodexPermission);
  }

  async saveAgents(agents: AgentConfig[]): Promise<void> {
    const captured = structuredClone(agents);
    await this.queueTeamConfiguration(() => this.saveAgentsNow(captured));
  }

  private async saveAgentsNow(agents: AgentConfig[]): Promise<void> {
    const resolver = this.connectionResolver();
    const normalized = normalizePersistedAgents(agents, resolver);
    assertSerializableRoutes(normalized, resolver);
    if (!this.hasWorkspace()) {
      // v0.9.99: a window without a folder keeps its team in memory, for this window only, instead of refusing to
      // save it. The same checks apply; nothing is written to any project.
      this.windowOnlyAgents = normalized.map(({ routeRepair: _repair, ...agent }) => agent);
      return;
    }
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

  /** v0.9.99: the team of a window without a folder, kept in memory for this window only. */
  private windowOnlyAgents: AgentConfig[] = [];

  loadSnapshot(agentId: string): ConversationSnapshot | undefined {
    if (!this.hasWorkspace()) return undefined;
    return this.workspaceState.get<ConversationSnapshot>(SNAPSHOT_PREFIX + agentId);
  }

  saveSnapshot(agentId: string, snapshot: ConversationSnapshot): PromiseLike<void> | undefined {
    if (!this.hasWorkspace()) return undefined;
    // Per-turn saves ignore the returned Thenable; a compaction awaits it before its receipt appears (v0.9.90).
    return this.workspaceState.update(SNAPSHOT_PREFIX + agentId, snapshot);
  }

  clearSnapshot(agentId: string): PromiseLike<void> | undefined {
    if (!this.hasWorkspace()) return undefined;
    // v0.9.94: returned, not dropped. The session orders a clear with the saves of the same agent and waits for
    // it before it starts a backend that must not see what was stored.
    return this.workspaceState.update(SNAPSHOT_PREFIX + agentId, undefined);
  }

  // ─── CLI program pins (v0.9.97) ──────────────────────────────────────

  /**
   * The CLI program an agent's session is pinned to, kept with the agent's record in this workspace. Read as stored;
   * the resolver parses it and refuses what it cannot read.
   */
  loadRuntimePin(agentId: string): unknown {
    if (!this.hasWorkspace()) return undefined;
    return this.workspaceState.get<unknown>(RUNTIME_PIN_PREFIX + agentId);
  }

  /** Saved before the program starts; a failure refuses that start. Without a workspace there is nowhere to keep it. */
  async saveRuntimePin(agentId: string, pin: unknown): Promise<void> {
    this.requireWorkspace('saving which CLI program an agent uses');
    await this.workspaceState.update(RUNTIME_PIN_PREFIX + agentId, pin);
  }

  /** Cleared when the agent is removed. */
  clearRuntimePin(agentId: string): PromiseLike<void> | undefined {
    if (!this.hasWorkspace()) return undefined;
    return this.workspaceState.update(RUNTIME_PIN_PREFIX + agentId, undefined);
  }

  // ─── Message history (P1#5) ──────────────────────────────────────────

  loadMessages(): Message[] {
    if (!this.hasWorkspace()) return [];
    return this.workspaceState.get<Message[]>(MESSAGES_KEY, []);
  }

  saveMessages(messages: Message[]): PromiseLike<void> | undefined {
    if (!this.hasWorkspace()) return;
    return this.workspaceState.update(MESSAGES_KEY, messages);
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
    const captured = structuredClone(results);
    return this.queueResultMailbox(async () => {
      if (this.hasWorkspace()) await this.workspaceState.update(PENDING_DELEGATION_RESULTS_KEY, captured);
    });
  }

  /** T2b prepared persistence port; production dispatch/delivery activation is a separately audited slice.
   * A corrupt index is unavailable, not an empty queue authorizing replacement. */
  loadResultMailboxIndex(): string[] | undefined {
    return this.hasWorkspace() ? parseResultMailboxIndex(this.workspaceState.get(RESULT_MAILBOX_INDEX_KEY)) : undefined;
  }

  /** Body is verified before either small metadata write. A resolved Memento update is NOT an fsync receipt.
   * Optional recovery failure returns no acknowledgement; it is never a condition for task dispatch. */
  saveResultMailboxEntry(entry: ResultMailboxEntry, bodies: DelegationResultBodyStore,
    assertCurrent: () => void): Promise<ResultMailboxMetadata | undefined> {
    const captured = structuredClone(entry);
    return this.queueResultMailbox(async () => {
      try {
        assertCurrent(); if (!this.hasWorkspace()) return undefined;
        const keys = this.loadResultMailboxIndex(); if (!keys) return undefined;
        const key = resultMailboxKey(captured.coordinatorId, captured.ref);
        if (!keys.includes(key) && keys.length >= RESULT_MAILBOX_LIMITS.slots) return undefined;
        const rawPrevious = this.workspaceState.get(resultMailboxItemKey(key));
        const previous = rawPrevious === undefined ? undefined : parseResultMailboxMetadata(rawPrevious);
        if (rawPrevious !== undefined && !previous) return undefined;
        if (previous && (previous.attemptId !== captured.attemptId || previous.settledEventId !== captured.settledEventId)) return undefined;
        const file = captured.body ? await bodies.write(key, captured.body.text) : undefined;
        assertCurrent();
        const metadata = resultMailboxMetadata(captured, file); if (!metadata) return undefined;
        if (previous?.body && (previous.body.file.sha256 !== metadata.body?.file.sha256
          || previous.body.sourceDigest !== metadata.body?.sourceDigest || previous.state !== metadata.state)) return undefined;
        if (previous?.delivery === 'delivered') {
          metadata.delivery = 'delivered'; metadata.deliveredVia = previous.deliveredVia;
        }
        if (previous?.conflict) metadata.conflict = true;
        if (previous?.deliveryAttempted) metadata.deliveryAttempted = true;
        const normalized = parseResultMailboxMetadata(metadata); if (!normalized) return undefined;
        await this.workspaceState.update(resultMailboxItemKey(key), normalized); assertCurrent();
        await this.workspaceState.update(RESULT_MAILBOX_INDEX_KEY, keys.includes(key) ? keys : [...keys, key]);
        assertCurrent(); return structuredClone(normalized);
      } catch { return undefined; }
    });
  }

  /** This is recovery data only. Its consumer must reconcile ledger ownership and conversation delivery markers
   * before using delivery state; loading an index must never schedule a wake or resume a worker. */
  async readResultMailboxEntry(key: string, bodies: DelegationResultBodyStore,
    assertCurrent: () => void): Promise<ResultMailboxEntry | undefined> {
    try {
      assertCurrent(); const keys = this.loadResultMailboxIndex(); if (!keys?.includes(key)) return undefined;
      const metadata = parseResultMailboxMetadata(this.workspaceState.get(resultMailboxItemKey(key)));
      if (!metadata || metadata.key !== key) return undefined;
      const { key: _key, body, ...entry } = metadata;
      if (!body) return entry;
      const text = await bodies.read(body.file); assertCurrent();
      // Another host-owned save/discard during the read invalidates this snapshot, not the retained file.
      if (!this.loadResultMailboxIndex()?.includes(key)
        || !isDeepStrictEqual(metadata, parseResultMailboxMetadata(this.workspaceState.get(resultMailboxItemKey(key))))) return undefined;
      const { file: _file, ...bodyMetadata } = body;
      return { ...entry, body: { ...bodyMetadata, text } };
    } catch { return undefined; }
  }

  /** Existing kernel calls this only after its archive/lifecycle port supplies the exact conversation receipt.
   * Remove active metadata, NEVER the body file: Memento acknowledgement does not establish durable archival. */
  archiveResultMailboxEntry(key: string, receipt: ResultArchiveReceipt | undefined,
    assertCurrent: () => void): Promise<boolean> {
    return this.queueResultMailbox(async () => {
      try {
        assertCurrent(); const keys = this.loadResultMailboxIndex(); if (!keys?.includes(key)) return false;
        const metadata = parseResultMailboxMetadata(this.workspaceState.get(resultMailboxItemKey(key)));
        if (!metadata || !receipt || receipt.coordinatorId !== metadata.coordinatorId
          || receipt.ref.handle !== metadata.ref.handle || receipt.ref.revision !== metadata.ref.revision) return false;
        if (metadata.body && (!receipt.location?.conversationId || !receipt.location.messageId
          || receipt.sourceDigest !== metadata.body.sourceDigest
          || metadata.body.location !== undefined && !isDeepStrictEqual(metadata.body.location, receipt.location))) return false;
        await this.workspaceState.update(RESULT_MAILBOX_INDEX_KEY, keys.filter(candidate => candidate !== key)); assertCurrent();
        await this.workspaceState.update(resultMailboxItemKey(key), undefined); assertCurrent();
        return true;
      } catch { return false; }
    });
  }

  /** Never invent a revision/completion identity for legacy prose. The existing ledger must prove each mapping.
   * Partial migration retains the entire source; retry reuses the same immutable bodies and item keys. */
  async migratePendingResultMailbox(bodies: DelegationResultBodyStore,
    prove: (legacy: PendingDelegationResult) => ResultMailboxEntry | undefined,
    assertCurrent: () => void): Promise<{ migrated: number; retired: boolean }> {
    let migrated = 0;
    try {
      assertCurrent(); if (!this.hasWorkspace()) return { migrated, retired: false };
      const source = structuredClone(this.workspaceState.get<unknown>(PENDING_DELEGATION_RESULTS_KEY));
      if (source === undefined) return { migrated, retired: true };
      if (!Array.isArray(source) || source.length > RESULT_MAILBOX_LIMITS.slots || !source.every(isPendingDelegationResult)) return { migrated, retired: false };
      for (const legacy of source) {
        assertCurrent(); const entry = prove(structuredClone(legacy));
        if (!entry || entry.coordinatorId !== legacy.coordinatorId || entry.ref.handle !== legacy.handle
          || !entry.body || entry.body.sourceDigest !== createHash('sha256').update(legacy.text, 'utf8').digest('hex')) return { migrated, retired: false };
        if (!await this.saveResultMailboxEntry(entry, bodies, assertCurrent)) return { migrated, retired: false };
        migrated++;
      }
      return await this.queueResultMailbox(async () => {
        assertCurrent();
        if (!isDeepStrictEqual(source, this.workspaceState.get(PENDING_DELEGATION_RESULTS_KEY))) return { migrated, retired: false };
        await this.workspaceState.update(PENDING_DELEGATION_RESULTS_KEY, undefined); assertCurrent();
        return { migrated, retired: true };
      });
    } catch { return { migrated, retired: false }; }
  }

  private queueResultMailbox<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.resultMailboxTail.then(operation);
    this.resultMailboxTail = pending.catch(() => undefined); return pending;
  }

  /** Keep the existing bounded metadata item as cleanup-pending, without rewriting or deleting its body. */
  retireArchivedResult(key: string, owner: string, assertCurrent: () => void): Promise<boolean> {
    return this.queueResultMailbox(async () => {
      assertCurrent(); const keys = this.loadResultMailboxIndex();
      const previous = parseResultMailboxMetadata(this.workspaceState.get(resultMailboxItemKey(key)));
      if (!keys?.includes(key) || !previous?.body || previous.conflict) return false;
      const archived = parseResultMailboxMetadata({ ...previous, archiveOwner: owner }); if (!archived) return false;
      await this.workspaceState.update(resultMailboxItemKey(key), archived); assertCurrent();
      await this.workspaceState.update(RESULT_MAILBOX_INDEX_KEY, keys.filter(value => value !== key)); assertCurrent(); return true;
    });
  }

  archivedResultBodies(): ResultMailboxMetadata[] {
    const keys = this.loadResultMailboxIndex(); if (!keys) return [];
    return this.workspaceState.keys().filter(key => key.startsWith('unode.pendingDelegationResult.v2:')).flatMap(key => {
      const item = parseResultMailboxMetadata(this.workspaceState.get(key));
      return item?.archiveOwner && item.body && !keys.includes(item.key) ? [item] : [];
    }).slice(0, RESULT_MAILBOX_LIMITS.slots);
  }

  forgetReclaimedResult(key: string, assertCurrent: () => void): Promise<void> {
    return this.queueResultMailbox(async () => {
      assertCurrent(); if (this.loadResultMailboxIndex()?.includes(key)) return;
      const item = parseResultMailboxMetadata(this.workspaceState.get(resultMailboxItemKey(key)));
      if (item?.archiveOwner) { await this.workspaceState.update(resultMailboxItemKey(key), undefined); assertCurrent(); }
    });
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
    if (!this.workspaceFolder()) return;
    await this.serializeTeamConfiguration(async (folder, assertCurrent) => {
      assertCurrent();
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, '.unode', 'team.json'));
      } catch (error) {
        if ((error as { code?: string }).code !== 'FileNotFound') throw error;
      }
      assertCurrent();
    });
  }

  /** Editor seed shares the configuration queue; unreadable/invalid files are never replaced as absence. */
  async ensureTeamFile(): Promise<void> {
    await this.serializeTeamConfiguration(async (folder, assertCurrent) => {
      try {
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.unode', 'team.json'));
        assertCurrent();
        return; // Existing malformed files must still be openable for repair.
      } catch (error) {
        if ((error as { code?: string }).code !== 'FileNotFound') throw error;
      }
      assertCurrent();
      await this.writeTeamConfig(folder, Buffer.from(serializeVersionedTeamFile({
        version: '1.0', members: [], mcpServers: [], workflows: [],
      }, this.connectionResolver())), assertCurrent);
    });
  }

  /**
   * Best-effort load of a versionable team file at <workspace>/.unode/team.json.
   * Returns undefined if absent or malformed. An invalid verification policy is surfaced instead of
   * allowing a caller to mistake it for absence and regain a legacy command.
   */
  async loadTeamFile(): Promise<AgentConfig[] | undefined> {
    const doc = await this.loadTeamConfig();
    return doc?.members;
  }

  /** Load and validate the full versionable .unode/team.json document. */
  async loadTeamConfig(options?: { strict: boolean }): Promise<TeamFileDocument | undefined> {
    return this.queueTeamConfiguration(() => this.readTeamConfig(options));
  }

  private async readTeamConfig(options?: { strict: boolean }): Promise<TeamFileDocument | undefined> {
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
      if (err instanceof TeamVerificationConfigurationError) {
        const invalidVerificationWarning = 'completionVerification is invalid in .unode/team.json. The team file was not changed. '
          + 'Startup will use the saved workspace roster, if any. Fix this field before saving the team.';
        if (!this.surfacedTeamFileWarnings.has(invalidVerificationWarning)) {
          this.surfacedTeamFileWarnings.add(invalidVerificationWarning);
          void vscode.window.showWarningMessage(invalidVerificationWarning);
        }
        throw err;
      }
      if (options?.strict && (err as { code?: string } | null)?.code !== 'FileNotFound'
        && (err as { code?: string } | null)?.code !== 'ENOENT') throw err;
      this.warnTeamFileIgnored(err);
      return undefined;
    }
  }

  /**
   * Only startup uses this recovery read. Writers and future verification admission still use the strict read
   * above; configuration-invalid must not become undefined and regain a legacy verification policy.
   */
  async loadTeamConfigForStartup(): Promise<StartupTeamConfig> {
    try {
      return { kind: 'ready', document: await this.loadTeamConfig() };
    } catch (error) {
      if (error instanceof TeamVerificationConfigurationError) return { kind: 'configuration-invalid', error };
      throw error;
    }
  }

  /** Strict editor preflight with a fixed repair hint; parser/filesystem text can contain file contents. */
  async loadTeamConfigForEdit(): Promise<TeamFileDocument | undefined> {
    try {
      return await this.loadTeamConfig({ strict: true });
    } catch (error) {
      if (error instanceof TeamVerificationConfigurationError) throw error;
      throw new Error('.unode/team.json could not be read. Fix or remove it before editing team configuration.');
    }
  }

  /** Full replacement, not a read/modify/write API. Editors must use updateTeamConfig instead. */
  async saveTeamConfig(doc: TeamFileDocument): Promise<void> {
    // Freeze the caller's input before waiting for earlier writers or filesystem I/O.
    const bytes = Buffer.from(serializeVersionedTeamFile(this.normalizeTeamConfig(doc), this.connectionResolver()), 'utf8');
    await this.serializeTeamConfiguration(async (folder, assertCurrent) => {
      await this.writeTeamConfig(folder, bytes, assertCurrent);
    });
  }

  /**
   * Same-host serialized read/modify/write. Read strictly *inside* the queue; a malformed/unreadable
   * document must never become an empty replacement. The synchronous edit changes only its owned fields
   * on the latest document. Returning undefined is a deliberate no-op (for example, a missing source).
   * This does not claim a cross-window/file-system CAS or make configuration an execution permission.
   */
  async updateTeamConfig(
    edit: (current: TeamFileDocument | undefined) => TeamFileDocument | undefined,
    expectedMembers?: readonly AgentConfig[],
  ): Promise<void> {
    // Roster migrations computed before the queue may replace only the roster they actually read.
    // This is a direct-edit target guard, NOT a task verification binding/full-document digest.
    const expectedRoster = expectedMembers === undefined ? undefined : structuredClone(expectedMembers);
    await this.serializeTeamConfiguration(async (folder, assertCurrent) => {
      let current: TeamFileDocument | undefined;
      try { current = await this.readTeamConfig({ strict: true }); }
      catch (error) {
        if (error instanceof TeamVerificationConfigurationError) throw error;
        throw new Error('.unode/team.json could not be read. Fix or remove it before editing team configuration.');
      }
      assertCurrent();
      if (expectedRoster !== undefined && !isDeepStrictEqual(current?.members, expectedRoster)) {
        throw new Error('The team roster changed before this edit could be saved. Refresh the team and try again.');
      }
      const next = edit(current);
      if (next === undefined) return;
      const bytes = Buffer.from(serializeVersionedTeamFile(this.normalizeTeamConfig(next), this.connectionResolver()), 'utf8');
      await this.writeTeamConfig(folder, bytes, assertCurrent);
    });
  }

  private normalizeTeamConfig(doc: TeamFileDocument): TeamFileDocument {
    const members = normalizePersistedAgents(doc.members ?? [], this.connectionResolver());
    assertSerializableRoutes(members, this.connectionResolver());
    return {
      version: doc.version ?? '1.0',
      members,
      mcpServers: [],
      workflows: doc.workflows ?? [],
      ...completionVerificationFields(doc),
      ...(doc.smartCompactionProfiles ? { smartCompactionProfiles: doc.smartCompactionProfiles } : {}),
    };
  }

  private async writeTeamConfig(folder: BoundProjectFolder, bytes: Uint8Array, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const dir = vscode.Uri.joinPath(folder.uri, '.unode');
    const uri = vscode.Uri.joinPath(dir, 'team.json');
    await vscode.workspace.fs.createDirectory(dir);
    assertCurrent();
    await vscode.workspace.fs.writeFile(uri, bytes);
    assertCurrent();
  }

  /**
   * v0.9.99: the target is the bound project root, compared with itself again around each I/O step. A change of the
   * editor's first folder does not change it, so the save completes in the project the team works in; only a
   * binding that no longer names this root (no folder) refuses.
   */
  private async serializeTeamConfiguration<T>(
    operation: (folder: BoundProjectFolder, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const folder = this.workspaceFolder();
    if (!folder) throw new Error('Open a workspace before saving .unode/team.json.');
    const assertCurrent = () => {
      const current = this.workspaceFolder();
      if (!current || current.uri.fsPath !== folder.uri.fsPath) {
        throw new Error('The workspace changed. Reload the window before saving team configuration.');
      }
    };
    return this.queueTeamConfiguration(() => {
      assertCurrent();
      return operation(folder, assertCurrent);
    });
  }

  private queueTeamConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    const operationResult = this.teamConfigurationTail.then(operation);
    // A refused edit must not poison later edits, but its own caller still receives the rejection.
    this.teamConfigurationTail = operationResult.then(() => undefined, () => undefined);
    return operationResult;
  }

  /** The caller holds roster/task admission. All document readers/writers and roster writes share this
   * queue, so none can observe or overwrite the persisted-policy / live-roster publication interval. */
  async replaceSavedTeam(incoming: TeamFileDocument, ops: SavedTeamReplacement): Promise<boolean> {
    // Validate the entire source before stopping anything. Host authority here does not widen a source:
    // callers must pass the already-narrowed or host-owned result of loadSavedTeamWithTrust.
    const validated = validateTeamFile(structuredClone(incoming), this.connectionResolver(), { authority: 'host-owned' });
    if (new Set(validated.members.map(member => member.id)).size !== validated.members.length) {
      throw new Error('The saved team contains duplicate agent IDs. Nothing was switched.');
    }
    const prepared = await this.serializeTeamConfiguration(async (folder, assertWorkspace) => {
      ops.assertCurrent();
      const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
      let original: Uint8Array | undefined;
      try { original = await vscode.workspace.fs.readFile(uri); }
      catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== 'ENOENT' && code !== 'FileNotFound' && code !== 'EntryNotFound') throw new Error('The current team configuration could not be read. Nothing was switched.');
      }
      let outgoingDocument: TeamFileDocument | undefined;
      try {
        outgoingDocument = original === undefined ? undefined
          : validateTeamFile(JSON.parse(Buffer.from(original).toString('utf8')), this.connectionResolver(), { workspaceRoot: folder.uri.fsPath });
      } catch { throw new Error('The current team configuration is invalid. Repair .unode/team.json before switching teams.'); }
      const outgoingMembers = structuredClone(ops.currentMembers());
      const next = this.normalizeTeamConfig(activeDocumentForSavedTeam(outgoingDocument, validated));
      const bytes = Buffer.from(serializeVersionedTeamFile(next, this.connectionResolver()), 'utf8');
      assertWorkspace(); ops.assertCurrent();
      if (!await ops.snapshotOutgoing(outgoingDocument)) return false;
      assertWorkspace(); ops.assertCurrent();
      return { original, outgoingMembers, bytes, root: folder.uri.fsPath };
    });
    if (!prepared) return false;
    // Stopping an old backend may await an already-running verification's queued document read.
    // Keep host admission closed, but release the storage lane while observing those stops.
    ops.assertCurrent();
    await ops.stopAndPrepare();
    return this.serializeTeamConfiguration(async (folder, assertWorkspace) => {
      assertWorkspace(); ops.assertCurrent();
      if (folder.uri.fsPath !== prepared.root) throw new Error('The workspace changed before switching teams.');
      const { original, outgoingMembers, bytes } = prepared;
      // Capture only after stopAndPrepare drained old conversation writes. Publication clears these
      // exact workspace-owned records; a failed publication must restore data, not just agent configs.
      const runtimeBackup = [...new Set([...outgoingMembers, ...validated.members].map(member => member.id))]
        .flatMap(id => [SNAPSHOT_PREFIX + id, RUNTIME_PIN_PREFIX + id])
        .map(key => ({ key, value: structuredClone(this.workspaceState.get<unknown>(key)) }));
      let publicationStarted = false;
      const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
      let currentBytes: Uint8Array | undefined;
      try { currentBytes = await vscode.workspace.fs.readFile(uri); }
      catch (missing) {
        const code = (missing as { code?: string })?.code;
        if (code !== 'ENOENT' && code !== 'FileNotFound' && code !== 'EntryNotFound') throw missing;
      }
      if (original === undefined ? currentBytes !== undefined : currentBytes === undefined || !Buffer.from(currentBytes).equals(original)) {
        throw new Error('The team file changed before switching. The previous team remains stopped; review the file and try again.');
      }
      assertWorkspace(); ops.assertCurrent();
      // A write that rejects may already have changed the file. Restore even that uncertain attempt.
      try {
        await this.writeTeamConfig(folder, bytes, assertWorkspace);
        ops.assertCurrent();
        if (!Buffer.from(await vscode.workspace.fs.readFile(uri)).equals(bytes)) throw new Error('The team file changed while switching. The saved team was not applied.');
        await this.saveAgentsNow(validated.members);
        assertWorkspace(); ops.assertCurrent();
        await ops.beforeIncomingPublish?.();
        assertWorkspace(); ops.assertCurrent();
        publicationStarted = true;
        await ops.publish(structuredClone(validated.members));
        assertWorkspace();
      } catch (error) {
        try {
          assertWorkspace();
          // Do not blindly overwrite an external edit with our rollback. This is a same-host queue,
          // not filesystem CAS; an unrecognised/partial target requires repair with admission closed.
          let observed: Uint8Array | undefined;
          try { observed = await vscode.workspace.fs.readFile(uri); }
          catch (missing) {
            const code = (missing as { code?: string })?.code;
            if (code !== 'ENOENT' && code !== 'FileNotFound' && code !== 'EntryNotFound') throw missing;
          }
          if (observed !== undefined && !Buffer.from(observed).equals(bytes)
            && (original === undefined || !Buffer.from(observed).equals(original))) throw new Error('Unrecognised target');
          if (original !== undefined) await this.writeTeamConfig(folder, original, assertWorkspace);
          else {
            try { await vscode.workspace.fs.delete(uri); }
            catch (missing) {
              const code = (missing as { code?: string })?.code;
              if (code !== 'ENOENT' && code !== 'FileNotFound' && code !== 'EntryNotFound') throw missing;
            }
          }
          await this.saveAgentsNow(outgoingMembers);
          // Before publication the original sessions are still live (stopped), including their history.
          // Republish only after a possibly partial incoming publication, then restore its storage effects.
          if (publicationStarted) {
            await ops.publish(outgoingMembers);
            for (const { key, value } of runtimeBackup) {
              assertWorkspace();
              await this.workspaceState.update(key, value);
            }
          }
          assertWorkspace();
        } catch { throw new TeamReplacementRecoveryError(); }
        throw error;
      }
      return true;
    });
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
    // v0.9.99: project saves are validated against the bound project root, the same one their folder is in.
    const currentWorkspaceRoot = () => this.canonicalWorkspaceRoot();
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
    verificationSource?: { document: TeamFileDocument | undefined },
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
    // Completion verification travels with the roster; missing stays missing (no legacy default is saved).
    const verification = completionVerificationFields(verificationSource ? verificationSource.document : await this.loadTeamConfig());
    // Other workspace-wide configuration does not travel. The first version copied `mcpServers`
    // and `workflows` in, which was wrong twice over: restoring must not apply them, so they were
    // dead weight the file promised and did not deliver; and a file meant to travel through git to a
    // colleague would have carried this workspace's server command lines with it. Empty here is not a
    // placeholder for later — restoring a team must not silently replace workspace-wide configuration.
    const serialized = scope === 'global'
      ? serializeHostOwnedTeamLibrary({ version: '1.0', members: normalized, mcpServers: [], workflows: [], ...verification })
      : serializeWorkspaceTeamLibrary(
          { version: '1.0', members: normalized, mcpServers: [], workflows: [], ...verification },
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
    // v0.9.99: project saves are validated against the bound project root, the same one their folder is in.
    const currentWorkspaceRoot = () => this.canonicalWorkspaceRoot();
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
        return { document, permissionSource: document.members, fingerprintMatched: true, sourceVersion: savedTeamSourceVersion(uri.fsPath, bytes) };
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
        sourceVersion: savedTeamSourceVersion(uri.fsPath, bytes),
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

  async savedTeamSourceMatches(ref: TeamLibraryRef, sourceVersion: string | undefined): Promise<boolean> {
    if (!sourceVersion) return false;
    const dir = this.teamsDir(ref.scope); if (!dir) return false;
    const uri = vscode.Uri.joinPath(dir, `${ref.slug}.json`);
    try { return savedTeamSourceVersion(uri.fsPath, await vscode.workspace.fs.readFile(uri)) === sourceVersion; }
    catch { return false; }
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
    const capturedWorkflows = structuredClone(workflows);
    await this.updateTeamConfig((current) => ({
      version: current?.version ?? '1.0',
      members: current?.members ?? this.loadAgents(),
      mcpServers: [],
      workflows: capturedWorkflows,
      smartCompactionProfiles: current?.smartCompactionProfiles,
      ...completionVerificationFields(current),
    }));
  }

  /**
   * v0.9.90: persist this team's Smart compaction profile table in .unode/team.json. Like saving workflows, the
   * first edit creates the file from the current roster. A team file that exists but does not validate is never
   * overwritten here: a table edit must not replace a roster this reader could not load.
   */
  async saveSmartCompactionProfiles(overrides: SmartCompactionProfileOverrides | undefined): Promise<void> {
    const capturedOverrides = structuredClone(overrides);
    await this.updateTeamConfig((current) => ({
      version: current?.version ?? '1.0',
      members: current?.members ?? this.loadAgents(),
      mcpServers: [],
      workflows: current?.workflows ?? [],
      smartCompactionProfiles: capturedOverrides && Object.keys(capturedOverrides).length > 0 ? capturedOverrides : undefined,
      ...completionVerificationFields(current),
    }));
  }

  /** Whether .unode/team.json exists, readable or not. */
  async teamFileExists(): Promise<boolean> {
    const folder = this.workspaceFolder();
    if (!folder) return false;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.unode', 'team.json'));
      return true;
    } catch {
      return false;
    }
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

  /** v0.9.99: the bound project root as a folder URI; never the editor's live first folder. */
  private workspaceFolder(): BoundProjectFolder | undefined {
    const root = this.boundWorkspaceRoot();
    return root === undefined ? undefined : { uri: vscode.Uri.file(root) };
  }

  /** Canonical bound project root for repository-owned team-library validation. */
  private canonicalWorkspaceRoot(): string | undefined {
    const root = this.boundWorkspaceRoot();
    if (root === undefined) return undefined;
    try {
      return realpathSync(root);
    } catch {
      return undefined;
    }
  }
}

/** The bound project folder that team files and the project Team Library resolve against. */
interface BoundProjectFolder {
  readonly uri: vscode.Uri;
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
    ...completionVerificationFields(doc),
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
        ...(source.executePreference ? { executePreference: source.executePreference } : {}),
        ...(source.builtinToolDefaultsRevision ? { builtinToolDefaultsRevision: source.builtinToolDefaultsRevision } : {}),
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

function savedTeamSourceVersion(filePath: string, bytes: Uint8Array): string {
  const fingerprint = workspaceTeamFingerprint(filePath, bytes);
  return `${fingerprint.locationSha256}:${fingerprint.sha256}`;
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
