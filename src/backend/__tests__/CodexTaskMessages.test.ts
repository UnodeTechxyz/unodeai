/*
 * v0.9.103 (CLI teammate messages, design DESIGN_v09103_cli_teammate_messages_2026-11-14 §2 C2, §3 tests 5-8 and 14):
 * a Codex CLI teammate reaches the host's `send_message` as an App Server dynamic tool. Production CodexBackend, a
 * real MessageBus and a real TaskInputResolver; the App Server is a fake that answers the start-up checks and records
 * what the backend sends. Nothing launches a binary or a model.
 */
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend, type CodexBackendDeps } from '../CodexBackend';
import { sendMessageToolSpec, WorkspaceTools } from '../WorkspaceTools';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import type { AgentConfig, Message } from '../../types';
import type { ConversationSnapshot } from '../AgentBackend';
import { REQUEST_LIMIT_STOPPED_REFUSAL, type RequestBoundary, type RequestBoundaryDetail, type RequestBoundaryOutcome } from '../requestBoundary';
import { fixedCodexProgram } from './codexProgramFixture';
import { candidateFor, incrementalContract } from './checkpointFixtures';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const SETTLED = { timeout: 10_000, interval: 5 };

const MESSAGING_TOOLS = ['read', 'write', 'execute', 'message'];
const NOT_AVAILABLE = 'send_message is not available to this agent.';
/** v0.9.103 D2 (a), the Owner: what a conversation started before send_message is told, in its turns and at a call. */
const OLD_CONVERSATION = 'This existing Codex conversation started before UnodeAi offered send_message, so you cannot message your '
  + 'coordinator in it. If you need a decision on a task, end your turn saying exactly what you need. A new model '
  + 'conversation for this agent offers the tool.';
const turnInputs = (t: { fake: { clientMessages: any[] } }): string[] =>
  t.fake.clientMessages.filter((message) => message.method === 'turn/start')
    .map((message) => (message.params.input as Array<{ text?: string }>).map((item) => item.text ?? '').join('\n'));
const messagingNotices = (t: { events: any[] }): any[] =>
  t.events.filter((event) => event.kind === 'runtime_notice' && String(event.text).includes('before teammates could ask the PM'));
const ATTEMPT_QUESTION_RECEIPT = 'Sent to your coordinator as a question on this task. Its answer comes back into this task. '
  + 'Meanwhile do what does not depend on it; if you cannot go on without it, end your turn saying what you wait for: the task '
  + 'stays open and continues with the answer.';
const REWORK_QUESTION_RECEIPT = 'Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer '
  + 'does not come back into this turn: finish what you can, and if you need the answer, end your turn saying exactly what you '
  + 'need; the PM can send the task back to you with it.';

function config(allowedTools: string[]): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Dev', role: 'developer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Work.', autoApprove: true, allowedTools, backend: 'codex', workingDirectory: process.cwd(),
  };
}

function savedThread(item: Record<string, unknown>): ConversationSnapshot {
  return { version: 3, backend: 'codex', hostTurnState: 'complete', messages: [item] };
}

/** Just enough App Server: the start-up checks answered from the host's own argv, one thread, one turn id. */
function fakeAppServer() {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const clientMessages: any[] = [];
  const responses: any[] = [];
  let proc: any;
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const spawn = (_command: string, args: string[]) => {
    proc = new EventEmitter();
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          if (!line) continue;
          const message = JSON.parse(line);
          clientMessages.push(message);
          const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
          if (message.method === 'initialize') reply({ userAgent: 'fake' });
          else if (message.method === 'config/read') reply({
            config: {
              model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
              approval_policy: setting(args, 'approval_policy'), approvals_reviewer: setting(args, 'approvals_reviewer'),
              sandbox_mode: setting(args, 'sandbox_mode'),
              sandbox_workspace_write: { network_access: setting(args, 'sandbox_workspace_write.network_access') === true },
              apps: { _default: {
                default_tools_approval_mode: setting(args, 'apps._default.default_tools_approval_mode'),
                approvals_reviewer: setting(args, 'apps._default.approvals_reviewer'),
              } },
            },
            origins: {}, layers: [],
          });
          else if (message.method === 'model/list') reply({ data: [] });
          else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
          else if (message.method === 'skills/list') reply({ data: [] });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') reply({
            thread: { id: 'thread-1' }, cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy,
            approvalsReviewer: message.params.approvalsReviewer, modelProvider: message.params.modelProvider,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            sandbox: message.params.sandbox === 'read-only'
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          });
          else if (message.method === 'turn/start') reply({ turn: { id: 'turn-1', status: 'inProgress' } });
          else if (message.id !== undefined && !message.method) responses.push(message);
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  return {
    spawn: spawn as any,
    clientMessages,
    responses,
    notify(method: string, params: unknown) { emit({ jsonrpc: '2.0', method, params }); },
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: id, namespace: null, tool, arguments: args } });
    },
  };
}

