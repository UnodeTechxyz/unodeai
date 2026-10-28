import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { deserializeChatHistory, serializeChatHistory } from '../chatHistory';
import { createChatExportPayload, parseChatImportPayload } from '../transcriptPort';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';
import type { ResponseRetry } from '../../backend/ResponseRetry';
import { SessionManager } from '../../session/SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import type { AgentConfig } from '../../types';
import { parseTurnInterruption } from '../../backend/TurnInterruption';
import { parsePmTurnStatus } from '../../session/PmTurnStatus';

vi.mock('vscode', () => ({}));
const retry: ResponseRetry = { previousAttempt: 1, attempt: 2, reason: 'connection-lost' };
const providers: ChatViewProvider[] = [];
afterEach(() => providers.splice(0).forEach(provider => provider.dispose()));
function setup() {
  const store = new Map<string, unknown>();
  const deps: ChatViewDeps = { listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai-compat' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => store.get(key) as T | undefined, update: async (key, value) => { store.set(key, value); } },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn() };
  const create = () => { const provider = new ChatViewProvider({} as never, deps); provider.selectAgent('pm'); providers.push(provider); return provider; };
  return { provider: create(), create, store };
}
const messages = (provider: ChatViewProvider): any[] => (provider as any).currentState().messages;
const complete = (provider: ChatViewProvider, text: string, epoch = 1) => (provider as any).onReply({
  from: 'pm', fromName: 'PM', text, epoch, turnId: `turn-${epoch}`, isError: false,
});
const descendants = (node: WebviewElement): WebviewElement[] =>
  ((Array.isArray(node.children) ? node.children : []) as WebviewElement[]).flatMap(child => [child, ...descendants(child)]);

/** Execute production extension registration, not a copied event mapping. */
function wire(provider: ChatViewProvider, sessionManager: any = new EventEmitter(), events = ['session.responseRetry'], log = (_line: string) => {}) {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'wireEvents');
  const registration = fn?.body?.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.expression.getText(source) === 'sessionManager'
    && ts.isStringLiteral(node.expression.arguments[0]) && events.includes(node.expression.arguments[0].text)) ?? [];
  expect(registration).toHaveLength(events.length);
  const js = ts.transpileModule(registration.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('host', `with(host) { ${js} }`)({ sessionManager, chatViewProvider: provider, outputChannel: { warn: log } });
  return sessionManager;
}

