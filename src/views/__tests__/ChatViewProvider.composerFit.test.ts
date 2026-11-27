import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: { createWebviewPanel: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

/**
 * v0.9.106 (Owner, 2026-11-18: "fix it now ... I would rather fix both"): a long draft in a short sidebar Chat, and a
 * short Workbench, pushed Send below the visible page. Where the message box is part of the page's column, its cap is
 * now also the room the column leaves it beside the transcript's usable minimum; with less room the transcript gives
 * way. A pending decision is never shrunk: a column still too short scrolls the page. The Workbench's floating-dock
 * reservations no longer stay when the dock is back in the column. The rendered layout at 170-900px wide and
 * 300-900px tall is checked in headless Edge; here the page script's measuring, on a column whose rows have known
 * heights, and the rules.
 */
function chat(container: 'sidebar' | 'workbench' = 'sidebar') {
  const provider = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai' }],
    send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
  } as never);
  (provider as any).rosterLoaded();
  provider.selectAgent('pm');
  return { provider, html: (provider as any).getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u }, container) as string };
}

/** A sidebar column: top bar 28, transcript (min 120, padding 4+4), approvals (margin-bottom 6), composer, Send row 41. */
function column(options: { height: number; approvals?: number; floating?: boolean }) {
  const { provider, html } = chat();
  const booted = bootWebviewScript(html);
  const el = (id: string) => booted.elements.get(id) as any;
  const input = el('input');
  const transcript = el('transcript');
  const approvals = el('approvals');
  const rect = (height: number) => () => ({ height, top: 0, bottom: height });
  const row = (height: number) => ({ getBoundingClientRect: rect(height), contains: () => false });
  const composer = { getBoundingClientRect: () => ({ height: Number.parseFloat(input.style.height) || 46 }), contains: (node: unknown) => node === input };
  transcript.getBoundingClientRect = rect(150);
  approvals.getBoundingClientRect = rect(options.approvals ?? 0);
  input.getBoundingClientRect = () => ({ height: Number.parseFloat(input.style.height) || 46 });
  input.clientWidth = 150;
  const body = booted.body as any;
  body.clientHeight = options.height;
  body.children.push(row(28), transcript, approvals, composer, row(41));
  const styles = new Map<unknown, Record<string, string>>([
    [body, { paddingTop: '8px', paddingBottom: '8px', rowGap: '8px' }],
    [transcript, { minHeight: '120px', paddingTop: '4px', paddingBottom: '4px', borderTopWidth: '0px', borderBottomWidth: '0px' }],
    [approvals, { marginBottom: '6px' }],
    [composer, options.floating ? { position: 'fixed' } : {}],
    [input, { maxHeight: '200px' }],
  ]);
  vi.stubGlobal('getComputedStyle', (element: unknown) => ({ display: 'block', position: 'static', marginTop: '0px', marginBottom: '0px', ...styles.get(element) }));
  booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
  const typed = (scrollHeight: number, value = 'a long draft') => {
    input.value = value;
    input.scrollHeight = scrollHeight;
    booted.dispatchElementEvent(input, 'input');
    return { box: input.style.height, scrolls: input.style.overflowY, transcriptMin: transcript.style.minHeight || '',
      approvalsMax: approvals.style.maxHeight || '', approvalsScroll: approvals.style.overflowY || '' };
  };
  return { typed };
}

