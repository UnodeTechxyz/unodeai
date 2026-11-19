/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the one final admission check before a managed Codex check process starts (v0.9.97)
 *  Every start of a downloaded version's program for a check (the check after the user's OK, an automatic check
 *  again, Check again, Try again) passes here. The instance's admission gate is held from before the decision until
 *  the process has spawned, so a Reset cannot slip in between. With the gate held, the suspension file and control are
 *  read afresh; that read is the one point the start is decided at. Whatever is published after it (a suspension, a
 *  change to External, a new prohibition) refuses every later start, while a start already past it may finish.
 *
 *  A refusal starts nothing else: no other version, no last-known-good, no external program.
 *--------------------------------------------------------------------------------------------*/

import type { ManagedFolderCheck, ManagedFolderProblem } from '../../../backend/cliClosure';
import type { PolicyEntry, PolicyLayout, ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import type {
  AdmissionHandle,
  ControlStoreApi,
  DisabledEntry,
  DisabledReason,
  InstanceRef,
  InstanceStoreApi,
  Lease,
  ProcessIdentity,
  VersionKey,
  WorkFolder,
} from '../contracts';
import {
  boundedDetail,
  controlContent,
  disabledFor,
  hasConsent,
  policyForKey,
  sameDisabledEntry,
  type ManagedHost,
} from './keyFacts';

/** What one check run of a version's program reports. `fail` and `pass` come only with a confirmed stop. */
export interface ManagedProbeResult {
  result: 'pass' | 'fail' | 'stop-unconfirmed';
  detail?: string;
  versionOutput?: string;
  durationMs: number;
}

/**
 * Starts the program in the work folder and stops its whole tree. `onSpawned` is called once its last process runs,
 * which is when the admission is released; `entry` is the version's policy entry.
 */
export type RunManagedProbe = (
  executable: string,
  workFolder: WorkFolder,
  hooks: { onSpawned(pid: number): void },
  entry: PolicyEntry,
) => Promise<ManagedProbeResult>;

/** Whether a version folder holds exactly the layout's files; the digest is of what was hashed now. */
export type CheckManagedClosure = (versionFolder: string, layout: PolicyLayout) => Promise<ManagedFolderCheck>;

export interface ManagedStartDeps {
  readonly control: ControlStoreApi;
  readonly instance: InstanceStoreApi;
  readonly policy: ValidatedCliCompatibilityPolicy;
  readonly host: ManagedHost;
  /** This extension host's own process: the holder of the check's lease. */
  readonly hostProcess: ProcessIdentity;
  readonly checkClosure: CheckManagedClosure;
  readonly runManagedProbe: RunManagedProbe;
  /** The current time as an ISO string. */
  readonly now: () => string;
}

/**
 * Why the program starts. `checkAgain` and `tryAgain` are the user's own actions; each may pass exactly one
 * `disabled` entry of the reasons it repairs, and only when that entry is the version's only one.
 */
export type ManagedStartPurpose = 'qualification' | { readonly checkAgain: true } | { readonly tryAgain: true };

/** The reasons each user action may pass. Nothing passes `policy-bad`, `consent-withdrawn` or any other reason. */
export const BYPASSABLE_REASONS: Readonly<Record<'checkAgain' | 'tryAgain', readonly DisabledReason[]>> = Object.freeze({
  checkAgain: Object.freeze(['probe-stop-unconfirmed'] as DisabledReason[]),
  tryAgain: Object.freeze(['local-bad', 'probe-failed'] as DisabledReason[]),
});

export type AdmissionRefusal =
  | 'gate' | 'suspended' | 'control' | 'not-enrolled' | 'external' | 'policy' | 'no-consent' | 'disabled'
  | 'no-version' | 'instance' | 'lease' | 'version-gone' | 'closure-changed' | 'closure-unchecked' | 'purpose';

export interface AdmittedStart {
  readonly ref: InstanceRef;
  readonly key: VersionKey;
  readonly closureDigest: string;
  readonly entry: PolicyEntry;
  /** The `probe` lease, created after the final check. The caller releases it, or keeps it when the stop is unconfirmed. */
  readonly lease: Lease;
  /** The one `disabled` entry the user's action passed, if any. */
  readonly bypassed?: DisabledEntry;
  /** The program file the closure check hashed. */
  readonly executable: string;
  /** Starts the program. The gate is released once the process has spawned, or when the start fails before that. */
  spawn(workFolder: WorkFolder): Promise<ManagedProbeResult>;
  /** Gives up before spawning: releases the gate and deletes the lease. */
  abandon(): void;
}

export type ManagedStartAdmission =
  | { admitted: true; start: AdmittedStart }
  | { admitted: false; reason: AdmissionRefusal; detail: string };

/** Closure-check outcomes that say nothing about the files: the hash itself failed. They refuse without marking. */
const HASH_RUN_FAILURES: ReadonlySet<ManagedFolderProblem> = new Set<ManagedFolderProblem>(['hash-failed', 'hash-timeout']);

/**
 * Decides one managed check start of `key` with the closure `closureDigest`, in this order:
 * 1. the instance's admission gate is acquired (its identity read through the handle);
 * 2. with the gate held, the final check: no suspension (any content, unreadable included); control readable with
 *    authority `ok`; this instance enrolled and the selection `managed`; the policy qualifies the key with this
 *    closure; the user's click for exactly `(storeId, key, closureDigest)`; no `disabled` entry for the key except the
 *    one the purpose may pass; the key's facts in the instance;
 * 3. the `probe` lease, the facts read again, and the closure check: files that differ from the click's closure
 *    record `local-bad` and refuse.
 * Any refusal releases the gate and deletes the lease.
 */
export async function admitManagedStart(
  deps: ManagedStartDeps,
  ref: InstanceRef,
  key: VersionKey,
  closureDigest: string,
  purpose: ManagedStartPurpose,
): Promise<ManagedStartAdmission> {
  const action = purposeAction(purpose);
  if (action === undefined) return { admitted: false, reason: 'purpose', detail: 'UnodeAi did not recognise why this check was started.' };

  const acquired = deps.instance.acquireAdmission(ref);
  if (!acquired.ok) return { admitted: false, reason: 'gate', detail: boundedDetail(acquired.detail) };
  const gate = acquired.handle;
  let lease: Lease | undefined;
  const refuse = (reason: AdmissionRefusal, detail: string): ManagedStartAdmission => {
    if (lease) {
      try { deps.instance.releaseLease(lease); } catch { /* an unreadable lease counts as alive; the collector keeps the folder */ }
      lease = undefined;
    }
    gate.release();
    return { admitted: false, reason, detail: boundedDetail(detail) };
  };

  try {
    if (gate.storeId !== ref.storeId) return refuse('gate', 'The managed Codex store folder belongs to another setup.');

    // The final check. Everything here is read afresh while the gate is held.
    const suspension = deps.control.readSuspension();
    if (suspension.present) return refuse('suspended', 'Managed Codex is paused in every window.');
    const view = deps.control.read();
    if (view.kind !== 'readable' || view.authority !== 'ok') {
      return refuse('control', view.kind === 'unusable' ? view.detail : view.kind === 'fresh' ? 'Managed Codex is not set up.' : 'UnodeAi could not confirm your last change to managed Codex.');
    }
    const record = view.snapshot.record;
    if (record.enrolledStoreId !== ref.storeId) return refuse('not-enrolled', 'This managed Codex setup is no longer the current one.');
    if (record.selection !== 'managed') return refuse('external', 'New sessions use the external Codex CLI, so no managed Codex program starts.');
    const keyPolicy = policyForKey(deps.policy, key, deps.host);
    if (keyPolicy.kind !== 'qualified') return refuse('policy', keyPolicy.kind === 'bad' ? `This UnodeAi marks this version not to be used (${keyPolicy.reason}).` : keyPolicy.detail);
    if (keyPolicy.closureDigest !== closureDigest) return refuse('policy', 'This UnodeAi describes other files for this version than the ones that were allowed.');
    if (!hasConsent(record, ref.storeId, key, closureDigest)) return refuse('no-consent', 'This version has not been allowed to run.');
    const passed = admittedDisabled(disabledFor(record, ref.storeId, key), action);
    if (!passed.ok) return refuse('disabled', passed.detail);
    const before = deps.instance.read(ref);
    if (before.kind !== 'readable') return refuse('instance', before.detail);
    const artifactSha256 = keyPolicy.entry.managed?.artifact.sha256;
    const facts = before.snapshot.record.versions[key];
    if (!facts || facts.artifactSha256 !== artifactSha256) return refuse('no-version', 'This version is not recorded as downloaded and checked.');

    // After the final check: the lease, then the facts again (a racing collection unpublishes them first), then the files.
    try {
      lease = deps.instance.createLease(ref, key, 'probe', deps.hostProcess);
    } catch (error) {
      return refuse('lease', `UnodeAi could not record that the check uses this version (${errorText(error)}).`);
    }
    const after = deps.instance.read(ref);
    if (after.kind !== 'readable' || after.snapshot.record.versions[key]?.artifactSha256 !== artifactSha256) {
      return refuse('version-gone', 'This version was removed while its check was starting.');
    }
    const check = await deps.checkClosure(deps.instance.versionFolder(ref, key), keyPolicy.layout);
    if (!check.ok && HASH_RUN_FAILURES.has(check.reason)) return refuse('closure-unchecked', check.message);
    if (!check.ok || check.closure.digest !== closureDigest) {
      const changed = check.ok ? 'its files differ from the ones that were allowed' : check.message;
      await recordProhibition(deps, ref, {
        storeId: ref.storeId,
        key,
        closureDigest,
        reason: 'local-bad',
        detail: boundedDetail(`its files changed after they were checked (${changed})`),
        at: deps.now(),
      }, passed.bypassed);
      return refuse('closure-changed', `The files of this version changed after they were checked (${changed}).`);
    }
    return { admitted: true, start: new Admitted(deps, ref, key, closureDigest, keyPolicy.entry, lease, passed.bypassed, check.closure.executable, gate) };
  } catch (error) {
    return refuse('instance', `UnodeAi could not check this version (${errorText(error)}).`);
  }
}

/** The user action a purpose names, or undefined when it names none exactly. */
function purposeAction(purpose: ManagedStartPurpose): 'qualification' | 'checkAgain' | 'tryAgain' | undefined {
  if (purpose === 'qualification') return 'qualification';
  if (!purpose || typeof purpose !== 'object') return undefined;
  const value = purpose as { checkAgain?: unknown; tryAgain?: unknown };
  if (value.checkAgain === true && value.tryAgain === undefined) return 'checkAgain';
  if (value.tryAgain === true && value.checkAgain === undefined) return 'tryAgain';
  return undefined;
}

/**
 * The `disabled` rule: none may name the version, except that the user's Check again passes exactly one entry for
 * an unconfirmed stop, and Try again exactly one for `local-bad` or `probe-failed`, when it is the version's only one.
 */
function admittedDisabled(
  entries: DisabledEntry[],
  action: 'qualification' | 'checkAgain' | 'tryAgain',
): { ok: true; bypassed?: DisabledEntry } | { ok: false; detail: string } {
  if (entries.length === 0) {
    return action === 'qualification' ? { ok: true } : { ok: false, detail: 'This version has nothing to check again or try again.' };
  }
  if (action !== 'qualification' && entries.length === 1 && BYPASSABLE_REASONS[action].includes(entries[0].reason)) {
    return { ok: true, bypassed: entries[0] };
  }
  return { ok: false, detail: 'UnodeAi recorded that this version must not run on this computer.' };
}

/**
 * Publishes a prohibition for one version: the entry is added, replacing the entry the user's action passed and any
 * earlier entry of the same reason for that version. It is a reduction, so it is reported only once its floor
 * record is written. Moot once the instance is no longer enrolled: its entries are inert.
 */
export async function recordProhibition(
  deps: Pick<ManagedStartDeps, 'control' | 'now'>,
  ref: InstanceRef,
  entry: DisabledEntry,
  replacing: DisabledEntry | undefined,
): Promise<boolean> {
  try {
    const result = await deps.control.publish({
      label: `disable-${entry.reason}`,
      kind: 'reduction',
      apply: (current) => {
        if (current.enrolledStoreId !== ref.storeId) return { moot: true };
        const kept = current.disabled.filter((existing) => !(replacing && sameDisabledEntry(existing, replacing))
          && !(existing.storeId === entry.storeId && existing.key === entry.key && existing.reason === entry.reason));
        return { ...controlContent(current), disabled: [...kept, entry], decidedAt: deps.now() };
      },
    });
    return result.outcome === 'published' || result.outcome === 'moot';
  } catch {
    return false;
  }
}

class Admitted implements AdmittedStart {
  private used = false;
  private gateOpen = true;

  constructor(
    private readonly deps: ManagedStartDeps,
    readonly ref: InstanceRef,
    readonly key: VersionKey,
    readonly closureDigest: string,
    readonly entry: PolicyEntry,
    readonly lease: Lease,
    readonly bypassed: DisabledEntry | undefined,
    readonly executable: string,
    private readonly gate: AdmissionHandle,
  ) {}

  async spawn(workFolder: WorkFolder): Promise<ManagedProbeResult> {
    if (this.used) throw new Error('An admitted start is used once.');
    this.used = true;
    try {
      return await this.deps.runManagedProbe(this.executable, workFolder, {
        onSpawned: (pid) => {
          try {
            this.deps.instance.recordLeaseChild(this.lease, { pid, creation: 'pending' });
          } catch {
            // The lease keeps its pending child, which counts as alive.
          } finally {
            this.releaseGate();
          }
        },
      }, this.entry);
    } finally {
      this.releaseGate();
    }
  }

  abandon(): void {
    if (this.used) return;
    this.used = true;
    try { this.deps.instance.releaseLease(this.lease); } catch { /* counts as alive until collected */ }
    this.releaseGate();
  }

  private releaseGate(): void {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.gate.release();
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
