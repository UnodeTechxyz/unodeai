/*
 * v0.9.97 P5: what the host's own file tools tell the request effect ledger, on a real file system. Each case names
 * the sentence it realises: review resolution §2 ("the effect ledger ... distinguishes host-verified, native-observed
 * and effect-uncertain ... approvals, attempts and model claims never count"), file effects design §4 ("track
 * successful commits and later observed restores/deletes, retain request attribution across delegates, and never
 * count attempts"), handoff §5 ("a rewrite is not counted twice") and the P4 audit request's open question 6 (a saved
 * attachment is a host-verified write of the request, with its relative path).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTargetState, type HostObservedFileEffect } from '../fileWritePolicy';
import { admitUserTurn, attachment, attachmentIds, PNG, saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

async function ledgerHost(options: Parameters<typeof saveHost>[0] = {}) {
  const effects: HostObservedFileEffect[] = [];
  const h = await saveHost({ ...options, onEffect: (effect) => { effects.push(effect); } });
  return { ...h, effects, shown: () => effects.map(({ path: shownPath, operation, grade, requestId }) => ({ path: shownPath, operation, grade, requestId })) };
}

describe('host commits reach the request effect ledger as they were read back', () => {
  it('a write is host-verified, named relative to the agent\'s folder, for the request it was made for', async () => {
    const h = await ledgerHost();
    expect(await h.tools().run('write_file', { path: 'src/a.ts', content: 'export const a = 1;\n' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('apply_edit', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' })).toMatchObject({ status: 'success' });
    expect(h.shown()).toEqual([
      { path: 'src/a.ts', operation: 'write', grade: 'host-verified', requestId: 'r1' },
      { path: 'src/a.ts', operation: 'write', grade: 'host-verified', requestId: 'r1' },
    ]);
    expect(h.effects[0]).toMatchObject({ agentId: 'dev', key: expect.any(String) });
  });

  it('a write that leaves the file as it was is no effect of the request', async () => {
    const h = await ledgerHost();
    await fs.writeFile(path.join(h.root, 'same.txt'), 'as it is\n');
    h.state.request = 'r1';
    expect(await h.tools().run('read_file', { path: 'same.txt' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('write_file', { path: 'same.txt', content: 'as it is\n' })).toMatchObject({ status: 'success' });
    expect(h.effects).toEqual([]);
  });

  it('a delete the host then finds done is a host-verified removal, of a file or of a folder', async () => {
    const h = await ledgerHost();
    expect(await h.tools().run('write_file', { path: 'tmp/x.txt', content: 'x' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('write_file', { path: 'old.txt', content: 'old' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('delete_file', { path: 'old.txt' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('delete_dir', { path: 'tmp' })).toMatchObject({ status: 'success' });
    expect(h.shown().slice(2)).toEqual([
      { path: 'old.txt', operation: 'delete-file', grade: 'host-verified', requestId: 'r1' },
      { path: 'tmp', operation: 'delete-directory', grade: 'host-verified', requestId: 'r1' },
    ]);
  });

  it('a write it cannot confirm is effect-uncertain, never a written file', async () => {
    let reads = 0;
    const h = await ledgerHost({
      readState: async (physical) => {
        const real = await readTargetState(physical);
        // The plan's look, the lock's, the commit's two; the fifth is the read-back, which here finds other bytes.
        return ++reads === 5 && real.state.exists ? { state: { ...real.state, sha256: 'f'.repeat(64) } } : real;
      },
    });
    await fs.writeFile(path.join(h.root, 'a.bin'), Buffer.from([0, 1, 2, 3]));
    const result = await h.tools().run('write_file', { path: 'a.bin', content: 'after' });
    expect(result.output).toContain('may have changed it');
    expect(h.shown()).toEqual([{ path: 'a.bin', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' }]);
  });

  it('a write that stops part way with an error is uncertain when the file then differs, and no effect when it does not', async () => {
    for (const changedMeanwhile of [true, false]) {
      let failing = false;
      let change: (() => Promise<void>) | undefined;
      // Once the restore point is kept, the commit's own first look fails with an error, not with a reason.
      const h = await ledgerHost({
        trusted: () => { if (failing) throw new Error('trust lookup failed'); return true; },
        duringCapture: async () => { if (failing) return; failing = true; await change?.(); },
      });
      const file = path.join(h.root, 'a.txt');
      await fs.writeFile(file, 'before');
      if (changedMeanwhile) change = () => fs.writeFile(file, 'changed meanwhile');
      expect((await h.tools().run('write_file', { path: 'a.txt', content: 'after' })).status).not.toBe('success');
      expect(h.shown(), String(changedMeanwhile)).toEqual(changedMeanwhile
        ? [{ path: 'a.txt', operation: 'write', grade: 'effect-uncertain', requestId: 'r1' }]
        : []);
    }
  });

  it('a denied write and a refused one are no effect: an approval or an attempt counts nothing', async () => {
    const h = await ledgerHost({ ask: true, approve: async () => 'deny' });
    expect((await h.tools().run('write_file', { path: 'denied.txt', content: 'no' })).status).toBe('refused');
    expect((await h.tools().run('write_file', { path: '../outside.txt', content: 'no' })).status).not.toBe('success');
    expect(h.effects).toEqual([]);
  });

  it('a saved attachment is a host-verified write of the request, with its relative path', async () => {
    const h = await ledgerHost();
    const sources = await admitUserTurn(h.assets, [attachment('logo.png', 'image/png', 'image', PNG)]);
    const [id] = attachmentIds(sources);
    const saved = await h.tools('dev', sources).run('save_attachment', { asset_id: id, path: 'assets/logo.png' });
    expect(saved.status).toBe('success');
    expect(h.shown()).toEqual([{ path: 'assets/logo.png', operation: 'write', grade: 'host-verified', requestId: 'r1' }]);
    // Saving the same bytes again changes nothing, and is no second effect.
    expect((await h.tools('dev', sources).run('save_attachment', { asset_id: id, path: 'assets/logo.png' })).status).toBe('success');
    expect(h.effects).toHaveLength(1);
  });

  it('counts a change for the request it was planned for, when the agent\'s request moves on while it waits', async () => {
    const h = await ledgerHost({
      ask: true,
      approve: async () => {
        // The person answers after the agent's turn has moved on to another request.
        h.state.request = 'r2';
        return 'once';
      },
    });
    expect(await h.tools().run('write_file', { path: 'planned.txt', content: 'x' })).toMatchObject({ status: 'success' });
    expect(h.shown()).toEqual([{ path: 'planned.txt', operation: 'write', grade: 'host-verified', requestId: 'r1' }]);
  });

  it('names a file outside the agent\'s own folder by no path: it is counted, never shown', async () => {
    const h = await ledgerHost({ base: (root) => path.join(root, 'agent') });
    await fs.mkdir(path.join(h.root, 'agent'), { recursive: true });
    expect(await h.tools().run('write_file', { path: 'agent/in.txt', content: 'in' })).toMatchObject({ status: 'success' });
    expect(await h.tools().run('write_file', { path: 'top.txt', content: 'out' })).toMatchObject({ status: 'success' });
    expect(h.shown()).toEqual([
      { path: 'in.txt', operation: 'write', grade: 'host-verified', requestId: 'r1' },
      { path: undefined, operation: 'write', grade: 'host-verified', requestId: 'r1' },
    ]);
  });
});
