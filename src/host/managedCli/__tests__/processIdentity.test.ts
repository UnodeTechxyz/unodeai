import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WindowsPowerShellRequest, WindowsPowerShellRunResult } from '../../windowsPowerShell';
import {
  judgeProcessIdentity,
  parseProcessCreationAnswer,
  PROCESS_CREATION_BATCH,
  PROCESS_CREATION_ENCODED_COMMAND,
  PROCESS_CREATION_INPUT_VARIABLE,
  PROCESS_CREATION_MAX_OUTPUT_BYTES,
  PROCESS_CREATION_SCRIPT,
  PROCESS_CREATION_TIMEOUT_MS,
  processCreationQuery,
  queryProcessCreations,
} from '../processIdentity';

// The design these tests realise: a lease names its holder and its CLI child by `{ pid, creation }`, the creation
// time Windows reports with 100 ns precision, never a clock estimate. The query is Windows PowerShell with a fixed
// script (`Get-CimInstance Win32_Process` for the given ids), 5 s, at most 4 KiB of output, from an owned neutral
// folder with the runner's environment allowlist. A pid absent from the answer is dead; present with another creation
// is dead; equal is alive; an unavailable answer makes every identity unknown, which counts as alive. Off Windows
// the answer is unavailable. The script is pinned by SHA-256, as the Authenticode script is.

const SELF = 7000;
const T1 = '2026-10-19T10:16:29.6764530Z';
const T2 = '2026-10-19T10:16:30.0000001Z';
const T_SELF = '2026-10-19T09:00:00.1234567Z';

function exited(stdout: string, code = 0): WindowsPowerShellRunResult {
  return { status: 'exited', code, signal: null, stdout, stderr: '' };
}

function answerOf(lines: string[]): string {
  return ['UNODE-PC1:BEGIN', ...lines, 'UNODE-PC1:END', ''].join('\r\n');
}

/** A runner that answers from a table of running processes, and records each request. */
function runner(running: Record<number, string>, override?: (request: WindowsPowerShellRequest) => WindowsPowerShellRunResult) {
  const requests: WindowsPowerShellRequest[] = [];
  const asked: number[][] = [];
  const runPowerShell = async (request: WindowsPowerShellRequest): Promise<WindowsPowerShellRunResult> => {
    requests.push(request);
    const pids = Buffer.from(request.input, 'base64').toString('ascii').split(',').map(Number);
    asked.push(pids);
    if (override) return override(request);
    return exited(answerOf(pids.filter((pid) => running[pid] !== undefined).map((pid) => `UNODE-PC1:${pid} ${running[pid]}`)));
  };
  return { runPowerShell, requests, asked };
}

const FOLDERS = { ownedFolder: 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\cli-store\\work', ownedTmp: 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\cli-store\\work\\tmp' };

describe('the fixed process-creation script', () => {
  it('is pinned by the SHA-256 of the encoded command, which is exactly what PowerShell receives', () => {
    expect(createHash('sha256').update(PROCESS_CREATION_ENCODED_COMMAND).digest('hex'))
      .toBe('e0e2dc84e7f18646ef73bbf52795c5165084c16b91bbba4ed5fc446838c04b50');
    expect(Buffer.from(PROCESS_CREATION_ENCODED_COMMAND, 'base64').toString('utf16le')).toBe(PROCESS_CREATION_SCRIPT);
  });

  it('checks the language mode first, casts every id to an unsigned integer, and prints creation times in UTC with 100 ns', () => {
    const lines = PROCESS_CREATION_SCRIPT.split('\n');
    expect(lines[1]).toBe("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'UNODE-PC1:CLM'; exit 3 }");
    expect(PROCESS_CREATION_SCRIPT).toContain('ForEach-Object { [uint32]$_ }');
    expect(PROCESS_CREATION_SCRIPT).toContain('CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter $filter');
    expect(PROCESS_CREATION_SCRIPT).toContain("$p.CreationDate.ToUniversalTime().ToString('o')");
  });
});