describe('same-turn interrupted response fragments', () => {
  it('shows immutable live-only details as plain text, while storage/export/import and reload retain no diagnostic text', () => {
    const { provider, create, store } = setup(); const log = vi.fn();
    const interruption = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted', attempts: 2 } as const;
    const detail = { schemaVersion: 1, name: 'TypeError', code: 'EPIPE', message: 'PRIVATE_DIAGNOSTIC <script>bad()</script> [link](https://bad.invalid)\nline2' } as const;
    provider.appendDelta('pm', 'partial', 1);
    wire(provider, new EventEmitter(), ['session.interruptionDetail'], log).emit('session.interruptionDetail', {
      sessionId: 'pm', data: { turnId: 'turn-1', epoch: 1, interruption, detail },
    });
    (provider as any).onReply({ from: 'pm', fromName: 'PM', text: 'host summary', isError: true, epoch: 1, turnId: 'turn-1', interruption });
    provider.recordInterruptionDetail('pm', 'turn-1', 1, { ...detail, message: 'PRIVATE_REPLACEMENT' });
    expect(messages(provider).find(item => item.turnFinal).interruptionDetail).toEqual(detail);
    const boot = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
    const nodes = descendants(boot.elements.get('transcript')!);
    expect(nodes.some(node => String(node.textContent).includes('PRIVATE_DIAGNOSTIC'))).toBe(true);
    const disclosure = nodes.find(node => node.className === 'compaction-summary'
      && descendants(node).some(child => String(child.textContent).includes('PRIVATE_DIAGNOSTIC')))!;
    expect(disclosure).toBeDefined();
    const original = descendants(disclosure).find(node => node.className === 'body')!;
    expect(original.textContent).toBe(`TypeError [EPIPE]\n${detail.message}`);
    expect(original.innerHTML).toBe(''); expect(original.children).toEqual([]);
    expect(String(log.mock.calls[0][0])).not.toContain('\n');
    expect(JSON.stringify([...store.values()])).not.toContain('PRIVATE_DIAGNOSTIC');
    const exported = provider.exportSelected()!;
    expect(JSON.stringify(exported)).not.toMatch(/PRIVATE_DIAGNOSTIC|PRIVATE_REPLACEMENT|interruptionDetail/);
    expect(messages(create()).find(item => item.turnFinal).interruptionDetail).toBeUndefined();
    provider.importToSelected(exported.messages);
    expect(messages(provider).find(item => item.turnFinal).interruptionDetail).toBeUndefined();
  });

  it('bounds the private detail cache and drops it when the conversation/agent is removed', () => {
    const { provider } = setup(); const detail = { schemaVersion: 1, name: 'Error', message: 'PRIVATE_DIAGNOSTIC' } as const;
    provider.appendDelta('pm', 'work', 1);
    for (let i = 0; i <= 50; i++) provider.recordInterruptionDetail('pm', `turn-${i}`, 1, detail);
    expect((provider as any).interruptionDetails.size).toBe(50);
    expect((provider as any).interruptionDetails.has(JSON.stringify(['pm', 'turn-0']))).toBe(false);
    provider.recordInterruptionDetail('pm', 'stale', 0, detail);
    expect((provider as any).interruptionDetails.size).toBe(50);
    expect((provider as any).interruptionDetails.has(JSON.stringify(['pm', 'stale']))).toBe(false);
    expect((provider as any).interruptionDetails.has(JSON.stringify(['pm', 'turn-1']))).toBe(true);
    provider.clearAgent('pm'); expect((provider as any).interruptionDetails.size).toBe(0);
  });
  it('passes only a valid typed error interruption through the production bus-to-chat reply adapter', () => {
    const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const matches: ts.PropertyAssignment[] = [];
    const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'onReply') matches.push(node); ts.forEachChild(node, visit); };
    visit(source); expect(matches).toHaveLength(1);
    const bus = new MessageBus(); const received: any[] = [];
    const host = { messageBus: bus, parseTurnInterruption, resolveAgentName: () => 'PM',
      parseDelegationCounts: () => undefined, parsePmTurnStatus, parseChatVerbatim: () => undefined, parseResponseOutcome: () => undefined,
      parseTurnOutcomeReceipt: () => undefined, parseChatTurnTrigger: () => undefined, cliRuntimeFailureNotice: () => undefined,
      normalizeEpoch: (value: unknown) => value, cb: (reply: unknown) => received.push(reply) };
    const js = ts.transpileModule(`const bind = ${matches[0].initializer.getText(source)}; bind(cb);`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('host', `with(host) { ${js} }`)(host);
    const interruption = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted', attempts: 2 };
    bus.send('pm', 'user', 'system.error', { instruction: 'host summary', metadata: { interruption: { ...interruption, raw: 'PRIVATE_DETAIL' } } });
    bus.send('pm', 'user', 'task.complete', { instruction: 'success', metadata: { interruption } });
    bus.send('pm', 'user', 'system.error', { instruction: 'old error', metadata: { interruption: { ...interruption, schemaVersion: 2 } } });
    expect(received[0].interruption).toEqual(interruption);
    expect(received[1].interruption).toBeUndefined(); expect(received[2].interruption).toBeUndefined();
    expect(JSON.stringify(received)).not.toContain('PRIVATE_DETAIL');
    // v0.9.99 P4: a valid PM status reaches the chat reply; a malformed one does not.
    const pmStatus = { row: 11, state: 'Idle', now: 'Nothing is running.', why: 'the PM finished its reply' };
    bus.send('pm', 'user', 'task.complete', { instruction: 'answered', metadata: { pmStatus } });
    bus.send('pm', 'user', 'task.complete', { instruction: 'answered', metadata: { pmStatus: { row: 11 } } });
    expect(received[3].pmStatus).toEqual(pmStatus);
    expect(received[4].pmStatus).toBeUndefined();
  });
  it('keeps the last un-retried partial text before the host interruption summary across reload/export/import', () => {
    const { provider, create } = setup();
    const interruption = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted', attempts: 2 } as const;
    provider.appendDelta('pm', 'last partial text', 1); provider.appendReasoning('pm', 'unfinished analysis', 1);
    (provider as any).onReply({ from: 'pm', fromName: 'PM', text: 'Fixed host summary', isError: true, epoch: 1, turnId: 'turn-1', interruption });
    for (const current of [provider, create()]) {
      const rows = messages(current).filter(item => item.kind === 'message');
      expect(rows.map(row => row.text)).toEqual(['last partial text', 'Fixed host summary']);
      expect(rows[0]).toMatchObject({ interruptedReply: true }); expect(rows[0].turnFinal).toBeUndefined();
      expect(rows[0].incompleteReply).toBeUndefined();
      expect(rows[1]).toMatchObject({ turnFinal: true, isError: true, interruption });
      expect(messages(current).find(item => item.kind === 'reasoning').nonConclusion).toBe(true);
      const exported = current.exportSelected()!;
      expect(deserializeChatHistory(exported.messages)).toMatchObject([
        { interruptedReply: true }, { interruption },
      ]);
      const boot = bootWebviewScript((current as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
      const nodes = descendants(boot.elements.get('transcript')!);
      expect(nodes.filter(node => node.textContent === 'Partial reply (turn interrupted)')).toHaveLength(1);
      expect(nodes.some(node => String(node.className).split(' ').includes('conclusion'))).toBe(false);
      expect(nodes.some(node => node.textContent === 'Incomplete reply fragment (automatically retried)')).toBe(false);
    }
  });
  it('runs actual SSE failure → resend → SessionManager → extension registrations → preserved transcript', async () => {
    const { provider } = setup(); const bus = new MessageBus(); let sends = 0;
    const config: AgentConfig = { id: 'pm', name: 'PM', role: 'senior-dev', backend: 'openai-compat', skill: '', systemPrompt: '', model: 'deepseek-chat',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, workingDirectory: process.cwd(), allowedTools: ['read'], autoApprove: true };
    const backend = new OpenAICompatBackend(config, vi.fn(), undefined, undefined, undefined, { retryBaseMs: 0 }, undefined,
      async () => { const first = ++sends === 1; return { ok: true, status: 200, body: (async function* () {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: first ? 'incomplete' : 'replacement' } }] })}\n\n`);
        if (first) throw new TypeError('terminated');
        yield Buffer.from('data: [DONE]\n\n');
      })() }; });
    const manager = new SessionManager(1, bus, { resolveEnv: async () => ({ ROAM_API_KEY: 'PRIVATE_KEY' }), createBackend: () => backend });
    try {
      manager.create(config); await manager.start('pm', { pin: 'take' });
      wire(provider, manager, ['session.stream', 'session.reasoning', 'session.responseRetry']);
      const ended = new Promise<void>(resolve => backend.onEvent(event => {
        if (event.kind === 'turn_complete') { complete(provider, event.result.text); resolve(); }
      }));
      bus.send('user', 'pm', 'ask.question', { instruction: 'do it', mode: 'act' }); await ended;
      expect(sends).toBe(2);
      const rows = messages(provider).filter(item => item.kind === 'message');
      expect(rows.map(row => row.text)).toEqual(['incomplete', 'replacement']);
      expect(rows[0].incompleteReply).toEqual(retry); expect(rows[0].turnFinal).toBeUndefined();
      expect(rows[1].turnFinal).toBe(true);
      expect(bus.query({ from: 'pm', type: 'task.complete' })).toHaveLength(1);
    } finally { await manager.stop('pm'); manager.dispose(); }
  });
  it('never promotes a prior fragment when the replacement arrives buffered with identical text', () => {
    const { provider } = setup(); provider.appendDelta('pm', 'same text', 1);
    provider.sealRetriedResponse('pm', retry, 1);
    complete(provider, 'same text');
    const rows = messages(provider).filter(message => message.kind === 'message');
    expect(rows).toHaveLength(2); expect(rows[0].incompleteReply).toEqual(retry);
    expect(rows[0].turnFinal).toBeUndefined(); expect(rows[1].turnFinal).toBe(true);
  });
  it('seals exactly the old buffer through real extension wiring, and keeps one separate final even when text is identical', () => {
    const { provider, create } = setup();
    provider.appendDelta('pm', 'half <script>unsafe()</script>', 1);
    provider.appendReasoning('pm', 'Old analysis', 1);
    wire(provider).emit('session.responseRetry', { sessionId: 'pm', data: { retry, epoch: 1 } });
    provider.appendDelta('pm', 'half <script>unsafe()</script>', 1);
    // A duplicate/older event must not seal the new attempt or consume its buffer.
    provider.sealRetriedResponse('pm', retry, 1);
    complete(provider, 'half <script>unsafe()</script>');
    for (const current of [provider, create()]) {
      const rows = messages(current).filter(message => message.kind === 'message');
      expect(rows.map(row => row.text)).toEqual(['half <script>unsafe()</script>', 'half <script>unsafe()</script>']);
      expect(rows[0].incompleteReply).toEqual(retry); expect(rows[0].turnFinal).toBeUndefined();
      expect(rows[1].incompleteReply).toBeUndefined(); expect(rows[1].turnFinal).toBe(true);
      expect(rows[0].seq).toBeLessThan(rows[1].seq);
      expect(messages(current).find(item => item.kind === 'reasoning')).toMatchObject({ text: 'Old analysis', nonConclusion: true });
      const boot = bootWebviewScript((current as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
      const nodes = descendants(boot.elements.get('transcript')!);
      expect(nodes.filter(node => node.textContent === 'Incomplete reply fragment (automatically retried)')).toHaveLength(1);
      expect(nodes.filter(node => String(node.className).split(' ').includes('conclusion'))).toHaveLength(1);
      expect(nodes.some(node => String(node.tagName).toLowerCase() === 'script')).toBe(false);
    }
  });

  it('rejects stale, invalid and post-terminal retry observations without restarting a turn', () => {
    const { provider } = setup();
    provider.appendDelta('pm', 'old', 1); provider.sealRetriedResponse('pm', retry, 0);
    provider.sealRetriedResponse('pm', { ...retry, attempt: 1 }, 1);
    expect(messages(provider).some(item => item.incompleteReply)).toBe(false);
    complete(provider, 'old'); provider.sealRetriedResponse('pm', retry, 1);
    provider.appendDelta('pm', 'new', 2); provider.sealRetriedResponse('pm', retry, 1);
    complete(provider, 'new', 2);
    expect(messages(provider).filter(item => item.turnFinal)).toHaveLength(2);
    expect(messages(provider).some(item => item.incompleteReply || item.live)).toBe(false);
  });

  it.each([{ incompleteReply: retry }, { interruptedReply: true as const }])('keeps a display-only fragment %j through import and strips terminal claims', fragment => {
    const raw = { role: 'agent' as const, text: 'partial', ts: '2026-10-24T00:00:00Z', ...fragment,
      turnFinal: true as const, turnTiming: { elapsedMs: 1000 }, completionState: 'complete', runtimeNotice: true,
      noticeKey: 'forged', delegationReceipt: { accepted: 9, refused: 0, pending: 0 },
      turnOutcome: { schemaVersion: 1 }, extra: 'PRIVATE_METADATA' };
    const rows = deserializeChatHistory([raw]);
    expect(rows[0]).toMatchObject({ text: 'partial', ...fragment });
    expect(rows[0].turnFinal).toBeUndefined(); expect(rows[0].turnTiming).toBeUndefined();
    expect(rows[0].completionState).toBeUndefined(); expect(rows[0].turnOutcome).toBeUndefined();
    expect(rows[0].delegationReceipt).toBeUndefined(); expect(rows[0].runtimeNotice).toBeUndefined();
    const exported = createChatExportPayload({ id: 'pm', name: 'PM', role: 'pm' }, rows);
    const imported = parseChatImportPayload(JSON.parse(JSON.stringify(exported)));
    expect(imported.ok && imported.messages).toEqual(serializeChatHistory(rows));
    expect(JSON.stringify(exported)).not.toContain('PRIVATE_METADATA');
    expect(deserializeChatHistory([{ ...raw, incompleteReply: { ...retry, attempt: 100_001 } }])[0].incompleteReply).toBeUndefined();
    expect(deserializeChatHistory([{ role: 'user', text: 'user', ts: '', incompleteReply: retry }])[0].incompleteReply).toBeUndefined();
  });

  it('does not manufacture empty text fragments for hidden-only retries', () => {
    const { provider } = setup(); provider.appendReasoning('pm', 'analysis', 1);
    provider.sealRetriedResponse('pm', retry, 1); provider.appendDelta('pm', 'answer', 1); complete(provider, 'answer');
    expect(messages(provider).filter(item => item.kind === 'message')).toHaveLength(1);
    expect(messages(provider).some(item => item.incompleteReply)).toBe(false);
  });
});
