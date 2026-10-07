import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUnifiedDiff, prepareCodexFileCheckpoints } from '../CodexFileChanges';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-codex-checkpoint-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex file-change checkpoint preparation', () => {
  it('materializes exact before/after snapshots without writing the proposed change', () => {
    const root = workspace();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.txt'), 'old\n');
    const result = prepareCodexFileCheckpoints(root, [root], [{
      path: 'src/a.txt',
      diff: '@@ -1 +1 @@\n-old\n+new\n',
      kind: { type: 'update' },
    }]);
    expect(result).toEqual({ ok: true, entries: [{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }] });
  });

  it('fails closed for paths outside write roots, mismatched diffs, and move operations', () => {
    const root = workspace();
    mkdirSync(path.join(root, 'write'));
    writeFileSync(path.join(root, 'write', 'a.txt'), 'old\n');
    expect(prepareCodexFileCheckpoints(root, [path.join(root, 'write')], [{
      path: 'outside.txt', diff: '@@ -0,0 +1 @@\n+x\n', kind: { type: 'add' },
    }])).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
    expect(prepareCodexFileCheckpoints(root, [root], [{
      path: 'write/a.txt', diff: '@@ -1 +1 @@\n-wrong\n+new\n', kind: { type: 'update' },
    }])).toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
    expect(prepareCodexFileCheckpoints(root, [root], [{
      path: 'write/a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n', kind: { type: 'update', move_path: 'write/b.txt' },
    }])).toMatchObject({ ok: false, reason: expect.stringContaining('move operations') });
  });

  it('applies multiple unified-diff hunks and honors a missing final newline marker', () => {
    expect(applyUnifiedDiff(
      'a\nb\nc\nd\n',
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -4 +4 @@\n-d\n+D\n\\ No newline at end of file\n',
    )).toBe('a\nB\nc\nD');
  });
});
