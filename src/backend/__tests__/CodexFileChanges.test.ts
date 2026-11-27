import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUnifiedDiff, codexCheckpointRecords, fileHoldsDiffResult, prepareCodexFileCheckpoints } from '../CodexFileChanges';

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

  // v0.9.97 P1: a change in a folder whose name starts with two dots is checkpointed where Codex makes it; the real
  // parent, a sibling whose name starts like the root and a link out of such a folder are not (the file-effects
  // design, §5).
  it('checkpoints a change in a "..name" folder, and refuses the parent, a sibling and a link out of that folder', () => {
    const base = workspace();
    const root = path.join(base, 'ws');
    const sibling = path.join(base, 'ws-cache');
    mkdirSync(path.join(root, '..cache'), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(path.join(root, '..cache', 'a.txt'), 'old\n');
    symlinkSync(sibling, path.join(root, '..cache', 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    const add = (file: string, writeRoots = [root]) => prepareCodexFileCheckpoints(root, writeRoots, [{
      path: file, diff: '@@ -0,0 +1 @@\n+x\n', kind: { type: 'add' },
    }]);
    expect(prepareCodexFileCheckpoints(root, [root], [{
      path: '..cache/a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n', kind: { type: 'update' },
    }])).toEqual({ ok: true, entries: [{ path: '..cache/a.txt', before: 'old\n', after: 'new\n' }] });
    expect(add('..cache/new/b.txt')).toMatchObject({ ok: true });
    expect(add(path.join(root, '..cache', 'c.txt'))).toMatchObject({ ok: true });
    // A write root that is itself a "..name" folder holds its files.
    expect(add('..cache/d.txt', [path.join(root, '..cache')])).toMatchObject({ ok: true });
    for (const outside of ['../outside.txt', '..cache/../../outside.txt', '../ws-cache/x.txt', path.join(sibling, 'x.txt')]) {
      expect(add(outside), outside).toMatchObject({ ok: false, reason: expect.stringContaining('outside its writable folders') });
    }
    expect(add('..cache/out/x.txt')).toMatchObject({ ok: false, reason: expect.stringContaining('linked path outside') });
  });

  it('applies multiple unified-diff hunks and honors a missing final newline marker', () => {
    expect(applyUnifiedDiff(
      'a\nb\nc\nd\n',
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -4 +4 @@\n-d\n+D\n\\ No newline at end of file\n',
    )).toBe('a\nB\nc\nD');
  });

  // Field, 4c06a304 N1: the diff Codex 0.165.0 sent to append a line to a file with no final newline.
  it('reads a missing-newline marker as being about the line before it, so a removed line says nothing of the new file', () => {
    const appended = '@@ -1 +1,2 @@\n-N1 approve\n\\ No newline at end of file\n+N1 approve\n+N1 ask\n';
    expect(applyUnifiedDiff('N1 approve', appended)).toBe('N1 approve\nN1 ask\n');
    // Both sides without one, and a kept last line, still end as the file does.
    expect(applyUnifiedDiff('a', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n')).toBe('b');
    expect(applyUnifiedDiff('a\nb', '@@ -1 +1 @@\n-a\n+A\n')).toBe('A\nb');
    expect(applyUnifiedDiff('a\nb\n', '@@ -1 +1 @@\n-a\n+A\n')).toBe('A\nb\n');
  });

  it('checks an edited file against the lines the diff says it now holds', () => {
    const appended = '@@ -1 +1,2 @@\n-N1 approve\n\\ No newline at end of file\n+N1 approve\n+N1 ask\n';
    expect(fileHoldsDiffResult('N1 approve\nN1 ask\n', appended)).toBe(true);
    expect(fileHoldsDiffResult('N1 approve\r\nN1 ask\r\n', appended)).toBe(true);
    expect(fileHoldsDiffResult('N1 approve\n', appended)).toBe(false);
    expect(fileHoldsDiffResult('other\nN1 approve\nN1 ask\n', appended)).toBe(false);
    // At its place in the new file, across hunks.
    const twoHunks = '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -4 +4 @@\n-d\n+D\n';
    expect(fileHoldsDiffResult('a\nB\nc\nD\n', twoHunks)).toBe(true);
    expect(fileHoldsDiffResult('a\nB\nc\nd\n', twoHunks)).toBe(false);
    // A diff that only removes names nothing to find, and one with no hunk names nothing at all.
    expect(fileHoldsDiffResult('a\n', '@@ -1,2 +1,0 @@\n-b\n-c\n')).toBe(false);
    expect(fileHoldsDiffResult('a\n', 'no hunk here')).toBe(false);
  });

  it('vouches for a removal only when the file shows it: the next line, or the end of the file', () => {
    const inTheMiddle = '@@ -1,3 +1,2 @@\n keep\n-remove\n tail\n';
    expect(fileHoldsDiffResult('keep\ntail\n', inTheMiddle)).toBe(true);
    expect(fileHoldsDiffResult('keep\nremove\ntail\n', inTheMiddle)).toBe(false);
    // The last line of the file: the removal is seen by the file ending there, with or without a final newline.
    const atTheEnd = '@@ -1,2 +1 @@\n keep\n-remove\n';
    expect(fileHoldsDiffResult('keep\n', atTheEnd)).toBe(true);
    expect(fileHoldsDiffResult('keep', atTheEnd)).toBe(true);
    expect(fileHoldsDiffResult('keep\nremove\n', atTheEnd)).toBe(false);
    // A removed line that reads like a diff header is still a removal.
    expect(fileHoldsDiffResult('keep\n-- note\n', '@@ -1,2 +1 @@\n keep\n--- note\n')).toBe(false);
    // Any hunk of the diff can hold it.
    const thenAnother = '@@ -1,2 +1 @@\n a\n-b\n@@ -4 +3 @@\n-d\n+D\n';
    expect(fileHoldsDiffResult('a\nb\nc\nD\n', thenAnother)).toBe(false);
    // Nothing after it to check, in the middle of a file: left uncertain, even when the removal may have happened.
    expect(fileHoldsDiffResult('keep\nother\n', atTheEnd)).toBe(false);
  });
});

// CHANGELOG [Unreleased]: a restore names the file the change was recorded for, as Codex resolves it.
describe('Codex restore-point records', () => {
  it('name the file against the agent folder, and say which change deletes it', () => {
    const cwd = path.resolve('/ws/main/.unode/worktrees/codex');
    const records = codexCheckpointRecords(
      cwd,
      [path.resolve('/ws/main')],
      [
        { path: 'src/a.ts', diff: '', kind: { type: 'update' } },
        { path: path.join(cwd, 'old.txt'), diff: '', kind: { type: 'delete' } },
      ],
      [
        { path: 'src/a.ts', before: 'a', after: 'b' },
        { path: path.join(cwd, 'old.txt'), before: 'gone', after: '' },
      ],
    );

    expect(records).toEqual({
      ok: true,
      records: [
        { path: path.join('src', 'a.ts'), target: path.join(cwd, 'src', 'a.ts'), before: 'a', after: 'b', operation: 'write' },
        { path: 'old.txt', target: path.join(cwd, 'old.txt'), before: 'gone', after: '', operation: 'delete-file' },
      ],
    });
  });

  it('refuse the whole change when one file is outside every open workspace folder', () => {
    const cwd = path.resolve('/ws/main');
    const outside = path.resolve('/elsewhere/b.ts');
    const records = codexCheckpointRecords(
      cwd,
      [cwd, path.resolve('/ws/other')],
      [{ path: 'a.ts', diff: '', kind: { type: 'update' } }, { path: outside, diff: '', kind: { type: 'update' } }],
      [{ path: 'a.ts', before: 'a', after: 'b' }, { path: outside, before: 'c', after: 'd' }],
    );

    expect(records).toMatchObject({ ok: false, reason: expect.stringContaining('outside the open workspace folders') });
  });

  it('keep restore points when the workspace folder was opened through a link and the agent works physically (v0.9.100)', () => {
    const root = realpathSync.native(workspace());
    const target = path.join(root, 'real'); const outside = path.join(root, 'outside');
    mkdirSync(path.join(target, 'src'), { recursive: true }); mkdirSync(outside);
    writeFileSync(path.join(target, 'src', 'a.ts'), 'a');
    const opened = path.join(root, 'opened');
    symlinkSync(target, opened, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, path.join(target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const cwd = realpathSync.native(opened);
    const changes = [{ path: 'src/a.ts', diff: '', kind: { type: 'update' as const } },
      { path: 'src/new/b.ts', diff: '', kind: { type: 'add' as const } }];
    const entries = [{ path: 'src/a.ts', before: 'a', after: 'b' }, { path: 'src/new/b.ts', before: '', after: 'b' }];
    expect(codexCheckpointRecords(cwd, [opened], changes, entries)).toMatchObject({ ok: true,
      records: [{ target: path.join(target, 'src', 'a.ts') }, { target: path.join(target, 'src', 'new', 'b.ts') }] });
    // A link inside the workspace that leads out of it is still outside.
    expect(codexCheckpointRecords(cwd, [opened], [{ path: 'escape/c.ts', diff: '', kind: { type: 'add' } }],
      [{ path: 'escape/c.ts', before: '', after: 'c' }])).toMatchObject({ ok: false });
  });
});
