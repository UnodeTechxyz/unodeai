#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ALL_MUTATIONS as MAIN_MUTATIONS } from './mutation-check.mjs';
import { ALL_MUTATIONS as V0973_MUTATIONS } from './mutation-check-v0973.mjs';
import {
  createMutationCopyFilter,
  parseMutationSelection,
  replaceExactlyOnce,
  selectMutationCases,
} from './mutation-runtime.mjs';
import {
  classifyCheckerProof,
  classifyVitestProof,
  escapeTestName,
  MAIN_PROOF_SCHEMA,
  validateProofManifest,
  V0973_PROOF_SCHEMA,
} from './mutation-focused-runtime.mjs';
import { assertReleaseRunnerIntegrity } from './release-runner-integrity.mjs';

const ROOT = resolve('.');
const REPORT_SCHEMA = 'unode-focused-mutation-report/v1';
const GROUPS = {
  main: {
    key: 'main',
    label: 'main',
    mutations: MAIN_MUTATIONS,
    manifestPath: join(ROOT, 'scripts', 'mutation-main-proofs.json'),
    proofSchema: MAIN_PROOF_SCHEMA,
    defaultReport: '.mutation-receipts/main-focused.json',
  },
  v0973: {
    key: 'v0973',
    label: 'v0.9.73',
    mutations: V0973_MUTATIONS,
    manifestPath: join(ROOT, 'scripts', 'mutation-v0973-proofs.json'),
    proofSchema: V0973_PROOF_SCHEMA,
    defaultReport: '.mutation-receipts/v0973-focused.json',
  },
};

function parseArgs(args) {
  let report;
  let group = 'main';
  const selectionArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--report' || arg.startsWith('--report=')) {
      const inline = arg.startsWith('--report=') ? arg.slice('--report='.length) : args[++index];
      if (!inline) throw new Error('--report requires a workspace-relative path.');
      report = inline;
    } else if (arg === '--group' || arg.startsWith('--group=')) {
      const inline = arg.startsWith('--group=') ? arg.slice('--group='.length) : args[++index];
      if (!inline) throw new Error('--group requires main or v0973.');
      group = inline;
    } else {
      selectionArgs.push(arg);
    }
  }
  const config = GROUPS[group];
  if (!config) throw new Error(`Unknown focused mutation group: ${group}.`);
  report ??= config.defaultReport;
  if (report.includes('\0')) throw new Error('--report contains an invalid character.');
  const absoluteReport = resolve(ROOT, report);
  if (absoluteReport === ROOT || !absoluteReport.startsWith(`${ROOT}${sep}`)) {
    throw new Error('--report must stay inside the workspace.');
  }
  return { config, selection: parseMutationSelection(selectionArgs), report: absoluteReport };
}

function resolveNodeModules(start) {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules');
    if (existsSync(join(candidate, 'vitest', 'vitest.mjs'))) return candidate;
    if (dirname(directory) === directory) throw new Error(`could not find Vitest above ${start}`);
  }
}

