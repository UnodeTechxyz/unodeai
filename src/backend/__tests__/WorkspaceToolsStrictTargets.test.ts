import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { exists, removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

/*
 * v0.9.97 S0, defect A1 in released v0.9.96: a write or delete whose path the tool could not place was redirected
 * to the longest trailing part of it that existed, so `delete_file('..cache/x.json')` deleted the root `x.json` and
 * reported "Deleted ..cache/x.json.". A tool now acts on the path it names or on none: a path under a foreign prefix
 * is refused by every file tool, reads included, with the workspace paths it could mean named. Where such a prefix
 * ends cannot be told, so even a reading that exists may not be the file meant (Codex's audit of 8c552a5, R5).
 */

afterEach(removeTemporaryFolders);

const FOREIGN = '/Users/dev/workspace-0073b507';

/** A root `x.json` and `sub/keep.txt`, and a `..cache` folder holding files of the same names. */
async function twinFixture(): Promise<string> {
  const root = await temporaryFolder('unode-a1-');
  await fs.mkdir(path.join(root, '..cache', 'sub'), { recursive: true });
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'x.json'), 'ROOT', 'utf8');
  await fs.writeFile(path.join(root, '..cache', 'x.json'), 'CACHE', 'utf8');
  await fs.writeFile(path.join(root, 'sub', 'keep.txt'), 'ROOT SUB', 'utf8');
  await fs.writeFile(path.join(root, '..cache', 'sub', 'keep.txt'), 'CACHE SUB', 'utf8');
  return root;
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

describe('A1: a change acts on the file it names, or on none', () => {
  it('delete_file of a path under a "..name" folder never deletes a same-named file elsewhere', async () => {
    const root = await twinFixture();
    const outcome = await new WorkspaceTools(root, new Set(['read', 'write'])).run('delete_file', { path: '..cache/x.json' });
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
    if (outcome.status === 'success') {
      expect(await exists(path.join(root, '..cache', 'x.json'))).toBe(false);
    }
  });

  it('delete_file of a missing file under a "..name" folder deletes nothing', async () => {
    const root = await twinFixture();
    await fs.rm(path.join(root, '..cache', 'x.json'));
    const outcome = await new WorkspaceTools(root, new Set(['read', 'write'])).run('delete_file', { path: '..cache/x.json' });
    expect(outcome.status).not.toBe('success');
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
  });

  it('delete_dir of a folder under a "..name" folder never deletes a same-named folder elsewhere', async () => {
    const root = await twinFixture();
    await fs.rm(path.join(root, '..cache', 'sub'), { recursive: true });
    const outcome = await new WorkspaceTools(root, new Set(['read', 'write'])).run('delete_dir', { path: '..cache/sub' });
    expect(outcome.status).not.toBe('success');
    expect(await fs.readFile(path.join(root, 'sub', 'keep.txt'), 'utf8')).toBe('ROOT SUB');
  });

  it('write_file to a new file under a "..name" folder never overwrites a same-named file the agent read', async () => {
    const root = await twinFixture();
    await fs.rm(path.join(root, '..cache', 'x.json'));
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(await tools.runText('read_file', { path: 'x.json' })).toContain('ROOT');
    const outcome = await tools.run('write_file', { path: '..cache/x.json', content: 'NEW' });
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
    if (outcome.status === 'success') {
      expect(await fs.readFile(path.join(root, '..cache', 'x.json'), 'utf8')).toBe('NEW');
    }
  });
});

