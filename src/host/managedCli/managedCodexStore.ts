/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the user's decisions about managed Codex (v0.9.97)
 *  Enrolment, the choice between managed Codex and the external CLI, Reset, the shared suspension, and the settings
 *  that change what may be downloaded or run. Each is one control publication, decided again on the record it is
 *  published after. Nothing here downloads, starts a program or reads a version folder.
 *
 *  - Enrolment builds a complete new instance first and only then names it in control; a build that loses to
 *    another change stays an orphan and is collected later.
 *  - Choosing the external CLI keeps the instance, its versions, its approvals and its settings. Choosing managed
 *    Codex again needs no download and no new approval.
 *  - Reset closes the instance's admission gate first, so that no managed start can cross it, and then retires the
 *    instance in control. It never deletes or renames files that a running program uses.
 *--------------------------------------------------------------------------------------------*/

import type {
  ControlContent,
  ControlPublishResult,
  ControlRecord,
  ControlStoreApi,
  ControlView,
  InstanceRef,
  InstanceStoreApi,
  InstanceView,
  StoreId,
  SuspensionView,
} from './contracts';

export interface ManagedCodexStatus {
  suspension: SuspensionView;
  control: ControlView;
  /** The enrolled instance, when control names one. */
  instance?: { storeId: StoreId; open: ReturnType<InstanceStoreApi['open']>; view?: InstanceView; admission?: ReturnType<InstanceStoreApi['admissionState']> };
}

export type ManagedCodexChange =
  | { ok: true; changed: boolean; control: ControlView }
  | { ok: false; reason: string; control?: ControlView };

export interface ManagedCodexStoreDeps {
  control: ControlStoreApi;
  instances: InstanceStoreApi;
  now?: () => Date;
  /** Told after a Reset is recorded, so that this window cancels its own tasks and probes of that instance. */
  onInstanceRetired?: (storeId: StoreId) => void;
}

/** The record a change is published after, with the fields every user decision keeps unless it changes them. */
function content(record: ControlRecord): ControlContent {
  return {
    enrolledStoreId: record.enrolledStoreId,
    selection: record.selection,
    enrollment: record.enrollment && { ...record.enrollment, consentedHosts: [...record.enrollment.consentedHosts] },
    scheduler: { ...record.scheduler },
    activationConsents: record.activationConsents.map((consent) => ({ ...consent })),
    active: record.active && { ...record.active },
    lastKnownGood: record.lastKnownGood && { ...record.lastKnownGood },
    disabled: record.disabled.map((entry) => ({ ...entry })),
    retiredInstances: record.retiredInstances.map((retired) => ({ ...retired })),
    decidedAt: record.decidedAt,
  };
}

export class ManagedCodexStore {
  private readonly now: () => Date;

