import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  groups: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
  closeResult: true as boolean,
  calls: [] as string[],
  tabListeners: [] as Array<() => void>,
  groupListeners: [] as Array<() => void>,
  warnings: [] as unknown[][],
  answer: undefined as string | undefined,
}));

vi.mock('vscode', () => {
  class TabInputWebview { constructor(readonly viewType: string) {} }
  class TabInputText { constructor(readonly uri: unknown) {} }
  return {
    TabInputWebview,
    TabInputText,
    window: {
      tabGroups: {
        get all() { return vscodeState.groups; },
        close: vi.fn(async (tab: { label: string }) => {
          vscodeState.calls.push(`close ${tab.label}`);
          return vscodeState.closeResult;
        }),
        onDidChangeTabs: (listener: () => void) => { vscodeState.tabListeners.push(listener); return { dispose() {} }; },
        onDidChangeTabGroups: (listener: () => void) => { vscodeState.groupListeners.push(listener); return { dispose() {} }; },
      },
      showWarningMessage: vi.fn(async (...args: unknown[]) => {
        vscodeState.warnings.push(args);
        return vscodeState.answer;
      }),
    },
    workspace: { getConfiguration: () => ({ inspect: () => undefined, get: () => undefined }) },
  };
});

import * as vscode from 'vscode';
import { askWorkbenchRecovery, registerWorkbenchRecovery, workbenchTabViewType, type RecoverableWorkbench } from '../WorkbenchTabs';
import { WORKBENCH_CONNECT_DEADLINE_MS } from '../WorkbenchRecovery';

const webviewTab = (label: string, viewType: string, isActive = true) => ({ label, isActive, input: new vscode.TabInputWebview(viewType) });

function chat(): RecoverableWorkbench & { recovery: unknown; live?: { viewColumn: number; visible: boolean }; rosterLoaded: boolean } {
  const provider = {
    recovery: undefined as unknown,
    rosterLoaded: true,
    isRosterLoaded: () => provider.rosterLoaded,
    live: undefined as { viewColumn: number; visible: boolean } | undefined,
    liveWorkbenchPlacement: () => provider.live,
    hasSavedWorkbenchDrafts: () => true,
    openRecoveredWorkbench: (viewColumn: number) => {
      vscodeState.calls.push(`open in ${viewColumn}`);
      provider.live = { viewColumn, visible: true };
    },
    openWorkbench: () => { vscodeState.calls.push('open'); },
    isDisposed: () => false,
    setWorkbenchRecovery: (recovery: unknown) => { provider.recovery = recovery; },
  };
  return provider;
}

