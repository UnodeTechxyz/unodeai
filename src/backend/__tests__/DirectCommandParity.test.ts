import { EventEmitter } from 'events';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import type { CommandExecutionProvider, CommandShellIdentity } from '../CommandExecution';
import type { PreparedDirectCommand } from '../CommandExecution';
import { MessageBus } from '../../bus/MessageBus';
import { HostShutdown, terminateChildProcessTree } from '../processTree';
import { TeamTools } from '../TeamTools';
import { WorkspaceTools } from '../WorkspaceTools';
import { CMD_SHELL, directPreparer } from './shellFixtures';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-direct-parity-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 5151, kill: () => true });
  return child;
}

/** A tree stop that gives these outcomes in turn. A confirmed one closes the child's output, as a stopped tree does. */
function treeStops(outcomes: Array<Record<string, unknown>>, seen?: (proc: ChildProcess) => void) {
  return async (proc: ChildProcess) => {
    seen?.(proc);
    const outcome = outcomes.shift();
    if (outcome?.status === 'confirmed-stopped') proc.emit('close', null);
    return outcome;
  };
}

/** A provider whose direct shell records what was started in the background, under which identity. */
function backgroundProvider(shell: CommandShellIdentity = CMD_SHELL) {
  const started: Array<{ command: string; shell: CommandShellIdentity }> = [];
  const children: ChildProcess[] = [];
  const provider: CommandExecutionProvider = {
    async acquire() { throw new Error('a background command takes no foreground lane'); },
    prepareDirect: () => {
      const prepared: PreparedDirectCommand = {
        ok: true,
        shell,
        execute: async () => { throw new Error('not a foreground command'); },
        startBackground: (command) => {
          started.push({ command, shell });
          const child = fakeChild();
          children.push(child);
          return { ok: true, process: child };
        },
      };
      return prepared;
    },
  };
  return { provider, started, children };
}

function toolsWith(provider: CommandExecutionProvider, policy = new CommandPolicy('all')): WorkspaceTools {
  return new WorkspaceTools(root, new Set(['execute']), 'agent', undefined, policy, 120_000, undefined, undefined, undefined, provider);
}

describe('background commands under the declared direct shell (v0.9.96)', () => {
  it('gates and spawns under the same prepared identity, outside the foreground lane', async () => {
    const { provider, started } = backgroundProvider(CMD_SHELL);
    const tools = toolsWith(provider);
    const refused = await tools.run('run_command', { command: 'Copy-Item a b', background: true });
    expect(refused).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    expect(refused.output).toMatch(/runs in cmd\.exe \(cmd grammar\)/);
    const ok = await tools.runText('run_command', { command: 'npm run dev', background: true });
    expect(ok).toContain('Background command started. ID: bg_1');
    expect(started).toEqual([{ command: 'npm run dev', shell: CMD_SHELL }]);
  });

  it('reports killed only when the tree is seen to stop, and keeps saying when it was not', async () => {
    const { provider, children } = backgroundProvider();
    const tools = toolsWith(provider);
    await tools.run('run_command', { command: 'npm run dev', background: true });
    await tools.run('run_command', { command: 'npm run watch', background: true });
    (tools as any).terminateBackgroundTree = treeStops([{ status: 'unknown', detail: 'process 77 was still running' }, { status: 'confirmed-stopped' }]);

    const unknown = await tools.run('kill_command', { id: 'bg_1' });
    expect(unknown).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(unknown.output).toBe('Background command "bg_1" was told to stop, but UnodeAi could not confirm that its process tree stopped (process 77 was still running). It may still be running.');
    // The close of the outer shell must not turn the unknown stop into an exit.
    children[0].emit('close', null);
    const checked = await tools.run('check_command', { id: 'bg_1' });
    expect(checked.output.split('\n')[0]).toBe('[bg_1 stop not confirmed: it may still be running]');
    expect(checked).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(await tools.run('kill_command', { id: 'bg_1' })).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });

    const confirmed = await tools.run('kill_command', { id: 'bg_2' });
    expect(confirmed).toMatchObject({ status: 'success', output: 'Background command "bg_2" killed.' });
    expect((await tools.run('check_command', { id: 'bg_2' })).output.split('\n')[0]).toBe('[bg_2 killed]');
  });

  it('disposal stops every running command and returns the stops it could not confirm', async () => {
    const { provider } = backgroundProvider();
    const tools = toolsWith(provider);
    await tools.run('run_command', { command: 'npm run dev', background: true });
    await tools.run('run_command', { command: 'npm run watch', background: true });
    (tools as any).terminateBackgroundTree = treeStops([{ status: 'confirmed-stopped' }, { status: 'unknown', detail: 'the process list could not be read' }]);
    expect(await tools.disposeBackground()).toEqual({
      unconfirmed: [{ id: 'bg_2', command: 'npm run watch', detail: 'the process list could not be read' }],
    });
  });

  it('disposal tries an unconfirmed stop again and reports each stop it still cannot confirm', async () => {
    const { provider } = backgroundProvider();
    const reported: unknown[] = [];
    const tools = toolsWith({ ...provider, reportUnconfirmedStops: (stops) => { reported.push(...stops); } });
    await tools.run('run_command', { command: 'npm run dev', background: true });
    await tools.run('run_command', { command: 'npm run watch', background: true });
    const stopped: string[] = [];
    (tools as any).terminateBackgroundTree = treeStops([
      { status: 'unknown', detail: 'process 77 was still running' },
      { status: 'unknown', detail: 'process 77 was still running' },
      { status: 'confirmed-stopped' },
    ], (proc) => { stopped.push(String(proc === undefined)); });
    expect(await tools.run('kill_command', { id: 'bg_1' })).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });

    const disposed = await tools.disposeBackground();
    // bg_1, whose stop was unconfirmed, was stopped again, as was the running bg_2.
    expect(stopped).toHaveLength(3);
    expect(disposed).toEqual({ unconfirmed: [{ id: 'bg_1', command: 'npm run dev', detail: 'process 77 was still running' }] });
    expect(reported).toEqual(disposed.unconfirmed);
  });

  it('a background start refused by a host condition is reported as not run, never as a failed start', async () => {
    const provider: CommandExecutionProvider = {
      async acquire() { throw new Error('a background command takes no foreground lane'); },
      prepareDirect: () => ({
        ok: true,
        shell: CMD_SHELL,
        execute: async () => { throw new Error('not a foreground command'); },
        startBackground: () => ({
          ok: false,
          error: 'distrusted',
          notStarted: { ok: false, reason: 'cwd-unverified', message: 'Command not run: the workspace is no longer trusted.' },
        }),
      }),
    };
    const out = await toolsWith(provider).run('run_command', { command: 'npm run dev', background: true });
    expect(out).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    expect(out.output).toContain('Command not run: the workspace is no longer trusted.');
    expect(out.output).not.toContain('Failed to start');
  });
});

