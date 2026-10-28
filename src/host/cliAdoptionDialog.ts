/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the question asked before an External CLI program this UnodeAi has not qualified first runs (v0.9.97)
 *  Every line comes from what was measured without starting the program: its physical path and install type, the
 *  closure listing (file count, bytes) and the publisher signature results, or why they were not checked. Nothing in
 *  it is a constant about a vendor's package. The signature check itself is the caller's; this only words its result.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { CliClosureFile, CliClosureKind } from '../backend/cliCompatibilityPolicy';
import { classifyCliSource, type CliRuntimeProvider } from '../backend/cliRuntime';
import { CLAUDE_NPM_LAUNCHER_PROGRAM } from '../backend/cliClosure';
import { isPathStrictlyInside } from '../backend/pathContainment';
import { AUTHENTICODE_OFFLINE_TEXT, type AuthenticodeCheckResult, type AuthenticodeFileVerdict } from './windowsAuthenticode';

export const ADOPTION_CHECK_BUTTON = 'Check and use this program';
export const ADOPTION_NOT_NOW_BUTTON = 'Not now';

/** The publisher each signer token stands for, as the dialog names it. */
const PUBLISHER_NAME: Readonly<Record<'openai' | 'microsoft-crt', string>> = {
  openai: 'OpenAI OpCo, LLC',
  'microsoft-crt': 'Microsoft',
};

/** The signature results, or why there are none (for example: not Windows, or the check was not run). */
export type AdoptionSignatures = AuthenticodeCheckResult | { status: 'not-checked'; reason: string };

export interface AdoptionDialogInput {
  provider: CliRuntimeProvider;
  /** The physical program. */
  executable: string;
  /** The measured closure: its kind, its listing (relative paths) and the listing path of the program. */
  closure: { kind: CliClosureKind; files: readonly CliClosureFile[]; executablePath: string; root?: string };
  signatures: AdoptionSignatures;
  host: { platform: NodeJS.Platform; arch: string; env: NodeJS.ProcessEnv; execPath: string };
}

export interface AdoptionDialogText {
  title: string;
  /** One line per fact, in order; a modal shows them joined by line breaks. */
  lines: string[];
  buttons: readonly [typeof ADOPTION_CHECK_BUTTON, typeof ADOPTION_NOT_NOW_BUTTON];
}

const LABEL: Readonly<Record<CliRuntimeProvider, string>> = { 'claude-cli': 'Claude CLI', 'codex-cli': 'Codex CLI' };

