import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/**
 * v0.9.106 (review loop, design R0 §9): an implementation, an independent review with findings, the PM's decision on
 * each finding, the fix and its recheck, through the extension's real entry. `activate()` runs with only the VS Code
 * API and the model's HTTP endpoint stood in (see ActivatedExtension.flows.test.ts): files, reads, receipts, review
 * admission, settlement, the ledger and its persistence are production code. Only the models' replies are scripted,
 * and no expected answer is in any agent's context. This file has its own activate().
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { RunLedger } from '../observability/RunLedger';
import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { buildPortableRunEvidence } from '../observability/PortableRunEvidence';
import { isReviewSetV1, type ReviewSetV1 } from '../backend/ReviewFindings';
import { projectReviewLoop } from '../observability/ReviewLoopProjection';
import {
  scripts, requests, latestUser, lastToolResult, replies, installActivatedExtension, pumpWhile, workspace, context,
  storedStateQuiet, type chatScreen, type ModelRequest, type ModelAnswer,
} from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The window's private storage is a file URI here, so the result bodies are saved as in a real window.
(context.storageUri as { scheme?: string }).scheme = 'file';

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; chatProvider = ready.chatProvider; });

// The chat's own detector of a rendered item that a later state lost: none of these flows may trip it.
const integrityReports: string[] = [];
const consoleWarn = console.warn.bind(console);
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const text = args.map(String).join(' ');
  if (text.includes('display-integrity bug')) integrityReports.push(text);
  consoleWarn(...args);
});
afterEach(() => { expect(integrityReports).toEqual([]); });

/** Synthetic credentials in the shapes the host's patterns know. Never real. */
const GITHUB_TOKEN = 'ghp_' + 'Q'.repeat(24);
const API_KEY = 'sk-' + 'Z'.repeat(24);

const BUGGY = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

const implementContract = (file: string) => ({
  version: 2, objective: `Write ${file}.`, expected_deliverable: file,
  effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
  outputs: [{ output_id: 'code', path: path.join(workspace, file), kind: 'file', required: true }],
  constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
  execution_strategy: 'delegate-required' });

const reviewContract = (file: string) => ({
  version: 1, objective: `Review ${file}: report findings with evidence.`, expected_deliverable: 'Findings.',
  effects: { read_files: [], expected_file_effect: 'none' },
  inputs: [{ input_id: 'target', kind: 'workspacePath', path: file, purpose: 'The file under review', required: true,
    freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } }],
  constraints: [], dependencies: [], review: { input_id: 'target' },
  required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required' });

const handleIn = (text: string | undefined) => /Handle: ([^\s.]+)/.exec(text ?? '')?.[1];
/** Tool results since the turn's own message: a teammate's conversation keeps its earlier tasks. */
const toolResultsOf = (request: ModelRequest) => {
  const lastUser = request.messages.map((message) => message.role).lastIndexOf('user');
  return request.messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length;
};

/** The run ledger as this window stored it, read back by the production persistence path into a new ledger. */
async function reloadedLedger(): Promise<RunLedger> {
  await storedStateQuiet();
  const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
  const host = { hostInstanceId: 'activated-flows-window', epoch: `reloaded-${Date.now()}` };
  return new RunLedger(await new PersistenceManager(context as never, undefined, () => workspace, host, undefined, state).loadRuns(), { host });
}

/** Every file below `dir`, as text. */
function filesBelow(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? filesBelow(path.join(dir, entry.name)) : [fs.readFileSync(path.join(dir, entry.name), 'utf8')]);
}

