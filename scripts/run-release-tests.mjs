#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReleaseTestRun, fileDurationsOf, renderReleaseGateFailure, reporterIdentityFromVitestList } from './release-test-classifier.mjs';
import { assertReleaseRunnerIntegrity, selfTestReleaseRunnerIntegrity } from './release-runner-integrity.mjs';
import { mergeShardRecords, parseShardPart, SHARD_RECORD_SCHEMA, shardRecordName } from './release-test-shards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'release-test-baseline.json'), 'utf8'));
selfTestReleaseRunnerIntegrity();
assertReleaseRunnerIntegrity({ root, baseline });

// v0.9.107 (Owner, 2026-11-21): CI runs the suite as shards and one gate. These modes take no other argument.
//   --release-shard=i/n --shard-out=<dir>   run shard i of n and record it; never says the suite passed
//   --merge-shards=<dir> --shards=n         check the n records are exactly the complete suite, then gate them
// Without them the runner runs the complete suite in one process, as before.
const argv = process.argv.slice(2);
const option = (name) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const shardPart = option('release-shard');
const mergeDir = option('merge-shards');
const mode = shardPart !== undefined ? 'shard' : mergeDir !== undefined ? 'merge' : 'complete';
const forwarded = mode === 'complete' ? argv : [];
if (mode !== 'complete') {
  const allowed = mode === 'shard' ? ['release-shard', 'shard-out'] : ['merge-shards', 'shards'];
  const stray = argv.filter((arg) => !allowed.some((name) => arg.startsWith(`--${name}=`)));
  if (stray.length > 0 || (shardPart !== undefined && mergeDir !== undefined)) {
    throw new Error(`The ${mode} mode of the release test runner takes only ${allowed.map((name) => `--${name}=`).join(' and ')}; got ${stray.join(' ') || 'both modes'}.`);
  }
}
if (forwarded.some((arg) => arg === '--reporter' || arg.startsWith('--reporter=')
  || arg === '--outputFile' || arg.startsWith('--outputFile=')
  || arg === '--json' || arg.startsWith('--json=') || arg === '--filesOnly' || arg.startsWith('--listTags')
  // A part of the suite must never be reported as the complete suite; shards go through --release-shard.
  || arg === '--shard' || arg.startsWith('--shard='))) {
  throw new Error('The release test runner owns reporter/output/discovery/shard controls so completeness cannot be bypassed.');
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const spawnVitest = (args) => spawnSync(process.execPath, [vitest, ...args], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
  env: process.env,
});
const readJson = (file) => {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
};
const echo = (spawned) => {
  if (spawned?.stdout) process.stdout.write(spawned.stdout);
  if (spawned?.stderr) process.stderr.write(spawned.stderr);
};
const validEntries = (entries) => Array.isArray(entries)
  && entries.every((entry) => typeof entry?.file === 'string' && typeof entry?.name === 'string');

