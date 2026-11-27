/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Task history: the host side of the page (v0.9.110 H1, design §4.4, §5, §3.3)
 *
 *  The page sends only task ids, revisions and filter values; the host reads the history, resolves every id against
 *  what it showed, and answers with display text. Nothing from the page is a path, a payload or an authority.
 *  Reading, searching, favourites and Resume ask nothing; deleting asks the person to confirm what it removes.
 *
 *  Resume fills the composer with a fixed local template (the saved goal, at most the last 2,000 code points of the
 *  saved result, the files the task changed) and sends nothing: no model, network or cost, no new request until the
 *  person presses Send. No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import type { ChatHistoryMessage } from './chatHistory';
import type { HistoryDeletionReport, HistoryService } from '../history/HistoryService';
import { HistoryConflictError, type HistoryFilter, type HistoryStore, type HistoryUsage } from '../history/HistoryStore';
import type { HistoryTaskV1, HistoryTerminal, HistoryVerification, TaskDeletionScope } from '../history/HistoryRecords';
import type { RecoveryManifestV1 } from '../history/RecoveryManifest';
import type { RequestChecksObservation } from '../observability/RequestCloseout';
import { completionCheckLabel } from '../observability/CompletionCheckObservation';

export const RESUME_RESULT_CODE_POINTS = 2_000;
const ROW_GOAL_CHARS = 300;
/** Saved references a Resume draft lists at most. */
const MAX_REFERENCES = 50;

export type TaskHistoryInbound =
  | { command: 'ready' }
  | { command: 'query'; filter: TaskHistoryFilterInput }
  | { command: 'more' }
  | { command: 'details'; historyId: string }
  | { command: 'favourite'; historyId: string; revision: number; value: boolean }
  | { command: 'resume'; historyId: string }
  | { command: 'storage' }
  | { command: 'delete'; historyId: string; revision: number; scope: TaskDeletionScope }
  | { command: 'deleteAll' };

export interface TaskHistoryFilterInput {
  text?: string;
  agentId?: string;
  terminal?: HistoryTerminal;
  verification?: HistoryVerification;
  favouritesOnly?: boolean;
  /** `YYYY-MM-DD`, inclusive. */
  since?: string;
  until?: string;
}

export interface TaskHistoryRowView {
  historyId: string;
  revision: number;
  goal: string;
  member: string;
  date: string;
  terminal: string;
  verification: string;
  favourite: boolean;
  legacy: boolean;
}

export interface TaskHistoryDetailsView extends TaskHistoryRowView {
  /** The whole saved result, not an excerpt. */
  conclusion?: string;
  /** What the request's closeout record says about the checks the host ran, or that none was recorded. */
  checks: string;
  transcript: Array<{ role: 'user' | 'agent'; from: string; text: string; time: string }>;
  coverage: string;
  coverageDetail: string;
  memberExists: boolean;
}

export type TaskHistoryOutbound =
  | { command: 'page'; append: boolean; rows: TaskHistoryRowView[]; more: boolean; gaps: number; readOnly?: string;
    members: Array<{ id: string; name: string }> }
  | { command: 'loading' }
  /** `refresh`: the details are shown again after a change; the page applies it only to the details it has open. */
  | { command: 'details'; task: TaskHistoryDetailsView; refresh?: true }
  | { command: 'detailsGone'; historyId: string; refresh?: true }
  | { command: 'favourite'; historyId: string; revision: number; favourite: boolean; conflict: boolean }
  | { command: 'storage'; lines: string[] }
  | { command: 'report'; lines: string[] }
  | { command: 'notice'; text: string }
  /** The draft is in the composer: the view steps aside so it can be edited and sent. */
  | { command: 'resumed' };

export interface TaskHistoryControllerDeps {
  history: Pick<HistoryService, 'store' | 'deleteTasks' | 'deleteAll' | 'syncProtection' | 'checkedManifest'>;
  members: () => Array<{ id: string; name: string }>;
  /** The member whose composer the person is using now; undefined when none is selected. */
  selectedMember: () => string | undefined;
  /** Put text into a member's composer as an ordinary draft; never sends. */
  insertIntoComposer: (agentId: string, text: string) => boolean;
  /** The person picks an existing member (the task's member was removed, or none is selected); undefined: cancelled. */
  pickMember: (members: Array<{ id: string; name: string }>) => Promise<string | undefined>;
  /** The checks of the request's closeout record, by its root member and outcome references; undefined: none recorded. */
  checks?: (agentId: string, outcomeRefs: readonly string[]) => RequestChecksObservation | undefined;
  /** The person confirms a deletion, told exactly what it removes; false keeps everything. */
  confirm: (title: string, detail: string) => Promise<boolean>;
  post: (message: TaskHistoryOutbound) => void;
  now?: () => number;
}

