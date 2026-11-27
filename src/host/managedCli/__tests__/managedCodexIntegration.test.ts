import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClosureHasher, verifyManagedVersionFolder } from '../../../backend/cliClosure';
import { CodexPreflightError } from '../../../backend/CodexCliPreflight';
import type { CodexProgramFailure, CodexProgramStart } from '../../../backend/CodexBackend';
import { launchCodexProgram } from '../../codexProgramLaunch';
import { AgentStartFailureChecks } from '../qualify/agentStartFailure';
import type { QualificationDeps } from '../qualify/qualification';
import type { ManagedLaunchPlan } from '../managedLauncher';
import {
  CLI_COMPATIBILITY_POLICY,
  CLI_REQUIRED_CANARIES,
  cliStoreVersionKey,
  loadCliCompatibilityPolicy,
  type CliCompatibilityPolicy,
  type PolicyEntry,
  type ValidatedCliCompatibilityPolicy,
} from '../../../backend/cliCompatibilityPolicy';
import { CliRuntimeResolver, type CliSpawn } from '../../cliRuntimeResolver';
import { runTransientCliUse } from '../../transientCliStart';
import { ManagedCodexActions } from '../../managedCodexActions';
import type { ManagedCodexHost } from '../../cliRuntimeHost';
import type { SessionRuntimePin } from '../../cliRuntimePin';
import { createControlStore } from '../controlStore';
import { createInstanceStore } from '../instanceStore';
import { ManagedCodexStore } from '../managedCodexStore';
import { ManagedLauncher } from '../managedLauncher';
import { launchableKey } from '../qualify/policyReconcile';
import { layoutClosureDigest } from '../qualify/keyFacts';
import { cliStoreRoots } from '../storeLayout';
import type { ControlContent, InstanceRef, VersionKey } from '../contracts';

