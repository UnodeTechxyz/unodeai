/*---------------------------------------------------------------------------------------------
 *  UnodeAi - what the managed Codex card says, from the records alone (v0.9.97)
 *  A pure function of the suspension, control, the enrolled instance, the bundled policy and this window's own task:
 *  every version, host, count and time on the card comes from those inputs, and each state offers only the actions
 *  that can act in it. The card never says that Codex was "updated": UnodeAi downloads and checks versions, and each
 *  new one runs only after the user's OK.
 *--------------------------------------------------------------------------------------------*/

import type { ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import { compareCliVersions } from '../../../backend/cliRuntime';
import type {
  ControlRecord,
  ControlUnusableReason,
  ControlView,
  DisabledEntry,
  InstanceRecord,
  InstanceView,
  ScheduleFailureClass,
  SuspensionView,
  VersionKey,
} from '../contracts';
import { clickOffer } from './activation';
import { BYPASSABLE_REASONS } from './admission';
import { boundedDetail, disabledFor, hasConsent, keyVersion, policyForKey, sameVersion, type ManagedHost } from './keyFacts';
import { launchableKey } from './policyReconcile';

/** This window's own task, or one another window runs, as the updater reports it. */
export type CardTask =
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; host: string; percent: number }
  | { phase: 'verifying'; version: string }
  | { phase: 'qualifying'; version: string }
  | { phase: 'elsewhere'; since: string }
  | { phase: 'cancelled'; version: string }
  | { phase: 'failed'; version: string; failureClass: ScheduleFailureClass; detail: string; retryAt?: string };

export interface CardInput {
  readonly host: ManagedHost;
  readonly suspension: SuspensionView;
  readonly control: ControlView;
  /** The enrolled instance's records; undefined when it could not be opened (`instanceProblem` says why). */
  readonly instance?: InstanceView;
  readonly instanceProblem?: string;
  readonly policy: ValidatedCliCompatibilityPolicy;
  readonly task?: CardTask;
  /** A time from the records, as the card shows it (for example 14:10). */
  readonly formatTime: (iso: string) => string;
}

export type CardActionId =
  | 'use-managed-again' | 'use-external-suspend' | 'use-external' | 'use-managed' | 'review-settings' | 'details'
  | 'review' | 'check-again' | 'try-again' | 'repair-store' | 'update-now' | 'set-up' | 'use-for-new-sessions' | 'reset';

export interface CardAction {
  readonly id: CardActionId;
  readonly label: string;
  readonly key?: VersionKey;
}

export type CardStateName =
  | 'unsupported' | 'suspended' | 'not-enrolled' | 'control-unusable' | 'behind-floor' | 'store-unavailable'
  | 'external-selected' | 'checking' | 'available' | 'downloading' | 'verifying' | 'qualifying' | 'elsewhere'
  | 'cancelled' | 'failed' | 'store-full' | 'stop-unconfirmed' | 'verified' | 'local-bad' | 'probe-failed' | 'bad'
  | 'consent-withdrawn' | 'allowed' | 'ready' | 'active' | 'blocked' | 'no-version';

export interface ManagedCodexCard {
  readonly state: CardStateName;
  readonly lines: readonly string[];
  readonly actions: readonly CardAction[];
}

const LABELS: Readonly<Record<CardActionId, string>> = Object.freeze({
  'use-managed-again': 'Use managed Codex again',
  'use-external-suspend': 'Use external CLI',
  'use-external': 'Use external CLI',
  'use-managed': 'Use managed Codex',
  'review-settings': 'Review managed Codex settings…',
  details: 'Details',
  review: 'Review',
  'check-again': 'Check again',
  'try-again': 'Try again',
  'repair-store': 'Repair managed Codex store…',
  'update-now': 'Update now',
  'set-up': 'Set up managed Codex…',
  'use-for-new-sessions': 'Use for new sessions',
  reset: 'Reset managed Codex…',
});

const action = (id: CardActionId, key?: VersionKey): CardAction => (key ? { id, label: LABELS[id], key } : { id, label: LABELS[id] });

const UNUSABLE_TEXT: Readonly<Record<ControlUnusableReason, (detail: string) => string>> = Object.freeze({
  'control-missing': () => 'UnodeAi cannot find the record of your managed Codex choices, although managed Codex files exist. Managed Codex is paused.',
  'control-unreadable': (detail: string) => `UnodeAi cannot read the record of your managed Codex choices (${detail}). Managed Codex is paused.`,
  'control-newer-schema': () => 'A newer UnodeAi wrote the record of your managed Codex choices. Managed Codex is paused in this UnodeAi.',
  'floor-unavailable': (detail: string) => `UnodeAi cannot read the record that protects your changes to managed Codex (${detail}). Managed Codex is paused.`,
  sealed: () => 'Managed Codex has recorded the most changes it can hold, so it is paused.',
});

