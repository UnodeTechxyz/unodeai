/*---------------------------------------------------------------------------------------------
 *  UnodeAi - task history records (v0.9.110 H0, design §3.1–3.2)
 *
 *  The canonical history is a series of events, each published once under a store revision. An event is one of a
 *  closed set of kinds, parsed field by field: never an arbitrary JSON merge. The store assigns the order; the
 *  times here are for display and filtering only.
 *
 *  No `vscode` import: the host gives the store its folder, its writer identity and its clock.
 *--------------------------------------------------------------------------------------------*/

import { deserializeChatHistory, type ChatHistoryMessage } from '../views/chatHistory';

export const HISTORY_SCHEMA_VERSION = 1;
/** One event file at most; an append past this is refused, never cut. */
export const MAX_HISTORY_EVENT_BYTES = 4 * 1024 * 1024;
/** Messages one view replacement or legacy import may carry. */
export const MAX_EVENT_MESSAGES = 1_000;

export type HistoryTerminal = 'running' | 'unfinished' | 'blocked' | 'failed' | 'completed' | 'interrupted';
export type HistoryVerification = 'verified' | 'failed' | 'not-verified' | 'unknown';
export const HISTORY_TERMINALS: readonly HistoryTerminal[] = ['running', 'unfinished', 'blocked', 'failed', 'completed', 'interrupted'];
export const HISTORY_VERIFICATIONS: readonly HistoryVerification[] = ['verified', 'failed', 'not-verified', 'unknown'];

/** Why a member's visible conversation was replaced. The earlier canonical history stays readable. */
export type ViewReplacedReason = 'clear' | 'import' | 'archive' | 'archive-restore' | 'agent-removed' | 'legacy-replaced';
const VIEW_REPLACED_REASONS: readonly ViewReplacedReason[] = ['clear', 'import', 'archive', 'archive-restore', 'agent-removed', 'legacy-replaced'];

/** A file's state as a restore manifest knows it. `payloadRef` names the exact bytes kept for it (a raw-v2 entry id). */
export type HistoryFileState =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string; size: number; payloadRef?: string };

/** What a request's file effect could not be covered by: run by a command, a provider's own tool, or outside. */
export type UncoveredEffectKind = 'command' | 'native-tool' | 'external';
const UNCOVERED_KINDS: readonly UncoveredEffectKind[] = ['command', 'native-tool', 'external'];

export type RecoveryAction = 'revert' | 'undo' | 'redo';
const RECOVERY_ACTIONS: readonly RecoveryAction[] = ['revert', 'undo', 'redo'];
export type RecoveryTargetPhase = 'planned' | 'intent' | 'applied' | 'failed' | 'unknown' | 'conflict';
const RECOVERY_PHASES: readonly RecoveryTargetPhase[] = ['planned', 'intent', 'applied', 'failed', 'unknown', 'conflict'];
export type TaskDeletionScope = 'view' | 'restore-points' | 'both';
export type TaskDeletionReason = 'explicit' | 'housekeeping' | 'delete-all';
/** Ids one deletion event names at most; a larger deletion is recorded as several events. */
export const MAX_DELETION_IDS = 5_000;
/** A raw restore-point entry id. */
const RAW_REF = /^[0-9a-f]{32}$/;

export interface HistoryMessageEntry {
  messageId: string;
  message: ChatHistoryMessage;
}