// The design these tests realise, end to end on the real stores in a temporary folder: Codex's binding ruling Q1
// (while External is selected no managed root process starts, pinned, recovery and reload starts included; running
// processes keep their version; choosing managed Codex again needs no download and no new click), Q4 (any surviving
// suspension refuses every managed start; new sessions use the external program), and the immutable-instance rule
// (after a Reset and a new set-up holding byte-identical files at a new path, a session pinned to the old instance
// starts nothing, and a new session starts from the new instance under its own pin).

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temps: string[] = [];
let hasher: ClosureHasher;
beforeAll(() => { hasher = new ClosureHasher(); });
afterEach(() => { for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const FILES: Record<string, string> = {
  'bin/codex.exe': 'MZ codex program',
  'codex-resources/voice/bin/vcruntime140.dll': 'MZ crt',
  'codex-path/rg.exe': 'MZ ripgrep',
  'codex-package.json': '{"layoutVersion":1,"entrypoint":"bin/codex.exe"}',
};

function entry(version = '0.164.0'): PolicyEntry {
  const files = Object.entries(FILES).map(([file, content]) => ({
    path: file, size: Buffer.byteLength(content), sha256: sha(content), pe: content.startsWith('MZ'),
    signer: file.endsWith('rg.exe') ? 'unsigned' as const : file.endsWith('.dll') ? 'microsoft-crt' as const : content.startsWith('MZ') ? 'openai' as const : 'none' as const,
  }));
  return {
    id: `codex-cli/${version}/win32-x64/codex-package`, provider: 'codex-cli', version, versionOutput: `codex-cli ${version}`,
    os: 'win32', arch: 'x64', status: 'qualified',
    managed: {
      artifact: { kind: 'tar.gz', name: 'codex-package.tar.gz', size: 1000, sha256: sha(`artifact ${version}`), urls: [`https://github.com/openai/codex/releases/download/rust-v${version}/codex-package.tar.gz`], redirectHosts: ['release-assets.githubusercontent.com'] },
      layout: { entrypoint: 'bin/codex.exe', unpackedBytes: files.reduce((sum, file) => sum + file.size, 0), dirs: ['bin', 'codex-resources', 'codex-resources/voice', 'codex-resources/voice/bin', 'codex-path'], ignoredEntries: [], files },
    },
    gates: {}, canaries: CLI_REQUIRED_CANARIES['codex-cli'].map((id) => ({ id, result: 'pass' as const, evidenceRef: 'r', ranAt: 't', model: 'm' })),
    selfUpdateReview: { sourceRef: 'tag', finding: 'none' }, qualifiedAt: 'today', qualificationRecord: 'record', leafThumbprints: [],
  };
}

function policyWith(entries: PolicyEntry[]): ValidatedCliCompatibilityPolicy {
  const loaded = loadCliCompatibilityPolicy({ ...structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy, entries });
  if (!loaded.ok) throw new Error(loaded.problems.join('; '));
  return loaded.policy;
}

interface World {
  root: string;
  policy: ValidatedCliCompatibilityPolicy;
  launcher: ManagedLauncher;
  newer: PolicyEntry;
  store: ManagedCodexStore;
  control: ReturnType<typeof createControlStore>;
  instances: ReturnType<typeof createInstanceStore>;
  resolver: CliRuntimeResolver;
  pins: Map<string, unknown>;
  spawns: Array<{ executable: string; managed: boolean }>;
  external: string;
  entry: PolicyEntry;
  key: VersionKey;
  digest: string;
}

/** One window on the store; a second call on the same root is another window, or the same one after a reload. */
interface WindowOptions {
  storeRefusal?: () => string | undefined;
  ready?: Promise<void>;
  /** This host's process as the launcher names it; its creation time may become known later. */
  identity?: { pid: number; creation: string };
  savePin?: (id: string, pin: SessionRuntimePin) => Promise<void>;
}

function window(root: string, external: string, pins = new Map<string, unknown>(), spawns: World['spawns'] = [], options: WindowOptions = {}): World {
  const theEntry = entry();
  const newer = entry('0.165.0');
  const policy = policyWith([theEntry, newer]);
  const roots = cliStoreRoots(root);
  const instances = createInstanceStore(roots, { processCreations: async (pids) => new Map(pids.map((pid) => [pid, '2026-10-21T00:00:00.0000000Z'])) });
  const control = createControlStore({
    root,
    admissionState: (storeId) => { const open = instances.open(storeId); return open.ok ? instances.admissionState(open.ref) : 'missing'; },
  });
  const store = new ManagedCodexStore({ control, instances });
  const host = { os: 'win32', arch: 'x64' } as const;
  const launcher = new ManagedLauncher({
    control,
    instances,
    entryForKey: (key) => [theEntry, newer].find((candidate) => cliStoreVersionKey(candidate) === key),
    launchableKey: (record, instance) => {
      const decided = launchableKey({
        suspension: { present: false },
        control: { kind: 'readable', authority: 'ok', floor: record.reductionEpoch, snapshot: { generation: record.generation, digest: '', record } },
        instance: { kind: 'readable', snapshot: { generation: instance.generation, digest: '', record: instance } },
        policy, host,
      });
      return decided.launchable ? { key: decided.version.key, closureDigest: decided.closureDigest } : undefined;
    },
    hasher,
    host: () => ({ ...(options.identity ?? { pid: process.pid, creation: '2026-10-21T00:00:00.0000000Z' }) }),
    ...(options.storeRefusal ? { storeRefusal: options.storeRefusal } : {}),
    ...(options.ready ? { ready: options.ready } : {}),
  });
  const resolver = new CliRuntimeResolver({
    platform: process.platform,
    host: { os: process.platform, arch: process.arch },
    policy,
    hasher,
    pins: { load: (id) => pins.get(id), save: options.savePin ?? (async (id, pin) => { pins.set(id, pin); }) },
    externalProgram: () => ({ executable: external, shell: false }),
    physical: (file) => realpathSync.native(file),
    storeRoot: root,
    externalPathInStore: () => false,
    managed: { status: () => store.status(), launcher },
    adoption: { find: () => ({ version: '0.163.0' }), adopt: async () => ({ ok: true, version: '0.163.0' }) },
  });
  return { root, policy, launcher, newer, store, control, instances, resolver, pins, spawns, external, entry: theEntry, key: cliStoreVersionKey(theEntry), digest: layoutClosureDigest(theEntry.managed!.layout) };
}

function setUp(options: WindowOptions = {}): World {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'unode-managed-')));
  temps.push(root);
  const externalFolder = path.join(root, '..', `${path.basename(root)}-external`);
  mkdirSync(externalFolder);
  temps.push(externalFolder);
  const external = path.join(externalFolder, 'codex.exe');
  writeFileSync(external, 'an external codex');
  return window(root, external, new Map(), [], options);
}

const spawn = (world: World): CliSpawn => (program) => {
  world.spawns.push({ executable: program.executable, managed: program.managed !== undefined });
  return Object.assign(new EventEmitter(), { pid: 4000 + world.spawns.length }) as never;
};

const content = (record: ControlContent): ControlContent => record;