describe('A1 contract: a change under a foreign prefix is refused, with the paths it could mean named', () => {
  it('write_file, apply_edit, apply_patch, delete_file and delete_dir change nothing, ask nothing and record nothing', async () => {
    const root = await twinFixture();
    const { tools, approvals, checkpoints, outside } = observedTools(root);
    expect(await tools.runText('read_file', { path: 'x.json' })).toContain('ROOT');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['write_file', { path: `${FOREIGN}/x.json`, content: 'NEW' }],
      ['apply_edit', { path: `${FOREIGN}/x.json`, old_string: 'ROOT', new_string: 'EDITED' }],
      ['delete_file', { path: `${FOREIGN}/x.json` }],
      ['delete_dir', { path: `${FOREIGN}/sub` }],
    ];
    for (const [name, args] of calls) {
      const outcome = await tools.run(name, args);
      expect(outcome.status, name).toBe('failed');
      expect(outcome.output, name).toMatch(/is outside the workspace.*workspace-relative path/s);
    }
    tools.setEditToolDialect('apply-patch');
    const patched = await tools.run('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${FOREIGN}/x.json\n@@\n-ROOT\n+PATCHED\n*** End Patch` });
    expect(patched.status).toBe('failed');
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
    expect(await fs.readFile(path.join(root, 'sub', 'keep.txt'), 'utf8')).toBe('ROOT SUB');
    expect(approvals).toEqual([]);
    expect(checkpoints).toEqual([]);
    // A path that reads as a workspace path is no folder to offer the agent.
    expect(outside).toEqual([]);
  });

  it('names every workspace path the foreign path could mean, existing or not', async () => {
    const root = await twinFixture();
    const outcome = await new WorkspaceTools(root, new Set(['read', 'write'])).run('delete_file', { path: `${FOREIGN}/..cache/x.json` });
    expect(outcome.status).toBe('failed');
    expect(outcome.output).toContain('"..cache/x.json"');
    expect(outcome.output).toContain('"x.json"');
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
    expect(await fs.readFile(path.join(root, '..cache', 'x.json'), 'utf8')).toBe('CACHE');
  });

  it('identifies the change as the path it names', async () => {
    const root = await twinFixture();
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(tools.fileEffectTarget('write_file', { path: `${FOREIGN}/x.json` }))
      .not.toBe(tools.fileEffectTarget('write_file', { path: 'x.json' }));
  });

  it('an ordinary write asks, records and reports the one path it names', async () => {
    const root = await twinFixture();
    const { tools, approvals, checkpoints } = observedTools(root);
    expect(await tools.runText('read_file', { path: 'sub/keep.txt' })).toContain('ROOT SUB');
    expect(await tools.runText('write_file', { path: 'sub/keep.txt', content: 'NEW SUB' })).toMatch(/sub\/keep\.txt/);
    expect(approvals).toEqual(['sub/keep.txt']);
    expect(checkpoints).toEqual(['sub/keep.txt']);
    expect(await fs.readFile(path.join(root, 'sub', 'keep.txt'), 'utf8')).toBe('NEW SUB');
  });

  it('a real path outside the workspace is judged as one, never matched to a workspace twin', async () => {
    const root = await twinFixture();
    const elsewhere = await temporaryFolder('unode-a1-elsewhere-');
    const { tools, outside } = observedTools(root);
    const outcome = await tools.run('delete_file', { path: path.join(elsewhere, 'x.json') });
    expect(outcome).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(outside).toEqual([path.join(elsewhere, 'x.json')]);
    expect(await fs.readFile(path.join(root, 'x.json'), 'utf8')).toBe('ROOT');
  });
});

/** A read refused as a foreign-prefix path: nothing of any workspace file is returned, and no receipt is issued. */
async function refusedRead(tools: WorkspaceTools, target: string, args: Record<string, unknown> = {}) {
  const result = await tools.run('read_file', { path: target, ...args });
  expect(result.status, target).toBe('failed');
  expect(result.output, target).toMatch(/Nothing was read\. ".*" is outside the workspace\..*workspace-relative path/s);
  expect(result.output, target).not.toMatch(/ROOT|CACHE|hello|SRC|ONLY|APP/);
  expect(result.readReceipt, target).toBeUndefined();
  return result.output;
}

