import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  defaultValue: 'dialog' as unknown,
  globalValue: undefined as unknown,
  workspaceValue: undefined as unknown,
  workspaceFolderValue: undefined as unknown,
  information: vi.fn().mockResolvedValue(undefined),
  warning: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      inspect: () => ({
        defaultValue: state.defaultValue,
        globalValue: state.globalValue,
        workspaceValue: state.workspaceValue,
        workspaceFolderValue: state.workspaceFolderValue,
      }),
    }),
  },
  window: {
    showInformationMessage: (...args: unknown[]) => state.information(...args),
    showWarningMessage: (...args: unknown[]) => state.warning(...args),
    showErrorMessage: (...args: unknown[]) => state.error(...args),
  },
}));

import { readFileSync } from 'node:fs';
import { readResultNoticeStyle, showResultNotice } from './resultNotice';

/** The shipped default, read from the real manifest the way VS Code supplies it as `defaultValue`. */
const manifestDefault = JSON.parse(readFileSync('package.json', 'utf8'))
  .contributes.configuration.properties['unode.notifications.resultStyle'].default as unknown;

beforeEach(() => {
  state.defaultValue = manifestDefault;
  state.globalValue = undefined;
  state.workspaceValue = undefined;
  state.workspaceFolderValue = undefined;
  state.information.mockReset().mockResolvedValue(undefined);
  state.warning.mockReset().mockResolvedValue(undefined);
  state.error.mockReset().mockResolvedValue(undefined);
});

describe('result notice style', () => {
  it('v0.9.99: an absent setting adopts the quiet default, which never waits for the notice to be closed', async () => {
    expect(manifestDefault).toBe('quiet');
    // VS Code keeps an itemless notification's promise open until it is dismissed; the work must not wait on it.
    state.warning.mockReturnValue(new Promise(() => {}));
    await expect(showResultNotice('warning', 'Summary', 'Longer detail')).resolves.toBeUndefined();
    expect(state.warning).toHaveBeenCalledWith('Summary\n\nLonger detail');
  });

  it('keeps an explicit Dialog from User Settings as a single-OK modal with the detail field', async () => {
    state.globalValue = 'dialog';
    await showResultNotice('warning', 'Summary', 'Longer detail');
    expect(state.warning).toHaveBeenCalledWith('Summary', { modal: true, detail: 'Longer detail' });
  });

  it('reads the user value at each call', async () => {
    state.globalValue = 'dialog';
    await showResultNotice('information', 'First');
    state.globalValue = undefined;
    await showResultNotice('information', 'Second', 'Same detail');

    expect(state.information).toHaveBeenNthCalledWith(1, 'First', { modal: true });
    expect(state.information).toHaveBeenNthCalledWith(2, 'Second\n\nSame detail');
  });

  it('ignores workspace values and fails an invalid user value back to dialog', () => {
    const configuration = {
      get: () => 'dialog',
      inspect: () => ({
        defaultValue: manifestDefault,
        globalValue: undefined,
        workspaceValue: 'dialog',
        workspaceFolderValue: 'dialog',
      }),
    };
    expect(readResultNoticeStyle(configuration)).toBe('quiet');
    expect(readResultNoticeStyle({
      ...configuration,
      inspect: () => ({ ...configuration.inspect(), globalValue: 'invalid' }),
    })).toBe('dialog');
  });

  it('a notice that fails to show never rejects into the work that reported it', async () => {
    state.error.mockImplementation(() => { throw new Error('no notification service'); });
    await expect(showResultNotice('error', 'Quiet failure')).resolves.toBeUndefined();
    state.globalValue = 'dialog';
    state.error.mockReset().mockRejectedValue(new Error('dialog closed by host'));
    await expect(showResultNotice('error', 'Dialog failure')).resolves.toBeUndefined();
  });
});
