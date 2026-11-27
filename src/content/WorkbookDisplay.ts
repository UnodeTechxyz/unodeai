import * as SSF from 'ssf';
import { WorkbookExactNumber, workbookArithmeticDigitAllowance } from './WorkbookExactNumber';
import type { XlsxNumberFormat } from './XlsxCell';

export interface WorkbookDisplay {
  text: string; status: 'formatted' | 'unavailable'; format_code?: string;
  precision?: number; rounding?: 'half-away-from-zero';
  fallback?: 'iso-date' | 'serial-and-epoch';
}
export const WORKBOOK_DISPLAY_PRECISION = 12;
const currencyFormats: Record<number, string> = { 5: '"$"#,##0;("$"#,##0)', 6: '"$"#,##0;[Red]("$"#,##0)',
  7: '"$"#,##0.00;("$"#,##0.00)', 8: '"$"#,##0.00;[Red]("$"#,##0.00)' };

/** Human display only. The exact rational remains in WorkbookDatum and source evidence. */
export function workbookRoundedText(value: WorkbookExactNumber, precision = WORKBOOK_DISPLAY_PRECISION, trim = true): string {
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > workbookArithmeticDigitAllowance()) throw Error('arithmetic-resource-budget');
  const negative = value.numerator < 0n; const top = (negative ? -value.numerator : value.numerator) * 10n ** BigInt(precision);
  let rounded = top / value.denominator; if ((top % value.denominator) * 2n >= value.denominator) rounded++;
  const digits = rounded.toString().padStart(precision + 1, '0');
  let fraction = precision ? digits.slice(-precision) : '';
  if (trim) fraction = fraction.replace(/0+$/, '');
  return (negative && rounded !== 0n ? '-' : '') + (precision ? digits.slice(0, -precision) : digits) + (fraction ? '.' + fraction : '');
}

/** Exact common fixed-point formats avoid converting large integers or money to an IEEE754 double. */
function fixedFormat(code: string, value: WorkbookExactNumber): string | undefined {
  if (/\[(?:[<>=])/.test(code)) return undefined;
  const sections = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const negative = value.numerator < 0n; const explicitNegative = negative && sections.length > 1;
  const section = value.numerator === 0n && sections.length > 2 ? sections[2] : sections[explicitNegative ? 1 : 0];
  if (section === '') return '';
  const tokens: Array<{ text: string; literal: boolean }> = [];
  for (let at = 0; at < section.length; at++) {
    const char = section[at];
    if (char === '"') {
      const end = section.indexOf('"', at + 1); if (end < 0) return undefined;
      tokens.push({ text: section.slice(at + 1, end), literal: true }); at = end;
    } else if (char === '\\' || char === '_') {
      if (++at >= section.length) return undefined;
      tokens.push({ text: char === '_' ? ' ' : section[at], literal: true });
    } else if (char === '*') { if (++at >= section.length) return undefined; }
    else if (char === '[') {
      const end = section.indexOf(']', at + 1); if (end < 0) return undefined;
      const body = section.slice(at + 1, end);
      if (body.startsWith('$')) tokens.push({ text: body.slice(1).split('-')[0], literal: true });
      else if (!/^(?:Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color\d+)$/i.test(body)) return undefined;
      at = end;
    } else tokens.push({ text: char, literal: false });
  }
  const first = tokens.findIndex(token => !token.literal && /[0#?]/.test(token.text));
  let last = tokens.length - 1; while (last >= 0 && (tokens[last].literal || !/[0#?,.]/.test(tokens[last].text))) last--;
  if (first < 0 || tokens.slice(first, last + 1).some(token => token.literal)) return undefined;
  let pattern = tokens.slice(first, last + 1).map(token => token.text).join('');
  if (pattern.includes('?')) return undefined;
  const scaleCommas = /,+$/.exec(pattern)?.[0].length ?? 0; pattern = pattern.replace(/,+$/, '');
  const match = /^([#0?,]+)(?:\.([#0?]+))?$/.exec(pattern); if (!match) return undefined;
  const outside = [...tokens.slice(0, first), ...tokens.slice(last + 1)];
  if (outside.some(token => !token.literal && /[A-Za-z/@]/.test(token.text))) return undefined;
  const percent = outside.filter(token => !token.literal && token.text === '%').length;
  if (percent * 2 + scaleCommas * 3 + (match[2]?.length ?? 0) > workbookArithmeticDigitAllowance()) throw Error('arithmetic-resource-budget');
  const scaled = new WorkbookExactNumber((negative ? -value.numerator : value.numerator) * 100n ** BigInt(percent), value.denominator * 1000n ** BigInt(scaleCommas));
  const precision = match[2]?.length ?? 0; const rounded = workbookRoundedText(scaled, precision, false).split('.');
  const integerPattern = match[1].replaceAll(',', '');
  let integer = rounded[0].padStart((integerPattern.match(/0/g) ?? []).length, '0');
  if (integer === '0' && !integerPattern.includes('0')) integer = '';
  if (match[1].includes(',')) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let fraction = rounded[1] ?? '';
  const minimum = (match[2] ?? '').lastIndexOf('0') + 1;
  while (fraction.length > minimum && fraction.endsWith('0') && match[2]![fraction.length - 1] === '#') fraction = fraction.slice(0, -1);
  const prefix = tokens.slice(0, first).map(token => token.text).join(''); const suffix = tokens.slice(last + 1).map(token => token.text).join('');
  return (negative && !explicitNegative ? '-' : '') + prefix + integer + (fraction ? '.' + fraction : '') + suffix;
}

export function workbookNumberDisplay(value: WorkbookExactNumber, format: XlsxNumberFormat | undefined, date1904 = false): WorkbookDisplay | undefined {
  const code = format?.code ?? (format ? SSF.get_table()[format.id] ?? currencyFormats[format.id] : undefined);
  if (!code || /^(?:General|@)$/i.test(code)) return undefined;
  try {
    const fixed = SSF.is_date(code) ? undefined : fixedFormat(code, value);
    if (fixed !== undefined) return { text: fixed, status: 'formatted', format_code: code };
    const binary = value.chartNumber();
    // Unsupported formats never silently round a large exact integer through Number.
    if (binary.value === null || !binary.exact && Math.abs(binary.value) > Number.MAX_SAFE_INTEGER) return { text: '', status: 'unavailable', format_code: code };
    const text = SSF.format(code, binary.value, { date1904 });
    return { text, status: text === '' && SSF.is_date(code) ? 'unavailable' : 'formatted', format_code: code };
  } catch (error) {
    if (error instanceof Error && error.message === 'arithmetic-resource-budget') throw error;
    return { text: '', status: 'unavailable', format_code: code };
  }
}
export function workbookDateDisplay(raw: string, epoch: '1900' | '1904', format?: XlsxNumberFormat): WorkbookDisplay {
  // Dates already have their exact source serial. Do not expand an arbitrary exponent just for display.
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial >= 0 && serial <= 2958465) {
    const code = format?.code ?? (format ? SSF.get_table()[format.id] : undefined);
    for (const candidate of [code, 'yyyy-mm-dd']) {
      if (!candidate) continue;
      try {
        const text = SSF.format(candidate, serial, { date1904: epoch === '1904' });
        if (text) return { text, status: 'formatted', format_code: candidate, ...(candidate === code ? {} : { fallback: 'iso-date' as const }) };
      } catch { /* Unsupported locale formats fall through to ISO, then source serial. */ }
    }
  }
  return { text: `${raw} (Excel ${epoch} date serial)`, status: 'formatted', fallback: 'serial-and-epoch' };
}
