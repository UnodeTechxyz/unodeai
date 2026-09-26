import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MUTATION_RECEIPT_SCHEMA,
  aggregateMutationReceipts,
  validateMutationPlan,
} from './mutation-receipts.mjs';

const actualPlan = validateMutationPlan(JSON.parse(readFileSync(join(resolve('.'), 'scripts', 'mutation-ci-plan.json'), 'utf8')));

const commit = 'a'.repeat(40);
const plan = {
  schema: 'unode-mutation-ci-plan/v1',
  minimumPopulation: { main: 2, sensors: 1 },
  jobs: [
    { key: 'main-a', runner: 'static', group: 'main', shard: '1/2' },
    { key: 'main-b', runner: 'static', group: 'main', shard: '2/2' },
    { key: 'aux', runner: 'auxiliary', groups: ['sensors'] },
  ],
};
const receipt = (jobKey, groups) => ({
  schema: MUTATION_RECEIPT_SCHEMA,
  jobKey,
  sourceCommit: commit,
  dirty: false,
  status: 'passed',
  complete: false,
  durationMs: 10,
  groups,
});
const group = (name, shard, populationIds, admittedIds) => ({
  name,
  shard,
  populationIds,
  admittedIds,
  killedIds: [...admittedIds],
});
const valid = [
  receipt('main-a', [group('main', '1/2', ['m1', 'm2'], ['m1'])]),
  receipt('main-b', [group('main', '2/2', ['m1', 'm2'], ['m2'])]),
  receipt('aux', [group('sensors', null, ['s1'], ['s1'])]),
];

assert.deepEqual(
  aggregateMutationReceipts({ plan, receipts: valid, expectedCommit: commit, matrixResult: 'success' }).counts,
  { main: 2, sensors: 1 },
);
assert.throws(
  () => aggregateMutationReceipts({ plan, receipts: valid.slice(0, 2), expectedCommit: commit, matrixResult: 'success' }),
  /missing: aux/,
);
const duplicate = structuredClone(valid);
duplicate[1].groups[0].admittedIds = ['m1'];
duplicate[1].groups[0].killedIds = ['m1'];
assert.throws(
  () => aggregateMutationReceipts({ plan, receipts: duplicate, expectedCommit: commit, matrixResult: 'success' }),
  /appears in more than one shard/,
);
const dirty = structuredClone(valid);
dirty[0].dirty = true;
assert.throws(
  () => aggregateMutationReceipts({ plan, receipts: dirty, expectedCommit: commit, matrixResult: 'success' }),
  /dirty checkout/,
);
const falseComplete = structuredClone(valid);
falseComplete[0].complete = true;
assert.throws(
  () => aggregateMutationReceipts({ plan, receipts: falseComplete, expectedCommit: commit, matrixResult: 'success' }),
  /explicitly partial/,
);
assert.throws(
  () => aggregateMutationReceipts({ plan, receipts: valid, expectedCommit: commit, matrixResult: 'failure' }),
  /not success/,
);
const actualPopulations = Object.fromEntries(Object.entries(actualPlan.minimumPopulation).map(([name, count]) => [
  name,
  Array.from({ length: count }, (_, index) => `${name}:fixture-${index + 1}`),
]));
const actualReceipts = actualPlan.jobs.map((job) => {
  const groups = job.runner === 'static'
    ? (() => {
      const [part, count] = job.shard.split('/').map(Number);
      const population = actualPopulations[job.group];
      const selected = population.filter((_, index) => index % count === part - 1);
      return [group(job.group, job.shard, population, selected)];
    })()
    : job.runner === 'focused'
      ? [group(job.group, null, actualPopulations[job.group], actualPopulations[job.group])]
      : job.groups.map((name) => group(name, null, actualPopulations[name], actualPopulations[name]));
  return receipt(job.key, groups);
});
assert.deepEqual(
  aggregateMutationReceipts({ plan: actualPlan, receipts: actualReceipts, expectedCommit: commit, matrixResult: 'success' }).counts,
  actualPlan.minimumPopulation,
);

console.log('mutation receipt contract passed (exact job/id union, population ratchet, commit and partial-state guards)');
