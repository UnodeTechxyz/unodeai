/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one App Server start of a Codex agent, through the window's resolver (v0.9.97)
 *  The resolver chooses the program (the external one the person chose or adopted, or managed Codex through its
 *  admission); the agent's own version and login checks run under that admission, right before the spawn. A managed
 *  start that fails at the program's own level (its checks could not run it, it exited, it reported another version,
 *  or App Server failed before it was ready) is reported once for the check of that version. The start stays failed.
 *--------------------------------------------------------------------------------------------*/

import type { CodexProgramFailure, CodexProgramLaunch, CodexProgramStart } from '../backend/CodexBackend';
import { CodexPreflightError } from '../backend/CodexCliPreflight';
import type { CliRuntimeResolver } from './cliRuntimeResolver';
import type { ManagedLaunchPlan } from './managedCli/managedLauncher';

export interface CodexProgramLaunchDeps {
  resolver: Pick<CliRuntimeResolver, 'start'>;
  /** A managed start failed at the program's own level; called once per failed start. */
  managedStartFailed(plan: ManagedLaunchPlan, failure: CodexProgramFailure): void;
}

/** The program's own failures among the preflight's refusals; a missing login is the environment's. */
function preflightFailure(error: unknown): CodexProgramFailure | undefined {
  if (!(error instanceof CodexPreflightError)) return undefined;
  switch (error.kind) {
    case 'not-configured':
    case 'did-not-run':
      return { kind: 'spawn-error', detail: error.message };
    case 'exited':
      return { kind: 'exit-before-ready', detail: error.message };
    case 'version':
      return { kind: 'version-mismatch', detail: error.message };
    case 'login':
      return undefined;
  }
}

export async function launchCodexProgram(deps: CodexProgramLaunchDeps, sessionId: string, start: CodexProgramStart): Promise<CodexProgramLaunch> {
  let plan: ManagedLaunchPlan | undefined;
  let failure: CodexProgramFailure | undefined;
  let launched: Awaited<ReturnType<CliRuntimeResolver['start']>>;
  try {
    launched = await deps.resolver.start({
      provider: 'codex-cli',
      sessionId,
      pin: start.pin,
      onPending: start.onPending,
      beforeStart: start.beforeStart,
    }, async (program) => {
      plan = program.managed;
      let version: string | undefined;
      try {
        version = await start.preflight(program.executable);
      } catch (error) {
        if (plan) failure = preflightFailure(error);
        throw error;
      }
      if (plan && version !== plan.entry.version) {
        failure = { kind: 'version-mismatch', detail: `it reported ${version ? `version ${version}` : 'no version'}, not ${plan.entry.version}` };
        throw new Error(`Managed Codex ${plan.entry.version} reported ${version ? `version ${version}` : 'no version'}, so it was not started.`);
      }
      return start.spawn(program.executable, { managed: plan !== undefined });
    });
  } catch (error) {
    if (plan && failure) deps.managedStartFailed(plan, failure);
    throw error;
  }
  const managed = plan;
  return {
    child: launched.child,
    executable: launched.executable,
    identityKey: launched.identityKey,
    release: launched.release,
    ...(managed ? { startFailed: (later: CodexProgramFailure) => deps.managedStartFailed(managed, later) } : {}),
  };
}
