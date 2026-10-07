/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Completion gate (verifier-as-gate, default path)
 *  The moat: a coordinator (PM) cannot report a goal "done" while the objective project checks
 *  (run_checks: build/type-check/test) are RED. This is the deterministic decision core only —
 *  pure, no I/O — so the deadlock-safety is unit-provable. The backend/orchestrator wires the
 *  async check run + retry/redelegate/handoff around it.
 *
 *  Deadlock guarantee: every failing cycle strictly increments `attempts`; once the bounded budget
 *  (self-fix retries + redelegations) is spent the only remaining outcome is `handoff` — a TERMINAL
 *  state that pauses for the human. There is no path that returns `retry` forever.
 *--------------------------------------------------------------------------------------------*/

/** What the runtime should do after evaluating the gate. */
export type CompletionGateOutcome =
  /** Checks are green (or the gate is disabled / inapplicable) → the goal may be reported done. */
  | { kind: 'pass' }
  /** Checks are red and budget remains → run one more fix cycle. `escalate` = route the fix to a
   *  stronger model/different teammate (redelegation tier of the ladder), not the same weak attempt. */
  | { kind: 'retry'; attempt: number; escalate: boolean }
  /** Budget spent → stop the loop and hand back to the human (suggest help / reassign). Terminal. */
  | { kind: 'handoff'; attempts: number };

export interface CompletionGateConfig {
  /** Same-target fix cycles before we change strategy. Default 2. */
  maxSelfRetries: number;
  /** Stronger-model / redelegated fix cycles after self-retries are spent. Default 1. */
  maxRedelegations: number;
}

export const DEFAULT_COMPLETION_GATE_CONFIG: CompletionGateConfig = {
  maxSelfRetries: 2,
  maxRedelegations: 1,
};

/** Total fix cycles the ladder will ever attempt before forcing a human handoff. */
export function maxGateAttempts(cfg: CompletionGateConfig): number {
  return Math.max(0, cfg.maxSelfRetries) + Math.max(0, cfg.maxRedelegations);
}

/**
 * Pure gate decision.
 * @param checksPassed whether the objective checks are currently green.
 * @param attempts how many fix cycles have ALREADY completed (0 = this is the first failure seen).
 *
 * Ladder: [0 .. maxSelfRetries)        → retry on the same target (escalate:false)
 *         [maxSelfRetries .. total)     → retry redelegated/stronger (escalate:true)
 *         >= total                      → handoff (terminal — never loops)
 */
export function decideCompletionGate(
  checksPassed: boolean,
  attempts: number,
  cfg: CompletionGateConfig = DEFAULT_COMPLETION_GATE_CONFIG
): CompletionGateOutcome {
  if (checksPassed) {
    return { kind: 'pass' };
  }
  const self = Math.max(0, cfg.maxSelfRetries);
  const total = maxGateAttempts(cfg);
  const done = Math.max(0, attempts);
  if (done >= total) {
    return { kind: 'handoff', attempts: done };
  }
  return { kind: 'retry', attempt: done + 1, escalate: done >= self };
}

/**
 * Detect that a FAILING verify run is the command itself being broken/misconfigured (wrong tool for the
 * project, not installed, missing script) rather than a real code failure — so the gate can stop and point
 * the user at their setting instead of burning fix attempts on a phantom error. Deliberately conservative:
 * only unmistakable "the command can't even run" signatures, never a normal non-zero test/compile failure.
 */
export function isMisconfiguredCheckOutput(output: string): boolean {
  const s = (output ?? '').toLowerCase();
  return (
    s.includes('this is not the tsc command you are looking for') || // npx grabbing the wrong `tsc` shim
    s.includes('command not found') ||                                // POSIX shell
    s.includes('is not recognized as an internal or external command') || // Windows cmd
    s.includes('could not determine executable to run') ||            // npx: no such binary
    s.includes('command "tsc" not found') ||
    /(?:npm err!\s*)?missing script/.test(s)                          // npm/yarn: script not defined
  );
}

/** Message when the verify command itself is misconfigured — point at the SETTING, not at the code. */
export function buildGateMisconfiguredMessage(verifyCommand: string, output: string): string {
  return (
    `⚠ Verification skipped — the configured check \`${verifyCommand}\` can't run in this project ` +
    `(it looks misconfigured, not a code failure). Fix or clear \`unode.verifyCommand\` — point it at this ` +
    `project's real test/build script — then verify again. No code fix was delegated, because there is no ` +
    `code defect here.\n\n--- checks output (tail) ---\n${gateOutputTail(output)}`
  );
}

/** Trim a checks-output blob to a context-safe tail for injecting back into the model. */
export function gateOutputTail(output: string, max = 4000): string {
  const s = output ?? '';
  return s.length > max ? `…\n${s.slice(-max)}` : s;
}

/**
 * The fix obligation injected back into the coordinator when the gate is RED and budget remains.
 * Frames it as a non-optional, objective failure so a weak model can't talk its way past it.
 */
export function buildGateRetryMessage(verifyCommand: string, output: string, escalate: boolean): string {
  const lead = escalate
    ? 'The project checks are STILL failing after earlier fix attempts. Escalate: reassign this fix to a ' +
      'stronger/different teammate (or a higher model tier) and be specific about the failing file(s).'
    : 'The project checks are failing, so the work is NOT done yet. Delegate a focused fix to the right ' +
      'teammate (name the failing file and the exact error), then run the checks again.';
  return (
    `🚦 Verification gate: \`${verifyCommand}\` did not pass.\n\n${lead}\n\n` +
    'Do not report the goal as complete until the checks pass.\n\n' +
    `--- checks output (tail) ---\n${gateOutputTail(output)}`
  );
}

/**
 * The terminal human-handoff message when the ladder is exhausted. Pauses, never abandons: it states
 * what failed and offers concrete next moves (stronger model / reassign / human takeover) so the run
 * ends in an actionable paused state instead of an endless retry loop.
 */
export function buildGateHandoffMessage(verifyCommand: string, attempts: number, output: string): string {
  return (
    `🚧 Blocked — needs a human. The verification checks (\`${verifyCommand}\`) still fail after ` +
    `${attempts} fix attempt${attempts === 1 ? '' : 's'} (self-fix then escalation). I've paused rather ` +
    'than loop forever. Your options:\n' +
    '  1. Have me retry with a stronger model on the implementer.\n' +
    '  2. Reassign the fix to a specific teammate you trust for this area.\n' +
    '  3. Take it over yourself — the latest failing output is below.\n\n' +
    `--- checks output (tail) ---\n${gateOutputTail(output)}`
  );
}
