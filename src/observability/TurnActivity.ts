/** Bounded presentation facts for one turn, never a task ledger, execution proof, or replay authority. */
import { interruptionReason, interruptionRetryReason, parseTurnInterruption, type TurnInterruptionV1 } from '../backend/TurnInterruption';
import { isPortableRelativePath } from './PortableRunEvidence';
import { MAX_REQUEST_COUNT } from './RequestCloseoutBounds';
import type { FileEffectGrade, RequestChangeOperation } from './RequestCloseout';

export const MAX_ACTIVITY_NAMES = 32;
export const MAX_ACTIVITY_PATHS = 20;
export const MAX_ACTIVITY_CALLS = 1024;
export const ACTIVITY_TOOLS = [
  'read_file', 'read_extracted_content', 'list_dir', 'search_files', 'inspect_git_tag',
  'write_file', 'apply_edit', 'apply_patch', 'delete_file', 'delete_directory', 'run_command', 'run_checks',
  'list_agents', 'assign_task', 'assign_tasks', 'wait_for_agent', 'check_task_status', 'collect_results',
  'accept_task', 'reject_task', 'update_todos', 'save_task_checkpoint', 'save_attachment', 'write_document', 'read_content_asset',
  'list_content_assets', 'describe_image', 'send_image_asset_to_model', 'read_shared_memory', 'write_shared_memory',
  'search_web', 'fetch_web', 'dispatch_task', 'collect_ready_tasks', 'close_assignment', 'record_task_disposition', 'native-tool',
] as const;
export type ActivityTool = typeof ACTIVITY_TOOLS[number];
export const ACTIVITY_DISPOSITIONS = ['accepted', 'rejected', 'needs-human', 'needs-rework', 'deferred',
  'accepted-with-caveat', 'accepted-after-rework', 'accepted-despite-framework-no-evidence', 'superseded', 'abandoned'] as const;
export interface ActivityToolCounts { tool: ActivityTool; success: number; refused: number; failed: number; unfinished: number }
export interface TurnActivityV1 {
  schemaVersion: 1;
  coverage: 'complete' | 'partial' | 'unavailable';
  tools: ActivityToolCounts[];
  reads: string[];
  changes: Array<{ path: string; operation: RequestChangeOperation; evidence: FileEffectGrade }>;
  decisions: Array<{ disposition: typeof ACTIVITY_DISPOSITIONS[number]; count: number }>;
  todoUpdates: number;
  dispatch?: { accepted: number; refused: number; pending: number };
  lastUnfinished?: ActivityTool;
  /** Counts omitted observations, not an assertion about distinct unlisted files/calls. */
  omitted: { events: number; reads: number; changes: number };
}
export function activityTool(name: string): ActivityTool {
  return (ACTIVITY_TOOLS as readonly string[]).includes(name) ? name as ActivityTool : 'native-tool';
}
export function activityPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw)) return undefined;
  const path = raw.replace(/\\/g, '/');
  return path.length <= 240 && isPortableRelativePath(path) ? path : undefined;
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REQUEST_COUNT;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolLabel = (value: unknown): value is ActivityTool => typeof value === 'string' && (ACTIVITY_TOOLS as readonly string[]).includes(value);
export function unavailableTurnActivity(): TurnActivityV1 {
  return { schemaVersion: 1, coverage: 'unavailable', tools: [], reads: [], changes: [], decisions: [], todoUpdates: 0,
    omitted: { events: 0, reads: 0, changes: 0 } };
}

