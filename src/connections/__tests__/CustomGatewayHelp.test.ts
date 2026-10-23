import { describe, expect, it } from 'vitest';
import {
  CUSTOM_GATEWAY_EDIT_HELP,
  CUSTOM_GATEWAY_REMOVE_HELP,
  customGatewayEditBlockedMessage,
  customGatewayRemoveBlockedMessage,
} from '../CustomGatewayHelp';

describe('custom gateway UX help', () => {
  it('states the edit and removal rules before a user hits a guard', () => {
    expect(CUSTOM_GATEWAY_EDIT_HELP).toMatch(/no agent.*running/i);
    expect(CUSTOM_GATEWAY_REMOVE_HELP).toMatch(/agent, default, or Smart Mode tier/i);
  });

  it('names the running agent and every removal reference in actionable guard messages', () => {
    expect(customGatewayEditBlockedMessage(['Build Agent'])).toBe('Stop Build Agent, then edit this gateway.');
    expect(customGatewayRemoveBlockedMessage(['Build Agent', 'default provider', 'Smart Mode model tier']))
      .toContain('Build Agent, default provider, Smart Mode model tier');
  });
});
