import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Found during the v0.9.33 verification trip.
 *
 * The Skip button sits between Back and Next in the wizard's step-navigation row, so it reads as
 * "skip this step" — but its handler shares a case with `finish`: it marks onboarding complete and
 * disposes the panel. Pressing it on the first page ends setup entirely.
 *
 * The behaviour is defensible; the label was not. This pins the wording, because the defect is only
 * visible in the gap between where the control sits and what it does.
 */
const source = readFileSync(join(__dirname, '..', 'OnboardingWizard.ts'), 'utf8');

describe('setup wizard Skip button', () => {
  it('is labelled for what it does — ending setup, not advancing a step', () => {
    expect(source).toMatch(/data-action="skip"[^>]*>Skip setup</);
    expect(source).not.toMatch(/data-action="skip"\s*>Skip</);
  });

  it('carries a tooltip saying the wizard can be reopened', () => {
    const button = /<button data-action="skip"[^>]*>/.exec(source)?.[0] ?? '';
    expect(button).toContain('title=');
    expect(button).toContain('Command Palette');
  });

  it('still exits through the same path as Finish', () => {
    // If these ever diverge, the label above has to be revisited rather than quietly left behind.
    expect(source).toMatch(/case 'finish':\s*case 'skip':/);
  });
});
