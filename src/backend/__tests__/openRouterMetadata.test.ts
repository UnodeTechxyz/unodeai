import { describe, expect, it } from 'vitest';
import { openRouterSelectedProvider, requestsOpenRouterMetadata } from '../openRouterMetadata';
import { OpenAIStreamReconstructor } from '../sseParser';

/** OpenRouter's documented routing metadata (Router Metadata guide), as it rides on a response. */
const routed = (available: unknown) => ({ id: 'gen-1', openrouter_metadata: { requested: 'deepseek/deepseek-v4-pro-0813', strategy: 'direct', attempt: 1, endpoints: { total: 2, available } } });

describe('OpenRouter upstream provider (v0.9.90 §8)', () => {
  it('asks only OpenRouter itself for routing metadata', () => {
    expect(requestsOpenRouterMetadata('https://openrouter.ai/api/v1')).toBe(true);
    expect(requestsOpenRouterMetadata('https://OpenRouter.ai/api/v1')).toBe(true);
    for (const other of ['http://openrouter.ai/api/v1', 'https://openrouter.ai.attacker.test/v1', 'https://attacker.test/openrouter.ai',
      'https://ai.weroam.xyz/v1', 'not a url', undefined]) {
      expect(requestsOpenRouterMetadata(other)).toBe(false);
    }
  });

  it('names the one selected endpoint\'s provider and nothing else', () => {
    expect(openRouterSelectedProvider(routed([
      { provider: 'Novita', model: 'deepseek/deepseek-v4-pro-0813', selected: false },
      { provider: 'DeepInfra', model: 'deepseek/deepseek-v4-pro-0813', selected: true },
    ]))).toBe('DeepInfra');
  });

  it('says nothing when the metadata is missing or malformed, and never throws', () => {
    const cases: unknown[] = [
      undefined, null, 'text', {}, { openrouter_metadata: 'x' }, routed('not-an-array'),
      routed([{ provider: 'DeepInfra' }]),
      routed([{ provider: 'A', selected: true }, { provider: 'B', selected: true }]),
      routed([{ provider: 42, selected: true }]),
      routed([{ provider: ' \u0000\u001b ', selected: true }]),
      routed([null, 7]),
    ];
    for (const response of cases) expect(openRouterSelectedProvider(response)).toBeUndefined();
    expect(openRouterSelectedProvider(routed([{ provider: `P${'x'.repeat(200)}`, selected: true }]))).toHaveLength(100);
  });

  it('keeps a provider name to plain text: no control, bidi or Markdown character survives', () => {
    const named = (provider: string) => openRouterSelectedProvider(routed([{ provider, selected: true }]));
    expect(named('Google AI Studio')).toBe('Google AI Studio');
    expect(named('Amazon Bedrock (us-east-1)')).toBe('Amazon Bedrock us-east-1');
    // A link-like name cannot become a link, and emphasis or code markup is gone.
    expect(named('[DeepInfra](https://evil.example/login)')).toBe('DeepInfrahttps//evil.example/login');
    expect(named('**Deep**`Infra`_x_')).toBe('DeepInfrax');
    // Bidirectional overrides and isolates could make one name read as another.
    expect(named('Deep\u202EarfnI\u202C\u2066x\u2069\u200F')).toBe('DeeparfnIx');
    expect(named('Deep\u001b[31mInfra')).toBe('Deep31mInfra');
  });

  it('keeps the id and the final chunk\'s routing metadata when a response streams', () => {
    const stream = new OpenAIStreamReconstructor();
    stream.accept({ id: 'gen-9', choices: [{ delta: { role: 'assistant' } }] });
    stream.accept({ id: 'gen-9', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    stream.accept({ id: 'gen-9', choices: [], ...routed([{ provider: 'DeepInfra', selected: true }]) });
    const result = stream.result();
    expect(result.id).toBe('gen-9');
    expect(openRouterSelectedProvider(result)).toBe('DeepInfra');
  });
});
