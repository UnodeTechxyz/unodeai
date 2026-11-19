import { describe, expect, it, vi } from 'vitest';
import { SpendAlert, SpendCoordinator, SpendCoordinatorDeps, SpendRoute } from '../SpendCoordinator';
import { MemorySpendLedger, SpendEventRejectedError, SpendLedger } from '../../state/SpendStore';
import { catalogFromNewApiPricing } from '../../models/spend/PriceCatalog';
import { gatewayCandidates, gatewaySnapshotFromPricing, PriceCandidate, StoredReferencePriceMode } from '../../models/spend/PriceResolver';
import { parseRepositoryBudget, parseUserTargets, UserTargets } from '../../models/spend/SpendTargets';
import { noticeKey } from '../../models/spend/SpendAggregate';
import { StoredSpendEvent } from '../../models/spend/SpendTypes';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const pricing = { group_ratio: { default: 1 }, data: [{ model_name: 'm1', quota_type: 0, model_ratio: 0.5, completion_ratio: 1 }] };
const unodeCatalog = catalogFromNewApiPricing(pricing, { provider: 'unode', capturedAt: '2026-09-27T00:00:00.000Z', sourceUrl: 'https://u.example/api/pricing' });
// $1 per 1M tokens, input and output.

interface Harness {
  coordinator: SpendCoordinator;
  ledger: SpendLedger;
  alerts: SpendAlert[];
  choices: Array<{ connectionName: string; modelId: string }>;
  setTargets(targets: unknown): void;
  setMode(mode: StoredReferencePriceMode): void;
  setCandidates(candidates: PriceCandidate[]): void;
  setRoute(route: SpendRoute | undefined): void;
  stopRequest: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<SpendCoordinatorDeps> = {}, ledger: SpendLedger = new MemorySpendLedger(() => NOW)): Harness {
  const alerts: SpendAlert[] = [];
  const choices: Array<{ connectionName: string; modelId: string }> = [];
  let targets: UserTargets = parseUserTargets({ schemaVersion: 1 });
  let mode: StoredReferencePriceMode = 'unselected';
  let candidates: PriceCandidate[] = [];
  let route: SpendRoute | undefined = { connectionId: 'unode', connectionName: 'Unode', route: 'gateway' };
  const stopRequest = vi.fn(() => 1);
  let ids = 0;
  const coordinator = new SpendCoordinator({
    ledger,
    notifier: {
      threshold: (alert) => alerts.push(alert),
      referencePriceChoiceNeeded: (context) => choices.push(context),
      viewChanged: () => undefined,
      repairNeeded: () => undefined,
    },
    resolveRoute: () => route,
    routeCandidates: () => candidates,
    referenceMode: () => mode,
    catalogs: () => ({ unode: unodeCatalog }),
    userTargets: () => targets,
    repositoryBudget: () => undefined,
    stopRequest,
    now: () => NOW,
    randomId: () => `id${++ids}`,
    claimRetryMs: 1,
    ...overrides,
  });
  return {
    coordinator, ledger, alerts, choices, stopRequest,
    setTargets: (value) => { targets = parseUserTargets(value); },
    setMode: (value) => { mode = value; },
    setCandidates: (value) => { candidates = value; },
    setRoute: (value) => { route = value; },
  };
}

async function flush(coordinator: SpendCoordinator): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await coordinator.settled();
  }
}

function coefficient(): PriceCandidate[] {
  const snapshot = gatewaySnapshotFromPricing(pricing, { sourceId: 'acct', connectionId: 'unode', capturedAt: '2026-09-28T00:00:00.000Z', authenticated: true });
  return gatewayCandidates(snapshot, 'm1', { coefficient: 1 });
}

