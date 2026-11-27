import { describe, expect, it } from 'vitest';
import {
  CONTINUE_ACTION, OFFER_ENDED_NOTICE, UnrequestedTurnOffers, continueMessageText, unrequestedTurnOfferText,
  type UnrequestedTurnOfferDeps,
} from '../unrequestedTurnOffer';

/* v0.9.103 (F2, the Owner's option A): the non-modal Continue offer for a turn an agent's CLI began on its own. */

interface Shown { text: string; action: string; choose(choice: string | undefined): void }

function offers(options: { names?: Record<string, string>; current?: (sessionId: string, launchId: string) => boolean } = {}) {
  const shown: Shown[] = [];
  const informed: string[] = [];
  const sent: Array<{ sessionId: string; text: string }> = [];
  const order: string[] = [];
  const names = options.names ?? { 'agent-a': 'Ada', 'agent-b': 'Bo' };
  let current = options.current ?? (() => true);
  const deps: UnrequestedTurnOfferDeps = {
    show: (text, action) => new Promise<string | undefined>((resolve) => {
      shown.push({ text, action, choose: resolve });
    }),
    inform: (text) => { order.push('inform'); informed.push(text); },
    agentName: (sessionId) => names[sessionId],
    isCurrentLaunch: (sessionId, launchId) => { order.push(`check:${sessionId}:${launchId}`); return current(sessionId, launchId); },
    sendPersonMessage: (sessionId, text) => { order.push(`send:${sessionId}`); sent.push({ sessionId, text }); },
  };
  return {
    offers: new UnrequestedTurnOffers(deps), shown, informed, sent, order,
    setCurrent: (next: (sessionId: string, launchId: string) => boolean) => { current = next; },
  };
}

const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

describe('v0.9.103 F2: UnrequestedTurnOffers', () => {
  it('shows one non-modal offer per agent, naming the agent and the summary, with the Continue action', async () => {
    const t = offers();
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-a1', taskId: 'bgA', summary: 'Background command "a-one" completed (exit code 0)' });
    t.offers.offer({ sessionId: 'agent-b', launchId: 'launch-b1', taskId: 'bgB', summary: 'Background command "b-one" completed (exit code 0)' });
    expect(t.shown.map(({ text, action }) => ({ text, action }))).toEqual([
      { text: unrequestedTurnOfferText('Ada', 'Background command "a-one" completed (exit code 0)'), action: CONTINUE_ACTION },
      { text: unrequestedTurnOfferText('Bo', 'Background command "b-one" completed (exit code 0)'), action: CONTINUE_ACTION },
    ]);
    expect(t.shown[0].text).toBe('Ada: something it started in the background finished after your request ended (Background command "a-one" '
      + 'completed (exit code 0)). It can read files in that turn but cannot run commands or change files. To let it act on the result, press Continue.');
    expect(CONTINUE_ACTION).toBe('Continue');
    expect(t.sent).toEqual([]);
  });

  it('dismissing the offer sends nothing and informs nothing', async () => {
    const t = offers();
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-dismiss', summary: 'dismissed summary' });
    t.shown[0].choose(undefined);
    await settle();
    expect(t.sent).toEqual([]);
    expect(t.informed).toEqual([]);
  });

  it('Continue sends exactly one ordinary message to that agent, checked against its launch when chosen', async () => {
    const t = offers();
    t.offers.offer({ sessionId: 'agent-b', launchId: 'launch-continue', taskId: 'bgC', summary: 'Background command "c" completed (exit code 0)' });
    expect(t.order).toEqual(['check:agent-b:launch-continue']);
    t.shown[0].choose(CONTINUE_ACTION);
    await settle();
    expect(t.sent).toEqual([{ sessionId: 'agent-b', text: continueMessageText('Background command "c" completed (exit code 0)') }]);
    expect(t.sent[0].text).toBe('Continue: something you started in the background finished after my last request ended (Background command '
      + '"c" completed (exit code 0)). Check its result and finish what that request needs.');
    // The launch is checked again at the click, immediately before the send.
    expect(t.order).toEqual(['check:agent-b:launch-continue', 'check:agent-b:launch-continue', 'send:agent-b']);
    expect(t.informed).toEqual([]);
    await settle();
    expect(t.sent).toHaveLength(1);
  });

  it('a launch that is no longer current when Continue is chosen sends nothing and says so', async () => {
    const t = offers();
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-stale', summary: 'stale summary' });
    expect(t.shown).toHaveLength(1);
    // The agent was restarted, removed or stopped while the offer was open.
    t.setCurrent(() => false);
    t.shown[0].choose(CONTINUE_ACTION);
    await settle();
    expect(t.sent).toEqual([]);
    expect(t.informed).toEqual([OFFER_ENDED_NOTICE]);
    expect(OFFER_ENDED_NOTICE).toBe('That agent session has ended; nothing was sent.');
  });

  it('a second wake of the same agent while its offer is open adds no offer; one Continue sends one message; a later wake offers again', async () => {
    const t = offers();
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-twice', taskId: 'bg1', summary: 'first wake summary' });
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-twice', taskId: 'bg2', summary: 'second wake summary' });
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0].text).toContain('first wake summary');
    t.shown[0].choose(CONTINUE_ACTION);
    await settle();
    expect(t.sent).toEqual([{ sessionId: 'agent-a', text: continueMessageText('first wake summary') }]);
    // The offer is closed now; the next wake gets its own.
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-twice', taskId: 'bg3', summary: 'third wake summary' });
    expect(t.shown).toHaveLength(2);
    expect(t.shown[1].text).toContain('third wake summary');
  });

  it('an agent that is gone, or a launch that is not current, gets no offer at all', async () => {
    const t = offers({ current: (_sessionId, launchId) => launchId !== 'launch-old' });
    t.offers.offer({ sessionId: 'agent-missing', launchId: 'launch-x', summary: 'no such agent' });
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-old', summary: 'old launch' });
    expect(t.shown).toEqual([]);
    // Neither left an outstanding offer behind.
    t.offers.offer({ sessionId: 'agent-a', launchId: 'launch-new', summary: 'new launch' });
    expect(t.shown).toHaveLength(1);
  });
});
