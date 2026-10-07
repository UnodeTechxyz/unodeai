#!/usr/bin/env node
// The mutation coordinator on the warm engine. It judges every group its plan job names: the focused groups (main
// and the cross-layer terminal-outcome invariants) on warm workers, and the auxiliary groups (sensors, shared
// memory) through their own proof scripts, in their own sandboxes. It has no case selector. A partitioned job
// judges its share of the focused cases; the final aggregator requires the union to be the whole population.
//
// This is the mutation gate. Its job comes from the checked-in plan (mutation-ci-plan.json); `--topology` names a
// candidate job layout instead, for a qualification run that is not a gate.
//
//   node scripts/mutation-warm-main.mjs --job=warm-1 [--workers=2] [--auxiliary=overlap|after] [--report=<path>]
//        [--topology=<candidate>]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { AUXILIARY_GROUPS, runAuxiliaryGroup } from './mutation-auxiliary.mjs';
import { FOCUSED_GROUPS, loadFocusedGroup } from './mutation-expected-population.mjs';
import { MUTATION_RECEIPT_SCHEMA_V2, planForTopology, validateMutationPlan, validateMutationReceipt } from './mutation-receipts.mjs';
import { replaceExactlyOnce } from './mutation-runtime.mjs';
import { EPOCH_CASE_LIMIT, killTree, proofFileUnits, resolveNodeModules, runWarmEngine, WARM_ENGINE } from './mutation-warm-engine.mjs';
import { assertReleaseRunnerIntegrity } from './release-runner-integrity.mjs';

const ROOT = resolve('.');
const AUXILIARY_TIMEOUT_MS = 300_000;
const MAX_CAPTURED_OUTPUT = 1_000_000;

