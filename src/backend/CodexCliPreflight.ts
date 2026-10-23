import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isValidatedCodexCliVersion } from './CodexBackend';
import type { CodexCliProbeResult } from './CodexCliProbe';

/**
 * v0.9.97: why the preflight refused, so that a failed start of managed Codex can tell the program's own failure (it
 * did not run, it exited, it reported no usable version) from the environment's (no login).
 */
export type CodexPreflightFailureKind = 'not-configured' | 'did-not-run' | 'exited' | 'version' | 'login';

export class CodexPreflightError extends Error {
  constructor(readonly kind: CodexPreflightFailureKind, message: string) {
    super(message);
    this.name = 'CodexPreflightError';
  }
}

/** Validate the selected binary before consent/model egress. The runner owns bounded local process I/O. */
export async function verifyCodexCliPreflight(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  run: (binaryPath: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CodexCliProbeResult>,
  exists: (binaryPath: string) => boolean = existsSync,
): Promise<string> {
  if (!binaryPath || !path.isAbsolute(binaryPath) || !exists(binaryPath)) {
    throw new CodexPreflightError('not-configured', 'Codex CLI is not configured. Set unode.codexCliPath to the absolute path of the logged-in Codex CLI executable.');
  }
  const version = await ran(() => run(binaryPath, ['--version'], env));
  if (version.code !== 0 || !isValidatedCodexCliVersion(version.output)) {
    throw new CodexPreflightError(version.code !== 0 ? 'exited' : 'version', `Codex CLI version check failed for ${binaryPath} (exit ${version.code ?? 'none'}${version.signal ? `, signal ${version.signal}` : ''}; ${version.output || 'no output'}). UnodeAi requires codex-cli 0.155.0 or newer; newer builds must also pass the live App Server and effective-policy checks. Windows validation records 0.155.1.`);
  }
  const login = await ran(() => run(binaryPath, ['login', 'status'], env));
  if (login.code !== 0 || /not logged in/i.test(login.output)) {
    throw new CodexPreflightError('login', 'Codex CLI is not logged in. Run `codex login` in a terminal for the executable selected by unode.codexCliPath, then try again.');
  }
  const exactVersion = /\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/.exec(version.output)?.[1];
  if (!exactVersion) throw new CodexPreflightError('version', 'Codex CLI did not report an exact semantic version.');
  return exactVersion;
}

/** A check whose program could not be run at all. */
async function ran(run: () => Promise<CodexCliProbeResult>): Promise<CodexCliProbeResult> {
  try {
    return await run();
  } catch (error) {
    throw new CodexPreflightError('did-not-run', error instanceof Error ? error.message : String(error));
  }
}
