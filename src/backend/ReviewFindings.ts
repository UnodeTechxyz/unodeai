/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Review findings (v0.9.106)
 *
 *  The findings a review closed with, kept so that each can be named, decided on, fixed and
 *  rechecked. A review set is what one successful close_assignment of one admitted review attempt
 *  submitted, numbered by the host (F1, F2, ...), bounded and pattern-redacted. It is joined to the
 *  standing result it belongs to only by host identities. This module is pure: shapes, bounds,
 *  parsers for stored records, and the text the coordinator is shown. The statements are the
 *  reviewer's words; nothing here treats them as facts.
 *--------------------------------------------------------------------------------------------*/

import { REVIEW_FINDING_CLASSIFICATIONS, parseReviewEvidenceState, type ReviewCoverage, type ReviewFindingClassification, type ReviewEvidenceState } from './ReviewEvidence';
import { redactDiagnosticText } from '../security/diagnosticRedaction';
import { parseOfficeReviewCitation, type OfficeReviewCitation } from './OfficeReviewCitations';

export const REVIEW_SET_SCHEMA_VERSION = 1 as const;
/** A review set's stored size, serialized, before its statements are dropped. */
export const REVIEW_SET_MAX_BYTES = 16 * 1024;
/** Review sets kept on one delegation; the oldest goes first. */
export const MAX_REVIEW_SETS_PER_DELEGATION = 32;
/** Review sets of one run that keep their statements; older ones keep ids, classes and cited lines. */
export const REVIEW_SET_TEXT_RETAINED_PER_RUN = 8;
export const MAX_FINDING_DISPOSITIONS = 50;
export const FINDING_REASON_MAX_CHARACTERS = 500;
/** A cited path as stored: longer ones keep their start and end around a marker. */
const STORED_PATH_MAX_CHARACTERS = 240;
const FINDING_ID = /^F([1-9]|[1-4]\d|50)$/;
const REVIEW_SET_ID = /^review-set-[a-z0-9-]{1,100}$/i;
const ATTEMPT_ID = /^attempt-[a-z0-9-]{1,100}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTITY_MAX = 500;

export type FindingId = `F${number}`;

/** A finding as the host names it: the review set and the finding's number in it. */
export interface ReviewFindingRefV1 {
  reviewSetId: string;
  findingId: FindingId;
}

