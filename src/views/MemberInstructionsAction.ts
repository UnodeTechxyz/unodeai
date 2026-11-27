import * as vscode from 'vscode';

export interface AddedMember { agentId: string; name: string }
export interface MemberAddResult { ok: boolean; message: string; addedMember?: AddedMember }
export const memberInstructionsLabel = (member: AddedMember) => `Edit ${member.name}'s instructions`;
/** Opening the member's existing editor changes no instructions, permissions or team-wide rules. */
export function openMemberInstructions(member: AddedMember): Thenable<unknown> {
  return vscode.commands.executeCommand('unode.openAgentBuilder', { agentId: member.agentId, focus: 'instructions' });
}
/** Optional action on an existing result; never a modal question or a wait for the person to dismiss it. */
export function showMemberAddedNotice(message: string, member: AddedMember): void {
  const action = memberInstructionsLabel(member);
  try {
    void Promise.resolve(vscode.window.showInformationMessage(message, action)).then(choice => {
      if (choice === action) return openMemberInstructions(member);
      return undefined;
    }).catch(() => undefined);
  } catch { /* The member is already added; an unavailable optional notice must not fail that result. */ }
}
