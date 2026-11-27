import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresentationDeck } from './PresentationContracts';

type PresentationSlide = PresentationDeck['slides'][number];

interface Draft { file: string; parts: number; slides: number }

/**
 * One agent's presentation drafts, so a model can build a long PPTX in several write_presentation calls instead
 * of one huge tool argument. Parts are canonical slides appended to a temporary file on disk, not held in memory,
 * and the final call reads them back in order. A draft is never a deliverable: nothing here writes to the workspace,
 * and the owner removes a draft once its file is written, when the agent is stopped, or when Stop ends the call.
 * Draft names are only keys; a file is named by a counter, never by model text.
 */
export class PresentationDraftStore {
  private root?: Promise<string>;
  private readonly drafts = new Map<string, Draft>();
  private serial: Promise<unknown> = Promise.resolve();
  private next = 0;

  constructor(private readonly makeRoot: () => Promise<string> = () => mkdtemp(join(tmpdir(), 'unode-presentation-draft-'))) {}

  /** Every operation runs in call order, so parts keep the order in which their calls arrived. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  has(name: string): boolean { return this.drafts.has(name); }

  /** v0.9.101 (H2b): how many parts and slides a draft holds, or undefined. Its content is not read. */
  size(name: string): { parts: number; slides: number } | undefined {
    const draft = this.drafts.get(name);
    return draft ? { parts: draft.parts, slides: draft.slides } : undefined;
  }

  /**
   * v0.9.101 (H2b): the draft under `from` is held under `to` from now on, in one synchronous step: the same file, every
   * part kept. False, and nothing moved, when there is no such draft or `to` already holds one.
   */
  rekey(from: string, to: string): boolean {
    const draft = this.drafts.get(from);
    if (!draft || this.drafts.has(to)) return false;
    this.drafts.delete(from);
    this.drafts.set(to, draft);
    return true;
  }

  append(name: string, slides: readonly PresentationSlide[]): Promise<{ parts: number; slides: number }> {
    return this.queue(async () => {
      this.root ??= this.makeRoot();
      const root = await this.root.catch(error => { this.root = undefined; throw error; });
      const draft = this.drafts.get(name) ?? { file: join(root, `draft-${++this.next}.jsonl`), parts: 0, slides: 0 };
      // One JSON line per slide. A part with no slides still counts as a part and creates the file.
      try { await appendFile(draft.file, slides.map(slide => `${JSON.stringify(slide)}\n`).join(''), 'utf8'); } catch (error) {
        // A part that may be half written cannot be trusted: the whole draft goes, never a silently shorter one.
        // The folder may be gone (a temp cleaner); the next part starts a new one rather than failing forever.
        this.drafts.delete(name); this.root = undefined; await rm(draft.file, { force: true }).catch(() => undefined); throw error;
      }
      draft.parts++; draft.slides += slides.length;
      this.drafts.set(name, draft);
      return { parts: draft.parts, slides: draft.slides };
    });
  }

  /** The draft's slides in order, or undefined when there is no such draft. Reading does not remove it. */
  read(name: string): Promise<{ parts: number; slides: PresentationSlide[] } | undefined> {
    return this.queue(async () => {
      const draft = this.drafts.get(name);
      if (!draft) return undefined;
      const text = await readFile(draft.file, 'utf8');
      const slides = text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as PresentationSlide);
      if (slides.length !== draft.slides) throw new Error('presentation draft changed on disk');
      return { parts: draft.parts, slides };
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

