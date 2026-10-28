/*
 * v0.9.97 P5-F1: a new file whose write fails part way is removed again, and the write says "not changed" only when
 * the host then finds the path empty. Each case names the sentence it realises: handoff §4.2 ("when a failed commit
 * leaves something behind, report the true state"), handoff §4.3 ("effect-uncertain or a provable failure, never
 * 'nothing happened'") and USAGE "The changes of a request" ("Effect uncertain: ... the tool stopped part way").
 *
 * The seam: `fs/promises` as the host sees it, where only the named new file's exclusive open misbehaves (its write
 * lands two bytes and then fails, or another program's file appears and the open fails), only that file's removal can
 * be refused, and only the look after its failed write can fail. Everything else is the real file system.
 */
import type { FileHandle } from 'fs/promises';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostObservedFileEffect } from '../fileWritePolicy';
import { saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

const seam = vi.hoisted(() => ({
  name: undefined as string | undefined,
  /** The exclusive open fails after another program put its own file at the path. */
  foreignFile: false,
  refuseRemoval: false,
  /** The first look at the path after the write failed fails. */
  failLook: false,
  failed: false,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const named = (file: unknown) => seam.name !== undefined && path.basename(String(file)) === seam.name;
  return {
    ...actual,
    open: async (file: Parameters<typeof actual.open>[0], flags?: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) => {
      if (named(file) && flags === 'wx' && seam.foreignFile) {
        await actual.writeFile(file, 'theirs');
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      const handle = await actual.open(file, flags, mode);
      if (!named(file) || flags !== 'wx') return handle;
      return {
        writeFile: async (data: Buffer) => {
          await handle.write(Buffer.from(data).subarray(0, 2));
          seam.failed = true;
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        },
        datasync: () => handle.datasync(),
        close: () => handle.close(),
      } as unknown as FileHandle;
    },
    unlink: async (file: Parameters<typeof actual.unlink>[0]) => {
      if (named(file) && seam.refuseRemoval) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return actual.unlink(file);
    },
    lstat: (async (file: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
      if (named(file) && seam.failed && seam.failLook) {
        seam.failLook = false;
        throw Object.assign(new Error('the disk did not answer'), { code: 'EIO' });
      }
      return actual.lstat(file, options);
    }) as typeof actual.lstat,
  };
});

afterEach(async () => {
  Object.assign(seam, { name: undefined, foreignFile: false, refuseRemoval: false, failLook: false, failed: false });
  await removeTemporaryFolders();
});

async function writeHost() {
  const effects: HostObservedFileEffect[] = [];
  const h = await saveHost({ onEffect: (effect) => { effects.push(effect); } });
  return { ...h, effects, shown: () => effects.map(({ path: shown, operation, grade }) => ({ path: shown, operation, grade })) };
}

const UNCERTAIN = 'Error: the write to made/new.txt may have changed it, but the write failed part way (no space left on '
  + 'device) and UnodeAi could not confirm that the file it created was removed again. Read it before relying on it; its '
  + 'restore point is kept. Folders created for it: made.';

describe('a new file whose write fails part way', () => {
  it('is removed again, and the write is "not changed" once the host finds the path empty', async () => {
    const h = await writeHost();
    seam.name = 'new.txt';
    const result = await h.tools().run('write_file', { path: 'made/new.txt', content: 'hello' });
    expect(result).toMatchObject({ status: 'failed', output: 'Write blocked: made/new.txt was not changed: no space left on device.' });
    await expect(fs.lstat(path.join(h.root, 'made'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.effects).toEqual([]);
  });

  it('that cannot be removed again is an uncertain write: the model is told it may have changed, and what is left', async () => {
    const h = await writeHost();
    seam.name = 'new.txt';
    seam.refuseRemoval = true;
    const result = await h.tools().run('write_file', { path: 'made/new.txt', content: 'hello' });
    expect(result).toMatchObject({ status: 'failed', output: UNCERTAIN });
    expect(result.output).not.toContain('not changed');
    // What the failed write left is still there, and the folder made for it with it.
    expect(await fs.readFile(path.join(h.root, 'made', 'new.txt'), 'utf8')).toBe('he');
    expect(h.shown()).toEqual([{ path: 'made/new.txt', operation: 'write', grade: 'effect-uncertain' }]);
  });

  it('whose removal the host cannot then look at is an uncertain write too', async () => {
    const h = await writeHost();
    seam.name = 'new.txt';
    seam.failLook = true;
    const result = await h.tools().run('write_file', { path: 'made/new.txt', content: 'hello' });
    expect(result).toMatchObject({ status: 'failed', output: UNCERTAIN });
    expect(h.shown()).toEqual([{ path: 'made/new.txt', operation: 'write', grade: 'effect-uncertain' }]);
  });
});

describe('a new file whose exclusive open fails', () => {
  it('removes nothing: a file another program put at the path stays as it is', async () => {
    const h = await writeHost();
    seam.name = 'new.txt';
    seam.foreignFile = true;
    const result = await h.tools().run('write_file', { path: 'new.txt', content: 'hello' });
    expect(result).toMatchObject({ status: 'failed', output: 'Write blocked: new.txt was not changed: permission denied.' });
    expect(await fs.readFile(path.join(h.root, 'new.txt'), 'utf8')).toBe('theirs');
    expect(h.effects).toEqual([]);
  });
});
