/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Managed integrations at an agent's start (v0.9.99)
 *
 *  An agent's granted UnodeAi-managed integrations are optional to its start. Each one mounts on its own: the
 *  start waits a short while for those still connecting, so a server that is merely starting up is offered from
 *  the first turn, and then goes ahead without the ones that are not ready. Nothing here fails a start, opens a
 *  dialog or waits for an answer. A server that is still connecting keeps connecting in the background; the
 *  caller names the missing ones to the person and offers a Retry that does not hold anything.
 *
 *  The mount itself (its approval, its program, its connection) is the caller's: this module only decides how long
 *  the start waits and what it reports. vscode-free, so it is tested with the real lease and wait primitives.
 *--------------------------------------------------------------------------------------------*/

import type { MCPServerConfig } from '../types';
import type { SharedOperationLease } from './SharedOperationLeases';

export type ManagedMountOutcome = 'mounted' | 'skipped' | 'error';

/** One granted integration the agent starts without. */
export interface UnavailableIntegration {
  id: string;
  name: string;
  /** Why it is not available, in plain words; never a path, a secret or a command line. */
  reason: string;
  /** It was still connecting when the start went ahead, and keeps connecting in the background. */
  stillConnecting: boolean;
}

export interface ManagedIntegrationStartDeps {
  isRegistered(id: string): boolean;
  config(id: string): MCPServerConfig | undefined;
  /** Join or start the one shared mount of this server. Releasing the last lease of a mount cancels it. */
  acquireMount(config: MCPServerConfig): SharedOperationLease<ManagedMountOutcome>;
  /** Wait for `pending` for at most `timeoutMs`, counted as this agent's wait on the server's mount. */
  waitAs<T>(key: string, sessionId: string, pending: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }>;
  /** Keep a mount the start stopped waiting for going, on a lease of its own. Called before the start's lease ends. */
  continueInBackground(config: MCPServerConfig): void;
  /** The last mount failure of this server, in plain words, if one was recorded. */
  mountDetail(id: string): string | undefined;
  now(): number;
}

/**
 * Mount every granted server that is not mounted yet, side by side, and wait for them until `waitMs` has passed
 * from the call. Returns the integrations the agent starts without, in the order granted. Never throws for an
 * integration; the start goes ahead in every case.
 */
export async function prepareManagedIntegrationsForStart(
  sessionId: string,
  serverIds: readonly string[],
  waitMs: number,
  deps: ManagedIntegrationStartDeps,
): Promise<UnavailableIntegration[]> {
  const deadline = deps.now() + Math.max(0, waitMs);
  const results = await Promise.all(serverIds.map(async (id): Promise<UnavailableIntegration | undefined> => {
    if (deps.isRegistered(id)) return undefined;
    const config = deps.config(id);
    if (!config) return { id, name: id, reason: 'its saved configuration is missing', stillConnecting: false };
    const lease = deps.acquireMount(config);
    let waited: { timedOut: false; value: ManagedMountOutcome } | { timedOut: true };
    try {
      waited = await deps.waitAs(config.id, sessionId, lease.promise, Math.max(0, deadline - deps.now()));
      // Still connecting: the start goes ahead, and the mount keeps going on a lease of its own, taken before this
      // start's lease ends so the mount is not cancelled in between.
      if (waited.timedOut) deps.continueInBackground(config);
    } catch {
      // A mount that throws is reported as not connected; it never fails the start.
      waited = { timedOut: false, value: 'error' };
    } finally {
      lease.release();
    }
    if (!waited.timedOut && waited.value === 'mounted' && deps.isRegistered(id)) return undefined;
    return waited.timedOut
      ? { id, name: config.name, reason: 'it is still connecting', stillConnecting: true }
      : { id, name: config.name, reason: deps.mountDetail(id) ?? 'it did not connect', stillConnecting: false };
  }));
  return results.filter((item): item is UnavailableIntegration => item !== undefined);
}

/**
 * The chat line for an agent that started without some of its integrations: what happened and the one thing the
 * person can do. `toolsFollowLive`: the agent's route offers newly connected tools from its next request; the
 * Claude Code and Codex routes take their tool list at start.
 */
export function unavailableIntegrationsNotice(unavailable: readonly UnavailableIntegration[], toolsFollowLive: boolean): string {
  const names = unavailable.map((item) => `${item.name} (${item.reason})`).join('; ');
  const still = unavailable.some((item) => item.stillConnecting);
  const failed = unavailable.some((item) => !item.stillConnecting);
  const plural = unavailable.length > 1;
  const sentences = [`Started without ${plural ? 'these integrations' : 'this integration'}: ${names}. `
    + `${plural ? 'Their' : 'Its'} tools are not available to this agent yet.`];
  const offered = toolsFollowLive
    ? 'the tools are offered from the next request once connected'
    : 'restart the agent once connected to give it the tools';
  if (still) sentences.push(`UnodeAi keeps connecting; ${offered}.`);
  if (failed) sentences.push(`For one that did not connect, fix the problem and choose Retry in the UnodeAi notification; ${offered}.`);
  return sentences.join(' ');
}
