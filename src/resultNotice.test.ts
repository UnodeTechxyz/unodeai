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

import { readResultNoticeStyle, showResultNotice } from './resultNotice';

beforeEach(() => {
  state.defaultValue = 'dialog';
  state.globalValue = undefined;
  state.workspaceValue = undefined;
  state.workspaceFolderValue = undefined;
  state.information.mockClear();
  state.warning.mockClear();
  state.error.mockClear();
});

describe('result notice style', () => {
  it('defaults to a single-OK dialog and keeps detail in the modal detail field', async () => {
    await showResultNotice('warning', 'Summary', 'Longer detail');
    expect(state.warning).toHaveBeenCalledWith('Summary', { modal: true, detail: 'Longer detail' });
  });

  it('reads the user value at each call and folds detail into a quiet notification', async () => {
    await showResultNotice('information', 'First');
    state.globalValue = 'quiet';
    await showResultNotice('information', 'Second', 'Same detail');

    expect(state.information).toHaveBeenNthCalledWith(1, 'First', { modal: true });
    expect(state.information).toHaveBeenNthCalledWith(2, 'Second\n\nSame detail');
  });

  it('ignores workspace values and fails an invalid user value back to dialog', () => {
    const configuration = {
      get: () => 'quiet',
      inspect: () => ({
        defaultValue: 'dialog',
        globalValue: undefined,
        workspaceValue: 'quiet',
        workspaceFolderValue: 'quiet',
      }),
    };
    expect(readResultNoticeStyle(configuration)).toBe('dialog');
    expect(readResultNoticeStyle({
      ...configuration,
      inspect: () => ({ ...configuration.inspect(), globalValue: 'invalid' }),
    })).toBe('dialog');
  });
});
