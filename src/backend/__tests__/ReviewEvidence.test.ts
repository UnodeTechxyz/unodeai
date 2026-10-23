import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  closeReviewEvidence,
  contentDigestOf,
  describeAttemptReceipts,
  describeReviewEvidence,
  describeReviewEvidenceState,
  MAX_ATTEMPT_RECEIPTS,
  MAX_CITATIONS_PER_FINDING,
  MAX_FINDING_STATEMENT_CHARACTERS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_SEARCH_RECEIPTS,
  normalizeReviewPath,
  numberedLine,
  parseReviewEvidenceState,
  parseReviewEvidenceSubmission,
  readReceiptLine,
  REVIEW_EVIDENCE_NOT_SUBMITTED,
  reviewEvidenceParameter,
  ReviewReceiptRegistry,
  reviewCloseRefusal,
  reviewTargetChangedFinding,
  reviewTargetChangedRefusal,
  searchDigestOf,
  searchReceiptLine,
  validateReviewEvidence,
  type ReviewEvidenceState,
  type ReviewEvidenceSubmissionV1,
  type ReviewReadReceipt,
  type ReviewTarget,
} from '../ReviewEvidence';

const DIGEST = 'a'.repeat(64);
/** What the two searches of the fixture asked. The query is a marker, so a test can see that no receipt keeps it. */
const QUERY = 'SENTINEL-QUERY-guard';
const ASKED = { scope: ['src'], query: QUERY };

/**
 * A registry holding `src/a.ts` lines 10-40 (R1), `src/b.ts` whole (R2), a complete search over `src` (S1) and a
 * capped search over the working folder (S2).
 */
function attemptReceipts(): ReviewReceiptRegistry {
  const receipts = new ReviewReceiptRegistry();
  receipts.issueRead({ path: 'src/a.ts', pathAliases: ['./src/a.ts', 'C:\\repo\\src\\a.ts'], startLine: 10, endLine: 40, contentDigest: DIGEST, coverage: 'partial' });
  receipts.issueRead({ path: 'src/b.ts', pathAliases: [], startLine: 1, endLine: 12, contentDigest: DIGEST, coverage: 'complete' });
  receipts.issueSearch({ filesScanned: 30, resultCap: 100, stopReason: 'completed' }, ASKED);
  receipts.issueSearch({ filesScanned: 12, resultCap: 5, stopReason: 'result-cap' }, { scope: ['.'], query: QUERY });
  return receipts;
}

function submission(overrides: Partial<Record<keyof ReviewEvidenceSubmissionV1, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    coverage: 'partial',
    findings: [
      { classification: 'observed', statement: 'The guard is missing.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 14 }] },
    ],
    searches: [],
    ...overrides,
  };
}

