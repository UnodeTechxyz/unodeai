#!/usr/bin/env node
// v0.9.104 D0.2 (E2): record this checkout's mutation population and floors as the baseline, and empty the
// retirement records they absorb. Run after a release's complete population passed at its tag, and commit the result
// for review. Without --write it prints what would change and writes nothing.
//
//   node scripts/mutation-population-ids.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveExpectedPopulations } from './mutation-expected-population.mjs';
import { validateMutationPlan } from './mutation-receipts.mjs';
import {
  MUTATION_POPULATION_IDS_SCHEMA, MUTATION_RETIREMENTS_SCHEMA, POPULATION_IDS_FILE, RETIREMENTS_FILE,
  loadRetirementInputs, verifyRetirements,
} from './mutation-retirements.mjs';

const ROOT = resolve('.');
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--write');
if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(' ')}`);
const write = args.includes('--write');

const plan = validateMutationPlan(JSON.parse(readFileSync(join(ROOT, 'scripts', 'mutation-ci-plan.json'), 'utf8')));
const derived = deriveExpectedPopulations(ROOT);
const populations = new Map(Object.keys(plan.minimumPopulation).map((group) => [group, derived[group].ids]));
// The records being absorbed must still be exact: a baseline is never recorded over an unexplained loss.
const summary = verifyRetirements({ plan, ...loadRetirementInputs(ROOT), populations });
const baseline = {
  schema: MUTATION_POPULATION_IDS_SCHEMA,
  recordedAt: new Date().toISOString().slice(0, 10),
  minimumPopulation: { ...plan.minimumPopulation },
  groups: Object.fromEntries([...populations].map(([group, ids]) => [group, [...ids].sort()])),
};
console.log(`population: ${[...populations].map(([group, ids]) => `${group} ${ids.length} (retired ${summary.retired[group]}, added ${summary.added[group]})`).join(', ')}`);
if (write) {
  writeFileSync(join(ROOT, 'scripts', POPULATION_IDS_FILE), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  writeFileSync(join(ROOT, 'scripts', RETIREMENTS_FILE), `${JSON.stringify({ schema: MUTATION_RETIREMENTS_SCHEMA, retirements: [] }, null, 2)}\n`, 'utf8');
  console.log(`wrote scripts/${POPULATION_IDS_FILE} and emptied scripts/${RETIREMENTS_FILE}`);
} else {
  console.log('nothing written (pass --write after a release)');
}
