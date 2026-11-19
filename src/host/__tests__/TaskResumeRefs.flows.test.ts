import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { TaskInputResolver } from '../../backend/TaskContract';
import { RESUME_REF_WITH_CONTRACT_REFUSAL, TeamTools, type TeamView } from '../../backend/TeamTools';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { RunLedger } from '../../observability/RunLedger';
import { projectJobOutcome } from '../../observability/JobOutcome';
import { classifyPmTasks } from '../../session/PmTurnStatus';
import { runAcceptanceEvidence } from '../../views/runCloseoutPresentation';
import { createPathAccessOffer, type PathAccessItem } from '../PathAccessOffer';
import { TaskResumeRefs } from '../TaskResumeRefs';
import { TaskClaimRegistry } from '../../backend/TaskClaimRegistry';
import { SessionManager } from '../../session/SessionManager';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';

/*
 * v0.9.101 (G3, T101-1, F3): a task a refused file call stopped is retried after Grant access, and the retry settles it.
 * Real TeamTools dispatch_task, real RunLedger, the real grant store and Grant access handler, the worker's real file
 * tools, the real Job outcome, PM footer and Review Delivered Work projections. Only the model is scripted: the PM's
 * calls are made here, and the worker's replies are bus messages.
 */

const REQUEST = 'r1';
const DEV = 'dev';
const INSTRUCTION = 'Read the lease outside the workspace, then save a bilingual summary to output/summary.docx.';
const BASE_NOTICE = 'Host scope update: Read access for a requested file or folder is now available for this request.';
const REF = /resume_ref (rr-[0-9a-f]{32}) /;

