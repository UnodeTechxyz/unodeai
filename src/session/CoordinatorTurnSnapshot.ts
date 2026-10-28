/**
 * v0.9.99: the team state a coordinator receives once at the start of each of its turns.
 *
 * It replaces rediscovery: the results waiting for a decision, the tasks still running, what the previous turn's
 * dispatches did, the inputs of this turn, and the team, each with the host's ids. It is built once per turn and
 * the turn's retries reuse it unchanged. It is host-authored from typed records only (the run ledger, the team
 * roster, the turn's structured inputs); it never reads a task, result or file body, and it carries no key,
 * endpoint or credential. What the host does not know stays "unknown": no running task is never shown as idle
 * while a backend is stopped or starting.
 *
 * The rendered block is bounded. Sections are filled in priority order and a footer says what was left out.
 */
import type { CoordinatorTaskStatus } from '../backend/TeamTools';
import { estimateTokens } from '../backend/TokenCounter';

export const COORDINATOR_TURN_SNAPSHOT_HEADER = '[Team state for this turn, supplied by UnodeAi]';
export const COORDINATOR_TURN_SNAPSHOT_TOKEN_BUDGET = 2_000;
/** A display field longer than this is cut on a code point boundary. Ids are never cut. */
const FIELD_MAX_CODE_POINTS = 160;
/** Room kept for the footer, which is written last. */
const FOOTER_RESERVE_TOKENS = 80;

export type CoordinatorTurnInputSource = 'attached' | 'named' | 'user-mentioned';

export interface CoordinatorTurnSnapshotInput {
  asOf: Date;
  requestId: string;
  /** Undefined until the ledger has opened the run. */
  runId?: string;
  turnId: string;
  /**
   * Every retained record of this coordinator that still needs attention (see `coordinatorTaskNeedsAttention`),
   * newest first, selected before any limit. Undefined when the host has none to read: unknown, not none.
   */
  tasks?: readonly CoordinatorTaskStatus[];
  /** What the dispatches of the coordinator's previous turn did. Undefined on its first turn or when unknown. */
  previousTurn?: {
    accepted: number;
    refused: ReadonlyArray<{ requestedAgent: string; reason: string }>;
  };
  inputs: ReadonlyArray<{ label: string; source: CoordinatorTurnInputSource }>;
  roster: ReadonlyArray<{ id: string; name: string; role: string; lifecycle?: string; route?: string; model?: string }>;
}

interface Section {
  title: string;
  /** What a section with no rows says. Undefined drops the section when it is empty. */
  empty?: string;
  rows: string[];
  /** Whether the heading gives the number of rows. */
  counted: boolean;
  /** The footer's name for an omitted row of this section. */
  noun: string;
}

export function renderCoordinatorTurnSnapshot(
  input: CoordinatorTurnSnapshotInput,
  budget = COORDINATOR_TURN_SNAPSHOT_TOKEN_BUDGET,
): string {
  const lines = [
    COORDINATOR_TURN_SNAPSHOT_HEADER,
    `As of ${input.asOf.toISOString()} · request ${input.requestId} · run ${input.runId ?? 'not yet recorded'} · turn ${input.turnId}`,
  ];
  const omitted: string[] = [];
  for (const section of sections(input)) {
    if (section.rows.length === 0 && section.empty === undefined) continue;
    const heading = `${section.title}${section.counted && section.rows.length > 0 ? ` (${section.rows.length})` : ''}:`;
    // A heading is shown only with its first row (or its empty line): never a heading with nothing under it.
    if (!fits([...lines, heading, section.rows[0] ?? `- ${section.empty}`], budget)) {
      if (section.rows.length > 0) omitted.push(`${section.rows.length} ${section.noun}`);
      continue;
    }
    lines.push(heading);
    if (section.rows.length === 0) {
      lines.push(`- ${section.empty}`);
      continue;
    }
    let left = 0;
    for (const row of section.rows) {
      if (left === 0 && fits([...lines, row], budget)) lines.push(row);
      else left++;
    }
    if (left > 0) omitted.push(`${left} ${section.noun}`);
  }
  if (omitted.length > 0) {
    lines.push(`Not shown: ${omitted.join(', ')}. Use inspect_task_status for any task. This block is a summary, `
      + 'not the full team record.');
  }
  return lines.join('\n');
}

function fits(lines: readonly string[], budget: number): boolean {
  return estimateTokens(lines.join('\n')) + FOOTER_RESERVE_TOKENS <= budget;
}

