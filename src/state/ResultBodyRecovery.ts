import { DelegationResultBodyStore, ResultBodyStorageError, type ResultBodyFileRef, type ResultBodyStoreOptions } from './DelegationResultBodyStore';

export const RESULT_RECOVERY_UNAVAILABLE = "Results can't be saved for crash recovery on this storage.";
export type ResultRecoveryStatus = { kind: 'disk' | 'conversation-only'; message: string };
export interface ResultBodyRecoveryPort {
  /** The existing conversation and live mailbox memory, not a new body/index store. */
  retainInConversationAndMemory(key: string, text: string): void;
  notice(message: string): void;
  statusChanged?(status: ResultRecoveryStatus): void;
}

/** Optional crash recovery, NEVER task admission. No production constructor until this slice passes audit.
 * Consumers keep dispatch/settlement in their existing kernel. A false/no receipt is not permission to refuse work. */
export class ResultBodyRecovery {
  private store?: DelegationResultBodyStore;
  private notified = false;
  private fact: ResultRecoveryStatus = { kind: 'conversation-only', message: RESULT_RECOVERY_UNAVAILABLE };
  private constructor(private readonly port: ResultBodyRecoveryPort, private readonly assertCurrent: ResultBodyStoreOptions['assertCurrent']) {}

  static async connect(options: ResultBodyStoreOptions, port: ResultBodyRecoveryPort): Promise<ResultBodyRecovery> {
    const recovery = new ResultBodyRecovery(port, options.assertCurrent);
    try {
      recovery.store = await DelegationResultBodyStore.open(options);
      if (recovery.store.readOnly) recovery.unavailable();
      else recovery.publish({ kind: 'disk', message: 'Result crash recovery storage is available.' });
    } catch { recovery.unavailable(); }
    return recovery;
  }
  get status(): ResultRecoveryStatus { return { ...this.fact }; }

  /** Preparing optional backing always resolves. Dispatch does not depend on this result. */
  async prepare(): Promise<void> {
    try { await this.store?.checkAdmission(); }
    catch (error) { this.storageFailure(error); }
  }
  async write(key: string, text: string): Promise<ResultBodyFileRef | undefined> {
    this.port.retainInConversationAndMemory(key, text);
    try { return await this.store?.write(key, text); }
    catch (error) { this.storageFailure(error, key); return undefined; }
  }
  async read(ref: ResultBodyFileRef): Promise<string | undefined> {
    try { return await this.store?.read(ref); }
    catch (error) { this.storageFailure(error); return undefined; }
  }
  private storageFailure(error: unknown, key?: string): void {
    // A stale request or one invalid/conflicting body says nothing about session-wide disk availability.
    try { this.assertCurrent(key); } catch { return; }
    if (error instanceof ResultBodyStorageError && ['storage-unavailable', 'unsafe-path', 'safe-publish-unavailable',
      'capacity', 'storage-error'].includes(error.reason)) this.unavailable();
  }
  private publish(fact: ResultRecoveryStatus): void {
    this.fact = fact;
    try { this.port.statusChanged?.(this.status); } catch { /* Observability cannot refuse work. */ }
  }
  private unavailable(): void {
    this.publish({ kind: 'conversation-only', message: RESULT_RECOVERY_UNAVAILABLE });
    if (this.notified) return;
    this.notified = true;
    try { this.port.notice(RESULT_RECOVERY_UNAVAILABLE); } catch { /* Observability cannot refuse work. */ }
  }
}