/** Fixed fields only; malformed optional activity can be replaced with unavailable without losing core closeout. */
export function parseTurnActivity(raw: unknown): TurnActivityV1 | undefined {
  try {
    const value = object(raw);
    if (!value || value.schemaVersion !== 1 || !['complete', 'partial', 'unavailable'].includes(value.coverage as string)
      || !Array.isArray(value.tools) || value.tools.length > MAX_ACTIVITY_NAMES
      || !Array.isArray(value.reads) || value.reads.length > MAX_ACTIVITY_PATHS
      || !Array.isArray(value.changes) || value.changes.length > MAX_ACTIVITY_PATHS
      || !Array.isArray(value.decisions) || value.decisions.length > ACTIVITY_DISPOSITIONS.length || !count(value.todoUpdates)) return undefined;
    const tools: ActivityToolCounts[] = [];
    let total = 0;
    for (const raw of value.tools) {
      const entry = object(raw);
      if (!entry || !toolLabel(entry.tool) || tools.some(item => item.tool === entry.tool)
        || !count(entry.success) || !count(entry.refused) || !count(entry.failed) || !count(entry.unfinished)) return undefined;
      total += entry.success + entry.refused + entry.failed + entry.unfinished;
      if (!count(total)) return undefined;
      tools.push({ tool: entry.tool, success: entry.success, refused: entry.refused, failed: entry.failed, unfinished: entry.unfinished });
    }
    const reads: string[] = [];
    for (const path of value.reads) {
      if (typeof path !== 'string' || activityPath(path) !== path || reads.includes(path)) return undefined;
      reads.push(path as string);
    }
    const changes: TurnActivityV1['changes'] = [];
    for (const raw of value.changes) {
      const entry = object(raw);
      if (!entry || typeof entry.path !== 'string' || activityPath(entry.path) !== entry.path
        || changes.some(item => item.path === entry.path) || !['write', 'delete-file', 'delete-directory'].includes(entry.operation as string)
        || !['host-verified', 'native-observed', 'effect-uncertain'].includes(entry.evidence as string)) return undefined;
      changes.push({ path: entry.path, operation: entry.operation as RequestChangeOperation, evidence: entry.evidence as FileEffectGrade });
    }
    const decisions: TurnActivityV1['decisions'] = [];
    for (const raw of value.decisions) {
      const entry = object(raw);
      if (!entry || !(ACTIVITY_DISPOSITIONS as readonly unknown[]).includes(entry.disposition) || !count(entry.count)
        || decisions.some(item => item.disposition === entry.disposition)) return undefined;
      decisions.push({ disposition: entry.disposition as TurnActivityV1['decisions'][number]['disposition'], count: entry.count });
    }
    const omitted = object(value.omitted);
    if (!omitted || !count(omitted.events) || !count(omitted.reads) || !count(omitted.changes)
      || value.lastUnfinished !== undefined && (!toolLabel(value.lastUnfinished) || !tools.some(item => item.tool === value.lastUnfinished && item.unfinished > 0))) return undefined;
    let dispatch: TurnActivityV1['dispatch'];
    if (value.dispatch !== undefined) {
      const entry = object(value.dispatch);
      if (!entry || !count(entry.accepted) || !count(entry.refused) || !count(entry.pending)) return undefined;
      dispatch = { accepted: entry.accepted, refused: entry.refused, pending: entry.pending };
    }
    if (value.coverage === 'complete' && (omitted.events + omitted.reads + omitted.changes > 0 || tools.some(item => item.tool === 'native-tool' || item.unfinished > 0))) return undefined;
    if (value.coverage === 'unavailable' && (total > 0 || reads.length || changes.length || decisions.length || value.todoUpdates || dispatch || value.lastUnfinished)) return undefined;
    return { schemaVersion: 1, coverage: value.coverage as TurnActivityV1['coverage'], tools, reads, changes, decisions, todoUpdates: value.todoUpdates,
      ...(dispatch ? { dispatch } : {}), ...(value.lastUnfinished ? { lastUnfinished: value.lastUnfinished as ActivityTool } : {}),
      omitted: { events: omitted.events, reads: omitted.reads, changes: omitted.changes } };
  } catch { return undefined; }
}

