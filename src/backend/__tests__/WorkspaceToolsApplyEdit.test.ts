import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots } from '../folderAccess';
import { WorkspaceTools } from '../WorkspaceTools';
import type { FolderGrant } from '../../types';

async function sandbox(content: string): Promise<{ tools: WorkspaceTools; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-edit-'));
  await fs.writeFile(path.join(root, 'README.md'), content, 'utf8');
  return { tools: new WorkspaceTools(root, new Set(['read', 'write']), 'test'), root };
}

describe('apply_edit (targeted edit + Edit-alias target)', () => {
  it('replaces an exact unique snippet and writes the file', async () => {
    const { tools, root } = await sandbox('# Title\nhello\n');
    const out = await tools.runText('apply_edit', { path: 'README.md', old_string: 'hello', new_string: 'hello\nCanada vs Qatar' });
    expect(out).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# Title\nhello\nCanada vs Qatar\n');
  });

  it('errors when old_string is not found (and does not change the file)', async () => {
    const { tools, root } = await sandbox('one\ntwo\n');
    const out = await tools.runText('apply_edit', { path: 'README.md', old_string: 'three', new_string: 'x' });
    expect(out).toMatch(/not found/i);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('one\ntwo\n'); // untouched
  });

  it('errors on an ambiguous match unless replace_all is set', async () => {
    const { tools, root } = await sandbox('a\na\n');
    const ambiguous = await tools.runText('apply_edit', { path: 'README.md', old_string: 'a', new_string: 'b' });
    expect(ambiguous).toMatch(/appears 2 times/i);
    const all = await tools.runText('apply_edit', { path: 'README.md', old_string: 'a', new_string: 'b', replace_all: true });
    expect(all).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('b\nb\n');
  });

  it('errors when the file does not exist (points to write_file)', async () => {
    const { tools } = await sandbox('x');
    const out = await tools.runText('apply_edit', { path: 'nope.md', old_string: 'x', new_string: 'y' });
    expect(out).toMatch(/file not found/i);
    expect(out).toMatch(/write_file/);
  });

  it('refuses without the write capability', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-edit-ro-'));
    await fs.writeFile(path.join(root, 'README.md'), 'hi', 'utf8');
    const readOnly = new WorkspaceTools(root, new Set(['read']), 'test');
    await expect(readOnly.run('apply_edit', { path: 'README.md', old_string: 'hi', new_string: 'bye' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
  });

  it('advertises apply_edit only with the write capability', () => {
    const names = (s: Set<string>) => new WorkspaceTools('/tmp', s, 't').specs().map((x) => x.function.name);
    expect(names(new Set(['write']))).toContain('apply_edit');
    expect(names(new Set(['read']))).not.toContain('apply_edit');
  });

  it('offers and executes the apply_patch-shaped edit surface when selected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-patch-'));
    await fs.writeFile(path.join(root, 'README.md'), 'old value\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'test');
    tools.setEditToolDialect('apply-patch');

    expect(tools.specs().map((spec) => spec.function.name)).toContain('apply_patch');
    expect(tools.specs().map((spec) => spec.function.name)).not.toContain('apply_edit');
    const out = await tools.runText('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-old value\n+new value\n*** End Patch',
    });
    expect(out).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('new value\n');
  });
});

/** Scope `tools` as a delegated worker receives a task scope (the host's two calls) or as a coordinator sets its own. */
function scopeOnRoute(route: 'delegated' | 'coordinator', tools: WorkspaceTools, root: string, scope: FolderGrant[]): boolean {
  if (route === 'coordinator') {
    return tools.setContractTaskScope({ folderAccess: scope });
  }
  const options = { fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted: true };
  const access = intersectTaskWorkspaceAccess(
    resolveEffectiveRoots({ ...options, grants: undefined }),
    resolveEffectiveRoots({ ...options, grants: scope }),
    true,
    root,
  );
  if (!access) {
    return false;
  }
  tools.setTurnWorkspaceAccess(access);
  return true;
}

describe('apply_edit and apply_patch under an exact-file grant', () => {
  const ROUTES = ['delegated', 'coordinator'] as const;

  async function twoFiles(): Promise<{ tools: WorkspaceTools; root: string; granted: string; other: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-edit-file-grant-'));
    const granted = path.join(root, 'granted.md');
    const other = path.join(root, 'other.md');
    await fs.writeFile(granted, 'alpha beta\n', 'utf8');
    await fs.writeFile(other, 'alpha beta\n', 'utf8');
    return { tools: new WorkspaceTools(root, new Set(['read', 'write']), 'test'), root, granted, other };
  }

  it.each(ROUTES)('edits the granted file and refuses the file beside it (%s route)', async (route) => {
    const { tools, root, granted, other } = await twoFiles();
    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'granted.md', permission: 'readwrite' }])).toBe(true);

      expect(await tools.run('apply_edit', { path: 'granted.md', old_string: 'alpha', new_string: 'gamma' }))
        .toMatchObject({ status: 'success' });
      expect(await fs.readFile(granted, 'utf8')).toBe('gamma beta\n');
      // The same edit, the same text, one name over: refused before the file is read for a match.
      expect(await tools.run('apply_edit', { path: 'other.md', old_string: 'alpha', new_string: 'gamma' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('apply_edit', { path: 'other.md', old_string: 'no such text', new_string: 'gamma' }))
        .toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readFile(other, 'utf8')).toBe('alpha beta\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('patches the granted file and refuses a patch that names the file beside it (%s route)', async (route) => {
    const { tools, root, granted, other } = await twoFiles();
    tools.setEditToolDialect('apply-patch');
    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'granted.md', permission: 'readwrite' }])).toBe(true);

      expect(await tools.run('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: granted.md\n@@\n-alpha beta\n+patched\n*** End Patch',
      })).toMatchObject({ status: 'success', name: 'apply_patch' });
      expect(await fs.readFile(granted, 'utf8')).toBe('patched\n');
      expect(await tools.run('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: other.md\n@@\n-alpha beta\n+patched\n*** End Patch',
      })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await fs.readFile(other, 'utf8')).toBe('alpha beta\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('edits nothing under a read-only file grant (%s route)', async (route) => {
    const { tools, root, granted } = await twoFiles();
    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'granted.md', permission: 'read' }])).toBe(true);

      expect(await tools.runText('read_file', { path: 'granted.md' })).toContain('alpha beta');
      expect(await tools.run('apply_edit', { path: 'granted.md', old_string: 'alpha', new_string: 'gamma' }))
        .toMatchObject({ status: 'refused' });
      tools.setEditToolDialect('apply-patch');
      expect(await tools.run('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: granted.md\n@@\n-alpha beta\n+patched\n*** End Patch',
      })).toMatchObject({ status: 'refused' });
      expect(tools.specs().map((spec) => spec.function.name)).not.toContain('apply_patch');
      expect(await fs.readFile(granted, 'utf8')).toBe('alpha beta\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
