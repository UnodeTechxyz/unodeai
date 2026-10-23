import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitCheckpointRestore,
  prepareCheckpointRestore,
  type CheckpointRestoreAuthority,
  type CheckpointRestoreHooks,
  type CheckpointRestoreRequest,
} from '../CheckpointRestore';

/**
 * The restore write itself (CHANGELOG [Unreleased], "A restore is a new write"; USAGE.md "Restoring a file"): it acts
 * only under the authority of now, only on the state UnodeAi recorded, and reports a write it cannot confirm as
 * uncertain rather than as nothing.
 */
const temps: string[] = [];
async function folder(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-restore-')));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function authority(roots: string[], over: Partial<{ trusted: boolean; dirty: string[] }> = {}) {
  const state = { trusted: over.trusted ?? true, dirty: over.dirty ?? [] };
  const value: CheckpointRestoreAuthority = {
    isTrusted: () => state.trusted,
    writeRoots: () => roots,
    hasUnsavedChanges: (file) => state.dirty.some((dirty) => path.resolve(dirty).toLowerCase() === path.resolve(file).toLowerCase()),
  };
  return { value, state };
}

function request(target: string, before: Buffer | null, currentAfter: Buffer | null): CheckpointRestoreRequest {
  return {
    target,
    content: before === null ? { kind: 'absent' } : { kind: 'bytes', bytes: before },
    expected: currentAfter === null ? { kind: 'absent' } : { kind: 'bytes', sha256: sha(currentAfter) },
  };
}

async function restore(req: CheckpointRestoreRequest, auth: CheckpointRestoreAuthority, hooks?: CheckpointRestoreHooks) {
  const preparation = await prepareCheckpointRestore(req, auth);
  if (preparation.status !== 'ready') {
    return preparation;
  }
  return commitCheckpointRestore(preparation.prepared, auth, hooks);
}

