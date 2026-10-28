/** User-facing rules shared by the custom-gateway controls and their host-side guards. */
export const CUSTOM_GATEWAY_EDIT_HELP =
  'Edit the endpoint or key at any time. If an agent using this gateway is in the middle of a turn, the change is saved when that turn ends.';

export const CUSTOM_GATEWAY_REMOVE_HELP =
  'Remove only when no agent, default, or Smart Mode tier points at it. Rebind those first.';

/** v0.9.99: an edit made while an agent is mid-turn waits for the turn to end instead of being refused. */
export function customGatewayEditWaitingMessage(gatewayName: string, agentNames: readonly string[]): string {
  const who = agentNames.join(', ');
  const plural = agentNames.length !== 1;
  return `Your change to ${gatewayName} will be saved when ${who} finish${plural ? '' : 'es'} the current turn. `
    + `To save it now, press Stop on ${plural ? 'those agents' : 'that agent'} in the Team panel.`;
}

export function customGatewayRemoveBlockedMessage(references: readonly string[]): string {
  return `Cannot remove this custom gateway while it is referenced by: ${references.join(', ')}. Rebind those references first, then try again.`;
}
