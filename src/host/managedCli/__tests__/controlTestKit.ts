// Shared by the control store's tests and its process fixture: ids, version keys, the changes the facade will make,
// and direct writers for setting up states (the fill to the seal, a generation at a chosen epoch).

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import type { ControlChange, ControlContent, ControlRecord, DisabledReason } from '../contracts';
import { FLOOR_RECORD_BYTES, FLOOR_REGION_A, FLOOR_REGION_B, floorRecord } from '../controlFloor';
import { controlJournalSpec } from '../controlStore';
import { publishGeneration, readJournal } from '../generationJournal';
import { cliStoreRoots } from '../storeLayout';

export const A = 'a1'.repeat(16);
export const B = 'b2'.repeat(16);
export const T = '2026-10-21T08:00:00.000Z';
export const D1 = 'd1'.repeat(32);
export const D2 = 'd2'.repeat(32);

/** A version key as `cliStoreVersionKey` names one. */
export function key(version: string, digest = '0123456789abcdef'): string {
  return `${version}-win32-x64-${digest}`;
}

export const K1 = key('0.163.0');
export const K2 = key('0.164.0');

type Edit = (current: ControlRecord) => ControlContent | { moot: true } | { refused: string };

export function change(kind: 'increase' | 'reduction', label: string, apply: Edit, extra: Partial<ControlChange> = {}): ControlChange {
  return { kind, label, apply, ...extra };
}

/** `(null, external)` → `(storeId, managed)`, one consented host. */
export function enrol(storeId = A): ControlChange {
  return change('increase', 'enrol', (current) => current.enrolledStoreId !== null ? { refused: 'already enrolled' } : {
    ...current, enrolledStoreId: storeId, selection: 'managed',
    enrollment: { epoch: 0, consentedHosts: ['releases.openai.com'], decidedAt: T }, decidedAt: T,
  });
}

export function selectExternal(extra: Partial<ControlChange> = {}): ControlChange {
  return change('reduction', 'use external CLI', (current) => current.selection === 'external' ? { moot: true } : { ...current, selection: 'external', decidedAt: T }, extra);
}

export function selectManaged(): ControlChange {
  return change('increase', 'use managed Codex', (current) => current.selection === 'managed' ? { moot: true } : { ...current, selection: 'managed', decidedAt: T });
}

export function consent(versionKey: string, digest = D1): ControlChange {
  return change('increase', 'activation consent', (current) => current.enrolledStoreId === null ? { refused: 'not enrolled' } : {
    ...current, activationConsents: [...current.activationConsents, { storeId: current.enrolledStoreId, key: versionKey, closureDigest: digest, decidedAt: T }],
    decidedAt: T,
  });
}

/** An increase that activates `versionKey`, refused when control disables it. */
export function activate(versionKey: string): ControlChange {
  return change('increase', 'activate', (current) => {
    if (current.enrolledStoreId === null) return { refused: 'not enrolled' };
    if (current.disabled.some((entry) => entry.storeId === current.enrolledStoreId && entry.key === versionKey)) return { refused: 'disabled' };
    if (current.active?.key === versionKey) return { moot: true };
    return { ...current, active: { storeId: current.enrolledStoreId, key: versionKey }, decidedAt: T };
  });
}

export function disable(versionKey: string, reason: DisabledReason, extra: Partial<ControlChange> = {}): ControlChange {
  return change('reduction', `disable (${reason})`, (current) => current.enrolledStoreId === null ? { refused: 'not enrolled' } : {
    ...current,
    disabled: [...current.disabled, { storeId: current.enrolledStoreId, key: versionKey, closureDigest: D1, reason, at: T }],
    decidedAt: T,
  }, extra);
}

/** The user's re-decision that removes only the matching entry, after its positive facts were published. */
export function undisable(versionKey: string, reason: DisabledReason, kind: 'increase' | 'reduction' = 'reduction'): ControlChange {
  return change(kind, `re-decide (${reason})`, (current) => ({
    ...current,
    disabled: current.disabled.filter((entry) => !(entry.storeId === current.enrolledStoreId && entry.key === versionKey && entry.reason === reason)),
    decidedAt: T,
  }));
}

/** A reduction that changes nothing but its time: enough to take an epoch. */
export function touch(label = 'touch'): ControlChange {
  return change('reduction', label, (current) => ({ ...current, decidedAt: new Date().toISOString() }));
}

/** Writes floor records 1..upTo into both regions directly, with one flush (fine for setting up a fill). */
export function fillFloorTo(root: string, controlId: string, upTo: number): void {
  const fd = openSync(cliStoreRoots(root).floor, 'r+');
  try {
    for (let epoch = 1; epoch <= upTo; epoch++) {
      const record = floorRecord(controlId, epoch);
      writeSync(fd, record, 0, FLOOR_RECORD_BYTES, FLOOR_REGION_A + epoch * FLOOR_RECORD_BYTES);
      writeSync(fd, record, 0, FLOOR_RECORD_BYTES, FLOOR_REGION_B + epoch * FLOOR_RECORD_BYTES);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Publishes the next generation directly, at a chosen epoch (setup only; the product never does this). */
export function publishAtEpoch(root: string, reductionEpoch: number, sealed = false): void {
  const spec = controlJournalSpec(root);
  const current = readJournal(spec);
  if (current.kind !== 'ok') throw new Error(`setup: control is ${current.kind}`);
  const { generation: _g, previousRecordDigest: _p, sealed: _s, ...content } = current.record;
  const result = publishGeneration(spec, current, { ...content, reductionEpoch, ...(sealed ? { sealed: true as const } : {}), decidedAt: T });
  if (result.outcome !== 'published') throw new Error('setup: lost');
}

export function generationFiles(root: string): string[] {
  try {
    return readdirSync(cliStoreRoots(root).controlManifests).filter((name) => name.startsWith('control-')).sort();
  } catch {
    return [];
  }
}

/** Every folder and file below `folder`, each file by the SHA-256 of its bytes, to prove that nothing changed. */
export function tree(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) { out[`${path.relative(folder, full)}/`] = 'dir'; walk(full); } else out[path.relative(folder, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(folder);
  return out;
}
