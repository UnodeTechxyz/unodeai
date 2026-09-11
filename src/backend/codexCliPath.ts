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
  if (platform !== 'win32' || path.extname(configuredPath).toLowerCase() !== '.cmd') {
    return configuredPath;
  }
  // Keep the configured path authoritative: a nonexistent wrapper must fail the regular exact-path check,
  // rather than letting a similarly named directory select a different binary.
  if (!fs.exists(configuredPath)) {
    return configuredPath;
  }

  const npmRoot = path.dirname(configuredPath);
  const packageRoot = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules');
  let packageNames: string[];
  try {
    packageNames = fs.readDir(path.join(packageRoot, '@openai'));
  } catch {
    throw wrapperResolutionError();
  }

  for (const packageName of packageNames.filter((name) => /^codex-win32-/i.test(name)).sort()) {
    const vendorRoot = path.join(packageRoot, '@openai', packageName, 'vendor');
    let targets: string[];
    try {
      targets = fs.readDir(vendorRoot);
    } catch {
      continue;
    }
    for (const target of targets.sort()) {
      const executable = path.join(vendorRoot, target, 'bin', 'codex.exe');
      if (fs.exists(executable)) {
        return executable;
      }
    }
  }

  throw wrapperResolutionError();
}

function wrapperResolutionError(): Error {
  return new Error(
    'The selected Codex .cmd wrapper has no adjacent native codex.exe. Reinstall @openai/codex or set '
    + 'unode.codexCliPath to its absolute codex.exe path. UnodeAi will not launch a .cmd wrapper through a shell.'
  );
}
