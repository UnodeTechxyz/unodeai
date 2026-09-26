#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mutationCases, parseMutationSelection, selectMutationCases } from './mutation-runtime.mjs';
import {
  MUTATION_RECEIPT_SCHEMA,
  validateMutationPlan,
} from './mutation-receipts.mjs';

const ROOT = resolve('.');
const MAX_CAPTURED_OUTPUT = 1_000_000;

function option(name) {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length !== 1 || !values[0]) throw new Error(`Exactly one ${prefix}<value> is required.`);
  return values[0];
}

const jobKey = option('job');
const reportPath = resolve(option('report'));
const reportRelative = relative(ROOT, reportPath);
if (reportRelative === '..' || reportRelative.startsWith(`..${sep}`)) {
  throw new Error('Mutation shard report must stay inside the workspace.');
}
const knownOptions = new Set(['job', 'report']);
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=/.exec(arg);
  if (!match || !knownOptions.has(match[1])) throw new Error(`Unknown mutation shard option: ${arg}`);
}

const plan = validateMutationPlan(JSON.parse(readFileSync(join(ROOT, 'scripts', 'mutation-ci-plan.json'), 'utf8')));
const job = plan.jobs.find((candidate) => candidate.key === jobKey);
if (!job) throw new Error(`Mutation CI plan has no job named ${jobKey}.`);

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function runNode(script, args = [], { echo = true } = {}) {
  return new Promise((finish) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      finish(result);
    };
    const capture = (current, chunk) => `${current}${chunk}`.slice(-MAX_CAPTURED_OUTPUT);
    child.stdout.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
      if (echo) process.stderr.write(chunk);
    });
    child.on('error', (error) => done({ code: 1, stdout, stderr, error }));
    child.on('close', (code, signal) => done({ code: code ?? 1, stdout, stderr, signal }));
  });
}

function assertSuccessful(result, label) {
  if (result.code !== 0 || result.error || result.signal) {
    throw new Error(`${label} failed (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ''}).`);
  }
}

function idsFromList(output, group) {
  const ids = output.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')[0]);
  if (ids.length === 0 || ids.some((id) => !id.startsWith(`${group}-`)) || new Set(ids).size !== ids.length) {
    throw new Error(`${group} --list did not return a unique, non-empty id population.`);
  }
  return ids;
}

function killedStaticIds(output, group) {
  const ids = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('killed')) continue;
    const match = new RegExp(`\\b(${group}-[a-f0-9]{10})\\b`).exec(line);
    if (match) ids.push(match[1]);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${group} output reported a duplicate killed id.`);
  return ids;
}

function assertExactIds(actual, expected, label) {
  const expectedSet = new Set(expected);
  if (actual.length !== expected.length || actual.some((id) => !expectedSet.has(id))) {
    throw new Error(`${label} reported ${actual.length} killed ids, expected the exact ${expected.length}-id selection.`);
  }
}

async function runStaticGroup(group, shard) {
  const script = group === 'main' ? 'scripts/mutation-check.mjs'
    : group === 'v0973' ? 'scripts/mutation-check-v0973.mjs'
      : undefined;
  if (!script) throw new Error(`Unsupported static mutation group ${group}.`);
  const listed = await runNode(script, ['--list'], { echo: false });
  assertSuccessful(listed, `${group} population listing`);
  const populationIds = idsFromList(listed.stdout, group);
  const selected = selectMutationCases(
    mutationCases(group, populationIds.map((id) => ({ id, name: id }))),
    parseMutationSelection(['--shard', shard]),
  ).cases.map((mutation) => mutation.id);
  const result = await runNode(script, ['--shard', shard]);
  assertSuccessful(result, `${group} shard ${shard}`);
  const killedIds = killedStaticIds(result.stdout, group);
  assertExactIds(killedIds, selected, `${group} shard ${shard}`);
  return { name: group, shard, populationIds, admittedIds: selected, killedIds };
}

async function runAuxiliary() {
  const sensors = await runNode('scripts/check-harness-sensor-mutations.mjs');
  assertSuccessful(sensors, 'harness sensor mutations');
  const sensorIds = [];
  for (const line of sensors.stdout.split(/\r?\n/)) {
    const match = /^killed\s+\d+\s+\[([^\]]+)\]/.exec(line);
    if (match) sensorIds.push(`sensor:${match[1]}`);
  }
  if (new Set(sensorIds).size !== sensorIds.length || sensorIds.length < plan.minimumPopulation.sensors) {
    throw new Error(`Sensor receipt found ${sensorIds.length} unique killed ids.`);
  }
  const sensorSummary = /every sensor requirement mutant killed \((\d+)\/(\d+)\)/.exec(sensors.stdout);
  if (!sensorSummary || Number(sensorSummary[1]) !== sensorIds.length || sensorSummary[1] !== sensorSummary[2]) {
    throw new Error('Sensor mutation summary disagrees with its killed ids.');
  }

  const shared = await runNode('scripts/check-shared-memory-trust-mutations.mjs');
  assertSuccessful(shared, 'shared-memory mutation');
  if (!shared.stdout.includes('killed: agent-selected contract cannot regain trust/admission priority')) {
    throw new Error('Shared-memory mutation did not report its expected kill.');
  }
  const sharedIds = ['shared-memory:trust-priority'];
  return [
    { name: 'sensors', shard: null, populationIds: sensorIds, admittedIds: sensorIds, killedIds: sensorIds },
    { name: 'shared-memory', shard: null, populationIds: sharedIds, admittedIds: sharedIds, killedIds: sharedIds },
  ];
}

const started = Date.now();
const sourceCommit = git(['rev-parse', 'HEAD']);
const receipt = {
  schema: MUTATION_RECEIPT_SCHEMA,
  jobKey,
  sourceCommit,
  dirty: git(['status', '--porcelain']).length > 0,
  status: 'failed',
  complete: false,
  durationMs: 0,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  groups: [],
};

let failure;
try {
  if (process.env.GITHUB_SHA?.trim() && process.env.GITHUB_SHA.trim() !== sourceCommit) {
    throw new Error(`Checked-out commit ${sourceCommit} differs from GITHUB_SHA ${process.env.GITHUB_SHA.trim()}.`);
  }
  receipt.groups = job.runner === 'static'
    ? [await runStaticGroup(job.group, job.shard)]
    : await runAuxiliary();
  receipt.status = 'passed';
} catch (error) {
  failure = error;
  receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
} finally {
  receipt.durationMs = Date.now() - started;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`Mutation shard receipt: ${reportRelative} (${receipt.status}, ${(receipt.durationMs / 1000).toFixed(1)}s)`);
}

if (failure) throw failure;
