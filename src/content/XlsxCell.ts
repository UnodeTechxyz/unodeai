import { spreadsheetString } from './WorkbookXml';

export interface XlsxNumberFormat { id: number; code?: string; interpretation: 'date' | 'number' | 'text' | 'uninterpreted' }
export interface XlsxRichString { text: string; runs?: Array<{ text: string }>; escapedCodeUnitsUnresolved?: boolean }
export type XlsxScalar = { kind: 'blank'; raw?: string }
  | { kind: 'merged'; from: string }
  | { kind: 'string' | 'rich-string'; text: string; runs?: Array<{ text: string }>; escapedCodeUnitsUnresolved?: boolean }
  | { kind: 'number'; raw: string; precision: 'source-literal'; finiteDouble: boolean }
  | { kind: 'date-serial'; raw: string; epoch: '1900' | '1904'; excelLeapDay: boolean }
  | { kind: 'iso-date'; raw: string }
  | { kind: 'boolean'; value: boolean; raw: string }
  | { kind: 'error'; code: string }
  | { kind: 'unresolved'; raw?: string; reason: string };
export interface XlsxFormula { storedText: string; mode: string; sharedIndex?: string; range?: string; sourceCell?: string;
  expanded: false; cachePresent: boolean; cachedResult?: XlsxScalar }
export interface XlsxCellRecord { cell: string; value: XlsxScalar; formula?: XlsxFormula; styleIndex?: number; numberFormat?: XlsxNumberFormat;
  mergedFrom?: string; coveredSourceValue?: XlsxScalar; arrayFormulaFrom?: string; sourceCellPresent?: boolean; hiddenRow?: boolean; hiddenColumn?: boolean;
  styleSource?: 'cell' | 'row' | 'column' | 'default' }

const dateIds = new Set([...Array.from({ length: 9 }, (_, index) => 14 + index), ...Array.from({ length: 10 }, (_, index) => 27 + index),
  45, 46, 47, ...Array.from({ length: 9 }, (_, index) => 50 + index)]);

/** Classify source format intent, not rendered text. Mixed/conditional custom sections remain explicit unknowns. */
export function xlsxNumberFormat(id: number, code?: string): XlsxNumberFormat {
  if (code === undefined) return { id, interpretation: dateIds.has(id) ? 'date' : id === 49 ? 'text' : id < 164 ? 'number' : 'uninterpreted' };
  const basic = code.replace(/"(?:[^"]|"")*"|\\.|_.|\*./g, '');
  if (/\[(?:[<>]=?|=)/.test(basic)) return { id, code, interpretation: 'uninterpreted' };
  const nonempty = basic.replace(/\[([^\]]*)\]/g, (_, body: string) => /^[hms]+$/i.test(body) ? body : '').split(';').slice(0, 3).filter(Boolean);
  if (nonempty.length && nonempty.every(section => section.trim() === '@')) return { id, code, interpretation: 'text' };
  const sections = nonempty.filter(section => section.trim() !== '@');
  const kinds = sections.map(section => {
    const tokens = section.replace(/[sS]{1,2}\.[0#?]+/g, 's').replace(/[eE][+-][0#?]+/g, '');
    const date = /[ymdhs]/i.test(tokens);
    return date ? /[0#?]/.test(tokens) ? 'uninterpreted' : 'date' : 'number';
  });
  return { id, code, interpretation: kinds.length && kinds.every(kind => kind === kinds[0]) ? kinds[0] as XlsxNumberFormat['interpretation'] : 'uninterpreted' };
}

/** Cached data only. No expression evaluation, locale coercion, recalculation or invented timezone. */
export function xlsxScalar(type: string | undefined, raw: string | undefined, inline: XlsxRichString | undefined,
  shared: (index: number) => XlsxRichString | undefined, format: XlsxNumberFormat | undefined, date1904: boolean): XlsxScalar {
  if (type === 'inlineStr') return inline ? { kind: inline.runs?.length ? 'rich-string' : 'string', ...inline }
    : { kind: 'unresolved', reason: 'missing-inline-string' };
  if (raw === undefined) return { kind: 'blank' };
  if (type === 's') {
    const index = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    const value = Number.isSafeInteger(index) ? shared(index) : undefined;
    return value ? { kind: value.runs?.length ? 'rich-string' : 'string', ...value } : { kind: 'unresolved', raw, reason: 'missing-shared-string' };
  }
  if (type === 'str') return { kind: 'string', ...spreadsheetString(raw) };
  if (type === 'e') return { kind: 'error', code: raw };
  if (type === 'd') return { kind: 'iso-date', raw };
  if (raw.trim() === '') return { kind: 'blank', raw };
  if (type === 'b') return raw.trim() === '0' || raw.trim() === '1' ? { kind: 'boolean', value: raw.trim() === '1', raw }
    : { kind: 'unresolved', raw, reason: 'invalid-boolean' };
  if (type !== undefined && type !== 'n') return { kind: 'unresolved', raw, reason: 'unsupported-cell-type' };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) return { kind: 'unresolved', raw, reason: 'invalid-number-literal' };
  const number = Number(raw.trim());
  if (format?.interpretation === 'date') return { kind: 'date-serial', raw, epoch: date1904 ? '1904' : '1900', excelLeapDay: !date1904 && Math.floor(number) === 60 };
  return { kind: 'number', raw, precision: 'source-literal', finiteDouble: Number.isFinite(number) };
}
