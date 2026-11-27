import { describe, expect, it, vi } from 'vitest';
import { TeamTools, type TeamRosterEntry, type TeamToolsOptions, type TeamView, type TurnDelegationReceipt } from '../TeamTools';
import { hostAuthoredCloseout } from '../OpenAICompatBackend';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';
import { SessionManager } from '../../session/SessionManager';
import type { AgentBackend, BackendEventHandler } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { CliStartRefused, NO_PROGRAM_TEXT } from '../../host/cliRuntimeResolver';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import { PersistenceManager } from '../../state/PersistenceManager';
import { coordinatorTaskNeedsAttention } from '../../session/CoordinatorTurnSnapshot';
import { classifyPmTasks, pmStatusRelevant } from '../../session/PmTurnStatus';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));

/*
 * v0.9.106 retest R3 (finding C): the PM dispatched a review to a Codex teammate whose start was then refused (no Codex
 * CLI chosen). The refusal came back to the PM as the task's result, and the PM never recorded a decision on it. From
 * then on every PM reply, even of a later request whose own task was accepted, ended with "UnodeAi: No assignment close
 * was recorded; 1 delegation result still needs a decision.", and a `complete` close was refused for the same count.
 *
 * Now a task its teammate never took (a typed `startRefused` refusal) owes no decision once the refusal was given to
 * the PM. Nothing is decided for the PM: no disposition is recorded, the run ledger keeps the task as it was, and a
 * decision the PM records still counts. A real result still owes its decision, and the notice now names who owes one.
 *
 * The first describe uses tools that do not wait for admission (the eval harness's), where a refused start comes after
 * the dispatch was recorded. The extension's tools wait for admission; that case is the C-1 describe at the end.
 */

const roster: TeamRosterEntry[] = [
  { id: 'pm', role: 'pm', name: 'Project Manager', status: 'running' },
  { id: 'reviewer', role: 'reviewer', name: 'Codex Reviewer', status: 'idle' },
  { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' },
];

function contract(objective: string): Record<string, unknown> {
  return {
    version: 1,
    objective,
    expected_deliverable: 'A reply.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
  };
}

function harness(options: (ledger: RunLedger) => TeamToolsOptions = () => ({})) {
  const bus = new MessageBus();
  const ledger = new RunLedger();
  const view: TeamView = {
    list: () => roster,
    resolve: (ref) => {
      const found = roster.find((entry) => entry.id === ref || entry.name === ref);
      return found ? { id: found.id } : undefined;
    },
    preflightTaskScope: () => undefined,
  };
  const team = new TeamTools('pm', view, bus, {
    timeoutMs: 60_000,
    evidenceEnabled: true,
    cwd: process.cwd(),
    taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'root-turn' }),
    onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    ...options(ledger),
  });
  const recorded = (handle: string) => ledger.snapshot().flatMap((run) => run.delegations).find((row) => row.handle === handle);
  return { bus, ledger, team, recorded };
}

async function dispatch(team: TeamTools, agent: string, objective: string): Promise<string> {
  const out = await team.run('dispatch_task', { agent, instruction: objective, contract: contract(objective) });
  const handle = out.match(/Handle: ([0-9a-f-]+)/i)?.[1];
  if (!handle) throw new Error(`dispatch failed: ${out}`);
  return handle;
}

/** What SessionManager sends for each turn queued behind a start that was refused. */
function refuseStart(bus: MessageBus, from: string, handle: string, text = NO_PROGRAM_TEXT['codex-cli']): void {
  bus.send(from, 'pm', 'system.error', { instruction: text, metadata: { isError: true, startRefused: true } }, 'normal', handle);
}

function complete(bus: MessageBus, from: string, handle: string, text: string): void {
  bus.send(from, 'pm', 'task.complete', {
    instruction: text,
    metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false } } },
  }, 'normal', handle);
}

const OWED_REVIEW = 'UnodeAi: No assignment close was recorded; 1 delegation result still needs a decision '
  + '(Codex Reviewer: "Review add.js and report defects."). Review the timeline and decide whether to continue or retry.';

