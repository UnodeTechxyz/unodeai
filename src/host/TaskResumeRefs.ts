/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Retry of a task that lacked file access (v0.9.101, G3), and work that waits for it (H2a)
 *
 *  A worker's file call is refused, and Grant access is offered for the target. The host keeps a preparation: the
 *  request, the task the worker was executing and the target. When a grant covers the target and that task settled
 *  without doing its required work, the host issues one opaque, single-use resume_ref. It rides a notice the PM gets
 *  anyway: the grant notice of the PM's own Grant access, or the task's result. The PM's dispatch_task with that ref
 *  retries the task's own stored contract, and admission records the old task as replaced in the same step.
 *
 *  v0.9.101 (H2a): a dispatch whose only obstacle is access the person has not granted yet is not refused. The host keeps
 *  a waiting preparation of it, with no predecessor: its compiled contract, the teammate it would go to and what its next
 *  step needs. The request stays owned while it waits. A grant that makes that step runnable owes one wake of the PM, in
 *  that request, carrying a resume_ref for it; a grant that makes nothing runnable owes none. The wake is consumed only
 *  when the PM's turn is admitted. Stop, the PM's cancel_task on its handle and the coordinator's removal end it.
 *
 *  Everything here is memory only. A reload issues nothing again and accepts no ref from before it. Nothing is matched
 *  by similarity, text, time or path, nothing is dispatched here, and a ref grants nothing.
 *--------------------------------------------------------------------------------------------*/
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { matchPathAccess, type SessionPathAccessGrant } from '../backend/localReadScope';
import type { EffectiveTaskContract } from '../backend/TaskContract';
import type { DraftRef, SourceCheck, SourceDigest } from '../backend/DocumentDraftCustody';
import type { FolderPermission } from '../types';

/** What the run ledger says about the task a ref would retry. */
export interface ResumePredecessor {
  state: 'active' | 'settled' | 'cancelled' | 'interrupted';
  /** Already superseded or abandoned. */
  terminal: boolean;
  /** Its settled result did not do its required work, by the host's facts. */
  unfinished: boolean;
  contract?: EffectiveTaskContract;
}

/** v0.9.101 (H2a): one thing a waiting step needs: a target, and the access that meets it. */
export interface AccessNeed {
  target: string;
  access: FolderPermission;
  /** `File lease.docx`, `Folder output`: the kind and name the person's item shows first. */
  label: string;
}

/**
 * v0.9.101 (H2a): the next step a waiting preparation is for. `dispatch`: the dispatch was refused only for access to a
 * required input. `save` (H2b): a settled attempt holds a draft of a required output whose final save waits for access.
 * `retry` (H2b): a settled attempt stopped for lack of access a grant can open, with no draft to save.
 */
export type PreparationStep = 'dispatch' | 'save' | 'retry';

/**
 * v0.9.101 (H2a): how a waiting request ended without its work. `hard-limit` (H2b): what it needs is outside a limit no
 * grant can change, such as the teammate's own Folder Access; nothing waits for a grant then.
 */
export type AccessWaitEnd = 'stopped' | 'abandoned' | 'coordinator-gone' | 'hard-limit';

/** v0.9.101 (H2a): what the run ledger keeps of a request's waiting work. */
export interface AccessWaitChange {
  coordinatorId: string;
  requestId: string;
  /** The thread the request's run is keyed by: the coordinator turn that prepared the work. */
  correlationId: string;
  /** What the request's waiting work needs, every preparation's, in order. Empty: nothing of it waits now. */
  needs: Array<AccessNeed & { step: PreparationStep }>;
  /** Waiting work that ended without being done: the reason, and whether the run may be closed at once. */
  ended?: { reason: AccessWaitEnd; closeNow: boolean };
  /** Waiting tasks the coordinator abandoned while others of the request still wait. */
  abandoned?: number;
}

export interface TaskResumePorts {
  /** The open delegation this agent's current turn executes, and who dispatched it. */
  openDelegationOf(agentId: string): { handle: string; coordinatorId: string } | undefined;
  /** The file grants the crew holds in this request now: its own and the session's. */
  grantsFor(requestId: string): readonly SessionPathAccessGrant[];
  predecessor(coordinatorId: string, handle: string): ResumePredecessor | undefined;
  /** The request of the coordinator's turn in progress. */
  currentRequestOf(coordinatorId: string): string | undefined;
  /** Replaced by tests. At least 128 random bits. */
  newRef?(): string;
  /**
   * v0.9.101 (H2a): whether `candidateId` can do what `need` asks now, by its live authority in `requestId`: read an
   * input, or (H2b) write the output a draft saves to. Absent: a grant of the request that covers it. `'limit'` (H2b):
   * not met, and no grant could meet it, as under the teammate's own Folder Access.
   */
  needMet?(candidateId: string, requestId: string, need: AccessNeed): boolean | 'limit';
  /**
   * v0.9.101 (the access table, R2 §1): the project's need rows. A waiting step's needs are recorded as rows of its own
   * consumer (its selected teammate and its handle) when it is prepared; its readiness reads those rows' state and
   * nothing else; the rows go when it is resumed or ends. Reading never writes. Absent: `needMet`.
   */
  needRows?: {
    declare(requestId: string, consumer: { agentId: string; handle: string }, needs: readonly AccessNeed[], step: PreparationStep): void;
    state(requestId: string, consumer: { agentId: string; handle: string }, need: AccessNeed): 'met' | 'partial' | 'missing' | 'limit' | undefined;
    drop(requestId: string, consumer: { agentId: string; handle: string }): void;
    /**
     * The request's waiting work ends with it (Stop, its coordinator gone): its rows are closed first, so what was
     * still missing at that moment is kept whole before any step's rows are released (audit of cc0b6bc6, F2).
     */
    close?(requestId: string, reason: AccessWaitEnd): void;
  };
  /**
   * v0.9.101 (H2b): the sources a draft was prepared from, compared with what they are now under the draft owner's live
   * authority in `requestId`. It reads; it never makes or widens a grant to read.
   */
  checkSource?(ownerId: string, requestId: string, digests: readonly SourceDigest[]): Promise<SourceCheck>;
  /** v0.9.101 (H2a): a request's waiting work changed; the run ledger keeps it. */
  waitChanged?(change: AccessWaitChange): void;
}

