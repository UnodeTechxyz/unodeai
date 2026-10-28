/*
 * v0.9.97: the host's write, edit and delete tools keep the exact bytes of an existing file before they replace or
 * remove it. Each case names the rule it realises: file effects design §4 ("For an overwrite, commit a
 * workspace-isolated binary checkpoint before replacing the target ... Quota/storage/checkpoint failure leaves the
 * target unchanged. Never evict another workspace's data"), handoff §4 (lock -> recheck -> checkpoint persisted ->
 * temporary file -> recheck -> commit -> read-back) and §4.3 (pin during the write; the request's first restore point
 * stays pinned until the request ends; evict only this workspace's unpinned entries; after a crash reconcile owned
 * staging only, never replay a write), and USAGE.md "Restoring a file".
 */
import { createHash } from 'crypto';
import { readFileSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore, checkpointRestorePlan } from '../Checkpoints';
import { FileWritePolicy, readTargetState, type ObservedTarget } from '../fileWritePolicy';
import { PreChangeCheckpoints, rawCheckpointLocation } from '../PreChangeCheckpoints';
import { RawCheckpointStore, type RawCheckpointLimits } from '../RawCheckpointStore';
import { WorkspaceTools } from '../WorkspaceTools';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3]);

async function folder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

/**
 * One extension host of one workspace: its own raw-byte store under the shared extension storage, the text records
 * made after each change (as the extension's recorder makes them), requests the test starts and ends, and a person
 * who approves every decision (the decision rules are P2's, tested elsewhere).
 */
async function host(options: {
  storage?: string;
  limits?: Partial<RawCheckpointLimits>;
  trusted?: () => boolean;
  readState?: (physical: string) => Promise<ObservedTarget>;
} = {}) {
  const root = await folder('unode-raw-ws-');
  const storage = options.storage ?? await folder('unode-raw-storage-');
  const location = rawCheckpointLocation(storage, root);
  const text = new CheckpointStore();
  const state = {
    request: 'r1' as string | undefined,
    running: new Set(['r1']),
    /** Runs each time the raw store commits its index: in a capture, and when it records what a change left. */
    duringCapture: undefined as undefined | (() => Promise<void>),
    store: undefined as RawCheckpointStore | undefined,
    /** The decisions the person was asked for. */
    decisions: 0,
    notices: [] as string[],
  };
  const checkpoints = new PreChangeCheckpoints({
    open: async () => {
      const { store } = await RawCheckpointStore.open({
        ...location,
        ...(options.limits ? { limits: options.limits } : {}),
        onRemoved: (ids) => { text.dropRaw(ids); },
        beforeIndexCommit: async () => { await state.duringCapture?.(); },
      });
      store.attachPeer(text);
      text.attachPeer(store);
      state.store = store;
      return store;
    },
    isRequestRunning: (id) => state.running.has(id),
  });
  const policy = new FileWritePolicy({
    workspaceId: () => 'workspace',
    isRequestRunning: (id) => state.running.has(id),
    checkpoints,
    ...(options.readState ? { readState: options.readState } : {}),
  });
  const tools = (agentId = 'dev') => {
    const t = new WorkspaceTools(
      root, new Set(['read', 'write']), agentId, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (entry) => { text.record({ ...entry, agentName: agentId, operation: entry.operation ?? 'write' }); },
      () => false, undefined, undefined, undefined, undefined, [], options.trusted ?? (() => true), [root],
    );
    t.setFileWrites(policy.forAgent({ agentId, requestId: () => state.request, decide: async () => { state.decisions++; return 'once'; },
      notice: message => state.notices.push(message) }));
    return t;
  };
  const store = async () => {
    const opened = await checkpoints.store();
    if ('unavailable' in opened) throw new Error(opened.unavailable);
    return opened.store;
  };
  return { root, storage, location, text, state, checkpoints, tools, store };
}

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = sha(await fs.readFile(full));
    }
  };
  await walk(dir);
  return out;
}

