/*---------------------------------------------------------------------------------------------
 *  UnodeAi - a lease held across windows, as a chain of generations (v0.9.110 §3.4, F2)
 *
 *  A lease folder holds `gen.<n>.json`, each the complete owner record of one holder, published once by exclusive
 *  link (durableFiles.ts), and `released.<n>` once that holder let go. Generation n+1 can be taken only after n was
 *  released, or after its holder was proven gone by the process identity it published with its record. The holder
 *  of n is never removed or rewritten: a later holder only publishes n+1, and two that try at once cannot both
 *  succeed. A holder whose process is alive, or whose state cannot be proven (no identity, a query that failed, an
 *  unsupported platform), is never taken over; a waiter gets "busy" instead.
 *
 *  The owner is published whole before the lease is held: there is no anonymous moment in which a lease exists
 *  without its process identity. A lease is held only for the short work it protects, never across a model call,
 *  an approval or a person's answer.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { publishExclusive, PublishTakenError, writeDurably, type PublishState } from './durableFiles';
import {
  parseProcessIdentityRecord,
  type ProcessIdentityAdapter,
  type ProcessIdentityRecord,
  type ProcessLiveness,
} from '../host/processIdentity/ProcessIdentityHost';

const GEN_FILE = /^gen\.(\d{12})\.json$/;
const RELEASED_FILE = /^released\.(\d{12})$/;
/** How long one observation of a holder's liveness is reused while waiting. */
const LIVENESS_REUSE_MS = 2_000;
const POLL_MS = 100;

type LivenessCache = Map<number, { at: number; liveness: ProcessLiveness }>;

export interface LeaseOwnerRecord {
  schemaVersion: 1;
  generation: number;
  hostInstanceId: string;
  nonce: string;
  purpose: string;
  /** Absent when this process could not prove its own identity: such a holder is never taken over. */
  identity?: ProcessIdentityRecord;
  /** Display only. */
  acquiredAt: string;
}

export interface HeldLease {
  readonly generation: number;
  readonly nonce: string;
  /** Idempotent. Releasing never removes the record; it publishes `released.<n>`. */
  release(): Promise<void>;
}

export type LeaseHolderState = 'alive' | 'unknown';

export type LeaseAttempt =
  /** `contended`: an unreleased previous holder had to be proven gone first; that time counts against a wait. */
  | { status: 'held'; lease: HeldLease; contended?: true }
  | { status: 'busy'; holder: LeaseHolderState };

export interface GenerationLeaseDeps {
  hostInstanceId: string;
  /** This process's identity, read once; undefined when it cannot be proven. */
  selfIdentity: () => Promise<ProcessIdentityRecord | undefined>;
  identity: ProcessIdentityAdapter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Real-time bound for one liveness query inside a wait; tests replace it. */
  timeout?: (ms: number) => Promise<void>;
  hardLinks?: boolean;
}

/** What one attempt inside a wait may still spend, and the wait's own cancellation. */
interface AttemptBudget {
  remainingMs(): number;
  signal?: AbortSignal;
}

export class GenerationLease {
  private readonly publishState: PublishState;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Generations this process holds now. */
  private readonly held = new Set<number>();

