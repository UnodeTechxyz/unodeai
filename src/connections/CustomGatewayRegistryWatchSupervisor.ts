/** Minimal watcher shape so recovery logic remains testable without a Node or VS Code host. */
export interface CustomGatewayRegistryWatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CustomGatewayRegistryWatchSupervisorOptions {
  directory: string;
  registryFileName: string;
  watchDirectory: (
    directory: string,
    onChange: (eventType: string, fileName: string | Buffer | undefined) => void,
  ) => CustomGatewayRegistryWatchHandle;
  onRegistryChange: () => void;
  onWatcherError: (error: unknown) => void;
  /** Called after a failed watcher is re-established; call markCurrent only after a successful reload. */
  onWatcherRecovered: () => void;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Re-establishes the profile-registry watcher with bounded exponential backoff. A watch failure is
 * security-significant: custom routes remain stale until a caller has re-read the registry and
 * explicitly marks this supervisor current again.
 */
export class CustomGatewayRegistryWatchSupervisor {
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private retryDelayMs: number;
  private watcher: CustomGatewayRegistryWatchHandle | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private stale = false;

  constructor(private readonly options: CustomGatewayRegistryWatchSupervisorOptions) {
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.retryDelayMs = this.initialRetryDelayMs;
  }

  get isStale(): boolean {
    return this.stale;
  }

  start(): void {
    this.installWatcher();
  }

  /** The caller has successfully re-read the registry after a recovered watcher. */
  markCurrent(): void {
    if (!this.disposed && this.watcher) {
      this.stale = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  private installWatcher(): void {
    if (this.disposed || this.watcher) {
      return;
    }
    try {
      const watcher = this.options.watchDirectory(this.options.directory, (_eventType, fileName) => {
        if (fileName?.toString() === this.options.registryFileName) {
          this.options.onRegistryChange();
        }
      });
      this.watcher = watcher;
      watcher.on('error', (error) => this.handleWatcherError(watcher, error));
      if (this.stale) {
        this.options.onWatcherRecovered();
      }
      this.retryDelayMs = this.initialRetryDelayMs;
    } catch (error) {
      this.handleWatcherError(undefined, error);
    }
  }

  private handleWatcherError(source: CustomGatewayRegistryWatchHandle | undefined, error: unknown): void {
    if (this.disposed || (source !== undefined && source !== this.watcher)) {
      return;
    }
    if (source) {
      source.close();
      this.watcher = undefined;
    }
    const newlyStale = !this.stale;
    this.stale = true;
    if (newlyStale) {
      this.options.onWatcherError(error);
    }
    if (this.retryTimer) {
      return;
    }
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.installWatcher();
    }, delay);
  }
}

/** Deny custom-gateway egress while its file watcher is stale; built-ins remain unaffected. */
export function assertCustomGatewayRegistryWatchCurrent(
  connectionId: string,
  supervisor: Pick<CustomGatewayRegistryWatchSupervisor, 'isStale'> | undefined,
): void {
  if (connectionId.startsWith('custom:') && supervisor?.isStale) {
    throw new Error('Custom gateway registry monitoring is unavailable. Repair the registry or wait for monitoring to recover before sending another request.');
  }
}
