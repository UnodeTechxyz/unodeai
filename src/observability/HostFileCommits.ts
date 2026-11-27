import { randomUUID } from 'node:crypto';
import type { HostObservedFileEffect } from '../backend/fileWritePolicy';
import { isPathInsideOrEqual } from '../backend/pathContainment';
import { redactDiagnosticText } from '../security/diagnosticRedaction';

/** Host-private evidence. Never include physical keys or these records in portable run snapshots. */
export interface HostFileCommitFact {
  readonly id: string;
  readonly sequence: number;
  readonly workspace: string;
  readonly key: string;
  readonly agentId: string;
  readonly requestId?: string;
  readonly turnId?: string;
  readonly state: 'committed' | 'uncertain' | 'deleted';
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly reportedModelId?: string;
  /** Loaded versions this fact causally replaces; independent host sequences alone prove no order. */
  readonly replaces?: readonly string[];
}

/** One host's observed effect order; absence, restart, eviction or mismatched bytes means unknown. */
export class HostFileCommits {
  private readonly latest = new Map<string, HostFileCommitFact>();
  private sequence = 0;
  private durableSequence = 0;
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;
  private readonly loadedIds: Set<string>;

  constructor(records: readonly unknown[] = [], private readonly save?: (facts: HostFileCommitFact[]) => Promise<readonly string[] | void>) {
    // Corrupt storage cannot reveal an older author by silently dropping only its newer invalid record.
    this.loadedIds = new Set(records.filter(validFact).map(fact => fact.id));
    if (!records.every(validFact)) return;
    for (const fact of records as HostFileCommitFact[]) {
      const key = JSON.stringify([fact.workspace, fact.key]);
      const prior = this.latest.get(key);
      const clean = copyFact(fact);
      const conflict = prior && JSON.stringify(prior) !== JSON.stringify(clean);
      if (!prior || !conflict || clean.replaces?.includes(prior.id)) this.latest.set(key, Object.freeze(clean));
      else if (!prior.replaces?.includes(clean.id)) this.latest.set(key, Object.freeze({ ...clean,
        state: 'uncertain', sha256: undefined, reportedModelId: undefined,
        replaces: [...new Set([...(prior.replaces ?? []), prior.id, ...(clean.replaces ?? [])])],
      }));
      this.sequence = Math.max(this.sequence, fact.sequence);
    }
    const kept = [...this.latest.entries()].sort((a, b) => a[1].sequence - b[1].sequence).slice(-4096);
    this.latest.clear();
    for (const [key, fact] of kept) this.latest.set(key, fact);
    this.durableSequence = this.sequence;
  }

  /** Workspace-state only. These private facts must never be added to RunRecord/portable snapshots. */
  snapshot(): HostFileCommitFact[] { return [...this.latest.values()].map(fact => ({ ...fact })); }

  async flush(): Promise<void> { await this.saving; }

