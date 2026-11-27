import { expect, it } from 'vitest';
import { WorkbookExactNumber } from '../WorkbookExactNumber';
import { workbookDateDisplay, workbookNumberDisplay, workbookRoundedText } from '../WorkbookDisplay';
const display = (raw: string, code: string) => workbookNumberDisplay(WorkbookExactNumber.parse(raw), { id: 164, code, interpretation: 'number' });
it('formats exact fixed-point percentages, currency, scale and negative sections without losing large integer digits', () => {
  expect(display('0.15', '0%')?.text).toBe('15%'); expect(display('1234.5', '"$"#,##0.00')?.text).toBe('$1,234.50');
  expect(display('9007199254740993', '"$"#,##0.00')?.text).toBe('$9,007,199,254,740,993.00');
  expect(display('-1234.5', '"$"#,##0.00;[Red]("$"#,##0.00)')?.text).toBe('($1,234.50)');
  expect(display('1234567', '#,##0,,')?.text).toBe('1');
  expect(display('1.005', '0.00')?.text).toBe('1.01'); expect(display('-1.005', '0.00')?.text).toBe('-1.01');
  expect(workbookRoundedText(new WorkbookExactNumber(5n, 3n))).toBe('1.666666666667');
  expect(workbookRoundedText(new WorkbookExactNumber(-1n, 3n))).toBe('-0.333333333333');
});
it('uses the declared date epoch, preserves Excel serial60 and formats source dates or ISO defaults', () => {
  expect(workbookDateDisplay('45231', '1900', { id: 164, code: 'yyyy-mm-dd', interpretation: 'date' }).text).toBe('2023-11-01');
  expect(workbookDateDisplay('60', '1900').text).toBe('1900-02-29'); expect(workbookDateDisplay('0', '1904').text).toBe('1904-01-01');
  expect(workbookDateDisplay('60', '1904').text).toBe('1904-03-01');
  expect(workbookDateDisplay('45231.5', '1900', { id: 164, code: 'yyyy-mm-dd hh:mm', interpretation: 'date' }).text).toBe('2023-11-01 12:00');
});
it('falls back from unsupported date formats to ISO or a readable source serial without expanding exponents', () => {
  expect(workbookDateDisplay('45231', '1900', { id: 31, interpretation: 'date' })).toMatchObject({ text: '2023-11-01', fallback: 'iso-date' });
  expect(workbookDateDisplay('45231', '1900', { id: 164, code: '[DBNum1]yyyy年m月d日', interpretation: 'date' }).text).toBe('2023-11-01');
  for (const raw of ['-1', '2958466', '1e10000000']) expect(workbookDateDisplay(raw, '1904')).toMatchObject({ text: `${raw} (Excel 1904 date serial)`, status: 'formatted', fallback: 'serial-and-epoch' });
});
