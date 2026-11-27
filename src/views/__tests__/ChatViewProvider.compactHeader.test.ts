import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

describe('compact Workbench session information', () => {
  it('keeps current session facts on the menu tooltip when the header folds', () => {
    const agent = { id: 'pm', name: 'PM', role: 'pm', backend: 'openai', model: 'first-model', observedModel: 'reported-model', costUsd: 1.25, turns: 2, costBasis: 'billed' };
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [agent], send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    (provider as any).rosterLoaded();
    provider.selectAgent('pm');
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:', asWebviewUri: (uri: unknown) => uri }, 'workbench'));
    const render = () => booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
    render();
    const menu = booted.elements.get('sessionMenuTrigger')!;
    expect(menu.title).toContain('first-model (CLI reports reported-model)');
    expect(menu.title).toContain('$1.250 used');
    expect(menu.title).toContain('2 turns');
    agent.model = 'second-model';
    render();
    expect(menu.title).toContain('second-model');
    expect(menu.title).not.toContain('first-model');
    expect(booted.elements.get('sessionSummary')!.hidden).toBe(false);
  });

  // v0.9.108 S2: the header names a subscription, a stopped turn's partial usage and unreported usage; never $0 or blank.
  it.each([
    [{ backend: 'codex', costUsd: 0, turns: 1 }, 'Subscription, no per-turn amount'],
    [{ backend: 'codex', costUsd: 0.02, turns: 1, costBasis: 'api-equivalent' }, 'Subscription (API-equivalent ~$0.020)'],
    [{ backend: 'openai', costUsd: 0.5, turns: 1, costBasis: 'estimated', costPartial: true }, 'Partial usage ~$0.500'],
    [{ backend: 'openai', costUsd: 0, turns: 1, costPartial: true }, 'Usage recorded, cost unknown'],
    [{ backend: 'openai', costUsd: 0, turns: 0, unknownTurns: 1 }, 'Usage not reported, cost unknown'],
  ])('shows %j as %s', (facts, expected) => {
    const agent = { id: 'pm', name: 'PM', role: 'pm', model: 'm', ...facts };
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [agent], send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    (provider as any).rosterLoaded(); provider.selectAgent('pm');
    const booted = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:', asWebviewUri: (uri: unknown) => uri }, 'workbench'));
    booted.listeners.message?.[0]?.({ data: { command: 'state', state: (provider as any).currentState() } });
    const text = booted.elements.get('sessionMenuTrigger')!.title as string;
    expect(text).toContain(' · ' + expected); expect(text).not.toMatch(/\$0(\.0+)? used/);
  });
});
