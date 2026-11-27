/*---------------------------------------------------------------------------------------------
 *  UnodeAi - recognition of installs outside the project
 *
 *  A closed list of command forms that install machine-wide or download a large tool outside the project:
 *    - npm / pnpm / yarn global installs: `npm install|i|add -g|--global`, `pnpm add|install|i -g`, `yarn global add`
 *    - Playwright browser downloads: `playwright install` (direct, npx, npm exec, pnpm exec, python -m playwright)
 *    - system package managers: `winget install`, `choco install`, `scoop install`
 *    - pip outside a project virtual environment: `pip|pip3 install`, `python -m pip install`
 *    - `npx` / `npm exec` of a package the project does not declare in its package.json
 *
 *  The shell gate sends a command that matches to the existing command approval card, once, also when commands
 *  otherwise run without asking. This module only recognises: it makes no permission decision, runs nothing and
 *  never says a command is safe. An empty result is not a statement that a command installs nothing: other
 *  spellings (other package managers, scripts, aliases, a shell started with an inline string the scanner does not
 *  read) are not recognised.
 *
 *  Every reading can only add a card. Where a fact cannot be established (a package.json that cannot be read, a
 *  virtual environment that cannot be shown to be the project's), the command is treated as installing outside.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { literalCommandSegments } from './CommandPolicy';
import { isPathInsideOrEqual } from './pathContainment';
import type { CommandShellIdentity } from './CommandShell';

export type GlobalInstallFamily = 'package-manager-global' | 'playwright-browsers' | 'system-package-manager'
  | 'pip-outside-venv' | 'npx-undeclared';

export interface RecognizedGlobalInstall {
  readonly family: GlobalInstallFamily;
  /** The words of the segment that matched, as read. */
  readonly argv: readonly string[];
  /** Where it installs, at the level of a category. */
  readonly where: string;
  /** An approximate size where one is genuinely known, otherwise `size unknown`. */
  readonly size: string;
}

export interface GlobalInstallContext {
  /** The directory the command runs in. */
  readonly cwd: string;
  /** The agent's folders. A virtual environment or a `--target` inside one of them is the project's. */
  readonly roots: readonly string[];
  /** The host-prepared execution environment, when known. Never a model-supplied environment. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests; resolves `undefined` for a file that cannot be read. */
  readonly readFile?: (file: string) => Promise<string | undefined>;
  /** The time the file reads may take together. Past it, every open question is answered "outside". */
  readonly budgetMs?: number;
}

const SIZE_UNKNOWN = 'size unknown';
const NPM_INSTALL_WORDS = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall']);
const PNPM_INSTALL_WORDS = new Set(['add', 'install', 'i']);
const GLOBAL_FLAGS = new Set(['-g', '--global', '--location=global']);
const PYTHON_EXECUTABLE = /^(?:python(?:3(?:\.\d+)?)?|py)$/;
const PIP_EXECUTABLE = /^pip(?:3(?:\.\d+)?)?$/;
const VENV_NAMES = new Set(['.venv', 'venv', 'env', '.env', 'virtualenv', '.virtualenv']);
const PLAYWRIGHT_PACKAGES = new Set(['playwright', '@playwright/test']);
const MAX_DECLARED_DEPENDENCIES = 400;

