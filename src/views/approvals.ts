/*---------------------------------------------------------------------------------------------
 *  UnodeAi - in-panel approvals (vscode-free core)
 *  The request/response queue behind the chat panel's approval cards (replacing native modals).
 *  Kept vscode-free so the queue logic is unit-tested without the editor.
 *--------------------------------------------------------------------------------------------*/

export type ApprovalKind = 'command' | 'write' | 'tool';

export interface ApprovalSettings {
  /** unode.commandApproval: none | ask | allowlist | all */
  command: string;
  /** unode.writeApproval: none | ask */
  write: string;
}

/** A pending action awaiting the user's in-panel approval. */
export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  /** Stable agent identity for host-level subscribers; display text remains agentName. */
  agentId?: string;
  /** The session that owns this request. Today it is normally the agent id, but it is explicit for clients. */
  sessionId?: string;
  agentName: string;
  /** command kind */
  command?: string;
  template?: string;
  /** write kind */
  path?: string;
  verb?: 'create' | 'overwrite';
  diff?: string;
  /** Claude native external-effect or newly discovered tool approval. */
  toolName?: string;
  toolDetail?: string;
  /** Web egress is granted to the entire crew for this extension-host session, never persisted. */
  crewSessionWebAccess?: boolean;
  /**
   * A command matched the reviewed built-in safe list, but that list is not enabled yet. This is an
   * explicit offer, never an implicit grant: the human may enable the list for this workspace or
   * choose the ordinary once/session/project/deny actions instead.
   */
  safeCommandOffer?: boolean;
  /**
   * Why this action is being surfaced when policy alone would not have surfaced it — e.g. the command
   * names a path outside the agent's folder. A heuristic that spots something suspicious escalates to
   * the human rather than refusing on its own; this is the sentence the human decides on.
   */
  warning?: string;
}

/** The user's answer. `action` is kind-specific; `note` is an optional deny reason for the agent. */
export interface ApprovalDecision {
  action: string;
  note?: string;
}

/** Host-attached actor identity. An expired request has no approver and therefore omits the field. */
export interface ResolvedApprovalDecision extends ApprovalDecision {
  /** Opaque host correlation for the request that settled. Never sent to the webview. */
  approvalId: string;
  /** A timeout is distinct from a human denial even though the caller must fail closed as `deny`. */
  expired?: true;
  approverId?: string;
}

/** A renderer-neutral description of what is awaiting a human decision. */
export interface ApprovalAction {
  kind: ApprovalKind;
  summary: string;
  target?: string;
}

/** Stable identity carried across the host event seam. It contains no VS Code object or URI. */
export interface ApprovalAgentIdentity {
  id: string;
  name: string;
}

export interface PendingApprovalEvent {
  type: 'pending';
  approval: {
    id: string;
    agent: ApprovalAgentIdentity;
    sessionId: string;
    action: ApprovalAction;
    requestedAt: string;
    /** ISO timestamp for bounded prompts, otherwise explicitly null (no invented deadline). */
    deadline: string | null;
  };
}

export interface DecidedApprovalEvent {
  type: 'decided';
  approvalId: string;
  agent: ApprovalAgentIdentity;
  sessionId: string;
  decision: ApprovalDecision;
  /** Every local decision names the actor now, before shared folders make this load-bearing. */
  approverId: string;
  decidedAt: string;
}

export interface ExpiredApprovalEvent {
  type: 'expired';
  approvalId: string;
  agent: ApprovalAgentIdentity;
  sessionId: string;
  expiredAt: string;
}

/**
 * Transport-neutral approval lifecycle. UI surfaces subscribe to this; none of them own the decision.
 * Keep this module VS Code-free so a future web/mobile transport can subscribe without a UI rewrite.
 */
export type ApprovalEvent = PendingApprovalEvent | DecidedApprovalEvent | ExpiredApprovalEvent;

/** Renderer-neutral derived state for a roster or notification subscriber. */
export interface ApprovalAttention {
  state: 'waiting' | 'timed_out';
  approvalId?: string;
  actionSummary?: string;
}

interface PendingResolver {
  resolve: (decision: ResolvedApprovalDecision) => void;
  request: ApprovalRequest;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Queue of pending approvals, each tied to a promise resolved when the user decides. `onChange` fires
 * whenever the visible queue changes so the host can re-render. Disposing denies anything still pending
 * so a torn-down panel never hangs the agent waiting on it.
 */
export class ApprovalQueue {
  private queue: ApprovalRequest[] = [];
  private resolvers = new Map<string, PendingResolver>();
  private seq = 0;

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly onEvent: (event: ApprovalEvent) => void = () => {},
  ) {}

