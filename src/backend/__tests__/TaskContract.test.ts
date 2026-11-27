import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, relative } from 'path';
import { CONTENT_ASSET_MAX_BYTES, hostReadMemoryBudget, ContentAssetStore } from '../../content/ContentAssetStore';
import { ReviewReceiptRegistry } from '../ReviewEvidence';
import {
  compileTaskContract,
  formatTaskAttemptCard,
  normalizeWorkspacePath,
  normalizeWorkspacePathsInInstruction,
  contractPathApi,
  preflightInputGrants,
  resolveWorkspacePathIdentity,
  taskReadinessIssues,
  TaskInputResolver,
  type CandidateContractAgent,
  type EffectiveTaskContract,
  type OutsideInputAccess,
} from '../TaskContract';
import { WorkspaceTools } from '../WorkspaceTools';
import { createEffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The parser's one answer for a review relation it does not accept: it says what it does accept. */
const REVIEW_INPUT_REFUSAL = 'contract.review.input_id must name one required upstreamArtifact or current workspacePath input in this contract.';

describe('v0.9.70 structured artifact review provenance', () => {
  it('accepts a required upstreamArtifact review input and stores no duplicate identity or prose', () => {
    const artifactInput = {
      input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: 'artifact-1-fixture', purpose: 'Review target',
      required: true, freshness: 'artifact-ready', provenance: { kind: 'upstream-artifact', source_refs: [] },
    };
    const valid = compile(proposal({ inputs: [artifactInput], dependencies: ['artifact-1-fixture'], review: { input_id: 'artifact' } }));
    expect(valid.review).toEqual({ inputId: 'artifact' });
    expect(valid.review).not.toHaveProperty('artifactId');
    expect(valid.review).not.toHaveProperty('author');

    expect(compileTaskContract(proposal({ inputs: [{ ...artifactInput, required: false }], dependencies: ['artifact-1-fixture'], review: { input_id: 'artifact' } }), 'pm').error)
      .toBe(REVIEW_INPUT_REFUSAL);
    expect(compileTaskContract(proposal({ inputs: [], review: { input_id: 'foreign' } }), 'pm').error)
      .toBe(REVIEW_INPUT_REFUSAL);
    expect(compileTaskContract(proposal({ inputs: [artifactInput], dependencies: ['artifact-1-fixture'], review: { input_id: 'artifact', author: 'model-a' } }), 'pm').error)
      .toMatch(/contain input_id, and optionally recheck/i);
  });

  it('accepts a required current workspacePath review input and refuses every other input with what is accepted', () => {
    const fileInput = {
      input_id: 'target', kind: 'workspacePath', path: 'src/a.ts', purpose: 'Review target',
      required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
    };
    const refusal = (inputs: unknown[], review: unknown = { input_id: 'target' }) =>
      compileTaskContract(proposal({ inputs, review }), 'pm').error;

    const valid = compile(proposal({ inputs: [fileInput], review: { input_id: 'target' } }));
    expect(valid.review).toEqual({ inputId: 'target' });
    // The relation names an input and nothing else: no path, digest or freshness of its own.
    expect(Object.keys(valid.review!)).toEqual(['inputId']);

    // A snapshot is read through the extracted-content tools, which issue no receipt a citation could name.
    expect(refusal([{ ...fileInput, freshness: 'dispatch-snapshot' }])).toBe(REVIEW_INPUT_REFUSAL);
    expect(refusal([{ ...fileInput, required: false }])).toBe(REVIEW_INPUT_REFUSAL);
    expect(refusal([{
      input_id: 'target', kind: 'contentAsset', asset_id: 'content-1', purpose: 'Review target',
      required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
    }])).toBe(REVIEW_INPUT_REFUSAL);
    // An id no input declares, and a review that names no input at all.
    expect(refusal([fileInput], { input_id: 'unknown' })).toBe(REVIEW_INPUT_REFUSAL);
    expect(refusal([])).toBe(REVIEW_INPUT_REFUSAL);
    expect(refusal([fileInput], {})).toBe('contract.review must contain input_id, and optionally recheck.');
    // One input only: a review cannot name a set of files.
    expect(refusal([fileInput, { ...fileInput, input_id: 'second', path: 'src/b.ts' }], { input_id: ['target', 'second'] }))
      .toBe('contract.review must contain input_id, and optionally recheck.');
    expect(refusal([fileInput], { input_id: 'target', also: 'second' })).toBe('contract.review must contain input_id, and optionally recheck.');

    // v0.9.106: a recheck names earlier findings, and a task may name findings it fixes; each "<reviewHandle>#F<n>", once.
    const recheck = compile(proposal({ inputs: [fileInput], review: { input_id: 'target', recheck: ['task-3#F2'] }, fixes: ['task-3#F1'] }));
    expect(recheck.review).toEqual({ inputId: 'target', recheck: ['task-3#F2'] });
    expect(recheck.fixes).toEqual(['task-3#F1']);
    expect(refusal([fileInput], { input_id: 'target', recheck: ['task-3 F2'] }))
      .toBe('contract.review.recheck must be a list of at most 50 findings, each written "<reviewHandle>#F<n>".');
    expect(refusal([fileInput], { input_id: 'target', recheck: ['task-3#F2', 'task-3#F2'] })).toBe('contract.review.recheck names a finding twice.');
    expect(compileTaskContract(proposal({ fixes: ['F1'] }), 'pm').error)
      .toBe('contract.fixes must be a list of at most 50 findings, each written "<reviewHandle>#F<n>".');
  });

  it('freezes author identity at publication and observes only an exact-attempt artifact read', async () => {
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, process.cwd());
    const producerContract = compile(proposal());
    const producer = await resolver.beginAttempt(producerContract, candidate('producer'), 'pm');
    const author = createEffectiveExecutionIdentity('reported-a', 'route-a', 1);
    resolver.bindAttemptExecutionIdentity(producer.card!.attemptId, author);
    const published = await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'FROZEN OUTPUT');
    resolver.endAttempt(producer.card!.attemptId, 'settled');

    const reviewContract = compile(proposal({
      inputs: [{
        input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: published.artifact!.artifactId,
        purpose: 'Review target', required: true, freshness: 'artifact-ready',
        provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [published.artifact!.artifactId],
      review: { input_id: 'artifact' },
    }));
    const reviewerAttempt = await resolver.beginAttempt(
      reviewContract,
      candidate('reviewer', { readyArtifacts: resolver.readyArtifacts() }),
      'pm',
    );
    const reviewer = createEffectiveExecutionIdentity('reported-b', 'route-b', 2);
    const facts = resolver.reviewPolicyFacts(reviewerAttempt.card!.attemptId);
    expect(facts.authorIdentity).toEqual(author);
    const decision = evaluateReviewPolicy({ review: facts.review, policy: { version: 1, requireDifferentReportedModelForArtifactReview: true }, authorIdentity: facts.authorIdentity, reviewerIdentity: reviewer });
    resolver.recordReviewAdmission(reviewerAttempt.card!.attemptId, decision);
    expect(resolver.reviewObservationForAttempt(reviewerAttempt.card!.attemptId)).toBeUndefined();

    resolver.noteRead(reviewerAttempt.card!.attemptId, 'reviewer', published.artifact!.contentAssetId);
    expect(resolver.reviewObservationForAttempt(reviewerAttempt.card!.attemptId)).toEqual(expect.objectContaining({
      artifactId: published.artifact!.artifactId,
      reviewInputId: 'artifact',
      producerAttemptId: producer.card!.attemptId,
      reviewerAttemptId: reviewerAttempt.card!.attemptId,
      sameReportedModel: false,
      sameConfiguredRouteAndModel: false,
      policyDecision: 'allowed-different-reported-model',
      artifactReadAt: expect.any(String),
    }));
    expect(JSON.stringify(published.artifact)).not.toMatch(/reported-a|route-a|routeVersionKey/);
    expect(JSON.stringify(reviewerAttempt.card)).not.toMatch(/reported-b|route-b|routeVersionKey/);
    await store.dispose();
  });

  it('deletes the private author binding when its artifact transport expires', async () => {
    let now = 1_000;
    const store = new ContentAssetStore({ ttlMs: 10, now: () => now });
    const resolver = new TaskInputResolver(store, process.cwd());
    const producer = await resolver.beginAttempt(compile(proposal()), candidate('producer'), 'pm');
    resolver.bindAttemptExecutionIdentity(
      producer.card!.attemptId,
      createEffectiveExecutionIdentity('reported-a', 'route-a', 1),
    );
    const published = await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'expires');
    expect(resolver.readyArtifacts()).toHaveLength(1);
    // v0.9.99: the producing attempt and the coordinator's request hold the artifact; it goes only once both let go.
    now += 11;
    expect(resolver.readyArtifacts()).toHaveLength(1);
    resolver.endAttempt(producer.card!.attemptId, 'settled');
    store.holdForUserRequest('pm', []);
    now += 11;
    expect(resolver.readyArtifacts()).toEqual([]);
    const rawReview = proposal({
      inputs: [{
        input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: published.artifact!.artifactId,
        purpose: 'expired', required: true, freshness: 'artifact-ready',
        provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [published.artifact!.artifactId],
      review: { input_id: 'artifact' },
    });
    const review = compile(rawReview);
    expect(preflightInputGrants(review, candidate('reviewer', { readyArtifacts: resolver.readyArtifacts() })).ok).toBe(false);
    await store.dispose();
  });
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

function compile(raw: Record<string, unknown>, proposedBy = 'pm'): EffectiveTaskContract {
  const result = compileTaskContract(raw, proposedBy);
  expect(result.error).toBeUndefined();
  expect(result.contract).toBeDefined();
  return result.contract!;
}

function candidate(
  agentId: string,
  extras: Partial<CandidateContractAgent> = {},
): CandidateContractAgent {
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

describe('v0.9.61 Task Contract', () => {
  it('compiles, labels, and bounds a coordinator brief without treating it as host fact', () => {
    const source = {
      input_id: 'brief-source', kind: 'workspacePath', path: 'docs/brief.md', purpose: 'Owner source',
      required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
    };
    const contract = compile(proposal({
      inputs: [source],
      coordinator_brief: { text: 'Focus on the acceptance criteria first.', basis_refs: ['brief-source'] },
    }));
    const card = formatTaskAttemptCard({
      attemptId: 'attempt-fixture', contractId: contract.contractId, agentId: 'worker', contract,
      grants: [{ attemptId: 'attempt-fixture', agentId: 'worker', inputId: 'brief-source', kind: 'workspacePath', sourceRef: 'docs/brief.md', suppliedAt: '2026-01-01T00:00:00.000Z' }],
      baselineWorkspaceAuthority: 'independent-agent-authority',
    });
    expect(card).toContain('Coordinator brief — claims and hypotheses, not host facts.');
    expect(card).toContain('Basis: brief-source');
    expect(card).toContain('Focus on the acceptance criteria first.');
    expect(compileTaskContract(proposal({ inputs: [source], coordinator_brief: { text: 'x', basis_refs: ['not-declared'] } }), 'pm').error)
      .toMatch(/basis_ref .*not.*declared/i);
    expect(compileTaskContract(proposal({ coordinator_brief: { text: 'x'.repeat(4_001) } }), 'pm').error)
      .toMatch(/coordinator_brief\.text.*4000/i);
  });

  it('rejects an otherwise optional brief basis that was not actually granted', async () => {
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, process.cwd());
    const contract = compile(proposal({
      inputs: [{
        input_id: 'optional-source', kind: 'contentAsset', asset_id: 'content-99', purpose: 'Optional source',
        required: false, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      }],
      coordinator_brief: { text: 'This rests on the optional source.', basis_refs: ['optional-source'] },
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker'), 'pm');
    expect(attempt.card).toBeUndefined();
    expect(attempt.error).toMatch(/coordinator brief cites input "optional-source".*not granted/i);
    await store.dispose();
  });

  it('makes input-substitution guidance conditional on required inputs, not any input', () => {
    const optional = compile(proposal({
      inputs: [{
        input_id: 'optional-source', kind: 'workspacePath', path: 'docs/optional.md', purpose: 'Optional',
        required: false, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const optionalCard = formatTaskAttemptCard({
      attemptId: 'attempt-optional', contractId: optional.contractId, agentId: 'worker', contract: optional,
      grants: [{ attemptId: 'attempt-optional', agentId: 'worker', inputId: 'optional-source', kind: 'workspacePath', sourceRef: 'docs/optional.md', suppliedAt: '2026-01-01T00:00:00.000Z' }],
      baselineWorkspaceAuthority: 'independent-agent-authority',
    });
    expect(optionalCard).toContain('This task declares no required inputs');
    expect(optionalCard).not.toContain('report_context_gap');
    expect(optionalCard).not.toMatch(/web search/i);

    const required = compile(proposal({
      inputs: [{
        input_id: 'required-source', kind: 'workspacePath', path: 'docs/required.md', purpose: 'Required',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const requiredCard = formatTaskAttemptCard({
      attemptId: 'attempt-required', contractId: required.contractId, agentId: 'worker', contract: required,
      grants: [{ attemptId: 'attempt-required', agentId: 'worker', inputId: 'required-source', kind: 'workspacePath', sourceRef: 'docs/required.md', suppliedAt: '2026-01-01T00:00:00.000Z' }],
      baselineWorkspaceAuthority: 'independent-agent-authority',
    });
    expect(requiredCard).toContain('report_context_gap');
    expect(requiredCard).toContain('declared input the host could not supply');
  });

  it('keeps read_files as a pointer while task scope and read capability remain enforced', () => {
    const contract = compile(proposal({
      effects: { read_files: [], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'docs/brief.docx', purpose: 'Read the brief',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    expect(preflightInputGrants(contract, candidate('worker', { workspaceRoot: '/workspace' })).ok).toBe(true);

    const missingRead = proposal({
      required_capabilities: { version: 1, capabilities: [] },
      inputs: contract.inputs.map((input) => ({
        input_id: input.inputId, kind: input.kind, path: (input as any).path, purpose: input.purpose,
        required: input.required, freshness: input.freshness, provenance: { kind: input.provenance.kind, source_refs: [] },
      })),
    });
    expect(compileTaskContract(missingRead, 'pm').error).toMatch(/explicitly declare "read"/i);
  });

  it('normalizes absolute paths only inside the supplied root and shares that normalizer with instruction text', () => {
    expect(normalizeWorkspacePath('C:\\work\\docs\\brief.docx', 'C:\\work')).toBe('docs/brief.docx');
    expect(normalizeWorkspacePath('C:\\work-old\\brief.docx', 'C:\\work')).toBeUndefined();
    expect(normalizeWorkspacePath('C:\\work\\..\\secret.txt', 'C:\\work')).toBeUndefined();
    expect(normalizeWorkspacePathsInInstruction('Read C:\\work\\docs\\brief.docx.', 'C:\\work'))
      .toBe('Read docs\\brief.docx.');
  });

  it('admits omitted ceremonial fields with explicit empty defaults', () => {
    const raw = proposal();
    delete raw.expected_deliverable;
    delete raw.constraints;
    delete raw.dependencies;

    expect(compile(raw)).toMatchObject({
      expectedDeliverable: '',
      constraints: [],
      dependencies: [],
    });
  });

  it('refuses a missing capability declaration instead of reading task prose', () => {
    const raw = proposal();
    delete raw.required_capabilities;
    expect(compileTaskContract(raw, 'pm').error).toMatch(/mandatory.*no capability is inferred from prose/i);
  });

  it('refuses a candidate that lacks a declared capability and names it', () => {
    const contract = compile(proposal({
      required_capabilities: { version: 1, capabilities: ['read', 'shell'] },
    }));
    const result = preflightInputGrants(contract, candidate('reviewer'));
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ filter: 'permissions', reason: expect.stringContaining('shell') }));
  });

  it('refuses structurally inconsistent capability declarations instead of silently adding authority', () => {
    const readContract = proposal({
      effects: { read_files: ['docs/brief.md'], expected_file_effect: 'none' },
      required_capabilities: { version: 1, capabilities: [] },
    });
    expect(compileTaskContract(readContract, 'pm').error).toMatch(/explicitly declare "read"/i);

    const writeContract = proposal({
      effects: {
        read_files: [],
        write_scope: { folder_access: [{ path: 'src', permission: 'readwrite' }] },
        expected_file_effect: 'modify',
      },
      required_capabilities: { version: 1, capabilities: ['read'] },
    });
    expect(compileTaskContract(writeContract, 'pm').error).toMatch(/explicitly declare "write".*will not infer or add/i);
  });

  it('keeps read files separate from write scope', () => {
    const contract = compile(proposal({
      effects: {
        read_files: ['docs/brief.md'],
        write_scope: { folder_access: [{ path: 'src', permission: 'readwrite' }] },
        expected_file_effect: 'modify',
      },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'docs/brief.md', purpose: 'Requirements',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    }));
    const result = preflightInputGrants(contract, candidate('dev', {
      capabilities: { read: true, write: true, shell: false },
    }));
    expect(result.failures).toContainEqual(expect.objectContaining({ filter: 'task-scope', inputId: 'brief' }));
    expect(contract.effects.readFiles).toEqual(['docs/brief.md']);
    expect(contract.effects.writeScope?.folderAccess).toEqual([{ path: 'src', permission: 'readwrite' }]);
  });

  // v0.9.97 P1: a folder whose name starts with two dots lies inside the task scope that holds it; a sibling whose name
  // starts like the scope folder, and a path that climbs out of it, do not (the file-effects design, §5).
  it('covers an input in a "..name" folder of the task scope, and not one beside the scope', () => {
    const scopedInput = (inputPath: string) => {
      const contract = compile(proposal({
        effects: {
          read_files: [],
          write_scope: { folder_access: [{ path: 'docs', permission: 'readwrite' }] },
          expected_file_effect: 'modify',
        },
        inputs: [{
          input_id: 'brief', kind: 'workspacePath', path: inputPath, purpose: 'Requirements',
          required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
        }],
        required_capabilities: { version: 1, capabilities: ['read', 'write'] },
      }));
      return preflightInputGrants(contract, candidate('dev', { workspaceRoot: '/workspace', capabilities: { read: true, write: true, shell: false } }));
    };
    expect(scopedInput('docs/..cache/brief.md').failures).toEqual([]);
    expect(scopedInput('docs/..cache/deep/brief.md').failures).toEqual([]);
    for (const outside of ['docs-old/brief.md', 'docs/../brief.md', 'docs/..cache/../../brief.md']) {
      expect(scopedInput(outside).failures, outside).toContainEqual(expect.objectContaining({ filter: 'task-scope', inputId: 'brief' }));
    }
  });

  it('keeps one grantability decision shared by routing and actual grant issue', async () => {
    const contractSource = await readFile(join(process.cwd(), 'src/backend/TaskContract.ts'), 'utf8');
    const teamSource = await readFile(join(process.cwd(), 'src/backend/TeamTools.ts'), 'utf8');
    // Definition + resolver issuance call; TeamTools contributes the candidate-filtering call.
    expect(contractSource.match(/preflightInputGrants\s*\(/g)).toHaveLength(2);
    expect(teamSource.match(/preflightInputGrants\s*\(/g)).toHaveLength(1);
    expect(teamSource).not.toMatch(/requestedDelegationCapabilities|infer.*capabilit/i);
  });
});

describe('v0.9.61 attempt-bound Input Resolver', () => {
  it('marks workspace input receipts by the host-observed physical file and never by an ungranted read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-physical-'));
    roots.push(root);
    await mkdir(join(root, 'research'));
    await writeFile(join(root, 'research', 'brief.md'), 'DECLARED INPUT', 'utf8');
    await writeFile(join(root, 'other.md'), 'UNGRANTED INPUT', 'utf8');
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['research/brief.md'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'research/brief.md', purpose: 'Fact-check baseline',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker', { workspaceRoot: root }), 'pm');
    const tools = new WorkspaceTools(root, new Set(['read']), 'worker');
    tools.setTaskInputResolver(resolver);
    tools.setTaskAttempt(attempt.card);

    expect(await tools.runText('read_file', { path: join(root, 'other.md') })).toContain('UNGRANTED INPUT');
    expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0].readAt).toBeUndefined();
    expect(await tools.runText('read_file', { path: join(root, 'research', 'brief.md') })).toContain('DECLARED INPUT');
    expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0]).toMatchObject({
      inputId: 'brief', reachableAt: expect.any(String), readAt: expect.any(String),
    });

    // The physical correlation key is private resolver state. The worker card and its formatted prompt
    // retain only the coordinator-authored workspace-relative sourceRef.
    expect(attempt.card!.grants[0].sourceRef).toBe('research/brief.md');
    expect(attempt.card!.grants[0].sourceRef).not.toBe(join(root, 'research', 'brief.md'));
    expect(formatTaskAttemptCard(attempt.card!)).not.toContain(root);
    expect(Object.keys(attempt.card!.grants[0]).sort()).toEqual([
      'agentId', 'attemptId', 'inputId', 'kind', 'sourceRef', 'suppliedAt',
    ]);
    await store.dispose();
  });

  it.runIf(process.platform === 'win32')('gives a lowercase drive letter the physical identity the file tools observe (release-stress finding S1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-drive-'));
    roots.push(root);
    await writeFile(join(root, 'brief.md'), 'DECLARED INPUT', 'utf8');
    // VS Code spells the drive letter in lowercase; read_file observes with the native realpath.
    const lowercase = root[0].toLowerCase() + root.slice(1);
    expect(resolveWorkspacePathIdentity(lowercase, 'brief.md')).toBe(await realpath(join(root, 'brief.md')));
  });

  it('uses filesystem identity for symlink aliases and filesystem-specific case semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-identity-'));
    roots.push(root);
    const research = join(root, 'research');
    await mkdir(research);
    await writeFile(join(research, 'brief.md'), 'PHYSICAL INPUT', 'utf8');
    const alias = join(root, 'alias');
    let aliasAvailable = true;
    try {
      await symlink(research, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: any) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') aliasAvailable = false;
      else throw error;
    }
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const makeContract = () => compile(proposal({
      effects: {
        read_files: ['research/brief.md'],
        write_scope: { folder_access: [{ path: 'research', permission: 'read' }] },
        expected_file_effect: 'none',
      },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'research/brief.md', purpose: 'Filesystem identity',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));

    if (aliasAvailable) {
      const aliasContract = makeContract();
      const aliasAttempt = await resolver.beginAttempt(aliasContract, candidate('worker', { workspaceRoot: root }), 'pm');
      const aliasTools = new WorkspaceTools(root, new Set(['read']), 'worker');
      aliasTools.setTaskInputResolver(resolver);
      aliasTools.setTaskAttempt(aliasAttempt.card);
      expect(await aliasTools.runText('read_file', { path: 'alias/brief.md' })).toContain('PHYSICAL INPUT');
      expect(resolver.grantsForAttempt(aliasAttempt.card!.attemptId)[0].readAt).toEqual(expect.any(String));
      resolver.endAttempt(aliasAttempt.card!.attemptId, 'settled');
    }

    const caseContract = makeContract();
    const caseVariant = join(root, 'Research', 'brief.md');
    const caseInsensitive = await realpath(caseVariant).then(() => true, () => false);
    const caseAdmissionContract = compile(proposal({
      effects: {
        read_files: ['Research/brief.md'],
        write_scope: { folder_access: [{ path: 'research', permission: 'read' }] },
        expected_file_effect: 'none',
      },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'Research/brief.md', purpose: 'Filesystem case',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    expect(preflightInputGrants(caseAdmissionContract, candidate('worker', { workspaceRoot: root })).ok)
      .toBe(caseInsensitive);
    const caseAttempt = await resolver.beginAttempt(caseContract, candidate('worker', { workspaceRoot: root }), 'pm');
    const caseTools = new WorkspaceTools(root, new Set(['read']), 'worker');
    caseTools.setTaskInputResolver(resolver);
    caseTools.setTaskAttempt(caseAttempt.card);
    const result = await caseTools.runText('read_file', { path: 'Research/brief.md' });
    if (caseInsensitive) {
      expect(result).toContain('PHYSICAL INPUT');
      expect(resolver.grantsForAttempt(caseAttempt.card!.attemptId)[0].readAt).toEqual(expect.any(String));
    } else {
      expect(result).toMatch(/not found/i);
      expect(resolver.grantsForAttempt(caseAttempt.card!.attemptId)[0].readAt).toBeUndefined();
    }
    await store.dispose();
  });

  it('uses the shared attempt-liveness predicate when granting declared contract-managed content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const first = await store.storeText('FIRST');
    const other = await store.storeText('OTHER');
    if ('error' in first || 'error' in other) throw new Error('fixture storage failed');
    const contract = compile(proposal({
      inputs: [{
        input_id: 'brief', kind: 'contentAsset', asset_id: first.assetId, purpose: 'Owner brief',
        required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: ['turn-source'] },
      }],
    }));
    const facts = candidate('worker', {
      authorizedContentAssetIds: [first.assetId],
      liveContentAssetIds: [first.assetId, other.assetId],
    });

    const attempt1 = await resolver.beginAttempt(contract, facts, 'pm');
    expect(attempt1.card).toBeDefined();
    expect(Object.isFrozen(attempt1.card)).toBe(true);
    expect(Object.isFrozen(attempt1.card!.contract)).toBe(true);
    expect(Object.isFrozen(attempt1.card!.grants)).toBe(true);
    expect(() => attempt1.card!.grants.push({ ...attempt1.card!.grants[0] })).toThrow();
    expect(resolver.canReadContentAsset(attempt1.card!.attemptId, 'worker', first.assetId)).toBe(true);
    expect(resolver.canReadContentAsset(attempt1.card!.attemptId, 'worker', other.assetId)).toBe(false);
    resolver.endAttempt(attempt1.card!.attemptId, 'settled');
    expect(resolver.canReadContentAsset(attempt1.card!.attemptId, 'worker', first.assetId)).toBe(false);

    const attempt2 = await resolver.beginAttempt(contract, facts, 'pm');
    expect(attempt2.card!.attemptId).not.toBe(attempt1.card!.attemptId);
    expect(resolver.canReadContentAsset(attempt1.card!.attemptId, 'worker', first.assetId)).toBe(false);
    expect(resolver.canReadContentAsset(attempt2.card!.attemptId, 'worker', first.assetId)).toBe(true);
    await store.dispose();
  });

  it('creates a dispatch-time workspace snapshot without widening file authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    await writeFile(join(root, 'brief.md'), 'version one', 'utf8');
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['brief.md'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'brief.md', purpose: 'Frozen brief',
        required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker'), 'pm');
    const assetId = attempt.card?.grants[0].resolvedContentAssetId;
    expect(assetId).toMatch(/^content-/);
    await writeFile(join(root, 'brief.md'), 'version two', 'utf8');
    const snapshot = await store.readExtractedContent(assetId!, { start: 1, end: 1 });
    expect('error' in snapshot ? snapshot.error : snapshot.items[0].text).toContain('version one');
    expect(contract.requiredCapabilities.capabilities).toEqual(['read']);
    await store.dispose();
  });

  // Smoke of 81f50826: a snapshot decoded any file's bytes as UTF-8, so a Word input reached the teammate as ZIP bytes.
  // A binary file whose text UnodeAi cannot read is now refused, and nothing is stored for it. (A Word, PowerPoint or
  // PDF file is snapshotted as its extracted text: OutsideContractInputDocument.flow.test, which needs the built worker.)
  it('refuses to snapshot a binary file whose text it cannot read, and stores nothing for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    await writeFile(join(root, 'chart.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0), Buffer.from('IHDR')]));
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['chart.png'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'chart', kind: 'workspacePath', path: 'chart.png', purpose: 'Frozen chart',
        required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker'), 'pm');
    expect(attempt.card).toBeUndefined();
    expect(attempt.error).toBe('input-grant: snapshot input "chart" is a binary file whose text UnodeAi cannot read '
      + '(it reads Word, PowerPoint, PDF and text files); nothing was snapshotted');
    expect(await store.readExtractedContent('content-1', { start: 1, end: 1 })).toHaveProperty('error');
    await store.dispose();
  });

  it('leaves out an optional binary file whose text it cannot read, says so on the card, and starts the task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    await writeFile(join(root, 'brief.md'), 'the brief to work from', 'utf8');
    await writeFile(join(root, 'chart.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0), Buffer.from('IHDR')]));
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['brief.md', 'chart.png'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'brief.md', purpose: 'Frozen brief',
        required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      }, {
        input_id: 'chart', kind: 'workspacePath', path: 'chart.png', purpose: 'Optional chart',
        required: false, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker'), 'pm');
    expect(attempt.error).toBeUndefined();
    expect(attempt.card!.grants.map((grant) => grant.inputId)).toEqual(['brief']);
    expect(attempt.card!.unreadableOptionalInputs).toEqual(['chart']);
    const text = formatTaskAttemptCard(attempt.card!);
    expect(text).toContain('- chart [workspacePath; optional]: Optional chart — not passed (optional): it is a binary file '
      + 'whose text UnodeAi cannot read');
    expect(text).toContain('- brief [workspacePath; required]: Frozen brief — read with extracted-content tools as content-1');
    expect(await store.readExtractedContent('content-1', { start: 1, end: 1 })).not.toHaveProperty('error');
    expect(await store.readExtractedContent('content-2', { start: 1, end: 1 })).toHaveProperty('error');
    await store.dispose();
  });

  it('reserves a contract before async snapshot work so concurrent attempts cannot both become live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    await writeFile(join(root, 'brief.md'), 'one execution only', 'utf8');
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['brief.md'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'brief.md', purpose: 'Frozen brief',
        required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));

    const attempts = await Promise.all([
      resolver.beginAttempt(contract, candidate('worker-a'), 'pm'),
      resolver.beginAttempt(contract, candidate('worker-b'), 'pm'),
    ]);
    expect(attempts.filter((attempt) => attempt.card)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.error)).toEqual([
      expect.objectContaining({ error: expect.stringMatching(/already has a live attempt/i) }),
    ]);
    await store.dispose();
  });

  it('publishes only explicit immutable artifacts, preserves all input provenance, and authorises one declared downstream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const source = await store.storeText('PRIVATE');
    if ('error' in source) throw new Error('fixture storage failed');
    const upstream = compile(proposal({
      inputs: [{
        input_id: 'private', kind: 'contentAsset', asset_id: source.assetId, purpose: 'Private source',
        required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      }],
    }));
    const producer = await resolver.beginAttempt(upstream, candidate('worker-a', {
      authorizedContentAssetIds: [source.assetId], liveContentAssetIds: [source.assetId],
    }), 'pm');
    const published = await resolver.publishArtifact(producer.card!.attemptId, 'worker-a', 'BOUNDED OUTPUT');
    expect(published.artifact?.provenance).toEqual([expect.objectContaining({ inputId: 'private' })]);
    resolver.endAttempt(producer.card!.attemptId, 'settled');

    const downstream = compile(proposal({
      inputs: [{
        input_id: 'upstream', kind: 'upstreamArtifact', artifact_id: published.artifact!.artifactId,
        purpose: 'Approved upstream output', required: true, freshness: 'artifact-ready',
        provenance: { kind: 'upstream-artifact', source_refs: [published.artifact!.artifactId] },
      }],
      dependencies: [published.artifact!.artifactId],
    }));
    const facts = candidate('worker-b', { readyArtifacts: resolver.readyArtifacts() });
    const granted = await resolver.beginAttempt(downstream, facts, 'pm');
    expect(resolver.canReadContentAsset(granted.card!.attemptId, 'worker-b', published.artifact!.contentAssetId)).toBe(true);
    expect(resolver.canReadContentAsset(granted.card!.attemptId, 'worker-c', published.artifact!.contentAssetId)).toBe(false);
    const republished = await resolver.publishArtifact(granted.card!.attemptId, 'worker-b', 'SECOND HOP');
    expect(republished.artifact?.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ producerAttemptId: producer.card!.attemptId, inputId: 'private', kind: 'contentAsset' }),
      expect.objectContaining({ producerAttemptId: granted.card!.attemptId, inputId: 'upstream', kind: 'upstreamArtifact' }),
    ]));

    const foreign = compile(proposal({
      inputs: [{
        input_id: 'upstream', kind: 'upstreamArtifact', artifact_id: published.artifact!.artifactId,
        purpose: 'Try to re-delegate', required: true, freshness: 'artifact-ready',
        provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [published.artifact!.artifactId],
    }), 'other-pm');
    expect(preflightInputGrants(foreign, candidate('worker-c', { readyArtifacts: resolver.readyArtifacts() })).failures)
      .toContainEqual(expect.objectContaining({ filter: 'input-grant' }));
    await store.dispose();
  });

  it('records context gaps as a separate task state with coordinator purpose, while an unknown id discloses nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['missing.md'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'brief', kind: 'workspacePath', path: 'missing.md', purpose: 'The customer acceptance boundary',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker'), 'pm');
    resolver.noteWorkspaceAccessFailure(attempt.card!.attemptId, 'worker', 'missing.md', 'missing');
    const report = resolver.reportContextGap(attempt.card!.attemptId, 'worker', 'brief');
    expect(report).toMatchObject({ status: 'recorded', gap: { inputId: 'brief', reason: 'missing', purpose: 'The customer acceptance boundary' } });
    expect(resolver.reportContextGap(attempt.card!.attemptId, 'worker', 'not-granted')).toEqual({ status: 'unknown-or-unavailable' });
    await store.dispose();
  });

  it('uses the latest host observation per input and keeps repeated reports idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-gap-'));
    roots.push(root);
    await writeFile(join(root, 'readable.txt'), 'Readable but semantically incomplete.', 'utf8');
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['readable.txt', 'missing.txt'], expected_file_effect: 'none' },
      inputs: [
        { input_id: 'readable', kind: 'workspacePath', path: 'readable.txt', purpose: 'Readable source', required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } },
        { input_id: 'missing', kind: 'workspacePath', path: 'missing.txt', purpose: 'Missing source', required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } },
      ],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker', { workspaceRoot: root }), 'pm');
    const tools = new WorkspaceTools(root, new Set(['read']), 'worker');
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setTaskAttempt(attempt.card);

    await expect(tools.runText('report_context_gap', { inputId: 'readable' })).resolves.toMatch(/attempt the declared input/i);
    await expect(tools.runText('read_file', { path: 'readable.txt' })).resolves.toContain('Readable but semantically incomplete');
    await expect(tools.runText('report_context_gap', { inputId: 'readable', reason: 'unreadable' })).resolves.toMatch(/successfully read/i);
    expect(resolver.gapsForAttempt(attempt.card!.attemptId)).toEqual([]);

    await expect(tools.runText('read_file', { path: 'missing.txt' })).resolves.toMatch(/not found/i);
    await expect(tools.runText('report_context_gap', { inputId: 'readable' })).resolves.toMatch(/successfully read/i);
    await expect(tools.runText('report_context_gap', { inputId: 'missing', reason: 'unreadable' })).resolves.toMatch(/host-observed missing/i);
    await expect(tools.runText('report_context_gap', { inputId: 'missing' })).resolves.toMatch(/host-observed missing/i);
    expect(resolver.gapsForAttempt(attempt.card!.attemptId)).toHaveLength(1);

    await writeFile(join(root, 'missing.txt'), 'now readable', 'utf8');
    await expect(tools.runText('read_file', { path: 'missing.txt' })).resolves.toContain('now readable');
    expect(resolver.gapsForAttempt(attempt.card!.attemptId)).toEqual([]);
    expect(resolver.grantsForAttempt(attempt.card!.attemptId).find((grant) => grant.inputId === 'missing')?.readAt)
      .toEqual(expect.any(String));
    await store.dispose();
  });

  it('derives unreadable from a real document extraction failure, not the retired reason field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-bad-doc-'));
    roots.push(root);
    await writeFile(join(root, 'broken.pdf'), Buffer.from('%PDF-1.7\nnot a valid pdf\n'));
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const contract = compile(proposal({
      effects: { read_files: ['broken.pdf'], expected_file_effect: 'none' },
      inputs: [{ input_id: 'document', kind: 'workspacePath', path: 'broken.pdf', purpose: 'Broken PDF', required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker', { workspaceRoot: root }), 'pm');
    const tools = new WorkspaceTools(root, new Set(['read']), 'worker');
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setTaskAttempt(attempt.card);

    await expect(tools.runText('read_file', { path: 'broken.pdf' })).resolves.toMatch(/Error:.*extraction|was not read/i);
    await expect(tools.runText('report_context_gap', { inputId: 'document', reason: 'missing' })).resolves.toMatch(/host-observed unreadable/i);
    expect(resolver.gapsForAttempt(attempt.card!.attemptId)[0].reason).toBe('unreadable');
    await store.dispose();
  });

  it('never carries a failure observation across an agent or attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-isolation-'));
    roots.push(root);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const makeContract = () => compile(proposal({
      effects: { read_files: ['missing.txt'], expected_file_effect: 'none' },
      inputs: [{ input_id: 'source', kind: 'workspacePath', path: 'missing.txt', purpose: 'Source', required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } }],
    }));
    const first = await resolver.beginAttempt(makeContract(), candidate('worker-a', { workspaceRoot: root }), 'pm');
    const second = await resolver.beginAttempt(makeContract(), candidate('worker-b', { workspaceRoot: root }), 'pm');
    resolver.noteWorkspaceAccessFailure(first.card!.attemptId, 'worker-a', 'missing.txt', 'missing');
    resolver.noteWorkspaceAccessFailure(second.card!.attemptId, 'worker-a', 'missing.txt', 'unreadable');

    expect(resolver.reportContextGap(first.card!.attemptId, 'worker-b', 'source')).toEqual({ status: 'unknown-or-unavailable' });
    expect(resolver.reportContextGap(second.card!.attemptId, 'worker-b', 'source')).toEqual({ status: 'no-current-failure' });
    await store.dispose();
  });

  it('enforces grants through the real content tools without adding write, command, or network authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-contract-'));
    roots.push(root);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const grantedSource = await store.storeText('GRANTED');
    const deniedSource = await store.storeText('DENIED');
    if ('error' in grantedSource || 'error' in deniedSource) throw new Error('fixture storage failed');
    const contract = compile(proposal({
      inputs: [{
        input_id: 'brief', kind: 'contentAsset', asset_id: grantedSource.assetId, purpose: 'Owner brief',
        required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
      }],
    }));
    const attempt = await resolver.beginAttempt(contract, candidate('worker', {
      authorizedContentAssetIds: [grantedSource.assetId],
      liveContentAssetIds: [grantedSource.assetId, deniedSource.assetId],
    }), 'pm');
    const tools = new WorkspaceTools(
      root, new Set(['read']), 'worker', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { policy: () => 'off', requestApproval: async () => ({ allow: false }) },
      'apply-edit', store,
    );
    const before = tools.specs().map((spec) => spec.function.name);
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setDelegationContentSources([
      { assetId: grantedSource.assetId, kind: 'user-request', label: 'a', location: 'turn', mediaKind: 'text' },
      { assetId: deniedSource.assetId, kind: 'user-request', label: 'b', location: 'turn', mediaKind: 'text' },
    ]);
    tools.setTaskAttempt(attempt.card);
    const after = tools.specs().map((spec) => spec.function.name);
    const gapSpec = tools.specs().find((spec) => spec.function.name === 'report_context_gap')!;
    expect(gapSpec.function.parameters.required).toEqual(['inputId']);
    expect(gapSpec.function.parameters.properties).not.toHaveProperty('reason');
    expect(after).not.toContain('write_file');
    expect(after).not.toContain('run_command');
    expect(after.includes('fetch_url')).toBe(before.includes('fetch_url'));
    await expect(tools.runText('read_extracted_content', { assetId: grantedSource.assetId, pages: { start: 1, end: 1 } })).resolves.toContain('GRANTED');
    expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0]).toMatchObject({
      inputId: 'brief', reachableAt: expect.any(String), readAt: expect.any(String),
    });
    await expect(tools.run('read_extracted_content', { assetId: deniedSource.assetId, pages: { start: 1, end: 1 } }))
      .resolves.toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
    await expect(tools.runText('report_context_gap', { inputId: 'brief', reason: 'unreadable' })).resolves.toMatch(/successfully read in this attempt/);
    const undisclosedInput = await tools.run('report_context_gap', { inputId: 'secret', reason: 'missing' });
    expect(undisclosedInput).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(undisclosedInput.output).toBe(
      'report_context_gap refused: task-scope. Use the inputs granted in the task card, call report_context_gap '
      + 'for a specific required input, or ask the coordinator to widen the scope.',
    );
    await expect(tools.runText('publish_task_artifact', { content: 'EXPLICIT ARTIFACT' })).resolves.toMatch(/Published immutable artifact/);
    const artifactContentId = resolver.artifactsForAttempt(attempt.card!.attemptId)[0].contentAssetId;
    resolver.endAttempt(attempt.card!.attemptId, 'settled');
    await expect(tools.run('read_extracted_content', { assetId: grantedSource.assetId, pages: { start: 1, end: 1 } }))
      .resolves.toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
    // The producing agent owns the store entry, but artifact transport is contract-managed and cannot be
    // recovered through that baseline ownership after its attempt ends.
    await expect(tools.run('read_extracted_content', { assetId: artifactContentId, pages: { start: 1, end: 1 } }))
      .resolves.toMatchObject({ status: 'refused', reason: 'asset-unavailable' });
    await store.dispose();
  });
});

