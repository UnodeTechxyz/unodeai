import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CommandPolicy } from '../CommandPolicy';
import { WorkspaceTools } from '../WorkspaceTools';
import { exists, removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { asProvider } from './shellFixtures';

/*
 * v0.9.97 P1. A folder whose name starts with two dots (`..cache`) is an ordinary child of the workspace, and the file
 * tools treat it as one: "Allow an authorised child named `..agent` or `..cache`, but never a real `..` parent,
 * sibling `repo-cache`, different drive/share or physical link escape" (the v0.9.97 file-effects design, §5). Until
 * v0.9.96 every check that compared `path.relative(root, target)` with a leading `..` refused such a folder as if it
 * were the parent, for reads, writes, deletes, commands, receipts and links alike.
 */

afterEach(removeTemporaryFolders);

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

interface Fixture {
  base: string;
  root: string;
  sibling: string;
  outsideDir: string;
}

/**
 * `<base>/ws` is the workspace: a root `x.json` and `sub/keep.txt`, and a `..cache` folder holding files of the same
 * names. Beside it, `<base>/ws-cache` is a sibling whose name starts like the workspace's, `<base>/outside.txt` is a
 * file of the real parent, and `<base>/outside-dir` is a folder outside with one marker file.
 */
async function dotFixture(): Promise<Fixture> {
  const base = await temporaryFolder('unode-p1-');
  const root = path.join(base, 'ws');
  const sibling = path.join(base, 'ws-cache');
  const outsideDir = path.join(base, 'outside-dir');
  await fs.mkdir(path.join(root, '..cache', 'sub'), { recursive: true });
  await fs.mkdir(path.join(root, 'sub'));
  await fs.mkdir(sibling);
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(root, 'x.json'), 'ROOT', 'utf8');
  await fs.writeFile(path.join(root, 'sub', 'keep.txt'), 'ROOT SUB', 'utf8');
  await fs.writeFile(path.join(root, '..cache', 'x.json'), 'CACHE', 'utf8');
  await fs.writeFile(path.join(root, '..cache', 'sub', 'keep.txt'), 'CACHE SUB', 'utf8');
  await fs.writeFile(path.join(sibling, 'x.json'), 'SIBLING', 'utf8');
  await fs.writeFile(path.join(base, 'outside.txt'), 'OUTSIDE', 'utf8');
  await fs.writeFile(path.join(outsideDir, 'marker.txt'), 'MARKER', 'utf8');
  return { base, root, sibling, outsideDir };
}

/** Tools that ask for every write and record each approval, checkpoint and out-of-root notice by path. */
function observedTools(root: string) {
  const approvals: string[] = [];
  const checkpoints: string[] = [];
  const outside: string[] = [];
  const tools = new WorkspaceTools(
    root, new Set(['read', 'write']), 'agent', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (entry) => { checkpoints.push(entry.path); },
    () => true,
    async (request) => { approvals.push(request.path); return 'once'; },
    undefined,
    (attempted) => { outside.push(attempted); },
  );
  return { tools, approvals, checkpoints, outside };
}

const read = (root: string) => new WorkspaceTools(root, new Set(['read', 'write']));

