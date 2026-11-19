/*---------------------------------------------------------------------------------------------
 * A0 benchmark fixture
 *
 * This is deliberately a test-only measurement fixture. `scripts/run-a0-benchmark.mjs` opts in by
 * setting UNODE_A0_UNIT_REPORT; ordinary unit runs execute the cheap availability assertion only.
 * The measurements describe the current implementation, including its known limitations. They are
 * evidence for a later optimisation, not budgets and not a production telemetry path.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { BalanceService } from '../models/BalanceService';
import { LivePriceService } from '../models/LivePriceService';
import { ModelCatalog } from '../models/ModelCatalog';
import { PersistenceManager } from '../state/PersistenceManager';
import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../views/ChatViewProvider';

interface Timed<T> {
  value: T;
  elapsedMs: number;
}

interface FetchCall {
  url: string;
  startedAtMs: number;
}

interface A0UnitReport {
  schemaVersion: 1;
  fixture: 'deterministic-in-memory-services-and-host-webview-proxy';
  caveats: string[];
  metadata: {
    modelCatalog: Record<string, unknown>;
    priceList: Record<string, unknown>;
    balance: Record<string, unknown>;
  };
  persistence: Record<string, unknown>;
  chatWebviewProxy: Record<string, unknown>;
}

const reportPath = process.env.UNODE_A0_UNIT_REPORT;

function timed<T>(fn: () => T): Timed<T> {
  const started = performance.now();
  const value = fn();
  return { value, elapsedMs: performance.now() - started };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - started };
}

function rounded(ms: number): number {
  return Number(ms.toFixed(3));
}

function response(body: unknown): { ok: true; status: 200; text(): Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function fixtureFetch(calls: FetchCall[]) {
  return async (url: string) => {
    calls.push({ url, startedAtMs: performance.now() });
    if (url.includes('catalog.example')) {
      return response({ providers: { unode: { models: [{ id: 'catalog-model' }] } } });
    }
    if (url.includes('/models')) {
      return response({ data: [{ id: 'gateway-model' }] });
    }
    if (url.includes('/api/pricing')) {
      return response({ data: [{ model_name: 'fixture-model', model_ratio: 1, completion_ratio: 1, quota_type: 0 }] });
    }
    if (url.includes('/subscription')) {
      return response({ hard_limit_usd: 12 });
    }
    if (url.includes('/usage')) {
      return response({ total_usage: 345 });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
}

const chatAgent: ChatAgent = { id: 'benchmark-agent', name: 'Benchmark agent', role: 'Developer', backend: 'openai' };

function chatDeps(): ChatViewDeps {
  const state = new Map<string, unknown>();
  return {
    listAgents: () => [chatAgent],
    send: () => {},
    interject: () => {},
    interrupt: () => {},
    onReply: () => () => {},
    state: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        state.set(key, value);
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: () => {},
  };
}

function seedTranscript(provider: ChatViewProvider, count: number): void {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: 'agent',
    text: `Message ${index}: benchmark transcript content with a small code sample.\n\n\`\`\`ts\nconst row${index} = ${index};\n\`\`\``,
    ts: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    seq: index,
    fromName: chatAgent.name,
  }));
  const internals = provider as unknown as {
    presentation: { replaceTranscript(id: string, rows: unknown[]): void };
    initializedSeqs: Set<string>;
    nextSeqs: Map<string, number>;
    clearRenderedMarkdownCache(id: string): void;
  };
  internals.presentation.replaceTranscript(chatAgent.id, messages);
  internals.initializedSeqs.delete(chatAgent.id);
  internals.nextSeqs.delete(chatAgent.id);
  internals.clearRenderedMarkdownCache(chatAgent.id);
}

function measureChatWebviewProxy(): Record<string, unknown> {
  const provider = new ChatViewProvider({} as never, chatDeps());
  provider.selectAgent(chatAgent.id);
  seedTranscript(provider, 500);

  const internals = provider as unknown as { currentState(): unknown };
  const beforeHeapBytes = process.memoryUsage().heapUsed;
  const state = timed(() => internals.currentState());
  const afterStateHeapBytes = process.memoryUsage().heapUsed;
  const posts: unknown[] = [];
  const disposable = { dispose: () => {} };
  const attach = timed(() => provider.resolveWebviewView({
    visible: true,
    webview: {
      cspSource: 'benchmark:',
      options: {},
      html: '',
      onDidReceiveMessage: () => disposable,
      postMessage: (message: unknown) => {
        posts.push(message);
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => disposable,
    onDidDispose: () => disposable,
    show: () => {},
  } as never));
  provider.refresh();

  return {
    transcriptMessages: 500,
    hostStateBuildMs: rounded(state.elapsedMs),
    hostStatePayloadBytes: Buffer.byteLength(JSON.stringify(state.value)),
    webviewAttachHostWorkMs: rounded(attach.elapsedMs),
    messagesPostedByHost: posts.length,
    heapDeltaBytesDuringHostState: afterStateHeapBytes - beforeHeapBytes,
    domNodesRealized: { status: 'unavailable', reason: 'Extension-host tests cannot inspect a real webview DOM.' },
    browserRenderMs: { status: 'unavailable', reason: 'Extension-host tests cannot measure browser paint or layout.' },
    browserMemoryBytes: { status: 'unavailable', reason: 'Extension-host process memory is not webview renderer memory.' },
  };
}

async function collectReport(): Promise<A0UnitReport> {
  const modelCalls: FetchCall[] = [];
  const modelCatalog = new ModelCatalog(
    () => [{ id: 'static-model', source: 'static' }],
    fixtureFetch(modelCalls),
    { catalogUrl: 'https://catalog.example/models.json' },
  );
  const firstModelList = await timedAsync(() => modelCatalog.list('unode', 'https://gateway.example/v1', 'fixture-key'));
  const requestsAfterFirstList = modelCalls.length;
  const cachedModelList = await timedAsync(() => modelCatalog.list('unode', 'https://gateway.example/v1', 'fixture-key'));
  const requestsAfterCachedList = modelCalls.length;

  const duplicateCalls: FetchCall[] = [];
  const duplicateCatalog = new ModelCatalog(
    () => [{ id: 'static-model', source: 'static' }],
    fixtureFetch(duplicateCalls),
    { catalogUrl: 'https://catalog.example/models.json' },
  );
  const duplicateInFlight = await timedAsync(() => Promise.all([
    duplicateCatalog.list('unode', 'https://gateway.example/v1', 'fixture-key'),
    duplicateCatalog.list('unode', 'https://gateway.example/v1', 'fixture-key'),
  ]));

  const priceCalls: FetchCall[] = [];
  const priceList = await timedAsync(() => new LivePriceService(fixtureFetch(priceCalls))
    .fetchGatewayPricesDetailed('https://gateway.example/v1', 'fixture-key'));
  const balanceCalls: FetchCall[] = [];
  const balance = await timedAsync(() => new BalanceService(fixtureFetch(balanceCalls))
    .fetchBalance('https://gateway.example/v1', 'fixture-key'));

  const updates: Array<{ key: string; value: unknown }> = [];
  const persistence = new PersistenceManager({
    workspaceState: {
      get: <T>(_key: string, fallback?: T) => fallback,
      update: (key: string, value: unknown) => {
        updates.push({ key, value });
        return Promise.resolve();
      },
      keys: () => [],
    },
  } as never);
  const snapshot = {
    messages: Array.from({ length: 20 }, (_, index) => ({ role: 'assistant', content: `turn ${index}` })),
  };
  const serialization = timed(() => JSON.stringify(snapshot));
  persistence.saveSnapshot('benchmark-agent', snapshot as never);
  await Promise.resolve();

  return {
    schemaVersion: 1,
    fixture: 'deterministic-in-memory-services-and-host-webview-proxy',
    caveats: [
      'Network timings use an in-memory deterministic fetch fixture; they measure local orchestration and request count, not provider latency.',
      'Persistence timing is JSON serialization of a fixture plus workspaceState.update call count; VS Code storage flush timing is not observable from this unit fixture.',
      'Chat measurements are extension-host work and postMessage count. Real webview DOM nodes, browser render time, and browser memory are intentionally reported unavailable.',
    ],
    metadata: {
      modelCatalog: {
        firstListMs: rounded(firstModelList.elapsedMs),
        firstListModelCount: firstModelList.value.length,
        firstListRequestCount: requestsAfterFirstList,
        cachedListMs: rounded(cachedModelList.elapsedMs),
        cachedListAdditionalRequestCount: requestsAfterCachedList - requestsAfterFirstList,
        duplicateInflightMs: rounded(duplicateInFlight.elapsedMs),
        duplicateInflightCallerCount: duplicateInFlight.value.length,
        duplicateInflightRequestCount: duplicateCalls.length,
        duplicateInflightUniqueUrlCount: new Set(duplicateCalls.map((call) => call.url)).size,
      },
      priceList: {
        firstRequestMs: rounded(priceList.elapsedMs),
        requestCount: priceCalls.length,
        modelCount: Object.keys(priceList.value.prices).length,
      },
      balance: {
        firstRequestMs: rounded(balance.elapsedMs),
        requestCount: balanceCalls.length,
        available: balance.value !== undefined,
      },
    },
    persistence: {
      fixtureSnapshotBytes: Buffer.byteLength(serialization.value),
      fixtureJsonSerializationMs: rounded(serialization.elapsedMs),
      workspaceStateWritesPerTurn: updates.length,
    },
    chatWebviewProxy: measureChatWebviewProxy(),
  };
}

describe('A0 benchmark fixture', () => {
  it('emits an opt-in, machine-readable baseline sample without changing production behaviour', async () => {
    if (!reportPath) {
      expect(true).toBe(true);
      return;
    }
    const report = await collectReport();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(report.metadata.modelCatalog).toMatchObject({ firstListRequestCount: 2 });
  });
});
