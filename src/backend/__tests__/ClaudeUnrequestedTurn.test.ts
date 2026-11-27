import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import type { LocalJsonEndpoint, LocalMcpServer, LocalMcpTool } from '../../mcp/LocalMcpServer';
import { MessageBus } from '../../bus/MessageBus';
import { CommandPolicy } from '../CommandPolicy';
import { PROBE_SUMMARY, probeCli, probeTask, type ProbeCli, type ProbeTask } from './claudeBackgroundWakeTrace';

/*
 * v0.9.103 (F2, the Owner's option A): a Claude CLI's background task finishes after the host's turn ended, and the CLI
 * begins a turn of its own. The production ClaudeHeadlessBackend with a fake process is fed the native probe's sequence
 * (ids rewritten); its PreToolUse gate is called as the CLI's hook calls it. A shell call that reaches the normal command
 * gate is allowed by policy `all`; one inside the unrequested turn is refused because the ended request's boundary stays
 * aborted.
 */

const REQUEST_ENDED = 'The request ended before this command. Nothing was run.';
const FOLDED_NOTICE = 'This reply was produced in a turn the agent had begun on its own for a background result. '
  + 'Its reported usage includes that earlier work.';
const wakeNotice = (summary: string) => `Claude Dev: something it started in the background finished after your request ended (${summary}). `
  + 'It can read files in that turn but cannot run commands or change files. To let it act on the result, press Continue in the '
  + 'notification, or send it a message.';

function config(dir: string): AgentConfig {
  return {
    id: 'claude-wake', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-haiku-5-5', systemPrompt: 'Follow the role.', autoApprove: true,
    allowedTools: ['read', 'write', 'execute'], backend: 'claude', workingDirectory: dir,
  };
}

type FakeServer = LocalMcpServer & { localTools: LocalMcpTool[]; jsonEndpoints: LocalJsonEndpoint[] };

function fakeLocalServer(): FakeServer {
  return {
    port: 48123, token: 'test-token', localTools: [], jsonEndpoints: [],
    addLocalTool(tool) { this.localTools.push(tool); },
    addJsonEndpoint(endpoint) { this.jsonEndpoints.push(endpoint); },
    observeToolOutcomes() { /* not read here */ },
    async start() { /* nothing listens */ },
    async stop() { /* nothing to close */ },
  } as FakeServer;
}

