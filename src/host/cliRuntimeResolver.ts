/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which program each CLI start runs (v0.9.97)
 *  Every start of Claude CLI or Codex CLI comes here: an agent's start, an App Server restart, the restart after a
 *  confirmed exit, a start for a message to a stopped agent, a start an agent or a tool asks for, and the first start
 *  after a window reload.
 *
 *  - A start the user asked for (`take`) resolves afresh and saves the session's new pin before the process starts.
 *    Managed Codex is used when it is set up and selected; otherwise the external program.
 *  - Every other start (`reuse`) checks the session's pin. An observed external update is repinned automatically;
 *    a missing or forgotten external check uses the host's non-blocking background qualification path.
 *  - External files are hashed at each start. Known-bad and managed-runtime rules stay distinct from this
 *    background check. A program inside UnodeAi's own CLI store is never started as external.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import { computeCliClosure, type CliClosure, type ClosureHasher } from '../backend/cliClosure';
import { qualifyCliClosure, type ValidatedCliCompatibilityPolicy } from '../backend/cliCompatibilityPolicy';
import type { CliRuntimeProvider } from '../backend/cliRuntime';
import { parseSessionRuntimePin, PINNED_START_REFUSAL_TEXT, runtimeIdentityKey, type PinMode, type PinnedStartRefusal, type SessionRuntimePin } from './cliRuntimePin';
import type { ManagedCodexStatus } from './managedCli/managedCodexStore';
import type { ManagedLaunchPlan, ManagedLauncher, ManagedLaunchRefusalReason } from './managedCli/managedLauncher';

export type CliStartRefusalReason =
  | PinnedStartRefusal
  | ManagedLaunchRefusalReason
  | 'external-path-in-store'
  | 'program-unavailable'
  | 'closure-check-failed'
  | 'blocked-bad'
  | 'adoption-declined'
  | 'adoption-failed'
  | 'adoption-needed';

/** A start that did not happen. Nothing was started for it, and no other program was started instead. */
export class CliStartRefused extends Error {
  constructor(readonly reason: CliStartRefusalReason, message: string) {
    super(message);
    this.name = 'CliStartRefused';
  }
}

export interface ExternalProgram {
  /** The program as configured or found, before links are resolved. */
  executable: string;
  /** npm's `.cmd` launcher, started through cmd.exe. */
  shell: boolean;
}

/** An external program a start may run now: qualified, or adopted by the person, with the session's pin saved. */
export interface ResolvedExternalProgram {
  /** What to start: npm's launcher through cmd.exe, or the physical program. */
  executable: string;
  shell: boolean;
  physical: string;
  pin: Extract<SessionRuntimePin, { mode: 'external' }>;
  identityKey: string;
  qualification: 'qualified' | 'adopted-unqualified';
  version: string;
}

/** What one start runs, with the identity its session is pinned to. */
export interface ResolvedCliStart {
  child: ChildProcess;
  pin: SessionRuntimePin;
  identityKey: string;
  mode: 'external' | 'managed';
  qualification: 'qualified' | 'adopted-unqualified';
  /** From the policy entry or the adoption record; never from running the program before consent. */
  version?: string;
  executable: string;
  /** Managed only: releases the version's lease. Called after a confirmed stop of the process tree only. */
  release(): void;
}

