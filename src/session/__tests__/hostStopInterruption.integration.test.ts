import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatBackend, type FetchFn } from '../../backend/OpenAICompatBackend';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { TeamMcpBridge } from '../../mcp/TeamMcpBridge';
import type { LocalMcpServer } from '../../mcp/LocalMcpServer';
import type { AgentBackend } from '../../backend/AgentBackend';
import type { TeamTools } from '../../backend/TeamTools';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import type { AgentConfig } from '../../types';
import { REQUEST_LIMIT_STOP } from '../SessionManager';
import {
  editContract, handleOf, hostStopHarness, readContract, replacementTeam, settle, type HostStopHarness,
} from './support/hostStopHarness';

/*
 * v0.9.103 (F1): a stop the host makes (a restart, closing the window, a removal, a shutdown) ends a coordinator's
 * delegations interrupted, `host-stopped`, and replaceable with replaces_handle; the person's Stop still cancels them.
 * Module integration: the real SessionManager, TeamTools, RunLedger, TaskInputResolver and TaskClaimRegistry, and the
 * production coordinator backends (OpenAI-compatible with a scripted fetch; Claude with a fake process and its real
 * LocalMcpServer and TeamMcpBridge). Not activation-level: activation starts a real Claude CLI for a Claude agent.
 */

const replyFetch: FetchFn = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    id: 'f1-reply', choices: [{ index: 0, message: { role: 'assistant', content: 'Noted by the PM.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
});
const api = (config: AgentConfig, team: TeamTools): AgentBackend => new OpenAICompatBackend(config, replyFetch, team);

/** A Claude CLI process that never answers: the host's own state is what is under test. */
function fakeClaudeSpawn() {
  return (_cmd: string, _args: string[]) => {
    const proc = new EventEmitter() as any;
    proc.pid = 4242;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
}
const claude = (config: AgentConfig, team: TeamTools): AgentBackend => new ClaudeHeadlessBackend(config, undefined, undefined,
  { teamMcpBridge: new TeamMcpBridge(team), spawn: fakeClaudeSpawn() as never });
const claudeConfig: Partial<AgentConfig> = {
  provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5',
};

/** The Claude CLI calls a team tool on its launch's own MCP endpoint, as the real CLI does. */
async function callTeamTool(backend: AgentBackend, name: string, args: Record<string, unknown>): Promise<string> {
  const server = (backend as unknown as { localMcpServer: LocalMcpServer }).localMcpServer;
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return body.result.content[0].text;
}

const cardOf = (h: HostStopHarness, handle: string): TaskAttemptCard => h.assignmentOf(handle)!.payload.taskAttempt!;
const hostStoppedReceipt = expect.objectContaining({ interrupted: true, interruptionReason: 'host-stopped' });

const harnesses: HostStopHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.cleanup();
});
function team(options: Parameters<typeof hostStopHarness>[0]): HostStopHarness {
  const h = hostStopHarness(options);
  harnesses.push(h);
  return h;
}

