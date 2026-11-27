/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one writer per physical file across this host's windows (v0.9.110 R1, design §3.4 "普通写入竞争")
 *
 *  Each host-made change of a workspace file holds the file's writer lease for the change itself: never across a
 *  model call, an approval or a person's answer. The leases live in this extension host's global storage, keyed by the
 *  remote authority and the physical target, not by the workspace's root set: windows with folder A and with A+B both
 *  change files in A, and take turns on the same lease.
 *
 *  An ordinary write that finds another window holding the file waits at most five seconds (asking whether the holder
 *  is gone at most every two), then gets a retryable "busy" answer: nothing is written, nothing else is stopped, and
 *  no one is asked anything. A holder proven gone is taken over at once; a live or unknown one never is.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { GenerationLease, type GenerationLeaseDeps, type HeldLease } from './GenerationLease';

/** The longest an ordinary write waits for another window's change of the same file. Not a task or model timeout. */
export const FILE_WRITER_WAIT_MS = 5_000;

export type FileWriterLeaseAttempt =
  | { status: 'held'; release(): Promise<void> }
  | { status: 'busy'; holder: 'alive' | 'unknown' }
  | { status: 'aborted' };

/** A change was not made because another writer holds the file. The model rereads, merges and retries. */
export class FileTargetBusyError extends Error {
  constructor(readonly holder: 'alive' | 'unknown') {
    super(holder === 'alive'
      ? 'another UnodeAi window is writing this file. Nothing was written. When it has finished, read the file again, merge your change and retry.'
      : 'UnodeAi cannot yet confirm that another writer of this file has finished. Nothing was written. Read the file again, merge your change and retry.');
  }
}

export class FileWriterLeases {
  private readonly held = new Map<string, { lease: HeldLease; count: number }>();

  constructor(private readonly root: string, private readonly deps: GenerationLeaseDeps & {
    remoteAuthority?: string;
    platform?: NodeJS.Platform;
  }) {}

  /** The lease folder of one physical target: the remote authority, then a digest of the path as the platform compares it. */
  private folder(physical: string): string {
    const platform = this.deps.platform ?? process.platform;
    const compared = platform === 'win32' ? path.win32.resolve(physical).toLowerCase() : path.resolve(physical);
    const authority = (typeof this.deps.remoteAuthority === 'string' ? this.deps.remoteAuthority : 'local').toLowerCase().replace(/[^a-z0-9.+-]/g, '_').slice(0, 80) || 'local';
    return path.join(this.root, authority, createHash('sha256').update(compared).digest('hex'));
  }

  /**
   * Hold the target's writer lease for one change, waiting at most `waitMs`. A second change of the same target in
   * this window shares the hold (one change at a time inside a window is the caller's own serialization).
   */
  async acquire(physical: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<FileWriterLeaseAttempt> {
    const folder = this.folder(physical);
    const shared = this.held.get(folder);
    if (shared) {
      shared.count++;
      return { status: 'held', release: () => this.releaseShared(folder) };
    }
    const lease = new GenerationLease(folder, this.deps);
    // No wait (a restore): one attempt, which still asks once whether the holder is gone; it never waits for the holder.
    if (options.waitMs === 0 && options.signal?.aborted) return { status: 'aborted' };
    const attempt = options.waitMs === 0
      ? await lease.tryAcquire('file-write')
      : await lease.acquire('file-write', { waitMs: options.waitMs ?? FILE_WRITER_WAIT_MS, signal: options.signal });
    if (attempt.status !== 'held') return attempt;
    this.held.set(folder, { lease: attempt.lease, count: 1 });
    return { status: 'held', release: () => this.releaseShared(folder) };
  }

  private async releaseShared(folder: string): Promise<void> {
    const shared = this.held.get(folder);
    if (!shared) return;
    shared.count--;
    if (shared.count > 0) return;
    this.held.delete(folder);
    await shared.lease.release();
  }
}
