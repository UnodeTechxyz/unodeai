/*---------------------------------------------------------------------------------------------
 * v0.9.96: which Claude or Codex CLI program UnodeAi starts, and what is known about it.
 *
 * Discovery only looks at the file system: it never starts a candidate. A version check starts exactly the program
 * the user chose to check, with `--version`, and nothing else. A configured path stays authoritative; UnodeAi never
 * switches installation because another one is newer.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_NPM_LAUNCHER_PROGRAM } from './cliClosure';
import { isPathInsideOrEqual, isPathStrictlyInside } from './pathContainment';

export type CliRuntimeProvider = 'claude-cli' | 'codex-cli';

/** How a program is started: a native executable without a shell, or the npm `.cmd` wrapper through `cmd.exe`. */
export type CliLaunchRoute = 'native' | 'npm-cmd';

export type CliCandidateSource =
  | 'npm global install'
  | 'native installer'
  | 'standard install location'
  | 'VS Code extension'
  | 'PATH'
  | 'chosen file';

export interface CliRuntimeCandidate {
  path: string;
  source: CliCandidateSource;
  route: CliLaunchRoute;
  /** Shown beside the candidate, for example that an extension's program moves when the extension updates. */
  note?: string;
}

export interface CliRuntimeFs {
  exists(path: string): boolean;
  readDir(path: string): string[];
}

/** What the identity of a program file is read from. */
export interface CliProgramFs {
  realpath(path: string): string;
  stat(path: string): { dev: number; ino: number; size: number; mtimeMs: number };
}

const nodeProgramFs: CliProgramFs = {
  realpath: (candidate) => realpathSync.native(candidate),
  stat: (candidate) => statSync(candidate),
};

/**
 * The identity of the file a program path names now: its physical path, file number, size and modification time.
 * A link pointed elsewhere, or a file replaced in place, as an update does, has another identity, so a check of the
 * old file says nothing about it. Undefined when the file cannot be read. Reading it starts nothing.
 */
export function cliProgramStamp(program: string, fs: CliProgramFs = nodeProgramFs): string | undefined {
  try {
    const physical = fs.realpath(program);
    const stat = fs.stat(physical);
    return [physical, stat.dev, stat.ino, stat.size, Math.trunc(stat.mtimeMs)].join('|');
  } catch {
    return undefined;
  }
}

/** What the folder a CLI program starts in is prepared with. */
export interface NeutralFolderFs {
  mkdir(path: string): void;
  realpath(path: string): string;
}

const nodeFolderFs: NeutralFolderFs = {
  mkdir: (folder) => { mkdirSync(folder, { recursive: true }); },
  realpath: (folder) => realpathSync.native(folder),
};

/**
 * The host-owned folder a CLI check or update terminal starts in. It must be absolute, must exist, and must lie
 * outside every workspace folder, as written and after links are resolved. Throws with the reason instead of
 * returning another folder, so that nothing starts in an inherited current directory.
 */
export function prepareNeutralFolder(
  folder: string | undefined,
  workspaceRoots: readonly string[],
  fs: NeutralFolderFs = nodeFolderFs,
  platform: NodeJS.Platform = process.platform,
): string {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const inside = (roots: readonly string[], candidate: string) => roots.some((root) => isPathInsideOrEqual(root, candidate, hostPath));
  if (!folder || !hostPath.isAbsolute(folder)) {
    throw new Error('UnodeAi has no storage folder of its own to start a CLI program in. Nothing was started.');
  }
  if (inside(workspaceRoots, folder)) {
    throw new Error('UnodeAi\'s folder for CLI programs is inside a workspace folder. Nothing was started.');
  }
  let physical: string;
  try {
    fs.mkdir(folder);
    physical = fs.realpath(folder);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`UnodeAi could not prepare its folder for CLI programs (${reason.slice(0, 200)}). Nothing was started.`);
  }
  const physicalRoots = workspaceRoots.map((root) => {
    try { return fs.realpath(root); } catch { return root; }
  });
  if (!hostPath.isAbsolute(physical) || inside([...workspaceRoots, ...physicalRoots], physical)) {
    throw new Error('UnodeAi\'s folder for CLI programs leads into a workspace folder. Nothing was started.');
  }
  return physical;
}

const nodeFs: CliRuntimeFs = {
  exists: existsSync,
  readDir: (dir) => readdirSync(dir, { encoding: 'utf8' }),
};