describe('the exact bytes are kept before the change, complete on disk (design §4, handoff §4)', () => {
  it('keeps a binary file\'s bytes before write_file replaces it, while the file still holds them', async () => {
    const h = await host();
    const file = path.join(h.root, 'logo.png');
    await fs.writeFile(file, BINARY);
    const seenDuringCapture: Buffer[] = [];
    h.state.duringCapture = async () => { seenDuringCapture.push(await fs.readFile(file)); };

    const result = await h.tools().run('write_file', { path: 'logo.png', content: 'replaced\n' });

    expect(result).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toBe(0);
    expect(h.state.notices).toEqual(['"logo.png" had changes UnodeAi did not make. A restore point was kept; ⟲ undoes this.']);
    // The capture's index commit saw the old bytes, the record of what the change left saw the new ones: the restore
    // point was complete on disk before, not after, the file was replaced.
    expect(seenDuringCapture).toEqual([BINARY, Buffer.from('replaced\n')]);
    expect(await fs.readFile(file, 'utf8')).toBe('replaced\n');
    const store = await h.store();
    const [entry] = store.list();
    expect(entry).toMatchObject({
      target: file,
      before: { exists: true, size: BINARY.length, sha256: sha(BINARY) },
      after: { exists: true, size: 9, sha256: sha('replaced\n') },
    });
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: BINARY });
    // One change, one restore point: the record names it and is counted once, as the raw entry.
    const [record] = h.text.list();
    expect(record.raw).toEqual({ id: entry.id, afterSha256: sha('replaced\n') });
    expect(record.restoreDisabledReason).toBeUndefined();
    expect(h.text.count() + store.count()).toBe(1);
  });

  it('keeps the bytes before delete_file removes a file', async () => {
    const h = await host();
    const file = path.join(h.root, 'data.bin');
    await fs.writeFile(file, BINARY);

    expect(await h.tools().run('delete_file', { path: 'data.bin' })).toMatchObject({ status: 'success' });

    const store = await h.store();
    const [entry] = store.list();
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: BINARY });
    expect(entry.after).toEqual({ exists: false });
    expect(h.text.list()[0]).toMatchObject({ operation: 'delete-file', raw: { id: entry.id, afterSha256: null } });
  });

  it('keeps the bytes of a file that is not UTF-8 before apply_edit rewrites it from decoded text', async () => {
    const h = await host();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x6f, 0x6b, 0x0d, 0x0a]); // "café\r\nok\r\n"
    await fs.writeFile(path.join(h.root, 'menu.txt'), latin1);

    expect(await h.tools().run('apply_edit', { path: 'menu.txt', old_string: 'ok', new_string: 'OK' })).toMatchObject({ status: 'success' });

    const store = await h.store();
    expect(await store.readBefore(store.list()[0].id)).toEqual({ status: 'read', bytes: latin1 });
    // The text kept for the diff is not the file; the record says so by naming the raw restore point instead.
    expect(h.text.list()[0].raw?.id).toBe(store.list()[0].id);
    expect(h.text.list()[0].restoreDisabledReason).toBeUndefined();
  });

  it('keeps nothing for a new file, a write that leaves the same bytes, or a folder delete', async () => {
    const h = await host();
    await fs.writeFile(path.join(h.root, 'same.txt'), 'same\n');
    await fs.mkdir(path.join(h.root, 'build'));
    await fs.writeFile(path.join(h.root, 'build', 'out.js'), 'x');
    const tools = h.tools();

    expect(await tools.run('write_file', { path: 'new.txt', content: 'new\n' })).toMatchObject({ status: 'success' });
    expect(await tools.run('write_file', { path: 'same.txt', content: 'same\n' })).toMatchObject({ status: 'success' });
    expect(await tools.run('delete_dir', { path: 'build' })).toMatchObject({ status: 'success' });

    expect((await h.store()).count()).toBe(0);
    expect(h.text.list().map((c) => [c.path, c.raw])).toEqual([['build', undefined], ['new.txt', undefined]]);
  });
});

