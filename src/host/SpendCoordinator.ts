/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SpendCoordinator (v0.9.89, design §3, §4, §7, §9, §13.3)
 *
 *  The one host owner of spend visibility. SessionManager reports request and usage-unit facts; this class
 *  prices them against a price pinned when the unit started, appends immutable events, and only after an event
 *  is durable recomputes totals, updates views and evaluates the reminder ladder.
 *
 *  It never gates work. Nothing here is awaited on the provider path: no Stop, no refusal, no `max_tokens`
 *  change, no coordinator wake, no `host_wait`. A reminder is information for the user, who decides.
 *
 *  VS Code-free: presentation, settings and credentials arrive through ports.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { TurnUsage } from '../backend/AgentBackend';
import { turnUsageBasis } from '../backend/AgentBackend';
import { formatUsd, NANO_PER_USD, parseNanoUsd } from '../models/spend/Money';
import { catalogIsStale, type PriceCatalogV1, type ReferenceProvider } from '../models/spend/PriceCatalog';
import {
  costBasisLabel,
  displayReferenceProvider,
  pinPrice,
  priceUsage,
  referenceCandidate,
  type PinnedPrice,
  type PriceCandidate,
  type ReferenceCatalogs,
  type StoredReferencePriceMode,
} from '../models/spend/PriceResolver';
import {
  aggregateSpend,
  counterEpochOf,
  counterTotals,
  latestApplicableReset,
  noticeCounterKey,
  noticeKey,
  parseNoticeKey,
  reachedThresholds,
  thresholdLoudness,
  totalsSnapshot,
  type AggregateResult,
  type CounterScope,
  type CounterTotals,
} from '../models/spend/SpendAggregate';
import {
  effectiveTargets,
  periodIdFor,
  targetRevision,
  type EffectiveAmount,
  type EffectiveTargets,
  type RepositoryBudget,
  type UserTargets,
} from '../models/spend/SpendTargets';
import {
  spendEventId,
  type CostBasis,
  type SpendEventPayload,
  type CounterResetV1,
  type ResetScope,
  type SpendControlV1,
  type StoredSpendEvent,
  type UsageReceipt,
  type UsageTokens,
} from '../models/spend/SpendTypes';
import { SpendEventRejectedError, SpendLockBusyError, type SpendLedger } from '../state/SpendStore';

export interface SpendRoute {
  connectionId: string;
  connectionName: string;
  /** Subscription CLIs show API-equivalent dollars only; everything with a key is a gateway route. */
  route: 'gateway' | 'subscription';
}

export type SpendResetRequest =
  | { scope: 'request'; requestId: string }
  | { scope: 'project-period'; periodId: string }
  | { scope: 'agent-period'; agentId: string; periodId: string }
  | { scope: 'project-all' };

export interface SpendAlert {
  key: string;
  loudness: 'quiet' | 'over-target';
  threshold: number;
  scope: 'request' | 'project-period' | 'agent-period';
  dimension: 'tokens' | 'usd';
  /** The request whose usage crossed the threshold; the Chat line goes to its coordinator. */
  requestId: string;
  rootAgentId?: string;
  agentId?: string;
  agentName?: string;
  periodId?: string;
  valueText: string;
  targetText: string;
  /** Which eligible basis crossed it, e.g. "reported tokens" or "Unode account estimate". */
  basisText: string;
  repositoryNarrowed: boolean;
  reset: SpendResetRequest;
  /** Single-use and bound to `requestId`; see `consumeStopToken`. */
  stopToken: string;
}

export interface SpendNotifier {
  /** Present one threshold appearance. Must not throw and must not block: the caller never awaits it. */
  threshold(alert: SpendAlert): void;
  /** A gateway turn finished with no billed or exact price and no reference mode chosen yet. */
  referencePriceChoiceNeeded(context: { connectionName: string; modelId: string }): void;
  /** Durable totals changed; re-render spend views. */
  viewChanged(): void;
  /** The control file is unreadable; reminders are paused until Repair. Shown once. */
  repairNeeded(detail: string): void;
}

export interface SpendCoordinatorDeps {
  ledger: SpendLedger;
  notifier: SpendNotifier;
  resolveRoute(agentId: string, modelId: string): SpendRoute | undefined;
  /** Price candidates for this exact connection and credential generation (user override, account, published). */
  routeCandidates(route: SpendRoute, modelId: string): PriceCandidate[];
  referenceMode(): StoredReferencePriceMode;
  catalogs(): ReferenceCatalogs;
  userTargets(): UserTargets;
  /** The validated repository proposal currently on disk, if any. Never read from the model or a webview. */
  repositoryBudget(): RepositoryBudget | undefined;
  agentName?(agentId: string): string | undefined;
  /**
   * Refresh this route's account price after a turn that lacked one (design §5.3). Only with existing network
   * consent, never a prompt, never awaited by the model path. Resolves once the snapshot cache is updated.
   */
  postTurnPriceRefresh?(route: SpendRoute, modelId: string): Promise<void>;
  /** Stop the still-live turns of one request; returns how many were stopped. */
  stopRequest?(requestId: string): number;
  /** The premium model the Dashboard compares mixed routing against. */
  premiumCostModel?: string;
  now?: () => number;
  randomId?: () => string;
  log?: (message: string) => void;
  /** Retry delay for a busy maintenance lock (tests shorten it). */
  claimRetryMs?: number;
  /** First retry delay for an event that could not be written; doubles up to 30 s (tests shorten it). */
  appendRetryMs?: number;
}

interface UnitState {
  usageUnitId: string;
  requestId: string;
  agentId: string;
  modelId: string;
  runId?: string;
  route?: SpendRoute;
  pin: PinnedPrice;
  attempts: number;
  progressIds: string[];
  closed: boolean;
}

/** What SessionManager's compatibility projection receives for one settled turn (legacy display only). */
export interface SettledUsageProjection {
  costUsd?: number;
  costBasis?: 'billed' | 'api-equivalent' | 'estimated';
  savings?: { actualUsd: number; premiumUsd: number; source: string } | 'unavailable';
}

export interface SpendRowView {
  label: string;
  tokens: number;
  costText?: string;
}

export interface CounterView {
  kind: 'request' | 'project-period' | 'agent-period';
  title: string;
  requestId?: string;
  agentId?: string;
  periodId?: string;
  eligibleTokens: number;
  eligibleNanoUsd: bigint;
  tokens: { input: number; cached: number; output: number; total: number };
  rows: SpendRowView[];
  unattributedUnits: number;
  target?: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount };
  /** Highest percentage of an enabled target in this epoch, if any. */
  percent?: number;
  counterEpoch: string;
  lastReset?: { resetAt: string; previousTokens: number };
  reset: SpendResetRequest;
}

