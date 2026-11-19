/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request limit meter (v0.9.94)
 *
 *  A request limit counts what the spend records count, from the same calls: a usage unit begins under a
 *  request, each model request of it is one provider request, and its token figures arrive as progress and as
 *  the terminal usage. The host shows the meter every usage call it makes to the spend port, in the same order,
 *  so neither reader can see a call the other missed. A failure here never reaches the caller.
 *
 *  A unit says who made its requests and how each is counted: one by one where the host sees every request
 *  leave, or as one per turn where a CLI makes the requests inside a turn the host started.
 *
 *  A request with no limit is not metered at all: nothing is kept for its units.
 *--------------------------------------------------------------------------------------------*/

import type { TokenCounts } from '../models/spend/Money';

/** `request`: the host saw that request leave. `turn`: a turn the host started on a CLI route, counted as one. */
export type MeteredCountKind = 'request' | 'turn';

/** The totals side of the request ceiling. Every call is a no-op for a request that has no limit. */
export interface RequestLimitTotals {
  /** Whether the request has a limit. */
  governs(requestId: string): boolean;
  /** One provider request by this agent. A request the agent reserved at a boundary is not counted twice. */
  noteProviderRequest(requestId: string, agentId: string, counted: MeteredCountKind): void;
  /** The latest token total of one open usage unit. A later figure for the same unit replaces the earlier one. */
  noteUsage(requestId: string, usageUnitId: string, counts: TokenCounts): void;
  /** The unit is over: its terminal counts replace what it reported, or without them its last figure stays. */
  settleUsage(requestId: string, usageUnitId: string, counts?: TokenCounts): void;
  /** Some usage of the request is unknown: its token total is a lower bound from now on. */
  markUsageIncomplete(requestId: string): void;
}

interface UsageFigure {
  inputTokens: number;
  outputTokens: number;
}

interface MeteredUnit {
  requestId: string;
  agentId: string;
  counted: MeteredCountKind;
  providerRequests: number;
  /** Attempts whose progress is already in the sums, so a figure reported twice is counted once. */
  progressAttempts: Set<number>;
  input: number;
  output: number;
}

/** Units metered at once. One more than this ends the oldest as unknown usage, never as zero. */
export const MAX_METERED_UNITS = 2_000;

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export class RequestLimitMeter {
  private readonly units = new Map<string, MeteredUnit>();

  /**
   * `countsTurns` says whether an agent's turns are what the host counts: true where a CLI makes the model
   * requests inside a turn. It is asked once, when a unit of that agent begins.
   */
  constructor(
    private readonly totals: RequestLimitTotals,
    private readonly countsTurns: (agentId: string) => boolean,
  ) {}

  /** `counted` overrides the agent's route for a unit whose requests the host sends itself, one by one. */
  beginUsageUnit(unit: { usageUnitId: string; requestId: string; agentId: string }, counted?: MeteredCountKind): void {
    this.guarded(() => {
      this.units.delete(unit.usageUnitId);
      if (!this.totals.governs(unit.requestId)) return;
      this.units.set(unit.usageUnitId, {
        requestId: unit.requestId,
        agentId: unit.agentId,
        counted: counted ?? (this.countsTurns(unit.agentId) ? 'turn' : 'request'),
        providerRequests: 0,
        progressAttempts: new Set(),
        input: 0,
        output: 0,
      });
      if (this.units.size > MAX_METERED_UNITS) {
        const [oldestId, oldest] = this.units.entries().next().value as [string, MeteredUnit];
        this.endWithoutUsage(oldestId, oldest, true);
      }
    });
  }

  noteModelRequest(usageUnitId: string): void {
    this.guarded(() => {
      const unit = this.units.get(usageUnitId);
      if (!unit) return;
      unit.providerRequests += 1;
      this.totals.noteProviderRequest(unit.requestId, unit.agentId, unit.counted);
    });
  }

  /** One completed response of the unit. The unit's running total is the sum over its attempts. */
  noteUsageProgress(usageUnitId: string, progress: { attempt: number } & UsageFigure): void {
    this.guarded(() => {
      const unit = this.units.get(usageUnitId);
      if (!unit) return;
      const { attempt } = progress;
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > unit.providerRequests || unit.progressAttempts.has(attempt)) return;
      const input = tokenCount(progress.inputTokens);
      const output = tokenCount(progress.outputTokens);
      if (input === undefined || output === undefined) return;
      unit.progressAttempts.add(attempt);
      unit.input += input;
      unit.output += output;
      this.totals.noteUsage(unit.requestId, usageUnitId, { input: unit.input, output: unit.output });
    });
  }

  /**
   * The unit is over. Its terminal usage covers the whole unit and replaces the progress sum. A unit that made a
   * request and ends without a usable figure leaves the request's token total incomplete.
   */
  settleUsageUnit(usageUnitId: string, usage: UsageFigure | undefined): void {
    this.guarded(() => {
      const unit = this.units.get(usageUnitId);
      if (!unit) return;
      const input = usage ? tokenCount(usage.inputTokens) : undefined;
      const output = usage ? tokenCount(usage.outputTokens) : undefined;
      if (input === undefined || output === undefined) {
        this.endWithoutUsage(usageUnitId, unit, false);
        return;
      }
      this.units.delete(usageUnitId);
      // Usage reported without an observed request start still came from a provider request.
      if (unit.providerRequests === 0) this.totals.noteProviderRequest(unit.requestId, unit.agentId, unit.counted);
      this.totals.settleUsage(unit.requestId, usageUnitId, { input, output });
    });
  }

  closeUsageUnit(usageUnitId: string): void {
    this.guarded(() => {
      const unit = this.units.get(usageUnitId);
      if (unit) this.endWithoutUsage(usageUnitId, unit, false);
    });
  }

  /** `dropped`: the meter gave the unit up, so what it goes on to use is unknown even if it made no request yet. */
  private endWithoutUsage(usageUnitId: string, unit: MeteredUnit, dropped: boolean): void {
    this.units.delete(usageUnitId);
    // What the unit reported while it ran stays in the total; it is only no longer kept by itself.
    this.totals.settleUsage(unit.requestId, usageUnitId);
    // A unit that never made a request used nothing: there is no gap to report.
    if (dropped || unit.providerRequests > 0) this.totals.markUsageIncomplete(unit.requestId);
  }

  private guarded(note: () => void): void {
    try {
      note();
    } catch {
      /* metering never changes what the spend records do */
    }
  }
}