/** A ref held by one dispatch from its call until its admission or its end. */
export interface ResumeReservation {
  ref: string;
  /** The task the retry replaces. Absent for waiting work that was never dispatched (H2a): admission replaces nothing. */
  predecessorHandle?: string;
  /** v0.9.101 (H2a): the waiting preparation this ref resumes, as its needs-access result named it. */
  preparationHandle?: string;
  /** The predecessor's stored compiled contract, or the waiting preparation's, a copy. */
  contract: EffectiveTaskContract;
  /** Admission: the ref is used up. False when this reservation no longer holds it: nothing may be replaced then. */
  spend(replacementHandle: string): boolean;
  /** The dispatch was not admitted: the ref can be used again. Nothing after `spend`. */
  release(): void;
  /**
   * v0.9.101 (H2a): the resumed dispatch found its access missing again. The ref is void and the preparation waits again
   * for `needs`, under its own handle. False when this reservation is not of a waiting preparation, or no longer holds it.
   */
  waitAgain?(needs: readonly AccessNeed[]): boolean;
  /**
   * v0.9.101 (H2b): the draft a waiting save is for, and the comparison of its sources under its owner's live authority
   * in the ref's request. Absent for every other ref.
   */
  draft?: { ref: DraftRef; checkSource(): Promise<SourceCheck> };
  /**
   * v0.9.101 (H2b): what the resumed task needs is outside a limit no grant can change. The ref is void, the waiting
   * work ends, and the request's outcome names the limit. False when this reservation no longer holds it.
   */
  endForLimit?(needs: readonly AccessNeed[]): boolean;
}

/** v0.9.101 (H2b): a settled task that did not do its work, for want of access a grant can open. */
export interface SettledPreparationInput {
  coordinatorId: string;
  /** The settled task. */
  handle: string;
  /** The coordinator's thread that dispatched it: the request's run. */
  correlationId?: string;
  agentId: string;
  /** The draft of a required output it holds, kept with every part, whose final save waits for access. */
  draft?: DraftRef;
  /** What its next step needs that its refused calls did not name: the draft's destination, a source it must read. */
  needs?: readonly AccessNeed[];
  /** What its next step needs that is met already, and must still be met when it runs: the digested sources' Read. */
  alsoRequires?: readonly AccessNeed[];
}

/** v0.9.101 (H2a): a dispatch kept waiting for access. */
export interface DispatchPreparationInput {
  coordinatorId: string;
  correlationId: string;
  contract: EffectiveTaskContract;
  candidateId: string;
  needs: readonly AccessNeed[];
}

/** The things TeamTools asks of this. */
export interface TaskResumeAdmission {
  /**
   * `queuedStart`: the start of a dispatch that was queued behind overlapping work (audit R7). Its request was checked
   * when the coordinator's call queued it; the coordinator need not be in a turn when that work settles.
   */
  reserve(ref: string, coordinatorId: string, options?: { queuedStart?: boolean }): { ok: true; reservation: ResumeReservation } | { ok: false; reason: string; limit?: true };
  /** The line a just-settled task's result carries, when the access it lacked was granted while it ran. */
  atSettlement(coordinatorId: string, handle: string): string | undefined;
  /**
   * v0.9.101 (H2b): a task settled without its work, and a grant can open what stopped it: its request keeps it as
   * waiting work, for its save or its retry, instead of ending. Returns the line its result carries, or undefined when
   * nothing of it waits (no refusal of it was captured, it finished, or it was replaced).
   */
  prepareAtSettlement?(input: SettledPreparationInput): string | undefined;
  /**
   * v0.9.101 (H2b): the settled task's draft cannot be saved for a limit no grant can change. Its captured refusals end,
   * nothing waits, and the request's outcome names the limit. Returns the line its result carries.
   */
  endAtSettlementForLimit?(input: SettledPreparationInput, limit: AccessNeed, text: string): string;
  /**
   * v0.9.101 (H2a): keep a dispatch whose only obstacle is access not granted yet. Returns its handle, or undefined when
   * the coordinator is in no request: then it cannot wait, and the dispatch is refused as before.
   */
  prepareDispatch?(input: DispatchPreparationInput): string | undefined;
  /**
   * Whether this coordinator's work in this request thread (the correlation its dispatch carried) waits for access now.
   * The reply that ends such a turn is waiting, not missing a conclusion (smoke of 7128f103).
   */
  waitingInThread?(coordinatorId: string, correlationId: string): boolean;
  /**
   * v0.9.101 (H2a): the coordinator's cancel_task on a waiting preparation's handle. False: no such waiting work of it.
   * (H2b) Otherwise the step it waited for.
   */
  abandonPreparation?(coordinatorId: string, handle: string): PreparationStep | false;
}

interface Preparation {
  requestId: string;
  coordinatorId: string;
  predecessorHandle: string;
  /** Each refused target, with the access that closes it. */
  targets: Map<string, FolderPermission>;
  state: 'pending' | 'issued' | 'dropped';
}

/** v0.9.101 (H2a): work that waits for access, before any dispatch. */
interface WaitingPreparation {
  readonly step: PreparationStep;
  /** Host-issued; the PM names it in cancel_task. */
  readonly handle: string;
  readonly requestId: string;
  readonly coordinatorId: string;
  readonly correlationId: string;
  readonly contract: EffectiveTaskContract;
  /** The teammate its dispatch would go to: the choice admission made, with the missing access taken as granted. */
  selectedCandidateId: string;
  needs: AccessNeed[];
  /**
   * v0.9.101 (H2b): everything its next step must have when it runs, met or not: `needs` and, for a save, the Read of
   * each source its draft was digested from. Readiness is judged on this. Absent: `needs`.
   */
  requires?: AccessNeed[];
  /** v0.9.101 (H2b): the settled task a save or a retry replaces. Absent for a dispatch that never ran. */
  readonly predecessorHandle?: string;
  /** v0.9.101 (H2b): the draft a save is for. */
  readonly draft?: DraftRef;
  /** Whether its next step can run now, as last computed. */
  runnable: boolean;
  /** Increases each time `runnable` changes. */
  readinessRevision: number;
  /** The last revision a delivered wake carried. A wake is owed only at a runnable revision above it. */
  consumedWake: number;
  /** waiting: not yet told it can run. ready: a delivered wake carries its live ref. */
  status: 'waiting' | 'ready' | 'resumed' | 'voided';
  /** The revision a queued wake was owed at, until that wake is delivered or dropped. */
  queuedAt?: number;
  /** The ref the delivered wake carries. */
  ref?: string;
  /** v0.9.101 (H2b): the consumed revision before a notice took it, restored if that notice does not reach the PM. */
  consumedBefore?: number;
}

interface IssuedRef {
  ref: string;
  preparation: Preparation | WaitingPreparation;
  /** The request the ref may be used in: its preparation's. */
  requestId: string;
  /** The grants that covered the targets when it was issued. Each must still be live when it is used. */
  grantIds: string[];
  state: 'live' | 'reserved' | 'spent' | 'void';
  /** The reservation holding it while it is reserved. */
  holder?: object;
  voidReason?: string;
}

