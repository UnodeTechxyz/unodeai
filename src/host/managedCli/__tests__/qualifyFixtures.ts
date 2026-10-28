/*
 * Fixtures for the qualification tests: a validated policy with Codex entries, the facts a download records, an
 * enrolled world, and the three injected dependencies (the probe program, the closure check and the re-download),
 * each recording its calls. No program is ever started and nothing is downloaded.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  CLI_COMPATIBILITY_POLICY,
  CLI_REQUIRED_CANARIES,
  cliStoreVersionKey,
  loadCliCompatibilityPolicy,
  type CliCompatibilityPolicy,
  type PolicyEntry,
  type ValidatedCliCompatibilityPolicy,
} from '../../../backend/cliCompatibilityPolicy';
import type { ManagedFolderCheck } from '../../../backend/cliClosure';
import type { DisabledEntry, InstanceRef, ManagedVersionRef, PromotedVersion, WorkFolder } from '../contracts';
import type { CheckManagedClosure, ManagedProbeResult, RunManagedProbe } from '../qualify/admission';
import { layoutClosureDigest } from '../qualify/keyFacts';
import type { DownloadAndPromote, TryAgainDeps } from '../qualify/tryAgain';
import { FakeWorld } from './fakeStoresQualify';

export const HOST = Object.freeze({ os: 'win32', arch: 'x64' });
export const HOST_PROCESS = Object.freeze({ pid: 1000, creation: '2026-10-21T00:00:00.0000000Z' });
export const CONSENTED_HOSTS = ['releases.openai.com', 'github.com', 'release-assets.githubusercontent.com'];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export interface EntryOptions {
  version: string;
  status?: PolicyEntry['status'];
  statusReason?: string;
  /** Changes the layout (and so its closure digest) without changing the artifact or the key. */
  layoutSalt?: string;
  /** No file without a signature. */
  fullySigned?: boolean;
  urls?: string[];
}

export function codexEntry(options: EntryOptions): PolicyEntry {
  const { version } = options;
  const salt = options.layoutSalt ?? '';
  const files: NonNullable<PolicyEntry['managed']>['layout']['files'] = [
    { path: 'codex-package.json', size: 215, sha256: sha(`codex-package.json ${version}${salt}`), pe: false, signer: 'none' },
    { path: 'bin/codex.exe', size: 1000, sha256: sha(`codex.exe ${version}${salt}`), pe: true, signer: 'openai' },
    { path: 'bin/codex-command-runner.exe', size: 300, sha256: sha(`runner ${version}${salt}`), pe: true, signer: 'openai' },
    { path: 'codex-resources/voice/bin/vcruntime140.dll', size: 120, sha256: sha(`vcruntime140.dll ${version}${salt}`), pe: true, signer: 'microsoft-crt' },
  ];
  if (!options.fullySigned) files.push({ path: 'codex-path/rg.exe', size: 400, sha256: sha(`rg.exe ${version}${salt}`), pe: true, signer: 'unsigned' });
  return {
    id: `codex-cli/${version}/win32-x64/codex-package`,
    provider: 'codex-cli',
    version,
    versionOutput: `codex-cli ${version}`,
    os: 'win32',
    arch: 'x64',
    status: options.status ?? 'qualified',
    ...(options.status && options.status !== 'qualified' ? { statusReason: options.statusReason ?? 'withdrawn' } : {}),
    managed: {
      artifact: {
        kind: 'tar.gz',
        name: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
        size: 162_230_206,
        sha256: sha(`artifact ${version}`),
        urls: options.urls ?? [
          `https://releases.openai.com/codex/releases/${version}/codex-package-x86_64-pc-windows-msvc.tar.gz`,
          `https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-x86_64-pc-windows-msvc.tar.gz`,
        ],
        redirectHosts: ['release-assets.githubusercontent.com'],
      },
      layout: {
        entrypoint: 'bin/codex.exe',
        unpackedBytes: 10_000,
        dirs: ['bin', 'codex-path', 'codex-resources', 'codex-resources/voice', 'codex-resources/voice/bin'],
        ignoredEntries: [],
        files,
      },
    },
    gates: { fileChangeApproval: true },
    canaries: CLI_REQUIRED_CANARIES['codex-cli'].map((id) => ({ id, result: 'pass' as const, evidenceRef: `record#${id}`, ranAt: '2026-10-21T00:00:00Z', model: 'test-model' })),
    selfUpdateReview: { sourceRef: `rust-v${version}`, finding: 'app-server has no update path' },
    qualifiedAt: '2026-10-21',
    qualificationRecord: `docs/release-record#codex-${version}`,
    leafThumbprints: ['0123456789ABCDEF0123456789ABCDEF01234567'],
  };
}

