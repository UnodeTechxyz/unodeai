/*---------------------------------------------------------------------------------------------
 *  UnodeAi - starting managed Codex (v0.9.97)
 *  Every start of a managed Codex root process passes one admission, with the instance's admission gate held from
 *  before the decision until the process has started:
 *
 *  1. Open the gate: a read handle on the instance's `admission\open\guard.bin`, its identity read through the handle.
 *  2. With the gate held, read the suspension and control afresh. This is the start's admission point: no suspension,
 *     authority ok, the instance enrolled, **managed Codex selected**, and for a pinned start the pin's instance.
 *     A change published after this point does not reach this start; a change published before it does.
 *  3. Take a lease on the version, read the instance's facts again, and check the version folder's files against the
 *     approved closure. A folder that changed is marked bad and the start is refused.
 *  4. Save the pin (new sessions), start the process, record its pid in the lease, close the gate.
 *
 *  A Reset closes the gate by renaming it, which Windows refuses while a handle is open, so a start either finishes
 *  in the instance it was admitted to or is refused. A refused start never starts anything else: no other version, no
 *  earlier version, no external program.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { closureDigest as digestOfListing, closureListing, verifyManagedVersionFolder, type ClosureHasher } from '../../backend/cliClosure';
import type { PolicyEntry } from '../../backend/cliCompatibilityPolicy';
import type { SessionRuntimePin } from '../cliRuntimePin';
import { PINNED_START_REFUSAL_TEXT } from '../cliRuntimePin';
import type {
  AdmissionHandle,
  ControlRecord,
  ControlStoreApi,
  ControlView,
  InstanceRecord,
  InstanceRef,
  InstanceStoreApi,
  Lease,
  ProcessIdentity,
  VersionKey,
} from './contracts';

export type ManagedLaunchRefusalReason =
  | 'suspended'
  | 'not-enrolled'
  | 'managed-not-selected'
  | 'authority-behind-floor'
  | 'authority-floor-unavailable'
  | 'store-sealed'
  | 'control-unavailable'
  | 'instance-unavailable'
  | 'no-launchable-version'
  | 'managed-store-replaced'
  | 'managed-version-gone'
  | 'identity-changed'
  | 'version-files-changed'
  | 'closure-unchecked'
  | 'store-refused'
  | 'pin-save-failed'
  | 'spawn-failed';

export type ManagedLaunchRefusal = { ok: false; reason: ManagedLaunchRefusalReason; message: string };

/** What the backend starts: the version folder's entrypoint, approved for this exact closure. */
export interface ManagedLaunchPlan {
  storeId: string;
  key: VersionKey;
  closureDigest: string;
  versionFolder: string;
  executable: string;
  entry: PolicyEntry;
}

export type ManagedLaunch =
  | { ok: true; child: ChildProcess; plan: ManagedLaunchPlan; pin: Extract<SessionRuntimePin, { mode: 'managed' }>; lease: Lease; release(): void }
  | ManagedLaunchRefusal;

export interface ManagedLauncherDeps {
  control: ControlStoreApi;
  instances: InstanceStoreApi;
  /** The policy entry a version key was promoted from, when the bundled policy still has it. */
  entryForKey(key: VersionKey): PolicyEntry | undefined;
  /**
   * The version a new session starts: the active one, else the last known good one, when launchable (consented
   * for this closure, its probe passed, nothing disables it, its policy entry qualified for this host).
   */
  launchableKey(record: ControlRecord, instance: InstanceRecord): { key: VersionKey; closureDigest: string } | undefined;
  hasher: ClosureHasher;
  host(): ProcessIdentity;
  /** Why the store must not be used now, for example because a folder an agent may write reaches it. */
  storeRefusal?(): string | undefined;
  /** Settles once `host()` names this process by its creation time; every launch waits for it. */
  ready?: Promise<void>;
  /** The operating system's creation time of a started child, asked in the background; never on the start path. */
  queryCreation?(pid: number): Promise<string | undefined>;
  now?: () => Date;
}

export type ManagedLaunchRequest = (
  | { kind: 'new'; savePin(pin: Extract<SessionRuntimePin, { mode: 'managed' }>): Promise<void> }
  | { kind: 'pinned'; pin: Extract<SessionRuntimePin, { mode: 'managed' }> }
  /** A short start that belongs to no session, such as loading the model list: like a new session, without a pin. */
  | { kind: 'transient' }
) & {
  /**
   * Called with the program the start will run, before the admission and before anything of it runs: the egress
   * consent. It may wait for the person, so no gate is held during it. A rejection starts nothing.
   */
  beforeAdmission?(executable: string): Promise<void>;
};

