/** First-action measurements only. Silence never interrupts a turn. */
export type FirstActionTool = 'dispatch_task' | 'close_assignment';

export type FirstActionKind = 'delegation-accepted' | 'assignment-closed' | 'terminal-reply';

export type FirstActionGuardState = 'off' | 'armed' | 'candidate' | 'satisfied';

/**
 * What one acceptance trial records about its first action. It is a record of the trial and never a field of a
 * run. The host-deadline variant is retained only for older records. A trial passes only with `source: 'provider'`.
 */
export type FirstActionEvidence =
  | { source: 'provider'; kind: FirstActionKind; latencyMs: number }
  | { source: 'host-deadline'; kind: 'needs-you'; latencyMs: number; silenceBudgetMs?: number;
      deadline?: 'native-compaction'; compactionPauseMs?: number };

const BRIDGED_TEAM_TOOL = /^mcp__unode_team_bridge_[a-f0-9]{32}__(dispatch_task|close_assignment)$/;

/**
 * Whether a tool call, as a route names it, is one of the two calls that can be a first action: the plain name on
 * the in-process and Codex routes, the bridge-qualified name on the Claude CLI route.
 */
export function firstActionToolOf(toolName: string): FirstActionTool | undefined {
  if (toolName === 'dispatch_task' || toolName === 'close_assignment') return toolName;
  return BRIDGED_TEAM_TOOL.exec(toolName)?.[1] as FirstActionTool | undefined;
}

export class FirstActionGuard {
  private current: FirstActionGuardState = 'off';
  private open = 0;

  get state(): FirstActionGuardState { return this.current; }

  arm(): void {
    this.current = 'armed';
    this.open = 0;
  }
  /** Record a first-action candidate; this measurement never refuses an active call. */
  callArrived(): boolean {
    if (this.current === 'armed' || this.current === 'candidate') {
      this.current = 'candidate';
      this.open += 1;
    }
    return true;
  }

  /**
   * The host answered a call that `callArrived` let through. Returns the first action when this call is it. A
   * refusal is not one: the coordinator has to act again, and the guard is armed again once no call is open.
   */
  callAnswered(tool: FirstActionTool, accepted: boolean): FirstActionKind | undefined {
    if (this.current !== 'candidate') return undefined;
    if (accepted) {
      this.current = 'satisfied';
      this.open = 0;
      return tool === 'dispatch_task' ? 'delegation-accepted' : 'assignment-closed';
    }
    this.open = Math.max(0, this.open - 1);
    if (this.open === 0) this.current = 'armed';
    return undefined;
  }

  /** A completed reply can be the first action. */
  turnEnded(withReply: boolean): FirstActionKind | undefined {
    const first = this.current === 'armed' && withReply ? 'terminal-reply' : undefined;
    this.current = 'off';
    this.open = 0;
    return first;
  }

  /** The user stopped the turn. */
  stopped(): void {
    this.current = 'off';
    this.open = 0;
  }

}