/** A version the pipeline promoted, which the person allowed and whose check passed, active for new sessions. */
async function readyVersion(world: World, theEntry: PolicyEntry = world.entry): Promise<InstanceRef> {
  const key = cliStoreVersionKey(theEntry);
  const view = world.control.read();
  if (view.kind !== 'readable' || !view.snapshot.record.enrolledStoreId) throw new Error('not enrolled');
  const open = world.instances.open(view.snapshot.record.enrolledStoreId);
  if (!open.ok) throw new Error(open.detail);
  const ref = open.ref;
  const folder = world.instances.versionFolder(ref, key);
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(folder, ...file.split('/'))), { recursive: true });
    writeFileSync(path.join(folder, ...file.split('/')), text);
  }
  const published = await world.instances.publish(ref, {
    label: 'seed',
    apply: (current) => ({
      versions: {
        ...current.versions,
        [key]: {
          key, provider: 'codex-cli', version: theEntry.version, os: 'win32', arch: 'x64', policyVersion: 'test', policyEntryId: theEntry.id,
          artifactSha256: theEntry.managed!.artifact.sha256, taskToken: 'a'.repeat(32), promotedAt: '2026-10-21T00:00:00.000Z',
          verification: { files: 4, bytes: 10, signed: { openai: 1, microsoftCrt: 1 }, unsigned: ['codex-path/rg.exe'], revocation: 'confirmed-online' },
        },
      },
      probes: { ...current.probes, [key]: { key, closureDigest: world.digest, versionOutput: theEntry.versionOutput, startedAt: '2026-10-21T00:00:00.000Z', durationMs: 400 } },
      stagingIntents: current.stagingIntents,
      schedule: current.schedule,
    }),
  });
  if (published.outcome !== 'published') throw new Error(`seed ${published.outcome}`);
  const consented = await world.control.publish({
    label: 'allow and activate', kind: 'increase',
    apply: (current) => content({
      enrolledStoreId: current.enrolledStoreId, selection: current.selection, enrollment: current.enrollment, scheduler: current.scheduler,
      activationConsents: [...current.activationConsents, { storeId: ref.storeId, key, closureDigest: world.digest, decidedAt: '2026-10-21T00:00:01.000Z' }],
      active: current.active ?? { storeId: ref.storeId, key }, lastKnownGood: current.lastKnownGood, disabled: current.disabled,
      retiredInstances: current.retiredInstances, decidedAt: '2026-10-21T00:00:01.000Z',
    }),
  });
  if (consented.outcome !== 'published') throw new Error(`consent ${consented.outcome}`);
  return ref;
}

async function enrolled(world: World): Promise<InstanceRef> {
  const result = await world.store.enrol({ consentedHosts: ['github.com', 'release-assets.githubusercontent.com', 'releases.openai.com'], autoMode: false });
  if (!result.ok) throw new Error(result.reason);
  return readyVersion(world);
}

