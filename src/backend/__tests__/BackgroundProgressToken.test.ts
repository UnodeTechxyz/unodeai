import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { OpenAICompatBackend, FetchFn } from '../OpenAICompatBackend';
import { BackendEvent } from '../AgentBackend';
import { AgentConfig } from '../../types';
import { hostToolSucceeded } from '../toolSummary';

/* v0.9.89 F7-21: a background command's progress token changes only on host-observed progress, and anti-spin
 * keys repeated polls by it, so real progress may be polled while an unchanged or forged poll still trips. */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tools(): Promise<{ root: string; tools: WorkspaceTools }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-f721-'));
  return { root, tools: new WorkspaceTools(root, new Set(['execute']), 'test', undefined, new CommandPolicy('all')) };
}

async function cleanup(root: string, workspace: WorkspaceTools): Promise<void> {
  await workspace.disposeBackground();
  for (let i = 0; i < 10; i++) {
    try { await fs.rm(root, { recursive: true, force: true }); return; } catch { await sleep(50); }
  }
}

async function token(workspace: WorkspaceTools, id: string): Promise<{ token?: string; text: string }> {
  const outcome = await workspace.run('check_command', { id });
  return { token: (outcome as { progressToken?: string }).progressToken, text: outcome.output };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 200 && !done(value); i++) {
    await sleep(15);
    value = await read();
  }
  return value;
}

describe('background command progress token', () => {
  it('changes on new output and on exit, and not on repeated polling or rendering', async () => {
    const { root, tools: workspace } = await tools();
    const start = await workspace.runText('run_command', {
      command: 'node -e "process.stdout.write(\'a\'); setTimeout(() => process.stdout.write(\'b\'), 400)"',
      background: true,
    });
    const id = start.match(/bg_\d+/)![0];
    const first = await until(() => token(workspace, id), (value) => value.text.includes('a'));
    const again = await token(workspace, id);
    if (!again.text.includes('b')) {
      // Nothing new was observed between these polls: same token.
      expect(again.token).toBe(first.token);
    }
    const exited = await until(() => token(workspace, id), (value) => value.text.includes('exited'));
    expect(exited.token).not.toBe(first.token);
    expect(exited.token).toMatch(new RegExp(`^${id}@\\d+$`));
    await cleanup(root, workspace);
  });

  it('counts stderr-only output as progress', async () => {
    const { root, tools: workspace } = await tools();
    const start = await workspace.runText('run_command', {
      command: 'node -e "setTimeout(() => process.stderr.write(\'warn\'), 100); setTimeout(() => {}, 60000)"',
      background: true,
    });
    const id = start.match(/bg_\d+/)![0];
    const before = await token(workspace, id);
    const after = await until(() => token(workspace, id), (value) => value.text.includes('warn'));
    expect(after.token).not.toBe(before.token);
    await cleanup(root, workspace);
  });

  it('does not change when a long output is only truncated again', async () => {
    const { root, tools: workspace } = await tools();
    const start = await workspace.runText('run_command', {
      command: 'node -e "process.stdout.write(\'x\'.repeat(200000)); setTimeout(() => {}, 60000)"',
      background: true,
    });
    const id = start.match(/bg_\d+/)![0];
    await until(() => token(workspace, id), (value) => value.text.length > 1000);
    await sleep(100);
    const a = await token(workspace, id);
    const b = await token(workspace, id);
    expect(b.token).toBe(a.token);
    await cleanup(root, workspace);
  });
});

function config(): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['execute'],
    workingDirectory: process.cwd(),
  };
}

function pollingModel(polls: number, extraArgs: (i: number) => Record<string, unknown> = () => ({})): FetchFn {
  let i = 0;
  return async () => {
    const n = i++;
    const body = n < polls
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: `c${n}`, type: 'function', function: { name: 'check_command', arguments: JSON.stringify({ id: 'bg_1', ...extraArgs(n) }) } },
      ] } }], usage: { prompt_tokens: 100_000, completion_tokens: 1 } }
      : { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 100_000, completion_tokens: 1 } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

async function run(backend: OpenAICompatBackend, tokenFor: (poll: number) => string): Promise<BackendEvent[]> {
  let poll = 0;
  const workspace = (backend as unknown as { tools: WorkspaceTools }).tools;
  const original = workspace.run.bind(workspace);
  (workspace as unknown as { run: WorkspaceTools['run'] }).run = (async (name: string, args: Record<string, unknown>) => {
    if (name !== 'check_command') return original(name, args);
    return { ...hostToolSucceeded(`[bg_1 running]\npoll ${poll}`), progressToken: tokenFor(poll++) };
  }) as WorkspaceTools['run'];
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  const events: BackendEvent[] = [];
  return new Promise((resolve) => {
    backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'turn_complete') resolve(events);
    });
    backend.sendUserTurn('watch the build');
  });
}

const blocked = (events: BackendEvent[]) => events.filter((event) => event.kind === 'tool_result' && event.summary === 'blocked: repeated identical call').length;

describe('Stop while a check_command is waiting', () => {
  it('ends the wait at once instead of holding the turn for the rest of it', async () => {
    const calls = [
      { name: 'run_command', args: { command: 'node -e "setTimeout(()=>{}, 60000)"', background: true } },
      { name: 'check_command', args: { id: 'bg_1', wait_seconds: 240 } },
    ];
    let request = 0;
    const model: FetchFn = async () => {
      const call = calls[request++];
      const body = call
        ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: `c${request}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
        ] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }
        : { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wait-stop-'));
    const backend = new OpenAICompatBackend({ ...config(), workingDirectory: root }, model, undefined, undefined, new CommandPolicy('all'), { retryBaseMs: 0 });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    const began = Date.now();
    const waitResult = new Promise<BackendEvent>((resolve) => {
      backend.onEvent((event) => {
        // The user presses Stop while the second call is waiting on the background command.
        if (event.kind === 'tool_use' && event.name === 'check_command') setTimeout(() => backend.abort(), 150);
        if (event.kind === 'tool_result' && event.name === 'check_command') resolve(event);
      });
    });
    backend.sendUserTurn('build it and wait');

    const result = await waitResult;
    expect(Date.now() - began).toBeLessThan(5_000);
    // The check itself succeeded: it reported the command, still running, as far as it had been observed.
    expect(result).toMatchObject({ kind: 'tool_result', name: 'check_command', outcome: { status: 'success' } });
    await backend.stop();
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; } catch { await sleep(50); }
    }
  }, 6_000);
});

describe('anti-spin with progress tokens', () => {
  it('lets a changing background command be polled more than the repeat limit', async () => {
    const backend = new OpenAICompatBackend(config(), pollingModel(8), undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await run(backend, (poll) => `bg_1@${poll + 1}`);
    expect(blocked(events)).toBe(0);
    expect(events.filter((event) => event.kind === 'tool_result' && event.outcome.status === 'success').length).toBe(8);
  });

  it('still trips the existing limit when the host token does not change', async () => {
    const backend = new OpenAICompatBackend(config(), pollingModel(8), undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await run(backend, () => 'bg_1@1');
    expect(blocked(events)).toBeGreaterThan(0);
  });

  it('cannot be evaded by a model-supplied token or extra argument', async () => {
    const backend = new OpenAICompatBackend(config(), pollingModel(8, (i) => ({ progressToken: `forged-${i}`, note: i })), undefined, undefined, undefined, { retryBaseMs: 0 });
    const events = await run(backend, () => 'bg_1@1');
    expect(blocked(events)).toBeGreaterThan(0);
  });
});
