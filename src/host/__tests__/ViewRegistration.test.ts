import { describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
const serializers = vi.hoisted(() => new Map<string, { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }>());

vi.mock('vscode', () => ({
  TabInputWebview: class {},
  window: {
    registerWebviewViewProvider: (id: string) => { order.push(`view ${id}`); return { dispose() {} }; },
    registerWebviewPanelSerializer: (viewType: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }) => {
      order.push(`serializer ${viewType}`);
      serializers.set(viewType, serializer);
      return { dispose() {} };
    },
    tabGroups: {
      get all() { order.push('recovery reads tabs'); return []; },
      onDidChangeTabs: () => ({ dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
  },
}));

import { registerUnodeSidebarViews } from '../ViewRegistration';

describe('view registration (v0.9.96)', () => {
  it('registers the Workbench serializer before recovery looks at any tab, and hands it VS Code\'s saved state', async () => {
    const restoreWorkbench = vi.fn();
    const chat = {
      restoreWorkbench,
      setWorkbenchRecovery: vi.fn(),
      liveWorkbenchPlacement: () => undefined,
      hasSavedWorkbenchDrafts: () => false,
      openRecoveredWorkbench: vi.fn(),
      openWorkbench: vi.fn(),
      isDisposed: () => false,
      isRosterLoaded: () => true,
    };
    registerUnodeSidebarViews([], { team: {} as never, activity: {} as never, chat: chat as never }, () => false);
    expect(order.indexOf('serializer unode.workbench')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('serializer unode.workbench')).toBeLessThan(order.indexOf('recovery reads tabs'));
    expect(chat.setWorkbenchRecovery).toHaveBeenCalledWith(expect.any(Object));
    const saved = { draftsByAgent: { dev: { text: 'kept', editedAt: 1 } } };
    await serializers.get('unode.workbench')!.deserializeWebviewPanel('panel', saved);
    expect(restoreWorkbench).toHaveBeenCalledWith('panel', saved);
  });
});
