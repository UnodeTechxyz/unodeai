/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the managed Codex store's control journal (v0.9.97)
 *  `<cli-store>\control\` says which store instance, if any, is enrolled, whether new sessions use it, and every
 *  decision that can take launch authority away: consented hosts, automatic mode, activation consents, the active
 *  and last known good versions, and every disabled version. It is the one place where these change.
 *
 *  Each change is published as the next generation after the exact record it was decided on; a writer that loses
 *  decides again from the winner. Every reduction of authority takes a new floor epoch and writes it into
 *  `control\authority\floor.bin` before it is reported, so losing the newest generation reads as behind the floor,
 *  never as the older authority. When control cannot be read or trusted, nothing managed runs, and the user can
 *  still choose the external CLI through `managed-suspended.json`, which only removes authority.
 *--------------------------------------------------------------------------------------------*/

import { lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { compareCliVersions } from '../../backend/cliRuntime';
import type {
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
  StoreId,
  SuspensionView,
} from './contracts';
import { createFloor, FLOOR_SEAL, nextReductionEpoch, nodeFloorFs, readFloor, writeFloorEpoch, type FloorFs } from './controlFloor';
import {
  generationFileName,
  JOURNAL_MAX_RECORD_BYTES,
  nodeJournalFs,
  publishGeneration,
  readJournal,
  trimJournal,
  type JournalEntry,
  type JournalFs,
  type JournalParse,
  type JournalSpec,
} from './generationJournal';
import { canonicalJson, cliStoreRoots, isStoreToken, newStoreToken, recordDigest } from './storeLayout';

export const CONTROL_SCHEMA = 'unodeai.cli-control/1';
export const CONTROL_JOURNAL_PREFIX = 'control';
/** A change is decided again at most this many times after another window won; then it is `busy`. */
export const CONTROL_PUBLISH_ROUNDS = 5;
/** Each list of a control record holds at most this many entries. */
export const CONTROL_LIST_MAX = 1000;
export const CONTROL_HOSTS_MAX = 16;
/** A larger suspension file is not read; it still counts as present. */
export const SUSPENSION_MAX_BYTES = 4 * 1024;
const DETAIL_MAX_CHARS = 500;
const SUSPENSION_TEXT_MAX_CHARS = 300;
/** How long `initialize` waits for another window that is creating the floor (about 5 ms of work). */
const INITIALIZE_WAIT_MS = 1000;
const INITIALIZE_ATTEMPTS = 50;

/** The file operations of the control store: the floor's, plus folders, listing and removal. */
export interface ControlFs extends FloorFs {
  /** Creates one folder; never its parents. */
  mkdir(folder: string): void;
  readdir(folder: string): string[];
  lstat(file: string): { isFile(): boolean; size: number };
  unlink(file: string): void;
}

export const nodeControlFs: ControlFs = {
  ...nodeFloorFs,
  mkdir: (folder) => mkdirSync(folder),
  readdir: (folder) => readdirSync(folder),
  lstat: (file) => lstatSync(file),
  unlink: (file) => unlinkSync(file),
};

export interface ControlStoreDeps {
  /** `<cli-store>`, created and location-checked by the caller. */
  root: string;
  /** The admission gate of an instance, from the instance store. */
  admissionState(storeId: StoreId): AdmissionGateState;
  fs?: ControlFs;
  journalFs?: JournalFs;
  now?: () => Date;
  /** Journal ids and temp-file names. */
  newId?: () => string;
  /** The epoch rule; replaced only by tests that prove when it is reached. */
  nextEpoch?: (predecessorEpoch: number, floor: number) => number;
}

// ---- The record ---------------------------------------------------------------------------------

const RECORD_KEYS = new Set([
  'schema', 'controlId', 'generation', 'previousRecordDigest', 'recordDigest', 'reductionEpoch', 'sealed',
  'enrolledStoreId', 'selection', 'enrollment', 'scheduler', 'activationConsents', 'active', 'lastKnownGood',
  'disabled', 'retiredInstances', 'decidedAt',
]);
const DISABLED_REASONS: ReadonlySet<DisabledReason> = new Set(['local-bad', 'probe-failed', 'probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn']);
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** `<version>-<os>-<arch>-<16 hex>`, as `cliStoreVersionKey` names a policy entry's folder; managed is Windows x64 only. */
const VERSION_KEY = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-win32-x64-[0-9a-f]{16}$/;
const NEWER_SCHEMA = /^unodeai\.cli-control\/([1-9]\d{0,8})$/;
const GENERATION_NAME = /^control-(\d{10})\.json$/;

type Fields = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

function isFields(value: unknown): value is Fields {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** An object with exactly these keys (the optional ones may be missing). */
function shaped(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []): Checked<Fields> {
  if (!isFields(value)) return { ok: false, detail: `${what} is not an object` };
  for (const key of required) if (!(key in value)) return { ok: false, detail: `${what} has no \`${key}\`` };
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  return extra === undefined ? { ok: true, value } : { ok: false, detail: `${what} has an unknown field \`${extra}\`` };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

