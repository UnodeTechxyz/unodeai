/*---------------------------------------------------------------------------------------------
 *  Historical read projection: the snapshot sidecar (v0.9.99 P1).
 *
 *  Stored messages never carry the host's turn identity or read provenance: a build that does not know them would
 *  send them to its provider. They travel beside the messages instead, one entry per message that had them, located
 *  by its position in that exact snapshot and checked by a fingerprint of the message as stored. Restore admits an
 *  entry only after rebuilding its fact from the stored message itself; anything that does not check out leaves the
 *  message without metadata, which keeps it full. The cutoff is never stored: a restore recomputes it.
 *--------------------------------------------------------------------------------------------*/

import {
  buildHistoricalReadFact, isHistoricalReadFact, isHistoryIdentity, sha256Utf8,
  type HistoricalReadFact, type HistoryIdentity, type ReadReferenceSource,
} from './ReadReferenceProjection';

/** The fact as stored: what cannot be derived from the message. Excerpt and character count are derived again. */
export interface StoredHistoricalRead {
  source: ReadReferenceSource;
  rerun: HistoricalReadFact['rerun'];
  span: { start: number; end: number };
  truncated: boolean;
  resultTextSha256: string;
}

export interface ReadProjectionSidecarEntry {
  /** Position of the message in the array this entry belongs to, in this snapshot only. */
  index: number;
  /** SHA-256 of the message's JSON as stored. */
  fingerprint: string;
  turnId: string;
  read?: StoredHistoricalRead;
}

export interface ReadProjectionSidecar {
  version: 1;
  record: ReadProjectionSidecarEntry[];
  provider?: ReadProjectionSidecarEntry[];
}

/** The fields of a message this module reads or sets. */
export interface SidecarMessage {
  role: string;
  content?: unknown;
  hostIdentity?: HistoryIdentity;
  historicalRead?: HistoricalReadFact;
}

/** Bounds for stored strings: a longer one is not something the host wrote. */
const MAX_TURN_ID_CHARS = 200;
const MAX_SOURCE_STRING_CHARS = 4_096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isBoundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function messageFingerprint(stored: unknown): string {
  return sha256Utf8(JSON.stringify(stored));
}

/**
 * The entries for `messages` (with their host metadata), where `stored[i]` is message `i` exactly as the snapshot
 * stores it, without that metadata.
 */
export function readProjectionEntries(messages: readonly SidecarMessage[], stored: readonly unknown[]): ReadProjectionSidecarEntry[] {
  const entries: ReadProjectionSidecarEntry[] = [];
  messages.forEach((message, index) => {
    const identity = message.hostIdentity;
    if (!isHistoryIdentity(identity) || index >= stored.length) return;
    const fact = message.historicalRead;
    entries.push({
      index,
      fingerprint: messageFingerprint(stored[index]),
      turnId: identity.turnId,
      ...(isHistoricalReadFact(fact) ? {
        read: {
          source: fact.source,
          rerun: fact.rerun,
          span: fact.span,
          truncated: fact.truncated,
          resultTextSha256: fact.resultTextSha256,
        },
      } : {}),
    });
  });
  return entries;
}

/** The source with only its own fields, or undefined. Unknown fields are dropped, not carried. */
function storedSource(value: unknown): ReadReferenceSource | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'file') {
    if (!isBoundedString(value.path, MAX_SOURCE_STRING_CHARS)
      || (value.representation !== 'text' && value.representation !== 'extracted-text')) return undefined;
    const source: ReadReferenceSource = { kind: 'file', path: value.path, representation: value.representation };
    if (value.reader !== undefined) {
      if (value.reader !== 'pdf' && value.reader !== 'docx' && value.reader !== 'pptx') return undefined;
      source.reader = value.reader;
    }
    if (value.lines !== undefined) {
      const lines = value.lines;
      if (!isRecord(lines) || !isCount(lines.first) || !isCount(lines.last) || (lines.total !== undefined && !isCount(lines.total))) {
        return undefined;
      }
      source.lines = lines.total === undefined
        ? { first: lines.first, last: lines.last }
        : { first: lines.first, last: lines.last, total: lines.total };
    }
    return source;
  }
  if (value.kind === 'list') {
    return isBoundedString(value.directory, MAX_SOURCE_STRING_CHARS) && typeof value.recursive === 'boolean'
      ? { kind: 'list', directory: value.directory, recursive: value.recursive }
      : undefined;
  }
  if (value.kind === 'search') {
    if (!isBoundedString(value.scope, MAX_SOURCE_STRING_CHARS) || !isBoundedString(value.query, MAX_SOURCE_STRING_CHARS)) return undefined;
    if (value.maxResults !== undefined && !isCount(value.maxResults)) return undefined;
    return value.maxResults === undefined
      ? { kind: 'search', scope: value.scope, query: value.query }
      : { kind: 'search', scope: value.scope, query: value.query, maxResults: value.maxResults };
  }
  return undefined;
}

