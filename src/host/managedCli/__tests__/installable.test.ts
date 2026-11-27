import { describe, expect, it } from 'vitest';
import { cliStoreVersionKey } from '../../../backend/cliCompatibilityPolicy';
import type { ControlRecord, ControlView, InstanceRecord, InstanceView, PromotedVersion, SuspensionView } from '../contracts';
import {
  downloadTarget,
  entryDownloadHosts,
  installableEntries,
  meetsCodexVersionFloor,
  versionOfKey,
} from '../updater/installable';
import { ALL_HOSTS, ASSET_HOST, GITHUB_HOST, PRIMARY_HOST, testPackage, testPolicy, unvalidatedPolicy } from './pipelineFixtures';

// Revision 5 §9.1 "installable" and the target; ADAPTER §5.1.4 (a host outside the consent needs a new consent);
// Revision 5 §3.3 (the Codex floor 0.155.0, no prerelease, as an extra minimum); Codex Q3 (an automatic task never
// retries a disabled key; the user's Try again is separate).

const STORE = 'a'.repeat(32);
const OTHER_STORE = 'b'.repeat(32);
const WINDOWS = { os: 'win32', arch: 'x64' };

function record(overrides: Partial<ControlRecord> = {}): ControlRecord {
  return {
    schema: 'unodeai.cli-control/1', controlId: 'c'.repeat(32), generation: 3, previousRecordDigest: 'd'.repeat(64), reductionEpoch: 0,
    enrolledStoreId: STORE, selection: 'managed',
    enrollment: { epoch: 0, consentedHosts: [...ALL_HOSTS], decidedAt: '2026-10-21T00:00:00Z' },
    scheduler: { epoch: 0, autoMode: true },
    activationConsents: [], active: null, lastKnownGood: null, disabled: [], retiredInstances: [], decidedAt: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}

function readable(control: ControlRecord, authority: 'ok' | 'behind-floor' = 'ok'): ControlView {
  return { kind: 'readable', authority, snapshot: { generation: control.generation, record: control, digest: 'e'.repeat(64) }, floor: 0 };
}

const absent: SuspensionView = { present: false };

function instance(versions: Record<string, PromotedVersion> = {}, storeId = STORE): InstanceView {
  const value: InstanceRecord = {
    schema: 'unodeai.cli-instance/1', storeId, generation: 1, previousRecordDigest: null,
    versions, probes: {}, stagingIntents: {}, schedule: {},
  };
  return { kind: 'readable', snapshot: { generation: 1, record: value, digest: 'f'.repeat(64) } };
}

function promotedFact(pkg: ReturnType<typeof testPackage>): PromotedVersion {
  return {
    key: cliStoreVersionKey(pkg.entry), provider: 'codex-cli', version: pkg.version, os: 'win32', arch: 'x64',
    policyVersion: 'test-1', policyEntryId: pkg.entry.id, artifactSha256: pkg.entry.managed!.artifact.sha256,
    taskToken: '1'.repeat(32), promotedAt: '2026-10-21T00:00:00Z',
    verification: { files: 5, bytes: 1, signed: { openai: 1, microsoftCrt: 1 }, unsigned: ['codex-path/rg.exe'], revocation: 'confirmed-online' },
  };
}

const p163 = testPackage('0.163.0');
const p164 = testPackage('0.164.0');
const p165 = testPackage('0.165.0');

describe('installableEntries (Revision 5 §9.1)', () => {
  it('lists every qualified Windows x64 Codex entry whose hosts are all consented, newest first', () => {
    const policy = testPolicy([p163.entry, p165.entry, p164.entry]);
    const result = installableEntries(policy, WINDOWS, { control: readable(record()), suspension: absent });
    expect(result.refused).toBeUndefined();
    expect(result.installable.map((entry) => entry.version)).toEqual(['0.165.0', '0.164.0', '0.163.0']);
    expect(result.needsHostConsent).toEqual([]);
  });

  it('gives a computer other than Windows x64 nothing', () => {
    const policy = testPolicy([p164.entry]);
    for (const host of [{ os: 'linux', arch: 'x64' }, { os: 'darwin', arch: 'arm64' }, { os: 'win32', arch: 'arm64' }, { os: 'win32', arch: 'ia32' }]) {
      expect(installableEntries(policy, host, { control: readable(record()), suspension: absent })).toEqual({ installable: [], needsHostConsent: [], refused: 'unsupported-host' });
    }
  });

  it('gives nothing while the suspension file exists, also when it cannot be read', () => {
    const policy = testPolicy([p164.entry]);
    for (const suspension of [{ present: true, readable: true, reason: 'x' }, { present: true, readable: false }] as SuspensionView[]) {
      expect(installableEntries(policy, WINDOWS, { control: readable(record()), suspension })).toMatchObject({ installable: [], refused: 'suspended' });
    }
  });

  it('gives nothing unless control is readable with authority ok and an enrolment', () => {
    const policy = testPolicy([p164.entry]);
    const view = (control: ControlView) => installableEntries(policy, WINDOWS, { control, suspension: absent });
    expect(view({ kind: 'fresh' })).toMatchObject({ installable: [], refused: 'not-enrolled' });
    expect(view({ kind: 'unusable', reason: 'sealed', detail: 'x' })).toMatchObject({ installable: [], refused: 'control-unusable' });
    expect(view({ kind: 'unusable', reason: 'floor-unavailable', detail: 'x' })).toMatchObject({ installable: [], refused: 'control-unusable' });
    expect(view(readable(record(), 'behind-floor'))).toMatchObject({ installable: [], refused: 'behind-floor' });
    expect(view(readable(record({ enrolledStoreId: null, selection: 'external', enrollment: null })))).toMatchObject({ installable: [], refused: 'not-enrolled' });
  });

  // Revision 5 §7.3 and Codex Q1: selection does not stop downloads.
  it('keeps entries installable while the selection is External', () => {
    const policy = testPolicy([p164.entry]);
    expect(installableEntries(policy, WINDOWS, { control: readable(record({ selection: 'external' })), suspension: absent }).installable).toHaveLength(1);
  });

  // ADAPTER §5.1.4: an entry whose hosts are not all consented requires a new consent before it is downloaded.
  it('returns an entry with a host outside the consent apart, with the hosts it lacks', () => {
    const policy = testPolicy([p164.entry]);
    const withoutAsset = record({ enrollment: { epoch: 0, consentedHosts: [PRIMARY_HOST, GITHUB_HOST], decidedAt: 'x' } });
    const result = installableEntries(policy, WINDOWS, { control: readable(withoutAsset), suspension: absent });
    expect(result.installable).toEqual([]);
    expect(result.needsHostConsent).toEqual([{ entry: p164.entry, hosts: [ASSET_HOST] }]);
    const withoutGithub = record({ enrollment: { epoch: 0, consentedHosts: [PRIMARY_HOST, ASSET_HOST], decidedAt: 'x' } });
    expect(installableEntries(policy, WINDOWS, { control: readable(withoutGithub), suspension: absent }).needsHostConsent[0].hosts).toEqual([GITHUB_HOST]);
  });

  it('compares hosts without case', () => {
    const policy = testPolicy([p164.entry]);
    const upper = record({ enrollment: { epoch: 0, consentedHosts: ALL_HOSTS.map((host) => host.toUpperCase()), decidedAt: 'x' } });
    expect(installableEntries(policy, WINDOWS, { control: readable(upper), suspension: absent }).installable).toHaveLength(1);
    expect(entryDownloadHosts(p164.entry)).toEqual([PRIMARY_HOST, GITHUB_HOST, ASSET_HOST]);
  });

  it('skips bad and revoked entries, other platforms and other providers', () => {
    const bad = testPackage('0.166.0', { status: 'bad' });
    const revoked = testPackage('0.167.0', { status: 'revoked' });
    const policy = testPolicy([p164.entry, bad.entry, revoked.entry]);
    expect(installableEntries(policy, WINDOWS, { control: readable(record()), suspension: absent }).installable.map((entry) => entry.version)).toEqual(['0.164.0']);
    const otherPlatform = { ...p165.entry, id: 'linux', os: 'linux' } as unknown as typeof p165.entry;
    const claude = { ...p165.entry, id: 'claude', provider: 'claude-cli' } as unknown as typeof p165.entry;
    const unchecked = unvalidatedPolicy([otherPlatform, claude, p164.entry]);
    expect(installableEntries(unchecked, WINDOWS, { control: readable(record()), suspension: absent }).installable.map((entry) => entry.id)).toEqual([p164.entry.id]);
  });

  // Revision 5 §3.3 (B4): the floor is applied again here, whatever the validator did.
  it('applies the Codex version floor 0.155.0 and refuses prereleases', () => {
    expect(meetsCodexVersionFloor('0.155.0')).toBe(true);
    expect(meetsCodexVersionFloor('0.163.0')).toBe(true);
    expect(meetsCodexVersionFloor('1.0.0')).toBe(true);
    expect(meetsCodexVersionFloor('0.154.9')).toBe(false);
    expect(meetsCodexVersionFloor('0.164.0-alpha.1')).toBe(false);
    expect(meetsCodexVersionFloor('v0.164.0')).toBe(false);
    const old = { ...testPackage('0.154.0').entry };
    const pre = { ...testPackage('0.170.0').entry, id: 'pre', version: '0.170.0-beta.2' };
    const policy = unvalidatedPolicy([old, pre, p164.entry]);
    expect(installableEntries(policy, WINDOWS, { control: readable(record()), suspension: absent }).installable.map((entry) => entry.version)).toEqual(['0.164.0']);
  });

  it('skips an entry whose program is not bin/codex.exe', () => {
    const other = testPackage('0.168.0', { entrypoint: 'codex-package.json' });
    const policy = unvalidatedPolicy([other.entry, p164.entry]);
    expect(installableEntries(policy, WINDOWS, { control: readable(record()), suspension: absent }).installable.map((entry) => entry.version)).toEqual(['0.164.0']);
  });
});

describe('downloadTarget (Revision 5 §9.1)', () => {
  const entries = [p163.entry, p164.entry, p165.entry];
  const key = (pkg: ReturnType<typeof testPackage>) => cliStoreVersionKey(pkg.entry);

  it('chooses the newest entry when nothing is active', () => {
    expect(downloadTarget(entries, record(), instance())).toEqual({ kind: 'target', entry: p165.entry, key: key(p165) });
  });

  it('chooses the newest entry above the active version, and nothing when none is above it', () => {
    const active163 = record({ active: { storeId: STORE, key: key(p163) } });
    expect(downloadTarget([p163.entry, p164.entry], active163, instance({ [key(p163)]: promotedFact(p163) }))).toMatchObject({ kind: 'target', entry: p164.entry });
    const active165 = record({ active: { storeId: STORE, key: key(p165) } });
    expect(downloadTarget(entries, active165, instance({ [key(p165)]: promotedFact(p165) }))).toEqual({ kind: 'none', reason: 'nothing-newer' });
  });

  it('reads the active version from the key when the instance lost the fact', () => {
    const active164 = record({ active: { storeId: STORE, key: key(p164) } });
    expect(downloadTarget(entries, active164, instance())).toMatchObject({ kind: 'target', entry: p165.entry });
    expect(versionOfKey(key(p164))).toBe('0.164.0');
    expect(versionOfKey('not-a-key')).toBeUndefined();
    const unreadable = record({ active: { storeId: STORE, key: 'garbage' } });
    expect(downloadTarget(entries, unreadable, instance())).toEqual({ kind: 'none', reason: 'active-version-unknown', key: 'garbage' });
  });

  // §9.2 rule A: a version awaiting its click is not downloaded again, and no older one is fetched in its place.
  it('downloads nothing while the newest candidate is promoted with the same artifact digest', () => {
    const result = downloadTarget(entries, record(), instance({ [key(p165)]: promotedFact(p165) }));
    expect(result).toEqual({ kind: 'none', reason: 'already-promoted', entry: p165.entry, key: key(p165) });
  });

  it('targets a key whose promoted fact names another artifact digest', () => {
    const other = { ...promotedFact(p165), artifactSha256: '0'.repeat(64) };
    expect(downloadTarget(entries, record(), instance({ [key(p165)]: other }))).toMatchObject({ kind: 'target', entry: p165.entry });
  });

  // Codex Q3: no automatic task retries a disabled key; an older candidate above the active version may be chosen.
  it('never targets a key control disables for this instance', () => {
    for (const reason of ['local-bad', 'probe-failed', 'probe-stop-unconfirmed', 'policy-bad', 'consent-withdrawn'] as const) {
      const disabled = record({ disabled: [{ storeId: STORE, key: key(p165), reason, at: 'x' }] });
      expect(downloadTarget(entries, disabled, instance())).toMatchObject({ kind: 'target', entry: p164.entry });
      expect(downloadTarget([p165.entry], disabled, instance())).toEqual({ kind: 'none', reason: 'disabled', entry: p165.entry, key: key(p165) });
    }
  });

  it('ignores a disabled entry that names another instance', () => {
    const inert = record({ disabled: [{ storeId: OTHER_STORE, key: key(p165), reason: 'local-bad', at: 'x' }] });
    expect(downloadTarget(entries, inert, instance())).toMatchObject({ kind: 'target', entry: p165.entry });
  });

  it('chooses nothing without an enrolment or a readable record of this instance', () => {
    expect(downloadTarget(entries, record({ enrolledStoreId: null, enrollment: null, selection: 'external' }), instance())).toEqual({ kind: 'none', reason: 'not-enrolled' });
    expect(downloadTarget(entries, record(), { kind: 'unusable', reason: 'store-corrupt', detail: 'x' })).toEqual({ kind: 'none', reason: 'instance-unusable' });
    expect(downloadTarget(entries, record(), instance({}, OTHER_STORE))).toEqual({ kind: 'none', reason: 'instance-unusable' });
  });
});
