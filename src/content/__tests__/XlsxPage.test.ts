import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import { typedXlsxFixture } from './xlsxFixtures';
import { parseXlsxSnapshot } from '../XlsxWorkbook';
import { readXlsxPage } from '../XlsxPage';
import { workbookOutputSize, type CellPosition, type PageBudget, type WorkbookRange } from '../WorkbookPage';
afterEach(removeTemporaryFolders);
async function prepare(input: Buffer) {
  const root = await temporaryFolder('unode-xlsx-page-'); const source = join(root, 'source');
  const directory = join(root, 'parsed'); await fs.mkdir(directory); await fs.writeFile(source, input);
  return { source, directory, manifest: await parseXlsxSnapshot(source, directory, () => {}) };
}
it('pages saved typed values and explicit visibility exclusions without changing source bytes', async () => {
  const input = await typedXlsxFixture(); const { source, directory, manifest } = await prepare(input);
  const range = { firstRow: 1, lastRow: 3, firstColumn: 1, lastColumn: 16 };
  const budget: PageBudget = { unit: 'bytes', carrier: 'mcp', limit: 2400, reserved: 100 };
  function collect(visibility: 'all' | 'visible-only') {
    let position: CellPosition | null = { row: 1, column: 1, byte: 0 }; const fragments: any[] = [];
    for (let count = 0; position; count++) {
      expect(count).toBeLessThan(100);
      const page = readXlsxPage(directory, manifest, manifest.sheets[0], range, position, 'snapshot', 'cursor', visibility, budget, () => {});
      expect(workbookOutputSize(JSON.stringify(page), budget) + budget.reserved).toBeLessThanOrEqual(budget.limit);
      expect(page.remaining).not.toEqual(position); fragments.push(...page.prepared_fragments); position = page.remaining;
    }
    const records = new Map<string, string>();
    for (const item of fragments) if (item.kind === 'cell-fragment') records.set(item.id, (records.get(item.id) ?? '') + item.text);
    return [...fragments.filter(item => item.kind !== 'cell-fragment'), ...[...records].map(([id, text]) => ({ kind: 'cell', id, record: JSON.parse(text) }))];
  }
  const all = collect('all'); expect(all.find(item => item.id === 'E1')?.record.value).toMatchObject({ kind: 'number', raw: '0' });
  expect(all.find(item => item.id === 'K1')?.record.value).toMatchObject({ kind: 'unresolved', reason: 'formula-cache-missing' });
  expect(all.find(item => item.id === 'N2')?.record.coveredSourceValue).toMatchObject({ raw: '99' });
  const visible = collect('visible-only'); expect(visible.some(item => item.id === 'N2' || item.id === 'C1')).toBe(false);
  expect(visible).toContainEqual({ kind: 'excluded-range', range: 'A2:P2', reason: 'saved-hidden-row' });
  expect(visible).toContainEqual({ kind: 'excluded-range', range: 'C1:C1', reason: 'saved-hidden-column' });
  expect(await fs.readFile(source)).toEqual(input);
});
it.each(['mcp', 'codex'] as const)('reassembles oversized Unicode JSON records within the actual %s carrier bound', async carrier => {
  const zip = await JSZip.loadAsync(await typedXlsxFixture()); const text = '\"😀\\\n'.repeat(3000);
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  zip.file('custom/strings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${escaped}</t></si></sst>`);
  const { directory, manifest } = await prepare(await zip.generateAsync({ type: 'nodebuffer' }));
  const range = { firstRow: 1, lastRow: 1, firstColumn: 1, lastColumn: 1 };
  const budget: PageBudget = { unit: 'bytes', carrier, limit: 1700, reserved: 130 };
  let position: CellPosition | null = { row: 1, column: 1, byte: 0 }; let json = ''; let end = 0;
  for (let count = 0; position; count++) {
    expect(count).toBeLessThan(1000);
    const page = readXlsxPage(directory, manifest, manifest.sheets[0], range, position, 'snapshot', 'cursor', 'all', budget, () => {});
    expect(workbookOutputSize(JSON.stringify(page), budget) + budget.reserved).toBeLessThanOrEqual(budget.limit);
    for (const item of page.prepared_fragments as any[]) {
      expect(item).toMatchObject({ kind: 'cell-fragment', start_byte: end, whole_record: false });
      json += item.text; end = item.end_byte;
    }
    expect(page.remaining).not.toEqual(position); position = page.remaining;
  }
  expect(JSON.parse(json)).toMatchObject({ cell: 'A1', value: { kind: 'string', text } });
  expect(Buffer.byteLength(json)).toBe(end);
});
it('covers a full sparse Excel grid with rectangles instead of visiting every absent cell', async () => {
  const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('data/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1048576"><c r="XFD1048576"><v>7</v></c></row></sheetData></worksheet>');
  const { directory, manifest } = await prepare(await zip.generateAsync({ type: 'nodebuffer' }));
  const range: WorkbookRange = { firstRow: 1, lastRow: 1048576, firstColumn: 1, lastColumn: 16384 }; let visits = 0;
  const page = readXlsxPage(directory, manifest, manifest.sheets[0], range, { row: 1, column: 1, byte: 0 }, 'snapshot', 'cursor', 'all',
    { unit: 'bytes', carrier: 'text', limit: 6000, reserved: 0 }, () => { visits++; });
  expect(visits).toBe(3); expect(page.remaining).toBeNull();
  expect(page.prepared_fragments).toMatchObject([{ kind: 'absent-range', range: 'A1:XFD1048575' },
    { kind: 'absent-range', range: 'A1048576:XFC1048576' }, { kind: 'cell', id: 'XFD1048576', record: { value: { raw: '7' } } }]);
});
