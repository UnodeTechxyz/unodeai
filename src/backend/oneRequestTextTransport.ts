/*---------------------------------------------------------------------------------------------
 *  UnodeAi - One host text request on a connection's OpenAI-compatible route
 *
 *  The host sends some model requests itself, outside an agent's backend: a conversation summary, a reply suggestion.
 *  Each is exactly one request: consent for the connection's own model-egress grant first, then a last check by the
 *  caller immediately before it leaves (a request limit, an auxiliary budget, a setting still current), then one POST.
 *  No retry, no streaming, no tools, no session. A request cancelled before it leaves never leaves, and records no
 *  cost; the caller's signal also aborts one that is out.
 *
 *  VS Code-free: consent and the network arrive as dependencies.
 *--------------------------------------------------------------------------------------------*/

/** The consent scope of one connection profile, exactly as an agent's ordinary model requests use it. */
export interface TextRequestEgressScope {
  profileId: string;
  profileRevision: number;
}

export interface OneTextRequest {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  /** Required: the connection's own grant. There is no generic default. */
  scope: TextRequestEgressScope;
  signal?: AbortSignal;
  /** Called once, immediately before the request leaves the host. */
  onRequestSent?: () => void;
}

export type TextRequestFetch = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OneTextRequestDeps {
  /** Resolves when the connection may be contacted; throws when the person declines, and nothing is sent. */
  approveEgress(url: string, scope: TextRequestEgressScope): Promise<void>;
  fetch: TextRequestFetch;
  /**
   * Asked after consent and immediately before the request leaves: may it leave now? Pending while the person decides
   * a reached limit, for a caller that holds there. Anything but true sends nothing. Absent, nothing is asked.
   */
  beforeSend?(signal?: AbortSignal): Promise<boolean> | boolean;
  /**
   * Synchronous, and run after the last awaited step: it decides, and the request is marked sent and handed to fetch,
   * in one uninterrupted step. Nothing can change what it checked (a budget, a setting) before the request leaves.
   * Anything but true sends nothing.
   */
  finalCheck?(): boolean;
  /** The error a request that never left is reported with. A plain TextRequestCancelledError when absent. */
  cancelled?: () => Error;
}

/** The request never left the host: it was cancelled, or its last check before sending said no. */
export class TextRequestCancelledError extends Error {
  constructor(message = 'The request was cancelled before it was sent.') {
    super(message);
    this.name = 'TextRequestCancelledError';
  }
}

/** Ask consent, check once more, then send exactly one request. The response is returned as it came, not retried. */
export async function sendOneTextRequest(
  request: OneTextRequest,
  deps: OneTextRequestDeps,
): Promise<{ ok: boolean; status: number; text: string }> {
  const cancelled = (): Error => deps.cancelled?.() ?? new TextRequestCancelledError();
  await deps.approveEgress(request.url, request.scope);
  if (request.signal?.aborted) throw cancelled();
  if (deps.beforeSend) {
    const mayLeave = await deps.beforeSend(request.signal);
    if (mayLeave !== true || request.signal?.aborted === true) throw cancelled();
  }
  // From here to the fetch call there is no await: the final check holds when the request leaves.
  if (deps.finalCheck && deps.finalCheck() !== true) throw cancelled();
  request.onRequestSent?.();
  const response = await deps.fetch(request.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify(request.body),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}
