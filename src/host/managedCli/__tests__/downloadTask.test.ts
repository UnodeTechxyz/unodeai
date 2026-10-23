import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every way Node can start a process, counted and refused: the only process a task may start is the signature check's
// Windows PowerShell, and that one goes through the fake runner's own spawn (Revision 5 §4.1, §9.1).
const processStarts = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse = (name: string) => (...args: unknown[]) => {
    processStarts.push(`${name}:${String(args[0])}`);
    throw new Error(`no process may start here (${name})`);
  };
  const refused = { spawn: refuse('spawn'), spawnSync: refuse('spawnSync'), exec: refuse('exec'), execSync: refuse('execSync'), execFile: refuse('execFile'), execFileSync: refuse('execFileSync'), fork: refuse('fork') };
  return { ...actual, ...refused, default: { ...actual, ...refused } };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const refuse = (name: string) => (...args: unknown[]) => {
    processStarts.push(`${name}:${String(args[0])}`);
    throw new Error(`no process may start here (${name})`);
  };
  const refused = { spawn: refuse('spawn'), spawnSync: refuse('spawnSync'), exec: refuse('exec'), execSync: refuse('execSync'), execFile: refuse('execFile'), execFileSync: refuse('execFileSync'), fork: refuse('fork') };
  return { ...actual, ...refused, default: { ...actual, ...refused } };
});

import { cliStoreVersionKey, type PolicyEntry } from '../../../backend/cliCompatibilityPolicy';
import { boundedDownload } from '../../cliDelivery/boundedDownload';
import { extractTarGz } from '../../cliDelivery/tarReader';
import { AUTHENTICODE_ENCODED_COMMAND, checkAuthenticodeSignatures, type AuthenticodeCheckRequest } from '../../windowsAuthenticode';
import type { ControlRecord, InstanceRecord, InstanceRef, StoreId, SuspensionView, VersionKey } from '../contracts';
import {
  DOWNLOAD_TASK_LIMITS,
  downloadFailureClass,
  runDownloadTask,
  signatureCheckFiles,
  type DownloadTaskDeps,
  type DownloadTaskKind,
  type DownloadTaskPhase,
  type DownloadTaskResult,
} from '../updater/downloadTask';
import { controlChanges, FakeControlStore, FakeInstanceStore } from './fakeStoresPipeline';
import {
  ALL_HOSTS,
  ASSET_HOST,
  codexPackageFiles,
  fakeFetch,
  fakePowerShell,
  manualTimers,
  okResponse,
  packageFetch,
  primaryUrl,
  githubUrl,
  stalledResponse,
  testPackage,
  testPolicy,
  until,
  type SignatureMode,
  type TestPackage,
} from './pipelineFixtures';

// The design these tests realise: Revision 5 §7 (a task's snapshot always carries the store id; an automatic task
// holds both epochs and needs automatic mode on, a manual one holds the enrolment epoch only; selection does not stop
// downloads) and §9.1 (V1 artifact, V2 layout and per-file digests, V3 PE sniff, V4 Authenticode, then promotion as
// `verified`, which is not launchable); ADAPTER §5.2.3 (3 GiB), §5.3–§5.5, §5.10, §5.12.1–2; LOCK §4 (the advisory
// intent) and §5 (leases); Codex's immutable design §8 and §11 (a task holds the gate only to take its lease) and the
// merged design §3.4 (launchable) and §4 (a present suspension refuses every task).

const WINDOWS = { os: 'win32', arch: 'x64' };
const HOST_ID = { pid: 1000, creation: '2026-10-21T07:59:00.1234567Z' };
const OTHER_WINDOW = { pid: 2000, creation: '2026-10-21T07:58:00.7654321Z' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const stores: FakeInstanceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  processStarts.length = 0;
});

interface Harness {
  events: string[];
  control: FakeControlStore;
  instances: FakeInstanceStore;
  ref: InstanceRef;
  packages: TestPackage[];
  policy: ReturnType<typeof testPolicy>;
}

async function setup(options: { packages?: TestPackage[]; hosts?: string[]; autoMode?: boolean } = {}): Promise<Harness> {
  const events: string[] = [];
  const instances = new FakeInstanceStore(events);
  stores.push(instances);
  const control = new FakeControlStore(events, instances);
  await control.initialize();
  const created = await instances.create();
  if (!created.ok) throw new Error('no instance');
  await control.publish(controlChanges.enrol(created.ref.storeId, options.hosts ?? [...ALL_HOSTS], options.autoMode ?? true));
  const packages = options.packages ?? [testPackage('0.164.0')];
  events.length = 0;
  return { events, control, instances, ref: created.ref, packages, policy: testPolicy(packages.map((item) => item.entry)) };
}

interface DepsOptions {
  signatures?: SignatureMode;
  /** Runs, synchronously, when the task reaches a step and before it checks its snapshot there. */
  at?: Partial<Record<DownloadTaskPhase, () => void>>;
  /**
   * Runs, awaited, when a step's work has ended and before the task checks its snapshot at the next step: another
   * window acts here. `V4` is therefore just before the promotion step's check.
   */
  after?: Partial<Record<'V1' | 'V2' | 'V4', () => void | Promise<void>>>;
}

function taskDeps(h: Harness, options: DepsOptions = {}, overrides: Partial<DownloadTaskDeps> = {}) {
  const powerShell = fakePowerShell(options.signatures ?? 'honest', h.events);
  const fetched = packageFetch(h.packages, h.events);
  const signatureRequests: AuthenticodeCheckRequest[] = [];
  const outer = new AbortController();
  const deps: DownloadTaskDeps = {
    fetch: fetched.fetch,
    hostIdentity: () => HOST_ID,
    ownerLiveness: async () => 'alive',
    signal: outer.signal,
    stillAllowed: () => true,
    writeRoots: () => [],
    authenticode: powerShell.deps,
    stopTree: powerShell.stopTree,
    newToken: undefined,
    download: async (request, downloadDeps) => {
      h.events.push('V1:start');
      const result = await boundedDownload(request, downloadDeps);
      h.events.push(`V1:end:${result.ok ? 'ok' : result.failure}`);
      await options.after?.V1?.();
      return result;
    },
    extract: async (request) => {
      h.events.push('V2:start');
      const result = await extractTarGz(request);
      h.events.push(`V2:end:${result.ok ? 'ok' : result.reason}`);
      await options.after?.V2?.();
      return result;
    },
    checkSignatures: async (request, checkDeps) => {
      h.events.push(`V4:start:${request.files.every((file) => file.pinnedDigestVerified === true) ? 'pinned' : 'not-pinned'}`);
      signatureRequests.push(request);
      const result = await checkAuthenticodeSignatures(request, checkDeps);
      h.events.push(`V4:end:${result.status}`);
      await options.after?.V4?.();
      return result;
    },
    onPhase: (phase) => {
      h.events.push(`phase:${phase}`);
      options.at?.[phase]?.();
    },
    ...overrides,
  };
  return { deps, powerShell, fetched, signatureRequests, outer };
}

