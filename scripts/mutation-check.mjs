#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Mutation harness for the usage-accounting safety property.
 *
 *  Why this exists: every commit message in this area claimed "mutation-verified", and none of those
 *  claims was re-runnable. A verification you cannot re-run is a story. (Codex, v0.9.29 review.)
 *
 *  What it does: copies the working tree to a TEMP directory, applies each MUTATION below to the COPY,
 *  runs the accounting suites there, and requires the named tests to FAIL. A mutant that survives means
 *  the tests do not actually constrain that behaviour — the code could be edited that way tomorrow and
 *  nothing would object.
 *
 *  Why a copy and not in-place: the first version mutated the tracked source and relied on exit/SIGINT
 *  handlers to restore it — a timeout, SIGKILL or crash left a live mutant sitting in the dev tree, which
 *  is the harness manufacturing exactly the class of bug it exists to catch. (Codex, v0.9.29 review,
 *  round 7.) The copy is of the WORKING TREE, not of HEAD, so it verifies what you are about to commit.
 *
 *  Run:  npm run test:mutation
 *
 *  Exit code IS the result: 0 = every mutant killed, 1 = a survivor / missing anchor / broken baseline.
 *  CI (and humans) must gate on that exit code directly — never pipe through `| tail`, which reports the
 *  pipe's exit (tail's 0) and silently turns a real mutation failure green.
 *--------------------------------------------------------------------------------------------*/

