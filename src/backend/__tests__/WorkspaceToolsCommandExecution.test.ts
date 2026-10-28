import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import type { CommandExecResult, CommandExecutionProvider, CommandPreparationFailure, PreparedCommandExecution } from '../CommandExecution';
import type { CommandShellIdentity } from '../CommandShell';
import { BoundedCommandOutput } from '../BoundedCommandOutput';
import { WorkspaceTools, type CommandApprover } from '../WorkspaceTools';
import { BASH_SHELL, CMD_SHELL } from './shellFixtures';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { createDirectCommandPreparer, createDirectExecutionProvider } from '../DirectCommandExecution';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-command-execution-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

interface Recorder {
  provider: CommandExecutionProvider;
  executed: string[];
  released: number;
}

function provider(options: {
  shell?: CommandShellIdentity;
  notice?: string;
  result?: CommandExecResult;
  failure?: CommandPreparationFailure;
} = {}): Recorder {
  const record: Recorder = {
    executed: [],
    released: 0,
    provider: {
      async acquire() {
        if (options.failure) return options.failure;
        const lease: PreparedCommandExecution = {
          ok: true,
          shell: options.shell ?? BASH_SHELL,
          transport: options.notice ? 'direct' : 'terminal',
          ...(options.notice ? { notice: options.notice } : {}),
          signal: new AbortController().signal,
          async execute(command) {
            record.executed.push(command);
            return options.result ?? { status: 'exited', code: 0, output: 'ok' };
          },
          async release() { record.released += 1; },
        };
        return lease;
      },
    },
  };
  return record;
}

function tools(
  recorder: Recorder,
  options: { policy?: CommandPolicy; approve?: CommandApprover; normalizer?: (command: string, shell: CommandShellIdentity) => { command: string; note?: string } } = {},
): WorkspaceTools {
  return new WorkspaceTools(
    root, new Set(['execute']), 'agent', undefined, options.policy ?? new CommandPolicy('all'), 120_000,
    options.approve, undefined, options.normalizer, recorder.provider,
  );
}

