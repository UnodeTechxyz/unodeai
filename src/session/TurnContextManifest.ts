/*---------------------------------------------------------------------------------------------
 *  TurnContextManifest
 *
 *  A host-owned, read-only account of the context assembled for one agent turn.  It deliberately
 *  records bytes and a plainly labelled byte-derived token estimate; it does not pretend a model
 *  tokenizer, image encoder, staleness detector, or sensitivity classifier exists before it does.
 *--------------------------------------------------------------------------------------------*/

export type ContextSourceKind =
  | 'user-request'
  | 'repository-instruction'
  | 'project-knowledge-index'
  | 'project-conventions'
  | 'shared-memory'
  | 'skill-summary'
  | 'context-mention'
  | 'user-attachment'
  | 'workspace-orientation';

export interface ContextManifestSource {
  kind: ContextSourceKind;
  /** What was supplied, without reproducing its potentially sensitive contents in the UI. */
  label: string;
  /** Where it came from: a workspace path, attachment name, or host surface. */
  location: string;
  /** The text actually supplied to the model. Omit only when a textual byte/token estimate is unavailable. */
  text?: string;
  /** Use when the host can disclose text size without retaining another copy of its contents. */
  textBytes?: number;
  /** Raw bytes supplied through a non-text modality (currently image attachments). */
  bytes?: number;
  /** The admission rule, rather than an invented model-side explanation. */
  reason: string;
  /** Filesystem fact captured by the host for a workspace source; never model-inferred. */
  modifiedAt?: string;
  /** POSIX permission bits from the filesystem, when the host could read them. */
  fileMode?: number;
  /** Whether the workspace's .gitignore mechanically matches this source path. */
  gitIgnored?: boolean;
  /** Mechanical sensitivity signals only. Labels never include the matched content. */
  sensitivitySignals?: readonly string[];
}

/**
 * A non-rebuildable source supplied with the user's current turn, retained behind an opaque,
 * expiring content id so a coordinator can hand it to a delegate without copying its text into a
 * bus message or forking conversation history.
 */
export interface DelegationContentSource {
  assetId: string;
  kind: Extract<ContextSourceKind, 'user-request' | 'context-mention' | 'user-attachment'>;
  label: string;
  location: string;
  /** Honest size receipt; text is deliberately not repeated on the delegation path. */
  textBytes?: number;
  bytes?: number;
  mediaKind: 'text' | 'pdf' | 'image';
}

export type ContextStaleness = 'modified-within-90-days' | 'unchanged-90-days-or-more' | 'unavailable';
export type ContextSensitivity = 'no-mechanical-signal' | 'potentially-sensitive' | 'unavailable';

/** A visible age threshold, not a claim that a source is incorrect. */
export const CONTEXT_STALENESS_WARNING_DAYS = 90;

export interface TurnContextManifestEntry {
  kind: ContextSourceKind;
  label: string;
  location: string;
  bytes: number;
  /** Undefined means the source was supplied but no honest text-token estimate is available. */
  estimatedTokens?: number;
  tokenEstimate: 'bytes / 4' | 'unavailable';
  reason: string;
  /** Source modification age, from filesystem metadata. It never asserts content correctness. */
  staleness: ContextStaleness;
  modifiedAt?: string;
  ageDays?: number;
  /** Mechanical signal only; no source content or model classification is exposed. */
  sensitivity: ContextSensitivity;
  sensitivitySignals?: string[];
}

export interface TurnContextManifest {
  schemaVersion: 1;
  entries: TurnContextManifestEntry[];
  sourceCount: number;
  totalBytes: number;
  /** Text-only estimate. Image/non-text sources remain counted, but are visibly excluded from this number. */
  estimatedTextTokens: number;
  tokenEstimateLabel: TokenEstimateLabel;
}

/** A deliberately lossy witness, not a tokenizer result. Four bytes/token is easy to inspect and label. */
/**
 * What the receipt's token number covers — and, as importantly, what it does not.
 *
 * It counts the ATTACHED SOURCES only. The request also carries the conversation history, the system
 * prompt, and the tool definitions, none of which appear here. A user on 2026-08-11 read "~9,147 text
 * tokens" beside a gateway rejecting the turn as too large and reasonably concluded one of the two was
 * lying. Neither was: they measure different things, and only one of them said so.
 */
export const TOKEN_ESTIMATE_LABEL = 'Attached sources only — the conversation, system prompt, and tool definitions are not counted here. Estimated from text bytes (bytes / 4); non-text sources excluded' as const;

export type TokenEstimateLabel = typeof TOKEN_ESTIMATE_LABEL;

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(Math.max(0, Math.floor(bytes)) / 4);
}

export function textContextSource(
  kind: ContextSourceKind,
  label: string,
  location: string,
  text: string | undefined,
  reason: string,
): ContextManifestSource | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  return { kind, label, location, text, reason };
}

