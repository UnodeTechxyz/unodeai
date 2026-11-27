import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const panels: any[] = [];
  return {
    ViewColumn: { One: 1, Active: -1 },
    panels,
    window: {
      createWebviewPanel: vi.fn(() => {
        const webview: any = {
          cspSource: 'test:',
          html: '',
          postMessage: vi.fn(),
          onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
            webview.messageHandler = handler;
            return { dispose: vi.fn() };
          }),
        };
        const panel: any = {
          webview,
          dispose: vi.fn(),
          reveal: vi.fn(),
          onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        };
        panels.push(panel);
        return panel;
      }),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
  };
});
vi.mock('vscode', () => vscodeMock);

import {
  CompactionProfileTablePanel,
  parseProfileTableOverrides,
  renderCompactionProfileTableHtml,
  type CompactionProfileTableViewModel,
} from '../CompactionProfileTablePanel';
import { bootWebviewScript } from './support/webviewBoot';

const webview = { cspSource: 'test:' } as any;

function table(fields: Partial<CompactionProfileTableViewModel> = {}): CompactionProfileTableViewModel {
  return {
    teamFileExists: true,
    rows: [
      {
        id: 'balanced', label: 'Balanced', typicalWork: 'Mixed work',
        defaults: { windowPercent: 70, ceilingTokens: 250_000, recentTailTokens: 48_000, postCompactTargetTokens: 80_000 },
        overrides: { ceilingTokens: 180_000 },
        agents: ['Project Manager'],
      },
      {
        id: 'deep-build', label: 'Deep build', typicalWork: 'Architecture',
        defaults: { windowPercent: 75, ceilingTokens: 350_000, recentTailTokens: 80_000, postCompactTargetTokens: 150_000 },
        overrides: {},
        agents: [],
      },
    ],
    ...fields,
  };
}

describe('team work-profile table editor', () => {
  it('shows each bundled default beside its override and who uses the row', () => {
    const html = renderCompactionProfileTableHtml(webview, table());
    expect(html).toMatch(/data-row="balanced" data-field="ceilingTokens"[^>]*value="180000"/);
    expect(html).toMatch(/data-row="balanced" data-field="windowPercent"[^>]*value=""/);
    expect(html).toContain('Default 250,000');
    expect(html).toContain('Default 75%');
    expect(html).toContain('Used by: Project Manager');
    expect(html).toContain('No Smart agent uses this row yet');
    expect(html).toContain('Host-history routes only');
    expect(html).toContain('This schedules compaction; it does not block tasks.');
    // v0.9.90 audit L1: the team file is read when the window opens.
    expect(html).toContain('applies after <strong>Developer: Reload Window</strong>');
    expect(html).not.toContain('saving creates one');
    expect(() => bootWebviewScript(html)).not.toThrow();
  });

  it('says the first save creates the team file when there is none', () => {
    expect(renderCompactionProfileTableHtml(webview, table({ teamFileExists: false }))).toContain('saving creates one from the current roster');
  });

  it('shows why the table is unavailable instead of a table of guesses', () => {
    const html = renderCompactionProfileTableHtml(webview, { teamFileExists: true, unavailableReason: 'profiles must be an object' });
    expect(html).toContain('The Smart profile table is unavailable: profiles must be an object.');
    expect(html).not.toContain('<table>');
  });

  it('reads numbers per known profile and field, and nothing else', () => {
    expect(parseProfileTableOverrides({ balanced: { ceilingTokens: '180000', windowPercent: 65 } }))
      .toEqual({ balanced: { ceilingTokens: 180_000, windowPercent: 65 } });
    expect(parseProfileTableOverrides({})).toEqual({});
    expect(parseProfileTableOverrides({ fast: { windowPercent: 50 } })).toBeUndefined();
    expect(parseProfileTableOverrides({ balanced: { color: 1 } })).toBeUndefined();
    expect(parseProfileTableOverrides({ balanced: { windowPercent: 'many' } })).toBeUndefined();
  });

  it('closes after a save the host accepts and shows the host\'s reason when it refuses', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'Nothing was saved. Balanced: window share must be a whole percent from 10 to 90.' })
      .mockResolvedValueOnce({ ok: true, message: 'Saved.' });
    CompactionProfileTablePanel.current = undefined;
    CompactionProfileTablePanel.createOrShow({ getViewModel: () => table(), save });
    const panel = vscodeMock.panels[vscodeMock.panels.length - 1];
    await panel.webview.messageHandler({ command: 'save', overrides: { balanced: { windowPercent: '5' } } });
    expect(save).toHaveBeenLastCalledWith({ balanced: { windowPercent: 5 } });
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ command: 'problem', message: expect.stringContaining('Nothing was saved') });
    expect(panel.dispose).not.toHaveBeenCalled();
    await panel.webview.messageHandler({ command: 'save', overrides: {} });
    expect(panel.dispose).toHaveBeenCalledOnce();
  });
});