function parsed(raw: Record<string, unknown>): ReviewEvidenceSubmissionV1 {
  const result = parseReviewEvidenceSubmission(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.submission;
}

function reasonOf(result: { ok: boolean; reason?: string }): string {
  expect(result.ok).toBe(false);
  return result.reason ?? '';
}

describe('review receipts of one attempt', () => {
  it('issues short ids in order and holds the view, never the text', () => {
    const receipts = attemptReceipts();

    expect(receipts.readReceipts().map((receipt) => receipt.id)).toEqual(['R1', 'R2']);
    expect(receipts.searchReceipts().map((receipt) => receipt.id)).toEqual(['S1', 'S2']);
    // Exactly these fields: which file, which lines, a digest and the coverage. There is no field text could sit in.
    expect(Object.keys(receipts.read('R1')!).sort()).toEqual(
      ['contentDigest', 'coverage', 'endLine', 'id', 'path', 'pathAliases', 'startLine'],
    );
    // A search receipt holds where it ran and a digest of what it asked. There is no field the query could sit in.
    expect(Object.keys(receipts.search('S1')!).sort()).toEqual(
      ['coverage', 'filesScanned', 'id', 'resultCap', 'scope', 'searchDigest', 'stopReason'],
    );
    expect(JSON.stringify(receipts.searchReceipts())).not.toContain(QUERY);
  });

  it('derives search coverage from the stop reason, so only a completed scan is complete', () => {
    const receipts = new ReviewReceiptRegistry();
    const coverage = (['completed', 'cancelled', 'timed-out', 'file-cap', 'result-cap'] as const)
      .map((stopReason) => receipts.issueSearch({ filesScanned: 1, resultCap: 10, stopReason }, ASKED)!.coverage);

    expect(coverage).toEqual(['complete', 'partial', 'partial', 'partial', 'partial']);
  });

  it('binds a search receipt to the scope it ran over and to one digest of that scope, the query and the cap', () => {
    const receipts = new ReviewReceiptRegistry();
    const scan = { filesScanned: 3, resultCap: 100, stopReason: 'completed' as const };
    const first = receipts.issueSearch(scan, ASKED)!;
    // The same question again with the scope spelled another way: another receipt, the same scope and digest.
    const again = receipts.issueSearch({ ...scan, filesScanned: 4, stopReason: 'timed-out' }, { scope: ['.\\src\\'], query: QUERY })!;
    const otherScope = receipts.issueSearch(scan, { scope: ['lib'], query: QUERY })!;
    const widerScope = receipts.issueSearch(scan, { scope: ['src', 'lib', 'src/'], query: QUERY })!;
    const otherQuery = receipts.issueSearch(scan, { scope: ['src'], query: `${QUERY}-2` })!;
    const otherCap = receipts.issueSearch({ ...scan, resultCap: 5 }, ASKED)!;

    expect(first).toMatchObject({ id: 'S1', scope: ['src'] });
    expect(again).toMatchObject({ id: 'S2', scope: ['src'], searchDigest: first.searchDigest });
    // Mutation: a digest that leaves the scope out gives another scope the digest of the first.
    expect(otherScope.searchDigest).not.toBe(first.searchDigest);
    expect(widerScope.searchDigest).not.toBe(first.searchDigest);
    expect(otherQuery.searchDigest).not.toBe(first.searchDigest);
    expect(otherCap.searchDigest).not.toBe(first.searchDigest);
    // Order and repeats do not make another scope: it is held sorted, each folder once.
    expect(widerScope.scope).toEqual(['lib', 'src']);
    expect(widerScope.searchDigest).toBe(searchDigestOf({ scope: ['lib', 'src'], query: QUERY }, 100));
    // SHA-256 over one fixed form, in hex, so whoever holds the question can compute it again.
    expect(first.searchDigest).toBe(
      createHash('sha256').update(JSON.stringify(['search', ['src'], QUERY, 100]), 'utf8').digest('hex'),
    );
    expect(JSON.stringify(receipts.searchReceipts())).not.toContain(QUERY);
  });

  it('starts numbering again on reset and keeps nothing issued before it', () => {
    const receipts = attemptReceipts();
    receipts.reset();

    expect(receipts.read('R1')).toBeUndefined();
    expect(receipts.search('S1')).toBeUndefined();
    const next = receipts.issueRead({ path: 'other.ts', pathAliases: [], startLine: 1, endLine: 2, contentDigest: DIGEST, coverage: 'complete' });
    expect(next?.id).toBe('R1');
    expect(receipts.read('R1')?.path).toBe('other.ts');
  });

  it('issues nothing for a view that is not a real interval of a digested file', () => {
    const receipts = new ReviewReceiptRegistry();
    const view = { path: 'a.ts', pathAliases: [], startLine: 1, endLine: 2, contentDigest: DIGEST, coverage: 'complete' as const };

    expect(receipts.issueRead({ ...view, startLine: 3 })).toBeUndefined();
    expect(receipts.issueRead({ ...view, startLine: 0 })).toBeUndefined();
    expect(receipts.issueRead({ ...view, endLine: 1.5 })).toBeUndefined();
    expect(receipts.issueRead({ ...view, contentDigest: 'not-a-digest' })).toBeUndefined();
    expect(receipts.issueRead({ ...view, path: '  ' })).toBeUndefined();
    expect(receipts.issueSearch({ filesScanned: -1, resultCap: 10, stopReason: 'completed' }, ASKED)).toBeUndefined();
    expect(receipts.readReceipts()).toEqual([]);
  });

  it('issues no search receipt without the question the search asked', () => {
    const receipts = new ReviewReceiptRegistry();
    const scan = { filesScanned: 1, resultCap: 10, stopReason: 'completed' as const };

    expect(receipts.issueSearch(scan, undefined as never)).toBeUndefined();
    expect(receipts.issueSearch(scan, { scope: ['src'] } as never)).toBeUndefined();
    expect(receipts.issueSearch(scan, { scope: 'src', query: QUERY } as never)).toBeUndefined();
    expect(receipts.issueSearch(scan, { scope: ['src', 7], query: QUERY } as never)).toBeUndefined();
    expect(receipts.searchReceipts()).toEqual([]);
    // A search that had no folder to walk is still a search: it gets a receipt, and the receipt says so.
    const nowhere = receipts.issueSearch(scan, { scope: [], query: QUERY })!;
    expect(nowhere.scope).toEqual([]);
    expect(searchReceiptLine(nowhere)).toContain('complete coverage of an empty scope,');
  });

  it('stops issuing at the per-attempt limit instead of growing without bound', () => {
    const receipts = new ReviewReceiptRegistry();
    for (let index = 0; index < MAX_ATTEMPT_RECEIPTS; index++) {
      receipts.issueRead({ path: `f${index}.ts`, pathAliases: [], startLine: 1, endLine: 1, contentDigest: DIGEST, coverage: 'complete' });
      receipts.issueSearch({ filesScanned: 1, resultCap: 1, stopReason: 'completed' }, ASKED);
    }

    expect(receipts.issueRead({ path: 'over.ts', pathAliases: [], startLine: 1, endLine: 1, contentDigest: DIGEST, coverage: 'complete' })).toBeUndefined();
    expect(receipts.issueSearch({ filesScanned: 1, resultCap: 1, stopReason: 'completed' }, ASKED)).toBeUndefined();
    expect(receipts.readReceipts()).toHaveLength(MAX_ATTEMPT_RECEIPTS);
  });

  it('names a file by one printable spelling and still accepts the exact one', () => {
    const receipts = new ReviewReceiptRegistry();
    const odd = `src\\na${String.fromCharCode(0x202e)}me.ts`;
    const receipt = receipts.issueRead({ path: odd, pathAliases: [], startLine: 1, endLine: 1, contentDigest: DIGEST, coverage: 'complete' })!;

    expect(receipt.path).toBe('src/na?me.ts');
    expect(receipt.pathAliases).toContain(`src/na${String.fromCharCode(0x202e)}me.ts`);
    expect(readReceiptLine(receipt, 1)).not.toContain(String.fromCharCode(0x202e));
  });

  it('prints a search scope in one printable spelling and still digests the exact one', () => {
    const receipts = new ReviewReceiptRegistry();
    const scan = { filesScanned: 1, resultCap: 10, stopReason: 'completed' as const };
    const left = receipts.issueSearch(scan, { scope: [`a${String.fromCharCode(0x202e)}`], query: QUERY })!;
    const right = receipts.issueSearch(scan, { scope: [`a${String.fromCharCode(0x202d)}`], query: QUERY })!;

    expect(left.scope).toEqual(['a?']);
    expect(right.scope).toEqual(['a?']);
    // Two folders that print alike are still two scopes.
    expect(left.searchDigest).not.toBe(right.searchDigest);
    expect(searchReceiptLine(left)).not.toContain(String.fromCharCode(0x202e));
  });
});

describe('normalizeReviewPath and numberedLine', () => {
  it('gives one spelling to slashes, a leading ./ and a trailing slash, and resolves nothing', () => {
    expect(normalizeReviewPath(' .\\src\\\\a.ts ')).toBe('src/a.ts');
    expect(normalizeReviewPath('./././src//a.ts/')).toBe('src/a.ts');
    expect(normalizeReviewPath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts');
    expect(normalizeReviewPath('\\\\server\\share\\\\a.ts')).toBe('//server/share/a.ts');
    expect(normalizeReviewPath('src/../src/a.ts')).toBe('src/../src/a.ts');
    expect(normalizeReviewPath('/')).toBe('/');
  });

  it('prefixes the number and a tab and leaves the line untouched', () => {
    expect(numberedLine(7, '  indented\r')).toBe('7\t  indented\r');
    expect(numberedLine(120, '')).toBe('120\t');
  });
});

describe('parseReviewEvidenceSubmission', () => {
  it('keeps the declared fields, drops unknown ones and treats absent lists as empty', () => {
    const result = parseReviewEvidenceSubmission({
      schemaVersion: 1,
      coverage: 'complete',
      verdict: 'approved',
      findings: [{ classification: 'inferred', statement: '  Likely fine.  ', confidence: 0.9 }],
    });

    expect(result).toEqual({
      ok: true,
      submission: {
        schemaVersion: 1,
        coverage: 'complete',
        findings: [{ classification: 'inferred', statement: 'Likely fine.', citations: [] }],
        searches: [],
      },
    });
  });

  it.each([
    ['a string', '{"schemaVersion":1}', /must be an object/],
    ['an array', [], /must be an object/],
    ['another schema version', submission({ schemaVersion: 2 }), /schemaVersion must be 1/],
    ['an unknown coverage', submission({ coverage: 'full' }), /coverage must be "complete" or "partial"/],
    ['no findings list', submission({ findings: undefined }), /findings must be an array/],
    ['a finding that is not an object', submission({ findings: ['looks fine'] }), /finding 1 must be an object/],
    ['an unknown classification', submission({ findings: [{ classification: 'verified', statement: 'x' }] }), /finding 1: classification must be one of observed, source-traced, inferred/],
    ['an empty statement', submission({ findings: [{ classification: 'inferred', statement: '   ' }] }), /finding 1: statement is required/],
    ['citations that are not a list', submission({ findings: [{ classification: 'observed', statement: 'x', citations: 'R1' }] }), /finding 1: citations must be an array/],
    ['searches that are not a list', submission({ searches: 'S1' }), /searches must be an array/],
  ])('refuses %s', (_label, raw, pattern) => {
    expect(reasonOf(parseReviewEvidenceSubmission(raw))).toMatch(pattern);
  });

  it('counts a statement in characters and refuses one over the limit instead of cutting it', () => {
    // An astral character is one character, though two UTF-16 units: the limit is not halved for it.
    const atLimit = '\u{1F50D}'.repeat(MAX_FINDING_STATEMENT_CHARACTERS);
    expect(parseReviewEvidenceSubmission(submission({ findings: [{ classification: 'inferred', statement: atLimit }] })).ok).toBe(true);

    const over = 'x'.repeat(MAX_FINDING_STATEMENT_CHARACTERS + 1);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({ findings: [{ classification: 'inferred', statement: over }] }))))
      .toMatch(/finding 1: statement has 241 characters; the limit is 240/);
  });

  it('refuses a list over its limit and names the limit', () => {
    const finding = { classification: 'inferred', statement: 'x' };
    const citation = { readReceiptId: 'R1', path: 'src/a.ts', startLine: 10, endLine: 10 };

    expect(parseReviewEvidenceSubmission(submission({ findings: Array(MAX_REVIEW_FINDINGS).fill(finding) })).ok).toBe(true);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({ findings: Array(MAX_REVIEW_FINDINGS + 1).fill(finding) }))))
      .toMatch(/findings has 51 entries; the limit is 50/);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({
      findings: [{ classification: 'observed', statement: 'x', citations: Array(MAX_CITATIONS_PER_FINDING + 1).fill(citation) }],
    })))).toMatch(/finding 1 has 9 citations; the limit is 8/);
    const searches = Array.from({ length: MAX_REVIEW_SEARCH_RECEIPTS + 1 }, (_unused, index) => ({ searchReceiptId: `S${index + 1}`, coverage: 'partial' }));
    expect(parseReviewEvidenceSubmission(submission({ searches: searches.slice(0, MAX_REVIEW_SEARCH_RECEIPTS) })).ok).toBe(true);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({ searches })))).toMatch(/searches has 101 entries; the limit is 100/);
  });

  it.each([
    ['a long random id in place of a short receipt id', { readReceiptId: 'receipt-3f2a9c1e-5b7d-4e2a-9c1e-5b7d4e2a9c1e' }, /readReceiptId must be a read receipt id such as "R1"/],
    ['a search id in place of a read id', { readReceiptId: 'S1' }, /readReceiptId must be a read receipt id/],
    ['no path', { path: '' }, /path must be the file path that read receipt R1 names/],
    ['a line number of zero', { startLine: 0 }, /startLine and endLine must be whole line numbers from 1/],
    ['a fractional line number', { endLine: 14.5 }, /whole line numbers from 1/],
    ['a line number given as text', { startLine: '12' }, /whole line numbers from 1/],
    ['an interval that ends before it starts', { startLine: 20, endLine: 12 }, /startLine 20 is after endLine 12/],
  ])('refuses a citation with %s', (_label, change, pattern) => {
    const citation = { readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 14, ...change };
    const raw = submission({ findings: [{ classification: 'observed', statement: 'x', citations: [citation] }] });

    expect(reasonOf(parseReviewEvidenceSubmission(raw))).toMatch(pattern);
    expect(reasonOf(parseReviewEvidenceSubmission(raw))).toMatch(/^finding 1, citation 1/);
  });

  it('refuses a malformed or repeated search receipt', () => {
    expect(reasonOf(parseReviewEvidenceSubmission(submission({ searches: [{ searchReceiptId: 'R1', coverage: 'partial' }] }))))
      .toMatch(/search 1: searchReceiptId must be a search receipt id such as "S1"/);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({ searches: [{ searchReceiptId: 'S1', coverage: 'whole' }] }))))
      .toMatch(/search 1: coverage must be "complete" or "partial"/);
    expect(reasonOf(parseReviewEvidenceSubmission(submission({
      searches: [{ searchReceiptId: 'S1', coverage: 'complete' }, { searchReceiptId: 'S1', coverage: 'partial' }],
    })))).toMatch(/search 2: search receipt S1 is listed more than once/);
  });
});

