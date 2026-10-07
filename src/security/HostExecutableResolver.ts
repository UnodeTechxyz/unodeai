/*---------------------------------------------------------------------------------------------
 *  UnodeAi - host executable resolution
 *
 *  Host-initiated processes must never inherit cmd.exe's "current directory first" lookup. Resolve
 *  a concrete executable from absolute PATH entries before spawning it, then reject any result that
 *  belongs to a workspace or an extension-owned worktree. User-approved shell text does not use this
 *  resolver: its project-relative semantics are part of what the user approved.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { SpawnOptions } from 'node:child_process';

export interface HostExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  workspaceRoots?: readonly string[];
  worktreeRoots?: readonly string[];
  isExecutableFile?: (candidate: string) => boolean;
  realpath?: (candidate: string) => string;
}

export class HostExecutableResolutionError extends Error {
  constructor(message: string, public readonly candidate?: string) {
    super(message);
    this.name = 'HostExecutableResolutionError';
  }
}

/** Host-selected native programs never need a command shell for lookup or argument parsing. */
export function hostNativeSpawnOptions(cwd?: string): SpawnOptions {
  return { ...(cwd ? { cwd } : {}), shell: false };
}

/** Resolve a host-selected executable without consulting the current working directory. */
export function resolveHostExecutable(
  command: string,
  options: HostExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const isExecutableFile = options.isExecutableFile ?? ((candidate: string) => executableFile(candidate, platform));
  const realpath = options.realpath ?? ((candidate: string) => realpathSync.native(candidate));
  const requested = command.trim();
  if (!requested) {
    throw new HostExecutableResolutionError('Host executable name is empty.');
  }

  const candidates = pathApi.isAbsolute(requested)
    ? executableCandidates(requested, env, platform, pathApi)
    : searchPathCandidates(requested, env, platform, pathApi);
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    const lexicalCandidate = pathApi.resolve(candidate);
    const resolved = canonicalPath(candidate, pathApi, realpath);
    const forbiddenRoot = [...(options.workspaceRoots ?? []), ...(options.worktreeRoots ?? [])]
      .find((root) => root && (
        isInsideOrEqual(pathApi.resolve(root), lexicalCandidate, platform, pathApi)
        || isInsideOrEqual(canonicalPath(root, pathApi, realpath), resolved, platform, pathApi)
      ));
    if (forbiddenRoot) {
      throw new HostExecutableResolutionError(
        `UnodeAi refused to launch host executable "${resolved}" because it is inside workspace-owned path "${forbiddenRoot}".`,
        resolved,
      );
    }
    return resolved;
  }

  throw new HostExecutableResolutionError(
    pathApi.isAbsolute(requested)
      ? `Host executable was not found at "${requested}".`
      : `Host executable "${requested}" was not found in an absolute PATH entry.`,
  );
}

function searchPathCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathApi: typeof path.posix | typeof path.win32,
): string[] {
  if (command.includes('/') || command.includes('\\')) {
    throw new HostExecutableResolutionError(`Host executable "${command}" must be an absolute path or a bare program name.`);
  }
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const directories = pathValue.split(delimiter)
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0 && pathApi.isAbsolute(entry));
  return directories.flatMap((directory) => executableCandidates(pathApi.join(directory, command), env, platform, pathApi));
}

function executableCandidates(
  candidate: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathApi: typeof path.posix | typeof path.win32,
): string[] {
  const absolute = pathApi.resolve(candidate);
  if (platform !== 'win32' || pathApi.extname(absolute)) return [absolute];
  const rawExtensions = env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = rawExtensions.split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
  return extensions.map((extension) => `${absolute}${extension}`);
}

function executableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canonicalPath(
  candidate: string,
  pathApi: typeof path.posix | typeof path.win32,
  realpath: (candidate: string) => string,
): string {
  try {
    return pathApi.resolve(realpath(candidate));
  } catch {
    return pathApi.resolve(candidate);
  }
}

function isInsideOrEqual(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
  pathApi: typeof path.posix | typeof path.win32,
): boolean {
  const normalizedRoot = platform === 'win32' ? root.toLowerCase() : root;
  const normalizedCandidate = platform === 'win32' ? candidate.toLowerCase() : candidate;
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  const escapesRoot = relative === '..' || relative.startsWith(`..${pathApi.sep}`);
  return relative === '' || (!escapesRoot && !pathApi.isAbsolute(relative));
}

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