function run(h: Harness, kind: DownloadTaskKind, deps: DownloadTaskDeps, entry: PolicyEntry = h.packages[0].entry): Promise<DownloadTaskResult> {
  const view = h.control.read();
  if (view.kind !== 'readable') throw new Error('control is not readable');
  return runDownloadTask({ kind, decidedOn: view.snapshot, entry, policy: h.policy, host: WINDOWS, instance: h.ref, control: h.control, instances: h.instances }, deps);
}

function controlRecord(h: Harness): ControlRecord {
  const view = h.control.read();
  if (view.kind !== 'readable') throw new Error('control is not readable');
  return view.snapshot.record;
}

/** The merged design §3.4: every condition for a new session to launch `key` of `storeId`. */
function launchable(control: ControlRecord, instance: InstanceRecord, suspension: SuspensionView, storeId: StoreId, key: VersionKey): boolean {
  return control.enrolledStoreId === storeId
    && control.selection === 'managed'
    && suspension.present === false
    && control.activationConsents.some((consent) => consent.storeId === storeId && consent.key === key)
    && !control.disabled.some((entry) => entry.storeId === storeId && entry.key === key)
    && ((control.active?.storeId === storeId && control.active.key === key) || (control.lastKnownGood?.storeId === storeId && control.lastKnownGood.key === key))
    && Object.hasOwn(instance.probes, key);
}

function expectNothingPromoted(h: Harness): void {
  expect(h.instances.listVersionFolders(h.ref)).toEqual([]);
  expect(h.instances.record(h.ref).versions).toEqual({});
  expect(h.events.some((event) => event.startsWith('promote:'))).toBe(false);
}

/** Every exit: the staging folder is gone, the own intent is gone, and the lease is released. */
function expectCleanedUp(h: Harness): void {
  expect(h.instances.stagingFolders(h.ref)).toEqual([]);
  expect(Object.values(h.instances.record(h.ref).stagingIntents).filter((intent) => intent.owner.pid === HOST_ID.pid)).toEqual([]);
  expect(h.instances.leases.every((lease) => lease.released)).toBe(true);
  expect(h.instances.heldHandles(h.ref.storeId)).toBe(0);
}

const index = (events: string[], event: string) => {
  const at = events.indexOf(event);
  expect(at, `${event} in ${events.join(', ')}`).toBeGreaterThanOrEqual(0);
  return at;
};

// =============================================================================================
// The whole task
// =============================================================================================