function isVersionKey(value: unknown): value is string {
  return typeof value === 'string' && VERSION_KEY.test(value);
}

function list<T>(value: unknown, what: string, max: number, item: (entry: unknown, label: string) => Checked<T>): Checked<T[]> {
  if (!Array.isArray(value)) return { ok: false, detail: `\`${what}\` is not a list` };
  if (value.length > max) return { ok: false, detail: `\`${what}\` has more than ${max} entries` };
  const items: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const checked = item(value[index], `\`${what}\` entry ${index}`);
    if (!checked.ok) return checked;
    items.push(checked.value);
  }
  return { ok: true, value: items };
}

/** An object naming one version of one instance, with exactly the other fields listed. */
function versionRef(value: unknown, what: string, required: readonly string[] = [], optional: readonly string[] = []): Checked<{ storeId: StoreId; key: string }> {
  const fields = shaped(value, what, ['storeId', 'key', ...required], optional);
  if (!fields.ok) return fields;
  if (!isStoreToken(fields.value.storeId)) return { ok: false, detail: `${what} names no valid store id` };
  if (!isVersionKey(fields.value.key)) return { ok: false, detail: `${what} names no valid version key` };
  return { ok: true, value: { storeId: fields.value.storeId, key: fields.value.key } };
}

/**
 * A control record, checked field by field, or why it is not one. A record of `unodeai.cli-control/<n>` with n > 1
 * is `newerSchema`: a newer UnodeAi wrote it, and this one does not use the journal.
 */