const AUTHORITY_TEXT = {
  'authority-behind-floor': 'UnodeAi could not confirm your last change to managed Codex after an unexpected shutdown. New managed Codex sessions are paused until you choose.',
  'authority-floor-unavailable': 'UnodeAi cannot read the record that protects your changes to managed Codex. Managed Codex is paused.',
  'store-sealed': 'Managed Codex has recorded the most changes it can hold. Use the external CLI.',
  'control-unavailable': 'UnodeAi cannot read its record of managed Codex. Managed Codex is paused.',
} as const;

function refuse(reason: ManagedLaunchRefusalReason, message: string): ManagedLaunchRefusal {
  return { ok: false, reason, message };
}

/** Why the current control and suspension do not allow a managed start, or undefined when they do. */
function authorityRefusal(control: ControlView, suspended: boolean): ManagedLaunchRefusal | undefined {
  if (suspended) return refuse('suspended', 'Managed Codex is paused in every window. New sessions use the external CLI.');
  if (control.kind === 'fresh') return refuse('not-enrolled', 'Managed Codex is not set up.');
  if (control.kind === 'unusable') {
    if (control.reason === 'floor-unavailable') return refuse('authority-floor-unavailable', AUTHORITY_TEXT['authority-floor-unavailable']);
    if (control.reason === 'sealed') return refuse('store-sealed', AUTHORITY_TEXT['store-sealed']);
    return refuse('control-unavailable', AUTHORITY_TEXT['control-unavailable']);
  }
  if (control.authority === 'behind-floor') return refuse('authority-behind-floor', AUTHORITY_TEXT['authority-behind-floor']);
  return undefined;
}

export class ManagedLauncher {
  private readonly now: () => Date;

  constructor(private readonly deps: ManagedLauncherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Starts managed Codex for a new session (`kind: 'new'`) or for a session's pin (`kind: 'pinned'`). `spawn` starts
   * the root process from the plan's executable; it is called at most once, with the gate held, and every program it
   * starts from the version folder before it returns is admitted by this one admission.
   */
  async launch(request: ManagedLaunchRequest, spawn: (plan: ManagedLaunchPlan) => ChildProcess | Promise<ChildProcess>): Promise<ManagedLaunch> {
    await this.deps.ready;
    const before = this.check(request, this.deps.control.read(), this.deps.control.readSuspension().present);
    if (!before.ok) return before;
    const open = this.deps.instances.open(before.storeId);
    if (!open.ok) {
      return request.kind === 'pinned'
        ? refuse('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced'])
        : refuse('instance-unavailable', `UnodeAi cannot open managed Codex's folder (${open.detail}).`);
    }
    const ref = open.ref;
    // The program this start expects to run, for the consent that may wait for the person. The admission below
    // decides again, and a different outcome refuses instead of running what was not consented.
    let expectedKey: VersionKey | undefined;
    if (request.beforeAdmission) {
      const view = this.deps.instances.read(ref);
      if (view.kind !== 'readable') return refuse('instance-unavailable', `UnodeAi cannot read managed Codex's record of its versions (${view.detail}).`);
      const candidate = this.choose(request, before.record, view.snapshot.record);
      if (!candidate.ok) return candidate;
      const entry = this.deps.entryForKey(candidate.key);
      if (!entry?.managed) return this.versionGone(request);
      expectedKey = candidate.key;
      await request.beforeAdmission(managedEntrypoint(this.deps.instances.versionFolder(ref, candidate.key), entry.managed.layout.entrypoint));
    }
    const gate = this.deps.instances.acquireAdmission(ref);
    if (!gate.ok) {
      return request.kind === 'pinned'
        ? refuse('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced'])
        : refuse('instance-unavailable', 'Managed Codex is being reset. New sessions use the external CLI.');
    }
    const handle = gate.handle;
    let lease: Lease | undefined;
    try {
      // The admission point: what was published before this read decides this start.
      const admitted = this.check(request, this.deps.control.read(), this.deps.control.readSuspension().present);
      if (!admitted.ok) return admitted;
      if (admitted.storeId !== ref.storeId) return refuse('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced']);
      const view = this.deps.instances.read(ref);
      if (view.kind !== 'readable') return refuse('instance-unavailable', `UnodeAi cannot read managed Codex's record of its versions (${view.detail}).`);
      const chosen = this.choose(request, admitted.record, view.snapshot.record);
      if (!chosen.ok) return chosen;
      if (expectedKey !== undefined && chosen.key !== expectedKey) {
        return refuse('no-launchable-version', 'The managed Codex version changed while it was being started. Start the agent again.');
      }
      const entry = this.deps.entryForKey(chosen.key);
      if (!entry?.managed) return this.versionGone(request);

