#!/usr/bin/env node
// Mutation engine v2: one warm worker. It owns one long-lived Vitest controller and one sandbox, and is started by
// the warm engine's coordinator (mutation-warm-engine.mjs) with the sandbox as its working directory. It answers
// one request at a time over the IPC channel and returns the raw run; the coordinator classifies it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createVitest } from 'vitest/node';

const ROOT = resolve('.');
const slash = (path) => path.replaceAll('\\', '/');
const absolute = (file) => slash(resolve(ROOT, file));
// Windows and macOS file systems ignore case, and Vite stores forward slashes. Compare without either.
const canonical = (path) => slash(path).toLowerCase();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

let vitest;

function environments() {
  const found = [];
  for (const project of vitest.projects) {
    for (const [name, environment] of Object.entries(project.vite.environments)) found.push([name, environment]);
  }
  return found;
}

// Every module of this file that still holds a transform. The scan compares paths itself: the lookup that
// invalidateFile uses finds nothing for a spelling Vite did not store, and reports nothing.
function cachedTransforms(file) {
  const target = canonical(absolute(file));
  const hits = [];
  for (const [name, environment] of environments()) {
    for (const [key, modules] of environment.moduleGraph.fileToModulesMap) {
      if (canonical(key) !== target) continue;
      for (const module of modules) {
        if (module.transformResult) hits.push(`${name}:${module.id ?? module.url}`);
      }
    }
  }
  return hits;
}

function invalidate(file, spelling) {
  vitest.invalidateFile(spelling === 'backslash' ? resolve(ROOT, file) : absolute(file));
}

// The JSON reporter joins suite and test names with a space; the proof manifests store that form.
function fullName(test) {
  const names = [test.name];
  for (let parent = test.parent; parent && parent.type === 'suite'; parent = parent.parent) names.unshift(parent.name);
  return names.join(' ');
}

// The shape classifyVitestProof reads. The exit code is what the cold process would have returned: non-zero when
// the module is not ok or an error escaped every test.
//
// runTestSpecifications returns every module the controller has run so far, not only this run's. A proof file that
// an earlier mutant failed stays in that list, still failed, until it runs again. Only the requested module is
// read; the unhandled errors are this run's, because Vitest clears them when a run starts.
async function run(testFile, testName) {
  const started = Date.now();
  const options = testName === undefined ? undefined : { testNamePattern: new RegExp(testName) };
  const moduleId = absolute(testFile);
  const specification = vitest.getRootProject().createSpecification(moduleId, options);
  const result = await vitest.runTestSpecifications([specification]);
  const requested = result.testModules.filter((module) => canonical(module.moduleId) === canonical(moduleId));
  const tests = [];
  const collectionErrors = [];
  let failed = result.unhandledErrors.length > 0;
  for (const module of requested) {
    const file = slash(relative(ROOT, module.moduleId));
    let failedAssertion = false;
    for (const test of module.children.allTests()) {
      const outcome = test.result();
      if (outcome.state === 'failed') failedAssertion = true;
      tests.push({
        file,
        name: fullName(test),
        status: outcome.state,
        failureMessages: (outcome.errors ?? []).map((error) => String(error?.message ?? error).slice(0, 2000)),
      });
    }
    if (!module.ok()) {
      failed = true;
      if (!failedAssertion) collectionErrors.push(file);
    }
  }
  if (requested.length !== 1) failed = true;
  return {
    exitCode: failed ? 1 : 0,
    reportMissing: false,
    tests,
    collectionErrors,
    unhandledErrors: result.unhandledErrors.length,
    modules: requested.length,
    modulesInControllerState: result.testModules.length,
    durationMs: Date.now() - started,
  };
}

async function init() {
  const started = Date.now();
  // The cache directory is Vite's own option. Left alone it is node_modules/.vite, which the sandbox reaches through
  // its junction, so every worker and every other Vitest run on the machine would share one results file.
  // A case runs one proof file, without the full suite's load, so it keeps Vitest's 5 s default. The suite's 30 s
  // budget (vitest.config.ts) would make every mutant that is killed by a hanging test cost 30 s, which pushed both
  // CI coordinators past their 10-minute limit. Explicit per-case and per-block bounds still apply.
  vitest = await createVitest('test', {
    root: ROOT,
    watch: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 5_000,
    reporters: [{}],
  }, { cacheDir: resolve(ROOT, '.warm-vite-cache') });
  const diskCache = vitest.projects.some((project) => project.config.experimental?.fsModuleCache === true);
  if (diskCache) throw new Error('experimental.fsModuleCache is on; a warm worker cannot verify an on-disk module cache.');
  if (vitest.config.watch) throw new Error('the controller started in watch mode.');
  return {
    createMs: Date.now() - started,
    vitest: vitest.version,
    pool: vitest.config.pool,
    isolate: vitest.config.isolate,
    cacheDir: slash(relative(ROOT, vitest.vite.config.cacheDir)),
  };
}

