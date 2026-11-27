import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * v0.9.106 (design §8.3, settings-and-commands inventory): every contributed command keeps its id, handler and
 * keybinding. The Command Palette lists the everyday entries; a command is hidden from it only where it has a real
 * other place. This file names that place for every hidden command and checks the place exists, and checks the
 * title bars: at most four icons per view, and the quiet first screen while the roster is empty.
 */
const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    views: { unode: Array<{ id: string; when?: string }> };
    menus: Record<'commandPalette' | 'view/title' | 'editor/title', Array<{ command: string; when?: string; group?: string }>>;
  };
};
const extension = read('src/extension.ts');
/** Where contributed commands are registered: the extension, the Spend host and the orchestration commands. */
const registrations = [extension, read('src/host/SpendHost.ts'), read('src/host/orchestration/OrchestrationCommandRegistration.ts')].join('\n');
const teamActionsMenu = extension.slice(extension.indexOf("reg('unode.teamActions'"), extension.indexOf("reg('unode.sendMessage'"));
const exportMenu = extension.slice(extension.indexOf("reg('unode.export'"), extension.indexOf("reg('unode.generateEvidenceReport'"));

/** The Command Palette entries: the inventory's fifteen everyday entries, then those with no other real place. */
const PALETTE_VISIBLE = [
  // v0.9.110 R2: Revert to before a request, Undo revert, Redo revert.
  'unode.revertToRequest', 'unode.undoRevert', 'unode.redoRevert',
  // The inventory's fifteen.
  'unode.showTeamPanel', 'unode.openSpend', 'unode.startAllAgents', 'unode.stopAllAgents', 'unode.addAgent',
  'unode.openAgentBuilder', 'unode.createTeamPreset', 'unode.openWorkbench', 'unode.reviewRun', 'unode.onboarding',
  'unode.export', 'unode.openSettings', 'unode.showSecurity', 'unode.openMarketplace', 'unode.addMcpServer',
  // Team Actions itself: its icon is hidden on the quiet first screen, so the palette keeps every entry of the menu
  // (Solo, Dashboard, Workflows, Team Rules, checkpoints, Concurrency, Account) reachable in every state.
  'unode.teamActions',
  // No other place found; kept visible rather than hidden (each is reported to the Owner).
  'unode.reviewSharedMemory', 'unode.applyExecutionHooks', 'unode.showPromptedCommandLog', 'unode.refreshPrices',
  'unode.openWorktreeReview', 'unode.manageProjectCommandApprovals', 'unode.showAgentOutput',
  // A keyboard command: the palette is where its shortcut is shown.
  'unode.toggleWorkbenchComposerFocus',
  // The context pill is absent on a runtime that owns its own context; the command is then the only surface.
  'unode.compactContext',
  // The Team panel's empty-state card is being retired by the first-use design, which keeps this in the palette.
  'unode.runDemoTask',
  // The Settings panel sets known provider keys only; this also stores a custom secret name (e.g. for an MCP server).
  'unode.setApiKey',
  // Its other places (Chat session menu and title bar) need an agent; archived chats outlive the roster.
  'unode.viewArchivedChats',
  // v0.9.106 (setup guide, design §2): always reachable, also before any agent exists, when Team Actions is hidden.
  'unode.setupGuide',
  // v0.9.107: direct Documents & images navigation for renderer diagnostics; reported to the Owner in progress.
  'unode.openDocumentSettings',
  // v0.9.110 (design §5): "UnodeAi: Task history"; the Chat title bar and session menu need an agent, history does not.
  'unode.taskHistory',
];

type Place =
  | { teamActions: true }
  /** Team Actions runs another command that does the same thing. */
  | { teamActionsRuns: string }
  | { exportMenu: true }
  | { menu: 'view/title' | 'editor/title' }
  | { view: string }
  | { source: string; contains: string[] };

const TEAM_ACTIONS: Place = { teamActions: true };
const EXPORT: Place = { exportMenu: true };
const VIEW_TITLE: Place = { menu: 'view/title' };
const teamRow = (...contains: string[]): Place => ({ source: 'src/views/TeamViewProvider.ts', contains });
const sessionMenu = (command: string): Place => ({ source: 'src/views/ChatViewProvider.ts', contains: [`data-chat-command="${command}"`, `'${command}',`] });
/** The Settings Spend tab's button posts the action; the host maps it to the command. */
const spendTab = (action: string, command: string): Place =>
  ({ source: 'src/extension.ts', contains: [`case '${action}': await vscode.commands.executeCommand('${command}')`] });
