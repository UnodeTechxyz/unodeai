import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { COMMAND_MAX_TIMEOUT_SECONDS, COMMAND_MAX_WAIT_SECONDS, WorkspaceTools } from '../WorkspaceTools';
import { asProvider } from './shellFixtures';
import { CommandPolicy } from '../CommandPolicy';

/** Tools whose commands really run. afterEach stops what each started, also when the test failed before it could. */
const made: Array<{ root: string; tools: WorkspaceTools }> = [];

const mkTools = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
  const tools = new WorkspaceTools(root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'));
  made.push({ root, tools });
  return { root, tools };
};

/** A test that starts a real process: one real tree stop can take seconds on a loaded machine. */
const REAL_PROCESS_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// On Windows a just-killed process keeps a lock on its cwd for a beat, so rm can hit EBUSY. Retry.
const rmDir = async (dir: string) => {
  for (let i = 0; i < 10; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
};

describe('WorkspaceTools background commands', () => {
  afterEach(async () => {
    for (const { root, tools } of made.splice(0)) {
      await tools.disposeBackground();
      await rmDir(root);
    }
  }, 90_000);

  it('background:true returns a handle', async () => {
    const { root, tools } = await mkTools();
    const out = await tools.runText('run_command', { command: 'echo hello', background: true });
    expect(out).toMatch(/Background command started\. ID: bg_\d+/);
    expect(out).toMatch(/check_command/);
    expect(out).toMatch(/wait_seconds/);
    expect(out).toMatch(/kill_command/);
    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('check_command reports exit status and captured output', async () => {
    const { root, tools } = await mkTools();
    const start = await tools.runText('run_command', { command: 'echo from-bg', background: true });
    const id = start.match(/bg_\d+/)![0];

    // Poll until the short command has exited.
    let checked = '';
    for (let i = 0; i < 50; i++) {
      checked = await tools.runText('check_command', { id });
      if (checked.includes('exited')) { break; }
      await sleep(20);
    }
    expect(checked).toMatch(/\[bg_\d+ exited 0\]/);
    expect(checked).toContain('from-bg');

    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('kill_command stops a long-running command', async () => {
    const { root, tools } = await mkTools();
    // node sleep is portable across Win/posix shells.
    const start = await tools.runText('run_command', {
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      background: true,
    });
    const id = start.match(/bg_\d+/)![0];

    expect(await tools.runText('check_command', { id })).toMatch(/\[bg_\d+ running\]/);
    expect(await tools.runText('kill_command', { id })).toContain('killed');
    expect(await tools.runText('check_command', { id })).toMatch(/\[bg_\d+ killed\]/);

    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('check_command / kill_command on an unknown ID return an error', async () => {
    const { root, tools } = await mkTools();
    expect(await tools.runText('check_command', { id: 'bg_999' })).toMatch(/no background command/);
    expect(await tools.runText('kill_command', { id: 'bg_999' })).toMatch(/no background command/);
    await rmDir(root);
  });

  it('applies the command normalizer (rewrite + note) before running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
    const norm = (c: string) =>
      c === 'npx vitest' ? { command: 'echo rewritten', note: '[UnodeAi] used the project script' } : { command: c };
    const tools = new WorkspaceTools(
      root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'), undefined, undefined, undefined, norm
    );
    const out = await tools.runText('run_command', { command: 'npx vitest' });
    expect(out).toContain('[UnodeAi] used the project script');
    expect(out).toContain('rewritten');
    await rmDir(root);
  });

  it('#13: runs foreground commands through the injected executor, preserving framing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
    const calls: string[] = [];
    const exec = async (command: string) => { calls.push(command); return { code: 0, output: 'hi from executor' }; };
    const tools = new WorkspaceTools(
      root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'),
      undefined, undefined, undefined, undefined, asProvider(exec)
    );
    const out = await tools.runText('run_command', { command: 'echo x' });
    expect(calls).toEqual(['echo x']);
    expect(out).toContain('[exit 0]');
    expect(out).toContain('hi from executor');
    await rmDir(root);
  });

  it('check_command with wait_seconds returns as soon as the command finishes, not when the wait ends', async () => {
    const { root, tools } = await mkTools();
    const start = await tools.runText('run_command', {
      command: 'node -e "setTimeout(() => console.log(\'built\'), 400)"',
      background: true,
    });
    const id = start.match(/bg_\d+/)![0];

    const began = Date.now();
    const checked = await tools.runText('check_command', { id, wait_seconds: 60 });
    expect(checked).toMatch(/\[bg_\d+ exited 0\]/);
    expect(checked).toContain('built');
    // One call saw the command through to its end, long before the minute it was allowed.
    expect(Date.now() - began).toBeLessThan(20_000);

    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('a wait that runs out reports the command as still running, and a value that is no number does not wait', async () => {
    const { root, tools } = await mkTools();
    const start = await tools.runText('run_command', { command: 'node -e "setTimeout(()=>{}, 60000)"', background: true });
    const id = start.match(/bg_\d+/)![0];

    const began = Date.now();
    expect(await tools.runText('check_command', { id, wait_seconds: 0.4 })).toMatch(/\[bg_\d+ running\]/);
    expect(Date.now() - began).toBeGreaterThanOrEqual(350);

    for (const value of ['long', -5, 0, Number.NaN, null]) {
      const before = Date.now();
      expect(await tools.runText('check_command', { id, wait_seconds: value })).toMatch(/\[bg_\d+ running\]/);
      expect(Date.now() - before).toBeLessThan(300);
    }
    expect(COMMAND_MAX_WAIT_SECONDS).toBe(300);

    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('ends a wait at once when it is interrupted, and leaves the command running', async () => {
    const { root, tools } = await mkTools();
    const start = await tools.runText('run_command', { command: 'node -e "setTimeout(()=>{}, 60000)"', background: true });
    const id = start.match(/bg_\d+/)![0];

    const began = Date.now();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    // The model asks for more than a check may wait: the wait it gets is the limit.
    const waiting = tools.runText('check_command', { id, wait_seconds: 99_999 });
    await sleep(100);
    const delays = timers.mock.calls.map(([, delay]) => delay);
    timers.mockRestore();
    expect(delays).toContain(COMMAND_MAX_WAIT_SECONDS * 1000);
    expect(delays).not.toContain(99_999_000);
    tools.interruptCommandWaits();
    expect(await waiting).toMatch(/\[bg_\d+ running\]/);
    expect(Date.now() - began).toBeLessThan(5_000);
    // The command was not stopped by that: only the wait was.
    expect(await tools.runText('check_command', { id })).toMatch(/\[bg_\d+ running\]/);
    expect(await tools.runText('kill_command', { id })).toContain('killed');

    await tools.disposeBackground();
    await rmDir(root);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('runs a foreground command for the time the model stated, within the limit, and says so when it is cut', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
    const timeouts: number[] = [];
    let timedOut = false;
    const exec = async (_command: string, opts: { cwd: string; timeoutMs: number }) => {
      timeouts.push(opts.timeoutMs);
      return timedOut ? { code: null, output: 'partial', timedOut: true } : { code: 0, output: 'ok' };
    };
    const tools = new WorkspaceTools(
      root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'),
      undefined, undefined, undefined, undefined, asProvider(exec)
    );

    await tools.runText('run_command', { command: 'npm test' });
    await tools.runText('run_command', { command: 'npm test', timeout_seconds: 300 });
    await tools.runText('run_command', { command: 'npm test', timeout_seconds: 10.2 });
    await tools.runText('run_command', { command: 'npm test', timeout_seconds: 99_999 });
    for (const value of ['300', 0, -1, Number.NaN, null]) {
      await tools.runText('run_command', { command: 'npm test', timeout_seconds: value });
    }
    expect(timeouts).toEqual([
      120_000, 300_000, 11_000, COMMAND_MAX_TIMEOUT_SECONDS * 1000, 120_000, 120_000, 120_000, 120_000, 120_000,
    ]);
    expect(COMMAND_MAX_TIMEOUT_SECONDS).toBe(600);

    timedOut = true;
    expect(await tools.runText('run_command', { command: 'npm test', timeout_seconds: 300 })).toContain('[timed out after 300s]');
    await rmDir(root);
  });

  describe('the exit code a command status line shows', () => {
    // v0.9.95: Windows reports an exit status as an unsigned 32-bit number, so a command that ended with -4058
    // was shown as `[exit 4294963238]`. The line now shows the signed code. The outcome keeps the raw one.
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    /** Run with `process.platform` reading as the given platform, and put the real one back. */
    const onPlatform = async <T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> => {
      Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
      try { return await run(); } finally { Object.defineProperty(process, 'platform', realPlatform); }
    };
    const foreground = async (code: number | null) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
      const exec = async () => ({ code, output: 'the command said this' });
      const tools = new WorkspaceTools(
        root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'),
        undefined, undefined, undefined, undefined, asProvider(exec)
      );
      return { root, tools };
    };

    it('shows a foreground command\'s Windows status as the signed code, and keeps the raw code in the outcome', async () => {
      const { root, tools } = await foreground(0xfffff026);
      const onWindows = await onPlatform('win32', () => tools.run('run_command', { command: 'npm test' }));
      expect(onWindows.output).toBe('[exit -4058]\nthe command said this');
      expect(onWindows).toMatchObject({ status: 'failed', exitCode: 4294963238, contentSource: 'mixed-external' });

      const elsewhere = await onPlatform('linux', () => tools.run('run_command', { command: 'npm test' }));
      expect(elsewhere.output).toBe('[exit 4294963238]\nthe command said this');
      expect(elsewhere).toMatchObject({ status: 'failed', exitCode: 4294963238 });
      await rmDir(root);
    });

    it('leaves a pass, an ordinary failure and a run with no code as they were, on either platform', async () => {
      for (const platform of ['win32', 'linux'] as const) {
        const passed = await foreground(0);
        const pass = await onPlatform(platform, () => passed.tools.run('run_command', { command: 'npm test' }));
        expect(pass.output).toBe('[exit 0]\nthe command said this');
        expect(pass).toMatchObject({ status: 'success', exitCode: 0 });
        await rmDir(passed.root);

        const failed = await foreground(2);
        const fail = await onPlatform(platform, () => failed.tools.run('run_command', { command: 'npm test' }));
        expect(fail.output).toBe('[exit 2]\nthe command said this');
        expect(fail).toMatchObject({ status: 'failed', exitCode: 2 });
        await rmDir(failed.root);

        const uncoded = await foreground(null);
        const none = await onPlatform(platform, () => uncoded.tools.run('run_command', { command: 'npm test' }));
        expect(none.output).toBe('[exit null]\nthe command said this');
        expect(none.status).toBe('failed');
        expect(none).not.toHaveProperty('exitCode');
        await rmDir(uncoded.root);
      }
    });

    it('fails a foreground command on its raw code: a status shown as -1 is not a pass', async () => {
      const { root, tools } = await foreground(0xffff_ffff);
      const outcome = await onPlatform('win32', () => tools.run('run_command', { command: 'npm test' }));
      expect(outcome.output).toBe('[exit -1]\nthe command said this');
      expect(outcome).toMatchObject({ status: 'failed', exitCode: 4294967295 });
      await rmDir(root);
    });

    it('shows a finished background command\'s Windows status as the signed code, and keeps the raw code in the outcome', async () => {
      const { root, tools } = await mkTools();
      // A command that has ended, as the host holds it. Reading its status touches nothing else of it.
      (tools as any).bgCommands.set('bg_7', {
        id: 'bg_7', command: 'npm test', proc: undefined, output: 'the command said this',
        status: 'exited', exitCode: 0xfffff026, progressRevision: 2,
      });
      const onWindows = await onPlatform('win32', () => tools.run('check_command', { id: 'bg_7' }));
      expect(onWindows.output).toBe('[bg_7 exited -4058]\nthe command said this');
      expect(onWindows).toMatchObject({ status: 'failed', exitCode: 4294963238, progressToken: 'bg_7@2' });

      const elsewhere = await onPlatform('linux', () => tools.run('check_command', { id: 'bg_7' }));
      expect(elsewhere.output).toBe('[bg_7 exited 4294963238]\nthe command said this');
      expect(elsewhere).toMatchObject({ status: 'failed', exitCode: 4294963238 });
      (tools as any).bgCommands.clear();
      await rmDir(root);
    });

    it('shows what a real background command exited with, as this platform reports it', async () => {
      const { root, tools } = await mkTools();
      const start = await tools.runText('run_command', { command: 'node -e "process.exit(-4058)"', background: true });
      const id = start.match(/bg_\d+/)![0];
      const checked = await tools.run('check_command', { id, wait_seconds: 60 });
      // Windows hands the status back as 4294963238. Elsewhere an exit status is its low byte.
      const [raw, shown] = process.platform === 'win32' ? [4294963238, -4058] : [38, 38];
      expect(checked.output.split('\n')[0]).toBe(`[${id} exited ${shown}]`);
      expect(checked).toMatchObject({ status: 'failed', exitCode: raw });

      await tools.disposeBackground();
      await rmDir(root);
    }, REAL_PROCESS_TIMEOUT_MS);
  });

  it('background commands are still gated by command policy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
    // default-deny policy: nothing should spawn.
    const tools = new WorkspaceTools(root, new Set(['execute']), 'test', undefined, new CommandPolicy('none'));
    const result = await tools.run('run_command', { command: 'echo nope', background: true });
    expect(result.output).not.toMatch(/Background command started/);
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    await rmDir(root);
  });

  it("ask-mode: a denied command is a consent refusal without relaying the user's note", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-approve-'));
    const tools = new WorkspaceTools(
      root, new Set(['execute']), 'test', undefined,
      new CommandPolicy('ask', []), undefined,
      async () => ({ allow: false, note: 'use npm run clean instead' }),
    );
    const result = await tools.run('run_command', { command: 'somecmd --build' });
    expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(result.output).not.toContain('use npm run clean instead');
    await rmDir(root);
  });
});
