/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which processes still run, by their operating-system creation time (v0.9.97)
 *  A lease names the process that holds it, and its CLI child, by `{ pid, creation }`, where `creation` is the
 *  creation time Windows reports for the process, with 100 ns precision. A process number alone is not an identity:
 *  Windows reuses numbers. A creation time is never compared with a clock estimate either.
 *
 *  Windows PowerShell answers with a fixed script (`Get-CimInstance Win32_Process` for the given numbers). The answer
 *  is framed and bounded; anything else is `unavailable`, and an unavailable answer makes every identity `unknown`,
 *  which counts as alive. Every answer must also list this process itself, which is surely running: an answer that
 *  does not cannot prove anything dead. The query costs about a second, so it never runs on the send path: a launcher
 *  writes `pending` first, and only cleanup asks.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { Liveness, ProcessIdentity } from './contracts';
import {
  encodePowerShellScript,
  runWindowsPowerShell,
  type WindowsPowerShellDeps,
  type WindowsPowerShellRequest,
  type WindowsPowerShellRunResult,
} from '../windowsPowerShell';

/**
 * The script, exactly as it runs. The numbers arrive as base64 of a comma-separated list and are cast to unsigned
 * integers before the filter is built, so nothing else can reach the query. A test pins the SHA-256 of
 * `PROCESS_CREATION_ENCODED_COMMAND`, so a change here is a reviewed change.
 */
