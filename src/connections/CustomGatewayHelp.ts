/** User-facing rules shared by the custom-gateway controls and their host-side guards. */
export const CUSTOM_GATEWAY_EDIT_HELP =
  'Edit endpoint/key while no agent using this gateway is running. Stop the agent first.';

export const CUSTOM_GATEWAY_REMOVE_HELP =
  'Remove only when no agent, default, or Smart Mode tier points at it. Rebind those first.';

export function customGatewayEditBlockedMessage(agentNames: readonly string[]): string {
  return `Stop ${agentNames.join(', ')}, then edit this gateway.`;
}

export function customGatewayRemoveBlockedMessage(references: readonly string[]): string {
  return `Cannot remove this custom gateway while it is referenced by: ${references.join(', ')}. Rebind those references first, then try again.`;
}