import { cpSync, readFileSync, writeFileSync, rmSync, rmdirSync, symlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';

const SRC = 'src/backend/OpenAICompatBackend.ts';
const TC = 'src/backend/TokenCounter.ts';
const ROUTES = 'src/routes/RouteContracts.ts';
const CODEX = 'src/backend/CodexBackend.ts';
const CLAUDE = 'src/backend/ClaudeHeadlessBackend.ts';
const EXTENSION = 'src/extension.ts';
const REGISTRY = 'src/routes/ConnectionRegistry.ts';
const PRICING = 'src/models/ModelPricing.ts';
const TEAM_TOOLS = 'src/backend/TeamTools.ts';
const WORKSPACE_TOOLS = 'src/backend/WorkspaceTools.ts';
const TOOL_SUMMARY = 'src/backend/toolSummary.ts';
const REFUSAL_DETAIL_GATE = 'scripts/check-refusal-detail-literals.mjs';
const SUITES = [
  'src/backend/__tests__/OpenAICompatBackend.test.ts',
  'src/backend/__tests__/TokenCounter.test.ts',
  'src/backend/__tests__/CodexBackend.test.ts',
  'src/backend/__tests__/ClaudeHeadlessBackend.test.ts',
  'src/routes/__tests__/RouteContracts.test.ts',
  'src/state/__tests__/TeamFileSchema.test.ts',
  'src/models/__tests__/ModelPricing.test.ts',
  'src/backend/__tests__/TeamTools.test.ts',
  'src/backend/__tests__/WorkspaceToolsFolderAccess.test.ts',
  'src/backend/__tests__/WorkspaceToolsSecurity.test.ts',
  'src/backend/__tests__/TaskContract.test.ts',
  'src/backend/__tests__/toolSummary.test.ts',
  'src/bus/__tests__/MessageBusPersistence.test.ts',
];

/** Each mutant is a real bug this codebase actually shipped, or nearly shipped, during v0.9.29. */
const MUTATIONS = [
  {
    name: 'verdict crosses routes (a Smart Mode model switch inherits another gateway\'s accounting)',
    file: SRC,
    from: 'const route = `${this.baseUrl}|${this.currentModel ?? this.config.model}`;',
    to: "const route = 'ANY';",
  },
  {
    name: 'inclusive can be re-declared exclusive (retroactively reinterprets everything the gateway said)',
    file: SRC,
    from: "      acc.semantics === 'unknown'\n      && reportedPrompt > 0 && acc.lastReported > 0",
    to: "      acc.semantics !== 'exclusive'\n      && reportedPrompt > 0 && acc.lastReported > 0",
  },
  {
    name: 'reconstruction drops the gateway\'s own figure (under-reports the prompt)',
    file: SRC,
    from: 'const truePrompt = Math.max(estimated, reportedPrompt);',
    to: 'const truePrompt = estimated;',
  },
  {
    name: 'declares exclusive without the append-only witness (libels an honest gateway on a legitimate trim)',
    file: SRC,
    from: '      && appendOnly                          //',
    to: '      && true                                //',
  },
  {
    name: 'append-only witness degraded back to a token-estimate comparison (Codex: ceil() is not order-preserving)',
    file: SRC,
    from: '      && shape.messages.length >= prev.messages.length\n      && prev.messages.every((h, i) => h === shape.messages[i]);',
    to: '      && true;',
  },
  {
    name: 'the money estimator stops leaning high (under-counts CJK, code, images)',
    file: TC,
    from: 'return countTokens(text, 3);',
    to: 'return countTokens(text, 4);',
  },
  {
    name: 'images priced at 256 tokens again (a high-detail image is ~1,100-1,600)',
    file: TC,
    from: 'const IMAGE_TOKENS_UPPER = 1600;',
    to: 'const IMAGE_TOKENS_UPPER = 256;',
  },
  {
    name: 'the runtime invariant guard is bypassed (a future bug reaches the bill)',
    file: SRC,
    from: '  const ok =\n    candidate.prompt >= reportedPrompt',
    to: '  const ok =\n    true || candidate.prompt >= reportedPrompt',
  },
  {
    name: 'a gateway that reports no usage books the turn at zero (the JSON-fallback path)',
    file: SRC,
    from: '      if (!data.usage) {\n        const msg = data.choices?.[0]?.message;',
    to: '      if (false && !data.usage) {\n        const msg = data.choices?.[0]?.message;',
  },
  {
    name: 'a repaired nonsense report (cached > prompt) is passed off as the gateway\'s own bill',
    file: SRC,
    from: '      if (prompt !== reportedPrompt) {\n        this.usageEstimated = true;',
    to: '      if (false && prompt !== reportedPrompt) {\n        this.usageEstimated = true;',
  },
  {
    name: 'the cache breakpoint is left in the append-only witness (its own movement reads as a rewrite)',
    file: SRC,
    from: '      messages: all.slice(0, historyCount).map((m) => JSON.stringify(billableForm(m))),',
    to: '      messages: all.slice(0, historyCount).map((m) => JSON.stringify(m)),',
  },
  {
    // The round-7 bug, verbatim: a witness that stores a digest of the bytes instead of the bytes. 32-bit
    // collisions need no adversary ('Aa'/'BB' collide under h*31), so a same-length rewrite of real user
    // content reads as "unchanged" and latches the route exclusive off an honest report.
    name: 'the witness stores a 32-bit hash of the bytes instead of the bytes (Aa/BB collide; honest rewrite latches exclusive)',
    file: SRC,
    from: '      messages: all.slice(0, historyCount).map((m) => JSON.stringify(billableForm(m))),',
    to: '      messages: all.slice(0, historyCount).map((m) => { const s = JSON.stringify(billableForm(m)); let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(16); }),',
  },
  {
    name: 'the final OpenAI-compatible route assertion is removed before fetch',
    file: SRC,
    from: '    this.assertResolvedRoute?.();',
    to: '    // route assertion removed',
  },
  {
    name: 'a forged Custom route reads another registered connection key',
    file: SRC,
    from: '    const secretName = apiKeySecretNameForRoute(route, this.connectionResolver);',
    to: '    const secretName = this.config.provider.apiKeySecretName;',
  },
  {
    name: 'the final route boundary trusts the config key name instead of the registered connection',
    file: EXTENSION,
    from: '      authIdentityRef: authIdentityRefForRoute(selected, effectiveConnectionRegistry),',
    to: '      authIdentityRef: config.provider.apiKeySecretName,',
  },
  {
    name: 'the final Codex route assertion is removed before spawn',
    file: CODEX,
    from: '      this.deps?.assertResolvedRoute?.();',
    to: '      // route assertion removed',
  },
  {
    name: 'the final Claude route assertion is removed before spawn',
    file: CLAUDE,
    from: '    this.deps.assertResolvedRoute?.();',
    to: '    // route assertion removed',
  },
  {
    name: 'canonical endpoint comparison is weakened to hostname-only (base-path crossing)',
    file: ROUTES,
    from: "['endpoint base', selected.executionDomain.canonicalEndpointBase, envelope.executionDomain.canonicalEndpointBase],",
    to: "['endpoint base', selected.executionDomain.canonicalEndpointBase.replace(/\\/[^/]*$/, ''), envelope.executionDomain.canonicalEndpointBase.replace(/\\/[^/]*$/, '')],",
  },
  {
    name: 'canonical endpoint folds path case (distinct bases become equal)',
    file: ROUTES,
    from: "return `${scheme}://${host}${effectivePort ? `:${effectivePort}` : ''}${path}`;",
    to: "return `${scheme}://${host}${effectivePort ? `:${effectivePort}` : ''}${path.toLowerCase()}`;",
  },
  {
    name: 'command capability is allowed without an approval mechanism',
    file: ROUTES,
    from: "if (capabilities.command && approval === 'none') {",
    to: "if (false && capabilities.command && approval === 'none') {",
  },
  {
    name: 'a stale custom profile revision is allowed to reuse its old endpoint and key',
    file: REGISTRY,
    from: 'if (profile.id !== expected.connectionId || profile.revision !== expected.revision) {',
    to: 'if (profile.id !== expected.connectionId || false) {',
  },
  {
    name: 'a custom gateway borrows a global list price without connection-specific provenance',
    file: PRICING,
    from: "if (scopedProvider.startsWith('custom:')) {",
    to: "if (false && scopedProvider.startsWith('custom:')) {",
  },
  {
    name: 'an empty tool-active delegation is treated as verified again',
    file: TEAM_TOOLS,
    from: 'if (returnedNothing(reply)) {',
    to: 'if (false && returnedNothing(reply)) {',
  },
  {
    name: 'F2 tool activity is over-credited as a green delivery verdict',
    file: TEAM_TOOLS,
    from: "outcome = 'tool-activity-recorded';",
    to: "outcome = 'verified';",
  },
  {
    name: 'a task-scope refusal is collapsed into a terminal workspace escape',
    file: WORKSPACE_TOOLS,
    from: "const refusalReason: HostToolRefusalReason | undefined = err instanceof WorkspaceAccessError\n        ? 'task-scope'\n        : err instanceof WorkspaceEscapeError\n          ? 'workspace-escape'\n          : undefined;",
    to: "const refusalReason: HostToolRefusalReason | undefined = err instanceof WorkspaceAccessError\n        ? 'workspace-escape'\n        : err instanceof WorkspaceEscapeError\n          ? 'workspace-escape'\n          : undefined;",
  },
  {
    name: 'a task-scope refusal again terminates the model turn',
    file: SRC,
    from: "boundaryRefused = execution.status === 'refused' && execution.reason === 'workspace-escape';",
    to: "boundaryRefused = execution.status === 'refused' && (execution.reason === 'workspace-escape' || execution.reason === 'task-scope');",
  },
  {
    name: 'a real workspace escape is made recoverable as task scope',
    file: WORKSPACE_TOOLS,
    from: "        : err instanceof WorkspaceEscapeError\n          ? 'workspace-escape'\n          : undefined;",
    to: "        : err instanceof WorkspaceEscapeError\n          ? 'task-scope'\n          : undefined;",
  },
  {
    name: 'task-scope prose falls through to a false consent denial',
    file: WORKSPACE_TOOLS,
    from: "    case 'task-scope':\n      action = 'Use the inputs granted in the task card, call report_context_gap for a specific required input, or ask the coordinator to widen the scope.';\n      break;",
    to: "    case 'task-scope':\n      action = 'User consent was not granted. Revise the action or ask the user for consent.';\n      break;",
  },
  {
    name: 'directory listings are rendered as reads again',
    file: TOOL_SUMMARY,
    from: "  if (name === 'list_dir' || name === 'list_agents') {\n    return 'list';\n  }",
    to: "  if (name === 'list_dir' || name === 'list_agents') {\n    return 'read';\n  }",
  },
  {
    name: 'configured-but-not-granted writes are made terminal again',
    file: WORKSPACE_TOOLS,
    from: "      if (this.isInsideConfiguredWriteRoots(recovered ?? abs)) {\n        throw this.taskScopeRefusal();\n      }\n",
    to: '',
  },
  {
    name: 'configured-but-not-granted symlink targets are made terminal again',
    file: WORKSPACE_TOOLS,
    from: "      if (this.isInsideConfiguredReadRoots(realPath)) {\n        throw this.taskScopeRefusal();\n      }\n",
    to: '',
  },
  {
    name: 'an unavailable image asset is again allowed to terminate the turn',
    file: SRC,
    from: "} else if (name === 'send_image_asset_to_model') {\n      outcome = await this.routeImageAssetToModel(args.assetId);\n    } else if (this.mcp?.hub.hasTool(name)) {",
    to: "} else if (name === 'send_image_asset_to_model') {\n      outcome = await this.routeImageAssetToModel(args.assetId);\n      boundaryRefused = outcome.source === 'host' && outcome.status === 'refused';\n    } else if (this.mcp?.hub.hasTool(name)) {",
  },
  {
    name: 'a coordinator brief bypasses destination-specific consent',
    file: TEAM_TOOLS,
    from: '    if (contract.coordinatorBrief) {\n      const approval = await approveCoordinatorBriefEgress!(this.selfId, target.id);',
    to: '    if (false && contract.coordinatorBrief) {\n      const approval = await approveCoordinatorBriefEgress!(this.selfId, target.id);',
  },
  {
    name: 'an ungranted coordinator brief basis is dispatched anyway',
    file: 'src/backend/TaskContract.ts',
    from: "    const missingBriefGrant = contract.coordinatorBrief?.basisRefs.find((inputId) =>\n      !grants.some((grant) => grant.inputId === inputId),\n    );",
    to: '    const missingBriefGrant = undefined;',
  },
  {
    name: 'an optional input silently restores the no-web substitution rule',
    file: 'src/backend/TaskContract.ts',
    from: 'contract.inputs.some((input) => input.required)',
    to: 'contract.inputs.length > 0',
  },
  {
    name: 'a coordinator brief leaks into persisted activity or conversation history',
    file: 'src/bus/MessageBus.ts',
    from: '  const { coordinatorBrief: _brief, ...contract } = attempt.contract as Record<string, unknown>;\n  return { ...attempt, contract };',
    to: '  return taskAttempt;',
  },
  {
    name: 'an unresolved manual route inherits equality from a provider label instead of its exact endpoint',
    file: ROUTES,
    from: "  return route.privacyDomain.status === 'unresolved-user-selected'\n    ? `execution:${route.executionDomain.canonicalEndpointBase}`\n    : `privacy:${route.privacyDomain.id}`;",
    to: '  return `privacy:${route.privacyDomain.id}`;',
  },
  {
    name: 'the live-task artifact detail is dropped after the generic refusal is rendered',
    file: WORKSPACE_TOOLS,
    from: "        output: `${workspaceRefusalMessage(name, outcome.reason)}${outcome.detail ? `\\n\\n${outcome.detail}` : ''}`,",
    to: '        output: workspaceRefusalMessage(name, outcome.reason),',
  },
  {
    name: 'a refusal detail interpolates host state instead of remaining literal-only',
    file: WORKSPACE_TOOLS,
    from: "hostToolRefusalDetail('This tool is available only while executing a live contracted task attempt.')",
    to: 'hostToolRefusalDetail(`This tool is available only while executing ${this.pathBase}.`)',
  },
  {
    name: 'the unknown-input refusal discloses that an unauthorised source exists',
    file: WORKSPACE_TOOLS,
    from: "return refused('Error: that required task input is not available to this agent. No source-existence detail was disclosed.', 'task-scope');",
    to: "return refused('Error: that required task input is not available to this agent. No source-existence detail was disclosed.', 'task-scope', hostToolRefusalDetail('The requested input exists but is not granted.'));",
  },
  {
    name: 'a stale unadvertised task tool is misclassified as another harness tool',
    file: SRC,
    from: '    } else if (this.tools.canRoute(name)) {',
    to: '    } else if (this.tools.specs().some((s) => s.function.name === name)) {',
  },
  {
    name: 'the frozen Claude bridge loses its no-live-attempt artifact handler guard',
    file: WORKSPACE_TOOLS,
    from: '    if (!attemptId || !this.taskInputResolver) {',
    to: '    if (!this.taskInputResolver) {',
  },
  {
    name: 'Claude stops advertising the task artifact in its one-time bridge schema',
    file: CLAUDE,
    from: "        name: 'publish_task_artifact',",
    to: "        name: 'publish_task_artifact_when_active',",
  },
];

// ─── The sandbox copy ────────────────────────────────────────────────────────────────────────────────
// Everything below mutates ONLY this copy. If the process is killed at any point, the dev tree has not
// been touched; the worst possible leak is a dead directory in the OS temp area.
const ROOT = resolve('.');
// Prefer the CI runner's temp dir when present. On a GitHub Windows runner the checkout lives on D: while
// os.tmpdir() is on C:, so a sandbox in tmpdir() makes the node_modules junction cross volumes — which
// resolves differently there and kills the baseline. RUNNER_TEMP sits on the same drive as the workspace;
// locally it is unset and this is exactly the previous behaviour.
const SANDBOX_ROOT = process.env.RUNNER_TEMP && process.env.RUNNER_TEMP.trim()
  ? process.env.RUNNER_TEMP.trim()
  : tmpdir();
const SANDBOX = join(SANDBOX_ROOT, `unodeai-mutation-${process.pid}`);
// Never copied: heavy build state, and — non-negotiably — local secrets like .ovsx-pat, which must not
// be sprayed into a world-readable temp directory.
const EXCLUDE_NAMES = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.vscode-test', '.ovsx-pat']);
const excluded = (p) => EXCLUDE_NAMES.has(basename(p)) || p.endsWith('.vsix');

// A git worktree has no installed node_modules of its own — Node resolves dependencies from the main
// checkout by walking up. Find that real directory so the harness runs from a worktree (fix/v0931-*), not
// only the primary checkout. A worktree often carries a STUB node_modules (just a Vite `.vite` cache from a
// prior test run); require a sentinel dependency so we junction the populated tree, not the stub — Node's own
// resolver walks past empty dirs per-module, but a single junction cannot, so it must point at the real one.
function resolveNodeModules(start) {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(join(candidate, 'vitest'))) { return candidate; }
    const parent = dirname(dir);
    if (parent === dir) { throw new Error(`could not find a populated node_modules (with vitest) above ${start}`); }
    dir = parent;
  }
}