export interface ReviewCitationV1 {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ReviewReportFindingV1 {
  findingId: FindingId;
  classification: ReviewFindingClassification;
  /** The reviewer's words, redacted; absent when the set's text is no longer retained. */
  statement?: string;
  citations: ReviewCitationV1[];
  officeCitations?: OfficeReviewCitation[];
}

export interface ReviewRecheckV1 {
  of: ReviewFindingRefV1;
  status: 'resolved' | 'unresolved';
  citations: ReviewCitationV1[];
  officeCitations?: OfficeReviewCitation[];
}

/** The workspace file a review was bound to at dispatch. */
export interface ReviewSetTargetV1 {
  inputId: string;
  lexicalPath: string;
  contentDigest: string;
  capturedAt: string;
  /** The write policy's key of the bound physical file, so the host's file effects can be joined to it. */
  key: string;
}

/** The TaskContract side: the admitted live attempt whose close produced the set. */
export interface ReviewSetReviewV1 {
  attemptId: string;
  reviewerAgentId: string;
  admission: { policyId: string; code: string };
  target?: ReviewSetTargetV1;
  targetChangedAtSettlement?: { changedByTeammate: boolean };
  dispatchedAt: string;
  closedAt: string;
  /** Findings of earlier sets this review was dispatched to recheck, as the host resolved them at dispatch. */
  recheckOf?: ReviewFindingRefV1[];
}

/** What the host captures at a successful close, before it is joined to a result. In memory only. */
export interface ReviewReportCapture {
  evidenceVersion?: 2;
  /** Kept inside the opaque v2 set so older runtimes retain the complete new evidence record. */
  evidenceSnapshot?: ReviewEvidenceState;
  reviewSetId: string;
  review: ReviewSetReviewV1;
  coverage: ReviewCoverage;
  findings: ReviewReportFindingV1[];
  rechecks?: ReviewRecheckV1[];
}

export interface ReviewSetResultV1 {
  handle: string;
  revision: number;
  completionAttemptId: string;
  settledEventId: string;
}

export interface ReviewSetV1 extends ReviewReportCapture {
  schemaVersion: 1 | 2;
  /** The ledger side: the standing result this review belongs to. */
  result: ReviewSetResultV1;
  text: 'retained' | 'truncated' | 'not-retained';
  /** Set only when two stored copies of one set differ: the relation is not established. */
  conflict?: true;
}

/** A stored entry: a v1 set, or one written by a newer UnodeAi that is kept but not read. */
export type StoredReviewSet = ReviewSetV1 | { schemaVersion: number; reviewSetId: string; [key: string]: unknown };

export const FINDING_ACTIONS = ['fix-requested', 'fixing-myself', 'not-adopted', 'deferred', 'disputed', 'needs-user'] as const;
export type FindingAction = typeof FINDING_ACTIONS[number];
/** The actions that need the coordinator's reason. */
export const FINDING_REASON_REQUIRED: ReadonlySet<FindingAction> = new Set(['not-adopted', 'deferred', 'disputed', 'needs-user']);

export interface FindingDispositionV1 {
  ref: ReviewFindingRefV1;
  action: FindingAction;
  reason?: string;
}

export interface FindingDispositionsV1 {
  schemaVersion: 1;
  entries: FindingDispositionV1[];
}

// ─── References as a model writes them ──────────────────────────────────────

/** "<reviewHandle>#F<n>": the form a coordinator writes. Returns undefined for anything else. */
export function parseFindingRefText(value: unknown): { handle: string; findingId: FindingId } | undefined {
  if (typeof value !== 'string') return undefined;
  const at = value.trim().lastIndexOf('#');
  if (at <= 0) return undefined;
  const handle = value.trim().slice(0, at);
  const findingId = value.trim().slice(at + 1);
  if (!FINDING_ID.test(findingId) || handle.length > IDENTITY_MAX) return undefined;
  return { handle, findingId: findingId as FindingId };
}

export function findingRefText(handle: string, findingId: FindingId): string {
  return `${handle}#${findingId}`;
}

export function sameFindingRef(left: ReviewFindingRefV1, right: ReviewFindingRefV1): boolean {
  return left.reviewSetId === right.reviewSetId && left.findingId === right.findingId;
}

// ─── Building a set from a checked submission ───────────────────────────────

/** A cited path as the host keeps it: redacted, bounded. */
export function storedCitationPath(value: string): string {
  const redacted = redactDiagnosticText(value);
  if (redacted.length <= STORED_PATH_MAX_CHARACTERS) return redacted;
  const half = Math.floor((STORED_PATH_MAX_CHARACTERS - 1) / 2);
  return `${redacted.slice(0, half)}…${redacted.slice(-half)}`;
}

/** The reviewer's statement as the host keeps and shows it: pattern-redacted. Redaction does not catch every secret. */
export function storedStatement(value: string): string {
  return redactDiagnosticText(value);
}

/** Host numbers, in submission order. */
export function findingIdAt(index: number): FindingId {
  return `F${index + 1}` as FindingId;
}

// ─── The coordinator's text ─────────────────────────────────────────────────

const BLOCK_MAX_BYTES = 16 * 1024;

/**
 * The findings block of a review's result, for the coordinator. Bounded: past its size, the remaining findings are
 * listed by number and class only, with a line saying their text is in the review's Details.
 */
export function renderReviewFindingsBlock(handle: string, capture: Pick<ReviewReportCapture, 'findings' | 'rechecks'>,
  recheckRefText: (ref: ReviewFindingRefV1) => string = (ref) => ref.findingId): string {
  if (!capture.findings.length && !capture.rechecks?.length) return '';
  const lines = [`Review findings of ${handle} (numbered by UnodeAi; the statements are the reviewer's, not host facts). `
    + `Name a finding as ${handle}#F<n> in record_task_disposition findings. Decide each finding before accepting.`];
  let bytes = Buffer.byteLength(lines[0], 'utf8');
  let omitted = 0;
  for (const finding of capture.findings) {
    const cited = reviewCitationLabels(finding).join(', ');
    const full = `${handle}#${finding.findingId} [${finding.classification}] ${finding.statement ?? '(text not retained)'}${cited ? ` — ${cited}` : ''}`;
    const line = bytes + Buffer.byteLength(full, 'utf8') + 1 <= BLOCK_MAX_BYTES ? full : `${handle}#${finding.findingId} [${finding.classification}]`;
    if (line !== full) omitted++;
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    lines.push(line);
  }
  for (const recheck of capture.rechecks ?? []) {
    const cited = reviewCitationLabels(recheck).join(', ');
    lines.push(`recheck of ${recheckRefText(recheck.of)}: ${recheck.status}${cited ? ` — ${cited}` : ''}`);
  }
  if (omitted) lines.push(`${omitted} finding${omitted === 1 ? '' : 's'} listed without text for size; the text is in this review's Details.`);
  return lines.join('\n');
}

export function reviewCitationLabels(value: { citations: ReviewCitationV1[]; officeCitations?: OfficeReviewCitation[] }): string[] {
  return [...value.citations.map(citation => `${citation.path}:${citation.startLine}-${citation.endLine}`),
    ...(value.officeCitations ?? []).map(citation => citation.kind === 'sheet-range' ? `${citation.sheetId}!${citation.range} (${citation.receiptId})`
      : citation.kind === 'slide-object' || citation.kind === 'document-object' ? `${citation.objectRef} (${citation.receiptId})`
        : citation.kind === 'render-page' ? `page ${citation.page}, ${citation.assetId} (${citation.receiptId})` : `${citation.assetId} (${citation.receiptId})`)];
}

// ─── Stored records ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = IDENTITY_MAX): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isInstant(value: unknown): value is string {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function parseFindingRef(value: unknown): ReviewFindingRefV1 | undefined {
  if (!isRecord(value) || typeof value.reviewSetId !== 'string' || !REVIEW_SET_ID.test(value.reviewSetId)
    || typeof value.findingId !== 'string' || !FINDING_ID.test(value.findingId)) return undefined;
  return { reviewSetId: value.reviewSetId, findingId: value.findingId as FindingId };
}

