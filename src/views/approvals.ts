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
  /** This request may be approved only once; no session/project/tool-wide grant is offered. */
  singleUseOnly?: boolean;
  /** Recovery for a Codex auto-review denial; wording must not imply a broader grant. */
  approveAnyway?: boolean;
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

/** Every session waiting on the prompt left (Stop) before anyone decided; the prompt is gone, nothing was granted. */
export interface WithdrawnApprovalEvent {
  type: 'withdrawn';
  approvalId: string;
  agent: ApprovalAgentIdentity;
  sessionId: string;
  withdrawnAt: string;
}

/**
 * Transport-neutral approval lifecycle. UI surfaces subscribe to this; none of them own the decision.
 * Keep this module VS Code-free so a future web/mobile transport can subscribe without a UI rewrite.
 */
export type ApprovalEvent = PendingApprovalEvent | DecidedApprovalEvent | ExpiredApprovalEvent | WithdrawnApprovalEvent;

/** Renderer-neutral derived state for a roster or notification subscriber. */
export interface ApprovalAttention {
  state: 'waiting' | 'timed_out';
  approvalId?: string;
  actionSummary?: string;
}

/** Why a prompt, or one participant's wait, ended. Only `human` can ever carry an allow. */
export type ApprovalSettledBy = 'human' | 'expired' | 'withdrawn' | 'host-disposed';

/** What one waiting request receives. */
export interface ParticipantOutcome extends ResolvedApprovalDecision {
  settledBy: ApprovalSettledBy;
  /** This participant's session left (Stop) before a decision; its worker receives a denial. */
  withdrawn?: true;
}

export interface ApprovalBrokerListener {
  onChange?(): void;
  onEvent?(event: ApprovalEvent): void;
  /** A session started (true) or stopped (false) waiting on a human decision. Fired on transitions only. */
  onWaitChange?(sessionId: string, waiting: boolean): void;
}

interface ApprovalParticipant {
  id: string;
  sessionId: string;
  resolve: (outcome: ParticipantOutcome) => void;
}

/** One human prompt, a card or a native modal. Open while it is in the map; it settles at most once. */
interface BrokeredApproval {
  request: ApprovalRequest;
  surface: 'card' | 'modal';
  timer?: ReturnType<typeof setTimeout>;
  participants: Map<string, ApprovalParticipant>;
}

export const APPROVAL_EXPIRED_NOTE = 'The approval window expired.';
export const APPROVAL_WITHDRAWN_NOTE = 'The approval was withdrawn because the agent was stopped.';

/**
 * The one settlement authority for human approvals on every route (v0.9.88).
 *
 * Two layers, because one prompt can be shared by several sessions while each session can leave on its own:
 * - a **prompt** settles at most once, on the first human answer, deadline or disposal. Every participant still
 *   waiting then receives that outcome, and any later answer (a card click after expiry, a native modal answered
 *   after its deadline) is dropped here, before it can reach an approver or a side effect;
 * - a **participant** is one waiting request. `leave(sessionId)` ends that session's participants with a denial
 *   without settling the prompt for anyone else; when the last participant leaves, the prompt is withdrawn.
 *
 * Card clicks, card and modal deadlines, modal answers, Stop and disposal all enter here. The chat panel only
 * renders the open card prompts.
 */
export class ApprovalDecisionBroker {
  private readonly prompts = new Map<string, BrokeredApproval>();
  private readonly listeners = new Set<ApprovalBrokerListener>();
  /** Open participants per session, so the waiting state changes only on 0 <-> 1 transitions. */
  private readonly waiting = new Map<string, number>();
  private seq = 0;
  private participantSeq = 0;

  /**
   * `attention` is the attention entry (v0.9.88 §5.11): called once when a prompt opens, keyed by its id, never
   * when a session joins it or when it settles.
   */
  constructor(private readonly options: { attention?: (key: string) => void } = {}) {}

