import { redactDiagnosticText } from '../security/diagnosticRedaction';

const NAMES = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError'] as const;
const CODES = ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ENOENT', 'EACCES', 'EPERM', 'ABORT_ERR'] as const;
/** Live, host-private presentation only. Never place in bus metadata, history, closeout or portable evidence. */
export interface InterruptionDetail {
  schemaVersion: 1;
  name: typeof NAMES[number];
  code?: typeof CODES[number];
  message?: string;
}

function boundedMessage(message: string, knownSecrets: readonly string[]): string {
  let text = message.slice(0, 16_384).replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*/g, '[redacted private key]');
  for (const secret of knownSecrets.slice(0, 16)) {
    if (typeof secret !== 'string' || !secret.length) continue;
    // A long credential can cross the retained window. Match a bounded prefix and remove its whole span,
    // including any unseen tail, before applying the display cap. Over-redaction is safer than a partial key.
    const needle = secret.slice(0, 1000);
    let at = text.indexOf(needle);
    while (at >= 0) {
      text = text.slice(0, at) + '[redacted credential]' + text.slice(at + secret.length);
      at = text.indexOf(needle, at + '[redacted credential]'.length);
    }
  }
  return redactDiagnosticText(text).slice(0, 1000);
}

export function parseInterruptionDetail(raw: unknown): InterruptionDetail | undefined {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Partial<InterruptionDetail>;
    if (value.schemaVersion !== 1 || !NAMES.includes(value.name as InterruptionDetail['name'])
      || value.code !== undefined && !CODES.includes(value.code)
      || value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 1000)) return undefined;
    return { schemaVersion: 1, name: value.name!, ...(value.code ? { code: value.code } : {}),
      ...(value.message ? { message: boundedMessage(value.message, []) } : {}) };
  } catch { return undefined; }
}

/** Inspect only guarded Error fields, not arbitrary JSON, body/stack/tool output or recursive serialization. */
export function interruptionDetail(error: unknown, knownSecrets: readonly string[] = []): InterruptionDetail {
  const detail: InterruptionDetail = { schemaVersion: 1, name: 'Error' };
  if (!(error instanceof Error)) return detail;
  try {
    const name: unknown = error.name;
    if (NAMES.includes(name as InterruptionDetail['name'])) detail.name = name as InterruptionDetail['name'];
    const message: unknown = error.message;
    if (typeof message === 'string') {
      // Bound untrusted diagnostic work, including a private key whose END marker is beyond this window.
      detail.message = boundedMessage(message, knownSecrets);
    }
  } catch { /* Keep only safely observed fields. */ }
  const seen = new Set<Error>(); let cursor: unknown = error;
  for (let depth = 0; depth <= 3 && cursor instanceof Error && !seen.has(cursor); depth++) {
    seen.add(cursor);
    try {
      const code: unknown = (cursor as Error & { code?: unknown }).code;
      if (!detail.code && CODES.includes(code as InterruptionDetail['code'] & string)) detail.code = code as InterruptionDetail['code'];
      cursor = cursor.cause;
    } catch { break; }
  }
  return detail;
}