  constructor(private readonly deps: ManagedCodexStoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** What every window reads before it decides. Reading changes nothing. */
  status(): ManagedCodexStatus {
    const suspension = this.deps.control.readSuspension();
    const control = this.deps.control.read();
    const storeId = control.kind === 'readable' ? control.snapshot.record.enrolledStoreId : control.kind === 'unusable' ? control.snapshot?.record.enrolledStoreId ?? null : null;
    if (!storeId) return { suspension, control };
    const open = this.deps.instances.open(storeId);
    if (!open.ok) return { suspension, control, instance: { storeId, open } };
    return {
      suspension,
      control,
      instance: { storeId, open, view: this.deps.instances.read(open.ref), admission: this.deps.instances.admissionState(open.ref) },
    };
  }

  /**
   * The user's explicit enrolment: a new instance with the consented download hosts and the automatic-mode choice.
   * Only from `(null, external)` with authority ok and no suspension.
   */
  async enrol(choice: { consentedHosts: readonly string[]; autoMode: boolean }): Promise<ManagedCodexChange> {
    let control = this.deps.control.read();
    if (control.kind === 'fresh') {
      const initialized = await this.deps.control.initialize();
      if (initialized.outcome !== 'published' && initialized.outcome !== 'moot') return refusal(initialized, 'UnodeAi could not set up its record of managed Codex.');
      control = this.deps.control.read();
    }
    if (control.kind !== 'readable' || control.authority !== 'ok') return { ok: false, reason: 'Managed Codex cannot be set up while its record is not usable.', control };
    if (this.deps.control.readSuspension().present) return { ok: false, reason: 'Managed Codex is paused in every window. Use managed Codex again first.', control };
    const predecessor = control.snapshot;
    if (predecessor.record.enrolledStoreId !== null) return { ok: false, reason: 'Managed Codex is already set up.', control };

    const built = await this.deps.instances.create();
    if (!built.ok) return { ok: false, reason: `UnodeAi could not prepare managed Codex's folder (${built.detail}). Nothing was set up.`, control };
    const storeId = built.ref.storeId;
    const decidedAt = this.now().toISOString();
    const hosts = [...new Set(choice.consentedHosts.map((host) => host.toLowerCase()))].sort();
    const published = await this.deps.control.publish({
      label: 'enrol managed Codex',
      kind: 'increase',
      expected: { generation: predecessor.generation, digest: predecessor.digest },
      apply: (current) => {
        if (current.enrolledStoreId !== null) return { refused: 'managed Codex was set up meanwhile' };
        return {
          ...content(current),
          enrolledStoreId: storeId,
          selection: 'managed',
          enrollment: { epoch: (current.enrollment?.epoch ?? 0) + 1, consentedHosts: hosts, decidedAt },
          scheduler: { epoch: current.scheduler.epoch, autoMode: choice.autoMode },
          active: null,
          lastKnownGood: null,
          decidedAt,
        };
      },
    });
    // A build that did not become current stays an orphan: nothing names it, and it is collected later.
    if (published.outcome !== 'published') return refusal(published, 'Managed Codex changed in another window. Nothing was set up.');
    return { ok: true, changed: true, control: this.deps.control.read() };
  }

  /** **Use external CLI**: `(A, managed)` → `(A, external)`. A recorded reduction; the instance stays enrolled. */
  async useExternal(): Promise<ManagedCodexChange> {
    const view = this.deps.control.read();
    const redecision = view.kind === 'readable' && view.authority === 'behind-floor';
    const published = await this.deps.control.publish({
      label: 'use the external CLI',
      kind: 'reduction',
      ...(redecision ? { redecision: true as const, expected: { generation: view.snapshot.generation, digest: view.snapshot.digest } } : {}),
      apply: (current) => {
        if (current.selection === 'external' && !redecision) return { moot: true };
        return { ...content(current), selection: 'external', decidedAt: this.now().toISOString() };
      },
    });
    return outcome(published, this.deps.control);
  }

  /**
   * **Use managed Codex**: `(A, external)` → `(A, managed)`, with no download and no new approval. Only while A's
   * admission gate is open, authority is ok and no suspension exists (the control store refuses increases then).
   */
  async useManaged(): Promise<ManagedCodexChange> {
    const view = this.deps.control.read();
    if (view.kind !== 'readable' || view.authority !== 'ok') return { ok: false, reason: 'Managed Codex cannot be chosen while its record is not usable.', control: view };
    const storeId = view.snapshot.record.enrolledStoreId;
    if (!storeId) return { ok: false, reason: 'Managed Codex is not set up.', control: view };
    const ref = this.openEnrolled(storeId);
    if (!ref || this.deps.instances.admissionState(ref) !== 'open') {
      return { ok: false, reason: 'Managed Codex is being reset. Set it up again to use it.', control: view };
    }
    const published = await this.deps.control.publish({
      label: 'use managed Codex',
      kind: 'increase',
      apply: (current) => {
        if (current.enrolledStoreId !== storeId) return { refused: 'managed Codex was reset meanwhile' };
        if (current.selection === 'managed') return { moot: true };
        return { ...content(current), selection: 'managed', decidedAt: this.now().toISOString() };
      },
    });
    return outcome(published, this.deps.control);
  }

  /**
   * **Reset managed Codex…**: close the enrolled instance's admission gate, then publish `(null, external)`. When
   * the gate cannot be closed (a managed start holds it), nothing is changed. A gate closed earlier by an
   * interrupted Reset is completed here too: the closed gate is the durable intent. An instance this window cannot
   * open is not reset: another window may hold its gate and still start from it, so only a closed gate retires it.
   * **Use external CLI** is the way out then.
   */
  async reset(): Promise<ManagedCodexChange> {
    const view = this.deps.control.read();
    if (view.kind !== 'readable') return { ok: false, reason: 'Reset is not available while the record of managed Codex cannot be read. Use the external CLI instead.', control: view };
    const storeId = view.snapshot.record.enrolledStoreId;
    if (!storeId) return { ok: true, changed: false, control: view };
    const ref = this.openEnrolled(storeId);
    if (!ref) {
      return {
        ok: false,
        reason: 'UnodeAi cannot open the managed Codex store, so it cannot reset it safely: another window may still be starting managed Codex from it. Nothing was changed. Choose Use external CLI so that new sessions use your own Codex CLI.',
        control: view,
      };
    }
    const closed = await this.deps.instances.closeAdmission(ref);
    if (!closed.ok) {
      return {
        ok: false,
        reason: `UnodeAi could not reset managed Codex now (${closed.code}). Nothing was changed. An agent may be starting, or a download or check may be running in another window. Try again in a moment.`,
        control: view,
      };
    }
    const result = await this.completeReset(storeId);
    if (result.ok && result.changed) this.deps.onInstanceRetired?.(storeId);
    return result;
  }

  /**
   * At start-up: a record that still names an instance whose gate is seen closed is a Reset that was interrupted
   * after the gate closed. It is completed; the gate is never opened again. An instance that is missing, names
   * another store or cannot be read is no Reset: it stays enrolled, starts nothing, and the card offers Use external CLI.
   */
  async completePendingReset(): Promise<ManagedCodexChange | undefined> {
    const view = this.deps.control.read();
    if (view.kind !== 'readable') return undefined;
    const storeId = view.snapshot.record.enrolledStoreId;
    if (!storeId) return undefined;
    const ref = this.openEnrolled(storeId);
    if (!ref || this.deps.instances.admissionState(ref) !== 'closed') return undefined;
    const result = await this.completeReset(storeId);
    if (result.ok && result.changed) this.deps.onInstanceRetired?.(storeId);
    return result;
  }

  private async completeReset(storeId: StoreId): Promise<ManagedCodexChange> {
    const view = this.deps.control.read();
    const redecision = view.kind === 'readable' && view.authority === 'behind-floor';
    const published = await this.deps.control.publish({
      label: 'reset managed Codex',
      kind: 'reduction',
      completesReset: 'gate-closed',
      ...(redecision && view.kind === 'readable' ? { redecision: true as const, expected: { generation: view.snapshot.generation, digest: view.snapshot.digest } } : {}),
      apply: (current) => {
        if (current.enrolledStoreId !== storeId) return { moot: true };
        const decidedAt = this.now().toISOString();
        const kept = content(current);
        return {
          ...kept,
          enrolledStoreId: null,
          selection: 'external',
          enrollment: null,
          scheduler: { epoch: current.scheduler.autoMode ? current.scheduler.epoch + 1 : current.scheduler.epoch, autoMode: false },
          // Entries naming a retired instance grant and forbid nothing any more; none is carried.
          activationConsents: kept.activationConsents.filter((consent) => consent.storeId !== storeId),
          disabled: kept.disabled.filter((entry) => entry.storeId !== storeId),
          active: null,
          lastKnownGood: null,
          retiredInstances: [...kept.retiredInstances.filter((retired) => retired.storeId !== storeId), { storeId, retiredAt: decidedAt }],
          decidedAt,
        };
      },
    });
    return outcome(published, this.deps.control);
  }

  /** **Use external CLI** when control cannot be used: the shared suspension. Writes nothing else. */
  async suspend(reason: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const view = this.deps.control.read();
    const state = view.kind === 'unusable' ? view.reason : view.kind === 'readable' ? view.authority : 'fresh';
    const result = await this.deps.control.suspend(reason, state);
    return result.ok ? { ok: true } : { ok: false, reason: `UnodeAi could not record the switch to the external CLI (${result.detail}). Managed Codex stays paused.` };
  }

  /** **Use managed Codex again**: only while control reads ok. Publishes nothing. */
  async clearSuspension(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.deps.control.clearSuspension();
    return result.ok ? { ok: true } : { ok: false, reason: result.detail };
  }

  /** Automatic mode. Turning it off is a reduction and moves the scheduler epoch, so automatic tasks stop. */
  async setAutoMode(on: boolean): Promise<ManagedCodexChange> {
    const published = await this.deps.control.publish({
      label: on ? 'turn automatic updates on' : 'turn automatic updates off',
      kind: on ? 'increase' : 'reduction',
      apply: (current) => {
        if (!current.enrolledStoreId) return { refused: 'managed Codex is not set up' };
        if (current.scheduler.autoMode === on) return { moot: true };
        return {
          ...content(current),
          scheduler: { epoch: on ? current.scheduler.epoch : current.scheduler.epoch + 1, autoMode: on },
          decidedAt: this.now().toISOString(),
        };
      },
    });
    return outcome(published, this.deps.control);
  }

  /** Removing a consented download host: a reduction that moves the enrolment epoch, so every task stops. */
  async removeHost(host: string): Promise<ManagedCodexChange> {
    const name = host.toLowerCase();
    const published = await this.deps.control.publish({
      label: `remove download host ${name}`,
      kind: 'reduction',
      apply: (current) => {
        if (!current.enrollment || !current.enrollment.consentedHosts.includes(name)) return { moot: true };
        return {
          ...content(current),
          enrollment: { ...current.enrollment, epoch: current.enrollment.epoch + 1, consentedHosts: current.enrollment.consentedHosts.filter((item) => item !== name) },
          decidedAt: this.now().toISOString(),
        };
      },
    });
    return outcome(published, this.deps.control);
  }

  /**
   * A user rollback to the last known good version: a reduction. The caller has already shown both versions and
   * said that running agents keep theirs.
   */
  async rollBack(): Promise<ManagedCodexChange> {
    const published = await this.deps.control.publish({
      label: 'roll back managed Codex',
      kind: 'reduction',
      apply: (current) => {
        if (!current.enrolledStoreId || !current.lastKnownGood || current.lastKnownGood.storeId !== current.enrolledStoreId) return { refused: 'there is no earlier version to go back to' };
        return { ...content(current), active: { ...current.lastKnownGood }, lastKnownGood: null, decidedAt: this.now().toISOString() };
      },
    });
    return outcome(published, this.deps.control);
  }

  /**
   * The `behind-floor` review: the user confirms the settings shown (possibly changed). One recorded reduction on
   * exactly the record that was shown; anything else asks again.
   */
  async confirmAfterUncertainShutdown(
    shown: { generation: number; digest: string },
    confirmed: Pick<ControlContent, 'selection'> & { autoMode: boolean; consentedHosts: readonly string[] },
  ): Promise<ManagedCodexChange> {
    const published = await this.deps.control.publish({
      label: 'confirm managed Codex settings after an unexpected shutdown',
      kind: 'reduction',
      redecision: true,
      expected: shown,
      apply: (current) => {
        const kept = content(current);
        if (!current.enrolledStoreId) return { ...kept, decidedAt: this.now().toISOString() };
        const hosts = [...new Set(confirmed.consentedHosts.map((host) => host.toLowerCase()))].sort();
        const enrollment = current.enrollment!;
        const removed = enrollment.consentedHosts.some((host) => !hosts.includes(host));
        return {
          ...kept,
          selection: confirmed.selection,
          scheduler: { epoch: current.scheduler.autoMode && !confirmed.autoMode ? current.scheduler.epoch + 1 : current.scheduler.epoch, autoMode: confirmed.autoMode },
          enrollment: { ...enrollment, epoch: removed ? enrollment.epoch + 1 : enrollment.epoch, consentedHosts: hosts.filter((host) => enrollment.consentedHosts.includes(host)) },
          decidedAt: this.now().toISOString(),
        };
      },
    });
    return outcome(published, this.deps.control);
  }

  /**
   * Store maintenance, at most once a day per window: the newest 3 versions of the current instance (active and
   * LKG and leased ones never deleted), orphan folders, and whole instances retired long enough ago. Each step
   * decides afresh from what it reads now.
   */
  async collect(): Promise<{ versions?: Awaited<ReturnType<InstanceStoreApi['collectVersions']>>; instances: StoreId[] }> {
    const view = this.deps.control.read();
    if (view.kind !== 'readable' || view.authority !== 'ok' || this.deps.control.readSuspension().present) return { instances: [] };
    const record = view.snapshot.record;
    let versions: Awaited<ReturnType<InstanceStoreApi['collectVersions']>> | undefined;
    const ref = record.enrolledStoreId ? this.openEnrolled(record.enrolledStoreId) : undefined;
    if (ref) {
      const protectedKeys = new Set([record.active, record.lastKnownGood].filter((item) => item?.storeId === ref.storeId).map((item) => item!.key));
      versions = await this.deps.instances.collectVersions(ref, { protectedKeys, keep: 3 });
      await this.deps.instances.retireOrphans(ref);
    }
    const instances = await this.deps.instances.collectInstances(record.enrolledStoreId, record.retiredInstances);
    return { ...(versions ? { versions } : {}), instances };
  }

  private openEnrolled(storeId: StoreId): InstanceRef | undefined {
    const open = this.deps.instances.open(storeId);
    return open.ok ? open.ref : undefined;
  }
}

function outcome(result: ControlPublishResult, control: ControlStoreApi): ManagedCodexChange {
  if (result.outcome === 'published') return { ok: true, changed: true, control: control.read() };
  if (result.outcome === 'moot') return { ok: true, changed: false, control: control.read() };
  return refusal(result, 'Managed Codex changed in another window. Nothing was changed.');
}

function refusal(result: ControlPublishResult, fallback: string): ManagedCodexChange {
  switch (result.outcome) {
    case 'refused': return { ok: false, reason: result.reason };
    case 'unusable': return { ok: false, reason: 'The record of managed Codex cannot be used.', control: result.view };
    case 'stale': return { ok: false, reason: 'Managed Codex changed since this was shown. Nothing was changed.' };
    case 'busy': return { ok: false, reason: 'Other windows kept changing managed Codex. Nothing was changed. Try again.' };
    default: return { ok: false, reason: fallback };
  }
}