const FAILURE_TEXT: Readonly<Record<ScheduleFailureClass, string>> = Object.freeze({
  network: 'the network connection failed',
  timeout: 'it took too long',
  'signature-unavailable': 'the publisher signature check was not available',
  integrity: 'the downloaded files did not match UnodeAi\'s record',
  signature: 'a publisher signature did not pass the check',
  'host-not-allowed': 'it needs a download host you have not allowed',
  'store-full': 'the managed Codex store is full',
  file: 'a file could not be written',
});

const RUNNING_KEEP = 'Running agents keep their version until restarted.';

interface Row { priority: number; state: CardStateName; line: string; actions: CardAction[] }

/** The card for the current records. */
export function managedCodexCard(input: CardInput): ManagedCodexCard {
  const { host, suspension, control, policy } = input;
  if (host.os !== 'win32' || host.arch !== 'x64') {
    return { state: 'unsupported', lines: ['Managed Codex is available on Windows x64 only.'], actions: [] };
  }
  const controlOk = control.kind === 'readable' && control.authority === 'ok';
  if (suspension.present) {
    const lines = ['Managed Codex is paused in every window. New sessions use the external Codex CLI.'];
    if (!suspension.readable) lines.push('The record of this pause cannot be read; managed Codex stays paused.');
    else if (suspension.reason) lines.push(`Reason recorded: ${boundedDetail(suspension.reason)}.`);
    return { state: 'suspended', lines, actions: [...(controlOk ? [action('use-managed-again')] : []), action('details')] };
  }
  if (control.kind === 'fresh') return notEnrolled();
  if (control.kind === 'unusable') {
    return { state: 'control-unusable', lines: [UNUSABLE_TEXT[control.reason](boundedDetail(control.detail))], actions: [action('use-external-suspend'), action('details')] };
  }
  if (control.authority === 'behind-floor') {
    return {
      state: 'behind-floor',
      lines: ['UnodeAi could not confirm your last change to managed Codex after an unexpected shutdown. New managed Codex sessions are paused until you choose.'],
      actions: [action('review-settings'), action('use-external'), action('details')],
    };
  }
  const record = control.snapshot.record;
  if (!record.enrolledStoreId) return notEnrolled();
  const instance = input.instance;
  if (!instance || instance.kind !== 'readable') {
    const reason = instance?.kind === 'unusable' ? instance.reason : 'missing';
    const detail = boundedDetail(instance?.kind === 'unusable' ? instance.detail : input.instanceProblem ?? 'it could not be opened');
    const line = reason === 'store-corrupt'
      ? `UnodeAi cannot read the managed Codex store's record of downloaded versions (${detail}). No managed Codex version starts until it is repaired.`
      : reason === 'store-newer-schema'
        ? 'A newer UnodeAi wrote the managed Codex store\'s record of downloaded versions. This UnodeAi does not change it, and no managed Codex version starts.'
        : `UnodeAi cannot open the managed Codex store folder (${detail}). No managed Codex version starts.`;
    // Reset closes the instance's gate first; an instance that cannot be opened offers none, since no window's failed
    // open proves that no other window starts from it.
    const actions = [
      ...(reason === 'store-corrupt' ? [action('repair-store')] : []),
      ...(record.selection === 'managed' ? [action('use-external')] : []),
      ...(instance ? [action('reset')] : []),
      action('details'),
    ];
    return { state: 'store-unavailable', lines: [line], actions };
  }
  const facts = instance.snapshot.record;
  const keys = versionKeys(record, facts);
  const name = (key: VersionKey) => versionName(policy, host, facts, key);

  if (record.selection !== 'managed') {
    const lines = ['Managed Codex is set up but not used for new sessions. New sessions use the external Codex CLI.'];
    for (const key of keys) {
      const offer = clickOffer({ suspension, control, instance, policy, host, key });
      if (!offer.offered && offer.reason === 'later') lines.push(offer.detail);
    }
    return { state: 'external-selected', lines, actions: [action('use-managed')] };
  }

  const rows: Row[] = [];
  const task = input.task;
  if (task) rows.push(taskRow(task, input.formatTime));

  const failure = facts.schedule.failure;
  if (failure && !(task && task.phase === 'failed')) {
    const entry = policy.entries.find((candidate) => candidate.id === failure.entryId);
    rows.push(failureRow(entry?.version ?? failure.entryId, failure.class, failure.detail, failure.retryAt, input.formatTime));
  }

  for (const key of keys) {
    const disabled = disabledFor(record, facts.storeId, key);
    if (disabled.length > 0) {
      rows.push(disabledRow(disabled, key, name(key)));
      continue;
    }
    const offer = clickOffer({ suspension, control, instance, policy, host, key });
    if (offer.offered) {
      rows.push({ priority: 40, state: 'verified', line: `${offer.version} is downloaded and checked. It runs only after your OK.`, actions: [action('review', key)] });
      continue;
    }
    const keyPolicy = policyForKey(policy, key, host);
    if (keyPolicy.kind === 'qualified' && hasConsent(record, facts.storeId, key, keyPolicy.closureDigest) && facts.versions[key]
      && facts.probes[key]?.closureDigest !== keyPolicy.closureDigest) {
      rows.push({ priority: 60, state: 'allowed', line: `${name(key)} is allowed, and UnodeAi checks it again before new sessions use it.`, actions: [] });
    }
  }

  const launch = launchableKey({ suspension, control, instance, policy, host });
  if (launch.launchable) {
    rows.push({ priority: 70, state: 'active', line: `New sessions use ${launch.versionName}. ${RUNNING_KEEP}`, actions: [] });
    if (launch.role === 'last-known-good' && record.active) {
      rows.push({ priority: 71, state: 'active', line: `${name(record.active.key)} is not used: ${launch.activeProblem ?? 'it cannot start'}.`, actions: [] });
    }
    // A checked and allowed version newer than the one in use, which an earlier activation did not reach.
    for (const key of keys) {
      const version = { storeId: facts.storeId, key };
      if (sameVersion(version, launch.version) || sameVersion(version, record.active)) continue;
      const order = compareCliVersions(keyVersion(key) ?? '', keyVersion(launch.version.key) ?? '');
      if (order === undefined || order <= 0) continue;
      if (readyVersion(record, facts, policy, host, key)) {
        rows.push({ priority: 65, state: 'ready', line: `${name(key)} is checked and allowed.`, actions: [action('use-for-new-sessions', key)] });
      }
    }
  } else if (Object.keys(facts.versions).length === 0 && !record.active) {
    rows.push({ priority: 80, state: 'no-version', line: 'No managed Codex version is downloaded yet.', actions: [action('update-now')] });
  } else {
    rows.push({ priority: 75, state: 'blocked', line: `No managed Codex version can start for new sessions: ${launch.activeProblem ?? launch.reason}.`, actions: [action('update-now'), action('use-external')] });
  }

  rows.sort((a, b) => a.priority - b.priority);
  const actions: CardAction[] = [];
  for (const row of rows) {
    for (const item of row.actions) {
      if (!actions.some((existing) => existing.id === item.id && existing.key === item.key)) actions.push(item);
    }
  }
  // v0.9.97: while managed Codex is selected, Use external CLI is always offered. It is a reduction that keeps the
  // store, its versions and approvals, so it needs no healthy state; before, only a blocked card offered it and the
  // one way back from a working managed Codex was Reset.
  if (!actions.some((existing) => existing.id === 'use-external')) actions.push(action('use-external'));
  return { state: rows[0].state, lines: rows.map((row) => row.line), actions };
}