const contract = () => ({
  version: 2,
  objective: 'Bilingual summary of the lease agreement.',
  expected_deliverable: 'output/summary.docx',
  effects: { read_files: [], expected_file_effect: 'create' },
  inputs: [],
  outputs: [{ output_id: 'summary', path: 'output/summary.docx', kind: 'file', required: true }],
  constraints: [{ text: 'Keep both languages side by side.', basis_refs: [] }],
  dependencies: [],
  required_capabilities: { version: 1, capabilities: ['read', 'write'] },
  execution_strategy: 'delegate-required',
});
const handleOf = (text: string) => /Handle: ([^\s.]+)/.exec(text)?.[1] ?? '';
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function host(options: { refs?: TaskResumeRefs; ledger?: RunLedger; coordinator?: string; claims?: TaskClaimRegistry } = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'unode-g3-')));
  cleanups.push(base);
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'output'), { recursive: true });
  mkdirSync(outside);
  const source = path.join(outside, 'lease.docx');
  writeFileSync(source, 'MASTER LEASE AGREEMENT');
  const pmId = options.coordinator ?? 'pm';
  const roster = [
    { id: pmId, role: 'pm', name: 'PM', status: 'running' },
    { id: DEV, role: 'custom', name: 'Senior Developer', status: 'idle',
      capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const } },
  ];
  const view: TeamView = {
    list: () => roster,
    preflightTaskScope: () => undefined,
    execution: () => ({ state: 'not-running' as const }),
    resolve: (ref) => roster.find((entry) => entry.id === ref) ? { id: ref } : undefined,
  };
  const bus = new MessageBus();
  let ledger = options.ledger ?? new RunLedger();
  bus.on('message.sent', (msg: unknown) => ledger.observeMessage(msg as Message));
  const rootMsg = bus.send('user', pmId, 'ask.question', { instruction: 'Summarise the lease into output/.' }) as Message;
  const owner = new SessionLocalReadScopeConsent(async () => false);
  let pmRequest = REQUEST;
  let workerTurn: string | undefined;
  const refs = options.refs ?? new TaskResumeRefs({
    openDelegationOf: (agentId) => ledger.activeDelegation(agentId === DEV ? workerTurn : undefined, agentId),
    grantsFor: (requestId) => owner.pathAccessFor(requestId),
    predecessor: (coordinatorId, handle) => ledger.resumePredecessor(coordinatorId, handle),
    currentRequestOf: () => pmRequest,
  });
  const results = new Map<string, string>();
  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); workerTurn = message.correlationId; });
  const team = new TeamTools(pmId, view, bus, {
    timeoutMs: 60_000, cwd: root, evidenceEnabled: true,
    ...(options.claims ? { claims: options.claims } : {}),
    taskInputResolver: new TaskInputResolver(new ContentAssetStore(), root),
    // The ledger half of the host's result retention, and the wake's text: what the PM is handed.
    onAsyncResultReady: (result) => {
      results.set(result.handle, result.text);
      const identity = ledger.resultIdentity(pmId, result.handle);
      if (identity) ledger.recordResultSettlement(identity, result.outcome?.status === 'failed' ? 'failed' : 'ready');
      return true;
    },
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: rootMsg.id }),
    onDelegationEvidence: ({ handle, outcome, evidence, agentId, executionEnded }) =>
      ledger.recordDelegationEvidence({ handle, outcome, evidence, agentId, executionEnded }),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus(pmId, handles),
    taskResume: refs,
  });
  team.beginTurnContentReceipts();

  // Grant access for the worker's notice and for the PM's, as src/extension.ts wires them: one handler per target.
  const items = new Map<string, PathAccessItem>();
  const pmNotices: string[] = [];
  const workerGrants: string[] = [];
  let choice: { permission: 'read' | 'readwrite'; lifetime: 'request' | 'session' } = { permission: 'read', lifetime: 'request' };
  const offerFor = (agentId: string) => createPathAccessOffer({
    owner,
    canOffer: () => true,
    captureRequest: () => ({ requestId: REQUEST, isCurrent: () => true }),
    present: async () => false,
    choose: async () => choice,
    item: (item) => { items.set(agentId, item); },
    granted: (grant, _current, requestId) => {
      if (agentId !== pmId) { workerGrants.push(grant.id); return; }
      const notice = refs.grantNotice(pmId, requestId, BASE_NOTICE);
      pmNotices.push(notice.text);
      notice.report({ kind: 'continues' });
    },
    unavailable: () => undefined,
    requestEnded: () => undefined,
    refused: (named, request, access) => refs.capture(agentId, request.requestId, named, access),
  });
  const workerOffer = offerFor(DEV);
  const pmOffer = offerFor(pmId);
  const worker = new WorkspaceTools(root, new Set(['read', 'write']), DEV);
  worker.setLivePathAccess(() => owner.pathAccessFor(REQUEST));
  worker.setOutsideRootObserver((target) => workerOffer(target));

  const h = {
    root, source, bus, team, refs, owner, results, assigned, pmNotices, workerGrants, rootMsg, items,
    /** The teammate's execution workspace, as the roster gives it (an isolated worktree). */
    setWorkerRoot: (folder: string) => { (roster[1] as any).workspaceRoot = folder; },
    /** The worker's item: its Continue, while offered. */
    workerItem: () => items.get(DEV),
    ledger: () => ledger,
    reload: () => { ledger = new RunLedger(ledger.snapshot()); return ledger; },
    setPmRequest: (requestId: string) => { pmRequest = requestId; },
    setChoice: (next: typeof choice) => { choice = next; },
    /** The PM's dispatch_task. */
    dispatch: async (args: Record<string, unknown>) => {
      team.beginTurnContentReceipts();
      return team.run('dispatch_task', { agent: DEV, instruction: INSTRUCTION, ...args });
    },
    /** The worker's own read of the outside source: refused, and Grant access is offered for it. */
    refusedRead: async () => {
      const outcome = await worker.run('read_file', { path: source });
      expect(outcome.status).toBe('refused');
    },
    /** The person chooses Grant access on the worker's notice, or on the PM's own for the same target. */
    grant: async (via: 'worker' | 'pm') => {
      if (via === 'pm') pmOffer(source, 'named');
      await flush();
      items.get(via === 'pm' ? pmId : DEV)!.grant();
      await flush();
    },
    /** The worker's reply for this handle: without the work, or with the required output saved. */
    reply: async (handle: string, finished: boolean) => {
      bus.send(DEV, pmId, 'task.complete', finished
        ? { instruction: 'Saved output/summary.docx.', metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['output/summary.docx'] } } }
        : { instruction: 'The source could not be read: access was refused. Please grant access.',
          metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } } },
      'normal', handle);
      await flush();
      expect(team.consumeAsyncResult(handle)).toBe(true);
    },
    decide: async (handle: string, disposition: string, reason?: string, replacement?: string) => {
      team.beginTurnContentReceipts();
      return team.run('record_task_disposition', { handle, disposition, ...(reason ? { reason } : {}),
        ...(replacement ? { replacement_handle: replacement } : {}) });
    },
    closeWith: (type: 'task.complete' | 'task.partial') => bus.send(pmId, 'user', type, { instruction: 'Done.' }, 'normal', rootMsg.id),
    delegation: (handle: string) => ledger.snapshot().flatMap((run) => run.delegations).find((row) => row.handle === handle)!,
    superseded: (handle: string) => h.delegation(handle).dispositions.filter((entry) => entry.disposition === 'superseded'),
    job: () => {
      const [run] = ledger.snapshot();
      const outcome = projectJobOutcome(run.id, ledger.get(run.id), () => undefined);
      if (outcome.state !== 'available') throw new Error(`job outcome ${outcome.state}`);
      return outcome;
    },
    footer: (handles: string[]) => classifyPmTasks(ledger.inspectTaskStatus(pmId, handles)),
  };
  return h;
}

