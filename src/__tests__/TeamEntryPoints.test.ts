import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEAM_COMMANDS = ['unode.createDefaultTeam', 'unode.createTeamPreset', 'unode.saveTeam', 'unode.openSavedTeam'] as const;

describe('the saved-team entry point', () => {
  it('shows only Create/Save/Load in the Command Palette', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }>; menus: { commandPalette: Array<{ command: string; when?: string }> } };
    };
    const visible = TEAM_COMMANDS.filter((command) => !manifest.contributes.menus.commandPalette
      .some((item) => item.command === command && item.when === 'false'));

    expect(visible).toEqual(['unode.createTeamPreset']);
    expect(manifest.contributes.commands.find((item) => item.command === 'unode.createTeamPreset')?.title)
      .toBe('UnodeAi: Create/Save/Load a Team…');
  });

  it('has the same sole entry in Team Actions and the empty Team panel', () => {
    const extension = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
    const actionsStart = extension.indexOf("reg('unode.teamActions'");
    const actionsEnd = extension.indexOf('const picked = await vscode.window.showQuickPick(items', actionsStart);
    const teamActions = extension.slice(actionsStart, actionsEnd);
    const visibleActions = [...teamActions.matchAll(/target: '(unode\.(?:createTeamPreset|saveTeam|openSavedTeam))'/g)]
      .map((match) => match[1]);
    expect(visibleActions).toEqual(['unode.createTeamPreset']);

    // v0.9.106 (first use, design §3.6): the empty Team panel has one button, which runs Get Started and so opens the
    // Workbench's first-task screen (the Owner, 2026-11-18), and one link, "Custom team…", which is this same sole team
    // entry.
    const panel = readFileSync(join(ROOT, 'src', 'views', 'TeamViewProvider.ts'), 'utf8');
    const emptyStart = panel.indexOf('private _renderEmptyState(): string {');
    const emptyEnd = panel.indexOf('private async openDocumentation', emptyStart);
    const emptyPanel = panel.slice(emptyStart, emptyEnd);
    const commands = [...emptyPanel.matchAll(/data-command="([^"]+)"/g)].map((match) => match[1]);
    expect(commands).toEqual(['getStarted', 'createTeamPreset']);
    expect(emptyPanel).toContain('>Custom team…</button>');
    expect(emptyPanel).not.toContain('createDefaultTeam');
    expect(panel).toMatch(/case 'getStarted':\s+(?:\/\/[^\n]*\n\s+)?vscode\.commands\.executeCommand\('unode\.onboarding'\);/);
    expect(panel).not.toContain("case 'openChat':");
  });
});