  subscribe(listener: ApprovalBrokerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Open a prompt with its requester as the first participant. `timeoutMs` bounds the human window: at the
   * deadline the prompt settles as expired. The returned id names the prompt for `join` and `settle`.
   */
  open(
    req: Omit<ApprovalRequest, 'id'>,
    options: { timeoutMs?: number; surface?: 'card' | 'modal' } = {},
  ): { approvalId: string; outcome: Promise<ParticipantOutcome> } {
    const id = `appr-${++this.seq}-${Date.now()}`;
    const request = { ...req, id } as ApprovalRequest;
    const timeoutMs = options.timeoutMs;
    const bounded = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const prompt: BrokeredApproval = { request, surface: options.surface ?? 'card', participants: new Map() };
    this.prompts.set(id, prompt);
    const outcome = this.addParticipant(prompt, approvalSessionId(request));
    if (bounded) {
      prompt.timer = setTimeout(() => {
        this.settle(id, { action: 'deny', note: APPROVAL_EXPIRED_NOTE }, 'expired');
      }, timeoutMs);
    }
    this.emit({
      type: 'pending',
      approval: {
        id,
        agent: approvalAgent(request),
        sessionId: approvalSessionId(request),
        action: approvalAction(request),
        requestedAt: new Date().toISOString(),
        deadline: bounded ? new Date(Date.now() + timeoutMs).toISOString() : null,
      },
    });
    this.changed();
    try {
      this.options.attention?.(`approval:${id}`);
    } catch {
      /* the prompt never depends on its sound */
    }
    return { approvalId: id, outcome };
  }

  /**
   * Open a prompt shown as a native modal. VS Code cannot dismiss an open modal, so the broker's deadline
   * settles the prompt, and an answer the modal returns after that is dropped.
   */
  openModal(
    req: Omit<ApprovalRequest, 'id'>,
    timeoutMs: number,
    show: () => Promise<ApprovalDecision>,
    approverId: string,
  ): { approvalId: string; outcome: Promise<ParticipantOutcome> } {
    const opened = this.open(req, { timeoutMs, surface: 'modal' });
    void Promise.resolve()
      .then(show)
      .then(
        (decision) => { this.settle(opened.approvalId, decision, 'human', approverId); },
        () => { this.settle(opened.approvalId, { action: 'deny' }, 'host-disposed', 'system:modal-failed'); },
      );
    return opened;
  }

  /** Wait on an open prompt from another session. Undefined when the prompt already settled. */
  join(approvalId: string, sessionId: string): Promise<ParticipantOutcome> | undefined {
    const prompt = this.prompts.get(approvalId);
    return prompt ? this.addParticipant(prompt, sessionId) : undefined;
  }

  isOpen(approvalId: string): boolean {
    return this.prompts.has(approvalId);
  }

  /**
   * Settle a prompt once. Returns false when it is unknown or already settled; nothing is resolved then, so a
   * late answer can never grant anything.
   */
  settle(
    approvalId: string,
    decision: ApprovalDecision,
    by: Exclude<ApprovalSettledBy, 'withdrawn'>,
    approverId = 'local-user',
  ): boolean {
    const prompt = this.prompts.get(approvalId);
    if (!prompt) {
      return false;
    }
    this.close(approvalId, prompt);
    const outcome: ParticipantOutcome = by === 'expired'
      ? { action: 'deny', note: APPROVAL_EXPIRED_NOTE, approvalId, expired: true, settledBy: 'expired' }
      : by === 'host-disposed'
        ? { action: 'deny', approvalId, settledBy: 'host-disposed' }
        : {
          action: decision.action,
          ...(decision.note ? { note: decision.note } : {}),
          approvalId,
          // A system actor is a fail-closed outcome, not a human approver: never a durable approval claim.
          ...(!approverId.startsWith('system:') ? { approverId } : {}),
          settledBy: 'human',
        };
    const participants = [...prompt.participants.values()];
    prompt.participants.clear();
    for (const participant of participants) {
      this.endParticipant(participant, { ...outcome });
    }
    if (by === 'expired') {
      this.emit({
        type: 'expired',
        approvalId,
        agent: approvalAgent(prompt.request),
        sessionId: approvalSessionId(prompt.request),
        expiredAt: new Date().toISOString(),
      });
    } else {
      this.emit({
        type: 'decided',
        approvalId,
        agent: approvalAgent(prompt.request),
        sessionId: approvalSessionId(prompt.request),
        decision: by === 'host-disposed' ? { action: 'deny' } : decision,
        approverId: by === 'host-disposed' && !approverId.startsWith('system:') ? 'system:host-disposed' : approverId,
        decidedAt: new Date().toISOString(),
      });
    }
    this.changed();
    return true;
  }

  /**
   * End every open participant of a session with a denial (the agent was stopped). A prompt that still has
   * other participants stays open for them; one left with none is withdrawn and its card removed.
   */
  leave(sessionId: string): number {
    let left = 0;
    for (const [approvalId, prompt] of [...this.prompts]) {
      const leaving = [...prompt.participants.values()].filter((participant) => participant.sessionId === sessionId);
      if (leaving.length === 0) continue;
      for (const participant of leaving) {
        prompt.participants.delete(participant.id);
      }
      // Close first, so no listener observes a withdrawn card as still open.
      const emptied = prompt.participants.size === 0;
      if (emptied) {
        this.close(approvalId, prompt);
      }
      for (const participant of leaving) {
        this.endParticipant(participant, {
          action: 'deny', note: APPROVAL_WITHDRAWN_NOTE, approvalId, withdrawn: true, settledBy: 'withdrawn',
        });
        left += 1;
      }
      if (emptied) {
        this.emit({
          type: 'withdrawn',
          approvalId,
          agent: approvalAgent(prompt.request),
          sessionId: approvalSessionId(prompt.request),
          withdrawnAt: new Date().toISOString(),
        });
      }
    }
    if (left > 0) {
      this.changed();
    }
    return left;
  }

  /** Settle everything still open as a denial so a torn-down host never leaves an agent hanging. */
  disposeAll(): void {
    for (const approvalId of [...this.prompts.keys()]) {
      this.settle(approvalId, { action: 'deny' }, 'host-disposed', 'system:host-disposed');
    }
  }

  /** Open prompts on a surface, oldest first (the chat panel renders the card ones). */
  list(surface: 'card' | 'modal' = 'card'): ApprovalRequest[] {
    return [...this.prompts.values()].filter((prompt) => prompt.surface === surface).map((prompt) => prompt.request);
  }

  /** Open prompts on every surface. */
  pendingCount(): number {
    return this.prompts.size;
  }

  private addParticipant(prompt: BrokeredApproval, sessionId: string): Promise<ParticipantOutcome> {
    return new Promise<ParticipantOutcome>((resolve) => {
      const participant = { id: `part-${++this.participantSeq}`, sessionId, resolve };
      prompt.participants.set(participant.id, participant);
      const count = (this.waiting.get(sessionId) ?? 0) + 1;
      this.waiting.set(sessionId, count);
      if (count === 1) {
        for (const listener of this.listeners) listener.onWaitChange?.(sessionId, true);
      }
    });
  }

  private endParticipant(participant: ApprovalParticipant, outcome: ParticipantOutcome): void {
    const count = Math.max(0, (this.waiting.get(participant.sessionId) ?? 0) - 1);
    if (count === 0) {
      this.waiting.delete(participant.sessionId);
    } else {
      this.waiting.set(participant.sessionId, count);
    }
    participant.resolve(outcome);
    if (count === 0) {
      for (const listener of this.listeners) listener.onWaitChange?.(participant.sessionId, false);
    }
  }

  private close(approvalId: string, prompt: BrokeredApproval): void {
    this.prompts.delete(approvalId);
    if (prompt.timer) {
      clearTimeout(prompt.timer);
    }
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) listener.onEvent?.(event);
  }

