/*---------------------------------------------------------------------------------------------
 *  UnodeAi - WorktreeManager (v0.6.x worktree fan-out, Slice A)
 *  Lifecycle for per-agent git worktrees under .unode/worktrees/ — the isolation substrate that lets
 *  parallel agents edit without stomping each other's branch. Pure git wrapper: no agent-lifecycle
 *  coupling, so it's unit-testable against a throwaway repo. Wiring into the session lives elsewhere.
 *
 *  Windows-first concerns handled here: git index-writing ops are serialized (avoids `index.lock`
 *  races on concurrent `worktree add`), worktrees get short friendly names (path-length), and the
 *  worktrees dir is added to .git/info/exclude (local-only, never committed — Kilo's trick).
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface Worktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Which agent owns it (set by the caller; not parsed from git). */
  agentId?: string;
}

/** Injectable git runner so the manager is testable without a real git on some paths. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Relative location of per-agent worktrees inside the repo (mirrors Kilo's `.kilo/worktrees/`). */
export const WORKTREES_DIR = path.join('.unode', 'worktrees');

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });

export class WorktreeManager {
  // Serializes git index-writing ops (add/remove) to avoid `index.lock` contention when several
  // agents spawn at once. Reads (list/status) don't need it.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly repoRoot: string, private readonly git: GitRunner = defaultGitRunner) {}

  /** True if repoRoot is inside a git work tree. */
  async isGitRepo(): Promise<boolean> {
    const r = await this.git(['rev-parse', '--is-inside-work-tree'], this.repoRoot);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  /**
   * True if the main work tree has no in-flight work that would be MISSING from a fresh worktree branched
   * off HEAD — i.e. no modified/staged tracked files AND no genuinely-untracked source files. We count
   * untracked files (a freshly-created `src/app.js` that was never committed does NOT exist in a new
   * worktree, so isolating an agent there breaks its edits with "outside working folder" — better to fall
   * back to the shared workspace). We DO ignore Roam/editor state dirs (`.unode/`, `.vscode/`), which are
   * commonly untracked but don't affect branching a worktree. (.gitignored files never show here.)
   */
  async isClean(): Promise<boolean> {
    const r = await this.git(['status', '--porcelain'], this.repoRoot);
    if (r.code !== 0) {
      return false;
    }
    const significant = r.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .filter((l) => {
        // porcelain v1: "XY <path>"; strip the 2-char status + space, and any surrounding quotes.
        const p = l.slice(3).replace(/^"|"$/g, '');
        return !p.startsWith('.unode/') && !p.startsWith('.vscode/');
      });
    return significant.length === 0;
  }

  /**
   * Create a worktree at `.unode/worktrees/<name>` on a new branch. Defaults: a short friendly name
   * and `unode/<name>` branch off HEAD. Serialized against other create/remove calls.
   */
  async create(opts: { name?: string; branch?: string; baseRef?: string; agentId?: string } = {}): Promise<Worktree> {
    return this.serializeWrite(async () => {
      const name = opts.name ?? friendlyName();
      const branch = opts.branch ?? `unode/${name}`;
      const abs = path.join(this.repoRoot, WORKTREES_DIR, name);
      await this.ensureExcluded();
      const args = ['worktree', 'add', '-b', branch, abs];
      if (opts.baseRef) { args.push(opts.baseRef); }
      const r = await this.git(args, this.repoRoot);
      if (r.code !== 0) {
        throw new Error(`git worktree add failed for "${name}": ${(r.stderr || r.stdout).trim()}`);
      }
      return { path: abs, branch, agentId: opts.agentId };
    });
  }

  /** List existing worktrees (including the main one). */
  async list(): Promise<Worktree[]> {
    const r = await this.git(['worktree', 'list', '--porcelain'], this.repoRoot);
    if (r.code !== 0) { return []; }
    return parseWorktreeList(r.stdout);
  }

  /** Remove a worktree. `force` drops it even with uncommitted/untracked changes inside. `pruneBranch`
   *  (only meaningful when given a Worktree) also deletes its branch, so re-creating an agent with the
   *  same name later doesn't fail on `git worktree add -b`. */
  async remove(target: string | Worktree, opts: { force?: boolean; pruneBranch?: boolean } = {}): Promise<void> {
    return this.serializeWrite(async () => {
      const wtPath = typeof target === 'string' ? target : target.path;
      const args = ['worktree', 'remove', wtPath];
      if (opts.force) { args.push('--force'); }
      const r = await this.git(args, this.repoRoot);
      if (r.code !== 0) {
        throw new Error(`git worktree remove failed for "${wtPath}": ${(r.stderr || r.stdout).trim()}`);
      }
      // Best-effort branch cleanup (audit #1): leftover unode/<name> branches are otherwise orphaned and
      // collide with a later same-name `worktree add -b`. Ignore failure — an extra branch is harmless.
      if (opts.pruneBranch && typeof target !== 'string' && target.branch) {
        await this.git(['branch', '-D', target.branch], this.repoRoot);
      }
    });
  }

  /** Chain git-writing ops so two concurrent creates can't collide on .git/index.lock. */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Add `.unode/worktrees/` to the common git exclude so the worktree dirs never show as untracked. */
  private async ensureExcluded(): Promise<void> {
    const gitDir = await this.git(['rev-parse', '--git-common-dir'], this.repoRoot);
    const rawDir = gitDir.code === 0 && gitDir.stdout.trim() ? gitDir.stdout.trim() : path.join(this.repoRoot, '.git');
    const absGitDir = path.isAbsolute(rawDir) ? rawDir : path.join(this.repoRoot, rawDir);
    const excludePath = path.join(absGitDir, 'info', 'exclude');
    const line = `${WORKTREES_DIR.replace(/\\/g, '/')}/`;
    try {
      let content = '';
      try { content = await fs.readFile(excludePath, 'utf8'); } catch { /* file may not exist yet */ }
      if (content.split(/\r?\n/).includes(line)) { return; }
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      await fs.writeFile(excludePath, `${content}${sep}${line}\n`);
    } catch {
      /* best-effort: a missing .git/info/exclude just means the dirs show as untracked, not fatal */
    }
  }
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  const flush = () => { if (cur.path) { out.push({ path: cur.path, branch: cur.branch ?? '' }); } cur = {}; };
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { flush(); cur.path = line.slice('worktree '.length); }
    else if (line.startsWith('branch ')) { cur.branch = line.slice('branch '.length).replace('refs/heads/', ''); }
    else if (line.trim() === '') { flush(); }
  }
  flush();
  return out;
}

const ADJECTIVES = ['sunny', 'calm', 'brave', 'swift', 'quiet', 'bright', 'bold', 'keen', 'warm', 'clever'];
const NOUNS = ['cloud', 'river', 'peak', 'forest', 'harbor', 'meadow', 'ember', 'tide', 'grove', 'summit'];

/** Short, human-readable, collision-resistant worktree name (e.g. "sunny-cloud-9f3a"). */
export function friendlyName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${a}-${n}-${suffix}`;
}
