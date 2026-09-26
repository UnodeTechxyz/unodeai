import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';

export const PROJECT_COMMAND_APPROVALS_KEY = 'unode.projectCommandApprovals.v1';

export interface WorkspaceMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface ProjectCommandApprovalRecord {
  version: 1;
  workspaceId: string;
  commands: string[];
  executionEnabled?: boolean;
}

/**
 * Human-approved command templates scoped to the current first workspace folder. The path itself is
 * not retained; its digest prevents a workspaceState bucket reused after a folder change from carrying
 * approvals into the new repository.
 */
export class ProjectCommandApprovals {
  constructor(
    private readonly state: WorkspaceMemento,
    private readonly workspaceRoot: () => string | undefined,
  ) {}

  list(): string[] {
    const record = this.record();
    if (!record) return [];
    return normalizeCommands(record.commands);
  }

  isExecutionEnabled(): boolean {
    return this.record()?.executionEnabled === true;
  }

  async approve(command: string): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    const normalized = normalizeCommand(command);
    if (!workspaceId || !normalized) return false;
    const commands = this.list();
    if (!commands.includes(normalized)) commands.push(normalized);
    await this.write(workspaceId, commands, this.isExecutionEnabled());
    return true;
  }

  async approveMany(commands: readonly string[]): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;
    const merged = normalizeCommands([...this.list(), ...commands]);
    await this.write(workspaceId, merged, this.isExecutionEnabled());
    return true;
  }

  /** Enable ask-mode command execution for this project without changing user-wide settings. */
  async enableExecution(commands: readonly string[] = []): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return false;
    await this.write(workspaceId, normalizeCommands([...this.list(), ...commands]), true);
    return true;
  }

  async revoke(command: string): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    const normalized = normalizeCommand(command);
    if (!workspaceId || !normalized || !this.list().includes(normalized)) return false;
    await this.write(workspaceId, this.list().filter((entry) => entry !== normalized), this.isExecutionEnabled());
    return true;
  }

  /** Revoke the project-level execution opt-in and every command it granted. */
  async disableExecution(): Promise<boolean> {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId || !this.record()) return false;
    await this.write(workspaceId, [], false);
    return true;
  }

  private record(): ProjectCommandApprovalRecord | undefined {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) return undefined;
    const record = this.state.get<unknown>(PROJECT_COMMAND_APPROVALS_KEY);
    if (!isRecord(record) || record.version !== 1 || record.workspaceId !== workspaceId || !Array.isArray(record.commands)) {
      return undefined;
    }
    return record as unknown as ProjectCommandApprovalRecord;
  }

  private write(workspaceId: string, commands: string[], executionEnabled: boolean): PromiseLike<void> {
    return this.state.update(PROJECT_COMMAND_APPROVALS_KEY, {
      version: 1,
      workspaceId,
      commands,
      executionEnabled,
    });
  }

  private currentWorkspaceId(): string | undefined {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    return workspaceRootIdentity(root);
  }
}

function normalizeCommands(values: readonly unknown[]): string[] {
  return [...new Set(values.map(normalizeCommand).filter((value): value is string => !!value))];
}

function normalizeCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