/** In priority order: results waiting for a decision, running tasks, the previous turn, this turn's inputs, the team. */
function sections(input: CoordinatorTurnSnapshotInput): Section[] {
  const tasks = input.tasks;
  const waiting = (tasks ?? []).filter(awaitsDecision);
  const running = (tasks ?? []).filter(isRunning);
  const previous = input.previousTurn;
  return [
    {
      title: 'Results waiting for your decision',
      empty: tasks ? 'none recorded' : 'unknown: the host has no task records to read',
      rows: waiting.map((task) => {
        const revision = task.result?.ref ? ` · result revision ${task.result.ref.revision}` : '';
        const outcome = task.evidenceOutcome ? ` · ${task.evidenceOutcome}` : '';
        const why = task.lifecycle === 'interrupted' ? ' · interrupted: record superseded or abandoned' : '';
        const arrived = task.terminalAt ? ` · returned ${task.terminalAt}` : '';
        return `- ${task.handle} · ${agentOf(task)}${revision}${outcome}${why}${arrived}`;
      }),
      counted: true,
      noun: 'waiting results',
    },
    {
      title: 'Running',
      empty: tasks ? 'none recorded' : 'unknown: the host has no task records to read',
      rows: running.map((task) => {
        const elapsed = task.dispatchedAt ? ` · ${task.result?.state === 'awaiting-rework' ? 'rework, ' : ''}`
          + `dispatched ${duration(input.asOf.getTime() - Date.parse(task.dispatchedAt))} ago` : '';
        const execution = task.execution && task.execution.state !== 'running' ? ` · execution ${task.execution.state}` : '';
        return `- ${task.handle} · ${agentOf(task)}${elapsed}${execution}`;
      }),
      counted: true,
      noun: 'running tasks',
    },
    {
      title: 'Your previous turn',
      rows: previous
        ? [
          `- ${previous.accepted} dispatch${previous.accepted === 1 ? '' : 'es'} accepted, ${previous.refused.length} refused`,
          ...previous.refused.map((refusal) => `- refused for ${cut(refusal.requestedAgent)}: ${cut(refusal.reason)}`),
        ]
        : [],
      counted: false,
      noun: 'previous-turn refusals',
    },
    {
      title: 'Inputs of this turn',
      rows: input.inputs.map((entry) => `- ${cut(entry.label)} (${INPUT_SOURCE_TEXT[entry.source]})`),
      counted: true,
      noun: 'inputs',
    },
    {
      title: 'Team',
      rows: input.roster.map((member) => {
        const route = [member.route, member.model].filter(Boolean).map((value) => cut(value!)).join(' ');
        return `- ${member.id} — ${cut(member.name)} (role: ${cut(member.role)}${route ? `; ${route}` : ''}) · ${member.lifecycle ?? 'unknown'}`;
      }),
      counted: true,
      noun: 'teammates',
    },
  ];
}

const INPUT_SOURCE_TEXT: Record<CoordinatorTurnInputSource, string> = {
  attached: 'attached',
  named: 'named with @',
  'user-mentioned': 'mentioned in the request; not opened or verified',
};

/**
 * Whether a task still needs the coordinator's attention: it is running, or its result waits for a decision. The
 * records are selected by this before anything bounds them, so the block's omissions are its own and are counted.
 */
export function coordinatorTaskNeedsAttention(task: CoordinatorTaskStatus): boolean {
  return awaitsDecision(task) || isRunning(task);
}

/** A settled result with no decision on it, or interrupted work nobody has disposed of. */
function awaitsDecision(task: CoordinatorTaskStatus): boolean {
  if (task.result) return task.result.state === 'ready' || task.result.state === 'awaiting-decision';
  if (task.disposition) return false;
  return task.lifecycle === 'settled' || task.lifecycle === 'interrupted';
}

function isRunning(task: CoordinatorTaskStatus): boolean {
  if (task.result?.state === 'awaiting-rework') return true;
  return task.lifecycle === 'active' || (task.lifecycle === 'timed-out' && task.execution?.state === 'running');
}

function agentOf(task: CoordinatorTaskStatus): string {
  return task.agentId ?? (task.requestedAgent ? cut(task.requestedAgent) : 'unknown teammate');
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** ‘ ’, “ ”, 「 」, 『 』 and ". */
const QUOTED = /‘([^’]+)’|“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"]+)"/gu;
const PATH_LIKE = /[/\\]|\.\p{L}[\p{L}\p{N}]{0,7}$/u;

/**
 * Paths a person quoted in their request, listed as strings they mentioned: not opened, not checked, and granting
 * nothing. A quoted string counts when it looks like a path, with a folder separator or a file extension.
 */
export function userMentionedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(QUOTED)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (value && value.length <= 260 && PATH_LIKE.test(value)) found.add(value);
  }
  return [...found];
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = [...flat];
  return points.length <= FIELD_MAX_CODE_POINTS ? flat : `${points.slice(0, FIELD_MAX_CODE_POINTS - 1).join('')}…`;
}