describe('usage units and receipts', () => {
  it('records one aggregate receipt for several provider attempts and projects its display cost', async () => {
    const h = harness();
    h.setCandidates(coefficient());
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.noteModelRequest('unit1');
    const projection = h.coordinator.settleUsageUnit('unit1', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported' });
    expect(projection?.costUsd).toBe(1);
    expect(projection?.costBasis).toBe('estimated');
    await flush(h.coordinator);
    const kinds = h.ledger.snapshot().events.map((stored) => stored.event.kind);
    expect(kinds.filter((kind) => kind === 'usage-receipt')).toHaveLength(1);
    const receipt = h.ledger.snapshot().events.find((stored) => stored.event.kind === 'usage-receipt')!.event;
    expect(receipt).toMatchObject({ receipt: { providerAttempts: 2, reminderValue: { basis: 'exact-route' } } });
  });

  it('creates neither usage nor a gap for a turn refused before any provider request', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.closeUsageUnit('unit1');
    await flush(h.coordinator);
    expect(h.ledger.snapshot().events).toHaveLength(0);
  });

  it('keeps exact progress and records one gap when a started turn never reports a total', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.noteUsageProgress('unit1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    h.coordinator.closeUsageUnit('unit1');
    h.coordinator.closeUsageUnit('unit1');
    await flush(h.coordinator);
    const kinds = h.ledger.snapshot().events.map((stored) => stored.event.kind);
    expect(kinds).toEqual(['usage-unit-start', 'usage-progress', 'coverage-gap']);
    const view = h.coordinator.viewModel();
    expect(view.coverageGaps).toBe(1);
    expect(view.requests[0].eligibleTokens).toBe(110);
  });

  it('refuses progress for an attempt that was never observed', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.noteUsageProgress('unit1', { attempt: 2, inputTokens: 100, outputTokens: 10 });
    await flush(h.coordinator);
    expect(h.ledger.snapshot().events.map((stored) => stored.event.kind)).toEqual(['usage-unit-start']);
  });

  it('marks a receipt whose attempts were not all attributed', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.settleUsageUnit('unit1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported', attributedAttempts: 1 });
    await flush(h.coordinator);
    const receipt = h.ledger.snapshot().events.find((stored) => stored.event.kind === 'usage-receipt')!.event;
    expect(receipt).toMatchObject({ receipt: { coverageGap: 'one-or-more-attempts-unattributed' } });
  });

  it('shows subscription dollars as API-equivalent and never uses them for a dollar reminder', async () => {
    const h = harness();
    h.setRoute({ connectionId: 'codex-cli', connectionName: 'Codex CLI', route: 'subscription' });
    h.setTargets({ schemaVersion: 1, request: { usd: '0.000001' } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    const projection = h.coordinator.settleUsageUnit('unit1', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported', costBasis: 'api-equivalent' });
    expect(projection?.costBasis).toBe('api-equivalent');
    await flush(h.coordinator);
    expect(h.alerts).toEqual([]);
    expect(h.choices).toEqual([]);
  });
});

describe('reminders', () => {
  it('reminds from exact progress inside a long turn, only after the event is durable', async () => {
    let release: (() => void) | undefined;
    const memory = new MemorySpendLedger(() => NOW);
    const slow: SpendLedger = Object.assign(Object.create(memory), {
      append: async (payload: never, id: string) => {
        if ((payload as { kind: string }).kind === 'usage-progress') await new Promise<void>((resolve) => { release = resolve; });
        return memory.append(payload, id);
      },
      snapshot: () => memory.snapshot(),
      transact: memory.transact.bind(memory),
      onDidChange: memory.onDidChange.bind(memory),
    });
    const h = harness({}, slow);
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.noteUsageProgress('unit1', { attempt: 1, inputTokens: 90, outputTokens: 20 });
    await flush(h.coordinator);
    expect(h.alerts).toEqual([]); // not durable yet: no notice
    release!();
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100]);
    expect(h.alerts[0]).toMatchObject({ loudness: 'over-target', scope: 'request', dimension: 'tokens', requestId: 'req1', rootAgentId: 'pm' });
  });

  it('walks the ladder 80, 100, 150, 200, 300 once each, presenting the highest newly reached', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    const steps = [85, 20, 50, 60, 100, 10];
    for (let i = 0; i < steps.length; i++) {
      h.coordinator.noteModelRequest('u');
      h.coordinator.noteUsageProgress('u', { attempt: i + 1, inputTokens: steps[i], outputTokens: 0 });
      await flush(h.coordinator);
    }
    expect(h.alerts.map((alert) => [alert.threshold, alert.loudness])).toEqual([
      [80, 'quiet'], [100, 'over-target'], [150, 'over-target'], [200, 'over-target'], [300, 'over-target'],
    ]);
  });

  it('gives partial and reconstructed usage no reminder authority', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 10 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 1000, outputTokens: 0, usageBasis: 'reported-partial' });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u2');
    h.coordinator.settleUsageUnit('u2', { inputTokens: 1000, outputTokens: 0, estimated: true });
    await flush(h.coordinator);
    expect(h.alerts).toEqual([]);
    expect(h.coordinator.viewModel().requests[0].tokens.total).toBe(2000);
  });

  it('starts the whole ladder again after a reset, without deleting history', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u');
    h.coordinator.noteUsageProgress('u', { attempt: 1, inputTokens: 120, outputTokens: 0 });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100]);
    const reset = await h.coordinator.resetCounter({ scope: 'request', requestId: 'req1' });
    expect(reset.previousTotals.eligibleTokens).toBe(120);
    const eventsBefore = h.ledger.snapshot().events.length;
    h.coordinator.noteModelRequest('u');
    h.coordinator.noteUsageProgress('u', { attempt: 2, inputTokens: 85, outputTokens: 0 });
    await flush(h.coordinator);
    h.coordinator.noteModelRequest('u');
    h.coordinator.noteUsageProgress('u', { attempt: 3, inputTokens: 20, outputTokens: 0 });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100, 80, 100]);
    expect(h.ledger.snapshot().events.length).toBeGreaterThan(eventsBefore);
    const view = h.coordinator.viewModel();
    expect(view.requests[0].eligibleTokens).toBe(105);
    expect(view.requests[0].lastReset?.previousTokens).toBe(120);
  });

  it('starts a new ladder when the target changes', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u');
    h.coordinator.noteUsageProgress('u', { attempt: 1, inputTokens: 120, outputTokens: 0 });
    await flush(h.coordinator);
    h.setTargets({ schemaVersion: 1, request: { tokens: 110 } });
    h.coordinator.noteModelRequest('u');
    h.coordinator.noteUsageProgress('u', { attempt: 2, inputTokens: 1, outputTokens: 0 });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100, 100]);
  });

  it('never stops, pauses or delays work: the port calls are synchronous and nothing is awaited on them', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 1 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    const result = h.coordinator.noteModelRequest('u');
    expect(result).toBeUndefined();
    h.coordinator.settleUsageUnit('u', { inputTokens: 1000, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.length).toBe(1);
    expect(h.stopRequest).not.toHaveBeenCalled();
  });

  it('binds Stop this request to the triggering request, once', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 1 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u');
    h.coordinator.settleUsageUnit('u', { inputTokens: 10, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    const token = h.alerts[0].stopToken;
    expect(h.coordinator.stopRequestForAlert(token)).toBe('stopped');
    expect(h.stopRequest).toHaveBeenCalledWith('req1');
    expect(h.coordinator.stopRequestForAlert(token)).toBe('used');
    h.stopRequest.mockReturnValue(0);
    expect(h.coordinator.stopRequestForAlert('forged')).toBe('used');
  });

  it('reports Already finished when the request has no live turn left', async () => {
    const h = harness();
    h.stopRequest.mockReturnValue(0);
    h.setTargets({ schemaVersion: 1, request: { tokens: 1 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u');
    h.coordinator.settleUsageUnit('u', { inputTokens: 10, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.coordinator.stopRequestForAlert(h.alerts[0].stopToken)).toBe('already-finished');
  });

  it('uses dollars only from an eligible basis', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { usd: '0.5' } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts).toEqual([]); // unselected reference: display-only
    h.setMode('unode');
    h.coordinator.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u2');
    h.coordinator.settleUsageUnit('u2', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => [alert.dimension, alert.threshold])).toEqual([['usd', 200]]);
    expect(h.alerts[0].basisText).toMatch(/selected reference/);
  });

  it('applies a repository proposal only after exact-digest acceptance, and only to enabled targets', async () => {
    const parsed = parseRepositoryBudget(JSON.stringify({ schemaVersion: 1, max: { request: { tokens: 10 }, project: { tokens: 5 } } }));
    if (!parsed.ok) throw new Error(parsed.reason);
    const h = harness({ repositoryBudget: () => parsed.budget });
    h.setTargets({ schemaVersion: 1, request: { tokens: 1000 } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 20, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts).toEqual([]);
    await h.coordinator.decideRepositoryTargets({ mode: 'accepted-digest', contentDigest: parsed.budget.contentDigest });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u2');
    h.coordinator.settleUsageUnit('u2', { inputTokens: 1, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => [alert.threshold, alert.repositoryNarrowed])).toEqual([[200, true]]);
    expect(h.coordinator.viewModel().targets.project).toBeUndefined();
  });
});

describe('durable writes', () => {
  function wrap(memory: MemorySpendLedger, append: (payload: never, id: string) => Promise<StoredSpendEvent>): SpendLedger {
    return Object.assign(Object.create(memory), {
      append,
      snapshot: () => memory.snapshot(),
      transact: memory.transact.bind(memory),
      onDidChange: memory.onDidChange.bind(memory),
    });
  }

  it('keeps settled usage queued and retries it until it is durable, saying usage is updating meanwhile', async () => {
    const memory = new MemorySpendLedger(() => NOW);
    let down = true;
    let failures = 0;
    const flaky = wrap(memory, async (payload, id) => {
      if (down) {
        failures += 1;
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      }
      return memory.append(payload, id);
    });
    const h = harness({ appendRetryMs: 1 }, flaky);
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.settleUsageUnit('unit1', { inputTokens: 150, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures).toBeGreaterThan(1);
    expect(h.coordinator.viewModel().pendingWrites).toBe(2);
    expect(memory.snapshot().events).toEqual([]);
    expect(h.alerts).toEqual([]);
    down = false;
    await h.coordinator.drained();
    expect(h.coordinator.viewModel().pendingWrites).toBe(0);
    expect(memory.snapshot().events.map((stored) => stored.event.eventId)).toEqual(['start:unit1:1', 'usage:unit1']);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([150]);
  });

  it('drops an event this version refuses to write without holding up the events behind it', async () => {
    const memory = new MemorySpendLedger(() => NOW);
    const picky = wrap(memory, async (payload, id) => {
      if (id.startsWith('start:')) throw new SpendEventRejectedError('Refusing to record an invalid spend event (usage-unit-start).');
      return memory.append(payload, id);
    });
    const h = harness({ appendRetryMs: 1 }, picky);
    h.coordinator.beginUsageUnit({ usageUnitId: 'unit1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('unit1');
    h.coordinator.settleUsageUnit('unit1', { inputTokens: 10, outputTokens: 0, usageBasis: 'reported' });
    await h.coordinator.drained();
    expect(memory.snapshot().events.map((stored) => stored.event.eventId)).toEqual(['usage:unit1']);
    expect(h.coordinator.viewModel().pendingWrites).toBe(0);
  });
});

describe('notice claims', () => {
  it('never prunes an active counter\'s claim by count, and prunes only ended periods and idle requests', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    const revision = h.coordinator.viewModel().targetRevision;
    const key = (scopeKey: string, periodId: string, threshold: number) =>
      noticeKey({ scopeKey, dimension: 'tokens', targetRevision: revision, counterEpoch: 'initial', periodId, threshold });
    const claimedAt = '2026-09-28T00:00:00.000Z';
    await h.ledger.transact((control) => ({
      next: {
        ...control,
        noticeClaims: [
          { key: key('request:req1', '-', 100), claimedAt },
          // Many live counters of the current period, all under the current target revision.
          ...Array.from({ length: 2_500 }, (_, i) => ({ key: key(`agent:a${i}`, '2026-09-28@UTC', 100), claimedAt })),
          { key: key('project', '2026-09-27@UTC', 100), claimedAt }, // a period that has ended
          // A request with no usage for 30 days after its claim.
          { key: key('request:gone', '-', 200), claimedAt: '2026-08-19T00:00:00.000Z' },
        ],
      },
      result: undefined,
    }));
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 160, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([150]);
    // Another window reaches 170% of the same counter: nothing new to say, however many other claims exist.
    const other = harness({}, h.ledger);
    other.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    other.coordinator.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    other.coordinator.noteModelRequest('u2');
    other.coordinator.settleUsageUnit('u2', { inputTokens: 10, outputTokens: 0, usageBasis: 'reported' });
    await flush(other.coordinator);
    expect(other.alerts).toEqual([]);
    const claims = h.ledger.snapshot().control.noticeClaims.map((claim) => claim.key);
    expect(claims.filter((entry) => entry.startsWith('agent:a'))).toHaveLength(2_500);
    expect(claims.filter((entry) => entry.startsWith('request:req1|'))).toEqual([key('request:req1', '-', 150)]);
    expect(claims.some((entry) => entry.startsWith('project|'))).toBe(false);
    expect(claims.some((entry) => entry.startsWith('request:gone|'))).toBe(false);
  });

  it('lets a request claim lapse after 30 days without usage, in this window and in control alike', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let clock = NOW;
    const h = harness({ now: () => clock }, new MemorySpendLedger(() => clock));
    h.setTargets({ schemaVersion: 1, request: { tokens: 100 } });
    h.coordinator.beginRequest('req1', 'pm');
    const turn = async (unit: string, tokens: number) => {
      h.coordinator.beginUsageUnit({ usageUnitId: unit, requestId: 'req1', agentId: 'pm', modelId: 'm1' });
      h.coordinator.noteModelRequest(unit);
      h.coordinator.settleUsageUnit(unit, { inputTokens: tokens, outputTokens: 0, usageBasis: 'reported' });
      await flush(h.coordinator);
    };
    await turn('u1', 120);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100]);
    // 29 days later the claim still holds: no second reminder for the same rung.
    clock += 29 * DAY;
    await turn('u2', 1);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100]);
    // Then 31 idle days with no other claim in between: the resumed request reminds again at its current rung.
    clock += 31 * DAY;
    await turn('u3', 1);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([100, 100]);
    const claims = h.ledger.snapshot().control.noticeClaims;
    expect(claims).toHaveLength(1);
    expect(claims[0].claimedAt).toBe(new Date(clock).toISOString());
  });

  it('claims and presents only the highest rung of a jump, far past the old cap', async () => {
    const h = harness();
    h.setTargets({ schemaVersion: 1, request: { tokens: 1 } });
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 25_000, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([2_500_000]);
    expect(h.ledger.snapshot().control.noticeClaims).toHaveLength(1);
    h.coordinator.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u2');
    h.coordinator.settleUsageUnit('u2', { inputTokens: 1, outputTokens: 0, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(h.alerts.map((alert) => alert.threshold)).toEqual([2_500_000, 2_500_100]);
  });
});

