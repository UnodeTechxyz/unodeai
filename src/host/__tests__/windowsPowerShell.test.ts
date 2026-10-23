import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostExecutableResolutionOptions } from '../../security/HostExecutableResolver';
import {
  encodePowerShellScript,
  runWindowsPowerShell,
  WINDOWS_POWERSHELL_ARGS,
  WINDOWS_POWERSHELL_STDERR_LIMIT,
  type WindowsPowerShellDeps,
  type WindowsPowerShellRequest,
} from '../windowsPowerShell';

/*
 * The runner of the publisher-signature check (and, later, the process-list query): the system's own powershell.exe
 * from SystemRoot, fixed arguments, input only through one variable, an exact environment allowlist, a bounded run.
 * Every test injects spawn, the resolver, the timers and the platform, so none depends on the machine being Windows.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
}

interface Spawned { command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }

function harness(overrides: Partial<WindowsPowerShellDeps> = {}) {
  const spawned: Spawned[] = [];
  const resolved: Array<{ command: string; options: HostExecutableResolutionOptions }> = [];
  const killed: ChildProcess[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const deps: WindowsPowerShellDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child as unknown as ChildProcess;
    },
    resolveExecutable: (command, options) => {
      resolved.push({ command, options });
      return command;
    },
    killTree: (proc) => { killed.push(proc); },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) (timer as { cleared: boolean }).cleared = true; },
    ...overrides,
  };
  return { deps, spawned, resolved, killed, timers };
}

const SCRIPT = encodePowerShellScript("'hello'");
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

function request(overrides: Partial<WindowsPowerShellRequest> = {}): WindowsPowerShellRequest {
  return {
    encodedCommand: SCRIPT,
    inputVariable: 'UNODE_AC_INPUT',
    input: base64(JSON.stringify({ v: 1, files: ['C:\\pkg\\bin\\codex.exe'] })),
    maxInputChars: 24 * 1024,
    cwd: 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\work\\t1',
    tmp: 'C:\\Users\\me\\AppData\\Local\\UnodeAi\\work\\t1\\tmp',
    timeoutMs: 90_000,
    maxStdoutBytes: 256 * 1024,
    workspaceRoots: ['C:\\repo'],
    worktreeRoots: ['C:\\repo-worktrees\\a'],
    ...overrides,
  };
}

/** Let the promise's own callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => { vi.unstubAllEnvs(); });

describe('runWindowsPowerShell: what is started', () => {
  it('starts SystemRoot\'s powershell.exe, resolved outside the workspace and worktree roots, with exactly the fixed arguments', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    expect(h.resolved).toEqual([{
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      options: { platform: 'win32', env: {}, workspaceRoots: ['C:\\repo'], worktreeRoots: ['C:\\repo-worktrees\\a'] },
    }]);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(h.spawned[0].args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', SCRIPT]);
    expect(WINDOWS_POWERSHELL_ARGS).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand']);
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('runs in the caller\'s owned folder with stdin ignored, both outputs piped and no shell', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    const { options } = h.spawned[0];
    expect(options.cwd).toBe('C:\\Users\\me\\AppData\\Local\\UnodeAi\\work\\t1');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.shell).toBe(false);
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('passes exactly the allowlist: SystemRoot, WINDIR, TEMP/TMP = the owned tmp, the system PSModulePath and the input', async () => {
    const h = harness({
      env: {
        SystemRoot: 'C:\\Windows',
        WINDIR: 'D:\\Elsewhere',
        PSModulePath: 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules;C:\\repo\\modules',
        PATH: 'C:\\repo\\bin;C:\\Windows\\System32',
        NODE_OPTIONS: '--require C:\\repo\\x.js',
        HTTPS_PROXY: 'http://proxy',
        TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
        UNODE_AC_INPUT: 'from-the-parent',
      },
    });
    const req = request();
    const running = runWindowsPowerShell(req, h.deps);
    expect(h.spawned[0].options.env).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: req.tmp,
      TMP: req.tmp,
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      UNODE_AC_INPUT: req.input,
    });
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('never inherits the host\'s own environment', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('PSModulePath', 'C:\\shadow\\Modules');
    vi.stubEnv('UNODE_LEAK_PROBE', 'leaked');
    const h = harness({ env: undefined });
    const running = runWindowsPowerShell(request(), h.deps);
    const env = h.spawned[0].options.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['PSModulePath', 'SystemRoot', 'TEMP', 'TMP', 'UNODE_AC_INPUT', 'WINDIR']);
    expect(env.PSModulePath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    expect(env.UNODE_LEAK_PROBE).toBeUndefined();
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('carries a non-ASCII path through the base64 input unchanged', async () => {
    const paths = ['C:\\Users\\张三\\AppData\\Local\\UnodeAi\\cli-store\\ü\\codex.exe', 'C:\\Users\\Zoë\\naïve — dash\\rg.exe'];
    const h = harness();
    const running = runWindowsPowerShell(request({ input: base64(JSON.stringify({ v: 1, files: paths })) }), h.deps);
    const env = h.spawned[0].options.env as Record<string, string>;
    expect(env.UNODE_AC_INPUT).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(Buffer.from(env.UNODE_AC_INPUT, 'base64').toString('utf8')).files).toEqual(paths);
    expect(h.spawned[0].args.join(' ')).not.toContain('codex.exe');
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('encodes the script as base64 of its UTF-16LE bytes', () => {
    const encoded = encodePowerShellScript("Write-Output 'ü'");
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe("Write-Output 'ü'");
  });
});

describe('runWindowsPowerShell: PowerShell that cannot be used is unavailable, and nothing starts', () => {
  it.each([
    ['missing', {}],
    ['a UNC path', { SystemRoot: '\\\\server\\share' }],
    ['a folder below another folder', { SystemRoot: 'C:\\Windows\\System32' }],
    ['a relative path', { SystemRoot: 'Windows' }],
    ['forward slashes', { SystemRoot: 'C:/Windows' }],
    ['a wildcard', { SystemRoot: 'C:\\Win*' }],
    ['a trailing separator', { SystemRoot: 'C:\\Windows\\' }],
    ['two spellings with different values', { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' }],
  ])('SystemRoot %s', async (_label, env) => {
    const h = harness({ env });
    const result = await runWindowsPowerShell(request(), h.deps);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not-found' });
    expect(h.resolved).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
  });

  it('reads SystemRoot without regard to case, as Windows does', async () => {
    const h = harness({ env: { SYSTEMROOT: 'C:\\WINDOWS' } });
    const running = runWindowsPowerShell(request(), h.deps);
    expect(h.spawned[0].command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    h.spawned[0].child.emit('close', 0, null);
    await running;
  });

  it('is not-found on any platform other than Windows', async () => {
    const h = harness({ platform: 'linux' });
    expect(await runWindowsPowerShell(request(), h.deps)).toMatchObject({ status: 'unavailable', reason: 'not-found' });
    expect(h.resolved).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
  });

  it('is not-found when the resolver finds no executable or refuses one inside a workspace', async () => {
    const h = harness({ resolveExecutable: () => { throw new Error('Host executable was not found at "C:\\Windows\\...".'); } });
    const result = await runWindowsPowerShell(request(), h.deps);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not-found' });
    expect(h.spawned).toHaveLength(0);
  });

  it('is not-found when Windows reports the program missing at spawn, and spawn-failed for any other spawn error', async () => {
    const missing = harness();
    const first = runWindowsPowerShell(request(), missing.deps);
    missing.spawned[0].child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(await first).toMatchObject({ status: 'unavailable', reason: 'not-found' });
    const denied = harness();
    const second = runWindowsPowerShell(request(), denied.deps);
    denied.spawned[0].child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(await second).toMatchObject({ status: 'unavailable', reason: 'spawn-failed' });
    const throwing = harness({ spawn: () => { throw new Error('bad options'); } });
    expect(await runWindowsPowerShell(request(), throwing.deps)).toMatchObject({ status: 'unavailable', reason: 'spawn-failed' });
  });
});

describe('runWindowsPowerShell: bounds', () => {
  it('kills the process tree at the time limit and reports a timeout; a later exit changes nothing', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(90_000);
    h.timers[0].callback();
    const result = await running;
    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(h.killed).toEqual([h.spawned[0].child]);
    h.spawned[0].child.emit('close', 0, null);
    await settle();
    expect(h.killed).toHaveLength(1);
  });

  it('does not signal a root that has already exited (its number may be reused) but still reports the timeout', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    h.spawned[0].child.emit('exit', 0, null);
    h.timers[0].callback();
    expect(await running).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(h.killed).toHaveLength(0);
  });

  it('accepts stdout up to the cap and stops the tree one byte over it', async () => {
    const atCap = harness();
    const first = runWindowsPowerShell(request(), atCap.deps);
    atCap.spawned[0].child.stdout.emit('data', Buffer.alloc(256 * 1024 - 1, 0x41));
    atCap.spawned[0].child.stdout.emit('data', Buffer.from('B'));
    atCap.spawned[0].child.emit('close', 0, null);
    const ok = await first;
    expect(ok.status).toBe('exited');
    expect(ok.status === 'exited' && ok.stdout.length).toBe(256 * 1024);

    const over = harness();
    const second = runWindowsPowerShell(request(), over.deps);
    over.spawned[0].child.stdout.emit('data', Buffer.alloc(256 * 1024, 0x41));
    over.spawned[0].child.stdout.emit('data', Buffer.from('B'));
    expect(await second).toMatchObject({ status: 'unavailable', reason: 'output-limit' });
    expect(over.killed).toEqual([over.spawned[0].child]);
    expect(over.timers[0].cleared).toBe(true);
  });

  it('keeps only the first 2 KiB of stderr, as a diagnostic', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    h.spawned[0].child.stderr.emit('data', Buffer.alloc(1500, 0x61));
    h.spawned[0].child.stderr.emit('data', Buffer.alloc(1500, 0x62));
    h.spawned[0].child.stdout.emit('data', Buffer.from('UNODE-AC1:ERR\r\n'));
    h.spawned[0].child.emit('close', 4, null);
    const result = await running;
    expect(result).toMatchObject({ status: 'exited', code: 4, stdout: 'UNODE-AC1:ERR\r\n' });
    expect(result.stderr).toHaveLength(WINDOWS_POWERSHELL_STDERR_LIMIT);
    expect(result.stderr).toBe('a'.repeat(1500) + 'b'.repeat(548));
  });

  it('reports what PowerShell printed and its exit code once its output has closed', async () => {
    const h = harness();
    const running = runWindowsPowerShell(request(), h.deps);
    h.spawned[0].child.stdout.emit('data', Buffer.from('UNODE-AC1:'));
    h.spawned[0].child.stdout.emit('data', Buffer.from('e30=\r\n'));
    h.spawned[0].child.emit('exit', 0, null);
    h.spawned[0].child.emit('close', 0, null);
    expect(await running).toEqual({ status: 'exited', code: 0, signal: null, stdout: 'UNODE-AC1:e30=\r\n', stderr: '' });
    expect(h.timers[0].cleared).toBe(true);
  });
});

describe('runWindowsPowerShell: a request built wrongly starts nothing', () => {
  it.each([
    ['an input over the caller\'s limit', { input: 'A'.repeat(24 * 1024 + 4), maxInputChars: 24 * 1024 }],
    ['an input that is not base64', { input: 'C:\\pkg\\codex.exe' }],
    ['an input variable named like a fixed variable', { inputVariable: 'PSMODULEPATH' }],
    ['an input variable that is TEMP', { inputVariable: 'TEMP' }],
    ['a lower-case input variable', { inputVariable: 'unode_ac_input' }],
    ['a script that is not encoded', { encodedCommand: "Get-ChildItem 'C:\\'" }],
    ['a relative working folder', { cwd: 'work\\t1' }],
    ['a relative temporary folder', { tmp: 'tmp' }],
    ['no time limit', { timeoutMs: 0 }],
    ['no output limit', { maxStdoutBytes: 0 }],
  ])('%s', (_label, overrides) => {
    const h = harness();
    expect(() => runWindowsPowerShell(request(overrides as Partial<WindowsPowerShellRequest>), h.deps)).toThrow(TypeError);
    expect(h.spawned).toHaveLength(0);
  });
});
