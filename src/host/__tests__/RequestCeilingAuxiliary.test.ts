import { describe, expect, it } from 'vitest';
import { MAX_TRACKED_REQUESTS, RequestCeilingGate, type RequestCeilingDecision, type RequestLimits } from '../RequestCeiling';
import { RequestLimitMeter } from '../RequestLimitMeter';

/*
 * v0.9.110: an auxiliary request (a reply suggestion) uses the root request's remaining tranche and never touches a
 * Continue decision. The real gate and the real meter are used together, as the host wires them.
 */

function harness(limits: RequestLimits) {
  const decisions: Array<{ answer(decision: RequestCeilingDecision): void }> = [];
  const reachable = new Set<string>();
  let asked = 0;
  const gate = new RequestCeilingGate({
    readLimits: () => limits,
    decide: () => {
      asked += 1;
      return new Promise<RequestCeilingDecision>((resolve) => decisions.push({ answer: resolve }));
    },
    stopRequest: () => undefined,
    reachableRequests: () => reachable,
    timers: { set: () => 0, clear: () => undefined },
  });
  const meter = new RequestLimitMeter(gate, () => false);
  return { gate, meter, decisions, reachable, decisionsAsked: () => asked };
}

/** The host's order for one suggestion: reserve, confirm immediately before sending, count the request, settle. */
function sendAuxiliary(h: ReturnType<typeof harness>, requestId: string, usageUnitId: string, tokens = { inputTokens: 10, outputTokens: 5 }) {
  const reserved = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent(requestId), usageUnitId);
  if (!reserved.ok) return { sent: false as const, reason: reserved.reason };
  const { reservation } = reserved;
  h.meter.beginUsageUnit({ usageUnitId, requestId, agentId: reservation.meterAgentId }, 'request');
  if (!reservation.confirmBeforeSend()) {
    h.meter.closeUsageUnit(usageUnitId);
    return { sent: false as const, reason: 'confirm' as const };
  }
  h.meter.noteModelRequest(usageUnitId);
  h.meter.settleUsageUnit(usageUnitId, tokens);
  reservation.end();
  return { sent: true as const };
}

