import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalApplicationCatalog } from './LocalApplicationCatalog';
import { NativeStageCleanup, type NativeHelperExit, type NativeStageLease } from './NativeStageCleanup';
import { NATIVE_OFFICE_TIMEOUT_MS } from './NativeOfficeRenderer';
import { XLSX_CVERR, XLSX_UNAVAILABLE_ERRORS, type WorkbookRecalcTarget, type WorkbookRecalcValue } from './WorkbookRecalcContracts';
import { windowsExcelRecalcLaunch, type WindowsExcelRecalcLaunch } from './platform/WindowsExcelRecalc';
import { libreOfficeRecalcArguments, libreOfficeRecalcCommandText, prepareLibreOfficeProfile, runLibreOfficeRecalc, type LibreOfficeRecalcPorts } from './platform/LibreOfficeRecalc';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type ExcelHelperRun = Awaited<ReturnType<WindowsExcelRecalcLaunch['run']>>;
/**
 * What the ended Excel helper proves about the stage: released only by its validated answer that it confirmed Excel's
 * exit after Quit, or that nothing was started. A left-running, unknown, missing or unreadable answer keeps the stage
 * for the receipt and a later sweep.
 */
function excelHelperExit(run: ExcelHelperRun, operationId: string): NativeHelperExit {
  if (run.status === 'unavailable' || run.status === 'stopped' && run.helper === 'not-started') return { stage_released: true };
  if (run.status !== 'exited' || run.code !== 0) return { stage_released: false };
  let response: { version?: unknown; operation_id?: unknown; status?: unknown; error?: unknown; native_app?: unknown } | undefined;
  try { response = JSON.parse(run.stdout); } catch { return { stage_released: false }; }
  // The fixed script's first statement answers this before anything is started.
  if (response?.version === 1 && response.status === 'not-run' && response.error === 'powershell-constrained') return { stage_released: true };
  return { stage_released: response?.version === 1 && response.operation_id === operationId && (response.native_app === 'quit-by-helper' || response.native_app === 'not-started') };
}
export type WorkbookRecalcEngineId = 'excel' | 'libreoffice';
export type WorkbookRecalcNativeApp = 'not-started' | 'quit-by-helper' | 'left-running' | 'ended' | 'unknown';
export interface WorkbookRecalcAuthorization { engine: WorkbookRecalcEngineId; executable: string; executable_sha256: string; copy_sha256: string;
  /** Exact text the ordinary command approval shows and binds; `shell` names the command-line grammar of that text. */
  command: string; shell: 'windows-powershell' | 'sh';
  /** The executable the approved command starts (the platform adapter's helper host for Excel, the engine itself otherwise). */
  program: string;
  /** The private stage the command names; it is host-created, never a user folder. */
  stage: string }
export interface WorkbookRecalcEngineJob {
  source: Buffer; engine: WorkbookRecalcEngineId; targets: WorkbookRecalcTarget[]; date1904: boolean; signal: AbortSignal; current(): boolean;
  /** The host's network-launch authority, re-read at the last check before the engine starts; it does not govern later steps. */
  launchAllowed?(): boolean;
  /** Mandatory current native admission and command approval, supplied by the host, never by model input. */
  authorize(facts: WorkbookRecalcAuthorization): Promise<void>;
  /** The fixed worker read of an engine-saved copy; the copy itself is evidence only and is never adopted. */
  readCopy(file: string, directory: string): Promise<WorkbookRecalcValue[]>;
}
export interface WorkbookRecalcEngineResult {
  state: 'passed' | 'failed' | 'not-run' | 'cancelled'; error?: string; engine: WorkbookRecalcEngineId; engine_version?: string; executable_sha256?: string;
  source_sha256: string; copy_sha256?: string; output_sha256?: string; values: WorkbookRecalcValue[]; native_app: WorkbookRecalcNativeApp;
  staging_cleanup: 'removed' | 'not-removed' | 'after-helper-exit';
}
export interface WorkbookRecalcEnginePorts {
  platform?: NodeJS.Platform; catalog?: Pick<LocalApplicationCatalog, 'candidate'>;
  /** The Windows platform adapter's helper launch; only the Excel engine on Windows uses it. */
  excelLaunch?: () => WindowsExcelRecalcLaunch | undefined;
  libreOffice?: LibreOfficeRecalcPorts; stagingLedger?: string; nativeTimeoutMs?: number;
  /** Version facts read from installed files next to LibreOffice, never by starting it. */
  readText?: (file: string) => Promise<string>;
  /** Liveness of a recorded process number (tests); the staging lease's conservative default otherwise. */
  ownerRunning?: (pid: number) => boolean;
}

