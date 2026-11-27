import { AgentConfig } from '../types';

export function folderAccessWorktreeConflictMessage(config: Pick<AgentConfig, 'name'>): string {
  return `Folder Access cannot be combined with worktree mode for "${config.name}". Switch unode.concurrencyStrategy off worktree mode, or clear this agent's Folder Access.`;
}

export function assertNoFolderAccessWorktreeConflict(config: Pick<AgentConfig, 'folderAccess' | 'name'>, worktreeMode: boolean): void {
  if (worktreeMode && (config.folderAccess?.length ?? 0) > 0) {
    throw new Error(folderAccessWorktreeConflictMessage(config));
  }
}
