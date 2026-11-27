import { expect, it } from 'vitest';
import { WorkbookExactNumber } from '../WorkbookExactNumber';
import { validateWorkbookDataSelection, workbookExactText, workbookBoundCell, workbookSuppliedValueMatches } from '../WorkbookBinding';
it('preserves exact decimals, repeating fractions and integers outside IEEE754 precision for Office text', () => {
  for (const raw of ['-0.125', '0.00000000000000000001', '9007199254740993', '1e40', '-2.5e-7']) {
    const number = WorkbookExactNumber.parse(raw); expect(WorkbookExactNumber.parse(workbookExactText(number)).compare(number)).toBe(0);
  }
  expect(workbookExactText(new WorkbookExactNumber(1n, 3n))).toBe('1/3');
  const expected = workbookBoundCell({ kind: 'number', exact: { numerator: '3', denominator: '10' } });
  expect(workbookSuppliedValueMatches('0.30', expected)).toBe(true); expect(workbookSuppliedValueMatches(0.3, expected)).toBe(true);
  expect(workbookSuppliedValueMatches('0.30000000000000004', expected)).toBe(false);
  expect(workbookSuppliedValueMatches('9007199254740992', workbookBoundCell({ kind: 'number', exact: { numerator: '9007199254740993', denominator: '1' } }))).toBe(false);
});
it('keeps missing, structural, date-epoch and uncertainty facts distinct from numeric values', () => {
  expect(workbookBoundCell({ kind: 'missing', reason: 'formula-cache-missing' })).toMatchObject({ text: '[Missing: formula-cache-missing]', state: 'unresolved' });
  expect(workbookBoundCell({ kind: 'merged', from: 'A1', anchor: { kind: 'number', exact: { numerator: '9', denominator: '1' } } })).toMatchObject({ text: '[Merged: A1]', state: 'structural' });
  expect(workbookBoundCell({ kind: 'date-serial', raw: '60', epoch: '1900', excelLeapDay: true })).toMatchObject({ text: '1900-02-29', value: { raw: '60', epoch: '1900', excelLeapDay: true } });
  expect(workbookBoundCell({ kind: 'date-serial', raw: '0', epoch: '1904', excelLeapDay: false }).text).toBe('1904-01-01');
  expect(workbookBoundCell({ kind: 'missing', reason: 'blank-cell' })).toMatchObject({ text: '', state: 'unresolved', value: { reason: 'blank-cell' } });
  expect(workbookBoundCell({ kind: 'number', exact: { numerator: '5', denominator: '3' } })).toMatchObject({ text: '1.666666666667', display_precision: 12, value: { exact: { numerator: '5', denominator: '3' } } });
  expect(workbookBoundCell({ kind: 'string', text: 'kept', escapedCodeUnitsUnresolved: true }).state).toBe('unresolved');
  expect(workbookBoundCell({ kind: 'number', exact: { numerator: '9', denominator: '1' } }, 'filter-inclusion-unresolved').state).toBe('unresolved');
});
it('accepts only public selection coordinates, rejecting private paths and ambiguous selectors', () => {
  const selection = { transformation_ref: 'transformation-host-id', fields: ['total'], rows: { first: 2, last: 3 } };
  expect(validateWorkbookDataSelection(selection)).toEqual(selection);
  for (const input of [{ ...selection, directory: 'private' }, { ...selection, fields: ['total', 'total'] }, { ...selection, fields: [] },
    { ...selection, rows: { first: 3, last: 2 } }, { ...selection, rows: { first: 0, last: 1 } }, { ...selection, rows: { first: 1, last: 3, file: 'private' } }]) {
    expect(() => validateWorkbookDataSelection(input)).toThrow('invalid-data-selection');
  }
});
it('keeps known date serials known when their stored display is unavailable', () => {
  const value = { kind: 'date-serial' as const, raw: '-1', epoch: '1900' as const, excelLeapDay: false, display: { text: '', status: 'unavailable' as const } };
  expect(workbookBoundCell(value)).toMatchObject({ text: '-1 (Excel 1900 date serial)', state: 'known', value });
  expect(workbookBoundCell(value, 'filter-inclusion-unresolved').state).toBe('unresolved');
});
