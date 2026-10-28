import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';

vi.mock('vscode', () => ({}));

function chat() {
  const store = new Map<string, unknown>();
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai', status: 'stopped' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key, value) => { store.set(key, value); } },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
    openAgentModelSettings: vi.fn(),
  };
  const create = () => {
    const provider = new ChatViewProvider({} as never, deps);
    provider.selectAgent('pm');
    return provider;
  };
  return { provider: create(), create };
}
const state = (provider: ChatViewProvider) => (provider as any).currentState();
const descendants = (node: WebviewElement): WebviewElement[] =>
  ((Array.isArray(node.children) ? node.children : []) as WebviewElement[]).flatMap(child => [child, ...descendants(child)]);
const cards = (boot: ReturnType<typeof bootWebviewScript>) => descendants(boot.elements.get('transcript')!)
  .filter(node => String(node.className).includes('outcome-repair'));
const labels = (node: WebviewElement) => descendants(node).filter(child => child.className !== 'notice-close')
  .map(child => String(child.textContent)).filter(Boolean);
const terminal = (provider: ChatViewProvider, turnId: string) => (provider as any).onReply({
  from: 'pm', fromName: 'PM', text: `Ended ${turnId}`, isError: true, turnId,
});

/** Execute the actual registration in wireEvents, not a copy of its event-to-card mapping.
 * Only unrelated extension host services are stand-ins; the card and webview renderer are real. */
