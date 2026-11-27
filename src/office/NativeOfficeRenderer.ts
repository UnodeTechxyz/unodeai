import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countPdfPages, hostReadMemoryBudget, isPdf } from '../content/ContentAssetStore';
import { encodePowerShellScript, runDocumentWindowsPowerShell } from '../host/windowsPowerShell';
import { LocalApplicationCatalog } from './LocalApplicationCatalog';
import { OfficeRenderPureHost } from './OfficeRenderPureHost';
import { nativeOfficeRenderingPlatform } from './OfficeRendererSelection';
import type { OfficeRenderCopy, OfficeRenderCopyFact } from './OfficeRenderCopy';
import { captureRasterFile } from './RasterFileCapture';
import { WindowsPdfRasterizer, type RasterPageFact } from './WindowsPdfRasterizer';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from './WindowsOfficeScript';
import { WINDOWS_PDF_RASTER_SCRIPT } from './WindowsPdfScript';
import { WINDOWS_LIBREOFFICE_RENDER_SCRIPT } from './WindowsLibreOfficeScript';
import { WINDOWS_WORD_PDF_CONVERT_SCRIPT } from './WindowsWordPdfScript';
import * as path from 'node:path';
import { NativeStageCleanup, type NativeHelperExit, type NativeStageLease } from './NativeStageCleanup';

