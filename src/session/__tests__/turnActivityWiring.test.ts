import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import type { AgentConfig, Message } from '../../types';
import type { RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';
import type { TurnActivityV1 } from '../../observability/TurnActivity';

const ok = { status: 'success' as const, observedBy: 'host' as const };
const error = { kind: 'turn_complete' as const, result: { text: 'PRIVATE_ERROR', isError: true, responseOutcome: { kind: 'error' as const } } };
function config(id: string): AgentConfig {
  return { id, name: id, role: id === 'pm' ? 'pm' : 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', systemPrompt: '',
    autoApprove: true, allowedTools: ['read'], backend: 'openai-compat', workingDirectory: process.cwd() };
}
class FakeBackend implements AgentBackend {
  readonly agentId: string;
  private handler?: BackendEventHandler;
  constructor(agent: AgentConfig) { this.agentId = agent.id; }
  onEvent(handler: BackendEventHandler) { this.handler = handler; return () => { this.handler = undefined; }; }
  async start() { this.emit({ kind: 'ready' }); }
  sendUserTurn() {}
  async stop() {}
  isAlive() { return true; }
  emit(event: BackendEvent) { this.handler?.(event); }
}
const managers: SessionManager[] = [];
afterEach(() => managers.splice(0).forEach(manager => manager.dispose()));
function terminalActivity(bus: MessageBus, agent: string) {
  const message = bus.query({ from: agent }).filter(message => ['task.complete', 'system.error', 'task.partial'].includes(message.type)).at(-1)!;
  return (message.payload.metadata as { turnActivity: TurnActivityV1 }).turnActivity;
}
async function setup() {
  const bus = new MessageBus();
  const backends = new Map<string, FakeBackend>();
  const records: RequestCloseoutRecordV1[] = [];
  const manager = new SessionManager(5, bus, { resolveEnv: async () => ({}),
    createBackend: agent => { const backend = new FakeBackend(agent); backends.set(agent.id, backend); return backend; } });
  managers.push(manager); manager.on('session.requestCloseout', event => records.push(event.data.record));
  for (const id of ['pm', 'dev']) { manager.create(config(id)); await manager.start(id, { pin: 'take' }); }
  return { bus, manager, backends, records };
}

describe('actual session turn-activity wiring', () => {
  it('routes bounded detail through the private event only, never the terminal bus, record or summary', async () => {
    const { bus, manager, backends, records } = await setup(); const diagnostics: any[] = [];
    manager.on('session.interruptionDetail', event => diagnostics.push(event.data));
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    const interruption = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted' } as const;
    const detail = { schemaVersion: 1, name: 'Error', code: 'EPIPE', message: 'PRIVATE_DIAGNOSTIC api_key=PRIVATE_CREDENTIAL',
      body: 'PRIVATE_BODY', stack: 'PRIVATE_STACK' };
    const result = { text: 'PRIVATE_MODEL_PROSE', isError: true, interruption,
      interruptionDetail: detail as any, responseOutcome: { kind: 'error' as const } };
    backends.get('pm')!.emit({ kind: 'turn_complete', result });
    backends.get('pm')!.emit({ kind: 'turn_complete', result });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].detail).toEqual({ schemaVersion: 1, name: 'Error', code: 'EPIPE', message: 'PRIVATE_DIAGNOSTIC api_key=[redacted]' });
    const terminal = bus.query({ from: 'pm', type: 'system.error' }).at(-1)!;
    expect(JSON.stringify(terminal)).not.toMatch(/PRIVATE_|interruptionDetail/);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|interruptionDetail/);
  });
  it.each(['pm', 'dev'])('projects %s interruption once from frozen host facts, never provider prose', async target => {
    const { bus, manager, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'PRIVATE_REQUEST', mode: 'act' });
    if (target === 'dev') bus.send('pm', 'dev', 'task.assign', { instruction: 'PRIVATE_TASK' }, 'normal', 'h-itr');
    const backend = backends.get(target)!;
    const interruption = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted', attempts: 2 } as const;
    backend.emit({ kind: 'tool_use', callId: 'read', name: 'read_file', input: { path: 'PRIVATE_ARGUMENT' } });
    backend.emit({ kind: 'tool_result', callId: 'read', name: 'read_file', outcome: ok, summary: 'PRIVATE_TOOL_OUTPUT', read: { path: 'work.md' } });
    backend.emit({ kind: 'error', message: 'PRIVATE_RAW_ERROR' });
    backend.emit({ kind: 'turn_complete', result: { text: 'PRIVATE_MODEL_PROSE', isError: true, interruption, responseOutcome: { kind: 'error' } } });
    const message = bus.query({ from: target, type: 'system.error' }).at(-1)!;
    expect(message.payload.instruction).toContain('connection to the model provider was interrupted');
    expect(message.payload.instruction).toContain('Files read: work.md');
    expect(message.payload.instruction).toContain('read_file: 1 succeeded');
    expect(message.payload.instruction).not.toContain('PRIVATE_');
    expect(message.payload.metadata).toMatchObject({ interruption, turnActivity: { reads: ['work.md'] } });
    if (target === 'pm') expect(records[0]).toMatchObject({ terminal: { kind: 'failed' }, interruption });
    else expect(records).toEqual([]);
    let offered = false;
    expect(await manager.withCompletedTurnWork(target, async () => { offered = true; })).toBeUndefined();
    expect(offered).toBe(false);
    backend.emit({ kind: 'turn_complete', result: { text: 'duplicate', isError: true, interruption, responseOutcome: { kind: 'error' } } });
    backend.emit({ kind: 'exit', code: 1 });
    expect(bus.query({ from: target, type: 'system.error' })).toHaveLength(1);
    expect(records).toHaveLength(target === 'pm' ? 1 : 0);
  });

  it('discards a corrupt optional interruption without changing an old error, or relabelling a user Stop', async () => {
    const { bus, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'legacy error', isError: true,
      interruption: { schemaVersion: 2 } as any, responseOutcome: { kind: 'error' } } });
    expect(bus.query({ from: 'pm', type: 'system.error' }).at(-1)?.payload.instruction).toBe('legacy error');
    expect(records[0].interruption).toBeUndefined();
    bus.send('user', 'pm', 'ask.question', { instruction: 'stop it', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'Stopped by user', isError: true,
      interruption: { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'exhausted' }, responseOutcome: { kind: 'stopped' } } });
    expect(records[1].interruption).toBeUndefined();
    expect(bus.query({ from: 'pm', type: 'system.error' }).at(-1)?.payload.instruction).toBe('Stopped by user');
  });
  it('forwards a content-free retry at the current epoch without forging a result, activity or terminal', async () => {
    const { bus, manager, backends, records } = await setup();
    const retries: unknown[] = []; manager.on('session.responseRetry', event => retries.push(event.data));
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    const retry = { previousAttempt: 1, attempt: 2, reason: 'connection-lost' as const };
    backends.get('pm')!.emit({ kind: 'response_retry', retry });
    expect(retries).toEqual([{ retry, epoch: 1 }]); expect(records).toEqual([]);
    expect(bus.query({ from: 'pm', type: 'task.complete' })).toEqual([]);
    backends.get('pm')!.emit(error);
    expect(records).toHaveLength(1); expect(records[0].observations.turnActivity?.tools).toEqual([]);
    await manager.stop('pm');
    backends.get('pm')!.emit({ kind: 'response_retry', retry: { ...retry, attempt: 3 } });
    expect(retries).toHaveLength(1);
  });
  it('pairs real backend events and carries a separate delegate projection without minting a root closeout', async () => {
    const { bus, manager, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'PRIVATE_REQUEST', mode: 'act' });
    const requestId = manager.currentRequestId('pm')!;
    const pmTurn = manager.currentTurnId('pm')!;
    bus.send('pm', 'dev', 'task.assign', { instruction: 'PRIVATE_DELEGATION' }, 'normal', 'h-1');
    const devTurn = manager.currentTurnId('dev')!;
    backends.get('pm')!.emit({ kind: 'tool_use', callId: 'pm-read', name: 'read_file', input: { path: 'PRIVATE_ARG' } });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'pm-read', name: 'read_file', outcome: ok, summary: 'PRIVATE_SUMMARY', detail: 'PRIVATE_CONTENT', read: { path: 'plan.md' } });
    backends.get('dev')!.emit({ kind: 'tool_use', callId: 'dev-write', name: 'write_file', input: { path: 'PRIVATE_ARG' } });
    manager.noteFileEffect(requestId, { key: 'private-physical', path: 'worker.md', operation: 'write', grade: 'native-observed' }, { agentId: 'dev', turnId: devTurn });
    backends.get('dev')!.emit({ kind: 'tool_result', callId: 'dev-write', name: 'write_file', outcome: ok, summary: 'PRIVATE_SUMMARY' });
    backends.get('dev')!.emit(error);
    expect(records).toEqual([]);
    expect(terminalActivity(bus, 'dev')).toMatchObject({ changes: [{ path: 'worker.md', operation: 'write', evidence: 'native-observed' }] });
    manager.noteFileEffect(requestId, { key: 'pm', path: 'pm.md', operation: 'write', grade: 'host-verified' }, { agentId: 'pm', turnId: pmTurn });
    backends.get('pm')!.emit(error);
    expect(records).toHaveLength(1);
    expect(records[0].observations.changes.files.map(file => file.path)).toEqual(['worker.md', 'pm.md']);
    expect(records[0].observations.turnActivity).toMatchObject({ reads: ['plan.md'], changes: [{ path: 'pm.md', operation: 'write', evidence: 'host-verified' }] });
    expect(terminalActivity(bus, 'pm')).toEqual(records[0].observations.turnActivity);
    expect(JSON.stringify(terminalActivity(bus, 'pm'))).not.toMatch(/PRIVATE_|private-physical/);
  });

  it('never attributes a late old-turn effect to the next same-agent turn, while the request ledger can retain it', async () => {
    const { bus, manager, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'first', mode: 'act' });
    const oldRequest = manager.currentRequestId('pm')!; const oldTurn = manager.currentTurnId('pm')!;
    backends.get('pm')!.emit(error);
    bus.send('user', 'pm', 'ask.question', { instruction: 'next', mode: 'act' });
    manager.noteFileEffect(oldRequest, { key: 'late', path: 'late.md', operation: 'write', grade: 'effect-uncertain' }, { agentId: 'pm', turnId: oldTurn });
    backends.get('pm')!.emit(error);
    expect(records).toHaveLength(2);
    expect(records[1].observations.turnActivity?.changes).toEqual([]);
    expect(records[0].observations.turnActivity?.changes).toEqual([]);
  });

  it('a real process-exit terminal keeps partial activity, emits once, and rejects the detached late completion', async () => {
    const { bus, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'tool_use', callId: 'unfinished', name: 'assign_task', input: {} });
    backends.get('pm')!.emit({ kind: 'exit', code: 1 });
    expect(records).toHaveLength(1);
    expect(terminalActivity(bus, 'pm')).toMatchObject({ coverage: 'partial', lastUnfinished: 'assign_task',
      tools: [{ tool: 'assign_task', success: 0, refused: 0, failed: 0, unfinished: 1 }] });
    backends.get('pm')!.emit(error);
    expect(records).toHaveLength(1);
    expect(bus.query({ from: 'pm', type: 'system.error' })).toHaveLength(1);
  });

  it('a PM wake in the same request cannot take an earlier turn attribution even though its request id still matches', async () => {
    const { bus, manager, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    const requestId = manager.currentRequestId('pm')!; const turnId = manager.currentTurnId('pm')!;
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegate' }, 'normal', 'h-1');
    backends.get('pm')!.emit(error); backends.get('dev')!.emit(error);
    manager.queueAsyncDelegationWake('pm', { handle: 'h-1', ref: 'dev', text: 'ready', runId: 'run-1' }, () => true, () => true);
    await Promise.resolve();
    expect(manager.currentRequestId('pm')).toBe(requestId);
    expect(manager.currentTurnId('pm')).not.toBe(turnId);
    manager.noteFileEffect(requestId, { key: 'old', path: 'old.md', operation: 'write', grade: 'host-verified' }, { agentId: 'pm', turnId });
    backends.get('pm')!.emit(error);
    expect(records.at(-1)?.observations.changes.files.map(file => file.path)).toContain('old.md');
    expect(records.at(-1)?.observations.turnActivity?.changes).toEqual([]);
  });

  it('ignores a refusal or external result pretending to carry a read observation', async () => {
    const { bus, backends, records } = await setup();
    bus.send('user', 'pm', 'ask.question', { instruction: 'read', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'tool_use', callId: 'refused', name: 'read_file', input: {} });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'refused', name: 'read_file', outcome: { status: 'refused', observedBy: 'host', reason: 'scope' }, summary: '', read: { path: 'fake.md' } });
    backends.get('pm')!.emit({ kind: 'tool_use', callId: 'external', name: 'read_file', input: {} });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'external', name: 'read_file', outcome: { status: 'success', observedBy: 'provider' }, summary: '', read: { path: 'fake.md' } });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'orphan', name: 'read_file', outcome: ok, summary: '', read: { path: 'orphan.md' } });
    backends.get('pm')!.emit({ kind: 'tool_use', callId: 'valid', name: 'read_file', input: {} });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'valid', name: 'read_file', outcome: ok, summary: '', read: { path: 'valid.md' } });
    backends.get('pm')!.emit({ kind: 'tool_result', callId: 'valid', name: 'read_file', outcome: ok, summary: '', read: { path: 'duplicate.md' } });
    backends.get('pm')!.emit(error);
    expect(records[0].observations.turnActivity?.reads).toEqual(['valid.md']);
    expect(records[0].observations.turnActivity?.coverage).toBe('partial');
  });

  it('carries an actual WorkspaceTools read through the OpenAI router into the terminal record, not its contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-itr-read-'));
    try {
      await fs.writeFile(path.join(dir, 'source.txt'), 'PRIVATE_FILE_CONTENT');
      const bus = new MessageBus();
      let count = 0;
      const manager = new SessionManager(5, bus, { resolveEnv: async () => ({ ROAM_API_KEY: 'PRIVATE_KEY' }),
        createBackend: agent => {
          const backend = new OpenAICompatBackend(agent, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: count++ === 0
            ? { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }] }
            : { role: 'assistant', content: 'done' } }] }) }));
          return backend;
        } });
      managers.push(manager); manager.create({ ...config('dev'), workingDirectory: dir });
      await manager.start('dev', { pin: 'take' });
      const complete = new Promise<Message>(resolve => bus.subscribe({ from: 'dev', type: 'task.complete' }, resolve));
      bus.send('user', 'dev', 'ask.question', { instruction: 'read source.txt', mode: 'act' });
      const terminal = await complete;
      const activity = (terminal.payload.metadata as { turnActivity: TurnActivityV1 }).turnActivity;
      expect(activity.reads).toEqual(['source.txt']);
      expect(activity.tools).toContainEqual({ tool: 'read_file', success: 1, refused: 0, failed: 0, unfinished: 0 });
      expect(JSON.stringify(activity)).not.toContain('PRIVATE_FILE_CONTENT');
      expect(count).toBe(2);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
