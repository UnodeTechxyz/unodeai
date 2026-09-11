import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';

const mkTools = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-bg-'));
  const tools = new WorkspaceTools(root, new Set(['execute']), 'test', undefined, new CommandPolicy('all'));
  return { root, tools };
};

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
  it('background:true returns a handle', async () => {
    const { root, tools } = await mkTools();
    const out = await tools.runText('run_command', { command: 'echo hello', background: true });
    expect(out).toMatch(/Background command started\. ID: bg_\d+/);
    expect(out).toMatch(/check_command/);
    expect(out).toMatch(/kill_command/);
    await tools.disposeBackground();
    await rmDir(root);
  });

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
  });

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
  });

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
      undefined, undefined, undefined, undefined, exec
    );
    const out = await tools.runText('run_command', { command: 'echo x' });
    expect(calls).toEqual(['echo x']);
    expect(out).toContain('[exit 0]');
    expect(out).toContain('hi from executor');
    await rmDir(root);
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
