/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the check of a downloaded Codex version after the user's OK, and what its result records (v0.9.97)
 *  The program starts once, in its own work folder, through the final admission check. A pass with a confirmed stop
 *  is recorded in this order: the positive fact in the instance first, then (only after a Check again or Try again)
 *  the control generation that removes the one entry the user's action passed, then the activation. A stop or crash
 *  between those steps leaves the prohibition in force; the reverse order is never used.
 *
 *  A failure and an unconfirmed stop are prohibitions in control, never instance facts, so losing an instance
 *  generation cannot revive an older pass. After an unconfirmed stop the lease and the work folder are kept: the
 *  process may still use them.
 *--------------------------------------------------------------------------------------------*/

import { compareCliVersions } from '../../../backend/cliRuntime';
import type { ControlPublishResult, DisabledReason, InstanceRef, ProbePass, VersionKey, WorkFolder } from '../contracts';
import {
  admitManagedStart,
  recordProhibition,
  type AdmissionRefusal,
  type AdmittedStart,
  type ManagedProbeResult,
  type ManagedStartDeps,
  type ManagedStartPurpose,
} from './admission';
import {
  boundedDetail,
  controlContent,
  disabledFor,
  hasConsent,
  instanceContent,
  keyVersion,
  policyForKey,
  sameDisabledEntry,
  versionLaunchability,
} from './keyFacts';

export interface QualificationDeps extends ManagedStartDeps {
  /** A new 32-hex-digit token for the check's work folder. */
  readonly newToken: () => string;
}

export type ActivationResult =
  | { activated: true; lastKnownGood: VersionKey | null }
  | { activated: false; reason: string };

export type QualificationOutcome =
  /** The check passed and every positive fact is recorded. `activation` says whether new sessions now use it. */
  | { outcome: 'ready'; key: VersionKey; activation: ActivationResult }
  /** Nothing started. */
  | { outcome: 'refused'; reason: AdmissionRefusal | 'work-folder' | 'warning' | 'user-action'; detail: string }
  /** The check failed with a confirmed stop; `recorded` says whether its prohibition was published. */
  | { outcome: 'failed'; reason: 'probe-failed' | 'local-bad'; detail: string; recorded: boolean }
  /** The check's process may still run. The lease and the work folder are kept. */
  | { outcome: 'stop-unconfirmed'; detail: string; workToken: string; recorded: boolean }
  /** The check passed, but a positive fact could not be recorded: the version is not used, and any prohibition stays. */
  | { outcome: 'not-recorded'; stage: 'probe-fact' | 'redecision'; detail: string };

/** One admitted check run and its result, before anything about it is published. */
export type ProbeRun =
  | { ran: false; outcome: Extract<QualificationOutcome, { outcome: 'refused' }> }
  | { ran: true; start: AdmittedStart; work: WorkFolder; startedAt: string; result: ManagedProbeResult };

/**
 * Admits and runs one check of `key` for `purpose`. A pass whose version output is not the entry's is a failure;
 * a probe that throws counts as an unconfirmed stop, because its process may still run.
 */
export async function runProbeOnce(deps: QualificationDeps, ref: InstanceRef, key: VersionKey, purpose: ManagedStartPurpose): Promise<ProbeRun> {
  const keyPolicy = policyForKey(deps.policy, key, deps.host);
  if (keyPolicy.kind !== 'qualified') {
    return { ran: false, outcome: { outcome: 'refused', reason: 'policy', detail: keyPolicy.kind === 'bad' ? boundedDetail(keyPolicy.reason) : keyPolicy.detail } };
  }
  const admission = await admitManagedStart(deps, ref, key, keyPolicy.closureDigest, purpose);
  if (!admission.admitted) return { ran: false, outcome: { outcome: 'refused', reason: admission.reason, detail: admission.detail } };
  const start = admission.start;
  let work: WorkFolder;
  try {
    work = deps.instance.createWorkFolder(ref, deps.newToken());
  } catch (error) {
    start.abandon();
    return { ran: false, outcome: { outcome: 'refused', reason: 'work-folder', detail: boundedDetail(`UnodeAi could not prepare the check's folder (${errorText(error)}).`) } };
  }
  const startedAt = deps.now();
  let result: ManagedProbeResult;
  try {
    result = await start.spawn(work);
  } catch (error) {
    result = { result: 'stop-unconfirmed', detail: `the check ended without a result (${errorText(error)})`, durationMs: 0 };
  }
  if (result.result === 'pass' && result.versionOutput !== start.entry.versionOutput) {
    result = { result: 'fail', detail: `it reported "${String(result.versionOutput ?? '').slice(0, 80)}" as its version, not "${start.entry.versionOutput}"`, durationMs: result.durationMs };
  }
  return { ran: true, start, work, startedAt, result };
}

