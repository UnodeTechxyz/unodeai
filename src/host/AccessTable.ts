/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the project's access table (v0.9.101)
 *
 *  The one record of what each request needs outside the workspace, what is granted, and what is still missing
 *  (design: CLAUDE_DESIGN_v09101_REQUEST_ACCESS_MODEL, R1 as retained by R2, R2 as amended by R3; the Owner,
 *  2026-11-07: "one maintained authorization table; do not keep changing things according to state").
 *
 *  - Rows change only in transactions, one per event. The state rule is applied only when a row is written; views
 *    (items, waiting work, the status line, the run marker) read rows and are told which rows changed.
 *  - It is a record, never authority: every file call is still checked at the moment of use, and a check reports what
 *    it saw back here (R2 §3, R3). A stale report is kept as history and changes nothing that decides a state.
 *  - Grants live in `grants`, the deliberate grant rows: SessionLocalReadScopeConsent writes and reads them through its
 *    unchanged API.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { FolderPermission } from '../types';
import type { PathGrantRows, SessionPathAccessGrant } from '../backend/localReadScope';
import { isPathInsideOrEqual } from '../backend/pathContainment';

/** What a need row says about its consumer's access to its target (R2 §1). */
export type NeedState = 'met' | 'partial' | 'missing' | 'limit';
/** Why a target is needed. */
export type NeedWhy = 'named' | 'input' | 'output' | 'refused' | 'save' | 'source';
/** The agent that will use a target, and the task or waiting preparation it uses it for. */
export interface AccessConsumer { agentId: string; handle?: string }
export type AccessSource = 'grant' | 'full' | 'configured' | 'none';

/** One consumer's access to one target now, as the host's existing access facts give it. */
export interface AccessJudgement {
  state: NeedState;
  /** What the consumer reaches now, from any source. */
  effective: 'none' | FolderPermission;
  source: AccessSource;
  /** What the person's own grants give: "granted" is never claimed for other reach. */
  granted: 'none' | FolderPermission;
  grantIds: readonly string[];
}

export interface AccessTablePorts {
  /** The state rule's facts: the consumer's reach inputs, the grants of the request and the session, and `identity`. */
  judge(consumer: AccessConsumer, requestId: string, named: string, needed: FolderPermission, observed: string | undefined): AccessJudgement;
  /**
   * The physical identity a file call on `named` would act on now; undefined when it cannot be resolved without
   * contacting another computer (E2) or at all. Never probes a share, device or /net spelling.
   */
  identity(named: string): string | undefined;
  /** Whether `named` is a share, device or /net spelling, which keeps its own item (R2 §5). */
  remote(named: string): boolean;
  /** Whether `named` is a folder, where the host can tell without contacting another computer. */
  isDirectory?(named: string): boolean | undefined;
  now?(): string;
}

export type RequestLifecycle = 'running' | 'waiting' | 'answered' | 'closed';
export type RequestCloseReason = 'stopped' | 'cleared' | 'removed' | 'abandoned' | 'reload' | 'coordinator-gone' | 'done';
export type ContinuationState = 'none' | 'eligible' | 'spent:started' | 'spent:unavailable';

export interface NeedSnapshot {
  label: string;
  path: string;
  needed: FolderPermission;
  state: NeedState;
  why: NeedWhy[];
  consumer: AccessConsumer;
}

export interface RequestRow {
  requestId: string;
  lifecycle: RequestLifecycle;
  closeReason?: RequestCloseReason;
  continuation: ContinuationState;
  /** The need rows not `met` at the moment it closed, as they were then (R2 §2). */
  unmetAtClose?: NeedSnapshot[];
  /**
   * The PM turn that first ended with this request waiting (R2 §5). v0.9.102: the PM live strip of `agentId` shows the
   * request's needs whenever it waits, also a later wait of the same request, as soon as it begins.
   */
  statusAnchor?: { agentId: string; turnId: string };
  updatedAt: string;
}

/** What a check at use reported (R2 §3, R3). */
export type UseCheckOutcome = 'reached' | 'access-missing' | 'access-limit' | 'not-access' | 'remote-unprobed';
export interface UseCheckReport {
  requestId: string;
  consumer: AccessConsumer;
  namedPath: string;
  observedPhysical?: string;
  observedAt: string;
  /** The target row's revision when the check began (`revisionOf`). */
  startRevision: number;
  outcome: UseCheckOutcome;
  grantId?: string;
}

