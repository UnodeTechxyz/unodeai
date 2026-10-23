import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../Checkpoints';
import { RawCheckpointStore, type RawCheckpointStoreOptions } from '../RawCheckpointStore';

/**
 * The out-of-line raw-byte restore points (CHANGELOG [Unreleased]; design limits: 32 MiB each, 256 MiB and 30 days
 * per workspace, 200 entries together with the text records). Each case names the rule it holds.
 */
const temps: string[] = [];
async function folder(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-raw-cp-')));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

async function open(directory: string, over: Partial<RawCheckpointStoreOptions> = {}) {
  return RawCheckpointStore.open({ directory, workspaceId: 'ws-a', ...over });
}

function input(bytes: Buffer | null, name = 'a.bin') {
  return { agentId: 'dev', path: name, target: path.resolve('/ws', name), bytes };
}

async function names(dir: string): Promise<string[]> {
  return fs.readdir(dir).then((list) => list.sort(), () => []);
}

/** Every file below `dir` with its bytes, to show that something was not touched. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = sha(await fs.readFile(full));
    }
  };
  await walk(dir);
  return out;
}

describe('RawCheckpointStore', () => {
  it('keeps the exact bytes out of line, and only bounded metadata in its index', async () => {
    const dir = await folder();
    const { store } = await open(dir);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x0d, 0x0a, 0xc3]);

    const captured = await store.capture(input(bytes));

    expect(captured.status).toBe('captured');
    const entry = (captured as any).entry;
    expect(entry.before).toEqual({ exists: true, size: bytes.length, sha256: sha(bytes) });
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes });
    expect(await names(path.join(dir, 'payloads'))).toEqual([`${entry.id}.bin`]);
    expect(await fs.readFile(path.join(dir, 'index.json'), 'utf8')).not.toContain(bytes.toString('base64'));
    expect(store.isPinned(entry.id)).toBe(true);
  });

  it('keeps a restore point of a file that did not exist without a payload', async () => {
    const dir = await folder();
    const { store } = await open(dir);

    const captured = await store.capture(input(null));

    expect(await store.readBefore((captured as any).entry.id)).toEqual({ status: 'absent' });
    expect(await names(path.join(dir, 'payloads'))).toEqual([]);
  });

  it('refuses a file over the per-payload limit and keeps nothing of it', async () => {
    const dir = await folder();
    const { store } = await open(dir, { limits: { maxPayloadBytes: 4 } });

    const captured = await store.capture(input(Buffer.from('12345')));

    expect(captured).toMatchObject({ status: 'refused', reason: expect.stringContaining('larger than') });
    expect(store.list()).toEqual([]);
    expect(await names(path.join(dir, 'staging'))).toEqual([]);
  });

  it('makes room under the workspace byte limit by dropping its oldest entry not in use', async () => {
    const dir = await folder();
    let now = 1000;
    const { store } = await open(dir, { limits: { maxTotalBytes: 10 }, now: () => now++ });
    const first = await store.capture(input(Buffer.from('aaaaaa'), 'first'));
    (first as any).pin.release();

    const second = await store.capture(input(Buffer.from('bbbbbb'), 'second'));

    expect(second.status).toBe('captured');
    expect(store.list().map((entry) => entry.path)).toEqual(['second']);
    expect(await names(path.join(dir, 'payloads'))).toEqual([`${(second as any).entry.id}.bin`]);
  });

  it('refuses, and removes nothing, when only an entry in use could make room', async () => {
    const dir = await folder();
    const { store } = await open(dir, { limits: { maxTotalBytes: 10 } });
    const held = await store.capture(input(Buffer.from('aaaaaa'), 'held'));
    const before = await snapshot(dir);

    const refused = await store.capture(input(Buffer.from('bbbbbb'), 'refused'));

    expect(refused).toMatchObject({ status: 'refused', reason: expect.stringContaining('still in use') });
    expect(store.list().map((entry) => entry.path)).toEqual(['held']);
    expect(await store.readBefore((held as any).entry.id)).toEqual({ status: 'read', bytes: Buffer.from('aaaaaa') });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('refuses at the entry limit when every entry is in use', async () => {
    const dir = await folder();
    const { store } = await open(dir, { limits: { maxEntries: 2 } });
    await store.capture(input(Buffer.from('a'), 'one'));
    await store.capture(input(Buffer.from('b'), 'two'));

    const refused = await store.capture(input(Buffer.from('c'), 'three'));

    expect(refused).toMatchObject({ status: 'refused', reason: expect.stringContaining('restore points') });
    expect(store.count()).toBe(2);
  });

  const textRecord = (text: CheckpointStore, before: string, after: string) => text.record({
    agentId: 'dev', agentName: 'Dev', path: 't.txt', target: path.resolve('/ws/t.txt'), operation: 'write', before, after,
  });

  it('shares one entry limit with the text records: a capture drops the oldest entry of either kind', async () => {
    const dir = await folder();
    let now = Date.now() + 1_000_000; // these raw entries are newer than the text records
    const { store } = await open(dir, { limits: { maxEntries: 3 }, now: () => now++ });
    const text = new CheckpointStore(3);
    text.attachPeer(store);
    store.attachPeer(text);
    textRecord(text, 't0', 't1');
    textRecord(text, 't1', 't2');
    const first = await store.capture(input(Buffer.from('r1'), 'r1'));
    (first as any).pin.release();
    expect(text.count() + store.count()).toBe(3);

    const second = await store.capture(input(Buffer.from('r2'), 'r2'));

    // The oldest entry overall was the first text record. It went as what it was; nothing was converted.
    expect(second.status).toBe('captured');
    expect(text.list().map((c) => [c.before, c.after])).toEqual([['t1', 't2']]);
    expect(store.list().map((entry) => entry.path)).toEqual(['r2', 'r1']);
    expect(await names(path.join(dir, 'payloads'))).toHaveLength(2);
  });

  it('shares one entry limit with the text records: a text record drops the oldest raw entry, payload included', async () => {
    const dir = await folder();
    let now = 1000; // these raw entries are older than any text record
    const { store } = await open(dir, { limits: { maxEntries: 3 }, now: () => now++ });
    const text = new CheckpointStore(3);
    text.attachPeer(store);
    store.attachPeer(text);
    for (const name of ['r1', 'r2']) {
      const captured = await store.capture(input(Buffer.from(name), name));
      (captured as any).pin.release();
    }
    textRecord(text, 't0', 't1');

    textRecord(text, 't1', 't2');
    await store.idle();

    expect(store.list().map((entry) => entry.path)).toEqual(['r2']);
    expect(await names(path.join(dir, 'payloads'))).toEqual([`${store.list()[0].id}.bin`]);
    expect(text.count()).toBe(2);
    const { store: reopened } = await open(dir, { now: () => now });
    expect(reopened.list().map((entry) => entry.path)).toEqual(['r2']);
  });

  it('a text record never drops a raw entry in use, even when it is the oldest', async () => {
    const dir = await folder();
    let now = 1000;
    const { store } = await open(dir, { limits: { maxEntries: 3 }, now: () => now++ });
    const text = new CheckpointStore(3);
    text.attachPeer(store);
    store.attachPeer(text);
    const held = await store.capture(input(Buffer.from('held'), 'held'));
    const free = await store.capture(input(Buffer.from('free'), 'free'));
    (free as any).pin.release();
    textRecord(text, 't0', 't1');

    textRecord(text, 't1', 't2');
    await store.idle();

    expect(store.list().map((entry) => entry.path)).toEqual(['held']);
    expect(await store.readBefore((held as any).entry.id)).toMatchObject({ status: 'read' });
  });

  it('refuses a payload that does not read back as written, and keeps nothing of it', async () => {
    const dir = await folder();
    const { store } = await open(dir, { afterStage: async (staged) => { await fs.writeFile(staged, 'bit rot'); } });

    const refused = await store.capture(input(Buffer.from('original')));

    expect(refused).toMatchObject({ status: 'refused', reason: expect.stringContaining('did not read back') });
    expect(store.list()).toEqual([]);
    expect(await names(path.join(dir, 'staging'))).toEqual([]);
    expect(await names(path.join(dir, 'payloads'))).toEqual([]);
  });

  it('never removes another workspace\'s restore points, or a file it did not create', async () => {
    const parent = await folder();
    const mine = path.join(parent, 'ws-a');
    const theirs = path.join(parent, 'ws-b');
    const { store: other } = await open(theirs, { workspaceId: 'ws-b' });
    await other.capture(input(Buffer.from('their bytes'), 'theirs'));
    const theirsBefore = await snapshot(theirs);
    const { store } = await open(mine, { limits: { maxTotalBytes: 8 } });
    await fs.mkdir(path.join(mine, 'payloads'), { recursive: true });
    await fs.writeFile(path.join(mine, 'payloads', 'notes.txt'), 'not a payload');
    await fs.mkdir(path.join(mine, 'staging'), { recursive: true });
    await fs.writeFile(path.join(mine, 'staging', 'keep.me'), 'not staging');

    for (const name of ['one', 'two', 'three']) {
      const captured = await store.capture(input(Buffer.from('12345678'), name));
      (captured as any).pin.release();
    }
    await RawCheckpointStore.open({ directory: mine, workspaceId: 'ws-a' });

    expect(store.list().map((entry) => entry.path)).toEqual(['three']);
    expect(await snapshot(theirs)).toEqual(theirsBefore);
    expect(await fs.readFile(path.join(mine, 'payloads', 'notes.txt'), 'utf8')).toBe('not a payload');
    expect(await fs.readFile(path.join(mine, 'staging', 'keep.me'), 'utf8')).toBe('not staging');
  });

  it('leaves a directory whose index names another workspace untouched, and refuses to use it', async () => {
    const dir = await folder();
    const { store: theirs } = await open(dir, { workspaceId: 'ws-b' });
    await theirs.capture(input(Buffer.from('theirs')));
    await fs.writeFile(path.join(dir, 'payloads', `${'f'.repeat(32)}.bin`), 'orphan of theirs');
    const before = await snapshot(dir);

    const { store, reconciliation } = await open(dir, { workspaceId: 'ws-a' });

    expect(reconciliation.unavailable).toContain('another workspace');
    expect(await store.capture(input(Buffer.from('x')))).toMatchObject({ status: 'refused' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('leaves an index it cannot read untouched, with its payloads, and refuses to use it', async () => {
    const dir = await folder();
    const { store: first } = await open(dir);
    await first.capture(input(Buffer.from('kept')));
    await fs.writeFile(path.join(dir, 'index.json'), '{ not json', 'utf8');
    const before = await snapshot(dir);

    const { store, reconciliation } = await open(dir);

    expect(reconciliation.unavailable).toBeDefined();
    expect(await store.capture(input(Buffer.from('x')))).toMatchObject({ status: 'refused' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('drops entries past 30 days, but never one in use', async () => {
    const dir = await folder();
    let now = 0;
    const { store } = await open(dir, { now: () => now });
    const old = await store.capture(input(Buffer.from('old'), 'old'));
    (old as any).pin.release();
    const held = await store.capture(input(Buffer.from('held'), 'held'));

    now = 31 * DAY;
    await store.capture(input(Buffer.from('new'), 'new'));

    expect(store.list().map((entry) => entry.path)).toEqual(['new', 'held']);
    expect(await store.readBefore((held as any).entry.id)).toMatchObject({ status: 'read' });
  });

  it('refuses when its index cannot be saved, removes the new payload, and drops nothing', async () => {
    const dir = await folder();
    let fail = false;
    const { store } = await open(dir, {
      limits: { maxTotalBytes: 10 },
      beforeIndexCommit: async () => { if (fail) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
    });
    const kept = await store.capture(input(Buffer.from('aaaaaa'), 'kept'));
    (kept as any).pin.release();
    const before = await snapshot(dir);

    fail = true;
    const refused = await store.capture(input(Buffer.from('bbbbbb'), 'refused'));

    expect(refused).toMatchObject({ status: 'refused', reason: expect.stringContaining('ENOSPC') });
    expect(store.list().map((entry) => entry.path)).toEqual(['kept']);
    expect(await snapshot(dir)).toEqual(before);
  });

  it('refuses, and does not throw, when the index cannot be saved while dropping expired entries', async () => {
    const dir = await folder();
    let now = 0;
    let fail = false;
    const { store } = await open(dir, {
      now: () => now,
      beforeIndexCommit: async () => { if (fail) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
    });
    const old = await store.capture(input(Buffer.from('old'), 'old'));
    (old as any).pin.release();

    now = 31 * DAY;
    fail = true;
    const refused = await store.capture(input(Buffer.from('new'), 'new'));

    expect(refused).toMatchObject({ status: 'refused', reason: expect.stringContaining('ENOSPC') });
    expect(await store.recordAfter((old as any).entry.id, { exists: false })).toBe(false);
  });

  it('reports a payload that no longer matches its SHA-256', async () => {
    const dir = await folder();
    const { store } = await open(dir);
    const captured = await store.capture(input(Buffer.from('original')));
    await fs.writeFile(path.join(dir, 'payloads', `${(captured as any).entry.id}.bin`), 'tampered');

    expect(await store.readBefore((captured as any).entry.id)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('SHA-256') });
  });

  it('keeps what the overwrite left across a reopen', async () => {
    const dir = await folder();
    const { store } = await open(dir);
    const captured = await store.capture(input(Buffer.from('before')));
    const after = { exists: true as const, size: 5, sha256: sha(Buffer.from('after')) };
    await store.recordAfter((captured as any).entry.id, after);

    const { store: reopened } = await open(dir);

    expect(reopened.get((captured as any).entry.id)?.after).toEqual(after);
  });
});

describe('RawCheckpointStore crash reconciliation', () => {
  it('removes what an interrupted capture left, and nothing it did not create', async () => {
    const dir = await folder();
    const workspace = await folder();
    const target = path.join(workspace, 'a.txt');
    await fs.writeFile(target, 'workspace file');
    const targetBefore = await fs.stat(target);
    const { store } = await open(dir);
    const kept = await store.capture({ ...input(Buffer.from('kept')), target });
    await fs.writeFile(path.join(dir, 'staging', `${'a'.repeat(32)}.${'b'.repeat(16)}.tmp`), 'half a payload');
    await fs.writeFile(path.join(dir, 'payloads', `${'c'.repeat(32)}.bin`), 'renamed, never indexed');
    await fs.writeFile(path.join(dir, `index.json.${'d'.repeat(16)}.tmp`), '{"half":');
    await fs.writeFile(path.join(dir, 'payloads', 'README'), 'someone else\'s');

    const { store: reopened, reconciliation } = await open(dir);

    expect(reconciliation).toMatchObject({ removedStaging: 1, removedOrphans: 1, droppedMissing: 0 });
    expect(await names(path.join(dir, 'staging'))).toEqual([]);
    expect(await names(path.join(dir, 'payloads'))).toEqual(['README', `${(kept as any).entry.id}.bin`].sort());
    expect(await names(dir)).toEqual(['index.json', 'payloads', 'staging']);
    // A restore point whose overwrite never reported back stays available; its file is never written to.
    expect(reopened.get((kept as any).entry.id)?.after).toBeUndefined();
    expect(await reopened.readBefore((kept as any).entry.id)).toMatchObject({ status: 'read' });
    expect(await fs.readFile(target, 'utf8')).toBe('workspace file');
    expect((await fs.stat(target)).mtimeMs).toBe(targetBefore.mtimeMs);
  });

  it('drops an entry whose payload is gone, since it can restore nothing', async () => {
    const dir = await folder();
    const { store } = await open(dir);
    const captured = await store.capture(input(Buffer.from('lost')));
    await fs.unlink(path.join(dir, 'payloads', `${(captured as any).entry.id}.bin`));

    const { store: reopened, reconciliation } = await open(dir);

    expect(reconciliation.droppedMissing).toBe(1);
    expect(reopened.list()).toEqual([]);
  });
});

// v0.9.97: the host acts on why a capture was refused, and a record that names a raw entry goes when the entry goes
// (USAGE "Restoring a file": a change that cannot keep its restore point is not made; no record outlives its bytes).
describe('RawCheckpointStore refusal codes and removal notices', () => {
  it('says why a capture was refused', async () => {
    const dir = await folder();
    const { store } = await open(dir, { limits: { maxPayloadBytes: 2, maxEntries: 1 } });
    expect(await store.capture(input(Buffer.from('too big')))).toMatchObject({ status: 'refused', code: 'too-large' });
    expect(await store.capture({ ...input(Buffer.from('x')), target: 'relative.bin' })).toMatchObject({ status: 'refused', code: 'invalid' });
    const held = await store.capture(input(Buffer.from('x')));
    expect(held.status).toBe('captured');
    expect(await store.capture(input(Buffer.from('y')))).toMatchObject({ status: 'refused', code: 'no-room' });
    const failing = await open(await folder(), { beforeIndexCommit: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
    expect(await failing.store.capture(input(Buffer.from('x')))).toMatchObject({ status: 'refused', code: 'storage' });
    const foreign = await folder();
    await fs.writeFile(path.join(foreign, 'index.json'), JSON.stringify({ schema: 'unode.rawCheckpoints', version: 1, workspace: 'ws-b', entries: [] }));
    expect(await (await open(foreign)).store.capture(input(Buffer.from('x')))).toMatchObject({ status: 'refused', code: 'unavailable' });
  });

  it('tells its owner every entry that leaves it: dropped for room, by the other side, expired, missing or removed', async () => {
    const dir = await folder();
    const removed: string[] = [];
    let now = 1_000;
    const { store } = await open(dir, { limits: { maxEntries: 2 }, now: () => now, onRemoved: (ids) => removed.push(...ids) });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      now += 1;
      const captured = await store.capture(input(Buffer.from(name), name));
      if (captured.status !== 'captured') throw new Error(captured.reason);
      captured.pin.release();
      ids.push(captured.entry.id);
    }
    expect(removed).toEqual([ids[0]]);
    store.evictOldest();
    expect(removed).toEqual([ids[0], ids[1]]);
    await store.idle();
    expect(await store.remove(ids[2])).toBe(true);
    expect(removed).toEqual(ids);

    const expiring = await store.capture(input(Buffer.from('d'), 'd'));
    if (expiring.status !== 'captured') throw new Error(expiring.reason);
    expiring.pin.release();
    const missing = await store.capture(input(Buffer.from('e'), 'e'));
    if (missing.status !== 'captured') throw new Error(missing.reason);
    missing.pin.release();
    await fs.unlink(path.join(dir, 'payloads', `${missing.entry.id}.bin`));
    now += 31 * DAY;
    const reopenedRemoved: string[] = [];
    await open(dir, { now: () => now, onRemoved: (gone) => reopenedRemoved.push(...gone) });
    expect(reopenedRemoved.sort()).toEqual([expiring.entry.id, missing.entry.id].sort());
  });
});