function gitFact(args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

function npmVersion() {
  const candidates = [
    process.env.npm_execpath ? resolve(dirname(process.env.npm_execpath), '..', 'package.json') : undefined,
    join(dirname(process.execPath), 'node_modules', 'npm', 'package.json'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'package.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  }
  return 'unavailable';
}

function cleanupSandbox(sandbox) {
  if (!sandbox) return;
  try { rmdirSync(join(sandbox, 'node_modules')); } catch { /* junction may already be absent */ }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* created temp root only */ }
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function main() {
  const { config, selection, report: reportPath } = parseArgs(process.argv.slice(2));
  if (selection.list) {
    const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
    const proofById = validateProofManifest(manifest, config.mutations, config.proofSchema);
    for (const mutation of config.mutations) {
      const entry = proofById.get(mutation.id);
      console.log(`${mutation.id}\t${mutation.file}\t${entry.proof.kind === 'vitest' ? entry.proof.testFile : entry.proof.script}\t${mutation.name}`);
    }
    return;
  }
  const selected = selectMutationCases(config.mutations, selection);
  let sequence = 0;
  const started = Date.now();
  let sandbox;
  let proofById;
  let failure;
  const trackedStatus = gitFact(['status', '--porcelain', '--untracked-files=no']) ?? '';
  const fullStatus = gitFact(['status', '--porcelain']) ?? '';
  const report = {
    schema: REPORT_SCHEMA,
    group: config.key,
    sourceCommit: gitFact(['rev-parse', 'HEAD']) ?? 'unavailable',
    dirty: Boolean(trackedStatus),
    untrackedFilesPresent: fullStatus.split(/\r?\n/).some((line) => line.startsWith('?? ')),
    status: 'invalid',
    complete: false,
    requestedComplete: selected.complete,
    selection: selected.label,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: npmVersion(),
    vitest: 'unavailable',
    manifestSha256: 'unavailable',
    populationIds: config.mutations.map((mutation) => mutation.id),
    admittedIds: selected.cases.map((mutation) => mutation.id),
    baseline: { status: 'not-run', durationMs: 0, proofFiles: [] },
    cases: [],
    counts: { killed: 0, survived: 0, invalid: 0, notSelected: config.mutations.length - selected.cases.length },
    durationMs: 0,
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  rmSync(reportPath, { force: true });
  try {
    const manifestText = readFileSync(config.manifestPath, 'utf8');
    report.manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
    const manifest = JSON.parse(manifestText);
    proofById = validateProofManifest(manifest, config.mutations, config.proofSchema);
    report.vitest = JSON.parse(readFileSync(join(resolveNodeModules(ROOT), 'vitest', 'package.json'), 'utf8')).version;
    assertReleaseRunnerIntegrity({
      root: ROOT,
      baseline: JSON.parse(readFileSync(join(ROOT, 'scripts', 'release-test-baseline.json'), 'utf8')),
    });

    for (const mutation of config.mutations) {
      const sourcePath = join(ROOT, mutation.file);
      const entry = proofById.get(mutation.id);
      if (!existsSync(sourcePath)) throw new Error(`${mutation.id} source file is missing: ${mutation.file}`);
      const anchor = replaceExactlyOnce(readFileSync(sourcePath, 'utf8'), mutation);
      if (anchor.kind === 'invalid') throw new Error(`${mutation.id} INVALID: ${anchor.reason}`);
      const proofPath = entry.proof.kind === 'vitest' ? entry.proof.testFile : entry.proof.script;
      if (!existsSync(join(ROOT, proofPath))) throw new Error(`${mutation.id} proof file is missing: ${proofPath}`);
    }

    sandbox = mkdtempSync(join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `unode-${config.key}-focused-`));
    cpSync(ROOT, sandbox, { recursive: true, filter: createMutationCopyFilter(ROOT) });
    const nodeModules = resolveNodeModules(ROOT);
    symlinkSync(nodeModules, join(sandbox, 'node_modules'), 'junction');
    const vitest = join(sandbox, 'node_modules', 'vitest', 'vitest.mjs');
    const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --preserve-symlinks --preserve-symlinks-main`.trim();
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };

    function runVitest(testFiles, testName, timeoutMs = 60_000) {
      const jsonPath = join(sandbox, `.focused-report-${sequence++}.json`);
      try { unlinkSync(jsonPath); } catch { /* absent */ }
      const args = [
        vitest,
        'run',
        ...testFiles,
        ...(testName ? ['--testNamePattern', escapeTestName(testName)] : []),
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile=${jsonPath}`,
      ];
      const runStarted = Date.now();
      const result = spawnSync(process.execPath, args, {
        cwd: sandbox,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      let json;
      try { json = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { /* classified below */ }
      const tests = [];
      const collectionErrors = [];
      for (const fileResult of json?.testResults ?? []) {
        const file = relative(sandbox, fileResult.name).replaceAll('\\', '/');
        const assertions = fileResult.assertionResults ?? [];
        for (const assertion of assertions) {
          tests.push({
            file,
            name: assertion.fullName,
            status: assertion.status,
            failureMessages: assertion.failureMessages ?? [],
          });
        }
        if (fileResult.status === 'failed' && !assertions.some((assertion) => assertion.status === 'failed')) {
          collectionErrors.push(file);
        }
      }
      return {
        exitCode: result.status,
        error: result.error ? String(result.error) : undefined,
        timedOut: result.error?.code === 'ETIMEDOUT',
        reportMissing: !json,
        tests,
        collectionErrors,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - runStarted,
      };
    }

    function runChecker(proof) {
      const runStarted = Date.now();
      const result = spawnSync(process.execPath, [proof.script], {
        cwd: sandbox,
        env,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        exitCode: result.status,
        error: result.error ? String(result.error) : undefined,
        timedOut: result.error?.code === 'ETIMEDOUT',
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - runStarted,
      };
    }

    const selectedEntries = selected.cases.map((mutation) => proofById.get(mutation.id));
    const proofFiles = [...new Set(selectedEntries.filter((entry) => entry.proof.kind === 'vitest').map((entry) => entry.proof.testFile))];
    const baselineStarted = Date.now();
    const vitestBaseline = proofFiles.length > 0 ? runVitest(proofFiles, undefined, 180_000) : undefined;
    const baselineProblems = [];
    if (vitestBaseline) {
      if (vitestBaseline.exitCode !== 0 || vitestBaseline.error || vitestBaseline.timedOut
          || vitestBaseline.reportMissing || vitestBaseline.collectionErrors.length > 0) {
        baselineProblems.push('grouped Vitest baseline did not complete green');
      }
      for (const entry of selectedEntries.filter((candidate) => candidate.proof.kind === 'vitest')) {
        const matches = vitestBaseline.tests.filter((test) =>
          test.file === entry.proof.testFile && test.name === entry.proof.testName && test.status === 'passed');
        if (matches.length !== 1) baselineProblems.push(`${entry.id} baseline proof matched ${matches.length} passing tests`);
      }
    }
    for (const entry of selectedEntries.filter((candidate) => candidate.proof.kind === 'checker')) {
      const checkerBaseline = runChecker(entry.proof);
      if (checkerBaseline.exitCode !== 0 || checkerBaseline.error || checkerBaseline.timedOut) {
        baselineProblems.push(`${entry.id} checker baseline did not pass`);
      }
    }
    report.baseline = {
      status: baselineProblems.length === 0 ? 'passed' : 'invalid',
      durationMs: Date.now() - baselineStarted,
      timeoutMs: 180_000,
      proofFiles,
      problems: baselineProblems,
    };
    if (baselineProblems.length > 0) throw new Error(`Focused baseline invalid:\n${baselineProblems.map((item) => `  - ${item}`).join('\n')}`);
    console.log(`${selected.complete ? 'COMPLETE' : 'PARTIAL'} focused ${config.label} mutation run: ${selected.label}; ${selected.cases.length}/${config.mutations.length} cases`);
    console.log(`baseline green: ${proofFiles.length} proof files in ${(report.baseline.durationMs / 1000).toFixed(1)}s`);

    const originals = new Map([...new Set(config.mutations.map((mutation) => mutation.file))]
      .map((file) => [file, readFileSync(join(sandbox, file), 'utf8')]));
    for (const mutation of selected.cases) {
      const entry = proofById.get(mutation.id);
      const sourcePath = join(sandbox, mutation.file);
      const original = originals.get(mutation.file);
      const applied = replaceExactlyOnce(original, mutation);
      let outcome;
      let durationMs = 0;
      try {
        if (applied.kind === 'invalid') {
          outcome = { verdict: 'invalid', reason: applied.reason };
        } else {
          writeFileSync(sourcePath, applied.text, 'utf8');
          if (entry.proof.kind === 'vitest') {
            const run = runVitest([entry.proof.testFile], entry.proof.testName);
            durationMs = run.durationMs;
            outcome = classifyVitestProof(run, entry.proof);
          } else {
            const run = runChecker(entry.proof);
            durationMs = run.durationMs;
            outcome = classifyCheckerProof(run, entry.proof);
          }
        }
      } finally {
        writeFileSync(sourcePath, original, 'utf8');
      }
      report.counts[outcome.verdict]++;
      report.cases.push({
        id: mutation.id,
        proof: entry.proof.kind === 'vitest'
          ? { kind: 'vitest', testFile: entry.proof.testFile, testName: entry.proof.testName }
          : { kind: 'checker', script: entry.proof.script, expectedFinding: entry.proof.expectedFinding },
        verdict: outcome.verdict,
        reason: outcome.reason,
        durationMs,
      });
      console.log(`${outcome.verdict.toUpperCase().padEnd(8)} ${mutation.id} ${(durationMs / 1000).toFixed(1)}s${outcome.reason ? ` — ${outcome.reason}` : ''}`);
    }
    if (report.counts.invalid > 0) {
      report.status = 'invalid';
      report.error = `${report.counts.invalid} mutation proof(s) were invalid.`;
    } else if (report.counts.survived > 0 || report.counts.killed !== selected.cases.length) {
      report.status = 'failed';
      report.error = `${report.counts.survived} mutant(s) survived; ${report.counts.killed}/${selected.cases.length} killed.`;
    } else {
      report.status = 'passed';
      report.complete = selected.complete;
    }
  } catch (error) {
    failure = error;
    report.status = 'invalid';
    report.complete = false;
    report.error = errorMessage(error);
  } finally {
    report.durationMs = Date.now() - started;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    cleanupSandbox(sandbox);
  }

  if (failure) throw failure;
  if (report.status !== 'passed') throw new Error(`Focused ${config.label} mutation gate ${report.status}: ${report.error}`);
  console.log(`Focused ${config.label} mutation population passed (${report.counts.killed}/${selected.cases.length}; complete=${report.complete}; ${(report.durationMs / 1000).toFixed(1)}s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
