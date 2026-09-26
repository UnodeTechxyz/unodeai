import { AgentModelParams } from '../types';
import {
  DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY,
  declaredSamplingParametersRejected,
  omitIncompatibleSamplingParameters,
  SAMPLING_PARAMETER_KEYS,
  SAMPLING_PARAMETER_REJECTION_REASON,
} from '../capabilities/CapabilityProfile';

/**
 * Compatibility facade for older callers. The declared policy now belongs to the capability profile,
 * where it can be outranked by session observation or an explicit user choice.
 */
export const SAMPLING_PARAMETER_REJECTION_POLICY = DECLARED_SAMPLING_PARAMETER_REJECTION_POLICY;
export { SAMPLING_PARAMETER_KEYS, SAMPLING_PARAMETER_REJECTION_REASON };

/** True only for model generations declared to reject all sampling knobs. */
export function modelRejectsSamplingParameters(model: string | undefined): boolean {
  return declaredSamplingParametersRejected(model);
}

/** Removes sampling fields before a known-incompatible model's params are persisted or sent. */
export function omitSamplingParametersForModel(
  model: string | undefined,
  params: AgentModelParams | undefined,
): AgentModelParams | undefined {
  return omitIncompatibleSamplingParameters(model, params);
}