describe('queryProcessCreations', () => {
  it('runs the fixed script with its bounds, from the owned folders, with the ids as base64 in one variable', async () => {
    const run = runner({ [SELF]: T_SELF, 41: T1 });
    const answer = await queryProcessCreations([41], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell });
    expect(answer).toEqual(new Map([[41, T1]]));
    expect(run.requests).toHaveLength(1);
    const request = run.requests[0];
    expect(request.encodedCommand).toBe(PROCESS_CREATION_ENCODED_COMMAND);
    expect(request.inputVariable).toBe(PROCESS_CREATION_INPUT_VARIABLE);
    expect(request.timeoutMs).toBe(PROCESS_CREATION_TIMEOUT_MS);
    expect(PROCESS_CREATION_TIMEOUT_MS).toBe(5_000);
    expect(request.maxStdoutBytes).toBe(PROCESS_CREATION_MAX_OUTPUT_BYTES);
    expect(PROCESS_CREATION_MAX_OUTPUT_BYTES).toBe(4 * 1024);
    expect(request.cwd).toBe(FOLDERS.ownedFolder);
    expect(request.tmp).toBe(FOLDERS.ownedTmp);
    // This process is asked for in every run: an answer that does not list it proves nothing dead.
    expect(run.asked[0]).toEqual([SELF, 41]);
  });

  it('is unavailable off Windows, and starts nothing', async () => {
    const run = runner({ [SELF]: T_SELF, 41: T1 });
    for (const platform of ['linux', 'darwin'] as const) {
      expect(await queryProcessCreations([41], FOLDERS, { platform, selfPid: SELF, runPowerShell: run.runPowerShell })).toBe('unavailable');
    }
    expect(run.requests).toEqual([]);
  });

  it('reads a pid absent from the answer as not running', async () => {
    const run = runner({ [SELF]: T_SELF, 41: T1 });
    const answer = await queryProcessCreations([41, 42], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell });
    expect(answer).toEqual(new Map([[41, T1]]));
  });

  it('is unavailable when the answer does not list this process, so an empty answer never reads as "all ended"', async () => {
    const run = runner({ 41: T1 });
    expect(await queryProcessCreations([41], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell })).toBe('unavailable');
    const empty = runner({}, () => exited(answerOf([])));
    expect(await queryProcessCreations([41], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: empty.runPowerShell })).toBe('unavailable');
  });

  it('is unavailable when this process changes its creation time between two runs', async () => {
    let call = 0;
    const run = runner({}, (request) => {
      call++;
      const pids = Buffer.from(request.input, 'base64').toString('ascii').split(',').map(Number);
      return exited(answerOf(pids.map((pid) => `UNODE-PC1:${pid} ${pid === SELF && call > 1 ? T2 : T1}`)));
    });
    const pids = Array.from({ length: PROCESS_CREATION_BATCH + 5 }, (_, index) => 100 + index);
    expect(await queryProcessCreations(pids, FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell })).toBe('unavailable');
  });

  it('asks in batches, this process in each, and joins the answers', async () => {
    const running: Record<number, string> = { [SELF]: T_SELF };
    const pids = Array.from({ length: 2 * PROCESS_CREATION_BATCH }, (_, index) => 100 + index);
    for (const pid of pids) running[pid] = T1;
    const run = runner(running);
    const answer = await queryProcessCreations(pids, FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell });
    expect(answer).not.toBe('unavailable');
    if (answer === 'unavailable') return;
    expect([...answer.keys()].sort((a, b) => a - b)).toEqual(pids);
    expect(run.asked.length).toBe(3);
    for (const asked of run.asked) {
      expect(asked[0]).toBe(SELF);
      expect(asked.length).toBeLessThanOrEqual(PROCESS_CREATION_BATCH);
    }
  });

  it('includes this process only when it was asked for', async () => {
    const run = runner({ [SELF]: T_SELF });
    expect(await queryProcessCreations([SELF], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell })).toEqual(new Map([[SELF, T_SELF]]));
  });

  it('refuses ids that are not process numbers and folders that are not absolute, before anything starts', async () => {
    const run = runner({ [SELF]: T_SELF });
    for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 32, '41' as unknown as number]) {
      await expect(queryProcessCreations([pid], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell })).rejects.toThrow(TypeError);
    }
    await expect(queryProcessCreations([41], { ownedFolder: 'work', ownedTmp: FOLDERS.ownedTmp }, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell }))
      .rejects.toThrow(TypeError);
    expect(run.requests).toEqual([]);
  });

  it('asks nothing for no ids', async () => {
    const run = runner({ [SELF]: T_SELF });
    expect(await queryProcessCreations([], FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell })).toEqual(new Map());
    expect(run.requests).toEqual([]);
  });

  it('builds a query for the instance store with fixed folders', async () => {
    const run = runner({ [SELF]: T_SELF, 41: T1 });
    const query = processCreationQuery(FOLDERS, { platform: 'win32', selfPid: SELF, runPowerShell: run.runPowerShell });
    expect(await query([41])).toEqual(new Map([[41, T1]]));
  });
});

