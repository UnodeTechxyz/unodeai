import type { CheckpointRecorder } from '../backend/WorkspaceTools';
import type { RunLedger } from './RunLedger';

/** Preserve host readback evidence; a binary checkpoint's display text is not its file content. */
export function recordCheckpointFileChange(
  ledger: Pick<RunLedger, 'recordFileChange'>,
  entry: Parameters<CheckpointRecorder>[0],
  correlationId: string | undefined,
): void {
  ledger.recordFileChange({
    agentId: entry.agentId, path: entry.path, before: entry.before, after: entry.after,
    ...(entry.afterSha256 !== undefined ? { afterSha256: entry.afterSha256 } : {}),
    ...(entry.beforeSha256 !== undefined ? { beforeSha256: entry.beforeSha256 } : {}),
    ...(entry.operation ? { operation: entry.operation } : {}),
    contentObserved: entry.afterContentObserved !== false && (!entry.restoreDisabledReason
      || (entry.restoreDisabledReason === 'not-utf8-text' && isHash(entry.afterSha256)
        && (entry.beforeSha256 === null || isHash(entry.beforeSha256)))),
    correlationId,
  });
}

function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
