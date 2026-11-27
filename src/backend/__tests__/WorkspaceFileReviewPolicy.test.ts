import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunLedger } from '../../observability/RunLedger';
import { createEffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';
import { admitUserTurn, attachment, attachmentIds, saveHost, sha } from './attachmentSaveFixtures';
import { solidScreenshotPng } from './presentationImageFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

it('reviews actual PM and worker binary commits by last current-byte writer, never an earlier comparable author', async () => {
  const ledger = new RunLedger(); let workspace = '';
  const models = new Map([['pm', 'chat-pm'], ['worker', 'chat-worker']]);
  const h = await saveHost({ turnId: agent => 'turn-' + agent,
    onEffect: effect => ledger.fileCommits.record(workspace, effect, models.get(effect.agentId)) });
  workspace = h.root;
  const pngs = [solidScreenshotPng(1, 1), solidScreenshotPng(2, 1)];
  const sources = await admitUserTurn(h.assets, pngs.map((png, index) => attachment(`source-${index}.png`, 'image/png', 'image', png)));
  const ids = attachmentIds(sources); const tools = [h.tools('pm', sources), h.tools('worker', sources)];
  const resolver = new TaskInputResolver(h.assets, h.root);
  resolver.setWorkspaceAuthorLookup((root, key, digest) => ledger.fileCommits.author(root, key, digest)?.reportedModelId);
  const strict = { version: 1 as const, requireDifferentReportedModelForArtifactReview: true };
  const recommended = { version: 2 as const, reviewMode: 'different-when-author-known' as const, requireDifferentReportedModelForArtifactReview: true };
  const reviewer = createEffectiveExecutionIdentity('chat-pm', 'review-route', 3);
  const save = async (agent: number, image: number) => {
    const saved = await tools[agent].run('save_attachment', { asset_id: ids[image], path: 'reviewed.png' });
    expect(saved.status, saved.output).toBe('success');
    expect(sha(await readFile(join(h.root, 'reviewed.png')))).toBe(sha(pngs[image]));
    await ledger.fileCommits.flush();
  };
  const facts = async () => {
    const compiled = compileTaskContract({ version: 1, objective: 'Review the current image.', expected_deliverable: 'Image review.',
      effects: { read_files: ['reviewed.png'], expected_file_effect: 'none' },
      inputs: [{ input_id: 'target', kind: 'workspacePath', path: 'reviewed.png', purpose: 'Actual review target', required: true,
        freshness: 'current', provenance: { kind: 'workspace', source_refs: [] } }], constraints: [], dependencies: [], review: { input_id: 'target' },
      required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required' }, 'pm', h.root);
    expect(compiled.error).toBeUndefined();
    const attempt = await resolver.beginAttempt(compiled.contract!, { agentId: 'reviewer', workspaceRoot: h.root, capabilities: { read: true, write: false, shell: false },
      taskScope: 'per-turn', verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [] }, 'pm');
    expect(attempt.error).toBeUndefined();
    return resolver.reviewPolicyFacts(attempt.card!.attemptId);
  };
  try {
    await save(0, 0); const pm = await facts();
    expect(pm.authorReportedModelId).toBe('chat-pm'); expect(pm.authorIdentity).toBeUndefined();
    expect(evaluateReviewPolicy({ ...pm, policy: strict, reviewerIdentity: reviewer }).code).toBe('refused-same-reported-model');
    await save(1, 1); const worker = await facts();
    expect(worker.authorReportedModelId).toBe('chat-worker');
    const different = evaluateReviewPolicy({ ...worker, policy: strict, reviewerIdentity: reviewer });
    expect(different.code).toBe('allowed-different-reported-model'); expect(different.comparison).toBeUndefined();
    // A later real write restores earlier bytes but has no reported identity: do not reuse the old PM author.
    models.delete('pm'); await save(0, 0); const unknown = await facts();
    expect(unknown.authorReportedModelId).toBeUndefined();
    expect(evaluateReviewPolicy({ ...unknown, policy: strict, reviewerIdentity: reviewer }).allowed).toBe(false);
    expect(evaluateReviewPolicy({ ...unknown, policy: recommended, reviewerIdentity: reviewer }).code).toBe('allowed-author-unknown');
    await writeFile(join(h.root, 'reviewed.png'), solidScreenshotPng(3, 1));
    expect((await facts()).authorReportedModelId).toBeUndefined();
  } finally { for (const tool of tools) tool.retire(); await h.assets.dispose(); }
});
