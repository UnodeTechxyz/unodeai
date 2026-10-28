import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
import { PersistenceManager } from '../PersistenceManager';
import { DelegationResultBodyStore } from '../DelegationResultBodyStore';
import { RESULT_MAILBOX_INDEX_KEY, resultMailboxItemKey } from '../ResultMailboxMetadata';
import { resultMailboxKey, type ResultMailboxEntry } from '../DelegationResultMailbox';
import { workspaceRootIdentity } from '../WorkspaceRootIdentity';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const testRoot = path.join(process.cwd(), '.audit-repro', 'mailbox-persistence'); const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) {
  if (path.dirname(dir) !== testRoot || !path.basename(dir).startsWith('result-')) throw new Error('Unsafe test cleanup');
  await fs.rm(dir, { force: true, recursive: true });
} });
function entry(n = 0, text = 'private worker result'): ResultMailboxEntry {
  return { coordinatorId: 'pm', ref: { handle: `handle-${n}`, revision: 1 }, attemptId: `attempt-${n}`, settledEventId: `completion-${n}`,
    state: 'ready', delivery: 'pending', body: { text, bytes: Buffer.byteLength(text), sourceBytes: Buffer.byteLength(text), sourceDigest: sha(text),
      truncated: false, location: { conversationId: `worker-${n}`, messageId: `turn-${n}` } } };
}
async function fixture() {
  await fs.mkdir(testRoot, { recursive: true }); const dir = await fs.mkdtemp(path.join(testRoot, 'result-')); dirs.push(dir);
  const values = new Map<string, unknown>(); const calls: Array<{ key: string; bytes: number; value: unknown }> = [];
  let intercept: ((key: string, value: unknown) => Promise<void>) | undefined; let current = true;
  const assertCurrent = () => { if (!current) throw new Error('old lease'); };
  const context = { workspaceState: { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, keys: () => [...values.keys()],
    update: async (key: string, value: unknown) => { await intercept?.(key, value); calls.push({ key, bytes: Buffer.byteLength(JSON.stringify(value) ?? ''), value });
      if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); } } };
  const persistence = new PersistenceManager(context as never, undefined, () => dir);
  const reservations = new Set<string>(); const workspaceId = workspaceRootIdentity(dir);
  const store = await DelegationResultBodyStore.open({ storageUri: { scheme: 'file', fsPath: dir }, workspaceId, assertCurrent,
    reservations: () => [...reservations] });
  return { values, calls, context, persistence, reservations, store, assertCurrent, stale: () => { current = false; },
    intercept: (callback: typeof intercept) => { intercept = callback; },
    bodyPath: (value: ResultMailboxEntry) => path.join(dir, 'delegation-results-v1', workspaceId, `${resultMailboxKey(value.coordinatorId, value.ref)}.body`) };
}
describe('T2b body-before-small-index persistence (consumer activation separately audited)', () => {
  it('near 8 MiB, actual PersistenceManager calls contain only small metadata and the bounded key index', async () => {
    const h = await fixture(); let ticks = 0; const timer = setInterval(() => ticks++, 1); const began = performance.now();
    try {
      for (let n = 0; n < 128; n++) {
        const value = entry(n, 'x'.repeat(65536)); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
        expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toBeDefined(); h.reservations.delete(key);
      }
      expect((await h.store.usage()).physicalBytes).toBe(8 * 1024 * 1024); expect(h.persistence.loadResultMailboxIndex()).toHaveLength(128);
      const items = h.calls.filter(call => call.key !== RESULT_MAILBOX_INDEX_KEY); const indexes = h.calls.filter(call => call.key === RESULT_MAILBOX_INDEX_KEY);
      expect(Math.max(...items.map(call => call.bytes))).toBeLessThanOrEqual(2048);
      expect(Math.max(...indexes.map(call => call.bytes))).toBeLessThan(20_000); expect(ticks).toBeGreaterThan(0);
      console.info('[mailbox-persistence-8MiB]', JSON.stringify({ node: process.version, elapsedMs: Math.round(performance.now() - began), ticks,
        bodyFileBytes: (await h.store.usage()).physicalBytes, largestItemApiBytes: Math.max(...items.map(call => call.bytes)),
        largestIndexApiBytes: Math.max(...indexes.map(call => call.bytes)), limitation: 'Real PersistenceManager/body files; measured Memento API payloads, not SQLite writes or power-loss durability.' }));
    } finally { clearInterval(timer); }
  }, 60000);
  it('verifies the body on disk before either metadata or index is acknowledged; metadata has no prose', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    h.intercept(async () => { expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text); });
    const saved = await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent);
    expect(saved?.key).toBe(key); expect(h.calls.map(call => call.key)).toEqual([resultMailboxItemKey(key), RESULT_MAILBOX_INDEX_KEY]);
    expect(JSON.stringify(h.calls)).not.toContain(value.body!.text); expect(Math.max(...h.calls.map(call => call.bytes))).toBeLessThan(2048);
    expect(await h.persistence.readResultMailboxEntry(key, h.store, h.assertCurrent)).toEqual(value);
  });
  it.each(['body', 'item', 'index'] as const)('a %s failure never acknowledges an unusable ready index', async failure => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref);
    if (failure !== 'body') h.reservations.add(key);
    h.intercept(async name => { if (failure === 'item' && name === resultMailboxItemKey(key) || failure === 'index' && name === RESULT_MAILBOX_INDEX_KEY) throw new Error('write failed'); });
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toBeUndefined();
    expect(h.values.get(RESULT_MAILBOX_INDEX_KEY)).toBeUndefined();
    if (failure !== 'body') expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text);
  });
  it('serializes concurrent index additions and updates delivery without rewriting or deleting body files', async () => {
    const h = await fixture(); const first = entry(1); const second = entry(2);
    for (const value of [first, second]) h.reservations.add(resultMailboxKey('pm', value.ref));
    const saved = await Promise.all([first, second].map(value => h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)));
    expect(saved.every(Boolean)).toBe(true); expect(h.persistence.loadResultMailboxIndex()).toHaveLength(2);
    const before = await fs.stat(h.bodyPath(first)); first.delivery = 'delivered'; first.deliveredVia = 'collect-ready';
    expect(await h.persistence.saveResultMailboxEntry(first, h.store, h.assertCurrent)).toBeDefined();
    expect((await fs.stat(h.bodyPath(first))).mtimeMs).toBe(before.mtimeMs);
    expect((await h.persistence.readResultMailboxEntry(saved[0]!.key, h.store, h.assertCurrent))?.delivery).toBe('delivered');
  });
  it('same-key conflicting completion bytes preserve the original file and metadata', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    const saved = await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent); const metadata = structuredClone(h.values.get(resultMailboxItemKey(key)));
    expect(await h.persistence.saveResultMailboxEntry(entry(0, 'different result'), h.store, h.assertCurrent)).toBeUndefined();
    expect(h.values.get(resultMailboxItemKey(key))).toEqual(metadata); expect(await h.store.read(saved!.body!.file)).toBe(value.body!.text);
  });
  it('never changes a delivered result back to pending on a later identical save', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    const delivered = { ...value, delivery: 'delivered' as const, deliveredVia: 'auto-wake' as const };
    expect(await h.persistence.saveResultMailboxEntry(delivered, h.store, h.assertCurrent)).toBeDefined();
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toMatchObject({ delivery: 'delivered', deliveredVia: 'auto-wake' });
    expect(await h.persistence.readResultMailboxEntry(key, h.store, h.assertCurrent)).toEqual(delivered);
  });
  it('does not overwrite a corrupt previous item, even with the same valid incoming body', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    const saved = await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent);
    const corrupt = { ...saved, attemptId: null }; h.values.set(resultMailboxItemKey(key), corrupt);
    const before = h.calls.length;
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toBeUndefined();
    expect(h.calls).toHaveLength(before); expect(h.values.get(resultMailboxItemKey(key))).toEqual(corrupt);
    expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text);
  });
  it('keeps a recorded conflict sticky when the exact original body is saved again', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    expect(await h.persistence.saveResultMailboxEntry({ ...value, conflict: true }, h.store, h.assertCurrent)).toMatchObject({ conflict: true });
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toMatchObject({ conflict: true });
    expect(await h.persistence.readResultMailboxEntry(key, h.store, h.assertCurrent)).toMatchObject({ conflict: true });
  });
  it('does not archive for another conversation or message even when ref and digest match', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent);
    const before = h.calls.length;
    for (const location of [
      { ...value.body!.location!, conversationId: 'other-conversation' },
      { ...value.body!.location!, messageId: 'other-message' },
    ]) {
      expect(await h.persistence.archiveResultMailboxEntry(key, {
        coordinatorId: 'pm', ref: value.ref, sourceDigest: value.body!.sourceDigest, location,
      }, h.assertCurrent)).toBe(false);
      expect(h.persistence.loadResultMailboxIndex()).toContain(key);
    }
    expect(h.calls).toHaveLength(before); expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text);
  });
  it('an index acknowledgement is not a disk durability claim and never authorizes body deletion', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toBeDefined();
    // Crash drops unflushed Memento cache; the file is still retained and charged, not guessed to be delivered.
    h.values.clear(); expect(h.persistence.loadResultMailboxIndex()).toEqual([]);
    expect(await h.persistence.readResultMailboxEntry(key, h.store, h.assertCurrent)).toBeUndefined();
    expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text); expect((await h.store.usage()).physicalSlots).toBe(1);
  });
  it('a stale lease does not acknowledge new metadata or retire the old source', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key); h.stale();
    expect(await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent)).toBeUndefined(); expect(h.calls).toEqual([]);
  });
  it('active metadata is released only for the exact archive receipt, while the physical body remains charged', async () => {
    const h = await fixture(); const value = entry(); const key = resultMailboxKey('pm', value.ref); h.reservations.add(key);
    await h.persistence.saveResultMailboxEntry(value, h.store, h.assertCurrent); h.reservations.delete(key);
    expect(await h.persistence.archiveResultMailboxEntry(key, undefined, h.assertCurrent)).toBe(false);
    expect(h.persistence.loadResultMailboxIndex()).toContain(key);
    const receipt = { coordinatorId: 'pm', ref: value.ref, location: value.body!.location, sourceDigest: value.body!.sourceDigest };
    expect(await h.persistence.archiveResultMailboxEntry(key, { ...receipt, sourceDigest: sha('other result') }, h.assertCurrent)).toBe(false);
    expect(await h.persistence.archiveResultMailboxEntry(key, receipt, h.assertCurrent)).toBe(true);
    expect(h.persistence.loadResultMailboxIndex()).toEqual([]); expect(h.values.has(resultMailboxItemKey(key))).toBe(false);
    expect(await fs.readFile(h.bodyPath(value), 'utf8')).toBe(value.body!.text); expect((await h.store.usage()).physicalSlots).toBe(1);
  });
  it('a legacy save arriving during retirement shares the lane and cannot be erased by the awaited retirement', async () => {
    const h = await fixture(); const value = entry(); const legacy = [{ coordinatorId: 'pm', handle: value.ref.handle, ref: 'worker', text: value.body!.text }];
    await h.persistence.savePendingDelegationResults(legacy); h.reservations.add(resultMailboxKey('pm', value.ref));
    let reached!: () => void; const atRetirement = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    h.intercept(async (name, data) => { if (name === 'roam.pendingDelegationResults' && data === undefined) { reached(); await hold; } });
    const migrating = h.persistence.migratePendingResultMailbox(h.store, () => value, h.assertCurrent); await atRetirement;
    const next = [...legacy, { ...legacy[0], handle: 'arrived-later' }]; const saving = h.persistence.savePendingDelegationResults(next);
    await new Promise(resolve => setTimeout(resolve, 0)); release(); await migrating; await saving;
    expect(h.persistence.loadPendingDelegationResults()).toEqual(next);
  });
  it('migrates only exact ledger-proven entries, and retires the unchanged old array only after every index ack', async () => {
    const h = await fixture(); const values = [entry(1), entry(2)];
    const legacy = values.map(value => ({ coordinatorId: 'pm', handle: value.ref.handle, ref: 'worker', text: value.body!.text }));
    await h.persistence.savePendingDelegationResults(legacy); for (const value of values) h.reservations.add(resultMailboxKey('pm', value.ref));
    expect(await h.persistence.migratePendingResultMailbox(h.store, row => values.find(value => value.ref.handle === row.handle), h.assertCurrent)).toEqual({ migrated: 2, retired: true });
    expect(h.persistence.loadPendingDelegationResults()).toEqual([]); expect(h.persistence.loadResultMailboxIndex()).toHaveLength(2);
    expect(h.calls.at(-1)?.key).toBe('roam.pendingDelegationResults'); expect(h.calls.at(-1)?.value).toBeUndefined();
  });
  it('an interrupted migration retains the old array and retries the already-published body idempotently', async () => {
    const h = await fixture(); const values = [entry(1), entry(2)]; const legacy = values.map(value => ({ coordinatorId: 'pm', handle: value.ref.handle, ref: 'worker', text: value.body!.text }));
    await h.persistence.savePendingDelegationResults(legacy); for (const value of values) h.reservations.add(resultMailboxKey('pm', value.ref));
    h.intercept(async name => { if (name === resultMailboxItemKey(resultMailboxKey('pm', values[1].ref))) throw new Error('interrupted'); });
    expect((await h.persistence.migratePendingResultMailbox(h.store, row => values.find(value => value.ref.handle === row.handle), h.assertCurrent)).retired).toBe(false);
    expect(h.persistence.loadPendingDelegationResults()).toEqual(legacy);
    h.intercept(undefined); expect((await h.persistence.migratePendingResultMailbox(h.store, row => values.find(value => value.ref.handle === row.handle), h.assertCurrent)).retired).toBe(true);
    expect((await h.store.usage()).physicalSlots).toBe(2);
  });
  it('unknown legacy identities and a source changed during migration are never silently retired', async () => {
    const h = await fixture(); const value = entry(); const legacy = [{ coordinatorId: 'pm', handle: value.ref.handle, ref: 'worker', text: value.body!.text }];
    await h.persistence.savePendingDelegationResults(legacy); h.reservations.add(resultMailboxKey('pm', value.ref));
    expect((await h.persistence.migratePendingResultMailbox(h.store, () => undefined, h.assertCurrent)).retired).toBe(false);
    h.intercept(async name => { if (name === RESULT_MAILBOX_INDEX_KEY) h.values.set('roam.pendingDelegationResults', [...legacy, { ...legacy[0], handle: 'late' }]); });
    expect((await h.persistence.migratePendingResultMailbox(h.store, () => value, h.assertCurrent)).retired).toBe(false);
    expect(h.persistence.loadPendingDelegationResults()).toHaveLength(2);
  });
});
