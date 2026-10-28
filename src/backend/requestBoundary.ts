/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request boundary (v0.9.94)
 *
 *  The one question a backend or a tool surface asks the host before something leaves or acts: may this
 *  request cross its next boundary? The host answers from the request limits the person configured. Nothing
 *  here knows a limit, a total or a prompt, and a caller never needs a request id: the host binds the function
 *  to the agent it hands it to.
 *
 *  With no boundary injected every caller proceeds at once, exactly as before.
 *--------------------------------------------------------------------------------------------*/
import { hostToolRefused, type HostToolOutcome } from './toolSummary';
import { isDocumentDraftPart } from '../content/document/DocumentTool';

/** `provider-request`: a model request is about to leave. `effect`: a tool call is about to act. */
export type RequestBoundaryKind = 'provider-request' | 'effect';
export type RequestBoundaryOutcome = 'proceed' | 'stopped';

export interface RequestBoundaryDetail {
  /** The tool whose call is the effect. Its name only, never its arguments. */
  tool?: string;
  /** Aborted when the caller's own turn is stopped, so a held boundary ends as `stopped` instead of waiting on. */
  signal?: AbortSignal;
}

/**
 * Resolves `proceed` at once while the request is inside its limits. At a reached limit it stays pending until
 * the person decides, and resolves `stopped` when they stop the request.
 */
export type RequestBoundary = (kind: RequestBoundaryKind, detail?: RequestBoundaryDetail) => Promise<RequestBoundaryOutcome>;

/** What a tool call refused at the boundary is told. One sentence, with no path, total or setting in it. */
export const REQUEST_LIMIT_STOPPED_REFUSAL =
  'This request reached its configured limit and the person stopped it, so this call was not run.';

/** The typed refusal of a call the boundary stopped. The reason carries the decision; the text is for the model. */
export function requestLimitRefusal(): HostToolOutcome {
  return hostToolRefused(REQUEST_LIMIT_STOPPED_REFUSAL, 'safety-limit');
}

/** A model request the boundary stopped. The backend ends the turn as a stop; nothing reads the message. */
export class RequestBoundaryStoppedError extends Error {
  constructor() {
    super('The request reached its configured limit and was stopped before this model request left.');
    this.name = 'RequestBoundaryStoppedError';
  }
}

export function isRequestBoundaryStopped(error: unknown): error is RequestBoundaryStoppedError {
  return error instanceof RequestBoundaryStoppedError;
}

/**
 * Ask the boundary, and stop waiting when the caller's own turn is stopped. A boundary that throws is not a
 * permission: the caller stops rather than cross a limit nobody answered for. A signal that was already aborted
 * when the question was asked changes nothing here, so a boundary that proceeds at once behaves as no boundary.
 */
export async function awaitRequestBoundary(
  boundary: RequestBoundary | undefined,
  kind: RequestBoundaryKind,
  detail: RequestBoundaryDetail = {},
): Promise<RequestBoundaryOutcome> {
  if (!boundary) return 'proceed';
  const { signal } = detail;
  let stopListening: () => void = () => undefined;
  const interrupted = new Promise<RequestBoundaryOutcome>((resolve) => {
    if (!signal || signal.aborted) return;
    const onAbort = (): void => resolve('stopped');
    signal.addEventListener('abort', onAbort, { once: true });
    stopListening = () => signal.removeEventListener('abort', onAbort);
  });
  const answered = Promise.resolve()
    .then(() => boundary(kind, detail))
    .then((outcome): RequestBoundaryOutcome => (outcome === 'proceed' ? 'proceed' : 'stopped'), (): RequestBoundaryOutcome => 'stopped');
  try {
    return await Promise.race([answered, interrupted]);
  } finally {
    stopListening();
  }
}

/**
 * Workspace tools whose call is an effect of the request: it writes or deletes in the workspace, runs a command,
 * reaches the network, or sends a message that starts a teammate's turn. Every other workspace tool reads, lists,
 * searches or keeps the agent's own bookkeeping, and is never held: a request at its limit can still inspect
 * what it did. Stopping a background command is never held either, because a limit must not keep work running.
 */
export const GOVERNED_WORKSPACE_TOOLS = Object.freeze([
  'write_file', 'apply_edit', 'apply_patch', 'delete_file', 'delete_dir', 'run_command', 'fetch_url', 'send_message', 'memory_note',
  'save_attachment', 'write_document',
] as const);
const governedWorkspaceTools = new Set<string>(GOVERNED_WORKSPACE_TOOLS);

/**
 * v0.9.99: with its arguments, a write_document draft part is not an effect: it only adds blocks to a draft on this
 * machine and writes no file. The final part, which writes the file, is held like every other write.
 */
export function isGovernedWorkspaceTool(name: string, args?: unknown): boolean {
  if (name === 'write_document' && isDocumentDraftPart(args)) return false;
  return governedWorkspaceTools.has(name);
}

/**
 * Team tools whose call is an effect of the request: it dispatches or resumes work, messages every teammate, or
 * runs the verification command. Reading results, stating a conclusion and stopping a teammate are never held:
 * a request at its limit must still be able to close out and to stop.
 */
export const GOVERNED_TEAM_TOOLS = Object.freeze([
  'dispatch_task', 'assign_task', 'assign_task_async', 'continue_task', 'broadcast', 'run_checks',
] as const);
const governedTeamTools = new Set<string>(GOVERNED_TEAM_TOOLS);
/**
 * Team tools that are not held by their name: they read or wait for results, record a decision, state the
 * conclusion, or stop a teammate. `record_task_disposition` is held for the two decisions that send a message.
 */
export const UNHELD_TEAM_TOOLS = Object.freeze([
  'list_agents', 'collect_ready_tasks', 'inspect_task_status', 'await_tasks', 'record_task_disposition',
  'close_assignment', 'publish_content_receipt', 'delegation_metrics', 'cancel_task',
  // v0.9.97: reads saved work, or keeps it as an artifact on this machine; neither acts outside the host.
  'read_saved_batches',
] as const);
const unheldTeamTools = new Set<string>(UNHELD_TEAM_TOOLS);
/** The two dispositions that send the teammate a message, which starts a turn of that teammate. */
const DISPOSITIONS_THAT_MESSAGE = new Set<string>(['needs-rework', 'rejected']);

/** Whether the name is a team tool this module has classified, one way or the other. */
export function isClassifiedTeamTool(name: string): boolean {
  return governedTeamTools.has(name) || unheldTeamTools.has(name);
}

export function isGovernedTeamTool(name: string, args?: Record<string, unknown>): boolean {
  // Recording a decision is bookkeeping; only the dispositions that message the teammate act on anything.
  // The value is read the way the tool itself reads it, so the two can never disagree about a call.
  if (name === 'record_task_disposition') return DISPOSITIONS_THAT_MESSAGE.has(String(args?.disposition ?? ''));
  return governedTeamTools.has(name);
}