/** Native recalculation of one private copy; the source bytes, the user's files and other application instances are never changed. */
export class WorkbookRecalcEngine {
  private readonly catalog: Pick<LocalApplicationCatalog, 'candidate'>; private readonly stages: NativeStageCleanup;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly ports: WorkbookRecalcEnginePorts = {}) {
    this.catalog = ports.catalog ?? new LocalApplicationCatalog();
    this.stages = ports.ownerRunning ? new NativeStageCleanup(ports.stagingLedger, ports.ownerRunning) : new NativeStageCleanup(ports.stagingLedger);
  }
  async available(engine: WorkbookRecalcEngineId): Promise<boolean> {
    if (engine === 'excel' && (this.ports.platform ?? process.platform) !== 'win32') return false;
    return !!await this.catalog.candidate(engine);
  }
  async dispose(): Promise<void> { await Promise.allSettled([...this.pending]); await this.stages.dispose(); }

  async run(job: WorkbookRecalcEngineJob): Promise<WorkbookRecalcEngineResult> {
    const result: WorkbookRecalcEngineResult = { state: 'failed', engine: job.engine, source_sha256: hash(job.source), values: [], native_app: 'not-started', staging_cleanup: 'removed' };
    const platform = this.ports.platform ?? process.platform;
    if (job.engine === 'excel' && platform !== 'win32') return Object.assign(result, { state: 'not-run', error: 'platform-unsupported' });
    const candidate = await this.catalog.candidate(job.engine);
    if (!candidate) return Object.assign(result, { state: 'not-run', error: 'recalc-engine-unavailable' });
    if (job.engine === 'libreoffice' && platform === 'win32' && !/\.(?:exe|com)$/i.test(candidate.path)) return Object.assign(result, { state: 'not-run', error: 'recalc-engine-unavailable' });
    result.executable_sha256 = candidate.sha256;
    const live = () => { try { return !job.signal.aborted && job.current(); } catch { return false; } };
    let stage: string | undefined; let lease: NativeStageLease | undefined; const manifest = new Map<string, string>();
    /**
     * Set once the stage is recorded as pending, just before the engine starts: from then on only the engine's end (the
     * helper's validated answer or its receipt) releases the stage, never an immediate cleanup.
     */
    const native: { token?: string; directories: string[]; exit?: NativeHelperExit; later?: boolean } = { directories: [] };
    try {
      if (!live()) return Object.assign(result, { state: 'cancelled', error: 'cancelled' });
      stage = await realpath(await mkdtemp(join(tmpdir(), 'unode-recalc-'))); lease = await this.stages.create(stage);
      const copy = join(stage, 'recalc-copy.xlsx'); const temporary = join(stage, 'tmp'); const home = join(stage, 'helper-home');
      await mkdir(temporary); await mkdir(home); await writeFile(copy, job.source, { flag: 'wx', mode: 0o600 });
      result.copy_sha256 = hash(await readFile(copy)); manifest.set(copy, result.copy_sha256);
      if (result.copy_sha256 !== result.source_sha256) throw Error('recalc-copy-changed');
      const owned = lease;
      const pending = async (directories: string[], operationId: string) => {
        await this.stages.defer(owned, manifest, directories, { operation_id: operationId, receipt: this.stages.receiptPath(operationId, owned.path) });
        native.token = owned.token; native.directories = directories; return owned.token;
      };
      if (job.engine === 'excel') return await this.excel(job, result, { stage, copy, temporary, home, candidate }, native, pending, (helper, operationId) => {
        // Stop or the deadline settled first: the stage is released only by the helper's own end, never at once.
        native.later = true; const token = native.token!; const files = new Map(manifest); const directories = native.directories;
        const settle = helper.then(run => excelHelperExit(run, operationId), () => ({ stage_released: false }))
          .then(exit => this.stages.release(token, { files, directories, exit })).catch(() => false);
        this.pending.add(settle); void settle.then(() => this.pending.delete(settle), () => this.pending.delete(settle));
      });
      return await this.libreOffice(job, result, { stage, copy, temporary, home, candidate }, native, pending);
    } catch (error) {
      if (error && typeof error === 'object' && 'recalcGateOutcome' in error) throw error;
      result.state = live() ? 'failed' : 'cancelled';
      result.error = live() ? error instanceof Error && /^(?:recalc|native|engine)-[a-z-]+$/.test(error.message) ? error.message : 'recalc-engine-failed' : 'cancelled';
      return result;
    } finally {
      if (stage && lease) {
        if (native.later) result.staging_cleanup = 'after-helper-exit';
        else if (native.token) {
          // The engine ended (or never started): its own answer, else its receipt, decides whether the stage is released.
          let removed = false;
          try { removed = await this.stages.release(native.token, { files: manifest, directories: native.directories, ...(native.exit ? { exit: native.exit } : {}) }); } catch { removed = false; }
          if (!removed) result.staging_cleanup = 'not-removed';
        } else if (!await this.stages.complete(lease, manifest, ['tmp', 'helper-home', 'libreoffice-profile'])) result.staging_cleanup = 'not-removed';
      }
    }
  }

  private async excel(job: WorkbookRecalcEngineJob, result: WorkbookRecalcEngineResult,
    paths: { stage: string; copy: string; temporary: string; home: string; candidate: { path: string; sha256: string } },
    native: { exit?: NativeHelperExit }, pending: (directories: string[], operationId: string) => Promise<string>,
    later: (helper: Promise<ExcelHelperRun>, operationId: string) => void): Promise<WorkbookRecalcEngineResult> {
    const launch = (this.ports.excelLaunch ?? windowsExcelRecalcLaunch)();
    if (!launch) return Object.assign(result, { state: 'not-run' as const, error: 'recalc-engine-unavailable' });
    await job.authorize({ engine: 'excel', executable: paths.candidate.path, executable_sha256: paths.candidate.sha256, copy_sha256: result.copy_sha256!, command: launch.command,
      shell: 'windows-powershell', program: launch.program, stage: paths.stage });
    const current = await this.catalog.candidate('excel');
    if (!current || current.path !== paths.candidate.path || current.sha256 !== paths.candidate.sha256) throw Error('engine-binding-changed');
    if (hash(await readFile(paths.copy)) !== result.copy_sha256) throw Error('recalc-copy-changed');
    if (job.signal.aborted || !job.current() || job.launchAllowed?.() === false) return Object.assign(result, { state: 'cancelled', error: 'cancelled' });
    const stopFile = join(paths.temporary, 'stop'); const timeoutMs = this.ports.nativeTimeoutMs ?? NATIVE_OFFICE_TIMEOUT_MS;
    const operationId = 'workbook-recalc-' + randomUUID();
    // Recorded as pending before the helper starts, so a host that exits mid-run leaves a stage a later sweep finds.
    const token = await pending(['tmp', 'helper-home'], operationId);
    // The last check before the launch, after the record's write: Stop, current authority and the host's launch
    // authority (Web access) are read again. Nothing was started, which this host observed itself.
    if (job.signal.aborted || !job.current() || job.launchAllowed?.() === false) { native.exit = { stage_released: true }; return Object.assign(result, { state: 'cancelled', error: 'cancelled' }); }
    const input = { operationId, source: paths.copy, phase: join(paths.temporary, 'phase.txt'), stop: stopFile, nativeTimeoutMs: timeoutMs,
      receipt: this.stages.receiptPath(operationId, paths.stage), hostPid: process.pid,
      targets: job.targets.map((target, i) => ({ i, position: target.position, cell: target.cell })) };
    result.native_app = 'unknown';
    // The helper is never killed: Stop and the deadline only write its stop marker; the helper closes what it owns.
    const helper = Promise.resolve().then(() => launch.run(input, { cwd: paths.home, tmp: paths.temporary, onSpawn: helperPid => { void this.stages.noteHelper(token, helperPid); } }));
    let deadline: ReturnType<typeof setTimeout> | undefined; let onAbort: (() => void) | undefined;
    const stopped = new Promise<'cancelled' | 'timeout'>(resolve => {
      deadline = setTimeout(() => resolve('timeout'), timeoutMs + 5000);
      onAbort = () => resolve('cancelled'); if (job.signal.aborted) onAbort(); else job.signal.addEventListener('abort', onAbort, { once: true });
    });
    const first = await Promise.race([helper, stopped]).catch(() => undefined);
    if (deadline) clearTimeout(deadline); if (onAbort) job.signal.removeEventListener('abort', onAbort);
    if (first === undefined) throw Error('native-helper-failed');
    if (first === 'cancelled' || first === 'timeout') {
      await writeFile(stopFile, first, { flag: 'w' }).catch(() => undefined);
      later(helper, operationId);
      return Object.assign(result, { state: first === 'cancelled' ? 'cancelled' as const : 'failed' as const, error: first === 'cancelled' ? 'cancelled' : 'native-stage-timeout', native_app: 'unknown' as const });
    }
    const run = first; native.exit = excelHelperExit(run, operationId);
    if (run.status === 'unavailable') { result.native_app = 'not-started'; return Object.assign(result, { state: 'not-run', error: 'powershell-' + run.reason }); }
    if (run.status !== 'exited' || run.code !== 0) throw Error('native-helper-failed');
    let response: { version?: number; operation_id?: string; status?: string; error?: string | null; app_version?: string; native_app?: string; values?: Array<{ i: number; kind: string; value?: string; code?: number }> };
    try { response = JSON.parse(run.stdout); } catch { throw Error('native-response-invalid'); }
    if (response.version === 1 && response.status === 'not-run' && response.error === 'powershell-constrained') { result.native_app = 'not-started'; return Object.assign(result, { state: 'not-run', error: 'powershell-constrained' }); }
    if (response.version !== 1 || response.operation_id !== operationId || !['passed', 'failed', 'not-run', 'stopped'].includes(response.status ?? '')) throw Error('native-response-invalid');
    result.native_app = ['quit-by-helper', 'left-running', 'not-started', 'unknown'].includes(response.native_app ?? '') ? response.native_app as WorkbookRecalcNativeApp : 'unknown';
    result.engine_version = typeof response.app_version === 'string' && /^[0-9.]{1,64}$/.test(response.app_version) ? response.app_version : 'unknown';
    if (response.status !== 'passed') return Object.assign(result, { state: response.status === 'not-run' ? 'not-run' as const : 'failed' as const,
      error: typeof response.error === 'string' && /^[a-z][a-z-]{0,63}$/.test(response.error) ? response.error : 'native-calculation-failed' });
    const values = Array.isArray(response.values) ? response.values : [];
    if (values.length !== job.targets.length || values.some((value, index) => value?.i !== index)) throw Error('native-response-invalid');
    result.values = job.targets.map((target, index) => {
      const value = values[index]; const base = { sheet_id: target.sheet_id, cell: target.cell };
      if (value.kind === 'blank') return { ...base, type: 'blank' as const, value: null, recalculated: true };
      if (value.kind === 'n' && typeof value.value === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:E[+-]?\d+)?$/i.test(value.value)) return { ...base, type: 'n' as const, value: value.value, recalculated: true };
      if (value.kind === 'str' && typeof value.value === 'string') return { ...base, type: 'str' as const, value: value.value, recalculated: true };
      if (value.kind === 'b' && (value.value === '1' || value.value === '0')) return { ...base, type: 'b' as const, value: value.value, recalculated: true };
      if (value.kind === 'e' && XLSX_CVERR.has(Number(value.code))) {
        // #NAME? and #BLOCKED! are not the workbook's calculated result (see XLSX_UNAVAILABLE_ERRORS), as on the LibreOffice path.
        const text = XLSX_CVERR.get(Number(value.code))!; const unavailable = XLSX_UNAVAILABLE_ERRORS.get(text);
        return { ...base, type: 'e' as const, value: text, recalculated: !unavailable, ...(unavailable ? { error: unavailable } : {}) };
      }
      return { ...base, type: 'blank' as const, value: null, recalculated: false, error: 'engine-value-unreadable' };
    });
    result.state = 'passed'; return result;
  }

  private async libreOffice(job: WorkbookRecalcEngineJob, result: WorkbookRecalcEngineResult,
    paths: { stage: string; copy: string; temporary: string; home: string; candidate: { path: string; sha256: string } },
    native: { exit?: NativeHelperExit }, pending: (directories: string[], operationId: string) => Promise<string>): Promise<WorkbookRecalcEngineResult> {
    const profile = join(dirname(paths.copy), 'libreoffice-profile'); const output = join(paths.temporary, 'out');
    await prepareLibreOfficeProfile(profile); await mkdir(output);
    const args = libreOfficeRecalcArguments(profile, output, paths.copy);
    await job.authorize({ engine: 'libreoffice', executable: paths.candidate.path, executable_sha256: paths.candidate.sha256, copy_sha256: result.copy_sha256!,
      command: libreOfficeRecalcCommandText(paths.candidate.path, args, this.ports.platform ?? process.platform),
      shell: (this.ports.platform ?? process.platform) === 'win32' ? 'windows-powershell' : 'sh', program: paths.candidate.path, stage: paths.stage });
    const current = await this.catalog.candidate('libreoffice');
    if (!current || current.path !== paths.candidate.path || current.sha256 !== paths.candidate.sha256) throw Error('engine-binding-changed');
    if (hash(await readFile(paths.copy)) !== result.copy_sha256) throw Error('recalc-copy-changed');
    if (job.signal.aborted || !job.current() || job.launchAllowed?.() === false) return Object.assign(result, { state: 'cancelled', error: 'cancelled' });
    // Recorded as pending before LibreOffice starts. No helper writes a receipt for it, so only this host's own
    // observation that the process tree ended (or never started) releases the stage; otherwise it is kept.
    await pending(['tmp', 'helper-home', 'libreoffice-profile'], 'workbook-recalc-' + randomUUID());
    if (job.signal.aborted || !job.current() || job.launchAllowed?.() === false) { native.exit = { stage_released: true }; return Object.assign(result, { state: 'cancelled', error: 'cancelled' }); }
    result.native_app = 'unknown';
    const run = await runLibreOfficeRecalc({ executable: paths.candidate.path, args, cwd: paths.home, signal: job.signal }, this.ports.libreOffice);
    result.native_app = run.native_app; native.exit = { stage_released: run.native_app === 'ended' || run.native_app === 'not-started' };
    try {
      const text = await (this.ports.readText ?? (file => readFile(file, 'utf8')))(join(dirname(paths.candidate.path), (this.ports.platform ?? process.platform) === 'win32' ? 'version.ini' : 'versionrc'));
      const build = /^buildid=([0-9a-f]{7,40})\s*$/mi.exec(text)?.[1]; result.engine_version = build ? `build ${build.slice(0, 12)}` : 'unknown';
    } catch { result.engine_version = 'unknown'; }
    if (run.status === 'stopped') return Object.assign(result, { state: 'cancelled', error: 'cancelled' });
    if (run.status === 'timeout') return Object.assign(result, { state: 'failed', error: 'native-stage-timeout' });
    if (run.status === 'spawn-failed') return Object.assign(result, { state: 'not-run', error: 'recalc-engine-unavailable', native_app: 'not-started' });
    if (run.status !== 'exited' || run.code !== 0) throw Error('native-calculation-failed');
    const converted = join(output, 'recalc-copy.xlsx'); let bytes: Buffer;
    try { bytes = await readFile(converted); } catch { throw Error('native-calculation-failed'); }
    result.output_sha256 = hash(bytes);
    if (hash(await readFile(paths.copy)) !== result.copy_sha256) throw Error('recalc-copy-changed');
    result.values = await job.readCopy(converted, paths.temporary);
    if (result.values.length !== job.targets.length) throw Error('native-response-invalid');
    result.state = 'passed'; return result;
  }
}
