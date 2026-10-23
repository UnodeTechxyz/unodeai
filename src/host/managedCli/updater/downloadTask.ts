/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one managed Codex download task (v0.9.97)
 *  A task takes one installable policy entry to a promoted version folder that is `verified`: downloaded and checked,
 *  and not launchable. Nothing it downloads runs: the user's click for that version, and the check that follows it,
 *  come later and elsewhere. The only process a task starts is Windows PowerShell, which reads the publisher
 *  signatures; reading a signature starts nothing from the file.
 *
 *  The task keeps what it was decided on: the enrolled instance's store id, the enrolment epoch, the scheduler epoch
 *  and its kind. Every 5 seconds and between its steps it checks that this still holds: managed Codex is not
 *  suspended, control is readable with authority `ok`, it still names the same instance (a Reset followed by a new
 *  enrolment has new epochs that may equal the old ones, so only the store id tells the two apart), the enrolment
 *  epoch is the same, the entry is still installable, no folder an agent may write reaches the store, and the window
 *  is still trusted, bound and running. An
 *  automatic task also needs the same scheduler epoch and automatic mode on; a manual task (the user's Update now)
 *  continues when automatic mode is turned off, and stops when a host is removed or the enrolment ends. Choosing
 *  External does not stop a download: it decides what new sessions use.
 *
 *  Its steps:
 *  1. Under the instance's admission gate, the task checks control again and creates a `download` lease on the
 *     version key, and releases the gate at once. No gate is held during network or hashing work.
 *  2. The 3 GiB limit of the instance, staging included: a download that would go beyond it is refused as store full.
 *  3. An advisory intent in the instance record: a live (or unknown) owner downloading the same key in another window
 *     makes this task skip; a dead owner's, or one older than the 10-minute task limit, does not. Two tasks of one key
 *     are harmless: each works in its own staging folder, and promotion keeps the first.
 *  4. Its own staging folder, then V1 the artifact (the entry's URLs in order, exact size and SHA-256, five minutes in
 *     all), V2 the archive extracted against the entry's layout (every file's SHA-256), V3 every file that starts with
 *     `MZ` is listed as a PE file and every PE file starts with `MZ`, V4 every PE file's signature against its signer.
 *     V4 is told that a file's bytes match their pin only because V2 has just compared them.
 *  5. Promotion of the payload with what V1–V4 proved. The version is `verified`; the task gives it no activation
 *     consent, no probe result and no role.
 *  Whatever the outcome, the task stops what it started, removes its own staging folder, removes its own intent, records
 *  the outcome in the schedule and releases its lease. Nothing left in a staging folder is ever promoted or started
 *  later: a new task downloads again.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { cliStoreVersionKey, type PolicyEntry, type PolicyLayout, type ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import { terminateChildProcessTree, type ProcessTerminationOutcome } from '../../../backend/processTree';
import {
  boundedDownload,
  type BoundedDownloadDeps,
  type BoundedDownloadRequest,
  type BoundedDownloadResult,
  type DownloadFailureClass,
  type DownloadFetch,
  type DownloadTimers,
} from '../../cliDelivery/boundedDownload';
import { extractTarGz, type TarExtractRequest, type TarExtractResult } from '../../cliDelivery/tarReader';
import {
  checkAuthenticodeSignatures,
  type AuthenticodeCheckDeps,
  type AuthenticodeCheckRequest,
  type AuthenticodeCheckResult,
  type AuthenticodeFile,
} from '../../windowsAuthenticode';
import type { WindowsPowerShellDeps } from '../../windowsPowerShell';
import type {
  ControlSnapshot,
  ControlStoreApi,
  InstanceContent,
  InstanceRecord,
  InstanceRef,
  InstanceStoreApi,
  Lease,
  Liveness,
  ProcessIdentity,
  PromotedVersion,
  Promotion,
  ScheduleFailureClass,
  StagingFolder,
  StoreId,
  VersionKey,
} from '../contracts';
import { cliStoreReachableFrom, newStoreToken } from '../storeLayout';
import { installableEntries, type UpdaterHost } from './installable';
import { recordAttempt, recordFailure, recordSuccess, type UpdateSchedule } from './schedule';

export const DOWNLOAD_TASK_LIMITS = Object.freeze({
  /** How often a running task checks what it was decided on, besides between its steps. */
  recheckMs: 5_000,
  /** The whole task; another window takes an intent older than this for a dead task's. */
  taskMs: 10 * 60_000,
  /** One instance's version folders and staging together. */
  storeCapBytes: 3 * 1024 * 1024 * 1024,
});

export type DownloadTaskKind = 'automatic' | 'manual';

/** What a task was decided on. The store id is part of it always. */
export interface DownloadTaskSnapshot {
  readonly storeId: StoreId;
  readonly enrollmentEpoch: number;
  readonly schedulerEpoch: number;
  readonly kind: DownloadTaskKind;
}

export type DownloadTaskPhase = 'admission' | 'cap' | 'intent' | 'staging' | 'V1' | 'V2' | 'V3' | 'V4' | 'promote';

export interface DownloadTaskInput {
  kind: DownloadTaskKind;
  /** The control generation the task was decided on. */
  decidedOn: ControlSnapshot;
  /** The installable entry the target lookup chose. */
  entry: PolicyEntry;
  policy: ValidatedCliCompatibilityPolicy;
  host: UpdaterHost;
  /** The instance control names as enrolled in `decidedOn`. */
  instance: InstanceRef;
  control: ControlStoreApi;
  instances: InstanceStoreApi;
}

export interface DownloadTaskDeps {
  /** The download's fetch; it is given only the entry's URLs and redirects. */
  fetch: DownloadFetch;
  /** Timers for the download, the 5-second check and the task limit. */
  timers?: DownloadTimers;
  /** The time written into records; `Date.now` by default. */
  now?: () => number;
  /** This extension host's own process identity, as far as it is known yet. */
  hostIdentity: () => ProcessIdentity;
  /** Whether another window's task is still running; `unknown` counts as alive. */
  ownerLiveness: (owner: ProcessIdentity) => Promise<Liveness>;
  /** Shutdown, and anything else that ends the window's tasks. */
  signal: AbortSignal;
  /** The window is still trusted, bound to its workspace and not shutting down. */
  stillAllowed: () => boolean;
  /**
   * Every folder an agent may write now (workspace folders, worktrees, Folder Access grants). A store that one of them
   * can reach could carry forged files, so no download or promotion happens in it.
   */
  writeRoots: () => readonly string[];
  /** For the Windows PowerShell run of the signature check. */
  authenticode?: AuthenticodeCheckDeps;
  /** Stops a PowerShell run the task started, observing the stop; `terminateChildProcessTree` by default. */
  stopTree?: (child: ChildProcess) => Promise<ProcessTerminationOutcome>;
  workspaceRoots?: readonly string[];
  worktreeRoots?: readonly string[];
  newToken?: () => string;
  /** The three verifying steps; the defaults are `boundedDownload`, `extractTarGz` and the Authenticode check. */
  download?: (request: BoundedDownloadRequest, deps: BoundedDownloadDeps) => Promise<BoundedDownloadResult>;
  extract?: (request: TarExtractRequest) => Promise<TarExtractResult>;
  checkSignatures?: (request: AuthenticodeCheckRequest, deps: AuthenticodeCheckDeps) => Promise<AuthenticodeCheckResult>;
  onPhase?: (phase: DownloadTaskPhase) => void;
  onProgress?: (receivedBytes: number, size: number) => void;
}

/**
 * Why a task did not start: nothing was sent over the network.
 * - `not-allowed`: what it was decided on no longer holds, or never named this instance.
 * - `gate-closed`: the instance's admission gate is closed (a Reset is under way) or cannot be read.
 * - `lease-failed`: the lease could not be created.
 */
export type DownloadTaskRefusal = 'not-allowed' | 'gate-closed' | 'lease-failed';

export type DownloadTaskOutcome =
  /** Promoted by this task, or found promoted with the same artifact digest (`alreadyPromoted`). */
  | { outcome: 'verified'; alreadyPromoted: boolean; facts?: PromotedVersion }
  /** A live or unknown task of another window is downloading the same key. */
  | { outcome: 'skipped'; reason: 'another-window' }
  | { outcome: 'refused'; reason: DownloadTaskRefusal; detail: string }
  /** What the task was decided on stopped holding, or the window stopped it. Not a failure of the version. */
  | { outcome: 'aborted'; phase: DownloadTaskPhase; detail: string }
  | { outcome: 'failed'; phase: DownloadTaskPhase; failure: ScheduleFailureClass; detail: string };

export type DownloadTaskResult = DownloadTaskOutcome & {
  key: VersionKey;
  snapshot?: DownloadTaskSnapshot;
  /** How each PowerShell run the task had to stop ended. */
  treeStops: ProcessTerminationOutcome[];
};

type Ended = DownloadTaskOutcome;

/** Thrown inside the task to end it with a result. */
class TaskEnd {
  constructor(readonly result: Ended) {}
}

/** The download's failure as the schedule counts it. */
export function downloadFailureClass(failure: Exclude<DownloadFailureClass, 'cancelled'>): ScheduleFailureClass {
  switch (failure) {
    case 'network':
    case 'http':
      return 'network';
    case 'timeout':
      return 'timeout';
    case 'refused-url':
      return 'host-not-allowed';
    case 'file':
      return 'file';
    case 'size':
    case 'integrity':
      return 'integrity';
  }
}

/** The snapshot of `decidedOn`, or why it cannot be one for this instance. */
export function downloadTaskSnapshot(decidedOn: ControlSnapshot, kind: DownloadTaskKind, instance: InstanceRef): DownloadTaskSnapshot | string {
  const record = decidedOn.record;
  if (record.enrolledStoreId === null || record.enrollment === null) return 'control names no enrolled instance';
  if (record.enrolledStoreId !== instance.storeId) return 'control names another instance';
  return Object.freeze({ storeId: record.enrolledStoreId, enrollmentEpoch: record.enrollment.epoch, schedulerEpoch: record.scheduler.epoch, kind });
}

/**
 * The files V4 checks: every file the entry lists as a PE file, at its payload path. A file is said to match its
 * pinned digest only when V2 has verified that very file.
 */
export function signatureCheckFiles(payload: string, layout: Pick<PolicyLayout, 'files'>, verifiedByV2: ReadonlySet<string>): AuthenticodeFile[] {
  return layout.files
    .filter((file) => file.pe)
    .map((file) => ({
      path: path.join(payload, ...file.path.split('/')),
      signer: file.signer,
      pinnedDigestVerified: verifiedByV2.has(file.path.toLowerCase()),
    }));
}

async function startsWithMz(file: string): Promise<boolean> {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } finally {
    await handle.close();
  }
}

