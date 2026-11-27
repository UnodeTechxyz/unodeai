/*---------------------------------------------------------------------------------------------
 *  UnodeAi - what a request's file changes can be put back to (v0.9.110 R1, design §3.1, §4.1)
 *
 *  A restore manifest per top-level request, folded from history events: for each physical file, the state before
 *  the request first changed it and the last state a change was read back as. Its label says what was recorded,
 *  not what a restore will find: a restore checks every target again when it runs.
 *
 *  Only what the host itself observed is listed. A command, a provider's own tool or anything outside that may have
 *  changed files is listed as not reversed, never guessed into a restore point.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import type { HistoryFileState, UncoveredEffectKind } from './HistoryRecords';

export interface RecoveryFileV1 {
  /** The first capture's id: the restore point of the state before. */
  targetId: string;
  displayPath: string;
  physicalTarget: string;
  /** What the file was before this request first changed it. */
  before: HistoryFileState;
  /** What the last change of it was read back as; absent when no change was confirmed. */
  after?: HistoryFileState;
  /** `exact`: the before state is kept exactly (bytes or absence) and the last change was read back. */
  coverage: 'exact' | 'unknown';
  reason?: string;
  /** Every capture of this file in the request, in order. */
  effectRefs: string[];
}

export interface RecoveryUncoveredV1 {
  effect: UncoveredEffectKind;
  path?: string;
  reason: string;
}

export type RecoveryLabel = 'Revertible' | 'Partly revertible' | 'Not revertible' | 'No recorded file changes';

export interface RecoveryManifestV1 {
  rootRequestId: string;
  files: RecoveryFileV1[];
  /** Effects the host could not keep a restore point for. */
  notReversed: RecoveryUncoveredV1[];
  label: RecoveryLabel;
  /** v0.9.110 H1: the person deleted this request's restore points. */
  restorePointsDeleted?: true;
}

/** What the host tells the history about a host-made change, as it is taken and as it ends. */
export interface RecoveryObserver {
  /**
   * A promise: the observer is taking over the hold on this restore point (a favourite task's, v0.9.110 H1). The
   * request keeps its own hold on its restore points, also after it ends, until the promise settles.
   */
  captured(capture: {
    rootRequestId: string; agentId: string; targetId: string; displayPath: string; physicalTarget: string;
    before: HistoryFileState; coverage: 'exact' | 'unknown'; reason?: string;
  }): void | PromiseLike<unknown>;
  settled(settle: { rootRequestId: string; targetId: string; outcome: 'committed' | 'not-committed' | 'uncertain'; after?: HistoryFileState }): void;
}

interface Building {
  /** Every capture of each file, in order, with how its change ended. */
  byPhysical: Map<string, CaptureRecord[]>;
  targetToPhysical: Map<string, string>;
  /** Captures whose change was not made: they do not count as a change of the file. */
  notMade: Set<string>;
  notReversed: RecoveryUncoveredV1[];
  /** The physical key of each not-reversed native-tool entry, by its index, when the host gave one. */
  nativeKeys: Map<number, string>;
}

interface CaptureRecord {
  targetId: string;
  displayPath: string;
  physicalTarget: string;
  before: HistoryFileState;
  coverage: 'exact' | 'unknown';
  reason?: string;
  outcome?: 'committed' | 'not-committed' | 'uncertain';
  after?: HistoryFileState;
}

/** Folds one request's recovery events in history order. `physicalKey` compares paths as the platform does. */
export interface CaptureInOrder {
  rootRequestId: string;
  targetId: string;
  /** Position in the history's order of all captures. */
  order: number;
}

export class RecoveryManifestBuilder {
  private readonly requests = new Map<string, Building>();
  /** Every capture of each physical file, by its key, in history order, whichever request made it. */
  private readonly byFile = new Map<string, CaptureInOrder[]>();
  private sequence = 0;

  constructor(private readonly physicalKey: (physical: string) => string) {}

  private building(rootRequestId: string): Building {
    let held = this.requests.get(rootRequestId);
    if (!held) {
      held = { byPhysical: new Map(), targetToPhysical: new Map(), notMade: new Set(), notReversed: [], nativeKeys: new Map() };
      this.requests.set(rootRequestId, held);
    }
    return held;
  }

  capture(event: { rootRequestId: string; targetId: string; displayPath: string; physicalTarget: string; before: HistoryFileState;
    coverage: 'exact' | 'unknown'; reason?: string }): void {
    const held = this.building(event.rootRequestId);
    const key = this.physicalKey(event.physicalTarget);
    held.targetToPhysical.set(event.targetId, key);
    const captures = held.byPhysical.get(key) ?? [];
    if (captures.some((capture) => capture.targetId === event.targetId)) return;
    const order = this.byFile.get(key) ?? [];
    order.push({ rootRequestId: event.rootRequestId, targetId: event.targetId, order: ++this.sequence });
    this.byFile.set(key, order);
    captures.push({ targetId: event.targetId, displayPath: event.displayPath, physicalTarget: event.physicalTarget, before: event.before,
      coverage: event.coverage, ...(event.reason ? { reason: event.reason } : {}) });
    held.byPhysical.set(key, captures);
  }