function notEnrolled(): ManagedCodexCard {
  return { state: 'not-enrolled', lines: ['Managed Codex is not set up. New sessions use the external Codex CLI.'], actions: [action('set-up')] };
}

/** The versions the card speaks about: those the instance holds facts for and those control names, newest first. */
function versionKeys(record: ControlRecord, facts: InstanceRecord): VersionKey[] {
  const keys = new Set<VersionKey>(Object.keys(facts.versions));
  for (const version of [record.active, record.lastKnownGood, ...record.activationConsents, ...record.disabled]) {
    if (version && version.storeId === facts.storeId) keys.add(version.key);
  }
  return [...keys].sort((a, b) => (compareCliVersions(keyVersion(b) ?? '', keyVersion(a) ?? '') ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
}

function versionName(policy: ValidatedCliCompatibilityPolicy, host: ManagedHost, facts: InstanceRecord, key: VersionKey): string {
  const keyPolicy = policyForKey(policy, key, host);
  if (keyPolicy.kind !== 'none') return keyPolicy.entry.version;
  return facts.versions[key]?.version ?? keyVersion(key) ?? key;
}

function readyVersion(record: ControlRecord, facts: InstanceRecord, policy: ValidatedCliCompatibilityPolicy, host: ManagedHost, key: VersionKey): boolean {
  const keyPolicy = policyForKey(policy, key, host);
  return keyPolicy.kind === 'qualified' && !!facts.versions[key] && disabledFor(record, facts.storeId, key).length === 0
    && hasConsent(record, facts.storeId, key, keyPolicy.closureDigest) && facts.probes[key]?.closureDigest === keyPolicy.closureDigest;
}

function taskRow(task: CardTask, formatTime: (iso: string) => string): Row {
  switch (task.phase) {
    case 'checking': return { priority: 10, state: 'checking', line: 'Looking for a supported version', actions: [] };
    case 'available': return { priority: 90, state: 'available', line: `${task.version} is supported by this UnodeAi and not downloaded`, actions: [action('update-now')] };
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.floor(Number.isFinite(task.percent) ? task.percent : 0)));
      return { priority: 10, state: 'downloading', line: `Downloading ${task.version} from ${task.host} — ${percent} %`, actions: [] };
    }
    case 'verifying': return { priority: 10, state: 'verifying', line: 'Checking file hashes and publisher signatures', actions: [] };
    case 'qualifying': return { priority: 10, state: 'qualifying', line: 'Starting it once in UnodeAi\'s folder to check it (no model request)', actions: [] };
    case 'elsewhere': return { priority: 10, state: 'elsewhere', line: `In progress in another window since ${formatTime(task.since)}`, actions: [] };
    case 'cancelled': return { priority: 15, state: 'cancelled', line: `The download of ${task.version} was cancelled.`, actions: [action('update-now')] };
    case 'failed': return failureRow(task.version, task.failureClass, task.detail, task.retryAt, formatTime);
  }
}

