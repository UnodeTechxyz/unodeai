/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Try again, for a Codex version UnodeAi marked bad on this computer (v0.9.97)
 *  A version marked bad (its files changed, or its check failed) is never retried, cleared or promoted again by
 *  anything automatic. The user may choose Try again for that same version. The old entry stays in force throughout:
 *  the local copy is retired (refused while any lease that could use it is alive or unknown), the version is
 *  downloaded and checked again from the start, and its check runs again. Only once every positive fact is
 *  published does a control generation remove that one entry. Any failure leaves a prohibition in place and starts
 *  no retry.
 *
 *  If the new copy's files are exactly the ones the user already allowed, that OK still covers them; other files need
 *  a new OK.
 *--------------------------------------------------------------------------------------------*/

import type { PolicyEntry } from '../../../backend/cliCompatibilityPolicy';
import type { InstanceRef, InstanceStoreApi, Promotion, VersionKey, VersionRetirement } from '../contracts';
import { activationDialog, recordRepairConsent, type ActivationDialog } from './activation';
import { BYPASSABLE_REASONS } from './admission';
import { boundedDetail, disabledFor, hasConsent, isInstallable, policyForKey } from './keyFacts';
import { publishText, qualifyVersion, type QualificationDeps, type QualificationOutcome } from './qualification';

/** Downloads an entry again and promotes it as a `verified` folder of its key: the complete V1–V4 checks. */
export type DownloadAndPromote = (ref: InstanceRef, entry: PolicyEntry, signal: AbortSignal) => Promise<Promotion>;

export interface TryAgainDeps extends QualificationDeps {
  readonly instance: InstanceStoreApi;
  readonly downloadAndPromote: DownloadAndPromote;
}

export interface TryAgainRequest {
  readonly ref: InstanceRef;
  readonly key: VersionKey;
  /** The user chose Try again for this version. Required, with no default: no automatic task calls Try again. */
  readonly userChoice: 'try-again';
  /**
   * Shows the activation dialog when the new copy's files are not the ones the user allowed, and resolves true only
   * on "Allow". Not called when the existing OK covers the new copy.
   */
  readonly askForNewClick: (dialog: ActivationDialog) => Promise<boolean>;
  readonly signal: AbortSignal;
}

export type TryAgainOutcome =
  | QualificationOutcome
  /** A lease that could use the folder is alive or unknown: nothing was changed. */
  | { outcome: 'in-use'; detail: string }
  | { outcome: 'retire-failed'; detail: string }
  /** The new download or one of its checks failed; the entry stays and nothing retries it. */
  | { outcome: 'download-failed'; detail: string }
  /** The new copy needs a new OK and the user did not give it: it stays downloaded and checked, the entry stays. */
  | { outcome: 'not-now' }
  | { outcome: 'consent-not-recorded'; detail: string };

/** The user's Try again for one version whose only `disabled` entry is `local-bad` or `probe-failed`. */
export async function tryAgain(deps: TryAgainDeps, request: TryAgainRequest): Promise<TryAgainOutcome> {
  if (request.userChoice !== 'try-again') {
    return { outcome: 'refused', reason: 'user-action', detail: 'Try again runs only as the user\'s own choice.' };
  }
  const { ref, key } = request;

  // Before anything is changed: the same conditions the check needs, and exactly one entry Try again repairs.
  if (deps.control.readSuspension().present) return { outcome: 'refused', reason: 'suspended', detail: 'Managed Codex is paused in every window.' };
  const view = deps.control.read();
  if (view.kind !== 'readable' || view.authority !== 'ok') return { outcome: 'refused', reason: 'control', detail: 'Managed Codex control cannot be used now.' };
  const record = view.snapshot.record;
  if (record.enrolledStoreId !== ref.storeId) return { outcome: 'refused', reason: 'not-enrolled', detail: 'This managed Codex setup is no longer the current one.' };
  if (record.selection !== 'managed') return { outcome: 'refused', reason: 'external', detail: 'New sessions use the external Codex CLI, so no managed Codex program starts.' };
  const entries = disabledFor(record, ref.storeId, key);
  if (entries.length !== 1 || !BYPASSABLE_REASONS.tryAgain.includes(entries[0].reason)) {
    return { outcome: 'refused', reason: 'disabled', detail: 'Try again is offered only for a version UnodeAi marked bad on this computer.' };
  }
  const repairing = entries[0];
  const keyPolicy = policyForKey(deps.policy, key, deps.host);
  if (keyPolicy.kind !== 'qualified') return { outcome: 'refused', reason: 'policy', detail: keyPolicy.kind === 'bad' ? boundedDetail(keyPolicy.reason) : keyPolicy.detail };
  if (!isInstallable(keyPolicy.entry, deps.host, record)) {
    return { outcome: 'refused', reason: 'policy', detail: 'This version would be downloaded from a host you have not allowed.' };
  }

  // The suspect copy is retired only when nothing can be using it.
  let retired: VersionRetirement;
  try {
    retired = await deps.instance.retireVersion(ref, key);
  } catch (error) {
    retired = { ok: false, reason: 'deferred', detail: errorText(error) };
  }
  if (!retired.ok) {
    return retired.reason === 'in-use'
      ? { outcome: 'in-use', detail: 'This version is in use by an agent or a check. Nothing was changed.' }
      : { outcome: 'retire-failed', detail: boundedDetail(retired.detail) };
  }

  // The complete download and its checks, to a new `verified` folder of the same key.
  let promotion: Promotion;
  try {
    promotion = await deps.downloadAndPromote(ref, keyPolicy.entry, request.signal);
  } catch (error) {
    return { outcome: 'download-failed', detail: boundedDetail(errorText(error)) };
  }
  if (!promotion.ok) return { outcome: 'download-failed', detail: boundedDetail(promotion.detail) };
  const facts = promotion.snapshot.record.versions[key];
  if (promotion.key !== key || !facts) return { outcome: 'download-failed', detail: 'The new download was not recorded for this version.' };

  // The OK covers the new copy only if its files are exactly the allowed ones.
  const now = deps.control.read();
  const covered = now.kind === 'readable' && hasConsent(now.snapshot.record, ref.storeId, key, keyPolicy.closureDigest);
  if (!covered) {
    const dialog = activationDialog(keyPolicy.entry, facts);
    if (!dialog.ok) return { outcome: 'download-failed', detail: dialog.detail };
    if (await request.askForNewClick(dialog.dialog) !== true) return { outcome: 'not-now' };
    const consent = await recordRepairConsent(deps, ref, key, keyPolicy.closureDigest, repairing);
    if (consent.outcome !== 'published' && consent.outcome !== 'moot') return { outcome: 'consent-not-recorded', detail: publishText(consent) };
  }

  // The check, through the final admission; a pass removes the entry only after its fact is published.
  return qualifyVersion(deps, ref, key, { tryAgain: true });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
