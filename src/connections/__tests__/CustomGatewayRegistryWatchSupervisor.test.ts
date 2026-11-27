import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCustomGatewayRegistryWatchCurrent,
  CustomGatewayRegistryWatchHandle,
  CustomGatewayRegistryWatchSupervisor,
} from '../CustomGatewayRegistryWatchSupervisor';

class FakeWatcher implements CustomGatewayRegistryWatchHandle {
  private errorHandler: ((error: Error) => void) | undefined;
  closed = false;

  on(event: 'error', listener: (error: Error) => void): unknown {
    if (event === 'error') {
      this.errorHandler = listener;
    }
    return this;
  }

  close(): void {
    this.closed = true;
  }

  emitError(error: Error): void {
    this.errorHandler?.(error);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CustomGatewayRegistryWatchSupervisor', () => {
  it('denies custom egress after a watcher error until a recovered watcher is revalidated', () => {
    vi.useFakeTimers();
    const watchers: FakeWatcher[] = [];
    const failures: Error[] = [];
    let recovered = 0;
    const supervisor = new CustomGatewayRegistryWatchSupervisor({
      directory: 'C:/profile-store',
      registryFileName: 'custom-gateways.json',
      watchDirectory: () => {
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher;
      },
      onRegistryChange: () => {},
      onWatcherError: (error) => failures.push(error as Error),
      onWatcherRecovered: () => { recovered += 1; },
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 20,
    });

    supervisor.start();
    watchers[0].emitError(new Error('directory renamed'));

    expect(supervisor.isStale).toBe(true);
    expect(watchers[0].closed).toBe(true);
    expect(failures).toHaveLength(1);
    expect(() => assertCustomGatewayRegistryWatchCurrent('custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', supervisor)).toThrow(/monitoring is unavailable/);
    expect(() => assertCustomGatewayRegistryWatchCurrent('unode', supervisor)).not.toThrow();

    vi.advanceTimersByTime(10);
    expect(watchers).toHaveLength(2);
    expect(recovered).toBe(1);
    expect(supervisor.isStale).toBe(true);

    supervisor.markCurrent();
    expect(supervisor.isStale).toBe(false);
    expect(() => assertCustomGatewayRegistryWatchCurrent('custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', supervisor)).not.toThrow();
  });

  it('backs off retry attempts after repeated watcher creation failures', () => {
    vi.useFakeTimers();
    let attempts = 0;
    const supervisor = new CustomGatewayRegistryWatchSupervisor({
      directory: 'C:/profile-store',
      registryFileName: 'custom-gateways.json',
      watchDirectory: () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('directory missing');
        }
        return new FakeWatcher();
      },
      onRegistryChange: () => {},
      onWatcherError: () => {},
      onWatcherRecovered: () => {},
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 20,
    });

    supervisor.start();
    expect(attempts).toBe(1);
    vi.advanceTimersByTime(10);
    expect(attempts).toBe(2);
    vi.advanceTimersByTime(19);
    expect(attempts).toBe(2);
    vi.advanceTimersByTime(1);
    expect(attempts).toBe(3);
    expect(supervisor.isStale).toBe(true);
  });
});
