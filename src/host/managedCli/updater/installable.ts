/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which policy entries the managed Codex updater may download (v0.9.97)
 *  An entry is installable when it is a qualified Codex entry for this computer's Windows x64, at or above the Codex
 *  version floor and not a prerelease, whose every download host (its URLs and the hosts it may be redirected to)
 *  the user consented to at enrolment, while control is readable with authority `ok` and managed Codex is not
 *  suspended. An entry that names a host outside the consent is not installable: it needs a new consent first.
 *
 *  The target is the newest installable entry above the active version. "Checking" is this local lookup only: a
 *  remote "latest" chooses nothing. A version already promoted in the instance waits for the user's click and is not
 *  downloaded again, and a version control has disabled for this instance is never chosen (the user's explicit Try
 *  again is a separate action). Pure: no file system, no network, no clock.
 *--------------------------------------------------------------------------------------------*/

import { compareCliVersions } from '../../../backend/cliRuntime';
import {
  CODEX_POLICY_VERSION_FLOOR,
  cliStoreVersionKey,
  type PolicyEntry,
  type ValidatedCliCompatibilityPolicy,
} from '../../../backend/cliCompatibilityPolicy';
import type { ControlRecord, ControlView, InstanceView, StoreId, SuspensionView, VersionKey } from '../contracts';
import { CODEX_WINDOWS_ENTRYPOINT } from './codexWindows';

/** The computer the updater runs on. Managed Codex exists on Windows x64 only. */
export interface UpdaterHost {
  os: string;
  arch: string;
}

/** What the caller read, both in one place: an entry is installable only under authority `ok` and no suspension. */
export interface UpdaterAuthority {
  control: ControlView;
  suspension: SuspensionView;
}

/** Why no entry is installable, when the reason is the computer or the authority rather than the entries. */
export type InstallableRefusal = 'unsupported-host' | 'suspended' | 'control-unusable' | 'behind-floor' | 'not-enrolled';

export interface InstallableEntries {
  /** The entries a task may download now, newest first. */
  installable: PolicyEntry[];
  /** Entries that would be installable but name a host the enrolment did not consent to, newest first. */
  needsHostConsent: Array<{ entry: PolicyEntry; hosts: string[] }>;
  refused?: InstallableRefusal;
}

const RELEASE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** Revision 5 §3.3 (B4): Codex at or above 0.155.0 and not a prerelease, as an extra minimum to the policy's own. */
export function meetsCodexVersionFloor(version: string): boolean {
  if (!RELEASE_VERSION.test(version)) return false;
  const order = compareCliVersions(version, CODEX_POLICY_VERSION_FLOOR);
  return order !== undefined && order >= 0;
}

/** Every host an entry's download may reach: its URLs' hosts and its redirect hosts, lower case, each once. */
export function entryDownloadHosts(entry: PolicyEntry): string[] {
  const artifact = entry.managed?.artifact;
  if (!artifact) return [];
  const hosts = new Set<string>();
  for (const url of artifact.urls) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // An entry URL that does not parse cannot name a consented host; it is refused below.
      hosts.add(`(not a URL: ${url.slice(0, 80)})`);
    }
  }
  for (const host of artifact.redirectHosts) hosts.add(host.toLowerCase());
  return [...hosts];
}

