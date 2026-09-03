/*---------------------------------------------------------------------------------------------
 *  UnodeAi - WorktreePanel (worktree fan-out review board, v1)
 *  Surfaces the parallel-crew state the fan-out feature creates: each agent's isolation lane (its
 *  worktree + branch), what's staged on the integration branch vs your base, and a one-click
 *  Finalize → your branch. This is the "review the PR from your crew" moment.
 *
 *  Renderer-only: the extension supplies a `load()` snapshot + an `onFinalize()` handler (which runs
 *  the WorktreeCoordinator). Phase 2: per-file/inline diffs in the lanes.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { csp, esc, escAttr, nonce } from './webviewSecurity';

/** v0.7.0 verifier-as-gate: a lane's verification state for the review board. */
export interface LaneVerification {
  status: 'passed' | 'failed' | 'skipped';
  command: string;
  output: string;
  /** Anti-cheat: test files this PASSING change also modified (passing by weakening tests, not fixing
   *  code). Present ⇒ the lane is flagged "verified, but review the test changes". */
  touchedTests?: string[];
}

export interface WorktreeReview {
  base: string;
  integrationBranch: string;
  hasIntegration: boolean;
  lanes: { agentId: string; agent: string; branch: string; path: string; verification?: LaneVerification; changedFiles?: string[] }[];
  integrationFiles: string[];
}

export type WorktreeReviewLoader = () => Promise<WorktreeReview>;
export type WorktreeFinalizeHandler = () => Promise<{ ok: boolean; message: string }>;
export type WorktreeLaneAction =
  | { command: 'openLaneDiff'; agentId: string; file?: string }
  | { command: 'reverifyLane'; agentId: string }
  | { command: 'handBackLane'; agentId: string };
export type WorktreeLaneActionHandler = (action: WorktreeLaneAction) => Promise<void> | void;

const EMPTY: WorktreeReview = { base: '', integrationBranch: 'unode/integration', hasIntegration: false, lanes: [], integrationFiles: [] };

export class WorktreePanel {
  public static current: WorktreePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private review: WorktreeReview = EMPTY;