describe('v0.9.106 retest R3: a task whose teammate never started owes no decision once the PM was given it', () => {
  it('the R3 sequence: a refused start, then a later accepted task; the later reply carries no notice and complete closes', async () => {
    const { bus, team, recorded } = harness();
    const refused = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    refuseStart(bus, 'reviewer', refused);
    await vi.waitFor(() => expect(team.isAsyncResultReady(refused)).toBe(true));

    // Not given to the PM yet: it is owed, and the notice says which one.
    expect(team.coordinatorCloseoutState()).toMatchObject({
      settledButUndisposed: 1,
      undisposed: [{ agentName: 'Codex Reviewer', handle: refused, task: 'Review add.js and report defects.' }],
    });
    expect(hostAuthoredCloseout(team.coordinatorCloseoutState())).toBe(OWED_REVIEW);

    // The host's wake gives the refusal to the PM. Nothing is owed for it now; nothing was decided for the PM either.
    expect(team.consumeAsyncResult(refused)).toBe(true);
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, undisposed: [], recordedDispositionCount: 0 });
    expect(recorded(refused)).toMatchObject({ handle: refused, agentId: 'reviewer', evidence: { outcome: 'no-evidence' } });
    expect(recorded(refused)?.dispositions ?? []).toEqual([]);

    // A later request: its own task comes back and the PM accepts it. That reply ends with no host notice.
    const later = await dispatch(team, 'dev', 'Fix the defect in add.js.');
    complete(bus, 'dev', later, 'Fixed.');
    await vi.waitFor(() => expect(team.isAsyncResultReady(later)).toBe(true));
    expect(team.consumeAsyncResult(later)).toBe(true);
    expect(await team.run('record_task_disposition', { handle: later, disposition: 'accepted' })).not.toMatch(/^Error/);
    const state = team.coordinatorCloseoutState();
    expect(state).toMatchObject({ settledButUndisposed: 0, recordedDispositionCount: 1 });
    expect(hostAuthoredCloseout(state)).toBe('');
    expect(await team.run('close_assignment', { outcome: 'complete', summary: 'add.js fixed.' })).toMatch(/^Recorded: assignment closed as complete/);
  });

  it('through a real SessionManager: the refused start of the teammate is what marks the task', async () => {
    const { bus, team } = harness();
    const manager = new SessionManager(5, bus, {
      createBackend: (agent) => new RefusingBackend(agent.id, new CliStartRefused('program-not-chosen', NO_PROGRAM_TEXT['codex-cli'])),
      resolveEnv: async () => ({}),
    });
    manager.create(agentConfig('reviewer', 'Codex Reviewer'));
    const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    await vi.waitFor(() => expect(team.isAsyncResultReady(handle)).toBe(true));
    expect(hostAuthoredCloseout(team.coordinatorCloseoutState())).toBe(OWED_REVIEW);
    expect(team.consumeAsyncResult(handle)).toBe(true);
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, assignmentOpen: true });
    // Its own request still says no result was recorded; it does not claim a decision is owed.
    expect(hostAuthoredCloseout(team.coordinatorCloseoutState()))
      .toBe('UnodeAi: No assignment close was recorded; no delegation result was recorded. Review the timeline and decide whether to continue or retry.');
  });

  it('a decision the PM records on the refused task still counts', async () => {
    const { bus, team, recorded } = harness();
    const refused = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    refuseStart(bus, 'reviewer', refused);
    await vi.waitFor(() => expect(team.isAsyncResultReady(refused)).toBe(true));
    expect(team.consumeAsyncResult(refused)).toBe(true);
    expect(await team.run('record_task_disposition', { handle: refused, disposition: 'rejected', reason: 'It never started.' }))
      .not.toMatch(/^Error/);
    expect(team.coordinatorCloseoutState()).toMatchObject({
      settledButUndisposed: 0, recordedDispositionCount: 1, latestDispositions: [{ agentName: 'Codex Reviewer', disposition: 'rejected' }],
    });
    expect(recorded(refused)?.dispositions?.map((event) => event.disposition)).toEqual(['rejected']);
  });
});