function parseCitations(value: unknown): ReviewCitationV1[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const citations: ReviewCitationV1[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !boundedString(raw.path, 1000) || !isLine(raw.startLine) || !isLine(raw.endLine)
      || raw.startLine > raw.endLine) return undefined;
    citations.push({ path: storedCitationPath(raw.path), startLine: raw.startLine, endLine: raw.endLine });
  }
  return citations;
}

function parseTarget(value: unknown): ReviewSetTargetV1 | undefined {
  if (!isRecord(value) || !boundedString(value.inputId) || !boundedString(value.lexicalPath, 4096)
    || typeof value.contentDigest !== 'string' || !DIGEST.test(value.contentDigest) || !isInstant(value.capturedAt)
    || !boundedString(value.key, 4096)) return undefined;
  return { inputId: value.inputId, lexicalPath: value.lexicalPath, contentDigest: value.contentDigest,
    capturedAt: value.capturedAt, key: value.key };
}

function parseReview(value: unknown): ReviewSetReviewV1 | undefined {
  if (!isRecord(value) || typeof value.attemptId !== 'string' || !ATTEMPT_ID.test(value.attemptId)
    || !boundedString(value.reviewerAgentId) || !isRecord(value.admission) || !boundedString(value.admission.policyId)
    || !boundedString(value.admission.code) || !isInstant(value.dispatchedAt) || !isInstant(value.closedAt)) return undefined;
  const target = value.target === undefined ? undefined : parseTarget(value.target);
  if (value.target !== undefined && !target) return undefined;
  const changed = value.targetChangedAtSettlement;
  if (changed !== undefined && (!isRecord(changed) || typeof changed.changedByTeammate !== 'boolean')) return undefined;
  let recheckOf: ReviewFindingRefV1[] | undefined;
  if (value.recheckOf !== undefined) {
    if (!Array.isArray(value.recheckOf) || value.recheckOf.length > MAX_FINDING_DISPOSITIONS) return undefined;
    recheckOf = [];
    for (const raw of value.recheckOf) {
      const ref = parseFindingRef(raw);
      if (!ref) return undefined;
      recheckOf.push(ref);
    }
  }
  return {
    attemptId: value.attemptId,
    reviewerAgentId: value.reviewerAgentId,
    admission: { policyId: value.admission.policyId, code: value.admission.code },
    ...(target ? { target } : {}),
    ...(isRecord(changed) ? { targetChangedAtSettlement: { changedByTeammate: changed.changedByTeammate as boolean } } : {}),
    dispatchedAt: value.dispatchedAt,
    closedAt: value.closedAt,
    ...(recheckOf ? { recheckOf } : {}),
  };
}

