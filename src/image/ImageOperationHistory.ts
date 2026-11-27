import type { ImageGenerationPorts, ImageGenerationReceipt } from './ImageGenerationHost';

/** Private workspace history only. Never include these records in portable evidence, prompts or diagnostic logs. */
export interface ImageOperationRecord {
  schemaVersion: 1; phase: 'started' | 'settled'; operationId: string;
  agentId: string; requestId?: string; attemptId?: string;
  endpointBase?: string;
  receipt: ImageGenerationReceipt;
  /** Original provider usage, preserved separately from the numeric public/Spend allowlist. */
  rawUsage?: unknown;
}
export interface ImageOperationHistoryPorts {
  write(key: string, record: ImageOperationRecord): PromiseLike<void>;
  failed(): void;
}

/** Reuses private workspace storage; per-operation phase keys cannot overwrite a different operation/window. */
export class ImageOperationHistory {
  private readonly pending = new Map<string, ImageOperationRecord>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  constructor(private readonly ports: ImageOperationHistoryPorts) {}

  capture(context: { agentId: string; requestId?: string; attemptId?: string }): ReturnType<NonNullable<ImageGenerationPorts['usage']>> {
    const captured = { ...context };
    const record = (phase: ImageOperationRecord['phase'], receipt: ImageGenerationReceipt, rawUsage?: unknown) => {
      if (!/^image-[a-f0-9-]{36}$/.test(receipt.operation_id)) return;
      const key = `unode.imageOperation.v1.${receipt.operation_id}.${phase}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.pending.set(key, structuredClone({ schemaVersion: 1, phase, operationId: receipt.operation_id, ...captured,
        ...(receipt.endpoint_base ? { endpointBase: receipt.endpoint_base } : {}), receipt,
        ...(rawUsage !== undefined ? { rawUsage } : {}) }));
      this.publish(key);
    };
    return { started: receipt => record('started', receipt), settled: (receipt, rawUsage) => record('settled', receipt, rawUsage) };
  }

  private publish(key: string): void {
    const record = this.pending.get(key); if (!record || this.writes.has(key)) return;
    const write = Promise.resolve().then(() => this.ports.write(key, structuredClone(record))).then(() => {
      this.pending.delete(key);
    }).catch(() => {
      // Keep the exact record for a later flush. Never log provider usage or storage exception text.
      try { this.ports.failed(); } catch { /* History visibility cannot gate image generation. */ }
    }).finally(() => { this.writes.delete(key); });
    this.writes.set(key, write);
  }

  /** Retry outstanding private records, e.g. at host shutdown. No timer, model request or task gate. */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
    for (const key of this.pending.keys()) this.publish(key);
    await Promise.all([...this.writes.values()]);
  }
  get pendingWrites(): number { return this.pending.size; }
}
