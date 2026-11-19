import { SECRET_PATTERNS } from './secretPatterns';

/**
 * Shared mechanical redaction for diagnostics and approval previews, excluding ordinary model-bound file content.
 * Never a claim that every sensitive value can be identified.
 */
export function redactDiagnosticText(value: string): string {
  return redactSecretText(value).trim().slice(0, 4000);
}

/** The same vocabulary for model-bound file text, without diagnostic truncation or whitespace changes. */
export function redactSecretText(value: string, preserveLines = false): string {
  let redacted = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      (key) => '[redacted private key]' + (preserveLines ? '\n'.repeat((key.match(/\n/g) ?? []).length) : ''))
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://[redacted]@')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&]key=)[^\s&#]*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret|authorization)\b\s*([:=])\s*[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/(--(?:token|password|secret|api[_-]?key)=(?:[^\s]+))/gi, (match) => `${match.slice(0, match.indexOf('='))}=[redacted]`);
  for (const { expression } of SECRET_PATTERNS) {
    redacted = redacted.replace(new RegExp(expression.source, 'g'), '[redacted secret]');
  }
  return redacted;
}