export interface SpendViewModel {
  folderless: boolean;
  /** The local date (YYYY-MM-DD, in the project target's time zone or this machine's) of the first record. */
  trackedSince?: string;
  controlState: string;
  remindersPaused: boolean;
  diagnostics: string[];
  referenceMode: StoredReferencePriceMode;
  catalogs: Array<{ provider: ReferenceProvider; catalogId: string; capturedAt: string; stale: boolean; models: number }>;
  requests: CounterView[];
  project?: CounterView;
  agents: CounterView[];
  openUnits: number;
  coverageGaps: number;
  /** Events settled in this window but not yet durable; while any remain the views say "usage updating". */
  pendingWrites: number;
  targets: EffectiveTargets;
  targetDiagnostics: string[];
  targetRevision: string;
  highestPercent?: number;
  overTarget: boolean;
  overTargetAgents: string[];
  /** Set by the VS Code host: the repository proposal's state, for the quiet Dashboard banner (design §6.2). */
  repository?: { state: 'none' | 'invalid' | 'proposed' | 'accepted' | 'ignored'; detail?: string };
}

/** Which dollar basis would remind for one agent's route right now (design §6.1: the UI says what a dollar target covers). */
export interface DollarCoverage {
  agentId: string;
  connectionName: string;
  coverage: 'billed-when-reported' | 'exact-route' | 'selected-reference' | 'tokens-only';
  detail: string;
}

const RECENT_REQUESTS = 10;
/** A failed or uninformative post-turn price lookup is not retried for the same route and model before this. */
const POST_TURN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const CLAIM_RETRIES = 5;
/** A request claim lapses once its request goes this long without recorded usage after the claim. */
const REQUEST_CLAIM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const APPEND_RETRY_MS = 1_000;
const APPEND_RETRY_MAX_MS = 30_000;

/** One event waiting to become durable, and what follows once it is. */
interface PendingWrite {
  payload: SpendEventPayload;
  eventId: string;
  onDurable?: (stored: StoredSpendEvent) => void;
}

const CLASS_LABELS: Record<string, string> = {
  'billed': 'Billed',
  'exact-route': 'Account / user-configured estimate',
  'selected-reference': 'Selected reference estimate',
  'reference': 'Reference estimate (display only)',
  'published': 'Gateway published estimate (display only)',
  'api-equivalent': 'API-equivalent (subscription)',
  'reported-partial': 'Partial (stopped before completion)',
  'reconstructed': 'Reconstructed (not reported)',
  'unavailable': 'Price unavailable (tokens only)',
};

interface ClaimCandidate {
  key: string;
  counter: string;
  scopeKey: string;
  periodId: string;
  threshold: number;
  alert: Omit<SpendAlert, 'stopToken'>;
}

/** A claim this window won, remembered so it need not re-read control; it lapses by the same rule as a stored one. */
interface LocalClaim {
  threshold: number;
  claimedAt: number;
  scopeKey: string;
  periodId: string;
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

export class SpendCoordinator {
  private readonly units = new Map<string, UnitState>();
  private readonly requestRoots = new Map<string, { agentId: string; startedAt: number }>();
  private readonly stopTokens = new Map<string, string>();
  /** Counter key -> the highest claim this window won; while live, the counter never claims at or below it. */
  private readonly localClaims = new Map<string, LocalClaim>();
  /** Each request's recorded usage times, sorted, per aggregate (claim liveness reads them). */
  private readonly activityCache = new WeakMap<AggregateResult, Map<string, number[]>>();
  /** Events not yet durable, written in order and retried until they are (design §8: "usage updating"). */
  private readonly writeQueue: PendingWrite[] = [];
  private draining: Promise<void> | undefined;
  private retryWake: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;
  private disposed = false;
  private readonly offeredReferenceFor = new Set<string>();
  /** One post-turn price refresh per connection and model, shared by concurrent turns and not repeated soon after. */
  private readonly postTurnRefreshes = new Map<string, { at: number; running?: Promise<void> }>();
  private aggregate: AggregateResult = aggregateSpend([]);
  private dirty = true;
  /** Bumped on every change to the recorded events or control, so a view built from them can be reused. */
  private version = 0;
  private viewCache: { key: string; view: SpendViewModel } | undefined;
  private get aggregateDirty(): boolean { return this.dirty; }
  private set aggregateDirty(value: boolean) {
    if (value) this.version += 1;
    this.dirty = value;
  }
  private repairNoticeShown = false;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly log: (message: string) => void;
  private readonly disposeLedgerListener: () => void;
  private evaluation: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SpendCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? randomUUID;
    this.log = deps.log ?? (() => undefined);
    this.disposeLedgerListener = deps.ledger.onDidChange(() => {
      this.aggregateDirty = true;
      deps.notifier.viewChanged();
    });
  }

  get projectBacked(): boolean {
    return this.deps.ledger.projectBacked;
  }

  // ─── SessionManager port ───────────────────────────────────────────────────────

  /** A top-level user request began on `rootAgentId`. */
  beginRequest(requestId: string, rootAgentId: string): void {
    this.requestRoots.set(requestId, { agentId: rootAgentId, startedAt: this.now() });
    if (this.requestRoots.size > 500) {
      const oldest = this.requestRoots.keys().next().value as string;
      this.requestRoots.delete(oldest);
    }
  }

  /** Immediately before `sendUserTurn`: one backend turn is one usage unit. Its price is pinned now. */
  beginUsageUnit(unit: { usageUnitId: string; requestId: string; agentId: string; modelId: string; runId?: string }): void {
    const route = this.safe(() => this.deps.resolveRoute(unit.agentId, unit.modelId), undefined);
    this.units.set(unit.usageUnitId, {
      ...unit,
      // Stored ids must fit the closed event schema; pricing still uses the real model id.
      requestId: spendEventId(unit.requestId, 'id'),
      agentId: spendEventId(unit.agentId, 'id'),
      ...(unit.runId ? { runId: spendEventId(unit.runId, 'id') } : {}),
      ...(route ? { route } : {}),
      pin: this.pinFor(route, unit.modelId),
      attempts: 0,
      progressIds: [],
      closed: false,
    });
  }

  private pinFor(route: SpendRoute | undefined, modelId: string): PinnedPrice {
    const now = this.now();
    const catalogs = this.safe(() => this.deps.catalogs(), {});
    const referenceMode = this.safe(() => this.deps.referenceMode(), 'unselected' as StoredReferencePriceMode);
    if (!route) {
      return pinPrice({ route: 'gateway', modelId, routeCandidates: [], referenceMode, catalogs, now });
    }
    const routeCandidates = route.route === 'gateway' ? this.safe(() => this.deps.routeCandidates(route, modelId), []) : [];
    return pinPrice({ route: route.route, modelId, routeCandidates, referenceMode, catalogs, now });
  }

  /** One backend `model_request`: the first writes the unit's start; later ones raise its attempt count. */
  noteModelRequest(usageUnitId: string): void {
    const unit = this.units.get(usageUnitId);
    if (!unit || unit.closed) return;
    unit.attempts += 1;
    this.appendStart(unit);
  }

  private appendStart(unit: UnitState): void {
    const connectionId = unit.route?.connectionId ?? 'unknown';
    this.record({
      kind: 'usage-unit-start',
      usageUnitId: unit.usageUnitId,
      requestId: unit.requestId,
      agentId: unit.agentId,
      connectionId: spendEventId(connectionId, 'route'),
      modelId: spendEventId(unit.modelId, 'route'),
      providerAttempts: unit.attempts,
    }, `start:${unit.usageUnitId}:${unit.attempts}`);
  }