export type HistoryEventBody =
  /** A top-level request the host admitted: binds its existing request id to the task its first message began. */
  | { kind: 'request-admitted'; historyId: string; rootRequestId: string; agentId: string }
  /** One message added to a member's visible conversation. `startsTask` only on the person's own request message. */
  | { kind: 'transcript-append'; agentId: string; viewGeneration: string; messageId: string; message: ChatHistoryMessage;
    startsTask?: { historyId: string } }
  /** A message already recorded changed in place (such as a late delegation receipt). */
  | { kind: 'transcript-patch'; agentId: string; messageId: string; message: ChatHistoryMessage }
  /** The request's closeout record, by reference; the record itself stays the authority. */
  | { kind: 'outcome-reference'; historyId: string; outcomeRef: string; terminal: HistoryTerminal;
    verification: HistoryVerification; endedAt: string }
  | { kind: 'favourite'; historyId: string; value: boolean; expectedRevision: number }
  /** The member's visible conversation was replaced; `messages` is the new view's content (import, restore). */
  | { kind: 'view-replaced'; agentId: string; viewGeneration: string; reason: ViewReplacedReason; messages: HistoryMessageEntry[] }
  /** Messages found in the older per-member chat key that this history had not recorded. */
  | { kind: 'legacy-import'; agentId: string; projectionKey: string; observedDigest: string;
    reason: 'migration' | 'divergence'; viewGeneration: string; messages: HistoryMessageEntry[] }
  /** The per-member chat key was copied into this history and checked; from here on this history is the source. */
  | { kind: 'migration-marker'; agentId: string; projectionKey: string; observedDigest: string; importedEventId?: string }
  /**
   * v0.9.110 R1: a host change of a request is about to replace, remove or create a file. `before` is what the file
   * was, and `coverage` whether its exact bytes (or its absence) are kept, so the change can be put back.
   */
  | { kind: 'recovery-capture'; rootRequestId: string; agentId: string; targetId: string; displayPath: string;
    physicalTarget: string; before: HistoryFileState; coverage: 'exact' | 'unknown'; reason?: string }
  /** How that change ended, read back: made (with what it left), not made, or not confirmed. */
  | { kind: 'recovery-settle'; rootRequestId: string; targetId: string; outcome: 'committed' | 'not-committed' | 'uncertain';
    after?: HistoryFileState }
  /** A file effect of the request the host could not take a restore point for. */
  | { kind: 'recovery-uncovered'; rootRequestId: string; effect: UncoveredEffectKind; path?: string; reason: string;
    /** v0.9.110: the host's key of a native-tool file, to match it with an exact restore point of the same file. */
    physicalKey?: string }
  /**
   * v0.9.110 R2: a person's Revert (to before `requestIds`), or an Undo revert / Redo revert of an earlier operation.
   * Recorded before any file is touched.
   */
  | { kind: 'recovery-operation'; operationId: string; action: RecoveryAction; agentId: string; requestIds: string[];
    targetOperationId?: string; fromHistoryId?: string }
  /**
   * One target of an operation, journaled step by step: `planned` → `intent` (durable before the file is written) →
   * `applied` / `failed` / `unknown`, or `conflict` without any write. `restoreTo` is what it puts back, `expected` what
   * the file had to hold, `inverse` the state kept first so the operation can be undone, `observed` what was read back.
   */
  | { kind: 'recovery-target'; operationId: string; targetKey: string; physicalTarget: string; displayPath: string;
    phase: RecoveryTargetPhase; restoreTo?: HistoryFileState; expected?: HistoryFileState; inverse?: HistoryFileState;
    observed?: HistoryFileState; reason?: string }
  /** The operation ended. With at least one applied target, later requests continue on `branchId`. */
  | { kind: 'recovery-closed'; operationId: string; applied: number; branchId?: string }
  /**
   * v0.9.110 R2 (F1): what every member must learn at its next request after files were restored: which files are now
   * in which state, which were left as they were, and what was not reversed. No file content.
   */
  | { kind: 'recovery-notice'; noticeId: string; operationId: string; action: RecoveryAction | 'restore';
    targets: Array<{ physicalTarget: string; displayPath: string; state: 'before-request' | 'removed' | 'after-request'; current: HistoryFileState }>;
    conflicts: Array<{ physicalTarget: string; displayPath: string; reason: string }>; notReversed: number;
    /** The continuation branch a revert started, when it started one. */
    branchId?: string;
    /** The request the person reverted to before (for an Undo/Redo, the revert's), so successive notices are told apart. */
    selected?: { historyId: string; rootRequestId?: string; goal: string };
    /** What the revert could not reverse, by kind and path. */
    notReversedRefs?: RecoveryUncoveredRef[] }
  /**
   * The notice was handed to the member's backend with this request, in this conversation view. It may or may not have
   * reached the model: only `recovery-notice-delivered` says it did. A notice only attached stays pending.
   */
  | { kind: 'recovery-notice-attached'; noticeIds: string[]; agentId: string; requestId: string; viewGeneration: string }
  /** The backend reported that the request carrying the notice was taken, in this conversation view. */
  | { kind: 'recovery-notice-delivered'; noticeId: string; agentId: string; requestId: string; viewGeneration?: string }
  /**
   * v0.9.110 H1: the person (or housekeeping) deleted tasks from the history. `view`: their conversation; `restore-points`:
   * the restore points their requests kept; `both`. What stays is this tombstone: ids and content digests, no text, so a
   * stale older copy cannot bring the deleted messages back.
   */
  | { kind: 'task-deletion'; historyIds: string[]; scope: TaskDeletionScope; reason: TaskDeletionReason;
    messageIds: string[]; digests: string[];
    /**
     * The restore points (raw entry ids, with the file each kept) these tasks own, to be removed. They stay owed in the
     * history, without any content, until a `restore-points-removed` event says each is gone.
     */
    payloads?: Array<{ ref: string; path: string }> }
  /** v0.9.110 H1: these restore points were removed (or were already gone); nothing of them is owed any more. */
  | { kind: 'restore-points-removed'; refs: string[] };