/** The first task: dispatched, refused on its source, settled without its work, and decided needs-human, as in the field. */
async function stoppedForAccess(h: ReturnType<typeof host>, decide = true): Promise<string> {
  const h1 = handleOf(await h.dispatch({ contract: contract() }));
  expect(h1).not.toBe('');
  await h.refusedRead();
  await h.reply(h1, false);
  if (decide) expect(await h.decide(h1, 'needs-human', 'The source was refused; the user must choose Grant access.')).toMatch(/^Recorded/);
  return h1;
}

describe('v0.9.101 G3: a retry by resume_ref settles the task that lacked file access', () => {
  it('settled first, then granted: the PM\'s grant notice carries one ref, the retry runs the stored contract and replaces the old task at admission, and the job closes Complete everywhere', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    expect(h.results.get(h1)).not.toMatch(REF);
    await h.grant('pm');
    expect(h.pmNotices).toHaveLength(1);
    const ref = REF.exec(h.pmNotices[0])?.[1];
    expect(ref).toBeDefined();
    expect(h.pmNotices[0]).toContain(`Task ${h1} stopped for lack of this access.`);
    const stored = h.delegation(h1).contract!;

    const second = await h.dispatch({ resume_ref: ref });
    const h2 = handleOf(second);
    expect(second).toContain(`Task ${h1} will be recorded as replaced by this task`);
    // Replaced in the admission step itself: the new task is still running.
    expect(h.delegation(h2).state).toBe('active');
    expect(h.superseded(h1)).toEqual([expect.objectContaining({ replacementHandle: h2 })]);
    // The original inputs, outputs, effects and checks, under a fresh contract identity.
    const retried = h.delegation(h2).contract!;
    const { contractId: firstId, compiledAt: _first, ...requirements } = stored;
    const { contractId: retryId, compiledAt: _retry, ...retriedRequirements } = retried;
    expect(retriedRequirements).toEqual(requirements);
    expect(retryId).not.toBe(firstId);
    expect(h.assigned).toHaveLength(2);

    await h.reply(h2, true);
    expect(await h.decide(h2, 'accepted')).toMatch(/^Recorded/);
    expect(h.footer([h1, h2]).human).toEqual([]);
    h.closeWith('task.complete');
    const job = h.job();
    expect(job.completion).toBe('complete');
    expect(job.remaining.items).toEqual([]);
    // Review Delivered Work: the old task is named replaced and nothing is asked about it.
    const review = runAcceptanceEvidence(h.ledger().get(job.runId)!);
    expect(review).toContain(`Coordinator dispositions: ${h1}: replaced by ${h2}; ${h2}: accepted.`);
    expect(review).not.toContain('needs-human');
  });

  it('a contract sent beside the ref is refused: the ref is not used and the old task is not replaced; the same ref alone then retries it', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    const different = { ...contract(), version: 1, outputs: undefined, objective: 'A short status note instead.',
      expected_deliverable: 'output/note.md' };
    delete (different as Record<string, unknown>).outputs;
    expect(await h.dispatch({ resume_ref: ref, contract: different })).toBe(RESUME_REF_WITH_CONTRACT_REFUSAL);
    expect(h.superseded(h1)).toEqual([]);
    expect(h.assigned).toHaveLength(1);
    expect(h.ledger().snapshot()[0].delegations).toHaveLength(1);

    const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
    expect(h2).not.toBe('');
    expect(h.superseded(h1)).toEqual([expect.objectContaining({ replacementHandle: h2 })]);
  });

  for (const via of ['worker', 'pm'] as const) {
    it(`granted on the ${via}'s notice while the task runs, then it settles without its work: exactly one ref, on its result, and no other notice`, async () => {
      const h = host();
      const h1 = handleOf(await h.dispatch({ contract: contract() }));
      await h.refusedRead();
      await h.grant(via);
      // Nothing to retry yet: a grant notice, if any goes to the PM, carries no ref.
      expect(h.pmNotices.join(' ')).not.toMatch(REF);
      expect(h.pmNotices).toHaveLength(via === 'pm' ? 1 : 0);
      await h.reply(h1, false);
      const text = h.results.get(h1)!;
      expect(text.match(new RegExp(REF.source, 'g'))).toHaveLength(1);
      expect(text).toContain(`Task ${h1} did not finish, and the file access it lacked was granted while it ran.`);
      expect(h.pmNotices).toHaveLength(via === 'pm' ? 1 : 0);
      const h2 = handleOf(await h.dispatch({ resume_ref: REF.exec(text)![1] }));
      expect(h.superseded(h1)).toEqual([expect.objectContaining({ replacementHandle: h2 })]);
    });
  }

  it('granted while the task runs, and the worker then saves the required output: no ref and no replacement', async () => {
    const h = host();
    const h1 = handleOf(await h.dispatch({ contract: contract() }));
    await h.refusedRead();
    await h.grant('worker');
    await h.reply(h1, true);
    expect(h.results.get(h1)).not.toMatch(REF);
    // A later grant notice of the PM's issues nothing either.
    h.setChoice({ permission: 'readwrite', lifetime: 'request' });
    await h.grant('pm');
    expect(h.pmNotices.join(' ')).not.toMatch(REF);
    expect(h.superseded(h1)).toEqual([]);
  });

  it('a ref is used once: the second dispatch with it is refused precisely, and nothing is recorded or started', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
    expect(h2).not.toBe('');
    const again = await h.dispatch({ resume_ref: ref });
    expect(again).toBe(`Error: resume_ref ${ref} cannot be used: it was already used. Dispatch the work without resume_ref, with `
      + 'its contract; the earlier task stays as it is. Nothing was recorded, and no teammate was started.');
    expect(h.assigned).toHaveLength(2);
    expect(h.ledger().snapshot()[0].delegations.map((row) => row.handle)).toEqual([h1, h2]);
    expect(h.ledger().snapshot()[0].refusedDispatches).toEqual([]);
  });

  const invalid: Array<[string, RegExp, (h: ReturnType<typeof host>, h1: string) => Promise<void> | void]> = [
    ['Stop pressed for the request', /the request was stopped/, (h) => h.refs.endRequest(REQUEST)],
    ['the grant revoked', /the file access it was issued for was revoked or has ended/, (h) => {
      for (const grant of h.owner.listPathAccess()) h.owner.revokePathAccess(grant.id);
    }],
    ['a dispatch in another request', /it belongs to another request/, (h) => h.setPmRequest('r2')],
    ['the task already replaced by other means', /task \S+ is already replaced or abandoned/, async (h, h1) => {
      const other = handleOf(await h.dispatch({ contract: contract() }));
      expect(await h.decide(h1, 'superseded', 'Replaced by hand.', other)).toMatch(/^Recorded/);
    }],
  ];
  for (const [name, reason, invalidate] of invalid) {
    it(`a ref is refused precisely after ${name}, and nothing is recorded or started`, async () => {
      const h = host();
      const h1 = await stoppedForAccess(h);
      await h.grant('pm');
      const ref = REF.exec(h.pmNotices[0])![1];
      await invalidate(h, h1);
      const before = { assigned: h.assigned.length, delegations: h.ledger().snapshot()[0].delegations.length,
        superseded: h.superseded(h1).length };
      const refused = await h.dispatch({ resume_ref: ref });
      expect(refused).toMatch(new RegExp(`^Error: resume_ref ${ref} cannot be used: ${reason.source}\\. Dispatch the work without resume_ref`));
      expect({ assigned: h.assigned.length, delegations: h.ledger().snapshot()[0].delegations.length,
        superseded: h.superseded(h1).length }).toEqual(before);
    });
  }

  it('a ref is refused for another coordinator', async () => {
    const h = host();
    await stoppedForAccess(h);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    const other = host({ refs: h.refs, ledger: h.ledger(), coordinator: 'pm2' });
    expect(await other.dispatch({ resume_ref: ref })).toMatch(/cannot be used: it was issued to another coordinator\./);
    expect(other.assigned).toHaveLength(0);
  });

  it('a predecessor with no stored contract gets no ref', async () => {
    const h = host();
    const ledger = h.ledger();
    // A task the ledger holds without a compiled contract: nothing to retry it with.
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'plain', agentId: DEV, requestedAgent: DEV,
      instruction: 'Do it.', originCorrelationId: h.rootMsg.id });
    const prepared = new TaskResumeRefs({
      openDelegationOf: (agentId) => ledger.activeDelegation('plain', agentId),
      grantsFor: (requestId) => h.owner.pathAccessFor(requestId),
      predecessor: (coordinatorId, handle) => ledger.resumePredecessor(coordinatorId, handle),
      currentRequestOf: () => REQUEST,
    });
    prepared.capture(DEV, REQUEST, h.source, 'read');
    ledger.recordDelegationEvidence({ handle: 'plain', agentId: DEV, outcome: 'no-evidence', evidence: {
      outcome: 'no-evidence', completionState: 'not-observed', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false, passed: false } } });
    expect(ledger.resumePredecessor('pm', 'plain')).toMatchObject({ state: 'settled', unfinished: true });
    await h.grant('pm');
    expect(prepared.issueAtGrant('pm', REQUEST)).toEqual({ lines: [], refs: [] });
    expect(prepared.atSettlement('pm', 'plain')).toBeUndefined();
  });

  it('after a reload a ref is void: refused precisely, nothing replayed, and the task and its decision are still there', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    // The recovery entry: the ledger read back from its stored records, and a fresh host with no refs in memory.
    const restored = h.reload();
    const fresh = host({ ledger: restored });
    expect(await fresh.dispatch({ resume_ref: ref })).toMatch(
      /cannot be used: the host did not issue it, or issued it before UnodeAi was reloaded\. Dispatch the work without resume_ref/);
    expect(fresh.assigned).toHaveLength(0);
    expect(restored.inspectTaskStatus('pm', [h1])[0]).toMatchObject({ handle: h1, disposition: { value: 'needs-human' } });
    expect(restored.snapshot().flatMap((run) => run.delegations).map((row) => row.handle)).toEqual([h1]);
  });
});

