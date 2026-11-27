/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Review evidence (v0.9.94)
 *
 *  A reviewer may back its findings with citations to lines the host itself displayed and to
 *  searches the host itself ran. This module is the pure part: the receipts one attempt holds, the
 *  strict parser for a submission, and the check that turns a submission into one bounded,
 *  content-free receipt. It reads no file and grants no authority. A checked citation shows that a
 *  receipt belongs to this attempt and that its lines were displayed to the reviewer. It never
 *  shows that the finding about them is correct, or that the review covered everything.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { WorkbookDeliveryRegistry } from '../content/WorkbookDelivery';
import { checkOfficeReviewCitation, parseOfficeReviewCitation, type OfficeCitationCustody, type OfficeReviewCitation } from './OfficeReviewCitations';
import type { OfficeVisualReceipt } from '../office/OfficeVisualContracts';

export const REVIEW_EVIDENCE_SCHEMA_VERSION = 1 as const;
export type ReviewEvidenceSchemaVersion = 1 | 2;
export interface ReviewBinarySource { kind: 'file' | 'attachment' | 'asset'; key: string; sha256: string }
export const MAX_REVIEW_FINDINGS = 50;
export const MAX_CITATIONS_PER_FINDING = 8;
export const MAX_FINDING_STATEMENT_CHARACTERS = 240;
export const MAX_REVIEW_SEARCH_RECEIPTS = 100;
/** Receipts of one kind that one attempt may hold. A read beyond it is still shown, but cannot be cited. */
export const MAX_ATTEMPT_RECEIPTS = 1000;
/** How many receipts of each kind a refusal lists, so a model can correct a citation without a flood. */
const REFUSAL_RECEIPTS_LISTED = 20;
const CITED_PATH_MAX_CHARACTERS = 1000;

export type ReviewCoverage = 'complete' | 'partial';

export const REVIEW_FINDING_CLASSIFICATIONS = ['observed', 'source-traced', 'inferred'] as const;
export type ReviewFindingClassification = typeof REVIEW_FINDING_CLASSIFICATIONS[number];

/** Why a search stopped. Only `completed` means every file in scope was scanned. */
export const SEARCH_STOP_REASONS = ['completed', 'cancelled', 'timed-out', 'file-cap', 'result-cap'] as const;
export type SearchStopReason = typeof SEARCH_STOP_REASONS[number];

/** What one host search observed about its own scan. Coverage is derived from the stop reason, never stated apart. */
export interface SearchScan {
  filesScanned: number;
  resultCap: number;
  stopReason: SearchStopReason;
  coverage: ReviewCoverage;
}

/** A search the host ran in this attempt, under a short id the model can cite. */
export interface ReviewSearchReceipt extends SearchScan {
  id: string;
  /**
   * The folders the search ran over, each named as a read receipt names a file: relative to the working folder
   * where possible, with forward slashes. Sorted, each once. The receipt's coverage is coverage of these folders
   * and of nothing else.
   */
  scope: readonly string[];
  /** SHA-256, in hex, of the scope, the query and the result cap together. The query's text is not kept. */
  searchDigest: string;
}

/** What a search asked, as the registry needs it to bind a receipt: where it ran and what it looked for. */
export interface ReviewSearchQuestion {
  scope: readonly string[];
  query: string;
}

/**
 * A line-numbered view the host displayed in this attempt. It holds which file, which lines, a digest of the
 * bytes read and whether the view covers the whole file. It never holds the file's text.
 */
export interface ReviewReadReceipt {
  id: string;
  /** The file as the result named it: relative to the working folder where possible, with forward slashes. */
  path: string;
  /** Other spellings of the same file that a citation may use: as requested, absolute, and physical. */
  pathAliases: readonly string[];
  /** 1-based, inclusive: the first and last line number the view displayed. */
  startLine: number;
  endLine: number;
  /** SHA-256 of the bytes read, in hex. */
  contentDigest: string;
  /** `complete` when the view displayed every line of the file. */
  coverage: ReviewCoverage;
}

