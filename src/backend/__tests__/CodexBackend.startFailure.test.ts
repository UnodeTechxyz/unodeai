import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend, type CodexProgramFailure, type CodexProgramLaunch, type CodexProgramStart } from '../CodexBackend';

// v0.9.97 (Codex's audit of 87092b9, F3): a start of a managed Codex version that fails at the program's own level is
// reported once, after the failed process was stopped, so that the host can check that version once more. A failure
// of the environment, and a start the person cancelled, report nothing. Nothing is started again.

function config(): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Reviewer', role: 'reviewer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Review the project.', autoApprove: true, allowedTools: ['read', 'search', 'write', 'execute'], backend: 'codex',
    workingDirectory: process.cwd(),
  };
}

const access = () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [process.cwd()] });

type Mode = 'spawn-error' | 'silent' | 'initialize-error' | 'exit' | 'config-error';

/** An App Server that fails its start in one way. */
function failingAppServer(mode: Mode) {
  const procs: any[] = [];
  const spawn = () => {
    const proc = new EventEmitter() as any;
    procs.push(proc);
    const reply = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
    proc.pid = 5150;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            if (mode === 'spawn-error') queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn codex.exe ENOENT'), { code: 'ENOENT' })));
            else if (mode === 'initialize-error') reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request' } });
            else if (mode === 'exit') queueMicrotask(() => { proc.exitCode = 1; proc.emit('exit', 1); });
            else if (mode === 'config-error') reply({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake' } });
          } else if (message.method === 'config/read') {
            reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'config.toml: invalid key' } });
          }
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => true;
    return proc;
  };
  return { spawn: spawn as any, procs };
}

