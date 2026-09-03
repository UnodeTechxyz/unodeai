import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3,
  },
}));

vi.mock('vscode', () => vscodeMock);

import { decideFixtureApiKeyAction, isE2EFixtureRequest } from '../E2EFixture';

describe('isE2EFixtureRequest', () => {
  it('accepts the marker only in VS Code Test mode', () => {
    expect(isE2EFixtureRequest(vscodeMock.ExtensionMode.Test as never, { e2e: true })).toBe(true);
    expect(isE2EFixtureRequest(vscodeMock.ExtensionMode.Development as never, { e2e: true })).toBe(false);
    expect(isE2EFixtureRequest(vscodeMock.ExtensionMode.Production as never, { e2e: true })).toBe(false);
    expect(isE2EFixtureRequest(vscodeMock.ExtensionMode.Test as never, { e2e: false })).toBe(false);
    expect(isE2EFixtureRequest(vscodeMock.ExtensionMode.Test as never, undefined)).toBe(false);
  });
});

describe('decideFixtureApiKeyAction', () => {
  it('never overwrites a key the profile already had', () => {
    expect(decideFixtureApiKeyAction({ clearRequested: false, keyExists: true, createdByFixture: false }))
      .toBe('leave');
  });

  it('never removes a key it did not create, even when teardown asks', () => {
    expect(decideFixtureApiKeyAction({ clearRequested: true, keyExists: true, createdByFixture: false }))
      .toBe('leave');
  });

  it('creates an offline key only into an empty slot, and removes exactly that one', () => {
    expect(decideFixtureApiKeyAction({ clearRequested: false, keyExists: false, createdByFixture: false }))
      .toBe('create');
    expect(decideFixtureApiKeyAction({ clearRequested: true, keyExists: true, createdByFixture: true }))
      .toBe('remove');
  });
});
