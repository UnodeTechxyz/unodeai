import type { KeyedWorkspaceMemento } from './RootScopedWorkspaceState';

export const MAX_OPERATION_HISTORY_RECORDS = 100;

/** Private, root-scoped records. Keep the latest completed operations and serialize pruning with writes. */
export class BoundedOperationHistory {
  private pending = Promise.resolve();
  private lastRecordedAt = 0;

  constructor(private readonly state: KeyedWorkspaceMemento, private readonly prefix: string) {}

  write(record: { operationId: string } & Record<string, unknown>): Promise<void> {
    const key = this.prefix + record.operationId;
    const write = this.pending.then(async () => {
      const previous = this.state.keys()
        .filter(id => id.startsWith(this.prefix) && id !== key)
        .map(id => ({ id, at: this.state.get<{ recordedAt?: number }>(id)?.recordedAt ?? 0 }))
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      for (const { id } of previous.slice(0, Math.max(0, previous.length - MAX_OPERATION_HISTORY_RECORDS + 1))) {
        await this.state.update(id, undefined);
      }
      this.lastRecordedAt = Math.max(Date.now(), this.lastRecordedAt + 1, (previous.at(-1)?.at ?? 0) + 1);
      await this.state.update(key, { ...record, recordedAt: this.lastRecordedAt });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
}