describe('validateReviewEvidence', () => {
  it('turns a submission that holds into counts only', () => {
    const result = validateReviewEvidence(parsed(submission({
      findings: [
        { classification: 'observed', statement: 'The guard is missing.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 14 }] },
        { classification: 'source-traced', statement: 'a calls b.', citations: [
          { readReceiptId: 'R1', path: 'src/a.ts', startLine: 30, endLine: 30 },
          { readReceiptId: 'R2', path: 'src/b.ts', startLine: 1, endLine: 12 },
        ] },
        { classification: 'inferred', statement: 'Probably untested.', citations: [] },
        { classification: 'inferred', statement: 'Reasoned from the guard above.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 12 }] },
      ],
      searches: [{ searchReceiptId: 'S1', coverage: 'complete' }, { searchReceiptId: 'S2', coverage: 'partial' }],
    })), attemptReceipts());

    expect(result).toEqual({
      ok: true,
      receipt: {
        schemaVersion: 1,
        findings: {
          observed: { total: 1, cited: 1 },
          'source-traced': { total: 1, cited: 1 },
          inferred: { total: 2, cited: 1 },
        },
        citations: 4,
        citedFiles: 2,
        searches: { complete: 1, partial: 1 },
        citedSearchCoverage: 'partial',
        reportedCoverage: 'partial',
      },
    });
  });

  it('accepts a citation that spells the same file another way, and the exact edges of the view', () => {
    for (const path of ['src/a.ts', './src/a.ts', 'src\\a.ts', 'C:/repo/src/a.ts', 'C:\\repo\\src\\a.ts']) {
      const result = validateReviewEvidence(parsed(submission({
        findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R1', path, startLine: 10, endLine: 40 }] }],
      })), attemptReceipts());
      expect(result.ok).toBe(true);
    }
  });

  it('refuses a citation to a receipt this attempt does not hold', () => {
    const raw = submission({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R7', path: 'src/a.ts', startLine: 12, endLine: 14 }] }] });

    expect(reasonOf(validateReviewEvidence(parsed(raw), attemptReceipts())))
      .toBe('finding 1, citation 1: read receipt R7 was not issued in this attempt.');
    // Mutation: skipping the ownership lookup lets a receipt of an earlier attempt validate.
    expect(reasonOf(validateReviewEvidence(parsed(submission()), new ReviewReceiptRegistry())))
      .toBe('finding 1, citation 1: read receipt R1 was not issued in this attempt.');
  });

  it('refuses a citation whose path is not the file that receipt displayed', () => {
    const raw = submission({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R1', path: 'src/b.ts', startLine: 12, endLine: 14 }] }] });

    expect(reasonOf(validateReviewEvidence(parsed(raw), attemptReceipts())))
      .toBe('finding 1, citation 1: path "src/b.ts" is not the file read receipt R1 displayed ("src/a.ts").');
  });

  it.each([
    ['before the first displayed line', 9, 12],
    ['past the last displayed line', 38, 41],
    ['around the whole view', 1, 200],
  ])('refuses lines %s', (_label, startLine, endLine) => {
    const raw = submission({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine, endLine }] }] });

    expect(reasonOf(validateReviewEvidence(parsed(raw), attemptReceipts())))
      .toBe(`finding 1, citation 1: lines ${startLine}-${endLine} are outside the lines read receipt R1 displayed (10-40).`);
  });

  it('refuses a source-traced finding without a citation and lets an inferred one have none', () => {
    const traced = submission({ findings: [{ classification: 'source-traced', statement: 'a calls b.', citations: [] }] });
    expect(reasonOf(validateReviewEvidence(parsed(traced), attemptReceipts()))).toBe(
      'finding 1 is source-traced and has no citation. An observed or source-traced finding needs at least one citation to lines '
      + 'a read receipt of this attempt displayed. Add a citation, or resubmit this finding as inferred.',
    );

    const inferred = submission({ findings: [{ classification: 'inferred', statement: 'Probably untested.', citations: [] }] });
    expect(validateReviewEvidence(parsed(inferred), attemptReceipts()).ok).toBe(true);
  });

  it('refuses an observed finding without a citation and says it can be resubmitted as inferred', () => {
    const uncited = { statement: 'Seen while reading, no line kept.', citations: [] };
    // The uncited finding is the second one, behind a cited one: the rule is per finding, not per submission.
    const observed = submission({ findings: [
      { classification: 'observed', statement: 'The guard is missing.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 14 }] },
      { classification: 'observed', ...uncited },
    ] });

    expect(reasonOf(validateReviewEvidence(parsed(observed), attemptReceipts()))).toBe(
      'finding 2 is observed and has no citation. An observed or source-traced finding needs at least one citation to lines '
      + 'a read receipt of this attempt displayed. Add a citation, or resubmit this finding as inferred.',
    );
    // A finding given with no citations field at all is the same finding.
    expect(reasonOf(validateReviewEvidence(parsed(submission({ findings: [{ classification: 'observed', statement: 'x' }] })), attemptReceipts())))
      .toMatch(/^finding 1 is observed and has no citation\./);
    // The same words resubmitted as inferred are accepted, and counted as uncited reasoning.
    expect(validateReviewEvidence(parsed(submission({ findings: [{ classification: 'inferred', ...uncited }] })), attemptReceipts()))
      .toMatchObject({ ok: true, receipt: { citations: 0, findings: { observed: { total: 0, cited: 0 }, inferred: { total: 1, cited: 0 } } } });
  });

  it('traces through several files only when every hop was displayed in this attempt', () => {
    const receipts = attemptReceipts();
    receipts.issueRead({ path: 'src/c.ts', pathAliases: [], startLine: 1, endLine: 5, contentDigest: DIGEST, coverage: 'complete' });
    const chain = (lastHop: string) => submission({
      findings: [{ classification: 'source-traced', statement: 'a imports b, b imports c.', citations: [
        { readReceiptId: 'R1', path: 'src/a.ts', startLine: 10, endLine: 11 },
        { readReceiptId: 'R2', path: 'src/b.ts', startLine: 3, endLine: 3 },
        { readReceiptId: lastHop, path: 'src/c.ts', startLine: 2, endLine: 2 },
      ] }],
    });

    const traced = validateReviewEvidence(parsed(chain('R3')), receipts);
    expect(traced).toMatchObject({ ok: true, receipt: { citations: 3, citedFiles: 3, findings: { 'source-traced': { total: 1, cited: 1 } } } });
    expect(reasonOf(validateReviewEvidence(parsed(chain('R4')), receipts)))
      .toBe('finding 1, citation 3: read receipt R4 was not issued in this attempt.');
  });

  it('refuses complete coverage over a search that did not scan everything', () => {
    const overall = submission({ coverage: 'complete', searches: [{ searchReceiptId: 'S2', coverage: 'partial' }] });
    expect(reasonOf(validateReviewEvidence(parsed(overall), attemptReceipts()))).toBe(
      'coverage "complete" is refused: search receipt S2, over scope ".", was partial (the search reached its result limit). '
      + 'Report coverage "partial". The host records overall coverage as your statement and does not confirm it.',
    );

    const perSearch = submission({ coverage: 'partial', searches: [{ searchReceiptId: 'S2', coverage: 'complete' }] });
    expect(reasonOf(validateReviewEvidence(parsed(perSearch), attemptReceipts())))
      .toBe('search 1: search receipt S2 was partial (the search reached its result limit); it cannot be submitted as complete.');
  });

  it('accepts complete coverage over complete searches, and an understated search as the host recorded it', () => {
    const complete = validateReviewEvidence(parsed(submission({ coverage: 'complete', searches: [{ searchReceiptId: 'S1', coverage: 'complete' }] })), attemptReceipts());
    expect(complete).toMatchObject({ ok: true, receipt: { reportedCoverage: 'complete', citedSearchCoverage: 'complete', searches: { complete: 1, partial: 0 } } });

    // The reviewer called a complete scan partial. That overstates nothing, and the count stays the host's fact.
    const understated = validateReviewEvidence(parsed(submission({ coverage: 'partial', searches: [{ searchReceiptId: 'S1', coverage: 'partial' }] })), attemptReceipts());
    expect(understated).toMatchObject({ ok: true, receipt: { reportedCoverage: 'partial', citedSearchCoverage: 'complete', searches: { complete: 1, partial: 0 } } });
  });

  it('keeps the overall coverage as the reviewer reported it, under a name that says so, and adds no finding of its own', () => {
    // Complete coverage reported with no search cited at all: nothing refutes it, and nothing confirms it.
    const result = validateReviewEvidence(parsed(submission({ coverage: 'complete' })), attemptReceipts());
    if (!result.ok) throw new Error(result.reason);

    expect(result.receipt).toMatchObject({ reportedCoverage: 'complete', citedSearchCoverage: 'none', searches: { complete: 0, partial: 0 } });
    // Mutation: a receipt that carries the submitted coverage under a plain `coverage` reads as the host's own fact.
    expect(Object.keys(result.receipt).sort()).toEqual(
      ['citations', 'citedFiles', 'citedSearchCoverage', 'findings', 'reportedCoverage', 'schemaVersion', 'searches'],
    );
  });

  it('refuses a search receipt this attempt does not hold and records no search coverage when none is cited', () => {
    expect(reasonOf(validateReviewEvidence(parsed(submission({ searches: [{ searchReceiptId: 'S9', coverage: 'partial' }] })), attemptReceipts())))
      .toBe('search 1: search receipt S9 was not issued in this attempt.');
    expect(validateReviewEvidence(parsed(submission()), attemptReceipts()))
      .toMatchObject({ ok: true, receipt: { citedSearchCoverage: 'none', searches: { complete: 0, partial: 0 } } });
  });
});

describe('closeReviewEvidence', () => {
  it('closes without evidence as not submitted, never as checked', () => {
    expect(closeReviewEvidence(undefined, attemptReceipts())).toEqual({ ok: true, state: { schemaVersion: 1, state: 'not-submitted' } });
    expect(closeReviewEvidence(null, attemptReceipts())).toEqual({ ok: true, state: REVIEW_EVIDENCE_NOT_SUBMITTED });
  });

  it('closes evidence that holds as citations checked, with its receipt', () => {
    const closed = closeReviewEvidence(submission(), attemptReceipts());

    expect(closed).toMatchObject({ ok: true, state: { schemaVersion: 1, state: 'citations-checked', receipt: { citations: 1, reportedCoverage: 'partial' } } });
  });

  it('refuses invalid evidence with its reason, what can be cited, and both ways on', () => {
    const closed = closeReviewEvidence(
      submission({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 1, endLine: 5 }] }] }),
      attemptReceipts(),
    );

    expect(reasonOf(closed)).toBe(
      'Error: review_evidence was refused. finding 1, citation 1: lines 1-5 are outside the lines read receipt R1 displayed (10-40). '
      + 'Nothing was recorded. Read receipts of this attempt: R1 (src/a.ts lines 10-40), R2 (src/b.ts lines 1-12). '
      + 'Search receipts of this attempt: S1 (complete, scope "src"), S2 (partial, scope "."). '
      + 'Correct the submission, or call close_assignment without review_evidence to close with evidence not submitted.',
    );
  });

  it('keeps the three answers apart in their words: not submitted, refused, citations checked', () => {
    const notSubmitted = closeReviewEvidence(undefined, attemptReceipts());
    const refused = closeReviewEvidence(submission({ findings: [{ classification: 'observed', statement: 'x' }] }), attemptReceipts());
    const checked = closeReviewEvidence(submission(), attemptReceipts());
    if (!notSubmitted.ok || !checked.ok) throw new Error('fixture did not close');

    // Each answer opens with its own sentence, and a refusal records nothing that could be read as either state.
    const texts = [describeReviewEvidenceState(notSubmitted.state), reasonOf(refused), describeReviewEvidenceState(checked.state)];
    expect(texts.map((text) => text.slice(0, text.indexOf('.')))).toEqual([
      'review evidence: not submitted',
      'Error: review_evidence was refused',
      'review evidence: citations checked by the host',
    ]);
    expect(refused).not.toHaveProperty('state');
  });

  it('says that nothing can be cited when the attempt holds no receipt', () => {
    expect(reasonOf(closeReviewEvidence(submission(), new ReviewReceiptRegistry())))
      .toContain('Read receipts of this attempt: none. Search receipts of this attempt: none.');
    expect(reasonOf(closeReviewEvidence('R1', new ReviewReceiptRegistry()))).toContain('review_evidence must be an object.');
  });

  it('lists a bounded number of receipts, the newest ones', () => {
    const receipts = new ReviewReceiptRegistry();
    for (let index = 1; index <= 25; index++) {
      receipts.issueRead({ path: `f${index}.ts`, pathAliases: [], startLine: 1, endLine: 2, contentDigest: DIGEST, coverage: 'complete' });
    }
    const listed = describeAttemptReceipts(receipts);

    expect(listed).toContain('R25 (f25.ts lines 1-2), and 5 earlier.');
    expect(listed).toContain('R6 (f6.ts lines 1-2)');
    expect(listed).not.toContain('R5 (');
  });
});

