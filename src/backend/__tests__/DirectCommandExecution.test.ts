import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import { createDirectCommandPreparer, createDirectExecutionProvider, DirectChildRegistry, resolveDeclaredDirectShell } from '../DirectCommandExecution';
import { declaredDirectShellIdentity } from '../CommandShell';
import { TIMEOUT_STOP_UNCONFIRMED_MESSAGE } from '../CommandExecution';
import { HostShutdown, type ProcessTreeTerminationDeps, terminateChildProcessTree } from '../processTree';

describe('resolveDeclaredDirectShell (v0.9.96)', () => {
  it('resolves cmd.exe on Windows through the host resolver, using ComSpec only as a candidate', () => {
    const asked: string[] = [];
    const shell = resolveDeclaredDirectShell({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      resolveExecutable: (program) => { asked.push(program); return 'C:\\Windows\\System32\\cmd.exe'; },
    });
    expect(shell).toEqual({ identity: declaredDirectShellIdentity('win32'), executable: 'C:\\Windows\\System32\\cmd.exe' });
    expect(asked).toEqual(['C:\\Windows\\System32\\cmd.exe']);
  });

  it('never takes a ComSpec that names another program, and refuses when nothing resolves', () => {
    const asked: string[] = [];
    const refused = resolveDeclaredDirectShell({
      platform: 'win32',
      env: { ComSpec: 'C:\\work\\project\\evil.exe' },
      resolveExecutable: (program) => { asked.push(program); throw new Error('not found'); },
    });
    expect(asked).toEqual(['cmd.exe']);
    expect(refused).toEqual({
      ok: false,
      reason: 'shell-compatibility',
      message: 'Command not run: UnodeAi could not find its declared direct shell (cmd.exe) as a host executable.',
    });
  });

  it('uses /bin/sh on macOS and Linux', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveDeclaredDirectShell({ platform, resolveExecutable: (program) => program })).toEqual({
        identity: declaredDirectShellIdentity(platform),
        executable: '/bin/sh',
      });
    }
  });
});

/** A child process the test drives by hand. */
function fakeChild(): ChildProcess & { emitOutput(text: string): void; exit(code: number | null): void } {
  const child = new EventEmitter() as ChildProcess & { emitOutput(text: string): void; exit(code: number | null): void };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { stdout, stderr, pid: 4242 });
  child.emitOutput = (text) => stdout.emit('data', Buffer.from(text));
  child.exit = (code) => child.emit('close', code);
  return child;
}

