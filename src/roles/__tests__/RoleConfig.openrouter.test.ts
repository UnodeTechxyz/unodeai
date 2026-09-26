import { describe, expect, it } from 'vitest';
import { resolveOpenAICompatBaseUrl } from '../../backend/openAICompatBaseUrl';
import { BUILTIN_CONNECTION_REGISTRY, connectionProfile, providerRefForConnectionId } from '../../routes/ConnectionRegistry';

describe('OpenRouter provider defaults', () => {
  it('registers OpenRouter with its own API key secret', () => {
    expect(providerRefForConnectionId('openrouter')).toMatchObject({
      providerId: 'openrouter',
      apiKeySecretName: 'OPENROUTER_API_KEY',
    });
  });

  it('configures OpenRouter as an OpenAI-compatible gateway with default models', () => {
    const profile = connectionProfile('openrouter')!;

    expect(profile).toMatchObject({
      id: 'openrouter',
      kind: 'openai-compatible',
      backendKind: 'openai-compat',
      apiKeySecretName: 'OPENROUTER_API_KEY',
    });
    expect(profile.presentation.endpointDefault).toBe('https://openrouter.ai/api/v1');
    expect(profile.catalogModels.length).toBeGreaterThanOrEqual(3);
    expect(profile.catalogModels.map((m) => m.id)).toEqual(expect.arrayContaining([
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.1-70b-instruct',
    ]));
  });

  it('resolves OpenRouter through the OpenAI-compatible base URL helper', () => {
    expect(
      resolveOpenAICompatBaseUrl(
        { routeVersion: 1, kind: 'openai-compatible', connectionId: 'openrouter', modelId: 'openai/gpt-4o' },
        BUILTIN_CONNECTION_REGISTRY
      )
    ).toBe('https://openrouter.ai/api/v1');
  });
});
