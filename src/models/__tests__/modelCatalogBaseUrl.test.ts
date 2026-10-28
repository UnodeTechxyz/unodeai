import { describe, expect, it } from 'vitest';
import { resolveModelCatalogBaseUrl } from '../modelCatalogBaseUrl';
import { CUSTOM_GATEWAY_ID, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';

describe('resolveModelCatalogBaseUrl', () => {
  it.each([
    ['roam', 'https://ai.weroam.xyz/v1'],
    ['unode', 'https://www.unodetech.xyz/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['openai', 'https://api.openai.com/v1'],
  ])('pins %s /models lookup to its registered endpoint', (provider, expected) => {
    expect(resolveModelCatalogBaseUrl(provider)).toBe(expected);
  });

  it('uses no endpoint for an unknown custom connection', () => {
    expect(resolveModelCatalogBaseUrl('custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  it('uses only the selected profile endpoint for a custom connection', () => {
    const resolver = customGatewayResolver({ endpoint: 'https://gateway.example/v1/' });
    expect(resolveModelCatalogBaseUrl(CUSTOM_GATEWAY_ID, resolver)).toBe('https://gateway.example/v1');
  });
});
