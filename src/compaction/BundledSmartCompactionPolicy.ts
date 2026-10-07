/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the bundled Smart compaction policy (v0.9.90 Smart compaction design, §4.1)
 *
 *  The one place that imports the policy file. It is validated once, when first asked for; data that does not
 *  validate is reported as unavailable by the resolver, never repaired or replaced by a literal. Runtime code
 *  receives the loaded value from the composition root rather than importing this module itself.
 *--------------------------------------------------------------------------------------------*/

import bundledPolicy from './smart-compaction-policy.v1.json';
import { loadSmartCompactionPolicy, type LoadedSmartCompactionPolicy } from './SmartCompactionPolicy';

let loaded: LoadedSmartCompactionPolicy | undefined;

export function bundledSmartCompactionPolicy(): LoadedSmartCompactionPolicy {
  loaded ??= loadSmartCompactionPolicy(bundledPolicy);
  return loaded;
}

/** The raw bundled data, for tests that compare the shipped mapping with the shipped role templates. */
export function bundledSmartCompactionPolicyData(): unknown {
  return bundledPolicy;
}
