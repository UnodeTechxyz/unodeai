export interface AutomaticRefreshSettings {
  version: 1;
  providers: Record<string, boolean>;
  globalPricingSources: boolean;
}

export const DEFAULT_AUTOMATIC_REFRESH_SETTINGS: AutomaticRefreshSettings = {
  version: 1,
  providers: {},
  globalPricingSources: true,
};

export function readAutomaticRefreshSettings(raw: unknown): AutomaticRefreshSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AUTOMATIC_REFRESH_SETTINGS, providers: {} };
  }
  const value = raw as Record<string, unknown>;
  const providers: Record<string, boolean> = {};
  if (value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers)) {
    for (const [providerId, enabled] of Object.entries(value.providers as Record<string, unknown>)) {
      if (providerId.trim() && typeof enabled === 'boolean') {
        providers[providerId] = enabled;
      }
    }
  }
  return {
    version: 1,
    providers,
    globalPricingSources: typeof value.globalPricingSources === 'boolean'
      ? value.globalPricingSources
      : true,
  };
}

export function providerAutomaticRefreshEnabled(
  settings: AutomaticRefreshSettings,
  providerId: string,
): boolean {
  return settings.providers[providerId] ?? true;
}

export function withProviderAutomaticRefresh(
  settings: AutomaticRefreshSettings,
  providerId: string,
  enabled: boolean,
): AutomaticRefreshSettings {
  if (!providerId.trim()) return settings;
  return {
    ...settings,
    providers: { ...settings.providers, [providerId]: enabled },
  };
}

export function withGlobalPricingSourcesAutomaticRefresh(
  settings: AutomaticRefreshSettings,
  enabled: boolean,
): AutomaticRefreshSettings {
  return { ...settings, globalPricingSources: enabled };
}

export function filterAutomaticPricingSources<T extends { providerId?: string }>(
  settings: AutomaticRefreshSettings,
  sources: readonly T[],
): T[] {
  return sources.filter((source) => source.providerId
    ? providerAutomaticRefreshEnabled(settings, source.providerId)
    : settings.globalPricingSources);
}

export function scheduleDailyAutomaticRefresh(
  register: (callback: () => void, everyMs: number) => ReturnType<typeof setInterval>,
  refresh: () => void,
): { dispose(): void } {
  const timer = register(refresh, 24 * 60 * 60 * 1000);
  return { dispose: () => clearInterval(timer) };
}

/**
 * Coalesces overlapping automatic refreshes and applies exponential back-off after failures.
 * Manual/user-triggered requests deliberately do not use this coordinator.
 */
export class AutomaticRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseBackoffMs = 30_000,
    private readonly maxBackoffMs = 30 * 60_000,
  ) {}

  isBackingOff(key: string): boolean {
    return (this.failures.get(key)?.retryAt ?? 0) > this.now();
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
    const active = this.inFlight.get(key) as Promise<T> | undefined;
    if (active) return active;
    if (this.isBackingOff(key)) return Promise.resolve(undefined);

    const run = task().then(
      (value) => {
        this.failures.delete(key);
        return value;
      },
      (error) => {
        const count = (this.failures.get(key)?.count ?? 0) + 1;
        const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** (count - 1)));
        this.failures.set(key, { count, retryAt: this.now() + delay });
        throw error;
      },
    ).finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }
}
