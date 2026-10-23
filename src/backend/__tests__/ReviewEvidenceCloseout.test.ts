import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { MessageBus } from '../../bus/MessageBus';
import { renderPortableRunEvidence } from '../../observability/PortableRunEvidence';
import { RunLedger } from '../../observability/RunLedger';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';
import { ReviewReceiptRegistry } from '../ReviewEvidence';
import {
  compileTaskContract,
  formatTaskAttemptCard,
  TaskInputResolver,
  type CandidateContractAgent,
  type TaskAttemptCard,
} from '../TaskContract';
import {
  REVIEW_EVIDENCE_WITHOUT_REVIEW,
  TeamTools,
  type AssignmentCloseoutEvent,
  type DelegationEvidenceRecord,
  type TeamRosterEntry,
  type TeamView,
} from '../TeamTools';
import { WorkspaceTools } from '../WorkspaceTools';

/**
 * v0.9.94: closing a review with evidence, end to end over the real file tools and the real attempt registry.
 * The pure rules have their own suite; these tests are about who may close, which receipts belong to which
 * attempt, and what is recorded.
 */

const FILE_A = "import { b } from './b';\nexport const a = () => b();\n// SENTINEL-FILE-CONTENT a\nexport const unused = 1;\n";
const FILE_B = "import { c } from './c';\nexport const b = () => c();\n";
const FILE_C = 'export const c = () => 42;\n';
/** FILE_A after an edit that keeps every line where it was, so a citation's lines still exist. */
const FILE_A_EDITED = FILE_A.replace('unused = 1', 'unused = 2');
const POLICY_OFF = { version: 1 as const, requireDifferentReportedModelForArtifactReview: false };

/** What closing a review of a workspace file is told once that file is no longer what was dispatched. */
const targetChangedFinding = (detail: string) => `review target changed; dispatch a new review. ${detail} This call recorded `
  + 'nothing for the review. A review of a workspace file is closed only against that file as it was dispatched: have a new '
  + 'review dispatched for the file as it is now, or, if you cannot dispatch one, say in your reply that the review target changed.';
/** As the text of a failed call. A call that goes on and reports the finding carries it without this mark. */
const targetChanged = (detail: string) => `Error: ${targetChangedFinding(detail)}`;
const CONTENT_CHANGED = 'The file under review (input "target") no longer has the content it had when this review was dispatched.';
const PATH_CHANGED = 'The path of the file under review (input "target") now leads to another file than the one this review was dispatched for.';
const FILE_GONE = 'The file under review (input "target") is no longer a file the host can read at its path.';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Inspect the declared source and deliver a bounded result.',
    expected_deliverable: 'A concrete result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
    ...overrides,
  };
}