/**
 * V3: the payload holds exactly the files V2 verified, under folders the layout lists, with no link anywhere, and a
 * file starts with `MZ` exactly when the entry lists it as a PE file. Undefined when it holds; otherwise why not.
 */
export async function sniffPortableExecutables(payload: string, layout: Pick<PolicyLayout, 'files' | 'dirs'>, verifiedByV2: ReadonlySet<string>): Promise<string | undefined> {
  const listed = new Map(layout.files.map((file) => [file.path.toLowerCase(), file]));
  const dirs = new Set(layout.dirs.map((dir) => dir.toLowerCase()));
  const seen = new Set<string>();
  const pending: string[] = [''];
  while (pending.length > 0) {
    const relative = pending.pop() as string;
    const folder = relative ? path.join(payload, ...relative.split('/')) : payload;
    for (const name of await fsp.readdir(folder)) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = await fsp.lstat(path.join(folder, name));
      if (stat.isSymbolicLink()) return `${child} is a link`;
      if (stat.isDirectory()) {
        if (!dirs.has(child.toLowerCase())) return `${child} is a folder the layout does not list`;
        pending.push(child);
        continue;
      }
      const row = listed.get(child.toLowerCase());
      if (!stat.isFile() || !row || !verifiedByV2.has(row.path.toLowerCase())) return `${child} is not a file the download verified`;
      seen.add(row.path.toLowerCase());
      const mz = await startsWithMz(path.join(folder, name));
      if (mz && !row.pe) return `${row.path} starts like a program, but the policy lists it as not one`;
      if (!mz && row.pe) return `${row.path} is listed as a program, but does not start like one`;
    }
  }
  const missing = layout.files.find((file) => !seen.has(file.path.toLowerCase()));
  return missing ? `${missing.path} is missing` : undefined;
}

