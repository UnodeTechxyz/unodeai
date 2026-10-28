/*---------------------------------------------------------------------------------------------
 *  UnodeAi - what control, the instance and the policy say about one managed Codex version (v0.9.97)
 *  Pure helpers for the click, the post-click check, Check again, Try again and the launch decision. Every condition
 *  that forbids a launch is read from control (or is the closure check at the start); a fact in the instance can only
 *  permit one, and only together with control. So losing an instance fact can never let anything run.
 *--------------------------------------------------------------------------------------------*/

import { closureDigest, closureListing } from '../../../backend/cliClosure';
import { cliStoreVersionKey, type PolicyEntry, type PolicyLayout, type ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import { canonicalJson } from '../storeLayout';
import type {
  ActivationConsent,
  ControlContent,
  ControlRecord,
  DisabledEntry,
  InstanceContent,
  InstanceRecord,
  ManagedVersionRef,
  StoreId,
  VersionKey,
} from '../contracts';

/** The operating system and architecture UnodeAi runs on; policy entries exist for Windows x64 only. */
export interface ManagedHost {
  readonly os: string;
  readonly arch: string;
}

/** A user-readable reason is kept to this many characters wherever it is recorded. */
export const DETAIL_MAX_CHARS = 300;

export function boundedDetail(text: string): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim();
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS - 1)}…` : flat;
}

export type KeyPolicy =
  /** One qualified entry for this host describes the key; `closureDigest` is the digest of its layout's listing. */
  | { kind: 'qualified'; entry: PolicyEntry; layout: PolicyLayout; closureDigest: string }
  /** An entry for the key is `bad` or `revoked`: it wins over any qualified one. */
  | { kind: 'bad'; entry: PolicyEntry; reason: string }
  | { kind: 'none'; detail: string };

/**
 * The bundled policy's word on a version key on this host. A bad or revoked entry for the key wins; otherwise
 * exactly one qualified Codex entry for this OS and architecture must describe it. No entry, or two, is `none`.
 */
export function policyForKey(policy: ValidatedCliCompatibilityPolicy, key: VersionKey, host: ManagedHost): KeyPolicy {
  const entries = policy.entries.filter((entry) => entry.provider === 'codex-cli' && entry.managed && cliStoreVersionKey(entry) === key);
  const bad = entries.find((entry) => entry.status !== 'qualified');
  if (bad) return { kind: 'bad', entry: bad, reason: bad.statusReason ?? bad.status };
  const qualified = entries.filter((entry) => entry.os === host.os && entry.arch === host.arch);
  if (qualified.length === 0) return { kind: 'none', detail: 'This UnodeAi has no qualified entry for this version on this computer.' };
  if (qualified.length > 1) return { kind: 'none', detail: 'This UnodeAi has more than one entry for this version.' };
  const entry = qualified[0];
  const layout = (entry.managed as NonNullable<PolicyEntry['managed']>).layout;
  return { kind: 'qualified', entry, layout, closureDigest: layoutClosureDigest(layout) };
}

/** The closure digest of a policy layout's files: what a version folder that equals them hashes to. */
export function layoutClosureDigest(layout: Pick<PolicyLayout, 'files'>): string {
  return closureDigest(closureListing(layout.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))));
}

/** The version a key names: `<version>-<os>-<arch>-<16 hex digits>`. Undefined for anything else. */
export function keyVersion(key: VersionKey): string | undefined {
  return /^(.+)-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{16}$/.exec(key)?.[1];
}

export function sameVersion(a: ManagedVersionRef | null | undefined, b: ManagedVersionRef | null | undefined): boolean {
  return !!a && !!b && a.storeId === b.storeId && a.key === b.key;
}

/** Every `disabled` entry naming this version of this instance. */
export function disabledFor(record: Pick<ControlRecord, 'disabled'>, storeId: StoreId, key: VersionKey): DisabledEntry[] {
  return record.disabled.filter((entry) => entry.storeId === storeId && entry.key === key);
}

/** The same recorded entry: every field equal. */
export function sameDisabledEntry(a: DisabledEntry, b: DisabledEntry): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Whether the user's click covers exactly this closure of this version of this instance. */
export function hasConsent(record: Pick<ControlRecord, 'activationConsents'>, storeId: StoreId, key: VersionKey, digest: string): boolean {
  return record.activationConsents.some((consent: ActivationConsent) => consent.storeId === storeId && consent.key === key && consent.closureDigest === digest);
}

/** The fields a control change sets, copied from a record. */
export function controlContent(record: ControlRecord): ControlContent {
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

/** The fields an instance change sets, copied from a record. */
export function instanceContent(record: InstanceRecord): InstanceContent {
  return { versions: record.versions, probes: record.probes, stagingIntents: record.stagingIntents, schedule: record.schedule };
}

/** The host names of an entry's download URLs, in their order, each once. */
export function urlHosts(entry: PolicyEntry): string[] {
  const hosts = new Set<string>();
  for (const url of entry.managed?.artifact.urls ?? []) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // The validator refuses such an entry; an unparsable URL can name no host the user consented to.
      hosts.add(url);
    }
  }
  return [...hosts];
}

/** The host names a download of this entry may reach: its URLs' hosts and its redirect hosts. */
export function entryHosts(entry: PolicyEntry): string[] {
  return [...new Set([...urlHosts(entry), ...(entry.managed?.artifact.redirectHosts ?? []).map((host) => host.toLowerCase())])];
}

/**
 * Whether an entry is installable under this control record: qualified, managed, for this host, and every host its
 * download may reach is one the user consented to. The caller has read control as `ok`.
 */
export function isInstallable(entry: PolicyEntry, host: ManagedHost, record: Pick<ControlRecord, 'enrollment'>): boolean {
  if (entry.status !== 'qualified' || !entry.managed || entry.os !== host.os || entry.arch !== host.arch) return false;
  const consented = new Set(record.enrollment?.consentedHosts ?? []);
  return entryHosts(entry).every((name) => consented.has(name));
}

export type VersionLaunchability =
  | { ok: true; closureDigest: string; version: string; entry: PolicyEntry }
  | { ok: false; why: string; disabled?: DisabledEntry; policyBad?: string };

/**
 * Whether one version of the enrolled instance may start a new session in the given role, from the records alone
 * (the closure check at the start is the launcher's): the policy qualifies it on this host (a last-known-good must
 * also still be installable); its facts are in the instance; the user's click covers its closure; no `disabled`
 * entry names it; and a probe passed on that closure.
 */
export function versionLaunchability(
  version: ManagedVersionRef,
  role: 'active' | 'last-known-good',
  record: ControlRecord,
  instance: InstanceRecord,
  policy: ValidatedCliCompatibilityPolicy,
  host: ManagedHost,
): VersionLaunchability {
  if (version.storeId !== record.enrolledStoreId || instance.storeId !== version.storeId) {
    return { ok: false, why: 'it belongs to another managed Codex setup' };
  }
  const disabled = disabledFor(record, version.storeId, version.key);
  if (disabled.length > 0) return { ok: false, why: disabledText(disabled[0]), disabled: disabled[0] };
  const keyPolicy = policyForKey(policy, version.key, host);
  if (keyPolicy.kind === 'bad') return { ok: false, why: `this UnodeAi marks it not to be used (${boundedDetail(keyPolicy.reason)})`, policyBad: keyPolicy.reason };
  if (keyPolicy.kind === 'none') return { ok: false, why: keyPolicy.detail };
  if (role === 'last-known-good' && !isInstallable(keyPolicy.entry, host, record)) {
    return { ok: false, why: 'it could not be downloaded again from the hosts you allowed' };
  }
  const facts = instance.versions[version.key];
  if (!facts || facts.artifactSha256 !== keyPolicy.entry.managed?.artifact.sha256) return { ok: false, why: 'it is not recorded as downloaded and checked' };
  if (!hasConsent(record, version.storeId, version.key, keyPolicy.closureDigest)) return { ok: false, why: 'you have not allowed it to run' };
  const probe = instance.probes[version.key];
  if (!probe || probe.closureDigest !== keyPolicy.closureDigest) return { ok: false, why: 'its check has not passed' };
  return { ok: true, closureDigest: keyPolicy.closureDigest, version: keyPolicy.entry.version, entry: keyPolicy.entry };
}

/** Why a `disabled` entry stops a version, in words. */
export function disabledText(entry: DisabledEntry): string {
  const detail = entry.detail ? `: ${boundedDetail(entry.detail)}` : '';
  switch (entry.reason) {
    case 'local-bad': return `UnodeAi marked it bad on this computer${detail}`;
    case 'probe-failed': return `its check failed${detail}`;
    case 'probe-stop-unconfirmed': return `UnodeAi could not confirm that its check's process stopped${detail}`;
    case 'policy-bad': return `this UnodeAi marks it not to be used${detail}`;
    case 'consent-withdrawn': return 'you withdrew your OK for it';
  }
}
