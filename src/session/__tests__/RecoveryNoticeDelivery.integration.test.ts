/*
 * v0.9.110 R2 (audit of f904fae7, F5 and F6): the recovery note on the Claude CLI and Codex routes. A notice recorded in
 * the real task history reaches the member's next request of the person, from the shared entrance (a new request or one
 * started again), at the start of the user turn the CLI receives; it counts as received only when the backend reports
 * that input taken, and a reopened history keeps what was and was not received.
 *
 * MODULE INTEGRATION, NOT ACTIVATION EVIDENCE: real SessionManager, MessageBus, UserRequestEntrance, HistoryService and
 * HistoryStore, the production recovery-notice port, and the production ClaudeHeadlessBackend and CodexBackend over a
 * fake process and a fake App Server transport.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../../backend/CodexBackend';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentConfig, Message } from '../../types';
import { SessionManager } from '../SessionManager';
import { UserRequestEntrance } from '../../host/UserRequestEntrance';
import { HistoryService } from '../../history/HistoryService';
import { HistoryStore } from '../../history/HistoryStore';
import { recoveryNoticePort } from '../../history/RecoveryNotice';
import { fixedCodexProgram } from '../../backend/__tests__/codexProgramFixture';

// Copied from CliTeammateMessages.integration.test.ts: the fake Claude CLI process and the fake App Server.
// ─── The Claude CLI process: a fake child the production backend spawns ───────────────────────────────

interface FakeCli { proc: any; packets: string[] }

function fakeClaudeSpawn() {
  const clis: FakeCli[] = [];
  const fn = () => {
    const proc = new EventEmitter() as any;
    const cli: FakeCli = { proc, packets: [] };
    proc.pid = 5150;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      write: (text: string) => {
        for (const line of String(text).split('\n')) if (line.trim()) cli.packets.push(line);
        return true;
      },
      end: () => undefined,
    };
    proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } return true; };
    clis.push(cli);
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, clis };
}

/** The text of a user packet the backend wrote to the CLI's stdin. */
function packetText(line: string): string {
  const content = (JSON.parse(line) as { message: { content: unknown } }).message.content;
  return typeof content === 'string' ? content
    : (content as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** The CLI's own end of its turn, as `claude -p --output-format stream-json` writes it. */
function cliTurnEnds(cli: FakeCli, text: string): void {
  cli.proc.stdout.emit('data', `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: text,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
  })}\n`);
}

// ─── The Codex App Server: a fake transport the production backend spawns ───────────────────────────────

function fakeAppServer() {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const state = { steer: 'accept' as 'accept' | 'refuse', turns: 0, currentTurn: '', refuseTurnStart: false };
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
          else if (message.method === 'turn/start' && state.refuseTurnStart) {
            // The App Server does not take this input: the request never reached the model.
            state.refuseTurnStart = false;
            emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'turn could not start' } });
          } else if (message.method === 'turn/start') {
            state.currentTurn = `turn-${++state.turns}`;
            reply({ turn: { id: state.currentTurn, status: 'inProgress' } });
          } else if (message.method === 'turn/steer') {
            // App Server's answer to a steer of this exact turn: accepted, or refused (the turn cannot take input).
            if (state.steer === 'accept' && message.params.expectedTurnId === state.currentTurn) reply({ turnId: state.currentTurn });
            else emit({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
          } else if (message.id !== undefined && !message.method) responses.push(message);
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
    state,
    clientMessages,
    responses,
    /** Codex calling a dynamic tool in its current turn. */
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: state.currentTurn, callId: id, namespace: null, tool, arguments: args } });
    },
    /** Codex ending its current turn with a final agent message. */
    turnEnds(text: string) {
      const turnId = state.currentTurn;
      emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `${turnId}-msg`, text } } });
      emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
    },
    /**
     * v0.9.104 D1.1: Codex's own question tool in its current turn, as measured on 0.165.0 and 0.167.0-alpha.4.1: Codex
     * answers request_user_input_async itself, and the question arrives only as an async agentMessage item, with no deltas.
     */
    nativeQuestion(title: string, options: string[], id = `call_native_${state.currentTurn}`) {
      const item = { type: 'agentMessage', id, text: `${title}\n${options.map((option) => `- ${option}`).join('\n')}`, delivery: 'async',
        questions: [{ title, options }] };
      emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-1', turnId: state.currentTurn, item } });
      emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-1', turnId: state.currentTurn, item } });
    },
    turnStarts(): any[] { return clientMessages.filter((message) => message.method === 'turn/start'); },
    steers(): any[] { return clientMessages.filter((message) => message.method === 'turn/steer'); },
  };
}



