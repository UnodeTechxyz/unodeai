import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { chatHistoryKey, deserializeChatHistory } from '../chatHistory';
import { dismissedNoticesKey, DISMISSED_NOTICE_LIMIT } from '../chatNoticePresentation';
import { parseChatWebviewInboundMessage } from '../chatWebviewProtocol';
import { bootWebviewScript, type WebviewBootResult, type WebviewElement } from './support/webviewBoot';

vi.mock('vscode', () => ({}));

function harness(initial?: unknown) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set(chatHistoryKey('pm'), structuredClone(initial));
  const send = vi.fn(); const interrupt = vi.fn(); const retry = vi.fn(async () => true);
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }, { id: 'dev', name: 'Dev', role: 'developer' }],
    send, interrupt, interject: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key, value) => { store.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
  };
  const create = () => { const provider = new ChatViewProvider({} as never, deps); provider.selectAgent('pm'); return provider; };
  return { store, send, interrupt, retry, create, provider: create() };
}
const current = (provider: ChatViewProvider) => (provider as any).currentState();
const descendants = (node: WebviewElement): WebviewElement[] => ((Array.isArray(node.children) ? node.children : []) as WebviewElement[])
  .flatMap(child => [child, ...descendants(child)]);
const transcriptNodes = (boot: WebviewBootResult) => descendants(boot.elements.get('transcript')!);
const closers = (boot: WebviewBootResult) => transcriptNodes(boot).filter(node => node.className === 'notice-close');
const bootChat = (provider: ChatViewProvider, container: 'sidebar' | 'workbench' = 'sidebar') =>
  bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, container), { focusModel: {} });
const republish = (boot: WebviewBootResult, provider: ChatViewProvider) => {
  for (const listener of boot.listeners.message ?? []) listener({ data: { command: 'state', state: current(provider) } });
};
function close(boot: WebviewBootResult, provider: ChatViewProvider, index = 0) {
  boot.postedMessages.length = 0;
  boot.dispatchElementEvent(closers(boot)[index], 'click', { preventDefault() {}, stopPropagation() {} });
  expect(boot.postedMessages).toHaveLength(1);
  expect(boot.postedMessages[0]).toMatchObject({ command: 'dismissNotice' });
  (provider as any).onMessage(boot.postedMessages[0], 'sidebar');
  republish(boot, provider);
}

