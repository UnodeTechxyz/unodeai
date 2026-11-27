/*
 * v0.9.97 P4: a user's own request tells its agent the ids of the files the user attached, which save_attachment
 * takes (handoff §5: "asset_id" of a live user attachment granted to this agent and turn). The ids go in what the
 * model is sent; the agent's displayed task and the request's token record keep the user's own words.
 */
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';
import type { DelegationContentSource } from '../TurnContextManifest';

class RecordingBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.handler?.({ kind: 'ready' }); }
  sendUserTurn(instruction: string, _attachments?: TurnAttachments): void { this.turns.push(instruction); }
  /** End the running turn, so the next message is delivered. */
  finishTurn(): void { this.handler?.({ kind: 'turn_complete', result: { text: 'done', isError: false } }); }
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing to stop */ }
  isAlive(): boolean { return true; }
}

function agent(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev' as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'm', systemPrompt: '',
    autoApprove: true, allowedTools: [],
  };
}

const IMAGE: DelegationContentSource = { assetId: 'content-7', kind: 'user-attachment', label: 'logo.png', location: 'user image attachment', bytes: 70, mediaKind: 'image' };
const REQUEST: DelegationContentSource = { assetId: 'content-6', kind: 'user-request', label: 'Current task', location: 'chat composer', textBytes: 7, mediaKind: 'text' };

async function manager() {
  const bus = new MessageBus();
  const backends = new Map<string, RecordingBackend>();
  const sessions = new SessionManager(5, bus, {
    createBackend: (config) => {
      const backend = new RecordingBackend(config);
      backends.set(config.id, backend);
      return backend;
    },
    resolveEnv: async () => ({}),
  });
  sessions.create(agent('dev'));
  await sessions.start('dev', { pin: 'take' });
  return { bus, sessions, backend: () => backends.get('dev')! };
}

describe('the ids of a user request\'s attachments (handoff §5)', () => {
  it('are named in what the model is sent, not in the displayed task', async () => {
    const { bus, sessions, backend } = await manager();
    bus.send('user', 'dev', 'ask.question', { instruction: 'save it', delegationContentSources: [REQUEST, IMAGE] });
    const [sent] = backend().turns;
    expect(sent.startsWith('save it\n\n[attachments of this request]\n')).toBe(true);
    expect(sent).toContain('- content-7: image 1 of 1, 70 bytes');
    // The request's own text is no attachment and is not listed; nor is the file's name.
    expect(sent).not.toContain('content-6');
    expect(sent).not.toContain('logo.png');
    expect(sessions.get('dev')!.currentTask).toBe('save it');
  });

  it('are not added to a turn without attachments, nor to work a teammate hands on', async () => {
    const { bus, backend } = await manager();
    bus.send('user', 'dev', 'ask.question', { instruction: 'just talk', delegationContentSources: [REQUEST] });
    expect(backend().turns[0]).toBe('just talk');
    backend().finishTurn();
    // A delegate learns the ids from its handoff, which names them already; a teammate's message carries none.
    bus.send('pm', 'dev', 'agent.message', { message: 'look', delegationContentSources: [IMAGE] } as never);
    expect(backend().turns).toHaveLength(2);
    expect(backend().turns[1]).toContain('look');
    expect(backend().turns[1]).not.toContain('[attachments of this request]');
  });
});
