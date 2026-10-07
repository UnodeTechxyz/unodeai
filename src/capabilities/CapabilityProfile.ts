import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../contextWindowDefaults';
import type { AgentConfig, AgentModelParams, ContextWindowBound, ContextWindowMeasurement, EditToolDialect, ToolProtocolKind } from '../types';

/** Where a capability fact came from. This order is the profile ratchet. */
export type CapabilityFactSource = 'declared' | 'observed' | 'user-override';

export interface CapabilityEvidence<T> {
  readonly source: CapabilityFactSource;
  readonly value: T;
  /** Human-readable, non-secret explanation suitable for Settings. */
  readonly detail: string;
  /** Present only for runtime observations. */
  readonly observedAt?: string;
}

/** A field retains every available fact while exposing its non-negotiable effective one. */
export interface CapabilityFact<T> {
  readonly declared: CapabilityEvidence<T>;
  readonly observed?: CapabilityEvidence<T>;
  readonly userOverride?: CapabilityEvidence<T>;
  readonly effective: CapabilityEvidence<T>;
}

export interface ProtocolCapability {
  readonly initial: ToolProtocolKind;
  readonly fallbackAfterTextLeak: 'xml';
  readonly knownNativeToolLeakRisk: boolean;
}

export type SamplingParameterCompatibility = 'accepted' | 'rejected';

export interface ContextWindowPolicy {
  readonly tokens?: number;
  readonly compactionThreshold: 0.7;
  readonly toolStopThreshold: 0.8;
}

export interface RecoveryCapability {
  readonly samplingParameter400: 'retry-without-sampling-parameters';
  readonly textToolCall: 'latch-xml-for-session';
  readonly requestShape: 'session-self-heal-ladder';
}

/** The edit syntax advertised to a model. This is a tool-surface fact, not a per-model conditional. */
export interface EditToolDialectCapability {
  readonly dialect: EditToolDialect;
}

export interface CapabilityProfile {
  readonly key: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly protocol: CapabilityFact<ProtocolCapability>;
  readonly samplingParameters: CapabilityFact<SamplingParameterCompatibility>;
  readonly contextWindow: CapabilityFact<ContextWindowPolicy>;
  readonly recovery: CapabilityFact<RecoveryCapability>;
  readonly editToolDialect: CapabilityFact<EditToolDialectCapability>;
}

export type CapabilityProfileField = 'protocol' | 'samplingParameters' | 'contextWindow' | 'recovery' | 'editToolDialect';

export interface CapabilityObservation<T = unknown> {
  readonly field: CapabilityProfileField;
  readonly value: T;
  readonly detail: string;
  readonly observedAt: string;
}

export interface CapabilityPersistenceProposal {
  readonly key: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly observations: readonly CapabilityObservation[];
  /** Explicitly signals that host code must ask a human before changing durable configuration. */
  readonly requiresHumanApproval: true;
}

/**
 * Per-backend-session observations. It has no persistence API: callers may inspect a proposal, but
 * durable configuration remains human-owned. A new backend gets a new overlay.
 */
export class SessionCapabilityOverlay {
  private readonly observations = new Map<CapabilityProfileField, CapabilityObservation>();

  observe<T>(field: CapabilityProfileField, value: T, detail: string, observedAt = new Date().toISOString()): void {
    this.observations.set(field, { field, value, detail, observedAt });
  }

  get<T>(field: CapabilityProfileField): CapabilityEvidence<T> | undefined {
    const observation = this.observations.get(field);
    return observation
      ? { source: 'observed', value: observation.value as T, detail: observation.detail, observedAt: observation.observedAt }
      : undefined;
  }

  all(): readonly CapabilityObservation[] {
    return [...this.observations.values()];
  }

  proposal(connectionId: string, modelId: string): CapabilityPersistenceProposal | undefined {
    const observations = this.all();
    return observations.length === 0
      ? undefined
      : {
        key: capabilityProfileKey(connectionId, modelId),
        connectionId,
        modelId,
        observations,
        requiresHumanApproval: true,
      };
  }
}

export interface CapabilityProfileInput {
  readonly connectionId: string;
  readonly modelId: string;
  readonly toolProtocol?: ToolProtocolKind;
  readonly editToolDialect?: EditToolDialect;
  readonly contextWindowTokens?: number;
  /** A user-approved `/models` observation for the exact selected model. */
  readonly measuredContextWindow?: ContextWindowMeasurement;
  /** A ceiling the provider proved by refusing a request of a known size on this exact model. */
  readonly observedContextWindow?: ContextWindowBound;
  readonly overlay?: SessionCapabilityOverlay;
}

