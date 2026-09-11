/*---------------------------------------------------------------------------------------------
 *  UnodeAi - PersistenceManager
 *  Persists the team roster (agent configs) and usage stats so the team survives reloads.
 *
 *  Agent CONFIGS live in workspaceState (and optionally a versionable `.unode/team.json`).
 *  API KEYS never go here — they live in SecretStorage (see SecretsManager). The two are joined
 *  at runtime via AgentConfig.provider.apiKeySecretName.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { AgentConfig, MCPServerConfig, Message, WorkflowConfig, WorkflowInstance } from '../types';
import { ConversationSnapshot } from '../backend/AgentBackend';
import { SerializedCheckpoints } from '../backend/Checkpoints';
import { PendingDelegationResult } from './PendingDelegationResults';
import type { RunRecord } from '../observability/RunLedger';
import { AGENT_CONFIG_FIELDS, TeamFileDocument, TeamFileValidationError, validateTeamFile } from './TeamFileSchema';
import { TeamLibraryEntry, TeamLibraryRef, TeamLibraryScope, isAutomaticSnapshotSlug } from './TeamLibrary';
import { keysToReset } from './resetWorkspaceKeys';
import { BUILTIN_CONNECTION_REGISTRY, ConnectionResolver, assertRegisteredRoute } from '../routes/ConnectionRegistry';
import {
  assertRepairableCustomRoute,
  exportVersionedAgentConfig,
  migrateAgentConfigOrRepair,
  type VersionedAgentConfig,
} from '../routes/RouteMigration';

const AGENTS_KEY = 'roam.agents';
const SNAPSHOT_PREFIX = 'roam.snapshot.';
const MESSAGES_KEY = 'roam.messages';
const WORKFLOWS_KEY = 'roam.workflows';
const APPROVED_MCP_KEY = 'roam.approvedMcpServers';
const CHECKPOINTS_KEY = 'roam.checkpoints';
const PENDING_DELEGATION_RESULTS_KEY = 'roam.pendingDelegationResults';
const RUNS_KEY = 'roam.runs';

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

export class PersistenceManager {
  constructor(
    private context: vscode.ExtensionContext,
    private readonly connectionResolver: () => ConnectionResolver = () => BUILTIN_CONNECTION_REGISTRY,
  ) {}

  loadAgents(): AgentConfig[] {
    return this.context.workspaceState.get<AgentConfig[]>(AGENTS_KEY, []);
  }

  async saveAgents(agents: AgentConfig[]): Promise<void> {
    const resolver = this.connectionResolver();
    const normalized = normalizePersistedAgents(agents, resolver);
    assertSerializableRoutes(normalized, resolver);
    // Repair explanations are derived from the live local registry on every restore, never trusted
    // from a prior workspaceState write.
    await this.context.workspaceState.update(AGENTS_KEY, normalized.map(({ routeRepair: _repair, ...agent }) => agent));
  }

  // ─── Conversation snapshots (L2 crash recovery) ──────────────────────

  loadSnapshot(agentId: string): ConversationSnapshot | undefined {
    return this.context.workspaceState.get<ConversationSnapshot>(SNAPSHOT_PREFIX + agentId);
  }

  saveSnapshot(agentId: string, snapshot: ConversationSnapshot): void {
    // Fire-and-forget; workspaceState.update returns a Thenable we don't need to await per-turn.
    void this.context.workspaceState.update(SNAPSHOT_PREFIX + agentId, snapshot);
  }

  clearSnapshot(agentId: string): void {
    void this.context.workspaceState.update(SNAPSHOT_PREFIX + agentId, undefined);
  }

  // ─── Message history (P1#5) ──────────────────────────────────────────

  loadMessages(): Message[] {
    return this.context.workspaceState.get<Message[]>(MESSAGES_KEY, []);
  }

  saveMessages(messages: Message[]): void {
    void this.context.workspaceState.update(MESSAGES_KEY, messages);
  }

  // ─── Run ledger (v0.9.49) ────────────────────────────────────────────

  /**
   * Deliberately unvalidated storage. `RunLedger` normalizes these values before any consumer can
   * receive a RunRecord; a named shape here would promise that validation already happened.
   */
  loadRuns(): unknown[] {
    const value = this.context.workspaceState.get<unknown>(RUNS_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  saveRuns(runs: RunRecord[]): void {
    void this.context.workspaceState.update(RUNS_KEY, runs);
  }

  // ─── Settled delegation results (FA-7 recovery) ────────────────────────

  loadPendingDelegationResults(): PendingDelegationResult[] {
    const value = this.context.workspaceState.get<unknown>(PENDING_DELEGATION_RESULTS_KEY, []);
    return Array.isArray(value) ? value.filter(isPendingDelegationResult) : [];
  }

  savePendingDelegationResults(results: PendingDelegationResult[]): Thenable<void> {
    return this.context.workspaceState.update(PENDING_DELEGATION_RESULTS_KEY, results);
  }

  // ─── Checkpoints (V1: per-write restore points) ──────────────────────

  loadCheckpoints(): SerializedCheckpoints | undefined {
    return this.context.workspaceState.get<SerializedCheckpoints>(CHECKPOINTS_KEY);
  }

  saveCheckpoints(data: SerializedCheckpoints): void {
    void this.context.workspaceState.update(CHECKPOINTS_KEY, data);
  }

  // ─── In-flight workflow instances (L3 recovery, P1#5) ────────────────

  loadWorkflows(): WorkflowInstance[] {
    return this.context.workspaceState.get<WorkflowInstance[]>(WORKFLOWS_KEY, []);
  }

  saveWorkflows(instances: WorkflowInstance[]): void {
    void this.context.workspaceState.update(WORKFLOWS_KEY, instances);
  }

  // ─── Approved (sensitive) MCP servers (P1#4) ─────────────────────────

  loadApprovedMcpServers(): string[] {
    return this.context.workspaceState.get<string[]>(APPROVED_MCP_KEY, []);
  }

  async saveApprovedMcpServers(ids: string[]): Promise<void> {
    await this.context.workspaceState.update(APPROVED_MCP_KEY, ids);
  }

  // ─── Reset (P2: "UnodeAi: Reset Workspace State") ──────────────────

  /**
   * Wipe this workspace's persisted Roam state: roster, per-agent conversation snapshots, per-agent
   * chat history, the message log, file checkpoints, workflows, approved MCP servers, and the
   * onboarding flag.
   * Secrets (API keys) are NOT touched here — those live in SecretStorage and are cleared separately.
   * Per-agent keys are prefixed, so we enumerate workspaceState and drop anything that matches.
   */
  async resetWorkspaceState(): Promise<void> {
    const ws = this.context.workspaceState;
    const CHAT_PREFIX = 'roam.chat.'; // mirrors CHAT_HISTORY_KEY_PREFIX in views/chatHistory.ts
    const keys = keysToReset(
      ws.keys(),
      [
        AGENTS_KEY,
        MESSAGES_KEY,
        WORKFLOWS_KEY,
        APPROVED_MCP_KEY,
        CHECKPOINTS_KEY,
        PENDING_DELEGATION_RESULTS_KEY,
        RUNS_KEY,
        'roam.onboardingComplete',
      ],
      [SNAPSHOT_PREFIX, CHAT_PREFIX]
    );
    for (const key of keys) {
      await ws.update(key, undefined);
    }
  }

  /**
   * Delete the versionable team file (<workspace>/.unode/team.json). Part of a full workspace reset:
   * otherwise an empty workspaceState would re-seed the just-cleared roster from this file on reload.
   * Best-effort — silently ignores an absent file or no workspace.
   */
  async deleteTeamFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const document = validateTeamFile(parsed, this.connectionResolver());
      for (const warning of document.validationWarnings ?? []) {
        void vscode.window.showWarningMessage(`UnodeAi adjusted .unode/team.json: ${warning}`);
      }
      return document;
    } catch (err) {
      this.warnTeamFileIgnored(err);
      return undefined;
    }
  }

  async saveTeamConfig(doc: TeamFileDocument): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace before saving .unode/team.json.');
    }
    const dir = vscode.Uri.joinPath(folder.uri, '.unode');
    const uri = vscode.Uri.joinPath(dir, 'team.json');
    await vscode.workspace.fs.createDirectory(dir);
    const normalized: TeamFileDocument = {
      version: doc.version ?? '1.0',
      members: normalizePersistedAgents(doc.members ?? [], this.connectionResolver()),
      mcpServers: doc.mcpServers ?? [],
      workflows: doc.workflows ?? [],
    };
    assertSerializableRoutes(normalized.members, this.connectionResolver());
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(serializeVersionedTeamFile(normalized, this.connectionResolver()), 'utf8'),
    );
  }

  // ─── Saved teams (.unode/teams/*.json) ──────────────────────────────────
  //
  // Deliberately the same document as `.unode/team.json`, written through the same serializer. A second
  // format would need its own validation, its own route migration and its own proof that it carries no
  // credential; reusing this one inherits all three, and a saved team stays readable JSON that travels
  // through git to a colleague.

  private teamsDir(scope: TeamLibraryScope): vscode.Uri | undefined {
    if (scope === 'global') {
      return this.context.globalStorageUri ? vscode.Uri.joinPath(this.context.globalStorageUri, 'teams') : undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
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
        const document = validateTeamFile(parsed, this.connectionResolver());
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
    void vscode.window.showWarningMessage(
      `${reasons.length} saved team file(s) could not be read and are not offered: ${reasons.join('; ')}`,
    );
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
    const normalized = normalizePersistedAgents([...members], this.connectionResolver()).map((member) => {
      if (scope !== 'global') return member;
      // A global file cannot distinguish a harmless proxy host from a secret typed into agent env.
      const { env: _env, ...withoutEnv } = member;
      return withoutEnv as AgentConfig;
    });
    assertSerializableRoutes(normalized, this.connectionResolver());
    await vscode.workspace.fs.createDirectory(dir);
    // A saved team is the roster and nothing else. The first version copied the workspace's `mcpServers`
    // and `workflows` in, which was wrong twice over: restoring only ever applies `members`, so they were
    // dead weight the file promised and did not deliver; and a file meant to travel through git to a
    // colleague would have carried this workspace's server command lines with it. Empty here is not a
    // placeholder for later — restoring a team must not silently replace workspace-wide configuration.
    const serialized = serializeVersionedTeamFile(
      { version: '1.0', members: normalized, mcpServers: [], workflows: [] },
      this.connectionResolver(),
    );
    // label/savedAt ride alongside the validated document: validateTeamFile ignores unknown top-level
    // keys, so the file stays loadable by the same reader that loads team.json.
    const document = { label, savedAt, ...JSON.parse(serialized) as Record<string, unknown> };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, `${slug}.json`),
      Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    );
  }

  async loadSavedTeam(ref: TeamLibraryRef): Promise<TeamFileDocument | undefined> {
    const dir = this.teamsDir(ref.scope);
    if (!dir) { return undefined; }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${ref.slug}.json`));
      const document = validateTeamFile(JSON.parse(Buffer.from(bytes).toString('utf8')), this.connectionResolver());
      return ref.scope === 'global' ? sanitizeGlobalRestore(document, currentWorkspaceRoot()) : document;
    } catch (err) {
      this.warnTeamFileIgnored(err);
      return undefined;
    }
  }

  async deleteSavedTeam(ref: TeamLibraryRef): Promise<void> {
    const dir = this.teamsDir(ref.scope);
    if (!dir) { return; }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${ref.slug}.json`));
    } catch {
      /* already gone */
    }
  }

  async saveCustomWorkflows(workflows: WorkflowConfig[]): Promise<void> {
    const current = await this.loadTeamConfig();
    await this.saveTeamConfig({
      version: current?.version ?? '1.0',
      members: current?.members ?? this.loadAgents(),
      mcpServers: current?.mcpServers ?? [],
      workflows,
    });
  }

  /** 段2: team-level MCP server registry from .unode/team.json (empty if absent/malformed). */
  async loadTeamMcpServers(): Promise<MCPServerConfig[]> {
    return (await this.loadTeamConfig())?.mcpServers ?? [];
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
}

