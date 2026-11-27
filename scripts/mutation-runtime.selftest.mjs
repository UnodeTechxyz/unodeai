import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  compiledWorkersWarning,
  createMutationCopyFilter,
  mutationCases,
  parseMutationSelection,
  replaceExactlyOnce,
  selectMutationCases,
  stableMutationId,
} from './mutation-runtime.mjs';
import { readFileSync } from 'node:fs';
import { costPartition, PROOF_COSTS_SCHEMA, validateProofCosts } from './mutation-partition.mjs';

const cases = mutationCases('main', [
  { name: 'alpha' },
  { name: 'beta' },
  { name: 'gamma' },
  { name: 'delta' },
  { name: 'epsilon' },
]);

assert.equal(stableMutationId('Main Gate', 'alpha'), stableMutationId('Main Gate', 'alpha'));
assert.notEqual(cases[0].id, cases[1].id);
assert.throws(() => parseMutationSelection(['--shard', '0/2']), /1 <= INDEX <= COUNT/);
assert.throws(() => parseMutationSelection(['--case', cases[0].id, '--shard', '1/2']), /cannot be combined/);
assert.throws(() => parseMutationSelection(['--case=']), /at least one case id/);
assert.throws(() => parseMutationSelection(['--list', '--shard', '1/2']), /cannot be combined/);
assert.throws(() => parseMutationSelection(['--shard', '1/2', '--shard', '2/2']), /only once/);
assert.throws(() => parseMutationSelection(['--case', `${cases[0].id},${cases[0].id}`]), /must be unique/);
assert.throws(
  () => selectMutationCases(cases, parseMutationSelection(['--case', 'missing-id'])),
  /Unknown mutation case id/,
);

const selected = selectMutationCases(cases, parseMutationSelection(['--case', cases[2].id]));
assert.deepEqual(selected.cases.map((mutation) => mutation.id), [cases[2].id]);
assert.equal(selected.complete, false);

const shardSelections = [1, 2, 3].map((part) =>
  selectMutationCases(cases, parseMutationSelection(['--shard', `${part}/3`])).cases.map((mutation) => mutation.id)
);
assert.deepEqual(new Set(shardSelections.flat()), new Set(cases.map((mutation) => mutation.id)));
assert.equal(shardSelections.flat().length, cases.length);

const root = resolve('C:/fixture/workspace');
const filter = createMutationCopyFilter(root);
assert.equal(filter(root), true);
assert.equal(filter(resolve(root, 'src', 'changed.ts')), true);
assert.equal(filter(resolve(root, '.github', 'workflows', 'ci.yml')), true);
assert.equal(filter(resolve(root, '.impl-worktrees', 'old', 'src', 'copy.ts')), false);
assert.equal(filter(resolve(root, '.tmp-vsix-review', 'unpacked', 'extension.js')), false);
assert.equal(filter(resolve(root, '.mutation-receipts', 'main-1-of-3.json')), false);
assert.equal(filter(resolve(root, '.unode', 'local-state.json')), false);
assert.equal(filter(resolve(root, 'src', 'nested', 'node_modules', 'copy.js')), false);
assert.equal(filter(resolve(root, 'candidate.vsix')), false);
// v0.9.104 (item 13): the compiled workers in the root's out/ come along, since proofs that start a Codex or document
// worker spawn them from there (src/backend/cliClosure.ts); an out/ anywhere deeper is still left behind.
assert.equal(filter(resolve(root, 'out', 'backend', 'cliClosureWorker.js')), true);
assert.equal(filter(resolve(root, 'src', 'fixtures', 'out', 'copy.js')), false);
assert.equal(filter(resolve(root, 'dist', 'bundle.js')), false);
assert.match(compiledWorkersWarning(resolve(root, 'no-such-checkout')), /npm run compile/);

const applied = replaceExactlyOnce('before\r\nunique\r\nafter', {
  file: 'fixture.ts', from: 'before\nunique', to: 'before\nchanged',
});
assert.equal(applied.kind, 'mutated');
assert.equal(applied.text, 'before\r\nchanged\r\nafter');
assert.match(
  replaceExactlyOnce('const present = true;', {
    file: 'fixture.ts', from: 'const absent = true;', to: 'const absent = false;',
  }).reason,
  /zero times/,
);
assert.match(
  replaceExactlyOnce('duplicate\nduplicate', {
    file: 'fixture.ts', from: 'duplicate', to: 'changed',
  }).reason,
  /more than once/,
);

