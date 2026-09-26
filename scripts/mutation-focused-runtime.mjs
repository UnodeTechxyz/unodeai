export const MAIN_PROOF_SCHEMA = 'unode-main-mutation-proofs/v1';
export const V0973_PROOF_SCHEMA = 'unode-v0973-mutation-proofs/v1';

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
