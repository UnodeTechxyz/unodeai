/* A per-agent command ceiling over the live workspace policy. The global policy remains the source of
 * truth and is consulted first for catastrophic patterns and runtime setting changes. */
import { AgentCommandNarrowing } from '../types';
import { CommandApprovalMode, CommandCheckOptions, CommandPolicy, CommandVerdict } from './CommandPolicy';

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
  ) {
    super('none');
  }

  override get approvalMode(): CommandApprovalMode {
    return this.narrowing
      ? narrowerCommandMode(this.globalPolicy.approvalMode, this.narrowing.approvalMode)
      : this.globalPolicy.approvalMode;
  }

  override check(command: string, options?: CommandCheckOptions): CommandVerdict {
    const global = this.globalPolicy.check(command, options);
    if (!this.narrowing) {
      return decorateGlobal(global);
    }
    // A global hard denial (including the non-overridable destructive-pattern block) is authoritative.
    if (!global.allowed && !global.ask) {
      return decorateGlobal(global);
    }

    const mode = narrowerCommandMode(this.globalPolicy.approvalMode, this.narrowing.approvalMode);
    const globalAllowlist = this.globalPolicy.allowedCommands;
    const selected = this.narrowing.allowedCommands.filter((entry) =>
      globalAllowlist.includes(entry.trim().toLowerCase())
    );
    const narrowed = new CommandPolicy(mode, selected).check(command, options);
    if (!narrowed.allowed) {
      if (narrowed.ask) {
        return {
          allowed: false,
          ask: true,
          reason: `agent command narrowing for ${this.agentName} requires approval`,
        };
      }
      return {
        allowed: false,
        reason: `agent command narrowing for ${this.agentName}: ${narrowed.reason ?? 'not allowed'}`,
      };
    }
    // The command passed the agent ceiling; the live global policy still gets the last word.
    return decorateGlobal(global);
  }

  /** The workspace policy reloads itself; an agent policy is only a live view and never mutable state. */
  override reload(_mode: CommandApprovalMode, _allowlist: string[]): void {
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