describe('v0.9.101 G3: a replacement recorded after the run closed', () => {
  /** G0 repro D: the old task left needs-human, a plain re-dispatch accepted, the run closed Partial, then the decision. */
  async function closedPartial(h: ReturnType<typeof host>, secondFinishes: boolean, close: 'task.complete' | 'task.partial' = 'task.complete') {
    const h1 = await stoppedForAccess(h);
    const h2 = handleOf(await h.dispatch({ contract: contract() }));
    await h.reply(h2, secondFinishes);
    expect(await h.decide(h2, 'accepted')).toMatch(/^Recorded/);
    h.closeWith(close);
    expect(h.job().completion).toBe('partial');
    return { h1, h2 };
  }

  it('turns Partial into Complete when the replacement finished its required work', async () => {
    const h = host();
    const { h1, h2 } = await closedPartial(h, true);
    expect(await h.decide(h1, 'superseded', 'Re-dispatched after access was granted.', h2)).toMatch(/^Recorded/);
    expect(h.job().completion).toBe('complete');
    expect(h.job().remaining.items).toEqual([]);
  });

  it('stays Partial when the replacement did not save its required output', async () => {
    const h = host();
    const { h1, h2 } = await closedPartial(h, false);
    expect(await h.decide(h1, 'superseded', 'Re-dispatched after access was granted.', h2)).toMatch(/^Recorded/);
    expect(h.job().completion).toBe('partial');
  });

  it('stays Partial when the closing reply itself was task.partial', async () => {
    const h = host();
    const { h1, h2 } = await closedPartial(h, true, 'task.partial');
    expect(await h.decide(h1, 'superseded', 'Re-dispatched after access was granted.', h2)).toMatch(/^Recorded/);
    expect(h.job().completion).toBe('partial');
  });

  it('a run stored before this release keeps its closeout', async () => {
    const h = host();
    const { h1, h2 } = await closedPartial(h, true);
    const stored = h.ledger().snapshot().map((run) => { const copy = { ...run }; delete copy.closingReplyPartial; return copy; });
    const old = new RunLedger(stored);
    old.recordDisposition({ handle: h1, agentId: DEV, disposition: 'superseded', reason: 'Late.', replacementHandle: h2,
      recordedAt: new Date().toISOString(), outcome: 'tool-activity-recorded' });
    expect(old.snapshot()[0].delegations.find((row) => row.handle === h1)!.dispositions.at(-1)?.disposition).toBe('superseded');
    expect(old.snapshot()[0].closeoutCompletionState).toBe('partial');
  });

  it('a replacement that is still running, or whose declared check did not run or failed, does not lift it', async () => {
    const h = host();
    const { h1 } = await closedPartial(h, true);
    const ledger = h.ledger();
    // A replacement in another run of this coordinator, still running.
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'late', agentId: DEV, requestedAgent: DEV,
      instruction: 'Again.', contract: h.delegation(h1).contract, originCorrelationId: 'another-thread' });
    expect(await h.decide(h1, 'superseded', 'Replaced.', 'late')).toMatch(/^Recorded/);
    expect(h.job().completion).toBe('partial');
    // It settles with its output, but the check it declared did not run.
    ledger.recordDelegationEvidence({ handle: 'late', agentId: DEV, outcome: 'tool-activity-recorded', evidence: {
      outcome: 'tool-activity-recorded', completionState: 'complete', changedFiles: ['output/summary.docx'], hadToolActions: true,
      unrecordedWrites: false, verification: { ran: false, passed: false }, verificationPlanStatus: 'not-run' } });
    expect(h.job().completion).toBe('partial');
    // Or it ran and failed.
    ledger.recordDelegationEvidence({ handle: 'late', agentId: DEV, outcome: 'verification-failed', evidence: {
      outcome: 'verification-failed', completionState: 'complete', changedFiles: ['output/summary.docx'], hadToolActions: true,
      unrecordedWrites: false, verification: { ran: true, passed: false }, verificationPlanStatus: 'failed' } });
    expect(h.job().completion).toBe('partial');
    // The same replacement with its check passed does.
    ledger.recordDelegationEvidence({ handle: 'late', agentId: DEV, outcome: 'verified', evidence: {
      outcome: 'verified', completionState: 'complete', changedFiles: ['output/summary.docx'], hadToolActions: true,
      unrecordedWrites: false, verification: { ran: true, passed: true }, verificationPlanStatus: 'satisfied' } });
    expect(h.job().completion).toBe('complete');
  });
});

