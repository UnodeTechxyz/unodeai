/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TeamViewProvider
 *  Sidebar webview showing the agent team with status, controls, and actions
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from '../session/SessionManager';
import { MessageBus } from '../bus/MessageBus';
import { SessionInfo } from '../types';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import { toConsoleRows } from './parallelConsoleModel';
import { DelegationAgentState } from './orchestrationProgress';
import { renderAgentIcon } from './agentIcon';
import { Checkpoint } from '../backend/Checkpoints';
import { ChangedFileSummary, groupChangedFilesByAgent } from './checkpointSummary';
import { promptTemplateStatus } from '../roles/PromptTemplateState';
import { ApprovalAttention } from './approvals';

export class TeamViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'unode.teamPanel';

  private _view?: vscode.WebviewView;
  /** Compact mode: each agent collapses to a small icon chip to free vertical space for New Task. */
  private _compact = false;
  private delegationStates = new Map<string, DelegationAgentState>();
  /** Repaint shortly after a transient delegation verdict ages out, even if no new session event arrives. */
  private statusDecayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private sessionManager: SessionManager,
    private messageBus: MessageBus,
    /** Extension version, shown in the view title bar so you always know what build you're running. */
    private readonly version = '',
    /** When Smart Mode is on, returns the tier + the model the agent will actually run on (its provider's
     *  tier model, or undefined when the agent keeps its configured model). Undefined = Smart Mode off. */
    private readonly smartModePreview?: (config: { role: string; tier?: string; provider: { providerId: string } }) => { tier: string; model?: string } | undefined,
    /** Recorded file checkpoints — used to show each agent's recently changed files on its card. */
    private getCheckpoints: () => Checkpoint[] = () => [],
    /** Registry-owned presentation label; the provider id remains opaque for actions and support. */
    private readonly displayNameForProviderId: (providerId: string) => string = (providerId) => providerId,
    /** Approval state is owned by the conversation queue; the Team roster is only a subscriber. */
    private readonly approvalAttentionForAgent: (agentId: string) => ApprovalAttention | undefined = () => undefined,
    /** Optional compact description of a stored per-agent command ceiling. */
    private readonly commandNarrowingSummary: (config: SessionInfo['config']) => string | undefined = () => undefined,
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    // The title stays one short word and the version goes in the `description` slot beside it, rather
    // than inside the title itself: VS Code drops the description first when the row runs out of room,
    // so the version yields to the action icons instead of competing with them for the same characters.
    webviewView.title = 'Team';
    webviewView.description = this.version ? `v${this.version}` : undefined;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!isTeamMessage(msg, this.sessionManager.getAll().map((s) => s.config.id))) {
        return;
      }
      const agentId = msg.agentId ?? '';
      switch (msg.command) {
        case 'startAgent':
          this.sessionManager.start(agentId);
          break;
        case 'stopAgent':
          this.sessionManager.stop(agentId);
          break;
        case 'restartAgent':
          this.sessionManager.restart(agentId);
          break;
        case 'removeAgent':
          this.sessionManager.remove(agentId);
          break;
        case 'sendMessage':
          vscode.commands.executeCommand('unode.sendMessage');
          break;
        case 'showOutput':
          vscode.commands.executeCommand('unode.showAgentOutput', agentId);
          break;
        case 'showTerminal':
          vscode.commands.executeCommand('unode.showAgentTerminal', agentId);
          break;
        case 'chatAgent':
          vscode.commands.executeCommand('unode.chatWithAgent', agentId);
          break;
        case 'openAgentWorkbench':
          vscode.commands.executeCommand('unode.openAgentWorkbench', agentId);
          break;
        case 'focusApproval':
          vscode.commands.executeCommand('unode.focusPendingApproval', agentId);
          break;
        case 'newTask':
        case 'openWorkbench':
          vscode.commands.executeCommand('unode.openWorkbench');
          break;
        case 'showCheckpointDiff':
          vscode.commands.executeCommand('unode.showCheckpointDiff', msg.checkpointId);
          break;
        case 'editAgent':
          vscode.commands.executeCommand('unode.openAgentBuilder', agentId);
          break;
        case 'openAgentBuilder':
          vscode.commands.executeCommand('unode.openAgentBuilder');
          break;
        case 'createDefaultTeam':
          // Route the empty-state "Create Team" card through the picker (software or knowledge-work),
          // so every entry point is consistent (menu / onboarding / panel).
          vscode.commands.executeCommand('unode.createTeamPreset');
          break;
        case 'addAgent':
          vscode.commands.executeCommand('unode.addAgent');
          break;
        case 'openMarketplace':
          vscode.commands.executeCommand('unode.openMarketplace');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('unode.openSettings');
          break;
        case 'showSecurity':
          vscode.commands.executeCommand('unode.showSecurity');
          break;
        case 'createTeamPreset':
          vscode.commands.executeCommand('unode.createTeamPreset');
          break;
        case 'editTeamRules':
          vscode.commands.executeCommand('unode.editTeamRules');
          break;
        case 'restoreCheckpoint':
          vscode.commands.executeCommand('unode.restoreCheckpoint');
          break;
        case 'startAllAgents':
          vscode.commands.executeCommand('unode.startAllAgents');
          break;
        case 'stopAllAgents':
          vscode.commands.executeCommand('unode.stopAllAgents');
          break;
        case 'startSolo':
          vscode.commands.executeCommand('unode.startSolo');
          break;
        case 'startSoloActive':
          vscode.commands.executeCommand('unode.startSoloActive');
          break;
        case 'runDemoTask':
          vscode.commands.executeCommand('unode.runDemoTask');
          break;
        case 'openDocumentation':
          void this.openDocumentation();
          break;
      }
    });
  }

  refresh(): void {
    if (this._view) {
      this._view.webview.html = this._getHtml(this._view.webview);
    }
  }

  /** Toggle compact mode (icon-only agent chips) and re-render. */
  setCompact(compact: boolean): void {
    this._compact = compact;
    this.refresh();
  }

  setDelegationProgress(states: DelegationAgentState[]): void {
    this.delegationStates = new Map(states.map((state) => [state.agentId, state]));
    this.refresh();
    this.scheduleStatusDecay();
  }

  private scheduleStatusDecay(): void {
    if (this.statusDecayTimer) {
      clearTimeout(this.statusDecayTimer);
      this.statusDecayTimer = undefined;
    }
    const expiryTimes = [...this.delegationStates.values()]
      .map((state) => Date.parse(state.updatedAt) + 120_000)
      .filter(Number.isFinite)
      .filter((expiresAt) => expiresAt > Date.now());
    if (expiryTimes.length === 0) {
      return;
    }
    const nextExpiry = Math.min(...expiryTimes);
    this.statusDecayTimer = setTimeout(() => {
      this.statusDecayTimer = undefined;
      this.refresh();
      this.scheduleStatusDecay();
    }, Math.max(0, nextExpiry - Date.now()) + 1);
  }

  isCompact(): boolean {
    return this._compact;
  }

  // There is deliberately no per-agent status patch message. A status change alters the row's label,
  // its available controls, and its metrics together, so the host re-renders the roster (refresh) rather
  // than reaching into the DOM. The patch path that used to live here targeted element ids the row
  // stopped rendering, and had no callers left to notice.

  /** Activity-bar container badge: a subscriber to the host approval signal, never its source. */
  setApprovalBadge(count: number): void {
    if (!this._view) {
      return;
    }
    const view = this._view as vscode.WebviewView & { badge?: { value: number; tooltip: string } };
    view.badge = count > 0
      ? { value: count, tooltip: `${count} approval${count === 1 ? '' : 's'} waiting` }
      : undefined;
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const sessions = this.sessionManager.getAll();

    const changedFilesByAgent = groupChangedFilesByAgent(this.getCheckpoints());
    const compact = this._compact && sessions.length > 0;
    const agentCards = sessions.length === 0
      ? this._renderEmptyState()
      : sessions.map((s) => compact
        ? this._renderCompactCard(s)
        : this._renderSidebarRow(s, changedFilesByAgent.get(s.config.id) ?? [])
      ).join('');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Team</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    .file-activity { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .file-activity-title { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .file-activity-list { display: flex; flex-direction: column; gap: 2px; }
    .file-activity-item { width: 100%; padding: 2px 0; border: none; background: transparent;
      color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; font-size: 11px; text-align: left;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-activity-item:hover { text-decoration: underline; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      padding: 8px;
    }
    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-icon { font-size: 48px; display: block; margin-bottom: 12px; }
    .empty-grid { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 12px; }
    .empty-card {
      width: 100%;
      text-align: left;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .empty-card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .empty-title { display: block; font-weight: 700; margin-bottom: 4px; }
    .empty-copy { display: block; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.35; }
    .hint { font-size: 11px; opacity: 0.7; margin-top: 8px; }
    .cta {
      display: inline-block;
      margin-top: 12px;
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .cta:hover { background: var(--vscode-button-hoverBackground); }
    .agent-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      transition: border-color 0.2s;
    }
    .agent-card:hover { border-color: var(--vscode-focusBorder); }
    /* UX3: the sidebar is navigation/status, not a second full Workbench. */
    .sidebar-primary { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .sidebar-primary button { min-height: 30px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .sidebar-primary button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .sidebar-section-title { margin: 8px 0 5px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    #team-container:not(.compact-grid) { display: grid; gap: 4px; }
    .session-item { border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-editor-background); }
    .session-item:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .session-item.waiting { border-color: var(--vscode-charts-yellow, #d29922); background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 12%, var(--vscode-editor-background)); }
    .session-item.timed-out .session-name { color: var(--vscode-descriptionForeground); }
    .session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px; align-items: center; padding: 5px 4px 5px 7px; }
    .session-open { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; align-items: center; min-width: 0; padding: 2px 0;
      border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .session-avatar { position: relative; display: inline-flex; }
    .session-avatar .approval-lock { position: absolute; right: -4px; bottom: -4px; font-size: 10px; line-height: 1; }
    .session-item .agent-icon-img { width: 18px; height: 18px; }
    .session-main { min-width: 0; display: grid; gap: 2px; }
    .session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
    .session-task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .session-trail { display: inline-flex; align-items: center; gap: 3px; }
    /* A dot remains a quick scan aid, never the only status channel. The 18px text/glyph marker is
       visible in the collapsed 250px roster and differentiates states which intentionally share colour. */
    .status-marker { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center;
      border: 1px solid currentColor; border-radius: 50%; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; line-height: 1; }
    .status-marker.status-verified { border-radius: 3px; color: var(--vscode-charts-green, #28a745); }
    .status-marker.status-no-applicable-sensor { color: var(--vscode-descriptionForeground); }
    .status-marker.status-verification-failed { color: var(--vscode-errorForeground, #dc3545); }
    .status-marker.status-tool-activity-recorded { border-style: dashed; color: var(--vscode-editorWarning-foreground, #b58100); }
    .status-marker.status-coordinator-accepted { border-radius: 3px; color: var(--vscode-charts-green, #28a745); }
    .status-marker.status-coordinator-rejected, .status-marker.status-human-intervention-required { color: var(--vscode-errorForeground, #dc3545); }
    .status-marker.status-done { color: var(--vscode-charts-green, #28a745); }
    .status-marker.status-replied-not-verified { border-style: dashed; color: var(--vscode-editorWarning-foreground, #b58100); }
    .status-marker.status-consent-required { border-radius: 3px; color: var(--vscode-editorWarning-foreground, #b58100); }
    .session-status { white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .session-status.waiting { color: var(--vscode-charts-yellow, #d29922); font-weight: 600; }
    /* The controls are ALWAYS on. Revealing them on hover meant they blinked out whenever the pointer
       left the row, and a control you have to go looking for is one you stop trusting. Their glyphs also
       carry the state the row used to spell out — a stopped agent offers Start, a running one offers
       Stop — so the status word is redundant text in a 250px column. What a glyph cannot say (error vs
       stopped, working vs idle) is said by the dot on the avatar. */
    .session-actions { display: inline-flex; gap: 1px; }
    .session-avatar .status-dot {
      position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border-radius: 50%;
      border: 1px solid var(--vscode-editor-background); background: var(--vscode-descriptionForeground);
    }
    .session-actions .icon-btn { width: 20px; height: 20px; font-size: 11px; }
    .session-expand { width: 18px; height: 20px; padding: 0; border: none; border-radius: 4px; background: transparent;
      color: var(--vscode-descriptionForeground); font: inherit; font-size: 10px; cursor: pointer; }
    .session-expand:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-foreground); }
    .session-detail { display: none; padding: 0 8px 8px 8px; }
    .session-item.expanded .session-detail { display: block; max-height: min(50vh, 360px); overflow-y: auto; }
    /* No Configure button here: the row's ⚙️ icon is the one way in, and an expanded row shows its
       controls unconditionally, so the icon is reachable without hovering. */
    .session-detail .agent-details { display: grid; gap: 3px; margin-bottom: 6px; }
    .agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .agent-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .agent-header-right { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
    .agent-name {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 600;
      font-size: 13px;
      min-width: 0;
    }
    .agent-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Action icons on the card's first row: emoji glyph + hover tooltip (the label). */
    .icon-btn {
      width: 24px; height: 24px; padding: 0; font-size: 13px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 4px; border: 1px solid transparent; background: transparent;
      color: var(--vscode-foreground); cursor: pointer;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); border-color: var(--vscode-panel-border); }
    .icon-btn.danger:hover { background: #dc354522; border-color: #dc3545; }
    .icon-btn:disabled { opacity: 0.5; cursor: default; }
    .agent-icon-img {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      object-fit: cover;
      flex: 0 0 auto;
    }
    .agent-role {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-emoji { font-size: 12px; line-height: 1; }
    .status-working { background: #28a74522; color: #28a745; }
    .status-delegating { background: #17a2b822; color: #17a2b8; }
    .status-done { background: #28a74522; color: #28a745; }
    .status-verified { background: #28a74522; color: #28a745; }
    .status-no-applicable-sensor { background: #6c757d22; color: #6c757d; }
    .status-verification-failed { background: #dc354522; color: #dc3545; }
    .status-tool-activity-recorded { background: #ffc10722; color: #b58100; }
    .status-replied-not-verified { background: #ffc10722; color: #b58100; }
    .status-no-evidence { background: #dc354522; color: #dc3545; }
    .status-delegation-timed-out, .status-consent-timed-out { background: #dc354522; color: #dc3545; }
    .status-coordinator-accepted { background: #28a74522; color: #28a745; }
    .status-coordinator-rejected, .status-human-intervention-required { background: #dc354522; color: #dc3545; }
    .status-blocked { background: #dc354522; color: #dc3545; }
    .status-running { background: #28a74522; color: #28a745; }
    .status-idle { background: #ffc10722; color: #ffc107; }
    .status-stopped { background: #6c757d22; color: #6c757d; }
    .status-error { background: #dc354522; color: #dc3545; }
    .status-starting { background: #17a2b822; color: #17a2b8; }
    .status-consent-required, .status-consent_required { background: #ffc10722; color: #b58100; }
    .status-stopping { background: #fd7e1422; color: #fd7e14; }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      display: inline-block;
    }
    .status-working .status-dot { background: #28a745; animation: pulse 1.5s infinite; }
    .status-delegating .status-dot { background: #17a2b8; }
    .status-done .status-dot { background: #28a745; }
    .status-verified .status-dot { background: #28a745; }
    .status-no-applicable-sensor .status-dot { background: #6c757d; }
    .status-verification-failed .status-dot { background: #dc3545; }
    .status-tool-activity-recorded .status-dot { background: #ffc107; }
    .status-replied-not-verified .status-dot { background: #ffc107; }
    .status-no-evidence .status-dot { background: #dc3545; }
    .status-delegation-timed-out .status-dot, .status-consent-timed-out .status-dot { background: #dc3545; }
    .status-coordinator-accepted .status-dot { background: #28a745; }
    .status-coordinator-rejected .status-dot, .status-human-intervention-required .status-dot { background: #dc3545; }
    .status-blocked .status-dot { background: #dc3545; }
    .status-stopped .status-dot { background: #6c757d; }
    .status-starting .status-dot,
    .status-stopping .status-dot { background: #17a2b8; }
    .status-consent-required .status-dot, .status-consent_required .status-dot { background: #ffc107; }
    .running .status-dot { background: #28a745; animation: pulse 1.5s infinite; }
    .idle .status-dot { background: #ffc107; }
    .error .status-dot { background: #dc3545; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @media (prefers-reduced-motion: reduce) {
      .status-working .status-dot, .running .status-dot,
      .compact-card.status-working .status-dot, .compact-card.status-running .status-dot { animation: none; }
    }
    .agent-details {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .model-line { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
    .smart-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #8957e522; color: #a371f7; font-weight: 600; white-space: nowrap; }
    .smart-badge.warn { background: var(--vscode-inputValidation-warningBackground, #6b5300); color: var(--vscode-editorWarning-foreground, #cca700); }
    .inline-metrics { display: inline-flex; flex-wrap: wrap; gap: 4px; }
    .agent-actions {
      display: flex;
      gap: 4px;
    }
    .btn {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-start { background: #28a74533; color: #28a745; border-color: #28a74555; }
    .btn-stop { background: #dc354533; color: #dc3545; border-color: #dc354555; }
    .skills-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .skill-tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .agent-task {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 4px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-task.err { color: #dc3545; }
    .agent-task.done { color: var(--vscode-charts-green, #28a745); }
    .template-update { margin: 6px 0 0; width: 100%; text-align: left; padding: 5px 7px; border-radius: 4px; border: 1px solid var(--vscode-inputValidation-warningBorder, #b58100); background: var(--vscode-inputValidation-warningBackground, transparent); color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); font: inherit; font-size: 11px; cursor: pointer; }
    .template-update:hover { filter: brightness(1.08); }
    /* Live per-agent metrics (folded in from the old Parallel Console): context %, cost, turns. */
    .agent-metrics { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    /* inline-metrics: the same chips rendered on the model row (v0.8.10 card layout). */
    .inline-metrics { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 6px; vertical-align: middle; }
    .agent-metrics .metric,
    .inline-metrics .metric {
      font-size: 10px;
      line-height: 1.3;
      padding: 1px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    /* Compact mode: agents collapse to small icon chips (status shown by the corner dot). */
    /* Compact mode: icon chips stay on a SINGLE row and scroll horizontally when they overflow —
       so the roster is always exactly one row tall no matter how many agents there are, freeing
       vertical space for Chat/Messages. (VS Code still enforces a floor on how short a sidebar
       webview view can be dragged, so a little empty space may remain below the row.) */
    body.compact { padding: 6px 8px; }
    .compact-grid { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; overflow-x: auto; overflow-y: hidden; }
    .compact-grid::-webkit-scrollbar { height: 6px; }
    .compact-grid > * { flex: 0 0 auto; }
    .compact-card {
      position: relative; width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; line-height: 1;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px; cursor: pointer;
      background: var(--vscode-editor-background);
    }
    .compact-card:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .compact-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 28px;
      max-height: 28px;
      overflow: hidden;
    }
    .compact-card .agent-icon-img {
      width: 28px;
      height: 28px;
    }
    .compact-card .status-dot {
      position: absolute; top: 3px; right: 3px;
      width: 8px; height: 8px; border-radius: 50%;
      border: 1px solid var(--vscode-editor-background);
      background: var(--vscode-descriptionForeground);
    }
    .compact-card .approval-lock { position: absolute; right: -3px; bottom: -4px; font-size: 12px; line-height: 1; }
    .compact-card .status-marker { position: absolute; left: 2px; bottom: 2px; width: 14px; height: 14px; font-size: 8px;
      background: var(--vscode-editor-background); }
    .compact-card.status-running .status-dot { background: #28a745; animation: pulse 1.5s infinite; }
    .compact-card.status-working .status-dot { background: #28a745; animation: pulse 1.5s infinite; }
    .compact-card.status-delegating .status-dot { background: #17a2b8; }
    .compact-card.status-done .status-dot { background: #28a745; }
    .compact-card.status-verified .status-dot { background: #28a745; }
    .compact-card.status-no-applicable-sensor .status-dot { background: #6c757d; }
    .compact-card.status-verification-failed .status-dot { background: #dc3545; }
    .compact-card.status-tool-activity-recorded .status-dot { background: #ffc107; }
    .compact-card.status-replied-not-verified .status-dot { background: #ffc107; }
    .compact-card.status-no-evidence .status-dot { background: #dc3545; }
    .compact-card.status-delegation-timed-out .status-dot,
    .compact-card.status-consent-timed-out .status-dot { background: #dc3545; }
    .compact-card.status-coordinator-accepted .status-dot { background: #28a745; }
    .compact-card.status-coordinator-rejected .status-dot, .compact-card.status-human-intervention-required .status-dot { background: #dc3545; }
    .compact-card.status-blocked .status-dot { background: #dc3545; }
    .compact-card.status-idle .status-dot { background: #ffc107; }
    .compact-card.status-stopped .status-dot { background: #6c757d; }
    .compact-card.status-error .status-dot { background: #dc3545; }
    .compact-card.status-starting .status-dot,
    .compact-card.status-stopping .status-dot { background: #17a2b8; }
    .compact-card.status-consent-required .status-dot,
    .compact-card.status-consent_required .status-dot { background: #ffc107; }
    /* Narrowing the sidebar must not make anything unreachable. Below these widths the collapsed chip
       strip wraps instead of scrolling its later agents out of sight, the two primary buttons stack,
       and the roster row hands its width back to the agent name. (The title-bar icons are VS Code's own
       row: it moves whatever no longer fits into the "..." overflow, which is why the view title is one
       short word and the version lives in the body.) */
    @media (max-width: 340px) {
      .compact-grid { flex-wrap: wrap; overflow-x: hidden; }
    }
    @media (max-width: 250px) {
      .sidebar-primary { grid-template-columns: 1fr; }
      .session-row { padding-left: 5px; gap: 2px; }
      .session-open { gap: 5px; }
      .session-actions .icon-btn { width: 18px; height: 18px; font-size: 10px; }
    }
  </style>
</head>
<body class="${compact ? 'compact' : ''}">
  ${sessions.length > 0 ? '<div class="sidebar-section-title">Sessions</div>' : ''}
  <div id="team-container" class="${compact ? 'compact-grid' : ''}">
    ${agentCards}
  </div>
  <details class="status-legend">
    <summary>Status key</summary>
    <ul><li>Working (…)</li><li>Delegating (↗)</li><li>Done (✓)</li><li>Verified (V)</li><li>Coordinator accepted (✓)</li><li>Coordinator rejected — amended (!)</li><li>Human intervention required (!)</li><li>Replied, not verified (↩)</li><li>No evidence (!)</li><li>Cancelled (■)</li><li>Blocked (×)</li><li>Idle (○)</li><li>Stopped (■)</li><li>Starting / stopping (…)</li><li>Consent required (🔒)</li><li>Denied — timed out (⌛)</li></ul>
  </details>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const emptyState = document.querySelector('.empty-state');
    if (emptyState) {
      const title = document.createElement('p');
      title.textContent = 'No agents in your team yet.';
      const grid = document.createElement('div');
      grid.className = 'empty-grid';
      [
        ['createDefaultTeam', 'Create a Team', 'Pick a software crew or a knowledge-work team (PM + specialists)'],
        ['openAgentBuilder', 'Build an Agent', 'Compose a custom role with model, tools, playbooks, and MCP grants'],
        ['runDemoTask', 'Run Demo Task', 'See UnodeAi in action with a pre-built task'],
        ['openDocumentation', 'Open Documentation', 'Learn about agents, teams, and workflows']
      ].forEach(([command, label, copy]) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'empty-card';
        card.dataset.command = command;
        const cardTitle = document.createElement('span');
        cardTitle.className = 'empty-title';
        cardTitle.textContent = label;
        const cardCopy = document.createElement('span');
        cardCopy.className = 'empty-copy';
        cardCopy.textContent = copy;
        card.append(cardTitle, cardCopy);
        grid.appendChild(card);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn';
      add.style.marginTop = '12px';
      add.dataset.command = 'addAgent';
      add.textContent = 'Add a single agent';
      emptyState.replaceChildren(title, grid, add);
    }

    // Which rows are expanded survives a re-render (the host replaces this document on every
    // roster refresh), so a member's details don't snap shut whenever an agent changes state.
    const savedState = vscode.getState() || {};
    const liveAgentIds = new Set(${JSON.stringify(sessions.map((session) => session.config.id))});
    const expandedIds = new Set((Array.isArray(savedState.expanded) ? savedState.expanded : []).filter((id) => liveAgentIds.has(id)));
    if (Array.isArray(savedState.expanded) && expandedIds.size !== savedState.expanded.length) {
      vscode.setState(Object.assign({}, savedState, { expanded: Array.from(expandedIds) }));
    }

    function setExpanded(item, expanded) {
      item.classList.toggle('expanded', expanded);
      const toggle = item.querySelector('.session-expand');
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? '▴' : '▾';
      }
    }

    document.querySelectorAll('.session-item').forEach((item) => {
      if (expandedIds.has(item.dataset.agentId)) setExpanded(item, true);
    });

    document.addEventListener('click', (event) => {
      const toggle = event.target.closest('button[data-expand]');
      if (!toggle) return;
      const item = toggle.closest('.session-item');
      if (!item) return;
      const expanded = !item.classList.contains('expanded');
      setExpanded(item, expanded);
      if (expanded) { expandedIds.add(item.dataset.agentId); } else { expandedIds.delete(item.dataset.agentId); }
      vscode.setState(Object.assign({}, vscode.getState(), { expanded: Array.from(expandedIds) }));
    });

    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      const checkpointId = button.dataset.checkpointId ? Number(button.dataset.checkpointId) : undefined;
      vscode.postMessage({ command: button.dataset.command, agentId: button.dataset.agentId, checkpointId });
    });

    // A double-click is an explicit request to work with this member, so it opens the Workbench even
    // when the single-click preference keeps navigation in the sidebar. Pending consent is different:
    // resolving the approval is the only actionable destination, and therefore wins over navigation.
    document.addEventListener('dblclick', (event) => {
      const item = event.target.closest('.session-item');
      if (!item) return;
      event.preventDefault();
      vscode.postMessage({
        command: item.classList.contains('status-consent-required') ? 'focusApproval' : 'openAgentWorkbench',
        agentId: item.dataset.agentId,
      });
    });

  </script>
</body>
</html>`;
  }

  /** A little person whose pose mirrors the agent's state: running=working, standing=idle, asleep=stopped. */
  private _stateEmoji(status: string): string {
    switch (status) {
      case 'working': return '🏃';
      case 'delegating': return '↗';
      case 'done': return '✓';
      case 'partial': return '◐';
      case 'verified': return '✓';
      case 'no-applicable-sensor': return '—';
      case 'verification-failed': return '!';
      case 'tool-activity-recorded': return '•';
      case 'replied-not-verified': return '!';
      case 'no-evidence': return '!';
      case 'delegation-timed-out': return '!';
      case 'consent-timed-out': return '⌛';
      case 'coordinator-accepted': return '✓';
      case 'coordinator-rejected': return '!';
      case 'human-intervention-required': return '!';
      case 'blocked': return '!';
      case 'running': return '🏃';
      case 'idle': return '🧍';
      case 'stopped': return '😴';
      case 'error': return '🤕';
      case 'starting': return '🚶';
      case 'stopping': return '🚶';
      default: return '🧍';
    }
  }

  private _statusView(session: SessionInfo): { key: string; label: string; detail?: string } {
    const attention = this.approvalAttentionForAgent(session.config.id);
    if (attention?.state === 'waiting') {
      return {
        key: 'consent-required',
        label: '🔐 Approval needed',
        detail: attention.actionSummary || 'Waiting for your approval',
      };
    }
    if (attention?.state === 'timed_out') {
      return { key: 'consent-timed-out', label: 'Denied — timed out', detail: 'The approval window closed without a decision.' };
    }
    const delegated = this.delegationStates.get(session.config.id);
    if (delegated?.status === 'working') {
      return {
        key: 'working',
        label: delegated.busyCount && delegated.busyCount > 1 ? `Working · ${delegated.busyCount} tasks` : 'Working',
        detail: `on ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'delegating') {
      return {
        key: 'delegating',
        label: `Delegating · ${delegated.busyCount ?? 1} out`,
        detail: 'accepting new instructions while teammates work',
      };
    }
    if (delegated?.completionState === 'partial' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'partial',
        label: 'Partial',
        detail: `unfinished ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'blocked') {
      return {
        key: 'blocked',
        label: 'Blocked',
        detail: `blocked on ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'cancelled' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'cancelled',
        label: 'Cancelled',
        detail: `cancelled ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'done' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'done',
        label: 'Done',
        detail: `finished ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'verified' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'verified',
        label: 'Verified',
        detail: `verified ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'no-applicable-sensor' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'no-applicable-sensor',
        label: 'No applicable sensor',
        detail: `no mechanical verification applied to ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'verification-failed' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'verification-failed',
        label: 'Verification failed',
        detail: `declared verification failed for ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'coordinator-accepted' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'coordinator-accepted',
        label: 'Coordinator accepted',
        detail: `coordinator accepted ${delegated.task || 'delegated task'}; this is not enterprise acceptance`,
      };
    }
    if (delegated?.status === 'coordinator-rejected' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'coordinator-rejected',
        label: 'Coordinator rejected — amended',
        detail: delegated.task || `a prior verdict for ${delegated.coordinatorName} was amended after rejection`,
      };
    }
    if (delegated?.status === 'human-intervention-required' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'human-intervention-required',
        label: 'Human intervention required',
        detail: delegated.task || `a human decision is required for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'tool-activity-recorded' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'tool-activity-recorded',
        label: 'Tool activity recorded',
        detail: `delivery not checked: ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'replied-not-verified' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'replied-not-verified',
        label: 'Replied, not verified',
        detail: `needs verification: ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'no-evidence' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'no-evidence',
        label: 'No evidence',
        detail: `no work evidence for ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'required-input-read-not-observed' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'required-input-read-not-observed',
        label: 'Required input read receipt not observed',
        detail: `host observed no read of a required input for ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (delegated?.status === 'timed-out' && isRecent(delegated.updatedAt, 120000)) {
      return {
        key: 'delegation-timed-out',
        label: 'Timed out',
        detail: `timed out waiting for ${delegated.task || 'delegated task'} for ${delegated.coordinatorName}`,
      };
    }
    if (session.status === 'error') {
      return { key: 'blocked', label: 'Blocked', detail: session.errorMessage };
    }
    if (session.status === 'running') {
      return {
        key: 'working',
        label: 'Working',
        detail: session.currentTask ? `on ${session.currentTask}` : undefined,
      };
    }
    if (session.status === 'idle') {
      return { key: 'idle', label: 'Idle' };
    }
    if (session.status === 'stopped') {
      return { key: 'stopped', label: 'Stopped' };
    }
    if (session.status === 'starting') {
      return { key: 'starting', label: 'Starting' };
    }
    if (session.status === 'consent_required') {
      return {
        key: 'consent-required',
        label: '🔐 Consent required',
        detail: session.consentMessage ?? 'Respond to the open UnodeAi network-consent dialog to continue this agent.',
      };
    }
    if (session.status === 'stopping') {
      return { key: 'stopping', label: 'Stopping' };
    }
    return { key: session.status, label: titleCase(session.status) };
  }

  /** Compact chip: just the agent's icon + a status-colored dot; click starts work with that agent.
   *  Name/role/status live in the tooltip. Frees vertical space for New Task. */
  private _renderCompactCard(session: SessionInfo): string {
    const config = session.config;
    const status = this._statusView(session);
    const id = escAttr(config.id);
    const row = toConsoleRows([session])[0];
    const meta = [row?.contextLabel, row?.costLabel, row?.turnsLabel].filter(Boolean).join(' · ');
    const tip = `${config.name} - ${config.role} - ${status.label}${status.detail ? ` - ${status.detail}` : ''}${meta ? ` - ${meta}` : ''}`;
    return /* html */`
      <button class="compact-card status-${status.key}" data-command="${status.key === 'consent-required' ? 'focusApproval' : 'chatAgent'}" data-agent-id="${id}"
              aria-label="${escAttr(`${config.name}, ${config.role}, ${status.label}${status.detail ? `, ${status.detail}` : ''}`)}"
              title="${escAttr(tip)}">
        ${renderAgentIcon(config.icon, 'compact-icon', 'RC')}
        <span class="status-dot"></span>
        <span class="status-marker status-${status.key}" aria-hidden="true">${this._statusMarker(status.key)}</span>
        ${status.key === 'consent-required' ? '<span class="approval-lock" aria-label="Consent required">🔐</span>' : ''}
      </button>`;
  }

  /** UX3 roster row: one line of navigation + status. The member's full detail (model, provider,
   *  live cost/turns/context, skills) and its controls expand in place, so the sidebar stays a roster
   *  while nothing about a team member is more than one click away. */
  private _renderSidebarRow(session: SessionInfo, changedFiles: ChangedFileSummary[] = []): string {
    const config = session.config;
    const status = this._statusView(session);
    const isWaiting = status.key === 'consent-required';
    const command = isWaiting ? 'focusApproval' : 'chatAgent';
    const responsibility = status.detail || (session.currentTask ? `on ${session.currentTask}` : config.role);
    const statusClass = isWaiting ? 'waiting' : status.key === 'consent-timed-out' ? 'timed-out' : '';
    const providerName = this.displayNameForProviderId(config.provider.providerId);
    const id = escAttr(config.id);

    const iconBtn = (cmd: string, glyph: string, label: string, danger = false): string =>
      `<button class="icon-btn${danger ? ' danger' : ''}" data-command="${cmd}" data-agent-id="${id}" title="${escAttr(label)}" aria-label="${escAttr(label)}">${glyph}</button>`;
    const actions = session.status === 'running' || session.status === 'idle'
      ? iconBtn('stopAgent', '⏹️', 'Stop') + iconBtn('restartAgent', '🔄', 'Restart') + iconBtn('editAgent', '⚙️', 'Configure') + iconBtn('showTerminal', '🖥️', 'Terminal')
      : session.status === 'stopped' || session.status === 'error'
        ? iconBtn('startAgent', '▶️', 'Start') + iconBtn('editAgent', '⚙️', 'Configure') + iconBtn('showTerminal', '🖥️', 'Terminal') + iconBtn('removeAgent', '🗑️', 'Remove', true)
        : `<button class="icon-btn" disabled title="Changing state…">…</button>`;

    // Live metrics carried over from the agent card: context %, cost, turns.
    const row = toConsoleRows([session])[0];
    const metrics = [
      row?.contextLabel ? { label: row.contextLabel, title: undefined } : undefined,
      row?.costLabel ? { label: row.costLabel, title: row.costTitle } : undefined,
      row?.turnsLabel ? { label: row.turnsLabel, title: undefined } : undefined,
    ].filter(Boolean) as Array<{ label: string; title?: string }>;
    const metricsHtml = metrics.length
      ? `<span class="inline-metrics">${metrics.map((m) => `<span class="metric"${m.title ? ` title="${escAttr(m.title)}"` : ''}>${esc(m.label)}</span>`).join('')}</span>`
      : '';
    const skillsHtml = (config.skills ?? [])
      .slice(0, 6)
      .map((s) => `<span class="skill-tag">${esc(s.name)}</span>`)
      .join('');
    const commandNarrowing = this.commandNarrowingSummary(config);

    return /* html */`
      <div class="session-item status-${status.key} ${statusClass}" data-agent-id="${id}">
        <div class="session-row">
          <button class="session-open" type="button" data-command="${command}" data-agent-id="${id}"
                  aria-label="${escAttr(`${config.name}, ${status.label}, ${responsibility}`)}"
                  title="${escAttr(`${config.name} — ${status.label}${status.detail ? ` — ${status.detail}` : ''} — ${isWaiting ? 'open the inline approval' : `open in the Workbench (${providerName})`}`)}">
            <span class="session-avatar">
              ${renderAgentIcon(config.icon, 'agent-icon', 'RC')}
              <span class="status-dot" aria-hidden="true"></span>
              ${isWaiting ? '<span class="approval-lock" aria-label="Approval needed">🔐</span>' : ''}
            </span>
            <span class="session-main">
              <span class="session-name">${esc(config.name)}</span>
              <span class="session-task">${esc(responsibility)}</span>
            </span>
          </button>
          <span class="session-trail">
            <span class="status-marker status-${status.key}" aria-hidden="true" title="${escAttr(status.label)}">${this._statusMarker(status.key)}</span>
            <span class="session-actions">${actions}</span>
          </span>
          <button class="session-expand" type="button" data-expand aria-expanded="false"
                  title="Details — model, provider, cost, turns, skills" aria-label="Details for ${escAttr(config.name)}">▾</button>
        </div>
        <div class="session-detail">
          <div class="agent-details">
            <span class="model-line">Model: ${esc(config.model)}${this._smartBadge(config)} ${metricsHtml}</span>
            <span title="${escAttr(config.provider.providerId)}">Provider: ${esc(providerName)}</span>
            <span>Role: ${esc(config.role)}</span>
            ${commandNarrowing ? `<span>${esc(commandNarrowing)}</span>` : ''}
            <span>Status: ${this._stateEmoji(status.key)} ${esc(status.label)}${status.detail ? ` — ${esc(status.detail)}` : ''}</span>
          </div>
          ${skillsHtml ? `<div class="skills-list">${skillsHtml}</div>` : ''}
          ${this._templateUpdateNotice(config, id)}
          ${this._renderFileActivity(changedFiles)}
        </div>
      </div>`;
  }

  /** Badge shown next to the model when Smart Mode is on: the TRUE model the agent will run (its provider's
   *  tier model), or a warning that it falls back to the configured model when no tier model is set. */
  private _smartBadge(config: { role: string; model: string; tier?: string; provider: { providerId: string } }): string {
    const sm = this.smartModePreview?.(config);
    const providerName = this.displayNameForProviderId(config.provider.providerId);
    if (!sm) {
      return ''; // Smart Mode off → just the configured model
    }
    if (sm.model && sm.model !== config.model) {
      return ` <span class="smart-badge" title="Smart Mode on — runs the ${esc(sm.tier)} tier model on ${esc(providerName)}">⚡ Smart → ${esc(sm.model)}</span>`;
    }
    if (sm.model) {
      return ` <span class="smart-badge" title="Smart Mode on — ${esc(sm.tier)} tier resolves to the configured model">⚡ Smart</span>`;
    }
    return ` <span class="smart-badge warn" title="Smart Mode on, but no ${esc(sm.tier)} model is set for ${esc(providerName)} — runs the configured model">⚡ Smart (configured)</span>`;
  }

  /** A compact non-colour state marker for the roster row and 18px compact chip. */
  private _statusMarker(status: string): string {
    switch (status) {
      case 'working': return '…';
      case 'delegating': return '↗';
      case 'done': return '✓';
      case 'partial': return '◐';
      case 'verified': return 'V';
      case 'no-applicable-sensor': return '—';
      case 'verification-failed': return '!';
      case 'tool-activity-recorded': return '…';
      case 'replied-not-verified': return '↩';
      case 'no-evidence': return '!';
      case 'delegation-timed-out': return '!';
      case 'coordinator-accepted': return '✓';
      case 'coordinator-rejected': return '!';
      case 'human-intervention-required': return '!';
      case 'blocked': return '×';
      case 'idle': return '○';
      case 'stopped': return '■';
      case 'starting':
      case 'stopping': return '…';
      case 'consent-required': return '🔒';
      case 'consent-timed-out': return '⌛';
      default: return '•';
    }
  }

  /** One quiet per-agent cue; Agent Builder holds the template-only diff and explicit choices. */
  private _templateUpdateNotice(config: SessionInfo['config'], id: string): string {
    const prompt = promptTemplateStatus(config);
    if ((prompt.state !== 'custom-outdated' && prompt.state !== 'custom-origin-unknown') || !prompt.showUpdateNotice) {
      return '';
    }
    const label = prompt.state === 'custom-origin-unknown'
      ? 'Default guidance may have changed — review options'
      : 'Default guidance updated — review changes';
    return `<button class="template-update" data-command="editAgent" data-agent-id="${id}">${label}</button>`;
  }

  /** Per-agent "recently changed files" (from checkpoints), each click-through to a read-only diff. */
  private _renderFileActivity(changedFiles: ChangedFileSummary[]): string {
    if (changedFiles.length === 0) {
      return '';
    }
    return /* html */`
      <div class="file-activity">
        <div class="file-activity-title">📝 Changed files</div>
        <div class="file-activity-list">
          ${changedFiles.map((file) => `
            <button class="file-activity-item" data-command="showCheckpointDiff"
                    data-checkpoint-id="${escAttr(String(file.checkpointId))}"
                    title="${escAttr(file.path)}">📝 ${esc(file.path)}</button>
          `).join('')}
        </div>
      </div>`;
  }

  private _renderEmptyState(): string {
    return /* html */`
      <div class="empty-state">
        <p>No agents in your team yet.</p>
        <div class="empty-grid">
          <button class="empty-card" data-command="createDefaultTeam">
            <span class="empty-title">Create a Team</span>
            <span class="empty-copy">Pick a software crew or a knowledge-work team (PM + specialists)</span>
          </button>
          <button class="empty-card" data-command="openAgentBuilder">
            <span class="empty-title">Build an Agent</span>
            <span class="empty-copy">Compose a custom role with model, tools, playbooks, and MCP grants</span>
          </button>
          <button class="empty-card" data-command="runDemoTask">
            <span class="empty-title">Run Demo Task</span>
            <span class="empty-copy">See UnodeAi in action with a pre-built task</span>
          </button>
          <button class="empty-card" data-command="openDocumentation">
            <span class="empty-title">Open Documentation</span>
            <span class="empty-copy">Learn about agents, teams, and workflows</span>
          </button>
        </div>
        <button class="btn" style="margin-top:12px" data-command="addAgent">Add a single agent</button>
      </div>`;
  }

  private async openDocumentation(): Promise<void> {
    const uri = vscode.Uri.joinPath(this._extensionUri, 'USAGE.md');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
      viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
    });
  }
}

function isTeamMessage(msg: unknown, agentIds: string[]): msg is { command: string; agentId?: string; checkpointId?: number } {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const command = (msg as { command?: unknown }).command;
  const agentId = (msg as { agentId?: unknown }).agentId;
  const checkpointId = (msg as { checkpointId?: unknown }).checkpointId;
  const globalCommands = new Set([
    'sendMessage',
    'createDefaultTeam',
    'addAgent',
    'openAgentBuilder',
    'openMarketplace',
    'openSettings',
    'showSecurity',
    'newTask',
    'openWorkbench',
    'createTeamPreset',
    'editTeamRules',
    'restoreCheckpoint',
    'startAllAgents',
    'stopAllAgents',
    'startSolo',
    'startSoloActive',
    'runDemoTask',
    'openDocumentation',
  ]);
  const agentCommands = new Set(['startAgent', 'stopAgent', 'restartAgent', 'removeAgent', 'showOutput', 'showTerminal', 'editAgent', 'chatAgent', 'openAgentWorkbench', 'focusApproval']);
  if (typeof command !== 'string') {
    return false;
  }
  if (globalCommands.has(command)) {
    return true;
  }
  if (command === 'showCheckpointDiff') {
    return typeof checkpointId === 'number' && Number.isFinite(checkpointId);
  }
  return agentCommands.has(command) && typeof agentId === 'string' && agentIds.includes(agentId);
}

function isRecent(timestamp: string, maxAgeMs: number): boolean {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
}

function titleCase(value: string): string {
  if (!value) {
    return 'Unknown';
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
