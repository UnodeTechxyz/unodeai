/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Git state of one write target (v0.9.97)
 *  Asked only when a structured change is about to act on a file or folder that exists, and only for that path.
 *  Nothing here lists the repository, and nothing here runs when a request starts.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as path from 'path';
import { resolveHostExecutable } from '../security/HostExecutableResolver';
import { sanitizedCommandEnv } from './commandEnv';

/** What Git says about a path under it. A path Git lists under no entry is tracked and unchanged. */
export interface GitPathEntry {
  /** Absolute; a folder entry ends where its files begin and stands for every file below it. */
  path: string;
  folder: boolean;
  state: 'changed' | 'untracked' | 'ignored';
}

export type GitPathReport =
  | { repository: false }
  | { repository: true; entries: readonly GitPathEntry[] }
  /** Git could not be asked or did not answer: the path is treated as one outside Git, which proves the least. */
  | { repository: 'unknown'; reason: string };

/** Asked for one file, or for one folder that is about to be deleted. */
export type GitPathProbe = (target: string, kind: 'file' | 'directory') => Promise<GitPathReport>;

const GIT_PATH_TIMEOUT_MS = 5_000;
const GIT_PATH_MAX_OUTPUT = 1024 * 1024;

/**
 * The Git state of exactly `target`. For a file, one `git status` limited to that file; for a folder, its
 * top-level folder and one `git status` limited to the folder. Pathspecs are literal, so a name with `*` or `[`
 * names itself. The file-system monitor a repository may configure is switched off, and no safe.directory is
 * added: a repository Git does not trust answers nothing, and the target is then judged as outside Git.
 */
export async function gitPathStatus(target: string, kind: 'file' | 'directory'): Promise<GitPathReport> {
  const cwd = kind === 'file' ? path.dirname(target) : target;
  let git: string;
  try {
    git = resolveHostExecutable('git', { workspaceRoots: [cwd] });
  } catch (error) {
    return { repository: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  let top = '';
  if (kind === 'directory') {
    const located = await runGit(git, cwd, ['rev-parse', '--show-toplevel']);
    if (located.notRepository) return { repository: false };
    if (located.error !== undefined || located.code !== 0) {
      return { repository: 'unknown', reason: located.error ?? `git exited ${located.code}` };
    }
    top = located.stdout.trim();
  }
  const status = await runGit(git, cwd, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--',
    kind === 'file' ? path.basename(target) : '.',
  ]);
  if (status.notRepository) return { repository: false };
  if (status.error !== undefined || status.code !== 0) {
    return { repository: 'unknown', reason: status.error ?? `git exited ${status.code}` };
  }
  return { repository: true, entries: parsePorcelainZ(status.stdout, kind === 'file' ? undefined : top, target) };
}

/**
 * Entries of `git status --porcelain=v1 -z`. A rename or copy carries its source as a second field, which names no
 * file of this change. A file's own status needs no top level: every entry of a one-file pathspec is that file or
 * a folder holding it.
 */
export function parsePorcelainZ(output: string, top: string | undefined, target: string): GitPathEntry[] {
  const fields = output.split('\0');
  const entries: GitPathEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const relative = field.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index++;
    const state: GitPathEntry['state'] = code === '??' ? 'untracked' : code === '!!' ? 'ignored' : 'changed';
    const folder = relative.endsWith('/');
    entries.push({
      path: top === undefined ? target : path.resolve(top, relative.replace(/\/+$/, '')),
      folder,
      state,
    });
  }
  return entries;
}

interface GitRun {
  code: number | null;
  stdout: string;
  notRepository: boolean;
  error?: string;
}

function runGit(git: string, cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const finish = (run: GitRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(git, ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...sanitizedCommandEnv(), GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch (error) {
      resolve({ code: null, stdout: '', notRepository: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ code: null, stdout, notRepository: false, error: 'Git did not answer in time.' });
    }, GIT_PATH_TIMEOUT_MS);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > GIT_PATH_MAX_OUTPUT) {
        overflow = true;
        proc.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    proc.on('error', (error) => finish({ code: null, stdout, notRepository: false, error: error.message }));
    proc.on('close', (code) => {
      if (overflow) {
        finish({ code: null, stdout: '', notRepository: false, error: 'Git listed more than this check reads.' });
        return;
      }
      finish({ code, stdout, notRepository: code !== 0 && /not a git repository/i.test(stderr) });
    });
  });
}