export interface CliRuntimeResolverDeps {
  platform: NodeJS.Platform;
  host: { os: string; arch: string };
  policy: ValidatedCliCompatibilityPolicy;
  hasher: ClosureHasher;
  pins: {
    load(sessionId: string): unknown;
    /** Saved with the session's record before the process starts. A failed save refuses the start. */
    save(sessionId: string, pin: SessionRuntimePin): Promise<void>;
  };
  /** The configured program (or the lookup UnodeAi always used), resolved by the host's executable resolver. */
  externalProgram(provider: CliRuntimeProvider): ExternalProgram;
  /** The physical path, every link resolved. */
  physical(file: string): string;
  /** The CLI store folder when this host has one (Windows x64), for the `external-path-in-store` rule. */
  storeRoot?: string;
  /**
   * v0.9.99: the person chose "Run anyway" in Check / choose CLI for exactly these files under exactly this bad-list
   * entry, after its compatibility check passed. Without it a version a release marked bad is not started.
   */
  runAnyway?(provider: CliRuntimeProvider, closureDigest: string, compatibilityPolicyId: string): boolean;
  externalPathInStore(physicalExecutable: string, storeRoot: string): boolean;
  /** Managed Codex, when this host offers it. */
  managed?: { status(): ManagedCodexStatus; launcher: ManagedLauncher };
  adoption: {
    /** The user's adoption of exactly this closure of this program, when one is recorded and may be used. */
    find(provider: CliRuntimeProvider, executable: string, closure: CliClosure): { version: string } | undefined;
    /**
     * Asks the user, and after the confirmation runs the gate probe and records the adoption. Nothing of the program
     * runs before the confirmation. The probe runs `launch`, the spelling whose files were hashed for the question;
     * the configured program is never read again, so a setting changed while the question is open runs nothing.
     */
    adopt(provider: CliRuntimeProvider, executable: string, closure: CliClosure, launch: ExternalProgram, onPending?: (message: string) => void, sessionId?: string): Promise<{ ok: true; version: string } | { ok: false; reason: 'adoption-declined' | 'adoption-failed'; message: string }>;
  };
}

export interface CliStartRequest {
  provider: CliRuntimeProvider;
  sessionId: string;
  pin: PinMode;
  /** Shown on the agent's row and in the chat while the start waits, for example for the files to be checked. */
  onPending?(message: string): void;
  /**
   * Called with the program the start will run, after it is chosen and checked and before anything of it runs: the
   * egress consent. For managed Codex it is called before the admission, since it may wait for the person.
   */
  beforeStart?(executable: string): Promise<void>;
}

export type CliSpawn = (program: { executable: string; shell: boolean; managed?: ManagedLaunchPlan }) => ChildProcess | Promise<ChildProcess>;

const CHECKING: Record<CliRuntimeProvider, string> = { 'claude-cli': 'Checking the Claude program…', 'codex-cli': 'Checking the Codex program…' };

function noRelease(): void { /* nothing is leased for an external program */ }

function startOf(child: ChildProcess, external: ResolvedExternalProgram): ResolvedCliStart {
  return { child, pin: external.pin, identityKey: external.identityKey, mode: 'external', qualification: external.qualification, version: external.version, executable: external.physical, release: noRelease };
}

export class CliRuntimeResolver {
  constructor(private readonly deps: CliRuntimeResolverDeps) {}

  async start(request: CliStartRequest, spawn: CliSpawn): Promise<ResolvedCliStart> {
    if (request.pin === 'reuse') {
      const saved = this.deps.pins.load(request.sessionId);
      if (saved !== undefined) {
        const parsed = parseSessionRuntimePin(saved);
        if (!parsed.ok) throw new CliStartRefused(parsed.reason, PINNED_START_REFUSAL_TEXT[parsed.reason]);
        if (parsed.pin.provider !== request.provider) throw new CliStartRefused('identity-changed', PINNED_START_REFUSAL_TEXT['identity-changed']);
        return this.startPinned(request, parsed.pin, spawn);
      }
    }
    return this.startFresh(request, spawn);
  }

  private async startPinned(request: CliStartRequest, pin: SessionRuntimePin, spawn: CliSpawn): Promise<ResolvedCliStart> {
    if (pin.mode === 'managed') {
      const managed = this.deps.managed;
      if (!managed) throw new CliStartRefused('managed-store-replaced', PINNED_START_REFUSAL_TEXT['managed-store-replaced']);
      request.onPending?.(CHECKING['codex-cli']);
      const launched = await managed.launcher.launch({ kind: 'pinned', pin, beforeAdmission: request.beforeStart }, (plan) => spawn({ executable: plan.executable, shell: false, managed: plan }));
      if (!launched.ok) throw new CliStartRefused(launched.reason, launched.message);
      return { child: launched.child, pin, identityKey: runtimeIdentityKey(pin), mode: 'managed', qualification: 'qualified', version: launched.plan.entry.version, executable: launched.plan.executable, release: launched.release };
    }
    const external = await this.pinnedExternal(request, pin);
    const child = await spawn({ executable: external.executable, shell: external.shell });
    return startOf(child, external);
  }