export interface ReviewEvidenceCitation {
  readReceiptId: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface ReviewEvidenceFinding {
  classification: ReviewFindingClassification;
  /** Bounded presentation text. The host never treats it as a fact. */
  statement: string;
  citations: ReviewEvidenceCitation[];
  officeCitations?: OfficeReviewCitation[];
}

export interface ReviewEvidenceSubmissionV1 {
  schemaVersion: ReviewEvidenceSchemaVersion;
  coverage: ReviewCoverage;
  findings: ReviewEvidenceFinding[];
  searches: Array<{ searchReceiptId: string; coverage: ReviewCoverage }>;
}

/** Findings of one class, and how many of them carry at least one checked citation. */
export interface ReviewFindingCount {
  total: number;
  cited: number;
}

/**
 * What a checked submission leaves behind: counts and a few fixed words. No statement, path, line, digest or query
 * is kept, so the receipt can travel with a result without carrying source text.
 */
export interface ReviewEvidenceReceiptV1 {
  schemaVersion: ReviewEvidenceSchemaVersion;
  findings: Record<ReviewFindingClassification, ReviewFindingCount>;
  citations: number;
  citedFiles: number;
  /** v2 only: distinct binary byte versions, separate from textual file identities. */
  binarySources?: number;
  searches: { complete: number; partial: number };
  /**
   * The host's fact about the cited search receipts alone: `complete` when each scanned its own whole scope,
   * `partial` when one did not, `none` when no search was cited. It says nothing about what lies outside those scopes.
   */
  citedSearchCoverage: ReviewCoverage | 'none';
  /**
   * The overall coverage as the reviewer reported it. It is the reviewer's statement, and the host did not check it:
   * the host refuses `complete` over a cited search that was partial, and it can confirm no coverage at all.
   */
  reportedCoverage: ReviewCoverage;
}

/**
 * The review-evidence fact of one review attempt. `citations-checked` means this and no more: every cited receipt
 * was issued in this attempt, and every cited line was displayed to the reviewer. It never means that a finding is
 * correct or that the review covered everything. A submission that cited nothing has this state with counts of
 * zero, and is described as one the host had nothing to check in. Absent evidence is its own state and is never
 * shown as checked.
 */
export type ReviewEvidenceState =
  | { schemaVersion: ReviewEvidenceSchemaVersion; state: 'citations-checked'; receipt: ReviewEvidenceReceiptV1 }
  | { schemaVersion: ReviewEvidenceSchemaVersion; state: 'not-submitted' };

export const REVIEW_EVIDENCE_NOT_SUBMITTED: ReviewEvidenceState = Object.freeze({
  schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
  state: 'not-submitted',
});

const READ_RECEIPT_ID = /^R[1-9]\d{0,5}$/;
const SEARCH_RECEIPT_ID = /^S[1-9]\d{0,5}$/;
const CONTENT_DIGEST = /^[a-f0-9]{64}$/;
/** Every key of a count-only receipt. A record read back must hold exactly these. */
const RECEIPT_KEYS = ['schemaVersion', 'findings', 'citations', 'citedFiles', 'searches', 'citedSearchCoverage', 'reportedCoverage'] as const;

export function searchCoverageOf(stopReason: SearchStopReason): ReviewCoverage {
  return stopReason === 'completed' ? 'complete' : 'partial';
}

/**
 * One spelling for a path in a citation or a receipt: forward slashes, no leading `./`, no trailing slash. It
 * resolves nothing: `a/../b` stays as written and therefore matches no receipt, which is the safe reading.
 */
export function normalizeReviewPath(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');
  // A leading double slash is a network path and keeps its meaning; every other run of slashes is one separator.
  normalized = normalized.startsWith('//')
    ? `//${normalized.slice(2).replace(/\/{2,}/g, '/')}`
    : normalized.replace(/\/{2,}/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** The line a numbered read displays: the 1-based number, a tab, then the line exactly as the file holds it. */
export function numberedLine(lineNumber: number, text: string): string {
  return `${lineNumber}\t${text}`;
}

/**
 * One digest for what a search asked: where it ran, what it looked for, and the result cap it ran under. The same
 * question over the same scope gives the same digest, however the scope was spelled or ordered; another query,
 * another scope or another cap gives another. It is SHA-256 over one fixed JSON form, so no text has to be kept.
 */
export function searchDigestOf(question: ReviewSearchQuestion, resultCap: number): string {
  return createHash('sha256')
    .update(JSON.stringify(['search', exactSearchScope(question.scope), question.query, resultCap]), 'utf8')
    .digest('hex');
}

/**
 * The one digest of a file's content: SHA-256, in hex, over its bytes exactly as they were read. A read receipt and
 * the binding of a review's target both take theirs from here, so the two can be compared. It accepts bytes and
 * never text: a decoded copy drops a byte-order mark and cannot hold a byte that is not text at all, so its digest
 * would be the digest of another file.
 */
export function contentDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The scope in one spelling and one order, each folder once. It resolves no link and folds no letter case. */
function exactSearchScope(scope: readonly string[]): string[] {
  return [...new Set(scope.map(normalizeReviewPath).filter((folder) => folder.length > 0))].sort();
}

/**
 * The receipts of one attempt. Ids are short and issued by the host in order (`R1`, `R2`, ... and `S1`, `S2`, ...)
 * because a model copies a short id reliably and a long random one not. `reset` starts a new attempt: numbering
 * begins again and nothing issued before it can be cited, since a check only ever reads what is held now.
 */
export class ReviewReceiptRegistry {
  readonly workbooks = new WorkbookDeliveryRegistry();
  private readonly reads = new Map<string, ReviewReadReceipt>();
  private readonly searches = new Map<string, ReviewSearchReceipt>();
  private readonly binarySources = new Map<string, ReviewBinarySource>();
  private readonly visuals = new Map<string, { lookup(): OfficeVisualReceipt | undefined; source?: ReviewBinarySource }>();

  bindBinarySource(ref: string, source: ReviewBinarySource): void {
    const held = this.binarySources.get(ref);
    if (!held || (held.kind === source.kind && held.key === source.key && held.sha256 === source.sha256)) this.binarySources.set(ref, { ...source });
  }
  bindVisual(id: string, lookup: () => OfficeVisualReceipt | undefined, source?: ReviewBinarySource): void {
    this.visuals.set(id, { lookup, ...(source ? { source: { ...source } } : {}) });
  }
  officeCustody(target?: ReviewTarget): OfficeCitationCustody {
    return { read: id => this.workbooks.fact(this, id), visual: id => this.visuals.get(id)?.lookup(), targetDigest: id => {
      const read = this.workbooks.fact(this, id); const source = read ? this.binarySources.get(read.scope.sourceVersion) : this.visuals.get(id)?.source;
      return source && target?.isBinarySourceOfTarget?.(source) ? target.contentDigest : undefined;
    } };
  }
  visualReceipts(): OfficeVisualReceipt[] {
    return [...this.visuals.values()].flatMap(entry => { const fact = entry.lookup(); return fact ? [fact] : []; });
  }

  reset(): void {
    this.workbooks.release(this);
    this.reads.clear();
    this.searches.clear();
    this.binarySources.clear(); this.visuals.clear();
  }

  /** Record a displayed view. Returns nothing when the view is not a real interval or the attempt holds its limit. */
  issueRead(view: Omit<ReviewReadReceipt, 'id'>): ReviewReadReceipt | undefined {
    if (this.reads.size >= MAX_ATTEMPT_RECEIPTS) return undefined;
    // The receipt names the file the way its result line prints it, so the spelling a model copies is the one
    // a citation is checked against. The exact spelling stays accepted as an alias.
    const exactPath = normalizeReviewPath(view.path);
    const path = printable(exactPath);
    if (!path || !isLineNumber(view.startLine) || !isLineNumber(view.endLine) || view.startLine > view.endLine
      || !CONTENT_DIGEST.test(view.contentDigest) || !isCoverage(view.coverage)) {
      return undefined;
    }
    const receipt: ReviewReadReceipt = Object.freeze({
      id: `R${this.reads.size + 1}`,
      path,
      pathAliases: Object.freeze([...new Set([exactPath, ...view.pathAliases.map(normalizeReviewPath)]
        .filter((alias) => alias && alias !== path))]),
      startLine: view.startLine,
      endLine: view.endLine,
      contentDigest: view.contentDigest,
      coverage: view.coverage,
    });
    this.reads.set(receipt.id, receipt);
    return receipt;
  }

  /**
   * Record a finished scan together with what it asked. Coverage comes from the stop reason, so the two cannot
   * disagree. The scope and the digest are fixed here, from the same normalized scope, so a receipt cannot name one
   * place and be bound to another. The query is digested and not kept.
   */
  issueSearch(
    scan: Pick<SearchScan, 'filesScanned' | 'resultCap' | 'stopReason'>,
    question: ReviewSearchQuestion,
  ): ReviewSearchReceipt | undefined {
    if (this.searches.size >= MAX_ATTEMPT_RECEIPTS) return undefined;
    if (!isCount(scan.filesScanned) || !isCount(scan.resultCap) || !SEARCH_STOP_REASONS.includes(scan.stopReason)
      || typeof question?.query !== 'string' || !Array.isArray(question.scope)
      || question.scope.some((folder) => typeof folder !== 'string')) {
      return undefined;
    }
    const receipt: ReviewSearchReceipt = Object.freeze({
      id: `S${this.searches.size + 1}`,
      filesScanned: scan.filesScanned,
      resultCap: scan.resultCap,
      stopReason: scan.stopReason,
      coverage: searchCoverageOf(scan.stopReason),
      scope: Object.freeze([...new Set(exactSearchScope(question.scope).map(printable))]),
      searchDigest: searchDigestOf(question, scan.resultCap),
    });
    this.searches.set(receipt.id, receipt);
    return receipt;
  }

  read(id: string): ReviewReadReceipt | undefined {
    return this.reads.get(id);
  }

  search(id: string): ReviewSearchReceipt | undefined {
    return this.searches.get(id);
  }

  readReceipts(): ReviewReadReceipt[] {
    return [...this.reads.values()];
  }

  searchReceipts(): ReviewSearchReceipt[] {
    return [...this.searches.values()];
  }
}

/**
 * The `review_evidence` argument as a tool schema. Every surface that offers the argument uses this one object,
 * so a reviewer is told the same shape and the same limits wherever it closes a review. It keeps to the schema
 * words every connection accepts (types, string enums, required): the limits are stated in the descriptions and
 * enforced by the parser, because this schema goes to whichever model a reviewer runs on.
 */
export function reviewEvidenceParameter(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'Optional evidence for this review. The host checks every citation against the receipts of this '
      + 'attempt and refuses the call, naming the fault, if one does not hold. A checked citation shows that its '
      + 'receipt belongs to this attempt and that its cited lines or binary selector/version have delivery evidence. It does not show that a finding '
      + 'is correct or that the review covered everything.',
    properties: {
      schemaVersion: { type: 'integer', description: '1: legacy text-line citations. 2: discriminated text-line, sheet-range, slide-object, document-object, render-page or image citations. Use only actual receipts of this attempt.' },
      coverage: {
        type: 'string',
        enum: ['complete', 'partial'],
        description: 'Your own statement of whether you covered the whole review scope. The host records it as '
          + 'reported by you and does not confirm it. It refuses complete if any search you list was partial.',
      },
      findings: {
        type: 'array',
        description: `At most ${MAX_REVIEW_FINDINGS} findings, each a defect or risk for the coordinator to decide. Use [] when `
          + 'you found none: a pass or "no defect found" is not a finding.',
        items: {
          type: 'object',
          properties: {
            classification: {
              type: 'string',
              enum: [...REVIEW_FINDING_CLASSIFICATIONS],
              description: 'observed: you saw it in the cited text or binary content. source-traced: you followed it through the cited '
                + 'content of one or more sources. Each of those two needs at least one citation. inferred: your reasoning, '
                + 'which may have none. A finding you cannot cite is inferred.',
            },
            statement: { type: 'string', description: `The defect or risk, in at most ${MAX_FINDING_STATEMENT_CHARACTERS} characters.` },
            citations: {
              type: 'array',
              description: `At most ${MAX_CITATIONS_PER_FINDING} citations, each to host-receipted text lines or a v2 binary selector of this attempt. `
                + 'Required for an observed or source-traced finding.',
              items: reviewCitationParameter(),
            },
          },
          required: ['classification', 'statement'],
        },
      },
      searches: {
        type: 'array',
        description: `At most ${MAX_REVIEW_SEARCH_RECEIPTS} search receipts your coverage statement rests on. Each receipt covers `
          + 'the scope it names and nothing else.',
        items: {
          type: 'object',
          properties: {
            searchReceiptId: { type: 'string', description: 'The id on the first line of that search_files result, such as S1.' },
            coverage: { type: 'string', enum: ['complete', 'partial'], description: 'The coverage that receipt states.' },
          },
          required: ['searchReceiptId', 'coverage'],
        },
      },
      rechecks: {
        type: 'array',
        description: 'Only for a review dispatched to recheck findings: one entry per finding it names, each once. '
          + '"resolved" needs at least one citation, checked like a finding\'s.',
        items: {
          type: 'object',
          properties: {
            finding: { type: 'string', description: 'The finding as the task card names it, "<reviewHandle>#F<n>".' },
            status: { type: 'string', enum: ['resolved', 'unresolved'], description: 'Whether the fix resolves it.' },
            citations: { type: 'array', description: 'Lines of this attempt\'s read receipts that show it, as for a finding.',
              items: reviewCitationParameter() },
          },
          required: ['finding', 'status'],
        },
      },
    },
    required: ['schemaVersion', 'coverage', 'findings'],
  };
}

function reviewCitationParameter(): Record<string, unknown> {
  return { type: 'object', description: 'v1: readReceiptId/path/startLine/endLine. v2: kind=text-line with those fields; '
    + 'sheet-range needs receiptId (delivery_ref), sourceRef (snapshot_ref), sourceSha256 (source_sha256), sheetId, range and visibility; '
    + 'slide-object needs those source/receipt fields plus slideRef/objectRef; document-object needs objectKind paragraph/table-cell and objectRef. '
    + 'render-page needs receiptId (delivery_id), assetId, sourceSha256, original page, imageSha256 and previewSha256; image needs the same except sourceSha256/page. '
    + 'Use the actual delivered original/preview facts. Submission, unknown delivery or a rejected image is not a visual review.',
    properties: {
      kind: { type: 'string', enum: ['text-line', 'sheet-range', 'slide-object', 'document-object', 'render-page', 'image'] },
      readReceiptId: { type: 'string' }, path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' },
      receiptId: { type: 'string' }, sourceRef: { type: 'string' }, sourceSha256: { type: 'string' }, sheetId: { type: 'string' }, range: { type: 'string' },
      visibility: { type: 'string', enum: ['all', 'visible-only'] }, slideRef: { type: 'string' }, objectRef: { type: 'string' },
      objectKind: { type: 'string', enum: ['paragraph', 'table-cell'] }, assetId: { type: 'string' }, page: { type: 'integer' }, imageSha256: { type: 'string' }, previewSha256: { type: 'string' },
    } };
}

export type ReviewEvidenceParse =
  | { ok: true; submission: ReviewEvidenceSubmissionV1 }
  | { ok: false; reason: string };

/**
 * Parse a model's untrusted submission. Unknown fields are dropped. A value outside the schema or over a limit
 * is refused with the place it was found; nothing is trimmed to fit, because a silently shortened submission
 * would be recorded as something the reviewer did not submit.
 */
export function parseReviewEvidenceSubmission(raw: unknown): ReviewEvidenceParse {
  if (!isRecord(raw)) return invalid('review_evidence must be an object.');
  if (raw.schemaVersion === 2) return parseReviewEvidenceV2(raw);
  if (raw.schemaVersion !== REVIEW_EVIDENCE_SCHEMA_VERSION) {
    return invalid('review_evidence.schemaVersion must be 1 or 2.');
  }
  if (!isCoverage(raw.coverage)) return invalid('review_evidence.coverage must be "complete" or "partial".');
  if (!Array.isArray(raw.findings)) return invalid('review_evidence.findings must be an array; use [] when there are none.');
  if (raw.findings.length > MAX_REVIEW_FINDINGS) {
    return invalid(`review_evidence.findings has ${raw.findings.length} entries; the limit is ${MAX_REVIEW_FINDINGS}.`);
  }
  const findings: ReviewEvidenceFinding[] = [];
  for (const [index, rawFinding] of raw.findings.entries()) {
    const at = `finding ${index + 1}`;
    if (!isRecord(rawFinding)) return invalid(`${at} must be an object.`);
    const classification = rawFinding.classification;
    if (!isClassification(classification)) {
      return invalid(`${at}: classification must be one of ${REVIEW_FINDING_CLASSIFICATIONS.join(', ')}.`);
    }
    const statement = typeof rawFinding.statement === 'string' ? rawFinding.statement.trim() : '';
    if (!statement) return invalid(`${at}: statement is required.`);
    const statementCharacters = [...statement].length;
    if (statementCharacters > MAX_FINDING_STATEMENT_CHARACTERS) {
      return invalid(`${at}: statement has ${statementCharacters} characters; the limit is ${MAX_FINDING_STATEMENT_CHARACTERS}.`);
    }
    const rawCitations = rawFinding.citations ?? [];
    if (!Array.isArray(rawCitations)) return invalid(`${at}: citations must be an array.`);
    if (rawCitations.length > MAX_CITATIONS_PER_FINDING) {
      return invalid(`${at} has ${rawCitations.length} citations; the limit is ${MAX_CITATIONS_PER_FINDING}.`);
    }
    const citations: ReviewEvidenceCitation[] = [];
    for (const [citationIndex, rawCitation] of rawCitations.entries()) {
      const citationAt = `${at}, citation ${citationIndex + 1}`;
      if (!isRecord(rawCitation)) return invalid(`${citationAt} must be an object.`);
      const { readReceiptId, path, startLine, endLine } = rawCitation;
      if (typeof readReceiptId !== 'string' || !READ_RECEIPT_ID.test(readReceiptId)) {
        return invalid(`${citationAt}: readReceiptId must be a read receipt id such as "R1".`);
      }
      if (typeof path !== 'string' || !path.trim() || path.length > CITED_PATH_MAX_CHARACTERS) {
        return invalid(`${citationAt}: path must be the file path that read receipt ${readReceiptId} names.`);
      }
      if (!isLineNumber(startLine) || !isLineNumber(endLine)) {
        return invalid(`${citationAt}: startLine and endLine must be whole line numbers from 1.`);
      }
      if (startLine > endLine) {
        return invalid(`${citationAt}: startLine ${startLine} is after endLine ${endLine}.`);
      }
      citations.push({ readReceiptId, path: path.trim(), startLine, endLine });
    }
    findings.push({ classification, statement, citations });
  }
  const rawSearches = raw.searches ?? [];
  if (!Array.isArray(rawSearches)) return invalid('review_evidence.searches must be an array.');
  if (rawSearches.length > MAX_REVIEW_SEARCH_RECEIPTS) {
    return invalid(`review_evidence.searches has ${rawSearches.length} entries; the limit is ${MAX_REVIEW_SEARCH_RECEIPTS}.`);
  }
  const searches: ReviewEvidenceSubmissionV1['searches'] = [];
  for (const [index, rawSearch] of rawSearches.entries()) {
    const at = `search ${index + 1}`;
    if (!isRecord(rawSearch)) return invalid(`${at} must be an object.`);
    const { searchReceiptId, coverage } = rawSearch;
    if (typeof searchReceiptId !== 'string' || !SEARCH_RECEIPT_ID.test(searchReceiptId)) {
      return invalid(`${at}: searchReceiptId must be a search receipt id such as "S1".`);
    }
    if (!isCoverage(coverage)) return invalid(`${at}: coverage must be "complete" or "partial".`);
    if (searches.some((entry) => entry.searchReceiptId === searchReceiptId)) {
      return invalid(`${at}: search receipt ${searchReceiptId} is listed more than once.`);
    }
    searches.push({ searchReceiptId, coverage });
  }
  return { ok: true, submission: { schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION, coverage: raw.coverage, findings, searches } };
}

function parseReviewEvidenceV2(raw: Record<string, unknown>): ReviewEvidenceParse {
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_REVIEW_FINDINGS) return invalid('v2 findings must be a bounded array.');
  const textFindings: unknown[] = []; const binary: OfficeReviewCitation[][] = [];
  for (const [index, finding] of raw.findings.entries()) {
    if (!isRecord(finding) || (finding.citations !== undefined && !Array.isArray(finding.citations))) return invalid(`finding ${index + 1}: citations must be an array.`);
    const citations = (finding.citations ?? []) as unknown[];
    if (citations.length > MAX_CITATIONS_PER_FINDING) return invalid(`finding ${index + 1}: too many citations.`);
    const lines: unknown[] = []; const office: OfficeReviewCitation[] = [];
    for (const citation of citations) {
      if (isRecord(citation) && citation.kind === 'text-line') {
        const { readReceiptId, path, startLine, endLine } = citation; lines.push({ readReceiptId, path, startLine, endLine });
      } else {
        const parsed = parseOfficeReviewCitation(citation);
        if (!parsed) return invalid(`finding ${index + 1}: invalid v2 citation kind or selector.`);
        office.push(parsed);
      }
    }
    textFindings.push({ ...finding, citations: lines }); binary.push(office);
  }
  const parsed = parseReviewEvidenceSubmission({ ...raw, schemaVersion: 1, findings: textFindings });
  if (!parsed.ok) return parsed;
  return { ok: true, submission: { ...parsed.submission, schemaVersion: 2,
    findings: parsed.submission.findings.map((finding, index) => ({ ...finding, ...(binary[index].length ? { officeCitations: binary[index] } : {}) })) } };
}

/**
 * The workspace file a review is a review of, as the host bound it when the review was dispatched. Which views are
 * views of that file is the host's answer, because this module resolves no path.
 */
export interface ReviewTarget {
  /** The digest of the file's bytes at dispatch, from `contentDigestOf`. */
  contentDigest: string;
  isViewOfTarget(receipt: ReviewReadReceipt): boolean;
  isBinarySourceOfTarget?(source: ReviewBinarySource): boolean;
}

/** `targetChanged` marks a citation that shows the file under review as other bytes than the dispatched ones. */
export type ReviewEvidenceValidation =
  | { ok: true; receipt: ReviewEvidenceReceiptV1 }
  | { ok: false; reason: string; targetChanged?: true };

/**
 * Check a parsed submission against the receipts the current attempt holds. Every citation must name a view of
 * this attempt, the file that view displayed, and lines inside it. An observed or source-traced finding needs a
 * citation; only an inferred one may have none. A search that did not scan everything cannot be called complete,
 * and neither can a review that cites it. That last check can refute the reported coverage and never confirms it,
 * so the receipt carries the coverage as the reviewer's statement. When the review has a bound target, a cited
 * view of that file must also have displayed the bytes the review was dispatched for.
 */
export function validateReviewEvidence(
  submission: ReviewEvidenceSubmissionV1,
  receipts: ReviewReceiptRegistry,
  target?: ReviewTarget,
): ReviewEvidenceValidation {
  const findings: ReviewEvidenceReceiptV1['findings'] = {
    observed: { total: 0, cited: 0 },
    'source-traced': { total: 0, cited: 0 },
    inferred: { total: 0, cited: 0 },
  };
  const citedFiles = new Set<string>();
  const binarySources = new Set<string>(); const office = receipts.officeCustody(target);
  let citations = 0;
  for (const [index, finding] of submission.findings.entries()) {
    const at = `finding ${index + 1}`;
    for (const [citationIndex, citation] of finding.citations.entries()) {
      const citationAt = `${at}, citation ${citationIndex + 1}`;
      const receipt = receipts.read(citation.readReceiptId);
      if (!receipt) {
        return invalid(`${citationAt}: read receipt ${citation.readReceiptId} was not issued in this attempt.`);
      }
      const citedPath = normalizeReviewPath(citation.path);
      if (citedPath !== receipt.path && !receipt.pathAliases.includes(citedPath)) {
        return invalid(`${citationAt}: path "${boundedText(citation.path)}" is not the file read receipt ${receipt.id} displayed ("${boundedText(receipt.path)}").`);
      }
      if (citation.startLine < receipt.startLine || citation.endLine > receipt.endLine) {
        return invalid(`${citationAt}: lines ${citation.startLine}-${citation.endLine} are outside the lines read receipt ${receipt.id} displayed (${receipt.startLine}-${receipt.endLine}).`);
      }
      // The file may have been other bytes while this view was displayed, even if it is the dispatched bytes again now.
      if (target?.isViewOfTarget(receipt) && receipt.contentDigest !== target.contentDigest) {
        return {
          ok: false,
          targetChanged: true,
          reason: `${citationAt}: read receipt ${receipt.id} displayed the file under review with content other than it had when this review was dispatched.`,
        };
      }
      citedFiles.add(receipt.path);
      citations++;
    }
    for (const [citationIndex, citation] of (finding.officeCitations ?? []).entries()) {
      if (submission.schemaVersion !== 2) return invalid('Binary citations require schemaVersion 2.');
      const checked = checkOfficeReviewCitation(citation, office);
      if (!checked.ok) return { ...checked, reason: `${at}, binary citation ${citationIndex + 1}: ${checked.reason}` };
      binarySources.add(checked.sourceSha256); citations++;
    }
    const citationCount = finding.citations.length + (finding.officeCitations?.length ?? 0);
    if (finding.classification !== 'inferred' && citationCount === 0) {
      return invalid(`${at} is ${finding.classification} and has no citation. An observed or source-traced finding needs at `
        + 'least one citation to lines a read receipt of this attempt displayed. Add a citation, or resubmit this finding as inferred.');
    }
    findings[finding.classification].total++;
    if (citationCount > 0) findings[finding.classification].cited++;
  }
  const searches = { complete: 0, partial: 0 };
  for (const [index, cited] of submission.searches.entries()) {
    const receipt = receipts.search(cited.searchReceiptId);
    if (!receipt) {
      return invalid(`search ${index + 1}: search receipt ${cited.searchReceiptId} was not issued in this attempt.`);
    }
    if (receipt.coverage === 'partial' && cited.coverage === 'complete') {
      return invalid(`search ${index + 1}: search receipt ${receipt.id} was partial (${describeSearchStop(receipt.stopReason)}); it cannot be submitted as complete.`);
    }
    if (receipt.coverage === 'partial' && submission.coverage === 'complete') {
      return invalid(`coverage "complete" is refused: search receipt ${receipt.id}, over ${describeSearchScope(receipt.scope)}, was partial `
        + `(${describeSearchStop(receipt.stopReason)}). Report coverage "partial". The host records overall coverage as your statement and does not confirm it.`);
    }
    searches[receipt.coverage]++;
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: submission.schemaVersion,
      findings,
      citations,
      citedFiles: citedFiles.size,
      ...(submission.schemaVersion === 2 ? { binarySources: binarySources.size } : {}),
      searches,
      citedSearchCoverage: combinedSearchCoverage(searches),
      reportedCoverage: submission.coverage,
    },
  };
}

