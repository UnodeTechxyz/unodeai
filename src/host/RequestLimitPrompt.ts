/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request limit prompt (v0.9.94)
 *
 *  What the person is asked when a request reaches a limit they set, and how their answer is read. The text
 *  carries totals and classes only: no prompt, path, tool input or model output. The question is a card in
 *  Chat with two actions, Stop first, and only the Continue action continues: a card that cannot be opened, a
 *  card that is closed without an answer and any other answer stop the request.
 *
 *  VS Code-free: the card itself arrives as a dependency.
 *--------------------------------------------------------------------------------------------*/

import type { RequestCeilingDecision, RequestCeilingDecisionFacts, RequestLimitKind } from './RequestCeiling';

export const STOP_REQUEST = 'Stop request';
export const CONTINUE_REQUEST = 'Continue request';

export interface RequestLimitPromptText {
  message: string;
  detail: string;
}

const whole = (value: number): string => Math.max(0, Math.floor(value)).toLocaleString('en-US');
const times = (count: number): string => `${whole(count)} ${count === 1 ? 'time' : 'times'}`;

/**
 * What the provider-turn count is a count of. Where a CLI makes the model requests inside a turn, the host counts
 * the turn as one, and a count of turns is never called a count of model requests.
 */
function countedAs(limits: RequestCeilingDecisionFacts['limits']): Record<RequestLimitKind, { label: string; noun: string; one: string }> {
  const counted = limits.providerTurns?.observed ?? 0;
  const turns = limits.providerTurns?.hostCountedTurns ?? 0;
  const providerTurns = turns === 0
    ? { label: 'Model requests', noun: 'model requests', one: 'model request' }
    : turns === counted
      ? { label: 'Host-counted turns', noun: 'host-counted turns', one: 'host-counted turn' }
      : { label: 'Model requests and host-counted turns', noun: 'model requests or host-counted turns', one: 'model request or host-counted turn' };
  return { providerTurns, tokens: { label: 'Tokens (input plus output)', noun: 'tokens', one: 'token' } };
}
const HELD_BOUNDARY: Record<NonNullable<RequestCeilingDecisionFacts['limits']['heldBoundary']>, string> = {
  'provider-request': 'the next model request',
  effect: 'the next action that writes, deletes, runs a command, reaches the web or dispatches work',
  'turn-start': 'the start of the next turn',
};