/** A scripted model behind the real SessionManager: its turns are the texts the host sends it. */
class ScriptedBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void {}
  isAlive(): boolean { return this.alive; }
  readonly snapshotKind = 'openai-compat' as const;
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): boolean { return true; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

describe('v0.9.101 G3: the ref rides the grant notice the PM gets anyway', () => {
  it('a grant during the PM\'s turn: the scope-update turn carries the ref; a notice that reaches nobody takes its ref back', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    const bus = new MessageBus();
    const backends = new Map<string, ScriptedBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => { const made = new ScriptedBackend(config); backends.set(config.id, made); return made; },
      resolveEnv: async () => ({}),
    });
    mgr.create({ id: 'pm', name: 'pm', role: 'project-manager' as AgentConfig['role'], skill: '',
      provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'claude-sonnet-4-20250514', systemPrompt: '',
      autoApprove: true, allowedTools: [] });
    await mgr.start('pm', { pin: 'take' });
    const pm = backends.get('pm')!;
    pm.emit({ kind: 'ready' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Summarise the lease into output/.' });
    const grant = await h.owner.requestPathAccess(h.source, { requestId: REQUEST, isCurrent: () => true },
      async () => ({ permission: 'read', lifetime: 'request' }));
    expect(grant).toBeDefined();

    // Told for a request this agent is not in: nobody hears it, and its ref is void.
    const lost = h.refs.grantNotice('pm', REQUEST, BASE_NOTICE);
    const lostRef = REF.exec(lost.text)![1];
    mgr.tellFileAccessGrant('pm', 'another-request', lost.text, (report) => lost.report(report));
    expect(await h.dispatch({ resume_ref: lostRef })).toMatch(/cannot be used: its notice did not reach you\./);
    expect(h.superseded(h1)).toEqual([]);

    // The same preparation, issued again on the grant notice of the PM's own turn of this request.
    const request = mgr.currentRequestId('pm')!;
    const told = h.refs.grantNotice('pm', REQUEST, BASE_NOTICE);
    const ref = REF.exec(told.text)![1];
    expect(ref).not.toBe(lostRef);
    mgr.tellFileAccessGrant('pm', request, told.text, (report) => told.report(report));
    pm.emit({ kind: 'turn_complete', result: { text: 'Waiting for access.', isError: false } } as BackendEvent);
    await flush();
    expect(pm.turns).toHaveLength(2);
    expect(pm.turns[1]).toContain(`To retry it, call dispatch_task with resume_ref ${ref} and no contract`);
    const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
    expect(h.superseded(h1)).toEqual([expect.objectContaining({ replacementHandle: h2 })]);
  });
});

