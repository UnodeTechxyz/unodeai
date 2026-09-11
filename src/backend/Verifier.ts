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

import { CommandRunner } from './TeamTools';
import { CommandPolicy } from './CommandPolicy';
import { gateShellCommand } from './ShellCommandGate';

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

export interface VerifierOptions {
  /** Read LIVE (thunk) so toggling `unode.verifyCommand` applies without a restart. */
  command: () => string;
  /** How the command runs (spawn in `cwd`). Injected so tests need no real build. */
  run: CommandRunner;
  /** Shared command gate; a blocked verify command can't run, so it's reported as 'skipped'. */
  commandPolicy?: CommandPolicy;
  /** Non-blocking warning when a configured verify command names a path outside the workspace/worktree. */
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
}

export class Verifier {
  constructor(private readonly opts: VerifierOptions) {}

  /**
   * Run the verify command in `cwd`.
   *   passed  — exit 0.
   *   failed  — non-zero exit (the gate blocks the merge).
   *   skipped — no command configured, or policy blocked it: the caller can't gate on it, so it
   *             should fall through (don't block work just because there's nothing to verify with).
   */
  async verify(cwd: string): Promise<VerifyResult> {
    const command = (this.opts.command() || '').trim();
    if (!command) {
      return { status: 'skipped', command: '', output: 'No verify command configured (set unode.verifyCommand, e.g. "npm test" or "npx tsc --noEmit").' };
    }
    const gate = await gateShellCommand({
      command,
      roots: cwd,
      source: 'config',
      commandPolicy: this.opts.commandPolicy,
      onConfigOutsideRoot: this.opts.onConfigOutsideRoot,
    });
    if (!gate.ok) {
      // The gate runs unattended (mid-merge), so it can't surface an approval prompt — and it must NOT
      // silently auto-run a command the user hasn't approved (a workspace-set unode.verifyCommand could
      // be hostile). Consistent with run_checks (blocks when not allowed): skip and tell the user how
      // to enable it. Common build/test commands are in the default allowlist, so they still run.
      const output = gate.reason === 'awaiting user approval'
        ? `Verify command "${command}" needs approval and the gate can't prompt during a merge. Add it to unode.allowedCommands (or adjust unode.commandApproval) to gate on it.`
        : `Verify command blocked by unode.commandApproval: ${gate.reason ?? 'not allowed'}`;
      return { status: 'skipped', command, output, blocked: true };
    }
    const { code, output } = await this.opts.run(command, cwd);
    const tail = output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
    return { status: code === 0 ? 'passed' : 'failed', command, output: tail };
  }
}
