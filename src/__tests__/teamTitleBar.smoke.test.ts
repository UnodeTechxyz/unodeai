import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A view title bar is a fixed-width row: VS Code shows what fits and pushes the rest into an
 * unlabelled "..." overflow. Pinning many icons therefore does not make them available on a narrow
 * sidebar — it makes them invisible. The Team panel pins a small set and routes everything else
 * through unode.teamActions, which lists its entries by name.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const teamTitleItems = (pkg.contributes.menus['view/title'] as Array<{ command: string; when: string }>)
  .filter((item) => item.when.includes('unode.teamPanel'));

describe('Team title bar', () => {
  it('pins few enough icons to survive a narrow sidebar', () => {
    // startSolo/startSoloActive and collapseTeam/expandTeam are mutually exclusive pairs — one of each shows.
    const concurrentlyVisible = new Set(teamTitleItems.map((item) =>
      item.command.replace(/^unode\.(startSolo|startSoloActive)$/, 'solo')
        .replace(/^unode\.(collapseTeam|expandTeam)$/, 'compact')));
    // Still seven. Open Workbench took Marketplace's pin rather than becoming an eighth icon, because the
    // eighth is the one the host hides (Owner, 2026-08-21 — the Team panel's own New Task button was
    // removed to save a row, so this control had to be reachable without one).
    expect([...concurrentlyVisible].sort()).toEqual([
      'compact', 'solo', 'unode.addAgent', 'unode.openSettings', 'unode.openWorkbench',
      'unode.sendMessage', 'unode.teamActions',
    ]);
  });

  it('declares the overflow menu command with an icon', () => {
    const command = (pkg.contributes.commands as Array<{ command: string; title: string; icon?: string }>)
      .find((entry) => entry.command === 'unode.teamActions');
    expect(command?.icon).toBe('$(ellipsis)');
    expect(command?.title).toContain('Team Actions');
  });

  it('pins the overflow menu ahead of the icons that may be pushed into the host overflow', () => {
    // VS Code fills the row in group order and pushes the tail into an unnamed "...". The menu that makes
    // everything else reachable must therefore sit near the front, and the last pinned icon must also be
    // listed inside it.
    const order = (command: string) => Number(
      teamTitleItems.find((item) => item.command === command)!.group.replace('navigation@', ''),
    );
    expect(order('unode.teamActions')).toBeLessThan(order('unode.sendMessage'));
    expect(order('unode.teamActions')).toBeLessThan(order('unode.collapseTeam'));

    const source = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
    const menu = source.slice(source.indexOf("reg('unode.teamActions'"), source.indexOf("reg('unode.sendMessage'"));
    expect(menu).toContain('unode.collapseTeam');
    expect(menu).toContain('unode.expandTeam');
  });

  it('keeps every unpinned Team destination reachable from the menu', () => {
    const source = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
    const menu = source.slice(source.indexOf("reg('unode.teamActions'"), source.indexOf("reg('unode.sendMessage'"));
    for (const target of [
      'unode.openAgentBuilder',
      'unode.createTeamPreset',
      'unode.startAllAgents',
      'unode.stopAllAgents',
      'unode.editTeamRules',
      'unode.restoreCheckpoint',
      'unode.toggleConcurrencyMode',
      'unode.openAccount',
      'unode.showSecurity',
      'unode.generateEvidenceReport',
    ]) {
      expect(menu, `${target} is neither pinned nor in the Team Actions menu`).toContain(target);
    }
  });

  it('does not repeat a pinned icon inside the menu', () => {
    // Everything except Collapse/Expand, which is pinned LAST and so is the first icon the host
    // pushes into its overflow — that one is listed in both places on purpose.
    const source = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
    const menu = source.slice(source.indexOf("reg('unode.teamActions'"), source.indexOf("reg('unode.sendMessage'"));
    for (const pinned of ['unode.addAgent', 'unode.openSettings', 'unode.openWorkbench', 'unode.sendMessage']) {
      expect(menu, `${pinned} is pinned and should not also be a menu entry`).not.toContain(pinned);
    }
  });
});