console.log(`sandbox: ${SANDBOX}`);
cpSync(ROOT, SANDBOX, { recursive: true, filter: (src) => !excluded(src) });
// The suites need dependencies; a junction shares the real node_modules without copying half a gigabyte.
// Removing the sandbox unlinks the junction, never its target.
symlinkSync(resolveNodeModules(ROOT), join(SANDBOX, 'node_modules'), 'junction');

const inSandbox = (f) => join(SANDBOX, f);
const read = (f) => readFileSync(inSandbox(f), 'utf8');
const TASK_CONTRACT = 'src/backend/TaskContract.ts';
const MESSAGE_BUS = 'src/bus/MessageBus.ts';
const originals = new Map([SRC, TC, ROUTES, CODEX, CLAUDE, EXTENSION, REGISTRY, PRICING, TEAM_TOOLS, WORKSPACE_TOOLS, TOOL_SUMMARY, TASK_CONTRACT, MESSAGE_BUS, REFUSAL_DETAIL_GATE].map((f) => [f, read(f)]));
const restore = () => originals.forEach((text, f) => writeFileSync(inSandbox(f), text, 'utf8'));

/** Anchors are written with `\n`; a Windows checkout has `\r\n`. Match the file's own line ending, or every
 *  multi-line anchor silently misses — and a mutation that cannot be applied is an unmonitored behaviour. */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const toEol = (snippet, text) => snippet.split('\n').join(eolOf(text));

