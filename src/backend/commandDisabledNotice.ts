import { redactDiagnosticText } from '../security/diagnosticRedaction';

/** One host line per refused command; quote control characters and never echo credentials. */
export function commandDisabledNotice(command: string, cwd: string | undefined): string {
  const quote = (text: string) => JSON.stringify(redactDiagnosticText(text)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `Commands are disabled, so UnodeAi did not run: ${quote(command)} (folder: ${quote(cwd ?? 'not specified')}). To enable them: 1. Run UnodeAi: Open Settings from the Command Palette. 2. Open More → Advanced permission settings. 3. Select User, find unode.commandApproval, and choose all or ask. A recognised dangerous delete will then ask you first.`;
}