describe('v0.9.106 R1: a review\'s findings are numbered, decided one by one, and kept', () => {
  it('A3: two findings, one sent for a fix and one not adopted with a reason; nothing is closed in bulk; reload keeps it; no credential leaks', async () => {
    let devHandle = '';
    let reviewHandle = '';
    let reviewWake = '';
    let decisionResults = '';
    let bodiesAtWake: string[] = [];
    // Each teammate starts once the PM has answered the turn that sent it, as a person's teammate would.
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').includes(text) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: latestUser(request).includes('rework') ? 'Fixed calc.js.' : 'Wrote calc.js.' };
      const rework = /rework/i.test(latestUser(request));
      if (!rework) await after('Dev is writing calc.js.', 'Dev');
      return { calls: [{ name: 'write_file', args: { path: 'calc.js', content: rework ? FIXED : BUGGY } }] };
    });
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const done = toolResultsOf(request);
      if (done === 0) await after('Writer is reviewing calc.js.', 'Writer');
      // Reads with line numbers; closes once with one finding, again with two (the one used), then a refused close.
      if (done === 0) return { calls: [{ name: 'read_file', args: { path: 'calc.js', line_numbers: true } }] };
      if (done === 1) return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'complete', searches: [],
        findings: [{ classification: 'inferred', statement: 'A first draft finding.', citations: [] }] } } }] };
      if (done === 2) return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'complete', searches: [],
        findings: [
          { classification: 'observed', statement: `add() subtracts instead of adding (seen with key ${GITHUB_TOKEN}).`,
            citations: [{ readReceiptId: 'R1', path: 'calc.js', startLine: 2, endLine: 2 }] },
          { classification: 'inferred', statement: `The name add is vague; config has ${API_KEY}.`, citations: [] },
        ] } } }] };
      if (done === 3) return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'complete', searches: [],
        findings: [{ classification: 'observed', statement: 'Not shown.', citations: [{ readReceiptId: 'R9', path: 'calc.js', startLine: 1, endLine: 1 }] }] } } }] };
      return { text: 'Review done: add() subtracts.' };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (tool) {
        if (tool.includes('Recorded')) { decisionResults = tool; return { text: 'Asked Dev to fix F1; F2 is not adopted.' }; }
        const handle = handleIn(tool);
        if (handle && !devHandle) { devHandle = handle; return { text: 'Dev is writing calc.js.' }; }
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing calc.js.' }; }
        return { text: 'Noted.' };
      }
      if (said.includes('Async delegation result') && reviewHandle && said.includes(reviewHandle) && !reviewWake) {
        reviewWake = said;
        bodiesAtWake = filesBelow(path.join(workspace, '.storage', 'delegation-results-v1'));
        // F1 is sent for a fix before the review is accepted: an acceptance decides each finding first (field retest, 2026-11-18).
        return { calls: [
          { name: 'record_task_disposition', args: { handle: devHandle, disposition: 'needs-rework', reason: 'add() must add.',
            findings: [{ finding: `${reviewHandle}#F1`, action: 'fix-requested' }] } },
          { name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'accepted',
            findings: [{ finding: `${reviewHandle}#F2`, action: 'not-adopted', reason: 'add is the domain term here.' }] } },
        ] };
      }
      if (said.includes('Async delegation result') && devHandle && said.includes(devHandle) && !reviewHandle) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review calc.js.', contract: reviewContract('calc.js') } }] };
      }
      if (said.includes('rework reply')) return { text: 'calc.js is fixed.' };
      if (said.includes('Build calc.js')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write calc.js with add().', contract: implementContract('calc.js') } }] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Build calc.js and have it reviewed.');
    await pumpWhile(() => !replies('pm').includes('Asked Dev to fix F1; F2 is not adopted.'), screen.pump, {
      detail: () => JSON.stringify({ replies: replies('pm'), devHandle, reviewHandle, decisionResults }) });
    // Dev's rework comes back (the request's earlier run had closed): drained here, so the next flow starts clean.
    await pumpWhile(() => !replies('pm').some((text) => text.startsWith('calc.js is fixed.')), screen.pump, {
      detail: () => JSON.stringify({ replies: replies('pm') }) });
    expect(fs.readFileSync(path.join(workspace, 'calc.js'), 'utf8')).toBe(FIXED);

    // The PM was shown the findings of the close it used, numbered by the host, with no credential.
    expect(reviewWake).toContain(`${reviewHandle}#F1 [observed] add() subtracts instead of adding`);
    expect(reviewWake).toContain(`${reviewHandle}#F2 [inferred] The name add is vague`);
    expect(reviewWake).not.toContain('A first draft finding.');
    for (const pmRequest of requests.filter((r) => r.model === 'pm-model')) {
      expect(JSON.stringify(pmRequest)).not.toContain(GITHUB_TOKEN);
      expect(JSON.stringify(pmRequest)).not.toContain(API_KEY);
    }
    // The refused third close changed nothing; the writer was told it was refused.
    const writerResults = requests.filter((r) => r.model === 'writer-model').map((r) => lastToolResult(r) ?? '');
    expect(writerResults.some((text) => text.includes('read receipt R9 was not issued in this attempt'))).toBe(true);
    expect(decisionResults).toContain(`Recorded coordinator acceptance for ${reviewHandle}`);

    // What the window stored, read back as a reload reads it.
    const ledger = await reloadedLedger();
    // The review was dispatched in a later turn of the request, so it is in a later run of it than Dev's task.
    const runs = ledger.snapshot();
    const delegations = runs.flatMap((run) => run.delegations);
    const review = delegations.find((delegation) => delegation.handle === reviewHandle)!;
    const dev = delegations.find((delegation) => delegation.handle === devHandle)!;
    const sets = (review.reviewSets ?? []).filter(isReviewSetV1) as ReviewSetV1[];
    expect(sets).toHaveLength(1);
    const set = sets[0];
    expect(set.findings.map((finding) => [finding.findingId, finding.classification])).toEqual([['F1', 'observed'], ['F2', 'inferred']]);
    expect(set.findings[0].citations).toEqual([{ path: 'calc.js', startLine: 2, endLine: 2 }]);
    expect(set.result).toMatchObject({ handle: reviewHandle, revision: 1 });
    expect(set.review.target).toMatchObject({ inputId: 'target' });
    expect(set.review.reviewerAgentId).toBe('writer');
    // Each decision names its finding; nothing else about the findings was decided.
    const ref = (findingId: string) => ({ reviewSetId: set.reviewSetId, findingId });
    expect(review.dispositions.at(-1)).toMatchObject({ disposition: 'accepted', resultRevision: 1,
      findings: { schemaVersion: 1, entries: [{ ref: ref('F2'), action: 'not-adopted', reason: 'add is the domain term here.' }] } });
    expect(dev.dispositions.find((event) => event.disposition === 'needs-rework')).toMatchObject({ resultRevision: 1,
      findings: { schemaVersion: 1, entries: [{ ref: ref('F1'), action: 'fix-requested' }] } });
    const decided = delegations.flatMap((delegation) => delegation.dispositions.flatMap((event) => event.findings?.entries ?? []));
    expect(decided).toHaveLength(2);
    // Dev's task is no review: no set there.
    expect(dev.reviewSets).toBeUndefined();

    // Credentials in the reviewer's statements reach no stored record but the reviewer's own tool card and conversation
    // (its raw tool input, unchanged by this version): not the ledger, the result bodies, the message archive or the
    // portable export.
    expect(JSON.stringify(ledger.snapshot())).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(set)).toContain('[redacted secret]');
    const state = context.workspaceState as unknown as { keys(): string[]; get(key: string): unknown };
    const stores = state.keys().filter((key) => !/roam\.chat\.tools\.writer$|roam\.snapshot\.writer$/.test(key));
    for (const key of stores) {
      const text = JSON.stringify(state.get(key));
      expect(text.includes(GITHUB_TOKEN) || text.includes(API_KEY), key).toBe(false);
    }
    // The review's result body, saved for recovery until the PM decided on it (then reclaimed, as before).
    expect(bodiesAtWake.some((body) => body.includes(`${reviewHandle}#F1 [observed]`)), 'the result body of the review is saved').toBe(true);
    for (const body of [...bodiesAtWake, ...filesBelow(path.join(workspace, '.storage'))]) {
      expect(body.includes(GITHUB_TOKEN) || body.includes(API_KEY)).toBe(false);
    }
    // The message archive keeps the review's result with its findings block, redacted.
    const archive = JSON.stringify(state.keys().filter((key) => key.endsWith('roam.messages')).map((key) => state.get(key)));
    expect(archive).toContain(`${reviewHandle}#F1 [observed]`);
    // Existing behaviour, unchanged here: the reviewer's own tool card holds its raw tool input.
    const writerCards = JSON.stringify(state.keys().filter((key) => /roam\.chat\.tools\.writer$/.test(key)).map((key) => state.get(key)));
    expect(writerCards).toContain(GITHUB_TOKEN);
    const portable = JSON.stringify(runs.map((run) => buildPortableRunEvidence(run)));
    expect(portable).not.toContain(GITHUB_TOKEN);
    expect(portable).not.toContain('add() subtracts');
  });
});

