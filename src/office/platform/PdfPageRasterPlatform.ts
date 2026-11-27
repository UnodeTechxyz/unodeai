import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { commandShellIdentity, type CommandShellIdentity } from '../../backend/CommandShell';
import { encodePowerShellScript, WINDOWS_POWERSHELL_ARGS, windowsPowerShellPath } from '../../host/windowsPowerShell';
import { resolveHostExecutable } from '../../security/HostExecutableResolver';
import { WindowsPdfRasterizer, type NativePdfRasterResult, type RasterPageFact } from '../WindowsPdfRasterizer';
import { WINDOWS_PDF_RASTER_SCRIPT } from '../WindowsPdfScript';

/**
 * Platform adapter for PDF page images (view_pdf_pages). Windows renders with Windows.Data.Pdf through the existing
 * fixed PowerShell script; other platforms have no adapter in this version and callers report platform-unsupported.
 */
export interface PdfPageRasterPlatform {
  readonly renderer: 'windows-pdf';
  /** The exact fixed command proposed as one ordinary command decision, or why it cannot be formed. */
  command(): { command: string; shell: CommandShellIdentity; executable: string; scriptSha256: string } | { unavailable: 'powershell-unavailable' };
  rasterize(source: Buffer, signal: AbortSignal, current: () => boolean, onPage: (page: RasterPageFact & { data: Buffer }) => void | Promise<void>,
    acceptPageCount: (total: number) => boolean): Promise<NativePdfRasterResult>;
}

export function pdfPageRasterPlatform(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  rasterizer: Pick<WindowsPdfRasterizer, 'rasterize'> = new WindowsPdfRasterizer(), resolveExecutable: (command: string) => string = resolveHostExecutable): PdfPageRasterPlatform | undefined {
  if (platform !== 'win32') return undefined;
  return {
    renderer: 'windows-pdf',
    command() {
      const root = env.SystemRoot ?? env.SYSTEMROOT;
      if (!root || !path.win32.isAbsolute(root)) return { unavailable: 'powershell-unavailable' };
      let executable: string;
      try { executable = resolveExecutable(windowsPowerShellPath(root)); } catch { return { unavailable: 'powershell-unavailable' }; }
      const shell = commandShellIdentity('windows-powershell', 'direct-fallback', { fingerprint: [executable] });
      const command = '& "' + executable.replace(/"/g, '""') + '" ' + WINDOWS_POWERSHELL_ARGS.join(' ') + ' ' + encodePowerShellScript(WINDOWS_PDF_RASTER_SCRIPT);
      return { command, shell, executable, scriptSha256: createHash('sha256').update(WINDOWS_PDF_RASTER_SCRIPT).digest('hex') };
    },
    rasterize: (source, signal, current, onPage, acceptPageCount) => rasterizer.rasterize(source, signal, current, onPage, acceptPageCount),
  };
}