/**
 * v0.9.106: what a checked submission said, for the host to keep as numbered findings. Each cited path is the path the
 * cited receipt displayed, never the spelling the reviewer typed. In memory only; the receipt above stays count-only.
 */
export interface CheckedReviewSubmission {
  schemaVersion?: ReviewEvidenceSchemaVersion;
  coverage: ReviewCoverage;
  findings: Array<{ classification: ReviewFindingClassification; statement: string;
    citations: Array<{ path: string; startLine: number; endLine: number }>; officeCitations?: OfficeReviewCitation[] }>;
  /** The raw `rechecks` field as submitted; the caller checks it against what its review was dispatched to recheck. */
  rechecks?: unknown;
}

export type ReviewEvidenceClose =
  | { ok: true; state: ReviewEvidenceState; checked?: CheckedReviewSubmission }
  | { ok: false; reason: string; finding: string };

/**
 * A refused close in its two wordings, made from one text: `finding` is what the host found, and `reason` is the
 * same as the text of a failed call. A caller that reports the finding without failing takes it from here and
 * never reads the failure mark back out of `reason`.
 */
export function reviewCloseRefusal(finding: string): { reason: string; finding: string } {
  return { reason: `Error: ${finding}`, finding };
}

/**
 * Close a review with the evidence it was given. Evidence is optional: without it the review is closed as
 * `not-submitted`. Evidence that does not hold is refused and closes nothing; the reason names the fault and lists
 * what can be cited, so the caller can correct the submission or close without it. Nothing is ever lowered to a
 * weaker state on its own. `target` is the bound file of a review of a workspace file; a citation that shows it
 * as other bytes is refused as a changed target, not as a slip in the submission.
 */
