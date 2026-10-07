/*---------------------------------------------------------------------------------------------
 *  UnodeAi - FileMentions  (#8: @file references in chat)
 *  Lets a user reference workspace files inline in a chat message with `@path`. Before the message
 *  is routed to the agent, each mention is resolved (workspace-relative, sandbox-guarded, size-capped)
 *  and the file contents are appended in an <attached_files> block — so the agent sees the file
 *  without the user pasting it.
 *
 *  Pure / file-read injectable so it's unit-testable without vscode.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';

export type FileReader = (absPath: string) => Promise<string>;
/** Resolves symlinks/junctions to a canonical absolute path (fs.realpath); injectable for tests. */
export type RealPathResolver = (absPath: string) => Promise<string>;
export type MentionFilter = (mention: string) => boolean;
const defaultRealPath: RealPathResolver = (p) => fs.realpath(p);

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 60_000;

/** Matches `@path` tokens: an @ at start or after whitespace, then a non-space run. */
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;

/** Extract unique @path mentions from text, trimming common trailing punctuation. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[1].replace(/[),.;:]+$/, ''); // strip trailing punctuation like "@a.ts,"
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/** True when `abs` is the root itself or sits inside it (string-level containment). */
function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/** Resolve a mention under root, returning the absolute path only if it stays inside the workspace. */
function safeResolve(root: string, rel: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, rel);
  return isInside(resolvedRoot, abs) ? abs : undefined; // escapes the workspace (e.g. ../../etc/passwd)
}

/**
 * Expand `@path` mentions in `text` into an appended <attached_files> block. Unreadable mentions /
 * non-paths are silently left as-is (so "@teammate" isn't treated as a file). Returns the original
 * text unchanged when nothing resolves. Never throws.
 */
export async function expandFileMentions(
  text: string,
  root: string,
  readFile: FileReader,
  realpath: RealPathResolver = defaultRealPath,
  shouldExpand: MentionFilter = () => true
): Promise<string> {
  const mentions = parseMentions(text);
  if (mentions.length === 0) {
    return text;
  }
  // Resolve the workspace root's real path once; if it can't be resolved, skip realpath guarding is
  // unsafe, so bail out (return text unchanged) rather than risk reading outside the sandbox.
  let realRoot: string;
  try {
    realRoot = await realpath(path.resolve(root));
  } catch {
    return text;
  }
  const blocks: string[] = [];
  let total = 0;
  for (const rel of mentions) {
    if (!shouldExpand(rel)) {
      continue;
    }
    const abs = safeResolve(root, rel);
    if (!abs) {
      continue;
    }
    // Realpath guard: a symlink/junction inside the workspace could resolve to a file OUTSIDE it.
    // Resolve the target and re-check containment against the real root before reading.
    let realAbs: string;
    try {
      realAbs = await realpath(abs);
    } catch {
      continue; // doesn't exist / not resolvable — leave the mention as plain text
    }
    if (!isInside(realRoot, realAbs)) {
      continue; // escapes the workspace via a symlink/junction
    }
    let content: string;
    try {
      content = await readFile(realAbs);
    } catch {
      continue; // not a readable file (or doesn't exist) — leave the mention as plain text
    }
    if (total >= TOTAL_MAX) {
      break;
    }
    let body = content.length > PER_FILE_MAX ? content.slice(0, PER_FILE_MAX) + '\n…(truncated)' : content;
    if (total + body.length > TOTAL_MAX) {
      body = body.slice(0, TOTAL_MAX - total) + '\n…(truncated)';
    }
    total += body.length;
    blocks.push(`--- ${rel} ---\n${body}`);
  }
  if (blocks.length === 0) {
    return text;
  }
  return `${text}\n\n<attached_files>\n${blocks.join('\n\n')}\n</attached_files>`;
}
