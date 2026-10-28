import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { windowsNameProblem } from '../workspacePath';
import { exists, protectedFixture, protectedFoldersIntact, removeTemporaryFolders, shortNameOf, temporaryFolder } from './pathSafetyFixtures';

/*
 * v0.9.97 S0, defect S1 in released v0.9.96: delete_dir protected .git and .unode by the written path only, so
 * `.git::$INDEX_ALLOCATION` and an 8.3 short name deleted the real folder. The Windows name rule now refuses, for
 * every file write and delete tool, the names Windows reads as something other than an ordinary file.
 */

afterEach(removeTemporaryFolders);

const tools = (root: string) => new WorkspaceTools(root, new Set(['read', 'write']));

async function notSucceeded(outcome: Promise<{ status: string }>): Promise<string> {
  const settled = await outcome.catch((error: Error) => ({ status: `threw: ${error.message}` }));
  expect(settled.status).not.toBe('success');
  return settled.status;
}

describe.runIf(process.platform === 'win32')('S1: delete_dir refuses NTFS alias spellings of .git and .unode', () => {
  it('refuses the $INDEX_ALLOCATION stream spelling of a protected folder', async () => {
    const root = await protectedFixture();
    for (const spelling of ['.git::$INDEX_ALLOCATION', '.GIT::$INDEX_ALLOCATION', '.unode::$INDEX_ALLOCATION']) {
      expect(await tools(root).runText('delete_dir', { path: spelling }), spelling).toMatch(/refuses to delete protected/);
    }
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('refuses the 8.3 short name of a protected folder', async (context) => {
    const root = await protectedFixture();
    const gitShort = shortNameOf(root, '.git');
    const unodeShort = shortNameOf(root, '.unode');
    if (!gitShort || !unodeShort) {
      context.skip('this volume does not generate 8.3 short names');
    }
    for (const spelling of [gitShort!, unodeShort!, gitShort!.toLowerCase()]) {
      expect(await tools(root).runText('delete_dir', { path: spelling }), spelling).toMatch(/refuses to delete protected/);
    }
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('refuses a link to a protected folder whose name on disk differs in case', async () => {
    const root = await temporaryFolder('unode-s1-case-');
    await fs.mkdir(path.join(root, '.GIT'));
    await fs.writeFile(path.join(root, '.GIT', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await fs.symlink(path.join(root, '.GIT'), path.join(root, 'innocent'), 'junction');
    expect(await tools(root).runText('delete_dir', { path: 'innocent' })).toMatch(/refuses to delete protected/);
    expect(await exists(path.join(root, '.GIT', 'HEAD'))).toBe(true);
  });

  it('still deletes an ordinary folder by its short name', async (context) => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'build-output-folder'));
    const short = shortNameOf(root, 'build-output-folder');
    if (!short) {
      context.skip('this volume does not generate 8.3 short names');
    }
    expect(await tools(root).runText('delete_dir', { path: short! })).toMatch(/Deleted directory/);
    expect(await exists(path.join(root, 'build-output-folder'))).toBe(false);
  });
});

describe('S1: delete_dir judges the folder its path physically names', () => {
  it('refuses a link whose target is a protected folder', async () => {
    const root = await protectedFixture();
    await fs.symlink(path.join(root, '.git'), path.join(root, 'innocent'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await tools(root).runText('delete_dir', { path: 'innocent' })).toMatch(/refuses to delete protected/);
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('refuses the workspace root spelled as sub/.. or as its absolute path', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'sub'));
    for (const spelling of ['sub/..', root]) {
      // Refused before the protected check: the root's own parent is outside the workspace.
      expect(await notSucceeded(tools(root).run('delete_dir', { path: spelling })), spelling).toMatch(/refused|failed/);
    }
    expect(await exists(path.join(root, 'sub'))).toBe(true);
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('refuses a folder that is itself a write root, even when another root holds it', async () => {
    const root = await protectedFixture();
    const sub = path.join(root, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'keep.txt'), 'keep', 'utf8');
    const overlapping = new WorkspaceTools(root, new Set(['read', 'write']));
    overlapping.setTurnWorkspaceAccess({ pathBase: root, commandCwd: root, readRoots: [root, sub], writeRoots: [root, sub] });
    expect(await overlapping.runText('delete_dir', { path: 'sub' })).toMatch(/refuses to delete protected/);
    expect(await exists(path.join(sub, 'keep.txt'))).toBe(true);
  });

  it('refuses a link into .git under any write root, whatever their order', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, '.git', 'inner'));
    await fs.symlink(path.join(root, '.git', 'inner'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const writeRoots of [[path.join(root, '.git'), root], [root, path.join(root, '.git')]]) {
      const scoped = new WorkspaceTools(root, new Set(['read', 'write']));
      scoped.setTurnWorkspaceAccess({ pathBase: root, commandCwd: root, readRoots: writeRoots, writeRoots });
      expect(await notSucceeded(scoped.run('delete_dir', { path: 'alias' })), writeRoots.join(' | ')).toMatch(/refused|failed/);
    }
    expect(await exists(path.join(root, '.git', 'inner'))).toBe(true);
  });

  // Codex's audit of 8c552a5, R2, reached since P1 (v0.9.97): the sandbox check no longer misreads a "..name" folder
  // as outside, so these calls get as far as the protected check, and only that check refuses them.
  it('refuses a link into a .git that lies under a "..name" folder', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, '..cache', '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '..cache', '.git', 'HEAD'), 'ref', 'utf8');
    await fs.symlink(path.join(root, '..cache', '.git'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await tools(root).runText('delete_dir', { path: 'alias' })).toMatch(/refuses to delete protected/);
    expect(await exists(path.join(root, '..cache', '.git', 'HEAD'))).toBe(true);
  });

  it('refuses a link inside a "..name" folder that leads to a .git folder, and deletes an ordinary folder there', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, '..cache', 'repo', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, '..cache', 'repo', 'build'));
    await fs.writeFile(path.join(root, '..cache', 'repo', '.git', 'HEAD'), 'ref', 'utf8');
    await fs.symlink(path.join(root, '..cache', 'repo', '.git'), path.join(root, '..cache', 'gitlink'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await tools(root).runText('delete_dir', { path: '..cache/gitlink' })).toMatch(/refuses to delete protected/);
    expect(await exists(path.join(root, '..cache', 'gitlink'))).toBe(true);
    expect(await exists(path.join(root, '..cache', 'repo', '.git', 'HEAD'))).toBe(true);
    // The "..name" folder itself is not what is refused.
    expect(await tools(root).runText('delete_dir', { path: '..cache/repo/build' })).toMatch(/Deleted directory/);
    expect(await exists(path.join(root, '..cache', 'repo', 'build'))).toBe(false);
  });

  it('still deletes an ordinary folder, and a folder whose name only starts with .git', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'scratch', 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, '.github'));
    expect(await tools(root).runText('delete_dir', { path: 'scratch' })).toMatch(/Deleted directory/);
    expect(await tools(root).runText('delete_dir', { path: '.github' })).toMatch(/Deleted directory/);
    expect(await exists(path.join(root, 'scratch'))).toBe(false);
    expect(await exists(path.join(root, '.github'))).toBe(false);
  });
});