export function closeReviewEvidence(raw: unknown, receipts: ReviewReceiptRegistry, target?: ReviewTarget): ReviewEvidenceClose {
  if (raw === undefined || raw === null) return { ok: true, state: REVIEW_EVIDENCE_NOT_SUBMITTED };
  const parsed = parseReviewEvidenceSubmission(raw);
  const validated: ReviewEvidenceValidation = parsed.ok ? validateReviewEvidence(parsed.submission, receipts, target) : parsed;
  if (!validated.ok && validated.targetChanged) return { ok: false, ...reviewCloseRefusal(reviewTargetChangedFinding(validated.reason)) };
  if (!validated.ok) {
    return {
      ok: false,
      ...reviewCloseRefusal(
        `review_evidence was refused. ${validated.reason} Nothing was recorded. ${describeAttemptReceipts(receipts)} `
        + 'Correct the submission, or call close_assignment without review_evidence to close with evidence not submitted.',
      ),
    };
  }
  const checked: CheckedReviewSubmission = {
    ...(parsed.ok && parsed.submission.schemaVersion === 2 ? { schemaVersion: 2 } : {}),
    coverage: parsed.ok ? parsed.submission.coverage : 'partial',
    findings: parsed.ok ? parsed.submission.findings.map((finding) => ({
      classification: finding.classification,
      statement: finding.statement,
      citations: finding.citations.map((citation) => ({
        path: receipts.read(citation.readReceiptId)?.path ?? normalizeReviewPath(citation.path),
        startLine: citation.startLine,
        endLine: citation.endLine,
      })),
      ...(finding.officeCitations?.length ? { officeCitations: structuredClone(finding.officeCitations) } : {}),
    })) : [],
    ...(isRecord(raw) && raw.rechecks !== undefined ? { rechecks: raw.rechecks } : {}),
  };
  return { ok: true, state: { schemaVersion: validated.receipt.schemaVersion, state: 'citations-checked', receipt: validated.receipt }, checked };
}