interface Asked { detail?: RequestBoundaryDetail; answer(outcome: RequestBoundaryOutcome): void }

function heldBoundary() {
  const asked: Asked[] = [];
  const boundary: RequestBoundary = (_kind, detail) => new Promise((resolve) => { asked.push({ detail, answer: resolve }); });
  return { boundary, asked };
}

/** A Codex teammate, its bus (with what it carries) and the resolver of its tasks. Started unless `start: false`. */
async function teammate(options: {
  allowedTools?: string[]; bus?: boolean; requestBoundary?: RequestBoundary; restore?: ConversationSnapshot;
  deps?: Partial<CodexBackendDeps>; start?: boolean;
} = {}) {
  const store = new ContentAssetStore();
  const resolver = new TaskInputResolver(store, process.cwd());
  const bus = options.bus === false ? undefined : new MessageBus();
  const sent: Message[] = [];
  bus?.onType('agent.message', (message) => { sent.push(message); });
  for (const member of ['pm', 'codex-1']) bus?.onAddressed(member, () => undefined);
  const fake = fakeAppServer();
  const resets: string[] = [];
  const backend = new CodexBackend(config(options.allowedTools ?? MESSAGING_TOOLS), undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    spawn: fake.spawn,
    access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [process.cwd()] }),
    requestApproval: async () => ({ allow: false }),
    killProcessTree: async () => undefined,
    taskInputResolver: resolver,
    onConversationReset: (message) => resets.push(message),
    ...(bus ? { messageBus: bus } : {}),
    ...(options.requestBoundary ? { requestBoundary: options.requestBoundary } : {}),
    ...options.deps,
  });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  if (options.restore) backend.restore(options.restore);
  if (options.start !== false) await backend.start({ PATH: 'safe' }, { pin: 'take' });
  const cleanup = async () => { await backend.stop(); await store.dispose(); bus?.dispose(); };
  return { backend, fake, bus, sent, resolver, resets, events, cleanup };
}

type Teammate = Awaited<ReturnType<typeof teammate>>;

/** A live attempt of codex-1 for the coordinator `pm`, bound to `handle`. */
async function liveAttempt(t: Teammate, handle: string) {
  const card = (await t.resolver.beginAttempt(incrementalContract(), candidateFor(t.resolver, 'codex-1'), 'pm')).card!;
  t.resolver.bindAttemptHandle(card.attemptId, handle);
  return card;
}

async function turn(t: Teammate, instruction: string, attachments?: Record<string, unknown>): Promise<void> {
  const starts = t.fake.clientMessages.filter((message) => message.method === 'turn/start').length;
  t.backend.sendUserTurn(instruction, attachments as any);
  await vi.waitFor(() => {
    expect(t.fake.clientMessages.filter((message) => message.method === 'turn/start')).toHaveLength(starts + 1);
    expect((t.backend as any).turnId).toBe('turn-1');
  }, SETTLED);
}

async function completeTurn(t: Teammate, text: string): Promise<void> {
  const done = t.events.filter((event) => event.kind === 'turn_complete').length;
  t.fake.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: text });
  t.fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  await vi.waitFor(() => expect(t.events.filter((event) => event.kind === 'turn_complete')).toHaveLength(done + 1), SETTLED);
}

async function answer(t: Teammate, id: string): Promise<any> {
  return vi.waitFor(() => {
    const response = t.fake.responses.find((candidate) => candidate.id === id);
    expect(response).toBeDefined();
    return response;
  }, SETTLED);
}

const offered = (t: Teammate): string[] =>
  (t.fake.clientMessages.find((message) => message.method === 'thread/start')?.params.dynamicTools ?? []).map((tool: any) => tool.name);

const savedSignature = (t: Teammate): Record<string, unknown> =>
  JSON.parse(String((t.backend.snapshot()?.messages[0] as { codexDynamicTools?: unknown }).codexDynamicTools));

const completeSnapshot = (t: Teammate): ConversationSnapshot =>
  ({ ...t.backend.snapshot()!, version: 3, backend: 'codex', hostTurnState: 'complete' });

