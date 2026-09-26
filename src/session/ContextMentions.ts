/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ContextMentions  (C1: @folder / @problems / @url)
 *  Pure aggregator for chat @-context. vscode and network access stay injected by extension.ts so
 *  this module remains unit-testable and never fetches anything unless the user typed an explicit
 *  @url mention.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { expandFileMentions, FileReader, parseMentions, RealPathResolver } from './FileMentions';

export type PathStat = (absPath: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
export type DirectoryEntry = { name: string; isDirectory(): boolean; isFile(): boolean };
export type DirectoryReader = (absPath: string) => Promise<DirectoryEntry[]>;
export type UrlTextReader = (url: string) => Promise<{ ok: boolean; text: string }>;
export type DiagnosticsProvider = () => DiagnosticsSnapshot;

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagnosticItem {
  file: string;
  line: number;
  col: number;
  severity: DiagnosticSeverity;
  message: string;
  code?: string;
}

export interface DiagnosticsSnapshot {
  items: DiagnosticItem[];
}

export interface ContextMentionDeps {
  readFile: FileReader;
  realpath?: RealPathResolver;
  stat?: PathStat;
  readDir?: DirectoryReader;
  diagnostics?: DiagnosticsProvider;
  fetchText?: UrlTextReader;
}

const defaultRealPath: RealPathResolver = (p) => fs.realpath(p);
const defaultStat: PathStat = (p) => fs.stat(p);
const defaultReadDir: DirectoryReader = (p) => fs.readdir(p, { withFileTypes: true });

const PER_SOURCE_MAX = 20_000;
const TOTAL_CONTEXT_MAX = 60_000;
const FOLDER_MAX_ENTRIES = 200;
const FOLDER_MAX_DEPTH = 2;
const PROBLEMS_MAX = 100;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'out-e2e', 'dist', 'build', '.vscode-test']);

export async function expandContextMentions(
  text: string,
  root: string,
  deps: ContextMentionDeps
): Promise<string> {
  try {
    const realpath = deps.realpath ?? defaultRealPath;
    const fileExpanded = await expandFileMentions(text, root, deps.readFile, realpath, isFileMentionCandidate);
    const mentions = parseMentions(text);
    if (mentions.length === 0) {
      return fileExpanded;
    }

    const context = await buildContextBlocks(root, mentions, {
      ...deps,
      realpath,
      stat: deps.stat ?? defaultStat,
      readDir: deps.readDir ?? defaultReadDir,
    });
    if (context.length === 0) {
      return fileExpanded;
    }
    return `${fileExpanded}\n\n<attached_context>\n${context.join('\n\n')}\n</attached_context>`;
  } catch {
    return text;
  }
}

async function buildContextBlocks(
  root: string,
  mentions: string[],
  deps: Required<Pick<ContextMentionDeps, 'realpath' | 'stat' | 'readDir'>> & ContextMentionDeps
): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await deps.realpath(path.resolve(root));
  } catch {
    return [];
  }

  const blocks: string[] = [];
  let total = 0;
  for (const mention of mentions) {
    let block: string | undefined;
    if (mention === 'problems') {
      block = formatProblems(deps.diagnostics?.() ?? { items: [] });
    } else if (isHttpUrl(mention)) {
      block = await formatUrl(mention, deps.fetchText);
    } else {
      block = await formatFolder(root, realRoot, mention, deps);
    }
    if (!block) {
      continue;
    }
    if (total >= TOTAL_CONTEXT_MAX) {
      break;
    }
    if (total + block.length > TOTAL_CONTEXT_MAX) {
      block = block.slice(0, TOTAL_CONTEXT_MAX - total) + '\n...(truncated)';
    }
    total += block.length;
    blocks.push(block);
  }
  return blocks;
}

