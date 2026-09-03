import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('WorkspaceTools.delete_file', () => {
  it('deletes a file and reports it (checkpointed)', async () => {
    const root = await tmp('roam-del-');
    await fs.writeFile(path.join(root, 'junk.js'), 'scratch', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['write']));

    const out = await tools.runText('delete_file', { path: 'junk.js' });
    expect(out).toBe('Deleted junk.js.');
    await expect(fs.stat(path.join(root, 'junk.js'))).rejects.toBeTruthy(); // gone
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a missing file and a directory with a clear message', async () => {
    const root = await tmp('roam-del2-');
    await fs.mkdir(path.join(root, 'adir'));
    const tools = new WorkspaceTools(root, new Set(['write']));

    expect(await tools.runText('delete_file', { path: 'nope.txt' })).toMatch(/does not exist/);
    expect(await tools.runText('delete_file', { path: 'adir' })).toMatch(/not a directory/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('requires write permission', async () => {
    const root = await tmp('roam-del3-');
    await fs.writeFile(path.join(root, 'x.txt'), 'y', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));
    await expect(tools.run('delete_file', { path: 'x.txt' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('WorkspaceTools.delete_dir', () => {
  it('deletes a nested directory through the sandboxed tool', async () => {
    const root = await tmp('roam-deldir-');
    await fs.mkdir(path.join(root, 'scratch', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'scratch', 'nested', 'junk.txt'), 'junk', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['write']));

    const out = await tools.runText('delete_dir', { path: 'scratch' });
    expect(out).toMatch(/Deleted directory scratch/);
    await expect(fs.stat(path.join(root, 'scratch'))).rejects.toBeTruthy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses protected workspace metadata directories', async () => {
    const root = await tmp('roam-deldir2-');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.mkdir(path.join(root, '.unode'), { recursive: true });
    const tools = new WorkspaceTools(root, new Set(['write']));

    expect(await tools.runText('delete_dir', { path: '.git' })).toMatch(/refuses to delete protected/);
    expect(await tools.runText('delete_dir', { path: '.unode' })).toMatch(/refuses to delete protected/);
    // Windows path-equivalence bypass (found in review): trailing dot/space resolve to .git/.unode at fs time.
    expect(await tools.runText('delete_dir', { path: '.git.' })).toMatch(/refuses to delete protected/);
    expect(await tools.runText('delete_dir', { path: '.git ' })).toMatch(/refuses to delete protected/);
    expect(await tools.runText('delete_dir', { path: '.unode.' })).toMatch(/refuses to delete protected/);
    expect(await fs.stat(path.join(root, '.git'))).toBeTruthy();
    expect(await fs.stat(path.join(root, '.unode'))).toBeTruthy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('requires write permission', async () => {
    const root = await tmp('roam-deldir3-');
    await fs.mkdir(path.join(root, 'scratch'));
    const tools = new WorkspaceTools(root, new Set(['read']));
    await expect(tools.run('delete_dir', { path: 'scratch' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * read_file is not a content extractor and must not pretend to be one.
 *
 * It called `toString('utf8')` on whatever the workspace held, so a PNG or a PDF reached an agent as a
 * screen of replacement characters — with nothing saying why, and nothing an agent could act on. The same
 * defect as the fetch boundary, one entrance over: the type was decided after the bytes were already text.
 */
describe('read_file refuses bytes that are not text', () => {
  it.each([
    ['a PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01], 'PNG image'],
    ['a PDF', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a], 'PDF'],
    ['a gzip', [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00], 'gzip archive'],
  ])('names what it found in %s rather than decoding it', async (_label, bytes, expected) => {
    const root = await tmp('roam-binary-');
    await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from(Uint8Array.from(bytes)));
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('read_file', { path: 'asset.bin' });
    expect(out).toContain(expected);
    expect(out).toContain('No bytes were added to context.');
    expect(out).not.toContain('\uFFFD');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses bytes that are merely invalid UTF-8, and still reads real text', async () => {
    const root = await tmp('roam-utf8-');
    await fs.writeFile(path.join(root, 'bad.txt'), Buffer.from(Uint8Array.from([0xc3, 0x28, 0xc3, 0x28])));
    await fs.writeFile(path.join(root, 'good.txt'), '研发团队 notes\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    expect(await tools.runText('read_file', { path: 'bad.txt' })).toContain('not valid UTF-8');
    expect(await tools.runText('read_file', { path: 'good.txt' })).toContain('研发团队 notes');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('WorkspaceTools not-found hints', () => {
  it('steers empty projects toward creating missing scaffold files', async () => {
    const root = await tmp('roam-empty-');
    await fs.mkdir(path.join(root, '.unode'));
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('read_file', { path: 'package.json' });
    expect(out).toMatch(/create it with write_file/);
    expect(out).not.toMatch(/Do NOT retry/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps typo recovery wording in populated projects', async () => {
    const root = await tmp('roam-populated-');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('read_file', { path: 'srcc/index.ts' });
    expect(out).toMatch(/Use list_dir\("\."\)/);
    expect(out).toMatch(/Do NOT retry/);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('WorkspaceTools.search_files', () => {
  it('finds a regex across files and returns relpath:line: text', async () => {
    const root = await tmp('roam-search-');
    await fs.writeFile(path.join(root, 'a.ts'), 'const worktreeCoordinator = make();\n// other\n', 'utf8');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'b.ts'), 'use worktreeCoordinator here\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('search_files', { query: 'worktreeCoordinator' });
    expect(out).toMatch(/a\.ts:1:/);
    expect(out).toMatch(/sub\/b\.ts:1:/);
    expect(out).toMatch(/2 matches/);
  });

  it('skips ignored dirs (node_modules) and reports no matches cleanly', async () => {
    const root = await tmp('roam-search2-');
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'needle', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    expect(await tools.runText('search_files', { query: 'needle' })).toMatch(/No matches/);
    await fs.rm(root, { recursive: true, force: true });
  });

  // A search has two limits and only one of them used to be disclosed. `max_results` said "(capped at N)";
  // the 8000-file scan budget said nothing, so a walk that quit early returned "No matches" — an assertion
  // of absence the scan never established. An agent given that answer stops looking, and is wrong.
  it('declares a scan cut short by the file budget instead of reporting a clean absence', async () => {
    const root = await tmp('roam-search-budget-');
    // 8001 files, none of them matching: the walk exhausts its budget before it runs out of files.
    for (let i = 0; i < 8100; i++) {
      await fs.writeFile(path.join(root, `f${i}.txt`), 'nothing here\n', 'utf8');
    }
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('search_files', { query: 'needle' });

    expect(out).toMatch(/SCAN INCOMPLETE/);
    expect(out).toMatch(/does not cover the whole scope/);
    // The bare sentence is what a reader treats as proof of absence; it must not appear alone.
    expect(out).not.toBe('No matches for /needle/.');
    await fs.rm(root, { recursive: true, force: true });
  // The fixture writes and scans more than 8,000 real files. Under the full parallel suite that can exceed
  // one minute without weakening the scan-budget assertion itself.
  }, 120000);

  it('states that a completed scan was complete, so absence means something', async () => {
    const root = await tmp('roam-search-complete-');
    await fs.writeFile(path.join(root, 'a.txt'), 'nothing here\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('search_files', { query: 'needle' });

    expect(out).toMatch(/The whole scope was scanned/);
    expect(out).not.toMatch(/SCAN INCOMPLETE/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns a prior complete exact query/path result without rescanning within one delegation turn', async () => {
    const root = await tmp('roam-search-repeat-');
    await fs.writeFile(path.join(root, 'a.txt'), 'nothing here\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));
    const scan = vi.spyOn(tools as any, 'searchFilesAcrossReadRoots');

    const first = await tools.runText('search_files', { query: 'needle', path: '.' });
    const second = await tools.runText('search_files', { query: 'needle', path: '.' });

    expect(first).toMatch(/The whole scope was scanned/);
    expect(second).toContain(first);
    expect(second).toMatch(/Exact repeat within this delegation.*without rescanning/i);
    expect(scan).toHaveBeenCalledTimes(1);
    // Mutation: caching an incomplete result or removing the lookup makes the second scan happen.
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not reuse capped search output and clears completed-search reuse at the next turn', async () => {
    const root = await tmp('roam-search-repeat-boundary-');
    await fs.writeFile(path.join(root, 'a.txt'), 'needle\nneedle\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));
    const scan = vi.spyOn(tools as any, 'searchFilesAcrossReadRoots');

    await tools.runText('search_files', { query: 'needle', max_results: 1 });
    await tools.runText('search_files', { query: 'needle', max_results: 1 });
    expect(scan).toHaveBeenCalledTimes(2); // capped output is not a complete result

    await tools.runText('search_files', { query: 'needle' });
    tools.beginTurn();
    await tools.runText('search_files', { query: 'needle' });
    expect(scan).toHaveBeenCalledTimes(4); // never reuse a previous delegation's result
    await fs.rm(root, { recursive: true, force: true });
  });

  it('says more matches may exist when max_results capped the result', async () => {
    const root = await tmp('roam-search-cap-');
    await fs.writeFile(path.join(root, 'many.txt'), 'needle\nneedle\nneedle\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));

    const out = await tools.runText('search_files', { query: 'needle', max_results: 2 });

    expect(out).toMatch(/capped at 2; more matches may exist/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('falls back to literal search on an invalid regex', async () => {
    const root = await tmp('roam-search3-');
    await fs.writeFile(path.join(root, 'c.txt'), 'a (b literal\n', 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));
    // "(b" is an invalid regex (unclosed group) → treated as a literal substring.
    expect(await tools.runText('search_files', { query: '(b' })).toMatch(/c\.txt:1:/);
    await fs.rm(root, { recursive: true, force: true });
  });
});
