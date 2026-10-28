/*---------------------------------------------------------------------------------------------
 * v0.9.96: Refresh models from Codex. The flow is the policy; the port is the editor.
 *
 * The selection is captured before its first check: the setting, the program and the identity of its file. It is
 * confirmed again before network consent is asked, before App Server starts and before the list is saved. If it
 * changed, or the window began closing, or the workspace changed, nothing more starts and nothing is saved: a stale
 * refresh never starts App Server for the program that is no longer selected, and never substitutes the new one.
 * The loader awaits its own folder preparation, so the last check is the one it makes right before it spawns.
 *--------------------------------------------------------------------------------------------*/

import type { CodexAccountModel } from '../backend/CodexModelLoader';

export interface CodexModelSelection {
  /** The raw `unode.codexCliPath` value the selection was made under. */
  setting: string;
  /** The program that was checked, and that App Server would be started from. */
  program: string;
  version: string;
  /** The identity of the program file when it was checked (see `cliProgramStamp`). */
  stamp: string;
}

export interface CodexModelRefreshPort<M> {
  /**
   * The configured program, checked now, or one the user chooses and checks. It captures the selection before its
   * first asynchronous step. Undefined: cancelled, and nothing was started.
   */
  select(): Promise<CodexModelSelection | undefined>;
  /** The same setting and program file, the window not closing and the workspace unchanged. */
  stillSelected(selection: CodexModelSelection): boolean;
  /** Codex's network consent for exactly this program. Throws when declined. */
  consent(program: string): Promise<void>;
  /**
   * Starts App Server from this program for the model list only. `assertCurrent` must be called synchronously right
   * before the process is spawned; it throws a CodexSelectionChangedError when the selection is no longer current.
   */
  discover(program: string, assertCurrent: () => void): Promise<CodexAccountModel[]>;
  remember(models: readonly CodexAccountModel[], selection: CodexModelSelection): Promise<void>;
  /** The models the Agent Builder lists now. */
  list(): Promise<M[]>;
}

export const CODEX_REFRESH_MESSAGES = {
  cancelled: 'Codex executable selection was cancelled. No App Server or model request started, and nothing was saved.',
  changedBefore: 'The Codex CLI selection changed, or the window began closing, before App Server started. Nothing was started or saved. Refresh again.',
  changedDuring: 'The Codex CLI selection changed while models were loading, so this list was not saved. Refresh again.',
} as const;

/** The selection changed before App Server was spawned; nothing was started. */
export class CodexSelectionChangedError extends Error {
  constructor() {
    super(CODEX_REFRESH_MESSAGES.changedBefore);
    this.name = 'CodexSelectionChangedError';
  }
}

export async function refreshCodexModels<M>(port: CodexModelRefreshPort<M>): Promise<{ models: M[]; message: string }> {
  const selection = await port.select();
  if (!selection) return { models: await port.list(), message: CODEX_REFRESH_MESSAGES.cancelled };
  // The version and login checks awaited inside select(): the selection may already be another one.
  if (!port.stillSelected(selection)) return { models: await port.list(), message: CODEX_REFRESH_MESSAGES.changedBefore };
  await port.consent(selection.program);
  if (!port.stillSelected(selection)) return { models: await port.list(), message: CODEX_REFRESH_MESSAGES.changedBefore };
  const assertCurrent = (): void => {
    if (!port.stillSelected(selection)) throw new CodexSelectionChangedError();
  };
  let models: CodexAccountModel[];
  try {
    models = await port.discover(selection.program, assertCurrent);
  } catch (error) {
    if (error instanceof CodexSelectionChangedError) return { models: await port.list(), message: CODEX_REFRESH_MESSAGES.changedBefore };
    throw error;
  }
  if (!port.stillSelected(selection)) return { models: await port.list(), message: CODEX_REFRESH_MESSAGES.changedDuring };
  if (models.length === 0) {
    return {
      models: await port.list(),
      message: `Codex ${selection.version} returned no account models. Nothing was saved; the earlier list and your model text are unchanged.`,
    };
  }
  await port.remember(models, selection);
  // The count is what Codex returned; the list also holds the bundled default.
  return {
    models: await port.list(),
    message: `${models.length} model${models.length === 1 ? '' : 's'} loaded from Codex ${selection.version}.`,
  };
}