const settingsSpend = (action: string): Place => ({ source: 'src/views/SettingsPanel.ts', contains: [`data-spend-action="${action}"`] });
const dashboardSpend = (command: string): Place => ({ source: 'src/views/spendDashboard.ts', contains: [`href="command:${command}"`] });

/** Every command hidden from the Command Palette, with the places it is reached from instead. */
const HIDDEN: Record<string, Place[]> = {
  // Hidden before v0.9.106.
  'unode.createDefaultTeam': [{ source: 'src/dialogs.ts', contains: ["description: 'PM + Architect + Developer + Reviewer'", 'Load system defaults'] }],
  'unode.saveTeam': [{ source: 'src/dialogs.ts', contains: ["label: 'Save current team...'"] }],
  'unode.openSavedTeam': [{ source: 'src/dialogs.ts', contains: ["teamMenuHeading('Load saved teams')"] }],
  'unode.startSoloActive': [TEAM_ACTIONS],
  'unode.setDashboardTaskCount': [{ source: 'src/views/DashboardProvider.ts', contains: ['command:unode.setDashboardTaskCount?'] }],
  'unode.exportMessages': [VIEW_TITLE, EXPORT],
  'unode.exportRun': [VIEW_TITLE, EXPORT],
  'unode.exportPortableRun': [EXPORT],
  'unode.exportWorkerProgress': [VIEW_TITLE, EXPORT],
  'unode.generateEvidenceReport': [TEAM_ACTIONS, EXPORT],
  'unode.enableCommands': [{ source: 'src/backend/CommandApprovalPrompter.ts', contains: ["'unode.enableCommands'"] }],
  // v0.9.106.
  'unode.showDashboard': [TEAM_ACTIONS],
  'unode.openMissionControl': [{ menu: 'editor/title' }],
  'unode.changeSpendTarget': [dashboardSpend('unode.changeSpendTarget')],
  'unode.resetSpendCounter': [dashboardSpend('unode.resetSpendCounter')],
  'unode.reviewRepositorySpendTargets': [settingsSpend('reviewProposal'), spendTab('reviewProposal', 'unode.reviewRepositorySpendTargets'), dashboardSpend('unode.reviewRepositorySpendTargets')],
  'unode.repairSpendTracking': [settingsSpend('repair'), spendTab('repair', 'unode.repairSpendTracking')],
  'unode.updateUnodeReferencePrices': [settingsSpend('updateUnode'), spendTab('updateUnode', 'unode.updateUnodeReferencePrices'), dashboardSpend('unode.updateUnodeReferencePrices')],
  'unode.updateRoamReferencePrices': [settingsSpend('updateRoam'), spendTab('updateRoam', 'unode.updateRoamReferencePrices'), dashboardSpend('unode.updateRoamReferencePrices')],
  'unode.showWorkbenchInspector': [{ menu: 'editor/title' }],
  'unode.hideWorkbenchInspector': [{ menu: 'editor/title' }],
  // Needs a checkpoint id: the Workbench change rail's Restore supplies it.
  'unode.restoreCheckpointById': [{ source: 'src/views/ChatViewProvider.ts', contains: ["'unode.restoreCheckpointById'"] }],
  'unode.startSolo': [TEAM_ACTIONS],
  'unode.sendMessage': [TEAM_ACTIONS],
  // The Chat view itself, and the Dashboard's New Task; Open Workbench (in the palette) opens the same surface.
  'unode.openChat': [{ view: 'unode.chat' }, { source: 'src/views/DashboardProvider.ts', contains: ['href="command:unode.openChat"'] }],
  // Needs an agent id: a member's row in the Team panel.
  'unode.chatWithAgent': [teamRow("'chatAgent'", "executeCommand('unode.chatWithAgent', agentId)")],
  'unode.closeWorkbench': [VIEW_TITLE],
  'unode.focusPendingApproval': [
    { source: 'src/extension.ts', contains: ["approvalStatusBarItem.command = 'unode.focusPendingApproval'"] },
    teamRow("'focusApproval'", "executeCommand('unode.focusPendingApproval', agentId)"),
  ],
  'unode.runWorkflow': [TEAM_ACTIONS],
  'unode.editWorkflow': [TEAM_ACTIONS],
  // The per-agent commands need an agent id, which the palette cannot supply; each member's row has the action.
  'unode.agentStart': [teamRow("iconBtn('startAgent'", "case 'startAgent':")],
  'unode.agentStop': [teamRow("iconBtn('stopAgent'", "executeCommand('unode.agentStop', agentId)")],
  'unode.agentRestart': [teamRow("iconBtn('restartAgent'", "case 'restartAgent':")],
  'unode.agentRemove': [teamRow("iconBtn('removeAgent'", "case 'removeAgent':")],
  'unode.agentEdit': [
    teamRow("iconBtn('editAgent'"),
    { source: 'src/extension.ts', contains: ["openAgentModelSettings: (agentId) => { void vscode.commands.executeCommand('unode.agentEdit', agentId); }"] },
  ],
  'unode.showAgentTerminal': [teamRow("iconBtn('showTerminal'", "executeCommand('unode.showAgentTerminal', agentId)")],
  'unode.showCheckpointDiff': [teamRow('data-command="showCheckpointDiff"'), { source: 'src/views/ChatViewProvider.ts', contains: ["'unode.showCheckpointDiff'"] }],
  'unode.showMessageLog': [{ view: 'unode.activityPanel' }],
  'unode.clearChat': [sessionMenu('unode.clearChat'), VIEW_TITLE],
  'unode.newModelConversation': [sessionMenu('unode.newModelConversation')],
  'unode.archiveChat': [sessionMenu('unode.archiveChat'), VIEW_TITLE],
  'unode.exportChat': [sessionMenu('unode.exportChat'), VIEW_TITLE, EXPORT],
  'unode.importChat': [sessionMenu('unode.importChat'), VIEW_TITLE],
  'unode.toggleChatCompact': [sessionMenu('unode.toggleChatCompact'), VIEW_TITLE],
  'unode.clearMessageLog': [VIEW_TITLE],
  'unode.importMessages': [VIEW_TITLE],
  'unode.toggleMessagesCompact': [VIEW_TITLE],
  'unode.collapseTeam': [TEAM_ACTIONS],
  'unode.expandTeam': [TEAM_ACTIONS],
  'unode.restoreCheckpoint': [TEAM_ACTIONS],
  'unode.deleteCheckpoint': [TEAM_ACTIONS],
  'unode.savedTaskBatches': [TEAM_ACTIONS],
  'unode.openAccount': [TEAM_ACTIONS, { source: 'src/views/SettingsPanel.ts', contains: ['data-tab="account">Unode Account<'] }],
  'unode.toggleConcurrencyMode': [TEAM_ACTIONS],
  // The two former title-bar icons only run the toggle, which Team Actions runs.
  'unode.concurrencyMode.optimistic': [{ teamActionsRuns: 'unode.toggleConcurrencyMode' }, { source: 'src/extension.ts', contains: ["reg('unode.concurrencyMode.optimistic', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));"] }],
  'unode.concurrencyMode.worktree': [{ teamActionsRuns: 'unode.toggleConcurrencyMode' }, { source: 'src/extension.ts', contains: ["reg('unode.concurrencyMode.worktree', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));"] }],
  // The Crew Worktrees panel (Open Worktree Review stays in the palette) has the Finalize button.
  'unode.worktree.finalize': [{ source: 'src/views/WorktreePanel.ts', contains: ['id="finalize"', "vscode.postMessage({ command: 'finalize' })"] }],
  'unode.resetWorkspaceState': [
    { source: 'src/views/SettingsPanel.ts', contains: ['data-command="resetWorkspace"'] },
    { source: 'src/extension.ts', contains: ["resetWorkspace: () => vscode.commands.executeCommand('unode.resetWorkspaceState')"] },
  ],
  'unode.editTeamRules': [TEAM_ACTIONS],
};