function parseArgs(args) {
  const options = { workers: 2, auxiliary: 'overlap' };
  for (const arg of args) {
    const match = /^--(workers|job|report|topology|auxiliary)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown warm mutation option: ${arg}`);
    options[match[1]] = match[2];
  }
  if (!options.job) throw new Error('--job=<plan job key> is required.');
  options.workers = Number(options.workers);
  if (!Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > 8) {
    throw new Error('--workers must be an integer from 1 to 8.');
  }
  if (!['overlap', 'after'].includes(options.auxiliary)) throw new Error('--auxiliary must be overlap or after.');
  options.report = resolve(ROOT, options.report ?? `.mutation-receipts/${options.job}.json`);
  if (!options.report.startsWith(`${ROOT}${sep}`)) throw new Error('--report must stay inside the workspace.');
  return options;
}

function git(args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, 'scripts', file), 'utf8'));

// The per-process Vite cache directories that vitest.config.ts creates under node_modules when nothing redirects
// them. A mutation run keeps every cache inside a sandbox, so it must leave none of these behind.
function vitestCacheDirectories() {
  try {
    return readdirSync(join(resolveNodeModules(ROOT), '.vite')).filter((name) => name.startsWith('unode-vitest-'));
  } catch {
    return [];
  }
}

// The coordinator's job in the checked-in plan, or in a candidate topology that keeps the plan's floors.
function planJob(options) {
  const plan = options.topology
    ? planForTopology(readJson('mutation-ci-plan.json'), readJson('mutation-warm-topologies.json'), options.topology)
    : validateMutationPlan(readJson('mutation-ci-plan.json'));
  const job = plan.jobs.find((candidate) => candidate.key === options.job);
  if (!job || job.runner !== 'warm') {
    throw new Error(`The mutation plan has no warm coordinator named ${options.job}${options.topology ? '' : '; name a candidate topology with --topology'}.`);
  }
  const coordinators = plan.jobs.filter((candidate) => candidate.runner === 'warm');
  const split = (group) => coordinators.filter((candidate) => candidate.groups.includes(group)).length > 1;
  const focused = FOCUSED_GROUPS.filter((group) => job.groups.includes(group.key));
  const auxiliary = AUXILIARY_GROUPS.filter((group) => job.groups.includes(group.key));
  const undefinedGroups = job.groups.filter((name) => ![...focused, ...auxiliary].some((group) => group.key === name));
  if (undefinedGroups.length > 0) throw new Error(`${options.job} names a group with no definition: ${undefinedGroups.join(', ')}.`);
  const splitAuxiliary = auxiliary.filter((group) => split(group.key)).map((group) => group.key);
  if (splitAuxiliary.length > 0) {
    throw new Error(`An auxiliary group is judged by one script run and cannot be split between coordinators: ${splitAuxiliary.join(', ')}.`);
  }
  return { job, focused, auxiliary, split };
}

// This coordinator's share of the cases that are split between coordinators. Proof files stay whole, the largest
// first, each to the partition that holds the fewest cases so far. Every coordinator computes the same split from
// the same manifests, so the shares are disjoint and together complete; the aggregator checks that they are.
function partitionShare(items, partition) {
  const [index, count] = partition.split('/').map(Number);
  const totals = Array(count).fill(0);
  const share = [];
  for (const unit of proofFileUnits(items)) {
    const target = totals.indexOf(Math.min(...totals));
    totals[target] += unit.items.length;
    if (target === index - 1) share.push(...unit.items);
  }
  return share;
}

const auxiliaryChildren = new Set();

function runScript(script) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: process.env, windowsHide: true });
    auxiliaryChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, AUXILIARY_TIMEOUT_MS);
    const finish = (code) => {
      clearTimeout(timer);
      auxiliaryChildren.delete(child);
      done({ code: timedOut ? 'after a timeout' : code, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_CAPTURED_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_CAPTURED_OUTPUT); });
    child.on('error', (error) => { stderr = `${stderr}\n${error.message}`; finish(1); });
    child.on('close', (code, signal) => finish(code ?? signal ?? 1));
  });
}

// The auxiliary groups, one script after the other. Never rejects: a script that cannot be read is a failed group.
async function runAuxiliary(groups) {
  const started = Date.now();
  const judged = [];
  for (const group of groups) {
    try {
      const result = await runAuxiliaryGroup(ROOT, group, runScript);
      console.log(`AUXILIARY ${group.key}: ${result.killedIds.length}/${result.populationIds.length} killed (${(result.durationMs / 1000).toFixed(1)}s)${result.problems.length > 0 ? ` — ${result.problems.join('; ')}` : ''}`);
      judged.push(result);
    } catch (error) {
      judged.push({ name: group.key, failure: error instanceof Error ? error.message : String(error), durationMs: 0 });
    }
  }
  return { groups: judged, wallMs: Date.now() - started };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const receipt = {
    schema: MUTATION_RECEIPT_SCHEMA_V2,
    jobKey: options.job,
    engine: WARM_ENGINE,
    sourceCommit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
    status: 'failed',
    complete: false,
    durationMs: 0,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    host: { cpus: availableParallelism(), cpuModel: cpus()[0]?.model ?? 'unknown', totalMemoryMb: Math.round(totalmem() / 2 ** 20) },
    // The workflow run that produced this receipt. Coordinators that aggregate in place accept a peer's receipt
    // only from their own run and attempt.
    run: process.env.GITHUB_RUN_ID?.trim()
      ? { id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) }
      : null,
    topology: options.topology ?? null,
    partition: null,
    workers: options.workers,
    auxiliaryMode: options.auxiliary,
    epochCaseLimit: EPOCH_CASE_LIMIT,
    controllerEpochs: 0,
    workerRestarts: 0,
    groups: [],
  };
  mkdirSync(dirname(options.report), { recursive: true });
  rmSync(options.report, { force: true });
  const cacheDirectoriesBefore = new Set(vitestCacheDirectories());
  let failure;
  try {
    if (process.env.GITHUB_SHA?.trim() && process.env.GITHUB_SHA.trim() !== receipt.sourceCommit) {
      throw new Error(`Checked-out commit ${receipt.sourceCommit} differs from GITHUB_SHA ${process.env.GITHUB_SHA.trim()}.`);
    }
    const { job, focused, auxiliary, split } = planJob(options);
    receipt.partition = job.partition ?? null;
    assertReleaseRunnerIntegrity({
      root: ROOT,
      baseline: JSON.parse(readFileSync(join(ROOT, 'scripts', 'release-test-baseline.json'), 'utf8')),
    });
    // Every anchor and proof file is checked before any sandbox exists, as the cold runner does. The workers then
    // confirm that their sandbox holds these exact bytes before each mutant.
    const groups = focused.map((group) => loadFocusedGroup(ROOT, group));
    const originals = new Map();
    const whole = [];
    const shared = [];
    for (const group of groups) {
      for (const mutation of group.mutations) {
        const proof = group.proofById.get(mutation.id).proof;
        if (proof.kind !== 'vitest') throw new Error(`${mutation.id} has a ${proof.kind} proof; the warm engine judges Vitest proofs only.`);
        if (!existsSync(join(ROOT, mutation.file))) throw new Error(`${mutation.id} source file is missing: ${mutation.file}`);
        if (!existsSync(join(ROOT, proof.testFile))) throw new Error(`${mutation.id} proof file is missing: ${proof.testFile}`);
        if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(join(ROOT, mutation.file), 'utf8'));
        const anchor = replaceExactlyOnce(originals.get(mutation.file), mutation);
        if (anchor.kind === 'invalid') throw new Error(`${mutation.id} INVALID: ${anchor.reason}`);
        (job.partition && split(group.key) ? shared : whole).push({
          id: mutation.id, group: group.key, file: mutation.file, mutation, testFile: proof.testFile, testName: proof.testName,
        });
      }
    }
    const items = [...whole, ...(job.partition ? partitionShare(shared, job.partition) : shared)];
    const admitted = new Set(items.map((item) => item.id));
    const preflightMs = Date.now() - started;
    console.log(`${job.partition ? `PARTITION ${job.partition}` : 'COMPLETE'} warm mutation run: ${items.length} cases in ${new Set(items.map((item) => item.testFile)).size} proof files, ${options.workers} worker(s); auxiliary ${auxiliary.map((group) => group.key).join(' + ') || 'none'} (${options.auxiliary}); ${receipt.host.cpus} logical CPU(s)`);

    // The auxiliary scripts keep their own sandboxes and classifiers. Overlapping them with the warm workers is a
    // scheduling choice: it changes how long the job takes, never what is judged.
    const overlapping = options.auxiliary === 'overlap' ? runAuxiliary(auxiliary) : undefined;
    const run = items.length > 0
      ? await runWarmEngine({ root: ROOT, items, originals, workerCount: options.workers, log: console.log })
      : { results: new Map(), baselines: [], phases: {}, wallMs: 0, workers: [] };
    const auxiliaryRun = await (overlapping ?? runAuxiliary(auxiliary));

    receipt.vitest = run.workers[0]?.vitest;
    receipt.controllerEpochs = run.workers.reduce((total, worker) => total + worker.epochs, 0);
    receipt.workerRestarts = run.workers.reduce((total, worker) => total + worker.restarts.length, 0);
    receipt.plannedRotations = run.workers.reduce((total, worker) => total + worker.rotations, 0);
    receipt.restarts = run.workers.flatMap((worker) => worker.restarts.map((restart) => ({ worker: worker.index, ...restart })));
    receipt.memory = run.workers.map((worker) => worker.memory.map((entry) => entry.rssMb));
    const baselineProblems = run.baselines.flatMap((baseline) => baseline.problems);
    receipt.baselines = { proofFiles: run.baselines.length, problems: baselineProblems };
    const counts = { killed: 0, survived: 0, invalid: 0 };
    let caseWorkerMs = 0;
    for (const group of groups) {
      const cases = group.mutations.filter((mutation) => admitted.has(mutation.id)).map((mutation) => {
        const proof = group.proofById.get(mutation.id).proof;
        const result = run.results.get(mutation.id) ?? { verdict: 'invalid', reason: 'the engine returned no result', durationMs: 0 };
        counts[result.verdict] += 1;
        caseWorkerMs += result.durationMs + (result.canaryMs ?? 0);
        return {
          id: mutation.id,
          proof: { testFile: proof.testFile, testName: proof.testName },
          verdict: result.verdict,
          reason: result.reason,
          durationMs: result.durationMs,
          worker: result.worker,
          epoch: result.epoch,
          canary: result.canary,
          epochEnded: result.epochEnded,
        };
      });
      receipt.groups.push({
        name: group.key,
        shard: null,
        manifestSha256: group.manifestSha256,
        populationIds: group.mutations.map((mutation) => mutation.id),
        admittedIds: cases.map((entry) => entry.id),
        killedIds: cases.filter((entry) => entry.verdict === 'killed').map((entry) => entry.id),
        cases,
      });
    }
    const auxiliaryProblems = [];
    for (const group of auxiliaryRun.groups) {
      if (group.failure) {
        auxiliaryProblems.push(`${group.name}: ${group.failure}`);
        continue;
      }
      for (const entry of group.cases) counts[entry.verdict] += 1;
      auxiliaryProblems.push(...group.problems.map((problem) => `${group.name}: ${problem}`));
      const { name, shard, manifestSha256, populationIds, admittedIds, killedIds, cases } = group;
      receipt.groups.push({ name, shard, manifestSha256, populationIds, admittedIds, killedIds, cases });
    }
    receipt.counts = counts;
    // Worker time is summed over the workers; the rest is wall time of this process.
    receipt.timings = {
      preflightMs,
      engineWallMs: run.wallMs,
      ...run.phases,
      baselineWorkerMs: run.baselines.reduce((total, baseline) => total + baseline.durationMs, 0),
      caseWorkerMs,
      auxiliaryWallMs: auxiliaryRun.wallMs,
      auxiliaryMs: Object.fromEntries(auxiliaryRun.groups.map((group) => [group.name, group.durationMs])),
    };
    const total = items.length + auxiliaryRun.groups.reduce((sum, group) => sum + (group.cases?.length ?? 0), 0);
    receipt.vitestCacheResidue = vitestCacheDirectories().filter((name) => !cacheDirectoriesBefore.has(name));
    if (baselineProblems.length > 0) {
      receipt.error = `Warm baseline invalid: ${baselineProblems.slice(0, 5).join('; ')}`;
    } else if (auxiliaryProblems.length > 0) {
      receipt.error = `Auxiliary proof failed: ${auxiliaryProblems.slice(0, 5).join('; ')}`;
    } else if (receipt.vitestCacheResidue.length > 0) {
      receipt.error = `The run left ${receipt.vitestCacheResidue.length} Vitest cache director${receipt.vitestCacheResidue.length === 1 ? 'y' : 'ies'} under node_modules/.vite.`;
    } else if (counts.invalid > 0) {
      receipt.error = `${counts.invalid} mutation proof(s) were invalid.`;
    } else if (counts.survived > 0 || counts.killed !== total) {
      receipt.error = `${counts.survived} mutant(s) survived; ${counts.killed}/${total} killed.`;
    } else {
      receipt.status = 'passed';
      validateMutationReceipt(receipt);
    }
  } catch (error) {
    failure = error;
    receipt.status = 'failed';
    receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  } finally {
    for (const child of auxiliaryChildren) killTree(child);
    receipt.durationMs = Date.now() - started;
    writeFileSync(options.report, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  if (failure) throw failure;
  const where = relative(ROOT, options.report).replaceAll('\\', '/');
  if (receipt.status !== 'passed') throw new Error(`Warm mutation gate failed: ${receipt.error} (receipt ${where})`);
  const timings = receipt.timings;
  console.log(`Warm mutation population passed (${receipt.counts.killed} killed in ${receipt.groups.map((group) => `${group.name} ${group.killedIds.length}`).join(', ')}; ${receipt.controllerEpochs} controller epoch(s), ${receipt.plannedRotations} planned rotation(s), ${receipt.workerRestarts} restart(s)).`);
  console.log(`Timing: total ${(receipt.durationMs / 1000).toFixed(1)}s = preflight ${(timings.preflightMs / 1000).toFixed(1)}s + engine ${(timings.engineWallMs / 1000).toFixed(1)}s (sandboxes ${((timings.sandboxMs ?? 0) / 1000).toFixed(1)}s, start ${((timings.startMs ?? 0) / 1000).toFixed(1)}s, judging ${((timings.judgeMs ?? 0) / 1000).toFixed(1)}s); worker time: baselines ${(timings.baselineWorkerMs / 1000).toFixed(1)}s, cases ${(timings.caseWorkerMs / 1000).toFixed(1)}s; auxiliary ${(timings.auxiliaryWallMs / 1000).toFixed(1)}s (${options.auxiliary}); receipt ${where}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
