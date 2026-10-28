import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DelegationResultBodyStore, ResultBodyStorageError, type ResultBodyStoreOptions } from '../DelegationResultBodyStore';
import { ResultBodyRecovery, RESULT_RECOVERY_UNAVAILABLE } from '../ResultBodyRecovery';
import { resultMailboxKey } from '../DelegationResultMailbox';
import { workspaceRootIdentity } from '../WorkspaceRootIdentity';

const directories: string[] = [];
const testRoot = path.join(process.cwd(), '.audit-repro', 'result-body-tests');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (n = 0) => resultMailboxKey('pm', { handle: `handle-${n}`, revision: 1 });
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    // Only test-owned mkdtemp children, never a caller/workspace path.
    if (path.dirname(dir) !== testRoot || !path.basename(dir).startsWith('unode-result-body-')) throw new Error('Unsafe test cleanup');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function fixture(io?: ResultBodyStoreOptions['io']) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'unode-result-body-')); directories.push(dir);
  const workspaceId = workspaceRootIdentity(dir); const root = path.join(dir, 'delegation-results-v1', workspaceId);
  const reservations = new Set<string>(); let current = true;
  const options: ResultBodyStoreOptions = { storageUri: { scheme: 'file', fsPath: dir }, workspaceId, io,
    assertCurrent: () => { if (!current) throw new Error('stale lease with PRIVATE path'); }, reservations: () => [...reservations] };
  const store = await DelegationResultBodyStore.open(options);
  return { dir, root, options, store, reservations, stale: () => { current = false; } };
}
const error = (reason: string) => expect.objectContaining({ reason });

