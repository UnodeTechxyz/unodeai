/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the CLI programs of this window: external adoption and managed Codex, put together (v0.9.97)
 *  Builds the resolver every Claude and Codex start goes through, the person's adoption of an external program
 *  (its facts, the dialog, the compatibility check, the record), and, on Windows x64 with a valid bundled policy,
 *  managed Codex: its control journal, its instances, the launcher, the qualification steps and the updater.
 *  The editor's own calls (modal dialogs, notifications) come through the port, so this module starts nothing and
 *  asks nothing by itself.
 *--------------------------------------------------------------------------------------------*/

import { readSync, openSync, closeSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { ClosureHasher, computeCliClosure, verifyManagedVersionFolder, type CliClosure } from '../backend/cliClosure';
import {
  CLI_COMPATIBILITY_POLICY,
  cliStoreVersionKey,
  loadCliCompatibilityPolicy,
  qualifyCliClosure,
  type PolicyEntry,
  type ValidatedCliCompatibilityPolicy,
} from '../backend/cliCompatibilityPolicy';
import type { CliRuntimeProvider } from '../backend/cliRuntime';
import type { HostShutdown } from '../backend/processTree';
import { findAdoption, recordAdoption, externalPathInStore, forgetAdoptions, type AdoptionContext } from './cliAdoption';
import { adoptionDialog, type AdoptionSignatures } from './cliAdoptionDialog';
import { runExternalCodexGateProbe, runManagedCodexGateProbe } from './codexGateProbe';
import { runClaudeGateProbe } from './claudeGateProbe';
import type { CliGateProbeOutcome, CliProgramFacts } from './CliRuntimeChooser';
import { CliRuntimeResolver, type ExternalProgram } from './cliRuntimeResolver';
import type { SessionRuntimePin } from './cliRuntimePin';
import {
  checkAuthenticodeSignatures,
  type AuthenticodeCheckResult,
  type AuthenticodeFile,
  type AuthenticodeFileVerdict,
} from './windowsAuthenticode';
import { createControlStore } from './managedCli/controlStore';
import { createInstanceStore } from './managedCli/instanceStore';
import { processCreationQuery, type ProcessCreationQuery } from './managedCli/processIdentity';
import { cliStoreReachableFrom, cliStoreRoots, newStoreToken, resolveCliStoreLocation, type CliStoreRoots } from './managedCli/storeLayout';
import type { ControlStoreApi, InstanceStoreApi, Liveness, ProcessIdentity, StoreId, VersionKey } from './managedCli/contracts';
import type { DownloadFetch, DownloadResponse } from './cliDelivery/boundedDownload';
import { ManagedCodexStore } from './managedCli/managedCodexStore';
import { ManagedLauncher } from './managedCli/managedLauncher';
import { launchableKey } from './managedCli/qualify/policyReconcile';
import type { TryAgainDeps } from './managedCli/qualify/tryAgain';
import { AgentStartFailureChecks, type AgentStartFailure, type AgentStartFailureOutcome } from './managedCli/qualify/agentStartFailure';
import { ManagedCodexUpdater, type UpdaterTaskEvent } from './managedCli/updater/updater';
import { runDownloadTask } from './managedCli/updater/downloadTask';

export interface CliRuntimeHostPort {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  extensionVersion: string;
  /** The extension's own storage folder; the place for adoption records off Windows. */
  globalStorage: string;
  workspaceRoots(): string[];
  /** Every folder an agent may write, and every Folder Access grant: none may reach the store. */
  agentReach(): { writeRoots: string[]; folderAccessGrants: string[] };
  /** UnodeAi's own folder for checks, prepared outside every workspace; throws with the reason. */
  checkFolder(): string;
  externalProgram(provider: CliRuntimeProvider): ExternalProgram;
  physical(file: string): string;
  /** The environment an agent starts with, every layer merged. */
  agentEnv(): NodeJS.ProcessEnv;
  pins: { load(sessionId: string): unknown; save(sessionId: string, pin: SessionRuntimePin): Promise<void> };
  /**
   * The adoption question, with **Not now** and **Check and use this program**; true only for the latter.
   * `sessionId`: the agent whose start waits for the answer, whose turn clock the wait pauses.
   */
  askAdoption(title: string, lines: readonly string[], sessionId?: string): Promise<boolean>;
  /** The window is trusted and its workspace binding is current. */
  windowAllowed(): boolean;
  shutdown: HostShutdown;
  /** A downloaded and checked version waits for the person's OK; told once per version in this window. */
  onManagedVersionVerified?(key: VersionKey, entry: PolicyEntry): void;
  /** A step of this window's download task, automatic, Update now or Try again, for the card. */
  onManagedTask?(event: UpdaterTaskEvent): void;
  log(line: string): void;
}

/** What managed Codex needs in this window, when this host offers it. */
export interface ManagedCodexHost {
  roots: CliStoreRoots;
  control: ControlStoreApi;
  instances: InstanceStoreApi;
  store: ManagedCodexStore;
  launcher: ManagedLauncher;
  updater: ManagedCodexUpdater;
  qualification: TryAgainDeps;
  policy: ValidatedCliCompatibilityPolicy;
  entryForKey(key: VersionKey): PolicyEntry | undefined;
  /** Why the store must not be used now, or undefined. */
  storeRefusal(): string | undefined;
  /**
   * Settles once this extension host's own creation time was asked. A lease names its holder by that time, and one
   * written with a pending holder could never be proved dead, so managed starts and tasks wait for it.
   */
  ready: Promise<void>;
  hostProcess(): ProcessIdentity;
  /**
   * After a real agent start of a managed version failed at the program's own level: one immediate check of that
   * version through the same final admission as every check. A failed check marks it `local-bad`; a passing one
   * makes the failure the environment's. Nothing is started again for the agent.
   */
  afterAgentStartFailure(storeId: StoreId, key: VersionKey, failure: AgentStartFailure): Promise<AgentStartFailureOutcome>;
}

export interface CliRuntimeHost {
  resolver: CliRuntimeResolver;
  hasher: ClosureHasher;
  policy: ValidatedCliCompatibilityPolicy;
  /** `cli-store`, which holds the adoption records; undefined when no such folder can be used here. */
  storeRoot?: string;
  managed?: ManagedCodexHost;
  /** For Check / choose CLI: the facts of a program, starting nothing of it. */
  facts(provider: CliRuntimeProvider, executable: string): Promise<CliProgramFacts & { closure?: CliClosure }>;
  /** For Check / choose CLI: the compatibility check, after the OK. */
  probe(provider: CliRuntimeProvider, launch: { executable: string; shell: boolean }): Promise<CliGateProbeOutcome>;
  /** For Check / choose CLI: the record of an adoption, after a pass. */
  adopt(provider: CliRuntimeProvider, closure: CliClosure, outcome: Extract<CliGateProbeOutcome, { result: 'pass' }>): void;
  forgetAdoptions(): number;
}

const CODEX_POLICY_HOST = { os: 'win32', arch: 'x64' } as const;

/** The download's fetch: the extension host's own, with VS Code's proxy support; no child process. */
const downloadFetch: DownloadFetch = async (url, init) => (await fetch(url, init)) as unknown as DownloadResponse;

/** The bundled policy, validated; an empty one when it does not validate, so nothing is ever qualified by mistake. */
function bundledPolicy(log: (line: string) => void): { policy: ValidatedCliCompatibilityPolicy; valid: boolean } {
  const loaded = loadCliCompatibilityPolicy();
  if (loaded.ok) return { policy: loaded.policy, valid: true };
  log(`The bundled CLI compatibility policy is not valid (${loaded.problems.slice(0, 3).join('; ')}); no CLI version is qualified and managed Codex is not offered.`);
  const empty = loadCliCompatibilityPolicy({ ...CLI_COMPATIBILITY_POLICY, entries: [] });
  if (!empty.ok) throw new Error('UnodeAi cannot read even an empty CLI compatibility policy.');
  return { policy: empty.policy, valid: false };
}

/** Creates one folder of the store's own path when it is missing; its parent already exists. */
function ensureFolder(folder: string): void {
  try {
    mkdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Whether a file starts with `MZ`: a program file Windows signs. */
function startsLikeProgram(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createCliRuntimeHost(port: CliRuntimeHostPort): CliRuntimeHost {
  const hasher = new ClosureHasher();
  const { policy, valid: policyValid } = bundledPolicy(port.log);
  const host = { os: port.platform, arch: port.arch };

  // The adoption records live in cli-store: on Windows below %LOCALAPPDATA% (never the roaming profile), elsewhere
  // in the extension's own storage.
  let storeRoot: string | undefined;
  if (port.platform === 'win32') {
    const location = resolveCliStoreLocation(port.env, 'win32', 'x64');
    if (location.ok) storeRoot = location.root;
    else port.log(`UnodeAi's CLI store is not available (${location.detail}). External programs are asked about at every start, and managed Codex is not offered.`);
  } else {
    storeRoot = path.join(port.globalStorage, 'cli-store');
  }
  if (storeRoot) {
    try {
      if (port.platform === 'win32') ensureFolder(path.dirname(storeRoot));
      else mkdirSync(path.dirname(storeRoot), { recursive: true });
      ensureFolder(storeRoot);
    } catch (error) {
      port.log(`UnodeAi could not prepare its CLI store (${error instanceof Error ? error.message : String(error)}).`);
      storeRoot = undefined;
    }
  }

  const adoptionContext = (): AdoptionContext | undefined => (storeRoot
    ? { storeRoot, reach: port.agentReach(), platform: port.platform }
    : undefined);

  const signaturesOf = async (provider: CliRuntimeProvider, closure: CliClosure): Promise<AdoptionSignatures> => {
    if (port.platform !== 'win32') return { status: 'not-checked', reason: 'publisher signatures are checked on Windows only' };
    if (provider === 'claude-cli') return { status: 'not-checked', reason: 'this UnodeAi records no Claude publisher to check against' };
    let cwd: string;
    try {
      cwd = port.checkFolder();
    } catch (error) {
      return { status: 'not-checked', reason: error instanceof Error ? error.message : String(error) };
    }
    const absolute = (relative: string) => (closure.root ? path.join(closure.root, ...relative.split('/')) : closure.executable);
    const programs = closure.files.map((file) => absolute(file.path)).filter(startsLikeProgram);
    // Shown, never gating: each program file is checked against the OpenAI signer, then against Microsoft's, then as
    // a file without a signature, and the dialog says which held.
    const request = (files: AuthenticodeFile[]) => checkAuthenticodeSignatures({
      files, signers: policy.signers, ownedFolder: cwd, ownedTmp: cwd, workspaceRoots: port.workspaceRoots(), worktreeRoots: [],
    });
    const verdicts = new Map<string, AuthenticodeFileVerdict>();
    let remaining = programs;
    let revocation: Extract<AuthenticodeCheckResult, { status: 'checked' }>['revocation'] = 'not-applicable';
    for (const signer of ['openai', 'microsoft-crt', 'unsigned'] as const) {
      if (remaining.length === 0) break;
      const result = await request(remaining.map((file) => ({ path: file, signer })));
      if (result.status !== 'checked') return result;
      for (const verdict of result.files) {
        if (verdict.accepted || signer === 'unsigned' || verdict.revoked) verdicts.set(verdict.path, verdict);
      }
      if (result.revocation === 'not-confirmed-offline') revocation = 'not-confirmed-offline';
      else if (result.revocation === 'confirmed-online' && revocation === 'not-applicable') revocation = 'confirmed-online';
      remaining = remaining.filter((file) => !verdicts.has(file));
    }
    const files = programs.map((file) => verdicts.get(file)).filter((verdict): verdict is AuthenticodeFileVerdict => verdict !== undefined);
    const counts = { openai: 0, 'microsoft-crt': 0, unsigned: 0 };
    for (const verdict of files) if (verdict.accepted) counts[verdict.signer]++;
    return {
      status: 'checked',
      accepted: files.every((verdict) => verdict.accepted),
      revoked: files.some((verdict) => !verdict.accepted && verdict.revoked),
      files,
      notSent: closure.files.map((file) => absolute(file.path)).filter((file) => !programs.includes(file)),
      counts,
      unsignedFiles: files.filter((verdict) => verdict.accepted && verdict.signer === 'unsigned').map((verdict) => verdict.path),
      revocation,
    };
  };

  const probe = async (provider: CliRuntimeProvider, launch: { executable: string; shell: boolean }): Promise<CliGateProbeOutcome> => {
    let cwd: string;
    try {
      cwd = port.checkFolder();
    } catch (error) {
      return { result: 'fail', detail: error instanceof Error ? error.message : String(error) };
    }
    const request = { probeCwd: cwd, workspaceRoots: port.workspaceRoots(), agentEnv: port.agentEnv() };
    const result = provider === 'codex-cli'
      ? await runExternalCodexGateProbe({ executable: launch.executable, ...request })
      : await runClaudeGateProbe({ launch, ...request });
    if (result.result !== 'pass') return { result: result.result, detail: result.detail };
    return { result: 'pass', version: result.version ?? result.versionOutput, versionOutput: result.versionOutput, startedAt: result.startedAt, durationMs: result.durationMs };
  };

  const adopt = (provider: CliRuntimeProvider, closure: CliClosure, outcome: Extract<CliGateProbeOutcome, { result: 'pass' }>): void => {
    const context = adoptionContext();
    if (!context) throw new Error('UnodeAi has no CLI store folder to record your choice in.');
    const written = recordAdoption({
      provider,
      closure,
      version: outcome.version,
      probe: { result: 'pass', versionOutput: outcome.versionOutput, ranAt: outcome.startedAt, durationMs: outcome.durationMs },
      decidedAt: new Date().toISOString(),
      extensionVersion: port.extensionVersion,
    }, context);
    if (!written.ok && written.reason !== 'exists') throw new Error(`UnodeAi could not record your choice (${written.detail}).`);
  };

  const facts = async (provider: CliRuntimeProvider, executable: string): Promise<CliProgramFacts & { closure?: CliClosure }> => {
    const physical = port.physical(executable);
    if (storeRoot && externalPathInStore(physical, storeRoot)) {
      throw new Error('This program is inside UnodeAi\'s own CLI store. UnodeAi starts the programs there only as managed Codex, after your OK for each version.');
    }
    const outcome = await computeCliClosure({ provider, executable }, hasher, { platform: port.platform });
    if (!outcome.ok) throw new Error(`UnodeAi could not check the program's files (${outcome.message}).`);
    const closure = outcome.closure;
    const verdict = qualifyCliClosure(policy, closure, host);
    if (verdict.verdict === 'blocked-bad') return { verdict: 'blocked-bad', closureDigest: closure.digest, reason: verdict.reason, closure };
    if (verdict.verdict === 'qualified') return { verdict: 'qualified', closureDigest: closure.digest, version: verdict.version, compatibilityPolicyId: verdict.compatibilityPolicyId, closure };
    const context = adoptionContext();
    const found = context ? findAdoption(provider, physical, closure, context) : undefined;
    if (found?.adopted) return { verdict: 'adopted', closureDigest: closure.digest, version: found.record.version, adoptionId: found.adoptionId, closure };
    const dialog = adoptionDialog({
      provider,
      executable: physical,
      closure,
      signatures: await signaturesOf(provider, closure),
      host: { platform: port.platform, arch: port.arch, env: port.env, execPath: port.execPath },
    });
    return { verdict: 'needs-adoption', closureDigest: closure.digest, dialog, closure };
  };

  const managed = port.platform === 'win32' && port.arch === 'x64' && policyValid && storeRoot
    ? createManagedCodexHost(port, storeRoot, policy, hasher)
    : undefined;

  const resolver = new CliRuntimeResolver({
    platform: port.platform,
    host,
    policy,
    hasher,
    pins: port.pins,
    externalProgram: (provider) => port.externalProgram(provider),
    physical: (file) => port.physical(file),
    ...(storeRoot ? { storeRoot } : {}),
    externalPathInStore: (physical, root) => externalPathInStore(physical, root),
    ...(managed ? { managed: { status: () => managed.store.status(), launcher: managed.launcher } } : {}),
    adoption: {
      find: (provider, executable, closure) => {
        const context = adoptionContext();
        const found = context ? findAdoption(provider, executable, closure, context) : undefined;
        return found?.adopted ? { version: found.record.version } : undefined;
      },
      adopt: async (provider, executable, closure, launch, onPending, sessionId) => {
        const dialog = adoptionDialog({
          provider,
          executable,
          closure,
          signatures: await signaturesOf(provider, closure),
          host: { platform: port.platform, arch: port.arch, env: port.env, execPath: port.execPath },
        });
        onPending?.(`${dialog.title} UnodeAi is waiting for your answer.`);
        if (!(await port.askAdoption(dialog.title, dialog.lines, sessionId))) {
          return { ok: false, reason: 'adoption-declined', message: 'You chose Not now, so nothing was started. Start the agent again to be asked again, or choose another program with Check / choose CLI.' };
        }
        // The program the question described, in the spelling that was hashed: never the setting read again.
        const outcome = await probe(provider, { executable: launch.shell ? launch.executable : executable, shell: launch.shell });
        if (outcome.result !== 'pass') {
          return { ok: false, reason: 'adoption-failed', message: `UnodeAi checked the program and it did not pass (${outcome.detail}). Nothing else was started.` };
        }
        // The pass is recorded for these files only when they are still the files the question described.
        const after = await computeCliClosure({ provider, executable: launch.executable }, hasher, { platform: port.platform });
        if (!after.ok || after.closure.digest !== closure.digest) {
          return { ok: false, reason: 'adoption-failed', message: 'The program\'s files changed while UnodeAi checked them, so your choice was not recorded and nothing else was started. Start the agent again to be asked about the files there now.' };
        }
        try {
          adopt(provider, closure, outcome);
        } catch (error) {
          return { ok: false, reason: 'adoption-failed', message: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true, version: outcome.version };
      },
    },
  });

  return {
    resolver,
    hasher,
    policy,
    ...(storeRoot ? { storeRoot } : {}),
    ...(managed ? { managed } : {}),
    facts,
    probe,
    adopt,
    forgetAdoptions: () => (storeRoot ? forgetAdoptions({ storeRoot }) : 0),
  };
}

function createManagedCodexHost(
  port: CliRuntimeHostPort,
  root: string,
  policy: ValidatedCliCompatibilityPolicy,
  hasher: ClosureHasher,
): ManagedCodexHost {
  const roots = cliStoreRoots(root);
  // The query's own folder is prepared when the first lease is judged, not at activation.
  const processCreations: ProcessCreationQuery = (pids) => {
    let folder: string;
    try {
      folder = port.checkFolder();
    } catch {
      return Promise.resolve('unavailable');
    }
    return processCreationQuery({ ownedFolder: folder, ownedTmp: folder, workspaceRoots: port.workspaceRoots() })(pids);
  };
  const identity: ProcessIdentity = { pid: process.pid, creation: 'pending' };
  // Asked when managed Codex is first used in this window, not at activation: a window that never uses it runs no query.
  let asked: Promise<void> | undefined;
  const ready = (): Promise<void> => (asked ??= processCreations([process.pid]).then((answer) => {
    const creation = answer === 'unavailable' ? undefined : answer.get(process.pid);
    if (creation) identity.creation = creation;
    else port.log('UnodeAi could not read its own process creation time, so no managed Codex version it uses is ever collected.');
  }, () => undefined));
  const hostProcess = (): ProcessIdentity => identity;
  const ownerLiveness = async (owner: ProcessIdentity): Promise<Liveness> => {
    if (owner.creation === 'pending') return 'unknown';
    const answer = await processCreations([owner.pid]);
    if (answer === 'unavailable') return 'unknown';
    const creation = answer.get(owner.pid);
    return creation === undefined || creation !== owner.creation ? 'dead' : 'alive';
  };
  const taskDeps = {
    fetch: downloadFetch,
    hostIdentity: hostProcess,
    ownerLiveness,
    writeRoots: () => { const reach = port.agentReach(); return [...reach.writeRoots, ...reach.folderAccessGrants]; },
    workspaceRoots: port.workspaceRoots(),
  };
  const instances = createInstanceStore(roots, { processCreations, log: port.log });
  const control = createControlStore({
    root,
    admissionState: (storeId) => {
      const open = instances.open(storeId);
      return open.ok ? instances.admissionState(open.ref) : 'missing';
    },
  });
  const entryForKey = (key: VersionKey): PolicyEntry | undefined => policy.entries.find((entry) => entry.provider === 'codex-cli'
    && entry.status === 'qualified' && entry.os === 'win32' && entry.arch === 'x64' && !!entry.managed && cliStoreVersionKey(entry) === key);
  const storeRefusal = (): string | undefined => {
    const reach = port.agentReach();
    return cliStoreReachableFrom(root, [...reach.writeRoots, ...reach.folderAccessGrants])
      ? 'A folder an agent may use reaches UnodeAi\'s CLI store, so managed Codex is not used. Remove that folder from the agent\'s Folder Access.'
      : undefined;
  };

  // A Reset recorded here wakes this window's updater, which then finds no enrolled instance and stops its task.
  const store = new ManagedCodexStore({ control, instances, onInstanceRetired: () => updater.refresh() });
  const launcher = new ManagedLauncher({
    control,
    instances,
    entryForKey,
    launchableKey: (record, instance) => {
      const decided = launchableKey({
        suspension: { present: false },
        control: { kind: 'readable', authority: 'ok', floor: record.reductionEpoch, snapshot: { generation: record.generation, digest: '', record } },
        instance: { kind: 'readable', snapshot: { generation: instance.generation, digest: '', record: instance } },
        policy,
        host: CODEX_POLICY_HOST,
      });
      return decided.launchable && decided.version.storeId === record.enrolledStoreId
        ? { key: decided.version.key, closureDigest: decided.closureDigest }
        : undefined;
    },
    hasher,
    host: hostProcess,
    get ready() { return ready(); },
    queryCreation: async (pid) => {
      const answer = await processCreations([pid]);
      return answer === 'unavailable' ? undefined : answer.get(pid);
    },
    storeRefusal,
  });

  const qualification: TryAgainDeps = {
    control,
    instance: instances,
    policy,
    host: CODEX_POLICY_HOST,
    get hostProcess() { return hostProcess(); },
    checkClosure: (folder, layout) => verifyManagedVersionFolder(folder, layout, hasher),
    runManagedProbe: async (executable, workFolder, hooks, entry) => {
      const result = await runManagedCodexGateProbe({ executable, workFolder, expectedVersionOutput: entry.versionOutput, hostEnv: port.env }, {
        onSpawned: (pid, step) => { if (step === 'app-server') hooks.onSpawned(pid); },
      });
      return result.result === 'pass'
        ? { result: 'pass', versionOutput: result.versionOutput, durationMs: result.durationMs }
        : { result: result.result, detail: result.detail, ...(result.versionOutput ? { versionOutput: result.versionOutput } : {}), durationMs: result.durationMs };
    },
    now: () => new Date().toISOString(),
    newToken: () => newStoreToken(),
    downloadAndPromote: async (ref, entry, signal) => {
      const view = control.read();
      if (view.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: 'the managed Codex record cannot be used' };
      // Try again's download: its steps reach the card like the updater's, until it ends.
      let ended = false;
      const report = (event: UpdaterTaskEvent) => { if (!ended) port.onManagedTask?.(event); };
      const result = await runDownloadTask({
        kind: 'manual', decidedOn: view.snapshot, entry, policy, host: CODEX_POLICY_HOST, control, instances, instance: ref,
      }, {
        ...taskDeps, signal, stillAllowed: () => port.windowAllowed() && !port.shutdown.started,
        onPhase: (phase) => report({ type: 'phase', kind: 'manual', entry, phase }),
        onProgress: (receivedBytes, size) => report({ type: 'progress', kind: 'manual', entry, receivedBytes, size }),
      });
      report({ type: 'ended', kind: 'manual', entry, result });
      ended = true;
      if (result.outcome !== 'verified') {
        return { ok: false, reason: 'publish-failed', detail: 'detail' in result ? String(result.detail) : result.outcome };
      }
      const after = instances.read(ref);
      if (after.kind !== 'readable') return { ok: false, reason: 'store-unusable', detail: 'the instance record cannot be read' };
      return { ok: true, key: cliStoreVersionKey(entry), alreadyPromoted: result.alreadyPromoted, snapshot: after.snapshot };
    },
  };

  const updater = new ManagedCodexUpdater({
    control,
    instances,
    policy,
    host: CODEX_POLICY_HOST,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    windowAllowed: () => port.windowAllowed(),
    shutdown: port.shutdown,
    task: taskDeps,
    onVerified: (key, entry) => port.onManagedVersionVerified?.(key, entry),
    onTask: (event) => port.onManagedTask?.(event),
  });

  const failureChecks = new AgentStartFailureChecks(qualification);
  const afterAgentStartFailure = async (storeId: StoreId, key: VersionKey, failure: AgentStartFailure): Promise<AgentStartFailureOutcome> => {
    await ready();
    return failureChecks.check(storeId, key, failure);
  };

  return { roots, control, instances, store, launcher, updater, qualification, policy, entryForKey, storeRefusal, get ready() { return ready(); }, hostProcess, afterAgentStartFailure };
}

export { cliStoreRoots };
