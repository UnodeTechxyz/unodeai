/*---------------------------------------------------------------------------------------------
 *  UnodeAi - PreChangeCheckpoints
 *  The restore point a host change takes before it replaces or removes an existing file: the file's exact bytes, kept
 *  in this workspace's RawCheckpointStore and complete on disk (payload and index) before the change acts. When they
 *  cannot be kept (the file is too large, there is no room without dropping a restore point still in use, the store
 *  cannot be used or written), the change is not made.
 *
 *  Pins. Each restore point is pinned from its capture until its change has settled. The first restore point a request
 *  keeps of a file stays pinned until that request ends, so what the file held before the request touched it cannot
 *  be dropped for room while the request still works on it. A request's end is seen at the next capture; until then
 *  its pins hold, which can only refuse a capture, never drop a restore point.
 *
 *  One store per workspace: its directory is named by the workspace's identity, and a store never removes anything
 *  outside its own directory, so room is made only from this workspace's own restore points.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';
import type { CheckpointRawRef } from './Checkpoints';
import {
  RAW_CHECKPOINT_LIMITS,
  type RawCheckpointPin,
  type RawCheckpointRefusalCode,
  type RawCheckpointStore,
  type RawFileState,
} from './RawCheckpointStore';

/** One change about to replace or remove an existing file. */
export interface PreChangeCheckpointRequest {
  agentId: string;
  /** The request the change belongs to. Its first restore point of each file stays pinned until it ends. */
  requestId?: string;
  /** As the tool reported it, for display. */
  path: string;
  /** The absolute file, as the tool resolved it. */
  target: string;
  /** Where it leads on disk: one restore point per request is pinned per physical file. */
  physical: string;
  /**
   * The bytes the change replaces: what the plan read, and what the last look before this capture still found.
   * Undefined when the file was too large to read.
   */
  bytes: Buffer | undefined;
}

/** How the change ended: what it left (read back), not made (the file proven unchanged), or not confirmed. */
export type PreChangeSettlement =
  | { kind: 'committed'; after: RawFileState }
  | { kind: 'not-committed' }
  | { kind: 'uncertain' };

export interface PreChangeCheckpoint {
  readonly id: string;
  /**
   * Settle the restore point once its change ended. A change that was made, or may have been, keeps it and returns
   * the reference its record carries; one that was not made removes it. Only the first call acts.
   */
  settle(result: PreChangeSettlement): Promise<CheckpointRawRef | undefined>;
}

export type PreChangeCheckpointOutcome =
  | { status: 'kept'; checkpoint: PreChangeCheckpoint }
  | { status: 'refused'; code: RawCheckpointRefusalCode; reason: string };

export interface PreChangeCheckpointsOptions {
  /** Open this workspace's store. Called once, at the first need. */
  open: () => Promise<RawCheckpointStore>;
  /** Whether a request still runs. When this cannot be told, the request is taken as running. */
  isRequestRunning: (requestId: string) => boolean;
  platform?: NodeJS.Platform;
}

/** This workspace's own directory for raw-byte restore points, and the identity its index records. */
export function rawCheckpointLocation(storageRoot: string, workspaceRoot: string): { directory: string; workspaceId: string } {
  const workspaceId = workspaceRootIdentity(workspaceRoot);
  return { directory: path.join(storageRoot, 'checkpoints', 'raw-v1', workspaceId), workspaceId };
}

export class PreChangeCheckpoints {
  private opened?: Promise<{ store: RawCheckpointStore } | { unavailable: string }>;
  /** Per request, the first restore point it kept of each file, by physical key. */
  private readonly requestPins = new Map<string, Map<string, RawCheckpointPin>>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: PreChangeCheckpointsOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** The workspace's store, opened (and its crash leftovers reconciled) once; or why there is none. */
  store(): Promise<{ store: RawCheckpointStore } | { unavailable: string }> {
    this.opened ??= this.options.open().then((store) => ({ store }), (error: unknown) => ({
      unavailable: `the restore-point store could not be opened (${errorText(error)}).`,
    }));
    return this.opened;
  }

  /** Keep the bytes a change is about to replace or remove. A refusal kept nothing and the change must not act. */
  async capture(request: PreChangeCheckpointRequest): Promise<PreChangeCheckpointOutcome> {
    this.releaseEndedRequests();
    if (!request.bytes) {
      return {
        status: 'refused',
        code: 'too-large',
        reason: `the file is larger than ${Math.round(RAW_CHECKPOINT_LIMITS.maxPayloadBytes / (1024 * 1024))} MiB, the most one restore point keeps.`,
      };
    }
    const opened = await this.store();
    if ('unavailable' in opened) {
      return { status: 'refused', code: 'unavailable', reason: opened.unavailable };
    }
    const { store } = opened;
    const captured = await store.capture({
      agentId: request.agentId,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      path: request.path,
      target: request.target,
      bytes: request.bytes,
    });
    if (captured.status === 'refused') {
      return { status: 'refused', code: captured.code, reason: captured.reason };
    }
    const held = this.holdForRequest(store, request, captured.entry.id);
    const writePin = captured.pin;
    let settled = false;
    return {
      status: 'kept',
      checkpoint: {
        id: captured.entry.id,
        settle: async (result) => {
          if (settled) return undefined;
          settled = true;
          if (result.kind === 'not-committed') {
            // Nothing was replaced: there is nothing to restore, and the request's first restore point is still to come.
            held?.release();
            writePin.release();
            await store.remove(captured.entry.id).catch(() => false);
            return undefined;
          }
          if (result.kind === 'uncertain') {
            writePin.release();
            return { id: captured.entry.id };
          }
          // Recorded while still pinned, so nothing drops the entry before it knows what the change left.
          await store.recordAfter(captured.entry.id, result.after);
          writePin.release();
          return { id: captured.entry.id, afterSha256: result.after.exists ? result.after.sha256 : null };
        },
      },
    };
  }

  /** Release the pins of requests that have ended. */
  releaseEndedRequests(): void {
    for (const [requestId, pins] of [...this.requestPins]) {
      let running: boolean;
      try {
        running = this.options.isRequestRunning(requestId);
      } catch {
        running = true;
      }
      if (running) continue;
      for (const pin of pins.values()) pin.release();
      this.requestPins.delete(requestId);
    }
  }

  /** Pin the request's first restore point of this file until the request ends; undefined when it is not the first. */
  private holdForRequest(store: RawCheckpointStore, request: PreChangeCheckpointRequest, id: string): { release(): void } | undefined {
    if (!request.requestId) return undefined;
    const key = this.platform === 'win32' ? request.physical.toLowerCase() : request.physical;
    const pins = this.requestPins.get(request.requestId) ?? new Map<string, RawCheckpointPin>();
    if (pins.has(key)) return undefined;
    const pin = store.pin(id);
    if (!pin) return undefined;
    pins.set(key, pin);
    this.requestPins.set(request.requestId, pins);
    return {
      release: () => {
        if (pins.get(key) !== pin) return;
        pin.release();
        pins.delete(key);
        if (pins.size === 0 && this.requestPins.get(request.requestId!) === pins) this.requestPins.delete(request.requestId!);
      },
    };
  }
}

function errorText(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}