  /**
   * One completed OpenAI-compatible response with reported usage (design §9). Appended as exact progress so a
   * long tool loop can remind while it runs; the next provider request never waits for this.
   */
  noteUsageProgress(usageUnitId: string, progress: { attempt: number; inputTokens: number; cachedInputTokens?: number; outputTokens: number }): void {
    const unit = this.units.get(usageUnitId);
    if (!unit || unit.closed) return;
    if (!Number.isSafeInteger(progress.attempt) || progress.attempt < 1 || progress.attempt > unit.attempts) return;
    const progressId = `progress:${unit.usageUnitId}:${progress.attempt}`;
    if (unit.progressIds.includes(progressId)) return;
    const tokens = this.tokensOf(progress.inputTokens, progress.cachedInputTokens, progress.outputTokens);
    if (!tokens) return;
    unit.progressIds.push(progressId);
    const priced = priceUsage(unit.pin, { ...tokens, basis: 'reported' });
    const payload = {
      kind: 'usage-progress' as const,
      progressId,
      usageUnitId: unit.usageUnitId,
      requestId: unit.requestId,
      providerAttempt: progress.attempt,
      tokens: { ...tokens, basis: 'reported' as const },
      displayCost: priced.displayCost,
      reminderValue: priced.reminderValue,
    };
    this.record(payload, progressId, (stored) => this.afterDurable(stored, unit));
  }

  private tokensOf(input: number, cached: number | undefined, output: number): { input: number; cachedInput?: number; output: number } | undefined {
    const valid = (n: number) => Number.isFinite(n) && n >= 0;
    if (!valid(input) || !valid(output)) return undefined;
    const i = Math.floor(input);
    const c = cached !== undefined && valid(cached) ? Math.min(Math.floor(cached), i) : undefined;
    return { input: i, ...(c !== undefined ? { cachedInput: c } : {}), output: Math.floor(output) };
  }

  /**
   * `turn_complete`: one aggregate receipt for the unit (design §13.3 step 5), or a coverage gap when a request
   * was made but no attributable usage arrived. Returns the legacy display projection synchronously; the event
   * itself becomes durable asynchronously and only then reaches totals and reminders.
   */
  settleUsageUnit(usageUnitId: string, usage: TurnUsage | undefined): SettledUsageProjection | undefined {
    const unit = this.units.get(usageUnitId);
    if (!unit || unit.closed) return undefined;
    const tokens = usage ? this.tokensOf(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens) : undefined;
    if (!usage || !tokens) {
      this.closeUsageUnit(usageUnitId);
      return undefined;
    }
    unit.closed = true;
    this.units.delete(usageUnitId);
    if (unit.attempts === 0) {
      // Usage without an observed request start: record the start so the receipt belongs to a unit.
      unit.attempts = 1;
      this.appendStart(unit);
    }
    const basis = turnUsageBasis(usage);
    const receiptTokens: UsageTokens = {
      ...tokens,
      ...(usage.reasoningOutputTokens !== undefined && Number.isFinite(usage.reasoningOutputTokens) && usage.reasoningOutputTokens >= 0
        ? { reasoningOutput: Math.min(Math.floor(usage.reasoningOutputTokens), tokens.output) } : {}),
      basis,
    };
    const priced = priceUsage(unit.pin, receiptTokens, { costUsd: usage.costUsd, costBasis: usage.costBasis });
    const receipt: UsageReceipt = {
      schemaVersion: 1,
      receiptId: `usage:${unit.usageUnitId}`,
      requestId: unit.requestId,
      ...(unit.runId ? { runId: unit.runId } : {}),
      usageUnitId: unit.usageUnitId,
      providerAttempts: unit.attempts,
      ...(unit.progressIds.length > 0 ? { coveredProgressIds: [...unit.progressIds] } : {}),
      agentId: unit.agentId,
      connectionId: spendEventId(unit.route?.connectionId ?? 'unknown', 'route'),
      modelId: spendEventId(unit.modelId, 'route'),
      observedAt: new Date(this.now()).toISOString(),
      tokens: receiptTokens,
      displayCost: priced.displayCost,
      reminderValue: priced.reminderValue,
      ...(usage.attributedAttempts !== undefined && usage.attributedAttempts < unit.attempts
        ? { coverageGap: 'one-or-more-attempts-unattributed' as const } : {}),
    };
    // The unit takes no more usage from here; its receipt stays queued, and retried, until it is durable.
    this.record({ kind: 'usage-receipt', receipt }, receipt.receiptId, (stored) => {
      this.afterDurable(stored, unit);
      this.afterReceipt(unit, receipt);
    });
    return this.projection(unit, receiptTokens, priced.displayCost);
  }

  /** Abort, backend exit or a stop that produced no final usage: a gap if a provider request was observed. */
  closeUsageUnit(usageUnitId: string): void {
    const unit = this.units.get(usageUnitId);
    if (!unit || unit.closed) return;
    unit.closed = true;
    this.units.delete(usageUnitId);
    // A consent refusal before any model_request creates neither usage nor a coverage gap.
    if (unit.attempts === 0) return;
    this.record({
      kind: 'coverage-gap', usageUnitId: unit.usageUnitId, requestId: unit.requestId, reason: 'no-terminal-usage',
    }, `gap:${unit.usageUnitId}`, () => {
      this.aggregateDirty = true;
      this.deps.notifier.viewChanged();
    });
  }

  /** Whether a unit still accepts usage (for SessionManager's detached-backend bookkeeping). */
  isOpen(usageUnitId: string): boolean {
    return this.units.has(usageUnitId);
  }

  /** Events settled here but not yet durable; the views say "usage updating" while any remain. */
  get pendingWrites(): number {
    return this.writeQueue.length;
  }

  private projection(unit: UnitState, tokens: UsageTokens, display: UsageReceipt['displayCost']): SettledUsageProjection {
    const out: SettledUsageProjection = {};
    if (display.basis !== 'unavailable') {
      const nano = parseNanoUsd(display.nanoUsd) ?? 0n;
      out.costUsd = Number(nano) / Number(NANO_PER_USD);
      out.costBasis = display.basis === 'billed' ? 'billed' : display.basis === 'api-equivalent' ? 'api-equivalent' : 'estimated';
    }
    // "Saved $X" compares two figures priced from the same selected dated reference, never an account rate.
    const premiumModel = this.deps.premiumCostModel;
    if (premiumModel) {
      const catalogs = this.safe(() => this.deps.catalogs(), {});
      const provider = displayReferenceProvider(this.safe(() => this.deps.referenceMode(), 'unselected' as StoredReferencePriceMode));
      const actual = referenceCandidate(catalogs, provider, unit.modelId, this.now());
      const premium = referenceCandidate(catalogs, provider, premiumModel, this.now());
      if (actual && premium) {
        const actualPin: PinnedPrice = { route: 'gateway', display: actual };
        const premiumPin: PinnedPrice = { route: 'gateway', display: premium };
        const priceOf = (pin: PinnedPrice) => {
          const cost = priceUsage(pin, { ...tokens, basis: 'reconstructed' }).displayCost;
          return cost.basis === 'unavailable' ? 0 : Number(parseNanoUsd(cost.nanoUsd) ?? 0n) / Number(NANO_PER_USD);
        };
        out.savings = {
          actualUsd: priceOf(actualPin),
          premiumUsd: priceOf(premiumPin),
          source: `${provider === 'unode' ? 'Unode' : 'Roam'} reference captured ${actual.sourceDate?.slice(0, 10) ?? 'unknown date'}`,
        };
      } else {
        out.savings = 'unavailable';
      }
    }
    return out;
  }

