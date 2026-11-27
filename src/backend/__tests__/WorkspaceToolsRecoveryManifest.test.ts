/*
 * v0.9.110 R1: the host's own write, edit, create and delete tools, through the shared raw-v2 store, record each
 * request's restore manifest in the task history: the exact state before the request first changed each file and the
 * last state a change was read back as. Another window changing the same file is waited for at most five seconds,
 * then the change is refused as a retryable conflict; a holder proven gone is not waited for.
 */
import { createHash, randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../Checkpoints';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { FileWritePolicy, targetKey } from '../fileWritePolicy';
import { PreChangeCheckpoints } from '../PreChangeCheckpoints';
import { RawCheckpointStore, type RawCheckpointLimits } from '../RawCheckpointStore';
import { WorkspaceTools } from '../WorkspaceTools';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { GenerationLease } from '../../history/GenerationLease';
import { FileWriterLeases } from '../../history/FileWriterLeases';
import { HistoryService } from '../../history/HistoryService';
import { HistoryStore } from '../../history/HistoryStore';
import type { ProcessIdentityAdapter, ProcessLiveness } from '../../host/processIdentity/ProcessIdentityHost';

/** Each test's stores finish their queued writes before its folders are removed. */
const pendingIdle: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const idle of pendingIdle.splice(0)) await idle();
  await removeTemporaryFolders();
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

async function folder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

const liveness = new Map<number, ProcessLiveness>();
const identity: ProcessIdentityAdapter = {
  platform: 'linux', self: async () => 'unknown', identityOf: async () => 'unknown',
  liveness: async (records) => records.map((record) => liveness.get(record.pid) ?? 'unknown'),
};
const me = { pid: 1, startToken: '1', bootToken: 'boot', platform: 'linux' as const };

