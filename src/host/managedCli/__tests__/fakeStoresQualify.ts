/*
 * An in-memory model of the control store and the instance store, for the qualification tests. It follows the
 * documented behaviour of `ControlStoreApi` and `InstanceStoreApi` (contracts.ts):
 * - control: exact-predecessor CAS with `apply` re-evaluated on each fresh predecessor (up to 5 rounds, then `busy`);
 *   `expected` → `stale`; `fresh` / `unusable` refusals; a present suspension (any content, unreadable included)
 *   refuses increases; `behind-floor` admits only a `redecision` reduction; a pending Reset (the enrolled instance's
 *   gate seen closed) admits only `completesReset`; a reduction takes `E = min(max(P, F) + 1, 4095)` and raises the
 *   floor before it is reported; an increase keeps `P`;
 * - instances: the admission gate (a held handle makes the close fail, as Windows refuses the rename), CAS-published
 *   manifests holding positive facts only, leases with liveness (unknown counts as alive), work folders, and the
 *   additive `retireVersion(ref, key)` that Try again needs (refused while a lease is alive or unknown).
 * Every published generation is durable at once: a "crash" is a test that stops before the next step.
 * Several "windows" share one world: each gets its own clients, so a change in one is visible in the other.
 */

import * as path from 'node:path';
import type {
  AdmissionAcquire,
  AdmissionClose,
  AdmissionGateState,
  ControlChange,
  ControlChangeKind,
  ControlContent,
  ControlPublishResult,
  ControlRecord,
  ControlStoreApi,
  ControlUnusableReason,
  ControlView,
  InstanceChange,
  InstanceContent,
  InstanceOpen,
  InstancePublishResult,
  InstanceRecord,
  InstanceRef,
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
  VersionCollectionReport,
  VersionKey,
  VersionRetirement,
  ManifestRepair,
  WorkFolder,
} from '../contracts';
import { recordDigest } from '../storeLayout';

export type FakeSuspension = { kind: 'absent' } | { kind: 'readable'; reason: string; decidedAt: string } | { kind: 'unreadable' };

export interface ControlPublication {
  window: string;
  label: string;
  kind: ControlChangeKind;
  outcome: ControlPublishResult['outcome'];
  generation?: number;
  epoch?: number;
}

export interface InstancePublication {
  window: string;
  storeId: StoreId;
  label: string;
  outcome: InstancePublishResult['outcome'];
  generation?: number;
}

export interface FakeInstanceState {
  readonly storeId: StoreId;
  readonly root: string;
  gate: AdmissionGateState;
  held: number;
  readonly generations: InstanceRecord[];
  readonly folders: Set<VersionKey>;
  readonly leases: Map<string, { lease: Lease; record: LeaseRecord; liveness: Liveness }>;
  readonly work: Map<string, WorkFolder>;
  unusable?: { reason: 'store-corrupt' | 'store-newer-schema' | 'missing'; detail: string };
  failLease?: boolean;
  /** The gate's identity read names another instance. */
  foreignGate?: boolean;
}

export interface FakeHooks {
  /** Called inside a control publication after `apply`, before the link: another window may publish here. */
  controlBeforeLink?: (change: ControlChange, window: string, round: number) => void;
  /** Return true to stop the window at the start of this control publication (the call throws; nothing is written). */
  controlCrash?: (change: ControlChange, window: string) => boolean;
  instanceBeforeLink?: (change: InstanceChange, window: string, round: number) => void;
  instanceCrash?: (change: InstanceChange, window: string) => boolean;
  onControlRead?: (window: string) => void;
  onSuspensionRead?: (window: string) => void;
  afterLeaseCreated?: (lease: Lease, window: string) => void;
}

const CONTROL_ID = 'c0'.repeat(16);
const REASONS = new Set(['local-bad', 'probe-failed', 'probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn']);