/**
 * v0.9.101 (H2a): a wake the coordinator is owed for one waiting request: what became runnable at one moment. The host
 * delivers it as the coordinator's turn in that request, never beside a turn in progress. `open` checks every
 * preparation again right before the turn is sent: still waiting, the same revision, and its access still there.
 */
export interface AccessWake {
  readonly coordinatorId: string;
  readonly requestId: string;
  readonly correlationId: string;
  /** The turn's text, with a fresh ref for each preparation that still holds; undefined when none does. Issues refs. */
  open(): string | undefined;
  /** The turn with the text `open` gave was admitted: the wake is consumed. */
  delivered(): void;
  /** The turn was not started: the refs `open` issued are void, and the preparations are owed a wake again. */
  notDelivered(): void;
  /** Whether any of its preparations can still be woken; false once every one ended. */
  live(): boolean;
}

const RETAINED = 128;
const OBJECTIVE_CHARS = 200;

/** The PM-facing line. The ref is host-issued; nothing in it is a path or a grant. */
export function resumeRefLine(predecessorHandle: string, ref: string, when: 'grant' | 'result'): string {
  const why = when === 'grant'
    ? `Task ${predecessorHandle} stopped for lack of this access.`
    : `Task ${predecessorHandle} did not finish, and the file access it lacked was granted while it ran.`;
  return `${why} To retry it, call dispatch_task with resume_ref ${ref} and no contract: the host reuses that task's `
    + `contract and records ${predecessorHandle} as replaced by the new task when it is admitted.`;
}

/** v0.9.101 (H2a): `Read`, `Read + Write`. */
export function accessWord(access: FolderPermission): string {
  return access === 'readwrite' ? 'Read + Write' : 'Read';
}

/** v0.9.101 (H2a): the kind and name of a target, as its item shows them, decided by its spelling only. */
export function accessNeedLabel(target: string): string {
  const name = path.basename(path.resolve(target)) || target;
  return `${/\.[^.\\/]+$/.test(name) ? 'File' : 'Folder'} ${name}`;
}

/** v0.9.101 (H2a): "Read access to File lease.docx (full path)", each need of a step, joined. */
export function accessNeedsText(needs: readonly AccessNeed[]): string {
  return needs.map((need) => `${accessWord(need.access)} access to ${need.label} (${need.target})`).join(' and ');
}

/**
 * v0.9.101 (H2a): the PM's tool result for a dispatch that waits for access. Its turn ends normally; nothing runs and
 * nothing is held while the task waits.
 */
export function needsAccessResult(handle: string, needs: readonly AccessNeed[]): string {
  return `Task "${handle}" is prepared and waiting for the user's ${accessNeedsText(needs)}. UnodeAi has asked them. `
    + 'Do not dispatch it again. When it can run, you will be told in this request, with a resume_ref. '
    + `If the user no longer wants it, call cancel_task with handle "${handle}".`;
}

/** v0.9.101 (the access table): a waiting step's consumer: its selected teammate, for this preparation. */
function consumerOf(preparation: WaitingPreparation): { agentId: string; handle: string } {
  return { agentId: preparation.selectedCandidateId, handle: preparation.handle };
}

export class TaskResumeRefs implements TaskResumeAdmission {
  private readonly preparations = new Map<string, Preparation>();
  private readonly refs = new Map<string, IssuedRef>();
  /** v0.9.101 (H2a): waiting work, by its handle. */
  private readonly waiting = new Map<string, WaitingPreparation>();
  /** v0.9.101 (H2a): the wake queued and not delivered yet, per coordinator and request. */
  private readonly queuedWakes = new Map<string, { preparations: Set<WaitingPreparation> }>();

  constructor(private readonly ports: TaskResumePorts) {}

  /**
   * A worker's file call to `target` was refused and Grant access offered for it. Kept only when the worker's turn
   * is an open delegation: a coordinator's own call, or a dispatch refused before it started, has no task to retry.
   */
  capture(workerId: string, requestId: string | undefined, target: string, accessNeeded: FolderPermission): void {
    if (!requestId) return;
    let open: { handle: string; coordinatorId: string } | undefined;
    try { open = this.ports.openDelegationOf(workerId); } catch { open = undefined; }
    if (!open) return;
    const key = `${requestId}\u0000${open.handle}`;
    let preparation = this.preparations.get(key);
    if (!preparation || preparation.state === 'dropped') {
      preparation = { requestId, coordinatorId: open.coordinatorId, predecessorHandle: open.handle, targets: new Map(), state: 'pending' };
      this.preparations.delete(key);
      this.preparations.set(key, preparation);
      while (this.preparations.size > RETAINED) this.preparations.delete(this.preparations.keys().next().value!);
    }
    if (preparation.state !== 'pending') return;
    if (preparation.targets.get(target) !== 'readwrite') preparation.targets.set(target, accessNeeded);
  }

  /**
   * A grant in `requestId` reached this agent's own notice. Every pending preparation of this coordinator in the
   * request whose task has settled without its work is issued its ref, for the grant notice to carry.
   */
  issueAtGrant(coordinatorId: string, requestId: string | undefined): { lines: string[]; refs: string[] } {
    const lines: string[] = [];
    const refs: string[] = [];
    if (!requestId) return { lines, refs };
    for (const preparation of [...this.preparations.values()]) {
      if (preparation.coordinatorId !== coordinatorId || preparation.requestId !== requestId) continue;
      const issued = this.evaluate(preparation);
      if (!issued) continue;
      refs.push(issued.ref);
      lines.push(resumeRefLine(preparation.predecessorHandle, issued.ref, 'grant'));
    }
    // v0.9.101 (H2b): a settled task kept waiting in this request, whose next step this grant made runnable: the notice
    // that reaches the PM anyway carries its ref, and no wake is owed for it any more.
    for (const preparation of [...this.waiting.values()]) {
      if (preparation.coordinatorId !== coordinatorId || preparation.requestId !== requestId || !preparation.predecessorHandle
        || preparation.status !== 'waiting' || preparation.queuedAt !== undefined) continue;
      this.refresh(preparation);
      if (!preparation.runnable || preparation.readinessRevision <= preparation.consumedWake) continue;
      const ref = this.issueWaiting(preparation);
      refs.push(ref);
      lines.push(settledRefLine(preparation, ref, 'grant'));
    }
    return { lines, refs };
  }

