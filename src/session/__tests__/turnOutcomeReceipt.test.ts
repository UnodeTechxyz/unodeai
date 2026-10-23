import { describe, expect, it } from 'vitest';
import {
  MAX_TURN_OUTCOME_COUNT,
  parseTurnOutcomeReceipt,
  restoredTurnDelivery,
  sameTurnOutcomeReceipt,
  TurnOutcomeAccumulator,
  turnOutcomeReceiptId,
  type TurnOutcomeReceiptV1,
} from '../turnOutcomeReceipt';

const TURN = {
  turnId: 'msg-1',
  agentId: 'dev',
  correlationId: 'thread-1',
  recordedAt: '2026-09-30T10:00:00.000Z',
  delivery: { kind: 'reply' as const },
};

function finish(accumulator: TurnOutcomeAccumulator, turn: Partial<typeof TURN> & { runId?: string } = {}): TurnOutcomeReceiptV1 {
  const receipt = accumulator.finish({ ...TURN, ...turn });
  expect(receipt).toBeDefined();
  return receipt!;
}

describe('TurnOutcomeAccumulator', () => {
  it('counts each call once by its typed fact, with complete coverage when every use has one result', () => {
    const turn = new TurnOutcomeAccumulator();
    for (const id of ['call-1', 'call-2', 'call-3', 'call-4', 'call-5']) turn.use(id);
    // Results arrive in any order.
    turn.result('call-3', { status: 'refused', observedBy: 'host', reason: 'consent' });
    turn.result('call-1', { status: 'success', observedBy: 'provider-protocol' });
    turn.result('call-5', { status: 'failed', observedBy: 'host', failureKind: 'outcome_unknown' });
    turn.result('call-2', { status: 'refused', observedBy: 'host', reason: 'consent' });
    turn.result('call-4', { status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' });

    expect(finish(turn, { runId: 'run-1' })).toEqual({
      schemaVersion: 1,
      receiptId: 'turn-outcome:msg-1',
      turnId: 'msg-1',
      agentId: 'dev',
      correlationId: 'thread-1',
      runId: 'run-1',
      recordedAt: '2026-09-30T10:00:00.000Z',
      delivery: { kind: 'reply' },
      tools: {
        coverage: 'complete',
        total: 5,
        success: 1,
        refused: 2,
        failed: 2,
        failureKinds: { error: 1, outcome_unknown: 1 },
        refusalReasons: { consent: 2 },
        unmatchedUses: 0,
        unmatchedResults: 0,
        excludedNativeActivities: 0,
        unjoinedHostDecisions: 0,
        observationGaps: 0,
      },
    });
  });

  it('records a turn without tools as complete with every count zero', () => {
    expect(finish(new TurnOutcomeAccumulator()).tools).toEqual({
      coverage: 'complete', total: 0, success: 0, refused: 0, failed: 0, failureKinds: {}, refusalReasons: {},
      unmatchedUses: 0, unmatchedResults: 0, excludedNativeActivities: 0, unjoinedHostDecisions: 0, observationGaps: 0,
    });
  });

  it('names a use without a result, a result without a use, and a duplicate result, counting each result once', () => {
    const turn = new TurnOutcomeAccumulator();
    turn.use('call-1');
    turn.use('call-2');
    turn.result('call-1', { status: 'success', observedBy: 'host' });
    // The same call again: a duplicated event, not a second success.
    turn.result('call-1', { status: 'success', observedBy: 'host' });
    // An ambiguous provider id gives its results fresh ids that no use carries: real results, unmatched.
    turn.result('call-7', { status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' });
    expect(finish(turn).tools).toMatchObject({
      coverage: 'partial', total: 2, success: 1, failed: 1, unmatchedUses: 1, unmatchedResults: 2,
    });
  });

  it('names a reused or invalid use id as unmatched', () => {
    const turn = new TurnOutcomeAccumulator();
    turn.use('call-1');
    turn.use('call-1');
    turn.use('not a valid id');
    turn.result('call-1', { status: 'success', observedBy: 'host' });
    turn.result('', { status: 'success', observedBy: 'host' });
    expect(finish(turn).tools).toMatchObject({ coverage: 'partial', total: 2, success: 2, unmatchedUses: 2, unmatchedResults: 1 });
  });

  it('makes coverage partial for an unjoined host decision and for native activity it does not mediate', () => {
    const gap = new TurnOutcomeAccumulator();
    gap.unjoinedHostDecision();
    expect(finish(gap).tools).toMatchObject({ coverage: 'partial', unjoinedHostDecisions: 1, total: 0 });

    const cut = new TurnOutcomeAccumulator();
    cut.observationGap();
    expect(finish(cut).tools).toMatchObject({ coverage: 'partial', observationGaps: 1, total: 0 });

    const native = new TurnOutcomeAccumulator();
    native.nativeActivity('inProgress');
    native.nativeActivity('completed');
    native.nativeActivity('inProgress');
    expect(finish(native).tools).toMatchObject({ coverage: 'partial', excludedNativeActivities: 2, total: 0 });
  });

  it('keeps the delivery outcome, including a bounded empty-reply attempt list', () => {
    const delivery = { kind: 'empty-reply' as const, attempts: [{ attempt: 1, gateway: 'g'.repeat(500), inputBasis: 'reported' as const, inputTokens: 12 }] };
    const receipt = finish(new TurnOutcomeAccumulator(), { delivery: delivery as never });
    expect(receipt.delivery).toEqual({ kind: 'empty-reply', attempts: [{ attempt: 1, gateway: 'g'.repeat(200), inputBasis: 'reported', inputTokens: 12 }] });
  });

  it('builds no receipt without a typed delivery outcome', () => {
    expect(new TurnOutcomeAccumulator().finish({ ...TURN, delivery: undefined as never })).toBeUndefined();
  });
});

describe('parseTurnOutcomeReceipt', () => {
  const receipt = (): TurnOutcomeReceiptV1 => {
    const turn = new TurnOutcomeAccumulator();
    turn.use('call-1');
    turn.result('call-1', { status: 'refused', observedBy: 'host', reason: 'trust' });
    return finish(turn, { runId: 'run-1' });
  };

  it('round-trips a receipt exactly, and the same facts compare equal', () => {
    const original = receipt();
    const restored = parseTurnOutcomeReceipt(JSON.parse(JSON.stringify(original)));
    expect(restored).toEqual(original);
    expect(sameTurnOutcomeReceipt(restored!, original)).toBe(true);
  });

  it('keeps only its own bounded fields: no tool name, call id, argument, output, path or prose survives', () => {
    const stored = {
      ...receipt(),
      toolNames: ['Bash'], summary: 'rm -rf build', detail: 'C:/secret/path', calls: [{ callId: 'call-1' }],
      tools: { ...receipt().tools, names: ['Bash'] },
    };
    const restored = parseTurnOutcomeReceipt(stored)!;
    expect(restored).toEqual(receipt());
    expect(JSON.stringify(restored)).not.toMatch(/Bash|rm -rf|secret|call-1/);
    const keys = (value: unknown): string[] => value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, entry]) => [key, ...keys(entry)])
      : [];
    expect(new Set(keys(restored))).toEqual(new Set([
      'schemaVersion', 'receiptId', 'turnId', 'agentId', 'correlationId', 'runId', 'recordedAt', 'delivery', 'kind', 'tools',
      'coverage', 'total', 'success', 'refused', 'failed', 'failureKinds', 'refusalReasons', 'trust',
      'unmatchedUses', 'unmatchedResults', 'excludedNativeActivities', 'unjoinedHostDecisions', 'observationGaps',
    ]));
  });

  it('rejects a receipt whose counts contradict each other rather than repairing it', () => {
    const base = receipt();
    for (const tools of [
      { ...base.tools, total: 2 },
      { ...base.tools, refusalReasons: {} },
      { ...base.tools, refusalReasons: { trust: 1, 'made-up': 1 } },
      { ...base.tools, coverage: 'partial' },
      { ...base.tools, unmatchedUses: 1 },
      { ...base.tools, observationGaps: 1 },
      { ...base.tools, observationGaps: undefined },
      { ...base.tools, success: -1 },
      { ...base.tools, success: MAX_TURN_OUTCOME_COUNT + 1 },
      { ...base.tools, failed: 1.5 },
    ]) {
      expect(parseTurnOutcomeReceipt({ ...base, tools })).toBeUndefined();
    }
  });

  it('rejects unbounded or mismatched identities and an unknown schema or delivery', () => {
    const base = receipt();
    expect(parseTurnOutcomeReceipt({ ...base, schemaVersion: 2 })).toBeUndefined();
    expect(parseTurnOutcomeReceipt({ ...base, receiptId: turnOutcomeReceiptId('other') })).toBeUndefined();
    expect(parseTurnOutcomeReceipt({ ...base, agentId: 'a b' })).toBeUndefined();
    expect(parseTurnOutcomeReceipt({ ...base, runId: 'x'.repeat(129) })).toBeUndefined();
    expect(parseTurnOutcomeReceipt({ ...base, recordedAt: 'yesterday' })).toBeUndefined();
    expect(parseTurnOutcomeReceipt({ ...base, delivery: { kind: 'answered' } })).toBeUndefined();
    expect(parseTurnOutcomeReceipt(undefined)).toBeUndefined();
    expect(parseTurnOutcomeReceipt([base])).toBeUndefined();
  });
});

describe('restoredTurnDelivery', () => {
  it('is typed from a receipt and legacy-unclassified without one, never read from text', () => {
    const receipt = finish(new TurnOutcomeAccumulator(), { delivery: { kind: 'tool-only' } as never });
    expect(restoredTurnDelivery(receipt)).toEqual({ classification: 'typed', outcome: { kind: 'tool-only' } });
    expect(restoredTurnDelivery(undefined)).toEqual({ classification: 'legacy-unclassified' });
  });
});