/** The executable as a lower-case file name: `/usr/bin/npm`, `npm.cmd` and `NPM.EXE` are all `npm`. */
function executableName(token: string | undefined): string {
  if (!token) return '';
  return token.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

/**
 * The command's segments as words. The policy's own bounded scanner is used when it can read the command. When it
 * cannot (a pipe, a redirect, an expansion, a `||`), a coarse reading splits at every unquoted control character so
 * that no install hides behind one: it can only find more installs, never fewer, and decides nothing else.
 */
export function installSegments(command: string, shell: Pick<CommandShellIdentity, 'kind' | 'grammar'>): string[][] {
  const literal = literalCommandSegments(command, shell);
  const segments = literal ? literal.map((segment) => [...segment]) : coarseSegments(command, shell.grammar === 'cmd');
  // One level of a shell started with an inline command string (`bash -c "..."`, `cmd /c ...`, `pwsh -Command "..."`).
  const inner: string[][] = [];
  for (const segment of segments) {
    const body = inlineShellBody(segment);
    if (body !== undefined) inner.push(...coarseSegments(body, false));
  }
  return [...segments, ...inner].filter((segment) => segment.length > 0);
}

function inlineShellBody(segment: readonly string[]): string | undefined {
  const verb = executableName(segment[0]);
  if (verb === 'cmd') {
    const at = segment.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
    return at > 0 ? segment.slice(at + 1).join(' ') : undefined;
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(verb)) {
    const at = segment.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/i.test(word));
    return at > 0 ? segment[at + 1] : undefined;
  }
  if (verb === 'powershell' || verb === 'pwsh') {
    const at = segment.findIndex((word, index) => index > 0 && /^-(?:c|command)$/i.test(word));
    return at > 0 ? segment.slice(at + 1).join(' ') : undefined;
  }
  return undefined;
}