  /** A waiting preparation is told it can run, by a ref carried now: it is ready, and its wake is consumed. */
  private issueWaiting(preparation: WaitingPreparation): string {
    const ref = this.ports.newRef?.() ?? `rr-${randomBytes(16).toString('hex')}`;
    this.refs.set(ref, { ref, preparation, requestId: preparation.requestId, grantIds: [], state: 'live' });
    while (this.refs.size > RETAINED) this.refs.delete(this.refs.keys().next().value!);
    preparation.consumedBefore = preparation.consumedWake;
    preparation.consumedWake = preparation.readinessRevision;
    preparation.status = 'ready';
    preparation.ref = ref;
    return ref;
  }

  /**
   * The grant notice this agent's own Grant access sends: `base`, then each ref issued for it. `report` takes the refs
   * back when the notice does not reach the agent.
   */
  grantNotice(agentId: string, requestId: string | undefined, base: string): { text: string; refs: string[]; report(report: { kind: string }): void } {
    const issued = this.issueAtGrant(agentId, requestId);
    return {
      text: [base, ...issued.lines].join(' '),
      refs: issued.refs,
      report: (report) => { if (report.kind === 'not-told') this.withdraw(issued.refs); },
    };
  }

  /** The notice that carried these refs did not reach the PM: they are void, and their preparations wait again. */
  withdraw(refs: readonly string[]): void {
    for (const ref of refs) {
      const issued = this.refs.get(ref);
      if (!issued || issued.state !== 'live') continue;
      this.voidRef(issued, 'its notice did not reach you');
      const preparation = issued.preparation;
      if (isRetry(preparation) && preparation.state === 'issued') preparation.state = 'pending';
      // v0.9.101 (H2b): a settled task's ref: it waits again, and the readiness that notice consumed is owed again.
      if (!isRetry(preparation) && preparation.status === 'ready' && preparation.ref === ref) {
        preparation.status = 'waiting';
        preparation.ref = undefined;
        preparation.consumedWake = preparation.consumedBefore ?? preparation.consumedWake;
      }
    }
  }

  atSettlement(coordinatorId: string, handle: string): string | undefined {
    for (const preparation of this.preparations.values()) {
      if (preparation.coordinatorId !== coordinatorId || preparation.predecessorHandle !== handle) continue;
      const issued = this.evaluate(preparation);
      if (issued) return resumeRefLine(handle, issued.ref, 'result');
    }
    return undefined;
  }

  reserve(ref: string, coordinatorId: string, options: { queuedStart?: boolean } = {}): { ok: true; reservation: ResumeReservation } | { ok: false; reason: string; limit?: true } {
    const issued = this.refs.get(ref);
    if (!issued) return { ok: false, reason: 'the host did not issue it, or issued it before UnodeAi was reloaded' };
    if (issued.state === 'spent') return { ok: false, reason: 'it was already used' };
    if (issued.state === 'void') return { ok: false, reason: issued.voidReason ?? 'it is no longer valid' };
    if (issued.state === 'reserved') return { ok: false, reason: 'another dispatch_task is using it now' };
    const preparation = issued.preparation;
    if (preparation.coordinatorId !== coordinatorId) return { ok: false, reason: 'it was issued to another coordinator' };
    let current: string | undefined;
    try { current = this.ports.currentRequestOf(coordinatorId); } catch { current = undefined; }
    if (!options.queuedStart && current !== issued.requestId) return { ok: false, reason: 'it belongs to another request' };
    if (!isRetry(preparation)) return this.reserveWaiting(issued, preparation);
    const predecessor = this.predecessorOf(preparation);
    if (!predecessor || predecessor.terminal) {
      this.voidRef(issued, `task ${preparation.predecessorHandle} is already replaced or abandoned`);
      return { ok: false, reason: issued.voidReason! };
    }
    if (predecessor.state !== 'settled') return { ok: false, reason: `task ${preparation.predecessorHandle} is not settled` };
    if (!predecessor.contract) return { ok: false, reason: `task ${preparation.predecessorHandle} has no stored contract` };
    const live = new Set(this.grantsOf(issued.requestId).filter((grant) => grant.current()).map((grant) => grant.id));
    if (issued.grantIds.some((id) => !live.has(id))) {
      this.voidRef(issued, 'the file access it was issued for was revoked or has ended');
      return { ok: false, reason: issued.voidReason! };
    }
    // Each reservation holds the ref by its own token, so a late release of an earlier one cannot free a later one.
    const holder = {};
    issued.state = 'reserved';
    issued.holder = holder;
    const holds = () => issued.state === 'reserved' && issued.holder === holder;
    return { ok: true, reservation: {
      ref,
      predecessorHandle: preparation.predecessorHandle,
      contract: predecessor.contract,
      spend: () => {
        if (!holds()) return false;
        issued.state = 'spent';
        return true;
      },
      release: () => {
        if (!holds()) return;
        issued.state = 'live';
        issued.holder = undefined;
      },
    } };
  }

  /** Stop, or the end of the request: its refs and preparations are void. A later decision does not revive them. */
  endRequest(requestId: string | undefined, reason = 'the request was stopped'): void {
    if (!requestId) return;
    for (const preparation of this.preparations.values()) {
      if (preparation.requestId === requestId) preparation.state = 'dropped';
    }
    for (const issued of this.refs.values()) {
      if (issued.preparation.requestId === requestId && issued.state !== 'spent') this.voidRef(issued, reason);
    }
    this.endWaiting((preparation) => preparation.requestId === requestId, 'stopped', reason);
  }

  // ─── v0.9.101 (H2a): work that waits for access ──────────────────────────────────────────

  prepareDispatch(input: DispatchPreparationInput): string | undefined {
    let requestId: string | undefined;
    try { requestId = this.ports.currentRequestOf(input.coordinatorId); } catch { requestId = undefined; }
    if (!requestId || !input.correlationId || input.needs.length === 0) return undefined;
    const handle = `wait-${randomBytes(6).toString('hex')}`;
    const preparation: WaitingPreparation = {
      step: 'dispatch', handle, requestId, coordinatorId: input.coordinatorId, correlationId: input.correlationId,
      contract: structuredClone(input.contract), selectedCandidateId: input.candidateId,
      needs: input.needs.map((need) => ({ ...need })), runnable: false, readinessRevision: 0, consumedWake: 0, status: 'waiting',
    };
    this.declareRows(preparation);
    this.waiting.set(handle, preparation);
    this.pruneWaiting();
    this.reportWait(preparation);
    return handle;
  }

