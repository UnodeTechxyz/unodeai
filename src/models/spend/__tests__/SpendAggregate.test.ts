import { describe, expect, it } from 'vitest';
import {
  afterReset,
  aggregateSpend,
  counterEpochOf,
  counterTotals,
  noticeCounterKey,
  noticeKey,
  parseNoticeKey,
  reachedThresholds,
  totalsSnapshot,
} from '../SpendAggregate';
import {
  CounterResetV1,
  emptySpendControl,
  SpendControlV1,
  SpendEventPayload,
  StoredSpendEvent,
  UsageReceipt,
  validateSpendEvent,
} from '../SpendTypes';

let sequence = 0;
function stored(payload: SpendEventPayload, opts: { segment?: string; at?: string; eventId?: string } = {}): StoredSpendEvent {
  const eventId = opts.eventId ?? (payload.kind === 'usage-unit-start' ? `start:${payload.usageUnitId}:${payload.providerAttempts}`
    : payload.kind === 'usage-progress' ? payload.progressId
    : payload.kind === 'usage-receipt' ? payload.receipt.receiptId
    : payload.kind === 'coverage-gap' ? `gap:${payload.usageUnitId}`
    : payload.adjustmentId);
  const event = { schemaVersion: 1 as const, eventId, hostEpoch: 'h1', sequence: ++sequence, recordedAt: opts.at ?? '2026-09-27T10:00:00.000Z', ...payload };
  expect(validateSpendEvent(event), JSON.stringify(event)).toBeDefined();
  return { segment: opts.segment ?? 'h1-0', event: event as StoredSpendEvent['event'] };
}

function start(unit: string, attempts = 1, requestId = 'req-1', agentId = 'pm') {
  return stored({ kind: 'usage-unit-start', usageUnitId: unit, requestId, agentId, connectionId: 'unode', modelId: 'm1', providerAttempts: attempts });
}

function progress(unit: string, attempt: number, input: number, output: number, nano: string, requestId = 'req-1') {
  return stored({
    kind: 'usage-progress', progressId: `progress:${unit}:${attempt}`, usageUnitId: unit, requestId, providerAttempt: attempt,
    tokens: { input, output, basis: 'reported' },
    displayCost: { nanoUsd: nano, basis: 'account-coefficient', sourceId: 's1' },
    reminderValue: { tokens: input + output, nanoUsd: nano, basis: 'exact-route' },
  });
}

function receipt(unit: string, input: number, output: number, nano: string, covered: string[] = [], extra: Partial<UsageReceipt> = {}, requestId = 'req-1', agentId = 'pm') {
  return stored({
    kind: 'usage-receipt',
    receipt: {
      schemaVersion: 1, receiptId: `usage:${unit}`, requestId, usageUnitId: unit, providerAttempts: Math.max(1, covered.length),
      ...(covered.length ? { coveredProgressIds: covered } : {}),
      agentId, connectionId: 'unode', modelId: 'm1', observedAt: '2026-09-27T10:00:00.000Z',
      tokens: { input, output, basis: 'reported' },
      displayCost: { nanoUsd: nano, basis: 'account-coefficient', sourceId: 's1' },
      reminderValue: { tokens: input + output, nanoUsd: nano, basis: 'exact-route' },
      ...extra,
    },
  });
}

const request = { kind: 'request' as const, requestId: 'req-1' };

