import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { terminateChildProcessTree, treeSeenStopped, type ProcessTerminationOutcome } from '../../backend/processTree';

/**
 * Platform-neutral LibreOffice launcher for one recalculation copy. A fresh private profile always recalculates OOXML
 * on load, never updates links and keeps macros disabled; the user's own LibreOffice profile and documents are never
 * touched. The process starts without a shell. Stop or the time limit ends only this private-profile process tree.
 */
export const LIBREOFFICE_RECALC_TIMEOUT_MS = 300_000;
export const LIBREOFFICE_RECALC_PROFILE = '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
  + '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>'
  + '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>'
  + '<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop>'
  + '<prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>'
  + '<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>'
  + '</oor:items>';
export function libreOfficeRecalcArguments(profile: string, output: string, copy: string): string[] {
  return [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--invisible', '--nodefault', '--nologo', '--norestore', '--nofirststartwizard',
    '--convert-to', 'xlsx:Calc Office Open XML', '--outdir', output, copy];
}
/** The approval text shows the exact program and arguments, quoted for the platform's command line; nothing is parsed by a shell. */
export function libreOfficeRecalcCommandText(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return '& ' + [executable, ...args].map(item => `"${item.replace(/"/g, '""')}"`).join(' ');
  return [executable, ...args].map(item => `'${item.replace(/'/g, `'\\''`)}'`).join(' ');
}
export interface LibreOfficeRecalcPorts {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  terminate?: (proc: ChildProcess) => Promise<ProcessTerminationOutcome>;
  timeoutMs?: number;
}
export type LibreOfficeRecalcRun = { status: 'exited'; code: number | null; native_app: 'ended' }
  | { status: 'stopped' | 'timeout'; native_app: 'ended' | 'left-running' } | { status: 'spawn-failed'; native_app: 'not-started' };

export async function prepareLibreOfficeProfile(profile: string): Promise<void> {
  await mkdir(join(profile, 'user'), { recursive: true });
  await writeFile(join(profile, 'user', 'registrymodifications.xcu'), LIBREOFFICE_RECALC_PROFILE, { flag: 'wx', mode: 0o600 });
}

export function runLibreOfficeRecalc(options: { executable: string; args: readonly string[]; cwd: string; signal: AbortSignal }, ports: LibreOfficeRecalcPorts = {}): Promise<LibreOfficeRecalcRun> {
  return new Promise(resolve => {
    let proc: ChildProcess; let settled = false; const clock: { timer?: ReturnType<typeof setTimeout> } = {};
    try {
      proc = (ports.spawn ?? spawn)(options.executable, options.args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: 'ignore',
        // A separate process group lets a POSIX stop reach the soffice.bin child of the launcher script.
        detached: process.platform !== 'win32' });
    } catch { resolve({ status: 'spawn-failed', native_app: 'not-started' }); return; }
    const finish = (value: LibreOfficeRecalcRun) => { if (settled) return; settled = true; if (clock.timer) clearTimeout(clock.timer); options.signal.removeEventListener('abort', onAbort); resolve(value); };
    const end = (status: 'stopped' | 'timeout') => {
      if (settled) return;
      void (ports.terminate ?? terminateChildProcessTree)(proc).then(outcome => finish({ status, native_app: treeSeenStopped(outcome) ? 'ended' : 'left-running' }),
        () => finish({ status, native_app: 'left-running' }));
    };
    const onAbort = () => end('stopped');
    proc.once('error', () => finish({ status: 'spawn-failed', native_app: 'not-started' }));
    proc.once('exit', code => finish({ status: 'exited', code, native_app: 'ended' }));
    clock.timer = setTimeout(() => end('timeout'), ports.timeoutMs ?? LIBREOFFICE_RECALC_TIMEOUT_MS);
    if (options.signal.aborted) onAbort(); else options.signal.addEventListener('abort', onAbort, { once: true });
  });
}
