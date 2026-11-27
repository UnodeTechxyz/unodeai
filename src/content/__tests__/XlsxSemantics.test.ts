import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadOnlyOpc } from '../OpcReadPackage';
import { inspectXlsxInventory } from '../XlsxInventory';
import { indexXlsxSharedStrings } from '../XlsxSharedStrings';
import { readXlsxStyles } from '../XlsxStyles';
import { WorkbookJsonIndex } from '../WorkbookJsonIndex';
import { indexXlsxSheet } from '../XlsxSheet';
import { XlsxPointReader } from '../XlsxPointReader';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import { typedXlsxFixture, styleXlsxFixture } from './xlsxFixtures';
import { parseXlsxSnapshot } from '../XlsxWorkbook';
afterEach(removeTemporaryFolders);
describe('real OPC/SAX worksheet semantics before the tool integration', () => {
  it('uses default style zero for allocated cells and saved row/column styles only for unallocated cells', async () => {
    const root = await temporaryFolder('unode-xlsx-styles-'); const directory = join(root, 'parsed'); await fs.mkdir(directory);
    const source = join(root, 'source'); await fs.writeFile(source, await styleXlsxFixture());
    const manifest = await parseXlsxSnapshot(source, directory, () => {}); const sheet = manifest.sheets[0];
    const reader = new XlsxPointReader(directory, join(directory, sheet.directory!), sheet.metadata!, manifest.date1904);
    try {
      for (const [row, column] of [[1, 2], [2, 1], [2, 2]]) expect(reader.cell(row, column)).toMatchObject({ value: { kind: 'number' }, styleIndex: 0, styleSource: column === 2 && row === 2 ? 'cell' : 'default' });
      expect(reader.cell(2, 3)).toMatchObject({ value: { kind: 'date-serial' }, styleIndex: 1, styleSource: 'cell' });
      expect(reader.cell(3, 2)).toMatchObject({ value: { kind: 'merged' }, styleIndex: 1, styleSource: 'column' });
      expect(reader.cell(2, 4)).toMatchObject({ value: { kind: 'merged' }, styleIndex: 1, styleSource: 'row' });
      for (let column = 1; column <= 4; column++) expect(reader.cell(4, column)).toMatchObject({ value: { kind: 'date-serial', raw: '60', excelLeapDay: true }, numberFormat: { interpretation: 'date' } });
      expect(reader.cell(4, 5)).toMatchObject({ value: { kind: 'number', raw: '60' }, numberFormat: { interpretation: 'uninterpreted' } });
    } finally { reader.close(); }
  });
  it.each([false, true])('keeps saved values/formulas distinct with date1904=%s and no source writes', async date1904 => {
    const root = await temporaryFolder('unode-xlsx-semantics-'); const input = await typedXlsxFixture(date1904); const source = join(root, 'source'); await fs.writeFile(source, input);
    const parsed = join(root, 'parsed'); const sheet = join(parsed, 'sheet-1'); await fs.mkdir(sheet, { recursive: true });
    const pkg = await ReadOnlyOpc.open(source, 200, 64 * 1024 * 1024, () => {});
    try {
      const inventory = await inspectXlsxInventory(pkg); expect(inventory.sheets.map(sheet => sheet.state)).toEqual(['visible', 'hidden', 'veryHidden']);
      expect(inventory).toMatchObject({ date1904, externalLinksPresent: true, cache: 'saved-results-not-recalculated', calculation: { calcMode: 'manual' } });
      expect(await indexXlsxSharedStrings(pkg, inventory.sharedStringsPart, parsed)).toBe(2);
      const formats = new WorkbookJsonIndex(parsed, 'number-formats', true); try { for (const format of await readXlsxStyles(pkg, inventory.stylesPart)) formats.append(format); } finally { formats.close(); }
      const metadata = await indexXlsxSheet(pkg, inventory.sheets[0].part!, sheet); expect(metadata).toMatchObject({ rows: 3, columns: 16, hiddenRowRecords: 1, autoFilter: { criteriaPresent: true } });
      const values = new XlsxPointReader(parsed, sheet, metadata, date1904);
      try {
        expect(values.cell(1, 1)?.value).toEqual({ kind: 'string', text: 'Shared 名称' });
        expect(values.cell(1, 2)?.value).toMatchObject({ kind: 'rich-string', text: 'Rich text' });
        expect(values.cell(1, 3)?.value).toMatchObject({ kind: 'string', text: '' }); expect(values.cell(1, 4)?.value).toEqual({ kind: 'blank' });
        expect(values.cell(1, 5)?.value).toMatchObject({ kind: 'number', raw: '0' }); expect(values.cell(1, 6)?.value).toEqual({ kind: 'boolean', raw: '0', value: false });
        expect(values.cell(1, 7)?.value).toEqual({ kind: 'error', code: '#DIV/0!' });
        expect(values.cell(1, 8)?.value).toEqual({ kind: 'date-serial', raw: '60', epoch: date1904 ? '1904' : '1900', excelLeapDay: !date1904 });
        expect(values.cell(1, 9)).toMatchObject({ value: { kind: 'number', raw: '0.15' }, numberFormat: { code: '0.00%' } });
        expect(values.cell(1, 10)?.formula).toMatchObject({ storedText: 'SUM(E1:E2)', cachePresent: true, cachedResult: { kind: 'number', raw: '5' }, expanded: false });
        expect(values.cell(1, 11)).toMatchObject({ value: { kind: 'unresolved', reason: 'formula-cache-missing' }, formula: { storedText: '1+1', cachePresent: false } });
        expect(values.cell(2, 12)?.formula).toMatchObject({ storedText: '', mode: 'shared', sourceCell: 'L1', cachePresent: true, cachedResult: { raw: '10' }, expanded: false });
        expect(values.cell(2, 13)).toMatchObject({ arrayFormulaFrom: 'M1', value: { kind: 'number', raw: '2' } });
        expect(values.cell(1, 15)).toMatchObject({ mergedFrom: 'N1', sourceCellPresent: false, value: { kind: 'merged', from: 'N1' } });
        expect(values.cell(2, 14)).toMatchObject({ mergedFrom: 'N1', coveredSourceValue: { raw: '99' }, value: { kind: 'merged', from: 'N1' } });
        expect(values.cell(2, 16)?.value).toMatchObject({ kind: 'string', text: 'line\r2' });
        expect(values.cell(3, 16)?.value).toEqual({ kind: 'iso-date', raw: '2026-11-19T09:00:00' });
        expect(values.cell(3, 2)).toBeUndefined(); expect(values.rowHidden(2)).toBe(true); expect(values.hiddenColumns[3]).toBe(1);
      } finally { values.close(); }
      expect(await fs.readFile(join(sheet, 'cells.json-data'), 'utf8')).not.toContain('Shared 名称'); expect(await fs.readFile(source)).toEqual(input);
    } finally { pkg.close(); }
  });
});
