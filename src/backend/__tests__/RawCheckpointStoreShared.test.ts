import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RawCheckpointStore, type RawCheckpointStoreOptions } from '../RawCheckpointStore';
import { GenerationLease } from '../../history/GenerationLease';
import type { ProcessIdentityAdapter, ProcessLiveness } from '../../host/processIdentity/ProcessIdentityHost';

/**
 * v0.9.110 R1 (raw-v2): two windows share one workspace's restore points. Neither drops what the other pinned, neither
 * removes what the other is writing, and only a host proven gone loses its pins.
 */
let dir: string;
let files: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-raw-v2-'));
  files = path.join(dir, 'workspace');
  await fsp.mkdir(files, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const liveness = new Map<number, ProcessLiveness>();
const identity: ProcessIdentityAdapter = {
  platform: 'linux',
  self: async () => 'unknown',
  identityOf: async () => 'unknown',
  liveness: async (records) => records.map((record) => liveness.get(record.pid) ?? 'unknown'),
};

function window(host: string, pid: number, extra: Partial<RawCheckpointStoreOptions> & { gone?: Set<string> } = {}) {
  const lease = new GenerationLease(path.join(dir, 'raw-v2', 'lock'), {
    hostInstanceId: host,
    selfIdentity: async () => ({ pid, startToken: String(pid), bootToken: 'boot', platform: 'linux' }),
    identity,
  });
  return RawCheckpointStore.open({
    directory: path.join(dir, 'raw-v2'),
    workspaceId: 'w',
    coordination: { lease, hostInstanceId: host, waitMs: 500, hostsGone: async (ids) => new Set(ids.filter((id) => extra.gone?.has(id))) },
    ...extra,
  });
}

async function capture(store: RawCheckpointStore, name: string, bytes: string) {
  const result = await store.capture({ agentId: 'dev', path: name, target: path.join(files, name), bytes: Buffer.from(bytes) });
  expect(result.status).toBe('captured');
  return result as Extract<typeof result, { status: 'captured' }>;
}

describe('RawCheckpointStore shared by windows (raw-v2)', () => {
  beforeEach(() => {
    liveness.clear();
    liveness.set(1, 'alive');
    liveness.set(2, 'alive');
  });

  it('keeps entries the other window wrote, and never drops one it pinned to make room', async () => {
    const limits = { maxEntries: 2 };
    const { store: a } = await window('host-a', 1, { limits });
    const { store: b } = await window('host-b', 2, { limits });
    const kept = await capture(a, 'a.txt', 'A before');
    // B has room for one more entry; to make room for a second it may only drop an entry nobody pinned.
    const first = await capture(b, 'b1.txt', 'B1 before');
    first.pin.release();
    await b.idle();
    const second = await capture(b, 'b2.txt', 'B2 before');
    expect(second.entry.id).not.toBe(kept.entry.id);
    await a.idle();
    await b.idle();
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'raw-v2', 'index.json'), 'utf8')) as { entries: Array<{ id: string }> };
    expect(index.entries.map((entry) => entry.id)).toContain(kept.entry.id);
    expect(index.entries.map((entry) => entry.id)).not.toContain(first.entry.id);
    expect((await a.readBefore(kept.entry.id))).toEqual({ status: 'read', bytes: Buffer.from('A before') });
    // A third capture in B finds every entry pinned: it is refused, nothing is removed.
    const refused = await b.capture({ agentId: 'dev', path: 'b3.txt', target: path.join(files, 'b3.txt'), bytes: Buffer.from('x') });
    expect(refused.status).toBe('refused');
    expect((await a.readBefore(kept.entry.id)).status).toBe('read');
  });

  it('does not remove what another window wrote when it opens and reconciles', async () => {
    const { store: a } = await window('host-a', 1);
    const kept = await capture(a, 'a.txt', 'A');
    kept.pin.release();
    await a.idle();
    const { store: b, reconciliation } = await window('host-b', 2);
    expect(reconciliation).toMatchObject({ removedOrphans: 0, droppedMissing: 0 });
    expect((await b.readBefore(kept.entry.id))).toEqual({ status: 'read', bytes: Buffer.from('A') });
    const later = await capture(a, 'later.txt', 'later');
    await a.idle();
    // B reads the index again at its next change and sees A's newer entry.
    await capture(b, 'b.txt', 'B');
    expect(b.get(later.entry.id)?.path).toBe('later.txt');
  });

  it('drops only the pins of a host proven gone', async () => {
    const { store: crashed } = await window('host-crashed', 3);
    const pinned = await capture(crashed, 'c.txt', 'crashed held this');
    // The host dies without releasing; its pin is in the index.
    const alive = await window('host-b', 2, { limits: { maxEntries: 1 } });
    expect(alive.store.isPinned(pinned.entry.id)).toBe(true);
    expect((await alive.store.capture({ agentId: 'dev', path: 'x', target: path.join(files, 'x'), bytes: Buffer.from('x') })).status).toBe('refused');
    // A live window holds a pin of its own as well.
    const live = await window('host-live', 5);
    const livePinned = await capture(live.store, 'l.txt', 'live window holds this');
    await live.store.idle();
    // Once the crashed host is proven gone, a window that opens drops its pins, and only its pins.
    const after = await window('host-c', 4, { limits: { maxEntries: 2 }, gone: new Set(['host-crashed']) });
    expect(after.store.isPinned(pinned.entry.id)).toBe(false);
    expect(after.store.isPinned(livePinned.entry.id)).toBe(true);
    expect((await after.store.capture({ agentId: 'dev', path: 'y', target: path.join(files, 'y'), bytes: Buffer.from('y') })).status).toBe('captured');
    expect((await after.store.readBefore(livePinned.entry.id))).toEqual({ status: 'read', bytes: Buffer.from('live window holds this') });
  });

  it('copies the restore points records still name from raw-v1, verified, under the same ids, and leaves raw-v1 as it was', async () => {
    const v1Dir = path.join(dir, 'raw-v1');
    const { store: v1 } = await RawCheckpointStore.open({ directory: v1Dir, workspaceId: 'v1-id' });
    const good = await v1.capture({ agentId: 'dev', path: 'good.txt', target: path.join(files, 'good.txt'), bytes: Buffer.from('good bytes') });
    const bad = await v1.capture({ agentId: 'dev', path: 'bad.txt', target: path.join(files, 'bad.txt'), bytes: Buffer.from('bad bytes') });
    const absent = await v1.capture({ agentId: 'dev', path: 'new.txt', target: path.join(files, 'new.txt'), bytes: null });
    expect([good.status, bad.status, absent.status]).toEqual(['captured', 'captured', 'captured']);
    const ids = [good, bad, absent].map((result) => (result as Extract<typeof result, { status: 'captured' }>).entry.id);
    // One payload no longer matches what its entry recorded.
    fs.writeFileSync(path.join(v1Dir, 'payloads', `${ids[1]}.bin`), 'tampered');
    const v1Index = fs.readFileSync(path.join(v1Dir, 'index.json'), 'utf8');
    const { store: v2 } = await window('host-a', 1);
    const imported = await v2.importLegacyEntries({ directory: v1Dir, workspaceId: 'v1-id' }, [...ids, 'f'.repeat(32)]);
    expect(imported.sort()).toEqual([ids[0], ids[2]].sort());
    expect(await v2.readBefore(ids[0])).toEqual({ status: 'read', bytes: Buffer.from('good bytes') });
    expect(await v2.readBefore(ids[2])).toEqual({ status: 'absent' });
    expect(v2.get(ids[1])).toBeUndefined();
    expect(fs.readFileSync(path.join(v1Dir, 'index.json'), 'utf8')).toBe(v1Index);
    // Importing again changes nothing.
    expect(await v2.importLegacyEntries({ directory: v1Dir, workspaceId: 'v1-id' }, ids)).toEqual([]);
  });

  it('refuses a capture when another window holds the store past the wait, and changes nothing', async () => {
    const { store: b } = await window('host-b', 2);
    const holder = new GenerationLease(path.join(dir, 'raw-v2', 'lock'), {
      hostInstanceId: 'host-a', selfIdentity: async () => ({ pid: 1, startToken: '1', bootToken: 'boot', platform: 'linux' }), identity,
    });
    const held = await holder.tryAcquire('test');
    expect(held.status).toBe('held');
    const refused = await b.capture({ agentId: 'dev', path: 'b.txt', target: path.join(files, 'b.txt'), bytes: Buffer.from('b') });
    expect(refused).toMatchObject({ status: 'refused', code: 'unavailable' });
    expect(fs.existsSync(path.join(dir, 'raw-v2', 'payloads')) ? fs.readdirSync(path.join(dir, 'raw-v2', 'payloads')) : []).toEqual([]);
    if (held.status === 'held') await held.lease.release();
    expect((await b.capture({ agentId: 'dev', path: 'b.txt', target: path.join(files, 'b.txt'), bytes: Buffer.from('b') })).status).toBe('captured');
  });
});