describe('contentDigestOf', () => {
  it('is SHA-256 over the bytes as given, so a byte-order mark, a carriage return and a byte that is no text all count', () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0x62, 0x0a]);

    expect(contentDigestOf(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(contentDigestOf(new Uint8Array(bytes))).toBe(contentDigestOf(bytes));
    // Text decoded from the bytes is other bytes once encoded again, and so another digest.
    const decoded = new TextDecoder('utf-8').decode(bytes);
    expect(contentDigestOf(Buffer.from(decoded, 'utf8'))).not.toBe(contentDigestOf(bytes));
    for (const removed of [[0, 3], [4, 5], [6, 7]]) {
      const without = Buffer.concat([bytes.subarray(0, removed[0]), bytes.subarray(removed[1])]);
      expect(contentDigestOf(without)).not.toBe(contentDigestOf(bytes));
    }
    expect(contentDigestOf(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('a review with a bound target', () => {
  const DISPATCHED = 'd'.repeat(64);
  /** `src/a.ts` is the file under review. R1 displayed it as dispatched, R2 as other bytes; R3 is another file. */
  function targetReceipts(): ReviewReceiptRegistry {
    const receipts = new ReviewReceiptRegistry();
    receipts.issueRead({ path: 'src/a.ts', pathAliases: [], startLine: 1, endLine: 40, contentDigest: DISPATCHED, coverage: 'complete' });
    receipts.issueRead({ path: 'src/a.ts', pathAliases: [], startLine: 1, endLine: 40, contentDigest: DIGEST, coverage: 'complete' });
    receipts.issueRead({ path: 'src/b.ts', pathAliases: [], startLine: 1, endLine: 40, contentDigest: DIGEST, coverage: 'complete' });
    return receipts;
  }
  const target: ReviewTarget = { contentDigest: DISPATCHED, isViewOfTarget: (receipt) => receipt.path === 'src/a.ts' };
  const citing = (...citations: Array<[string, string]>) => submission({
    findings: [{
      classification: 'observed', statement: 'The guard is missing.',
      citations: citations.map(([readReceiptId, path]) => ({ readReceiptId, path, startLine: 12, endLine: 14 })),
    }],
  });

  it('refuses a citation to a view of the target that displayed other bytes than the dispatched ones, and marks it as a changed target', () => {
    expect(validateReviewEvidence(parsed(citing(['R2', 'src/a.ts'])), targetReceipts(), target)).toEqual({
      ok: false,
      targetChanged: true,
      reason: 'finding 1, citation 1: read receipt R2 displayed the file under review with content other than it had when this review was dispatched.',
    });
    // One such citation refuses the submission, wherever it stands among citations that hold.
    expect(validateReviewEvidence(parsed(citing(['R1', 'src/a.ts'], ['R3', 'src/b.ts'], ['R2', 'src/a.ts'])), targetReceipts(), target))
      .toMatchObject({ ok: false, targetChanged: true, reason: expect.stringContaining('finding 1, citation 3: read receipt R2 displayed') });
  });

  it('accepts a view of the dispatched bytes, holds no other file to the target\'s digest, and checks nothing without a target', () => {
    expect(validateReviewEvidence(parsed(citing(['R1', 'src/a.ts'], ['R3', 'src/b.ts'])), targetReceipts(), target))
      .toMatchObject({ ok: true, receipt: { citations: 2, citedFiles: 2 } });
    // A review of an upstream artifact has no bound file: any view this attempt holds can be cited, as before.
    expect(validateReviewEvidence(parsed(citing(['R2', 'src/a.ts'])), targetReceipts())).toMatchObject({ ok: true, receipt: { citations: 1 } });
    expect(closeReviewEvidence(citing(['R2', 'src/a.ts']), targetReceipts())).toMatchObject({ ok: true, state: { state: 'citations-checked' } });
  });

  it('keeps the ordinary faults of a citation ordinary: an unknown receipt, another file and lines outside the view are evidence to correct', () => {
    for (const [raw, fault] of [
      [citing(['R9', 'src/a.ts']), 'read receipt R9 was not issued in this attempt.'],
      [citing(['R2', 'src/b.ts']), 'is not the file read receipt R2 displayed'],
      [submission({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R2', path: 'src/a.ts', startLine: 39, endLine: 41 }] }] }), 'lines 39-41 are outside the lines read receipt R2 displayed (1-40).'],
    ] as const) {
      const validated = validateReviewEvidence(parsed(raw), targetReceipts(), target);
      expect(validated).not.toHaveProperty('targetChanged');
      expect(reasonOf(validated)).toContain(fault);
      const refused = closeReviewEvidence(raw, targetReceipts(), target) as { ok: false; reason: string; finding: string };
      expect(reasonOf(refused)).toMatch(/^Error: review_evidence was refused\./);
      // The same text without the failure mark, for a caller that reports it without failing.
      expect(refused.finding).toMatch(/^review_evidence was refused\./);
      expect(refused.reason).toBe(`Error: ${refused.finding}`);
    }
  });

  it('closes nothing for a changed target and names a new review as the way on, in words of its own', () => {
    const closed = closeReviewEvidence(citing(['R2', 'src/a.ts']), targetReceipts(), target);

    expect(closed).not.toHaveProperty('state');
    expect(reasonOf(closed)).toBe(
      'Error: review target changed; dispatch a new review. finding 1, citation 1: read receipt R2 displayed the file under review '
      + 'with content other than it had when this review was dispatched. This call recorded nothing for the review. A review of a '
      + 'workspace file is closed only against that file as it was dispatched: have a new review dispatched for the file as it is '
      + 'now, or, if you cannot dispatch one, say in your reply that the review target changed.',
    );
    const detail = 'finding 1, citation 1: read receipt R2 displayed the file under review with content other than it had when this review was dispatched.';
    expect(reasonOf(closed)).toBe(reviewTargetChangedRefusal(detail));
    // The finding is the same text without the failure mark; the reason is made from it and never read back out.
    expect(closed).toEqual({ ok: false, reason: `Error: ${reviewTargetChangedFinding(detail)}`, finding: reviewTargetChangedFinding(detail) });
    expect(reviewTargetChangedFinding(detail)).toMatch(/^review target changed; dispatch a new review\. finding 1, citation 1: /);
    expect(reviewCloseRefusal('the host found this.')).toEqual({ reason: 'Error: the host found this.', finding: 'the host found this.' });
    expect(reasonOf(closed)).not.toMatch(/Correct the submission|without review_evidence|Read receipts of this attempt/);
    expect(reasonOf(closed).split('\n')).toHaveLength(1);
  });
});

describe('the review-evidence receipt', () => {
  it('carries no statement, path, line number, digest or receipt id', () => {
    const closed = closeReviewEvidence(submission({
      findings: [{ classification: 'observed', statement: 'SENTINEL-STATEMENT about a secret', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 12, endLine: 14 }] }],
      searches: [{ searchReceiptId: 'S2', coverage: 'partial' }],
    }), attemptReceipts());
    const serialised = JSON.stringify(closed);

    expect(closed.ok).toBe(true);
    const cited = attemptReceipts().search('S2')!;
    for (const absent of [
      'SENTINEL-STATEMENT', 'src/a.ts', DIGEST, '"R1"', '"S2"', 'startLine', 'statement', 'path',
      // Nor what the cited search asked: its query, its scope or the digest that binds them.
      QUERY, cited.searchDigest, 'scope', 'query',
    ]) {
      expect(serialised).not.toContain(absent);
    }
    // Every value in the receipt is a count, a version or one of a few fixed words.
    const values: unknown[] = [];
    JSON.stringify(closed, (_key, value) => { if (typeof value !== 'object') values.push(value); return value; });
    expect(values.every((value) => typeof value === 'number' || typeof value === 'boolean'
      || ['citations-checked', 'complete', 'partial', 'none'].includes(String(value)))).toBe(true);
  });

  const stateOf = (raw: Record<string, unknown>): ReviewEvidenceState => {
    const closed = closeReviewEvidence(raw, attemptReceipts());
    if (!closed.ok) throw new Error(closed.reason);
    return closed.state;
  };

  it('is described in one line that says what the host checked and what it did not', () => {
    expect(describeReviewEvidenceState(stateOf(submission({ searches: [{ searchReceiptId: 'S2', coverage: 'partial' }] })))).toBe(
      'review evidence: citations checked by the host. 1 finding: 1 observed (1 cited), 0 source-traced (0 cited), 0 inferred (0 cited); '
      + '1 citation in 1 file; 1 search cited (1 partial). '
      + 'The reviewer reported overall coverage partial; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );
    expect(describeReviewEvidenceState(REVIEW_EVIDENCE_NOT_SUBMITTED)).toBe(
      'review evidence: not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.',
    );
    // The same sentence without its label, for a surface that prints its own.
    expect(`review evidence: ${describeReviewEvidence(REVIEW_EVIDENCE_NOT_SUBMITTED)}`).toBe(describeReviewEvidenceState(REVIEW_EVIDENCE_NOT_SUBMITTED));
  });

  it('presents complete coverage as what the reviewer reported, and says when no search was cited', () => {
    // The strongest submission a reviewer can make without a single search: every word of it is the reviewer's.
    const line = describeReviewEvidenceState(stateOf(submission({ coverage: 'complete' })));

    expect(line).toBe(
      'review evidence: citations checked by the host. 1 finding: 1 observed (1 cited), 0 source-traced (0 cited), 0 inferred (0 cited); '
      + '1 citation in 1 file; no search was cited. '
      + 'The reviewer reported overall coverage complete; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );
    // Mutation: the coverage stated bare, as the host's own fact, is what this line must never say.
    expect(line).not.toMatch(/(?<!reported )overall coverage complete/);
    expect(line).not.toMatch(/validated|verified|confirmed/);

    // With complete searches cited the sentence is the same: a cited search can refute the report, never confirm it.
    const withSearch = describeReviewEvidenceState(stateOf(submission({ coverage: 'complete', searches: [{ searchReceiptId: 'S1', coverage: 'complete' }] })));
    expect(withSearch).toContain('1 search cited (0 partial). The reviewer reported overall coverage complete; the host did not check that.');
  });

  it('says the host checked nothing when a submission cites no receipt at all', () => {
    const line = describeReviewEvidenceState(stateOf(submission({
      coverage: 'complete',
      findings: [{ classification: 'inferred', statement: 'Probably fine.' }],
    })));

    expect(line).toBe(
      'review evidence: submitted with nothing for the host to check. 1 finding: 0 observed (0 cited), 0 source-traced (0 cited), 1 inferred (0 cited); '
      + '0 citations in 0 files; no search was cited. '
      + 'The reviewer reported overall coverage complete; the host did not check that. '
      + 'No receipt was cited, so the findings are the reviewer\'s reasoning only.',
    );
    expect(line).not.toContain('citations checked');
  });
});

describe('parseReviewEvidenceState', () => {
  const checked = () => {
    const closed = closeReviewEvidence(submission({ searches: [{ searchReceiptId: 'S1', coverage: 'complete' }] }), attemptReceipts());
    if (!closed.ok || closed.state.state !== 'citations-checked') throw new Error('fixture was not checked');
    return closed.state;
  };

  it('reads back both states exactly as they were written', () => {
    const state = checked();

    expect(parseReviewEvidenceState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseReviewEvidenceState(state)).toEqual(state);
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'not-submitted' })).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    expect(parseReviewEvidenceState(REVIEW_EVIDENCE_NOT_SUBMITTED)).toEqual(REVIEW_EVIDENCE_NOT_SUBMITTED);
  });

  it('yields nothing for a state that holds a key it does not know, at any depth', () => {
    const state = checked();
    const { receipt } = state;

    expect(parseReviewEvidenceState({ ...state, reviewer: 'model-x' })).toBeUndefined();
    expect(parseReviewEvidenceState({ ...state, receipt: { ...receipt, paths: ['src/a.ts'] } })).toBeUndefined();
    expect(parseReviewEvidenceState({ ...state, receipt: { ...receipt, findings: { ...receipt.findings, verified: { total: 1, cited: 1 } } } })).toBeUndefined();
    expect(parseReviewEvidenceState({ ...state, receipt: { ...receipt, findings: { ...receipt.findings, observed: { total: 1, cited: 1, statement: 'x' } } } })).toBeUndefined();
    expect(parseReviewEvidenceState({ ...state, receipt: { ...receipt, searches: { complete: 1, partial: 0, queries: ['x'] } } })).toBeUndefined();
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'not-submitted', note: 'x' })).toBeUndefined();
    // A state that carries a receipt it has no place for is not `not-submitted` with something extra.
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'not-submitted', receipt })).toBeUndefined();
  });

  it('yields nothing for a state that is unknown, incomplete or contradicts itself', () => {
    const { receipt } = checked();
    const withReceipt = (change: Record<string, unknown>) => ({ schemaVersion: 1, state: 'citations-checked', receipt: { ...receipt, ...change } });
    const without = (key: keyof typeof receipt) => {
      const rest: Record<string, unknown> = { ...receipt };
      delete rest[key];
      return { schemaVersion: 1, state: 'citations-checked', receipt: rest };
    };

    for (const notAState of [undefined, null, 'citations-checked', [], 7]) {
      expect(parseReviewEvidenceState(notAState)).toBeUndefined();
    }
    expect(parseReviewEvidenceState({ schemaVersion: 2, state: 'not-submitted' })).toBeUndefined();
    expect(parseReviewEvidenceState({ state: 'not-submitted' })).toBeUndefined();
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'verified' })).toBeUndefined();
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'citations-checked' })).toBeUndefined();
    // The name this state had before, and the names its two coverage fields had: none of them is read as today's.
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'validated', receipt })).toBeUndefined();
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'citations-checked', receipt: { ...without('reportedCoverage').receipt, coverage: 'partial' } })).toBeUndefined();
    expect(parseReviewEvidenceState({ schemaVersion: 1, state: 'citations-checked', receipt: { ...without('citedSearchCoverage').receipt, searchCoverage: 'complete' } })).toBeUndefined();
    // A missing key is never filled in.
    for (const key of ['schemaVersion', 'findings', 'citations', 'citedFiles', 'searches', 'citedSearchCoverage', 'reportedCoverage'] as const) {
      expect(parseReviewEvidenceState(without(key)), key).toBeUndefined();
    }
    expect(parseReviewEvidenceState(withReceipt({ schemaVersion: 2 }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ findings: { observed: receipt.findings.observed, inferred: receipt.findings.inferred } }))).toBeUndefined();
    // More cited findings than findings; a negative, fractional or textual count.
    expect(parseReviewEvidenceState(withReceipt({ findings: { ...receipt.findings, inferred: { total: 1, cited: 2 } } }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citations: -1 }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citations: 1.5 }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citations: '1' }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citedFiles: 5 }))).toBeUndefined();
    // More citations than its one cited finding can hold, and citations with no cited finding to hold them.
    expect(parseReviewEvidenceState(withReceipt({ citations: 9, citedFiles: 1 }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({
      findings: { observed: { total: 0, cited: 0 }, 'source-traced': { total: 0, cited: 0 }, inferred: { total: 3, cited: 0 } }, citations: 2, citedFiles: 1,
    }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citations: 8, citedFiles: 1 }))).toMatchObject({ receipt: { citations: 8 } });
    expect(parseReviewEvidenceState(withReceipt({ searches: { complete: '1', partial: 0 } }))).toBeUndefined();
    // An observed or a source-traced finding recorded without a citation: the host never records one.
    expect(parseReviewEvidenceState(withReceipt({ findings: { ...receipt.findings, observed: { total: 2, cited: 1 } } }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ findings: { ...receipt.findings, 'source-traced': { total: 1, cited: 0 } } }))).toBeUndefined();
    // A reported coverage that is no coverage; complete reported over a cited partial search; a cited-search
    // coverage the counts do not support.
    expect(parseReviewEvidenceState(withReceipt({ reportedCoverage: 'full' }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ reportedCoverage: 'complete', searches: { complete: 0, partial: 1 }, citedSearchCoverage: 'partial' }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ searches: { complete: 0, partial: 1 }, citedSearchCoverage: 'complete' }))).toBeUndefined();
    expect(parseReviewEvidenceState(withReceipt({ citedSearchCoverage: 'none' }))).toBeUndefined();
  });
});

