#!/usr/bin/env node
// The complete mutation gate, run locally: `npm run test:mutation`. It runs every warm coordinator of the checked-in
// plan, one after the other, and then aggregates their receipts as CI does: the exact complete population and
// every manifest digest are derived from this checkout and compared with what the coordinators judged.
//
// It has no case selector. It judges the working tree, so uncommitted changes are part of what is judged; CI judges
// the commit.
//
//   node scripts/run-mutation-warm.mjs [--workers=3]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveExpectedPopulations } from './mutation-expected-population.mjs';
import { aggregateMutationReceipts, validateMutationPlan } from './mutation-receipts.mjs';

const ROOT = resolve('.');
const RECEIPTS = join(ROOT, '.mutation-receipts', 'complete');

let workers = 3;
for (const arg of process.argv.slice(2)) {
  const match = /^--workers=(\d+)$/.exec(arg);
  if (!match) throw new Error(`Unknown option: ${arg}`);
  workers = Number(match[1]);
}
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8) throw new Error('--workers must be an integer from 1 to 8.');

function run(label, script, ...args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const passed = result.status === 0 && !result.error;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return passed;
}

const started = Date.now();
const plan = validateMutationPlan(JSON.parse(readFileSync(join(ROOT, 'scripts', 'mutation-ci-plan.json'), 'utf8')));
const coordinators = plan.jobs.filter((job) => job.runner === 'warm');
if (coordinators.length === 0 || coordinators.length !== plan.jobs.length) {
  throw new Error('The mutation plan is not a warm plan; `npm run test:mutation:cold` runs the cold diagnostic.');
}
const failed = [];
for (const [label, script] of [
  ['runner contract', 'scripts/mutation-runtime.selftest.mjs'],
  ['classifier contract', 'scripts/mutation-focused-runtime.selftest.mjs'],
  ['receipt contract', 'scripts/mutation-receipts.selftest.mjs'],
]) {
  if (!run(label, script)) failed.push(label);
}
rmSync(RECEIPTS, { recursive: true, force: true });
mkdirSync(RECEIPTS, { recursive: true });
console.log(`Running the complete mutation population as ${coordinators.length} warm coordinator(s) of the checked-in plan, ${workers} worker(s) each.`);
for (const job of coordinators) {
  const label = `coordinator ${job.key}${job.partition ? ` (partition ${job.partition})` : ''}`;
  if (!run(label, 'scripts/mutation-warm-main.mjs', `--job=${job.key}`, `--workers=${workers}`, `--report=.mutation-receipts/complete/${job.key}.json`)) {
    failed.push(label);
  }
}
if (failed.length > 0) {
  console.error(`Mutation gate failed: ${failed.join(', ')}.`);
  process.exitCode = 1;
} else {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const receipts = readdirSync(RECEIPTS).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(RECEIPTS, name), 'utf8')));
  const aggregate = aggregateMutationReceipts({
    plan,
    receipts,
    expectedCommit: head,
    matrixResult: 'success',
    expectedPopulations: deriveExpectedPopulations(ROOT),
    workingTree: true,
  });
  const dirty = receipts.some((receipt) => receipt.dirty);
  console.log(`Complete mutation population passed: ${Object.entries(aggregate.counts).map(([group, count]) => `${group} ${count}`).join(', ')}; exact ids and manifest digests derived from this checkout; ${coordinators.length} coordinator(s); ${((Date.now() - started) / 1000).toFixed(1)}s.${dirty ? ' The working tree has uncommitted changes, and they were part of what was judged.' : ''}`);
}
