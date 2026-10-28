/** One logical OpenAI response's retry limit and optional finite time limit. Infinity means no time ceiling. */
export class ResponseBudgetExhausted extends Error {
  constructor(readonly attempts: number, readonly elapsedMs: number, readonly totalMs: number,
    readonly maxAttempts: number, cause?: unknown) {
    super(elapsedMs >= totalMs
      ? `Response gave up after ${elapsedMs}ms across ${attempts} attempt(s), exceeding the ${totalMs}ms total budget.`
      : `Response stopped after ${attempts} attempt(s), exhausting its ${maxAttempts} allowed attempt(s).`, { cause });
    this.name = 'ResponseBudgetExhausted';
  }
}

/** Stack-owned, never persisted: it carries no body, request identity, execution evidence, logger or timer. */
export class ResponseAttemptBudget {
  readonly maxAttempts: number;
  private used = 0;
  private started = false;
  private activeSince?: number;
  private accumulated = 0;
  private hostWaitDepth = 0;
  private latestClock?: number;

  constructor(maxRetries: number, readonly totalMs: number, private readonly clock: () => number = Date.now) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries >= Number.MAX_SAFE_INTEGER
      || totalMs !== Infinity && (!Number.isSafeInteger(totalMs) || totalMs < 1)) throw new Error('Invalid response retry budget.');
    this.maxAttempts = maxRetries + 1;
  }

  get attempts(): number { return this.used; }
  get elapsedMs(): number {
    return this.accumulated + (this.activeSince === undefined ? 0 : this.now() - this.activeSince);
  }
  get remainingMs(): number { return Math.max(0, this.totalMs - this.elapsedMs); }
  get canAttempt(): boolean { return this.hostWaitDepth === 0 && this.used < this.maxAttempts && this.remainingMs > 0; }

  /** Call only after consent, request boundary, current-route and Stop checks, immediately before actual send. */
  takeAttempt(): number {
    if (this.hostWaitDepth > 0 || this.used >= this.maxAttempts) throw this.exhausted();
    const at = this.now();
    const remaining = this.totalMs - this.accumulated - (this.activeSince === undefined ? 0 : at - this.activeSince);
    if (remaining <= 0) throw this.exhausted();
    if (!this.started) { this.started = true; this.activeSince = at; }
    this.used++;
    return remaining;
  }

  /** Existing host consent/limit waits are not provider time. Never wrap a fetch, body read, or retry backoff. */
  async waitForHost<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hostWaitDepth++ === 0 && this.activeSince !== undefined) {
      this.accumulated += this.now() - this.activeSince;
      this.activeSince = undefined;
    }
    try { return await operation(); }
    finally {
      this.hostWaitDepth--;
      if (this.hostWaitDepth === 0 && this.started) this.activeSince = this.now();
    }
  }

  exhausted(cause?: unknown): ResponseBudgetExhausted {
    return new ResponseBudgetExhausted(this.used, this.elapsedMs, this.totalMs, this.maxAttempts, cause);
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Response clock unavailable.');
    this.latestClock = Math.max(this.latestClock ?? value, value);
    return this.latestClock;
  }
}