/** Bytes as the dialog shows them: decimal units, one decimal place. */
export function formatAdoptionBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function files(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`;
}

/** The dialog for one program, filled from its measured facts. */
export function adoptionDialog(input: AdoptionDialogInput): AdoptionDialogText {
  const { provider, closure, signatures, host } = input;
  const label = LABEL[provider];
  const installType = classifyCliSource(provider, input.executable, host.env, host.platform, host.execPath);
  const program = closure.files.find((file) => file.path === closure.executablePath);
  const programName = closure.executablePath.split('/').pop() ?? closure.executablePath;
  const bytes = closure.files.reduce((total, file) => total + file.size, 0);
  const listingName = displayName(closure.root, host.platform);

  const lines = [
    `Program: ${input.executable} (${installType}). UnodeAi did not install or update it.`,
    'Version: not yet verified. UnodeAi has not started this program.',
  ];
  let covers: { exact: string; change: string };
  switch (closure.kind) {
    case 'package':
      lines.push(`Package: ${files(closure.files.length)}, ${formatAdoptionBytes(bytes)}, checked by hash. This exact set is not one UnodeAi has qualified.`);
      lines.push(`Publisher signatures: ${signatureSummary(signatures, listingName)}`);
      covers = { exact: 'this exact package', change: 'Any change to one of its files asks again.' };
      break;
    case 'unbounded':
      lines.push(`Package: UnodeAi could not identify the package this program belongs to, so programs it may start from beside it (for example rg.exe) are not identified, not checked, and not covered by this choice. Only ${programName} itself (${formatAdoptionBytes(program?.size ?? bytes)}) is checked by hash.`);
      lines.push(`Publisher signature of ${programName}: ${singleSignature(signatures)}`);
      covers = { exact: 'this exact program', change: 'Any change to it asks again.' };
      break;
    case 'launcher-pair': {
      const started = closure.files.find((file) => file.path !== closure.executablePath);
      lines.push(`Package: ${files(closure.files.length)}, ${formatAdoptionBytes(bytes)}, checked by hash: the launcher ${closure.executablePath} and the program it starts, ${started?.path ?? CLAUDE_NPM_LAUNCHER_PROGRAM.join('/')}. The launcher is a script that is not signed. This exact pair is not one UnodeAi has qualified.`);
      lines.push(`Publisher signature of ${(started?.path ?? '').split('/').pop() || 'the program'}: ${singleSignature(signatures)}`);
      covers = { exact: 'these exact two files', change: 'Any change to either file asks again.' };
      break;
    }
    default:
      lines.push(`Package: ${files(closure.files.length)}, ${formatAdoptionBytes(bytes)}, checked by hash. This exact file is not one UnodeAi has qualified.`);
      lines.push(`Publisher signature: ${singleSignature(signatures)}`);
      covers = { exact: 'this exact file', change: 'Any change to it asks again.' };
  }
  if (host.platform !== 'win32' || host.arch !== 'x64') lines.push('UnodeAi qualifies CLI versions on Windows x64 only.');
  lines.push(`If you continue, UnodeAi starts it once in its own folder to read its version and check its safety interfaces. That run sends no model request and opens no workspace.${provider === 'claude-cli' ? ' Starting it may also run Claude Code\'s own update check.' : ''} If the check passes, agents use ${covers.exact}. ${covers.change}`);
  return { title: `Use ${label} with UnodeAi?`, lines, buttons: [ADOPTION_CHECK_BUTTON, ADOPTION_NOT_NOW_BUTTON] };
}

/** A file of the check as the dialog names it: its listing path below the package root, or its own name. */
function displayName(root: string | undefined, platform: NodeJS.Platform): (file: string) => string {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  return (file) => {
    if (root && isPathStrictlyInside(root, file, hostPath)) return hostPath.relative(root, file).split(hostPath.sep).join('/');
    return hostPath.basename(file);
  };
}

/** The package line: counts per publisher, the files without a signature named, and every file that failed. */
function signatureSummary(signatures: AdoptionSignatures, name: (file: string) => string): string {
  if (signatures.status !== 'checked') return `not checked: ${notCheckedReason(signatures)}.`;
  const parts: string[] = [];
  const signedBy = (signer: 'openai' | 'microsoft-crt') => signatures.counts[signer];
  if (signedBy('openai') > 0) parts.push(`${files(signedBy('openai'))} signed by ${PUBLISHER_NAME.openai}`);
  if (signedBy('microsoft-crt') > 0) parts.push(parts.length > 0 ? `${signedBy('microsoft-crt')} by ${PUBLISHER_NAME['microsoft-crt']}` : `${files(signedBy('microsoft-crt'))} signed by ${PUBLISHER_NAME['microsoft-crt']}`);
  if (signatures.unsignedFiles.length > 0) {
    parts.push(`${signatures.unsignedFiles.length} without a signature (${signatures.unsignedFiles.map(name).join(', ')})`);
  }
  const failed = signatures.files.filter((verdict): verdict is Extract<AuthenticodeFileVerdict, { accepted: false }> => !verdict.accepted);
  if (failed.length > 0) {
    const shown = failed.slice(0, 3).map((verdict) => `${name(verdict.path)}: ${verdict.reason}`).join('; ');
    parts.push(`${failed.length} not verified (${shown}${failed.length > 3 ? `; and ${failed.length - 3} more` : ''})`);
  }
  if (parts.length === 0) return 'no file of this package carries a signature that was checked.';
  const offline = signatures.revocation === 'not-confirmed-offline' ? ` Revocation: ${AUTHENTICODE_OFFLINE_TEXT}.` : '';
  return `${parts.join('; ')}.${offline}`;
}

/** The signature line of one program file: its publisher, that it has none, or why it was not verified. */
function singleSignature(signatures: AdoptionSignatures): string {
  if (signatures.status !== 'checked') return `not checked: ${notCheckedReason(signatures)}.`;
  const verdict = signatures.files[0];
  if (!verdict) return 'not checked: it is not a program file Windows signs.';
  if (!verdict.accepted) return `not verified: ${verdict.reason}.`;
  if (verdict.signer === 'unsigned') return 'none; the file carries no signature.';
  const offline = verdict.revocation === 'not-confirmed-offline' ? ` (${AUTHENTICODE_OFFLINE_TEXT})` : '';
  return `${PUBLISHER_NAME[verdict.signer]}${offline}.`;
}

function notCheckedReason(signatures: Exclude<AdoptionSignatures, { status: 'checked' }>): string {
  return signatures.status === 'unavailable' ? signatures.message : signatures.reason;
}