export function checkControlRecord(value: unknown): { ok: true; record: ControlRecord } | { ok: false; newerSchema?: true; detail: string } {
  if (!isFields(value)) return { ok: false, detail: 'not a record' };
  if (value.schema !== CONTROL_SCHEMA) {
    const newer = typeof value.schema === 'string' ? NEWER_SCHEMA.exec(value.schema) : null;
    if (newer && Number(newer[1]) > 1) return { ok: false, newerSchema: true, detail: `written as ${value.schema}` };
    return { ok: false, detail: `\`schema\` is not ${CONTROL_SCHEMA}` };
  }
  const extra = Object.keys(value).find((key) => !RECORD_KEYS.has(key));
  if (extra !== undefined) return { ok: false, detail: `unknown field \`${extra}\`` };
  if (!isStoreToken(value.controlId)) return { ok: false, detail: '`controlId` is not 32 lower-case hex digits' };
  if (!isCount(value.generation) || value.generation < 1) return { ok: false, detail: '`generation` is not a positive integer' };
  if (value.previousRecordDigest !== null && !(typeof value.previousRecordDigest === 'string' && DIGEST.test(value.previousRecordDigest))) {
    return { ok: false, detail: '`previousRecordDigest` is neither null nor a digest' };
  }
  const epoch = value.reductionEpoch;
  if (!isCount(epoch) || epoch > FLOOR_SEAL) return { ok: false, detail: `\`reductionEpoch\` is not an integer from 0 to ${FLOOR_SEAL}` };
  if ('sealed' in value && value.sealed !== true) return { ok: false, detail: '`sealed` is present but not true' };
  if ((value.sealed === true) !== (epoch === FLOOR_SEAL)) return { ok: false, detail: `\`sealed\` is set exactly at epoch ${FLOOR_SEAL}` };

  for (const key of ['enrolledStoreId', 'selection', 'enrollment', 'scheduler', 'activationConsents', 'active', 'lastKnownGood', 'disabled', 'retiredInstances', 'decidedAt']) {
    if (!(key in value)) return { ok: false, detail: `no \`${key}\`` };
  }
  const enrolled = value.enrolledStoreId;
  if (enrolled !== null && !isStoreToken(enrolled)) return { ok: false, detail: '`enrolledStoreId` is neither null nor a store id' };
  if (value.selection !== 'managed' && value.selection !== 'external') return { ok: false, detail: '`selection` is neither managed nor external' };
  if (value.selection === 'managed' && enrolled === null) return { ok: false, detail: '`selection` is managed without an enrolled instance' };

  let enrollment: ControlContent['enrollment'] = null;
  if ((value.enrollment === null) !== (enrolled === null)) return { ok: false, detail: '`enrollment` is set exactly when an instance is enrolled' };
  if (value.enrollment !== null) {
    const fields = shaped(value.enrollment, '`enrollment`', ['epoch', 'consentedHosts', 'decidedAt']);
    if (!fields.ok) return fields;
    if (!isCount(fields.value.epoch)) return { ok: false, detail: '`enrollment.epoch` is not a count' };
    const hosts = list(fields.value.consentedHosts, 'enrollment.consentedHosts', CONTROL_HOSTS_MAX, (host, label): Checked<string> =>
      typeof host === 'string' && HOSTNAME.test(host) ? { ok: true, value: host } : { ok: false, detail: `${label} is not a lower-case host name` });
    if (!hosts.ok) return hosts;
    if (new Set(hosts.value).size !== hosts.value.length) return { ok: false, detail: '`enrollment.consentedHosts` names a host twice' };
    if (!isTime(fields.value.decidedAt)) return { ok: false, detail: '`enrollment.decidedAt` is not a time' };
    enrollment = { epoch: fields.value.epoch, consentedHosts: hosts.value, decidedAt: fields.value.decidedAt };
  }

  const scheduler = shaped(value.scheduler, '`scheduler`', ['epoch', 'autoMode']);
  if (!scheduler.ok) return scheduler;
  if (!isCount(scheduler.value.epoch) || typeof scheduler.value.autoMode !== 'boolean') return { ok: false, detail: '`scheduler` is not an epoch and a switch' };

  const consents = list(value.activationConsents, 'activationConsents', CONTROL_LIST_MAX, (entry, label) => {
    const ref = versionRef(entry, label, ['closureDigest', 'decidedAt']);
    if (!ref.ok) return ref;
    const fields = shaped(entry, label, ['storeId', 'key', 'closureDigest', 'decidedAt']);
    if (!fields.ok) return fields;
    if (typeof fields.value.closureDigest !== 'string' || !DIGEST.test(fields.value.closureDigest)) return { ok: false, detail: `${label} names no closure digest` };
    if (!isTime(fields.value.decidedAt)) return { ok: false, detail: `${label} has no decision time` };
    return { ok: true, value: { ...ref.value, closureDigest: fields.value.closureDigest, decidedAt: fields.value.decidedAt } };
  });
  if (!consents.ok) return consents;

  const roles: { active: ControlContent['active']; lastKnownGood: ControlContent['lastKnownGood'] } = { active: null, lastKnownGood: null };
  for (const role of ['active', 'lastKnownGood'] as const) {
    if (value[role] === null) continue;
    const ref = versionRef(value[role], `\`${role}\``);
    if (!ref.ok) return ref;
    if (ref.value.storeId !== enrolled) return { ok: false, detail: `\`${role}\` names an instance that is not the enrolled one` };
    roles[role] = ref.value;
  }

  const disabled = list(value.disabled, 'disabled', CONTROL_LIST_MAX, (entry, label) => {
    const ref = versionRef(entry, label, ['reason', 'at'], ['closureDigest', 'detail']);
    if (!ref.ok) return ref;
    const fields = shaped(entry, label, ['storeId', 'key', 'reason', 'at'], ['closureDigest', 'detail']);
    if (!fields.ok) return fields;
    const { reason, at, closureDigest, detail } = fields.value;
    if (typeof reason !== 'string' || !DISABLED_REASONS.has(reason as DisabledReason)) return { ok: false, detail: `${label} has no known reason` };
    if (!isTime(at)) return { ok: false, detail: `${label} has no time` };
    if (closureDigest !== undefined && (typeof closureDigest !== 'string' || !DIGEST.test(closureDigest))) return { ok: false, detail: `${label} names no valid closure digest` };
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > DETAIL_MAX_CHARS)) return { ok: false, detail: `${label} has a detail that is not a short text` };
    return {
      ok: true,
      value: {
        ...ref.value, reason: reason as DisabledReason, at,
        ...(closureDigest !== undefined ? { closureDigest: closureDigest as string } : {}),
        ...(detail !== undefined ? { detail: detail as string } : {}),
      },
    };
  });
  if (!disabled.ok) return disabled;

  const retired = list(value.retiredInstances, 'retiredInstances', CONTROL_LIST_MAX, (entry, label): Checked<{ storeId: StoreId; retiredAt: string }> => {
    const fields = shaped(entry, label, ['storeId', 'retiredAt']);
    if (!fields.ok) return fields;
    if (!isStoreToken(fields.value.storeId) || !isTime(fields.value.retiredAt)) return { ok: false, detail: `${label} is not a store id and a time` };
    return { ok: true, value: { storeId: fields.value.storeId, retiredAt: fields.value.retiredAt } };
  });
  if (!retired.ok) return retired;
  if (!isTime(value.decidedAt)) return { ok: false, detail: '`decidedAt` is not a time' };

  return {
    ok: true,
    record: {
      schema: CONTROL_SCHEMA,
      controlId: value.controlId,
      generation: value.generation,
      previousRecordDigest: value.previousRecordDigest as string | null,
      reductionEpoch: epoch,
      ...(value.sealed === true ? { sealed: true as const } : {}),
      enrolledStoreId: enrolled,
      selection: value.selection,
      enrollment,
      scheduler: { epoch: scheduler.value.epoch, autoMode: scheduler.value.autoMode },
      activationConsents: consents.value,
      active: roles.active,
      lastKnownGood: roles.lastKnownGood,
      disabled: disabled.value,
      retiredInstances: retired.value,
      decidedAt: value.decidedAt,
    },
  };
}