describe('v0.9.103 F1: a stop the host makes interrupts a coordinator\'s delegations (module integration)', () => {
  it('3: shutdown with the teammates first: the running, inbox, checkpoint and starting-queued tasks end interrupted, stay so after a reload, are replaceable, and the queued one never starts', async () => {
    const h = team({ coordinator: api, order: ['dev', 'writer', 'pm'] });
    await h.startAll();
    // Other work already holds src/app: the edit below queues behind it.
    expect(h.claims.claim('f1-other-edit', 'elsewhere', ['src/app'], 'An edit of other work').ok).toBe(true);

    // Writer's task waits at its checkpoint for the PM's answer.
    const atCheckpoint = handleOf(await h.dispatch('writer', 'Check the glossary for the F1 release note.', readContract('Check the F1 glossary.')));
    const checkpointCard = cardOf(h, atCheckpoint);
    await h.waitAtCheckpoint('writer', checkpointCard, 'Which glossary edition for F1?');
    expect(h.manager.delegationExecution('writer', atCheckpoint).state).toBe('waiting-for-answer');

    // Dev runs one task; a second waits in Dev's inbox.
    const running = handleOf(await h.dispatch('dev', 'Summarise the F1 changelog.', readContract('Summarise the F1 changelog.')));
    const inbox = handleOf(await h.dispatch('dev', 'List the F1 release blockers.', readContract('List the F1 blockers.')));
    expect(h.manager.delegationExecution('dev', running)).toEqual({ state: 'running' });
    expect(h.manager.delegationExecution('dev', inbox)).toEqual({ state: 'queued' });
    const runningCard = cardOf(h, running);
    const inboxCard = cardOf(h, inbox);

    // The edit queues behind the overlapping claim; when that claim goes, it starts and waits at its admission boundary.
    const queuedOut = await h.dispatch('dev', 'Edit the F1 release script.', editContract('Edit the F1 release script.'));
    expect(queuedOut).toMatch(/^Queued contract /);
    const queued = handleOf(queuedOut);
    // Before it is recorded, only the coordinator's own queue knows it (read here as the precondition it is).
    const queueState = () => (h.team() as unknown as { queuedDispatches: Map<string, { state: string }> }).queuedDispatches.get(queued)?.state;
    expect(queueState()).toBe('queued');
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const begin = h.resolver.beginAttempt.bind(h.resolver);
    const queuedCards: string[] = [];
    vi.spyOn(h.resolver, 'beginAttempt').mockImplementation(async (...args) => {
      await gate;
      const attempt = await begin(...args);
      if (attempt.card) queuedCards.push(attempt.card.attemptId);
      return attempt;
    });
    h.claims.release('f1-other-edit');
    await settle();
    expect(queueState()).toBe('starting');

    // The window closes: SessionManager stops the roster in its order, the teammates before their PM.
    await h.manager.shutdown();
    proceed();
    await settle();

    // The live PM received each teammate's receipt, and each says interrupted by the host, never cancelled.
    for (const handle of [running, inbox, atCheckpoint]) {
      const receipts = h.receiptsOf(handle);
      expect(receipts, handle).toHaveLength(1);
      expect(receipts[0].payload.metadata, handle).toEqual(hostStoppedReceipt);
      expect((receipts[0].payload.metadata as { cancelled?: unknown }).cancelled, handle).toBeUndefined();
    }
    // The queued edit never started, also after its admission wait ended.
    expect(h.assignmentOf(queued)).toBeUndefined();
    expect(queueState()).toBe('interrupted');
    expect(h.claims.activeClaims()).toEqual([]);
    expect(queuedCards).toHaveLength(1);

    // Cleanup: no attempt keeps its grants, and nothing waits at a checkpoint.
    for (const [card, agent] of [[runningCard, 'dev'], [inboxCard, 'dev'], [checkpointCard, 'writer']] as const) {
      expect(h.resolver.isAttemptLive(card.attemptId, agent)).toBe(false);
    }
    expect(h.resolver.isAttemptLive(queuedCards[0], 'dev')).toBe(false);
    expect(h.manager.delegationExecution('writer', atCheckpoint).state).not.toBe('waiting-for-answer');

    // Durable, and still so in the records a new window loads.
    const all = [running, inbox, atCheckpoint, queued];
    for (const handle of all) {
      expect(h.status(handle), handle).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });
    }
    const reloaded = h.reload();
    for (const handle of all) {
      expect(reloaded.inspectTaskStatus('pm', [handle])[0], handle).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });
    }

    // Each can be replaced, and the replacement supersedes it.
    const replacing = replacementTeam(reloaded, h.root);
    for (const handle of all) {
      const out = await replacing.team.run('dispatch_task', {
        agent: 'dev', instruction: `Redo F1 task ${handle}.`, contract: readContract(`Redo F1 task ${handle}.`),
        replaces_handle: handle, replacement_reason: 'Interrupted when the window closed.',
      });
      expect(out, handle).toMatch(new RegExp(`Interrupted handle ${handle} will be superseded`));
      expect(reloaded.snapshot().flatMap((run) => run.delegations).find((row) => row.handle === handle)!.dispositions, handle)
        .toContainEqual(expect.objectContaining({ disposition: 'superseded', replacementHandle: handleOf(out) }));
    }
    replacing.team.cancelPending('f1 test cleanup');
    replacing.bus.dispose();
  });

  it('5: dispose (the window closing without a shutdown) interrupts the PM\'s running delegation; it does not cancel it', async () => {
    const h = team({ coordinator: api, order: ['pm', 'dev'] });
    await h.startAll();
    const handle = handleOf(await h.dispatch('dev', 'Collect the F1 dispose notes.', readContract('Collect the F1 dispose notes.')));
    expect(h.status(handle)).toMatchObject({ lifecycle: 'active' });

    h.manager.dispose();
    await settle();

    expect(h.status(handle)).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });
    expect(h.receiptsOf(handle).map((message) => message.payload.metadata)).toEqual([hostStoppedReceipt]);
  });

  it('6: the host\'s stop of the PM settles its task first, then stops only that exact assignment; the teammate\'s later work keeps running', async () => {
    const h = team({ coordinator: api, order: ['pm', 'dev'] });
    await h.startAll();
    const handle = handleOf(await h.dispatch('dev', 'Draft the F1 migration note.', readContract('Draft the F1 migration note.')));
    await h.waitAtCheckpoint('dev', cardOf(h, handle), 'Which F1 database version?');
    // Dev takes later work of its own: the person's direct request, running now.
    h.bus.send('user', 'dev', 'task.assign', { instruction: 'Later direct F1 work for Dev.' }, 'normal');
    await settle();
    expect(h.manager.get('dev')?.status).toBe('running');
    const later = h.manager.currentTurnCorrelationId('dev');
    expect(later).toBeDefined();

    await h.manager.restart('pm');
    await settle();

    expect(h.status(handle)).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });
    // The stop was asked for the exact handle, as an interruption, after the task was recorded interrupted.
    expect(h.stopRequests).toEqual([{ handle, interruption: true, recorded: 'interrupted' }]);
    // The teammate's own receipt for that assignment says interrupted, never cancelled.
    expect(h.receiptsOf(handle).map((message) => message.payload.metadata)).toEqual([hostStoppedReceipt]);
    // Its later work was not touched.
    expect(h.manager.get('dev')?.status).toBe('running');
    expect(h.manager.currentTurnCorrelationId('dev')).toBe(later);
    expect(h.workers.get('dev')!.stops).toBe(0);
  });

  it('8 (API): the person\'s Stop and Stop at the request limit cancel the PM\'s delegation, and replacement is refused', async () => {
    const h = team({ coordinator: api, order: ['pm', 'dev'] });
    await h.startAll();
    const stopped = handleOf(await h.dispatch('dev', 'Prepare the F1 API stop draft.', readContract('Prepare the F1 API stop draft.')));
    await h.manager.stop('pm');
    await settle();
    expect(h.status(stopped)).toMatchObject({ lifecycle: 'cancelled' });

    await h.manager.start('pm', { pin: 'take' });
    await h.manager.start('dev', { pin: 'take' });
    await settle();
    const limited = handleOf(await h.dispatch('dev', 'Prepare the F1 API limit draft.', readContract('Prepare the F1 API limit draft.')));
    expect(h.status(limited)).toMatchObject({ lifecycle: 'active' });
    h.manager.interrupt('pm', REQUEST_LIMIT_STOP);
    await settle();
    expect(h.status(limited)).toMatchObject({ lifecycle: 'cancelled' });

    await h.manager.start('pm', { pin: 'take' });
    await settle();
    for (const handle of [stopped, limited]) {
      const out = await h.dispatch('dev', `Redo F1 API ${handle}.`, readContract(`Redo F1 API ${handle}.`),
        { replaces_handle: handle, replacement_reason: 'Try again.' });
      expect(out, handle).toMatch(new RegExp(`replaces_handle must identify your durable interrupted task; ${handle} is cancelled`));
    }
  });

  it('9: a task already cancelled and a completed result keep their state through a later host restart and shutdown', async () => {
    const h = team({ coordinator: api, order: ['pm', 'dev', 'writer'] });
    await h.startAll();
    const cancelled = handleOf(await h.dispatch('dev', 'Prepare the F1 cancelled draft.', readContract('Prepare the F1 cancelled draft.')));
    expect(await h.team().run('cancel_task', { handle: cancelled })).toMatch(new RegExp(`^Cancelled ${cancelled}`));
    await settle();
    const completed = handleOf(await h.dispatch('writer', 'Write the F1 completed summary.', readContract('Write the F1 completed summary.')));
    h.workers.get('writer')!.emit({ kind: 'turn_complete', result: { text: 'The F1 completed summary.', isError: false } });
    await settle();
    expect(h.status(cancelled)).toMatchObject({ lifecycle: 'cancelled' });
    expect(h.status(completed)).toMatchObject({ lifecycle: 'settled' });

    await h.manager.restart('pm');
    await settle();
    await h.manager.shutdown();
    await settle();

    expect(h.status(cancelled)).toMatchObject({ lifecycle: 'cancelled' });
    expect(h.status(completed)).toMatchObject({ lifecycle: 'settled' });
    expect(h.status(cancelled).interruption).toBeUndefined();
    expect(h.status(completed).interruption).toBeUndefined();
  });
});