describe('aggregation', () => {
  it('counts one aggregate receipt for several attempts and never splits it per attempt', () => {
    const events = [start('u1', 1), start('u1', 2), start('u1', 3), receipt('u1', 900, 100, '1000', [], { providerAttempts: 3 })];
    const result = aggregateSpend(events);
    expect(result.contributions).toHaveLength(1);
    expect(result.units.get('u1')).toMatchObject({ providerAttempts: 3, state: 'settled' });
    expect(counterTotals(result, emptySpendControl(), request)).toMatchObject({ eligibleTokens: 1000, eligibleNanoUsd: 1000n });
  });

  it('counts progress at its own sequence and adds only the receipt residual', () => {
    const events = [
      start('u1', 1), progress('u1', 1, 100, 10, '110'),
      start('u1', 2), progress('u1', 2, 200, 20, '220'),
      receipt('u1', 350, 40, '400', ['progress:u1:1', 'progress:u1:2'], { providerAttempts: 3 }),
    ];
    const totals = counterTotals(aggregateSpend(events), emptySpendControl(), request);
    expect(totals.eligibleTokens).toBe(390);
    expect(totals.eligibleNanoUsd).toBe(400n);
    expect(totals.displayTokens).toBe(390);
  });

  it('divides a long turn exactly once across a mid-turn reset', () => {
    const before = [start('u1', 1), progress('u1', 1, 100, 10, '110'), start('u1', 2), progress('u1', 2, 200, 20, '220')];
    const watermarks = aggregateSpend(before).watermarks;
    const after = [start('u1', 3), progress('u1', 3, 300, 30, '330'), receipt('u1', 650, 70, '700', ['progress:u1:1', 'progress:u1:2', 'progress:u1:3'], { providerAttempts: 3 })];
    const all = aggregateSpend([...before, ...after]);
    const reset: CounterResetV1 = {
      resetId: 'r1', scope: 'request', requestId: 'req-1', resetAt: '2026-09-27T10:00:00Z', actor: 'user', watermarks,
      previousTotals: totalsSnapshot(counterTotals(aggregateSpend(before), emptySpendControl(), request)),
    };
    const control: SpendControlV1 = { ...emptySpendControl(), resets: [reset] };
    const total = counterTotals(all, emptySpendControl(), request);
    const sinceReset = counterTotals(all, control, request);
    expect(total.eligibleTokens).toBe(720);
    // 330 before the reset, 330 of progress plus a 60-token residual after it: nothing lost or doubled.
    expect(sinceReset.eligibleTokens).toBe(390);
    expect(Number(reset.previousTotals.eligibleTokens) + sinceReset.eligibleTokens).toBe(total.eligibleTokens);
    expect(counterEpochOf(control, request)).toBe('r1');
  });

  it('keeps exact progress when a receipt claims less than it covers, and makes the residual display-only', () => {
    const events = [start('u1'), progress('u1', 1, 100, 10, '110'), receipt('u1', 50, 5, '55', ['progress:u1:1'])];
    const result = aggregateSpend(events);
    expect(counterTotals(result, emptySpendControl(), request)).toMatchObject({ eligibleTokens: 110, eligibleNanoUsd: 110n });
    expect(result.diagnostics.join(' ')).toMatch(/fewer tokens/);
  });

  it('never counts partial or reconstructed receipts for reminders but still shows them', () => {
    const events = [
      start('u1'), progress('u1', 1, 100, 10, '110'),
      receipt('u1', 150, 20, '170', ['progress:u1:1'], {
        tokens: { input: 150, output: 20, basis: 'reported-partial' }, reminderValue: { basis: 'not-eligible' },
      }),
    ];
    const totals = counterTotals(aggregateSpend(events), emptySpendControl(), request);
    expect(totals.eligibleTokens).toBe(110);
    expect(totals.displayTokens).toBe(170);
    expect(totals.byClass['reported-partial'].tokens).toBe(60);
  });

  it('treats an open unit with exact progress as counted, and a gap as zero authority', () => {
    const events = [start('u1'), progress('u1', 1, 100, 10, '110'), start('u2', 1), stored({ kind: 'coverage-gap', usageUnitId: 'u2', requestId: 'req-1', reason: 'no-terminal-usage' })];
    const result = aggregateSpend(events);
    expect(result.units.get('u1')?.state).toBe('open');
    expect(result.units.get('u2')?.state).toBe('gap');
    expect(counterTotals(result, emptySpendControl(), request).eligibleTokens).toBe(110);
  });

  it('is idempotent for duplicate ids and quarantines conflicting ones', () => {
    const a = receipt('u1', 100, 0, '100');
    const duplicate = { segment: 'h2-0', event: { ...a.event, hostEpoch: 'h2', sequence: 99 } };
    const same = aggregateSpend([start('u1'), a, duplicate as StoredSpendEvent]);
    expect(counterTotals(same, emptySpendControl(), request).eligibleTokens).toBe(100);
    const conflicting = receipt('u1', 999, 0, '999');
    const conflicted = aggregateSpend([start('u1'), a, conflicting]);
    expect(conflicted.quarantined.has('usage:u1')).toBe(true);
    expect(counterTotals(conflicted, emptySpendControl(), request).eligibleTokens).toBe(0);
  });

  it('applies an adjustment only while the receipt still has the expected basis', () => {
    const base = receipt('u1', 100, 0, '0', [], {
      displayCost: { basis: 'unavailable' }, reminderValue: { tokens: 100, basis: 'reported-tokens' },
    });
    const adjust = (id: string, expected: 'unavailable' | 'account-coefficient', nano: string) => stored({
      kind: 'cost-adjustment', adjustmentId: id, receiptId: 'usage:u1', expectedCostBasis: expected,
      displayCost: { nanoUsd: nano, basis: 'account-coefficient', sourceId: 's2' },
      reminderValue: { tokens: 100, nanoUsd: nano, basis: 'exact-route' },
    }, { at: id === 'a1' ? '2026-09-27T10:01:00.000Z' : '2026-09-27T10:02:00.000Z' });
    const result = aggregateSpend([start('u1'), base, adjust('a1', 'unavailable', '500'), adjust('a2', 'unavailable', '900')]);
    expect(counterTotals(result, emptySpendControl(), request).eligibleNanoUsd).toBe(500n);
    expect(result.diagnostics.join(' ')).toMatch(/stale/);
  });

  it('orders a racing event against a reset by watermark, not by time', () => {
    const reset: CounterResetV1 = {
      resetId: 'r', scope: 'project-all', resetAt: '2026-09-27T12:00:00Z', actor: 'user',
      watermarks: { 'h1-0': 10 }, previousTotals: { eligibleTokens: 0, eligibleNanoUsd: '0', displayTokens: 0 },
    };
    expect(afterReset({ segment: 'h1-0', sequence: 10 }, reset)).toBe(false);
    expect(afterReset({ segment: 'h1-0', sequence: 11 }, reset)).toBe(true);
    expect(afterReset({ segment: 'h9-0', sequence: 1 }, reset)).toBe(true);
  });

  it('filters project and agent periods in the target zone', () => {
    const events = [
      stored({ kind: 'usage-unit-start', usageUnitId: 'a', requestId: 'r1', agentId: 'pm', connectionId: 'unode', modelId: 'm1', providerAttempts: 1 }, { at: '2026-09-27T06:00:00.000Z' }),
      receipt('a', 100, 0, '1', [], {}, 'r1', 'pm'),
      stored({ kind: 'usage-unit-start', usageUnitId: 'b', requestId: 'r2', agentId: 'worker', connectionId: 'unode', modelId: 'm1', providerAttempts: 1 }, { at: '2026-09-27T08:00:00.000Z' }),
      stored({ kind: 'usage-receipt', receipt: { ...(receipt('b', 50, 0, '1', [], {}, 'r2', 'worker').event as { receipt: UsageReceipt }).receipt } }, { at: '2026-09-27T08:00:00.000Z' }),
    ];
    // Receipts are dated by their own event time: 'a' is 10:00Z (Sep 27 in Vancouver), 'b' 08:00Z.
    const result = aggregateSpend(events);
    const project = { kind: 'project-period' as const, periodId: '2026-09-27@America/Vancouver', period: 'day' as const, timeZone: 'America/Vancouver' };
    expect(counterTotals(result, emptySpendControl(), project).eligibleTokens).toBe(150);
    const agent = { kind: 'agent-period' as const, agentId: 'worker', periodId: project.periodId, period: 'day' as const, timeZone: 'America/Vancouver' };
    expect(counterTotals(result, emptySpendControl(), agent).eligibleTokens).toBe(50);
    const reset: CounterResetV1 = {
      resetId: 'p1', scope: 'project-period', periodId: project.periodId, resetAt: '2026-09-27T12:00:00Z', actor: 'user',
      watermarks: result.watermarks, previousTotals: { eligibleTokens: 150, eligibleNanoUsd: '2', displayTokens: 150 },
    };
    // A project-period reset rebases that period's agent shares too.
    expect(counterEpochOf({ ...emptySpendControl(), resets: [reset] }, agent)).toBe('p1');
    expect(counterTotals(result, { ...emptySpendControl(), resets: [reset] }, agent).eligibleTokens).toBe(0);
  });
});

