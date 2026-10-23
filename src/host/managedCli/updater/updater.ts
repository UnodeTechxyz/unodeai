/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the managed Codex updater of one window (v0.9.97)
 *  It owns the window's timers and runs at most one download task at a time. The first automatic attempt comes 2
 *  minutes after the window starts, in a trusted window that is not shutting down, and after that within the 24-hour
 *  rule every window shares through the instance's schedule. Between attempts it only reads: control, the suspension
 *  and the instance record, and the bundled policy, which sends nothing, so it looks again at least every hour and
 *  notices a change another window made (automatic mode turned on, a new enrolment). The user's Update now starts a
 *  manual task at once.
 *
 *  It never starts a version: a task ends at `verified`, and the notice that a version waits for the user's click,
 *  given once per version in this window, is for the click's own module to show. Everything it does goes through the
 *  stores and the dependencies it is given. `dispose()`, and the extension host's shutdown, end its task.
 *--------------------------------------------------------------------------------------------*/

import type { PolicyEntry, ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import { compareCliVersions } from '../../../backend/cliRuntime';
import type { HostShutdown } from '../../../backend/processTree';
import type { DownloadTimers } from '../../cliDelivery/boundedDownload';
import type { ControlSnapshot, ControlStoreApi, InstanceRef, InstanceStoreApi, VersionKey } from '../contracts';
import { runDownloadTask, type DownloadTaskDeps, type DownloadTaskInput, type DownloadTaskKind, type DownloadTaskPhase, type DownloadTaskResult } from './downloadTask';
import { downloadTarget, installableEntries, type InstallableRefusal, type UpdaterHost } from './installable';
import { automaticCheck, manualCheck, UPDATE_SCHEDULE, type UpdateSchedule } from './schedule';

/** The longest the updater waits before it reads again; reading sends nothing. */
export const UPDATER_IDLE_RECHECK_MS = 60 * 60_000;

export interface ManagedCodexUpdaterDeps {
  control: ControlStoreApi;
  instances: InstanceStoreApi;
  policy: ValidatedCliCompatibilityPolicy;
  host: UpdaterHost;
  timers: DownloadTimers;
  /** The window is trusted and its workspace binding is current. */
  windowAllowed: () => boolean;
  shutdown: Pick<HostShutdown, 'started' | 'onBegin'>;
  /** What every task gets besides its own signal, check and clock. */
  task: Omit<DownloadTaskDeps, 'signal' | 'stillAllowed' | 'timers' | 'now'>;
  /** `runDownloadTask` by default. */
  runTask?: (input: DownloadTaskInput, deps: DownloadTaskDeps) => Promise<DownloadTaskResult>;
  onTaskEnded?: (result: DownloadTaskResult, kind: DownloadTaskKind) => void;
  /** A version is downloaded and checked and waits for the click: told once per version per window session. */
  onVerified?: (key: VersionKey, entry: PolicyEntry) => void;
  /**
   * What this window's task does now, for the card: its steps, the bytes received, and its end. Only the task that
   * runs now reports, and nothing is reported once the updater was disposed.
   */
  onTask?: (event: UpdaterTaskEvent) => void;
}

export type UpdaterTaskEvent =
  | { type: 'phase'; kind: DownloadTaskKind; entry: PolicyEntry; phase: DownloadTaskPhase }
  | { type: 'progress'; kind: DownloadTaskKind; entry: PolicyEntry; receivedBytes: number; size: number }
  | { type: 'ended'; kind: DownloadTaskKind; entry: PolicyEntry; result: DownloadTaskResult };

type Plan =
  | {
    kind: 'target';
    entry: PolicyEntry;
    key: VersionKey;
    decidedOn: ControlSnapshot;
    ref: InstanceRef;
    schedule: UpdateSchedule;
    /** A newer entry that names a host outside the consent. */
    needsConsent?: { entry: PolicyEntry; hosts: string[] };
  }
  | {
    kind: 'none';
    reason: InstallableRefusal | 'instance-unusable' | 'active-version-unknown' | 'nothing-newer' | 'already-promoted' | 'disabled';
    entry?: PolicyEntry;
    key?: VersionKey;
    needsConsent?: { entry: PolicyEntry; hosts: string[] };
  };

export type UpdateNowOutcome =
  | { ran: true; result: DownloadTaskResult }
  | {
    ran: false;
    reason: Extract<Plan, { kind: 'none' }>['reason'] | 'busy' | 'disposed' | 'untrusted' | 'shutting-down' | 'needs-host-consent';
    entry?: PolicyEntry;
    key?: VersionKey;
    hosts?: string[];
  };

export class ManagedCodexUpdater {
  private startedAt: number | undefined;
  private timer: unknown;
  private current: { kind: DownloadTaskKind; controller: AbortController; done: Promise<DownloadTaskResult> } | undefined;
  private disposed = false;
  private forgetShutdown: (() => void) | undefined;
  private readonly notified = new Set<VersionKey>();
  /** The task whose steps reach the card. */
  private reporting: object | undefined;

  constructor(private readonly deps: ManagedCodexUpdaterDeps) {}

  /** Begins the window's schedule: the first automatic attempt is 2 minutes away at the earliest. */
  start(): void {
    if (this.startedAt !== undefined || this.disposed) return;
    this.startedAt = this.deps.timers.now();
    this.forgetShutdown = this.deps.shutdown.onBegin(() => this.dispose());
    if (this.disposed) return;
    this.wake(this.startedAt + UPDATE_SCHEDULE.firstCheckDelayMs);
  }

  /** Read again soon, for example after this window changed control; never earlier than the window's first check. */
  refresh(): void {
    if (this.startedAt === undefined || this.disposed || this.current) return;
    this.wake(Math.max(this.deps.timers.now(), this.startedAt + UPDATE_SCHEDULE.firstCheckDelayMs));
  }

  /** The kind of the task that runs now, if any. */
  get running(): DownloadTaskKind | undefined {
    return this.current?.kind;
  }

  /** Ends the timers and this window's task. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.current?.controller.abort();
    this.forgetShutdown?.();
  }

  /** The user's Update now: a manual task at once, with a valid enrolment and every host it uses consented. */
  async updateNow(): Promise<UpdateNowOutcome> {
    if (this.disposed) return { ran: false, reason: 'disposed' };
    if (this.current) return { ran: false, reason: 'busy' };
    const plan = this.plan();
    if (plan.kind === 'none' && plan.reason === 'not-enrolled') return { ran: false, reason: 'not-enrolled' };
    const gate = manualCheck({ window: { trusted: this.allowed(), shuttingDown: this.deps.shutdown.started }, enrolled: true });
    if (gate.kind === 'never') return { ran: false, reason: gate.why };
    // The newest version needs a new consent before anything is downloaded for it.
    if (plan.needsConsent) return { ran: false, reason: 'needs-host-consent', entry: plan.needsConsent.entry, hosts: plan.needsConsent.hosts };
    if (plan.kind === 'none') return { ran: false, reason: plan.reason, ...(plan.entry ? { entry: plan.entry } : {}), ...(plan.key ? { key: plan.key } : {}) };
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
    return { ran: true, result: await this.launch('manual', plan) };
  }

  private allowed(): boolean {
    try {
      return this.deps.windowAllowed();
    } catch {
      return false;
    }
  }

  private wake(at: number): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    const delay = Math.max(0, at - this.deps.timers.now());
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = undefined;
      this.evaluate();
    }, delay);
  }

  /** What a task would download now, read from control, the suspension, the instance and the policy. */
  private plan(): Plan {
    let suspension;
    let view;
    try {
      suspension = this.deps.control.readSuspension();
      view = this.deps.control.read();
    } catch {
      return { kind: 'none', reason: 'control-unusable' };
    }
    const installable = installableEntries(this.deps.policy, this.deps.host, { control: view, suspension });
    if (installable.refused || view.kind !== 'readable') return { kind: 'none', reason: installable.refused ?? 'control-unusable' };
    const record = view.snapshot.record;
    if (record.enrolledStoreId === null) return { kind: 'none', reason: 'not-enrolled' };
    const opened = this.deps.instances.open(record.enrolledStoreId);
    if (!opened.ok) return { kind: 'none', reason: 'instance-unusable' };
    const instance = this.deps.instances.read(opened.ref);
    const target = downloadTarget(installable.installable, record, instance);
    // A newer version than any installable one that needs a new consent first.
    const consentTarget = downloadTarget(installable.needsHostConsent.map((item) => item.entry), record, instance);
    const consentEntry = consentTarget.kind === 'target' ? consentTarget.entry : undefined;
    const needsConsent = consentEntry && (target.kind !== 'target' || (compareCliVersions(consentEntry.version, target.entry.version) ?? 0) > 0)
      ? installable.needsHostConsent.find((item) => item.entry === consentEntry)
      : undefined;
    if (target.kind !== 'target' || instance.kind !== 'readable') {
      const reason = target.kind === 'none' ? target.reason : 'instance-unusable';
      return { kind: 'none', reason, ...(target.kind === 'none' && target.entry ? { entry: target.entry, key: target.key } : {}), ...(needsConsent ? { needsConsent } : {}) };
    }
    return {
      kind: 'target',
      entry: target.entry,
      key: target.key,
      decidedOn: view.snapshot,
      ref: opened.ref,
      schedule: instance.snapshot.record.schedule,
      ...(needsConsent ? { needsConsent } : {}),
    };
  }

  /** The timer: start an automatic task when it is due, otherwise read again later. */
  private evaluate(): void {
    if (this.disposed || this.current || this.startedAt === undefined) return;
    const now = this.deps.timers.now();
    const plan = this.plan();
    if (plan.kind === 'none') {
      if (plan.reason === 'already-promoted' && plan.entry && plan.key) this.notifyVerified(plan.key, plan.entry);
      this.wake(now + UPDATER_IDLE_RECHECK_MS);
      return;
    }
    const decision = automaticCheck({
      now,
      window: { startedAt: this.startedAt, trusted: this.allowed(), shuttingDown: this.deps.shutdown.started },
      enrolled: true,
      autoMode: plan.decidedOn.record.scheduler.autoMode,
      schedule: plan.schedule,
      targetEntryId: plan.entry.id,
    });
    if (decision.kind === 'due') {
      void this.launch('automatic', plan);
      return;
    }
    if (decision.kind === 'never' && decision.why === 'shutting-down') return;
    this.wake(decision.kind === 'later' ? Math.min(decision.at, now + UPDATER_IDLE_RECHECK_MS) : now + UPDATER_IDLE_RECHECK_MS);
  }

  private launch(kind: DownloadTaskKind, plan: Extract<Plan, { kind: 'target' }>): Promise<DownloadTaskResult> {
    const controller = new AbortController();
    const run = this.deps.runTask ?? runDownloadTask;
    // Reports of this task only, while it is the window's task: a stale task's late step never reaches the card.
    const token = {};
    this.reporting = token;
    const report = (event: UpdaterTaskEvent): void => {
      if (this.disposed || this.reporting !== token) return;
      try { this.deps.onTask?.(event); } catch { /* a listener never changes the updater */ }
    };
    const done = run({
      kind,
      decidedOn: plan.decidedOn,
      entry: plan.entry,
      policy: this.deps.policy,
      host: this.deps.host,
      instance: plan.ref,
      control: this.deps.control,
      instances: this.deps.instances,
    }, {
      ...this.deps.task,
      signal: controller.signal,
      stillAllowed: () => !this.disposed && !this.deps.shutdown.started && this.allowed(),
      timers: this.deps.timers,
      now: () => this.deps.timers.now(),
      onPhase: (phase) => report({ type: 'phase', kind, entry: plan.entry, phase }),
      onProgress: (receivedBytes, size) => report({ type: 'progress', kind, entry: plan.entry, receivedBytes, size }),
    }).catch((error: unknown): DownloadTaskResult => ({
      outcome: 'failed', phase: 'admission', failure: 'file', key: plan.key, treeStops: [],
      detail: `the task failed (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`,
    }));
    this.current = { kind, controller, done };
    void done.then((result) => {
      if (this.current?.done === done) this.current = undefined;
      report({ type: 'ended', kind, entry: plan.entry, result });
      if (this.reporting === token) this.reporting = undefined;
      try { this.deps.onTaskEnded?.(result, kind); } catch { /* a listener never changes the updater */ }
      if (result.outcome === 'verified') this.notifyVerified(result.key, plan.entry);
      // Never at once: a task that ended before its download records no attempt, and must not start again in a loop.
      if (!this.disposed) this.wake(this.deps.timers.now() + UPDATER_IDLE_RECHECK_MS);
    });
    return done;
  }

  private notifyVerified(key: VersionKey, entry: PolicyEntry): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    try { this.deps.onVerified?.(key, entry); } catch { /* a listener never changes the updater */ }
  }
}
