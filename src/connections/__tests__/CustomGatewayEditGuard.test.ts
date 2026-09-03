import { describe, expect, it } from 'vitest';
import { isCustomGatewayEditBlockedStatus } from '../CustomGatewayEditGuard';

describe('custom gateway edit guard', () => {
  it('allows idle, stopped, and failed sessions because they have no in-flight turn', () => {
    expect(isCustomGatewayEditBlockedStatus('idle')).toBe(false);
    expect(isCustomGatewayEditBlockedStatus('stopped')).toBe(false);
    expect(isCustomGatewayEditBlockedStatus('error')).toBe(false);
  });

  it('blocks every in-flight lifecycle state', () => {
    expect(isCustomGatewayEditBlockedStatus('starting')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('consent_required')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('running')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('stopping')).toBe(true);
  });
});
