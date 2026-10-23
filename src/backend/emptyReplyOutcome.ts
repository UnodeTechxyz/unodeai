/*---------------------------------------------------------------------------------------------
 *  UnodeAi - empty-reply outcome wording (v0.9.90 Smart compaction design, §7.3)
 *
 *  The typed outcome travels through MessageBus metadata and restored records, so it is parsed defensively. The
 *  wording states observed facts only: the attempts, the last attempt's input size and how it was obtained, and
 *  the upstream provider when the route named one. It never claims that the context size caused the empty reply.
 *--------------------------------------------------------------------------------------------*/

import type { EmptyReplyAttempt, TurnResponseOutcome } from './AgentBackend';

const TEXT_LIMIT = 200;
const PROVIDER_NAME_LIMIT = 100;

/**
 * A gateway-supplied provider name made safe to show: letters, digits, spaces and `. & + - /` only. That drops
 * control and bidirectional formatting characters, which can reorder what a reader sees, and all Markdown syntax, so
 * a name like `[DeepInfra](https://x)` can never render as a link. Undefined when nothing displayable is left.
 */
export function displayProviderName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/[^\p{L}\p{N} .&+\-/]/gu, '').replace(/\s+/g, ' ').trim().slice(0, PROVIDER_NAME_LIMIT).trim();
  return name || undefined;
}

/** Escape the characters that start inline Markdown, at the point where text enters a rendered message. */
function escapeInlineMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|~#()!]/g, (character) => `\\${character}`);
}

const formatTokens = (tokens: number) => tokens.toLocaleString('en-US');

/** A valid typed outcome from metadata, or undefined (a legacy record, or a malformed one). */
export function parseResponseOutcome(raw: unknown): TurnResponseOutcome | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'reply' || value.kind === 'tool-only' || value.kind === 'error' || value.kind === 'stopped') {
    return { kind: value.kind };
  }
  // The only deadline there is. An unknown one is not a value this host wrote, and is refused whole.
  if (value.kind === 'host-deadline') {
    return value.deadline === 'first-action' ? { kind: 'host-deadline', deadline: 'first-action' } : undefined;
  }
  if (value.kind !== 'empty-reply' || !Array.isArray(value.attempts)) return undefined;
  const attempts = value.attempts.flatMap((attempt) => {
    const parsed = parseAttempt(attempt);
    return parsed ? [parsed] : [];
  });
  return attempts.length > 0 ? { kind: 'empty-reply', attempts } : undefined;
}

/** The host item a teammate's chat shows for an empty reply. */
export function emptyReplyNotice(attempts: readonly EmptyReplyAttempt[]): string {
  return `UnodeAi: ${describeEmptyReply(attempts)}`;
}

/** The observed facts of an empty reply, as one paragraph a coordinator or a person can read. */
export function describeEmptyReply(attempts: readonly EmptyReplyAttempt[]): string {
  const last = attempts[attempts.length - 1];
  const size = measured(last)
    ? `The last attempt used about ${formatTokens(last!.inputTokens!)} input tokens `
      + `(${last!.inputBasis === 'reported' ? 'provider-reported' : 'estimated'})`
    : 'The last attempt\'s input size was not reported';
  const provider = displayProviderName(last?.upstreamProvider);
  return `The model returned an empty reply after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}. `
    + `${size}; no text or tool call was received. Upstream provider: ${provider ? escapeInlineMarkdown(provider) : 'unavailable'}.`;
}

/** The short cause a coordinator and the Activity view show: a fact, not a diagnosis. */
export function emptyReplyReason(attempts: readonly EmptyReplyAttempt[]): string {
  const last = attempts[attempts.length - 1];
  return measured(last)
    ? `the model returned an empty reply at about ${formatTokens(last!.inputTokens!)} input tokens`
    : 'the model returned an empty reply';
}

function measured(attempt: EmptyReplyAttempt | undefined): boolean {
  return attempt !== undefined && attempt.inputTokens !== undefined && attempt.inputBasis !== 'unavailable';
}

function parseAttempt(raw: unknown): EmptyReplyAttempt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const count = (field: unknown) => (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined);
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.slice(0, TEXT_LIMIT) : undefined);
  const attempt = count(value.attempt);
  const gateway = text(value.gateway);
  const inputBasis = value.inputBasis === 'reported' || value.inputBasis === 'reconstructed' || value.inputBasis === 'unavailable'
    ? value.inputBasis
    : undefined;
  if (!attempt || !gateway || !inputBasis) return undefined;
  const inputTokens = count(value.inputTokens);
  const outputTokens = count(value.outputTokens);
  const finishSignal = text(value.finishSignal);
  // Restored records are re-checked: a name stored before this filter, or edited on disk, is made safe again.
  const upstreamProvider = displayProviderName(value.upstreamProvider);
  const responseId = text(value.responseId);
  return {
    attempt,
    gateway,
    inputBasis,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(finishSignal ? { finishSignal } : {}),
    ...(upstreamProvider ? { upstreamProvider } : {}),
    ...(responseId ? { responseId } : {}),
  };
}
