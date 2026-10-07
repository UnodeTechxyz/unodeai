import { describe, expect, it } from 'vitest';
import {
  compareEffectiveExecutionIdentities,
  createEffectiveExecutionIdentity,
} from '../EffectiveExecutionIdentity';

describe('host-private effective execution identity', () => {
  it('keeps reported-model and configured-route comparisons as two separate facts', () => {
    const same = compareEffectiveExecutionIdentities(
      createEffectiveExecutionIdentity('model-a', 'custom:one', 4),
      createEffectiveExecutionIdentity('model-a', 'custom:one', 4),
    );
    expect(same).toEqual({ sameReportedModel: true, sameConfiguredRouteAndModel: true });

    const differentModel = compareEffectiveExecutionIdentities(
      createEffectiveExecutionIdentity('model-a', 'custom:one', 4),
      createEffectiveExecutionIdentity('model-b', 'custom:one', 4),
    );
    expect(differentModel).toEqual({ sameReportedModel: false, sameConfiguredRouteAndModel: false });

    const differentRoute = compareEffectiveExecutionIdentities(
      createEffectiveExecutionIdentity('model-a', 'custom:one', 4),
      createEffectiveExecutionIdentity('model-a', 'custom:one', 5),
    );
    expect(differentRoute).toEqual({ sameReportedModel: true, sameConfiguredRouteAndModel: false });
  });

  it('uses the profile revision, so an endpoint change under one connection id is observable', () => {
    const beforeEndpointChange = createEffectiveExecutionIdentity('model-a', 'custom:stable-id', 1);
    const afterEndpointChange = createEffectiveExecutionIdentity('model-a', 'custom:stable-id', 2);
    expect(compareEffectiveExecutionIdentities(beforeEndpointChange, afterEndpointChange))
      .toEqual({ sameReportedModel: true, sameConfiguredRouteAndModel: false });
  });

  it('exports neither an equals decision nor an execution verdict', () => {
    const identity = createEffectiveExecutionIdentity('model-a', 'unode', 1) as Record<string, unknown>;
    const comparison = compareEffectiveExecutionIdentities(
      createEffectiveExecutionIdentity('model-a', 'unode', 1),
      createEffectiveExecutionIdentity('model-a', 'unode', 1),
    ) as Record<string, unknown>;
    expect(identity).not.toHaveProperty('equals');
    expect(comparison).toEqual({ sameReportedModel: true, sameConfiguredRouteAndModel: true });
    expect(comparison).not.toHaveProperty('verdict');
  });
});
