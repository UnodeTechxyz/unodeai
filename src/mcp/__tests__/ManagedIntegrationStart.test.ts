import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../types';
import { SharedOperationLeases } from '../SharedOperationLeases';
import { SharedPromptWaits } from '../../session/SharedPromptWaits';
import {
  prepareManagedIntegrationsForStart,
  unavailableIntegrationsNotice,
  type ManagedIntegrationStartDeps,
  type ManagedMountOutcome,
} from '../ManagedIntegrationStart';

// v0.9.99 (A8): granted integrations mount on their own and never hold or fail an agent's start. The start waits for
// those still connecting for a bounded while, then goes ahead without them; a slow one keeps connecting in the
// background, and one that is down is reported, not fatal. Driven through the real shared lease and wait primitives.

const server = (id: string): MCPServerConfig => ({ id, name: id.toUpperCase(), transport: 'stdio', command: 'npx' });

function host(mounts: Record<string, (signal: AbortSignal) => Promise<ManagedMountOutcome>>) {
  const leases = new SharedOperationLeases<string, ManagedMountOutcome>();
  const waits = new SharedPromptWaits({ approvalStarted: () => undefined, approvalFinished: () => undefined });
  const registered = new Set<string>();
  const details = new Map<string, string>();
  const aborted: string[] = [];
  const background: Array<Promise<ManagedMountOutcome>> = [];
  const mount = (cfg: MCPServerConfig) => leases.acquire(cfg.id, async (signal) => {
    signal.addEventListener('abort', () => aborted.push(cfg.id), { once: true });
    const outcome = await mounts[cfg.id](signal);
    if (outcome === 'mounted' && !signal.aborted) registered.add(cfg.id);
    return outcome;
  });
  const deps: ManagedIntegrationStartDeps = {
    isRegistered: (id) => registered.has(id),
    config: (id) => (id in mounts ? server(id) : undefined),
    acquireMount: mount,
    waitAs: (key, sessionId, pending, timeoutMs) => waits.waitAs(key, sessionId, pending, timeoutMs),
    continueInBackground: (cfg) => {
      const lease = mount(cfg);
      background.push(lease.promise.finally(() => lease.release()));
    },
    mountDetail: (id) => details.get(id),
    now: () => Date.now(),
  };
  return { deps, registered, details, aborted, background };
}

afterEach(() => { vi.useRealTimers(); });

describe('managed integrations at an agent start (v0.9.99, A8)', () => {
  it('goes ahead without a slow server after the wait, keeps it connecting, and mounts the fast one', async () => {
    vi.useFakeTimers();
    let finishSlow!: (outcome: ManagedMountOutcome) => void;
    const { deps, registered, aborted, background } = host({
      fast: async () => 'mounted',
      slow: () => new Promise<ManagedMountOutcome>((resolve) => { finishSlow = resolve; }),
    });
    let settled = false;
    const start = prepareManagedIntegrationsForStart('agent-1', ['fast', 'slow'], 45_000, deps)
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const unavailable = await start;
    expect(unavailable).toEqual([{ id: 'slow', name: 'SLOW', reason: 'it is still connecting', stillConnecting: true }]);
    expect(registered.has('fast')).toBe(true);
    // The slow mount was not cancelled when the start stopped waiting: it finishes in the background.
    expect(aborted).toEqual([]);
    finishSlow('mounted');
    await expect(background[0]).resolves.toBe('mounted');
    expect(registered.has('slow')).toBe(true);
  });

  it('never fails the start for a server that is down or misconfigured, and names why', async () => {
    const { deps, details } = host({ down: async () => 'error' });
    details.set('down', 'the command "uvx" is not installed');
    const unavailable = await prepareManagedIntegrationsForStart('agent-1', ['down', 'gone'], 45_000, deps);
    expect(unavailable).toEqual([
      { id: 'down', name: 'DOWN', reason: 'the command "uvx" is not installed', stillConnecting: false },
      { id: 'gone', name: 'gone', reason: 'its saved configuration is missing', stillConnecting: false },
    ]);
  });

  it('waits for nothing when every grant is already mounted', async () => {
    const { deps, registered } = host({ ready: async () => { throw new Error('must not mount again'); } });
    registered.add('ready');
    await expect(prepareManagedIntegrationsForStart('agent-1', ['ready'], 45_000, deps)).resolves.toEqual([]);
  });

  it('mounts servers side by side: a slow one does not delay a fast one past its own answer', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { deps } = host({
      slow: () => new Promise<ManagedMountOutcome>((resolve) => setTimeout(() => { order.push('slow'); resolve('mounted'); }, 30_000)),
      fast: () => new Promise<ManagedMountOutcome>((resolve) => setTimeout(() => { order.push('fast'); resolve('mounted'); }, 10)),
    });
    const start = prepareManagedIntegrationsForStart('agent-1', ['slow', 'fast'], 45_000, deps);
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(['fast']);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(start).resolves.toEqual([]);
  });

  it('says what happened and the one next step, without claiming the tools are mounted', () => {
    const slow = { id: 'gh', name: 'GitHub', reason: 'it is still connecting', stillConnecting: true };
    const down = { id: 'db', name: 'Postgres', reason: 'it did not connect', stillConnecting: false };
    expect(unavailableIntegrationsNotice([slow], true)).toBe('Started without this integration: GitHub (it is still '
      + 'connecting). Its tools are not available to this agent yet. UnodeAi keeps connecting; the tools are offered from '
      + 'the next request once connected.');
    const cli = unavailableIntegrationsNotice([slow, down], false);
    expect(cli).toContain('Started without these integrations: GitHub (it is still connecting); Postgres (it did not connect).');
    expect(cli).toContain('restart the agent once connected to give it the tools');
    expect(cli).toContain('choose Retry in the UnodeAi notification');
    expect(cli).not.toMatch(/mounted|quarantin|admission/i);
  });
});