describe('A1 contract: a read under a foreign prefix is refused with the paths it could mean named', () => {
  it('reads nothing even when exactly one workspace file matches; the named path then reads', async () => {
    const root = await twinFixture();
    await fs.writeFile(path.join(root, 'README.md'), 'hello', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(await refusedRead(tools, `${FOREIGN}/README.md`)).toContain('could name the workspace path "README.md"');
    await refusedRead(tools, `${FOREIGN}/README.md`, { line_numbers: true });
    expect(await tools.runText('read_file', { path: 'README.md' })).toContain('hello');
  });

  it('keeps a "..name" folder the workspace does not have, and never falls back to a root file of the same name', async () => {
    const root = await twinFixture();
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    const missing = await refusedRead(tools, `/Users/nonexistent-prefix/project/..missing/x.json`);
    expect(missing).toContain('"..missing/x.json" (does not exist)');
    const nested = await refusedRead(tools, `${FOREIGN}/..a/..b/x.json`);
    expect(nested).toContain('"..a/..b/x.json" (does not exist)');
    expect(nested).toContain('"..b/x.json" (does not exist)');
  });

  it('reads nothing when a whole ordinary folder the path names is missing', async () => {
    const root = await twinFixture();
    await fs.writeFile(path.join(root, 'app.ts'), 'ROOT APP', 'utf8');
    const output = await refusedRead(new WorkspaceTools(root, new Set(['read', 'write'])), `${FOREIGN}/src/app.ts`);
    expect(output).toContain('"app.ts"');
  });

  it('reads nothing when the file is missing in an existing folder, or when two files match', async () => {
    const root = await twinFixture();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'app.ts'), 'ROOT APP', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(await refusedRead(tools, `${FOREIGN}/src/app.ts`)).toContain('"src/app.ts" (does not exist)');
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'SRC INDEX', 'utf8');
    await fs.writeFile(path.join(root, 'index.ts'), 'ROOT INDEX', 'utf8');
    expect(await refusedRead(tools, `${FOREIGN}/src/index.ts`)).toMatch(/"src\/index\.ts", "index\.ts"/);
  });

  it('names both a "..name" file and a same-named root file, and reads neither', async () => {
    const root = await twinFixture();
    const output = await refusedRead(new WorkspaceTools(root, new Set(['read', 'write'])), `${FOREIGN}/..cache/x.json`);
    expect(output).toMatch(/"\.\.cache\/x\.json", "x\.json"/);
  });

  it('judges a real outside path, a path climbing with "..", and a relative path as they are', async () => {
    const root = await twinFixture();
    const elsewhere = await temporaryFolder('unode-a1-elsewhere-');
    await fs.writeFile(path.join(elsewhere, 'x.json'), 'ELSEWHERE', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    expect(await tools.run('read_file', { path: path.join(elsewhere, 'x.json') })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    // A path that climbs is judged as the path it resolves to, and names no workspace reading.
    for (const climbingPath of [`${FOREIGN}/sub/../x.json`, `${FOREIGN}/nowhere/../x.json`]) {
      expect(await tools.run('read_file', { path: climbingPath }), climbingPath).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    }
    const relative = await tools.run('read_file', { path: 'nowhere/x.json' });
    expect(relative.status).toBe('failed');
    expect(relative.output).not.toContain('ROOT');
  });

  it('reads nothing outside the task scope either', async () => {
    const root = await twinFixture();
    const tools = new WorkspaceTools(root, new Set(['read', 'write']));
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: path.join(root, 'sub'), readRoots: [path.join(root, 'sub')], writeRoots: [path.join(root, 'sub')] });
    const result = await tools.run('read_file', { path: `${FOREIGN}/x.json` });
    expect(result.status).not.toBe('success');
    expect(result.output).not.toContain('ROOT');
  });

  it.runIf(process.platform === 'win32')('refuses a foreign path on this drive, whose folders do not exist here', async () => {
    const root = await twinFixture();
    await fs.writeFile(path.join(root, 'README.md'), 'hello', 'utf8');
    // The drive exists here; the folders under it do not. The drive itself names no workspace path.
    const foreign = `${root.slice(0, 2)}\\Users\\nobody-unode-s0\\workspace\\README.md`;
    const output = await refusedRead(new WorkspaceTools(root, new Set(['read', 'write'])), foreign);
    // The one reading is the workspace file; nothing above the workspace is offered as a reading.
    expect(output).toContain('could name the workspace path "README.md". ');
    expect(output).not.toContain('"..');
  });

  it('list_dir refuses a foreign-prefix path and names the readings', async () => {
    const root = await twinFixture();
    const result = await new WorkspaceTools(root, new Set(['read', 'write'])).run('list_dir', { path: `${FOREIGN}/sub` });
    expect(result.status).toBe('failed');
    expect(result.output).toContain('"sub"');
    expect(result.output).not.toContain('keep.txt');
  });
});

