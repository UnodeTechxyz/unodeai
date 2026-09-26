import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export type RepositoryCliKind = 'claude' | 'codex';
export type RepositoryAutomationMode = 'native' | 'user-only';

export interface RepositoryCliLaunchApproval {
  mode: RepositoryAutomationMode;
  /** Canonical project root used for a process-local native CLI trust override. */
  projectRoot: string;
  /** Re-hash immediately before spawn so a file cannot change after the dialog. */
  assertCurrent: () => void;
}

export interface RepositoryCliInspection {
  kind: RepositoryCliKind;
  workspaceRoot: string;
  cwd: string;
  present: boolean;
  digest: string;
  configPaths: string[];
  summary: string[];
  blockedLinks: string[];
}

export interface RepositoryCliInspectionOptions {
  /** Test seam and explicit exclusion boundary; configuration inside this directory is never inferred. */
  homeDirectory?: string;
  /** Test-only virtual filesystem ceiling. Production discovery always reaches the real volume root. */
  ancestorBoundary?: string;
}

export interface RepositoryCliTrustRecord {
  version: 1;
  kind: RepositoryCliKind;
  workspaceRoot: string;
  cwd: string;
  digest: string;
  mode: RepositoryAutomationMode;
  grantedAt: string;
}

const MAX_DISCOVERY_DEPTH = 64;
const MAX_CONFIG_FILES = 512;
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

/**
 * Inspect only the exact project-configuration locations used by the selected CLI. The walk is
 * bounded to those directories after their presence is established; it never scans the repository
 * and never follows a link or junction.
 */
export function inspectRepositoryCliConfig(
  kind: RepositoryCliKind,
  workspaceRoot: string,
  cwd: string,
  options: RepositoryCliInspectionOptions = {},
): RepositoryCliInspection {
  const canonicalWorkspace = canonicalDirectory(workspaceRoot);
  const canonicalCwd = canonicalDirectory(cwd);
  // HOME is an exclusion sentinel, never an inspection target. Resolve its spelling without
  // touching the directory: realpath can be denied by an otherwise valid Windows sandbox.
  const canonicalHome = path.resolve(options.homeDirectory ?? homedir());
  const canonicalBoundary = options.ancestorBoundary
    ? canonicalDirectory(options.ancestorBoundary)
    : path.parse(canonicalCwd).root;
  if (!isInside(canonicalWorkspace, canonicalCwd)) {
    throw new Error('CLI repository configuration cannot be inspected outside the bound workspace.');
  }
  if (!isInside(canonicalBoundary, canonicalCwd)) {
    throw new Error('CLI configuration discovery boundary does not contain the working directory.');
  }

  const candidates = discoveryCandidates(kind, canonicalWorkspace, canonicalCwd, canonicalHome, canonicalBoundary);
  const files: Array<{ absolute: string; relative: string; bytes: Buffer }> = [];
  const configPaths: string[] = [];
  const blockedLinks: string[] = [];
  let totalBytes = 0;

  const addFile = (absolute: string, labelRoot = canonicalWorkspace): void => {
    const relative = slash(path.relative(labelRoot, absolute));
    const bytes = readFileSync(absolute);
    totalBytes += bytes.byteLength;
    if (files.length >= MAX_CONFIG_FILES || totalBytes > MAX_CONFIG_BYTES) {
      throw new Error('CLI repository configuration is too large to review safely.');
    }
    files.push({ absolute, relative, bytes });
  };

  const walkConfigDirectory = (directory: string): void => {
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const relative = slash(path.relative(canonicalWorkspace, absolute));
        const stat = lstatSync(absolute);
        if (isLinkLike(stat)) {
          blockedLinks.push(relative);
          continue;
        }
        if (stat.isDirectory()) pending.push(absolute);
        else if (stat.isFile()) addFile(absolute);
      }
    }
  };

  for (const candidate of candidates) {
    let stat: Stats;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const relative = slash(path.relative(canonicalWorkspace, candidate));
    configPaths.push(relative || path.basename(candidate));
    if (isLinkLike(stat)) {
      blockedLinks.push(relative);
    } else if (stat.isDirectory()) {
      walkConfigDirectory(candidate);
    } else if (stat.isFile()) {
      addFile(candidate);
    }
  }

  const hash = createHash('sha256');
  hash.update('unode-repository-cli-config-v1\0');
  hash.update(kind);
  for (const configPath of [...configPaths].sort()) hash.update(`\0root\0${configPath}`);
  for (const link of [...blockedLinks].sort()) hash.update(`\0blocked-link\0${link}`);
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(`\0file\0${file.relative}\0${file.bytes.byteLength}\0`);
    hash.update(file.bytes);
  }

  return {
    kind,
    workspaceRoot: canonicalWorkspace,
    cwd: canonicalCwd,
    present: configPaths.length > 0,
    digest: hash.digest('hex'),
    configPaths: [...configPaths].sort(),
    summary: summarize(kind, files),
    blockedLinks: [...new Set(blockedLinks)].sort(),
  };
}

