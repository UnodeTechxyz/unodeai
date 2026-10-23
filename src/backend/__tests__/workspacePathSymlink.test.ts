import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileIdentity, nameIsTaken, resolveInsideRoot, resolveInsideRootPhysical } from '../workspacePath';

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

  it('REFUSES a link whose target does not exist, which a write would go through', async () => {
    // Nothing resolves at the link, so its directory used to decide, and that is inside. A junction whose target
    // is gone is the same case on Windows, where a file symlink needs elevation.
    const kind = process.platform === 'win32' ? 'junction' : 'file';
    await fs.symlink(path.join(outside, 'created-through-the-link.txt'), path.join(root, 'dangling.txt'), kind);
    expect(resolveInsideRoot(root, 'dangling.txt').status).toBe('resolved');
    await expect(resolveInsideRootPhysical(root, 'dangling.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
    // A name nothing holds is still resolved beside it.
    await expect(resolveInsideRootPhysical(root, 'not-there.txt')).resolves.toMatchObject({ status: 'resolved' });
  });

  it('counts a name as free only when nothing is there', async () => {
    expect(await nameIsTaken(path.join(root, 'src', 'app.ts'))).toBe(true);
    expect(await nameIsTaken(path.join(root, 'linked'))).toBe(true);
    expect(await nameIsTaken(path.join(root, 'nothing-here.txt'))).toBe(false);
    // A name the system will not look up is not known to be free.
    expect(await nameIsTaken(path.join(root, 'no\0such'))).toBe(true);
  });

  it('still refuses the lexical escapes', async () => {
    await expect(resolveInsideRootPhysical(root, '../outside/secret.txt')).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, path.join(outside, 'secret.txt'))).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, '.')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });
});

/*
 * v0.9.97 P1: a folder whose name starts with two dots is a folder of the workspace for checkpoint restore and diff,
 * the Codex checkpoint, the memory and rules files and the docs index; a link is still judged by where it leads
 * (the file-effects design, §5).
 */
describe('resolveInsideRootPhysical and fileIdentity with a "..name" folder', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-path-dots-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'workspace-cache');
    await fs.mkdir(path.join(root, '..cache'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, '..cache', 'x.json'), 'inside', 'utf8');
    await fs.writeFile(path.join(outside, 'x.json'), 'sibling', 'utf8');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, path.join(root, '..cache', 'to-sibling'), kind);
    await fs.symlink(path.join(root, '..cache'), path.join(root, 'alias'), kind);
    await fs.symlink(root, path.join(base, 'via-link'), kind);
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('resolves an existing file, a new file and a new nested path under it', async () => {
    const realCache = await fs.realpath(path.join(root, '..cache'));
    await expect(resolveInsideRootPhysical(root, '..cache/x.json')).resolves.toEqual({ status: 'resolved', path: path.join(realCache, 'x.json') });
    await expect(resolveInsideRootPhysical(root, '..cache/new.json')).resolves.toEqual({ status: 'resolved', path: path.join(realCache, 'new.json') });
    // Nothing on the way exists yet but the root: the new "..name" folder is created inside it.
    await expect(resolveInsideRootPhysical(root, '..new/deep/x.json')).resolves.toEqual({
      status: 'resolved', path: path.join(await fs.realpath(root), '..new', 'deep', 'x.json'),
    });
  });

  it('resolves a link that leads into the "..name" folder, and refuses one in it that leads to the sibling', async () => {
    await expect(resolveInsideRootPhysical(root, 'alias/x.json')).resolves.toEqual({
      status: 'resolved', path: path.join(await fs.realpath(path.join(root, '..cache')), 'x.json'),
    });
    await expect(resolveInsideRootPhysical(root, '..cache/to-sibling/x.json')).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, '..cache/to-sibling/new.json')).resolves.toEqual({ status: 'refused', reason: 'scope' });
    await expect(resolveInsideRootPhysical(root, '../workspace-cache/x.json')).resolves.toEqual({ status: 'refused', reason: 'scope' });
  });

  it('gives a "..name" file the physical identity a link to it has', () => {
    // The root is named through a link, so the lexical and the physical identity of a file in it differ.
    const viaLink = path.join(base, 'via-link');
    const identity = fileIdentity(path.join(viaLink, '..cache', 'x.json'), [viaLink]);
    expect(identity).toBe(fileIdentity(path.join(viaLink, 'alias', 'x.json'), [viaLink]));
    expect(identity).toBe(fileIdentity(path.join(root, '..cache', 'x.json'), [root]));
    // Outside every root the identity stays lexical: the filesystem is not asked about it.
    expect(fileIdentity(path.join(outside, 'x.json'), [root])).toBe(
      process.platform === 'win32' ? path.join(outside, 'x.json').toLowerCase() : path.join(outside, 'x.json'),
    );
  });
});