describe('P1: a "..name" folder is a folder of the workspace', () => {
  it('reads, lists and searches it, by a relative or an absolute path', async () => {
    const { root } = await dotFixture();
    const { tools, outside } = observedTools(root);
    expect(await tools.run('read_file', { path: '..cache/x.json' })).toMatchObject({ status: 'success' });
    expect(await tools.runText('read_file', { path: '..cache/x.json' })).toContain('CACHE');
    expect(await tools.runText('read_file', { path: path.join(root, '..cache', 'x.json') })).toContain('CACHE');
    expect((await tools.runText('list_dir', { path: '..cache' })).split(/\r?\n/)).toEqual(['sub/', 'x.json']);
    const found = await tools.run('search_files', { query: 'CACHE SUB', path: '..cache' });
    expect(found.status).toBe('success');
    expect(found.output).toContain('..cache/sub/keep.txt:1:');
    // A path inside the workspace is no folder to offer the agent.
    expect(outside).toEqual([]);
  });

  it('writes, edits and deletes exactly the "..name" file it names, and asks and records by that path', async () => {
    const { root } = await dotFixture();
    const { tools, approvals, checkpoints, outside } = observedTools(root);
    expect(await tools.run('write_file', { path: '..cache/new.txt', content: 'NEW' })).toMatchObject({ status: 'success' });
    expect(await fs.readFile(path.join(root, '..cache', 'new.txt'), 'utf8')).toBe('NEW');
    expect(await exists(path.join(root, 'new.txt'))).toBe(false);

    expect(await tools.runText('read_file', { path: '..cache/x.json' })).toContain('CACHE');
    expect(await tools.run('apply_edit', { path: '..cache/x.json', old_string: 'CACHE', new_string: 'EDITED' }))
      .toMatchObject({ status: 'success' });
    expect(await fs.readFile(path.join(root, '..cache', 'x.json'), 'utf8')).toBe('EDITED');

    expect(await tools.run('delete_file', { path: '..cache/x.json' })).toMatchObject({ status: 'success' });
    expect(await exists(path.join(root, '..cache', 'x.json'))).toBe(false);
    expect(await tools.run('delete_dir', { path: '..cache/sub' })).toMatchObject({ status: 'success' });
    expect(await exists(path.join(root, '..cache', 'sub'))).toBe(false);

    // The same-named root files are untouched.
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
    expect(await fs.readFile(path.join(root, 'sub', 'keep.txt'), 'utf8')).toBe('ROOT SUB');
    expect(approvals).toEqual(['..cache/new.txt', '..cache/x.json', '..cache/x.json', '..cache/sub']);
    expect(checkpoints).toEqual(['..cache/new.txt', '..cache/x.json', '..cache/x.json', '..cache/sub']);
    expect(outside).toEqual([]);
  });

  it('still refuses the real parent, a sibling whose name starts like the workspace, and a path that climbs out', async () => {
    const { base, root, sibling } = await dotFixture();
    const spellings = [
      '../outside.txt',
      '..cache/../../outside.txt',
      '../ws-cache/x.json',
      path.join(sibling, 'x.json'),
      path.join(base, 'outside.txt'),
    ];
    for (const spelling of spellings) {
      const { tools, approvals } = observedTools(root);
      expect(await tools.run('read_file', { path: spelling }), spelling).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(await tools.run('write_file', { path: spelling, content: 'NO' }), spelling).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(await tools.run('delete_file', { path: spelling }), spelling).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      expect(approvals, spelling).toEqual([]);
    }
    for (const spelling of ['..', '..cache/../..', '../ws-cache']) {
      expect((await read(root).run('delete_dir', { path: spelling })).status, spelling).not.toBe('success');
      expect((await read(root).run('list_dir', { path: spelling })).status, spelling).toBe('refused');
    }
    expect(await fs.readFile(path.join(sibling, 'x.json'), 'utf8')).toBe('SIBLING');
    expect(await fs.readFile(path.join(base, 'outside.txt'), 'utf8')).toBe('OUTSIDE');
    expect(await exists(path.join(sibling, 'x.json'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('still refuses a path on another drive', async () => {
    const { root } = await dotFixture();
    const own = root[0].toUpperCase();
    const drive = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => letter !== own && !existsSync(`${letter}:\\`));
    expect(drive).toBeDefined();
    const elsewhere = `${drive}:\\elsewhere\\nothing-here.txt`;
    const tools = read(root);
    expect(await tools.run('read_file', { path: elsewhere })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await tools.run('write_file', { path: elsewhere, content: 'NO' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    // Under a "..name" folder the same path reads as a workspace path under a foreign prefix: refused, and named.
    const foreign = `${drive}:\\elsewhere\\..cache\\nothing-here.txt`;
    const refused = await tools.run('write_file', { path: foreign, content: 'NO' });
    expect(refused.status).toBe('failed');
    expect(refused.output).toContain('"..cache/nothing-here.txt" (does not exist)');
    expect(await exists(path.join(root, '..cache', 'nothing-here.txt'))).toBe(false);
  });
});

describe('P1: a link is judged by where it leads, whole segments included', () => {
  it('refuses a link inside a "..name" folder that leads out of the workspace', async () => {
    const { root, outsideDir } = await dotFixture();
    await fs.symlink(outsideDir, path.join(root, '..cache', 'out'), linkKind);
    const tools = read(root);
    expect(await tools.run('read_file', { path: '..cache/out/marker.txt' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await tools.run('write_file', { path: '..cache/out/new.txt', content: 'NO' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await tools.run('delete_file', { path: '..cache/out/marker.txt' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await fs.readdir(outsideDir)).toEqual(['marker.txt']);
  });

  it('refuses a link that leads to the sibling whose name starts like the workspace', async () => {
    const { root, sibling } = await dotFixture();
    await fs.symlink(sibling, path.join(root, 'sib'), linkKind);
    const tools = read(root);
    expect(await tools.run('read_file', { path: 'sib/x.json' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await tools.run('write_file', { path: 'sib/x.json', content: 'NO' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await fs.readFile(path.join(sibling, 'x.json'), 'utf8')).toBe('SIBLING');
  });

  it('follows a link that leads into a "..name" folder of the workspace, which is inside it', async () => {
    const { root } = await dotFixture();
    await fs.symlink(path.join(root, '..cache'), path.join(root, 'alias'), linkKind);
    const tools = read(root);
    expect(await tools.runText('read_file', { path: 'alias/x.json' })).toContain('CACHE');
    expect(await tools.run('write_file', { path: 'alias/through.txt', content: 'LINKED' })).toMatchObject({ status: 'success' });
    expect(await fs.readFile(path.join(root, '..cache', 'through.txt'), 'utf8')).toBe('LINKED');
  });

  it('gives a "..name" file one identity, whichever spelling or link names it', async () => {
    const { base, root } = await dotFixture();
    // The tools see the workspace through a link, so a lexical identity and a physical one differ.
    const viaLink = path.join(base, 'ws-link');
    await fs.symlink(root, viaLink, linkKind);
    await fs.symlink(path.join(root, '..cache'), path.join(root, 'alias'), linkKind);
    const tools = new WorkspaceTools(viaLink, new Set(['read', 'write']));
    const target = tools.fileEffectTarget('write_file', { path: '..cache/x.json' });
    expect(target).toBe(tools.fileEffectTarget('delete_file', { path: 'alias/x.json' }));
    // Outside the tools' roots the identity is the path as written, so the absolute spelling is the physical one: the
    // fixture's own spelling of `root` may carry an 8.3 short name that the physical identity expands.
    expect(target).toBe(tools.fileEffectTarget('write_file', { path: path.join(await fs.realpath(root), '..cache', 'x.json') }));
    expect(target).not.toBe(tools.fileEffectTarget('write_file', { path: 'x.json' }));
  });
});

describe('P1: task scopes, commands and receipts hold a "..name" folder', () => {
  it('a task scope on a "..name" folder holds its files, and the path beside it is a task-scope refusal', async () => {
    const { root } = await dotFixture();
    const { tools, outside } = observedTools(root);
    const scoped = path.join(root, '..cache');
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: scoped, readRoots: [scoped], writeRoots: [scoped] });
    expect(await tools.run('write_file', { path: '..cache/new.txt', content: 'NEW' })).toMatchObject({ status: 'success' });
    expect(await tools.run('write_file', { path: 'x.json', content: 'NO' })).toMatchObject({ status: 'refused', reason: 'task-scope' });

    // Scoped to another folder, a "..name" file of the configured workspace is outside the task, not the workspace.
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: path.join(root, 'sub'), readRoots: [path.join(root, 'sub')], writeRoots: [path.join(root, 'sub')] });
    expect(await tools.run('read_file', { path: '..cache/x.json' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await tools.run('write_file', { path: '..cache/x.json', content: 'NO' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    // A link in the scope that leads to that "..name" folder is judged where it leads: outside the task, in the workspace.
    await fs.symlink(path.join(root, '..cache'), path.join(root, 'sub', 'alias'), linkKind);
    expect(await tools.run('read_file', { path: 'sub/alias/x.json' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await tools.run('write_file', { path: 'sub/alias/x.json', content: 'NO' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await fs.readFile(path.join(root, '..cache', 'x.json'), 'utf8')).toBe('CACHE');
    expect(outside).toEqual([]);
  });

  it('runs a command in a "..name" working folder of the scope, and never in a sibling', async () => {
    const { root, sibling } = await dotFixture();
    const cwds: string[] = [];
    const tools = new WorkspaceTools(
      root, new Set(['read', 'write', 'execute']), 'agent', undefined, new CommandPolicy('all'), undefined, undefined, undefined,
      undefined, asProvider(async (_command, opts) => { cwds.push(opts.cwd); return { code: 0, output: 'ok' }; }),
    );
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: path.join(root, '..cache'), readRoots: [root], writeRoots: [root] });
    expect(await tools.runText('run_command', { command: 'echo here' })).toContain('[exit 0]');
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: sibling, readRoots: [root], writeRoots: [root] });
    expect(await tools.runText('run_command', { command: 'echo here' })).toContain('[exit 0]');
    expect(cwds).toEqual([path.join(root, '..cache'), root]);
  });

  it('names a "..name" file and folder in a receipt relative to the working folder', async () => {
    const { root } = await dotFixture();
    const tools = read(root);
    expect(await tools.runText('read_file', { path: '..cache/x.json', line_numbers: true })).toContain('[read receipt R1: ..cache/x.json lines 1-1');
    expect(await tools.runText('search_files', { query: 'CACHE', path: '..cache' })).toContain('scope "..cache"');
  });

  it('reads a "..name" file from the shared integration view when the agent\'s own worktree has none', async () => {
    const { base, root } = await dotFixture();
    const shared = path.join(base, 'shared');
    await fs.mkdir(path.join(shared, '..cache'), { recursive: true });
    await fs.writeFile(path.join(shared, '..cache', 'merged.txt'), 'from integration\n', 'utf8');
    const tools = new WorkspaceTools(
      root, new Set(['read', 'write']), 'agent', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, shared,
    );
    const output = await tools.runText('read_file', { path: '..cache/merged.txt' });
    expect(output).toContain('from integration');
    expect(output).toContain('shared integration view');
  });
});
