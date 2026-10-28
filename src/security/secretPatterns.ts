/* Shared mechanical secret vocabulary. It is deliberately content-only: callers decide whether
 * examining a local source is appropriate; this module never sends it anywhere. */
import patterns from './secret-patterns.json';

export interface SecretPattern {
  readonly expression: RegExp;
  readonly label: string;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = patterns.map(({ source, label }) => ({
  expression: new RegExp(source),
  label,
}));

/** Return labels only; callers must never copy a matched secret into a UI, log, or prompt. */
export function secretPatternSignals(text: string | undefined): string[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  return SECRET_PATTERNS.filter(({ expression }) => expression.test(text)).map(({ label }) => label);
}