/** v0.9.110 R2: one effect a revert could not reverse, as a notice names it. */
export interface RecoveryUncoveredRef { effect: UncoveredEffectKind; path?: string; reason: string }

export type HistoryEventKind = HistoryEventBody['kind'];

export interface HistoryEventEnvelope {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  /** Host-generated; the same event delivered twice is recorded once. */
  eventId: string;
  workspaceId: string;
  /** The extension host instance that wrote it. */
  writerId: string;
  /** Wall time of the write, for display only. */
  at: string;
  body: HistoryEventBody;
}

export type ParsedEnvelope =
  | { status: 'ok'; envelope: HistoryEventEnvelope }
  | { status: 'newer-schema'; schemaVersion: number }
  | { status: 'invalid'; reason: string };

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,300}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 400;
}

/** One stored message: kept only when the transcript's own parser keeps it, whole. */
function parseStoredMessage(value: unknown): ChatHistoryMessage | undefined {
  const parsed = deserializeChatHistory([value], 1);
  return parsed.length === 1 ? parsed[0] : undefined;
}

function parseFileState(value: unknown): HistoryFileState | undefined {
  const state = value as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') return undefined;
  if (state.kind === 'absent') return { kind: 'absent' };
  if (state.kind !== 'file' || typeof state.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.sha256)
    || typeof state.size !== 'number' || !Number.isSafeInteger(state.size) || state.size < 0) return undefined;
  if (state.payloadRef !== undefined && !isHistoryId(state.payloadRef)) return undefined;
  return { kind: 'file', sha256: state.sha256, size: state.size, ...(state.payloadRef !== undefined ? { payloadRef: state.payloadRef as string } : {}) };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseEntries(value: unknown): HistoryMessageEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVENT_MESSAGES) return undefined;
  const entries: HistoryMessageEntry[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const candidate = item as { messageId?: unknown; message?: unknown } | null;
    if (!candidate || !isHistoryId(candidate.messageId) || ids.has(candidate.messageId)) return undefined;
    const message = parseStoredMessage(candidate.message);
    if (!message) return undefined;
    ids.add(candidate.messageId);
    entries.push({ messageId: candidate.messageId, message: { ...message, messageId: candidate.messageId } });
  }
  return entries;
}