const TERMINAL_LABELS: Record<HistoryTerminal, string> = {
  running: 'Running', unfinished: 'Not finished', blocked: 'Blocked', failed: 'Failed', completed: 'Completed', interrupted: 'Interrupted',
};
const VERIFICATION_LABELS: Record<HistoryVerification, string> = {
  verified: 'Verified', failed: 'Check failed', 'not-verified': 'Not verified', unknown: 'Verification unknown',
};
const ID = /^[A-Za-z0-9._:-]{1,300}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict reading of what the page sent; anything else is ignored. */
export function parseTaskHistoryMessage(raw: unknown): TaskHistoryInbound | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const id = (key: string) => (typeof value[key] === 'string' && ID.test(value[key] as string) ? value[key] as string : undefined);
  const revision = typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : undefined;
  switch (value.command) {
    case 'ready': case 'more': case 'storage': case 'deleteAll':
      return { command: value.command };
    case 'details': case 'resume': {
      const historyId = id('historyId');
      return historyId ? { command: value.command, historyId } : undefined;
    }
    case 'favourite': {
      const historyId = id('historyId');
      return historyId && revision !== undefined && typeof value.value === 'boolean'
        ? { command: 'favourite', historyId, revision, value: value.value } : undefined;
    }
    case 'delete': {
      const historyId = id('historyId');
      const scope = value.scope;
      return historyId && revision !== undefined && (scope === 'view' || scope === 'restore-points' || scope === 'both')
        ? { command: 'delete', historyId, revision, scope } : undefined;
    }
    case 'query': {
      const filter = (value.filter ?? {}) as Record<string, unknown>;
      const text = typeof filter.text === 'string' ? filter.text.slice(0, 200) : undefined;
      const agentId = typeof filter.agentId === 'string' && ID.test(filter.agentId) ? filter.agentId : undefined;
      const terminal = typeof filter.terminal === 'string' && filter.terminal in TERMINAL_LABELS ? filter.terminal as HistoryTerminal : undefined;
      const verification = typeof filter.verification === 'string' && filter.verification in VERIFICATION_LABELS
        ? filter.verification as HistoryVerification : undefined;
      const since = typeof filter.since === 'string' && DATE.test(filter.since) ? filter.since : undefined;
      const until = typeof filter.until === 'string' && DATE.test(filter.until) ? filter.until : undefined;
      return { command: 'query', filter: { ...(text ? { text } : {}), ...(agentId ? { agentId } : {}), ...(terminal ? { terminal } : {}),
        ...(verification ? { verification } : {}), ...(filter.favouritesOnly === true ? { favouritesOnly: true } : {}),
        ...(since ? { since } : {}), ...(until ? { until } : {}) } };
    }
    default:
      return undefined;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function day(iso: string | undefined): string {
  return iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : '';
}

/** The member's name as the task recorded it: the replies carry it, so a removed member keeps its name. */
function memberName(task: HistoryTaskV1, transcript: readonly ChatHistoryMessage[] | undefined, members: Array<{ id: string; name: string }>): string {
  const recorded = transcript?.find((message) => message.role === 'agent' && message.fromName)?.fromName;
  return recorded ?? members.find((member) => member.id === task.agentId)?.name ?? 'Removed member';
}

/** What the restore manifest says, for the person; never more than was recorded. */
export function coverageText(manifest: RecoveryManifestV1 | undefined, legacy: boolean): { label: string; detail: string } {
  if (legacy) return { label: 'History not recorded', detail: 'This task was found in an older chat: its request, outcome and restore points were not recorded.' };
  if (!manifest) return { label: 'No recorded file changes', detail: 'The host recorded no file change for this task.' };
  if (manifest.restorePointsDeleted) return { label: 'Not revertible', detail: 'Its restore points were deleted.' };
  const notReversed = manifest.notReversed.length > 0
    ? ` Not reversed: ${manifest.notReversed.map((entry) => entry.path ?? 'changes by a command or a provider tool').join(', ')}.` : '';
  return { label: manifest.label, detail: `${manifest.files.length} file(s) recorded.${notReversed}` };
}

/**
 * The references a saved result makes (Markdown links and web addresses), from the whole result, not only the part a
 * Resume draft quotes.
 */
export function savedReferences(text: string | undefined): string[] {
  if (!text) return [];
  const references: string[] = [];
  const targets = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g)) {
    if (targets.has(match[2])) continue;
    targets.add(match[2]);
    references.push(`${match[1]}: ${match[2]}`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>]{1,2000}/g)) {
    if (targets.has(match[0])) continue;
    targets.add(match[0]);
    references.push(match[0]);
  }
  return references.slice(0, MAX_REFERENCES);
}

