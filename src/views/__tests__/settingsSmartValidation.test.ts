import { describe, expect, it } from 'vitest';
import { parseModelTierCellPatch } from '../settingsSmartValidation';

describe('settings Smart Mode validation', () => {
  it('rejects model tier edits for unknown providers', () => {
    const patch = parseModelTierCellPatch(
      { kind: 'modelTierCell', tier: 'standard', provider: 'evil-provider', value: 'bad-model' },
      new Set(['roam'])
    );

    expect(patch).toBeUndefined();
  });

  it('accepts model tier edits for known providers', () => {
    const patch = parseModelTierCellPatch(
      { kind: 'modelTierCell', tier: 'standard', provider: 'roam', value: ' deepseek-v4-pro ' },
      new Set(['roam'])
    );

    expect(patch).toEqual({
      kind: 'modelTierCell',
      tier: 'standard',
      provider: 'roam',
      value: 'deepseek-v4-pro',
    });
  });
});