/**
 * What closing a review is told when the file under review is no longer, or was not while it was read, the file
 * the review was dispatched for. `detail` says what the host found. The way on it names is a new review, because a
 * review is closed only against what was dispatched.
 */
export function reviewTargetChangedFinding(detail: string): string {
  return `review target changed; dispatch a new review. ${detail} This call recorded nothing for the review. `
    + 'A review of a workspace file is closed only against that file as it was dispatched: have a new review dispatched '
    + 'for the file as it is now, or, if you cannot dispatch one, say in your reply that the review target changed.';
}

/** The same finding as the text of a failed call. */
export function reviewTargetChangedRefusal(detail: string): string {
  return reviewCloseRefusal(reviewTargetChangedFinding(detail)).reason;
}

/** The receipts a citation may use now, bounded. It names files, line ranges and search scopes, never text or a query. */
export function describeAttemptReceipts(receipts: ReviewReceiptRegistry): string {
  const reads = receipts.readReceipts();
  const searches = receipts.searchReceipts();
  const readList = reads.length === 0
    ? 'none'
    : `${reads.slice(-REFUSAL_RECEIPTS_LISTED).map((receipt) =>
      `${receipt.id} (${boundedText(receipt.path)} lines ${receipt.startLine}-${receipt.endLine})`).join(', ')}`
      + (reads.length > REFUSAL_RECEIPTS_LISTED ? `, and ${reads.length - REFUSAL_RECEIPTS_LISTED} earlier` : '');
  const searchList = searches.length === 0
    ? 'none'
    : `${searches.slice(-REFUSAL_RECEIPTS_LISTED).map((receipt) =>
      `${receipt.id} (${receipt.coverage}, ${describeSearchScope(receipt.scope)})`).join(', ')}`
      + (searches.length > REFUSAL_RECEIPTS_LISTED ? `, and ${searches.length - REFUSAL_RECEIPTS_LISTED} earlier` : '');
  const binary = receipts.workbooks.facts(receipts); const visual = receipts.visualReceipts();
  const extra = binary.length || visual.length ? ' Binary payload receipts of this attempt: '
    + [...binary.slice(-REFUSAL_RECEIPTS_LISTED).map(fact => `${fact.id} (${boundedText(fact.scope.sourceVersion)}, ${fact.state}, ${fact.submitted_units.length} complete units submitted, ${fact.observed_units.length} observed)`),
      ...visual.slice(-REFUSAL_RECEIPTS_LISTED).map(fact => `${fact.delivery_id} (${fact.asset_id}, ${fact.state}, provider response ${fact.provider_result}, viewing ${fact.viewed})`)].join(', ') + '.' : '';
  return `Read receipts of this attempt: ${readList}. Search receipts of this attempt: ${searchList}.${extra}`;
}