function placeHolds(command: string, place: Place): string | undefined {
  if ('teamActionsRuns' in place) return teamActionsMenu.includes(`target: '${place.teamActionsRuns}'`) ? undefined : `Team Actions lacks ${place.teamActionsRuns}`;
  if ('teamActions' in place) return teamActionsMenu.includes(`'${command}'`) ? undefined : 'not in Team Actions';
  if ('exportMenu' in place) return exportMenu.includes(`command: '${command}'`) ? undefined : 'not in Export…';
  if ('menu' in place) return manifest.contributes.menus[place.menu].some((item) => item.command === command) ? undefined : `not in ${place.menu}`;
  if ('view' in place) return manifest.contributes.views.unode.some((view) => view.id === place.view) ? undefined : `no view ${place.view}`;
  const text = read(place.source);
  const missing = place.contains.filter((snippet) => !text.includes(snippet));
  return missing.length ? `${place.source} lacks ${missing.join(' | ')}` : undefined;
}

/** A small when-clause evaluator: `a && b || c`, `!key`, `key == value`, `key`, `false`. Enough for this manifest. */
function holds(when: string | undefined, context: Record<string, unknown>): boolean {
  if (!when) return true;
  return when.split('||').some((alternative) => alternative.split('&&').every((raw) => {
    const term = raw.trim();
    if (term === 'false') return false;
    if (term === 'true') return true;
    if (term.startsWith('!')) return !context[term.slice(1).trim()];
    const equality = term.match(/^([\w.]+)\s*==\s*'?([\w.]+)'?$/);
    if (equality) return context[equality[1]] === equality[2];
    if (!/^[\w.]+$/.test(term)) throw new Error(`unsupported when clause: ${when}`);
    return Boolean(context[term]);
  }));
}

