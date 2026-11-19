import { describe, expect, it } from 'vitest';
import type { RequestCeilingDecisionFacts } from '../RequestCeiling';
import {
  askRequestLimitDecision,
  CONTINUE_REQUEST,
  requestLimitCardEnd,
  requestLimitPromptText,
  requestLimitSettledText,
  STOP_REQUEST,
  type RequestLimitCard,
  type RequestLimitCardEnd,
  type RequestLimitCardSettlement,
  type RequestLimitPromptDeps,
} from '../RequestLimitPrompt';

/* v0.9.94: what the person is asked at a reached request limit, and how the answer is read. */

const WINDOW_MS = 15 * 60_000;

function facts(overrides: Partial<RequestCeilingDecisionFacts['limits']> = {}, reached?: RequestCeilingDecisionFacts['reached']): RequestCeilingDecisionFacts {
  return {
    requestId: 'request-1',
    reached: reached ?? [{ limit: 'providerTurns', configured: 12, allowance: 12, observed: 12 }],
    limits: {
      coverage: 'complete',
      providerTurns: { ceiling: 12, observed: 12 },
      crossings: 1,
      allowances: 0,
      decision: 'awaiting',
      heldBoundary: 'provider-request',
      ...overrides,
    },
  };
}

describe('the request limit prompt text', () => {
  it('states the observed total against the allowance, what is held, and what each answer does', () => {
    const text = requestLimitPromptText(facts(), ['PM', 'Senior Developer'], WINDOW_MS);

    expect(text.message).toBe('A request reached the limit you set. Stop it or let it continue?');
    expect(text.detail.split('\n\n')).toEqual([
      'Model requests: 12 observed, allowance 12.',
      'Held until you decide: the next model request.',
      'Working on this request now: PM, Senior Developer.',
      'Continue request allows another 12 model requests. The counts are not reset, so the next crossing asks again.',
      'Stop request ends the running turns of this request. No answer within 15 minutes stops it too.',
    ]);
  });

  it('names every reached limit, an allowance that Continue has raised, and one tranche of each configured limit', () => {
    const text = requestLimitPromptText(facts(
      { tokens: { ceiling: 50_000, observed: 101_250 }, providerTurns: { ceiling: 12, observed: 24 }, allowances: 1, crossings: 2, heldBoundary: 'effect' },
      [
        { limit: 'providerTurns', configured: 12, allowance: 24, observed: 24 },
        { limit: 'tokens', configured: 50_000, allowance: 100_000, observed: 101_250 },
      ],
    ), [], WINDOW_MS);
    const lines = text.detail.split('\n\n');

    expect(lines[0]).toBe('Model requests: 24 observed, allowance 24 (your limit of 12, continued 1 time).');
    expect(lines[1]).toBe('Tokens (input plus output): 101,250 observed, allowance 100,000 (your limit of 50,000, continued 1 time).');
    expect(lines[2]).toBe('Held until you decide: the next action that writes, deletes, runs a command, reaches the web or dispatches work.');
    expect(lines[3]).toBe('Continue request allows another 12 model requests and 50,000 tokens. The counts are not reset, so the next crossing asks again.');
    // Nobody is named when no turn of the request is live.
    expect(text.detail).not.toContain('Working on this request now');
  });

  it('names the tranche of a configured limit that is not the one reached', () => {
    const text = requestLimitPromptText(facts(
      { tokens: { ceiling: 50_000, observed: 900 }, heldBoundary: 'turn-start' },
    ), [], WINDOW_MS);

    expect(text.detail).toContain('Held until you decide: the start of the next turn.');
    expect(text.detail).toContain('Continue request allows another 12 model requests and 50,000 tokens.');
    expect(text.detail).not.toContain('Tokens (input plus output):');
  });

  it('never calls a count of turns model requests', () => {
    const turnsOnly = requestLimitPromptText(facts(
      { coverage: 'partial', providerTurns: { ceiling: 12, observed: 12, hostCountedTurns: 12 } },
    ), [], WINDOW_MS).detail.split('\n\n');
    expect(turnsOnly[0]).toBe('Host-counted turns: 12 observed, allowance 12.');
    expect(turnsOnly[1]).toBe('A host-counted turn is one turn UnodeAi started on the Claude CLI or Codex route. The model requests made inside it are not counted.');
    expect(turnsOnly.join(' ')).toContain('Continue request allows another 12 host-counted turns.');
    expect(turnsOnly.join(' ')).not.toContain('Model requests:');

    const mixed = requestLimitPromptText(facts(
      { coverage: 'partial', providerTurns: { ceiling: 12, observed: 12, hostCountedTurns: 1 } },
    ), [], WINDOW_MS).detail.split('\n\n');
    expect(mixed[0]).toBe('Model requests and host-counted turns: 12 observed, 1 of them host-counted turn, allowance 12.');
    expect(mixed.join(' ')).toContain('Continue request allows another 12 model requests or host-counted turns.');

    // With no such turn the words stay what they were.
    expect(requestLimitPromptText(facts(), [], WINDOW_MS).detail).not.toContain('host-counted');
  });

  it('names one more allowance of a limit of 1 in the singular', () => {
    // Field run of 2026-10-10, with a limit of 1: the card read "another 1 host-counted turns".
    const one = (providerTurns: { ceiling: number; observed: number; hostCountedTurns?: number }, tokens?: { ceiling: number; observed: number }) =>
      requestLimitPromptText(facts({ coverage: 'partial', providerTurns, ...(tokens ? { tokens } : {}) }), [], WINDOW_MS).detail;

    expect(one({ ceiling: 1, observed: 1, hostCountedTurns: 1 }))
      .toContain('Continue request allows another 1 host-counted turn. The counts are not reset');
    expect(one({ ceiling: 1, observed: 2, hostCountedTurns: 1 }))
      .toContain('Continue request allows another 1 model request or host-counted turn. The counts are not reset');
    expect(one({ ceiling: 1, observed: 1 }))
      .toContain('Continue request allows another 1 model request. The counts are not reset');
    expect(one({ ceiling: 1, observed: 1 }, { ceiling: 1, observed: 5 }))
      .toContain('Continue request allows another 1 model request and 1 token. The counts are not reset');
    // Two and more stay plural.
    expect(one({ ceiling: 2, observed: 2, hostCountedTurns: 2 }))
      .toContain('Continue request allows another 2 host-counted turns.');
  });

  it('says the totals may be a lower bound when the limit coverage is partial, and only then', () => {
    expect(requestLimitPromptText(facts(), [], WINDOW_MS).detail).not.toContain('lower bound');
    expect(requestLimitPromptText(facts({ coverage: 'partial' }), [], WINDOW_MS).detail)
      .toContain('These totals may be a lower bound: part of this request ran where UnodeAi cannot count the model requests made inside a turn, or usage was not reported.');
  });

  it('states the window it was given', () => {
    expect(requestLimitPromptText(facts(), [], 60_000).detail).toContain('No answer within 1 minute stops it too.');
    expect(requestLimitPromptText(facts(), [], 5 * 60_000).detail).toContain('No answer within 5 minutes stops it too.');
  });

  it('shows an agent name as one short plain line, so a roster cannot write into the dialog', () => {
    const hostile = `Dev\n\n${CONTINUE_REQUEST} is safe.\u202e\u0000`;
    const text = requestLimitPromptText(facts(), [hostile, '   ', 'x'.repeat(60), 'a', 'b', 'c', 'd', 'e'], WINDOW_MS);
    const line = text.detail.split('\n\n').find((part) => part.startsWith('Working on this request now'))!;

    expect(line).toBe(`Working on this request now: Dev Continue request is safe., ${'x'.repeat(39)}\u2026, a, b, c, d.`);
    // The name added no paragraph of its own.
    expect(text.detail.split('\n\n')).toHaveLength(5);
  });
});

