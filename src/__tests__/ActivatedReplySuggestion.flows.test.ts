import { describe, expect, it, vi } from 'vitest';

const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { fakeFetch, installActivatedExtension, pumpWhile, replies, requests, scripts } from './support/activatedHarness';

/*
 * v0.9.110 S2 (Codex audit F1): the reply suggestion through the real window. activate(), the registered sidebar, the
 * real session and backend, the real final-reply delivery (inside holdPosts), the real suggestion service on the real
 * one-request transport; only VS Code and HTTP are stood in. The person types and sends, the answer arrives, the
 * suggestion appears as ghost text, and Tab fills an ordinary draft without sending it.
 */

let screen: any;
let provider: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; provider = ready.chatProvider; });

/** The suggestion model answers as a plain chat completion; everything else is the harness's own scripted model. */
async function withSuggestionModel(input: unknown, init?: { body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string; stream?: boolean; tools?: unknown } : undefined;
  if (body?.model !== 'sugg-model') return fakeFetch(input, init);
  requests.push(body as never);
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'Add a regression test for the parser.' } }],
    usage: { prompt_tokens: 40, completion_tokens: 8 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('reply suggestion in the activated window', () => {
  it('typed message, Send, the real final delivery, ghost text, Tab: an ordinary draft, and nothing sent', async () => {
    vi.stubGlobal('fetch', withSuggestionModel);
    try {
      const timeline: Array<{ command: string; running?: string[] }> = [];
      const view = provider.sidebarView;
      const post = view.webview.postMessage;
      view.webview.postMessage = (message: any) => {
        timeline.push({ command: message.command, ...(message.command === 'state' ? { running: message.state.runningAgentIds } : {}) });
        return post(message);
      };
      const config = (host.overrides['vscode.workspace.getConfiguration'] as Function)('unode');
      await config.update('replySuggestions.model', { connectionId: 'unode', modelId: 'sugg-model' });
      scripts.set('pm-model', () => ({ text: 'The parser is fixed.' }));
      await screen.select('pm');
      const typed = screen.page();
      (typed.elements.get('input') as any).value = 'Fix the parser.';
      typed.dispatchElementEvent(typed.elements.get('input'), 'input', {});
      await screen.sendBox();
      await pumpWhile(() => !replies('pm').includes('The parser is fixed.'), screen.pump);
      const page = screen.page();
      const box = page.elements.get('replySuggestion') as any;
      const ghost = () => (box.hidden === false ? String((page.elements.get('replySuggestionText') as any).textContent ?? '') : '');
      await pumpWhile(() => ghost() === '', screen.pump);

      // The offer came after the state that shows the PM idle, and exactly one suggestion request was made.
      const offered = timeline.findIndex((item) => item.command === 'replySuggestionOffer');
      const stateBefore = timeline.slice(0, offered).findLast((item) => item.command === 'state');
      expect(stateBefore?.running).not.toContain('pm');
      const suggestionRequests = requests.filter((request) => request.model === 'sugg-model');
      expect(suggestionRequests).toHaveLength(1);
      expect((suggestionRequests[0] as unknown as { tools?: unknown; stream?: boolean }).tools).toBeUndefined();
      expect(JSON.stringify(suggestionRequests[0].messages)).toContain('The parser is fixed.');
      expect(ghost()).toBe('Add a regression test for the parser.');

      // Tab fills the draft; nothing is sent, and the PM starts no turn.
      const sendsBefore = page.postedMessages.filter((message: any) => message.command === 'send').length;
      const pmRequestsBefore = requests.filter((request) => request.model === 'pm-model').length;
      const event = { key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, preventDefault: vi.fn() };
      page.dispatchElementEvent(page.elements.get('input'), 'keydown', event);
      await screen.pump();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect((page.elements.get('input') as any).value).toBe('Add a regression test for the parser.');
      expect(ghost()).toBe('');
      expect(page.postedMessages.filter((message: any) => message.command === 'send')).toHaveLength(sendsBefore);
      expect(requests.filter((request) => request.model === 'pm-model')).toHaveLength(pmRequestsBefore);
      expect(replies('pm').at(-1)).toBe('The parser is fixed.');
    } finally {
      vi.stubGlobal('fetch', fakeFetch);
    }
  });
});