describe('spend view dates', () => {
  it('dates "Tracked since" in the local day, like the project period beside it (field finding F2)', async () => {
    // 05:13 UTC on the 28th is still the evening of the 27th in Vancouver.
    const at = Date.parse('2026-09-28T05:13:00.000Z');
    const h = harness({ now: () => at }, new MemorySpendLedger(() => at));
    h.setTargets({ schemaVersion: 1, project: { tokens: 1_000_000, period: 'day', timeZone: 'America/Vancouver' } });
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(h.coordinator);
    const view = h.coordinator.viewModel();
    expect(view.trackedSince).toBe('2026-09-27');
  });
});

describe('reference prices after a gateway turn', () => {
  it('offers the choice when a gateway turn has no exact price, key presence notwithstanding', async () => {
    const refresh = vi.fn(async () => undefined);
    const h = harness({ postTurnPriceRefresh: refresh });
    const published = gatewayCandidates(gatewaySnapshotFromPricing(pricing, { sourceId: 's', connectionId: 'unode', capturedAt: '2026-09-28T00:00:00.000Z', authenticated: true }), 'm1', {});
    h.setCandidates(published);
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.choices).toEqual([{ connectionName: 'Unode', modelId: 'm1' }]);
  });

  it('adjusts the receipt instead when the post-turn refresh finds an exact account price', async () => {
    const h = harness();
    const refreshed = coefficient();
    const withRefresh = harness({
      postTurnPriceRefresh: async () => { withRefresh.setCandidates(refreshed); },
    });
    withRefresh.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    withRefresh.coordinator.noteModelRequest('u1');
    withRefresh.coordinator.settleUsageUnit('u1', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported' });
    await flush(withRefresh.coordinator);
    const kinds = withRefresh.ledger.snapshot().events.map((stored: StoredSpendEvent) => stored.event.kind);
    expect(kinds).toContain('cost-adjustment');
    expect(withRefresh.choices).toEqual([]);
    expect(withRefresh.coordinator.viewModel().requests[0].eligibleNanoUsd).toBe(1_000_000_000n);
    void h;
  });

  it('does not offer the choice after a stopped turn on a route that has an account price (field finding F4)', async () => {
    const h = harness();
    h.setCandidates(coefficient());
    h.coordinator.beginRequest('req1', 'pm');
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 5000, outputTokens: 200, usageBasis: 'reported-partial' });
    await flush(h.coordinator);
    expect(h.choices).toEqual([]);
    // A route that really has no price still gets the choice after a stopped turn.
    const unpriced = harness();
    unpriced.coordinator.beginRequest('req1', 'pm');
    unpriced.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    unpriced.coordinator.noteModelRequest('u1');
    unpriced.coordinator.settleUsageUnit('u1', { inputTokens: 5000, outputTokens: 200, usageBasis: 'reported-partial' });
    await flush(unpriced.coordinator);
    expect(unpriced.choices).toHaveLength(1);
  });

  it('does not offer the choice once a mode is chosen or an exact price exists', async () => {
    const chosen = harness();
    chosen.setMode('token-only');
    chosen.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    chosen.coordinator.noteModelRequest('u1');
    chosen.coordinator.settleUsageUnit('u1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(chosen.coordinator);
    expect(chosen.choices).toEqual([]);
    const exact = harness();
    exact.setCandidates(coefficient());
    exact.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    exact.coordinator.noteModelRequest('u1');
    exact.coordinator.settleUsageUnit('u1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(exact.coordinator);
    expect(exact.choices).toEqual([]);
  });
});

