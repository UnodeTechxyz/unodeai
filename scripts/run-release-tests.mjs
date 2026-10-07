#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReleaseTestRun, reporterIdentityFromVitestList } from './release-test-classifier.mjs';
import { assertReleaseRunnerIntegrity, selfTestReleaseRunnerIntegrity } from './release-runner-integrity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'release-test-baseline.json'), 'utf8'));
selfTestReleaseRunnerIntegrity();
assertReleaseRunnerIntegrity({ root, baseline });
const forwarded = process.argv.slice(2);
if (forwarded.some((arg) => arg === '--reporter' || arg.startsWith('--reporter=')
  || arg === '--outputFile' || arg.startsWith('--outputFile=')
  || arg === '--json' || arg.startsWith('--json=') || arg === '--filesOnly' || arg.startsWith('--listTags'))) {
  throw new Error('The release test runner owns reporter/output/discovery controls so completeness cannot be bypassed.');
}
const scratch = mkdtempSync(join(tmpdir(), 'unode-release-tests-'));
const reportPath = join(scratch, 'vitest-report.json');
const discoveryPath = join(scratch, 'vitest-discovery.json');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const started = Date.now();
let report;
let run;
try {
  const discoveryRun = spawnSync(process.execPath, [vitest, 'list', ...forwarded, `--json=${discoveryPath}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  let discovered;
  if (discoveryRun.status === 0 && existsSync(discoveryPath)) {
    try {
      const entries = JSON.parse(readFileSync(discoveryPath, 'utf8'));
      if (Array.isArray(entries) && entries.every((entry) => typeof entry?.file === 'string' && typeof entry?.name === 'string')) {
        discovered = {
          files: new Set(entries.map((entry) => entry.file)).size,
          tests: entries.length,
          testIdentities: entries.map((entry) => reporterIdentityFromVitestList(entry.name)),
        };
      }
    } catch { discovered = undefined; }
  }
  if (discoveryRun.stdout) process.stdout.write(discoveryRun.stdout);
  if (discoveryRun.stderr) process.stderr.write(discoveryRun.stderr);
  if (discoveryRun.status !== 0 || !discovered) {
    throw new Error(`Vitest pre-run discovery failed (exit=${String(discoveryRun.status)}, signal=${String(discoveryRun.signal)}).`);
  }
  run = spawnSync(process.execPath, [vitest, 'run', ...forwarded, '--reporter=json', `--outputFile=${reportPath}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { report = undefined; }
  }
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  const classified = classifyReleaseTestRun({
    exitCode: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    report,
    discovered,
    baseline,
    platform: process.platform,
  });
  const evidence = {
    ...classified.summary,
    ok: classified.ok,
    exitCode: run.status,
    signal: run.signal,
    durationMs: Date.now() - started,
    errors: classified.errors,
  };
  const summaryTarget = process.env.UNODE_RELEASE_TEST_SUMMARY;
  if (summaryTarget) writeFileSync(resolve(summaryTarget), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (!classified.ok) {
    console.error(`\nRelease test gate FAILED:\n- ${classified.errors.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Release test gate passed: ${evidence.files} files, ${evidence.tests} tests, ${evidence.passed} passed, ${evidence.skipped} skipped, 0 pending/failed, ${evidence.durationMs} ms.`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
