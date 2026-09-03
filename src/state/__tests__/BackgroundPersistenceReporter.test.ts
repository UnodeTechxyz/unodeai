import { describe, expect, it, vi } from 'vitest';
import { BackgroundPersistenceReporter, runBackgroundPersistence } from '../BackgroundPersistenceReporter';

describe('BackgroundPersistenceReporter', () => {
  it('surfaces and logs one rejected background save without throwing to its caller', async () => {
    const logError = vi.fn();
    const showError = vi.fn();
    const reporter = new BackgroundPersistenceReporter({ logError, showError });

    expect(() => runBackgroundPersistence(
      async () => { throw new Error('workspace state is unavailable'); },
      reporter,
      'save the agent roster',
    )).not.toThrow();

    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    expect(logError).toHaveBeenCalledWith('UnodeAi could not save the agent roster: workspace state is unavailable');
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain('Changes may be lost after reload');
  });

  it('deduplicates repeated background failures until a save succeeds', async () => {
    const logError = vi.fn();
    const showError = vi.fn();
    const reporter = new BackgroundPersistenceReporter({ logError, showError });
    const rejected = async () => { throw new Error('disk is read-only'); };

    runBackgroundPersistence(rejected, reporter, 'save the agent roster');
    runBackgroundPersistence(rejected, reporter, 'save the agent roster');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    expect(showError).toHaveBeenCalledTimes(1);

    runBackgroundPersistence(async () => {}, reporter, 'save the agent roster');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    runBackgroundPersistence(rejected, reporter, 'save the agent roster');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(2));
  });
});
