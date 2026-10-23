/**
 * The first-action guard of a coordinator's turn.
 *
 * A coordinator that receives a top-level request has to do one of three things first: get a `dispatch_task`
 * accepted, get a `close_assignment` accepted, or end the turn with a reply. Until then the provider may not stay
 * silent for longer than the budget in one unbroken stretch. The guard applies only before that first action; it
 * is not a timeout for the work that follows.
 *
 * This is the state machine alone. It holds no clock and no timer: its caller reads the provider's silence from
 * the turn's timing tracker, where a running tool and an open approval already pause it, and tells the guard what
 * happened.
 *
 *   off ─────── a coordinator turn from a top-level request begins ──> armed
 *   armed ───── a dispatch_task or close_assignment call arrives ───> candidate
 *   armed ───── the turn ends with a reply ─────────────────────────> off      (first action: terminal-reply)
 *   armed ───── one silence reaches the budget ─────────────────────> expired
 *   candidate ─ the host accepts a call ────────────────────────────> satisfied
 *   candidate ─ the host has refused every open call ───────────────> armed
 *   armed, candidate ── the user stops the turn ────────────────────> off
 */

/** One unbroken provider silence, before the first action, that ends the attempt. */
export const FIRST_ACTION_SILENCE_BUDGET_MS = 60_000;

export type FirstActionTool = 'dispatch_task' | 'close_assignment';

export type FirstActionKind = 'delegation-accepted' | 'assignment-closed' | 'terminal-reply';

export type FirstActionGuardState = 'off' | 'armed' | 'candidate' | 'satisfied' | 'expired';

/**
 * What one acceptance trial records about its first action. It is a record of the trial and never a field of a
 * run: when the deadline fires, no run exists. A trial passes only with `source: 'provider'`.
 */
export type FirstActionEvidence =
  | { source: 'provider'; kind: FirstActionKind; latencyMs: number }
  | { source: 'host-deadline'; kind: 'needs-you'; latencyMs: number };

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
  /** First-action calls that reached the host and have no answer yet. */
  private open = 0;

  constructor(private readonly budgetMs: number = FIRST_ACTION_SILENCE_BUDGET_MS) {}

  get state(): FirstActionGuardState {
    return this.current;
  }

  /** A coordinator turn from a top-level request begins. Nothing of an earlier turn is kept. */
  arm(): void {
    this.current = 'armed';
    this.open = 0;
  }

  /**
   * A `dispatch_task` or `close_assignment` call reached the host. The provider has acted, so the budget stops
   * while the host decides. False means the attempt has expired: the call belongs to a turn the host already
   * ended, and it must be refused without running.
   */
  callArrived(): boolean {
    if (this.current === 'expired') return false;
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

  /**
   * The turn ended. With a reply and no accepted call before it, the reply is the first action. A turn the
   * deadline ended stays expired, so a call that arrives late from it is still refused.
   */
  turnEnded(withReply: boolean): FirstActionKind | undefined {
    if (this.current === 'expired') return undefined;
    const first = this.current === 'armed' && withReply ? 'terminal-reply' : undefined;
    this.current = 'off';
    this.open = 0;
    return first;
  }

  /** The user stopped the turn. A deliberate stop is not a deadline, and an expired attempt stays expired. */
  stopped(): void {
    if (this.current === 'expired') return;
    this.current = 'off';
    this.open = 0;
  }

  /**
   * `silenceMs` is the provider's current unbroken silence, or undefined while none is running. True exactly
   * once, when an armed guard's silence has reached the budget: the caller then ends the attempt. While a call is
   * with the host, after the first action, and after a stop, nothing expires.
   */
  expireIfSilent(silenceMs: number | undefined): boolean {
    if (this.current !== 'armed' || silenceMs === undefined || silenceMs < this.budgetMs) return false;
    this.current = 'expired';
    this.open = 0;
    return true;
  }
}
