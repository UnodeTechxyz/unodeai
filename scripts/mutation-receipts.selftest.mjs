import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MUTATION_RECEIPT_SCHEMA,
  MUTATION_RECEIPT_SCHEMA_V2,
  aggregateMutationReceipts,
  planForTopology,
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
const focusedPlan = {
  schema: 'unode-mutation-ci-plan/v1',
  minimumPopulation: { main: 2, 'terminal-outcome': 2 },
  jobs: [
    { key: 'focused-a', runner: 'focused', groups: ['main', 'terminal-outcome'], shard: '1/2' },
    { key: 'focused-b', runner: 'focused', groups: ['main', 'terminal-outcome'], shard: '2/2' },
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
// A fixture group's manifest digest is the digest of its name, on both sides: what a runner records and what the
// aggregator derives.
const digestOf = (name) => createHash('sha256').update(name).digest('hex');
const group = (name, shard, populationIds, admittedIds) => ({
  name,
  shard,
  manifestSha256: digestOf(name),
  populationIds,
  admittedIds,
  killedIds: [...admittedIds],
});
const derivedFrom = (populations) => Object.fromEntries(Object.entries(populations)
  .map(([name, ids]) => [name, { ids, manifestSha256: digestOf(name) }]));
const valid = [
  receipt('main-a', [group('main', '1/2', ['m1', 'm2'], ['m1'])]),
  receipt('main-b', [group('main', '2/2', ['m1', 'm2'], ['m2'])]),
  receipt('aux', [group('sensors', null, ['s1'], ['s1'])]),
];

assert.deepEqual(
  aggregateMutationReceipts({ plan, receipts: valid, expectedCommit: commit, matrixResult: 'success' }).counts,
  { main: 2, sensors: 1 },
);
const focusedReceipts = [
  receipt('focused-a', [
    group('main', '1/2', ['m1', 'm2'], ['m1']),
    group('terminal-outcome', '1/2', ['v1', 'v2'], ['v1']),
  ]),
  receipt('focused-b', [
    group('main', '2/2', ['m1', 'm2'], ['m2']),
    group('terminal-outcome', '2/2', ['v1', 'v2'], ['v2']),
  ]),
];
assert.deepEqual(
  aggregateMutationReceipts({ plan: focusedPlan, receipts: focusedReceipts, expectedCommit: commit, matrixResult: 'success' }).counts,
  { main: 2, 'terminal-outcome': 2 },
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
// A developer's local run judges the working tree's bytes on purpose; only that caller accepts a dirty receipt.
assert.deepEqual(
  aggregateMutationReceipts({ plan, receipts: dirty, expectedCommit: commit, matrixResult: 'success', workingTree: true }).counts,
  { main: 2, sensors: 1 },
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
const populationsFor = (candidate) => Object.fromEntries(Object.entries(candidate.minimumPopulation).map(([name, count]) => [
  name,
  Array.from({ length: count }, (_, index) => `${name}:fixture-${index + 1}`),
]));
// Receipts a plan's own jobs would produce for `populations`. A group that several warm coordinators name is split
// between them; a group that one names is judged whole by it.
function receiptsFor(candidate, populations) {
  const coordinators = candidate.jobs.filter((job) => job.runner === 'warm');
  return candidate.jobs.map((job) => {
    const groups = job.runner === 'static'
      ? (() => {
        const [part, count] = job.shard.split('/').map(Number);
        const population = populations[job.group];
        const selected = population.filter((_, index) => index % count === part - 1);
        return [group(job.group, job.shard, population, selected)];
      })()
      : job.runner === 'focused'
        ? job.groups.map((name) => {
          const [part, count] = job.shard.split('/').map(Number);
          const population = populations[name];
          const selected = population.filter((_, index) => index % count === part - 1);
          return group(name, job.shard, population, selected);
        })
        : job.runner === 'warm'
          ? job.groups.map((name) => {
            const population = populations[name];
            const split = coordinators.filter((other) => other.groups.includes(name)).length > 1;
            const [part, count] = (split ? job.partition : '1/1').split('/').map(Number);
            return warmGroup(name, population, population.filter((_, index) => index % count === part - 1));
          })
          : job.groups.map((name) => group(name, null, populations[name], populations[name]));
    return job.runner === 'warm' ? warmReceipt(job.key, groups) : receipt(job.key, groups);
  });
}
const actualPopulations = populationsFor(actualPlan);
assert.deepEqual(
  aggregateMutationReceipts({
    plan: actualPlan, receipts: receiptsFor(actualPlan, actualPopulations), expectedCommit: commit, matrixResult: 'success',
    expectedPopulations: derivedFrom(actualPopulations),
  }).counts,
  actualPlan.minimumPopulation,
);

// The warm coordinator's receipt, and the population the aggregator derives for itself.
function warmGroup(name, populationIds, admittedIds) {
  return {
    ...group(name, null, populationIds, admittedIds),
    cases: admittedIds.map((id) => ({ id, verdict: 'killed', durationMs: 1 })),
  };
}
function warmReceipt(jobKey, groups) {
  return {
    ...receipt(jobKey, groups),
    schema: MUTATION_RECEIPT_SCHEMA_V2,
    engine: 'warm-vitest-v2',
    controllerEpochs: 1,
    workerRestarts: 0,
  };
}
const warmPlan = {
  schema: 'unode-mutation-ci-plan/v1',
  // The floors sit below the populations, as they do in the checked-in plan.
  minimumPopulation: { main: 2, sensors: 1 },
  jobs: [{ key: 'warm', runner: 'warm', groups: ['main', 'sensors'] }],
};
const expectedPopulations = derivedFrom({ main: ['m1', 'm2', 'm3'], sensors: ['s1'] });
const warmValid = () => [warmReceipt('warm', [
  warmGroup('main', ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3']),
  warmGroup('sensors', ['s1'], ['s1']),
])];
const aggregateWarm = (receipts, overrides = {}) => aggregateMutationReceipts({
  plan: warmPlan, receipts, expectedCommit: commit, matrixResult: 'success', expectedPopulations, ...overrides,
});
const warmAggregate = aggregateWarm(warmValid());
assert.deepEqual(warmAggregate.counts, { main: 3, sensors: 1 });
assert.deepEqual(warmAggregate.derivedGroups, ['main', 'sensors']);
assert.deepEqual(warmAggregate.manifests, { main: digestOf('main'), sensors: digestOf('sensors') });

// A case lost together with its place in the receipt: two ids remain, the floor is two, and the receipt is
// internally consistent. Only the independently derived population catches it.
const lostWithinFloor = warmValid();
lostWithinFloor[0].groups[0] = warmGroup('main', ['m1', 'm2'], ['m1', 'm2']);
assert.throws(() => aggregateWarm(lostWithinFloor), /main receipt population differs from the checked-in definitions \(missing: m3; unexpected: none\)/);
// The receipt names an id the definitions do not.
const unexpectedId = warmValid();
unexpectedId[0].groups[0] = warmGroup('main', ['m1', 'm2', 'm3', 'm9'], ['m1', 'm2', 'm3', 'm9']);
assert.throws(() => aggregateWarm(unexpectedId), /missing: none; unexpected: m9/);
// The same count with one id swapped is still a disagreement.
const swappedId = warmValid();
swappedId[0].groups[0] = warmGroup('main', ['m1', 'm2', 'm9'], ['m1', 'm2', 'm9']);
assert.throws(() => aggregateWarm(swappedId), /missing: m3; unexpected: m9/);
const duplicateId = warmValid();
duplicateId[0].groups[0].admittedIds = ['m1', 'm1', 'm3'];
assert.throws(() => aggregateWarm(duplicateId), /admittedIds contains duplicates/);
// A warm coordinator has no shard; a receipt that claims one was not produced by it.
const shardLabel = warmValid();
shardLabel[0].groups[0].shard = '1/4';
assert.throws(() => aggregateWarm(shardLabel), /reported shard 1\/4, expected null/);
// A plan with a warm coordinator refuses to aggregate a group nobody derived.
assert.throws(() => aggregateWarm(warmValid(), { expectedPopulations: derivedFrom({ main: ['m1', 'm2', 'm3'] }) }), /not derived for: sensors/);
assert.throws(() => aggregateWarm(warmValid(), { expectedPopulations: undefined }), /not derived for: main, sensors/);
// The coordinator never asserts completeness, and a passed receipt holds one kill for every admitted id.
const selfComplete = warmValid();
selfComplete[0].complete = true;
assert.throws(() => aggregateWarm(selfComplete), /explicitly partial/);
const missingCase = warmValid();
missingCase[0].groups[0].cases.pop();
assert.throws(() => aggregateWarm(missingCase), /case results differ from its admitted set/);
const survivorInPassed = warmValid();
survivorInPassed[0].groups[0].cases[1].verdict = 'survived';
assert.throws(() => aggregateWarm(survivorInPassed), /passed with m2 survived/);
const unknownEngine = warmValid();
unknownEngine[0].engine = 'something-else';
assert.throws(() => aggregateWarm(unknownEngine), /unknown mutation engine/);
// A cold receipt cannot stand in for a warm coordinator's.
assert.throws(
  () => aggregateWarm([receipt('warm', [group('main', null, ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3']), group('sensors', null, ['s1'], ['s1'])])]),
  /receipt schema does not match its warm plan job/,
);

// The manifest digest is verified, not only recorded. A runner that judged another manifest is refused even when
// its ids agree; a warm receipt must record a digest; and the aggregator's own digest cannot be absent.
const otherManifest = warmValid();
otherManifest[0].groups[0].manifestSha256 = digestOf('some other manifest');
assert.throws(() => aggregateWarm(otherManifest), new RegExp(`warm/main judged manifest ${digestOf('some other manifest')}, but this checkout's is ${digestOf('main')}`));
const noDigest = warmValid();
delete noDigest[0].groups[1].manifestSha256;
assert.throws(() => aggregateWarm(noDigest), /warm\/sensors has no valid manifest digest/);
assert.throws(
  () => aggregateWarm(warmValid(), { expectedPopulations: { ...expectedPopulations, main: { ids: ['m1', 'm2', 'm3'] } } }),
  /expected main manifest digest is missing/,
);
// The cold receipts are held to the same rule once the aggregator derives: ids, and a recorded, matching digest.
const coldDerived = (receipts, populations = { main: ['m1', 'm2'], sensors: ['s1'] }) => aggregateMutationReceipts({
  plan, receipts, expectedCommit: commit, matrixResult: 'success', expectedPopulations: derivedFrom(populations),
});
assert.deepEqual(coldDerived(valid).derivedGroups, ['main', 'sensors']);
assert.throws(() => coldDerived(valid, { main: ['m1', 'm2', 'm3'], sensors: ['s1'] }), /main receipt population differs from the checked-in definitions \(missing: m3/);
const coldNoDigest = structuredClone(valid);
delete coldNoDigest[2].groups[0].manifestSha256;
assert.throws(() => coldDerived(coldNoDigest), /aux\/sensors judged manifest with no recorded digest/);
const coldOtherManifest = structuredClone(valid);
coldOtherManifest[1].groups[0].manifestSha256 = digestOf('some other manifest');
assert.throws(() => coldDerived(coldOtherManifest), /main-b\/main judged manifest/);
const coldBadDigest = structuredClone(valid);
coldBadDigest[0].groups[0].manifestSha256 = 'not-a-digest';
assert.throws(() => coldDerived(coldBadDigest), /main-a\/main has no valid manifest digest/);
// Deriving is all or nothing: a group left underived would be held to its floor alone.
assert.throws(() => coldDerived(valid, { main: ['m1', 'm2'] }), /not derived for: sensors/);

// Two coordinators on two runners: a complete partition pair, a disjoint union, and the same derived population.
const partitionedPlan = {
  schema: 'unode-mutation-ci-plan/v1',
  minimumPopulation: { main: 2 },
  jobs: [
    { key: 'warm-1', runner: 'warm', groups: ['main'], partition: '1/2' },
    { key: 'warm-2', runner: 'warm', groups: ['main'], partition: '2/2' },
  ],
};
const partitioned = (second) => aggregateMutationReceipts({
  plan: partitionedPlan,
  receipts: [
    warmReceipt('warm-1', [warmGroup('main', ['m1', 'm2', 'm3'], ['m1', 'm2'])]),
    warmReceipt('warm-2', [warmGroup('main', ['m1', 'm2', 'm3'], second)]),
  ],
  expectedCommit: commit, matrixResult: 'success', expectedPopulations: derivedFrom({ main: ['m1', 'm2', 'm3'] }),
});
assert.deepEqual(partitioned(['m3']).counts, { main: 3 });
assert.throws(() => partitioned(['m2', 'm3']), /appears in more than one shard/);
const planWith = (jobs, minimumPopulation = partitionedPlan.minimumPopulation) => () => validateMutationPlan({ ...partitionedPlan, minimumPopulation, jobs });
assert.throws(planWith([partitionedPlan.jobs[0]]), /complete set 1\/2, 2\/2/);
assert.throws(planWith([partitionedPlan.jobs[0], { ...partitionedPlan.jobs[1], partition: '1/2' }]), /complete set 1\/2, 2\/2/);
assert.throws(planWith([partitionedPlan.jobs[0], { key: 'warm-2', runner: 'warm', groups: ['main'] }]), /complete set 1\/2, 2\/2/);
assert.throws(planWith([{ key: 'warm-1', runner: 'warm', groups: ['main'] }, { key: 'warm-2', runner: 'warm', groups: ['main'] }]), /exactly one job/);
assert.throws(planWith([{ key: 'warm', runner: 'warm', groups: ['main'], shard: '1/4' }]), /cannot name a shard/);
// A group one coordinator names is judged whole by it. A group that some coordinators name and others do not has
// no defined split.
const wholeGroupPlan = {
  ...partitionedPlan,
  minimumPopulation: { main: 2, sensors: 1 },
  jobs: [{ ...partitionedPlan.jobs[0], groups: ['main', 'sensors'] }, partitionedPlan.jobs[1]],
};
assert.deepEqual(
  aggregateMutationReceipts({
    plan: wholeGroupPlan,
    receipts: receiptsFor(wholeGroupPlan, { main: ['m1', 'm2', 'm3'], sensors: ['s1', 's2'] }),
    expectedCommit: commit, matrixResult: 'success', expectedPopulations: derivedFrom({ main: ['m1', 'm2', 'm3'], sensors: ['s1', 's2'] }),
  }).counts,
  { main: 3, sensors: 2 },
);
const three = (groups) => groups.map((names, index) => ({ key: `warm-${index + 1}`, runner: 'warm', groups: names, partition: `${index + 1}/3` }));
assert.throws(
  planWith(three([['main', 'sensors'], ['main', 'sensors'], ['main']]), { main: 2, sensors: 1 }),
  /must all name sensors, or exactly one of them must/,
);
validateMutationPlan({ ...partitionedPlan, minimumPopulation: { main: 2, sensors: 1 }, jobs: three([['main', 'sensors'], ['main'], ['main']]) });

// A candidate topology replaces the jobs and keeps the checked-in floors.
const topologies = { single: warmPlan.jobs, dual: wholeGroupPlan.jobs };
assert.deepEqual(planForTopology(plan, topologies, 'dual').minimumPopulation, plan.minimumPopulation);
assert.deepEqual(planForTopology(plan, topologies, 'single').jobs, warmPlan.jobs);
assert.throws(() => planForTopology(plan, topologies, 'triple'), /topology triple is not defined/);
assert.throws(() => planForTopology(focusedPlan, topologies, 'single'), /jobs and minimum-population groups differ/);
// The checked-in candidates, where this checkout carries them: each is a valid plan over the authoritative floors,
// and receipts shaped by its own jobs aggregate to the complete population.
const topologyFile = join(resolve('.'), 'scripts', 'mutation-warm-topologies.json');
if (existsSync(topologyFile)) {
  const candidates = JSON.parse(readFileSync(topologyFile, 'utf8'));
  assert.ok(Object.keys(candidates).length > 0);
  for (const name of Object.keys(candidates)) {
    const candidate = planForTopology(actualPlan, candidates, name);
    assert.deepEqual(
      aggregateMutationReceipts({
        plan: candidate, receipts: receiptsFor(candidate, actualPopulations), expectedCommit: commit, matrixResult: 'success',
        expectedPopulations: derivedFrom(actualPopulations),
      }).counts,
      actualPlan.minimumPopulation,
      name,
    );
  }
}

console.log('mutation receipt contract passed (exact job/id union, population ratchet, commit and partial-state guards; warm receipts, independently derived populations and manifest digests, coordinator partitions, candidate topologies)');