export class FakeWorld {
  readonly root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'fake', 'cli-store');
  readonly events: string[] = [];
  readonly controlGenerations: ControlRecord[] = [];
  floor = 0;
  suspension: FakeSuspension = { kind: 'absent' };
  controlUnusable?: { reason: ControlUnusableReason; detail: string };
  readonly controlPublications: ControlPublication[] = [];
  readonly instancePublications: InstancePublication[] = [];
  readonly instances = new Map<StoreId, FakeInstanceState>();
  /** The closure digest the files of each version folder give now; absent means the folder is unreadable. */
  readonly folderDigests = new Map<string, string>();
  /** The closure digest a staging payload's files give, set by the download. */
  readonly stagedDigests = new Map<string, string>();
  hooks: FakeHooks = {};
  private tokens = 0;
  private clock = 0;

  token(): string {
    this.tokens += 1;
    return this.tokens.toString(16).padStart(32, '0');
  }

  now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 21, 0, 0, this.clock)).toISOString();
  }

  control(window = 'w1'): FakeControlStore {
    return new FakeControlStore(this, window);
  }

  instance(window = 'w1'): FakeInstanceStore {
    return new FakeInstanceStore(this, window);
  }

  addInstance(): InstanceRef {
    const storeId = this.token().replace(/^0+/, (zeros) => 'a'.repeat(zeros.length));
    const root = path.join(this.root, 'instances', storeId);
    this.instances.set(storeId, {
      storeId,
      root,
      gate: 'open',
      held: 0,
      generations: [{ schema: 'unodeai.cli-instance/1', storeId, generation: 1, previousRecordDigest: null, versions: {}, probes: {}, stagingIntents: {}, schedule: {} }],
      folders: new Set(),
      leases: new Map(),
      work: new Map(),
    });
    return { storeId, root };
  }

  instanceState(ref: InstanceRef | StoreId): FakeInstanceState {
    const state = this.instances.get(typeof ref === 'string' ? ref : ref.storeId);
    if (!state) throw new Error('no such fake instance');
    return state;
  }

  /** The newest control record (a copy). */
  controlRecord(): ControlRecord {
    const record = this.controlGenerations[this.controlGenerations.length - 1];
    if (!record) throw new Error('control is fresh');
    return structuredClone(record);
  }

  instanceRecord(ref: InstanceRef): InstanceRecord {
    const state = this.instanceState(ref);
    return structuredClone(state.generations[state.generations.length - 1]);
  }

  /** Writes a control generation directly, as a test's setup (another UnodeAi's earlier decisions). */
  writeControl(kind: ControlChangeKind, change: (content: ControlContent) => ControlContent): void {
    const previous = this.controlGenerations[this.controlGenerations.length - 1];
    const content = change(previous ? pickControlContent(previous) : emptyControl(this.now()));
    const P = previous?.reductionEpoch ?? 0;
    const epoch = kind === 'reduction' ? Math.min(Math.max(P, this.floor) + 1, 4095) : P;
    const record: ControlRecord = {
      schema: 'unodeai.cli-control/1',
      controlId: CONTROL_ID,
      generation: (previous?.generation ?? 0) + 1,
      previousRecordDigest: previous ? recordDigest(previous) : null,
      reductionEpoch: epoch,
      ...structuredClone(content),
    };
    this.controlGenerations.push(record);
    if (kind === 'reduction') this.floor = Math.max(this.floor, epoch);
  }

  /** Writes an instance generation directly, as a test's setup. */
  writeInstance(ref: InstanceRef, change: (content: InstanceContent) => InstanceContent): void {
    const state = this.instanceState(ref);
    const previous = state.generations[state.generations.length - 1];
    state.generations.push({
      schema: 'unodeai.cli-instance/1',
      storeId: state.storeId,
      generation: previous.generation + 1,
      previousRecordDigest: recordDigest(previous),
      ...structuredClone(change(pickInstanceContent(previous))),
    });
  }

  /** The newest control generation is lost after it was reported (power loss); the floor keeps its epoch. */
  loseNewestControlGeneration(): void {
    this.controlGenerations.pop();
  }

  /** The newest instance generation is lost. */
  loseNewestInstanceGeneration(ref: InstanceRef): void {
    const state = this.instanceState(ref);
    if (state.generations.length > 1) state.generations.pop();
  }

  controlView(): ControlView {
    if (this.controlUnusable) return { kind: 'unusable', reason: this.controlUnusable.reason, detail: this.controlUnusable.detail };
    const last = this.controlGenerations[this.controlGenerations.length - 1];
    if (!last) return { kind: 'fresh' };
    const record = structuredClone(last);
    const snapshot = { generation: record.generation, record, digest: recordDigest(record) };
    if (record.sealed || this.floor >= 4095) return { kind: 'unusable', reason: 'sealed', detail: 'the floor is sealed', snapshot };
    return { kind: 'readable', authority: record.reductionEpoch < this.floor ? 'behind-floor' : 'ok', snapshot, floor: this.floor };
  }

  suspensionView(): SuspensionView {
    if (this.suspension.kind === 'absent') return { present: false };
    if (this.suspension.kind === 'unreadable') return { present: true, readable: false };
    return { present: true, readable: true, reason: this.suspension.reason, decidedAt: this.suspension.decidedAt };
  }

  /** Every lease currently held on a key, across windows. */
  leasesOn(ref: InstanceRef, key: VersionKey): LeaseRecord[] {
    return [...this.instanceState(ref).leases.values()].filter((entry) => entry.record.key === key).map((entry) => entry.record);
  }
}

