#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MUTATION_RECEIPT_SCHEMA, validateMutationPlan } from './mutation-receipts.mjs';

const ROOT = resolve('.');

function option(name) {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length !== 1 || !values[0]) throw new Error(`Exactly one ${prefix}<value> is required.`);
  return values[0];
}

function workspacePath(value, label) {
  const absolute = resolve(value);
  const rel = relative(ROOT, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} must stay inside the workspace.`);
  return { absolute, relative: rel.replaceAll('\\', '/') };
}

const jobKey = option('job');
const report = workspacePath(option('report'), 'Mutation receipt path');
const rawReport = workspacePath(option('raw-report'), 'Focused report path');
const knownOptions = new Set(['job', 'report', 'raw-report']);
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=/.exec(arg);
  if (!match || !knownOptions.has(match[1])) throw new Error(`Unknown focused CI option: ${arg}`);
}

const plan = validateMutationPlan(JSON.parse(readFileSync(join(ROOT, 'scripts', 'mutation-ci-plan.json'), 'utf8')));
const job = plan.jobs.find((candidate) => candidate.key === jobKey);
if (!job || job.runner !== 'focused') throw new Error(`Mutation CI plan has no focused job named ${jobKey}.`);

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => new Set(right).has(value));
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
  const run = spawnSync(process.execPath, [
    'scripts/mutation-focused-main.mjs',
    `--group=${job.group}`,
    `--report=${rawReport.relative}`,
  ], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0 || run.error || run.signal) {
    throw new Error(`Focused ${job.group} runner failed (exit ${run.status ?? 'none'}${run.signal ? `, signal ${run.signal}` : ''}).`);
  }
  const raw = JSON.parse(readFileSync(rawReport.absolute, 'utf8'));
  if (raw.schema !== 'unode-focused-mutation-report/v1' || raw.group !== job.group) {
    throw new Error(`Focused ${job.group} report schema or group is invalid.`);
  }
  if (raw.status !== 'passed' || raw.complete !== true) {
    throw new Error(`Focused ${job.group} report is ${raw.status ?? 'missing-status'} and complete=${String(raw.complete)}.`);
  }
  if (raw.sourceCommit !== sourceCommit) throw new Error(`Focused ${job.group} report names the wrong source commit.`);
  const killedIds = raw.cases.filter((entry) => entry.verdict === 'killed').map((entry) => entry.id);
  if (!sameSet(raw.populationIds, raw.admittedIds) || !sameSet(raw.admittedIds, killedIds)) {
    throw new Error(`Focused ${job.group} report did not kill its exact complete population.`);
  }
  receipt.groups = [{
    name: job.group,
    shard: null,
    populationIds: raw.populationIds,
    admittedIds: raw.admittedIds,
    killedIds,
  }];
  receipt.focused = {
    manifestSha256: raw.manifestSha256,
    runnerStatus: raw.status,
    runnerDurationMs: raw.durationMs,
  };
  receipt.status = 'passed';
} catch (error) {
  failure = error;
  receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
} finally {
  receipt.durationMs = Date.now() - started;
  mkdirSync(dirname(report.absolute), { recursive: true });
  writeFileSync(report.absolute, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`Focused mutation CI receipt: ${report.relative} (${receipt.status}, ${(receipt.durationMs / 1000).toFixed(1)}s)`);
}

if (failure) throw failure;
