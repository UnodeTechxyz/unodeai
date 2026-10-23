import type { CodexApprovalRequest } from '../backend/CodexBackend';
import type { ApprovalRequest } from '../views/approvals';

/** Keep the command and host shell fact separate from model-authored justification. */
export function codexApprovalPresentation(
  agentName: string,
  request: CodexApprovalRequest,
  origin: { agentId?: string; sessionId?: string },
): Omit<ApprovalRequest, 'id'> {
  return request.kind === 'command'
    ? {
        kind: 'command', agentName,
        // Never promote detail (which includes the model's reason) into command or shell identity.
        command: request.command || '',
        shellLabel: request.shellLabel || 'Codex provider shell (unverified)',
        singleUseOnly: true, ...origin,
      }
    : {
        kind: 'tool', agentName, toolName: request.title, toolDetail: request.detail,
        singleUseOnly: true, approveAnyway: request.approveAnyway === true, ...origin,
      };
}
