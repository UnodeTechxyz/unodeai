import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { RunLedger } from '../../observability/RunLedger';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';
import { TeamPolicyStore } from '../../policy/TeamPolicy';
import { createTeam, TEAM_PRESETS } from '../../roles/RoleConfig';
import { connectionProfileForAgent } from '../../routes/CapabilityGuard';
import { BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';
import { createEffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import { runtimeSystemPrompt, SessionManager } from '../../session/SessionManager';
import type { AgentConfig } from '../../types';
import { evaluateWiring, extensionWiring } from '../../views/__tests__/support/extensionWiring';
import { CommandPolicy } from '../CommandPolicy';
import { createDirectExecutionProvider } from '../DirectCommandExecution';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { TaskInputResolver } from '../TaskContract';
import { TeamTools, type DelegationEvidenceRecord, type TeamRosterEntry, type TeamView } from '../TeamTools';

// These flow tests run real persistence, sessions, backends and commands, taking about 0.5-3 s each here and
// several times that on CI. The warm mutation worker keeps Vitest's 5 s default, so the suite's own 30 s budget
// (vitest.config.ts) is set here; CI 42814839194 judged two proofs invalid when a rerun ran past 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/*
 * v0.9.102 R4 (design 6, 6.1; T102-6, T102-7): a Reviewer works with its own tools, and what its review covers is
 * bound to the content it was dispatched for.
 *
 * The production path, end to end:
 * - the Reviewer is the shipped template as a preset team creates it (`createTeam`);
 * - it runs as a session of the real SessionManager, which assembles its runtime prompt, admits its task and hands
 *   its reply back; the admission, its execution identity and the attempt's end are the extension's own wiring,
 *   transpiled from src/extension.ts (the `SessionManager` dependencies and the `admitArtifactReviewAttempt`
 *   function it calls) and run over the real attempt registry and team policy store;
 * - its backend is the real OpenAI-compatible backend, with a scripted model, and the real direct command executor:
 *   every command below runs as a real process in the test's own folder (cmd.exe on Windows, /bin/sh elsewhere);
 * - the PM is real TeamTools; its own model is scripted, so its tool calls are made here.
 * What stands in: the model's replies, the person's approval of each command, and the roster's capabilities, which
 * the extension derives from the same tools these agents hold.
 */

const FILE_A = "export const total = (a, b) => a + b;\nexport const unused = 1;\n";
/** The Reviewer's own fix of the implementation it reviewed. */
const FILE_A_FIXED = "export const total = (a, b) => a + b;\n";
const REPORT = '# Review of a.ts\n\nFAIL: `unused` is exported and never read.\n';
/** A reproduction the Reviewer writes: a real node:test file that fails while a.ts still exports `unused`. */
const REPRO = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { readFileSync } from 'node:fs';",
  "test('a.ts exports nothing unused', () => {",
  "  assert.ok(!readFileSync(new URL('../a.ts', import.meta.url), 'utf8').includes('unused'));",
  '});',
  '',
].join('\n');
const CHECK = 'node --test tests/a.repro.test.mjs';
const CONTENT_CHANGED = 'The file under review (input "target") no longer has the content it had when this review was dispatched.';

const extensionSource = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);

