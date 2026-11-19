import { describe, expect, it } from 'vitest';
import { resolveOpenAICompatBaseUrl, requireHttpsCustomEndpoint } from '../openAICompatBaseUrl';
import type { AgentRoute } from '../../routes/RouteContracts';
import { CUSTOM_GATEWAY_ID, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';

function route(connectionId: 'roam' | 'unode' | 'openrouter' | 'openai' | typeof CUSTOM_GATEWAY_ID): AgentRoute {
  return { routeVersion: 1, kind: 'openai-compatible', connectionId, modelId: 'model-a' };
}

describe('resolveOpenAICompatBaseUrl', () => {
  it.each([
    ['roam', 'https://ai.weroam.xyz/v1'],
    ['unode', 'https://www.unodetech.xyz/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['openai', 'https://api.openai.com/v1'],
  ] as const)('pins the %s route to its registry endpoint', (connectionId, expected) => {
    expect(resolveOpenAICompatBaseUrl(route(connectionId))).toBe(expected);
  });

  it('uses the profile-owned endpoint for a custom route', () => {
    expect(resolveOpenAICompatBaseUrl(route(CUSTOM_GATEWAY_ID), customGatewayResolver({ endpoint: ' https://gateway.example/v1/ ' })))
      .toBe('https://gateway.example/v1');
  });

  it.each([
    'http://gateway.example/v1',
    'https://user:pass@gateway.example/v1',
    'https://gateway.example/v1?token=secret',
    'not a url',
  ])('rejects an unsafe Custom endpoint: %s', (endpoint) => {
    expect(() => requireHttpsCustomEndpoint(endpoint)).toThrow();
  });

  it('does not accept a CLI route as an OpenAI-compatible endpoint', () => {
    expect(() => resolveOpenAICompatBaseUrl({
      routeVersion: 1,
      kind: 'claude-headless',
      connectionId: 'claude-cli',
      modelId: 'claude-cli-default',
    })).toThrow(/not an OpenAI-compatible/);
  });

  it('rejects an unknown custom route before it can resolve an endpoint', () => {
    expect(() => resolveOpenAICompatBaseUrl(route(CUSTOM_GATEWAY_ID))).toThrow(/unknown connection/);
  });
});
