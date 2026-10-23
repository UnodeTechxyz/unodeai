#!/usr/bin/env node
// Change-scoped mutation feedback for a developer about to push: the focused main and cross-layer terminal-outcome
// invariant cases that the changes since the base (default origin/main, plus staged, unstaged and untracked work)
// can affect, judged on the warm engine. It is partial by construction and never the gate: it writes no receipt,
// and CI and release scripts run only the complete population.
//
// This is the only entry that selects cases for the warm engine. The coordinator (mutation-warm-main.mjs) has no
// selector and must not get one.
//
//   npm run test:mutation:changed
//   npm run test:mutation:changed -- --base <git-ref> [--workers=2]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changedSelection } from './mutation-changed-selection.mjs';
import { FOCUSED_GROUPS, loadFocusedGroup } from './mutation-expected-population.mjs';
import { replaceExactlyOnce } from './mutation-runtime.mjs';
import { runWarmEngine, WARM_ENGINE } from './mutation-warm-engine.mjs';
import { assertReleaseRunnerIntegrity } from './release-runner-integrity.mjs';

const ROOT = resolve('.');
const REPORT = join(ROOT, '.mutation-receipts', 'changed-partial.json');

function parseArgs(args) {
  let base = 'origin/main';
  let workers = 2;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--base' || arg.startsWith('--base=')) {
      base = arg.startsWith('--base=') ? arg.slice('--base='.length) : args[++index];
      if (!base) throw new Error('--base requires a git ref.');
    } else if (/^--workers=\d+$/.test(arg)) {
      workers = Number(arg.slice('--workers='.length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8) throw new Error('--workers must be an integer from 1 to 8.');
  return { base, workers };
}

async function main() {
  const { base, workers } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  for (const [label, script] of [
    ['runner contract', 'scripts/mutation-runtime.selftest.mjs'],
    ['classifier contract', 'scripts/mutation-focused-runtime.selftest.mjs'],
  ]) {
    const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error(`${label} failed.`);
  }

  // Every anchor and proof file of every case is checked, selected or not, as the complete run does.
  const groups = FOCUSED_GROUPS.map((group) => loadFocusedGroup(ROOT, group));
  const originals = new Map();
  const items = [];
  const selections = [];
  for (const group of groups) {
    for (const mutation of group.mutations) {
      const proof = group.proofById.get(mutation.id).proof;
      if (proof.kind !== 'vitest') throw new Error(`${mutation.id} has a ${proof.kind} proof; the warm engine judges Vitest proofs only.`);
      if (!existsSync(join(ROOT, mutation.file))) throw new Error(`${mutation.id} source file is missing: ${mutation.file}`);
      if (!existsSync(join(ROOT, proof.testFile))) throw new Error(`${mutation.id} proof file is missing: ${proof.testFile}`);
      if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(join(ROOT, mutation.file), 'utf8'));
      const anchor = replaceExactlyOnce(originals.get(mutation.file), mutation);
      if (anchor.kind === 'invalid') throw new Error(`${mutation.id} INVALID: ${anchor.reason}`);
    }
    const selection = await changedSelection(ROOT, group, base);
    selections.push({ group: group.key, selection: selection.label, selected: selection.cases.length, population: group.mutations.length });
    console.log(selection.cases.length === 0
      ? `PARTIAL — 0 mapped cases; full gate not run (${group.label}: ${selection.label}; all ${group.mutations.length} anchors still match).`
      : `PARTIAL ${group.label} mutation run: ${selection.label}; ${selection.cases.length}/${group.mutations.length} cases`);
    for (const note of selection.notes) console.log(note);
    for (const mutation of selection.cases) {
      const proof = group.proofById.get(mutation.id).proof;
      items.push({ id: mutation.id, group: group.key, file: mutation.file, mutation, testFile: proof.testFile, testName: proof.testName });
    }
  }

  // Never a receipt: the aggregator knows no such schema, and `complete` and `partial` say what this is.
  const report = {
    schema: 'unode-mutation-warm-partial/v1',
    engine: WARM_ENGINE,
    partial: true,
    complete: false,
    base,
    status: 'passed',
    selections,
    cases: [],
    durationMs: 0,
  };
  let failure;
  try {
    if (items.length > 0) {
      assertReleaseRunnerIntegrity({
        root: ROOT,
        baseline: JSON.parse(readFileSync(join(ROOT, 'scripts', 'release-test-baseline.json'), 'utf8')),
      });
      const run = await runWarmEngine({ root: ROOT, items, originals, workerCount: workers, log: console.log });
      const counts = { killed: 0, survived: 0, invalid: 0 };
      for (const item of items) {
        const result = run.results.get(item.id) ?? { verdict: 'invalid', reason: 'the engine returned no result', durationMs: 0 };
        counts[result.verdict] += 1;
        report.cases.push({ id: item.id, group: item.group, verdict: result.verdict, reason: result.reason, durationMs: result.durationMs });
      }
      report.counts = counts;
      const baselineProblems = run.baselines.flatMap((baseline) => baseline.problems);
      if (baselineProblems.length > 0) {
        throw new Error(`Baseline invalid:\n${baselineProblems.slice(0, 10).map((problem) => `  - ${problem}`).join('\n')}`);
      }
      if (counts.invalid > 0) throw new Error(`${counts.invalid} mutation proof(s) were invalid.`);
      if (counts.survived > 0 || counts.killed !== items.length) {
        throw new Error(`${counts.survived} mutant(s) survived; ${counts.killed}/${items.length} killed.`);
      }
    }
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  } finally {
    report.durationMs = Date.now() - started;
    mkdirSync(join(ROOT, '.mutation-receipts'), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (failure) throw failure;
  console.log(`PARTIAL mutation feedback passed for the changes since ${base}${items.length > 0 ? ` (${items.length} case(s) killed in ${((Date.now() - started) / 1000).toFixed(1)}s)` : ''}. This is not the complete gate; CI runs the complete population.`);
}

try {
  await main();
} catch (error) {
  console.error(`PARTIAL mutation feedback FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