/** A look that reports a file's identity and SHA-256 but not its bytes, as for a file too large to read whole. */
async function lookWithoutBytes(physical: string): Promise<ObservedTarget> {
  return { state: (await readTargetState(physical)).state };
}

// v0.9.99 (A3): a restore point that cannot be kept (storage full or read-only, no room) no longer stops the change.
// The change is made; the model's result and one line for the person say it has no restore point, and why. Every check
// of the target (path, identity, content) still runs before it.
describe('a restore point that cannot be kept no longer stops the change, and says so', () => {
  it('writes and deletes a file over the per-restore-point limit, and says neither has a restore point', async () => {
    const h = await host({ limits: { maxPayloadBytes: 4 } });
    await fs.writeFile(path.join(h.root, 'big.bin'), BINARY);
    await fs.writeFile(path.join(h.root, 'old.bin'), BINARY);

    const write = await h.tools().run('write_file', { path: 'big.bin', content: 'x' });
    const remove = await h.tools().run('delete_file', { path: 'old.bin' });

    expect(write).toMatchObject({ status: 'success' });
    expect(write.output).toMatch(/^Wrote 1 bytes to big\.bin\. No restore point for this change to "big\.bin": UnodeAi could not keep a copy of the file \(the file is larger than 0 MiB, the most one restore point keeps\)\. ⟲ cannot undo this change\.$/);
    expect(remove).toMatchObject({ status: 'success' });
    expect(remove.output).toMatch(/^Deleted old\.bin\. No restore point for this change to "old\.bin"/);
    expect(await fs.readFile(path.join(h.root, 'big.bin'), 'utf8')).toBe('x');
    await expect(fs.stat(path.join(h.root, 'old.bin'))).rejects.toThrow();
    // The person reads the same line; no record claims a restore point (not UTF-8: ⟲ is disabled, as the line says).
    // (This host has no Git, so each change also gets the existing line about changes UnodeAi did not make.)
    expect(h.state.notices.filter((line) => line.includes('restore point for this change'))).toEqual([write.output.replace(/^Wrote 1 bytes to big\.bin\. /, ''), remove.output.replace(/^Deleted old\.bin\. /, '')]);
    expect(h.text.list().map((c) => [c.path, c.raw, c.restoreDisabledReason])).toEqual([
      ['old.bin', undefined, 'not-utf8-text'], ['big.bin', undefined, 'not-utf8-text'],
    ]);
    expect(await filesUnder(h.location.directory)).toEqual({});
  });

  it('writes when only a restore point still in use could make room, and says its earlier text can still be put back', async () => {
    const h = await host({ limits: { maxEntries: 1 } });
    await fs.writeFile(path.join(h.root, 'a.txt'), 'a1');
    await fs.writeFile(path.join(h.root, 'b.txt'), 'b1');
    const tools = h.tools();
    expect(await tools.run('write_file', { path: 'a.txt', content: 'a2' })).toMatchObject({ status: 'success' });

    // a.txt's restore point is this running request's first of that file, so it is not dropped for room.
    const written = await tools.run('write_file', { path: 'b.txt', content: 'b2' });

    expect(written.status).toBe('success');
    expect(written.output).toMatch(/No exact restore point for this change to "b\.txt": UnodeAi could not keep a copy of its bytes \(.*none that could make room is free\)\. ⟲ can still put back its earlier text\.$/);
    expect(await fs.readFile(path.join(h.root, 'b.txt'), 'utf8')).toBe('b2');
    // That claim is true: the change's text record holds 'b1' and a restore plan exists for it.
    const record = h.text.list().find((c) => c.path === 'b.txt')!;
    expect(record.before).toBe('b1');
    expect(record.raw).toBeUndefined();
    expect(checkpointRestorePlan(h.text.list(), record)).toMatchObject({ ok: true });
  });

  it('writes when the restore point cannot be saved (storage full), removes what it wrote, and keeps no fake restore point', async () => {
    const h = await host();
    const file = path.join(h.root, 'a.txt');
    await fs.writeFile(file, 'before');
    h.state.duringCapture = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };

    const result = await h.tools().run('write_file', { path: 'a.txt', content: 'after' });

    expect(result.status).toBe('success');
    expect(result.output).toMatch(/could not be saved \(ENOSPC\)\)\. ⟲ can still put back its earlier text\.$/);
    expect(await fs.readFile(file, 'utf8')).toBe('after');
    expect(h.text.list().map((c) => [c.path, c.raw])).toEqual([['a.txt', undefined]]);
    expect(Object.keys(await filesUnder(h.location.directory)).filter((name) => name.startsWith('payloads'))).toEqual([]);
    expect(h.state.notices.filter((line) => line.includes('restore point for this change'))).toHaveLength(1);
  });

  it('deletes when this workspace\'s restore-point directory cannot be used, and says so', async () => {
    const h = await host();
    await fs.mkdir(h.location.directory, { recursive: true });
    await fs.writeFile(path.join(h.location.directory, 'index.json'), '{ not json');
    const file = path.join(h.root, 'a.txt');
    await fs.writeFile(file, 'before');

    const result = await h.tools().run('delete_file', { path: 'a.txt' });

    expect(result.status).toBe('success');
    expect(result.output).toMatch(/^Deleted a\.txt\. No exact restore point for this change to "a\.txt": .*restore-point index is not readable/);
    await expect(fs.stat(file)).rejects.toThrow();
    // The unusable index is left exactly as it was.
    expect(await fs.readFile(path.join(h.location.directory, 'index.json'), 'utf8')).toBe('{ not json');
  });

  it('still refuses when the file changed before the change: the identity check is not loosened', async () => {
    const h = await host({ limits: { maxPayloadBytes: 4 } });
    const file = path.join(h.root, 'big.bin');
    await fs.writeFile(file, BINARY);
    const tools = h.tools();
    await tools.run('read_file', { path: 'big.bin' });
    h.state.duringCapture = undefined;
    // Another program changes the file after the plan was made, while the (refused) capture runs.
    const checkpoints = h.checkpoints as unknown as { capture: (request: unknown) => Promise<unknown> };
    const capture = checkpoints.capture.bind(h.checkpoints);
    checkpoints.capture = async (request) => { const outcome = await capture(request); await fs.writeFile(file, 'someone else'); return outcome; };
    const result = await tools.run('write_file', { path: 'big.bin', content: 'x' });
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/changed while this change waited/);
    expect(await fs.readFile(file, 'utf8')).toBe('someone else');
    expect(h.state.notices).toEqual([]);
  });
});