  record(workspace: string, effect: HostObservedFileEffect, reportedModelId?: string): void {
    if (!workspace || !effect.key) return;
    if (effect.operation === 'delete-directory') {
      for (const fact of [...this.latest.values()]) {
        if (fact.workspace === workspace && isPathInsideOrEqual(effect.key, fact.key)) {
          this.record(workspace, { ...effect, key: fact.key, operation: 'delete-file' });
        }
      }
    }
    const id = JSON.stringify([workspace, effect.key]);
    const previous = this.latest.get(id);
    const replaces = [...new Set([...(previous?.replaces ?? []).filter(id => this.loadedIds.has(id)), ...(previous ? [previous.id] : [])])];
    const committed = effect.operation === 'write' && effect.grade !== 'effect-uncertain'
      && typeof effect.sha256 === 'string' && /^[a-f0-9]{64}$/.test(effect.sha256);
    const model = reportedModelId && reportedModelId.length <= 512 && !/[\r\n]/.test(reportedModelId)
      && redactDiagnosticText(reportedModelId) === reportedModelId ? reportedModelId : undefined;
    const fact: HostFileCommitFact = Object.freeze({
      id: randomUUID(), sequence: ++this.sequence, workspace, key: effect.key, agentId: effect.agentId,
      ...(effect.requestId ? { requestId: effect.requestId } : {}),
      ...(effect.turnId ? { turnId: effect.turnId } : {}),
      state: committed ? 'committed' : effect.operation !== 'write' && effect.grade !== 'effect-uncertain' ? 'deleted' : 'uncertain',
      ...(committed ? { sha256: effect.sha256,
        ...(Number.isSafeInteger(effect.byteLength) && effect.byteLength! >= 0 ? { byteLength: effect.byteLength } : {}) } : {}),
      ...(committed && model ? { reportedModelId: model } : {}),
      ...(replaces.length ? { replaces } : {}),
    });
    this.latest.delete(id);
    this.latest.set(id, fact);
    while (this.latest.size > 4096) this.latest.delete(this.latest.keys().next().value!);
    if (this.save && !this.saveQueued) {
      this.saveQueued = true;
      this.saving = Promise.resolve().then(async () => {
        try {
          let attempted = -1;
          while (attempted !== this.sequence) {
            const through = this.sequence;
            const snapshot = this.snapshot();
            for (const fact of snapshot) this.loadedIds.add(fact.id);
            try {
              const retained = await this.save!(snapshot);
              if (retained) { this.loadedIds.clear(); for (const id of retained) this.loadedIds.add(id); }
              this.durableSequence = through;
            }
            catch { /* A failed save never acknowledges the newer author. */ }
            attempted = through;
          }
        } finally { this.saveQueued = false; }
      });
    } else if (!this.save) this.durableSequence = this.sequence;
  }

  author(workspace: string, key: string, currentSha256: string): HostFileCommitFact | undefined {
    const fact = this.latest.get(JSON.stringify([workspace, key]));
    return fact?.state === 'committed' && fact.sequence <= this.durableSequence && fact.sha256 === currentSha256 && fact.reportedModelId
      ? { ...fact } : undefined;
  }
}

function validFact(value: unknown): value is HostFileCommitFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as HostFileCommitFact;
  return typeof fact.id === 'string' && typeof fact.workspace === 'string' && typeof fact.key === 'string'
    && typeof fact.agentId === 'string' && Number.isSafeInteger(fact.sequence) && fact.sequence > 0
    && ['committed', 'uncertain', 'deleted'].includes(fact.state)
    && (fact.requestId === undefined || typeof fact.requestId === 'string')
    && (fact.turnId === undefined || typeof fact.turnId === 'string')
    && (fact.replaces === undefined || (Array.isArray(fact.replaces) && fact.replaces.every(id => typeof id === 'string')))
    && (fact.sha256 === undefined ? fact.state !== 'committed' : typeof fact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(fact.sha256))
    && (fact.reportedModelId === undefined || (typeof fact.reportedModelId === 'string'
      && fact.reportedModelId.length <= 512 && !/[\r\n]/.test(fact.reportedModelId)
      && redactDiagnosticText(fact.reportedModelId) === fact.reportedModelId))
    && (fact.byteLength === undefined || (Number.isSafeInteger(fact.byteLength) && fact.byteLength >= 0));
}

function copyFact(fact: HostFileCommitFact): HostFileCommitFact {
  return { id: fact.id, sequence: fact.sequence, workspace: fact.workspace, key: fact.key, agentId: fact.agentId,
    state: fact.state, ...(fact.requestId ? { requestId: fact.requestId } : {}), ...(fact.turnId ? { turnId: fact.turnId } : {}),
    ...(fact.sha256 ? { sha256: fact.sha256 } : {}), ...(fact.byteLength !== undefined ? { byteLength: fact.byteLength } : {}),
    ...(fact.reportedModelId ? { reportedModelId: fact.reportedModelId } : {}),
    ...(fact.replaces?.length ? { replaces: [...fact.replaces] } : {}) };
}
