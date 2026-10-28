import { describe, expect, it } from 'vitest';
import {
  CUSTOM_GATEWAY_EDIT_HELP,
  CUSTOM_GATEWAY_REMOVE_HELP,
  customGatewayEditWaitingMessage,
  customGatewayRemoveBlockedMessage,
} from '../CustomGatewayHelp';

describe('custom gateway UX help', () => {
  it('states the edit and removal rules before a user hits a guard', () => {
    // v0.9.99: an edit is never refused; it waits for a running turn.
    expect(CUSTOM_GATEWAY_EDIT_HELP).toMatch(/at any time/i);
    expect(CUSTOM_GATEWAY_EDIT_HELP).toMatch(/saved when that turn ends/i);
    expect(CUSTOM_GATEWAY_REMOVE_HELP).toMatch(/agent, default, or Smart Mode tier/i);
  });

  it('names the running agent and every removal reference in actionable guard messages', () => {
    expect(customGatewayEditWaitingMessage('Lab gateway', ['Build Agent']))
      .toBe('Your change to Lab gateway will be saved when Build Agent finishes the current turn. To save it now, press Stop on that agent in the Team panel.');
    expect(customGatewayEditWaitingMessage('Lab gateway', ['A', 'B'])).toContain('when A, B finish the current turn');
    expect(customGatewayRemoveBlockedMessage(['Build Agent', 'default provider', 'Smart Mode model tier']))
      .toContain('Build Agent, default provider, Smart Mode model tier');
  });
});
