import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceRecord, LeaseKind, LeaseRecord, ProcessIdentity } from '../contracts';
import { publishGeneration, readJournal, type JournalSpec } from '../generationJournal';
import { judgeLease, nodeInstanceFs } from '../instanceStore';
import { CREATED, cleanTemps, created, factsFor, fsError, kit, promoteVersion, recordingFs } from './instanceTestKit';

// The design these tests realise (the store design for immutable instances; the lease design as amended):
// - staging folders are created without creating any parent; promotion renames the checked payload to
//   `versions\<key>\` and then publishes its facts; an existing folder of that key is never replaced: the same
//   artifact counts as already promoted, any other is refused; a failed publication leaves an orphan folder;
// - a lease is created `wx` and flushed; only its owner rewrites it, by a temp file renamed over it; a lease is dead
//   only when its holder is dead and its child is `none` or dead, and a pending identity or a failed query is
//   unknown, which counts as alive;
// - work folders are `work\<storeId>\<token>\` with `cwd\`, `tmp\` and an empty `home\`;
// - usage counts regular files under `versions\` and `staging\`, never following a link.

afterEach(cleanTemps);

function journalOf(root: string): JournalSpec<InstanceRecord> {
  return { folder: path.join(root, 'manifests'), prefix: 'instance', parse: (value) => ({ ok: true, record: value as InstanceRecord }) };
}

// =============================================================================================
// Staging and promotion
// =============================================================================================

describe('createStaging()', () => {
  it('creates staging\\<token>\\ and payload\\ inside it, and names the artifact file', async () => {
    const { store } = kit();
    const ref = await created(store);
    const staging = store.createStaging(ref, 'c'.repeat(32));
    expect(staging).toEqual({
      storeId: ref.storeId,
      taskToken: 'c'.repeat(32),
      root: path.join(ref.root, 'staging', 'c'.repeat(32)),
      artifact: path.join(ref.root, 'staging', 'c'.repeat(32), 'artifact.part'),
      payload: path.join(ref.root, 'staging', 'c'.repeat(32), 'payload'),
    });
    expect(readdirSync(staging.root)).toEqual(['payload']);
    expect(() => store.createStaging(ref, 'c'.repeat(32))).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  });

  it('never creates a missing staging\\ folder again', async () => {
    const { store } = kit();
    const ref = await created(store);
    rmSync(path.join(ref.root, 'staging'), { recursive: true });
    expect(() => store.createStaging(ref, 'c'.repeat(32))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(path.join(ref.root, 'staging'))).toBe(false);
  });

  it('discards a staging folder best effort, leaving what Windows refuses', async () => {
    let refuse = true;
    const { fs } = recordingFs((call) => {
      if (call.op === 'unlink' && refuse && call.paths[0].endsWith('busy.dll')) { refuse = false; throw fsError('EBUSY'); }
    });
    const { store } = kit({ fs });
    const ref = await created(store);
    const staging = store.createStaging(ref, 'c'.repeat(32));
    writeFileSync(path.join(staging.payload, 'busy.dll'), 'x');
    await store.discardStaging(staging);
    expect(existsSync(path.join(staging.payload, 'busy.dll'))).toBe(true);
    await store.discardStaging(staging);
    expect(existsSync(staging.root)).toBe(false);
  });
});