export function testPolicy(entries: PolicyEntry[]): ValidatedCliCompatibilityPolicy {
  const policy = structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy;
  policy.policyVersion = '0.9.97-test';
  policy.entries = entries;
  const loaded = loadCliCompatibilityPolicy(policy);
  if (!loaded.ok) throw new Error(`fixture policy refused: ${loaded.problems.join('; ')}`);
  return loaded.policy;
}

export const keyOf = (entry: PolicyEntry) => cliStoreVersionKey(entry);
export const digestOf = (entry: PolicyEntry) => layoutClosureDigest((entry.managed as NonNullable<PolicyEntry['managed']>).layout);

/** The facts V1–V4 record for an entry's download, consistent with the entry. */
export function promotedFacts(entry: PolicyEntry, overrides: Partial<PromotedVersion['verification']> = {}): PromotedVersion {
  const files = (entry.managed as NonNullable<PolicyEntry['managed']>).layout.files;
  return {
    key: keyOf(entry),
    provider: 'codex-cli',
    version: entry.version,
    os: 'win32',
    arch: 'x64',
    policyVersion: '0.9.97-test',
    policyEntryId: entry.id,
    artifactSha256: (entry.managed as NonNullable<PolicyEntry['managed']>).artifact.sha256,
    taskToken: 'b'.repeat(32),
    promotedAt: '2026-10-21T00:00:00.000Z',
    verification: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      signed: { openai: files.filter((file) => file.signer === 'openai').length, microsoftCrt: files.filter((file) => file.signer === 'microsoft-crt').length },
      unsigned: files.filter((file) => file.signer === 'unsigned').map((file) => file.path),
      revocation: 'confirmed-online',
      ...overrides,
    },
  };
}

export interface Enrolled {
  world: FakeWorld;
  ref: InstanceRef;
}

/** A world with one enrolled instance: `(A, managed)` unless `selection` says otherwise. */
export function enrolledWorld(options: { selection?: 'managed' | 'external'; autoMode?: boolean } = {}): Enrolled {
  const world = new FakeWorld();
  const ref = world.addInstance();
  world.writeControl('increase', (content) => content);
  world.writeControl('increase', (content) => ({
    ...content,
    enrolledStoreId: ref.storeId,
    selection: 'managed',
    enrollment: { epoch: 0, consentedHosts: [...CONSENTED_HOSTS], decidedAt: world.now() },
    scheduler: { epoch: 0, autoMode: options.autoMode ?? false },
  }));
  if (options.selection === 'external') world.writeControl('reduction', (content) => ({ ...content, selection: 'external' }));
  return { world, ref };
}

export interface SeedOptions {
  /** The closure the user's OK covers; `true` for the entry's own. */
  consent?: boolean | string;
  probe?: boolean;
  disabled?: Array<Pick<DisabledEntry, 'reason'> & Partial<DisabledEntry>>;
  active?: boolean;
  lastKnownGood?: boolean;
  /** The closure digest the folder's files give now; the entry's own by default. */
  folderDigest?: string;
  /** No folder and no facts: only control names the version. */
  noFacts?: boolean;
}

/** A version the pipeline has promoted (folder and facts), with optional control decisions about it. */
export function seedVersion(enrolled: Enrolled, entry: PolicyEntry, options: SeedOptions = {}): ManagedVersionRef {
  const { world, ref } = enrolled;
  const key = keyOf(entry);
  const version = { storeId: ref.storeId, key };
  if (!options.noFacts) {
    const state = world.instanceState(ref);
    state.folders.add(key);
    world.folderDigests.set(path.join(state.root, 'versions', key), options.folderDigest ?? digestOf(entry));
    world.writeInstance(ref, (content) => ({
      ...content,
      versions: { ...content.versions, [key]: promotedFacts(entry) },
      probes: options.probe ? { ...content.probes, [key]: { key, closureDigest: digestOf(entry), versionOutput: entry.versionOutput, startedAt: world.now(), durationMs: 400 } } : content.probes,
    }));
  }
  const consent = options.consent === true ? digestOf(entry) : options.consent;
  if (consent || options.active || options.lastKnownGood) {
    world.writeControl('increase', (content) => ({
      ...content,
      activationConsents: consent ? [...content.activationConsents, { ...version, closureDigest: consent, decidedAt: world.now() }] : content.activationConsents,
      active: options.active ? version : content.active,
      lastKnownGood: options.lastKnownGood ? version : content.lastKnownGood,
    }));
  }
  if (options.disabled?.length) {
    world.writeControl('reduction', (content) => ({
      ...content,
      disabled: [...content.disabled, ...(options.disabled ?? []).map((entry) => ({ ...version, at: world.now(), detail: `seeded ${entry.reason}`, ...entry }))],
    }));
  }
  return version;
}