/** How a receipt line or a reason names where a search ran. An empty scope is a search that had no folder to walk. */
export function describeSearchScope(scope: readonly string[]): string {
  return scope.length === 0 ? 'an empty scope' : `scope ${scope.map((folder) => `"${boundedText(folder)}"`).join(', ')}`;
}

export function describeSearchStop(stopReason: SearchStopReason): string {
  switch (stopReason) {
    case 'completed': return 'the whole scope was scanned';
    case 'cancelled': return 'the search was cancelled';
    case 'timed-out': return 'the search reached its time budget';
    case 'file-cap': return 'the search reached its file limit';
    case 'result-cap': return 'the search reached its result limit';
    default: {
      const exhaustive: never = stopReason;
      return exhaustive;
    }
  }
}

/** The first line of a numbered read's result. `totalLines` is the file's line count, for orientation only. */
export function readReceiptLine(receipt: ReviewReadReceipt, totalLines: number): string {
  return `[read receipt ${receipt.id}: ${receipt.path} lines ${receipt.startLine}-${receipt.endLine} of ${totalLines}`
    + `${receipt.coverage === 'complete' ? ', the whole file' : ''}. To cite these lines, use readReceiptId "${receipt.id}" `
    + 'with this path and line numbers inside this range.]';
}

/**
 * The first line of a search result. It names the scope the scan ran over and restates in words whether the scan
 * covered that scope, so `complete` is never read as wider than the folders named.
 */
