import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const extensionSource = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');

function commandRegistration(command: string, nextCommand: string): string {
  const start = extensionSource.indexOf(`reg('${command}'`);
  const end = extensionSource.indexOf(`reg('${nextCommand}'`, start);
  if (start < 0 || end < 0) {
    throw new Error(`could not locate the ${command} registration`);
  }
  return extensionSource.slice(start, end);
}

describe('user actions do not depend on price-coefficient repair', () => {
  it('opens the product panel before the fallible User Settings read repair', () => {
    const source = commandRegistration('unode.openSettings', 'unode.openAccount');
    const openPanelAt = source.indexOf('SettingsPanel.createOrShow(');
    const repairAt = source.indexOf("startPriceMultiplierReadRepairAfterUserAction('Settings'");

    expect(openPanelAt).toBeGreaterThanOrEqual(0);
    expect(repairAt).toBeGreaterThan(openPanelAt);
    expect(source).not.toContain("await startPriceMultiplierReadRepairAfterUserAction('Settings'");
    expect(source).toContain('SettingsPanel.refreshCurrent()');
  });

  it('finishes Refresh Model Prices before starting the fallible repair', () => {
    const source = commandRegistration('unode.refreshPrices', 'unode.showSecurity');
    const refreshAt = source.indexOf("await refreshPrices({ interactive: true, trigger: 'explicit command' })");
    const resultAt = source.indexOf("showResultNotice('information'");
    const repairAt = source.indexOf("startPriceMultiplierReadRepairAfterUserAction('Refresh model prices')");

    expect(refreshAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(refreshAt);
    expect(repairAt).toBeGreaterThan(resultAt);
    expect(source).not.toContain("await startPriceMultiplierReadRepairAfterUserAction('Refresh model prices')");
  });

  it('contains repair failures and offers the shared User Settings recovery path', () => {
    const start = extensionSource.indexOf('function startPriceMultiplierReadRepairAfterUserAction(');
    const end = extensionSource.indexOf('\nasync function refreshPrices(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const source = extensionSource.slice(start, end);
    expect(source).toContain('void repairPriceMultipliersAfterUserAction(reason).then(');
    expect(source).toContain('Open User Settings (JSON)');
    expect(source).toContain('workbench.action.openSettingsJson');
  });
});
