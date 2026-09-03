/*---------------------------------------------------------------------------------------------
 *  UnodeAi - DashboardProvider
 *  Full webview dashboard showing team overview, message stats, workflow status, and mission lanes.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager, TaskTokenRecord } from '../session/SessionManager';
import { MessageBus } from '../bus/MessageBus';
import { SessionInfo } from '../types';
import { csp, esc, escAttr } from './webviewSecurity';
import { contextLabel } from './contextLabel';
import { DelegationAgentState } from './orchestrationProgress';
import { WorktreeReview } from './WorktreePanel';

export interface DashboardProviderDeps {
  agentStates?: () => DelegationAgentState[];
  filesByAgent?: () => Map<string, string[]>;
  worktreeReview?: () => Promise<WorktreeReview | undefined>;
  /** How many recent tasks the "Latest tasks" panel shows (user-settable from the dashboard). */
  recentTaskCount?: () => number;
  /** Current concurrency strategy ('optimistic' | 'worktree') for the dashboard status line. */
  concurrencyMode?: () => string;
}

/** Selectable sizes for the "Latest tasks" panel (the dashboard's N control). */
export const RECENT_TASK_COUNT_OPTIONS = [3, 5, 10, 20] as const;

interface DashboardLaneRenderState {
  agentStates?: DelegationAgentState[];
  filesByAgent?: Map<string, string[]>;
  worktreeReview?: WorktreeReview;
}

