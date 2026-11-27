import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkbookReader, type WorkbookReadArgs, type WorkbookSnapshotSource } from '../WorkbookReader';
import { readCsvPage, type WorkbookPage, type PageBudget } from '../WorkbookPage';
import * as fs from 'node:fs/promises';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import type { WorkbookTransformPage } from '../WorkbookTransformPage';
import { validateWorkbookTransformPlan } from '../WorkbookTransformPlan';

const readers: WorkbookReader[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map(reader => reader.dispose())); await removeTemporaryFolders(); });
const budget: PageBudget = { unit: 'bytes', limit: 2400, reserved: 100, carrier: 'mcp' };
async function reader() {
  const root = await temporaryFolder('unode-csv-worker-'); const worker = join(root, 'WorkbookWorker.cjs');
  await build({ entryPoints: ['src/content/WorkbookWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  const value = new WorkbookReader(worker); readers.push(value); return value;
}
const range = (cursor?: string): WorkbookReadArgs => ({ operation: 'range', ...(cursor ? { cursor } : {}) });
describe('disk-index CSV reader through its real isolated worker (tool routes separately)', () => {
  it('reclaims an unpublished real computation rejected by the reader post-work source lease', async () => {
    const host = await reader(); const holder = {}; let live = true; let ref = ''; let directory = '';
    const source = await host.read('source', Buffer.from('A,1'), range(), budget, undefined, () => true, holder) as WorkbookPage;
    const hooks = host as unknown as { transformationPage(...args: unknown[]): Promise<WorkbookTransformPage>; transformations: Map<string, { directory: string }> };
    const page = hooks.transformationPage.bind(host);
    vi.spyOn(hooks, 'transformationPage').mockImplementation(async (...args) => {
      const value = await page(...args); ref = value.data_ref; directory = hooks.transformations.get(ref)!.directory;
      live = false; return value;
    });
    const plan = validateWorkbookTransformPlan({ sources: [{ name: 'input', snapshot_ref: source.snapshot_ref }],
      steps: [{ id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A' }] }] });
    await expect(host.transform(plan, holder, async () => () => live, budget)).rejects.toThrow('cancelled');
    expect(directory).not.toBe(''); await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(host.readTransformation({ data_ref: ref }, async () => () => true, budget)).rejects.toThrow('invalid-cursor');
    // A failed unpublished result does not consume the caller's source holder.
    expect(await host.withSnapshot(source.snapshot_ref, holder, async () => () => true, async snapshot => snapshot.sourceSha256)).toBe(source.source_sha256);
  });
  it('retains an immutable old source for its host holder and requires a live authority lease on every use', async () => {
    const host = await reader(); const holder = {}; const input = Buffer.from('old,0');
    const first = await host.read('physical-source', input, range(), budget, undefined, () => true, holder) as WorkbookPage;
    await host.read('physical-source', Buffer.from('new,1'), range(), budget);
    let directory = ''; let live = true; let authorized = 0;
    const authorize = async (key: string) => { expect(key).toBe('physical-source'); authorized++; return () => live; };
    const read = async (source: WorkbookSnapshotSource) => {
      directory = source.directory; expect(source.sourceSha256).toBe(first.source_sha256);
      if (source.source.format !== 'csv') throw new Error('unexpected fixture format');
      return await readCsvPage(source.directory, source.source, { firstRow: 1, lastRow: 1, firstColumn: 1, lastColumn: 2 },
        { row: 1, column: 1, byte: 0 }, source.snapshotRef, 'cursor', budget, () => {});
    };
    const old = await host.withSnapshot(first.snapshot_ref, holder, authorize, read);
    expect(old.prepared_fragments.map(cell => cell.text)).toEqual(['old', '0']); expect(authorized).toBe(1);
    const resultHolder = {}; expect(host.retainSnapshot(first.snapshot_ref, resultHolder)).toBe(true);
    await expect(host.withSnapshot(first.snapshot_ref, {}, authorize, read)).rejects.toThrow('snapshot-unavailable'); expect(authorized).toBe(1);
    live = false; await expect(host.withSnapshot(first.snapshot_ref, holder, authorize, read)).rejects.toThrow('cancelled');
    live = true;
    await expect(host.withSnapshot(first.snapshot_ref, holder, authorize, async source => { const value = await read(source); live = false; return value; })).rejects.toThrow('cancelled');
    host.releaseSnapshots(holder);
    await expect(host.withSnapshot(first.snapshot_ref, holder, authorize, read)).rejects.toThrow('snapshot-unavailable');
    live = true; expect((await host.withSnapshot(first.snapshot_ref, resultHolder, authorize, read)).source_sha256).toBe(first.source_sha256);
    host.releaseSnapshots(resultHolder);
    await expect.poll(async () => { try { await fs.stat(directory); return true; } catch { return false; } }).toBe(false);
  });
  it('pins a late captured version before its read releases the active snapshot', async () => {
    const host = await reader(); const holder = {}; const original = Buffer.from('old' + 'x'.repeat(200000));
    const [old] = await Promise.all([host.read('source', original, range(), budget, undefined, () => true, holder), host.read('source', Buffer.from('new'), range(), budget)]) as WorkbookPage[];
    const result = await host.withSnapshot(old.snapshot_ref, holder, async () => () => true, async source => fs.readFile(join(source.directory, '..', 'source')));
    expect(result).toEqual(original); host.releaseSnapshots(holder);
  });
  it('finishes overlapping captured versions before reclaiming the superseded private snapshot', async () => {
    const host = await reader(); const oldBytes = Buffer.from('old' + 'x'.repeat(200000) + ',0'); const newBytes = Buffer.from('new,1');
    const [old, newer] = await Promise.all([host.read('same-source', oldBytes, range(), budget), host.read('same-source', newBytes, range(), budget)]) as WorkbookPage[];
    expect(old.prepared_fragments[0].text).toMatch(/^oldx/); expect(newer.prepared_fragments.map(cell => cell.text)).toEqual(['new', '1']);
    expect(old.source_sha256).toBe(createHash('sha256').update(oldBytes).digest('hex')); expect(newer.source_sha256).toBe(createHash('sha256').update(newBytes).digest('hex'));
    const reread = await host.read('same-source', newBytes, range(), budget) as WorkbookPage;
    expect(reread.snapshot_ref).toBe(newer.snapshot_ref);
  });
  it('retains duplicate headers, quoted CRLF, formulas as text, zero and empty fields without changing the input', async () => {
    const input = Buffer.from('\ufeffname,name,\r\n"a,b","x\r\ny",=1+1\r\n0,,\r\n'); const original = Buffer.from(input);
    const host = await reader(); const inspect = await host.read('source.csv', input, { operation: 'inspect' }, budget);
    expect(inspect).toMatchObject({ source_sha256: createHash('sha256').update(input).digest('hex'), source: { rows: 3, columns: 3, encoding: 'utf-8', delimiter: ',' } });
    const page = await host.read('source.csv', input, range(), { ...budget, limit: 16000 }) as WorkbookPage;
    expect(page.snapshot_ref).toBe(inspect.snapshot_ref); expect(page.next_cursor).toBeNull(); expect(page.delivery).toBe('prepared');
    expect(page.prepared_fragments.map(cell => cell.text)).toEqual(['name', 'name', '', 'a,b', 'x\r\ny', '=1+1', '0', '', '']);
    expect(page.prepared_fragments.every(cell => cell.whole_value)).toBe(true); expect(input).toEqual(original);
  });
  it('fits the fully escaped carrier and reconstructs a long Unicode cell from byte-exact fragments', async () => {
    const host = await reader(); const text = '😀\n"'.repeat(800); const input = Buffer.from('"' + text.replaceAll('"', '""') + '",0');
    const fragments: WorkbookPage['prepared_fragments'] = []; let cursor: string | undefined;
    do {
      const page = await host.read('large.csv', input, range(cursor), budget) as WorkbookPage;
      expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(page) }] }), 'utf8') + budget.reserved).toBeLessThanOrEqual(budget.limit);
      fragments.push(...page.prepared_fragments); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(fragments.filter(cell => cell.cell === 'A1').map(cell => cell.text).join('')).toBe(text);
    expect(fragments.filter(cell => cell.cell === 'A1').every(cell => !cell.whole_value)).toBe(true);
    expect(fragments.filter(cell => cell.cell === 'B1').map(cell => cell.text)).toEqual(['0']);
  });
  it('binds cursors to source bytes, reader authority, range and parse settings', async () => {
    const host = await reader(); const input = Buffer.from('x'.repeat(9000) + ',0'); const first = await host.read('table', input, range(), budget) as WorkbookPage;
    expect(first.next_cursor).toMatch(/^cursor-/); const args = range(first.next_cursor!);
    await expect(host.read('table', Buffer.from('changed'), args, budget)).rejects.toThrow('source-changed');
    await expect(host.read('different', input, args, budget)).rejects.toThrow('invalid-cursor');
    await expect(host.read('table', input, { ...args, delimiter: ';' }, budget)).rejects.toThrow('invalid-cursor');
    await expect(host.read('table', input, { ...args, range: 'B1' }, budget)).rejects.toThrow('invalid-cursor');
    const other = await reader(); await expect(other.read('table', input, args, budget)).rejects.toThrow('invalid-cursor');
  });
  it.each(['utf-16le', 'utf-16be', 'gb18030'] as const)('uses only the explicitly requested %s encoding', async encoding => {
    const host = await reader(); let input: Buffer;
    if (encoding === 'gb18030') input = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x30]);
    else { input = Buffer.from('\ufeff你好,0', 'utf16le'); if (encoding === 'utf-16be') input.swap16(); }
    await expect(host.read('encoded.csv', input, range(), budget)).rejects.toThrow('encoding');
    const page = await host.read('encoded.csv', input, { ...range(), encoding }, budget) as WorkbookPage;
    expect(page.prepared_fragments.map(cell => cell.text)).toEqual(['你好', '0']); expect(page.source.encoding).toBe(encoding);
  });
  it('rejects a malformed quoted input and keeps independently active reads running after one call stops', async () => {
    const host = await reader(); const input = Buffer.from('a,"unfinished');
    await expect(host.read('bad.csv', input, range(), budget)).rejects.toThrow('quotes'); expect(input.toString()).toBe('a,"unfinished');
    const stopped = new AbortController(); stopped.abort(); const valid = Buffer.from('a,b\n0,1');
    const results = await Promise.allSettled([host.read('same.csv', valid, range(), budget, stopped.signal), host.read('same.csv', valid, range(), budget)]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { message: 'cancelled' } }); expect(results[1].status).toBe('fulfilled');
  });
});