export function emptyControl(decidedAt: string): ControlContent {
  return {
    enrolledStoreId: null,
    selection: 'external',
    enrollment: null,
    scheduler: { epoch: 0, autoMode: false },
    activationConsents: [],
    active: null,
    lastKnownGood: null,
    disabled: [],
    retiredInstances: [],
    decidedAt,
  };
}

function pickControlContent(record: ControlContent): ControlContent {
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

function pickInstanceContent(record: InstanceContent): InstanceContent {
  return { versions: record.versions, probes: record.probes, stagingIntents: record.stagingIntents, schedule: record.schedule };
}

/** The record invariants the real control parser holds (the ones these tests can reach). */
function controlProblem(content: ControlContent): string | undefined {
  if (content.selection === 'managed' && !content.enrolledStoreId) return 'managed without an enrolled instance';
  if ((content.enrollment === null) !== (content.enrolledStoreId === null)) return 'enrollment and enrolled instance disagree';
  for (const version of [content.active, content.lastKnownGood]) {
    if (version && version.storeId !== content.enrolledStoreId) return 'active or last-known-good names another instance';
  }
  for (const entry of content.disabled) if (!REASONS.has(entry.reason)) return `unknown disabled reason ${entry.reason}`;
  return undefined;
}

export class FakeControlStore implements ControlStoreApi {
  constructor(private readonly world: FakeWorld, readonly window: string) {}

  read(): ControlView {
    this.world.events.push(`${this.window}:control.read`);
    this.world.hooks.onControlRead?.(this.window);
    return this.world.controlView();
  }

  readSuspension(): SuspensionView {
    this.world.events.push(`${this.window}:suspension.read`);
    this.world.hooks.onSuspensionRead?.(this.window);
    return this.world.suspensionView();
  }

  async initialize(): Promise<ControlPublishResult> {
    const view = this.world.controlView();
    if (view.kind !== 'fresh') return view.kind === 'readable' ? { outcome: 'moot', snapshot: view.snapshot } : { outcome: 'unusable', view };
    this.world.writeControl('increase', (content) => content);
    const after = this.world.controlView();
    return after.kind === 'readable' ? { outcome: 'published', snapshot: after.snapshot } : { outcome: 'unusable', view: after };
  }

  async publish(change: ControlChange): Promise<ControlPublishResult> {
    const world = this.world;
    const log = (result: ControlPublishResult, extra: Partial<ControlPublication> = {}): ControlPublishResult => {
      world.controlPublications.push({ window: this.window, label: change.label, kind: change.kind, outcome: result.outcome, ...extra });
      world.events.push(`${this.window}:control.publish:${change.label}:${change.kind}:${result.outcome}`);
      return result;
    };
    if (world.hooks.controlCrash?.(change, this.window)) throw new Error('the window stopped');
    for (let round = 1; round <= 5; round++) {
      const view = world.controlView();
      if (view.kind === 'unusable') return log({ outcome: 'unusable', view });
      if (view.kind === 'fresh') return log({ outcome: 'refused', reason: 'control is not initialized' });
      const snapshot = view.snapshot;
      if (change.expected && (change.expected.generation !== snapshot.generation || change.expected.digest !== snapshot.digest)) {
        return log({ outcome: 'stale', snapshot });
      }
      if (world.suspensionView().present && change.kind === 'increase') return log({ outcome: 'refused', reason: 'managed Codex is suspended', snapshot });
      if (view.authority === 'behind-floor' && !(change.redecision === true && change.kind === 'reduction')) {
        return log({ outcome: 'refused', reason: 'behind the floor', snapshot });
      }
      const enrolled = snapshot.record.enrolledStoreId;
      if (enrolled && world.instances.get(enrolled)?.gate === 'closed' && change.completesReset === undefined) {
        return log({ outcome: 'refused', reason: 'a Reset is pending', snapshot });
      }
      const applied = change.apply(structuredClone(snapshot.record));
      if ('moot' in applied) return log({ outcome: 'moot', snapshot });
      if ('refused' in applied) return log({ outcome: 'refused', reason: applied.refused, snapshot });
      const content = pickControlContent(applied);
      const problem = controlProblem(content);
      if (problem) return log({ outcome: 'refused', reason: problem, snapshot });
      world.hooks.controlBeforeLink?.(change, this.window, round);
      if (world.controlGenerations.length !== snapshot.generation || world.controlUnusable) continue;
      const P = snapshot.record.reductionEpoch;
      const epoch = change.kind === 'reduction' ? Math.min(Math.max(P, world.floor) + 1, 4095) : P;
      const record: ControlRecord = {
        schema: 'unodeai.cli-control/1',
        controlId: CONTROL_ID,
        generation: snapshot.generation + 1,
        previousRecordDigest: snapshot.digest,
        reductionEpoch: epoch,
        ...(epoch === 4095 || snapshot.record.sealed ? { sealed: true as const } : {}),
        ...structuredClone(content),
      };
      world.controlGenerations.push(record);
      // The floor record is written in both regions before the change is reported.
      if (change.kind === 'reduction') world.floor = Math.max(world.floor, epoch);
      const published = world.controlView();
      if (published.kind !== 'readable' && published.kind !== 'unusable') throw new Error('unreachable');
      return log({ outcome: 'published', snapshot: published.snapshot as NonNullable<typeof published.snapshot> }, { generation: record.generation, epoch });
    }
    return log({ outcome: 'busy' });
  }

  async suspend(reason: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (this.world.suspension.kind === 'absent') this.world.suspension = { kind: 'readable', reason, decidedAt: this.world.now() };
    this.world.events.push(`${this.window}:suspend`);
    return { ok: true };
  }

  async clearSuspension(): Promise<{ ok: true } | { ok: false; detail: string }> {
    const view = this.world.controlView();
    if (view.kind !== 'readable' || view.authority !== 'ok') return { ok: false, detail: 'control is not ok' };
    this.world.suspension = { kind: 'absent' };
    return { ok: true };
  }
}

export class FakeInstanceStore implements InstanceStoreApi {
  constructor(private readonly world: FakeWorld, readonly window: string) {}

  private event(name: string): void {
    this.world.events.push(`${this.window}:${name}`);
  }

  private state(ref: InstanceRef): FakeInstanceState {
    return this.world.instanceState(ref);
  }

  async create(): Promise<{ ok: true; ref: InstanceRef } | { ok: false; detail: string }> {
    return { ok: true, ref: this.world.addInstance() };
  }

  open(storeId: StoreId): InstanceOpen {
    const state = this.world.instances.get(storeId);
    return state ? { ok: true, ref: { storeId, root: state.root } } : { ok: false, reason: 'missing', detail: 'no such instance' };
  }

  admissionState(ref: InstanceRef): AdmissionGateState {
    return this.world.instances.get(ref.storeId)?.gate ?? 'missing';
  }

  acquireAdmission(ref: InstanceRef): AdmissionAcquire {
    this.event('gate.acquire');
    const state = this.world.instances.get(ref.storeId);
    if (!state) return { ok: false, reason: 'unreadable', detail: 'the instance is missing' };
    if (state.gate !== 'open') return { ok: false, reason: 'closed', detail: 'the admission gate is closed' };
    state.held += 1;
    let released = false;
    const storeId = state.foreignGate ? 'f'.repeat(32) : state.storeId;
    return {
      ok: true,
      handle: {
        storeId,
        release: () => {
          if (released) return;
          released = true;
          state.held -= 1;
          this.event('gate.release');
        },
      },
    };
  }

  async closeAdmission(ref: InstanceRef): Promise<AdmissionClose> {
    this.event('gate.close');
    const state = this.state(ref);
    if (state.held > 0) return { ok: false, code: 'EPERM', attempts: 30 };
    if (state.gate === 'closed') return { ok: true, alreadyClosed: true };
    state.gate = 'closed';
    return { ok: true, alreadyClosed: false };
  }

  read(ref: InstanceRef): InstanceView {
    this.event('instance.read');
    const state = this.world.instances.get(ref.storeId);
    if (!state) return { kind: 'unusable', reason: 'missing', detail: 'the instance is missing' };
    if (state.unusable) return { kind: 'unusable', ...state.unusable };
    const record = structuredClone(state.generations[state.generations.length - 1]);
    return { kind: 'readable', snapshot: { generation: record.generation, record, digest: recordDigest(record) } };
  }

  async publish(ref: InstanceRef, change: InstanceChange): Promise<InstancePublishResult> {
    const world = this.world;
    const state = this.state(ref);
    const log = (result: InstancePublishResult, generation?: number): InstancePublishResult => {
      world.instancePublications.push({ window: this.window, storeId: state.storeId, label: change.label, outcome: result.outcome, ...(generation ? { generation } : {}) });
      world.events.push(`${this.window}:instance.publish:${change.label}:${result.outcome}`);
      return result;
    };
    if (world.hooks.instanceCrash?.(change, this.window)) throw new Error('the window stopped');
    for (let round = 1; round <= 5; round++) {
      if (state.unusable) return log({ outcome: 'unusable', view: { kind: 'unusable', ...state.unusable } });
      const previous = state.generations[state.generations.length - 1];
      const applied = change.apply(structuredClone(previous));
      if ('moot' in applied) return log({ outcome: 'moot', snapshot: { generation: previous.generation, record: structuredClone(previous), digest: recordDigest(previous) } });
      if ('refused' in applied) return log({ outcome: 'refused', reason: applied.refused });
      const content = pickInstanceContent(applied);
      for (const [key, probe] of Object.entries(content.probes)) {
        if (!content.versions[key] || probe.key !== key) return log({ outcome: 'refused', reason: 'a probe fact names a version without facts' });
      }
      world.hooks.instanceBeforeLink?.(change, this.window, round);
      if (state.generations[state.generations.length - 1] !== previous || state.unusable) continue;
      const record: InstanceRecord = {
        schema: 'unodeai.cli-instance/1',
        storeId: state.storeId,
        generation: previous.generation + 1,
        previousRecordDigest: recordDigest(previous),
        ...structuredClone(content),
      };
      state.generations.push(record);
      return log({ outcome: 'published', snapshot: { generation: record.generation, record: structuredClone(record), digest: recordDigest(record) } }, record.generation);
    }
    return log({ outcome: 'busy' });
  }

  versionFolder(ref: InstanceRef, key: VersionKey): string {
    return path.join(this.state(ref).root, 'versions', key);
  }

  listVersionFolders(ref: InstanceRef): VersionKey[] {
    return [...this.state(ref).folders];
  }

  createStaging(ref: InstanceRef, taskToken: string): StagingFolder {
    const root = path.join(this.state(ref).root, 'staging', taskToken);
    return { storeId: ref.storeId, taskToken, root, artifact: path.join(root, 'artifact.part'), payload: path.join(root, 'payload') };
  }

  async discardStaging(): Promise<void> {
    /* nothing to delete in memory */
  }

  async promote(ref: InstanceRef, staging: StagingFolder, facts: PromotedVersion): Promise<Promotion> {
    this.event('promote');
    const state = this.state(ref);
    const folder = this.versionFolder(ref, facts.key);
    if (state.folders.has(facts.key)) {
      const current = state.generations[state.generations.length - 1];
      const existing = current.versions[facts.key];
      if (existing && existing.artifactSha256 === facts.artifactSha256) {
        return { ok: true, key: facts.key, alreadyPromoted: true, snapshot: { generation: current.generation, record: structuredClone(current), digest: recordDigest(current) } };
      }
      return { ok: false, reason: 'different-artifact', detail: 'another artifact holds this key' };
    }
    state.folders.add(facts.key);
    this.world.folderDigests.set(folder, this.world.stagedDigests.get(staging.root) ?? 'unknown-files');
    const published = await this.publish(ref, {
      label: 'promote',
      apply: (current) => ({ ...pickInstanceContent(current), versions: { ...current.versions, [facts.key]: facts } }),
    });
    if (published.outcome !== 'published' && published.outcome !== 'moot') return { ok: false, reason: 'publish-failed', detail: published.outcome };
    return { ok: true, key: facts.key, alreadyPromoted: false, snapshot: published.snapshot };
  }

  createLease(ref: InstanceRef, key: VersionKey, kind: LeaseKind, holder: ProcessIdentity): Lease {
    this.event(`lease.create:${kind}`);
    const state = this.state(ref);
    if (state.failLease) throw new Error('EACCES');
    const token = this.world.token();
    const lease: Lease = { ref, key, token };
    state.leases.set(token, {
      lease,
      record: { leaseToken: token, storeId: ref.storeId, key, kind, holder, child: kind === 'session' || kind === 'probe' ? 'pending' : 'none', createdAt: this.world.now() },
      liveness: 'alive',
    });
    this.world.hooks.afterLeaseCreated?.(lease, this.window);
    return lease;
  }

  recordLeaseChild(lease: Lease, child: ProcessIdentity): void {
    this.event('lease.child');
    const entry = this.state(lease.ref).leases.get(lease.token);
    if (entry) entry.record.child = child;
  }

  releaseLease(lease: Lease): void {
    this.event('lease.release');
    this.state(lease.ref).leases.delete(lease.token);
  }

  async leaseLiveness(ref: InstanceRef, key: VersionKey): Promise<Liveness> {
    const values = [...this.state(ref).leases.values()].filter((entry) => entry.record.key === key).map((entry) => entry.liveness);
    if (values.includes('alive')) return 'alive';
    if (values.includes('unknown')) return 'unknown';
    return 'dead';
  }

  createWorkFolder(ref: InstanceRef, token: string): WorkFolder {
    this.event('work.create');
    const root = path.join(this.world.root, 'work', ref.storeId, token);
    const folder: WorkFolder = { storeId: ref.storeId, token, root, cwd: path.join(root, 'cwd'), tmp: path.join(root, 'tmp'), home: path.join(root, 'home') };
    this.state(ref).work.set(token, folder);
    return folder;
  }

  async removeWorkFolder(folder: WorkFolder): Promise<void> {
    this.event('work.remove');
    this.world.instances.get(folder.storeId)?.work.delete(folder.token);
  }

  async usageBytes(): Promise<number> {
    return 0;
  }

  async collectVersions(): Promise<VersionCollectionReport> {
    return { kept: [], collected: [], restored: [], deferred: [] };
  }

  async retireOrphans(): Promise<VersionKey[]> {
    return [];
  }

  async collectInstances(): Promise<StoreId[]> {
    return [];
  }

  repairManifest(ref: InstanceRef): ManifestRepair {
    return { ok: true, moved: [], view: this.read(ref) };
  }

  async retireVersion(ref: InstanceRef, key: VersionKey): Promise<VersionRetirement> {
    this.event('retire');
    const liveness = await this.leaseLiveness(ref, key);
    if (liveness !== 'dead') return { ok: false, reason: 'in-use', detail: `a lease is ${liveness}` };
    const published = await this.publish(ref, {
      label: 'retire',
      apply: (current) => {
        if (!current.versions[key] && !current.probes[key]) return { moot: true };
        const versions = { ...current.versions };
        const probes = { ...current.probes };
        delete versions[key];
        delete probes[key];
        return { ...pickInstanceContent(current), versions, probes };
      },
    });
    if (published.outcome !== 'published' && published.outcome !== 'moot') return { ok: false, reason: 'store-unusable', detail: published.outcome };
    this.state(ref).folders.delete(key);
    this.world.folderDigests.delete(this.versionFolder(ref, key));
    return { ok: true, key };
  }
}