function failureRow(version: string, failureClass: ScheduleFailureClass, detail: string, retryAt: string | undefined, formatTime: (iso: string) => string): Row {
  const next = retryAt ? `Next try at ${formatTime(retryAt)}.` : 'Not retried automatically.';
  if (failureClass === 'store-full') {
    return { priority: 30, state: 'store-full', line: `The managed Codex store is full, so ${version} was not downloaded (${boundedDetail(detail)}). ${next}`, actions: [] };
  }
  return { priority: 30, state: 'failed', line: `Downloading ${version} failed: ${FAILURE_TEXT[failureClass]} (${boundedDetail(detail)}). ${next}`, actions: [action('update-now')] };
}

function disabledRow(entries: DisabledEntry[], key: VersionKey, version: string): Row {
  const only = entries.length === 1 ? entries[0] : undefined;
  const find = (reason: DisabledEntry['reason']) => entries.find((entry) => entry.reason === reason);
  const detail = (entry: DisabledEntry) => (entry.detail ? ` (${boundedDetail(entry.detail)})` : '');
  const unconfirmed = find('probe-stop-unconfirmed');
  if (unconfirmed) {
    const canCheck = !!only && BYPASSABLE_REASONS.checkAgain.includes(only.reason);
    return {
      priority: 20,
      state: 'stop-unconfirmed',
      line: `UnodeAi could not confirm that the check's process of ${version} stopped${detail(unconfirmed)}.`,
      actions: canCheck ? [action('check-again', key)] : [],
    };
  }
  const policyBad = find('policy-bad');
  if (policyBad) return { priority: 50, state: 'bad', line: `This UnodeAi marks ${version} as not to be used${detail(policyBad)}.`, actions: [] };
  const withdrawn = find('consent-withdrawn');
  if (withdrawn) return { priority: 55, state: 'consent-withdrawn', line: `You withdrew your OK for ${version}.`, actions: [] };
  const localBad = find('local-bad');
  const probeFailed = find('probe-failed');
  const repairable = !!only && BYPASSABLE_REASONS.tryAgain.includes(only.reason);
  if (localBad) {
    return { priority: 45, state: 'local-bad', line: `UnodeAi marked ${version} bad on this computer${detail(localBad)}.`, actions: repairable ? [action('try-again', key)] : [] };
  }
  const failed = probeFailed as DisabledEntry;
  return { priority: 45, state: 'probe-failed', line: `${version} did not pass UnodeAi's check${detail(failed)}.`, actions: repairable ? [action('try-again', key)] : [] };
}
