/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the managed Codex store's shared types (v0.9.97)
 *  The store is `%LOCALAPPDATA%\UnodeAi\cli-store\`. One fixed control journal says which store instance, if any, is
 *  enrolled, whether new sessions use it, and every decision that can take launch authority away. Each enrolment
 *  creates a new instance folder, named by a random store id that is never used again, so a path derived from one
 *  instance can never denote another. An instance's own manifest holds positive facts only (what was downloaded and
 *  checked, which probe passed): losing one of them can make UnodeAi check again, never let anything run.
 *
 *  These types are shared by the control store, the instance store, the launcher and the updater. Only the instance
 *  store derives instance paths; every other module holds an `InstanceRef`.
 *--------------------------------------------------------------------------------------------*/

/** 32 lowercase hex digits; random, chosen once per instance, never reused. */
export type StoreId = string;

/** A version folder's name: `<version>-<os>-<arch>-<first 16 hex digits of the artifact SHA-256>`. */
export type VersionKey = string;

export interface ManagedVersionRef {
  storeId: StoreId;
  key: VersionKey;
}

// ---- The control journal ----------------------------------------------------------------------

/**
 * Why a version of an instance must not run. Adding an entry is a reduction of authority. No automatic action ever
 * removes one; only the user's explicit **Check again** (`probe-stop-unconfirmed`) or **Try again** (`local-bad`),
 * after their positive facts are published, removes the matching entry.
 */
export type DisabledReason = 'local-bad' | 'probe-failed' | 'probe-stop-unconfirmed' | 'policy-bad' | 'consent-withdrawn';

export interface DisabledEntry extends ManagedVersionRef {
  /** The closure the decision was about, when one was hashed. */
  closureDigest?: string;
  reason: DisabledReason;
  /** A bounded, user-readable reason. */
  detail?: string;
  at: string;
}

/** The user's click for one exact version of one instance: it covers this closure only. */
export interface ActivationConsent extends ManagedVersionRef {
  closureDigest: string;
  decidedAt: string;
}

/** The fields a change may set. The store itself sets the schema, the journal chain and the reduction epoch. */
export interface ControlContent {
  enrolledStoreId: StoreId | null;
  /** `managed` only with an enrolled instance. Choosing External keeps the instance; only Reset retires it. */
  selection: 'managed' | 'external';
  /** `epoch` increases when a consented host is removed. Null exactly when no instance is enrolled. */
  enrollment: { epoch: number; consentedHosts: string[]; decidedAt: string } | null;
  /** `epoch` increases when automatic mode is turned off. */
  scheduler: { epoch: number; autoMode: boolean };
  activationConsents: ActivationConsent[];
  active: ManagedVersionRef | null;
  lastKnownGood: ManagedVersionRef | null;
  disabled: DisabledEntry[];
  /** Instances a Reset retired, with when; an entry is dropped once its instance is collected. */
  retiredInstances: Array<{ storeId: StoreId; retiredAt: string }>;
  decidedAt: string;
}

export interface ControlRecord extends ControlContent {
  schema: 'unodeai.cli-control/1';
  /** Random, chosen when the journal is created; the floor's header carries the same value. */
  controlId: string;
  generation: number;
  previousRecordDigest: string | null;
  reductionEpoch: number;
  sealed?: true;
}

export interface ControlSnapshot {
  readonly generation: number;
  readonly record: ControlRecord;
  /** The record's own digest, which its successor names as `previousRecordDigest`. */
  readonly digest: string;
}

/**
 * Why control cannot be used. In each of these, no managed start, task, probe, download or promotion happens, and
 * the card offers the shared suspension (Use external CLI) instead of any change to control.
 */
export type ControlUnusableReason =
  /** Instances exist, or the floor holds reductions, but no generation can be read. */
  | 'control-missing'
  /** A file above the newest valid generation, a broken chain, or another journal's floor. */
  | 'control-unreadable'
  /** A generation written by a newer UnodeAi. */
  | 'control-newer-schema'
  /** The floor is missing, of the wrong size, or valid in neither header copy. */
  | 'floor-unavailable'
  /** The floor's last position is used: no reduction can be recorded any more. */
  | 'sealed';

export type ControlView =
  /** Nothing is recorded yet: no journal, no floor reduction, no instance folder. It means `(null, external)`. */
  | { kind: 'fresh' }
  /**
   * `behind-floor`: a reported reduction is missing from the newest generation. Only the user's recorded
   * re-decision (a reduction) may be published; nothing managed runs until then.
   */
  | { kind: 'readable'; authority: 'ok' | 'behind-floor'; snapshot: ControlSnapshot; floor: number }
  | { kind: 'unusable'; reason: ControlUnusableReason; detail: string; snapshot?: ControlSnapshot };

export type ControlChangeKind = 'increase' | 'reduction';

export interface ControlChange {
  /** Names the change in diagnostics and error texts. */
  label: string;
  /** Every reduction takes a new floor epoch, written in both floor regions before it is reported. */
  kind: ControlChangeKind;
  /**
   * The change, evaluated against each fresh predecessor. A predecessor that no longer allows it gives `refused`, or
   * `moot` when the predecessor already has its effect. It is never applied to a stale predecessor.
   */
  apply(current: ControlRecord): ControlContent | { moot: true } | { refused: string };
  /** The exact generation the user decided on; any other predecessor refuses (`stale`). */
  expected?: { generation: number; digest: string };
  /**
   * Completes a Reset of the enrolled instance, the only change allowed while its admission gate is closed. Only a
   * gate seen closed, by this Reset or by an interrupted one, completes a Reset: one window's failure to open the
   * instance is no barrier against another window that holds its gate.
   */
  completesReset?: 'gate-closed';
  /** The user's recorded re-decision in `behind-floor`; it must be a reduction. */
  redecision?: true;
}

export type ControlPublishResult =
  | { outcome: 'published'; snapshot: ControlSnapshot }
  | { outcome: 'moot'; snapshot: ControlSnapshot }
  | { outcome: 'refused'; reason: string; snapshot?: ControlSnapshot }
  | { outcome: 'stale'; snapshot: ControlSnapshot }
  | { outcome: 'unusable'; view: ControlView }
  /** Another window won every attempt; nothing was published. */
  | { outcome: 'busy' }
  /**
   * A file step failed, and the change is not reported. `floor`: the generation was published but its floor record
   * was not completely written; `snapshot` is that generation, now current but not protected by the floor.
   */
  | { outcome: 'failed'; step: 'folders' | 'floor' | 'generation'; detail: string; snapshot?: ControlSnapshot };

/**
 * `<cli-store>\managed-suspended.json`. While it exists, whatever its content, and also when it cannot be read, every
 * window refuses every managed start, task, probe, download and promotion. It only removes authority.
 */
export type SuspensionView =
  | { present: false }
  | { present: true; readable: boolean; reason?: string; decidedAt?: string; controlState?: string };

export interface ControlStoreApi {
  read(): ControlView;
  readSuspension(): SuspensionView;
  /** Creates the floor and the journal's first generation, `(null, external)`, when nothing is recorded yet. */
  initialize(): Promise<ControlPublishResult>;
  publish(change: ControlChange): Promise<ControlPublishResult>;
  /** Created `wx`; reported only after its bytes were flushed. `EEXIST` is success. Writes nothing else. */
  suspend(reason: string, controlState: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Only while control reads `ok`; the user's explicit action. Publishes nothing. */
  clearSuspension(): Promise<{ ok: true } | { ok: false; detail: string }>;
}

// ---- Instances --------------------------------------------------------------------------------

/** A handle on one instance. Its `root` is derived by the instance store from the store id alone. */
export interface InstanceRef {
  readonly storeId: StoreId;
  readonly root: string;
}

export type InstanceOpen =
  | { ok: true; ref: InstanceRef }
  | { ok: false; reason: 'missing' | 'identity-mismatch' | 'identity-unreadable'; detail: string };

export type AdmissionGateState = 'open' | 'closed' | 'missing';

/**
 * A read handle on `admission\open\guard.bin`, through which the instance's identity was read. While any process
 * holds one, Windows refuses the rename that closes the gate, so a launch admitted under it starts only from this
 * instance.
 */
export interface AdmissionHandle {
  readonly storeId: StoreId;
  release(): void;
}

export type AdmissionAcquire =
  | { ok: true; handle: AdmissionHandle }
  | { ok: false; reason: 'closed' | 'identity-mismatch' | 'unreadable'; detail: string };

export type AdmissionClose =
  | { ok: true; alreadyClosed: boolean }
  /** The rename kept failing (a launch holds the gate). Nothing was changed. */
  | { ok: false; code: string; attempts: number };

export type SignatureRevocation = 'confirmed-online' | 'not-confirmed-offline';

/** A promoted version folder and what its download proved: V1 artifact, V2 files, V3 PE sniff, V4 signatures. */
export interface PromotedVersion {
  key: VersionKey;
  provider: 'codex-cli';
  version: string;
  os: 'win32';
  arch: 'x64';
  policyVersion: string;
  policyEntryId: string;
  artifactSha256: string;
  taskToken: string;
  promotedAt: string;
  verification: {
    files: number;
    bytes: number;
    signed: { openai: number; microsoftCrt: number };
    /** Listing paths of the PE files the policy lists as unsigned. */
    unsigned: string[];
    revocation: SignatureRevocation;
  };
}

/** A post-click probe that passed with a confirmed stop. Failures are control `disabled` entries, never facts. */
export interface ProbePass {
  key: VersionKey;
  closureDigest: string;
  versionOutput: string;
  startedAt: string;
  durationMs: number;
}

export interface ProcessIdentity {
  pid: number;
  /** The operating system's creation time of the process, exactly as reported; never a clock estimate. */
  creation: string | 'pending';
}

export type ScheduleFailureClass =
  | 'network' | 'timeout' | 'signature-unavailable'
  | 'integrity' | 'signature' | 'host-not-allowed' | 'store-full' | 'file';

export interface InstanceContent {
  versions: Record<VersionKey, PromotedVersion>;
  probes: Record<VersionKey, ProbePass>;
  /** One per running download task, advisory: a live owner makes another window skip its own task. */
  stagingIntents: Record<string, { key: VersionKey; owner: ProcessIdentity; startedAt: string }>;
  schedule: {
    lastAttemptAt?: string;
    failure?: { class: ScheduleFailureClass; entryId: string; at: string; attempts: number; retryAt?: string; detail: string };
  };
}

export interface InstanceRecord extends InstanceContent {
  schema: 'unodeai.cli-instance/1';
  storeId: StoreId;
  generation: number;
  previousRecordDigest: string | null;
}

export interface InstanceSnapshot {
  readonly generation: number;
  readonly record: InstanceRecord;
  readonly digest: string;
}

export type InstanceView =
  | { kind: 'readable'; snapshot: InstanceSnapshot }
  | { kind: 'unusable'; reason: 'store-corrupt' | 'store-newer-schema' | 'missing'; detail: string };

export interface InstanceChange {
  label: string;
  apply(current: InstanceRecord): InstanceContent | { moot: true } | { refused: string };
}

export type InstancePublishResult =
  | { outcome: 'published'; snapshot: InstanceSnapshot }
  | { outcome: 'moot'; snapshot: InstanceSnapshot }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'unusable'; view: InstanceView }
  | { outcome: 'busy' };

/** One download task's own folder, `staging\<taskToken>\`, created without creating any parent. */
export interface StagingFolder {
  readonly storeId: StoreId;
  readonly taskToken: string;
  readonly root: string;
  /** The download is written here, opened `wx`. */
  readonly artifact: string;
  /** The archive is extracted here; renamed to `versions\<key>\` on promotion. */
  readonly payload: string;
}

export type Promotion =
  | { ok: true; key: VersionKey; alreadyPromoted: boolean; snapshot: InstanceSnapshot }
  | { ok: false; reason: 'store-unusable' | 'rename-failed' | 'publish-failed' | 'different-artifact'; detail: string };

export type LeaseKind = 'session' | 'probe' | 'download' | 'maintenance';

export interface LeaseRecord {
  leaseToken: string;
  storeId: StoreId;
  key: VersionKey;
  kind: LeaseKind;
  holder: ProcessIdentity;
  child: ProcessIdentity | 'pending' | 'none';
  createdAt: string;
}

export interface Lease {
  readonly ref: InstanceRef;
  readonly key: VersionKey;
  readonly token: string;
}

/** Dead only with positive proof; a pending, failed or timed-out identity query is `unknown`, which counts as alive. */
export type Liveness = 'alive' | 'dead' | 'unknown';

/** `work\<storeId>\<token>\`: the post-click probe's own folders, outside the instance. */
export interface WorkFolder {
  readonly storeId: StoreId;
  readonly token: string;
  readonly root: string;
  readonly cwd: string;
  readonly tmp: string;
  readonly home: string;
}

export interface VersionCollectionInput {
  /** `active` and `lastKnownGood` from control. Leases are read by the store itself. */
  protectedKeys: ReadonlySet<VersionKey>;
  /** At most this many version folders are kept, protected ones never deleted. */
  keep: number;
}

export interface VersionCollectionReport {
  kept: Array<{ key: VersionKey; why: 'newest' | 'active-or-lkg' | 'lease-alive' | 'lease-unknown' }>;
  /** Renamed to `trash\` and then deleted, completely or partly (the rest waits for a later cycle). */
  collected: VersionKey[];
  /** Renamed back because a lease appeared after the rename. */
  restored: VersionKey[];
  deferred: Array<{ key: VersionKey; code: string }>;
}

/**
 * What a repair of the instance manifest did. It only moves damaged generations above the newest valid one to
 * `trash\manifests\`; it never writes a record, and the manifest holds positive facts only, so no repair can let
 * anything run.
 */
export type ManifestRepair =
  | { ok: true; moved: string[]; view: InstanceView }
  /**
   * `newer-schema`: a file above the newest valid generation was written by a newer UnodeAi. `nothing-valid`: no
   * generation is valid. `not-repairable`: nothing lies above the newest valid one, yet the journal is not readable
   * (its generations do not form one chain). `failed`: a move failed.
   */
  | { ok: false; reason: 'newer-schema' | 'nothing-valid' | 'not-repairable' | 'missing' | 'failed'; detail: string };

/** The user's **Try again** for one key: its facts unpublished first, then its folder moved to `trash\`. */
export type VersionRetirement =
  | { ok: true; key: VersionKey }
  /**
   * `in-use`: a lease on the key is alive or unknown, or one appeared while the folder was moved (it was moved back).
   * `admission-closed`: the instance is being reset or was retired. Nothing was retired in any of these.
   */
  | { ok: false; reason: 'in-use' | 'admission-closed' | 'store-unusable' | 'deferred'; detail: string };

export interface InstanceStoreApi {
  /** A new instance, not yet named by control: identity, layout, first manifest, open admission gate. */
  create(): Promise<{ ok: true; ref: InstanceRef } | { ok: false; detail: string }>;
  open(storeId: StoreId): InstanceOpen;
  admissionState(ref: InstanceRef): AdmissionGateState;
  acquireAdmission(ref: InstanceRef): AdmissionAcquire;
  /** Renames `admission\open` to `admission\closed`, retrying 30 times 100 ms apart. */
  closeAdmission(ref: InstanceRef): Promise<AdmissionClose>;
  read(ref: InstanceRef): InstanceView;
  publish(ref: InstanceRef, change: InstanceChange): Promise<InstancePublishResult>;
  /** The only way to name a version folder. */
  versionFolder(ref: InstanceRef, key: VersionKey): string;
  listVersionFolders(ref: InstanceRef): VersionKey[];
  createStaging(ref: InstanceRef, taskToken: string): StagingFolder;
  discardStaging(staging: StagingFolder): Promise<void>;
  /** Renames the payload to `versions\<key>\`, then publishes its facts. An existing folder of that key is kept. */
  promote(ref: InstanceRef, staging: StagingFolder, facts: PromotedVersion): Promise<Promotion>;
  /** Created `wx` under `leases\<key>\`. */
  createLease(ref: InstanceRef, key: VersionKey, kind: LeaseKind, holder: ProcessIdentity): Lease;
  /** Rewritten by its owner only: a temp file renamed over the lease. */
  recordLeaseChild(lease: Lease, child: ProcessIdentity): void;
  releaseLease(lease: Lease): void;
  leaseLiveness(ref: InstanceRef, key: VersionKey): Promise<Liveness>;
  createWorkFolder(ref: InstanceRef, token: string): WorkFolder;
  removeWorkFolder(folder: WorkFolder): Promise<void>;
  /** Version folders and staging of the instance, for the 3 GiB limit. */
  usageBytes(ref: InstanceRef): Promise<number>;
  collectVersions(ref: InstanceRef, input: VersionCollectionInput): Promise<VersionCollectionReport>;
  /** Folders under `versions\` that the manifest does not mention, after the task-age, intent and lease checks. */
  retireOrphans(ref: InstanceRef): Promise<VersionKey[]>;
  /** Whole instances that are not current and have no live or unknown lease, after their grace period. */
  collectInstances(current: StoreId | null, retired: ReadonlyArray<{ storeId: StoreId; retiredAt: string }>): Promise<StoreId[]>;
  /** Moves each damaged generation above the newest valid one to `trash\manifests\`; refused for a newer schema. */
  repairManifest(ref: InstanceRef): ManifestRepair;
  /** For **Try again**: refused while a lease on the key is alive or unknown; otherwise the version GC steps for it. */
  retireVersion(ref: InstanceRef, key: VersionKey): Promise<VersionRetirement>;
}
