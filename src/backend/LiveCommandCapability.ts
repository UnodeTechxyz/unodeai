import type { CommandApprovalMode } from './CommandPolicy';

export type CommandCapabilityReason = 'connection-no-command' | 'tool-disabled' | 'commands-none'
  | 'workspace-untrusted' | 'mode-or-scope-restricted';
export interface LiveCommandCapability {
  canRequest: boolean;
  reasons: CommandCapabilityReason[];
  policy: CommandApprovalMode;
}

/** Presentation of the real gates, not a grant or a second command authorization policy. */
export function liveCommandCapability(input: { connection: boolean; tool: boolean; trusted: boolean;
  policy: CommandApprovalMode; restricted?: boolean }): LiveCommandCapability {
  const reasons: CommandCapabilityReason[] = [];
  if (!input.connection) reasons.push('connection-no-command');
  if (!input.tool) reasons.push('tool-disabled');
  if (input.policy === 'none') reasons.push('commands-none');
  if (!input.trusted) reasons.push('workspace-untrusted');
  if (input.restricted) reasons.push('mode-or-scope-restricted');
  return { canRequest: reasons.length === 0, reasons, policy: input.policy };
}

export function commandCapabilityText(facts: LiveCommandCapability): string {
  return facts.canRequest
    ? `command requests available; policy=${facts.policy}; each command is still checked and may require approval`
    : `command requests unavailable: ${facts.reasons.join(', ')}`;
}
