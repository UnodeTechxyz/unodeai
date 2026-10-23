import { describe, expect, it } from 'vitest';
import { modelRejectsSamplingParameters, omitSamplingParametersForModel } from '../samplingParamCompatibility';

describe('sampling-parameter model compatibility', () => {
  it.each([
    'claude-opus-4-7',
    'anthropic/claude-opus-4.8-20260701',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'gpt-5',
    'gpt-5.6',
    'opus',
  ])('recognizes %s as rejecting sampling parameters', (model) => {
    expect(modelRejectsSamplingParameters(model)).toBe(true);
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4.1', 'deepseek-v4-pro'])
  ('does not over-match %s', (model) => {
    expect(modelRejectsSamplingParameters(model)).toBe(false);
  });

  // The whole table checked against the authoritative model list in one place, because the boundary is
  // the hard part: 4.6 accepts sampling parameters and 4.7 onward reject them, and a wrong call in the
  // permissive direction is a 400 on every request while a wrong call the other way silently strips a
  // parameter the user set. Mythos 5 was missing from the first version — invitation-only, so exactly the
  // kind of entry nobody notices is absent.
  it.each([
    ['claude-opus-5', true],
    ['claude-opus-4-8', true],
    ['claude-opus-4-7', true],
    ['claude-opus-4-6', false],
    ['claude-sonnet-4-6', false],
    ['claude-sonnet-5', true],
    ['claude-fable-5', true],
    ['claude-mythos-5', true],
    ['claude-haiku-4-5', false],
    ['claude-opus-4-5', false],
    ['gpt-5', true],
    ['gpt-4o', false],
    ['anthropic/claude-opus-4-6', false],
    ['deepseek-v4-pro', false],
  ])('classifies %s as rejecting=%s', (model, rejects) => {
    expect(modelRejectsSamplingParameters(model as string)).toBe(rejects as boolean);
  });

  it('removes only sampling fields for a known incompatible model', () => {
    expect(omitSamplingParametersForModel('gpt-5', {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096,
      reasoning_effort: 'high',
    })).toEqual({ max_tokens: 4096, reasoning_effort: 'high' });
  });
});