describe('v0.9.103 F1: a Claude PM (production backend, fake process, real LocalMcpServer and TeamMcpBridge; module integration)', () => {
  it('1: the host restarts a Claude PM: its bridge close interrupts the dispatch, the record survives a reload, and the new launch replaces it', async () => {
    const h = team({ coordinator: claude, order: ['pm', 'dev'], coordinatorConfig: claudeConfig });
    await h.startAll();
    const out = await callTeamTool(h.backend(), 'dispatch_task', {
      agent: 'dev', instruction: 'Write the F1 Claude summary.', contract: readContract('Write the F1 Claude summary.'),
    });
    const handle = handleOf(out);
    expect(handle, out).not.toBe('');
    await settle();
    expect(h.status(handle)).toMatchObject({ lifecycle: 'active' });

    await h.manager.restart('pm');
    await settle();

    expect(h.status(handle)).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });
    expect(h.receiptsOf(handle).map((message) => message.payload.metadata)).toEqual([hostStoppedReceipt]);
    expect(h.reload().inspectTaskStatus('pm', [handle])[0]).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });

    // The new launch, on the reloaded records, replaces it through its own endpoint; the teammate takes it up.
    expect(h.launches).toHaveLength(2);
    await h.manager.start('dev', { pin: 'take' });
    await settle();
    const replaced = await callTeamTool(h.backend(), 'dispatch_task', {
      agent: 'dev', instruction: 'Write the F1 Claude summary again.', contract: readContract('Write the F1 Claude summary again.'),
      replaces_handle: handle, replacement_reason: 'Interrupted when the PM restarted.',
    });
    expect(replaced).toMatch(new RegExp(`Interrupted handle ${handle} will be superseded`));
    await settle();
    const replacement = handleOf(replaced);
    expect(h.status(replacement)).toMatchObject({ lifecycle: 'active' });
    expect(h.delegation(handle)!.dispositions).toContainEqual(expect.objectContaining({ disposition: 'superseded', replacementHandle: replacement }));
  });

  it('8 (Claude): the person\'s Stop and Stop at the request limit cancel the Claude PM\'s delegation, and replacement is refused', async () => {
    const h = team({ coordinator: claude, order: ['pm', 'dev'], coordinatorConfig: claudeConfig });
    await h.startAll();
    const stopped = handleOf(await callTeamTool(h.backend(), 'dispatch_task', {
      agent: 'dev', instruction: 'Prepare the F1 Claude stop draft.', contract: readContract('Prepare the F1 Claude stop draft.'),
    }));
    await settle();
    await h.manager.stop('pm');
    await settle();
    expect(h.status(stopped)).toMatchObject({ lifecycle: 'cancelled' });

    await h.manager.start('pm', { pin: 'take' });
    await h.manager.start('dev', { pin: 'take' });
    await settle();
    const limited = handleOf(await callTeamTool(h.backend(), 'dispatch_task', {
      agent: 'dev', instruction: 'Prepare the F1 Claude limit draft.', contract: readContract('Prepare the F1 Claude limit draft.'),
    }));
    await settle();
    expect(h.status(limited)).toMatchObject({ lifecycle: 'active' });
    h.manager.interrupt('pm', REQUEST_LIMIT_STOP);
    await settle();
    expect(h.status(limited)).toMatchObject({ lifecycle: 'cancelled' });

    await h.manager.start('pm', { pin: 'take' });
    await settle();
    for (const handle of [stopped, limited]) {
      const out = await callTeamTool(h.backend(), 'dispatch_task', {
        agent: 'dev', instruction: `Redo F1 Claude ${handle}.`, contract: readContract(`Redo F1 Claude ${handle}.`),
        replaces_handle: handle, replacement_reason: 'Try again.',
      });
      expect(out, handle).toMatch(new RegExp(`replaces_handle must identify your durable interrupted task; ${handle} is cancelled`));
    }
  });
});