export interface NativeOfficeRenderJob {
  operation_id?: string;
  require_private_application?: boolean;
  /** `pdf` only with intent `convert-docx` and Word: the PDF is copied byte for byte (there is no passive Office copy). */
  source: Buffer; kind: 'docx' | 'pptx' | 'pdf'; renderer: 'word' | 'powerpoint' | 'libreoffice'; signal: AbortSignal; current(): boolean;
  /** Original inspected slide count, not a model claim or a PDF page count. */
  source_slide_count?: number;
  /** `deliver-pdf` (export_pdf): keep the native PDF of the passive copy for the caller instead of capturing pages. */
  /** `convert-docx` (convert_pdf_to_docx): Word opens a private copy of a PDF and saves it as .docx for the caller. */
  intent?: 'render-pages' | 'deliver-pdf' | 'convert-docx';
  /** Receives the verified PDF of a deliver-pdf job before the render result is returned. */
  onPdf?(pdf: NativePdfOutput & { data: Buffer }): void | Promise<void>;
  /** Receives the verified DOCX of a convert-docx job before the result is returned. */
  onDocx?(docx: NativeDocxOutput & { data: Buffer }): void | Promise<void>;
  /** Mandatory current Commands/trust/source gate supplied by the public host, never by model input. */
  beforeStart(facts: { renderer: string; renderer_executable?: string; source_sha256: string; render_copy_sha256: string; fixed_script_sha256: string; pdf_raster_script_sha256?: string; copy_fact?: OfficeRenderCopyFact }): Promise<void>;
  onPage(page: RasterPageFact & { data: Buffer }): void | Promise<void>;
}
export interface NativeOfficeRenderResult {
  operation_id: string; renderer: NativeOfficeRenderJob['renderer']; renderer_version?: string; installed_executable_sha256?: string;
  source_sha256: string; render_copy?: OfficeRenderCopyFact;
  state: 'passed' | 'partial' | 'failed' | 'not-run' | 'cancelled' | 'outcome-unknown'; error?: string;
  application_export: 'not-started' | 'completed' | 'partial' | 'failed' | 'unknown'; document_closed: boolean;
  application_owned?: boolean; application_quit?: boolean;
  helper_stop?: 'not-started' | 'stopped' | 'unconfirmed';
  /** The native stage's own end, kept apart from the render result: a cancelled request is not a closed application. */
  native_stop?: NativeStopFacts;
  chart_display?: { state: 'not-verified'; charts: number; reason: string };
  pages: RasterPageFact[]; total_pages?: number; staging_cleanup: 'removed' | 'not-removed'; scope: string;
  /** deliver-pdf only: the PDF handed to the caller, checked as a PDF with at least one page. */
  pdf?: NativePdfOutput;
  /** convert-docx only: the DOCX handed to the caller, checked as a Word package. */
  docx?: NativeDocxOutput;
}
export interface NativePdfOutput { sha256: string; bytes: number; pages: number }
export interface NativeDocxOutput { sha256: string; bytes: number }
interface RendererPorts {
  platform?: NodeJS.Platform;
  catalog?: Pick<LocalApplicationCatalog, 'candidate'>;
  pure?: OfficeRenderPureHost;
  execute?: typeof runDocumentWindowsPowerShell;
  pdf?: WindowsPdfRasterizer;
  /** Page count of a produced PDF (PDF.js in the isolated content worker by default). */
  pdfPages?: (path: string, bytes: number) => Promise<number>;
  memoryBudget?: () => number;
  retainStage?: (path: string) => void;
  nativeTimeoutMs?: number;
  stagingLedger?: string;
  /** Liveness of a recorded process number (tests); the cleaner's conservative default otherwise. */
  ownerRunning?: (pid: number) => boolean;
}
export interface NativeStopFacts {
  operation: 'completed' | 'stopped' | 'timed-out';
  /** `closing`: the host did not end the helper; it is closing its own document and may still be running. */
  helper: 'closing' | 'exited' | 'not-started';
  native_app: 'quit-by-helper' | 'left-running' | 'ended' | 'not-started' | 'unknown';
  native_reason?: string;
  /** Whether this render uses the native output. Stop or the deadline never uses a late or partial one. */
  output: 'kept' | 'none';
  staging: 'removed' | 'kept-until-app-ends';
  /** A LibreOffice timeout: the usable alternative for this document type. */
  next?: string;
  summary: string;
}
export const NATIVE_OFFICE_TIMEOUT_MS = 300_000;
const NATIVE_APPS: ReadonlyArray<NativeStopFacts['native_app']> = ['quit-by-helper', 'left-running', 'ended', 'not-started', 'unknown'];
const LEFT_RUNNING: Readonly<Record<string, string>> = {
  'shared': 'it had other documents open, so only this operation’s copy was closed',
  'shared-at-stop': 'other documents were open at the stop, so only this operation’s copy was closed',
  'visible-adopted': 'it had become visible and may be in use, so only this operation’s copy was closed',
  'existing-application': 'it was already running before this render, so only this operation’s copy was closed',
  'exit-unconfirmed': 'its conversion processes could not be confirmed ended within five seconds',
};
/** Plain facts for the person and the model: what was cancelled, and separately what the native application did. */
export function nativeStopSummary(facts: Omit<NativeStopFacts, 'summary'>): string {
  const head = facts.operation === 'stopped' ? 'The render request was cancelled; no output from it is used.'
    : facts.operation === 'timed-out' ? 'The native stage reached its five-minute limit; the render failed and no partial output is used.'
      : 'The native stage finished.';
  const app = facts.helper === 'closing'
    ? 'The helper is still closing this operation’s copy in the background, so the application’s state is not yet known. UnodeAi never force-ends Word or PowerPoint; for LibreOffice the helper ends only the conversion processes it started for this operation. No action is needed.'
    : facts.native_app === 'quit-by-helper' ? 'The private application closed after a fresh check showed no other open documents.'
      : facts.native_app === 'ended' ? 'The private LibreOffice conversion processes ended.'
        : facts.native_app === 'not-started' ? 'No native application was started.'
          : facts.native_app === 'left-running' ? 'The application was left running: ' + (LEFT_RUNNING[facts.native_reason ?? ''] ?? 'only this operation’s copy was closed') + '.'
            : 'Whether the native application has exited is unknown; UnodeAi does not force-end it.';
  const staging = facts.staging === 'kept-until-app-ends' ? ' Its temporary copy is kept; UnodeAi tries to remove it only after the helper and the application are seen to have exited.' : '';
  return head + ' ' + app + staging + (facts.next ? ' ' + facts.next : '');
}
function nativeStop(facts: Omit<NativeStopFacts, 'summary'>): NativeStopFacts { return { ...facts, summary: nativeStopSummary(facts) }; }
/** What to try after LibreOffice reached the native time limit, by document type. */
export function libreOfficeTimeoutAlternative(kind: 'docx' | 'pptx'): string {
  return kind === 'docx' ? 'Next: render this document with Word (adapter_id word); if that is unavailable, split it into smaller documents and try again.'
    : 'Next: render this presentation with PowerPoint (adapter_id powerpoint) if it is installed; otherwise split it into smaller presentations and try again.';
}
/** The helper's final answer as far as stage release goes; a missing or unexpected field is never read as released. */
function helperExitFacts(response: any): { native_app: NativeStopFacts['native_app']; native_reason?: string; exit: NativeHelperExit } {
  const app = NATIVE_APPS.includes(response?.native_app) ? response.native_app as NativeStopFacts['native_app'] : 'unknown';
  const reason = typeof response?.native_reason === 'string' && /^[a-z-]{1,64}$/.test(response.native_reason) ? response.native_reason : undefined;
  return { native_app: app, ...(reason ? { native_reason: reason } : {}), exit: { stage_released: response?.stage_released === true && app !== 'unknown' } };
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

type HelperRun = Awaited<ReturnType<typeof runDocumentWindowsPowerShell>>;
type NativeEnd = { kind: 'exited'; run: HelperRun } | { kind: 'rejected' } | { kind: 'stop' } | { kind: 'timeout' };
/** One settle per native stage: the helper's own exit, Stop, or the host's backup deadline, whichever comes first. */
function firstNativeEnd(run: Promise<HelperRun>, signal: AbortSignal, deadlineMs: number): Promise<NativeEnd> {
  return new Promise(resolve => {
    let done = false;
    const finish = (end: NativeEnd) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(end); };
    const onAbort = () => finish({ kind: 'stop' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), deadlineMs);
    run.then(value => finish({ kind: 'exited', run: value }), () => finish({ kind: 'rejected' }));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}
interface HelperEnd { helper: 'exited' | 'not-started'; native_app: NativeStopFacts['native_app']; native_reason?: string; exit: NativeHelperExit; response?: any }
const NOT_STARTED: HelperEnd = { helper: 'not-started', native_app: 'not-started', exit: { stage_released: true } };
/** What the ended helper says about its application. Anything unreadable stays unknown and keeps the stage. */
function helperEnd(run: HelperRun, operationId: string): HelperEnd {
  if (run.status === 'unavailable' || run.status === 'stopped' && run.helper === 'not-started') return NOT_STARTED;
  if (run.status === 'stopped') return { helper: 'exited', native_app: 'unknown', native_reason: 'helper-output-limit', exit: { stage_released: false } };
  let response: any; try { response = JSON.parse(run.stdout); } catch { response = undefined; }
  if (run.code !== 0 || response?.version !== 1) return { helper: 'exited', native_app: 'unknown', native_reason: 'helper-answer-invalid', exit: { stage_released: false } };
  if (response.status === 'not-run' && response.error === 'powershell-constrained') return { ...NOT_STARTED, response };
  if (response.operation_id !== operationId) return { helper: 'exited', native_app: 'unknown', native_reason: 'helper-answer-invalid', exit: { stage_released: false } };
  return { helper: 'exited', ...helperExitFacts(response), response };
}
const NATIVE_PRODUCERS = ['tmp', 'helper-home', 'native', 'pages'];

/** Native effect only; public source/command authority and foreground/background lifecycle live in its caller. */
export class NativeOfficeRenderer {
  private readonly catalog: Pick<LocalApplicationCatalog, 'candidate'>;
  private readonly pure: OfficeRenderPureHost;
  private readonly stages: NativeStageCleanup;
  private readonly retained = new Set<string>();
  /** Helpers still closing their own document after their render settled. Deactivation never waits for them. */
  private readonly closing = new Set<Promise<void>>();
  constructor(private readonly ports: RendererPorts = {}) {
    this.catalog = ports.catalog ?? new LocalApplicationCatalog(); this.pure = ports.pure ?? new OfficeRenderPureHost();
    this.stages = ports.ownerRunning ? new NativeStageCleanup(ports.stagingLedger, ports.ownerRunning) : new NativeStageCleanup(ports.stagingLedger);
  }
  private retain = (stage: string) => { this.retained.add(stage); try { this.ports.retainStage?.(stage); } catch { /* Retention never changes an artifact result. */ } };
  async recoverStaging(): Promise<void> { await this.stages.recover(); }
  async dispose(): Promise<void> { await this.stages.dispose(); }
  /** Resolves when every helper left closing after a Stop or deadline has ended and its facts were appended. */
  async closingSettled(): Promise<void> { while (this.closing.size) await Promise.all([...this.closing]); }
  /** After Stop or the deadline settled the render: wait for the helper's own end in the background, then append the
   * native facts and release the stage only as the helper's answer or receipt allows. The render result never changes. */
  private closeLater(run: Promise<HelperRun>, result: NativeOfficeRenderResult, token: string, stage: string, files: ReadonlyMap<string, string>, directories: string[]): void {
    const task = (async () => {
      let end: HelperEnd; try { end = helperEnd(await run, result.operation_id); } catch { end = NOT_STARTED; }
      let removed = false; try { removed = await this.stages.release(token, { files, directories, exit: end.exit }); } catch { removed = false; }
      const { operation, output, next } = result.native_stop!;
      result.native_stop = nativeStop({ operation, output, ...(next ? { next } : {}), helper: end.helper, native_app: end.native_app,
        ...(end.native_reason ? { native_reason: end.native_reason } : {}), staging: removed ? 'removed' : 'kept-until-app-ends' });
      if (removed) result.staging_cleanup = 'removed'; else this.retain(stage);
    })();
    this.closing.add(task); void task.finally(() => this.closing.delete(task));
  }
  async render(job: NativeOfficeRenderJob): Promise<NativeOfficeRenderResult> {
    const operationId = job.operation_id && /^office-render-[a-zA-Z0-9-]+$/.test(job.operation_id) ? job.operation_id : 'office-render-' + randomUUID();
    const result: NativeOfficeRenderResult = { operation_id: operationId, renderer: job.renderer,
      source_sha256: hash(job.source), state: 'failed', application_export: 'not-started', document_closed: false, pages: [], staging_cleanup: 'removed',
      scope: 'Actual pages of this render copy only. Copy modifications, page capture, model delivery and independent visual review are separate facts. Native app is not an OS/network sandbox.' };
    const budget = this.ports.memoryBudget?.() ?? hostReadMemoryBudget();
    if (!Number.isSafeInteger(budget) || budget <= 0 || job.source.length > budget) return Object.assign(result, { error: 'render-memory-limited' });
    if (!nativeOfficeRenderingPlatform(this.ports.platform ?? process.platform)) return Object.assign(result, { state: 'not-run', error: 'windows-native-renderer-unavailable' });
    const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, job.signal]);
    const current = () => { try { return !signal.aborted && job.current(); } catch { return false; } };
    const check = () => { if (!current()) { controller.abort(); throw Error('cancelled'); } };
    let stage: string | undefined; let lease: NativeStageLease | undefined;
    let cleanupAllowed = true; let phase = 'stage';
    /** Set once a helper may run: from then on only the helper's end decides the stage. */
    let native: { token: string; directories: string[]; end?: HelperEnd } | undefined; let handedOff = false;
    const manifest = new Map<string, string>();
    try {
      check();
      const convert = job.intent === 'convert-docx';
      if (convert || job.kind === 'pdf' ? !(convert && job.kind === 'pdf' && job.renderer === 'word')
        : job.renderer !== 'libreoffice' && (job.kind === 'docx' ? job.renderer !== 'word' : job.kind !== 'pptx' || job.renderer !== 'powerpoint')) return Object.assign(result, { state: 'not-run', error: 'render-kind-mismatch' });
      const candidate = await this.catalog.candidate(job.renderer); check();
      if (!candidate) return Object.assign(result, { state: 'not-run', error: 'renderer-not-detected' });
      if (job.renderer === 'libreoffice' && !['.exe', '.com'].includes(path.win32.extname(candidate.path).toLowerCase())) return Object.assign(result, { state: 'not-run', error: 'renderer-native-executable-required' });
      result.installed_executable_sha256 = candidate.sha256;
      stage = await mkdtemp(join(tmpdir(), 'unode-native-render-')); stage = await realpath(stage); lease = await this.stages.create(stage);
      const source = join(stage, 'source.' + job.kind); const copyPath = join(stage, 'render-copy.' + job.kind);
      const output = join(stage, 'pages'); const temporary = join(stage, 'tmp'); const helperFiles = join(stage, 'native');
      // The helper writes only into producer directories, so a stage whose host exited can still be identified and cleaned.
      const pdf = join(helperFiles, 'internal.pdf'); const docx = join(helperFiles, 'converted.docx'); const marker = join(helperFiles, 'phase.txt'); const stopMarker = join(helperFiles, 'stop');
      await mkdir(output); await mkdir(temporary); await mkdir(helperFiles); await writeFile(source, job.source, { flag: 'wx', mode: 0o600 }); manifest.set(source, result.source_sha256);
      phase = 'copy'; check();
      // A PDF for conversion is copied byte for byte; an Office source gets the verified passive copy.
      const copy = convert ? undefined : await this.pure.run<OfficeRenderCopy>({ operation: 'copy', source, memoryBudget: budget }, job.source.length, signal, current); check();
      const bytes = copy ? Buffer.from(copy.bytes) : Buffer.from(job.source);
      const copySha = copy ? copy.fact.render_copy_sha256 : result.source_sha256;
      if (copy && (copy.fact.kind !== job.kind || copy.fact.source_sha256 !== result.source_sha256) || hash(bytes) !== copySha) throw Error('render-copy-changed');
      if (copy) result.render_copy = copy.fact;
      await writeFile(copyPath, bytes, { flag: 'wx', mode: 0o600 }); manifest.set(copyPath, copySha);
      phase = 'authorization';
      const script = convert ? WINDOWS_WORD_PDF_CONVERT_SCRIPT : job.renderer === 'libreoffice' ? WINDOWS_LIBREOFFICE_RENDER_SCRIPT : WINDOWS_OFFICE_RENDER_SCRIPT;
      const deliverPdf = job.intent === 'deliver-pdf';
      // Page capture rasterizes the internal PDF; a delivered PDF is handed over as produced and never rasterized.
      const usesPdf = !deliverPdf && !convert && (job.kind === 'docx' || job.renderer === 'libreoffice');
      await job.beforeStart({ renderer: job.renderer, renderer_executable: candidate.path, source_sha256: result.source_sha256, render_copy_sha256: copySha,
        ...(copy ? { copy_fact: structuredClone(copy.fact) } : {}),
        fixed_script_sha256: hash(script), ...(usesPdf ? { pdf_raster_script_sha256: hash(WINDOWS_PDF_RASTER_SCRIPT) } : {}) });
      check(); const bound = await this.catalog.candidate(job.renderer);
      if (!bound || bound.path !== candidate.path || bound.sha256 !== candidate.sha256) throw Error('renderer-binding-changed');
      if (hash(await captureRasterFile(source, budget)) !== result.source_sha256 || hash(await captureRasterFile(copyPath, budget)) !== copySha) throw Error('render-copy-changed');
      check();
      // An empty operation-private cwd avoids intentionally using a user/project folder for native application lookup.
      phase = 'helper-home';
      const home = join(stage, 'helper-home'); await mkdir(home); check();
      const nativeTimeoutMs = this.ports.nativeTimeoutMs ?? NATIVE_OFFICE_TIMEOUT_MS;
      const receipt = this.stages.receiptPath(result.operation_id, stage);
      const directories = [...NATIVE_PRODUCERS, ...(job.renderer === 'libreoffice' ? ['libreoffice-profile'] : [])];
      await this.stages.defer(lease, manifest, NATIVE_PRODUCERS, { operation_id: result.operation_id, receipt });
      check();
      phase = 'native'; cleanupAllowed = false; result.application_export = 'unknown';
      native = { token: lease.token, directories }; const token = lease.token;
      const execute = this.ports.execute ?? runDocumentWindowsPowerShell;
      const run = Promise.resolve().then(() => execute({ encodedCommand: encodePowerShellScript(script),
        inputVariable: 'UNODE_OFFICE_RENDER_JOB', input: Buffer.from(JSON.stringify({ operationId: result.operation_id, kind: job.kind, source: copyPath,
          output, pdf, phase: marker, stop: stopMarker, receipt, hostPid: process.pid, nativeTimeoutMs, ...(deliverPdf ? { intent: 'deliver-pdf' } : {}), ...(convert ? { intent: 'convert-docx', docx } : {}),
          ...(job.renderer === 'libreoffice' ? { executable: candidate.path, executableSha256: candidate.sha256, helperHome: home,
            passiveChartCopy: (copy?.fact.native_charts ?? 0) > 0, renderCopySha256: copySha } : { requirePrivateApplication: job.require_private_application === true }),
          maxNominalPixels: Math.max(1, Math.floor(budget / 64)) })).toString('base64'),
        maxInputChars: 65536, maxStdoutBytes: 16384, cwd: home, tmp: temporary, signal, helperClosesApplication: true,
        onSpawn: helperPid => { void this.stages.noteHelper(token, helperPid); } }));
      const ended = await firstNativeEnd(run, signal, nativeTimeoutMs + 5000);
      if (ended.kind === 'stop' || ended.kind === 'timeout') {
        // Stop or the host deadline settled first. The host never ends the helper: it asks the helper to stop at its next
        // checkpoint, where only the helper closes its own document and quits only its own empty private application.
        const timedOut = ended.kind === 'timeout';
        try { await writeFile(stopMarker, timedOut ? 'deadline' : 'stop', { flag: 'wx', mode: 0o600 }); } catch { /* An existing marker asks the same. */ }
        handedOff = true;
        result.native_stop = nativeStop({ operation: timedOut ? 'timed-out' : 'stopped', helper: 'closing', native_app: 'unknown', output: 'none', staging: 'kept-until-app-ends',
          ...(timedOut && job.renderer === 'libreoffice' && job.kind !== 'pdf' ? { next: libreOfficeTimeoutAlternative(job.kind) } : {}) });
        this.closeLater(run, result, token, stage, new Map(manifest), directories);
        return Object.assign(result, { state: timedOut ? 'failed' : 'cancelled', error: timedOut ? 'native-stage-timeout' : 'cancelled' });
      }
      if (ended.kind === 'rejected') { native.end = NOT_STARTED; throw Error('native-helper-failed'); }
      const end = native.end = helperEnd(ended.run, result.operation_id); const executed = ended.run;
      const helperTimedOut = end.response?.error === 'native-stage-timeout';
      result.native_stop = nativeStop({ operation: helperTimedOut ? 'timed-out' : 'completed', helper: end.helper, native_app: end.native_app,
        ...(helperTimedOut && job.renderer === 'libreoffice' && job.kind !== 'pdf' ? { next: libreOfficeTimeoutAlternative(job.kind) } : {}),
        ...(end.native_reason ? { native_reason: end.native_reason } : {}), output: 'none', staging: 'kept-until-app-ends' });
      if (executed.status === 'stopped') {
        result.helper_stop = executed.helper;
        if (executed.helper === 'not-started') { result.application_export = 'not-started'; return Object.assign(result, { state: 'cancelled', error: 'native-helper-not-started' }); }
        return Object.assign(result, { state: 'failed', error: 'native-output-limit' });
      }
      if (executed.status === 'unavailable') { result.application_export = 'not-started'; return Object.assign(result, { state: 'not-run', error: 'powershell-' + executed.reason }); }
      if (executed.code !== 0) return Object.assign(result, { error: 'native-helper-failed' });
      const response = end.response; if (!response) throw Error('native-response-invalid');
      if (response.status === 'not-run' && response.error === 'powershell-constrained') {
        result.application_export = 'not-started'; return Object.assign(result, { state: 'not-run', error: 'powershell-constrained' });
      }
      if (response.status === 'not-run' && ['powerpoint-already-running', 'powerpoint-shared-application'].includes(response.error)) {
        result.application_export = 'not-started';
        result.scope += ' Automatic PowerPoint rendering does not borrow an already-running or unconfirmed private application. Other document work can continue.';
        return Object.assign(result, { state: 'not-run', error: response.error });
      }
      // Conversion only: the Word PDF notice is on (Word not started), or Word was not a proven private instance (nothing opened).
      if (convert && response.status === 'not-run' && ['word-pdf-prompt-on', 'office-instance-not-private'].includes(response.error)) {
        result.application_export = 'not-started'; return Object.assign(result, { state: 'not-run', error: response.error });
      }
      if (!['passed', 'partial', 'failed'].includes(response.status)
        || typeof response.document_closed !== 'boolean' || !Number.isSafeInteger(response.page_count) || response.page_count < 0
        || !Number.isSafeInteger(response.completed_pages) || response.completed_pages < 0 || response.completed_pages > response.page_count) throw Error('native-response-invalid');
      result.application_export = response.status === 'passed' ? 'completed' : response.status === 'partial' ? 'partial' : 'failed';
      result.document_closed = response.document_closed;
      if (typeof response.application_owned === 'boolean') result.application_owned = response.application_owned;
      if (typeof response.application_quit === 'boolean') result.application_quit = response.application_quit;
      result.renderer_version = typeof response.app_version === 'string' && /^[0-9.]{1,64}$/.test(response.app_version) ? response.app_version : 'unknown';
      // The helper's own deadline: no partial pages or PDF from a timed-out stage are used.
      if (response.error === 'native-stage-timeout' || response.error === 'native-stop-requested') {
        return Object.assign(result, { state: 'failed', error: response.error === 'native-stage-timeout' ? 'native-stage-timeout' : 'native-export-failed' });
      }
      check(); phase = 'capture';
      if (hash(await captureRasterFile(source, budget)) !== result.source_sha256 || hash(await captureRasterFile(copyPath, budget)) !== copySha) throw Error('render-copy-changed');
      const decode = (data: Buffer, memoryBudget: number) => this.pure.run<{ sha256: string; width: number; height: number }>({ operation: 'png', bytes: data, memoryBudget }, data.length, signal, current);
      if (convert && response.status === 'passed') {
        // The DOCX Word saved must be a Word package the passive-copy reader accepts, and stay the same bytes until handed over.
        const data = await captureRasterFile(docx, budget); const sha256 = hash(data); manifest.set(docx, sha256);
        const checked = await this.pure.run<OfficeRenderCopy>({ operation: 'copy', source: docx, memoryBudget: budget }, data.length, signal, current); check();
        if (checked.fact.kind !== 'docx' || checked.fact.source_sha256 !== sha256 || hash(await captureRasterFile(docx, budget)) !== sha256) throw Error('render-output-invalid');
        result.docx = { sha256, bytes: data.length };
        phase = 'delivery'; await job.onDocx?.({ ...result.docx, data: Buffer.from(data) }); phase = 'capture'; check();
        result.native_stop = nativeStop({ ...result.native_stop, output: 'kept' }); result.state = 'passed';
      } else if (deliverPdf && response.status === 'passed') {
        const data = await captureRasterFile(pdf, budget); const sha256 = hash(data); manifest.set(pdf, sha256);
        if (!isPdf(data)) throw Error('render-output-invalid');
        const pages = await (this.ports.pdfPages ?? ((file: string, bytes: number) => countPdfPages(file, bytes)))(pdf, data.length); check();
        if (!Number.isSafeInteger(pages) || pages <= 0 || hash(await captureRasterFile(pdf, budget)) !== sha256) throw Error('render-output-invalid');
        result.pdf = { sha256, bytes: data.length, pages }; result.total_pages = pages;
        phase = 'delivery'; await job.onPdf?.({ ...result.pdf, data: Buffer.from(data) }); phase = 'capture'; check();
        result.native_stop = nativeStop({ ...result.native_stop, output: 'kept' }); result.state = 'passed';
      } else if (usesPdf && response.status === 'passed') {
        const data = await captureRasterFile(pdf, budget); manifest.set(pdf, hash(data));
        result.native_stop = nativeStop({ ...result.native_stop, output: 'kept' });
        const raster = this.ports.pdf ?? new WindowsPdfRasterizer({ memoryBudget: () => budget, decode, retainStage: this.retain });
        let deliveryFailed = false;
        const rendered = await raster.rasterize(data, signal, current, async page => {
          check(); result.pages.push({ page: page.page, bytes: page.bytes, sha256: page.sha256, width: page.width, height: page.height });
          try { await job.onPage(page); } catch (error) { deliveryFailed = true; throw error; } check();
        }, job.renderer === 'libreoffice' && job.kind === 'pptx' && job.source_slide_count !== undefined
          ? count => count === job.source_slide_count : undefined);
        if (rendered.source_sha256 !== hash(data) || rendered.pages.length !== result.pages.length
          || rendered.state === 'passed' && (!rendered.total_pages || rendered.total_pages !== result.pages.length)) throw Error('render-output-invalid');
        if (rendered.staging_cleanup === 'not-removed') result.staging_cleanup = 'not-removed';
        result.helper_stop = rendered.helper_stop;
        result.total_pages = rendered.total_pages; result.state = rendered.state; result.error = deliveryFailed ? 'render-delivery-failed' : rendered.error;
      } else if (!deliverPdf && job.kind === 'pptx' && job.renderer !== 'libreoffice') {
        result.total_pages = response.page_count;
        for (let page = 1; page <= response.completed_pages; page++) {
          check(); const file = join(output, 'page-' + page + '.png'); const data = await captureRasterFile(file, budget); const image = await decode(data, budget); check();
          if (image.sha256 !== hash(data) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) throw Error('render-output-invalid');
          manifest.set(file, image.sha256); const fact = { page, bytes: data.length, sha256: image.sha256, width: image.width, height: image.height };
          result.pages.push(fact); result.native_stop = nativeStop({ ...result.native_stop, output: 'kept' });
          phase = 'delivery'; await job.onPage({ ...fact, data: Buffer.from(data) }); phase = 'capture'; check();
        }
        result.state = response.status === 'passed' && response.page_count > 0 && response.completed_pages === response.page_count ? 'passed' : result.pages.length ? 'partial' : 'failed';
        if (result.state !== 'passed') result.error = 'native-export-incomplete';
      } else result.error = 'native-export-failed';
      if (job.renderer === 'libreoffice' && copy && (copy.fact.native_charts ?? 0) > 0) {
        result.chart_display = { state: 'not-verified', charts: copy.fact.native_charts!,
          reason: 'The verified passive copy permits LibreOffice native chart rendering. Inspect the captured chart regions; successful export is not independent visual verification.' };
      }
      check(); return result;
    } catch (error) {
      if (phase === 'authorization' && error && typeof error === 'object' && 'officeRenderGateOutcome' in error) throw error;
      const stopped = !current(); result.state = stopped ? result.application_export === 'unknown' && !native?.end ? 'outcome-unknown' : 'cancelled' : result.pages.length ? 'partial' : 'failed';
      result.error = stopped ? 'cancelled' : error instanceof Error && /^(?:render|renderer|native|raster)-[a-z-]+$/.test(error.message) ? error.message : 'render-' + phase + '-failed';
      return result;
    } finally {
      if (stage) {
        let removed = false;
        if (handedOff) { /* The closing helper's background task releases the stage after the helper ends. */ }
        else if (native) {
          // The helper ended (or never started): its own answer, else its receipt, decides whether the stage is released.
          try { removed = await this.stages.release(native.token, { files: manifest, directories: native.directories, ...(native.end ? { exit: native.end.exit } : {}) }); } catch { removed = false; }
          if (result.native_stop) result.native_stop = nativeStop({ ...result.native_stop, staging: removed ? 'removed' : 'kept-until-app-ends' });
        } else if (cleanupAllowed && lease) {
          removed = await this.stages.complete(lease, manifest, ['tmp', 'helper-home', 'native']);
        }
        if (!removed) result.staging_cleanup = 'not-removed';
        if (!removed && !handedOff) this.retain(stage);
      }
    }
  }
}
