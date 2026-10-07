/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one host-summary request on an agent's own connection
 *
 *  The summary of an OpenAI-compatible agent's older turns goes to that agent's own connection, so it is covered by
 *  the same model-egress grant as the agent's ordinary requests: the connection profile and its revision, not a
 *  generic host-only scope. The request counts as sent only once it leaves, after consent and while still wanted,
 *  so a refused or cancelled request records no cost.
 *--------------------------------------------------------------------------------------------*/

/** The consent scope of one connection profile, exactly as an agent's ordinary model requests use it. */
export interface SummaryEgressScope {
  profileId: string;
  profileRevision: number;
}

export interface SummaryRequest {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  /** Required: the agent's own connection grant. There is no generic default. */
  scope: SummaryEgressScope;
  signal?: AbortSignal;
  /** Called once, immediately before the request leaves the host. */
  onRequestSent?: () => void;
}

export interface SummaryRequestDeps {
  /** Resolves when the connection may be contacted; throws when the user declines, and nothing is sent. */
  approveEgress(url: string, scope: SummaryEgressScope): Promise<void>;
  fetch(url: string, init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** The request was cancelled while its consent was open; it never left the host. */
export class SummaryRequestCancelledError extends Error {
  constructor() {
    super('The summary request was cancelled before it was sent.');
    this.name = 'SummaryRequestCancelledError';
  }
}

/** The agent's own connection scope, or an error when the agent names no known connection. */
export function summaryEgressScope(
  connection: { id: string; revision: number } | undefined,
  agentName: string,
): SummaryEgressScope {
  if (!connection) throw new Error(`Unknown connection for ${agentName}.`);
  return { profileId: connection.id, profileRevision: connection.revision };
}

/** Ask consent for the agent's own connection, then send only if the request is still wanted. */
export async function sendSummaryRequest(
  request: SummaryRequest,
  deps: SummaryRequestDeps,
): Promise<{ ok: boolean; status: number; text: string }> {
  await deps.approveEgress(request.url, request.scope);
  if (request.signal?.aborted) throw new SummaryRequestCancelledError();
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