describe('Codex send_message is offered under the one predicate (v0.9.103 C2a)', () => {
  // Design §3 test 5: advertised at thread/start with 'message' and a bus.
  it('advertises send_message at thread/start when the role may message and a bus is set', async () => {
    const t = await teammate();
    try {
      await turn(t, 'test five offered');
      expect(offered(t)).toContain('send_message');
      expect(savedSignature(t)).toMatchObject({ taskMessages: true });
    } finally { await t.cleanup(); }
  });

  // Design §3 test 5 (preserved half): no 'message' in the role, no tool.
  it('does not advertise send_message without the message tool', async () => {
    const t = await teammate({ allowedTools: ['read', 'write', 'execute'] });
    try {
      await turn(t, 'test five without message');
      expect(t.fake.clientMessages.some((message) => message.method === 'thread/start')).toBe(true);
      expect(offered(t)).not.toContain('send_message');
    } finally { await t.cleanup(); }
  });

  // Design §3 test 5 (preserved half): no bus, no tool.
  it('does not advertise send_message without a bus', async () => {
    const t = await teammate({ bus: false });
    try {
      await turn(t, 'test five without bus');
      expect(t.fake.clientMessages.some((message) => message.method === 'thread/start')).toBe(true);
      expect(offered(t)).not.toContain('send_message');
    } finally { await t.cleanup(); }
  });
});

