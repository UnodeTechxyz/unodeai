/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Verifier (v0.7.0 verifier-as-gate)
 *  Runs the project's own verification (build / type-check / test, via `unode.verifyCommand`) in a
 *  given directory and reports pass / fail. This is the engine behind making verification a
 *  COMPLETION/MERGE condition rather than a nudge: the WorktreeCoordinator runs it in a worker's
 *  worktree before merging, so a crew only lands work that passes your project's checks.
 *
 *  Pure and injectable (no vscode): the command is read live (thunk) and the runner + policy are
 *  passed in, so it's unit-testable and shares CommandPolicy with the rest of the tool surface.
 *--------------------------------------------------------------------------------------------*/

import { CommandPolicy } from './CommandPolicy';
import { gateShellCommand } from './ShellCommandGate';
import { describeShell } from './CommandShell';
import type { PrepareDirectCommand } from './CommandExecution';
import { createDirectCommandPreparer } from './DirectCommandExecution';

export type VerifyStatus = 'passed' | 'failed' | 'skipped';

export interface VerifyResult {
  status: VerifyStatus;
  /** The command that ran (empty when skipped for lack of one). */
  command: string;
  /** Bounded tail of the command output (empty for skipped). */
  output: string;
  /** True when a CONFIGURED verify command couldn't run because command policy blocked it. Distinct
   *  from a plain `skipped` (no command at all): a blocked verify must NOT let work merge as if passed. */
  blocked?: boolean;
}

/** Cap verify output fed back to an agent / shown in the review board, to bound context/UI. */
const MAX_OUTPUT = 8000;
/** The default wall clock of one verification run. */
const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;

export interface VerifierOptions {
  /** Read LIVE (thunk) so toggling `unode.verifyCommand` applies without a restart. */
  command: () => string;
  /**
   * v0.9.96: prepares the declared direct shell. The same preparation is gated and runs the command, so the
   * gate and the executor never see two shells. Injected so tests need no real build.
   */
  prepare?: PrepareDirectCommand;
  /** Read live: the wall clock of one run; the whole tree is stopped and observed when it passes. */
  timeoutMs?: () => number;
  /** The output kept, head and tail. */
  maxOutputChars?: number;
  /** Shared command gate; a blocked verify command can't run, so it's reported as 'skipped'. */
  commandPolicy?: CommandPolicy;
  /** Non-blocking warning when a configured verify command names a path outside the workspace/worktree. */
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
  /** Told when policy blocks the configured command, so the person sees it too. */
  onCommandBlocked?: (reason: string) => void;
}

const defaultPreparer = createDirectCommandPreparer();

export class Verifier {
  constructor(private readonly opts: VerifierOptions) {}

  /**
   * Run the verify command in `cwd`.
   *   passed  — an observed exit 0. Nothing else is ever a pass.
   *   failed  — a non-zero exit, a timeout, or an outcome that could not be observed (the gate blocks the merge;
   *             `blocked` marks the cases where the command could not run or its outcome is unknown).
   *   skipped — no command configured, or policy blocked it: the caller can't gate on it, so it
   *             should fall through (don't block work just because there's nothing to verify with).
   */
  async verify(cwd: string): Promise<VerifyResult> {
    const command = (this.opts.command() || '').trim();
    if (!command) {
      return { status: 'skipped', command: '', output: 'No verify command configured (set unode.verifyCommand, e.g. "npm test" or "npx tsc --noEmit").' };
    }
    const prepared = (this.opts.prepare ?? defaultPreparer)();
    if (!prepared.ok) {
      return { status: 'failed', command, output: prepared.message, blocked: true };
    }
    const gate = await gateShellCommand({
      command,
      roots: cwd,
      cwd,
      source: 'config',
      shell: prepared.shell,
      commandPolicy: this.opts.commandPolicy,
      onConfigOutsideRoot: this.opts.onConfigOutsideRoot,
    });
    if (!gate.ok) {
      // The gate runs unattended (mid-merge), so it can't surface an approval prompt — and it must NOT
      // silently auto-run a command the user hasn't approved (a workspace-set unode.verifyCommand could
      // be hostile). Consistent with run_checks (blocks when not allowed): skip and tell the user how
      // to enable it. An approval is kept for one shell grammar, so the remedy names the one this gate needs.
      this.opts.onCommandBlocked?.(gate.reason ?? 'command execution is disabled');
      const output = gate.reason === 'awaiting user approval'
        ? `Verify command "${command}" needs approval and the gate can't prompt during a merge. It runs in ${describeShell(prepared.shell)}. Approve the same command once through coordinator run_checks, which runs in that shell, or add it to "unode.allowedCommands", before relying on this gate.`
        : `Verify command blocked by unode.commandApproval: ${gate.reason ?? 'not allowed'}`;
      return { status: 'skipped', command, output, blocked: true };
    }
    const maxOutputChars = this.opts.maxOutputChars ?? MAX_OUTPUT;
    const timeoutMs = this.opts.timeoutMs?.() ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const result = await prepared.execute(command, { cwd, timeoutMs, maxOutputChars });
    switch (result.status) {
      case 'exited':
        return { status: result.code === 0 ? 'passed' : 'failed', command, output: result.output };
      case 'timed-out':
        return {
          status: 'failed',
          command,
          output: `${result.output}\n[verify timed out after ${Math.round(timeoutMs / 1000)}s and its process tree was stopped — ensure unode.verifyCommand exits (e.g. not a watch mode) and doesn't wait for input]`.trimStart(),
        };
      case 'not-started':
        return result.reason === 'environment-changed'
          ? { status: 'skipped', command, output: result.output, blocked: true }
          : { status: 'failed', command, output: result.output, blocked: true };
      case 'outcome-unknown':
        // Never merge evidence: the run's outcome was not observed.
        return { status: 'failed', command, output: result.output, blocked: true };
    }
  }
}
