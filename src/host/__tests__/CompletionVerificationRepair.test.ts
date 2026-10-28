import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn(async () => {}) } }));
import * as vscode from 'vscode';
import { openLegacyVerificationUserSettings } from '../CompletionVerificationRepair';

beforeEach(() => { vi.clearAllMocks(); });

describe('M1 User Settings-only repair adapter', () => {
  it('uses the dedicated User settings action, not generic/last-used or workspace settings', async () => {
    await openLegacyVerificationUserSettings();
    expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
      'workbench.action.openGlobalSettings', { query: '@id:unode.verifyCommand' },
    );
  });

  it('does not fall back to generic/workspace settings if the User settings action is unavailable', async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('unsupported command'));
    await expect(openLegacyVerificationUserSettings()).rejects.toThrow('unsupported command');
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
  });
});
