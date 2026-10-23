import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { WorkspaceTools } from '../WorkspaceTools';

/*
 * Release-stress finding S1: a workspace root that is not spelled physically — VS Code's lowercase drive letter,
 * a junction or symlink, an 8.3 short name — must behave exactly like its physical spelling. Reads are recorded
 * by the physical path, so every comparison against them has to be physical too.
 */

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('WorkspaceTools with a root that is not spelled physically (release-stress finding S1)', () => {
  let base: string;
  beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-spelling-')); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  async function workspace(): Promise<{ real: string; link: string }> {
    const real = path.join(base, 'real');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'shared.ts'), 'v1', 'utf8');
    const link = path.join(base, 'link');
    await fs.symlink(real, link, linkType);
    return { real, link };
  }

  async function readThenWrite(root: string): Promise<string> {
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'A', new OptimisticFileCoordinator());
    await tools.runText('read_file', { path: 'shared.ts' });
    return tools.runText('write_file', { path: 'shared.ts', content: 'changed' });
  }

  it('lets an agent overwrite a file it read when its root is a junction or symlink', async () => {
    const { link } = await workspace();
    expect(await readThenWrite(link)).toMatch(/^Wrote/);
  });

  it.runIf(process.platform === 'win32')('lets an agent overwrite a file it read when the drive letter is lowercase, as VS Code gives it', async () => {
    const { real } = await workspace();
    expect(await readThenWrite(real[0].toLowerCase() + real.slice(1))).toMatch(/^Wrote/);
  });

  it('warns a teammate on the physical root when an agent on a junction root changes a file it read', async () => {
    const { real, link } = await workspace();
    const coordinator = new OptimisticFileCoordinator();
    const writer = new WorkspaceTools(link, new Set(['read', 'write']), 'A', coordinator);
    const reader = new WorkspaceTools(real, new Set(['read', 'write']), 'B', coordinator);
    await reader.runText('read_file', { path: 'shared.ts' });
    await writer.runText('read_file', { path: 'shared.ts' });
    expect(await writer.runText('write_file', { path: 'shared.ts', content: 'A changed it' })).toMatch(/^Wrote/);
    expect(await reader.runText('list_dir', { path: '.' })).toMatch(/Dependency changed/);
  });

  it('refuses a link to a configured folder outside the task scope as a task-scope gap, not an escape, on a junction root', async () => {
    const real = path.join(base, 'real');
    const granted = path.join(real, 'granted');
    const configuredOnly = path.join(real, 'configured-only');
    await fs.mkdir(granted, { recursive: true });
    await fs.mkdir(configuredOnly);
    await fs.writeFile(path.join(configuredOnly, 'internal.md'), 'CONFIGURED ONLY', 'utf8');
    await fs.symlink(configuredOnly, path.join(granted, 'internal-link'), linkType);
    const link = path.join(base, 'link');
    await fs.symlink(real, link, linkType);

    const tools = new WorkspaceTools(link, new Set(['read']), 'A');
    tools.setTurnWorkspaceAccess({ pathBase: link, commandCwd: link, readRoots: [path.join(link, 'granted')], writeRoots: [] });
    // The target is inside the agent's configured workspace, so this is a recoverable gap in the task's scope;
    // the turn continues. An escape would end it.
    expect(await tools.run('read_file', { path: 'granted/internal-link/internal.md' }))
      .toMatchObject({ status: 'refused', reason: 'task-scope' });
  });
});

/*
 * A turn keeps which files it was refused a change to and which it changed. Both are kept by the file a call
 * addresses, not by the words of the call: the same file under another spelling is the same file.
 */
