/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MergeOrchestrator (v0.6.x worktree fan-out, Slice C) — CONTRACT
 *  The differentiator: after an isolated agent finishes in its worktree, commit its branch, merge it
 *  into a shared `unode/integration` staging branch (so the PM reviews the COMBINED result, and `main`
 *  gets one clean merge), surface conflicts for agent/PM resolution, and finalize integration → base
 *  on approval.
 *
 *  This file is the FROZEN INTERFACE (Claude). The `GitMergeOrchestrator` IMPLEMENTATION + unit tests
 *  are implemented separately. Don't change the interface without coordinating — Slice B wires the call
 *  sites against it.
 *
 *  Key mechanic (so the user's checkout is never disturbed): merges happen in a DEDICATED integration
 *  worktree (`.unode/worktrees/_integration`, checked out to `unode/integration`) via `git -C`, NOT in
 *  the main checkout. Conflicts are detected and `git merge --abort`ed, leaving integration clean.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs, realpathSync } from 'fs';
import * as path from 'path';
import { GitRunner, Worktree, WORKTREES_DIR } from './WorktreeManager';

export type MergeStatus = 'merged' | 'conflict' | 'nothing' | 'error';

export interface MergeResult {
  status: MergeStatus;
  /** The agent branch that was merged (or attempted). */
  branch: string;
  /** The staging branch merges land on (default `unode/integration`). */
  integrationBranch: string;
  /** On `conflict`: the files with merge conflicts (workspace-relative), for agent/PM feedback. */
  conflictedFiles?: string[];
  /** Human/agent-readable summary (surfaced to the PM or the agent). */
  message: string;
}

export interface MergeOrchestrator {
  /**
   * Ensure the integration branch + its dedicated worktree exist. Created off `baseRef` (default the
   * repo's current branch / HEAD) on first use. Idempotent.
   */
  ensureIntegration(baseRef?: string): Promise<void>;

  /**
   * Stage + commit everything in the agent's worktree on its own branch. Returns `false` (no error)
   * when the worktree is clean (nothing to commit).
   */
  commitWorktree(worktree: Worktree, message: string): Promise<boolean>;

  /**
   * Merge the agent's branch into the integration branch (in the integration worktree, `--no-ff`).
   * On conflict: abort the merge (leaving integration clean) and return `status:'conflict'` with the
   * conflicted files. `status:'nothing'` when the branch has no commits beyond integration.
   */
  mergeToIntegration(worktree: Worktree): Promise<MergeResult>;

  /**
   * The approval step: merge the integration branch into `baseRef` (default the original base branch).
   * Fast-forward when possible. Returns the result; does not remove worktrees (caller does cleanup).
   */
  finalizeToBase(baseRef?: string): Promise<MergeResult>;
}

/**
 * Git-backed implementation. **Stub — to be implemented by Codex** (see the task card). Constructor
 * shape is part of the contract; method bodies are placeholders that throw until implemented.
 */