const EXTENSION_NOTE = 'Comes with an editor extension; it moves to a new folder when the extension updates.';

/**
 * Claude CLI programs on this computer, found from the file system alone. The native program behind npm's
 * `claude.cmd` comes first, then the native installer, then extension-bundled copies, then PATH.
 */
export function discoverClaudeCliCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: CliRuntimeFs = nodeFs,
  execPath: string = process.execPath,
): CliRuntimeCandidate[] {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const found: CliRuntimeCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidatePath: string | undefined, source: CliCandidateSource, note?: string): void => {
    if (!candidatePath || !hostPath.isAbsolute(candidatePath) || !fs.exists(candidatePath)) return;
    const key = platform === 'win32' ? hostPath.resolve(candidatePath).toLowerCase() : hostPath.resolve(candidatePath);
    if (seen.has(key)) return;
    seen.add(key);
    const route: CliLaunchRoute = platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidatePath) ? 'npm-cmd' : 'native';
    found.push({ path: hostPath.resolve(candidatePath), source, route, ...(note ? { note } : {}) });
  };

  for (const npmRoot of npmGlobalRoots(env, platform, execPath)) {
    const packageBin = hostPath.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
    add(packageBin, 'npm global install', 'The program npm\'s claude launcher starts.');
    if (platform === 'win32') {
      add(hostPath.join(hostPath.dirname(npmRoot), 'claude.cmd'), 'npm global install', 'npm\'s launcher; UnodeAi starts the program it names directly.');
    } else {
      add(hostPath.join(hostPath.dirname(hostPath.dirname(npmRoot)), 'bin', 'claude'), 'npm global install');
      add(hostPath.join(hostPath.dirname(npmRoot), 'bin', 'claude'), 'npm global install');
    }
  }

  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  add(home && hostPath.join(home, '.local', 'bin', exe), 'native installer');
  if (platform === 'win32') {
    add(env.LOCALAPPDATA && hostPath.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), 'standard install location');
  } else {
    add(home && hostPath.join(home, '.claude', 'local', 'claude'), 'standard install location');
    add('/usr/local/bin/claude', 'standard install location');
    add('/opt/homebrew/bin/claude', 'standard install location');
  }

  for (const extensions of editorExtensionRoots(home, hostPath)) {
    for (const folder of extensionFolders(extensions, /^anthropic\.claude-code-/i, fs)) {
      add(hostPath.join(extensions, folder, 'resources', 'native-binary', exe), 'VS Code extension', EXTENSION_NOTE);
    }
  }

  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const entry of String(env.PATH ?? env.Path ?? '').split(hostPath.delimiter).filter(Boolean)) {
    for (const name of names) add(hostPath.join(entry, name), 'PATH');
  }
  return found;
}

/** Codex programs bundled with an editor extension, which the Codex discovery does not list on its own. */
export function discoverCodexExtensionCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: CliRuntimeFs = nodeFs,
): CliRuntimeCandidate[] {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  const found: CliRuntimeCandidate[] = [];
  for (const extensions of editorExtensionRoots(home, hostPath)) {
    for (const folder of extensionFolders(extensions, /^openai\.chatgpt-/i, fs)) {
      const bin = hostPath.join(extensions, folder, 'bin');
      let platforms: string[];
      try {
        platforms = fs.readDir(bin);
      } catch {
        continue;
      }
      for (const target of platforms.sort()) {
        const candidate = hostPath.join(bin, target, platform === 'win32' ? 'codex.exe' : 'codex');
        if (fs.exists(candidate)) found.push({ path: candidate, source: 'VS Code extension', route: 'native', note: EXTENSION_NOTE });
      }
    }
  }
  return found;
}

