import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import type { CommandApprovalContext, CommandApprover } from '../ShellCommandGate';
import { createDirectCommandPreparer, createDirectExecutionProvider } from '../DirectCommandExecution';
import type { CommandExecutionProvider } from '../CommandExecution';
import { BASH_SHELL } from './shellFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { modelFacingToolOutput } from '../toolSummary';

afterEach(removeTemporaryFolders);
const publish = 'npm publish --registry=https://registry.invalid';
async function host(options: { ask?: boolean; approve?: CommandApprover; beforeExecute?: () => Promise<void>; terminal?: boolean } = {}) {
  const root = await fs.realpath(await temporaryFolder('unode-outward-host-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'public-fixture', version: '1.0.0' }));
  const source = path.join(root, 'index.js'); await fs.writeFile(source, 'export const publicFixture = 1;');
  const actualEnv = Object.freeze({ ...process.env, HOME: root, USERPROFILE: root, NPM_CONFIG_USERCONFIG: path.join(root, 'no-user-npmrc') });
  const spawned: Array<{ env: unknown; command: string }> = [];
  const prepare = createDirectCommandPreparer({
    shell: () => ({ identity: BASH_SHELL, executable: '/not-a-real-shell' }), env: () => actualEnv,
    spawn: (command, settings) => {
      spawned.push({ env: settings.env, command });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0); });
      return child;
    },
  });
  const direct = createDirectExecutionProvider(prepare);
  const acquisitions: Array<{ requireEnvironment?: boolean; signal?: AbortSignal }> = [];
  const releases = vi.fn();
  const provider: CommandExecutionProvider = {
    prepareDirect: prepare,
    acquire: async opts => {
      acquisitions.push(opts);
      if (options.terminal && !opts.requireEnvironment) return {
        ok: true, shell: BASH_SHELL, transport: 'terminal', signal: opts.signal ?? new AbortController().signal,
        execute: async () => { throw new Error('the unverified terminal must not execute an outward action'); }, release: async () => { releases(); },
      };
      const lease = await direct.acquire(opts);
      if (!lease.ok) return lease;
      return { ...lease, execute: async (...args) => { await options.beforeExecute?.(); return lease.execute(...args); } };
    },
  };
  const policy = new CommandPolicy(options.ask ? 'ask' : 'all');
  const approvals: CommandApprovalContext[] = [];
  const approve: CommandApprover = async (command, context) => {
    approvals.push(context);
    return options.approve ? options.approve(command, context) : { allow: true };
  };
  const tools = new WorkspaceTools(root, new Set(['read', 'write', 'execute']), 'dev', undefined, policy, undefined,
    approve, undefined, undefined, provider);
  return { root, source, actualEnv, spawned, acquisitions, releases, tools, approvals, policy };
}

