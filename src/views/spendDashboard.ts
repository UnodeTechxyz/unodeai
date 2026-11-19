/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Dashboard Spend section (v0.9.89, design §7, §13.2)
 *
 *  Renders a host-built SpendViewModel. The page is scripts-disabled; every action is a command link that
 *  carries no request, project or agent id, so the host always decides which counter an action touches.
 *  Provenance classes stay in separate rows: nothing is collapsed into one unlabelled dollar figure.
 *--------------------------------------------------------------------------------------------*/

import type { CounterView, SpendViewModel } from '../host/SpendCoordinator';
import { formatUsd } from '../models/spend/Money';
import { esc, escAttr } from './webviewSecurity';

export const SPEND_DASHBOARD_STYLES = /* css */`
  .spend { margin: 0 0 24px; padding: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-input-background); }
  .spend h2 { font-size: 16px; margin-bottom: 4px; }
  .spend .spend-sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }
  .spend .spend-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
  .spend .spend-warn { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 12px;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); }
  .spend .spend-note { margin: 6px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .spend-counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .spend-counter { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; }
  .spend-counter.over { border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); }
  .spend-counter h3 { font-size: 13px; margin-bottom: 6px; }
  .spend-counter .progress { font-size: 12px; margin-bottom: 6px; }
  .spend-counter .progress b { color: var(--vscode-foreground); }
  .spend-counter table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .spend-counter td { padding: 2px 4px; border-top: 1px solid var(--vscode-panel-border); }
  .spend-counter td.num { text-align: right; white-space: nowrap; }
  .spend-counter .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
`;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function targetLine(view: CounterView): string {
  if (!view.target) return '<div class="progress">No reminder target.</div>';
  const parts: string[] = [];
  if (view.target.tokens) {
    const target = Number(view.target.tokens.value);
    parts.push(`<b>${tokens(view.eligibleTokens)}</b> of ${tokens(target)} tokens`);
  }
  if (view.target.nanoUsd) {
    parts.push(`<b>${esc(formatUsd(view.eligibleNanoUsd))}</b> of ${esc(formatUsd(BigInt(view.target.nanoUsd.value)))}`);
  }
  const narrowed = view.target.tokens?.repositoryNarrowed || view.target.nanoUsd?.repositoryNarrowed;
  return `<div class="progress">${parts.join(' · ')}${view.percent !== undefined ? ` — <b>${view.percent}%</b>` : ''}`
    + `${narrowed ? ' (project-suggested target accepted by you)' : ''}</div>`;
}

function counterCard(view: CounterView): string {
  const over = (view.percent ?? 0) >= 100;
  const rows = view.rows.length === 0
    ? '<tr><td>No usage in this counter yet.</td><td></td><td></td></tr>'
    : view.rows.map((row) => `<tr><td>${esc(row.label)}</td><td class="num">${tokens(row.tokens)} tok</td><td class="num">${esc(row.costText ?? '—')}</td></tr>`).join('');
  const meta = [
    `in ${tokens(view.tokens.input)} · cached ${tokens(view.tokens.cached)} · out ${tokens(view.tokens.output)}`,
    view.unattributedUnits > 0 ? `${view.unattributedUnits} turn(s) had provider attempts whose usage was not reported` : '',
    view.lastReset ? `Counter reset ${esc(view.lastReset.resetAt.replace('T', ' ').slice(0, 16))} UTC (it held ${tokens(view.lastReset.previousTokens)} reminder tokens; history kept)` : '',
  ].filter(Boolean).join('<br>');
  return /* html */`<div class="spend-counter${over ? ' over' : ''}">
    <h3>${esc(view.title)}${over ? ' — over target' : ''}</h3>
    ${targetLine(view)}
    <table>${rows}</table>
    <div class="meta">${meta}</div>
  </div>`;
}

