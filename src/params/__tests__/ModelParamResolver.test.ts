import { describe, it, expect } from 'vitest';
import {
  ModelParamResolver, HARD_DEFAULTS, PROVIDER_DEFAULT_MODEL_PARAM_LABEL, REASONING_EFFORT_CHOICES, modelParamDefaultLabels,
  reasoningEffortBaseline,
} from '../ModelParamResolver';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../contextWindowDefaults';
import { ConfigStore } from '../../settings/SettingsBridge';
import { AgentConfig } from '../../types';

function fakeConfig(initial: Record<string, unknown> = {}): ConfigStore {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(k: string, fb: T) => (values.has(k) ? (values.get(k) as T) : fb),
    update: async (k, v) => { values.set(k, v); },
  };
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1',
    name: 'Dev',
    role: 'developer',
    skill: 'code-generation',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-v4-pro',
    systemPrompt: '',
    autoApprove: false,
    allowedTools: [],
    ...over,
  };
}

describe('ModelParamResolver (F2)', () => {
  it('falls back to hard defaults when nothing is configured', () => {
    const r = new ModelParamResolver(fakeConfig());
    const out = r.resolve(agent());
    expect(out.temperature).toBe(HARD_DEFAULTS.temperature);
    expect(out.max_tokens).toBe(HARD_DEFAULTS.max_tokens);
    expect(out.stream).toBe(HARD_DEFAULTS.stream);
  });

  it('global settings override hard defaults', () => {
    const r = new ModelParamResolver(
      fakeConfig({ 'modelDefaults.temperature': 1.2, 'modelDefaults.maxTokens': 8000 })
    );
    const out = r.resolve(agent());
    expect(out.temperature).toBe(1.2);
    expect(out.max_tokens).toBe(8000);
  });

  it('agent.modelParams wins over global and hard defaults', () => {
    const r = new ModelParamResolver(fakeConfig({ 'modelDefaults.temperature': 1.2 }));
    const out = r.resolve(agent({ modelParams: { temperature: 0.3 } }));
    expect(out.temperature).toBe(0.3);
  });

  it('smart-tier params win over global but lose to explicit agent params', () => {
    const r = new ModelParamResolver(fakeConfig({ 'modelDefaults.temperature': 1.2 }));
    // tier sets 0.9, no explicit agent value -> tier wins over global
    expect(r.resolve(agent(), { temperature: 0.9 }).temperature).toBe(0.9);
    // explicit agent value beats the tier
    expect(r.resolve(agent({ modelParams: { temperature: 0.3 } }), { temperature: 0.9 }).temperature).toBe(0.3);
  });

  it('legacy agent.temperature/maxTokens are honored below modelParams but above globals', () => {
    const r = new ModelParamResolver(fakeConfig({ 'modelDefaults.temperature': 1.2, 'modelDefaults.maxTokens': 9000 }));
    const out = r.resolve(agent({ temperature: 0.5, maxTokens: 2000 }));
    expect(out.temperature).toBe(0.5); // legacy beats global
    expect(out.max_tokens).toBe(2000);
  });

  it('maps reasoningEffort and responseFormat globals into the resolved shape', () => {
    const r = new ModelParamResolver(
      fakeConfig({ 'modelDefaults.reasoningEffort': 'high', 'modelDefaults.responseFormat': 'json_object' })
    );
    const out = r.resolve(agent());
    expect(out.reasoning_effort).toBe('high');
    expect(out.response_format).toEqual({ type: 'json_object' });
  });

  it('renders default labels from the same global/hard fallback layer used for requests', () => {
    const labels = modelParamDefaultLabels(fakeConfig({
      'modelDefaults.temperature': 0.2,
      'modelDefaults.topP': 0.9,
      'modelDefaults.maxTokens': 8192,
      'modelDefaults.reasoningEffort': 'high',
      'modelDefaults.responseFormat': 'json_object',
      'modelDefaults.stream': false,
    }));

    expect(labels).toMatchObject({
      temperature: '0.2',
      topP: '0.9',
      maxTokens: '8192',
      presencePenalty: 'provider default',
      frequencyPenalty: 'provider default',
      reasoningEffort: 'high',
      responseFormat: 'json_object',
      stream: 'off',
      thinking: 'provider default',
      toolChoice: 'provider default',
      stop: 'provider default',
      contextWindow: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
    });
  });

  it('labels explicitly empty defaults as provider defaults instead of inventing a concrete value', () => {
    const labels = modelParamDefaultLabels(fakeConfig({
      'modelDefaults.reasoningEffort': '',
      'modelDefaults.responseFormat': '',
      'modelDefaults.stream': null,
    }));

    expect(labels.reasoningEffort).toBe('provider default');
    expect(labels.responseFormat).toBe('provider default');
    expect(labels.stream).toBe('on'); // stream still has a hard fallback
  });

  it('omits fields that resolve to undefined (no spurious keys)', () => {
    const r = new ModelParamResolver(fakeConfig());
    const out = r.resolve(agent());
    // top_p has no hard default and nothing set it -> must be absent, not undefined
    expect('top_p' in out).toBe(false);
    expect('presence_penalty' in out).toBe(false);
  });
});

describe('reasoningEffortBaseline', () => {
  const defaults = (reasoningEffort: string) => ({ reasoningEffort });

  it('shows the value set on the agent, with the label Agent Builder gives it', () => {
    expect(reasoningEffortBaseline({ modelParams: { reasoning_effort: 'high' } }, defaults('medium'), true))
      .toEqual({ label: 'High', basis: 'Set on this agent.' });
    expect(reasoningEffortBaseline({ modelParams: { reasoning_effort: 'xhigh' } }, defaults(PROVIDER_DEFAULT_MODEL_PARAM_LABEL), true).label)
      .toBe('X-High');
    // Every value a person can choose has its label, and no other value is offered.
    expect(REASONING_EFFORT_CHOICES.map(([value]) => value)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('shows the inherited global default when the agent sets none, and Provider default when nothing is sent', () => {
    expect(reasoningEffortBaseline({ modelParams: {} }, defaults('low'), true))
      .toEqual({ label: 'Low', basis: 'Not set on this agent, so the global default applies.' });
    expect(reasoningEffortBaseline({}, defaults(PROVIDER_DEFAULT_MODEL_PARAM_LABEL), true))
      .toEqual({ label: 'Provider default', basis: 'Not set, so none is sent and the provider decides.' });
    // The value is the one the default-label authority reads from the settings; it is shown with the word a
    // chosen value has, and without a "(default)" suffix.
    expect(reasoningEffortBaseline({}, modelParamDefaultLabels(fakeConfig({ 'modelDefaults.reasoningEffort': 'high' })), true).label)
      .toBe('High');
    expect(reasoningEffortBaseline({}, defaults('medium'), true).label).not.toMatch(/default/i);
    expect(reasoningEffortBaseline({}, modelParamDefaultLabels(fakeConfig()), true).label).toBe('Provider default');
  });

  it('says Not supported on a route that does not take the field, whatever is saved', () => {
    const unsupported = { label: 'Not supported', basis: 'This route does not take a reasoning effort, so none is sent.' };
    expect(reasoningEffortBaseline({ modelParams: { reasoning_effort: 'high' } }, defaults('medium'), false)).toEqual(unsupported);
    expect(reasoningEffortBaseline({}, defaults(PROVIDER_DEFAULT_MODEL_PARAM_LABEL), false)).toEqual(unsupported);
  });
});