describe('runDownloadTask: from a policy entry to a promoted, verified key', () => {
  it('runs V1, V2, V3 and V4 in that order and promotes the version with what they proved', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const key = cliStoreVersionKey(pkg.entry);
    const { deps } = taskDeps(h);
    const result = await run(h, 'automatic', deps);

    expect(result).toMatchObject({ outcome: 'verified', alreadyPromoted: false, key });
    expect(result.snapshot).toEqual({ storeId: h.ref.storeId, enrollmentEpoch: 0, schedulerEpoch: 0, kind: 'automatic' });
    const order = ['phase:V1', 'V1:start', 'V1:end:ok', 'phase:V2', 'V2:start', 'V2:end:ok', 'phase:V3', 'phase:V4', 'V4:start:pinned', 'V4:end:checked', 'phase:promote', `promote:${key}`]
      .map((event) => index(h.events, event));
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const fact = h.instances.record(h.ref).versions[key];
    expect(fact).toEqual({
      key, provider: 'codex-cli', version: '0.164.0', os: 'win32', arch: 'x64', policyVersion: 'test-1', policyEntryId: pkg.entry.id,
      artifactSha256: pkg.entry.managed!.artifact.sha256, taskToken: expect.stringMatching(/^[0-9a-f]{32}$/), promotedAt: expect.any(String),
      verification: {
        files: 5,
        bytes: pkg.files.reduce((sum, file) => sum + file.data.length, 0),
        signed: { openai: 1, microsoftCrt: 1 },
        unsigned: ['codex-path/rg.exe'],
        revocation: 'confirmed-online',
      },
    });
    // The payload became the version folder, byte for byte.
    const folder = h.instances.versionFolder(h.ref, key);
    for (const file of pkg.files) expect(readFileSync(path.join(folder, ...file.path.split('/'))).equals(file.data)).toBe(true);
    expectCleanedUp(h);
    expect(h.instances.record(h.ref).schedule.lastAttemptAt).toEqual(expect.any(String));
  });

  // Revision 5 §9.1: `verified` is not launchable; nothing runs before the user's click.
  it('promotes the key as verified only: no consent, no probe result, no role, and no control publication', async () => {
    const h = await setup();
    const key = cliStoreVersionKey(h.packages[0].entry);
    const controlGenerations = h.control.generations.length;
    const result = await run(h, 'automatic', taskDeps(h).deps);
    expect(result.outcome).toBe('verified');
    expect(h.control.generations).toHaveLength(controlGenerations);
    const control = controlRecord(h);
    expect(control.activationConsents).toEqual([]);
    expect(control.active).toBeNull();
    expect(control.lastKnownGood).toBeNull();
    expect(h.instances.record(h.ref).probes).toEqual({});
    expect(launchable(control, h.instances.record(h.ref), h.control.readSuspension(), h.ref.storeId, key)).toBe(false);
  });

  it('starts no process but the signature check\'s Windows PowerShell (a spawn spy)', async () => {
    const h = await setup();
    const { deps, powerShell } = taskDeps(h);
    const result = await run(h, 'manual', deps);
    expect(result.outcome).toBe('verified');
    expect(powerShell.spawned).toHaveLength(1);
    expect(powerShell.spawned[0].command).toBe(path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(powerShell.spawned[0].args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', AUTHENTICODE_ENCODED_COMMAND]);
    expect(processStarts).toEqual([]);
  });

  it('sends every PE file to V4 after V2 verified it, and no file that is not a PE', async () => {
    const h = await setup();
    const { deps, signatureRequests, powerShell } = taskDeps(h);
    await run(h, 'automatic', deps);
    expect(index(h.events, 'V2:end:ok')).toBeLessThan(index(h.events, 'V4:start:pinned'));
    expect(signatureRequests).toHaveLength(1);
    const sent = signatureRequests[0].files.map((file) => [path.basename(file.path), file.signer, file.pinnedDigestVerified]);
    expect(sent).toEqual([['codex.exe', 'openai', true], ['rg.exe', 'unsigned', true], ['vcruntime140.dll', 'microsoft-crt', true]]);
    expect(powerShell.spawned[0].files.map((file) => path.basename(file))).toEqual(['codex.exe', 'rg.exe', 'vcruntime140.dll']);
    expect(signatureRequests[0].signers).toEqual(h.policy.signers);
  });

  // windowsAuthenticode: a CRT catalog chain with an expired intermediate passes only for bytes just verified (V2).
  it('passes a CRT catalog chain with an expired intermediate, because V2 has just verified the DLL', async () => {
    const h = await setup();
    const result = await run(h, 'automatic', taskDeps(h, { signatures: 'crt-expired-intermediate' }).deps);
    expect(result).toMatchObject({ outcome: 'verified' });
  });

  it('says a file matches its pin only when V2 verified that very file', () => {
    const layout = { files: codexPackageFiles('0.164.0').map((file) => ({ path: file.path, size: file.data.length, sha256: '0'.repeat(64), pe: file.pe, signer: file.signer })) };
    const all = new Set(layout.files.map((file) => file.path.toLowerCase()));
    expect(signatureCheckFiles(path.join(path.sep, 'p'), layout, all).every((file) => file.pinnedDigestVerified === true)).toBe(true);
    const partly = new Set(['bin/codex.exe']);
    expect(signatureCheckFiles(path.join(path.sep, 'p'), layout, partly).map((file) => file.pinnedDigestVerified)).toEqual([true, false, false]);
    expect(signatureCheckFiles(path.join(path.sep, 'p'), layout, new Set()).map((file) => file.pinnedDigestVerified)).toEqual([false, false, false]);
  });

  it('records revocation not confirmed when a chain could not be checked online', async () => {
    const h = await setup();
    const result = await run(h, 'automatic', taskDeps(h, { signatures: 'offline' }).deps);
    expect(result.outcome === 'verified' && result.facts?.verification.revocation).toBe('not-confirmed-offline');
  });

  it('finds a key already promoted with the same digest and downloads nothing', async () => {
    const h = await setup();
    await run(h, 'automatic', taskDeps(h).deps);
    h.events.length = 0;
    const second = taskDeps(h);
    const result = await run(h, 'automatic', second.deps);
    expect(result).toMatchObject({ outcome: 'verified', alreadyPromoted: true });
    expect(second.fetched.calls).toHaveLength(0);
    expectCleanedUp(h);
  });

  it('carries the store id in every snapshot and refuses a decision that named another instance', async () => {
    const h = await setup();
    const { deps, fetched } = taskDeps(h);
    const view = h.control.read();
    if (view.kind !== 'readable') throw new Error('unreadable');
    const other = await h.instances.create();
    if (!other.ok) throw new Error('no instance');
    const result = await runDownloadTask({ kind: 'automatic', decidedOn: view.snapshot, entry: h.packages[0].entry, policy: h.policy, host: WINDOWS, instance: other.ref, control: h.control, instances: h.instances }, deps);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not-allowed' });
    expect(fetched.calls).toHaveLength(0);
  });
});

// =============================================================================================
// The admission gate and the lease
// =============================================================================================

describe('the admission gate (Codex immutable design §8, §11)', () => {
  it('creates the download lease while the gate is held and releases the gate before the download starts', async () => {
    const h = await setup();
    await run(h, 'automatic', taskDeps(h).deps);
    const acquired = index(h.events, 'gate:acquired');
    const lease = index(h.events, 'lease:created:download:gate-held');
    const released = index(h.events, 'gate:released');
    const fetched = index(h.events, 'fetch:releases.openai.com');
    expect(acquired).toBeLessThan(lease);
    expect(lease).toBeLessThan(released);
    expect(released).toBeLessThan(fetched);
    expect(h.events.filter((event) => event === 'gate:acquired')).toHaveLength(1);
    expect(h.instances.leases).toHaveLength(1);
    expect(h.instances.leases[0]).toMatchObject({ createdWhileGateHeld: true, released: true, record: { kind: 'download', holder: HOST_ID, storeId: h.ref.storeId } });
  });

  it('refuses the task at a closed gate before any network call, lease or staging', async () => {
    const h = await setup();
    expect(await h.instances.closeAdmission(h.ref)).toEqual({ ok: true, alreadyClosed: false });
    const { deps, fetched } = taskDeps(h);
    const result = await run(h, 'automatic', deps);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'gate-closed' });
    expect(fetched.calls).toHaveLength(0);
    expect(h.instances.leases).toHaveLength(0);
    expect(h.instances.stagingFolders(h.ref)).toEqual([]);
    expect(h.events.some((event) => event.startsWith('instance:'))).toBe(false);
  });

  it('releases its lease in every outcome', async () => {
    for (const mode of ['honest', 'garbage', 'openai-not-signed'] as SignatureMode[]) {
      const h = await setup();
      await run(h, 'automatic', taskDeps(h, { signatures: mode }).deps);
      expect(h.instances.leases.length).toBe(1);
      expect(h.instances.leases.every((lease) => lease.released)).toBe(true);
    }
  });
});