describe('dismissible transcript reminders', () => {
  it('closes the very first render of a pre-sequence saved conversation and survives later writes/reload', () => {
    const initial = [{ role: 'agent', fromName: 'UnodeAi', runtimeNotice: true, text: 'Old reminder', ts: '2026-01-01T00:00:00Z' }];
    const { provider, create, store } = harness(initial);
    const boot = bootChat(provider); expect(closers(boot)).toHaveLength(1);
    close(boot, provider); expect(closers(boot)).toHaveLength(0);
    provider.postRuntimeNotice('pm', 'New unrelated reminder');
    expect(closers(bootChat(create()))).toHaveLength(1);
    expect(provider.exportSelected()!.messages[0].text).toBe('Old reminder');
    expect((store.get(chatHistoryKey('pm')) as any[])[0].notice).toBeUndefined();
  });
  it.each(['sidebar', 'workbench'] as const)('closes host and retry cards in %s without changing history, exports, model input or actions', container => {
    const { provider, create, store, retry, send, interrupt } = harness();
    provider.postRuntimeNotice('pm', 'Commands are disabled. Choose Commands → Automatic.');
    provider.recordFirstActionDeadline({ agentId: 'pm', turnId: 'old', retry });
    const exported = structuredClone(provider.exportSelected());
    const history = structuredClone(store.get(chatHistoryKey('pm')));
    const boot = bootChat(provider, container);
    expect(closers(boot)).toHaveLength(2);
    for (const button of closers(boot)) {
      expect(button.type).toBe('button');
      expect((button.getAttribute as (name: string) => string)('aria-label')).toBe('Close this notice');
    }
    // Native buttons remain keyboard-focusable; Enter/Space use the same click handler, not a repair handler.
    (closers(boot)[1].focus as () => void)(); expect(boot.activeElement()).toBe(closers(boot)[1]);
    close(boot, provider, 1);
    expect(closers(boot)).toHaveLength(1);
    close(boot, provider);
    expect(closers(boot)).toHaveLength(0);
    republish(boot, provider);
    expect(closers(boot)).toHaveLength(0);
    expect(closers(bootChat(create(), container))).toHaveLength(0);
    expect(provider.exportSelected()).toEqual(exported);
    expect(store.get(chatHistoryKey('pm'))).toEqual(history);
    expect(current(provider).messages).toHaveLength(2); // no deletion from the underlying transcript
    expect(send).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    expect(boot.postedMessages.some((m: any) => m.command === 'repairAction' || m.command === 'approvalDecision')).toBe(false);
    expect(boot.postedMessages.some((m: any) => m.command === 'renderedTranscriptItemsMissing')).toBe(false);
  });

  it('remembers a close per agent and updates both live surfaces', () => {
    const { provider, create } = harness();
    provider.postRuntimeNoticeOnce('pm', 'shared-key', 'A reminder');
    const sidebar = bootChat(provider); const workbench = bootChat(provider, 'workbench');
    close(sidebar, provider); republish(workbench, provider);
    expect(closers(workbench)).toHaveLength(0);
    provider.postRuntimeNoticeOnce('dev', 'shared-key', 'A reminder');
    provider.selectAgent('dev'); expect(closers(bootChat(provider))).toHaveLength(1);
    provider.selectAgent('pm'); expect(closers(bootChat(provider))).toHaveLength(0);
    expect(closers(bootChat(create()))).toHaveLength(0);
  });

  it('merges three consecutive identical host notices, hides the entire group, and still shows a new repetition', () => {
    const { provider, create } = harness();
    for (let n = 0; n < 3; n++) provider.postRuntimeNotice('pm', 'Same reminder');
    const boot = bootChat(provider);
    expect(closers(boot)).toHaveLength(1);
    expect(transcriptNodes(boot).filter(node => node.className === 'notice-count').map(node => node.textContent)).toEqual(['×3']);
    expect(deserializeChatHistory(provider.exportSelected()!.messages)).toHaveLength(3);
    close(boot, provider);
    expect(closers(bootChat(create()))).toHaveLength(0);
    provider.postRuntimeNotice('pm', 'Same reminder'); republish(boot, provider);
    expect(closers(boot)).toHaveLength(1);
    expect(transcriptNodes(boot).find(node => node.className === 'notice-count')!.textContent).toBe('×4');
    expect(boot.postedMessages.some((m: any) => m.command === 'renderedTranscriptItemsMissing')).toBe(false);
  });

  it('does not merge across a different notice, a user message, or a tool', () => {
    const { provider } = harness();
    provider.postRuntimeNotice('pm', 'Same'); provider.postRuntimeNotice('pm', 'Different'); provider.postRuntimeNotice('pm', 'Same');
    (provider as any).append('pm', { role: 'user', text: 'Continue', ts: new Date().toISOString() });
    provider.postRuntimeNotice('pm', 'Same');
    provider.appendToolActivity('pm', { phase: 'use', callId: 'read-1', name: 'read_file', input: { path: 'a.txt' } });
    provider.postRuntimeNotice('pm', 'Same');
    const boot = bootChat(provider);
    expect(closers(boot)).toHaveLength(5);
    expect(transcriptNodes(boot).filter(node => node.className === 'notice-count')).toEqual([]);
  });

  it('merges equal old deadline cards by title and text, not their different retry ids', () => {
    const { provider, retry } = harness();
    for (let n = 0; n < 3; n++) provider.recordFirstActionDeadline({ agentId: 'pm', turnId: `old${n}`, retry });
    const boot = bootChat(provider);
    expect(closers(boot)).toHaveLength(1);
    expect(transcriptNodes(boot).find(node => node.className === 'notice-count')!.textContent).toBe('×3');
    close(boot, provider);
    expect(closers(boot)).toHaveLength(0); expect(retry).not.toHaveBeenCalled();
    expect(provider.exportSelected()!.messages).toHaveLength(3);
  });

  it('keeps a pending approval unclosable, but makes its expired outcome closable', async () => {
    vi.useFakeTimers();
    const { provider } = harness();
    try {
      const opened = provider.openApproval({ kind: 'command', agentId: 'pm', sessionId: 'pm', agentName: 'PM', command: 'echo test' }, 60_000);
      const boot = bootChat(provider);
      expect(boot.elements.get('approvals')!.hidden).toBe(false);
      expect(closers(boot)).toHaveLength(0);
      expect(descendants(boot.elements.get('approvals')!).some(node => node.className === 'notice-close')).toBe(false);
      (provider as any).onMessage({ command: 'dismissNotice', agentId: 'pm', noticeKey: 'notice:' + '0'.repeat(64) }, 'sidebar');
      expect(current(provider).pendingApprovals).toHaveLength(1);
      vi.advanceTimersByTime(60_001); await expect(opened.outcome).resolves.toMatchObject({ action: 'deny', expired: true });
      republish(boot, provider); expect(closers(boot)).toHaveLength(1);
      close(boot, provider); expect(closers(boot)).toHaveLength(0);
    } finally { provider.dispose(); vi.useRealTimers(); }
  });

  it('closes restored 0.9.97 outcome, request-limit, expiry and unkeyed host lines across a reload', () => {
    const { provider, create } = harness();
    const rows = [
      { noticeKey: 'outcome-repair/first-action-deadline:legacy', text: 'No first action within 60 seconds\n\nOld reminder' },
      { noticeKey: 'outcome-repair/compaction-deadline:legacy', text: 'Compaction did not finish\n\nOld reminder' },
      { noticeKey: 'request-limit/legacy', text: 'Request limit\n\nSettled' },
      { noticeKey: 'approval-expired/legacy', text: 'Approval expired\n\nSettled' },
      { text: 'Old host runtime notice without a key', runtimeNotice: undefined },
    ].map((row, index) => ({ role: 'agent' as const, fromName: 'UnodeAi', runtimeNotice: true, ts: `2026-10-01T00:00:0${index}.000Z`, ...row }));
    provider.importToSelected(rows);
    const before = structuredClone(provider.exportSelected());
    const boot = bootChat(provider); expect(closers(boot)).toHaveLength(5);
    for (let n = 0; n < 5; n++) close(boot, provider);
    expect(provider.exportSelected()).toEqual(before);
    expect(closers(bootChat(create()))).toHaveLength(0);
    expect(boot.postedMessages.some((m: any) => m.command === 'renderedTranscriptItemsMissing')).toBe(false);
  });

  it('accepts only a shown reminder key for the selected agent and bounds remembered keys to 500', () => {
    const { create, store } = harness();
    const key = dismissedNoticesKey('pm');
    store.set(key, Array.from({ length: DISMISSED_NOTICE_LIMIT }, (_, i) => `notice:${i.toString(16).padStart(64, '0')}`));
    const provider = create();
    provider.postRuntimeNoticeOnce('pm', 'new-key', 'New');
    provider.postRuntimeNoticeOnce('dev', 'other-key', 'Other');
    provider.selectAgent('dev'); const otherKey = current(provider).messages[0].notice.key;
    provider.selectAgent('pm');
    (provider as any).onMessage({ command: 'dismissNotice', agentId: 'dev', noticeKey: otherKey }, 'sidebar');
    const boot = bootChat(provider); expect(closers(boot)).toHaveLength(1);
    close(boot, provider);
    const saved = store.get(key) as string[];
    expect(saved).toHaveLength(500); expect(saved[0]).toBe(`notice:${'1'.padStart(64, '0')}`);
    expect(store.has(dismissedNoticesKey('dev'))).toBe(false);
    for (const extra of [{ action: 'once' }, { kind: 'retry-same-route' }, { outcomeId: 'old' }]) {
      expect(parseChatWebviewInboundMessage({ command: 'dismissNotice', agentId: 'pm', noticeKey: saved.at(-1), ...extra }).ok).toBe(false);
    }
  });
});