// Partitioned warm coordinators split by estimated time. v0.9.100's PR CI split 702 and 691 cases by count; the
// slow proof files all fell to one side, which then took twice the time of the other.
{
  const table = (perCaseMs, auxiliaryMs = {}) => ({ schema: PROOF_COSTS_SCHEMA, perCaseMs, auxiliaryMs });
  assert.throws(() => validateProofCosts({ ...table({ 'src/a.test.ts': 1 }), schema: 'other' }), /schema/);
  assert.throws(() => validateProofCosts(table({})), /names no proof file/);
  assert.throws(() => validateProofCosts(table({ 'src/a.test.ts': 0 })), /positive whole number/);
  assert.throws(() => validateProofCosts(table({ 'src/a.test.ts': 1.5 })), /positive whole number/);
  assert.throws(() => validateProofCosts(table({ '../a.test.ts': 1 })), /src\/ test file/);
  assert.throws(() => validateProofCosts(table({ 'src/a.test.ts': 1 }, { sensors: -1 })), /auxiliary sensors/);
  assert.equal(validateProofCosts(table({ 'src/a.test.ts': 10, 'src/b.test.ts': 30, 'src/c.test.ts': 20 })).medianPerCaseMs, 20);

  const items = (file, count) => Array.from({ length: count }, (_, index) => ({ id: `${file}#${index}`, testFile: file }));
  // Two slow files of 10 cases (10 s a case) and twenty fast files of 10 cases (0.5 s a case): equal counts would
  // put both slow files on one side; by time they go one to each.
  const slow = ['src/slow-1.test.ts', 'src/slow-2.test.ts'];
  const fast = Array.from({ length: 20 }, (_, index) => `src/fast-${String(index).padStart(2, '0')}.test.ts`);
  const costs = validateProofCosts(table(Object.fromEntries([...slow.map((file) => [file, 10_000]), ...fast.map((file) => [file, 500])])));
  const population = [...slow, ...fast].flatMap((file) => items(file, 10));
  const { shares, estimatedMs } = costPartition(population, { count: 2, costs });
  assert.deepEqual(shares.map((share) => share.filter((item) => slow.includes(item.testFile)).length), [10, 10]);
  assert.ok(Math.abs(estimatedMs[0] - estimatedMs[1]) <= 5_500, `estimates ${estimatedMs}`);
  // Disjoint and complete; a proof file is never split, since its baseline runs where its cases are judged.
  assert.deepEqual(shares.flat().map((item) => item.id).sort(), population.map((item) => item.id).sort());
  for (const file of [...slow, ...fast]) assert.equal(shares.filter((share) => share.some((item) => item.testFile === file)).length, 1, file);
  // Every coordinator computes the same split whatever order its manifests list the cases in.
  assert.deepEqual(costPartition([...population].reverse(), { count: 2, costs }).shares.map((share) => share.map((item) => item.id).sort()),
    shares.map((share) => share.map((item) => item.id).sort()));
  // Work a coordinator does alone counts first: with more than both slow files (110 s each) preloaded, the first
  // partition takes neither.
  const preloaded = costPartition(population, { count: 2, costs, preloadMs: [220_001, 0] });
  assert.equal(preloaded.shares[0].filter((item) => slow.includes(item.testFile)).length, 0);
  // A proof file the table does not name costs the median per case.
  const unknown = costPartition([...items('src/new.test.ts', 3)], { count: 1, costs });
  assert.deepEqual(unknown.estimatedMs, [costs.medianPerCaseMs * 4]);
  assert.throws(() => costPartition(population, { count: 0, costs }), /positive integer/);
  // Each file's own measured time decides where it goes (Codex's audit of e1d73139: the checks above still passed when
  // every file was priced at the median). Four files of four cases; the one measured at 10 s a case goes alone, and
  // moves when another file is the slow one. Priced alike, the four would alternate between the two sides.
  {
    const named = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
    const sameCount = named.flatMap((file) => items(file, 4));
    const filesOf = (result) => result.shares.map((share) => [...new Set(share.map((item) => item.testFile))].sort());
    const priced = (slowFile) => validateProofCosts(table(Object.fromEntries(named.map((file) => [file, file === slowFile ? 10_000 : 1_000]))));
    const slowA = costPartition(sameCount, { count: 2, costs: priced('src/a.test.ts') });
    assert.deepEqual(filesOf(slowA), [['src/a.test.ts'], ['src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']]);
    assert.deepEqual(slowA.estimatedMs, [50_000, 15_000]);
    const slowD = costPartition(sameCount, { count: 2, costs: priced('src/d.test.ts') });
    assert.deepEqual(filesOf(slowD), [['src/d.test.ts'], ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']]);
    assert.deepEqual(slowD.estimatedMs, [50_000, 15_000]);
  }
  // A file's measured baseline time counts as itself, not as one more case (v0.9.104's tag run: estimates of 908 s
  // each, 1351, 913 and 2294 s measured; activation-flow baselines take 30-130 s). Four files of four cases at 1 s
  // a case; only b has a long baseline, so b goes alone. Without baselineMs all four cost the same and alternate.
  {
    const named = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
    const sameCount = named.flatMap((file) => items(file, 4));
    const filesOf = (result) => result.shares.map((share) => [...new Set(share.map((item) => item.testFile))].sort());
    const flat = Object.fromEntries(named.map((file) => [file, 1_000]));
    const withBaseline = validateProofCosts({ ...table(flat), baselineMs: { 'src/b.test.ts': 30_000 } });
    const split = costPartition(sameCount, { count: 2, costs: withBaseline });
    assert.deepEqual(filesOf(split), [['src/b.test.ts'], ['src/a.test.ts', 'src/c.test.ts', 'src/d.test.ts']]);
    // b: 30 s baseline + 4 cases; each other file: one case's time for its baseline + 4 cases.
    assert.deepEqual(split.estimatedMs, [34_000, 15_000]);
    assert.deepEqual(filesOf(costPartition(sameCount, { count: 2, costs: validateProofCosts(table(flat)) })),
      [['src/a.test.ts', 'src/c.test.ts'], ['src/b.test.ts', 'src/d.test.ts']]);
    assert.throws(() => validateProofCosts({ ...table(flat), baselineMs: { 'src/b.test.ts': 0 } }), /baseline src\/b\.test\.ts/);
    assert.throws(() => validateProofCosts({ ...table(flat), baselineMs: { '../b.test.ts': 5 } }), /baseline \.\.\/b\.test\.ts/);
  }
  // The checked-in table is valid, and it carries measured baselines.
  const checkedIn = validateProofCosts(JSON.parse(readFileSync(new URL('./mutation-proof-costs.json', import.meta.url), 'utf8')));
  assert.ok(Object.keys(checkedIn.baselineMs).length > 0, 'the checked-in cost table has no baseline times');
}

console.log('mutation runtime contract passed (stable ids, exact anchors, disjoint shards, strict selectors, lean sandbox copy, cost-balanced partitions)');