  private changed(): void {
    for (const listener of this.listeners) listener.onChange?.();
  }
}

/**
 * The chat panel's view of the broker: the card prompts it renders, and the clicks it forwards. It resolves
 * nothing itself. Kept with its historical API so existing callers and tests read the same.
 */
export class ApprovalQueue {
  readonly broker: ApprovalDecisionBroker;

  constructor(
    onChange: () => void = () => {},
    onEvent: (event: ApprovalEvent) => void = () => {},
    broker: ApprovalDecisionBroker = new ApprovalDecisionBroker(),
  ) {
    this.broker = broker;
    this.broker.subscribe({ onChange, onEvent });
  }

  /** Enqueue a card and return the promise that resolves with the decision. A bounded card expires as a deny. */
  request(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): Promise<ApprovalDecision> {
    return this.requestWithIdentity(req, timeoutMs).then(({ action, note }) => ({
      action,
      ...(note ? { note } : {}),
    }));
  }

  /** Same card, for host audit callers that need the actor attached by the decision. */
  requestWithIdentity(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): Promise<ParticipantOutcome> {
    return this.open(req, timeoutMs).outcome;
  }

  /** Open a card and also return its id, for a caller that lets other sessions join it. */
  open(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): { approvalId: string; outcome: Promise<ParticipantOutcome> } {
    return this.broker.open(req, { timeoutMs, surface: 'card' });
  }

  /** Forward a click. Returns false when the card already settled; the click is then ignored. */
  resolve(id: string, decision: ApprovalDecision, approverId = 'local-user'): boolean {
    return this.broker.settle(id, decision, approverId.startsWith('system:') ? 'host-disposed' : 'human', approverId);
  }

  /** The open cards, for rendering. */
  list(): ApprovalRequest[] {
    return this.broker.list('card');
  }

  /** Open prompts on every surface. */
  pendingCount(): number {
    return this.broker.pendingCount();
  }

  /** Deny everything still open (on dispose) so no awaiting agent hangs. */
  denyAll(): void {
    this.broker.disposeAll();
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