// =============================================================================================
// The store limit
// =============================================================================================

describe('the 3 GiB store limit (ADAPTER §5.2.3, merged design §6.5)', () => {
  it('refuses a download that would take the instance past 3 GiB as store full, before any network call', async () => {
    const h = await setup();
    const managed = h.packages[0].entry.managed!;
    h.instances.usage = DOWNLOAD_TASK_LIMITS.storeCapBytes - managed.artifact.size - managed.layout.unpackedBytes + 1;
    const { deps, fetched } = taskDeps(h);
    const result = await run(h, 'automatic', deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'cap', failure: 'store-full' });
    expect(fetched.calls).toHaveLength(0);
    expectNothingPromoted(h);
    expectCleanedUp(h);
    // Never retried automatically.
    expect(h.instances.record(h.ref).schedule.failure).toMatchObject({ class: 'store-full', attempts: 1 });
    expect(h.instances.record(h.ref).schedule.failure?.retryAt).toBeUndefined();
    expect(DOWNLOAD_TASK_LIMITS.storeCapBytes).toBe(3 * 1024 ** 3);
  });

  it('downloads when the instance reaches exactly 3 GiB', async () => {
    const h = await setup();
    const managed = h.packages[0].entry.managed!;
    h.instances.usage = DOWNLOAD_TASK_LIMITS.storeCapBytes - managed.artifact.size - managed.layout.unpackedBytes;
    expect((await run(h, 'automatic', taskDeps(h).deps)).outcome).toBe('verified');
  });
});

// =============================================================================================
// V1–V4 failures
// =============================================================================================

describe('V1–V4: each failure, its class and its retry rule (ADAPTER §5.5, §5.10)', () => {
  async function failedWith(h: Harness, deps: DownloadTaskDeps) {
    const result = await run(h, 'automatic', deps);
    expectNothingPromoted(h);
    expectCleanedUp(h);
    return { result, failure: h.instances.record(h.ref).schedule.failure };
  }

  it('V1: bytes of the right size with another SHA-256 are integrity, never extracted and never retried', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const tampered = Buffer.from(pkg.archive);
    tampered[100] ^= 0x01;
    const { deps } = taskDeps(h, {}, { fetch: fakeFetch({ [primaryUrl(pkg.version)]: () => okResponse(tampered) }).fetch });
    const { result, failure } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V1', failure: 'integrity' });
    expect(h.events).not.toContain('V2:start');
    expect(failure).toMatchObject({ class: 'integrity', entryId: pkg.entry.id, attempts: 1 });
    expect(failure?.retryAt).toBeUndefined();
  });

  it('V1: a wrong Content-Length is integrity', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const short = pkg.archive.subarray(0, pkg.archive.length - 1);
    const { deps } = taskDeps(h, {}, { fetch: fakeFetch({ [primaryUrl(pkg.version)]: () => okResponse(Buffer.from(short)) }).fetch });
    expect((await failedWith(h, deps)).result).toMatchObject({ outcome: 'failed', phase: 'V1', failure: 'integrity' });
  });

  it('V1: a network failure on every URL is network, retried after 1 hour', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const broken = () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
    const { deps } = taskDeps(h, {}, { fetch: fakeFetch({ [primaryUrl(pkg.version)]: broken, [githubUrl(pkg.version)]: broken }).fetch, now: () => Date.parse('2026-10-21T10:00:00Z') });
    const { result, failure } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V1', failure: 'network' });
    expect(failure).toMatchObject({ class: 'network', attempts: 1, retryAt: '2026-10-21T11:00:00.000Z' });
  });

  it('V1: an HTTP error on every URL is network', async () => {
    const h = await setup();
    const { deps } = taskDeps(h, {}, { fetch: fakeFetch({}).fetch });
    expect((await failedWith(h, deps)).result).toMatchObject({ outcome: 'failed', phase: 'V1', failure: 'network' });
  });

  it('V1: a redirect to a host the entry does not list is host-not-allowed, never retried', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const redirect = () => ({ status: 302, headers: new Headers({ location: 'https://evil.example/pkg.tar.gz' }), body: null });
    const { deps } = taskDeps(h, {}, { fetch: fakeFetch({ [primaryUrl(pkg.version)]: redirect }).fetch });
    const { result, failure } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V1', failure: 'host-not-allowed' });
    expect(failure?.retryAt).toBeUndefined();
  });

  it('V1: follows a redirect to a listed redirect host', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const asset = `https://${ASSET_HOST}/asset?token=secret`;
    const { deps } = taskDeps(h, {}, {
      fetch: fakeFetch({
        [primaryUrl(pkg.version)]: () => ({ status: 302, headers: new Headers({ location: asset }), body: null }),
        [asset]: () => okResponse(pkg.archive),
      }).fetch,
    });
    expect((await run(h, 'automatic', deps)).outcome).toBe('verified');
  });

  it('V2: an archive file whose bytes are not its pinned digest is integrity, and nothing is signature-checked', async () => {
    const files = codexPackageFiles('0.164.0');
    const archiveFiles = files.map((file) => file.path === 'codex-resources/NOTICE.md' ? { ...file, data: Buffer.alloc(file.data.length, 0x78) } : file);
    const h = await setup({ packages: [testPackage('0.164.0', { files, archiveFiles })] });
    const { deps, powerShell } = taskDeps(h);
    const { result, failure } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V2', failure: 'integrity' });
    expect(result.outcome === 'failed' && result.detail).toContain('SHA-256');
    expect(h.events).toContain('V1:end:ok');
    expect(h.events).not.toContain('phase:V3');
    expect(powerShell.spawned).toHaveLength(0);
    expect(failure?.retryAt).toBeUndefined();
  });

  it('V2: an archive entry the layout does not list is integrity', async () => {
    const files = codexPackageFiles('0.164.0');
    const extra = { path: 'codex-resources/extra.dll', data: Buffer.from('MZ extra'), pe: true, signer: 'openai' as const };
    const h = await setup({ packages: [testPackage('0.164.0', { files, archiveFiles: [...files, extra] })] });
    expect((await failedWith(h, taskDeps(h).deps)).result).toMatchObject({ outcome: 'failed', phase: 'V2', failure: 'integrity' });
  });

  it('V3: a file listed as not a PE that starts with MZ is integrity, before any signature check', async () => {
    const files = codexPackageFiles('0.164.0').map((file) => file.path === 'codex-resources/NOTICE.md' ? { ...file, data: Buffer.concat([Buffer.from('MZ'), file.data]) } : file);
    const h = await setup({ packages: [testPackage('0.164.0', { files })] });
    const { deps, powerShell } = taskDeps(h);
    const { result } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V3', failure: 'integrity' });
    expect(result.outcome === 'failed' && result.detail).toContain('codex-resources/NOTICE.md');
    expect(powerShell.spawned).toHaveLength(0);
  });

  it('V3: a file listed as a PE that does not start with MZ is integrity', async () => {
    const files = codexPackageFiles('0.164.0').map((file) => file.path === 'codex-path/rg.exe' ? { ...file, data: Buffer.from('#!/bin/sh ripgrep') } : file);
    const h = await setup({ packages: [testPackage('0.164.0', { files })] });
    const { deps, powerShell } = taskDeps(h);
    const { result } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V3', failure: 'integrity' });
    expect(powerShell.spawned).toHaveLength(0);
  });

  it('V4: an unavailable signature check is signature-unavailable, never a pass, and is retried after 1 hour', async () => {
    const h = await setup();
    const { deps } = taskDeps(h, { signatures: 'garbage' }, { now: () => Date.parse('2026-10-21T10:00:00Z') });
    const { result, failure } = await failedWith(h, deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V4', failure: 'signature-unavailable' });
    expect(failure).toMatchObject({ class: 'signature-unavailable', retryAt: '2026-10-21T11:00:00.000Z' });
  });

  it('V4: PowerShell missing is signature-unavailable', async () => {
    const h = await setup();
    const { deps } = taskDeps(h, {}, { authenticode: { platform: 'win32', env: {} } });
    expect((await failedWith(h, deps)).result).toMatchObject({ outcome: 'failed', phase: 'V4', failure: 'signature-unavailable' });
  });

  it('V4: a definite signature failure is signature, never retried', async () => {
    const h = await setup();
    const { result, failure } = await failedWith(h, taskDeps(h, { signatures: 'openai-not-signed' }).deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V4', failure: 'signature' });
    expect(result.outcome === 'failed' && result.detail).toContain('codex.exe');
    expect(failure?.retryAt).toBeUndefined();
  });

  it('V4: a revoked certificate is signature, and says so', async () => {
    const h = await setup();
    const { result } = await failedWith(h, taskDeps(h, { signatures: 'revoked' }).deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'V4', failure: 'signature' });
    expect(result.outcome === 'failed' && result.detail).toContain('revoked');
  });

  it('a promotion that finds another artifact under the key is integrity', async () => {
    const h = await setup();
    h.instances.promoteOverride = () => ({ ok: false, reason: 'different-artifact', detail: 'another artifact' });
    const result = await run(h, 'automatic', taskDeps(h).deps);
    expect(result).toMatchObject({ outcome: 'failed', phase: 'promote', failure: 'integrity' });
    expectCleanedUp(h);
  });

  it('maps every download failure to its schedule class', () => {
    expect(downloadFailureClass('network')).toBe('network');
    expect(downloadFailureClass('http')).toBe('network');
    expect(downloadFailureClass('timeout')).toBe('timeout');
    expect(downloadFailureClass('refused-url')).toBe('host-not-allowed');
    expect(downloadFailureClass('size')).toBe('integrity');
    expect(downloadFailureClass('integrity')).toBe('integrity');
    expect(downloadFailureClass('file')).toBe('file');
  });
});

