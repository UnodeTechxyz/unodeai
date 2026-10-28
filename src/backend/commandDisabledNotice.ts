import { redactDiagnosticText } from '../security/diagnosticRedaction';

/** One host line per refused command; quote control characters and never echo credentials. */
export function commandDisabledNotice(command: string, cwd: string | undefined): string {
  const quote = (text: string) => JSON.stringify(redactDiagnosticText(text)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `Commands are disabled, so UnodeAi did not run: ${quote(command)} (folder: ${quote(cwd ?? 'not specified')}). To let agents run commands, choose Commands → Automatic or Ask each at the bottom of the chat panel. A recognised dangerous delete will then ask you first.`;
}
