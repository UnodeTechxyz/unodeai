import assert from 'node:assert/strict';
import {
  affectedMutationCases,
  classifyCheckerProof,
  classifyVitestProof,
  escapeTestName,
  TERMINAL_OUTCOME_PROOF_SCHEMA,
  validateProofManifest,
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
const terminalOutcomeManifest = { ...manifest, schema: TERMINAL_OUTCOME_PROOF_SCHEMA };
assert.equal(validateProofManifest(terminalOutcomeManifest, [mutation], TERMINAL_OUTCOME_PROOF_SCHEMA).size, 1);
assert.throws(() => validateProofManifest(terminalOutcomeManifest, [mutation]), /unode-main-mutation-proofs/);

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

const two = { id: 'main-two', name: 'boundary two', file: 'src/two.ts', from: 'a', to: 'b', expected: /two/ };
const twoEntry = { id: two.id, boundary: two.name, sourceFile: two.file, proof: { kind: 'vitest', testFile: 'src/__tests__/two.test.ts', testName: 'two' } };
const checker = { id: 'main-three', name: 'boundary three', file: 'src/three.ts', from: 'c', to: 'd' };
const checkerEntry = { id: checker.id, boundary: checker.name, sourceFile: checker.file, proof: { kind: 'checker', script: 'scripts/check-three.mjs', expectedFinding: 'THREE' } };
const population = [{ ...mutation, from: 'x', to: 'y' }, two, checker];
const entries = [{ ...manifest.cases[0] }, twoEntry, checkerEntry];
const affected = (changedPaths, { basePopulation = population, baseEntries = entries, removedPaths } = {}) => affectedMutationCases({
  mutations: population,
  proofById: new Map(entries.map((entry) => [entry.id, entry])),
  basePopulation: new Map(basePopulation.map((item) => [item.id, item])),
  baseProofById: new Map(baseEntries.map((entry) => [entry.id, entry])),
  changedPaths,
  removedPaths,
});
assert.deepEqual(affected([]), { full: false, ids: [], unmapped: [] });
assert.deepEqual(affected(['README.md', 'docs/x.md', 'CHANGELOG.md']), { full: false, ids: [], unmapped: [] });
assert.deepEqual(affected(['src/two.ts']).ids, ['main-two'], 'a changed source file selects its cases');
assert.deepEqual(affected(['src\\two.ts']).ids, ['main-two'], 'Windows separators are normalized');
assert.deepEqual(affected(['src/one.test.ts']).ids, ['main-one'], 'a changed proof test selects the cases it proves');
assert.deepEqual(affected(['scripts/check-three.mjs']).ids, ['main-three'], 'a changed checker selects its cases');
assert.deepEqual(affected(['src/__tests__/__snapshots__/two.test.ts.snap']).ids, ['main-two'], 'a snapshot belongs to its test');
assert.deepEqual(affected(['src/']).ids, ['main-one', 'main-two', 'main-three'], 'an untracked directory covers its files');
assert.deepEqual(affected([], { basePopulation: [population[0], { ...two, to: 'c' }, checker] }).ids, ['main-two'],
  'an edited mutant is selected');
assert.deepEqual(affected([], { basePopulation: [population[0], { ...two, expected: /other/ }, checker] }).ids, ['main-two'],
  'a changed regular expression counts as an edit');
assert.deepEqual(affected([], { basePopulation: [population[0], two] }).ids, ['main-three'], 'a new mutant is selected');
assert.deepEqual(affected([], { baseEntries: [entries[0], { ...twoEntry, proof: { ...twoEntry.proof, testName: 'old' } }, checkerEntry] }).ids,
  ['main-two'], 'a changed proof entry is selected');
for (const shared of ['package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'src/testing/fake.ts',
  'src/views/__tests__/support/webviewBoot.ts', 'src/mcp/__tests__/fixtures/', 'scripts/mutation-runtime.mjs']) {
  const result = affected([shared]);
  assert.equal(result.full, true, `${shared} is shared by every proof`);
  assert.match(result.reason, /shared by every proof/);
}
assert.deepEqual(affected(['src/two.ts'], { removedPaths: ['docs\\old.md'] }), { full: true, reason: 'docs/old.md was deleted or renamed' },
  'a deletion or rename anywhere selects every case');
assert.deepEqual(affected(['src/two.ts', 'src/helper.ts', 'src/__tests__/other.test.ts', 'src/new/', 'docs/x.md']), {
  full: false,
  ids: ['main-two'],
  unmapped: ['src/__tests__/other.test.ts', 'src/helper.ts', 'src/new/'],
}, 'changed src paths that no case names are listed, not silently dropped');
assert.deepEqual(affected(['src/']).unmapped, [], 'an untracked directory holding a mapped file is not unmapped');

console.log('focused mutation runtime contract passed (exact manifest, strict killed/survived/invalid classification and change-scoped selection)');