export function repositoryCliTrustMatches(
  record: RepositoryCliTrustRecord | undefined,
  inspection: RepositoryCliInspection,
): boolean {
  return !!record
    && record.version === 1
    && record.kind === inspection.kind
    && pathKey(record.workspaceRoot) === pathKey(inspection.workspaceRoot)
    && pathKey(record.cwd) === pathKey(inspection.cwd)
    && record.digest === inspection.digest
    && (record.mode === 'native' || record.mode === 'user-only');
}

export function repositoryCliTrustRecord(
  inspection: RepositoryCliInspection,
  mode: RepositoryAutomationMode,
  now = new Date(),
): RepositoryCliTrustRecord {
  return {
    version: 1,
    kind: inspection.kind,
    workspaceRoot: inspection.workspaceRoot,
    cwd: inspection.cwd,
    digest: inspection.digest,
    mode,
    grantedAt: now.toISOString(),
  };
}

export function repositoryCliTrustKey(kind: RepositoryCliKind, cwd: string): string {
  return `${kind}\0${pathKey(path.resolve(cwd))}`;
}

/** Select the most specific open workspace folder that actually contains this agent cwd. */
export function workspaceRootForCliCwd(workspaceRoots: string[], cwd: string): string | undefined {
  if (!path.isAbsolute(cwd)) return undefined;
  const resolvedCwd = path.resolve(cwd);
  return workspaceRoots
    .filter((root) => path.isAbsolute(root) && isInside(path.resolve(root), resolvedCwd))
    .sort((left, right) => path.resolve(right).length - path.resolve(left).length)[0];
}

/**
 * Build the superset of ancestor configuration locations the real CLIs may load.
 *
 * Claude 2.1.209 was measured walking `.mcp.json` past the nearest `.git`, past HOME, and in a
 * directory tree with no Git marker. Codex 0.155.1 was measured loading the trusted repository
 * root `.codex/config.toml` when launched from a subfolder; its user-configurable root markers mean
 * the extension cannot safely assume `.git` is always the stopping point. Walking exact ancestor
 * locations is cheap and closes both gaps. The user's own HOME `.claude` and `.codex` directories
 * are deliberately excluded; those are native user configuration, not repository configuration.
 */
function discoveryCandidates(
  kind: RepositoryCliKind,
  workspaceRoot: string,
  cwd: string,
  homeDirectory: string,
  ancestorBoundary: string,
): string[] {
  const roots: string[] = [];
  let current = cwd;
  for (let depth = 0; depth < MAX_DISCOVERY_DEPTH; depth++) {
    roots.push(current);
    if (pathKey(current) === pathKey(ancestorBoundary)) break;
    const parent = path.dirname(current);
    if (parent === current || !isInside(ancestorBoundary, parent)) {
      throw new Error('CLI configuration discovery escaped its bounded ancestor chain.');
    }
    current = parent;
  }
  if (pathKey(roots.at(-1) ?? '') !== pathKey(ancestorBoundary)) {
    throw new Error('CLI configuration discovery exceeded its bounded depth.');
  }

  if (kind === 'codex') {
    return roots
      .filter((root) => pathKey(root) !== pathKey(homeDirectory))
      .map((root) => path.join(root, '.codex'));
  }

  const workspaceAncestors = roots.filter((root) => isInside(workspaceRoot, root));
  return [
    ...workspaceAncestors
      .filter((root) => pathKey(root) !== pathKey(homeDirectory))
      .map((root) => path.join(root, '.claude')),
    ...roots.map((root) => path.join(root, '.mcp.json')),
  ];
}