describe('createDirectCommandPreparer (v0.9.96)', () => {
  const shell = { identity: declaredDirectShellIdentity('linux'), executable: '/bin/sh' };

  it.each(['exit', 'stop'] as const)('hands off the same foreground process on wait expiry and supports %s later', async action => {
    const child = fakeChild(); const spawn = vi.fn(() => child);
    const terminateTree = vi.fn(async () => { child.exit(null); return { status: 'confirmed-stopped' as const }; });
    const prepare = createDirectCommandPreparer({ shell: () => shell, spawn, terminateTree, env: () => ({}), platform: 'linux' });
    const lease = await createDirectExecutionProvider(prepare).acquire({ cwd: '/work/project' });
    if (!lease.ok) throw new Error('refused');
    const result = await lease.execute('npm run build', 10, true);
    expect(result.status).toBe('running'); expect(terminateTree).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledTimes(1);
    await lease.release();
    if (result.status !== 'running') throw new Error('not continued');
    child.emitOutput('later output');
    expect(result.continuation.output()).toContain('later output');
    if (action === 'stop') await expect(result.continuation.stop()).resolves.toMatchObject({ status: 'confirmed-stopped' });
    else child.exit(0);
    const done = await result.continuation.completion;
    expect(done.status).toBe(action === 'exit' ? 'exited' : 'outcome-unknown');
    if (action === 'stop') { expect(done.output).toContain('background command was stopped'); expect(done.output).not.toContain('agent was stopped'); }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('captures a partial final ANSI tail only after finishing the stream', async () => {
    const child = fakeChild();
    const prepared = createDirectCommandPreparer({ shell: () => shell, spawn: () => child, env: () => ({}), platform: 'linux' })();
    if (!prepared.ok) throw new Error('refused');
    const running = prepared.execute('echo tail', { cwd: '/work/project', timeoutMs: 5000 });
    child.emitOutput('prefix\x1b[31'); child.exit(0);
    const done = await running;
    expect(done.output).toBe('prefix\x1b[31');
    expect(done.output).toBe(done.capture?.renderWithin(16000));
  });

  it('spawns with the resolved interpreter as Node\'s shell option, never shell: true, and runs once', async () => {
    const spawned: Array<{ command: string; options: SpawnOptions }> = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const prepare = createDirectCommandPreparer({
      shell: () => shell,
      spawn: (command, options) => { spawned.push({ command, options }); const child = fakeChild(); children.push(child); return child; },
      env: () => ({}),
      platform: 'linux',
    });
    const prepared = prepare();
    if (!prepared.ok) throw new Error('refused');
    expect(prepared.shell).toBe(shell.identity);
    const running = prepared.execute('npm test', { cwd: '/work/project', timeoutMs: 5_000 });
    children[0].emitOutput('ok\n');
    children[0].exit(0);
    expect(await running).toMatchObject({ status: 'exited', code: 0, output: 'ok\n' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].options.shell).toBe('/bin/sh');
    expect(spawned[0].options.shell).not.toBe(true);
    expect(await prepared.execute('npm test', { cwd: '/work/project' })).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(prepared.startBackground('npm test', { cwd: '/work/project' })).toEqual({ ok: false, error: 'this prepared command was already used' });
    expect(spawned).toHaveLength(1);
  });

  it('reports a timeout as stopped only after the tree is confirmed stopped and the child closed', async () => {
    const child = fakeChild();
    const prepare = createDirectCommandPreparer({
      shell: () => shell,
      spawn: () => child,
      env: () => ({}),
      terminateTree: async () => { setTimeout(() => child.exit(null), 5); return { status: 'confirmed-stopped' }; },
      platform: 'linux',
    });
    const prepared = prepare();
    if (!prepared.ok) throw new Error('refused');
    expect(await prepared.execute('npm run watch', { cwd: '/work/project', timeoutMs: 20 })).toMatchObject({ status: 'timed-out', stopConfirmed: true });
  });

  it('a promoted command never claims killed when tree cleanup reports success but output has not closed', async () => {
    const child = fakeChild();
    const prepare = createDirectCommandPreparer({ shell: () => shell, spawn: () => child, env: () => ({}),
      terminateTree: async () => ({ status: 'confirmed-stopped' }), confirmTimeoutMs: 5 });
    const prepared = prepare(); if (!prepared.ok) throw new Error('refused');
    const result = await prepared.execute('build', { cwd: '/work', timeoutMs: 5, continueOnTimeout: true });
    if (result.status !== 'running') throw new Error('not continued');
    await expect(result.continuation.stop()).resolves.toMatchObject({ status: 'unknown' });
    await expect(result.continuation.completion).resolves.toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed' });
    child.exit(null);
  });

  it('never calls an unconfirmed stop a timeout: the outcome is unknown and says why', async () => {
    const child = fakeChild();
    const prepare = createDirectCommandPreparer({
      shell: () => shell,
      spawn: () => child,
      env: () => ({}),
      terminateTree: async () => ({ status: 'unknown', detail: 'process 9 was still running' }),
      confirmTimeoutMs: 20,
      platform: 'linux',
    });
    const prepared = prepare();
    if (!prepared.ok) throw new Error('refused');
    const result = await prepared.execute('node hang.js', { cwd: '/work/project', timeoutMs: 20 });
    expect(result).toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed' });
    expect(result.note).toBe(TIMEOUT_STOP_UNCONFIRMED_MESSAGE);
    // v0.9.99 (A5): the note no longer says that the agent's later commands are refused.
    expect(result.note).not.toMatch(/no later command will start/);
  });

  it('a spawn error before the process existed means nothing ran', async () => {
    const child = fakeChild();
    const prepare = createDirectCommandPreparer({ shell: () => shell, spawn: () => child, env: () => ({}), platform: 'linux' });
    const prepared = prepare();
    if (!prepared.ok) throw new Error('refused');
    const running = prepared.execute('npm test', { cwd: '/work/project' });
    child.emit('error', new Error('spawn /bin/sh ENOENT'));
    expect(await running).toEqual({ status: 'not-started', code: null, reason: 'spawn-failed', output: 'Failed to start the command: spawn /bin/sh ENOENT' });
  });

  it('a real command runs through the declared shell of this host', async () => {
    const prepare = createDirectCommandPreparer();
    const prepared = prepare();
    if (!prepared.ok) throw new Error(prepared.message);
    const result = await prepared.execute(`"${process.execPath}" -e "console.log('direct')"`, { cwd: process.cwd(), timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: 'exited', code: 0 });
    expect(result.output.trim()).toBe('direct');
  }, 30_000);
});

describe('the host\'s direct children at shutdown (v0.9.96)', () => {
  const shell = { identity: declaredDirectShellIdentity('linux'), executable: '/bin/sh' };

  it('keeps every child it starts until it closes, and stops all at once at shutdown, waiting for each stop', async () => {
    const registry = new DirectChildRegistry();
    const children: ReturnType<typeof fakeChild>[] = [];
    const prepare = createDirectCommandPreparer({
      shell: () => shell,
      spawn: () => { const child = fakeChild(); children.push(child); return child; },
      env: () => ({}),
      platform: 'linux',
      children: registry,
    });
    const foreground = prepare();
    const background = prepare();
    const finished = prepare();
    if (!foreground.ok || !background.ok || !finished.ok) throw new Error('refused');
    void foreground.execute('npm test', { cwd: '/work', timeoutMs: 60_000 });
    expect(background.startBackground('npm run dev', { cwd: '/work' })).toMatchObject({ ok: true });
    const done = finished.execute('echo done', { cwd: '/work', timeoutMs: 60_000 });
    children[2].exit(0);
    await done;
    // The closed one is forgotten; the foreground and background commands still run.
    expect(registry.size).toBe(2);

    const stops: Array<{ proc: ChildProcess; end: () => void }> = [];
    const stopping = registry.stopAll((proc) => new Promise<void>((end) => { stops.push({ proc, end }); }));
    expect(stops.map(({ proc }) => proc)).toEqual([children[0], children[1]]);
    let all = false;
    void stopping.then(() => { all = true; });
    stops[0].end();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(all).toBe(false);
    stops[1].end();
    await stopping;
    for (const child of children) child.exit(null);
    expect(registry.size).toBe(0);
  });

  it('forgets a child that failed to start, and a stop that fails does not stop the others', async () => {
    const registry = new DirectChildRegistry();
    const broken = fakeChild();
    Object.assign(broken, { pid: undefined });
    const prepare = createDirectCommandPreparer({ shell: () => shell, spawn: () => broken, env: () => ({}), platform: 'linux', children: registry });
    const prepared = prepare();
    if (!prepared.ok) throw new Error('refused');
    const run = prepared.execute('missing-program', { cwd: '/work' });
    broken.emit('error', new Error('spawn ENOENT'));
    expect(await run).toMatchObject({ status: 'not-started', reason: 'spawn-failed' });
    expect(registry.size).toBe(0);

    const a = registry.start(() => fakeChild());
    const b = registry.start(() => fakeChild());
    const stopped: ChildProcess[] = [];
    await registry.stopAll(async (proc) => { stopped.push(proc); if (proc === a) throw new Error('taskkill could not run'); });
    expect(stopped).toEqual([a, b]);
  });

  const SHUTTING_DOWN = { ok: false, reason: 'disposed', message: 'Command not run: the window is closing or reloading.' };

  it('starts nothing once the host has begun to shut down, also a command prepared before that', async () => {
    const shutdown = new HostShutdown();
    const registry = new DirectChildRegistry(shutdown);
    let spawns = 0;
    const prepare = createDirectCommandPreparer({
      shell: () => shell, spawn: () => { spawns += 1; return fakeChild(); }, env: () => ({}), platform: 'linux', children: registry,
    });
    const foreground = prepare();
    const background = prepare();
    if (!foreground.ok || !background.ok) throw new Error('refused');
    shutdown.begin();
    await registry.stopAll(async () => undefined);

    expect(await foreground.execute('npm test', { cwd: '/work', timeoutMs: 60_000 })).toEqual({
      status: 'not-started', code: null, reason: 'disposed', output: SHUTTING_DOWN.message,
    });
    expect(background.startBackground('npm run dev', { cwd: '/work' })).toEqual({ ok: false, error: SHUTTING_DOWN.message, notStarted: SHUTTING_DOWN });
    const later = prepare();
    if (!later.ok) throw new Error('refused');
    expect(await later.execute('npm test', { cwd: '/work' })).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(spawns).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('does not start a command whose approval was still waiting when the window began to close', async () => {
    const shutdown = new HostShutdown();
    const registry = new DirectChildRegistry(shutdown);
    let spawns = 0;
    const provider = createDirectExecutionProvider(createDirectCommandPreparer({
      shell: () => shell, spawn: () => { spawns += 1; return fakeChild(); }, env: () => ({}), platform: 'linux', children: registry,
    }));
    const lease = await provider.acquire({ cwd: '/work' });
    if (!lease.ok) throw new Error('refused');
    // The sweep runs and finds nothing; then the approval comes back.
    shutdown.begin();
    await registry.stopAll(async () => undefined);
    expect(await lease.execute('npm test', 60_000)).toMatchObject({ status: 'not-started', reason: 'disposed', output: SHUTTING_DOWN.message });
    await lease.release();
    expect(spawns).toBe(0);
  });

  it('also stops a child that is kept after the sweep began', async () => {
    const registry = new DirectChildRegistry(new HostShutdown());
    const first = registry.start(() => fakeChild());
    let late: ChildProcess | undefined;
    const stopped: Array<ChildProcess | undefined> = [];
    await registry.stopAll(async (proc) => {
      stopped.push(proc);
      late ??= registry.start(() => fakeChild());
    });
    expect(late).toBeDefined();
    expect(stopped).toEqual([first, late]);
  });

  describe('with the production tree stop', () => {
    /** A child Node started, with the state Node keeps of its end. */
    const nodeChild = (pid: number) => Object.assign(fakeChild(), { pid, exitCode: null, signalCode: null });
    const windows = (taskkills: number[], options: { alive: () => boolean; taskkill?: () => Promise<number | undefined> }): ProcessTreeTerminationDeps => ({
      platform: 'win32',
      shutdown: new HostShutdown(),
      kill: () => { if (!options.alive()) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
      listProcesses: async () => [],
      taskkill: (pid) => { taskkills.push(pid); return options.taskkill?.() ?? Promise.resolve(0); },
      sleep: async () => undefined,
      confirmTimeoutMs: 0,
    });

    it('sends nothing to a child that has ended but not closed, although its number is in use again', async () => {
      const registry = new DirectChildRegistry(new HostShutdown());
      const child = registry.start(() => nodeChild(41001))!;
      // A process it started still holds its output open, so Node reports the exit and no close.
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
      const taskkills: number[] = [];
      // The number now belongs to an unrelated process, which is alive.
      await registry.stopAll((proc) => terminateChildProcessTree(proc, windows(taskkills, { alive: () => true })));
      expect(taskkills).toEqual([]);
      expect(registry.size).toBe(1);
    });

    it('joins the stop its owner has under way instead of sending a second one', async () => {
      const registry = new DirectChildRegistry(new HostShutdown());
      const child = registry.start(() => nodeChild(41002))!;
      const taskkills: number[] = [];
      const releases: Array<() => void> = [];
      let alive = true;
      const deps = windows(taskkills, {
        alive: () => alive,
        taskkill: () => new Promise((resolve) => { releases.push(() => { alive = false; resolve(0); }); }),
      });
      const owner = terminateChildProcessTree(child, deps);
      const sweep = registry.stopAll((proc) => terminateChildProcessTree(proc, deps));
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const release of releases) release();
      await sweep;
      expect(await owner).toEqual({ status: 'confirmed-stopped' });
      expect(taskkills).toEqual([41002]);
    });
  });
});

describe('createDirectExecutionProvider (v0.9.96)', () => {
  // v0.9.99 (A5): an unconfirmed stop is reported in that command's own result and no longer refuses the agent's later
  // commands. The old command is never run again; a second, unrelated command runs in its own process.
  it('serializes, keeps the unconfirmed stop in its own result and runs a second unrelated command', async () => {
    const ran: string[] = [];
    const provider = createDirectExecutionProvider(() => ({
      ok: true,
      shell: declaredDirectShellIdentity('linux'),
      execute: async (command) => {
        ran.push(command);
        return ran.length === 1
          ? { status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', output: 'stopped?' }
          : { status: 'exited', code: 0, output: 'ok' };
      },
      startBackground: (command) => { ran.push(`bg ${command}`); return { ok: false, error: 'fake' }; },
    }));
    const first = await provider.acquire({ cwd: '/work' });
    if (!first.ok) throw new Error('refused');
    expect(await first.execute('hang', 10)).toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed' });
    await first.release();
    const second = await provider.acquire({ cwd: '/work' });
    if (!second.ok) throw new Error(`refused: ${second.message}`);
    expect(await second.execute('npm test', 10)).toMatchObject({ status: 'exited', code: 0 });
    await second.release();
    // A background command starts beside the lane too.
    const background = provider.prepareDirect?.();
    if (!background?.ok) throw new Error('background refused');
    background.startBackground('npm run dev', { cwd: '/work' });
    // Each command ran once; the uncertain one was never replayed.
    expect(ran).toEqual(['hang', 'npm test', 'bg npm run dev']);
  });

  it('checks the caller\'s start condition when the approved command would start, and consumes the lease', async () => {
    const ran: string[] = [];
    const provider = createDirectExecutionProvider(() => ({
      ok: true,
      shell: declaredDirectShellIdentity('linux'),
      execute: async (command) => { ran.push(command); return { status: 'exited', code: 0, output: '' }; },
      startBackground: () => ({ ok: false, error: 'fake' }),
    }));
    let trusted = true;
    const lease = await provider.acquire({ cwd: '/work', startRefusal: () => (trusted ? undefined : { ok: false, reason: 'shell-compatibility', message: 'untrusted' }) });
    if (!lease.ok) throw new Error('refused');
    trusted = false;
    expect(await lease.execute('npm test', 10)).toEqual({ status: 'not-started', code: null, reason: 'environment-changed', output: 'untrusted' });
    trusted = true;
    expect(await lease.execute('npm test', 10)).toMatchObject({ status: 'not-started', reason: 'disposed' });
    await lease.release();
    expect(ran).toEqual([]);
  });

  it('starts a background command prepared before an earlier command\'s stop went unconfirmed', async () => {
    let call = 0;
    const started: string[] = [];
    const provider = createDirectExecutionProvider(() => ({
      ok: true,
      shell: declaredDirectShellIdentity('linux'),
      execute: async () => {
        call += 1;
        return { status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', output: 'stopped?' };
      },
      startBackground: (command) => { started.push(command); return { ok: false, error: 'fake' }; },
    }));
    // Prepared, then waiting for its approval while a foreground command runs and its stop is unconfirmed.
    const background = provider.prepareDirect!();
    if (!background.ok) throw new Error('refused');
    const foreground = await provider.acquire({ cwd: '/work' });
    if (!foreground.ok) throw new Error('refused');
    await foreground.execute('hang', 10);
    await foreground.release();
    expect(call).toBe(1);
    background.startBackground('npm run dev', { cwd: '/work' });
    expect(started).toEqual(['npm run dev']);
  });
});

// v0.9.99 (A5, CF-4 item 5), on a fake clock: a command whose stop is not confirmed leaves the agent able to run a
// second, unrelated command, which is handed to the background on its wait expiry without being started again.
describe('an uncertain earlier process does not lock the agent (v0.9.99)', () => {
  const shell = { identity: declaredDirectShellIdentity('linux'), executable: '/bin/sh' };

  it('runs a second command after an unconfirmed stop, and promotes it to the background with one spawn', async () => {
    vi.useFakeTimers();
    try {
      const children: Array<ReturnType<typeof fakeChild>> = [];
      const spawn = vi.fn(() => { const child = fakeChild(); children.push(child); return child; });
      // The first tree is never seen to stop; the stop of any later one is confirmed.
      const terminateTree = vi.fn(async (proc: ChildProcess) => (proc === children[0]
        ? { status: 'unknown' as const, detail: 'process 4242 was still running' }
        : (children[1].exit(null), { status: 'confirmed-stopped' as const })));
      const provider = createDirectExecutionProvider(createDirectCommandPreparer({
        shell: () => shell, spawn, terminateTree, env: () => ({}), platform: 'linux', confirmTimeoutMs: 1_000,
      }));

      const first = await provider.acquire({ cwd: '/work' });
      if (!first.ok) throw new Error('refused');
      const hung = first.execute('node hang.js', 120_000);
      await vi.advanceTimersByTimeAsync(121_001);
      expect(await hung).toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed', note: TIMEOUT_STOP_UNCONFIRMED_MESSAGE });
      await first.release();

      const second = await provider.acquire({ cwd: '/work' });
      if (!second.ok) throw new Error(`refused: ${second.message}`);
      const build = second.execute('npm run build', 120_000, true);
      await vi.advanceTimersByTimeAsync(120_001);
      const promoted = await build;
      expect(promoted.status).toBe('running');
      // The same process continues in the background: nothing was spawned again, and the uncertain one was not replayed.
      expect(spawn).toHaveBeenCalledTimes(2);
      children[1].emitOutput('built\n');
      children[1].exit(0);
      if (promoted.status !== 'running') throw new Error('not promoted');
      await expect(promoted.continuation.completion).resolves.toMatchObject({ status: 'exited', code: 0 });
      expect(spawn).toHaveBeenCalledTimes(2);
      await second.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