const quotedPath = (path: string) => path.replace(/[\\`*_[\]<>|~#()!]/g, character => `\\${character}`);
/** Read-only progress, not a terminal outcome or an instruction to retry. */
export function ongoingTurnSummary(rawActivity?: TurnActivityV1): string {
  const activity = parseTurnActivity(rawActivity);
  const lines = ['This task is still running. UnodeAi has not stopped or restarted it.'];
  if (!activity || activity.coverage === 'unavailable') {
    lines.push('Progress details are not available; this does not mean no work has happened.');
  } else {
    const completed = activity.tools.filter(tool => tool.success + tool.refused + tool.failed > 0);
    lines.push(completed.length
      ? 'Recorded operations: ' + completed.map(tool => `${tool.tool}: ${tool.success} succeeded, ${tool.refused} not allowed, ${tool.failed} failed`).join('; ') + '.'
      : 'No completed operation has been recorded yet.');
    if (activity.reads.length) lines.push('Files read: ' + activity.reads.map(quotedPath).join(', ') + '.');
    if (activity.changes.length) lines.push('File observations: ' + activity.changes.map(change =>
      `${quotedPath(change.path)} (${change.evidence === 'host-verified' ? 'confirmed by UnodeAi'
        : change.evidence === 'native-observed' ? 'reported by the CLI' : 'change not confirmed'})`).join(', ') + '.');
    if (activity.dispatch) lines.push(`Dispatch records: ${activity.dispatch.accepted} accepted, ${activity.dispatch.refused} not accepted, ${activity.dispatch.pending} pending. These counts do not establish current worker status.`);
    if (activity.decisions.length) lines.push('Recorded task decisions: ' + activity.decisions.map(item => `${item.disposition.replaceAll('-', ' ')}: ${item.count}`).join(', ') + '.');
    const unfinished = activity.tools.filter(tool => tool.unfinished > 0);
    lines.push(unfinished.length
      ? 'Still awaiting a recorded result: ' + unfinished.map(tool => `${tool.tool} (${tool.unfinished})`).join(', ') + '.'
      : 'Still pending: the model has not finished this turn.');
    if (activity.coverage === 'partial') lines.push('Only the work visible to UnodeAi is listed; the provider may be doing other work.');
  }
  lines.push('Execution continues. Use Stop if you want to end the task.');
  return lines.join('\n\n');
}

/** The sole prose is fixed host wording. Paths/counts/enums come from the same strict, per-turn projection. */
export function interruptedTurnSummary(interruption: TurnInterruptionV1, rawActivity?: TurnActivityV1): string {
  const reason = parseTurnInterruption(interruption);
  if (!reason) return 'This turn was interrupted by an error and did not finish normally.';
  const activity = parseTurnActivity(rawActivity);
  const lines = [interruptionReason(reason)];
  if (!activity || activity.coverage === 'unavailable') lines.push('Host observations for this turn are unavailable; no zero-work claim is made.');
  else {
    lines.push('Host-observed work in this turn only:');
    if (activity.tools.length) lines.push(activity.tools.map(tool =>
      `${tool.tool}: ${tool.success} succeeded, ${tool.refused} refused, ${tool.failed} failed, ${tool.unfinished} without a confirmed result`).join('; ') + '.');
    else lines.push('No completed operation was recorded in the available host observations.');
    if (activity.reads.length) lines.push(`Files read: ${activity.reads.map(quotedPath).join(', ')}.`);
    if (activity.changes.length) lines.push('File effects: ' + activity.changes.map(change =>
      `${quotedPath(change.path)} (${change.operation}, ${change.evidence})`).join('; ') + '.');
    if (activity.decisions.length) lines.push('Recorded task decisions: ' + activity.decisions.map(item => `${item.disposition}: ${item.count}`).join(', ') + '.');
    if (activity.todoUpdates) lines.push(`Recorded task-list updates: ${activity.todoUpdates}.`);
    if (activity.dispatch) lines.push(`Dispatches recorded this turn: ${activity.dispatch.accepted} accepted, ${activity.dispatch.refused} refused, ${activity.dispatch.pending} pending. These counts do not establish current worker status.`);
    if (activity.coverage === 'partial') lines.push('These observations are partial; other work or missing results may exist.');
    if (activity.lastUnfinished) lines.push(`The last observed operation without a confirmed result was ${activity.lastUnfinished}.`);
  }
  lines.push('Unfinished: this turn did not deliver a normal conclusion.', interruptionRetryReason(reason),
    'Next: send "continue" to proceed from the existing records. Check existing task handles before dispatching again; this summary does not replay operations or restart workers.');
  return lines.join('\n\n');
}
