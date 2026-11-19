import { beforeEach, describe, expect, it, vi } from 'vitest';

const showInformationMessage = vi.hoisted(() => vi.fn());
const showWarningMessage = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  window: { showInformationMessage, showWarningMessage },
}));

import { confirmDangerousCommand, confirmFolderDelete, promptCommandApproval } from '../CommandApprovalPrompter';
import { SAFE_COMMAND_PREFIXES } from '../CommandPolicy';

describe('single-use destructive command confirmation', () => {
  it.each([undefined, "Don't delete", 'Cancel', 'Delete'])('a folder is deleted only on Delete: %s', async answer => {
    showWarningMessage.mockReset().mockResolvedValue(answer);
    const foreignFiles = Array.from({ length: 12 }, (_, i) => `file-${i}.txt`);
    expect(await confirmFolderDelete({ path: 'drafts', foreignFiles, reason: '', operation: 'delete', before: '', after: '' }, 'folder', open => open())).toBe(answer === 'Delete');
    expect(showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Folder: "drafts"'), { modal: true }, "Don't delete", 'Delete');
    const text = showWarningMessage.mock.calls[0][0]; expect(text).toContain('"file-9.txt"'); expect(text).not.toContain('"file-10.txt"'); expect(text).toContain('and 2 more');
  });
  it('Stop while the folder dialog is open cancels the affirmative answer', async () => {
    const stop = new AbortController(); showWarningMessage.mockImplementationOnce(async () => { stop.abort(); return 'Delete'; });
    expect(await confirmFolderDelete({ path: 'drafts', foreignFiles: ['a'], reason: '', operation: 'delete', before: '', after: '', signal: stop.signal }, 'folder', open => open())).toBe(false);
  });
  it('an unavailable approval window is not consent to delete', async () => {
    showWarningMessage.mockRejectedValueOnce(new Error('window gone'));
    expect(await confirmFolderDelete({ path: 'drafts', foreignFiles: ['a'], reason: '', operation: 'delete', before: '', after: '' }, 'folder', open => open())).toBe(false);
  });
  it.each([undefined, "Don't run", 'Cancel', 'Run it'])('runs only on the affirmative answer: %s', async (answer) => {
    showWarningMessage.mockResolvedValue(answer);
    await expect(confirmDangerousCommand('rm -rf output', 'C:/project', 'test', (open) => open()))
      .resolves.toBe(answer === 'Run it');
    expect(showWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('Command: rm -rf output\nFolder: C:/project'),
      { modal: true }, "Don't run", 'Run it',
    );
  });
});

describe('promptCommandApproval', () => {
  beforeEach(() => showInformationMessage.mockReset());

  it('enables only the supplied project store and never needs a configuration writer', async () => {
    showInformationMessage.mockResolvedValue('Enable Command Execution');
    const projectApprovals = { enableExecution: vi.fn().mockResolvedValue(true) };

    await expect(promptCommandApproval('none', projectApprovals)).resolves.toBe(true);

    // One write holding the reviewed list once per persisted grammar, never an `any` grammar.
    expect(projectApprovals.enableExecution).toHaveBeenCalledTimes(1);
    const keys = projectApprovals.enableExecution.mock.calls[0][0] as Array<{ grammar: string; template: string }>;
    for (const grammar of ['cmd', 'powershell', 'posix']) {
      expect(keys.filter((key) => key.grammar === grammar).map((key) => key.template), grammar).toEqual([...SAFE_COMMAND_PREFIXES]);
    }
    expect(new Set(keys.map((key) => key.grammar))).toEqual(new Set(['cmd', 'powershell', 'posix']));
  });

  it('does nothing when user-level command policy is already enabled', async () => {
    const projectApprovals = { enableExecution: vi.fn() };
    await expect(promptCommandApproval('ask', projectApprovals)).resolves.toBe(false);
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(projectApprovals.enableExecution).not.toHaveBeenCalled();
  });
});