/** The checks one closeout record holds, as one line; none recorded is said so, never shown as passed. */
export function checksText(checks: RequestChecksObservation | undefined, legacy: boolean): string {
  if (legacy) return 'Checks: not recorded (found in an older chat).';
  if (!checks) return 'Checks: no closeout record of this request was found.';
  if (checks.coverage === 'unavailable' || checks.coverage === 'excluded') return 'Checks: this route does not report them.';
  const parts = [`${checks.passed} passed`, `${checks.failed} failed`];
  if (checks.refused > 0) parts.push(`${checks.refused} not run`);
  const last = checks.lastCompletionCheck ? `; completion check ${completionCheckLabel(checks.lastCompletionCheck)}` : '';
  return `Checks the host ran: ${parts.join(', ')}${last}.`;
}

/**
 * The Resume draft: fixed text from what was saved, nothing read or generated. The result keeps its last
 * `RESUME_RESULT_CODE_POINTS` code points and says when it was cut; a missing result says so.
 */
export function resumeDraft(task: HistoryTaskV1, member: string, manifest: RecoveryManifestV1 | undefined): string {
  const lines = [`[Continuing an earlier task from Task history: ${member}, ${day(task.startedAt)}. This is a new request; nothing from it is run again.]`, '',
    'Goal (as sent):', task.goal, ''];
  if (task.conclusion === undefined) {
    lines.push('Final result: not recorded.');
  } else {
    const points = Array.from(task.conclusion);
    const cut = points.length > RESUME_RESULT_CODE_POINTS;
    lines.push(cut ? `Final result (its last ${RESUME_RESULT_CODE_POINTS} characters; the beginning is cut):` : 'Final result:',
      cut ? points.slice(-RESUME_RESULT_CODE_POINTS).join('') : task.conclusion);
  }
  // The result's own references come from the whole saved result, whatever the excerpt above keeps.
  const references = savedReferences(task.conclusion);
  if (references.length > 0) {
    lines.push('', 'References in that result (historical):');
    for (const reference of references) lines.push(`- ${reference}`);
  }
  const files = manifest && !manifest.restorePointsDeleted ? manifest.files : [];
  if (files.length > 0) {
    lines.push('', 'Files that task changed (historical: read them again before relying on them):');
    for (const file of files) lines.push(`- ${file.displayPath}`);
  }
  return lines.join('\n');
}

function reportLines(report: HistoryDeletionReport, all: boolean): string[] {
  if (report.status === 'failed') return [`Nothing was deleted: ${report.reason ?? 'the history could not be changed'}.`];
  const lines = [`Deleted: ${report.tasksDeleted} task(s), ${report.messagesDeleted} message(s), ${report.restorePointsRemoved} restore point(s).`];
  if (report.localCopiesRemoved) {
    lines.push(`Also deleted: ${report.localCopiesRemoved.editHistoryRecords} Edit history record(s) with their text copies, `
      + `and ${report.localCopiesRemoved.archivedChats} archived chat(s).`);
  }
  if (report.status === 'partial') {
    lines.push(`Not everything could be removed; deleting again tries once more: ${report.remaining.join('; ')}.`);
  }
  if (report.restorePointsKept > 0) {
    lines.push(`Kept: ${report.restorePointsKept} restore point(s) still in use by running work; delete again once it has ended. `
      + `Files: ${report.restorePointsKeptFiles.join(', ')}.`);
  }
  if (all && report.runningTasksKept > 0) lines.push(`Kept: ${report.runningTasksKept} running task(s) and their conversation.`);
  lines.push('Not history, so not deleted: your workspace files, Spend records, approvals, and the file-effect and outcome records of past requests.');
  return lines;
}

export class TaskHistoryController {
  private filter: HistoryFilter = {};
  private cursor: string | undefined;
  /** The tasks the page was shown, by id: an id the host did not show is not acted on. */
  private readonly shown = new Map<string, HistoryTaskV1>();
  /** The task whose details were last shown: a deletion shows them again as they are now. */
  private detailsShown?: string;
  private readonly now: () => number;