export function searchReceiptLine(receipt: ReviewSearchReceipt): string {
  return `[search receipt ${receipt.id}: ${receipt.coverage === 'complete' ? 'complete coverage' : 'PARTIAL coverage'} of `
    + `${describeSearchScope(receipt.scope)}, ${describeSearchStop(receipt.stopReason)}; ${receipt.filesScanned} files scanned; `
    + `result cap ${receipt.resultCap}. To cite this search, use searchReceiptId "${receipt.id}" with coverage "${receipt.coverage}".]`;
}

/**
 * One line for a result, a notice or a tool reply. It states the counts, says that the overall coverage is the
 * reviewer's own report, and names the two things the host checked. With nothing cited it says the host checked
 * nothing, so a submission of reasoning alone is not read as checked.
 */
export function describeReviewEvidenceState(state: ReviewEvidenceState): string {
  return `review evidence: ${describeReviewEvidence(state)}`;
}

/** The same line without its label, for a surface that prints a label of its own. */
export function describeReviewEvidence(state: ReviewEvidenceState): string {
  if (state.state === 'not-submitted') {
    return 'not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.';
  }
  const { receipt } = state;
  const total = REVIEW_FINDING_CLASSIFICATIONS.reduce((sum, key) => sum + receipt.findings[key].total, 0);
  const classes = REVIEW_FINDING_CLASSIFICATIONS
    .map((key) => `${receipt.findings[key].total} ${key} (${receipt.findings[key].cited} cited)`)
    .join(', ');
  const searches = receipt.searches.complete + receipt.searches.partial;
  const cited = receipt.citations + searches > 0;
  return `${cited ? 'citations checked by the host' : 'submitted with nothing for the host to check'}. `
    + `${total} finding${total === 1 ? '' : 's'}: ${classes}; `
    + `${receipt.citations} citation${receipt.citations === 1 ? '' : 's'} in ${receipt.citedFiles} file${receipt.citedFiles === 1 ? '' : 's'}`
    + (receipt.schemaVersion === 2 ? ` and ${receipt.binarySources ?? 0} binary byte version(s); ` : '; ')
    + `${searches === 0 ? 'no search was cited' : `${searches} search${searches === 1 ? '' : 'es'} cited (${receipt.searches.partial} partial)`}. `
    + `The reviewer reported overall coverage ${receipt.reportedCoverage}; the host did not check that. `
    + (cited
      ? (receipt.schemaVersion === 2
        ? 'The host checked this attempt’s receipt custody, cited lines and binary selector/version payload evidence; transmission does not attest attention or understanding. '
        : 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. ')
        + 'It did not check that a finding is correct or that the review covered everything.'
      : 'No receipt was cited, so the findings are the reviewer\'s reasoning only.');
}

/**
 * Read a review-evidence state that crossed a boundary: a stored record, or one handed over by another part of the
 * host. It is strict. A key it does not know, a missing key, a malformed value or a state that contradicts itself
 * yields nothing, never a repaired value and never a state stronger than the one written.
 */
export function parseReviewEvidenceState(raw: unknown): ReviewEvidenceState | undefined {
  if (!isRecord(raw) || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)) return undefined;
  const version = raw.schemaVersion;
  if (raw.state === 'not-submitted') {
    return hasExactKeys(raw, ['schemaVersion', 'state'])
      ? { schemaVersion: version, state: 'not-submitted' }
      : undefined;
  }
  if (raw.state !== 'citations-checked' || !hasExactKeys(raw, ['schemaVersion', 'state', 'receipt'])) return undefined;
  const receipt = raw.receipt;
  if (!hasExactKeys(receipt, version === 2 ? [...RECEIPT_KEYS, 'binarySources'] : RECEIPT_KEYS) || receipt.schemaVersion !== version
    || !hasExactKeys(receipt.findings, REVIEW_FINDING_CLASSIFICATIONS) || !hasExactKeys(receipt.searches, ['complete', 'partial'])) {
    return undefined;
  }
  const findings = {} as ReviewEvidenceReceiptV1['findings'];
  let totalFindings = 0;
  let citedFindings = 0;
  for (const key of REVIEW_FINDING_CLASSIFICATIONS) {
    const count = receipt.findings[key];
    if (!hasExactKeys(count, ['total', 'cited']) || !isCount(count.total) || !isCount(count.cited) || count.cited > count.total) {
      return undefined;
    }
    findings[key] = { total: count.total, cited: count.cited };
    totalFindings += count.total;
    citedFindings += count.cited;
  }
  const { citations, citedFiles, citedSearchCoverage, reportedCoverage } = receipt;
  const binarySources = version === 2 ? receipt.binarySources : 0;
  const { complete, partial } = receipt.searches;
  if (totalFindings > MAX_REVIEW_FINDINGS
    // An observed or source-traced finding is never recorded without a citation.
    || findings.observed.cited !== findings.observed.total
    || findings['source-traced'].cited !== findings['source-traced'].total
    // Every citation belongs to a cited finding, and a finding holds a bounded number of them.
    || !isCount(citations) || citations > citedFindings * MAX_CITATIONS_PER_FINDING || citations < citedFindings
    || !isCount(citedFiles) || !isCount(binarySources) || citedFiles + binarySources > citations || (citations > 0 && citedFiles + binarySources === 0)
    || !isCount(complete) || !isCount(partial) || complete + partial > MAX_REVIEW_SEARCH_RECEIPTS
    || !isCoverage(reportedCoverage)
    || citedSearchCoverage !== combinedSearchCoverage({ complete, partial })
    // The host refuses a report of complete over a cited partial search, so no record of one can exist.
    || (partial > 0 && reportedCoverage === 'complete')) {
    return undefined;
  }
  return {
    schemaVersion: version,
    state: 'citations-checked',
    receipt: {
      schemaVersion: version,
      findings,
      citations,
      citedFiles,
      ...(version === 2 ? { binarySources } : {}),
      searches: { complete, partial },
      citedSearchCoverage: combinedSearchCoverage({ complete, partial }),
      reportedCoverage,
    },
  };
}

