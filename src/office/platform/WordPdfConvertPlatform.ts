import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { commandShellIdentity, type CommandShellIdentity } from '../../backend/CommandShell';
import { encodePowerShellScript, WINDOWS_POWERSHELL_ARGS, windowsPowerShellPath } from '../../host/windowsPowerShell';
import { resolveHostExecutable } from '../../security/HostExecutableResolver';
import { WINDOWS_WORD_PDF_CONVERT_SCRIPT } from '../WindowsWordPdfScript';

/**
 * Windows adapter for convert_pdf_to_docx: the exact fixed command proposed as one ordinary command decision (Windows
 * PowerShell running the fixed Word helper). Other platforms have no Word adapter; callers report platform-unsupported.
 */
export interface WordPdfConvertProposal { command: string; shell: CommandShellIdentity; executable: string; scriptSha256: string }

export function wordPdfConvertProposal(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  resolveExecutable: (command: string) => string = resolveHostExecutable): WordPdfConvertProposal | { unavailable: 'powershell-unavailable' | 'platform-unsupported' } {
  if (platform !== 'win32') return { unavailable: 'platform-unsupported' };
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root)) return { unavailable: 'powershell-unavailable' };
  let executable: string;
  try { executable = resolveExecutable(windowsPowerShellPath(root)); } catch { return { unavailable: 'powershell-unavailable' }; }
  const shell = commandShellIdentity('windows-powershell', 'direct-fallback', { fingerprint: [executable] });
  const command = '& "' + executable.replace(/"/g, '""') + '" ' + WINDOWS_POWERSHELL_ARGS.join(' ') + ' ' + encodePowerShellScript(WINDOWS_WORD_PDF_CONVERT_SCRIPT);
  return { command, shell, executable, scriptSha256: createHash('sha256').update(WINDOWS_WORD_PDF_CONVERT_SCRIPT).digest('hex') };
}