/** The prior XML hint list now lives only as a cold-start declared profile seed. */
export const DECLARED_PROTOCOL_LEAK_MODEL_HINTS = Object.freeze(['kimi', 'k2', 'moonshot', 'glm', 'minimax']);

/** Kept in the profile because it is a declared sampling-compatibility fact, not a UI-only table. */
export const DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY = Object.freeze({
  latestAliases: ['opus', 'sonnet', 'fable'],
  versionFivePrefixes: [
    'gpt-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5',
    'opus-5', 'sonnet-5', 'fable-5', 'mythos-5',
  ],
  claudeOpusFourPrefix: 'claude-opus-4-',
  claudeOpusFourMinimumMinor: 7,
});

export const SAMPLING_PARAMETER_KEYS = Object.freeze(['temperature', 'top_p', 'top_k'] as const);

export const SAMPLING_PARAMETER_REJECTION_REASON =
  'This model rejects sampling parameters (temperature and top P), so those controls are disabled and are not sent.';

export function capabilityProfileKey(connectionId: string, modelId: string): string {
  return `${connectionId.trim().toLowerCase() || 'unknown'}::${modelId.trim().toLowerCase() || 'unknown'}`;
}

/** Builds the immutable connection × model profile; observations are supplied only by its session overlay. */
export function capabilityProfile(input: CapabilityProfileInput): CapabilityProfile {
  const connectionId = input.connectionId.trim() || 'unknown';
  const modelId = input.modelId.trim() || 'unknown';
  const nativeLeakRisk = declaredNativeToolLeakRisk(modelId);
  const protocolDeclared: CapabilityEvidence<ProtocolCapability> = {
    source: 'declared',
    value: { initial: 'native', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk: nativeLeakRisk },
    detail: nativeLeakRisk
      ? 'Declared cold-start seed: this model family has previously leaked native tool calls as text.'
      : 'Declared default: start with native tools and recover to XML only after a text-form leak.',
  };
  const protocolOverride: CapabilityEvidence<ProtocolCapability> | undefined = input.toolProtocol
    ? evidence('user-override', {
      initial: input.toolProtocol,
      fallbackAfterTextLeak: 'xml',
      knownNativeToolLeakRisk: nativeLeakRisk,
    }, `Agent configuration explicitly selected ${input.toolProtocol} tool calling.`)
    : undefined;
  const samplingRejected = declaredSamplingParametersRejected(modelId);
  const samplingDeclared = evidence<SamplingParameterCompatibility>(
    'declared',
    samplingRejected ? 'rejected' : 'accepted',
    samplingRejected
      ? 'Declared model-generation compatibility: omit temperature and top P.'
      : 'Declared model-generation compatibility: sampling parameters may be sent.',
  );
  const contextDeclared = evidence<ContextWindowPolicy>(
    'declared',
    { compactionThreshold: 0.7, toolStopThreshold: 0.8 },
    'Declared default: compact at 70% of the context window and stop new tool calls at 80%.',
  );
  const contextOverride: CapabilityEvidence<ContextWindowPolicy> | undefined = input.contextWindowTokens && input.contextWindowTokens > 0
    ? evidence('user-override', { tokens: input.contextWindowTokens, compactionThreshold: 0.7, toolStopThreshold: 0.8 }, 'Agent configuration explicitly set this context window.')
    : undefined;
  const measurement = input.measuredContextWindow;
  const contextObserved: CapabilityEvidence<ContextWindowPolicy> | undefined = measurement
    && measurement.model === modelId
    && Number.isSafeInteger(measurement.tokens)
    && measurement.tokens > 0
    ? evidence(
      'observed',
      { tokens: measurement.tokens, compactionThreshold: 0.7, toolStopThreshold: 0.8 },
      `Gateway /models metadata advertised ${measurement.tokens.toLocaleString()} tokens via ${measurement.field}.`,
    )
    : undefined;
  // A refusal beats an advertisement, downwards only: gateways routinely advertise a model's raw window
  // while reserving part of it for output, so a `/models` number larger than what the endpoint accepts is
  // the ordinary case. Same tie-break as resolveContextWindow, kept in step with it deliberately.
  const bound = input.observedContextWindow;
  const advertisedTokens = contextObserved ? measurement!.tokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const contextRefused: CapabilityEvidence<ContextWindowPolicy> | undefined = bound
    && bound.model === modelId
    && Number.isSafeInteger(bound.tokens)
    && bound.tokens > 0
    && bound.tokens < advertisedTokens
    ? evidence(
      'observed',
      { tokens: bound.tokens, compactionThreshold: 0.7, toolStopThreshold: 0.8 },
      `Provider refused a request of about ${bound.tokens.toLocaleString()} tokens on ${bound.observedAt}; treated as a ceiling.`,
    )
    : undefined;
  const recoveryDeclared = evidence<RecoveryCapability>('declared', {
    samplingParameter400: 'retry-without-sampling-parameters',
    textToolCall: 'latch-xml-for-session',
    requestShape: 'session-self-heal-ladder',
  }, 'Declared session recovery behaviours; observations never rewrite this global fact.');
  const editToolDialectDeclared = evidence<EditToolDialectCapability>(
    'declared',
    { dialect: 'apply-edit' },
    'Declared default: exact-snippet apply_edit surface.',
  );
  const editToolDialectOverride = input.editToolDialect
    ? evidence<EditToolDialectCapability>(
      'user-override',
      { dialect: input.editToolDialect },
      `Agent configuration explicitly selected the ${input.editToolDialect} edit surface.`,
    )
    : undefined;
  const overlay = input.overlay;
  return {
    key: capabilityProfileKey(connectionId, modelId),
    connectionId,
    modelId,
    protocol: fact(protocolDeclared, overlay?.get<ProtocolCapability>('protocol'), protocolOverride),
    samplingParameters: fact(samplingDeclared, overlay?.get<SamplingParameterCompatibility>('samplingParameters')),
    contextWindow: fact(contextDeclared, overlay?.get<ContextWindowPolicy>('contextWindow') ?? contextRefused ?? contextObserved, contextOverride),
    recovery: fact(recoveryDeclared, overlay?.get<RecoveryCapability>('recovery')),
    editToolDialect: fact(editToolDialectDeclared, overlay?.get<EditToolDialectCapability>('editToolDialect'), editToolDialectOverride),
  };
}