describe('receipt lines and the tool schema', () => {
  it('prints a read receipt line that names the id, the file and the citable range', () => {
    const receipts = attemptReceipts();

    expect(readReceiptLine(receipts.read('R1') as ReviewReadReceipt, 200)).toBe(
      '[read receipt R1: src/a.ts lines 10-40 of 200. To cite these lines, use readReceiptId "R1" with this path and line numbers inside this range.]',
    );
    expect(readReceiptLine(receipts.read('R2') as ReviewReadReceipt, 12)).toContain('lines 1-12 of 12, the whole file.');
  });

  it('prints a search receipt line that names the scope and says in words whether the scan covered it', () => {
    const receipts = attemptReceipts();

    expect(searchReceiptLine(receipts.search('S1')!)).toBe(
      '[search receipt S1: complete coverage of scope "src", the whole scope was scanned; 30 files scanned; result cap 100. '
      + 'To cite this search, use searchReceiptId "S1" with coverage "complete".]',
    );
    expect(searchReceiptLine(receipts.search('S2')!)).toBe(
      '[search receipt S2: PARTIAL coverage of scope ".", the search reached its result limit; 12 files scanned; result cap 5. '
      + 'To cite this search, use searchReceiptId "S2" with coverage "partial".]',
    );
    // A search over more than one folder names each of them; the query is in none of the lines.
    const wide = receipts.issueSearch({ filesScanned: 2, resultCap: 100, stopReason: 'completed' }, { scope: ['src', 'C:\\shared\\src'], query: QUERY })!;
    expect(searchReceiptLine(wide)).toContain('complete coverage of scope "C:/shared/src", "src", the whole scope was scanned;');
    expect(receipts.searchReceipts().map(searchReceiptLine).join('\n')).not.toContain(QUERY);
  });

  it('says in the schema which findings need a citation and whose statement the coverage is', () => {
    const schema = reviewEvidenceParameter() as any;
    const finding = schema.properties.findings.items.properties;

    expect(finding.classification.description).toBe(
      'observed: you saw it at the cited lines. source-traced: you followed it through the cited lines of one or more files. '
      + 'Each of those two needs at least one citation. inferred: your reasoning, which may have none. A finding you cannot cite is inferred.',
    );
    expect(finding.citations.description).toContain('Required for an observed or source-traced finding.');
    expect(schema.properties.coverage.description).toBe(
      'Your own statement of whether you covered the whole review scope. The host records it as reported by you and does not confirm it. '
      + 'It refuses complete if any search you list was partial.',
    );
    expect(schema.description).toContain('It does not show that a finding is correct or that the review covered everything.');
    expect(JSON.stringify(schema)).not.toMatch(/validat/i);
  });

  it('states in the schema the same limits the parser enforces', () => {
    const schema = reviewEvidenceParameter() as any;
    const finding = schema.properties.findings.items.properties;

    expect(schema.required).toEqual(['schemaVersion', 'coverage', 'findings']);
    expect(schema.properties.findings.description).toContain(`At most ${MAX_REVIEW_FINDINGS} findings`);
    expect(finding.citations.description).toContain(`At most ${MAX_CITATIONS_PER_FINDING} citations`);
    expect(schema.properties.searches.description).toContain(`At most ${MAX_REVIEW_SEARCH_RECEIPTS} search receipts`);
    expect(finding.statement.description).toContain(`at most ${MAX_FINDING_STATEMENT_CHARACTERS} characters`);
    expect(finding.classification.enum).toEqual(['observed', 'source-traced', 'inferred']);
    expect(finding.citations.items.required).toEqual(['readReceiptId', 'path', 'startLine', 'endLine']);
  });

  it('keeps the schema to words every connection accepts', () => {
    // This schema reaches whichever model a reviewer runs on. Limits are prose plus the parser, not schema keywords.
    const words = new Set<string>();
    JSON.stringify(reviewEvidenceParameter(), (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) Object.keys(value).forEach((word) => words.add(word));
      return value;
    });

    expect([...words].sort()).toEqual(['description', 'enum', 'items', 'properties', 'required', 'type']);
    expect(JSON.stringify(reviewEvidenceParameter())).not.toMatch(/"enum":\[\d/);
  });
});
