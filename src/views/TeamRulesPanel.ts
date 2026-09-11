/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TeamRulesPanel  (#4b Team Rules)
 *  Three truthful zones: display-only host protections, human-selected host policy, and advisory
 *  guidance persisted to `.unode/rules.md` for agent judgement.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { nonce, csp, esc } from './webviewSecurity';
import type { TeamPolicyV1 } from '../policy/TeamPolicy';

export type TeamRulesKind = 'software' | 'knowledge';

/**
 * The only portion of `.unode/rules.md` owned by UnodeAi. Keep these markers deliberately plain:
 * a person can see, edit around, or remove the generated roster without needing a special editor.
 */
export const TEAM_ROSTER_START = '<!-- unode:team-roster:start -->';
export const TEAM_ROSTER_END = '<!-- unode:team-roster:end -->';

/** The small, per-turn roster fact an agent needs; this is intentionally not a biography. */
export interface TeamRosterMember {
  name: string;
  role: string;
  duty: string;
}

export interface TeamRulesPanelDeps {
  rulesFilePath: string;
  /** Kind-appropriate starter template to seed when no rules exist yet (software vs knowledge/business). */
  defaultTemplate?: string;
  /** A chosen preset's body. When set, it OVERRIDES the saved rules in the editor (the "use a preset"
   *  flow), so the user reviews it and Saves to replace the current rules. */
  initialContent?: string;
  /** Called after a successful save so the live RulesFile cache can reload. */
  onSaved?: () => void;
  currentPolicy?: () => TeamPolicyV1;
  setReviewPolicyFromHumanPanel?: (enabled: boolean) => Promise<boolean>;
  latestPolicyChangeAt?: () => string | undefined;
}

/** Display-only rows backed by host enforcement and removal proof. */
export const BUILT_IN_PROTECTIONS = [
  'Delegate-required contracts never authorize coordinator fallback.',
  'Task read and write scope is intersected with the target connection authority.',
  'MCP access comes only from a host grant.',
  'Attempts and receipts are host-issued, current-attempt-bound, and terminal once.',
  'Execution hooks require an approved digest and origin.',
] as const;

let currentPanel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the Team Rules editor. */
export async function openTeamRulesPanel(deps: TeamRulesPanelDeps): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'unode.teamRules',
    'Team Rules',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });

  const seed = deps.defaultTemplate?.trim() ? deps.defaultTemplate : defaultTeamRules('software');
  const saved = await readRules(deps.rulesFilePath);
  // Priority: a chosen preset (override, so "use a preset" swaps the text) → saved rules → the
  // kind-appropriate starter template. Seeded as *real* editable text so the user can tweak + Save.
  const content = deps.initialContent !== undefined
    ? deps.initialContent
    : saved.trim() ? saved : seed;
  const scriptNonce = nonce();
  const policy = deps.currentPolicy?.();
  panel.webview.html = getHtml(
    panel.webview,
    scriptNonce,
    content,
    policy?.requireDifferentReportedModelForArtifactReview ?? false,
    deps.latestPolicyChangeAt?.(),
  );

  panel.webview.onDidReceiveMessage(async (msg: { command?: string; text?: unknown; reviewPolicy?: unknown }) => {
    if (msg?.command === 'save' && typeof msg.text === 'string') {
      try {
        if (typeof msg.reviewPolicy === 'boolean') {
          await deps.setReviewPolicyFromHumanPanel?.(msg.reviewPolicy);
        }
        await writeRules(deps.rulesFilePath, msg.text);
        deps.onSaved?.();
        panel.webview.postMessage({ command: 'saved' });
        vscode.window.showInformationMessage('Team policy and advisory guidance saved.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Could not save team rules: ${message}`);
      }
    }
  });
}

