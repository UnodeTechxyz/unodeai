import { describe, expect, it, vi } from 'vitest';
import {
  AutomaticRefreshCoordinator,
  filterAutomaticPricingSources,
  providerAutomaticRefreshEnabled,
  readAutomaticRefreshSettings,
  scheduleDailyAutomaticRefresh,
  withGlobalPricingSourcesAutomaticRefresh,
  withProviderAutomaticRefresh,
} from '../AutomaticRefreshPolicy';

describe('AutomaticRefreshPolicy', () => {
  it('defaults existing and new providers and global sources to on, from user-owned state only', () => {
    const settings = readAutomaticRefreshSettings(undefined);
    expect(providerAutomaticRefreshEnabled(settings, 'roam')).toBe(true);
    expect(settings.globalPricingSources).toBe(true);
  });

  it('persists independent provider and global choices without widening malformed input', () => {
    let settings = readAutomaticRefreshSettings({
      version: 99,
      providers: { roam: false, bad: 'yes' },
      globalPricingSources: false,
    });
    expect(providerAutomaticRefreshEnabled(settings, 'roam')).toBe(false);
    expect(providerAutomaticRefreshEnabled(settings, 'bad')).toBe(true);
    settings = withProviderAutomaticRefresh(settings, 'unode', false);
    settings = withGlobalPricingSourcesAutomaticRefresh(settings, true);
    expect(settings.providers).toEqual({ roam: false, unode: false });
    expect(settings.globalPricingSources).toBe(true);
  });

  it('removes disabled provider and global sources before an automatic request can start', () => {
    const settings = readAutomaticRefreshSettings({
      providers: { roam: false, unode: true },
      globalPricingSources: false,
    });
    expect(filterAutomaticPricingSources(settings, [
      { providerId: 'roam', url: 'https://roam.invalid' },
      { providerId: 'unode', url: 'https://unode.invalid' },
      { url: 'https://global.invalid' },
    ])).toEqual([{ providerId: 'unode', url: 'https://unode.invalid' }]);
  });

  it('does not refresh on activation and runs only after the daily timer advances', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const timer = scheduleDailyAutomaticRefresh(setInterval, refresh);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    timer.dispose();
    vi.useRealTimers();
  });

  it('coalesces concurrent triggers into one request', async () => {
    let resolve!: (value: number) => void;
    const task = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const coordinator = new AutomaticRefreshCoordinator();
    const first = coordinator.run('prices:roam', task);
    const second = coordinator.run('prices:roam', task);
    expect(task).toHaveBeenCalledOnce();
    resolve(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
  });

  it('backs off after failure and retries after the window', async () => {
    let now = 1_000;
    const coordinator = new AutomaticRefreshCoordinator(() => now, 100, 1_000);
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('ok');
    await expect(coordinator.run('prices:roam', task)).rejects.toThrow('offline');
    await expect(coordinator.run('prices:roam', task)).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);
    now += 100;
    await expect(coordinator.run('prices:roam', task)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
  });
});
