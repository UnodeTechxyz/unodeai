/**
 * Formula text checks shared by workbook writing and recalculation admission. Text only: nothing is evaluated,
 * fetched or resolved. A finding describes what a spreadsheet application may do when it calculates the formula.
 */
export type XlsxFormulaEffect = 'network' | 'native-code' | 'external-workbook';
export const XLSX_FORMULA_MAX_LENGTH = 8192;

/** Double-quoted string literals are data; single-quoted sheet names stay because they can carry an external index. */
export function xlsxFormulaCode(text: string): string { return withoutStringLiterals(text); }
function withoutStringLiterals(text: string): string {
  let result = ''; let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '"') { if (text[index + 1] === '"') { index++; continue; } inString = false; result += '""'; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    result += char;
  }
  return inString ? result + '""' : result;
}

/** Undefined when the text can be stored as formula text; otherwise the reason, for the model's next attempt. */
export function xlsxFormulaIssue(text: string): string | undefined {
  if (!text.trim()) return 'is empty';
  if (text.length > XLSX_FORMULA_MAX_LENGTH) return `is longer than ${XLSX_FORMULA_MAX_LENGTH} characters`;
  // LF and TAB are kept by spreadsheet formula bars; every other C0 control (including CR) and noncharacter is refused.
  if (/[\u0000-\u0008\u000b-\u001f￾￿]/u.test(text)) return 'contains a control character';
  let depth = 0; let inString = false; let inSheet = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) { if (char === '"') { if (text[index + 1] === '"') index++; else inString = false; } continue; }
    if (inSheet) { if (char === "'") { if (text[index + 1] === "'") index++; else inSheet = false; } continue; }
    if (char === '"') inString = true;
    else if (char === "'") inSheet = true;
    else if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return 'has a closing parenthesis without an opening one';
  }
  if (inString) return 'has an unterminated string literal';
  if (inSheet) return 'has an unterminated quoted sheet name';
  if (depth) return 'has unbalanced parentheses';
  return undefined;
}

const NETWORK = /(?:^|[^A-Za-z0-9_.])(?:_xlfn\.)?(WEBSERVICE|IMAGE|STOCKHISTORY)\s*\(/i;
// RTD(ProgID, server, topic) starts the COM server registered under that ProgID: local code (Owner, 2026-11-22).
const NATIVE = /(?:^|[^A-Za-z0-9_.])(CALL|REGISTER\.ID|RTD)\s*\(/i;
// Dynamic data exchange: application|topic!item, possibly with a quoted topic.
const DDE = /(?:^|[^A-Za-z0-9_.'\]])[A-Za-z][A-Za-z0-9_.]*\|(?:'(?:[^']|'')*'|[A-Za-z0-9_.$\\/: -]+)!/;
// Stored external workbook index ([1]Sheet!A1 or '[1]Sheet name'!A1), never a structured table reference.
const EXTERNAL_INDEX = /(?:^|[^A-Za-z0-9_\].@#])'?\[\d+\]/;
const EXTERNAL_NAME = /\[[^[\]]+\.(?:xlsx|xlsm|xlsb|xls|xltx|xltm|csv)\]/i;
const EXTERNAL_PATH = /'(?:[A-Za-z]:[\\/]|\\\\|https?:\/\/)/i;

export function xlsxFormulaEffects(text: string): XlsxFormulaEffect[] {
  const code = withoutStringLiterals(text); const effects: XlsxFormulaEffect[] = [];
  if (NETWORK.test(code)) effects.push('network');
  if (NATIVE.test(code) || DDE.test(code)) effects.push('native-code');
  if (EXTERNAL_INDEX.test(code) || EXTERNAL_NAME.test(code) || EXTERNAL_PATH.test(code)) effects.push('external-workbook');
  return effects;
}

/** Statically visible http(s) hosts in network function string arguments; a computed address yields none. */
export function xlsxFormulaNetworkHosts(text: string): { hosts: string[]; dynamic: boolean } {
  const hosts = new Set<string>(); let dynamic = false; const pattern = /(?:^|[^A-Za-z0-9_.])(?:_xlfn\.)?(WEBSERVICE|IMAGE|STOCKHISTORY)\s*\(\s*/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const rest = text.slice(match.index + match[0].length);
    const literal = /^"((?:[^"]|"")*)"\s*[,)]/.exec(rest);
    if (match[1].toUpperCase() === 'STOCKHISTORY') { dynamic = true; continue; }
    if (!literal) { dynamic = true; continue; }
    try {
      const url = new URL(literal[1].replaceAll('""', '"'));
      if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.hostname.toLowerCase()); else dynamic = true;
    } catch { dynamic = true; }
  }
  return { hosts: [...hosts].sort(), dynamic };
}