describe('v0.9.101 G3 audit: a retried contract, its output identity, an overlap and a teammate\'s grant', () => {
  // Audit R1b: the retry's contract identity is the compiler's, so the stored record restores it whole.
  it('a resume-ref retry keeps its stored contract, whole, across a reload', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
    const before = h.delegation(h2).contract!;
    expect(before.contractId).toMatch(/^contract-[0-9a-f-]{36}$/);
    const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
    const rows = restored.snapshot().flatMap((run) => run.delegations);
    expect(rows.find((row) => row.handle === h2)?.contract).toEqual(before);
    expect(rows.find((row) => row.handle === h1)?.contract).toEqual(h.delegation(h1).contract);
  });

  // Audit R5: a required outside output is met only by a write to that destination.
  for (const destination of ['workspace', 'outside'] as const) {
    it(`a required outside output written to the ${destination} file of its name: ${destination === 'workspace' ? 'stays Partial' : 'completes'}`, async () => {
      const h = host();
      const outsideOutput = path.join(path.dirname(h.source), 'report.txt');
      const required = { ...contract(), outputs: [{ output_id: 'report', path: outsideOutput, kind: 'file', required: true }] };
      const h1 = handleOf(await h.dispatch({ contract: required }));
      await h.refusedRead();
      await h.reply(h1, false);
      expect(await h.decide(h1, 'needs-human', 'The source was refused.')).toMatch(/^Recorded/);
      const h2 = handleOf(await h.dispatch({ contract: required }));
      // A real host write and the path it records, under a Read + Write grant for the outside folder.
      await h.owner.requestPathAccess(path.dirname(outsideOutput), { requestId: REQUEST, isCurrent: () => true },
        async () => ({ permission: 'readwrite', lifetime: 'request' }));
      const worker = new WorkspaceTools(h.root, new Set(['write']), DEV);
      worker.setLivePathAccess(() => h.owner.pathAccessFor(REQUEST));
      const saved = await worker.run('write_file', { path: destination === 'workspace' ? 'report.txt' : outsideOutput, content: 'REPORT' });
      expect(saved.status).toBe('success');
      h.bus.send(DEV, 'pm', 'task.complete', { instruction: 'Saved the report.', metadata: {
        delegationEvidence: { hadToolActions: true, changedFiles: [saved.path] } } }, 'normal', h2);
      await flush();
      expect(h.team.consumeAsyncResult(h2)).toBe(true);
      expect(await h.decide(h2, 'accepted')).toMatch(/^Recorded/);
      h.closeWith('task.complete');
      expect(await h.decide(h1, 'superseded', 'The second task replaces it.', h2)).toMatch(/^Recorded/);
      expect(existsSync(outsideOutput)).toBe(destination === 'outside');
      expect(h.job().completion).toBe(destination === 'workspace' ? 'partial' : 'complete');
    });
  }

  // Audit R7: an overlap queues the retry like any dispatch, and the ref is checked and spent when it starts.
  it('a retry whose files overlap work in flight is queued, starts when that work settles, replaces the task once and spends its ref once', async () => {
    const claims = new TaskClaimRegistry();
    const h = host({ claims });
    const scoped = () => ({ ...contract(), effects: { read_files: [], expected_file_effect: 'create',
      write_scope: { folder_access: [{ path: 'output', permission: 'readwrite' }] } } });
    const h1 = handleOf(await h.dispatch({ contract: scoped() }));
    await h.refusedRead();
    await h.reply(h1, false);
    expect(await h.decide(h1, 'needs-human', 'The source was refused.')).toMatch(/^Recorded/);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    expect(claims.claim('other-task', 'other-worker', ['output'], 'Another edit').ok).toBe(true);
    const queued = await h.dispatch({ resume_ref: ref });
    expect(queued).toMatch(new RegExp(`^Queued contract .*Handle: .*When it is admitted, task ${h1} is recorded as replaced by it\\.`, 's'));
    const h2 = handleOf(queued);
    expect(h.assigned).toHaveLength(1);
    expect(h.superseded(h1)).toEqual([]);
    claims.release('other-task');
    await flush();
    expect(h.assigned.map((message) => message.correlationId)).toEqual([h1, h2]);
    expect(h.superseded(h1)).toEqual([expect.objectContaining({ replacementHandle: h2 })]);
    expect(await h.dispatch({ resume_ref: ref })).toMatch(/cannot be used: it was already used\./);
    expect(h.superseded(h1)).toHaveLength(1);
  });

  it('a queued retry whose ref Stop voided before it started replaces nothing, and its handle reports why', async () => {
    const claims = new TaskClaimRegistry();
    const h = host({ claims });
    const scoped = () => ({ ...contract(), effects: { read_files: [], expected_file_effect: 'create',
      write_scope: { folder_access: [{ path: 'output', permission: 'readwrite' }] } } });
    const h1 = handleOf(await h.dispatch({ contract: scoped() }));
    await h.refusedRead();
    await h.reply(h1, false);
    await h.grant('pm');
    const ref = REF.exec(h.pmNotices[0])![1];
    expect(claims.claim('other-task', 'other-worker', ['output'], 'Another edit').ok).toBe(true);
    const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
    h.refs.endRequest(REQUEST);
    claims.release('other-task');
    await flush();
    expect(h.assigned).toHaveLength(1);
    expect(h.superseded(h1)).toEqual([]);
    expect(h.results.get(h2)).toMatch(/could not start\. Error: resume_ref \S+ cannot be used now: the request was stopped\./);
  });

  // v0.9.101 (H2a): the 'retry' Continue of audit R4 is removed. A grant on the worker's own item after it settled tells
  // the worker's item participants only, and offers no Continue: no notice of the PM carries a ref for it.
  it('a worker item granted after settlement offers no Continue and sends the PM nothing', async () => {
    const h = host();
    const h1 = await stoppedForAccess(h);
    await h.grant('worker');
    expect(h.workerItem()).toMatchObject({ state: 'granted' });
    expect(h.workerItem()!.continuation).toBeUndefined();
    expect(h.workerItem()!.continueRequest).toBeUndefined();
    expect([h.results.get(h1), ...h.pmNotices].join(' ')).not.toMatch(REF);
    expect(h.superseded(h1)).toEqual([]);
  });

  it('a worker item granted while its task still runs offers no Continue: the result carries the ref, as before', async () => {
    const h = host();
    const h1 = handleOf(await h.dispatch({ contract: contract() }));
    await h.refusedRead();
    await h.grant('worker');
    expect(h.workerItem()?.continuation).toBeUndefined();
    await h.reply(h1, false);
    expect(h.results.get(h1)).toMatch(REF);
    expect(h.pmNotices).toEqual([]);
  });

});