/** The argument each rerun tool cannot run without. */
const REQUIRED_RERUN_ARGUMENT = { read_file: 'path', list_dir: 'path', search_files: 'query' } as const;

/**
 * The host fact for `content`, rebuilt from a stored entry: known fields only, the tool's required argument present,
 * the span inside the content, and the payload digesting to the stored digest. Excerpt and character count come from
 * the content, never from storage. Undefined for anything else.
 */
export function restoredHistoricalRead(stored: unknown, content: unknown): HistoricalReadFact | undefined {
  if (!isRecord(stored) || typeof content !== 'string') return undefined;
  const source = storedSource(stored.source);
  const rerun = stored.rerun;
  const span = stored.span;
  if (!source || !isRecord(rerun) || !isRecord(rerun.args) || !isRecord(span)) return undefined;
  if (typeof rerun.tool !== 'string' || !Object.prototype.hasOwnProperty.call(REQUIRED_RERUN_ARGUMENT, rerun.tool)) return undefined;
  const tool = rerun.tool as keyof typeof REQUIRED_RERUN_ARGUMENT;
  const args: Record<string, string | number | boolean> = {};
  for (const [key, arg] of Object.entries(rerun.args)) {
    if (typeof arg === 'string' ? arg.length > MAX_SOURCE_STRING_CHARS : typeof arg !== 'number' && typeof arg !== 'boolean') return undefined;
    args[key] = arg as string | number | boolean;
  }
  if (typeof args[REQUIRED_RERUN_ARGUMENT[tool]] !== 'string') return undefined;
  if (!isCount(span.start) || !isCount(span.end)) return undefined;
  if (typeof stored.truncated !== 'boolean' || typeof stored.resultTextSha256 !== 'string') return undefined;
  // It refuses a span that is reversed or runs past the content.
  const fact = buildHistoricalReadFact({
    source,
    rerun: { tool, args },
    resultText: content,
    span: { start: span.start, end: span.end },
    truncated: stored.truncated,
  });
  // The shape check ties the tool to the source and admits only that tool's own arguments.
  return fact && fact.resultTextSha256 === stored.resultTextSha256 && isHistoricalReadFact(fact) ? fact : undefined;
}

/**
 * Attach the validated metadata of `entries` to `messages`, where `stored[i]` is message `i` as the snapshot held it
 * and `messages[i]` its restored copy. An entry is admitted only when its position exists, appears once, and the
 * stored message still has its fingerprint; a fact only when it rebuilds from that message. Turns must stay
 * contiguous in message order; if they do not, nothing of this array is attached. Returns how many messages got an
 * identity.
 */
export function attachReadProjection(
  messages: SidecarMessage[],
  stored: readonly unknown[],
  entries: unknown,
  newMessageId: () => string,
): number {
  if (!Array.isArray(entries) || entries.length > messages.length || messages.length !== stored.length) return 0;
  const admitted = new Map<number, { turnId: string; read?: HistoricalReadFact }>();
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!isRecord(entry) || !isCount(entry.index) || entry.index >= messages.length) continue;
    if (seen.has(entry.index)) { admitted.delete(entry.index); continue; }
    seen.add(entry.index);
    if (typeof entry.turnId !== 'string' || entry.turnId === '' || entry.turnId.length > MAX_TURN_ID_CHARS) continue;
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint !== messageFingerprint(stored[entry.index])) continue;
    const message = messages[entry.index];
    const read = entry.read !== undefined && (message.role === 'tool' || message.role === 'user')
      ? restoredHistoricalRead(entry.read, message.content)
      : undefined;
    admitted.set(entry.index, { turnId: entry.turnId, ...(read ? { read } : {}) });
  }
  // A turn that ends never starts again: first appearance is the turn order the projection relies on.
  const closed = new Set<string>();
  let current: string | undefined;
  for (const index of [...admitted.keys()].sort((a, b) => a - b)) {
    const turnId = admitted.get(index)!.turnId;
    if (turnId === current) continue;
    if (closed.has(turnId)) return 0;
    if (current !== undefined) closed.add(current);
    current = turnId;
  }
  for (const [index, value] of admitted) {
    const message = messages[index];
    message.hostIdentity = { messageId: newMessageId(), turnId: value.turnId };
    if (value.read) message.historicalRead = value.read;
  }
  return admitted.size;
}

/** The sidecar's container, or undefined when it is not one this build wrote. */
export function readSidecar(value: unknown): { record: unknown; provider: unknown } | undefined {
  return isRecord(value) && value.version === 1 ? { record: value.record, provider: value.provider } : undefined;
}