describe('display rows follow the final price (v0.9.89 field finding F1)', () => {
  const reference = { nanoUsd: '0', basis: 'unode-reference' as const, sourceId: 'unode-2026-09-27', sourceDate: '2026-09-27T21:13:20.000Z' };
  function referenceProgress(unit: string, attempt: number, input: number, output: number, nano: string) {
    return stored({
      kind: 'usage-progress', progressId: `progress:${unit}:${attempt}`, usageUnitId: unit, requestId: 'req-1', providerAttempt: attempt,
      tokens: { input, output, basis: 'reported' },
      displayCost: { ...reference, nanoUsd: nano },
      reminderValue: { tokens: input + output, basis: 'reported-tokens' },
    });
  }

  it('moves a turn re-priced by an adjustment to the adjusted row, with the adjusted total and no empty row', () => {
    // The field case: two responses priced at the reference, the receipt at the reference, then the post-turn
    // refresh finds the account price (here half the reference).
    const events = [
      start('u1', 1), referenceProgress('u1', 1, 6493, 68, '4431404'),
      start('u1', 2), referenceProgress('u1', 2, 6612, 151, '1399823'),
      receipt('u1', 13105, 219, '5831227', ['progress:u1:1', 'progress:u1:2'], {
        providerAttempts: 2,
        displayCost: { ...reference, nanoUsd: '5831227' },
        reminderValue: { tokens: 13324, basis: 'reported-tokens' },
      }),
      stored({
        kind: 'cost-adjustment', adjustmentId: 'adjust-1', receiptId: 'usage:u1', expectedCostBasis: 'unode-reference',
        displayCost: { nanoUsd: '2915613', basis: 'account-coefficient', sourceId: 'price-1:coefficient' },
        reminderValue: { tokens: 13324, nanoUsd: '2915613', basis: 'exact-route' },
      }),
    ];
    const totals = counterTotals(aggregateSpend(events), emptySpendControl(), request);
    expect(totals.byClass['exact-route']).toMatchObject({ tokens: 13324, nanoUsd: 2915613n, hasCost: true });
    expect(totals.byClass.reference.count).toBe(0);
    expect(totals.eligibleNanoUsd).toBe(2915613n);
    expect(totals.eligibleTokens).toBe(13324);
  });

  it('shows a billed receipt under Billed with the billed total, whatever its progress was priced at', () => {
    const events = [
      start('u1', 1), progress('u1', 1, 100, 10, '110'),
      start('u1', 2), progress('u1', 2, 200, 20, '220'),
      receipt('u1', 350, 40, '500', ['progress:u1:1', 'progress:u1:2'], {
        providerAttempts: 2,
        displayCost: { nanoUsd: '500', basis: 'billed', sourceId: 'provider' },
        reminderValue: { tokens: 390, nanoUsd: '500', basis: 'billed' },
      }),
    ];
    const totals = counterTotals(aggregateSpend(events), emptySpendControl(), request);
    expect(totals.byClass.billed).toMatchObject({ tokens: 390, nanoUsd: 500n });
    expect(totals.byClass['exact-route'].count).toBe(0);
  });

  it('keeps completed progress under its own label when the receipt is only partial', () => {
    const events = [
      start('u1', 1), progress('u1', 1, 100, 10, '110'),
      start('u1', 2),
      receipt('u1', 150, 30, '160', ['progress:u1:1'], { providerAttempts: 2, tokens: { input: 150, output: 30, basis: 'reported-partial' } }),
    ];
    const totals = counterTotals(aggregateSpend(events), emptySpendControl(), request);
    expect(totals.byClass['exact-route']).toMatchObject({ tokens: 110, nanoUsd: 110n });
    expect(totals.byClass['reported-partial']).toMatchObject({ tokens: 70 });
  });

  it('splits a re-priced turn across periods in proportion to its tokens, adding up to the final total', () => {
    const events = [
      start('u1', 1), referenceProgress('u1', 1, 300, 0, '999'),
      start('u1', 2),
      stored({
        kind: 'usage-progress', progressId: 'progress:u1:2', usageUnitId: 'u1', requestId: 'req-1', providerAttempt: 2,
        tokens: { input: 100, output: 0, basis: 'reported' }, displayCost: { ...reference, nanoUsd: '333' },
        reminderValue: { tokens: 100, basis: 'reported-tokens' },
      }, { at: '2026-09-28T10:00:00.000Z' }),
      receipt('u1', 400, 0, '1332', ['progress:u1:1', 'progress:u1:2'], {
        providerAttempts: 2,
        displayCost: { nanoUsd: '1000', basis: 'billed', sourceId: 'provider' },
        reminderValue: { tokens: 400, nanoUsd: '1000', basis: 'billed' },
      }),
    ];
    const result = aggregateSpend(events);
    const nanoOn = (day: string) => result.contributions
      .filter((contribution) => contribution.recordedAt.startsWith(day))
      .reduce((sum, contribution) => sum + (contribution.displayNano ?? 0n), 0n);
    expect(nanoOn('2026-09-27')).toBe(750n);
    expect(nanoOn('2026-09-28')).toBe(250n);
    expect(result.contributions.every((contribution) => contribution.displayClass === 'billed')).toBe(true);
  });
});