describe('managed Codex end to end on the real stores (v0.9.97)', () => {
  it('Q1: under (A, external) a running A process keeps its version, and no pinned, recovery or reload start of it runs; managed again reuses A without a download or a click', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const first = await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    expect(first.mode).toBe('managed');
    expect(world.pins.get('s1')).toEqual({ pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeId: ref.storeId, storeKey: world.key, closureDigest: world.digest });
    expect(world.spawns).toEqual([{ executable: path.join(world.instances.versionFolder(ref, world.key), 'bin', 'codex.exe'), managed: true }]);

    const before = world.control.read();
    expect((await world.store.useExternal()).ok).toBe(true);
    // The running process holds its lease; nothing was retired or removed.
    expect(await world.instances.leaseLiveness(ref, world.key)).toBe('alive');
    expect(world.instances.admissionState(ref)).toBe('open');

    // An App Server restart, the restart after an exit, a start for a message: every reuse start is refused.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(world))).rejects.toMatchObject({ reason: 'managed-not-selected' });
    }
    // The first start after a window reload: another resolver reading the same saved pin.
    const reloaded = window(world.root, world.external, world.pins, world.spawns);
    await expect(reloaded.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(reloaded))).rejects.toMatchObject({ reason: 'managed-not-selected' });
    expect(world.spawns).toHaveLength(1);
    // A new session started by the person uses the external program.
    const other = await world.resolver.start({ provider: 'codex-cli', sessionId: 's2', pin: 'take' }, spawn(world));
    expect(other.mode).toBe('external');

    // Managed again: the same instance, its consent and version, no download and no new click.
    expect((await world.store.useManaged()).ok).toBe(true);
    const after = world.control.read();
    if (before.kind !== 'readable' || after.kind !== 'readable') throw new Error('unreadable');
    expect(after.snapshot.record.enrolledStoreId).toBe(ref.storeId);
    expect(after.snapshot.record.activationConsents).toEqual(before.snapshot.record.activationConsents);
    expect(Object.keys(world.instances.read(ref).kind === 'readable' ? (world.instances.read(ref) as any).snapshot.record.versions : {})).toEqual([world.key]);
    const again = await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(world));
    expect(again.mode).toBe('managed');
    expect(world.spawns.filter((item) => item.managed)).toHaveLength(2);
  }, 60_000);

  // v0.9.97 field preparation (USAGE "Use external CLI makes new sessions use the Codex CLI you chose"): a working
  // managed Codex offered no way back but Reset. The card now offers Use external CLI, and the click reduces.
  it('a working managed Codex offers Use external CLI on its card; the click makes new sessions external and keeps the store', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const first = await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    expect(first.mode).toBe('managed');
    const asked: string[] = [];
    const actions = new ManagedCodexActions({
      store: world.store, control: world.control, instances: world.instances, policy: world.policy,
      storeRefusal: () => undefined, ready: Promise.resolve(),
    } as unknown as ManagedCodexHost, {
      ask: async (title: string) => { asked.push(title); return 'Use external CLI'; }, inform: () => undefined, refresh: () => undefined,
      forgetAdoptions: () => 0, storeFolder: world.root, formatTime: (iso) => iso,
    });
    const offered = actions.card().actions.map((item) => item.action);
    expect(offered).toContain('use-external');
    expect(offered).toContain('reset');
    await actions.act('use-external', undefined);
    expect(asked).toEqual(['Use the external Codex CLI for new sessions?']);
    const view = world.control.read();
    if (view.kind !== 'readable') throw new Error('unreadable');
    expect(view.snapshot.record).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'external', retiredInstances: [] });
    expect(world.instances.admissionState(ref)).toBe('open');
    const next = await world.resolver.start({ provider: 'codex-cli', sessionId: 's2', pin: 'take' }, spawn(world));
    expect(next.mode).toBe('external');
  }, 60_000);

  it('Q4: a suspension, readable or not, refuses every managed start; new sessions use the external program', async () => {
    const world = setUp();
    await enrolled(world);
    await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    for (const body of ['{"v":1,"reason":"r","controlState":"ok","decidedAt":"t"}', '', '{ torn']) {
      writeFileSync(cliStoreRoots(world.root).suspension, body);
      await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(world))).rejects.toMatchObject({ reason: 'suspended' });
      const fresh = await world.resolver.start({ provider: 'codex-cli', sessionId: `n${body.length}`, pin: 'take' }, spawn(world));
      expect(fresh.mode).toBe('external');
    }
    expect(world.spawns.filter((item) => item.managed)).toHaveLength(1);
  }, 60_000);

  it('after a Reset and a new set-up with byte-identical files, a session pinned to the old instance starts nothing; a new session starts from the new one', async () => {
    const world = setUp();
    const a = await enrolled(world);
    await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    // The start released A's admission gate once its process had spawned, so the Reset can close it.
    expect((await world.store.reset()).ok).toBe(true);
    expect(world.instances.admissionState(a)).toBe('closed');
    const b = await enrolled(world);
    expect(b.storeId).not.toBe(a.storeId);
    expect(world.instances.versionFolder(b, world.key)).not.toBe(world.instances.versionFolder(a, world.key));

    await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(world))).rejects.toMatchObject({ reason: 'managed-store-replaced' });
    expect(world.spawns).toHaveLength(1);
    expect(await world.instances.leaseLiveness(b, world.key)).toBe('dead');

    const fresh = await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    expect(fresh.mode).toBe('managed');
    expect((world.pins.get('s1') as SessionRuntimePin & { storeId: string }).storeId).toBe(b.storeId);
    expect(world.spawns.at(-1)?.executable).toBe(path.join(world.instances.versionFolder(b, world.key), 'bin', 'codex.exe'));
  }, 60_000);

  it('a version folder whose files changed is refused and recorded bad; nothing else is started', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    writeFileSync(path.join(world.instances.versionFolder(ref, world.key), 'codex-path', 'rg.exe'), 'MZ replaced');
    await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world))).rejects.toMatchObject({ reason: 'version-files-changed' });
    expect(world.spawns).toEqual([]);
    const view = world.control.read();
    expect(view.kind === 'readable' && view.snapshot.record.disabled.map((item) => item.reason)).toEqual(['local-bad']);
  }, 60_000);

  it('decides at the admission, with the gate held: a change published after the first look and before the gate refuses the start', async () => {
    const world = setUp();
    await enrolled(world);
    const switched = world.resolver.start({
      provider: 'codex-cli', sessionId: 's1', pin: 'take',
      // The consent waits for the person; meanwhile another window chooses the external CLI.
      beforeStart: async () => { expect((await world.store.useExternal()).ok).toBe(true); },
    }, spawn(world));
    await expect(switched).rejects.toMatchObject({ reason: 'managed-not-selected' });
    expect(world.spawns).toEqual([]);
  }, 60_000);

  it('refuses, and starts nothing, when the version chosen at the admission is not the one the consent was asked for', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    await readyVersion(world, world.newer);
    const newerKey = cliStoreVersionKey(world.newer);
    const moved = world.resolver.start({
      provider: 'codex-cli', sessionId: 's1', pin: 'take',
      beforeStart: async () => {
        const published = await world.control.publish({ label: 'activate newer', kind: 'increase', apply: (current) => ({ ...current, active: { storeId: ref.storeId, key: newerKey } }) });
        expect(published.outcome).toBe('published');
      },
    }, spawn(world));
    await expect(moved).rejects.toMatchObject({ reason: 'no-launchable-version', message: expect.stringMatching(/changed while it was being started/) });
    expect(world.spawns).toEqual([]);
  }, 60_000);

  it('refuses a pinned start of a version recorded bad since, and a start while a folder an agent may use reaches the store', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    await world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(world));
    const marked = await world.control.publish({ label: 'mark bad', kind: 'reduction', apply: (current) => ({ ...current, disabled: [{ storeId: ref.storeId, key: world.key, reason: 'local-bad', at: '2026-10-21T00:00:02.000Z' }] }) });
    expect(marked.outcome).toBe('published');
    await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'reuse' }, spawn(world))).rejects.toMatchObject({ reason: 'managed-version-gone' });
    expect(world.spawns).toHaveLength(1);

    const reached = setUp({ storeRefusal: () => 'A folder an agent may use reaches the store.' });
    await enrolled(reached);
    await expect(reached.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(reached))).rejects.toMatchObject({ reason: 'store-refused' });
    expect(reached.spawns).toEqual([]);
  }, 60_000);

  it('starts nothing when the pin cannot be saved, and waits until this host knows its own process before any lease', async () => {
    const unsaved = setUp({ savePin: async () => { throw new Error('disk full'); } });
    await enrolled(unsaved);
    await expect(unsaved.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(unsaved))).rejects.toMatchObject({ reason: 'pin-save-failed' });
    expect(unsaved.spawns).toEqual([]);

    // The lease names its holder by creation time: one written with a pending holder could never be proved dead.
    const identity = { pid: process.pid, creation: 'pending' };
    let known!: () => void;
    const waiting = setUp({ identity, ready: new Promise<void>((resolve) => { known = () => { identity.creation = '2026-10-21T00:00:00.0000000Z'; resolve(); }; }) });
    const ref = await enrolled(waiting);
    const started = waiting.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(waiting));
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
    expect(waiting.spawns).toEqual([]);
    known();
    expect((await started).mode).toBe('managed');
    expect(waiting.spawns).toHaveLength(1);
    const leases = path.join(cliStoreRoots(waiting.root).instances, ref.storeId, 'leases', waiting.key);
    const holders = readdirSync(leases).map((name) => JSON.parse(readFileSync(path.join(leases, name), 'utf8')).holder.creation);
    expect(holders).toEqual(['2026-10-21T00:00:00.0000000Z']);
  }, 60_000);
});