export interface TargetRow {
  id: string;
  requestId: string;
  /** The path as the need named it. */
  named: string;
  /** The identity key: the physical path where it can be resolved, the spelling for a remote one. */
  key: string;
  kind: 'File' | 'Folder';
  label: string;
  /** The operative physical identity at the row's revision (R3): what the state rule reads. */
  observed?: string;
  /** What checks reported, applicable or not; nothing that decides a state reads it (R3). */
  history: Array<UseCheckReport & { applied: boolean }>;
  revision: number;
  /** The row whose item shows this one: its own id, or the nearest ancestor folder row of the same request. */
  shownOn: string;
}

export interface NeedRow {
  id: string;
  targetId: string;
  consumer: AccessConsumer;
  needed: FolderPermission;
  why: Set<NeedWhy>;
  judgement: AccessJudgement;
  /**
   * Its consumer no longer waits on it: its step was resumed, abandoned or voided (audit of cc0b6bc6, F1). It is still
   * judged, so its target's item keeps showing what is granted, but no readiness, status line, marker or close snapshot
   * reads it. The same consumer needing it again makes it live again.
   */
  released?: boolean;
}

/**
 * v0.9.101 (R1 §2.4): the table as stored in the workspace's storage. A record only: grants are not in it, and restoring it
 * closes every request it holds as ended by the reload, judged no more.
 */
export interface AccessTableSnapshot {
  version: 1;
  requests: RequestRow[];
  targets: Array<Omit<TargetRow, 'history'>>;
  needs: Array<Omit<NeedRow, 'why'> & { why: NeedWhy[] }>;
}

/** Which rows a transaction changed: each view redraws only what is listed. */
export interface AccessTableChange {
  targets: ReadonlySet<string>;
  requests: ReadonlySet<string>;
}

const HISTORY = 16;
const RETAINED_REQUESTS = 256;

const keyCase = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
// Whole path segments: a child named `..notes` is inside, as the shared containment rule reads it.
const insideOrEqual = (root: string, target: string) => isPathInsideOrEqual(keyCase(root), keyCase(target));
const consumerKey = (consumer: AccessConsumer) => `${consumer.agentId}\u0000${consumer.handle ?? ''}`;
const stronger = (left: FolderPermission, right: FolderPermission): FolderPermission =>
  (left === 'readwrite' || right === 'readwrite' ? 'readwrite' : 'read');

export class AccessTable {
  private readonly requests = new Map<string, RequestRow>();
  private readonly targets = new Map<string, TargetRow>();
  private readonly needs = new Map<string, NeedRow>();
  private readonly listeners = new Set<(change: AccessTableChange) => void>();
  private open?: { targets: Set<string>; requests: Set<string>; restate: Set<string> };
  private laterQueued = false;

  /**
   * The deliberate grant rows (R1 §2.1). SessionLocalReadScopeConsent decides and reads them through its own API; every
   * change re-judges the live need rows.
   */
  readonly grantRows: PathGrantRows = {
    map: new Map<string, SessionPathAccessGrant>(),
    changed: () => this.inputsChanged(),
    changedLater: () => {
      if (this.laterQueued) return;
      this.laterQueued = true;
      queueMicrotask(() => { this.laterQueued = false; this.inputsChanged(); });
    },
  };

  constructor(private readonly ports: AccessTablePorts) {}

  // ─── Transactions ────────────────────────────────────────────────────────────────────────────

  /**
   * One event: `write` marks what it changed; the rule re-states every marked target's need rows, raising each target's
   * revision once, and listeners hear one change. Nested calls join the open transaction.
   */
  transact<T>(write: () => T): T {
    if (this.open) return write();
    this.open = { targets: new Set(), requests: new Set(), restate: new Set() };
    let result: T;
    try {
      result = write();
      for (const targetId of this.open.restate) this.restateTarget(targetId);
    } finally {
      const done = this.open;
      this.open = undefined;
      if (done.targets.size || done.requests.size) {
        const change: AccessTableChange = { targets: done.targets, requests: done.requests };
        for (const listener of [...this.listeners]) {
          try { listener(change); } catch { /* One view's failure does not stop another's redraw. */ }
        }
      }
    }
    return result!;
  }