// v0.9.99 (A3): a file too large to read whole is hashed as a stream and its restore point copied on disk.
describe('a file too large to read whole gets a restore point copied on disk', () => {
  it('copies the file into a restore point before the change, and keeps it only when the copy matches', async () => {
    const h = await host({ readState: lookWithoutBytes });
    const file = path.join(h.root, 'data.bin');
    await fs.writeFile(file, BINARY);

    expect(await h.tools().run('write_file', { path: 'data.bin', content: 'new' })).toMatchObject({ status: 'success' });

    const store = await h.store();
    const [entry] = store.list();
    expect(entry.before).toEqual({ exists: true, size: BINARY.length, sha256: sha(BINARY) });
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: BINARY });
    expect(h.state.notices.join(' ')).not.toMatch(/No (exact )?restore point/);
  });

  it('keeps no copy of a file that changed while it was copied, and the change then stops on the identity check', async () => {
    const h = await host({ readState: lookWithoutBytes });
    const file = path.join(h.root, 'data.bin');
    await fs.writeFile(file, BINARY);
    const tools = h.tools();
    const policy = (tools as unknown as { fileWrites: { checkpointBefore: (change: { physical: string }) => Promise<unknown> } }).fileWrites;
    const original = policy.checkpointBefore.bind(policy);
    policy.checkpointBefore = async (change) => { await fs.writeFile(file, 'changed meanwhile'); return original(change); };

    const result = await tools.run('write_file', { path: 'data.bin', content: 'new' });

    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/changed while this change waited/);
    expect(await fs.readFile(file, 'utf8')).toBe('changed meanwhile');
    expect((await h.store()).count()).toBe(0);
    expect(Object.keys(await filesUnder(h.location.directory)).filter((name) => !name.endsWith('index.json'))).toEqual([]);
  });

  it('writes without a restore point when the copy would not fit in all the room kept, and says so', async () => {
    const h = await host({ readState: lookWithoutBytes, limits: { maxTotalBytes: 4 } });
    await fs.writeFile(path.join(h.root, 'data.bin'), BINARY);
    const result = await h.tools().run('write_file', { path: 'data.bin', content: 'new' });
    expect(result.status).toBe('success');
    expect(result.output).toMatch(/No restore point for this change to "data\.bin": UnodeAi could not keep a copy of the file \(the file is larger than 0 MiB, all the room kept for this workspace's restore points\)\. ⟲ cannot undo this change\.$/);
    expect(await fs.readFile(path.join(h.root, 'data.bin'), 'utf8')).toBe('new');
  });

  // Former rule: "A file larger than 32 MiB is not replaced or deleted by these tools at all."
  it('replaces and deletes a file over 32 MiB, each with an exact restore point copied on disk', async () => {
    const h = await host();
    const file = path.join(h.root, 'huge.bin');
    const size = 32 * 1024 * 1024 + 1;
    const handle = await fs.open(file, 'w');
    await handle.truncate(size);
    await handle.close();
    const zeros = sha(Buffer.alloc(size));

    // Same size, so the whole-file truncation guard does not apply.
    const write = await h.tools().run('write_file', { path: 'huge.bin', content: 'b'.repeat(size) });
    expect(write).toMatchObject({ status: 'success' });
    expect(write.output).toBe(`Wrote ${size} bytes to huge.bin.`);
    const remove = await h.tools().run('delete_file', { path: 'huge.bin' });
    expect(remove).toMatchObject({ status: 'success', output: 'Deleted huge.bin.' });
    await expect(fs.stat(file)).rejects.toThrow();
    expect(h.state.decisions).toBe(0);
    expect(h.state.notices.join(' ')).not.toMatch(/No (exact )?restore point/);

    const store = await h.store();
    expect(store.list().map((entry) => entry.before)).toEqual([
      { exists: true, size, sha256: sha('b'.repeat(size)) },
      { exists: true, size, sha256: zeros },
    ]);
    // The records name those restore points, so ⟲ can put either version back.
    expect(h.text.list().map((c) => [c.path, c.operation, !!c.raw])).toEqual([['huge.bin', 'delete-file', true], ['huge.bin', 'write', true]]);
  }, 60_000);
});