describe('a background command whose shell ended while its output stays open (v0.9.96)', () => {
  const STILL_OPEN = 'its output did not close, so a process it started may still be running';
  const AT_SHUTDOWN = 'the host was shutting down, so it was not seen whether its output closed';
  const ALLOWANCE = 1_000;
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Background commands stopped by the production tree stop, every number reading alive, and every signal, listing
   * and taskkill recorded. The commands' shells have ended: by exit code, or by a signal.
   */
  async function endedShells(count: number, how: Array<'exit' | 'signal'> = []) {
    vi.useFakeTimers();
    const { provider, children } = backgroundProvider();
    const reported: unknown[] = [];
    const tools = toolsWith({ ...provider, reportUnconfirmedStops: (stops) => { reported.push(...stops); } });
    for (let i = 0; i < count; i += 1) await tools.run('run_command', { command: `npm run job${i + 1}`, background: true });
    const shutdown = new HostShutdown();
    const sent: string[] = [];
    (tools as any).backgroundShutdown = shutdown;
    (tools as any).backgroundCloseConfirmMs = ALLOWANCE;
    (tools as any).terminateBackgroundTree = (proc: ChildProcess) => terminateChildProcessTree(proc, {
      platform: 'win32', shutdown,
      kill: (pid, signal) => { sent.push(`signal ${pid} ${signal}`); },
      listProcesses: async () => { sent.push('list'); return []; },
      taskkill: async (pid) => { sent.push(`taskkill ${pid}`); return 0; },
    });
    children.forEach((child, i) => {
      const bySignal = how[i] === 'signal';
      // Each child has its own number, which an unrelated process may now hold.
      Object.assign(child, { pid: 6100 + i, exitCode: bySignal ? null : 0, signalCode: bySignal ? 'SIGTERM' : null });
      child.emit('exit', bySignal ? null : 0, bySignal ? 'SIGTERM' : null);
    });
    /** Whether `promise` has settled once the timers have run `ms` further. */
    const settledAfter = async (promise: Promise<unknown>, ms: number) => {
      let settled = false;
      void promise.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(ms);
      return settled;
    };
    return { tools, children, reported, shutdown, sent, settledAfter };
  }

  it('is not reported killed when the output does not close in time, by exit code or by signal, and nothing is sent to the shell\'s number', async () => {
    const { tools, sent, settledAfter } = await endedShells(2, ['exit', 'signal']);
    for (const id of ['bg_1', 'bg_2']) {
      const killing = tools.run('kill_command', { id });
      expect(await settledAfter(killing, ALLOWANCE - 1)).toBe(false);
      expect(await settledAfter(killing, 1)).toBe(true);
      const result = await killing;
      expect(result).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
      expect(result.output).toContain(`(${STILL_OPEN})`);
      expect((await tools.run('check_command', { id })).output.split('\n')[0]).toBe(`[${id} stop not confirmed: it may still be running]`);
    }
    expect(sent).toEqual([]);
  });

  it('is reported killed when the output closes within the time, and at once when it closed during the stop', async () => {
    const { tools, children, sent, settledAfter } = await endedShells(2);
    const killing = tools.run('kill_command', { id: 'bg_1' });
    expect(await settledAfter(killing, 300)).toBe(false);
    children[0].emit('close', 0);
    expect(await settledAfter(killing, 0)).toBe(true);
    expect(await killing).toMatchObject({ status: 'success', output: 'Background command "bg_1" killed.' });

    // The close comes while the tree stop runs: nothing is waited for afterwards.
    (tools as any).terminateBackgroundTree = async (proc: ChildProcess) => { proc.emit('close', 0); return { status: 'already-stopped' }; };
    const closedFirst = tools.run('kill_command', { id: 'bg_2' });
    expect(await settledAfter(closedFirst, 0)).toBe(true);
    expect(await closedFirst).toMatchObject({ status: 'success', output: 'Background command "bg_2" killed.' });
    expect((await tools.run('check_command', { id: 'bg_2' })).output.split('\n')[0]).toBe('[bg_2 killed]');
    expect(sent).toEqual([]);
  });

  it('gives every stop of one command a single time: a stop during the wait shares it', async () => {
    const { tools, reported, settledAfter } = await endedShells(1);
    const killing = tools.run('kill_command', { id: 'bg_1' });
    await vi.advanceTimersByTimeAsync(500);
    // The session ends while kill_command waits: both stops end when the one time is up, at 1,000 ms, not 1,500 ms.
    const disposing = tools.disposeBackground();
    expect(await settledAfter(Promise.all([killing, disposing]), ALLOWANCE - 500)).toBe(true);
    expect(await disposing).toEqual({ unconfirmed: [{ id: 'bg_1', command: 'npm run job1', detail: STILL_OPEN }] });
    expect(reported).toEqual([{ id: 'bg_1', command: 'npm run job1', detail: STILL_OPEN }]);
  });

  it('a retry after the time has passed is unconfirmed at once and reported', async () => {
    const { tools, reported, settledAfter } = await endedShells(1);
    const killing = tools.run('kill_command', { id: 'bg_1' });
    await vi.advanceTimersByTimeAsync(ALLOWANCE);
    expect(await killing).toMatchObject({ failureKind: 'outcome_unknown' });
    const disposing = tools.disposeBackground();
    expect(await settledAfter(disposing, 0)).toBe(true);
    expect(await disposing).toEqual({ unconfirmed: [{ id: 'bg_1', command: 'npm run job1', detail: STILL_OPEN }] });
    expect(reported).toHaveLength(1);
  });

  it('does not wait at all once the host is shutting down, and claims nothing', async () => {
    const { tools, shutdown, reported, sent, settledAfter } = await endedShells(1);
    shutdown.begin();
    const disposing = tools.disposeBackground();
    expect(await settledAfter(disposing, 0)).toBe(true);
    expect(await disposing).toEqual({ unconfirmed: [{ id: 'bg_1', command: 'npm run job1', detail: AT_SHUTDOWN }] });
    expect(reported).toEqual([{ id: 'bg_1', command: 'npm run job1', detail: AT_SHUTDOWN }]);
    expect(sent).toEqual([]);
  });

  it('ends a wait under way when the shutdown begins, and leaves no timer or listener behind', async () => {
    const { tools, children, shutdown, settledAfter } = await endedShells(1);
    const listeners = children[0].listenerCount('close');
    const killing = tools.run('kill_command', { id: 'bg_1' });
    expect(await settledAfter(killing, 200)).toBe(false);
    expect(children[0].listenerCount('close')).toBe(listeners + 1);
    shutdown.begin();
    expect(await settledAfter(killing, 0)).toBe(true);
    const result = await killing;
    expect(result).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(result.output).toContain(`(${AT_SHUTDOWN})`);
    expect(children[0].listenerCount('close')).toBe(listeners);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('run_checks under one preparation of the direct shell (v0.9.96)', () => {
  function checks(prepare: ReturnType<typeof directPreparer>, policy = new CommandPolicy('all')) {
    return new TeamTools('pm', { list: () => [], resolve: () => undefined }, new MessageBus(), {
      verifyCommand: 'npm test', cwd: root, commandPolicy: policy, prepareCommand: prepare,
    });
  }

  it('gates and runs the same preparation, once, with a head-and-tail output bound', async () => {
    const policy = new CommandPolicy('all');
    const seen: string[] = [];
    const original = policy.check.bind(policy);
    policy.check = (command, options) => { seen.push(options.shell.fingerprint); return original(command, options); };
    const prepare = directPreparer(async () => ({ code: 0, output: 'all green' }), CMD_SHELL);
    const out = await checks(prepare, policy).runOutcome('run_checks', {});
    expect(out).toMatchObject({ status: 'success' });
    expect(out.output).toContain('[checks passed]');
    expect(prepare.prepared).toBe(1);
    expect(seen).toEqual([CMD_SHELL.fingerprint]);
    expect(prepare.runs).toEqual([{ command: 'npm test', cwd: root, timeoutMs: 300_000, maxOutputChars: 8_000 }]);
  });

  it('a timeout fails the checks; an unobserved outcome is never verification evidence', async () => {
    const timedOut = await checks(directPreparer(async () => ({ code: null, output: 'partial', timedOut: true }))).runOutcome('run_checks', {});
    expect(timedOut).toMatchObject({ status: 'failed' });
    expect(timedOut.output).toMatch(/^\[checks FAILED\] `npm test` timed out after 300s and its process tree was stopped\./);

    const unknown = await checks(directPreparer(async () => ({
      status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', note: 'Command timed out. UnodeAi could not confirm that its process tree stopped.', output: 'x',
    }))).runOutcome('run_checks', {});
    expect(unknown).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
    expect(unknown.output).toMatch(/^\[checks outcome unknown\] `npm test`: Command timed out\. UnodeAi could not confirm that its process tree stopped\. This is not a verification result/);
  });

  it('refuses when the direct shell cannot be prepared, and runs nothing', async () => {
    const tools = new TeamTools('pm', { list: () => [], resolve: () => undefined }, new MessageBus(), {
      verifyCommand: 'npm test', cwd: root, commandPolicy: new CommandPolicy('all'),
      prepareCommand: () => ({ ok: false, reason: 'shell-compatibility', message: 'Command not run: UnodeAi could not find its declared direct shell (cmd.exe) as a host executable.' }),
    });
    const out = await tools.runOutcome('run_checks', {});
    expect(out).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    expect(out.output).toBe('Verification command not run: Command not run: UnodeAi could not find its declared direct shell (cmd.exe) as a host executable.');
  });
});

describe('the closed command-string inventory (v0.9.96)', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
    });
  }
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  /** The option text of every process spawn: the arguments of a spawn call, and SpawnOptions-typed literals. */
  function spawnSites(text: string): string[] {
    const sites: string[] = [];
    for (const match of text.matchAll(/\b(?:spawn|cpSpawn|nodeSpawn|spawnSync|execFile|execFileSync)\s*\(/g)) {
      let depth = 0;
      let end = match.index! + match[0].length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')') { depth -= 1; if (depth === 0) break; }
      }
      sites.push(text.slice(match.index, end + 1));
    }
    for (const match of text.matchAll(/:\s*SpawnOptions\s*=>\s*\(\{[\s\S]*?\}\)/g)) sites.push(match[0]);
    return sites;
  }

  it('no production path spawns a command string with shell: true, and a variable shell is only the explained ones', () => {
    const files = sourceFiles(path.join(process.cwd(), 'src'));
    const relative = (file: string) => path.relative(process.cwd(), file).replace(/\\/g, '/');
    const sites = files.flatMap((file) => spawnSites(code(readFileSync(file, 'utf8'))).map((site) => ({ file: relative(file), site })));
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.filter(({ site }) => /\bshell\s*:\s*true\b/.test(site)).map(({ file }) => file)).toEqual([]);
    const variable = sites
      .filter(({ site }) => /\bshell\s*:\s*(?!true\b|false\b)[A-Za-z_][\w.]*/.test(site))
      .map(({ file }) => file);
    // The declared direct shell (an absolute interpreter, gated under its identity), the measured Claude CLI
    // `.cmd` launch shim, which interprets no model command string, and (v0.9.96) the version check of that same
    // shim, whose only argument is the fixed `--version`. v0.9.97: the adoption check's `--version` run of that shim
    // (refused for a path holding `"`, CR, LF or `%`), and the resolver, which hands
    // the start's own spawn the launch spelling whose files it hashed; it starts no process itself.
    expect([...new Set(variable)].sort()).toEqual([
      'src/backend/ClaudeHeadlessBackend.ts', 'src/backend/CodexCliProbe.ts', 'src/backend/DirectCommandExecution.ts',
      'src/host/cliGateProbeRun.ts', 'src/host/cliRuntimeResolver.ts',
    ]);
  });
});
