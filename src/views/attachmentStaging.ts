import { constants as bufferConstants } from 'node:buffer';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostReadMemoryBudget } from '../content/ContentAssetStore';
import { attachmentSizeLabel } from '../attachments';

/**
 * v0.9.99: the chat composer hands each file it attaches to the host in pieces, as soon as the person adds it. The
 * host writes the pieces to a temporary file of its own and acknowledges each one, so the view never holds or posts a
 * whole file at once and sends the next pieces only as the host keeps up. The send names the file by its upload id;
 * the host reads its own copy then. Nothing here limits a file's size: the one limit is the real resource, the memory
 * this VS Code window can give one file once the message is sent (hostReadMemoryBudget), and the disk.
 */

/** The bytes one piece carries from the composer. */
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
/** The most bytes one piece may carry; a message that claims more is not a piece the composer sends. */
export const ATTACHMENT_CHUNK_MAX_BYTES = 4 * ATTACHMENT_CHUNK_BYTES;
/** Pieces the composer sends before it waits for the host's acknowledgement of the oldest one. */
export const ATTACHMENT_CHUNKS_IN_FLIGHT = 4;

export type StagedChunkResult = { ok: true; received: number } | { ok: false; reason: string };
export type StagedTakeResult = { ok: true; bytes: Buffer } | { ok: false; reason: string };

interface StagedUpload {
  path: string;
  total: number;
  received: number;
  nextIndex: number;
}

export interface AttachmentStagingOptions {
  /** The bytes one file may take in this window's memory; the extension host's own budget when absent. */
  memoryBudget?: () => number;
  /** Where the temporary folder is made; the system's temporary folder when absent. */
  tempRoot?: () => string;
}

export class AttachmentStaging {
  private root: string | undefined;
  private readonly uploads = new Map<string, StagedUpload>();
  private sequence = 0;

  constructor(private readonly options: AttachmentStagingOptions = {}) {}

  /** The memory one file may take once it is sent, as the person reads it in a notice. */
  memoryBudget(): number {
    return (this.options.memoryBudget ?? defaultAttachmentMemoryBudget)();
  }

  /**
   * Take piece `index` of upload `uploadId` from chat view `scope`. Piece 0 starts the upload and says its total size;
   * every later piece must come next in order. A failed piece ends the upload and says why, for that file only.
   */
  append(scope: string, uploadId: string, index: number, total: number, data: Buffer): StagedChunkResult {
    const key = uploadKey(scope, uploadId);
    if (index === 0) {
      this.discard(scope, uploadId);
      const budget = this.memoryBudget();
      if (total > budget) {
        return { ok: false, reason: memoryReason(total, budget) };
      }
      let path: string;
      try {
        path = join(this.ensureRoot(), `upload-${++this.sequence}`);
        writeFileSync(path, new Uint8Array(0));
      } catch (error) {
        return { ok: false, reason: diskReason(error) };
      }
      this.uploads.set(key, { path, total, received: 0, nextIndex: 0 });
    }
    const upload = this.uploads.get(key);
    if (!upload) {
      return { ok: false, reason: 'UnodeAi did not receive the start of the file' };
    }
    if (index !== upload.nextIndex || total !== upload.total || upload.received + data.byteLength > upload.total) {
      this.discard(scope, uploadId);
      return { ok: false, reason: 'its pieces did not arrive as the chat sent them' };
    }
    try {
      appendFileSync(upload.path, data);
    } catch (error) {
      this.discard(scope, uploadId);
      return { ok: false, reason: diskReason(error) };
    }
    upload.received += data.byteLength;
    upload.nextIndex += 1;
    return { ok: true, received: upload.received };
  }

  /** The size of a complete upload, before it is read; undefined while pieces are missing or after it was taken. */
  completeSize(scope: string, uploadId: string): number | undefined {
    const upload = this.uploads.get(uploadKey(scope, uploadId));
    return upload && upload.received === upload.total ? upload.total : undefined;
  }

