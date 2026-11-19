/*---------------------------------------------------------------------------------------------
 *  UnodeAi - a teammate's question and its coordinator's answer (v0.9.103 slice 2, design §5.5)
 *
 *  Each question or blocker a teammate sends to the coordinator of its live task is an exchange with a host-issued id,
 *  bound to one attempt. Its facts are recorded separately and in order: question-open, answer-queued,
 *  answer-delivered, closed. A closed exchange says whether its answer was delivered; one that closed because its
 *  attempt ended, or because of Stop, records undelivered and why. Nothing here starts a turn: the session decides
 *  when an answer is delivered.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { TaskMessageKind } from '../backend/TaskMessage';

export type TaskExchangeFact = 'question-open' | 'answer-queued' | 'answer-delivered' | 'closed';

/** Why an exchange closed without its answer reaching the teammate. */
export type ExchangeUndeliveredCause =
  /** The attempt reached a terminal outcome (a result, an error, a budget or safety stop, an interruption). */
  | 'task-ended'
  /** The person stopped the teammate, or the coordinator cancelled the task. */
  | 'teammate-stopped'
  /** The person stopped the coordinator. */
  | 'coordinator-stopped';

export interface TaskExchange {
  readonly exchangeId: string;
  /** The coordinator session the question went to, and the only one that may answer it. */
  readonly coordinatorId: string;
  readonly teammateId: string;
  readonly handle: string;
  readonly attemptId: string;
  /** The request of the attempt's saved binding: the answer and its continuation are charged to it. */
  readonly requestId?: string;
  readonly kind: Exclude<TaskMessageKind, 'note'>;
  readonly question: string;
  /** The host event id of the teammate's message that opened it. */
  readonly questionEventId: string;
  /** Each fact once, in order, with when it was recorded. */
  readonly facts: Array<{ fact: TaskExchangeFact; at: string }>;
  answer?: { text: string; eventId: string };
  /** How the answer reached the teammate. */
  deliveredBy?: 'in-turn' | 'continuation';
  closed?: { delivered: true } | { delivered: false; cause: ExchangeUndeliveredCause; reason: string };
}

/** The state an exchange is in now: its latest fact. */
export function exchangeState(exchange: TaskExchange): TaskExchangeFact {
  return exchange.facts[exchange.facts.length - 1].fact;
}

/** Owed to the teammate: a question without an answer yet, or an answer not yet delivered. */
export function exchangeOwed(exchange: TaskExchange): boolean {
  const state = exchangeState(exchange);
  return state === 'question-open' || state === 'answer-queued';
}

/** Closed exchanges kept for a refusal's reason and for the record; the oldest are forgotten first. */
const CLOSED_RETAINED = 500;

export class TaskExchanges {
  private readonly exchanges = new Map<string, TaskExchange>();
  private closedOrder: string[] = [];
  /** §5.3 (Q1, no hard cap): how many exchanges each attempt opened. Counted only; nothing is held by it. */
  private readonly counts = new Map<string, number>();

  open(input: Omit<TaskExchange, 'exchangeId' | 'facts' | 'answer' | 'deliveredBy' | 'closed'>, now = new Date()): TaskExchange {
    let exchangeId = '';
    do { exchangeId = `exchange-${randomUUID().slice(0, 8)}`; } while (this.exchanges.has(exchangeId));
    const exchange: TaskExchange = { ...input, exchangeId, facts: [{ fact: 'question-open', at: now.toISOString() }] };
    this.exchanges.set(exchangeId, exchange);
    const count = this.countOf(input.attemptId) + 1;
    // Re-inserted, so the attempt counted last is forgotten last.
    this.counts.delete(input.attemptId);
    this.counts.set(input.attemptId, count);
    if (this.counts.size > CLOSED_RETAINED) this.counts.delete(this.counts.keys().next().value as string);
    return exchange;
  }

  /** The number of exchanges an attempt opened, closed ones included. */
  countOf(attemptId: string): number {
    return this.counts.get(attemptId) ?? 0;
  }

  get(exchangeId: string): TaskExchange | undefined {
    return this.exchanges.get(exchangeId);
  }

  /** question-open → answer-queued. False, changing nothing, from any other state. */
  answer(exchange: TaskExchange, text: string, eventId: string, now = new Date()): boolean {
    if (exchangeState(exchange) !== 'question-open') return false;
    exchange.answer = { text, eventId };
    exchange.facts.push({ fact: 'answer-queued', at: now.toISOString() });
    return true;
  }

  /** answer-queued → answer-delivered → closed (delivered). False, changing nothing, from any other state. */
  delivered(exchange: TaskExchange, by: 'in-turn' | 'continuation', now = new Date()): boolean {
    if (exchangeState(exchange) !== 'answer-queued') return false;
    const at = now.toISOString();
    exchange.deliveredBy = by;
    exchange.facts.push({ fact: 'answer-delivered', at }, { fact: 'closed', at });
    exchange.closed = { delivered: true };
    this.retire(exchange);
    return true;
  }

  /** An owed exchange closes without its answer reaching the teammate. False, changing nothing, once it is closed. */
  closeUndelivered(exchange: TaskExchange, cause: ExchangeUndeliveredCause, reason: string, now = new Date()): boolean {
    if (!exchangeOwed(exchange)) return false;
    exchange.facts.push({ fact: 'closed', at: now.toISOString() });
    exchange.closed = { delivered: false, cause, reason };
    this.retire(exchange);
    return true;
  }

  /** The owed exchanges of one attempt, oldest first. */
  owedOf(attemptId: string): TaskExchange[] {
    return [...this.exchanges.values()].filter((exchange) => exchange.attemptId === attemptId && exchangeOwed(exchange));
  }

  /** The owed exchanges a coordinator was asked. */
  owedTo(coordinatorId: string): TaskExchange[] {
    return [...this.exchanges.values()].filter((exchange) => exchange.coordinatorId === coordinatorId && exchangeOwed(exchange));
  }

  /** Every exchange of one attempt still known here, oldest first. */
  ofAttempt(attemptId: string): TaskExchange[] {
    return [...this.exchanges.values()].filter((exchange) => exchange.attemptId === attemptId);
  }

  /** The attempt of the latest exchange on a handle, if any is known here. */
  latestAttemptOf(handle: string): string | undefined {
    let latest: string | undefined;
    for (const exchange of this.exchanges.values()) if (exchange.handle === handle) latest = exchange.attemptId;
    return latest;
  }

  private retire(exchange: TaskExchange): void {
    this.closedOrder.push(exchange.exchangeId);
    while (this.closedOrder.length > CLOSED_RETAINED) this.exchanges.delete(this.closedOrder.shift()!);
  }
}