// =============================================================================================
// Epochs across windows (Revision 5 §7, §11.15)
// =============================================================================================

describe('epochs: window B changes control while window A\'s task runs (Revision 5 §11.15)', () => {
  const windowB = (h: Harness, ...changes: Array<() => ReturnType<typeof controlChanges.autoMode>>) => async () => {
    for (const change of changes) await h.control.publish(change());
  };

  it('aborts an automatic task before promotion when B turns automatic mode off during the download', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const { deps } = taskDeps(h, {}, {
      fetch: fakeFetch({ [primaryUrl(pkg.version)]: async () => { await h.control.publish(controlChanges.autoMode(false)); return okResponse(pkg.archive); } }).fetch,
    });
    const result = await run(h, 'automatic', deps);
    expect(result).toMatchObject({ outcome: 'aborted' });
    expect(result.outcome === 'aborted' && result.detail).toBe('automatic updates were turned off');
    expectNothingPromoted(h);
    expectCleanedUp(h);
    expect(h.instances.record(h.ref).schedule.failure).toBeUndefined();
  });

  it('aborts an automatic task at the promotion step when B turns automatic mode off just before it', async () => {
    const h = await setup();
    const result = await run(h, 'automatic', taskDeps(h, { after: { V4: windowB(h, () => controlChanges.autoMode(false)) } }).deps);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote' });
    expectNothingPromoted(h);
  });

  it('lets a manual task continue and promote when B turns automatic mode off', async () => {
    const h = await setup();
    const result = await run(h, 'manual', taskDeps(h, { after: { V4: windowB(h, () => controlChanges.autoMode(false)) } }).deps);
    expect(result).toMatchObject({ outcome: 'verified', alreadyPromoted: false });
    expect(controlRecord(h).scheduler).toEqual({ epoch: 1, autoMode: false });
  });

  it('lets a manual task run with automatic mode off from the start', async () => {
    const h = await setup({ autoMode: false });
    expect((await run(h, 'manual', taskDeps(h).deps)).outcome).toBe('verified');
    const auto = await setup({ autoMode: false });
    expect(await run(auto, 'automatic', taskDeps(auto).deps)).toMatchObject({ outcome: 'refused', reason: 'not-allowed' });
  });

  it('aborts both kinds when B removes a host the entry uses', async () => {
    for (const kind of ['automatic', 'manual'] as const) {
      const h = await setup();
      const result = await run(h, kind, taskDeps(h, { after: { V4: windowB(h, () => controlChanges.removeHost(ASSET_HOST)) } }).deps);
      expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote' });
      expectNothingPromoted(h);
    }
  });

  it('aborts both kinds when B removes any host, also one the entry does not use (the enrolment epoch)', async () => {
    for (const kind of ['automatic', 'manual'] as const) {
      const h = await setup({ hosts: [...ALL_HOSTS, 'mirror.example'] });
      const result = await run(h, kind, taskDeps(h, { after: { V4: windowB(h, () => controlChanges.removeHost('mirror.example')) } }).deps);
      expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote' });
      expect(result.outcome === 'aborted' && result.detail).toBe('the managed Codex enrolment changed');
      expectNothingPromoted(h);
    }
  });

  it('still aborts an automatic task when B turns automatic mode off and on again', async () => {
    const h = await setup();
    const result = await run(h, 'automatic', taskDeps(h, { after: { V4: windowB(h, () => controlChanges.autoMode(false), () => controlChanges.autoMode(true)) } }).deps);
    expect(controlRecord(h).scheduler).toEqual({ epoch: 1, autoMode: true });
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote' });
    expect(result.outcome === 'aborted' && result.detail).toBe('automatic updates were turned off');
    expectNothingPromoted(h);
  });

  // Revision 5 §7.2 and §11.19 "Tasks": a re-enrolled store starts with epochs equal to the old one's.
  it('aborts on the store id when B resets and enrols a new instance at equal epochs (I8)', async () => {
    for (const kind of ['automatic', 'manual'] as const) {
      const h = await setup();
      let instanceB: StoreId | undefined;
      const resetAndEnrol = async () => {
        await h.control.publish(controlChanges.reset());
        const created = await h.instances.create();
        if (!created.ok) throw new Error('no instance');
        instanceB = created.ref.storeId;
        await h.control.publish(controlChanges.enrol(created.ref.storeId, [...ALL_HOSTS], true));
      };
      const result = await run(h, kind, taskDeps(h, { after: { V4: resetAndEnrol } }).deps);
      const now = controlRecord(h);
      // The scenario is exact: only the store id differs from A's snapshot.
      expect(now.enrolledStoreId).toBe(instanceB);
      expect(now.enrollment?.epoch).toBe(result.snapshot?.enrollmentEpoch);
      expect(now.scheduler.epoch).toBe(result.snapshot?.schedulerEpoch);
      expect(now.scheduler.autoMode).toBe(true);
      expect(result.snapshot?.storeId).toBe(h.ref.storeId);
      expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote', detail: 'managed Codex was reset or set up again' });
      expectNothingPromoted(h);
    }
  });

  // Revision 5 §7.3 and Codex Q1: selection does not stop downloads, and nothing managed runs unless it is managed.
  it('keeps downloading after B chooses External, and the promoted key is still not launchable', async () => {
    const h = await setup();
    const key = cliStoreVersionKey(h.packages[0].entry);
    const result = await run(h, 'automatic', taskDeps(h, { after: { V1: windowB(h, () => controlChanges.selectExternal()) } }).deps);
    expect(result).toMatchObject({ outcome: 'verified', alreadyPromoted: false });
    const control = controlRecord(h);
    expect(control.selection).toBe('external');
    expect(launchable(control, h.instances.record(h.ref), h.control.readSuspension(), h.ref.storeId, key)).toBe(false);
  });

  it('aborts when control becomes unusable or falls behind its floor', async () => {
    const unusable = await setup();
    expect(await run(unusable, 'manual', taskDeps(unusable, { at: { V3: () => { unusable.control.unusable = { reason: 'sealed', detail: 'x' }; } } }).deps))
      .toMatchObject({ outcome: 'aborted', phase: 'V3' });
    expectNothingPromoted(unusable);
    const behind = await setup();
    expect(await run(behind, 'manual', taskDeps(behind, { at: { V3: () => { behind.control.authority = 'behind-floor'; } } }).deps))
      .toMatchObject({ outcome: 'aborted', phase: 'V3' });
    expectNothingPromoted(behind);
  });

  // Revision 5 §7.2 lists "the entry still installable" among the checks; a shrunk consent is caught by it alone here.
  it('aborts when the entry stops being installable, even without a new enrolment epoch', async () => {
    const h = await setup();
    const shrink = async () => {
      await h.control.publish({
        label: 'consent shrunk without an epoch', kind: 'reduction',
        apply: (current) => ({ ...current, enrollment: { ...current.enrollment!, consentedHosts: current.enrollment!.consentedHosts.filter((host) => host !== ASSET_HOST) } }),
      });
    };
    const result = await run(h, 'manual', taskDeps(h, { after: { V4: shrink } }).deps);
    expect(controlRecord(h).enrollment?.epoch).toBe(0);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote', detail: 'the version is no longer one UnodeAi may download' });
    expectNothingPromoted(h);
  });

  // ADAPTER §5.1.5: the store is refused when a write root can reach it, checked before every download and promotion.
  it('refuses, and aborts before promotion, when a folder an agent may write reaches the store', async () => {
    const h = await setup();
    const { deps, fetched } = taskDeps(h, {}, { writeRoots: () => [h.instances.root] });
    expect(await run(h, 'automatic', deps)).toMatchObject({ outcome: 'refused', reason: 'not-allowed', detail: 'a folder an agent may write reaches the managed Codex store' });
    expect(fetched.calls).toHaveLength(0);
    const inside = await setup();
    expect(await run(inside, 'manual', taskDeps(inside, {}, { writeRoots: () => [path.join(inside.ref.root, 'staging')] }).deps)).toMatchObject({ outcome: 'refused', reason: 'not-allowed' });
    const later = await setup();
    let roots: string[] = [];
    const result = await run(later, 'manual', taskDeps(later, { after: { V4: () => { roots = [later.ref.root]; } } }, { writeRoots: () => roots }).deps);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote' });
    expectNothingPromoted(later);
    const elsewhere = await setup();
    expect((await run(elsewhere, 'manual', taskDeps(elsewhere, {}, { writeRoots: () => [path.join(elsewhere.instances.root, '..', 'some-workspace')] }).deps)).outcome).toBe('verified');
  });

  it('aborts when the window stops being allowed (trust or binding)', async () => {
    const h = await setup();
    let allowed = true;
    const result = await run(h, 'manual', taskDeps(h, { at: { V2: () => { allowed = false; } } }, { stillAllowed: () => allowed }).deps);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V2' });
    expectNothingPromoted(h);
  });
});