/** Records an unconfirmed stop: the prohibition replaces the entry the action passed; the lease and folder stay. */
export async function recordStopUnconfirmed(deps: QualificationDeps, run: Extract<ProbeRun, { ran: true }>): Promise<QualificationOutcome> {
  const detail = boundedDetail(`${run.result.detail ?? 'its process tree did not confirm its end'}; its folder ${run.work.token} is kept`);
  const recorded = await recordProhibition(deps, run.start.ref, {
    storeId: run.start.ref.storeId,
    key: run.start.key,
    closureDigest: run.start.closureDigest,
    reason: 'probe-stop-unconfirmed',
    detail,
    at: deps.now(),
  }, run.start.bypassed);
  return { outcome: 'stop-unconfirmed', detail, workToken: run.work.token, recorded };
}

/** Records a failed check with a confirmed stop: the work folder is removed, the prohibition published, the lease released. */
export async function recordFailure(
  deps: QualificationDeps,
  run: Extract<ProbeRun, { ran: true }>,
  reason: Extract<DisabledReason, 'probe-failed' | 'local-bad'>,
): Promise<QualificationOutcome> {
  await removeWorkFolder(deps, run.work);
  const detail = boundedDetail(run.result.detail ?? 'the check failed');
  try {
    const recorded = await recordProhibition(deps, run.start.ref, {
      storeId: run.start.ref.storeId,
      key: run.start.key,
      closureDigest: run.start.closureDigest,
      reason,
      detail,
      at: deps.now(),
    }, run.start.bypassed);
    return { outcome: 'failed', reason, detail, recorded };
  } finally {
    releaseLease(deps, run);
  }
}

/**
 * The check of `key` after the user's OK (or, with the user's own action, Check again and Try again), and what its
 * result records. A pass: the work folder is removed; the probe fact is published in the instance and waited for;
 * only then the control generation that removes exactly the entry the action passed; then the activation. The lease
 * is held until those publications are done.
 */
export async function qualifyVersion(deps: QualificationDeps, ref: InstanceRef, key: VersionKey, purpose: ManagedStartPurpose): Promise<QualificationOutcome> {
  const run = await runProbeOnce(deps, ref, key, purpose);
  if (!run.ran) return run.outcome;
  if (run.result.result === 'stop-unconfirmed') return recordStopUnconfirmed(deps, run);
  if (run.result.result !== 'pass') return recordFailure(deps, run, 'probe-failed');

  await removeWorkFolder(deps, run.work);
  try {
    const pass: ProbePass = {
      key,
      closureDigest: run.start.closureDigest,
      versionOutput: run.result.versionOutput as string,
      startedAt: run.startedAt,
      durationMs: run.result.durationMs,
    };
    const artifactSha256 = run.start.entry.managed?.artifact.sha256;
    let fact;
    try {
      fact = await deps.instance.publish(ref, {
        label: 'probe-pass',
        apply: (current) => {
          if (current.versions[key]?.artifactSha256 !== artifactSha256) return { refused: 'the version is no longer recorded' };
          return { ...instanceContent(current), probes: { ...current.probes, [key]: pass } };
        },
      });
    } catch (error) {
      return { outcome: 'not-recorded', stage: 'probe-fact', detail: boundedDetail(errorText(error)) };
    }
    if (fact.outcome !== 'published' && fact.outcome !== 'moot') {
      return { outcome: 'not-recorded', stage: 'probe-fact', detail: fact.outcome === 'refused' ? boundedDetail(fact.reason) : fact.outcome };
    }

    if (run.start.bypassed) {
      const bypassed = run.start.bypassed;
      const redecision = await deps.control.publish({
        label: `redecide-${bypassed.reason}`,
        // The user's re-decision after a recorded doubt counts as a reduction, even though it removes a prohibition.
        kind: 'reduction',
        apply: (current) => {
          if (current.enrolledStoreId !== ref.storeId) return { refused: 'this managed Codex setup is no longer the current one' };
          const index = current.disabled.findIndex((existing) => sameDisabledEntry(existing, bypassed));
          if (index < 0) return { moot: true };
          return { ...controlContent(current), disabled: current.disabled.filter((_, at) => at !== index), decidedAt: deps.now() };
        },
      });
      if (redecision.outcome !== 'published' && redecision.outcome !== 'moot') {
        return { outcome: 'not-recorded', stage: 'redecision', detail: publishText(redecision) };
      }
    }

    const activation = await activateVersion(deps, ref, key);
    return { outcome: 'ready', key, activation };
  } finally {
    releaseLease(deps, run);
  }
}

