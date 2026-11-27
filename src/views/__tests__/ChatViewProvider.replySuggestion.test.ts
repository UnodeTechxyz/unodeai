import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider, type ChatReply, type ChatReplySuggestionPort, type ChatViewDeps } from '../ChatViewProvider';
import { bootWebviewScript, type WebviewBootResult } from './support/webviewBoot';
import type { SuggestionOutcome } from '../../suggestions/ReplySuggestionService';

vi.mock('vscode', () => ({}));

/** Let the port's answer travel back through the provider's promise chain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/*
 * v0.9.110 S2: a reply suggestion from the host's final answer to the composer and back, through the real provider and
 * the real webview script: the host offers, the page says it is empty, the port is asked once, the page shows the
 * suggestion as ghost text and fills it on Tab. Key events are dispatched to the page's own listeners.
 */

interface Asked { request: Parameters<ChatReplySuggestionPort['suggest']>[0]; resolve(outcome: SuggestionOutcome): void }

function harness(options: { enabled?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const asked: Asked[] = [];
  const pins: Array<{ requestId: string; released: boolean; release(): void }> = [];
  let enabled = options.enabled ?? true;
  let settingsRevision = 1;
  const port: ChatReplySuggestionPort = {
    enabled: () => enabled,
    settingsRevision: () => settingsRevision,
    workspaceId: () => 'file:///w',
    pinBudget: (requestId) => { const pin = { requestId, released: false, release() { pin.released = true; } }; pins.push(pin); return pin; },
    suggest: (request) => new Promise<SuggestionOutcome>((resolve) => asked.push({ request, resolve })),
  };
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }, { id: 'dev', name: 'Dev', role: 'developer' }],
    send: vi.fn(), interrupt: vi.fn(), interject: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key, value) => { store.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
    replySuggestions: port,
  };
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('pm');
  const hostPosts: Array<Record<string, unknown>> = [];
  const page: WebviewBootResult = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'sidebar'), { focusModel: {} });
  // The sidebar is visible; what the host posts to it reaches the booted page's own message listeners.
  (provider as any).sidebarView = {
    visible: true,
    webview: {
      postMessage: (message: Record<string, unknown>) => {
        hostPosts.push(message);
        for (const listener of page.listeners.message ?? []) listener({ data: message });
        return Promise.resolve(true);
      },
    },
  };
  let relayed = 0;
  /** Hand what the page posted since the last call to the host, as VS Code would. */
  const relay = () => {
    while (relayed < page.postedMessages.length) {
      (provider as any).onMessage(page.postedMessages[relayed++], 'sidebar');
    }
  };
  const input = page.elements.get('input') as any;
  const box = page.elements.get('replySuggestion') as any;
  // The stub starts every element visible; the suggestion counts as shown only with its text in it.
  const shown = () => {
    const text = String((page.elements.get('replySuggestionText') as any).textContent ?? '');
    return box.hidden === false && text ? text : undefined;
  };
  const key = (init: Record<string, unknown>) => {
    const event = { key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, preventDefault: vi.fn(), ...init };
    // A key event on the box comes from the focused box.
    input.focus();
    page.dispatchElementEvent(input, 'keydown', event);
    return event;
  };
  const answer = (overrides: Partial<ChatReply> = {}) => {
    (provider as any).onReply({ from: 'pm', fromName: 'PM', text: 'Fixed the parser.', isError: false, turnId: 't1', requestId: 'r1',
      completionState: 'complete', ...overrides } satisfies ChatReply);
    relay();
  };
  const sentToPage = (command: string) => page.postedMessages.filter((message: any) => message.command === command);
  input.value = '';
  if (typeof input.focus === 'function') input.focus();
  return {
    provider, page, port, asked, pins, hostPosts, relay, input, shown, key, answer, sentToPage,
    setEnabled: (value: boolean) => { enabled = value; },
    bumpSettings: () => { settingsRevision += 1; },
  };
}

