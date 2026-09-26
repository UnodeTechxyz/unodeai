export interface SharedOperationLease<T> {
  readonly promise: Promise<T>;
  release(): void;
}

interface SharedOperation<T> {
  readonly controller: AbortController;
  readonly leases: Set<symbol>;
  promise: Promise<T>;
  settled: boolean;
}

/**
 * Coalesces an operation by key without giving any one waiter ownership of it.
 * The operation is cancelled only when every independent waiter has released
 * its lease (or when the owner explicitly cancels the key).
 */
export class SharedOperationLeases<K, T> {
  private readonly operations = new Map<K, SharedOperation<T>>();

  has(key: K): boolean {
    return this.operations.has(key);
  }

  acquire(key: K, start: (signal: AbortSignal) => Promise<T>): SharedOperationLease<T> {
    let operation = this.operations.get(key);
    if (!operation) {
      const controller = new AbortController();
      operation = {
        controller,
        leases: new Set(),
        promise: Promise.resolve(undefined as T),
        settled: false,
      };
      const owned = operation;
      owned.promise = Promise.resolve().then(() => start(controller.signal)).finally(() => {
        owned.settled = true;
        if (this.operations.get(key) === owned) this.operations.delete(key);
      });
      this.operations.set(key, owned);
    }

    const token = Symbol('shared-operation-lease');
    operation.leases.add(token);
    let released = false;
    return {
      promise: operation.promise,
      release: () => {
        if (released) return;
        released = true;
        operation!.leases.delete(token);
        if (!operation!.settled && operation!.leases.size === 0) operation!.controller.abort();
      },
    };
  }

  cancel(key: K): boolean {
    const operation = this.operations.get(key);
    if (!operation || operation.settled) return false;
    operation.controller.abort();
    return true;
  }
}