/** The journal's parse step for control generations. */
export function parseControlRecord(value: unknown): JournalParse<ControlRecord> {
  const checked = checkControlRecord(value);
  if (checked.ok) return { ok: true, record: checked.record };
  return checked.newerSchema ? { ok: false, newerSchema: true, detail: checked.detail } : { ok: false, detail: checked.detail };
}

const KEY_SUFFIX = /-win32-x64-[0-9a-f]{16}$/;

/** Whether version key `next` names a strictly newer version than `previous`. */
function newerKey(next: string, previous: string): boolean {
  return compareCliVersions(next.replace(KEY_SUFFIX, ''), previous.replace(KEY_SUFFIX, '')) === 1;
}

/**
 * Every way `next` takes authority away from `previous`; each must be published as a reduction. Another or no
 * enrolled instance; External selected; a consented host removed, or the enrolment epoch changed; automatic mode
 * turned off, or the scheduler epoch changed; an activation consent withdrawn; `active` or `lastKnownGood` moved to
 * anything but a newer version of the same instance; any change to the disabled versions (an entry added, replaced
 * or removed, removing one being the user's recorded re-decision).
 */
export function authorityReductions(previous: ControlContent, next: ControlContent): string[] {
  const found: string[] = [];
  if (previous.enrolledStoreId !== null && next.enrolledStoreId !== previous.enrolledStoreId) found.push('the enrolled instance');
  if (previous.selection === 'managed' && next.selection !== 'managed') found.push('the selection');
  if (previous.enrollment && previous.enrolledStoreId === next.enrolledStoreId) {
    const hosts = new Set(next.enrollment?.consentedHosts ?? []);
    if (previous.enrollment.consentedHosts.some((host) => !hosts.has(host))) found.push('a consented host');
    if (next.enrollment?.epoch !== previous.enrollment.epoch) found.push('the enrolment epoch');
  }
  if (previous.scheduler.autoMode && !next.scheduler.autoMode) found.push('automatic mode');
  if (next.scheduler.epoch !== previous.scheduler.epoch) found.push('the scheduler epoch');
  const consent = (entry: ControlContent['activationConsents'][number]) => `${entry.storeId}/${entry.key}/${entry.closureDigest}`;
  const consents = new Set(next.activationConsents.map(consent));
  if (previous.activationConsents.some((entry) => !consents.has(consent(entry)))) found.push('an activation consent');
  for (const role of ['active', 'lastKnownGood'] as const) {
    const before = previous[role];
    const after = next[role];
    if (!before || (after && after.storeId === before.storeId && after.key === before.key)) continue;
    if (!(after && after.storeId === before.storeId && newerKey(after.key, before.key))) found.push(`the ${role} version`);
  }
  const entries = (list: ControlContent['disabled']) => list.map((entry) => canonicalJson(entry)).sort().join('\n');
  if (entries(previous.disabled) !== entries(next.disabled)) found.push('the disabled versions');
  return found;
}

/** An epoch that falls would let a task decided on the older epoch go on; no change may lower one. */
function loweredEpoch(previous: ControlContent, next: ControlContent): string | undefined {
  if (next.scheduler.epoch < previous.scheduler.epoch) return 'the scheduler epoch';
  if (previous.enrollment && next.enrollment && previous.enrolledStoreId === next.enrolledStoreId && next.enrollment.epoch < previous.enrollment.epoch) {
    return 'the enrolment epoch';
  }
  return undefined;
}

/** The fields a change sets; anything else it returns is not part of the record. */
function contentOf(value: ControlContent): ControlContent {
  return {
    enrolledStoreId: value.enrolledStoreId,
    selection: value.selection,
    enrollment: value.enrollment,
    scheduler: value.scheduler,
    activationConsents: value.activationConsents,
    active: value.active,
    lastKnownGood: value.lastKnownGood,
    disabled: value.disabled,
    retiredInstances: value.retiredInstances,
    decidedAt: value.decidedAt,
  };
}

// ---- The store ----------------------------------------------------------------------------------

/** The control journal of the store at `root`: `control\manifests\control-<g>.json`. */
export function controlJournalSpec(root: string): JournalSpec<ControlRecord> {
  return { folder: cliStoreRoots(root).controlManifests, prefix: CONTROL_JOURNAL_PREFIX, parse: parseControlRecord };
}

