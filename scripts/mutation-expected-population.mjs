// The ids the mutation gate must have judged, and the digest of the file that defines each group, derived from the
// checked-in definitions rather than from what a runner reported. The final aggregator calls this at the commit it
// is checking.
//
// The sensor ids come from a TypeScript syntax-tree scan, so the job that aggregates installs dependencies.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUXILIARY_GROUPS, fileSha256 } from './mutation-auxiliary.mjs';
import { ALL_MUTATIONS as MAIN_MUTATIONS } from './mutation-check.mjs';
import { ALL_MUTATIONS as TERMINAL_OUTCOME_MUTATIONS } from './mutation-check-v0973.mjs';
import { MAIN_PROOF_SCHEMA, TERMINAL_OUTCOME_PROOF_SCHEMA, validateProofManifest } from './mutation-focused-runtime.mjs';

export const FOCUSED_GROUPS = [
  {
    key: 'main',
    label: 'main',
    mutations: MAIN_MUTATIONS,
    definitionsFile: 'scripts/mutation-check.mjs',
    manifest: 'scripts/mutation-main-proofs.json',
    schema: MAIN_PROOF_SCHEMA,
  },
  {
    key: 'terminal-outcome',
    label: 'cross-layer terminal-outcome invariants',
    mutations: TERMINAL_OUTCOME_MUTATIONS,
    definitionsFile: 'scripts/mutation-check-v0973.mjs',
    manifest: 'scripts/mutation-v0973-proofs.json',
    schema: TERMINAL_OUTCOME_PROOF_SCHEMA,
  },
];

/** A group's cases and proofs. Throws unless the definitions and the proof manifest name exactly the same ids. */
export function loadFocusedGroup(root, group) {
  const manifestText = readFileSync(join(root, group.manifest), 'utf8');
  const proofById = validateProofManifest(JSON.parse(manifestText), group.mutations, group.schema);
  return { ...group, manifestText, manifestSha256: createHash('sha256').update(manifestText).digest('hex'), proofById };
}

/**
 * Every group's expected ids and manifest digest. A focused group's manifest is its proof manifest; an auxiliary
 * group has no manifest, so the digest is of the source file its ids are read from and its mutants are made in.
 */
export function deriveExpectedPopulations(root) {
  const expected = {};
  for (const group of FOCUSED_GROUPS) {
    const loaded = loadFocusedGroup(root, group);
    expected[group.key] = {
      ids: loaded.mutations.map((mutation) => mutation.id),
      manifest: group.manifest,
      manifestSha256: loaded.manifestSha256,
    };
  }
  for (const group of AUXILIARY_GROUPS) {
    expected[group.key] = { ids: group.ids(root), manifest: group.source, manifestSha256: fileSha256(root, group.source) };
  }
  return expected;
}
