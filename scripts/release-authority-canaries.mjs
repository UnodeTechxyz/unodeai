#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Release authority-canary harness (runbook step 4a).
 *
 *  This is deliberately separate from test:mutation. It verifies the release-boundary
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
import { replaceExactlyOnce } from './mutation-runtime.mjs';

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
  {
    id: 'C13',
    boundary: 'a project team file cannot inject environment variables',
    file: 'src/state/TeamFileSchema.ts',
    suite: 'src/state/__tests__/TeamFileSchema.test.ts',
    test: 'removes every host-only field and only accepts proven permission narrowing',
    from: "  env: 'host-only',",
    to: "  env: 'data',",
  },
  {
    id: 'C14',
    boundary: 'a project team file cannot enable automatic approval',
    file: 'src/state/TeamFileSchema.ts',
    suite: 'src/state/__tests__/TeamFileSchema.test.ts',
    test: 'removes every host-only field and only accepts proven permission narrowing',
    from: "  autoApprove: 'host-only',",
    to: "  autoApprove: 'data',",
  },
  {
    id: 'C15',
    boundary: 'Claude launches the resolved absolute host executable',
    file: 'src/backend/ClaudeHeadlessBackend.ts',
    suite: 'src/backend/__tests__/ClaudeHeadlessBackend.test.ts',
    test: 'spawns the host-resolved absolute Claude executable, never the bare workspace-searchable name',
    from: '    const executable = this.deps.resolveExecutable?.(requestedExecutable) ?? requestedExecutable;',
    to: '    const executable = requestedExecutable;',
  },
  {
    id: 'C16',
    boundary: 'the host Git probe never uses shell lookup',
    file: 'src/security/HostExecutableResolver.ts',
    suite: 'src/security/__tests__/HostExecutableResolver.test.ts',
    test: 'forces the host git probe to bypass shell lookup',
    from: '  return { ...(cwd ? { cwd } : {}), shell: false };',
    to: '  return { ...(cwd ? { cwd } : {}), shell: true };',
  },
  {
    id: 'C17',
    boundary: 'a Windows Claude shim path with spaces remains one quoted shell token',
    file: 'src/backend/ClaudeHeadlessBackend.ts',
    suite: 'src/backend/__tests__/ClaudeHeadlessBackend.test.ts',
    test: 'spawns the host-resolved absolute Claude executable, never the bare workspace-searchable name',
    from: '    const spawnExecutable = useShell ? `"${executable}"` : executable;',
    to: '    const spawnExecutable = executable;',
  },
  {
    id: 'C18',
    boundary: 'legacy project MCP configuration crosses into host state only with an exact prior approval',
    file: 'src/state/PersistenceManager.ts',
    suite: 'src/state/__tests__/PersistenceManager.test.ts',
    test: 'imports only already-approved legacy team MCP servers and renames the Roam state keys',
    from: '        if (validated && approvedKeys.has(approvalKey(validated, folder.uri.fsPath))) {',
    to: '        if (validated) {',
  },
  {
    id: 'C19',
    boundary: 'legacy roster cleanup removes only env and autoApprove',
    file: 'src/state/TeamFileSchema.ts',
    suite: 'src/state/__tests__/PersistenceManager.test.ts',
    test: 'clears only immediate authority from a source-unknown legacy roster and preserves user configuration',
    from: "  const immediateAuthorityFields = new Set<keyof AgentConfig>(['env', 'autoApprove']);",
    to: "  const immediateAuthorityFields = new Set<keyof AgentConfig>(['env', 'autoApprove', 'skills']);",
  },
  {
    id: 'C20',
    boundary: 'the global Team Library uses host-owned validation',
    file: 'src/state/PersistenceManager.ts',
    suite: 'src/state/__tests__/TeamLibraryPersistence.test.ts',
    test: 'preserves host-owned global MCP and env grants and never places automatic snapshots globally',
    from: "        ref.scope === 'global'\n          ? { authority: 'host-owned' }\n          : { workspaceRoot: currentWorkspaceRoot() },",
    to: '        { workspaceRoot: currentWorkspaceRoot() },',
  },
  {
    id: 'C21',
    boundary: 'a workspace child beginning with two dots is still inside the workspace',
    file: 'src/security/HostExecutableResolver.ts',
    suite: 'src/security/__tests__/HostExecutableResolver.test.ts',
    test: 'recognises a child whose name begins with two dots as workspace-owned',
    from: "  const escapesRoot = relative === '..' || relative.startsWith(`..${pathApi.sep}`);",
    to: "  const escapesRoot = relative.startsWith('..');",
  },
  {
    id: 'C22',
    boundary: 'a typed egress decline is not retried as a transient non-streaming failure',
    file: 'src/backend/OpenAICompatBackend.ts',
    suite: 'src/backend/__tests__/OpenAICompatBackend.test.ts',
    test: 'gates network egress: onBeforeEgress runs with the request URL before any fetch, and declining sends nothing',
    from: "      } catch (err) {\n        if (isEgressConsentDeclined(err)) {\n          throw err;\n        }\n        // Network error or timeout — always retryable until we run out of attempts.",
    to: "      } catch (err) {\n        // Network error or timeout — always retryable until we run out of attempts.",
  },
  {
    id: 'C23',
    boundary: 'a typed streaming decline cannot enter body repair or non-streaming fallback',
    file: 'src/backend/OpenAICompatBackend.ts',
    suite: 'src/backend/__tests__/OpenAICompatBackend.test.ts',
    test: 'does not body-repair or fall back after a typed streaming consent decline',
    from: "    } catch (err) {\n      clearWatchdog();\n      if (isEgressConsentDeclined(err)) {\n        throw err;\n      }\n      if (watchdogExpired) {",
    to: "    } catch (err) {\n      clearWatchdog();\n      if (watchdogExpired) {",
  },
  {
    id: 'C24',
    boundary: 'every project-state key is physically namespaced by canonical workspace root',
    file: 'src/state/RootScopedWorkspaceState.ts',
    suite: 'src/state/__tests__/RootScopedWorkspaceState.test.ts',
    test: 'isolates fixed and dynamic keys in one reused backing bucket',
    from: '  private scopedKey(key: string): string {\n    return `${this.prefix}${key}`;\n  }',
    to: '  private scopedKey(key: string): string {\n    return key;\n  }',
  },
  {
    id: 'C25',
    boundary: 'a reused Devin bucket never imports or falls back to unscoped legacy project state',
    file: 'src/state/RootScopedWorkspaceState.ts',
    suite: 'src/state/__tests__/RootScopedWorkspaceState.test.ts',
    test: 'does not import or fall back to old state in Devin or an unknown host',
    from: "    if (!this.prefix || !this.isAvailable() || host === 'other') return [];",
    to: '    if (!this.prefix || !this.isAvailable()) return [];',
  },
  {
    id: 'C26',
    // Repointed for v0.9.84: the original anchor guarded the read-only-until-UnodeAi-decides design, which the
    // native permission profiles replaced. The boundary that exists now is the backend turning a resolved
    // Read only (Plan, or a trust/folder/tool cap) into the turn sandbox; the resolver half is the focused
    // mutant main-v0984-codex-decision.
    boundary: 'a Codex turn that must be read-only is given a writable sandbox',
    file: 'src/backend/CodexBackend.ts',
    suite: 'src/backend/__tests__/CodexBackend.test.ts',
    test: 'uses Codex read-only permissions for Plan mode',
    from: "    if (profile === 'read-only') {",
    to: "    if (false && profile === 'read-only') {",
  },
  {
    id: 'C27',
    boundary: 'a CLI start refusal terminates its queued chat turn',
    file: 'src/session/SessionManager.ts',
    suite: 'src/session/__tests__/consentLifecycle.test.ts',
    test: 'terminates the queued chat turn with the refusal reason and starts the next message as a fresh turn',
    from: '    this.rejectQueuedTurns(info.id, message);',
    to: '    // queued turn left pending',
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
  const duplicate = replaceExactlyOnce('const repeated = true;\nconst repeated = true;', {
    file: 'fixture.ts', from: 'const repeated = true;', to: 'const repeated = false;',
  });
  if (duplicate.kind !== 'invalid') throw new Error('self-test failed: duplicated anchor did not become invalid');
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

  const invalidAnchors = MUTATIONS.flatMap((mutation) => {
    const original = originals.get(mutation.file);
    if (original === undefined) return [`${mutation.id}: source file was not copied (${mutation.file})`];
    const applied = replaceExactlyOnce(original, mutation);
    return applied.kind === 'invalid' ? [`${mutation.id}: ${applied.reason}`] : [];
  });
  if (invalidAnchors.length > 0) {
    throw new Error(`release authority population contains invalid anchors:\n${invalidAnchors.map((item) => `  - ${item}`).join('\n')}`);
  }

  console.log(`sandbox: ${SANDBOX}`);
  console.log('self-test: missing/duplicated anchors and zero-failure crashes are invalid');
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
