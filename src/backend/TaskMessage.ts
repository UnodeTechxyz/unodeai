/*---------------------------------------------------------------------------------------------
 *  UnodeAi - a teammate's message bound to its task (v0.9.103, G1)
 *
 *  While a teammate executes a delegated task, a `send_message` to that task's own coordinator is bound by the host
 *  to the live attempt. The attempt, its handle and the event id are the host's: the model supplies only the text,
 *  the target and, optionally, the kind. The coordinator's session checks the claim against its own saved binding
 *  of the attempt before it treats the message as bound.
 *--------------------------------------------------------------------------------------------*/

/** `note`: no answer expected. `question` and `blocker`: an answer is expected (v0.9.103 has no reply path yet). */
export type TaskMessageKind = 'note' | 'question' | 'blocker';

export const TASK_MESSAGE_KINDS: readonly TaskMessageKind[] = ['note', 'question', 'blocker'];

/** What the host stamps on a bound `agent.message` (payload.metadata.taskMessage). Never taken from tool arguments. */
export interface TaskMessageClaim {
  /** The live attempt the turn executes. Absent on a turn with no attempt card: a rework of the handle (audit I1). */
  attemptId?: string;
  handle: string;
  kind: TaskMessageKind;
  /** Stable host event id: delivering the same id again starts no turn and adds nothing. */
  eventId: string;
}

/** An absent kind is a note; anything other than the three kinds is refused. */
export function parseTaskMessageKind(value: unknown): TaskMessageKind | undefined {
  if (value === undefined || value === null || value === '') return 'note';
  return typeof value === 'string' && (TASK_MESSAGE_KINDS as readonly string[]).includes(value)
    ? value as TaskMessageKind : undefined;
}

/** Whole or nothing: a claim with any field missing or malformed is no claim. Only the attempt id may be absent. */
export function parseTaskMessageClaim(value: unknown): TaskMessageClaim | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const claim = value as Record<string, unknown>;
  const text = (field: unknown): field is string => typeof field === 'string' && field.length > 0 && field.length <= 200;
  if ((claim.attemptId !== undefined && !text(claim.attemptId)) || !text(claim.handle) || !text(claim.eventId)) return undefined;
  if (typeof claim.kind !== 'string' || !(TASK_MESSAGE_KINDS as readonly string[]).includes(claim.kind)) return undefined;
  return { ...(text(claim.attemptId) ? { attemptId: claim.attemptId } : {}), handle: claim.handle,
    kind: claim.kind as TaskMessageKind, eventId: claim.eventId };
}

/** How the coordinator's wake and chat name one bound message. */
export function taskMessageKindLabel(kind: TaskMessageKind): string {
  return kind === 'question' ? 'question (answer expected)'
    : kind === 'blocker' ? 'blocker (answer expected)'
      : 'note (no answer expected)';
}