  /**
   * Read a complete upload into memory for the message that names it, and let go of its temporary file. A file the
   * host never received, or did not receive whole, is reported for that file alone.
   */
  take(scope: string, uploadId: string): StagedTakeResult {
    const key = uploadKey(scope, uploadId);
    const upload = this.uploads.get(key);
    if (!upload) {
      return { ok: false, reason: 'UnodeAi no longer has the copy this chat received. Attach it again' };
    }
    if (upload.received !== upload.total) {
      return { ok: false, reason: 'UnodeAi had not received all of it. Attach it again' };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(upload.path);
    } catch (error) {
      this.discard(scope, uploadId);
      return { ok: false, reason: isMemoryError(error) ? memoryReason(upload.total, this.memoryBudget()) : 'UnodeAi could not read its temporary copy. Attach it again' };
    }
    this.discard(scope, uploadId);
    if (bytes.byteLength !== upload.total) {
      return { ok: false, reason: 'its temporary copy changed after it was attached. Attach it again' };
    }
    return { ok: true, bytes };
  }

  /** Let go of one upload: the person removed the file, or the message that named it no longer needs it. */
  discard(scope: string, uploadId: string): void {
    const key = uploadKey(scope, uploadId);
    const upload = this.uploads.get(key);
    if (!upload) return;
    this.uploads.delete(key);
    removeQuietly(upload.path);
  }

  /** Let go of every upload of one chat view, which closed. */
  discardScope(scope: string): void {
    for (const key of [...this.uploads.keys()]) {
      if (key.startsWith(`${scope}\n`)) this.discard(scope, key.slice(scope.length + 1));
    }
  }

  /** How many uploads are held, for tests and diagnostics. */
  heldCount(): number {
    return this.uploads.size;
  }

  dispose(): void {
    this.uploads.clear();
    if (this.root) {
      try { rmSync(this.root, { recursive: true, force: true }); } catch { /* the system's temporary folder reclaims it */ }
      this.root = undefined;
    }
  }

  private ensureRoot(): string {
    if (!this.root) {
      this.root = mkdtempSync(join((this.options.tempRoot ?? tmpdir)(), 'unode-attach-'));
    }
    return this.root;
  }
}

/**
 * v0.9.99: the most one sent file may take: the host's budget for one file in memory, and no more than the longest
 * base64 text this process can make, since a sent attachment is carried as one.
 */
export function defaultAttachmentMemoryBudget(): number {
  return Math.min(hostReadMemoryBudget(), Math.floor(bufferConstants.MAX_STRING_LENGTH / 4) * 3);
}

function uploadKey(scope: string, uploadId: string): string {
  return `${scope}\n${uploadId}`;
}

function removeQuietly(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* reclaimed with the folder */ }
}

/** v0.9.99: the person's words for a file larger than this window can hold in memory once it is sent. */
export function memoryReason(total: number, budget: number): string {
  return `at ${attachmentSizeLabel(total)} it is more than this VS Code window can hold in memory for one file `
    + `(about ${attachmentSizeLabel(budget)}). Save it in the workspace folder and ask the agent to work on it there`;
}

/**
 * v0.9.99: the warning for the files of one message that together exceed what this window can safely hold at once.
 * It never stops a send; it says what may happen and what the person can do. `lead` names the files: "These files"
 * in the composer, "The files of this message" in the transcript. The composer builds the same sentence itself.
 */
export function combinedSizeWarning(lead: string, total: number, budget: number): string {
  return `${lead} are ${attachmentSizeLabel(total)} together, more than this VS Code window can safely hold at once `
    + `(about ${attachmentSizeLabel(budget)}). Sending them in one message may make UnodeAi run out of memory. To be safe, `
    + 'send them in separate messages, or save them in the workspace folder and ask the agent to work on them there.';
}

function diskReason(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
    ? 'there is no room left on the disk for UnodeAi\'s temporary copy. Free some space and attach it again'
    : 'UnodeAi could not write a temporary copy of it. Attach it again';
}

/** A buffer or string this process cannot make: the file is beyond what memory holds as one value. */
export function isMemoryError(error: unknown): boolean {
  return error instanceof RangeError || (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_FS_FILE_TOO_LARGE'
    || /Cannot create a string longer|Array buffer allocation failed|Invalid string length/i.test(String((error as Error | undefined)?.message ?? ''));
}
