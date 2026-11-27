import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { UserRequestPreparations } from '../../host/userRequestPreparations';

vi.mock('vscode', () => ({}));

function harness() {
  const store = new Map<string, unknown>();
  const preparations = new UserRequestPreparations();
  const submitted: string[] = [];
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
    send: (_agent, text) => { submitted.push(text); },
    interject: (_agent, text) => { submitted.push(text); },
    interrupt: vi.fn(), onReply: () => () => {},
    beginPreparation: (agent) => preparations.begin(agent),
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key, value) => { store.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
  };
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('pm');
  const message = (data: Record<string, unknown>, source = 'sidebar') => (provider as any).onMessage(data, source);
  const wait = (intentId: string) => message({ command: 'sendWaiting', agentId: 'pm', intentId, stopSeen: 0 });
  const send = (requestId: string | undefined, text: string, intentId?: string, source = 'sidebar') => message({
    command: 'send', agentId: 'pm', text, requestId, intentId, stopSeen: 0, attachments: [], mode: 'act',
  }, source);
  return { provider, preparations, submitted, wait, send };
}

describe('completed composer identities are not admitted again', () => {
  it('does not register a completed intent again after newer unrelated requests', () => {
    const h = harness();
    h.wait('original');
    h.send('r-original', 'Once.', 'original');
    for (let i = 0; i < 4; i++) {
      h.wait(`later-${i}`);
      h.send(`r-later-${i}`, `Later ${i}.`, `later-${i}`);
    }
    h.wait('original');
    expect(h.preparations.pending('pm')).toBe(0);
    h.send('r-replayed', 'Once.', 'original');
    expect(h.submitted.filter((text) => text === 'Once.')).toHaveLength(1);
    expect(h.submitted).toHaveLength(5);
  });

  it('admits a plain request id only once even when the agent is now running', () => {
    const h = harness();
    h.send('original', 'Once.');
    for (let i = 0; i < 4; i++) h.send(`later-${i}`, `Later ${i}.`);
    h.send('original', 'Once.');
    expect(h.submitted.filter((text) => text === 'Once.')).toHaveLength(1);
    expect(h.submitted).toHaveLength(5);
  });

  it('keeps distinct clicks, separate chat surfaces and legacy messages working', () => {
    const h = harness();
    h.send('one', 'Same text.');
    h.send('two', 'Same text.');
    h.send('one', 'Workbench.', undefined, 'workbench');
    h.send(undefined, 'Legacy.');
    h.send(undefined, 'Legacy.');
    expect(h.submitted).toEqual(['Same text.', 'Same text.', 'Workbench.', 'Legacy.', 'Legacy.']);
  });
});