/** A top-level function of src/extension.ts, transpiled from the source and run over the names `scope` supplies. */
function extensionFunction<T>(name: string, scope: Record<string, unknown>): T {
  const node = extensionSource.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`extension.ts has no function ${name}`);
  const body = ts.transpileModule(`${node.getText(extensionSource)}\nreturn ${name};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return evaluateWiring<T>(body, scope);
}

/** The extension's own value of a SessionManager dependency, run over the names `scope` supplies. */
function sessionDependency<T>(property: string, scope: Record<string, unknown>): T {
  return evaluateWiring<T>(extensionWiring('SessionManager', 2, property), scope);
}

class MemoryState {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): void { this.values.set(key, value); }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function call(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}
const say = (text: string) => ({ choices: [{ message: { role: 'assistant', content: text } }] });
/** A message's text, whether it is one string or a list of parts. */
const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
const slashes = (file: string) => file.replace(/\\/g, '/');

/** The Reviewer of a preset team, created by the same factory a new team uses. */
function presetReviewer(preset: string): AgentConfig {
  const reviewer = createTeam(TEAM_PRESETS[preset].roles as Parameters<typeof createTeam>[0]).find((config) => config.role === 'reviewer');
  if (!reviewer) throw new Error(`${preset} has no reviewer`);
  return reviewer;
}

/** The capabilities the extension reports for a roster entry, from the agent's own tools. */
function capabilitiesOf(config: AgentConfig): TeamRosterEntry['capabilities'] {
  const tools = config.allowedTools ?? [];
  return {
    read: tools.includes('read'),
    write: tools.includes('write'),
    shell: tools.includes('execute'),
    toolFamilies: tools.filter((tool) => ['read', 'search', 'write', 'execute', 'delegate'].includes(tool)),
    taskScope: 'per-turn',
  };
}

/** A marked review of the workspace file a.ts: the host binds the file as it is at dispatch. */
const reviewContract = () => ({
  version: 1,
  objective: 'Review a.ts: report findings with evidence, and show any defect with a reproduction.',
  expected_deliverable: 'A PASS or FAIL review with its findings.',
  effects: { read_files: [], expected_file_effect: 'none' },
  inputs: [{
    input_id: 'target', kind: 'workspacePath', path: 'a.ts', purpose: 'The file under review',
    required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
  }],
  constraints: [],
  dependencies: [],
  review: { input_id: 'target' as string },
  required_capabilities: { version: 1, capabilities: ['read', 'write', 'shell'] },
  execution_strategy: 'delegate-required',
});

/**
 * A team of a PM and the Reviewer (and, when `secondReviewer`, another one), each Reviewer a SessionManager session on
 * a real backend. `scripts[agent]` holds the model's replies for that agent's next turn; a reply given as a function
 * is called when its request arrives, which is what happens in the world while the model is thinking.
 */
async function team(options: { secondReviewer?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'unode-r4-review-'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'a.ts'), FILE_A, 'utf8');
  const store = new ContentAssetStore();
  const taskInputResolver = new TaskInputResolver(store, root);
  const teamPolicyStore = new TeamPolicyStore(new MemoryState());
  const runLedger = new RunLedger();
  const bus = new MessageBus();

  const admitArtifactReviewAttempt = extensionFunction('admitArtifactReviewAttempt', { taskInputResolver, evaluateReviewPolicy, teamPolicyStore });
  const scripts: Record<string, unknown[]> = {};
  const requests: Record<string, any[]> = {};
  const fetchFor = (agent: string): FetchFn => async (_url, init) => {
    (requests[agent] ??= []).push(JSON.parse(init.body));
    const next = scripts[agent].shift();
    const body = typeof next === 'function' ? await (next as () => Promise<unknown>)() : next;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const manager = new SessionManager(4, bus, {
    createBackend: (config) => new OpenAICompatBackend(
      config, fetchFor(config.id), undefined, undefined,
      new CommandPolicy('ask', []), { retryBaseMs: 0 }, undefined, undefined,
      // The person approves each command the Reviewer asks to run.
      async () => ({ allow: true }),
      undefined, undefined,
      createDirectExecutionProvider(),
      undefined, undefined, undefined, undefined,
      { taskInputResolver },
    ),
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
    resolveEffectiveExecutionIdentity: sessionDependency('resolveEffectiveExecutionIdentity', {
      connectionProfileForAgent, effectiveConnectionRegistry: BUILTIN_CONNECTION_REGISTRY, createEffectiveExecutionIdentity,
    }),
    admitTaskExecution: sessionDependency('admitTaskExecution', { admitArtifactReviewAttempt }),
    endTaskAttempt: sessionDependency('endTaskAttempt', { taskInputResolver }),
    onTaskAttemptTerminal: sessionDependency('onTaskAttemptTerminal', { taskInputResolver, runLedger }),
  });
  cleanups.push(async () => {
    await manager.stopAll();
    bus.dispose();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const reviewers: AgentConfig[] = [
    { ...presetReviewer('security-review-crew'), id: 'reviewer', workingDirectory: root },
    ...(options.secondReviewer ? [{ ...presetReviewer('bugfix-crew'), id: 'reviewer-2', name: 'Second Reviewer', workingDirectory: root }] : []),
  ];
  for (const config of reviewers) {
    manager.create(config);
    await manager.start(config.id, { pin: 'take' });
  }
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running', capabilities: { read: true, write: false, shell: false, toolFamilies: ['read', 'delegate'], taskScope: 'per-turn' } },
    ...reviewers.map((config) => ({ id: config.id, role: config.role, name: config.name, status: 'idle', workspaceRoot: root, capabilities: capabilitiesOf(config) })),
  ];
  const view: TeamView = { list: () => roster, resolve: (ref) => roster.find((entry) => entry.id === ref) ? { id: ref } : undefined, preflightTaskScope: () => undefined };
  const records: DelegationEvidenceRecord[] = [];
  const pm = new TeamTools('pm', view, bus, {
    timeoutMs: 30_000,
    cwd: root,
    evidenceEnabled: true,
    waitForTaskAdmission: true,
    taskInputResolver,
    onDelegationDispatched: (event) => runLedger.recordDelegationDispatched(event),
    onDelegationEvidence: (event) => { records.push(event.evidence); runLedger.recordDelegationEvidence(event); },
  });

  /** The PM's dispatch_task: a marked review of a.ts, or (`marked: false`) the same task with no review relation. */
  const dispatch = async (agent: string, script: unknown[], marked = true) => {
    scripts[agent] = [...script];
    const turnEnded = new Promise<void>((resolve) => {
      const listener = (event: { sessionId: string }) => {
        if (event.sessionId !== agent) return;
        manager.off('session.turnEnded', listener);
        resolve();
      };
      manager.on('session.turnEnded', listener);
    });
    const { review, ...unmarked } = reviewContract();
    const reply = await pm.run('dispatch_task', { agent, instruction: 'Review a.ts.', contract: marked ? { ...unmarked, review } : unmarked });
    expect(reply).toMatch(/Dispatched contract/);
    const handle = /Handle: ([^\s.]+)/.exec(reply)?.[1] ?? '';
    // The Reviewer's turn ends on its own end event; its reply has then reached the PM through SessionManager.
    await turnEnded;
    const result = await vi.waitFor(async () => {
      const collected = await pm.run('collect_ready_tasks', { handles: [handle] });
      expect(collected).toContain('[delegation:');
      return collected;
    }, { timeout: 5_000, interval: 10 });
    expect(scripts[agent]).toEqual([]);
    return { handle, result };
  };
  return { root, pm, records, requests, runLedger, dispatch };
}

describe('v0.9.102 R4: a Reviewer works with its own tools (T102-6)', () => {
  it('the Reviewer a review or security preset creates can write files and run commands, and is told how to keep its work apart from the work it reviews', () => {
    for (const preset of ['bugfix-crew', 'security-review-crew', 'software-engineering', 'release-crew']) {
      const reviewer = presetReviewer(preset);
      expect(reviewer.allowedTools, preset).toEqual(expect.arrayContaining(['read', 'search', 'write', 'execute']));
      expect(reviewer.allowedTools, preset).not.toContain('delegate');
    }
    const prompt = runtimeSystemPrompt(presetReviewer('security-review-crew'), 'pm');
    // Its own checks, its own reproduction and report, its change kept apart and bound to a version.
    for (const line of [
      "Where you can run commands, run the project's own checks (tests, lint, type checks, build) when the verdict\n  depends on them, and say what you ran and what it returned.",
      'You may reproduce a problem and add a test or fixture that shows it. Where you can write files, put your review\n  in a report file',
      'If you change it, your verdict no longer covers\n  what you changed: deliver the change with its checks and your review of the earlier version, and say plainly\n  that the changed version is not yet independently reviewed.',
      'Bind the verdict to what you reviewed: the commit, the files or the version.',
      'As a reviewer: first confirm what actually triggers a problem and what it does to the user.',
      "The project's independent-review rules still apply.",
    ]) expect(prompt).toContain(line);
    // A Reviewer with Run commands and Write files is never told it lacks them.
    expect(prompt).not.toContain('You cannot run commands in this session');
    expect(prompt).not.toContain('does not have Write files');
  });

  it('writes its reproduction and report and runs the check itself; the PM receives them as the Reviewer\'s own work and is not told to run the checks again', async () => {
    const h = await team();
    const { result } = await h.dispatch('reviewer', [
      call('read_file', { path: 'a.ts', line_numbers: true }),
      call('write_file', { path: 'tests/a.repro.test.mjs', content: REPRO }),
      call('run_command', { command: CHECK }),
      call('write_file', { path: 'review/REVIEW.md', content: REPORT }),
      call('close_assignment', { review_evidence: {
        schemaVersion: 1, coverage: 'partial', searches: [],
        findings: [{ classification: 'observed', statement: 'unused is exported and never read.', citations: [{ readReceiptId: 'R1', path: 'a.ts', startLine: 2, endLine: 2 }] }],
      } }),
      say('FAIL: `unused` is exported and never read. Reproduction in tests/a.repro.test.mjs fails; report in review/REVIEW.md.'),
    ]);

    // SessionManager handed the Reviewer's provider its assembled runtime prompt.
    expect(JSON.stringify(h.requests.reviewer[0].messages[0])).toContain('As a reviewer: first confirm what actually triggers a problem');
    // Its files are on disk, and its check really ran: node:test found the defect and exited 1.
    expect(await readFile(join(h.root, 'tests', 'a.repro.test.mjs'), 'utf8')).toBe(REPRO);
    expect(await readFile(join(h.root, 'review', 'REVIEW.md'), 'utf8')).toBe(REPORT);
    expect(await readFile(join(h.root, 'a.ts'), 'utf8')).toBe(FILE_A);
    const checkResult = textOf(h.requests.reviewer[3].messages.at(-1).content);
    expect(checkResult).toMatch(/fail 1/);
    // Its close was accepted against the receipt of its own numbered read.
    expect(textOf(h.requests.reviewer[5].messages.at(-1).content)).toContain('Review closed. Recorded: review evidence: citations checked by the host.');

    // The PM receives the files, the check's outcome and the review evidence together, as the Reviewer's own work.
    const record = h.records.at(-1)!;
    expect(record.changedFiles.map(slashes).sort()).toEqual(['review/REVIEW.md', 'tests/a.repro.test.mjs']);
    expect(record.verification).toMatchObject({ ran: true, passed: false, command: CHECK, source: 'command-exit-zero' });
    expect(record.unrecordedWrites).toBe(false);
    expect(record.reviewTargetChange).toBeUndefined();
    expect(result).toMatch(/changed files \(recorded\): (review[\\/]REVIEW\.md, tests[\\/]a\.repro\.test\.mjs|tests[\\/]a\.repro\.test\.mjs, review[\\/]REVIEW\.md)/);
    expect(result).toContain(`the last recorded run was a command (${CHECK}), not run_checks; it did not exit 0 (framework recorded).`);
    expect(result).toContain('review evidence: citations checked by the host. 1 finding: 1 observed (1 cited)');
    expect(result).toContain("This is a review: the files it changed and the commands it ran are the reviewer's own work. "
      + 'Decide on its findings without running its checks again for it; only a change it made to the work it reviewed needs another reviewer.');
    // Mutation: the PM was told to run the Reviewer's checks itself, or to send the review back to review.
    expect(result).not.toContain('Run_checks yourself');
    expect(result).not.toContain('review target changed');
    // The run ledger holds what the PM was shown.
    expect(h.runLedger.snapshot()[0].delegations[0].evidence?.reviewEvidence).toMatchObject({ state: 'citations-checked' });
  }, 60_000);

  it('tells the PM, for a review dispatched with no review relation, that what the Reviewer wrote and ran is its own work', async () => {
    const h = await team();
    // No review relation is declared, so the host cannot know this result is a review; the PM is told what to do if it is.
    const { result } = await h.dispatch('reviewer', [
      call('read_file', { path: 'a.ts' }),
      call('write_file', { path: 'tests/a.repro.test.mjs', content: REPRO }),
      call('run_command', { command: CHECK }),
      call('write_file', { path: 'review/REVIEW.md', content: REPORT }),
      say('FAIL: `unused` is exported and never read. Report in review/REVIEW.md.'),
    ], false);

    expect(await readFile(join(h.root, 'review', 'REVIEW.md'), 'utf8')).toBe(REPORT);
    const record = h.records.at(-1)!;
    expect(record.reviewEvidence).toBeUndefined();
    expect(record.verification).toMatchObject({ ran: true, passed: false, command: CHECK, source: 'command-exit-zero' });
    expect(result).toContain(`the last recorded run was a command (${CHECK}), not run_checks; it did not exit 0 (framework recorded).`);
    expect(result).toContain('Do not mark this step done. Run_checks yourself or send it to the reviewer. If it is a review, the report, '
      + "reproduction or test it wrote is the reviewer's own work. Decide on its findings without running its checks again for it; "
      + 'only a change it made to the work it reviewed needs another reviewer.');
  }, 60_000);
});

describe('v0.9.102 R4: a review covers the file as it was dispatched (T102-6, T102-7)', () => {
  /** The Reviewer reproduces the defect, fixes it itself, checks the fix, writes its report and closes its review. */
  const reviewerFixesIt = () => [
    call('read_file', { path: 'a.ts', line_numbers: true }),
    call('write_file', { path: 'tests/a.repro.test.mjs', content: REPRO }),
    call('run_command', { command: CHECK }),
    call('write_file', { path: 'a.ts', content: FILE_A_FIXED }, 'call-write_file-fix'),
    call('run_command', { command: CHECK }, 'call-run_command-again'),
    call('write_file', { path: 'review/REVIEW.md', content: REPORT }, 'call-write_file-report'),
    call('close_assignment', {}),
    say('FAIL on the dispatched version: `unused` was exported and never read. I removed it in a.ts; the reproduction now passes. '
      + 'The changed version is not yet independently reviewed.'),
  ];

  it('delivers a Reviewer\'s own fix, says the changed version is not independently reviewed, and the PM accepts it and closes with no other reviewer', async () => {
    const h = await team();
    const { handle, result } = await h.dispatch('reviewer', reviewerFixesIt());

    // The work is delivered: the fix, the reproduction and the report are on disk, and the result reached the PM.
    expect(await readFile(join(h.root, 'a.ts'), 'utf8')).toBe(FILE_A_FIXED);
    expect(await readFile(join(h.root, 'review', 'REVIEW.md'), 'utf8')).toBe(REPORT);
    expect(result).toContain('The changed version is not yet independently reviewed.');
    // The real check failed on the dispatched file and passed on the fix.
    expect(textOf(h.requests.reviewer[3].messages.at(-1).content)).toMatch(/fail 1/);
    expect(textOf(h.requests.reviewer[5].messages.at(-1).content)).toMatch(/pass 1/);
    // Its close was refused: nothing it recorded can be taken for the changed file.
    expect(textOf(h.requests.reviewer[7].messages.at(-1).content)).toContain(`review target changed; dispatch a new review. ${CONTENT_CHANGED}`);
    expect(result).toContain('review evidence: not submitted.');

    const record = h.records.at(-1)!;
    expect(record.changedFiles.map(slashes).sort()).toEqual(['a.ts', 'review/REVIEW.md', 'tests/a.repro.test.mjs']);
    expect(record.verification).toMatchObject({ ran: true, passed: true, command: CHECK, source: 'command-exit-zero' });
    expect(record.reviewTargetChange).toEqual({ inputId: 'target', detail: CONTENT_CHANGED, changedByTeammate: true });
    expect(result).toContain(`the last recorded run was a command (${CHECK}), not run_checks; it exited 0 (framework recorded).`);
    expect(result).toContain(`review target changed: ${CONTENT_CHANGED} This review covers that file only as it was dispatched, `
      + 'so the version there now is not independently reviewed. The file changes recorded for this teammate include that file: '
      + 'its own review does not cover its change. Check only that file again: dispatch a review of it as it is now to a teammate '
      + 'who did not change it, or deliver this result and say that the changed version is not independently reviewed.');
    // Nothing is held: the outcome is what the evidence alone gives, and the PM decides and closes the work.
    expect(record.outcome).toBe('replied-not-verified');
    expect(await h.pm.run('record_task_disposition', {
      handle, disposition: 'accepted-with-caveat', reason: 'No other reviewer: delivered with a.ts not independently reviewed.',
    })).toMatch(/^Recorded/);
    expect(await h.pm.run('close_assignment', {
      outcome: 'complete', summary: 'Review delivered; the Reviewer\'s fix of a.ts is not independently reviewed.',
    })).toBe('Recorded: assignment closed as complete.');
  }, 60_000);

  it('lets the PM send only the changed file to another Reviewer, whose review is bound to the content there now', async () => {
    const h = await team({ secondReviewer: true });
    const first = await h.dispatch('reviewer', reviewerFixesIt());
    expect(first.result).toContain('review target changed:');
    expect(await h.pm.run('record_task_disposition', {
      handle: first.handle, disposition: 'deferred', reason: 'The fixed a.ts goes to the second reviewer.',
    })).toMatch(/^Recorded/);

    const second = await h.dispatch('reviewer-2', [
      call('read_file', { path: 'a.ts', line_numbers: true }),
      call('run_command', { command: CHECK }),
      call('close_assignment', { review_evidence: {
        schemaVersion: 1, coverage: 'complete', searches: [],
        findings: [{ classification: 'observed', statement: 'total adds its two arguments.', citations: [{ readReceiptId: 'R1', path: 'a.ts', startLine: 1, endLine: 1 }] }],
      } }),
      say('PASS: a.ts as it is now; the reproduction passes.'),
    ]);

    // Closed against the fixed file the second review was dispatched for, with no target change to report.
    expect(textOf(h.requests['reviewer-2'][3].messages.at(-1).content)).toContain('Review closed. Recorded: review evidence: citations checked by the host.');
    const record = h.records.at(-1)!;
    expect(record.reviewTargetChange).toBeUndefined();
    expect(record.verification).toMatchObject({ ran: true, passed: true, command: CHECK });
    expect(second.result).toContain('review evidence: citations checked by the host.');
    expect(second.result).not.toContain('review target changed');
  }, 60_000);

  it('says that a review closed before someone else changed its file does not cover the content there now (concurrent change)', async () => {
    const h = await team();
    const { result } = await h.dispatch('reviewer', [
      call('read_file', { path: 'a.ts', line_numbers: true }),
      call('close_assignment', { review_evidence: {
        schemaVersion: 1, coverage: 'partial', searches: [],
        findings: [{ classification: 'observed', statement: 'unused is exported and never read.', citations: [{ readReceiptId: 'R1', path: 'a.ts', startLine: 2, endLine: 2 }] }],
      } }),
      // An editor, a formatter or another teammate changes the file after the close and before the reply.
      async () => {
        await writeFile(join(h.root, 'a.ts'), FILE_A_FIXED, 'utf8');
        return say('FAIL: `unused` is exported and never read.');
      },
    ]);

    const record = h.records.at(-1)!;
    // What the close recorded stays: it covers the dispatched content.
    expect(result).toContain('review evidence: citations checked by the host.');
    expect(record.reviewTargetChange).toEqual({ inputId: 'target', detail: CONTENT_CHANGED, changedByTeammate: false });
    expect(result).toContain(`review target changed: ${CONTENT_CHANGED} This review covers that file only as it was dispatched, `
      + 'so the version there now is not independently reviewed. No file change recorded for this teammate is that file: '
      + 'another teammate, a command or an edit outside UnodeAi changed it. Check only that file again:');
  }, 60_000);

  it('reports a file the Reviewer changed with a command as unrecorded by the host, never as no change (shell change)', async () => {
    const h = await team();
    // A real command whose shell redirect rewrites the file under review. No file tool of the host sees it.
    const rewrite = 'node -e "console.log(1)" > a.ts';
    const { result } = await h.dispatch('reviewer', [
      call('read_file', { path: 'a.ts', line_numbers: true }),
      call('run_command', { command: rewrite }),
      say('Rewrote a.ts.'),
    ]);

    const after = await readFile(join(h.root, 'a.ts'));
    expect(after.equals(Buffer.from(FILE_A, 'utf8'))).toBe(false);
    expect(after.length).toBeGreaterThan(0);
    const record = h.records.at(-1)!;
    expect(record.verification).toMatchObject({ ran: true, passed: true, command: rewrite, source: 'command-exit-zero' });
    expect(record.changedFiles).toEqual([]);
    expect(record.unrecordedWrites).toBe(true);
    expect(result).toContain('changed files (recorded): (none recorded)');
    expect(result).toContain('evidence gap: a potentially mutating native tool ran without a CheckpointRecorder file record.');
    expect(record.reviewTargetChange).toEqual({ inputId: 'target', detail: CONTENT_CHANGED, changedByTeammate: false });
    expect(result).toContain('No file change recorded for this teammate is that file: another teammate, a command or an edit outside UnodeAi changed it.');
    // An unrecorded change is not shown as tool activity with nothing changed.
    expect(record.outcome).toBe('replied-not-verified');
  }, 60_000);
});
