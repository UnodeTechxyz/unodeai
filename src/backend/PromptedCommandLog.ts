/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Prompted command log
 *  An intentionally local, opt-in frequency table for commands that reached a human approval
 *  prompt. The caller supplies CommandPolicy.commandTemplate(command), never the raw command.
 *--------------------------------------------------------------------------------------------*/

export interface PromptedCommandFrequency {
  template: string;
  count: number;
}

export interface SerializedPromptedCommandLog {
  version: 1;
  entries: PromptedCommandFrequency[];
}

/** A token that carries a filesystem location rather than a verb. */
function looksLikePath(token: string): boolean {
  return token.startsWith('/') || token.startsWith('~')
    || token.includes('/') || token.includes('\\')
    || /^[a-z]:$/i.test(token.slice(0, 2));
}

/**
 * Redact everything after the leading verb that could carry a location or a credential.
 *
 * `CommandPolicy.commandTemplate()` is a SAFETY function for allowlisting, not a sanitizer. It
 * deliberately keeps the second token so "git status" cannot green-light "git reset --hard" —
 * correct there, but it means the template carries whatever that token happens to be. For
 * interpreter-style tools that is an absolute path (`node /Users/alice/clients/acme/deploy.js`),
 * and when the token is a flag with an inline value it is that value (`kubectl --token=SECRET`).
 *
 * This log is opt-in and local, but it exists to be READ — and pasted into a chat or an issue.
 * Home-directory layout, client names and inline credentials must not survive into it.
 *
 * Redaction costs AR2 nothing. You would never allowlist bare `node` or a `--token=` flag, so
 * "node <path> was prompted 47 times" is exactly as actionable as the full path would be.
 */
export function redactTemplateForLog(template: string): string {
  const tokens = (template ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '';
  }
  return tokens
    .map((token, index) => {
      if (index === 0) {
        return token; // the verb itself
      }
      const equals = token.indexOf('=');
      if (equals > 0) {
        return `${token.slice(0, equals)}=<redacted>`;
      }
      return looksLikePath(token) ? '<path>' : token;
    })
    .join(' ');
}

/**
 * Dependency-free local aggregate. It deliberately has no transport, filesystem, or VS Code API:
 * persistence and presentation are owned by the extension host.
 */
export class PromptedCommandLog {
  private readonly counts = new Map<string, number>();

  /** Record a command template that reached a user approval prompt. Redacted defensively — see below. */
  record(template: string): void {
    const normalized = redactTemplateForLog(template);
    if (!normalized) {
      return;
    }
    this.counts.set(normalized, (this.counts.get(normalized) ?? 0) + 1);
  }

  /** Highest frequency first; template name provides stable ordering for ties. */
  ranked(): PromptedCommandFrequency[] {
    return [...this.counts.entries()]
      .map(([template, count]) => ({ template, count }))
      .sort((a, b) => b.count - a.count || a.template.localeCompare(b.template));
  }

  serialize(): SerializedPromptedCommandLog {
    return { version: 1, entries: this.ranked() };
  }

  /** Tolerant restore: malformed or non-positive persisted rows are ignored, never displayed. */
  restoreFrom(data: SerializedPromptedCommandLog | undefined): void {
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) {
      return;
    }
    this.counts.clear();
    for (const entry of data.entries) {
      if (!entry || typeof entry.template !== 'string' || !entry.template.trim() ||
          typeof entry.count !== 'number' || !Number.isSafeInteger(entry.count) || entry.count <= 0) {
        continue;
      }
      this.counts.set(entry.template.trim(), entry.count);
    }
  }
}

/** Render only templates and counts for the dedicated local Output channel. */
export function formatPromptedCommandLog(entries: readonly PromptedCommandFrequency[]): string[] {
  if (entries.length === 0) {
    return ['No command approval prompts have been logged on this machine yet.'];
  }
  const rows = entries.map((entry, index) => `${String(index + 1).padStart(2, ' ')}  ${String(entry.count).padStart(5, ' ')}  ${entry.template}`);
  return [
    'Rank  Count  Command template',
    '----  -----  ----------------',
    ...rows,
  ];
}
