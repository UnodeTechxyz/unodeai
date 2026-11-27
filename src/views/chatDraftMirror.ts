/*---------------------------------------------------------------------------------------------
 * v0.9.96: a second local copy of the Workbench composer's unsent text, so the composer can be rebuilt when
 * VS Code keeps an editor tab whose extension host is gone (Restart Extension Host never hands that tab to the
 * new host). The page's own webview state stays the first copy.
 *
 * Only text, the agent it belongs to and host-issued ordering are kept: no attachment, file name, permission,
 * tool argument or credential. Restoring text never sends it; a new explicit Send does. The copy lives in this
 * workspace's activation-bound state on this machine, never in global or synced state, and is ordinary local
 * data, not secret storage.
 *
 * Every agent in the roster has an incarnation: a host sequence given to it the first time the copy sees it.
 * Removing the agent forgets the incarnation, so an agent created later with the same id gets a new one, and a
 * draft made for the earlier agent, wherever it was saved, never matches it again. Only agents in the roster
 * have one, which is what bounds this state: nothing is kept for a removed agent.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { WorkspaceMemento } from '../settings/ProjectCommandApprovals';

export const CHAT_DRAFT_MIRROR_KEY = 'unode.chatDraftMirror.v1';

export const CHAT_DRAFT_LIMITS = {
  /** The page keeps at most this many nonempty agent drafts; so does the copy. */
  drafts: 20,
  /** The send protocol's text ceiling, in characters. A longer draft is not copied, and never truncated. */
  draftChars: 1_000_000,
  /** All copied text of the Workbench together, in characters. The oldest drafts give way first. */
  surfaceChars: 2_000_000,
  /** Agent ids, as the chat protocol bounds them. */
  agentIdChars: 160,
} as const;

/** What happened to one draft revision. `saved` means the workspace-state update settled, not merely that it arrived. */
export type DraftBackupState = 'saved' | 'too-long' | 'over-budget' | 'unavailable' | 'failed';

export interface DraftBackupResult {
  agentId: string;
  /** The page revision this result is about; 0 for a draft dropped by the budget, whatever its revision. */
  revision: number;
  state: DraftBackupState;
  /** The host sequence at which this revision was recorded. Later sends of the agent have higher marks. */
  basis: number;
}

export interface DraftEdit {
  agentId: string;
  text: string;
  revision: number;
  /** The agent's incarnation the page made this text for; 0 for text saved before incarnations existed. */
  epoch: number;
  /** The page holds more than the copy keeps. It sends no text then, and the copy keeps none. */
  overLimit?: boolean;
}

/** One draft of a page snapshot, as the restored page holds it. `basis` is the newest host sequence it had heard of. */
export interface DraftSnapshotEntry extends DraftEdit {
  basis: number;
}

/** A draft offered to a new Workbench page that has no state of its own. */
export interface SeededDraft {
  agentId: string;
  text: string;
  epoch: number;
  basis: number;
}

interface CopiedDraft {
  text: string;
  seq: number;
  epoch: number;
}

interface Incarnation {
  epoch: number;
  /**
   * True only for an agent that was already in the roster when this copy was first made. Text it saved without an
   * incarnation (an earlier UnodeAi) may be its own; for any later agent, such text is a predecessor's.
   */
  adoptsUntagged: boolean;
}

/** The latest Workbench send of an agent the host accepted: its sequence, and the page revision it sent. */
interface SendMark {
  seq: number;
  revision: number;
}

/** The copy keeps one memento value. Every update writes all of it, which is what makes writes easy to order. */
interface MirrorRecordV1 {
  version: 1;
  seq: number;
  /** False until the copy first saw the whole roster. */
  adopted: boolean;
  selectedAgentId?: string;
  drafts: Record<string, CopiedDraft>;
  incarnations: Record<string, Incarnation>;
  sent: Record<string, SendMark>;
}

export interface ChatDraftMirrorStore extends WorkspaceMemento {
  /** False when no workspace root is bound: then nothing is read or written, and nothing is rejected unhandled. */
  available(): boolean;
}

export interface DraftSyncOutcome {
  dropped: string[];
  results: Promise<DraftBackupResult[]>;
}

