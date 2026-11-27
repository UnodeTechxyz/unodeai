/** Content-free observation of a real resend, not a request identity or recovery instruction. */
export interface ResponseRetry {
  previousAttempt: number;
  attempt: number;
  reason: 'connection-lost' | 'provider-timeout';
}

export function parseResponseRetry(raw: unknown): ResponseRetry | undefined {
  try {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Partial<ResponseRetry>;
  if (!Number.isSafeInteger(value.previousAttempt) || !Number.isSafeInteger(value.attempt)
    || value.previousAttempt! < 1 || value.attempt! <= value.previousAttempt! || value.attempt! > 100_000
    || value.reason !== 'connection-lost' && value.reason !== 'provider-timeout') return undefined;
  return { previousAttempt: value.previousAttempt!, attempt: value.attempt!, reason: value.reason };
  } catch { return undefined; }
}
