import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * v0.9.106 (first use, design §3.1, §3.5 and §6): the setup wizard was removed. Its command opens the Workbench (the
 * Owner, 2026-11-18), which with no agent is the first-task screen, and activation opens the Workbench at most once, for
 * a fresh installation, without moving the focus. That both reach the first-task screen in the Workbench is proven
 * through activate() in ActivatedFirstUse.workbench.flows.test.ts; this file keeps the source-level guarantees.
 */
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
const reveal = source.slice(
  source.indexOf('async function settleFirstUsePresentation'),
  source.indexOf('async function recordTeamUse'),
);

describe('first use at activation', () => {
  it('has no setup wizard left to open', () => {
    expect(existsSync(join(__dirname, '..', 'views', 'OnboardingWizard.ts'))).toBe(false);
    expect(source).not.toContain('OnboardingWizard');
    expect(source).not.toContain('onboardingDeps');
    expect(source).not.toContain('completeImmediately');
  });

  it('never runs the old wizard command from activation, and keeps no workspace onboarding flag', () => {
    expect(activation).not.toContain("executeCommand('unode.onboarding')");
    expect(activation).not.toContain('roam.onboardingComplete');
    expect(activation).not.toMatch(/setTimeout\([\s\S]{0,200}unode\.onboarding/);
  });

  it('opens the Workbench from the Get Started command, with the focus', () => {
    expect(onboardingCommand).toContain('openFirstUseWorkbench(false)');
    expect(onboardingCommand).not.toContain("'unode.openChat'");
  });

  it('opens the Workbench only through the decision, once, keeping the focus where it is', () => {
    expect(reveal).toContain('revealDecision(');
    expect(reveal).toContain("context.globalState.update(FIRST_USE_REVEAL_HANDLED_KEY, true)");
    expect(reveal).toContain('openFirstUseWorkbench(true)');
    expect(reveal.indexOf('FIRST_USE_REVEAL_HANDLED_KEY, true')).toBeLessThan(reveal.indexOf('openFirstUseWorkbench(true)'));
    // Nowhere else does activation open the Workbench without the focus, and the sidebar Chat is no longer revealed.
    expect(source.split('openFirstUseWorkbench(true)').length - 1).toBe(1);
    expect(source).not.toContain("'unode.chat.open'");
  });

  it('reads the installation evidence before the first migration writes', () => {
    const read = activation.indexOf('installCohort = readInstallCohort(context)');
    expect(read).toBeGreaterThan(0);
    for (const write of ['migrateRoamSettingsToUnode(context)', 'consentGrants.restore(', 'restoreCodexModelCacheV2(']) {
      expect(read, write).toBeLessThan(activation.indexOf(write));
    }
  });
});
