import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots } from '../folderAccess';
import { searchDigestOf } from '../ReviewEvidence';
import { WorkspaceTools } from '../WorkspaceTools';
import type { FolderGrant } from '../../types';

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
    try {
      // Exercise the production algorithm at a smaller limit. Creating 8,100 real files made this unit test
      // a slow filesystem stress test and obscured diagnostics from the separate PDF-worker crash.
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(root, `f${i}.txt`), 'nothing here\n', 'utf8');
      }
      const tools = new WorkspaceTools(root, new Set(['read']));
      (tools as any).fileScanBudget = 8;

      const out = await tools.runText('search_files', { query: 'needle' });

      expect(out).toMatch(/SCAN INCOMPLETE/);
      expect(out).toMatch(/stopped after 8 files/);
      expect(out).toMatch(/does not cover the whole scope/);
      // The bare sentence is what a reader treats as proof of absence; it must not appear alone.
      expect(out).not.toBe('No matches for /needle/.');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

/**
 * v0.9.94: a search has four ways to stop before it has seen everything: its caller cancels it, its time runs
 * out, it reaches the file budget, or it reaches the result cap. Each one is a typed stop reason with partial
 * coverage, and each one says so in the words of its result. Only a scan that ran out of files is complete.
 */
describe('WorkspaceTools.search_files bounds and receipts', () => {
  async function withFiles(count: number, run: (tools: WorkspaceTools, root: string) => Promise<void>, line = 'nothing here\n'): Promise<void> {
    const root = await tmp('unode-search-bounds-');
    for (let i = 0; i < count; i++) {
      await fs.writeFile(path.join(root, `f${String(i).padStart(2, '0')}.txt`), line, 'utf8');
    }
    try {
      await run(new WorkspaceTools(root, new Set(['read'])), root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('gives a completed scan a receipt with complete coverage and the exact file count', async () => {
    await withFiles(3, async (tools) => {
      const result = await tools.run('search_files', { query: 'needle' });

      expect(result.status).toBe('success');
      expect(result.searchScan).toEqual({ filesScanned: 3, resultCap: 100, stopReason: 'completed', coverage: 'complete' });
      expect(result.searchReceipt).toEqual({
        id: 'S1', filesScanned: 3, resultCap: 100, stopReason: 'completed', coverage: 'complete',
        scope: ['.'], searchDigest: searchDigestOf({ scope: ['.'], query: 'needle' }, 100),
      });
      expect(result.output).toBe(
        '[search receipt S1: complete coverage of scope ".", the whole scope was scanned; 3 files scanned; result cap 100. '
        + 'To cite this search, use searchReceiptId "S1" with coverage "complete".]\n'
        + 'No matches for /needle/. The whole scope was scanned (3 files).'
      );
    });
  });

  it('binds each receipt to the folder the search ran over and to a digest of that folder, the query and the cap', async () => {
    await withFiles(2, async (tools, root) => {
      await fs.mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
      await fs.writeFile(path.join(root, 'sub', 'deep', 'z.txt'), 'needle\nneedle\n', 'utf8');
      const receiptOf = async (args: Record<string, unknown>) => (await tools.run('search_files', args)).searchReceipt!;

      // A capped search is never reused, so asking again really scans again: another receipt for the same question.
      const first = await receiptOf({ query: 'needle', path: 'sub', max_results: 1 });
      const again = await receiptOf({ query: 'needle', path: 'sub', max_results: 1 });
      const spelled = await receiptOf({ query: 'needle', path: './sub/deep/../', max_results: 1 });
      const absolute = await receiptOf({ query: 'needle', path: path.join(root, 'sub'), max_results: 1 });
      const deeper = await receiptOf({ query: 'needle', path: 'sub/deep', max_results: 1 });
      const everywhere = await receiptOf({ query: 'needle', max_results: 1 });
      const otherQuery = await receiptOf({ query: 'needl', path: 'sub', max_results: 1 });
      const otherCap = await receiptOf({ query: 'needle', path: 'sub', max_results: 2 });

      expect([first.id, again.id, spelled.id, absolute.id]).toEqual(['S1', 'S2', 'S3', 'S4']);
      expect(first).toMatchObject({ scope: ['sub'], coverage: 'partial' });
      expect(first.searchDigest).toMatch(/^[a-f0-9]{64}$/);
      // The same query over the same folder is the same digest, however the folder was spelled.
      for (const same of [again, spelled, absolute]) {
        expect(same).toMatchObject({ scope: ['sub'], searchDigest: first.searchDigest });
      }
      // Mutation: a digest that ignores the scope gives the narrower and the wider search the digest of the first.
      expect(deeper).toMatchObject({ scope: ['sub/deep'] });
      expect(everywhere).toMatchObject({ scope: ['.'] });
      expect(deeper.searchDigest).not.toBe(first.searchDigest);
      expect(everywhere.searchDigest).not.toBe(first.searchDigest);
      expect(otherQuery.searchDigest).not.toBe(first.searchDigest);
      expect(otherCap.searchDigest).not.toBe(first.searchDigest);
      // The receipt holds the digest in place of the query, and the line the model reads names the scope.
      expect(JSON.stringify([first, deeper, everywhere])).not.toContain('needle');
      const narrow = await tools.run('search_files', { query: 'needle', path: 'sub/deep' });
      expect(narrow.output).toMatch(/^\[search receipt S9: complete coverage of scope "sub\/deep", the whole scope was scanned; 1 files scanned; result cap 100\./);
    }, 'needle\n');
  });

  it('names every read root a search without a path ran over, and an outside root by its full path', async () => {
    const extra = await tmp('unode-search-extra-root-');
    try {
      await withFiles(1, async (tools, root) => {
        await fs.writeFile(path.join(extra, 'lib.txt'), 'needle\n', 'utf8');
        tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: root, readRoots: [extra], writeRoots: [root] });

        const everywhere = await tools.run('search_files', { query: 'needle' });
        const workingFolder = await tools.run('search_files', { query: 'needle', path: '.' });

        const scope = ['.', extra.replace(/\\/g, '/')].sort();
        expect(everywhere.searchReceipt).toMatchObject({ scope, filesScanned: 2, coverage: 'complete' });
        expect(everywhere.output).toContain(`complete coverage of scope ${scope.map((folder) => `"${folder}"`).join(', ')},`);
        // The working folder alone is a narrower scope than every read root, so it is another search.
        expect(workingFolder.searchReceipt).toMatchObject({ scope: ['.'], filesScanned: 1 });
        expect(workingFolder.searchReceipt!.searchDigest).not.toBe(everywhere.searchReceipt!.searchDigest);
      }, 'needle\n');
    } finally {
      await fs.rm(extra, { recursive: true, force: true });
    }
  });

  it('stops at the file budget with partial coverage, having scanned exactly the budget', async () => {
    await withFiles(10, async (tools) => {
      (tools as any).fileScanBudget = 8;

      const result = await tools.run('search_files', { query: 'needle' });

      expect(result.status).toBe('success');
      expect(result.searchScan).toEqual({ filesScanned: 8, resultCap: 100, stopReason: 'file-cap', coverage: 'partial' });
      expect(result.output).toMatch(/^\[search receipt S1: PARTIAL coverage of scope "\.", the search reached its file limit; 8 files scanned; result cap 100\./);
      expect(result.output).toContain('No matches for /needle/ in the 8 files scanned — SCAN INCOMPLETE: stopped after 8 files');
    });
  });

  it('calls a scope that exactly fits the file budget complete, because nothing was left unscanned', async () => {
    await withFiles(8, async (tools) => {
      (tools as any).fileScanBudget = 8;

      const result = await tools.run('search_files', { query: 'needle' });

      expect(result.searchScan).toEqual({ filesScanned: 8, resultCap: 100, stopReason: 'completed', coverage: 'complete' });
      expect(result.output).not.toMatch(/SCAN INCOMPLETE|PARTIAL/);
    });
  });

  it('stops at the result cap with partial coverage and says more matches may exist', async () => {
    await withFiles(4, async (tools) => {
      const result = await tools.run('search_files', { query: 'needle', max_results: 2 });

      expect(result.status).toBe('success');
      expect(result.searchScan).toMatchObject({ resultCap: 2, stopReason: 'result-cap', coverage: 'partial' });
      expect(result.searchScan!.filesScanned).toBeLessThan(4);
      expect(result.output).toMatch(/^\[search receipt S1: PARTIAL coverage of scope "\.", the search reached its result limit; \d files scanned; result cap 2\./);
      expect(result.output).toMatch(/2 matches for \/needle\/ \(capped at 2; more matches may exist/);
      expect(result.output).not.toMatch(/ — complete:/);
    }, 'needle\n');
  });

  it('stops at its time budget with partial coverage and says how far it got', async () => {
    await withFiles(6, async (tools) => {
      // A host clock that moves one second each time the walk asks: the 3.5-second budget ends partway through the files.
      let now = 0;
      (tools as any).searchClock = () => (now += 1_000);
      (tools as any).searchWallTimeMs = 3_500;

      const result = await tools.run('search_files', { query: 'needle' });

      expect(result.status).toBe('success');
      expect(result.searchScan).toMatchObject({ stopReason: 'timed-out', coverage: 'partial' });
      expect(result.searchScan!.filesScanned).toBeGreaterThan(0);
      expect(result.searchScan!.filesScanned).toBeLessThan(6);
      const scanned = result.searchScan!.filesScanned;
      expect(result.output).toMatch(/^\[search receipt S1: PARTIAL coverage of scope "\.", the search reached its time budget; /);
      expect(result.output).toContain(`No matches for /needle/ in the ${scanned} files scanned — SCAN INCOMPLETE: stopped at the 3.5-second time budget after ${scanned} files`);
      expect(result.output).toContain('do not read this as a complete answer');
    });
  });

  it('scans nothing once its caller has already cancelled, and reports the call as cancelled', async () => {
    await withFiles(5, async (tools) => {
      const controller = new AbortController();
      controller.abort();

      const result = await tools.run('search_files', { query: 'needle' }, { signal: controller.signal });

      expect(result).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
      expect(result.searchScan).toEqual({ filesScanned: 0, resultCap: 100, stopReason: 'cancelled', coverage: 'partial' });
      expect(result.output).toMatch(/^\[search receipt S1: PARTIAL coverage of scope "\.", the search was cancelled; 0 files scanned; result cap 100\./);
      expect(result.output).toContain('SCAN INCOMPLETE: cancelled after 0 files');
    }, 'needle\n');
  });

  it('stops walking when its caller cancels partway and keeps the matches it had found', async () => {
    await withFiles(6, async (tools) => {
      const controller = new AbortController();
      // The walk asks the clock before each entry. Cancelling on the fourth ask stops it between two files.
      let asks = 0;
      (tools as any).searchClock = () => { if (++asks === 4) controller.abort(); return 0; };

      const result = await tools.run('search_files', { query: 'needle' }, { signal: controller.signal });

      expect(result).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
      expect(result.searchScan).toMatchObject({ stopReason: 'cancelled', coverage: 'partial' });
      const scanned = result.searchScan!.filesScanned;
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThan(6);
      expect(result.output).toContain(`${scanned} matches for /needle/ — SCAN INCOMPLETE: cancelled after ${scanned} files`);
      // It found matches, but a call that did not succeed records no read provenance.
      expect(result.historicalRead).toBeUndefined();
      // A cancelled, partial result is never kept for reuse: the same query scans again.
      const again = await tools.run('search_files', { query: 'needle' });
      expect(again.output).not.toMatch(/Exact repeat/);
      expect(again.searchReceipt?.id).toBe('S2');
    }, 'needle\n');
  });

  it('reports the first bound it reached and lets no later one replace it', async () => {
    await withFiles(1, async (tools, root) => {
      // Three nested folders, each with a file after the folder, so the walk asks again at every level on its way out.
      await fs.mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true });
      for (const folder of ['a', path.join('a', 'b'), path.join('a', 'b', 'c')]) {
        await fs.writeFile(path.join(root, folder, 'z.txt'), 'needle\n', 'utf8');
      }
      const controller = new AbortController();
      // The time budget runs out on the fifth ask, and the caller cancels in that same instant. Time was first.
      let asks = 0;
      (tools as any).searchWallTimeMs = 100;
      (tools as any).searchClock = () => {
        if (++asks < 6) return 0;
        controller.abort();
        return 1_000;
      };

      const result = await tools.run('search_files', { query: 'needle' }, { signal: controller.signal });

      expect(controller.signal.aborted).toBe(true);
      expect(result.searchScan).toMatchObject({ stopReason: 'timed-out', coverage: 'partial' });
      expect(result.status).toBe('success');
    }, 'needle\n');
  });

  it('returns a repeated complete search with its first receipt and issues no second one', async () => {
    await withFiles(2, async (tools) => {
      const first = await tools.run('search_files', { query: 'needle' });
      const repeat = await tools.run('search_files', { query: 'needle' });
      const other = await tools.run('search_files', { query: 'haystack' });

      expect(repeat.output).toMatch(/Exact repeat within this delegation/);
      expect(repeat.searchReceipt).toEqual(first.searchReceipt);
      expect(repeat.searchScan).toEqual(first.searchScan);
      // The repeat took no id: the next search that really ran is the second receipt.
      expect(other.searchReceipt?.id).toBe('S2');
    });
  });

  it('issues no receipt for a search that never ran, and starts numbering again on a new turn', async () => {
    await withFiles(1, async (tools) => {
      const missing = await tools.run('search_files', { query: 'needle', path: 'no-such-folder' });
      expect(missing.status).toBe('failed');
      expect(missing.searchReceipt).toBeUndefined();
      expect(missing.searchScan).toBeUndefined();

      expect((await tools.run('search_files', { query: 'needle' })).searchReceipt?.id).toBe('S1');
      tools.beginTurn();
      expect((await tools.run('search_files', { query: 'needle' })).searchReceipt?.id).toBe('S1');
    });
  });

  it('names a match by the same line number a numbered read gives that line, in a CRLF file too', async () => {
    await withFiles(0, async (tools, root) => {
      await fs.writeFile(path.join(root, 'win.txt'), 'first\r\n\r\nthe needle is here\r\nlast\r\n', 'utf8');

      const found = await tools.run('search_files', { query: 'needle' });
      const read = await tools.run('read_file', { path: 'win.txt', line_numbers: true });

      expect(found.output).toContain('win.txt:3: the needle is here');
      expect(read.output).toContain('\n3\tthe needle is here\r');
      expect(read.readReceipt).toMatchObject({ startLine: 1, endLine: 4 });
    });
  });

  it('tells the model in the tool description that a bounded search is partial', () => {
    const tools = new WorkspaceTools(os.tmpdir(), new Set(['read']));
    const description = tools.specs().find((spec) => spec.function.name === 'search_files')!.function.description;

    expect(description).toMatch(/starts with a short host search receipt \(S1, S2, \.\.\.\) stating the scope searched,/);
    expect(description).toMatch(/whether coverage of that scope was complete or partial/);
    expect(description).toMatch(/a search that was cancelled, ran out of time, or hit a cap is partial/);
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

describe('delete, list and search under an exact-file grant', () => {
  const ROUTES = ['delegated', 'coordinator'] as const;

  async function files(): Promise<{ tools: WorkspaceTools; root: string }> {
    const root = await tmp('unode-file-grant-sd-');
    await fs.mkdir(path.join(root, 'folder'));
    await fs.writeFile(path.join(root, 'granted.txt'), 'the needle is here\n', 'utf8');
    await fs.writeFile(path.join(root, 'beside.txt'), 'another needle\n', 'utf8');
    await fs.writeFile(path.join(root, 'folder', 'inner.txt'), 'a third needle\n', 'utf8');
    return { tools: new WorkspaceTools(root, new Set(['read', 'write'])), root };
  }

  it.each(ROUTES)('deletes the granted file, and neither the file beside it nor any directory (%s route)', async (route) => {
    const { tools, root } = await files();
    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'granted.txt', permission: 'readwrite' }])).toBe(true);

      expect(await tools.run('delete_file', { path: 'beside.txt' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      expect(await tools.run('delete_file', { path: 'folder/inner.txt' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
      for (const directory of ['folder', 'granted.txt']) {
        expect(await tools.run('delete_dir', { path: directory }), directory).toMatchObject({ status: 'refused' });
      }
      expect((await fs.readdir(root)).sort()).toEqual(['beside.txt', 'folder', 'granted.txt']);
      expect(await fs.readdir(path.join(root, 'folder'))).toEqual(['inner.txt']);

      expect(await tools.runText('delete_file', { path: 'granted.txt' })).toBe('Deleted granted.txt.');
      expect((await fs.readdir(root)).sort()).toEqual(['beside.txt', 'folder']);
      expect(await tools.run('delete_file', { path: 'granted.txt' })).toMatchObject({ status: 'failed', failureKind: 'not_found' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('lists and searches no directory, and inspects no repository, on a file grant (%s route)', async (route) => {
    const { tools, root } = await files();
    try {
      expect(scopeOnRoute(route, tools, root, [{ path: 'granted.txt', permission: 'read' }])).toBe(true);

      expect(await tools.runText('read_file', { path: 'granted.txt' })).toContain('the needle is here');
      for (const [name, args] of [
        ['list_dir', { path: '.' }],
        ['list_dir', { path: 'folder' }],
        ['list_dir', { path: 'granted.txt' }],
        ['search_files', { query: 'needle', path: '.' }],
        ['search_files', { query: 'needle', path: 'folder' }],
        ['search_files', { query: 'needle', path: 'granted.txt' }],
        ['inspect_git_tag', { repository_path: root, tag: 'v1' }],
      ] as const) {
        expect(await tools.run(name, args), `${name} ${JSON.stringify(args)}`).toMatchObject({ status: 'refused', reason: 'task-scope' });
      }
      // With no folder named, a search walks none: it opens neither the granted file nor a file beside it.
      const search = await tools.run('search_files', { query: 'needle' });
      expect(search.searchScan).toMatchObject({ filesScanned: 0 });
      expect(search.output).toContain('(0 files)');
      expect(search.output).not.toContain('.txt');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ROUTES)('searches the directories of a scope and leaves an exact file beside them unsearched (%s route)', async (route) => {
    const { tools, root } = await files();
    try {
      expect(scopeOnRoute(route, tools, root, [
        { path: 'folder', permission: 'read' },
        { path: 'granted.txt', permission: 'read' },
      ])).toBe(true);

      const search = await tools.run('search_files', { query: 'needle' });
      expect(search.output).toContain('inner.txt:1: a third needle');
      expect(search.output).not.toContain('granted.txt');
      expect(search.output).not.toContain('beside.txt');
      // The receipt names what was walked, so the unsearched file is not counted as covered.
      expect(search.searchReceipt?.scope).toEqual(['folder']);
      expect(await tools.runText('read_file', { path: 'granted.txt' })).toContain('the needle is here');
      expect(await tools.run('read_file', { path: 'beside.txt' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
