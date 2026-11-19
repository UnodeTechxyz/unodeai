/*
 * v0.9.106 (first use, Owner 2026-11-17): the one workspace-scoped record of a person's first goal, written before any
 * agent exists. It is kept apart from the per-agent drafts, so restoring or pruning the roster never drops it. It holds
 * the goal's text and revision, the connection chosen for it, and the identity of the one start that turns it into a
 * task. Pure: no VS Code API; the host reads and writes it through a Memento.
 */

/** The workspace state key of the record. */
export const FIRST_USE_RECORD_KEY = 'unode.firstUse.v1';

/** The longest goal kept. A longer text is cut here rather than refused, so typing never loses what came before. */
export const FIRST_USE_TEXT_LIMIT = 20_000;

export type FirstUseStartKind = 'team' | 'solo';
export type FirstUseStartPhase = 'creating' | 'sending' | 'accepted';

/** The one start of the goal: created before the roster is, carried through the send, and kept once accepted. */
export interface FirstUseStart {
  startId: string;
  kind: FirstUseStartKind;
  phase: FirstUseStartPhase;
  /** The connection the start created its agents on, fixed at the click. */
  connectionId: string;
  /** The model chosen for a custom gateway, fixed at the click. */
  model?: string;
  /** The revision of the goal text this start sends. Only this revision is retired when the task is accepted. */
  textRevision: number;
  /** When the start began (ISO). A user message of the receiver at or after it with the goal's text is its admission. */
  startedAt: string;
  receiverAgentId?: string;
  /** Derived from the start id; the one request this start admits. */
  requestId?: string;
}

/** An unsent goal handed to an agent's message box once a roster exists, until a chat page reports the outcome. */
export interface FirstUseHandover {
  agentId: string;
  /** The goal revision handed over. */
  revision: number;
  /** True once a page found a newer draft for that agent and kept it: the goal then stays here as an unsent goal. */
  kept?: boolean;
}

export interface FirstUseRecord {
  text: string;
  revision: number;
  /** The connection chosen with "Use a different connection". Absent means the current default connection. */
  connectionId?: string;
  /** The model chosen for a custom gateway connection. */
  model?: string;
  start?: FirstUseStart;
  handover?: FirstUseHandover;
}

export function emptyFirstUseRecord(): FirstUseRecord {
  return { text: '', revision: 0 };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const shortString = (value: unknown, max = 400): string | undefined => (isString(value) && value.length > 0 && value.length <= max ? value : undefined);

/** Read a stored record. Anything malformed becomes the empty record or loses only the malformed part. */
export function parseFirstUseRecord(raw: unknown): FirstUseRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFirstUseRecord();
  const value = raw as Record<string, unknown>;
  const record: FirstUseRecord = {
    text: isString(value.text) ? value.text.slice(0, FIRST_USE_TEXT_LIMIT) : '',
    revision: count(value.revision),
  };
  const connectionId = shortString(value.connectionId);
  if (connectionId) record.connectionId = connectionId;
  const model = shortString(value.model);
  if (model) record.model = model;
  const start = parseStart(value.start);
  if (start) record.start = start;
  const handover = parseHandover(value.handover);
  if (handover) record.handover = handover;
  return record;
}

function parseStart(raw: unknown): FirstUseStart | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const startId = shortString(value.startId, 120);
  const connectionId = shortString(value.connectionId);
  const startedAt = shortString(value.startedAt, 64);
  const kind = value.kind === 'team' || value.kind === 'solo' ? value.kind : undefined;
  const phase = value.phase === 'creating' || value.phase === 'sending' || value.phase === 'accepted' ? value.phase : undefined;
  if (!startId || !connectionId || !startedAt || !kind || !phase) return undefined;
  const start: FirstUseStart = { startId, kind, phase, connectionId, textRevision: count(value.textRevision), startedAt };
  const model = shortString(value.model);
  if (model) start.model = model;
  const receiverAgentId = shortString(value.receiverAgentId, 200);
  if (receiverAgentId) start.receiverAgentId = receiverAgentId;
  const requestId = shortString(value.requestId, 200);
  if (requestId) start.requestId = requestId;
  return start;
}

function parseHandover(raw: unknown): FirstUseHandover | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const agentId = shortString(value.agentId, 200);
  if (!agentId) return undefined;
  return { agentId, revision: count(value.revision), ...(value.kept === true ? { kept: true } : {}) };
}

/** The request id of a start: derived from the start id, so a retry of the same start names the same request. */
export function firstUseRequestId(startId: string): string {
  return `first-use:${startId}`;
}

/** True while a start is between its first click and its acceptance. */
export function startInProgress(record: FirstUseRecord): boolean {
  return !!record.start && record.start.phase !== 'accepted';
}

/** The text after its accepted revision is retired: only that revision goes, so text typed later is kept. */
export function retireAcceptedText(record: FirstUseRecord, acceptedRevision: number): FirstUseRecord {
  if (record.revision !== acceptedRevision) return record;
  return { ...record, text: '', revision: record.revision + 1, handover: undefined };
}

/** Who receives an unsent goal when a roster appears without a start: the PM, otherwise the first agent. */
export function handoverReceiver(agents: ReadonlyArray<{ id: string; role: string }>): string | undefined {
  return (agents.find((agent) => agent.role === 'pm') ?? agents[0])?.id;
}

/**
 * What a reload makes of a start that had not been accepted (§3.4). Nothing here sends: an unaccepted start with its
 * receiver becomes an unsent goal handed to that receiver's message box, where only the person's Send starts it.
 *
 * - accepted, or no start: unchanged.
 * - the receiver exists and the request was admitted: accepted, and its revision retired.
 * - the receiver exists and the request was not admitted: the start ends, and the goal is handed to the receiver.
 * - no receiver: the start ends; the goal stays a draft.
 */
export function recoverFirstUseStart(
  record: FirstUseRecord,
  facts: { agentExists: (agentId: string) => boolean; admitted: (start: FirstUseStart) => boolean },
): FirstUseRecord {
  const start = record.start;
  if (!start || start.phase === 'accepted') return record;
  const receiver = start.receiverAgentId;
  if (receiver && facts.agentExists(receiver)) {
    if (facts.admitted(start)) {
      return { ...retireAcceptedText(record, start.textRevision), start: { ...start, phase: 'accepted' } };
    }
    const { start: _ended, ...rest } = record;
    return record.text.trim() ? { ...rest, handover: { agentId: receiver, revision: record.revision } } : rest;
  }
  const { start: _ended, ...rest } = record;
  return rest;
}