export function createControlStore(deps: ControlStoreDeps): ControlStoreApi {
  const roots = cliStoreRoots(deps.root);
  const fs = deps.fs ?? nodeControlFs;
  const journalFs = deps.journalFs ?? nodeJournalFs;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newStoreToken;
  const epochRule = deps.nextEpoch ?? nextReductionEpoch;
  const spec = controlJournalSpec(deps.root);

  const unusable = (reason: ControlUnusableReason, detail: string, snapshot?: ControlSnapshot): ControlView =>
    ({ kind: 'unusable', reason, detail, ...(snapshot ? { snapshot } : {}) });

  /**
   * Whether a generation this window just linked is in the chain that readers follow. Trimming frees old names, so
   * a writer that read the journal more generations ago than are kept can link such a name again: it wins the name,
   * not the chain. The link counts when no later generation exists, or when the next one names its digest; a later
   * generation that names another digest makes it `stale`; anything else cannot be confirmed.
   */
  function chainHolds(entry: { generation: number; digest: string }): { chain: 'in-chain' | 'stale' } | { chain: 'unknown'; why: string } {
    let names: string[];
    try {
      names = journalFs.readdir(spec.folder);
    } catch (error) {
      return { chain: 'unknown', why: `the record folder could not be listed (${errorCode(error)})` };
    }
    const later = names.some((name) => {
      const match = GENERATION_NAME.exec(name);
      return !!match && Number(match[1]) > entry.generation;
    });
    if (!later) return { chain: 'in-chain' };
    let next: unknown;
    try {
      const bytes = journalFs.readFile(path.join(spec.folder, generationFileName(CONTROL_JOURNAL_PREFIX, entry.generation + 1)), JOURNAL_MAX_RECORD_BYTES);
      if (!bytes) return { chain: 'unknown', why: 'the next generation is too large' };
      next = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      return { chain: 'unknown', why: `the next generation could not be read (${errorCode(error)})` };
    }
    if (!isFields(next) || typeof next.recordDigest !== 'string' || next.recordDigest !== recordDigest(next) || typeof next.previousRecordDigest !== 'string') {
      return { chain: 'unknown', why: 'the next generation is not a record' };
    }
    return { chain: next.previousRecordDigest === entry.digest ? 'in-chain' : 'stale' };
  }

  function removeStale(generation: number): void {
    try { journalFs.unlink(path.join(spec.folder, generationFileName(CONTROL_JOURNAL_PREFIX, generation))); } catch { /* not read by anyone: a later generation exists */ }
  }
  const snapshotOf = (entry: JournalEntry<ControlRecord>): ControlSnapshot => ({ generation: entry.generation, record: entry.record, digest: entry.digest });

  /** Any entry under `instances\`, or a listing that fails for another reason than absence. */
  function instancesExist(): boolean {
    try {
      return fs.readdir(roots.instances).length > 0;
    } catch (error) {
      return errorCode(error) !== 'ENOENT';
    }
  }

  function gateOf(storeId: StoreId): AdmissionGateState {
    try {
      return deps.admissionState(storeId);
    } catch {
      return 'missing';
    }
  }

  function read(): ControlView {
    // The floor is read before the journal. A floor record is written only after its generation was linked, and the
    // epoch never falls along the chain, so a reduction that another window completes meanwhile cannot make this
    // read look behind the floor: only a lost generation does.
    let floor = readFloor(roots.floor, undefined, fs);
    const journal = readJournal(spec, journalFs);
    if (journal.kind === 'empty') {
      // A torn record is a reduction whose generation was linked first, so it also means a generation was lost.
      if (floor.known && (floor.floor > 0 || floor.torn.length > 0)) {
        return unusable('control-missing', `the floor records reductions (up to epoch ${floor.floor}), but no control generation can be read`);
      }
      if (!floor.known && floor.reason !== 'missing') return unusable('floor-unavailable', `no control generation exists, and ${floor.detail}`);
      if (instancesExist()) return unusable('control-missing', 'a store instance exists, but no control generation can be read');
      return { kind: 'fresh' };
    }
    if (journal.kind === 'corrupt') return unusable('control-unreadable', journal.detail, journal.newestValid && snapshotOf(journal.newestValid));
    if (journal.kind === 'newer-schema') return unusable('control-newer-schema', journal.detail);

    const snapshot = snapshotOf(journal);
    // A first generation can exist only after its floor was created, so a floor that was not there a moment ago
    // may have been created by another window meanwhile.
    if (!floor.known) floor = readFloor(roots.floor, undefined, fs);
    if (!floor.known) return unusable('floor-unavailable', floor.detail, snapshot);
    if (floor.controlId !== snapshot.record.controlId) return unusable('control-unreadable', 'the floor belongs to another control journal', snapshot);
    if (floor.floor === FLOOR_SEAL || snapshot.record.sealed === true) {
      return unusable('sealed', 'managed Codex has recorded the most changes its control can hold', snapshot);
    }
    return { kind: 'readable', authority: snapshot.record.reductionEpoch < floor.floor ? 'behind-floor' : 'ok', snapshot, floor: floor.floor };
  }

  async function publish(change: ControlChange): Promise<ControlPublishResult> {
    for (let round = 1; round <= CONTROL_PUBLISH_ROUNDS; round++) {
      const view = read();
      if (view.kind === 'unusable') return { outcome: 'unusable', view };
      if (view.kind === 'fresh') return { outcome: 'refused', reason: 'Managed Codex control is not set up yet.' };
      const { snapshot } = view;
      const current = snapshot.record;
      if (change.expected && (change.expected.generation !== snapshot.generation || change.expected.digest !== snapshot.digest)) {
        return { outcome: 'stale', snapshot };
      }
      if (change.kind !== 'increase' && change.kind !== 'reduction') return { outcome: 'refused', reason: `${change.label} names no kind of change.`, snapshot };
      // Present means blocked, whatever the file holds; reductions still go through.
      const suspended = readSuspension().present;
      if (change.kind === 'increase' && suspended) {
        return { outcome: 'refused', reason: 'Managed Codex is suspended, so nothing can give it more authority.', snapshot };
      }
      if (view.authority === 'behind-floor' && !(change.redecision === true && change.kind === 'reduction')) {
        return { outcome: 'refused', reason: 'A recent change to managed Codex could not be confirmed; only your new decision can be recorded.', snapshot };
      }
      // Only a gate seen closed is a Reset that has not been recorded yet. A gate that is missing or cannot be read is
      // a store to repair: it gains no authority, reductions such as Use external CLI go through, and no Reset completes.
      if (current.enrolledStoreId !== null) {
        const gate = gateOf(current.enrolledStoreId);
        if (gate === 'closed' && change.completesReset === undefined) {
          return { outcome: 'refused', reason: 'A Reset of managed Codex is pending; only completing it can be recorded.', snapshot };
        }
        if (gate === 'open' && change.completesReset !== undefined) {
          return { outcome: 'refused', reason: 'A Reset is recorded only after the instance stopped admitting starts.', snapshot };
        }
        if (gate === 'missing' && change.completesReset !== undefined) {
          return { outcome: 'refused', reason: 'The admission gate of managed Codex was not seen closed, so no Reset is pending.', snapshot };
        }
        if (gate === 'missing' && change.kind === 'increase') {
          return { outcome: 'refused', reason: 'The managed Codex store cannot be opened, so nothing can give it more authority until it is repaired or Reset.', snapshot };
        }
      }

      let decided: ReturnType<ControlChange['apply']>;
      try {
        decided = change.apply(structuredClone(current));
      } catch (error) {
        return { outcome: 'refused', reason: `${change.label} could not be decided (${errorCode(error)}).`, snapshot };
      }
      if (!decided || typeof decided !== 'object' || Array.isArray(decided)) return { outcome: 'refused', reason: `${change.label} gave no record.`, snapshot };
      if ('moot' in decided) return { outcome: 'moot', snapshot };
      if ('refused' in decided) return { outcome: 'refused', reason: decided.refused, snapshot };
      if (change.completesReset !== undefined && (change.kind !== 'reduction' || decided.enrolledStoreId !== null)) {
        return { outcome: 'refused', reason: 'Completing a Reset is a reduction that leaves no instance enrolled.', snapshot };
      }
      if (!isFields(decided.scheduler) || !Array.isArray(decided.activationConsents) || !Array.isArray(decided.disabled)) {
        return { outcome: 'refused', reason: `${change.label} gave no complete record.`, snapshot };
      }
      // The kind a caller names can only add protection: an increase that takes anything away is refused.
      const reductions = authorityReductions(current, decided);
      if (change.kind === 'increase' && reductions.length > 0) {
        return { outcome: 'refused', reason: `${change.label} changes ${reductions.join(', ')}, which only a reduction may change.`, snapshot };
      }
      const lowered = loweredEpoch(current, decided);
      if (lowered) return { outcome: 'refused', reason: `${change.label} would lower ${lowered}.`, snapshot };
      // While suspended, nothing may enrol an instance or select it, whatever kind of change carries it.
      if (suspended && ((decided.enrolledStoreId !== null && decided.enrolledStoreId !== current.enrolledStoreId)
        || (decided.selection === 'managed' && current.selection !== 'managed'))) {
        return { outcome: 'refused', reason: 'Managed Codex is suspended, so it cannot be set up or selected.', snapshot };
      }

      const reductionEpoch = change.kind === 'reduction' ? epochRule(current.reductionEpoch, view.floor) : current.reductionEpoch;
      const sealed = change.kind === 'reduction' ? reductionEpoch === FLOOR_SEAL : current.sealed === true;
      // The bytes the journal will store: undefined fields dropped, exactly as a later read parses them.
      const content = JSON.parse(canonicalJson({
        ...contentOf(decided),
        schema: CONTROL_SCHEMA,
        controlId: current.controlId,
        reductionEpoch,
        ...(sealed ? { sealed: true } : {}),
      })) as Omit<ControlRecord, 'generation' | 'previousRecordDigest'>;
      const checked = checkControlRecord({ ...content, generation: snapshot.generation + 1, previousRecordDigest: snapshot.digest });
      if (!checked.ok) return { outcome: 'refused', reason: `${change.label} would make an invalid control record: ${checked.detail}.`, snapshot };

      let won: ReturnType<typeof publishGeneration<ControlRecord>>;
      try {
        won = publishGeneration(spec, snapshot, content, journalFs, newId);
      } catch (error) {
        return { outcome: 'failed', step: 'generation', detail: `The control record could not be written (${errorCode(error)}).` };
      }
      if (won.outcome === 'lost') continue;
      const chain = chainHolds(won.entry);
      if (chain.chain === 'stale') {
        removeStale(won.entry.generation);
        continue;
      }
      if (chain.chain === 'unknown') {
        // It may be current, and then it must be protected before anything is reported; the record of its own epoch
        // only ever adds protection. The file stays, since it may be in the chain. The next round decides again on
        // what is current now, which already holds this change if the link counted.
        if (change.kind === 'reduction') {
          try {
            writeFloorEpoch(roots.floor, current.controlId, reductionEpoch, fs);
          } catch (error) {
            return { outcome: 'failed', step: 'floor', detail: `A change may have been recorded, but neither its place nor its protection could be confirmed (${chain.why}; ${errorCode(error)}).` };
          }
        }
        continue;
      }
      const next: ControlSnapshot = { generation: won.entry.generation, record: checked.record, digest: won.entry.digest };
      if (change.kind === 'reduction') {
        try {
          writeFloorEpoch(roots.floor, current.controlId, reductionEpoch, fs);
        } catch (error) {
          return { outcome: 'failed', step: 'floor', detail: `The change was recorded but its protection could not be written (${errorCode(error)}).`, snapshot: next };
        }
      }
      try { trimJournal(spec as JournalSpec<unknown>, next.generation, journalFs); } catch { /* best effort; a later writer trims */ }
      return { outcome: 'published', snapshot: next };
    }
    return { outcome: 'busy' };
  }

  async function initialize(): Promise<ControlPublishResult> {
    const deadline = Date.now() + INITIALIZE_WAIT_MS;
    let anotherCreator = false;
    for (let attempt = 1; attempt <= INITIALIZE_ATTEMPTS; attempt++) {
      const view = read();
      if (view.kind === 'readable') return { outcome: 'moot', snapshot: view.snapshot };
      if (view.kind === 'unusable') {
        // Another window's floor is a few milliseconds from complete; anything else stays as it reads.
        if (anotherCreator && view.reason === 'floor-unavailable' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        return { outcome: 'unusable', view };
      }
      for (const folder of [roots.control, roots.controlAuthority, roots.controlManifests]) {
        try {
          fs.mkdir(folder);
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') return { outcome: 'failed', step: 'folders', detail: `A control folder could not be created (${errorCode(error)}).` };
        }
      }
      const floor = readFloor(roots.floor, undefined, fs);
      let controlId: string;
      if (floor.known && floor.floor === 0 && floor.torn.length === 0) {
        controlId = floor.controlId;
      } else if (!floor.known && floor.reason === 'missing') {
        controlId = newId();
        try {
          createFloor(roots.floor, controlId, fs);
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') return { outcome: 'failed', step: 'floor', detail: `The control floor could not be created (${errorCode(error)}).` };
          anotherCreator = true;
          continue;
        }
      } else {
        // The floor changed since it read as fresh: decide again from what is there now.
        anotherCreator = true;
        continue;
      }
      const first: Omit<ControlRecord, 'generation' | 'previousRecordDigest'> = {
        schema: CONTROL_SCHEMA,
        controlId,
        reductionEpoch: 0,
        enrolledStoreId: null,
        selection: 'external',
        enrollment: null,
        scheduler: { epoch: 0, autoMode: false },
        activationConsents: [],
        active: null,
        lastKnownGood: null,
        disabled: [],
        retiredInstances: [],
        decidedAt: now().toISOString(),
      };
      let won: ReturnType<typeof publishGeneration<ControlRecord>>;
      try {
        won = publishGeneration(spec, null, first, journalFs, newId);
      } catch (error) {
        return { outcome: 'failed', step: 'generation', detail: `The first control record could not be written (${errorCode(error)}).` };
      }
      if (won.outcome === 'lost') continue;
      // A first generation that is not provably current is not reported; the next attempt reads what is.
      const chain = chainHolds(won.entry);
      if (chain.chain === 'stale') removeStale(won.entry.generation);
      if (chain.chain !== 'in-chain') continue;
      return { outcome: 'published', snapshot: { generation: won.entry.generation, record: { ...first, generation: 1, previousRecordDigest: null }, digest: won.entry.digest } };
    }
    return { outcome: 'busy' };
  }

  // ---- The shared suspension --------------------------------------------------------------------

  function readSuspension(): SuspensionView {
    const unreadable: SuspensionView = { present: true, readable: false };
    let stat: { isFile(): boolean; size: number };
    try {
      stat = fs.lstat(roots.suspension);
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { present: false } : unreadable;
    }
    if (!stat.isFile() || stat.size > SUSPENSION_MAX_BYTES) return unreadable;
    let bytes: Buffer;
    try {
      bytes = readSmallFile(roots.suspension);
    } catch (error) {
      // Gone since the first look: the user cleared it meanwhile. Every other failure keeps it present.
      return errorCode(error) === 'ENOENT' ? { present: false } : unreadable;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return unreadable;
    }
    const fields = shaped(value, 'the suspension', ['v', 'reason', 'controlState', 'decidedAt']);
    if (!fields.ok || fields.value.v !== 1) return unreadable;
    const { reason, controlState, decidedAt } = fields.value;
    if (typeof reason !== 'string' || typeof controlState !== 'string' || typeof decidedAt !== 'string') return unreadable;
    return { present: true, readable: true, reason, controlState, decidedAt };
  }

  function readSmallFile(file: string): Buffer {
    const fd = fs.open(file, 'r');
    try {
      const stat = fs.fstat(fd);
      if (!stat.isFile() || stat.size > SUSPENSION_MAX_BYTES) throw new Error('not a small file');
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.read(fd, bytes, read, bytes.length - read, read);
        if (count <= 0) throw new Error('the file ended early');
        read += count;
      }
      return bytes;
    } finally {
      fs.close(fd);
    }
  }

  async function suspend(reason: string, controlState: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    let body = Buffer.from(JSON.stringify({ v: 1, reason: shortText(reason), controlState: shortText(controlState), decidedAt: now().toISOString() }), 'utf8');
    if (body.length > SUSPENSION_MAX_BYTES) body = Buffer.from(JSON.stringify({ v: 1, reason: 'suspended', controlState: 'unknown', decidedAt: now().toISOString() }), 'utf8');
    let fd: number;
    let created = true;
    try {
      fd = fs.open(roots.suspension, 'wx');
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return { ok: false, detail: `Managed Codex could not be suspended (${errorCode(error)}).` };
      // Another window suspended managed Codex first. Its file is flushed here too before this window reports the
      // switch, since that window may not have flushed it yet.
      created = false;
      try {
        fd = fs.open(roots.suspension, 'r+');
      } catch (again) {
        return { ok: false, detail: `Managed Codex is suspended, but this could not be confirmed (${errorCode(again)}).` };
      }
    }
    let failure: string | undefined;
    try {
      // A folder or anything else there still blocks every start, but it is not a suspension a window wrote.
      if (!created && !fs.fstat(fd).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
      let written = 0;
      while (created && written < body.length) {
        const count = fs.write(fd, body, written, body.length - written, written);
        if (count <= 0) throw new Error('the file did not accept a write');
        written += count;
      }
      fs.fsync(fd);
    } catch (error) {
      failure = errorCode(error);
    }
    try {
      fs.close(fd);
    } catch (error) {
      failure ??= errorCode(error);
    }
    // The file that is left, partial or empty, still blocks every managed start; the switch is not reported.
    if (failure !== undefined) return { ok: false, detail: `Managed Codex could not be suspended durably (${failure}).` };
    return { ok: true };
  }

  async function clearSuspension(): Promise<{ ok: true } | { ok: false; detail: string }> {
    const view = read();
    if (view.kind !== 'readable' || view.authority !== 'ok') {
      return { ok: false, detail: 'The suspension can be lifted only while managed Codex control reads as valid.' };
    }
    try {
      fs.unlink(roots.suspension);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return { ok: false, detail: `The suspension could not be removed (${errorCode(error)}).` };
    }
    return { ok: true };
  }

  return { read, readSuspension, initialize, publish, suspend, clearSuspension };
}

/** One line of bounded, printable text. */
function shortText(text: string): string {
  return Array.from(String(text).replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, SUSPENSION_TEXT_MAX_CHARS).join('');
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}