describe('outward approvals through actual WorkspaceTools and the direct execution provider', () => {
  it.each(['human', 'host', undefined] as const)('preserves only human and legacy unmarked decline notes for the model (%s)', async noteOrigin => {
    const note = 'HUMAN-OUTWARD-INSTRUCTION "use a draft"';
    const h = await host({ approve: async () => ({ allow: false, note, ...(noteOrigin ? { noteOrigin } : {}) }) });
    const result = await h.tools.run('run_command', { command: publish });
    expect(result.status).toBe('refused'); expect(result.output).not.toContain(note);
    expect(modelFacingToolOutput(result).includes(`The user said: ${JSON.stringify(note)}`)).toBe(noteOrigin !== 'host');
    expect(h.approvals).toHaveLength(1); expect(h.spawned).toEqual([]);
  });
  it.each([false, true])('asks exactly once under ordinary Ask=%s and uses the approved command and actual environment', async ask => {
    const h = await host({ ask });
    const result = await h.tools.run('run_command', { command: publish });
    expect(result).toMatchObject({ status: 'success', exitCode: 0 });
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ forcePrompt: true, singleUse: true, outward: [expect.objectContaining({
      destination: 'https://registry.invalid/', content: expect.stringContaining('public-fixture@1.0.0'),
    })] });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].command).toContain(publish);
    expect(h.spawned[0].env).toEqual(h.actualEnv);
    // A second effect is a new decision even when the text and artifact did not change.
    await h.tools.run('run_command', { command: publish });
    expect(h.approvals).toHaveLength(2); expect(h.spawned).toHaveLength(2);
  });

  it('chooses a verified direct preparation before asking, releasing the unused terminal plan without executing it', async () => {
    const h = await host({ terminal: true });
    expect(await h.tools.run('run_command', { command: publish })).toMatchObject({ status: 'success', exitCode: 0 });
    expect(h.acquisitions).toHaveLength(2);
    expect(h.acquisitions[1]).toMatchObject({ requireEnvironment: true });
    expect(h.releases).toHaveBeenCalledTimes(1);
    expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(1);
  });

  it('a denied publication produces no process and keeps the human note out of the clean display', async () => {
    const h = await host({ approve: async () => ({ allow: false, note: 'PRIVATE typed reason' }) });
    const result = await h.tools.run('run_command', { command: publish });
    expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(result.output).toContain('did not approve this outward action');
    expect(result.output).not.toContain('PRIVATE'); expect(h.spawned).toHaveLength(0);
    expect(modelFacingToolOutput(result)).toContain('The user said: "PRIVATE typed reason"');
  });

  it.each(['content', 'off-on', 'stop'] as const)('rechecks %s at the real provider final boundary, not only when the gate returns', async ending => {
    const stop = new AbortController();
    const h: Awaited<ReturnType<typeof host>> = await host({ beforeExecute: async () => {
      if (ending === 'content') await fs.writeFile(h.source, 'export const publicFixture = 2;');
      if (ending === 'off-on') { h.policy.reload('none', []); h.policy.reload('all', []); }
      if (ending === 'stop') stop.abort();
    } });
    const result = await h.tools.run('run_command', { command: publish }, { signal: stop.signal });
    expect(h.acquisitions[0].signal).toBe(stop.signal);
    expect(result.status).not.toBe('success');
    if (ending === 'content') { expect(result).toMatchObject({ status: 'refused', reason: 'safety-limit' }); expect(result.output).toContain('Command not run: the approved working folder, destination or proposed content changed'); expect(result.output).not.toContain('the person stopped it'); }
    if (ending === 'off-on') expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    if (ending === 'stop') expect(result).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
    expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(0);
  });

  it('unresolved publication asks once with an unknown-effect disclosure and continues under that exact approval', async () => {
    const h = await host();
    const result = await h.tools.run('run_command', { command: 'cargo publish' });
    expect(result).toMatchObject({ status: 'success' });
    expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ outward: [], outwardUnknownReason: expect.any(String), cwd: h.root, forcePrompt: true, singleUse: true });
  });

  it('Off remains Off before execution preparation and preserves the actual Commands navigation', async () => {
    const h = await host(); h.policy.reload('none', []);
    const result = await h.tools.run('run_command', { command: publish });
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(result.output).toContain('Team > Permissions > Commands');
    expect(result.output).toContain('3. In User settings, choose all or ask.');
    expect(h.acquisitions).toHaveLength(0); expect(h.approvals).toHaveLength(0); expect(h.spawned).toHaveLength(0);
  });

  it.each(['npm install', 'git fetch origin', 'git pull', 'npm publish --dry-run'])('adds no outward question for %s', async command => {
    const h = await host();
    expect(await h.tools.run('run_command', { command })).toMatchObject({ status: 'success', exitCode: 0 });
    expect(h.approvals).toHaveLength(0); expect(h.spawned).toHaveLength(1);
  });

  it('a cancelled background preparation cannot start after the human answer', async () => {
    const stop = new AbortController();
    const h = await host({ approve: async () => { stop.abort(); return { allow: true }; } });
    const result = await h.tools.run('run_command', { command: publish, background: true }, { signal: stop.signal });
    expect(result.status).not.toBe('success'); expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(0);
  });

  it('an approved background publication binds the actual environment and starts once', async () => {
    const h = await host();
    const result = await h.tools.run('run_command', { command: publish, background: true });
    expect(result).toMatchObject({ status: 'success' }); expect(result.output).toContain('Background command started');
    expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(1);
    // The card shows what the actual environment prepares, as for a foreground command, not an uncertainty.
    expect(h.approvals[0]).toMatchObject({ forcePrompt: true, singleUse: true, outward: [expect.objectContaining({
      destination: 'https://registry.invalid/', content: expect.stringContaining('public-fixture@1.0.0'),
    })] });
    expect(h.approvals[0].outwardUnknownReason).toBeUndefined();
    expect(h.spawned[0]).toEqual({ command: publish, env: h.actualEnv });
    await h.tools.disposeBackground();
  });

  it('a background cancellation immediately after async revalidation still prevents the synchronous spawn', async () => {
    for (let repeat = 0; repeat < 25; repeat++) {
      const h = await host(); const stop = new AbortController();
      const actual = (h.tools as any).commandEffectCheck.bind(h.tools);
      (h.tools as any).commandEffectCheck = (...args: unknown[]) => async () => {
        const result = await actual(...args)();
        queueMicrotask(() => stop.abort());
        return result;
      };
      const result = await h.tools.run('run_command', { command: publish, background: true }, { signal: stop.signal });
      expect(result).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
      expect(h.approvals).toHaveLength(1); expect(h.spawned).toHaveLength(0);
    }
  }, 30_000);

  it('a held request limit retires the call on its signal without later preparing or starting it', async () => {
    for (let repeat = 0; repeat < 25; repeat++) {
      const h = await host(); const stop = new AbortController();
      let release!: (answer: 'proceed') => void, entered!: () => void, observedSignal: AbortSignal | undefined;
      const held = new Promise<'proceed'>(done => { release = done; });
      const observed = new Promise<void>(done => { entered = done; });
      h.tools.setRequestBoundary(async (_kind, detail) => { observedSignal = detail?.signal; entered(); return held; });
      const result = h.tools.run('run_command', { command: publish }, { signal: stop.signal });
      await observed; expect(observedSignal).toBe(stop.signal); stop.abort();
      expect(await result).toMatchObject({ status: 'refused', reason: 'safety-limit' });
      release('proceed'); await Promise.resolve();
      expect(h.acquisitions).toHaveLength(0); expect(h.approvals).toHaveLength(0); expect(h.spawned).toHaveLength(0);
    }
  });
});
