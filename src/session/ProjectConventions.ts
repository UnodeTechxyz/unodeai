/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ProjectConventions  (A1 + A2: agent robustness)
 *  Auto-detects how THIS project is built/tested (package.json scripts + package manager) and
 *  produces a guidance block that's injected into every agent's system prompt via the same
 *  project-context channel as .unode/rules.md.
 *
 *  Why: weaker/cheaper agents don't reliably read package.json before running commands — they invent
 *  `npx vitest` instead of the project's `npm test`, hit "No test suite found", and misattribute it to
 *  "broken infrastructure". Claude reads the scripts; UnodeAi makes EVERY agent robust by handing
 *  the conventions to it up front (A1) plus explicit behavioral guidance (A2). Pure / file-read
 *  injectable so it's unit-testable without vscode.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectCommandInfo } from '../backend/commandNormalize';

export type FileReader = (filePath: string) => Promise<string>;
const defaultReader: FileReader = (p) => fs.readFile(p, 'utf8');

/** Lists the immediate SUBDIRECTORY names of a directory (for the project-layout map). */
export type DirLister = (dir: string) => Promise<string[]>;
const defaultLister: DirLister = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
};

/** Cap how many scripts / how long each script line we inject, to bound prompt size. */
const MAX_SCRIPTS = 25;
const MAX_SCRIPT_LEN = 120;
/** Dirs never worth showing an agent (generated/vendored/tooling). */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'out-e2e', 'dist', 'build', '.vscode-test', 'coverage', '.unode', '.npm-cache', '.worktrees', '.vscode', 'tmp']);
const MAX_DIRS = 24;

const EMPTY_INFO: ProjectCommandInfo = { packageManager: 'npm', scripts: {} };

/** Detected stack + top-level layout, injected so agents don't guess where files live. */
export interface ProjectMap { stack: string[]; dirs: string[]; }

export class ProjectConventions {
  private block = '';
  private info: ProjectCommandInfo = EMPTY_INFO;

  constructor(
    private root: string,
    private readFile: FileReader = defaultReader,
    private listDir: DirLister = defaultLister
  ) {}

  /** Last-detected conventions block ('' when there's nothing useful to inject). */
  get(): string {
    return this.block;
  }

  /** Structured package-manager + scripts, for command normalization (see commandNormalize). */
  getInfo(): ProjectCommandInfo {
    return this.info;
  }

  /** (Re)detect from disk. Never throws — a missing/invalid package.json yields ''/empty info. */
  async load(): Promise<string> {
    this.info = await detectProjectInfo(this.root, this.readFile);
    const map = await detectProjectMap(this.root, this.readFile, this.listDir);
    this.block = [buildConventionsBlock(this.info), buildProjectMapBlock(map)]
      .filter((s) => s.trim())
      .join('\n\n');
    return this.block;
  }
}

/** Detect the stack (language + test framework) and the top-level directory layout. */
export async function detectProjectMap(root: string, readFile: FileReader, listDir: DirLister): Promise<ProjectMap> {
  const stack: string[] = [];
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
  } catch { /* no/invalid package.json — stack stays minimal */ }
  const deps: Record<string, unknown> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if ('typescript' in deps || (await exists(readFile, path.join(root, 'tsconfig.json')))) {
    stack.push('TypeScript');
  }
  const testFw = ['vitest', 'jest', 'mocha', 'ava', 'jasmine', 'playwright', 'cypress'].find((t) => t in deps);
  if (testFw) {
    stack.push(`tests: ${testFw}`);
  }
  const dirs = (await listDir(root).catch(() => []))
    .filter((d) => !d.startsWith('.') && !IGNORED_DIRS.has(d))
    .sort()
    .slice(0, MAX_DIRS);
  return { stack, dirs };
}

