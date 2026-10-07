import { describe, expect, it } from 'vitest';
import type { DelegationEvidenceRecord } from '../../backend/TeamTools';
import type { Message } from '../../types';
import { TurnOutcomeAccumulator } from '../../session/turnOutcomeReceipt';
import type { TurnTiming, TurnTimingPhases } from '../../session/TurnTiming';
import { RunLedger, type RunRecord } from '../RunLedger';
import {
  JOB_OUTCOME_SECTIONS,
  jobContinuationRequest,
  jobOutcomeId,
  jobOutcomeView,
  projectJobOutcome,
  renderJobOutcomeMarkdown,
  type JobOutcomeProjectionV1,
  type JobUsageLookup,
  type JobUsageUnitFacts,
} from '../JobOutcome';

const at = (second: number): string => new Date(Date.UTC(2026, 9, 4, 10, 0, second)).toISOString();

const PHASES: TurnTimingPhases = {
  queuedMs: 0, hostMs: 1_000, providerWaitMs: 10_000, reasoningMs: 2_000, respondingMs: 3_000, toolMs: 4_000,
  providerWaitCount: 2, longestProviderWaitMs: 7_000,
};

function timing(startSecond: number): TurnTiming & { phases: TurnTimingPhases } {
  return { startedAt: at(startSecond), settledAt: at(startSecond + 20), durationMs: 20_000, approvalWaitMs: 0, phases: { ...PHASES } };
}

const VERIFIED: DelegationEvidenceRecord = {
  outcome: 'verified',
  completionState: 'complete',
  changedFiles: ['src/feature.ts'],
  hadToolActions: true,
  verification: { ran: true, passed: true },
  unrecordedWrites: false,
  verificationPlan: { sensors: ['run-checks'], noneApplies: 'report-no-applicable-sensor' },
  verificationPlanStatus: 'satisfied',
  verificationSensors: [{ kind: 'run-checks', status: 'passed' }],
};

const settled = (unit: Partial<JobUsageUnitFacts> = {}): JobUsageUnitFacts => ({
  state: 'settled', quarantined: false, unattributed: false,
  rows: [{ displayClass: 'exact-route', inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200, nanoUsd: '710000000' }],
  ...unit,
});

const usageOf = (units: Record<string, JobUsageUnitFacts>): JobUsageLookup => (id) => units[id];

interface Fixture {
  evidence?: DelegationEvidenceRecord | null;
  openingTurnId?: string | null;
  closingType?: 'task.complete' | 'task.partial';
  closingText?: string;
  pmTurn?: boolean;
  workerTurn?: boolean;
  write?: boolean;
  receipt?: (accumulator: TurnOutcomeAccumulator) => void;
  before?: (ledger: RunLedger, runId: string) => void;
}

/** One coordinated run through the ledger's own entry points: a dispatch, a result, both turns and a closing reply. */
function closedRun(fixture: Fixture = {}): RunRecord {
  const ledger = new RunLedger();
  const runId = ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review the modules.',
    originCorrelationId: 'origin-1', dispatchedAt: at(10),
    ...(fixture.openingTurnId === null ? {} : { originTurnId: fixture.openingTurnId ?? 'turn-pm' }),
  });
  if (fixture.write !== false) {
    ledger.recordFileChange({ agentId: 'arch', correlationId: 'h-1', path: 'src/feature.ts', before: 'a', after: 'b' });
  }
  fixture.before?.(ledger, runId);
  if (fixture.evidence !== null) {
    const evidence = fixture.evidence ?? VERIFIED;
    ledger.recordDelegationEvidence({ handle: 'h-1', agentId: 'arch', outcome: evidence.outcome, evidence });
  }
  if (fixture.workerTurn !== false) {
    ledger.recordTurn('arch', { turnId: 'turn-arch', correlationId: 'h-1', runId, usageUnitId: 'unit-arch', ended: 'completed', timing: timing(11) });
  }
  if (fixture.pmTurn !== false) {
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'origin-1', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(0) });
  }
  const accumulator = new TurnOutcomeAccumulator();
  fixture.receipt?.(accumulator);
  const closing: Message = {
    id: 'closing-reply', correlationId: 'origin-1', from: 'pm', to: 'user', type: fixture.closingType ?? 'task.complete',
    priority: 'normal', timestamp: at(40),
    payload: {
      instruction: fixture.closingText ?? 'Done.',
      metadata: {
        turnId: 'turn-pm',
        ...(fixture.receipt ? {
          turnOutcome: accumulator.finish({ turnId: 'turn-pm', agentId: 'pm', correlationId: 'origin-1', runId, recordedAt: at(40), delivery: { kind: 'reply' } }),
        } : {}),
      },
    },
  };
  ledger.observeMessage(closing);
  return ledger.get(runId)!;
}

function project(run: RunRecord, units: Record<string, JobUsageUnitFacts> = { 'unit-pm': settled(), 'unit-arch': settled() }): JobOutcomeProjectionV1 {
  const outcome = projectJobOutcome(run.id, run, usageOf(units));
  if (outcome.state !== 'available') throw new Error(`expected an available outcome, got ${outcome.reason}`);
  return outcome;
}

