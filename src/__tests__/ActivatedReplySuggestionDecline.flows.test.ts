import { describe, expect, it, vi } from 'vitest';

const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { context, fakeFetch, installActivatedExtension, pumpWhile, replies, requests, scripts } from './support/activatedHarness';
import { modelDeclineKey } from '../security/ImpliedConsent';

/*
 * v0.9.110 (release security re-audit, finding 2): a reply suggestion under a standing decline of its connection,
 * through the real window: activate(), the real suggestion service and its real egress wiring, the real consent decision
 * and decline list. The PM answers on its own connection; the suggestion connection (Unode) was declined before this
 * window opened. Each answer offers a suggestion; the egress question for it is asked at most once for each setting,
 * says it is for a reply suggestion, and nothing is sent to the declined connection.
 */

// Declined in an earlier session, as the decline list stores it.
await context.globalState.update('unode.egressConsentDeclines.v1', [modelDeclineKey('unode', 'https://www.unodetech.xyz:443')]);

// VS Code tells the window when a setting changes; the stand-in keeps the listeners so this test can say so too.
const configurationListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
host.overrides['vscode.workspace.onDidChangeConfiguration'] = (listener: (typeof configurationListeners)[number]) => {
  configurationListeners.push(listener);
  return { dispose() {} };
};
const settingChanged = (key: string) => {
  for (const listener of [...configurationListeners]) listener({ affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`) });
};

let screen: any;
let provider: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; provider = ready.chatProvider; });

async function withSuggestionModel(input: unknown, init?: { body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string } : undefined;
  if (!body?.model?.startsWith('sugg-model')) return fakeFetch(input, init);
  requests.push(body as never);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Never shown.' } }] }), { status: 200 });
}

describe('a declined reply suggestion connection in the activated window', () => {
  it('asks at most once for each setting, says it is for a reply suggestion, and sends nothing', async () => {
    vi.stubGlobal('fetch', withSuggestionModel);
    try {
      const questions: string[] = [];
      host.overrides['vscode.window.showWarningMessage'] = async (text: string) => { questions.push(String(text)); return 'Do not allow'; };
      const offers: number[] = [];
      const view = provider.sidebarView;
      const post = view.webview.postMessage;
      view.webview.postMessage = (message: any) => { if (message.command === 'replySuggestionOffer') offers.push(offers.length); return post(message); };
      const config = (host.overrides['vscode.workspace.getConfiguration'] as Function)('unode');
      await config.update('replySuggestions.model', { connectionId: 'unode', modelId: 'sugg-model' });
      await screen.select('pm');
      const suggestionQuestions = () => questions.filter((text) => text.includes('to suggest one reply'));
      /** One answer, then the suggestion it offers, which goes through the egress decision. */
      const answer = async (text: string, offersBefore: number) => {
        scripts.set('pm-model', () => ({ text: `answered ${text}` }));
        const page = screen.page();
        (page.elements.get('input') as any).value = text;
        page.dispatchElementEvent(page.elements.get('input'), 'input', {});
        await screen.sendBox();
        await pumpWhile(() => !replies('pm').includes(`answered ${text}`), screen.pump);
        await pumpWhile(() => offers.length <= offersBefore, screen.pump);
        for (let round = 0; round < 20; round++) await screen.pump();
      };

      await answer('first question', 0);
      expect(suggestionQuestions()).toHaveLength(1);
      expect(suggestionQuestions()[0]).toContain('do not ask again until you change the reply suggestion model');
      expect(suggestionQuestions()[0]).not.toContain("this agent's prompt");
      await answer('second question', offers.length);
      expect(suggestionQuestions()).toHaveLength(1);

      // Another model is a new setting: the next suggestion may ask once again.
      await config.update('replySuggestions.model', { connectionId: 'unode', modelId: 'sugg-model-2' });
      settingChanged('unode.replySuggestions.model');
      await answer('third question', offers.length);
      expect(suggestionQuestions()).toHaveLength(2);

      // Nothing reached the declined connection, and no question was about anything else.
      expect(requests.filter((request) => String(request.model).startsWith('sugg-model'))).toEqual([]);
      expect(questions).toHaveLength(2);
    } finally {
      vi.stubGlobal('fetch', fakeFetch);
    }
  });
});
