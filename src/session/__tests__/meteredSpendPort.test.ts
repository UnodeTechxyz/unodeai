import { describe, expect, it } from 'vitest';
import { RequestLimitMeter } from '../../host/RequestLimitMeter';
import { meteredSpendPort } from '../meteredSpendPort';
import type { SpendSessionPort } from '../SessionManager';

/* v0.9.94: the spend port a session uses, with every usage call also shown to the request limit meter. */

function metered() {
  const calls: string[] = [];
  const settled = { costUsd: 0.25, costBasis: 'estimated' as const };
  const spend: SpendSessionPort = {
    beginRequest: (requestId, rootAgentId) => { calls.push(`spend beginRequest ${requestId} ${rootAgentId}`); },
    beginUsageUnit: (unit) => { calls.push(`spend beginUsageUnit ${unit.usageUnitId} ${unit.requestId} ${unit.agentId} ${unit.modelId}`); },
    noteModelRequest: (usageUnitId) => { calls.push(`spend noteModelRequest ${usageUnitId}`); },
    noteUsageProgress: (usageUnitId, progress) => { calls.push(`spend noteUsageProgress ${usageUnitId} ${progress.attempt}`); },
    settleUsageUnit: (usageUnitId) => { calls.push(`spend settleUsageUnit ${usageUnitId}`); return settled; },
    closeUsageUnit: (usageUnitId) => { calls.push(`spend closeUsageUnit ${usageUnitId}`); },
  };
  const meter = new RequestLimitMeter({
    governs: () => true,
    noteProviderRequest: (requestId, agentId, counted) => { calls.push(`limit ${counted} ${requestId} by ${agentId}`); },
    noteUsage: (requestId, usageUnitId, counts) => { calls.push(`limit usage ${requestId} ${usageUnitId} ${counts.input}+${counts.output}`); },
    settleUsage: (requestId, usageUnitId, counts) => {
      calls.push(counts ? `limit settled ${requestId} ${usageUnitId} ${counts.input}+${counts.output}` : `limit ended ${requestId} ${usageUnitId}`);
    },
    markUsageIncomplete: (requestId) => { calls.push(`limit incomplete ${requestId}`); },
  }, () => false);
  return { calls, settled, port: meteredSpendPort(spend, meter) };
}

describe('the metered spend port', () => {
  it('shows every usage call to the limit meter first and then to the spend port, unchanged', () => {
    const { calls, port } = metered();
    port.beginRequest('req', 'pm');
    port.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'pm', modelId: 'model-a' });
    port.noteModelRequest('u1');
    port.noteUsageProgress('u1', { attempt: 1, inputTokens: 100, outputTokens: 10 });
    port.settleUsageUnit('u1', { inputTokens: 120, outputTokens: 12 });

    expect(calls).toEqual([
      'spend beginRequest req pm',
      'spend beginUsageUnit u1 req pm model-a',
      'limit request req by pm',
      'spend noteModelRequest u1',
      'limit usage req u1 100+10',
      'spend noteUsageProgress u1 1',
      'limit settled req u1 120+12',
      'spend settleUsageUnit u1',
    ]);
  });

  it('returns what the spend port returned for a settled unit', () => {
    const { port, settled } = metered();
    port.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'pm', modelId: 'model-a' });
    port.noteModelRequest('u1');

    expect(port.settleUsageUnit('u1', { inputTokens: 1, outputTokens: 1 })).toBe(settled);
  });

  it('marks the request incomplete when a unit that made a request is closed without usage', () => {
    const { calls, port } = metered();
    port.beginUsageUnit({ usageUnitId: 'u1', requestId: 'req', agentId: 'pm', modelId: 'model-a' });
    port.noteModelRequest('u1');
    port.closeUsageUnit('u1');

    expect(calls.slice(-3)).toEqual(['limit ended req u1', 'limit incomplete req', 'spend closeUsageUnit u1']);
  });
});