/** Gate a run (one process, or merged shards) with the classifier and print and record the verdict. */
function gate({ exitCode, signal, stdout, stderr, report, discovered, started, extraErrors = [], extraEvidence = {} }) {
  const classified = classifyReleaseTestRun({ exitCode, signal, stdout, stderr, report, discovered, baseline, platform: process.platform });
  const errors = [...extraErrors, ...classified.errors];
  const ok = classified.ok && extraErrors.length === 0;
  const evidence = {
    ...classified.summary,
    ok,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    errors,
    ...extraEvidence,
    // v0.9.104 D0.6: for the release chain's timing trend (a report, not a gate).
    fileDurations: fileDurationsOf(report, root),
  };
  const summaryTarget = process.env.UNODE_RELEASE_TEST_SUMMARY;
  if (summaryTarget) writeFileSync(resolve(summaryTarget), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (!ok) {
    console.error(`\n${renderReleaseGateFailure({ ...classified, ok, errors }, { root })}`);
    process.exitCode = 1;
  } else {
    console.log(`Release test gate passed: ${evidence.files} files, ${evidence.tests} tests, ${evidence.passed} passed, ${evidence.skipped} skipped, 0 pending/failed, ${evidence.durationMs} ms.`);
  }
}

const started = Date.now();
const scratch = mkdtempSync(join(tmpdir(), 'unode-release-tests-'));
try {
  if (mode === 'merge') {
    const total = Number(option('shards'));
    if (!Number.isSafeInteger(total) || total < 1 || total > 16) throw new Error(`--shards= must be 1-16; got ${String(option('shards'))}.`);
    const directory = resolve(mergeDir);
    const records = Array.from({ length: total }, (_, slot) => readJson(join(directory, shardRecordName(slot + 1, total))));
    // The gate's own checkout gives the complete file list; listing files does not run or collect them.
    const filesPath = join(scratch, 'vitest-files.json');
    const listed = spawnVitest(['list', '--filesOnly', `--json=${filesPath}`]);
    const files = readJson(filesPath);
    if (listed.status !== 0 || !Array.isArray(files) || !files.every((entry) => typeof entry?.file === 'string')) {
      echo(listed);
      throw new Error(`Vitest file listing failed (exit=${String(listed.status)}, signal=${String(listed.signal)}).`);
    }
    const merged = mergeShardRecords({
      records, total, allFiles: files.map((entry) => entry.file), root, platform: process.platform, commit: process.env.GITHUB_SHA || undefined,
    });
    gate({
      exitCode: merged.exitCode,
      signal: merged.signal,
      stdout: merged.stdout,
      stderr: merged.stderr,
      report: merged.report,
      discovered: merged.discovered,
      started,
      extraErrors: merged.errors,
      extraEvidence: { shards: total, shardDurationsMs: merged.shardDurationsMs },
    });
  } else {
    const part = mode === 'shard' ? parseShardPart(shardPart) : undefined;
    const shardArgs = part ? [`--shard=${part.index}/${part.total}`] : [];
    const reportPath = join(scratch, 'vitest-report.json');
    const discoveryPath = join(scratch, 'vitest-discovery.json');
    const discoveryRun = spawnVitest(['list', ...forwarded, ...shardArgs, `--json=${discoveryPath}`]);
    const entries = discoveryRun.status === 0 ? readJson(discoveryPath) : undefined;
    echo(discoveryRun);
    const discoveryOk = validEntries(entries);
    const run = discoveryOk ? spawnVitest(['run', ...forwarded, ...shardArgs, '--reporter=json', `--outputFile=${reportPath}`]) : undefined;
    const report = run ? readJson(reportPath) : undefined;
    echo(run);
    if (part) {
      const out = option('shard-out');
      if (!out) throw new Error('--release-shard= needs --shard-out=<dir>.');
      mkdirSync(resolve(out), { recursive: true });
      const record = {
        schema: SHARD_RECORD_SCHEMA,
        index: part.index,
        total: part.total,
        platform: process.platform,
        commit: process.env.GITHUB_SHA || undefined,
        exitCode: run ? run.status : discoveryRun.status,
        signal: run ? run.signal : discoveryRun.signal,
        stdout: run?.stdout ?? '',
        stderr: run?.stderr ?? '',
        discovery: discoveryOk ? entries : undefined,
        ...(discoveryOk ? {} : { discoveryError: `Vitest pre-run discovery failed (exit=${String(discoveryRun.status)}, signal=${String(discoveryRun.signal)}).` }),
        report,
        durationMs: Date.now() - started,
      };
      writeFileSync(join(resolve(out), shardRecordName(part.index, part.total)), `${JSON.stringify(record)}\n`, 'utf8');
      // A shard only records. Its exit says whether its own part ran cleanly, so a red shard is visible at once;
      // whether the suite passed is decided only by the merge gate.
      const clean = discoveryOk && run?.status === 0 && report?.success === true;
      console.log(`Release shard ${part.index}/${part.total} recorded (${clean ? 'its part ran cleanly' : 'its part did NOT run cleanly'}); the merge gate decides the suite.`);
      if (!clean) process.exitCode = 1;
    } else {
      if (!discoveryOk) {
        throw new Error(`Vitest pre-run discovery failed (exit=${String(discoveryRun.status)}, signal=${String(discoveryRun.signal)}).`);
      }
      gate({
        exitCode: run.status,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
        report,
        discovered: {
          files: new Set(entries.map((entry) => entry.file)).size,
          tests: entries.length,
          testIdentities: entries.map((entry) => reporterIdentityFromVitestList(entry.name)),
        },
        started,
      });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
