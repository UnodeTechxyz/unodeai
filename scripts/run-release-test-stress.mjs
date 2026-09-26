#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = 20;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.UNODE_RELEASE_TEST_STRESS_DIR ?? join(root, 'release-test-stress'));
mkdirSync(output, { recursive: true });
const results = [];
for (let index = 1; index <= RUNS; index++) {
  const label = String(index).padStart(2, '0');
  const summary = join(output, `run-${label}.json`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'run-release-tests.mjs')], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, UNODE_RELEASE_TEST_SUMMARY: summary },
  });
  writeFileSync(join(output, `run-${label}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`, 'utf8');
  let evidence;
  try { evidence = JSON.parse(readFileSync(summary, 'utf8')); } catch { evidence = undefined; }
  results.push({ run: index, exitCode: run.status, signal: run.signal, durationMs: Date.now() - started, evidence });
  console.log(`release stress ${label}/${RUNS}: ${run.status === 0 && evidence?.ok ? 'complete' : 'FAILED'}`);
}
const manifest = { runs: RUNS, completed: results.filter((entry) => entry.exitCode === 0 && entry.evidence?.ok).length, results };
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
if (manifest.completed !== RUNS) {
  console.error(`Release stress gate FAILED: ${manifest.completed}/${RUNS} suites were complete. Logs: ${output}`);
  process.exitCode = 1;
} else {
  console.log(`Release stress gate passed: all ${RUNS} suites complete. Evidence: ${output}`);
}
