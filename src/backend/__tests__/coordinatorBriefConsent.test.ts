import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT,
  ALLOW_CROSS_PROVIDER_DISPATCH_SETTING,
  UNRESOLVED_BRIEF_DESTINATION_REASON,
  decideCoordinatorBriefConsent,
} from '../coordinatorBriefConsent';

describe('coordinator brief consent', () => {
  it('asks per dispatch across providers when the user has turned the setting off', () => {
    expect(decideCoordinatorBriefConsent({ sourceKey: 'unode', destinationKey: 'anthropic', allowCrossProviderWithoutApproval: false }))
      .toEqual({ kind: 'ask' });
  });

  it('sends across providers without a dialog when the setting is on, and says that is why', () => {
    expect(decideCoordinatorBriefConsent({ sourceKey: 'unode', destinationKey: 'anthropic', allowCrossProviderWithoutApproval: true }))
      .toEqual({ kind: 'allow', basis: 'user-setting' });
  });

  it('never asks for the same destination, whichever way the setting is set', () => {
    for (const allow of [true, false]) {
      expect(decideCoordinatorBriefConsent({ sourceKey: 'unode', destinationKey: 'unode', allowCrossProviderWithoutApproval: allow }))
        .toEqual({ kind: 'allow', basis: 'same-destination' });
    }
  });

  it('still refuses an unresolvable destination when dispatch without approval is allowed', () => {
    // The setting removes a dialog. It must not remove the resolution check: an unknown destination is not one
    // the user agreed to in advance.
    const cases: Array<[string | undefined, string | undefined]> = [[undefined, 'anthropic'], ['unode', undefined], [undefined, undefined]];
    for (const [sourceKey, destinationKey] of cases) {
      expect(decideCoordinatorBriefConsent({ sourceKey, destinationKey, allowCrossProviderWithoutApproval: true }))
        .toEqual({ kind: 'refuse', reason: UNRESOLVED_BRIEF_DESTINATION_REASON });
    }
  });

  it('declares the setting as the Owner specified: boolean, on by default, user-level only, restricted', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const key = `unode.${ALLOW_CROSS_PROVIDER_DISPATCH_SETTING}`;
    const setting = pkg.contributes.configuration.properties[key];
    expect(setting, 'setting must be declared in package.json').toBeDefined();
    expect(setting.type).toBe('boolean');
    expect(setting.default).toBe(ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT);
    expect(ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT).toBe(true);
    // Application scope: a repository's .vscode/settings.json cannot switch approval back off after the user
    // turned it on. Restricted as well, per the rule noPhoneHome.smoke.test.ts states for approval switches.
    expect(setting.scope).toBe('application');
    expect(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(key);
  });
});