/** Build a manifest-only receipt for an opaque source handed off by a coordinator. */
export function delegatedContentManifestSource(source: DelegationContentSource): ContextManifestSource | undefined {
  if (!/^content-[1-9]\d*$/.test(source.assetId) ||
      (source.kind !== 'user-request' && source.kind !== 'context-mention' && source.kind !== 'user-attachment') ||
      (source.mediaKind !== 'text' && source.mediaKind !== 'pdf' && source.mediaKind !== 'image')) {
    return undefined;
  }
  const textBytes = Number.isSafeInteger(source.textBytes) && source.textBytes! >= 0
    ? source.textBytes
    : undefined;
  const bytes = Number.isSafeInteger(source.bytes) && source.bytes! >= 0
    ? source.bytes
    : undefined;
  return {
    kind: source.kind,
    label: `Delegated user source: ${source.label || source.kind}`,
    location: source.location || 'coordinator source handoff',
    ...(textBytes !== undefined ? { textBytes } : {}),
    ...(textBytes === undefined && bytes !== undefined ? { bytes } : {}),
    reason: `coordinator forwarded this turn-supplied ${source.mediaKind} source as an opaque content asset; read it on demand`,
  };
}

export function createTurnContextManifest(sources: readonly (ContextManifestSource | undefined)[]): TurnContextManifest {
  const entries: TurnContextManifestEntry[] = sources.filter((source): source is ContextManifestSource => !!source).map((source): TurnContextManifestEntry => {
    const textual = source.text !== undefined || source.textBytes !== undefined;
    const bytes = source.text !== undefined
      ? Buffer.byteLength(source.text, 'utf8')
      : textual
        ? Math.max(0, Math.floor(source.textBytes ?? 0))
        : Math.max(0, Math.floor(source.bytes ?? 0));
    const staleness = sourceStaleness(source.modifiedAt);
    const sensitivitySignals = sourceSensitivitySignals(source);
    return {
      kind: source.kind,
      label: source.label,
      location: source.location,
      bytes,
      estimatedTokens: textual ? estimateTokensFromBytes(bytes) : undefined,
      tokenEstimate: textual ? 'bytes / 4' : 'unavailable',
      reason: source.reason,
      staleness: staleness.state,
      ...(staleness.modifiedAt ? { modifiedAt: staleness.modifiedAt } : {}),
      ...(staleness.ageDays !== undefined ? { ageDays: staleness.ageDays } : {}),
      sensitivity: sensitivitySignals.length > 0 ? 'potentially-sensitive' as const : sourceCanCarrySensitivity(source) ? 'no-mechanical-signal' as const : 'unavailable' as const,
      ...(sensitivitySignals.length > 0 ? { sensitivitySignals } : {}),
    };
  });
  return {
    schemaVersion: 1,
    entries,
    sourceCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    estimatedTextTokens: entries.reduce((total, entry) => total + (entry.estimatedTokens ?? 0), 0),
    tokenEstimateLabel: TOKEN_ESTIMATE_LABEL,
  };
}

function sourceStaleness(modifiedAt: string | undefined): { state: ContextStaleness; modifiedAt?: string; ageDays?: number } {
  if (!modifiedAt) {
    return { state: 'unavailable' };
  }
  const parsed = Date.parse(modifiedAt);
  if (!Number.isFinite(parsed)) {
    return { state: 'unavailable' };
  }
  const ageDays = Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
  return {
    state: ageDays >= CONTEXT_STALENESS_WARNING_DAYS ? 'unchanged-90-days-or-more' : 'modified-within-90-days',
    modifiedAt: new Date(parsed).toISOString(),
    ageDays,
  };
}

function sourceSensitivitySignals(source: ContextManifestSource): string[] {
  const signals = new Set(source.sensitivitySignals ?? []);
  if (source.gitIgnored) {
    signals.add('path is matched by .gitignore');
  }
  // A source readable only by its owner is not proof of a secret, but it is a conservative local signal.
  if (source.fileMode !== undefined && (source.fileMode & 0o077) === 0) {
    signals.add('owner-only filesystem mode');
  }
  return [...signals];
}

function sourceCanCarrySensitivity(source: ContextManifestSource): boolean {
  return source.modifiedAt !== undefined || source.fileMode !== undefined || source.gitIgnored !== undefined || source.sensitivitySignals !== undefined;
}

/** Keep the immutable record model while adding a source discovered during asynchronous assembly. */
export function appendContextManifestSource(
  manifest: TurnContextManifest,
  source: ContextManifestSource | undefined,
): TurnContextManifest {
  if (!source) {
    return manifest;
  }
  const nextEntry = createTurnContextManifest([source]).entries[0];
  if (!nextEntry) {
    return manifest;
  }
  const entries = [...manifest.entries, nextEntry];
  return {
    ...manifest,
    entries,
    sourceCount: entries.length,
    totalBytes: manifest.totalBytes + nextEntry.bytes,
    estimatedTextTokens: manifest.estimatedTextTokens + (nextEntry.estimatedTokens ?? 0),
  };
}
