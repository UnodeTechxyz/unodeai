/*---------------------------------------------------------------------------------------------
 *  Resolves the native executable behind the official npm Windows wrapper without ever spawning
 *  the .cmd file through a shell. A configured path is always explicit; PATH is never consulted.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export interface CodexCliPathFs {
  exists(path: string): boolean;
  readDir(path: string): string[];
}

export type CodexCliCandidateSource = 'npm global install' | 'standard install location' | 'PATH';

export interface CodexCliCandidate {
  path: string;
  source: CodexCliCandidateSource;
}

const nodeFs: CodexCliPathFs = {
  exists: existsSync,
  readDir: (dir) => readdirSync(dir, { encoding: 'utf8' }),
};

/**
 * Node cannot safely spawn a Windows .cmd wrapper with `shell: false`. The official npm package installs
 * that wrapper beside a native vendor binary, so resolve that explicit sibling instead of enabling a shell.
 */
export function resolveCodexCliLaunchPath(
  configuredPath: string,
  platform = process.platform,
  fs: CodexCliPathFs = nodeFs,
): string {
  if (platform !== 'win32' || path.win32.extname(configuredPath).toLowerCase() !== '.cmd') {
    return configuredPath;
  }
  // Keep the configured path authoritative: a nonexistent wrapper must fail the regular exact-path check,
  // rather than letting a similarly named directory select a different binary.
  if (!fs.exists(configuredPath)) {
    return configuredPath;
  }

  const npmRoot = path.win32.dirname(configuredPath);
  const packageRoot = path.win32.join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules');
  let packageNames: string[];
  try {
    packageNames = fs.readDir(path.win32.join(packageRoot, '@openai'));
  } catch {
    throw wrapperResolutionError();
  }

  for (const packageName of packageNames.filter((name) => /^codex-win32-/i.test(name)).sort()) {
    const vendorRoot = path.win32.join(packageRoot, '@openai', packageName, 'vendor');
    let targets: string[];
    try {
      targets = fs.readDir(vendorRoot);
    } catch {
      continue;
    }
    for (const target of targets.sort()) {
      const executable = path.win32.join(vendorRoot, target, 'bin', 'codex.exe');
      if (fs.exists(executable)) {
        return executable;
      }
    }
  }

  throw wrapperResolutionError();
}

/**
 * Find explicit Codex executable candidates without running Codex and without consulting its home folder.
 * Ordering is security-significant: the user's npm-global install and ordinary user install locations are
 * considered before PATH, where an editor-bundled preview can shadow the CLI the user installed.
 */
export function discoverCodexCliCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  fs: CodexCliPathFs = nodeFs,
): CodexCliCandidate[] {
  // Path rules follow the platform argument, not the host running this code, so a caller (or a test on
  // Linux CI) asking about Windows gets Windows semantics: absolute drive paths, `;` PATH delimiter.
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates: CodexCliCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidatePath: string | undefined, source: CodexCliCandidateSource): void => {
    if (!candidatePath || !hostPath.isAbsolute(candidatePath) || !fs.exists(candidatePath)) return;
    let launchPath: string;
    try {
      launchPath = resolveCodexCliLaunchPath(candidatePath, platform, fs);
    } catch {
      return;
    }
    if (!fs.exists(launchPath)) return;
    const key = platform === 'win32' ? hostPath.resolve(launchPath).toLowerCase() : hostPath.resolve(launchPath);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: launchPath, source });
  };

  for (const npmRoot of inferredNpmGlobalRoots(env, platform)) {
    if (platform === 'win32') {
      add(hostPath.join(hostPath.dirname(npmRoot), 'codex.cmd'), 'npm global install');
      for (const executable of windowsVendorExecutables(npmRoot, fs)) add(executable, 'npm global install');
    } else {
      add(hostPath.join(hostPath.dirname(hostPath.dirname(npmRoot)), 'bin', 'codex'), 'npm global install');
      add(hostPath.join(hostPath.dirname(npmRoot), 'bin', 'codex'), 'npm global install');
    }
  }

  if (platform === 'win32') {
    add(env.LOCALAPPDATA && hostPath.join(env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe'), 'standard install location');
    add(env.LOCALAPPDATA && hostPath.join(env.LOCALAPPDATA, 'Programs', 'OpenAI Codex', 'codex.exe'), 'standard install location');
    add(env.LOCALAPPDATA && hostPath.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codex.exe'), 'standard install location');
    add(env.USERPROFILE && hostPath.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'), 'standard install location');
  } else {
    add(env.HOME && hostPath.join(env.HOME, '.local', 'bin', 'codex'), 'standard install location');
    add('/usr/local/bin/codex', 'standard install location');
    add('/opt/homebrew/bin/codex', 'standard install location');
  }

  const pathNames = platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const entry of String(env.PATH ?? '').split(hostPath.delimiter).filter(Boolean)) {
    for (const name of pathNames) add(hostPath.join(entry, name), 'PATH');
  }
  return candidates;
}

function inferredNpmGlobalRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const roots: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value || !hostPath.isAbsolute(value)) return;
    const resolved = hostPath.resolve(value);
    if (!roots.some((root) => (platform === 'win32' ? root.toLowerCase() === resolved.toLowerCase() : root === resolved))) {
      roots.push(resolved);
    }
  };
  if (env.npm_config_prefix || env.NPM_CONFIG_PREFIX) {
    const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX!;
    add(platform === 'win32' ? hostPath.join(prefix, 'node_modules') : hostPath.join(prefix, 'lib', 'node_modules'));
  }
  if (platform === 'win32') {
    add(env.APPDATA && hostPath.join(env.APPDATA, 'npm', 'node_modules'));
    add(hostPath.join(hostPath.dirname(process.execPath), 'node_modules'));
  } else {
    add(hostPath.resolve(hostPath.dirname(process.execPath), '..', 'lib', 'node_modules'));
  }
  return roots;
}

function windowsVendorExecutables(npmRoot: string, fs: CodexCliPathFs): string[] {
  const platformPackages = path.win32.join(npmRoot, '@openai', 'codex', 'node_modules', '@openai');
  let packageNames: string[];
  try {
    packageNames = fs.readDir(platformPackages);
  } catch {
    return [];
  }
  const executables: string[] = [];
  for (const packageName of packageNames.filter((name) => /^codex-win32-/i.test(name)).sort()) {
    const vendorRoot = path.win32.join(platformPackages, packageName, 'vendor');
    let targets: string[];
    try {
      targets = fs.readDir(vendorRoot);
    } catch {
      continue;
    }
    for (const target of targets.sort()) {
      const executable = path.win32.join(vendorRoot, target, 'bin', 'codex.exe');
      if (fs.exists(executable)) executables.push(executable);
    }
  }
  return executables;
}

function wrapperResolutionError(): Error {
  return new Error(
    'The selected Codex .cmd wrapper has no adjacent native codex.exe. Reinstall @openai/codex or set '
    + 'unode.codexCliPath to its absolute codex.exe path. UnodeAi will not launch a .cmd wrapper through a shell.'
  );
}