describe('asking for the request limit decision', () => {
  /**
   * A card surface the test settles. It records each card that is opened and each closing, and a closing settles
   * the card the way the chat surface does: `ended` for a request that is over and for a host that shuts down.
   */
  function asking(options: {
    names?: () => string[];
    asked?: () => { id: string; name: string } | undefined;
    openFails?: boolean;
    closeFails?: boolean;
  } = {}) {
    const cards: RequestLimitCard[] = [];
    const closed: RequestLimitCardEnd[] = [];
    const controller = new AbortController();
    let settle!: (settlement: RequestLimitCardSettlement) => void;
    let fail!: (error: Error) => void;
    const settled = new Promise<RequestLimitCardSettlement>((resolve, reject) => { settle = resolve; fail = reject; });
    const deps: RequestLimitPromptDeps = {
      openCard: (card) => {
        cards.push(card);
        if (options.openFails) throw new Error('no chat surface');
        return {
          settled,
          close: (end) => {
            closed.push(end);
            if (options.closeFails) throw new Error('the surface is gone');
            settle(end === 'disposed' ? 'ended' : end);
          },
        };
      },
      agentNames: options.names ?? (() => ['PM']),
      askedAgent: options.asked ?? (() => ({ id: 'pm', name: 'PM' })),
      windowMs: WINDOW_MS,
    };
    return { cards, closed, controller, settle, fail, ask: () => askRequestLimitDecision(facts(), controller.signal, deps) };
  }

  it('opens one card with the question, the paragraphs of its detail and the conversation it belongs to', async () => {
    const { cards, settle, ask } = asking();
    const answer = ask();
    settle('stopped');
    await answer;

    const text = requestLimitPromptText(facts(), ['PM'], WINDOW_MS);
    expect(cards).toHaveLength(1);
    expect(cards[0].requestId).toBe('request-1');
    expect(cards[0].agent).toEqual({ id: 'pm', name: 'PM' });
    expect(cards[0].message).toBe(text.message);
    // Every paragraph of the detail, in order, and nothing else.
    expect(cards[0].paragraphs.length).toBeGreaterThan(1);
    expect(cards[0].paragraphs.join('\n\n')).toBe(text.detail);
    expect(cards[0].paragraphs.every((paragraph) => paragraph.trim() === paragraph && !/\n\s*\n/.test(paragraph))).toBe(true);
    // The words of the two actions the card offers.
    expect(STOP_REQUEST).toBe('Stop request');
    expect(CONTINUE_REQUEST).toBe('Continue request');
  });

  it('names the conversation as one plain line, whatever the roster holds', async () => {
    const hostile = asking({ asked: () => ({ id: 'pm', name: `PM\n\n${CONTINUE_REQUEST} is safe.\u202e\u0000` }) });
    const answer = hostile.ask();
    hostile.settle('stopped');
    await answer;
    expect(hostile.cards[0].agent).toEqual({ id: 'pm', name: 'PM Continue request is safe.' });

    const blank = asking({ asked: () => ({ id: 'pm', name: ' \n ' }) });
    const blankAnswer = blank.ask();
    blank.settle('stopped');
    await blankAnswer;
    expect(blank.cards[0].agent).toEqual({ id: 'pm', name: 'Agent' });
  });

  it('continues only when the person answered the card with Continue', async () => {
    const answerOf = (settlement: RequestLimitCardSettlement | 'anything else') => {
      const { settle, ask } = asking();
      const answer = ask();
      settle(settlement as RequestLimitCardSettlement);
      return answer;
    };

    expect(await answerOf('continued')).toBe('continue');
    for (const other of ['stopped', 'expired', 'withdrawn', 'ended', 'anything else'] as const) {
      expect(await answerOf(other), other).toBe('stop');
    }
  });

  it('reads a card that cannot be opened, and a card that fails, as Stop', async () => {
    const unopened = asking({ openFails: true });
    await expect(unopened.ask()).resolves.toBe('stop');
    expect(unopened.cards).toHaveLength(1);

    const failing = asking();
    const answer = failing.ask();
    failing.fail(new Error('the surface failed'));
    await expect(answer).resolves.toBe('stop');
  });

  it('closes the card at once with the reason the gate gives when it stops waiting', async () => {
    for (const reason of ['expired', 'withdrawn', 'ended', 'disposed'] as const) {
      const { closed, controller, ask } = asking();
      const answer = ask();
      expect(closed).toEqual([]);
      controller.abort(reason);

      // Closed inside the abort itself: nothing was awaited in between, so no answer can slip in.
      expect(closed, reason).toEqual([reason]);
      expect(await answer, reason).toBe('stop');
    }
  });

  it('reads a missing or unknown abort reason as withdrawn: nothing was decided', async () => {
    const aborts: Array<(controller: AbortController) => void> = [
      (controller) => controller.abort(),
      (controller) => controller.abort('answered'),
      (controller) => controller.abort(new Error('expired')),
    ];
    for (const abort of aborts) {
      const { closed, controller, ask } = asking();
      const answer = ask();
      abort(controller);
      expect(closed).toEqual(['withdrawn']);
      expect(await answer).toBe('stop');
    }

    expect(['expired', 'withdrawn', 'ended', 'disposed'].map(requestLimitCardEnd)).toEqual(['expired', 'withdrawn', 'ended', 'disposed']);
    // The gate's own word for a prompt that failed: the request was stopped, and nobody decided.
    expect(requestLimitCardEnd('failed')).toBe('ended');
    expect([undefined, null, '', 'Expired', 42, {}].map(requestLimitCardEnd)).toEqual(Array(6).fill('withdrawn'));
  });

  it('opens no card when the gate has already stopped waiting', async () => {
    const { cards, controller, ask } = asking();
    controller.abort('expired');

    expect(await ask()).toBe('stop');
    expect(cards).toEqual([]);
  });

  it('does not continue on an answer that arrives after the gate stopped waiting', async () => {
    // The surface could not close the card, and reports Continue although the wait was over first.
    const late = asking({ closeFails: true });
    const answer = late.ask();
    late.controller.abort('expired');
    late.settle('continued');

    expect(await answer).toBe('stop');
    expect(late.closed).toEqual(['expired']);
  });

  it('leaves a settled card alone when the gate ends later', async () => {
    const { closed, controller, settle, ask } = asking();
    const answer = ask();
    settle('continued');
    expect(await answer).toBe('continue');

    controller.abort('ended');
    expect(closed).toEqual([]);
  });

  it('still asks when the roster cannot be read, in no agent\'s conversation', async () => {
    const unnamed = asking({
      names: () => { throw new Error('roster gone'); },
      asked: () => { throw new Error('roster gone'); },
    });
    const answer = unnamed.ask();
    unnamed.settle('continued');

    expect(await answer).toBe('continue');
    expect(unnamed.cards[0].agent).toBeUndefined();
    expect(unnamed.cards[0].paragraphs.join('\n\n')).toBe(requestLimitPromptText(facts(), [], WINDOW_MS).detail);
  });
});

