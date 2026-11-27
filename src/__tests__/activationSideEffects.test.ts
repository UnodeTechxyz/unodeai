/* The activation body is a source-level guard for the two actions A1 removes from startup. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function activationBody(): string {
  const source = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf('export async function activate(');
  const relativeEnd = source.slice(start).search(/\nexport\s+(?:async\s+)?function deactivate\s*\(/);
  const end = relativeEnd < 0 ? -1 : start + relativeEnd;
  if (start < 0 || end < 0) {
    throw new Error('could not locate activate() body');
  }
  return source.slice(start, end);
}

describe('A1 activation side-effect boundary', () => {
  it('does not repair global settings, fetch metadata, or wire commands/views directly', () => {
    const source = activationBody();
    expect(source).not.toContain('repairPriceMultipliersAfterUserAction(');
    expect(source).not.toContain('backfillPriceMultipliers(');
    // Daily maintenance is scheduled from activation, but the old code also immediately chained a refresh
    // after the unattended write. Only that immediate warm-up is forbidden here.
    expect(source).not.toContain('backfillPriceMultipliers().then(() => refreshPrices())');
    expect(source).not.toContain('ConfigurationTarget.Global');
    expect(source).not.toContain('globalThis as any).fetch');
    expect(source).not.toContain('vscode.commands.registerCommand');
    expect(source).not.toContain('vscode.window.registerWebviewViewProvider');
  });
});