describe('v0.9.106: a rework asked for after the result\'s run closed still comes back to the PM', () => {
  /*
   * The defect this proves fixed (observed 2026-11-17 through activate()): Dev's result arrives in turn 2; the PM sends
   * other work and replies, and that reply closes the run of Dev's task while its result still waits for a decision.
   * In turn 3 the PM records needs-rework on it. Before the fix the rework was sent and Dev rewrote the file, but no
   * revision was reserved in the closed run, so Dev's reply never reached the PM.
   */
  it('dev result in turn 2, its run closes, needs-rework in turn 3: Dev rewrites and the PM is woken with that result, once', async () => {
    let devHandle = '';
    let writerHandle = '';
    const reworkWakes: string[] = [];
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').includes(text) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: /rework/i.test(latestUser(request)) ? 'Fixed sum.js.' : 'Wrote sum.js.' };
      const rework = /rework/i.test(latestUser(request));
      if (!rework) await after('Dev is writing sum.js.', 'Dev');
      return { calls: [{ name: 'write_file', args: { path: 'sum.js', content: rework ? FIXED : BUGGY } }] };
    });
    scripts.set('writer-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Notes written.' };
      await after('Writer is writing notes.', 'Writer');
      return { calls: [{ name: 'write_file', args: { path: 'notes.md', content: 'Notes.' } }] };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (tool) {
        if (tool.includes('Recorded needs-rework')) return { text: 'Sent sum.js back to Dev.' };
        const handle = handleIn(tool);
        if (handle && !devHandle) { devHandle = handle; return { text: 'Dev is writing sum.js.' }; }
        if (handle && !writerHandle) { writerHandle = handle; return { text: 'Writer is writing notes.' }; }
        return { text: 'Noted.' };
      }
      if (said.includes('rework reply') && said.includes(devHandle)) { reworkWakes.push(said); return { text: 'sum.js is fixed.' }; }
      if (said.includes('Async delegation result') && writerHandle && said.includes(writerHandle)) {
        return { calls: [{ name: 'record_task_disposition', args: { handle: devHandle, disposition: 'needs-rework', reason: 'sum() must add.' } }] };
      }
      if (said.includes('Async delegation result') && devHandle && said.includes(devHandle) && !writerHandle) {
        // Turn 2: Dev's result is left undecided; other work is sent and the turn ends.
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Write notes.md.', contract: implementContract('notes.md') } }] };
      }
      if (said.includes('Build sum.js')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write sum.js.', contract: implementContract('sum.js') } }] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Build sum.js, then write notes.');
    await pumpWhile(() => !replies('pm').some((text) => text.startsWith('sum.js is fixed.')), screen.pump, {
      detail: () => JSON.stringify({ replies: replies('pm'), devHandle, writerHandle }) });

    // Dev rewrote the file, and its reply reached the PM once.
    expect(fs.readFileSync(path.join(workspace, 'sum.js'), 'utf8')).toBe(FIXED);
    expect(reworkWakes).toHaveLength(1);
    expect(reworkWakes[0]).toContain('Fixed sum.js.');
    await storedStateQuiet();
    expect(replies('pm').filter((text) => text.startsWith('sum.js is fixed.')), JSON.stringify(replies('pm'))).toHaveLength(1);
    // The rework is a second revision of Dev's task in the run it was dispatched in, which stays closed.
    const ledger = await reloadedLedger();
    const devRun = ledger.snapshot().find((run) => run.delegations.some((delegation) => delegation.handle === devHandle))!;
    const dev = devRun.delegations.find((delegation) => delegation.handle === devHandle)!;
    expect(dev.resultHistory?.map((result) => result.ref.revision)).toEqual([1, 2]);
    expect(dev.currentResultRevision).toBe(2);
    expect(dev.resultHistory?.find((result) => result.ref.revision === 2)?.delivery).toBe('delivered');
    expect(devRun.status).toBe('closed');
  });
});

