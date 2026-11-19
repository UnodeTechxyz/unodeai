import { describe, it, expect } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { MessageBus } from '../../bus/MessageBus';
import { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';

// F3: the send_message tool lets an agent message a teammate (or broadcast) over the team bus.
// Capability-gated by the 'message' token; degrades safely when no bus is wired.
describe('WorkspaceTools send_message (F3)', () => {
  const root = process.cwd();

  it('only exposes send_message when the "message" token is granted', () => {
    const without = new WorkspaceTools(root, new Set(['read']));
    expect(without.specs().some((s) => s.function.name === 'send_message')).toBe(false);

    const withMsg = new WorkspaceTools(root, new Set(['read', 'message']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    expect(withMsg.specs().some((s) => s.function.name === 'send_message')).toBe(true);
  });

  it('sends a directed message to a teammate over the bus', async () => {
    const bus = new MessageBus();
    const received: Message[] = [];
    bus.onAddressed('bob', (m) => received.push(m));

    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, bus);
    const out = await tools.runText('send_message', { target: 'bob', message: 'ship it' });

    expect(out).toMatch(/sent to "bob"/i);
    expect(received).toHaveLength(1);
    expect(received[0].from).toBe('alice');
    expect(received[0].to).toBe('bob');
    expect(received[0].type).toBe('agent.message');
    expect(received[0].payload.message).toBe('ship it');
  });

  it('broadcasts to all teammates with target "*"', async () => {
    const bus = new MessageBus();
    const seen: Message[] = [];
    bus.onType('agent.message', (m) => seen.push(m));

    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, bus);
    const out = await tools.runText('send_message', { target: '*', message: 'standup in 5' });

    expect(out).toMatch(/broadcast/i);
    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe('*');
    expect(seen[0].payload.message).toBe('standup in 5');
  });

  it('errors (does not throw) when no bus is configured', async () => {
    const tools = new WorkspaceTools(root, new Set(['message']), 'alice');
    const out = await tools.runText('send_message', { target: 'bob', message: 'hi' });
    expect(out).toMatch(/not available/i);
  });

  it('refuses send_message without the message token even if invoked directly', async () => {
    const tools = new WorkspaceTools(root, new Set(['read']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    const result = await tools.run('send_message', { target: 'bob', message: 'hi' });
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
  });

  it('validates target and message are present', async () => {
    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    expect(await tools.runText('send_message', { target: '', message: 'hi' })).toMatch(/target is required/i);
    expect(await tools.runText('send_message', { target: 'bob', message: '' })).toMatch(/message is required/i);
  });
});

/**
 * v0.9.103 slice 1 (design §4 G1): during a delegated task, a send_message to the task's own coordinator is bound by the
 * host to that live attempt. Attempt, handle and event id are the host's; the model names the target, text and kind.
 */
describe('WorkspaceTools send_message bound to the live task (v0.9.103 G1)', () => {
  const root = process.cwd();

  async function liveTask(options: { handle?: string } = { handle: 'handle-a' }) {
    const resolver = new TaskInputResolver(new ContentAssetStore(), root);
    const contract = compileTaskContract({
      version: 1, objective: 'Write the summary.', effects: { read_files: [], expected_file_effect: 'none' }, inputs: [],
      required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
    }, 'pm').contract!;
    const card = (await resolver.beginAttempt(contract, {
      agentId: 'dev', capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn',
      verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
    }, 'pm')).card!;
    if (options.handle) resolver.bindAttemptHandle(card.attemptId, options.handle);
    const bus = new MessageBus();
    const sent: Message[] = [];
    bus.onType('agent.message', (message) => { sent.push(message); });
    // The team: every agent of it receives what is addressed to it (SessionManager subscribes each one).
    for (const member of ['pm', 'dev', 'tester']) bus.onAddressed(member, () => undefined);
    const tools = new WorkspaceTools(root, new Set(['message']), 'dev', undefined, undefined, undefined, undefined, bus);
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setTaskAttempt(card);
    return { resolver, card, tools, sent };
  }

  it('binds a message to the coordinator to the attempt and handle the host holds, with a host event id', async () => {
    const { card, tools, sent } = await liveTask();
    const out = await tools.runText('send_message', { target: 'pm', message: 'Which format?', kind: 'question' });
    // v0.9.103 slice 2: the answer comes back into the task; the teammate may end its turn waiting for it.
    expect(out).toBe('Sent to your coordinator as a question on this task. Its answer comes back into this task. Meanwhile do '
      + 'what does not depend on it; if you cannot go on without it, end your turn saying what you wait for: the task stays '
      + 'open and continues with the answer.');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'dev', to: 'pm', correlationId: 'handle-a', payload: { message: 'Which format?' } });
    expect(sent[0].payload.metadata).toEqual({ taskMessage: {
      attemptId: card.attemptId, handle: 'handle-a', kind: 'question', eventId: expect.stringMatching(/^task-message-[0-9a-f-]{36}$/) } });
    // Text only (§5.3): no instruction, scope, attempt card, files or sources ride on it.
    expect(Object.keys(sent[0].payload).sort()).toEqual(['message', 'metadata']);
  });

  it('resolves the target "coordinator" to the coordinator of the live task', async () => {
    const { tools, sent } = await liveTask();
    expect(await tools.runText('send_message', { target: 'coordinator', message: 'Half done.' }))
      .toBe('Sent to your coordinator as a note on this task. No answer is expected: carry on with the task.');
    expect(sent[0]).toMatchObject({ to: 'pm', correlationId: 'handle-a' });
    expect((sent[0].payload.metadata as { taskMessage: { kind: string } }).taskMessage.kind).toBe('note');
  });

  it('takes nothing of the identity from the model: a handle, attempt, request or metadata it supplies is ignored', async () => {
    const { card, tools, sent } = await liveTask();
    await tools.runText('send_message', {
      target: 'pm', message: 'Done soon.', kind: 'note', handle: 'handle-forged', attemptId: 'attempt-forged',
      request_id: 'request-forged', eventId: 'task-message-forged', metadata: { taskMessage: { handle: 'handle-forged' } },
    });
    expect(sent[0].correlationId).toBe('handle-a');
    const claim = (sent[0].payload.metadata as { taskMessage: Record<string, string> }).taskMessage;
    expect(claim).toMatchObject({ attemptId: card.attemptId, handle: 'handle-a', kind: 'note' });
    expect(claim.eventId).not.toBe('task-message-forged');
    expect(JSON.stringify(sent[0].payload)).not.toContain('forged');
  });

  it('gives each message its own event id', async () => {
    const { tools, sent } = await liveTask();
    await tools.runText('send_message', { target: 'pm', message: 'One.' });
    await tools.runText('send_message', { target: 'pm', message: 'Two.' });
    const ids = sent.map((message) => (message.payload.metadata as { taskMessage: { eventId: string } }).taskMessage.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a kind other than note, question or blocker, and sends nothing', async () => {
    const { tools, sent } = await liveTask();
    expect(await tools.runText('send_message', { target: 'pm', message: 'Hurry.', kind: 'urgent' }))
      .toBe('Error: kind must be note, question or blocker.');
    expect(await tools.runText('send_message', { target: 'bob', message: 'Hurry.', kind: 7 }))
      .toBe('Error: kind must be note, question or blocker.');
    expect(sent).toEqual([]);
    for (const kind of ['note', 'question', 'blocker']) {
      await tools.runText('send_message', { target: 'pm', message: `A ${kind}.`, kind });
    }
    expect(sent.map((message) => (message.payload.metadata as { taskMessage: { kind: string } }).taskMessage.kind))
      .toEqual(['note', 'question', 'blocker']);
  });

  it('keeps today\'s message to anyone other than the coordinator, and a broadcast, unbound', async () => {
    const { tools, sent } = await liveTask();
    expect(await tools.runText('send_message', { target: 'tester', message: 'Check A.', kind: 'question' })).toBe('Message sent to "tester".');
    expect(await tools.runText('send_message', { target: '*', message: 'FYI.' })).toBe('Message broadcast to all teammates.');
    expect(sent.map((message) => ({ to: message.to, correlationId: message.correlationId, payload: message.payload }))).toEqual([
      { to: 'tester', correlationId: undefined, payload: { message: 'Check A.' } },
      { to: '*', correlationId: undefined, payload: { message: 'FYI.' } },
    ]);
  });

  it('binds nothing once the attempt has ended, before it has a handle, or outside a task', async () => {
    const ended = await liveTask();
    ended.resolver.endAttempt(ended.card.attemptId, 'settled');
    expect(await ended.tools.runText('send_message', { target: 'pm', message: 'Late.' })).toBe('Message sent to "pm".');
    expect(ended.sent[0].payload.metadata).toBeUndefined();

    const unbound = await liveTask({});
    expect(await unbound.tools.runText('send_message', { target: 'pm', message: 'Early.' })).toBe('Message sent to "pm".');
    expect(unbound.sent[0].payload.metadata).toBeUndefined();

    const outside = await liveTask();
    outside.tools.beginTurn();
    expect(await outside.tools.runText('send_message', { target: 'pm', message: 'Direct.' })).toBe('Message sent to "pm".');
    expect(outside.sent[0].payload.metadata).toBeUndefined();
  });

  // v0.9.103 (audit I1): a rework turn has no attempt card; the host's turn thread still names its coordinator.
  it('binds a message to "coordinator" in a turn with no attempt card to the thread the host says the turn is on', async () => {
    const { resolver, tools, sent } = await liveTask();
    resolver.setTurnThreadSource((agentId) => (agentId === 'dev' ? { coordinatorId: 'pm', handle: 'handle-a' } : undefined));
    tools.beginTurn();
    // v0.9.103 slice 2 (audit I1): no answer can come back into a rework turn; the receipt says so and says what to do.
    expect(await tools.runText('send_message', { target: 'coordinator', message: 'Should the totals include tax?', kind: 'question' }))
      .toBe('Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer does not come '
        + 'back into this turn: finish what you can, and if you need the answer, end your turn saying exactly what you need; '
        + 'the PM can send the task back to you with it.');
    expect(sent[0]).toMatchObject({ from: 'dev', to: 'pm', correlationId: 'handle-a' });
    expect(sent[0].payload.metadata).toEqual({ taskMessage: { handle: 'handle-a', kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
  });

  it('refuses "coordinator" when it names no one, and an id no teammate has, and sends nothing', async () => {
    const { resolver, card, tools, sent } = await liveTask();
    resolver.setTurnThreadSource(() => undefined);
    tools.beginTurn();
    expect(await tools.runText('send_message', { target: 'coordinator', message: 'Anyone?' }))
      .toBe('Error: nothing was sent. "coordinator" names the coordinator of a task you are working on, and this turn is on none. '
        + 'Name the recipient by its agent id.');
    expect(await tools.runText('send_message', { target: 'project-manager', message: 'Anyone?' }))
      .toBe('Error: nothing was sent. No teammate on this team has the id "project-manager". Name the recipient by its agent id.');
    // An attempt that has ended names no coordinator either.
    tools.setTaskAttempt(card);
    resolver.endAttempt(card.attemptId, 'settled');
    expect(await tools.runText('send_message', { target: 'coordinator', message: 'Late.' })).toMatch(/^Error: nothing was sent\./);
    expect(sent).toEqual([]);
  });

  it('tells the model about kind and asks for no content-free acknowledgements', () => {
    const tools = new WorkspaceTools(root, new Set(['message']), 'dev', undefined, undefined, undefined, undefined, new MessageBus());
    const spec = tools.specs().find((s) => s.function.name === 'send_message')!.function;
    expect(spec.description).toContain('target "coordinator" (or its id) reaches the coordinator that assigned it');
    expect(spec.description).toContain('no acknowledgements such as "got it" or "thanks"');
    const params = spec.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(params.properties.kind.enum).toEqual(['note', 'question', 'blocker']);
    expect(params.required).toEqual(['target', 'message']);
  });
});
