import type { CommandPolicy } from './CommandPolicy';
import type { CommandShellIdentity } from './CommandShell';
import type { PrepareDirectCommand } from './CommandExecution';
import { gateShellCommand, type CommandApprover, type CommandApprovalDecision } from './ShellCommandGate';
import { admitCompletionVerification, type VerificationAdmissionReaders } from './CompletionVerificationAdmission';
import { sameVerificationBinding, verificationCommandIssueMessage, type VerificationBinding, type VerificationPolicyResolution,
  type VerificationPolicySource } from './CompletionVerificationPolicy';

type NotRunReason = 'disabled' | 'configuration-invalid' | 'not-applicable' | 'policy-stale'
  | 'approval-required' | 'policy-blocked' | 'spawn-failed';
interface OutcomeContext { source: VerificationPolicySource; binding?: VerificationBinding }
interface BoundOutcomeContext { source: VerificationPolicySource; binding: VerificationBinding }
export type VerificationCheckOutcome =
  | (OutcomeContext & { kind: 'not-run'; reason: NotRunReason; detail: string })
  | (BoundOutcomeContext & { kind: 'passed'; command: string; exitCode: 0; output: string })
  | (BoundOutcomeContext & { kind: 'failed'; command: string; reason: 'exit-nonzero' | 'timeout-stopped'; output: string })
  | (BoundOutcomeContext & { kind: 'outcome-unknown'; command: string; output: string });

/** Existing request identities, not a new agent incarnation or persistent team identity. */
export type VerificationRequestIdentity =
  | { readonly kind: 'session'; readonly sessionId: string; readonly requestId: string; readonly attemptId?: string }
  | { readonly kind: 'workflow'; readonly runId: string };

export interface CompletionVerificationCheckOptions {
  resolution: VerificationPolicyResolution;
  cwd: string;
  roots: readonly string[];
  request: VerificationRequestIdentity;
  signal: AbortSignal;
  /** Host-owned, synchronous current state; no source field or caller-provided model text grants authority. */
  currentResolution(): VerificationPolicyResolution;
  /** Re-read the host's strict current team state after asynchronous waits; never grants execution. */
  refreshResolution?: () => Promise<void>;
  isCurrentRequest(request: VerificationRequestIdentity): boolean;
  isTrusted(): boolean;
  directoryAllowed(cwd: string): boolean;
  commandPolicy(): CommandPolicy | undefined;
  prepare: PrepareDirectCommand | undefined;
  requestApproval?: CommandApprover;
  readers?: VerificationAdmissionReaders;
  timeoutMs?: number;
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
}

function shellKey(shell: CommandShellIdentity): string {
  return JSON.stringify([shell.kind, shell.grammar, shell.source, shell.fingerprint, shell.label]);
}

/**
 * A private, one-shot check. Consumers will wire this only after this kernel's code audit.
 * Its short-lived receipt exists only inside run(), never in settings, a team file or a session snapshot.
 */