function candidate(agentId: string, extras: Partial<CandidateContractAgent> = {}): CandidateContractAgent {
  return {
    agentId,
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: [],
    liveContentAssetIds: [],
    readyArtifacts: [],
    ...extras,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'unode-review-evidence-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), FILE_A, 'utf8');
  await writeFile(join(root, 'src', 'b.ts'), FILE_B, 'utf8');
  await writeFile(join(root, 'src', 'c.ts'), FILE_C, 'utf8');
  const store = new ContentAssetStore();
  const resolver = new TaskInputResolver(store, root);
  cleanups.push(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  // An artifact a producer published: the thing a marked review is a review of.
  const producerContract = compileTaskContract(proposal(), 'pm').contract!;
  const producer = await resolver.beginAttempt(producerContract, candidate('producer'), 'pm');
  const artifact = (await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'ARTIFACT UNDER REVIEW')).artifact!;
  resolver.endAttempt(producer.card!.attemptId, 'settled');

  const rawReviewContract = (overrides: Record<string, unknown> = {}) => proposal({
    inputs: [{
      input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: artifact.artifactId, purpose: 'Review target',
      required: true, freshness: 'artifact-ready', provenance: { kind: 'upstream-artifact', source_refs: [] },
    }],
    dependencies: [artifact.artifactId],
    review: { input_id: 'artifact' },
    ...overrides,
  });
  const admit = (card: TaskAttemptCard) => {
    const decision = evaluateReviewPolicy({ review: card.contract.review, policy: POLICY_OFF });
    resolver.recordReviewAdmission(card.attemptId, decision);
    return decision;
  };
  /** A live attempt for `agentId`. A marked review is admitted unless the test says otherwise. */
  const begin = async (agentId: string, options: { review?: boolean; admitted?: boolean } = {}): Promise<TaskAttemptCard> => {
    const contract = compileTaskContract(options.review === false ? proposal() : rawReviewContract(), 'pm').contract!;
    const attempt = await resolver.beginAttempt(contract, candidate(agentId, { readyArtifacts: resolver.readyArtifacts() }), 'pm');
    expect(attempt.error).toBeUndefined();
    if (options.admitted !== false) admit(attempt.card!);
    return attempt.card!;
  };
  /** The other thing a marked review may be a review of: a workspace file, read where it stands. */
  const rawFileReviewContract = (overrides: Record<string, unknown> = {}, targetPath = 'src/a.ts') => proposal({
    inputs: [{
      input_id: 'target', kind: 'workspacePath', path: targetPath, purpose: 'Review target',
      required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
    }],
    review: { input_id: 'target' },
    ...overrides,
  });
  /** A live, admitted review of the workspace file at `targetPath`, bound as that file is right now. */
  const beginFileReview = async (agentId: string, targetPath = 'src/a.ts'): Promise<TaskAttemptCard> => {
    const compiled = compileTaskContract(rawFileReviewContract({}, targetPath), 'pm');
    expect(compiled.error).toBeUndefined();
    const attempt = await resolver.beginAttempt(compiled.contract!, candidate(agentId), 'pm');
    expect(attempt.error).toBeUndefined();
    admit(attempt.card!);
    return attempt.card!;
  };
  const toolsFor = (agentId: string) => {
    const tools = new WorkspaceTools(root, new Set(['read']), agentId);
    tools.setTaskInputResolver(resolver);
    return tools;
  };
  /** What a backend does when a delegated turn begins. */
  const startTurn = (tools: WorkspaceTools, card?: TaskAttemptCard) => {
    tools.beginTurn();
    tools.setTaskAttempt(card);
  };
  return { root, resolver, rawReviewContract, rawFileReviewContract, admit, begin, beginFileReview, toolsFor, startTurn };
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    coverage: 'partial',
    findings: [
      { classification: 'observed', statement: 'a.ts exports an unused constant.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 4, endLine: 4 }] },
    ],
    searches: [],
    ...overrides,
  };
}

const advertised = (tools: WorkspaceTools) => tools.specs().map((spec) => spec.function.name);

describe('who may close a review with evidence', () => {
  it('offers close_assignment only to the holder of a delegated, admitted review', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');

    startTurn(tools);
    expect(advertised(tools)).not.toContain('close_assignment');

    startTurn(tools, await begin('reviewer', { review: false }));
    expect(advertised(tools)).toEqual(expect.arrayContaining(['report_context_gap', 'publish_task_artifact']));
    expect(advertised(tools)).not.toContain('close_assignment');

    startTurn(tools, await begin('reviewer', { admitted: false }));
    expect(advertised(tools)).not.toContain('close_assignment');

    startTurn(tools, await begin('reviewer'));
    const spec = tools.specs().find((candidateSpec) => candidateSpec.function.name === 'close_assignment')!;
    expect(spec.function.parameters).toMatchObject({ required: [], properties: { review_evidence: { type: 'object' } } });
    // One or two plain sentences where the reviewer decides: which reads can be cited.
    expect(spec.function.description).toContain("Only UnodeAi's read_file and search_files issue receipts; a read or search made with any other tool cannot be cited.");
    expect(spec.function.description).toContain('grants no file, command or network authority');
    // And what the check is worth: which findings need a citation, and that it judges neither a finding nor the coverage.
    expect(spec.function.description).toContain('An observed or source-traced finding must cite lines that read_file displayed with line_numbers: true; only an inferred finding may cite none.');
    expect(spec.function.description).toContain('A checked citation shows that those lines were displayed to you, not that the finding is correct, and your overall coverage is recorded as your own statement.');
  });

  it('gives a coordinator running its own review no second tool of that name', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const coordinatorFiles = toolsFor('pm');

    startTurn(coordinatorFiles, await begin('pm'));

    expect(advertised(coordinatorFiles)).not.toContain('close_assignment');
    await expect(coordinatorFiles.run('close_assignment', { review_evidence: evidence() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
  });

  it('tells a reader to cite receipts in close_assignment exactly where its tool list offers close_assignment', async () => {
    const { begin, beginFileReview, toolsFor, startTurn } = await fixture();
    const lineNumbers = (tools: WorkspaceTools) => (tools.specs().find((spec) => spec.function.name === 'read_file')!
      .function.parameters as { properties: Record<string, { description: string }> }).properties.line_numbers.description;
    const neutral = 'Set true to prefix every returned line with its 1-based line number and to receive a short host read receipt '
      + '(R1, R2, ...) for the lines displayed. A receipt is local to the current attempt: when another attempt or turn begins, '
      + 'numbering starts again and earlier receipts no longer exist.';
    const citation = 'A reviewer cites these receipts in close_assignment review_evidence. Only this tool and search_files issue '
      + 'receipts; a read or search made with any other tool cannot be cited.';
    const reader = toolsFor('reviewer');
    const coordinatorFiles = toolsFor('pm');

    // Every reader that holds no delegated, admitted review: numbered lines and a receipt, and no tool it lacks.
    const ordinary: Array<[WorkspaceTools, TaskAttemptCard | undefined]> = [
      [reader, undefined],
      [reader, await begin('reviewer', { review: false })],
      [reader, await begin('reviewer', { admitted: false })],
      // A coordinator closes its own review through its team tools; this list has no close_assignment for it.
      [coordinatorFiles, await begin('pm')],
    ];
    for (const [tools, card] of ordinary) {
      startTurn(tools, card);
      expect(advertised(tools)).not.toContain('close_assignment');
      expect(lineNumbers(tools)).toBe(`${neutral} Do not combine it with publish_to_user.`);
      expect(lineNumbers(tools)).not.toMatch(/close_assignment|review_evidence|cite/);
    }

    // The holder of a delegated, admitted review, of an artifact or of a workspace file: the sentence and the tool together.
    for (const card of [await begin('reviewer'), await beginFileReview('reviewer')]) {
      startTurn(reader, card);
      expect(advertised(reader)).toContain('close_assignment');
      expect(lineNumbers(reader)).toBe(`${neutral} ${citation} Do not combine it with publish_to_user.`);
    }

    // The next turn has no review: the sentence leaves with the tool.
    startTurn(reader);
    expect(advertised(reader)).not.toContain('close_assignment');
    expect(lineNumbers(reader)).not.toContain('close_assignment');
  });

  it('refuses the call in one line when the task is not an admitted review, with or without evidence', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const refusal = 'close_assignment refused: capability. Use an allowed tool or ask for the required capability.\n\n'
      + 'close_assignment is available only while executing an admitted review task.';

    startTurn(tools);
    await expect(tools.runText('close_assignment', { review_evidence: evidence() })).resolves.toBe(refusal);

    const ordinary = await begin('reviewer', { review: false });
    startTurn(tools, ordinary);
    await expect(tools.run('close_assignment', { review_evidence: evidence() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability', output: refusal });
    await expect(tools.runText('close_assignment', {})).resolves.toBe(refusal);
    // An ordinary task has no review-evidence fact at all: not "citations checked" and not "not submitted".
    expect(tools.taskAttemptEvidence()).not.toHaveProperty('reviewEvidence');

    startTurn(tools, await begin('reviewer', { admitted: false }));
    await expect(tools.runText('close_assignment', {})).resolves.toBe(refusal);
  });

  it('tells the reviewer in its task card how evidence is submitted and which reads cannot be cited', async () => {
    const { begin } = await fixture();

    const reviewCard = formatTaskAttemptCard(await begin('reviewer'));
    expect(reviewCard).toContain('Review evidence is optional.');
    expect(reviewCard).toContain('Only those two UnodeAi tools issue receipts: a read or search made with any other tool cannot be cited.');
    expect(reviewCard).toContain('An observed or source-traced finding needs at least one citation; a finding you cannot cite is inferred.');
    expect(reviewCard).toContain('The host checks that each cited receipt belongs to this attempt and that the cited lines were displayed to you. '
      + 'It does not confirm a finding, and it records your overall coverage as your own statement.');
    expect(reviewCard).toContain('is recorded as evidence not submitted.');
    expect(formatTaskAttemptCard(await begin('reviewer', { review: false }))).not.toContain('Review evidence');
  });
});

describe('closing a delegated review', () => {
  it('checks citations against the reads and searches of this attempt and records counts', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);

    expect((await tools.run('read_file', { path: 'src/a.ts', line_numbers: true })).readReceipt?.id).toBe('R1');
    expect((await tools.run('read_file', { path: 'src/b.ts', line_numbers: true })).readReceipt?.id).toBe('R2');
    expect((await tools.run('read_file', { path: 'src/c.ts', line_numbers: true })).readReceipt?.id).toBe('R3');
    expect((await tools.run('search_files', { query: 'unused' })).searchReceipt).toMatchObject({ id: 'S1', coverage: 'complete', scope: ['.'] });

    const closed = await tools.run('close_assignment', {
      review_evidence: evidence({
        coverage: 'complete',
        findings: [
          { classification: 'observed', statement: 'a.ts exports an unused constant.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 4, endLine: 4 }] },
          // The planted transitive dependency: a reaches c only through b, and every hop was displayed.
          { classification: 'source-traced', statement: 'a depends on c through b.', citations: [
            { readReceiptId: 'R1', path: 'src/a.ts', startLine: 1, endLine: 2 },
            { readReceiptId: 'R2', path: 'src/b.ts', startLine: 1, endLine: 2 },
            { readReceiptId: 'R3', path: 'src/c.ts', startLine: 1, endLine: 1 },
          ] },
          { classification: 'inferred', statement: 'Nothing else imports unused.', citations: [] },
        ],
        searches: [{ searchReceiptId: 'S1', coverage: 'complete' }],
      }),
    });

    expect(closed.status).toBe('success');
    expect(closed.output).toBe(
      'Review closed. Recorded: review evidence: citations checked by the host. 3 findings: 1 observed (1 cited), 1 source-traced (1 cited), '
      + '1 inferred (0 cited); 4 citations in 3 files; 1 search cited (0 partial). '
      + 'The reviewer reported overall coverage complete; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );
    const recorded = {
      schemaVersion: 1,
      state: 'citations-checked',
      receipt: {
        schemaVersion: 1,
        findings: { observed: { total: 1, cited: 1 }, 'source-traced': { total: 1, cited: 1 }, inferred: { total: 1, cited: 0 } },
        citations: 4,
        citedFiles: 3,
        searches: { complete: 1, partial: 0 },
        citedSearchCoverage: 'complete',
        reportedCoverage: 'complete',
      },
    };
    // The same fact in the two places a result takes it from: the turn's evidence and the host's attempt registry.
    expect(tools.taskAttemptEvidence().reviewEvidence).toEqual(recorded);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual(recorded);
  });

  it('refuses a citation to a receipt of another attempt', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');

    const first = await begin('reviewer');
    startTurn(tools, first);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    resolver.endAttempt(first.attemptId, 'settled');

    // A new attempt for the same agent, on the same tool surface. It has displayed nothing yet.
    const second = await begin('reviewer');
    startTurn(tools, second);
    const stale = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(stale.status).toBe('failed');
    expect(stale.output).toContain('finding 1, citation 1: read receipt R1 was not issued in this attempt.');
    expect(stale.output).toContain('Read receipts of this attempt: none. Search receipts of this attempt: none.');

    // The new attempt's own R1 is another file. The earlier attempt's R1 does not come back under the same id.
    await tools.run('read_file', { path: 'src/b.ts', line_numbers: true });
    const reused = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(reused.status).toBe('failed');
    expect(reused.output).toContain('path "src/a.ts" is not the file read receipt R1 displayed ("src/b.ts").');
    expect(resolver.reviewEvidenceForAttempt(second.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });
  });

  it('does not let a view shown before the attempt began, or in an earlier turn of it, be cited', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');

    // Shown in a turn that had no attempt, then the attempt begins on the same surface in the same turn.
    startTurn(tools);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    tools.setTaskAttempt(card);
    expect((await tools.run('close_assignment', { review_evidence: evidence() })).output)
      .toContain('read receipt R1 was not issued in this attempt.');

    // Shown inside the attempt, then a new turn begins for the same attempt.
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    startTurn(tools, card);
    expect((await tools.run('close_assignment', { review_evidence: evidence() })).output)
      .toContain('read receipt R1 was not issued in this attempt.');
  });

  it('refuses a citation outside the lines that read displayed, and accepts one inside them', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    startTurn(tools, await begin('reviewer'));
    await tools.run('read_file', { path: 'src/a.ts', offset: 0, limit: 2, line_numbers: true });

    const outside = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(outside.status).toBe('failed');
    expect(outside.output).toContain('finding 1, citation 1: lines 4-4 are outside the lines read receipt R1 displayed (1-2).');

    const inside = await tools.run('close_assignment', {
      review_evidence: evidence({ findings: [{ classification: 'observed', statement: 'a imports b.', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 1, endLine: 2 }] }] }),
    });
    expect(inside.status).toBe('success');
  });

  it('refuses a citation to a file that was only read without line numbers', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    startTurn(tools, await begin('reviewer'));

    const plain = await tools.run('read_file', { path: 'src/a.ts' });
    expect(plain.readReceipt).toBeUndefined();

    expect((await tools.run('close_assignment', { review_evidence: evidence() })).output)
      .toContain('read receipt R1 was not issued in this attempt.');
  });

  it('refuses a source-traced finding without a citation', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    startTurn(tools, await begin('reviewer'));

    const closed = await tools.run('close_assignment', {
      review_evidence: evidence({ findings: [{ classification: 'source-traced', statement: 'a depends on c through b.', citations: [] }] }),
    });

    expect(closed.status).toBe('failed');
    expect(closed.output).toContain('finding 1 is source-traced and has no citation.');
  });

  it('refuses an observed finding without a citation, and accepts the same finding resubmitted as inferred', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    // The reviewer did read the file, with a receipt. An observed finding still has to point at lines of it.
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    const uncited = { statement: 'a.ts exports an unused constant.', citations: [] };

    const observed = await tools.run('close_assignment', { review_evidence: evidence({ findings: [{ classification: 'observed', ...uncited }] }) });
    expect(observed.status).toBe('failed');
    expect(observed.output).toMatch(/^Error: review_evidence was refused\. finding 1 is observed and has no citation\. An observed or source-traced finding needs at least one citation to lines a read receipt of this attempt displayed\. Add a citation, or resubmit this finding as inferred\. Nothing was recorded\./);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    const inferred = await tools.run('close_assignment', { review_evidence: evidence({ findings: [{ classification: 'inferred', ...uncited }] }) });
    expect(inferred.status).toBe('success');
    // Nothing was cited, so the result does not say that anything was checked.
    expect(inferred.output).toMatch(/^Review closed\. Recorded: review evidence: submitted with nothing for the host to check\. 1 finding: 0 observed \(0 cited\), 0 source-traced \(0 cited\), 1 inferred \(0 cited\);/);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({
      state: 'citations-checked', receipt: { citations: 0, findings: { observed: { total: 0, cited: 0 }, inferred: { total: 1, cited: 0 } } },
    });
  });

  it('refuses complete coverage over a partial search and accepts the same evidence as partial', async () => {
    const { begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    startTurn(tools, await begin('reviewer'));
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    const capped = await tools.run('search_files', { query: 'export', max_results: 1 });
    expect(capped.searchReceipt).toMatchObject({ id: 'S1', stopReason: 'result-cap', coverage: 'partial' });

    const overstated = await tools.run('close_assignment', {
      review_evidence: evidence({ coverage: 'complete', searches: [{ searchReceiptId: 'S1', coverage: 'partial' }] }),
    });
    expect(overstated.status).toBe('failed');
    expect(overstated.output).toContain('coverage "complete" is refused: search receipt S1, over scope ".", was partial (the search reached its result limit). Report coverage "partial".');
    // The refusal names what this attempt can cite, and both ways on.
    expect(overstated.output).toContain('Read receipts of this attempt: R1 (src/a.ts lines 1-4). Search receipts of this attempt: S1 (partial, scope ".").');
    expect(overstated.output).toContain('Correct the submission, or call close_assignment without review_evidence to close with evidence not submitted.');

    const honest = await tools.run('close_assignment', {
      review_evidence: evidence({ coverage: 'partial', searches: [{ searchReceiptId: 'S1', coverage: 'partial' }] }),
    });
    expect(honest.status).toBe('success');
    expect(tools.taskAttemptEvidence().reviewEvidence).toMatchObject({
      state: 'citations-checked', receipt: { reportedCoverage: 'partial', citedSearchCoverage: 'partial', searches: { complete: 0, partial: 1 } },
    });
  });

  it('records complete coverage with no search cited as what the reviewer reported, and tells the reviewer so', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });

    // No search at all, and the strongest coverage a reviewer can write.
    const closed = await tools.run('close_assignment', { review_evidence: evidence({ coverage: 'complete' }) });

    expect(closed.status).toBe('success');
    expect(closed.output).toContain('1 citation in 1 file; no search was cited. The reviewer reported overall coverage complete; the host did not check that.');
    expect(closed.output).not.toMatch(/(?<!reported )overall coverage complete/);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({
      state: 'citations-checked', receipt: { reportedCoverage: 'complete', citedSearchCoverage: 'none', searches: { complete: 0, partial: 0 } },
    });
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).not.toHaveProperty('receipt.coverage');
  });

  it('accepts a close without evidence and records it as not submitted, never as checked', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });

    // A review that has not been closed at all already says so.
    expect(tools.taskAttemptEvidence().reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    const closed = await tools.run('close_assignment', {});
    expect(closed.status).toBe('success');
    expect(closed.output).toBe(
      'Review closed. Recorded: review evidence: not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.',
    );
    expect(tools.taskAttemptEvidence().reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    expect((await tools.run('close_assignment', { review_evidence: null })).output).toContain('review evidence: not submitted');
  });

  it('records nothing for evidence that does not hold, and never lowers evidence it checked', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    const invalid = evidence({ findings: [{ classification: 'observed', statement: 'x', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 9, endLine: 9 }] }] });

    const refused = await tools.run('close_assignment', { review_evidence: invalid });
    expect(refused.status).toBe('failed');
    expect(refused.output).toMatch(/^Error: review_evidence was refused\. .* Nothing was recorded\./);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    expect((await tools.run('close_assignment', { review_evidence: evidence() })).status).toBe('success');
    const checked = resolver.reviewEvidenceForAttempt(card.attemptId);
    expect(checked).toMatchObject({ state: 'citations-checked', receipt: { citations: 1 } });

    // A later invalid submission and a later close without evidence both leave the checked record as it is.
    expect((await tools.run('close_assignment', { review_evidence: invalid })).status).toBe('failed');
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual(checked);
    const again = await tools.run('close_assignment', {});
    expect(again.output).toMatch(/^This review already has a recorded evidence submission, and closing it again without review_evidence changed nothing\. Recorded: review evidence: citations checked by the host\./);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual(checked);
  });

  it('keeps file text, statements, paths and digests out of the recorded receipt and the tool result', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    const read = await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    expect(read.output).toContain('SENTINEL-FILE-CONTENT');
    // A cited search, too: its receipt holds the scope and a digest in memory, and the record takes neither.
    const search = await tools.run('search_files', { query: 'SENTINEL-FILE-CONTENT', path: 'src' });
    expect(search.searchReceipt).toMatchObject({ id: 'S1', scope: ['src'], coverage: 'complete' });

    const closed = await tools.run('close_assignment', {
      review_evidence: evidence({
        findings: [{ classification: 'observed', statement: 'SENTINEL-STATEMENT quoting SENTINEL-FILE-CONTENT', citations: [{ readReceiptId: 'R1', path: 'src/a.ts', startLine: 3, endLine: 3 }] }],
        searches: [{ searchReceiptId: 'S1', coverage: 'complete' }],
      }),
    });
    const kept = JSON.stringify([closed.output, tools.taskAttemptEvidence(), resolver.reviewEvidenceForAttempt(card.attemptId)]);

    expect(closed.status).toBe('success');
    for (const absent of [
      'SENTINEL-FILE-CONTENT', 'SENTINEL-STATEMENT', 'src/a.ts', 'a.ts', read.readReceipt!.contentDigest, 'R1',
      search.searchReceipt!.searchDigest, 'S1', 'src', 'scope',
    ]) {
      expect(kept).not.toContain(absent);
    }
  });

  it('cannot close an attempt that is over, and keeps what that attempt recorded', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    await tools.run('close_assignment', { review_evidence: evidence() });

    resolver.endAttempt(card.attemptId, 'settled');

    await expect(tools.run('close_assignment', { review_evidence: evidence() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
    expect(resolver.closeReviewAssignment(card.attemptId, 'reviewer', evidence())).toEqual({ status: 'no-admitted-review' });
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({ state: 'citations-checked' });
  });

  it('accepts evidence only from the agent that holds the attempt', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const reviewer = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(reviewer, card);
    await reviewer.run('read_file', { path: 'src/a.ts', line_numbers: true });

    // Another agent's tools cannot adopt the attempt, bind receipts to it, or close it.
    const other = toolsFor('other');
    startTurn(other, card);
    await other.run('read_file', { path: 'src/a.ts', line_numbers: true });
    await expect(other.run('close_assignment', { review_evidence: evidence() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
    expect(resolver.closeReviewAssignment(card.attemptId, 'other', evidence())).toEqual({ status: 'no-admitted-review' });

    expect((await reviewer.run('close_assignment', { review_evidence: evidence() })).status).toBe('success');
  });

  it('does not let another agent put receipts of its own under the attempt', async () => {
    const { resolver, begin, toolsFor, startTurn } = await fixture();
    const reviewer = toolsFor('reviewer');
    const card = await begin('reviewer');
    startTurn(reviewer, card);

    // A registry the reviewer never read from, offered for the reviewer's attempt in another agent's name.
    const planted = new ReviewReceiptRegistry();
    planted.issueRead({ path: 'src/a.ts', pathAliases: [], startLine: 1, endLine: 4, contentDigest: 'f'.repeat(64), coverage: 'complete' });
    resolver.bindReviewReceipts(card.attemptId, 'other', planted);

    const closed = resolver.closeReviewAssignment(card.attemptId, 'reviewer', evidence());
    expect(closed.status).toBe('refused');
    expect(closed).toMatchObject({ reason: expect.stringContaining('read receipt R1 was not issued in this attempt.') });
  });
});

describe('closing a review of a workspace file', () => {
  it('admits a marked review of a required current workspace file and closes it on a valid R1 citation', async () => {
    const { resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer');
    startTurn(tools, card);

    expect(resolver.admittedReview(card.attemptId, 'reviewer')).toEqual({ inputId: 'target' });
    expect(advertised(tools)).toContain('close_assignment');
    expect((await tools.run('read_file', { path: 'src/a.ts', line_numbers: true })).readReceipt?.id).toBe('R1');

    const closed = await tools.run('close_assignment', { review_evidence: evidence() });

    expect(closed.status).toBe('success');
    expect(closed.output).toBe(
      'Review closed. Recorded: review evidence: citations checked by the host. 1 finding: 1 observed (1 cited), 0 source-traced (0 cited), '
      + '0 inferred (0 cited); 1 citation in 1 file; no search was cited. '
      + 'The reviewer reported overall coverage partial; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({
      state: 'citations-checked', receipt: { citations: 1, citedFiles: 1, reportedCoverage: 'partial' },
    });
    expect(tools.taskAttemptEvidence().reviewEvidence).toEqual(resolver.reviewEvidenceForAttempt(card.attemptId));
  });

  it('refuses to close after the file was edited outside the file tools, though the receipt of the earlier read is still held', async () => {
    const { root, resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });

    // An editor, a formatter or another process: nothing the reviewer's tool surface saw.
    await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');

    const refused = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(refused.status).toBe('failed');
    expect(refused.output).toBe(targetChanged(CONTENT_CHANGED));
    // Without evidence the answer is the same: the host says "closed" for no review whose target changed.
    const bare = await tools.run('close_assignment', {});
    expect(bare).toMatchObject({ status: 'failed', output: targetChanged(CONTENT_CHANGED) });
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    // The receipt was never withdrawn. With the dispatched bytes back on disk, the same citation closes the review.
    await writeFile(join(root, 'src', 'a.ts'), FILE_A, 'utf8');
    expect((await tools.run('close_assignment', { review_evidence: evidence() })).status).toBe('success');
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({ state: 'citations-checked', receipt: { citations: 1 } });
  });

  it('keeps evidence it checked when the file changes afterwards, and closes nothing more', async () => {
    const { root, resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    expect((await tools.run('close_assignment', { review_evidence: evidence() })).status).toBe('success');
    const checked = resolver.reviewEvidenceForAttempt(card.attemptId);

    await rm(join(root, 'src', 'a.ts'));

    // A deleted target is a changed target too, and a folder in its place is no file to compare.
    expect((await tools.run('close_assignment', { review_evidence: evidence() })).output).toBe(targetChanged(FILE_GONE));
    expect((await tools.run('close_assignment', {})).output).toBe(targetChanged(FILE_GONE));
    await mkdir(join(root, 'src', 'a.ts'));
    expect((await tools.run('close_assignment', {})).output).toBe(targetChanged(FILE_GONE));
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual(checked);
  });

  it('refuses a citation to a view that displayed other content of the target, even with the dispatched content back on disk', async () => {
    const { root, resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer');
    startTurn(tools, card);

    // The file was other bytes while the reviewer read it, and is the dispatched bytes again before the close.
    await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');
    const during = await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    expect(during.readReceipt?.id).toBe('R1');
    await writeFile(join(root, 'src', 'a.ts'), FILE_A, 'utf8');

    const stale = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(stale.status).toBe('failed');
    expect(stale.output).toBe(targetChanged(
      'finding 1, citation 1: read receipt R1 displayed the file under review with content other than it had when this review was dispatched.',
    ));
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    // A view of another file is not held to the target's digest, and a view of the dispatched bytes is accepted.
    expect((await tools.run('read_file', { path: 'src/b.ts', line_numbers: true })).readReceipt?.id).toBe('R2');
    const fresh = await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    expect(fresh.readReceipt).toMatchObject({ id: 'R3' });
    expect(fresh.readReceipt!.contentDigest).not.toBe(during.readReceipt!.contentDigest);
    const closed = await tools.run('close_assignment', {
      review_evidence: evidence({
        findings: [{ classification: 'source-traced', statement: 'a reaches b.', citations: [
          { readReceiptId: 'R3', path: 'src/a.ts', startLine: 1, endLine: 2 },
          { readReceiptId: 'R2', path: 'src/b.ts', startLine: 1, endLine: 2 },
        ] }],
      }),
    });
    expect(closed.status).toBe('success');
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toMatchObject({ state: 'citations-checked', receipt: { citations: 2, citedFiles: 2 } });
  });

  it('binds the one input the review names, and no other workspace file the contract declares', async () => {
    const { root, resolver, rawFileReviewContract, admit, toolsFor, startTurn } = await fixture();
    // src/b.ts is declared first, as context the reviewer needs. Only `target` is what the review is a review of.
    const contract = compileTaskContract(rawFileReviewContract({
      inputs: [
        {
          input_id: 'context', kind: 'workspacePath', path: 'src/b.ts', purpose: 'What a.ts calls',
          required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
        },
        {
          input_id: 'target', kind: 'workspacePath', path: 'src/a.ts', purpose: 'Review target',
          required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
        },
      ],
    }), 'pm').contract!;
    const card = (await resolver.beginAttempt(contract, candidate('reviewer'), 'pm')).card!;
    admit(card);
    expect(formatTaskAttemptCard(card)).toContain('Marked workspace file review input: target');
    const tools = toolsFor('reviewer');
    startTurn(tools, card);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    const context = await tools.run('read_file', { path: 'src/b.ts', line_numbers: true });
    const citingBoth = evidence({
      findings: [{ classification: 'source-traced', statement: 'a reaches b.', citations: [
        { readReceiptId: 'R1', path: 'src/a.ts', startLine: 1, endLine: 2 },
        { readReceiptId: 'R2', path: 'src/b.ts', startLine: 1, endLine: 2 },
      ] }],
    });

    // The context file changes after it was read. It is not the review's target, so its earlier view still counts.
    await writeFile(join(root, 'src', 'b.ts'), `${FILE_B}// edited after dispatch\n`, 'utf8');
    expect(context.readReceipt?.id).toBe('R2');
    expect((await tools.run('close_assignment', { review_evidence: citingBoth })).status).toBe('success');

    await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');
    expect((await tools.run('close_assignment', { review_evidence: citingBoth })).output).toBe(targetChanged(CONTENT_CHANGED));
  });

  it('still refuses a receipt this attempt does not hold or that names another file, as evidence to correct', async () => {
    const { resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer');

    // A view shown before the attempt began is not a receipt of it.
    startTurn(tools);
    await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });
    tools.setTaskAttempt(card);
    const unheld = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(unheld.status).toBe('failed');
    expect(unheld.output).toMatch(/^Error: review_evidence was refused\. finding 1, citation 1: read receipt R1 was not issued in this attempt\. Nothing was recorded\./);
    expect(unheld.output).toContain('Correct the submission, or call close_assignment without review_evidence to close with evidence not submitted.');

    // This attempt's R1 is a view of another file; citing it as the target is a wrong receipt, not a changed target.
    await tools.run('read_file', { path: 'src/b.ts', line_numbers: true });
    const wrong = await tools.run('close_assignment', { review_evidence: evidence() });
    expect(wrong.output).toContain('path "src/a.ts" is not the file read receipt R1 displayed ("src/b.ts").');
    expect(wrong.output).not.toContain('review target changed');
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    // The target itself is unchanged, so the review still closes without evidence.
    expect((await tools.run('close_assignment', {})).output).toContain('Review closed. Recorded: review evidence: not submitted.');
  });

  it('refuses to close when the path of the target leads to another file, and knows a view of the target by its path or by its file', async () => {
    const { root, resolver, beginFileReview, toolsFor, startTurn } = await fixture();
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    await writeFile(join(root, 'first', 'a.ts'), FILE_A, 'utf8');
    await writeFile(join(root, 'second', 'a.ts'), FILE_A, 'utf8');
    const link = join(root, 'current');
    const point = async (folder: string) => {
      await rm(link, { force: true });
      await symlink(join(root, folder), link, process.platform === 'win32' ? 'junction' : 'dir');
    };
    try {
      await point('first');
    } catch (error: any) {
      // A host that may not create links has no path that can be led elsewhere.
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return;
      throw error;
    }
    const tools = toolsFor('reviewer');
    const card = await beginFileReview('reviewer', 'current/a.ts');
    startTurn(tools, card);
    const cite = (readReceiptId: string, path: string) => evidence({
      findings: [{ classification: 'observed', statement: 'An unused constant is exported.', citations: [{ readReceiptId, path, startLine: 4, endLine: 4 }] }],
    });
    const otherContent = (readReceiptId: string) => targetChanged(
      `finding 1, citation 1: read receipt ${readReceiptId} displayed the file under review with content other than it had when this review was dispatched.`,
    );
    expect((await tools.run('read_file', { path: 'current/a.ts', line_numbers: true })).readReceipt?.id).toBe('R1');

    // The path now leads to another file holding the very same bytes: its digest alone could not tell.
    await point('second');
    const elsewhere = await tools.run('close_assignment', { review_evidence: cite('R1', 'current/a.ts') });
    expect(elsewhere).toMatchObject({ status: 'failed', output: targetChanged(PATH_CHANGED) });

    // While the path led elsewhere a view through it displayed other bytes. The path is back before the close.
    await writeFile(join(root, 'second', 'a.ts'), FILE_A_EDITED, 'utf8');
    expect((await tools.run('read_file', { path: 'current/a.ts', line_numbers: true })).readReceipt?.id).toBe('R2');
    await point('first');
    expect((await tools.run('close_assignment', { review_evidence: cite('R2', 'current/a.ts') })).output).toBe(otherContent('R2'));

    // The bound file itself, read under its other name while it held other bytes.
    await writeFile(join(root, 'first', 'a.ts'), FILE_A_EDITED, 'utf8');
    expect((await tools.run('read_file', { path: 'first/a.ts', line_numbers: true })).readReceipt?.id).toBe('R3');
    await writeFile(join(root, 'first', 'a.ts'), FILE_A, 'utf8');
    expect((await tools.run('close_assignment', { review_evidence: cite('R3', 'first/a.ts') })).output).toBe(otherContent('R3'));
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });

    // The first view was of the dispatched bytes through the declared path, and still closes the review.
    expect((await tools.run('close_assignment', { review_evidence: cite('R1', 'current/a.ts') })).status).toBe('success');
  });
});

