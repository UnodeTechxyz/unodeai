import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveInsideRoot } from '../workspacePath';

const ROOT = path.resolve('/repo');

describe('resolveInsideRoot', () => {
  it('resolves a normal workspace-relative path', () => {
    expect(resolveInsideRoot(ROOT, 'src/app.ts')).toEqual({ status: 'resolved', path: path.join(ROOT, 'src', 'app.ts') });
    expect(resolveInsideRoot(ROOT, './src/app.ts')).toEqual({ status: 'resolved', path: path.join(ROOT, 'src', 'app.ts') });
    expect(resolveInsideRoot(ROOT, 'a/../src/app.ts')).toEqual({ status: 'resolved', path: path.join(ROOT, 'src', 'app.ts') });
  });

  it('refuses anything that leaves the workspace', () => {
    // These reach a file WRITE (checkpoint restore). A checkpoint store is re-loaded from a persisted
    // file, so a tampered record must not become an arbitrary write.
    expect(resolveInsideRoot(ROOT, '../outside.txt')).toEqual({ status: 'refused', reason: 'scope' });
    expect(resolveInsideRoot(ROOT, 'src/../../outside.txt')).toEqual({ status: 'refused', reason: 'scope' });
    expect(resolveInsideRoot(ROOT, '../repo-sibling/x.ts')).toEqual({ status: 'refused', reason: 'scope' });
  });

  it('refuses an absolute path instead of letting it replace the root', () => {
    expect(resolveInsideRoot(ROOT, path.resolve('/etc/passwd'))).toEqual({ status: 'refused', reason: 'scope' });
    if (process.platform === 'win32') {
      expect(resolveInsideRoot('C:\\repo', 'D:\\elsewhere\\x.ts')).toEqual({ status: 'refused', reason: 'scope' });
      expect(resolveInsideRoot('C:\\repo', '\\\\server\\share\\x.ts')).toEqual({ status: 'refused', reason: 'scope' });
    }
  });

  it('refuses the root itself and the empty path', () => {
    expect(resolveInsideRoot(ROOT, '')).toEqual({ status: 'failed', reason: 'invalid-target' });
    expect(resolveInsideRoot(ROOT, '.')).toEqual({ status: 'refused', reason: 'scope' });
  });

  it('keeps a path that merely starts with the root name as a sibling out', () => {
    expect(resolveInsideRoot(path.resolve('/repo'), '../repo2/x.ts')).toEqual({ status: 'refused', reason: 'scope' });
  });

  // v0.9.97 P1: a checkpoint of a file in a `..cache` folder restores and diffs where it was taken, and a record that
  // climbs out through such a folder is still refused (the file-effects design, §5).
  it('resolves a file in a folder whose name starts with two dots, and refuses a climb out through one', () => {
    expect(resolveInsideRoot(ROOT, '..cache/x.json')).toEqual({ status: 'resolved', path: path.join(ROOT, '..cache', 'x.json') });
    expect(resolveInsideRoot(ROOT, '..cache')).toEqual({ status: 'resolved', path: path.join(ROOT, '..cache') });
    expect(resolveInsideRoot(ROOT, path.join(ROOT, '..agent', 'notes.md'))).toEqual({ status: 'resolved', path: path.join(ROOT, '..agent', 'notes.md') });
    expect(resolveInsideRoot(ROOT, '..cache/../../outside.txt')).toEqual({ status: 'refused', reason: 'scope' });
    expect(resolveInsideRoot(ROOT, '..cache/..')).toEqual({ status: 'refused', reason: 'scope' });
    expect(resolveInsideRoot(ROOT, '../repo-cache/x.json')).toEqual({ status: 'refused', reason: 'scope' });
    expect(resolveInsideRoot(ROOT, '..')).toEqual({ status: 'refused', reason: 'scope' });
  });
});
