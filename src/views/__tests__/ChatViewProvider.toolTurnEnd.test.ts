import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';

vi.mock('vscode', () => ({}));

/**
 * v0.9.99 field run: a tool call Stop interrupted kept its card "Running" for good, and a much later turn's progress
 * line briefly counted it (643 s). A card left without a result is closed when its turn ends, as an unknown outcome.
 */
function harness() {
  const store = new Map<string, unknown>();
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
    send: vi.fn(), interrupt: vi.fn(), interject: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key, value) => { store.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
  };
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('pm');
  return provider;
}

const tools = (provider: ChatViewProvider) =>
  ((provider as any).currentState().messages as Array<Record<string, any>>).filter((item) => item.kind === 'tool');

describe('a tool card without a result is closed when its turn ends', () => {
  it('the end of a stopped turn closes an open card as an unknown outcome, and it no longer counts as running', () => {
    const provider = harness();
    provider.appendToolActivity('pm', { phase: 'use', callId: 'search-1', name: 'search_extracted_content', input: { query: 'x' } });
    expect(tools(provider).map((card) => card.phase)).toEqual(['use']);
    provider.postNotice('pm', 'Stopped by user.');
    const [card] = tools(provider);
    expect(card.phase).toBe('result');
    expect(card).toMatchObject({ ok: false, failureKind: 'outcome_unknown' });
    expect(card.summary).toBe('No result: the turn ended before this call reported one.');
  });

  it('a result that still arrives in the same turn replaces the closed card instead of adding one', () => {
    const provider = harness();
    provider.appendToolActivity('pm', { phase: 'use', callId: 'read-1', name: 'read_file', input: { path: 'a.txt' } });
    provider.postNotice('pm', 'Stopped by user.');
    provider.appendToolActivity('pm', { phase: 'result', callId: 'read-1', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'Read a.txt' });
    const cards = tools(provider);
    expect(cards).toHaveLength(1);
    expect(cards[0].ok).toBe(true);
    expect(cards[0].summary).toBe('Read a.txt');
    expect(cards[0].closedAtTurnEnd).toBeUndefined();
  });

  it('a later turn closes a card the previous turn left open before its own first card', () => {
    const provider = harness();
    provider.appendToolActivity('pm', { phase: 'use', callId: 'c1', name: 'read_file', input: { path: 'a.txt' }, epoch: 1 });
    provider.appendToolActivity('pm', { phase: 'use', callId: 'c1', name: 'list_dir', input: { path: '.' }, epoch: 2 });
    const cards = tools(provider);
    expect(cards.map((card) => [card.name, card.phase])).toEqual([['read_file', 'result'], ['list_dir', 'use']]);
    expect(cards[0]).toMatchObject({ ok: false, failureKind: 'outcome_unknown' });
  });
});