/** Newest first; entries of one version keep a fixed order by id. */
function newestFirst(a: PolicyEntry, b: PolicyEntry): number {
  const order = compareCliVersions(b.version, a.version);
  if (order !== undefined && order !== 0) return order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether the entry describes a managed Codex download for this host, whatever the consent says. */
function downloadableHere(entry: PolicyEntry, host: UpdaterHost): boolean {
  return entry.provider === 'codex-cli'
    && entry.status === 'qualified'
    && entry.managed !== undefined
    && entry.os === host.os
    && entry.arch === host.arch
    && meetsCodexVersionFloor(entry.version)
    // ADAPTER §6.1.3: the launcher starts `bin/codex.exe` and nothing else.
    && entry.managed.layout.entrypoint === CODEX_WINDOWS_ENTRYPOINT;
}

/**
 * Revision 5 §9.1 "installable" and ADAPTER §5.1.4: the entries a download task may fetch now. Selection does not
 * matter: choosing External keeps downloads going (Revision 5 §7.3), and nothing managed runs unless it is managed.
 */
export function installableEntries(
  policy: ValidatedCliCompatibilityPolicy,
  host: UpdaterHost,
  authority: UpdaterAuthority,
): InstallableEntries {
  const none = (refused: InstallableRefusal): InstallableEntries => ({ installable: [], needsHostConsent: [], refused });
  if (host.os !== 'win32' || host.arch !== 'x64') return none('unsupported-host');
  // Present means blocked, whatever the file holds and also when it cannot be read.
  if (authority.suspension.present !== false) return none('suspended');
  const view = authority.control;
  if (view.kind === 'fresh') return none('not-enrolled');
  if (view.kind !== 'readable') return none('control-unusable');
  if (view.authority !== 'ok') return none('behind-floor');
  const record = view.snapshot.record;
  if (record.enrolledStoreId === null || record.enrollment === null) return none('not-enrolled');

  const consented = new Set(record.enrollment.consentedHosts.map((consentedHost) => consentedHost.toLowerCase()));
  const installable: PolicyEntry[] = [];
  const needsHostConsent: Array<{ entry: PolicyEntry; hosts: string[] }> = [];
  for (const entry of policy.entries) {
    if (!downloadableHere(entry, host)) continue;
    const outside = entryDownloadHosts(entry).filter((entryHost) => !consented.has(entryHost));
    if (outside.length === 0) installable.push(entry);
    else needsHostConsent.push({ entry, hosts: outside });
  }
  installable.sort(newestFirst);
  needsHostConsent.sort((a, b) => newestFirst(a.entry, b.entry));
  return { installable, needsHostConsent };
}

export type DownloadTarget =
  | { kind: 'target'; entry: PolicyEntry; key: VersionKey }
  | {
    kind: 'none';
    /**
     * - `not-enrolled`: control names no instance.
     * - `instance-unusable`: the instance's record cannot be read, so what is promoted is not known.
     * - `active-version-unknown`: control names an active key whose version cannot be read from it.
     * - `nothing-newer`: no installable entry is above the active version.
     * - `already-promoted`: the newest candidate is downloaded and checked, and waits for the user's click.
     * - `disabled`: every candidate is disabled for this instance; only the user's Try again may download it.
     */
    reason: 'not-enrolled' | 'instance-unusable' | 'active-version-unknown' | 'nothing-newer' | 'already-promoted' | 'disabled';
    entry?: PolicyEntry;
    key?: VersionKey;
  };

const KEY_PATTERN = /^(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?)-win32-x64-[0-9a-f]{16}$/;

/** The version a version key names (`<version>-win32-x64-<16 hex digits>`), or undefined. */
export function versionOfKey(key: VersionKey): string | undefined {
  return KEY_PATTERN.exec(key)?.[1];
}

/** Whether control disables this key of this instance. Entries naming another instance are inert. */
export function keyDisabled(record: Pick<ControlRecord, 'disabled'>, storeId: StoreId, key: VersionKey): boolean {
  return record.disabled.some((entry) => entry.storeId === storeId && entry.key === key);
}

/**
 * Revision 5 §9.1: the newest installable entry above the active version. `entries` are installable entries (any
 * order). A key already promoted with the same artifact digest is not downloaded again; a key control disables for
 * this instance is skipped, and an older candidate above the active version may then be chosen.
 */
export function downloadTarget(entries: readonly PolicyEntry[], control: ControlRecord, instance: InstanceView): DownloadTarget {
  const storeId = control.enrolledStoreId;
  if (storeId === null || control.enrollment === null) return { kind: 'none', reason: 'not-enrolled' };
  if (instance.kind !== 'readable' || instance.snapshot.record.storeId !== storeId) return { kind: 'none', reason: 'instance-unusable' };
  const promoted = instance.snapshot.record.versions;

  let activeVersion: string | undefined;
  const active = control.active && control.active.storeId === storeId ? control.active : null;
  if (active) {
    const fact = Object.hasOwn(promoted, active.key) ? promoted[active.key] : undefined;
    activeVersion = fact?.key === active.key ? fact.version : versionOfKey(active.key);
    if (activeVersion === undefined) return { kind: 'none', reason: 'active-version-unknown', key: active.key };
  }

  const candidates = entries
    .filter((entry) => entry.managed !== undefined)
    .filter((entry) => activeVersion === undefined || (compareCliVersions(entry.version, activeVersion) ?? 0) > 0)
    .sort(newestFirst);
  let disabledNewest: { entry: PolicyEntry; key: VersionKey } | undefined;
  for (const entry of candidates) {
    const key = cliStoreVersionKey(entry);
    if (keyDisabled(control, storeId, key)) {
      disabledNewest ??= { entry, key };
      continue;
    }
    const fact = Object.hasOwn(promoted, key) ? promoted[key] : undefined;
    if (fact && fact.artifactSha256 === entry.managed?.artifact.sha256) return { kind: 'none', reason: 'already-promoted', entry, key };
    return { kind: 'target', entry, key };
  }
  if (disabledNewest) return { kind: 'none', reason: 'disabled', ...disabledNewest };
  return { kind: 'none', reason: 'nothing-newer' };
}
