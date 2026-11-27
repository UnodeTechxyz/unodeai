import { describe, expect, it } from 'vitest';
import { MAX_METERED_UNITS, RequestLimitMeter, type RequestLimitTotals } from '../RequestLimitMeter';

/* v0.9.94: the meter turns the usage calls of a turn into the totals a request limit is checked against. */

/** Agents named `cli-...` stand for a route where a CLI makes the model requests inside a turn. */
function totals(governed: string[] = ['req']) {
  const calls: string[] = [];
  const port: RequestLimitTotals = {
    governs: (requestId) => governed.includes(requestId),
    noteProviderRequest: (requestId, agentId, counted) => { calls.push(`${counted} ${requestId} by ${agentId}`); },
    noteUsage: (requestId, usageUnitId, counts) => { calls.push(`usage ${requestId} ${usageUnitId} ${counts.input}+${counts.output}`); },
    settleUsage: (requestId, usageUnitId, counts) => {
      calls.push(counts ? `settled ${requestId} ${usageUnitId} ${counts.input}+${counts.output}` : `ended ${requestId} ${usageUnitId}`);
    },
    markUsageIncomplete: (requestId) => { calls.push(`incomplete ${requestId}`); },
  };
  return { calls, meter: new RequestLimitMeter(port, (agentId) => agentId.startsWith('cli-')) };
}

