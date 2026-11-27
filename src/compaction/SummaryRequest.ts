/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one host-summary request on an agent's own connection
 *
 *  The summary of an OpenAI-compatible agent's older turns goes to that agent's own connection, so it is covered by
 *  the same model-egress grant as the agent's ordinary requests: the connection profile and its revision, not a
 *  generic host-only scope. The request counts as sent only once it leaves, after consent and while still wanted,
 *  so a refused or cancelled request records no cost.
 *--------------------------------------------------------------------------------------------*/

import { sendOneTextRequest, TextRequestCancelledError } from '../backend/oneRequestTextTransport';

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
  /**
   * A summary request is a model request of the request it is made for. Asked after consent and immediately
   * before the request leaves: may that request cross its limit? Pending while the person decides. Absent,
   * nothing is asked. Any answer but `proceed` sends nothing.
   */
  requestBoundary?(signal?: AbortSignal): Promise<'proceed' | 'stopped'>;
}

/** The request was cancelled while its consent was open; it never left the host. */
export class SummaryRequestCancelledError extends TextRequestCancelledError {
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

/**
 * Ask consent for the agent's own connection, then send only if the request is still wanted. v0.9.110: the one-request
 * host text transport is shared with reply suggestions; a summary request asks its request limit as its last check.
 */
export async function sendSummaryRequest(
  request: SummaryRequest,
  deps: SummaryRequestDeps,
): Promise<{ ok: boolean; status: number; text: string }> {
  return sendOneTextRequest(request, {
    approveEgress: (url, scope) => deps.approveEgress(url, scope),
    fetch: deps.fetch,
    ...(deps.requestBoundary
      ? { beforeSend: async (signal?: AbortSignal) => (await deps.requestBoundary!(signal)) === 'proceed' }
      : {}),
    cancelled: () => new SummaryRequestCancelledError(),
  });
}