/** Whatever the last sandbox run printed. A swallowed failure here is a debugging dead end — especially in
 *  CI, where "the suites do not pass" with no output tells you nothing about WHY. */
let lastSuiteFailure;

/** True when the suites pass IN THE SANDBOX. A mutant that leaves them passing has SURVIVED — the failure. */
function suitesPass() {
  try {
    // The sandbox reaches its dependencies through a node_modules JUNCTION. On Node ≥25 a junction has a
    // distinct realpath from its target, so without --preserve-symlinks Vite/Vitest resolves TWO copies of
    // its own runtime and every suite dies at `describe()` collection — the baseline then fails and the whole
    // gate reports a false "suites do not pass on unmutated source". Merge the flags into any existing
    // NODE_OPTIONS (never clobber a caller's) so the junction path is used consistently.
    const preserve = '--preserve-symlinks --preserve-symlinks-main';
    const NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preserve}`.trim();
    // Track E2: on Windows, a parallel Vitest worker can survive the suite after reporting no assertion
    // failure. Mutation gating needs a determinate exit code, so keep the sandbox serial rather than
    // treating a runner fork leak as either a killed or surviving mutant.
    execSync(`npx vitest run --maxWorkers=1 --no-file-parallelism ${SUITES.join(' ')}`, {
      stdio: 'pipe', cwd: SANDBOX, env: { ...process.env, NODE_OPTIONS },
    });
    execSync('node scripts/check-refusal-detail-literals.mjs', {
      stdio: 'pipe', cwd: SANDBOX, env: { ...process.env, NODE_OPTIONS },
    });
    lastSuiteFailure = undefined;
    return true;
  } catch (err) {
    lastSuiteFailure = err;
    return false;
  }
}

/** Print what the sandbox run actually said. Only used when the BASELINE fails: a surviving mutant is
 *  self-explanatory, but a broken baseline is always an environment problem you cannot fix blind. */
function reportBaselineFailure() {
  const chunks = [lastSuiteFailure?.stdout, lastSuiteFailure?.stderr]
    .map((chunk) => (chunk ? chunk.toString() : ''))
    .filter((text) => text.trim());
  if (chunks.length === 0) {
    console.error('    (the sandbox run produced no output — check that npx/vitest resolve inside the sandbox)');
    return;
  }
  console.error('\n--- vitest output from the unmutated sandbox run ---');
  console.error(chunks.join('\n').slice(-6000));
  console.error('--- end vitest output ---');
}

function cleanup() {
  try { rmdirSync(join(SANDBOX, 'node_modules')); } catch { /* junction may already be gone */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* a dead temp dir is not worth failing over */ }
}

try {
  if (suitesPass() !== true) {
    console.error('✖ the suites do not pass on unmutated source — fix that first');
    reportBaselineFailure();
    process.exit(1);
  }
  console.log(`✓ baseline green (in sandbox)\n`);

  const survivors = [];
  for (const m of MUTATIONS) {
    const text = read(m.file);
    const from = toEol(m.from, text);
    const to = toEol(m.to, text);
    if (!text.includes(from)) {
      console.error(`✖ ANCHOR MISSING for "${m.name}"\n    in ${m.file}, looking for:\n    ${JSON.stringify(m.from)}`);
      console.error('    The code moved and this mutation no longer applies. Update it — a mutation that cannot be');
      console.error('    applied is not a passing mutation, it is an unmonitored behaviour.');
      survivors.push(m.name);
      continue;
    }
    writeFileSync(inSandbox(m.file), text.replace(from, to), 'utf8');
    const survived = suitesPass();
    restore();
    console.log(`${survived ? '✖ SURVIVED' : '✓ killed  '}  ${m.name}`);
    if (survived) { survivors.push(m.name); }
  }

  if (survivors.length > 0) {
    console.error(`\n✖ ${survivors.length} mutant(s) survived. The tests do not constrain this behaviour:`);
    survivors.forEach((s) => console.error(`    - ${s}`));
    process.exit(1);
  }
  console.log(`\n✓ every mutant killed (${MUTATIONS.length}/${MUTATIONS.length})`);
} finally {
  cleanup();
}