  constructor(private readonly dir: string, private readonly deps: GenerationLeaseDeps) {
    this.publishState = { hardLinks: deps.hardLinks ?? true };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One attempt, no waiting. `observed` reuses liveness answers within one wait, so polling does not start a process
   * query (about a second on Windows) every few milliseconds; a separate attempt always asks afresh.
   */
  async tryAcquire(purpose: string, observed: LivenessCache = new Map(), budget?: AttemptBudget): Promise<LeaseAttempt> {
    await fsp.mkdir(this.dir, { recursive: true });
    const { latest, released } = await this.scan();
    let contended = false;
    if (latest > 0 && !released.has(latest)) {
      const holder = await this.readOwner(latest);
      const state = await this.holderState(latest, holder, observed, budget);
      if (state !== 'gone') return { status: 'busy', holder: state };
      // Taking over from a holder that never released is contention, even on the first attempt.
      contended = holder?.hostInstanceId !== this.deps.hostInstanceId;
    }
    const generation = latest + 1;
    const identity = await this.deps.selfIdentity().catch(() => undefined);
    const record: LeaseOwnerRecord = {
      schemaVersion: 1, generation, hostInstanceId: this.deps.hostInstanceId, nonce: randomUUID(), purpose,
      ...(identity ? { identity } : {}), acquiredAt: new Date(this.now()).toISOString(),
    };
    try {
      await publishExclusive(path.join(this.dir, `.staging-${this.deps.hostInstanceId}-${record.nonce}`), this.genPath(generation),
        `${JSON.stringify(record)}\n`, this.publishState);
    } catch (error) {
      // Another holder published this generation first: it holds the lease now.
      if (error instanceof PublishTakenError) return { status: 'busy', holder: 'alive' };
      throw error;
    }
    this.held.add(generation);
    let done = false;
    const release = async () => {
      if (done) return;
      done = true;
      this.held.delete(generation);
      await writeDurably(path.join(this.dir, `released.${pad(generation)}`), record.nonce).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    };
    // Published under a name pruning had freed while this attempt was paused: a newer generation exists, so this one
    // is stale and holds nothing. It is released at once and the attempt is busy.
    if ((await this.scan()).latest > generation) {
      await release().catch(() => undefined);
      return { status: 'busy', holder: 'alive' };
    }
    // Pruned before the lease is handed out, so no file work of this lease outlives the call.
    await this.prune(generation);
    return { status: 'held', lease: { generation, nonce: record.nonce, release }, ...(contended ? { contended: true as const } : {}) };
  }

  /**
   * Try until held, `waitMs` passes or `signal` aborts. A holder proven gone is taken over at once; a live or unknown
   * one is waited for, and still holding at the end means busy. Never waits past `waitMs`.
   */
  async acquire(purpose: string, options: { waitMs: number; signal?: AbortSignal }): Promise<LeaseAttempt | { status: 'aborted' }> {
    const deadline = this.now() + Math.max(0, options.waitMs);
    const observed: LivenessCache = new Map();
    // The wait's budget covers every query and retry inside it, not only the pauses between attempts.
    const budget: AttemptBudget = { remainingMs: () => Math.max(0, deadline - this.now()), signal: options.signal };
    let last: LeaseAttempt | undefined;
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) return { status: 'aborted' };
      // A retry is part of the contended wait: none starts once its budget is spent.
      if (attempt > 0 && last && this.now() >= deadline) return last;
      const result = await this.tryAcquire(purpose, observed, budget);
      if (result.status === 'held') {
        // A Stop that arrived while the hold was being taken: the hold goes back, and no work runs under it.
        if (options.signal?.aborted) {
          await result.lease.release().catch(() => undefined);
          return { status: 'aborted' };
        }
        // A hold obtained after the wait's end, by a retry or by an attempt that first had to take over from a holder
        // that never released, is not used: the wait ended busy. An uncontended first attempt is not a wait.
        if ((attempt > 0 || result.contended) && this.now() > deadline) {
          await result.lease.release().catch(() => undefined);
          return last ?? { status: 'busy', holder: 'unknown' };
        }
        return result;
      }
      last = result;
      if (options.signal?.aborted) return { status: 'aborted' };
      if (this.now() >= deadline) return last;
      await this.sleep(Math.min(POLL_MS, Math.max(0, deadline - this.now())));
    }
  }

  private async holderState(generation: number, holder: LeaseOwnerRecord | undefined, observed: LivenessCache, budget?: AttemptBudget): Promise<ProcessLiveness> {
    // This host published it and does not hold it now: its own release failed. It knows that it is not holding it.
    if (holder?.hostInstanceId === this.deps.hostInstanceId) return this.held.has(generation) ? 'alive' : 'gone';
    if (!holder?.identity) return 'unknown';
    const cached = observed.get(generation);
    if (cached && this.now() - cached.at < LIVENESS_REUSE_MS) return cached.liveness;
    const query = this.deps.identity.liveness([holder.identity]).then((answers) => answers[0] ?? 'unknown', () => 'unknown' as const);
    // Inside a wait, a query that outlasts the time left is unknown: never gone, and never a longer wait.
    const liveness = budget ? await this.within(query, budget) : await query;
    observed.set(generation, { at: this.now(), liveness });
    return liveness;
  }

  private within(query: Promise<ProcessLiveness>, budget: AttemptBudget): Promise<ProcessLiveness> {
    const remaining = budget.remainingMs();
    if (remaining <= 0 || budget.signal?.aborted) return Promise.resolve('unknown');
    const timeout = this.deps.timeout ?? ((ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    }));
    const aborted = new Promise<ProcessLiveness>((resolve) => budget.signal?.addEventListener('abort', () => resolve('unknown'), { once: true }));
    return Promise.race([query, timeout(remaining).then(() => 'unknown' as const), aborted]);
  }

  /** The holder of `generation`, or undefined when its record cannot be read as one (then it counts as unknown). */
  async readOwner(generation: number): Promise<LeaseOwnerRecord | undefined> {
    try {
      const value = JSON.parse(await fsp.readFile(this.genPath(generation), 'utf8')) as Partial<LeaseOwnerRecord>;
      if (value.schemaVersion !== 1 || value.generation !== generation || typeof value.hostInstanceId !== 'string'
        || typeof value.nonce !== 'string' || typeof value.purpose !== 'string') return undefined;
      const identity = value.identity === undefined ? undefined : parseProcessIdentityRecord(value.identity);
      if (value.identity !== undefined && !identity) return undefined;
      return { schemaVersion: 1, generation, hostInstanceId: value.hostInstanceId, nonce: value.nonce, purpose: value.purpose,
        ...(identity ? { identity } : {}), acquiredAt: typeof value.acquiredAt === 'string' ? value.acquiredAt : '' };
    } catch {
      return undefined;
    }
  }

  /** The newest generation and which generations were released. */
  async scan(): Promise<{ latest: number; released: Set<number> }> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { latest: 0, released: new Set() };
      throw error;
    }
    let latest = 0;
    const released = new Set<number>();
    for (const name of names) {
      const gen = GEN_FILE.exec(name);
      if (gen) latest = Math.max(latest, Number(gen[1]));
      const rel = RELEASED_FILE.exec(name);
      if (rel) released.add(Number(rel[1]));
    }
    return { latest, released };
  }

  /** Older generations are history once a newer one is held; they are removed, the newest two stay. */
  private async prune(current: number): Promise<void> {
    let names: string[];
    try { names = await fsp.readdir(this.dir); } catch { return; }
    for (const name of names) {
      const match = GEN_FILE.exec(name) ?? RELEASED_FILE.exec(name);
      if (match && Number(match[1]) < current - 1) await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
    }
  }

  private genPath(generation: number): string {
    return path.join(this.dir, `gen.${pad(generation)}.json`);
  }
}

function pad(n: number): string {
  return String(n).padStart(12, '0');
}

/** One identity read per process, shared by every lease of this host. */
export function cachedSelfIdentity(identity: ProcessIdentityAdapter): () => Promise<ProcessIdentityRecord | undefined> {
  let read: Promise<ProcessIdentityRecord | undefined> | undefined;
  return () => {
    read ??= identity.self().then((self) => (self === 'unknown' ? undefined : self)).catch(() => undefined);
    return read;
  };
}
