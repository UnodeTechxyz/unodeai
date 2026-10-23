import { describe, expect, it } from 'vitest';
import { RequestCeilingGate, type RequestCeilingDecision } from '../RequestCeiling';
import { agentRequestBoundary } from '../RequestLimitBinding';

/* v0.9.94: the boundary a backend is handed, bound to the real gate the way the host binds it. */

function bound(options: { requestOf?: Record<string, string | undefined>; gateGone?: boolean } = {}) {
  const answers: Array<(decision: RequestCeilingDecision) => void> = [];
  const waits: string[] = [];
  const asked: string[] = [];
  const gate = new RequestCeilingGate({
    readLimits: () => ({ providerTurns: 1 }),
    decide: () => new Promise<RequestCeilingDecision>((resolve) => { answers.push(resolve); }),
    stopRequest: () => undefined,
    reachableRequests: () => new Set<string>(),
    timers: { set: () => 0, clear: () => undefined },
  });
  const requestOf = options.requestOf ?? { pm: 'request-1' };
  const boundary = (agentId: string) => agentRequestBoundary(agentId, {
    gate: () => (options.gateGone ? undefined : {
      governs: (requestId) => gate.governs(requestId),
      wouldHold: (requestId) => gate.wouldHold(requestId),
      boundary: (requestId, kind, signal, reserveFor) => {
        asked.push(`${requestId} ${kind} ${signal ? 'signal' : 'no-signal'}${reserveFor ? ` reserved for ${reserveFor}` : ''}`);
        return gate.boundary(requestId, kind, signal, reserveFor);
      },
    }),
    currentRequestId: (id) => requestOf[id],
    personWait: async (id, wait) => {
      waits.push(`start ${id}`);
      try {
        return await wait();
      } finally {
        waits.push(`end ${id}`);
      }
    },
  });
  return { gate, answers, waits, asked, boundary };
}

describe('the request boundary of one agent', () => {
  it('proceeds without asking the gate for a request that has no limit, and for an agent in no turn', async () => {
    const { gate, asked, waits, boundary } = bound({ requestOf: { pm: 'unlimited', idle: undefined } });
    gate.begin('request-1');

    expect(await boundary('pm')('provider-request')).toBe('proceed');
    expect(await boundary('idle')('effect', { tool: 'write_file' })).toBe('proceed');
    expect(asked).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('proceeds when the host has no gate', async () => {
    const { asked, boundary } = bound({ gateGone: true });
    expect(await boundary('pm')('effect')).toBe('proceed');
    expect(asked).toEqual([]);
  });

  it('asks the gate about the request of the turn that is running when the call is made', async () => {
    const requestOf: Record<string, string | undefined> = { pm: 'request-1' };
    const { gate, asked, waits, boundary } = bound({ requestOf });
    gate.begin('request-1');
    gate.begin('request-2');
    const ask = boundary('pm');

    expect(await ask('provider-request')).toBe('proceed');
    // The same backend, later, in a turn of another request.
    requestOf.pm = 'request-2';
    expect(await ask('effect')).toBe('proceed');
    expect(asked).toEqual(['request-1 provider-request no-signal reserved for pm', 'request-2 effect no-signal']);
    // Inside the limits nothing waits, so nobody's clock is touched.
    expect(waits).toEqual([]);
  });

  it('counts a held boundary as the person\'s wait for exactly as long as it is held', async () => {
    const { gate, answers, waits, boundary } = bound();
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const held = boundary('pm')('effect');
    await Promise.resolve();

    expect(waits).toEqual(['start pm']);
    answers[0]('continue');
    expect(await held).toBe('proceed');
    expect(waits).toEqual(['start pm', 'end pm']);
    // The allowance was raised and a call that acts used none of it: the model request that follows is inside
    // it, takes it as it crosses, and waits for nobody.
    expect(await boundary('pm')('provider-request')).toBe('proceed');
    expect(waits).toEqual(['start pm', 'end pm']);
    expect(gate.wouldHold('request-1')).toBe(true);
  });

  it('hands the caller\'s signal to the gate, so a stopped turn is released and its wait ends', async () => {
    const { gate, asked, waits, boundary } = bound();
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const turn = new AbortController();
    const held = boundary('pm')('effect', { tool: 'run_command', signal: turn.signal });
    await Promise.resolve();
    turn.abort();

    expect(await held).toBe('stopped');
    expect(asked).toEqual(['request-1 effect signal']);
    expect(waits).toEqual(['start pm', 'end pm']);
  });

  it('reserves a model request for its agent as it crosses, so a teammate asking at the same count is held', async () => {
    const { gate, waits, boundary } = bound({ requestOf: { dev: 'request-1', reviewer: 'request-1' } });
    gate.begin('request-1');
    // Limit 1, nothing counted yet, and two teammates ask before either request has left.
    const first = boundary('dev')('provider-request');
    const second = boundary('reviewer')('provider-request');
    await Promise.resolve();

    expect(await first).toBe('proceed');
    expect(waits).toEqual(['start reviewer']);
    expect(gate.facts('request-1')).toMatchObject({ providerTurns: { ceiling: 1, observed: 1 }, decision: 'awaiting' });
    // The first agent's turn ends before its request left: what it reserved is given back.
    gate.release('request-1', 'dev');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(0);
    void second;
  });

  it('refuses the boundary of a request that was stopped, without a wait', async () => {
    const { gate, answers, waits, boundary } = bound();
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const held = boundary('pm')('effect');
    await Promise.resolve();
    answers[0]('stop');
    expect(await held).toBe('stopped');

    expect(await boundary('pm')('provider-request')).toBe('stopped');
    expect(waits).toEqual(['start pm', 'end pm']);
  });
});