export const PROCESS_CREATION_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'UNODE-PC1:CLM'; exit 3 }
$ProgressPreference = 'SilentlyContinue'
try {
  $ids = @(([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($env:UNODE_PC_INPUT))).Split(',') | ForEach-Object { [uint32]$_ })
  $filter = (@($ids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR ')
  $found = @(CimCmdlets\Get-CimInstance -ClassName Win32_Process -Filter $filter)
  'UNODE-PC1:BEGIN'
  foreach ($p in $found) { 'UNODE-PC1:' + [string]$p.ProcessId + ' ' + $p.CreationDate.ToUniversalTime().ToString('o') }
  'UNODE-PC1:END'
} catch { 'UNODE-PC1:ERR'; exit 4 }
`;

/** What `-EncodedCommand` receives. */
export const PROCESS_CREATION_ENCODED_COMMAND = encodePowerShellScript(PROCESS_CREATION_SCRIPT);
/** The one variable that carries the input. */
export const PROCESS_CREATION_INPUT_VARIABLE = 'UNODE_PC_INPUT';
export const PROCESS_CREATION_TIMEOUT_MS = 5_000;
export const PROCESS_CREATION_MAX_OUTPUT_BYTES = 4 * 1024;
/** The most numbers in one run, this process included; more go into further runs. Keeps an answer below 4 KiB. */
export const PROCESS_CREATION_BATCH = 60;
const MAX_INPUT_CHARS = 2 * 1024;

/** A creation time as the script prints it: UTC, seven fractional digits. */
export const PROCESS_CREATION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const ANSWER_LINE = /^UNODE-PC1:(\d{1,10}) (\S+)$/;

/** The creation time of each listed number that runs now, or `unavailable`. A number not in the map does not run. */
export type ProcessCreations = ReadonlyMap<number, string> | 'unavailable';

/** What the instance store asks; built by `processCreationQuery`. */
export type ProcessCreationQuery = (pids: readonly number[]) => Promise<ProcessCreations>;

export interface ProcessCreationQueryRequest {
  /** A folder the caller owns: PowerShell's working folder. */
  ownedFolder: string;
  /** A folder the caller owns: PowerShell's TEMP and TMP. */
  ownedTmp: string;
  workspaceRoots?: readonly string[];
  worktreeRoots?: readonly string[];
}

export interface ProcessCreationQueryDeps extends WindowsPowerShellDeps {
  /** One run of the fixed script; `runWindowsPowerShell` with the other dependencies by default. */
  runPowerShell?: (request: WindowsPowerShellRequest) => Promise<WindowsPowerShellRunResult>;
  /** This process's number, which every answer must list; `process.pid` by default. */
  selfPid?: number;
}

export function isProcessNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

/**
 * The creation times of `pids` that run now. Off Windows, and on every failure of a run, `unavailable`. A number
 * that is not an integer from 1 to 2^32 - 1, or a folder that is not an absolute Windows path, throws a `TypeError`
 * before anything starts.
 */
export async function queryProcessCreations(
  pids: readonly number[],
  request: ProcessCreationQueryRequest,
  deps: ProcessCreationQueryDeps = {},
): Promise<ProcessCreations> {
  const self = deps.selfPid ?? process.pid;
  for (const pid of [...pids, self]) {
    if (!isProcessNumber(pid)) throw new TypeError(`The process query was not started: ${String(pid)} is not a process number.`);
  }
  if (pids.length === 0) return new Map();
  if ((deps.platform ?? process.platform) !== 'win32') return 'unavailable';
  for (const folder of [request.ownedFolder, request.ownedTmp]) {
    if (typeof folder !== 'string' || !path.win32.isAbsolute(folder)) {
      throw new TypeError('The process query was not started: its folders are not absolute Windows paths.');
    }
  }
  const wanted = [...new Set(pids)].filter((pid) => pid !== self);
  const run = deps.runPowerShell ?? ((powerShellRequest: WindowsPowerShellRequest) => runWindowsPowerShell(powerShellRequest, deps));
  const creations = new Map<number, string>();
  let selfCreation: string | undefined;
  // Every run asks for this process too, so an empty or truncated answer can never read as "all ended".
  for (let start = 0; start === 0 || start < wanted.length; start += PROCESS_CREATION_BATCH - 1) {
    const batch = [self, ...wanted.slice(start, start + PROCESS_CREATION_BATCH - 1)];
    const answer = parseProcessCreationAnswer(await run({
      encodedCommand: PROCESS_CREATION_ENCODED_COMMAND,
      inputVariable: PROCESS_CREATION_INPUT_VARIABLE,
      input: Buffer.from(batch.join(','), 'ascii').toString('base64'),
      maxInputChars: MAX_INPUT_CHARS,
      cwd: request.ownedFolder,
      tmp: request.ownedTmp,
      timeoutMs: PROCESS_CREATION_TIMEOUT_MS,
      maxStdoutBytes: PROCESS_CREATION_MAX_OUTPUT_BYTES,
      workspaceRoots: request.workspaceRoots ?? [],
      worktreeRoots: request.worktreeRoots ?? [],
    }), batch);
    if (answer === 'unavailable') return 'unavailable';
    const own = answer.get(self);
    if (own === undefined || (selfCreation !== undefined && own !== selfCreation)) return 'unavailable';
    selfCreation = own;
    for (const [pid, creation] of answer) creations.set(pid, creation);
  }
  if (pids.includes(self) && selfCreation !== undefined) creations.set(self, selfCreation);
  else creations.delete(self);
  return creations;
}

/**
 * One run's answer: `UNODE-PC1:BEGIN`, one line `UNODE-PC1:<pid> <creation>` per running process that was asked for,
 * `UNODE-PC1:END`, and nothing else. A run that did not exit with 0, an extra or malformed line, a number not asked
 * for or listed twice, or a creation time in another form makes the whole answer `unavailable`.
 */
export function parseProcessCreationAnswer(result: WindowsPowerShellRunResult, asked: readonly number[]): ProcessCreations {
  if (result.status !== 'exited' || result.code !== 0 || result.signal !== null) return 'unavailable';
  if (Buffer.byteLength(result.stdout, 'utf8') > PROCESS_CREATION_MAX_OUTPUT_BYTES) return 'unavailable';
  const lines = result.stdout.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2 || lines[0] !== 'UNODE-PC1:BEGIN' || lines[lines.length - 1] !== 'UNODE-PC1:END') return 'unavailable';
  const askedSet = new Set(asked);
  const creations = new Map<number, string>();
  for (const line of lines.slice(1, -1)) {
    const match = ANSWER_LINE.exec(line);
    if (!match) return 'unavailable';
    const pid = Number(match[1]);
    if (!askedSet.has(pid) || creations.has(pid) || !PROCESS_CREATION_PATTERN.test(match[2])) return 'unavailable';
    creations.set(pid, match[2]);
  }
  return creations;
}

/**
 * One identity against an answer. Dead only with positive proof: the number does not run, or it runs with another
 * creation time. A `pending` identity or an unavailable answer is `unknown`.
 */
export function judgeProcessIdentity(identity: ProcessIdentity, answer: ProcessCreations): Liveness {
  if (identity.creation === 'pending' || answer === 'unavailable') return 'unknown';
  const creation = answer.get(identity.pid);
  if (creation === undefined) return 'dead';
  return creation === identity.creation ? 'alive' : 'dead';
}

/** The query the instance store is given: these folders and dependencies for every run. */
export function processCreationQuery(request: ProcessCreationQueryRequest, deps: ProcessCreationQueryDeps = {}): ProcessCreationQuery {
  return (pids) => queryProcessCreations(pids, request, deps);
}