beforeEach(() => {
  vi.useFakeTimers();
  vscodeState.groups = [];
  vscodeState.closeResult = true;
  vscodeState.calls = [];
  vscodeState.tabListeners = [];
  vscodeState.groupListeners = [];
  vscodeState.warnings = [];
  vscodeState.answer = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Workbench tabs VS Code reports (v0.9.96)', () => {
  it('names the Workbench tab by the prefixed view type VS Code reports, and nothing else', async () => {
    expect(workbenchTabViewType('unode.workbench')).toBe('mainThreadWebview-unode.workbench');
    vscodeState.groups = [
      { viewColumn: 1, tabs: [webviewTab('foreign', 'mainThreadWebview-other.workbench')] },
      { viewColumn: 2, tabs: [webviewTab('look-alike', 'mainThreadWebview-unode.workbenchX')] },
      { viewColumn: 3, tabs: [webviewTab('unprefixed', 'unode.workbench')] },
      { viewColumn: 4, tabs: [{ label: 'UnodeAi Workbench', isActive: true, input: new vscode.TabInputText('file') }] },
      { viewColumn: 5, tabs: [webviewTab('ours', 'mainThreadWebview-unode.workbench')] },
    ];
    vscodeState.answer = 'Reopen Workbench';
    const subscriptions: Array<{ dispose(): void }> = [];
    registerWorkbenchRecovery(subscriptions as never, chat(), 'unode.workbench', () => false);
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(vscodeState.calls).toEqual(['open in 5', 'close ours']);
  });

  it('opens the new Workbench before closing the old tab, so it takes the old tab\'s place', async () => {
    vscodeState.groups = [{ viewColumn: 2, tabs: [webviewTab('old', 'mainThreadWebview-unode.workbench')] }];
    vscodeState.answer = 'Reopen Workbench';
    registerWorkbenchRecovery([] as never, chat(), 'unode.workbench', () => false);
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS);
    expect(vscodeState.calls).toEqual(['open in 2', 'close old']);
  });

  it('says so, as a result notice, when the old tab could not be closed', async () => {
    vscodeState.groups = [{ viewColumn: 1, tabs: [webviewTab('old', 'mainThreadWebview-unode.workbench')] }];
    vscodeState.answer = 'Reopen Workbench';
    vscodeState.closeResult = false;
    registerWorkbenchRecovery([] as never, chat(), 'unode.workbench', () => false);
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS);
    // v0.9.99: result notices are quiet by default, so any detail follows the summary in the one message.
    expect(String(vscodeState.warnings.at(-1)?.[0])).toMatch(/^UnodeAi reopened the Workbench but could not close the old tab\./);
  });

  it('judges no tab before the roster is loaded, and starts the deadline once it is', async () => {
    vscodeState.groups = [{ viewColumn: 1, tabs: [webviewTab('old', 'mainThreadWebview-unode.workbench')] }];
    vscodeState.answer = 'Reopen Workbench';
    const provider = chat();
    provider.rosterLoaded = false;
    const recovery = registerWorkbenchRecovery([] as never, provider, 'unode.workbench', () => false);
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(vscodeState.warnings).toHaveLength(0);
    provider.rosterLoaded = true;
    recovery.changed();
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS - 1);
    expect(vscodeState.warnings).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(vscodeState.calls).toEqual(['open in 1', 'close old']);
  });

  it('closes nothing when the user keeps the old tab', async () => {
    vscodeState.groups = [{ viewColumn: 1, tabs: [webviewTab('old', 'mainThreadWebview-unode.workbench')] }];
    vscodeState.answer = 'Keep Old Tab';
    registerWorkbenchRecovery([] as never, chat(), 'unode.workbench', () => false);
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(vscodeState.calls).toEqual([]);
  });

  it('re-evaluates on tab changes and stops for good once disposed', async () => {
    const provider = chat();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerWorkbenchRecovery(subscriptions as never, provider, 'unode.workbench', () => false);
    expect(vscodeState.tabListeners).toHaveLength(1);
    expect(vscodeState.groupListeners).toHaveLength(1);
    expect(provider.recovery).toBeDefined();
    subscriptions.forEach((subscription) => subscription.dispose());
    expect(provider.recovery).toBeUndefined();
    vscodeState.groups = [{ viewColumn: 1, tabs: [webviewTab('old', 'mainThreadWebview-unode.workbench')] }];
    vscodeState.tabListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(WORKBENCH_CONNECT_DEADLINE_MS * 3);
    expect(vscodeState.warnings).toHaveLength(0);
  });

  it('asks a modal question, safe answer first, only when the user asked for the Workbench', async () => {
    vscodeState.answer = 'Reopen Workbench';
    expect(await askWorkbenchRecovery({ kind: 'reopen', userInitiated: true, savedDrafts: true })).toBe('reopen');
    const [message, options, ...actions] = vscodeState.warnings.at(-1)!;
    expect(message).toBe('The UnodeAi Workbench lost its connection when the extension host restarted.');
    expect(options).toMatchObject({ modal: true });
    expect(String((options as { detail: string }).detail)).toContain('Text typed after the restart may be missing');
    expect(actions).toEqual(['Not now', 'Reopen Workbench']);

    vscodeState.answer = 'Not now';
    expect(await askWorkbenchRecovery({ kind: 'reopen', userInitiated: true, savedDrafts: false })).toBeUndefined();
    expect(String((vscodeState.warnings.at(-1)![1] as { detail: string }).detail)).toContain('no saved copy');

    vscodeState.answer = 'Reopen Workbench';
    expect(await askWorkbenchRecovery({ kind: 'reopen', userInitiated: false, savedDrafts: true })).toBe('reopen');
    const automatic = vscodeState.warnings.at(-1)!;
    expect(typeof automatic[1]).toBe('string');
    expect(automatic.slice(1)).toEqual(['Reopen Workbench', 'Keep Old Tab']);

    vscodeState.answer = 'Close Old Tab';
    expect(await askWorkbenchRecovery({ kind: 'close-extra' })).toBe('close');
    vscodeState.answer = 'Keep Old Tab';
    expect(await askWorkbenchRecovery({ kind: 'close-extra' })).toBeUndefined();
    expect(await askWorkbenchRecovery({ kind: 'ambiguous' })).toBeUndefined();
  });
});