/** Split at unquoted `& | ; ( ) { }`, backticks and line ends; drop quotes. A reading, not an interpreter. */
function coarseSegments(command: string, cmdQuotes: boolean): string[][] {
  const segments: string[][] = [[]];
  let word = '';
  let quote: string | undefined;
  const endWord = () => { if (word) segments[segments.length - 1].push(word); word = ''; };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined; else word += ch;
      continue;
    }
    if (ch === '"' || (!cmdQuotes && ch === "'")) { quote = ch; continue; }
    if (/[&|;(){}`\r\n]/.test(ch)) { endWord(); if (segments[segments.length - 1].length > 0) segments.push([]); continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    word += ch;
  }
  endWord();
  return segments.filter((segment) => segment.length > 0);
}

/** Skip POSIX assignments and an `env` prefix: `CI=1 npm i -g x`, `env X=1 npm i -g x`. */
function commandStart(argv: readonly string[]): number {
  let start = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? '')) start++;
  if (executableName(argv[start]) === 'env') {
    start++;
    while (argv[start] === '--' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? '')) start++;
  }
  return start;
}

interface Reader {
  read(file: string): Promise<string | undefined>;
}

function budgetedReader(context: GlobalInstallContext): Reader {
  const deadline = Date.now() + (context.budgetMs ?? 1000);
  const read = context.readFile ?? (async (file: string) => {
    try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
  });
  return {
    async read(file: string): Promise<string | undefined> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), remaining); timer.unref?.(); });
      try { return await Promise.race([read(file), timeout]); } finally { if (timer) clearTimeout(timer); }
    },
  };
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function insideRoots(target: string, context: GlobalInstallContext): boolean {
  const api = pathApiFor(context.platform ?? process.platform);
  const absolute = api.resolve(context.cwd, target);
  // Segment-aware: a project child named `..cache` is inside; only a real `..` segment leaves the root.
  return context.roots.some((root) => isPathInsideOrEqual(root, absolute, api));
}

/** `<venv>/bin/<exe>` or `<venv>\Scripts\<exe>` where `<venv>` has a virtual-environment name or a pyvenv.cfg. */
async function isProjectVenvExecutable(token: string, context: GlobalInstallContext, reader: Reader): Promise<boolean> {
  const parts = token.split(/[\\/]/);
  if (parts.length < 3) return false;
  const binDir = parts.at(-2)!.toLowerCase();
  if (binDir !== 'bin' && binDir !== 'scripts') return false;
  const venv = parts.slice(0, -2).join('/');
  if (!venv || !insideRoots(venv, context)) return false;
  if (VENV_NAMES.has(parts.at(-3)!.toLowerCase())) return true;
  const api = pathApiFor(context.platform ?? process.platform);
  return (await reader.read(api.join(api.resolve(context.cwd, venv), 'pyvenv.cfg'))) !== undefined;
}

/** An earlier segment that activates a project virtual environment: `source .venv/bin/activate`, `.venv\Scripts\activate`. */
async function activatesProjectVenv(argv: readonly string[], context: GlobalInstallContext, reader: Reader): Promise<boolean> {
  const verb = executableName(argv[0]);
  const script = verb === 'source' || argv[0] === '.' ? argv[1] : argv[0];
  if (!script || !/[\\/](?:bin|scripts)[\\/]activate(?:\.bat|\.ps1|\.fish|\.csh)?$/i.test(script)) return false;
  const parts = script.split(/[\\/]/);
  return isProjectVenvExecutable([...parts.slice(0, -1), 'python'].join('/'), context, reader);
}

function venvFromEnvironment(context: GlobalInstallContext): boolean {
  const virtualEnv = context.environment?.VIRTUAL_ENV;
  return typeof virtualEnv === 'string' && virtualEnv.trim() !== '' && insideRoots(virtualEnv, context);
}

/** `NAME=value` words before the executable (`PIP_TARGET=x pip install …`, `env npm_config_prefix=x npm i …`). */
function assignmentsOf(prefix: readonly string[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const word of prefix) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    if (match) assignments.set(match[1].toLowerCase(), match[2]);
  }
  return assignments;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);

/**
 * The values of a command's destination options: `--name value`, `--name=value`, and for each listed short flag
 * `-f value` and `-fvalue`. An option given without a value yields an empty string, which no folder contains.
 */
function optionValues(args: readonly string[], long: readonly string[], short: readonly string[] = []): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    const name = long.find((option) => word === option || word.startsWith(`${option}=`));
    if (name) { values.push(word === name ? args[++index] ?? '' : word.slice(name.length + 1)); continue; }
    const flag = short.find((option) => word === option || (word.startsWith(option) && word.length > option.length && !word.startsWith('--')));
    if (flag) values.push(word === flag ? args[++index] ?? '' : word.slice(flag.length));
  }
  return values;
}

/** The first word that is not an option, skipping the values of the listed options. */
function subcommandOf(args: readonly string[], valueOptions: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (valueOptions.includes(word)) { index++; continue; }
    if (!word.startsWith('-')) return word.toLowerCase();
  }
  return undefined;
}

/** The first named destination outside the agent's folders, if any. */
function outsideDestination(destinations: readonly string[], context: GlobalInstallContext): string | undefined {
  return destinations.find((destination) => destination === '' || !insideRoots(destination, context));
}

/**
 * Where a pip install goes when the command says so itself. An explicit destination decides before the interpreter
 * does: a project virtual environment's pip still installs wherever `--target`, `--prefix`, `--root` or `--home`
 * sends it, and `--user` (or PIP_USER) always installs into the user's site-packages.
 */
function pipDestination(args: readonly string[], assignments: Map<string, string>):
  { user: boolean; destinations: string[] } {
  const user = args.includes('--user') || TRUE_WORDS.has((assignments.get('pip_user') ?? '').toLowerCase());
  const destinations = optionValues(args, ['--target', '--prefix', '--root', '--home'], ['-t']);
  for (const variable of ['pip_target', 'pip_prefix', 'pip_root']) {
    const value = assignments.get(variable);
    if (value !== undefined) destinations.push(value);
  }
  return { user, destinations };
}

function playwrightWhere(platform: NodeJS.Platform, environment: Readonly<NodeJS.ProcessEnv> | undefined): string {
  const configured = environment?.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== '0') return `the Playwright browser folder set by PLAYWRIGHT_BROWSERS_PATH (${configured})`;
  if (platform === 'win32') return 'the Playwright browser cache in your user profile (%LOCALAPPDATA%\\ms-playwright)';
  if (platform === 'darwin') return 'the Playwright browser cache in your user profile (~/Library/Caches/ms-playwright)';
  return 'the Playwright browser cache in your user profile (~/.cache/ms-playwright)';
}

const PLAYWRIGHT_SIZE = 'roughly 100-200 MB for each browser, several hundred MB when every browser is downloaded';

/** A package specifier's name, and whether it names an exact version or tag. `@scope/x@1`, `x@latest`. */
function packageName(specifier: string): { name: string; versioned: boolean; remote: boolean; local: boolean } {
  if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return { name: specifier, versioned: false, remote: false, local: true };
  const scoped = specifier.startsWith('@');
  const at = specifier.indexOf('@', scoped ? 1 : 0);
  const name = at === -1 ? specifier : specifier.slice(0, at);
  const remote = /:/.test(name) || (!scoped && name.includes('/'));
  return { name, versioned: at !== -1, remote, local: false };
}

interface ExecTarget {
  /** Packages the exec names with -p/--package, or the command word itself. */
  readonly packages: string[];
  /** The command word that runs (the bin), when one is named. */
  readonly command?: string;
  readonly commandIndex?: number;
  /** The packages were named with -p/--package, so the command word is a command, not a package. */
  readonly fromPackageOption: boolean;
  /** An option this reading does not know, or `-c`: the packages it runs cannot be named. */
  readonly unreadable: boolean;
}

/** `npx [-y|--yes|--no|-q] [-p <pkg>]... <command> ...` and `npm exec|x [same] [--] <command> ...`. */
function readExec(argv: readonly string[], from: number): ExecTarget {
  const packages: string[] = [];
  let unreadable = false;
  let index = from;
  for (; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--') { index++; break; }
    if (!word.startsWith('-')) break;
    if (word === '-y' || word === '--yes' || word === '--no' || word === '--no-install' || word === '-q' || word === '--quiet') continue;
    if (word === '-p' || word === '--package') { const value = argv[++index]; if (value) packages.push(value); else unreadable = true; continue; }
    if (word.startsWith('--package=')) { packages.push(word.slice('--package='.length)); continue; }
    unreadable = true; // -c / --call and every option this reading does not know
    if (word === '-c' || word === '--call') index++;
  }
  const command = argv[index];
  return { packages: packages.length > 0 ? packages : command ? [command] : [], command, commandIndex: command ? index : undefined,
    fromPackageOption: packages.length > 0, unreadable };
}

interface Declared {
  readonly names: Set<string>;
  readonly bins: Set<string>;
}

/**
 * The packages the project declares: `dependencies` and `devDependencies` of every package.json from the command's
 * folder up to the agent folder that holds it, and the command names (`bin`) those declared packages provide where
 * they are installed. A package.json that cannot be read declares nothing.
 */
async function declaredPackages(context: GlobalInstallContext, reader: Reader): Promise<Declared> {
  const api = pathApiFor(context.platform ?? process.platform);
  const names = new Set<string>();
  const bins = new Set<string>();
  const folders: string[] = [];
  let folder = api.resolve(context.cwd);
  const roots = context.roots.map((root) => api.resolve(root));
  for (let depth = 0; depth < 16; depth++) {
    folders.push(folder);
    if (roots.includes(folder)) break;
    const parent = api.dirname(folder);
    if (parent === folder || !insideRoots(parent, context)) break;
    folder = parent;
  }
  for (const dir of folders) {
    const text = await reader.read(api.join(dir, 'package.json'));
    if (text === undefined) continue;
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { continue; }
    const declared = new Set<string>();
    for (const field of ['dependencies', 'devDependencies']) {
      const map = (manifest as Record<string, unknown> | null)?.[field];
      if (map && typeof map === 'object' && !Array.isArray(map)) for (const name of Object.keys(map)) declared.add(name);
    }
    for (const name of [...declared].slice(0, MAX_DECLARED_DEPENDENCIES)) {
      names.add(name);
      const installed = await reader.read(api.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
      if (installed === undefined) continue;
      let bin: unknown;
      try { bin = (JSON.parse(installed) as { bin?: unknown }).bin; } catch { continue; }
      if (typeof bin === 'string') bins.add(name.split('/').at(-1)!);
      else if (bin && typeof bin === 'object') for (const key of Object.keys(bin)) bins.add(key);
    }
  }
  return { names, bins };
}

/** Whether running this exec target can fetch a package the project does not declare. */
async function execFetchesUndeclared(target: ExecTarget, context: GlobalInstallContext, reader: Reader,
  declared: () => Promise<Declared>): Promise<boolean> {
  if (target.unreadable || target.packages.length === 0) return true;
  for (const specifier of target.packages) {
    const parsed = packageName(specifier);
    if (parsed.local) continue;
    if (parsed.remote || parsed.versioned) return true;
    const known = await declared();
    if (known.names.has(parsed.name)) continue;
    if (!target.fromPackageOption && known.bins.has(parsed.name)) continue;
    return true;
  }
  return false;
}

/**
 * The installs outside the project in this command, one per matching segment, in order. An empty list means none
 * of the listed forms was recognised, nothing more.
 */
export async function recognizeGlobalInstalls(
  command: string,
  shell: Pick<CommandShellIdentity, 'kind' | 'grammar'>,
  context: GlobalInstallContext,
): Promise<RecognizedGlobalInstall[]> {
  const text = (command ?? '').trim();
  if (!text) return [];
  const platform = context.platform ?? process.platform;
  const reader = budgetedReader(context);
  let declaredCache: Promise<Declared> | undefined;
  const declared = () => (declaredCache ??= declaredPackages(context, reader));
  const found: RecognizedGlobalInstall[] = [];
  let venvActive = venvFromEnvironment(context);
  for (const segment of installSegments(text, shell)) {
    const start = commandStart(segment);
    const argv = segment.slice(start);
    const verb = executableName(argv[0]);
    const add = (family: GlobalInstallFamily, where: string, size = SIZE_UNKNOWN) => found.push({ family, argv: segment, where, size });
    if (await activatesProjectVenv(argv, context, reader)) { venvActive = true; continue; }

    // npm / pnpm / yarn global installs, and a project install that a destination option sends outside the project.
    const assignments = assignmentsOf(segment.slice(0, start));
    const redirected = (tool: string, destination: string) =>
      add('package-manager-global', `the folder ${tool} was told to install into (${destination || 'no folder given'}), outside the project`);
    if (verb === 'npm') {
      const words = argv.slice(1);
      const sub = subcommandOf(words, ['--prefix', '-C']);
      const viaEnvironment = TRUE_WORDS.has((assignments.get('npm_config_global') ?? '').toLowerCase())
        || (assignments.get('npm_config_location') ?? '').toLowerCase() === 'global';
      if (sub && NPM_INSTALL_WORDS.has(sub) && (viaEnvironment || words.some((word) => GLOBAL_FLAGS.has(word.toLowerCase())))) {
        add('package-manager-global', "npm's global folder (the prefix `npm prefix -g` prints), for every project of this user");
        continue;
      }
      const prefixes = optionValues(words, ['--prefix'], ['-C']);
      const prefixed = assignments.get('npm_config_prefix');
      if (prefixed !== undefined) prefixes.push(prefixed);
      const outside = outsideDestination(prefixes, context);
      if (sub && (NPM_INSTALL_WORDS.has(sub) || sub === 'ci') && outside !== undefined) { redirected('npm', outside); continue; }
    }
    if (verb === 'pnpm') {
      const words = argv.slice(1);
      const sub = subcommandOf(words, ['--dir', '-C', '--modules-dir']);
      if (sub && PNPM_INSTALL_WORDS.has(sub) && words.some((word) => GLOBAL_FLAGS.has(word.toLowerCase()))) {
        add('package-manager-global', "pnpm's global folder (`pnpm root -g`), for every project of this user");
        continue;
      }
      const outside = outsideDestination(optionValues(words, ['--dir', '--modules-dir'], ['-C']), context);
      if (sub && PNPM_INSTALL_WORDS.has(sub) && outside !== undefined) { redirected('pnpm', outside); continue; }
    }
    if (verb === 'yarn') {
      const words = argv.slice(1);
      const sub = subcommandOf(words, ['--cwd', '--modules-folder']);
      if (sub === 'global' && subcommandOf(words.slice(words.findIndex((word) => word.toLowerCase() === 'global') + 1), []) === 'add') {
        add('package-manager-global', "Yarn's global folder (`yarn global dir`), for every project of this user");
        continue;
      }
      const outside = outsideDestination(optionValues(words, ['--cwd', '--modules-folder']), context);
      if ((sub === undefined || sub === 'add' || sub === 'install') && outside !== undefined) { redirected('yarn', outside); continue; }
    }

    // Playwright browser downloads, whichever runner starts it.
    let playwrightAt: number | undefined;
    if (verb === 'playwright') playwrightAt = 1;
    else if (verb === 'npx' || ((verb === 'npm' || verb === 'pnpm') && (argv[1] === 'exec' || (verb === 'npm' && argv[1] === 'x')))) {
      const target = readExec(argv, verb === 'npx' ? 1 : 2);
      if (target.command && target.commandIndex !== undefined && PLAYWRIGHT_PACKAGES.has(packageName(target.command).name)) {
        playwrightAt = target.commandIndex + 1;
      }
    } else if (PYTHON_EXECUTABLE.test(verb) && argv[1] === '-m' && argv[2] === 'playwright') playwrightAt = 3;
    if (playwrightAt !== undefined) {
      const sub = argv[playwrightAt]?.toLowerCase();
      if (sub === 'install') { add('playwright-browsers', playwrightWhere(platform, context.environment), PLAYWRIGHT_SIZE); continue; }
      if (sub === 'install-deps') { add('system-package-manager', "the operating system's own packages (Playwright's system dependencies)"); continue; }
    }

    // System package managers.
    const sub1 = argv[1]?.toLowerCase();
    if ((verb === 'winget' && (sub1 === 'install' || sub1 === 'add')) || (verb === 'choco' && sub1 === 'install')
      || verb === 'cinst' || (verb === 'scoop' && sub1 === 'install')) {
      add('system-package-manager', `the system, through ${verb === 'cinst' ? 'choco' : verb} (programs for this machine or this user)`);
      continue;
    }

    // pip outside a project virtual environment.
    let pipArgs: readonly string[] | undefined;
    let interpreter: string | undefined;
    if (PIP_EXECUTABLE.test(verb) && sub1 === 'install') { pipArgs = argv.slice(2); interpreter = argv[0]; }
    else if (PYTHON_EXECUTABLE.test(verb) && argv[1] === '-m' && PIP_EXECUTABLE.test(argv[2] ?? '') && argv[3]?.toLowerCase() === 'install') {
      pipArgs = argv.slice(4); interpreter = argv[0];
    }
    if (pipArgs && interpreter !== undefined) {
      const destination = pipDestination(pipArgs, assignments);
      if (destination.user) {
        add('pip-outside-venv', "Python's user site-packages (pip --user), for every project of this user");
      } else if (destination.destinations.length > 0) {
        const outside = outsideDestination(destination.destinations, context);
        if (outside !== undefined) {
          add('pip-outside-venv', `the folder pip was told to install into (${outside || 'no folder given'}), outside the project`);
        }
      } else {
        const hasPath = /[\\/]/.test(interpreter);
        const projectLocal = hasPath ? await isProjectVenvExecutable(interpreter, context, reader) : venvActive;
        if (!projectLocal) {
          add('pip-outside-venv', "the Python environment this pip belongs to (system or user site-packages), not a project virtual environment");
        }
      }
      continue;
    }

    // npx / npm exec of a package the project does not declare.
    if (verb === 'npx' || (verb === 'npm' && (argv[1] === 'exec' || argv[1] === 'x'))) {
      const target = readExec(argv, verb === 'npx' ? 1 : 2);
      if (await execFetchesUndeclared(target, context, reader, declared)) {
        add('npx-undeclared', "npm's cache folder (the _npx folder under `npm config get cache`), outside the project");
      }
    }
  }
  return found;
}

/** The text the existing approval card carries for these installs: what, where, and the size where known. */
export function globalInstallNote(installs: readonly RecognizedGlobalInstall[]): string {
  const lines = installs.map((install) => `- ${install.argv.join(' ')}\n  Installs to: ${install.where}. Size: ${install.size}.`);
  return [
    `This command installs outside the project:`,
    ...lines,
    'Approve to run it this once. If you deny it, nothing is installed and the agent continues with the work that does not need it.',
  ].join('\n');
}