describe('T2b private body-file backing (no production activation)', () => {
  it('reclaims only the exact archived body, freeing a charged slot while other results remain', async () => {
    const h = await fixture(); h.reservations.add(key(1)); h.reservations.add(key(2));
    const ref = await h.store.write(key(1), 'archived result'); const other = await h.store.write(key(2), 'still pending');
    h.reservations.clear(); const closed = vi.fn(); const read = vi.fn(async () => 'archived result');
    expect(await h.store.reclaimArchived(ref, { assertClosed: closed, readRecoveredBody: read })).toBe(true);
    expect(closed).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledExactlyOnceWith(ref);
    expect((await h.store.usage()).physicalSlots).toBe(1); expect(await h.store.read(other)).toBe('still pending');
    await expect(fs.lstat(path.join(h.root, `${ref.key}.body`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([undefined, 'wrong archive'])('keeps a body and its quota when the recovered copy is %s', async archived => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'must remain'); h.reservations.clear();
    expect(await h.store.reclaimArchived(ref, { assertClosed() {}, readRecoveredBody: async () => archived })).toBe(false);
    expect(await h.store.read(ref)).toBe('must remain'); expect((await h.store.usage()).physicalSlots).toBe(1);
  });
  it('keeps the body if its archive scope reopens or the lease changes during the archive read', async () => {
    for (const loseLease of [false, true]) {
      const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'retained');
      let closed = true;
      await expect(h.store.reclaimArchived(ref, {
        assertClosed() { if (!closed) throw new Error('scope reopened'); },
        async readRecoveredBody() { if (loseLease) h.stale(); else closed = false; return 'retained'; },
      })).rejects.toBeInstanceOf(ResultBodyStorageError);
      expect(await fs.readFile(path.join(h.root, `${ref.key}.body`), 'utf8')).toBe('retained');
    }
  });
  it('does not delete a body changed during the awaited archive read', async () => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'before');
    await expect(h.store.reclaimArchived(ref, { assertClosed() {}, async readRecoveredBody() {
      await fs.writeFile(path.join(h.root, `${ref.key}.body`), 'changed'); return 'before';
    } })).rejects.toEqual(error('conflict'));
    expect(await fs.readFile(path.join(h.root, `${ref.key}.body`), 'utf8')).toBe('changed');
  });
  it('can reopen full storage for recovery, reclaim one proven archived slot and admit recovery writes again', async () => {
    const h = await fixture();
    for (let n = 0; n < 256; n++) await fs.writeFile(path.join(h.root, `${key(n)}.body`), `body-${n}`);
    const full = await DelegationResultBodyStore.open(h.options); expect(full.readOnly).toBe(true);
    const ref = { key: key(), bytes: Buffer.byteLength('body-0'), sha256: digest('body-0') };
    expect(await full.reclaimArchived(ref, { assertClosed() {}, readRecoveredBody: async () => 'body-0' })).toBe(true);
    expect((await full.usage()).physicalSlots).toBe(255);
    await expect(full.checkAdmission()).resolves.toBeUndefined(); expect(full.readOnly).toBe(false);
    expect(await fs.readFile(path.join(h.root, `${key(255)}.body`), 'utf8')).toBe('body-255');
  }, 60000);
  it('retries directory sync when the final name was published before a prior sync failed', async () => {
    let activeRoot = ''; let syncs = 0;
    const open: typeof fs.open = async (...args) => {
      if (String(args[0]) === activeRoot && args[1] === 'r') return { sync: async () => {
        syncs++; if (syncs === 1) throw Object.assign(new Error('sync failed'), { code: 'EIO' });
      }, close: async () => {} } as unknown as fs.FileHandle;
      return fs.open(...args);
    };
    const h = await fixture({ ...fs, open }); activeRoot = h.root; h.reservations.add(key());
    await expect(h.store.write(key(), 'retained bytes')).rejects.toEqual(error('storage-error'));
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe('retained bytes');
    expect(await h.store.write(key(), 'retained bytes')).toMatchObject({ key: key() }); expect(syncs).toBe(2);
  });
  it('charges a crash-left staging/final pair once, and an unrelated staging copy separately', async () => {
    const h = await fixture(); const final = path.join(h.root, `${key()}.body`);
    const stage = path.join(h.root, 'staging', `${digest('linked-stage')}.stage`);
    await fs.writeFile(stage, 'retained'); await fs.link(stage, final);
    await fs.writeFile(path.join(h.root, 'staging', `${digest('orphan-stage')}.stage`), 'orphan');
    const reloaded = await DelegationResultBodyStore.open(h.options);
    expect(await reloaded.usage()).toMatchObject({ physicalSlots: 2, physicalBytes: Buffer.byteLength('retainedorphan') });
    expect(await fs.readFile(final, 'utf8')).toBe('retained'); expect(await fs.readFile(stage, 'utf8')).toBe('retained');
  });
  it('refuses a junction inside the owned namespace, not redirected VS Code storage ancestors', async () => {
    const h = await fixture(); const parent = path.dirname(h.root); const saved = parent + '.saved';
    await fs.rename(parent, saved); await fs.symlink(saved, parent, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(DelegationResultBodyStore.open(h.options)).rejects.toEqual(error('unsafe-path'));
    expect((await fs.stat(saved)).isDirectory()).toBe(true);
  });
  it('measures ordinary 4 KiB writes and flushes the published directory when supported', async () => {
    const opened: string[] = []; const open: typeof fs.open = async (...args) => { opened.push(String(args[0])); return fs.open(...args); };
    const h = await fixture({ ...fs, open }); opened.length = 0;
    const durations: number[] = [];
    for (let n = 0; n < 20; n++) {
      h.reservations.add(key(n)); const began = performance.now();
      await h.store.write(key(n), 'x'.repeat(4096)); durations.push(performance.now() - began); h.reservations.delete(key(n));
    }
    expect(opened.filter(folder => folder === h.root)).toHaveLength(20);
    durations.sort((a, b) => a - b);
    console.info('[result-body-4k]', JSON.stringify({ node: process.version, medianMs: Number(durations[10].toFixed(2)),
      averageMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)), targetMs: 10 }));
    // Measurements are evidence, not a flaky wall-clock assertion on a busy CI disk.
    expect((await h.store.usage()).physicalSlots).toBe(20);
  });
  it('on directory-sync-capable storage, syncs the published name before reading it back or acknowledging it', async () => {
    let activeRoot = ''; const order: string[] = [];
    const open: typeof fs.open = async (...args) => {
      if (String(args[0]) === activeRoot && args[1] === 'r') return {
        sync: async () => { order.push('directory-sync'); }, close: async () => {},
      } as unknown as fs.FileHandle;
      if (activeRoot && String(args[0]).endsWith('.body') && args[1] === 'r') order.push('read-back');
      return fs.open(...args);
    };
    const link: typeof fs.link = async (...args) => { await fs.link(...args); if (activeRoot) order.push('publish'); };
    const h = await fixture({ ...fs, open, link }); activeRoot = h.root; h.reservations.add(key());
    await h.store.write(key(), 'body'); expect(order).toEqual(['publish', 'directory-sync', 'read-back']);
  });
  it('round-trips immutable UTF-8 bytes and a content-free receipt without storing the body in metadata', async () => {
    const h = await fixture(); h.reservations.add(key()); const text = '简繁中文 日本語 한국어 🧑🏽‍💻\nprivate result';
    const ref = await h.store.write(key(), text); h.reservations.clear();
    expect(ref).toEqual({ key: key(), bytes: Buffer.byteLength(text), sha256: digest(text) });
    expect(await h.store.read(ref)).toBe(text);
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe(text);
    expect(await fs.readdir(path.join(h.root, 'staging'))).toEqual([]);
    expect(JSON.stringify(ref)).not.toContain('private result');
    expect(await h.store.usage()).toEqual({ physicalSlots: 1, physicalBytes: ref.bytes, reservedSlots: 0, reservedBytes: 0 });
  });
  it('repeated exact write is idempotent, including an empty body, without allocating another item', async () => {
    const h = await fixture(); h.reservations.add(key());
    const ref = await h.store.write(key(), ''); h.reservations.clear();
    expect(await h.store.write(key(), '')).toEqual(ref); expect(await h.store.read(ref)).toBe('');
    expect((await h.store.usage()).physicalSlots).toBe(1);
  });
  it('refuses conflicting same-key bytes and leaves the original untouched', async () => {
    const h = await fixture(); h.reservations.add(key()); const original = await h.store.write(key(), 'original');
    await expect(h.store.write(key(), 'replacement')).rejects.toEqual(error('conflict'));
    expect(await h.store.read(original)).toBe('original');
  });
  it.each(['../escape', key().toUpperCase(), '', 'x'.repeat(64)])('rejects non-host filename %s', async candidate => {
    const h = await fixture(); h.reservations.add(candidate);
    await expect(h.store.write(candidate, 'body')).rejects.toEqual(error('invalid-body'));
  });
  it.each(['a'.repeat(65537), '中'.repeat(21846), '\ud800'])('rejects oversize or non-round-trippable UTF-8', async text => {
    const h = await fixture(); h.reservations.add(key());
    await expect(h.store.write(key(), text)).rejects.toEqual(error('invalid-body'));
    expect(await fs.readdir(path.join(h.root, 'staging'))).toEqual([]);
  });
  it('will not write a new body without that exact existing mailbox reservation', async () => {
    const h = await fixture(); h.reservations.add(key(1));
    await expect(h.store.write(key(), 'not reserved')).rejects.toEqual(error('reservation-required'));
  });
  it.each([undefined, { scheme: 'vscode-remote', fsPath: '/remote' }, { scheme: 'file', fsPath: 'relative' }])
  ('refuses missing/non-file/relative storage, not a cwd fallback', async storageUri => {
    await expect(DelegationResultBodyStore.open({ storageUri, workspaceId: digest('workspace'),
      assertCurrent() {}, reservations: () => [] })).rejects.toEqual(error('storage-unavailable'));
  });
  it('refuses an unavailable private storage base instead of creating arbitrary parent directories', async () => {
    const h = await fixture(); const missing = path.join(h.dir, 'missing', 'nested');
    await expect(DelegationResultBodyStore.open({ ...h.options, storageUri: { scheme: 'file', fsPath: missing } })).rejects.toEqual(error('storage-unavailable'));
    await expect(fs.stat(path.join(h.dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('checks all three counters: orphan physical bytes, live reservations and the 256-slot ceiling', async () => {
    const h = await fixture();
    // Crash leftovers are not in an index or kernel, but they still consume the same admission budget.
    for (let n = 0; n < 128; n++) await fs.writeFile(path.join(h.root, `${key(n)}.body`), Buffer.alloc(65536));
    h.store = await DelegationResultBodyStore.open(h.options); // Simulated crash leftovers are inventoried on open.
    expect(await h.store.usage()).toEqual({ physicalSlots: 128, physicalBytes: 8 * 1024 * 1024, reservedSlots: 0, reservedBytes: 0 });
    await expect(h.store.checkAdmission()).rejects.toEqual(error('capacity'));
    expect(await fs.readdir(h.root)).toHaveLength(129);
  });
  it('retains the exact 8 MiB/128 reservation admission limit without shrinking it', async () => {
    const h = await fixture();
    for (let n = 0; n < 127; n++) h.reservations.add(key(n));
    await expect(h.store.checkAdmission()).resolves.toBeUndefined();
    h.reservations.add(key(127)); await expect(h.store.checkAdmission()).rejects.toEqual(error('capacity'));
    // This attempt replaces its own reservation, so writing a full body at the boundary is legal.
    const ref = await h.store.write(key(0), 'x'.repeat(65536)); h.reservations.delete(key(0));
    expect(await h.store.read(ref)).toHaveLength(65536);
    expect(await h.store.usage()).toMatchObject({ physicalBytes: 65536, reservedBytes: 127 * 65536 });
  });
  it('opening a full backing stays read-only and never spends an extra probe byte or slot beyond quota', async () => {
    const link: typeof fs.link = vi.fn(fs.link); const h = await fixture({ ...fs, link });
    for (let n = 0; n < 128; n++) await fs.writeFile(path.join(h.root, `${key(n)}.body`), Buffer.alloc(65536));
    vi.mocked(link).mockClear();
    const reloaded = await DelegationResultBodyStore.open(h.options);
    expect(await reloaded.usage()).toMatchObject({ physicalBytes: 8388608, physicalSlots: 128 });
    expect(await reloaded.read({ key: key(), bytes: 65536, sha256: createHash('sha256').update(Buffer.alloc(65536)).digest('hex') })).toBe('\0'.repeat(65536));
    await expect(reloaded.checkAdmission()).rejects.toEqual(error('capacity')); expect(link).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(h.root, 'staging'))).toEqual([]);
  });
  it('charges short orphan bodies against the 256 physical slot limit', async () => {
    const h = await fixture();
    for (let n = 0; n < 256; n++) await fs.writeFile(path.join(h.root, `${key(n)}.body`), 'x');
    h.store = await DelegationResultBodyStore.open(h.options);
    expect(await h.store.usage()).toMatchObject({ physicalSlots: 256, physicalBytes: 256 });
    await expect(h.store.checkAdmission()).rejects.toEqual(error('capacity'));
  }, 30_000); // Creates 256 real files; use the same Windows I/O budget as the sibling quota fixture.
  it('does not globally fence a benign orphan when space remains', async () => {
    const h = await fixture(); await fs.writeFile(path.join(h.root, `${key(9)}.body`), 'orphan');
    h.store = await DelegationResultBodyStore.open(h.options);
    await expect(h.store.checkAdmission()).resolves.toBeUndefined();
    h.reservations.add(key()); await h.store.write(key(), 'new result');
    expect((await h.store.usage()).physicalSlots).toBe(2);
  });
  it('distinct hard-linked final names still consume distinct result slots', async () => {
    const h = await fixture(); const original = path.join(h.root, `${key()}.body`); await fs.writeFile(original, 'x');
    for (let n = 1; n <= 256; n++) await fs.link(original, path.join(h.root, `${key(n)}.body`));
    h.store = await DelegationResultBodyStore.open(h.options);
    expect(h.store.readOnly).toBe(true);
    expect(await h.store.usage()).toMatchObject({ physicalSlots: 257, physicalBytes: 257 });
    await expect(h.store.checkAdmission()).rejects.toEqual(error('capacity'));
  });
  it('a reload cannot delete final bodies just because metadata acknowledgement or a cached close exists', async () => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'only recoverable copy');
    h.reservations.clear(); const reloaded = await DelegationResultBodyStore.open(h.options);
    expect(await reloaded.recoverStaging()).toBe(0); expect(await reloaded.read(ref)).toBe('only recoverable copy');
    expect((await reloaded.usage()).physicalSlots).toBe(1);
  });
  it('cleans only strict staging files older than activation and retains orphan finals', async () => {
    const h = await fixture(); const old = path.join(h.root, 'staging', `${digest('old')}.stage`);
    await fs.writeFile(old, 'old staging'); await fs.utimes(old, new Date(0), new Date(0));
    await fs.writeFile(path.join(h.root, `${key()}.body`), 'final');
    const reloaded = await DelegationResultBodyStore.open(h.options);
    const fresh = path.join(h.root, 'staging', `${digest('fresh')}.stage`); await fs.writeFile(fresh, 'active staging');
    await fs.utimes(fresh, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    expect(await reloaded.recoverStaging()).toBe(1); expect(await fs.readFile(fresh, 'utf8')).toBe('active staging');
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe('final');
  });
  it('never recursively removes unknown staging names or nested folders', async () => {
    const h = await fixture(); await fs.mkdir(path.join(h.root, 'staging', 'user-data'));
    await expect(h.store.recoverStaging()).rejects.toEqual(error('unsafe-path'));
    expect((await fs.stat(path.join(h.root, 'staging', 'user-data'))).isDirectory()).toBe(true);
  });
  it('refuses a renamed/substituted bound root even if the replacement has the same absolute path', async () => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'retained');
    await fs.rename(h.root, `${h.root}.saved`); await fs.mkdir(h.root); await fs.mkdir(path.join(h.root, 'staging'));
    await expect(h.store.read(ref)).rejects.toEqual(error('unsafe-path'));
    expect(await fs.readFile(path.join(`${h.root}.saved`, `${key()}.body`), 'utf8')).toBe('retained');
  });
  it('accepts a real redirected storage base while preserving checks within its own subtree', async () => {
    const h = await fixture(); const alias = path.join(h.dir, 'alias');
    await fs.symlink(h.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const redirected = await DelegationResultBodyStore.open({ ...h.options, storageUri: { scheme: 'file', fsPath: alias } });
    await expect(redirected.checkAdmission()).resolves.toBeUndefined();
    expect(await fs.readdir(h.root)).toContain('staging');
  });
  it('retains the reparse-point directory-entry check even when lstat reports an ordinary directory', async () => {
    const h = await fixture(); await fs.writeFile(path.join(h.root, `${key()}.body`), 'body');
    const opendir = vi.fn(async (parent: string) => {
      const directory = await fs.opendir(parent);
      return (async function* () { for await (const entry of directory) yield entry.name === `${key()}.body`
        ? { ...entry, name: entry.name, isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true } : entry; })();
    });
    await expect(DelegationResultBodyStore.open({ ...h.options, io: { ...fs, opendir } as unknown as ResultBodyStoreOptions['io'] })).rejects.toEqual(error('unsafe-path'));
  });
  it('never enumerates or stats storage ancestors, and does not rescan files for usage, admission or writes', async () => {
    const h = await fixture(); const owned = path.join(h.dir, 'delegation-results-v1');
    const opendir = vi.fn(async (folder: string) => {
      if (!folder.startsWith(owned)) throw new Error('Ancestor listing is not allowed');
      return fs.opendir(folder);
    });
    const lstat = vi.fn(async (...args: Parameters<typeof fs.lstat>) => {
      if (!String(args[0]).startsWith(owned)) throw new Error('Ancestor stat is not allowed');
      return fs.lstat(...args);
    });
    h.store = await DelegationResultBodyStore.open({ ...h.options, io: { ...fs, opendir, lstat } as ResultBodyStoreOptions['io'] });
    opendir.mockClear(); lstat.mockClear();
    h.reservations.add(key()); await h.store.checkAdmission(); await h.store.write(key(), 'x'); h.reservations.clear();
    await h.store.usage(); await h.store.checkAdmission();
    expect(opendir).not.toHaveBeenCalled();
    expect(lstat.mock.calls.filter(call => call[0] === h.root)).toHaveLength(4); // Exactly one root check per operation.
  });
  it('hard-link-unavailable reports only optional backing failure with fixed text', async () => {
    const link = vi.fn(async () => { throw Object.assign(new Error('PRIVATE filesystem details'), { code: 'ENOTSUP' }); });
    const h = await fixture();
    await expect(DelegationResultBodyStore.open({ ...h.options, io: { ...fs, link } })).rejects.toMatchObject({
      reason: 'safe-publish-unavailable', message: expect.stringContaining('Work can continue'),
    });
    expect(link).toHaveBeenCalledOnce();
  });
  it('EEXIST cannot overwrite conflicting bytes written between the initial lookup and publication', async () => {
    let destination = ''; let inserted = false;
    const open: typeof fs.open = async (...args) => {
      if (destination && !inserted && args[1] === 'r' && String(args[0]).endsWith('.stage')) {
        inserted = true; await fs.writeFile(destination, 'external conflict', { flag: 'wx' });
      }
      return fs.open(...args);
    };
    const h = await fixture({ ...fs, open }); h.reservations.add(key()); destination = path.join(h.root, `${key()}.body`);
    const outcome = await h.store.write(key(), 'new result').then(() => undefined, failure => failure);
    // Check the protected bytes first: a replacing rename must fail here, not merely on staging cleanup.
    expect(await fs.readFile(destination, 'utf8')).toBe('external conflict');
    expect(outcome).toEqual(error('conflict'));
    const stage = await fs.readdir(path.join(h.root, 'staging')); expect(stage).toHaveLength(1);
    expect(await fs.readFile(path.join(h.root, 'staging', stage[0]), 'utf8')).toBe('new result');
  });
  it('an index-ack failure can leave an orphan, but retry reads the same verified immutable bytes', async () => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'ready before metadata');
    // Simulate a process crash before the caller acknowledges its small index: there is deliberately no index API here.
    const reloaded = await DelegationResultBodyStore.open(h.options);
    expect(await reloaded.write(key(), 'ready before metadata')).toEqual(ref);
    expect((await reloaded.usage()).physicalSlots).toBe(1);
  });
  it('checks the existing lease after a publish await, keeps bytes, and does not return a false receipt', async () => {
    let invalidate = () => {}; let active = false;
    const link = async (from: fs.PathLike, to: fs.PathLike) => { await fs.link(from, to); if (active) invalidate(); };
    const h = await fixture({ ...fs, link }); invalidate = h.stale; active = true; h.reservations.add(key());
    await expect(h.store.write(key(), 'late result')).rejects.toBeInstanceOf(ResultBodyStorageError);
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe('late result');
    expect(await fs.readdir(path.join(h.root, 'staging'))).toHaveLength(1);
  });
  it('refuses an obsolete completion even when the coordinator lease itself remains current', async () => {
    let ended = false; let active = false;
    const link = async (from: fs.PathLike, to: fs.PathLike) => { await fs.link(from, to); if (active) ended = true; };
    const h = await fixture({ ...fs, link }); active = true; h.reservations.add(key());
    h.options.assertCurrent = resultKey => { if (resultKey === key() && ended) throw new Error('old completion'); };
    await expect(h.store.write(key(), 'old completion result')).rejects.toBeInstanceOf(ResultBodyStorageError);
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe('old completion result');
  });
  it('a failed staging flush retains the only new copy and does not publish or acknowledge it', async () => {
    let active = false;
    const open: typeof fs.open = async (...args) => {
      const handle = await fs.open(...args);
      if (active && args[1] === 'wx') handle.sync = async () => { throw Object.assign(new Error('disk flush failed'), { code: 'EIO' }); };
      return handle;
    };
    const h = await fixture({ ...fs, open }); active = true; h.reservations.add(key());
    await expect(h.store.write(key(), 'unflushed result')).rejects.toEqual(error('storage-error'));
    await expect(fs.lstat(path.join(h.root, `${key()}.body`))).rejects.toMatchObject({ code: 'ENOENT' });
    const names = await fs.readdir(path.join(h.root, 'staging')); expect(names).toHaveLength(1);
    expect(await fs.readFile(path.join(h.root, 'staging', names[0]), 'utf8')).toBe('unflushed result');
    expect(await h.store.usage()).toMatchObject({ physicalSlots: 1, physicalBytes: Buffer.byteLength('unflushed result') });
    await fs.utimes(path.join(h.root, 'staging', names[0]), new Date(0), new Date(0));
    expect(await h.store.recoverStaging()).toBe(0); // Even skewed timestamps cannot delete this activation's copy.
  });
  it('lease loss during staging recovery cannot delete further files', async () => {
    let invalidate = () => {}; let active = false;
    const unlink = async (name: fs.PathLike) => { await fs.unlink(name); if (active) invalidate(); };
    const h = await fixture({ ...fs, unlink }); invalidate = h.stale;
    for (const label of ['one', 'two']) {
      const file = path.join(h.root, 'staging', `${digest(label)}.stage`); await fs.writeFile(file, label); await fs.utimes(file, new Date(0), new Date(0));
    }
    active = true; await expect(h.store.recoverStaging()).rejects.toBeInstanceOf(ResultBodyStorageError);
    expect(await fs.readdir(path.join(h.root, 'staging'))).toHaveLength(1);
  });
  it('detects changed read-back bytes instead of returning a successful receipt', async () => {
    const h = await fixture(); h.reservations.add(key()); const ref = await h.store.write(key(), 'original');
    await fs.writeFile(path.join(h.root, `${key()}.body`), 'modified');
    await expect(h.store.read(ref)).rejects.toEqual(error('conflict'));
  });
  it('does not reset the serial lane after a conflict into unbounded admission or overwrite', async () => {
    const h = await fixture(); h.reservations.add(key()); await h.store.write(key(), 'first');
    const results = await Promise.allSettled([h.store.write(key(), 'second'), h.store.write(key(), 'third')]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(await fs.readFile(path.join(h.root, `${key()}.body`), 'utf8')).toBe('first');
    expect((await h.store.usage()).physicalBytes).toBe(5);
  });
  it('near-8-MiB real body adapter probe: bounded receipt metadata and observable event-loop progress', async () => {
    const h = await fixture(); const receipts = []; const text = 'x'.repeat(65536);
    const delay = monitorEventLoopDelay({ resolution: 10 }); let ticks = 0;
    const timer = setInterval(() => ticks++, 5); delay.enable(); const began = performance.now();
    try {
      for (let n = 0; n < 128; n++) {
        h.reservations.add(key(n)); receipts.push(await h.store.write(key(n), text)); h.reservations.delete(key(n));
      }
      const usage = await h.store.usage(); expect(usage.physicalBytes).toBe(8 * 1024 * 1024); expect(usage.physicalSlots).toBe(128);
      await expect(h.store.checkAdmission()).rejects.toEqual(error('capacity'));
      const simulatedIndexPayloadBytes = Buffer.byteLength(JSON.stringify(receipts));
      expect(simulatedIndexPayloadBytes).toBeLessThan(128 * 2048); expect(ticks).toBeGreaterThan(0);
      console.info('[result-body-adapter-probe]', JSON.stringify({ node: process.version, physicalBytes: usage.physicalBytes,
        physicalSlots: usage.physicalSlots, elapsedMs: Math.round(performance.now() - began), eventLoopTicks: ticks,
        eventLoopDelayMaxMs: Number((delay.max / 1e6).toFixed(2)), simulatedIndexPayloadBytes,
        limitation: 'Body adapter only; receipt-array serialization is not a real Memento, SQLite or integrated mailbox measurement.' }));
    } finally { delay.disable(); clearInterval(timer); }
  }, 60000);
});