describe('promote()', () => {
  it('moves the payload to versions\\<key>\\, publishes the facts, and discards its staging', async () => {
    const { fs, calls } = recordingFs();
    const { store } = kit({ fs });
    const ref = await created(store);
    calls.length = 0;
    const facts = factsFor('0.163.0');
    const result = await promoteVersion(store, ref, facts, { 'codex.exe': 'program', 'codex-path/rg.exe': 'helper' });
    expect(result).toMatchObject({ ok: true, key: facts.key, alreadyPromoted: false, snapshot: { generation: 2, record: { versions: { [facts.key]: facts } } } });
    const folder = store.versionFolder(ref, facts.key);
    expect(readFileSync(path.join(folder, 'codex-path', 'rg.exe'), 'utf8')).toBe('helper');
    expect(readdirSync(path.join(ref.root, 'staging'))).toEqual([]);
    // The rename comes before the publication of its facts.
    const order = calls.filter((call) => call.op === 'rename' || call.op === 'link').map((call) => call.op);
    expect(order).toEqual(['rename', 'link']);
  });

  it('refuses facts whose key is not the name of their own artifact, and a staging folder of another store', async () => {
    const { store } = kit();
    const a = await created(store);
    const b = await created(store);
    const facts = factsFor('0.163.0');
    const stagingA = store.createStaging(a, 'c'.repeat(32));
    await expect(store.promote(a, stagingA, { ...facts, key: factsFor('0.163.0', 'other').key })).rejects.toThrow(TypeError);
    await expect(store.promote(a, stagingA, { ...facts, version: '0.162.0' })).rejects.toThrow(TypeError);
    await expect(store.promote(b, stagingA, facts)).rejects.toThrow(TypeError);
    await expect(store.promote(a, { ...stagingA, payload: path.join(b.root, 'versions') }, facts)).rejects.toThrow(TypeError);
    expect(existsSync(stagingA.payload)).toBe(true);
    expect(store.listVersionFolders(a)).toEqual([]);
  });

  it('counts the same artifact promoted before as already promoted, and leaves that folder as it is', async () => {
    const { store } = kit();
    const ref = await created(store);
    const facts = factsFor('0.163.0');
    await promoteVersion(store, ref, facts, { 'codex.exe': 'first' });
    const again = await promoteVersion(store, ref, { ...facts, taskToken: 'b'.repeat(32) }, { 'codex.exe': 'second' });
    expect(again).toMatchObject({ ok: true, alreadyPromoted: true });
    expect(readFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'utf8')).toBe('first');
    expect(readdirSync(path.join(ref.root, 'staging'))).toEqual([]);
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.versions[facts.key].taskToken).toBe(facts.taskToken);
  });

  it('refuses another artifact under a key already recorded, renaming nothing', async () => {
    const { fs, calls } = recordingFs();
    const { store } = kit({ fs });
    const ref = await created(store);
    const facts = factsFor('0.163.0');
    // The same first 16 hex digits, so the same key; another full digest.
    const other = { ...facts, artifactSha256: `${facts.artifactSha256.slice(0, 16)}${'f'.repeat(48)}` };
    expect(other.key).toBe(facts.key);
    await promoteVersion(store, ref, facts, { 'codex.exe': 'first' });
    rmSync(store.versionFolder(ref, facts.key), { recursive: true });
    calls.length = 0;
    const result = await promoteVersion(store, ref, other, { 'codex.exe': 'second' });
    expect(result).toMatchObject({ ok: false, reason: 'different-artifact' });
    expect(calls.filter((call) => call.op === 'rename')).toEqual([]);
    expect(existsSync(store.versionFolder(ref, facts.key))).toBe(false);
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.versions[facts.key].artifactSha256).toBe(facts.artifactSha256);
  });

  it('refuses another artifact whose folder is already there, and replaces nothing', async () => {
    const { store } = kit();
    const ref = await created(store);
    const facts = factsFor('0.163.0');
    const other = { ...facts, artifactSha256: `${facts.artifactSha256.slice(0, 16)}${'f'.repeat(48)}` };
    await promoteVersion(store, ref, facts, { 'codex.exe': 'first' });
    expect(await promoteVersion(store, ref, other, { 'codex.exe': 'second' })).toMatchObject({ ok: false, reason: 'different-artifact' });
    expect(readFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'utf8')).toBe('first');
  });

  it('gives back the payload when another artifact is recorded while it moves, and the record keeps the other one', async () => {
    const facts = factsFor('0.163.0');
    const other = { ...facts, artifactSha256: `${facts.artifactSha256.slice(0, 16)}${'f'.repeat(48)}` };
    let competitor: (() => void) | undefined;
    const { fs } = recordingFs((call) => {
      if (call.op === 'rename' && competitor && call.paths[1].includes('versions')) { const run = competitor; competitor = undefined; run(); }
    });
    const { store } = kit({ fs });
    const ref = await created(store);
    competitor = () => {
      const current = readJournal(journalOf(ref.root));
      if (current.kind !== 'ok') throw new Error('setup');
      const { generation: _g, previousRecordDigest: _p, recordDigest: _d, ...content } = current.record as InstanceRecord & { recordDigest?: string };
      publishGeneration(journalOf(ref.root), current, { ...content, versions: { [other.key]: other } }, nodeInstanceFs);
    };
    const staging = store.createStaging(ref, 'c'.repeat(32));
    writeFileSync(path.join(staging.payload, 'codex.exe'), 'mine');
    expect(await store.promote(ref, staging, facts)).toMatchObject({ ok: false, reason: 'different-artifact' });
    expect(readFileSync(path.join(staging.payload, 'codex.exe'), 'utf8')).toBe('mine');
    expect(existsSync(store.versionFolder(ref, facts.key))).toBe(false);
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.versions[facts.key].artifactSha256).toBe(other.artifactSha256);
  });

  it('waits for the facts of a folder another promotion made, and replaces nothing when none come', async () => {
    const { store, sleeps } = kit();
    const ref = await created(store);
    const facts = factsFor('0.163.0');
    mkdirSync(store.versionFolder(ref, facts.key));
    writeFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'orphan');
    expect(await promoteVersion(store, ref, facts, { 'codex.exe': 'mine' })).toMatchObject({ ok: false, reason: 'rename-failed' });
    expect(sleeps).toEqual(Array(19).fill(50));
    expect(readFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'utf8')).toBe('orphan');
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.versions).toEqual({});
  });

  it('refuses another artifact whose facts another promotion publishes while it waits', async () => {
    const facts = factsFor('0.163.0');
    const other = { ...facts, artifactSha256: `${facts.artifactSha256.slice(0, 16)}${'f'.repeat(48)}` };
    let competitor: (() => void) | undefined;
    const { store } = kit({ sleep: async () => { const run = competitor; competitor = undefined; run?.(); } });
    const ref = await created(store);
    mkdirSync(store.versionFolder(ref, facts.key));
    writeFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'other');
    competitor = () => { void store.publish(ref, { label: 'other', apply: (current) => ({ ...current, versions: { [other.key]: other } }) }); };
    expect(await promoteVersion(store, ref, facts, { 'codex.exe': 'mine' })).toMatchObject({ ok: false, reason: 'different-artifact' });
    expect(readFileSync(path.join(store.versionFolder(ref, facts.key), 'codex.exe'), 'utf8')).toBe('other');
  });

  it('moves nothing while the manifest is unusable', async () => {
    const { store } = kit();
    const ref = await created(store);
    writeFileSync(path.join(ref.root, 'manifests', 'instance-0000000002.json'), '{');
    const staging = store.createStaging(ref, 'c'.repeat(32));
    writeFileSync(path.join(staging.payload, 'codex.exe'), 'x');
    expect(await store.promote(ref, staging, factsFor('0.163.0'))).toMatchObject({ ok: false, reason: 'store-unusable' });
    expect(existsSync(path.join(staging.payload, 'codex.exe'))).toBe(true);
  });

  it('reports a failed publication and leaves the folder without facts (an orphan, never launchable by itself)', async () => {
    let lose = false;
    const { fs } = recordingFs((call) => { if (call.op === 'link' && lose) throw fsError('EEXIST'); });
    const { store } = kit({ fs });
    const ref = await created(store);
    lose = true;
    const facts = factsFor('0.163.0');
    expect(await promoteVersion(store, ref, facts)).toMatchObject({ ok: false, reason: 'publish-failed' });
    expect(store.listVersionFolders(ref)).toEqual([facts.key]);
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.versions).toEqual({});
  });
});