describe('start-up completes a Reset only on a gate seen closed (v0.9.97, Codex audit of 87092b9 F2)', () => {
  const instanceFolder = (world: World, storeId: string) => path.join(cliStoreRoots(world.root).instances, storeId);
  const record = (world: World) => {
    const view = world.control.read();
    if (view.kind !== 'readable') throw new Error('unreadable');
    return view.snapshot.record;
  };

  const damage: Record<string, (world: World, ref: InstanceRef) => void | Promise<void>> = {
    'missing': (world, ref) => rmSync(instanceFolder(world, ref.storeId), { recursive: true, force: true }),
    'identity-mismatch': async (world, ref) => {
      const other = setUp();
      const theirs = await other.instances.create();
      if (!theirs.ok) throw new Error(theirs.detail);
      writeFileSync(path.join(instanceFolder(world, ref.storeId), 'identity.bin'), readFileSync(path.join(instanceFolder(other, theirs.ref.storeId), 'identity.bin')));
    },
    'identity-unreadable': (world, ref) => writeFileSync(path.join(instanceFolder(world, ref.storeId), 'identity.bin'), 'torn'),
    'gate damaged': (world, ref) => writeFileSync(path.join(instanceFolder(world, ref.storeId), 'admission', 'open', 'guard.bin'), 'torn'),
  };

  it.each(Object.keys(damage))('an instance that is %s stays enrolled, is not Reset at start-up or by the person, and starts nothing', async (name) => {
    const world = setUp();
    const ref = await enrolled(world);
    await damage[name]!(world, ref);
    const reloaded = window(world.root, world.external, world.pins, world.spawns);
    expect(reloaded.instances.open(ref.storeId).ok).toBe(false);
    expect(await reloaded.store.completePendingReset()).toBeUndefined();
    expect(record(reloaded)).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'managed', retiredInstances: [] });
    expect(reloaded.store.status().instance).toMatchObject({ storeId: ref.storeId, open: { ok: false } });
    await expect(reloaded.resolver.start({ provider: 'codex-cli', sessionId: 's1', pin: 'take' }, spawn(reloaded))).rejects.toBeDefined();
    expect(world.spawns).toEqual([]);
    // The card offers Use external CLI and no Reset, which would have to close the gate first.
    const actions = new ManagedCodexActions({
      store: reloaded.store, control: reloaded.control, instances: reloaded.instances, policy: reloaded.policy,
      storeRefusal: () => undefined, ready: Promise.resolve(),
    } as unknown as ManagedCodexHost, {
      ask: async () => undefined, inform: () => undefined, refresh: () => undefined, forgetAdoptions: () => 0,
      storeFolder: reloaded.root, formatTime: (iso) => iso,
    });
    const offered = actions.card().actions.map((item) => item.action);
    expect(offered).toContain('use-external');
    expect(offered).not.toContain('reset');
    // Use external CLI goes through; a Reset that cannot close the gate is refused and changes nothing.
    expect((await reloaded.store.useExternal()).ok).toBe(true);
    expect(record(reloaded)).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'external' });
    expect(await reloaded.store.reset()).toMatchObject({ ok: false, reason: expect.stringContaining('cannot reset it safely') });
    expect(record(reloaded)).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'external', retiredInstances: [] });
  }, 60_000);

  it('a Reset in a window that cannot open the instance starts no race with a window that holds its gate: it is refused, and that start is not a start after a Reset', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    // Window B: past its final control read, holding the gate, about to save its pin and spawn.
    const other = window(world.root, world.external, world.pins, world.spawns);
    let paused!: () => void;
    let reached!: () => void;
    const atPin = new Promise<void>((resolve) => { reached = resolve; });
    const proceed = new Promise<void>((resolve) => { paused = resolve; });
    const otherStart = other.launcher.launch({
      kind: 'new',
      savePin: async () => { reached(); await proceed; },
    }, (plan) => { world.spawns.push({ executable: plan.executable, managed: true }); return Object.assign(new EventEmitter(), { pid: 8001 }) as never; });
    await atPin;
    // Window A cannot open the same instance.
    const blind = window(world.root, world.external, world.pins, world.spawns);
    blind.instances.open = () => ({ ok: false, reason: 'identity-unreadable', detail: 'the identity could not be read here' });
    const before = world.control.read();
    expect(await blind.store.reset()).toMatchObject({ ok: false, reason: expect.stringContaining('cannot reset it safely') });
    expect(world.control.read()).toEqual(before);
    paused();
    expect(await otherStart).toMatchObject({ ok: true });
    // The start that went ahead is a start of an instance that is still enrolled and selected.
    expect(record(world)).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'managed', retiredInstances: [] });
    expect(world.spawns).toHaveLength(1);
  }, 60_000);

  it('a gate seen closed is a Reset interrupted after the close: start-up completes it and never opens the gate again', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    expect((await world.instances.closeAdmission(ref)).ok).toBe(true);
    const reloaded = window(world.root, world.external, world.pins, world.spawns);
    expect(await reloaded.store.completePendingReset()).toMatchObject({ ok: true, changed: true });
    expect(record(reloaded)).toMatchObject({ enrolledStoreId: null, selection: 'external', retiredInstances: [{ storeId: ref.storeId }] });
    expect(reloaded.instances.admissionState(ref)).toBe('closed');
  }, 60_000);

  it('an open gate is no Reset at start-up', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    expect(await world.store.completePendingReset()).toBeUndefined();
    expect(record(world)).toMatchObject({ enrolledStoreId: ref.storeId, selection: 'managed' });
  }, 60_000);
});