export function capabilityProfileForAgent(config: AgentConfig, overlay?: SessionCapabilityOverlay): CapabilityProfile {
  return capabilityProfile({
    connectionId: config.route?.connectionId ?? config.provider?.providerId ?? 'unknown',
    modelId: config.route?.modelId ?? config.model,
    toolProtocol: config.toolProtocol,
    editToolDialect: config.editToolDialect,
    contextWindowTokens: config.contextWindowTokens,
    measuredContextWindow: config.measuredContextWindow,
    observedContextWindow: config.observedContextWindow,
    overlay,
  });
}

export function declaredNativeToolLeakRisk(model: string | undefined): boolean {
  const normalized = String(model ?? '').toLowerCase();
  return !!normalized && DECLARED_PROTOCOL_LEAK_MODEL_HINTS.some((hint) => normalized.includes(hint));
}

export function declaredSamplingParametersRejected(model: string | undefined): boolean {
  const id = normalizedModelId(model);
  if (!id) return false;
  const policy = DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY;
  if (policy.latestAliases.includes(id) || policy.versionFivePrefixes.some((prefix) => hasVersionPrefix(id, prefix))) return true;
  const markerIndex = id.indexOf(policy.claudeOpusFourPrefix);
  if (markerIndex < 0) return false;
  const minor = Number(id.slice(markerIndex + policy.claudeOpusFourPrefix.length).split('-')[0]);
  return Number.isInteger(minor) && minor >= policy.claudeOpusFourMinimumMinor;
}

/** Applies the declared profile seed before an agent configuration is persisted. */
export function omitIncompatibleSamplingParameters(
  model: string | undefined,
  params: AgentModelParams | undefined,
): AgentModelParams | undefined {
  if (!params || !declaredSamplingParametersRejected(model)) return params;
  const keys = new Set<string>(SAMPLING_PARAMETER_KEYS);
  const compatible = Object.fromEntries(Object.entries(params).filter(([key]) => !keys.has(key))) as AgentModelParams;
  return Object.keys(compatible).length > 0 ? compatible : undefined;
}

function fact<T>(declared: CapabilityEvidence<T>, observed?: CapabilityEvidence<T>, userOverride?: CapabilityEvidence<T>): CapabilityFact<T> {
  return { declared, observed, userOverride, effective: userOverride ?? observed ?? declared };
}

function evidence<T>(source: CapabilityFactSource, value: T, detail: string): CapabilityEvidence<T> {
  return { source, value, detail };
}

function normalizedModelId(model: string | undefined): string {
  return String(model ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hasVersionPrefix(model: string, prefix: string): boolean {
  return model === prefix || model.startsWith(`${prefix}-`) || model.includes(`-${prefix}-`) || model.endsWith(`-${prefix}`);
}
