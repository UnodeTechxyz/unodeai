/*
 * In-memory fakes of the two store contracts (`ControlStoreApi`, `InstanceStoreApi`) for the updater's tests. They
 * follow the documented behaviour, not the other slices' code: every publication is a compare-and-swap whose `apply`
 * is re-run on a fresh predecessor; `expected` gives `stale`; a present suspension refuses every increase; an unusable
 * control refuses everything; `behind-floor` admits only a recorded re-decision; a closed admission gate refuses the
 * gate and is closed only while no handle is held. Instance manifests are in memory; staging and version folders are
 * real folders under a temp root, so the real download, extraction and PE sniff run against real files.
 */

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  AdmissionAcquire,
  AdmissionClose,
  AdmissionGateState,
  ControlChange,
  ControlContent,
  ControlPublishResult,
  ControlRecord,
  ControlSnapshot,
  ControlStoreApi,
  ControlUnusableReason,
  ControlView,
  DisabledReason,
  InstanceChange,
  InstanceOpen,
  InstancePublishResult,
  InstanceRecord,
  InstanceRef,
  InstanceSnapshot,
  InstanceStoreApi,
  InstanceView,
  Lease,
  LeaseKind,
  LeaseRecord,
  Liveness,
  ProcessIdentity,
  PromotedVersion,
  Promotion,
  StagingFolder,
  StoreId,
  SuspensionView,
  VersionCollectionInput,
  VersionCollectionReport,
  VersionKey,
  VersionRetirement,
  ManifestRepair,
  WorkFolder,
} from '../contracts';
import { newStoreToken, recordDigest } from '../storeLayout';

/** One list of what happened, in order, shared by the stores and the test's own recorders. */
export type Recorder = string[];

const PUBLISH_ATTEMPTS = 5;

// ---- Control ----------------------------------------------------------------------------------

export class FakeControlStore implements ControlStoreApi {
  readonly generations: ControlSnapshot[] = [];
  floor = 0;
  authority: 'ok' | 'behind-floor' = 'ok';
  unusable: { reason: ControlUnusableReason; detail: string } | undefined;
  suspension: SuspensionView = { present: false };
  readonly controlId = newStoreToken();
  /** Runs after `apply` and before the commit: another window may publish here. */
  beforeCommit: ((change: ControlChange) => void | Promise<void>) | undefined;

  constructor(private readonly recorder: Recorder = [], private readonly instances?: FakeInstanceStore) {}

  private latest(): ControlSnapshot | undefined {
    return this.generations[this.generations.length - 1];
  }

  read(): ControlView {
    const latest = this.latest();
    if (this.unusable) return { kind: 'unusable', ...this.unusable, ...(latest ? { snapshot: latest } : {}) };
    if (!latest) return { kind: 'fresh' };
    return { kind: 'readable', authority: this.authority, snapshot: latest, floor: this.floor };
  }

  readSuspension(): SuspensionView {
    return this.suspension;
  }

  async initialize(): Promise<ControlPublishResult> {
    const latest = this.latest();
    if (latest) return { outcome: 'moot', snapshot: latest };
    const snapshot = this.commit(null, {
      enrolledStoreId: null,
      selection: 'external',
      enrollment: null,
      scheduler: { epoch: 0, autoMode: false },
      activationConsents: [],
      active: null,
      lastKnownGood: null,
      disabled: [],
      retiredInstances: [],
      decidedAt: new Date(0).toISOString(),
    }, 'increase');
    return { outcome: 'published', snapshot };
  }