export function prepareCompletionVerificationCheck(options: CompletionVerificationCheckOptions): {
  run(): Promise<VerificationCheckOutcome>;
} {
  // Copy identity-bearing inputs now, not after any wait, so mutating a UI snapshot cannot rebind the check.
  const resolution: VerificationPolicyResolution = structuredClone(options.resolution);
  const request = Object.freeze({ ...options.request });
  const cwd = options.cwd;
  const roots = [...options.roots];
  const signal = options.signal;
  const identity: OutcomeContext = resolution.kind === 'resolved'
    ? { source: resolution.effective.source, binding: { ...resolution.effective.binding } }
    : { source: resolution.source };
  const notRun = (reason: NotRunReason, detail: string): VerificationCheckOutcome => ({
    ...identity, kind: 'not-run', reason, detail,
  });
  let used = false;

  const refusal = (): VerificationCheckOutcome | undefined => {
    if (signal.aborted || !options.isCurrentRequest(request)) return notRun('policy-stale', 'The original request is no longer active.');
    if (!options.isTrusted() || !options.directoryAllowed(cwd)) return notRun('policy-blocked', 'Current workspace trust or directory scope refuses this check.');
    const current = options.currentResolution();
    if (resolution.kind !== 'resolved' || current.kind !== 'resolved'
      || !sameVerificationBinding(resolution.effective.binding, current.effective.binding)) {
      return notRun('policy-stale', 'The verification policy, source, team kind or workspace changed.');
    }
    if (!options.commandPolicy()) return notRun('policy-blocked', 'No current command policy is available.');
    return undefined;
  };

  return { run: async () => {
    if (used) return notRun('policy-stale', 'This prepared check has already been consumed.');
    used = true; // Consume synchronously, including denied/cancelled runs and concurrent reuse.
    if (resolution.kind === 'configuration-invalid') {
      return notRun('configuration-invalid', resolution.source === 'legacy-global' && resolution.commandIssue
        ? `User Settings: unode.verifyCommand is invalid. ${verificationCommandIssueMessage(resolution.commandIssue)} No fallback is used. Edit User Settings or explicitly choose a team completion policy.`
        : 'The verification configuration is invalid; no fallback is used.');
    }
    const boundIdentity: BoundOutcomeContext = { source: resolution.effective.source, binding: { ...resolution.effective.binding } };
    if (resolution.effective.policy.mode === 'disabled') return notRun('disabled', 'Command checks are disabled for this team.');
    const initialRefusal = refusal();
    if (initialRefusal) return initialRefusal;
    const admitted = await admitCompletionVerification(resolution, cwd, options.readers);
    if (admitted.kind !== 'ready') {
      return notRun('not-applicable', admitted.kind === 'not-applicable' ? admitted.reason : admitted.kind);
    }
    const beforePrepare = refusal();
    if (beforePrepare) return beforePrepare;
    if (!options.prepare) return notRun('spawn-failed', 'No command preparation is available.');
    const prepared = options.prepare();
    if (!prepared.ok) return notRun('spawn-failed', prepared.message);
    const shell = Object.freeze({ ...prepared.shell });
    const command = admitted.command;
    // Exact receipt binding includes the concrete command, entire shell identity, cwd, R6 binding and request.
    const key = JSON.stringify([command, shellKey(shell), cwd, identity.binding, request]);
    let receipt: { key: string; consumed: boolean; singleUse: boolean } | undefined;
    const approve = options.requestApproval;
    const prompt: CommandApprover | undefined = approve ? async (askedCommand, context) => {
      if (refusal() || askedCommand !== command || shellKey(context.shell) !== shellKey(shell)) return { allow: false, withdrawn: true };
      const decision = await approve(askedCommand, {
        ...context,
        warning: [context.warning, `Completion check from ${identity.source}; configuration is not approval. Working directory: ${cwd}`].filter(Boolean).join('\n'),
      });
      if (refusal()) return { allow: false, withdrawn: true };
      if (decision.allow) receipt = { key, consumed: false, singleUse: context.singleUse === true };
      return decision;
    } : undefined;
    const gateOptions = (policy: CommandPolicy) => ({
      command, cwd, roots, source: 'config' as const, shell, signal,
      commandPolicy: policy, onConfigOutsideRoot: options.onConfigOutsideRoot,
    });
    const beforeGate = refusal();
    if (beforeGate) return beforeGate;
    const initialPolicy = options.commandPolicy();
    if (!initialPolicy) return notRun('policy-blocked', 'No current command policy is available.');
    const firstGate = await gateShellCommand({ ...gateOptions(initialPolicy), requestApproval: prompt });
    if (!firstGate.ok) return notRun(firstGate.kind === 'approval' || (firstGate.kind === 'policy' && initialPolicy.check(command, { shell }).ask)
      ? 'approval-required' : 'policy-blocked', firstGate.message);
    const afterApproval = refusal();
    if (afterApproval) return afterApproval;
    try { await options.refreshResolution?.(); }
    catch { return notRun('configuration-invalid', 'The current team configuration could not be read. No fallback is used.'); }
    const afterRefresh = refusal();
    if (afterRefresh) return afterRefresh;
    // Re-read applicability after an approval wait, at the same actual cwd. An auto command cannot silently change.
    const currentAdmission = await admitCompletionVerification(options.currentResolution(), cwd, options.readers);
    const afterManifest = refusal();
    if (afterManifest) return afterManifest;
    if (currentAdmission.kind !== 'ready' || currentAdmission.command !== command) {
      return notRun('not-applicable', 'Command applicability changed while the check was being prepared.');
    }
    const consumeReceipt: CommandApprover = async (askedCommand, context): Promise<CommandApprovalDecision> => {
      if (!refusal() && receipt && !receipt.consumed && receipt.key === key
        && askedCommand === command && shellKey(context.shell) === shellKey(shell)
        && receipt.singleUse === (context.singleUse === true)) {
        receipt.consumed = true;
        return { allow: true };
      }
      return { allow: false };
    };
    // No second human prompt. A current hard denial dominates; a still-ask verdict needs this invocation's receipt.
    const recheckPolicy = options.commandPolicy();
    if (!recheckPolicy) return notRun('policy-blocked', 'No current command policy is available.');
    const secondGate = await gateShellCommand({ ...gateOptions(recheckPolicy), requestApproval: consumeReceipt });
    if (!secondGate.ok) return notRun(secondGate.kind === 'approval' ? 'approval-required' : 'policy-blocked', secondGate.message);
    try { await options.refreshResolution?.(); }
    catch { return notRun('configuration-invalid', 'The current team configuration could not be read. No fallback is used.'); }
    const finalRefusal = refusal();
    if (finalRefusal) return finalRefusal;
    const policy = options.commandPolicy();
    if (!policy) return notRun('policy-blocked', 'No current command policy is available.');
    const verdict = policy.check(command, { shell });
    if (!verdict.allowed && !(verdict.ask && receipt?.consumed && receipt.key === key)) {
      return notRun(verdict.ask ? 'approval-required' : 'policy-blocked', 'Current command permission does not authorize this check.');
    }
    // No asynchronous boundary between final state checks and the existing prepared executor's own start guards.
    try {
      const result = await prepared.execute(command, {
        cwd, signal, timeoutMs: options.timeoutMs ?? 300_000, maxOutputChars: 8000,
      });
      switch (result.status) {
        case 'running':
          await result.continuation.stop();
          return { ...boundIdentity, kind: 'outcome-unknown', command, output: result.output };
        case 'not-started': return notRun('spawn-failed', result.output);
        case 'outcome-unknown': return { ...boundIdentity, kind: 'outcome-unknown', command, output: result.output };
        case 'timed-out': return { ...boundIdentity, kind: 'failed', reason: 'timeout-stopped', command, output: result.output };
        case 'exited':
          if (result.code === null) return { ...boundIdentity, kind: 'outcome-unknown', command, output: result.output };
          return result.code === 0
            ? { ...boundIdentity, kind: 'passed', command, exitCode: 0, output: result.output }
            : { ...boundIdentity, kind: 'failed', reason: 'exit-nonzero', command, output: result.output };
      }
    } catch {
      // An unexpected executor rejection does not prove that no process/effect existed.
      return { ...boundIdentity, kind: 'outcome-unknown', command, output: 'The executor did not report an observable outcome.' };
    }
  } };
}

/** No configuration, approval or unknown outcome consumes an implementation-fix attempt. */
export function verificationUsesRepairBudget(outcome: VerificationCheckOutcome): boolean {
  return outcome.kind === 'failed';
}