/** A capture as it travels in memory and is recorded; the same checks as a stored set's, without the result. */
export function parseReviewReportCapture(value: unknown): ReviewReportCapture | undefined {
  if (!isRecord(value) || typeof value.reviewSetId !== 'string' || !REVIEW_SET_ID.test(value.reviewSetId)) return undefined;
  const review = parseReview(value.review);
  if (value.evidenceVersion !== undefined && value.evidenceVersion !== 2) return undefined;
  const evidenceSnapshot = value.evidenceSnapshot === undefined ? undefined : parseReviewEvidenceState(value.evidenceSnapshot);
  if (value.evidenceVersion === 2 ? evidenceSnapshot?.schemaVersion !== 2 || evidenceSnapshot.state !== 'citations-checked' : value.evidenceSnapshot !== undefined) return undefined;
  if (!review || (value.coverage !== 'complete' && value.coverage !== 'partial')) return undefined;
  if (!Array.isArray(value.findings) || value.findings.length > 50) return undefined;
  const findings: ReviewReportFindingV1[] = [];
  for (const [index, raw] of value.findings.entries()) {
    if (!isRecord(raw) || raw.findingId !== findingIdAt(index)
      || !(REVIEW_FINDING_CLASSIFICATIONS as readonly unknown[]).includes(raw.classification)) return undefined;
    if (raw.statement !== undefined && (typeof raw.statement !== 'string' || [...raw.statement].length > 4000)) return undefined;
    const citations = parseCitations(raw.citations);
    if (!citations) return undefined;
    const office = parseOfficeCitations(raw.officeCitations, value.evidenceVersion); if (office === false || citations.length + (office?.length ?? 0) > 8) return undefined;
    findings.push({ findingId: raw.findingId as FindingId, classification: raw.classification as ReviewFindingClassification,
      ...(typeof raw.statement === 'string' ? { statement: storedStatement(raw.statement) } : {}), citations, ...(office?.length ? { officeCitations: office } : {}) });
  }
  if (evidenceSnapshot?.state === 'citations-checked' && (evidenceSnapshot.receipt.reportedCoverage !== value.coverage
    || REVIEW_FINDING_CLASSIFICATIONS.some(classification => evidenceSnapshot.receipt.findings[classification].total !== findings.filter(finding => finding.classification === classification).length))) return undefined;
  let rechecks: ReviewRecheckV1[] | undefined;
  if (value.rechecks !== undefined) {
    if (!Array.isArray(value.rechecks) || value.rechecks.length > MAX_FINDING_DISPOSITIONS) return undefined;
    rechecks = [];
    for (const raw of value.rechecks) {
      if (!isRecord(raw) || (raw.status !== 'resolved' && raw.status !== 'unresolved')) return undefined;
      const of = parseFindingRef(raw.of);
      const citations = parseCitations(raw.citations);
      if (!of || !citations) return undefined;
      const office = parseOfficeCitations(raw.officeCitations, value.evidenceVersion); if (office === false || citations.length + (office?.length ?? 0) > 8) return undefined;
      rechecks.push({ of, status: raw.status, citations, ...(office?.length ? { officeCitations: office } : {}) });
    }
  }
  return { ...(value.evidenceVersion === 2 ? { evidenceVersion: 2, evidenceSnapshot } : {}), reviewSetId: value.reviewSetId, review, coverage: value.coverage, findings, ...(rechecks ? { rechecks } : {}) };
}