      lease = this.deps.instances.createLease(ref, chosen.key, 'session', this.deps.host());
      // Read again after the lease: a version collected meanwhile has lost its facts before its folder moved.
      const again = this.deps.instances.read(ref);
      if (again.kind !== 'readable' || !again.snapshot.record.versions[chosen.key] || again.snapshot.record.probes[chosen.key]?.closureDigest !== chosen.closureDigest) {
        return this.versionGone(request);
      }
      const folder = this.deps.instances.versionFolder(ref, chosen.key);
      const checked = await verifyManagedVersionFolder(folder, entry.managed.layout, this.deps.hasher);
      // A hash run that gave no answer says nothing about the files: the start is refused, nothing is marked.
      if (!checked.ok && (checked.reason === 'hash-failed' || checked.reason === 'hash-timeout')) {
        return refuse('closure-unchecked', `UnodeAi could not check the files of managed Codex (${checked.message}). Nothing was started.`);
      }
      if (!checked.ok || checked.closure.digest !== chosen.closureDigest) {
        await this.markChanged(ref, chosen.key, chosen.closureDigest, checked.ok ? 'its files differ from the ones that were approved' : checked.message);
        return request.kind === 'pinned'
          ? refuse('identity-changed', PINNED_START_REFUSAL_TEXT['identity-changed'])
          : refuse('version-files-changed', 'The files of managed Codex changed after they were checked. UnodeAi marked this version bad on this computer.');
      }
      const plan: ManagedLaunchPlan = { storeId: ref.storeId, key: chosen.key, closureDigest: chosen.closureDigest, versionFolder: folder, executable: checked.closure.executable, entry };
      const pin = { pinVersion: 1 as const, mode: 'managed' as const, provider: 'codex-cli' as const, storeId: ref.storeId, storeKey: chosen.key, closureDigest: chosen.closureDigest };
      if (request.kind === 'new') {
        try {
          await request.savePin(pin);
        } catch (error) {
          return refuse('pin-save-failed', `UnodeAi could not save which Codex program this agent uses (${error instanceof Error ? error.message : String(error)}). Nothing was started.`);
        }
      }
      let child: ChildProcess;
      try {
        child = await spawn(plan);
      } catch (error) {
        return refuse('spawn-failed', `Managed Codex could not be started (${error instanceof Error ? error.message : String(error)}).`);
      }
      const started = lease;
      if (typeof child.pid === 'number') this.recordChild(started, child.pid);
      lease = undefined;
      let released = false;
      return {
        ok: true,
        child,
        plan,
        pin,
        lease: started,
        // Called after a confirmed stop of the process tree only; an unconfirmed stop keeps the lease.
        release: () => {
          if (released) return;
          released = true;
          this.deps.instances.releaseLease(started);
        },
      };
    } finally {
      if (lease) this.deps.instances.releaseLease(lease);
      release(handle);
    }
  }

  /** The conditions every managed root start needs, read from one control view and suspension read. */
  private check(request: ManagedLaunchRequest, control: ControlView, suspended: boolean): ManagedLaunchRefusal | { ok: true; storeId: string; record: ControlRecord } {
    const blocked = authorityRefusal(control, suspended);
    if (blocked) return blocked;
    const refusal = this.deps.storeRefusal?.();
    if (refusal) return refuse('store-refused', refusal);
    const record = (control as Extract<ControlView, { kind: 'readable' }>).snapshot.record;
    if (!record.enrolledStoreId) {
      return request.kind === 'pinned'
        ? refuse('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced'])
        : refuse('not-enrolled', 'Managed Codex is not set up.');
    }
    if (request.kind === 'pinned' && record.enrolledStoreId !== request.pin.storeId) {
      return refuse('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced']);
    }
    // No managed root process starts while the user has chosen the external CLI, pinned starts included.
    if (record.selection !== 'managed') {
      return request.kind === 'pinned'
        ? refuse('managed-not-selected', PINNED_START_REFUSAL_TEXT['managed-not-selected'])
        : refuse('managed-not-selected', 'New sessions use the external Codex CLI.');
    }
    if (request.kind === 'pinned' && record.disabled.some((entry) => entry.storeId === request.pin.storeId && entry.key === request.pin.storeKey)) {
      return refuse('managed-version-gone', PINNED_START_REFUSAL_TEXT['managed-version-gone']);
    }
    return { ok: true, storeId: record.enrolledStoreId, record };
  }

  private versionGone(request: ManagedLaunchRequest): ManagedLaunchRefusal {
    return request.kind === 'pinned'
      ? refuse('managed-version-gone', PINNED_START_REFUSAL_TEXT['managed-version-gone'])
      : refuse('no-launchable-version', 'The managed Codex version changed while it was being started. Start the agent again.');
  }

  private choose(request: ManagedLaunchRequest, record: ControlRecord, instance: InstanceRecord): ManagedLaunchRefusal | { ok: true; key: VersionKey; closureDigest: string } {
    if (request.kind !== 'pinned') {
      const chosen = this.deps.launchableKey(record, instance);
      return chosen ? { ok: true, ...chosen } : refuse('no-launchable-version', 'No managed Codex version is ready for new sessions.');
    }
    const { storeId, storeKey, closureDigest } = request.pin;
    const consented = record.activationConsents.some((consent) => consent.storeId === storeId && consent.key === storeKey && consent.closureDigest === closureDigest);
    const probed = instance.probes[storeKey]?.closureDigest === closureDigest;
    if (!consented || !probed || !instance.versions[storeKey]) return refuse('managed-version-gone', PINNED_START_REFUSAL_TEXT['managed-version-gone']);
    return { ok: true, key: storeKey, closureDigest };
  }

  /** A version folder whose files no longer equal the approved closure: a recorded prohibition. */
  private async markChanged(ref: InstanceRef, key: VersionKey, closureDigest: string, detail: string): Promise<void> {
    const at = this.now().toISOString();
    await this.deps.control.publish({
      label: 'mark a managed Codex version bad on this computer',
      kind: 'reduction',
      apply: (current) => {
        if (current.enrolledStoreId !== ref.storeId) return { moot: true };
        if (current.disabled.some((entry) => entry.storeId === ref.storeId && entry.key === key && entry.reason === 'local-bad')) return { moot: true };
        return {
          enrolledStoreId: current.enrolledStoreId,
          selection: current.selection,
          enrollment: current.enrollment,
          scheduler: current.scheduler,
          activationConsents: current.activationConsents,
          active: current.active,
          lastKnownGood: current.lastKnownGood,
          disabled: [...current.disabled, { storeId: ref.storeId, key, closureDigest, reason: 'local-bad', detail: detail.slice(0, 300), at }],
          retiredInstances: current.retiredInstances,
          decidedAt: at,
        };
      },
    }).catch(() => undefined);
  }

  private recordChild(lease: Lease, pid: number): void {
    try {
      this.deps.instances.recordLeaseChild(lease, { pid, creation: 'pending' });
    } catch {
      // The lease still says the child is pending, which counts as alive: nothing it protects is collected.
    }
    void this.deps.queryCreation?.(pid).then((creation) => {
      if (creation) this.deps.instances.recordLeaseChild(lease, { pid, creation });
    }).catch(() => undefined);
  }
}

/** The entrypoint of a version folder: the layout path's `/` segments below the folder. */
export function managedEntrypoint(versionFolder: string, entrypoint: string): string {
  return path.join(versionFolder, ...entrypoint.split('/'));
}

function release(handle: AdmissionHandle): void {
  try { handle.release(); } catch { /* closed with the process at worst */ }
}

/** The closure digest a policy entry's layout gives: what an approval of that version covers. */
export function policyEntryClosureDigest(entry: PolicyEntry): string | undefined {
  const layout = entry.managed?.layout;
  if (!layout) return undefined;
  return digestOfListing(closureListing(layout.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))));
}
