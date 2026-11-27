/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the host side of Revert / Undo revert / Redo revert (v0.9.110 R2, design §4.2–4.3)
 *
 *  Every target goes through the restore checks a single-file restore uses (CheckpointRestore.ts): Workspace Trust,
 *  the folders the host may write now, unsaved editor changes, the physical target, and the file still holding exactly
 *  what the history last recorded. "Restore anyway" is never offered here. The file's writer lease is taken without
 *  waiting: another window writing it makes this target a conflict, and the rest go on. When the existing security-
 *  control policy wants the person's decision, the lease is given back while they decide, and every check runs again
 *  after it under a new lease.
 *
 *  What a target holds before it is replaced is kept first as an exact restore point, pinned under the operation, so
 *  Undo revert can put it back; the states a revert restores are pinned the same way for Redo revert.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import {
  commitCheckpointRestore,
  prepareCheckpointRestore,
  type CheckpointRestoreAuthority,
  type PreparedCheckpointRestore,
} from './CheckpointRestore';
import type { RawCheckpointStore } from './RawCheckpointStore';
import type { FileWriterLeases } from '../history/FileWriterLeases';
import type { HistoryFileState } from '../history/HistoryRecords';
import type { PreparedRestore, RestoreContent, TaskRecoveryPorts, TaskRecoveryStore } from '../history/TaskRecovery';

export interface TaskRecoveryHostDeps {
  store: TaskRecoveryStore;
  raw: () => Promise<RawCheckpointStore | undefined>;
  leases?: FileWriterLeases;
  authority: CheckpointRestoreAuthority;
  /**
   * The existing security-control decision for one restore, asked of the person; true only when they allowed it.
   * Without it, a restore that needs that decision is a conflict.
   */
  decideSecurityControl?: (preview: NonNullable<PreparedCheckpointRestore['securityControlPreview']>) => Promise<boolean>;
  isRequestRunning(rootRequestId: string): boolean;
  newId(): string;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function taskRecoveryPorts(deps: TaskRecoveryHostDeps): TaskRecoveryPorts {
  const pinOwner = (operationId: string) => `history:${operationId}`;

  async function hold(physical: string): Promise<{ release(): Promise<void> } | { conflict: string }> {
    if (!deps.leases) return { release: async () => undefined };
    const lease = await deps.leases.acquire(physical, { waitMs: 0 });
    if (lease.status === 'held') return lease;
    return { conflict: lease.status === 'busy' && lease.holder === 'alive'
      ? 'another UnodeAi window is writing this file now.'
      : 'UnodeAi cannot confirm that another writer of this file has finished.' };
  }

  return {
    store: deps.store,
    isRequestRunning: (id) => deps.isRequestRunning(id),
    newId: () => deps.newId(),

    async observe(physicalTarget) {
      try {
        const bytes = await fs.readFile(physicalTarget);
        return { kind: 'file', sha256: sha256(bytes), size: bytes.length };
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'absent' } : undefined;
      }
    },

    async readPayload(payloadRef) {
      const raw = await deps.raw();
      const read = await raw?.readBefore(payloadRef);
      return read?.status === 'read' ? read.bytes : undefined;
    },

    async pinPayloads(operationId, refs) {
      const raw = await deps.raw();
      if (!raw) return false;
      for (const ref of new Set(refs)) {
        if (!await raw.pinNamed(ref, pinOwner(operationId))) return false;
      }
      return true;
    },

    async keepCurrent({ operationId, physicalTarget, displayPath, expected }) {
      if (expected.kind === 'absent') return { state: { kind: 'absent' } };
      const raw = await deps.raw();
      if (!raw) return { refused: 'there is no restore-point store in this window' };
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(physicalTarget);
      } catch {
        return { refused: 'it could not be read' };
      }
      if (sha256(bytes) !== expected.sha256) return { refused: 'it changed while it was read' };
      const captured = await raw.capture({ agentId: 'user', path: displayPath, target: physicalTarget, bytes });
      if (captured.status !== 'captured') return { refused: captured.reason };
      const pinned = await raw.pinNamed(captured.entry.id, pinOwner(operationId));
      captured.pin.release();
      if (!pinned) return { refused: 'its restore point could not be kept for Undo' };
      return { state: { kind: 'file', sha256: expected.sha256, size: bytes.length, payloadRef: captured.entry.id } };
    },

    async prepare({ physicalTarget, content, expected }) {
      const request = {
        target: physicalTarget, physicalTarget, content,
        expected: expected.kind === 'absent' ? { kind: 'absent' as const } : { kind: 'bytes' as const, sha256: expected.sha256 },
      };
      const attempt = async (decided?: string): Promise<{ status: 'ready'; restore: PreparedRestore } | { status: 'conflict'; reason: string }
        | { status: 'decide'; preview: NonNullable<PreparedCheckpointRestore['securityControlPreview']>; signature: string }> => {
        const lease = await hold(physicalTarget);
        if ('conflict' in lease) return { status: 'conflict', reason: lease.conflict };
        const prepared = await prepareCheckpointRestore(request, deps.authority);
        if (prepared.status === 'refused') {
          await lease.release();
          return { status: 'conflict', reason: prepared.reason };
        }
        const preview = prepared.prepared.securityControlPreview;
        if (preview) {
          const signature = `${prepared.prepared.securityControlSignature}\0${prepared.prepared.proposedContent}`;
          if (decided !== signature) {
            // The lease is never held while the person decides.
            await lease.release();
            return decided === undefined
              ? { status: 'decide', preview, signature }
              : { status: 'conflict', reason: 'the security-control file changed while you decided; it was left as it is.' };
          }
        }
        return { status: 'ready', restore: preparedRestore(prepared.prepared, content, deps.authority, lease, !!preview) };
      };
      const first = await attempt();
      if (first.status !== 'decide') return first;
      if (!deps.decideSecurityControl) return { status: 'conflict', reason: 'it is a security-control file; restore it on its own so you can decide.' };
      const allowed = await deps.decideSecurityControl(first.preview).catch(() => false);
      if (!allowed) return { status: 'conflict', reason: 'you did not allow this security-control change; it was left as it is.' };
      // Every check again, under a new lease, held to what the person allowed.
      const second = await attempt(first.signature);
      return second.status === 'decide' ? { status: 'conflict', reason: 'it needs a decision.' } : second;
    },
  };
}

/** A prepared restore, held under the file's writer lease until it is committed or given back. */
function preparedRestore(prepared: PreparedCheckpointRestore, content: RestoreContent, authority: CheckpointRestoreAuthority,
  lease: { release(): Promise<void> }, decided: boolean): PreparedRestore {
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await lease.release();
  };
  return {
    release,
    async commit() {
      if (prepared.securityControlPreview && !decided) {
        return { status: 'refused', reason: 'it is a security-control file and no decision was made for it.' };
      }
      const outcome = await commitCheckpointRestore(prepared, authority);
      if (outcome.status === 'restored') {
        const observed: HistoryFileState = outcome.sha256 === null
          ? { kind: 'absent' }
          : { kind: 'file', sha256: outcome.sha256, size: content.kind === 'bytes' ? content.bytes.length : 0 };
        return { status: 'restored', observed };
      }
      return outcome.status === 'refused' ? { status: 'refused', reason: outcome.reason } : { status: 'effect-uncertain', reason: outcome.reason };
    },
  };
}
