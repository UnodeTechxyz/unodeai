/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Evidence Report (trust artifact)
 *  Turn a completed crew run into a single, skimmable "here's what actually happened and whether it
 *  was verified" report. This is the moat made tangible: not "the agent says it's done", but the plan,
 *  who did what, the files touched, the checks run, and the verdict. Pure (no I/O) so it's unit-testable;
 *  the orchestrator gathers the inputs (delegation tracker + verify result + changed files) and renders.
 *--------------------------------------------------------------------------------------------*/

export type EvidenceWorkStatus = 'done' | 'working' | 'blocked';

export interface EvidenceAgentWork {
  agentName: string;
  task: string;
  status: EvidenceWorkStatus;
  /** Short result/outcome line from the teammate (already trimmed by the caller). */
  result?: string;
  /** Fix cycles this teammate took before finishing (from the robustness ladder), if known. */
  retries?: number;
}

export interface EvidenceChecks {
  command: string;
  passed: boolean;
  /** Tail of the checks output, shown when failed. */
  outputTail?: string;
}

export interface EvidenceInput {
  goal: string;
  coordinatorName?: string;
  agents: EvidenceAgentWork[];
  /** Workspace-relative paths the run modified. */
  filesChanged: string[];
  checks?: EvidenceChecks;
  /** True when the objective checks passed (or there was nothing to verify and the caller deems it ok). */
  verified: boolean;
  /** True when the verifier gate exhausted its budget and handed off to a human. */
  blocked?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export type EvidenceVerdict = 'verified' | 'unverified' | 'blocked';

/** The headline verdict: blocked beats unverified beats verified (most-severe wins). */
export function evidenceVerdict(input: Pick<EvidenceInput, 'verified' | 'blocked'>): EvidenceVerdict {
  if (input.blocked) { return 'blocked'; }
  return input.verified ? 'verified' : 'unverified';
}

const VERDICT_LINE: Record<EvidenceVerdict, string> = {
  verified: '✅ Verified — checks passed',
  unverified: '⚠ Unverified — work landed but checks did not confirm it',
  blocked: '🚧 Blocked — needs a human (checks still failing after the crew tried)',
};

const STATUS_EMOJI: Record<EvidenceWorkStatus, string> = { done: '✅', working: '⏳', blocked: '🚧' };

function oneLine(s: string | undefined, max = 140): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function duration(startedAt?: string, completedAt?: string): string {
  if (!startedAt || !completedAt) { return ''; }
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) { return ''; }
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Render a Markdown Evidence Report. Deterministic and side-effect-free. The caller decides where it
 * goes (chat artifact, a saved `.md`, the report column) — this only produces the text.
 */
export function buildEvidenceReport(input: EvidenceInput): string {
  const verdict = evidenceVerdict(input);
  const dur = duration(input.startedAt, input.completedAt);
  const crew = input.coordinatorName
    ? `${input.coordinatorName} + ${input.agents.length} teammate${input.agents.length === 1 ? '' : 's'}`
    : `${input.agents.length} agent${input.agents.length === 1 ? '' : 's'}`;

  const lines: string[] = [];
  lines.push(`# Evidence Report — ${oneLine(input.goal, 120) || 'task'}`);
  lines.push('');
  lines.push(`**Verdict:** ${VERDICT_LINE[verdict]}`);
  lines.push(`**Crew:** ${crew}${dur ? ` · **Duration:** ${dur}` : ''}`);
  lines.push('');

  lines.push('## Work done');
  if (input.agents.length === 0) {
    lines.push('_No delegated work recorded._');
  } else {
    for (const a of input.agents) {
      const retry = a.retries && a.retries > 0 ? ` _(after ${a.retries} fix ${a.retries === 1 ? 'cycle' : 'cycles'})_` : '';
      const result = a.result ? ` — ${oneLine(a.result)}` : '';
      lines.push(`- ${STATUS_EMOJI[a.status]} **${a.agentName}**: ${oneLine(a.task)}${result}${retry}`);
    }
  }
  lines.push('');

  lines.push(`## Files changed (${input.filesChanged.length})`);
  if (input.filesChanged.length === 0) {
    lines.push('_No files were modified._');
  } else {
    for (const f of input.filesChanged) { lines.push(`- \`${f}\``); }
  }
  lines.push('');

  lines.push('## Verification');
  if (!input.checks) {
    lines.push('_No verification command was configured (`unode.verifyCommand`), so checks were not run._');
  } else {
    lines.push(`\`${input.checks.command}\` → ${input.checks.passed ? '✅ passed' : '❌ failed'}`);
    if (!input.checks.passed && input.checks.outputTail) {
      lines.push('');
      lines.push('```');
      lines.push(input.checks.outputTail.trimEnd());
      lines.push('```');
    }
  }

  if (verdict !== 'verified') {
    lines.push('');
    lines.push('## Open items');
    lines.push(verdict === 'blocked'
      ? '- The crew could not get the checks to pass within its retry budget. Retry with a stronger model, reassign, or take it over.'
      : '- Work was applied but not confirmed by the project checks. Set/run `unode.verifyCommand` to verify before relying on it.');
  }

  return lines.join('\n');
}
