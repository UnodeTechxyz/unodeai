import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import { createTurnContextManifest, dispatchDelegatedSources, type DelegationContentSource } from '../TurnContextManifest';
import type { AgentConfig, UserAttachment } from '../../types';

vi.mock('vscode', () => ({}));

// v0.9.97 ATTACH-CODEX. USAGE "Context receipt" and CHANGELOG [Unreleased]: "Attached context lists an attachment
// only after the agent's route sent it." The session lists a user attachment, and a source an inline route carries,
// only from the route's own report of the payload it sent.

class ReportingBackend implements AgentBackend {
  readonly agentId: string;
  pid = 77;
  turns: string[] = [];
  inputs: Array<TurnAttachments | undefined> = [];
  private handler?: BackendEventHandler;
  constructor(config: AgentConfig, readonly delegatedSourceDelivery?: 'inline') { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { /* nothing to spawn */ }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void { this.turns.push(instruction); this.inputs.push(attachments); }
  async stop(): Promise<void> { this.emit({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return true; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function agent(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'm', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const textFile: UserAttachment = { name: 'notes.md', mime: 'text/markdown', kind: 'file', dataBase64: Buffer.from('# Notes').toString('base64'), size: 7 };
const image: UserAttachment = { name: 'shot.png', mime: 'image/png', kind: 'image', dataBase64: 'iVBORw0KGgo=', size: 8 };
const handed: DelegationContentSource[] = [
  { assetId: 'content-3', kind: 'user-attachment', label: 'brief.md', location: 'user text attachment', textBytes: 12, mediaKind: 'text' },
  { assetId: 'content-4', kind: 'user-attachment', label: 'photo.png', location: 'user image attachment', bytes: 40, mediaKind: 'image' },
];

async function harness(inline = false) {
  const bus = new MessageBus();
  let backend: ReportingBackend | undefined;
  const manifests: Array<{ manifest: { entries: Array<{ label: string; reason: string; kind: string }> }; epoch: number }> = [];
  const manager = new SessionManager(5, bus, {
    createBackend: (config) => (backend = new ReportingBackend(config, inline ? 'inline' : undefined)),
    resolveEnv: async () => ({}),
    getTurnContextBundle: (_config, message, options) => ({
      projectContext: '',
      contextManifest: createTurnContextManifest([
        { kind: 'user-request', label: 'Current task', location: 'chat', text: message.payload.instruction ?? '', reason: 'user-entered task' },
        // The extension's own rule for which forwarded sources the dispatch manifest lists.
        ...dispatchDelegatedSources(message.type, message.payload.delegationContentSources, options),
        { kind: 'project-conventions', label: 'Project conventions', location: 'workspace', text: 'Use npm test.', reason: 'fixed path' },
      ]),
    }),
  });
  manager.on('session.contextManifest', (event) => manifests.push(event.data as never));
  manager.create(agent('dev'));
  await manager.start('dev', { pin: 'take' });
  backend!.emit({ kind: 'ready' });
  const labels = (index = manifests.length - 1) => manifests[index].manifest.entries.map((entry) => entry.label);
  return { bus, manager, backend: backend!, manifests, labels };
}

describe('the turn manifest lists an attachment only from the route\'s report (v0.9.97)', () => {
  it('keeps the manifest of a turn without attachments at dispatch, as before', async () => {
    const { bus, manifests, labels } = await harness();
    bus.send('user', 'dev', 'ask.question', { instruction: 'Plain turn.', metadata: { turnEpoch: 2 } });
    expect(manifests).toHaveLength(1);
    expect(labels()).toEqual(['Current task', 'Project conventions']);
  });

  it('waits for the report, then lists only the attachments it names, after the request', async () => {
    const { bus, backend, manifests, labels } = await harness();
    bus.send('user', 'dev', 'ask.question', { instruction: 'Look.', userAttachments: [textFile, image], metadata: { turnEpoch: 3 } });
    expect(manifests).toEqual([]);
    const input = backend.inputs[0]!;
    backend.emit({ kind: 'turn_input_delivered', input, userAttachments: [1] });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].epoch).toBe(3);
    expect(labels()).toEqual(['Current task', 'shot.png', 'Project conventions']);
    expect(input.contextManifest?.entries.map((entry) => entry.label)).toEqual(['Current task', 'shot.png', 'Project conventions']);
  });

  it('ignores a report about another input, a second report, and a report after the turn ended', async () => {
    const { bus, backend, manifests } = await harness();
    bus.send('user', 'dev', 'ask.question', { instruction: 'Look.', userAttachments: [textFile], metadata: { turnEpoch: 4 } });
    const input = backend.inputs[0]!;
    backend.emit({ kind: 'turn_input_delivered', input: { ...input }, userAttachments: [0] });
    expect(manifests).toEqual([]);
    backend.emit({ kind: 'turn_input_delivered', input, userAttachments: [0, 0, 7, -1] });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].manifest.entries.filter((entry) => entry.kind === 'user-attachment').map((entry) => entry.label)).toEqual(['notes.md']);
    backend.emit({ kind: 'turn_input_delivered', input, userAttachments: [0] });
    expect(manifests).toHaveLength(1);
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } });

    bus.send('user', 'dev', 'ask.question', { instruction: 'Again.', userAttachments: [image], metadata: { turnEpoch: 5 } });
    const next = backend.inputs[1]!;
    backend.emit({ kind: 'turn_complete', result: { text: 'failed', isError: true, responseOutcome: { kind: 'error' } } });
    backend.emit({ kind: 'turn_input_delivered', input: next, userAttachments: [0] });
    expect(manifests).toHaveLength(1);
  });

  it('lists forwarded sources at dispatch for a route that reads them on demand', async () => {
    const { bus, backend, manifests, labels } = await harness(false);
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Use the brief.', delegationContentSources: handed });
    expect(manifests).toHaveLength(1);
    expect(labels()).toEqual(['Current task', 'Delegated user source: brief.md', 'Delegated user source: photo.png', 'Project conventions']);
    expect(backend.turns[0]).toContain('These sources are addressable, not copied into this turn.');
    expect(backend.inputs[0]?.receivedContentSources).toEqual(handed);
  });

  it('lists a forwarded source of an inline route only when its report names it', async () => {
    const { bus, backend, manifests, labels } = await harness(true);
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Use the brief.', delegationContentSources: handed });
    expect(manifests).toEqual([]);
    expect(backend.turns[0]).toContain('The host copies each of these sources that it may give you into this turn');
    expect(backend.turns[0]).not.toContain('read_extracted_content');
    expect(backend.inputs[0]?.receivedContentSources).toEqual(handed);
    backend.emit({ kind: 'turn_input_delivered', input: backend.inputs[0]!, userAttachments: [], delegatedSources: ['content-3', 'content-9'] });
    expect(labels()).toEqual(['Current task', 'Delegated user source: brief.md', 'Project conventions']);
    expect(manifests[0].manifest.entries[1].reason).toBe('coordinator forwarded this turn-supplied text source; the route reported it in the input it sent');
  });

  it('gives a user turn no received sources: a coordinator\'s forwarding receipts are not its own input', async () => {
    const { bus, backend } = await harness(true);
    bus.send('user', 'dev', 'ask.question', { instruction: 'Delegate this.', delegationContentSources: handed, metadata: { turnEpoch: 6 } });
    expect(backend.inputs[0]?.delegationContentSources).toEqual(handed);
    expect(backend.inputs[0]?.receivedContentSources).toBeUndefined();
  });
});
