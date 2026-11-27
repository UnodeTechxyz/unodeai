import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { SpendCoordinator } from '../../host/SpendCoordinator';
import { MemorySpendLedger } from '../../state/SpendStore';
import { parseUserTargets } from '../../models/spend/SpendTargets';
import { RequestLimitMeter } from '../../host/RequestLimitMeter';
import { meteredSpendPort } from '../meteredSpendPort';
import { toConsoleRows } from '../../views/parallelConsoleModel';
import { renderSpendSection } from '../../views/spendDashboard';
import { ChatViewProvider } from '../../views/ChatViewProvider';
import { bootWebviewScript } from '../../views/__tests__/support/webviewBoot';
import { validUsageReceipt } from '../../models/spend/SpendTypes';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { SessionInfo } from '../../types';

/*
 * v0.9.108 S2 audit F1-F3: the real session manager, metered spend port, spend coordinator and ledger, then the three
 * displays (chat header webview script, team console row, Dashboard Spend section). Only the provider backend is fake.
 */
class Backend implements AgentBackend {
  readonly agentId = 'dev';
  private handler?: BackendEventHandler; private alive = false;
  onEvent(handler: BackendEventHandler) { this.handler = handler; return () => { this.handler = undefined; }; }
  async start() { this.alive = true; }
  async stop() { this.alive = false; }
  abort() {}
  isAlive() { return this.alive; }
  sendUserTurn() {}
  emit(event: BackendEvent) { this.handler?.(event); }
}

function header(session: SessionInfo): string {
  const u = session.usage!;
  const agent = { id: session.id, name: session.config.name, role: session.config.role, backend: session.config.backend, model: session.config.model,
    costUsd: u.costUsd, turns: u.turns, costBasis: u.costBasis, costPartial: u.partial, unknownTurns: u.unknownTurns };
  const provider = new ChatViewProvider({} as never, { listAgents: () => [agent], send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} }, getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {} } as never);
  (provider as any).rosterLoaded(); provider.selectAgent('dev');
  const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:', asWebviewUri: (uri: unknown) => uri }, 'workbench'));
  booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
  return booted.elements.get('sessionMenuTrigger')!.title as string;
}

async function flow(kind: 'codex' | 'openai-compat', terminal: BackendEvent | undefined, options: { stop?: boolean; request?: boolean; ledger?: MemorySpendLedger } = {}) {
  const ledger = options.ledger ?? new MemorySpendLedger();
  const coordinator = new SpendCoordinator({
    ledger, notifier: { threshold() {}, referencePriceChoiceNeeded() {}, viewChanged() {}, repairNeeded() {} },
    resolveRoute: () => ({ connectionId: kind, connectionName: kind, route: kind === 'codex' ? 'subscription' : 'gateway' }),
    routeCandidates: () => [], referenceMode: () => 'unselected', catalogs: () => ({}),
    userTargets: () => parseUserTargets({ schemaVersion: 1 }), repositoryBudget: () => undefined,
  });
  const meter = new RequestLimitMeter({ governs: () => false, noteProviderRequest() {}, noteUsage() {}, settleUsage() {}, markUsageIncomplete() {} } as never, () => false);
  const bus = new MessageBus(); let backend!: Backend;
  const mgr = new SessionManager(1, bus, { createBackend: () => (backend = new Backend()), resolveEnv: async () => ({}), spend: meteredSpendPort(coordinator, meter) });
  mgr.create({ id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', backend: kind, model: 'unpriced-model', systemPrompt: '', autoApprove: true, allowedTools: [],
    provider: { providerId: kind === 'codex' ? 'codex' : 'unode', apiKeySecretName: kind === 'codex' ? 'CODEX_CLI_AUTH' : 'UNODE_API_KEY' } } as never);
  await mgr.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' } as BackendEvent);
  bus.send('user', 'dev', 'task.assign', { instruction: 'work' });
  if (options.request !== false) backend.emit({ kind: 'model_request' } as BackendEvent);
  if (options.stop) mgr.interrupt('dev');
  if (terminal) backend.emit(terminal);
  await coordinator.settled();
  const view = coordinator.viewModel(); const session = mgr.get('dev')!;
  const result = { usage: session.usage!, console: toConsoleRows([session])[0].costLabel, header: header(session), view,
    rows: view.requests.flatMap(request => request.rows), html: renderSpendSection(view), ledger };
  mgr.dispose(); coordinator.dispose(); return result;
}
const turn = (usage?: Record<string, unknown>, stopped = false) => ({ kind: 'turn_complete', result: { text: stopped ? '[Stopped]' : 'done', isError: stopped, ...(usage ? { usage } : {}) } }) as BackendEvent;

