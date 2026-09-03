import { describe, expect, it, vi } from 'vitest';

const showQuickPick = vi.fn().mockResolvedValue(undefined);
const showInputBox = vi.fn().mockResolvedValue(undefined);
const showInformationMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: { getConfiguration: () => ({ get: () => '', update: vi.fn() }), workspaceFolders: [] },
  window: {
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
    showInputBox: (...args: unknown[]) => showInputBox(...args),
    showInformationMessage: (...args: unknown[]) => showInformationMessage(...args),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { showSetApiKeyDialog } from './dialogs';

function depsWithStoredKey(stored: Set<string>) {
  return {
    secrets: {
      has: async (name: string) => stored.has(name),
      delete: async (name: string) => { stored.delete(name); },
      set: async () => {},
    },
  } as never;
}

/**
 * Found during the v0.9.33 verification trip: W7 made connection order consistent across the setup
 * wizard, Agent Builder and Settings, and `stableProviderSort`'s own comment claims it is "shared by
 * every connection picker" — but this dialog never used it, so the one screen that decides which
 * account you are about to pay for listed them in registry order instead.
 */
describe('Set Provider API Key — picker order', () => {
  it('lists Unode first and Roam second, like every other connection picker', async () => {
    showQuickPick.mockClear();
    await showSetApiKeyDialog({} as never);

    const labels = (showQuickPick.mock.calls[0][0] as Array<{ label: string }>).map((item) => item.label);
    const unode = labels.indexOf('UNODE_API_KEY');
    const roam = labels.indexOf('ROAM_API_KEY');

    expect(unode).toBeGreaterThanOrEqual(0);
    expect(roam).toBeGreaterThanOrEqual(0);
    expect(unode).toBeLessThan(roam);
  });

  it('still offers the custom secret escape hatch last', async () => {
    showQuickPick.mockClear();
    await showSetApiKeyDialog({} as never);

    const items = showQuickPick.mock.calls[0][0] as Array<{ label: string; custom?: boolean }>;
    expect(items[items.length - 1].custom).toBe(true);
  });
});

describe('custom secret confirmation', () => {
  it('does not claim that an arbitrary secret refreshed provider prices or models', async () => {
    const storeUserInitiatedProviderKey = vi.fn().mockResolvedValue(undefined);
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValueOnce({ label: 'Custom secret name', custom: true });
    showInputBox.mockReset();
    showInputBox.mockResolvedValueOnce('GITHUB_TOKEN').mockResolvedValueOnce('ghp_example');
    showInformationMessage.mockClear();

    await showSetApiKeyDialog({
      secrets: { has: async () => false, delete: async () => {} },
      storeUserInitiatedProviderKey,
    } as never);

    expect(storeUserInitiatedProviderKey).toHaveBeenCalledWith('GITHUB_TOKEN', 'ghp_example', undefined);
    expect(showInformationMessage).toHaveBeenCalledWith('Stored GITHUB_TOKEN in SecretStorage.');
  });
});

describe('Set Provider API Key — clearing a stored key', () => {
  it('offers to clear, and clearing removes it without a workspace reset', async () => {
    // Found on the v0.9.33 verification trip: a built-in provider's key could only be removed by the
    // reset that also deletes the team file and reloads the window, so "take my key off this machine"
    // cost the user their roster. The value box refuses an empty string, by design.
    const stored = new Set(['UNODE_API_KEY']);
    showQuickPick
      .mockResolvedValueOnce({ label: 'UNODE_API_KEY', secretName: 'UNODE_API_KEY' })
      .mockResolvedValueOnce('Clear the stored value');

    await showSetApiKeyDialog(depsWithStoredKey(stored));

    expect(stored.has('UNODE_API_KEY')).toBe(false);
  });

  it('does not ask when there is nothing stored — the common path stays one step', async () => {
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValueOnce({ label: 'UNODE_API_KEY', secretName: 'UNODE_API_KEY' });

    await showSetApiKeyDialog(depsWithStoredKey(new Set()));

    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });
});
