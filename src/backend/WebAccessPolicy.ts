/*---------------------------------------------------------------------------------------------
 *  UnodeAi - route-neutral public-web access policy
 *
 *  Public web reads are egress: a URL may itself contain sensitive data.  This small, VS Code-free
 *  module is deliberately shared by the gateway (`fetch_url`) and Claude Headless native web tools so
 *  a connection choice cannot silently change the user's web-access policy.
 *--------------------------------------------------------------------------------------------*/

export type WebAccessPolicy = 'ask' | 'allow' | 'off';

export interface WebAccessDecision {
  allow: boolean;
  /** Human-readable denial that is safe to return to a model. */
  reason?: string;
  /** An allow may be remembered only for the current extension-host session. */
  remember?: boolean;
}

export interface WebAccessApprovalRequest {
  /** Stable host identity, distinct from the display name and free of VS Code types. */
  agentId?: string;
  /** Explicit session identity for the approval event seam. */
  sessionId?: string;
  agentName: string;
  /** Native Claude tool name or `fetch_url` on an OpenAI-compatible route. */
  toolName: string;
  /** A public URL is shown only for fetches. WebSearch has no single destination URL. */
  url?: string;
}

export interface WebAccessPolicyGate {
  /** Read live: changing the workspace setting affects already-running agents. */
  policy: () => unknown;
  /** The host-owned crew/session approval surface. */
  requestApproval: (request: WebAccessApprovalRequest) => Promise<WebAccessDecision>;
}

/**
 * A bounded human window for the supported "send it and work elsewhere" flow. It is deliberately
 * independent of the seconds-scale loopback liveness clock used by the local Claude tool-gate transport.
 */
export const WEB_ACCESS_HUMAN_WINDOW_MS = 15 * 60 * 1000;

/**
 * A backend's own approval timer is only a last-resort net: the host approval broker owns the card and its
 * deadline. The net fires this much later than the same human window, so the broker, which settles the card
 * and the decision together, always settles first (v0.9.88).
 */
export const APPROVAL_TIMER_GRACE_MS = 5_000;

export function normalizeWebAccessPolicy(value: unknown): WebAccessPolicy {
  return value === 'allow' || value === 'off' ? value : 'ask';
}

/**
 * The policy-only part of the decision table. `undefined` means `ask`: the host approval surface must
 * decide. Both backends call this exact function before they can perform a web read.
 */
export function resolveWebAccessPolicy(value: unknown, canRead: boolean): WebAccessDecision | undefined {
  if (!canRead) {
    return {
      allow: false,
      reason: "This agent's connection does not grant the read capability required for public web access.",
    };
  }
  switch (normalizeWebAccessPolicy(value)) {
    case 'allow':
      return { allow: true };
    case 'off':
      return {
        allow: false,
        reason: 'Public web access is turned off by unode.webAccess.',
      };
    case 'ask':
      return undefined;
  }
}

/**
 * One extension-host session authority for all crew members and both routes. Concurrent first requests
 * share a single visible prompt; only an explicit "always" allow survives for later requests.
 */
export class SessionWebAccessApprover {
  private remembered: WebAccessDecision | undefined;
  private pending: Promise<WebAccessDecision> | undefined;

  constructor(
    private readonly prompt: (request: WebAccessApprovalRequest) => Promise<WebAccessDecision>,
    /**
     * Join the prompt that is already open for another agent, so this agent waits on the same human decision
     * as its own participant: it shows "Waiting on your approval", and it can leave (Stop) without ending the
     * wait for anyone else. Undefined when no prompt is open (v0.9.88).
     */
    private readonly join?: (request: WebAccessApprovalRequest) => Promise<WebAccessDecision> | undefined,
  ) {}

  requestApproval = async (request: WebAccessApprovalRequest): Promise<WebAccessDecision> => {
    if (this.remembered) {
      return this.remembered;
    }
    const joined = this.join?.(request);
    if (joined) {
      return this.record(joined);
    }
    if (this.pending) {
      return this.pending;
    }
    const pending = this.record(this.prompt(request));
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    }
  };

  /** Normalize one participant's answer. An explicit crew-wide allow is remembered from whichever arrives. */
  private record(decision: Promise<WebAccessDecision>): Promise<WebAccessDecision> {
    return decision
      .then((answer) => {
        const normalized: WebAccessDecision = {
          allow: answer.allow === true,
          ...(answer.reason?.trim() ? { reason: answer.reason.trim() } : {}),
          ...(answer.remember === true ? { remember: true } : {}),
        };
        if (normalized.allow && normalized.remember) {
          this.remembered = normalized;
        }
        return normalized;
      })
      .catch(() => ({ allow: false, reason: 'Web access approval could not be completed, so access was denied.' }));
  }

  /** Test/support hook; a new extension activation normally constructs a new approver instead. */
  clear(): void {
    this.remembered = undefined;
    this.pending = undefined;
  }
}