/** One partial search makes the cited searches partial together; with no search cited there is nothing to combine. */
function combinedSearchCoverage(searches: { complete: number; partial: number }): ReviewEvidenceReceiptV1['citedSearchCoverage'] {
  return searches.partial > 0 ? 'partial' : searches.complete > 0 ? 'complete' : 'none';
}

function invalid(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** An object that holds every one of these keys and no other. */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCoverage(value: unknown): value is ReviewCoverage {
  return value === 'complete' || value === 'partial';
}

function isClassification(value: unknown): value is ReviewFindingClassification {
  return typeof value === 'string' && (REVIEW_FINDING_CLASSIFICATIONS as readonly string[]).includes(value);
}

function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Code point ranges that must not reach a receipt line or a reason: C0 and C1 controls, the line and paragraph
 * separators, and the direction overrides and isolates. They are written as numbers so that this source file
 * itself never contains one of them.
 */
const UNPRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];

/** A file name or a model's argument can hold such a character; it becomes `?` so the text stays one readable line. */
function printable(value: string): string {
  let text = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    text += UNPRINTABLE_RANGES.some(([from, to]) => code >= from && code <= to) ? '?' : character;
  }
  return text;
}

/** A model-supplied or path-derived fragment inside a reason, cut so the reason itself stays bounded. */
function boundedText(value: string): string {
  const characters = [...printable(value)];
  return characters.length > 160 ? `${characters.slice(0, 160).join('')}...` : characters.join('');
}