  async publish(change: ControlChange): Promise<ControlPublishResult> {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      const view = this.read();
      if (view.kind === 'unusable') return { outcome: 'unusable', view };
      if (view.kind === 'fresh') return { outcome: 'refused', reason: 'control is not initialized' };
      const predecessor = view.snapshot;
      if (this.suspension.present !== false && change.kind === 'increase') {
        return { outcome: 'refused', reason: 'managed Codex is suspended', snapshot: predecessor };
      }
      if (change.expected && (change.expected.generation !== predecessor.generation || change.expected.digest !== predecessor.digest)) {
        return { outcome: 'stale', snapshot: predecessor };
      }
      if (view.authority === 'behind-floor' && !(change.redecision && change.kind === 'reduction')) {
        return { outcome: 'refused', reason: 'behind the floor: only a recorded re-decision', snapshot: predecessor };
      }
      const enrolled = predecessor.record.enrolledStoreId;
      if (enrolled && this.instances?.gateOf(enrolled) === 'closed' && !change.completesReset) {
        return { outcome: 'refused', reason: 'a Reset is under way', snapshot: predecessor };
      }
      const applied = change.apply(predecessor.record);
      if ('moot' in applied) return { outcome: 'moot', snapshot: predecessor };
      if ('refused' in applied) return { outcome: 'refused', reason: applied.refused, snapshot: predecessor };
      // Without a race hook the commit follows `apply` at once, as one window's publication does.
      if (this.beforeCommit) await this.beforeCommit(change);
      if (this.latest() !== predecessor) continue;
      const snapshot = this.commit(predecessor, applied, change.kind);
      this.recorder.push(`control:${change.label}`);
      return { outcome: 'published', snapshot };
    }
    return { outcome: 'busy' };
  }

  private commit(predecessor: ControlSnapshot | null, content: ControlContent, kind: 'increase' | 'reduction'): ControlSnapshot {
    const previousEpoch = predecessor?.record.reductionEpoch ?? 0;
    const record: ControlRecord = {
      ...structuredClone(content),
      schema: 'unodeai.cli-control/1',
      controlId: this.controlId,
      generation: (predecessor?.generation ?? 0) + 1,
      previousRecordDigest: predecessor?.digest ?? null,
      reductionEpoch: kind === 'reduction' ? previousEpoch + 1 : previousEpoch,
    };
    if (kind === 'reduction') this.floor = record.reductionEpoch;
    const snapshot: ControlSnapshot = Object.freeze({ generation: record.generation, record, digest: recordDigest(record) });
    this.generations.push(snapshot);
    return snapshot;
  }

  async suspend(reason: string, _controlState: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (this.suspension.present === false) this.suspension = { present: true, readable: true, reason, decidedAt: new Date().toISOString() };
    this.recorder.push('control:suspended');
    return { ok: true };
  }

  async clearSuspension(): Promise<{ ok: true } | { ok: false; detail: string }> {
    const view = this.read();
    if (view.kind !== 'readable' || view.authority !== 'ok') return { ok: false, detail: 'control is not ok' };
    this.suspension = { present: false };
    return { ok: true };
  }
}

/** The facade's transitions, as the tests need them (Revision 5 §7, merged design §3.2–3.3). */
export const controlChanges = {
  enrol(storeId: StoreId, consentedHosts: string[], autoMode: boolean): ControlChange {
    return {
      label: 'enrol', kind: 'increase',
      apply: (current) => current.enrolledStoreId !== null ? { refused: 'already enrolled' } : {
        ...contentOf(current),
        enrolledStoreId: storeId,
        selection: 'managed',
        // A new enrolment starts its epoch again, so it can equal the epoch of a retired instance's enrolment.
        enrollment: { epoch: 0, consentedHosts, decidedAt: new Date().toISOString() },
        scheduler: { epoch: current.scheduler.epoch, autoMode },
      },
    };
  },
  autoMode(on: boolean): ControlChange {
    return on
      ? { label: 'auto on', kind: 'increase', apply: (current) => current.scheduler.autoMode ? { moot: true } : { ...contentOf(current), scheduler: { ...current.scheduler, autoMode: true } } }
      : { label: 'auto off', kind: 'reduction', apply: (current) => ({ ...contentOf(current), scheduler: { epoch: current.scheduler.epoch + 1, autoMode: false } }) };
  },
  removeHost(host: string): ControlChange {
    return {
      label: 'remove host', kind: 'reduction',
      apply: (current) => current.enrollment === null ? { refused: 'not enrolled' } : {
        ...contentOf(current),
        enrollment: { ...current.enrollment, epoch: current.enrollment.epoch + 1, consentedHosts: current.enrollment.consentedHosts.filter((item) => item !== host) },
      },
    };
  },
  selectExternal(): ControlChange {
    return { label: 'use external', kind: 'reduction', apply: (current) => ({ ...contentOf(current), selection: 'external' }) };
  },
  reset(): ControlChange {
    return {
      label: 'reset', kind: 'reduction', completesReset: 'gate-closed',
      apply: (current) => ({
        ...contentOf(current),
        enrolledStoreId: null,
        selection: 'external',
        enrollment: null,
        active: null,
        lastKnownGood: null,
        retiredInstances: current.enrolledStoreId
          ? [...current.retiredInstances, { storeId: current.enrolledStoreId, retiredAt: new Date().toISOString() }]
          : current.retiredInstances,
      }),
    };
  },
  disable(storeId: StoreId, key: VersionKey, reason: DisabledReason): ControlChange {
    return {
      label: `disable ${reason}`, kind: 'reduction',
      apply: (current) => ({ ...contentOf(current), disabled: [...current.disabled, { storeId, key, reason, at: new Date().toISOString() }] }),
    };
  },
  setActive(storeId: StoreId, key: VersionKey): ControlChange {
    return { label: 'active', kind: 'increase', apply: (current) => ({ ...contentOf(current), active: { storeId, key } }) };
  },
};

