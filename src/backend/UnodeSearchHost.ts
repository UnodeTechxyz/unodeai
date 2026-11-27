import { randomUUID } from 'node:crypto';
import { readBoundedText } from './cliRuntime';
import { normalizeWebAccessPolicy, type WebAccessDecision } from './WebAccessPolicy';
import {
  UNODE_SEARCH_CALLS_PER_TURN, UNODE_SEARCH_DEADLINE_MS, UNODE_SEARCH_MODEL, UNODE_SEARCH_USES_PER_CALL,
  unodeSearchCost, unodeSearchUnitPrice,
} from './UnodeSearchPricing';
import { parseUnodeSearchResponse, type SearchResponse } from './UnodeSearchResponse';
import { awaitRequestBoundary, reservePaidRequest, type RequestBoundary } from './requestBoundary';

export interface UnodeSearchConnection {
  connectionId: string;
  revision: number;
  endpointBase: string;
  secretName: string;
}

export interface SearchTurn {
  agentId: string;
  turn: object;
  turnId?: string;
  signal: AbortSignal;
  boundary?: RequestBoundary;
  current(): boolean;
}

export interface SearchOperation {
  operationId: string;
  route: UnodeSearchConnection;
  turnCall: number;
  requestId?: string;
}

type SearchDetails = Omit<SearchResponse, 'state'> & ReturnType<typeof unodeSearchCost>;
export type UnodeSearchOutcome =
  | { state: 'refused'; message: string; reason?: 'limit' | 'missing-key' | 'consent' | 'request-limit' | 'stopped' }
  | { state: 'outcome-unknown'; operationId: string; may_have_cost: true; message: string }
  | { state: SearchResponse['state']; operationId: string; may_have_cost: true; details: SearchDetails };

export interface UnodeSearchPorts {
  connection(): UnodeSearchConnection | undefined;
  secret(name: string): Promise<string | undefined>;
  policy(agentId: string): unknown;
  approve(turn: SearchTurn, query: string, price: string): Promise<WebAccessDecision>;
  egress(agentId: string, route: UnodeSearchConnection, signal: AbortSignal): Promise<boolean>;
  egressCurrent(route: UnodeSearchConnection): boolean;
  activity(turn: SearchTurn, text: string): void;
  started?(turn: SearchTurn, operation: SearchOperation): void;
  settled?(turn: SearchTurn, operation: SearchOperation, outcome: Exclude<UnodeSearchOutcome, {state: 'refused'}>, queries: string[]): void;
  fetch?: typeof fetch;
}

const LIMIT_MESSAGE = `This member has used all ${UNODE_SEARCH_CALLS_PER_TURN} web search calls for this turn. It can continue next turn.`;
const STALE_MESSAGE = 'Public web search is no longer available for this turn.';
const SEARCH_REPLY_MAX_BYTES = 1_000_000;

export class UnodeSearchHost {
  private readonly sent = new WeakMap<object, Map<string, number>>();

  constructor(private readonly ports: UnodeSearchPorts) {}

  enabled(agentId: string): boolean {
    return normalizeWebAccessPolicy(this.ports.policy(agentId)) !== 'off';
  }

