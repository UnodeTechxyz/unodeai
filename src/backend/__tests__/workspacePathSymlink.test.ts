import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveInsideRoot, resolveInsideRootPhysical } from '../workspacePath';

/**
 * Real links on a real filesystem. A lexical check cannot see a symlink, so a test that only feeds
 * it strings proves nothing about this boundary — the point of these cases is that the LEXICAL
 * answer and the PHYSICAL answer disagree, and only the physical one is safe to write through.
 *
 * Directory junctions are used on Windows because they need no elevation; POSIX gets a normal
 * directory symlink. File symlinks DO need elevation on Windows, so that one case is skipped there
 * rather than being made to pass by weakening the assertion.
 */
describe('resolveInsideRootPhysical with real links', () => {
  let base: string;
  let root: string;
  let outside: string;
  let fileLinkSupported = true;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-path-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'inside', 'utf8');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');

    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'linkedFile.txt'), 'file');
    } catch {
      fileLinkSupported = false; // Windows without Developer Mode / elevation
    }
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('still resolves ordinary paths inside the workspace', async () => {
    await expect(resolveInsideRootPhysical(root, 'src/app.ts')).resolves.toEqual({
      status: 'resolved', path: await fs.realpath(path.join(root, 'src', 'app.ts')),
    });
  });

  it('resolves a file that does not exist yet inside a real directory', async () => {
    const resolved = await resolveInsideRootPhysical(root, 'src/created-later.ts');
    expect(resolved).toEqual({ status: 'resolved', path: path.join(await fs.realpath(path.join(root, 'src')), 'created-later.ts') });
  });

  it('REFUSES a path through a linked directory, which the lexical check accepts', async () => {
    // The exact bypass: `linked` is inside the workspace by name, and points outside it in fact.
    expect(resolveInsideRoot(root, 'linked/secret.txt').status).toBe('resolved');
    await expect(resolveInsideRootPhysical(root, 'linked/secret.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });

  it('REFUSES a not-yet-existing file under a linked directory', async () => {
    // Restore recreates deleted files, so the target frequently does not exist. The nearest existing
    // ancestor is the link itself, and that is what has to be resolved.
    expect(resolveInsideRoot(root, 'linked/target.txt').status).toBe('resolved');
    await expect(resolveInsideRootPhysical(root, 'linked/target.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });

  it('REFUSES a nested not-yet-existing path under a linked directory', async () => {
    await expect(resolveInsideRootPhysical(root, 'linked/deep/nested/target.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });

  it('REFUSES a symlinked file pointing outside', async ({ skip }) => {
    if (!fileLinkSupported) {
      skip();
      return;
    }
    expect(resolveInsideRoot(root, 'linkedFile.txt').status).toBe('resolved');
    await expect(resolveInsideRootPhysical(root, 'linkedFile.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });

  it('still refuses the lexical escapes', async () => {
    await expect(resolveInsideRootPhysical(root, '../outside/secret.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, path.join(outside, 'secret.txt'))).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, '.')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });
});