describe('pins and eviction (handoff §4.3)', () => {
  it('holds a request\'s first restore point of a file until the request ends; later ones may go for room', async () => {
    const h = await host({ limits: { maxEntries: 2 } });
    for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(h.root, `${name}.txt`), `${name}0`);
    const tools = h.tools();
    await tools.run('write_file', { path: 'a.txt', content: 'a1' }); // r1's first of a.txt: pinned
    const store = await h.store();
    const firstOfA = store.list()[0].id;
    await tools.run('write_file', { path: 'a.txt', content: 'a2' }); // not the first: free once written

    // Room for b.txt's restore point is made from the free one, never from the first.
    expect(await tools.run('write_file', { path: 'b.txt', content: 'b1' })).toMatchObject({ status: 'success' });
    expect(store.list().map((entry) => entry.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await store.readBefore(firstOfA)).toEqual({ status: 'read', bytes: Buffer.from('a0') });
    // The record of the change whose restore point went is gone with it; nothing points at missing bytes.
    expect(h.text.list().map((c) => [c.path, c.after])).toEqual([['b.txt', 'b1'], ['a.txt', 'a1']]);

    // Both remaining are r1's first restore points: while r1 runs, nothing can make room. v0.9.99: the write is made
    // without a restore point, says so, and drops neither pinned one.
    const unkept = await tools.run('write_file', { path: 'c.txt', content: 'c1' });
    expect(unkept.status).toBe('success');
    expect(unkept.output).toMatch(/No exact restore point for this change to "c\.txt"/);
    expect(await fs.readFile(path.join(h.root, 'c.txt'), 'utf8')).toBe('c1');
    expect(store.get(firstOfA)).toBeDefined();

    // Once r1 has ended its pins are released, and the oldest restore point goes for the next one.
    h.state.running.delete('r1');
    h.state.request = 'r2';
    h.state.running.add('r2');
    const kept = await tools.run('write_file', { path: 'c.txt', content: 'c2' });
    expect(kept).toMatchObject({ status: 'success' });
    expect(kept.output).not.toMatch(/restore point/);
    expect(store.get(firstOfA)).toBeUndefined();
  });

  it('makes room only from this workspace\'s own restore points', async () => {
    const storage = await folder('unode-raw-shared-storage-');
    const one = await host({ storage, limits: { maxEntries: 1 } });
    const two = await host({ storage, limits: { maxEntries: 1 } });
    expect(one.location.directory).not.toBe(two.location.directory);
    await fs.writeFile(path.join(one.root, 'a.txt'), 'one before');
    await one.tools().run('write_file', { path: 'a.txt', content: 'one after' });
    one.state.running.clear(); // its request ended: its restore point is free to go, but only for its own workspace
    const untouched = await filesUnder(one.location.directory);
    for (const round of [1, 2]) {
      two.state.request = `r${round}`;
      two.state.running = new Set([`r${round}`]);
      await fs.writeFile(path.join(two.root, `f${round}.txt`), `two ${round}`);
      expect(await two.tools().run('write_file', { path: `f${round}.txt`, content: 'changed' })).toMatchObject({ status: 'success' });
    }

    expect(await filesUnder(one.location.directory)).toEqual(untouched);
    expect((await one.store()).count()).toBe(1);
    expect((await two.store()).list().map((entry) => entry.path)).toEqual(['f2.txt']);
  });
});

