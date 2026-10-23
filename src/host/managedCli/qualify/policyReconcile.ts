/*---------------------------------------------------------------------------------------------
 *  UnodeAi - versions the bundled policy now marks bad, and which version a new session may use (v0.9.97)
 *  When an extension update marks a version `bad` or `revoked`, that version is recorded as `policy-bad` in control,
 *  a prohibition nothing ever passes. A new session uses the active version when it is launchable, otherwise the
 *  last-known-good when that one is launchable and still installable, otherwise no managed version: launches are
 *  then blocked with repair, and nothing falls back to another version or to the external CLI by itself.
 *--------------------------------------------------------------------------------------------*/

import { cliStoreVersionKey, type ValidatedCliCompatibilityPolicy } from '../../../backend/cliCompatibilityPolicy';
import type {
  ControlPublishResult,
  ControlStoreApi,
  ControlView,
  DisabledEntry,
  InstanceStoreApi,
  InstanceView,
  ManagedVersionRef,
  SuspensionView,
  VersionKey,
} from '../contracts';
import { boundedDetail, controlContent, versionLaunchability, type ManagedHost } from './keyFacts';

export interface PolicyReconciliation {
  /** `nothing-bad`: the policy marks no Codex version bad, so nothing was read or published. */
  readonly outcome: ControlPublishResult['outcome'] | 'nothing-bad';
  /** The versions this call recorded as `policy-bad`. */
  readonly added: VersionKey[];
}

/**
 * Records `policy-bad` for every version of the enrolled instance whose policy entry is now `bad` or `revoked`, in
 * one reduction. The versions are those control names (active, last-known-good, OKs, other entries) and those the
 * instance holds facts for. Idempotent: a version already recorded as `policy-bad` is left as it is.
 */
export async function reconcilePolicy(
  stores: { readonly control: ControlStoreApi; readonly instance: InstanceStoreApi },
  policy: ValidatedCliCompatibilityPolicy,
  now: () => string,
): Promise<PolicyReconciliation> {
  const bad = new Map<VersionKey, string>();
  for (const entry of policy.entries) {
    if (entry.provider !== 'codex-cli' || !entry.managed || entry.status === 'qualified') continue;
    bad.set(cliStoreVersionKey(entry), entry.statusReason ?? entry.status);
  }
  if (bad.size === 0) return { outcome: 'nothing-bad', added: [] };
  const view = stores.control.read();
  const storeId = view.kind === 'readable' ? view.snapshot.record.enrolledStoreId : null;
  const instanceKeys = new Set<VersionKey>();
  if (storeId) {
    const opened = stores.instance.open(storeId);
    if (opened.ok) {
      const instance = stores.instance.read(opened.ref);
      if (instance.kind === 'readable') for (const key of Object.keys(instance.snapshot.record.versions)) instanceKeys.add(key);
    }
  }
  let added: VersionKey[] = [];
  const result = await stores.control.publish({
    label: 'disable-policy-bad',
    kind: 'reduction',
    apply: (current) => {
      const enrolled = current.enrolledStoreId;
      added = [];
      if (!enrolled) return { moot: true };
      const keys = new Set<VersionKey>(enrolled === storeId ? instanceKeys : []);
      for (const version of [current.active, current.lastKnownGood, ...current.activationConsents, ...current.disabled]) {
        if (version && version.storeId === enrolled) keys.add(version.key);
      }
      const at = now();
      const entries: DisabledEntry[] = [];
      for (const key of [...keys].sort()) {
        const reason = bad.get(key);
        if (reason === undefined) continue;
        if (current.disabled.some((entry) => entry.storeId === enrolled && entry.key === key && entry.reason === 'policy-bad')) continue;
        entries.push({ storeId: enrolled, key, reason: 'policy-bad', detail: boundedDetail(reason), at });
      }
      if (entries.length === 0) return { moot: true };
      added = entries.map((entry) => entry.key);
      return { ...controlContent(current), disabled: [...current.disabled, ...entries], decidedAt: at };
    },
  });
  return { outcome: result.outcome, added: result.outcome === 'published' ? added : [] };
}

export interface LaunchableInput {
  readonly suspension: SuspensionView;
  readonly control: ControlView;
  readonly instance: InstanceView;
  readonly policy: ValidatedCliCompatibilityPolicy;
  readonly host: ManagedHost;
}

export type LaunchableKey =
  /** The launcher must still find this closure digest when it checks the files at the start. */
  | { launchable: true; version: ManagedVersionRef; role: 'active' | 'last-known-good'; closureDigest: string; versionName: string; activeProblem?: string }
  | { launchable: false; reason: string; activeProblem?: string; lastKnownGoodProblem?: string };

/**
 * The version a new session may use, from the records: the active version when it is launchable; otherwise the
 * last-known-good when it is launchable and still installable; otherwise none. Nothing is launchable while
 * suspended, unless control reads `ok`, the instance is the enrolled one and managed Codex is selected.
 */
export function launchableKey(input: LaunchableInput): LaunchableKey {
  const { suspension, control, instance, policy, host } = input;
  if (suspension.present) return { launchable: false, reason: 'Managed Codex is paused in every window.' };
  if (control.kind !== 'readable' || control.authority !== 'ok') return { launchable: false, reason: 'Managed Codex control cannot be used now.' };
  const record = control.snapshot.record;
  if (!record.enrolledStoreId) return { launchable: false, reason: 'Managed Codex is not set up.' };
  if (record.selection !== 'managed') return { launchable: false, reason: 'New sessions use the external Codex CLI.' };
  if (instance.kind !== 'readable') return { launchable: false, reason: instance.detail };
  const facts = instance.snapshot.record;
  if (facts.storeId !== record.enrolledStoreId) return { launchable: false, reason: 'The managed Codex store belongs to another setup.' };

  let activeProblem: string | undefined;
  if (record.active) {
    const active = versionLaunchability(record.active, 'active', record, facts, policy, host);
    if (active.ok) return { launchable: true, version: record.active, role: 'active', closureDigest: active.closureDigest, versionName: active.version };
    activeProblem = active.why;
  } else {
    activeProblem = 'no version is active';
  }
  let lastKnownGoodProblem: string | undefined;
  const lkg = record.lastKnownGood;
  if (lkg && !(record.active && lkg.storeId === record.active.storeId && lkg.key === record.active.key)) {
    const fallback = versionLaunchability(lkg, 'last-known-good', record, facts, policy, host);
    if (fallback.ok) return { launchable: true, version: lkg, role: 'last-known-good', closureDigest: fallback.closureDigest, versionName: fallback.version, activeProblem };
    lastKnownGoodProblem = fallback.why;
  }
  return { launchable: false, reason: `No managed Codex version can start: ${activeProblem}.`, activeProblem, ...(lastKnownGoodProblem ? { lastKnownGoodProblem } : {}) };
}
