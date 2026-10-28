import { describe, expect, it, vi } from 'vitest';
import { consentGatedFetch, EgressNotConsentedError } from '../../models/LivePriceService';
import { ConnectionResolver, EffectiveConnectionRegistry } from '../../routes/ConnectionRegistry';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';
import { testApiKeyConnection } from '../ConnectionTest';

const jsonResponse = {
  ok: true,
  status: 200,
  text: async () => '{"data":[]}',
};

describe('testApiKeyConnection', () => {
  it("uses a built-in connection's own registry endpoint and secret", async () => {
    const getSecret = vi.fn(async (secretRef: string) => secretRef === 'UNODE_API_KEY' ? 'unode-owned-key' : undefined);
    const ensureConsent = vi.fn(async () => {});
    const metadataFetch = vi.fn(async () => jsonResponse);

    const result = await testApiKeyConnection('unode', {
      resolver: new EffectiveConnectionRegistry(),
      getSecret,
      ensureConsent,
      metadataFetch,
    });

    expect(result).toEqual({ connectionId: 'unode', displayName: 'Unode' });
    expect(getSecret).toHaveBeenCalledOnce();
    expect(getSecret).toHaveBeenCalledWith('UNODE_API_KEY');
    expect(ensureConsent).toHaveBeenCalledWith('unode', 'https://www.unodetech.xyz/v1');
    expect(metadataFetch).toHaveBeenCalledWith('https://www.unodetech.xyz/v1/models', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer unode-owned-key',
      },
    });
    expect(ensureConsent.mock.invocationCallOrder[0]).toBeLessThan(metadataFetch.mock.invocationCallOrder[0]);
  });

  it('rejects an unknown or forged id before reading a secret or fetching', async () => {
    const getSecret = vi.fn(async () => 'should-not-be-read');
    const ensureConsent = vi.fn(async () => {});
    const metadataFetch = vi.fn(async () => jsonResponse);

    await expect(testApiKeyConnection('https://attacker.example/v1', {
      resolver: new EffectiveConnectionRegistry(),
      getSecret,
      ensureConsent,
      metadataFetch,
    })).rejects.toThrow('The selected connection cannot be tested');

    expect(getSecret).not.toHaveBeenCalled();
    expect(ensureConsent).not.toHaveBeenCalled();
    expect(metadataFetch).not.toHaveBeenCalled();
  });

  it('rejects CLI connections before secret access or egress', async () => {
    const getSecret = vi.fn(async () => 'should-not-be-read');
    const ensureConsent = vi.fn(async () => {});
    const metadataFetch = vi.fn(async () => jsonResponse);

    await expect(testApiKeyConnection('anthropic', {
      resolver: new EffectiveConnectionRegistry(),
      getSecret,
      ensureConsent,
      metadataFetch,
    })).rejects.toThrow('The selected connection cannot be tested');

    expect(getSecret).not.toHaveBeenCalled();
    expect(ensureConsent).not.toHaveBeenCalled();
    expect(metadataFetch).not.toHaveBeenCalled();
  });

  it('produces zero network egress when consent is declined', async () => {
    const innerFetch = vi.fn(async () => jsonResponse);
    const metadataFetch = consentGatedFetch(innerFetch, () => false);

    await expect(testApiKeyConnection('unode', {
      resolver: new EffectiveConnectionRegistry(),
      getSecret: async () => 'unode-owned-key',
      ensureConsent: async () => {},
      metadataFetch,
    })).rejects.toBeInstanceOf(EgressNotConsentedError);

    expect(innerFetch).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTPS registry endpoint before consent or fetch', async () => {
    const builtIns = new EffectiveConnectionRegistry();
    const unode = builtIns.connectionProfile('unode')!;
    const insecure = {
      ...unode,
      presentation: { ...unode.presentation, endpointDefault: 'http://insecure.example/v1' },
    };
    const resolver: ConnectionResolver = {
      revision: 1,
      profiles: [insecure],
      connectionProfile: (connectionId) => connectionId === 'unode' ? insecure : undefined,
      connectionIdForProviderId: (providerId) => providerId === 'unode' ? 'unode' : undefined,
      legacyProviderIdForConnectionId: (connectionId) => connectionId === 'unode' ? 'unode' : undefined,
    };
    const ensureConsent = vi.fn(async () => {});
    const metadataFetch = vi.fn(async () => jsonResponse);

    await expect(testApiKeyConnection('unode', {
      resolver,
      getSecret: async () => 'unode-owned-key',
      ensureConsent,
      metadataFetch,
    })).rejects.toThrow('does not have a secure model-catalog endpoint');

    expect(ensureConsent).not.toHaveBeenCalled();
    expect(metadataFetch).not.toHaveBeenCalled();
  });

  it('reports HTTP status without reflecting credential material', async () => {
    const apiKey = 'unode-owned-key';
    const error = await testApiKeyConnection('unode', {
      resolver: new EffectiveConnectionRegistry(),
      getSecret: async () => apiKey,
      ensureConsent: async () => {},
      metadataFetch: async () => ({ ok: false, status: 401, text: async () => '' }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Unode returned HTTP 401 while listing models.');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain('UNODE_API_KEY');
    expect((error as Error).message).not.toContain('Authorization');
  });

  it('reports the HTML endpoint diagnostic without leaking key or secret metadata', async () => {
    const apiKey = 'custom-owned-key';
    const metadataFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><title>Sign in</title>',
    }));

    const error = await testApiKeyConnection(CUSTOM_GATEWAY_ID, {
      resolver: customGatewayResolver(),
      getSecret: async (secretRef) => secretRef === CUSTOM_GATEWAY_SECRET_REF ? apiKey : undefined,
      ensureConsent: async () => {},
      metadataFetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('returned HTML, not JSON');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(CUSTOM_GATEWAY_SECRET_REF);
    expect((error as Error).message).not.toContain('Authorization');
  });

  it('sanitizes lower-level fetch errors instead of reflecting request credentials', async () => {
    const apiKey = 'custom-owned-key';
    const error = await testApiKeyConnection(CUSTOM_GATEWAY_ID, {
      resolver: customGatewayResolver(),
      getSecret: async () => apiKey,
      ensureConsent: async () => {},
      metadataFetch: async (_url, init) => {
        throw new Error(`failed with ${init?.headers?.Authorization} via ${CUSTOM_GATEWAY_SECRET_REF}`);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The model catalog for Fixture Gateway could not be reached.');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(CUSTOM_GATEWAY_SECRET_REF);
    expect((error as Error).message).not.toContain('Authorization');
  });
});
