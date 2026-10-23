import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveFileForOpen, resolveRecordedFileForOpen } from '../toolReceipt';

describe('recorded tool-receipt file opening', () => {
  const root = path.resolve('workspace');
  const realpath = (candidate: string) => path.resolve(candidate);

  it('opens a relative host-recorded path inside the agent read roots', () => {
    expect(resolveRecordedFileForOpen('docs/guide.md', root, [root], realpath)).toEqual({
      ok: true,
      path: path.resolve(root, 'docs/guide.md'),
    });
  });

  it('refuses an absolute path outside the agent read roots', () => {
    const outside = path.resolve('private', 'secret.md');
    expect(resolveRecordedFileForOpen(outside, root, [root], realpath)).toEqual({
      ok: false,
      reason: 'outside-read-roots',
    });
  });

  it('compares the physical target so a symlink cannot escape the read root', () => {
    const linked = path.resolve(root, 'docs', 'linked.md');
    const outside = path.resolve('private', 'secret.md');
    const resolvingSymlink = (candidate: string) => path.resolve(candidate) === linked ? outside : path.resolve(candidate);

    expect(resolveRecordedFileForOpen('docs/linked.md', root, [root], resolvingSymlink)).toEqual({
      ok: false,
      reason: 'outside-read-roots',
    });
  });

  // v0.9.97 P1: a receipt of a file in a folder whose name starts with two dots opens it; the real parent, a sibling
  // whose name starts like the read root and a link out to that sibling are still refused (the file-effects design, §5).
  it('opens a "..name" file of a read root, and refuses the parent, a sibling and a link to the sibling', () => {
    expect(resolveRecordedFileForOpen('..cache/notes.md', root, [root], realpath)).toEqual({
      ok: true,
      path: path.resolve(root, '..cache', 'notes.md'),
    });
    expect(resolveRecordedFileForOpen(path.resolve(root, '..agent', 'x.md'), root, [root], realpath)).toMatchObject({ ok: true });
    for (const outside of ['../secret.md', '..cache/../../secret.md', '../workspace-cache/x.md', path.resolve('workspace-cache', 'x.md')]) {
      expect(resolveRecordedFileForOpen(outside, root, [root], realpath), outside).toEqual({ ok: false, reason: 'outside-read-roots' });
    }
    const linked = path.resolve(root, '..cache', 'linked.md');
    const toSibling = (candidate: string) => path.resolve(candidate) === linked ? path.resolve('workspace-cache', 'x.md') : path.resolve(candidate);
    expect(resolveRecordedFileForOpen('..cache/linked.md', root, [root], toSibling)).toEqual({ ok: false, reason: 'outside-read-roots' });
  });
});

/*
 * v0.9.97 (SECURITY.md "Chat file links open through one host boundary"): the one physical check a receipt and a
 * reply's file link share, under explicit Windows and POSIX path rules.
 */
describe('the shared open check for chat files', () => {
  const identity = (candidate: string) => candidate;
  const file = () => ({ isFile: () => true, isDirectory: () => false });
  const folder = () => ({ isFile: () => false, isDirectory: () => true });
  const device = () => ({ isFile: () => false, isDirectory: () => false });

  it('compares whole segments: a child named ..name is inside, a prefix sibling is not', () => {
    expect(resolveFileForOpen('/ws/..name/notes.md', ['/ws'], { realpath: identity, stat: file }, path.posix))
      .toEqual({ ok: true, path: '/ws/..name/notes.md' });
    expect(resolveFileForOpen('/ws-old/notes.md', ['/ws'], { realpath: identity, stat: file }, path.posix))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
    expect(resolveFileForOpen('C:\\ws\\..name\\notes.md', ['C:\\ws'], { realpath: identity, stat: file }, path.win32))
      .toEqual({ ok: true, path: 'C:\\ws\\..name\\notes.md' });
    expect(resolveFileForOpen('C:\\ws-old\\notes.md', ['C:\\ws'], { realpath: identity, stat: file }, path.win32))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
  });

  it('refuses another drive and follows Windows letter case', () => {
    expect(resolveFileForOpen('D:\\ws\\notes.md', ['C:\\ws'], { realpath: identity, stat: file }, path.win32))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
    expect(resolveFileForOpen('c:\\WS\\notes.md', ['C:\\ws'], { realpath: identity, stat: file }, path.win32))
      .toEqual({ ok: true, path: 'c:\\WS\\notes.md' });
    expect(resolveFileForOpen('/WS/notes.md', ['/ws'], { realpath: identity, stat: file }, path.posix))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
  });

  it('decides on the real path: a link out of the root is outside, a link into it from a linked root is inside', () => {
    const linkOut = (candidate: string) => candidate === '/ws/docs/out.md' ? '/private/secret.md' : candidate;
    expect(resolveFileForOpen('/ws/docs/out.md', ['/ws'], { realpath: linkOut, stat: file }, path.posix))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
    const linkedRoot = (candidate: string) => candidate.replace(/^\/home\/dev\/ws/, '/data/ws');
    expect(resolveFileForOpen('/home/dev/ws/notes.md', ['/home/dev/ws'], { realpath: linkedRoot, stat: file }, path.posix))
      .toEqual({ ok: true, path: '/data/ws/notes.md' });
  });

  it('reports a directory, a device, a missing file and a denied one, and opens only a regular file', () => {
    const fs = (stat: () => { isFile(): boolean; isDirectory(): boolean }) => ({ realpath: identity, stat });
    expect(resolveFileForOpen('/ws/docs', ['/ws'], fs(folder), path.posix)).toEqual({ ok: false, reason: 'directory' });
    expect(resolveFileForOpen('/ws/fifo', ['/ws'], fs(device), path.posix)).toEqual({ ok: false, reason: 'not-regular' });
    const failing = (code: string) => ({
      realpath: (candidate: string) => {
        if (candidate === '/ws') return candidate;
        throw Object.assign(new Error(code), { code });
      },
      stat: file,
    });
    expect(resolveFileForOpen('/ws/gone.md', ['/ws'], failing('ENOENT'), path.posix)).toEqual({ ok: false, reason: 'missing' });
    expect(resolveFileForOpen('/ws/locked.md', ['/ws'], failing('EACCES'), path.posix)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('grants nothing through a read root whose real path cannot be read (FOPEN-RC-N1)', () => {
    const rootUnreadable = (candidate: string) => {
      if (candidate === '/ws') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return candidate;
    };
    expect(resolveFileForOpen('/ws/notes.md', ['/ws'], { realpath: rootUnreadable, stat: file }, path.posix))
      .toEqual({ ok: false, reason: 'outside-read-roots' });
  });

  it('refuses a junction out of the workspace on the real disk', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'unode-open-ws-')));
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'unode-open-out-')));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'outside');
      writeFileSync(path.join(workspace, 'inside.md'), 'inside');
      // A junction on Windows; a directory symlink elsewhere. Neither needs elevation.
      symlinkSync(outside, path.join(workspace, 'linked'), 'junction');
      const disk = { realpath: realpathSync, stat: statSync };
      expect(resolveFileForOpen(path.join(workspace, 'linked', 'secret.md'), [workspace], disk))
        .toEqual({ ok: false, reason: 'outside-read-roots' });
      expect(resolveFileForOpen(path.join(workspace, 'inside.md'), [workspace], disk))
        .toEqual({ ok: true, path: path.join(workspace, 'inside.md') });
      expect(resolveFileForOpen(workspace, [workspace], disk)).toEqual({ ok: false, reason: 'directory' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
