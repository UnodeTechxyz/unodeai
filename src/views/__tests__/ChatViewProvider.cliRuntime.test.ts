import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ChatAgent, ChatReply, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

/*
 * v0.9.96: the chat shows the requested model and, beside it, the model the CLI reported; a provider error that names
 * a too-old CLI gets one host line, and nothing is resent.
 */

function chat(agents: ChatAgent[]) {
  let reply: ((value: ChatReply) => void) | undefined;
  const store = new Map<string, unknown>();
  const deps = {
    listAgents: () => agents,
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: (callback: (value: ChatReply) => void) => { reply = callback; return () => undefined; },
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as unknown as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(agents[0].id);
  return { provider, deps, deliver: (value: ChatReply) => reply!(value) };
}

const facts = (provider: ChatViewProvider) => {
  const boot = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'workbench'));
  return String(boot.elements.get('sessionFacts')!.textContent);
};

const dev: ChatAgent = { id: 'dev', name: 'Dev', role: 'Developer', backend: 'claude', routeLabel: 'Claude CLI', model: 'claude-requested-1' };

describe('the model shown for a CLI agent (v0.9.96)', () => {
  it('shows the requested model, and the reported one beside it only once the CLI reported it', () => {
    expect(facts(chat([dev]).provider)).toBe('Developer · Claude CLI · claude-requested-1');
    expect(facts(chat([{ ...dev, observedModel: 'claude-remapped-1' }]).provider))
      .toBe('Developer · Claude CLI · claude-requested-1 (CLI reports claude-remapped-1)');
    expect(facts(chat([{ ...dev, model: undefined, observedModel: 'claude-x' }]).provider)).toBe('Developer · Claude CLI · CLI reports claude-x');
  });
});

describe('a provider error that names a too-old CLI (v0.9.96)', () => {
  it('adds the host line once, beside the error, and starts no new turn', () => {
    const { provider, deps, deliver } = chat([dev]);
    const failure: ChatReply = {
      from: 'dev', fromName: 'Dev', isError: true,
      text: "API Error: 400 Claude Code 2.1.209 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
      runtimeNotice: { noticeKey: 'cli-runtime:m1', text: 'Claude CLI: the provider says this CLI is 2.1.209 and that the model needs 2.1.280 or newer.' },
    };
    deliver(failure);
    deliver(failure);
    const messages = (provider as any).currentState().messages as Array<{ text?: string }>;
    expect(messages.filter((message) => message.text?.startsWith('Claude CLI: the provider says'))).toHaveLength(1);
    expect(messages.some((message) => message.text?.includes("Run 'claude update'"))).toBe(true);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.interject).not.toHaveBeenCalled();
  });
});