export class ChatDraftMirror {
  private seq = 0;
  private adopted = false;
  private selected: string | undefined;
  private readonly drafts = new Map<string, CopiedDraft>();
  private readonly incarnations = new Map<string, Incarnation>();
  private readonly sent = new Map<string, SendMark>();
  /** The live Workbench page this copy currently accepts edits from. A page of any other generation is stale. */
  private surface: string | undefined;
  /** The live page already reported its drafts, or edited one: a later report from it is not its start state. */
  private surfaceStarted = false;
  private readonly liveRevisions = new Map<string, number>();
  private readonly sentRevisions = new Map<string, number>();
  private mutations = 0;
  private durable = 0;
  private writing: Promise<void> | undefined;
  private readonly waiters: Array<{ at: number; done: (saved: boolean) => void }> = [];
  /** Set by Reset: from then on this copy reads and writes nothing, so a late write cannot outlive the reset. */
  private retired = false;

  constructor(private readonly store: ChatDraftMirrorStore) {
    if (store.available()) this.load(store.get<unknown>(CHAT_DRAFT_MIRROR_KEY));
  }

  available(): boolean {
    return !this.retired && this.store.available();
  }

  /**
   * The whole roster is loaded. Agents not in it are forgotten, with their drafts and send marks; agents without an
   * incarnation get one. The first time the copy sees a roster, its agents may also own untagged older drafts.
   */
  rosterLoaded(liveAgentIds: ReadonlySet<string>): void {
    if (!this.available()) return;
    let changed = false;
    for (const agentId of [...this.incarnations.keys()]) {
      if (!liveAgentIds.has(agentId)) changed = this.forget(agentId) || changed;
    }
    for (const agentId of [...this.drafts.keys(), ...this.sent.keys()]) {
      if (!liveAgentIds.has(agentId)) changed = this.forget(agentId) || changed;
    }
    if (this.selected && !liveAgentIds.has(this.selected)) {
      this.selected = undefined;
      changed = true;
    }
    for (const agentId of liveAgentIds) {
      if (!this.incarnations.has(agentId)) {
        this.incarnations.set(agentId, { epoch: ++this.seq, adoptsUntagged: !this.adopted });
        changed = true;
      }
    }
    if (!this.adopted) {
      this.adopted = true;
      changed = true;
    }
    if (changed) void this.persist();
  }

  /**
   * Reset UnodeAi in this workspace: forget everything and write nothing again. Settles once any write under way
   * has settled, so the reset that follows deletes the last of it.
   */
  retire(): Promise<boolean> {
    this.retired = true;
    this.drafts.clear();
    this.incarnations.clear();
    this.sent.clear();
    this.selected = undefined;
    this.surface = undefined;
    return this.writing ? this.writing.then(() => true, () => true) : Promise.resolve(true);
  }

  /** A new live Workbench page. Edits, reports and send marks of every earlier page are refused from now on. */
  beginSurface(): string {
    this.surface = randomUUID();
    this.surfaceStarted = false;
    this.liveRevisions.clear();
    this.sentRevisions.clear();
    return this.surface;
  }

  /** The live page went away without a successor; nothing it sends later is accepted. */
  endSurface(token: string): void {
    if (this.surface === token) this.surface = undefined;
  }

  isCurrentSurface(token: string | undefined): boolean {
    return token !== undefined && token === this.surface;
  }

  /** The current incarnation of an agent that exists; one is given to it if it has none yet. 0 with no copy. */
  epochOf(agentId: string): number {
    return this.incarnation(agentId)?.epoch ?? 0;
  }