describe('request limit meter', () => {
  it('counts each model request of a unit as one provider request of its request', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.noteModelRequest('u1');
    meter.noteModelRequest('u1');

    expect(calls).toEqual(['request req by dev', 'request req by dev']);
  });

  it('counts a unit of an agent on a CLI route as turns, unless the host sends the requests of that unit itself', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'cli-pm' });
    meter.noteModelRequest('u1');
    // A summary request the host sends for that agent is one request, whatever route the agent is on.
    meter.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req', agentId: 'cli-pm' }, 'request');
    meter.noteModelRequest('u2');

    expect(calls).toEqual(['turn req by cli-pm', 'request req by cli-pm']);
  });

  it('keeps nothing for a request that has no limit', () => {
    const { calls, meter } = totals([]);
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.noteModelRequest('u1');
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    meter.settleUsageUnit('u1', { inputTokens: 100, outputTokens: 10 });
    meter.closeUsageUnit('u1');

    expect(calls).toEqual([]);
  });

  it('reports the running total of a unit as the sum over its attempts, each attempt once', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.noteModelRequest('u1');
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    meter.noteModelRequest('u1');
    meter.noteUsageProgress('u1', { attempt: 2, inputTokens: 250, outputTokens: 40 });
    // The same attempt reported again adds nothing.
    meter.noteUsageProgress('u1', { attempt: 2, inputTokens: 250, outputTokens: 40 });

    expect(calls.filter((call) => call.startsWith('usage'))).toEqual(['usage req u1 100+10', 'usage req u1 350+50']);
  });

  it('ignores progress that names no attempt the unit made, and a figure that is not a count', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.noteModelRequest('u1');
    meter.noteUsageProgress('u1', { attempt: 2, inputTokens: 100, outputTokens: 10 });
    meter.noteUsageProgress('u1', { attempt: 0, inputTokens: 100, outputTokens: 10 });
    meter.noteUsageProgress('u1', { attempt: 1.5, inputTokens: 100, outputTokens: 10 });
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: Number.NaN, outputTokens: 10 });
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: -1 });

    expect(calls).toEqual(['request req by dev']);
    // The attempt is still open for a figure that is a count.
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    expect(calls.at(-1)).toBe('usage req u1 100+10');
  });

  it('replaces the progress sum with the terminal usage, which covers the whole unit', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.noteModelRequest('u1');
    meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    meter.settleUsageUnit('u1', { inputTokens: 420, outputTokens: 61 });

    expect(calls.at(-1)).toBe('settled req u1 420+61');
    // The unit is over: nothing later is counted under it.
    meter.noteModelRequest('u1');
    meter.closeUsageUnit('u1');
    expect(calls).toHaveLength(3);
  });

  it('counts one provider request for usage that arrived without an observed request start', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.settleUsageUnit('u1', { inputTokens: 30, outputTokens: 5 });

    expect(calls).toEqual(['request req by dev', 'settled req u1 30+5']);
  });

  it('marks the request incomplete when a unit that made a request ends without usable usage', () => {
    const settled = totals();
    settled.meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    settled.meter.noteModelRequest('u1');
    settled.meter.settleUsageUnit('u1', undefined);
    expect(settled.calls).toEqual(['request req by dev', 'ended req u1', 'incomplete req']);

    const unusable = totals();
    unusable.meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    unusable.meter.noteModelRequest('u1');
    unusable.meter.settleUsageUnit('u1', { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 5 });
    expect(unusable.calls).toEqual(['request req by dev', 'ended req u1', 'incomplete req']);

    const closed = totals();
    closed.meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    closed.meter.noteModelRequest('u1');
    closed.meter.closeUsageUnit('u1');
    expect(closed.calls).toEqual(['request req by dev', 'ended req u1', 'incomplete req']);
  });

  it('reports no gap for a unit that never made a request', () => {
    const { calls, meter } = totals();
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });
    meter.closeUsageUnit('u1');
    meter.beginUsageUnit({ usageUnitId: 'u2', requestId: 'req', agentId: 'dev' });
    meter.settleUsageUnit('u2', undefined);

    // Each unit is handed back as over, and neither is a gap.
    expect(calls).toEqual(['ended req u1', 'ended req u2']);
  });

  it('keeps the units of two requests apart', () => {
    const { calls, meter } = totals(['a', 'b']);
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'a', agentId: 'dev' });
    meter.beginUsageUnit({ usageUnitId: 'u2', requestId: 'b', agentId: 'dev' });
    meter.noteModelRequest('u2');
    meter.noteModelRequest('u1');
    meter.settleUsageUnit('u2', { inputTokens: 7, outputTokens: 1 });

    expect(calls).toEqual(['request b by dev', 'request a by dev', 'settled b u2 7+1']);
  });

  it('ends the oldest unit as unknown usage when more are open than it keeps', () => {
    const { calls, meter } = totals(['old', 'new']);
    meter.beginUsageUnit({ usageUnitId: 'first', requestId: 'old', agentId: 'dev' });
    for (let index = 0; index < MAX_METERED_UNITS - 1; index += 1) {
      meter.beginUsageUnit({ usageUnitId: `u${index}`, requestId: 'new', agentId: 'dev' });
    }
    expect(calls).toEqual([]);

    meter.beginUsageUnit({ usageUnitId: 'one-more', requestId: 'new', agentId: 'dev' });
    expect(calls).toEqual(['ended old first', 'incomplete old']);
    // The dropped unit is gone: a late call of it is not counted.
    meter.noteModelRequest('first');
    expect(calls).toEqual(['ended old first', 'incomplete old']);
  });

  it('never lets a failure of the totals reach the caller', () => {
    const meter = new RequestLimitMeter({
      governs: () => true,
      noteProviderRequest: () => { throw new Error('totals failed'); },
      noteUsage: () => { throw new Error('totals failed'); },
      settleUsage: () => { throw new Error('totals failed'); },
      markUsageIncomplete: () => { throw new Error('totals failed'); },
    }, () => false);
    meter.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' });

    expect(() => meter.noteModelRequest('u1')).not.toThrow();
    expect(() => meter.noteUsageProgress('u1', { attempt: 1, inputTokens: 1, outputTokens: 1 })).not.toThrow();
    expect(() => meter.settleUsageUnit('u1', undefined)).not.toThrow();
    const failing = new RequestLimitMeter({
      governs: () => { throw new Error('totals failed'); },
      noteProviderRequest: () => undefined, noteUsage: () => undefined, settleUsage: () => undefined, markUsageIncomplete: () => undefined,
    }, () => { throw new Error('roster failed'); });
    expect(() => failing.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'dev' })).not.toThrow();
  });
});