  async search(args: Record<string, unknown>, turn: SearchTurn): Promise<UnodeSearchOutcome> {
    const refuse = (message: string, reason?: 'limit' | 'missing-key' | 'consent' | 'request-limit' | 'stopped'): UnodeSearchOutcome =>
      ({ state: 'refused', message, ...(reason ? { reason } : {}) });
    const { query } = args;
    if (Object.keys(args).length !== 1 || typeof query !== 'string' || !query.trim()) return refuse('Provide a query for public web search.');
    const policy = () => normalizeWebAccessPolicy(this.ports.policy(turn.agentId));
    const live = () => !turn.signal.aborted && turn.current() && policy() !== 'off';
    if (turn.signal.aborted) return refuse('Public web search stopped before sending.', 'stopped');
    if (!live()) return refuse(STALE_MESSAGE);
    const uses = this.sent.get(turn.turn) ?? new Map<string, number>();
    this.sent.set(turn.turn, uses);
    const used = () => uses.get(turn.agentId) ?? 0;
    if (used() >= UNODE_SEARCH_CALLS_PER_TURN) return refuse(LIMIT_MESSAGE, 'limit');
    const route = this.ports.connection();
    const secret = route && await this.ports.secret(route.secretName);
    if (!live()) return refuse(STALE_MESSAGE);
    if (!route || !secret?.trim()) return refuse('Configure the Unode API key in UnodeAi Settings → Providers → Unode to use public web search.', 'missing-key');
    const unitPrice = unodeSearchUnitPrice();
    const boundaryDetail = { tool: 'web_search', signal: turn.signal };
    let approved = false;
    if (policy() === 'ask') {
      const decision = await this.ports.approve(turn, query, unitPrice);
      if (!decision.allow) return refuse('Public web search was declined.', 'consent');
      if (turn.boundary && await awaitRequestBoundary(turn.boundary, 'effect', boundaryDetail) === 'stopped') {
        return refuse('The request limit stopped this search.', 'request-limit');
      }
      approved = true;
    }
    const sameRoute = () => {
      const current = this.ports.connection();
      return current?.connectionId === route.connectionId && current.revision === route.revision
        && current.endpointBase === route.endpointBase && current.secretName === route.secretName;
    };
    const maySend = () => live() && sameRoute() && (policy() !== 'ask' || approved);
    if (!maySend()) return refuse(STALE_MESSAGE);
    if (!await this.ports.egress(turn.agentId, route, turn.signal)) return refuse('Public web search could not send to the configured Unode connection.', 'consent');
    const currentSecret = await this.ports.secret(route.secretName);
    if (!maySend() || currentSecret !== secret || !this.ports.egressCurrent(route)) return refuse(STALE_MESSAGE);
    if (used() >= UNODE_SEARCH_CALLS_PER_TURN) return refuse(LIMIT_MESSAGE, 'limit');
    if (turn.boundary) {
      const reservation = await reservePaidRequest(turn.boundary, boundaryDetail);
      if (reservation.status !== 'reserved') return refuse(reservation.status === 'stopped'
        ? 'Public web search stopped before sending.' : 'The request limit stopped this search.', reservation.status);
      const { release } = reservation;
      let freshSecret: string | undefined;
      try { freshSecret = await this.ports.secret(route.secretName); }
      catch { release(); return refuse(STALE_MESSAGE); }
      if (!maySend() || freshSecret !== secret || !this.ports.egressCurrent(route)) {
        release();
        return refuse(STALE_MESSAGE);
      }
      if (used() >= UNODE_SEARCH_CALLS_PER_TURN) {
        release();
        return refuse(LIMIT_MESSAGE, 'limit');
      }
    }
    const turnCall = used() + 1;
    if (turnCall > UNODE_SEARCH_CALLS_PER_TURN) return refuse(LIMIT_MESSAGE, 'limit');
    uses.set(turn.agentId, turnCall);
    const operation: SearchOperation = { operationId: `search-${randomUUID()}`, route, turnCall };
    const deadline = AbortSignal.any([turn.signal, AbortSignal.timeout(UNODE_SEARCH_DEADLINE_MS)]);
    try {
      this.ports.activity(turn, `Unode web search, usually a few seconds, up to about a minute when the gateway is busy. ${unitPrice} · ${turnCall}/${UNODE_SEARCH_CALLS_PER_TURN} calls this turn.`);
    } catch { /* Activity visibility never gates an admitted request. */ }
    try { this.ports.started?.(turn, operation); }
    catch { /* A private history failure never prevents a send. */ }

    let queries: string[] = [];
    let outcome: Exclude<UnodeSearchOutcome, {state: 'refused'}>;
    try {
      const response = await (this.ports.fetch ?? fetch)(route.endpointBase + '/messages', {
        method: 'POST', redirect: 'manual', signal: deadline,
        headers: { 'content-type': 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: UNODE_SEARCH_MODEL, max_tokens: 2048, stream: false,
          system: 'You are a public web search service. Always call web_search at least once before answering, even when you think you know the answer. Answer only from the search results and cite them.',
          messages: [{ role: 'user', content: query }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: UNODE_SEARCH_USES_PER_CALL }],
        }),
      });
      const requestId = response.headers.get('x-request-id');
      if (requestId && /^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)) operation.requestId = requestId;
      deadline.throwIfAborted();
      const result = response.ok
        ? parseUnodeSearchResponse(JSON.parse(await readBoundedText(response, SEARCH_REPLY_MAX_BYTES)))
        : undefined;
      deadline.throwIfAborted();
      if (result) {
        queries = result.queries;
        const { state, ...details } = result.result;
        outcome = { state, operationId: operation.operationId, may_have_cost: true,
          details: { ...details, ...unodeSearchCost(details.usage, details.estimatedSearchCount) } };
      } else {
        outcome = { state: 'service-failed', operationId: operation.operationId, may_have_cost: true,
          details: { answer: '', sources: [], usage: {}, total: { basis: 'unavailable' } } };
      }
    } catch {
      outcome = { state: 'outcome-unknown', operationId: operation.operationId, may_have_cost: true,
        message: 'Search did not return a confirmed result. It may have cost money. Automatic retry was skipped.' };
    }
    try { this.ports.settled?.(turn, operation, outcome, queries); }
    catch { /* A private history failure never changes the observed result. */ }
    return maySend() ? outcome : {
      state: 'outcome-unknown', operationId: operation.operationId, may_have_cost: true,
      message: 'The search was sent before this turn or its permission changed. It may have cost money. Automatic retry was skipped.',
    };
  }
}