describe('Codex send_message is bound to the live attempt (v0.9.103 C2a)', () => {
  // Design §3 test 6: one bound agent.message, the attempt-bound receipt.
  it('sends exactly one message bound to the host attempt and handle, and returns the attempt-bound receipt', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-test-6');
      await turn(t, 'test six bound', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test six: which currency?', kind: 'question' }, 'six-1');
      const response = await answer(t, 'six-1');
      expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toBe(ATTEMPT_QUESTION_RECEIPT);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ from: 'codex-1', to: 'pm', type: 'agent.message', correlationId: 'handle-test-6',
        payload: { message: 'Test six: which currency?' } });
      expect(t.sent[0].payload.metadata).toEqual({ taskMessage: {
        attemptId: card.attemptId, handle: 'handle-test-6', kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
      expect(t.events.find((event) => event.kind === 'tool_result' && event.name === 'send_message')?.outcome)
        .toMatchObject({ status: 'success' });
    } finally { await t.cleanup(); }
  });

  // Design §3 test 6 (refusal half): the predicate is false without 'message'; nothing is sent.
  it('refuses a call without the message tool and sends nothing', async () => {
    const t = await teammate({ allowedTools: ['read', 'write', 'execute'] });
    try {
      const card = await liveAttempt(t, 'handle-test-6-no-message');
      await turn(t, 'test six refused without message', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test six refused: no message tool.', kind: 'question' }, 'six-2');
      const response = await answer(t, 'six-2');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain(NOT_AVAILABLE);
      expect(t.sent).toEqual([]);
      expect(t.events.find((event) => event.kind === 'tool_result' && event.name === 'send_message')?.outcome)
        .toMatchObject({ status: 'refused', reason: 'capability' });
    } finally { await t.cleanup(); }
  });

  // Design §3 test 6 (refusal half): the predicate is false without a bus.
  it('refuses a call without a bus', async () => {
    const t = await teammate({ bus: false });
    try {
      const card = await liveAttempt(t, 'handle-test-6-no-bus');
      await turn(t, 'test six refused without bus', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test six refused: no bus.', kind: 'note' }, 'six-3');
      const response = await answer(t, 'six-3');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain(NOT_AVAILABLE);
    } finally { await t.cleanup(); }
  });
});

describe('Codex send_message held at the request boundary (v0.9.103 turn lifetime)', () => {
  // Design §3 test 7: a normally released hold sends exactly one; the boundary is asked for send_message (an effect).
  it('sends exactly one message when a held call is released normally', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7-release');
      await turn(t, 'test seven release', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven released.', kind: 'question' }, 'seven-1');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      expect(asked[0].detail?.tool).toBe('send_message');
      expect(t.sent).toEqual([]);
      asked[0].answer('proceed');
      const response = await answer(t, 'seven-1');
      expect(response.result.success).toBe(true);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ correlationId: 'handle-test-7-release', payload: { message: 'Test seven released.' } });
    } finally { await t.cleanup(); }
  });

  // Design §3 test 7: an interrupt aborts the controller while the call is held; a later proceed sends nothing.
  it('sends nothing when the turn is interrupted while the call is held and the boundary then says proceed', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7-interrupt');
      await turn(t, 'test seven interrupt', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven interrupted.', kind: 'question' }, 'seven-2');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      t.backend.abort();
      expect(asked[0].detail?.signal?.aborted).toBe(true);
      asked[0].answer('proceed');
      const response = await answer(t, 'seven-2');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toBe(REQUEST_LIMIT_STOPPED_REFUSAL);
      for (let i = 0; i < 5; i++) await tick();
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // Design §3 test 7: Stop aborts the controller while the call is held; a later proceed sends nothing.
  it('sends nothing when the agent is stopped while the call is held and the boundary then says proceed', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7-stop');
      await turn(t, 'test seven stop', { taskAttempt: card });
      // Called the way the transport calls it, without the transport's reply: after Stop there is no App Server to
      // answer (as in CodexRequestBoundary.test.ts).
      const running: Promise<any> = (t.backend as any).dynamicToolCall({ threadId: 'thread-1', turnId: 'turn-1', callId: 'seven-3',
        namespace: null, tool: 'send_message', arguments: { target: 'coordinator', message: 'Test seven stopped.', kind: 'blocker' } });
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      await t.backend.stop();
      expect(asked[0].detail?.signal?.aborted).toBe(true);
      asked[0].answer('proceed');
      expect(await running).toEqual({ success: false, contentItems: [{ type: 'inputText', text: REQUEST_LIMIT_STOPPED_REFUSAL }] });
      for (let i = 0; i < 10; i++) await tick();
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // v0.9.103 (the Owner: fix in 0.9.103): through the transport, a call held at Stop is answered after its App Server
  // ended. The answer has nowhere to go: it is logged, never an unhandled rejection, and nothing is sent.
  it('logs, and does not reject unhandled, when a call held at Stop is answered after the App Server ended', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const card = await liveAttempt(t, 'handle-test-7-transport-stop');
      await turn(t, 'test seven transport stop', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven transport stop.', kind: 'blocker' }, 'seven-ts');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      await t.backend.stop();
      asked[0].answer('proceed');
      for (let i = 0; i < 20; i++) await tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(t.events.some((event) => event.kind === 'log' && String(event.line).startsWith('Codex App Server request item/tool/call was not answered: '))).toBe(true);
      expect(t.sent).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await t.cleanup();
    }
  });

  // Design §3 test 7 (signal forwarding): a call that arrives after the interrupt, in the still-open turn, whose
  // boundary then says proceed, is refused by the cancelled signal and sends nothing.
  it('sends nothing for a call that arrives after an interrupt and is let through by the boundary', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7-late');
      await turn(t, 'test seven late call', { taskAttempt: card });
      t.backend.abort();
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven after the interrupt.', kind: 'question' }, 'seven-4');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      asked[0].answer('proceed');
      const response = await answer(t, 'seven-4');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain('nothing was sent');
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // Design §3 test 7b: the turn completes normally while the call is held; released with no new turn, nothing is sent.
  it('sends nothing for a call held across the normal end of its turn, and says the turn has ended', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7b');
      await turn(t, 'test seven-b stale turn', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven-b held past its turn.', kind: 'question' }, 'seven-b-1');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      await completeTurn(t, 'Test seven-b turn done.');
      // Normal completion clears the controller without aborting it: only the turn check can refuse the call.
      expect(asked[0].detail?.signal?.aborted).toBe(false);
      asked[0].answer('proceed');
      const response = await answer(t, 'seven-b-1');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain('the turn this message belonged to has ended.');
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // Design §3 test 7b (replaced turn): released after a new turn has started, the call still sends nothing.
  it('sends nothing for a held call released after its turn was replaced by a new one', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-test-7b-replaced');
      await turn(t, 'test seven-b replaced first', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven-b replaced.', kind: 'question' }, 'seven-b-2');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      await completeTurn(t, 'Test seven-b replaced turn done.');
      await turn(t, 'test seven-b replaced second', { taskAttempt: card });
      asked[0].answer('proceed');
      const response = await answer(t, 'seven-b-2');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain('the turn this message belonged to has ended.');
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // Design §3 test 7c: a turn with attempt A, then a cardless rework turn: the rework call binds through turnThread.
  it('binds a call of a cardless rework turn through the turn thread, not to the earlier attempt', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-test-7c-attempt');
      await turn(t, 'test seven-c attempt turn', { taskAttempt: card });
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven-c in the attempt.', kind: 'question' }, 'seven-c-1');
      expect((await answer(t, 'seven-c-1')).result.contentItems[0].text).toBe(ATTEMPT_QUESTION_RECEIPT);
      await completeTurn(t, 'Test seven-c attempt turn done.');

      t.resolver.setTurnThreadSource((agentId) => (agentId === 'codex-1' ? { coordinatorId: 'pm', handle: 'handle-test-7c-rework' } : undefined));
      await turn(t, 'test seven-c rework turn', {});
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test seven-c in the rework.', kind: 'question' }, 'seven-c-2');
      const response = await answer(t, 'seven-c-2');
      expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toBe(REWORK_QUESTION_RECEIPT);
      expect(t.sent).toHaveLength(2);
      expect(t.sent[1]).toMatchObject({ to: 'pm', correlationId: 'handle-test-7c-rework', payload: { message: 'Test seven-c in the rework.' } });
      expect(t.sent[1].payload.metadata).toEqual({ taskMessage: {
        handle: 'handle-test-7c-rework', kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
      expect(JSON.stringify(t.sent[1].payload)).not.toContain(card.attemptId);
    } finally { await t.cleanup(); }
  });
});

describe('Codex saved threads and the messaging bit (v0.9.103 C2b)', () => {
  const OLD_PLAIN = '{"team":false,"mcpTools":[],"executableSkills":false,"taskCheckpoint":true}';

  // Design §3 test 8: a thread saved without taskMessages resumes, is not reset, and its call is refused.
  it('resumes a thread saved without taskMessages and refuses send_message in it', async () => {
    const t = await teammate({ restore: savedThread({ codexThreadId: 'thread-8-old', codexDynamicTools: OLD_PLAIN }) });
    try {
      expect(t.resets).toEqual([]);
      const card = await liveAttempt(t, 'handle-test-8-old');
      await turn(t, 'test eight old thread', { taskAttempt: card });
      expect(t.fake.clientMessages.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
      expect(t.fake.clientMessages.filter((message) => message.method === 'thread/start')).toHaveLength(0);
      expect(savedSignature(t)).not.toHaveProperty('taskMessages');
      // D2 (a): the model is told in its turn, and the person once per conversation.
      expect(turnInputs(t)[0]).toContain(`[host messaging]\n${OLD_CONVERSATION}\n[/host messaging]`);
      expect(messagingNotices(t)).toHaveLength(1);
      expect(messagingNotices(t)[0].text).toContain('New Model Conversation (keep chat)');
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test eight from an old thread.', kind: 'question' }, 'eight-1');
      const response = await answer(t, 'eight-1');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain(OLD_CONVERSATION);
      expect(t.sent).toEqual([]);
      await completeTurn(t, 'Test eight old thread first turn done.');
      await turn(t, 'test eight old thread again', { taskAttempt: card });
      expect(turnInputs(t)[1]).toContain('[host messaging]');
      expect(messagingNotices(t)).toHaveLength(1);
    } finally { await t.cleanup(); }
  });

  // v0.9.103 (Codex's audit of 1faadf1a, finding 1; the Owner: fix): the D2 notice is once per conversation, also
  // when a new backend restores that conversation (a reload or a restart), not once per backend instance.
  it('tells the person once per old conversation, also after a new backend restores it', async () => {
    const first = await teammate({ restore: savedThread({ codexThreadId: 'thread-8-notice', codexDynamicTools: OLD_PLAIN }) });
    let saved: ConversationSnapshot;
    try {
      await turn(first, 'test eight notice first backend');
      expect(messagingNotices(first)).toHaveLength(1);
      await completeTurn(first, 'Test eight notice first backend done.');
      saved = completeSnapshot(first);
      expect((saved.messages[0] as { codexMessagingNoticed?: unknown }).codexMessagingNoticed).toBe(true);
    } finally { await first.cleanup(); }
    const next = await teammate({ restore: saved });
    try {
      expect(next.resets).toEqual([]);
      await turn(next, 'test eight notice second backend');
      expect(turnInputs(next)[0]).toContain('[host messaging]');
      expect(messagingNotices(next)).toEqual([]);
    } finally { await next.cleanup(); }
  });

  // Design §3 test 8: a thread started now saves the bit, and resumes with the tool.
  it('saves taskMessages on a thread started now, and resumes that thread with the tool', async () => {
    const first = await teammate();
    let snapshot: ConversationSnapshot;
    try {
      await turn(first, 'test eight new thread');
      expect(turnInputs(first)[0]).not.toContain('[host messaging]');
      expect(messagingNotices(first)).toEqual([]);
      await completeTurn(first, 'Test eight new thread done.');
      expect(savedSignature(first)).toMatchObject({ taskMessages: true });
      snapshot = completeSnapshot(first);
    } finally { await first.cleanup(); }
    const next = await teammate({ restore: snapshot });
    try {
      expect(next.resets).toEqual([]);
      const card = await liveAttempt(next, 'handle-test-8-resumed');
      await turn(next, 'test eight resumed thread', { taskAttempt: card });
      expect(next.fake.clientMessages.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
      expect(next.fake.clientMessages.filter((message) => message.method === 'thread/start')).toHaveLength(0);
      next.fake.toolCall('send_message', { target: 'coordinator', message: 'Test eight from a resumed thread.', kind: 'question' }, 'eight-2');
      const response = await answer(next, 'eight-2');
      expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toBe(ATTEMPT_QUESTION_RECEIPT);
      expect(next.sent).toHaveLength(1);
      expect(next.sent[0]).toMatchObject({ correlationId: 'handle-test-8-resumed' });
    } finally { await next.cleanup(); }
  });

  // Design §3 test 8: a message-disabled agent's signature is the one it had before (no taskMessages key).
  it('leaves the signature of an agent that may not message unchanged', async () => {
    for (const options of [{ allowedTools: ['read', 'write', 'execute'] }, { bus: false }]) {
      const t = await teammate(options);
      try {
        await turn(t, `test eight disabled ${JSON.stringify(options)}`);
        expect((t.backend.snapshot()?.messages[0] as { codexDynamicTools?: unknown }).codexDynamicTools).toBe(OLD_PLAIN);
      } finally { await t.cleanup(); }
    }
  });

  // Design §3 test 8: a saved taskMessages: true whose messaging is now unavailable starts fresh.
  it('starts fresh when a thread saved with taskMessages meets an agent that can no longer message', async () => {
    const saved = '{"team":false,"mcpTools":[],"executableSkills":false,"taskCheckpoint":true,"taskMessages":true}';
    for (const options of [{ allowedTools: ['read', 'write', 'execute'] }, { bus: false }]) {
      const t = await teammate({ ...options, restore: savedThread({ codexThreadId: 'thread-8-gone', codexDynamicTools: saved }) });
      try {
        expect(t.resets).toHaveLength(1);
        await turn(t, `test eight messaging gone ${JSON.stringify(options)}`);
        expect(t.fake.clientMessages.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
        expect(t.fake.clientMessages.filter((message) => message.method === 'thread/start')).toHaveLength(1);
      } finally { await t.cleanup(); }
    }
  });

  // Design §3 test 8 (preserved): every combination of the four older optional bits accepted before is still accepted,
  // on a message-enabled and a message-disabled agent that offer all four.
  it('still accepts every saved combination of taskCheckpoint, writeDocument, contentReader and writeFile', async () => {
    const hostFileTools = () => {
      const tools = new WorkspaceTools(process.cwd(), new Set(['read', 'write']), 'codex-1');
      tools.setDocumentRenderer({ render: async () => { throw new Error('test eight renders nothing'); } } as any);
      return tools;
    };
    const delegatedSources = { read: async () => { throw new Error('unused'); }, delivered: () => undefined,
      readPage: async () => ({ ok: true, output: '' }) } as any;
    const optional = ['writeDocument', 'taskCheckpoint', 'contentReader', 'writeFile'] as const;
    for (const allowedTools of [MESSAGING_TOOLS, ['read', 'write', 'execute']]) {
      for (let mask = 0; mask < 16; mask++) {
        // The order the signature has always had: an exact string a thread of an earlier version saved.
        const surface: Record<string, unknown> = { team: false, mcpTools: [], executableSkills: false, saveAttachment: true };
        optional.forEach((key, bit) => { if (mask & (1 << bit)) surface[key] = true; });
        const t = await teammate({ allowedTools, start: false, deps: { hostFileTools: hostFileTools(), delegatedSources },
          restore: savedThread({ codexThreadId: `thread-8-mask-${mask}`, codexDynamicTools: JSON.stringify(surface) }) });
        try {
          expect(t.resets, `${allowedTools.join(',')} mask ${mask}`).toEqual([]);
          expect((t.backend as any).threadId, `${allowedTools.join(',')} mask ${mask}`).toBe(`thread-8-mask-${mask}`);
        } finally { await t.cleanup(); }
      }
    }
  });

  // Design §3 test 8: a complete snapshot with no signature, on a message-enabled backend with no other dynamic
  // sources (legacyWorker), resumes as before with no messaging bit.
  it('resumes a legacy snapshot with no signature without a messaging bit', async () => {
    const t = await teammate({ restore: savedThread({ codexThreadId: 'thread-8-legacy' }) });
    try {
      expect(t.resets).toEqual([]);
      expect(JSON.parse((t.backend as any).threadDynamicToolSignature)).not.toHaveProperty('taskMessages');
      const card = await liveAttempt(t, 'handle-test-8-legacy');
      await turn(t, 'test eight legacy thread', { taskAttempt: card });
      expect(t.fake.clientMessages.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
      expect(t.fake.clientMessages.filter((message) => message.method === 'thread/start')).toHaveLength(0);
      expect(savedSignature(t)).not.toHaveProperty('taskMessages');
      t.fake.toolCall('send_message', { target: 'coordinator', message: 'Test eight from a legacy thread.', kind: 'question' }, 'eight-3');
      const response = await answer(t, 'eight-3');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toContain(OLD_CONVERSATION);
      expect(messagingNotices(t)).toHaveLength(1);
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });
});

describe('send_message spec parity (v0.9.103)', () => {
  // Design §3 test 14: the shared spec, the API route's spec and the spec Codex advertises are the same.
  it('advertises on Codex the same send_message spec as the API route', async () => {
    const shared = sendMessageToolSpec();
    const api = new WorkspaceTools(process.cwd(), new Set(['message']), 'codex-1', undefined, undefined, undefined, undefined, new MessageBus())
      .specs().find((spec) => spec.function.name === 'send_message');
    expect(api).toEqual(shared);
    const t = await teammate();
    try {
      await turn(t, 'test fourteen parity');
      const codex = t.fake.clientMessages.find((message) => message.method === 'thread/start')
        .params.dynamicTools.find((tool: any) => tool.name === 'send_message');
      expect(codex).toEqual({ name: shared.function.name, description: shared.function.description, inputSchema: shared.function.parameters });
    } finally { await t.cleanup(); }
  });
});

// v0.9.104 D1.1 (ROADMAP item 5): Codex's own question tool. Measured on 0.165.0 and 0.167.0-alpha.4.1 (2026-11-15): in
// the Default collaboration mode the blocking request_user_input is unavailable; the model calls
// request_user_input_async, Codex answers it itself, and the question arrives only as this item, with no text deltas.
describe('Codex\'s own question tool (v0.9.104 D1.1)', () => {
  const QUESTION = 'Which season should the haiku be about?\nOptions: Spring, Summer, Autumn, Winter';
  const nativeItem = (id = 'call_q1') => ({ type: 'agentMessage', id, text: 'Which season should the haiku be about?\n- Spring\n- Summer\n- Autumn\n- Winter',
    delivery: 'async', questions: [{ title: 'Which season should the haiku be about?', options: ['Spring', 'Summer', 'Autumn', 'Winter'] }] });
  const ask = (t: Teammate, method: 'item/started' | 'item/completed', id?: string) =>
    t.fake.notify(method, { threadId: 'thread-1', turnId: 'turn-1', item: nativeItem(id) });
  const notices = (t: Teammate): string[] => t.events.filter((event) => event.kind === 'runtime_notice').map((event) => String(event.text));

  it('on a live attempt: exactly one question to the coordinator, bound like send_message; the chat shows it once', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-native-1');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/started');
      ask(t, 'item/completed');
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(t.sent).toHaveLength(1), SETTLED);
      await tick();
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ from: 'codex-1', to: 'pm', type: 'agent.message', correlationId: 'handle-native-1', payload: { message: QUESTION } });
      expect(t.sent[0].payload.metadata).toEqual({ taskMessage: {
        attemptId: card.attemptId, handle: 'handle-native-1', kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
      expect(notices(t).filter((text) => text.includes(QUESTION))).toEqual([
        `Codex Dev asked the coordinator of this task with Codex's own question tool:\n${QUESTION}\nThe answer comes back into this task.`]);
    } finally { await t.cleanup(); }
  });

  it('acts on the completed item: a started item that does not carry its questions yet does not use the question up', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-native-5');
      await turn(t, 'write the haiku', { taskAttempt: card });
      t.fake.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'call_q1', text: '', delivery: 'async', questions: null } });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(t.sent).toHaveLength(1), SETTLED);
      expect(t.sent[0].payload.message).toBe(QUESTION);
    } finally { await t.cleanup(); }
  });

  it('leaves the turn\'s own text, and so its result, as Codex wrote it', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-native-2');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(t.sent).toHaveLength(1), SETTLED);
      await completeTurn(t, 'I am waiting for the season.');
      expect(t.events.filter((event) => event.kind === 'turn_complete').at(-1).result.text).toBe('I am waiting for the season.');
      expect(t.events.filter((event) => event.kind === 'assistant').map((event) => event.text).join('')).not.toContain('Which season');
    } finally { await t.cleanup(); }
  });

  it('on no task (a Solo agent): nothing is sent anywhere, and the person sees the question to answer in this chat', async () => {
    const t = await teammate();
    try {
      await turn(t, 'write the haiku');
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(notices(t).some((text) => text.includes(QUESTION))).toBe(true), SETTLED);
      await tick();
      expect(t.sent).toEqual([]);
      expect(notices(t).filter((text) => text.includes(QUESTION))).toEqual([
        `Codex Dev asked with Codex's own question tool:\n${QUESTION}\nAnswer it in this chat.`]);
    } finally { await t.cleanup(); }
  });

  it('without the message tool: nothing is sent, as for send_message; the question is still shown', async () => {
    const t = await teammate({ allowedTools: ['read', 'write', 'execute'] });
    try {
      const card = await liveAttempt(t, 'handle-native-3');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(notices(t).some((text) => text.includes('Answer it in this chat.'))).toBe(true), SETTLED);
      await tick();
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  // Codex's audit of a5e238d7 (R1): the person's request limit holds a native question as it holds send_message.
  it('waits at the request boundary like send_message, and sends exactly one question once it is let through', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-native-held');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      expect(asked[0].detail?.tool).toBe('send_message');
      expect(t.sent).toEqual([]);
      asked[0].answer('proceed');
      await vi.waitFor(() => expect(t.sent).toHaveLength(1), SETTLED);
      expect(t.sent[0]).toMatchObject({ correlationId: 'handle-native-held', payload: { message: QUESTION } });
    } finally { await t.cleanup(); }
  });

  it('sends nothing when the person stops at the request limit, and the chat says the question did not reach the coordinator', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-native-limit');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      asked[0].answer('stopped');
      await vi.waitFor(() => expect(notices(t)).toContain(`That question did not reach the coordinator: ${REQUEST_LIMIT_STOPPED_REFUSAL}`), SETTLED);
      for (let i = 0; i < 5; i++) await tick();
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  it('sends nothing when the turn is interrupted while the question waits at the boundary and it is then let through', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-native-interrupt');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      t.backend.abort();
      expect(asked[0].detail?.signal?.aborted).toBe(true);
      asked[0].answer('proceed');
      for (let i = 0; i < 10; i++) await tick();
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  it('sends nothing when its turn ended and a new one started while the question waited at the boundary', async () => {
    const { boundary, asked } = heldBoundary();
    const t = await teammate({ requestBoundary: boundary });
    try {
      const card = await liveAttempt(t, 'handle-native-replaced');
      await turn(t, 'write the haiku', { taskAttempt: card });
      ask(t, 'item/completed');
      await vi.waitFor(() => expect(asked).toHaveLength(1), SETTLED);
      await completeTurn(t, 'I am waiting for the season.');
      await turn(t, 'write the haiku, second turn', { taskAttempt: card });
      asked[0].answer('proceed');
      await vi.waitFor(() => expect(notices(t)).toContain('That question did not reach the coordinator: Error: nothing was sent: the turn this message belonged to has ended.'), SETTLED);
      expect(t.sent).toEqual([]);
    } finally { await t.cleanup(); }
  });

  it('an ordinary agent message is not a question, and sends nothing', async () => {
    const t = await teammate();
    try {
      const card = await liveAttempt(t, 'handle-native-4');
      await turn(t, 'write the haiku', { taskAttempt: card });
      t.fake.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'Which season? I will pick winter.', delivery: null, questions: null } });
      await completeTurn(t, 'Done.');
      expect(t.sent).toEqual([]);
      expect(notices(t).some((text) => text.includes('own question tool'))).toBe(false);
    } finally { await t.cleanup(); }
  });
});
