import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import PptxGenJS from 'pptxgenjs';
import { encodePowerShellScript, runDocumentWindowsPowerShell, windowsPowerShellPath } from '../../host/windowsPowerShell';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../WindowsOfficeScript';
import { WINDOWS_LIBREOFFICE_RENDER_SCRIPT } from '../WindowsLibreOfficeScript';

/*
 * The production helper scripts' own Stop/deadline decisions, executed for real on Windows. Nothing here supplies the
 * helper's closing facts: they come from the fixed script running against processes this file starts itself.
 * - LibreOffice: a compiled stand-in loader (started by the helper, as soffice would be) spawns one conversion child
 *   carrying the exact private-profile argument and one decoy whose argument only contains it; the test also starts an
 *   outsider with the exact argument that is not the loader's child. Only the exact child and the loader may end.
 * - PowerPoint: a private instance started by the helper itself; another COM client adds a presentation to that same
 *   hidden instance before Stop. The helper must close only its own copy and not Quit; the control (no other
 *   presentation) must Quit. Skipped when PowerPoint is absent or already running: a person's instance is never used.
 */
const windows = process.platform === 'win32';
const powershell = () => windowsPowerShellPath(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read().catch(() => undefined); if (value !== undefined) return value; if (Date.now() > end) throw Error('condition not reached'); await sleep(50); }
}
const roots: string[] = []; const started: number[] = [];
async function stage(): Promise<Record<string, string>> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'unode-native-render-'))); roots.push(root);
  for (const name of ['pages', 'tmp', 'native', 'helper-home']) await mkdir(path.join(root, name));
  return { root, output: path.join(root, 'pages'), tmp: path.join(root, 'tmp'), home: path.join(root, 'helper-home'), receipt: path.join(root, 'tmp', 'owner-receipt.json'),
    stop: path.join(root, 'native', 'stop'), phase: path.join(root, 'native', 'phase.txt'), pdf: path.join(root, 'native', 'internal.pdf') };
}
function helper(script: string, dirs: Record<string, string>, job: object) {
  return runDocumentWindowsPowerShell({ encodedCommand: encodePowerShellScript(script), inputVariable: 'UNODE_OFFICE_RENDER_JOB',
    input: Buffer.from(JSON.stringify({ operationId: 'office-render-' + randomUUID(), output: dirs.output, pdf: dirs.pdf, phase: dirs.phase, stop: dirs.stop,
      receipt: dirs.receipt, hostPid: process.pid, ...job })).toString('base64'),
    maxInputChars: 65536, maxStdoutBytes: 16384, cwd: dirs.home, tmp: dirs.tmp, signal: new AbortController().signal, helperClosesApplication: true });
}
const answer = (run: Awaited<ReturnType<typeof runDocumentWindowsPowerShell>>) => { expect(run.status).toBe('exited'); return JSON.parse((run as { stdout: string }).stdout); };
const receiptOf = async (dirs: Record<string, string>) => JSON.parse(await readFile(dirs.receipt, 'utf8'));
afterAll(async () => {
  for (const pid of started) if (alive(pid)) try { process.kill(pid); } catch { /* already ended */ }
  await sleep(300);
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const LOADER = `using System; using System.Diagnostics; using System.IO; using System.Threading;
public static class StandInLoader {
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "child") { Thread.Sleep(Timeout.Infinite); return 0; }
    string self = Process.GetCurrentProcess().MainModule.FileName;
    Process exact = Start(self, "child \\"" + args[0] + "\\""); Process decoy = Start(self, "child \\"" + args[0] + "-decoy\\"");
    File.WriteAllText("children.txt", exact.Id + " " + decoy.Id);
    Thread.Sleep(Timeout.Infinite); return 0;
  }
  // Shell execution inherits no handles, so a surviving decoy never holds the helper's output pipe open.
  static Process Start(string file, string arguments) { return Process.Start(new ProcessStartInfo(file, arguments) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }); }
}`;
describe.runIf(windows)('the LibreOffice helper ends only the conversion processes it identified', () => {
  let loader = ''; let loaderSha = '';
  beforeAll(async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'unode-native-render-'))); roots.push(dir); loader = path.join(dir, 'standin-loader.exe');
    execFileSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -TypeDefinition $env:UNODE_LOADER_SOURCE -OutputAssembly $env:UNODE_LOADER_EXE -OutputType ConsoleApplication'],
      { env: { ...process.env, UNODE_LOADER_SOURCE: LOADER, UNODE_LOADER_EXE: loader }, stdio: 'ignore' });
    loaderSha = createHash('sha256').update(await readFile(loader)).digest('hex');
  }, 60_000);
  it.each([['stop', 300_000], ['deadline', 6_000]] as const)('on %s: recorded exact-profile child and the loader end; a substring decoy and a non-child keep running', async (trigger, nativeTimeoutMs) => {
    const dirs = await stage(); const source = path.join(dirs.root, 'render-copy.docx'); await writeFile(source, 'stand-in conversion input');
    const exactArgument = '-env:UserInstallation=' + pathToFileURL(path.join(dirs.root, 'libreoffice-profile')).href;
    const run = helper(WINDOWS_LIBREOFFICE_RENDER_SCRIPT, dirs, { kind: 'docx', source, executable: loader, executableSha256: loaderSha, helperHome: dirs.home, passiveChartCopy: false, nativeTimeoutMs });
    const [exact, decoy] = (await until(async () => (await readFile(path.join(dirs.home, 'children.txt'), 'utf8')).split(' ').map(Number), 30_000)); started.push(exact, decoy);
    // Started after the loader, carrying the exact argument, but not the loader's child: only the parent rule excludes it.
    const outsider: ChildProcess = spawn(loader, ['child', exactArgument], { stdio: 'ignore', windowsHide: true }); started.push(outsider.pid!);
    await until(async () => (await receiptOf(dirs)).children?.length ? true : undefined, 30_000); await sleep(1500); // later scans see decoy and outsider
    if (trigger === 'stop') await writeFile(dirs.stop, 'stop');
    const result = answer(await run); const receipt = await receiptOf(dirs);
    expect(result).toMatchObject({ status: 'failed', error: trigger === 'stop' ? 'native-stop-requested' : 'native-stage-timeout', native_app: 'ended', native_reason: 'ended-at-' + (trigger === 'stop' ? 'stop' : 'timeout'), stage_released: true });
    expect(receipt).toMatchObject({ phase: 'closed', native_app: 'ended', process_name: 'soffice', children_complete: true, host_pid: process.pid });
    expect(receipt.children.map((child: { pid: number }) => child.pid)).toEqual([exact]);
    expect([alive(exact), alive(receipt.loader_pid)]).toEqual([false, false]);
    expect([alive(decoy), alive(outsider.pid!)]).toEqual([true, true]);
    expect(existsSync(dirs.pdf)).toBe(false);
  }, 90_000);
});