describe('v0.9.106 the message box keeps Send in view where it is part of the column', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // Rows other than the transcript and the box: 8+8 padding, 4 gaps of 8, top bar 28, approvals' margin 6, Send row 41.
  it('keeps the 200px cap where the column has room, as before', () => {
    expect(column({ height: 640 }).typed(400)).toMatchObject({ box: '200px', scrolls: 'auto', transcriptMin: '' });
    expect(column({ height: 640 }).typed(150)).toMatchObject({ box: '150px', scrolls: 'hidden', transcriptMin: '' });
  });

  it('a short Chat: the box takes the room left beside the transcript\'s 120px and scrolls inside itself', () => {
    // 385 - 123 - 120 = 142; 300 - 123 - 120 = 57.
    expect(column({ height: 385 }).typed(400)).toMatchObject({ box: '142px', scrolls: 'auto', transcriptMin: '' });
    expect(column({ height: 300 }).typed(400)).toMatchObject({ box: '57px', scrolls: 'auto', transcriptMin: '' });
  });

  it('with less room than the box\'s 46px the transcript gives way, and an empty box shows no scrollbar', () => {
    // 250 - 123 - 120 = 7: the box keeps 46px and the transcript gives the 39px it lacks.
    expect(column({ height: 250 }).typed(400)).toMatchObject({ box: '46px', scrolls: 'auto', transcriptMin: '81px' });
    expect(column({ height: 250 }).typed(49, '')).toMatchObject({ box: '46px', scrolls: 'hidden', transcriptMin: '81px' });
  });

  it('a pending decision: the transcript gives way, down to its padding; the decision itself is never shrunk', () => {
    // 385 - 323 - 120 = -58: the transcript gives 104 of its 112.
    expect(column({ height: 385, approvals: 200 }).typed(400))
      .toMatchObject({ box: '46px', transcriptMin: '16px', approvalsMax: '', approvalsScroll: '' });
    // 300 - 323 - 120 = -143: the transcript gives all 112 and the page scrolls for the other 77; the decision keeps
    // its full height (a permission decision is never squeezed out of view to keep Send in view).
    expect(column({ height: 300, approvals: 200 }).typed(400))
      .toMatchObject({ box: '46px', transcriptMin: '8px', approvalsMax: '', approvalsScroll: '' });
    // Even a decision taller than the whole column keeps its height.
    expect(column({ height: 300, approvals: 600 }).typed(400))
      .toMatchObject({ box: '46px', transcriptMin: '8px', approvalsMax: '', approvalsScroll: '' });
  });

  it('a composer floating over the transcript keeps its own 200px cap and takes nothing from the transcript', () => {
    expect(column({ height: 300, floating: true }).typed(400)).toMatchObject({ box: '200px', scrolls: 'auto', transcriptMin: '' });
  });
});

describe('v0.9.106 a Workbench dock back in the column keeps no floating reservation', () => {
  it('both ways back to the column reset the transcript padding and the decision margin, after the floating rules', () => {
    const { html } = chat('workbench');
    const floatingPadding = html.indexOf('body.container-workbench #transcript { padding-bottom: calc(var(--composer-dock-h, 0px) + 8px); }');
    const floatingMargin = html.indexOf('body.container-workbench #approvals:not([hidden]) {\n      margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);');
    const inlinePadding = html.indexOf('body.container-workbench:where(.approval-dock-inline) #transcript { min-height: 72px; padding-bottom: 4px; }');
    const inlineMargin = html.indexOf('body.container-workbench:where(.approval-dock-inline) #approvals:not([hidden]) { margin-bottom: 0; }');
    const media = html.indexOf('@media (max-height: 560px)');
    const short = html.slice(media, html.indexOf('@media (max-width: 620px)', media));
    expect(short).toContain('body.container-workbench #transcript { min-height: 72px; padding-bottom: 4px; }');
    expect(short).toContain('body.container-workbench #approvals:not([hidden]) { margin-bottom: 0; }');
    // Same specificity: the reset wins because it comes later.
    for (const floating of [floatingPadding, floatingMargin]) {
      expect(floating).toBeGreaterThan(0);
      for (const reset of [inlinePadding, inlineMargin, media]) expect(reset).toBeGreaterThan(floating);
    }
  });

  it('the decision to dock in the column is still measured with the floating reservations', () => {
    const { html } = chat('workbench');
    const measure = html.match(/function minimumApprovalColumnHeight\(\)[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(measure).toContain('cssPixels(item.style.paddingTop) + floatingDockHeight + 8');
    expect(measure).toContain('if (item.element === approvalsEl) marginBottom = floatingDockHeight + 16;');
    expect(html).toMatch(/floatingDockHeight = height;\s*document\.body\.style\.setProperty\('--composer-dock-h'/);
  });
});