describe('post-turn price refresh', () => {
  it('runs once for concurrent turns on one route and model, not again soon after', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const h = harness({
      postTurnPriceRefresh: () => { calls += 1; return new Promise<void>((resolve) => { release = resolve; }); },
    });
    for (const unit of ['u1', 'u2']) {
      h.coordinator.beginUsageUnit({ usageUnitId: unit, requestId: 'req1', agentId: 'pm', modelId: 'm1' });
      h.coordinator.noteModelRequest(unit);
      h.coordinator.settleUsageUnit(unit, { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    }
    await flush(h.coordinator);
    expect(calls).toBe(1);
    release!();
    await flush(h.coordinator);
    h.coordinator.beginUsageUnit({ usageUnitId: 'u3', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('u3');
    h.coordinator.settleUsageUnit('u3', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(h.coordinator);
    expect(calls).toBe(1);
  });
});

describe('ids outside the event charset', () => {
  it('records usage for a model or agent name the schema cannot store verbatim', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req1', agentId: 'Frontend Engineer', modelId: 'Vendor Model 7B (preview)' });
    h.coordinator.noteModelRequest('u1');
    h.coordinator.settleUsageUnit('u1', { inputTokens: 10, outputTokens: 1, usageBasis: 'reported' });
    await flush(h.coordinator);
    const receipt = h.ledger.snapshot().events.find((stored) => stored.event.kind === 'usage-receipt')?.event as { receipt: { modelId: string; agentId: string } } | undefined;
    expect(receipt?.receipt.modelId).toMatch(/^h-[0-9a-f]{40}$/);
    expect(receipt?.receipt.agentId).toMatch(/^h-[0-9a-f]{40}$/);
    expect(h.coordinator.viewModel().requests[0].eligibleTokens).toBe(11);
  });
});