describe('v0.9.106: a real result still owes its decision, and the PM and the person are told which', () => {
  it('a reply the PM was given and did not decide is still owed; the notice and the refused complete close name it', async () => {
    const { bus, team } = harness();
    const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    complete(bus, 'reviewer', handle, 'No defect found.');
    await vi.waitFor(() => expect(team.isAsyncResultReady(handle)).toBe(true));
    expect(team.consumeAsyncResult(handle)).toBe(true);
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 1 });
    expect(hostAuthoredCloseout(team.coordinatorCloseoutState())).toBe(OWED_REVIEW);
    expect(await team.run('close_assignment', { outcome: 'complete', summary: 'Reviewed.' })).toBe(
      `Error: 1 settled delegation(s) still have no disposition: Codex Reviewer (handle ${handle}). `
      + 'Record those first, or close as partial and say what is unresolved.');
  });

  it('an error after the teammate took the task is a result, and is still owed', async () => {
    const { bus, team } = harness();
    const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    bus.send('reviewer', 'pm', 'system.error', { instruction: 'The model returned an error.', metadata: { isError: true } }, 'normal', handle);
    await vi.waitFor(() => expect(team.isAsyncResultReady(handle)).toBe(true));
    expect(team.consumeAsyncResult(handle)).toBe(true);
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 1, undisposed: [{ agentName: 'Codex Reviewer', handle }] });
  });

  it('names at most three and counts the rest', () => {
    expect(hostAuthoredCloseout({
      settledButUndisposed: 5,
      recordedDispositionCount: 0,
      undisposed: [
        { agentName: 'A', task: 'One' }, { agentName: 'B' }, { agentName: 'C', task: 'Three' }, { agentName: 'D' }, { agentName: 'E' },
      ],
    })).toBe('UnodeAi: No assignment close was recorded; 5 delegation results still need a decision '
      + '(A: "One", B, C: "Three", and 2 more). Review the timeline and decide whether to continue or retry.');
  });
});

function agentConfig(id: string, name: string): AgentConfig {
  return {
    id, name, role: 'reviewer', skill: '',
    provider: { providerId: 'codex-cli', apiKeySecretName: '' },
    model: 'codex-cli-default', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'codex',
  } as AgentConfig;
}

class RefusingBackend implements AgentBackend {
  private handler: BackendEventHandler | undefined;
  constructor(readonly agentId: string, private readonly refusal: Error, private readonly beforeRefusal?: Promise<void>) {}
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { if (this.beforeRefusal) await this.beforeRefusal; throw this.refusal; }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return false; }
}

/*
 * Codex's audit of 4cc9cfd9 (C-1): production waits for the teammate to take the task (`waitForTaskAdmission`), records
 * the delegation only then, and delivers a result only under the identity that record reserves. A start refused before
 * that left a settled result nobody could deliver, owed forever. With the same gating as the host's
 * (OrchestrationHostAdapter), the refused start now ends the dispatch as a refused dispatch, as a policy refusal before
 * admission does: recorded with its reason for the coordinator's next turn, never a result that owes a decision.
 */
