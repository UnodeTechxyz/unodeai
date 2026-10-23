import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  exactFileGrantState,
  exactFileGrantsOnFolderRoute,
  intersectTaskWorkspaceAccess,
  readablePathCeilings,
  resolveEffectiveRoots,
  samePath,
  writeRootsForTrust,
} from '../folderAccess';
import type { FolderGrant } from '../../types';

// These cases create temp folders and junctions. In run 13 of 20 of the nightly Windows release stress
// (Actions run 36453763436) two adjacent cases exceeded vitest's 5 s default while the other 19 runs passed:
// a runner filesystem stall, not a slow path in resolveEffectiveRoots. Test-only margin.
describe('resolveEffectiveRoots', { timeout: 20_000 }, () => {
  it('drops every writable root when Workspace Trust is off', () => {
    expect(writeRootsForTrust(['C:\\workspace', 'C:\\scratch'], false)).toEqual([]);
    expect(writeRootsForTrust(['C:\\workspace'], true)).toEqual(['C:\\workspace']);
  });

  it('intersects a wider task request with configured Folder Access instead of replacing it (R1 mutation gate)', () => {
    const configured = {
      readRoots: [path.resolve('/workspace/src')],
      writeRoots: [],
      readFiles: [],
      writeFiles: [],
    };
    const request = {
      // The coordinator asks for the whole workspace and write access; it must get only the agent's
      // configured src read root. Mutating intersection to replacement makes this named test fail.
      readRoots: [path.resolve('/workspace')],
      writeRoots: [path.resolve('/workspace')],
      readFiles: [],
      writeFiles: [],
    };

    const access = intersectTaskWorkspaceAccess(configured, request, true, path.resolve('/workspace'));
    expect(access).toEqual({
      pathBase: path.resolve('/workspace'),
      readRoots: [path.resolve('/workspace/src')],
      writeRoots: [],
      readFiles: [],
      writeFiles: [],
    });
    // No writable directory, so no command working directory: the path base does not stand in for one.
    expect(access).not.toHaveProperty('commandCwd');
  });

  it('keeps pathBase at the configured root while containing commandCwd inside a writable task scope', () => {
    const workspace = path.resolve('/workspace');
    const research = path.resolve('/workspace/research');

    expect(intersectTaskWorkspaceAccess(
      { readRoots: [workspace], writeRoots: [research], readFiles: [], writeFiles: [] },
      { readRoots: [research], writeRoots: [research], readFiles: [], writeFiles: [] },
      true,
      workspace,
    )).toEqual({
      pathBase: workspace,
      commandCwd: research,
      readRoots: [research],
      writeRoots: [research],
      readFiles: [],
      writeFiles: [],
    });
  });

  it('preserves default roots when folderAccess is absent or empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-root-'));
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-extra-'));

    const effective = resolveEffectiveRoots({
      grants: undefined,
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [extra],
      workspaceRoots: [root],
      isTrusted: true,
    });

    expect(effective.restricted).toBe(false);
    expect(effective.writeRoots).toEqual([path.resolve(root)]);
    expect(effective.readRoots).toEqual([path.resolve(root), path.resolve(extra)]);

    const empty = resolveEffectiveRoots({
      grants: [],
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [extra],
      workspaceRoots: [root],
      isTrusted: true,
    });
    expect(empty).toEqual(effective);

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(extra, { recursive: true, force: true });
  });

  it('restricted mode never widens with workspace folders or additional roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-root-'));
    const allowed = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-allowed-'));
    const workspaceSibling = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-ws2-'));
    const additional = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-extra-'));

    const effective = resolveEffectiveRoots({
      grants: [{ path: allowed, permission: 'read' }],
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [additional],
      workspaceRoots: [root, workspaceSibling],
      isTrusted: true,
    });

    expect(effective.restricted).toBe(true);
    expect(effective.writeRoots).toEqual([]);
    expect(effective.readRoots).toEqual([path.resolve(allowed)]);
    expect(effective.readRoots).not.toContain(path.resolve(root));
    expect(effective.readRoots).not.toContain(path.resolve(workspaceSibling));
    expect(effective.readRoots).not.toContain(path.resolve(additional));

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(allowed, { recursive: true, force: true });
    await fs.rm(workspaceSibling, { recursive: true, force: true });
    await fs.rm(additional, { recursive: true, force: true });
  });

  it('drops missing and untrusted outside-workspace grants', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-ws-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-out-'));

    const effective = resolveEffectiveRoots({
      grants: [
        { path: outside, permission: 'readwrite' },
        { path: path.join(workspace, 'missing'), permission: 'read' },
      ],
      fallbackPrimaryRoot: workspace,
      fallbackReadRoots: [],
      workspaceRoots: [workspace],
      isTrusted: false,
    });

    expect(effective.restricted).toBe(true);
    expect(effective.writeRoots).toEqual([]);
    expect(effective.readRoots).toEqual([]);
    expect(effective.issues.map((issue) => issue.kind).sort()).toEqual(['missing', 'untrusted-outside-workspace']);

    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('uses the most restrictive permission for duplicate realpaths and warns on read inside readwrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-root-'));
    const child = path.join(root, 'child');
    await fs.mkdir(child);

    const duplicate = resolveEffectiveRoots({
      grants: [
        { path: root, permission: 'readwrite' },
        { path: root, permission: 'read' },
      ],
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [],
      workspaceRoots: [root],
      isTrusted: true,
    });
    expect(duplicate.writeRoots).toEqual([]);
    expect(duplicate.readRoots).toEqual([path.resolve(root)]);
    expect(duplicate.issues.some((issue) => issue.kind === 'duplicate-conflict')).toBe(true);

    const nested = resolveEffectiveRoots({
      grants: [
        { path: root, permission: 'readwrite' },
        { path: child, permission: 'read' },
      ],
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [],
      workspaceRoots: [root],
      isTrusted: true,
    });
    expect(nested.writeRoots).toEqual([path.resolve(root)]);
    expect(nested.issues.some((issue) => issue.kind === 'read-inside-readwrite')).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('warns about a read-only ..name folder inside a writable one, by whole path segments, and changes no grant (v0.9.96)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-dots-'));
    try {
      const root = path.join(base, 'repo');
      const dotted = path.join(root, '..cache');
      const outside = path.join(base, 'outside');
      const sibling = path.join(base, 'repo-cache');
      for (const folder of [root, dotted, outside, sibling]) await fs.mkdir(folder, { recursive: true });
      const warned = (readOnly: string) => {
        const resolved = resolveEffectiveRoots({
          grants: [{ path: root, permission: 'readwrite' }, { path: readOnly, permission: 'read' }],
          fallbackPrimaryRoot: root,
          fallbackReadRoots: [],
          workspaceRoots: [root],
          isTrusted: true,
        });
        expect(resolved.writeRoots, readOnly).toEqual([path.resolve(root)]);
        return resolved.issues.filter((issue) => issue.kind === 'read-inside-readwrite').map((issue) => issue.path);
      };
      // The warning names the grant's real path as Folder Access resolves it (`realpathSync`, which keeps an 8.3 short
      // name such as a runner's `RUNNER~1` temp folder); the promise form expands it and named another string.
      expect(warned(dotted)).toEqual([realpathSync(dotted)]);
      // A real parent segment and a sibling whose name starts like the writable folder are outside it.
      expect(warned(path.join(root, '..', 'outside'))).toEqual([]);
      expect(warned(sibling)).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('dedupes symlinked grants by realpath', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-real-'));
    const link = `${root}-link`;
    try {
      await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      const effective = resolveEffectiveRoots({
        grants: [
          { path: root, permission: 'readwrite' },
          { path: link, permission: 'readwrite' },
        ],
        fallbackPrimaryRoot: root,
        fallbackReadRoots: [],
        workspaceRoots: [root],
        isTrusted: true,
      });

      expect(effective.writeRoots).toEqual([path.resolve(root)]);
      expect(effective.readRoots).toEqual([path.resolve(root)]);
      expect(effective.issues).toEqual([]);
    } finally {
      await fs.rm(link, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('drops untrusted workspace grants whose symlink resolves outside the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-ws-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-out-'));
    const link = path.join(workspace, 'outside-link');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err: any) {
      if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      throw err;
    }

    try {
      const effective = resolveEffectiveRoots({
        grants: [{ path: link, permission: 'read' }],
        fallbackPrimaryRoot: workspace,
        fallbackReadRoots: [],
        workspaceRoots: [workspace],
        isTrusted: false,
      });

      expect(effective.writeRoots).toEqual([]);
      expect(effective.readRoots).toEqual([]);
      expect(effective.issues.map((issue) => issue.kind)).toEqual(['untrusted-outside-workspace']);
      expect(effective.readRoots).not.toContain(path.resolve(outside));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('honors trusted workspace grants whose symlink resolves outside the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-ws-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-out-'));
    const link = path.join(workspace, 'outside-link');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err: any) {
      if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      throw err;
    }

    try {
      const effective = resolveEffectiveRoots({
        grants: [{ path: link, permission: 'read' }],
        fallbackPrimaryRoot: workspace,
        fallbackReadRoots: [],
        workspaceRoots: [workspace],
        isTrusted: true,
      });

      expect(effective.writeRoots).toEqual([]);
      expect(effective.readRoots).toEqual([path.resolve(outside)]);
      expect(effective.issues).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

// A grant may name one existing file. It is compiled into an exact-file grant that is never a root, and it is
// intersected as that file alone.
describe('exact-file grants', { timeout: 20_000 }, () => {
  async function workspace(): Promise<{ root: string; docs: string; notes: string; sibling: string; other: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-file-'));
    const docs = path.join(root, 'docs');
    const other = path.join(root, 'other');
    await fs.mkdir(docs);
    await fs.mkdir(other);
    const notes = path.join(docs, 'notes.md');
    const sibling = path.join(docs, 'sibling.md');
    await fs.writeFile(notes, 'notes\n', 'utf8');
    await fs.writeFile(sibling, 'sibling\n', 'utf8');
    return { root, docs, notes, sibling, other };
  }

  function compile(root: string, grants: FolderGrant[] | undefined, isTrusted = true) {
    return resolveEffectiveRoots({
      grants,
      fallbackPrimaryRoot: root,
      fallbackReadRoots: [],
      workspaceRoots: [root],
      isTrusted,
    });
  }

  function fileGrant(file: string, permission: 'read' | 'readwrite') {
    return { kind: 'file', permission, lexicalPath: path.resolve(file), realPath: path.resolve(file), realParent: path.dirname(path.resolve(file)) };
  }

  it('compiles a file into a typed grant apart from every root, and never makes it the working directory', async () => {
    const { root, notes, sibling, other } = await workspace();
    try {
      const effective = compile(root, [
        { path: 'docs/notes.md', permission: 'readwrite' },
        { path: 'docs/sibling.md', permission: 'read' },
        { path: 'other', permission: 'read' },
      ]);

      expect(effective.issues).toEqual([]);
      expect(effective.restricted).toBe(true);
      expect(effective.readRoots).toEqual([path.resolve(other)]);
      expect(effective.writeRoots).toEqual([]);
      expect(effective.writeFiles).toEqual([fileGrant(notes, 'readwrite')]);
      expect(effective.readFiles).toEqual([fileGrant(notes, 'readwrite'), fileGrant(sibling, 'read')]);
      // The writable file comes first in the grants, and is still not where the agent works.
      expect(effective.primaryRoot).toBe(path.resolve(other));

      const filesOnly = compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]);
      expect(filesOnly.readRoots).toEqual([]);
      expect(filesOnly.writeRoots).toEqual([]);
      expect(filesOnly.primaryRoot).toBe(path.resolve(root));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing path at compile time without calling it a folder', async () => {
    const { root } = await workspace();
    try {
      const effective = compile(root, [{ path: 'docs/missing.md', permission: 'readwrite' }]);

      expect(effective.readFiles).toEqual([]);
      expect(effective.readRoots).toEqual([]);
      expect(effective.issues).toEqual([{ kind: 'missing', path: 'docs/missing.md', message: 'Path does not exist: docs/missing.md' }]);
      expect(effective.issues[0].message).not.toMatch(/folder/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps one grant per physical file, narrows conflicting duplicates, and names the file as a file', async () => {
    const { root, notes, sibling } = await workspace();
    try {
      const duplicate = compile(root, [
        { path: 'docs/notes.md', permission: 'readwrite' },
        { path: notes, permission: 'read' },
        { path: 'docs/sibling.md', permission: 'readwrite' },
        { path: sibling, permission: 'readwrite' },
      ]);

      expect(duplicate.writeFiles).toEqual([fileGrant(sibling, 'readwrite')]);
      expect(duplicate.readFiles).toEqual([fileGrant(sibling, 'readwrite'), fileGrant(notes, 'read')]);
      expect(duplicate.issues).toEqual([
        { kind: 'duplicate-conflict', path: notes, message: `Duplicate file has conflicting permissions; using read-only: ${notes}` },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('folds a file into a directory of the same authority, and keeps a writable file beside a read-only directory', async () => {
    const { root, docs, notes, sibling } = await workspace();
    try {
      const covered = compile(root, [
        { path: 'docs', permission: 'readwrite' },
        { path: 'docs/notes.md', permission: 'readwrite' },
        { path: 'docs/sibling.md', permission: 'read' },
      ]);
      expect(covered.writeRoots).toEqual([path.resolve(docs)]);
      expect(covered.readFiles).toEqual([]);
      expect(covered.writeFiles).toEqual([]);
      expect(covered.issues).toEqual([{
        kind: 'read-inside-readwrite',
        path: path.resolve(sibling),
        message: `Read-only file is inside writable folder ${path.resolve(docs)}; it is writable in practice: ${path.resolve(sibling)}`,
      }]);

      const beside = compile(root, [
        { path: 'docs', permission: 'read' },
        { path: 'docs/notes.md', permission: 'readwrite' },
        { path: 'docs/sibling.md', permission: 'read' },
      ]);
      expect(beside.readRoots).toEqual([path.resolve(docs)]);
      expect(beside.writeRoots).toEqual([]);
      // The read-only directory already holds the read-only file. It does not make the other one writable.
      expect(beside.writeFiles).toEqual([fileGrant(notes, 'readwrite')]);
      expect(beside.readFiles).toEqual([fileGrant(notes, 'readwrite')]);
      expect(beside.issues).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('ignores an outside-workspace file in an untrusted workspace, and names it as a file', async () => {
    const { root } = await workspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-file-out-'));
    const secret = path.join(outside, 'secret.md');
    await fs.writeFile(secret, 'secret\n', 'utf8');
    try {
      const effective = compile(root, [{ path: secret, permission: 'readwrite' }], false);

      expect(effective.readFiles).toEqual([]);
      expect(effective.writeFiles).toEqual([]);
      expect(effective.issues).toEqual([{
        kind: 'untrusted-outside-workspace',
        path: secret,
        message: `Ignored outside-workspace file in an untrusted workspace: ${secret}`,
      }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  // The five rows of the scope ratchet, at the function both routes call.
  it('directory over a directory inside it: the requested directory', async () => {
    const { root, docs } = await workspace();
    try {
      const access = intersectTaskWorkspaceAccess(
        compile(root, undefined), compile(root, [{ path: 'docs', permission: 'readwrite' }]), true, root,
      );
      expect(access).toEqual({
        pathBase: path.resolve(root),
        commandCwd: path.resolve(docs),
        readRoots: [path.resolve(docs)],
        writeRoots: [path.resolve(docs)],
        readFiles: [],
        writeFiles: [],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('directory over a file inside it: the exact file, with no root and no command directory', async () => {
    const { root, notes } = await workspace();
    try {
      const access = intersectTaskWorkspaceAccess(
        compile(root, undefined), compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]), true, root,
      );
      expect(access).toEqual({
        pathBase: path.resolve(root),
        readRoots: [],
        writeRoots: [],
        readFiles: [fileGrant(notes, 'readwrite')],
        writeFiles: [fileGrant(notes, 'readwrite')],
      });
      expect(access).not.toHaveProperty('commandCwd');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exact file over a directory containing it: the exact file, not the directory', async () => {
    const { root, notes } = await workspace();
    try {
      const access = intersectTaskWorkspaceAccess(
        compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]),
        compile(root, [{ path: 'docs', permission: 'readwrite' }]),
        true,
        root,
      );
      expect(access).toEqual({
        pathBase: path.resolve(root),
        readRoots: [],
        writeRoots: [],
        readFiles: [fileGrant(notes, 'readwrite')],
        writeFiles: [fileGrant(notes, 'readwrite')],
      });
      expect(access).not.toHaveProperty('commandCwd');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exact file over the same exact file: that file, at the narrower permission', async () => {
    const { root, notes } = await workspace();
    try {
      const rw: FolderGrant[] = [{ path: 'docs/notes.md', permission: 'readwrite' }];
      const ro: FolderGrant[] = [{ path: notes, permission: 'read' }];

      const both = intersectTaskWorkspaceAccess(compile(root, rw), compile(root, rw), true, root);
      expect(both?.writeFiles).toEqual([fileGrant(notes, 'readwrite')]);
      expect(both?.readFiles).toEqual([fileGrant(notes, 'readwrite')]);

      for (const [configured, requested] of [[rw, ro], [ro, rw]]) {
        const narrowed = intersectTaskWorkspaceAccess(compile(root, configured), compile(root, requested), true, root);
        expect(narrowed?.writeFiles).toEqual([]);
        expect(narrowed?.readFiles).toEqual([fileGrant(notes, 'read')]);
        expect(narrowed?.readRoots).toEqual([]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a writable file read-only when the directory around it on the other side is read-only', async () => {
    const { root, notes } = await workspace();
    try {
      const writableFile: FolderGrant[] = [{ path: 'docs/notes.md', permission: 'readwrite' }];
      const readOnlyDirectory: FolderGrant[] = [{ path: 'docs', permission: 'read' }];
      // Either side may hold the read-only directory. It lends the file on the other side no write authority.
      for (const [configured, requested] of [[readOnlyDirectory, writableFile], [writableFile, readOnlyDirectory]]) {
        const access = intersectTaskWorkspaceAccess(compile(root, configured), compile(root, requested), true, root);
        expect(access).toEqual({
          pathBase: path.resolve(root),
          readRoots: [],
          writeRoots: [],
          readFiles: [fileGrant(notes, 'read')],
          writeFiles: [],
        });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exact file over another file or directory: no intersection', async () => {
    const { root } = await workspace();
    try {
      const configured = compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]);
      const others: FolderGrant[][] = [
        [{ path: 'docs/sibling.md', permission: 'readwrite' }],
        [{ path: 'other', permission: 'readwrite' }],
      ];
      for (const requested of others) {
        expect(intersectTaskWorkspaceAccess(configured, compile(root, requested), true, root)).toBeUndefined();
      }
      // The other way round, too: a file the request names outside the configured directory shares nothing.
      expect(intersectTaskWorkspaceAccess(
        compile(root, [{ path: 'other', permission: 'readwrite' }]),
        compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]),
        true,
        root,
      )).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('takes write authority from a file in an untrusted workspace and adds none', async () => {
    const { root, notes } = await workspace();
    try {
      const requested = compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }], false);
      const access = intersectTaskWorkspaceAccess(compile(root, undefined, false), requested, false, root);

      expect(access).toEqual({
        pathBase: path.resolve(root),
        readRoots: [],
        writeRoots: [],
        readFiles: [fileGrant(notes, 'read')],
        writeFiles: [],
      });
      expect(access).not.toHaveProperty('commandCwd');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('takes the command directory from a writable directory beside a file, never from the file', async () => {
    const { root, other, notes } = await workspace();
    try {
      const access = intersectTaskWorkspaceAccess(
        compile(root, undefined),
        compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }, { path: 'other', permission: 'readwrite' }]),
        true,
        root,
      );
      expect(access?.commandCwd).toBe(path.resolve(other));
      expect(access?.writeRoots).toEqual([path.resolve(other)]);
      expect(access?.writeFiles).toEqual([fileGrant(notes, 'readwrite')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('tells whether a granted path still leads to the admitted file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-file-state-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const link = path.join(root, 'link');
    const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'notes.md'), 'first\n', 'utf8');
    await fs.writeFile(path.join(second, 'notes.md'), 'second\n', 'utf8');
    try {
      await fs.symlink(first, link, linkKind);
      const [grant] = compile(root, [{ path: 'link/notes.md', permission: 'readwrite' }]).writeFiles;

      // The grant keeps the path as it was given, and the physical file and directory behind the link.
      expect(grant).toEqual({
        kind: 'file',
        permission: 'readwrite',
        lexicalPath: path.join(path.resolve(link), 'notes.md'),
        realPath: path.join(path.resolve(first), 'notes.md'),
        realParent: path.resolve(first),
      });
      expect(exactFileGrantState(grant)).toBe('present');

      await fs.rm(path.join(first, 'notes.md'));
      expect(exactFileGrantState(grant)).toBe('absent');

      // The link now leads to another directory: with a file of that name there, and without one.
      await fs.rm(link, { recursive: true, force: true });
      await fs.symlink(second, link, linkKind);
      expect(exactFileGrantState(grant)).toBe('changed');
      await fs.rm(path.join(second, 'notes.md'));
      expect(exactFileGrantState(grant)).toBe('changed');

      await fs.rm(link, { recursive: true, force: true });
      expect(exactFileGrantState(grant)).toBe('changed');
    } finally {
      await fs.rm(link, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('compares two paths as one location and never as containment', () => {
    const file = path.resolve('/workspace/docs/notes.md');
    expect(samePath(file, path.resolve('/workspace/docs/../docs/notes.md'))).toBe(true);
    expect(samePath(file, path.resolve('/workspace/docs/notes.md.bak'))).toBe(false);
    expect(samePath(file, path.resolve('/workspace/docs'))).toBe(false);
    expect(samePath(path.resolve('/workspace/docs'), file)).toBe(false);
    expect(samePath(file, path.join(file, 'child'))).toBe(false);
  });

  it('lists an exact file among the readable ceilings as itself only', async () => {
    const { root, notes, other } = await workspace();
    try {
      const effective = compile(root, [{ path: 'other', permission: 'read' }, { path: 'docs/notes.md', permission: 'read' }]);
      expect(readablePathCeilings(effective)).toEqual([path.resolve(other), path.resolve(notes)]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('gives exact files to no agent confined by folders, and refuses one that was granted no folder', async () => {
    const { root, notes } = await workspace();
    try {
      expect(exactFileGrantsOnFolderRoute(compile(root, undefined))).toEqual({ ignored: [], refused: false });
      expect(exactFileGrantsOnFolderRoute(compile(root, [{ path: 'other', permission: 'readwrite' }]))).toEqual({ ignored: [], refused: false });
      expect(exactFileGrantsOnFolderRoute(compile(root, [
        { path: 'other', permission: 'readwrite' },
        { path: 'docs/notes.md', permission: 'read' },
      ]))).toEqual({ ignored: [path.resolve(notes)], refused: false });
      // With files only, the fallback root would otherwise become a working directory the grants never named.
      const filesOnly = compile(root, [{ path: 'docs/notes.md', permission: 'readwrite' }]);
      expect(exactFileGrantsOnFolderRoute(filesOnly)).toEqual({ ignored: [path.resolve(notes)], refused: true });
      expect(filesOnly.primaryRoot).toBe(path.resolve(root));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/*
 * v0.9.97 P1: a folder whose name starts with two dots is a folder of the one that holds it, for every Folder Access
 * decision: the untrusted-workspace filter, collapsing, file grants and task scopes. A sibling whose name starts like
 * the root is not (the file-effects design, §5). Collapsing a "..name" folder into its parent gives it the parent's
 * authority, as any child folder has; the read-only warning above says so.
 */
describe('P1: Folder Access holds a "..name" folder by whole path segments', { timeout: 20_000 }, () => {
  async function dotted(): Promise<{ base: string; root: string; cache: string; notes: string; sibling: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-fa-p1-'));
    await fs.mkdir(path.join(base, 'repo', '..cache'), { recursive: true });
    await fs.mkdir(path.join(base, 'repo-cache'));
    await fs.writeFile(path.join(base, 'repo', '..cache', 'notes.md'), 'notes\n', 'utf8');
    await fs.writeFile(path.join(base, 'repo-cache', 'notes.md'), 'sibling\n', 'utf8');
    const root = await fs.realpath(path.join(base, 'repo'));
    const cache = path.join(root, '..cache');
    return { base, root, cache, notes: path.join(cache, 'notes.md'), sibling: await fs.realpath(path.join(base, 'repo-cache')) };
  }

  function compile(root: string, grants: FolderGrant[], isTrusted = true) {
    return resolveEffectiveRoots({ grants, fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted });
  }

  it('keeps a "..name" grant in an untrusted workspace, and drops a sibling one', async () => {
    const { base, root, cache, sibling } = await dotted();
    try {
      const effective = compile(root, [{ path: '..cache', permission: 'read' }, { path: sibling, permission: 'read' }], false);
      expect(effective.readRoots).toEqual([cache]);
      expect(effective.issues.map((issue) => [issue.kind, issue.path])).toEqual([['untrusted-outside-workspace', sibling]]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('collapses a "..name" folder into the folder that holds it, and never into a sibling', async () => {
    const { base, root, sibling } = await dotted();
    try {
      const effective = compile(root, [
        { path: root, permission: 'readwrite' },
        { path: '..cache', permission: 'readwrite' },
        { path: sibling, permission: 'readwrite' },
      ]);
      expect(effective.writeRoots).toEqual([root, sibling]);
      expect(effective.readRoots).toEqual([root, sibling]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('folds a read-only "..name" file into the writable folder that holds it, and keeps a writable one beside a read-only folder', async () => {
    const { base, root, notes } = await dotted();
    try {
      const folded = compile(root, [{ path: root, permission: 'readwrite' }, { path: '..cache/notes.md', permission: 'read' }]);
      expect(folded.readFiles).toEqual([]);
      expect(folded.writeFiles).toEqual([]);
      // A writable file inside a writable folder adds nothing either, so a folder route is told of no ignored file.
      const foldedWritable = compile(root, [{ path: root, permission: 'readwrite' }, { path: '..cache/notes.md', permission: 'readwrite' }]);
      expect(foldedWritable.readFiles).toEqual([]);
      expect(foldedWritable.writeFiles).toEqual([]);
      expect(exactFileGrantsOnFolderRoute(foldedWritable)).toEqual({ ignored: [], refused: false });
      const kept = compile(root, [{ path: root, permission: 'read' }, { path: '..cache/notes.md', permission: 'readwrite' }]);
      expect(kept.writeFiles.map((file) => file.realPath)).toEqual([notes]);
      expect(kept.writeRoots).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('narrows a task scope to a "..name" folder or file of the configured folder, and to nothing for a sibling', async () => {
    const { base, root, cache, notes, sibling } = await dotted();
    try {
      const configured = compile(root, [{ path: root, permission: 'readwrite' }]);
      expect(intersectTaskWorkspaceAccess(configured, compile(root, [{ path: '..cache', permission: 'readwrite' }]), true, root))
        .toMatchObject({ commandCwd: cache, readRoots: [cache], writeRoots: [cache] });
      const file = intersectTaskWorkspaceAccess(configured, compile(root, [{ path: '..cache/notes.md', permission: 'readwrite' }]), true, root);
      expect(file?.writeFiles.map((grant) => grant.realPath)).toEqual([notes]);
      // A configured "..name" folder under a requested parent: the "..name" folder, never the parent.
      expect(intersectTaskWorkspaceAccess(compile(root, [{ path: '..cache', permission: 'readwrite' }]), configured, true, root))
        .toMatchObject({ readRoots: [cache], writeRoots: [cache] });
      // A configured "..name" file under a requested parent: that file, never the parent.
      const configuredFile = intersectTaskWorkspaceAccess(compile(root, [{ path: '..cache/notes.md', permission: 'readwrite' }]), configured, true, root);
      expect(configuredFile).toMatchObject({ readRoots: [], writeRoots: [] });
      expect(configuredFile?.writeFiles.map((grant) => grant.realPath)).toEqual([notes]);
      expect(intersectTaskWorkspaceAccess(configured, compile(root, [{ path: sibling, permission: 'readwrite' }]), true, root)).toBeUndefined();
      expect(intersectTaskWorkspaceAccess(configured, compile(root, [{ path: path.join(sibling, 'notes.md'), permission: 'readwrite' }]), true, root))
        .toBeUndefined();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