describe('projectJobOutcome', () => {
  it('has no outcome for a run that is not held or not closed, and says which', () => {
    const run = closedRun();
    expect(projectJobOutcome('gone', undefined, usageOf({}))).toEqual({
      schemaVersion: 1, state: 'unavailable', id: 'outcome:gone', runId: 'gone', reason: 'run-not-retained',
    });
    const open = { ...run, status: 'open' as const };
    expect(projectJobOutcome(run.id, open, usageOf({}))).toMatchObject({ state: 'unavailable', reason: 'run-not-closed' });
    const view = jobOutcomeView(projectJobOutcome('gone', undefined, usageOf({})));
    expect(view.available).toBe(false);
    expect(view.headline.map((segment) => segment.text)).toEqual(['Outcome evidence unavailable']);
    // No derived figure survives an unavailable run.
    expect(JSON.stringify(view)).not.toMatch(/\d+ file|checks passed|\$/);
    expect(view.actions).toEqual([]);
  });

  it('projects a complete, verified run from stored facts alone', () => {
    const run = closedRun();
    const outcome = project(run);
    expect(outcome).toMatchObject({
      id: jobOutcomeId(run.id), lifecycle: 'closed', completion: 'complete', humanVerdict: 'unjudged',
      work: { logicalTasks: 1, attempts: 1, retryChains: 0, settled: 1, unfinished: 0, coverage: 'complete' },
      verification: { state: 'verified', checks: { planned: 1, passed: 1, failed: 0, notRun: 0 }, coverage: 'complete' },
      changes: { coverage: 'complete', fileCount: 1, files: ['src/feature.ts'], unrecordedWrites: false },
      remaining: { state: 'none', items: [] },
      approvals: { total: 0 },
    });
    expect(outcome.closeoutBasis).toBeUndefined();
    expect(outcome.usage).toMatchObject({
      state: 'recorded', coverage: 'complete', turns: 2, unitsSettled: 2,
      tokens: { input: 2_000, cachedInput: 800, output: 400 },
      cost: { state: 'single-basis', displayClass: 'exact-route', nanoUsd: '1420000000' },
    });
    expect(outcome.timing).toMatchObject({
      clock: {
        requestAcceptedAt: { state: 'recorded', at: at(0) }, firstDispatchAt: { state: 'recorded', at: at(10) },
        recordOpenedAt: at(10), closedAt: at(40),
      },
      elapsedMs: 40_000, elapsedBasis: 'since-request', timeToFirstDispatchMs: { state: 'recorded', ms: 10_000 },
      phases: { state: 'recorded', coverage: 'complete', turns: 2, dominant: 'provider-wait' },
    });
    const view = jobOutcomeView(outcome);
    expect(view.headline.map((segment) => segment.text)).toEqual([
      'Complete', 'Verified', '1 file changed', '1/1 checks passed', '$1.42 estimated', '40s',
    ]);
    // Nothing is left over, so the line names no unfinished task.
    expect(view.headline.some((segment) => segment.text.includes('unfinished'))).toBe(false);
    expect(view.sections.map((section) => section.title)).toEqual([...JOB_OUTCOME_SECTIONS]);
  });

  it('never reads Verified out of prose: a reply and a task that say the tests pass change nothing', () => {
    const prose: DelegationEvidenceRecord = {
      outcome: 'replied-not-verified', completionState: 'complete', changedFiles: [], hadToolActions: false,
      verification: { ran: false, passed: false }, unrecordedWrites: false,
    };
    const run = closedRun({ evidence: prose, closingText: 'All tests pass. Verified. 12 files changed. Cost $0.00.', write: false });
    const outcome = project(run);
    expect(outcome.verification.state).toBe('not-run');
    expect(outcome.verification.checks).toEqual({ planned: 0, passed: 0, failed: 0, notRun: 0 });
    expect(outcome.changes.fileCount).toBe(0);
    const text = jobOutcomeView(outcome).headline.map((segment) => segment.text);
    expect(text).toContain('Checks not run');
    expect(text).not.toContain('Verified');
  });

  it('keeps a complete run complete when a tool failed on the way, and names the failure', () => {
    const run = closedRun({
      receipt: (accumulator) => {
        accumulator.use('call-1');
        accumulator.result('call-1', { status: 'failed', observedBy: 'host', failureKind: 'error' });
        accumulator.use('call-2');
        accumulator.result('call-2', { status: 'success', observedBy: 'host' });
      },
    });
    const outcome = project(run);
    expect(outcome.completion).toBe('complete');
    expect(outcome.verification.state).toBe('verified');
    expect(outcome.tools).toMatchObject({ total: 2, success: 1, failed: 1, failureKinds: [{ kind: 'error', count: 1 }] });
    // The worker's turn published no receipt in this fixture, so the count is not presented as the whole job's.
    expect(outcome.tools.coverage).toBe('partial');
  });

  it('says tool outcomes were not recorded when the run has no receipt, never zero tools', () => {
    const outcome = project(closedRun());
    expect(outcome.tools).toMatchObject({ coverage: 'not-recorded', turns: 0, total: 0 });
  });

  it('joins usage through the turn entries, so the coordinator turn that opened the run is counted', () => {
    // A selection by run id would miss this unit: it began before the run existed.
    const outcome = project(closedRun(), { 'unit-pm': settled(), 'unit-arch': settled() });
    expect(outcome.usage).toMatchObject({ state: 'recorded', turns: 2, unitsSettled: 2 });
  });

  it('reports usage as partial when a turn has no settled unit, and as not recorded without turn entries', () => {
    const missing = project(closedRun(), { 'unit-arch': settled() });
    expect(missing.usage).toMatchObject({ state: 'recorded', coverage: 'partial', unitsSettled: 1 });
    const gap = project(closedRun(), { 'unit-pm': settled({ state: 'gap', rows: [] }), 'unit-arch': settled() });
    expect(gap.usage).toMatchObject({ coverage: 'partial' });
    const unattributed = project(closedRun(), { 'unit-pm': settled({ unattributed: true }), 'unit-arch': settled() });
    expect(unattributed.usage).toMatchObject({ coverage: 'partial' });
    // The note says which kind of partial it is, and never "2 of 2 ... the rest is missing".
    const usageNote = (outcome: JobOutcomeProjectionV1) => jobOutcomeView(outcome).sections.find((section) => section.title === 'Usage')!.note!;
    expect(usageNote(missing)).toContain('known for 1 of 2 recorded turn(s); the rest is missing');
    expect(usageNote(unattributed)).toContain('known for all 2 recorded turn(s), but it cannot be shown to be the whole job\'s');
    expect(usageNote(unattributed)).not.toContain('the rest is missing');
    const none = project(closedRun({ pmTurn: false, workerTurn: false }));
    expect(none.usage).toEqual({ state: 'not-recorded' });
    expect(jobOutcomeView(none).headline.map((segment) => segment.text)).toContain('usage not recorded');
    const noWorkerTurn = project(closedRun({ workerTurn: false }));
    expect(noWorkerTurn.usage).toMatchObject({ state: 'recorded', coverage: 'partial' });
  });

  it('never adds different cost bases into one amount, and never shows a missing price as zero', () => {
    const mixed = project(closedRun(), {
      'unit-pm': settled({ rows: [{ displayClass: 'billed', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, nanoUsd: '500000000' }] }),
      'unit-arch': settled(),
    });
    expect(mixed.usage).toMatchObject({ cost: { state: 'mixed-basis' } });
    const mixedView = jobOutcomeView(mixed);
    expect(mixedView.headline.map((segment) => segment.text)).toContain('cost on mixed basis');
    expect(mixedView.headline.some((segment) => segment.text.includes('$'))).toBe(false);
    const unpriced = project(closedRun(), {
      'unit-pm': settled({ rows: [{ displayClass: 'unavailable', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }] }),
      'unit-arch': settled({ rows: [{ displayClass: 'unavailable', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }] }),
    });
    expect(unpriced.usage).toMatchObject({ cost: { state: 'unavailable' }, tokens: { input: 20, output: 10 } });
    const unpricedView = jobOutcomeView(unpriced);
    expect(unpricedView.headline.map((segment) => segment.text)).toContain('cost unavailable');
    expect(JSON.stringify(unpricedView)).not.toContain('$0');
    // One basis, part of it without a price: no amount at all, because a part-sum would read as the whole.
    const partPriced = project(closedRun(), {
      'unit-pm': settled(),
      'unit-arch': settled({ rows: [{ displayClass: 'exact-route', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }] }),
    });
    expect(partPriced.usage).toMatchObject({ cost: { state: 'unavailable' }, rows: [{ displayClass: 'exact-route', tokens: 1_215 }] });
    expect((partPriced.usage as { rows: Array<{ nanoUsd?: string }> }).rows[0].nanoUsd).toBeUndefined();
  });

  it('reports a usage conflict when two turns name one unit or a unit is quarantined', () => {
    const shared = closedRun({
      before: (ledger, runId) => {
        ledger.recordTurn('pm', { turnId: 'turn-mid', correlationId: 'origin-1', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(2) });
      },
    });
    expect(project(shared).usage).toMatchObject({ coverage: 'conflict' });
    const quarantined = project(closedRun(), { 'unit-pm': settled({ quarantined: true }), 'unit-arch': settled() });
    expect(quarantined.usage).toMatchObject({ coverage: 'conflict' });
  });

  it('measures from the first dispatch, and says so, when the opening turn is not recorded', () => {
    const outcome = project(closedRun({ openingTurnId: null }));
    expect(outcome.timing).toMatchObject({
      clock: { requestAcceptedAt: { state: 'not-recorded' } },
      elapsedMs: 30_000, elapsedBasis: 'since-first-dispatch', timeToFirstDispatchMs: { state: 'not-recorded' },
    });
    expect(jobOutcomeView(outcome).headline.at(-1)?.text).toBe('30s since first dispatch');
    // Without the opening turn the turn set cannot be proved whole, so no dominant phase is named.
    expect(outcome.timing.phases).toMatchObject({ state: 'recorded', coverage: 'partial' });
    expect((outcome.timing.phases as { dominant?: string }).dominant).toBeUndefined();
  });

  it('adds agent-turn phases over the turns and keeps them apart from the wall clock', () => {
    const outcome = project(closedRun());
    expect(outcome.timing.phases).toMatchObject({
      state: 'recorded',
      totals: { providerWaitMs: 20_000, toolMs: 8_000, providerWaitCount: 4, longestProviderWaitMs: 7_000 },
    });
    const timingSection = jobOutcomeView(outcome).sections.find((section) => section.title === 'Timing')!;
    expect(timingSection.note).toContain('can exceed the elapsed time');
    expect(timingSection.rows.find((row) => row.label === 'Longest provider wait')?.value).toBe('7s');
  });

  it('counts a host retry as one task, and leaves a run without recorded retry links ungrouped', () => {
    const retried = closedRun({
      before: (ledger) => {
        ledger.recordDelegationDispatched({
          coordinatorId: 'pm', handle: 'h-2', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review the modules.',
          originCorrelationId: 'origin-1', dispatchedAt: at(15), retryOfHandle: 'h-1', retryStage: 'firm-retry',
        });
        ledger.recordDelegationEvidence({ handle: 'h-2', agentId: 'arch', outcome: 'verified', evidence: VERIFIED });
      },
    });
    expect(project(retried).work).toMatchObject({ logicalTasks: 1, attempts: 2, retryChains: 1, settled: 1, coverage: 'complete' });
    const legacy = structuredClone(retried);
    delete legacy.retryTopology;
    for (const delegation of legacy.delegations) {
      delete delegation.retryOfHandle;
      delete delegation.retryStage;
    }
    expect(project(legacy).work).toMatchObject({ logicalTasks: 2, attempts: 2, retryChains: 0, coverage: 'not-recorded' });
  });

  it('lists interrupted work as remaining and offers a new request for it, not a resume', () => {
    const run = closedRun({
      evidence: null,
      closingType: 'task.partial',
      before: (ledger) => {
        ledger.recordDelegationInterrupted({
          coordinatorId: 'pm', handle: 'h-1', agentId: 'arch', reason: 'worker-lost', lastObservedAt: at(12), detectedAt: at(13),
        });
      },
    });
    const outcome = project(run);
    expect(outcome.completion).toBe('partial');
    expect(outcome.work).toMatchObject({ interrupted: 1, unfinished: 1 });
    expect(outcome.remaining).toMatchObject({ state: 'some', items: [{ handle: 'h-1', reason: 'interrupted' }], closeoutPartial: false });
    expect(outcome.verification).toMatchObject({ state: 'coverage-incomplete', coverage: 'partial' });
    const view = jobOutcomeView(outcome, { agentName: (id) => (id === 'arch' ? 'System Architect' : undefined) });
    expect(view.sections.find((section) => section.title === 'Remaining')?.items).toEqual(['System Architect: interrupted before a result']);
    expect(view.actions.map((action) => action.id)).toContain('continueUnfinished');
    expect(view.headline[0]).toEqual({ text: 'Partial', tone: 'caution' });
    expect(view.headline.map((segment) => segment.text)).toContain('1 task unfinished');
  });

  it('shows a job the host ended at a stop: partial, the stopped task left over, the time measured to the stop', () => {
    const ledger = new RunLedger([], { activeTurnId: () => undefined });
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review the modules.',
      originCorrelationId: 'origin-1', dispatchedAt: at(10), originTurnId: 'turn-pm',
    });
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'origin-1', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(0) });
    ledger.observeMessage({
      id: 'dispatch-reply', correlationId: 'origin-1', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      timestamp: at(20), payload: { instruction: 'Dispatched. I will report back.', metadata: { turnId: 'turn-pm' } },
    });
    // The person stops the only task while the coordinator is idle. Nobody answers anything afterwards.
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-1', agentId: 'arch', reason: 'Stopped by user.', cancelledAt: at(25) });
    const run = ledger.get(runId)!;
    expect(run).toMatchObject({ status: 'closed', closingTurnId: 'turn-pm', endedAt: at(25) });
    const outcome = project(run, { 'unit-pm': settled() });
    expect(outcome).toMatchObject({ completion: 'partial', closeoutBasis: 'stopped-work-resolved' });
    expect(outcome.work).toMatchObject({ logicalTasks: 1, settled: 0, cancelled: 1, unfinished: 1 });
    expect(outcome.remaining).toMatchObject({ state: 'some', items: [{ handle: 'h-1', reason: 'stopped' }] });
    // From the accepted request to the stop: no waiting for a later request is counted into the job.
    expect(outcome.timing).toMatchObject({ elapsedMs: 25_000, elapsedBasis: 'since-request', clock: { closedAt: at(25) } });
    const view = jobOutcomeView(outcome);
    expect(view.headline.map((segment) => segment.text)).toEqual(expect.arrayContaining(['Partial', '1 task unfinished', '25s']));
    expect(view.sections[0].rows.find((row) => row.label === 'Closed by')?.value).toBe('UnodeAi, after a task was stopped and no work was left running');
    expect(view.actions.map((action) => action.id)).toContain('continueUnfinished');
  });

  // Codex's audit of 2026-10-04: the same stop while the coordinator was still in its turn. Its own reply closes
  // the run, and the card said Complete beside "1 task unfinished".
  it('shows a job the coordinator closed over a stopped task as partial too, with the stopped task left over', () => {
    const ledger = new RunLedger([], { activeTurnId: () => 'turn-pm' });
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review the modules.',
      originCorrelationId: 'origin-1', dispatchedAt: at(10), originTurnId: 'turn-pm',
    });
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-1', agentId: 'arch', reason: 'Stopped by user.', cancelledAt: at(15) });
    // The coordinator is in a turn, so the host leaves the run to it.
    expect(ledger.get(runId)!.status).toBe('open');
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'origin-1', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(0) });
    ledger.observeMessage({
      id: 'closing-reply', correlationId: 'origin-1', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      timestamp: at(20), payload: { instruction: 'The review was stopped before it finished.', metadata: { turnId: 'turn-pm' } },
    });
    const run = ledger.get(runId)!;
    expect(run).toMatchObject({ status: 'closed', closingTurnId: 'turn-pm', endedAt: at(20) });
    expect(run.closeoutBasis).toBeUndefined();
    const outcome = project(run, { 'unit-pm': settled() });
    expect(outcome.completion).toBe('partial');
    expect(outcome.work).toMatchObject({ logicalTasks: 1, settled: 0, cancelled: 1, unfinished: 1 });
    // The stopped task accounts for the partial close: the card does not say that nothing does.
    expect(outcome.remaining).toMatchObject({ state: 'some', closeoutPartial: false, items: [{ handle: 'h-1', reason: 'stopped' }] });
    const view = jobOutcomeView(outcome);
    expect(view.headline[0]).toEqual({ text: 'Partial', tone: 'caution' });
    expect(view.headline.map((segment) => segment.text)).toContain('1 task unfinished');
    expect(view.sections[0].rows.find((row) => row.label === 'Closed by')?.value).toBe('The coordinator\'s closing reply');
    expect(view.actions.map((action) => action.id)).toContain('continueUnfinished');
  });

  // Field smoke, 2026-10-04: a worker that admitted its task after the coordinator's dispatching turn had ended.
  it('counts the coordinator\'s dispatching turn when the dispatch was recorded only after that turn had ended', () => {
    const ledger = new RunLedger();
    expect(ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'origin-1', usageUnitId: 'unit-pm', ended: 'completed', timing: timing(0) })).toBe(false);
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review the modules.',
      originCorrelationId: 'origin-1', originTurnId: 'turn-pm', dispatchedAt: at(10),
    });
    ledger.recordFileChange({ agentId: 'arch', correlationId: 'h-1', path: 'src/feature.ts', before: 'a', after: 'b' });
    ledger.recordDelegationEvidence({ handle: 'h-1', agentId: 'arch', outcome: VERIFIED.outcome, evidence: VERIFIED });
    ledger.recordTurn('arch', { turnId: 'turn-arch', correlationId: 'h-1', runId, usageUnitId: 'unit-arch', ended: 'completed', timing: timing(21) });
    ledger.recordTurn('pm', { turnId: 'turn-close', correlationId: runId, runId, usageUnitId: 'unit-close', ended: 'completed', timing: timing(42) });
    ledger.observeMessage({
      id: 'closing-reply', correlationId: runId, from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      timestamp: at(62), payload: { instruction: 'Done.', metadata: { turnId: 'turn-close' } },
    });
    const outcome = project(ledger.get(runId)!, { 'unit-pm': settled(), 'unit-arch': settled(), 'unit-close': settled() });
    // From the accepted request, with the dispatching turn's usage in the job: nothing is "since first dispatch".
    expect(outcome.timing).toMatchObject({
      elapsedBasis: 'since-request', elapsedMs: 62_000, timeToFirstDispatchMs: { state: 'recorded', ms: 10_000 },
      clock: { requestAcceptedAt: { state: 'recorded', at: at(0) } },
      phases: { state: 'recorded', coverage: 'complete', turns: 3 },
    });
    expect(outcome.usage).toMatchObject({ state: 'recorded', coverage: 'complete', turns: 3, unitsSettled: 3 });
  });

  it('writes a continuation request that names replaces_handle for an interrupted task only', () => {
    const stoppedLedger = new RunLedger([], { activeTurnId: () => undefined });
    const stoppedId = stoppedLedger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-stopped', requestedAgent: 'architect', agentId: 'arch', instruction: 'Review.',
      originCorrelationId: 'origin-1', dispatchedAt: at(10),
    });
    stoppedLedger.observeMessage({
      id: 'dispatch-reply', correlationId: 'origin-1', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      timestamp: at(20), payload: { instruction: 'Dispatched.', metadata: { turnId: 'turn-pm' } },
    });
    stoppedLedger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-stopped', agentId: 'arch', reason: 'Stopped by user.', cancelledAt: at(25) });
    const labels = { agentName: (id: string) => (id === 'arch' ? 'System Architect' : undefined) };
    const stopped = jobContinuationRequest(project(stoppedLedger.get(stoppedId)!, {}), labels);
    expect(stopped).toContain('System Architect\'s task was stopped before it returned a result (task handle h-stopped).');
    // The host refuses replaces_handle for a stopped task, so the request must not send the coordinator there.
    expect(stopped).toContain('dispatch it as a new task, without replaces_handle');
    expect(stopped).not.toContain('with replaces_handle set to its handle');
    // Field re-check, 2026-10-04: the coordinator tried to mark the stopped task abandoned, and the host refused.
    expect(stopped).toContain('A stopped task has no result and takes no disposition: do not call record_task_disposition for it.');

    const interrupted = jobContinuationRequest(project(closedRun({
      evidence: null,
      closingType: 'task.partial',
      before: (ledger) => {
        ledger.recordDelegationInterrupted({
          coordinatorId: 'pm', handle: 'h-1', agentId: 'arch', reason: 'worker-lost', lastObservedAt: at(12), detectedAt: at(13),
        });
      },
    })), labels);
    expect(interrupted).toContain('System Architect\'s task was interrupted before it returned a result (task handle h-1).');
    expect(interrupted).toContain('To redo an interrupted task, dispatch it again with replaces_handle set to its handle.');
    expect(interrupted).not.toContain('without replaces_handle');
    // An interrupted task does take a disposition, so nothing about dispositions is said of it.
    expect(interrupted).not.toContain('record_task_disposition');

    const refused = jobContinuationRequest(project(refusedRun(), { 'unit-pm': settled() }), labels);
    expect(refused).toContain('A dispatch to System Architect was refused by team policy before it started (policy reviewers-only).');
    expect(refused).toContain('Do not send a refused dispatch again unchanged');
    expect(refused).not.toContain('replaces_handle');
    expect(refused).not.toContain('record_task_disposition');
  });

  it('never says that nobody was asked when the turns recorded a wait for a person and no approval was recorded', () => {
    const approvals = (run: RunRecord) => jobOutcomeView(project(run)).sections.find((section) => section.title === 'Approvals')!;
    // No approval and no wait: a plain statement of what is recorded.
    expect(approvals(closedRun())).toEqual({ title: 'Approvals', rows: [{ label: 'Approvals', value: 'None recorded' }] });
    // A consent dialog that writes no approval receipt still paused the worker's turn clock for 5 s.
    const asked = closedRun({
      workerTurn: false,
      before: (ledger, runId) => {
        ledger.recordTurn('arch', {
          turnId: 'turn-arch', correlationId: 'h-1', runId, usageUnitId: 'unit-arch', ended: 'completed',
          timing: { startedAt: at(11), settledAt: at(36), durationMs: 20_000, approvalWaitMs: 5_000, phases: { ...PHASES } },
        });
      },
    });
    const section = approvals(asked);
    expect(section.rows).toEqual([{ label: 'Approvals', value: 'None recorded', tone: 'caution' }]);
    expect(section.note).toContain('recorded 5s of waiting for a person');
    expect(section.note).toContain('are not counted here');
    expect(JSON.stringify(section)).not.toContain('None observed');
  });

  /** A run that a refusal by team policy opened: the host started nothing, and the coordinator's reply closed it. */
  function refusedRun(options: { openingTurn?: boolean; thenDispatch?: boolean } = {}): RunRecord {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'h-refused', requestedAgent: 'arch', reason: 'Team policy refused this attempt.',
      recordedAt: at(10), originCorrelationId: 'origin-1', taskState: 'policy-refused', policyId: 'reviewers-only',
      ...(options.openingTurn === false ? {} : { originTurnId: 'turn-pm' }),
    });
    const runId = ledger.openRunIdForCorrelation('pm', 'origin-1')!;
    if (options.thenDispatch) {
      ledger.recordDelegationDispatched({
        coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'developer', agentId: 'dev', instruction: 'Review the modules.',
        originCorrelationId: 'origin-1', dispatchedAt: at(18),
      });
      ledger.recordDelegationEvidence({ handle: 'h-1', agentId: 'dev', outcome: VERIFIED.outcome, evidence: VERIFIED });
    }
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'origin-1', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(0) });
    ledger.observeMessage({
      id: 'closing-reply', correlationId: 'origin-1', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      timestamp: at(40), payload: { instruction: 'The team policy did not allow it.', metadata: { turnId: 'turn-pm' } },
    });
    return ledger.get(runId)!;
  }

  it('shows a job whose only dispatch team policy refused as blocked work, and gives it no first dispatch', () => {
    const run = refusedRun();
    expect(run.status).toBe('closed');
    expect(run.delegations).toEqual([]);
    const outcome = project(run, { 'unit-pm': settled() });
    expect(outcome.work).toMatchObject({ logicalTasks: 0, attempts: 0, unfinished: 0, refusedBeforeDispatch: 1, policyRefused: 1 });
    expect(outcome.remaining).toEqual({
      state: 'some', items: [], omittedItems: 0,
      blocked: [{ requested: 'arch', reason: 'policy-refused', policyId: 'reviewers-only' }], omittedBlocked: 0,
      closeoutPartial: false,
    });
    expect(outcome.timing).toMatchObject({
      clock: {
        requestAcceptedAt: { state: 'recorded', at: at(0) }, firstDispatchAt: { state: 'none' },
        recordOpenedAt: at(10), closedAt: at(40),
      },
      elapsedMs: 40_000, elapsedBasis: 'since-request', timeToFirstDispatchMs: { state: 'not-recorded' },
    });
    const view = jobOutcomeView(outcome, { agentName: (id) => (id === 'arch' ? 'System Architect' : undefined) });
    const line = view.headline.map((segment) => segment.text);
    expect(line).toContain('1 dispatch refused by team policy');
    expect(line.some((text) => text.includes('first dispatch') || text.includes('unfinished'))).toBe(false);
    expect(line.at(-1)).toBe('40s');
    const remaining = view.sections.find((section) => section.title === 'Remaining')!;
    expect(remaining.rows).toEqual([
      { label: 'Unfinished work', value: '0' },
      { label: 'Refused by team policy', value: '1', tone: 'caution' },
    ]);
    expect(remaining.items).toEqual(['System Architect: refused by team policy before it started (policy reviewers-only)']);
    expect(remaining.note).toContain('would be refused again');
    // The way on is a new request, the same as for any other work that is left.
    expect(view.actions.map((action) => action.id)).toContain('continueUnfinished');
    const timingRows = view.sections.find((section) => section.title === 'Timing')!.rows;
    expect(timingRows.find((row) => row.label === 'First dispatch')).toEqual({ label: 'First dispatch', value: 'none accepted', tone: 'caution' });
    expect(timingRows.find((row) => row.label === 'Job recorded')).toEqual({ label: 'Job recorded', value: at(10), instant: at(10) });
    const markdown = renderJobOutcomeMarkdown(view, at(59));
    expect(markdown).toContain(`- Job recorded (UTC): **${at(10)}**`);
    expect(markdown).toContain('- First dispatch: **none accepted**');
    expect(timingRows.some((row) => row.label === 'Time to first dispatch')).toBe(false);
  });

  it('measures a job without any dispatch from its record, and says so, when the opening turn is not recorded', () => {
    const outcome = project(refusedRun({ openingTurn: false }), { 'unit-pm': settled() });
    expect(outcome.timing).toMatchObject({
      clock: { requestAcceptedAt: { state: 'not-recorded' }, firstDispatchAt: { state: 'none' } },
      elapsedMs: 30_000, elapsedBasis: 'since-record-opened', timeToFirstDispatchMs: { state: 'not-recorded' },
    });
    const view = jobOutcomeView(outcome);
    expect(view.headline.at(-1)?.text).toBe('30s since the job was recorded');
    expect(JSON.stringify(view)).not.toContain('since first dispatch');
  });

  it('takes the first dispatch from the attempts, not from the refusal that opened the run, and keeps the refusal listed', () => {
    const outcome = project(refusedRun({ thenDispatch: true }), { 'unit-pm': settled() });
    expect(outcome.timing).toMatchObject({
      clock: { firstDispatchAt: { state: 'recorded', at: at(18) }, recordOpenedAt: at(10) },
      elapsedBasis: 'since-request', timeToFirstDispatchMs: { state: 'recorded', ms: 18_000 },
    });
    expect(outcome.work).toMatchObject({ logicalTasks: 1, settled: 1, unfinished: 0, policyRefused: 1 });
    // No link says the later dispatch replaced the refused one, so the refusal is not taken to be resolved.
    expect(outcome.remaining).toMatchObject({ state: 'some', items: [], blocked: [{ requested: 'arch', reason: 'policy-refused' }] });
  });

  it('does not list a refusal that is not a policy refusal as blocked work', () => {
    const run = closedRun({
      before: (ledger) => {
        ledger.recordRefusedDispatch({
          coordinatorId: 'pm', requestedAgent: 'nobody', reason: 'No teammate has that id.', recordedAt: at(11), originCorrelationId: 'origin-1',
        });
      },
    });
    const outcome = project(run);
    expect(outcome.work).toMatchObject({ refusedBeforeDispatch: 1, policyRefused: 0 });
    expect(outcome.remaining).toEqual({ state: 'none', items: [], omittedItems: 0, blocked: [], omittedBlocked: 0, closeoutPartial: false });
  });

  it('drops a path it cannot prove workspace-relative, counts it and bounds the list', () => {
    const many = Array.from({ length: 60 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`);
    const run = closedRun({
      write: false,
      evidence: { ...VERIFIED, changedFiles: [...many, 'C:/Users/someone/secret.txt', '../outside.ts', '<img src=x onerror=alert(1)>.ts'] },
    });
    const outcome = project(run);
    expect(outcome.changes.fileCount).toBe(61);
    expect(outcome.changes.files).toHaveLength(50);
    expect(outcome.changes.omittedFiles).toBe(11);
    expect(outcome.changes.droppedPaths).toBe(2);
    expect(JSON.stringify(outcome)).not.toContain('secret.txt');
    // An evidence list without a complete digest is not a whole list.
    expect(outcome.changes.coverage).toBe('partial');
  });

  it('shows a human verdict apart, without letting it change completion or verification', () => {
    const run = closedRun({ evidence: { ...VERIFIED, verificationPlanStatus: 'failed', verificationSensors: [{ kind: 'run-checks', status: 'failed' }], verification: { ran: true, passed: false }, outcome: 'verification-failed' } });
    const judged: RunRecord = {
      ...run,
      verdicts: [{ verdict: 'accepted', approverId: 'owner', recordedAt: at(50), evidenceReviewedAt: at(49), unresolvedItems: [] }],
    };
    const outcome = project(judged);
    expect(outcome.humanVerdict).toBe('accepted');
    expect(outcome.verification.state).toBe('failed');
    expect(jobOutcomeView(outcome).headline[1]).toEqual({ text: 'Checks failed', tone: 'negative' });
  });
});

describe('one view for the card and the report', () => {
  it('writes the report from the same view the card shows, so the two cannot disagree', () => {
    const view = jobOutcomeView(project(closedRun()));
    const markdown = renderJobOutcomeMarkdown(view, at(59));
    for (const segment of view.headline) expect(markdown).toContain(segment.text.replace(/[\\`*_{}\[\]<>|]/g, '\\$&'));
    for (const section of view.sections) {
      expect(markdown).toContain(`## ${section.title}`);
      for (const row of section.rows) {
        expect(markdown).toContain(`${row.label.replace(/[\\`*_{}\[\]<>|]/g, '\\$&')}${row.instant ? ' (UTC)' : ''}: **`);
      }
    }
    expect(markdown).toContain('Host-observed');
    expect(markdown).toContain('Nothing was run, checked or measured again');
  });

  // The Owner, 2026-10-04: exported evidence that states its times in UTC must say that they are UTC.
  it('states every instant in UTC, says so in the report, and marks the rows a card may show in local time', () => {
    const view = jobOutcomeView(project(closedRun()));
    const timingRows = view.sections.find((section) => section.title === 'Timing')!.rows;
    const instants = timingRows.filter((row) => row.instant !== undefined);
    expect(instants.map((row) => row.label)).toEqual(['Request accepted', 'First dispatch', 'Closed']);
    for (const row of instants) {
      expect(row.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row.instant).toBe(row.value);
    }
    // Durations and counts are not instants, in this section or any other.
    for (const section of view.sections) {
      for (const row of section.rows) {
        if (!instants.includes(row)) expect(row.instant).toBeUndefined();
      }
    }
    const markdown = renderJobOutcomeMarkdown(view, at(59));
    expect(markdown).toContain(`- Report written (UTC): ${at(59)}`);
    expect(markdown).toContain('- Timestamps in this document are UTC (Coordinated Universal Time), in ISO 8601 form with a trailing `Z`. They are not local times.');
    for (const row of instants) expect(markdown).toContain(`- ${row.label} (UTC): **${row.value}**`);
    // Only an instant is called UTC.
    const marked = markdown.split('\n').filter((line) => line.includes('(UTC)'));
    expect(marked).toHaveLength(instants.length + 1);
    expect(view.sections.find((section) => section.title === 'Timing')!.note).toContain('An exported report shows the same instants in UTC.');
  });

  it('states a stored instant that carries an offset as the same instant in UTC', () => {
    const run = closedRun();
    // 18:00:40 at +08:00 is the fixture's own close, 10:00:40 UTC, written the other way.
    const outcome = project({ ...run, endedAt: '2026-10-04T18:00:40.000+08:00' });
    const closed = jobOutcomeView(outcome).sections.find((section) => section.title === 'Timing')!.rows.find((row) => row.label === 'Closed')!;
    expect(closed).toMatchObject({ value: at(40), instant: at(40) });
  });

  it('is a pure function of its inputs: the same run and usage give the same bytes', () => {
    const run = closedRun();
    const units = { 'unit-pm': settled(), 'unit-arch': settled() };
    const first = JSON.stringify(jobOutcomeView(projectJobOutcome(run.id, run, usageOf(units))));
    const second = JSON.stringify(jobOutcomeView(projectJobOutcome(run.id, structuredClone(run), usageOf(structuredClone(units)))));
    expect(second).toBe(first);
  });

  it('offers the spend actions as usage actions that say they do not change the job', () => {
    const view = jobOutcomeView(project(closedRun()));
    expect(view.actions.map((action) => action.id)).toEqual(['reviewChanges', 'openEvidence', 'changeTarget', 'resetCounter']);
    for (const action of view.actions.filter((entry) => entry.section === 'Usage')) {
      expect(action.title).toContain('does not change the job');
    }
  });
});