// =============================================================================================
// The suspension
// =============================================================================================

describe('the shared suspension (merged design §4, Codex Q4)', () => {
  it('starts no task while the suspension file exists, readable or not', async () => {
    for (const suspension of [{ present: true, readable: true, reason: 'x' }, { present: true, readable: false }] as SuspensionView[]) {
      const h = await setup();
      h.control.suspension = suspension;
      const { deps, fetched } = taskDeps(h);
      const result = await run(h, 'manual', deps);
      expect(result).toMatchObject({ outcome: 'refused', reason: 'not-allowed', detail: 'managed Codex is suspended' });
      expect(fetched.calls).toHaveLength(0);
      expect(h.instances.leases).toHaveLength(0);
    }
  });

  it('aborts a running task at its next check, and promotes nothing', async () => {
    const h = await setup();
    const result = await run(h, 'manual', taskDeps(h, { after: { V4: () => h.control.suspend('control unreadable', 'control-unreadable').then(() => undefined) } }).deps);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'promote', detail: 'managed Codex is suspended' });
    expectNothingPromoted(h);
    expectCleanedUp(h);
  });

  // ADAPTER §5.3.7 as replaced by Revision 5 §7.2: every 5 seconds, not only between steps.
  it('checks again every 5 seconds while a step runs, and stops the signature check it started', async () => {
    const h = await setup();
    const timers = manualTimers();
    const { deps, powerShell } = taskDeps(h, { signatures: 'hang' }, { timers });
    const running = run(h, 'manual', deps);
    await until(() => powerShell.spawned.length === 1);
    timers.advance(DOWNLOAD_TASK_LIMITS.recheckMs - 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(powerShell.stops).toHaveLength(0);
    h.control.suspension = { present: true, readable: false };
    timers.advance(1);
    const result = await running;
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V4', detail: 'managed Codex is suspended' });
    expect(powerShell.stops).toEqual([powerShell.spawned[0].child]);
    expect(result.treeStops).toEqual([{ status: 'confirmed-stopped' }]);
    expectNothingPromoted(h);
    expectCleanedUp(h);
  });
});

