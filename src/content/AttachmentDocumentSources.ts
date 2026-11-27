import { randomUUID } from 'node:crypto';
import { hostReadMemoryBudget, type ContentAssetStore } from './ContentAssetStore';

interface Source { key: string; ref: string; bytes: number; sha256: string }
/** Private attachment custody. Keys never name filesystem paths and never grant content access. */
export class AttachmentDocumentSources {
  private sources = new Map<string, Source>();
  constructor(private readonly store: ContentAssetStore, private readonly canRead: (ref: string) => boolean) {}

  has(key: string): boolean { return this.sources.has(key); }

  /** Share source identity across host views; their live access predicates remain separate. */
  shareCustodyWith(owner: AttachmentDocumentSources): void { if (owner.store === this.store) this.sources = owner.sources; }

  private live(source: Source): boolean {
    if (!this.canRead(source.ref) || !this.store.isHeld(source.ref)) return false;
    const identity = this.store.userAttachmentIdentity(source.ref);
    return !!identity && identity.bytes === source.bytes && identity.sha256 === source.sha256;
  }

  lease(key: string, current: () => boolean): () => boolean {
    const source = this.sources.get(key);
    const live = () => !!source && current() && this.live(source);
    if (!live()) throw new Error('source-unavailable'); return live;
  }

  /** Extend an already admitted input's custody into an owned background operation, not into another task. */
  operationLease(key: string, current: (ref: string) => boolean) {
    const source = this.sources.get(key);
    if (!source || !this.live(source) || !current(source.ref)) throw Error('source-unavailable');
    const live = () => {
      const identity = this.store.userAttachmentIdentity(source.ref);
      return current(source.ref) && this.store.isHeld(source.ref) && !!identity && identity.bytes === source.bytes && identity.sha256 === source.sha256;
    };
    return { ref: source.ref, current: live, checkVersion: async () => {
      if (!live()) throw Error('source-unavailable');
      const original = await this.store.readUserAttachment(source.ref);
      if (!live() || original.status !== 'ready' || original.sha256 !== source.sha256 || original.bytes.length !== source.bytes) throw Error('source-changed');
    } };
  }

  /** `kinds`: the attachment media kinds this reader accepts; edit_pdf reads stored PDF attachments. */
  async read(ref: string, current: () => boolean, signal?: AbortSignal, kinds: readonly string[] = ['binary', 'text']) {
    const permitted = () => !signal?.aborted && current() && this.canRead(ref) && this.store.isHeld(ref);
    if (!/^content-[1-9]\d*$/.test(ref) || !permitted()) throw new Error('source-unavailable');
    const receipt = this.store.getReceipt(ref); const identity = this.store.userAttachmentIdentity(ref);
    if (!receipt || !identity || !kinds.includes(receipt.mediaKind)) throw new Error('source-unavailable');
    if (identity.bytes > hostReadMemoryBudget()) throw new Error('source-memory');
    const original = await this.store.readUserAttachment(ref);
    if (!permitted()) throw new Error('source-unavailable');
    if (original.status !== 'ready' || original.sha256 !== identity.sha256 || original.bytes.length !== identity.bytes) throw new Error('source-unreadable');
    let source = [...this.sources.values()].find(source => source.ref === ref && this.live(source));
    if (!source) {
      source = { key: `attachment-source-${randomUUID()}`, ref, ...identity };
      this.sources.set(source.key, source);
    }
    return { key: source.key, bytes: original.bytes, current: this.lease(source.key, permitted) };
  }

  async checkVersion(key: string, bytes: number, sha256: string, current: () => boolean): Promise<void> {
    const live = this.lease(key, current); const source = this.sources.get(key)!;
    if (source.bytes !== bytes || source.sha256 !== sha256) throw new Error('source-changed');
    const original = await this.store.readUserAttachment(source.ref);
    if (!live()) throw new Error('source-unavailable');
    if (original.status !== 'ready' || original.sha256 !== sha256 || original.bytes.length !== bytes) throw new Error('source-unreadable');
  }
}