export class GitMergeOrchestrator implements MergeOrchestrator {
  private readonly integrationBranch: string;
  private readonly git: GitRunner;
  private readonly integrationPath: string;
  private originalBaseRef: string | undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly opts: { integrationBranch?: string; git?: GitRunner } = {}
  ) {
    this.integrationBranch = opts.integrationBranch ?? 'unode/integration';
    this.git = opts.git ?? defaultGitRunner;
    this.integrationPath = path.join(repoRoot, WORKTREES_DIR, '_integration');
  }

  async ensureIntegration(baseRef?: string): Promise<void> {
    const base = baseRef ?? this.originalBaseRef ?? await this.currentBranch();
    this.originalBaseRef = base;
    await this.ensureExcluded();

    const branchRef = `refs/heads/${this.integrationBranch}`;
    const hasBranch = await this.git(['show-ref', '--verify', '--quiet', branchRef], this.repoRoot);
    if (hasBranch.code !== 0) {
      const created = await this.git(['branch', this.integrationBranch, base], this.repoRoot);
      if (created.code !== 0) {
        throw new Error(`Failed to create integration branch "${this.integrationBranch}": ${gitMessage(created)}`);
      }
    }

    if (await this.hasIntegrationWorktree()) {
      return;
    }
    const added = await this.git(['worktree', 'add', this.integrationPath, this.integrationBranch], this.repoRoot);
    if (added.code !== 0) {
      throw new Error(`Failed to create integration worktree "${this.integrationPath}": ${gitMessage(added)}`);
    }
  }

  async commitWorktree(worktree: Worktree, message: string): Promise<boolean> {
    const added = await this.git(['-C', worktree.path, 'add', '-A'], this.repoRoot);
    if (added.code !== 0) {
      throw new Error(`Failed to stage worktree "${worktree.path}": ${gitMessage(added)}`);
    }
    const status = await this.git(['-C', worktree.path, 'status', '--porcelain'], this.repoRoot);
    if (status.code !== 0) {
      throw new Error(`Failed to inspect worktree "${worktree.path}": ${gitMessage(status)}`);
    }
    if (status.stdout.trim() === '') {
      return false;
    }
    const committed = await this.git([
      '-C', worktree.path,
      '-c', 'user.name=UnodeAi',
      '-c', 'user.email=unodeai@example.invalid',
      'commit',
      '-m',
      message,
    ], this.repoRoot);
    if (committed.code !== 0) {
      throw new Error(`Failed to commit worktree "${worktree.path}": ${gitMessage(committed)}`);
    }
    return true;
  }

  async mergeToIntegration(worktree: Worktree): Promise<MergeResult> {
    await this.ensureIntegration();
    const alreadyMerged = await this.git([
      '-C', this.integrationPath,
      'merge-base',
      '--is-ancestor',
      worktree.branch,
      this.integrationBranch,
    ], this.repoRoot);
    if (alreadyMerged.code === 0) {
      return {
        status: 'nothing',
        branch: worktree.branch,
        integrationBranch: this.integrationBranch,
        message: `${worktree.branch} is already included in ${this.integrationBranch}.`,
      };
    }

    const beforeMerge = await this.git(['-C', this.integrationPath, 'rev-parse', 'HEAD'], this.repoRoot);
    if (beforeMerge.code !== 0) {
      return {
        status: 'error',
        branch: worktree.branch,
        integrationBranch: this.integrationBranch,
        message: `Failed to observe ${this.integrationBranch} before merge: ${gitMessage(beforeMerge)}`,
      };
    }

    const merged = await this.git([
      '-C', this.integrationPath,
      '-c', 'user.name=UnodeAi',
      '-c', 'user.email=unodeai@example.invalid',
      'merge',
      '--no-ff',
      worktree.branch,
    ], this.repoRoot);
    const output = gitMessage(merged);
    if (merged.code === 0) {
      const afterMerge = await this.git(['-C', this.integrationPath, 'rev-parse', 'HEAD'], this.repoRoot);
      if (afterMerge.code !== 0) {
        return {
          status: 'error',
          branch: worktree.branch,
          integrationBranch: this.integrationBranch,
          message: `Merge completed but ${this.integrationBranch} could not be observed afterwards: ${gitMessage(afterMerge)}`,
        };
      }
      return {
        status: beforeMerge.stdout.trim() === afterMerge.stdout.trim() ? 'nothing' : 'merged',
        branch: worktree.branch,
        integrationBranch: this.integrationBranch,
        message: output || (beforeMerge.stdout.trim() === afterMerge.stdout.trim()
          ? `${worktree.branch} has nothing new to merge.`
          : `Merged ${worktree.branch} into ${this.integrationBranch}.`),
      };
    }

    const conflictedFiles = await this.conflictedFiles();
    if (conflictedFiles.length > 0) {
      await this.git(['-C', this.integrationPath, 'merge', '--abort'], this.repoRoot);
      return {
        status: 'conflict',
        branch: worktree.branch,
        integrationBranch: this.integrationBranch,
        conflictedFiles,
        message: output || `Merge conflict while merging ${worktree.branch}.`,
      };
    }
    return {
      status: 'error',
      branch: worktree.branch,
      integrationBranch: this.integrationBranch,
      message: output || `Failed to merge ${worktree.branch} into ${this.integrationBranch}.`,
    };
  }

  async finalizeToBase(baseRef?: string): Promise<MergeResult> {
    await this.ensureIntegration(baseRef);
    const base = baseRef ?? this.originalBaseRef ?? await this.currentBranch();

    const alreadyIncluded = await this.git([
      '-C', this.integrationPath,
      'merge-base',
      '--is-ancestor',
      this.integrationBranch,
      base,
    ], this.repoRoot);
    if (alreadyIncluded.code === 0) {
      return {
        status: 'nothing',
        branch: base,
        integrationBranch: this.integrationBranch,
        message: `${base} already includes ${this.integrationBranch}.`,
      };
    }

    const canFastForward = await this.git([
      '-C', this.integrationPath,
      'merge-base',
      '--is-ancestor',
      base,
      this.integrationBranch,
    ], this.repoRoot);
    if (canFastForward.code !== 0) {
      const mergedBase = await this.git([
        '-C', this.integrationPath,
        '-c', 'user.name=UnodeAi',
        '-c', 'user.email=unodeai@example.invalid',
        'merge',
        '--no-ff',
        base,
      ], this.repoRoot);
      if (mergedBase.code !== 0) {
        const conflictedFiles = await this.conflictedFiles();
        if (conflictedFiles.length > 0) {
          await this.git(['-C', this.integrationPath, 'merge', '--abort'], this.repoRoot);
          return {
            status: 'conflict',
            branch: base,
            integrationBranch: this.integrationBranch,
            conflictedFiles,
            message: gitMessage(mergedBase) || `Conflict while finalizing ${this.integrationBranch} to ${base}.`,
          };
        }
        return {
          status: 'error',
          branch: base,
          integrationBranch: this.integrationBranch,
          message: gitMessage(mergedBase) || `Failed to merge ${base} into ${this.integrationBranch}.`,
        };
      }
    }

    // integration now contains base, so base can fast-forward to it. If base is the branch checked out
    // in the MAIN worktree (the common case — the user is on it), fast-forward THERE so the working
    // tree materializes the merged files atomically (git refuses if the tree is dirty, protecting the
    // user). update-ref would advance the ref without touching the work tree, leaving the files as
    // phantom "deleted" until a manual reset — so only use it when base isn't the live checkout.
    const current = await this.currentBranch();
    if (current === base) {
      const ff = await this.git(['-C', this.repoRoot, 'merge', '--ff-only', this.integrationBranch], this.repoRoot);
      if (ff.code !== 0) {
        return {
          status: 'error',
          branch: base,
          integrationBranch: this.integrationBranch,
          message: gitMessage(ff) || `Failed to fast-forward ${base} to ${this.integrationBranch} (uncommitted changes on ${base}?).`,
        };
      }
      return {
        status: 'merged',
        branch: base,
        integrationBranch: this.integrationBranch,
        message: `Fast-forwarded ${base} to ${this.integrationBranch}.`,
      };
    }

    // base isn't checked out in the main worktree → just advance its ref (whoever has it elsewhere can refresh).
    const integrationHead = await this.git(['-C', this.integrationPath, 'rev-parse', this.integrationBranch], this.repoRoot);
    if (integrationHead.code !== 0) {
      return {
        status: 'error',
        branch: base,
        integrationBranch: this.integrationBranch,
        message: gitMessage(integrationHead) || `Failed to resolve ${this.integrationBranch}.`,
      };
    }
    const updated = await this.git(['-C', this.integrationPath, 'update-ref', this.branchRef(base), integrationHead.stdout.trim()], this.repoRoot);
    if (updated.code !== 0) {
      return {
        status: 'error',
        branch: base,
        integrationBranch: this.integrationBranch,
        message: gitMessage(updated) || `Failed to advance ${base} to ${this.integrationBranch}.`,
      };
    }
    return {
      status: 'merged',
      branch: base,
      integrationBranch: this.integrationBranch,
      message: `Advanced ${base} to ${this.integrationBranch}.`,
    };
  }

  private async currentBranch(): Promise<string> {
    const r = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], this.repoRoot);
    if (r.code !== 0) {
      throw new Error(`Failed to resolve current branch: ${gitMessage(r)}`);
    }
    return r.stdout.trim() || 'HEAD';
  }

  private async hasIntegrationWorktree(): Promise<boolean> {
    const r = await this.git(['worktree', 'list', '--porcelain'], this.repoRoot);
    if (r.code !== 0) {
      return false;
    }
    const wanted = path.resolve(this.integrationPath);
    return r.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length)))
      .some((p) => samePath(p, wanted));
  }

  private async conflictedFiles(): Promise<string[]> {
    const conflicts = await this.git(['-C', this.integrationPath, 'diff', '--name-only', '--diff-filter=U'], this.repoRoot);
    if (conflicts.code !== 0) {
      return [];
    }
    return conflicts.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  private async ensureExcluded(): Promise<void> {
    const gitDir = await this.git(['rev-parse', '--git-common-dir'], this.repoRoot);
    const rawDir = gitDir.code === 0 && gitDir.stdout.trim() ? gitDir.stdout.trim() : path.join(this.repoRoot, '.git');
    const absGitDir = path.isAbsolute(rawDir) ? rawDir : path.join(this.repoRoot, rawDir);
    const excludePath = path.join(absGitDir, 'info', 'exclude');
    const line = `${WORKTREES_DIR.replace(/\\/g, '/')}/`;
    try {
      let content = '';
      try { content = await fs.readFile(excludePath, 'utf8'); } catch { /* may not exist yet */ }
      if (content.split(/\r?\n/).includes(line)) {
        return;
      }
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      await fs.writeFile(excludePath, `${content}${sep}${line}\n`);
    } catch {
      /* best effort only: this should never block merge orchestration */
    }
  }

  private branchRef(branch: string): string {
    return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  }
}

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

function gitMessage(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim();
}

// Resolve to the real on-disk path so that 8.3 short names (e.g. C:\Users\ADMINI~1) and their long
// form (C:\Users\Administrator) compare equal — git canonicalizes worktree paths to the long form in
// `worktree list`, while a path built from os.tmpdir() may still be the short form. Falls back to a
// plain resolve when the path doesn't exist yet (realpath would throw).
function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  return process.platform === 'win32' ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}
