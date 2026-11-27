import { describe, expect, it, vi } from 'vitest';
import type { ReworkContinueOutcome } from '../../../backend/TeamTools';
import { CONTINUE_REWORK, offerContinueRework, reworkContinueNotice } from '../continueRework';

/** v0.9.99 (B14): the Continue rework offer for a request held at the automatic cap. */
describe('Continue rework offer', () => {
  function harness(outcome: ReworkContinueOutcome = 'sent') {
    let answer!: (choice: string | undefined) => void;
    const shown: Array<{ text: string; button: string }> = [];
    const posted: string[] = [];
    let stopListener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const continueRework = vi.fn(() => outcome);
    offerContinueRework({
      show: (text, button) => {
        shown.push({ text, button });
        return new Promise((resolve) => { answer = resolve; });
      },
      onUserStop: (listener) => { stopListener = listener; return unsubscribe; },
      post: (text) => { posted.push(text); },
    }, 'PM', { agentName: 'Dev', rounds: 3 }, continueRework);
    const settle = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
    return { shown, posted, unsubscribe, continueRework, answer: (c: string | undefined) => answer(c), stop: () => stopListener?.(), settle };
  }

  it('describes the hold in one non-modal notification with one Continue rework button', () => {
    const { shown } = harness();
    expect(shown).toEqual([{
      text: 'PM has asked Dev to rework a task 3 times. Automatic rework stopped after two rounds; the result stands unless you continue.',
      button: CONTINUE_REWORK,
    }]);
  });

  it('a click sends the held request and says so in the PM chat', async () => {
    const h = harness('sent');
    h.answer(CONTINUE_REWORK);
    await h.settle();
    expect(h.continueRework).toHaveBeenCalledTimes(1);
    expect(h.posted).toEqual(['You continued the rework: the request was sent to Dev.']);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('after the person stopped the PM, a click sends nothing and says why', async () => {
    const h = harness('sent');
    h.stop();
    h.answer(CONTINUE_REWORK);
    await h.settle();
    expect(h.continueRework).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['Nothing was sent: you stopped the PM after automatic rework stopped.']);
  });

  it('a dismissed notification sends and posts nothing, and stops listening', async () => {
    const h = harness('sent');
    h.answer(undefined);
    await h.settle();
    expect(h.continueRework).not.toHaveBeenCalled();
    expect(h.posted).toEqual([]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('names each outcome in plain words', () => {
    expect(reworkContinueNotice('running', 'Dev')).toBe('Nothing more was sent: Dev is still working on an earlier rework of this task.');
    expect(reworkContinueNotice('stale', 'Dev')).toBe('Nothing was sent: Dev has delivered a newer result since. The PM reviews that one.');
    expect(reworkContinueNotice('decided', 'Dev')).toBe('Nothing was sent: the PM has since recorded another decision on this result, or you wrote to it.');
  });
});
