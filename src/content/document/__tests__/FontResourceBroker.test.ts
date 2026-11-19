import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontResourceBroker, type FontBrokerJob } from '../FontResourceBroker';

const io = vi.hoisted(() => ({ open: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: (...args: unknown[]) => io.open(...args), lstat: (...args: unknown[]) => io.lstat(...args),
    realpath: (...args: unknown[]) => io.realpath(...args) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const directories: string[] = [];
beforeEach(() => {
  io.open.mockReset().mockImplementation(actualFs.open); io.lstat.mockReset().mockImplementation(actualFs.lstat);
  io.realpath.mockReset().mockImplementation(actualFs.realpath);
});
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory); const rel = relative(resolve(tmpdir()), target);
    if (!isAbsolute(target) || !basename(target).startsWith('unode-font-race-') || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Unsafe temporary cleanup target');
    await actualFs.rm(target, { recursive: true, force: true });
  }
});
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(overrides: Partial<FontBrokerJob> = {}) {
  // Cleanup keeps the created spelling, because its guard is relative to tmpdir(). The candidate must equal its real
  // path, and a runner's TEMP can be an 8.3 short name.
  const created = await actualFs.mkdtemp(join(tmpdir(), 'unode-font-race-')); directories.push(created);
  const directory = await actualFs.realpath(created);
  const file = join(directory, 'font.ttf'); const bytes = Buffer.alloc(80); bytes.writeUInt32BE(0x10000); await actualFs.writeFile(file, bytes);
  const controller = new AbortController(); let current = true;
  const broker = new FontResourceBroker({ jobId: 'job', signal: controller.signal,
    isCurrent: () => current, candidates: [file], forbiddenRoots: [], ...overrides });
  return { directory, file, bytes, broker, controller, invalidate: () => { current = false; } };
}
function patchedStat<T extends object>(stat: T, values: object): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, values);
}