async function formatFolder(
  root: string,
  realRoot: string,
  rel: string,
  deps: Required<Pick<ContextMentionDeps, 'realpath' | 'stat' | 'readDir'>>
): Promise<string | undefined> {
  const abs = safeResolve(root, rel);
  if (!abs) {
    return undefined;
  }
  let realAbs: string;
  try {
    realAbs = await deps.realpath(abs);
  } catch {
    return undefined;
  }
  if (!isInside(realRoot, realAbs)) {
    return undefined;
  }
  try {
    if (!(await deps.stat(realAbs)).isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const entries = await listFolderTree(realAbs, rel.replace(/[\\/]+$/, ''), realRoot, deps);
  if (entries.length === 0) {
    return `--- @${rel} (folder) ---\n(empty)`;
  }
  // Traversal stops shortly after the cap, so we can't know the exact remaining count — state the
  // truncation honestly rather than printing a misleading "(N more)". (Codex review of v0.3.0.)
  const more = entries.length > FOLDER_MAX_ENTRIES ? [`...(truncated at ${FOLDER_MAX_ENTRIES} entries)`] : [];
  return `--- @${rel} (folder) ---\n${entries.slice(0, FOLDER_MAX_ENTRIES).concat(more).join('\n')}`;
}

async function listFolderTree(
  absDir: string,
  displayRoot: string,
  realRoot: string,
  deps: Required<Pick<ContextMentionDeps, 'realpath' | 'readDir'>>,
  depth = 0,
  out: string[] = []
): Promise<string[]> {
  if (depth > FOLDER_MAX_DEPTH || out.length > FOLDER_MAX_ENTRIES) {
    return out;
  }
  let entries: DirectoryEntry[];
  try {
    entries = await deps.readDir(absDir);
  } catch {
    return out;
  }
  entries = entries
    .filter((e) => !SKIP_DIRS.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length > FOLDER_MAX_ENTRIES) {
      break;
    }
    const childAbs = path.join(absDir, entry.name);
    const display = slash(path.join(displayRoot, entry.name)) + (entry.isDirectory() ? '/' : '');
    out.push(display);
    if (entry.isDirectory() && depth < FOLDER_MAX_DEPTH) {
      let realChild: string;
      try {
        realChild = await deps.realpath(childAbs);
      } catch {
        continue;
      }
      if (isInside(realRoot, realChild)) {
        await listFolderTree(realChild, path.join(displayRoot, entry.name), realRoot, deps, depth + 1, out);
      }
    }
  }
  return out;
}

function formatProblems(snapshot: DiagnosticsSnapshot): string {
  const items = [...snapshot.items].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.col - b.col
  );
  const errors = items.filter((i) => i.severity === 'error').length;
  const warnings = items.filter((i) => i.severity === 'warning').length;
  if (items.length === 0) {
    return '--- @problems --- (none)';
  }
  const lines = items.slice(0, PROBLEMS_MAX).map((i) => {
    const code = i.code ? `${i.code}: ` : '';
    return `${i.file}:${i.line}:${i.col} ${i.severity} ${code}${oneLine(i.message)}`;
  });
  if (items.length > PROBLEMS_MAX) {
    lines.push(`...(${items.length - PROBLEMS_MAX} more)`);
  }
  return `--- @problems (${errors} errors, ${warnings} warnings) ---\n${lines.join('\n')}`;
}

async function formatUrl(url: string, fetchText?: UrlTextReader): Promise<string | undefined> {
  if (!fetchText) {
    return undefined;
  }
  try {
    const result = await fetchText(url);
    if (!result.ok || !result.text.trim()) {
      return undefined;
    }
    const text = stripHtml(result.text);
    const body = text.length > PER_SOURCE_MAX ? `${text.slice(0, PER_SOURCE_MAX)}\n...(truncated)` : text;
    return `--- @${url} (url) ---\n${body}`;
  } catch {
    return undefined;
  }
}

function safeResolve(root: string, rel: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, rel);
  return isInside(resolvedRoot, abs) ? abs : undefined;
}

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isFileMentionCandidate(value: string): boolean {
  return value !== 'problems' && !isHttpUrl(value);
}

function severityRank(severity: DiagnosticSeverity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : severity === 'info' ? 2 : 3;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function slash(value: string): string {
  return value.split(path.sep).join('/');
}