describe('run_command under a prepared execution (v0.9.96)', () => {
  it.each(['rm -rf .', 'echo hello'])('shows each Disabled refusal for %s without executing or asking', async command => {
    const recorder = provider(); const approve = async () => { throw new Error('must not ask'); };
    const work = tools(recorder, { policy: new CommandPolicy('none'), approve }); const lines: string[] = [];
    work.setCommandDisabledObserver(line => lines.push(line));
    const outcome = await work.run('run_command', { command });
    expect(outcome.status).toBe('refused'); expect(recorder.executed).toEqual([]);
    expect(lines).toHaveLength(1); expect(lines[0]).toContain(command); expect(lines[0]).toContain(JSON.stringify(root));
  });
  it.each(['exit', 'kill', 'dispose'] as const)('a real direct execution hands off to check_command and supports %s', async action => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242 });
    let spawns = 0; let stops = 0;
    const execution = createDirectExecutionProvider(createDirectCommandPreparer({
      shell: () => ({ identity: CMD_SHELL, executable: 'C:/Windows/System32/cmd.exe' }),
      spawn: () => { spawns++; return child; }, env: () => ({}),
      terminateTree: async () => { stops++; child.emit('close', null); return { status: 'confirmed-stopped' }; },
    }));
    const work = new WorkspaceTools(root, new Set(['execute']), 'agent', undefined, new CommandPolicy('all'), 10,
      undefined, undefined, undefined, execution);
    const started = await work.run('run_command', { command: 'npm run build' });
    expect(started.output).toContain('still running'); expect(spawns).toBe(1); expect(stops).toBe(0);
    const id = /ID: (bg_\d+)/.exec(started.output)![1];
    child.stdout!.emit('data', Buffer.from('more output\n'));
    expect((await work.run('check_command', { id })).output).toContain('more output');
    if (action === 'exit') {
      child.emit('close', 0); await Promise.resolve();
      expect(await work.run('check_command', { id })).toMatchObject({ status: 'success', exitCode: 0 });
    } else if (action === 'kill') expect((await work.run('kill_command', { id })).output).toContain('killed');
    await work.disposeBackground();
    expect(stops).toBe(action === 'exit' ? 0 : 1); expect(spawns).toBe(1);
  });
  it('normalizes and gates under the prepared shell, runs the normalized command once and releases the lane', async () => {
    const seen: CommandShellIdentity[] = [];
    const recorder = provider({ shell: CMD_SHELL });
    const result = await tools(recorder, {
      normalizer: (command, shell) => { seen.push(shell); return { command: command.replace('npx vitest', 'npm test'), note: '[UnodeAi] used the project script' }; },
    }).run('run_command', { command: 'npx vitest' });
    expect(seen).toEqual([CMD_SHELL]);
    expect(recorder.executed).toEqual(['npm test']);
    expect(recorder.released).toBe(1);
    expect(result).toMatchObject({ status: 'success', exitCode: 0 });
    expect(result.output).toBe('[UnodeAi] used the project script\n[exit 0]\nok');
  });

  it('releases the lane when the gate refuses or the person denies, and runs nothing', async () => {
    const refused = provider({ shell: CMD_SHELL });
    expect(await tools(refused).run('run_command', { command: 'Copy-Item a b' })).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    const denied = provider();
    expect(await tools(denied, { policy: new CommandPolicy('ask', []), approve: async () => ({ allow: false }) })
      .run('run_command', { command: 'npm run deploy' })).toMatchObject({ status: 'refused', reason: 'consent' });
    for (const recorder of [refused, denied]) {
      expect(recorder.executed).toEqual([]);
      expect(recorder.released).toBe(1);
    }
  });

  it('names the direct fallback in the result and on the approval it opens', async () => {
    const notice = 'The selected terminal profile could not prove shell integration and cwd. This invocation will use the declared direct fallback: cmd.exe.';
    const warnings: Array<string | undefined> = [];
    const recorder = provider({ shell: CMD_SHELL, notice });
    const result = await tools(recorder, {
      policy: new CommandPolicy('ask', []),
      approve: async (_command, context) => { warnings.push(context.warning); return { allow: true }; },
    }).run('run_command', { command: 'npm run build' });
    expect(warnings).toEqual([notice]);
    expect(result.output.startsWith(`${notice}\n[exit 0]`)).toBe(true);
    expect(result.output).not.toMatch(/System32|\\cmd\.exe|\/bin\/sh/i);
  });

  it('says that no output was captured for a quiet command, and still passes it', async () => {
    const result = await tools(provider({ result: { status: 'exited', code: 0, output: '' } })).run('run_command', { command: 'git diff --quiet' });
    expect(result).toMatchObject({ status: 'success', exitCode: 0 });
    expect(result.output).toBe('[exit 0]\nNo output was captured.');
  });

  it('keeps the head and the tail of long output within the 16,000-character result, framing included', async () => {
    const capture = new BoundedCommandOutput();
    capture.push(`BEGIN\n${'y'.repeat(100_000)}\nTHE ERROR AT THE END`);
    const recorder = provider({ result: { status: 'exited', code: 1, output: capture.renderWithin(16_000), capture } });
    const result = await tools(recorder, { normalizer: (command) => ({ command, note: 'n'.repeat(500) }) }).run('run_command', { command: 'npm test' });
    expect(result.output.length).toBeLessThanOrEqual(16_000);
    expect(result.output.startsWith(`${'n'.repeat(500)}\n[exit 1]\nBEGIN`)).toBe(true);
    expect(result.output.endsWith('THE ERROR AT THE END')).toBe(true);
    expect(result.output).not.toContain('…[truncated');
  });

  it('frames every typed result from its status, never from its wording', async () => {
    const cases: Array<[CommandExecResult, Record<string, unknown>, RegExp]> = [
      [{ status: 'timed-out', code: null, stopConfirmed: true, output: 'partial' }, { status: 'failed' }, /^\[timed out after 120s\]\npartial$/],
      [{ status: 'not-started', code: null, reason: 'environment-changed', output: 'Command not run: the prepared terminal changed after approval.' }, { status: 'refused', reason: 'shell-compatibility' }, /Command not run: the prepared terminal changed after approval\./],
      [{ status: 'not-started', code: null, reason: 'spawn-failed', output: 'Failed to start the command: ENOENT' }, { status: 'failed' }, /^Error: Failed to start the command: ENOENT$/],
      [{ status: 'not-started', code: null, reason: 'disposed', output: 'Command not run: the agent was stopped.' }, { status: 'failed', failureKind: 'cancelled' }, /agent was stopped/],
      [{ status: 'outcome-unknown', code: null, reason: 'terminal-died', output: 'half' }, { status: 'failed', failureKind: 'outcome_unknown' }, /^\[outcome unknown: the terminal closed while the command ran; it may have had effects\]\nhalf$/],
      [{ status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', note: 'Command timed out. UnodeAi could not confirm that its process tree stopped.', output: 'Command timed out. UnodeAi could not confirm that its process tree stopped.\nlast words' }, { status: 'failed', failureKind: 'outcome_unknown' }, /^\[outcome unknown: the process tree could not be confirmed stopped\]\nCommand timed out\. UnodeAi could not confirm that its process tree stopped\.\nlast words$/],
      [{ status: 'exited', code: 0, output: 'Error: words are only data' }, { status: 'success', exitCode: 0 }, /^\[exit 0\]\nError: words are only data$/],
    ];
    for (const [result, outcome, text] of cases) {
      const recorder = provider({ result });
      const framed = await tools(recorder).run('run_command', { command: 'npm test' });
      expect(framed, JSON.stringify(result)).toMatchObject(outcome);
      expect(framed.output, JSON.stringify(result)).toMatch(text);
      expect(recorder.released).toBe(1);
    }
  });

  it('refuses when no execution could be prepared, and calls a disposed lane cancelled', async () => {
    const unprepared = provider({ failure: { ok: false, reason: 'cwd-unverified', message: 'Command not run: the agent terminal could not be prepared.' } });
    expect(await tools(unprepared).run('run_command', { command: 'npm test' })).toMatchObject({ status: 'refused', reason: 'shell-compatibility' });
    const disposed = provider({ failure: { ok: false, reason: 'disposed', message: 'Command not run: the agent was stopped.' } });
    expect(await tools(disposed).run('run_command', { command: 'npm test' })).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
    expect(unprepared.executed).toEqual([]);
    expect(disposed.executed).toEqual([]);
  });
});