// One mutant: write, invalidate, run the named proof, restore, invalidate, then show that no transform of the
// file survives. `defect` plants an engine fault so the coordinator can prove the check catches it.
async function mutantCase({ file, mutantText, originalSha256, testFile, testName, defect }) {
  const path = resolve(ROOT, file);
  const original = readFileSync(path, 'utf8');
  if (sha256(original) !== originalSha256) throw new Error(`${file} does not hold the bytes the coordinator read.`);
  const spelling = defect === 'backslash-invalidation' ? 'backslash' : 'forward';
  let outcome;
  let staleBeforeRun = [];
  try {
    writeFileSync(path, mutantText, 'utf8');
    invalidate(file, spelling);
    // A drill: this process dies with the mutant on disk. Nothing below runs, not even the restore.
    if (defect === 'worker-exit') process.exit(7);
    staleBeforeRun = cachedTransforms(file);
    outcome = await run(testFile, testName);
  } finally {
    writeFileSync(path, original, 'utf8');
  }
  const restoredBytes = sha256(readFileSync(path, 'utf8')) === originalSha256;
  if (defect !== 'skip-restore-invalidation') invalidate(file, spelling);
  return { run: outcome, staleBeforeRun, restoredBytes, staleAfterRestore: cachedTransforms(file) };
}

/**
 * A baseline runs unchanged code, under the suite's own per-test budget (vitest.config.ts). With three warm workers
 * on the CI runner, tests that start real git and npm processes crossed 5 s on unchanged code (CI on 4523a765 and
 * aebbd520), and the whole partition failed before judging one mutant. A mutant case keeps 5 s (see init), so a hang
 * a mutant causes still ends quickly. Vitest rebuilds the test config from `configOverride` on every run.
 * The same budget covers hooks. On the CI of ec9eca19 (three warm jobs), AskForAccess.flows.test.ts opened worker 2:
 * its beforeAll parses src/extension.ts while every worker is still cold, passed Vitest's 10 s hook default, and its
 * proofs were skipped (collection errors, 0 passing tests). A mutant case keeps the hook default too.
 */
export const BASELINE_TEST_TIMEOUT_MS = 30_000;

/**
 * A baseline runs the proofs its cases name, not the whole file (pre-v0.9.101 CI reliability). A mutant case runs one
 * proof by name, so that proof passing on unchanged code is what a verdict needs. The whole file ran here before: on
 * the CI of 1fc3dbfa, ResultDeliveryHost.test.ts passed the 180 s baseline limit on two tests no mutant uses (256 and
 * 300 real files, about 30 s each), and the partition failed before judging. Every test still runs in the suite.
 */
async function baseline({ testFile, testNamePattern }) {
  if (typeof testNamePattern !== 'string' || testNamePattern === '') throw new Error(`${testFile} baseline names no proof.`);
  vitest.configOverride.testTimeout = BASELINE_TEST_TIMEOUT_MS;
  vitest.configOverride.hookTimeout = BASELINE_TEST_TIMEOUT_MS;
  try {
    return await run(testFile, testNamePattern);
  } finally {
    delete vitest.configOverride.testTimeout;
    delete vitest.configOverride.hookTimeout;
  }
}

const handlers = {
  init,
  baseline,
  proof: ({ testFile, testName }) => run(testFile, testName),
  case: mutantCase,
  async close() {
    await vitest?.close();
    return {
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    };
  },
};

process.on('message', async (message) => {
  let reply;
  try {
    const handler = handlers[message.type];
    if (!handler) throw new Error(`unknown request ${message.type}`);
    reply = { seq: message.seq, ok: true, value: await handler(message) };
  } catch (error) {
    reply = { seq: message.seq, ok: false, error: String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 4000) };
  }
  process.send(reply, () => {
    if (message.type !== 'close') return;
    // Vitest sets process.exitCode to 1 whenever a test fails, and every killed mutant is a failed test.
    process.exitCode = 0;
    process.disconnect();
  });
});