  onChange(listener: (change: AccessTableChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ─── Events that write rows ──────────────────────────────────────────────────────────────────

  /** A request started, or its lifecycle changed. `closed` writes `unmetAtClose` in the same transaction (R2 §2). */
  setLifecycle(requestId: string, lifecycle: RequestLifecycle, reason?: RequestCloseReason): void {
    this.transact(() => {
      const row = this.requestRow(requestId);
      if (row.lifecycle === 'closed') return;
      if (row.lifecycle === lifecycle) return;
      row.lifecycle = lifecycle;
      if (lifecycle === 'closed') {
        row.closeReason = reason ?? 'done';
        row.unmetAtClose = this.snapshot(requestId).filter((need) => need.state !== 'met');
      }
      row.updatedAt = this.now();
      this.markRequest(requestId);
      for (const target of this.targetsOf(requestId)) this.open!.targets.add(target.id);
    });
  }

  /** Continue's record for an answered request (R2 §2). */
  setContinuation(requestId: string, continuation: ContinuationState): void {
    this.transact(() => {
      const row = this.requestRow(requestId);
      if (row.continuation === continuation) return;
      row.continuation = continuation;
      row.updatedAt = this.now();
      this.markRequest(requestId);
    });
  }

  /** The PM turn that ended with this request waiting: its live strip shows the wait. */
  setStatusAnchor(requestId: string, anchor: { agentId: string; turnId: string } | undefined): void {
    this.transact(() => {
      const row = this.requestRow(requestId);
      row.statusAnchor = anchor;
      this.markRequest(requestId);
    });
  }

  /**
   * A need: named by the person, declared by a dispatch or a save, or found by a refused call. Needs of one consumer on
   * one target merge to the stronger access. Returns the need row's id.
   */
  addNeed(requestId: string, named: string, consumer: AccessConsumer, needed: FolderPermission, why: NeedWhy): string {
    return this.transact(() => {
      this.requestRow(requestId);
      const target = this.targetRow(requestId, named);
      const existing = [...this.needs.values()].find((need) => need.targetId === target.id
        && consumerKey(need.consumer) === consumerKey(consumer));
      if (existing) {
        if (existing.released) { existing.released = undefined; existing.needed = needed; }
        existing.needed = stronger(existing.needed, needed);
        existing.why.add(why);
        // Each event re-states the rows it touches: a need found again is judged again.
        this.restate(target.id);
        return existing.id;
      }
      const need: NeedRow = { id: this.newId('need'), targetId: target.id, consumer: { ...consumer }, needed, why: new Set([why]),
        judgement: { state: 'missing', effective: 'none', source: 'none', granted: 'none', grantIds: [] } };
      this.needs.set(need.id, need);
      this.restate(target.id);
      return need.id;
    });
  }

  /**
   * A consumer no longer waits on its rows: its preparation was resumed, abandoned or voided. The rows are released, not
   * deleted, so their targets' items still show what the grants give (audit of cc0b6bc6, F1). A closed request's rows
   * are its record as it closed: nothing releases them after that (F2).
   */
  dropConsumer(requestId: string, consumer: AccessConsumer): void {
    this.transact(() => {
      if (this.requests.get(requestId)?.lifecycle === 'closed') return;
      for (const need of this.needs.values()) {
        const target = this.targets.get(need.targetId);
        if (!target || target.requestId !== requestId || consumerKey(need.consumer) !== consumerKey(consumer) || need.released) continue;
        need.released = true;
        this.restate(target.id);
      }
    });
  }

  /**
   * Something every row's state rule reads changed: a grant made, revoked or expired, Full access, trust, or the reach
   * inputs of `agentId` (or of every agent). Each live target is re-judged, and its revision rises (R3).
   */
  inputsChanged(agentId?: string): void {
    this.transact(() => {
      for (const target of this.targets.values()) {
        if (this.requests.get(target.requestId)?.lifecycle === 'closed') continue;
        if (agentId && ![...this.needsOf(target.id)].some((need) => need.consumer.agentId === agentId)) continue;
        this.restate(target.id);
      }
    });
  }

  /** The person chose Grant access on an item, or the PM's turn in the request began: its targets are re-judged (R2 §3). */
  rejudge(requestId: string, targetId?: string): void {
    this.transact(() => {
      for (const target of this.targetsOf(requestId)) {
        if (!targetId || target.id === targetId || target.shownOn === targetId) this.restate(target.id);
      }
    });
  }

  /** The revision a check at use carries from its start (R3). Undefined: no row names this target for that consumer. */
  revisionOf(requestId: string, named: string): number | undefined {
    return this.findTarget(requestId, named)?.revision;
  }

  /**
   * A check at use reported. Applicable only at the row's current revision and while the request is not closed: then
   * `observed` and the state are written together. Otherwise it is history only (R3 §2).
   */
  report(report: UseCheckReport): boolean {
    return this.transact(() => {
      const target = this.findTarget(report.requestId, report.namedPath);
      if (!target) return false;
      const applicable = report.startRevision === target.revision
        && this.requests.get(report.requestId)?.lifecycle !== 'closed';
      target.history.push({ ...report, consumer: { ...report.consumer }, applied: applicable });
      if (target.history.length > HISTORY) target.history.splice(0, target.history.length - HISTORY);
      if (!applicable || report.outcome === 'not-access' || report.outcome === 'remote-unprobed') return false;
      this.restate(target.id, report.observedPhysical);
      return true;
    });
  }

  // ─── Reading ─────────────────────────────────────────────────────────────────────────────────

  request(requestId: string): Readonly<RequestRow> | undefined { return this.requests.get(requestId); }

  /**
   * v0.9.102 (the PM live strip): what the coordinator's waiting requests still need, each target and access once. A
   * request counts from the turn that ended with it waiting (its status anchor) until it stops waiting.
   */
  waitingNeedsOf(agentId: string): NeedSnapshot[] {
    const seen = new Set<string>();
    const out: NeedSnapshot[] = [];
    for (const row of this.requests.values()) {
      if (row.lifecycle !== 'waiting' || row.statusAnchor?.agentId !== agentId) continue;
      for (const need of this.unmet(row.requestId)) {
        const key = `${keyCase(need.path)}\u0000${need.needed}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(need);
      }
    }
    return out;
  }

  /**
   * v0.9.103 (slice 3 §4.1): whether a teammate's attempt has an access need the person is asked to grant in `requestId`,
   * the request its running turn belongs to. Only live rows a grant could still meet (`missing`, `partial`) of a request
   * that has not closed count. `waiting`: a row of this teammate with this attempt's handle (a step that waits for access
   * declares its rows so). `unknown`: a row of this teammate that names no handle (a refused file call records the agent
   * alone), which cannot be matched to this attempt or another. A row of another handle is another attempt's. An open
   * row says the person is being asked; it does not prove that the turn has stopped to wait. Reading never writes.
   */
  attemptAccessWait(requestId: string, consumer: { agentId: string; handle: string }): 'none' | 'waiting' | 'unknown' {
    const row = this.requests.get(requestId);
    if (!row || row.lifecycle === 'closed') return 'none';
    let answer: 'none' | 'unknown' = 'none';
    for (const target of this.targetsOf(requestId)) {
      for (const need of this.needsOf(target.id)) {
        if (need.released || need.consumer.agentId !== consumer.agentId) continue;
        if (need.judgement.state !== 'missing' && need.judgement.state !== 'partial') continue;
        if (need.consumer.handle === consumer.handle) return 'waiting';
        if (need.consumer.handle === undefined) answer = 'unknown';
      }
    }
    return answer;
  }

  target(targetId: string): Readonly<TargetRow> | undefined { return this.targets.get(targetId); }

  targetsOf(requestId: string): TargetRow[] {
    return [...this.targets.values()].filter((target) => target.requestId === requestId);
  }

  *needsOf(targetId: string): IterableIterator<Readonly<NeedRow>> {
    for (const need of this.needs.values()) if (need.targetId === targetId) yield need;
  }

  /** The target rows an item shows: the row itself and every row shown on it. */
  shownRows(targetId: string): TargetRow[] {
    return [...this.targets.values()].filter((target) => target.shownOn === targetId);
  }

  /**
   * The row for a named target: by the name first, so a target whose physical identity changed is still the same
   * logical need (R2 §3); then by identity, so a link or an 8.3 name finds the row of the long path.
   */
  findTarget(requestId: string, named: string): TargetRow | undefined {
    const resolved = keyCase(path.resolve(named));
    const rows = [...this.targets.values()].filter((target) => target.requestId === requestId);
    const byName = rows.find((target) => keyCase(target.named) === resolved);
    if (byName) return byName;
    const key = this.keyOf(named);
    return rows.find((target) => target.key === key);
  }

  /** One consumer's live need on one target. */
  needState(requestId: string, named: string, consumer: AccessConsumer): NeedState | undefined {
    const target = this.findTarget(requestId, named);
    if (!target) return undefined;
    for (const need of this.needsOf(target.id)) {
      if (!need.released && consumerKey(need.consumer) === consumerKey(consumer)) return need.judgement.state;
    }
    return undefined;
  }

  /**
   * One target's state across its consumers, as the run marker records it: `met` when every row is met; otherwise the
   * state of a row a grant could still help (`partial`, then `missing`); `limit` when only limits are left.
   */
  targetState(requestId: string, named: string): NeedState | undefined {
    const target = this.findTarget(requestId, named);
    if (!target) return undefined;
    const states = [...this.needsOf(target.id)].filter((need) => !need.released).map((need) => need.judgement.state);
    if (!states.length) return undefined;
    if (states.every((state) => state === 'met')) return 'met';
    if (states.includes('partial')) return 'partial';
    if (states.includes('missing')) return 'missing';
    return 'limit';
  }

  /** Every live need row of a request, as display facts. */
  snapshot(requestId: string): NeedSnapshot[] {
    const rows: NeedSnapshot[] = [];
    for (const target of this.targetsOf(requestId)) {
      for (const need of this.needsOf(target.id)) {
        if (need.released) continue;
        rows.push({ label: target.label, path: target.named, needed: need.needed, state: need.judgement.state,
          why: [...need.why], consumer: { ...need.consumer } });
      }
    }
    return rows;
  }

  /** The request's needs not `met` now, one line per target and access (R2 §5). */
  unmet(requestId: string): NeedSnapshot[] {
    const seen = new Set<string>();
    return this.snapshot(requestId).filter((need) => {
      if (need.state === 'met' || need.state === 'limit') return false;
      const key = `${keyCase(need.path)}\u0000${need.needed}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ─── Rows ────────────────────────────────────────────────────────────────────────────────────

  private requestRow(requestId: string): RequestRow {
    let row = this.requests.get(requestId);
    if (!row) {
      row = { requestId, lifecycle: 'running', continuation: 'none', updatedAt: this.now() };
      this.requests.set(requestId, row);
      this.markRequest(requestId);
      this.prune();
    }
    return row;
  }

  private targetRow(requestId: string, named: string): TargetRow {
    const existing = this.findTarget(requestId, named);
    if (existing) return existing;
    const resolved = path.resolve(named);
    const remote = this.ports.remote(resolved);
    const key = this.keyOf(resolved);
    let directory: boolean | undefined;
    try { directory = remote ? undefined : this.ports.isDirectory?.(resolved); } catch { directory = undefined; }
    // Where the host cannot tell, a name with an extension is read as a file still to be made.
    const kind = (directory ?? !/\.[^.\\/]+$/.test(path.basename(resolved))) ? 'Folder' : 'File';
    const row: TargetRow = { id: this.newId('target'), requestId, named: resolved, key, kind, label: '', history: [], revision: 0, shownOn: '' };
    row.shownOn = row.id;
    this.targets.set(row.id, row);
    this.relabel(requestId);
    this.rehang(requestId);
    this.restate(row.id);
    return row;
  }

  /**
   * Every row of the request is shown on its nearest ancestor folder row of the same request, whichever arrived first.
   * A remote spelling, and anything with no identity, keeps its own item (R2 §5).
   */
  private rehang(requestId: string): void {
    // Outer folders first, so a nested folder's own host is settled before rows inside it are hung on it.
    const rows = this.targetsOf(requestId).sort((left, right) => left.key.length - right.key.length);
    for (const row of rows) {
      const before = row.shownOn;
      let host: TargetRow | undefined;
      if (!this.ports.remote(row.named)) {
        for (const other of rows) {
          if (other.id === row.id || other.kind !== 'Folder' || this.ports.remote(other.named)) continue;
          if (other.key === row.key || !insideOrEqual(other.key, row.key)) continue;
          if (!host || other.key.length > host.key.length) host = other;
        }
      }
      // The nearest folder that is itself shown on its own item.
      while (host && host.shownOn !== host.id) host = this.targets.get(host.shownOn);
      row.shownOn = host?.id ?? row.id;
      if (row.shownOn !== before) { this.open!.targets.add(row.id); this.open!.targets.add(row.shownOn); if (before) this.open!.targets.add(before); }
    }
  }

  /** A row's label: kind and name, with its folder's name when another target of the request has the same name. */
  private relabel(requestId: string): void {
    const rows = this.targetsOf(requestId);
    for (const row of rows) {
      const name = path.basename(row.named) || row.named;
      const twin = rows.some((other) => other.id !== row.id && keyCase(path.basename(other.named)) === keyCase(name));
      const folder = path.basename(path.dirname(row.named));
      const label = `${row.kind} ${twin && folder ? `${folder}${path.sep}${name}` : name}`;
      if (label !== row.label) { row.label = label; this.open!.targets.add(row.id); }
    }
  }

  private restate(targetId: string, observed?: string): void {
    this.open!.restate.add(targetId);
    if (observed !== undefined) this.pendingObserved.set(targetId, observed);
  }

  private readonly pendingObserved = new Map<string, string>();

  /** The state rule, applied when the row is written: observed identity and every need row's judgement, together. */
  private restateTarget(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target) return;
    const reported = this.pendingObserved.get(targetId);
    this.pendingObserved.delete(targetId);
    let observed: string | undefined;
    try { observed = reported ?? this.ports.identity(target.named); } catch { observed = undefined; }
    target.observed = observed;
    target.revision++;
    // Where it leads now decides which folder item shows it: a target that left a granted tree through a link has its
    // own item, and is hung on the folder again once it leads back inside (R2 §5, R3).
    if (!this.ports.remote(target.named)) {
      const key = keyCase(observed ?? target.named);
      if (key !== target.key) { target.key = key; this.rehang(target.requestId); }
    }
    for (const need of this.needsOf(targetId)) {
      let judgement: AccessJudgement;
      try {
        judgement = this.ports.judge(need.consumer, target.requestId, target.named, need.needed, observed);
      } catch {
        judgement = { state: 'missing', effective: 'none', source: 'none', granted: 'none', grantIds: [] };
      }
      (need as NeedRow).judgement = judgement;
    }
    this.open!.targets.add(targetId);
    if (target.shownOn !== targetId) this.open!.targets.add(target.shownOn);
    this.open!.requests.add(target.requestId);
  }

  private markRequest(requestId: string): void { this.open!.requests.add(requestId); }

  private keyOf(named: string): string {
    const resolved = path.resolve(named);
    if (this.ports.remote(resolved)) return keyCase(resolved);
    let identity: string | undefined;
    try { identity = this.ports.identity(resolved); } catch { identity = undefined; }
    return keyCase(identity ?? resolved);
  }

  private prune(): void {
    if (this.requests.size <= RETAINED_REQUESTS) return;
    for (const [requestId, row] of this.requests) {
      if (this.requests.size <= RETAINED_REQUESTS) break;
      if (row.lifecycle !== 'closed') continue;
      this.requests.delete(requestId);
      for (const target of this.targetsOf(requestId)) {
        for (const need of [...this.needsOf(target.id)]) this.needs.delete(need.id);
        this.targets.delete(target.id);
      }
    }
  }

  /** The rows as stored: requests, targets and needs, without grants or check history. */
  toSnapshot(): AccessTableSnapshot {
    return {
      version: 1,
      requests: [...this.requests.values()].map((row) => structuredClone(row)),
      targets: [...this.targets.values()].map(({ history: _history, ...row }) => structuredClone(row)),
      needs: [...this.needs.values()].map((need) => ({ ...structuredClone({ ...need, why: undefined }), why: [...need.why] })),
    };
  }

  /**
   * A stored table from before a reload: its requests are closed by the reload, each keeping what was not met as it was
   * stored; nothing of it is judged again or grants anything (R1 §2.4).
   */
  restore(snapshot: unknown): void {
    const stored = snapshot as Partial<AccessTableSnapshot> | undefined;
    if (!stored || stored.version !== 1 || !Array.isArray(stored.requests) || !Array.isArray(stored.targets) || !Array.isArray(stored.needs)) return;
    this.transact(() => {
      for (const target of stored.targets!) {
        if (!target || typeof target.id !== 'string' || typeof target.requestId !== 'string' || this.targets.has(target.id)) continue;
        this.targets.set(target.id, { ...target, history: [] });
        this.open!.targets.add(target.id);
      }
      for (const need of stored.needs!) {
        if (!need || typeof need.id !== 'string' || !this.targets.has(need.targetId) || this.needs.has(need.id)) continue;
        this.needs.set(need.id, { ...need, why: new Set(Array.isArray(need.why) ? need.why : []) });
      }
      for (const row of stored.requests!) {
        if (!row || typeof row.requestId !== 'string' || this.requests.has(row.requestId)) continue;
        const closed: RequestRow = row.lifecycle === 'closed' ? { ...row } : { ...row, lifecycle: 'closed', closeReason: 'reload' };
        this.requests.set(row.requestId, closed);
        if (row.lifecycle !== 'closed') closed.unmetAtClose = this.snapshot(row.requestId).filter((need) => need.state !== 'met');
        this.markRequest(row.requestId);
      }
    });
  }

  private newId(kind: string): string { return `${kind}-${randomUUID()}`; }
  private now(): string { return this.ports.now?.() ?? new Date().toISOString(); }
}
