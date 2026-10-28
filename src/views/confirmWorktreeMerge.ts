import * as vscode from 'vscode';
import type { ManualLaneMergeReview } from '../backend/WorktreeCoordinator';

/** A user-opened decision, never an approval for commands or a passing verification result. */
export async function confirmWorktreeMerge(review: ManualLaneMergeReview): Promise<boolean> {
  const merge = 'Merge without verification';
  const choice = await vscode.window.showWarningMessage(
    'Merge this held lane without verification?',
    { modal: true, detail: `Agent: ${review.agentName}\nAgent ID: ${review.agentId}\nBranch: ${review.branch}\nCommit: ${review.head}\n${review.reason}\n\nOnly this committed version will enter integration. It stays unverified and is not check evidence. Finalize to your branch is a separate action.` },
    'Not now',
    merge,
  );
  if (choice !== merge) return false;
  return true;
}