describe('v0.9.106 R2: a fix is closed only by a new admitted review of the fixed version', () => {
  /** The review loop of the request the task `handle` belongs to, as a reload reads it. */
  async function loopOf(handle: string) {
    const ledger = await reloadedLedger();
    const run = ledger.snapshot().find((candidate) => candidate.delegations.some((delegation) => delegation.handle === handle))!;
    return { ledger, view: projectReviewLoop(ledger.requestRunsOf(run)) };
  }

  it('A4: review binds A; Dev fixes it to B; the reviewer\'s rework reply (its old receipt) closes nothing; a recheck bound to B does', async () => {
    let devHandle = '';
    let reviewHandle = '';
    let recheckHandle = '';
    const said = new Set<string>();
    // The recheck starts once the state before it has been read.
    let releaseRecheck!: () => void;
    const recheckMayStart = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith(text)) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('dev-model', async (request) => {
      const rework = /rework/i.test(latestUser(request));
      if (lastToolResult(request)) return { text: rework ? 'Fixed loop.js.' : 'Wrote loop.js.' };
      if (!rework) await after('Dev is writing loop.js.', 'Dev');
      return { calls: [{ name: 'write_file', args: { path: 'loop.js', content: rework ? FIXED : BUGGY } }] };
    });
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const user = latestUser(request);
      const done = toolResultsOf(request);
      if (/rework/i.test(user)) return { text: 'I checked it again; it looks fixed now.' };
      if (user.includes('Recheck F1 in loop.js.')) {
        if (done === 0) { await recheckMayStart; return { calls: [{ name: 'read_file', args: { path: 'loop.js', line_numbers: true } }] }; }
        if (done === 1) return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'partial', searches: [], findings: [],
          rechecks: [{ finding: `${reviewHandle}#F1`, status: 'resolved', citations: [{ readReceiptId: 'R1', path: 'loop.js', startLine: 2, endLine: 2 }] }] } } }] };
        return { text: 'Recheck done: F1 is fixed.' };
      }
      if (done === 0) { await after('Writer is reviewing loop.js.', 'Writer'); return { calls: [{ name: 'read_file', args: { path: 'loop.js', line_numbers: true } }] }; }
      if (done === 1) return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'partial', searches: [],
        findings: [{ classification: 'observed', statement: 'add() subtracts.', citations: [{ readReceiptId: 'R1', path: 'loop.js', startLine: 2, endLine: 2 }] }] } } }] };
      return { text: 'Review done.' };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const user = latestUser(request);
      const tool = lastToolResult(request);
      const once = (key: string) => (said.has(key) ? false : (said.add(key), true));
      if (tool) {
        const handle = handleIn(tool);
        if (handle && !devHandle) { devHandle = handle; return { text: 'Dev is writing loop.js.' }; }
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing loop.js.' }; }
        if (handle && !recheckHandle) { recheckHandle = handle; return { text: 'Writer is rechecking loop.js.' }; }
        if (tool.includes(`Recorded needs-rework for ${devHandle}`)) return { text: 'Dev is fixing F1.' };
        if (tool.includes(`Recorded needs-rework for ${reviewHandle}`)) return { text: 'Writer is checking again.' };
        return { text: 'Noted.' };
      }
      if (recheckHandle && user.includes(`=== writer (${recheckHandle})`) && once('recheck-wake')) return { text: 'F1 is closed.' };
      if (reviewHandle && user.includes('rework reply') && user.includes(reviewHandle) && once('review-rework')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Recheck F1 in loop.js.',
          contract: { ...reviewContract('loop.js'), review: { input_id: 'target', recheck: [`${reviewHandle}#F1`] } } } }] };
      }
      if (devHandle && user.includes('rework reply') && user.includes(devHandle) && once('dev-rework')) {
        // The reviewer's own rework: a new reply of the same review, carrying its old receipt. It is no review of B.
        return { calls: [{ name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'needs-rework', reason: 'Look at loop.js again.' } }] };
      }
      if (reviewHandle && user.includes(reviewHandle) && once('review-wake')) {
        return { calls: [{ name: 'record_task_disposition', args: { handle: devHandle, disposition: 'needs-rework', reason: 'add() must add.',
          findings: [{ finding: `${reviewHandle}#F1`, action: 'fix-requested' }] } }] };
      }
      if (devHandle && user.includes(devHandle) && once('dev-wake')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review loop.js.', contract: reviewContract('loop.js') } }] };
      }
      if (user.includes('Build loop.js')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write loop.js.', contract: implementContract('loop.js') } }] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Build loop.js and have it reviewed.');
    await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith('Writer is checking again.')), screen.pump,
      { detail: () => JSON.stringify(replies('pm')) });
    // The reviewer's rework reply has come back by the time the PM dispatches the recheck: until then F1 is fixed, not closed.
    await pumpWhile(() => !recheckHandle, screen.pump, { detail: () => JSON.stringify(replies('pm')) });
    const between = await loopOf(reviewHandle);
    const review = between.ledger.snapshot().flatMap((run) => run.delegations).find((delegation) => delegation.handle === reviewHandle)!;
    expect(review.resultHistory?.map((result) => result.ref.revision)).toEqual([1, 2]);
    // The rework revision of the review recorded no new set: it is a reply, not a review.
    expect((review.reviewSets ?? []).filter(isReviewSetV1).map((set) => (set as ReviewSetV1).result.revision)).toEqual([1]);
    expect(between.view.findings.find((finding) => finding.reviewHandle === reviewHandle)).toMatchObject({ findingId: 'F1', state: 'fixed-awaiting-recheck' });
    releaseRecheck();

    await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith('F1 is closed.')), screen.pump, { detail: () => JSON.stringify(replies('pm')) });
    const { ledger, view } = await loopOf(reviewHandle);
    const f1 = view.findings.find((finding) => finding.reviewHandle === reviewHandle && finding.findingId === 'F1')!;
    expect(f1).toMatchObject({ state: 'closed-by-recheck', recheck: { handle: recheckHandle, reviewerAgentId: 'writer', status: 'resolved' } });
    // The recheck was bound to the fixed bytes (B), not to the reviewed ones (A).
    const recheckSet = ledger.snapshot().flatMap((run) => run.delegations).find((delegation) => delegation.handle === recheckHandle)!
      .reviewSets!.filter(isReviewSetV1)[0] as ReviewSetV1;
    expect(recheckSet.review.target?.contentDigest).toBe(createHash('sha256').update(FIXED).digest('hex'));
    expect(recheckSet.review.recheckOf).toEqual([{ reviewSetId: (review.reviewSets![0] as ReviewSetV1).reviewSetId, findingId: 'F1' }]);
    expect(recheckSet.rechecks).toEqual([{ of: recheckSet.review.recheckOf![0], status: 'resolved', citations: [{ path: 'loop.js', startLine: 2, endLine: 2 }] }]);
  });
});

