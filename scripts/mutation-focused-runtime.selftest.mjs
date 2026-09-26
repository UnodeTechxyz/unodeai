import assert from 'node:assert/strict';
import {
  classifyCheckerProof,
  classifyVitestProof,
  escapeTestName,
  validateProofManifest,
  V0973_PROOF_SCHEMA,
} from './mutation-focused-runtime.mjs';

const mutation = { id: 'main-one', name: 'boundary one', file: 'src/one.ts' };
const proof = { kind: 'vitest', testFile: 'src/one.test.ts', testName: 'suite proves [one]' };
const manifest = {
  schema: 'unode-main-mutation-proofs/v1',
  cases: [{ id: mutation.id, boundary: mutation.name, sourceFile: mutation.file, proof }],
};
assert.equal(validateProofManifest(manifest, [mutation]).get(mutation.id).proof.testName, proof.testName);
assert.throws(() => validateProofManifest({ ...manifest, cases: [] }, [mutation]), /lacks/);
assert.throws(() => validateProofManifest({ ...manifest, cases: [...manifest.cases, ...manifest.cases] }, [mutation]), /duplicate id/);
assert.throws(() => validateProofManifest({ ...manifest, cases: [{ ...manifest.cases[0], boundary: 'old' }] }, [mutation]), /stale/);
const v0973Manifest = { ...manifest, schema: V0973_PROOF_SCHEMA };
assert.equal(validateProofManifest(v0973Manifest, [mutation], V0973_PROOF_SCHEMA).size, 1);
assert.throws(() => validateProofManifest(v0973Manifest, [mutation]), /unode-main-mutation-proofs/);

const run = (status, extras = {}) => ({
  exitCode: status === 'failed' ? 1 : 0,
  tests: [{ file: proof.testFile, name: proof.testName, status, failureMessages: ['expected true'] }],
  collectionErrors: [],
  reportMissing: false,
  ...extras,
});
assert.equal(classifyVitestProof(run('failed'), proof).verdict, 'killed');
assert.equal(classifyVitestProof(run('passed'), proof).verdict, 'survived');
assert.equal(classifyVitestProof(run('passed', {
  exitCode: 1,
  tests: [
    { file: proof.testFile, name: proof.testName, status: 'passed' },
    { file: proof.testFile, name: 'unrelated', status: 'failed' },
  ],
}), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { timedOut: true }), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { error: new Error('crash') }), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { reportMissing: true }), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { collectionErrors: [proof.testFile] }), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { tests: [] }), proof).verdict, 'invalid');
assert.equal(classifyVitestProof(run('failed', { tests: [
  { file: proof.testFile, name: proof.testName, status: 'failed' },
  { file: proof.testFile, name: 'related', status: 'failed' },
] }), proof).verdict, 'killed');
assert.equal(classifyCheckerProof({ exitCode: 1, stdout: 'EXPECTED', stderr: '' }, {
  expectedFinding: 'EXPECTED',
}).verdict, 'killed');
assert.equal(classifyCheckerProof({ exitCode: 1, stdout: 'other', stderr: '' }, {
  expectedFinding: 'EXPECTED',
}).verdict, 'invalid');
assert.equal(classifyCheckerProof({ exitCode: 0 }, { expectedFinding: 'EXPECTED' }).verdict, 'survived');
assert.equal(escapeTestName('suite proves [one] (exact)'), '^suite proves \\[one\\] \\(exact\\)$');

console.log('focused mutation runtime contract passed (exact manifest and strict killed/survived/invalid classification)');