/** A managed launcher: one start, whose failures are recorded in order with the process stop. */
function managedProgram(order: string[], failures: CodexProgramFailure[]) {
  return async (start: CodexProgramStart): Promise<CodexProgramLaunch> => {
    await start.beforeStart('C:/store/versions/k/bin/codex.exe');
    await start.preflight('C:/store/versions/k/bin/codex.exe');
    const child = start.spawn('C:/store/versions/k/bin/codex.exe', { managed: true });
    return {
      child,
      executable: 'C:/store/versions/k/bin/codex.exe',
      identityKey: 'managed|k',
      release: () => order.push('released'),
      startFailed: (failure) => { order.push('reported'); failures.push(failure); },
    };
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('a failed managed start is reported once for the check of its version (v0.9.97)', () => {
  it.each([
    ['spawn-error', 'spawn-error', /ENOENT/],
    ['initialize-error', 'malformed-json-rpc', /Invalid request/],
    ['exit', 'exit-before-ready', /exited with code 1/],
  ] as const)('a start whose App Server %s reports %s after the stop, and nothing starts again', async (mode, kind, detail) => {
    const fake = failingAppServer(mode);
    const order: string[] = [];
    const failures: CodexProgramFailure[] = [];
    const backend = new CodexBackend(config(), undefined, {
      launchProgram: managedProgram(order, failures), spawn: fake.spawn, access,
      terminateProcessTree: async () => { order.push('stopped'); return { status: 'confirmed-stopped' }; },
    });
    await expect(backend.start({}, { pin: 'take' })).rejects.toThrow();
    expect(failures).toEqual([{ kind, detail: expect.stringMatching(detail) }]);
    // Reported after the stop. An App Server that exited by itself is no proof about what it started, so its start
    // keeps what it holds.
    expect(order).toEqual(mode === 'exit' ? ['reported'] : ['stopped', 'released', 'reported']);
    expect(fake.procs).toHaveLength(1);
  });

  // v0.9.99: a slow answer to initialize is not a failure. The start keeps waiting, the agent's row says how long it has
  // waited, and Stop cancels it; a start the person stopped reports nothing.
  // v0.9.99 (the Owner's decision): no deadline, but by 30 s without an answer the version is reported as bad once, and
  // the person is told to update the Codex CLI in the provider settings. The start keeps waiting until Stop.
  it('a start whose App Server has not answered initialize keeps waiting with progress until Stop, and reports the version once at 30 s', async () => {
    vi.useFakeTimers();
    const fake = failingAppServer('silent');
    const failures: CodexProgramFailure[] = [];
    const unanswered: number[] = [];
    const backend = new CodexBackend(config(), undefined, {
      launchProgram: managedProgram([], failures), spawn: fake.spawn, access,
      terminateProcessTree: async () => ({ status: 'confirmed-stopped' }),
      onStartUnanswered: (seconds) => { unanswered.push(seconds); },
    });
    const waits: string[] = [];
    const notices: string[] = [];
    backend.onEvent((event) => {
      if (event.kind === 'start_pending') waits.push(event.message);
      if (event.kind === 'runtime_notice') notices.push(event.text);
    });
    let outcome: string | undefined;
    void backend.start({}, { pin: 'take' }).then(() => { outcome = 'started'; }, (error: Error) => { outcome = error.message; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(failures).toEqual([]);
    expect(unanswered).toEqual([]);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(outcome).toBeUndefined();
    expect(waits.slice(0, 3)).toEqual([
      'Codex is still starting (10 s). Press Stop to cancel.',
      'Codex is still starting (20 s). Press Stop to cancel.',
      'Codex is still starting (30 s). Press Stop to cancel.',
    ]);
    expect(waits.at(-1)).toBe('Codex is still starting (120 s). Press Stop to cancel.');
    expect(failures).toEqual([{ kind: 'no-initialize-response', detail: 'no answer to initialize after 30 s' }]);
    expect(unanswered).toEqual([30]);
    expect(notices).toEqual(['Codex has not answered for 30 s, so this Codex CLI version looks bad, and UnodeAi has reported it. '
      + 'Update the Codex CLI: open Settings → Providers → Codex CLI → Check / choose CLI…. This start keeps waiting; press Stop to cancel.']);

    await backend.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatch(/stopped|cancelled/i);
    expect(failures).toHaveLength(1);
    // The progress ends with the start.
    const shown = waits.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waits).toHaveLength(shown);
    expect(fake.procs).toHaveLength(1);
  });

  it('a slow initialize that then answers with an error fails the start, reported once (at 30 s, as unanswered)', async () => {
    vi.useFakeTimers();
    const fake = failingAppServer('silent');
    const failures: CodexProgramFailure[] = [];
    const backend = new CodexBackend(config(), undefined, {
      launchProgram: managedProgram([], failures), spawn: fake.spawn, access,
      terminateProcessTree: async () => ({ status: 'confirmed-stopped' }),
    });
    let outcome: string | undefined;
    void backend.start({}, { pin: 'take' }).then(() => { outcome = 'started'; }, (error: Error) => { outcome = error.message; });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(outcome).toBeUndefined();
    fake.procs[0].stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request' } })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatch(/Invalid request/);
    expect(failures).toEqual([{ kind: 'no-initialize-response', detail: 'no answer to initialize after 30 s' }]);
  });

  it('reports nothing for a failure after initialize answered, such as the person\'s configuration', async () => {
    const fake = failingAppServer('config-error');
    const failures: CodexProgramFailure[] = [];
    const backend = new CodexBackend(config(), undefined, {
      launchProgram: managedProgram([], failures), spawn: fake.spawn, access,
      terminateProcessTree: async () => ({ status: 'confirmed-stopped' }),
    });
    await expect(backend.start({}, { pin: 'take' })).rejects.toThrow();
    expect(failures).toEqual([]);
  });

  it('reports nothing for a start the person stopped', async () => {
    const fake = failingAppServer('silent');
    const failures: CodexProgramFailure[] = [];
    const backend = new CodexBackend(config(), undefined, {
      launchProgram: managedProgram([], failures), spawn: fake.spawn, access,
      terminateProcessTree: async () => ({ status: 'confirmed-stopped' }),
    });
    const started = backend.start({}, { pin: 'take' }).then(() => 'started', () => 'failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backend.stop();
    expect(await started).toBe('failed');
    expect(failures).toEqual([]);
  });
});