describe('v0.9.106 R3: one request from a reproducible error to a delivered, rechecked fix', () => {
  /** Every Job outcome view the chat holds for the PM, current or as an earlier report of the request's card. */
  const outcomeViews = (): any[] => {
    const messages = (chatProvider as any).currentState().messages as any[];
    return messages.flatMap((item) => [
      ...(item.kind === 'jobOutcome' ? [item.view] : []),
      ...((item.earlier ?? []) as any[]).map((report) => ({ sections: report.sections })),
      ...(item.kind === 'earlierResults' ? (item.cards as any[]).map((card) => card.view ?? card) : []),
    ]);
  };
  const reviewSections = () => outcomeViews().flatMap((view) => (view.sections ?? []).filter((section: any) => section.title === 'Review'));

  it('A1: Dev writes a bug, Writer finds it, the PM sends a fix as a new task, a recheck of the fixed file closes it, the check passes', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'a1', private: true,
      scripts: { test: 'node -e "process.exit(require(\'fs\').readFileSync(\'sum1.js\',\'utf8\').includes(\'a + b\')?0:1)"' } }));
    let devHandle = '';
    let reviewHandle = '';
    let fixHandle = '';
    let recheckHandle = '';
    let checkResult = '';
    const said = new Set<string>();
    const once = (key: string) => (said.has(key) ? false : (said.add(key), true));
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith(text)) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('dev-model', async (request) => {
      const user = latestUser(request);
      const fixing = user.includes('Fix F1 in sum1.js.');
      if (toolResultsOf(request)) return { text: fixing ? 'Fixed sum1.js.' : 'Wrote sum1.js.' };
      await after(fixing ? 'Dev is fixing F1.' : 'Dev is writing sum1.js.', 'Dev');
      return { calls: [{ name: 'write_file', args: { path: 'sum1.js', content: fixing ? FIXED : BUGGY } }] };
    });
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const user = latestUser(request);
      const done = toolResultsOf(request);
      const rechecking = user.includes('Recheck F1 in sum1.js.');
      if (done === 0) {
        await after(rechecking ? 'Writer is rechecking sum1.js.' : 'Writer is reviewing sum1.js.', 'Writer');
        return { calls: [{ name: 'read_file', args: { path: 'sum1.js', line_numbers: true } }] };
      }
      if (done === 1) {
        return { calls: [{ name: 'close_assignment', args: { review_evidence: rechecking
          ? { schemaVersion: 1, coverage: 'partial', searches: [], findings: [],
            rechecks: [{ finding: `${reviewHandle}#F1`, status: 'resolved', citations: [{ readReceiptId: 'R1', path: 'sum1.js', startLine: 2, endLine: 2 }] }] }
          : { schemaVersion: 1, coverage: 'partial', searches: [],
            findings: [{ classification: 'observed', statement: 'add() subtracts its arguments.', citations: [{ readReceiptId: 'R1', path: 'sum1.js', startLine: 2, endLine: 2 }] }] } } }] };
      }
      return { text: rechecking ? 'Recheck: F1 is resolved.' : 'Review: F1, add() subtracts.' };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const user = latestUser(request);
      const tool = lastToolResult(request);
      if (tool) {
        if (tool.startsWith('[checks')) { checkResult = tool; return { text: 'Delivered sum1.js: fixed, rechecked, and the check passes.' }; }
        const handle = handleIn(tool);
        if (handle && !devHandle) { devHandle = handle; return { text: 'Dev is writing sum1.js.' }; }
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing sum1.js.' }; }
        if (handle && !fixHandle) { fixHandle = handle; return { text: 'Dev is fixing F1.' }; }
        if (handle && !recheckHandle) { recheckHandle = handle; return { text: 'Writer is rechecking sum1.js.' }; }
        return { text: 'Noted.' };
      }
      const wakeOf = (handle: string) => !!handle && user.includes(`(${handle}) ===`);
      if (wakeOf(recheckHandle) && once('recheck')) {
        return { calls: [
          { name: 'record_task_disposition', args: { handle: recheckHandle, disposition: 'accepted' } },
          { name: 'run_checks', args: {} },
        ] };
      }
      if (wakeOf(fixHandle) && once('fix')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Recheck F1 in sum1.js.',
          contract: { ...reviewContract('sum1.js'), review: { input_id: 'target', recheck: [`${reviewHandle}#F1`] } } } }] };
      }
      if (wakeOf(reviewHandle) && once('review')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Fix F1 in sum1.js.',
          contract: { ...implementContract('sum1.js'), fixes: [`${reviewHandle}#F1`] } } }] };
      }
      if (wakeOf(devHandle) && once('dev')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review sum1.js.', contract: reviewContract('sum1.js') } }] };
      }
      if (user.includes('Build sum1.js')) {
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write sum1.js.', contract: implementContract('sum1.js') } }] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Build sum1.js, have it reviewed, and deliver it fixed.');
    await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith('Delivered sum1.js')), screen.pump,
      { deadlineMs: 40_000, detail: () => JSON.stringify(replies('pm')) });

    // The delivered file is the fixed one, and the project's check ran and passed on it.
    expect(fs.readFileSync(path.join(workspace, 'sum1.js'), 'utf8')).toBe(FIXED);
    expect(checkResult).toMatch(/^\[checks passed\]/);
    // The finding is closed by the recheck of the fixed file; the fix was dispatched for it.
    const ledger = await reloadedLedger();
    const run = ledger.snapshot().find((candidate) => candidate.delegations.some((delegation) => delegation.handle === reviewHandle))!;
    const view = projectReviewLoop(ledger.requestRunsOf(run));
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]).toMatchObject({ findingId: 'F1', state: 'closed-by-recheck', recheck: { handle: recheckHandle, reviewerAgentId: 'writer' } });
    const fix = ledger.snapshot().flatMap((entry) => entry.delegations).find((delegation) => delegation.handle === fixHandle)!;
    expect(fix.fixesFindings).toEqual([{ reviewSetId: view.findings[0].reviewSetId, findingId: 'F1' }]);
    // The request's result says so, in its Review section, with the reviewer's words as text.
    // This request's section (the chat also holds the cards of the requests before it).
    const ours = (item: string) => item.includes('sum1.js') && item.includes('closed by an independent recheck');
    await pumpWhile(() => !reviewSections().some((section) => (section.items ?? []).some(ours)),
      screen.pump, { detail: () => JSON.stringify(reviewSections()) });
    const section = reviewSections().find((entry) => (entry.items ?? []).some(ours))!;
    expect(section.rows).toContainEqual({ label: 'Findings', value: '1: 1 closed by an independent recheck' });
    expect(section.items[0]).toMatch(/^Writer's review F1 \[observed\] add\(\) subtracts its arguments\. — sum1\.js:2-2 · closed by an independent recheck · recheck by Writer of the version at \S+$/);
  });

  it('opening the result and Review changes only navigates: no verdict, decision, dispatch or model request', async () => {
    const before = requests.length;
    const ledger = await reloadedLedger();
    const runs = ledger.snapshot();
    const decisions = JSON.stringify(runs.map((run) => [run.verdicts, run.delegations.map((delegation) => [delegation.handle, delegation.dispositions.length])]));
    // The card of the run that changed sum1.js offers Review changes; pressing it only opens the change view.
    const changed = runs.find((run) => run.delegations.some((delegation) => delegation.evidence?.changedFiles.includes('sum1.js')))!;
    await screen.select('pm');
    const opened = vi.spyOn(chatProvider, 'openWorkbench');
    (chatProvider as any).runJobOutcomeAction(`outcome:${changed.id}`, 'reviewChanges');
    await screen.pump();
    expect(opened).toHaveBeenCalledTimes(1);
    opened.mockRestore();
    await storedStateQuiet();
    const after = await reloadedLedger();
    expect(JSON.stringify(after.snapshot().map((run) => [run.verdicts, run.delegations.map((delegation) => [delegation.handle, delegation.dispositions.length])]))).toBe(decisions);
    expect(after.snapshot().length).toBe(runs.length);
    expect(requests.length).toBe(before);
  });
});

