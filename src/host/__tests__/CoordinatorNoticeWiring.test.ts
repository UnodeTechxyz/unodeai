import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';

vi.mock('vscode', () => ({}));

/**
 * v0.9.103 (action-needed messages): the coordinator's chat gets host lines while its own turn runs. A dispatch that
 * lets a teammate reach outside the workspace says so, and a check that commands Off blocked says how to turn them on.
 * The actual wiring of activation paints them as runtime lines: the turn keeps running, its open tool card stays open,
 * and the composer keeps its Stop. A line posted in place of a turn would close all three while the turn goes on.
 */
function activationWiring(chatViewProvider: unknown): (coordinatorId: string, text: string) => void {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'publishCoordinatorNotice') found.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found, 'activation wires publishCoordinatorNotice exactly once').toHaveLength(1);
  const js = ts.transpileModule(`const wiring = ${found[0].getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('chatViewProvider', `${js}; return wiring;`)(chatViewProvider);
}

function runningPm() {
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
  // The PM's turn is in its dispatch call: the call's card is open and the turn is running.
  provider.appendToolActivity('pm', { phase: 'use', callId: 'dispatch-1', name: 'dispatch_task', input: { agent: 'dev' } });
  return provider;
}

const state = (provider: ChatViewProvider) => (provider as any).currentState() as { messages: Array<Record<string, any>> };

describe('the coordinator notice of activation, while the coordinator\'s turn runs', () => {
  it('paints the line in its chat and leaves the turn, its open card and its start time as they were', () => {
    const provider = runningPm();
    const startedAt = (provider as any).turnStartedAt.get('pm');
    expect((provider as any).runningAgentIds.has('pm')).toBe(true);
    const postNotice = vi.spyOn(provider, 'postNotice');
    const text = 'This task lets Dev reach outside this workspace: /elsewhere/brief.txt (Read). It applies to this task only. To stop it, use Stop.';

    activationWiring(provider)('pm', text);

    expect(postNotice).not.toHaveBeenCalled();
    const messages = state(provider).messages;
    expect(messages.filter((item) => item.runtimeNotice && item.text === text)).toHaveLength(1);
    // The turn goes on: still running, from the same start, and the dispatch card is not closed as "No result".
    expect((provider as any).runningAgentIds.has('pm')).toBe(true);
    expect((provider as any).turnStartedAt.get('pm')).toBe(startedAt);
    const card = messages.find((item) => item.kind === 'tool' && item.callId === 'dispatch-1');
    expect(card).toMatchObject({ phase: 'use' });
    expect(card?.closedAtTurnEnd).toBeUndefined();
  });
});