describe('a managed model-list load gives up its version only after a confirmed stop (v0.9.97, Codex audit of 87092b9 F6)', () => {
  const leaseFiles = (world: World, ref: InstanceRef) => {
    const folder = path.join(cliStoreRoots(world.root).instances, ref.storeId, 'leases', world.key);
    try { return readdirSync(folder).length; } catch { return 0; }
  };
  const child = (pid: number) => Object.assign(new EventEmitter(), { pid }) as never;
  const outcomes = {
    confirmed: { status: 'confirmed-stopped' },
    'already ended': { status: 'already-stopped' },
    unknown: { status: 'unknown', detail: 'taskkill timed out' },
  } as const;

  it.each([
    ['confirmed', 'loads', 0],
    ['confirmed', 'fails after its start', 0],
    ['already ended', 'loads', 1],
    ['unknown', 'loads', 1],
    ['unknown', 'fails after its start', 1],
  ] as const)('a %s stop of a use that %s leaves %i lease', async (stop, ending, kept) => {
    const world = setUp();
    const ref = await enrolled(world);
    const logged: string[] = [];
    const run = runTransientCliUse((spawnIt) => world.resolver.startTransient({ provider: 'codex-cli' }, spawnIt), async (program) => {
      world.spawns.push({ executable: program.executable, managed: true });
      program.spawned(child(5001));
      await new Promise((resolve) => setImmediate(resolve));
      expect(leaseFiles(world, ref)).toBe(1);
      program.stopped(outcomes[stop]);
      if (ending === 'fails after its start') throw new Error('no initialize response');
      return ['gpt-5.5'];
    }, (line) => logged.push(line));
    if (ending === 'loads') expect((await run).value).toEqual(['gpt-5.5']);
    else await expect(run).rejects.toThrow('no initialize response');
    expect(world.spawns).toEqual([{ executable: path.join(world.instances.versionFolder(ref, world.key), 'bin', 'codex.exe'), managed: true }]);
    expect(leaseFiles(world, ref)).toBe(kept);
    expect(logged).toHaveLength(kept);
  }, 60_000);

  it('a use that fails before its process exists starts nothing and holds no lease', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    await expect(runTransientCliUse((spawnIt) => world.resolver.startTransient({ provider: 'codex-cli' }, spawnIt), async () => {
      throw new Error('the window closed');
    }, () => undefined)).rejects.toMatchObject({ reason: 'spawn-failed' });
    expect(leaseFiles(world, ref)).toBe(0);
  }, 60_000);
});

