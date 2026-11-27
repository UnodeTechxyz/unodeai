import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { resolveHostExecutable } from '../../security/HostExecutableResolver';

/**
 * Windows adapter: whether the user has turned off Word's "convert your PDF" notice (per-user Word setting
 * DisableConvertPdfWarning = 1). In a hidden private Word instance that notice blocks opening a PDF, and neither
 * DisplayAlerts nor ConfirmConversions suppresses it, so convert_pdf_to_docx runs only when the user turned it off.
 * UnodeAi never writes this setting: this is one fixed read-only `reg query`, without a shell and with a time limit,
 * read fresh for every conversion. Other platforms have no Word adapter (platform-unsupported).
 */
export const WORD_PDF_NOTICE_KEY = 'HKCU\\Software\\Microsoft\\Office\\16.0\\Word\\Options';
export const WORD_PDF_NOTICE_VALUE = 'DisableConvertPdfWarning';
export type WordPdfNoticeState = 'off' | 'on' | 'platform-unsupported';
/** The fixed read-only query; tests replace only this boundary. */
export type RegistryQuery = (executable: string, args: readonly string[]) => Promise<string | undefined>;

const defaultQuery: RegistryQuery = (executable, args) => new Promise(resolve => execFile(executable, [...args],
  { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout)));

/** `off` only for an exact REG_DWORD 1; a missing value, any other value or an unreadable key is `on`. */
export function wordPdfNoticeFromQuery(output: string | undefined): 'off' | 'on' {
  const match = output && /^\s*DisableConvertPdfWarning\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(output);
  return match && parseInt(match[1], 16) === 1 ? 'off' : 'on';
}

export async function readWordPdfNotice(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  query: RegistryQuery = defaultQuery, resolveExecutable: (command: string) => string = resolveHostExecutable): Promise<WordPdfNoticeState> {
  if (platform !== 'win32') return 'platform-unsupported';
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root)) return 'on';
  let executable: string;
  try { executable = resolveExecutable(path.win32.join(root, 'System32', 'reg.exe')); } catch { return 'on'; }
  try { return wordPdfNoticeFromQuery(await query(executable, ['query', WORD_PDF_NOTICE_KEY, '/v', WORD_PDF_NOTICE_VALUE])); } catch { return 'on'; }
}
