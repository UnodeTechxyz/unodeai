/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the managed Codex store's instances (v0.9.97)
 *  Each enrolment builds a new instance, `instances\<storeId>\`, named by a random store id that is never used again.
 *  Every path this module touches is derived from a store id it has checked, below `instances\` or the instance's own
 *  `work\<storeId>\`; nothing here accepts a path from a caller, a manifest or a lease file. So a path derived from one
 *  instance can never denote another, and a late task of a retired instance can only touch that instance.
 *
 *  - `identity.bin` names the instance (two checksummed copies), written once, exclusively, and flushed.
 *  - `admission\open\guard.bin` is the admission gate. A launch opens it and reads the identity through that handle;
 *    while any process holds such a handle, Windows refuses to rename `admission\open`, which is how a Reset closes
 *    the gate. So a launch either was admitted before the Reset closed the gate, or it is refused.
 *  - `manifests\instance-<g>.json` holds positive facts only: which versions were downloaded and checked, which probe
 *    passed. Losing a fact can make UnodeAi check again; it can never let anything run, because every prohibition
 *    lives in the control journal and every start checks the files themselves.
 *  - `leases\<key>\<token>.json` says that a process uses a version. A lease is dead only when its holder and its CLI
 *    child are proven dead by their operating-system creation times; anything less certain counts as alive.
 *  - Versions and whole instances are removed only through a trash folder that no launcher resolves: renamed away,
 *    leases looked at again, renamed back if one appeared, and only then deleted file by file. A deletion stops at the
 *    first file Windows refuses (a running program) and is finished by a later cycle.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync } from 'node:fs';
import * as path from 'node:path';
import { CLI_POLICY_LIMITS, cliStoreVersionKey } from '../../backend/cliCompatibilityPolicy';
import { compareCliVersions } from '../../backend/cliRuntime';
import type {
  AdmissionAcquire,
  AdmissionClose,
  AdmissionGateState,
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
  ManifestRepair,
  ProcessIdentity,
  PromotedVersion,
  Promotion,
  StagingFolder,
  StoreId,
  VersionCollectionInput,
  VersionCollectionReport,
  VersionKey,
  VersionRetirement,
  WorkFolder,
} from './contracts';
import {
  generationFileName,
  nodeJournalFs,
  publishGeneration,
  readJournal,
  trimJournal,
  type JournalFs,
  type JournalParse,
  type JournalSpec,
} from './generationJournal';
import { isProcessNumber, judgeProcessIdentity, PROCESS_CREATION_PATTERN, type ProcessCreationQuery, type ProcessCreations } from './processIdentity';
import { canonicalJson, isStoreToken, newStoreToken, type CliStoreRoots } from './storeLayout';

// ---------------------------------------------------------------------------------------------
// Names and limits
// ---------------------------------------------------------------------------------------------

export const INSTANCE_SCHEMA = 'unodeai.cli-instance/1';
const INSTANCE_PREFIX = 'instance';

/** A managed version folder's name, as `cliStoreVersionKey` makes it for a released Codex version on Windows x64. */
const VERSION_KEY = /^(\d{1,4}\.\d{1,4}\.\d{1,6})-win32-x64-[0-9a-f]{16}$/;

export function isManagedVersionKey(value: unknown): value is VersionKey {
  return typeof value === 'string' && VERSION_KEY.test(value);
}

export const INSTANCE_LIMITS = Object.freeze({
  maxVersions: 64,
  maxProbes: 64,
  maxStagingIntents: 64,
  maxShortChars: 200,
  maxDetailChars: 1_000,
  maxLeaseBytes: 4 * 1024,
  /** A folder under `versions\` that no fact names is left alone this long: a promotion may be publishing it. */
  orphanAgeMs: 10 * 60 * 1000,
  /** An instance never named by control is left alone this long after it was made. */
  unpublishedInstanceAgeMs: 10 * 60 * 1000,
  /** A retired instance is kept this long after its Reset. */
  retiredGraceMs: 7 * 24 * 60 * 60 * 1000,
  /** Files and folders one usage count reads at most. */
  maxUsageEntries: 200_000,
});

/** `admission\open` is renamed this many times, this far apart, before a close reports that nothing changed. */
export const ADMISSION_CLOSE_ATTEMPTS = 30;
export const ADMISSION_CLOSE_INTERVAL_MS = 100;
const ADMISSION_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Rounds of one manifest change: each re-reads the newest generation and decides again. */
export const INSTANCE_PUBLISH_ROUNDS = 5;
/** A promotion that finds its folder already there waits this long, in total, for the other promotion's facts. */
const PROMOTION_SETTLE_ROUNDS = 20;
const PROMOTION_SETTLE_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------------------------
// The identity record
// ---------------------------------------------------------------------------------------------

const IDENTITY_MAGIC = Buffer.from('UNID', 'ascii');
const IDENTITY_FORMAT = 1;
export const IDENTITY_RECORD_BYTES = 64;
/** The second copy's offset; the file is this plus one record long, zeros between. */
export const IDENTITY_SECOND_COPY = 4096;

/** One 64-byte copy: magic `UNID`, u32 LE format 1, the 16 bytes of the store id, u32 LE 0, 4 zero bytes, SHA-256 of bytes 0-31. */
export function identityRecord(storeId: StoreId): Buffer {
  if (!isStoreToken(storeId)) throw new TypeError('An identity names a store id.');
  const record = Buffer.alloc(IDENTITY_RECORD_BYTES);
  IDENTITY_MAGIC.copy(record, 0);
  record.writeUInt32LE(IDENTITY_FORMAT, 4);
  Buffer.from(storeId, 'hex').copy(record, 8);
  record.writeUInt32LE(0, 24);
  createHash('sha256').update(record.subarray(0, 32)).digest().copy(record, 32);
  return record;
}

/** `identity.bin` and `guard.bin`: the record at offset 0 and again at `IDENTITY_SECOND_COPY`. */
export function identityFileBytes(storeId: StoreId): Buffer {
  const record = identityRecord(storeId);
  const file = Buffer.alloc(IDENTITY_SECOND_COPY + IDENTITY_RECORD_BYTES);
  record.copy(file, 0);
  record.copy(file, IDENTITY_SECOND_COPY);
  return file;
}

/** The store id one copy names, or undefined when its magic, format, zeros or checksum do not hold. */
export function identityOfCopy(copy: Buffer): StoreId | undefined {
  if (copy.length !== IDENTITY_RECORD_BYTES) return undefined;
  if (!copy.subarray(0, 4).equals(IDENTITY_MAGIC) || copy.readUInt32LE(4) !== IDENTITY_FORMAT) return undefined;
  if (copy.readUInt32LE(24) !== 0 || copy.readUInt32LE(28) !== 0) return undefined;
  if (!createHash('sha256').update(copy.subarray(0, 32)).digest().equals(copy.subarray(32, 64))) return undefined;
  return copy.subarray(8, 24).toString('hex');
}

type IdentityVerdict = 'ok' | 'mismatch' | 'unreadable';

/** Valid copies that all name `storeId` are `ok`; one naming another id is a mismatch; none valid is unreadable. */
function judgeIdentityCopies(copies: ReadonlyArray<StoreId | undefined>, storeId: StoreId): IdentityVerdict {
  const valid = copies.filter((copy): copy is StoreId => copy !== undefined);
  if (valid.length === 0) return 'unreadable';
  return valid.every((copy) => copy === storeId) ? 'ok' : 'mismatch';
}

// ---------------------------------------------------------------------------------------------
// The file system it uses
// ---------------------------------------------------------------------------------------------

export interface InstanceFsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}

/** Everything the instance store does to the disk. Production uses `nodeInstanceFs`; tests record or fail calls. */
export interface InstanceFs extends JournalFs {
  /** One folder, never its parents; `EEXIST` when it exists. */
  mkdir(folder: string): void;
  rmdir(folder: string): void;
  rename(from: string, to: string): void;
  /** Never follows a link. */
  lstat(file: string): InstanceFsStat;
  openRead(file: string): number;
  /** Reads up to `buffer.length` bytes at `position` through an open handle. */
  read(fd: number, buffer: Buffer, position: number): number;
  close(fd: number): void;
}

export const nodeInstanceFs: InstanceFs = {
  ...nodeJournalFs,
  // Bounded before reading, so an oversized file is never read into memory.
  readFile: (file, maxBytes) => {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > maxBytes) return undefined;
      const bytes = Buffer.alloc(size);
      let filled = 0;
      while (filled < size) {
        const read = readSync(fd, bytes, filled, size - filled, filled);
        if (read <= 0) break;
        filled += read;
      }
      return bytes.subarray(0, filled);
    } finally {
      closeSync(fd);
    }
  },
  mkdir: (folder) => { mkdirSync(folder); },
  rmdir: (folder) => { rmdirSync(folder); },
  rename: (from, to) => { renameSync(from, to); },
  lstat: (file) => lstatSync(file),
  openRead: (file) => openSync(file, 'r'),
  read: (fd, buffer, position) => readSync(fd, buffer, 0, buffer.length, position),
  close: (fd) => { closeSync(fd); },
};

export interface InstanceStoreDeps {
  /**
   * Which processes run now, by creation time (`processCreationQuery`). Required: a lease's holder and child are
   * judged only through it, and an unavailable answer makes every lease `unknown`.
   */
  processCreations: ProcessCreationQuery;
  fs?: InstanceFs;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  sleep?: (ms: number) => Promise<void>;
  /** Names found in the store that are not its own and were left alone, for diagnostics. */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Record checks
// ---------------------------------------------------------------------------------------------

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INSTANCE_FIELDS = ['schema', 'storeId', 'generation', 'previousRecordDigest', 'recordDigest', 'versions', 'probes', 'stagingIntents', 'schedule'];
const PROMOTED_FIELDS = ['key', 'provider', 'version', 'os', 'arch', 'policyVersion', 'policyEntryId', 'artifactSha256', 'taskToken', 'promotedAt', 'verification'];
const VERIFICATION_FIELDS = ['files', 'bytes', 'signed', 'unsigned', 'revocation'];
const PROBE_FIELDS = ['key', 'closureDigest', 'versionOutput', 'startedAt', 'durationMs'];
const INTENT_FIELDS = ['key', 'owner', 'startedAt'];
const FAILURE_CLASSES = ['network', 'timeout', 'signature-unavailable', 'integrity', 'signature', 'host-not-allowed', 'store-full', 'file'];
const LEASE_KINDS: readonly LeaseKind[] = ['session', 'probe', 'download', 'maintenance'];
const LEASE_FIELDS = ['leaseToken', 'storeId', 'key', 'kind', 'holder', 'child', 'createdAt'];
const MAX_PROBE_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyFields(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? undefined : `an unknown field "${extra.slice(0, 40)}"`;
}

function isShortText(value: unknown, max: number = INSTANCE_LIMITS.maxShortChars): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

export function processIdentityProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'a process identity is not an object';
  const extra = onlyFields(value, ['pid', 'creation']);
  if (extra) return `a process identity has ${extra}`;
  if (!isProcessNumber(value.pid)) return 'a process identity has no valid process number';
  if (value.creation !== 'pending' && !(typeof value.creation === 'string' && PROCESS_CREATION_PATTERN.test(value.creation))) {
    return 'a process identity has no valid creation time';
  }
  return undefined;
}

/** What is wrong with one version's facts, or undefined. The key must be the one its own facts make. */
export function promotedVersionProblem(facts: unknown, key: string): string | undefined {
  if (!isRecord(facts)) return `the facts of ${key.slice(0, 80)} are not an object`;
  const extra = onlyFields(facts, PROMOTED_FIELDS);
  if (extra) return `the facts of ${key} have ${extra}`;
  if (!isManagedVersionKey(key) || facts.key !== key) return 'a version is listed under another name than its own';
  if (facts.provider !== 'codex-cli' || facts.os !== 'win32' || facts.arch !== 'x64') return `${key} is not a managed Codex version for Windows x64`;
  if (typeof facts.version !== 'string' || VERSION_KEY.exec(key)?.[1] !== facts.version) return `${key} names another version`;
  if (typeof facts.artifactSha256 !== 'string' || !SHA256_HEX.test(facts.artifactSha256)) return `${key} has no artifact digest`;
  if (cliStoreVersionKey({ version: facts.version, os: 'win32', arch: 'x64', managed: { artifact: { sha256: facts.artifactSha256 } } }) !== key) {
    return `${key} is not the name of its own artifact`;
  }
  if (!isShortText(facts.policyVersion) || !isShortText(facts.policyEntryId)) return `${key} names no policy entry`;
  if (!isStoreToken(facts.taskToken) || !isTime(facts.promotedAt)) return `${key} has no valid task or time`;
  const verification = facts.verification;
  if (!isRecord(verification) || onlyFields(verification, VERIFICATION_FIELDS)) return `${key} has no valid verification`;
  if (!isCount(verification.files, CLI_POLICY_LIMITS.maxEntries) || !isCount(verification.bytes, CLI_POLICY_LIMITS.maxUnpackedBytes)) {
    return `${key} has verification counts out of bounds`;
  }
  const signed = verification.signed;
  if (!isRecord(signed) || onlyFields(signed, ['openai', 'microsoftCrt'])
    || !isCount(signed.openai, CLI_POLICY_LIMITS.maxEntries) || !isCount(signed.microsoftCrt, CLI_POLICY_LIMITS.maxEntries)) {
    return `${key} has no valid signature counts`;
  }
  if (!Array.isArray(verification.unsigned) || verification.unsigned.length > INSTANCE_LIMITS.maxVersions
    || !verification.unsigned.every((file) => isShortText(file, 260))) {
    return `${key} has no valid list of unsigned files`;
  }
  if (verification.revocation !== 'confirmed-online' && verification.revocation !== 'not-confirmed-offline') return `${key} has no revocation state`;
  return undefined;
}

/** What is wrong with the four content fields of an instance record, or undefined. Folders are never consulted. */
export function instanceContentProblem(content: unknown): string | undefined {
  if (!isRecord(content)) return 'the content is not an object';
  const { versions, probes, stagingIntents, schedule } = content;
  if (!isRecord(versions)) return '`versions` is not an object';
  const versionKeys = Object.keys(versions);
  if (versionKeys.length > INSTANCE_LIMITS.maxVersions) return 'too many versions';
  for (const key of versionKeys) {
    const problem = promotedVersionProblem(versions[key], key);
    if (problem) return problem;
  }
  if (!isRecord(probes)) return '`probes` is not an object';
  const probeKeys = Object.keys(probes);
  if (probeKeys.length > INSTANCE_LIMITS.maxProbes) return 'too many probes';
  for (const key of probeKeys) {
    const probe = probes[key];
    if (!versionKeys.includes(key)) return 'a probe names a version that is not listed';
    if (!isRecord(probe) || onlyFields(probe, PROBE_FIELDS) || probe.key !== key) return `the probe of ${key} is not valid`;
    if (typeof probe.closureDigest !== 'string' || !SHA256_HEX.test(probe.closureDigest)) return `the probe of ${key} has no closure digest`;
    if (!isShortText(probe.versionOutput) || !isTime(probe.startedAt) || !isCount(probe.durationMs, MAX_PROBE_MS)) {
      return `the probe of ${key} has fields out of bounds`;
    }
  }
  if (!isRecord(stagingIntents)) return '`stagingIntents` is not an object';
  const intentTokens = Object.keys(stagingIntents);
  if (intentTokens.length > INSTANCE_LIMITS.maxStagingIntents) return 'too many staging intents';
  for (const taskToken of intentTokens) {
    const intent = stagingIntents[taskToken];
    if (!isStoreToken(taskToken) || !isRecord(intent) || onlyFields(intent, INTENT_FIELDS)) return 'a staging intent is not valid';
    if (!isManagedVersionKey(intent.key) || !isTime(intent.startedAt) || processIdentityProblem(intent.owner)) {
      return 'a staging intent has fields out of bounds';
    }
  }
  if (!isRecord(schedule) || onlyFields(schedule, ['lastAttemptAt', 'failure'])) return '`schedule` is not valid';
  if (schedule.lastAttemptAt !== undefined && !isTime(schedule.lastAttemptAt)) return '`schedule.lastAttemptAt` is not a time';
  if (schedule.failure !== undefined) {
    const failure = schedule.failure;
    if (!isRecord(failure) || onlyFields(failure, ['class', 'entryId', 'at', 'attempts', 'retryAt', 'detail'])) return '`schedule.failure` is not valid';
    if (!FAILURE_CLASSES.includes(failure.class as string) || !isShortText(failure.entryId) || !isTime(failure.at)
      || !isCount(failure.attempts, 1_000) || (failure.retryAt !== undefined && !isTime(failure.retryAt))
      || !isShortText(failure.detail, INSTANCE_LIMITS.maxDetailChars)) {
      return '`schedule.failure` has fields out of bounds';
    }
  }
  return undefined;
}

function parseInstanceRecord(storeId: StoreId): (value: unknown) => JournalParse<InstanceRecord> {
  return (value) => {
    const record = value as Record<string, unknown>;
    if (typeof record.schema === 'string') {
      const match = /^unodeai\.cli-instance\/(\d{1,6})$/.exec(record.schema);
      if (match && Number(match[1]) > 1) return { ok: false, newerSchema: true, detail: `schema ${record.schema}` };
    }
    if (record.schema !== INSTANCE_SCHEMA) return { ok: false, detail: 'not an instance record' };
    const extra = onlyFields(record, INSTANCE_FIELDS);
    if (extra) return { ok: false, detail: `the record has ${extra}` };
    if (record.storeId !== storeId) return { ok: false, detail: 'the record names another instance' };
    const problem = instanceContentProblem(record);
    return problem ? { ok: false, detail: problem } : { ok: true, record: record as unknown as InstanceRecord };
  };
}

function leaseRecordOf(bytes: Buffer, leaseToken: string, storeId: StoreId, key: VersionKey): LeaseRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || onlyFields(value, LEASE_FIELDS)) return undefined;
  if (value.leaseToken !== leaseToken || value.storeId !== storeId || value.key !== key) return undefined;
  if (!LEASE_KINDS.includes(value.kind as LeaseKind) || processIdentityProblem(value.holder) || !isTime(value.createdAt)) return undefined;
  if (value.child !== 'pending' && value.child !== 'none' && processIdentityProblem(value.child)) return undefined;
  return value as unknown as LeaseRecord;
}

/** One lease: alive when its holder or its child runs; dead only when both are proven dead; otherwise unknown. */
export function judgeLease(lease: Pick<LeaseRecord, 'holder' | 'child'>, answer: ProcessCreations): Liveness {
  const holder = judgeProcessIdentity(lease.holder, answer);
  const child = lease.child === 'none' ? 'dead' : lease.child === 'pending' ? 'unknown' : judgeProcessIdentity(lease.child, answer);
  if (holder === 'alive' || child === 'alive') return 'alive';
  if (holder === 'dead' && child === 'dead') return 'dead';
  return 'unknown';
}

function aggregateLiveness(each: readonly Liveness[]): Liveness {
  if (each.includes('alive')) return 'alive';
  if (each.includes('unknown')) return 'unknown';
  return 'dead';
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

const LEASE_FILE = /^([0-9a-f]{32})\.json$/;
const LEASE_TEMP = /^\.([0-9a-f]{32})\.tmp-[0-9a-f]{32}$/;
/** `trash\<key>.<token>`: moved away, its leases not yet looked at again. */
const TRASH_UNDECIDED = /^(\d{1,4}\.\d{1,4}\.\d{1,6}-win32-x64-[0-9a-f]{16})\.[0-9a-f]{32}$/;
/** `trash\<token>`, `instance-trash\<token>`: decided, being deleted; never moved back. */
const TRASH_DECIDED = /^[0-9a-f]{32}$/;
/** `instance-trash\<storeId>.<token>`. */
const INSTANCE_TRASH_UNDECIDED = /^([0-9a-f]{32})\.[0-9a-f]{32}$/;

interface InstancePaths {
  root: string;
  identity: string;
  manifests: string;
  versions: string;
  staging: string;
  leases: string;
  trash: string;
  admission: string;
  admissionOpen: string;
  admissionClosed: string;
  guard: string;
  closedGuard: string;
}

function instancePaths(root: string): InstancePaths {
  const join = path.join;
  return {
    root,
    identity: join(root, 'identity.bin'),
    manifests: join(root, 'manifests'),
    versions: join(root, 'versions'),
    staging: join(root, 'staging'),
    leases: join(root, 'leases'),
    trash: join(root, 'trash'),
    admission: join(root, 'admission'),
    admissionOpen: join(root, 'admission', 'open'),
    admissionClosed: join(root, 'admission', 'closed'),
    guard: join(root, 'admission', 'open', 'guard.bin'),
    closedGuard: join(root, 'admission', 'closed', 'guard.bin'),
  };
}

interface LeaseFile {
  name: string;
  record?: LeaseRecord;
}

/** The lease files of one key; `listed: false` when the folder could not be listed (counted as unknown). */
interface LeaseFolder {
  key: string;
  listed: boolean;
  files: LeaseFile[];
}

interface JudgedLeases {
  liveness: Liveness;
  /** The file names proven dead, which the collector may remove. */
  dead: string[];
}

type RetireOutcome = { outcome: 'collected' } | { outcome: 'restored' } | { outcome: 'gone' } | { outcome: 'deferred'; code: string };

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}

export function createInstanceStore(roots: CliStoreRoots, deps: InstanceStoreDeps): InstanceStoreApi {
  for (const folder of [roots.root, roots.instances, roots.instanceTrash, roots.work]) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new TypeError('The instance store needs absolute store folders.');
  }
  if (typeof deps?.processCreations !== 'function') throw new TypeError('The instance store needs the process creation query.');
  const fs = deps.fs ?? nodeInstanceFs;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? randomBytes;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => undefined);
  const token = () => newStoreToken(random);
  const iso = () => new Date(now()).toISOString();

  // ---- Names, all checked before any file-system call ------------------------------------------

  function instanceRoot(storeId: unknown): string {
    if (!isStoreToken(storeId)) throw new TypeError('This is not the name of a managed store instance.');
    return path.join(roots.instances, storeId);
  }

  /** The paths of a ref, derived from its store id alone. A ref whose root is anything else is refused. */
  function pathsOf(ref: InstanceRef): InstancePaths {
    if (!isRecord(ref)) throw new TypeError('This is not a managed store instance.');
    const root = instanceRoot(ref.storeId);
    if (ref.root !== root) throw new TypeError('This instance reference does not belong to this store.');
    return instancePaths(root);
  }

  function checkKey(key: unknown): asserts key is VersionKey {
    if (!isManagedVersionKey(key)) throw new TypeError('This is not the name of a managed Codex version.');
  }

  function checkToken(value: unknown): asserts value is string {
    if (!isStoreToken(value)) throw new TypeError('This is not a token of the managed store.');
  }

  function journalSpec(paths: InstancePaths, storeId: StoreId): JournalSpec<InstanceRecord> {
    return { folder: paths.manifests, prefix: INSTANCE_PREFIX, parse: parseInstanceRecord(storeId) };
  }

  // ---- Small file-system helpers ----------------------------------------------------------------

  function statOf(file: string): InstanceFsStat | undefined {
    try {
      return fs.lstat(file);
    } catch {
      return undefined;
    }
  }

  function isRealDirectory(file: string): boolean {
    const stat = statOf(file);
    return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
  }

  function exists(file: string): boolean {
    return statOf(file) !== undefined;
  }

  /** One folder; an existing one is fine. Its parent must exist. */
  function mkdirAllowExisting(folder: string): void {
    try {
      fs.mkdir(folder);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }

  function list(folder: string): string[] | undefined {
    try {
      return fs.readdir(folder);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      return undefined;
    }
  }

  /**
   * Deletes a tree file by file, never following a link (a link is removed itself). Stops at the first failure and
   * returns its code; the rest is left for a later cycle. A file that is already gone is fine.
   */
  async function removeTree(target: string): Promise<string | undefined> {
    let count = 0;
    const remove = async (entry: string): Promise<string | undefined> => {
      if (++count % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      let stat: InstanceFsStat;
      try {
        stat = fs.lstat(entry);
      } catch (error) {
        return errorCode(error) === 'ENOENT' ? undefined : errorCode(error);
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        let names: string[];
        try {
          names = fs.readdir(entry);
        } catch (error) {
          return errorCode(error) === 'ENOENT' ? undefined : errorCode(error);
        }
        for (const name of names) {
          const stopped = await remove(path.join(entry, name));
          if (stopped) return stopped;
        }
        try {
          fs.rmdir(entry);
        } catch (error) {
          return errorCode(error) === 'ENOENT' ? undefined : errorCode(error);
        }
        return undefined;
      }
      try {
        fs.unlink(entry);
      } catch (error) {
        return errorCode(error) === 'ENOENT' ? undefined : errorCode(error);
      }
      return undefined;
    };
    return remove(target);
  }

  /** Reads both copies of an identity through one handle on `file`, then closes it. */
  function identityAt(file: string, storeId: StoreId): IdentityVerdict | 'missing' {
    let fd: number;
    try {
      fd = fs.openRead(file);
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
    }
    try {
      return judgeIdentityCopies(copiesThrough(fd), storeId);
    } catch {
      return 'unreadable';
    } finally {
      try { fs.close(fd); } catch { /* nothing was decided on this handle any more */ }
    }
  }

  function copiesThrough(fd: number): Array<StoreId | undefined> {
    return [0, IDENTITY_SECOND_COPY].map((position) => {
      const copy = Buffer.alloc(IDENTITY_RECORD_BYTES);
      let filled = 0;
      while (filled < IDENTITY_RECORD_BYTES) {
        const read = fs.read(fd, copy.subarray(filled), position + filled);
        if (read <= 0) break;
        filled += read;
      }
      return filled === IDENTITY_RECORD_BYTES ? identityOfCopy(copy) : undefined;
    });
  }

  // ---- Identity and creation ----------------------------------------------------------------------

  async function create(): Promise<{ ok: true; ref: InstanceRef } | { ok: false; detail: string }> {
    try {
      mkdirAllowExisting(roots.instances);
      let storeId: StoreId | undefined;
      for (let attempt = 1; attempt <= 3 && !storeId; attempt++) {
        const candidate = token();
        try {
          fs.mkdir(instanceRoot(candidate));
          storeId = candidate;
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
      }
      if (!storeId) return { ok: false, detail: 'UnodeAi could not choose a new name for the managed Codex store.' };
      const paths = instancePaths(instanceRoot(storeId));
      fs.writeExclusive(paths.identity, identityFileBytes(storeId));
      for (const folder of [paths.manifests, paths.versions, paths.staging, paths.leases, paths.trash, paths.admission, paths.admissionOpen]) {
        fs.mkdir(folder);
      }
      const first = publishGeneration(journalSpec(paths, storeId), null, {
        schema: INSTANCE_SCHEMA, storeId, versions: {}, probes: {}, stagingIntents: {}, schedule: {},
      }, fs, token);
      if (first.outcome !== 'published') return { ok: false, detail: 'Another writer published into the new managed Codex store.' };
      // Last: the instance is complete, and can be named by control, only once its gate exists.
      fs.writeExclusive(paths.guard, identityFileBytes(storeId));
      return { ok: true, ref: Object.freeze({ storeId, root: paths.root }) };
    } catch (error) {
      return { ok: false, detail: `UnodeAi could not create the managed Codex store (${errorCode(error)}).` };
    }
  }

  function open(storeId: StoreId): InstanceOpen {
    if (!isStoreToken(storeId)) return { ok: false, reason: 'missing', detail: 'This is not the name of a managed store instance.' };
    const paths = instancePaths(instanceRoot(storeId));
    const identity = identityAt(paths.identity, storeId);
    if (identity === 'missing') return { ok: false, reason: 'missing', detail: `The managed Codex store ${storeId} does not exist.` };
    if (identity === 'mismatch') return { ok: false, reason: 'identity-mismatch', detail: `The folder of the managed Codex store ${storeId} names another store.` };
    if (identity === 'unreadable') return { ok: false, reason: 'identity-unreadable', detail: `The identity of the managed Codex store ${storeId} is damaged.` };
    // An instance is complete only once its gate was written; the gate holds the same identity, open or closed.
    const openGate = identityAt(paths.guard, storeId);
    const gate = openGate === 'missing' ? identityAt(paths.closedGuard, storeId) : openGate;
    if (gate === 'missing') return { ok: false, reason: 'missing', detail: `The managed Codex store ${storeId} was never completed.` };
    if (gate === 'mismatch') return { ok: false, reason: 'identity-mismatch', detail: `The admission gate of the managed Codex store ${storeId} names another store.` };
    if (gate === 'unreadable') return { ok: false, reason: 'identity-unreadable', detail: `The admission gate of the managed Codex store ${storeId} is damaged.` };
    return { ok: true, ref: Object.freeze({ storeId, root: paths.root }) };
  }

  // ---- The admission gate -------------------------------------------------------------------------

  function admissionState(ref: InstanceRef): AdmissionGateState {
    const paths = pathsOf(ref);
    const guard = statOf(paths.guard);
    if (guard?.isFile()) return 'open';
    return isRealDirectory(paths.admissionClosed) ? 'closed' : 'missing';
  }

  function acquireAdmission(ref: InstanceRef): AdmissionAcquire {
    const paths = pathsOf(ref);
    let fd: number;
    try {
      fd = fs.openRead(paths.guard);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' && isRealDirectory(paths.admissionClosed)) {
        return { ok: false, reason: 'closed', detail: 'Managed Codex is being reset or was reset. Nothing was started.' };
      }
      return { ok: false, reason: 'unreadable', detail: `The admission gate of managed Codex could not be opened (${code}). Nothing was started.` };
    }
    // The identity is read through the handle just opened, never by opening the path again.
    let verdict: IdentityVerdict;
    try {
      verdict = judgeIdentityCopies(copiesThrough(fd), ref.storeId);
    } catch {
      verdict = 'unreadable';
    }
    if (verdict !== 'ok') {
      try { fs.close(fd); } catch { /* refused either way */ }
      return verdict === 'mismatch'
        ? { ok: false, reason: 'identity-mismatch', detail: 'The admission gate of managed Codex names another store. Nothing was started.' }
        : { ok: false, reason: 'unreadable', detail: 'The admission gate of managed Codex is damaged. Nothing was started.' };
    }
    let released = false;
    return {
      ok: true,
      handle: Object.freeze({
        storeId: ref.storeId,
        release: () => {
          if (released) return;
          released = true;
          try { fs.close(fd); } catch { /* closed with the process at the latest */ }
        },
      }),
    };
  }

  async function closeAdmission(ref: InstanceRef): Promise<AdmissionClose> {
    const paths = pathsOf(ref);
    if (!exists(paths.admissionOpen)) {
      return isRealDirectory(paths.admissionClosed) ? { ok: true, alreadyClosed: true } : { ok: false, code: 'ENOENT', attempts: 0 };
    }
    // Both present is damage; renaming onto `closed` could replace it on some systems, so nothing is changed.
    if (exists(paths.admissionClosed)) return { ok: false, code: 'EEXIST', attempts: 0 };
    let code = 'unknown';
    for (let attempt = 1; attempt <= ADMISSION_CLOSE_ATTEMPTS; attempt++) {
      try {
        fs.rename(paths.admissionOpen, paths.admissionClosed);
        return { ok: true, alreadyClosed: false };
      } catch (error) {
        code = errorCode(error);
        if (code === 'ENOENT' && isRealDirectory(paths.admissionClosed)) return { ok: true, alreadyClosed: true };
        if (!ADMISSION_RETRYABLE.has(code)) return { ok: false, code, attempts: attempt };
      }
      if (attempt < ADMISSION_CLOSE_ATTEMPTS) await sleep(ADMISSION_CLOSE_INTERVAL_MS);
    }
    return { ok: false, code, attempts: ADMISSION_CLOSE_ATTEMPTS };
  }

  // ---- The instance manifest ----------------------------------------------------------------------

  function readPaths(paths: InstancePaths, storeId: StoreId): InstanceView {
    const journal = readJournal(journalSpec(paths, storeId), fs);
    switch (journal.kind) {
      case 'ok':
        return { kind: 'readable', snapshot: { generation: journal.generation, record: journal.record, digest: journal.digest } };
      case 'newer-schema':
        return { kind: 'unusable', reason: 'store-newer-schema', detail: journal.detail };
      case 'corrupt':
        return { kind: 'unusable', reason: 'store-corrupt', detail: journal.detail };
      case 'empty':
        return exists(paths.root)
          ? { kind: 'unusable', reason: 'store-corrupt', detail: 'the managed Codex store has no record' }
          : { kind: 'unusable', reason: 'missing', detail: 'the managed Codex store does not exist' };
    }
  }

  function read(ref: InstanceRef): InstanceView {
    return readPaths(pathsOf(ref), ref.storeId);
  }

  function contentOf(record: InstanceContent): InstanceContent {
    return { versions: record.versions, probes: record.probes, stagingIntents: record.stagingIntents, schedule: record.schedule };
  }

  async function publish(ref: InstanceRef, change: InstanceChange): Promise<InstancePublishResult> {
    const paths = pathsOf(ref);
    if (!isRecord(change) || typeof change.apply !== 'function') throw new TypeError('A change of the managed Codex store has no apply().');
    const spec = journalSpec(paths, ref.storeId);
    for (let round = 1; round <= INSTANCE_PUBLISH_ROUNDS; round++) {
      // Each round decides again from the newest generation; an old decision is never applied to a new predecessor.
      const view = readPaths(paths, ref.storeId);
      if (view.kind !== 'readable') return { outcome: 'unusable', view };
      const decided = change.apply(view.snapshot.record);
      if ((decided as { moot?: unknown }).moot === true) return { outcome: 'moot', snapshot: view.snapshot };
      if (typeof (decided as { refused?: unknown }).refused === 'string') return { outcome: 'refused', reason: (decided as { refused: string }).refused };
      const content = contentOf(decided as InstanceContent);
      const problem = instanceContentProblem(content);
      if (problem) return { outcome: 'refused', reason: `the change would make an invalid record (${problem})` };
      let result: ReturnType<typeof publishGeneration<InstanceRecord>>;
      try {
        result = publishGeneration(spec, view.snapshot, { schema: INSTANCE_SCHEMA, storeId: ref.storeId, ...content }, fs, token);
      } catch (error) {
        return { outcome: 'refused', reason: `the record could not be written (${errorCode(error)})` };
      }
      if (result.outcome === 'published') {
        trimJournal(spec as JournalSpec<unknown>, result.entry.generation, fs);
        return { outcome: 'published', snapshot: { generation: result.entry.generation, record: result.entry.record, digest: result.entry.digest } };
      }
    }
    return { outcome: 'busy' };
  }

  function repairManifest(ref: InstanceRef): ManifestRepair {
    const paths = pathsOf(ref);
    const journal = readJournal(journalSpec(paths, ref.storeId), fs);
    if (journal.kind === 'ok') return { ok: true, moved: [], view: readPaths(paths, ref.storeId) };
    if (journal.kind === 'newer-schema') {
      return { ok: false, reason: 'newer-schema', detail: 'A newer UnodeAi wrote the managed Codex store; this version does not repair it.' };
    }
    if (journal.kind === 'empty') {
      return exists(paths.root)
        ? { ok: false, reason: 'nothing-valid', detail: 'The managed Codex store has no record to keep.' }
        : { ok: false, reason: 'missing', detail: 'The managed Codex store does not exist.' };
    }
    if (!journal.newestValid) return { ok: false, reason: 'nothing-valid', detail: 'No record of the managed Codex store is valid.' };
    const newest = journal.newestValid.generation;
    const names = list(paths.manifests);
    if (!names) return { ok: false, reason: 'failed', detail: 'The records of the managed Codex store could not be listed.' };
    const above = names.filter((name) => {
      const match = /^instance-(\d{10})\.json$/.exec(name);
      return !!match && generationFileName(INSTANCE_PREFIX, Number(match[1])) === name && Number(match[1]) > newest;
    });
    if (above.length === 0) return { ok: false, reason: 'not-repairable', detail: journal.detail };
    const moved: string[] = [];
    try {
      mkdirAllowExisting(paths.trash);
      mkdirAllowExisting(path.join(paths.trash, 'manifests'));
      for (const name of above) {
        try {
          fs.rename(path.join(paths.manifests, name), path.join(paths.trash, 'manifests', `${name}.${token()}`));
          moved.push(name);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      return { ok: false, reason: 'failed', detail: `A damaged record could not be moved (${errorCode(error)}); moved: ${moved.join(', ') || 'none'}.` };
    }
    return { ok: true, moved, view: readPaths(paths, ref.storeId) };
  }

  // ---- Versions, staging, promotion ---------------------------------------------------------------

  function versionFolder(ref: InstanceRef, key: VersionKey): string {
    const paths = pathsOf(ref);
    checkKey(key);
    return path.join(paths.versions, key);
  }

  function listVersionFolders(ref: InstanceRef): VersionKey[] {
    const paths = pathsOf(ref);
    const names = list(paths.versions) ?? [];
    const keys: VersionKey[] = [];
    for (const name of names) {
      if (isManagedVersionKey(name) && isRealDirectory(path.join(paths.versions, name))) keys.push(name);
      else log(`managed Codex store ${ref.storeId}: "${name.slice(0, 80)}" in versions is not a version folder; it was left alone`);
    }
    return keys.sort();
  }

  function stagingPathsOf(storeId: StoreId, taskToken: string): StagingFolder {
    checkToken(taskToken);
    const root = path.join(instancePaths(instanceRoot(storeId)).staging, taskToken);
    return Object.freeze({ storeId, taskToken, root, artifact: path.join(root, 'artifact.part'), payload: path.join(root, 'payload') });
  }

  /** A staging folder handed back, re-derived from its store id and token; one naming any other path is refused. */
  function checkedStaging(staging: StagingFolder): StagingFolder {
    if (!isRecord(staging)) throw new TypeError('This is not a staging folder of the managed store.');
    const derived = stagingPathsOf(staging.storeId, staging.taskToken);
    if (staging.root !== derived.root || staging.artifact !== derived.artifact || staging.payload !== derived.payload) {
      throw new TypeError('This staging folder does not belong to this store.');
    }
    return derived;
  }

  function createStaging(ref: InstanceRef, taskToken: string): StagingFolder {
    pathsOf(ref);
    const staging = stagingPathsOf(ref.storeId, taskToken);
    // Neither is created recursively: a missing `staging\` fails rather than being made again.
    fs.mkdir(staging.root);
    fs.mkdir(staging.payload);
    return staging;
  }

  async function discardStaging(staging: StagingFolder): Promise<void> {
    const derived = checkedStaging(staging);
    await removeTree(derived.root);
  }

  async function promote(ref: InstanceRef, staging: StagingFolder, facts: PromotedVersion): Promise<Promotion> {
    const paths = pathsOf(ref);
    const own = checkedStaging(staging);
    if (own.storeId !== ref.storeId) throw new TypeError('This staging folder belongs to another managed store.');
    const key = isRecord(facts) ? facts.key : undefined;
    checkKey(key);
    const problem = promotedVersionProblem(facts, key);
    if (problem) throw new TypeError(`These facts cannot be promoted: ${problem}.`);
    const target = path.join(paths.versions, key);

    const view = readPaths(paths, ref.storeId);
    if (view.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: view.detail };
    const listed = view.snapshot.record.versions[key];
    if (listed && listed.artifactSha256 !== facts.artifactSha256) {
      return { ok: false, reason: 'different-artifact', detail: `${key} is already recorded with another artifact; nothing was replaced.` };
    }
    // An existing folder is never replaced: a rename onto it could replace an empty one on some systems.
    if (exists(target)) return settleExisting(ref, own, facts);
    try {
      fs.rename(own.payload, target);
    } catch (error) {
      if (exists(target)) return settleExisting(ref, own, facts);
      return { ok: false, reason: 'rename-failed', detail: `The checked files could not be moved into place (${errorCode(error)}).` };
    }
    const published = await publish(ref, {
      label: `promote ${key}`,
      apply: (current) => {
        const there = current.versions[key];
        if (there) return there.artifactSha256 === facts.artifactSha256 ? { moot: true } : { refused: 'different-artifact' };
        return { ...contentOf(current), versions: { ...current.versions, [key]: facts } };
      },
    });
    if (published.outcome === 'published' || published.outcome === 'moot') {
      await removeTree(own.root);
      return { ok: true, key, alreadyPromoted: false, snapshot: published.snapshot };
    }
    if (published.outcome === 'refused' && published.reason === 'different-artifact') {
      // Another artifact was recorded meanwhile: these files go back to staging, and nothing of the record changes.
      try { fs.rename(target, own.payload); } catch { /* left as a folder no fact describes as these files */ }
      return { ok: false, reason: 'different-artifact', detail: `${key} was recorded with another artifact meanwhile; nothing was replaced.` };
    }
    // The folder stays without facts: an orphan, retired later. Nothing runs because of it.
    return { ok: false, reason: 'publish-failed', detail: `The checked version could not be recorded (${published.outcome}).` };
  }

  /** The folder of the key exists: it counts as this promotion only when the record names the same artifact. */
  async function settleExisting(ref: InstanceRef, own: StagingFolder, facts: PromotedVersion): Promise<Promotion> {
    for (let round = 1; round <= PROMOTION_SETTLE_ROUNDS; round++) {
      const view = read(ref);
      if (view.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: view.detail };
      const there = view.snapshot.record.versions[facts.key];
      if (there && there.artifactSha256 === facts.artifactSha256) {
        await removeTree(own.root);
        return { ok: true, key: facts.key, alreadyPromoted: true, snapshot: view.snapshot };
      }
      if (there) return { ok: false, reason: 'different-artifact', detail: `${facts.key} is recorded with another artifact; nothing was replaced.` };
      if (round < PROMOTION_SETTLE_ROUNDS) await sleep(PROMOTION_SETTLE_INTERVAL_MS);
    }
    return { ok: false, reason: 'rename-failed', detail: `A folder for ${facts.key} exists that no promotion recorded; nothing was replaced.` };
  }

  async function usageBytes(ref: InstanceRef): Promise<number> {
    const paths = pathsOf(ref);
    let total = 0;
    let entries = 0;
    const walk = (folder: string): void => {
      let names: string[];
      try {
        names = fs.readdir(folder);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      for (const name of names) {
        if (++entries > INSTANCE_LIMITS.maxUsageEntries) throw new Error('The managed Codex store holds more files than it can count.');
        const entry = path.join(folder, name);
        let stat: InstanceFsStat;
        try {
          stat = fs.lstat(entry);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(entry);
        else if (stat.isFile()) total += stat.size;
      }
    };
    walk(paths.versions);
    walk(paths.staging);
    return total;
  }

  // ---- Leases -------------------------------------------------------------------------------------

  function checkedLease(lease: Lease): { paths: InstancePaths; key: VersionKey; leaseToken: string } {
    if (!isRecord(lease)) throw new TypeError('This is not a lease of the managed store.');
    const paths = pathsOf(lease.ref);
    checkKey(lease.key);
    checkToken(lease.token);
    return { paths, key: lease.key, leaseToken: lease.token };
  }

  function createLease(ref: InstanceRef, key: VersionKey, kind: LeaseKind, holder: ProcessIdentity): Lease {
    const paths = pathsOf(ref);
    checkKey(key);
    if (!LEASE_KINDS.includes(kind)) throw new TypeError('This is not a kind of lease.');
    const problem = processIdentityProblem(holder);
    if (problem) throw new TypeError(`The lease holder is not valid: ${problem}.`);
    const leaseToken = token();
    const folder = path.join(paths.leases, key);
    mkdirAllowExisting(folder);
    const record: LeaseRecord = {
      leaseToken,
      storeId: ref.storeId,
      key,
      kind,
      holder: { pid: holder.pid, creation: holder.creation },
      child: kind === 'session' || kind === 'probe' ? 'pending' : 'none',
      createdAt: iso(),
    };
    fs.writeExclusive(path.join(folder, `${leaseToken}.json`), Buffer.from(canonicalJson(record), 'utf8'));
    return Object.freeze({ ref, key, token: leaseToken });
  }

  function recordLeaseChild(lease: Lease, child: ProcessIdentity): void {
    const { paths, key, leaseToken } = checkedLease(lease);
    const problem = processIdentityProblem(child);
    if (problem) throw new TypeError(`The lease child is not valid: ${problem}.`);
    const folder = path.join(paths.leases, key);
    const file = path.join(folder, `${leaseToken}.json`);
    const bytes = fs.readFile(file, INSTANCE_LIMITS.maxLeaseBytes);
    const current = bytes ? leaseRecordOf(bytes, leaseToken, lease.ref.storeId, key) : undefined;
    if (!current) throw new Error('UnodeAi could not read its own lease of managed Codex.');
    const next: LeaseRecord = { ...current, child: { pid: child.pid, creation: child.creation } };
    const temp = path.join(folder, `.${leaseToken}.tmp-${token()}`);
    fs.writeExclusive(temp, Buffer.from(canonicalJson(next), 'utf8'));
    try {
      fs.rename(temp, file);
    } catch (error) {
      try { fs.unlink(temp); } catch { /* judged as this lease by its content */ }
      throw error;
    }
  }

  function releaseLease(lease: Lease): void {
    const { paths, key, leaseToken } = checkedLease(lease);
    try {
      fs.unlink(path.join(paths.leases, key, `${leaseToken}.json`));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  /** Every entry of `leases\<key>\`. A lease file or a lease's temp file is judged by its content; anything else is unknown. */
  function leaseFolder(leasesRoot: string, storeId: StoreId, key: string): LeaseFolder {
    const folder = path.join(leasesRoot, key);
    const names = list(folder);
    if (!names) return { key, listed: false, files: [] };
    const files = names.map((name): LeaseFile => {
      const leaseToken = LEASE_FILE.exec(name)?.[1] ?? LEASE_TEMP.exec(name)?.[1];
      if (!leaseToken || !isManagedVersionKey(key)) return { name };
      let bytes: Buffer | undefined;
      try {
        bytes = fs.readFile(path.join(folder, name), INSTANCE_LIMITS.maxLeaseBytes);
      } catch {
        bytes = undefined;
      }
      return { name, ...(bytes ? { record: leaseRecordOf(bytes, leaseToken, storeId, key) } : {}) };
    });
    return { key, listed: true, files };
  }

  async function queryCreations(identities: ReadonlyArray<ProcessIdentity>): Promise<ProcessCreations> {
    const pids = [...new Set(identities.filter((identity) => identity.creation !== 'pending').map((identity) => identity.pid))];
    if (pids.length === 0) return 'unavailable';
    try {
      const answer = await deps.processCreations(pids);
      return answer instanceof Map ? answer : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** Judges lease folders, plus further identities, with one fresh creation query. */
  async function judgeLeaseFolders(
    folders: readonly LeaseFolder[],
    extra: ReadonlyArray<ProcessIdentity> = [],
  ): Promise<{ byKey: Map<string, JudgedLeases>; answer: ProcessCreations }> {
    const identities: ProcessIdentity[] = [...extra];
    for (const folder of folders) {
      for (const file of folder.files) {
        if (!file.record) continue;
        identities.push(file.record.holder);
        if (typeof file.record.child === 'object') identities.push(file.record.child);
      }
    }
    const answer = await queryCreations(identities);
    const byKey = new Map<string, JudgedLeases>();
    for (const folder of folders) {
      if (!folder.listed) {
        byKey.set(folder.key, { liveness: 'unknown', dead: [] });
        continue;
      }
      const each = folder.files.map((file) => (file.record ? judgeLease(file.record, answer) : 'unknown'));
      byKey.set(folder.key, {
        liveness: aggregateLiveness(each),
        dead: folder.files.filter((_file, index) => each[index] === 'dead').map((file) => file.name),
      });
    }
    return { byKey, answer };
  }

  async function leaseLiveness(ref: InstanceRef, key: VersionKey): Promise<Liveness> {
    const paths = pathsOf(ref);
    checkKey(key);
    const judged = await judgeLeaseFolders([leaseFolder(paths.leases, ref.storeId, key)]);
    return judged.byKey.get(key)?.liveness ?? 'unknown';
  }

  /** Any entry in `leases\<key>\`, or a folder that cannot be listed, is a lease present. */
  function leasePresent(paths: InstancePaths, key: VersionKey): boolean {
    const names = list(path.join(paths.leases, key));
    return names === undefined || names.length > 0;
  }

  // ---- Work folders -------------------------------------------------------------------------------

  function workPathsOf(storeId: StoreId, workToken: string): WorkFolder {
    instanceRoot(storeId);
    checkToken(workToken);
    const root = path.join(roots.work, storeId, workToken);
    return Object.freeze({ storeId, token: workToken, root, cwd: path.join(root, 'cwd'), tmp: path.join(root, 'tmp'), home: path.join(root, 'home') });
  }

  function createWorkFolder(ref: InstanceRef, workToken: string): WorkFolder {
    pathsOf(ref);
    const folder = workPathsOf(ref.storeId, workToken);
    mkdirAllowExisting(roots.work);
    mkdirAllowExisting(path.join(roots.work, ref.storeId));
    fs.mkdir(folder.root);
    fs.mkdir(folder.cwd);
    fs.mkdir(folder.tmp);
    fs.mkdir(folder.home);
    return folder;
  }

  async function removeWorkFolder(folder: WorkFolder): Promise<void> {
    if (!isRecord(folder)) throw new TypeError('This is not a work folder of the managed store.');
    const derived = workPathsOf(folder.storeId, folder.token);
    if (folder.root !== derived.root || folder.cwd !== derived.cwd || folder.tmp !== derived.tmp || folder.home !== derived.home) {
      throw new TypeError('This work folder does not belong to this store.');
    }
    await removeTree(derived.root);
  }

  // ---- Version retention and orphans ----------------------------------------------------------------

  function withoutKey(key: VersionKey): InstanceChange {
    return {
      label: `retire ${key}`,
      apply: (current) => {
        if (!(key in current.versions) && !(key in current.probes)) return { moot: true };
        const versions = { ...current.versions };
        const probes = { ...current.probes };
        delete versions[key];
        delete probes[key];
        return { ...contentOf(current), versions, probes };
      },
    };
  }

  /**
   * The trash steps for one key, each decided afresh: remove the leases proven dead; under the admission gate, publish
   * the record without the key's facts (or, for an orphan, see that no fact names it) and move the folder to
   * `trash\<key>.<token>`; then look at the key's leases again. A lease present moves the folder back; otherwise it is
   * marked decided (`trash\<token>`) and deleted file by file. Holding the gate means that a retired instance, whose
   * gate a Reset closed, never loses a version this way.
   */
  async function retireKey(ref: InstanceRef, key: VersionKey, deadLeases: readonly string[], mode: 'facts' | 'orphan'): Promise<RetireOutcome> {
    const paths = pathsOf(ref);
    for (const name of deadLeases) {
      try {
        fs.unlink(path.join(paths.leases, key, name));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') return { outcome: 'deferred', code: `lease-${errorCode(error)}` };
      }
    }
    // Decided afresh: a lease that appeared since the leases were judged keeps the facts and the folder.
    if (leasePresent(paths, key)) return { outcome: 'deferred', code: 'lease-present' };
    const folder = path.join(paths.versions, key);
    const trashed = path.join(paths.trash, `${key}.${token()}`);
    const gate = acquireAdmission(ref);
    if (!gate.ok) return { outcome: 'deferred', code: `admission-${gate.reason}` };
    try {
      if (mode === 'facts') {
        // The facts go first: a folder no fact names cannot become launchable, whatever happens next.
        const result = await publish(ref, withoutKey(key));
        if (result.outcome !== 'published' && result.outcome !== 'moot') return { outcome: 'deferred', code: `publish-${result.outcome}` };
      } else {
        const view = read(ref);
        if (view.kind !== 'readable' || key in view.snapshot.record.versions) return { outcome: 'deferred', code: 'listed' };
      }
      try {
        fs.rename(folder, trashed);
      } catch (error) {
        return errorCode(error) === 'ENOENT' ? { outcome: 'gone' } : { outcome: 'deferred', code: errorCode(error) };
      }
    } finally {
      gate.handle.release();
    }
    return settleTrashed(paths, key, trashed);
  }

  async function settleTrashed(paths: InstancePaths, key: VersionKey, trashed: string): Promise<RetireOutcome> {
    if (leasePresent(paths, key)) {
      try {
        fs.rename(trashed, path.join(paths.versions, key));
        return { outcome: 'restored' };
      } catch (error) {
        // The name was taken meanwhile, or the move failed: the copy stays undecided in trash for a later cycle.
        return { outcome: 'deferred', code: `restore-${errorCode(error)}` };
      }
    }
    const decided = path.join(paths.trash, token());
    try {
      fs.rename(trashed, decided);
    } catch (error) {
      // Gone: another window's cycle decided it first and deletes it.
      return errorCode(error) === 'ENOENT' ? { outcome: 'collected' } : { outcome: 'deferred', code: errorCode(error) };
    }
    await removeTree(decided);
    return { outcome: 'collected' };
  }

  /** What earlier cycles left in `trash\`: decided entries are deleted; undecided ones are decided again from fresh leases. */
  async function sweepTrash(ref: InstanceRef): Promise<void> {
    const paths = pathsOf(ref);
    for (const name of list(paths.trash) ?? []) {
      const entry = path.join(paths.trash, name);
      if (TRASH_DECIDED.test(name)) {
        await removeTree(entry);
        continue;
      }
      if (name === 'manifests') {
        for (const file of list(entry) ?? []) await removeTree(path.join(entry, file));
        continue;
      }
      const key = TRASH_UNDECIDED.exec(name)?.[1];
      if (!key) {
        log(`managed Codex store ${ref.storeId}: "${name.slice(0, 80)}" in trash is not the store's; it was left alone`);
        continue;
      }
      const judged = (await judgeLeaseFolders([leaseFolder(paths.leases, ref.storeId, key)])).byKey.get(key);
      if (!judged || judged.liveness !== 'dead') {
        if (!exists(path.join(paths.versions, key))) {
          try { fs.rename(entry, path.join(paths.versions, key)); } catch { /* looked at again in a later cycle */ }
        }
        continue;
      }
      let removed = true;
      for (const lease of judged.dead) {
        try { fs.unlink(path.join(paths.leases, key, lease)); } catch (error) { if (errorCode(error) !== 'ENOENT') removed = false; }
      }
      if (!removed || leasePresent(paths, key)) continue;
      const decided = path.join(paths.trash, token());
      try {
        fs.rename(entry, decided);
      } catch {
        continue;
      }
      await removeTree(decided);
    }
  }

  function policyOrder(a: PromotedVersion, b: PromotedVersion): number {
    const byVersion = compareCliVersions(a.version, b.version) ?? 0;
    if (byVersion !== 0) return byVersion;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  async function collectVersions(ref: InstanceRef, input: VersionCollectionInput): Promise<VersionCollectionReport> {
    const paths = pathsOf(ref);
    if (!isRecord(input) || typeof (input.protectedKeys as { has?: unknown })?.has !== 'function') {
      throw new TypeError('Version collection needs the keys control protects.');
    }
    if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > INSTANCE_LIMITS.maxVersions) {
      throw new TypeError('Version collection keeps between 1 and 64 versions.');
    }
    const report: VersionCollectionReport = { kept: [], collected: [], restored: [], deferred: [] };
    await sweepTrash(ref);
    const view = readPaths(paths, ref.storeId);
    if (view.kind !== 'readable') return report;
    const candidates = Object.values(view.snapshot.record.versions)
      .filter((facts) => isRealDirectory(path.join(paths.versions, facts.key)))
      .sort(policyOrder);
    const judged = (await judgeLeaseFolders(candidates.map((facts) => leaseFolder(paths.leases, ref.storeId, facts.key)))).byKey;
    const why = new Map<VersionKey, VersionCollectionReport['kept'][number]['why'] | undefined>();
    for (const facts of candidates) {
      const liveness = judged.get(facts.key)?.liveness ?? 'unknown';
      why.set(facts.key, input.protectedKeys.has(facts.key) ? 'active-or-lkg'
        : liveness === 'alive' ? 'lease-alive'
          : liveness === 'unknown' ? 'lease-unknown'
            : undefined);
    }
    // A folder kept by a lease is kept beside the newest ones, not instead of one of them: an old session never
    // makes the newest download go.
    let counted = candidates.filter((facts) => why.get(facts.key) !== 'lease-alive' && why.get(facts.key) !== 'lease-unknown').length;
    const done = new Set<VersionKey>();
    for (const facts of candidates) {
      if (counted <= input.keep) break;
      if (why.get(facts.key) !== undefined) continue;
      done.add(facts.key);
      const outcome = await retireKey(ref, facts.key, judged.get(facts.key)?.dead ?? [], 'facts');
      if (outcome.outcome === 'collected' || outcome.outcome === 'gone') {
        report.collected.push(facts.key);
        counted--;
        continue;
      }
      // A lease appeared, or a step failed: nothing more this cycle; the next one decides again from fresh reads.
      if (outcome.outcome === 'restored') report.restored.push(facts.key);
      else report.deferred.push({ key: facts.key, code: outcome.code });
      break;
    }
    for (const facts of candidates) {
      if (!done.has(facts.key)) report.kept.push({ key: facts.key, why: why.get(facts.key) ?? 'newest' });
    }
    return report;
  }

  async function retireVersion(ref: InstanceRef, key: VersionKey): Promise<VersionRetirement> {
    const paths = pathsOf(ref);
    checkKey(key);
    const judged = (await judgeLeaseFolders([leaseFolder(paths.leases, ref.storeId, key)])).byKey.get(key);
    if (!judged || judged.liveness !== 'dead') {
      return { ok: false, reason: 'in-use', detail: `${key} may be in use (its lease is ${judged?.liveness ?? 'unknown'}); nothing was retired.` };
    }
    const view = readPaths(paths, ref.storeId);
    if (view.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: view.detail };
    const outcome = await retireKey(ref, key, judged.dead, 'facts');
    if (outcome.outcome === 'collected' || outcome.outcome === 'gone') return { ok: true, key };
    if (outcome.outcome === 'restored' || outcome.code === 'lease-present') {
      return { ok: false, reason: 'in-use', detail: `${key} came into use while it was retired; nothing was retired.` };
    }
    if (outcome.code.startsWith('admission-')) return { ok: false, reason: 'admission-closed', detail: `Managed Codex is being reset or was reset (${outcome.code}).` };
    return { ok: false, reason: 'deferred', detail: `${key} could not be retired now (${outcome.code}).` };
  }

  async function retireOrphans(ref: InstanceRef): Promise<VersionKey[]> {
    const paths = pathsOf(ref);
    const view = readPaths(paths, ref.storeId);
    if (view.kind !== 'readable') return [];
    const record = view.snapshot.record;
    const time = now();
    const orphans = listVersionFolders(ref).filter((key) => {
      if (key in record.versions) return false;
      const stat = statOf(path.join(paths.versions, key));
      return !!stat && time - stat.mtimeMs > INSTANCE_LIMITS.orphanAgeMs;
    });
    if (orphans.length === 0) return [];
    const intents = Object.values(record.stagingIntents);
    const judged = await judgeLeaseFolders(orphans.map((key) => leaseFolder(paths.leases, ref.storeId, key)), intents.map((intent) => intent.owner));
    const intended = new Set(intents.filter((intent) => judgeProcessIdentity(intent.owner, judged.answer) !== 'dead').map((intent) => intent.key));
    const retired: VersionKey[] = [];
    for (const key of orphans) {
      const leases = judged.byKey.get(key);
      if (intended.has(key) || !leases || leases.liveness !== 'dead') continue;
      const outcome = await retireKey(ref, key, leases.dead, 'orphan');
      if (outcome.outcome === 'collected') retired.push(key);
      else if (outcome.outcome === 'deferred' && outcome.code.startsWith('admission-')) break;
    }
    return retired;
  }

  // ---- Whole instances ------------------------------------------------------------------------------

  /** Every lease of an instance, judged with one fresh query; `dead` names `<key>/<file>`. Anything unexpected is unknown. */
  async function judgeInstanceLeases(root: string, storeId: StoreId): Promise<{ liveness: Liveness; dead: Set<string> }> {
    const leasesRoot = path.join(root, 'leases');
    const names = list(leasesRoot);
    if (!names) return { liveness: 'unknown', dead: new Set() };
    if (names.some((name) => !isManagedVersionKey(name) || !isRealDirectory(path.join(leasesRoot, name)))) return { liveness: 'unknown', dead: new Set() };
    const folders = names.map((key) => leaseFolder(leasesRoot, storeId, key));
    const judged = (await judgeLeaseFolders(folders)).byKey;
    const dead = new Set<string>();
    for (const [key, leases] of judged) for (const name of leases.dead) dead.add(`${key}/${name}`);
    return { liveness: aggregateLiveness([...judged.values()].map((leases) => leases.liveness)), dead };
  }

  /** True when a moved instance holds a lease that was not proven dead before the move. */
  function instanceLeasesChanged(root: string, dead: ReadonlySet<string>): boolean {
    const leasesRoot = path.join(root, 'leases');
    const keys = list(leasesRoot);
    if (!keys) return true;
    for (const key of keys) {
      const files = list(path.join(leasesRoot, key));
      if (!files) return true;
      if (files.some((name) => !dead.has(`${key}/${name}`))) return true;
    }
    return false;
  }

  function newestMtime(root: string): number {
    const folder = statOf(root);
    if (!folder) return Number.POSITIVE_INFINITY;
    const identity = statOf(path.join(root, 'identity.bin'));
    return Math.max(folder.mtimeMs, identity?.mtimeMs ?? Number.NEGATIVE_INFINITY);
  }

  async function sweepInstanceTrash(): Promise<void> {
    for (const name of list(roots.instanceTrash) ?? []) {
      const entry = path.join(roots.instanceTrash, name);
      if (TRASH_DECIDED.test(name)) {
        await removeTree(entry);
        continue;
      }
      const storeId = INSTANCE_TRASH_UNDECIDED.exec(name)?.[1];
      if (!storeId) {
        log(`managed Codex store: "${name.slice(0, 80)}" in instance-trash is not the store's; it was left alone`);
        continue;
      }
      const judged = await judgeInstanceLeases(entry, storeId);
      if (judged.liveness !== 'dead') {
        if (!exists(instanceRoot(storeId))) {
          try { fs.rename(entry, instanceRoot(storeId)); } catch { /* looked at again in a later cycle */ }
        }
        continue;
      }
      if (instanceLeasesChanged(entry, judged.dead)) continue;
      const decided = path.join(roots.instanceTrash, token());
      try {
        fs.rename(entry, decided);
      } catch {
        continue;
      }
      await removeTree(decided);
    }
  }

  async function collectInstances(current: StoreId | null, retired: ReadonlyArray<{ storeId: StoreId; retiredAt: string }>): Promise<StoreId[]> {
    if (current !== null && !isStoreToken(current)) throw new TypeError('The current store instance is not a store id.');
    if (!Array.isArray(retired) || !retired.every((entry) => isRecord(entry) && isStoreToken(entry.storeId) && typeof entry.retiredAt === 'string')) {
      throw new TypeError('The retired store instances are not valid.');
    }
    const time = now();
    await sweepInstanceTrash();
    const collected: StoreId[] = [];
    for (const name of list(roots.instances) ?? []) {
      if (!isStoreToken(name)) {
        log(`managed Codex store: "${String(name).slice(0, 80)}" in instances is not a store instance; it was left alone`);
        continue;
      }
      if (name === current) continue;
      const root = instanceRoot(name);
      if (!isRealDirectory(root)) continue;
      const entry = retired.find((item) => item.storeId === name);
      if (entry) {
        const retiredAt = isTime(entry.retiredAt) ? Date.parse(entry.retiredAt) : Number.NaN;
        if (!(time - retiredAt >= INSTANCE_LIMITS.retiredGraceMs)) continue;
      } else if (!(time - newestMtime(root) > INSTANCE_LIMITS.unpublishedInstanceAgeMs)) {
        continue;
      }
      const leases = await judgeInstanceLeases(root, name);
      if (leases.liveness !== 'dead') continue;
      try {
        mkdirAllowExisting(roots.instanceTrash);
      } catch {
        return collected;
      }
      const trashed = path.join(roots.instanceTrash, `${name}.${token()}`);
      try {
        fs.rename(root, trashed);
      } catch {
        continue;
      }
      if (instanceLeasesChanged(trashed, leases.dead)) {
        try { fs.rename(trashed, root); } catch { /* looked at again in a later cycle */ }
        continue;
      }
      const decided = path.join(roots.instanceTrash, token());
      try {
        fs.rename(trashed, decided);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') collected.push(name);
        continue;
      }
      await removeTree(path.join(roots.work, name));
      await removeTree(decided);
      collected.push(name);
    }
    // Work folders of instances that no longer exist (a collection stopped before it reached them).
    for (const name of list(roots.work) ?? []) {
      if (isStoreToken(name) && name !== current && !exists(instanceRoot(name))) await removeTree(path.join(roots.work, name));
    }
    return collected;
  }

  return {
    create,
    open,
    admissionState,
    acquireAdmission,
    closeAdmission,
    read,
    publish,
    versionFolder,
    listVersionFolders,
    createStaging,
    discardStaging,
    promote,
    createLease,
    recordLeaseChild,
    releaseLease,
    leaseLiveness,
    createWorkFolder,
    removeWorkFolder,
    usageBytes,
    collectVersions,
    retireOrphans,
    collectInstances,
    repairManifest,
    retireVersion,
  };
}