function parseOfficeCitations(raw: unknown, version: unknown): OfficeReviewCitation[] | undefined | false {
  if (raw === undefined) return undefined;
  if (version !== 2 || !Array.isArray(raw) || raw.length > 8) return false;
  const citations = raw.map(parseOfficeReviewCitation); return citations.every((entry): entry is OfficeReviewCitation => !!entry) ? citations : false;
}

export type ReviewSetParse =
  | { kind: 'set'; set: ReviewSetV1 }
  | { kind: 'newer'; entry: StoredReviewSet }
  | { kind: 'invalid' };

/** A stored set: v1 strictly parsed; a newer version kept as it is (bounded), never read; anything else invalid. */
export function parseStoredReviewSet(value: unknown, handle: string): ReviewSetParse {
  if (!isRecord(value) || typeof value.reviewSetId !== 'string' || !REVIEW_SET_ID.test(value.reviewSetId)) return { kind: 'invalid' };
  if (typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion) && value.schemaVersion > 2) {
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { /* not kept */ }
    return size <= REVIEW_SET_MAX_BYTES ? { kind: 'newer', entry: value as StoredReviewSet } : { kind: 'invalid' };
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return { kind: 'invalid' };
  if ((value.schemaVersion === 2) !== (value.evidenceVersion === 2)) return { kind: 'invalid' };
  const capture = parseReviewReportCapture(value);
  const result = value.result;
  if (!capture || !isRecord(result) || result.handle !== handle || !Number.isInteger(result.revision) || (result.revision as number) < 1
    || !boundedString(result.completionAttemptId) || !boundedString(result.settledEventId)) return { kind: 'invalid' };
  if (value.text !== 'retained' && value.text !== 'truncated' && value.text !== 'not-retained') return { kind: 'invalid' };
  if (value.conflict !== undefined && value.conflict !== true) return { kind: 'invalid' };
  const set: ReviewSetV1 = {
    schemaVersion: value.schemaVersion,
    ...capture,
    result: { handle: result.handle as string, revision: result.revision as number,
      completionAttemptId: result.completionAttemptId, settledEventId: result.settledEventId },
    text: value.text,
    ...(value.conflict ? { conflict: true as const } : {}),
  };
  return { kind: 'set', set: value.text === 'not-retained' ? withoutText(set) : boundSet(set) };
}

export function isReviewSetV1(entry: StoredReviewSet): entry is ReviewSetV1 {
  return (entry.schemaVersion === 1 || entry.schemaVersion === 2) && 'result' in entry;
}

/** A set within its stored size: statements go first, from the last finding back, and the set says it was cut. */
export function boundSet(set: ReviewSetV1): ReviewSetV1 {
  const size = (candidate: ReviewSetV1) => Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  if (size(set) <= REVIEW_SET_MAX_BYTES) return set;
  const findings = set.findings.map((finding) => ({ ...finding }));
  let bounded: ReviewSetV1 = { ...set, findings, text: 'truncated' };
  for (let index = findings.length - 1; index >= 0 && size(bounded) > REVIEW_SET_MAX_BYTES; index--) {
    delete findings[index].statement;
    bounded = { ...bounded, findings: [...findings] };
  }
  if (size(bounded) <= REVIEW_SET_MAX_BYTES) return bounded;
  // Still too large with no statement left: the cited lines go too, first all but each finding's first, then all.
  const oneCitation = { ...withoutText(bounded), findings: bounded.findings.map(({ statement: _statement, ...finding }) =>
    ({ ...finding, citations: finding.citations.slice(0, 1), ...(finding.officeCitations?.length ? { officeCitations: finding.officeCitations.slice(0, 1) } : {}) })),
    ...(bounded.rechecks ? { rechecks: bounded.rechecks.map(recheck => ({ ...recheck,
      ...(recheck.officeCitations?.length ? { officeCitations: recheck.officeCitations.slice(0, 1) } : {}) })) } : {}) };
  return size(oneCitation) <= REVIEW_SET_MAX_BYTES ? oneCitation
    : { ...oneCitation, findings: oneCitation.findings.map(({ officeCitations: _office, ...finding }) => ({ ...finding, citations: [] })),
      ...(oneCitation.rechecks ? { rechecks: oneCitation.rechecks.map(({ officeCitations: _office, ...recheck }) => recheck) } : {}) };
}