describe('font broker lifetime and filesystem races', () => {
  // v0.9.99: the broker has no deadline any more; Stop (abort) and a stale request still close it.
  it.each(['abort', 'stale'] as const)('does not open a resource after %s admission expires', async cause => {
    const f = await fixture({});
    if (cause === 'abort') f.controller.abort(); if (cause === 'stale') f.invalidate();
    expect(() => f.broker.issueCandidate(f.file)).toThrow('cancelled');
    expect(io.open).not.toHaveBeenCalled(); await f.broker.close();
  });
  it.each(['abort', 'stale'] as const)('closes the actual opened handle when %s arrives during read', async cause => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); let closed = false;
    io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      return { stat: () => handle.stat(), read: async (...readArgs: Parameters<typeof handle.read>) => {
        entered.resolve(); await release.promise; return handle.read(...readArgs);
      }, close: async () => { await handle.close(); closed = true; } };
    });
    const result = f.broker.read('job', f.broker.issueCandidate(f.file)).then(() => undefined, error => error);
    await entered.promise; if (cause === 'abort') f.controller.abort(); else f.invalidate();
    let stopped = false; const stopping = f.broker.close().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(closed).toBe(false);
    release.resolve(); expect(await result).toMatchObject({ code: 'cancelled' }); await stopping;
    expect(closed).toBe(true); expect(stopped).toBe(true);
  });
  it('refuses a concurrent read without consuming its token', async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args); return { stat: () => handle.stat(), close: () => handle.close(),
        read: async (...readArgs: Parameters<typeof handle.read>) => { entered.resolve(); await release.promise; return handle.read(...readArgs); } };
    });
    const first = f.broker.read('job', f.broker.issueCandidate(f.file)); const secondToken = f.broker.issueCandidate(f.file);
    await entered.promise; await expect(f.broker.read('job', secondToken)).rejects.toMatchObject({ code: 'font-resource-invalid' });
    release.resolve(); await first;
    await expect(f.broker.read('job', secondToken)).resolves.toMatchObject({ bytes: expect.any(ArrayBuffer) }); await f.broker.close();
  });
  it('refuses a symbolic resource and a changed real path before opening a handle', async () => {
    const f = await fixture(); const stat = await actualFs.lstat(f.file);
    io.lstat.mockResolvedValueOnce(patchedStat(stat, { isSymbolicLink: () => true }));
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'font-resource-invalid' });
    io.realpath.mockResolvedValueOnce(join(f.directory, 'replaced.ttf'));
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'font-resource-invalid' });
    expect(io.open).not.toHaveBeenCalled(); await f.broker.close();
  });
  it('detects an opened handle that differs from the earlier pathname identity and closes it', async () => {
    const f = await fixture(); const read = vi.fn(); const close = vi.fn();
    io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args); close.mockImplementation(() => handle.close());
      return { stat: async () => patchedStat(await handle.stat(), { ino: -1 }), read, close };
    });
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'font-resource-changed' });
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); await f.broker.close();
  });
  it('rejects oversized metadata before allocation/read and still closes the handle', async () => {
    const f = await fixture(); const read = vi.fn(); const close = vi.fn(); const size = 64 * 1024 * 1024 + 1;
    const stat = await actualFs.lstat(f.file); io.lstat.mockResolvedValueOnce(patchedStat(stat, { size }));
    io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args); close.mockImplementation(() => handle.close());
      return { stat: async () => patchedStat(await handle.stat(), { size }), read, close };
    });
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'font-budget' });
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); await f.broker.close();
  });
  it.each(['handle-time', 'path-time', 'path-identity', 'realpath'] as const)('refuses %s changing after bytes are read', async change => {
    const f = await fixture(); const close = vi.fn();
    if (change === 'handle-time') io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args); let stats = 0; close.mockImplementation(() => handle.close());
      return { stat: async () => { const stat = await handle.stat(); return ++stats === 2 ? patchedStat(stat, { mtimeMs: stat.mtimeMs + 1 }) : stat; },
        read: (...args: Parameters<typeof handle.read>) => handle.read(...args), close };
    });
    if (change === 'path-time' || change === 'path-identity') {
      io.lstat.mockImplementationOnce(actualFs.lstat).mockImplementationOnce(async (...args: Parameters<typeof actualFs.lstat>) => {
        const stat = await actualFs.lstat(...args); return patchedStat(stat, change === 'path-time' ? { ctimeMs: stat.ctimeMs + 1 } : { ino: -1 });
      });
    }
    if (change === 'realpath') io.realpath.mockImplementationOnce(actualFs.realpath).mockResolvedValueOnce(join(f.directory, 'changed.ttf'));
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'font-resource-changed' });
    if (change === 'handle-time') expect(close).toHaveBeenCalledOnce(); await f.broker.close();
  });
  it('never reports a quiescent close after the resource handle close was unconfirmed', async () => {
    const f = await fixture();
    io.open.mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args); return { stat: () => handle.stat(), read: (...args: Parameters<typeof handle.read>) => handle.read(...args),
        close: async () => { await handle.close(); throw new Error('simulated close acknowledgement loss'); } };
    });
    await expect(f.broker.read('job', f.broker.issueCandidate(f.file))).rejects.toMatchObject({ code: 'render-stop-unconfirmed' });
    await expect(f.broker.close()).rejects.toMatchObject({ code: 'render-stop-unconfirmed' });
    expect(() => f.broker.issueCandidate(f.file)).toThrow('cancelled');
  });
  it('does not leak filesystem exception text in a document error', async () => {
    const f = await fixture(); io.open.mockRejectedValueOnce(new Error('private-font-path-and-account'));
    const error = await f.broker.read('job', f.broker.issueCandidate(f.file)).catch(error => error);
    expect(error.code).toBe('font-resource-invalid'); expect(String(error)).not.toContain('private-font-path'); await f.broker.close();
  });
  it('bounds the number of issued capabilities, even before any read starts', async () => {
    const f = await fixture(); for (let i = 0; i < 64; i++) expect(f.broker.issueCandidate(f.file)).toEqual(expect.any(String));
    expect(() => f.broker.issueCandidate(f.file)).toThrow('font-budget'); expect(io.open).not.toHaveBeenCalled(); await f.broker.close();
  });
});