export function contentOf(record: ControlRecord): ControlContent {
  return {
    enrolledStoreId: record.enrolledStoreId,
    selection: record.selection,
    enrollment: record.enrollment,
    scheduler: record.scheduler,
    activationConsents: record.activationConsents,
    active: record.active,
    lastKnownGood: record.lastKnownGood,
    disabled: record.disabled,
    retiredInstances: record.retiredInstances,
    decidedAt: record.decidedAt,
  };
}

// ---- Instances --------------------------------------------------------------------------------

interface InstanceState {
  ref: InstanceRef;
  gate: 'open' | 'closed';
  heldHandles: number;
  snapshots: InstanceSnapshot[];
  unusable?: { reason: 'store-corrupt' | 'store-newer-schema'; detail: string };
}

export interface FakeLease extends Lease {
  record: LeaseRecord;
  createdWhileGateHeld: boolean;
  released: boolean;
}

export class FakeInstanceStore implements InstanceStoreApi {
  readonly root: string;
  private readonly states = new Map<StoreId, InstanceState>();
  readonly leases: FakeLease[] = [];
  /** Overrides `usageBytes` for the cap tests. */
  usage: number | undefined;
  /** Runs after `apply` and before the commit of an instance publication: another window may publish here. */
  beforeCommit: ((change: InstanceChange) => void | Promise<void>) | undefined;
  /** Replaces the promotion's own result, for its failure classes. */
  promoteOverride: ((facts: PromotedVersion) => Promotion | undefined) | undefined;