// =============================================================================================
// Leases and their liveness
// =============================================================================================

describe('leases', () => {
  const key = factsFor('0.163.0').key;

  it('are created exclusively and flushed, with a pending child for a session or a probe and none otherwise', async () => {
    const { fs, calls } = recordingFs();
    const { store, processes } = kit({ fs });
    const ref = await created(store);
    const host = processes.start(100, CREATED.host);
    for (const kind of ['session', 'probe', 'download', 'maintenance'] as LeaseKind[]) {
      calls.length = 0;
      const lease = store.createLease(ref, key, kind, host);
      const file = path.join(ref.root, 'leases', key, `${lease.token}.json`);
      expect(calls.filter((call) => call.op === 'writeExclusive').map((call) => call.paths[0])).toEqual([file]);
      const record = JSON.parse(readFileSync(file, 'utf8')) as LeaseRecord;
      expect(record).toMatchObject({ leaseToken: lease.token, storeId: ref.storeId, key, kind, holder: host, child: kind === 'session' || kind === 'probe' ? 'pending' : 'none' });
    }
  });

  it('never overwrite an existing lease: a token that exists fails and the first lease stays', async () => {
    const { store, processes } = kit({ random: () => Buffer.alloc(16, 0x5a) });
    const ref = await created(store);
    expect(ref.storeId).toBe('5a'.repeat(16));
    const first = store.createLease(ref, key, 'session', processes.start(100, CREATED.host));
    const file = path.join(ref.root, 'leases', key, `${first.token}.json`);
    const before = readFileSync(file, 'utf8');
    expect(() => store.createLease(ref, key, 'download', processes.start(200, CREATED.other))).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('are not created when leases\\ is missing', async () => {
    const { store, processes } = kit();
    const ref = await created(store);
    rmSync(path.join(ref.root, 'leases'), { recursive: true });
    expect(() => store.createLease(ref, key, 'session', processes.start(100, CREATED.host))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('record the child by a temp file renamed over the lease, written by its owner only', async () => {
    const { fs, calls } = recordingFs();
    const { store, processes } = kit({ fs });
    const ref = await created(store);
    const lease = store.createLease(ref, key, 'session', processes.start(100, CREATED.host));
    calls.length = 0;
    store.recordLeaseChild(lease, { pid: 101, creation: 'pending' });
    store.recordLeaseChild(lease, { pid: 101, creation: CREATED.child });
    const file = path.join(ref.root, 'leases', key, `${lease.token}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ child: { pid: 101, creation: CREATED.child }, holder: { pid: 100 } });
    expect(readdirSync(path.dirname(file))).toEqual([`${lease.token}.json`]);
    const writes = calls.filter((call) => call.op === 'writeExclusive' || call.op === 'rename');
    expect(writes.map((call) => call.op)).toEqual(['writeExclusive', 'rename', 'writeExclusive', 'rename']);
    expect(writes[1].paths[1]).toBe(file);
    expect(path.basename(writes[0].paths[0])).toMatch(new RegExp(`^\\.${lease.token}\\.tmp-[0-9a-f]{32}$`));
  });

  it('are not rewritten by a child record when the lease file is damaged or belongs to another lease', async () => {
    const { store, processes } = kit();
    const ref = await created(store);
    const lease = store.createLease(ref, key, 'session', processes.start(100, CREATED.host));
    const other = store.createLease(ref, key, 'session', processes.start(200, CREATED.other));
    const file = path.join(ref.root, 'leases', key, `${lease.token}.json`);
    for (const content of ['{', readFileSync(path.join(ref.root, 'leases', key, `${other.token}.json`), 'utf8')]) {
      writeFileSync(file, content);
      expect(() => store.recordLeaseChild(lease, { pid: 101, creation: CREATED.child })).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(readdirSync(path.dirname(file)).sort()).toEqual([`${lease.token}.json`, `${other.token}.json`].sort());
    }
  });

  it('are not brought back by a child record after they were released', async () => {
    const { store, processes } = kit();
    const ref = await created(store);
    const lease = store.createLease(ref, key, 'session', processes.start(100, CREATED.host));
    store.releaseLease(lease);
    store.releaseLease(lease);
    expect(() => store.recordLeaseChild(lease, { pid: 101, creation: CREATED.child })).toThrow();
    expect(readdirSync(path.join(ref.root, 'leases', key))).toEqual([]);
  });
});

describe('lease liveness', () => {
  const key = factsFor('0.163.0').key;
  const HOLDER = 100;
  const CHILD = 101;

  type Side = 'alive' | 'dead' | 'pending' | 'none';
  async function judge(holder: Side, child: Side, query: 'ok' | 'answer' | 'throws' = 'ok') {
    const { store, processes } = kit();
    const ref = await created(store);
    const holderIdentity: ProcessIdentity = { pid: HOLDER, creation: holder === 'pending' ? 'pending' : CREATED.host };
    if (holder === 'alive') processes.start(HOLDER, CREATED.host);
    if (holder === 'dead') processes.start(HOLDER, CREATED.other); // the number now belongs to another process
    const lease = store.createLease(ref, key, child === 'none' ? 'download' : 'session', holderIdentity);
    if (child === 'alive' || child === 'dead') {
      store.recordLeaseChild(lease, { pid: CHILD, creation: CREATED.child });
      if (child === 'alive') processes.start(CHILD, CREATED.child);
    }
    processes.unavailable = query === 'ok' ? 'no' : query;
    return store.leaseLiveness(ref, key);
  }

  it.each([
    ['alive', 'none', 'alive'], ['alive', 'alive', 'alive'], ['alive', 'dead', 'alive'], ['alive', 'pending', 'alive'],
    ['dead', 'none', 'dead'], ['dead', 'alive', 'alive'], ['dead', 'dead', 'dead'], ['dead', 'pending', 'unknown'],
    ['pending', 'none', 'unknown'], ['pending', 'alive', 'alive'], ['pending', 'dead', 'unknown'], ['pending', 'pending', 'unknown'],
  ] as const)('holder %s, child %s: %s', async (holder, child, expected) => {
    expect(await judge(holder, child)).toBe(expected);
  });

  it.each([
    ['alive', 'none'], ['dead', 'none'], ['dead', 'dead'], ['alive', 'alive'],
  ] as const)('holder %s, child %s: unknown when the query fails or answers unavailable', async (holder, child) => {
    expect(await judge(holder, child, 'answer')).toBe('unknown');
    expect(await judge(holder, child, 'throws')).toBe('unknown');
  });

  it('judges one lease the same way without the store', () => {
    const answer = new Map([[HOLDER, CREATED.host]]);
    expect(judgeLease({ holder: { pid: HOLDER, creation: CREATED.host }, child: 'none' }, answer)).toBe('alive');
    expect(judgeLease({ holder: { pid: 7, creation: CREATED.host }, child: 'none' }, answer)).toBe('dead');
    expect(judgeLease({ holder: { pid: 7, creation: CREATED.host }, child: 'pending' }, answer)).toBe('unknown');
  });

  it('is dead without any lease, and asks nothing when every identity is pending', async () => {
    const { store, processes } = kit();
    const ref = await created(store);
    expect(await store.leaseLiveness(ref, key)).toBe('dead');
    store.createLease(ref, key, 'session', { pid: HOLDER, creation: 'pending' });
    expect(await store.leaseLiveness(ref, key)).toBe('unknown');
    expect(processes.calls).toEqual([]);
  });

  it('counts the most alive lease of a key', async () => {
    const { store, processes } = kit();
    const ref = await created(store);
    store.createLease(ref, key, 'download', { pid: 7, creation: CREATED.host });
    expect(await store.leaseLiveness(ref, key)).toBe('dead');
    store.createLease(ref, key, 'session', { pid: 8, creation: 'pending' });
    expect(await store.leaseLiveness(ref, key)).toBe('unknown');
    store.createLease(ref, key, 'download', processes.start(HOLDER, CREATED.host));
    expect(await store.leaseLiveness(ref, key)).toBe('alive');
  });

  it.each([
    ['an unparsable lease', (folder: string) => writeFileSync(path.join(folder, `${'d'.repeat(32)}.json`), '{')],
    ['a lease of another store', (folder: string) => writeFileSync(path.join(folder, `${'d'.repeat(32)}.json`), JSON.stringify({ leaseToken: 'd'.repeat(32), storeId: 'e'.repeat(32), key: path.basename(folder), kind: 'download', holder: { pid: 7, creation: CREATED.host }, child: 'none', createdAt: '2026-10-20T08:00:00.000Z' }))],
    ['a lease filed under another token', (folder: string) => writeFileSync(path.join(folder, `${'d'.repeat(32)}.json`), JSON.stringify({ leaseToken: 'f'.repeat(32), storeId: path.basename(path.dirname(path.dirname(folder))), key: path.basename(folder), kind: 'download', holder: { pid: 7, creation: CREATED.host }, child: 'none', createdAt: '2026-10-20T08:00:00.000Z' }))],
    ['a file that is not a lease', (folder: string) => writeFileSync(path.join(folder, 'notes.txt'), 'x')],
    ['a folder', (folder: string) => mkdirSync(path.join(folder, `${'d'.repeat(32)}.json`))],
    ['an oversized lease', (folder: string) => writeFileSync(path.join(folder, `${'d'.repeat(32)}.json`), 'x'.repeat(5000))],
  ])('counts %s as unknown', async (_label, plant) => {
    const { store } = kit();
    const ref = await created(store);
    const folder = path.join(ref.root, 'leases', key);
    mkdirSync(folder);
    plant(folder);
    expect(await store.leaseLiveness(ref, key)).toBe('unknown');
  });

  it('judges a temp file left by an interrupted rewrite by its content', async () => {
    const { store } = kit();
    const ref = await created(store);
    const lease = store.createLease(ref, key, 'download', { pid: 7, creation: CREATED.host });
    const file = path.join(ref.root, 'leases', key, `${lease.token}.json`);
    writeFileSync(path.join(ref.root, 'leases', key, `.${lease.token}.tmp-${'0'.repeat(32)}`), readFileSync(file));
    expect(await store.leaseLiveness(ref, key)).toBe('dead');
  });

  it('counts a lease folder that cannot be listed as unknown', async () => {
    const { fs } = recordingFs((call) => { if (call.op === 'readdir' && call.paths[0].includes(`${path.sep}leases${path.sep}`)) throw fsError('EACCES'); });
    const { store } = kit({ fs });
    const ref = await created(store);
    expect(await store.leaseLiveness(ref, key)).toBe('unknown');
  });
});

// =============================================================================================
// Usage and work folders
// =============================================================================================

describe('usageBytes()', () => {
  it('sums the regular files under versions\\ and staging\\, never through a link', async () => {
    const { store } = kit();
    const ref = await created(store);
    const facts = factsFor('0.163.0');
    await promoteVersion(store, ref, facts, { 'codex.exe': '12345', 'codex-path/rg.exe': '123' });
    const staging = store.createStaging(ref, 'c'.repeat(32));
    writeFileSync(staging.artifact, '1234567');
    const outside = path.join(path.dirname(ref.root), '..', 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(1000));
    symlinkSync(outside, path.join(staging.payload, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(ref.root, 'leases', 'not-counted'), Buffer.alloc(500));
    expect(await store.usageBytes(ref)).toBe(5 + 3 + 7);
  });
});

describe('work folders', () => {
  it('are work\\<storeId>\\<token>\\ with cwd, tmp and an empty home, created exclusively', async () => {
    const { store, roots } = kit();
    const ref = await created(store);
    const folder = store.createWorkFolder(ref, 'c'.repeat(32));
    expect(folder).toEqual({
      storeId: ref.storeId, token: 'c'.repeat(32),
      root: path.join(roots.work, ref.storeId, 'c'.repeat(32)),
      cwd: path.join(roots.work, ref.storeId, 'c'.repeat(32), 'cwd'),
      tmp: path.join(roots.work, ref.storeId, 'c'.repeat(32), 'tmp'),
      home: path.join(roots.work, ref.storeId, 'c'.repeat(32), 'home'),
    });
    expect(readdirSync(folder.root).sort()).toEqual(['cwd', 'home', 'tmp']);
    expect(readdirSync(folder.home)).toEqual([]);
    expect(store.createWorkFolder(ref, 'd'.repeat(32)).root).toBe(path.join(roots.work, ref.storeId, 'd'.repeat(32)));
    expect(() => store.createWorkFolder(ref, 'c'.repeat(32))).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    writeFileSync(path.join(folder.tmp, 'x'), 'x');
    await store.removeWorkFolder(folder);
    expect(existsSync(folder.root)).toBe(false);
  });

  it('refuses to remove a folder that is not the one its store id and token derive', async () => {
    const { store } = kit();
    const ref = await created(store);
    const folder = store.createWorkFolder(ref, 'c'.repeat(32));
    await expect(store.removeWorkFolder({ ...folder, root: ref.root })).rejects.toThrow(TypeError);
    expect(existsSync(ref.root)).toBe(true);
  });
});