describe('v0.9.106 (C-1): with production admission, a start refused before admission is a refused dispatch', () => {
  const gated = (receipts: TurnDelegationReceipt[]) => (ledger: RunLedger): TeamToolsOptions => ({
    waitForTaskAdmission: true,
    resultRevisionFor: (handle) => ledger.resultIdentity('pm', handle)?.ref.revision,
    isAsyncResultEligible: (_handle, revision) => revision !== undefined,
    onTurnDelegationReceiptChanged: (receipt) => receipts.push(receipt),
    onDelegationRefused: (event) => ledger.recordRefusedDispatch({ ...event, originCorrelationId: event.originCorrelationId ?? 'root-turn' }),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
  });

  it('v0.9.107 C: a real CLI start refusal remains inspectable after the reply and save/reload, without a decision', async () => {
    const { bus, team, ledger } = harness(gated([]));
    let releaseStart!: () => void;
    const beforeRefusal = new Promise<void>((resolve) => { releaseStart = resolve; });
    const manager = new SessionManager(5, bus, {
      createBackend: (agent) => new RefusingBackend(agent.id, new CliStartRefused('program-not-chosen', NO_PROGRAM_TEXT['codex-cli']), beforeRefusal),
      resolveEnv: async () => ({}),
    });
    manager.create(agentConfig('reviewer', 'Codex Reviewer'));
    const observeReply = bus.onType('task.complete', (message) => {
      if (message.from === 'pm' && message.to === 'user') ledger.observeMessage(message);
    });
    try {
      const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
      bus.send('pm', 'user', 'task.complete', { instruction: 'Dispatched the review.' }, 'normal', 'root-turn');
      releaseStart();
      await vi.waitFor(() => expect(ledger.snapshot()).toHaveLength(1));
      const [run] = ledger.snapshot();
      expect(run).toMatchObject({ delegations: [], closeoutCompletionState: 'partial' });
      expect(run.refusedDispatches).toEqual([expect.objectContaining({ handle, taskState: 'not-started' })]);
      const refusal = run.refusedDispatches[0];
      const expected = {
        handle, runId: run.id, requestedAgent: 'reviewer', lifecycle: 'not-started' as const,
        terminalAt: refusal.recordedAt, refusalReason: refusal.reason,
      };
      expect(ledger.inspectTaskStatus('pm', [handle])).toEqual([expected]);
      expect(ledger.inspectTaskStatus('pm')).toEqual([expected]);

      const values = new Map<string, unknown>();
      const memento = {
        get: <T>(key: string, fallback?: T) => values.has(key) ? structuredClone(values.get(key)) as T : fallback,
        update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        keys: () => [...values.keys()],
      };
      const store = new PersistenceManager({ workspaceState: memento } as never, undefined, () => process.cwd());
      await store.saveRuns(ledger.snapshot());
      const restored = new RunLedger(await store.loadRuns());
      restored.snapshotForPersistence(await store.loadRuns());
      const restoredTeam = new TeamTools('pm', { list: () => roster, resolve: () => undefined }, bus, {
        inspectTaskStatus: (handles) => restored.inspectTaskStatus('pm', handles),
      });
      try {
        expect(restored.inspectTaskStatus('pm', [handle])).toEqual([expected]);
        expect(restored.inspectTaskStatus('pm')).toEqual([expected]);
        expect(restored.inspectTaskStatus('another-pm', [handle])).toEqual([{ handle, lifecycle: 'unknown' }]);
        expect(restored.inspectTaskStatus('another-pm')).toEqual([]);
        expect(restored.inspectTaskStatus('pm', ['missing'])).toEqual([{ handle: 'missing', lifecycle: 'unknown' }]);
        for (const tools of [team, restoredTeam]) {
          const byHandle = await tools.run('inspect_task_status', { handles: [handle] });
          const listed = await tools.run('inspect_task_status', {});
          for (const text of [byHandle, listed]) {
            expect(text).toContain('state: not-started');
            expect(text).toContain(`reason: ${refusal.reason}`);
            expect(text).toContain('result state: none');
            expect(text).not.toMatch(/^state: unknown$/m);
            expect(text).not.toContain('policy:');
          }
        }
        expect(restored.inspectTaskStatusWhere('pm', () => true)).toEqual([]);
        expect(pmStatusRelevant(expected)).toBe(false);
        expect(coordinatorTaskNeedsAttention(expected)).toBe(false);
        expect(classifyPmTasks([expected])).toEqual({ running: [], uncertain: [], human: [], undisposed: [], awaitingRework: [] });
        expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, recordedDispositionCount: 0 });
        expect(restoredTeam.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, recordedDispositionCount: 0 });
        expect(restored.snapshot()).toEqual(ledger.snapshot());
      } finally {
        restoredTeam.cancelPending('test cleanup');
      }
    } finally {
      releaseStart();
      observeReply();
      team.cancelPending('test cleanup');
      manager.dispose();
      bus.dispose();
    }
  });

  it('v0.9.107 C: policy refusal status keeps its policy fields and creates no PM attention', async () => {
    const { bus, team, ledger } = harness(gated([]));
    try {
      ledger.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'policy-handle', requestedAgent: 'reviewer',
        taskState: 'policy-refused', policyId: 'different-reported-model', reason: 'Same reported model.',
        originCorrelationId: 'root-turn', recordedAt: '2026-11-18T00:00:00.000Z' });
      const rows = ledger.inspectTaskStatus('pm');
      expect(rows).toEqual(ledger.inspectTaskStatus('pm', ['policy-handle']));
      expect(rows).toEqual([{
        handle: 'policy-handle', runId: ledger.snapshot()[0].id, requestedAgent: 'reviewer',
        lifecycle: 'policy-refused', terminalAt: '2026-11-18T00:00:00.000Z',
        policyId: 'different-reported-model', policyReason: 'Same reported model.',
      }]);
      expect(await team.run('inspect_task_status', {})).toContain('policy: different-reported-model\nreason: Same reported model.');
      expect(ledger.inspectTaskStatusWhere('pm', () => true)).toEqual([]);
      expect(rows.filter(pmStatusRelevant)).toEqual([]);
      expect(rows.filter(coordinatorTaskNeedsAttention)).toEqual([]);
      expect(classifyPmTasks(rows)).toEqual({ running: [], uncertain: [], human: [], undisposed: [], awaitingRework: [] });
    } finally {
      team.cancelPending('test cleanup');
      bus.dispose();
    }
  });

  it('records the refusal with its reason, records no delegation, owes no decision, and lets complete close', async () => {
    const { bus, team, ledger, recorded } = harness(gated([]));
    const from = new Date(Date.now() - 1_000).toISOString();
    const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    refuseStart(bus, 'reviewer', handle);
    await vi.waitFor(() => expect(ledger.dispatchOutcomesBetween('pm', from, new Date(Date.now() + 1_000).toISOString(), 'root-turn').refused)
      .toEqual([{ requestedAgent: 'reviewer', reason: `It did not start, so it never took this task. ${NO_PROGRAM_TEXT['codex-cli']}` }]));
    expect(recorded(handle)).toBeUndefined();
    // A late admission of the same task records nothing.
    bus.send('reviewer', 'pm', 'task.admitted', {}, 'normal', handle);
    expect(recorded(handle)).toBeUndefined();
    await vi.waitFor(() => expect(team.coordinatorCloseoutState().hasLiveDelegationWork).toBe(false));
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, undisposed: [], recordedDispositionCount: 0 });
    expect(await team.run('inspect_task_status', { handles: [handle] })).toContain(
      'state: ended before it started (reviewer did not take it up; the error it reported says why). Dispatch it again once that is fixed.');
    expect(await team.run('close_assignment', { outcome: 'complete', summary: 'Nothing else was asked.' })).toMatch(/^Recorded: assignment closed as complete/);
  });

  it('an error of an admitted task is unchanged: recorded at admission, still owed', async () => {
    const { bus, team, recorded } = harness(gated([]));
    const handle = await dispatch(team, 'reviewer', 'Review add.js and report defects.');
    bus.send('reviewer', 'pm', 'task.admitted', {}, 'normal', handle);
    expect(recorded(handle)).toBeDefined();
    bus.send('reviewer', 'pm', 'system.error', { instruction: 'The model returned an error.', metadata: { isError: true } }, 'normal', handle);
    await vi.waitFor(() => expect(team.isAsyncResultReady(handle)).toBe(true));
    expect(team.consumeAsyncResult(handle)).toBe(true);
    expect(team.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 1, undisposed: [{ agentName: 'Codex Reviewer', handle }] });
  });
});
