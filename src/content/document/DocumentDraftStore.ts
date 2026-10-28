import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentBlock } from './DocumentContracts';

interface Draft { file: string; parts: number; blocks: number }

/**
 * v0.9.99: one agent's document drafts, so a model can build a long Word/PDF in several write_document calls instead
 * of one huge tool argument. Parts are canonical blocks appended to a temporary file on disk, not held in memory,
 * and the final call reads them back in order. A draft is never a deliverable: nothing here writes to the workspace,
 * and the owner removes a draft once its file is written, when the agent is stopped, or when Stop ends the call.
 * Draft names are only keys; a file is named by a counter, never by model text.
 */
export class DocumentDraftStore {
  private root?: Promise<string>;
  private readonly drafts = new Map<string, Draft>();
  private serial: Promise<unknown> = Promise.resolve();
  private next = 0;

  constructor(private readonly makeRoot: () => Promise<string> = () => mkdtemp(join(tmpdir(), 'unode-document-draft-'))) {}

  /** Every operation runs in call order, so parts keep the order in which their calls arrived. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  has(name: string): boolean { return this.drafts.has(name); }

  append(name: string, blocks: readonly DocumentBlock[]): Promise<{ parts: number; blocks: number }> {
    return this.queue(async () => {
      this.root ??= this.makeRoot();
      const root = await this.root.catch(error => { this.root = undefined; throw error; });
      const draft = this.drafts.get(name) ?? { file: join(root, `draft-${++this.next}.jsonl`), parts: 0, blocks: 0 };
      // One JSON line per block. A part with no blocks still counts as a part and creates the file.
      try { await appendFile(draft.file, blocks.map(block => `${JSON.stringify(block)}\n`).join(''), 'utf8'); } catch (error) {
        // A part that may be half written cannot be trusted: the whole draft goes, never a silently shorter one.
        // The folder may be gone (a temp cleaner); the next part starts a new one rather than failing forever.
        this.drafts.delete(name); this.root = undefined; await rm(draft.file, { force: true }).catch(() => undefined); throw error;
      }
      draft.parts++; draft.blocks += blocks.length;
      this.drafts.set(name, draft);
      return { parts: draft.parts, blocks: draft.blocks };
    });
  }

  /** The draft's blocks in order, or undefined when there is no such draft. Reading does not remove it. */
  read(name: string): Promise<{ parts: number; blocks: DocumentBlock[] } | undefined> {
    return this.queue(async () => {
      const draft = this.drafts.get(name);
      if (!draft) return undefined;
      const text = await readFile(draft.file, 'utf8');
      const blocks = text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as DocumentBlock);
      if (blocks.length !== draft.blocks) throw new Error('document draft changed on disk');
      return { parts: draft.parts, blocks };
    });
  }

  discard(name: string): Promise<void> {
    return this.queue(async () => {
      const draft = this.drafts.get(name);
      if (!draft) return;
      this.drafts.delete(name);
      await rm(draft.file, { force: true }).catch(() => undefined);
    });
  }

  /** The agent stopped: every draft and its folder go. A later part starts a new folder. */
  discardAll(): Promise<void> {
    return this.queue(async () => {
      const root = this.root;
      this.root = undefined;
      this.drafts.clear();
      const folder = await root?.catch(() => undefined);
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    });
  }
}
