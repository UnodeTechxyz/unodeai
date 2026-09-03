import { describe, expect, it } from 'vitest';
import {
  capabilityProfile,
  capabilityProfileForAgent,
  declaredNativeToolLeakRisk,
  SessionCapabilityOverlay,
} from '../CapabilityProfile';

describe('CapabilityProfile', () => {
  it('keeps declared, observed, and user-override facts separate with fixed precedence', () => {
    const overlay = new SessionCapabilityOverlay();
    overlay.observe('protocol', {
      initial: 'xml', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk: true,
    }, 'Observed text-form tool call.', '2026-08-05T00:00:00.000Z');
    const profile = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'kimi-k2.7-code',
      toolProtocol: 'native',
      contextWindowTokens: 128000,
      overlay,
    });

    expect(profile.key).toBe('gateway-a::kimi-k2.7-code');
    expect(profile.protocol.declared.source).toBe('declared');
    expect(profile.protocol.observed).toMatchObject({ source: 'observed', observedAt: '2026-08-05T00:00:00.000Z' });
    expect(profile.protocol.userOverride).toMatchObject({ source: 'user-override', value: { initial: 'native' } });
    expect(profile.protocol.effective).toBe(profile.protocol.userOverride);
    expect(profile.contextWindow.effective).toMatchObject({ source: 'user-override', value: { tokens: 128000 } });
  });

  it('exports observations only as an approval-required proposal and never changes a fresh profile', () => {
    const overlay = new SessionCapabilityOverlay();
    overlay.observe('samplingParameters', 'rejected', 'Gateway rejected temperature.', '2026-08-05T01:02:03.000Z');
    const proposal = overlay.proposal('gateway-a', 'model-a');
    const fresh = capabilityProfile({ connectionId: 'gateway-a', modelId: 'model-a' });

    expect(proposal).toMatchObject({
      key: 'gateway-a::model-a',
      requiresHumanApproval: true,
      observations: [{ field: 'samplingParameters', value: 'rejected' }],
    });
    expect(fresh.samplingParameters.effective).toMatchObject({ source: 'declared', value: 'accepted' });
  });

  it('projects a configured agent to exactly one connection × model profile', () => {
    const profile = capabilityProfileForAgent({
      id: 'a1', name: 'A', role: 'senior-dev', skill: '',
      provider: { providerId: 'legacy-provider', apiKeySecretName: 'KEY' },
      route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'gateway-a', modelId: 'glm-5.2' },
      model: 'ignored-when-route-is-present', systemPrompt: '', autoApprove: true, allowedTools: [],
    });

    expect(profile).toMatchObject({ connectionId: 'gateway-a', modelId: 'glm-5.2' });
    expect(profile.protocol.declared.value.knownNativeToolLeakRisk).toBe(true);
  });

  it('shows a persisted /models measurement as observed, while a user value remains effective', () => {
    const measured = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'model-a',
      measuredContextWindow: { model: 'model-a', tokens: 128_000, field: 'context_window' },
    });
    expect(measured.contextWindow.effective).toMatchObject({ source: 'observed', value: { tokens: 128_000 } });

    const overridden = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'model-a',
      contextWindowTokens: 64_000,
      measuredContextWindow: { model: 'model-a', tokens: 128_000, field: 'context_window' },
    });
    expect(overridden.contextWindow.effective).toMatchObject({ source: 'user-override', value: { tokens: 64_000 } });
  });

  // Gateways routinely advertise a model's raw window while the endpoint in front of it reserves part for
  // output, so a /models number larger than what is actually accepted is ordinary. A refusal is the only
  // hard evidence either way — and it can only ever argue downwards.
  it('lets a refused request tighten the advertised window, but never widen it', () => {
    const advertised = { model: 'model-a', tokens: 128_000, field: 'context_window' as const };
    const tightened = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'model-a',
      measuredContextWindow: advertised,
      observedContextWindow: { model: 'model-a', tokens: 96_000, observedAt: '2026-08-10T00:00:00.000Z' },
    });
    expect(tightened.contextWindow.effective).toMatchObject({ source: 'observed', value: { tokens: 96_000 } });
    expect(tightened.contextWindow.effective.detail).toMatch(/refused a request/);

    const looser = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'model-a',
      measuredContextWindow: advertised,
      observedContextWindow: { model: 'model-a', tokens: 512_000, observedAt: '2026-08-10T00:00:00.000Z' },
    });
    expect(looser.contextWindow.effective).toMatchObject({ value: { tokens: 128_000 } });

    const otherModel = capabilityProfile({
      connectionId: 'gateway-a',
      modelId: 'model-b',
      observedContextWindow: { model: 'model-a', tokens: 96_000, observedAt: '2026-08-10T00:00:00.000Z' },
    });
    expect(otherModel.contextWindow.effective.source).toBe('declared');
  });

  it('keeps the edit dialect in the same declared/observed/user-override precedence chain', () => {
    const overlay = new SessionCapabilityOverlay();
    overlay.observe('editToolDialect', { dialect: 'apply-patch' }, 'Observed an apply_patch-shaped edit call.');
    const observed = capabilityProfile({ connectionId: 'gateway-a', modelId: 'model-a', overlay });
    const overridden = capabilityProfile({ connectionId: 'gateway-a', modelId: 'model-a', editToolDialect: 'apply-edit', overlay });

    expect(observed.editToolDialect.effective).toMatchObject({ source: 'observed', value: { dialect: 'apply-patch' } });
    expect(overridden.editToolDialect.effective).toMatchObject({ source: 'user-override', value: { dialect: 'apply-edit' } });
  });

  it('recognizes declared native tool-call leak seeds, including version suffixes', () => {
    for (const model of ['kimi-k2.7-code', 'moonshot-v1-128k', 'glm-4.6', 'minimax-m1', 'K2']) {
      expect(declaredNativeToolLeakRisk(model)).toBe(true);
    }
  });

  it('does not mark frontier, native-clean, or DeepSeek models as declared leak risks', () => {
    for (const model of ['claude-opus-4-8', 'gpt-4o', 'gemini-2.5-pro', 'qwen-max', 'deepseek-v4-pro', 'deepseek-chat', '']) {
      expect(declaredNativeToolLeakRisk(model)).toBe(false);
    }
    expect(declaredNativeToolLeakRisk(undefined)).toBe(false);
  });
});
