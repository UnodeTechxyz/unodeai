import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  createMutationCopyFilter,
  mutationCases,
  parseMutationSelection,
  replaceExactlyOnce,
  selectMutationCases,
  stableMutationId,
} from './mutation-runtime.mjs';

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

console.log('mutation runtime contract passed (stable ids, exact anchors, disjoint shards, strict selectors, lean sandbox copy)');
