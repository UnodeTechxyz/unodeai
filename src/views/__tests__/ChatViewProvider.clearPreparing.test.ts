import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { prepareAndSubmit, UserRequestPreparations } from '../../host/userRequestPreparations';

/**
 * v0.9.99 (audit of 036061e6, M1): clearing or archiving a conversation whose message is still being prepared cancels
 * that message, and the chat is no longer shown working on it, so the next message is an ordinary send. A turn of the
 * agent that is genuinely running keeps its running state. The real chat view runs over the real preparation tracker.
 */
describe('Clear and Archive settle a message still being prepared', () => {
  function chat(turnRunning = false) {
    const preparations = new UserRequestPreparations();
    const finishes: Array<() => void> = [];
    const outcomes: Array<Promise<unknown>> = [];
    const submit = vi.fn();
    const steer = vi.fn();
    const state = new Map<string, unknown>();
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'dev', name: 'Dev', role: 'Developer', status: 'idle', backend: 'openai' }],
      send: (id: string) => {
        outcomes.push(prepareAndSubmit(preparations, id, {
          prepare: () => new Promise<void>((resolve) => { finishes.push(resolve); }), submit,
        }));
      },
      interject: steer, interrupt: () => {}, onReply: () => () => {},
      // The extension's own port: a cancelled message settles the chat unless a turn of the agent is running.
      retirePreparing: (id: string) => preparations.cancel(id) > 0 && !turnRunning,
      state: { get: (key: string) => state.get(key), update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); } },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: () => {},
    } as unknown as ChatViewDeps);
    provider.selectAgent('dev');
    const sendText = (requestId: string, text: string) =>
      (provider as any).onMessage({ command: 'send', agentId: 'dev', requestId, text, mode: 'act', attachments: [] }, 'sidebar');
    const running = () => ((provider as any).currentState().runningAgentIds as string[]).includes('dev');
    return { provider, preparations, finishes, outcomes, submit, steer, sendText, running };
  }

  it.each(['clear', 'archive'] as const)('%s: the cancelled message is not sent and the next message is an ordinary send', async (how) => {
    const c = chat();
    try {
      c.sendText('s1', 'Read @https://example.com');
      expect(c.running()).toBe(true);
      if (how === 'clear') c.provider.clearSelectedAgent();
      else expect(c.provider.archiveSelectedAgent()).toBe(1);
      expect(c.preparations.pending('dev')).toBe(0);
      expect(c.running()).toBe(false);
      c.finishes[0]();
      await c.outcomes[0];
      expect(c.submit).not.toHaveBeenCalled();
      c.sendText('s2', 'Fresh request');
      expect(c.steer).not.toHaveBeenCalled();
      expect(c.preparations.pending('dev')).toBe(1);
    } finally { c.provider.dispose(); }
  });

  it('a turn of the agent that is running keeps the chat working', () => {
    const c = chat(true);
    try {
      c.sendText('s1', 'Read @https://example.com');
      c.provider.clearSelectedAgent();
      expect(c.preparations.pending('dev')).toBe(0);
      expect(c.running()).toBe(true);
    } finally { c.provider.dispose(); }
  });

  it('a clear with no message being prepared leaves the running state as it was', async () => {
    const c = chat();
    try {
      c.sendText('s1', 'Read @https://example.com');
      c.finishes[0]();
      await c.outcomes[0];
      c.provider.clearSelectedAgent();
      // The message was submitted: its turn, not the clear, ends the running state.
      expect(c.submit).toHaveBeenCalledTimes(1);
      expect(c.running()).toBe(true);
    } finally { c.provider.dispose(); }
  });
});
