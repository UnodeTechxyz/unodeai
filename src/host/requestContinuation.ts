import type { Message } from '../types';
import type { RequestContinuation } from './PathAccessOffer';

export interface EndedRequestContinuationDeps {
  /**
   * The agent whose item offers it. Continue goes on only with a request the person addressed to this agent: a
   * teammate's item never sends the coordinator's request to the teammate (security re-audit, F1).
   */
  agentId: string;
  /**
   * Whether the host holds a structured preparation of this request: work of its own that continues it when access
   * changes (an open run or a pending delegation now; v0.9.101 G3's preparation record later). Such a request is never
   * continued by Continue. In the extension this is `SessionManager.requestHasStructuredPreparation`.
   */
  hasStructuredPreparation(requestId: string): boolean;
  /** The person's own message that began the request, if the host still has it. */
  originalRequest(requestId: string): Message | undefined;
  /** Submits that message again as a new request of the person, to the same agent (`UserRequestEntrance.resubmit`). */
  resubmit(request: Message): Promise<boolean>;
}

/**
 * v0.9.101 (§4.2): how one explicit Continue goes on with an ended request that has no structured preparation: the
 * person's original message is submitted again, as a new request to the same agent, in its own mode (a Plan request
 * stays Plan), so nobody copies the text. Undefined where the request has such a preparation or its message is gone.
 * It starts nothing until `start` is called, and the caller spends it once.
 */
export function endedRequestContinuation(deps: EndedRequestContinuationDeps, requestId: string): RequestContinuation | undefined {
  const structured = () => {
    try { return deps.hasStructuredPreparation(requestId); } catch { return true; }
  };
  if (structured()) return undefined;
  const original = deps.originalRequest(requestId);
  if (!original || original.from !== 'user' || original.to !== deps.agentId) return undefined;
  return { available: () => !structured(), start: () => deps.resubmit(original) };
}