export function withoutText(set: ReviewSetV1): ReviewSetV1 {
  return { ...set, text: 'not-retained', findings: set.findings.map(({ statement: _statement, ...finding }) => finding) };
}

/** Parse a disposition event's findings; undefined when absent or invalid (the event itself stays). */
export function parseFindingDispositions(value: unknown): FindingDispositionsV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)
    || value.entries.length === 0 || value.entries.length > MAX_FINDING_DISPOSITIONS) return undefined;
  const entries: FindingDispositionV1[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw) || !(FINDING_ACTIONS as readonly unknown[]).includes(raw.action)) return undefined;
    const ref = parseFindingRef(raw.ref);
    if (!ref) return undefined;
    const action = raw.action as FindingAction;
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : undefined;
    if (raw.reason !== undefined && (typeof raw.reason !== 'string' || [...raw.reason].length > 4000)) return undefined;
    if (FINDING_REASON_REQUIRED.has(action) && !reason) return undefined;
    entries.push({ ref, action, ...(reason ? { reason: redactDiagnosticText(reason) } : {}) });
  }
  return { schemaVersion: 1, entries };
}

// ─── Target effects (v0.9.106 R2): the host's order and version facts for a reviewed file ────────────

export const MAX_TARGET_EFFECTS_PER_DELEGATION = 64;

/** One host-observed change to the file a review set was bound to, recorded after that set. */
export interface ReviewTargetEffectV1 {
  schemaVersion: 1;
  effectId: string;
  /** Per review delegation, 1 + the highest stored; the order of the changes. */
  seq: number;
  reviewSetId: string;
  /** Who changed it. */
  agentId: string;
  byCoordinator: boolean;
  operation: 'write' | 'delete-file';
  grade: 'host-verified' | 'native-observed' | 'effect-uncertain';
  /** The version: SHA-256 of the bytes read back, only for a confirmed write. */
  sha256?: string;
  at: string;
  /** eventIds of this set's finding decisions that were open fix relations when it landed. */
  fixes: string[];
}

const EFFECT_ID = /^target-effect-[a-z0-9-]{1,100}$/i;

export function parseReviewTargetEffect(value: unknown): ReviewTargetEffectV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.effectId !== 'string' || !EFFECT_ID.test(value.effectId)
    || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || typeof value.reviewSetId !== 'string'
    || !REVIEW_SET_ID.test(value.reviewSetId) || !boundedString(value.agentId) || typeof value.byCoordinator !== 'boolean'
    || (value.operation !== 'write' && value.operation !== 'delete-file')
    || (value.grade !== 'host-verified' && value.grade !== 'native-observed' && value.grade !== 'effect-uncertain')
    || (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256)))
    || !isInstant(value.at) || !Array.isArray(value.fixes) || value.fixes.length > MAX_FINDING_DISPOSITIONS
    || value.fixes.some((entry) => !boundedString(entry, 200))) return undefined;
  return {
    schemaVersion: 1, effectId: value.effectId, seq: value.seq as number, reviewSetId: value.reviewSetId, agentId: value.agentId,
    byCoordinator: value.byCoordinator, operation: value.operation, grade: value.grade,
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}), at: value.at, fixes: [...value.fixes as string[]],
  };
}