export interface ProbeScriptStep extends Partial<ManagedProbeResult> {
  /** Runs while the probe "runs", after `onSpawned`. */
  during?: () => void | Promise<void>;
  /** The probe throws instead of answering. */
  throws?: Error;
  /** `onSpawned` is not called. */
  noSpawn?: boolean;
}

export interface ProbeSpy {
  run: RunManagedProbe;
  calls: Array<{ executable: string; work: WorkFolder }>;
}

/** The injected probe program. Each call takes the next step; a missing step passes with the version's own output. */
export function scriptedProbe(world: FakeWorld, versionOutput: (executable: string) => string, steps: ProbeScriptStep[] = []): ProbeSpy {
  const calls: ProbeSpy['calls'] = [];
  return {
    calls,
    run: async (executable, work, hooks) => {
      calls.push({ executable, work });
      world.events.push('probe.spawn');
      const step = steps.shift() ?? {};
      if (!step.noSpawn) hooks.onSpawned(4242);
      await step.during?.();
      if (step.throws) throw step.throws;
      world.events.push('probe.end');
      return {
        result: step.result ?? 'pass',
        ...(step.detail !== undefined ? { detail: step.detail } : {}),
        ...((step.result ?? 'pass') === 'pass' ? { versionOutput: step.versionOutput ?? versionOutput(executable) } : step.versionOutput !== undefined ? { versionOutput: step.versionOutput } : {}),
        durationMs: step.durationMs ?? 400,
      };
    },
  };
}

/** The injected closure check: the folder's files give the digest the world records for it now. */
export function fakeCheckClosure(world: FakeWorld, override?: (folder: string) => ManagedFolderCheck | undefined): CheckManagedClosure {
  return async (folder) => {
    world.events.push('closure.check');
    const forced = override?.(folder);
    if (forced) return forced;
    const digest = world.folderDigests.get(folder);
    if (digest === undefined) return { ok: false, reason: 'unreadable', message: 'The version folder could not be read (ENOENT).' };
    return {
      ok: true,
      closure: { provider: 'codex-cli', kind: 'package', executable: path.join(folder, 'bin', 'codex.exe'), root: folder, files: [], executablePath: 'bin/codex.exe', listing: '', digest },
    };
  };
}

export interface DownloadSpy {
  run: DownloadAndPromote;
  calls: Array<{ key: string }>;
}

/** The injected re-download: V1–V4 pass and the payload's files are the entry's (or give `digest`). */
export function fakeDownload(world: FakeWorld, window = 'w1', options: { fail?: string; digest?: string } = {}): DownloadSpy {
  const calls: DownloadSpy['calls'] = [];
  const instance = world.instance(window);
  return {
    calls,
    run: async (ref, entry) => {
      calls.push({ key: keyOf(entry) });
      world.events.push('download');
      if (options.fail) return { ok: false, reason: 'publish-failed', detail: options.fail };
      const staging = instance.createStaging(ref, world.token());
      world.stagedDigests.set(staging.root, options.digest ?? digestOf(entry));
      return instance.promote(ref, staging, promotedFacts(entry));
    },
  };
}

export interface Harness {
  deps: TryAgainDeps;
  probe: ProbeSpy;
  download: DownloadSpy;
}

/** The dependencies one window passes to the qualification functions. */
export function harness(
  world: FakeWorld,
  policy: ValidatedCliCompatibilityPolicy,
  options: { window?: string; probeSteps?: ProbeScriptStep[]; checkClosure?: CheckManagedClosure; download?: DownloadSpy } = {},
): Harness {
  const window = options.window ?? 'w1';
  // A passing probe reports the output of the version whose folder it was started from.
  const outputOf = (executable: string) => policy.entries.find((entry) => executable.includes(keyOf(entry)))?.versionOutput ?? '';
  const probe = scriptedProbe(world, outputOf, options.probeSteps);
  const download = options.download ?? fakeDownload(world, window);
  const deps: TryAgainDeps = {
    control: world.control(window),
    instance: world.instance(window),
    policy,
    host: HOST,
    hostProcess: HOST_PROCESS,
    checkClosure: options.checkClosure ?? fakeCheckClosure(world),
    runManagedProbe: probe.run,
    downloadAndPromote: download.run,
    now: () => world.now(),
    newToken: () => world.token(),
  };
  return { deps, probe, download };
}
