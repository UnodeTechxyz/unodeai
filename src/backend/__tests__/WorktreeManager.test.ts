import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { WorktreeManager, parseWorktreeList, friendlyName } from '../WorktreeManager';

async function tempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-wt-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: root });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), 'hi\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return root;
}

describe('WorktreeManager (real git)', () => {
  it('detects a git repo; clean ignores .unode/.vscode but counts untracked source + modified tracked', async () => {
    const root = await tempRepo();
    const wm = new WorktreeManager(root);
    expect(await wm.isGitRepo()).toBe(true);
    expect(await wm.isClean()).toBe(true);
    // Roam/editor state dirs are untracked but don't affect a worktree → still clean.
    await fs.mkdir(path.join(root, '.unode'), { recursive: true });
    await fs.writeFile(path.join(root, '.unode', 'team.json'), '{}');
    await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{}');
    expect(await wm.isClean()).toBe(true);
    // A genuinely-untracked SOURCE file WOULD be missing from a new worktree → NOT clean (the fix).
    await fs.writeFile(path.join(root, 'app.js'), 'new');
    expect(await wm.isClean()).toBe(false);
    await fs.rm(path.join(root, 'app.js'), { force: true });
    // A modified TRACKED file also counts — real in-flight work.
    await fs.writeFile(path.join(root, 'README.md'), 'changed\n');
    expect(await wm.isClean()).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a worktree under .unode/worktrees/, lists it, and removes it', async () => {
    const root = await tempRepo();
    const wm = new WorktreeManager(root);

    const wt = await wm.create({ name: 'feature-x', agentId: 'a1' });
    expect(wt.branch).toBe('unode/feature-x');
    expect(wt.agentId).toBe('a1');
    expect(wt.path).toContain(path.join('.unode', 'worktrees', 'feature-x'));
    expect((await fs.stat(wt.path)).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(wt.path, 'README.md'))).isFile()).toBe(true); // branched off HEAD

    const list = await wm.list();
    expect(list.some((w) => w.path.replace(/\\/g, '/').endsWith('worktrees/feature-x'))).toBe(true);

    // .git/info/exclude got the worktrees dir
    const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.unode/worktrees/');

    await wm.remove(wt, { force: true });
    expect(list.length).toBeGreaterThanOrEqual(2); // main + feature-x existed before removal
    await fs.rm(root, { recursive: true, force: true });
  });

  it('pruneBranch deletes the branch on remove so the same name can be re-created (audit #1)', async () => {
    const root = await tempRepo();
    const wm = new WorktreeManager(root);
    const branchList = () => spawnSync('git', ['branch', '--list', 'unode/feature-x'], { cwd: root, encoding: 'utf8' }).stdout ?? '';

    const wt = await wm.create({ name: 'feature-x' });
    expect(branchList()).toContain('unode/feature-x');

    // Without pruning, the branch lingers and re-creating the same name fails on `worktree add -b`.
    await wm.remove(wt, { force: true, pruneBranch: true });
    expect(branchList().trim()).toBe(''); // branch gone

    // Re-creating with the same name now succeeds (the bug: it used to throw "branch already exists").
    const again = await wm.create({ name: 'feature-x' });
    expect((await fs.stat(again.path)).isDirectory()).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('serializes concurrent creates without index.lock collisions', async () => {
    const root = await tempRepo();
    const wm = new WorktreeManager(root);
    const wts = await Promise.all([wm.create(), wm.create(), wm.create()]);
    expect(new Set(wts.map((w) => w.path)).size).toBe(3); // three distinct worktrees, all created
    for (const w of wts) { expect((await fs.stat(w.path)).isDirectory()).toBe(true); }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports not-a-git-repo for a bare directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-nogit-'));
    const wm = new WorktreeManager(dir);
    expect(await wm.isGitRepo()).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('WorktreeManager exclude path', () => {
  it('uses git common-dir instead of assuming .git is a directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-wt-common-'));
    const common = path.join(root, 'actual-git-dir');
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { code: 0, stdout: common, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        await fs.mkdir(args[4], { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    try {
      const wm = new WorktreeManager(root, git);
      await wm.create({ name: 'feature-x' });
      const exclude = await fs.readFile(path.join(common, 'info', 'exclude'), 'utf8');
      expect(exclude).toContain('.unode/worktrees/');
      expect(calls.some((args) => args.join(' ') === 'rev-parse --git-common-dir')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('parseWorktreeList', () => {
  it('parses porcelain output', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/.unode/worktrees/sunny-cloud',
      'HEAD def',
      'branch refs/heads/unode/sunny-cloud',
      '',
    ].join('\n');
    const list = parseWorktreeList(porcelain);
    expect(list).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/repo/.unode/worktrees/sunny-cloud', branch: 'unode/sunny-cloud' },
    ]);
  });
});

describe('friendlyName', () => {
  it('is short, kebab, and varied', () => {
    const a = friendlyName();
    expect(a).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    expect(friendlyName()).not.toBe(a); // suffix makes collisions vanishingly unlikely
  });
});