function contentOf(record: InstanceRecord): InstanceContent {
  return { versions: record.versions, probes: record.probes, stagingIntents: record.stagingIntents, schedule: record.schedule };
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function defaultTimers(): DownloadTimers {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Runs one task to its end. Never throws for a network, file, archive or signature problem: the result says which. */
export async function runDownloadTask(input: DownloadTaskInput, deps: DownloadTaskDeps): Promise<DownloadTaskResult> {
  const { entry, policy, host, control, instances } = input;
  const ref = input.instance;
  const key = cliStoreVersionKey(entry);
  const managed = entry.managed;
  const treeStops: ProcessTerminationOutcome[] = [];
  const done = (result: Ended, snapshot?: DownloadTaskSnapshot): DownloadTaskResult =>
    ({ ...result, key, ...(snapshot ? { snapshot } : {}), treeStops } as DownloadTaskResult);
  if (!managed) return done({ outcome: 'refused', reason: 'not-allowed', detail: 'the entry has no managed download' });
  const snapshotOrProblem = downloadTaskSnapshot(input.decidedOn, input.kind, ref);
  if (typeof snapshotOrProblem === 'string') return done({ outcome: 'refused', reason: 'not-allowed', detail: snapshotOrProblem });
  const snapshot = snapshotOrProblem;

  const timers = deps.timers ?? defaultTimers();
  const now = deps.now ?? (() => Date.now());
  const taskToken = (deps.newToken ?? newStoreToken)();
  const owner = deps.hostIdentity();

  // One controller ends everything the task started: the fetch, the extraction and the PowerShell run.
  const task = new AbortController();
  let abortDetail: string | undefined;
  let timedOut = false;
  const abortWith = (detail: string): void => {
    abortDetail ??= detail;
    task.abort();
  };
  const onOuterAbort = (): void => abortWith('the window stopped the task');
  if (deps.signal.aborted) onOuterAbort();
  else deps.signal.addEventListener('abort', onOuterAbort, { once: true });

  /** What the task was decided on, checked again: undefined while it holds, otherwise why not. */
  const recheck = (): string | undefined => {
    if (task.signal.aborted) return abortDetail ?? 'the task was stopped';
    try {
      if (!deps.stillAllowed()) return 'the window is no longer trusted, bound or running';
      if (cliStoreReachableFrom(ref.root, deps.writeRoots())) return 'a folder an agent may write reaches the managed Codex store';
      const suspension = control.readSuspension();
      if (suspension.present !== false) return 'managed Codex is suspended';
      const view = control.read();
      if (view.kind !== 'readable') return 'the managed Codex record cannot be used';
      if (view.authority !== 'ok') return 'a change to managed Codex could not be confirmed';
      const record = view.snapshot.record;
      if (record.enrolledStoreId !== snapshot.storeId) return 'managed Codex was reset or set up again';
      if (record.enrollment === null || record.enrollment.epoch !== snapshot.enrollmentEpoch) return 'the managed Codex enrolment changed';
      if (snapshot.kind === 'automatic' && (record.scheduler.epoch !== snapshot.schedulerEpoch || !record.scheduler.autoMode)) {
        return 'automatic updates were turned off';
      }
      const still = installableEntries(policy, host, { control: view, suspension }).installable
        .some((candidate) => candidate.id === entry.id && candidate.managed?.artifact.sha256 === managed.artifact.sha256);
      if (!still) return 'the version is no longer one UnodeAi may download';
      return undefined;
    } catch (error) {
      return `the managed Codex record could not be read (${errorText(error)})`;
    }
  };

  let phase: DownloadTaskPhase = 'admission';
  /** A step boundary: what the task was decided on must still hold. */
  const enter = (next: DownloadTaskPhase): void => {
    phase = next;
    try { deps.onPhase?.(next); } catch { /* a recorder never changes the task */ }
    const problem = recheck();
    if (problem) {
      abortWith(problem);
      throw new TaskEnd({ outcome: 'aborted', phase, detail: problem });
    }
  };
  const failed = (failure: ScheduleFailureClass, detail: string): TaskEnd => new TaskEnd({ outcome: 'failed', phase, failure, detail });
  /** A step that ended early: the task's own stop wins over the step's report of it. */
  const endedBy = (failure: ScheduleFailureClass, detail: string): TaskEnd => {
    if (timedOut) return failed('timeout', `the task took longer than ${DOWNLOAD_TASK_LIMITS.taskMs / 60_000} minutes`);
    if (task.signal.aborted) return new TaskEnd({ outcome: 'aborted', phase, detail: abortDetail ?? 'the task was stopped' });
    return failed(failure, detail);
  };

  let recheckTimer: unknown;
  const armRecheck = (): void => {
    recheckTimer = timers.setTimeout(() => {
      const problem = recheck();
      if (problem) abortWith(problem);
      else if (!task.signal.aborted) armRecheck();
    }, DOWNLOAD_TASK_LIMITS.recheckMs);
  };
  const taskTimer = timers.setTimeout(() => {
    timedOut = true;
    abortWith('the task took too long');
  }, DOWNLOAD_TASK_LIMITS.taskMs);

  // The only process a task starts. Once the task is stopping, nothing new starts, and a run that started is stopped.
  const running = new Set<ChildProcess>();
  const stops: Array<Promise<void>> = [];
  const stopTree = deps.stopTree ?? ((child: ChildProcess) => terminateChildProcessTree(child));
  const stopChild = (child: ChildProcess): void => {
    stops.push(stopTree(child).then(
      (outcome) => { treeStops.push(outcome); },
      (error) => { treeStops.push({ status: 'unknown', detail: `the stop failed (${errorText(error)})` }); },
    ));
  };
  const onTaskAbort = (): void => { for (const child of running) stopChild(child); };
  task.signal.addEventListener('abort', onTaskAbort, { once: true });
  const baseSpawn = (deps.authenticode?.spawn ?? nodeSpawn) as NonNullable<WindowsPowerShellDeps['spawn']>;
  const authenticodeDeps: AuthenticodeCheckDeps = {
    ...deps.authenticode,
    spawn: (command, args, options) => {
      if (task.signal.aborted) throw new Error('the task is stopping, so nothing new is started');
      const child = baseSpawn(command, args, options);
      running.add(child);
      child.once('close', () => running.delete(child));
      return child;
    },
  };

  let lease: Lease | undefined;
  let staging: StagingFolder | undefined;
  let intentPublished = false;
  let result: Ended;
  try {
    result = await (async (): Promise<Ended> => {
      try {
        // 1. Nothing starts unless what the task was decided on holds now. Then the lease, under the gate; the gate
        // is released before anything else happens.
        try { deps.onPhase?.('admission'); } catch { /* a recorder never changes the task */ }
        const initial = recheck();
        if (initial) return { outcome: 'refused', reason: 'not-allowed', detail: initial };
        const gate = instances.acquireAdmission(ref);
        if (!gate.ok) return { outcome: 'refused', reason: 'gate-closed', detail: gate.detail };
        try {
          if (gate.handle.storeId !== snapshot.storeId) return { outcome: 'refused', reason: 'gate-closed', detail: 'the admission gate belongs to another instance' };
          const problem = recheck();
          if (problem) return { outcome: 'refused', reason: 'not-allowed', detail: problem };
          try {
            lease = instances.createLease(ref, key, 'download', owner);
          } catch (error) {
            return { outcome: 'refused', reason: 'lease-failed', detail: errorText(error) };
          }
        } finally {
          gate.handle.release();
        }
        armRecheck();

        const current = instances.read(ref);
        if (current.kind !== 'readable') throw failed('file', `the instance record cannot be read (${current.reason})`);
        const versions = current.snapshot.record.versions;
        const promoted = Object.hasOwn(versions, key) ? versions[key] : undefined;
        if (promoted && promoted.artifactSha256 === managed.artifact.sha256) return { outcome: 'verified', alreadyPromoted: true };

        // 2. The store limit.
        enter('cap');
        let usage: number;
        try {
          usage = await instances.usageBytes(ref);
        } catch (error) {
          throw failed('file', `the store size could not be read (${errorText(error)})`);
        }
        const needed = managed.artifact.size + managed.layout.unpackedBytes;
        if (!Number.isFinite(usage) || usage + needed > DOWNLOAD_TASK_LIMITS.storeCapBytes) {
          throw failed('store-full', `the managed Codex store would hold more than ${DOWNLOAD_TASK_LIMITS.storeCapBytes / 1024 ** 3} GiB`);
        }

        // 3. The advisory intent.
        enter('intent');
        const others = Object.entries(current.snapshot.record.stagingIntents)
          .filter(([token, intent]) => token !== taskToken && intent.key === key);
        const dismissed = new Set<string>();
        for (const [token, intent] of others) {
          const startedAt = Date.parse(intent.startedAt);
          if (Number.isFinite(startedAt) && now() - startedAt > DOWNLOAD_TASK_LIMITS.taskMs) {
            dismissed.add(token);
            continue;
          }
          let liveness: Liveness = 'unknown';
          try { liveness = await deps.ownerLiveness(intent.owner); } catch { /* unknown counts as alive */ }
          if (liveness === 'dead') dismissed.add(token);
        }
        const startedAt = now();
        const published = await instances.publish(ref, {
          label: 'download intent',
          apply: (record) => {
            for (const [token, intent] of Object.entries(record.stagingIntents)) {
              if (token !== taskToken && intent.key === key && !dismissed.has(token)) return { refused: 'another-window' };
            }
            return {
              ...contentOf(record),
              stagingIntents: { ...record.stagingIntents, [taskToken]: { key, owner, startedAt: new Date(startedAt).toISOString() } },
              schedule: recordAttempt(record.schedule, startedAt),
            };
          },
        });
        if (published.outcome === 'refused' && published.reason === 'another-window') return { outcome: 'skipped', reason: 'another-window' };
        if (published.outcome === 'busy') return { outcome: 'aborted', phase, detail: 'other windows kept changing the instance record' };
        if (published.outcome !== 'published') throw failed('file', `the download intent could not be recorded (${published.outcome})`);
        intentPublished = true;

        // 4. Its own staging, then V1–V4.
        enter('staging');
        let folder: StagingFolder;
        try {
          folder = instances.createStaging(ref, taskToken);
        } catch (error) {
          throw failed('file', `the staging folder could not be created (${errorText(error)})`);
        }
        staging = folder;

        enter('V1');
        const download = await (deps.download ?? boundedDownload)({
          urls: managed.artifact.urls,
          redirectHosts: managed.artifact.redirectHosts,
          size: managed.artifact.size,
          sha256: managed.artifact.sha256,
          targetPath: folder.artifact,
          signal: task.signal,
          shouldContinue: () => {
            const problem = recheck();
            if (problem) abortWith(problem);
            return problem === undefined;
          },
          onProgress: deps.onProgress,
        }, { fetch: deps.fetch, timers });
        if (!download.ok) {
          if (download.failure === 'cancelled') throw endedBy('network', download.reason);
          throw endedBy(downloadFailureClass(download.failure), download.reason);
        }

        enter('V2');
        const extracted = await (deps.extract ?? extractTarGz)({
          archivePath: folder.artifact,
          payloadDir: folder.payload,
          layout: managed.layout,
          signal: task.signal,
        });
        if (!extracted.ok) {
          const detail = `${extracted.detail}${extracted.entry ? ` (${extracted.entry})` : ''}`;
          if (extracted.failure === 'cancelled') throw endedBy('file', detail);
          throw endedBy(extracted.failure === 'file' ? 'file' : 'integrity', detail);
        }
        const verifiedByV2 = new Set(extracted.written.map((written) => written.toLowerCase()));

        enter('V3');
        let sniffed: string | undefined;
        try {
          sniffed = await sniffPortableExecutables(folder.payload, managed.layout, verifiedByV2);
        } catch (error) {
          throw endedBy('file', `the payload could not be read (${errorText(error)})`);
        }
        if (sniffed) throw failed('integrity', sniffed);

        enter('V4');
        const files = signatureCheckFiles(folder.payload, managed.layout, verifiedByV2);
        let signatures: AuthenticodeCheckResult;
        try {
          signatures = await (deps.checkSignatures ?? checkAuthenticodeSignatures)({
            files,
            signers: policy.signers,
            ownedFolder: folder.root,
            ownedTmp: folder.root,
            workspaceRoots: deps.workspaceRoots ?? [],
            worktreeRoots: deps.worktreeRoots ?? [],
          }, authenticodeDeps);
        } catch (error) {
          throw endedBy('signature-unavailable', `the signature check could not run (${errorText(error)})`);
        }
        if (task.signal.aborted) throw endedBy('signature-unavailable', 'the signature check was stopped');
        if (signatures.status !== 'checked') throw failed('signature-unavailable', `${signatures.message}${signatures.diagnostic ? `: ${signatures.diagnostic}` : ''}`);
        if (!signatures.accepted || signatures.files.length !== files.length || signatures.files.some((verdict) => !verdict.accepted)) {
          const rejected = signatures.files.find((verdict) => !verdict.accepted);
          const reason = rejected && !rejected.accepted ? `${path.basename(rejected.path)}: ${rejected.reason}` : 'not every file was checked';
          throw failed('signature', signatures.revoked ? `a certificate is revoked (${reason})` : reason);
        }
        const layoutPathOf = new Map(managed.layout.files.map((file) => [path.join(folder.payload, ...file.path.split('/')), file.path]));
        const facts: PromotedVersion = {
          key,
          provider: 'codex-cli',
          version: entry.version,
          os: 'win32',
          arch: 'x64',
          policyVersion: policy.policyVersion,
          policyEntryId: entry.id,
          artifactSha256: managed.artifact.sha256,
          taskToken,
          promotedAt: new Date(now()).toISOString(),
          verification: {
            files: managed.layout.files.length,
            bytes: managed.layout.files.reduce((sum, file) => sum + file.size, 0),
            signed: { openai: signatures.counts.openai, microsoftCrt: signatures.counts['microsoft-crt'] },
            unsigned: signatures.unsignedFiles.map((file) => layoutPathOf.get(file) ?? file),
            // A package with no signed file has no revocation to confirm; it is never shown as confirmed.
            revocation: signatures.revocation === 'confirmed-online' ? 'confirmed-online' : 'not-confirmed-offline',
          },
        };

        // 5. Promotion, only while what the task was decided on still holds.
        enter('promote');
        let promotion: Promotion;
        try {
          promotion = await instances.promote(ref, folder, facts);
        } catch (error) {
          throw failed('file', `the version could not be promoted (${errorText(error)})`);
        }
        if (!promotion.ok) throw failed(promotion.reason === 'different-artifact' ? 'integrity' : 'file', promotion.detail);
        return { outcome: 'verified', alreadyPromoted: promotion.alreadyPromoted, ...(promotion.alreadyPromoted ? {} : { facts }) };
      } catch (error) {
        if (error instanceof TaskEnd) return error.result;
        return { outcome: 'failed', phase, failure: 'file', detail: `the task failed (${errorText(error)})` };
      }
    })();
  } finally {
    timers.clearTimeout(taskTimer);
    if (recheckTimer !== undefined) timers.clearTimeout(recheckTimer);
    deps.signal.removeEventListener('abort', onOuterAbort);
  }

  // Every exit: stop what was started, remove the staging folder and the intent, record the outcome, release the lease.
  if (!task.signal.aborted && running.size > 0) for (const child of running) stopChild(child);
  task.signal.removeEventListener('abort', onTaskAbort);
  await Promise.all(stops);
  if (staging) {
    try { await instances.discardStaging(staging); } catch { /* left for the startup reconciliation */ }
  }
  const scheduleChange = ((): ((schedule: UpdateSchedule) => UpdateSchedule) | undefined => {
    if (result.outcome === 'verified') return (schedule) => recordSuccess(schedule, entry.id);
    if (result.outcome === 'failed') {
      const failure = { class: result.failure, entryId: entry.id, at: now(), detail: result.detail };
      return (schedule) => recordFailure(schedule, failure);
    }
    return undefined;
  })();
  if (intentPublished || scheduleChange) {
    try {
      await instances.publish(ref, {
        label: 'download task ended',
        apply: (record) => {
          const intents = { ...record.stagingIntents };
          // Only this task's own intent: the token is its own, and so is the owner.
          const own = intents[taskToken];
          const ownIntent = own !== undefined && own.owner.pid === owner.pid && own.owner.creation === owner.creation;
          if (ownIntent) delete intents[taskToken];
          if (!ownIntent && !scheduleChange) return { moot: true };
          return { ...contentOf(record), stagingIntents: intents, schedule: scheduleChange ? scheduleChange(record.schedule) : record.schedule };
        },
      });
    } catch { /* a stale intent ages out after the task limit */ }
  }
  if (lease) {
    try { instances.releaseLease(lease); } catch { /* a lease of a dead holder is removable by cleanup */ }
  }
  return done(result, snapshot);
}
