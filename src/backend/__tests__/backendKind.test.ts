import { describe, it, expect } from 'vitest';
import { apiKeySecretNameForProvider, defaultBackendKind, isSupportedProviderId } from '../backendKind';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';

const forProvider = (providerId: string) => defaultBackendKind({ provider: { providerId, apiKeySecretName: 'X' } });

describe('defaultBackendKind', () => {
  it('routes OpenAI-compatible providers to the in-process backend', () => {
    for (const p of ['roam', 'openai', 'openrouter']) {
      expect(forProvider(p), `${p} should be openai-compat`).toBe('openai-compat');
    }
  });

  it('routes everything else to the Claude backend', () => {
    for (const p of ['anthropic', 'google', 'ollama']) {
      expect(forProvider(p)).toBe('claude');
    }
  });

  it('OpenRouter (a built-in OpenAI-compatible provider) is NOT misrouted to Claude (v0.2.29 regression)', () => {
    expect(forProvider('openrouter')).toBe('openai-compat');
  });

  it('routes an opaque custom connection only through its supplied effective resolver', () => {
    const resolver = customGatewayResolver();
    expect(defaultBackendKind({ provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: CUSTOM_GATEWAY_SECRET_REF } }, resolver))
      .toBe('openai-compat');
    expect(isSupportedProviderId(CUSTOM_GATEWAY_ID)).toBe(false);
    expect(isSupportedProviderId(CUSTOM_GATEWAY_ID, resolver)).toBe(true);
    expect(apiKeySecretNameForProvider(CUSTOM_GATEWAY_ID, resolver)).toBe(CUSTOM_GATEWAY_SECRET_REF);
  });

  it('distinguishes supported providers from catalog-only placeholders', () => {
    expect(isSupportedProviderId('roam')).toBe(true);
    expect(isSupportedProviderId('openrouter')).toBe(true);
    expect(isSupportedProviderId('anthropic')).toBe(true);
    expect(isSupportedProviderId('google')).toBe(false);
    expect(isSupportedProviderId('ollama')).toBe(false);
  });

  it('returns a key only for API-key connections', () => {
    expect(apiKeySecretNameForProvider('anthropic')).toBeUndefined();
    expect(apiKeySecretNameForProvider('codex')).toBeUndefined();
    expect(apiKeySecretNameForProvider('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(apiKeySecretNameForProvider('roam')).toBe('ROAM_API_KEY');
  });
});