describe('the Windows name rule, as a pure function', () => {
  const problem = (target: string) => windowsNameProblem(target, 'win32');

  it('names each kind of name Windows reads as something other than an ordinary file', () => {
    for (const target of ['x.txt:hidden', 'README.md::$DATA', '.git::$INDEX_ALLOCATION', 'sub\\a:b\\c.txt']) {
      expect(problem(target), target).toMatch(/":"|alternate data stream/);
    }
    for (const target of ['a.', 'a ', 'dir./x.txt', 'notes.txt ']) {
      expect(problem(target), target).toMatch(/dot or a space/);
    }
    for (const target of ['nul', 'NUL', 'con.md', 'Com1.log', 'lpt9', 'aux.tar.gz', 'prn', 'COM0', 'LPT¹', 'conin$', 'CONOUT$', 'sub/nul/x.txt', 'nul .txt']) {
      expect(problem(target), target).toMatch(/reserved Windows device name/);
    }
  });

  it('accepts ordinary names, absolute Windows paths and . or .. segments', () => {
    for (const target of [
      'README.md', 'a.b.txt', 'notes.v2', 'console.md', 'nul-check.txt', 'COM10.txt', 'lpt.txt', '.git', '..cache/x.json',
      'C:\\Users\\dev\\project\\src\\app.ts', 'C:/Users/dev/project/x.txt', '\\\\server\\share\\x.txt', './a/../b.txt', 'sub\\.\\x.txt',
    ]) {
      expect(problem(target), target).toBeUndefined();
    }
  });

  it('has no rule on other hosts', () => {
    expect(windowsNameProblem('x.txt:hidden', 'linux')).toBeUndefined();
    expect(windowsNameProblem('nul', 'darwin')).toBeUndefined();
  });
});

describe.runIf(process.platform === 'win32')('the Windows name rule holds for every file write and delete tool', () => {
  async function readme(): Promise<string> {
    const root = await temporaryFolder('unode-names-');
    await fs.writeFile(path.join(root, 'README.md'), 'original\n', 'utf8');
    await fs.mkdir(path.join(root, 'dir'));
    return root;
  }

  it('write_file creates no stream, device-named file or trailing-dot name', async () => {
    const root = await readme();
    const t = tools(root);
    for (const target of ['README.md:hidden', 'README.md::$DATA', 'nul', 'con.md', 'COM1.log', 'a.', 'a ']) {
      expect(await notSucceeded(t.run('write_file', { path: target, content: 'x' })), target).toBe('failed');
    }
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('original\n');
    await expect(fs.readFile(path.join(root, 'README.md:hidden'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).sort()).toEqual(['README.md', 'dir']);
  });

  it('apply_edit and apply_patch refuse the stream spelling of a file', async () => {
    const root = await readme();
    const t = tools(root);
    expect(await t.runText('read_file', { path: 'README.md' })).toContain('original');
    expect(await notSucceeded(t.run('apply_edit', { path: 'README.md::$DATA', old_string: 'original', new_string: 'edited' }))).toBe('failed');
    t.setEditToolDialect('apply-patch');
    expect(await notSucceeded(t.run('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: README.md::$DATA\n@@\n-original\n+patched\n*** End Patch',
    }))).toBe('failed');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('original\n');
  });

  it('delete_file and delete_dir refuse such names and delete nothing', async () => {
    const root = await readme();
    const t = tools(root);
    expect(await notSucceeded(t.run('delete_file', { path: 'README.md::$DATA' }))).toBe('failed');
    expect(await notSucceeded(t.run('delete_dir', { path: 'dir.' }))).toBe('failed');
    expect(await notSucceeded(t.run('delete_dir', { path: 'dir::$INDEX_ALLOCATION' }))).toBe('failed');
    expect((await fs.readdir(root)).sort()).toEqual(['README.md', 'dir']);
  });

  it('still writes an ordinary file by an absolute Windows path', async () => {
    const root = await readme();
    expect(await tools(root).runText('write_file', { path: path.join(root, 'ok.txt'), content: 'fine' })).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(root, 'ok.txt'), 'utf8')).toBe('fine');
  });
});