describe('optional result crash recovery never refuses task work', () => {
  it('a stale completion key does not disable disk recovery while the workspace lease is still current', async () => {
    const h = await fixture(); const notice = vi.fn(); let completionCurrent = true;
    const recovery = await ResultBodyRecovery.connect({ ...h.options, assertCurrent(candidate) {
      h.options.assertCurrent(candidate); if (candidate === key() && !completionCurrent) throw new Error('old completion');
    } }, { retainInConversationAndMemory() {}, notice });
    h.reservations.add(key()); completionCurrent = false;
    expect(await recovery.write(key(), 'late callback')).toBeUndefined(); expect(recovery.status.kind).toBe('disk');
    h.reservations.add(key(1)); expect(await recovery.write(key(1), 'current result')).toBeDefined(); expect(notice).not.toHaveBeenCalled();
  });
  it('one oversized/conflicting/unreserved result and a stale lease do not disable healthy recovery for the session', async () => {
    const h = await fixture(); const notice = vi.fn(); const retain = vi.fn();
    const recovery = await ResultBodyRecovery.connect(h.options, { retainInConversationAndMemory: retain, notice });
    h.reservations.add(key()); const ref = await recovery.write(key(), 'first'); expect(ref).toBeDefined();
    expect(await recovery.write(key(), 'different')).toBeUndefined();
    expect(await recovery.write(key(2), 'x'.repeat(65537))).toBeUndefined();
    expect(await recovery.write(key(3), 'no reservation')).toBeUndefined();
    expect(recovery.status.kind).toBe('disk'); expect(notice).not.toHaveBeenCalled();
    h.reservations.add(key(4)); expect(await recovery.write(key(4), 'still works')).toBeDefined();
    h.stale(); expect(await recovery.read(ref!)).toBeUndefined(); expect(recovery.status.kind).toBe('disk'); expect(notice).not.toHaveBeenCalled();
  });
  it.each(['missing', 'link', 'path', 'quota'] as const)('continues dispatch/settlement on %s problems, retains the body, and notices once', async failure => {
    const h = await fixture(); const retain = vi.fn(); const notice = vi.fn(); const statusChanged = vi.fn();
    let options = h.options;
    if (failure === 'missing') options = { ...options, storageUri: undefined };
    if (failure === 'link') options = { ...options, io: { ...fs, link: async () => { throw Object.assign(new Error('Bearer private-raw-error'), { code: 'ENOTSUP' }); } } };
    if (failure === 'path') {
      await fs.rename(h.root, h.root + '.saved'); await fs.symlink(h.root + '.saved', h.root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (failure === 'quota') for (let n = 0; n < 257; n++) await fs.writeFile(path.join(h.root, `${key(n)}.body`), 'orphan');
    const recovery = await ResultBodyRecovery.connect(options, { retainInConversationAndMemory: retain, notice, statusChanged });
    const dispatch = vi.fn(async () => 'dispatched'); await recovery.prepare();
    await expect(dispatch()).resolves.toBe('dispatched'); // No storage refusal propagates across the boundary.
    h.reservations.add(key(999));
    await expect(recovery.write(key(999), 'completed worker reply')).resolves.toBeUndefined();
    await recovery.prepare(); await recovery.write(key(999), 'completed worker reply');
    expect(retain).toHaveBeenCalledWith(key(999), 'completed worker reply');
    expect(recovery.status).toEqual({ kind: 'conversation-only', message: RESULT_RECOVERY_UNAVAILABLE });
    expect(notice).toHaveBeenCalledExactlyOnceWith(RESULT_RECOVERY_UNAVAILABLE);
    expect(JSON.stringify(statusChanged.mock.calls)).not.toContain('private-raw-error');
    if (failure === 'quota') expect(await fs.readdir(h.root)).toHaveLength(258); // No silent eviction.
  // The quota case creates 257 real files; Windows I/O under parallel tests can exceed 5s.
  }, 30_000);
  it('keeps the existing conversation/memory copy even when backing succeeds', async () => {
    const h = await fixture(); const retain = vi.fn(); const notice = vi.fn();
    const recovery = await ResultBodyRecovery.connect(h.options, { retainInConversationAndMemory: retain, notice });
    h.reservations.add(key());
    const ref = await recovery.write(key(), 'complete');
    expect(ref).toMatchObject({ key: key(), bytes: 8 }); expect(retain).toHaveBeenCalledExactlyOnceWith(key(), 'complete');
    await expect(recovery.read(ref!)).resolves.toBe('complete'); expect(notice).not.toHaveBeenCalled();
  });
});
