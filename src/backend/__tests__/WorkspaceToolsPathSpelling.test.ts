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