describe('alert ladder', () => {
  it('reaches 80, 100, 150, 200 and then the highest whole multiple', () => {
    expect(reachedThresholds(79n, 100n)).toEqual([]);
    expect(reachedThresholds(80n, 100n)).toEqual([80]);
    expect(reachedThresholds(100n, 100n)).toEqual([80, 100]);
    expect(reachedThresholds(199n, 100n)).toEqual([80, 100, 150]);
    expect(reachedThresholds(200n, 100n)).toEqual([80, 100, 150, 200]);
    // Only the highest multiple: the ones in between are never claimed or presented.
    expect(reachedThresholds(450n, 100n)).toEqual([80, 100, 150, 200, 400]);
  });

  it('has no upper bound: a far multiple is still a new, higher rung', () => {
    expect(reachedThresholds(12_345_600n, 100n).at(-1)).toBe(12_345_600);
    expect(reachedThresholds(12_345_700n, 100n).at(-1)).toBe(12_345_700);
    // Past 2^53 the rung is the nearest representable number: never lower than a smaller value's rung.
    const huge = 10n ** 30n;
    expect(reachedThresholds(huge + 100n, 1n).at(-1)!).toBeGreaterThanOrEqual(reachedThresholds(huge, 1n).at(-1)!);
  });

  it('splits a notice key into its counter and threshold', () => {
    const parts = { scopeKey: 'agent:qa', dimension: 'usd' as const, targetRevision: 'rev1', counterEpoch: 'reset-1', periodId: '2026-09-28@UTC' };
    const key = noticeKey({ ...parts, threshold: 400 });
    expect(parseNoticeKey(key)).toEqual({ counter: noticeCounterKey(parts), scopeKey: 'agent:qa', periodId: '2026-09-28@UTC', threshold: 400 });
    expect(parseNoticeKey('not-a-key')).toBeUndefined();
  });

  it('keys each appearance by revision, epoch and period, so a reset or target change starts again', () => {
    const base = { scopeKey: 'request:req-1', dimension: 'tokens' as const, targetRevision: 'rev1', counterEpoch: 'initial', threshold: 100 };
    expect(noticeKey(base)).not.toBe(noticeKey({ ...base, counterEpoch: 'r1' }));
    expect(noticeKey(base)).not.toBe(noticeKey({ ...base, targetRevision: 'rev2' }));
    expect(noticeKey(base)).not.toBe(noticeKey({ ...base, periodId: '2026-09-27@UTC' }));
  });
});
