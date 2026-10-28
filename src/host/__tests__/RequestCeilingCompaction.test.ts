import { describe, expect, it } from 'vitest';
import type { TurnUsage } from '../../backend/AgentBackend';
import { compactionUsageSink } from '../../compaction/CompactionUsage';
import type { SummarizableRecord } from '../../compaction/HistoryCompactionPlanner';
import { MapReduceSummarizer, type SummaryIO } from '../../compaction/MapReduceSummarizer';
import { sendSummaryRequest } from '../../compaction/SummaryRequest';
import { RequestCeilingGate, type RequestCeilingDecision, type RequestCeilingDecisionFacts, type RequestLimits } from '../RequestCeiling';
import { agentRequestBoundary } from '../RequestLimitBinding';
import { RequestLimitMeter } from '../RequestLimitMeter';

/* v0.9.94: one compaction makes several summary requests, some of them at the same time. Each is a model
   request of the request it compacts for. This binds the real summarizer, the real summary request and the real
   gate the way the host binds them, and counts what actually leaves. */

const REQUEST = 'request-1';
const AGENT = 'pm';

function records(count: number, chars: number): SummarizableRecord[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `${i}:`.padEnd(chars, 'w') }));
}

interface OpenPrompt {
  facts: RequestCeilingDecisionFacts;
  /** How many summary requests had left when the person was asked. */
  leftWhenAsked: number;
  answer(decision: RequestCeilingDecision): void;
}

function compaction(limits: RequestLimits) {
  const prompts: OpenPrompt[] = [];
  const stops: string[] = [];
  let left = 0;
  const turn = new AbortController();
  const gate = new RequestCeilingGate({
    readLimits: () => limits,
    decide: (facts) => new Promise<RequestCeilingDecision>((resolve) => { prompts.push({ facts, leftWhenAsked: left, answer: resolve }); }),
    // The host's ordinary stop path ends the turn, and with it the compaction that was preparing it.
    stopRequest: (requestId) => {
      stops.push(requestId);
      turn.abort();
    },
    reachableRequests: () => new Set([REQUEST]),
    timers: { set: () => 0, clear: () => undefined },
  });
  gate.begin(REQUEST);
  const boundary = agentRequestBoundary(AGENT, {
    gate: () => gate,
    currentRequestId: () => REQUEST,
    personWait: (_agentId, wait) => wait(),
  });
  // The host sends each summary request itself: counted one by one, whatever route the agent is on.
  const meter = new RequestLimitMeter(gate, () => true);
  const usage = compactionUsageSink({
    beginUsageUnit: (unit) => meter.beginUsageUnit(unit, 'request'),
    noteModelRequest: (usageUnitId) => meter.noteModelRequest(usageUnitId),
    settleUsageUnit: (usageUnitId, reported) => meter.settleUsageUnit(usageUnitId, reported),
  }, { operationId: 'op-1', requestId: REQUEST, agentId: AGENT });
  const io: SummaryIO = {
    async chatCompletion(messages, _model, _params, signal, onRequestSent) {
      await sendSummaryRequest({
        url: 'https://gw.example/v1/chat/completions', apiKey: 'k', body: { messages },
        scope: { profileId: 'unode', profileRevision: 1 },
        ...(signal ? { signal } : {}),
        ...(onRequestSent ? { onRequestSent } : {}),
      }, {
        approveEgress: async () => undefined,
        fetch: async () => {
          left += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { ok: true, status: 200, text: async () => '{}' };
        },
        requestBoundary: (boundarySignal) => boundary('provider-request', boundarySignal ? { signal: boundarySignal } : {}),
      });
      const text = messages[0].content.startsWith('You merge') ? 'merged summary' : `partial ${messages[1].content.length}`;
      const reported: TurnUsage = { inputTokens: 100, outputTokens: 10, usageBasis: 'reported' };
      return { text, usage: reported };
    },
  };
  const run = () => new MapReduceSummarizer().summarizeChunks({
    io, model: 'eco', contextWindow: 40_000, records: records(80, 6_000), usage, signal: turn.signal,
  });
  return { gate, prompts, stops, run, left: () => left };
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000 && !condition(); turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}

describe('a compaction of several summary requests and a request limit', () => {
  it('needs more requests than the limit used below, so the limit is crossed inside the compaction', async () => {
    const { run, left, prompts } = compaction({ providerTurns: 1_000 });
    const result = await run();
    expect(result).toMatchObject({ ok: true, summary: 'merged summary' });
    expect(left()).toBeGreaterThanOrEqual(5);
    expect(prompts).toHaveLength(0);
  });

  it('lets exactly the allowed summary requests leave and holds the rest behind one decision', async () => {
    const { gate, prompts, run, left } = compaction({ providerTurns: 2 });
    const running = run();
    await until(() => prompts.length === 1);
    // Three were about to go at once. Two crossed, each counted as it crossed; nothing else left meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(left()).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts).toMatchObject({
      reached: [{ limit: 'providerTurns', configured: 2, allowance: 2, observed: 2 }],
      limits: { heldBoundary: 'provider-request', decision: 'awaiting' },
    });

    prompts[0].answer('stop');
    expect(await running).toMatchObject({ ok: false });
    expect(left()).toBe(2);
    expect(gate.facts(REQUEST)).toMatchObject({ providerTurns: { ceiling: 2, observed: 2 }, decision: 'stopped' });
  });

  it('after each Continue lets one more allowance leave and no more, to the end of the compaction', async () => {
    const unlimited = compaction({ providerTurns: 1_000 });
    await unlimited.run();
    const needed = unlimited.left();

    const { gate, prompts, stops, run, left } = compaction({ providerTurns: 2 });
    const running = run();
    let answered = 0;
    let finished = false;
    void running.then(() => { finished = true; });
    while (!finished) {
      await until(() => finished || prompts.length > answered);
      if (finished) break;
      // Whenever the person is asked, no more requests have left than the allowance at that moment.
      expect(prompts[answered].leftWhenAsked).toBeLessThanOrEqual(2 * (answered + 1));
      expect(prompts[answered].facts.reached[0]).toMatchObject({ limit: 'providerTurns', allowance: 2 * (answered + 1) });
      prompts[answered].answer('continue');
      answered += 1;
    }

    expect(await running).toMatchObject({ ok: true, summary: 'merged summary' });
    expect(left()).toBe(needed);
    expect(stops).toEqual([]);
    // Every request that left was counted once, and each tranche needed its own answer.
    expect(gate.facts(REQUEST)).toMatchObject({ providerTurns: { ceiling: 2, observed: needed }, allowances: answered, decision: 'continued' });
    expect(answered).toBe(Math.ceil(needed / 2) - 1);
  });
});
