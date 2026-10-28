import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const extensionSource = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
const providerSource = readFileSync(join(ROOT, 'src', 'views', 'MessageLogProvider.ts'), 'utf8');

describe('Activity is the one team-event entry', () => {
  it('contributes only the sidebar Activity view and leaves no dead Messages menus', () => {
    const contributedViews = Object.values(manifest.contributes.views)
      .flat() as Array<{ id: string; name: string }>;
    const activityViews = contributedViews.filter((view) =>
      view.id === 'unode.activityPanel' || view.id === 'unode.messageLog');

    expect(activityViews).toEqual([{ id: 'unode.activityPanel', name: 'Activity', type: 'webview', icon: '$(output)', contextualTitle: 'UnodeAi Activity' }]);
    // Roster, then the feed, then the transcript. Activity sits above Chat because a feed is what you
    // glance at and a transcript is what you drop into to read (Owner, 2026-08-21).
    expect(manifest.contributes.views.unode.map((view: { id: string }) => view.id))
      .toEqual(['unode.teamPanel', 'unode.activityPanel', 'unode.chat']);
    expect(manifest.contributes.views.unodePanel).toBeUndefined();
    expect(manifest.contributes.viewsContainers.panel).toBeUndefined();
    expect(JSON.stringify(manifest.contributes.menus['view/title'])).not.toContain('unode.messageLog');
    expect(providerSource).toContain("public static readonly viewType = 'unode.activityPanel'");
  });

  it('keeps the old command id but routes it to the surviving Activity view', () => {
    const command = manifest.contributes.commands.find((candidate: { command?: string }) =>
      candidate.command === 'unode.showMessageLog');

    expect(command?.title).toBe('UnodeAi: Show Activity');
    expect(extensionSource).toContain("reg('unode.showMessageLog', () => vscode.commands.executeCommand('unode.activityPanel.focus'))");
    expect(extensionSource).not.toContain("registerWebviewViewProvider('unode.messageLog'");
    expect(extensionSource).not.toContain("executeCommand('unode.messageLog.focus')");
  });
});