describe('a change that does not complete (handoff §4.3: reconcile owned staging, never replay)', () => {
  it('removes the restore point when the file changed before the commit and nothing was replaced', async () => {
    const h = await host();
    const file = path.join(h.root, 'a.txt');
    await fs.writeFile(file, 'before');
    h.state.duringCapture = async () => { await fs.writeFile(file, 'someone else'); };

    const result = await h.tools().run('write_file', { path: 'a.txt', content: 'mine' });

    expect(result.status).toBe('failed');
    expect(await fs.readFile(file, 'utf8')).toBe('someone else');
    expect((await h.store()).count()).toBe(0);
    expect(await filesUnder(path.join(h.location.directory, 'payloads'))).toEqual({});
    expect(h.text.list()).toEqual([]);
  });

  it('removes the restore point when the commit fails with an error and the file is as it was', async () => {
    let failing = false;
    // Once the restore point is kept, the commit's own first look fails with an error, not with a reason.
    const h = await host({ trusted: () => { if (failing) throw new Error('trust lookup failed'); return true; } });
    const file = path.join(h.root, 'a.txt');
    await fs.writeFile(file, 'before');
    h.state.duringCapture = async () => { failing = true; };

    const result = await h.tools().run('write_file', { path: 'a.txt', content: 'after' });

    expect(result.status).not.toBe('success');
    expect(result.output).toContain('trust lookup failed');
    expect(await fs.readFile(file, 'utf8')).toBe('before');
    expect((await h.store()).count()).toBe(0);
    expect(h.text.list()).toEqual([]);
  });

  it('keeps the restore point, and records the change, when the commit fails with an error and the file changed', async () => {
    let failing = false;
    const h = await host({ trusted: () => { if (failing) throw new Error('trust lookup failed'); return true; } });
    const file = path.join(h.root, 'a.txt');
    await fs.writeFile(file, 'before');
    h.state.duringCapture = async () => {
      if (failing) return;
      failing = true;
      await fs.writeFile(file, 'changed meanwhile');
    };

    expect((await h.tools().run('write_file', { path: 'a.txt', content: 'after' })).status).not.toBe('success');

    const store = await h.store();
    expect(store.count()).toBe(1);
    expect(await store.readBefore(store.list()[0].id)).toEqual({ status: 'read', bytes: Buffer.from('before') });
    expect(h.text.list().map((c) => c.raw?.id)).toEqual([store.list()[0].id]);
  });

  it('keeps the restore point, and records the change against its file, when the write cannot be confirmed', async () => {
    let reads = 0;
    const h = await host({
      readState: async (physical) => {
        const real = await readTargetState(physical);
        // The plan's look, the lock's, the commit's two; the fifth is the read-back, which here finds other bytes.
        return ++reads === 5 && real.state.exists ? { state: { ...real.state, sha256: 'f'.repeat(64) } } : real;
      },
    });
    const file = path.join(h.root, 'a.bin');
    await fs.writeFile(file, BINARY);

    const result = await h.tools().run('write_file', { path: 'a.bin', content: 'after' });

    expect(result.status).toBe('failed');
    expect(result.output).toContain('may have changed it');
    const store = await h.store();
    const [entry] = store.list();
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: BINARY });
    expect(entry.after).toBeUndefined();
    // Its record names the file the tool resolved, and the raw restore point, without a confirmed after-state.
    expect(h.text.list().map((c) => [c.target, c.raw])).toEqual([[file, { id: entry.id }]]);
  });

  it('leaves a complete restore point and an untouched file after a crash between the checkpoint and the commit', async () => {
    const h = await host();
    const file = path.join(h.root, 'a.bin');
    await fs.writeFile(file, BINARY);
    // The host keeps the restore point and stops there, as a host that dies before the rename does.
    const kept = await h.checkpoints.capture({ agentId: 'dev', requestId: 'r1', path: 'a.bin', target: file, physical: file, bytes: BINARY });
    expect(kept.status).toBe('kept');

    // A new host on the same storage: its records start from what was saved, which never named this change.
    const { store, reconciliation } = await RawCheckpointStore.open(h.location);

    expect(reconciliation).toEqual({ removedStaging: 0, removedOrphans: 0, droppedMissing: 0, expired: 0 });
    const [entry] = store.list();
    expect(entry).toMatchObject({ path: 'a.bin', target: file, before: { exists: true, sha256: sha(BINARY) } });
    expect(entry.after).toBeUndefined();
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: BINARY });
    expect(await fs.readFile(file)).toEqual(BINARY);
    expect(await filesUnder(path.join(h.location.directory, 'staging'))).toEqual({});
    expect(new CheckpointStore().restorable()).toEqual([]);
  });
});

describe('the extension gives the write policy this workspace\'s restore points', () => {
  // extension.ts needs a VS Code host to run, so its wiring is held here by its source. What openRawCheckpoints does is
  // run in checkpointRestoreFlow.test.ts.
  const source = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');

  it('builds the restore points before the policy, and hands them to it', () => {
    const created = source.indexOf('preChangeCheckpoints = new PreChangeCheckpoints({');
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(source.indexOf('fileWritePolicy = makeFileWritePolicy();'));
    const policy = source.slice(source.indexOf('function makeFileWritePolicy('), source.indexOf('async function openRawCheckpoints('));
    expect(policy).toMatch(/^\s+checkpoints: preChangeCheckpoints,$/m);
    expect(source).toMatch(/open: \(\) => openRawCheckpoints\(storageRoot\),\s*isRequestRunning: \(requestId\) => sessionManager\?\.requestRunning\(requestId\) \?\? false,/);
  });
});