  /**
   * The external program of a start, checked now: for `reuse`, the session's pinned program and nothing else; for
   * `take`, the configured program, after the person's choice when UnodeAi has not qualified it, with the new pin
   * saved. Managed Codex is not resolved here (see `start`).
   */
  async resolveExternal(request: CliStartRequest): Promise<ResolvedExternalProgram> {
    if (request.pin === 'reuse') {
      const saved = this.deps.pins.load(request.sessionId);
      if (saved !== undefined) {
        const parsed = parseSessionRuntimePin(saved);
        if (!parsed.ok) throw new CliStartRefused(parsed.reason, PINNED_START_REFUSAL_TEXT[parsed.reason]);
        if (parsed.pin.provider !== request.provider || parsed.pin.mode !== 'external') {
          throw new CliStartRefused('identity-changed', PINNED_START_REFUSAL_TEXT['identity-changed']);
        }
        return this.pinnedExternal(request, parsed.pin);
      }
    }
    return this.freshExternal(request);
  }

  private async pinnedExternal(request: CliStartRequest, pin: Extract<SessionRuntimePin, { mode: 'external' }>): Promise<ResolvedExternalProgram> {
    const resolved = await this.externalClosure(request);
    const current: SessionRuntimePin = { pinVersion: 1, mode: 'external', provider: request.provider, executable: resolved.physical, closureDigest: resolved.closure.digest };
    if (runtimeIdentityKey(current, this.deps.platform) !== runtimeIdentityKey(pin, this.deps.platform)) {
      request.onPending?.('The installed CLI changed. Checking and using the current program automatically.');
      const next = await this.freshExternal(request);
      request.onPending?.(next.version === 'not-yet-checked'
        ? 'CLI updated. Using the current program; its version is being checked.'
        : `CLI updated: ${pin.version ?? 'previous version not recorded'} → ${next.version}. Using the current program.`);
      return next;
    }
    const verdict = this.externalVerdict(request.provider, resolved.physical, resolved.closure);
    if (verdict.kind === 'blocked-bad') throw new CliStartRefused('blocked-bad', verdict.message);
    // A forgotten external check is refreshed in the background by the existing host path, without a modal.
    if (verdict.kind === 'needs-adoption') return this.freshExternal(request);
    if (verdict.warning) request.onPending?.(verdict.warning);
    await request.beforeStart?.(resolved.physical);
    return this.external(resolved, pin, verdict);
  }

  private async startFresh(request: CliStartRequest, spawn: CliSpawn): Promise<ResolvedCliStart> {
    if (request.provider === 'codex-cli' && this.deps.managed) {
      const status = this.deps.managed.status();
      const use = managedChoice(status);
      if (use.kind === 'refuse') throw new CliStartRefused(use.reason, use.message);
      if (use.kind === 'managed') {
        request.onPending?.(CHECKING['codex-cli']);
        let saved: SessionRuntimePin | undefined;
        const launched = await this.deps.managed.launcher.launch({
          kind: 'new',
          savePin: async (pin) => { await this.deps.pins.save(request.sessionId, pin); saved = pin; },
          beforeAdmission: request.beforeStart,
        }, (plan) => spawn({ executable: plan.executable, shell: false, managed: plan }));
        if (!launched.ok) throw new CliStartRefused(launched.reason, launched.message);
        const pin = saved ?? launched.pin;
        return { child: launched.child, pin, identityKey: runtimeIdentityKey(pin), mode: 'managed', qualification: 'qualified', version: launched.plan.entry.version, executable: launched.plan.executable, release: launched.release };
      }
    }
    const external = await this.freshExternal(request);
    const child = await spawn({ executable: external.executable, shell: external.shell });
    return startOf(child, external);
  }