describe('a managed start that fails at the program\'s own level is checked once (v0.9.97, Codex audit of 87092b9 F3)', () => {
  /** The checks of the window, on the real stores; the check's program run is the test's. */
  function checks(world: World, probe: () => Promise<{ result: 'pass' | 'fail'; detail?: string }>) {
    const runs: string[] = [];
    let token = 0;
    const deps: QualificationDeps = {
      control: world.control,
      instance: world.instances,
      policy: world.policy,
      host: { os: 'win32', arch: 'x64' },
      hostProcess: { pid: process.pid, creation: '2026-10-21T00:00:00.0000000Z' },
      checkClosure: (folder, layout) => verifyManagedVersionFolder(folder, layout, hasher),
      runManagedProbe: async (executable, _work, hooks, entry) => {
        runs.push(executable);
        hooks.onSpawned(6001);
        const result = await probe();
        return result.result === 'pass' ? { result: 'pass', versionOutput: entry.versionOutput, durationMs: 300 } : { result: 'fail', detail: result.detail ?? 'it failed', durationMs: 300 };
      },
      now: () => '2026-10-21T00:00:02.000Z',
      newToken: () => (++token).toString(16).padStart(32, '0'),
    };
    return { failures: new AgentStartFailureChecks(deps), runs };
  }
  const record = (world: World) => {
    const view = world.control.read();
    if (view.kind !== 'readable') throw new Error('unreadable');
    return view.snapshot.record;
  };
  const failure = { kind: 'no-initialize-response', detail: 'Codex App Server request timed out: initialize' } as const;

  it('a check that fails too marks the version local-bad, and no new session starts it', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const { failures, runs } = checks(world, async () => ({ result: 'fail', detail: 'no initialize response' }));
    expect(await failures.check(ref.storeId, world.key, failure)).toMatchObject({ outcome: 'local-bad', recorded: true });
    expect(runs).toHaveLength(1);
    expect(record(world).disabled).toEqual([expect.objectContaining({ storeId: ref.storeId, key: world.key, reason: 'local-bad' })]);
    await expect(world.resolver.start({ provider: 'codex-cli', sessionId: 's2', pin: 'take' }, spawn(world))).rejects.toBeDefined();
    expect(world.spawns).toEqual([]);
  }, 60_000);

  it('a check that passes makes the failure the environment\'s: nothing is marked, and the version still starts', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const { failures, runs } = checks(world, async () => ({ result: 'pass' }));
    expect(await failures.check(ref.storeId, world.key, failure)).toMatchObject({ outcome: 'environmental', checked: true });
    expect(runs).toHaveLength(1);
    expect(record(world).disabled).toEqual([]);
    expect((await world.resolver.start({ provider: 'codex-cli', sessionId: 's2', pin: 'take' }, spawn(world))).mode).toBe('managed');
  }, 60_000);

  it('runs no check when External was chosen before it, and marks nothing', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const { failures, runs } = checks(world, async () => ({ result: 'fail' }));
    expect((await world.store.useExternal()).ok).toBe(true);
    expect(await failures.check(ref.storeId, world.key, failure)).toMatchObject({ outcome: 'not-checked' });
    expect(runs).toEqual([]);
    expect(record(world).disabled).toEqual([]);
  }, 60_000);

  it('answers failures that arrive while a check runs with that check; an environmental failure runs none', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    let finish: (() => void) | undefined;
    const { failures, runs } = checks(world, () => new Promise((resolve) => { finish = () => resolve({ result: 'fail' }); }));
    const first = failures.check(ref.storeId, world.key, failure);
    const second = failures.check(ref.storeId, world.key, { kind: 'exit-before-ready', detail: 'exited' });
    for (let index = 0; index < 100 && !finish; index++) await new Promise((resolve) => setTimeout(resolve, 10));
    finish!();
    expect(await second).toEqual(await first);
    expect(runs).toHaveLength(1);
    expect(await failures.check(ref.storeId, world.key, { kind: 'login', detail: 'not logged in' })).toMatchObject({ outcome: 'environmental', checked: false });
    expect(runs).toHaveLength(1);
  }, 60_000);

  /** One agent start through the window's launch wiring, with the agent's preflight and spawn. */
  function agentStart(world: World, preflight: () => Promise<string | undefined>) {
    const reported: Array<{ plan: ManagedLaunchPlan; failure: CodexProgramFailure }> = [];
    const start: CodexProgramStart = {
      pin: 'take',
      onPending: () => undefined,
      beforeStart: async () => undefined,
      preflight,
      spawn: (executable) => {
        world.spawns.push({ executable, managed: true });
        return Object.assign(new EventEmitter(), { pid: 7001 }) as never;
      },
    };
    const launched = launchCodexProgram({ resolver: world.resolver, managedStartFailed: (plan, failed) => reported.push({ plan, failure: failed }) }, 's1', start);
    return { launched, reported };
  }

  it.each([
    ['another version', async (): Promise<string | undefined> => '0.163.9', 'version-mismatch'],
    ['a version check that exits', async (): Promise<string | undefined> => { throw new CodexPreflightError('exited', 'Codex CLI version check failed (exit 3)'); }, 'exit-before-ready'],
    ['a version check that cannot run', async (): Promise<string | undefined> => { throw new CodexPreflightError('did-not-run', 'spawn EPERM'); }, 'spawn-error'],
  ] as const)('reports %s as %s and starts no App Server', async (_name, preflight, kind) => {
    const world = setUp();
    const ref = await enrolled(world);
    const { launched, reported } = agentStart(world, preflight);
    await expect(launched).rejects.toBeDefined();
    expect(reported).toEqual([{ plan: expect.objectContaining({ storeId: ref.storeId, key: world.key }), failure: expect.objectContaining({ kind }) }]);
    expect(world.spawns).toEqual([]);
  }, 60_000);

  it('reports nothing when the login is missing, and hands the started program a report for App Server\'s own failures', async () => {
    const world = setUp();
    const ref = await enrolled(world);
    const missing = agentStart(world, async () => { throw new CodexPreflightError('login', 'Codex CLI is not logged in.'); });
    await expect(missing.launched).rejects.toBeDefined();
    expect(missing.reported).toEqual([]);

    const started = agentStart(world, async () => world.entry.version);
    const launch = await started.launched;
    expect(world.spawns).toHaveLength(1);
    launch.startFailed?.({ kind: 'malformed-json-rpc', detail: 'Invalid request' });
    expect(started.reported).toEqual([{ plan: expect.objectContaining({ storeId: ref.storeId, key: world.key }), failure: { kind: 'malformed-json-rpc', detail: 'Invalid request' } }]);
  }, 60_000);
});