describe('S2 spend display through the real session and spend pipeline', () => {
  // F1: a provider request whose process died before reporting usage is shown as usage unknown, once.
  it('shows a coverage gap from an unexpected backend exit as usage unknown in the header and console', async () => {
    const gap = await flow('openai-compat', { kind: 'exit', code: 1 } as BackendEvent);
    expect(gap.view.coverageGaps).toBe(1);
    expect(gap.usage).toMatchObject({ turns: 0, unknownTurns: 1 });
    expect(gap.console).toBe('Usage not reported, cost unknown');
    expect(gap.header).toContain(' · Usage not reported, cost unknown');
    const none = await flow('openai-compat', { kind: 'exit', code: 1 } as BackendEvent, { request: false });
    expect(none.view.coverageGaps).toBe(0); expect(none.usage.unknownTurns).toBeUndefined();
  });

  // F2: a stopped subscription turn keeps both facts.
  it('keeps the partial qualification on a stopped subscription turn, priced or not', async () => {
    const priced = await flow('codex', turn({ inputTokens: 12, outputTokens: 3, usageBasis: 'reported-partial', costUsd: 0.02, costBasis: 'api-equivalent' }, true), { stop: true });
    expect(priced.usage).toMatchObject({ partial: true, costBasis: 'api-equivalent' });
    expect(priced.console).toBe('Partial usage, subscription (API-equivalent ~$0.0200)');
    expect(priced.header).toContain(' · Partial usage, subscription (API-equivalent ~$0.020)');
    const unpriced = await flow('codex', turn({ inputTokens: 12, outputTokens: 3, usageBasis: 'reported-partial', costBasis: 'api-equivalent' }, true), { stop: true });
    expect(unpriced.console).toBe('Partial usage, subscription, no per-turn amount');
    expect(unpriced.header).toContain(' · Partial usage, subscription, no per-turn amount');
  });

  // F3: the Spend section names an unpriced subscription turn from the route recorded with it, never from current settings.
  it('words an unpriced Codex subscription turn as a subscription in Dashboard Spend, and an old record without its route as unknown', async () => {
    const codex = await flow('codex', turn({ inputTokens: 12, outputTokens: 3, usageBasis: 'reported', costBasis: 'api-equivalent' }));
    expect(codex.console).toBe('Subscription, no per-turn amount');
    expect(codex.rows).toEqual([{ label: 'Subscription (no per-turn amount)', tokens: 15, costText: 'Subscription, no per-turn amount' }]);
    expect(codex.html).toContain('Subscription (no per-turn amount)'); expect(codex.html).toContain('Subscription, no per-turn amount');
    const receipt = codex.ledger.snapshot().events.map(stored => stored.event).find(event => event.kind === 'usage-receipt') as any;
    expect(receipt.receipt.billingRoute).toBe('subscription');
    expect(receipt.receipt.reminderValue).toEqual({ tokens: 15, basis: 'reported-tokens' });
    const gateway = await flow('openai-compat', turn({ inputTokens: 12, outputTokens: 3, usageBasis: 'reported' }));
    expect(gateway.rows).toEqual([{ label: 'Price unavailable (tokens only)', tokens: 15, costText: 'cost unknown' }]);
    expect(gateway.ledger.snapshot().events.some(stored => stored.event.kind === 'usage-receipt' && 'billingRoute' in (stored.event as any).receipt)).toBe(false);
    // A record written before v0.9.108 has no route: it loads unchanged and stays "cost unknown".
    const old = new MemorySpendLedger();
    for (const stored of codex.ledger.snapshot().events) {
      const { schemaVersion: _s, eventId, hostEpoch: _h, sequence: _q, recordedAt: _r, ...payload } = stored.event as any;
      if (payload.kind === 'usage-receipt') { payload.receipt = { ...payload.receipt }; delete payload.receipt.billingRoute; }
      await old.append(payload, eventId);
    }
    const reloaded = await flow('codex', undefined, { request: false, ledger: old });
    expect(reloaded.rows).toEqual([{ label: 'Price unavailable (tokens only)', tokens: 15, costText: 'cost unknown' }]);
    expect(validUsageReceipt({ ...receipt.receipt })).toBe(true);
    const { billingRoute: _b, ...without } = receipt.receipt; expect(validUsageReceipt(without)).toBe(true);
    expect(validUsageReceipt({ ...receipt.receipt, billingRoute: 'gateway' })).toBe(false);
  });
});
