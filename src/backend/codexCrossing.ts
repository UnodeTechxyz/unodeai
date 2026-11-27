/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Codex sandbox crossings (v0.9.102, the Owner's decisions of 2026-11-12)
 *
 *  Codex's own reviewer no longer decides a crossing. Under Approve for me, an escape is first declined with a note
 *  asking Codex to try inside the sandbox; asked again, or after a sandbox failure, it is the person's card. Under
 *  Ask for approval every escape is the card. A decline runs nothing, so no rule here needs to prove what a command
 *  does. What is kept of a card or a notice is a fixed record from closed lists, never a command's text or target.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual } from './pathContainment';

type JsonObject = Record<string, unknown>;

/** Sent to Codex on the same turn as the decline of its first escape (measured: Codex retries in the sandbox). */
export const CODEX_REDIRECT_NOTE = 'UnodeAi did not run that command outside the sandbox. Reads anywhere, and writes '
  + 'inside the workspace and granted folders, work inside the sandbox: run the command again now without requesting '
  + 'escalation. If it still fails inside the sandbox, you may request escalation again; the user will then be asked.';

/** The person's line for a redirect. */
export const CODEX_REDIRECT_LINE = 'Codex asked to run a command outside its sandbox; UnodeAi asked it to try inside '
  + 'the sandbox first.';

/** The person's line when the note could not be delivered: the decline stands and the next escape is a card. */
export const CODEX_STEER_FAILED_LINE = 'UnodeAi declined a command outside Codex\'s sandbox but could not ask Codex to '
  + 'retry inside it. If Codex stops, ask it in this chat to try again; it will then ask you.';

/** Shown on a Codex command card, above the exact command. */
export const CODEX_COMMAND_CARD_WARNING = 'Running it means it runs once outside Codex\'s sandbox, with everything it '
  + 'does. This card\'s own record keeps only the program name and your choice. The command\'s activity card in this '
  + 'chat shows and keeps its text and output, as for every command.';

/** A file change outside this agent's folders is refused before any card; this names the next step. */
export const CODEX_OUTSIDE_PATCH_REFUSAL = 'UnodeAi did not write outside this agent\'s folders. To allow it, use '
  + 'Grant access on the folder\'s item in this chat, or Security → File access; it applies from the next turn.';

/** Codex 0.165.0 App Server schema: every field a command approval request may carry. */
const MODERN_COMMAND_APPROVAL_FIELDS: ReadonlySet<string> = new Set([
  'approvalId', 'availableDecisions', 'command', 'commandActions', 'cwd', 'environmentId', 'itemId', 'kind',
  'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'reason', 'startedAtMs',
  'threadId', 'turnId',
]);
const LEGACY_COMMAND_APPROVAL_FIELDS: ReadonlySet<string> = new Set([
  'approvalId', 'callId', 'command', 'conversationId', 'cwd', 'parsedCmd', 'reason',
]);

/**
 * True when a command approval carries something this host has not measured: a field outside the 0.165 schema, a
 * network context, or a proposed network amendment. Such a request is never redirected; it is the person's card.
 */
export function codexEscapeNeedsCard(params: JsonObject, legacy: boolean): boolean {
  const known = legacy ? LEGACY_COMMAND_APPROVAL_FIELDS : MODERN_COMMAND_APPROVAL_FIELDS;
  if (Object.keys(params).some((key) => !known.has(key))) return true;
  const present = (key: string) => params[key] !== undefined && params[key] !== null
    && !(Array.isArray(params[key]) && (params[key] as unknown[]).length === 0);
  return present('networkApprovalContext') || present('proposedNetworkPolicyAmendments');
}

/** The closed list of program labels a saved card record or notice may name. */
const PROGRAM_LABELS: ReadonlySet<string> = new Set([
  'powershell', 'pwsh', 'cmd', 'git', 'npm', 'npx', 'node', 'python', 'py', 'pip', 'curl', 'dotnet', 'cargo', 'go',
  'docker', 'kubectl', 'gh', 'az',
]);

/**
 * The program label of a transported command: the base name of its executable, lower-cased and without an
 * extension, when it is on the closed list; otherwise `a program`. Nothing else of the command is ever used.
 */
export function codexProgramLabel(transportedCommand: string): string {
  const text = transportedCommand.trim();
  let first: string;
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    first = end > 0 ? text.slice(1, end) : '';
  } else {
    first = text.split(/\s+/, 1)[0] ?? '';
  }
  const base = first.split(/[\\/]/).pop() ?? '';
  const label = base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  return PROGRAM_LABELS.has(label) ? label : 'a program';
}

export type CodexCardChoice = 'run once' | 'grant folder, then run once' | 'allow network, then run once' | 'declined' | 'expired';

