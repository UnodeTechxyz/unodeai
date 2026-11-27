/*---------------------------------------------------------------------------------------------
 *  UnodeAi - team work-profile table editor (v0.9.90 Smart compaction design, §4.1)
 *
 *  The one editable copy of the Smart compaction profile table for the current team. It stores only the
 *  cells that differ from the bundled policy, shows the bundled value beside every override, and affects only
 *  agents in Smart mode that resolve to the edited row. Custom and Off agents never read it.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { CompactionWorkProfile } from '../types';
import {
  formatTokens,
  isCompactionWorkProfile,
  PROFILE_VALUE_FIELDS,
  TOKEN_VALUE_RANGE,
  WINDOW_PERCENT_RANGE,
  type SmartCompactionProfileOverrides,
  type SmartCompactionProfileValues,
} from '../compaction/SmartCompactionPolicy';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import { showResultNotice } from '../resultNotice';

export interface CompactionProfileTableRow {
  id: CompactionWorkProfile;
  label: string;
  typicalWork: string;
  defaults: SmartCompactionProfileValues;
  overrides: Partial<SmartCompactionProfileValues>;
  /** Names of the Smart agents on this team that resolve to this row. */
  agents: string[];
}

export interface CompactionProfileTableViewModel {
  /** Absent when the bundled Smart policy is unavailable; the reason is shown instead of a table. */
  rows?: CompactionProfileTableRow[];
  unavailableReason?: string;
  /** Whether .unode/team.json already exists; the first save otherwise creates it. */
  teamFileExists: boolean;
}

export interface CompactionProfileTableDeps {
  getViewModel: () => Promise<CompactionProfileTableViewModel> | CompactionProfileTableViewModel;
  save: (overrides: SmartCompactionProfileOverrides) => Promise<{ ok: boolean; message: string }>;
}

export class CompactionProfileTablePanel {
  public static current: CompactionProfileTablePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(deps: CompactionProfileTableDeps): void {
    if (CompactionProfileTablePanel.current) {
      CompactionProfileTablePanel.current.deps = deps;
      CompactionProfileTablePanel.current.panel.reveal();
      void CompactionProfileTablePanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeCompactionProfileTable',
      'Team work-profile table',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    CompactionProfileTablePanel.current = new CompactionProfileTablePanel(panel, deps);
  }

  private constructor(panel: vscode.WebviewPanel, private deps: CompactionProfileTableDeps) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    void this.render();
  }