  settle(event: { rootRequestId: string; targetId: string; outcome: 'committed' | 'not-committed' | 'uncertain'; after?: HistoryFileState }): void {
    const held = this.requests.get(event.rootRequestId);
    const key = held?.targetToPhysical.get(event.targetId);
    const capture = key ? held!.byPhysical.get(key)?.find((entry) => entry.targetId === event.targetId) : undefined;
    if (!held || !capture || capture.outcome) return;
    capture.outcome = event.outcome;
    if (event.outcome === 'not-committed') held.notMade.add(event.targetId);
    if (event.outcome === 'committed' && event.after) capture.after = event.after;
  }

  uncovered(event: { rootRequestId: string; effect: UncoveredEffectKind; path?: string; reason: string; physicalKey?: string }): void {
    const held = this.building(event.rootRequestId);
    const at = held.notReversed.findIndex((entry) => entry.effect === event.effect && entry.path === event.path);
    if (at >= 0) {
      if (event.physicalKey && !held.nativeKeys.has(at)) held.nativeKeys.set(at, this.physicalKey(event.physicalKey));
      return;
    }
    if (event.physicalKey) held.nativeKeys.set(held.notReversed.length, this.physicalKey(event.physicalKey));
    held.notReversed.push({ effect: event.effect, ...(event.path ? { path: event.path } : {}), reason: event.reason });
  }

  has(rootRequestId: string): boolean {
    return this.requests.has(rootRequestId);
  }

  /** Every capture of one physical file, in history order; captures whose change was not made are left out. */
  capturesOf(physicalTarget: string): CaptureInOrder[] {
    const key = this.physicalKey(physicalTarget);
    return (this.byFile.get(key) ?? []).filter((capture) => !this.requests.get(capture.rootRequestId)?.notMade.has(capture.targetId))
      .map((capture) => ({ ...capture }));
  }

  key(physicalTarget: string): string {
    return this.physicalKey(physicalTarget);
  }

  manifest(rootRequestId: string): RecoveryManifestV1 | undefined {
    const held = this.requests.get(rootRequestId);
    if (!held) return undefined;
    const files: RecoveryFileV1[] = [];
    /** Files whose before state this request kept exactly: a provider's own change of one was captured. */
    const exactlyKept = new Set<string>();
    for (const [key, captures] of held.byPhysical) {
      // Only changes that were made, or may have been, count. A file whose every attempt was proven not made was not
      // changed; an attempt proven not made never supplies the before state or its restore point.
      const effective = captures.filter((capture) => capture.outcome !== 'not-committed');
      if (effective.length === 0) continue;
      const first = effective[0];
      if (first.coverage === 'exact') exactlyKept.add(key);
      const last = effective[effective.length - 1];
      const uncertain = effective.some((capture) => capture.outcome === 'uncertain');
      const lastAfter = last.outcome === 'committed' ? last.after : undefined;
      const coverage: 'exact' | 'unknown' = first.coverage === 'exact' && !uncertain && !!lastAfter ? 'exact' : 'unknown';
      const reason = first.coverage !== 'exact' ? first.reason
        : uncertain ? 'a change could not be read back, so what the file holds now is not known'
          : !lastAfter ? 'the last change has not been confirmed' : undefined;
      files.push({
        targetId: first.targetId, displayPath: first.displayPath, physicalTarget: first.physicalTarget,
        before: { ...first.before }, ...(lastAfter ? { after: { ...lastAfter } } : {}), coverage, ...(reason ? { reason } : {}),
        effectRefs: effective.map((capture) => capture.targetId),
      });
    }
    // A provider's own change that passed through UnodeAi first has its exact restore point above. It is not also
    // listed as having none, whichever of the two the history took in first.
    const notReversed = held.notReversed.filter((entry, index) => {
      const key = entry.effect === 'native-tool' ? held.nativeKeys.get(index) : undefined;
      return !(key !== undefined && exactlyKept.has(key));
    }).map((entry) => ({ ...entry }));
    return { rootRequestId, files, notReversed, label: recoveryLabel(files, notReversed) };
  }
}

/** A file is revertible when its before state is kept exactly and its last change was read back. */
export function fileRevertible(file: RecoveryFileV1): boolean {
  if (file.coverage !== 'exact' || !file.after) return false;
  return file.before.kind === 'absent' || file.before.payloadRef !== undefined;
}

export function recoveryLabel(files: readonly RecoveryFileV1[], notReversed: readonly RecoveryUncoveredV1[]): RecoveryLabel {
  if (files.length === 0 && notReversed.length === 0) return 'No recorded file changes';
  const revertible = files.filter(fileRevertible).length;
  if (revertible === 0) return 'Not revertible';
  return revertible === files.length && notReversed.length === 0 ? 'Revertible' : 'Partly revertible';
}