/** The fixed record kept of a Codex command card: closed-list words and a time, nothing from the command. */
export function codexCardRecordLine(programLabel: string, choice: CodexCardChoice, at: Date): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const label = PROGRAM_LABELS.has(programLabel) ? programLabel : 'a program';
  return choice === 'declined' || choice === 'expired'
    ? `Codex command (${label}): ${choice} at ${time}.`
    : `Codex command (${label}): ${choice} at ${time}, outside the sandbox.`;
}

/** The folder a card may offer to grant, judged on the local disk. */
export interface CodexCardFolderInput {
  /** The command's literal words (the bounded scan); undefined when the command could not be read. */
  segments: readonly (readonly string[])[] | undefined;
  /** Targets the person's own request named: candidates as well, with the same mapping and ambiguity rule. */
  named: readonly string[];
  /** The agent's writable roots now: a folder already inside them needs no grant. */
  writeRoots: readonly string[];
}

/** An absolute local path written out in full: no wildcard, share, device or relative spelling. */
function plainAbsolute(word: string): boolean {
  if (!path.isAbsolute(word) || /[*?[\]]/.test(word)) return false;
  return !/^[\/]{2}/.test(word);
}

/** The folder a candidate names on the disk, or undefined when the disk cannot say. */
function folderOf(candidate: string): string | undefined {
  if (!plainAbsolute(candidate)) return undefined;
  const real = (target: string) => realpathSync.native(target);
  try {
    const found = statSync(candidate, { throwIfNoEntry: false });
    if (found?.isDirectory()) return real(candidate);
    if (found) return real(path.dirname(candidate));
    const parent = statSync(path.dirname(candidate), { throwIfNoEntry: false });
    return parent?.isDirectory() ? real(path.dirname(candidate)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * v0.9.102 (R2): the one folder a card may offer to grant with "Grant … then run once", or undefined.
 * - The candidates are every absolute argument of the command (never its program) plus what the person's own request
 *   named (draft 13, §15.3).
 * - Each candidate maps to a folder: an existing folder itself, an existing file's folder, or a new file's existing
 *   parent. Anything else maps to none, and then the whole offer is ambiguous: a candidate is never dropped to make one
 *   folder remain. Only a folder already inside the writable roots is left out.
 * - Exactly one physical folder must remain.
 */
export function codexCardFolder(input: CodexCardFolderInput): string | undefined {
  // The first word of a segment is the program that runs, never a target: it is not a candidate.
  const fromCommand = (input.segments ?? []).flatMap((argv) => argv.slice(1)).filter((word) => path.isAbsolute(word));
  const candidates = [...fromCommand, ...input.named];
  const folders = new Map<string, string>();
  for (const candidate of candidates) {
    const folder = folderOf(candidate);
    if (folder === undefined) return undefined;
    if (input.writeRoots.some((root) => isPathInsideOrEqual(root, folder))) continue;
    folders.set(process.platform === 'win32' ? folder.toLowerCase() : folder, folder);
  }
  return folders.size === 1 ? [...folders.values()][0] : undefined;
}

/**
 * The measured connection failures of a sandboxed command with network off: Windows PowerShell, curl and git; and
 * npm and Node's fetch, whose request error counts only together with the sandbox's refused connect (`EACCES`).
 */
export function codexConnectionFailure(output: string): boolean {
  if (/无法连接到远程服务器|Unable to connect to the remote server|Failed to connect|Could not connect to server|could not resolve host/i
    .test(output)) return true;
  return /FetchError: request to https?:\/\/\S+ failed|TypeError: fetch failed/.test(output) && /\bEACCES\b/.test(output);
}

const OUTWARD_KINDS: ReadonlySet<string> = new Set(['push', 'publish', 'deploy', 'post']);

/** v0.9.102 (§4d): the outward notice: the classified kind and a closed-list program label, nothing else. */
export function codexOutwardNotice(kind: string, programLabel: string): string {
  const shown = OUTWARD_KINDS.has(kind) ? kind : 'outward';
  const label = PROGRAM_LABELS.has(programLabel) ? programLabel : 'a program';
  return `Codex is running an outward action (${shown}) with ${label}. It was not asked first because network is `
    + 'allowed for this session. Stop ends the turn; it does not undo what was sent.';
}

/** v0.9.102 (§4d): the observed outcome of an announced outward action, in the same fixed form. */
export function codexOutwardOutcome(kind: string, programLabel: string, status: 'completed' | 'failed' | 'declined'): string {
  const shown = OUTWARD_KINDS.has(kind) ? kind : 'outward';
  const label = PROGRAM_LABELS.has(programLabel) ? programLabel : 'a program';
  return `Codex outward action (${shown}) with ${label}: ${status}.`;
}