describe('v0.9.106 R3: the PM\'s own work goes through the same loop', () => {
  it('A2: the PM fixes its own file; a recheck of the pre-fix version closes nothing; a recheck of the last version does; reload agrees', async () => {
    const PM_BUG = 'Total: 1 + 1 = 3\n';
    const FIX_1 = 'Total: 1 + 1 = 2?\n';
    const FIX_2 = 'Total: 1 + 1 = 2\n';
    let reviewHandle = '';
    let staleHandle = '';
    let recheckHandle = '';
    const said = new Set<string>();
    const once = (key: string) => (said.has(key) ? false : (said.add(key), true));
    let releaseRecheck!: () => void;
    const recheckMayStart = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith(text)) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    const recheckClose = (status: 'resolved') => ({ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'partial', searches: [], findings: [],
      rechecks: [{ finding: `${reviewHandle}#F1`, status, citations: [{ readReceiptId: 'R1', path: 'notes2.md', startLine: 1, endLine: 1 }] }] } } });
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const user = latestUser(request);
      const done = toolResultsOf(request);
      const stale = user.includes('Recheck the old notes2.md.');
      const recheck = user.includes('Recheck the fixed notes2.md.');
      if (done === 0) {
        if (recheck) await recheckMayStart;
        else await after(stale ? 'Writer is checking the old version.' : 'Writer is reviewing notes2.md.', 'Writer');
        return { calls: [{ name: 'read_file', args: { path: 'notes2.md', line_numbers: true } }] };
      }
      if (done === 1) {
        return { calls: [stale || recheck ? recheckClose('resolved') : { name: 'close_assignment', args: { review_evidence: { schemaVersion: 1,
          coverage: 'partial', searches: [], findings: [{ classification: 'observed', statement: 'The total is wrong.',
            citations: [{ readReceiptId: 'R1', path: 'notes2.md', startLine: 1, endLine: 1 }] }] } } }] };
      }
      return { text: stale ? 'Old version: resolved.' : recheck ? 'Fixed version: resolved.' : 'Review: F1, the total is wrong.' };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const user = latestUser(request);
      const tool = lastToolResult(request);
      const wakeOf = (handle: string) => !!handle && user.includes(`(${handle}) ===`);
      if (tool) {
        const handle = handleIn(tool);
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing notes2.md.' }; }
        if (handle && !staleHandle) { staleHandle = handle; return { text: 'Writer is checking the old version.' }; }
        if (handle && !recheckHandle) { recheckHandle = handle; return { text: 'Writer is rechecking the fix.' }; }
        if (tool.includes('notes2.md') && once('fixed')) {
          return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Recheck the fixed notes2.md.',
            contract: { ...reviewContract('notes2.md'), review: { input_id: 'target', recheck: [`${reviewHandle}#F1`] } } } }] };
        }
        return { text: 'Noted.' };
      }
      if (wakeOf(recheckHandle) && once('recheck')) return { text: 'notes2.md is fixed and rechecked.' };
      if (wakeOf(staleHandle) && once('stale')) {
        // The fix, written twice: two versions of the file, in order.
        return { calls: [
          { name: 'write_file', args: { path: 'notes2.md', content: FIX_1 } },
          { name: 'write_file', args: { path: 'notes2.md', content: FIX_2 } },
        ] };
      }
      if (wakeOf(reviewHandle) && once('review')) {
        return { calls: [
          { name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'accepted',
            findings: [{ finding: `${reviewHandle}#F1`, action: 'fixing-myself' }] } },
          // A recheck dispatched before the fix: it is bound to the bytes the review saw.
          { name: 'dispatch_task', args: { agent: 'writer', instruction: 'Recheck the old notes2.md.',
            contract: { ...reviewContract('notes2.md'), review: { input_id: 'target', recheck: [`${reviewHandle}#F1`] } } } },
        ] };
      }
      if (user.includes('Write notes2.md')) {
        return { calls: [
          { name: 'write_file', args: { path: 'notes2.md', content: PM_BUG } },
          { name: 'write_file', args: { path: 'other2.md', content: 'Other notes.\n' } },
          { name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review notes2.md.', contract: reviewContract('notes2.md') } },
        ] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Write notes2.md and other2.md, and have notes2.md reviewed.');
    await pumpWhile(() => !recheckHandle, screen.pump, { deadlineMs: 30_000, detail: () => JSON.stringify(replies('pm')) });

    // Before the recheck of the fixed file: the stale recheck reviewed another version, so the fix is not closed.
    const loop = async () => {
      const ledger = await reloadedLedger();
      const run = ledger.snapshot().find((candidate) => candidate.delegations.some((delegation) => delegation.handle === reviewHandle))!;
      return { ledger, view: projectReviewLoop(ledger.requestRunsOf(run)) };
    };
    const between = await loop();
    expect(between.view.findings).toHaveLength(1);
    expect(between.view.findings[0]).toMatchObject({ findingId: 'F1', state: 'fixed-awaiting-recheck', gap: 'recheck-of-another-version' });
    const review = between.ledger.snapshot().flatMap((run) => run.delegations).find((delegation) => delegation.handle === reviewHandle)!;
    const effects = review.targetEffects ?? [];
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(effects.map((effect) => [effect.seq, effect.byCoordinator, effect.sha256])).toEqual([[1, true, digest(FIX_1)], [2, true, digest(FIX_2)]]);
    expect(effects.every((effect) => effect.fixes.length === 1)).toBe(true);

    releaseRecheck();
    await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith('notes2.md is fixed and rechecked.')), screen.pump,
      { detail: () => JSON.stringify(replies('pm')) });
    const { view } = await loop();
    expect(view.findings[0]).toMatchObject({ state: 'closed-by-recheck', recheck: { handle: recheckHandle, reviewerAgentId: 'writer' } });
    expect(view.findings[0].changedLaterBy).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, 'notes2.md'), 'utf8')).toBe(FIX_2);
    // The other file the PM wrote went to no review: the result says so.
    const reviewItems = () => ((chatProvider as any).currentState().messages as any[]).flatMap((item) => [
      ...(item.kind === 'jobOutcome' ? [item.view] : []), ...((item.earlier ?? []) as any[])])
      .flatMap((view) => (view.sections ?? []).filter((section: any) => section.title === 'Review'))
      .flatMap((section: any) => section.items ?? []);
    await pumpWhile(() => !reviewItems().includes('other2.md · not independently reviewed'), screen.pump,
      { detail: () => JSON.stringify(reviewItems()) });
    expect(reviewItems()).not.toContain('notes2.md · not independently reviewed');
  });
});