class State {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

async function host(options: { limits?: Partial<RawCheckpointLimits>; coordinated?: boolean } = {}) {
  liveness.set(1, 'alive');
  const root = await folder('unode-r1-ws-');
  const storage = await folder('unode-r1-storage-');
  const text = new CheckpointStore();
  const clock = { t: 0 };
  const history = new HistoryService({
    // As the extension opens it: paths compare as file writes compare them on this platform.
    open: () => HistoryStore.open({ directory: path.join(storage, 'history'), workspaceId: 'w'.repeat(8), writerId: randomUUID(),
      physicalKey: (physical) => targetKey(physical) }),
    state: new State(),
  });
  const checkpoints = new PreChangeCheckpoints({
    open: async () => {
      const directory = path.join(storage, 'raw-v2');
      const { store } = await RawCheckpointStore.open({
        directory, workspaceId: 'w',
        coordination: {
          lease: new GenerationLease(path.join(directory, 'lock'), { hostInstanceId: 'host-me', selfIdentity: async () => me, identity }),
          hostInstanceId: 'host-me', hostsGone: async () => new Set(),
        },
        ...(options.limits ? { limits: options.limits } : {}),
        onRemoved: (ids) => { text.dropRaw(ids); },
      });
      store.attachPeer(text);
      text.attachPeer(store);
      return store;
    },
    isRequestRunning: () => true,
    recovery: { captured: (capture) => history.recoveryCaptured(capture), settled: (settle) => history.recoverySettled(settle) },
  });
  const leasesRoot = path.join(storage, 'file-leases');
  const fileLeases = new FileWriterLeases(leasesRoot, {
    hostInstanceId: 'host-me', selfIdentity: async () => me, identity,
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
  });
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', isRequestRunning: () => true, checkpoints, fileLeases });
  const tools = new WorkspaceTools(
    root, new Set(['read', 'write']), 'dev', options.coordinated ? new OptimisticFileCoordinator() : undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (entry) => { text.record({ ...entry, agentName: 'dev', operation: entry.operation ?? 'write' }); },
    () => false, undefined, undefined, undefined, undefined, [], () => true, [root],
  );
  tools.setFileWrites(policy.forAgent({ agentId: 'dev', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
  const manifest = async () => {
    await history.flush();
    const store = (await history.store())!;
    await store.refresh();
    return store.recoveryManifest('r1');
  };
  const raw = async () => {
    const opened = await checkpoints.store();
    if ('unavailable' in opened) throw new Error(opened.unavailable);
    return opened.store;
  };
  /** Another window of this host holding a file's writer lease. */
  const otherWindow = (pid: number) => new FileWriterLeases(leasesRoot, {
    hostInstanceId: `host-${pid}`, selfIdentity: async () => ({ ...me, pid, startToken: String(pid) }), identity,
  });
  /** Every queued write of the stores has finished: nothing is still writing into the folders the test removes. */
  const idle = async () => {
    const opened = await checkpoints.store();
    if ('store' in opened) await opened.store.idle();
    await history.flush();
  };
  pendingIdle.push(idle);
  /** The manifest as a new window reads it from disk. */
  const reopenedManifest = async () => {
    await history.flush();
    const opened = await HistoryStore.open({ directory: path.join(storage, 'history'), workspaceId: 'w'.repeat(8), writerId: randomUUID(),
      physicalKey: (physical) => targetKey(physical) });
    try { return opened.recoveryManifest('r1'); } finally { await opened.dispose(); }
  };
  return { root, tools, history, manifest, reopenedManifest, raw, clock, otherWindow };
}

describe('R1: a request\'s restore manifest from real host changes', () => {
  it('records the exact before of each file (BOM, CRLF, binary, a create) and its last read-back after', async () => {
    const h = await host();
    const bomCrlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\r\nline two\r\n')]);
    await fs.writeFile(path.join(h.root, 'notes.txt'), bomCrlf);
    await fs.writeFile(path.join(h.root, 'logo.png'), BINARY);
    expect((await h.tools.run('read_file', { path: 'notes.txt' })).status).toBe('success');
    expect((await h.tools.run('write_file', { path: 'notes.txt', content: 'first rewrite\n' })).status).toBe('success');
    expect((await h.tools.run('read_file', { path: 'notes.txt' })).status).toBe('success');
    expect((await h.tools.run('apply_edit', { path: 'notes.txt', old_string: 'first', new_string: 'second' })).status).toBe('success');
    expect((await h.tools.run('write_file', { path: 'new/created.txt', content: 'brand new\n' })).status).toBe('success');
    expect((await h.tools.run('delete_file', { path: 'logo.png' })).status).toBe('success');
    const manifest = (await h.manifest())!;
    const byPath = new Map(manifest.files.map((file) => [file.displayPath.replace(/\\/g, '/'), file]));
    const notes = byPath.get('notes.txt')!;
    expect(notes.before).toMatchObject({ kind: 'file', sha256: sha(bomCrlf), size: bomCrlf.length });
    expect(notes.after).toEqual({ kind: 'file', sha256: sha('second rewrite\n'), size: Buffer.byteLength('second rewrite\n') });
    expect(notes.effectRefs.length).toBe(2);
    // The first before's bytes are kept exactly, and readable from the shared store.
    const store = await h.raw();
    expect(await store.readBefore((notes.before as { payloadRef: string }).payloadRef)).toEqual({ status: 'read', bytes: bomCrlf });
    expect(byPath.get('new/created.txt')).toMatchObject({ before: { kind: 'absent' }, coverage: 'exact',
      after: { kind: 'file', sha256: sha('brand new\n') } });
    const logo = byPath.get('logo.png')!;
    expect(logo.after).toEqual({ kind: 'absent' });
    expect(await store.readBefore((logo.before as { payloadRef: string }).payloadRef)).toEqual({ status: 'read', bytes: BINARY });
    expect(manifest.label).toBe('Revertible');
  });

  it('keeps working when no restore point can be kept, and says so in the manifest', async () => {
    const h = await host({ limits: { maxTotalBytes: 4 } });
    await fs.writeFile(path.join(h.root, 'big.txt'), 'more than four bytes\n');
    await h.tools.run('read_file', { path: 'big.txt' });
    expect((await h.tools.run('write_file', { path: 'big.txt', content: 'changed\n' })).status).toBe('success');
    expect(await fs.readFile(path.join(h.root, 'big.txt'), 'utf8')).toBe('changed\n');
    const manifest = (await h.manifest())!;
    expect(manifest.files[0]).toMatchObject({ coverage: 'unknown', before: { kind: 'file', sha256: sha('more than four bytes\n') } });
    expect(manifest.files[0].reason).toMatch(/no restore point was kept/);
    expect(manifest.label).toBe('Not revertible');
  });

  it('lists effects of commands and provider tools as not reversed', async () => {
    const h = await host();
    await h.tools.run('write_file', { path: 'a.txt', content: 'a\n' });
    h.history.effectsObserved('r1', 'dev', { coverage: 'partial', files: [{ path: 'b.txt', operation: 'write', evidence: 'native-observed' }],
      omitted: 0, droppedPaths: 0, grades: { hostVerified: 1, nativeObserved: 1, uncertain: 0 }, notCovered: true } as never);
    const manifest = (await h.manifest())!;
    expect(manifest.notReversed.map((entry) => entry.effect).sort()).toEqual(['command', 'native-tool']);
    expect(manifest.label).toBe('Partly revertible');
  });

  /** What the closeout reports of a provider's own change to `name`, with the host's key of the file. */
  const nativeChange = (h: { root: string; history: HistoryService }, name: string) => h.history.effectsObserved('r1', 'dev', {
    coverage: 'complete', files: [{ path: name, operation: 'write', evidence: 'native-observed' }], omitted: 0, droppedPaths: 0,
    grades: { hostVerified: 0, nativeObserved: 1, uncertain: 0 } } as never, { [name]: targetKey(path.join(h.root, name)) });

  for (const order of ['capture first', 'observation first'] as const) {
    it(`does not list a provider's change kept exactly as having no restore point (${order})`, async () => {
      const h = await host();
      await fs.writeFile(path.join(h.root, 'kept.txt'), 'before\n');
      await h.tools.run('read_file', { path: 'kept.txt' });
      if (order === 'observation first') { nativeChange(h, 'kept.txt'); await h.history.flush(); }
      expect((await h.tools.run('write_file', { path: 'kept.txt', content: 'after\n' })).status).toBe('success');
      if (order === 'capture first') { await h.history.flush(); nativeChange(h, 'kept.txt'); }
      const manifest = (await h.manifest())!;
      expect(manifest.files.map((file) => [file.displayPath, file.coverage])).toEqual([['kept.txt', 'exact']]);
      expect(manifest.notReversed).toEqual([]);
      expect(manifest.label).toBe('Revertible');
      expect((await h.reopenedManifest())).toMatchObject({ notReversed: [], label: 'Revertible' });
    });
  }

  it('still lists a provider\'s change of a file with no restore point, beside one that has one', async () => {
    const h = await host();
    await fs.writeFile(path.join(h.root, 'kept.txt'), 'before\n');
    await h.tools.run('read_file', { path: 'kept.txt' });
    expect((await h.tools.run('write_file', { path: 'kept.txt', content: 'after\n' })).status).toBe('success');
    nativeChange(h, 'kept.txt');
    nativeChange(h, 'native-only.txt');
    const manifest = (await h.manifest())!;
    expect(manifest.notReversed).toEqual([{ effect: 'native-tool', path: 'native-only.txt',
      reason: 'Changed by the provider\'s own file tool; no exact restore point was taken before it.' }]);
    expect(manifest.label).toBe('Partly revertible');
  });

  it('keeps the row of a provider\'s change when the file\'s restore point could not be kept exactly', async () => {
    const h = await host({ limits: { maxTotalBytes: 4 } });
    await fs.writeFile(path.join(h.root, 'big.txt'), 'more than four bytes\n');
    await h.tools.run('read_file', { path: 'big.txt' });
    expect((await h.tools.run('write_file', { path: 'big.txt', content: 'changed\n' })).status).toBe('success');
    nativeChange(h, 'big.txt');
    const manifest = (await h.manifest())!;
    expect(manifest.files[0].coverage).toBe('unknown');
    expect(manifest.notReversed.map((entry) => [entry.effect, entry.path])).toEqual([['native-tool', 'big.txt']]);
  });
});

describe('R1: a file refused as not text can still be replaced as a whole', () => {
  it('replaces a binary file after its read was refused, with the exact bytes kept as its restore point', async () => {
    const h = await host({ coordinated: true });
    await fs.writeFile(path.join(h.root, 'binary.bin'), BINARY);
    const read = await h.tools.run('read_file', { path: 'binary.bin' });
    expect(read.status).toBe('failed');
    expect(read.output).toMatch(/was not read as text\. No bytes were added to context\. It can still be replaced as a whole with write_file\.$/);
    expect(read.output).not.toContain('\u0000');
    const write = await h.tools.run('write_file', { path: 'binary.bin', content: 'now text\n' });
    expect(write.status).toBe('success');
    expect(await fs.readFile(path.join(h.root, 'binary.bin'), 'utf8')).toBe('now text\n');
    const file = (await h.manifest())!.files.find((entry) => entry.displayPath === 'binary.bin')!;
    expect(file).toMatchObject({ coverage: 'exact', before: { kind: 'file', sha256: sha(BINARY), size: BINARY.length } });
    expect(await (await h.raw()).readBefore((file.before as { payloadRef: string }).payloadRef)).toEqual({ status: 'read', bytes: BINARY });
  });

  it('refuses the replacement as stale when another writer changed the file after the refused read', async () => {
    const h = await host({ coordinated: true });
    await fs.writeFile(path.join(h.root, 'binary.bin'), BINARY);
    expect((await h.tools.run('read_file', { path: 'binary.bin' })).status).toBe('failed');
    const theirs = Buffer.concat([BINARY, Buffer.from([0x00, 0x01])]);
    await fs.writeFile(path.join(h.root, 'binary.bin'), theirs);
    const write = await h.tools.run('write_file', { path: 'binary.bin', content: 'mine\n' });
    expect(write.status).toBe('failed');
    expect(write.output).toMatch(/changed since you last read it/);
    expect(await fs.readFile(path.join(h.root, 'binary.bin'))).toEqual(theirs);
  });

  it('leaves text reads as they were: a text read still allows the write, an unread file is still refused', async () => {
    const h = await host({ coordinated: true });
    await fs.writeFile(path.join(h.root, 'plain.txt'), 'plain\n');
    await fs.writeFile(path.join(h.root, 'unread.bin'), BINARY);
    const read = await h.tools.run('read_file', { path: 'plain.txt' });
    expect(read.status).toBe('success');
    expect(read.output).not.toMatch(/replaced as a whole/);
    expect((await h.tools.run('write_file', { path: 'plain.txt', content: 'changed\n' })).status).toBe('success');
    const unread = await h.tools.run('write_file', { path: 'unread.bin', content: 'x\n' });
    expect(unread.status).toBe('failed');
    expect(unread.output).toMatch(/You have not read "[^"]*unread\.bin" yet/);
    // Text that is not UTF-8 is refused on the text path, which records no read.
    await fs.writeFile(path.join(h.root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const latin = await h.tools.run('read_file', { path: 'latin1.txt' });
    expect(latin.output).toMatch(/is not valid UTF-8 text and was not read\. No bytes were added to context\.$/);
    expect((await h.tools.run('write_file', { path: 'latin1.txt', content: 'x\n' })).output).toMatch(/You have not read/);
  });
});

describe('R1: another window changing the same file', () => {
  it('waits at most five seconds, then refuses the change as a retryable conflict and writes nothing', async () => {
    const h = await host();
    liveness.set(2, 'alive');
    await fs.writeFile(path.join(h.root, 'shared.txt'), 'original\n');
    await h.tools.run('read_file', { path: 'shared.txt' });
    const other = await h.otherWindow(2).acquire(path.join(h.root, 'shared.txt'), { waitMs: 0 });
    expect(other.status).toBe('held');
    const result = await h.tools.run('write_file', { path: 'shared.txt', content: 'mine\n' });
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Write blocked: another UnodeAi window is writing this file\. Nothing was written\./);
    expect(h.clock.t).toBeGreaterThanOrEqual(5_000);
    expect(h.clock.t).toBeLessThan(5_200);
    expect(await fs.readFile(path.join(h.root, 'shared.txt'), 'utf8')).toBe('original\n');
    // Other files are not held up.
    expect((await h.tools.run('write_file', { path: 'other.txt', content: 'fine\n' })).status).toBe('success');
    if (other.status === 'held') await other.release();
    expect((await h.tools.run('write_file', { path: 'shared.txt', content: 'mine\n' })).status).toBe('success');
  });

  it('says it cannot confirm the other writer has finished when its state is unknown', async () => {
    const h = await host();
    liveness.set(3, 'unknown');
    const other = await h.otherWindow(3).acquire(path.join(h.root, 'x.txt'), { waitMs: 0 });
    expect(other.status).toBe('held');
    const result = await h.tools.run('write_file', { path: 'x.txt', content: 'x\n' });
    expect(result.output).toMatch(/^Write blocked: UnodeAi cannot yet confirm that another writer of this file has finished/);
  });

  it('takes the file over at once from a writer proven gone', async () => {
    const h = await host();
    liveness.set(4, 'alive');
    const crashed = await h.otherWindow(4).acquire(path.join(h.root, 'y.txt'), { waitMs: 0 });
    expect(crashed.status).toBe('held');
    liveness.set(4, 'gone');
    expect((await h.tools.run('write_file', { path: 'y.txt', content: 'y\n' })).status).toBe('success');
    expect(h.clock.t).toBe(0);
  });
});