function summarize(
  kind: RepositoryCliKind,
  files: Array<{ absolute: string; relative: string; bytes: Buffer }>,
): string[] {
  const result = new Set<string>();
  for (const file of files) {
    const relative = slash(file.relative);
    const lower = relative.toLowerCase();
    if (/\/(?:skills|agents|commands)\//.test(`/${lower}`)) {
      const group = lower.includes('/skills/') ? 'skill' : lower.includes('/agents/') ? 'agent' : 'slash command';
      result.add(`${kind === 'claude' ? 'Claude' : 'Codex'} project ${group}: ${projectAutomationName(file, group)}`);
      continue;
    }
    if (path.basename(lower) === '.mcp.json' || lower.endsWith('/settings.json') || lower.endsWith('/settings.local.json')) {
      summarizeJson(file.bytes, result);
      result.add(`Project settings: ${relative}`);
      continue;
    }
    if (lower.endsWith('.toml')) {
      summarizeToml(file.bytes, result);
      result.add(`Codex project settings: ${relative}`);
      continue;
    }
    result.add(`Project configuration: ${relative}`);
  }
  return [...result].slice(0, 24);
}

function projectAutomationName(
  file: { absolute: string; bytes: Buffer },
  group: 'skill' | 'agent' | 'slash command',
): string {
  const stem = path.basename(file.absolute, path.extname(file.absolute));
  if (group !== 'skill' || stem.toLowerCase() !== 'skill') return stem;
  const text = file.bytes.toString('utf8');
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const declared = /^\s*name\s*:\s*["']?([^\r\n"']+)["']?\s*$/im.exec(frontmatter)?.[1]?.trim();
  // Names are display-only, but keep untrusted repository text single-line and bounded in the dialog.
  if (declared && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(declared)) return declared;
  return path.basename(path.dirname(file.absolute)) || stem;
}

function summarizeJson(bytes: Buffer, result: Set<string>): void {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const servers = asRecord(parsed.mcpServers ?? parsed.mcp_servers);
    for (const name of Object.keys(servers).sort()) result.add(`MCP server: ${redactedName(name)}`);
    const hooks = asRecord(parsed.hooks);
    for (const name of Object.keys(hooks).sort()) {
      result.add(`Hook group: ${redactedName(name)}`);
      summarizeHookPrograms(hooks[name], result);
    }
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    if (plugins.length > 0) result.add(`${plugins.length} project plugin declaration(s)`);
  } catch {
    // The CLI will report malformed configuration after consent. The dialog still names the file.
  }
}

function summarizeHookPrograms(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) summarizeHookPrograms(entry, result);
    return;
  }
  const record = asRecord(value);
  if (typeof record.command === 'string') {
    const program = commandProgramName(record.command);
    if (program) result.add(`Hook command: ${redactedName(program)}`);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (key !== 'command') summarizeHookPrograms(entry, result);
  }
}

function commandProgramName(command: string): string | undefined {
  const text = command.trim();
  if (!text) return undefined;
  const quoted = /^(?:"([^"]+)"|'([^']+)')/.exec(text);
  const token = (quoted?.[1] ?? quoted?.[2] ?? /^\S+/.exec(text)?.[0] ?? '').trim();
  const basename = token.split(/[\\/]/).at(-1)?.replace(/^['"]|['"]$/g, '');
  return basename || undefined;
}

function summarizeToml(bytes: Buffer, result: Set<string>): void {
  const text = bytes.toString('utf8');
  for (const match of text.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]{1,128})\]\s*$/gm)) {
    result.add(`MCP server: ${redactedName(match[1])}`);
  }
  if (/^\s*notify\s*=/m.test(text)) result.add('Notification command');
  if (/^\s*\[(?:hooks?|plugins?)(?:\.|\])/m.test(text)) result.add('Hook or plugin configuration');
}

function canonicalDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('CLI repository configuration requires absolute paths.');
  return path.resolve(realpathSync.native(value));
}

function isLinkLike(stat: Stats): boolean {
  return stat.isSymbolicLink();
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function slash(value: string): string { return value.split(path.sep).join('/'); }
function pathKey(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function redactedName(value: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : '(name redacted)';
}