describe('reply suggestion: host offer to composer and back', () => {
  it('asks the port once for the shown answer, shows the suggestion, and Tab fills the draft without sending', async () => {
    const h = harness();
    h.answer();
    expect(h.sentToPage('replySuggestionStart')).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].request).toMatchObject({ agentId: 'pm', agentName: 'PM' });
    expect(h.asked[0].request.budget.requestId).toBe('r1');
    expect(h.asked[0].request.messages.at(-1)).toMatchObject({ role: 'agent', text: 'Fixed the parser.' });
    h.asked[0].resolve({ kind: 'suggestion', text: 'Add a regression test.', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBe('Add a regression test.');
    const tab = h.key({ key: 'Tab' });
    expect(tab.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.input.value).toBe('Add a regression test.');
    expect(h.shown()).toBeUndefined();
    h.relay();
    expect(h.sentToPage('replySuggestionAccepted')).toHaveLength(1);
    // Filled, not sent: no send left the page.
    expect(h.sentToPage('send')).toEqual([]);
  });

  it('None offers nothing and asks nothing', () => {
    const h = harness({ enabled: false });
    h.answer();
    expect(h.hostPosts.filter((message) => message.command === 'replySuggestionOffer')).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it.each([
    ['an error', { isError: true }],
    ['an answer still waiting for its team', { completionState: 'partial' as const }],
    ['a turn that handed work out', { delegationReceipt: { accepted: 1, refused: 0, pending: 0 } }],
    ['another member than the one shown', { from: 'dev', fromName: 'Dev' }],
    ['a reply without its request', { requestId: undefined }],
  ])('offers nothing for %s', (_name, overrides) => {
    const h = harness();
    h.answer(overrides as Partial<ChatReply>);
    expect(h.asked).toEqual([]);
  });

  it('a composer with a draft is not offered one, and its draft is never overwritten', async () => {
    const h = harness();
    h.input.value = 'my own words';
    h.answer();
    expect(h.sentToPage('replySuggestionStart')).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.input.value).toBe('my own words');
  });

  it('typing while the request is out ends it: the request is aborted and the late answer is not shown', async () => {
    const h = harness();
    h.answer();
    const signal = h.asked[0].request.signal;
    h.input.value = 'x';
    h.page.dispatchElementEvent(h.input, 'input', {});
    h.relay();
    expect(signal.aborted).toBe(true);
    h.asked[0].resolve({ kind: 'suggestion', text: 'Too late.', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBeUndefined();
    expect(h.hostPosts.filter((message) => message.command === 'replySuggestion')).toEqual([]);
  });

  it('an answer for an earlier composer revision is not shown, even if the host delivers it', () => {
    const h = harness();
    h.answer();
    // The page moved on (a typed and deleted character), but the host was not told before delivering.
    h.input.value = 'a';
    h.page.dispatchElementEvent(h.input, 'input', {});
    h.input.value = '';
    for (const listener of h.page.listeners.message ?? []) {
      listener({ data: { command: 'replySuggestion', opId: 'op-x', agentId: 'pm', text: 'Stale.', composerRevision: 0 } });
    }
    expect(h.shown()).toBeUndefined();
  });

  it('Shift+Tab, a Tab during IME composition and a Tab with a modifier move focus as usual', async () => {
    const h = harness();
    h.answer();
    h.asked[0].resolve({ kind: 'suggestion', text: 'Next step?', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBe('Next step?');
    for (const init of [{ shiftKey: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }]) {
      const event = h.key(init);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(h.input.value).toBe('');
    }
    expect(h.shown()).toBe('Next step?');
    // An IME composition that starts ends the suggestion.
    h.page.dispatchElementEvent(h.input, 'compositionstart', {});
    expect(h.shown()).toBeUndefined();
    const after = h.key({});
    expect(after.preventDefault).not.toHaveBeenCalled();
    expect(h.input.value).toBe('');
  });

  it('Tab is left to an open menu', async () => {
    const h = harness();
    h.answer();
    h.asked[0].resolve({ kind: 'suggestion', text: 'Menu open.', usageUnitId: 'u1' });
    await settle();
    // The menu is open, as its trigger says.
    (h.page.elements.get('autonomyButton') as any).setAttribute('aria-expanded', 'true');
    const event = h.key({});
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.input.value).toBe('');
  });

  it('the Accept control fills the draft like Tab', async () => {
    const h = harness();
    h.answer();
    h.asked[0].resolve({ kind: 'suggestion', text: 'Clicked in.', usageUnitId: 'u1' });
    await settle();
    h.page.dispatchElementEvent(h.page.elements.get('replySuggestionAccept') as any, 'click', {});
    expect(h.input.value).toBe('Clicked in.');
    expect(h.sentToPage('send')).toEqual([]);
  });

  it('Tab with no suggestion is left to the browser', () => {
    const h = harness();
    const event = h.key({});
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('Escape, Send, a member switch and a settings change end it; the composer is told to drop it', async () => {
    for (const end of ['escape', 'send', 'switch', 'settings'] as const) {
      const h = harness();
      h.answer();
      h.asked[0].resolve({ kind: 'suggestion', text: 'Shown.', usageUnitId: 'u1' });
      await settle();
      expect(h.shown()).toBe('Shown.');
      if (end === 'escape') h.key({ key: 'Escape' });
      if (end === 'send') (h.provider as any).onMessage({ command: 'send', agentId: 'pm', text: 'hi', attachments: [], mode: 'act', stopSeen: 0 }, 'workbench');
      if (end === 'switch') (h.provider as any).onMessage({ command: 'selectAgent', agentId: 'dev' }, 'sidebar');
      if (end === 'settings') h.provider.dismissReplySuggestions();
      expect(h.shown()).toBeUndefined();
      // Nothing more is offered for the same answer.
      h.relay();
      expect(h.asked).toHaveLength(1);
    }
  });

  it('a host result after a settings change is not delivered', async () => {
    const h = harness();
    h.answer();
    h.bumpSettings();
    h.asked[0].resolve({ kind: 'suggestion', text: 'Old model.', usageUnitId: 'u1' });
    await settle();
    expect(h.hostPosts.filter((message) => message.command === 'replySuggestion')).toEqual([]);
    expect(h.shown()).toBeUndefined();
  });

  it('a reload shows no suggestion: the page state never holds one', async () => {
    const h = harness();
    h.answer();
    h.asked[0].resolve({ kind: 'suggestion', text: 'Not kept.', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBe('Not kept.');
    expect(JSON.stringify(h.page.savedStates)).not.toContain('Not kept.');
  });

  // Codex audit F1: in production the final reply is delivered inside holdPosts; the offer must follow the idle state.
  it('a reply delivered with its posts held is offered only after the state that ends the turn', async () => {
    const h = harness();
    (h.provider as any).runningAgentIds.add('pm');
    (h.provider as any).postState();
    const order: string[] = [];
    const before = h.hostPosts.length;
    h.provider.holdPosts(() => {
      (h.provider as any).onReply({ from: 'pm', fromName: 'PM', text: 'Done.', isError: false, turnId: 't1', requestId: 'r1', completionState: 'complete' });
    });
    for (const message of h.hostPosts.slice(before)) {
      order.push(message.command === 'state' ? `state:${((message.state as any).runningAgentIds ?? []).join(',')}` : String(message.command));
    }
    expect(order.indexOf('replySuggestionOffer')).toBeGreaterThan(order.indexOf('state:'));
    h.relay();
    expect(h.sentToPage('replySuggestionStart')).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
  });

  // Codex audit F3: every real switch ends the suggestion, offered or shown, and never brings it back.
  it('working in the other container ends it at once, and it is not made again there', async () => {
    const h = harness();
    h.answer();
    const signal = h.asked[0].request.signal;
    (h.provider as any).onMessage({ command: 'accessibilityFocus', focused: true }, 'workbench');
    expect(signal.aborted).toBe(true);
    h.asked[0].resolve({ kind: 'suggestion', text: 'Late.', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.pins[0].released).toBe(true);
  });

  it('focus moving within the same container ends nothing', () => {
    const h = harness();
    h.answer();
    (h.provider as any).onMessage({ command: 'accessibilityFocus', focused: true }, 'sidebar');
    expect(h.asked[0].request.signal.aborted).toBe(false);
  });

  it('a member switch through the host, and a return, end it and do not bring the old result back', async () => {
    const h = harness();
    h.answer();
    const signal = h.asked[0].request.signal;
    h.provider.selectAgent('dev');
    expect(signal.aborted).toBe(true);
    h.provider.selectAgent('pm');
    h.asked[0].resolve({ kind: 'suggestion', text: 'Before the switch.', usageUnitId: 'u1' });
    await settle();
    expect(h.shown()).toBeUndefined();
    expect(h.hostPosts.filter((message) => message.command === 'replySuggestion')).toEqual([]);
  });

  it('a switch before the composer answered ends the pending offer: no request is made', () => {
    const h = harness();
    // The offer reaches the page but the page's answer has not reached the host yet.
    (h.provider as any).onReply({ from: 'pm', fromName: 'PM', text: 'Done.', isError: false, turnId: 't1', requestId: 'r1', completionState: 'complete' });
    h.provider.selectAgent('dev');
    h.relay();
    expect(h.asked).toEqual([]);
    expect(h.pins[0].released).toBe(true);
  });
});
