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
});
