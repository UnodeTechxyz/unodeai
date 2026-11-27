import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { hostNativeSpawnOptions, resolveHostExecutable } from '../HostExecutableResolver';

const WINDOWS_ENV = { PATH: 'relative;C:\\workspace;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' };

describe('resolveHostExecutable', () => {
  it('ignores the current directory and relative PATH entries', () => {
    const files = new Set([
      'C:\\workspace\\git.EXE',
      'C:\\Program Files\\Git\\cmd\\git.EXE',
    ].map((entry) => entry.toLowerCase()));

    const resolved = resolveHostExecutable('git', {
      platform: 'win32',
      env: { PATH: '.;relative;C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE;.CMD' },
      workspaceRoots: ['C:\\workspace'],
      isExecutableFile: (candidate) => files.has(candidate.toLowerCase()),
      realpath: (candidate) => candidate,
    });

    expect(resolved).toBe('C:\\Program Files\\Git\\cmd\\git.EXE');
  });

  it('refuses a resolved executable inside a workspace instead of falling through to another copy', () => {
    const files = new Set([
      'C:\\workspace\\claude.CMD',
      'C:\\Windows\\System32\\claude.CMD',
    ].map((entry) => entry.toLowerCase()));

    expect(() => resolveHostExecutable('claude.cmd', {
      platform: 'win32',
      env: WINDOWS_ENV,
      workspaceRoots: ['C:\\workspace'],
      isExecutableFile: (candidate) => files.has(candidate.toLowerCase()),
      realpath: (candidate) => candidate,
    })).toThrow(/inside workspace-owned path/i);
  });

  it('rejects a symlink-resolved executable inside an extension worktree root', () => {
    expect(() => resolveHostExecutable('git', {
      platform: 'win32',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE' },
      worktreeRoots: ['C:\\repo\\.unode\\worktrees'],
      isExecutableFile: () => true,
      realpath: () => 'C:\\repo\\.unode\\worktrees\\agent-a\\git.exe',
    })).toThrow(/inside workspace-owned path/i);
  });

  it('rejects a workspace-owned symlink even when its target resolves outside the workspace', () => {
    expect(() => resolveHostExecutable('claude.cmd', {
      platform: 'win32',
      env: { PATH: 'C:\\workspace', PATHEXT: '.CMD' },
      workspaceRoots: ['C:\\workspace'],
      isExecutableFile: () => true,
      realpath: (candidate) => candidate.toLowerCase().includes('claude')
        ? 'C:\\host-tools\\claude.cmd'
        : candidate,
    })).toThrow(/inside workspace-owned path/i);
  });

  it('accepts an explicit absolute executable outside protected roots', () => {
    expect(resolveHostExecutable('C:\\Tools\\claude.cmd', {
      platform: 'win32',
      workspaceRoots: ['C:\\workspace'],
      isExecutableFile: () => true,
      realpath: (candidate) => candidate,
    })).toBe('C:\\Tools\\claude.cmd');
  });

  it('recognises a child whose name begins with two dots as workspace-owned', () => {
    expect(() => resolveHostExecutable('C:\\workspace\\..tools\\claude.cmd', {
      platform: 'win32',
      workspaceRoots: ['C:\\workspace'],
      isExecutableFile: () => true,
      realpath: (candidate) => candidate,
    })).toThrow(/inside workspace-owned path/i);
  });

  it('forces the host git probe to bypass shell lookup', () => {
    expect(hostNativeSpawnOptions('C:\\workspace')).toEqual({ cwd: 'C:\\workspace', shell: false });
  });
});

const windowsScratch: string[] = [];
afterEach(async () => {
  await Promise.all(windowsScratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.runIf(process.platform === 'win32')('real Windows lookup never runs planted claude.cmd or git.cmd from cwd', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'unode-host-launch-'));
  windowsScratch.push(scratch);
  const workspace = path.join(scratch, 'workspace');
  const hostTools = path.join(scratch, 'host tools');
  await mkdir(workspace);
  await mkdir(hostTools);
  const claudeMarker = path.join(workspace, 'marker-claude.txt');
  const gitMarker = path.join(workspace, 'marker-git.txt');
  await writeFile(path.join(workspace, 'claude.cmd'), `@echo off\r\n>"${claudeMarker}" echo planted\r\n`, 'utf8');
  await writeFile(path.join(workspace, 'git.cmd'), `@echo off\r\n>"${gitMarker}" echo planted\r\n`, 'utf8');
  await writeFile(path.join(hostTools, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');

  const env = { ...process.env, PATH: `${hostTools};${process.env.PATH ?? ''}` };
  const claude = resolveHostExecutable('claude.cmd', { env, workspaceRoots: [workspace] });
  const git = resolveHostExecutable('git', { env, workspaceRoots: [workspace] });
  expect(path.isAbsolute(claude)).toBe(true);
  expect(path.isAbsolute(git)).toBe(true);
  // Pass one fully formed test command: Node 25 deprecates an argv array with shell:true because it would
  // concatenate unescaped arguments. The production Claude boundary separately validates every argv token.
  expect(spawnSync(`"${claude}" --version`, { cwd: workspace, shell: true, timeout: 15_000 }).error).toBeUndefined();
  expect(spawnSync(git, ['--version'], { ...hostNativeSpawnOptions(workspace), timeout: 15_000 }).error).toBeUndefined();
  expect(existsSync(claudeMarker)).toBe(false);
  expect(existsSync(gitMarker)).toBe(false);
});
