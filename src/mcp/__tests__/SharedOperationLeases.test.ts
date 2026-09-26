import { describe, expect, it, vi } from 'vitest';
import { SharedOperationLeases } from '../SharedOperationLeases';

describe('SharedOperationLeases', () => {
  it('keeps a shared operation alive when one waiter releases but another still owns a lease', async () => {
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const start = vi.fn((actualSignal: AbortSignal) => {
      signal = actualSignal;
      return new Promise<string>((done) => { resolve = done; });
    });
    const operations = new SharedOperationLeases<string, string>();

    const first = operations.acquire('docs', start);
    const second = operations.acquire('docs', start);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    first.release();
    expect(signal.aborted).toBe(false);
    resolve('mounted');
    await expect(second.promise).resolves.toBe('mounted');
    second.release();
    expect(operations.has('docs')).toBe(false);
  });

  it('aborts an unsettled operation after its last waiter releases', async () => {
    let signal!: AbortSignal;
    const operations = new SharedOperationLeases<string, never>();
    const lease = operations.acquire('docs', async (actualSignal) => {
      signal = actualSignal;
      return await new Promise<never>(() => undefined);
    });
    await Promise.resolve();

    lease.release();
    expect(signal.aborted).toBe(true);
  });

  it('lets the owner explicitly cancel a pending operation', async () => {
    let signal!: AbortSignal;
    const operations = new SharedOperationLeases<string, never>();
    operations.acquire('docs', async (actualSignal) => {
      signal = actualSignal;
      return await new Promise<never>(() => undefined);
    });
    await Promise.resolve();

    expect(operations.cancel('docs')).toBe(true);
    expect(signal.aborted).toBe(true);
  });
});