  prepareAtSettlement(input: SettledPreparationInput): string | undefined {
    const captured = this.capturedOf(input.coordinatorId, input.handle);
    if (!captured) return undefined;
    const predecessor = this.predecessorOf(captured);
    if (!predecessor || predecessor.state !== 'settled' || predecessor.terminal || !predecessor.unfinished || !predecessor.contract) return undefined;
    const needs = mergeNeeds([...captured.targets].map(([target, access]) => ({ target, access, label: accessNeedLabel(target) })), input.needs ?? []);
    const handle = `wait-${randomBytes(6).toString('hex')}`;
    const preparation: WaitingPreparation = {
      step: input.draft ? 'save' : 'retry', handle, requestId: captured.requestId, coordinatorId: input.coordinatorId,
      correlationId: input.correlationId ?? '', contract: structuredClone(predecessor.contract), selectedCandidateId: input.agentId,
      needs, requires: mergeNeeds(needs, input.alsoRequires ?? []), predecessorHandle: input.handle,
      ...(input.draft ? { draft: structuredClone(input.draft) } : {}),
      runnable: false, readinessRevision: 0, consumedWake: 0, status: 'waiting',
    };
    this.declareRows(preparation);
    const limited = (preparation.requires ?? needs).find((need) => this.limitOf(preparation, need));
    if (limited) {
      captured.state = 'dropped';
      preparation.status = 'voided';
      this.dropRows(preparation);
      this.emitWait({ ...waitIdentity(preparation), needs: [{ ...limited, step: preparation.step }], ended: { reason: 'hard-limit', closeNow: false } });
      return limitLine(input.handle, limited, input.agentId);
    }
    this.refresh(preparation);
    // Granted while it ran, with no draft to save: the retry's ref rides its result, as G3 issues it at settlement.
    if (!input.draft && preparation.runnable) { this.dropRows(preparation); return undefined; }
    // What waits from now on is this preparation: the captured refusals issue no ref of their own.
    captured.state = 'dropped';
    this.waiting.set(handle, preparation);
    this.pruneWaiting();
    // The access its save lacked was granted while it ran: its result, which reaches the PM anyway, carries the ref.
    if (preparation.runnable) {
      const ref = this.issueWaiting(preparation);
      this.reportWait(preparation);
      return settledRefLine(preparation, ref, 'result');
    }
    this.reportWait(preparation);
    return settledWaitLine(preparation);
  }

  endAtSettlementForLimit(input: SettledPreparationInput, limit: AccessNeed, text: string): string {
    const captured = this.capturedOf(input.coordinatorId, input.handle);
    if (captured) captured.state = 'dropped';
    const requestId = captured?.requestId ?? '';
    this.emitWait({ coordinatorId: input.coordinatorId, requestId, correlationId: input.correlationId ?? '',
      needs: [{ ...limit, step: input.draft ? 'save' : 'retry' }], ended: { reason: 'hard-limit', closeNow: false } });
    return `Task ${input.handle} did not finish, and a grant cannot help it: ${text} `
      + (input.draft ? `Its draft "${input.draft.draftName}" is kept with ${input.agentId}, unsaved. ` : '')
      + 'Nothing waits for access for it. Tell the user what limits it; do not dispatch it again for this.';
  }

  /** The refusal capture of a settled task, still pending. */
  private capturedOf(coordinatorId: string, handle: string): Preparation | undefined {
    return [...this.preparations.values()].find((preparation) => preparation.coordinatorId === coordinatorId
      && preparation.predecessorHandle === handle && preparation.state === 'pending');
  }

  /** Whether a need is outside a limit no grant can change, for its preparation's teammate now. */
  private limitOf(preparation: WaitingPreparation, need: AccessNeed): boolean {
    try {
      const row = this.ports.needRows?.state(preparation.requestId, consumerOf(preparation), need);
      if (row) return row === 'limit'; return this.ports.needMet?.(preparation.selectedCandidateId, preparation.requestId, need) === 'limit'; } catch { return false; }
  }

  /**
   * v0.9.101 (the access table): the rows of these requests changed. Each one's waiting work is reported again, so the run
   * marker records every need's state as it is now.
   */
  restated(requestIds: Iterable<string>): void {
    for (const requestId of requestIds) {
      const open = this.openOf(requestId);
      if (open.length) this.reportWait(open[0]);
    }
  }

  /** Whether work of this request waits for access now: it keeps the request owned. */
  hasWaiting(requestId: string | undefined): boolean {
    return !!requestId && [...this.waiting.values()].some((preparation) => preparation.requestId === requestId && open(preparation));
  }

  waitingInThread(coordinatorId: string, correlationId: string): boolean {
    return [...this.waiting.values()].some((preparation) => preparation.coordinatorId === coordinatorId
      && preparation.correlationId === correlationId && open(preparation));
  }

  /**
   * Whether this coordinator's work in `requestId` waits for access. Then the wake its readiness owes is how a grant in
   * that request reaches it: a grant that makes nothing runnable starts no turn of it.
   */
  waitsOn(coordinatorId: string, requestId: string | undefined): boolean {
    return !!requestId && [...this.waiting.values()].some((preparation) => preparation.coordinatorId === coordinatorId
      && preparation.requestId === requestId && open(preparation));
  }

  /**
   * Access changed. Each waiting preparation is judged again against its selected teammate's live authority, on its
   * own. Those that became runnable at a revision above their consumed wake are owed one; what becomes runnable at one
   * moment shares one wake per coordinator and request, and one already queued takes them. Returns the new wakes.
   */
  readyWakes(): AccessWake[] {
    const made: AccessWake[] = [];
    for (const preparation of [...this.waiting.values()]) {
      if (preparation.status !== 'waiting') continue;
      if (this.replacedMeanwhile(preparation)) { this.endReplaced(preparation); continue; }
      this.refresh(preparation);
      if (!preparation.runnable || preparation.readinessRevision <= preparation.consumedWake || preparation.queuedAt !== undefined) continue;
      preparation.queuedAt = preparation.readinessRevision;
      const key = `${preparation.coordinatorId}\u0000${preparation.requestId}`;
      const queued = this.queuedWakes.get(key);
      if (queued) { queued.preparations.add(preparation); continue; }
      const entry = { preparations: new Set([preparation]) };
      this.queuedWakes.set(key, entry);
      made.push(this.wakeFor(key, entry, preparation));
    }
    return made;
  }