export function renderSpendSection(view: SpendViewModel | undefined): string {
  if (!view) return '';
  const catalogs = view.catalogs.map((catalog) => {
    const name = catalog.provider === 'unode' ? 'Unode' : 'Roam';
    return `${name} reference captured ${esc(catalog.capturedAt.slice(0, 10))}${catalog.stale ? ' (<b>stale</b>)' : ''}`;
  }).join(' · ');
  const mode = view.referenceMode === 'unselected'
    ? 'Reference prices are shown for comparison; dollar reminders use only billed or exact account prices until you choose a reference.'
    : view.referenceMode === 'token-only'
      ? 'Token reminders only: reference dollars are shown but never used for a reminder.'
      : `Dollar reminders may use the ${view.referenceMode === 'unode' ? 'Unode' : 'Roam'} reference estimate when no billed or exact account price exists.`;
  const warnings = [
    view.remindersPaused ? 'Spend tracking needs repair; reminders are paused. Work is not affected. <a href="command:unode.repairSpendTracking">Repair spend tracking…</a>' : '',
    view.openUnits > 0 ? `Usage updating: ${view.openUnits} turn(s) still running.` : '',
    view.pendingWrites > 0 ? `Usage updating: ${view.pendingWrites} usage record(s) could not be saved yet and are being retried. Totals and reminders include them once saved.` : '',
    view.coverageGaps > 0 ? `${view.coverageGaps} turn(s) may have used tokens, but the provider result was not completely observed. They are listed as coverage gaps, never charged a guessed amount.` : '',
    view.repository?.state === 'proposed'
      ? 'This project proposes lower spend-reminder targets. They have no effect until you accept this exact version. <a href="command:unode.reviewRepositorySpendTargets">Review</a>'
      : '',
    ...view.targetDiagnostics.map((line) => esc(line)),
    ...view.diagnostics.slice(0, 5).map((line) => esc(line)),
  ].filter(Boolean);
  const counters = [
    ...(view.project ? [counterCard(view.project)] : []),
    ...view.agents.filter((agent) => agent.target || agent.rows.length > 0).map(counterCard),
    ...view.requests.slice(0, 3).map(counterCard),
  ];
  return /* html */`
  <section class="spend" id="spend">
    <h2>Spend</h2>
    <div class="spend-sub">Reminders only — UnodeAi never stops, pauses or shortens work because of spend. `
      + `${view.trackedSince ? `Tracked since v0.9.89 (${esc(view.trackedSince.slice(0, 10))}).` : 'Tracked since v0.9.89.'}`
      + `${view.folderless ? ' No folder is open, so only per-request totals are kept (in memory).' : ''}</div>
    <div class="spend-actions">
      <a class="cmd-link" href="command:unode.changeSpendTarget">Change target</a>
      <a class="cmd-link secondary" href="command:unode.resetSpendCounter">Reset counter…</a>
      <a class="cmd-link secondary" href="command:unode.updateUnodeReferencePrices">Update Unode reference prices</a>
      <a class="cmd-link secondary" href="command:unode.updateRoamReferencePrices">Update Roam reference prices</a>
    </div>
    ${warnings.map((line) => `<div class="spend-warn">${line}</div>`).join('')}
    <div class="spend-note">${catalogs ? `${catalogs}. ` : ''}${esc(mode)}</div>
    <div class="spend-counters">${counters.join('') || '<div class="spend-note">No usage recorded yet.</div>'}</div>
  </section>`;
}

/** The savings banner prices both sides from the same dated reference, or makes no claim at all. */
export function renderReferenceSavings(sessions: Array<{ usage?: { turns: number; savings?: { actualUsd: number; premiumUsd: number; source: string } | 'unavailable' } }>): string {
  const used = sessions.filter((session) => (session.usage?.turns ?? 0) > 0);
  if (used.length === 0) return '';
  if (used.some((session) => !session.usage?.savings || session.usage.savings === 'unavailable')) return '';
  const entries = used.map((session) => session.usage!.savings as { actualUsd: number; premiumUsd: number; source: string });
  const actual = entries.reduce((sum, entry) => sum + entry.actualUsd, 0);
  const premium = entries.reduce((sum, entry) => sum + entry.premiumUsd, 0);
  const sources = new Set(entries.map((entry) => entry.source));
  if (sources.size !== 1 || premium <= 0) return '';
  const delta = premium - actual;
  if (Math.abs(delta) < 0.0001) return '';
  const pct = (Math.abs(delta) / premium) * 100;
  const source = [...sources][0];
  return /* html */`
  <div class="savings-banner${delta >= 0 ? '' : ' over'}">
    <div class="savings-head">${delta >= 0
      ? `Mixed-model routing saved about <b>$${delta.toFixed(2)}</b> <span class="savings-pct">(${pct.toFixed(0)}% off)</span>`
      : `Mixed-model routing cost about <b>$${(-delta).toFixed(2)}</b> more <span class="savings-pct">(${pct.toFixed(0)}% over the all-premium baseline)</span>`}</div>
    <div class="savings-detail" title="${escAttr(`Both figures priced from the ${source}. Not a bill.`)}">Priced from the ${esc(source)}: all-premium baseline <b>$${premium.toFixed(2)}</b> · your mixed routing <b>$${actual.toFixed(2)}</b></div>
  </div>`;
}
