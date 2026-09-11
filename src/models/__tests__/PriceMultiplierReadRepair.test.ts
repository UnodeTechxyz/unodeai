import { describe, expect, it, vi } from 'vitest';
import { repairPriceMultipliers } from '../PriceMultiplierReadRepair';

describe('repairPriceMultipliers', () => {
  it('writes only unstated coefficients for connections that actually have a stored key', async () => {
    const writeSetting = vi.fn(async () => {});
    const result = await repairPriceMultipliers({
      readSetting: () => ({ unode: 0, roam: 0.33 }),
      connectionsWithStoredKeys: async () => ['unode', 'roam', 'openai'],
      writeSetting,
    });

    expect(result).toEqual({ changed: true, added: ['openai'] });
    expect(writeSetting).toHaveBeenCalledWith({ unode: 0, roam: 0.33, openai: 1 });
  });

  it('does not rewrite a deliberate bare-number setting or write an empty repair', async () => {
    const writeSetting = vi.fn(async () => {});
    const result = await repairPriceMultipliers({
      readSetting: () => 1,
      connectionsWithStoredKeys: async () => ['unode', 'roam'],
      writeSetting,
    });

    expect(result).toEqual({ changed: false, added: [] });
    expect(writeSetting).not.toHaveBeenCalled();
  });
});
