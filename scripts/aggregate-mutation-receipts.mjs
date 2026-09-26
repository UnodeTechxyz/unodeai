#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { aggregateMutationReceipts, validateMutationPlan } from './mutation-receipts.mjs';

const ROOT = resolve('.');

function option(name) {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length !== 1 || !values[0]) throw new Error(`Exactly one ${prefix}<value> is required.`);
  return values[0];
}

const receiptsDir = resolve(option('receipts'));
const reportPath = resolve(option('report'));
for (const target of [receiptsDir, reportPath]) {
  const rel = relative(ROOT, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Mutation aggregate paths must stay inside the workspace.');
}
const knownOptions = new Set(['receipts', 'report']);
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=/.exec(arg);
  if (!match || !knownOptions.has(match[1])) throw new Error(`Unknown mutation aggregate option: ${arg}`);
}

const plan = validateMutationPlan(JSON.parse(readFileSync(join(ROOT, 'scripts', 'mutation-ci-plan.json'), 'utf8')));
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
});
writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
console.log(`Complete mutation population verified at ${aggregate.sourceCommit}: ${Object.entries(aggregate.counts).map(([group, count]) => `${group} ${count}`).join(', ')}.`);