describe('v0.9.106 R3: Stop and reload keep the loop\'s facts and replay nothing', () => {
  it('A6: Stop while a recheck runs: nothing is revived or dispatched, the finding stays open, and a reload reads the same', async () => {
    let reviewHandle = '';
    let recheckHandle = '';
    const said = new Set<string>();
    const once = (key: string) => (said.has(key) ? false : (said.add(key), true));
    let pmThinking!: () => void;
    const pmInTurn = new Promise<void>((resolve) => { pmThinking = resolve; });
    let releaseRecheck!: () => void;
    const recheckMayGoOn = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith(text)) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const user = latestUser(request);
      const done = toolResultsOf(request);
      const recheck = user.includes('Recheck stop.md.');
      if (done === 0) {
        if (recheck) await recheckMayGoOn; else await after('Writer is reviewing stop.md.', 'Writer');
        return { calls: [{ name: 'read_file', args: { path: 'stop.md', line_numbers: true } }] };
      }
      if (done === 1) {
        return { calls: [{ name: 'close_assignment', args: { review_evidence: recheck
          ? { schemaVersion: 1, coverage: 'partial', searches: [], findings: [],
            rechecks: [{ finding: `${reviewHandle}#F1`, status: 'resolved', citations: [{ readReceiptId: 'R1', path: 'stop.md', startLine: 1, endLine: 1 }] }] }
          : { schemaVersion: 1, coverage: 'partial', searches: [], findings: [{ classification: 'observed', statement: 'Wrong line.',
            citations: [{ readReceiptId: 'R1', path: 'stop.md', startLine: 1, endLine: 1 }] }] } } }] };
      }
      return { text: recheck ? 'Recheck: resolved.' : 'Review: F1.' };
    });
    scripts.set('pm-model', (request): ModelAnswer | Promise<ModelAnswer> => {
      const user = latestUser(request);
      const tool = lastToolResult(request);
      const wakeOf = (handle: string) => !!handle && user.includes(`(${handle}) ===`);
      if (tool) {
        const handle = handleIn(tool);
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing stop.md.' }; }
        if (handle && !recheckHandle) { recheckHandle = handle; pmThinking(); return new Promise<ModelAnswer>(() => { /* still thinking at Stop */ }); }
        return { text: 'Noted.' };
      }
      if (wakeOf(reviewHandle) && once('review')) {
        return { calls: [
          { name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'accepted', findings: [{ finding: `${reviewHandle}#F1`, action: 'fixing-myself' }] } },
          { name: 'write_file', args: { path: 'stop.md', content: 'Right line.\n' } },
          { name: 'dispatch_task', args: { agent: 'writer', instruction: 'Recheck stop.md.',
            contract: { ...reviewContract('stop.md'), review: { input_id: 'target', recheck: [`${reviewHandle}#F1`] } } } },
        ] };
      }
      if (user.includes('Write stop.md')) {
        return { calls: [
          { name: 'write_file', args: { path: 'stop.md', content: 'Wrong line.\n' } },
          { name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review stop.md.', contract: reviewContract('stop.md') } },
        ] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Write stop.md and have it reviewed.');
    await pmInTurn;
    await screen.stop();
    await pumpWhile(() => !screen.strip().some((line) => line.startsWith('Stopped.')), screen.pump);
    expect(screen.strip()[0]).toBe('Stopped. The PM does not continue until you send a message.');
    const pmRequests = requests.filter((request) => request.model === 'pm-model').length;
    // The recheck's teammate goes on after the Stop; whatever it returns does not revive the request.
    releaseRecheck();
    await storedStateQuiet();
    await screen.pump();
    expect(requests.filter((request) => request.model === 'pm-model').length).toBe(pmRequests);

    const read = async () => {
      const ledger = await reloadedLedger();
      const run = ledger.snapshot().find((candidate) => candidate.delegations.some((delegation) => delegation.handle === reviewHandle))!;
      return projectReviewLoop(ledger.requestRunsOf(run));
    };
    const first = await read();
    expect(first.findings).toHaveLength(1);
    // Nothing closed the fix: the recheck was stopped.
    expect(first.findings[0].state).not.toBe('closed-by-recheck');
    expect(first.findings[0].state).toBe('fixed-awaiting-recheck');
    // A second reload reads the same, and starts nothing.
    expect(await read()).toEqual(first);
    expect(requests.filter((request) => request.model === 'pm-model').length).toBe(pmRequests);
  });
});

describe('v0.9.106 (field retest, 2026-11-18): a review that found no defect leaves nothing undecided', () => {
  const reviewItems = () => ((chatProvider as any).currentState().messages as any[]).flatMap((item) => [
    ...(item.kind === 'jobOutcome' ? [item.view] : []), ...((item.earlier ?? []) as any[])])
    .flatMap((view) => (view.sections ?? []).filter((section: any) => section.title === 'Review'))
    .flatMap((section: any) => section.items ?? []);

  it('A7: a "PASS" finding blocks the acceptance until the PM decides it; a later review with no finding is accepted at once', async () => {
    const PASS = 'PASS for add7.js lines 1-3: no concrete defect found.';
    let reviewHandle = '';
    let secondHandle = '';
    let refusal = '';
    const said = new Set<string>();
    const once = (key: string) => (said.has(key) ? false : (said.add(key), true));
    const after = async (text: string, running: string) => {
      await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith(text)) || !screen.strip().some((line) => line.startsWith(`Running: ${running}`)), screen.pump);
    };
    scripts.set('writer-model', async (request): Promise<ModelAnswer> => {
      const again = latestUser(request).includes('Review add7.js again.');
      const done = toolResultsOf(request);
      if (done === 0) {
        await after(again ? 'Writer is reviewing add7.js again.' : 'Writer is reviewing add7.js.', 'Writer');
        return { calls: [{ name: 'read_file', args: { path: 'add7.js', line_numbers: true } }] };
      }
      // The first close is what the field's Codex reviewer sent: its pass as a finding. The second follows the guidance.
      if (done === 1) {
        return { calls: [{ name: 'close_assignment', args: { review_evidence: { schemaVersion: 1, coverage: 'complete', searches: [],
          findings: again ? [] : [{ classification: 'observed', statement: PASS, citations: [{ readReceiptId: 'R1', path: 'add7.js', startLine: 1, endLine: 3 }] }] } } }] };
      }
      return { text: 'No defect found in add7.js.' };
    });
    scripts.set('pm-model', (request): ModelAnswer => {
      const user = latestUser(request);
      const tool = lastToolResult(request);
      const wakeOf = (handle: string) => !!handle && user.includes(`(${handle}) ===`);
      if (tool) {
        if (tool.includes('was not recorded') && once('refused')) {
          refusal = tool;
          return { calls: [{ name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'accepted-with-caveat',
            reason: 'No defect found', findings: [{ finding: `${reviewHandle}#F1`, action: 'not-adopted', reason: 'It reports a pass, not a defect.' }] } }] };
        }
        if (tool.includes(`Recorded coordinator acceptance with caveat for ${reviewHandle}`) && once('accepted')) {
          return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review add7.js again.', contract: reviewContract('add7.js') } }] };
        }
        if (secondHandle && tool.includes(`Recorded coordinator acceptance for ${secondHandle}`)) return { text: 'add7.js is reviewed.' };
        const handle = handleIn(tool);
        if (handle && !reviewHandle) { reviewHandle = handle; return { text: 'Writer is reviewing add7.js.' }; }
        if (handle && !secondHandle) { secondHandle = handle; return { text: 'Writer is reviewing add7.js again.' }; }
        return { text: 'Noted.' };
      }
      if (wakeOf(secondHandle) && once('second')) {
        return { calls: [{ name: 'record_task_disposition', args: { handle: secondHandle, disposition: 'accepted' } }] };
      }
      if (wakeOf(reviewHandle) && once('review')) {
        // What the field's PM did: an acceptance with a caveat and no decision on the finding.
        return { calls: [{ name: 'record_task_disposition', args: { handle: reviewHandle, disposition: 'accepted-with-caveat', reason: 'No defect found' } }] };
      }
      if (user.includes('Write add7.js')) {
        return { calls: [
          { name: 'write_file', args: { path: 'add7.js', content: FIXED } },
          { name: 'dispatch_task', args: { agent: 'writer', instruction: 'Review add7.js.', contract: reviewContract('add7.js') } },
        ] };
      }
      return { text: 'Nothing to do.' };
    });
    await screen.select('pm');
    await screen.send('Write add7.js and have it reviewed.');
    await pumpWhile(() => !replies('pm').some((reply) => reply.startsWith('add7.js is reviewed.')), screen.pump,
      { deadlineMs: 40_000, detail: () => JSON.stringify({ replies: replies('pm'), refusal }) });

    // The PM was told which finding had no decision, in the reviewer's words, and how to decide it.
    expect(refusal).toContain(`Error: accepted-with-caveat of ${reviewHandle} was not recorded: 1 finding of its review has no decision yet: `
      + `${reviewHandle}#F1 ("${PASS}")`);
    expect(refusal).toContain('A finding that is not a defect is not-adopted, with your reason.');
    // The reviewer was told a pass is no finding.
    const writerTurns = JSON.stringify(requests.filter((request) => request.model === 'writer-model').map((request) => request.messages));
    expect(writerTurns).toContain('If you found none, close with findings: [] and your coverage');

    const ledger = await reloadedLedger();
    const delegations = ledger.snapshot().flatMap((run) => run.delegations);
    const first = delegations.find((delegation) => delegation.handle === reviewHandle)!;
    const second = delegations.find((delegation) => delegation.handle === secondHandle)!;
    // One decision on the first review: the acceptance and its finding decision, recorded together. The refused one left nothing.
    expect(first.dispositions).toHaveLength(1);
    expect(first.dispositions[0]).toMatchObject({ disposition: 'accepted-with-caveat',
      findings: { entries: [{ ref: { findingId: 'F1' }, action: 'not-adopted', reason: 'It reports a pass, not a defect.' }] } });
    expect(second.dispositions).toEqual([expect.objectContaining({ disposition: 'accepted' })]);
    expect((second.reviewSets ?? []).filter(isReviewSetV1).map((set) => (set as ReviewSetV1).findings)).toEqual([[]]);
    const view = projectReviewLoop(ledger.requestRunsOf(ledger.snapshot().find((run) => run.delegations.some((delegation) => delegation.handle === reviewHandle))!));
    expect(view.findings.map((finding) => [finding.reviewHandle, finding.findingId, finding.state])).toEqual([[reviewHandle, 'F1', 'not-adopted']]);
    // The request's Review section shows the decision, and nothing as not decided.
    const ours = (item: string) => item.includes(PASS);
    await pumpWhile(() => !reviewItems().some(ours), screen.pump, { detail: () => JSON.stringify(reviewItems()) });
    // Each card of the request that shows it (the current one and an earlier report) says the same.
    expect([...new Set(reviewItems().filter(ours))]).toEqual([expect.stringContaining('· not adopted · reason: It reports a pass, not a defect.')]);
    expect(reviewItems().filter(ours).join('\n')).not.toContain('not decided yet');
  });
});
