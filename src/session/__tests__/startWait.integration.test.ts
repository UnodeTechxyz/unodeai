import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../../backend/CodexBackend';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentConfig } from '../../types';
import { TeamViewProvider } from '../../views/TeamViewProvider';
import { SessionManager } from '../SessionManager';

// v0.9.97 (Codex's audit of 87092b9, F5): while a start waits, for example for the check of the program's files,
// the agent's Team row says so. The line comes from the backend's own start, through the session, and it is gone
// once the start ends: started, refused, stopped by the person, or failed.

const CHECKING = { claude: 'Checking the Claude program…', codex: 'Checking the Codex program…' } as const;

function config(id: string, backend: 'claude' | 'codex'): AgentConfig {
  return {
    id, name: `${backend} agent`, role: 'developer', skill: '',
    provider: backend === 'codex' ? { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' } : { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: backend === 'codex' ? CODEX_CLI_DEFAULT_MODEL : 'claude-sonnet-5', systemPrompt: '', autoApprove: true, allowedTools: [], backend,
    workingDirectory: process.cwd(),
  };
}

/** The Team row's HTML for the agents of `sessions`. */
function teamRow(sessions: SessionManager): string {
  const provider = new TeamViewProvider({} as never, sessions as never, new MessageBus(), '', undefined, () => [], (id) => id);
  return (provider as unknown as { _getHtml: (webview: unknown) => string })._getHtml({ cspSource: 'test:' });
}

/** A start that waits until the test lets it go on, after saying what it waits for. */
function waiting() {
  let release!: (outcome: 'go' | 'refuse') => void;
  const gate = new Promise<'go' | 'refuse'>((resolve) => { release = resolve; });
  return { gate, release };
}

function realBackend(kind: 'claude' | 'codex', agent: AgentConfig, gate: Promise<'go' | 'refuse'>): AgentBackend {
  if (kind === 'codex') {
    return new CodexBackend(agent, undefined, {
      launchProgram: async (start) => {
        start.onPending(CHECKING.codex);
        await gate;
        throw new Error('This program is not the one this agent was started with. Nothing was started.');
      },
      access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [process.cwd()] }),
    });
  }
  return new ClaudeHeadlessBackend(agent, undefined, undefined, {
    // Any readable file: the start reaches the program's choice only with its hook in place.
    toolGateScriptPath: path.join(process.cwd(), 'package.json'),
    // No real program is ever looked up or started here.
    resolveExecutable: () => { throw new Error('this test starts no program'); },
    resolveClaudeLaunch: async (start) => {
      start.onPending(CHECKING.claude);
      await gate;
      throw new Error('This program is not the one this agent was started with. Nothing was started.');
    },
  });
}

const managers: SessionManager[] = [];
afterEach(() => { managers.splice(0); });

describe.each(['codex', 'claude'] as const)('the Team row of a %s agent whose start waits (v0.9.97)', (kind) => {
  it('says what the start waits for, and nothing once it was refused', async () => {
    const { gate, release } = waiting();
    const sessions = new SessionManager(5, new MessageBus(), { createBackend: (agent) => realBackend(kind, agent, gate), resolveEnv: async () => ({}) });
    managers.push(sessions);
    sessions.create(config('a1', kind));
    const started = sessions.start('a1', { pin: 'take' }).then(() => 'started', () => 'refused');
    await vi.waitFor(() => expect(sessions.get('a1')?.startWaitMessage).toBe(CHECKING[kind]));
    expect(teamRow(sessions)).toContain(CHECKING[kind]);
    release('refuse');
    expect(await started).toBe('refused');
    expect(sessions.get('a1')).toMatchObject({ status: 'error', startWaitMessage: undefined });
    expect(teamRow(sessions)).not.toContain(CHECKING[kind]);
  });

  it('says nothing once the person stopped the waiting start', async () => {
    const { gate, release } = waiting();
    const sessions = new SessionManager(5, new MessageBus(), { createBackend: (agent) => realBackend(kind, agent, gate), resolveEnv: async () => ({}) });
    managers.push(sessions);
    sessions.create(config('a1', kind));
    const started = sessions.start('a1', { pin: 'take' }).catch(() => undefined);
    await vi.waitFor(() => expect(teamRow(sessions)).toContain(CHECKING[kind]));
    await sessions.stop('a1');
    expect(sessions.get('a1')?.startWaitMessage).toBeUndefined();
    expect(teamRow(sessions)).not.toContain(CHECKING[kind]);
    release('refuse');
    await started;
    expect(teamRow(sessions)).not.toContain(CHECKING[kind]);
  });
});

/** A backend that says what its start waits for, then ends it as the test says. */
class ScriptedBackend implements AgentBackend {
  readonly agentId: string;
  pid: number | undefined;
  private handler: BackendEventHandler | undefined;
  end!: (how: 'ready' | 'fail') => void;
  constructor(agent: AgentConfig) { this.agentId = agent.id; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  emit(event: BackendEvent): void { this.handler?.(event); }
  start(): Promise<void> {
    this.emit({ kind: 'start_pending', message: `  ${CHECKING.codex}\n${'x'.repeat(400)}` });
    return new Promise((resolve, reject) => {
      this.end = (how) => {
        if (how === 'fail') { reject(new Error('Codex App Server exited with code 1.')); return; }
        this.pid = 77;
        this.emit({ kind: 'ready' });
        resolve();
      };
    });
  }
  sendUserTurn(): void { /* nothing */ }
  interrupt(): void { /* nothing */ }
  async stop(): Promise<void> { /* nothing */ }
  isAlive(): boolean { return this.pid !== undefined; }
}

describe('the start-wait line on the Team row ends with the start (v0.9.97)', () => {
  it.each(['ready', 'fail'] as const)('is one bounded line, and gone after a start that ends %s', async (how) => {
    let backend!: ScriptedBackend;
    const sessions = new SessionManager(5, new MessageBus(), { createBackend: (agent) => (backend = new ScriptedBackend(agent)), resolveEnv: async () => ({}) });
    managers.push(sessions);
    sessions.create(config('a1', 'codex'));
    const started = sessions.start('a1', { pin: 'take' }).catch(() => undefined);
    await vi.waitFor(() => expect(sessions.get('a1')?.startWaitMessage).toBeDefined());
    const line = sessions.get('a1')!.startWaitMessage!;
    expect(line.startsWith(CHECKING.codex)).toBe(true);
    expect(line).not.toMatch(/\n/);
    expect(line.length).toBeLessThanOrEqual(200);
    backend.end(how);
    await started;
    expect(sessions.get('a1')?.startWaitMessage).toBeUndefined();
    expect(teamRow(sessions)).not.toContain(CHECKING.codex);
  });

  it('takes no line from a start that is no longer the agent\'s, or once it is no longer starting', async () => {
    let backend!: ScriptedBackend;
    const sessions = new SessionManager(5, new MessageBus(), { createBackend: (agent) => (backend = new ScriptedBackend(agent)), resolveEnv: async () => ({}) });
    managers.push(sessions);
    sessions.create(config('a1', 'codex'));
    const started = sessions.start('a1', { pin: 'take' }).catch(() => undefined);
    await vi.waitFor(() => expect(sessions.get('a1')?.startWaitMessage).toBeDefined());
    backend.end('ready');
    await started;
    backend.emit({ kind: 'start_pending', message: 'late' });
    expect(sessions.get('a1')?.startWaitMessage).toBeUndefined();
  });
});
