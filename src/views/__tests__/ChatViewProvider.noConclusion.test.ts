import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import type { TurnResponseOutcome } from '../../backend/AgentBackend';

/* v0.9.94: reasoning a turn showed stays, labelled as work that is not a conclusion, when the turn ends without a reply. */

const SHOWN = 'The parser fails on an empty header, so the fix is to guard the split.';

function receipt(turnId: string, delivery: TurnResponseOutcome) {
  return {
    schemaVersion: 1 as const, receiptId: `turn-outcome:${turnId}`, turnId, agentId: 'dev', recordedAt: '2026-10-08T10:00:00.000Z', delivery,
    tools: {
      coverage: 'complete' as const, total: 0, success: 0, refused: 0, failed: 0, failureKinds: {}, refusalReasons: {},
      unmatchedUses: 0, unmatchedResults: 0, excludedNativeActivities: 0, unjoinedHostDecisions: 0, observationGaps: 0,
    },
  };
}

function harness(store: Map<string, unknown>) {
  let onReply: ((reply: unknown) => void) | undefined;
  const send = vi.fn();
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'dev', name: 'Dev', role: 'Developer' }],
    send, interject: vi.fn(), interrupt: vi.fn(),
    onReply: (cb: (reply: unknown) => void) => { onReply = cb; return vi.fn(); },
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        if (value === undefined) store.delete(key); else store.set(key, structuredClone(value));
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as never);
  const items = (): any[] => (chat as any).currentState().messages;
  return {
    chat,
    send,
    items,
    reasoning: () => items().filter((item) => item.kind === 'reasoning'),
    end: (turnId: string, delivery: TurnResponseOutcome, text = '') => onReply!({
      from: 'dev', fromName: 'Dev', text, isError: false, completionState: 'complete', turnId,
      turnOutcome: receipt(turnId, delivery),
    }),
  };
}

const empty: TurnResponseOutcome = { kind: 'empty-reply', attempts: [{ attempt: 1, gateway: 'unode', inputBasis: 'unavailable' }] };

describe('reasoning of a turn that ended without a reply', () => {
  it.each([
    ['after tool calls', { kind: 'tool-only' } as TurnResponseOutcome],
    ['with an empty reply', empty],
  ])('keeps what was shown and labels it as not a conclusion: %s', (_name, delivery) => {
    const h = harness(new Map());
    h.chat.appendReasoning('dev', SHOWN);
    h.end('turn-1', delivery);
    expect(h.reasoning()).toHaveLength(1);
    expect(h.reasoning()[0]).toMatchObject({ kind: 'reasoning', text: SHOWN, nonConclusion: true });
    // It is not turned into a reply: no agent message carries the reasoning text.
    expect(h.items().some((item) => item.kind === 'message' && String(item.text).includes('guard the split'))).toBe(false);
  });

  it('leaves the reasoning of an answered turn as it was', () => {
    const h = harness(new Map());
    h.chat.appendReasoning('dev', SHOWN);
    h.end('turn-1', { kind: 'reply' }, 'Guard the split with a length check.');
    expect(h.reasoning()).toHaveLength(1);
    expect(h.reasoning()[0].nonConclusion).toBeUndefined();
  });

  it('labels every segment the turn showed, and none of the turn before', () => {
    const h = harness(new Map());
    h.chat.appendReasoning('dev', 'First turn thinking.');
    h.end('turn-1', { kind: 'reply' }, 'An answer.');
    h.chat.appendReasoning('dev', 'Second turn, first segment.');
    h.chat.appendToolActivity('dev', { phase: 'use', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } });
    h.chat.appendToolActivity('dev', { phase: 'result', callId: 'c1', name: 'read_file', outcome: { status: 'success', observedBy: 'host' }, summary: 'read' });
    h.chat.appendReasoning('dev', 'Second turn, second segment.');
    h.end('turn-2', { kind: 'tool-only' });
    expect(h.reasoning().map((item) => [item.text, item.nonConclusion === true])).toEqual([
      ['First turn thinking.', false],
      ['Second turn, first segment.', true],
      ['Second turn, second segment.', true],
    ]);
  });

  it('keeps the item and its label after a restart', () => {
    const store = new Map<string, unknown>();
    const first = harness(store);
    first.chat.appendReasoning('dev', SHOWN);
    first.end('turn-1', { kind: 'tool-only' });
    const restored = harness(store);
    expect(restored.reasoning()).toHaveLength(1);
    expect(restored.reasoning()[0]).toMatchObject({ text: SHOWN, nonConclusion: true });
  });

  it('starts nothing: no request is sent again for a turn that ended without a reply', () => {
    const h = harness(new Map());
    h.chat.appendReasoning('dev', SHOWN);
    h.end('turn-1', empty);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not take a stored label from anything but the host\'s own flag', () => {
    const store = new Map<string, unknown>([['roam.chat.reasoning.dev', [
      { kind: 'reasoning', id: 'r1', ts: '2026-10-08T10:00:00.000Z', seq: 1, text: 'one', nonConclusion: 'true' },
      { kind: 'reasoning', id: 'r2', ts: '2026-10-08T10:00:01.000Z', seq: 2, text: 'two', nonConclusion: true },
    ]]]);
    const stored = harness(store).reasoning();
    // A string is never the flag.
    expect(stored.map((item) => [item.id, item.nonConclusion === true])).toEqual([['r1', false], ['r2', true]]);
  });

  it('shows the label, open, in the view', () => {
    const html = (harness(new Map()).chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
    expect(html).toContain("'Work shown; no conclusion recorded'");
    expect(html).toContain("node.className = 'reasoning non-conclusion';");
    expect(html).toContain('body.compact .reasoning.non-conclusion .reasoning-body { display: block; }');
  });
});
