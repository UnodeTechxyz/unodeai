import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

/**
 * What the meter RENDERS, not what its state object contains.
 *
 * v0.9.50 was verified by reading the source and asserting the state — and shipped a control that showed a
 * blank pill on every runtime that could not report. The state was right the whole time. This suite drives
 * the real webview script and reads the text a user would see.
 */
function renderWith(contextMeter: unknown, container: 'sidebar' | 'workbench' = 'sidebar') {
  const store = new Map<string, unknown>();
  const provider = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'a', name: 'Dev', role: 'senior-dev' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    contextMeter: () => contextMeter as never,
    compactContext: vi.fn(),
  } as never);
  const html = (provider as any).getHtml({ cspSource: 'test:' }, container) as string;
  const boot = bootWebviewScript(html);
  expect((provider as any).currentState()).not.toHaveProperty('context');
  const handlers = boot.listeners.message ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) {
    handler({
      data: {
        command: 'state',
        state: {
          agents: [{ id: 'a', name: 'Dev', role: 'senior-dev', routeLabel: 'OmniCodex', model: 'gpt-6-sol' }],
          selectedAgentId: 'a',
          messages: [], runningAgentIds: [], mode: 'act',
          contextMeter,
          // What a 0.9.91 host sent for the facts line. The webview no longer reads it.
          context: { text: 'Context not measured yet', percent: 0, level: 'none' },
        },
      },
    });
  }
  const button = boot.elements.get('ctxCompact');
  const label = boot.elements.get('ctxMeter');
  if (!button || !label) { throw new Error('the composer did not render a context meter'); }
  return {
    text: String(label.textContent ?? ''),
    // The reading and the action are separate controls; a user must be able to see the button whenever an
    // agent is selected, and read the reason for its state beside it.
    buttonLabel: String(button.textContent ?? ''),
    title: String(button.title ?? ''),
    disabled: button.disabled === true,
    gone: button.classList.contains('is-gone'),
    buttonGone: button.classList.contains('is-gone'),
    warn: label.classList.contains('warn'),
    facts: String(boot.elements.get('sessionFacts')?.textContent ?? ''),
  };
}

describe('the context meter renders an answer, never a blank', () => {
  it('shows the ratio and its denominator when the runtime reports one', () => {
    const rendered = renderWith({
      kind: 'usage',
      usage: { tokens: 900_000, window: 1_048_576, ratio: 0.86, source: 'assumed' },
    });
    expect(rendered.text).toBe('86% of an assumed 1,048,576 tokens');
    // An icon, not a word (Owner, 2026-08-12). The meaning lives in the meter text and the accessible name.
    expect(rendered.buttonLabel).toBe('⤓');
    expect(rendered.buttonGone).toBe(false);
    expect(rendered.disabled).toBe(false);
    expect(rendered.gone).toBe(false);
    expect(rendered.warn).toBe(true);
  });

  it('names the provider-refused denominator rather than calling a proved ceiling an assumption', () => {
    const rendered = renderWith({
      kind: 'usage',
      usage: { tokens: 40_000, window: 96_000, ratio: 0.41, source: 'observed' },
    });
    expect(rendered.text).toBe('41% of a provider-refused 96,000 tokens');
    expect(rendered.warn).toBe(false);
  });

  // The two states that shipped as an empty pill. Each must say something a user can act on, and neither
  // may claim the other's cause: "start the agent" is a promise a CLI-managed runtime can never keep.
  it('says the agent is not running instead of rendering nothing', () => {
    const rendered = renderWith({ kind: 'not-started' });
    expect(rendered.text).toBe('Context — start the agent');
    expect(rendered.disabled).toBe(true);
    expect(rendered.gone).toBe(false);
    expect(rendered.title).toMatch(/not running/);
    expect(rendered.title).not.toMatch(/owns its own context/);
    // Present but inert. An absent control and an unavailable one look identical, which is how the last
    // release was read as shipping no button at all.
    expect(rendered.buttonGone).toBe(false);
    expect(rendered.buttonLabel).toBe('⤓');
  });

  it('says the runtime owns the context instead of rendering nothing', () => {
    const rendered = renderWith({ kind: 'unsupported' });
    expect(rendered.text).toBe('Context — managed by the runtime');
    expect(rendered.disabled).toBe(true);
    expect(rendered.gone).toBe(false);
    expect(rendered.title).toMatch(/owns its own context window/);
    expect(rendered.title).not.toMatch(/not running/);
    expect(rendered.buttonGone).toBe(false);
  });

  it('says a native runtime has not reported yet, and still lets the user compact it (v0.9.90)', () => {
    const rendered = renderWith({ kind: 'awaiting-report' });
    expect(rendered.text).toBe('Context — measured after the next reply');
    expect(rendered.disabled).toBe(false);
    expect(rendered.title).toMatch(/summarise this conversation now/);
    expect(rendered.title).not.toMatch(/owns its own context|nothing of its own to compact/);
  });

  // Field run, 2026-10-02: the Workbench's session bar said "Context not measured yet" while the meter under it
  // said "Context — start the agent". The meter now sits in that bar, and the facts beside it name no context.
  it('is the one context reading in the Workbench session bar', () => {
    const rendered = renderWith({ kind: 'not-started' }, 'workbench');
    expect(rendered.text).toBe('Context — start the agent');
    expect(rendered.gone).toBe(false);
    expect(rendered.facts).toBe('senior-dev · OmniCodex · gpt-6-sol');
  });

  it('disappears only when there is no agent to describe', () => {
    expect(renderWith(undefined).gone).toBe(true);
  });
});