// =============================================================================================
// Cancellation and shutdown
// =============================================================================================

describe('cancellation and shutdown (ADAPTER §5.12.1–2)', () => {
  it('during V1: aborts the fetch, deletes the staging folder and clears its own intent', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const { deps, outer } = taskDeps(h, {}, {
      fetch: fakeFetch({ [primaryUrl(pkg.version)]: (init) => stalledResponse(pkg.archive.length, init.signal) }).fetch,
    });
    const running = run(h, 'automatic', deps);
    await until(() => h.events.includes('V1:start'));
    expect(Object.keys(h.instances.record(h.ref).stagingIntents)).toHaveLength(1);
    outer.abort();
    const result = await running;
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V1', detail: 'the window stopped the task' });
    expectNothingPromoted(h);
    expectCleanedUp(h);
    expect(h.instances.record(h.ref).stagingIntents).toEqual({});
    expect(h.instances.record(h.ref).schedule.failure).toBeUndefined();
  });

  it('during V2: stops the extraction', async () => {
    const h = await setup();
    const { deps, outer } = taskDeps(h);
    const result = await run(h, 'automatic', { ...deps, extract: async (request) => { outer.abort(); return extractTarGz(request); } });
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V2' });
    expectNothingPromoted(h);
    expectCleanedUp(h);
  });

  it('during V4: stops the PowerShell tree it started, with stop evidence', async () => {
    const h = await setup();
    const { deps, outer, powerShell } = taskDeps(h, { signatures: 'hang' });
    const running = run(h, 'automatic', deps);
    await until(() => powerShell.spawned.length === 1);
    outer.abort();
    const result = await running;
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V4' });
    expect(powerShell.stops).toEqual([powerShell.spawned[0].child]);
    expect(result.treeStops).toEqual([{ status: 'confirmed-stopped' }]);
    expectNothingPromoted(h);
    expectCleanedUp(h);
  });

  it('starts no process once the shutdown has begun', async () => {
    const h = await setup();
    const { deps, outer, powerShell } = taskDeps(h, { at: { V4: () => outer.abort() } });
    const result = await run(h, 'automatic', deps);
    expect(result).toMatchObject({ outcome: 'aborted', phase: 'V4' });
    expect(powerShell.spawned).toHaveLength(0);
    // Also when the stop comes between the check and the run itself.
    const late = await setup();
    const second = taskDeps(late);
    const lateResult = await run(late, 'automatic', { ...second.deps, checkSignatures: async (request, checkDeps) => { second.outer.abort(); return checkAuthenticodeSignatures(request, checkDeps); } });
    expect(lateResult).toMatchObject({ outcome: 'aborted', phase: 'V4' });
    expect(second.powerShell.spawned).toHaveLength(0);
    expect(processStarts).toEqual([]);
  });

  it('refuses at once when the window was already stopped', async () => {
    const h = await setup();
    const { deps, outer, fetched } = taskDeps(h);
    outer.abort();
    expect(await run(h, 'automatic', deps)).toMatchObject({ outcome: 'refused', reason: 'not-allowed' });
    expect(fetched.calls).toHaveLength(0);
  });

  it('ends a task that runs longer than 10 minutes as a timeout', async () => {
    const h = await setup();
    const timers = manualTimers();
    const { deps, powerShell } = taskDeps(h, { signatures: 'hang' }, { timers });
    const running = run(h, 'automatic', deps);
    await until(() => powerShell.spawned.length === 1);
    timers.advance(DOWNLOAD_TASK_LIMITS.taskMs);
    const result = await running;
    expect(result).toMatchObject({ outcome: 'failed', failure: 'timeout' });
    expect(powerShell.stops).toHaveLength(1);
    expectNothingPromoted(h);
  });
});

// =============================================================================================
// The advisory intent
// =============================================================================================