/** Build the project-layout block. '' when there's nothing useful (no stack and no dirs). */
export function buildProjectMapBlock(map: ProjectMap): string {
  if (map.stack.length === 0 && map.dirs.length === 0) {
    return '';
  }
  const lines: string[] = ["## Project layout (auto-detected — don't guess paths)"];
  if (map.stack.length) {
    lines.push(`- Stack: ${map.stack.join(', ')}.`);
  }
  if (map.dirs.length) {
    lines.push(`- Top-level directories: ${map.dirs.map((d) => `\`${d}/\``).join(', ')}.`);
    lines.push(
      '- Put a new file under an EXISTING directory that fits. Do NOT invent a new path (e.g. a sibling/nested data dir) — verify a directory exists with list_dir or search_files before writing into it.'
    );
  }
  return lines.join('\n');
}

/** Parse package.json scripts + detect the package manager. Empty info on missing/invalid package.json. */
export async function detectProjectInfo(root: string, readFile: FileReader): Promise<ProjectCommandInfo> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, 'package.json'));
  } catch {
    return EMPTY_INFO;
  }
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return EMPTY_INFO;
  }
  const scripts: Record<string, string> = {};
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [name, body] of Object.entries(pkg.scripts)) {
      scripts[name] = String(body ?? '');
    }
  }
  return { packageManager: await detectPackageManager(root, readFile), scripts };
}

/** Build the injected guidance block from detected info. Returns '' when there are no scripts. */
export function buildConventionsBlock(info: ProjectCommandInfo): string {
  const names = Object.keys(info.scripts);
  if (names.length === 0) {
    return '';
  }
  const pm = info.packageManager;
  const lines: string[] = [
    '## Project conventions (auto-detected — follow these)',
    `- Package manager: ${pm}.`,
    `- To build / test / lint, use the project's scripts below (e.g. \`${pm} test\`, \`${pm} run build\`). Do NOT invent commands — never call \`npx vitest\` / \`npx tsc\` / a global tool directly when a script exists for it.`,
    '- If a command fails with "not found" or "No test suite found", re-check the exact command against these scripts. Do NOT conclude the environment or infrastructure is broken — that is almost always a wrong command, not an infra problem.',
    '- Available scripts:',
  ];
  for (const name of names.slice(0, MAX_SCRIPTS)) {
    const body = info.scripts[name];
    lines.push(`  - ${name}: ${body.length > MAX_SCRIPT_LEN ? body.slice(0, MAX_SCRIPT_LEN) + '…' : body}`);
  }
  if (names.length > MAX_SCRIPTS) {
    lines.push(`  - …and ${names.length - MAX_SCRIPTS} more.`);
  }
  return lines.join('\n');
}

/**
 * Pick a sensible verify command from the project's OWN scripts (test → typecheck → check → build → lint),
 * using the detected package manager. Returns '' when nothing runnable exists — so the gate stays disabled
 * instead of inventing a command. This is what lets `run_checks` work out of the box WITHOUT a brittle
 * hardcoded default like `npx tsc --noEmit` (which can never pass on a plain-JS project). `<pm> run <name>`
 * is valid across npm/yarn/pnpm/bun (npm run test === npm test).
 */
export function autoVerifyCommand(info: ProjectCommandInfo): string {
  const scripts = info.scripts ?? {};
  const has = (name: string) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0;
  for (const name of ['test', 'typecheck', 'type-check', 'check', 'build', 'lint']) {
    if (has(name)) { return `${info.packageManager} run ${name}`; }
  }
  return '';
}

/** The EFFECTIVE verify command: the user's explicit `unode.verifyCommand` if set, else the auto-detected one. */
export function resolveVerifyCommand(configured: string | undefined, info: ProjectCommandInfo): string {
  const c = (configured ?? '').trim();
  return c || autoVerifyCommand(info);
}

async function exists(readFile: FileReader, filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string, readFile: FileReader): Promise<string> {
  if (await exists(readFile, path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(readFile, path.join(root, 'yarn.lock'))) return 'yarn';
  if (await exists(readFile, path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Build the conventions block from package.json scripts. Returns '' when there's no package.json or
 * no scripts. Thin wrapper over detectProjectInfo + buildConventionsBlock (kept for existing callers).
 */
export async function detectConventions(root: string, readFile: FileReader): Promise<string> {
  return buildConventionsBlock(await detectProjectInfo(root, readFile));
}
