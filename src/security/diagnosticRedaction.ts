import { SECRET_PATTERNS } from './secretPatterns';

/** Shared mechanical redaction. Never a claim that every sensitive value can be identified. */
export function redactDiagnosticText(value: string): string {
  let redacted = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&]key=)[^\s&#]*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret|authorization)\b\s*([:=])\s*[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/(--(?:token|password|secret|api[_-]?key)=(?:[^\s]+))/gi, (match) => `${match.slice(0, match.indexOf('='))}=[redacted]`);
  for (const { expression } of SECRET_PATTERNS) {
    redacted = redacted.replace(new RegExp(expression.source, 'g'), '[redacted secret]');
  }
  return redacted.trim().slice(0, 4000);
}