describe('the dispatch binding of a workspace file review', () => {
  const POLICY_OFF = { version: 1 as const, requireDifferentReportedModelForArtifactReview: false };
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  async function reviewRoot(content: string | Uint8Array = 'export const a = 1;\nexport const unused = 2;\n') {
    const root = await mkdtemp(join(tmpdir(), 'unode-review-binding-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), content);
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, root);
    const fileReview = (targetPath = 'src/a.ts') => compile(proposal({
      inputs: [{
        input_id: 'target', kind: 'workspacePath', path: targetPath, purpose: 'Review target',
        required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
      }],
      review: { input_id: 'target' },
    }));
    /** A live review of `targetPath` that the review policy admitted, as the host admits one before its turn. */
    const admitted = async (targetPath = 'src/a.ts') => {
      const attempt = await resolver.beginAttempt(fileReview(targetPath), candidate('reviewer'), 'pm');
      expect(attempt.error).toBeUndefined();
      resolver.recordReviewAdmission(attempt.card!.attemptId, evaluateReviewPolicy({ review: attempt.card!.contract.review, policy: POLICY_OFF }));
      return attempt.card!;
    };
    return { root, store, resolver, fileReview, admitted };
  }

  // v0.9.97 P1: a review of a file in a folder whose name starts with two dots binds that file; a target that climbs
  // out through such a folder, or names a sibling whose name starts like the workspace's, is refused (the file-effects
  // design, §5).
  it('starts a review of a file in a "..name" folder, and refuses one that climbs out through it', async () => {
    const { root, store, resolver, fileReview } = await reviewRoot();
    await mkdir(join(root, '..cache'));
    await writeFile(join(root, '..cache', 'a.ts'), 'export const cached = 1;\n', 'utf8');
    const sibling = `${root}-x`;
    await mkdir(sibling);
    roots.push(sibling);
    await writeFile(join(sibling, 'a.ts'), 'export const sibling = 1;\n', 'utf8');
    const begin = (targetPath: string) => resolver.beginAttempt(fileReview(targetPath), candidate('reviewer'), 'pm');
    const escapes = { error: 'task-scope: workspace review target "target" escapes the workspace root' };

    const started = await begin('..cache/a.ts');
    expect(started.error).toBeUndefined();
    expect(started.card).toBeDefined();
    await expect(begin(`..cache/../../${basename(sibling)}/a.ts`)).resolves.toEqual(escapes);
    await expect(begin(`src/../../${basename(sibling)}/a.ts`)).resolves.toEqual(escapes);
    await store.dispose();
  });

  it('does not start a review whose target is missing, a folder or outside the workspace; v0.9.99: a file past the former 10 MiB is bound', async () => {
    const { root, store, resolver, fileReview } = await reviewRoot();
    const outside = await mkdtemp(join(tmpdir(), 'unode-review-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'a.ts'), 'export const outside = 1;\n', 'utf8');
    const unbound = 'input-grant: workspace review target "target" is missing, is not a file, or is larger than the '
      + `${hostReadMemoryBudget()} bytes this window can hold in memory at once; a review of a workspace file needs that file at dispatch`;
    const begin = (targetPath: string) => resolver.beginAttempt(fileReview(targetPath), candidate('reviewer'), 'pm');

    await expect(begin('src/missing.ts')).resolves.toEqual({ error: unbound });
    await expect(begin('src')).resolves.toEqual({ error: unbound });
    // The file exists and is readable; it is refused for where it is, before any of it is read.
    await expect(begin(`src/../../${basename(outside)}/a.ts`)).resolves.toEqual({
      error: 'task-scope: workspace review target "target" escapes the workspace root',
    });

    // v0.9.99: read_file has no fixed size limit any more, and neither has the binding: past the former 10 MiB, bound.
    await writeFile(join(root, 'src', 'over.txt'), Buffer.alloc(CONTENT_ASSET_MAX_BYTES + 1, 0x61));
    expect((await begin('src/over.txt')).card).toBeDefined();

    // A refused dispatch holds nothing: the same contract starts once its target exists.
    const late = fileReview('src/late.ts');
    await expect(resolver.beginAttempt(late, candidate('reviewer'), 'pm')).resolves.toEqual({ error: unbound });
    await writeFile(join(root, 'src', 'late.ts'), 'export const late = 1;\n', 'utf8');
    expect((await resolver.beginAttempt(late, candidate('reviewer'), 'pm')).card).toBeDefined();
    await store.dispose();
  });

  it('keeps the bound digest, the physical path and the capture time out of the card, its grants and its text', async () => {
    const content = 'export const a = 1;\nexport const unused = 2;\n';
    const { root, store, resolver, admitted } = await reviewRoot(content);
    const card = await admitted();

    // The card is the object a backend, the run ledger and an evidence export are handed. It has no field for the binding.
    expect(Object.keys(card).sort()).toEqual(['agentId', 'attemptId', 'baselineWorkspaceAuthority', 'contract', 'contractId', 'grants']);
    expect(Object.keys(card.contract.review!)).toEqual(['inputId']);
    const exposed = JSON.stringify([card, formatTaskAttemptCard(card), resolver.grantsForAttempt(card.attemptId), resolver.reviewPolicyFacts(card.attemptId)]);
    for (const absent of [sha256(Buffer.from(content, 'utf8')), basename(root), 'contentDigest', 'physicalPath', 'lexicalPath', 'capturedAt']) {
      expect(exposed).not.toContain(absent);
    }
    // What the card does say is the workspace-relative path the coordinator declared.
    expect(card.grants[0]).toMatchObject({ inputId: 'target', kind: 'workspacePath', sourceRef: 'src/a.ts' });
    await store.dispose();
  });

  it('names in the task card what kind of input the marked review is a review of', async () => {
    const { store, resolver, admitted } = await reviewRoot();

    const fileCard = formatTaskAttemptCard(await admitted());
    expect(fileCard).toContain('Marked workspace file review input: target');
    expect(fileCard).toContain('- target [workspacePath; required]: Review target — read workspace path src/a.ts (current content)');
    expect(fileCard).toContain('Close this review with close_assignment and review_evidence');
    // v0.9.106 (field smoke of a86b8516): evidence is no longer called optional, and the close outranks "put it in your reply".
    expect(fileCard).not.toContain('Review evidence is optional');
    expect(fileCard).toContain('Do this even if the task asks you to put your conclusion in your reply.');
    // v0.9.106 (field retest, 2026-11-18): a review that found no defect closes with no finding, not with a "PASS" one.
    expect(fileCard).toContain('A finding is a defect or risk for the coordinator to decide. If you found none, close with '
      + 'findings: [] and your coverage: a pass or "no defect found" is not a finding');

    // The artifact review and the task that is no review keep the line they had.
    const producer = await resolver.beginAttempt(compile(proposal()), candidate('producer'), 'pm');
    expect(formatTaskAttemptCard(producer.card!)).toContain('Marked artifact review input: none');
    const artifact = (await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'ARTIFACT')).artifact!;
    const artifactReview = await resolver.beginAttempt(compile(proposal({
      inputs: [{
        input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: artifact.artifactId, purpose: 'Review target',
        required: true, freshness: 'artifact-ready', provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [artifact.artifactId],
      review: { input_id: 'artifact' },
    })), candidate('reviewer', { readyArtifacts: resolver.readyArtifacts() }), 'pm');
    expect(formatTaskAttemptCard(artifactReview.card!)).toContain('Marked artifact review input: artifact');
    await store.dispose();
  });

  it('takes the dispatch digest over the bytes on disk, so a file that is no valid text still matches a receipt of those bytes', async () => {
    // 0xff is no UTF-8 at all, and the leading bytes are a byte-order mark a text decoder drops.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0x62, 0x0a]);
    expect(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)).toBe(false);
    const { root, store, resolver, admitted } = await reviewRoot(bytes);
    const card = await admitted();
    const view = { path: 'src/a.ts', pathAliases: [join(root, 'src', 'a.ts')], startLine: 1, endLine: 2, coverage: 'complete' as const };
    const cite = (readReceiptId: string) => ({
      schemaVersion: 1, coverage: 'partial', searches: [],
      findings: [{ classification: 'observed', statement: 'Line 2 holds a byte that is no text.', citations: [{ readReceiptId, path: 'src/a.ts', startLine: 2, endLine: 2 }] }],
    });

    // Receipts as the file tools would issue them: R1 over the bytes decoded and encoded again, R2 over the bytes themselves.
    const receipts = new ReviewReceiptRegistry();
    receipts.issueRead({ ...view, contentDigest: sha256(Buffer.from(bytes.toString('utf8'), 'utf8')) });
    receipts.issueRead({ ...view, contentDigest: sha256(bytes) });
    resolver.bindReviewReceipts(card.attemptId, 'reviewer', receipts);

    // A refusal has two wordings of one text: the failed call's, and the same without the failure mark.
    const finding = 'review target changed; dispatch a new review. finding 1, citation 1: read receipt R1 displayed the file under '
      + 'review with content other than it had when this review was dispatched. This call recorded nothing for the review. A '
      + 'review of a workspace file is closed only against that file as it was dispatched: have a new review dispatched for the '
      + 'file as it is now, or, if you cannot dispatch one, say in your reply that the review target changed.';
    expect(resolver.closeReviewAssignment(card.attemptId, 'reviewer', cite('R1'))).toEqual({
      status: 'refused',
      reason: `Error: ${finding}`,
      finding,
    });
    expect(resolver.reviewEvidenceForAttempt(card.attemptId)).toEqual({ schemaVersion: 1, state: 'not-submitted' });
    expect(resolver.closeReviewAssignment(card.attemptId, 'reviewer', cite('R2'))).toMatchObject({
      status: 'closed', evidence: { state: 'citations-checked', receipt: { citations: 1 } },
    });
    await store.dispose();
  });

  it('places a view by an absolute path only, and reads no relative name from the folder the host process runs in', async () => {
    const { root, store, resolver, admitted } = await reviewRoot();
    const card = await admitted();
    // The name the target would have if a relative path were read from this process's own working folder, which
    // has nothing to do with the workspace. On another drive there is no such name and nothing to tell apart.
    const fromProcessFolder = relative(process.cwd(), join(root, 'src', 'a.ts'));
    if (!isAbsolute(fromProcessFolder)) {
      // A view known by that relative name alone, of bytes that are not the dispatched ones.
      const receipts = new ReviewReceiptRegistry();
      const view = receipts.issueRead({ path: fromProcessFolder, pathAliases: [], startLine: 1, endLine: 2, contentDigest: 'f'.repeat(64), coverage: 'complete' })!;
      resolver.bindReviewReceipts(card.attemptId, 'reviewer', receipts);

      // The host cannot place it, so it is a view of some other file and is not held to the target's digest.
      expect(resolver.closeReviewAssignment(card.attemptId, 'reviewer', {
        schemaVersion: 1, coverage: 'partial', searches: [],
        findings: [{ classification: 'observed', statement: 'Seen elsewhere.', citations: [{ readReceiptId: view.id, path: view.path, startLine: 1, endLine: 1 }] }],
      })).toMatchObject({ status: 'closed', evidence: { state: 'citations-checked' } });
    }
    await store.dispose();
  });
});

// v0.9.100 (CI on Linux, 7fc21c4b): a POSIX absolute path is absolute by Windows rules too, so choosing the rules by
// `path.win32.isAbsolute` resolved an outside folder `/tmp/x` as `\tmp\x` on Linux and macOS, a name inside the workspace.
describe('contract path rules follow the spelling, then the host', () => {
  it('uses Windows rules only for a drive or share spelling, and the host rules for a POSIX path', async () => {
    const nodePath = await import('node:path');
    expect(contractPathApi('/tmp/outside', '/tmp/workspace', nodePath.posix)).toBe(nodePath.posix);
    expect(contractPathApi('docs/a.md', '/home/me/ws', nodePath.posix)).toBe(nodePath.posix);
    expect(contractPathApi('C:\\outside', '/tmp/workspace', nodePath.posix)).toBe(nodePath.win32);
    expect(contractPathApi('docs/a.md', 'C:\\ws', nodePath.posix)).toBe(nodePath.win32);
    expect(contractPathApi('\\\\server\\share\\x', undefined, nodePath.posix)).toBe(nodePath.win32);
    // A single leading backslash is not a share: it keeps the host's rules.
    expect(contractPathApi('\\tmp\\x', '/tmp/workspace', nodePath.posix)).toBe(nodePath.posix);
    expect(contractPathApi('c:/outside', undefined, nodePath.posix)).toBe(nodePath.win32);
    // Under POSIX rules the outside folder keeps its own spelling, outside the workspace.
    const rules = contractPathApi('/tmp/outside', '/tmp/workspace', nodePath.posix);
    expect(rules.resolve('/tmp/outside')).toBe('/tmp/outside');
    expect(rules.relative('/tmp/workspace', '/tmp/outside')).toBe('../outside');
  });
});

// v0.9.100 (field, 7fc21c4b T2): "read the agreement, write the summary there". With a write_scope, the scope is the
// teammate's whole reach, and the agreement named only in read_files was out of it.
describe('an outside read file joins the task scope as read', () => {
  it('adds an outside read file the scope does not cover, and only that', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'unode-contract-outside-read-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'unode-contract-outside-out-')));
    const agreement = join(outside, 'agreement.docx');
    const covered = join(outside, 'summary', 'old.docx');
    try {
      const withScope = compileTaskContract(proposal({
        effects: { read_files: [agreement, covered, 'docs/inside.md'],
          write_scope: { folder_access: [{ path: join(outside, 'summary'), permission: 'readwrite' }] }, expected_file_effect: 'create' },
        required_capabilities: { version: 1, capabilities: ['read', 'write'] },
      }), 'pm', root);
      expect(withScope.error).toBeUndefined();
      expect(withScope.contract?.effects.writeScope?.folderAccess).toEqual([
        { path: join(outside, 'summary'), permission: 'readwrite' },
        { path: agreement, permission: 'read' },
      ]);
      expect(withScope.contract?.effects.readFiles).toEqual([agreement, covered, 'docs/inside.md']);
      // Audit of 15a4fa53 (F1): a scope of the whole workspace, `.` or its absolute root, covers nothing outside it.
      for (const workspaceEntry of ['.', root]) {
        const workspaceScope = compileTaskContract(proposal({
          effects: { read_files: [agreement], write_scope: { folder_access: [{ path: workspaceEntry, permission: 'readwrite' }] }, expected_file_effect: 'create' },
          required_capabilities: { version: 1, capabilities: ['read', 'write'] },
        }), 'pm', root);
        expect(workspaceScope.error, workspaceEntry).toBeUndefined();
        expect(workspaceScope.contract?.effects.writeScope?.folderAccess, workspaceEntry).toEqual([
          { path: '.', permission: 'readwrite' },
          { path: agreement, permission: 'read' },
        ]);
      }
      // Without a write_scope there is no task scope to join: the file is read under the teammate's own reach.
      const without = compileTaskContract(proposal({ effects: { read_files: [agreement], expected_file_effect: 'none' } }), 'pm', root);
      expect(without.error).toBeUndefined();
      expect(without.contract?.effects.writeScope).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// v0.9.101 (A1, field aebbd520 T2): the PM put the outside contract it was to summarise in contract.inputs, the whole
// contract was refused as invalid, and the PM dispatched again with no scope at all. Contract paths here are spellings
// only: compiling and preflight read no disk, and Windows spellings follow Windows rules on every host.
describe('v0.9.101 A1: an input outside the workspace is a read the task needs, not an invalid contract', () => {
  const ROOT = 'C:\\work';
  const LEASE = 'C:\\contracts\\lease.docx';
  const input = (overrides: Record<string, unknown> = {}) => ({
    input_id: 'lease', kind: 'workspacePath', path: LEASE, purpose: 'The contract to summarise',
    required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] }, ...overrides,
  });

  it('compiles a v1 contract whose required source is an outside file, and keeps it a required input', () => {
    const compiled = compileTaskContract(proposal({
      inputs: [input()], constraints: [{ text: 'Keep every clause.', basis_refs: ['lease'] }],
    }), 'pm', ROOT);
    expect(compiled.error).toBeUndefined();
    expect(compiled.contract?.version).toBe(1);
    expect(compiled.contract?.inputs).toEqual([expect.objectContaining({
      inputId: 'lease', kind: 'workspacePath', path: LEASE, required: true, freshness: 'dispatch-snapshot',
    })]);
    expect(compiled.contract?.constraints[0].basisRefs).toEqual(['lease']);
    // Without a task scope nothing joins one: the file is read under the teammate's own reach.
    expect(compiled.contract?.effects.writeScope).toBeUndefined();
    // A share or device spelling is named as written.
    for (const share of ['\\\\203.0.113.7\\share\\lease.docx', '\\\\?\\UNC\\203.0.113.7\\share\\lease.docx', '\\\\.\\pipe\\lease']) {
      const named = compileTaskContract(proposal({ inputs: [input({ path: share })] }), 'pm', ROOT);
      expect(named.error, share).toBeUndefined();
      expect(named.contract?.inputs[0], share).toMatchObject({ path: share });
    }
  });

  it('still refuses a malformed path, an unknown field and an invalid reference, precisely', () => {
    const error = (raw: Record<string, unknown>) => compileTaskContract(raw, 'pm', ROOT).error;
    const malformed = 'contract.inputs[0].path must be relative and inside the workspace, or an absolute path.';
    expect(error(proposal({ inputs: [input({ path: '..\\contracts\\lease.docx' })] }))).toBe(malformed);
    expect(error(proposal({ inputs: [input({ path: 'docs/../../lease.docx' })] }))).toBe(malformed);
    expect(error(proposal({ inputs: [input({ path: '' })] }))).toBe(malformed);
    // With no workspace to judge it against, an absolute path names nothing.
    expect(compileTaskContract(proposal({ inputs: [input()] }), 'pm').error).toBe(malformed);
    expect(error(proposal({ inputs: [input({ scope: 'read' })] }))).toBe('contract.inputs[0] contains unsupported field "scope".');
    expect(error(proposal({ inputs: [input()], constraints: [{ text: 'Keep it.', basis_refs: ['annex'] }] })))
      .toBe('contract constraint basis_ref "annex" is not a declared input.');
    expect(error(proposal({ inputs: [input({ freshness: 'attempt-start' })] })))
      .toBe('workspacePath input "lease" freshness must be current or dispatch-snapshot.');
  });

  it('with a task scope, joins it as read once, beside the same file in read_files, and never as write or as its folder', () => {
    const compiled = compileTaskContract(proposal({
      effects: { read_files: [LEASE], write_scope: { folder_access: [{ path: 'C:\\out', permission: 'readwrite' }] }, expected_file_effect: 'create' },
      inputs: [
        input(),
        input({ input_id: 'annex', path: 'C:\\contracts\\annex.docx', required: false }),
        input({ input_id: 'annex-again', path: 'c:\\CONTRACTS\\annex.docx', required: false }),
        input({ input_id: 'old', path: 'C:\\out\\old.docx' }),
        input({ input_id: 'brief', path: 'docs\\brief.md', freshness: 'current' }),
      ],
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    }), 'pm', ROOT);
    expect(compiled.error).toBeUndefined();
    expect(compiled.contract?.effects.writeScope?.folderAccess).toEqual([
      { path: 'C:\\out', permission: 'readwrite' },
      { path: LEASE, permission: 'read' },
      { path: 'C:\\contracts\\annex.docx', permission: 'read' },
    ]);
    expect(compiled.contract?.effects.readFiles).toEqual([LEASE]);
    expect(compiled.contract?.inputs.map((entry) => entry.inputId)).toEqual(['lease', 'annex', 'annex-again', 'old', 'brief']);
  });

  it('leaves a v1 contract with a workspace input as it was', () => {
    const compiled = compileTaskContract(proposal({
      effects: { read_files: [], write_scope: { folder_access: [{ path: 'docs', permission: 'readwrite' }] }, expected_file_effect: 'modify' },
      inputs: [input({ path: 'C:\\work\\docs\\brief.md', freshness: 'current' })],
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    }), 'pm', ROOT);
    expect(compiled.error).toBeUndefined();
    expect(compiled.contract?.inputs[0]).toMatchObject({ path: 'docs/brief.md' });
    expect(compiled.contract?.effects.writeScope?.folderAccess).toEqual([{ path: 'docs', permission: 'readwrite' }]);
    // Its admission asks for no outside fact.
    const workspaceOnly = compile(proposal({ inputs: [input({ path: 'docs/brief.md', freshness: 'current' })] }));
    expect(preflightInputGrants(workspaceOnly, candidate('dev'))).toEqual({
      ok: true, failures: [], decisions: [{ inputId: 'lease', kind: 'workspacePath', sourceRef: 'docs/brief.md' }],
    });
  });

  it('admits it by the host\'s access fact, never by a read tool alone, and names each gap as what it is', () => {
    const contract = compileTaskContract(proposal({ inputs: [input()] }), 'pm', ROOT).contract!;
    const judge = (access?: OutsideInputAccess) =>
      preflightInputGrants(contract, candidate('dev', access ? { outsideInputs: { lease: access } } : {}));
    // A read tool and no fact from the host: not admitted.
    expect(judge().failures).toEqual([expect.objectContaining({ filter: 'input-grant', inputId: 'lease' })]);
    const gap = judge({ status: 'grant-needed' }).failures;
    expect(gap).toEqual([expect.objectContaining({ filter: 'grant-needed', inputId: 'lease' })]);
    expect(gap[0].reason).toContain('Grant access');
    expect(gap[0].reason).toContain('dispatch the same contract again');
    expect(gap[0].reason).not.toMatch(/not exist|not found|missing|no regular file/i);
    const limit = judge({ status: 'explicit-limit' }).failures;
    expect(limit).toEqual([expect.objectContaining({ filter: 'explicit-limit', inputId: 'lease' })]);
    expect(limit[0].reason).toContain('Folder Access');
    expect(limit[0].reason).not.toContain('Grant access');
    expect(judge({ status: 'missing-input' }).failures).toEqual([expect.objectContaining({ filter: 'missing-input', inputId: 'lease' })]);
    expect(judge({ status: 'readable', physical: LEASE })).toEqual({
      ok: true, failures: [], decisions: [{ inputId: 'lease', kind: 'workspacePath', sourceRef: LEASE }],
    });
    // An optional outside input that cannot be read is left out and does not stop the task.
    const optional = compileTaskContract(proposal({ inputs: [input({ required: false })] }), 'pm', ROOT).contract!;
    expect(preflightInputGrants(optional, candidate('dev', { outsideInputs: { lease: { status: 'grant-needed' } } })))
      .toEqual({ ok: true, failures: [], decisions: [] });
  });
});

// v0.9.101 (G1): a version 2 contract adds only outputs: results the task is to leave, as requirements, never grants.
// Paths are spellings here; the one disk observation (an output's existing kind) is replaced by a recorded probe.
describe('v0.9.101 G1: version 2 outputs are parsed strictly and change nothing in version 1', () => {
  const ROOT = 'C:\\work';
  const output = (overrides: Record<string, unknown> = {}) => ({
    output_id: 'summary', path: 'out\\summary.docx', kind: 'file', required: true, ...overrides,
  });
  const v2 = (overrides: Record<string, unknown> = {}) => proposal({
    version: 2,
    effects: { read_files: [], expected_file_effect: 'create' },
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    outputs: [output()],
    ...overrides,
  });
  const nothingThere = () => undefined;
  const error = (raw: Record<string, unknown>) => compileTaskContract(raw, 'pm', ROOT, nothingThere).error;

  it('compiles outputs by the read-file path rules: relative to the workspace, or an absolute path that only names a target', () => {
    const compiled = compileTaskContract(v2({ outputs: [
      output(),
      output({ output_id: 'pages', path: 'C:\\work\\out\\pages', kind: 'directory', required: false }),
      output({ output_id: 'copy', path: 'D:\\share out\\summary.docx' }),
    ] }), 'pm', ROOT, nothingThere);
    expect(compiled.error).toBeUndefined();
    expect(compiled.contract?.version).toBe(2);
    expect(compiled.contract?.outputs).toEqual([
      { outputId: 'summary', path: 'out/summary.docx', kind: 'file', required: true },
      { outputId: 'pages', path: 'out/pages', kind: 'directory', required: false },
      { outputId: 'copy', path: 'D:\\share out\\summary.docx', kind: 'file', required: true },
    ]);
    // A requirement, not a grant: no scope appears and none is widened.
    expect(compiled.contract?.effects.writeScope).toBeUndefined();
    expect(compileTaskContract(v2({ outputs: undefined }), 'pm', ROOT, nothingThere).contract?.outputs).toEqual([]);
    expect(error(v2({ outputs: [output({ path: '..\\summary.docx' })] })))
      .toBe('contract.outputs[0].path must be relative and inside the workspace, or an absolute path.');
  });

  it('bounds, identifies and strictly shapes each output', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => output({ output_id: `o${index}`, path: `out/${index}.md` }));
    expect(error(v2({ outputs: many(100) }))).toBeUndefined();
    expect(error(v2({ outputs: many(101) }))).toBe('contract.outputs may contain at most 100 entries.');
    expect(error(v2({ outputs: {} }))).toBe('contract.outputs must be an array.');
    expect(error(v2({ outputs: null }))).toBe('contract.outputs must be an array.');
    expect(error(v2({ outputs: [output(), output({ path: 'out/other.docx' })] }))).toBe('contract.outputs repeats output_id "summary".');
    expect(error(v2({ outputs: [output(), output({ output_id: 'again', path: 'C:\\WORK\\out\\summary.docx' })] })))
      .toBe('contract.outputs[1].path names the same target as output "summary".');
    expect(error(v2({ outputs: [output({ output_id: 'Summary' })] }))).toBe('contract.outputs[0].output_id is invalid.');
    expect(error(v2({ outputs: [output({ output_id: `s${'x'.repeat(80)}` })] }))).toBe('contract.outputs[0].output_id is invalid.');
    expect(error(v2({ outputs: [output({ format: 'docx' })] }))).toBe('contract.outputs[0] contains unsupported field "format".');
    expect(error(v2({ outputs: [output({ kind: 'folder' })] }))).toBe('contract.outputs[0].kind must be file or directory.');
    const { required: _required, ...noRequired } = output();
    expect(error(v2({ outputs: [noRequired] }))).toBe('contract.outputs[0].required must be boolean.');
    // An output is something the task writes: the write capability is declared, never inferred.
    expect(error(v2({ required_capabilities: { version: 1, capabilities: ['read'] }, effects: { read_files: [], expected_file_effect: 'none' } })))
      .toBe('contract.required_capabilities.capabilities must explicitly declare "write" for the declared file effects and outputs; the host will not infer or add it.');
  });

  it('refuses a kind that contradicts the existing target, and observes no share, device or /net path and nothing without a workspace', () => {
    const seen: string[] = [];
    const probe = (kind: 'file' | 'directory') => (absolute: string) => { seen.push(absolute); return kind; };
    const root = process.platform === 'win32' ? 'C:\\work' : '/work';
    const at = (target: string) => compileTaskContract(v2({ outputs: [output({ path: target })] }), 'pm', root, probe('directory'));
    expect(at('out/summary.docx').error).toBe('contract.outputs[0].kind is file, but out/summary.docx is an existing folder. '
      + 'Correct the kind or name the intended target; an output never stands for its folder or for a file in it.');
    expect(seen).toEqual([process.platform === 'win32' ? 'C:\\work\\out\\summary.docx' : '/work/out/summary.docx']);
    const asFolder = compileTaskContract(v2({ outputs: [output({ kind: 'directory', path: 'out' })] }), 'pm', root, probe('file'));
    expect(asFolder.error).toMatch(/^contract\.outputs\[0\]\.kind is directory, but out is an existing file\./);
    expect(compileTaskContract(v2({ outputs: [output({ kind: 'directory', path: 'out' })] }), 'pm', root, probe('directory')).error).toBeUndefined();

    seen.length = 0;
    const network = process.platform === 'win32'
      ? ['\\\\203.0.113.7\\share\\summary.docx', '\\\\?\\UNC\\203.0.113.7\\share\\summary.docx']
      : ['/net/203.0.113.7/summary.docx', '/NET/host/summary.docx'];
    for (const target of network) expect(at(target).error, target).toBeUndefined();
    expect(compileTaskContract(v2(), 'pm', undefined, probe('directory')).error).toBeUndefined();
    // Security re-audit (F4): an outside local path is not looked at either: its answer told the model whether a file or
    // folder exists outside every grant. Its kind is met when it is written.
    const outside = process.platform === 'win32' ? 'D:\\private\\summary.docx' : '/private/summary.docx';
    expect(at(outside).error).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('leaves version 1 as it was: no outputs field, no outputs key, the same contract', () => {
    expect(compileTaskContract(proposal({ outputs: [output()] }), 'pm', ROOT).error)
      .toBe('contract contains unsupported field "outputs". contract.outputs needs contract.version 2.');
    expect(compileTaskContract(proposal({ version: 3 }), 'pm', ROOT).error).toBe('contract.version must be 1 or 2.');
    const v1 = compileTaskContract(proposal({
      effects: { read_files: [], write_scope: { folder_access: [{ path: 'docs', permission: 'readwrite' }] }, expected_file_effect: 'modify' },
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    }), 'pm', ROOT).contract!;
    expect(v1.version).toBe(1);
    expect(v1).not.toHaveProperty('outputs');
    expect(taskReadinessIssues(v1, ROOT)).toEqual([]);
    const card = formatTaskAttemptCard({ attemptId: 'a', contractId: v1.contractId, agentId: 'dev', contract: v1, grants: [], baselineWorkspaceAuthority: 'narrowed-by-contract-scope' });
    expect(card).not.toContain('Outputs');
  });
});

describe('v0.9.101 G1: a required output must be inside the write part of the task scope the contract carries', () => {
  const ROOT = 'C:\\work';
  const scoped = (folderAccess: Array<{ path: string; permission: string }>, outputs: unknown[]) => compileTaskContract(proposal({
    version: 2,
    effects: { read_files: [], write_scope: { folder_access: folderAccess }, expected_file_effect: 'create' },
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    outputs,
  }), 'pm', ROOT, () => undefined).contract!;
  const summary = { output_id: 'summary', path: 'out/summary.docx', kind: 'file', required: true };

  it('is ready when a readwrite entry holds it, and names invalid-task-scope precisely when only a read entry or nothing does', () => {
    expect(taskReadinessIssues(scoped([{ path: 'out', permission: 'readwrite' }], [summary]), ROOT)).toEqual([]);
    expect(taskReadinessIssues(scoped([{ path: '.', permission: 'readwrite' }], [summary]), ROOT)).toEqual([]);
    expect(taskReadinessIssues(scoped([{ path: 'C:\\work\\out\\summary.docx', permission: 'readwrite' }], [summary]), ROOT)).toEqual([]);
    const readOnly = taskReadinessIssues(scoped([{ path: 'out', permission: 'read' }, { path: 'docs', permission: 'readwrite' }], [summary]), ROOT);
    expect(readOnly).toEqual([{
      requirementRef: 'output:summary',
      code: 'invalid-task-scope',
      reason: 'required output "summary" (out/summary.docx) is not inside a readwrite entry of contract.effects.write_scope, '
        + 'so the teammate could not write it. Add a readwrite entry that holds it, or leave write_scope out so the '
        + 'teammate\'s own access applies. The host neither widens the scope nor drops the output',
    }]);
    // The scope as it was written is kept: the output is not intersected away, and nothing is added to the scope.
    const contract = scoped([{ path: 'out', permission: 'read' }], [summary]);
    expect(contract.effects.writeScope?.folderAccess).toEqual([{ path: 'out', permission: 'read' }]);
    expect(contract.outputs).toEqual([{ outputId: 'summary', path: 'out/summary.docx', kind: 'file', required: true }]);
  });

  it('judges an outside output by the entry as resolved: `.` is the workspace, and an optional output is never an issue', () => {
    const outside = { output_id: 'copy', path: 'D:\\reports\\summary.docx', kind: 'file', required: true };
    expect(taskReadinessIssues(scoped([{ path: '.', permission: 'readwrite' }], [outside]), ROOT))
      .toEqual([expect.objectContaining({ requirementRef: 'output:copy', code: 'invalid-task-scope' })]);
    expect(taskReadinessIssues(scoped([{ path: 'D:\\reports', permission: 'readwrite' }], [outside]), ROOT)).toEqual([]);
    expect(taskReadinessIssues(scoped([{ path: 'docs', permission: 'readwrite' }], [{ ...summary, required: false }]), ROOT)).toEqual([]);
  });

  it('narrows nothing without a scope, and tells the teammate its outputs are requirements, not grants', () => {
    const contract = compileTaskContract(proposal({
      version: 2,
      effects: { read_files: [], expected_file_effect: 'create' },
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
      outputs: [summary, { output_id: 'pages', path: 'out/pages', kind: 'directory', required: false }],
    }), 'pm', ROOT, () => undefined).contract!;
    expect(taskReadinessIssues(contract, ROOT)).toEqual([]);
    expect(contract.effects.writeScope).toBeUndefined();
    const card = formatTaskAttemptCard({ attemptId: 'a', contractId: contract.contractId, agentId: 'dev', contract, grants: [], baselineWorkspaceAuthority: 'independent-agent-authority' });
    expect(card).toContain('Outputs (requirements, not grants: saving one uses your own write access, and a refused save is reported, not worked around):\n'
      + '- summary [file; required]: out/summary.docx\n- pages [directory; optional]: out/pages');
    expect(card).toContain('Write scope: agent baseline (not widened by this contract)');
  });
});