describe('the advisory staging intent (LOCK §4)', () => {
  async function withIntent(h: Harness, startedAt: string, key = cliStoreVersionKey(h.packages[0].entry)) {
    const token = 'f'.repeat(32);
    await h.instances.publish(h.ref, {
      label: 'other window intent',
      apply: (current) => ({ ...current, stagingIntents: { ...current.stagingIntents, [token]: { key, owner: OTHER_WINDOW, startedAt } } }),
    });
    return token;
  }
  const recent = () => new Date(Date.now() - MINUTE).toISOString();

  it('skips while a live owner in another window downloads the same key, and leaves its intent', async () => {
    for (const liveness of ['alive', 'unknown'] as const) {
      const h = await setup();
      const token = await withIntent(h, recent());
      const { deps, fetched } = taskDeps(h, {}, { ownerLiveness: async () => liveness });
      expect(await run(h, 'automatic', deps)).toMatchObject({ outcome: 'skipped', reason: 'another-window' });
      expect(fetched.calls).toHaveLength(0);
      expect(h.instances.stagingFolders(h.ref)).toEqual([]);
      expect(Object.keys(h.instances.record(h.ref).stagingIntents)).toEqual([token]);
      expectCleanedUp(h);
    }
  });

  it('counts a liveness query that fails as alive', async () => {
    const h = await setup();
    await withIntent(h, recent());
    const { deps } = taskDeps(h, {}, { ownerLiveness: async () => { throw new Error('no answer'); } });
    expect(await run(h, 'automatic', deps)).toMatchObject({ outcome: 'skipped' });
  });

  it('proceeds past a dead owner\'s intent, and does not remove it (only its owner does)', async () => {
    const h = await setup();
    const token = await withIntent(h, recent());
    const asked: unknown[] = [];
    const { deps } = taskDeps(h, {}, { ownerLiveness: async (owner) => { asked.push(owner); return 'dead'; } });
    expect((await run(h, 'automatic', deps)).outcome).toBe('verified');
    expect(asked).toEqual([OTHER_WINDOW]);
    expect(Object.keys(h.instances.record(h.ref).stagingIntents)).toEqual([token]);
  });

  it('proceeds past an intent older than the 10-minute task limit, even of a live owner', async () => {
    const h = await setup();
    await withIntent(h, new Date(Date.now() - DOWNLOAD_TASK_LIMITS.taskMs - MINUTE).toISOString());
    const { deps } = taskDeps(h, {}, { ownerLiveness: async () => 'alive' });
    expect((await run(h, 'automatic', deps)).outcome).toBe('verified');
  });

  it('ignores an intent for another key', async () => {
    const h = await setup();
    const token = await withIntent(h, recent(), '0.999.0-win32-x64-0000000000000000');
    expect((await run(h, 'automatic', taskDeps(h).deps)).outcome).toBe('verified');
    expect(Object.keys(h.instances.record(h.ref).stagingIntents)).toEqual([token]);
  });

  it('skips when another window\'s intent lands between its read and its publication', async () => {
    const h = await setup();
    let once = true;
    h.instances.beforeCommit = async (change) => {
      if (once && change.label === 'download intent') {
        once = false;
        await withIntent(h, recent());
      }
    };
    const { deps, fetched } = taskDeps(h);
    expect(await run(h, 'automatic', deps)).toMatchObject({ outcome: 'skipped' });
    expect(fetched.calls).toHaveLength(0);
  });

  // A task of another window that outlived the 10-minute limit is taken for dead: both tasks then download.
  it('makes two tasks of one key in two windows harmless: one promotes, the other finds it promoted', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const late = fakeFetch({ [primaryUrl(pkg.version)]: async () => { await held; return okResponse(pkg.archive); } });
    const b = taskDeps(h, {}, { fetch: late.fetch, hostIdentity: () => OTHER_WINDOW, now: () => Date.now() - DOWNLOAD_TASK_LIMITS.taskMs - MINUTE });
    const second = run(h, 'automatic', b.deps);
    await until(() => late.calls.length === 1);
    const first = await run(h, 'automatic', taskDeps(h, {}, { ownerLiveness: async () => 'alive' }).deps);
    release();
    const later = await second;
    expect(first).toMatchObject({ outcome: 'verified', alreadyPromoted: false });
    expect(later).toMatchObject({ outcome: 'verified', alreadyPromoted: true });
    expect(h.instances.listVersionFolders(h.ref)).toEqual([cliStoreVersionKey(pkg.entry)]);
    expect(h.instances.stagingFolders(h.ref)).toEqual([]);
    expect(h.instances.record(h.ref).stagingIntents).toEqual({});
  });

  it('records the attempt with its intent, so every window counts the 24 hours from it', async () => {
    const h = await setup();
    const at = Date.parse('2026-10-21T09:30:00Z');
    let intent: unknown;
    const { deps } = taskDeps(h, { at: { staging: () => { intent = Object.values(h.instances.record(h.ref).stagingIntents)[0]; } } }, { now: () => at });
    await run(h, 'automatic', deps);
    expect(intent).toEqual({ key: cliStoreVersionKey(h.packages[0].entry), owner: HOST_ID, startedAt: '2026-10-21T09:30:00.000Z' });
    expect(h.instances.record(h.ref).schedule.lastAttemptAt).toBe('2026-10-21T09:30:00.000Z');
  });

  it('counts consecutive failures of one entry across tasks, and clears them on success', async () => {
    const h = await setup();
    const pkg = h.packages[0];
    const broken = () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
    const failing = () => taskDeps(h, {}, { fetch: fakeFetch({ [primaryUrl(pkg.version)]: broken, [githubUrl(pkg.version)]: broken }).fetch, now: () => Date.parse('2026-10-21T10:00:00Z') }).deps;
    await run(h, 'automatic', failing());
    await run(h, 'automatic', failing());
    expect(h.instances.record(h.ref).schedule.failure).toMatchObject({ attempts: 2, retryAt: new Date(Date.parse('2026-10-21T10:00:00Z') + 6 * HOUR).toISOString() });
    await run(h, 'automatic', taskDeps(h).deps);
    expect(h.instances.record(h.ref).schedule.failure).toBeUndefined();
  });
});