  abandonPreparation(coordinatorId: string, handle: string): PreparationStep | false {
    const preparation = this.waiting.get(handle.trim());
    if (!preparation || preparation.coordinatorId !== coordinatorId || !open(preparation)) return false;
    let current: string | undefined;
    try { current = this.ports.currentRequestOf(coordinatorId); } catch { current = undefined; }
    this.voidWaiting(preparation, 'the task was abandoned');
    const left = this.openOf(preparation.requestId);
    // The coordinator's own turn in that request closes its run with its reply; from another request it is closed now.
    this.emitWait({ ...waitIdentity(preparation), needs: needsOf(left),
      ...(left.length ? { abandoned: 1 } : { ended: { reason: 'abandoned', closeNow: current !== preparation.requestId } }) });
    return preparation.step;
  }

  /**
   * The person's Stop of this coordinator, or its removal: every request of it whose work waits ends. Returns those
   * requests, whose For this request grants end with them.
   */
  endCoordinator(coordinatorId: string, reason: 'stopped' | 'coordinator-gone'): string[] {
    const requests = new Set([...this.waiting.values()]
      .filter((preparation) => preparation.coordinatorId === coordinatorId && open(preparation)).map((preparation) => preparation.requestId));
    this.endWaiting((preparation) => preparation.coordinatorId === coordinatorId, reason,
      reason === 'stopped' ? 'the request was stopped' : 'its coordinator is no longer available');
    return [...requests];
  }

  private endWaiting(which: (preparation: WaitingPreparation) => boolean, reason: AccessWaitEnd, why: string): void {
    const ended = new Map<string, WaitingPreparation>();
    // Each ending request is closed while all its steps still wait, so its record names everything still missing then.
    const closing = new Set([...this.waiting.values()].filter((preparation) => which(preparation) && open(preparation))
      .map((preparation) => preparation.requestId));
    for (const requestId of closing) {
      try { this.ports.needRows?.close?.(requestId, reason); } catch { /* The rows are a record. */ }
    }
    for (const preparation of this.waiting.values()) {
      if (!which(preparation) || !open(preparation)) continue;
      this.voidWaiting(preparation, why);
      ended.set(`${preparation.coordinatorId}\u0000${preparation.requestId}`, preparation);
    }
    for (const preparation of ended.values()) {
      this.emitWait({ ...waitIdentity(preparation), needs: [], ended: { reason, closeNow: true } });
    }
  }

  private emitWait(change: AccessWaitChange): void {
    try { this.ports.waitChanged?.(change); } catch { /* The in-memory wait stays valid for this window; the ledger says nothing it does not hold. */ }
  }

  private reserveWaiting(issued: IssuedRef, preparation: WaitingPreparation): { ok: true; reservation: ResumeReservation } | { ok: false; reason: string; limit?: true } {
    if (preparation.status !== 'ready' || preparation.ref !== issued.ref) {
      this.voidRef(issued, 'its task no longer waits for it');
      return { ok: false, reason: issued.voidReason! };
    }
    // v0.9.101 (H2b): a settled task replaced or abandoned meanwhile by other means has nothing left to resume.
    if (this.replacedMeanwhile(preparation)) {
      this.voidRef(issued, `task ${preparation.predecessorHandle} is already replaced or abandoned`);
      this.endReplaced(preparation);
      return { ok: false, reason: issued.voidReason! };
    }
    // Checked again now: a grant can have ended between the wake and this call.
    this.refresh(preparation);
    if (!preparation.runnable) {
      // v0.9.101 (H2b): a need no grant can meet now ends the work: nothing would wait for anything that could come.
      const limited = (preparation.requires ?? preparation.needs).find((need) => this.limitOf(preparation, need));
      if (limited) {
        this.voidRef(issued, limitText(limited, preparation.selectedCandidateId));
        this.endForLimit(preparation, [limited]);
        return { ok: false, reason: issued.voidReason!, limit: true };
      }
      this.voidRef(issued, 'the file access it was issued for was revoked or has ended');
      this.waitAgainFor(preparation, preparation.requires
        ? preparation.requires.filter((need) => !this.met(preparation, need)) : preparation.needs);
      return { ok: false, reason: issued.voidReason! };
    }
    const holder = {};
    issued.state = 'reserved';
    issued.holder = holder;
    const holds = () => issued.state === 'reserved' && issued.holder === holder;
    const draft = preparation.draft;
    return { ok: true, reservation: {
      ref: issued.ref,
      ...(preparation.predecessorHandle ? { predecessorHandle: preparation.predecessorHandle } : {}),
      preparationHandle: preparation.handle,
      contract: structuredClone(preparation.contract),
      ...(draft ? { draft: { ref: structuredClone(draft), checkSource: () => this.checkSourceOf(draft, preparation.requestId) } } : {}),
      endForLimit: (needs) => {
        if (!holds() || preparation.status !== 'ready') return false;
        this.voidRef(issued, 'what it needs is outside a limit a grant cannot change');
        this.endForLimit(preparation, needs);
        return true;
      },
      spend: () => {
        if (!holds() || preparation.status !== 'ready') return false;
        issued.state = 'spent';
        preparation.status = 'resumed';
        this.dropRows(preparation);
        this.reportWait(preparation);
        return true;
      },
      release: () => {
        if (!holds()) return;
        issued.state = 'live';
        issued.holder = undefined;
      },
      waitAgain: (needs) => {
        if (!holds() || preparation.status !== 'ready') return false;
        this.voidRef(issued, 'its access was missing again when it was dispatched');
        this.waitAgainFor(preparation, needs);
        return true;
      },
    } };
  }

  /** v0.9.101 (H2b): the settled task a save or retry would replace was replaced or abandoned by another decision. */
  private replacedMeanwhile(preparation: WaitingPreparation): boolean {
    if (!preparation.predecessorHandle) return false;
    let predecessor: ResumePredecessor | undefined;
    try { predecessor = this.ports.predecessor(preparation.coordinatorId, preparation.predecessorHandle); } catch { predecessor = undefined; }
    return !predecessor || predecessor.terminal;
  }

  /** It is no longer the request's waiting work; the request's run keeps what else of it waits. */
  private endReplaced(preparation: WaitingPreparation): void {
    this.voidWaiting(preparation, `task ${preparation.predecessorHandle} is already replaced or abandoned`);
    this.reportWait(preparation);
  }

  /** v0.9.101 (H2b): the draft's sources against what they are now, under its owner's live authority in the request. */
  private async checkSourceOf(draft: DraftRef, requestId: string): Promise<SourceCheck> {
    if (!draft.inputDigests.length) return { state: 'unchanged' };
    if (!this.ports.checkSource) return { state: 'unreadable', physical: draft.inputDigests[0].physical, inputId: draft.inputDigests[0].inputId };
    return this.ports.checkSource(draft.agentId, requestId, draft.inputDigests);
  }

