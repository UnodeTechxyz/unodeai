import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
const deactivateStart = source.search(/export\s+(?:async\s+)?function deactivate\s*\(/);
const activation = source.slice(
  source.indexOf('export async function activate'),
  deactivateStart,
);
const onboardingCommand = source.slice(
  source.indexOf("reg('unode.onboarding'"),
  source.indexOf("reg('unode.runDemoTask'"),
);

describe('setup wizard activation', () => {
  it('never auto-opens on a fresh install', () => {
    expect(activation).not.toContain("executeCommand('unode.onboarding')");
    expect(activation).not.toContain('OnboardingWizard.createOrShow');
  });

  it('stays dismissed across workspaces because activation has no workspace-state onboarding branch', () => {
    // A workspace-local completion flag cannot make setup global. There is no automatic path at all:
    // every workspace activation leaves the editor alone until the user invokes the wizard.
    expect(activation).not.toContain('roam.onboardingComplete');
    expect(activation).not.toMatch(/setTimeout\([\s\S]{0,200}unode\.onboarding/);
  });

  it('keeps opening the wizard as an explicit command', () => {
    expect(onboardingCommand).toContain('OnboardingWizard.createOrShow');
  });
});
