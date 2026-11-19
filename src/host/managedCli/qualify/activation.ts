/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the user's OK for one downloaded Codex version (v0.9.97)
 *  A downloaded version runs for the first time only after the user allows it, whether or not every file is signed.
 *  The dialog says what was checked, from that version's own download record and its policy entry only, and names
 *  every file that carries no publisher signature. The OK is recorded in control for exactly that version's files,
 *  visible to every window; "Not now" records nothing and the version stays downloaded and checked.
 *
 *  The OK is asked only while managed Codex is selected for new sessions: while the external CLI is selected, the
 *  card says the version is ready to review once managed Codex is selected again.
 *--------------------------------------------------------------------------------------------*/

import { cliStoreVersionKey, type PolicyEntry, type ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import { compareCliVersions } from '../../../backend/cliRuntime';
import type {
  ControlPublishResult,
  ControlStoreApi,
  ControlView,
  DisabledEntry,
  InstanceRef,
  InstanceView,
  PromotedVersion,
  StoreId,
  SuspensionView,
  VersionKey,
} from '../contracts';
import { controlContent, disabledFor, hasConsent, keyVersion, policyForKey, sameDisabledEntry, urlHosts, type ManagedHost } from './keyFacts';
import { qualifyVersion, type QualificationDeps, type QualificationOutcome } from './qualification';

export const ACTIVATION_ALLOW = 'Allow and use for new sessions';
export const ACTIVATION_NOT_NOW = 'Not now';

/** Display names of the policy's two signer tokens. */
const PUBLISHER_NAMES = Object.freeze({ openai: 'OpenAI OpCo, LLC', 'microsoft-crt': 'Microsoft' });

/** What a known file without a signature is used for, by its listing path. */
const UNSIGNED_FILE_USE: Readonly<Record<string, string>> = Object.freeze({
  'codex-path/rg.exe': 'Codex runs it when an agent searches files.',
});

export interface ActivationDialog {
  readonly title: string;
  readonly intro: string;
  readonly facts: readonly string[];
  readonly closing: string;
  readonly buttons: readonly [typeof ACTIVATION_ALLOW, typeof ACTIVATION_NOT_NOW];
}

export type ActivationDialogResult = { ok: true; dialog: ActivationDialog } | { ok: false; detail: string };

/**
 * The dialog for one promoted version, from its download record and its policy entry only. The record must describe
 * exactly the entry's files (count, bytes, signer counts, the unsigned files); otherwise no dialog is offered,
 * because it could not be truthful. A package without an unsigned file has no "Not verified" line and still needs
 * the click.
 */
export function activationDialog(entry: PolicyEntry, facts: PromotedVersion): ActivationDialogResult {
  const managed = entry.managed;
  if (!managed) return { ok: false, detail: 'The policy entry has no managed package.' };
  const files = managed.layout.files;
  const verification = facts.verification;
  const signerCount = (signer: string) => files.filter((file) => file.signer === signer).length;
  const unsignedPaths = files.filter((file) => file.signer === 'unsigned').map((file) => file.path).sort();
  const recordedUnsigned = [...verification.unsigned].sort();
  if (facts.key !== cliStoreVersionKey(entry) || facts.artifactSha256 !== managed.artifact.sha256 || facts.version !== entry.version
    || verification.files !== files.length || verification.bytes !== files.reduce((sum, file) => sum + file.size, 0)
    || verification.signed.openai !== signerCount('openai') || verification.signed.microsoftCrt !== signerCount('microsoft-crt')
    || recordedUnsigned.length !== unsignedPaths.length || recordedUnsigned.some((path, index) => path !== unsignedPaths[index])) {
    return { ok: false, detail: 'The record of this download does not describe the files this UnodeAi expects for it.' };
  }

  // The download came from one of the entry's URLs; which one served it is not recorded, so all are named.
  const hosts = urlHosts(entry);
  const from = hosts.length === 1 ? hosts[0] : `${hosts.slice(0, -1).join(', ')} or ${hosts[hosts.length - 1]}`;
  const lines: string[] = [];
  lines.push(verification.files === 1
    ? 'Its 1 file matches, byte for byte, the file UnodeAi recorded when it tested this version before release.'
    : `All ${verification.files} files match, byte for byte, the files UnodeAi recorded when it tested this version before release.`);
  const signed = [
    { count: verification.signed.openai, publisher: PUBLISHER_NAMES.openai },
    { count: verification.signed.microsoftCrt, publisher: PUBLISHER_NAMES['microsoft-crt'] },
  ].filter((item) => item.count > 0);
  lines.push(signed.length === 0
    ? 'No file carries a publisher signature.'
    : `${signed.map((item, index) => index === 0
      ? `${item.count} ${item.count === 1 ? 'file carries' : 'files carry'} a valid ${item.publisher} signature`
      : `${item.count} a valid ${item.publisher} signature`).join(', and ')}, checked now.`);
  for (const path of unsignedPaths) {
    const use = UNSIGNED_FILE_USE[path];
    lines.push(`Not verified: ${path} has no publisher signature. Its bytes match UnodeAi's record, but nothing proves that OpenAI published it.${use ? ` ${use}` : ''}`);
  }
  lines.push(verification.revocation === 'confirmed-online' ? 'Revocation: confirmed online.' : 'Revocation: not confirmed (offline).');
  return {
    ok: true,
    dialog: {
      title: `Allow Codex CLI ${entry.version} to run?`,
      intro: `UnodeAi downloaded it from ${from} and checked it on this computer:`,
      facts: lines,
      closing: 'If you allow it, UnodeAi starts it once in its own folder to check it, with no model request. If that passes, new agent sessions use it. Agents already running keep their version.',
      buttons: [ACTIVATION_ALLOW, ACTIVATION_NOT_NOW],
    },
  };
}

export interface ClickOfferInput {
  readonly suspension: SuspensionView;
  readonly control: ControlView;
  readonly instance: InstanceView;
  readonly policy: ValidatedCliCompatibilityPolicy;
  readonly host: ManagedHost;
  readonly key: VersionKey;
}

export type ClickOffer =
  | { offered: true; storeId: StoreId; key: VersionKey; version: string; closureDigest: string; dialog: ActivationDialog }
  /** `later`: the version is ready to review once managed Codex is selected again. */
  | { offered: false; reason: 'later' | 'not-verified' | 'unavailable'; detail: string };

/**
 * Whether the click is offered for a version: it is `verified` (promoted, no passed check, no `disabled` entry, not
 * yet allowed) and managed Codex is selected for new sessions, with control `ok` and no suspension.
 */
export function clickOffer(input: ClickOfferInput): ClickOffer {
  const { suspension, control, instance, policy, host, key } = input;
  if (suspension.present) return { offered: false, reason: 'unavailable', detail: 'Managed Codex is paused in every window.' };
  if (control.kind !== 'readable' || control.authority !== 'ok') return { offered: false, reason: 'unavailable', detail: 'Managed Codex control cannot be used now.' };
  if (instance.kind !== 'readable') return { offered: false, reason: 'unavailable', detail: instance.detail };
  const record = control.snapshot.record;
  const facts = instance.snapshot.record;
  if (!record.enrolledStoreId || record.enrolledStoreId !== facts.storeId) return { offered: false, reason: 'unavailable', detail: 'This managed Codex setup is not the current one.' };
  const promoted = facts.versions[key];
  if (!promoted) return { offered: false, reason: 'not-verified', detail: 'This version is not downloaded and checked.' };
  if (disabledFor(record, facts.storeId, key).length > 0) return { offered: false, reason: 'not-verified', detail: 'UnodeAi recorded that this version must not run.' };
  const keyPolicy = policyForKey(policy, key, host);
  if (keyPolicy.kind !== 'qualified') return { offered: false, reason: 'not-verified', detail: keyPolicy.kind === 'bad' ? keyPolicy.reason : keyPolicy.detail };
  if (facts.probes[key]) return { offered: false, reason: 'not-verified', detail: 'This version was already checked.' };
  if (hasConsent(record, facts.storeId, key, keyPolicy.closureDigest)) return { offered: false, reason: 'not-verified', detail: 'You already allowed this version.' };
  // An OK for a version older than the one new sessions use could not make it used (that is a rollback), so none is
  // asked for; the newest-3 rule removes its folder later.
  const active = record.active?.storeId === facts.storeId ? record.active.key : undefined;
  const activeVersion = active ? keyVersion(active) : undefined;
  if (activeVersion) {
    const order = compareCliVersions(keyPolicy.entry.version, activeVersion);
    if (order === undefined || order < 0) {
      return { offered: false, reason: 'not-verified', detail: `Codex ${keyPolicy.entry.version} is older than the version new sessions use.` };
    }
  }
  if (record.selection !== 'managed') {
    return { offered: false, reason: 'later', detail: `Codex ${keyPolicy.entry.version} is ready to review once managed Codex is selected again.` };
  }
  const dialog = activationDialog(keyPolicy.entry, promoted);
  if (!dialog.ok) return { offered: false, reason: 'unavailable', detail: dialog.detail };
  return { offered: true, storeId: facts.storeId, key, version: keyPolicy.entry.version, closureDigest: keyPolicy.closureDigest, dialog: dialog.dialog };
}

/**
 * Records the user's click for exactly `(storeId, key, closureDigest)`, an increase, visible to every window. It is
 * refused unless this instance is enrolled, managed Codex is selected, and no `disabled` entry names the version.
 */
export function recordActivationConsent(
  deps: { readonly control: ControlStoreApi; readonly now: () => string },
  ref: InstanceRef,
  key: VersionKey,
  closureDigest: string,
): Promise<ControlPublishResult> {
  return publishConsent(deps, ref, key, closureDigest, undefined);
}

/**
 * The click for a new closure during the user's Try again: the same as `recordActivationConsent`, except that the
 * one `disabled` entry that Try again repairs may still name the version (it stays until the check has passed).
 */
export function recordRepairConsent(
  deps: { readonly control: ControlStoreApi; readonly now: () => string },
  ref: InstanceRef,
  key: VersionKey,
  closureDigest: string,
  repairing: DisabledEntry,
): Promise<ControlPublishResult> {
  return publishConsent(deps, ref, key, closureDigest, repairing);
}

function publishConsent(
  deps: { readonly control: ControlStoreApi; readonly now: () => string },
  ref: InstanceRef,
  key: VersionKey,
  closureDigest: string,
  repairing: DisabledEntry | undefined,
): Promise<ControlPublishResult> {
  return deps.control.publish({
    label: 'activation-consent',
    kind: 'increase',
    apply: (current) => {
      if (current.enrolledStoreId !== ref.storeId) return { refused: 'this managed Codex setup is no longer the current one' };
      if (current.selection !== 'managed') return { refused: 'new sessions use the external Codex CLI' };
      const disabled = disabledFor(current, ref.storeId, key);
      const onlyRepairing = !!repairing && disabled.length === 1 && sameDisabledEntry(disabled[0], repairing);
      if (disabled.length > 0 && !onlyRepairing) return { refused: 'UnodeAi recorded that this version must not run' };
      if (hasConsent(current, ref.storeId, key, closureDigest)) return { moot: true };
      const decidedAt = deps.now();
      return {
        ...controlContent(current),
        activationConsents: [...current.activationConsents, { storeId: ref.storeId, key, closureDigest, decidedAt }],
        decidedAt,
      };
    },
  });
}

export type ActivationDecision =
  | QualificationOutcome
  /** "Not now": nothing was written; the version stays downloaded and checked, and the card keeps Review. */
  | { outcome: 'not-now' }
  | { outcome: 'consent-not-recorded'; detail: string };

/**
 * The user's answer to the dialog. "Allow" records the click and only then starts the check; "Not now" writes
 * nothing and starts nothing.
 */
export async function decideActivation(
  deps: QualificationDeps,
  ref: InstanceRef,
  key: VersionKey,
  answer: typeof ACTIVATION_ALLOW | typeof ACTIVATION_NOT_NOW,
): Promise<ActivationDecision> {
  if (answer !== ACTIVATION_ALLOW) return { outcome: 'not-now' };
  const keyPolicy = policyForKey(deps.policy, key, deps.host);
  if (keyPolicy.kind !== 'qualified') return { outcome: 'consent-not-recorded', detail: keyPolicy.kind === 'bad' ? keyPolicy.reason : keyPolicy.detail };
  const consent = await recordActivationConsent(deps, ref, key, keyPolicy.closureDigest);
  if (consent.outcome !== 'published' && consent.outcome !== 'moot') {
    return { outcome: 'consent-not-recorded', detail: consent.outcome === 'refused' ? consent.reason : consent.outcome };
  }
  return qualifyVersion(deps, ref, key, 'qualification');
}

export interface VerifiedNotice {
  readonly key: VersionKey;
  readonly text: string;
  readonly buttons: readonly ['Review', 'Not now'];
}

/**
 * This window's memory of the notifications for versions awaiting the click: with automatic mode on, each version
 * is announced at most once per window session, and never again or on a timer.
 */
export class VerifiedKeyNotices {
  private readonly shown = new Set<string>();

  /** The notification to show now for an offer, or undefined. Records the version as announced when it returns one. */
  next(offer: ClickOffer, autoMode: boolean): VerifiedNotice | undefined {
    if (!autoMode || !offer.offered) return undefined;
    const id = `${offer.storeId}|${offer.key}`;
    if (this.shown.has(id)) return undefined;
    this.shown.add(id);
    return { key: offer.key, text: `Codex ${offer.version} is downloaded and checked. It runs only after your OK.`, buttons: ['Review', 'Not now'] };
  }
}