  /** Enqueue a request and return the promise that resolves with the user's decision. A bounded prompt is
   * removed and denied cleanly on lapse, so an approval UI can never silently pin a caller forever. */
  request(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): Promise<ApprovalDecision> {
    return this.requestWithIdentity(req, timeoutMs).then(({ action, note }) => ({
      action,
      ...(note ? { note } : {}),
    }));
  }

  /** Same queue operation for host audit callers that need the actor attached by resolve(). */
  requestWithIdentity(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): Promise<ResolvedApprovalDecision> {
    const id = `appr-${++this.seq}-${Date.now()}`;
    const full = { ...req, id } as ApprovalRequest;
    const requestedAt = new Date().toISOString();
    const deadline = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Date(Date.now() + timeoutMs).toISOString()
      : null;
    return new Promise<ResolvedApprovalDecision>((resolve) => {
      const entry: PendingResolver = { resolve, request: full };
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.expire(id);
        }, timeoutMs);
      }
      this.resolvers.set(id, entry);
      this.queue.push(full);
      this.onEvent({
        type: 'pending',
        approval: {
          id,
          agent: approvalAgent(full),
          sessionId: approvalSessionId(full),
          action: approvalAction(full),
          requestedAt,
          deadline,
        },
      });
      this.onChange();
    });
  }

  /** Resolve a pending request by id. Returns true if it was pending (false if unknown/already done). */
  resolve(id: string, decision: ApprovalDecision, approverId = 'local-user'): boolean {
    const entry = this.resolvers.get(id);
    if (!entry) {
      return false;
    }
    this.resolvers.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.queue = this.queue.filter((a) => a.id !== id);
    entry.resolve({
      ...decision,
      approvalId: id,
      // System shutdown is a fail-closed outcome, not a human approver. Keep the lifecycle actor in the
      // live event while refusing to turn it into a durable human-approval claim.
      ...(!approverId.startsWith('system:') ? { approverId } : {}),
    });
    this.onEvent({
      type: 'decided',
      approvalId: id,
      agent: approvalAgent(entry.request),
      sessionId: approvalSessionId(entry.request),
      decision,
      approverId,
      decidedAt: new Date().toISOString(),
    });
    this.onChange();
    return true;
  }

  /** Fail closed on a bounded human window while retaining an explicit expired lifecycle event. */
  private expire(id: string): boolean {
    const entry = this.resolvers.get(id);
    if (!entry) {
      return false;
    }
    this.resolvers.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.queue = this.queue.filter((a) => a.id !== id);
    entry.resolve({ action: 'deny', note: 'The approval window expired.', approvalId: id, expired: true });
    this.onEvent({
      type: 'expired',
      approvalId: id,
      agent: approvalAgent(entry.request),
      sessionId: approvalSessionId(entry.request),
      expiredAt: new Date().toISOString(),
    });
    this.onChange();
    return true;
  }

  /** The current visible queue (for rendering). */
  list(): ApprovalRequest[] {
    return this.queue;
  }

  /** Count of still-unresolved requests. */
  pendingCount(): number {
    return this.resolvers.size;
  }

  /** Deny everything still pending (on dispose) so no awaiting agent hangs. */
  denyAll(): void {
    for (const id of [...this.resolvers.keys()]) {
      this.resolve(id, { action: 'deny' }, 'system:host-disposed');
    }
  }
}

function approvalAgent(request: ApprovalRequest): ApprovalAgentIdentity {
  return {
    id: request.agentId || request.agentName,
    name: request.agentName,
  };
}

function approvalSessionId(request: ApprovalRequest): string {
  return request.sessionId || request.agentId || request.agentName;
}

function approvalAction(request: ApprovalRequest): ApprovalAction {
  switch (request.kind) {
    case 'command':
      return { kind: 'command', summary: 'Run a command', target: request.command || request.template };
    case 'write':
      return { kind: 'write', summary: `${request.verb || 'write'} a workspace path`, target: request.path };
    case 'tool':
      return { kind: 'tool', summary: `Use ${request.toolName || 'a tool'}`, target: request.toolName };
  }
}
