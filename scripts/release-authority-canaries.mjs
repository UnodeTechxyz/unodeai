#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Release authority-canary harness (runbook step 4a).
 *
 *  This is deliberately separate from test:mutation. It verifies the twelve release-boundary
 *  mutations from docs/CODEX_TASKS_v0962.md against a disposable working-tree copy. A non-zero
 *  Vitest exit is not automatically a kill: only a completed run with counted test assertion
 *  failures is one. Runner crashes, timeouts and source anchors that moved are invalid evidence.
 *--------------------------------------------------------------------------------------------*/

import {
  cpSync, existsSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve('.');
const SANDBOX_ROOT = process.env.RUNNER_TEMP?.trim() || tmpdir();
const SANDBOX = join(SANDBOX_ROOT, `unodeai-release-authority-${process.pid}`);
const REPORT = '.release-authority-canaries.json';
const EXCLUDE_NAMES = new Set([
  'node_modules', '.git', 'dist', 'out', 'coverage', '.vscode-test', '.ovsx-pat',
  '.audit-worktrees', '.docx_review_icii', '.impl-worktrees',
]);
const excludes = (source) => EXCLUDE_NAMES.has(basename(source)) || source.endsWith('.vsix');

const MUTATIONS = [
  {
    id: 'C1',
    boundary: 'coordinator fallback repeats the full contract filter set',
    file: 'src/backend/TeamTools.ts',
    suite: 'src/backend/__tests__/TeamTools.test.ts',
    test: 're-evaluates host task scope when delegate-preferred work falls back to the coordinator|re-evaluates capability, sensor, and claim filters when delegate-preferred work falls back to the coordinator',
    from: '    const failures = this.contractCandidateFailures(contract, coordinator);',
    to: '    const failures: string[] = [];',
  },
  {
    id: 'C2',
    boundary: 'contract read scope only narrows configured read authority',
    file: 'src/backend/WorkspaceTools.ts',
    suite: 'src/backend/__tests__/WorkspaceToolsFolderAccess.test.ts',
    test: 'refuses a contract read scope outside configured roots without granting access',
    from: '      if (!configuredReadRoots.some((root) => isInside(root, absolute))) return false;',
    to: '      if (false) return false;',
  },
  {
    id: 'C3',
    boundary: 'contract readwrite scope only narrows configured write authority',
    file: 'src/backend/WorkspaceTools.ts',
    suite: 'src/backend/__tests__/WorkspaceToolsFolderAccess.test.ts',
    test: 'refuses a contract readwrite scope for an additional read root without granting writes',
    from: '        if (!this.configuredWriteRoots.some((root) => isInside(root, absolute))) return false;',
    to: '        if (false) return false;',
  },
  {
    id: 'C4',
    boundary: 'an input grant dies when its attempt settles',
    file: 'src/backend/TaskContract.ts',
    suite: 'src/backend/__tests__/TaskContract.test.ts',
    test: 'uses the shared attempt-liveness predicate when granting declared contract-managed content',
    from: '    attempt.state = state;',
    to: "    attempt.state = 'live';",
  },
  {
    id: 'C5',
    boundary: 'a contract has at most one live attempt',
    file: 'src/backend/TaskContract.ts',
    suite: 'src/backend/__tests__/TaskContract.test.ts',
    test: 'reserves a contract before async snapshot work so concurrent attempts cannot both become live',
    from: '    if (this.liveAttemptByContract.has(contract.contractId)) {',
    to: '    if (false) {',
  },
  {
    id: 'C6',
    boundary: 'Solo is never an automatic delegation fallback',
    file: 'src/backend/TeamTools.ts',
    suite: 'src/backend/__tests__/TeamTools.test.ts',
    test: 'never makes Solo the only automatic contract-routing candidate',
    from: "    return this.view.list().filter((a) => a.id !== this.selfId && a.role !== 'solo');",
    to: '    return this.view.list().filter((a) => a.id !== this.selfId);',
  },
  {
    id: 'C7',
    boundary: 'Solo is not reachable by exact identifier or alias',
    file: 'src/backend/TeamTools.ts',
    suite: 'src/backend/__tests__/TeamTools.test.ts',
    test: 'excludes the standalone Solo agent from delegation',
    from: "    if (this.view.list().some((a) => a.id === resolved.id && a.role === 'solo')) { return undefined; }",
    to: '    if (false) { return undefined; }',
  },
  {
    id: 'C8',
    boundary: 'recorded-file open takes its path from the host receipt',
    file: 'src/views/toolReceipt.ts',
    suite: 'src/views/__tests__/toolReceipt.test.ts',
    test: 'refuses an absolute path outside the agent read roots',
    from: "  const candidate = path.isAbsolute(recordedPath)\n    ? path.resolve(recordedPath)\n    : path.resolve(primaryRoot, recordedPath);",
    to: "  const candidate = path.resolve(primaryRoot, 'docs/guide.md');",
  },
  {
    id: 'C9',
    boundary: 'recorded-file open resolves a physical path before root comparison',
    file: 'src/views/toolReceipt.ts',
    suite: 'src/views/__tests__/toolReceipt.test.ts',
    test: 'compares the physical target so a symlink cannot escape the read root',
    from: '    physicalPath = realpath(candidate);',
    to: '    physicalPath = candidate;',
  },
  {
    id: 'C10',
    boundary: 'recorded-file open checks the selected agent\'s current read roots',
    file: 'src/views/toolReceipt.ts',
    suite: 'src/views/__tests__/toolReceipt.test.ts',
    test: 'refuses an absolute path outside the agent read roots',
    from: '  const allowed = readRoots.some((root) => {',
    to: '  const allowed = true; if (false) readRoots.some((root) => {',
  },
  {
    id: 'C11',
    boundary: 'a firm retry begins only after the first task attempt has settled',
    file: 'src/backend/TeamTools.ts',
    suite: 'src/backend/__tests__/TeamTools.test.ts',
    test: 'settles the first contract attempt before a firm retry receives a fresh lease',
    from: "      if (taskAttempt) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, 'settled');",
    to: '      if (false) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, \'settled\');',
  },
  {
    id: 'C12',
    boundary: 'hook approval binds the exact normalized declaration digest',
    file: 'src/backend/ExecutionHooks.ts',
    suite: 'src/backend/__tests__/ExecutionHooks.test.ts',
    test: 'keeps a workspace setting inert until the exact normalized declaration and origin are explicitly approved',
    from: '    approval?.version !== 1\n    || approval.digest !== candidate.digest\n    || approval.origin !== origin',
    to: '    approval?.version !== 1\n    || false\n    || approval.origin !== origin',
  },
];

function resolveNodeModules(start) {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'node_modules');
    if (existsSync(join(candidate, 'vitest', 'vitest.mjs'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not find Vitest node_modules above ${start}.`);
    directory = parent;
  }
}

function eolFor(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function inFileEol(snippet, text) {
  return snippet.split('\n').join(eolFor(text));
}

function replaceExactlyOnce(text, mutation) {
  const from = inFileEol(mutation.from, text);
  const first = text.indexOf(from);
  if (first < 0 || first !== text.lastIndexOf(from)) {
    return { kind: 'invalid', reason: `anchor is not present exactly once in ${mutation.file}` };
  }
  return { kind: 'mutated', text: `${text.slice(0, first)}${inFileEol(mutation.to, text)}${text.slice(first + from.length)}` };
}

function verdictFor(run) {
  if (run.error || run.status === null || run.timedOut) {
    return { kind: 'invalid', reason: 'runner crashed, could not launch, or timed out' };
  }
  if (!run.summary) return { kind: 'invalid', reason: 'runner exited without a JSON test summary' };
  if (run.status === 0 && run.summary.numFailedTests === 0) return { kind: 'passed' };
  if (run.status !== 0 && run.summary.numFailedTests > 0) return { kind: 'killed' };
  return { kind: 'invalid', reason: `exit ${run.status} with ${run.summary.numFailedTests} counted failed test(s)` };
}

function runSuite(suite, test, label) {
  const reportPath = join(SANDBOX, REPORT);
  try { unlinkSync(reportPath); } catch { /* no report from a prior run */ }
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --preserve-symlinks --preserve-symlinks-main`.trim();
  const result = spawnSync(
    process.execPath,
    [join(SANDBOX, 'node_modules', 'vitest', 'vitest.mjs'), 'run', suite, '--testNamePattern', test,
      '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${REPORT}`],
    { cwd: SANDBOX, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: nodeOptions } },
  );
  let summary;
  try {
    summary = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch { /* a crash or reporter failure has no trustworthy counted result */ }
  return {
    status: result.status,
    error: result.error,
    timedOut: result.error?.code === 'ETIMEDOUT',
    summary: summary && typeof summary.numFailedTests === 'number' ? summary : undefined,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    label,
  };
}

function selfTest() {
  const missing = replaceExactlyOnce('const present = true;', {
    file: 'fixture.ts', from: 'const absent = true;', to: 'const absent = false;',
  });
  if (missing.kind !== 'invalid') throw new Error('self-test failed: missing anchor did not become invalid');
  const zeroFailureCrash = verdictFor({ status: 1, summary: { numFailedTests: 0 } });
  if (zeroFailureCrash.kind !== 'invalid') throw new Error('self-test failed: zero-failure non-zero exit became a kill');
}

function cleanup() {
  try { rmdirSync(join(SANDBOX, 'node_modules')); } catch { /* junction may not exist */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* never erase outside the sandbox */ }
}

const developmentSources = new Map(
  [...new Set(MUTATIONS.map((mutation) => mutation.file))].map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]),
);

let exitCode = 0;
try {
  selfTest();
  cpSync(ROOT, SANDBOX, { recursive: true, filter: (source) => !excludes(source) });
  symlinkSync(resolveNodeModules(ROOT), join(SANDBOX, 'node_modules'), 'junction');
  const originals = new Map(
    [...new Set(MUTATIONS.map((mutation) => mutation.file))].map((file) => [file, readFileSync(join(SANDBOX, file), 'utf8')]),
  );

  console.log(`sandbox: ${SANDBOX}`);
  console.log('self-test: missing anchors and zero-failure crashes are invalid');
  for (const mutation of MUTATIONS) {
    const baseline = verdictFor(runSuite(mutation.suite, mutation.test, `baseline ${mutation.id}`));
    if (baseline.kind !== 'passed') {
      console.error(`BASELINE INVALID ${mutation.id}: ${baseline.reason ?? 'tests did not pass'}`);
      exitCode = 1;
      break;
    }
    console.log(`baseline green  ${mutation.id}  ${mutation.test}`);
  }

  if (exitCode === 0) {
    const failures = [];
    for (const mutation of MUTATIONS) {
      const original = originals.get(mutation.file);
      if (original === undefined) throw new Error(`missing captured original for ${mutation.file}`);
      const applied = replaceExactlyOnce(original, mutation);
      if (applied.kind === 'invalid') {
        console.error(`${mutation.id} INVALID  ${mutation.boundary}: ${applied.reason}`);
        failures.push(mutation.id);
        continue;
      }
      try {
        writeFileSync(join(SANDBOX, mutation.file), applied.text, 'utf8');
        const verdict = verdictFor(runSuite(mutation.suite, mutation.test, mutation.id));
        if (verdict.kind === 'killed') {
          console.log(`${mutation.id} killed   ${mutation.boundary}`);
        } else {
          console.error(`${mutation.id} ${verdict.kind === 'passed' ? 'SURVIVED' : 'INVALID '}  ${mutation.boundary}${verdict.reason ? `: ${verdict.reason}` : ''}`);
          failures.push(mutation.id);
        }
      } finally {
        writeFileSync(join(SANDBOX, mutation.file), original, 'utf8');
      }
    }
    if (failures.length > 0) {
      console.error(`release authority canaries failed: ${failures.join(', ')}`);
      exitCode = 1;
    } else {
      console.log(`every release authority canary killed (${MUTATIONS.length}/${MUTATIONS.length})`);
    }
  }
} catch (error) {
  console.error(`release authority canary harness failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  cleanup();
  for (const [file, source] of developmentSources) {
    if (readFileSync(join(ROOT, file), 'utf8') !== source) {
      console.error(`DEVELOPMENT TREE CHANGED while running canaries: ${file}`);
      exitCode = 1;
    }
  }
}

process.exitCode = exitCode;