  /** v0.9.101 (H2b): nothing a grant could do helps this work: it ends, and the request's outcome names the limit. */
  private endForLimit(preparation: WaitingPreparation, needs: readonly AccessNeed[]): void {
    this.voidWaiting(preparation, 'what it needs is outside a limit a grant cannot change');
    const left = this.openOf(preparation.requestId);
    if (left.length) { this.reportWait(preparation); return; }
    this.emitWait({ ...waitIdentity(preparation), needs: needs.map((need) => ({ ...need, step: preparation.step })),
      ended: { reason: 'hard-limit', closeNow: false } });
  }

  /** It needs access again: it waits, under its own handle, and a later runnable change owes a new wake. */
  private waitAgainFor(preparation: WaitingPreparation, needs: readonly AccessNeed[]): void {
    preparation.status = 'waiting';
    preparation.ref = undefined;
    if (needs.length) preparation.needs = needs.map((need) => ({ ...need }));
    // v0.9.101 (H2b): what it was found to lack is part of what its next step needs from now on.
    if (preparation.requires) preparation.requires = mergeNeeds(preparation.requires, needs);
    this.declareRows(preparation);
    this.refresh(preparation);
    this.reportWait(preparation);
  }

  /** v0.9.101 (the access table): this step's needs as rows of its own consumer. */
  private declareRows(preparation: WaitingPreparation): void {
    if (!this.ports.needRows) return;
    try {
      this.ports.needRows.declare(preparation.requestId, consumerOf(preparation), preparation.requires ?? preparation.needs, preparation.step);
    } catch { /* Readiness then reads `needMet`'s answer; each call is checked at use anyway. */ }
  }

  private dropRows(preparation: WaitingPreparation): void {
    try { this.ports.needRows?.drop(preparation.requestId, consumerOf(preparation)); } catch { /* The rows are a record. */ }
  }

  private wakeFor(key: string, entry: { preparations: Set<WaitingPreparation> }, first: WaitingPreparation): AccessWake {
    let opened: Array<{ preparation: WaitingPreparation; ref: string }> = [];
    let done = false;
    const finish = () => {
      done = true;
      if (this.queuedWakes.get(key) === entry) this.queuedWakes.delete(key);
    };
    return {
      coordinatorId: first.coordinatorId,
      requestId: first.requestId,
      correlationId: first.correlationId,
      live: () => !done && [...entry.preparations].some((preparation) => preparation.status === 'waiting'),
      open: () => {
        if (done) return undefined;
        opened = [];
        for (const preparation of entry.preparations) {
          if (preparation.status !== 'waiting' || preparation.queuedAt === undefined) continue;
          // Rechecked at delivery: still waiting, the revision it was owed at, and its access still there.
          this.refresh(preparation);
          if (!preparation.runnable || preparation.readinessRevision !== preparation.queuedAt) { preparation.queuedAt = undefined; continue; }
          const ref = this.ports.newRef?.() ?? `rr-${randomBytes(16).toString('hex')}`;
          this.refs.set(ref, { ref, preparation, requestId: preparation.requestId, grantIds: [], state: 'live' });
          while (this.refs.size > RETAINED) this.refs.delete(this.refs.keys().next().value!);
          opened.push({ preparation, ref });
        }
        if (!opened.length) { finish(); return undefined; }
        return accessWakeText(opened.map(({ preparation, ref }) => ({ handle: preparation.handle, objective: preparation.contract.objective,
          agent: preparation.selectedCandidateId, ref, step: preparation.step,
          ...(preparation.predecessorHandle ? { predecessor: preparation.predecessorHandle } : {}),
          ...(preparation.draft ? { draft: preparation.draft.draftName } : {}) })));
      },
      delivered: () => {
        for (const { preparation, ref } of opened) {
          preparation.consumedWake = preparation.queuedAt ?? preparation.readinessRevision;
          preparation.queuedAt = undefined;
          preparation.status = 'ready';
          preparation.ref = ref;
        }
        opened = [];
        finish();
      },
      notDelivered: () => {
        for (const { preparation, ref } of opened) {
          const issued = this.refs.get(ref);
          if (issued) this.voidRef(issued, 'its notice did not reach you');
          preparation.queuedAt = undefined;
        }
        opened = [];
        for (const preparation of entry.preparations) preparation.queuedAt = undefined;
        finish();
      },
    };
  }

  /** Its next step's needs against its selected teammate's live authority; the revision moves when that changes. */
  private refresh(preparation: WaitingPreparation): void {
    const runnable = (preparation.requires ?? preparation.needs).every((need) => this.met(preparation, need));
    if (runnable === preparation.runnable) return;
    preparation.runnable = runnable;
    preparation.readinessRevision++;
  }

  private met(preparation: WaitingPreparation, need: AccessNeed): boolean {
    try {
      const row = this.ports.needRows?.state(preparation.requestId, consumerOf(preparation), need);
      if (row) return row === 'met';
      if (this.ports.needMet) return this.ports.needMet(preparation.selectedCandidateId, preparation.requestId, need) === true;
      return matchPathAccess(this.grantsOf(preparation.requestId).filter((grant) => grant.current()), need.target, need.access) !== undefined;
    } catch {
      return false;
    }
  }

  private voidWaiting(preparation: WaitingPreparation, why: string): void {
    preparation.status = 'voided';
    preparation.queuedAt = undefined;
    this.dropRows(preparation);
    for (const issued of this.refs.values()) {
      if (issued.preparation === preparation && issued.state !== 'spent') this.voidRef(issued, why);
    }
  }

  private openOf(requestId: string): WaitingPreparation[] {
    return [...this.waiting.values()].filter((preparation) => preparation.requestId === requestId && open(preparation));
  }

  private reportWait(preparation: WaitingPreparation): void {
    this.emitWait({ ...waitIdentity(preparation), needs: needsOf(this.openOf(preparation.requestId)) });
  }

  private pruneWaiting(): void {
    for (const [handle, preparation] of this.waiting) {
      if (this.waiting.size <= RETAINED) break;
      if (!open(preparation)) this.waiting.delete(handle);
    }
  }

  /**
   * Whether the preparation is ready now: pending, its task settled without its work and not replaced, a stored
   * contract to retry, and every target covered. Issues its one ref when it is. A task that is settled and finished,
   * interrupted, cancelled or replaced, or that has no stored contract, drops the preparation: it gets no ref.
   */
  private evaluate(preparation: Preparation): IssuedRef | undefined {
    const covering = this.readiness(preparation);
    if (!covering) return undefined;
    const ref = this.ports.newRef?.() ?? `rr-${randomBytes(16).toString('hex')}`;
    const issued: IssuedRef = { ref, preparation, requestId: preparation.requestId, grantIds: covering, state: 'live' };
    preparation.state = 'issued';
    this.refs.set(ref, issued);
    while (this.refs.size > RETAINED) this.refs.delete(this.refs.keys().next().value!);
    return issued;
  }

