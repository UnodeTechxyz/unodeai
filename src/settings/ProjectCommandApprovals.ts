import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';
import { type CommandApprovalKey, isPersistedCommandShellGrammar } from '../backend/CommandShell';

/** The pre-v0.9.96 record. Read only for its execution opt-in; its untyped commands are never re-activated. */
export const PROJECT_COMMAND_APPROVALS_KEY = 'unode.projectCommandApprovals.v1';
/** v0.9.96: every approval is bound to the shell grammar it was given under. */
export const PROJECT_COMMAND_APPROVALS_V2_KEY = 'unode.projectCommandApprovals.v2';

export interface WorkspaceMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface ProjectCommandApprovalRecordV1 {
  version: 1;
  workspaceId: string;
  commands: string[];
  executionEnabled?: boolean;
}

interface ProjectCommandApprovalRecordV2 {
  version: 2;
  workspaceId: string;
  approvals: CommandApprovalKey[];
  executionEnabled?: boolean;
}

/** What the store holds for the current workspace, whichever record it came from. */
interface ProjectCommandApprovalState {
  approvals: CommandApprovalKey[];
  executionEnabled: boolean;
}

/**
 * Project command approvals in UnodeAi-owned workspace storage. Since v0.9.96 an approval is a
 * `(grammar, template)` key: "Allow for project" under PowerShell never authorizes the same template under
 * cmd.exe or a POSIX shell.
 *
 * Upgrade is fail-closed. Without a v2 record, the v1 record contributes only its execution opt-in; its
 * commands were stored without the shell they were approved under, so none becomes a v2 grant and each may
 * ask once again. A v2 record that is present but malformed is not trusted and does not fall back to v1. The
 * first v2 write leaves the v1 record untouched as rollback evidence.
 */
export class ProjectCommandApprovals {
  constructor(
    private readonly state: WorkspaceMemento,
    private readonly workspaceRoot: () => string | undefined,
  ) {}

  list(): CommandApprovalKey[] {
    return this.current()?.approvals.map((key) => ({ ...key })) ?? [];
  }

  isExecutionEnabled(): boolean {
    return this.current()?.executionEnabled === true;
  }

  async approve(key: CommandApprovalKey): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    const normalized = normalizeKey(key);
    if (!workspaceId || !normalized) return false;
    await this.write(workspaceId, normalizeKeys([...this.list(), normalized]), this.isExecutionEnabled());
    return true;
  }

  async approveMany(keys: readonly CommandApprovalKey[]): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;
    await this.write(workspaceId, normalizeKeys([...this.list(), ...keys]), this.isExecutionEnabled());
    return true;
  }

  /** The explicit guided opt-in: ask mode for this project plus the reviewed keys, in one write. */
  async enableExecution(keys: readonly CommandApprovalKey[]): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;
    await this.write(workspaceId, normalizeKeys([...this.list(), ...keys]), true);
    return true;
  }

  /** Revoke exactly the displayed `(grammar, template)` key. */
  async revoke(key: CommandApprovalKey): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    const normalized = normalizeKey(key);
    if (!workspaceId || !normalized) return false;
    const current = this.list();
    const remaining = current.filter((entry) => !sameKey(entry, normalized));
    if (remaining.length === current.length) return false;
    await this.write(workspaceId, remaining, this.isExecutionEnabled());
    return true;
  }

  /** Revoke the project-level execution opt-in and every command it granted. A v1 record cannot reactivate them. */
  async disableExecution(): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId || !this.current()) return false;
    await this.write(workspaceId, [], false);
    return true;
  }

  private current(): ProjectCommandApprovalState | undefined {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return undefined;
    const v2 = this.state.get<unknown>(PROJECT_COMMAND_APPROVALS_V2_KEY);
    if (v2 !== undefined) {
      // Present means authoritative: a malformed or foreign v2 record grants nothing and never falls back to v1.
      const record = parseV2(v2);
      if (!record || record.workspaceId !== workspaceId) return undefined;
      return { approvals: record.approvals, executionEnabled: record.executionEnabled === true };
    }
    const v1 = this.state.get<unknown>(PROJECT_COMMAND_APPROVALS_KEY);
    if (!isRecord(v1) || v1.version !== 1 || v1.workspaceId !== workspaceId || !Array.isArray(v1.commands)) {
      return undefined;
    }
    // The old commands carry no grammar. Only the execution opt-in survives the upgrade.
    return { approvals: [], executionEnabled: (v1 as unknown as ProjectCommandApprovalRecordV1).executionEnabled === true };
  }

  private write(workspaceId: string, approvals: CommandApprovalKey[], executionEnabled: boolean): PromiseLike<void> {
    const record: ProjectCommandApprovalRecordV2 = { version: 2, workspaceId, approvals, executionEnabled };
    return this.state.update(PROJECT_COMMAND_APPROVALS_V2_KEY, record);
  }

  private currentWorkspaceId(): string | undefined {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    return workspaceRootIdentity(root);
  }
}

function parseV2(value: unknown): ProjectCommandApprovalRecordV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || typeof value.workspaceId !== 'string' || !Array.isArray(value.approvals)) {
    return undefined;
  }
  if (value.executionEnabled !== undefined && typeof value.executionEnabled !== 'boolean') return undefined;
  const approvals: CommandApprovalKey[] = [];
  for (const entry of value.approvals) {
    const key = isRecord(entry) ? normalizeKey(entry as unknown as CommandApprovalKey) : undefined;
    if (!key) return undefined;
    approvals.push(key);
  }
  return {
    version: 2,
    workspaceId: value.workspaceId,
    approvals: normalizeKeys(approvals),
    ...(value.executionEnabled !== undefined ? { executionEnabled: value.executionEnabled as boolean } : {}),
  };
}

function normalizeKeys(keys: readonly CommandApprovalKey[]): CommandApprovalKey[] {
  const out: CommandApprovalKey[] = [];
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (normalized && !out.some((entry) => sameKey(entry, normalized))) out.push(normalized);
  }
  return out;
}

function normalizeKey(key: CommandApprovalKey | undefined): CommandApprovalKey | undefined {
  if (!key || !isPersistedCommandShellGrammar(key.grammar) || typeof key.template !== 'string') return undefined;
  const template = key.template.trim().toLowerCase();
  return template ? { grammar: key.grammar, template } : undefined;
}

function sameKey(a: CommandApprovalKey, b: CommandApprovalKey): boolean {
  return a.grammar === b.grammar && a.template === b.template;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
