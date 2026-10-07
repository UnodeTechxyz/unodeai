/*---------------------------------------------------------------------------------------------
 *  Price-coefficient read repair
 *
 *  A key that predates the coefficient prompt may have no stated rate. The repair is intentionally
 *  separated from activation: deciding which connections need a value is product logic, while reading
 *  SecretStorage and writing VS Code configuration are host concerns supplied through this port.
 *--------------------------------------------------------------------------------------------*/

import { priceMultiplierBackfill } from './LivePriceService';

export interface PriceMultiplierReadRepairPort {
  readSetting(): unknown;
  connectionsWithStoredKeys(): Promise<readonly string[]>;
  writeSetting(next: Record<string, number>): Promise<void>;
}

export interface PriceMultiplierReadRepairResult {
  changed: boolean;
  added: readonly string[];
}

/**
 * Repair only coefficients that are genuinely unstated for connections with a stored key.
 *
 * A bare number is deliberately left alone by `priceMultiplierBackfill`: it is a user's explicit
 * "same rate everywhere" statement, not a legacy shape the extension gets to rewrite. The host chooses
 * the user-initiated moment at which this may run; this function contains no VS Code or UI import.
 */
export async function repairPriceMultipliers(
  port: PriceMultiplierReadRepairPort,
): Promise<PriceMultiplierReadRepairResult> {
  const plan = priceMultiplierBackfill(
    await Promise.resolve(port.readSetting()),
    await port.connectionsWithStoredKeys(),
  );
  if (!plan) {
    return { changed: false, added: [] };
  }
  await port.writeSetting(plan.next);
  return { changed: true, added: plan.added };
}
