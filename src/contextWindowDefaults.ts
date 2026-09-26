import type { AgentConfig, ContextWindowBound, ContextWindowMeasurement, ContextWindowSource } from './types';

/**
 * Default context window used when an agent does not set `contextWindowTokens`.
 *
 * This is the number the soft-compaction and hard-trim thresholds are computed from, so it is a claim
 * about the model's real window, not a preference. Raising it delays compaction; if it exceeds what the
 * model actually accepts, the guard stops guarding and the provider rejects the turn instead. An agent
 * on a smaller model should set `contextWindowTokens` explicitly rather than inherit this.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1024 * 1024;

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
  measurement?: ContextWindowMeasurement;
  bound?: ContextWindowBound;
}

/**
 * Below this, an overflow is not evidence about the history budget.
 *
 * A request carries far more than the conversation: system prompt, tool schemas, project knowledge. When the
 * estimated history is this small, the overflow was caused by something the guard does not control, and
 * recording it as the window would push compaction into a loop that summarises constantly, costs money, and
 * still cannot make the request fit. Recording nothing is the honest outcome; the error text still names the
 * problem and the user can set the window themselves.
 */
export const MIN_OBSERVED_CONTEXT_BOUND_TOKENS = 8192;

export interface ContextWindowBoundDecision {
  bound?: ContextWindowBound;
  applied: boolean;
  /** Why an overflow taught nothing, for the log line that would otherwise be silence. */
  reason?: 'explicit-window' | 'below-floor' | 'not-tighter';
}

export interface ContextWindowMeasurementDecision {
  measurement?: ContextWindowMeasurement;
  applied: boolean;
}

/**
 * Resolve the guard's denominator without turning a provider report into a user override.
 *
 * A manual value wins. A measurement is valid only for the exact model it named; retaining an older
 * report while the user tries another model is harmless because it cannot apply to that new model.
 */
export function resolveContextWindow(
  config: Pick<AgentConfig, 'model' | 'route' | 'contextWindowTokens' | 'measuredContextWindow' | 'observedContextWindow'>
): ResolvedContextWindow {
  if (isTokenCount(config.contextWindowTokens)) {
    return { tokens: config.contextWindowTokens, source: 'configured' };
  }
  const model = config.route?.modelId ?? config.model;
  const measurement = config.measuredContextWindow;
  const base: ResolvedContextWindow = measurement && measurement.model === model && isTokenCount(measurement.tokens)
    ? { tokens: measurement.tokens, source: 'measured', measurement }
    : { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'assumed' };

  // A refusal outranks an advertisement, but only downwards. Gateways commonly advertise the model's raw
  // window while reserving part of it for output, so `measured` being larger than what the endpoint accepts
  // is the normal case, not an anomaly. A bound may only tighten: it can never talk the guard into believing
  // there is more room than a measurement or the default already claims.
  const bound = config.observedContextWindow;
  if (bound && bound.model === model && isTokenCount(bound.tokens) && bound.tokens < base.tokens) {
    return { tokens: bound.tokens, source: 'observed', measurement: base.measurement, bound };
  }
  return base;
}

/**
 * Turn one overflow rejection into a durable fact, or refuse to.
 *
 * The rejection proves the model accepts less than we sent. Left unrecorded, the guard keeps computing its
 * threshold from the disproved number and the same conversation fails at the same place — the user presses
 * Compact once per turn, forever. Three cases record nothing, each for its own reason, and the caller is
 * told which so the decision is visible instead of silent.
 */
export function decideContextWindowBound(input: {
  model: string;
  explicitTokens?: number;
  prior?: ContextWindowBound;
  rejectedEstimate: number;
  observedAt: string;
}): ContextWindowBoundDecision {
  const priorForModel = input.prior && input.prior.model === input.model && isTokenCount(input.prior.tokens)
    ? input.prior
    : undefined;
  // The user's number is a statement, not a guess, and it already outranks every other source in
  // `resolveContextWindow`. Recording a bound underneath it would change nothing and would present a stored
  // value the guard never consults.
  if (isTokenCount(input.explicitTokens)) {
    return { bound: input.prior, applied: false, reason: 'explicit-window' };
  }
  if (!isTokenCount(input.rejectedEstimate) || input.rejectedEstimate < MIN_OBSERVED_CONTEXT_BOUND_TOKENS) {
    return { bound: input.prior, applied: false, reason: 'below-floor' };
  }
  if (priorForModel && priorForModel.tokens <= input.rejectedEstimate) {
    return { bound: input.prior, applied: false, reason: 'not-tighter' };
  }
  return {
    bound: { model: input.model, tokens: input.rejectedEstimate, observedAt: input.observedAt },
    applied: true,
  };
}

/**
 * Decide whether a fresh gateway report may replace the inherited assumption.
 *
 * Absence/failure is intentionally a no-op, and an explicit user number freezes the existing measurement
 * as well as the effective value. This pure seam keeps both rules independently regression-testable.
 */
export function decideContextWindowMeasurement(input: {
  model: string;
  explicitTokens?: number;
  prior?: ContextWindowMeasurement;
  discovered?: ContextWindowMeasurement;
}): ContextWindowMeasurementDecision {
  if (isTokenCount(input.explicitTokens) || !input.discovered || input.discovered.model !== input.model) {
    return { measurement: input.prior, applied: false };
  }
  return { measurement: input.discovered, applied: true };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
