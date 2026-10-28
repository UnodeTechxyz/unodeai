import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentFailure } from './DocumentContracts';
import { FONT_RESOURCE_LIMITS as LIMIT } from './FontEmbeddingPolicy';

export interface FontBrokerJob {
  jobId: string; signal: AbortSignal; isCurrent(): boolean;
  /** Exact host-selected candidates only (system aliases or explicit User settings), never model paths. */
  candidates: readonly string[];
  /** Workspace/worktree and every agent-writable root, captured by the host. */
  forbiddenRoots: readonly string[];
}
const canonical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (root: string, file: string) => { const rel = path.relative(canonical(root), canonical(file)); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

/** One job's one-shot font resource capabilities. No global cache, directory scan, subprocess or HTTP. */
export class FontResourceBroker {
  private readonly tokens = new Map<string, { file: string; used: boolean }>();
  private readonly retained = new Map<string, number>();
  private reads = 0;
  private readBytes = 0;
  private pending: Promise<unknown> | undefined;
  private closed = false;
  private closeUnconfirmed = false;
  constructor(private readonly job: FontBrokerJob) {
    this.job = { ...job, candidates: [...job.candidates], forbiddenRoots: [...job.forbiddenRoots] };
  }

  private assertCurrent(): void {
    if (this.closed || this.job.signal.aborted || !this.job.isCurrent()) throw new DocumentFailure('cancelled');
  }
  private assertPath(file: string): void {
    if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /:\/\//.test(file) || !/\.(?:ttf|otf|ttc|otc)$/i.test(file)
      || this.job.forbiddenRoots.some(root => inside(root, file))) throw new DocumentFailure('font-resource-invalid');
  }
  issueCandidate(file: string): string {
    this.assertCurrent(); this.assertPath(file);
    if (!this.job.candidates.some(candidate => canonical(candidate) === canonical(file))) throw new DocumentFailure('font-resource-invalid');
    if (this.tokens.size >= LIMIT.readCount) throw new DocumentFailure('font-budget');
    const token = randomUUID(); this.tokens.set(token, { file: path.resolve(file), used: false }); return token;
  }
  async read(jobId: string, token: string): Promise<{ bytes: ArrayBuffer; sha256: string }> {
    this.assertCurrent();
    const candidate = this.tokens.get(token);
    if (jobId !== this.job.jobId || !candidate || candidate.used || this.pending) throw new DocumentFailure('font-resource-invalid');
    candidate.used = true;
    const operation = this.readCandidate(candidate.file);
    this.pending = operation;
    try { return await operation; } finally { this.pending = undefined; }
  }
  private async readCandidate(file: string) {
    if (++this.reads > LIMIT.readCount) throw new DocumentFailure('font-budget');
    this.assertPath(file); this.assertCurrent();
    let handle: fs.FileHandle | undefined;
    try {
      const logical = await fs.lstat(file); this.assertCurrent();
      if (!logical.isFile() || logical.isSymbolicLink()) throw new DocumentFailure('font-resource-invalid');
      const real = await fs.realpath(file); this.assertCurrent(); this.assertPath(real);
      if (canonical(real) !== canonical(file)) throw new DocumentFailure('font-resource-invalid');
      handle = await fs.open(real, 'r'); this.assertCurrent();
      const before = await handle.stat(); this.assertCurrent();
      if (!before.isFile() || before.dev !== logical.dev || before.ino !== logical.ino || before.size !== logical.size) throw new DocumentFailure('font-resource-changed');
      if (before.size < 12 || before.size > LIMIT.sourceBytes || this.readBytes + before.size > LIMIT.readBytes
        || this.retained.size >= LIMIT.retainedFiles || [...this.retained.values()].reduce((a, b) => a + b, 0) + before.size > LIMIT.retainedBytes) throw new DocumentFailure('font-budget');
      // An exact standalone buffer; never a pooled Buffer.buffer with unrelated trailing memory.
      const bytes = new Uint8Array(before.size);
      for (let offset = 0; offset < bytes.length;) {
        this.assertCurrent();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        this.readBytes += bytesRead; this.assertCurrent();
        if (!bytesRead) throw new DocumentFailure('font-resource-changed');
        offset += bytesRead;
      }
      const after = await handle.stat(); this.assertCurrent();
      const current = await fs.lstat(file); this.assertCurrent();
      const realAfter = await fs.realpath(file); this.assertCurrent();
      if (!current.isFile() || current.isSymbolicLink() || canonical(realAfter) !== canonical(real)
        || [after, current].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
          || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) throw new DocumentFailure('font-resource-changed');
      const magic = Buffer.from(bytes.buffer, 0, 4);
      if (!['OTTO', 'ttcf', 'true'].includes(magic.toString('ascii')) && magic.readUInt32BE(0) !== 0x00010000) throw new DocumentFailure('font-resource-invalid');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      this.retained.set(sha256, bytes.byteLength);
      return { bytes: bytes.buffer, sha256 };
    } catch (error) { throw error instanceof DocumentFailure ? error : new DocumentFailure('font-resource-invalid'); }
    finally {
      if (handle) try { await handle.close(); } catch {
        this.closeUnconfirmed = true;
        throw new DocumentFailure('render-stop-unconfirmed');
      }
    }
  }
  /** Worker confirms it no longer needs that source before the next candidate is requested. */
  release(sha256: string): void { this.retained.delete(sha256); }
  /** The renderer must await this together with worker exit before releasing its queue slot. */
  async close(): Promise<void> {
    this.closed = true;
    try { await this.pending; } catch { /* caller already owns the read result */ }
    if (this.closeUnconfirmed) throw new DocumentFailure('render-stop-unconfirmed');
    this.retained.clear(); this.tokens.clear();
  }
}
