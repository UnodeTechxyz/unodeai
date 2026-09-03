import { beforeEach, describe, expect, it, vi } from 'vitest';

const showInputBox = vi.fn();
const update = vi.fn();
let stored: unknown = {};

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    getConfiguration: () => ({
      get: () => stored,
      update: (...args: unknown[]) => update(...args),
    }),
    workspaceFolders: [],
  },
  window: {
    showInputBox: (...args: unknown[]) => showInputBox(...args),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { parsePriceCoefficient, promptForKeyPriceMultiplier } from './dialogs';

/** The prompt only fires for a connection that owns the secret being stored. */
const deps = { secrets: { has: async () => true, delete: async () => {}, set: async () => {} } } as never;

/** Drive the real box and report what reached settings, plus the validator it installed. */
async function runPrompt(typed: string | undefined) {
  update.mockClear();
  showInputBox.mockReset();
  let validate: ((input: string) => string | undefined) | undefined;
  let options: { value?: string } | undefined;
  showInputBox.mockImplementation(async (opts: { validateInput?: (i: string) => string | undefined }) => {
    options = opts;
    validate = opts.validateInput;
    return typed;
  });
  await promptForKeyPriceMultiplier(deps, 'UNODE_API_KEY');
  const written = update.mock.calls[0]?.[1] as Record<string, number> | undefined;
  return { written, validate: validate!, options: options! };
}

/**
 * A blank box stored "free".
 *
 * `validateInput` and the line that persisted the answer were two copies of the same rule, and both read
 * `Number(input.trim())`. `Number('')` is 0, so a user who cleared the pre-filled `1` and pressed Enter
 * passed validation and stored a coefficient of zero — every model then displayed as costing nothing.
 * Found by Codex review, 2026-08-21, in the round that fixed the double discount; the same shape of defect,
 * cost under-reported in the direction nobody checks.
 *
 * Blank means list price. The prompt opens blank to prevent an Enter bleed-through from the preceding key
 * prompt; `0` remains the explicit way to say the key is free.
 */
describe('price coefficient input', () => {
  beforeEach(() => { stored = {}; });

  it('does not show an error in the intentionally blank initial box', async () => {
    const { validate } = await runPrompt(undefined);
    expect(validate('')).toBeUndefined();
    expect(validate('   ')).toBeUndefined();
    expect(validate('\t')).toBeUndefined();
  });

  it('accepts an explicit 0 and stores it, because a free key is a fact', async () => {
    const { written, validate } = await runPrompt('0');
    expect(validate('0')).toBeUndefined();
    expect(written).toEqual({ unode: 0 });
  });

  it('stores a fraction as typed, with surrounding space tolerated', async () => {
    expect((await runPrompt('0.33')).written).toEqual({ unode: 0.33 });
    expect((await runPrompt(' 0.5 ')).written).toEqual({ unode: 0.5 });
  });

  it('reads a dismissed box as list price, not as unset and not as free', async () => {
    expect((await runPrompt(undefined)).written).toEqual({ unode: 1 });
  });

  it('stores a submitted blank box as list price, not as free', async () => {
    expect((await runPrompt('')).written).toEqual({ unode: 1 });
  });

  it('does not pre-fill 1, so Enter from the preceding key box cannot silently accept list price', async () => {
    expect((await runPrompt(undefined)).options.value).toBeUndefined();
  });

  it('writes a supplied custom connection id without needing its profile to have reloaded yet', async () => {
    update.mockClear();
    showInputBox.mockResolvedValueOnce('0.33');
    const connectionId = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await promptForKeyPriceMultiplier(deps, undefined, connectionId);

    expect(update).toHaveBeenCalledWith(
      'priceMultiplier',
      { [connectionId]: 0.33 },
      1,
    );
  });

  it('refuses what is not a coefficient', async () => {
    const { validate } = await runPrompt(undefined);
    expect(validate('half')).toMatch(/positive number/);
    expect(validate('-1')).toMatch(/positive number/);
    expect(validate('NaN')).toMatch(/positive number/);
    expect(validate('1.5')).toMatch(/above 1/);
  });

  it('keeps the coefficients of other connections when it writes one', async () => {
    stored = { roam: 0.8 };
    expect((await runPrompt('0.33')).written).toEqual({ roam: 0.8, unode: 0.33 });
  });

  it('uses the same blank rule for validation and storage', () => {
    expect(parsePriceCoefficient('')).toEqual({ ok: true, value: 1 });
    expect(parsePriceCoefficient('   ')).toEqual({ ok: true, value: 1 });
    expect(parsePriceCoefficient('0')).toEqual({ ok: true, value: 0 });
    expect(parsePriceCoefficient('1')).toEqual({ ok: true, value: 1 });
  });
});