function fakeSpawn() {
  return () => {
    const proc = new EventEmitter() as any;
    proc.pid = 4242;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  backend: ClaudeHeadlessBackend;
  cli: ProbeCli;
  proc: any;
  events: BackendEvent[];
  writes: any[];
  feed(...lines: unknown[]): Promise<void>;
  hook(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<{ allow: boolean; reason?: string }>;
  completions(): Array<Extract<BackendEvent, { kind: 'turn_complete' }>>;
  wakes(): Array<Extract<BackendEvent, { kind: 'unrequested_turn' }>>;
  notices(): string[];
  requests(): number;
  /** The person's request: written now. Returns its packet. */
  send(text: string): any;
  /** One whole host turn of the probe: the person's request, the background Bash call, STARTED, the result. */
  backgroundRequest(text: string, task: ProbeTask): Promise<any>;
}

async function harness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-wake-'));
  const gate = fakeLocalServer();
  const backend = new ClaudeHeadlessBackend(config(dir), undefined, undefined, {
    spawn: fakeSpawn() as any,
    toolGateServerFactory: () => gate,
    toolBridgeServerFactory: () => fakeLocalServer(),
    localMcpServerFactory: () => fakeLocalServer(),
    messageBus: new MessageBus(),
    commandPermission: { policy: new CommandPolicy('all') },
    requestToolApproval: async () => ({ allow: true }),
    webAccess: { policy: () => 'allow', requestApproval: async () => ({ allow: true }) },
  });
  cleanups.push(async () => {
    await backend.stop(50).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const events: BackendEvent[] = [];
  backend.onEvent((event) => events.push(event));
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  const proc = (backend as any).proc;
  const writes: any[] = [];
  proc.stdin.write = (line: string) => { writes.push(JSON.parse(line)); return true; };
  const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
  expect(route).toBeDefined();
  const cli = probeCli(`s-${path.basename(dir)}`);
  const feed = async (...lines: unknown[]) => {
    for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
    await (backend as any).eventChain;
  };
  const h: Harness = {
    backend, cli, proc, events, writes, feed,
    hook: (tool_name, tool_input, tool_use_id) => route.handler({ tool_name, tool_input, tool_use_id }) as Promise<{ allow: boolean; reason?: string }>,
    completions: () => events.filter((event): event is Extract<BackendEvent, { kind: 'turn_complete' }> => event.kind === 'turn_complete'),
    wakes: () => events.filter((event): event is Extract<BackendEvent, { kind: 'unrequested_turn' }> => event.kind === 'unrequested_turn'),
    notices: () => events.filter((event) => event.kind === 'runtime_notice').map((event) => (event as { text: string }).text),
    requests: () => events.filter((event) => event.kind === 'model_request').length,
    send: (text: string) => {
      const before = writes.length;
      backend.sendUserTurn(text);
      expect(writes).toHaveLength(before + 1);
      return writes[before];
    },
    backgroundRequest: async (text: string, task: ProbeTask) => {
      const packet = h.send(text);
      const completed = h.completions().length;
      await feed(...cli.backgroundTurn(packet.uuid, packet.message.content, task));
      expect(h.completions()).toHaveLength(completed + 1);
      return packet;
    },
  };
  return h;
}

/** The CLI runs a Bash call: the assistant tool_use, then the PreToolUse hook. Returns the gate's answer. */
async function shellCall(h: Harness, toolUseId: string, command: string): Promise<{ allow: boolean; reason?: string }> {
  await h.feed(h.cli.bash(toolUseId, command, `Run ${command}`));
  return h.hook('Bash', { command, description: `Run ${command}` }, toolUseId);
}

describe('v0.9.103 F2: a Claude CLI turn nobody requested (native probe sequence)', () => {
  it('1: after the request ended, the notification and the next init give one notice and one started event with the probe\'s summary, then one ended; the wake completes nothing', async () => {
    const h = await harness();
    const task = probeTask('t1a');
    await h.backgroundRequest('Start the background job, t1.', task);
    const requests = h.requests();

    await h.feed(...h.cli.finishes(task));
    // The notification alone says nothing yet.
    expect(h.wakes()).toEqual([]);
    const beforeWake = h.events.length;
    await h.feed(...h.cli.wakeStarts());
    expect(h.wakes()).toEqual([{ kind: 'unrequested_turn', phase: 'started', taskId: task.taskId, summary: PROBE_SUMMARY }]);
    expect(h.notices()).toEqual([wakeNotice(PROBE_SUMMARY)]);
    // The notice comes before the event the host offers Continue on.
    const noticeAt = h.events.findIndex((event) => event.kind === 'runtime_notice');
    expect(noticeAt).toBeLessThan(h.events.findIndex((event) => event.kind === 'unrequested_turn'));

    await h.feed(...h.cli.wakeReplies('The background command finished with exit code 0, t1.'));
    await h.feed(h.cli.wakeEnds('The background command finished with exit code 0, t1.', task));
    expect(h.wakes()).toEqual([
      { kind: 'unrequested_turn', phase: 'started', taskId: task.taskId, summary: PROBE_SUMMARY },
      { kind: 'unrequested_turn', phase: 'ended', usage: expect.objectContaining({ costUsd: expect.closeTo(0.0005, 10), usageBasis: 'reported' }) },
    ]);
    expect(h.completions()).toHaveLength(1);
    // The wake's own text is shown once, apart from any request, when the wake ends; nothing of it is turn output.
    expect(h.notices()).toEqual([wakeNotice(PROBE_SUMMARY),
      'Claude Dev, in a turn it began on its own: The background command finished with exit code 0, t1.']);
    expect(h.events.slice(beforeWake).some((event) => event.kind === 'assistant' || event.kind === 'assistant_delta' || event.kind === 'tool_use')).toBe(false);
    expect(h.requests()).toBe(requests);
  });

  it('2: a shell call inside the unrequested turn is refused with the existing text before the wake\'s result', async () => {
    const h = await harness();
    const task = probeTask('t2a');
    await h.backgroundRequest('Start the background job, t2.', task);
    await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started']);

    expect(await shellCall(h, 'toolu_wake_t2', 'echo wake-t2')).toEqual({ allow: false, reason: REQUEST_ENDED });
    // Refused while the unrequested turn still runs: its result has not come.
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started']);

    await h.feed(h.cli.toolResult('toolu_wake_t2', REQUEST_ENDED, true), h.cli.text('Could not run it, t2.'), h.cli.wakeEnds('Could not run it, t2.', task));
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
    expect(h.completions()).toHaveLength(1);
  });

  describe('3: what is not an unrequested turn', () => {
    it('3a: a start-up init with no notification before it gives no notice, also after a request ended', async () => {
      const h = await harness();
      // The CLI's own start-up init, before any request.
      await h.feed(h.cli.init(), h.cli.requesting());
      expect(h.wakes()).toEqual([]);
      const task = probeTask('t3a');
      await h.backgroundRequest('Start the background job, t3a.', task);
      // An init with no host turn open and no notification before it (a restart or a stray init).
      await h.feed(h.cli.init(), h.cli.requesting());
      expect(h.wakes()).toEqual([]);
      expect(h.notices()).toEqual([]);
    });

    it('3b: a duplicate init within one wake gives one notice and one started event', async () => {
      const h = await harness();
      const task = probeTask('t3b');
      await h.backgroundRequest('Start the background job, t3b.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts(), h.cli.init(), h.cli.requesting());
      expect(h.wakes()).toEqual([{ kind: 'unrequested_turn', phase: 'started', taskId: task.taskId, summary: PROBE_SUMMARY }]);
      expect(h.notices()).toHaveLength(1);
      await h.feed(h.cli.text('Done, t3b.'), h.cli.wakeEnds('Done, t3b.', task));
      expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
    });

    it('3c: a notification during an open host turn gives no notice, neither in that turn nor at a later init', async () => {
      const h = await harness();
      const task = probeTask('t3c');
      const packet = h.send('Start and wait for the background job, t3c.');
      await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
      // The task finishes inside the host's turn: the CLI handles it in that turn.
      await h.feed(...h.cli.finishes(task), h.cli.text('It finished, t3c.'), h.cli.result('It finished, t3c.', { userMessageUuid: packet.uuid }));
      expect(h.completions()).toHaveLength(1);
      await h.feed(h.cli.init(), h.cli.requesting(), h.cli.text('Stray, t3c.'), h.cli.result('Stray, t3c.'));
      expect(h.wakes()).toEqual([]);
      expect(h.notices()).toEqual([]);
      expect(h.completions()).toHaveLength(1);
    });

    it('3d: a held steer segment (result held for an unread steer, then the steer\'s own init) gives no notice', async () => {
      const h = await harness();
      const task = probeTask('t3d');
      const packet = h.send('Run the steps, t3d.');
      await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
      expect(h.backend.interject('Also end with PINEAPPLE, t3d.')).toBe(true);
      const steer = h.writes.at(-1);
      // The result arrives before the steer is read: held, the host turn stays open.
      await h.feed(h.cli.text('First part, t3d.'), h.cli.result('First part, t3d.', { userMessageUuid: packet.uuid }));
      expect(h.completions()).toEqual([]);
      expect(h.events.filter((event) => event.kind === 'reply_segment_held')).toHaveLength(1);
      // A background task finishes in the held span, then the steer's CLI turn starts with its own init.
      await h.feed(...h.cli.finishes(task), h.cli.init([steer.uuid]), h.cli.requesting([steer.uuid]), h.cli.replay(steer.uuid, steer.message.content));
      expect(h.wakes()).toEqual([]);
      await h.feed(h.cli.text('Second part. PINEAPPLE, t3d.'), h.cli.result('Second part. PINEAPPLE, t3d.', { userMessageUuid: steer.uuid }));
      expect(h.completions()).toHaveLength(1);
      expect(h.wakes()).toEqual([]);
      expect(h.notices()).toEqual([]);
    });

    it('3e: a notification inside a /compact control turn raises nothing, and the next request is not held', async () => {
      const h = await harness();
      const task = probeTask('t3e');
      await h.backgroundRequest('Start the background job, t3e.', task);
      const settled: unknown[] = [];
      const compaction = h.backend.contextControl!.compact({
        usage: { requestStarted: () => 'unit-t3e', requestSettled: (_unit: string, usage: unknown) => { settled.push(usage); } },
      } as any);
      expect(h.writes.at(-1)).toEqual({ type: 'user', message: { role: 'user', content: '/compact' } });
      // Every event until the control turn's result is the control turn's, the notification and an init included.
      await h.feed(
        { type: 'system', subtype: 'status', status: 'compacting', session_id: h.cli.sessionId },
        ...h.cli.finishes(task), h.cli.init(), h.cli.requesting(),
        { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: h.cli.sessionId },
        h.cli.result(''),
      );
      expect(await compaction).toMatchObject({ kind: 'compacted' });
      expect(h.wakes()).toEqual([]);
      expect(h.notices()).toEqual([]);
      // Nothing is held: the next request opens as it is written, and its result completes it without a read.
      const requests = h.requests();
      h.send('After the compaction, t3e.');
      expect(h.requests()).toBe(requests + 1);
      await h.feed(h.cli.text('Done after compaction, t3e.'), h.cli.result('Done after compaction, t3e.'));
      expect(h.completions()).toHaveLength(2);
      expect(h.completions()[1].result.text).toBe('Done after compaction, t3e.');
    });

    it('3f: a notification before a /compact control turn raises no notice inside it; the next request then waits only for its read', async () => {
      const h = await harness();
      const task = probeTask('t3f');
      await h.backgroundRequest('Start the background job, t3f.', task);
      await h.feed(...h.cli.finishes(task));
      const compaction = h.backend.contextControl!.compact({ usage: { requestStarted: () => 'unit-t3f', requestSettled: () => undefined } } as any);
      await h.feed(
        { type: 'system', subtype: 'status', status: 'compacting', session_id: h.cli.sessionId },
        h.cli.init(), h.cli.requesting(),
        { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: h.cli.sessionId },
        h.cli.result(''),
      );
      expect(await compaction).toMatchObject({ kind: 'compacted' });
      expect(h.wakes()).toEqual([]);
      expect(h.notices()).toEqual([]);
      // The stale marker holds the request only until the CLI reads it; the read opens it at once.
      const requests = h.requests();
      const packet = h.send('After the compaction, t3f.');
      await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
      expect(h.requests()).toBe(requests + 1);
      expect(await shellCall(h, 'toolu_t3f', 'echo after-compaction-t3f')).toEqual({ allow: true });
      await h.feed(h.cli.text('Done, t3f.'), h.cli.result('Done, t3f.', { userMessageUuid: packet.uuid }));
      expect(h.completions()).toHaveLength(2);
      expect(h.wakes()).toEqual([]);
    });
  });

  it('3g: two successive wakes give two notices and two started/ended pairs', async () => {
    const h = await harness();
    const first = probeTask('t3g1');
    const second = probeTask('t3g2', 'Background command "Run sleep 30 then echo second" completed (exit code 0)', 'Run sleep 30 then echo second');
    await h.backgroundRequest('Start two background jobs, t3g.', first);
    await h.feed(...h.cli.finishes(first), ...h.cli.wakeStarts(), ...h.cli.wakeReplies('First finished, t3g.'), h.cli.wakeEnds('First finished, t3g.', first));
    await h.feed(...h.cli.finishes(second), ...h.cli.wakeStarts(), ...h.cli.wakeReplies('Second finished, t3g.'), h.cli.wakeEnds('Second finished, t3g.', second));
    expect(h.wakes()).toEqual([
      { kind: 'unrequested_turn', phase: 'started', taskId: first.taskId, summary: first.summary },
      { kind: 'unrequested_turn', phase: 'ended', usage: expect.objectContaining({ costUsd: expect.closeTo(0.0005, 10), usageBasis: 'reported' }) },
      { kind: 'unrequested_turn', phase: 'started', taskId: second.taskId, summary: second.summary },
      { kind: 'unrequested_turn', phase: 'ended', usage: expect.objectContaining({ costUsd: expect.closeTo(0.0005, 10), usageBasis: 'reported' }) },
    ]);
    expect(h.notices().filter((text) => !text.includes(', in a turn it began on its own: '))).toEqual([wakeNotice(first.summary), wakeNotice(second.summary)]);
    expect(h.completions()).toHaveLength(1);
  });

  it('4: a Send between the notification and the wake\'s init is written but not opened; the wake\'s tool is refused and its result completes nothing; the read opens the request, whose shell reaches the gate and whose result completes it once', async () => {
    const h = await harness();
    const task = probeTask('t4a');
    await h.backgroundRequest('Start the background job, t4.', task);
    await h.feed(...h.cli.finishes(task));
    const requests = h.requests();

    // The person's message: written to the CLI at once, not opened.
    const packet = h.send('What did the background job print, t4?');
    expect(packet).toEqual({ type: 'user', uuid: expect.any(String), message: { role: 'user', content: expect.stringContaining('What did the background job print, t4?') } });
    expect(h.requests()).toBe(requests);
    await h.feed(h.cli.lifecycle(packet.uuid, 'queued'));
    expect(h.requests()).toBe(requests);

    // The CLI runs its own turn first: the notice, and its shell call is refused under the ended request's boundary.
    await h.feed(...h.cli.wakeStarts());
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started']);
    expect(await shellCall(h, 'toolu_wake_t4', 'echo wake-t4')).toEqual({ allow: false, reason: REQUEST_ENDED });
    await h.feed(h.cli.toolResult('toolu_wake_t4', REQUEST_ENDED, true), ...h.cli.wakeReplies('Wake done, t4.'), h.cli.wakeEnds('Wake done, t4.', task));
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
    expect(h.completions()).toHaveLength(1);
    expect(h.requests()).toBe(requests);

    // The CLI reads our packet: the request opens, once.
    await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
    expect(h.requests()).toBe(requests + 1);
    expect(await shellCall(h, 'toolu_req_t4', 'echo request-t4')).toEqual({ allow: true });
    await h.feed(h.cli.toolResult('toolu_req_t4', 'request-t4'), h.cli.text('It printed BACKGROUND-DONE, t4.'),
      h.cli.result('It printed BACKGROUND-DONE, t4.', { userMessageUuid: packet.uuid }), h.cli.lifecycle(packet.uuid, 'completed'));
    expect(h.completions()).toHaveLength(2);
    expect(h.completions()[1].result).toMatchObject({ text: 'It printed BACKGROUND-DONE, t4.', isError: false });
    expect(h.notices().filter((text) => text === FOLDED_NOTICE)).toEqual([]);
    expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
  });

  it('4 stale: a notification with no CLI turn after it; the Send waits only for its read, which opens the request at once', async () => {
    const h = await harness();
    const task = probeTask('t4s');
    await h.backgroundRequest('Start the background job, t4s.', task);
    await h.feed(...h.cli.finishes(task));
    const requests = h.requests();
    const packet = h.send('Anything new, t4s?');
    expect(h.requests()).toBe(requests);
    // No wake follows: the CLI reads our packet next (lifecycle started comes before its init, as in the probe).
    await h.feed(h.cli.lifecycle(packet.uuid, 'queued'), ...h.cli.reads(packet.uuid, packet.message.content));
    expect(h.requests()).toBe(requests + 1);
    expect(h.wakes()).toEqual([]);
    expect(h.notices()).toEqual([]);
    expect(await shellCall(h, 'toolu_req_t4s', 'echo stale-t4s')).toEqual({ allow: true });
    await h.feed(h.cli.text('Nothing new, t4s.'), h.cli.result('Nothing new, t4s.', { userMessageUuid: packet.uuid }));
    expect(h.completions()).toHaveLength(2);
    expect(h.completions()[1].result.text).toBe('Nothing new, t4s.');
    // The marker was cleared at the read: the next request opens as it is written.
    h.send('And the next one, t4s.');
    expect(h.requests()).toBe(requests + 2);
  });

  describe('5: both provider orders of a person\'s message during the wake', () => {
    it('5a after-result: written at once; the wake\'s shell is refused; its result completes nothing; the read opens the request; its shell reaches the gate; the next result completes it', async () => {
      const h = await harness();
      const task = probeTask('t5a');
      await h.backgroundRequest('Start the background job, t5a.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
      const requests = h.requests();

      // 1. The message arrives during the wake and is written at once.
      const writes = h.writes.length;
      const packet = h.send('Continue with the result, t5a.');
      expect(h.writes).toHaveLength(writes + 1);
      expect(h.requests()).toBe(requests);
      // 2. A wake shell call is refused.
      expect(await shellCall(h, 'toolu_wake_t5a', 'echo wake-t5a')).toEqual({ allow: false, reason: REQUEST_ENDED });
      // 3. The wake's result: no request completes.
      await h.feed(h.cli.toolResult('toolu_wake_t5a', REQUEST_ENDED, true), h.cli.text('Wake done, t5a.'), h.cli.wakeEnds('Wake done, t5a.', task, 0.0003));
      expect(h.completions()).toHaveLength(1);
      expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
      // Codex's audit of 6b332fa3, finding 1: the wake's own usage goes out with its end (its own receipt).
      expect((h.wakes()[1] as any).usage).toMatchObject({ outputTokens: expect.any(Number), usageBasis: 'reported' });
      expect((h.wakes()[1] as any).usage.costUsd).toBeCloseTo(0.0003, 10);
      // 4. Our replay is read: the request opens.
      await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
      expect(h.requests()).toBe(requests + 1);
      // 5. A shell call reaches the normal command gate.
      expect(await shellCall(h, 'toolu_req_t5a', 'echo request-t5a')).toEqual({ allow: true });
      // 6. The next result completes the request.
      await h.feed(h.cli.toolResult('toolu_req_t5a', 'request-t5a'), h.cli.text('Finished, t5a.'), h.cli.result('Finished, t5a.', { userMessageUuid: packet.uuid, cost: 0.0007 }));
      expect(h.completions()).toHaveLength(2);
      expect(h.completions()[1].result).toMatchObject({ text: 'Finished, t5a.', isError: false });
      // Only the request's own cost: none of the wake's.
      expect(h.completions()[1].result.usage.costUsd).toBeCloseTo(0.0007, 10);
      expect(h.notices().filter((text) => text === FOLDED_NOTICE)).toEqual([]);
      // Nothing of the wake is left: the next request opens as it is written.
      h.send('Next request, t5a.');
      expect(h.requests()).toBe(requests + 2);
    });

    it('5b folded: read inside the wake\'s CLI turn; the pre-read shell is refused, the post-read shell reaches the gate; that result completes the request once with the folded-usage notice', async () => {
      const h = await harness();
      const task = probeTask('t5b');
      await h.backgroundRequest('Start the background job, t5b.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
      const requests = h.requests();

      // 1. Written at once.
      const packet = h.send('Continue with the result, t5b.');
      expect(h.requests()).toBe(requests);
      await h.feed(h.cli.lifecycle(packet.uuid, 'queued'));
      // 2. A wake shell call, decided before the read, is refused.
      expect(await shellCall(h, 'toolu_wake_t5b', 'echo wake-t5b')).toEqual({ allow: false, reason: REQUEST_ENDED });
      await h.feed(h.cli.toolResult('toolu_wake_t5b', REQUEST_ENDED, true));
      // 3. The CLI reads our packet between model requests of the same CLI turn: the request opens, the wake ends.
      await h.feed(h.cli.lifecycle(packet.uuid, 'started'), h.cli.replay(packet.uuid, packet.message.content));
      expect(h.requests()).toBe(requests + 1);
      expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
      // 4. A later shell call in that same CLI turn reaches the normal gate.
      expect(await shellCall(h, 'toolu_req_t5b', 'echo request-t5b')).toEqual({ allow: true });
      await h.feed(h.cli.toolResult('toolu_req_t5b', 'request-t5b'), h.cli.text('Finished, t5b.'));
      expect(h.completions()).toHaveLength(1);
      // 5. That CLI turn's result completes the request, with the note on its usage before the completion.
      const result = h.cli.result('Finished, t5b.', { wakeRunId: task.runId, cost: 0.0009 });
      await h.feed(result);
      // The folded wake carries no usage of its own: its one CLI result is the request's, combined, with the notice.
      expect((h.wakes()[1] as any).usage).toBeUndefined();
      expect(h.completions()[1].result.usage.costUsd).toBeCloseTo(0.0009, 10);
      expect(h.completions()).toHaveLength(2);
      const completion = h.completions()[1].result;
      expect(completion).toMatchObject({ text: 'Finished, t5b.', isError: false });
      const reported = result.usage;
      expect(completion.usage).toMatchObject({
        inputTokens: reported.input_tokens + reported.cache_creation_input_tokens + reported.cache_read_input_tokens,
        outputTokens: reported.output_tokens, usageBasis: 'reported',
      });
      expect(h.notices().filter((text) => text === FOLDED_NOTICE)).toHaveLength(1);
      const noticeAt = h.events.findIndex((event) => event.kind === 'runtime_notice' && event.text === FOLDED_NOTICE);
      expect(noticeAt).toBeLessThan(h.events.lastIndexOf(h.completions()[1]));
      // 6. No second request completion follows.
      await h.feed(h.cli.lifecycle(packet.uuid, 'completed'));
      expect(h.completions()).toHaveLength(2);
      expect(h.wakes().map((wake) => wake.phase)).toEqual(['started', 'ended']);
    });

    it('5c duplicate acknowledgement: lifecycle started and the replay of our uuid open the request once', async () => {
      const h = await harness();
      const task = probeTask('t5c');
      await h.backgroundRequest('Start the background job, t5c.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
      const packet = h.send('Continue, t5c.');
      await h.feed(h.cli.text('Wake, t5c.'), h.cli.wakeEnds('Wake, t5c.', task));
      const requests = h.requests();
      await h.feed(h.cli.lifecycle(packet.uuid, 'started'));
      expect(h.requests()).toBe(requests + 1);
      await h.feed(h.cli.init([packet.uuid]), h.cli.replay(packet.uuid, packet.message.content), h.cli.lifecycle(packet.uuid, 'started'),
        h.cli.replay(packet.uuid, packet.message.content));
      expect(h.requests()).toBe(requests + 1);
      expect(await shellCall(h, 'toolu_req_t5c', 'echo request-t5c')).toEqual({ allow: true });
      await h.feed(h.cli.text('Done, t5c.'), h.cli.result('Done, t5c.', { userMessageUuid: packet.uuid }));
      expect(h.completions()).toHaveLength(2);
      expect(h.completions()[1].result.text).toBe('Done, t5c.');
    });

    it('5d an acknowledgement of an unknown or an older uuid opens nothing', async () => {
      const h = await harness();
      const task = probeTask('t5d');
      const first = await h.backgroundRequest('Start the background job, t5d.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
      const packet = h.send('Continue, t5d.');
      const requests = h.requests();
      await h.feed(h.cli.lifecycle('not-our-packet-t5d', 'started'), h.cli.replay('not-our-packet-t5d', 'x'),
        h.cli.lifecycle(first.uuid, 'started'), h.cli.replay(first.uuid, first.message.content));
      expect(h.requests()).toBe(requests);
      // Still the unrequested turn: its shell call is refused, and its result completes nothing.
      expect(await shellCall(h, 'toolu_wake_t5d', 'echo wake-t5d')).toEqual({ allow: false, reason: REQUEST_ENDED });
      await h.feed(h.cli.toolResult('toolu_wake_t5d', REQUEST_ENDED, true), h.cli.text('Wake, t5d.'), h.cli.wakeEnds('Wake, t5d.', task));
      expect(h.completions()).toHaveLength(1);
      // Only our packet's read opens the request.
      await h.feed(...h.cli.reads(packet.uuid, packet.message.content));
      expect(h.requests()).toBe(requests + 1);
    });

    it('5e exit while held: the backend forgets the held request and emits no completion of its own', async () => {
      const h = await harness();
      const task = probeTask('t5e');
      await h.backgroundRequest('Start the background job, t5e.', task);
      await h.feed(...h.cli.finishes(task), ...h.cli.wakeStarts());
      h.send('Continue, t5e.');
      expect((h.backend as any).heldRequest).toBeDefined();
      h.proc.exitCode = 1;
      h.proc.emit('exit', 1);
      await (h.backend as any).eventChain;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.events.filter((event) => event.kind === 'exit')).toHaveLength(1);
      expect(h.completions()).toHaveLength(1);
      expect((h.backend as any).heldRequest).toBeUndefined();
      expect((h.backend as any).pendingWake).toBeUndefined();
      expect((h.backend as any).unrequestedTurn).toBeUndefined();
      expect((h.backend as any).turnOpen).toBe(false);
    });
  });
});