describe('RequestCeilingGate.tryReserveAuxiliary', () => {
  it('counts a suggestion once against the root tranche, as one provider request and its actual tokens', () => {
    const h = harness({ providerTurns: 5, tokens: 1_000 });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    expect(sendAuxiliary(h, 'r1', 'u-aux')).toEqual({ sent: true });
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 2 }, tokens: { observed: 15 }, decision: 'none' });
    expect(h.decisionsAsked()).toBe(0);
  });

  it('sends nothing and asks nothing when the root has reached its limit', () => {
    const h = harness({ providerTurns: 1 });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    expect(sendAuxiliary(h, 'r1', 'u-aux')).toEqual({ sent: false, reason: 'limit-reached' });
    expect(h.decisionsAsked()).toBe(0);
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 1 }, decision: 'none', crossings: 0 });
  });

  it('never joins, holds or answers an open Continue decision; a later Continue does not revive it', async () => {
    const h = harness({ providerTurns: 1 });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    const held = h.gate.boundary('r1', 'provider-request', undefined, 'pm');
    expect(h.decisions).toHaveLength(1);
    expect(sendAuxiliary(h, 'r1', 'u-aux')).toEqual({ sent: false, reason: 'awaiting-decision' });
    // Still one decision, and nothing of the suggestion is held behind it.
    expect(h.decisions).toHaveLength(1);
    h.decisions[0].answer('continue');
    expect(await held).toBe('proceed');
    // The main request's held step used the new tranche; the skipped suggestion is not re-sent by anybody.
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 2 }, allowances: 1, decision: 'continued' });
  });

  it('refuses a stopped root and an unknown token total under a token limit', () => {
    const stopped = harness({ providerTurns: 1 });
    stopped.gate.begin('r1');
    stopped.gate.noteProviderRequest('r1', 'pm', 'request');
    void stopped.gate.boundary('r1', 'provider-request');
    stopped.decisions[0].answer('stop');
    return Promise.resolve().then(() => {
      expect(sendAuxiliary(stopped, 'r1', 'u-aux')).toEqual({ sent: false, reason: 'stopped' });
      const unknown = harness({ tokens: 1_000 });
      unknown.gate.begin('r2');
      unknown.gate.markUsageIncomplete('r2');
      expect(sendAuxiliary(unknown, 'r2', 'u-aux2')).toEqual({ sent: false, reason: 'usage-unknown' });
    });
  });

  it('re-checks the shared meter before sending: a reservation overtaken by the main request is given back', () => {
    const h = harness({ tokens: 100 });
    h.gate.begin('r1');
    const reserved = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent('r1'), 'u-aux');
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    // The main request's usage arrives between the reservation and the send, and reaches the limit.
    h.gate.settleUsage('r1', 'u-main', { input: 90, output: 10 });
    expect(reserved.reservation.confirmBeforeSend()).toBe(false);
    expect(h.gate.facts('r1')).toMatchObject({ tokens: { observed: 100 }, decision: 'none' });
    expect(h.decisionsAsked()).toBe(0);
  });

  it('gives back a reservation that was cancelled before it was sent', () => {
    const h = harness({ providerTurns: 2 });
    h.gate.begin('r1');
    const reserved = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent('r1'), 'u-aux');
    if (!reserved.ok) throw new Error('expected a reservation');
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 1 } });
    reserved.reservation.release();
    expect(h.gate.facts('r1')).toMatchObject({ providerTurns: { observed: 0 } });
    expect(reserved.reservation.confirmBeforeSend()).toBe(false);
  });

  it('two callers at the last allowance cannot both reserve it', () => {
    const h = harness({ providerTurns: 2 });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    const first = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent('r1'), 'u-a');
    const second = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent('r1'), 'u-b');
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'limit-reached' });
  });

  it('adds no limit to a request that has none, and still gives a separate unit key', () => {
    const h = harness({});
    h.gate.begin('r1');
    const reserved = h.gate.tryReserveAuxiliary(h.gate.pinAuxiliaryParent('r1'), 'u-aux');
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.reservation.meterAgentId).toBe('aux:u-aux');
    expect(reserved.reservation.confirmBeforeSend()).toBe(true);
    expect(h.gate.governs('r1')).toBe(false);
  });

  it('keeps the root while a suggestion is open, so usage arriving after the closeout still counts', () => {
    const h = harness({ tokens: 10_000 });
    h.gate.begin('r-root');
    const pin = h.gate.pinAuxiliaryParent('r-root');
    const reserved = h.gate.tryReserveAuxiliary(pin, 'u-aux');
    if (!reserved.ok) throw new Error('expected a reservation');
    h.meter.beginUsageUnit({ usageUnitId: 'u-aux', requestId: 'r-root', agentId: reserved.reservation.meterAgentId }, 'request');
    expect(reserved.reservation.confirmBeforeSend()).toBe(true);
    h.meter.noteModelRequest('u-aux');
    // The root request is over (nothing can continue it) and the gate fills up to its bound.
    for (let i = 0; i < MAX_TRACKED_REQUESTS; i += 1) h.gate.begin(`other-${i}`);
    expect(h.gate.governs('r-root')).toBe(true);
    h.meter.settleUsageUnit('u-aux', { inputTokens: 40, outputTokens: 2 });
    expect(h.gate.facts('r-root')).toMatchObject({ tokens: { observed: 42 } });
    reserved.reservation.end();
    pin.release();
    for (let i = 0; i < MAX_TRACKED_REQUESTS; i += 1) h.gate.begin(`later-${i}`);
    expect(h.gate.governs('r-root')).toBe(false);
  });

  it('refuses after the host is shutting down', () => {
    const h = harness({});
    h.gate.begin('r1');
    const pin = h.gate.pinAuxiliaryParent('r1');
    h.gate.dispose();
    expect(h.gate.tryReserveAuxiliary(pin, 'u-aux')).toEqual({ ok: false, reason: 'disposed' });
  });

  // Codex audit F4: a parent whose budget record is gone is not an unlimited parent.
  it('refuses a parent the gate never began, or forgot, instead of treating it as unlimited', () => {
    const h = harness({ providerTurns: 1 });
    expect(h.gate.pinAuxiliaryParent('never-begun').state).toBe('unavailable');
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    // The exhausted parent is over and the bounded cleanup forgets it.
    for (let i = 0; i <= MAX_TRACKED_REQUESTS; i += 1) h.gate.begin(`later-${i}`);
    expect(h.gate.governs('r1')).toBe(false);
    const pin = h.gate.pinAuxiliaryParent('r1');
    expect(pin.state).toBe('unavailable');
    expect(h.gate.tryReserveAuxiliary(pin, 'u-aux')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a pin taken when the suggestion is offered keeps a limited parent through its closeout cleanup', () => {
    const h = harness({ providerTurns: 1 });
    h.gate.begin('r1');
    h.gate.noteProviderRequest('r1', 'pm', 'request');
    const pin = h.gate.pinAuxiliaryParent('r1');
    expect(pin.state).toBe('limited');
    for (let i = 0; i <= MAX_TRACKED_REQUESTS; i += 1) h.gate.begin(`later-${i}`);
    expect(h.gate.governs('r1')).toBe(true);
    // Still the parent's pinned budget: exhausted, so nothing is sent, and no decision is opened.
    expect(h.gate.tryReserveAuxiliary(pin, 'u-aux')).toEqual({ ok: false, reason: 'limit-reached' });
    expect(h.decisionsAsked()).toBe(0);
    pin.release();
    for (let i = 0; i <= MAX_TRACKED_REQUESTS; i += 1) h.gate.begin(`again-${i}`);
    expect(h.gate.governs('r1')).toBe(false);
  });

  it('a parent begun with no limit is proven unlimited, and no limit is invented for it', () => {
    const h = harness({});
    h.gate.begin('free');
    const pin = h.gate.pinAuxiliaryParent('free');
    expect(pin.state).toBe('unlimited');
    for (let i = 0; i < 5; i += 1) {
      const reserved = h.gate.tryReserveAuxiliary(pin, `u-${i}`);
      expect(reserved.ok && reserved.reservation.confirmBeforeSend()).toBe(true);
    }
  });
});
