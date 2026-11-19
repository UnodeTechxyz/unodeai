import type { CodexApprovalRequest } from '../backend/CodexBackend';
import type { ApprovalRequest } from '../views/approvals';
import { CODEX_COMMAND_CARD_WARNING, codexProgramLabel } from '../backend/codexCrossing';

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
        // v0.9.102: a Codex command card is always a crossing of its sandbox; it says so, and says what is kept.
        warning: CODEX_COMMAND_CARD_WARNING,
        // The card's events name the program from the closed list only, never the command or its targets.
        recordTarget: `Codex command (${codexProgramLabel(request.command || '')})`,
        ...(request.grantFolder ? { codexGrantFolder: request.grantFolder } : {}),
        ...(request.offerNetwork ? { codexAllowNetwork: true } : {}),
        singleUseOnly: true, ...origin,
      }
    : request.kind === 'computer-use' && request.computerUse
      ? {
          // v0.9.105 (D5-1): Codex's own question, with only the lasting choices Codex offered.
          kind: 'tool', agentName, toolName: request.title, toolDetail: request.detail,
          codexComputerUse: { app: request.computerUse.app, persist: [...request.computerUse.persist] },
          singleUseOnly: true, ...origin,
        }
      : {
          kind: 'tool', agentName, toolName: request.title, toolDetail: request.detail,
          singleUseOnly: true, approveAnyway: request.approveAnyway === true, ...origin,
        };
}
