import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A view title bar is a fixed-width row: VS Code shows what fits and pushes the rest into an
 * unlabelled "..." overflow. Pinning many icons therefore does not make them available on a narrow
 * sidebar — it makes them invisible. v0.9.106 (design §8.3): the Team panel pins at most four icons —
 * New Task/Workbench, Add Agent, Team Actions and Settings — and routes everything else through
 * unode.teamActions, which lists its entries by name.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const teamTitleItems = (pkg.contributes.menus['view/title'] as Array<{ command: string; when: string; group?: string }>)
  .filter((item) => item.when.includes('unode.teamPanel'));

const teamActionsMenu = (() => {
  const source = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
  return source.slice(source.indexOf("reg('unode.teamActions'"), source.indexOf("reg('unode.sendMessage'"));
})();

describe('Team title bar', () => {
  it('pins exactly the four icons of the design, in order', () => {
    expect(teamTitleItems.every((item) => item.group?.startsWith('navigation@'))).toBe(true);
    const order = (item: { group?: string }) => Number(item.group!.replace('navigation@', ''));
    expect([...teamTitleItems].sort((a, b) => order(a) - order(b)).map((item) => item.command)).toEqual([
      'unode.openWorkbench', 'unode.addAgent', 'unode.teamActions', 'unode.openSettings',
    ]);
  });

  it('declares the overflow menu command with an icon', () => {
    const command = (pkg.contributes.commands as Array<{ command: string; title: string; icon?: string }>)
      .find((entry) => entry.command === 'unode.teamActions');
    expect(command?.icon).toBe('$(ellipsis)');
    expect(command?.title).toContain('Team Actions');
  });

  it('keeps every former title-bar icon and every unpinned Team destination reachable from the menu', () => {
    for (const target of [
      // Title-bar icons before v0.9.106.
      'unode.startSolo',
      'unode.startSoloActive',
      'unode.sendMessage',
      'unode.collapseTeam',
      'unode.expandTeam',
      // Already in the menu.
      'unode.openAgentBuilder',
      'unode.createTeamPreset',
      'unode.startAllAgents',
      'unode.stopAllAgents',
      'unode.editTeamRules',
      'unode.restoreCheckpoint',
      'unode.deleteCheckpoint',
      'unode.toggleConcurrencyMode',
      'unode.openMarketplace',
      'unode.openAccount',
      'unode.showSecurity',
      'unode.generateEvidenceReport',
      // Command Palette only before v0.9.106.
      'unode.showDashboard',
      'unode.runWorkflow',
      'unode.editWorkflow',
      'unode.savedTaskBatches',
    ]) {
      expect(teamActionsMenu, `${target} is neither pinned nor in the Team Actions menu`).toContain(`'${target}'`);
    }
  });

  it('does not repeat a pinned icon inside the menu', () => {
    for (const pinned of ['unode.addAgent', 'unode.openSettings', 'unode.openWorkbench']) {
      expect(teamActionsMenu, `${pinned} is pinned and should not also be a menu entry`).not.toContain(pinned);
    }
  });

  it('offers the Solo entry for the state the chat is in, as the two former Solo icons did', () => {
    expect(teamActionsMenu).toContain("target: soloSelected ? 'unode.startSoloActive' : 'unode.startSolo'");
    expect(teamActionsMenu).toContain('const soloSelected = isSoloSelected();');
  });
});