// Audit R5b (17b0a10b), Codex's flow: a relative required output written in the teammate's own worktree and really
// merged is the required output; comparing it under the coordinator's folder left the job Partial.
it('a required relative output written in the delegated worktree and really merged completes the retry', async () => {
  const { spawnSync } = await import('node:child_process');
  const { WorktreeManager } = await import('../../backend/WorktreeManager');
  const { GitMergeOrchestrator } = await import('../../backend/MergeOrchestrator');
  const { WorktreeCoordinator } = await import('../../backend/WorktreeCoordinator');
  const { readFileSync } = await import('node:fs');
  const h = host();
  const git = (args: string[]) => {
    const ran = spawnSync('git', args, { cwd: h.root, encoding: 'utf8' });
    expect(ran.status, ran.stderr).toBe(0);
  };
  git(['init','-q','-b','main']);
  git(['config','user.email','audit@example.invalid']);
  git(['config','user.name','Auditor fixture']);
  writeFileSync(path.join(h.root,'base.txt'),'BASE');
  git(['add','base.txt']);
  git(['commit','-q','-m','fixture base']);
  const coordinator = new WorktreeCoordinator({
    manager: new WorktreeManager(h.root), orchestrator: new GitMergeOrchestrator(h.root),
    isEnabled: () => true, autoMerge: () => false, maxParallel: () => 4,
    isEligible: () => true, log: () => {}, notifyAgent: () => {},
  });
  const lane = await coordinator.assignWorkingDirectory({ id: DEV, name: DEV, role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'K' }, model: 'm', systemPrompt: '', autoApprove: false, allowedTools: [] });
  expect(lane).toBeTruthy();
  h.setWorkerRoot(lane!);
  const required = { ...contract(), expected_deliverable: 'output/report.txt',
    outputs: [{ output_id: 'report', path: 'output/report.txt', kind: 'file', required: true }] };
  const h1 = handleOf(await h.dispatch({ contract: required }));
  await h.refusedRead();
  await h.reply(h1, false);
  await h.decide(h1, 'needs-human', 'The source was refused.');
  await h.grant('pm');
  const ref = REF.exec(h.pmNotices[0])![1];
  const h2 = handleOf(await h.dispatch({ resume_ref: ref }));
  const worker = new WorkspaceTools(lane!, new Set(['read','write']), DEV);
  worker.setLivePathAccess(() => h.owner.pathAccessFor(REQUEST));
  expect((await worker.run('read_file',{ path: h.source })).status).toBe('success');
  const saved = await worker.run('write_file',{ path: 'output/report.txt', content: 'COMPLETED REPORT' });
  expect(saved.status).toBe('success');
  await coordinator.onTurnComplete(DEV, false);
  expect((await coordinator.finalize()).status).toBe('merged');
  expect(readFileSync(path.join(h.root,'output/report.txt'),'utf8')).toBe('COMPLETED REPORT');
  h.bus.send(DEV,'pm','task.complete',{ instruction: 'Saved and merged the report.', metadata: {
    delegationEvidence: { hadToolActions: true, changedFiles: [saved.path] } } }, 'normal',h2);
  await flush();
  expect(h.team.consumeAsyncResult(h2)).toBe(true);
  expect(await h.decide(h2,'accepted')).toMatch(/^Recorded/);
  h.closeWith('task.complete');
  const restored = new RunLedger(JSON.parse(JSON.stringify(h.ledger().snapshot())));
  expect(restored.snapshot().flatMap(run => run.delegations).find(row => row.handle === h2)?.pathBases).toEqual(h.delegation(h2).pathBases);
  expect(h.job().completion).toBe('complete');
});
