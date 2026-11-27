import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
import { runCliProbe, runCodexCliProbe } from '../CodexCliProbe';

function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
  });
  mock.spawn.mockReturnValue(proc);
  return proc;
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

/** An absolute host folder on this platform: `C:\host\check` on Windows, `/host/check` elsewhere. */
const HOST = path.resolve('/host/check');

describe('the CLI version check (v0.9.96)', () => {
  it('starts in the host folder it is given, without the named credentials, and without a shell', async () => {
    const proc = child();
    const result = runCliProbe('C:/claude.exe', ['--version'], { ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', KEEP: '1' }, vi.fn(), {
      label: 'Claude CLI', credentialKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], cwd: HOST,
    });
    proc.emit('close', 0, null);
    await result;
    const [command, args, options] = mock.spawn.mock.calls[0];
    expect(command).toBe('C:/claude.exe');
    expect(args).toEqual(['--version']);
    expect(options).toMatchObject({ shell: false, cwd: HOST, env: { KEEP: '1' } });
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(options.env).not.toHaveProperty('anthropic_auth_token');
  });

  it('quotes an npm launcher as one token for cmd.exe, and refuses a path that could be shell syntax', async () => {
    const proc = child();
    const result = runCliProbe('C:/Users/Ada Lovelace/npm/claude.cmd', ['--version'], {}, vi.fn(), { label: 'Claude CLI', credentialKeys: [], shell: true, cwd: HOST });
    proc.emit('close', 0, null);
    await result;
    expect(mock.spawn.mock.calls[0][0]).toBe('"C:/Users/Ada Lovelace/npm/claude.cmd"');
    expect(mock.spawn.mock.calls[0][2]).toMatchObject({ shell: true });
    mock.spawn.mockClear();
    for (const unsafe of ['C:/x/"&calc.cmd', 'C:/x/%PATH%/claude.cmd', 'C:/x/a\nb.cmd']) {
      await expect(runCliProbe(unsafe, ['--version'], {}, vi.fn(), { label: 'Claude CLI', credentialKeys: [], shell: true, cwd: HOST })).rejects.toThrow(/unsafe/);
    }
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('names the program in its timeout', async () => {
    vi.useFakeTimers();
    child();
    const result = runCliProbe('C:/claude.exe', ['--version'], {}, vi.fn(), { label: 'Claude CLI', credentialKeys: [], cwd: HOST });
    const rejected = expect(result).rejects.toThrow('Claude CLI did not finish within 15 seconds.');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });

  it('starts nothing without an absolute host-owned folder, never in the inherited current directory', async () => {
    for (const cwd of [undefined, '', 'relative/check']) {
      await expect(runCliProbe('C:/claude.exe', ['--version'], {}, vi.fn(), { label: 'Claude CLI', credentialKeys: [], cwd } as never))
        .rejects.toThrow('Claude CLI was not started: it has no host-owned folder to start in.');
      await expect(runCodexCliProbe('C:/codex.exe', ['--version'], {}, vi.fn(), cwd as never))
        .rejects.toThrow('Codex CLI was not started: it has no host-owned folder to start in.');
    }
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('starts a Codex check in the host folder too, keeping Codex\'s credential stripping', async () => {
    const proc = child();
    const result = runCodexCliProbe('C:/codex.exe', ['--version'], { OPENAI_API_KEY: 'k' }, vi.fn(), HOST);
    proc.emit('close', 0, null);
    await result;
    expect(mock.spawn.mock.calls[0][2]).toMatchObject({ shell: false, cwd: HOST });
    expect(mock.spawn.mock.calls[0][2].env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('Codex local CLI probes', () => {
  it('waits for close and captures version output arriving after exit', async () => {
    const proc = child();
    const stop = vi.fn();
    const result = runCodexCliProbe('C:/codex.exe', ['--version'], {}, stop, HOST);
    const settled = vi.fn();
    void result.then(settled);
    proc.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    proc.stdout.emit('data', 'codex-cli 0.155.1\n');
    proc.emit('close', 0, null);
    await expect(result).resolves.toEqual({ code: 0, signal: null, output: 'codex-cli 0.155.1' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('preserves stderr, nonzero status and signal for diagnostics', async () => {
    const proc = child();
    const result = runCodexCliProbe('C:/codex.exe', ['--version'], {}, vi.fn(), HOST);
    proc.stderr.emit('data', 'startup failed\n');
    proc.emit('exit', null, 'SIGTERM');
    proc.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toEqual({ code: null, signal: 'SIGTERM', output: 'startup failed' });
  });

  it('bounds combined output and strips API keys without mutating the supplied environment', async () => {
    const proc = child();
    const env = { OpenAI_API_KEY: 'test-openai', codex_api_key: 'test-codex', PATH: 'tools' };
    const result = runCodexCliProbe('C:/codex.exe', ['login', 'status'], env, vi.fn(), HOST);
    expect(mock.spawn).toHaveBeenCalledWith('C:/codex.exe', ['login', 'status'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: 'tools' }, cwd: HOST,
    });
    expect(env.OpenAI_API_KEY).toBe('test-openai');
    proc.stdout.emit('data', 'x'.repeat(70_000));
    proc.stderr.emit('data', 'extra');
    proc.emit('close', 1, null);
    expect((await result).output).toHaveLength(64 * 1024);
    expect((await result).code).toBe(1);
  });

  it.each([false, true])('times out without signaling an already-exited process (exited=%s)', async (exited) => {
    vi.useFakeTimers();
    const proc = child();
    const stop = vi.fn();
    const result = runCodexCliProbe('C:/codex.exe', ['--version'], {}, stop, HOST);
    const rejected = expect(result).rejects.toThrow('within 15 seconds');
    if (exited) proc.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(stop).toHaveBeenCalledTimes(exited ? 0 : 1);
    if (!exited) expect(stop).toHaveBeenCalledWith(proc as unknown as ChildProcess);
    proc.emit('close', 0, null);
  });

  it('rejects spawn errors and clears its timeout', async () => {
    vi.useFakeTimers();
    const proc = child();
    const stop = vi.fn();
    const result = runCodexCliProbe('C:/codex.exe', ['--version'], {}, stop, HOST);
    const rejected = expect(result).rejects.toThrow('ENOENT');
    proc.emit('error', new Error('ENOENT'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stop).not.toHaveBeenCalled();
  });
});