  static createOrShow(
    extensionUri: vscode.Uri,
    load: WorktreeReviewLoader,
    onFinalize: WorktreeFinalizeHandler,
    onLaneAction?: WorktreeLaneActionHandler
  ): void {
    if (WorktreePanel.current) {
      WorktreePanel.current.load = load;
      WorktreePanel.current.onFinalize = onFinalize;
      WorktreePanel.current.onLaneAction = onLaneAction;
      WorktreePanel.current.panel.reveal();
      void WorktreePanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeWorktrees',
      'UnodeAi — Crew Worktrees',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    WorktreePanel.current = new WorktreePanel(panel, load, onFinalize, onLaneAction);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private load: WorktreeReviewLoader,
    private onFinalize: WorktreeFinalizeHandler,
    private onLaneAction?: WorktreeLaneActionHandler
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => { WorktreePanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    void this.render();
  }

  private async render(): Promise<void> {
    try {
      this.review = await this.load();
    } catch (err) {
      this.review = EMPTY;
      void vscode.window.showWarningMessage(`UnodeAi: couldn't read worktree state — ${String(err)}`);
    }
    this.panel.webview.html = renderHtml(this.panel.webview, this.review);
  }

  public update(review: WorktreeReview): void {
    this.review = review;
    this.panel.webview.html = renderHtml(this.panel.webview, this.review);
  }

  private onMessage(msg: { command?: unknown; agentId?: unknown; file?: unknown }): void {
    if (!msg) {
      return;
    }
    if (msg.command !== 'finalize') {
      const action = parseLaneAction(msg);
      if (!action) {
        return;
      }
      void Promise.resolve(this.onLaneAction?.(action)).catch((err) => {
        void vscode.window.showErrorMessage(`UnodeAi: lane action failed - ${String(err)}`);
      });
      return;
    }
    void this.onFinalize().then((result) => {
      const show = result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void show(`UnodeAi: ${result.message}`);
      void this.render(); // refresh after a finalize (integration drains into base)
    }, (err) => {
      void vscode.window.showErrorMessage(`UnodeAi: finalize failed — ${String(err)}`);
    });
  }
}

function parseLaneAction(msg: { command?: unknown; agentId?: unknown; file?: unknown }): WorktreeLaneAction | undefined {
  if (typeof msg.agentId !== 'string' || msg.agentId === '') {
    return undefined;
  }
  if (msg.command === 'openLaneDiff') {
    return typeof msg.file === 'string' && msg.file !== ''
      ? { command: 'openLaneDiff', agentId: msg.agentId, file: msg.file }
      : { command: 'openLaneDiff', agentId: msg.agentId };
  }
  if (msg.command === 'reverifyLane') {
    return { command: 'reverifyLane', agentId: msg.agentId };
  }
  if (msg.command === 'handBackLane') {
    return { command: 'handBackLane', agentId: msg.agentId };
  }
  return undefined;
}

function verificationView(v?: LaneVerification, detailId?: string): string {
  if (!v || v.status === 'skipped') {
    return /* html */`<div class="verification unverified">
      <div class="verify-head">
        <span class="vmark">⚠</span>
        <span class="vtext">Unverified</span>
      </div>
      <div class="verify-note">No verification result yet. This lane has not been gated.</div>
    </div>`;
  }
  if (v.status === 'passed') {
    // Anti-cheat: a passing lane that also edited the tests is NOT clean green — surface it so the
    // reviewer checks whether the tests were weakened to pass instead of the code being fixed.
    const tampered = v.touchedTests && v.touchedTests.length > 0;
    if (tampered) {
      return /* html */`<div class="verification tampered" title="${escAttr(v.command)} passed, but this change edited test files">
        <div class="verify-head">
          <span class="vmark">⚠</span>
          <span class="vtext">Verified · review tests</span>
        </div>
        <div class="verify-note"><code>${esc(v.command)}</code> passed, but this change <strong>also modified test files</strong> — confirm the code was fixed, not the tests weakened to pass:</div>
        <ul class="verify-tests">${v.touchedTests!.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      </div>`;
    }
    return /* html */`<div class="verification passed" title="${escAttr(v.command)} passed">
      <div class="verify-head">
        <span class="vmark">✓</span>
        <span class="vtext">Verified</span>
      </div>
      <div class="verify-note"><code>${esc(v.command)}</code> passed.</div>
    </div>`;
  }
  const output = v.output.trim() || '(no failing output captured)';
  return /* html */`<div class="verification failed" title="${escAttr(v.command)} failed; held off integration">
    <div class="verify-head">
      <span class="vmark">✗</span>
      <span class="vtext">Failing</span>
    </div>
    <div class="verify-note"><code>${esc(v.command)}</code> failed. Held off integration until this lane verifies.</div>
    <details class="verify-output" data-detail-id="${escAttr(detailId ?? 'verify-output')}">
      <summary>Failing output</summary>
      <pre>${esc(output)}</pre>
    </details>
  </div>`;
}

function renderLane(l: WorktreeReview['lanes'][number]): string {
  const tampered = l.verification?.status === 'passed' && !!l.verification.touchedTests?.length;
  const needsAction = l.verification?.status === 'failed' || tampered;
  const changedFiles = (l.changedFiles ?? []).filter((f) => f.trim() !== '');
  const changedFilesHtml = changedFiles.length > 0
    ? /* html */`<div class="lane-files" aria-label="Changed files">
        <div class="lane-files-title">Changed files</div>
        ${changedFiles.map((file) => /* html */`
          <button class="file-link" type="button" data-lane-command="openLaneDiff" data-agent-id="${escAttr(l.agentId)}" data-file="${escAttr(file)}">${esc(file)}</button>
        `).join('')}
      </div>`
    : '';
  return /* html */`<article class="lane ${tampered ? 'tampered-lane' : l.verification?.status ?? 'unverified'}">
    <div class="lane-main">
      <div class="agent">${esc(l.agent)}</div>
      <div class="branch">${esc(l.branch)}</div>
      ${changedFilesHtml}
      <div class="lane-actions">
        <button class="btn secondary" type="button" data-lane-command="openLaneDiff" data-agent-id="${escAttr(l.agentId)}">View diff</button>
        ${needsAction ? `<button class="btn secondary" type="button" data-lane-command="reverifyLane" data-agent-id="${escAttr(l.agentId)}">Re-verify</button>` : ''}
        ${needsAction ? `<button class="btn secondary" type="button" data-lane-command="handBackLane" data-agent-id="${escAttr(l.agentId)}">Hand back</button>` : ''}
      </div>
    </div>
    ${verificationView(l.verification, `verify-output:${l.agentId}`)}
  </article>`;
}

export function renderHtml(webview: vscode.Webview, r: WorktreeReview): string {
  const scriptNonce = nonce();
  const canFinalize = r.hasIntegration && r.integrationFiles.length > 0;
  return /* html */`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <style>
    * { box-sizing: border-box; }
    body { margin:0; padding:18px; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family,sans-serif); font-size:var(--vscode-font-size,13px); }
    h1 { margin:0 0 4px; font-size:18px; }
    .sub { color:var(--vscode-descriptionForeground); margin-bottom:16px; }
    .section-title { font-weight:700; text-transform:uppercase; letter-spacing:.4px; font-size:11px; color:var(--vscode-descriptionForeground); margin:18px 0 8px; }
    .lane { display:grid; grid-template-columns:minmax(0, 1fr) minmax(220px, 42%); gap:12px; align-items:start; padding:12px; border:1px solid var(--vscode-panel-border); border-radius:8px; margin-bottom:8px; background:var(--vscode-sideBar-background, transparent); }
    .lane.failed { border-color:var(--vscode-testing-iconFailed,#f85149); }
    .lane-main { min-width:0; }
    .lane .agent { font-weight:700; margin-bottom:3px; }
    .lane .branch { color:var(--vscode-descriptionForeground); font-family:var(--vscode-editor-font-family,monospace); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lane-files { margin-top:10px; display:flex; flex-direction:column; gap:3px; min-width:0; }
    .lane-files-title { color:var(--vscode-descriptionForeground); font-size:11px; text-transform:uppercase; letter-spacing:.3px; font-weight:700; }
    .file-link { width:100%; display:block; border:0; padding:2px 0; color:var(--vscode-textLink-foreground); background:transparent; cursor:pointer; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .file-link:hover { text-decoration:underline; }
    .lane-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .verification { border-left:3px solid var(--vscode-panel-border); padding-left:10px; min-width:0; }
    .verification.passed { border-left-color:var(--vscode-testing-iconPassed,#3fb950); }
    .verification.failed { border-left-color:var(--vscode-testing-iconFailed,#f85149); }
    .verification.unverified { border-left-color:var(--vscode-descriptionForeground); }
    .verification.tampered { border-left-color:var(--vscode-editorWarning-foreground,#cca700); }
    .tampered .verify-head { color:var(--vscode-editorWarning-foreground,#cca700); }
    .verify-tests { margin:6px 0 0; padding-left:18px; color:var(--vscode-descriptionForeground); font-family:var(--vscode-editor-font-family,monospace); font-size:12px; }
    .verify-head { display:flex; align-items:center; gap:6px; font-weight:800; text-transform:uppercase; letter-spacing:.3px; font-size:12px; }
    .vmark { display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; border-radius:50%; border:1px solid currentColor; font-weight:800; line-height:1; }
    .passed .verify-head { color:var(--vscode-testing-iconPassed,#3fb950); }
    .failed .verify-head { color:var(--vscode-testing-iconFailed,#f85149); }
    .unverified .verify-head { color:var(--vscode-descriptionForeground); }
    .verify-note { margin-top:5px; color:var(--vscode-descriptionForeground); line-height:1.35; }
    .verify-output { margin-top:8px; }
    .verify-output summary { cursor:pointer; color:var(--vscode-textLink-foreground); font-weight:600; }
    .verify-output pre { max-height:220px; overflow:auto; margin:8px 0 0; padding:10px; border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-textCodeBlock-background); color:var(--vscode-editor-foreground); font-family:var(--vscode-editor-font-family,monospace); font-size:12px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
    .files { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:10px; }
    .file { font-family:var(--vscode-editor-font-family,monospace); font-size:12px; line-height:1.6; }
    .empty { color:var(--vscode-descriptionForeground); padding:14px 0; }
    .actions { margin-top:18px; }
    .btn { min-height:30px; padding:6px 14px; border:0; border-radius:5px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; font-weight:600; }
    .btn.secondary { min-height:26px; padding:4px 9px; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
    .btn:hover { background:var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity:.5; cursor:default; }
    code { background:var(--vscode-textCodeBlock-background); padding:1px 5px; border-radius:3px; }
    @media (max-width: 620px) {
      .lane { grid-template-columns:1fr; }
      .verification { border-left:0; border-top:3px solid var(--vscode-panel-border); padding:10px 0 0; }
      .verification.passed { border-top-color:var(--vscode-testing-iconPassed,#3fb950); }
      .verification.failed { border-top-color:var(--vscode-testing-iconFailed,#f85149); }
      .verification.unverified { border-top-color:var(--vscode-descriptionForeground); }
    }
  </style>
</head><body>
  <h1>Crew Worktrees</h1>
  <div class="sub">Each agent works isolated in its own git worktree; finished work is staged on <code>${esc(r.integrationBranch)}</code> for review before it lands on <code>${esc(r.base || 'your branch')}</code>.</div>

  <div class="section-title">Isolation lanes (${r.lanes.length})</div>
  ${r.lanes.length === 0
    ? `<div class="empty">No agents are isolated right now. Enable worktree mode (<code>unode.concurrencyStrategy</code> = <code>worktree</code>) and start a team.</div>`
    : r.lanes.map(renderLane).join('')}

  <div class="section-title">Staged for review → ${esc(r.base || 'base')} (${r.integrationFiles.length} file${r.integrationFiles.length === 1 ? '' : 's'})</div>
  ${canFinalize
    ? `<div class="files">${r.integrationFiles.map((f) => `<div class="file">${esc(f)}</div>`).join('')}</div>`
    : `<div class="empty">Nothing staged yet — failed lanes are held on their own branches until verification passes.</div>`}

  <div class="actions">
    <button class="btn" id="finalize" ${canFinalize ? '' : 'disabled'}>Finalize → ${esc(r.base || 'your branch')}</button>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('finalize');
    function savedState() {
      try { return vscode.getState() || {}; } catch { return {}; }
    }
    function saveViewState() {
      const details = {};
      document.querySelectorAll('details[data-detail-id]').forEach((node) => { details[node.dataset.detailId] = node.open; });
      try { vscode.setState({ ...savedState(), scrollY: window.scrollY, details }); } catch {}
    }
    const state = savedState();
    if (state.details) {
      document.querySelectorAll('details[data-detail-id]').forEach((node) => {
        if (Object.prototype.hasOwnProperty.call(state.details, node.dataset.detailId)) {
          node.open = !!state.details[node.dataset.detailId];
        }
      });
    }
    if (typeof state.scrollY === 'number') {
      requestAnimationFrame(() => window.scrollTo(0, state.scrollY));
    }
    window.addEventListener('scroll', saveViewState, { passive: true });
    document.querySelectorAll('details[data-detail-id]').forEach((node) => node.addEventListener('toggle', saveViewState));
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-lane-command]');
      if (!action) return;
      const command = action.dataset.laneCommand;
      const agentId = action.dataset.agentId;
      if (!command || !agentId) return;
      const message = action.dataset.file ? { command, agentId, file: action.dataset.file } : { command, agentId };
      if (command === 'reverifyLane' || command === 'handBackLane') {
        action.disabled = true;
      }
      saveViewState();
      vscode.postMessage(message);
    });
    if (btn) btn.addEventListener('click', () => { btn.disabled = true; btn.textContent = 'Finalizing…'; vscode.postMessage({ command: 'finalize' }); });
  </script>
</body></html>`;
}