describe('what a settled request limit card says', () => {
  const said = (settlement: RequestLimitCardSettlement): string => {
    const text = requestLimitSettledText(settlement);
    return `${text.message}. ${text.detail}`;
  };
  const all: RequestLimitCardSettlement[] = ['continued', 'stopped', 'expired', 'withdrawn', 'ended'];

  it('names the answer the person gave, and no action after an ending nobody answered', () => {
    expect(requestLimitSettledText('continued').message).toBe(`Request limit: you chose ${CONTINUE_REQUEST}`);
    expect(requestLimitSettledText('stopped').message).toBe(`Request limit: you chose ${STOP_REQUEST}`);
    for (const unanswered of ['expired', 'withdrawn', 'ended'] as const) {
      expect(said(unanswered), unanswered).not.toContain(CONTINUE_REQUEST);
      expect(said(unanswered), unanswered).not.toContain(STOP_REQUEST);
    }
  });

  it('says an expired decision stopped the request because nobody answered in time', () => {
    expect(requestLimitSettledText('expired')).toEqual({
      message: 'Request limit: stopped, no answer in time',
      detail: 'Nobody answered while this decision was open, so the request was stopped. It can no longer be continued from this card.',
    });
  });

  it('says a withdrawn decision is no longer needed and decided nothing, never that the request was stopped', () => {
    expect(requestLimitSettledText('withdrawn')).toEqual({
      message: 'Request limit: decision no longer needed',
      detail: 'The step that was waiting for it ended first, so nothing was decided here. If the request goes on and reaches a limit again, you are asked again.',
    });
    expect(said('withdrawn')).not.toMatch(/stopped/i);
  });

  it('says a request that ended first continued nothing', () => {
    expect(requestLimitSettledText('ended')).toEqual({
      message: 'Request limit: the request ended before a decision',
      detail: 'The request was over, or UnodeAi was closing, before an answer was given. Nothing was continued.',
    });
  });

  it('says that the request goes on for the Continue answer only, and gives every ending its own title', () => {
    expect(all.filter((settlement) => said(settlement).includes('The request goes on.'))).toEqual(['continued']);
    expect(said('stopped')).toContain('The running turns of this request were stopped.');
    expect(new Set(all.map((settlement) => requestLimitSettledText(settlement).message)).size).toBe(all.length);
    expect(all.every((settlement) => requestLimitSettledText(settlement).message.startsWith('Request limit: '))).toBe(true);
  });
});