describe('the coordinator and review evidence', () => {
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running', capabilities: { read: true, write: false, shell: false, toolFamilies: ['read', 'delegate'], taskScope: 'per-turn' } },
    { id: 'reviewer', role: 'reviewer', name: 'Reviewer', status: 'idle', capabilities: { read: true, write: false, shell: false, toolFamilies: ['read'], taskScope: 'per-turn' } },
  ];
  const view: TeamView = { list: () => roster, resolve: (ref) => ({ id: ref }), preflightTaskScope: () => undefined };
  const closeSpec = (team: TeamTools) => team.specs().find((spec) => spec.function.name === 'close_assignment')!
    .function.parameters as { properties: Record<string, unknown>; required: string[] };

  it('refuses review_evidence on an assignment that is not an admitted review, and closes nothing', async () => {
    const { resolver } = await fixture();
    const events: AssignmentCloseoutEvent[] = [];
    const team = new TeamTools('pm', view, new MessageBus(), { taskInputResolver: resolver, onAssignmentCloseout: (event) => { events.push(event); } });

    // The ordinary close keeps the schema it had.
    expect(Object.keys(closeSpec(team).properties)).toEqual(['outcome', 'summary', 'incomplete']);

    const refused = await team.runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered.', review_evidence: evidence() });
    expect(refused).toMatchObject({ status: 'failed', output: REVIEW_EVIDENCE_WITHOUT_REVIEW });
    expect(REVIEW_EVIDENCE_WITHOUT_REVIEW.split('\n')).toHaveLength(1);
    expect(events).toEqual([]);
    expect(team.coordinatorCloseoutState().assignmentClosed).toBe(false);

    // Without the argument the same close is exactly what it was.
    await expect(team.run('close_assignment', { outcome: 'complete', summary: 'Delivered.' }))
      .resolves.toBe('Recorded: assignment closed as complete.');
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('reviewEvidence');
  });

  it('lets a coordinator close a review it is executing itself, against the receipts of its own file tools', async () => {
    const { resolver, rawReviewContract, admit, toolsFor } = await fixture();
    const events: AssignmentCloseoutEvent[] = [];
    const team = new TeamTools('pm', view, new MessageBus(), {
      taskInputResolver: resolver,
      admitCoordinatorAttempt: admit,
      onAssignmentCloseout: (event) => { events.push(event); },
    });
    const files = toolsFor('pm');
    files.beginTurn();

    // A numbered read before the attempt exists belongs to no attempt.
    await files.run('read_file', { path: 'src/b.ts', line_numbers: true });
    await expect(team.run('dispatch_task', {
      agent: 'pm', instruction: 'Review the artifact yourself.', contract: rawReviewContract({ execution_strategy: 'coordinator-only' }),
    })).resolves.toMatch(/Coordinator execution is authorised/);
    // What the in-process backend does after every team tool call.
    files.setTaskAttempt(team.currentCoordinatorTaskAttempt());

    // While the review runs, the one close tool carries the argument, and the file tools add no second close tool.
    expect(Object.keys(closeSpec(team).properties)).toEqual(['outcome', 'summary', 'incomplete', 'review_evidence']);
    expect(advertised(files)).not.toContain('close_assignment');

    const early = await team.runOutcome('close_assignment', { outcome: 'complete', summary: 'Reviewed.', review_evidence: evidence() });
    expect(early.status).toBe('failed');
    expect(early.output).toContain('read receipt R1 was not issued in this attempt.');
    expect(events).toEqual([]);
    expect(team.coordinatorCloseoutState().assignmentClosed).toBe(false);

    await files.run('read_file', { path: 'src/a.ts', line_numbers: true });
    const closed = await team.run('close_assignment', { outcome: 'complete', summary: 'Reviewed.', review_evidence: evidence() });
    expect(closed).toMatch(/^Recorded: assignment closed as complete\. For the review you ran yourself, recorded: review evidence: citations checked by the host\. 1 finding: /);
    expect(events).toHaveLength(1);
    expect(events[0].reviewEvidence).toMatchObject({ state: 'citations-checked', receipt: { citations: 1, citedFiles: 1 } });
    expect(files.taskAttemptEvidence().reviewEvidence).toEqual(events[0].reviewEvidence);

    // Once its own attempt is over, the close is the ordinary one again.
    team.finishCoordinatorAttempt('settled');
    expect(Object.keys(closeSpec(team).properties)).toEqual(['outcome', 'summary', 'incomplete']);
    await expect(team.run('close_assignment', { outcome: 'complete', summary: 'Again.', review_evidence: evidence() }))
      .resolves.toBe(REVIEW_EVIDENCE_WITHOUT_REVIEW);
  });

  it('records a coordinator review closed without evidence as not submitted', async () => {
    const { resolver, rawReviewContract, admit } = await fixture();
    const events: AssignmentCloseoutEvent[] = [];
    const team = new TeamTools('pm', view, new MessageBus(), {
      taskInputResolver: resolver,
      admitCoordinatorAttempt: admit,
      onAssignmentCloseout: (event) => { events.push(event); },
    });
    await team.run('dispatch_task', { agent: 'pm', instruction: 'Review it.', contract: rawReviewContract({ execution_strategy: 'coordinator-only' }) });

    const closed = await team.run('close_assignment', { outcome: 'complete', summary: 'Reviewed.' });

    expect(closed).toBe(
      'Recorded: assignment closed as complete. For the review you ran yourself, recorded: review evidence: not submitted. '
      + 'The host recorded no checked citation and no cited search for this review; the findings are prose only.',
    );
    expect(events[0].reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
  });

  /**
   * A reviewer is dispatched, works on its own tool surface, and replies. `closeWith` is what it passes to
   * close_assignment (`false` = it never calls the tool); `forged` is added to the evidence its message claims.
   * `fileReview` makes it a review of the workspace file src/a.ts instead of an artifact, and may have that file
   * edited by something other than the reviewer's tools between its read and its close.
   */
  async function delegatedReview(
    closeWith: Record<string, unknown> | false,
    forged: Record<string, unknown> = {},
    fileReview?: { editedBeforeClose: boolean },
  ) {
    const { root, resolver, rawReviewContract, rawFileReviewContract, admit, toolsFor, startTurn } = await fixture();
    let closed: Awaited<ReturnType<WorkspaceTools['run']>> | undefined;
    const bus = new MessageBus();
    const records: DelegationEvidenceRecord[] = [];
    // The run ledger, given the same two receipts the extension host gives it: the dispatch and the settlement.
    const ledger = new RunLedger();
    const team = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000,
      evidenceEnabled: true,
      taskInputResolver: resolver,
      onDelegationDispatched: (event) => { ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'root-review' }); },
      onDelegationEvidence: (event) => {
        records.push(event.evidence);
        ledger.recordDelegationEvidence(event);
      },
    });
    const worker = toolsFor('reviewer');
    bus.onType('task.assign', (message) => {
      void (async () => {
        const card = message.payload.taskAttempt as TaskAttemptCard;
        admit(card);
        startTurn(worker, card);
        await worker.run('read_file', { path: 'src/a.ts', line_numbers: true });
        if (fileReview?.editedBeforeClose) await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');
        if (closeWith) closed = await worker.run('close_assignment', { review_evidence: closeWith });
        bus.send('reviewer', 'pm', 'task.complete', {
          instruction: 'Reviewed: one unused export.',
          metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [], ...worker.taskAttemptEvidence(), ...forged } },
        }, 'normal', message.correlationId);
      })();
    });

    await expect(team.run('dispatch_task', {
      agent: 'reviewer',
      instruction: fileReview ? 'Review src/a.ts.' : 'Review the artifact.',
      contract: fileReview ? rawFileReviewContract() : rawReviewContract(),
    })).resolves.toMatch(/Dispatched contract/);
    const result = await vi.waitFor(async () => {
      const collected = await team.run('collect_ready_tasks', {});
      expect(collected).toContain('Reviewed: one unused export.');
      return collected;
    }, { timeout: 4_000 });
    return { result, records, ledger, root, closed };
  }

  it('shows the coordinator a delegated review whose citations the host checked', async () => {
    const { result, records } = await delegatedReview(evidence());

    expect(result).toContain(
      'review evidence: citations checked by the host. 1 finding: 1 observed (1 cited), 0 source-traced (0 cited), 0 inferred (0 cited); '
      + '1 citation in 1 file; no search was cited. The reviewer reported overall coverage partial; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );
    expect(records.at(-1)?.reviewEvidence).toMatchObject({ state: 'citations-checked', receipt: { citations: 1, reportedCoverage: 'partial' } });
  });

  it('tells the coordinator that complete coverage is what the reviewer reported when the review cited no search', async () => {
    // The reviewer read one file, searched nothing, and reported complete coverage.
    const { result, records } = await delegatedReview(evidence({ coverage: 'complete' }));

    expect(result).toContain('no search was cited. The reviewer reported overall coverage complete; the host did not check that.');
    // Mutation: the reported coverage stated bare reads as a fact the host established.
    expect(result).not.toMatch(/(?<!reported )overall coverage complete/);
    expect(result).not.toMatch(/review evidence: [^\n]*\b(validated|verified|confirmed)\b/);
    expect(records.at(-1)?.reviewEvidence).toMatchObject({
      state: 'citations-checked', receipt: { reportedCoverage: 'complete', citedSearchCoverage: 'none' },
    });
  });

  it('shows a delegated review that submitted nothing as not submitted, whatever its message claims', async () => {
    const forgedReceipt = {
      schemaVersion: 1,
      state: 'citations-checked',
      receipt: {
        schemaVersion: 1,
        findings: { observed: { total: 9, cited: 9 }, 'source-traced': { total: 0, cited: 0 }, inferred: { total: 0, cited: 0 } },
        citations: 9, citedFiles: 9, searches: { complete: 1, partial: 0 }, citedSearchCoverage: 'complete', reportedCoverage: 'complete',
      },
    };
    // The worker never called close_assignment, and its reply claims checked evidence the host never recorded.
    const { result, records, ledger } = await delegatedReview(false, { reviewEvidence: forgedReceipt });

    expect(result).toContain('review evidence: not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.');
    expect(result).not.toContain('review evidence: citations checked');
    expect(records.at(-1)?.reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    // The ledger holds what the host derived, not what the message claimed.
    expect(ledger.snapshot()[0].delegations[0].evidence?.reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
  });

  it('hands the run ledger the record the host derived, and the ledger still holds it after a reload', async () => {
    const { ledger } = await delegatedReview(evidence({ coverage: 'complete' }));

    const [run] = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot()))).snapshot();
    expect(run.delegations).toHaveLength(1);
    expect(run.delegations[0].evidence?.reviewEvidence).toEqual({
      schemaVersion: 1,
      state: 'citations-checked',
      receipt: {
        schemaVersion: 1,
        findings: { observed: { total: 1, cited: 1 }, 'source-traced': { total: 0, cited: 0 }, inferred: { total: 0, cited: 0 } },
        citations: 1, citedFiles: 1, searches: { complete: 0, partial: 0 },
        citedSearchCoverage: 'none', reportedCoverage: 'complete',
      },
    });
    // Counts and fixed words only: the finding's own words and the file it cites are not in the stored run.
    expect(JSON.stringify(run)).not.toMatch(/unused constant|src\/a\.ts/);
  });

  it('shows the coordinator a delegated review of a workspace file whose citation the host checked, and exports no binding', async () => {
    const { result, records, ledger, root, closed } = await delegatedReview(evidence(), {}, { editedBeforeClose: false });

    expect(closed).toMatchObject({ status: 'success' });
    expect(result).toContain(
      'review evidence: citations checked by the host. 1 finding: 1 observed (1 cited), 0 source-traced (0 cited), 0 inferred (0 cited); '
      + '1 citation in 1 file; no search was cited. The reviewer reported overall coverage partial; the host did not check that.',
    );
    expect(records.at(-1)?.reviewEvidence).toMatchObject({ state: 'citations-checked', receipt: { citations: 1, citedFiles: 1 } });

    // What the host bound at dispatch stays with the live attempt: the digest and the place of the file on this
    // machine are in no result, no evidence record, no stored run and no exported evidence.
    const [run] = ledger.snapshot();
    const carried = JSON.stringify([result, closed, records, run, renderPortableRunEvidence(run)]);
    for (const absent of [createHash('sha256').update(FILE_A, 'utf8').digest('hex'), basename(root), 'physicalPath', 'lexicalPath']) {
      expect(carried).not.toContain(absent);
    }
    // The contract the run keeps names the review input and the workspace-relative path the coordinator declared.
    expect(run.delegations[0].contract?.review).toEqual({ inputId: 'target' });
    expect(run.delegations[0].contract?.inputs).toMatchObject([{ inputId: 'target', kind: 'workspacePath', path: 'src/a.ts', freshness: 'current' }]);
    // And a reload compiles that contract again, so a stored review of a workspace file is still one.
    const [reloaded] = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot()))).snapshot();
    expect(reloaded.delegations[0].contract?.review).toEqual({ inputId: 'target' });
  });

  it('gives the coordinator no closed review to claim when the reviewed file changed after dispatch, whatever the reviewer replies', async () => {
    const forgedReceipt = {
      schemaVersion: 1,
      state: 'citations-checked',
      receipt: {
        schemaVersion: 1,
        findings: { observed: { total: 1, cited: 1 }, 'source-traced': { total: 0, cited: 0 }, inferred: { total: 0, cited: 0 } },
        citations: 1, citedFiles: 1, searches: { complete: 0, partial: 0 }, citedSearchCoverage: 'none', reportedCoverage: 'partial',
      },
    };
    // The reviewer read the dispatched file and holds R1. The file is then edited by something else, the close is
    // refused, and the reply claims the checked evidence all the same.
    const { result, records, ledger, closed } = await delegatedReview(evidence(), { reviewEvidence: forgedReceipt }, { editedBeforeClose: true });

    expect(closed).toMatchObject({ status: 'failed', output: targetChanged(CONTENT_CHANGED) });
    expect(result).toContain('review evidence: not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.');
    expect(result).not.toContain('review evidence: citations checked');
    expect(records.at(-1)?.reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    expect(ledger.snapshot()[0].delegations[0].evidence?.reviewEvidence).toEqual({ schemaVersion: 1, state: 'not-submitted' });
  });

  it('lets a coordinator close its own review of a workspace file against its own numbered read', async () => {
    const { root, resolver, rawFileReviewContract, admit, toolsFor } = await fixture();
    const events: AssignmentCloseoutEvent[] = [];
    const team = new TeamTools('pm', view, new MessageBus(), {
      taskInputResolver: resolver,
      admitCoordinatorAttempt: admit,
      onAssignmentCloseout: (event) => { events.push(event); },
    });
    const files = toolsFor('pm');
    files.beginTurn();
    await expect(team.run('dispatch_task', {
      agent: 'pm', instruction: 'Review src/a.ts yourself.', contract: rawFileReviewContract({ execution_strategy: 'coordinator-only' }),
    })).resolves.toMatch(/Coordinator execution is authorised[\s\S]*Marked workspace file review input: target/);
    files.setTaskAttempt(team.currentCoordinatorTaskAttempt());
    await files.run('read_file', { path: 'src/a.ts', line_numbers: true });

    const closed = await team.run('close_assignment', { outcome: 'complete', summary: 'Reviewed.', review_evidence: evidence() });

    expect(closed).toMatch(/^Recorded: assignment closed as complete\. For the review you ran yourself, recorded: review evidence: citations checked by the host\. 1 finding: /);
    expect(events).toHaveLength(1);
    expect(events[0].reviewEvidence).toMatchObject({ state: 'citations-checked', receipt: { citations: 1, citedFiles: 1 } });

    // The file changes after that close. A later close records nothing new for the review and keeps what was checked.
    await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');
    const later = await team.run('close_assignment', { outcome: 'complete', summary: 'Reviewed.' });
    expect(later).toBe(`Recorded: assignment closed as complete. This call did not close the review you ran yourself: ${targetChangedFinding(CONTENT_CHANGED)}`);
    expect(later).not.toContain('Error:');
    expect(events).toHaveLength(2);
    expect(events[1].reviewEvidence).toEqual(events[0].reviewEvidence);
  });

  it('fails a coordinator close that offers evidence for a changed file, and without evidence closes the assignment but not the review', async () => {
    const { root, resolver, rawFileReviewContract, admit, toolsFor } = await fixture();
    const events: AssignmentCloseoutEvent[] = [];
    const team = new TeamTools('pm', view, new MessageBus(), {
      taskInputResolver: resolver,
      admitCoordinatorAttempt: admit,
      onAssignmentCloseout: (event) => { events.push(event); },
    });
    const files = toolsFor('pm');
    files.beginTurn();
    await team.run('dispatch_task', { agent: 'pm', instruction: 'Review src/a.ts yourself.', contract: rawFileReviewContract({ execution_strategy: 'coordinator-only' }) });
    const card = team.currentCoordinatorTaskAttempt()!;
    files.setTaskAttempt(card);
    await files.run('read_file', { path: 'src/a.ts', line_numbers: true });
    await writeFile(join(root, 'src', 'a.ts'), FILE_A_EDITED, 'utf8');

    // Offered evidence is never dropped: the call fails and says why no submission can be recorded.
    const offered = await team.runOutcome('close_assignment', { outcome: 'complete', summary: 'Reviewed.', review_evidence: evidence() });
    expect(offered).toMatchObject({ status: 'failed', output: targetChanged(CONTENT_CHANGED) });
    expect(events).toEqual([]);
    expect(team.coordinatorCloseoutState().assignmentClosed).toBe(false);

    // The coordinator's own attempt lasts until its turn ends, so a review that can no longer be closed must not
    // keep the assignment open with it. The assignment closes; the reply and the event say the review did not.
    const blocked = await team.runOutcome('close_assignment', {
      outcome: 'blocked', summary: 'The file changed while it was reviewed.',
      incomplete: [{ item: 'Review of src/a.ts', reason: 'The file was edited after the review was dispatched.' }],
    });
    expect(blocked.status).toBe('success');
    expect(blocked.output).toBe(
      'Recorded: assignment closed as blocked with 1 unresolved item(s). This is a reportable outcome; it does not need to be '
      + `retried before you answer the user. This call did not close the review you ran yourself: ${targetChangedFinding(CONTENT_CHANGED)}`,
    );
    expect(blocked.output).not.toContain('For the review you ran yourself, recorded');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'blocked', reviewEvidence: { schemaVersion: 1, state: 'not-submitted' } });
    expect(team.coordinatorCloseoutState().assignmentClosed).toBe(true);
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });
  });
});
