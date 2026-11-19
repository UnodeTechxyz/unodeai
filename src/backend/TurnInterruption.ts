/** Host-only error classification and content-free persisted facts. No retry/execution authority. */
export const INTERRUPTION_KINDS = [
  'connection-lost', 'provider-error', 'provider-timeout', 'process-exited', 'protocol-error', 'unknown',
] as const;
export const INTERRUPTION_PHASES = ['before-response', 'reading-response', 'native-turn', 'unknown'] as const;
export const INTERRUPTION_RETRIES = ['exhausted', 'after-tool', 'native-unknown', 'not-retryable', 'not-available'] as const;
export interface TurnInterruptionV1 {
  schemaVersion: 1;
  kind: typeof INTERRUPTION_KINDS[number];
  phase: typeof INTERRUPTION_PHASES[number];
  retry: typeof INTERRUPTION_RETRIES[number];
  attempts?: number;
}
export const MAX_INTERRUPTION_ATTEMPTS = 100_000;

/** Optional extensions are parsed independently: a corrupt extension must not discard an older core record. */
export function parseTurnInterruption(raw: unknown): TurnInterruptionV1 | undefined {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !INTERRUPTION_KINDS.includes(value.kind as TurnInterruptionV1['kind'])
      || !INTERRUPTION_PHASES.includes(value.phase as TurnInterruptionV1['phase'])
      || !INTERRUPTION_RETRIES.includes(value.retry as TurnInterruptionV1['retry'])
      || value.attempts !== undefined && (typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts)
        || value.attempts < 1 || value.attempts > MAX_INTERRUPTION_ATTEMPTS)) return undefined;
    return { schemaVersion: 1, kind: value.kind as TurnInterruptionV1['kind'], phase: value.phase as TurnInterruptionV1['phase'],
      retry: value.retry as TurnInterruptionV1['retry'], ...(value.attempts !== undefined ? { attempts: value.attempts as number } : {}) };
  } catch { return undefined; }
}

type HostTag = Pick<TurnInterruptionV1, 'kind' | 'phase'>;
// A JSON property/name/message cannot forge an adapter observation, even after an Error is copied or imported.
const hostTags = new WeakMap<Error, HostTag>();
function tagged(cause: unknown, kind: HostTag['kind'], phase: HostTag['phase']): Error {
  // Preserve diagnostic/body-repair semantics. This message is never the user-facing reason.
  let message = 'Host-observed turn interruption.';
  try { if (cause instanceof Error && typeof cause.message === 'string') message = cause.message; } catch { /* hostile accessor */ }
  const error = new Error(message, { cause });
  hostTags.set(error, { kind, phase });
  return error;
}
/** Only the actual text/body reader's rejection may use this, not a parser or a whole-turn catch. */
export function bodyReadInterruption(cause: unknown): Error {
  return tagged(cause, cause instanceof SyntaxError ? 'protocol-error' : 'connection-lost', 'reading-response');
}
export function providerResponseInterruption(cause: unknown, phase: HostTag['phase']): Error {
  return tagged(cause, 'provider-error', phase);
}
/** The host's own provider timeout, not a person stopping or a host first-action/anti-spin deadline. */
export function providerTimeoutInterruption(cause: unknown, phase: HostTag['phase']): Error {
  return tagged(cause, 'provider-timeout', phase);
}
export function processExitInterruption(cause: unknown): Error { return tagged(cause, 'process-exited', 'native-turn'); }
export function protocolInterruption(cause: unknown, phase: HostTag['phase']): Error { return tagged(cause, 'protocol-error', phase); }

const CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
export interface InterruptionContext {
  phase: TurnInterruptionV1['phase'];
  retry: TurnInterruptionV1['retry'];
  attempts?: number;
  /** The caller's existing typed lifecycle decision wins; this module does not infer it from AbortError. */
  suppressed?: 'stopped' | 'host-deadline' | 'approval-wait' | 'safety-limit';
}

/** At most the original Error plus three cause links, with cycle detection. Never inspect message prose. */
export function classifyTurnInterruption(error: unknown, context: InterruptionContext): TurnInterruptionV1 | undefined {
  if (context.suppressed !== undefined) return undefined;
  let cursor = error;
  let observation: HostTag | undefined;
  let timeout = false;
  let connection = false;
  const visited = new Set<Error>();
  for (let depth = 0; depth <= 3 && cursor instanceof Error && !visited.has(cursor); depth++) {
    visited.add(cursor);
    observation ??= hostTags.get(cursor);
    try {
      const code: unknown = (cursor as Error & { code?: unknown }).code;
      if (typeof code === 'string') {
        timeout ||= TIMEOUT_CODES.has(code);
        connection ||= CONNECTION_CODES.has(code);
      }
      cursor = cursor.cause;
    } catch { break; }
  }
  // A reader socket wrapper cannot hide the reader's actual timeout. Explicit protocol/provider/process facts
  // otherwise retain their source meaning; an arbitrary TypeError or AbortError remains unknown.
  const kind = timeout || observation?.kind === 'provider-timeout' ? 'provider-timeout'
    : observation && observation.kind !== 'connection-lost' ? observation.kind
      : connection || observation?.kind === 'connection-lost' ? 'connection-lost' : 'unknown';
  return parseTurnInterruption({ schemaVersion: 1, kind, phase: observation?.phase ?? context.phase,
    retry: context.retry, ...(context.attempts !== undefined ? { attempts: context.attempts } : {}) });
}

/** Product UI is English. No raw error, tool prose, provider name, or action callback is accepted here. */
export function interruptionReason(interruption: TurnInterruptionV1): string {
  switch (interruption.kind) {
    case 'connection-lost': return interruption.phase === 'reading-response'
      ? 'The connection to the model provider was interrupted while the reply was being received.'
      : 'The connection to the model provider ended before a complete reply was received.';
    case 'provider-timeout': return 'Timed out waiting for the model provider. This turn was interrupted.';
    case 'provider-error': return 'The model provider returned an error. This turn did not finish normally.';
    case 'process-exited': return 'The agent program exited before this turn finished.';
    default: return 'This turn was interrupted by an error and did not finish normally.';
  }
}

export function interruptionRetryReason(interruption: TurnInterruptionV1): string {
  switch (interruption.retry) {
    case 'exhausted': return 'The existing retry or time limit was reached.';
    case 'after-tool': return 'No automatic resend was made because an operation had already started.';
    case 'native-unknown': return 'The CLI may already have acted, so this turn was not automatically sent again.';
    case 'not-retryable': return 'This failure was not eligible for an automatic resend.';
    default: return 'No safe automatic resend was available.';
  }
}
