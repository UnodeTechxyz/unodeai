import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots, writeRootsForTrust } from '../folderAccess';

describe('resolveEffectiveRoots', () => {
  it('drops every writable root when Workspace Trust is off', () => {
    expect(writeRootsForTrust(['C:\\workspace', 'C:\\scratch'], false)).toEqual([]);
    expect(writeRootsForTrust(['C:\\workspace'], true)).toEqual(['C:\\workspace']);
  });

  it('intersects a wider task request with configured Folder Access instead of replacing it (R1 mutation gate)', () => {
    const configured = {
      readRoots: [path.resolve('/workspace/src')],
      writeRoots: [],
    };
    const request = {
      // The coordinator asks for the whole workspace and write access; it must get only the agent's
      // configured src read root. Mutating intersection to replacement makes this named test fail.
      readRoots: [path.resolve('/workspace')],
      writeRoots: [path.resolve('/workspace')],
    };

    expect(intersectTaskWorkspaceAccess(configured, request, true, path.resolve('/workspace'))).toEqual({
      pathBase: path.resolve('/workspace'),
      commandCwd: path.resolve('/workspace'),
      readRoots: [path.resolve('/workspace/src')],
      writeRoots: [],
    });
  });

  it('keeps pathBase at the configured root while containing commandCwd inside a writable task scope', () => {
    const workspace = path.resolve('/workspace');
    const research = path.resolve('/workspace/research');

    expect(intersectTaskWorkspaceAccess(
      { readRoots: [workspace], writeRoots: [research] },
      { readRoots: [research], writeRoots: [research] },
      true,
      workspace,
    )).toEqual({
      pathBase: workspace,
      commandCwd: research,
      readRoots: [research],
      writeRoots: [research],
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
