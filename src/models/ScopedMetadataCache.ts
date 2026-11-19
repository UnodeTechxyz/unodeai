/**
 * A small, host-free cache for metadata that is scoped by its caller before it is shared.
 *
 * A cache is a performance detail, never an authority to contact a host or show data from a different
 * connection.  Callers must make their route/egress decision before asking this cache for a value, and put
 * the connection, route and credential fingerprint in `key`.
 */
export type MetadataCacheState = 'fresh' | 'stale' | 'unknown';

export interface MetadataCacheResult<T> {
  value: T;
  state: Exclude<MetadataCacheState, 'unknown'>;
  /** True when this caller reused a completed value rather than initiating a load. */
  cached: boolean;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

interface PendingLoad<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

export const DEFAULT_METADATA_TTL_MS = 60_000;
export const MAX_METADATA_TTL_MS = 10 * 60_000;
export const MIN_METADATA_TTL_MS = 1_000;

/** A bounded TTL prevents an accidental option from making metadata effectively permanent. */
export function boundedMetadataTtl(ttlMs: number | undefined, fallback = DEFAULT_METADATA_TTL_MS): number {
  const candidate = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : fallback;
  return Math.min(MAX_METADATA_TTL_MS, Math.max(MIN_METADATA_TTL_MS, candidate));
}

/** A stable routing tag, not a secrecy mechanism. It must never be described as one. */
export function credentialFingerprint(apiKey?: string): string {
  if (!apiKey) {
    return 'anon';
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i++) {
    hash ^= apiKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function metadataAbortError(): Error {
  const error = new Error('Metadata request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Bounded-TTL, keyed de-duplication with per-caller cancellation.
 *
 * Cancelling one consumer stops only that consumer waiting. The shared transport is aborted only once every
 * consumer has lost interest, so one picker closing cannot corrupt another picker that asked for the same
 * connection. A failed refresh retains an older value as explicitly `stale`; a first failure is `unknown`
 * to the caller, which must use its own local fallback rather than inventing a value.
 */
export class ScopedMetadataCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, PendingLoad<T>>();

  constructor(
    private readonly ttlMs = DEFAULT_METADATA_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  state(key: string): MetadataCacheState {
    const entry = this.entries.get(key);
    if (!entry) {
      return 'unknown';
    }
    return this.now() - entry.storedAt < boundedMetadataTtl(this.ttlMs) ? 'fresh' : 'stale';
  }

  clear(): void {
    this.entries.clear();
  }

  async get(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<MetadataCacheResult<T>> {
    if (signal?.aborted) {
      throw metadataAbortError();
    }

    const existing = this.entries.get(key);
    if (existing && this.state(key) === 'fresh') {
      return { value: existing.value, state: 'fresh', cached: true };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => load(controller.signal))
        .then((value) => {
          this.entries.set(key, { value, storedAt: this.now() });
          return value;
        })
        .finally(() => {
          this.pending.delete(key);
        });
      pending = { promise, controller, waiters: 0 };
      this.pending.set(key, pending);
    }

    pending.waiters++;
    try {
      const value = await this.waitForCaller(pending, signal);
      return { value, state: 'fresh', cached: false };
    } catch (error) {
      // Cancellation answers a different question from refresh failure. A caller that explicitly stopped
      // waiting must not receive an old value as though its cancelled operation completed successfully.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      // An old result remains useful only when the new fetch failed. It is deliberately labelled stale so a
      // UI cannot render it as the current connection's truth.
      if (existing) {
        return { value: existing.value, state: 'stale', cached: true };
      }
      throw error;
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.pending.get(key) === pending) {
        pending.controller.abort();
      }
    }
  }

  private async waitForCaller(pending: PendingLoad<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return pending.promise;
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(metadataAbortError());
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      void pending.promise.then(
        (value) => { cleanup(); resolve(value); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    });
  }
}