/**
 * Makes a ready version the one new sessions use, an increase: `active` becomes it, and the previous active becomes
 * the last-known-good when it is still launchable (allowed, checked, not disabled, installable); otherwise the
 * last-known-good stays. A version older than the active one is not made active here: that would be a rollback.
 */
export async function activateVersion(deps: ManagedStartDeps, ref: InstanceRef, key: VersionKey): Promise<ActivationResult> {
  const keyPolicy = policyForKey(deps.policy, key, deps.host);
  if (keyPolicy.kind !== 'qualified') return { activated: false, reason: 'this UnodeAi does not qualify this version' };
  const instanceView = deps.instance.read(ref);
  if (instanceView.kind !== 'readable') return { activated: false, reason: instanceView.detail };
  const instance = instanceView.snapshot.record;
  if (instance.probes[key]?.closureDigest !== keyPolicy.closureDigest) return { activated: false, reason: 'its check is not recorded' };
  let lastKnownGood: VersionKey | null = null;
  let result: ControlPublishResult;
  try {
    result = await deps.control.publish({
      label: 'activate',
      kind: 'increase',
      apply: (current) => {
        if (current.enrolledStoreId !== ref.storeId) return { refused: 'this managed Codex setup is no longer the current one' };
        if (!hasConsent(current, ref.storeId, key, keyPolicy.closureDigest)) return { refused: 'this version has not been allowed to run' };
        if (disabledFor(current, ref.storeId, key).length > 0) return { refused: 'UnodeAi recorded that this version must not run' };
        const previous = current.active;
        if (previous && previous.storeId === ref.storeId) {
          if (previous.key === key) return { moot: true };
          const order = compareCliVersions(keyVersion(key) ?? '', keyVersion(previous.key) ?? '');
          if (order === undefined || order < 0) return { refused: 'a newer version is already used for new sessions' };
        }
        const keepPrevious = !!previous && previous.storeId === ref.storeId
          && versionLaunchability(previous, 'last-known-good', current, instance, deps.policy, deps.host).ok;
        const nextLastKnownGood = keepPrevious ? previous : current.lastKnownGood;
        lastKnownGood = nextLastKnownGood?.key ?? null;
        return { ...controlContent(current), active: { storeId: ref.storeId, key }, lastKnownGood: nextLastKnownGood, decidedAt: deps.now() };
      },
    });
  } catch (error) {
    return { activated: false, reason: boundedDetail(errorText(error)) };
  }
  if (result.outcome === 'published') return { activated: true, lastKnownGood };
  if (result.outcome === 'moot') return { activated: true, lastKnownGood: null };
  return { activated: false, reason: publishText(result) };
}

async function removeWorkFolder(deps: QualificationDeps, work: WorkFolder): Promise<void> {
  try { await deps.instance.removeWorkFolder(work); } catch { /* best effort; collected with its instance */ }
}

function releaseLease(deps: QualificationDeps, run: Extract<ProbeRun, { ran: true }>): void {
  try { deps.instance.releaseLease(run.start.lease); } catch { /* counts as alive until collected */ }
}

export function publishText(result: ControlPublishResult): string {
  switch (result.outcome) {
    case 'refused': return boundedDetail(result.reason);
    case 'unusable': return result.view.kind === 'unusable' ? boundedDetail(result.view.detail) : 'managed Codex control cannot be used';
    case 'stale': return 'another window changed managed Codex first';
    case 'busy': return 'another window kept changing managed Codex';
    default: return result.outcome;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
