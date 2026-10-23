export const MUTATION_PLAN_SCHEMA = 'unode-mutation-ci-plan/v1';
export const MUTATION_RECEIPT_SCHEMA = 'unode-mutation-shard-receipt/v1';
// The warm coordinator's receipt: the same groups, plus every case result and the engine's epoch facts.
export const MUTATION_RECEIPT_SCHEMA_V2 = 'unode-mutation-shard-receipt/v2';
export const MUTATION_AGGREGATE_SCHEMA = 'unode-mutation-aggregate/v1';
const RECEIPT_ENGINES = new Set(['warm-vitest-v2', 'cold-focused-v1']);

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function uniqueStrings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`);
  }
  const strings = value.map((entry, index) => requireString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new Error(`${label} contains duplicates.`);
  return strings;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => new Set(right).has(value));
}

export function groupsForPlanJob(job) {
  return job.runner === 'static' ? [job.group] : job.groups;
}

function requireShard(value, label) {
  const shard = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])) {
    throw new Error(`${label} must satisfy 1 <= INDEX <= COUNT.`);
  }
  return value;
}

export function validateMutationPlan(plan) {
  if (!plan || plan.schema !== MUTATION_PLAN_SCHEMA) throw new Error('Mutation CI plan schema is missing or unsupported.');
  if (!plan.minimumPopulation || typeof plan.minimumPopulation !== 'object' || Array.isArray(plan.minimumPopulation)) {
    throw new Error('Mutation CI plan minimumPopulation is missing.');
  }
  const minimumGroups = Object.keys(plan.minimumPopulation);
  uniqueStrings(minimumGroups, 'minimum population groups');
  for (const [group, minimum] of Object.entries(plan.minimumPopulation)) {
    requireString(group, 'minimum population group');
    if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error(`Minimum population for ${group} must be positive.`);
  }
  if (!Array.isArray(plan.jobs) || plan.jobs.length === 0) throw new Error('Mutation CI plan has no jobs.');
  const keys = [];
  const coveredGroups = new Set();
  for (const [index, job] of plan.jobs.entries()) {
    if (!job || typeof job !== 'object') throw new Error(`Mutation CI plan job ${index} is invalid.`);
    keys.push(requireString(job.key, `jobs[${index}].key`));
    if (job.runner === 'static') {
      requireString(job.group, `${job.key}.group`);
      requireShard(job.shard, `${job.key}.shard`);
      coveredGroups.add(job.group);
    } else if (job.runner === 'focused') {
      requireShard(job.shard, `${job.key}.shard`);
      for (const group of uniqueStrings(job.groups, `${job.key}.groups`)) coveredGroups.add(group);
    } else if (job.runner === 'auxiliary') {
      for (const group of uniqueStrings(job.groups, `${job.key}.groups`)) {
        coveredGroups.add(group);
      }
    } else if (job.runner === 'warm') {
      // A warm coordinator schedules its own proof-file units, so it has no shard. Two coordinators on two
      // runners split the population by `partition` instead.
      if (job.shard !== undefined) throw new Error(`${job.key} is a warm coordinator and cannot name a shard.`);
      if (job.partition !== undefined) requireShard(job.partition, `${job.key}.partition`);
      for (const group of uniqueStrings(job.groups, `${job.key}.groups`)) coveredGroups.add(group);
    } else {
      throw new Error(`${job.key}.runner is unsupported.`);
    }
  }
  const warmJobs = plan.jobs.filter((job) => job.runner === 'warm');
  if (warmJobs.length > 0) {
    const partitions = warmJobs.map((job) => job.partition);
    if (partitions.every((partition) => partition === undefined)) {
      if (warmJobs.length !== 1) throw new Error('Warm coordinators without a partition must be exactly one job.');
    } else {
      const count = Number(partitions.find((partition) => partition !== undefined).split('/')[1]);
      const expected = Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);
      if (partitions.some((partition) => partition === undefined) || new Set(partitions).size !== partitions.length
          || !sameSet(partitions, expected)) {
        throw new Error(`Warm coordinator partitions must be the complete set ${expected.join(', ')}.`);
      }
      // A group every coordinator names is split between them by partition. Any other group is named by exactly
      // one coordinator, which judges all of it.
      const namedBy = new Map();
      for (const job of warmJobs) for (const group of job.groups) namedBy.set(group, (namedBy.get(group) ?? 0) + 1);
      const ambiguous = [...namedBy].filter(([, count]) => count !== 1 && count !== warmJobs.length).map(([group]) => group);
      if (ambiguous.length > 0) {
        throw new Error(`Partitioned warm coordinators must all name ${ambiguous.join(', ')}, or exactly one of them must.`);
      }
    }
  }
  if (new Set(keys).size !== keys.length) throw new Error('Mutation CI plan job keys must be unique.');
  if (!sameSet([...coveredGroups], minimumGroups)) {
    throw new Error('Mutation CI plan jobs and minimum-population groups differ.');
  }
  return plan;
}

/**
 * A candidate topology is the checked-in plan with other jobs. It keeps the plan's population floors, so a
 * topology under qualification is never held to a lower floor than the authoritative gate.
 */
export function planForTopology(plan, topologies, name) {
  const jobs = topologies?.[name];
  if (!Array.isArray(jobs)) throw new Error(`Mutation topology ${name} is not defined.`);
  return validateMutationPlan({ ...plan, jobs });
}

export function validateMutationReceipt(receipt) {
  const warm = receipt?.schema === MUTATION_RECEIPT_SCHEMA_V2;
  if (!receipt || (receipt.schema !== MUTATION_RECEIPT_SCHEMA && !warm)) throw new Error('Mutation receipt schema is missing or unsupported.');
  requireString(receipt.jobKey, 'receipt.jobKey');
  if (warm) {
    if (!RECEIPT_ENGINES.has(receipt.engine)) throw new Error(`${receipt.jobKey} names an unknown mutation engine.`);
    for (const fact of ['controllerEpochs', 'workerRestarts']) {
      if (!Number.isSafeInteger(receipt[fact]) || receipt[fact] < 0) throw new Error(`${receipt.jobKey}.${fact} must be a count.`);
    }
  }
  if (!/^[a-f0-9]{40,64}$/i.test(receipt.sourceCommit ?? '')) throw new Error(`${receipt.jobKey} has an invalid source commit.`);
  if (typeof receipt.dirty !== 'boolean') throw new Error(`${receipt.jobKey}.dirty must be boolean.`);
  if (receipt.complete !== false) throw new Error(`${receipt.jobKey} must be an explicitly partial shard receipt.`);
  if (!['passed', 'failed'].includes(receipt.status)) throw new Error(`${receipt.jobKey} has an invalid status.`);
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) throw new Error(`${receipt.jobKey} has an invalid duration.`);
  if (!Array.isArray(receipt.groups)) throw new Error(`${receipt.jobKey}.groups must be an array.`);
  if (receipt.status === 'failed') return receipt;
  if (receipt.groups.length === 0) throw new Error(`${receipt.jobKey} passed without group evidence.`);
  const names = [];
  for (const group of receipt.groups) {
    names.push(requireString(group.name, `${receipt.jobKey}.group.name`));
    if (group.shard !== null && typeof group.shard !== 'string') throw new Error(`${receipt.jobKey}/${group.name} has an invalid shard.`);
    if ((warm || group.manifestSha256 !== undefined) && !/^[a-f0-9]{64}$/.test(group.manifestSha256 ?? '')) {
      throw new Error(`${receipt.jobKey}/${group.name} has no valid manifest digest.`);
    }
    const population = uniqueStrings(group.populationIds, `${receipt.jobKey}/${group.name}.populationIds`);
    const admitted = uniqueStrings(group.admittedIds, `${receipt.jobKey}/${group.name}.admittedIds`);
    const killed = uniqueStrings(group.killedIds, `${receipt.jobKey}/${group.name}.killedIds`);
    if (!sameSet(admitted, killed)) throw new Error(`${receipt.jobKey}/${group.name} did not kill its exact admitted set.`);
    const populationSet = new Set(population);
    if (admitted.some((id) => !populationSet.has(id))) throw new Error(`${receipt.jobKey}/${group.name} admitted an unknown id.`);
    if (warm) {
      // Every admitted id has exactly one case result, and a passed receipt holds only kills.
      if (!Array.isArray(group.cases)) throw new Error(`${receipt.jobKey}/${group.name}.cases must be an array.`);
      const caseIds = uniqueStrings(group.cases.map((entry) => entry?.id), `${receipt.jobKey}/${group.name}.cases`);
      if (!sameSet(caseIds, admitted)) throw new Error(`${receipt.jobKey}/${group.name} case results differ from its admitted set.`);
      const notKilled = group.cases.find((entry) => entry.verdict !== 'killed');
      if (notKilled) throw new Error(`${receipt.jobKey}/${group.name} passed with ${notKilled.id} ${notKilled.verdict}.`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error(`${receipt.jobKey} repeats a group.`);
  return receipt;
}

/**
 * `expectedPopulations` maps a group to `{ ids, manifestSha256 }`, which the aggregator derived itself from the
 * checked-in definitions. A receipt only says what a runner loaded. Without the ids, a group that lost cases still
 * passes while its count stays above the floor, and with one coordinator there is no second receipt to disagree
 * with it. Without the digest, a receipt records which manifest it judged and nothing checks that it is this
 * commit's. A plan with a warm coordinator must supply every group; only a caller with no checkout supplies none.
 *
 * `workingTree` is for a developer's local run only: it accepts receipts from a checkout with uncommitted changes,
 * because that run judges the working tree's bytes on purpose. The CI aggregator never sets it.
 */
export function aggregateMutationReceipts({
  plan, receipts, expectedCommit, matrixResult, expectedPopulations = {}, workingTree = false,
}) {
  validateMutationPlan(plan);
  requireString(expectedCommit, 'expectedCommit');
  if (matrixResult !== 'success') throw new Error(`Mutation shard matrix result is ${matrixResult}, not success.`);
  if (!Array.isArray(receipts)) throw new Error('Mutation receipts must be an array.');
  receipts.forEach(validateMutationReceipt);
  const derived = new Map(Object.entries(expectedPopulations).map(([group, expected]) => {
    if (!/^[a-f0-9]{64}$/.test(expected?.manifestSha256 ?? '')) throw new Error(`expected ${group} manifest digest is missing.`);
    return [group, { ids: uniqueStrings(expected.ids, `expected ${group} population`), manifestSha256: expected.manifestSha256 }];
  }));
  // Deriving is all or nothing: a group left underived would be held to its floor alone.
  if (derived.size > 0 || plan.jobs.some((job) => job.runner === 'warm')) {
    const underived = Object.keys(plan.minimumPopulation).filter((group) => !derived.has(group));
    if (underived.length > 0) throw new Error(`The expected population was not derived for: ${underived.join(', ')}.`);
  }

  const expectedJobs = new Map(plan.jobs.map((job) => [job.key, job]));
  const receiptJobs = receipts.map((receipt) => receipt.jobKey);
  if (new Set(receiptJobs).size !== receiptJobs.length) throw new Error('Mutation receipts contain a duplicate job key.');
  const missingJobs = [...expectedJobs.keys()].filter((key) => !receiptJobs.includes(key));
  const unexpectedJobs = receiptJobs.filter((key) => !expectedJobs.has(key));
  if (missingJobs.length || unexpectedJobs.length) {
    throw new Error(`Mutation receipt job set differs (missing: ${missingJobs.join(', ') || 'none'}; unexpected: ${unexpectedJobs.join(', ') || 'none'}).`);
  }

  const populations = new Map();
  const admitted = new Map();
  for (const receipt of receipts) {
    if (receipt.status !== 'passed') throw new Error(`${receipt.jobKey} reported ${receipt.status}: ${receipt.error ?? 'no diagnostic'}`);
    if (receipt.sourceCommit !== expectedCommit) throw new Error(`${receipt.jobKey} reports commit ${receipt.sourceCommit}, expected ${expectedCommit}.`);
    if (receipt.dirty && !workingTree) throw new Error(`${receipt.jobKey} ran from a dirty checkout.`);
    const job = expectedJobs.get(receipt.jobKey);
    if ((job.runner === 'warm') !== (receipt.schema === MUTATION_RECEIPT_SCHEMA_V2)) {
      throw new Error(`${receipt.jobKey} receipt schema does not match its ${job.runner} plan job.`);
    }
    const expectedGroups = groupsForPlanJob(job);
    const actualGroups = receipt.groups.map((group) => group.name);
    if (!sameSet(actualGroups, expectedGroups)) throw new Error(`${receipt.jobKey} reported the wrong groups.`);

    for (const group of receipt.groups) {
      const expectedShard = job.runner === 'static' || job.runner === 'focused' ? job.shard : null;
      if (group.shard !== expectedShard) throw new Error(`${receipt.jobKey}/${group.name} reported shard ${group.shard}, expected ${expectedShard}.`);
      // The digest the runner recorded for the manifest it judged, against the one computed from this checkout.
      const expectedDigest = derived.get(group.name)?.manifestSha256;
      if (expectedDigest && group.manifestSha256 !== expectedDigest) {
        throw new Error(`${receipt.jobKey}/${group.name} judged manifest ${group.manifestSha256 ?? 'with no recorded digest'}, but this checkout's is ${expectedDigest}.`);
      }
      const sortedPopulation = [...group.populationIds].sort();
      const priorPopulation = populations.get(group.name);
      if (priorPopulation && !sameSet(priorPopulation, sortedPopulation)) {
        throw new Error(`${group.name} receipts disagree on the admitted population.`);
      }
      populations.set(group.name, sortedPopulation);
      const groupAdmitted = admitted.get(group.name) ?? new Set();
      for (const id of group.admittedIds) {
        if (groupAdmitted.has(id)) throw new Error(`${group.name} mutation id ${id} appears in more than one shard.`);
        groupAdmitted.add(id);
      }
      admitted.set(group.name, groupAdmitted);
    }
  }

  const counts = {};
  for (const [group, minimum] of Object.entries(plan.minimumPopulation)) {
    const population = populations.get(group) ?? [];
    const executed = [...(admitted.get(group) ?? new Set())];
    const expected = derived.get(group)?.ids;
    if (expected && !sameSet(population, expected)) {
      const reported = new Set(population);
      const known = new Set(expected);
      const missing = expected.filter((id) => !reported.has(id));
      const unexpected = population.filter((id) => !known.has(id));
      throw new Error(`${group} receipt population differs from the checked-in definitions (missing: ${missing.slice(0, 5).join(', ') || 'none'}; unexpected: ${unexpected.slice(0, 5).join(', ') || 'none'}).`);
    }
    if (!sameSet(executed, population)) throw new Error(`${group} aggregate is incomplete or contains unexpected ids.`);
    // The floor is a ratchet against deleting cases together with their definitions. It is not the population.
    if (population.length < minimum) throw new Error(`${group} population ${population.length} is below the ratchet ${minimum}.`);
    counts[group] = population.length;
  }
  return {
    schema: MUTATION_AGGREGATE_SCHEMA,
    complete: true,
    sourceCommit: expectedCommit,
    jobs: [...expectedJobs.keys()],
    counts,
    derivedGroups: [...derived.keys()].filter((group) => group in plan.minimumPopulation).sort(),
    manifests: Object.fromEntries([...derived].filter(([group]) => group in plan.minimumPopulation)
      .map(([group, expected]) => [group, expected.manifestSha256])),
  };
}
