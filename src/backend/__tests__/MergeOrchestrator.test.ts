import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { GitMergeOrchestrator } from '../MergeOrchestrator';
import { WorktreeManager } from '../WorktreeManager';
import type { GitRunner, Worktree } from '../WorktreeManager';

async function tempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-merge-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), 'hi\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

function gitStatus(cwd: string): string {
  return git(cwd, ['status', '--porcelain']).trim();
}

async function readLf(file: string): Promise<string> {
  return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
}

describe('GitMergeOrchestrator', () => {
  it.each([
    ['已经是最新的。', 'same-head', 'same-head', 'nothing'],
    ['Déjà à jour.', 'same-head', 'same-head', 'nothing'],
    ['任意本地化输出', 'before-head', 'after-head', 'merged'],
  ] as const)('uses integration HEAD movement when merge says %s', async (message, before, after, expected) => {
    let headReads = 0;
    const runner: GitRunner = async (args) => {
      if (args.includes('merge-base')) return { code: 1, stdout: '', stderr: '' };
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: `${headReads++ === 0 ? before : after}\n`, stderr: '' };
      }
      if (args.includes('merge')) return { code: 0, stdout: `${message}\n`, stderr: '' };
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    };
    const orchestrator = new GitMergeOrchestrator('repo', { git: runner });
    orchestrator.ensureIntegration = async () => undefined;
    const worktree: Worktree = { path: 'worker', branch: 'unode/worker' };

    await expect(orchestrator.mergeToIntegration(worktree)).resolves.toMatchObject({ status: expected });
  });

  it('merges different agent worktrees into the integration worktree', async () => {
    const root = await tempRepo();
    try {
      const wm = new WorktreeManager(root);
      const orchestrator = new GitMergeOrchestrator(root);
      const a = await wm.create({ name: 'agent-a', branch: 'unode/agent-a' });
      const b = await wm.create({ name: 'agent-b', branch: 'unode/agent-b' });

      await fs.writeFile(path.join(a.path, 'a.txt'), 'from a\n');
      await fs.writeFile(path.join(b.path, 'b.txt'), 'from b\n');

      expect(await orchestrator.commitWorktree(a, 'agent a')).toBe(true);
      expect(await orchestrator.commitWorktree(b, 'agent b')).toBe(true);

      expect((await orchestrator.mergeToIntegration(a)).status).toBe('merged');
      expect((await orchestrator.mergeToIntegration(b)).status).toBe('merged');

      const integration = path.join(root, '.unode', 'worktrees', '_integration');
      await expect(readLf(path.join(integration, 'a.txt'))).resolves.toBe('from a\n');
      await expect(readLf(path.join(integration, 'b.txt'))).resolves.toBe('from b\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('aborts conflicts and leaves integration clean', async () => {
    const root = await tempRepo();
    try {
      const wm = new WorktreeManager(root);
      const orchestrator = new GitMergeOrchestrator(root);
      const a = await wm.create({ name: 'agent-a', branch: 'unode/conflict-a' });
      const b = await wm.create({ name: 'agent-b', branch: 'unode/conflict-b' });

      await fs.writeFile(path.join(a.path, 'README.md'), 'from a\n');
      await fs.writeFile(path.join(b.path, 'README.md'), 'from b\n');

      expect(await orchestrator.commitWorktree(a, 'agent a')).toBe(true);
      expect(await orchestrator.commitWorktree(b, 'agent b')).toBe(true);
      expect((await orchestrator.mergeToIntegration(a)).status).toBe('merged');

      const result = await orchestrator.mergeToIntegration(b);
      expect(result.status).toBe('conflict');
      expect(result.conflictedFiles).toContain('README.md');

      const integration = path.join(root, '.unode', 'worktrees', '_integration');
      expect(gitStatus(integration)).toBe('');
      await expect(readLf(path.join(integration, 'README.md'))).resolves.toBe('from a\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('returns false when committing a clean worktree', async () => {
    const root = await tempRepo();
    try {
      const wm = new WorktreeManager(root);
      const orchestrator = new GitMergeOrchestrator(root);
      const wt = await wm.create({ name: 'clean-agent', branch: 'unode/clean-agent' });

      await expect(orchestrator.commitWorktree(wt, 'clean')).resolves.toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('returns nothing when a branch has no new commits for integration', async () => {
    const root = await tempRepo();
    try {
      const wm = new WorktreeManager(root);
      const orchestrator = new GitMergeOrchestrator(root);
      const wt = await wm.create({ name: 'empty-agent', branch: 'unode/empty-agent' });

      const result = await orchestrator.mergeToIntegration(wt);
      expect(result.status).toBe('nothing');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load

  it('finalizes integration by advancing the base branch', async () => {
    const root = await tempRepo();
    try {
      const wm = new WorktreeManager(root);
      const orchestrator = new GitMergeOrchestrator(root);
      const wt = await wm.create({ name: 'final-agent', branch: 'unode/final-agent' });

      await fs.writeFile(path.join(wt.path, 'final.txt'), 'approved\n');
      expect(await orchestrator.commitWorktree(wt, 'final work')).toBe(true);
      expect((await orchestrator.mergeToIntegration(wt)).status).toBe('merged');

      const result = await orchestrator.finalizeToBase('main');
      expect(result.status).toBe('merged');
      expect(git(root, ['show', 'main:final.txt'])).toBe('approved\n');
      expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // real-git: many spawns (init/worktree add/merge) — slow on Windows under parallel load
});