const VIEWS = ['unode.teamPanel', 'unode.chat', 'unode.activityPanel'] as const;
function titleBar(view: string, context: Record<string, unknown>) {
  const items = manifest.contributes.menus['view/title'].filter((item) => holds(item.when, { ...context, view }));
  const navigation = items.filter((item) => item.group?.startsWith('navigation'))
    .sort((a, b) => Number(a.group!.split('@')[1] ?? 0) - Number(b.group!.split('@')[1] ?? 0))
    .map((item) => item.command);
  return { navigation, overflow: items.filter((item) => !item.group?.startsWith('navigation')).map((item) => item.command) };
}
function* contexts() {
  for (const hasAgents of [false, true]) for (const returningUser of [undefined, false, true])
    for (const soloActive of [false, true]) for (const teamCompact of [false, true]) for (const workbenchOpen of [false, true]) {
      yield { 'unode.hasAgents': hasAgents, 'unode.returningUser': returningUser, 'unode.soloActive': soloActive, 'unode.teamCompact': teamCompact, 'unode.workbenchOpen': workbenchOpen };
    }
}

describe('v0.9.106 every contributed command stays reachable', () => {
  const ids = manifest.contributes.commands.map((command) => command.command);
  const hidden = manifest.contributes.menus.commandPalette.filter((item) => item.when === 'false').map((item) => item.command);

  it('keeps all 93 command ids and the one keybinding', () => {
    // 87 at the inventory, plus Setup Guide, v0.9.107 Documents & images, v0.9.110's three revert commands and Task history.
    expect(ids).toHaveLength(93);
    expect(new Set(ids).size).toBe(93);
    expect(manifest.contributes.keybindings).toEqual([
      { command: 'unode.toggleWorkbenchComposerFocus', key: 'ctrl+alt+enter', mac: 'cmd+alt+enter', when: 'editorTextFocus || webviewFocus' },
    ]);
  });

  it('registers a handler for every contributed command', () => {
    const registered = (id: string) => registrations.includes(`reg('${id}'`) || registrations.includes(`register('${id}'`)
      || registrations.includes(`'${id}', async () =>`);
    expect(ids.filter((id) => !registered(id))).toEqual([]);
  });

  it('lists exactly the everyday entries and the commands without another place in the Command Palette', () => {
    const visible = ids.filter((id) => !hidden.includes(id));
    expect(visible.sort()).toEqual([...PALETTE_VISIBLE].sort());
    expect(manifest.contributes.menus.commandPalette.every((item) => item.when === 'false')).toBe(true);
  });

  it('names a real place for every command hidden from the Command Palette', () => {
    expect([...hidden].sort()).toEqual(Object.keys(HIDDEN).sort());
    const failures: string[] = [];
    for (const [command, places] of Object.entries(HIDDEN)) {
      expect(places.length, command).toBeGreaterThan(0);
      for (const place of places) {
        const problem = placeHolds(command, place);
        if (problem) failures.push(`${command}: ${problem}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('shows each view/title entry of a hidden command in at least one state of the roster', () => {
    for (const command of Object.keys(HIDDEN)) {
      for (const item of manifest.contributes.menus['view/title'].filter((entry) => entry.command === command)) {
        expect([...contexts()].some((context) => VIEWS.some((view) => holds(item.when, { ...context, view }))), command).toBe(true);
      }
    }
  });
});

describe('v0.9.106 title bars: at most four icons, and a quiet first screen', () => {
  it('pins at most four icons in every view, in every state', () => {
    for (const context of contexts()) {
      for (const view of VIEWS) {
        const { navigation } = titleBar(view, context);
        expect(navigation.length, `${view} ${JSON.stringify(context)}: ${navigation.join(', ')}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('with a roster: the Team, Chat and Activity title bars', () => {
    const context = { 'unode.hasAgents': true, 'unode.workbenchOpen': false };
    expect(titleBar('unode.teamPanel', context)).toEqual({
      navigation: ['unode.openWorkbench', 'unode.addAgent', 'unode.teamActions', 'unode.openSettings'], overflow: [],
    });
    expect(titleBar('unode.chat', context)).toEqual({
      navigation: ['unode.openWorkbench', 'unode.archiveChat', 'unode.clearChat'],
      overflow: ['unode.toggleChatCompact', 'unode.taskHistory', 'unode.viewArchivedChats', 'unode.exportChat', 'unode.importChat'],
    });
    expect(titleBar('unode.chat', { ...context, 'unode.workbenchOpen': true }).navigation[0]).toBe('unode.closeWorkbench');
    expect(titleBar('unode.activityPanel', context)).toEqual({
      navigation: ['unode.exportMessages', 'unode.toggleMessagesCompact', 'unode.clearMessageLog'],
      overflow: ['unode.exportRun', 'unode.exportWorkerProgress', 'unode.importMessages'],
    });
  });

  it('without agents: Chat shows nothing, Team shows only Settings, and the Activity view is hidden', () => {
    for (const returningUser of [undefined, false]) {
      const context = { 'unode.hasAgents': false, 'unode.returningUser': returningUser, 'unode.workbenchOpen': false };
      expect(titleBar('unode.chat', context)).toEqual({ navigation: [], overflow: [] });
      expect(titleBar('unode.teamPanel', context)).toEqual({ navigation: ['unode.openSettings'], overflow: [] });
    }
    // Before activation sets the key it is undefined, which reads as no agents.
    expect(titleBar('unode.teamPanel', {})).toEqual({ navigation: ['unode.openSettings'], overflow: [] });
    expect(titleBar('unode.chat', {})).toEqual({ navigation: [], overflow: [] });
    const activity = manifest.contributes.views.unode.find((view) => view.id === 'unode.activityPanel');
    expect(activity?.when).toBe('unode.hasAgents');
    expect(manifest.contributes.views.unode.filter((view) => view.when !== undefined).map((view) => view.id)).toEqual(['unode.activityPanel']);
  });

  it('without agents, a returning user keeps Add Agent, Team Actions and Settings', () => {
    const context = { 'unode.hasAgents': false, 'unode.returningUser': true };
    expect(titleBar('unode.teamPanel', context)).toEqual({
      navigation: ['unode.addAgent', 'unode.teamActions', 'unode.openSettings'], overflow: [],
    });
    expect(titleBar('unode.chat', context)).toEqual({ navigation: [], overflow: [] });
  });

  it('the evaluator reads the clauses it is given', () => {
    expect(holds('view == unode.teamPanel && unode.hasAgents || view == unode.teamPanel && unode.returningUser',
      { view: 'unode.teamPanel', 'unode.returningUser': true })).toBe(true);
    expect(holds('view == unode.chat && unode.hasAgents && !unode.workbenchOpen', { view: 'unode.chat', 'unode.hasAgents': true, 'unode.workbenchOpen': true })).toBe(false);
    expect(holds("activeWebviewPanelId == 'unode.workbench'", { activeWebviewPanelId: 'unode.workbench' })).toBe(true);
    expect(() => holds('(a || b)', {})).toThrow();
  });
});