  /**
   * A start that belongs to no session and is asked for by the person, such as loading Codex's model list: managed
   * Codex through its admission when it is set up and selected, otherwise the external program, after the person's
   * choice when UnodeAi has not qualified it. No pin is saved.
   */
  async startTransient(request: Omit<CliStartRequest, 'sessionId' | 'pin'>, spawn: CliSpawn): Promise<ResolvedCliStart> {
    if (request.provider === 'codex-cli' && this.deps.managed) {
      const use = managedChoice(this.deps.managed.status());
      if (use.kind === 'refuse') throw new CliStartRefused(use.reason, use.message);
      if (use.kind === 'managed') {
        request.onPending?.(CHECKING['codex-cli']);
        const launched = await this.deps.managed.launcher.launch({ kind: 'transient', beforeAdmission: request.beforeStart }, (plan) => spawn({ executable: plan.executable, shell: false, managed: plan }));
        if (!launched.ok) throw new CliStartRefused(launched.reason, launched.message);
        return { child: launched.child, pin: launched.pin, identityKey: runtimeIdentityKey(launched.pin), mode: 'managed', qualification: 'qualified', version: launched.plan.entry.version, executable: launched.plan.executable, release: launched.release };
      }
    }
    const external = await this.freshExternal({ ...request, sessionId: '', pin: 'take' }, false);
    const child = await spawn({ executable: external.executable, shell: external.shell });
    return startOf(child, external);
  }

  /**
   * The external program for a use that belongs to no session and that the person asked for (the model list):
   * checked by hash, and asked about when UnodeAi has not qualified it, with no pin saved and nothing started.
   */
  resolveExternalTransient(request: Omit<CliStartRequest, 'sessionId' | 'pin'>): Promise<ResolvedExternalProgram> {
    return this.freshExternal({ ...request, sessionId: '', pin: 'take' }, false);
  }

  private async freshExternal(request: CliStartRequest, savePin = true): Promise<ResolvedExternalProgram> {
    let resolved = await this.externalClosure(request);
    let verdict = this.externalVerdict(request.provider, resolved.physical, resolved.closure);
    if (verdict.kind === 'blocked-bad') throw new CliStartRefused('blocked-bad', verdict.message);
    if (verdict.kind === 'needs-adoption') {
      const adopted = await this.deps.adoption.adopt(request.provider, resolved.physical, resolved.closure, resolved.program, request.onPending, request.sessionId || undefined);
      if (!adopted.ok) throw new CliStartRefused(adopted.reason, adopted.message);
      // The adoption ran its probe on these files; they are hashed again before this start uses the record.
      const again = await this.externalClosure(request);
      if (again.physical !== resolved.physical || again.closure.digest !== resolved.closure.digest) {
        request.onPending?.('The installed CLI changed during its check. Using the current program.');
        resolved = again;
        const currentVerdict = this.externalVerdict(request.provider, again.physical, again.closure);
        if (currentVerdict.kind === 'blocked-bad') throw new CliStartRefused('blocked-bad', currentVerdict.message);
      }
      verdict = { kind: 'adopted-unqualified', version: adopted.version };
    }
    if (verdict.warning) request.onPending?.(verdict.warning);
    const pin: Extract<SessionRuntimePin, { mode: 'external' }> = { pinVersion: 1, mode: 'external', provider: request.provider, executable: resolved.physical, closureDigest: resolved.closure.digest, version: verdict.version };
    // The consent comes before the pin: a declined start keeps the session's earlier pin.
    await request.beforeStart?.(resolved.physical);
    if (!savePin) return this.external(resolved, pin, verdict);
    try {
      await this.deps.pins.save(request.sessionId, pin);
    } catch (error) {
      throw new CliStartRefused('program-unavailable', `UnodeAi could not save which program this agent uses (${error instanceof Error ? error.message : String(error)}). Nothing was started.`);
    }
    return this.external(resolved, pin, verdict);
  }

  private external(
    resolved: { program: ExternalProgram; physical: string },
    pin: Extract<SessionRuntimePin, { mode: 'external' }>,
    verdict: { kind: 'qualified' | 'adopted-unqualified'; version: string },
  ): ResolvedExternalProgram {
    return {
      executable: resolved.program.shell ? resolved.program.executable : resolved.physical,
      shell: resolved.program.shell,
      physical: resolved.physical,
      pin,
      identityKey: runtimeIdentityKey(pin, this.deps.platform),
      qualification: verdict.kind,
      version: verdict.version,
    };
  }