/** Current target root for a global-team restore. An absent or inaccessible root keeps no folder grant. */
function currentWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    return realpathSync(folder.uri.fsPath);
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A global record crosses a workspace boundary on every restore.  It therefore never recreates an
 * unchosen outside-folder, MCP, or env grant; the result is still a valid roster and the exact repair is
 * carried in validationWarnings for the restore UI to show before replacement.
 */
function sanitizeGlobalRestore(document: TeamFileDocument, workspaceRoot: string | undefined): TeamFileDocument {
  let removedFolders = 0;
  let removedMcp = 0;
  let removedEnv = 0;
  const members = document.members.map((member) => {
    const keptFolders = (member.folderAccess ?? []).filter((grant) => {
      if (!workspaceRoot) {
        removedFolders++;
        return false;
      }
      const requested = path.resolve(workspaceRoot, grant.path);
      if (!existsSync(requested)) {
        removedFolders++;
        return false;
      }
      try {
        if (isInside(workspaceRoot, realpathSync(requested))) return true;
      } catch {
        // A missing/inaccessible path cannot establish a safe, current workspace grant.
      }
      removedFolders++;
      return false;
    });
    const mcpCount = member.mcpServers?.length ?? 0;
    const hadEnv = member.env !== undefined;
    removedMcp += mcpCount;
    if (hadEnv) removedEnv++;
    const { folderAccess: _folders, mcpServers: _mcp, env: _env, ...safe } = member;
    return {
      ...safe,
      ...(keptFolders.length > 0 ? { folderAccess: keptFolders } : {}),
    } as AgentConfig;
  });
  return {
    ...document,
    members,
    validationWarnings: [
      ...(document.validationWarnings ?? []),
      `Global restore removed ${removedFolders} folder access grant(s), ${removedMcp} MCP grant(s), and ${removedEnv} env map(s).`,
    ],
  };
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
  return agents.map((agent) => migrateAgentConfigOrRepair(agent, resolver).config);
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
    members: persisted.members.map((member) => persistableAgentFields(exportVersionedAgentConfig(member, resolver))),
  }, null, 2)}\n`;
}
