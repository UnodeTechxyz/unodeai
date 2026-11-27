import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';
import { SessionManager } from '../../session/SessionManager';
import type { GrantNoticeReport } from '../../session/GrantNotices';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/**
 * v0.9.100 (audit of 254ccc8b, A2): Clear and Archive take back a file-access notice not told yet, and the paid turn
 * it would have run. The turn that is running goes on. The real chat view over the real session manager; the model is
 * scripted.
 */
class Scripted implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  receipts: Array<(accepted: boolean) => void> = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(text: string): void { this.turns.push(text); }
  async stop(): Promise<void> { this.alive = false; }
  abort(): void {}
  isAlive(): boolean { return this.alive; }
  readonly snapshotKind = 'openai-compat' as const;
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): boolean { return true; }
  steerNotice(): Promise<boolean> { return new Promise((resolve) => { this.receipts.push(resolve); }); }
  emit(e: BackendEvent): void { this.handler?.(e); }
}
const config: AgentConfig = { id: 'dev', name: 'Dev', role: 'senior-dev' as AgentConfig['role'], skill: '',
  provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'm', systemPrompt: '', autoApprove: true, allowedTools: [] };
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

async function setup(options: { hold?: Promise<void> } = {}) {
  const bus = new MessageBus();
  const ledger = new RunLedger();
  let backend!: Scripted;
  const mgr = new SessionManager(5, bus, {
    createBackend: (cfg) => { backend = new Scripted(cfg); return backend; },
    resolveEnv: async () => ({}),
    onTurnComplete: options.hold ? () => options.hold! : undefined,
    continuationDecided: (id, correlation) => ledger.beginContinuation(id, correlation),
    continuationAbandoned: (id, correlation) => ledger.abandonContinuation(id, correlation),
    threadRunOpen: (id, correlation) => ledger.threadRunOpen(id, correlation),
  });
  bus.subscribe({}, (message) => ledger.observeMessage(message));
  mgr.create(config);
  await mgr.start('dev', { pin: 'take' });
  backend.emit({ kind: 'ready' });
  const state = new Map<string, unknown>();
  const provider = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'dev', name: 'Dev', role: 'Developer', status: 'running', backend: 'openai' }],
    send: () => {}, interject: () => {}, interrupt: () => {}, onReply: () => () => {},
    // The extension's own ports.
    retirePreparing: () => false,
    forgetFileAccessNotices: (id: string) => mgr.forgetFileAccessNotices(id),
    state: { get: (key: string) => state.get(key), update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); } },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: () => {},
  } as unknown as ChatViewDeps);
  provider.selectAgent('dev');
  // Archive has something to archive.
  provider.postRuntimeNotice('dev', 'An earlier line of this chat.');
  const reports: GrantNoticeReport[] = [];
  const message = bus.send('user', 'dev', 'ask.question', { instruction: 'work' });
  const correlation = message.correlationId ?? message.id;
  const request = mgr.currentRequestId('dev')!;
  const tell = (text: string) => mgr.tellFileAccessGrant('dev', request, text, (report) => reports.push(report));
  const finish = (usage?: { inputTokens: number; outputTokens: number }) =>
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, ...(usage ? { usage } : {}) } } as BackendEvent);
  return { bus, mgr, ledger, provider, reports, correlation, request, tell, finish, backend: () => backend };
}

describe.each([
  ['Clear', (provider: ChatViewProvider) => provider.clearSelectedAgent()],
  ['Archive', (provider: ChatViewProvider) => { provider.archiveSelectedAgent(); }],
] as const)('%s takes back a file-access notice not told yet', (_name, wipe) => {
  it('during the turn: the turn goes on, no turn follows, and a late answer changes nothing', async () => {
    const c = await setup();
    try {
      c.tell('Host scope update: Read access.');
      expect(c.backend().receipts).toHaveLength(1);
      wipe(c.provider);
      expect(c.mgr.currentRequestId('dev')).toBe(c.request);
      expect(c.mgr.get('dev')!.status).toBe('running');
      c.backend().receipts[0](false);
      await tick();
      // Nothing is written into the chat that was just cleared.
      expect(c.reports).toEqual([{ kind: 'not-told', reason: 'stopped' }]);
      c.finish();
      await tick();
      expect(c.backend().turns).toEqual(['work']);
      expect(c.reports).toEqual([{ kind: 'not-told', reason: 'stopped' }]);
    } finally { c.provider.dispose(); c.mgr.dispose(); c.bus.dispose(); }
  });

  it('after the decision: the owed turn is not sent, its task slot goes back, and the reply ends the run', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const c = await setup({ hold });
    try {
      c.ledger.recordDelegationDispatched({ coordinatorId: 'dev', handle: 'w1', agentId: 'other', requestedAgent: 'other', instruction: 'x', attemptId: 'a', originCorrelationId: c.correlation });
      c.ledger.recordDelegationEvidence({ handle: 'w1', agentId: 'other', outcome: 'no-evidence', evidence: {
        outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false } } });
      c.ledger.recordDeliveryDelivered('w1', 'blocking-tool');
      c.tell('Host scope update: Read access.');
      c.backend().receipts[0](false);
      await tick();
      c.finish({ inputTokens: 100, outputTokens: 10 });
      expect(c.reports.at(-1)).toEqual({ kind: 'continues' });
      expect(c.ledger.snapshot()[0].status).toBe('open');
      expect(c.mgr.getRecentTaskTokens(5)).toEqual([]);
      wipe(c.provider);
      release();
      await tick();
      expect(c.mgr.requestRunning(c.request)).toBe(false);
      expect(c.backend().turns).toEqual(['work']);
      expect(c.ledger.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
      expect(c.ledger.snapshot()[0].continuationPending).toBeUndefined();
      expect(c.mgr.getRecentTaskTokens(5)).toEqual([expect.objectContaining({ id: c.request, totalTokens: 110 })]);
    } finally { c.provider.dispose(); c.mgr.dispose(); c.bus.dispose(); }
  });
});

describe('the wiring', () => {
  it('the extension gives the chat view the session manager\'s entry', async () => {
    const source = await readFile('src/extension.ts', 'utf8');
    expect(source).toContain('forgetFileAccessNotices: (agentId) => sessionManager.forgetFileAccessNotices(agentId),');
  });

  it('a failing port never stops a clear', async () => {
    const c = await setup();
    try {
      (c.provider as unknown as { deps: { forgetFileAccessNotices: () => void } }).deps.forgetFileAccessNotices = () => { throw new Error('gone'); };
      expect(() => c.provider.clearSelectedAgent()).not.toThrow();
    } finally { c.provider.dispose(); c.mgr.dispose(); c.bus.dispose(); }
  });
});