export class DashboardProvider {
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private sessionManager: SessionManager,
    private messageBus: MessageBus,
    private readonly deps: DashboardProviderDeps = {}
  ) { }

  async getDashboardHtml(webview: vscode.Webview): Promise<string> {
    const sessions = this.sessionManager.getAll();
    const running = sessions.filter((s) => s.status === 'running' || s.status === 'idle').length;
    const total = sessions.length;
    const messageCount = this.messageBus.getMessageCount();
    const completedUsage = sessions.map((s) => s.usage).filter((usage): usage is NonNullable<SessionInfo['usage']> => (usage?.turns ?? 0) > 0);
    const billedCost = completedUsage
      .filter((usage) => usage.costBasis === 'billed')
      .reduce((sum, usage) => sum + usage.costUsd, 0);
    const apiEquivalentCost = completedUsage
      .filter((usage) => usage.costBasis === 'api-equivalent')
      .reduce((sum, usage) => sum + usage.costUsd, 0);
    const hasBilledCost = completedUsage.some((usage) => usage.costBasis === 'billed');
    const hasApiEquivalentCost = completedUsage.some((usage) => usage.costBasis === 'api-equivalent');
    const hasUnknownCost = completedUsage.some((usage) => !usage.costBasis);
    const totalCost = billedCost + apiEquivalentCost;
    const costSummary = [
      hasBilledCost ? `$${billedCost.toFixed(2)} billed` : '',
      hasApiEquivalentCost ? `~$${apiEquivalentCost.toFixed(2)} API-equivalent` : '',
      hasUnknownCost ? 'cost unknown' : '',
    ].filter(Boolean).join(' + ') || 'cost unknown';
    const costTitle = hasUnknownCost
      ? 'At least one completed turn has no observed cost basis; it is not represented as $0.'
      : hasApiEquivalentCost
        ? 'API-equivalent cost is a subscription-usage estimate, not a billed per-token invoice.'
        : 'Billed cost.';
    const totalTokens = sessions.reduce(
      (sum, s) => sum + (s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0),
      0
    );
    // Prefix-cache hit rate. Cached input costs ~1/10, so this is most of why the bill is what it is — and
    // until now it was invisible. Undefined on every session = the gateway told us nothing; show nothing
    // rather than a fabricated "0%".
    const totalInput = sessions.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0);
    const totalOutput = sessions.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);
    const anyCacheReported = sessions.some((s) => s.usage?.cachedInputTokens !== undefined);
    const totalCached = sessions.reduce((sum, s) => sum + (s.usage?.cachedInputTokens ?? 0), 0);
    const cacheHitPct = anyCacheReported && totalInput > 0 ? (totalCached / totalInput) * 100 : undefined;
    // Some gateway on this team did not report its usage honestly, so these figures were RECONSTRUCTED. We
    // lean them high on purpose — under-reporting a bill is worse than over-reporting one — but a
    // reconstruction is an estimate, not an invoice, and it must not be shown as one.
    const tokensEstimated = sessions.some((s) => s.usage?.estimated === true);
    const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    // Cost arbitrage proof: what the same work would have cost if every turn ran on a top-tier model,
    // vs what mixed routing actually cost. premiumCostUsd accrues from this build forward.
    const totalPremiumCost = sessions.reduce((sum, s) => sum + (s.usage?.premiumCostUsd ?? s.usage?.costUsd ?? 0), 0);
    // Honest delta: >0 = mixed routing was cheaper (saved), <0 = it was pricier. Don't clamp — show the truth.
    const costDelta = totalPremiumCost - totalCost;
    const deltaPct = totalPremiumCost > 0 ? (Math.abs(costDelta) / totalPremiumCost) * 100 : 0;
    const showSavings = totalTokens > 0 && !hasApiEquivalentCost && !hasUnknownCost && Math.abs(costDelta) > 0.0001;
    const saved = costDelta >= 0;

    const laneBoard = renderMissionControlLanes(sessions, {
      agentStates: this.deps.agentStates?.() ?? [],
      filesByAgent: this.deps.filesByAgent?.() ?? new Map(),
      worktreeReview: await this.deps.worktreeReview?.(),
    });
    // A bounded timeline has no per-sample cost basis. Never present a mixed
    // billed/API-equivalent history as one dollar-denominated "spend" trend.
    const trendSvg = hasApiEquivalentCost || hasUnknownCost
      ? '<div class="empty">Cost trend is available only when every completed turn has a billed cost basis. API-equivalent and unknown costs remain separate above.</div>'
      : this._renderCostTrend();
    const ranking = this._renderAgentRanking(sessions);
    const providerDist = this._renderProviderDistribution(sessions);
    const taskCount = Math.max(1, Math.floor(this.deps.recentTaskCount?.() ?? 5));
    const recentTasks = this._renderRecentTasks(this.sessionManager.getRecentTaskTokens(taskCount), taskCount);
    const concurrency = (this.deps.concurrencyMode?.() ?? 'optimistic') === 'worktree'
      ? '⎇ Worktree — each agent works in its own isolated git worktree'
      : '⚙ Optimistic — agents share this workspace folder';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      padding: 24px;
      background: var(--vscode-editor-background);
    }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; font-size: 13px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .savings-banner {
      margin: -10px 0 24px;
      padding: 12px 16px;
      border: 1px solid color-mix(in srgb, var(--vscode-charts-green) 40%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-charts-green) 10%, transparent);
    }
    .savings-head { font-size: 15px; }
    .savings-head b { color: var(--vscode-charts-green); }
    .savings-banner.over { border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 67%, transparent); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 9%, transparent); }
    .savings-banner.over .savings-head b { color: var(--vscode-editorWarning-foreground); }
    .savings-pct { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .savings-detail { margin-top: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .stat-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .stat-value { font-size: 28px; font-weight: 700; }
    .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 4px; }
    .stat-breakdown { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 5px;
      font-size: 11px; color: var(--vscode-descriptionForeground); }
    .stat-breakdown .cached { color: var(--vscode-charts-green, #28a745); }
    /* "not reported" must not read as a healthy zero — it means we are BLIND, which is a different problem. */
    .stat-breakdown .cached.unknown { color: var(--vscode-inputValidation-warningForeground, #b58100); font-style: italic; }
    .stat-running { color: var(--vscode-charts-green); }
    .empty { text-align: center; padding: 24px; color: var(--vscode-descriptionForeground); }
    .mission-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 10px;
    }
    .mission-title { font-size: 15px; font-weight: 800; }
    .mission-sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; }
    .mission-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .cmd-link {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-radius: 5px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
    }
    .cmd-link:hover { background: var(--vscode-button-hoverBackground); }
    .cmd-link.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .cmd-link.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .lane-board {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
      background: var(--vscode-input-background);
    }
    .lane-head,
    .lane-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.3fr) 94px minmax(200px, 2fr) 86px 86px 92px minmax(130px, .9fr) 120px;
      gap: 10px;
      align-items: center;
    }
    .lane-board.no-worktree .lane-head,
    .lane-board.no-worktree .lane-row {
      grid-template-columns: minmax(180px, 1.3fr) 94px minmax(200px, 2fr) 86px 86px 92px 120px;
    }
    .lane-head {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, transparent);
    }
    .lane-row {
      min-height: 64px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .lane-row:last-child { border-bottom: 0; }
    .agent-cell { min-width: 0; display: flex; align-items: center; gap: 9px; }
    .agent-icon { width: 26px; height: 26px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; background: var(--vscode-editor-background); font-size: 16px; overflow: hidden; }
    .agent-icon img { width: 100%; height: 100%; object-fit: cover; }
    .agent-name { font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-role { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: capitalize; }
    .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .lane-working .status-dot { background: var(--vscode-charts-green); }
    .lane-idle .status-dot { background: var(--vscode-charts-yellow); }
    .lane-done .status-dot { background: var(--vscode-testing-iconPassed, #3fb950); }
    .lane-blocked .status-dot, .lane-error .status-dot { background: var(--vscode-testing-iconFailed, #dc3545); }
    .lane-stopped .status-dot { background: var(--vscode-descriptionForeground); }
    .task-cell { min-width: 0; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-muted { color: var(--vscode-descriptionForeground); }
    .metric { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .files-cell { min-width: 0; }
    .files-count { font-weight: 800; }
    .files-list { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .verify-badge { display: inline-flex; max-width: 100%; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .verify-passed { color: var(--vscode-testing-iconPassed, #3fb950); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 13%, transparent); }
    .verify-failed { color: var(--vscode-testing-iconFailed, #dc3545); background: color-mix(in srgb, var(--vscode-testing-iconFailed, #dc3545) 13%, transparent); }
    .verify-skipped, .verify-missing { color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .lane-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
    .lane-empty { padding: 22px; text-align: center; color: var(--vscode-descriptionForeground); }
    .lane-empty a { color: var(--vscode-textLink-foreground); text-decoration: none; font-weight: 700; }
    .lane-empty a:hover { text-decoration: underline; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .panel {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
    }
    .panel.wide { grid-column: 1 / -1; }
    .panel h3 { font-size: 13px; margin-bottom: 12px; }
    .panel .empty { padding: 8px; text-align: left; }
    .bar-row { display: grid; grid-template-columns: 130px 1fr 70px; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
    .bar-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar-track { background: var(--vscode-panel-border); border-radius: 4px; height: 10px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--vscode-charts-purple); border-radius: 4px; }
    .bar-fill.tok { background: var(--vscode-charts-green); }
    .bar-value { text-align: right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .trend-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .task-ctl { float: right; font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); }
    .task-ctl a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .task-ctl b { color: var(--vscode-foreground); }
    .task-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .task-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; }
    .task-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 8px; }
    .task-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .task-total { white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
    .task-approval { margin: -2px 0 7px; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
    @media (max-width: 980px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .panels { grid-template-columns: 1fr; }
      .mission-header { align-items: flex-start; flex-direction: column; }
      .lane-head { display: none; }
      .lane-row, .lane-board.no-worktree .lane-row {
        grid-template-columns: 1fr;
        gap: 7px;
        align-items: start;
      }
      .lane-actions { justify-content: flex-start; }
      .metric::before, .files-cell::before {
        display: inline-block;
        min-width: 68px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .files-cell::before { content: "Files"; }
      .context-cell::before { content: "Context"; }
      .cost-cell::before { content: "Cost"; }
      .verify-cell::before { content: "Verify"; }
    }
    .footer { margin-top: 24px; font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  <h1>UnodeAi Dashboard</h1>
  <p class="subtitle">Multi-Agent AI Team Management</p>
  <p class="subtitle" title="Concurrency mode — change it from the chip in the Team panel or Settings → unode.concurrencyStrategy">Concurrency: ${concurrency}</p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total Agents</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-running">${running}</div>
      <div class="stat-label">Active Agents</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${messageCount}</div>
      <div class="stat-label">Messages</div>
    </div>
    <div class="stat-card">
      <div class="stat-value"${tokensEstimated ? ' title="Reconstructed, not reported — see the breakdown below."' : ''}>${tokensEstimated ? '~' : ''}${(totalTokens / 1000).toFixed(1)}k</div>
      <div class="stat-label">Tokens${tokensEstimated ? ' <span class="cached unknown" title="At least one gateway on this team does not report usage honestly: it relays Anthropic&#39;s `input_tokens` (the part of the prompt that MISSED the cache) as if it were the whole prompt, or streams no usage at all. UnodeAi reconstructs the real figures and deliberately leans them HIGH — under-reporting a bill is worse than over-reporting it — but a reconstruction is an estimate, not an invoice. Ask the gateway to map cache_read_input_tokens into prompt_tokens_details.cached_tokens and these become exact.">estimated</span>' : ''}</div>
      <div class="stat-breakdown">
        <span title="Prompt tokens sent to the model. Inclusive of anything served from cache.">in ${fmtTok(totalInput)}</span>
        <span title="Tokens the model generated. Output is 3-5x the price of input on most models.">out ${fmtTok(totalOutput)}</span>
        ${cacheHitPct !== undefined
          ? `<span class="cached" title="Input tokens served from the provider's prefix cache — a SUBSET of 'in', not an addition. Upstream a cache hit costs a fraction of a fresh token, but the gateway only passes that discount on for models it has a cache ratio configured for, so a high hit rate does not automatically mean a smaller bill.">cached ${fmtTok(totalCached)} (${cacheHitPct.toFixed(0)}%)</span>`
          : `<span class="cached unknown" title="No provider on this team reported a cache-hit field (prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens / cache_read_input_tokens). That is NOT the same as a 0% hit rate — it means we cannot see the hit rate at all, so we cannot tell whether the prompt prefix is being cached or re-billed in full every turn.">cached: not reported</span>`}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-value" title="${escAttr(costTitle)}">${esc(costSummary)}</div>
      <div class="stat-label">Cost basis</div>
    </div>
  </div>
  ${showSavings ? `
  <div class="savings-banner${saved ? '' : ' over'}">
    <div class="savings-head">${saved
      ? `Mixed-model routing saved you <b>$${costDelta.toFixed(2)}</b> <span class="savings-pct">(${deltaPct.toFixed(0)}% off)</span>`
      : `Mixed-model routing cost <b>$${(-costDelta).toFixed(2)}</b> more <span class="savings-pct">(${deltaPct.toFixed(0)}% over the all-premium baseline)</span>`}</div>
    <div class="savings-detail" title="${escAttr(costTitle)}">All-premium baseline (every turn on a top-tier model): <b>$${totalPremiumCost.toFixed(2)}</b> &nbsp;|&nbsp; your mixed routing: <b>$${totalCost.toFixed(2)}</b></div>
  </div>` : ''}

  <div class="mission-header">
    <div>
      <div class="mission-title">Team activity</div>
      <div class="mission-sub">See who is doing what, where it is stuck, and whether it can land.</div>
    </div>
    <div class="mission-actions">
      <a class="cmd-link" href="command:unode.generateEvidenceReport">Evidence Report</a>
      <a class="cmd-link secondary" href="command:unode.openChat">New Task</a>
    </div>
  </div>
  ${laneBoard}

  <div class="panels">
    <div class="panel wide">
      <h3>Cost Trend</h3>
      ${trendSvg}
    </div>
    <div class="panel">
      <h3>Cost by Agent</h3>
      ${ranking}
    </div>
    <div class="panel">
      <h3>Provider Distribution</h3>
      ${providerDist}
    </div>
  </div>

  ${recentTasks}

  <div class="footer">
    UnodeAi &bull; Multi-model AI team for VS Code &bull; Bring your own model provider
  </div>
</body>
</html>`;
  }

  /** Cumulative-cost sparkline from SessionManager's bounded timeline (P0#3). */
  private _renderCostTrend(): string {
    const timeline = this.sessionManager.getCostTimeline();
    if (timeline.length < 2) {
      return '<div class="empty">Cost trend appears once agents complete a few turns.</div>';
    }
    const w = 640, h = 120, pad = 6;
    const max = Math.max(...timeline.map((s) => s.cost), 1e-9);
    const n = timeline.length;
    const points = timeline
      .map((s, i) => {
        const x = pad + (i / (n - 1)) * (w - 2 * pad);
        const y = h - pad - (s.cost / max) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const last = timeline[n - 1].cost;
    return /* html */`
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Cumulative cost trend">
        <polyline fill="none" stroke="var(--vscode-charts-purple)" stroke-width="2" points="${points}" />
      </svg>
      <div class="trend-meta">${n} samples | cumulative spend $${last.toFixed(4)} (max $${max.toFixed(4)})</div>`;
  }

  /** Horizontal bar list of agents ranked by cost (P0#3). */
  private _renderAgentRanking(sessions: SessionInfo[]): string {
    const rows = sessions
      .map((s) => ({ name: s.config.name, cost: s.usage?.costUsd ?? 0, basis: s.usage?.costBasis, turns: s.usage?.turns ?? 0 }))
      .filter((r) => r.cost > 0 && r.turns > 0 && r.basis)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8);
    if (rows.length === 0) {
      return '<div class="empty">No cost recorded yet.</div>';
    }
    const max = Math.max(...rows.map((r) => r.cost));
    return rows
      .map(
        (r) => `
        <div class="bar-row">
          <span class="bar-label" title="${escAttr(r.name)}">${esc(r.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${((r.cost / max) * 100).toFixed(1)}%"></span></span>
          <span class="bar-value">${r.basis === 'api-equivalent' ? '~' : ''}$${r.cost.toFixed(3)}${r.basis === 'api-equivalent' ? ' est.' : ''}</span>
        </div>`
      )
      .join('');
  }

  /** "Latest tasks" panel: the last N user-initiated tasks, each broken down by the agents that worked
   *  on it (token bars). N is set via command-URI links (the webview has scripts disabled). */
  private _renderRecentTasks(records: TaskTokenRecord[], n: number): string {
    const control = `<span class="task-ctl">Show last: ${RECENT_TASK_COUNT_OPTIONS.map((k) => {
      if (k === n) { return `<b>${k}</b>`; }
      const href = `command:unode.setDashboardTaskCount?${encodeURIComponent(JSON.stringify([k]))}`;
      return `<a href="${href}">${k}</a>`;
    }).join(' · ')}</span>`;
    if (records.length === 0) {
      return /* html */`<div class="panel wide">
        <h3>Latest tasks ${control}</h3>
        <div class="empty">No completed tasks yet — run a task and its token usage appears here, broken down by agent.</div>
      </div>`;
    }
    const cards = records.map((t) => {
      const approvalWaitMs = Math.max(0, t.approvalWaitMs ?? 0);
      const approvalWait = approvalWaitMs < 1_000
        ? `${approvalWaitMs} ms`
        : `${(approvalWaitMs / 1_000).toFixed(approvalWaitMs < 10_000 ? 1 : 0)} s`;
      const approvalStats = `Human approvals: ${approvalWait} waiting · ${t.approvalDenials ?? 0} denied`;
      const maxAgent = Math.max(...t.agents.map((a) => a.inputTokens + a.outputTokens), 1);
      const bars = t.agents.map((a) => {
        const tot = a.inputTokens + a.outputTokens;
        const pct = (tot / maxAgent) * 100;
        const title = `${a.name}: ${tot.toLocaleString()} tokens (in ${a.inputTokens.toLocaleString()} / out ${a.outputTokens.toLocaleString()}) · $${a.costUsd.toFixed(4)}`;
        return /* html */`<div class="bar-row" title="${escAttr(title)}">
          <span class="bar-label">${esc(a.name)}</span>
          <span class="bar-track"><span class="bar-fill tok" style="width:${pct.toFixed(1)}%"></span></span>
          <span class="bar-value">${tot.toLocaleString()}</span>
        </div>`;
      }).join('');
      return /* html */`<div class="task-card">
        <div class="task-head">
          <span class="task-title" title="${escAttr(t.title)}">${esc(t.title)}</span>
          <span class="task-total">${t.totalTokens.toLocaleString()} tok &bull; $${t.totalCostUsd.toFixed(4)}</span>
        </div>
        <div class="task-approval">${esc(approvalStats)}</div>
        ${bars}
      </div>`;
    }).join('');
    return /* html */`<div class="panel wide">
      <h3>Latest tasks ${control}</h3>
      <div class="task-list">${cards}</div>
    </div>`;
  }

  /** Token share per provider (P0#3) - shows where the cost arbitrage is actually landing. */
  private _renderProviderDistribution(sessions: SessionInfo[]): string {
    const byProvider = new Map<string, number>();
    for (const s of sessions) {
      const tok = (s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0);
      if (tok > 0) {
        byProvider.set(s.config.provider.providerId, (byProvider.get(s.config.provider.providerId) ?? 0) + tok);
      }
    }
    const rows = [...byProvider.entries()].sort((a, b) => b[1] - a[1]);
    if (rows.length === 0) {
      return '<div class="empty">No token usage yet.</div>';
    }
    const totalTok = rows.reduce((sum, [, t]) => sum + t, 0);
    return rows
      .map(([provider, tok]) => {
        const pct = (tok / totalTok) * 100;
        return `
        <div class="bar-row">
          <span class="bar-label" title="${escAttr(provider)}">${esc(provider)}</span>
          <span class="bar-track"><span class="bar-fill tok" style="width:${pct.toFixed(1)}%"></span></span>
          <span class="bar-value">${pct.toFixed(0)}%</span>
        </div>`;
      })
      .join('');
  }
}

export function renderMissionControlLanes(sessions: SessionInfo[], state: DashboardLaneRenderState = {}): string {
  const hasWorktree = !!state.worktreeReview;
  const header = /* html */`<div class="lane-head">
    <div>Agent</div>
    <div>Status</div>
    <div>Current task</div>
    <div>Files</div>
    <div>Cost</div>
    <div>Context</div>
    ${hasWorktree ? '<div>Verified</div>' : ''}
    <div>Actions</div>
  </div>`;
  if (sessions.length === 0) {
    return /* html */`<section class="lane-board ${hasWorktree ? 'with-worktree' : 'no-worktree'}">
      <div class="lane-empty">No agents configured yet. <a href="command:unode.createTeamPreset">Create a team</a> to start using the Dashboard.</div>
    </section>`;
  }
  const progressByAgent = new Map((state.agentStates ?? []).map((s) => [s.agentId, s]));
  const laneByAgentId = new Map((state.worktreeReview?.lanes ?? []).map((l) => [l.agentId, l]));
  const rows = sessions.map((session) => {
    const progress = progressByAgent.get(session.id);
    const worktreeLane = laneByAgentId.get(session.id);
    const files = uniqueStrings([
      ...(state.filesByAgent?.get(session.id) ?? []),
      ...(worktreeLane?.changedFiles ?? []),
    ]);
    return renderMissionControlLane(session, {
      progress,
      files,
      worktreeLane,
      hasWorktree,
    });
  }).join('');
  return /* html */`<section class="lane-board ${hasWorktree ? 'with-worktree' : 'no-worktree'}">${header}${rows}</section>`;
}

function renderMissionControlLane(
  session: SessionInfo,
  opts: {
    progress?: DelegationAgentState;
    files: string[];
    worktreeLane?: WorktreeReview['lanes'][number];
    hasWorktree: boolean;
  }
): string {
  const cfg = session.config;
  const status = laneStatus(session, opts.progress);
  const task = taskText(session, opts.progress);
  const u = session.usage;
  const ctx = contextLabel(session.contextUsage, cfg.backend);
  const filesPreview = opts.files.slice(0, 3).join(', ');
  const fileTitle = opts.files.length > 0 ? opts.files.join('\n') : 'No files touched yet';
  const cost = laneCostLabel(u);
  const chatHref = commandUri('unode.chatWithAgent', [session.id]);
  const terminalHref = commandUri('unode.showAgentTerminal', [session.id]);
  return /* html */`<div class="lane-row lane-${status}">
    <div class="agent-cell">
      <span class="agent-icon">${renderAgentIcon(cfg.icon)}</span>
      <span style="min-width:0">
        <div class="agent-name" title="${escAttr(cfg.name)}">${esc(cfg.name)}</div>
        <div class="agent-role" title="${escAttr(String(cfg.role))}">${esc(String(cfg.role))}</div>
      </span>
    </div>
    <div><span class="status-pill"><span class="status-dot"></span>${esc(status)}</span></div>
    <div class="task-cell ${task.muted ? 'task-muted' : ''}" title="${escAttr(task.text)}">${esc(task.text)}</div>
    <div class="files-cell" title="${escAttr(fileTitle)}">
      <span class="files-count">${opts.files.length}</span>
      ${opts.files.length > 0 ? `<div class="files-list">${esc(filesPreview)}</div>` : ''}
    </div>
    <div class="metric cost-cell">${cost}</div>
    <div class="metric context-cell" title="${escAttr(ctx.text)}">${esc(ctx.level === 'none' ? 'n/a' : `${ctx.percent}%`)}</div>
    ${opts.hasWorktree ? `<div class="verify-cell">${renderVerifyBadge(opts.worktreeLane)}</div>` : ''}
    <div class="lane-actions">
      <a class="cmd-link secondary" href="${escAttr(chatHref)}">New Task</a>
      <a class="cmd-link secondary" href="${escAttr(terminalHref)}">Terminal</a>
    </div>
  </div>`;
}

function laneCostLabel(usage: SessionInfo['usage']): string {
  if (!usage || usage.turns <= 0 || !usage.costBasis) {
    return 'cost unknown';
  }
  return `${usage.costBasis === 'api-equivalent' ? '~' : ''}$${usage.costUsd.toFixed(2)}`;
}

function laneStatus(session: SessionInfo, progress?: DelegationAgentState): string {
  if (progress?.completionState === 'partial') {
    return 'partial';
  }
  if (progress?.status) {
    return progress.status;
  }
  switch (session.status) {
    case 'running':
    case 'starting':
    case 'stopping':
      return 'working';
    case 'idle':
      return 'idle';
    // Awaiting a human consent answer is blocked, not stopped: the agent is mid-start and needs the user.
    case 'consent_required':
    case 'error':
      return 'blocked';
    case 'stopped':
    default:
      return 'stopped';
  }
}

function taskText(session: SessionInfo, progress?: DelegationAgentState): { text: string; muted: boolean } {
  if (progress?.task) {
    return { text: progress.task, muted: false };
  }
  if (session.currentTask) {
    return { text: session.currentTask, muted: false };
  }
  if (session.errorMessage) {
    return { text: session.errorMessage, muted: false };
  }
  return { text: 'No active task', muted: true };
}

function renderVerifyBadge(lane: WorktreeReview['lanes'][number] | undefined): string {
  const status = lane?.verification?.status;
  if (status === 'passed') {
    return '<span class="verify-badge verify-passed">Verified / mergeable</span>';
  }
  if (status === 'failed') {
    return '<span class="verify-badge verify-failed">Failed / held</span>';
  }
  if (status === 'skipped') {
    return '<span class="verify-badge verify-skipped">Unverified</span>';
  }
  return '<span class="verify-badge verify-missing">Not in worktree</span>';
}

function renderAgentIcon(icon: string | undefined): string {
  if (icon?.startsWith('data:')) {
    return `<img src="${escAttr(icon)}" alt="">`;
  }
  return esc(icon || 'AI');
}

function commandUri(command: string, args?: unknown[]): string {
  return args && args.length > 0
    ? `command:${command}?${encodeURIComponent(JSON.stringify(args))}`
    : `command:${command}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