describe('WorkspaceTools.fileEffectTarget: one identity for the file a file-changing call addresses', () => {
  let base: string;
  let root: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-effect-target-'));
    root = path.join(base, 'ws');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
  });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  const patchFor = (file: string) => ['*** Begin Patch', `*** Update File: ${file}`, '@@', '-old', '+new', '*** End Patch'].join('\n');

  it('is the same for every spelling of one file and for every tool that names it', () => {
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    const target = tools.fileEffectTarget('write_file', { path: 'src/a.ts' });
    expect(target).toBeDefined();
    for (const spelled of ['./src/a.ts', 'src/./a.ts', 'src/x/../a.ts', path.join(root, 'src', 'a.ts')]) {
      expect(tools.fileEffectTarget('write_file', { path: spelled })).toBe(target);
    }
    if (process.platform === 'win32') {
      // Windows compares paths without regard to case or to the direction of a separator.
      expect(tools.fileEffectTarget('write_file', { path: 'SRC\\A.TS' })).toBe(target);
    } else {
      expect(tools.fileEffectTarget('write_file', { path: 'SRC/A.TS' })).not.toBe(target);
    }
    expect(tools.fileEffectTarget('delete_file', { path: './src/a.ts' })).toBe(target);
    expect(tools.fileEffectTarget('delete_dir', { path: './src/a.ts' })).toBe(target);
    // apply_edit reads `path`, or `file_path` when there is none, and trims it.
    expect(tools.fileEffectTarget('apply_edit', { path: '  src/a.ts ' })).toBe(target);
    expect(tools.fileEffectTarget('apply_edit', { file_path: './src/a.ts' })).toBe(target);
    expect(tools.fileEffectTarget('apply_edit', { path: 'src/a.ts', file_path: 'src/b.ts' })).toBe(target);
    // A patch names its file in its own text, whatever else the text holds.
    expect(tools.fileEffectTarget('apply_patch', { patch: patchFor('./src/a.ts') })).toBe(target);
    expect(tools.fileEffectTarget('apply_patch', { patch: patchFor('src/a.ts').replace('+new', '+something else') })).toBe(target);

    expect(tools.fileEffectTarget('write_file', { path: 'src/b.ts' })).not.toBe(target);
    expect(tools.fileEffectTarget('apply_patch', { patch: patchFor('src/b.ts') })).not.toBe(target);
  });

  it('has no target for a call that names no file, and none for a tool that changes no file', () => {
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(tools.fileEffectTarget('write_file', {})).toBeUndefined();
    expect(tools.fileEffectTarget('write_file', { path: '   ' })).toBeUndefined();
    expect(tools.fileEffectTarget('delete_file', { path: '' })).toBeUndefined();
    expect(tools.fileEffectTarget('delete_dir', {})).toBeUndefined();
    expect(tools.fileEffectTarget('apply_edit', { old_string: 'x' })).toBeUndefined();
    expect(tools.fileEffectTarget('apply_patch', {})).toBeUndefined();
    expect(tools.fileEffectTarget('apply_patch', { patch: 'src/a.ts' })).toBeUndefined();
    // write_file does not read `file_path`; only apply_edit does.
    expect(tools.fileEffectTarget('write_file', { file_path: 'src/a.ts' })).toBeUndefined();
    expect(tools.fileEffectTarget('read_file', { path: 'src/a.ts' })).toBeUndefined();
    expect(tools.fileEffectTarget('run_command', { command: 'echo', path: 'src/a.ts' })).toBeUndefined();
  });

  it('is physical inside a writable root: a way in through a junction or symlink is the same file', async () => {
    await fs.symlink(path.join(root, 'src'), path.join(root, 'link'), linkType);
    await fs.writeFile(path.join(root, 'src', 'there.ts'), 'x', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    // A file that exists, and one that does not exist yet.
    expect(tools.fileEffectTarget('write_file', { path: 'link/there.ts' })).toBe(tools.fileEffectTarget('write_file', { path: 'src/there.ts' }));
    expect(tools.fileEffectTarget('write_file', { path: 'link/new/later.ts' })).toBe(tools.fileEffectTarget('write_file', { path: 'src/new/later.ts' }));
  });

  it('is lexical outside every writable root: the filesystem is not asked about a path the agent may not write', async () => {
    const outsideReal = path.join(base, 'outside-real');
    const outsideLink = path.join(base, 'outside-link');
    await fs.mkdir(outsideReal);
    await fs.symlink(outsideReal, outsideLink, linkType);
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    const viaLink = tools.fileEffectTarget('write_file', { path: path.join(outsideLink, 'x.txt') });
    const lexical = path.join(outsideLink, 'x.txt');
    // Had the link been followed, the identity would name `outside-real`.
    expect(viaLink).toBe(process.platform === 'win32' ? lexical.toLowerCase() : lexical);
    expect(viaLink).not.toBe(tools.fileEffectTarget('write_file', { path: path.join(outsideReal, 'x.txt') }));
    // The same outside file under two spellings is still one.
    expect(tools.fileEffectTarget('write_file', { path: path.join(outsideLink, '.', 'x.txt') })).toBe(viaLink);
  });

  it('follows the tool, which never redirects a change under a foreign prefix (v0.9.97)', async () => {
    await fs.writeFile(path.join(root, 'README.md'), 'hello', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    // write_file refuses the path as it stands, so that is the path the call addresses, with or without a
    // same-named file inside.
    expect(tools.fileEffectTarget('write_file', { path: '/Users/dev/workspace-0073b507/README.md' })).not.toBe(
      tools.fileEffectTarget('write_file', { path: 'README.md' }),
    );
    expect(tools.fileEffectTarget('write_file', { path: '/Users/dev/workspace-0073b507/absent.md' })).not.toBe(
      tools.fileEffectTarget('write_file', { path: 'absent.md' }),
    );
  });
});
