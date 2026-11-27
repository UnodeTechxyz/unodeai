import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbookReader } from '../../content/WorkbookReader';
import { workbookOutputSize, type PageBudget, type WorkbookPage } from '../../content/WorkbookPage';
import { WorkspaceTools } from '../WorkspaceTools';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { typedXlsxFixture, forcedZip64, styleXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import JSZip from 'jszip';
const owned: Array<{ tools: WorkspaceTools; reader: WorkbookReader }> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
const budget: PageBudget = { unit: 'bytes', limit: 2200, reserved: 0, carrier: 'mcp' };
async function host(allowed = new Set(['read'])) {
  const root = await temporaryFolder('unode-workbook-tool-'); const reader = await workbookRouteReader(); const coordinator = new OptimisticFileCoordinator();
  const tools = new WorkspaceTools(root, allowed, 'agent', coordinator); tools.setWorkbookReader(reader); tools.beginTurn(); owned.push({ tools, reader });
  return { root, reader, tools, coordinator };
}
describe('registered read_workbook production entry', () => {
  it('names extra and invalid fields, rejects them without reading, then accepts the corrected request', async () => {
    const h = await host(); await fs.writeFile(join(h.root, 'sales.csv'), 'region,sales\nNorth,15\nSouth,20');
    const read = vi.spyOn(h.reader, 'read');
    const bad = await h.tools.run('read_workbook', { path: 'sales.csv', operation: 'inspect', sheet_id: 'csv:1', snapshot_ref: 'old', typo: true });
    expect(bad.status).toBe('failed'); expect(bad.output).toContain('"snapshot_ref", "typo"');
    expect(bad.output).toContain('Remove these fields'); expect(bad.output).toContain('transform_workbook sources[].snapshot_ref'); expect(read).not.toHaveBeenCalled();
    const invalid = await h.tools.run('read_workbook', { path: 'sales.csv', operation: 'fetch', sheet_id: 1, encoding: 'latin1' });
    expect(invalid.status).toBe('failed');
    for (const field of ['operation (inspect or range)', 'sheet_id (string from inspect)', 'encoding (utf-8']) expect(invalid.output).toContain(field);
    expect(read).not.toHaveBeenCalled();
    const fixed = await h.tools.run('read_workbook', { path: 'sales.csv', operation: 'range', sheet_id: 'csv:1' });
    expect(fixed.status, fixed.output).toBe('success'); expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixed.output).prepared_fragments.map((cell: any) => cell.text)).toEqual(['region', 'sales', 'North', '15', 'South', '20']);
  });
  it('shares the request holder across surfaces and releases superseded data when the owner starts a new request', async () => {
    const h = await host(); const borrower = new WorkspaceTools(h.root, new Set(['read']), 'agent'); borrower.shareWorkbookDataWith(h.tools); borrower.beginTurn();
    const target = join(h.root, 'context.csv'); await fs.writeFile(target, 'old,0');
    try {
      const first = await borrower.run('read_workbook', { path: 'context.csv', operation: 'range' }); expect(first.status).toBe('success');
      const roots = [...(h.reader as any).folders] as string[]; expect(roots).toHaveLength(1);
      await fs.writeFile(target, 'new,1'); expect((await h.tools.run('read_workbook', { path: 'context.csv' })).status).toBe('success');
      borrower.retire(); expect(await fs.readFile(join(roots[0], 'source'), 'utf8')).toBe('old,0');
      h.tools.beginTurn(); await vi.waitFor(async () => expect(fs.stat(roots[0])).rejects.toMatchObject({ code: 'ENOENT' }));
      expect(await fs.readFile(target, 'utf8')).toBe('new,1');
    } finally { borrower.retire(); }
  });
  it('returns no borrowed cells when the shared owner advances its request after preparation', async () => {
    const h = await host(); const borrower = new WorkspaceTools(h.root, new Set(['read']), 'agent'); borrower.shareWorkbookDataWith(h.tools); borrower.beginTurn();
    await fs.writeFile(join(h.root, 'context.csv'), 'PRIVATE CONTEXT CANARY,0'); const real = h.reader.read.bind(h.reader);
    const spy = vi.spyOn(h.reader, 'read').mockImplementation(async (...args) => { const value = await real(...args); h.tools.beginTurn(); return value; });
    try {
      const result = await borrower.run('read_workbook', { path: 'context.csv', operation: 'range' });
      expect(result.status).toBe('failed'); expect(result.output).not.toContain('PRIVATE CONTEXT CANARY');
      spy.mockRestore(); const retry = await borrower.run('read_workbook', { path: 'context.csv', operation: 'range' });
      expect(retry.status, retry.output).toBe('success');
    } finally { spy.mockRestore(); borrower.retire(); }
  });
  it('stops one borrowed read surface while another surface can still finish its own read', async () => {
    const h = await host(); const stopped = new WorkspaceTools(h.root, new Set(['read']), 'agent'); stopped.setWorkbookReader(h.reader); stopped.beginTurn();
    await fs.writeFile(join(h.root, 'stop.csv'), 'PRIVATE STOP CANARY,' + 'x'.repeat(200000)); await fs.writeFile(join(h.root, 'keep.csv'), 'keep,0');
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    const real = h.reader.read.bind(h.reader); vi.spyOn(h.reader, 'read').mockImplementation((...args) => { const pending = real(...args); if (args[0].endsWith('stop.csv')) entered(); return pending; });
    try {
      const pending = stopped.run('read_workbook', { path: 'stop.csv', operation: 'range' }); await waiting; stopped.retire();
      const [cancelled, live] = await Promise.all([pending, h.tools.run('read_workbook', { path: 'keep.csv', operation: 'range' })]);
      expect(cancelled.status).toBe('failed'); expect(cancelled.output).not.toContain('PRIVATE STOP CANARY');
      expect(live.status, live.output).toBe('success'); expect(JSON.parse(live.output).prepared_fragments.map((cell: any) => cell.text)).toEqual(['keep', '0']);
    } finally { stopped.retire(); }
  });
  it('keeps borrowed cache custody separate from read capability and owner retirement', async () => {
    const h = await host();
    const owner = new WorkspaceTools(h.root, new Set(['read']), 'agent'); owner.setWorkbookReader(h.reader, true); owner.beginTurn();
    const borrower = new WorkspaceTools(h.root, new Set(['read']), 'agent'); borrower.setWorkbookReader(owner.workbookReaderForHost()); borrower.beginTurn();
    const off = new WorkspaceTools(h.root, new Set(), 'agent'); off.setWorkbookReader(owner.workbookReaderForHost()); off.beginTurn();
    await fs.writeFile(join(h.root, 'shared.csv'), 'value,0');
    try {
      const first = await borrower.run('read_workbook', { path: 'shared.csv', operation: 'range' }); expect(first.status).toBe('success');
      const snapshot = JSON.parse(first.output).snapshot_ref; borrower.retire();
      expect((await off.run('read_workbook', { path: 'shared.csv' })).status).toBe('refused'); off.retire();
      const second = await owner.run('read_workbook', { path: 'shared.csv', operation: 'range' }); expect(second.status, second.output).toBe('success');
      expect(JSON.parse(second.output).snapshot_ref).toBe(snapshot);
      owner.retire(); await expect(h.reader.read('other', Buffer.from('a,b'), { operation: 'range' }, budget)).rejects.toThrow('cancelled');
    } finally { borrower.retire(); off.retire(); owner.retire(); }
  });
  it('pages detailed merge/column/hidden overrides from the real workbook without exposing private paths', async () => {
    const h = await host(); const zip = await JSZip.loadAsync(await typedXlsxFixture());
    zip.file('data/sheet2.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetFormatPr zeroHeight="1"/><sheetData><row r="3" hidden="0"/><row r="1048576" hidden="1"/></sheetData></worksheet>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const file = join(h.root, 'details.xlsx'); await fs.writeFile(file, bytes);
    const small: PageBudget = { ...budget, limit: 1450, reserved: 50 }; const whole: any[] = []; const splits = new Map<string, { kind: string; text: string }>();
    let cursor: string | undefined; let pages = 0;
    do {
      const result = await h.tools.run('read_workbook', { path: 'details.xlsx', operation: 'inspect', ...(cursor ? { cursor } : {}) }, { workbookBudget: small });
      expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, small) + small.reserved).toBeLessThanOrEqual(small.limit);
      const page = JSON.parse(result.output); expect(page.delivery).toBe('prepared');
      for (const item of page.prepared_fragments) {
        if (item.kind.endsWith('-fragment')) {
          const prior = splits.get(item.id) ?? { kind: item.kind.slice(0, -9), text: '' };
          expect(Buffer.byteLength(prior.text)).toBe(item.start_byte); prior.text += item.text; splits.set(item.id, prior);
        } else whole.push(item);
      }
      cursor = page.next_cursor ?? undefined; expect(++pages).toBeLessThan(50);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    const items = [...whole, ...[...splits].map(([id, value]) => ({ kind: value.kind, id, record: JSON.parse(value.text) }))];
    expect(items.find(item => item.kind === 'merge').record).toMatchObject({ sheet_id: 'sheet-1', value: { sourceCell: 'N1', range: { firstRow: 1, lastRow: 2, firstColumn: 14, lastColumn: 15 } } });
    expect(items.find(item => item.kind === 'saved-column-definition').record).toMatchObject({ value: { min: 3, max: 3, hidden: true } });
    const overrides = items.filter(item => item.kind === 'saved-row-hidden-override' && item.record.sheet_id === 'sheet-2').map(item => item.record.value);
    expect(overrides).toEqual([{ row: 3, hidden: false }, { row: 1048576, hidden: true }]);
    expect(items.find(item => item.id === 'sheet-2').record.metadata).toMatchObject({ defaultRowHidden: true, hiddenRowOverrides: 2 });
    expect(new Set(items.map(item => item.id)).size).toBe(items.length); expect(JSON.stringify(items)).not.toContain('directory');
    expect(await fs.readFile(file)).toEqual(bytes);
  });
  it('keeps General numbers inside date-styled rows and columns numeric through the actual worker', async () => {
    const h = await host(); const bytes = await styleXlsxFixture(); const target = join(h.root, 'styles.xlsx'); await fs.writeFile(target, bytes);
    const result = await h.tools.run('read_workbook', { path: 'styles.xlsx', operation: 'range', range: 'A1:C2' });
    expect(result.status, result.output).toBe('success'); const cells = JSON.parse(result.output).prepared_fragments.filter((item: any) => item.kind === 'cell');
    for (const id of ['B1', 'A2', 'B2']) expect(cells.find((item: any) => item.id === id).record).toMatchObject({ value: { kind: 'number' }, styleIndex: 0 });
    expect(cells.find((item: any) => item.id === 'C2').record.value.kind).toBe('date-serial');
    const date = await h.tools.run('read_workbook', { path: 'styles.xlsx', operation: 'range', range: 'A4:D4' });
    const dates = JSON.parse(date.output).prepared_fragments; expect(dates).toHaveLength(4);
    expect(dates.every((item: any) => item.record.value.kind === 'date-serial')).toBe(true);
    const textFormat = await h.tools.run('read_workbook', { path: 'styles.xlsx', operation: 'range', range: 'F4:G4' });
    const textCells = JSON.parse(textFormat.output).prepared_fragments; expect(textCells).toHaveLength(2);
    expect(textCells.every((item: any) => item.record.numberFormat.interpretation === 'text' && item.record.value.kind === 'number')).toBe(true);
    expect(await fs.readFile(target)).toEqual(bytes);
  });
  it('reads a real XLSX through the registered tool and isolated worker with paged inventory and saved visibility', async () => {
    const h = await host(); const input = forcedZip64(await typedXlsxFixture(true)); const file = join(h.root, 'named.csv'); await fs.writeFile(file, input);
    let cursor: string | undefined; const inventory: any[] = [];
    do {
      const result = await h.tools.run('read_workbook', { path: 'named.csv', operation: 'inspect', ...(cursor ? { cursor } : {}) }, { workbookBudget: budget });
      expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, budget)).toBeLessThanOrEqual(budget.limit);
      const page = JSON.parse(result.output); inventory.push(...page.prepared_fragments); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(inventory.find(item => item.kind === 'workbook')?.record).toMatchObject({ date1904: true, external_links_present: true, shared_strings: 2, visibility: 'saved-hidden-state-only' });
    expect(inventory.find(item => item.id === 'sheet-3')?.record).toMatchObject({ state: 'veryHidden' });
    expect(JSON.stringify(inventory)).not.toContain('directory');
    const result = await h.tools.run('read_workbook', { path: 'named.csv', operation: 'range', sheet_id: 'sheet-1', range: 'H1:K1' }, { workbookBudget: { ...budget, limit: 10000 } });
    expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output);
    expect(page.prepared_fragments[0].record.value).toEqual({ kind: 'date-serial', raw: '60', epoch: '1904', excelLeapDay: false });
    expect(page.prepared_fragments[3].record.value).toMatchObject({ kind: 'unresolved', reason: 'formula-cache-missing' });
    const visible = await h.tools.run('read_workbook', { path: 'named.csv', operation: 'range', range: 'N2', visibility: 'visible-only' });
    expect(JSON.parse(visible.output).prepared_fragments).toEqual([{ kind: 'excluded-range', range: 'N2:N2', reason: 'saved-hidden-row' }]);
    const absent = await h.tools.run('read_workbook', { path: 'named.csv', operation: 'range', sheet_id: 'sheet-2', range: 'A1:B2' });
    expect(JSON.parse(absent.output).prepared_fragments).toEqual([{ kind: 'absent-range', range: 'A1:B2' }]);
    const empty = await h.tools.run('read_workbook', { path: 'named.csv', operation: 'range', sheet_id: 'sheet-2' });
    expect(empty.status, empty.output).toBe('success'); expect(JSON.parse(empty.output)).toMatchObject({ prepared_fragments: [], remaining: null });
    expect(await fs.readFile(file)).toEqual(input); expect(await fs.readdir(h.root)).toEqual(['named.csv']);
  });
  it('binds real XLSX continuations to sheet, visibility, operation and current bytes', async () => {
    const h = await host(); const file = join(h.root, 'table.xlsx'); const input = await typedXlsxFixture(); await fs.writeFile(file, input);
    const first = await h.tools.run('read_workbook', { path: 'table.xlsx', operation: 'range' }, { workbookBudget: budget });
    expect(first.status, first.output).toBe('success'); const cursor = JSON.parse(first.output).next_cursor; expect(cursor).toBeTruthy();
    for (const change of [{ sheet_id: 'sheet-2' }, { visibility: 'visible-only' }, { operation: 'inspect' }]) {
      const result = await h.tools.run('read_workbook', { path: 'table.xlsx', operation: 'range', cursor, ...change }, { workbookBudget: budget });
      expect(result.status).toBe('failed'); expect(result.output).toContain('cursor');
    }
    const resumed = await h.tools.run('read_workbook', { path: 'table.xlsx', operation: 'range', cursor }, { workbookBudget: budget });
    expect(resumed.status, resumed.output).toBe('success');
    await fs.writeFile(file, await typedXlsxFixture(true));
    const changed = await h.tools.run('read_workbook', { path: 'table.xlsx', operation: 'range', cursor }, { workbookBudget: budget });
    expect(changed.status).toBe('failed'); expect(changed.output).toContain('Source bytes changed');
  });
  it('reports non-workbook ZIP and legacy/encrypted containers without treating bytes as CSV', async () => {
    const h = await host(); const zip = new JSZip(); zip.file('text.txt', 'PRIVATE CANARY');
    await fs.writeFile(join(h.root, 'archive.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await h.tools.run('read_workbook', { path: 'archive.xlsx' }); expect(result.status).toBe('failed'); expect(result.output).not.toContain('PRIVATE CANARY');
    await fs.writeFile(join(h.root, 'legacy.xls'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const legacy = await h.tools.run('read_workbook', { path: 'legacy.xls' }); expect(legacy.output).toContain('unencrypted XLSX or CSV copy');
    const empty = await new JSZip().generateAsync({ type: 'nodebuffer' });
    for (const bytes of [empty, Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), empty])]) {
      await fs.writeFile(join(h.root, 'empty.zip'), bytes); const result = await h.tools.run('read_workbook', { path: 'empty.zip' });
      expect(result.status).toBe('failed'); expect(result.output).toContain('XLSX package'); expect(result.output).not.toContain('selected encoding');
    }
  });
  it('detects the separator from a complete short header when the next quoted record spans chunks', async () => {
    const h = await host(); const value = 'q'.repeat(200000) + '😀'; const input = 'Title;Value\r\n"' + value + '";0\r\n';
    await fs.writeFile(join(h.root, 'header.csv'), input); const cells: WorkbookPage['prepared_fragments'] = []; let cursor: string | undefined;
    do {
      const result = await h.tools.run('read_workbook', { path: 'header.csv', operation: 'range', range: 'A2:B2', ...(cursor ? { cursor } : {}) });
      expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output) as WorkbookPage;
      expect(page.source).toMatchObject({ rows: 2, columns: 2, delimiter: ';', newline: 'CRLF' }); cells.push(...page.prepared_fragments); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(cells.filter(cell => cell.cell === 'A2').map(cell => cell.text).join('')).toBe(value); expect(cells.filter(cell => cell.cell === 'B2').map(cell => cell.text)).toEqual(['0']);
  });
  it('keeps the original bytes while accepting the documented nonstandard spaces after a closing quote', async () => {
    const h = await host(); const input = '"a"  ,b\n0,1'; await fs.writeFile(join(h.root, 'spacing.csv'), input);
    const result = await h.tools.run('read_workbook', { path: 'spacing.csv', operation: 'range' }); expect(result.status, result.output).toBe('success');
    expect((JSON.parse(result.output) as WorkbookPage).prepared_fragments.map(cell => cell.text)).toEqual(['a', 'b', '0', '1']);
    expect(await fs.readFile(join(h.root, 'spacing.csv'), 'utf8')).toBe(input);
    const literal = 'Notes with "quote,Value\r\nabc,0\r\n'; await fs.writeFile(join(h.root, 'spacing.csv'), literal);
    const read = await h.tools.run('read_workbook', { path: 'spacing.csv', operation: 'range' }); expect(read.status, read.output).toBe('success');
    expect((JSON.parse(read.output) as WorkbookPage).prepared_fragments.map(cell => cell.text)).toEqual(['Notes with "quote', 'Value', 'abc', '0']);
  });
  it('reads BMI/MZ text headers while retaining real BMP and DOS-header binary detection', async () => {
    const h = await host(); const target = join(h.root, 'table.csv');
    for (const title of ['BMI', 'MZ report']) {
      await fs.writeFile(target, `${title},Value\n23,0`); const result = await h.tools.run('read_workbook', { path: 'table.csv', operation: 'range' });
      expect(result.status, result.output).toBe('success'); expect((JSON.parse(result.output) as WorkbookPage).prepared_fragments[0].text).toBe(title);
    }
    const bmp = Buffer.alloc(58); bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    const mz = Buffer.alloc(512); mz.write('MZ'); mz.writeUInt16LE(1, 4); mz.writeUInt16LE(2, 8); mz.writeUInt16LE(28, 24);
    for (const bytes of [bmp, mz]) { await fs.writeFile(target, bytes); const result = await h.tools.run('read_workbook', { path: 'table.csv' });
      expect(result.status).toBe('failed'); expect(result.output).toContain('bytes'); expect(result.output).toContain('no cells returned'); }
  });
  it('reclaims superseded source/index copies after their request ends while retaining changed-source cursor diagnosis', async () => {
    const h = await host(); const target = join(h.root, 'changing.csv'); await fs.writeFile(target, 'x'.repeat(8000));
    const first = await h.tools.run('read_workbook', { path: 'changing.csv', operation: 'range' }, { workbookBudget: budget });
    const cursor = (JSON.parse(first.output) as WorkbookPage).next_cursor;
    const oldFolders = [...(h.reader as any).folders] as string[]; expect(oldFolders).toHaveLength(1);
    await fs.writeFile(target, 'y'.repeat(8000)); const newer = await h.tools.run('read_workbook', { path: 'changing.csv', operation: 'inspect' });
    expect(newer.status, newer.output).toBe('success');
    for (const folder of oldFolders) expect((await fs.stat(folder)).isDirectory()).toBe(true);
    h.tools.beginTurn();
    await vi.waitFor(async () => { for (const folder of oldFolders) await expect(fs.stat(folder)).rejects.toMatchObject({ code: 'ENOENT' }); });
    const old = await h.tools.run('read_workbook', { path: 'changing.csv', operation: 'range', cursor });
    expect(old.status).toBe('failed'); expect(old.output).toContain('Source bytes changed'); expect(await fs.readFile(target, 'utf8')).toBe('y'.repeat(8000));
  });
  it.each(['\r\n', '\r'])('preserves a >200 KB first quoted record with %j row endings and a split UTF-8 character', async newline => {
    const h = await host(); const first = 'a'.repeat(65534) + '😀' + 'b'.repeat(70000) + '\r\ninside quotes' + 'c'.repeat(70000);
    const input = '"' + first + '";0' + newline + 'last;1' + newline;
    expect(Buffer.byteLength(input, 'utf8')).toBeGreaterThan(200000); await fs.writeFile(join(h.root, 'long-record.csv'), input);
    const cells: WorkbookPage['prepared_fragments'] = []; let cursor: string | undefined; let pages = 0;
    do {
      const result = await h.tools.run('read_workbook', { path: 'long-record.csv', operation: 'range', range: 'A1:B2', ...(cursor ? { cursor } : {}) });
      expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output) as WorkbookPage;
      expect(page.source).toMatchObject({ rows: 2, columns: 2, delimiter: ';' }); cells.push(...page.prepared_fragments); cursor = page.next_cursor ?? undefined;
      if (++pages > 20) throw new Error('long CSV did not progress');
    } while (cursor);
    expect(cells.filter(cell => cell.cell === 'A1').map(cell => cell.text).join('')).toBe(first);
    expect(cells.filter(cell => cell.cell !== 'A1').map(cell => cell.text)).toEqual(['0', 'last', '1']);
    expect(await fs.readFile(join(h.root, 'long-record.csv'), 'utf8')).toBe(input);
  });
  it('reads exact CSV fields with Commands and file writes Off, keeps the source unchanged, and pages to the end', async () => {
    const h = await host(); const input = '\ufeffname,name,\r\n"a,b","x\r\ny",=1+1\r\n0,,\r\n'; await fs.writeFile(join(h.root, 'table.csv'), input);
    expect(h.tools.specs().find(spec => spec.function.name === 'read_workbook')?.returnsExternalContent).toBe(true);
    const all: WorkbookPage['prepared_fragments'] = []; let cursor: string | undefined;
    do {
      const result = await h.tools.run('read_workbook', { path: 'table.csv', operation: 'range', ...(cursor ? { cursor } : {}) }, { workbookBudget: budget });
      expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, budget)).toBeLessThanOrEqual(budget.limit);
      const page = JSON.parse(result.output) as WorkbookPage; all.push(...page.prepared_fragments); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(all.map(cell => cell.text)).toEqual(['name', 'name', '', 'a,b', 'x\r\ny', '=1+1', '0', '', '']);
    expect(await fs.readFile(join(h.root, 'table.csv'), 'utf8')).toBe(input); expect(await fs.readdir(h.root)).toEqual(['table.csv']);
    expect((await h.tools.run('run_command', { command: 'echo forbidden' })).status).toBe('refused');
  });
  it('counts actual escaped stale-source notices before preparing the page', async () => {
    const h = await host(); await fs.writeFile(join(h.root, 'long.csv'), 'x'.repeat(10000) + ',0');
    const args = { path: 'long.csv', operation: 'range' }; const plain = await h.tools.run('read_workbook', args, { workbookBudget: budget });
    const plainPage = JSON.parse(plain.output) as WorkbookPage; await fs.mkdir(join(h.root, 'deps'));
    for (let index = 0; index < 8; index++) {
      const file = join(h.root, 'deps', `source-${index}.txt`); await fs.writeFile(file, 'old'); h.coordinator.recordRead('agent', file, 'old');
      await fs.writeFile(file, 'new'); h.coordinator.recordWrite('teammate', file, 'new');
    }
    const result = await h.tools.run('read_workbook', args, { workbookBudget: budget }); expect(result.status, result.output).toBe('success');
    expect(result.output).toContain('Dependency changed'); expect(workbookOutputSize(result.output, budget)).toBeLessThanOrEqual(budget.limit);
    const page = JSON.parse(result.output.slice(result.output.indexOf('{"schema_version"'))) as WorkbookPage;
    expect(page.prepared_fragments[0].text!.length).toBeLessThan(plainPage.prepared_fragments[0].text!.length);
    expect(page.prepared_fragments[0].whole_value).toBe(false);
  });
  it('retains explicit read Off and refuses an ungranted outside source without sending it to the worker', async () => {
    const h = await host(new Set()); await fs.writeFile(join(h.root, 'table.csv'), 'private,0');
    expect((await h.tools.run('read_workbook', { path: 'table.csv' })).status).toBe('refused');
    const reading = await host(); const outside = await temporaryFolder('unode-workbook-outside-'); const target = join(outside, 'table.csv'); await fs.writeFile(target, 'PRIVATE CANARY,0');
    const parser = vi.spyOn(reading.reader, 'read'); const result = await reading.tools.run('read_workbook', { path: target, operation: 'range' });
    expect(result.status).toBe('refused'); expect(result.output).not.toContain('PRIVATE CANARY'); expect(parser).not.toHaveBeenCalled();
  });
  it('uses a real exact-file read grant and returns no source cells when that grant is revoked after worker completion', async () => {
    const h = await host(); const outside = await temporaryFolder('unode-workbook-granted-'); const file = join(outside, 'table.csv'); await fs.writeFile(file, 'PRIVATE CANARY,0');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const grant = await owner.requestPathAccess(file, { requestId: 'request-1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
    h.tools.setLivePathAccess(() => owner.pathAccessFor('request-1'));
    const args = { path: file, operation: 'range' }; expect((await h.tools.run('read_workbook', args)).output).toContain('PRIVATE CANARY');
    const realRead = h.reader.read.bind(h.reader); vi.spyOn(h.reader, 'read').mockImplementation(async (...args) => { const result = await realRead(...args); owner.revokePathAccess(grant!.id); return result; });
    const revoked = await h.tools.run('read_workbook', args); expect(revoked.status).not.toBe('success'); expect(revoked.output).not.toContain('PRIVATE CANARY');
  });
  it('invalidates a continuation after a real source edit and never emits binary bytes as CSV', async () => {
    const h = await host(); const target = join(h.root, 'table.csv'); await fs.writeFile(target, 'x'.repeat(8000));
    const first = await h.tools.run('read_workbook', { path: 'table.csv', operation: 'range' }, { workbookBudget: budget }); const page = JSON.parse(first.output) as WorkbookPage;
    await fs.writeFile(target, 'y'.repeat(8000)); const next = await h.tools.run('read_workbook', { path: 'table.csv', operation: 'range', cursor: page.next_cursor }, { workbookBudget: budget });
    expect(next.status).toBe('failed'); expect(next.output).toContain('Source bytes changed');
    await fs.writeFile(target, Buffer.from('%PDF-1.7\nPRIVATE-BINARY')); const binary = await h.tools.run('read_workbook', { path: 'table.csv' });
    expect(binary.status).toBe('failed'); expect(binary.output).toContain('PDF'); expect(binary.output).not.toContain('PRIVATE-BINARY');
  });
});
