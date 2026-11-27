/*---------------------------------------------------------------------------------------------
 * Media capability facts are deliberately narrower than general model capability profiles.
 *
 * A missing `vision` flag is not a license to upload an image.  The cache is process-local and
 * keyed by the whole execution route, so one gateway/model rejection cannot poison another
 * gateway, model, or media class.  It also has no persistence API: a runtime observation is not a
 * user-owned configuration change.
 *--------------------------------------------------------------------------------------------*/

export type MediaClass = 'image' | 'audio';
export type MediaCapabilityState = 'supported' | 'unsupported' | 'unknown';
export type MediaCapabilitySource = 'declared' | 'observed';

export interface MediaCapabilityRoute {
  connectionId: string;
  modelId: string;
  /** Canonical endpoint base, rather than just the host: different gateway paths are different routes. */
  endpointBase: string;
}

export interface MediaCapability {
  state: MediaCapabilityState;
  source: MediaCapabilitySource;
  detail: string;
  observedAt?: string;
}

export interface MediaCapabilityObservation {
  state: Exclude<MediaCapabilityState, 'unknown'>;
  detail: string;
  observedAt?: string;
}

export function mediaCapabilityKey(route: MediaCapabilityRoute, mediaClass: MediaClass): string {
  return [
    route.connectionId.trim().toLowerCase() || 'unknown',
    route.modelId.trim().toLowerCase() || 'unknown',
    route.endpointBase.trim().toLowerCase() || 'unknown',
    mediaClass,
  ].join('::');
}

/**
 * A scoped, in-memory result cache.  `observe` intentionally gives the shared operation no caller
 * AbortSignal.  A caller may stop waiting, but cannot abort discovery that another caller is sharing.
 */
export class MediaCapabilityCache {
  private readonly observations = new Map<string, MediaCapabilityObservation & { observedAt: string }>();
  private readonly inFlight = new Map<string, Promise<MediaCapabilityObservation>>();

  resolve(route: MediaCapabilityRoute, mediaClass: MediaClass, declared: boolean | undefined): MediaCapability {
    const key = mediaCapabilityKey(route, mediaClass);
    const observed = this.observations.get(key);
    if (observed) {
      return { ...observed, source: 'observed' };
    }
    if (declared === true) {
      return { state: 'supported', source: 'declared', detail: 'The selected route declares support for this media class.' };
    }
    if (declared === false) {
      return { state: 'unsupported', source: 'declared', detail: 'The selected route declares that it does not support this media class.' };
    }
    return { state: 'unknown', source: 'declared', detail: 'This route has not declared support for this media class.' };
  }

  record(route: MediaCapabilityRoute, mediaClass: MediaClass, observation: MediaCapabilityObservation): MediaCapability {
    const observedAt = observation.observedAt ?? new Date().toISOString();
    const stored = { ...observation, observedAt };
    this.observations.set(mediaCapabilityKey(route, mediaClass), stored);
    return { ...stored, source: 'observed' };
  }

  observe(
    route: MediaCapabilityRoute,
    mediaClass: MediaClass,
    discover: () => Promise<MediaCapabilityObservation>,
  ): Promise<MediaCapability> {
    const key = mediaCapabilityKey(route, mediaClass);
    const existing = this.observations.get(key);
    if (existing) {
      return Promise.resolve({ ...existing, source: 'observed' });
    }
    let shared = this.inFlight.get(key);
    if (!shared) {
      shared = Promise.resolve()
        .then(discover)
        .then((observation) => {
          this.record(route, mediaClass, observation);
          return observation;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, shared);
    }
    return shared.then((observation) => ({
      ...this.observations.get(key) ?? { ...observation, observedAt: observation.observedAt ?? new Date().toISOString() },
      source: 'observed' as const,
    }));
  }
}

/** Wait without transmitting cancellation into the shared observation. */
export function awaitMediaCapability<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) { return promise; }
  if (signal.aborted) { return Promise.reject(abortError()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function abortError(): Error {
  const error = new Error('Media capability observation wait was cancelled.');
  error.name = 'AbortError';
  return error;
}
