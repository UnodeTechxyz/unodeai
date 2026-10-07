import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/*---------------------------------------------------------------------------------------------
 *  The extension must stay REACHABLE.
 *
 *  A build shipped during 0.9.33 development with the activity-bar icon gone (Owner, 2026-07-30 —
 *  found and fixed live). That is the worst failure this product has: with no icon there is no way
 *  to open the Team panel, the Workbench, or anything else except by remembering a Command Palette
 *  entry. The extension is installed, running, and invisible.
 *
 *  Nothing in the suite would have caught it. `rebrand.smoke` asserts the container ids and that
 *  icon files exist by NAME — a rename guard, not a reachability guard. These are the three ways
 *  the icon actually disappears, and none of them is a syntax error anyone would notice in review.
 *--------------------------------------------------------------------------------------------*/

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const ACTIVITY_BAR_ID = 'unode';

describe('the extension cannot become unreachable', () => {
  it('contributes an activity-bar container with an icon file that exists on disk', () => {
    const container = (manifest.contributes?.viewsContainers?.activitybar ?? [])
      .find((c: { id?: string }) => c.id === ACTIVITY_BAR_ID);

    expect(container, 'no activity-bar container — the extension has no entry point').toBeTruthy();
    expect(container.icon, 'container declares no icon').toBeTruthy();

    // A manifest can name an icon that was moved or deleted; VS Code renders nothing and the entry
    // point is gone without any packaging step complaining.
    const iconPath = path.join(__dirname, '..', '..', container.icon);
    expect(fs.existsSync(iconPath), `manifest points at ${container.icon}, which does not exist`).toBe(true);
    expect(fs.statSync(iconPath).size, 'icon file is empty').toBeGreaterThan(0);
  });

  it('keeps at least one view unconditionally visible, or VS Code hides the whole container', () => {
    // This is the subtle one. VS Code hides an activity-bar container when EVERY view inside it is
    // hidden by its `when` clause — so adding a `when` to the last unconditional view removes the
    // icon, with no error, from a change that looks purely additive. A context key that regresses
    // does the same thing at runtime.
    const views = manifest.contributes?.views?.[ACTIVITY_BAR_ID] ?? [];
    expect(views.length, 'container has no views at all').toBeGreaterThan(0);

    const alwaysVisible = views.filter((v: { when?: string }) => !v.when);
    expect(
      alwaysVisible.length,
      `every view in "${ACTIVITY_BAR_ID}" is gated by a \`when\` clause, so VS Code will hide the container ` +
      'and the extension becomes unreachable. At least one view must have no `when`.',
    ).toBeGreaterThan(0);
  });

  it('does not exclude the icon from the shipped bundle', () => {
    // The icon can also vanish at packaging time: present in the repo, absent from the VSIX. The
    // bundle ignore-list excludes images/_brand/**, and a broader pattern would silently take the
    // activity-bar icon with it.
    const container = (manifest.contributes?.viewsContainers?.activitybar ?? [])
      .find((c: { id?: string }) => c.id === ACTIVITY_BAR_ID);
    const iconRelative: string = container.icon.replace(/\\/g, '/');

    const ignoreFile = path.join(__dirname, '..', '..', '.vscodeignore.bundle');
    const patterns = fs.readFileSync(ignoreFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));

    for (const pattern of patterns) {
      // Only the coarse directory-glob shape can swallow the icon; exact-file entries are deliberate.
      const globbedDir = pattern.match(/^(.*?)\/\*\*$/)?.[1];
      if (globbedDir && iconRelative.startsWith(`${globbedDir}/`)) {
        throw new Error(`.vscodeignore.bundle pattern "${pattern}" would exclude the activity-bar icon ${iconRelative}`);
      }
    }
  });
});