describe.runIf(windows)('the Word/PowerPoint helper decides Close/Quit from a fresh inventory of its own instance', () => {
  const installed = () => { try { execFileSync('reg', ['query', 'HKCR\\PowerPoint.Application\\CLSID'], { stdio: 'ignore' }); return true; } catch { return false; } };
  // Any failure to enumerate counts as running: an unknown process list is never proof that PowerPoint is absent.
  const running = () => { try { return /POWERPNT/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq POWERPNT.EXE', '/NH'], { encoding: 'utf8' })); } catch { return true; } };
  async function deck(dirs: Record<string, string>) {
    const ppt = new PptxGenJS(); for (let i = 1; i <= 150; i++) ppt.addSlide().addText('Helper check slide ' + i, { x: 1, y: 1, w: 6, h: 1 });
    const source = path.join(dirs.root, 'render-copy.pptx'); await writeFile(source, Buffer.from(await ppt.write({ outputType: 'nodebuffer' }) as Buffer)); return source;
  }
  // it.for, unlike an it.each table, passes the test context, so the environment skips below are real skips.
  it.for([['another presentation joined', true], ['its own copy only', false]] as const)('Stop with %s', async ([_name, join], context) => {
    if (!installed()) context.skip('PowerPoint is not installed on this machine');
    if (running()) context.skip('PowerPoint is already running; this test never shares a person’s instance');
    const dirs = await stage(); const source = await deck(dirs);
    const run = helper(WINDOWS_OFFICE_RENDER_SCRIPT, dirs, { kind: 'pptx', source, nativeTimeoutMs: 300_000, maxNominalPixels: 1_000_000, requirePrivateApplication: true });
    const nativePid: number = await until(async () => { const receipt = await receiptOf(dirs); return receipt.phase === 'started' ? receipt.native_pid : undefined; }, 60_000); started.push(nativePid);
    await until(async () => (await readFile(dirs.phase, 'utf8')) === 'opened' ? true : undefined, 60_000);
    let joiner: ChildProcess | undefined; let joined = '';
    if (join) {
      // Another COM client of the same hidden instance (verified to be the only PowerPoint process: the helper's own).
      const joinedFile = path.join(dirs.root, 'joined'); const releaseFile = path.join(dirs.root, 'release');
      const script = `$ErrorActionPreference = 'Stop'
$ids = @(Get-Process POWERPNT | ForEach-Object { $_.Id }); if ($ids.Count -ne 1 -or $ids[0] -ne ${nativePid}) { exit 3 }
$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application'); $other = $app.Presentations.Add(0)
[IO.File]::WriteAllText('${joinedFile}', [string]$app.Presentations.Count)
while (-not [IO.File]::Exists('${releaseFile}')) { Start-Sleep -Milliseconds 100 }
try { $other.Close() } catch {}
try { if (@(Get-Process -Id ${nativePid} -ErrorAction SilentlyContinue).Count -and $app.Presentations.Count -eq 0) { $app.Quit() } } catch {}`;
      joiner = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)], { stdio: 'ignore', windowsHide: true });
      joined = await until(async () => await readFile(joinedFile, 'utf8'), 60_000);
      await writeFile(dirs.stop, 'stop'); const result = answer(await run); const receipt = await receiptOf(dirs);
      await writeFile(releaseFile, 'go'); await new Promise(resolve => joiner!.once('close', resolve));
      expect(joined).toBe('2');
      expect(result).toMatchObject({ error: 'native-stop-requested', application_owned: true, application_quit: false, document_closed: true,
        native_app: 'left-running', native_reason: 'shared-at-stop', stage_released: true });
      expect(receipt).toMatchObject({ phase: 'closed', native_app: 'left-running', native_reason: 'shared-at-stop', native_pid: nativePid });
    } else {
      await writeFile(dirs.stop, 'stop'); const result = answer(await run); const receipt = await receiptOf(dirs);
      expect(result).toMatchObject({ error: 'native-stop-requested', application_owned: true, application_quit: true, document_closed: true,
        native_app: 'quit-by-helper', native_reason: 'inventory-empty-at-close', stage_released: true });
      expect(receipt).toMatchObject({ phase: 'closed', native_app: 'quit-by-helper', native_pid: nativePid });
      expect(alive(nativePid)).toBe(false);
    }
    expect(Number(answer(await run).completed_pages)).toBeLessThan(150);
  }, 180_000);
});