  // ─── Durable follow-up: totals, views, reminders ───────────────────────────────

  /**
   * Queue one event. Events are written in order, and a write that fails is retried (1 s, doubling to 30 s) until it
   * is durable; meanwhile the views say usage is updating. Only a durable event reaches totals and reminders. The
   * provider path never waits for any of this.
   */
  private record(payload: SpendEventPayload, eventId: string, onDurable?: (stored: StoredSpendEvent) => void): void {
    if (this.disposed) return;
    this.writeQueue.push({ payload, eventId, ...(onDurable ? { onDurable } : {}) });
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      let failures = 0;
      while (this.writeQueue.length > 0 && !this.disposed) {
        const write = this.writeQueue[0];
        let stored: StoredSpendEvent;
        try {
          stored = await this.deps.ledger.append(write.payload, write.eventId);
        } catch (error) {
          if (error instanceof SpendEventRejectedError) {
            // Retrying cannot make an invalid event valid; drop it so the events behind it are not held up.
            this.writeQueue.shift();
            this.log(`Spend event not recorded: ${error.message}`);
            continue;
          }
          failures += 1;
          if (failures === 1) this.deps.notifier.viewChanged();
          this.log(`Spend event not recorded yet (attempt ${failures}); retrying: ${error instanceof Error ? error.message : String(error)}`);
          await this.retryDelay(Math.min((this.deps.appendRetryMs ?? APPEND_RETRY_MS) * 2 ** (failures - 1), APPEND_RETRY_MAX_MS));
          continue;
        }
        this.writeQueue.shift();
        const recovered = failures > 0;
        failures = 0;
        try {
          write.onDurable?.(stored);
        } catch (error) {
          this.log(`Spend follow-up skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (recovered) this.deps.notifier.viewChanged();
      }
    })().finally(() => { this.draining = undefined; });
  }

  private retryDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.retryWake = undefined; resolve(); }, ms);
      (timer as { unref?: () => void }).unref?.();
      this.retryWake = { timer, resolve };
    });
  }

  private afterDurable(stored: StoredSpendEvent, unit: Pick<UnitState, 'requestId' | 'agentId'>): void {
    this.aggregateDirty = true;
    this.deps.notifier.viewChanged();
    this.scheduleEvaluation(unit.requestId, unit.agentId, stored);
  }

  private afterReceipt(unit: UnitState, receipt: UsageReceipt): void {
    if (unit.route?.route !== 'gateway') return;
    if (receipt.tokens.input + receipt.tokens.output <= 0) return;
    const hasEligibleDollars = receipt.reminderValue.basis === 'billed' || receipt.reminderValue.basis === 'exact-route';
    if (hasEligibleDollars) return;
    void this.resolveAfterTurn(unit, receipt).catch((error) => {
      this.log(`Post-turn price resolution skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Design §5.3/§5.4: one bounded post-turn refresh for a gateway turn without an exact price. A price found for
   * this exact route/model becomes one append-only adjustment to this receipt; otherwise, if no reference mode
   * was ever chosen, the user is offered the choice (the UI enforces the seven-day re-offer cadence).
   */
  private async resolveAfterTurn(unit: UnitState, receipt: UsageReceipt): Promise<void> {
    const route = unit.route!;
    const refreshKey = `${route.connectionId}|${unit.modelId}`;
    if (this.deps.postTurnPriceRefresh) {
      const prior = this.postTurnRefreshes.get(refreshKey);
      if (prior?.running) {
        await prior.running;
      } else if (!prior || this.now() - prior.at >= POST_TURN_REFRESH_INTERVAL_MS) {
        const running = this.deps.postTurnPriceRefresh(route, unit.modelId).catch(() => undefined);
        this.postTurnRefreshes.set(refreshKey, { at: this.now(), running });
        await running;
        this.postTurnRefreshes.set(refreshKey, { at: this.now() });
      }
    }
    const repinned = this.pinFor(route, unit.modelId);
    const exact = repinned.reminder && repinned.reminder.basis !== 'unode-reference' && repinned.reminder.basis !== 'roam-reference'
      ? repinned.reminder : undefined;
    if (exact) {
      // This route has a price. A partial or reconstructed turn never gains dollar-reminder authority, so there is
      // nothing to adjust, and nothing to ask: the reference choice is only for routes without a price (v0.9.89
      // field finding F4, where a stopped turn on a priced Unode route opened the choice).
      if (receipt.tokens.basis !== 'reported') return;
      const priced = priceUsage({ route: 'gateway', display: exact, reminder: exact }, receipt.tokens);
      const adjustmentId = `adjust-${this.randomId()}`;
      this.record({
        kind: 'cost-adjustment',
        adjustmentId,
        receiptId: receipt.receiptId,
        expectedCostBasis: receipt.displayCost.basis as CostBasis,
        displayCost: priced.displayCost,
        reminderValue: priced.reminderValue,
      }, adjustmentId, (stored) => this.afterDurable(stored, unit));
      return;
    }
    if (this.safe(() => this.deps.referenceMode(), 'unselected' as StoredReferencePriceMode) !== 'unselected') return;
    if (this.offeredReferenceFor.has(refreshKey)) return;
    this.offeredReferenceFor.add(refreshKey);
    this.deps.notifier.referencePriceChoiceNeeded({ connectionName: route.connectionName, modelId: unit.modelId });
  }

  private scheduleEvaluation(requestId: string, agentId: string, stored: StoredSpendEvent): void {
    this.evaluation = this.evaluation
      .then(() => this.evaluate(requestId, agentId, stored))
      .catch((error) => this.log(`Spend reminder evaluation skipped: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Test seam: resolves once every scheduled evaluation has finished. */
  async settled(): Promise<void> {
    await this.evaluation;
  }

  /** Test seam: resolves once the write queue is empty (every queued event durable or dropped as invalid). */
  async drained(): Promise<void> {
    while (this.draining) await this.draining;
    await this.evaluation;
  }

  /**
   * v0.9.93: the current aggregate of the durable spend events, for a reader that looks units up by exact id.
   * Read-only: the caller must not change it.
   */
  aggregateForRead(): AggregateResult {
    return this.currentAggregate();
  }

  private currentAggregate(): AggregateResult {
    if (this.aggregateDirty) {
      this.aggregate = aggregateSpend(this.deps.ledger.snapshot().events);
      this.aggregateDirty = false;
    }
    return this.aggregate;
  }

  private effective(): { targets: EffectiveTargets; revision: string; user: UserTargets } {
    const user = this.safe(() => this.deps.userTargets(), { agents: {}, diagnostics: [] } as UserTargets);
    const control = this.deps.ledger.snapshot().control;
    const decision = control.repositoryTargetDecision;
    const accepted = decision?.mode === 'accepted-digest' ? decision.contentDigest : undefined;
    const repository = decision?.mode === 'ignore-project' ? undefined : this.safe(() => this.deps.repositoryBudget(), undefined);
    const targets = effectiveTargets(user, repository, accepted);
    const mode = this.safe(() => this.deps.referenceMode(), 'unselected' as StoredReferencePriceMode);
    return { targets, revision: targetRevision(targets, mode), user };
  }

  private scopesFor(requestId: string, agentId: string, targets: EffectiveTargets, at: number): Array<{
    scope: CounterScope; scopeKey: string; kind: SpendAlert['scope']; target: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount };
    periodId?: string; reset: SpendResetRequest;
  }> {
    const out: ReturnType<SpendCoordinator['scopesFor']> = [];
    if (targets.request.tokens || targets.request.nanoUsd) {
      out.push({
        scope: { kind: 'request', requestId }, scopeKey: `request:${requestId}`, kind: 'request',
        target: targets.request, reset: { scope: 'request', requestId },
      });
    }
    if (targets.project && this.projectBacked) {
      const { period, timeZone } = targets.project;
      const periodId = periodIdFor(at, period, timeZone);
      if (periodId) {
        if (targets.project.tokens || targets.project.nanoUsd) {
          out.push({
            scope: { kind: 'project-period', periodId, period, timeZone }, scopeKey: 'project', kind: 'project-period',
            target: targets.project, periodId, reset: { scope: 'project-period', periodId },
          });
        }
        const share = targets.agents[agentId];
        if (share) {
          out.push({
            scope: { kind: 'agent-period', agentId, periodId, period, timeZone }, scopeKey: `agent:${agentId}`, kind: 'agent-period',
            target: share, periodId, reset: { scope: 'agent-period', agentId, periodId },
          });
        }
      }
    }
    return out;
  }

  private async evaluate(requestId: string, agentId: string, stored: StoredSpendEvent): Promise<void> {
    const snapshot = this.deps.ledger.snapshot();
    if (snapshot.controlState === 'corrupt' || snapshot.controlState === 'unsupported' || snapshot.unsupportedLines > 0) {
      if (!this.repairNoticeShown) {
        this.repairNoticeShown = true;
        this.deps.notifier.repairNeeded(snapshot.controlState === 'unsupported' || snapshot.unsupportedLines > 0
          ? 'Spend tracking was written by a newer UnodeAi; reminders are paused. Update UnodeAi.'
          : 'The spend-tracking control file is unreadable; reminders are paused until you run Repair spend tracking. Work is not affected.');
      }
      return;
    }
    if (snapshot.controlState === 'backup' && !this.repairNoticeShown) {
      this.repairNoticeShown = true;
      this.deps.notifier.repairNeeded('The spend-tracking control file was unreadable, so its backup is in use. Run Repair spend tracking to restore it.');
    }
    const { targets, revision } = this.effective();
    const at = Date.parse(stored.event.recordedAt);
    const scopes = this.scopesFor(requestId, agentId, targets, at);
    if (scopes.length === 0) return;
    // Merge other windows' usage first: a project counter can cross on the sum of several windows.
    try {
      if (await this.deps.ledger.refresh()) this.aggregateDirty = true;
    } catch { /* a slow or failed read delays nothing; the poll catches up */ }
    const aggregate = this.currentAggregate();
    const control = this.deps.ledger.snapshot().control;
    const now = this.now();
    const claimed = this.liveClaims(control.noticeClaims, aggregate, now);
    const candidates: ClaimCandidate[] = [];
    for (const entry of scopes) {
      const totals = counterTotals(aggregate, control, entry.scope);
      const counterEpoch = counterEpochOf(control, entry.scope);
      for (const dimension of ['tokens', 'usd'] as const) {
        const target = dimension === 'tokens' ? entry.target.tokens : entry.target.nanoUsd;
        if (!target) continue;
        const value = dimension === 'tokens' ? BigInt(totals.eligibleTokens) : totals.eligibleNanoUsd;
        const targetValue = BigInt(target.value);
        const reached = reachedThresholds(value, targetValue);
        if (reached.length === 0) continue;
        // Only the highest reached rung is claimed and presented; a counter never returns to a rung at or below
        // one already claimed, so the ladder needs no cap and claims need no count limit.
        const threshold = reached[reached.length - 1];
        const counter = noticeCounterKey({ scopeKey: entry.scopeKey, dimension, targetRevision: revision, counterEpoch, periodId: entry.periodId });
        const local = this.localClaims.get(counter);
        const localThreshold = local && this.claimLive(local.scopeKey, local.periodId, local.claimedAt, aggregate, now) ? local.threshold : 0;
        if (threshold <= Math.max(localThreshold, claimed.get(counter) ?? 0)) continue;
        const key = noticeKey({ scopeKey: entry.scopeKey, dimension, targetRevision: revision, counterEpoch, periodId: entry.periodId, threshold });
        candidates.push({
          key,
          counter,
          scopeKey: entry.scopeKey,
          periodId: entry.periodId ?? '-',
          threshold,
          alert: {
            key,
            loudness: thresholdLoudness(threshold),
            threshold,
            scope: entry.kind,
            dimension,
            requestId,
            ...(this.requestRoots.get(requestId) ? { rootAgentId: this.requestRoots.get(requestId)!.agentId } : {}),
            ...(entry.kind === 'agent-period' ? { agentId, agentName: this.safe(() => this.deps.agentName?.(agentId), undefined) ?? agentId } : {}),
            ...(entry.periodId ? { periodId: entry.periodId } : {}),
            valueText: dimension === 'tokens' ? `${formatTokens(totals.eligibleTokens)} tokens` : formatUsd(totals.eligibleNanoUsd),
            targetText: dimension === 'tokens' ? `${formatTokens(Number(targetValue))} tokens` : formatUsd(targetValue),
            basisText: this.basisText(totals, dimension),
            repositoryNarrowed: target.repositoryNarrowed,
            reset: entry.reset,
          },
        });
      }
    }
    if (candidates.length === 0) return;
    const won = await this.claim(candidates);
    for (const candidate of candidates) {
      if (!won.has(candidate.key)) continue;
      const alert = candidate.alert;
      const stopToken = this.randomId();
      this.stopTokens.set(stopToken, alert.requestId);
      if (this.stopTokens.size > 200) this.stopTokens.delete(this.stopTokens.keys().next().value as string);
      try {
        this.deps.notifier.threshold({ ...alert, stopToken });
      } catch (error) {
        this.log(`Spend reminder could not be shown: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private basisText(totals: CounterTotals, dimension: 'tokens' | 'usd'): string {
    if (dimension === 'tokens') return 'reported tokens';
    const rows = totals.byClass;
    const parts: string[] = [];
    if (rows.billed.count > 0) parts.push('billed');
    if (rows['exact-route'].count > 0) parts.push('account or user-configured estimate');
    if (rows['selected-reference'].count > 0) parts.push('your selected reference estimate');
    return parts.join(' + ') || 'eligible estimate';
  }

  /**
   * Durably claim one threshold per counter; returns the keys this window won. A counter's claim is won only above
   * the highest live threshold any window claimed for it. A busy lock retries, never blocks work.
   */
  private async claim(candidates: ClaimCandidate[]): Promise<Set<string>> {
    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
      try {
        const now = this.now();
        const won = await this.deps.ledger.transact((control) => {
          const aggregate = this.currentAggregate();
          const claimed = this.liveClaims(control.noticeClaims, aggregate, now);
          const fresh = candidates.filter((candidate) => candidate.threshold > (claimed.get(candidate.counter) ?? 0));
          if (fresh.length === 0) return { result: new Set<string>() };
          const claimedAt = new Date(now).toISOString();
          const claims = this.compactClaims([...control.noticeClaims, ...fresh.map(({ key }) => ({ key, claimedAt }))], aggregate, now);
          return { next: { ...control, noticeClaims: claims }, result: new Set(fresh.map(({ key }) => key)) };
        });
        for (const candidate of candidates) {
          if (!won.has(candidate.key)) continue;
          this.localClaims.set(candidate.counter, { threshold: candidate.threshold, claimedAt: now, scopeKey: candidate.scopeKey, periodId: candidate.periodId });
        }
        return won;
      } catch (error) {
        if (!(error instanceof SpendLockBusyError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.deps.claimRetryMs ?? 2_000));
      }
    }
    return new Set();
  }

  /**
   * Whether a claim still holds its counter (design §13.4; D2 in the v0.9.89 audit request). A period claim lapses
   * when its period ends. A request claim lapses once the request goes 30 days without recorded usage after the
   * claim, so a request resumed after that reminds again at its current rung. Stored and in-memory claims, the
   * reminder check and pruning all use this one rule.
   */
  private claimLive(scopeKey: string, periodId: string, claimedAt: number, aggregate: AggregateResult, now: number): boolean {
    if (periodId !== '-') {
      const at = periodId.indexOf('@');
      if (at <= 0) return true;
      const label = periodId.slice(0, at);
      const current = periodIdFor(now, label.length === 7 ? 'month' : 'day', periodId.slice(at + 1));
      return current === undefined || current.slice(0, label.length) <= label;
    }
    if (!scopeKey.startsWith('request:') || !Number.isFinite(claimedAt)) return true;
    let previous = claimedAt;
    for (const at of this.requestActivity(aggregate).get(scopeKey.slice('request:'.length)) ?? []) {
      if (at <= claimedAt) continue;
      if (at - previous >= REQUEST_CLAIM_IDLE_MS) return false;
      previous = at;
    }
    return now - previous < REQUEST_CLAIM_IDLE_MS;
  }

  private requestActivity(aggregate: AggregateResult): Map<string, number[]> {
    let activity = this.activityCache.get(aggregate);
    if (!activity) {
      const built = new Map<string, number[]>();
      const add = (requestId: string, at: number) => {
        if (!Number.isFinite(at)) return;
        const times = built.get(requestId) ?? [];
        times.push(at);
        built.set(requestId, times);
      };
      for (const unit of aggregate.units.values()) add(unit.requestId, Date.parse(unit.firstRecordedAt));
      for (const contribution of aggregate.contributions) add(contribution.requestId, Date.parse(contribution.recordedAt));
      for (const times of built.values()) times.sort((a, b) => a - b);
      this.activityCache.set(aggregate, built);
      activity = built;
    }
    return activity;
  }

  /** Counter key -> the highest threshold of its live claims. */
  private liveClaims(claims: SpendControlV1['noticeClaims'], aggregate: AggregateResult, now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const claim of claims) {
      const parsed = parseNoticeKey(claim.key);
      if (!parsed || !this.claimLive(parsed.scopeKey, parsed.periodId, Date.parse(claim.claimedAt), aggregate, now)) continue;
      out.set(parsed.counter, Math.max(out.get(parsed.counter) ?? 0, parsed.threshold));
    }
    return out;
  }

  /**
   * Keep one claim per counter, its highest live one (nothing at or below it can be claimed again), and drop lapsed
   * claims. Never by count (design §13.4).
   */
  private compactClaims(claims: SpendControlV1['noticeClaims'], aggregate: AggregateResult, now: number): SpendControlV1['noticeClaims'] {
    const kept: SpendControlV1['noticeClaims'] = [];
    const highest = new Map<string, { claim: SpendControlV1['noticeClaims'][number]; threshold: number }>();
    for (const claim of claims) {
      const parsed = parseNoticeKey(claim.key);
      if (!parsed) { kept.push(claim); continue; }
      if (!this.claimLive(parsed.scopeKey, parsed.periodId, Date.parse(claim.claimedAt), aggregate, now)) continue;
      const prior = highest.get(parsed.counter);
      if (!prior || parsed.threshold > prior.threshold) highest.set(parsed.counter, { claim, threshold: parsed.threshold });
    }
    return [...kept, ...[...highest.values()].map((entry) => entry.claim)];
  }

  // ─── User actions ──────────────────────────────────────────────────────────────

  /** A single-use Stop bound to the request that triggered an alert. */
  consumeStopToken(token: string): { requestId: string } | undefined {
    const requestId = this.stopTokens.get(token);
    if (!requestId) return undefined;
    this.stopTokens.delete(token);
    return { requestId };
  }

  /** Stop the still-live turns of the alert's request; 'already-finished' when none remain. Never another request. */
  stopRequestForAlert(token: string): 'stopped' | 'already-finished' | 'used' {
    const bound = this.consumeStopToken(token);
    if (!bound) return 'used';
    const stopped = this.safe(() => this.deps.stopRequest?.(bound.requestId) ?? 0, 0);
    return stopped > 0 ? 'stopped' : 'already-finished';
  }

  /**
   * Reset one counter (design §6.3): a new counter epoch at the current per-shard watermarks. Receipts are never
   * deleted or repriced, no work is touched, and the full alert ladder can fire again.
   */
  async resetCounter(request: SpendResetRequest): Promise<CounterResetV1> {
    const reset = await this.deps.ledger.transact((control, snapshot) => {
      const aggregate = aggregateSpend(snapshot.events);
      const { targets } = this.effective();
      const scope = this.scopeOfReset(request, targets);
      const previous = scope ? counterTotals(aggregate, control, scope) : undefined;
      const entry: CounterResetV1 = {
        resetId: `reset-${this.randomId()}`,
        scope: request.scope as ResetScope,
        ...(request.scope === 'request' ? { requestId: request.requestId } : {}),
        ...(request.scope === 'agent-period' ? { agentId: request.agentId } : {}),
        ...(request.scope === 'project-period' || request.scope === 'agent-period' ? { periodId: request.periodId } : {}),
        resetAt: new Date(this.now()).toISOString(),
        actor: 'user',
        watermarks: { ...aggregate.watermarks },
        previousTotals: previous ? totalsSnapshot(previous) : { eligibleTokens: 0, eligibleNanoUsd: '0', displayTokens: 0 },
      };
      return { next: { ...control, resets: [...control.resets, entry] }, result: entry };
    });
    this.aggregateDirty = true;
    this.deps.notifier.viewChanged();
    return reset;
  }

  private scopeOfReset(request: SpendResetRequest, targets: EffectiveTargets): CounterScope | undefined {
    switch (request.scope) {
      case 'request': return { kind: 'request', requestId: request.requestId };
      case 'project-period':
        return targets.project ? { kind: 'project-period', periodId: request.periodId, period: targets.project.period, timeZone: targets.project.timeZone } : undefined;
      case 'agent-period':
        return targets.project ? { kind: 'agent-period', agentId: request.agentId, periodId: request.periodId, period: targets.project.period, timeZone: targets.project.timeZone } : undefined;
      case 'project-all':
        return undefined;
    }
  }

  /** Record the user's decision about the repository proposal. Only user actions call this. */
  async decideRepositoryTargets(decision: { mode: 'accepted-digest'; contentDigest: string } | { mode: 'ignore-project' } | { mode: 'review-again' }): Promise<void> {
    await this.deps.ledger.transact((control) => {
      const decidedAt = new Date(this.now()).toISOString();
      if (decision.mode === 'review-again') {
        const { repositoryTargetDecision: _dropped, ...rest } = control;
        return { next: rest as SpendControlV1, result: undefined };
      }
      return {
        next: {
          ...control,
          repositoryTargetDecision: decision.mode === 'accepted-digest'
            ? { mode: 'accepted-digest', contentDigest: decision.contentDigest, decidedAt }
            : { mode: 'ignore-project', decidedAt },
        },
        result: undefined,
      };
    });
    this.deps.notifier.viewChanged();
  }

  repositoryDecision(): SpendControlV1['repositoryTargetDecision'] {
    return this.deps.ledger.snapshot().control.repositoryTargetDecision;
  }

  async repair(): Promise<void> {
    await this.deps.ledger.repair('User ran Repair spend tracking.');
    this.repairNoticeShown = false;
    this.aggregateDirty = true;
    this.deps.notifier.viewChanged();
  }

  /** Ask the ledger to re-read shards (other windows) now. */
  async refresh(): Promise<void> {
    if (await this.deps.ledger.refresh()) this.aggregateDirty = true;
  }

  // ─── Views ─────────────────────────────────────────────────────────────────────

  viewModel(): SpendViewModel {
    const snapshot = this.deps.ledger.snapshot();
    const aggregate = this.currentAggregate();
    const control = snapshot.control;
    const { targets, revision, user } = this.effective();
    const now = this.now();
    // Views ask often (every Team render); rebuild only when events, control, targets or the minute changed.
    const catalogs = this.safe(() => this.deps.catalogs(), {} as ReferenceCatalogs);
    const cacheKey = [this.version, control.revision, snapshot.controlState, snapshot.liveHosts.size, revision, this.writeQueue.length,
      Math.floor(now / 60_000), user.diagnostics.length, catalogs.unode?.catalogId, catalogs.roam?.catalogId].join('|');
    if (this.viewCache?.key === cacheKey) return this.viewCache.view;
    const view = this.buildViewModel(snapshot, aggregate, control, targets, revision, user, now);
    this.viewCache = { key: cacheKey, view };
    return view;
  }

  private buildViewModel(
    snapshot: ReturnType<SpendLedger['snapshot']>,
    aggregate: AggregateResult,
    control: SpendControlV1,
    targets: EffectiveTargets,
    revision: string,
    user: UserTargets,
    now: number,
  ): SpendViewModel {
    const catalogs = this.safe(() => this.deps.catalogs(), {} as ReferenceCatalogs);
    const referenceMode = this.safe(() => this.deps.referenceMode(), 'unselected' as StoredReferencePriceMode);
    const catalogViews = (['unode', 'roam'] as const)
      .map((provider) => catalogs[provider])
      .filter((catalog): catalog is PriceCatalogV1 => !!catalog)
      .map((catalog) => ({ provider: catalog.provider, catalogId: catalog.catalogId, capturedAt: catalog.capturedAt, stale: catalogIsStale(catalog, now), models: catalog.models.length }));

    // Requests, most recent first.
    const requestTimes = new Map<string, string>();
    for (const unit of aggregate.units.values()) {
      const prior = requestTimes.get(unit.requestId);
      if (!prior || unit.firstRecordedAt > prior) requestTimes.set(unit.requestId, unit.firstRecordedAt);
    }
    const recent = [...requestTimes.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, RECENT_REQUESTS);
    const requests = recent.map(([requestId]) => this.counterView(aggregate, control, { kind: 'request', requestId },
      `Request ${requestId.slice(0, 8)}`, targets.request, { scope: 'request', requestId }));

    let project: CounterView | undefined;
    const agents: CounterView[] = [];
    if (this.projectBacked) {
      const period = targets.project?.period ?? 'day';
      const timeZone = targets.project?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
      const periodId = periodIdFor(now, period, timeZone);
      if (periodId) {
        project = this.counterView(aggregate, control, { kind: 'project-period', periodId, period, timeZone },
          `Project, ${period === 'day' ? 'today' : 'this month'} (${periodId.split('@')[0]})`,
          targets.project, { scope: 'project-period', periodId });
        const agentIds = new Set<string>(Object.keys(targets.agents));
        for (const contribution of aggregate.contributions) {
          if (periodIdFor(Date.parse(contribution.recordedAt), period, timeZone) === periodId) agentIds.add(contribution.agentId);
        }
        for (const agentId of [...agentIds].sort()) {
          const name = this.safe(() => this.deps.agentName?.(agentId), undefined) ?? agentId;
          agents.push(this.counterView(aggregate, control, { kind: 'agent-period', agentId, periodId, period, timeZone },
            name, targets.agents[agentId], { scope: 'agent-period', agentId, periodId }));
        }
      }
    }
    const percents = [...requests.slice(0, 1), ...(project ? [project] : []), ...agents]
      .map((view) => view.percent)
      .filter((value): value is number => value !== undefined);
    const highestPercent = percents.length > 0 ? Math.max(...percents) : undefined;
    let openUnits = 0;
    let coverageGaps = 0;
    for (const unit of aggregate.units.values()) {
      if (unit.state === 'gap') coverageGaps += 1;
      else if (unit.state === 'open') {
        if (snapshot.liveHosts.has(this.hostOfUnit(unit.usageUnitId, snapshot.events))) openUnits += 1;
        else coverageGaps += 1; // a gone window's unfinished unit is a gap until recovery records it
      }
    }
    const localZone = targets.project?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const trackedSince = aggregate.firstRecordedAt
      ? periodIdFor(Date.parse(aggregate.firstRecordedAt), 'day', localZone)?.split('@')[0] ?? aggregate.firstRecordedAt.slice(0, 10)
      : undefined;
    const diagnostics = [...aggregate.diagnostics];
    if (snapshot.quarantinedLines > 0) diagnostics.push(`${snapshot.quarantinedLines} unreadable spend record(s) were set aside and are not counted.`);
    if (snapshot.unsupportedLines > 0) diagnostics.push(`${snapshot.unsupportedLines} spend record(s) come from a newer UnodeAi; reminders are paused.`);
    return {
      folderless: !this.projectBacked,
      ...(trackedSince ? { trackedSince } : {}),
      controlState: snapshot.controlState,
      remindersPaused: snapshot.controlState === 'corrupt' || snapshot.controlState === 'unsupported' || snapshot.unsupportedLines > 0,
      diagnostics,
      referenceMode,
      catalogs: catalogViews,
      requests,
      ...(project ? { project } : {}),
      agents,
      openUnits,
      coverageGaps,
      pendingWrites: this.writeQueue.length,
      targets,
      targetDiagnostics: user.diagnostics,
      targetRevision: revision,
      ...(highestPercent !== undefined ? { highestPercent } : {}),
      overTarget: (highestPercent ?? 0) >= 100,
      overTargetAgents: agents.filter((view) => (view.percent ?? 0) >= 100).map((view) => view.agentId!).filter(Boolean),
    };
  }

  private hostOfUnit(usageUnitId: string, events: readonly StoredSpendEvent[]): string {
    const start = events.find((stored) => stored.event.kind === 'usage-unit-start' && stored.event.usageUnitId === usageUnitId);
    return start?.event.hostEpoch ?? '';
  }

  private counterView(
    aggregate: AggregateResult,
    control: SpendControlV1,
    scope: CounterScope,
    title: string,
    target: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount } | undefined,
    reset: SpendResetRequest,
  ): CounterView {
    const totals = counterTotals(aggregate, control, scope);
    const latest = latestApplicableReset(control, scope);
    const rows: SpendRowView[] = [];
    for (const [cls, row] of Object.entries(totals.byClass)) {
      if (row.count === 0) continue;
      rows.push({
        label: CLASS_LABELS[cls] ?? cls,
        tokens: row.tokens,
        ...(row.hasCost ? { costText: `${cls === 'billed' ? '' : '~'}${formatUsd(row.nanoUsd)}` } : {}),
      });
    }
    const percent = (() => {
      const values: number[] = [];
      if (target?.tokens) values.push(Math.floor((totals.eligibleTokens * 100) / Number(target.tokens.value)));
      if (target?.nanoUsd) values.push(Number((totals.eligibleNanoUsd * 100n) / BigInt(target.nanoUsd.value)));
      return values.length > 0 ? Math.max(...values) : undefined;
    })();
    return {
      kind: scope.kind,
      title,
      ...(scope.kind === 'request' ? { requestId: scope.requestId } : {}),
      ...(scope.kind === 'agent-period' ? { agentId: scope.agentId } : {}),
      ...(scope.kind !== 'request' ? { periodId: scope.periodId } : {}),
      eligibleTokens: totals.eligibleTokens,
      eligibleNanoUsd: totals.eligibleNanoUsd,
      tokens: { input: totals.inputTokens, cached: totals.cachedInputTokens, output: totals.outputTokens, total: totals.displayTokens },
      rows,
      unattributedUnits: totals.unattributedUnits,
      ...(target && (target.tokens || target.nanoUsd) ? { target } : {}),
      ...(percent !== undefined ? { percent } : {}),
      counterEpoch: latest?.resetId ?? 'initial',
      ...(latest ? { lastReset: { resetAt: latest.resetAt, previousTokens: latest.previousTotals.eligibleTokens } } : {}),
      reset,
    };
  }

  /**
   * Coverage-gap recovery (design §9, §13.3 step 7): an open unit whose window is gone gets one gap. Exact
   * progress it already stored stays counted. Deterministic gap ids make two recovering windows agree.
   */
  async recoverAbandonedUnits(): Promise<number> {
    await this.deps.ledger.refresh();
    const snapshot = this.deps.ledger.snapshot();
    const aggregate = aggregateSpend(snapshot.events);
    let recovered = 0;
    for (const unit of aggregate.units.values()) {
      if (unit.state !== 'open') continue;
      const host = this.hostOfUnit(unit.usageUnitId, snapshot.events);
      if (!host || snapshot.liveHosts.has(host)) continue;
      await this.deps.ledger.append({ kind: 'coverage-gap', usageUnitId: unit.usageUnitId, requestId: unit.requestId, reason: 'no-terminal-usage' }, `gap:${unit.usageUnitId}`);
      recovered += 1;
    }
    if (recovered > 0) {
      this.aggregateDirty = true;
      this.deps.notifier.viewChanged();
    }
    return recovered;
  }

  /**
   * For each agent, whether a dollar target covers its route and on what basis (design §6.1). Subscription routes
   * and routes without an exact or selected price count tokens only.
   */
  dollarCoverage(agents: Array<{ agentId: string; modelId: string }>): DollarCoverage[] {
    return agents.map(({ agentId, modelId }) => {
      const route = this.safe(() => this.deps.resolveRoute(agentId, modelId), undefined);
      const connectionName = route?.connectionName ?? 'unknown route';
      if (!route) return { agentId, connectionName, coverage: 'tokens-only', detail: 'route unknown: tokens only' };
      if (route.route === 'subscription') {
        return {
          agentId, connectionName, coverage: 'billed-when-reported',
          detail: 'counts a cost the CLI reports as billed; subscription (API-equivalent) dollars never count, tokens always do',
        };
      }
      const pin = this.pinFor(route, modelId);
      if (pin.reminder && (pin.reminder.basis === 'unode-reference' || pin.reminder.basis === 'roam-reference')) {
        return { agentId, connectionName, coverage: 'selected-reference', detail: `${costBasisLabel(pin.reminder.basis)} (you chose it)` };
      }
      if (pin.reminder) {
        return { agentId, connectionName, coverage: 'exact-route', detail: costBasisLabel(pin.reminder.basis, connectionName) };
      }
      return {
        agentId, connectionName, coverage: 'tokens-only',
        detail: 'no billed, account or chosen reference price for this model yet: tokens only',
      };
    });
  }

  /** User-facing label for a cost basis, with the connection name for account estimates. */
  label(basis: CostBasis, connectionName?: string): string {
    return costBasisLabel(basis, connectionName);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retryWake) {
      clearTimeout(this.retryWake.timer);
      this.retryWake.resolve();
      this.retryWake = undefined;
    }
    while (this.draining) await this.draining;
    // One last attempt for anything still queued; what fails now becomes a coverage gap when another window
    // recovers this window's open units.
    for (const write of this.writeQueue.splice(0)) {
      try {
        await this.deps.ledger.append(write.payload, write.eventId);
      } catch (error) {
        this.log(`Spend event not recorded before closing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.disposeLedgerListener();
    await this.deps.ledger.dispose();
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (error) {
      this.log(`Spend input unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }
}