describe('parseProcessCreationAnswer is bounded and fail-closed', () => {
  const asked = [SELF, 41, 42];
  const ok = (lines: string[]) => exited(answerOf(lines));
  it('reads a framed answer', () => {
    expect(parseProcessCreationAnswer(ok([`UNODE-PC1:${SELF} ${T_SELF}`, `UNODE-PC1:41 ${T1}`]), asked)).toEqual(new Map([[SELF, T_SELF], [41, T1]]));
    expect(parseProcessCreationAnswer(exited(`UNODE-PC1:BEGIN\nUNODE-PC1:${SELF} ${T_SELF}\nUNODE-PC1:END`), asked)).toEqual(new Map([[SELF, T_SELF]]));
  });

  it.each([
    ['an extra line', ok([`UNODE-PC1:${SELF} ${T_SELF}`, 'WARNING: something'])],
    ['an extra line after the end', exited(`${answerOf([`UNODE-PC1:${SELF} ${T_SELF}`])}more\r\n`)],
    ['no frame', exited(`UNODE-PC1:${SELF} ${T_SELF}\r\n`)],
    ['no end', exited(`UNODE-PC1:BEGIN\r\nUNODE-PC1:${SELF} ${T_SELF}\r\n`)],
    ['an id that was not asked for', ok([`UNODE-PC1:${SELF} ${T_SELF}`, `UNODE-PC1:43 ${T1}`])],
    ['an id listed twice', ok([`UNODE-PC1:41 ${T1}`, `UNODE-PC1:41 ${T1}`])],
    ['a date without 100 ns', ok([`UNODE-PC1:41 2026-10-19T10:16:29.676Z`])],
    ['a local date', ok([`UNODE-PC1:41 2026-10-19T10:16:29.6764530+02:00`])],
    ['a malformed date', ok(['UNODE-PC1:41 yesterday'])],
    ['a malformed id', ok([`UNODE-PC1:4x1 ${T1}`])],
    ['the error marker', exited('UNODE-PC1:ERR\r\n', 4)],
    ['constrained language', exited('UNODE-PC1:CLM\r\n', 3)],
    ['a non-zero exit', exited(answerOf([`UNODE-PC1:41 ${T1}`]), 1)],
    ['a signal', { status: 'exited', code: null, signal: 'SIGTERM', stdout: answerOf([]), stderr: '' } as WindowsPowerShellRunResult],
    ['a timeout', { status: 'unavailable', reason: 'timeout', detail: 'stopped', stderr: '' } as WindowsPowerShellRunResult],
    ['an output limit', { status: 'unavailable', reason: 'output-limit', detail: 'stopped', stderr: '' } as WindowsPowerShellRunResult],
    ['PowerShell not found', { status: 'unavailable', reason: 'not-found', detail: 'none', stderr: '' } as WindowsPowerShellRunResult],
  ])('reads %s as unavailable', (_label, result) => {
    expect(parseProcessCreationAnswer(result, asked)).toBe('unavailable');
  });
});

describe('parseProcessCreationAnswer output bound', () => {
  it('reads more than 4 KiB as unavailable, even when every line is well formed', () => {
    const many = Array.from({ length: 150 }, (_, index) => 1000 + index);
    const lines = many.map((pid) => `UNODE-PC1:${pid} ${T1}`);
    expect(Buffer.byteLength(answerOf(lines))).toBeGreaterThan(PROCESS_CREATION_MAX_OUTPUT_BYTES);
    expect(parseProcessCreationAnswer(exited(answerOf(lines)), many)).toBe('unavailable');
    const fewer = many.slice(0, 60);
    expect(parseProcessCreationAnswer(exited(answerOf(fewer.map((pid) => `UNODE-PC1:${pid} ${T1}`))), fewer)).toBeInstanceOf(Map);
  });
});

describe('judgeProcessIdentity', () => {
  const answer = new Map([[41, T1]]);
  it('is alive only for the same pid with the same creation time', () => {
    expect(judgeProcessIdentity({ pid: 41, creation: T1 }, answer)).toBe('alive');
  });
  it('is dead for a pid that does not run, or runs with another creation time (a reused number)', () => {
    expect(judgeProcessIdentity({ pid: 42, creation: T1 }, answer)).toBe('dead');
    expect(judgeProcessIdentity({ pid: 41, creation: T2 }, answer)).toBe('dead');
  });
  it('is unknown for a pending identity and for an unavailable answer', () => {
    expect(judgeProcessIdentity({ pid: 41, creation: 'pending' }, answer)).toBe('unknown');
    expect(judgeProcessIdentity({ pid: 42, creation: 'pending' }, answer)).toBe('unknown');
    expect(judgeProcessIdentity({ pid: 41, creation: T1 }, 'unavailable')).toBe('unknown');
    expect(judgeProcessIdentity({ pid: 42, creation: T1 }, 'unavailable')).toBe('unknown');
  });
});
