/* A per-agent command ceiling over the live workspace policy. The global policy remains the source of
 * truth and is consulted first for catastrophic patterns and runtime setting changes. */
import { AgentCommandNarrowing } from '../types';
import { CommandApprovalMode, CommandCheckOptions, CommandPolicy, CommandPolicyInputs, CommandVerdict } from './CommandPolicy';

const RANK: Record<CommandApprovalMode, number> = { none: 0, allowlist: 1, ask: 2, all: 3 };

export function narrowerCommandMode(globalMode: CommandApprovalMode, requestedMode: CommandApprovalMode): CommandApprovalMode {
  return RANK[requestedMode] <= RANK[globalMode] ? requestedMode : globalMode;
}

/** Concrete subtype keeps every existing command gate on the same interface. */
export class AgentCommandPolicy extends CommandPolicy {
  constructor(
    private readonly globalPolicy: CommandPolicy,
    private readonly narrowing: AgentCommandNarrowing | undefined,
    private readonly agentName: string,
    private readonly review: () => boolean = () => false,
    /**
     * v0.9.106 (F-1): false for a check whose own record in the request already tells the person why it did not run
     * (the PM's host checks); the one-time "Enable Commands" notice is then neither shown nor used up.
     */
    private readonly blockNotice = true,
  ) {
    super('none');
  }

  override get approvalMode(): CommandApprovalMode {
    const mode = this.narrowing
      ? narrowerCommandMode(this.globalPolicy.approvalMode, this.narrowing.approvalMode)
      : this.globalPolicy.approvalMode;
    return mode === 'all' && this.review() ? 'ask' : mode;
  }

  override get revocationRevision(): number { return this.globalPolicy.revocationRevision; }

  override check(command: string, options: CommandCheckOptions): CommandVerdict {
    return this.decide(command, options, this.blockNotice);
  }

  override checkWithoutBlockNotice(command: string, options: CommandCheckOptions): CommandVerdict {
    return this.decide(command, options, false);
  }

  private decide(command: string, options: CommandCheckOptions, blockNotice: boolean): CommandVerdict {
    const global = blockNotice ? this.globalPolicy.check(command, options) : this.globalPolicy.checkWithoutBlockNotice(command, options);
    if (global.dangerous) return global;
    if (!this.narrowing) {
      return this.withReview(command, options, decorateGlobal(global));
    }
    // A global hard denial (including the non-overridable destructive-pattern block) is authoritative.
    if (!global.allowed && !global.ask) {
      return decorateGlobal(global);
    }

    const mode = narrowerCommandMode(this.globalPolicy.approvalMode, this.narrowing.approvalMode);
    // The ceiling is the workspace allowlist of THIS command's grammar: a selected template approved for the
    // project in PowerShell is no grant for the same template in cmd.exe.
    const ceiling = this.globalPolicy.allowlistFor(options.shell.grammar);
    const selected = this.narrowing.allowedCommands.filter((entry) =>
      ceiling.includes(entry.trim().toLowerCase())
    );
    const narrowed = new CommandPolicy(mode, selected).check(command, options);
    if (!narrowed.allowed) {
      if (narrowed.ask) {
        return {
          allowed: false,
          ask: true,
          ...(narrowed.opaque ? { opaque: true } : {}),
          reason: `agent command narrowing for ${this.agentName} requires approval`,
        };
      }
      return {
        allowed: false,
        ...(narrowed.opaque ? { opaque: true } : {}),
        reason: `agent command narrowing for ${this.agentName}: ${narrowed.reason ?? 'not allowed'}`,
      };
    }
    // The command passed the agent ceiling; the live global policy still gets the last word.
    return this.withReview(command, options, decorateGlobal(global));
  }

  /**
   * An explicit grant as this agent sees it: the live global grants, or, under a narrowing, only the selected
   * templates the workspace still grants for this grammar. Off grants nothing.
   */
  override explicitlyGranted(command: string, options: CommandCheckOptions): boolean {
    if (this.approvalMode === 'none') return false;
    if (!this.narrowing) return this.globalPolicy.explicitlyGranted(command, options);
    const ceiling = this.globalPolicy.allowlistFor(options.shell.grammar);
    const selected = this.narrowing.allowedCommands.filter((entry) => ceiling.includes(entry.trim().toLowerCase()));
    return new CommandPolicy('allowlist', selected).explicitlyGranted(command, options);
  }

  private withReview(command: string, options: CommandCheckOptions, verdict: CommandVerdict): CommandVerdict {
    if (!verdict.allowed || !this.review()) return verdict;
    return new CommandPolicy('ask', { configured: this.globalPolicy.allowedCommands,
      project: this.globalPolicy.projectApprovals }).check(command, options);
  }

  /** The workspace policy reloads itself; an agent policy is only a live view and never mutable state. */
  override reload(_mode: CommandApprovalMode, _inputs: CommandPolicyInputs | readonly string[]): void {
    // Intentionally inert. Calling reload on this wrapper must not widen or mutate the global policy.
  }
}

function decorateGlobal(verdict: CommandVerdict): CommandVerdict {
  if (verdict.allowed) {
    return verdict;
  }
  return {
    ...verdict,
    reason: verdict.ask
      ? 'global command policy requires approval'
      : `global command policy: ${verdict.reason ?? 'not allowed'}`,
  };
}
