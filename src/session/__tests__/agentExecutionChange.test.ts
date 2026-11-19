import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentExecutionChanged } from '../agentExecutionChange';
import type { AgentConfig } from '../../types';

// v0.9.101 (H2a, audit H2a-1): which agent edits replace the coordinator a waiting request waits with.
describe('agentExecutionChanged', () => {
  const base: Pick<AgentConfig, 'model' | 'backend' | 'route' | 'baseUrl' | 'provider'> = {
    model: 'gpt-a', backend: 'openai-compat', baseUrl: 'https://example.invalid/v1',
    provider: { providerId: 'roam', apiKeySecretName: 'K' },
  } as AgentConfig;

  it('is false for an edit that keeps the model and the connection', () => {
    expect(agentExecutionChanged(base, { ...base }, 'openai-compat')).toBe(false);
    expect(agentExecutionChanged({ ...base, backend: undefined }, base, 'openai-compat')).toBe(false);
  });

  it('is true for a new model, backend kind, endpoint or provider', () => {
    expect(agentExecutionChanged(base, { ...base, model: 'gpt-b' }, 'openai-compat')).toBe(true);
    expect(agentExecutionChanged(base, { ...base, backend: 'claude' }, 'openai-compat')).toBe(true);
    expect(agentExecutionChanged(base, { ...base, baseUrl: 'https://other.invalid/v1' }, 'openai-compat')).toBe(true);
    expect(agentExecutionChanged(base, { ...base, provider: { providerId: 'other', apiKeySecretName: 'K' } }, 'openai-compat')).toBe(true);
  });

  it('the agent editor passes it to configEdited, computed before the edit replaces the configuration', () => {
    const source = readFileSync('src/extension.ts', 'utf8');
    const computed = source.indexOf('const executionChanged = agentExecutionChanged(existing.config, config, priorBackendKind);');
    const committed = source.indexOf('committed = await agentRosterEdits.commit(config, existing.config', computed);
    const told = source.indexOf('await sessionManager.configEdited(existing.id, { backendKindChanged, executionChanged });', computed);
    expect(computed).toBeGreaterThan(0);
    expect(committed).toBeGreaterThan(computed);
    expect(told).toBeGreaterThan(committed);
    // The only caller: every agent edit reaches configEdited with the fact.
    expect(source.split('sessionManager.configEdited(').length - 1).toBe(1);
  });
});
