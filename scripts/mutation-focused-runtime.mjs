export const MAIN_PROOF_SCHEMA = 'unode-main-mutation-proofs/v1';
// The persisted schema string is retained so existing proof evidence remains readable. The operational name
// describes the protected contract instead of the release in which the contract was introduced.
export const TERMINAL_OUTCOME_PROOF_SCHEMA = 'unode-v0973-mutation-proofs/v1';
export const V0973_PROOF_SCHEMA = TERMINAL_OUTCOME_PROOF_SCHEMA;

export function validateProofManifest(manifest, mutations, expectedSchema = MAIN_PROOF_SCHEMA) {
  if (!manifest || manifest.schema !== expectedSchema || !Array.isArray(manifest.cases)) {
    throw new Error(`Focused mutation proof manifest must use ${expectedSchema}.`);
  }
  const mutationById = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  if (mutationById.size !== mutations.length) throw new Error('Focused mutation population contains duplicate ids.');
  const proofById = new Map();
  for (const entry of manifest.cases) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('Focused proof entry has no id.');
    if (proofById.has(entry.id)) throw new Error(`Focused proof manifest contains duplicate id ${entry.id}.`);
    const mutation = mutationById.get(entry.id);
    if (!mutation) throw new Error(`Focused proof manifest contains unknown id ${entry.id}.`);
    if (typeof entry.boundary !== 'string' || !entry.boundary.trim()) throw new Error(`${entry.id} has no boundary.`);
    if (entry.boundary !== mutation.name) throw new Error(`${entry.id} boundary is stale.`);
    if (entry.sourceFile !== mutation.file) throw new Error(`${entry.id} source file is stale.`);
    const proof = entry.proof;
    if (proof?.kind === 'vitest') {
      if (typeof proof.testFile !== 'string' || !proof.testFile.trim()) throw new Error(`${entry.id} has no proof test file.`);
      if (typeof proof.testName !== 'string' || !proof.testName.trim()) throw new Error(`${entry.id} has no proof test name.`);
      if (proof.expectedFailure !== undefined && (typeof proof.expectedFailure !== 'string' || !proof.expectedFailure.trim())) {
        throw new Error(`${entry.id} has an invalid expected failure signature.`);
      }
    } else if (proof?.kind === 'checker') {
      if (typeof proof.script !== 'string' || !proof.script.trim()) throw new Error(`${entry.id} has no checker script.`);
      if (typeof proof.expectedFinding !== 'string' || !proof.expectedFinding.trim()) {
        throw new Error(`${entry.id} has no checker finding.`);
      }
    } else {
      throw new Error(`${entry.id} has an unknown proof kind.`);
    }
    proofById.set(entry.id, entry);
  }
  const missing = mutations.map((mutation) => mutation.id).filter((id) => !proofById.has(id));
  if (missing.length > 0) throw new Error(`Focused proof manifest lacks: ${missing.join(', ')}.`);
  if (proofById.size !== mutationById.size) throw new Error('Focused proof manifest population is not exact.');
  return proofById;
}

export function classifyVitestProof(run, proof) {
  if (run.error || run.timedOut || run.exitCode === null || run.exitCode === undefined) {
    return { verdict: 'invalid', reason: 'runner crashed, could not launch, or timed out' };
  }
  if (run.reportMissing) return { verdict: 'invalid', reason: 'JSON test report is missing' };
  if ((run.collectionErrors ?? []).length > 0) {
    return { verdict: 'invalid', reason: `test collection failed in ${run.collectionErrors.join(', ')}` };
  }
  const declared = (run.tests ?? []).filter((test) => test.file === proof.testFile && test.name === proof.testName);
  if (declared.length !== 1) {
    return { verdict: 'invalid', reason: `declared test was found ${declared.length} times` };
  }
  const test = declared[0];
  const otherFailures = (run.tests ?? []).filter((candidate) => candidate.status === 'failed' && candidate !== test);
  if (test.status === 'failed') {
    if (run.exitCode === 0) return { verdict: 'invalid', reason: 'declared test failed but the process exited zero' };
    if (proof.expectedFailure && !(test.failureMessages ?? []).some((message) => message.includes(proof.expectedFailure))) {
      return { verdict: 'invalid', reason: 'declared test failed without the expected signature' };
    }
    return { verdict: 'killed', reason: otherFailures.length > 0 ? `${otherFailures.length} collateral assertion failure(s)` : undefined };
  }
  if (test.status === 'passed' && otherFailures.length === 0 && run.exitCode === 0) {
    return { verdict: 'survived', reason: 'declared test passed' };
  }
  if (test.status === 'passed' && otherFailures.length > 0) {
    return { verdict: 'invalid', reason: 'declared test passed while another assertion failed' };
  }
  return { verdict: 'invalid', reason: `declared test status was ${test.status ?? 'missing'}` };
}

