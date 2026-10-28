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
 * What the ring RENDERS, not what its state object contains.
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
  if (!button) { throw new Error('the composer did not render the context ring'); }
  // The sidebar composer shows only the ring (Owner, 2026-10-27); the Workbench session bar keeps the text reading.
  const label = container === 'workbench' ? boot.elements.get('ctxMeter') : undefined;
  const attribute = (element: unknown, name: string) => String((element as { getAttribute(name: string): unknown }).getAttribute(name) ?? '');
  return {
    html,
    boot,
    button,
    text: label ? String(label.textContent ?? '') : undefined,
    warn: label ? label.classList.contains('warn') : undefined,
    glyph: String(boot.elements.get('ctxRingGlyph')?.textContent ?? ''),
    ring: attribute(button, 'data-ring'),
    filled: attribute(boot.elements.get('ctxRingFill'), 'stroke-dasharray'),
    title: String(button.title ?? ''),
    ariaLabel: attribute(button, 'aria-label'),
    disabled: button.disabled === true,
    gone: button.classList.contains('is-gone'),
    facts: String(boot.elements.get('sessionFacts')?.textContent ?? ''),
  };
}

const usage = (tokens: number, window: number, source = 'measured') => ({ tokens, window, ratio: tokens / window, source });

describe('the context ring renders an answer, never a blank', () => {
  it('is the only context control in the sidebar composer, and the Workbench bar keeps its text reading', () => {
    const sidebar = renderWith({ kind: 'usage', usage: usage(40_000, 100_000) });
    expect(sidebar.html).not.toContain('id="ctxMeter"');
    const workbench = renderWith({ kind: 'usage', usage: usage(40_000, 100_000) }, 'workbench');
    expect(workbench.html).toContain('id="ctxMeter"');
    expect(workbench.text).toBe('40% of a measured 100,000 tokens');
  });

  it('is a real button with the compact glyph inside the ring and a full-sentence accessible name', () => {
    const rendered = renderWith({ kind: 'usage', usage: usage(900_000, 1_048_576, 'assumed') });
    expect(rendered.html).toMatch(/<button class="ctx-compact is-gone" id="ctxCompact" type="button"[^>]*>\s*<svg class="ctx-ring"[^>]*aria-hidden="true"[\s\S]*?<span class="ctx-ring-glyph" id="ctxRingGlyph">⤓<\/span>\s*<\/button>/);
    expect(rendered.html).toContain('.composer-actions .ctx-compact:focus-visible');
    expect(rendered.glyph).toBe('⤓');
    expect(rendered.ariaLabel).toBe(rendered.title);
    expect(rendered.title).toMatch(/^Summarise older turns now\. 86% of an assumed 1,048,576 tokens\.$/);
    expect(rendered.disabled).toBe(false);
    expect(rendered.gone).toBe(false);
  });

  it('marks itself busy when clicked, and asks the host to compact', () => {
    const rendered = renderWith({ kind: 'usage', usage: usage(50_000, 100_000) });
    rendered.boot.dispatchElementEvent(rendered.button, 'click');
    expect(rendered.glyph === '⤓').toBe(true);
    expect(String(rendered.boot.elements.get('ctxRingGlyph')?.textContent)).toBe('⋯');
    expect(rendered.button.disabled).toBe(true);
    expect(rendered.boot.postedMessages).toContainEqual({ command: 'compactContext' });
  });

  describe('what the ring fills toward', () => {
    it('fills toward the automatic trigger and gives the actual numbers', () => {
      const rendered = renderWith({ kind: 'usage', usage: usage(60_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'served-model' } });
      expect(rendered.filled).toBe('50 100');
      expect(rendered.ring).toBe('measured');
      expect(rendered.title).toBe('Summarise older turns now. 6% of a measured 1,000,000 tokens. '
        + 'Automatic compaction runs at 120,000 tokens; this conversation is 50% of the way there.');
    });

    it('is drawn full at 100% or more, says compaction is due, and never that it has run', () => {
      const rendered = renderWith({ kind: 'usage', usage: usage(150_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'served-model' } });
      expect(rendered.filled).toBe('100 100');
      expect(rendered.ring).toBe('due');
      expect(rendered.title).toContain('Automatic compaction is due: 150,000 tokens have reached its point of 120,000. The next turn checks it.');
      expect(rendered.title).not.toMatch(/applied|compacted|was summarised/);
    });

    it('fills toward the window when automatic compaction is off, and says so', () => {
      const rendered = renderWith({ kind: 'usage', usage: usage(400_000, 1_000_000), compaction: { mode: 'off' } });
      expect(rendered.filled).toBe('40 100');
      expect(rendered.title).toBe('Summarise older turns now. 40% of a measured 1,000,000 tokens. Automatic compaction is off.');
    });

    it('fills toward the window when the policy cannot be read, and says so', () => {
      const rendered = renderWith({ kind: 'usage', usage: usage(750_000, 1_000_000), compaction: { mode: 'unavailable' } });
      expect(rendered.filled).toBe('75 100');
      expect(rendered.ring).toBe('warn');
      expect(rendered.title).toContain('Automatic compaction is not available for this agent, so the ring shows the window.');
    });

    it('keeps the denominator\'s provenance in the hover text', () => {
      expect(renderWith({ kind: 'usage', usage: usage(40_000, 96_000, 'observed') }).title).toContain('of a provider-refused 96,000 tokens');
      expect(renderWith({ kind: 'usage', usage: usage(40_000, 96_000, 'configured') }).title).toContain('of a configured 96,000 tokens');
    });
  });

  // Codex's audit of 3ca068c0, M1 and M2.
  it('says when the point belongs to the configured model, before a turn has shown which model serves', () => {
    const rendered = renderWith({ kind: 'usage', usage: usage(60_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'configured-model' } });
    expect(rendered.title).toContain('This is the point for the configured model; a turn served by another model can differ.');
    const served = renderWith({ kind: 'usage', usage: usage(60_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'served-model' } });
    expect(served.title).not.toContain('configured model');
  });

  it('does not promise an automatic start after a failure, nor invent why a summary was discarded', () => {
    const due = { kind: 'usage', usage: usage(150_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'served-model' } };
    const failed = renderWith({ ...due, background: 'failed' }).title;
    expect(failed).toContain('The next turn checks it.');
    expect(failed).not.toMatch(/starts with the next turn|will start/);
    expect(failed).toContain('automatic compaction is not retried in this session while the request fits. Click to compact now.');
    const discarded = renderWith({ ...due, background: 'not-applied' }).title;
    expect(discarded).toContain('was not applied: the conversation had changed, or it no longer saved enough.');
  });

  it('keeps each background summary state apart', () => {
    const states = ['preparing', 'ready', 'applied', 'not-applied', 'failed', 'cancelled'] as const;
    const titles = states.map((background) => renderWith({
      kind: 'usage', usage: usage(150_000, 1_000_000), compaction: { mode: 'automatic', triggerTokens: 120_000, basis: 'served-model' }, background,
    }).title);
    expect(new Set(titles).size).toBe(states.length);
    expect(titles[0]).toContain('A summary is being prepared in the background');
    expect(titles[1]).toContain('A summary is ready and is applied at the next turn that needs it.');
    expect(titles[1]).not.toContain('was applied');
    expect(titles[2]).toContain('The last background summary was applied.');
    expect(titles[3]).toContain('was not applied');
    expect(titles[4]).toContain('failed');
    expect(titles[5]).toContain('cancelled');
  });

  // The states that once shipped as an empty pill. Each must say something a user can act on, never a 0% ring.
  describe('a size the host does not have is unknown, never 0%', () => {
    it('says the agent is not running', () => {
      const rendered = renderWith({ kind: 'not-started' });
      expect(rendered.ring).toBe('unknown');
      expect(rendered.disabled).toBe(true);
      expect(rendered.gone).toBe(false);
      expect(rendered.title).toMatch(/not running/);
      expect(rendered.title).not.toMatch(/owns its own context/);
      expect(rendered.glyph).toBe('⤓');
    });

    it('says the runtime owns the context', () => {
      const rendered = renderWith({ kind: 'unsupported' });
      expect(rendered.ring).toBe('unknown');
      expect(rendered.disabled).toBe(true);
      expect(rendered.title).toMatch(/owns its own context window/);
      expect(rendered.title).not.toMatch(/not running/);
    });

    it('says a native runtime has not reported yet, and still lets the user compact it (v0.9.90)', () => {
      const rendered = renderWith({ kind: 'awaiting-report' });
      expect(rendered.ring).toBe('unknown');
      expect(rendered.disabled).toBe(false);
      expect(rendered.title).toMatch(/summarise this conversation now/);
    });

    it('is styled as a dashed ring with no fill', () => {
      const { html } = renderWith({ kind: 'not-started' });
      expect(html).toContain('.ctx-compact[data-ring="unknown"] .ctx-ring-track { stroke-dasharray: 3 3; }');
      expect(html).toContain('.ctx-compact[data-ring="unknown"] .ctx-ring-fill { display: none; }');
    });
  });

  // Field run, 2026-10-02: the Workbench's session bar said "Context not measured yet" while the meter under it
  // said "Context — start the agent". The meter sits in that bar, and the facts beside it name no context.
  it('is the one context reading in the Workbench session bar', () => {
    const rendered = renderWith({ kind: 'not-started' }, 'workbench');
    expect(rendered.text).toBe('Context — start the agent');
    expect(rendered.facts).toBe('senior-dev · OmniCodex · gpt-6-sol');
  });

  it('disappears only when there is no agent to describe', () => {
    expect(renderWith(undefined).gone).toBe(true);
  });
});