  constructor(private readonly recorder: Recorder = [], root?: string) {
    this.root = root ?? mkdtempSync(path.join(tmpdir(), 'unode-pipeline-'));
    mkdirSync(path.join(this.root, 'instances'), { recursive: true });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  gateOf(storeId: StoreId): AdmissionGateState {
    return this.states.get(storeId)?.gate ?? 'missing';
  }

  heldHandles(storeId: StoreId): number {
    return this.states.get(storeId)?.heldHandles ?? 0;
  }

  private state(ref: InstanceRef): InstanceState {
    const state = this.states.get(ref.storeId);
    if (!state) throw Object.assign(new Error(`no instance ${ref.storeId}`), { code: 'ENOENT' });
    return state;
  }

  async create(): Promise<{ ok: true; ref: InstanceRef } | { ok: false; detail: string }> {
    const storeId = newStoreToken();
    const root = path.join(this.root, 'instances', storeId);
    mkdirSync(root);
    for (const folder of ['versions', 'staging', 'leases', 'manifests']) mkdirSync(path.join(root, folder));
    const ref: InstanceRef = Object.freeze({ storeId, root });
    const record: InstanceRecord = {
      schema: 'unodeai.cli-instance/1', storeId, generation: 1, previousRecordDigest: null,
      versions: {}, probes: {}, stagingIntents: {}, schedule: {},
    };
    this.states.set(storeId, { ref, gate: 'open', heldHandles: 0, snapshots: [Object.freeze({ generation: 1, record, digest: recordDigest(record) })] });
    return { ok: true, ref };
  }

  open(storeId: StoreId): InstanceOpen {
    const state = this.states.get(storeId);
    return state ? { ok: true, ref: state.ref } : { ok: false, reason: 'missing', detail: 'no such instance' };
  }

  admissionState(ref: InstanceRef): AdmissionGateState {
    return this.gateOf(ref.storeId);
  }

  acquireAdmission(ref: InstanceRef): AdmissionAcquire {
    const state = this.states.get(ref.storeId);
    if (!state || state.gate === 'closed') return { ok: false, reason: 'closed', detail: 'the admission gate is closed' };
    state.heldHandles++;
    this.recorder.push('gate:acquired');
    let released = false;
    return {
      ok: true,
      handle: {
        storeId: ref.storeId,
        release: () => {
          if (released) return;
          released = true;
          state.heldHandles--;
          this.recorder.push('gate:released');
        },
      },
    };
  }

  async closeAdmission(ref: InstanceRef): Promise<AdmissionClose> {
    const state = this.state(ref);
    if (state.gate === 'closed') return { ok: true, alreadyClosed: true };
    // Windows refuses the rename while a handle is held.
    if (state.heldHandles > 0) return { ok: false, code: 'EPERM', attempts: 30 };
    state.gate = 'closed';
    return { ok: true, alreadyClosed: false };
  }

  read(ref: InstanceRef): InstanceView {
    const state = this.states.get(ref.storeId);
    if (!state) return { kind: 'unusable', reason: 'missing', detail: 'no such instance' };
    if (state.unusable) return { kind: 'unusable', ...state.unusable };
    return { kind: 'readable', snapshot: state.snapshots[state.snapshots.length - 1] };
  }

  /** The newest record, for assertions. */
  record(ref: InstanceRef): InstanceRecord {
    const view = this.read(ref);
    if (view.kind !== 'readable') throw new Error('unreadable');
    return view.snapshot.record;
  }

  makeUnusable(ref: InstanceRef, reason: 'store-corrupt' | 'store-newer-schema'): void {
    this.state(ref).unusable = { reason, detail: reason };
  }

  async publish(ref: InstanceRef, change: InstanceChange): Promise<InstancePublishResult> {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      const view = this.read(ref);
      if (view.kind !== 'readable') return { outcome: 'unusable', view };
      const predecessor = view.snapshot;
      const applied = change.apply(predecessor.record);
      if ('moot' in applied) return { outcome: 'moot', snapshot: predecessor };
      if ('refused' in applied) return { outcome: 'refused', reason: applied.refused };
      // Without a race hook the commit follows `apply` at once, as one window's publication does.
      if (this.beforeCommit) await this.beforeCommit(change);
      const state = this.state(ref);
      if (state.snapshots[state.snapshots.length - 1] !== predecessor) continue;
      const record: InstanceRecord = {
        ...structuredClone(applied),
        schema: 'unodeai.cli-instance/1',
        storeId: ref.storeId,
        generation: predecessor.generation + 1,
        previousRecordDigest: predecessor.digest,
      };
      const snapshot: InstanceSnapshot = Object.freeze({ generation: record.generation, record, digest: recordDigest(record) });
      state.snapshots.push(snapshot);
      this.recorder.push(`instance:${change.label}`);
      return { outcome: 'published', snapshot };
    }
    return { outcome: 'busy' };
  }

  versionFolder(ref: InstanceRef, key: VersionKey): string {
    return path.join(this.state(ref).ref.root, 'versions', key);
  }

  listVersionFolders(ref: InstanceRef): VersionKey[] {
    return readdirSync(path.join(this.state(ref).ref.root, 'versions'));
  }

  stagingFolders(ref: InstanceRef): string[] {
    return readdirSync(path.join(this.state(ref).ref.root, 'staging'));
  }

  createStaging(ref: InstanceRef, taskToken: string): StagingFolder {
    const root = path.join(this.state(ref).ref.root, 'staging', taskToken);
    // Created without any parent, as the contract says.
    mkdirSync(root);
    mkdirSync(path.join(root, 'payload'));
    this.recorder.push('staging:created');
    return Object.freeze({ storeId: ref.storeId, taskToken, root, artifact: path.join(root, 'artifact.part'), payload: path.join(root, 'payload') });
  }

  async discardStaging(staging: StagingFolder): Promise<void> {
    rmSync(staging.root, { recursive: true, force: true });
    this.recorder.push('staging:discarded');
  }