  constructor(private readonly deps: TaskHistoryControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async handle(raw: unknown): Promise<void> {
    const message = parseTaskHistoryMessage(raw);
    if (!message) return;
    switch (message.command) {
      case 'ready': return this.load(false);
      case 'query': this.filter = toFilter(message.filter); return this.load(false);
      case 'more': return this.load(true);
      case 'details': return this.details(message.historyId);
      case 'favourite': return this.favourite(message.historyId, message.revision, message.value);
      case 'resume': return this.resume(message.historyId);
      case 'storage': return this.storage();
      case 'delete': return this.delete(message.historyId, message.revision, message.scope);
      case 'deleteAll': return this.deleteAll();
    }
  }

  private async store(): Promise<HistoryStore | undefined> {
    const store = await this.deps.history.store();
    if (!store) this.deps.post({ command: 'notice', text: 'Task history is not available in this window.' });
    return store;
  }

  private async load(append: boolean): Promise<void> {
    const store = await this.store();
    if (!store) return;
    if (!append) { this.cursor = undefined; this.shown.clear(); }
    else if (!this.cursor) return;
    this.deps.post({ command: 'loading' });
    const page = await store.query(this.filter, append ? this.cursor : undefined);
    this.cursor = page.nextCursor;
    const members = this.deps.members();
    const rows: TaskHistoryRowView[] = [];
    for (const task of page.tasks) {
      this.shown.set(task.historyId, task);
      rows.push(this.row(task, await store.taskTranscript(task.historyId), members));
    }
    this.deps.post({ command: 'page', append, rows, more: !!page.nextCursor, gaps: page.gaps.length,
      ...(page.readOnly ? { readOnly: page.readOnly } : {}), members });
  }

  private row(task: HistoryTaskV1, transcript: readonly ChatHistoryMessage[] | undefined, members: Array<{ id: string; name: string }>): TaskHistoryRowView {
    return {
      historyId: task.historyId, revision: task.revision, goal: clip(task.goal, ROW_GOAL_CHARS), member: memberName(task, transcript, members),
      date: day(task.startedAt), terminal: task.legacy ? 'History not recorded' : TERMINAL_LABELS[task.terminal],
      verification: task.legacy ? '' : VERIFICATION_LABELS[task.verification], favourite: task.favourite, legacy: task.legacy,
    };
  }

  private async details(historyId: string, refresh = false): Promise<void> {
    if (!refresh && !this.shown.has(historyId)) return;
    const store = await this.store();
    if (!store) return;
    const task = await store.task(historyId);
    if (!task) {
      this.detailsShown = undefined;
      this.deps.post({ command: 'detailsGone', historyId, ...(refresh ? { refresh: true as const } : {}) });
      return;
    }
    this.shown.set(historyId, task);
    this.detailsShown = historyId;
    const transcript = await store.taskTranscript(historyId) ?? [];
    const members = this.deps.members();
    const coverage = coverageText(task.rootRequestId ? await this.deps.history.checkedManifest(task.rootRequestId) : undefined, task.legacy);
    // The whole saved transcript and result: the history keeps them, and the view shows them in full.
    this.deps.post({ command: 'details', task: {
      ...this.row(task, transcript, members),
      ...(task.conclusion !== undefined ? { conclusion: task.conclusion } : {}),
      checks: checksText(task.legacy ? undefined : this.deps.checks?.(task.agentId, task.outcomeRefs), task.legacy),
      transcript: transcript.map((message) => ({ role: message.role, from: message.role === 'user' ? 'You' : message.fromName ?? 'Agent',
        text: message.text, time: message.ts })),
      coverage: coverage.label, coverageDetail: coverage.detail,
      memberExists: members.some((member) => member.id === task.agentId),
    }, ...(refresh ? { refresh: true as const } : {}) });
  }

  /**
   * After a deletion, the details last shown say what is true now: the coverage of deleted restore points, or that
   * the task is gone. The task stays one the page was shown even when the reloaded list no longer holds it.
   */
  private async refreshDetails(): Promise<void> {
    if (this.detailsShown) await this.details(this.detailsShown, true);
  }

  /** Compare-and-set: a task changed since it was shown is read again and shown as it is; nothing is forced. */
  private async favourite(historyId: string, revision: number, value: boolean): Promise<void> {
    if (!this.shown.has(historyId)) return;
    const store = await this.store();
    if (!store) return;
    let conflict = false;
    try {
      await store.setFavourite(historyId, revision, value);
    } catch (error) {
      if (!(error instanceof HistoryConflictError)) {
        this.deps.post({ command: 'notice', text: `The favourite was not saved: ${(error as Error).message}` });
      }
      conflict = true;
    }
    // A favourite's restore points are held with it, and a task no longer favourite lets them go.
    await this.deps.history.syncProtection();
    const task = await store.task(historyId);
    if (!task) { this.deps.post({ command: 'detailsGone', historyId }); return; }
    this.shown.set(historyId, task);
    this.deps.post({ command: 'favourite', historyId, revision: task.revision, favourite: task.favourite, conflict });
  }

  private async resume(historyId: string): Promise<void> {
    const shown = this.shown.get(historyId);
    if (!shown) return;
    const store = await this.store();
    if (!store) return;
    const task = await store.task(historyId) ?? shown;
    const members = this.deps.members();
    const originalExists = members.some((member) => member.id === task.agentId);
    const selected = this.deps.selectedMember();
    // The draft goes to the composer the person is using now, with its member, route and permissions. When the task's
    // member was removed, the person first chooses who continues; nothing is ever moved to another member silently.
    const agentId = originalExists && selected && members.some((member) => member.id === selected)
      ? selected : await this.deps.pickMember(members);
    if (!agentId) return;
    const transcript = await store.taskTranscript(historyId);
    const draft = resumeDraft(task, memberName(task, transcript, members), task.rootRequestId ? store.recoveryManifest(task.rootRequestId) : undefined);
    if (!this.deps.insertIntoComposer(agentId, draft)) {
      this.deps.post({ command: 'notice', text: 'The draft could not be put into the message box.' });
      return;
    }
    this.deps.post({ command: 'resumed' });
  }

  private async storage(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    const usage = await store.usage();
    this.deps.post({ command: 'storage', lines: usageLines(usage) });
  }

  private async delete(historyId: string, revision: number, scope: TaskDeletionScope): Promise<void> {
    const shown = this.shown.get(historyId);
    if (!shown) return;
    const what = scope === 'view'
      ? 'Remove the conversation of this task from Task history and from the chat. Its file changes stay as they are.'
      : scope === 'restore-points'
        ? 'Delete the restore points this task kept. Its files are not changed, but the task can no longer be reverted, and Undo or Redo of a restore of it ends.'
        : 'Remove the conversation of this task and delete its restore points. Its files are not changed; it can no longer be reverted.';
    const confirmed = await this.deps.confirm(`Delete from Task history: ${clip(shown.goal, 80)}`,
      `${what} Workspace files, Spend records, approvals and the outcome records are not deleted.`);
    if (!confirmed) return;
    const store = await this.store();
    if (!store) return;
    const now = await store.task(historyId);
    if (!now || now.revision !== revision) {
      this.deps.post({ command: 'notice', text: 'This task changed since it was shown; nothing was deleted. Look at it again first.' });
      return this.details(historyId);
    }
    const report = await this.deps.history.deleteTasks([historyId], scope);
    this.deps.post({ command: 'report', lines: reportLines(report, false) });
    await this.load(false);
    await this.refreshDetails();
  }

  private async deleteAll(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    const usage = await store.usage();
    const confirmed = await this.deps.confirm('Delete all history and restore points of this workspace?',
      `${usage.tasks} task(s), ${usage.favourites} of them favourites, about ${mib(usage.bytes)} of conversation, and their restore points, `
      + 'with the Edit history and the archived chats. '
      + 'Favourites are included. Undo and Redo of earlier restores end. Running tasks are kept. '
      + 'Your workspace files, Spend records, approvals and the outcome records are not deleted.');
    if (!confirmed) return;
    const report = await this.deps.history.deleteAll(this.deps.members().map((member) => member.id));
    this.deps.post({ command: 'report', lines: reportLines(report, true) });
    await this.load(false);
    await this.refreshDetails();
  }
}

function toFilter(input: TaskHistoryFilterInput): HistoryFilter {
  return {
    ...(input.text ? { text: input.text } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.terminal ? { terminal: input.terminal } : {}),
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.favouritesOnly ? { favourite: true } : {}),
    ...(input.since ? { since: `${input.since}T00:00:00.000Z` } : {}),
    ...(input.until ? { until: `${input.until}T23:59:59.999Z` } : {}),
  };
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function usageLines(usage: HistoryUsage): string[] {
  return [
    `${usage.tasks} task(s) in this workspace's history (${usage.endedTasks} ended, ${usage.running} running, ${usage.favourites} favourites).`,
    `Conversation and metadata: about ${mib(usage.bytes)} of 16 MiB.`,
    'Kept up to 30 days, 1,000 ended tasks or 16 MiB, whichever comes first; the oldest tasks that are not favourites go first. '
    + 'Favourites and running tasks are never removed automatically.',
    'Restore points: up to 256 MiB, 30 days and 200 entries per workspace.',
  ];
}
