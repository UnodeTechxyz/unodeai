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
  preflightInputGrants,
  resolveWorkspacePathIdentity,
  TaskInputResolver,
  type CandidateContractAgent,
  type EffectiveTaskContract,
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
      .toMatch(/contain only input_id/i);
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
    expect(refusal([fileInput], {})).toBe('contract.review must contain only input_id.');
    // One input only: a review cannot name a set of files.
    expect(refusal([fileInput, { ...fileInput, input_id: 'second', path: 'src/b.ts' }], { input_id: ['target', 'second'] }))
      .toBe('contract.review must contain only input_id.');
    expect(refusal([fileInput], { input_id: 'target', also: 'second' })).toBe('contract.review must contain only input_id.');
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
    expect(fileCard).toContain('Review evidence is optional.');

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