/** Where a chosen or configured program comes from, for display and update instructions. Paths only. */
export function classifyCliSource(
  provider: CliRuntimeProvider,
  programPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): CliCandidateSource {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = hostPath.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = normalize(programPath);
  const inside = (root: string | undefined) => !!root && isPathStrictlyInside(normalize(root), target, hostPath);
  const packageName = provider === 'claude-cli' ? ['@anthropic-ai', 'claude-code'] : ['@openai', 'codex'];
  for (const npmRoot of npmGlobalRoots(env, platform, execPath)) {
    if (inside(hostPath.join(npmRoot, ...packageName))) return 'npm global install';
    const launcher = provider === 'claude-cli' ? 'claude' : 'codex';
    const wrappers = platform === 'win32'
      ? [hostPath.join(hostPath.dirname(npmRoot), `${launcher}.cmd`)]
      : [hostPath.join(hostPath.dirname(hostPath.dirname(npmRoot)), 'bin', launcher), hostPath.join(hostPath.dirname(npmRoot), 'bin', launcher)];
    if (wrappers.some((wrapper) => normalize(wrapper) === target)) return 'npm global install';
  }
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  const extensionPrefix = provider === 'claude-cli' ? /^anthropic\.claude-code-/i : /^openai\.chatgpt-/i;
  for (const extensions of editorExtensionRoots(home, hostPath)) {
    if (!inside(extensions)) continue;
    const folder = hostPath.relative(normalize(extensions), target).split(hostPath.sep)[0];
    if (extensionPrefix.test(folder)) return 'VS Code extension';
  }
  if (provider === 'claude-cli' && home && normalize(hostPath.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')) === target) {
    return 'native installer';
  }
  return 'chosen file';
}

export interface ClaudeCliLaunch {
  executable: string;
  /** True only for npm's `.cmd` launcher, which Node cannot start without `cmd.exe`. */
  shell: boolean;
  route: CliLaunchRoute;
  /** `configured` is `unode.claudeCliPath`; `legacy` is the PATH lookup of `claude.cmd`/`claude` used before 0.9.96. */
  origin: 'configured' | 'legacy';
}

/**
 * The program a Claude agent is started with. `resolve` is the host executable resolver: it requires an existing
 * file, resolves links, and refuses a program inside a workspace or worktree. A configured path must be absolute.
 * Without one, the lookup UnodeAi always used is kept, so nobody is moved to another installation silently.
 *
 * v0.9.97: npm's `claude.cmd` only starts the native program inside its package
 * (`node_modules\@anthropic-ai\claude-code\bin\claude.exe`). When that program is there, it is started directly,
 * without `cmd.exe`, so the launch is that one program file, the same bytes the native installer ships. A launcher
 * whose program is missing keeps the `cmd.exe` route.
 */
export function resolveClaudeCliLaunch(
  configuredPath: string,
  resolve: (command: string) => string,
  platform: NodeJS.Platform = process.platform,
  fs: Pick<CliRuntimeFs, 'exists'> = nodeFs,
): ClaudeCliLaunch {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const configured = configuredPath.trim();
  if (configured && !hostPath.isAbsolute(configured)) {
    throw new Error('unode.claudeCliPath must be the absolute path of the Claude CLI program. Use Check / choose CLI in Settings.');
  }
  const executable = resolve(configured || (platform === 'win32' ? 'claude.cmd' : 'claude'));
  const origin = configured ? 'configured' as const : 'legacy' as const;
  if (platform !== 'win32') return { executable, shell: false, route: 'native', origin };
  const extension = hostPath.extname(executable).toLowerCase();
  if (extension === '.exe') return { executable, shell: false, route: 'native', origin };
  if (extension === '.cmd' || extension === '.bat') {
    // Node joins command and argv when a shell is used, so the path is quoted as one token. Windows paths cannot
    // contain a quote; refuse one, and line breaks, so the token can never become shell syntax.
    if (/["\r\n%]/.test(executable)) throw new Error('Claude CLI refused an unsafe resolved executable path.');
    const program = hostPath.join(hostPath.dirname(executable), ...CLAUDE_NPM_LAUNCHER_PROGRAM);
    // The program the launcher names, through the same resolver: a refusal of it refuses the start.
    if (fs.exists(program)) return { executable: resolve(program), shell: false, route: 'native', origin };
    return { executable, shell: true, route: 'npm-cmd', origin };
  }
  throw new Error(`UnodeAi starts only a .exe program or npm's .cmd launcher for Claude CLI, not "${executable}".`);
}

/** `claude --version` prints `2.1.209 (Claude Code)`. Anything else is not taken for a Claude CLI version. */
export function parseClaudeCliVersion(output: string): string | undefined {
  return /^\s*(\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?)\s+\(Claude Code\)/m.exec(output.slice(0, 4096))?.[1];
}

export interface CliRuntimeTooOld {
  kind: 'runtime-too-old';
  provider: CliRuntimeProvider;
  /** The version the provider's error names. It is the provider's statement, not a local measurement. */
  reportedVersion: string;
  requiredVersion: string;
}

/**
 * The provider's error that a model needs a newer CLI. Only the version numbers are taken from it; its suggested
 * command, link or path is never acted on. Any other error is not classified: an old CLI is not assumed.
 */
export function classifyCliRuntimeFailure(provider: CliRuntimeProvider, text: string): CliRuntimeTooOld | undefined {
  if (provider !== 'claude-cli') return undefined;
  const match = /Claude Code (\d{1,4}\.\d{1,4}\.\d{1,6}) does not support this model; version (\d{1,4}\.\d{1,4}\.\d{1,6}) or newer is required/
    .exec(text.slice(0, 8192));
  return match ? { kind: 'runtime-too-old', provider, reportedVersion: match[1], requiredVersion: match[2] } : undefined;
}

/** A program and its arguments; written out for one shell by `renderCliUpdateCommand`. */
export interface CliUpdateCommand {
  /** `npm`, found by the user's shell, or the absolute path of the installed program. */
  program: string;
  args: string[];
}

export interface CliUpdateInstructions {
  /** What to do, in plain words, naming the installation it is for. */
  summary: string;
  /** A command for the user to run themselves. UnodeAi copies it or types it in a terminal; it never runs it. */
  update?: CliUpdateCommand;
  docsUrl: string;
}

export const CLAUDE_SETUP_DOCS_URL = 'https://code.claude.com/docs/en/setup';
export const CODEX_CLI_DOCS_URL = 'https://learn.chatgpt.com/docs/cli/reference';

/** How to update the very installation UnodeAi starts. Copyable text only; nothing here is executed. */
export function cliUpdateInstructions(
  provider: CliRuntimeProvider,
  programPath: string,
  source: CliCandidateSource,
): CliUpdateInstructions {
  if (provider === 'claude-cli') {
    switch (source) {
      case 'npm global install':
        return {
          summary: 'UnodeAi starts the Claude CLI that npm installed. Update it with npm; the npm your terminal finds must be the one that installed it. Running "claude update" in a terminal may update a different installation.',
          update: { program: 'npm', args: ['install', '-g', `${CLI_NPM_PACKAGE['claude-cli']}@latest`] },
          docsUrl: CLAUDE_SETUP_DOCS_URL,
        };
      case 'native installer':
        return {
          summary: 'UnodeAi starts the Claude CLI from the native installer. Update that program itself.',
          update: { program: programPath, args: ['update'] },
          docsUrl: CLAUDE_SETUP_DOCS_URL,
        };
      case 'VS Code extension':
        return {
          summary: 'UnodeAi starts the Claude CLI that comes with an editor extension. Update the extension, then choose its new program with Check / choose CLI, because the program moves to a new folder.',
          docsUrl: CLAUDE_SETUP_DOCS_URL,
        };
      default:
        return {
          summary: 'UnodeAi does not know how this Claude CLI was installed. Update it the way it was installed, or choose another installation with Check / choose CLI.',
          docsUrl: CLAUDE_SETUP_DOCS_URL,
        };
    }
  }
  switch (source) {
    case 'npm global install':
      return {
        summary: 'UnodeAi starts the Codex CLI that npm installed. Update it with npm; the npm your terminal finds must be the one that installed it.',
        update: { program: 'npm', args: ['install', '-g', `${CLI_NPM_PACKAGE['codex-cli']}@latest`] },
        docsUrl: CODEX_CLI_DOCS_URL,
      };
    case 'VS Code extension':
      return {
        summary: 'UnodeAi starts the Codex CLI that comes with an editor extension. Update the extension, then choose its new program with Check / choose CLI, because the program moves to a new folder.',
        docsUrl: CODEX_CLI_DOCS_URL,
      };
    default:
      return {
        summary: 'UnodeAi does not know how this Codex CLI was installed. Update it the way it was installed, or choose another installation with Check / choose CLI.',
        docsUrl: CODEX_CLI_DOCS_URL,
      };
  }
}

/** The shells a command can be written for. Any other shell gets no typed command; the user copies one instead. */
export type CliTerminalShell = 'powershell' | 'cmd' | 'posix';

/** The kind of the user's default terminal shell, from its path (`vscode.env.shell`). */
export function cliTerminalShell(shellPath: string): CliTerminalShell | undefined {
  const name = shellPath.trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) return 'posix';
  return undefined;
}

/**
 * One command line for that shell, or undefined when it cannot be written safely. `npm` and its fixed arguments
 * need no quoting in any of these shells; a program path is quoted for the shell, and refused where quoting cannot
 * keep it one word (a quote, `%` for cmd.exe, or a line break).
 */
export function renderCliUpdateCommand(update: CliUpdateCommand, shell: CliTerminalShell): string | undefined {
  if (update.args.some((arg) => !/^[A-Za-z0-9@/._-]+$/.test(arg))) return undefined;
  const args = update.args.join(' ');
  if (update.program === 'npm') return `npm ${args}`;
  const program = update.program;
  if (/[\r\n]/.test(program)) return undefined;
  // PowerShell also ends a single-quoted string at the typographic single quotes, so each is doubled too.
  if (shell === 'powershell') return `& '${program.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}' ${args}`;
  if (shell === 'cmd') return /["%]/.test(program) ? undefined : `"${program}" ${args}`;
  return `'${program.replace(/'/g, "'\\''")}' ${args}`;
}

/** The npm package of each CLI. Only its public `latest` version is ever asked for. */
export const CLI_NPM_PACKAGE: Record<CliRuntimeProvider, string> = {
  'claude-cli': '@anthropic-ai/claude-code',
  'codex-cli': '@openai/codex',
};
export const CLI_LATEST_HOST = 'registry.npmjs.org';
/** A latest-version lookup waits at most this long and reads at most this much. */
export const CLI_LATEST_LIMITS = { timeoutMs: 8_000, bytes: 256 * 1024 } as const;

export function cliLatestVersionUrl(provider: CliRuntimeProvider): string {
  return `https://${CLI_LATEST_HOST}/${CLI_NPM_PACKAGE[provider]}/latest`;
}

/** Only the release version of npm's `latest` document for that package; anything else is refused. */
export function parseNpmLatestVersion(provider: CliRuntimeProvider, body: string): string {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new Error('npm did not return a package document.');
  }
  const { name, version } = (document && typeof document === 'object' ? document : {}) as { name?: unknown; version?: unknown };
  if (name !== CLI_NPM_PACKAGE[provider]) throw new Error('npm returned a document for another package.');
  if (typeof version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) throw new Error('npm returned no release version.');
  return version;
}

/**
 * Compares the release numbers of two versions; a prerelease sorts below its release. Undefined when either is
 * not a version, so nothing is claimed about it.
 */
export function compareCliVersions(a: string, b: string): number | undefined {
  const parse = (value: string) => {
    const match = /(\d{1,4})\.(\d{1,4})\.(\d{1,6})(-[0-9A-Za-z.-]+)?/.exec(value);
    return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] !== undefined } : undefined;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1;
  }
  if (left.prerelease !== right.prerelease) return left.prerelease ? -1 : 1;
  return 0;
}

