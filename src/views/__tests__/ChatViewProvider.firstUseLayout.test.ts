import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: { createWebviewPanel: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

/**
 * v0.9.106 first-use smoke (a ~170px sidebar, a long goal): the goal box grew to 200px, the Chat body overflowed, the
 * page scrolled around the first-use text and the box, and Send was clipped below the visible Chat. With no agent the
 * goal box now has a cap that is a share of the Chat's height, and the first-use text gives way instead of the page.
 * The rendered layout at 170, 300, 420 and 900px is checked in headless Edge; here the rules and the box's measuring.
 */
const GOAL_VIEW = {
  active: true, text: 'A long goal', revision: 1, phase: 'idle',
  suggestions: ['One', 'Two', 'Three'],
};

function chat(agents: boolean) {
  const provider = new ChatViewProvider({} as never, {
    listAgents: () => (agents ? [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai' }] : []),
    send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    ...(agents ? {} : { firstUse: { view: () => GOAL_VIEW, draft() {}, action() {}, handoverResult() {} } }),
  } as never);
  (provider as any).rosterLoaded();
  if (agents) provider.selectAgent('pm');
  const html: string = (provider as any).getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u });
  return { provider, html };
}

describe('v0.9.106 the first-use goal box in a short or narrow Chat', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('caps the goal box at a share of the Chat height and lets the first-use text give way, only while no agent exists', () => {
    const { html } = chat(false);
    expect(html).toContain('body.first-use #transcript { min-height: 0; }');
    expect(html).toContain('body.first-use #input { max-height: clamp(46px, 35vh, 200px); }');
    // The message box of an agent keeps its own rules: 46px to 200px, and the transcript keeps its 120px minimum.
    expect(html).toMatch(/\n {4}textarea \{[^}]*min-height: 46px;\s*max-height: 200px;/);
    expect(html).toMatch(/\n {4}#transcript \{[^}]*min-height: 120px;/);
  });

  it('the goal box scrolls inside itself past the cap that applies to it, and an agent\'s box keeps its 200px cap', () => {
    for (const agents of [false, true]) {
      const { provider, html } = chat(agents);
      const booted = bootWebviewScript(html);
      const input = booted.elements.get('input') as any;
      // The cap the stylesheet gives the box now: a share of a 385px Chat in first use, 200px otherwise.
      let cap = agents ? '200px' : '135px';
      vi.stubGlobal('getComputedStyle', (element: unknown) => ({ maxHeight: element === input ? cap : 'none' }));
      booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
      expect(booted.body.classList.contains('first-use')).toBe(!agents);
      input.clientWidth = 150;
      const typed = (scrollHeight: number) => {
        // A box this tall holds text (an empty box never scrolls).
        input.value = 'A long goal';
        input.scrollHeight = scrollHeight;
        booted.dispatchElementEvent(input, 'input');
        return [input.style.height, input.style.overflowY];
      };
      expect(typed(400), `agents: ${agents}`).toEqual(agents ? ['200px', 'auto'] : ['135px', 'auto']);
      expect(typed(150), `agents: ${agents}`).toEqual(agents ? ['150px', 'hidden'] : ['135px', 'auto']);
      expect(typed(100), `agents: ${agents}`).toEqual(['100px', 'hidden']);
      // No cap read from the stylesheet: the script's own 200px.
      cap = 'none';
      expect(typed(400), `agents: ${agents}`).toEqual(['200px', 'auto']);
    }
  });

  it('measures the goal box again when the Chat is resized in first use', () => {
    const { provider, html } = chat(false);
    const booted = bootWebviewScript(html);
    const input = booted.elements.get('input') as any;
    let cap = '200px';
    vi.stubGlobal('getComputedStyle', (element: unknown) => ({ maxHeight: element === input ? cap : 'none' }));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
    input.clientWidth = 150;
    input.value = 'A long goal';
    input.scrollHeight = 180;
    booted.dispatchElementEvent(input, 'input');
    expect([input.style.height, input.style.overflowY]).toEqual(['180px', 'hidden']);
    // The Chat gets shorter: the cap follows its height, and the box now scrolls.
    cap = '120px';
    for (const listener of booted.listeners.resize ?? []) (listener as () => void)();
    expect([input.style.height, input.style.overflowY]).toEqual(['120px', 'auto']);
  });
});
