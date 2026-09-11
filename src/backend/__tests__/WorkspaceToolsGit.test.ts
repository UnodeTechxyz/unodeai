import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { ContentReceiptObservation } from '../../content/ContentReceipt';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { WorkspaceTools } from '../WorkspaceTools';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function makeTaggedRepository(parent: string): Promise<{ repository: string; commit: string }> {
  const repository = path.join(parent, 'RoamCrew');
  await fs.mkdir(repository);
  git(parent, ['init', repository]);
  git(repository, ['config', 'user.name', 'Unode test']);
  git(repository, ['config', 'user.email', 'unode-test@example.invalid']);
  await fs.writeFile(path.join(repository, 'source.ts'), 'export const version = "0.9.8";\n', 'utf8');
  git(repository, ['add', 'source.ts']);
  git(repository, ['commit', '-m', 'legacy source']);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['tag', '-a', 'v0.9.8', '-m', 'release v0.9.8']);
  return { repository, commit };
}

describe('WorkspaceTools.inspect_git_tag', () => {
  it('proves an annotated local tag through the read-root boundary without exposing shell access', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-git-read-'));
    const workspace = path.join(parent, 'unode');
    await fs.mkdir(workspace);
    const { repository, commit } = await makeTaggedRepository(parent);
    const tools = new WorkspaceTools(
      workspace,
      new Set(['read']),
      'a1',
      undefined, // coordinator
      undefined, // commandPolicy
      undefined, // commandTimeoutMs
      undefined, // requestApproval
      undefined, // bus
      undefined, // commandNormalizer
      undefined, // commandExecutor
      undefined, // checkpointRecorder
      undefined, // writeApprovalAsk
      undefined, // requestWriteApproval
      undefined, // memoryWriter
      undefined, // onOutsideRoot
      undefined, // sharedReadRoot
      [parent], // additionalReadRoots
    );
    const receipts: ContentReceiptObservation[] = [];
    const prompts: string[] = [];
    tools.setContentReceiptObserver((receipt) => receipts.push(receipt));
    tools.setLocalReadScopeAccess([parent], new SessionLocalReadScopeConsent(async (root) => {
      prompts.push(root);
      return true;
    }));

    try {
      expect(tools.specs().some((spec) => spec.function.name === 'inspect_git_tag')).toBe(true);
      const result = await tools.run('inspect_git_tag', { repository_path: repository, tag: 'v0.9.8' });
      expect(result.status).toBe('success');
      expect(result.output).toContain('Git tag verified:');
      expect(result.output).toContain(`Repository: ${repository}`);
      expect(result.output).toContain(`Commit: ${commit}`);
      expect(result.output).toContain('Subject: legacy source');
      expect(result.output).toContain('[local-scope receipt: local-scope-1; git-tag-inspection; 1 item]');
      expect(prompts).toEqual([parent]);
      expect(receipts).toEqual([
        { contentClass: 'local-scope', action: 'git-tag-inspection', rootId: 'local-scope-1', count: 1 },
      ]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses a repository outside configured read roots before invoking Git', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-git-workspace-'));
    const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-git-outside-'));
    const { repository } = await makeTaggedRepository(outsideParent);
    const tools = new WorkspaceTools(workspace, new Set(['read']));

    try {
      await expect(tools.run('inspect_git_tag', { repository_path: repository, tag: 'v0.9.8' }))
        .resolves.toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outsideParent, { recursive: true, force: true });
    }
  });

  it('never treats a revision expression as a tag name', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-git-tag-name-'));
    const tools = new WorkspaceTools(workspace, new Set(['read']));
    try {
      const result = await tools.run('inspect_git_tag', { repository_path: workspace, tag: 'HEAD^{commit}' });
      expect(result.status).toBe('failed');
      expect(result.output).toMatch(/simple Git tag name/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