  /** The grants that cover a ready preparation's targets; undefined when it is not ready. Issues nothing. */
  private readiness(preparation: Preparation): string[] | undefined {
    if (preparation.state !== 'pending') return undefined;
    const predecessor = this.predecessorOf(preparation);
    if (!predecessor) { preparation.state = 'dropped'; return undefined; }
    // Still running: its settlement evaluates it again.
    if (predecessor.state === 'active') return undefined;
    if (predecessor.state !== 'settled' || predecessor.terminal || !predecessor.unfinished || !predecessor.contract) {
      preparation.state = 'dropped';
      return undefined;
    }
    const grants = this.grantsOf(preparation.requestId);
    const covering: string[] = [];
    for (const [target, access] of preparation.targets) {
      let match: ReturnType<typeof matchPathAccess>;
      try { match = matchPathAccess(grants, target, access); } catch { match = undefined; }
      if (!match) return undefined;
      covering.push(match.grant.id);
    }
    return [...new Set(covering)];
  }

  private predecessorOf(preparation: Preparation): ResumePredecessor | undefined {
    try { return this.ports.predecessor(preparation.coordinatorId, preparation.predecessorHandle); } catch { return undefined; }
  }

  private grantsOf(requestId: string): readonly SessionPathAccessGrant[] {
    try { return this.ports.grantsFor(requestId); } catch { return []; }
  }

  private voidRef(issued: IssuedRef, reason: string): void {
    if (issued.state === 'spent') return;
    issued.state = 'void';
    issued.voidReason = reason;
  }
}

function isRetry(preparation: Preparation | WaitingPreparation): preparation is Preparation {
  return 'targets' in preparation;
}

/** Still the request's waiting work: not resumed, not ended. */
function open(preparation: WaitingPreparation): boolean {
  return preparation.status === 'waiting' || preparation.status === 'ready';
}

function waitIdentity(preparation: WaitingPreparation): Pick<AccessWaitChange, 'coordinatorId' | 'requestId' | 'correlationId'> {
  return { coordinatorId: preparation.coordinatorId, requestId: preparation.requestId, correlationId: preparation.correlationId };
}

function needsOf(preparations: readonly WaitingPreparation[]): AccessWaitChange['needs'] {
  return preparations.flatMap((preparation) => preparation.needs.map((need) => ({ ...need, step: preparation.step })));
}

/**
 * v0.9.101 (H2a): the wake's text. The PM's conversation may hold another request since, so it names the earlier
 * request's task and its ref, and says whose turn this is.
 */
export function accessWakeText(ready: ReadonlyArray<{ handle: string; objective: string; agent: string; ref: string;
  step?: PreparationStep; predecessor?: string; draft?: string }>): string {
  const objective = (text: string) => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > OBJECTIVE_CHARS ? `${line.slice(0, OBJECTIVE_CHARS - 1)}…` : line;
  };
  const call = (agent: string, ref: string) => `call dispatch_task with agent "${agent}", resume_ref ${ref} and no contract.`;
  return [
    ...ready.map(({ handle, objective: goal, agent, ref, step, predecessor, draft }) => `[UnodeAi] Access granted for your earlier request "${objective(goal)}". `
      + (step === 'save' && predecessor
        // v0.9.101 (H2b): the draft is kept; the same teammate saves it, and admission records the old task replaced.
        ? `Task ${predecessor} prepared the draft "${draft ?? ''}", which can be saved now: ${call(agent, ref)} The teammate saves the kept draft without preparing it again, and ${predecessor} is recorded as replaced.`
        : step === 'retry' && predecessor
          ? `Task ${predecessor} stopped for lack of this access and can be retried now: ${call(agent, ref)} ${predecessor} is recorded as replaced when the retry is admitted.`
          : `Its task "${handle}" can run now: ${call(agent, ref)}`)),
    'This turn belongs to that request.',
  ].join('\n');
}

/** v0.9.101 (H2b): a settled task's ref, on the notice or the result that reaches the PM anyway. */
function settledRefLine(preparation: WaitingPreparation, ref: string, when: 'grant' | 'result'): string {
  const handle = preparation.predecessorHandle!;
  if (!preparation.draft) return resumeRefLine(handle, ref, when);
  return `Task ${handle} prepared the draft "${preparation.draft.draftName}", and the access its save lacked is granted now. To save it, `
    + `call dispatch_task with agent "${preparation.selectedCandidateId}", resume_ref ${ref} and no contract: the same teammate saves the `
    + `kept draft without preparing it again, and ${handle} is recorded as replaced by the new task when it is admitted.`;
}

/** v0.9.101 (H2b): a settled task that waits in its request for access a grant can open. */
function settledWaitLine(preparation: WaitingPreparation): string {
  const handle = preparation.predecessorHandle!;
  const what = preparation.draft
    ? `Its draft "${preparation.draft.draftName}" is kept with every part (${preparation.draft.parts} parts, ${preparation.draft.blocks} blocks), and its save waits`
    : 'It waits';
  return `Task ${handle} did not finish. ${what} for the user's ${accessNeedsText(preparation.needs)}. UnodeAi has asked them. `
    + 'Do not dispatch it again. When it can continue, you will be told in this request, with a resume_ref. '
    + `If the user no longer wants it, call cancel_task with handle "${preparation.handle}".`;
}

/** v0.9.101 (H2b): the limit a grant cannot change, named. */
function limitText(need: AccessNeed, agentId: string): string {
  return `${need.label} is outside ${agentId}'s Folder Access; a grant cannot change that`;
}

function limitLine(handle: string, need: AccessNeed, agentId: string): string {
  return `Task ${handle} did not finish, and a grant cannot help it: ${limitText(need, agentId)}. Nothing waits for access for `
    + 'it. Tell the user what limits it; do not dispatch it again for this.';
}

/** v0.9.101 (H2b): needs of one target are one need, the stronger access kept. */
function mergeNeeds(first: readonly AccessNeed[], second: readonly AccessNeed[]): AccessNeed[] {
  const merged: AccessNeed[] = [];
  const key = (target: string) => { const resolved = path.resolve(target); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  for (const need of [...first, ...second]) {
    const same = merged.find((entry) => key(entry.target) === key(need.target));
    if (same) { if (need.access === 'readwrite') same.access = 'readwrite'; continue; }
    merged.push({ ...need });
  }
  return merged;
}