/** Reads a response body up to `maxBytes`; a longer one is cancelled and refused, never kept. */
export async function readBoundedText(
  response: { text(): Promise<string>; body?: unknown },
  maxBytes: number,
): Promise<string> {
  const stream = response.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | undefined;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('npm returned more than UnodeAi reads.');
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('larger than UnodeAi reads').catch(() => undefined);
      throw new Error('npm returned more than UnodeAi reads.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function npmGlobalRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, execPath: string): string[] {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const roots: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value || !hostPath.isAbsolute(value)) return;
    const resolved = hostPath.resolve(value);
    if (!roots.some((root) => (platform === 'win32' ? root.toLowerCase() === resolved.toLowerCase() : root === resolved))) roots.push(resolved);
  };
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (prefix) add(platform === 'win32' ? hostPath.join(prefix, 'node_modules') : hostPath.join(prefix, 'lib', 'node_modules'));
  if (platform === 'win32') {
    add(env.APPDATA && hostPath.join(env.APPDATA, 'npm', 'node_modules'));
    add(hostPath.join(hostPath.dirname(execPath), 'node_modules'));
  } else {
    add(hostPath.resolve(hostPath.dirname(execPath), '..', 'lib', 'node_modules'));
  }
  return roots;
}

function editorExtensionRoots(home: string | undefined, hostPath: typeof path.posix | typeof path.win32): string[] {
  if (!home || !hostPath.isAbsolute(home)) return [];
  return ['.vscode', '.vscode-insiders', '.cursor'].map((dir) => hostPath.join(home, dir, 'extensions'));
}

/** Extension folders of one publisher, newest version name first. */
function extensionFolders(extensions: string, prefix: RegExp, fs: CliRuntimeFs): string[] {
  let folders: string[];
  try {
    folders = fs.readDir(extensions);
  } catch {
    return [];
  }
  return folders.filter((folder) => prefix.test(folder))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}