  /** The incarnations of the given existing agents, for the state both chat pages receive. Empty with no copy. */
  epochsFor(agentIds: Iterable<string>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const agentId of agentIds) {
      const epoch = this.epochOf(agentId);
      if (epoch) result[agentId] = epoch;
    }
    return result;
  }

  /** Of the given existing agents, those that also own drafts saved without an incarnation. */
  adoptingAgents(agentIds: Iterable<string>): string[] {
    return [...agentIds].filter((agentId) => this.incarnation(agentId)?.adoptsUntagged === true);
  }

  selectedAgentId(): string | undefined {
    return this.selected;
  }

  hasDrafts(liveAgentIds: ReadonlySet<string>): boolean {
    return this.seed(liveAgentIds).length > 0;
  }

  /** The copied drafts of agents that still exist, for a new page that has no state of its own. */
  seed(liveAgentIds: ReadonlySet<string>): SeededDraft[] {
    return [...this.drafts.entries()]
      .filter(([agentId, draft]) => liveAgentIds.has(agentId) && draft.epoch === this.incarnations.get(agentId)?.epoch)
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([agentId, draft]) => ({ agentId, text: draft.text, epoch: draft.epoch, basis: draft.seq }));
  }

  /**
   * One composer edit of the live page. Undefined when it is stale (another page, an earlier incarnation, an older
   * revision than one already taken, or text a send already accepted): it is ignored, not answered.
   */
  edit(token: string, edit: DraftEdit, agentExists: boolean): Promise<DraftBackupResult[]> | undefined {
    if (!this.isCurrentSurface(token) || !agentExists) return undefined;
    const epoch = this.currentEpochFor(edit.agentId, edit.epoch);
    if (epoch === undefined) return undefined;
    if (edit.revision <= (this.liveRevisions.get(edit.agentId) ?? 0)) return undefined;
    if (edit.revision <= (this.sentRevisions.get(edit.agentId) ?? 0)) return undefined;
    this.liveRevisions.set(edit.agentId, edit.revision);
    this.surfaceStarted = true;
    if (!this.available()) {
      return Promise.resolve([{ agentId: edit.agentId, revision: edit.revision, state: 'unavailable', basis: this.seq }]);
    }
    const { agentId, text, revision } = edit;
    let state: DraftBackupState = edit.overLimit ? 'too-long' : 'saved';
    const basisNow = this.seq;
    if (!text && !this.drafts.has(agentId)) {
      // Nothing to delete. The answer still waits for any write already under way, so it never claims too early.
      return this.flush().then((saved) => [{ agentId, revision, state: saved ? state : 'failed', basis: basisNow }]);
    }
    let basis = basisNow;
    if (!text || edit.overLimit) {
      this.drafts.delete(agentId);
    } else if (text.length > CHAT_DRAFT_LIMITS.draftChars) {
      // An older copy of this draft would come back as if it were the draft. Not copying it at all is the honest state.
      this.drafts.delete(agentId);
      state = 'too-long';
    } else {
      basis = ++this.seq;
      this.drafts.set(agentId, { text, seq: basis, epoch });
    }
    const evicted = this.applyBudget(agentId);
    const evictedBasis = this.seq;
    return this.persist().then((saved) => [
      { agentId, revision, state: saved ? state : 'failed', basis },
      ...evicted.map((other) => ({ agentId: other, revision: 0, state: 'over-budget' as const, basis: evictedBasis })),
    ]);
  }

  /**
   * The drafts a live page holds when it starts, reported once, before any edit of it. Text of an earlier
   * incarnation, or text a later accepted send made stale, is dropped from the page as well. With `replace` (a page
   * VS Code restored, whose state is the newest) the page's drafts replace the copy; otherwise (a page this host
   * created) they are added, and a draft the page does not hold is kept. A later report from the same page is
   * ignored: it is not the page's start state, and it must not undo an edit taken since.
   */
  sync(
    token: string,
    entries: ReadonlyArray<DraftSnapshotEntry & { overLimit?: boolean }>,
    liveAgentIds: ReadonlySet<string>,
    replace = true,
  ): DraftSyncOutcome | undefined {
    if (!this.isCurrentSurface(token)) return undefined;
    if (this.surfaceStarted) return { dropped: [], results: Promise.resolve([]) };
    this.surfaceStarted = true;
    const dropped: string[] = [];
    const kept: Array<DraftSnapshotEntry & { overLimit?: boolean }> = [];
    for (const entry of entries) {
      const epoch = liveAgentIds.has(entry.agentId) ? this.currentEpochFor(entry.agentId, entry.epoch) : undefined;
      const sent = this.sent.get(entry.agentId);
      // Text the page held when a later send was accepted is that send's text, unless it was edited after it.
      const stale = epoch === undefined
        || (sent !== undefined && sent.seq > entry.basis && entry.revision <= sent.revision);
      if (stale) dropped.push(entry.agentId);
      else kept.push({ ...entry, epoch });
    }
    for (const entry of kept) this.liveRevisions.set(entry.agentId, entry.revision);
    const withText = kept.filter((entry) => entry.text || entry.overLimit);
    if (!this.available()) {
      return {
        dropped,
        results: Promise.resolve(withText.map((entry) => ({ agentId: entry.agentId, revision: entry.revision, state: 'unavailable' as const, basis: this.seq }))),
      };
    }
    if (replace) {
      this.drafts.clear();
    } else {
      for (const agentId of dropped) this.drafts.delete(agentId);
    }
    const tooLong = new Set<string>();
    const recorded = new Map<string, number>();
    for (const entry of [...kept].sort((a, b) => a.revision - b.revision)) {
      if (!entry.text && !entry.overLimit) {
        this.drafts.delete(entry.agentId);
        continue;
      }
      if (entry.overLimit || entry.text.length > CHAT_DRAFT_LIMITS.draftChars) {
        this.drafts.delete(entry.agentId);
        tooLong.add(entry.agentId);
        continue;
      }
      const seq = ++this.seq;
      recorded.set(entry.agentId, seq);
      this.drafts.set(entry.agentId, { text: entry.text, seq, epoch: entry.epoch });
    }
    const evicted = new Set(this.applyBudget(undefined));
    const basisNow = this.seq;
    return {
      dropped,
      results: this.persist().then((saved) => withText.map((entry) => ({
        agentId: entry.agentId,
        revision: entry.revision,
        state: tooLong.has(entry.agentId) ? 'too-long' as const
          : evicted.has(entry.agentId) ? 'over-budget' as const
            : saved ? 'saved' as const : 'failed' as const,
        basis: recorded.get(entry.agentId) ?? basisNow,
      }))),
    };
  }

  /**
   * The host accepted a Workbench send of this agent at this page revision. Its copy goes, unless the page already
   * sent a newer edit, and the returned sequence marks older saved text as sent. Undefined when the page is stale.
   */
  acceptSend(token: string | undefined, agentId: string, revision: number): number | undefined {
    if (!token || !this.isCurrentSurface(token)) return undefined;
    this.sentRevisions.set(agentId, Math.max(this.sentRevisions.get(agentId) ?? 0, revision));
    if (!this.available()) return undefined;
    const mark = ++this.seq;
    this.sent.set(agentId, { seq: mark, revision });
    const draft = this.drafts.get(agentId);
    if (draft && (this.liveRevisions.get(agentId) ?? 0) > revision) {
      // The page sent a newer edit first. That text is not the one sent, so it stays and is ordered after the mark.
      draft.seq = ++this.seq;
    } else {
      this.drafts.delete(agentId);
    }
    void this.persist();
    return mark;
  }

  /** The agent was removed: its incarnation, copy and marks go, and a later agent with the same id starts anew. */
  removeAgent(agentId: string): void {
    if (!this.available()) return;
    this.forget(agentId);
    // From now on an agent the copy has not seen came after it started, so untagged text cannot be its own.
    this.adopted = true;
    this.liveRevisions.delete(agentId);
    this.sentRevisions.delete(agentId);
    void this.persist();
  }

  /** The user closed the live Workbench: its drafts go with it, as they always did with the page's own state. */
  clearDrafts(): void {
    if (!this.available() || this.drafts.size === 0) return;
    this.drafts.clear();
    void this.persist();
  }

  /** The agent the user last chose, offered to a Workbench rebuilt from this copy. A preference, never authority. */
  setSelected(agentId: string): void {
    if (!this.available() || !agentId || agentId === this.selected) return;
    this.selected = agentId;
    void this.persist();
  }

  writePending(): boolean {
    return this.writing !== undefined || this.durable < this.mutations;
  }

  /** Settles when every change made so far has been written, or its write has failed. Never rejects. */
  flush(): Promise<boolean> {
    if (!this.writePending()) return Promise.resolve(true);
    return new Promise((done) => {
      this.waiters.push({ at: this.mutations, done });
      this.pump();
    });
  }

  /** The agent's incarnation, given now if it has none. Undefined with no copy. */
  private incarnation(agentId: string): Incarnation | undefined {
    if (!this.available()) return undefined;
    let incarnation = this.incarnations.get(agentId);
    if (!incarnation) {
      incarnation = { epoch: ++this.seq, adoptsUntagged: !this.adopted };
      this.incarnations.set(agentId, incarnation);
      void this.persist();
    }
    return incarnation;
  }

  /**
   * The incarnation text tagged `epoch` belongs to: the agent's current one when the tag matches it, or when the
   * text is untagged and the current incarnation owns untagged text. Undefined for an earlier incarnation's text.
   */
  private currentEpochFor(agentId: string, epoch: number): number | undefined {
    const incarnation = this.incarnation(agentId);
    if (!incarnation) return epoch === 0 ? 0 : undefined;
    if (epoch === incarnation.epoch) return epoch;
    return epoch === 0 && incarnation.adoptsUntagged ? incarnation.epoch : undefined;
  }

  private forget(agentId: string): boolean {
    const had = this.incarnations.delete(agentId);
    const hadDraft = this.drafts.delete(agentId);
    const hadMark = this.sent.delete(agentId);
    if (this.selected === agentId) this.selected = undefined;
    return had || hadDraft || hadMark;
  }

  private applyBudget(protectedAgentId: string | undefined): string[] {
    const evicted: string[] = [];
    const total = () => [...this.drafts.values()].reduce((sum, draft) => sum + draft.text.length, 0);
    while (this.drafts.size > CHAT_DRAFT_LIMITS.drafts || total() > CHAT_DRAFT_LIMITS.surfaceChars) {
      const oldest = [...this.drafts.entries()]
        .filter(([agentId]) => agentId !== protectedAgentId)
        .sort(([, a], [, b]) => a.seq - b.seq)[0];
      if (!oldest) break;
      this.drafts.delete(oldest[0]);
      evicted.push(oldest[0]);
    }
    return evicted;
  }

  /** Writes are serialized and each writes the whole current copy, so an older slow write never lands after a newer one. */
  private persist(): Promise<boolean> {
    this.mutations += 1;
    return new Promise((done) => {
      this.waiters.push({ at: this.mutations, done });
      this.pump();
    });
  }

  private pump(): void {
    if (this.writing || this.durable >= this.mutations || this.retired) {
      if (!this.writing) this.settle(this.durable, true);
      return;
    }
    const at = this.mutations;
    let update: PromiseLike<void>;
    try {
      update = this.store.update(CHAT_DRAFT_MIRROR_KEY, this.snapshot());
    } catch (error) {
      update = Promise.reject(error);
    }
    this.writing = Promise.resolve(update).then(
      () => {
        this.durable = Math.max(this.durable, at);
        this.settle(at, true);
      },
      () => this.settle(at, false),
    ).finally(() => {
      this.writing = undefined;
      if (this.mutations > at) this.pump();
      else this.settle(this.durable, true);
    });
  }

  private settle(at: number, saved: boolean): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      if (this.waiters[index].at <= at) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter.done(saved);
      }
    }
  }

  private snapshot(): MirrorRecordV1 {
    return {
      version: 1,
      seq: this.seq,
      adopted: this.adopted,
      ...(this.selected ? { selectedAgentId: this.selected } : {}),
      drafts: Object.fromEntries([...this.drafts.entries()].map(([agentId, draft]) => [agentId, { ...draft }])),
      incarnations: Object.fromEntries([...this.incarnations.entries()].map(([agentId, incarnation]) => [agentId, { ...incarnation }])),
      sent: Object.fromEntries([...this.sent.entries()].map(([agentId, mark]) => [agentId, { ...mark }])),
    };
  }

  /** An unknown version, or anything malformed, is not authority: it is read as an empty copy. */
  private load(raw: unknown): void {
    if (!isRecord(raw) || raw.version !== 1 || !isCount(raw.seq)) return;
    this.seq = raw.seq;
    this.adopted = raw.adopted === true;
    if (isRecord(raw.incarnations)) {
      for (const [agentId, incarnation] of Object.entries(raw.incarnations)) {
        if (!isAgentId(agentId) || !isRecord(incarnation)) continue;
        const { epoch, adoptsUntagged } = incarnation;
        if (!isCount(epoch) || epoch === 0 || epoch > this.seq || typeof adoptsUntagged !== 'boolean') continue;
        this.incarnations.set(agentId, { epoch, adoptsUntagged });
      }
    }
    if (isRecord(raw.sent)) {
      for (const [agentId, mark] of Object.entries(raw.sent)) {
        if (!isAgentId(agentId) || !this.incarnations.has(agentId) || !isRecord(mark)) continue;
        if (isCount(mark.seq) && mark.seq <= this.seq && isCount(mark.revision)) {
          this.sent.set(agentId, { seq: mark.seq, revision: mark.revision });
        }
      }
    }
    if (isRecord(raw.drafts)) {
      for (const [agentId, draft] of Object.entries(raw.drafts)) {
        if (!isAgentId(agentId) || !isRecord(draft)) continue;
        const { text, seq, epoch } = draft;
        if (typeof text !== 'string' || !text || text.length > CHAT_DRAFT_LIMITS.draftChars) continue;
        if (!isCount(seq) || seq > this.seq || !isCount(epoch) || epoch !== this.incarnations.get(agentId)?.epoch) continue;
        if ((this.sent.get(agentId)?.seq ?? 0) > seq) continue;
        this.drafts.set(agentId, { text, seq, epoch });
      }
      this.applyBudget(undefined);
    }
    if (typeof raw.selectedAgentId === 'string' && this.incarnations.has(raw.selectedAgentId)) this.selected = raw.selectedAgentId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAgentId(value: string): boolean {
  return value.length > 0 && value.length <= CHAT_DRAFT_LIMITS.agentIdChars;
}
