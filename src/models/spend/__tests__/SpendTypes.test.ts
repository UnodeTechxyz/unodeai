import { describe, expect, it } from 'vitest';
import { canonicalJson, emptySpendControl, eventIdentityPayload, validDisplayCost, validateSpendControl, validateSpendEvent } from '../SpendTypes';

const envelope = { schemaVersion: 1, hostEpoch: 'h1', sequence: 1, recordedAt: '2026-09-27T10:00:00.000Z' };

describe('spend event validation', () => {
  it('accepts the closed shapes with deterministic ids', () => {
    expect(validateSpendEvent({ ...envelope, eventId: 'start:u1:1', kind: 'usage-unit-start', usageUnitId: 'u1', requestId: 'r1', agentId: 'pm', connectionId: 'custom:abc', modelId: 'vendor/model-1', providerAttempts: 1 })).toBeDefined();
    expect(validateSpendEvent({ ...envelope, eventId: 'gap:u1', kind: 'coverage-gap', usageUnitId: 'u1', requestId: 'r1', reason: 'no-terminal-usage' })).toBeDefined();
  });

  it('fails closed on unknown versions, keys, kinds and mismatched ids', () => {
    const gap = { ...envelope, eventId: 'gap:u1', kind: 'coverage-gap', usageUnitId: 'u1', requestId: 'r1', reason: 'no-terminal-usage' };
    expect(validateSpendEvent({ ...gap, schemaVersion: 2 })).toBeUndefined();
    expect(validateSpendEvent({ ...gap, extra: 1 })).toBeUndefined();
    expect(validateSpendEvent({ ...gap, kind: 'budget-stop' })).toBeUndefined();
    expect(validateSpendEvent({ ...gap, eventId: 'gap:u2' })).toBeUndefined();
    expect(validateSpendEvent({ ...gap, sequence: 0 })).toBeUndefined();
    const progress = {
      ...envelope, eventId: 'progress:u1:1', kind: 'usage-progress', progressId: 'progress:u1:1', usageUnitId: 'u1', requestId: 'r1', providerAttempt: 1,
      tokens: { input: 1, output: 1, basis: 'reported' }, displayCost: { basis: 'unavailable' }, reminderValue: { tokens: 2, basis: 'reported-tokens' },
    };
    expect(validateSpendEvent(progress)).toBeDefined();
    // Progress is always exact reported usage.
    expect(validateSpendEvent({ ...progress, tokens: { input: 1, output: 1, basis: 'reconstructed' } })).toBeUndefined();
    // A reminder basis must match what it carries.
    expect(validateSpendEvent({ ...progress, reminderValue: { basis: 'not-eligible', tokens: 2 } })).toBeUndefined();
    // Cached input is a subset of input.
    expect(validateSpendEvent({ ...progress, tokens: { input: 1, cachedInput: 2, output: 1, basis: 'reported' } })).toBeUndefined();
  });

  it('never accepts a display cost that is both unavailable and priced', () => {
    expect(validDisplayCost({ basis: 'unavailable' })).toBe(true);
    expect(validDisplayCost({ basis: 'unavailable', nanoUsd: '1', sourceId: 'x' })).toBe(false);
    expect(validDisplayCost({ basis: 'unavailable', nanoUsd: '1' })).toBe(false);
    expect(validDisplayCost({ basis: 'billed', nanoUsd: '1', sourceId: 'x' })).toBe(true);
    expect(validDisplayCost({ basis: 'billed', sourceId: 'x' })).toBe(false);
  });

  it('identifies duplicates by payload, not envelope', () => {
    const a = validateSpendEvent({ ...envelope, eventId: 'gap:u1', kind: 'coverage-gap', usageUnitId: 'u1', requestId: 'r1', reason: 'no-terminal-usage' })!;
    const b = { ...a, hostEpoch: 'h2', sequence: 7, recordedAt: '2026-09-28T00:00:00.000Z' };
    expect(eventIdentityPayload(a)).toBe(eventIdentityPayload(b));
  });
});

describe('control validation', () => {
  it('accepts the empty control and rejects an unknown schema', () => {
    expect(validateSpendControl(emptySpendControl())).toBeDefined();
    expect(validateSpendControl({ ...emptySpendControl(), schemaVersion: 2 })).toBeUndefined();
    expect(validateSpendControl({ ...emptySpendControl(), repositoryTargetDecision: { mode: 'accepted-digest', contentDigest: 'x', decidedAt: envelope.recordedAt } })).toBeUndefined();
    expect(validateSpendControl({ ...emptySpendControl(), resets: [{ resetId: 'r', scope: 'request', resetAt: envelope.recordedAt, actor: 'user', watermarks: {}, previousTotals: { eligibleTokens: 0, eligibleNanoUsd: '0', displayTokens: 0 } }] })).toBeUndefined();
  });

  it('writes canonical JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});
