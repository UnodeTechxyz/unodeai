#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { deriveExpectedPopulations } from './mutation-expected-population.mjs';
import { aggregateMutationReceipts, planForTopology, validateMutationPlan } from './mutation-receipts.mjs';

const ROOT = resolve('.');

function option(name, { required = true } = {}) {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length === 0 && !required) return undefined;
  if (values.length !== 1 || !values[0]) throw new Error(`Exactly one ${prefix}<value> is required.`);
  return values[0];
}

const receiptsDir = resolve(option('receipts'));
const reportPath = resolve(option('report'));
for (const target of [receiptsDir, reportPath]) {
  const rel = relative(ROOT, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Mutation aggregate paths must stay inside the workspace.');
}
const knownOptions = new Set(['receipts', 'report', 'topology']);
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=/.exec(arg);
  if (!match || !knownOptions.has(match[1])) throw new Error(`Unknown mutation aggregate option: ${arg}`);
}

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, 'scripts', file), 'utf8'));
// `--topology` aggregates a candidate job layout under qualification against the checked-in plan's floors. Without
// it this is the authoritative plan.
const topology = option('topology', { required: false });
const plan = topology
  ? planForTopology(readJson('mutation-ci-plan.json'), readJson('mutation-warm-topologies.json'), topology)
  : validateMutationPlan(readJson('mutation-ci-plan.json'));
const files = readdirSync(receiptsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();
const receipts = files.map((file) => JSON.parse(readFileSync(join(receiptsDir, file), 'utf8')));
const aggregate = aggregateMutationReceipts({
  plan,
  receipts,
  expectedCommit: process.env.MUTATION_EXPECTED_COMMIT?.trim() || '',
  matrixResult: process.env.MUTATION_MATRIX_RESULT?.trim() || '',
  // Read from this checkout, not from the receipts: a runner that lost cases cannot vouch for its own population,
  // and a recorded manifest digest proves nothing until it is compared with this commit's.
  expectedPopulations: deriveExpectedPopulations(ROOT),
});
writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
console.log(`Complete mutation population verified at ${aggregate.sourceCommit}${topology ? ` (topology ${topology})` : ''}: ${Object.entries(aggregate.counts).map(([group, count]) => `${group} ${count}`).join(', ')} (ids and manifest digests derived from this checkout: ${aggregate.derivedGroups.join(', ')}).`);