  async promote(ref: InstanceRef, staging: StagingFolder, facts: PromotedVersion): Promise<Promotion> {
    this.recorder.push(`promote:${facts.key}`);
    const override = this.promoteOverride?.(facts);
    if (override) return override;
    const view = this.read(ref);
    if (view.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: view.reason };
    const existing = view.snapshot.record.versions[facts.key];
    if (existing) {
      if (existing.artifactSha256 !== facts.artifactSha256) return { ok: false, reason: 'different-artifact', detail: 'another artifact has this key' };
      return { ok: true, key: facts.key, alreadyPromoted: true, snapshot: view.snapshot };
    }
    const target = this.versionFolder(ref, facts.key);
    if (existsSync(target)) return { ok: false, reason: 'rename-failed', detail: 'a folder of that key exists' };
    renameSync(staging.payload, target);
    const published = await this.publish(ref, {
      label: 'promote',
      apply: (current) => current.versions[facts.key]
        ? { moot: true }
        : { versions: { ...current.versions, [facts.key]: facts }, probes: current.probes, stagingIntents: current.stagingIntents, schedule: current.schedule },
    });
    if (published.outcome === 'moot') return { ok: true, key: facts.key, alreadyPromoted: true, snapshot: published.snapshot };
    if (published.outcome !== 'published') return { ok: false, reason: 'publish-failed', detail: published.outcome };
    return { ok: true, key: facts.key, alreadyPromoted: false, snapshot: published.snapshot };
  }

  createLease(ref: InstanceRef, key: VersionKey, kind: LeaseKind, holder: ProcessIdentity): Lease {
    const state = this.state(ref);
    const token = newStoreToken();
    const createdWhileGateHeld = state.heldHandles > 0;
    const lease: FakeLease = {
      ref, key, token, createdWhileGateHeld, released: false,
      record: { leaseToken: token, storeId: ref.storeId, key, kind, holder, child: 'none', createdAt: new Date().toISOString() },
    };
    this.leases.push(lease);
    this.recorder.push(`lease:created:${kind}:${createdWhileGateHeld ? 'gate-held' : 'gate-free'}`);
    return lease;
  }

  recordLeaseChild(lease: Lease, child: ProcessIdentity): void {
    const found = this.leases.find((item) => item.token === lease.token);
    if (found) found.record = { ...found.record, child };
  }

  releaseLease(lease: Lease): void {
    const found = this.leases.find((item) => item.token === lease.token);
    if (found) found.released = true;
    this.recorder.push('lease:released');
  }

  async leaseLiveness(ref: InstanceRef, key: VersionKey): Promise<Liveness> {
    return this.leases.some((lease) => lease.ref.storeId === ref.storeId && lease.key === key && !lease.released) ? 'alive' : 'dead';
  }

  createWorkFolder(ref: InstanceRef, token: string): WorkFolder {
    const root = path.join(this.root, 'work', ref.storeId, token);
    mkdirSync(root, { recursive: true });
    return { storeId: ref.storeId, token, root, cwd: path.join(root, 'cwd'), tmp: path.join(root, 'tmp'), home: path.join(root, 'home') };
  }

  async removeWorkFolder(folder: WorkFolder): Promise<void> {
    rmSync(folder.root, { recursive: true, force: true });
  }

  async usageBytes(ref: InstanceRef): Promise<number> {
    if (this.usage !== undefined) return this.usage;
    let total = 0;
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(child);
        else total += statSync(child).size;
      }
    };
    walk(this.state(ref).ref.root);
    return total;
  }

  async collectVersions(_ref: InstanceRef, _input: VersionCollectionInput): Promise<VersionCollectionReport> {
    throw new Error('version collection is not the pipeline\'s');
  }

  async retireOrphans(_ref: InstanceRef): Promise<VersionKey[]> {
    throw new Error('orphan retirement is not the pipeline\'s');
  }

  async collectInstances(): Promise<StoreId[]> {
    throw new Error('instance collection is not the pipeline\'s');
  }

  repairManifest(): ManifestRepair {
    throw new Error('manifest repair is not the pipeline\'s');
  }

  async retireVersion(): Promise<VersionRetirement> {
    throw new Error('retiring a version is not the pipeline\'s');
  }
}
