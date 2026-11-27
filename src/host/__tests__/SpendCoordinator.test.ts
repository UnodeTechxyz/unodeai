import { describe, expect, it, vi } from 'vitest';
import { rowCostText, SpendAlert, SpendCoordinator, SpendCoordinatorDeps, SpendRoute } from '../SpendCoordinator';
import { MemorySpendLedger, SpendEventRejectedError, SpendLedger } from '../../state/SpendStore';
import { catalogFromNewApiPricing } from '../../models/spend/PriceCatalog';
import { gatewayCandidates, gatewaySnapshotFromPricing, PriceCandidate, StoredReferencePriceMode } from '../../models/spend/PriceResolver';
import { parseRepositoryBudget, parseUserTargets, UserTargets } from '../../models/spend/SpendTargets';
import { noticeKey } from '../../models/spend/SpendAggregate';
import { StoredSpendEvent } from '../../models/spend/SpendTypes';
import { unodeSearchCost } from '../../backend/UnodeSearchPricing';
import { TranscriptionHost, type TranscriptionOperation } from '../../media/TranscriptionHost';
import { UNODE_DEFAULT_BASE_URL } from '../../backend/openAICompatBaseUrl';
import { createPaidToolAccounting } from '../PaidToolAccounting';
import { RequestCeilingGate } from '../RequestCeiling';
import { RequestLimitMeter } from '../RequestLimitMeter';
import { agentRequestBoundary } from '../RequestLimitBinding';

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
  it.each([false, true])('accounts for each sent audio part when the last part is held: %s', async stopAtLimit => {
    const h = harness();
    h.setMode('unode');
    const requestId = 'audio-request';
    const agentId = 'researcher';
    const gate = new RequestCeilingGate({
      readLimits: () => ({ providerTurns: stopAtLimit ? 2 : 4, tokens: 100 }),
      reachableRequests: () => new Set([requestId]),
      decide: async () => 'stop', stopRequest: () => {},
    });
    gate.begin(requestId);
    h.coordinator.beginRequest(requestId, agentId);
    const accounting = createPaidToolAccounting({
      currentRequestId: () => requestId, meter: new RequestLimitMeter(gate, () => true),
      spend: () => h.coordinator, onSpendError: () => {},
    });
    const boundary = vi.fn(agentRequestBoundary(agentId, {
      gate: () => gate, currentRequestId: () => requestId, personWait: (_id, wait) => wait(),
    }));
    const bytes = Buffer.alloc(44 + 481 * 16_000);
    Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e0000020010006461746102000000', 'hex').copy(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);

    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const part = (init?.body as FormData).get('file') as Blob;
      return new Response(JSON.stringify({ text: 'private segment', usage: { type: 'duration', seconds: (part.size - 44) / 16_000 } }));
    });
    const audioEgress = vi.fn(async () => {});
    const modelEgress = vi.fn(async () => {});
    const receipt = vi.fn();
    const activity = vi.fn();
    const host = new TranscriptionHost({
      route: () => ({ connectionId: 'unode', revision: 1, endpointBase: UNODE_DEFAULT_BASE_URL,
        model: 'gpt-transcribe', secretName: 'fixture', verifiedLimit: 25_000_000 }),
      secret: async () => 'fixture', egressCurrent: () => true, modelEgress, audioEgress, activity, receipt, fetch,
      ...accounting.transcription,
    });
    try {
      const result = await host.transcribe({ agentId, turnId: 'turn', signal: new AbortController().signal, boundary,
        current: () => true, prepare: async () => ({ bytes, name: 'meeting.wav', sha256: 'fixture', current: async () => true }),
      });
      const sentSeconds = stopAtLimit ? [240, 240] : [240, 240, 1];
      expect(modelEgress).toHaveBeenCalledOnce();
      expect(audioEgress).toHaveBeenCalledOnce();
      expect(activity).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.stringContaining('in 3 parts'));
      expect(boundary.mock.calls.filter(([kind]) => kind === 'provider-request')).toHaveLength(3);
      expect(fetch).toHaveBeenCalledTimes(sentSeconds.length);
      gate.release(requestId, agentId);
      expect(gate.facts(requestId)?.providerTurns.observed).toBe(sentSeconds.length);
      expect(result.state).toBe(stopAtLimit ? 'incomplete' : 'succeeded');
      if (stopAtLimit) expect(result).toMatchObject({ missing: { startSeconds: 480, endSeconds: 481 } });
      expect(receipt).toHaveBeenCalledOnce();
      expect(JSON.stringify(receipt.mock.calls)).not.toContain('private segment');

      await h.coordinator.drained();
      const receipts = h.ledger.snapshot().events.map(({ event }) => event)
        .flatMap(event => event.kind === 'usage-receipt' ? [event.receipt] : []);
      expect(receipts.map(entry => entry.audio_seconds)).toEqual(sentSeconds);
      expect(new Set(receipts.map(entry => entry.usageUnitId)).size).toBe(sentSeconds.length);
      expect(receipts.every(entry => entry.requestId === requestId && entry.displayCost.basis === 'unode-reference')).toBe(true);
    } finally {
      gate.dispose();
      h.coordinator.dispose();
    }
  });

  it('accounts for sent transcription and search through the production callbacks on the captured request', async () => {
    const h = harness();
    let activeRequest = 'first-request';
    const gate = new RequestCeilingGate({
      readLimits: () => ({ providerTurns: 10, tokens: 100 }),
      reachableRequests: () => new Set(['first-request', 'next-request']),
      decide: async () => 'stop', stopRequest: () => {},
    });
    gate.begin('first-request');
    gate.begin('next-request');
    const onSpendError = vi.fn();
    const accounting = createPaidToolAccounting({
      currentRequestId: () => activeRequest, meter: new RequestLimitMeter(gate, () => true),
      spend: () => h.coordinator, onSpendError,
    });
    const agentId = 'researcher';
    const signal = new AbortController().signal;
    const commonRoute = { connectionId: 'unode', endpointBase: UNODE_DEFAULT_BASE_URL, revision: 1, secretName: 'fixture' } as const;
    const audio = { operationId: 'transcription-1', route: { ...commonRoute, model: 'gpt-transcribe' as const } };
    const search = { operationId: 'search-1', route: commonRoute, turnCall: 1 };
    try {
      accounting.transcription.started({
        agentId, signal, turnId: 'turn', prepare: async () => undefined, current: () => true,
      }, audio);
      accounting.search.started({ agentId, signal, turn: {}, current: () => true }, search);
      expect(gate.facts('first-request')?.providerTurns).toEqual({ ceiling: 10, observed: 2 });

      activeRequest = 'next-request';
      accounting.transcription.settled(audio, { state: 'withheld', mayHaveCost: true, usage: {
        seconds: 17, pricing: { basis: 'unavailable' },
      } });
      const usage = { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, web_search_requests: 1 };
      expect(accounting.search.settled(search, { state: 'completed', operationId: search.operationId, may_have_cost: true,
        details: { answer: '', sources: [], usage, ...unodeSearchCost(usage) } })).toBe('first-request');
      expect(gate.facts('first-request')).toMatchObject({ coverage: 'complete', tokens: { observed: 17 } });
      expect(gate.facts('next-request')).toMatchObject({ tokens: { observed: 0 }, providerTurns: { observed: 0 } });
      await h.coordinator.drained();
      const receipts = h.ledger.snapshot().events.map(({ event }) => event)
        .flatMap(event => event.kind === 'usage-receipt' ? [event.receipt] : []);
      expect(receipts).toEqual([
        expect.objectContaining({ requestId: 'first-request', usageUnitId: audio.operationId, audio_seconds: 17,
          displayCost: expect.objectContaining({ nanoUsd: '1275000', sourceDate: '2026-11-23' }) }),
        expect.objectContaining({ requestId: 'first-request', usageUnitId: search.operationId, web_search_requests: 1,
          tokens: expect.objectContaining({ input: 14, output: 3 }) }),
      ]);
      expect(onSpendError).not.toHaveBeenCalled();
    } finally {
      gate.dispose();
      h.coordinator.dispose();
    }
  });

  it('keeps reported paid search usage on the separate Unode operation', async () => {
    const h = harness();
    h.setRoute({ connectionId: 'claude-cli', connectionName: 'Claude CLI', route: 'subscription' });
    const operationId = 'search-operation';
    const settle = h.coordinator.publicSearchUsage({ requestId: 'req-search', agentId: 'researcher' }, {
      operationId, turnCall: 1, route: { connectionId: 'unode', revision: 2, endpointBase: 'https://gateway.example/v1', secretName: 'UNODE_API_KEY' },
    });
    const usage = { input_tokens: 2857, output_tokens: 185, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 1 };
    settle({ state: 'completed', operationId, may_have_cost: true, details: { answer: '', sources: [], usage, ...unodeSearchCost(usage) } });
    await h.coordinator.drained();
    const receipt = h.ledger.snapshot().events.find(({ event }) => event.kind === 'usage-receipt')?.event;
    expect(receipt).toMatchObject({ receipt: { requestId: 'req-search', usageUnitId: operationId,
      connectionId: 'unode', modelId: 'claude-haiku-5-5', web_search_requests: 1, tokens: { input: 2857, output: 185 },
      displayCost: { nanoUsd: '10378200', sourceDate: '2026-11-23', basis: 'unode-reference' } } });
    h.coordinator.dispose();
  });
  it('records a coverage gap for a paid search without a request ID', async () => {
    const h = harness();
    const operationId = 'search-unattributed';
    const settle = h.coordinator.publicSearchUsage({ agentId: 'researcher' }, {
      operationId, turnCall: 1, route: { connectionId: 'unode', revision: 2, endpointBase: 'https://gateway.example/v1', secretName: 'fixture' },
    });
    settle({ state: 'outcome-unknown', operationId, may_have_cost: true, message: 'sent' });
    await h.coordinator.drained();
    const events = h.ledger.snapshot().events.map(({ event }) => event);
    expect(events).toEqual([expect.objectContaining({ kind: 'coverage-gap', usageUnitId: operationId, reason: 'no-request-id' })]);
    expect(events[0]).not.toHaveProperty('requestId');
    expect(h.coordinator.viewModel()).toMatchObject({ requests: [], coverageGaps: 1 });
    expect(h.coordinator.aggregateForRead().diagnostics).toEqual([]);
    h.coordinator.dispose();
  });
  it('uses reference-priced, reported transcription seconds for the selected Unode spend counter', async () => {
    const h = harness();
    h.setMode('unode');
    const operation: TranscriptionOperation = { operationId: 'audio-1', route: {
      connectionId: 'unode', revision: 1, endpointBase: UNODE_DEFAULT_BASE_URL, model: 'gpt-transcribe', secretName: 'fixture',
    } };
    h.coordinator.beginRequest('request', 'researcher');
    const settle = h.coordinator.transcriptionUsage({ requestId: 'request', agentId: 'researcher' }, operation);
    settle({ state: 'succeeded', mayHaveCost: true, usage: { seconds: 1205, pricing: { basis: 'unavailable' } },
      transcript: { text: 'Private recording text', languages: [], segments: [] } });
    await h.coordinator.drained();
    const receipt = h.ledger.snapshot().events.find(({ event }) => event.kind === 'usage-receipt')?.event;
    expect(receipt).toMatchObject({ receipt: { modelId: 'gpt-transcribe', audio_seconds: 1205,
      displayCost: { basis: 'unode-reference', sourceDate: '2026-11-23', nanoUsd: '90375000' } } });
    expect(JSON.stringify(receipt)).not.toContain('Private recording text');
    expect(h.coordinator.aggregateForRead().contributions).toContainEqual(expect.objectContaining({
      displayClass: 'selected-reference', displayNano: 90_375_000n, reminderNano: 90_375_000n,
    }));
    h.coordinator.dispose();
  });
  it('records Whisper as unpriced and exposes transcription coverage gaps without invented requests', async () => {
    const h = harness();
    const route = { connectionId: 'unode', revision: 1, endpointBase: UNODE_DEFAULT_BASE_URL, secretName: 'fixture' } as const;
    const request = { requestId: 'request', agentId: 'researcher' };
    const whisper = h.coordinator.transcriptionUsage(request, { operationId: 'whisper', route: { ...route, model: 'whisper-1' } });
    whisper({ state: 'withheld', mayHaveCost: true, usage: { seconds: 71, pricing: { basis: 'unavailable' } } });
    const missing = h.coordinator.transcriptionUsage(request, { operationId: 'missing', route: { ...route, model: 'gpt-transcribe' } });
    missing({ state: 'outcome-unknown', mayHaveCost: true });
    h.coordinator.transcriptionUsage({ agentId: 'researcher' }, { operationId: 'unattributed', route: { ...route, model: 'gpt-transcribe' } });
    await h.coordinator.drained();
    const events = h.ledger.snapshot().events.map(({ event }) => event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage-receipt', receipt: expect.objectContaining({
      modelId: 'whisper-1', audio_seconds: 71, displayCost: { basis: 'unavailable' },
    }) }));
    expect(events.filter(event => event.kind === 'coverage-gap')).toEqual([
      expect.objectContaining({ usageUnitId: 'missing', requestId: 'request', reason: 'no-terminal-usage' }),
      expect.objectContaining({ usageUnitId: 'unattributed', reason: 'no-request-id' }),
    ]);
    expect(h.coordinator.viewModel().coverageGaps).toBe(2);
    expect(h.coordinator.aggregateForRead().units.has('unattributed')).toBe(false);
    h.coordinator.dispose();
  });
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

  // v0.9.108 S2: the session display is told when a turn's usage is unknown, so it never shows $0 for it.
  it('tells the settling session that a requested turn without usage is unknown, and a refused one is not', async () => {
    const h = harness();
    h.coordinator.beginUsageUnit({ usageUnitId: 'asked', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('asked');
    expect(h.coordinator.settleUsageUnit('asked', undefined)).toEqual({ usageUnknown: true });
    h.coordinator.beginUsageUnit({ usageUnitId: 'refused', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    expect(h.coordinator.settleUsageUnit('refused', undefined)).toBeUndefined();
    await flush(h.coordinator);
    expect(h.coordinator.viewModel().coverageGaps).toBe(1);
  });

  it('words each spend row: partial, subscription, unknown, billed and estimated', async () => {
    expect(rowCostText('reported-partial', true, 12_000_000n)).toMatch(/^Partial usage ~\$0\.01/);
    expect(rowCostText('reported-partial', false, 0n)).toBe('Usage recorded, cost unknown');
    expect(rowCostText('api-equivalent', true, 20_000_000n)).toMatch(/^Subscription \(API-equivalent ~\$0\.02/);
    expect(rowCostText('unavailable', false, 0n)).toBe('cost unknown');
    expect(rowCostText('reconstructed', false, 0n)).toBe('cost unknown');
    expect(rowCostText('billed', true, 10_000_000n)).toMatch(/^\$0\.01/);
    expect(rowCostText('reference', true, 10_000_000n)).toMatch(/^~\$0\.01/);
    // A stopped turn's partial usage reaches the Spend view under its own wording.
    const h = harness(); h.setCandidates(coefficient());
    h.coordinator.beginUsageUnit({ usageUnitId: 'stopped', requestId: 'req1', agentId: 'pm', modelId: 'm1' });
    h.coordinator.noteModelRequest('stopped');
    h.coordinator.settleUsageUnit('stopped', { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported-partial' });
    await flush(h.coordinator);
    expect(h.coordinator.viewModel().requests[0].rows).toEqual([expect.objectContaining({ label: 'Partial (stopped before completion)', costText: expect.stringMatching(/^Partial usage ~\$1/) })]);
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