async function entries(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe('CheckpointRestore', () => {
  it('puts back the exact bytes, whatever they are', async () => {
    const root = await folder();
    const file = path.join(root, 'image.bin');
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x41, 0x0d, 0x0a]);
    const after = Buffer.from('replaced\r\n');
    await fs.writeFile(file, after);

    const outcome = await restore(request(file, original, after), authority([root]).value);

    expect(outcome).toEqual({ status: 'restored', physical: file, sha256: sha(original) });
    expect((await fs.readFile(file)).equals(original)).toBe(true);
    expect(await entries(root)).toEqual(['image.bin']);
  });

  it('deletes a file that did not exist before the change', async () => {
    const root = await folder();
    const file = path.join(root, 'created.md');
    await fs.writeFile(file, 'made by the agent');

    const outcome = await restore(request(file, null, Buffer.from('made by the agent')), authority([root]).value);

    expect(outcome).toEqual({ status: 'restored', physical: file, sha256: null });
    expect(await entries(root)).toEqual([]);
  });

  it('refuses a file outside the folders it may write in now', async () => {
    const allowed = await folder();
    const elsewhere = await folder();
    const file = path.join(elsewhere, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([allowed]).value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('outside the folders') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('refuses a path that leads out through a link', async () => {
    const root = await folder();
    const outside = await folder();
    await fs.writeFile(path.join(outside, 'a.txt'), 'after');
    await fs.symlink(outside, path.join(root, 'linked'), 'junction');
    const file = path.join(root, 'linked', 'a.txt');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value);

    expect(outcome).toMatchObject({ status: 'refused' });
    expect(await fs.readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('after');
  });

  it('refuses a path that now leads somewhere other than where the change was recorded', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(
      { ...request(file, Buffer.from('before'), Buffer.from('after')), physicalTarget: path.join(root, 'elsewhere', 'a.txt') },
      authority([root]).value,
    );

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('different place') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('refuses in an untrusted workspace', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root], { trusted: false }).value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('not trusted') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('refuses a file with unsaved editor changes', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root], { dirty: [file] }).value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('unsaved changes') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('refuses when the file no longer holds the recorded state', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'newer work');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('changed after UnodeAi last recorded it') });
    expect(await fs.readFile(file, 'utf8')).toBe('newer work');
  });

  it('refuses to delete a created file that is present again with other content, and to recreate over a new one', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'someone else made this');

    const deleting = await restore(request(file, null, Buffer.from('made by the agent')), authority([root]).value);
    const recreating = await restore(request(file, Buffer.from('original'), null), authority([root]).value);

    expect(deleting).toMatchObject({ status: 'refused' });
    expect(recreating).toMatchObject({ status: 'refused' });
    expect(await fs.readFile(file, 'utf8')).toBe('someone else made this');
  });

  it('refuses when what the file should hold is unknown', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(
      { target: file, content: { kind: 'bytes', bytes: Buffer.from('before') }, expected: { kind: 'unknown', reason: 'it cannot be told.' } },
      authority([root]).value,
    );

    expect(outcome).toEqual({ status: 'refused', reason: 'it cannot be told.' });
  });

  it('refuses to overwrite a file that has a second name', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');
    await fs.link(file, path.join(root, 'other-name.txt'));

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('hard link') });
    expect(await fs.readFile(path.join(root, 'other-name.txt'), 'utf8')).toBe('after');
  });

  it('refuses when the file changes while the decision is open, and keeps the change', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');
    const auth = authority([root]).value;
    const preparation = await prepareCheckpointRestore(request(file, Buffer.from('before'), Buffer.from('after')), auth);
    expect(preparation.status).toBe('ready');

    await fs.writeFile(file, 'edited while asked');
    let wroteAnything = false;
    const outcome = await commitCheckpointRestore((preparation as any).prepared, auth, {
      beforeCommit: async () => { wroteAnything = true; },
    });

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('changed while') });
    expect(await fs.readFile(file, 'utf8')).toBe('edited while asked');
    // The commit's first check refuses before the restore writes anything of its own.
    expect(wroteAnything).toBe(false);
  });

  it('refuses when trust is withdrawn while the decision is open', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');
    const { value, state } = authority([root]);
    const preparation = await prepareCheckpointRestore(request(file, Buffer.from('before'), Buffer.from('after')), value);

    state.trusted = false;
    const outcome = await commitCheckpointRestore((preparation as any).prepared, value);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('not trusted') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('checks again after its own file I/O, immediately before the rename', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value, {
      beforeCommit: async () => { await fs.writeFile(file, 'last-moment edit'); },
    });

    expect(outcome).toMatchObject({ status: 'refused' });
    expect(await fs.readFile(file, 'utf8')).toBe('last-moment edit');
    expect(await entries(root)).toEqual(['a.txt']);
  });

  it('checks again immediately before a delete', async () => {
    const root = await folder();
    const file = path.join(root, 'created.md');
    await fs.writeFile(file, 'made by the agent');

    const outcome = await restore(request(file, null, Buffer.from('made by the agent')), authority([root]).value, {
      beforeCommit: async () => { await fs.writeFile(file, 'rewritten just now'); },
    });

    expect(outcome).toMatchObject({ status: 'refused' });
    expect(await fs.readFile(file, 'utf8')).toBe('rewritten just now');
  });

  it('reports a failed rename as not committed only while the file is provably unchanged', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');
    const busy = Object.assign(new Error('busy'), { code: 'EPERM' });

    const unchanged = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value, {
      rename: async () => { throw busy; },
    });
    expect(unchanged).toMatchObject({ status: 'refused', reason: expect.stringContaining('The file is unchanged') });
    expect(await fs.readFile(file, 'utf8')).toBe('after');
    expect(await entries(root)).toEqual(['a.txt']);

    const changed = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value, {
      rename: async () => { await fs.writeFile(file, 'half'); throw busy; },
    });
    expect(changed).toMatchObject({ status: 'effect-uncertain', physical: file });
  });

  it('reports a read-back that does not hold the restored bytes as uncertain, and writes nothing again', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'after');

    const outcome = await restore(request(file, Buffer.from('before'), Buffer.from('after')), authority([root]).value, {
      afterCommit: async () => { await fs.writeFile(file, 'not what was restored'); },
    });

    expect(outcome).toMatchObject({ status: 'effect-uncertain', physical: file, reason: expect.stringContaining('does not hold the restored content') });
    expect(await fs.readFile(file, 'utf8')).toBe('not what was restored');
  });

  it('reports a delete whose file is still there as uncertain', async () => {
    const root = await folder();
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'made by the agent');

    const outcome = await restore(request(file, null, Buffer.from('made by the agent')), authority([root]).value, {
      unlink: async () => undefined,
    });

    expect(outcome).toMatchObject({ status: 'effect-uncertain', reason: expect.stringContaining('still there') });
  });

  it('recreates a missing folder for a deleted file, and removes it again when the restore is refused', async () => {
    const root = await folder();
    const file = path.join(root, 'gone', 'deeper', 'a.txt');
    const { value, state } = authority([root]);

    const refused = await restore(request(file, Buffer.from('before'), null), value, {
      beforeCommit: async () => { state.trusted = false; },
    });
    expect(refused).toMatchObject({ status: 'refused' });
    expect(await entries(root)).toEqual([]);

    state.trusted = true;
    const restored = await restore(request(file, Buffer.from('before'), null), value);
    expect(restored).toMatchObject({ status: 'restored' });
    expect(await fs.readFile(file, 'utf8')).toBe('before');
  });
});