function wireFirstAction(provider: ChatViewProvider) {
  const source = ts.createSourceFile('extension.ts', readFileSync(resolve('src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const wireEvents = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'wireEvents');
  const registrations = wireEvents?.body?.statements.filter((node): node is ts.ExpressionStatement => {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    const call = node.expression;
    return ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.getText(source) === 'sessionManager'
      && call.expression.name.text === 'on'
      && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'session.firstAction';
  }) ?? [];
  expect(registrations).toHaveLength(1);
  const sessionManager = new EventEmitter();
  const request = { id: 'buffered', payload: { instruction: 'Original request' } };
  const resubmit = vi.fn(async () => true);
  const host = {
    sessionManager, chatViewProvider: provider, outputChannel: { info: vi.fn() },
    messageBus: { getThread: vi.fn(() => [request]) }, userRequests: { resubmit },
  };
  const js = ts.transpileModule(registrations[0].getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('host', `with (host) { ${js} }`)(host);
  return { sessionManager, resubmit, request };
}

describe('terminal outcomes are transcript records, not pending decisions', () => {
  it.each(['stop-request', 'retry-same-route'] as const)('does not claim earlier work never happened when a compaction card settles via %s', async kind => {
    const { provider } = chat();
    provider.postRuntimeNoticeOnce('pm', 'prior-work', 'Earlier tool work is recorded here');
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'comp', deadline: 'native-compaction', compactionPauseMs: 300000,
      retry: async () => false });
    await (provider as any).onMessage({ command: 'repairAction', kind, outcomeId: 'compaction-deadline:comp' }, 'sidebar');
    const card = state(provider).messages.find((message: any) => message.outcomeCard)?.outcomeCard;
    expect(card.detail).toContain('already recorded'); expect(card.detail).not.toContain('Nothing was dispatched or changed');
    expect(state(provider).messages.some((message: any) => message.text === 'Earlier tool work is recorded here')).toBe(true);
  });
  it('wires a native compaction deadline to its distinct transcript card and preserves it on reload', async () => {
    const { provider, create } = chat(); const { sessionManager, resubmit, request } = wireFirstAction(provider);
    terminal(provider, 'buffered');
    provider.postRuntimeNoticeOnce('pm', 'later', 'A later turn');
    sessionManager.emit('session.firstAction', { sessionId: 'pm', data: { turnId: 'buffered', approvalWaitMs: 1000,
      evidence: { source: 'host-deadline', kind: 'needs-you', latencyMs: 320000, deadline: 'native-compaction', compactionPauseMs: 300000 } } });
    for (const current of [provider, create()]) {
      expect(state(current).messages.map((m: any) => m.text)).toEqual([
        'Ended buffered', expect.stringContaining('Context compaction did not finish'), 'A later turn',
      ]);
      const boot = bootWebviewScript((current as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
      expect(cards(boot)).toHaveLength(1);
      expect(labels(cards(boot)[0]).join(' ')).toContain('Context compaction did not finish within 300 seconds');
      expect(labels(cards(boot)[0]).join(' ')).toContain('Observed compaction pause: 300 seconds');
      expect(labels(cards(boot)[0]).join(' ')).not.toContain('No provider output');
      expect(boot.elements.get('approvals')!.hidden).toBe(true);
    }
    await (provider as any).onMessage({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'compaction-deadline:buffered' }, 'sidebar');
    expect(resubmit).toHaveBeenCalledExactlyOnceWith('pm', request);
  });
  it.each([60_000, 180_000])('wires the deadline evidence budget (%i ms) through the host event to the rendered card', async silenceBudgetMs => {
    const { provider, create } = chat();
    const { sessionManager, resubmit, request } = wireFirstAction(provider);
    const data = {
      turnId: 'buffered', approvalWaitMs: 0,
      evidence: { kind: 'deadline', source: 'host-deadline', latencyMs: silenceBudgetMs, silenceBudgetMs },
    };
    // Ordinary first-action evidence does not create a deadline card.
    sessionManager.emit('session.firstAction', { sessionId: 'pm', data: {
      ...data, evidence: { ...data.evidence, source: 'provider' },
    } });
    expect(state(provider).messages.some((m: any) => m.outcomeCard)).toBe(false);
    terminal(provider, 'buffered');
    sessionManager.emit('session.firstAction', { sessionId: 'pm', data });
    const seconds = silenceBudgetMs / 1000;
    for (const current of [provider, create()]) {
      const boot = bootWebviewScript((current as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
      expect(cards(boot)).toHaveLength(1);
      expect(labels(cards(boot)[0])[0]).toBe(`No provider output for ${seconds} seconds`);
      expect(labels(cards(boot)[0])[1]).toContain(`for ${seconds} seconds before`);
      expect(boot.elements.get('approvals')!.hidden).toBe(true);
    }
    await (provider as any).onMessage({ command: 'repairAction', outcomeId: 'first-action-deadline:buffered', kind: 'retry-same-route' }, 'sidebar');
    expect(resubmit).toHaveBeenCalledExactlyOnceWith('pm', request);
  });

  it('shows the ended response’s 180s budget in the live card and saved transcript, not the current route', () => {
    const { provider, create } = chat();
    terminal(provider, 'buffered');
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'buffered', silenceBudgetMs: 180_000, retry: vi.fn() });
    for (const current of [provider, create()]) {
      const boot = bootWebviewScript((current as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
      expect(cards(boot)).toHaveLength(1);
      expect(labels(cards(boot)[0]).join(' ')).toContain('No provider output for 180 seconds');
      expect(labels(cards(boot)[0]).join(' ')).toContain('for 180 seconds before');
      expect(boot.elements.get('approvals')!.hidden).toBe(true);
    }
  });

  it('does not re-append an outcome trimmed while its retry is in flight (MN1)', async () => {
    const { provider } = chat();
    let finish!: (ok: boolean) => void;
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'trimmed', retry: () => new Promise(resolve => { finish = resolve; }) });
    const retry = (provider as any).onMessage({ command: 'repairAction', outcomeId: 'first-action-deadline:trimmed', kind: 'retry-same-route' }, 'sidebar');
    for (let i = 0; i < 55; i++) provider.postRuntimeNoticeOnce('pm', `later-${i}`, `Later ${i}`);
    expect(state(provider).messages.some((m: any) => m.noticeKey === 'outcome-repair/first-action-deadline:trimmed')).toBe(false);
    const before = state(provider).messages.map((m: any) => m.seq);
    finish(false); await retry; // late unavailable settlement must not resurrect the trimmed notice
    expect(state(provider).messages.map((m: any) => m.seq)).toEqual(before);
    expect(state(provider).messages.some((m: any) => m.outcomeCard)).toBe(false);
  });
  it.each(['sidebar', 'workbench'] as const)('renders live actions in the %s transcript and updates the same card on settlement', async container => {
    const { provider } = chat();
    const retry = vi.fn(async () => true);
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'first', retry });
    const originalSeq = state(provider).messages.find((m: any) => m.outcomeCard).seq;
    terminal(provider, 'first'); // the terminal delivery can follow the first-action event
    provider.postRuntimeNoticeOnce('pm', 'later-turn', 'A later turn');
    const messages = state(provider).messages;
    expect(messages.map((m: any) => m.text)).toEqual([
      'Ended first', expect.stringContaining('No provider output'), 'A later turn',
    ]);
    expect(messages[1].seq).toBe(originalSeq); // placement never rewrites transcript identity
    const html = (provider as any).getHtml({ cspSource: 'test:' }, container);
    const boot = bootWebviewScript(html, { bodyClasses: container === 'workbench' ? ['container-workbench'] : [] });
    expect(boot.elements.get('approvals')!.hidden).toBe(true);
    expect(descendants(boot.elements.get('approvals')!)).toHaveLength(0);
    expect(cards(boot)).toHaveLength(1);
    expect(labels(cards(boot)[0])).toEqual([
      'No provider output for 60 seconds', expect.stringContaining('No output was received'),
      'Retry same route', 'Switch route', 'Stop',
    ]);
    // Exercise the real renderer's registered buttons, then dispatch only the retry message through the host parser.
    for (const listener of boot.listeners.click ?? []) {
      try { listener({ preventDefault() {}, stopPropagation() {}, target: {} }); } catch { /* unrelated control */ }
    }
    const message = boot.postedMessages.find((m: any) => m.command === 'repairAction' && m.kind === 'retry-same-route');
    expect(message).toEqual({ command: 'repairAction', kind: 'retry-same-route', outcomeId: 'first-action-deadline:first' });
    await (provider as any).onMessage(message, container);
    expect(retry).toHaveBeenCalledTimes(1);
    for (const listener of boot.listeners.message ?? []) listener({ data: { command: 'state', state: state(provider) } });
    expect(cards(boot)).toHaveLength(1);
    expect(labels(cards(boot)[0])).toEqual(['No provider output for 60 seconds', expect.stringContaining('started again')]);
    expect(boot.elements.get('approvals')!.hidden).toBe(true);
    expect(state(provider).messages.at(-1).text).toBe('A later turn');
    expect(boot.postedMessages.filter((m: any) => m.command === 'renderedTranscriptItemsMissing')).toEqual([]);
  });

  it('retains settled results and placement across reload and export/import, without restoring action authority', async () => {
    const { provider, create } = chat();
    const retry = vi.fn(async () => true);
    terminal(provider, 'old');
    provider.postRuntimeNoticeOnce('pm', 'newer', 'Later conversation');
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'old', retry }); // late receipt must anchor to old turn
    await (provider as any).onMessage({ command: 'repairAction', outcomeId: 'first-action-deadline:old', kind: 'stop-request' }, 'sidebar');
    const exported = provider.exportSelected()!.messages;
    expect(exported.filter(m => m.noticeKey?.startsWith('outcome-repair/'))).toHaveLength(1);
    expect(exported.find(m => m.noticeKey?.startsWith('outcome-repair/'))!.text).toContain('Stopped. Nothing');
    expect(JSON.stringify(exported)).not.toContain('"actions"');
    for (const restored of [create(), provider]) {
      if (restored === provider) expect(restored.importToSelected(exported)).toBe(true);
      expect(state(restored).messages.map((m: any) => m.text)).toEqual([
        'Ended old', expect.stringContaining('Stopped. Nothing'), 'Later conversation',
      ]);
      const outcome = state(restored).messages.find((m: any) => m.outcomeCard).outcomeCard;
      expect(outcome.actions).toBeUndefined();
      expect(outcome.action).toBeUndefined();
      await (restored as any).onMessage({ command: 'repairAction', outcomeId: 'first-action-deadline:old', kind: 'retry-same-route' }, 'sidebar');
    }
    expect(retry).not.toHaveBeenCalled();
  });

  it('importing an offered card cannot revive its old host closure, and trimmed or cleared cards cannot act', async () => {
    for (const method of ['import', 'trim', 'clear'] as const) {
      const { provider } = chat();
      const retry = vi.fn(async () => true);
      provider.recordFirstActionDeadline({ agentId: 'pm', turnId: method, retry });
      if (method === 'import') provider.importToSelected(provider.exportSelected()!.messages);
      if (method === 'clear') provider.clearSelectedAgent();
      if (method === 'trim') for (let i = 0; i < 55; i++) provider.postRuntimeNoticeOnce('pm', `next-${i}`, `Later ${i}`);
      await (provider as any).onMessage({ command: 'repairAction', outcomeId: `first-action-deadline:${method}`, kind: 'retry-same-route' }, 'sidebar');
      expect(retry).not.toHaveBeenCalled();
    }
  });

  it('keeps only a genuinely pending approval in the dock, then records its timeout in history', async () => {
    vi.useFakeTimers();
    const { provider, create } = chat();
    try {
      const opened = provider.openApproval({ kind: 'command', agentId: 'pm', sessionId: 'pm', agentName: 'PM', command: 'echo example' }, 60_000);
      const pending = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
      expect(pending.elements.get('approvals')!.hidden).toBe(false);
      vi.advanceTimersByTime(60_001);
      await expect(opened.outcome).resolves.toMatchObject({ action: 'deny', expired: true });
      for (const restored of [provider, create()]) {
        const boot = bootWebviewScript((restored as any).getHtml({ cspSource: 'test:' }, 'workbench'));
        expect(boot.elements.get('approvals')!.hidden).toBe(true);
        expect(cards(boot)).toHaveLength(1);
        expect(labels(cards(boot)[0]).join(' ')).toContain('Approval denied — timed out');
        expect(labels(cards(boot)[0]).join(' ')).toContain('cannot be approved');
      }
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });
});