function turnStartText(message: any): string {
  return (message.params.input as Array<{ type: string; text?: string }>).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

class State {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

const NOTE = '[UnodeAi host note — not from the person]';

function devConfig(kind: 'claude' | 'codex', dir: string): AgentConfig {
  return kind === 'claude'
    ? {
      id: 'dev', name: 'Dev', role: 'developer', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
      model: 'claude-haiku-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read'],
      backend: 'claude', workingDirectory: dir,
    }
    : {
      id: 'dev', name: 'Dev', role: 'developer', skill: '', provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' },
      model: CODEX_CLI_DEFAULT_MODEL, systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read'],
      backend: 'codex', workingDirectory: dir,
    };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined); });

async function world(kind: 'claude' | 'codex') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `unode-r2-notice-${kind}-`)));
  const historyDir = path.join(dir, '.history');
  const openStore = () => HistoryStore.open({ directory: historyDir, workspaceId: 'w'.repeat(8), writerId: randomUUID() });
  const history = new HistoryService({ open: openStore, state: new State() });
  const bus = new MessageBus();
  const claude = fakeClaudeSpawn();
  const codex = fakeAppServer();
  const mgr = new SessionManager(5, bus, {
    createBackend: (agent) => kind === 'claude'
      ? new ClaudeHeadlessBackend(agent, undefined, undefined, { spawn: claude.fn as any, messageBus: bus })
      : new CodexBackend(agent, undefined, {
        launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
        spawn: codex.spawn,
        access: () => ({ trusted: true, restricted: false, readRoots: [dir], writeRoots: [dir] }),
        requestApproval: async () => ({ allow: false }),
        killProcessTree: async () => undefined,
        messageBus: bus,
      }),
    resolveEnv: async () => ({ PATH: 'safe' }),
    recoveryNotices: recoveryNoticePort(() => history, (_agent, physical) => !physical.includes(`${path.sep}secret${path.sep}`)),
  });
  const entrance = new UserRequestEntrance({
    beginUserRequest: () => {}, bus,
    agents: { has: (id) => mgr.get(id) !== undefined, isRunning: (id) => mgr.get(id)?.status !== 'stopped', start: (id) => mgr.start(id) },
  });
  mgr.create(devConfig(kind, dir));
  await mgr.start('dev', { pin: 'take' });
  await vi.waitFor(() => expect(mgr.get('dev')?.status).toBe('idle'));
  cleanups.push(async () => { await mgr.stopAll(); bus.dispose(); await history.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  const turns = (): string[] => kind === 'claude' ? (claude.clis[0]?.packets ?? []).map(packetText) : codex.turnStarts().map(turnStartText);
  const ends = (text: string) => { if (kind === 'claude') cliTurnEnds(claude.clis[0], text); else codex.turnEnds(text); };
  /** A file restored to an earlier restore point, as the single-file Restore records it. */
  const restored = (name: string) => history.restoreNotice({ physicalTarget: path.join(dir, name), displayPath: name, removed: false,
    current: { kind: 'file', sha256: 'a'.repeat(64), size: 1 } });
  return { dir, history, bus, mgr, entrance, turns, ends, restored, openStore, codex };
}

describe('R2 recovery note whose request the backend never took (F6)', () => {
  it('Codex: a turn the App Server refused leaves the note pending, flagged, and the next request carries it', async () => {
    const w = await world('codex');
    w.restored('d.txt');
    await w.history.flush();
    w.codex.state.refuseTurnStart = true;
    w.entrance.submit('dev', 'ask.question', { instruction: 'refused request' });
    await vi.waitFor(() => expect(w.codex.turnStarts()).toHaveLength(1));
    await vi.waitFor(() => expect(w.mgr.get('dev')?.status).not.toBe('running'));
    await w.history.flush();
    const still = await w.history.pendingRecoveryNotices('dev');
    expect(still).toHaveLength(1);
    expect(still[0].attached).toBe(true);
    w.entrance.submit('dev', 'ask.question', { instruction: 'next request' });
    await vi.waitFor(() => expect(w.turns().some((turn) => turn.endsWith('next request'))).toBe(true));
    const sent = w.turns().find((turn) => turn.endsWith('next request'))!;
    expect(sent).toContain('d.txt: restored to an earlier restore point');
    expect(sent).toContain('may repeat a note sent with an earlier request whose delivery was not confirmed');
    await vi.waitFor(async () => {
      await w.history.flush();
      expect(await w.history.pendingRecoveryNotices('dev')).toEqual([]);
    });
  });
});

for (const kind of ['claude', 'codex'] as const) {
  describe(`R2 recovery note on the ${kind} route (F5, F6)`, () => {
    it('the next request of the person starts with the note; it is received once, when the backend took the input', async () => {
      const w = await world(kind);
      w.restored('a.txt');
      w.restored(`secret${path.sep}hidden.txt`);
      await w.history.flush();
      expect(await w.history.pendingRecoveryNotices('dev')).toHaveLength(2);
      w.entrance.submit('dev', 'ask.question', { instruction: 'first request' });
      await vi.waitFor(() => expect(w.turns()).toHaveLength(1));
      const sent = w.turns()[0];
      // Claude's first turn starts with the role's own preamble; the note follows it and precedes the person's text.
      expect(sent.indexOf(NOTE)).toBeGreaterThanOrEqual(0);
      expect(sent.endsWith('\n\nfirst request')).toBe(true);
      expect(sent.indexOf(NOTE)).toBeLessThan(sent.lastIndexOf('first request'));
      expect(sent).toContain('a.txt: restored to an earlier restore point');
      expect(sent).not.toContain('hidden.txt');
      expect(sent).toContain('1 more file outside your current file access');
      await vi.waitFor(async () => {
        await w.history.flush();
        expect(await w.history.pendingRecoveryNotices('dev')).toEqual([]);
      });
      w.ends('done first');
      await vi.waitFor(() => expect(w.mgr.get('dev')?.status).toBe('idle'));
      w.entrance.submit('dev', 'ask.question', { instruction: 'second request' });
      await vi.waitFor(() => expect(w.turns()).toHaveLength(2));
      expect(w.turns()[1]).not.toContain(NOTE);
      expect(w.turns()[1].endsWith('second request')).toBe(true);
      // A reopened history (a reload) keeps the delivery.
      const reopened = new HistoryService({ open: w.openStore, state: new State() });
      expect(await reopened.pendingRecoveryNotices('dev')).toEqual([]);
      await reopened.flush();
    });

    it('a request started again carries a note recorded meanwhile', async () => {
      const w = await world(kind);
      const first = w.entrance.submit('dev', 'ask.question', { instruction: 'try this' }) as Message;
      await vi.waitFor(() => expect(w.turns()).toHaveLength(1));
      expect(w.turns()[0]).not.toContain(NOTE);
      expect(w.turns()[0].endsWith('try this')).toBe(true);
      w.ends('done');
      await vi.waitFor(() => expect(w.mgr.get('dev')?.status).toBe('idle'));
      w.restored('b.txt');
      await w.history.flush();
      expect(await w.entrance.resubmit('dev', first)).toBe(true);
      await vi.waitFor(() => expect(w.turns()).toHaveLength(2));
      expect(w.turns()[1]).toContain(NOTE);
      expect(w.turns()[1].endsWith('\n\ntry this')).toBe(true);
      expect(w.turns()[1]).toContain('b.txt: restored to an earlier restore point');
    });
  });
}

describe('R2 recovery notices across a reload (F6)', () => {
  it('a note handed over but never confirmed stays pending after a reload and says it may repeat', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-r2-notice-reload-')));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const openStore = () => HistoryStore.open({ directory: path.join(dir, 'h'), workspaceId: 'w'.repeat(8), writerId: randomUUID() });
    const history = new HistoryService({ open: openStore, state: new State() });
    // No message of this member is stored: the view its note went out in is kept by the attach record itself.
    history.restoreNotice({ physicalTarget: path.join(dir, 'c.txt'), displayPath: 'c.txt', removed: false, current: { kind: 'file', sha256: 'b'.repeat(64), size: 1 } });
    await history.flush();
    const port = recoveryNoticePort(() => history, () => true);
    const prepared = (await port.prepare('dev'))!;
    expect(prepared.noticeIds).toHaveLength(1);
    port.attached('dev', prepared, 'req-1');
    await history.flush();
    const reopened = new HistoryService({ open: openStore, state: new State() });
    const again = (await recoveryNoticePort(() => reopened, () => true).prepare('dev'))!;
    expect(again.noticeIds).toEqual(prepared.noticeIds);
    expect(again.text).toContain('may repeat a note sent with an earlier request whose delivery was not confirmed');
    recoveryNoticePort(() => reopened, () => true).delivered('dev', again, 'req-2');
    await reopened.flush();
    const third = new HistoryService({ open: openStore, state: new State() });
    expect(await third.pendingRecoveryNotices('dev')).toEqual([]);
    await third.flush();
  });

  it('names the newest ten notices and counts the rest', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-r2-notice-cap-')));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const history = new HistoryService({ open: () => HistoryStore.open({ directory: path.join(dir, 'h'), workspaceId: 'w'.repeat(8), writerId: randomUUID() }), state: new State() });
    for (let index = 0; index < 13; index++) {
      history.restoreNotice({ physicalTarget: path.join(dir, `f${index}.txt`), displayPath: `f${index}.txt`, removed: false, current: { kind: 'file', sha256: 'c'.repeat(64), size: 1 } });
    }
    await history.flush();
    const prepared = (await recoveryNoticePort(() => history, () => true).prepare('dev'))!;
    expect(prepared.noticeIds).toHaveLength(13);
    expect(prepared.text).toContain('3 earlier restores not listed here');
    expect(prepared.text).not.toContain('f2.txt:');
    expect(prepared.text).toContain('f3.txt:');
    expect(prepared.text).toContain('f12.txt:');
  });
});
