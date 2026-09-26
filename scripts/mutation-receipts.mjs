export const MUTATION_PLAN_SCHEMA = 'unode-mutation-ci-plan/v1';
export const MUTATION_RECEIPT_SCHEMA = 'unode-mutation-shard-receipt/v1';
export const MUTATION_AGGREGATE_SCHEMA = 'unode-mutation-aggregate/v1';

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
  return job.runner === 'static' || job.runner === 'focused' ? [job.group] : job.groups;
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
      const shard = /^(\d+)\/(\d+)$/.exec(job.shard ?? '');
      if (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])) {
        throw new Error(`${job.key}.shard must satisfy 1 <= INDEX <= COUNT.`);
      }
      coveredGroups.add(job.group);
    } else if (job.runner === 'focused') {
      requireString(job.group, `${job.key}.group`);
      coveredGroups.add(job.group);
    } else if (job.runner === 'auxiliary') {
      for (const group of uniqueStrings(job.groups, `${job.key}.groups`)) {
        coveredGroups.add(group);
      }
    } else {
      throw new Error(`${job.key}.runner is unsupported.`);
    }
  }
  if (new Set(keys).size !== keys.length) throw new Error('Mutation CI plan job keys must be unique.');
  if (!sameSet([...coveredGroups], minimumGroups)) {
    throw new Error('Mutation CI plan jobs and minimum-population groups differ.');
  }
  return plan;
}

export function validateMutationReceipt(receipt) {
  if (!receipt || receipt.schema !== MUTATION_RECEIPT_SCHEMA) throw new Error('Mutation receipt schema is missing or unsupported.');
  requireString(receipt.jobKey, 'receipt.jobKey');
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
    const population = uniqueStrings(group.populationIds, `${receipt.jobKey}/${group.name}.populationIds`);
    const admitted = uniqueStrings(group.admittedIds, `${receipt.jobKey}/${group.name}.admittedIds`);
    const killed = uniqueStrings(group.killedIds, `${receipt.jobKey}/${group.name}.killedIds`);
    if (!sameSet(admitted, killed)) throw new Error(`${receipt.jobKey}/${group.name} did not kill its exact admitted set.`);
    const populationSet = new Set(population);
    if (admitted.some((id) => !populationSet.has(id))) throw new Error(`${receipt.jobKey}/${group.name} admitted an unknown id.`);
  }
  if (new Set(names).size !== names.length) throw new Error(`${receipt.jobKey} repeats a group.`);
  return receipt;
}

export function aggregateMutationReceipts({ plan, receipts, expectedCommit, matrixResult }) {
  validateMutationPlan(plan);
  requireString(expectedCommit, 'expectedCommit');
  if (matrixResult !== 'success') throw new Error(`Mutation shard matrix result is ${matrixResult}, not success.`);
  if (!Array.isArray(receipts)) throw new Error('Mutation receipts must be an array.');
  receipts.forEach(validateMutationReceipt);

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
    if (receipt.dirty) throw new Error(`${receipt.jobKey} ran from a dirty checkout.`);
    const job = expectedJobs.get(receipt.jobKey);
    const expectedGroups = groupsForPlanJob(job);
    const actualGroups = receipt.groups.map((group) => group.name);
    if (!sameSet(actualGroups, expectedGroups)) throw new Error(`${receipt.jobKey} reported the wrong groups.`);

    for (const group of receipt.groups) {
      const expectedShard = job.runner === 'static' ? job.shard : null;
      if (group.shard !== expectedShard) throw new Error(`${receipt.jobKey}/${group.name} reported shard ${group.shard}, expected ${expectedShard}.`);
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
    if (!sameSet(executed, population)) throw new Error(`${group} aggregate is incomplete or contains unexpected ids.`);
    if (population.length < minimum) throw new Error(`${group} population ${population.length} is below the ratchet ${minimum}.`);
    counts[group] = population.length;
  }
  return {
    schema: MUTATION_AGGREGATE_SCHEMA,
    complete: true,
    sourceCommit: expectedCommit,
    jobs: [...expectedJobs.keys()],
    counts,
  };
}