export function classifyCheckerProof(run, proof) {
  if (run.error || run.timedOut || run.exitCode === null || run.exitCode === undefined) {
    return { verdict: 'invalid', reason: 'checker crashed, could not launch, or timed out' };
  }
  if (run.exitCode === 0) return { verdict: 'survived', reason: 'checker passed' };
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  return output.includes(proof.expectedFinding)
    ? { verdict: 'killed' }
    : { verdict: 'invalid', reason: 'checker failed without the declared finding' };
}

export function escapeTestName(name) {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

// Inputs every proof shares. A change to one of them can move any verdict, so a change-scoped run falls back to
// every case in the group rather than guess.
const SHARED_PROOF_INPUTS = [
  /^package(-lock)?\.json$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^tsconfig[^/]*\.json$/,
  /^src\/testing\//,
  // The runners and what they judge with: the warm engine, its worker, the classifier, and the cold runner.
  /^scripts\/mutation-(runtime|focused-runtime|focused-main|warm-engine|warm-worker|changed-selection)\.mjs$/,
  /^scripts\/run-mutation-[a-z-]+\.mjs$/,
];

function comparable(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof RegExp) return `/${item.source}/${item.flags}`;
    if (typeof item === 'function') return String(item);
    return item;
  });
}

/**
 * Choose the cases a change can affect: the case's source file or proof file changed, or its own definition or
 * proof entry differs from the base. Paths are repository-relative. `changedPaths` were added or modified; a path
 * ending in `/` is an untracked directory and covers everything under it. `removedPaths` were deleted, renamed away,
 * changed type or left unmerged. A removed path, or a changed input every proof shares (a test helper, the package
 * manifest or lockfile, the Vitest or TypeScript config, the runner itself), selects every case in the group.
 * `unmapped` lists changed `src/` paths that no case names as its source or proof: a change there, like any change
 * to a mapped file's imports, is not selected. The complete population in CI covers both.
 */
export function affectedMutationCases({ mutations, proofById, basePopulation, baseProofById, changedPaths, removedPaths = [] }) {
  const normalize = (path) => path.replaceAll('\\', '/');
  const removed = removedPaths.map(normalize).find(Boolean);
  if (removed) return { full: true, reason: `${removed} was deleted or renamed` };
  const files = new Set();
  const directories = [];
  for (const path of changedPaths.map(normalize)) {
    if (path.endsWith('/')) directories.push(path);
    else files.add(path.replace(/\/__snapshots__\/([^/]+)\.snap$/, '/$1'));
  }
  for (const path of [...files, ...directories]) {
    const testSupport = /(^|\/)__tests__\//.test(path) && !/\.test\.[cm]?[jt]s$/.test(path);
    if (testSupport || SHARED_PROOF_INPUTS.some((pattern) => pattern.test(path))) {
      return { full: true, reason: `${path} is shared by every proof` };
    }
  }
  const changed = (path) => files.has(path) || directories.some((directory) => path.startsWith(directory));
  const ids = [];
  const mapped = new Set();
  for (const mutation of mutations) {
    const entry = proofById.get(mutation.id);
    const proofFile = entry.proof.kind === 'vitest' ? entry.proof.testFile : entry.proof.script;
    mapped.add(mutation.file).add(proofFile);
    if (changed(mutation.file) || changed(proofFile)
        || comparable(basePopulation.get(mutation.id)) !== comparable(mutation)
        || comparable(baseProofById.get(mutation.id)) !== comparable(entry)) {
      ids.push(mutation.id);
    }
  }
  const unmapped = [...files, ...directories].filter((path) => path.startsWith('src/')
    && !(path.endsWith('/') ? [...mapped].some((file) => file.startsWith(path)) : mapped.has(path))).sort();
  return { full: false, ids, unmapped };
}