  /** The configured external program, its physical path, the store rule, and its closure hashed now. */
  private async externalClosure(request: CliStartRequest): Promise<{ program: ExternalProgram; physical: string; closure: CliClosure }> {
    let program: ExternalProgram;
    let physical: string;
    try {
      program = this.deps.externalProgram(request.provider);
      physical = this.deps.physical(program.executable);
    } catch (error) {
      throw new CliStartRefused('program-unavailable', error instanceof Error ? error.message : String(error));
    }
    if (this.deps.storeRoot && this.deps.externalPathInStore(physical, this.deps.storeRoot)) {
      throw new CliStartRefused('external-path-in-store', 'This program is inside UnodeAi\'s own CLI store. UnodeAi starts the programs there only as managed Codex, after your OK for each version. Choose another program with Check / choose CLI.');
    }
    request.onPending?.(CHECKING[request.provider]);
    const outcome = await computeCliClosure({ provider: request.provider, executable: program.executable }, this.deps.hasher, { platform: this.deps.platform });
    if (!outcome.ok) throw new CliStartRefused('closure-check-failed', `UnodeAi could not check the program's files (${outcome.message}). Nothing was started.`);
    return { program, physical, closure: outcome.closure };
  }

  private externalVerdict(provider: CliRuntimeProvider, executable: string, closure: CliClosure):
    | { kind: 'qualified' | 'adopted-unqualified'; version: string; warning?: string }
    | { kind: 'blocked-bad'; message: string }
    | { kind: 'needs-adoption' } {
    const verdict = qualifyCliClosure(this.deps.policy, closure, this.deps.host);
    if (verdict.verdict === 'blocked-bad') {
      const label = provider === 'codex-cli' ? 'Codex' : 'Claude';
      // v0.9.99: the person's explicit Run anyway for these exact files starts it, with a warning on every start.
      if (this.deps.runAnyway?.(provider, closure.digest, verdict.compatibilityPolicyId)) {
        return {
          kind: 'adopted-unqualified',
          version: verdict.entry.version,
          warning: `Running ${label} CLI ${verdict.entry.version}, which a UnodeAi release marked bad (${verdict.reason}), because you chose Run anyway. It may not work correctly; update it when you can.`,
        };
      }
      return {
        kind: 'blocked-bad',
        message: `This UnodeAi does not run this ${label} version: ${verdict.reason}. Update it, or choose another program. `
          + `To run it anyway: open UnodeAi Settings, Providers tab, choose Check / choose CLI… on the ${label} CLI row, pick this program and choose Run anyway.`,
      };
    }
    if (verdict.verdict === 'qualified') return { kind: 'qualified', version: verdict.version };
    const adopted = this.deps.adoption.find(provider, executable, closure);
    return adopted ? { kind: 'adopted-unqualified', version: adopted.version } : { kind: 'needs-adoption' };
  }
}

/** For a start the user asked for: managed Codex, the external program, or a refusal while managed Codex is paused. */
export function managedChoice(status: ManagedCodexStatus):
  | { kind: 'managed' }
  | { kind: 'external' }
  | { kind: 'refuse'; reason: ManagedLaunchRefusalReason; message: string } {
  // The shared suspension: new sessions use the external program.
  if (status.suspension.present) return { kind: 'external' };
  const control = status.control;
  if (control.kind === 'fresh') return { kind: 'external' };
  if (control.kind === 'unusable') {
    return {
      kind: 'refuse',
      reason: control.reason === 'floor-unavailable' ? 'authority-floor-unavailable' : control.reason === 'sealed' ? 'store-sealed' : 'control-unavailable',
      message: 'UnodeAi cannot read its record of managed Codex, so it does not know which Codex program you chose. Choose Use external CLI on the Codex card, or see Details there.',
    };
  }
  if (control.authority === 'behind-floor') {
    return { kind: 'refuse', reason: 'authority-behind-floor', message: 'UnodeAi could not confirm your last change to managed Codex after an unexpected shutdown. Review it on the Codex card before new sessions start.' };
  }
  const record = control.snapshot.record;
  return record.enrolledStoreId && record.selection === 'managed' ? { kind: 'managed' } : { kind: 'external' };
}