async function readRules(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function writeRules(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

const SOFTWARE_RULES = `# Team guidance

Advisory working preferences supplied to the crew. Host protections and selected team policy remain authoritative.

Examples:
- Prefer a focused review when a change crosses a public boundary.
- Keep edits within the files named by the task and report necessary spillover.
- Run the relevant tests before reporting a task complete.
- Follow the existing code style; avoid new dependencies without a clear reason.`;

const KNOWLEDGE_RULES = `# Team guidance

Advisory working preferences supplied to the crew. Host protections and selected team policy remain authoritative.

Examples:
- State assumptions explicitly, and keep facts, analysis, and recommendations clearly separated.
- Cite a source for external figures or claims; label estimates and give a range where useful.
- Mark unverifiable material as an assumption rather than fabricating data.
- Quantify trade-offs where useful and surface the largest risks and unknowns.
- The PM should synthesize specialist findings into one coherent answer.`;

const STRICT_RULES = `# Team guidance

Advisory working preferences supplied to the crew. Host protections and selected team policy remain authoritative.

- Prefer a second set of eyes for high-risk changes and run the relevant project checks.
- Keep work within the assigned set; flag necessary spillover to the PM.
- Avoid new dependencies, frameworks, or public-API changes without explicit sign-off.
- On failure, report the observed command and output before offering a diagnosis.
- If blocked, ask rather than silently working around the issue.`;

const LEAN_RULES = `# Team guidance

Advisory working preferences supplied to the crew. Host protections and selected team policy remain authoritative.

- Keep changes small and focused on the requested outcome.
- Match the existing code and style; avoid dependencies without a good reason.
- For ambiguity, make the smallest reasonable choice and state it.
- Say clearly when a task is done and what changed.`;

/** The starter Team Rules template appropriate to the kind of team (software crew vs knowledge/business). */
export function defaultTeamRules(kind: TeamRulesKind): string {
  return kind === 'knowledge' ? KNOWLEDGE_RULES : SOFTWARE_RULES;
}

/** The distinctive primary skills carried by knowledge/business specialists. Their role templates all use
 *  role:'custom', so the ROLE is not a usable signal — the SKILL is. Keep in sync with the knowledge
 *  presets in RoleConfig (business-analyst/market-researcher/financial-analyst/strategy-lead). */
export const KNOWLEDGE_TEAM_SKILLS = [
  'business-analysis', 'market-research', 'financial-modeling', 'strategy',
  // Marketing team specialists
  'content-marketing', 'growth-marketing', 'seo-analytics',
  // Sales team specialists
  'sales-development', 'sales-execution', 'sales-engineering', 'customer-success',
];

/** Classify a team from the skills its agents carry: any knowledge specialist → 'knowledge', else 'software'. */
export function teamKindFromSkills(agentSkills: readonly string[]): TeamRulesKind {
  const known = new Set(KNOWLEDGE_TEAM_SKILLS);
  return agentSkills.some((sk) => known.has(sk)) ? 'knowledge' : 'software';
}

/**
 * Decide whether switching to a team of `kind` should reset the current rules. Returns the new rules body
 * to write, or null to leave them untouched. Only a recognized KIND default (software ↔ knowledge) that no
 * longer matches the new kind is swapped — empty, custom, or kind-agnostic-preset (strict/lean) rules are
 * always preserved, so a user's deliberate rules are never clobbered on a team switch.
 */
export function rulesResetForKind(current: string, kind: TeamRulesKind): string | null {
  const cur = (current ?? '').trim();
  const target = defaultTeamRules(kind);
  if (!cur || cur === target.trim()) { return null; }
  const kindDefaults = new Set([defaultTeamRules('software').trim(), defaultTeamRules('knowledge').trim()]);
  return kindDefaults.has(cur) ? target : null;
}

/**
 * Build the live roster block appended to team rules. It contains one role and one short duty per
 * member because this file is attached to every turn; richer agent descriptions belong in the Team UI.
 */
export function generatedTeamRoster(members: readonly TeamRosterMember[]): string {
  const rows = members.length === 0
    ? ['- No active agents.']
    : members.map((member) => {
      const name = oneLine(member.name, 'Team member');
      const role = oneLine(member.role, 'Team member');
      const duty = oneLine(member.duty, 'Contribute within the assigned scope.');
      return `- **${name}** — ${role}: ${duty}`;
    });
  return [
    TEAM_ROSTER_START,
    '## Active team roster (generated)',
    'Current roles and one-line responsibilities. This section is refreshed when the roster changes; edit rules outside these markers.',
    '',
    ...rows,
    TEAM_ROSTER_END,
  ].join('\n');
}

/**
 * Replace only a complete generated block. A missing, incomplete, or reversed pair of markers is
 * treated as user content and left intact; append a new block rather than guessing at ownership.
 */
export function upsertGeneratedTeamRoster(current: string, members: readonly TeamRosterMember[]): string {
  const source = current ?? '';
  const start = source.indexOf(TEAM_ROSTER_START);
  const end = start >= 0 ? source.indexOf(TEAM_ROSTER_END, start + TEAM_ROSTER_START.length) : -1;
  const generated = generatedTeamRoster(members);
  if (start >= 0 && end >= 0) {
    return source.slice(0, start) + generated + source.slice(end + TEAM_ROSTER_END.length);
  }
  const before = source.trimEnd();
  return before ? `${before}\n\n${generated}\n` : `${generated}\n`;
}

/**
 * Reconcile the static team template with the live roster. Only an untouched built-in default may
 * change kind on a switch; every other user-authored byte remains as-is and gains/refreshes the
 * bounded generated block.
 */
export function syncTeamRulesWithRoster(
  current: string,
  kind: TeamRulesKind,
  members: readonly TeamRosterMember[],
): string {
  const withoutRoster = removeCompleteGeneratedRoster(current ?? '');
  const bare = withoutRoster.trim();
  const kindDefaults = new Set([defaultTeamRules('software').trim(), defaultTeamRules('knowledge').trim()]);
  const base = !bare || kindDefaults.has(bare) ? defaultTeamRules(kind) : current;
  return upsertGeneratedTeamRoster(base, members);
}

function removeCompleteGeneratedRoster(current: string): string {
  const start = current.indexOf(TEAM_ROSTER_START);
  const end = start >= 0 ? current.indexOf(TEAM_ROSTER_END, start + TEAM_ROSTER_START.length) : -1;
  if (start < 0 || end < 0) {
    return current;
  }
  return (current.slice(0, start) + current.slice(end + TEAM_ROSTER_END.length)).trim();
}

function oneLine(value: string | undefined, fallback: string): string {
  const compact = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return fallback;
  }
  const sentence = compact.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || compact;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

export interface TeamRulesPreset {
  id: string;
  label: string;
  description: string;
  body: string;
}

/** Prepared Team Rules presets offered from the Rules button's "use a preset" option. */
export const TEAM_RULES_PRESETS: readonly TeamRulesPreset[] = [
  { id: 'software', label: 'Software crew', description: 'Focused review, tests, and code-style guidance', body: SOFTWARE_RULES },
  { id: 'knowledge', label: 'Business & analysis', description: 'Cite sources, separate facts from recommendations, quantify', body: KNOWLEDGE_RULES },
  { id: 'strict', label: 'Careful delivery', description: 'High-risk review and checks; restrained scope', body: STRICT_RULES },
  { id: 'lean', label: 'Lean & fast', description: "Minimal ceremony — small focused changes, don't overreach", body: LEAN_RULES },
];

function getHtml(
  webview: vscode.Webview,
  scriptNonce: string,
  content: string,
  reviewPolicyEnabled: boolean,
  latestPolicyChangeAt?: string,
): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Rules</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; gap: 10px; padding: 14px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
    }
    h2 { margin: 0; font-size: 15px; }
    h3 { margin: 0 0 6px; font-size: 13px; }
    section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; }
    ul { margin: 6px 0 0; padding-left: 20px; }
    .policy { display: flex; align-items: flex-start; gap: 8px; }
    .policy input { margin-top: 2px; }
    p.hint { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    textarea {
      flex: 1 1 auto; min-height: 280px; resize: vertical;
      padding: 10px; border-radius: 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px; line-height: 1.5;
    }
    .row { display: flex; align-items: center; gap: 10px; }
    button {
      padding: 5px 14px; border-radius: 4px; cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .saved { color: var(--vscode-charts-green, #3fb950); font-size: 12px; opacity: 0; transition: opacity 0.15s; }
    .saved.show { opacity: 1; }
  </style>
</head>
<body>
  <h2>Team Rules</h2>
  <section>
    <h3>Built-in protections</h3>
    <p class="hint">Host-enforced and not configurable here.</p>
    <ul>${BUILT_IN_PROTECTIONS.map((row) => `<li>${esc(row)}</li>`).join('')}</ul>
  </section>
  <section>
    <h3>Team policy</h3>
    <label class="policy"><input id="reviewPolicy" type="checkbox" ${reviewPolicyEnabled ? 'checked' : ''}><span>For explicitly marked artifact reviews, require a different reported model identity.</span></label>
    <p class="hint">Host-enforced after the exact turn model is selected. Different reported identities do not prove different underlying models or review quality.${latestPolicyChangeAt ? ` Latest human-panel change: ${esc(latestPolicyChangeAt)}.` : ''}</p>
  </section>
  <h3>Guidance</h3>
  <p class="hint">Advisory text for agent judgement. It cannot change permissions, built-in protections, or team policy. Saved to <code>.unode/rules.md</code>.</p>
  <textarea id="rules" placeholder="Write advisory team guidance here…" spellcheck="false">${esc(content)}</textarea>
  <div class="row">
    <button id="save" type="button">Save</button>
    <span id="saved" class="saved">Saved ✓</span>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('rules');
    const reviewPolicy = document.getElementById('reviewPolicy');
    const saveBtn = document.getElementById('save');
    const savedLabel = document.getElementById('saved');
    saveBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'save', text: ta.value, reviewPolicy: reviewPolicy.checked });
    });
    window.addEventListener('message', (event) => {
      if (event.data && event.data.command === 'saved') {
        savedLabel.classList.add('show');
        setTimeout(() => savedLabel.classList.remove('show'), 1500);
      }
    });
  </script>
</body>
</html>`;
}