/** A name as one plain line of at most 40 characters, so a roster cannot write into the decision's text. */
function plainName(name: string): string | undefined {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

export function requestLimitPromptText(
  facts: RequestCeilingDecisionFacts,
  agentNames: readonly string[],
  windowMs: number,
): RequestLimitPromptText {
  const { limits, reached } = facts;
  const words = countedAs(limits);
  const hostCountedTurns = limits.providerTurns?.hostCountedTurns ?? 0;
  const lines: string[] = [];
  for (const { limit, configured, allowance, observed } of reached) {
    const raised = allowance !== configured
      ? ` (your limit of ${whole(configured)}, continued ${times(limits.allowances)})`
      : '';
    const turns = limit === 'providerTurns' && hostCountedTurns > 0 && hostCountedTurns < observed
      ? `, ${whole(hostCountedTurns)} of them host-counted ${hostCountedTurns === 1 ? 'turn' : 'turns'}`
      : '';
    lines.push(`${words[limit].label}: ${whole(observed)} observed${turns}, allowance ${whole(allowance)}${raised}.`);
  }
  if (hostCountedTurns > 0) {
    lines.push('A host-counted turn is one turn UnodeAi started on the Claude CLI or Codex route. The model requests made inside it are not counted.');
  }
  if (limits.heldBoundary) lines.push(`Held until you decide: ${HELD_BOUNDARY[limits.heldBoundary]}.`);
  const names = agentNames.map(plainName).filter((name): name is string => name !== undefined).slice(0, 6);
  if (names.length > 0) lines.push(`Working on this request now: ${names.join(', ')}.`);
  if (limits.coverage !== 'complete') {
    lines.push('These totals may be a lower bound: part of this request ran where UnodeAi cannot count the model requests made inside a turn, or usage was not reported.');
  }
  // One tranche of every limit the person configured, whether or not that one is reached.
  const tranche = (['providerTurns', 'tokens'] as const)
    .map((limit) => {
      const configured = limit === 'providerTurns' ? limits.providerTurns?.ceiling : limits.tokens?.ceiling;
      // A limit of 1 allows one more of what it counts, not "1 turns".
      return configured === undefined
        ? undefined
        : `${whole(configured)} ${Math.floor(configured) === 1 ? words[limit].one : words[limit].noun}`;
    })
    .filter((part): part is string => part !== undefined);
  lines.push(`${CONTINUE_REQUEST} allows another ${tranche.join(' and ')}. The counts are not reset, so the next crossing asks again.`);
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  lines.push(`${STOP_REQUEST} ends the running turns of this request. No answer within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} stops it too.`);
  return { message: 'A request reached the limit you set. Stop it or let it continue?', detail: lines.join('\n\n') };
}

/**
 * How the wait for the decision can end without the person: `expired`, the window passed and the request was
 * stopped; `withdrawn`, the last held step ended first, so nothing was decided and the request was not stopped;
 * `ended` and `disposed`, the request is over or the host is shutting down. The gate gives its reason as the
 * reason of the aborted signal; `requestLimitCardEnd` reads it.
 */
export type RequestLimitCardEnd = 'expired' | 'withdrawn' | 'ended' | 'disposed';

/** What a settled card shows. `continued` and `stopped` are the person's answers; the rest came without one. */
export type RequestLimitCardSettlement = 'continued' | 'stopped' | 'expired' | 'withdrawn' | 'ended';

/** One decision card: the conversation it belongs to and the text it shows. */
export interface RequestLimitCard {
  requestId: string;
  /** The agent whose conversation the card belongs to, its name as one plain line. Absent when none is known. */
  agent?: { id: string; name: string };
  message: string;
  /** The paragraphs under the message, in order. */
  paragraphs: string[];
}

export interface OpenRequestLimitCard {
  /** How the card settled. A card settles once: by the person's answer or by `close`, whichever comes first. */
  settled: PromiseLike<RequestLimitCardSettlement>;
  /** Settle the card at once as this ending. It then offers no action, and an answer that comes later is dropped. */
  close(end: RequestLimitCardEnd): void;
}

export interface RequestLimitPromptDeps {
  /** Open the card in Chat, with its two actions, Stop first. A surface that cannot open one throws. */
  openCard(card: RequestLimitCard): OpenRequestLimitCard;
  /** The names of the agents with a live turn of the request. */
  agentNames(requestId: string): string[];
  /** The agent the person asked this request of or, when that is not known, an agent working on it. */
  askedAgent(requestId: string): { id: string; name: string } | undefined;
  windowMs: number;
}

/**
 * The ending an abort reason names. The gate's `failed` (the prompt itself failed, and the request was stopped)
 * is an ending without a decision, like `ended`. No reason, and one that is none of these, is read as
 * `withdrawn`: nothing is shown as stopped that the gate did not say was stopped.
 */
export function requestLimitCardEnd(reason: unknown): RequestLimitCardEnd {
  if (reason === 'failed') return 'ended';
  return reason === 'expired' || reason === 'ended' || reason === 'disposed' ? reason : 'withdrawn';
}

const SETTLED_TEXT: Record<RequestLimitCardSettlement, RequestLimitPromptText> = {
  continued: {
    message: `Request limit: you chose ${CONTINUE_REQUEST}`,
    detail: 'The request goes on. If it reaches a limit again, you are asked again.',
  },
  stopped: {
    message: `Request limit: you chose ${STOP_REQUEST}`,
    detail: 'The running turns of this request were stopped.',
  },
  expired: {
    message: 'Request limit: stopped, no answer in time',
    detail: 'Nobody answered while this decision was open, so the request was stopped. It can no longer be continued from this card.',
  },
  withdrawn: {
    message: 'Request limit: decision no longer needed',
    detail: 'The step that was waiting for it ended first, so nothing was decided here. If the request goes on and reaches a limit again, you are asked again.',
  },
  ended: {
    message: 'Request limit: the request ended before a decision',
    detail: 'The request was over, or UnodeAi was closing, before an answer was given. Nothing was continued.',
  },
};

/** What a settled card says: a title and one sentence for each way a card can settle. */
export function requestLimitSettledText(settlement: RequestLimitCardSettlement): RequestLimitPromptText {
  return SETTLED_TEXT[settlement];
}

/**
 * Ask once, with one card. Only a card the person answered with Continue continues the request, and only while
 * the gate still waits for the answer. When the gate stops waiting (the signal aborts), the card is closed with
 * the reason at once, so it never goes on offering an answer that nobody reads. A card that cannot be opened and
 * a card that fails are Stop.
 */
export async function askRequestLimitDecision(
  facts: RequestCeilingDecisionFacts,
  signal: AbortSignal,
  deps: RequestLimitPromptDeps,
): Promise<RequestCeilingDecision> {
  // Nobody waits for the answer any more, so no card is opened for it.
  if (signal.aborted) return 'stop';
  let names: string[] = [];
  try { names = deps.agentNames(facts.requestId); } catch { names = []; }
  let asked: { id: string; name: string } | undefined;
  try { asked = deps.askedAgent(facts.requestId); } catch { asked = undefined; }
  const text = requestLimitPromptText(facts, names, deps.windowMs);
  let card: OpenRequestLimitCard;
  try {
    card = deps.openCard({
      requestId: facts.requestId,
      ...(asked ? { agent: { id: asked.id, name: plainName(asked.name) ?? 'Agent' } } : {}),
      message: text.message,
      paragraphs: text.detail.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length > 0),
    });
  } catch {
    return 'stop';
  }
  const close = (): void => {
    try { card.close(requestLimitCardEnd(signal.reason)); } catch { /* the answer read below is Stop either way */ }
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    const settled = await card.settled;
    if (settled !== 'continued') return 'stop';
    return signal.aborted ? 'stop' : 'continue';
  } catch {
    return 'stop';
  } finally {
    signal.removeEventListener('abort', close);
  }
}