  private async onMessage(msg: { command?: unknown; overrides?: unknown }): Promise<void> {
    if (!msg || typeof msg.command !== 'string') return;
    try {
      if (msg.command === 'cancel') {
        this.panel.dispose();
        return;
      }
      if (msg.command === 'save') {
        const overrides = parseProfileTableOverrides(msg.overrides);
        if (!overrides) {
          void showResultNotice('warning', 'UnodeAi: the profile table could not be read. Reopen it and try again.');
          return;
        }
        const result = await this.deps.save(overrides);
        if (result.ok) {
          void showResultNotice('information', `UnodeAi: ${result.message}`);
          this.panel.dispose();
        } else {
          void showResultNotice('warning', `UnodeAi: ${result.message}`);
          void this.panel.webview.postMessage({ command: 'problem', message: result.message });
        }
      }
    } catch (error) {
      void showResultNotice('error', `UnodeAi: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async render(): Promise<void> {
    this.panel.webview.html = renderCompactionProfileTableHtml(this.panel.webview, await this.deps.getViewModel());
  }

  private dispose(): void {
    CompactionProfileTablePanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

/**
 * The webview's candidate table: numbers only, per known profile and field. Range and row checks are the
 * host's (`profileOverrideProblems`), so a refused save is explained rather than trimmed here.
 */
export function parseProfileTableOverrides(raw: unknown): SmartCompactionProfileOverrides | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const overrides: SmartCompactionProfileOverrides = {};
  for (const [id, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCompactionWorkProfile(id) || !row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const cells: Partial<SmartCompactionProfileValues> = {};
    for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
      if (!(PROFILE_VALUE_FIELDS as readonly string[]).includes(field)) return undefined;
      const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(parsed)) return undefined;
      cells[field as keyof SmartCompactionProfileValues] = parsed;
    }
    if (Object.keys(cells).length > 0) overrides[id] = cells;
  }
  return overrides;
}

const COLUMNS: Array<{ field: keyof SmartCompactionProfileValues; label: string; hostHistoryOnly: boolean }> = [
  { field: 'windowPercent', label: 'Window share (%)', hostHistoryOnly: false },
  { field: 'ceilingTokens', label: 'Practical ceiling', hostHistoryOnly: false },
  { field: 'recentTailTokens', label: 'Recent tail', hostHistoryOnly: true },
  { field: 'postCompactTargetTokens', label: 'Post-compact target', hostHistoryOnly: true },
];

export function renderCompactionProfileTableHtml(webview: vscode.Webview, view: CompactionProfileTableViewModel): string {
  const scriptNonce = nonce();
  const rows = view.rows ?? [];
  const defaults = Object.fromEntries(rows.map((row) => [row.id, row.defaults]));
  const cell = (row: CompactionProfileTableRow, column: (typeof COLUMNS)[number]) => {
    const isPercent = column.field === 'windowPercent';
    const range = isPercent ? WINDOW_PERCENT_RANGE : TOKEN_VALUE_RANGE;
    const base = row.defaults[column.field];
    const override = row.overrides[column.field];
    return `<td><input type="number" data-row="${escAttr(row.id)}" data-field="${column.field}" min="${range.min}" max="${range.max}" `
      + `step="${isPercent ? 1 : 1000}" value="${override ?? ''}" placeholder="${escAttr(isPercent ? `${base}` : formatTokens(base))}" `
      + `aria-label="${escAttr(`${row.label} ${column.label}`)}">`
      + `<div class="default">Default ${esc(isPercent ? `${base}%` : formatTokens(base))}</div></td>`;
  };
  const body = rows.map((row) => `<tr>
        <th scope="row"><div class="profile">${esc(row.label)}</div><div class="work">${esc(row.typicalWork)}</div>`
      + `<div class="work">${row.agents.length ? `Used by: ${esc(row.agents.join(', '))}` : 'No Smart agent uses this row yet'}</div></th>
        ${COLUMNS.map((column) => cell(row, column)).join('')}
        <td><button class="btn" type="button" data-reset-row="${escAttr(row.id)}">Reset row</button></td>
      </tr>`).join('');
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team work-profile table</title>
  <style>
    body { margin: 0; padding: 18px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); }
    h1 { margin: 0 0 6px; font-size: 18px; }
    .help { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; margin: 4px 0; }
    .problem { color: var(--vscode-inputValidation-warningForeground, #b58100); font-size: 12px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 6px; text-align: left; vertical-align: top; }
    thead th { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .profile { font-weight: 600; }
    .work, .default { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
    input { width: 100%; min-width: 90px; box-sizing: border-box; padding: 4px 6px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px; font: inherit; }
    .btn { padding: 5px 11px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; }
    .btn.primary { border-color: transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .table-wrap { overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Team work-profile table</h1>
  <p class="help">Smart agents on this team compact at the smaller of their window share and practical ceiling. Blank cells use the
    bundled default shown under them. Changes apply to Smart agents on the edited row at their next idle turn; Custom and
    Off agents are not affected, and a running Claude agent applies a change when it restarts.
    This schedules compaction; it does not block tasks.</p>
  <p class="help">Saved in <code>.unode/team.json</code>.${view.teamFileExists ? '' : ' This workspace has no team file yet, so saving creates one from the current roster.'}
    A change made outside this editor, by hand or by a <code>git pull</code>, applies after <strong>Developer: Reload Window</strong>.</p>
  ${view.rows ? `<div class="table-wrap"><table>
    <thead><tr><th>Work profile</th>${COLUMNS.map((column) => `<th>${esc(column.label)}${column.hostHistoryOnly ? ' *' : ''}</th>`).join('')}<th></th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="help">* Host-history routes only: OpenAI-compatible agents keep this recent tail word for word and aim for this
    target. Claude and Codex write their own summary; for them only the trigger applies.</p>
  <p class="problem" id="problem" role="status" hidden></p>
  <div class="actions">
    <button class="btn" type="button" id="resetAll">Reset all</button>
    <button class="btn" type="button" id="cancel">Cancel</button>
    <button class="btn primary" type="button" id="save">Save</button>
  </div>` : `<p class="problem" role="status">The Smart profile table is unavailable: ${esc(view.unavailableReason ?? 'the bundled policy did not validate')}.
    Custom and Off still work, and tasks are always sent.</p>
  <div class="actions"><button class="btn" type="button" id="cancel">Close</button></div>`}
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const defaults = ${JSON.stringify(defaults).replace(/</g, '\\u003c')};
    const byId = (id) => document.getElementById(id);
    document.addEventListener('click', (event) => {
      const reset = event.target.closest('[data-reset-row]');
      if (reset) {
        document.querySelectorAll('input[data-row="' + reset.dataset.resetRow + '"]').forEach((input) => { input.value = ''; });
        return;
      }
      if (event.target.id === 'resetAll') {
        document.querySelectorAll('input[data-row]').forEach((input) => { input.value = ''; });
        return;
      }
      if (event.target.id === 'cancel') {
        vscode.postMessage({ command: 'cancel' });
        return;
      }
      if (event.target.id === 'save') {
        // Only changed cells are stored: a blank cell, or one equal to the bundled value, is not an override.
        const overrides = {};
        document.querySelectorAll('input[data-row]').forEach((input) => {
          const raw = input.value.trim();
          if (!raw) return;
          const row = input.dataset.row;
          const field = input.dataset.field;
          if (defaults[row] && String(defaults[row][field]) === raw) return;
          overrides[row] = overrides[row] || {};
          overrides[row][field] = raw;
        });
        vscode.postMessage({ command: 'save', overrides });
      }
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.command === 'problem' && byId('problem')) {
        byId('problem').textContent = msg.message;
        byId('problem').hidden = false;
      }
    });
  </script>
</body>
</html>`;
}
