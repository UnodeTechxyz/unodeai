import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual, isPathStrictlyInside } from './pathContainment';
import { physicalPath } from './workspacePath';

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
  if (!allowed.some((root) => isPathInsideOrEqual(root, absolute))) {
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
  if (!canonicalAllowed.some((root) => isPathInsideOrEqual(root, canonicalTarget))) {
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
  let previousPrefix = '';

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
        // It speaks of the line before it. After a removed line that is the old file, which says nothing of the new one
        // (field, 4c06a304: appending to a file with no final newline never matched what Codex wrote).
        if (previousPrefix !== '-') noFinalNewline = true;
        continue;
      }
      if (line === '' && index === diffLines.length - 1) continue;
      const prefix = line[0];
      previousPrefix = prefix;
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
  // A last line no hunk reached ends as it did before.
  const lastLineUntouched = sourceIndex < source.length;
  output.push(...source.slice(sourceIndex));
  const text = output.join('\n');
  return (lastLineUntouched ? !beforeHadNewline : noFinalNewline) ? text : `${text}\n`;
}

/**
 * v0.9.100 (field): whether a file now holds what a unified diff says its lines became: every context and added line at
 * its place in the new file. Codex edits inside its sandbox without asking, so the file as it was before is gone; this is
 * what can still be checked of an edit. A removal shows only by what follows it: a line in the new file, or the end of
 * the file when nothing does. A diff that only removes names no line to find, and is not vouched for. Any other removal
 * with nothing after it to check is not vouched for either.
 */
export function fileHoldsDiffResult(after: string, diff: string): boolean {
  const lines = after.replace(/\r\n/g, '\n').split('\n');
  const diffLines = diff.replace(/\r\n/g, '\n').split('\n');
  const lineCount = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  let found = 0;
  for (let index = 0; index < diffLines.length; index++) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(diffLines[index]);
    if (!header) continue;
    let at = Math.max(Number(header[1]) - 1, 0);
    let endsInRemoval = false;
    for (index += 1; index < diffLines.length && !diffLines[index].startsWith('@@ '); index++) {
      const line = diffLines[index];
      if (line.startsWith('+++ ') || line.startsWith('\\') || line === '') continue;
      if (line[0] === '-') {
        endsInRemoval = true;
        continue;
      }
      if (line[0] !== ' ' && line[0] !== '+') return false;
      if (lines[at] !== line.slice(1)) return false;
      at++;
      found++;
      endsInRemoval = false;
    }
    if (endsInRemoval && at < lineCount) return false;
    index--;
  }
  return found > 0;
}

/** A Codex restore point as the host records it: the file Codex resolves, what the change does, and a display path. */
export interface CodexCheckpointRecord extends CodexCheckpointEntry {
  /** The absolute file, resolved against the agent's own folder as Codex resolves it. */
  target: string;
  operation: 'write' | 'delete-file';
}

/**
 * Name the file of each prepared entry. Each entry belongs to the change at the same position, which
 * prepareCodexFileCheckpoints keeps. A display path stays relative to the agent's folder when the file is inside it.
 *
 * A Codex change is accepted only with a restore point a restore can act on, and a restore acts only inside an open
 * workspace folder, so a file outside every one of `workspaceFolders` refuses the whole change.
 */
export function codexCheckpointRecords(
  agentCwd: string,
  workspaceFolders: readonly string[],
  changes: readonly CodexFileChange[],
  entries: readonly CodexCheckpointEntry[],
): { ok: true; records: CodexCheckpointRecord[] } | { ok: false; reason: string } {
  const records = entries.map((entry, index): CodexCheckpointRecord => {
    const target = path.resolve(agentCwd, entry.path);
    return {
      ...entry,
      path: isPathStrictlyInside(agentCwd, target) ? path.relative(agentCwd, target) : target,
      target,
      operation: changes[index]?.kind.type === 'delete' ? 'delete-file' : 'write',
    };
  });
  // The agent folder is physical since v0.9.100, while VS Code names a folder as it was opened (a junction, an 8.3
  // name or a subst drive): compare both physically. A target that does not exist yet resolves through its parents.
  const folders = workspaceFolders.map((folder) => physicalPath(path.resolve(folder)));
  const outside = records.find((record) => !folders.some((folder) => isPathStrictlyInside(folder, physicalPath(record.target))));
  return outside
    ? { ok: false, reason: `UnodeAi could not save a restorable checkpoint: ${outside.path} is outside the open workspace folders, where a restore can act` }
    : { ok: true, records };
}
