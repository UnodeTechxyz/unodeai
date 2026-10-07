import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

export interface CodexFileChange {
  path: string;
  diff: string;
  /** Legacy App Server add/delete requests provide the complete content instead of a unified diff. */
  content?: string;
  kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null };
}

export interface CodexCheckpointEntry {
  path: string;
  before: string | null;
  after: string;
}

export type CodexCheckpointPreparation =
  | { ok: true; entries: CodexCheckpointEntry[] }
  | { ok: false; reason: string };

const MAX_RESTORABLE_BYTES = 200_000;

/**
 * Materialize the exact before/after snapshots advertised by a pending Codex file-change item.
 * Nothing is written here. Callers record every returned entry before accepting App Server's request.
 */
export function prepareCodexFileCheckpoints(
  workspaceRoot: string,
  writeRoots: readonly string[],
  changes: readonly CodexFileChange[],
): CodexCheckpointPreparation {
  if (changes.length === 0) return { ok: false, reason: 'Codex supplied no file changes to checkpoint.' };
  const entries: CodexCheckpointEntry[] = [];
  for (const change of changes) {
    if (change.kind.move_path) {
      return { ok: false, reason: `Codex move operations cannot yet be restored safely: ${change.path}` };
    }
    const absolute = resolveRestorablePath(workspaceRoot, writeRoots, change.path);
    if (!absolute.ok) return absolute;
    const exists = existsSync(absolute.path);
    if (exists && lstatSync(absolute.path).isSymbolicLink()) {
      return { ok: false, reason: `Codex targeted a symbolic link, which cannot be checkpointed safely: ${change.path}` };
    }
    if (change.kind.type === 'add' && exists) {
      return { ok: false, reason: `Codex described an add for an existing file: ${change.path}` };
    }
    if (change.kind.type !== 'add' && !exists) {
      return { ok: false, reason: `Codex described a ${change.kind.type} for a missing file: ${change.path}` };
    }
    const before = exists ? readFileSync(absolute.path, 'utf8') : null;
    if ((before?.length ?? 0) > MAX_RESTORABLE_BYTES) {
      return { ok: false, reason: `Codex targeted a file too large for a restorable checkpoint: ${change.path}` };
    }
    let after: string;
    try {
      after = change.kind.type === 'delete'
        ? ''
        : change.content !== undefined
          ? change.content
          : applyUnifiedDiff(before ?? '', change.diff);
    } catch (error) {
      return {
        ok: false,
        reason: `Codex supplied a file diff that could not be checkpointed for ${change.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (after.length > MAX_RESTORABLE_BYTES) {
      return { ok: false, reason: `Codex proposed a file too large for a restorable checkpoint: ${change.path}` };
    }
    entries.push({ path: change.path, before, after });
  }
  return { ok: true, entries };
}

function resolveRestorablePath(
  workspaceRoot: string,
  writeRoots: readonly string[],
  candidate: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!candidate.trim()) return { ok: false, reason: 'Codex supplied an empty file path.' };
  const absolute = path.resolve(workspaceRoot, candidate);
  const allowed = writeRoots.map((root) => path.resolve(root));
  if (!allowed.some((root) => isInside(root, absolute))) {
    return { ok: false, reason: `Codex targeted a path outside its writable folders: ${candidate}` };
  }
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return { ok: false, reason: `Codex file parent could not be resolved: ${candidate}` };
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  const suffix = path.relative(existing, absolute);
  const canonicalTarget = path.resolve(canonicalExisting, suffix);
  const canonicalAllowed = allowed.map((root) => existsSync(root) ? realpathSync.native(root) : root);
  if (!canonicalAllowed.some((root) => isInside(root, canonicalTarget))) {
    return { ok: false, reason: `Codex targeted a linked path outside its writable folders: ${candidate}` };
  }
  return { ok: true, path: canonicalTarget };
}

/** Apply ordinary unified-diff hunks and verify every context/deletion against the current file. */
export function applyUnifiedDiff(before: string, diff: string): string {
  const normalizedDiff = diff.replace(/\r\n/g, '\n');
  const diffLines = normalizedDiff.split('\n');
  const beforeHadNewline = before.endsWith('\n');
  const source = before.replace(/\r\n/g, '\n').split('\n');
  if (beforeHadNewline) source.pop();
  if (source.length === 1 && source[0] === '' && before.length === 0) source.pop();
  const output: string[] = [];
  let sourceIndex = 0;
  let sawHunk = false;
  let noFinalNewline = false;

  for (let index = 0; index < diffLines.length; index++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(diffLines[index]);
    if (!header) continue;
    sawHunk = true;
    const oldStart = Number(header[1]);
    const hunkStart = oldStart === 0 ? 0 : oldStart - 1;
    if (hunkStart < sourceIndex || hunkStart > source.length) throw new Error('hunk starts outside the current file');
    output.push(...source.slice(sourceIndex, hunkStart));
    sourceIndex = hunkStart;
    for (index += 1; index < diffLines.length && !diffLines[index].startsWith('@@ '); index++) {
      const line = diffLines[index];
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      if (line === '\\ No newline at end of file') {
        noFinalNewline = true;
        continue;
      }
      if (line === '' && index === diffLines.length - 1) continue;
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === ' ' || prefix === '-') {
        if (source[sourceIndex] !== text) throw new Error('diff context does not match the current file');
        if (prefix === ' ') output.push(text);
        sourceIndex++;
      } else if (prefix === '+') {
        output.push(text);
      } else {
        throw new Error('unsupported diff line');
      }
    }
    index--;
  }
  if (!sawHunk) throw new Error('no unified-diff hunk was present');
  output.push(...source.slice(sourceIndex));
  const text = output.join('\n');
  return noFinalNewline ? text : `${text}\n`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