/** Field by field; a body that is not exactly one known kind is invalid. */
export function parseHistoryEventBody(value: unknown): HistoryEventBody | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  switch (body.kind) {
    case 'request-admitted':
      return isHistoryId(body.historyId) && isHistoryId(body.rootRequestId) && isHistoryId(body.agentId)
        ? { kind: body.kind, historyId: body.historyId, rootRequestId: body.rootRequestId, agentId: body.agentId }
        : undefined;
    case 'transcript-append': {
      if (!isHistoryId(body.agentId) || !isHistoryId(body.viewGeneration) || !isHistoryId(body.messageId)) return undefined;
      const message = parseStoredMessage(body.message);
      if (!message) return undefined;
      const starts = body.startsTask as { historyId?: unknown } | undefined;
      if (starts !== undefined && (!starts || !isHistoryId(starts.historyId) || message.role !== 'user')) return undefined;
      return {
        kind: body.kind, agentId: body.agentId, viewGeneration: body.viewGeneration, messageId: body.messageId,
        message: { ...message, messageId: body.messageId },
        ...(starts ? { startsTask: { historyId: starts.historyId as string } } : {}),
      };
    }
    case 'transcript-patch': {
      if (!isHistoryId(body.agentId) || !isHistoryId(body.messageId)) return undefined;
      const message = parseStoredMessage(body.message);
      return message ? { kind: body.kind, agentId: body.agentId, messageId: body.messageId, message: { ...message, messageId: body.messageId } } : undefined;
    }
    case 'outcome-reference':
      return isHistoryId(body.historyId) && isHistoryId(body.outcomeRef)
        && HISTORY_TERMINALS.includes(body.terminal as HistoryTerminal)
        && HISTORY_VERIFICATIONS.includes(body.verification as HistoryVerification) && isIsoTime(body.endedAt)
        ? { kind: body.kind, historyId: body.historyId, outcomeRef: body.outcomeRef, terminal: body.terminal as HistoryTerminal,
          verification: body.verification as HistoryVerification, endedAt: body.endedAt }
        : undefined;
    case 'favourite':
      return isHistoryId(body.historyId) && typeof body.value === 'boolean'
        && typeof body.expectedRevision === 'number' && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0
        ? { kind: body.kind, historyId: body.historyId, value: body.value, expectedRevision: body.expectedRevision }
        : undefined;
    case 'view-replaced': {
      if (!isHistoryId(body.agentId) || !isHistoryId(body.viewGeneration)
        || !VIEW_REPLACED_REASONS.includes(body.reason as ViewReplacedReason)) return undefined;
      const messages = parseEntries(body.messages);
      return messages ? { kind: body.kind, agentId: body.agentId, viewGeneration: body.viewGeneration,
        reason: body.reason as ViewReplacedReason, messages } : undefined;
    }
    case 'legacy-import': {
      if (!isHistoryId(body.agentId) || !isKey(body.projectionKey) || typeof body.observedDigest !== 'string'
        || !DIGEST_PATTERN.test(body.observedDigest) || (body.reason !== 'migration' && body.reason !== 'divergence')
        || !isHistoryId(body.viewGeneration)) return undefined;
      const messages = parseEntries(body.messages);
      return messages ? { kind: body.kind, agentId: body.agentId, projectionKey: body.projectionKey,
        observedDigest: body.observedDigest, reason: body.reason, viewGeneration: body.viewGeneration, messages } : undefined;
    }
    case 'migration-marker':
      return isHistoryId(body.agentId) && isKey(body.projectionKey) && typeof body.observedDigest === 'string'
        && DIGEST_PATTERN.test(body.observedDigest) && (body.importedEventId === undefined || isHistoryId(body.importedEventId))
        ? { kind: body.kind, agentId: body.agentId, projectionKey: body.projectionKey, observedDigest: body.observedDigest,
          ...(body.importedEventId !== undefined ? { importedEventId: body.importedEventId as string } : {}) }
        : undefined;
    case 'recovery-capture': {
      const before = parseFileState(body.before);
      if (!isHistoryId(body.rootRequestId) || !isHistoryId(body.agentId) || !isHistoryId(body.targetId) || !before
        || !isText(body.displayPath, 4096) || !isText(body.physicalTarget, 4096)
        || (body.coverage !== 'exact' && body.coverage !== 'unknown')
        || (body.reason !== undefined && !isText(body.reason, 1000))) return undefined;
      return { kind: body.kind, rootRequestId: body.rootRequestId, agentId: body.agentId, targetId: body.targetId,
        displayPath: body.displayPath, physicalTarget: body.physicalTarget, before, coverage: body.coverage,
        ...(body.reason !== undefined ? { reason: body.reason as string } : {}) };
    }
    case 'recovery-settle': {
      const after = body.after === undefined ? undefined : parseFileState(body.after);
      if (!isHistoryId(body.rootRequestId) || !isHistoryId(body.targetId)
        || (body.outcome !== 'committed' && body.outcome !== 'not-committed' && body.outcome !== 'uncertain')
        || (body.after !== undefined && !after) || (body.outcome === 'committed' && !after)) return undefined;
      return { kind: body.kind, rootRequestId: body.rootRequestId, targetId: body.targetId, outcome: body.outcome,
        ...(after ? { after } : {}) };
    }
    case 'recovery-operation': {
      if (!isHistoryId(body.operationId) || !RECOVERY_ACTIONS.includes(body.action as RecoveryAction) || !isHistoryId(body.agentId)
        || !Array.isArray(body.requestIds) || body.requestIds.length > 1_000 || !body.requestIds.every(isHistoryId)
        || (body.targetOperationId !== undefined && !isHistoryId(body.targetOperationId))
        || (body.fromHistoryId !== undefined && !isHistoryId(body.fromHistoryId))) return undefined;
      if ((body.action === 'revert') === (body.targetOperationId !== undefined)) return undefined;
      return { kind: body.kind, operationId: body.operationId, action: body.action as RecoveryAction, agentId: body.agentId,
        requestIds: [...body.requestIds as string[]],
        ...(body.targetOperationId !== undefined ? { targetOperationId: body.targetOperationId as string } : {}),
        ...(body.fromHistoryId !== undefined ? { fromHistoryId: body.fromHistoryId as string } : {}) };
    }
    case 'recovery-target': {
      const states: Record<string, HistoryFileState | undefined> = {};
      for (const name of ['restoreTo', 'expected', 'inverse', 'observed'] as const) {
        if (body[name] === undefined) continue;
        const state = parseFileState(body[name]);
        if (!state) return undefined;
        states[name] = state;
      }
      if (!isHistoryId(body.operationId) || !isText(body.targetKey, 4096) || !isText(body.physicalTarget, 4096)
        || !isText(body.displayPath, 4096) || !RECOVERY_PHASES.includes(body.phase as RecoveryTargetPhase)
        || (body.reason !== undefined && !isText(body.reason, 1000))) return undefined;
      return { kind: body.kind, operationId: body.operationId, targetKey: body.targetKey, physicalTarget: body.physicalTarget,
        displayPath: body.displayPath, phase: body.phase as RecoveryTargetPhase,
        ...(states.restoreTo ? { restoreTo: states.restoreTo } : {}), ...(states.expected ? { expected: states.expected } : {}),
        ...(states.inverse ? { inverse: states.inverse } : {}), ...(states.observed ? { observed: states.observed } : {}),
        ...(body.reason !== undefined ? { reason: body.reason as string } : {}) };
    }
    case 'recovery-notice': {
      if (!isHistoryId(body.noticeId) || !isHistoryId(body.operationId)
        || (body.action !== 'restore' && !RECOVERY_ACTIONS.includes(body.action as RecoveryAction))
        || !Array.isArray(body.targets) || body.targets.length > 10_000 || !Array.isArray(body.conflicts) || body.conflicts.length > 10_000
        || typeof body.notReversed !== 'number' || !Number.isSafeInteger(body.notReversed) || body.notReversed < 0) return undefined;
      const targets: Array<{ physicalTarget: string; displayPath: string; state: 'before-request' | 'removed' | 'after-request'; current: HistoryFileState }> = [];
      for (const item of body.targets as Array<Record<string, unknown>>) {
        const current = parseFileState(item?.current);
        if (!current || !isText(item.physicalTarget, 4096) || !isText(item.displayPath, 4096)
          || (item.state !== 'before-request' && item.state !== 'removed' && item.state !== 'after-request')) return undefined;
        targets.push({ physicalTarget: item.physicalTarget, displayPath: item.displayPath, state: item.state, current });
      }
      const conflicts: Array<{ physicalTarget: string; displayPath: string; reason: string }> = [];
      for (const item of body.conflicts as Array<Record<string, unknown>>) {
        if (!isText(item?.physicalTarget, 4096) || !isText(item.displayPath, 4096) || !isText(item.reason, 1000)) return undefined;
        conflicts.push({ physicalTarget: item.physicalTarget, displayPath: item.displayPath, reason: item.reason });
      }
      if (body.branchId !== undefined && !isHistoryId(body.branchId)) return undefined;
      let selected: { historyId: string; rootRequestId?: string; goal: string } | undefined;
      if (body.selected !== undefined) {
        const item = body.selected as Record<string, unknown> | null;
        if (!item || !isHistoryId(item.historyId) || (item.rootRequestId !== undefined && !isHistoryId(item.rootRequestId))
          || typeof item.goal !== 'string' || item.goal.length > 400) return undefined;
        selected = { historyId: item.historyId, ...(item.rootRequestId !== undefined ? { rootRequestId: item.rootRequestId as string } : {}), goal: item.goal };
      }
      let notReversedRefs: RecoveryUncoveredRef[] | undefined;
      if (body.notReversedRefs !== undefined) {
        if (!Array.isArray(body.notReversedRefs) || body.notReversedRefs.length > 10_000) return undefined;
        notReversedRefs = [];
        for (const item of body.notReversedRefs as Array<Record<string, unknown>>) {
          if (!item || !UNCOVERED_KINDS.includes(item.effect as UncoveredEffectKind) || !isText(item.reason, 1000)
            || (item.path !== undefined && !isText(item.path, 4096))) return undefined;
          notReversedRefs.push({ effect: item.effect as UncoveredEffectKind, reason: item.reason,
            ...(item.path !== undefined ? { path: item.path as string } : {}) });
        }
      }
      return { kind: body.kind, noticeId: body.noticeId, operationId: body.operationId, action: body.action as RecoveryAction | 'restore',
        targets, conflicts, notReversed: body.notReversed, ...(body.branchId !== undefined ? { branchId: body.branchId as string } : {}),
        ...(selected ? { selected } : {}), ...(notReversedRefs ? { notReversedRefs } : {}) };
    }
    case 'recovery-notice-attached':
      return Array.isArray(body.noticeIds) && body.noticeIds.length > 0 && body.noticeIds.length <= 1_000
        && body.noticeIds.every(isHistoryId) && isHistoryId(body.agentId) && isHistoryId(body.requestId) && isHistoryId(body.viewGeneration)
        ? { kind: body.kind, noticeIds: [...body.noticeIds] as string[], agentId: body.agentId, requestId: body.requestId, viewGeneration: body.viewGeneration }
        : undefined;
    case 'recovery-notice-delivered':
      return isHistoryId(body.noticeId) && isHistoryId(body.agentId) && isHistoryId(body.requestId)
        && (body.viewGeneration === undefined || isHistoryId(body.viewGeneration))
        ? { kind: body.kind, noticeId: body.noticeId, agentId: body.agentId, requestId: body.requestId,
          ...(body.viewGeneration !== undefined ? { viewGeneration: body.viewGeneration as string } : {}) }
        : undefined;
    case 'recovery-closed':
      return isHistoryId(body.operationId) && typeof body.applied === 'number' && Number.isSafeInteger(body.applied) && body.applied >= 0
        && (body.branchId === undefined || isHistoryId(body.branchId))
        ? { kind: body.kind, operationId: body.operationId, applied: body.applied,
          ...(body.branchId !== undefined ? { branchId: body.branchId as string } : {}) }
        : undefined;
    case 'restore-points-removed':
      return Array.isArray(body.refs) && body.refs.length <= MAX_DELETION_IDS
        && body.refs.every((ref) => typeof ref === 'string' && RAW_REF.test(ref))
        ? { kind: body.kind, refs: [...body.refs as string[]] } : undefined;
    case 'task-deletion': {
      const ids = (value: unknown, check: (item: unknown) => boolean) =>
        Array.isArray(value) && value.length <= MAX_DELETION_IDS && value.every(check) ? value as string[] : undefined;
      const historyIds = ids(body.historyIds, isHistoryId);
      const messageIds = ids(body.messageIds, isHistoryId);
      const digests = ids(body.digests, (item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item));
      const payloads = body.payloads === undefined ? [] : Array.isArray(body.payloads) && body.payloads.length <= MAX_DELETION_IDS
        && body.payloads.every((item) => !!item && typeof item === 'object' && RAW_REF.test(String((item as { ref?: unknown }).ref))
          && isText((item as { path?: unknown }).path, 4096))
        ? (body.payloads as Array<{ ref: string; path: string }>).map((item) => ({ ref: item.ref, path: item.path })) : undefined;
      if (!historyIds || !messageIds || !digests || !payloads
        || (body.scope !== 'view' && body.scope !== 'restore-points' && body.scope !== 'both')
        || (body.reason !== 'explicit' && body.reason !== 'housekeeping' && body.reason !== 'delete-all')) return undefined;
      return { kind: body.kind, historyIds: [...historyIds], scope: body.scope, reason: body.reason, messageIds: [...messageIds], digests: [...digests],
        ...(payloads.length > 0 ? { payloads } : {}) };
    }
    case 'recovery-uncovered':
      return isHistoryId(body.rootRequestId) && UNCOVERED_KINDS.includes(body.effect as UncoveredEffectKind)
        && isText(body.reason, 1000) && (body.path === undefined || isText(body.path, 4096))
        && (body.physicalKey === undefined || isText(body.physicalKey, 4096))
        ? { kind: body.kind, rootRequestId: body.rootRequestId, effect: body.effect as UncoveredEffectKind, reason: body.reason,
          ...(body.path !== undefined ? { path: body.path as string } : {}),
          ...(body.physicalKey !== undefined ? { physicalKey: body.physicalKey as string } : {}) }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * A stored event. A newer schema is reported as such, so the store turns read-only instead of misreading it; any
 * other deviation is invalid and the event is set aside, never repaired.
 */
export function parseHistoryEnvelope(value: unknown): ParsedEnvelope {
  if (!value || typeof value !== 'object') return { status: 'invalid', reason: 'not an object' };
  const candidate = value as Record<string, unknown>;
  const version = candidate.schemaVersion;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > HISTORY_SCHEMA_VERSION) {
    return { status: 'newer-schema', schemaVersion: version };
  }
  if (version !== HISTORY_SCHEMA_VERSION) return { status: 'invalid', reason: 'schema version' };
  if (!isHistoryId(candidate.eventId) || !isHistoryId(candidate.workspaceId) || !isHistoryId(candidate.writerId)
    || !isIsoTime(candidate.at)) return { status: 'invalid', reason: 'envelope fields' };
  const body = parseHistoryEventBody(candidate.body);
  if (!body) return { status: 'invalid', reason: 'body' };
  return { status: 'ok', envelope: { schemaVersion: HISTORY_SCHEMA_VERSION, eventId: candidate.eventId,
    workspaceId: candidate.workspaceId, writerId: candidate.writerId, at: candidate.at, body } };
}

/** A task as the history reads it: folded from events, never stored as one mutable record. */
export interface HistoryTaskV1 {
  schemaVersion: 1;
  historyId: string;
  workspaceId: string;
  branchId: string;
  /** The host's existing top-level request id; absent for a task recorded before 0.9.110 or never admitted. */
  rootRequestId?: string;
  agentId: string;
  parentHistoryId?: string;
  /** The conversation view the task's messages were written in. */
  transcriptRef: string;
  outcomeRefs: string[];
  recoveryManifestRef?: string;
  startedAt: string;
  endedAt?: string;
  terminal: HistoryTerminal;
  verification: HistoryVerification;
  favourite: boolean;
  /** The person's request text, as sent. */
  goal: string;
  /** The text of the reply that ended the task, when one did. */
  conclusion?: string;
  /** Found in an older chat key: its request, outcome and restore points were not recorded. */
  legacy: boolean;
  /** The highest store revision that changed this task; a favourite change names it. */
  revision: number;
  messageIds: string[];
}
