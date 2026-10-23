/*
 * v0.9.97 P5-F1: a host delete tells the model it deleted something only when the host's own look afterwards finds
 * the path empty, and the request's effect ledger is told the same result. Each case names the sentence it realises:
 * handoff §3 ("a success receipt comes only from the final disk check"), handoff §4.3 ("a check that fails after the
 * change is effect-uncertain or a provable failure, never 'nothing happened'; do not blindly write the old version
 * back to hide the failure"), review resolution §2 (the ledger tells host-verified and effect-uncertain apart) and
 * USAGE "The changes of a request" ("Effect uncertain: the change may or may not have happened").
 *
 * The seam: the first look at the target that finds nothing there is the host's look right after its removal (every
 * look before it finds the file or the folder). There another program puts something at the path, or the look fails,
 * before the host sees the result. No timing is involved.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { noJobUsage } from '../../observability/JobOutcomeUsage';
import { projectRequestSummary, type RequestSummarySection } from '../../observability/RequestCloseout';
import { RequestCloseoutAccumulator, RequestFileEffects } from '../../session/RequestCloseoutAccumulator';
import { readTargetState, type HostObservedFileEffect, type ObservedTarget } from '../fileWritePolicy';
import { saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

/** At the host's look after the removal of `name`, `meanwhile` acts first: it puts something there, or throws. */
function afterRemovalOf(name: string, meanwhile: (physical: string) => Promise<void>) {
  let acted = false;
  return async (physical: string): Promise<ObservedTarget> => {
    const seen = await readTargetState(physical);
    if (acted || seen.state.exists || path.basename(physical) !== name) return seen;
    acted = true;
    await meanwhile(physical);
    return readTargetState(physical);
  };
}

async function deleteHost(readState?: (physical: string) => Promise<ObservedTarget>) {
  const effects: HostObservedFileEffect[] = [];
  const h = await saveHost({ ...(readState ? { readState } : {}), onEffect: (effect) => { effects.push(effect); } });
  return { ...h, effects };
}

/** The Changes section a closeout of the request makes from the effects the host reported. */
function changesOf(effects: readonly HostObservedFileEffect[]): RequestSummarySection {
  const ledger = new RequestFileEffects();
  for (const effect of effects) ledger.effect(effect);
  const turn = new RequestCloseoutAccumulator({ requestId: 'r1', rootAgentId: 'dev', originTurnId: 't1', terminalTurnId: 't1' }, ledger);
  turn.route({ agentId: 'dev', backend: 'openai-compatible', model: 'm' });
  const record = turn.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-20T01:00:00.000Z', eventsCut: false })!;
  return projectRequestSummary(record, { usage: noJobUsage }).sections.find((section) => section.title === 'Changes')!;
}

const row = (section: RequestSummarySection, label: string) => section.rows.find((entry) => entry.label === label)?.value;

describe('delete_file says "Deleted" only when the host then finds the file gone', () => {
  it('a delete the host then finds done: "Deleted", and one host-verified removal on the card', async () => {
    const h = await deleteHost();
    await fs.writeFile(path.join(h.root, 'old.txt'), 'old');
    const result = await h.tools().run('delete_file', { path: 'old.txt' });
    expect(result).toMatchObject({ status: 'success', output: 'Deleted old.txt.' });
    expect(h.effects.map(({ path: shown, operation, grade }) => ({ path: shown, operation, grade })))
      .toEqual([{ path: 'old.txt', operation: 'delete-file', grade: 'host-verified' }]);
    const changes = changesOf(h.effects);
    expect(changes.items).toEqual(['old.txt (deleted, host-verified)']);
    expect(row(changes, 'Host-verified files')).toBe('1');
    expect(row(changes, 'Effect uncertain')).toBeUndefined();
  });

  it('a file another program puts at the path between the removal and the read-back: not confirmed, uncertain once, nothing removed again or put back', async () => {
    const h = await deleteHost(afterRemovalOf('old.txt', (physical) => fs.writeFile(physical, 'theirs, written meanwhile')));
    const file = path.join(h.root, 'old.txt');
    await fs.writeFile(file, 'old');
    const result = await h.tools().run('delete_file', { path: 'old.txt' });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('Error: the delete of old.txt is not confirmed: after the removal, a file of 25 bytes is at that '
      + 'path, holding other content than before. UnodeAi did not remove it again or put anything back; its restore point '
      + 'is kept. Look at it before relying on it.');
    expect(result.output).not.toContain('Deleted');
    // The file found there is left as it is: not deleted again, not overwritten with what the delete removed.
    expect(await fs.readFile(file, 'utf8')).toBe('theirs, written meanwhile');
    // The model and the request's ledger are told the same: one uncertain removal, no verified one beside it.
    expect(h.effects.map(({ path: shown, operation, grade, requestId }) => ({ path: shown, operation, grade, requestId })))
      .toEqual([{ path: 'old.txt', operation: 'delete-file', grade: 'effect-uncertain', requestId: 'r1' }]);
    const changes = changesOf(h.effects);
    expect(changes.items).toEqual(['old.txt (deleted, effect uncertain)']);
    expect(row(changes, 'Host-verified files')).toBe('none');
    expect(row(changes, 'Effect uncertain')).toBe('1');
    // What the delete removed is still kept, unsettled, so the person can still compare and restore it.
    const store = await h.rawStore();
    const [entry] = store.list();
    expect(await store.readBefore(entry.id)).toEqual({ status: 'read', bytes: Buffer.from('old') });
    expect(entry.after).toBeUndefined();
    expect(h.text.list().map((change) => [change.operation, change.raw?.id])).toEqual([['delete-file', entry.id]]);
  });

  it('a file still at the path holding what it held before is not confirmed either, and is uncertain on the card', async () => {
    // The removal may not have taken (a name that only goes once another program lets go of it), or the same bytes were
    // put back meanwhile: either way the host cannot say the file was deleted, nor that nothing happened.
    const h = await deleteHost(afterRemovalOf('same.txt', (physical) => fs.writeFile(physical, 'kept')));
    const file = path.join(h.root, 'same.txt');
    await fs.writeFile(file, 'kept');
    const result = await h.tools().run('delete_file', { path: 'same.txt' });
    expect(result.status).toBe('failed');
    expect(result.output).toContain('not confirmed: after the removal, a file of 4 bytes is at that path, holding what it held before.');
    expect(result.output).not.toContain('Deleted');
    expect(await fs.readFile(file, 'utf8')).toBe('kept');
    expect(h.effects.map(({ operation, grade }) => ({ operation, grade }))).toEqual([{ operation: 'delete-file', grade: 'effect-uncertain' }]);
    expect(changesOf(h.effects).items).toEqual(['same.txt (deleted, effect uncertain)']);
  });

  it('a look after the removal that fails: not confirmed, and uncertain on the card', async () => {
    const h = await deleteHost(afterRemovalOf('gone.txt', async () => { throw new Error('the disk did not answer'); }));
    await fs.writeFile(path.join(h.root, 'gone.txt'), 'gone');
    const result = await h.tools().run('delete_file', { path: 'gone.txt' });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('Error: the delete of gone.txt is not confirmed: after the removal, UnodeAi could not look at '
      + 'that path (the disk did not answer). UnodeAi did not remove it again or put anything back; its restore point is '
      + 'kept. Look at it before relying on it.');
    expect(h.effects.map(({ path: shown, operation, grade }) => ({ path: shown, operation, grade })))
      .toEqual([{ path: 'gone.txt', operation: 'delete-file', grade: 'effect-uncertain' }]);
    expect(row(changesOf(h.effects), 'Effect uncertain')).toBe('1');
    const store = await h.rawStore();
    expect(store.list().map((entry) => entry.after)).toEqual([undefined]);
  });

  it('a refused delete stays a refusal and counts nothing', async () => {
    const effects: HostObservedFileEffect[] = [];
    // A file outside Git the agent did not read needs the person's decision for this delete; the person says no.
    const h = await saveHost({ decide: async () => 'deny', onEffect: (effect) => { effects.push(effect); } });
    await fs.writeFile(path.join(h.root, 'keep.txt'), 'keep');
    const result = await h.tools().run('delete_file', { path: 'keep.txt' });
    expect(result.status).toBe('refused');
    expect(await fs.readFile(path.join(h.root, 'keep.txt'), 'utf8')).toBe('keep');
    expect(effects).toEqual([]);
  });
});

describe('delete_dir says "Deleted directory" only when the host then finds the folder gone', () => {
  it('a folder the host then finds gone: "Deleted directory", and one host-verified removal', async () => {
    const h = await deleteHost();
    await fs.mkdir(path.join(h.root, 'build'));
    await fs.writeFile(path.join(h.root, 'build', 'out.js'), 'x');
    const result = await h.tools().run('delete_dir', { path: 'build' });
    expect(result).toMatchObject({ status: 'success', output: 'Deleted directory build (1 entry).' });
    expect(h.effects.map(({ path: shown, operation, grade }) => ({ path: shown, operation, grade })))
      .toEqual([{ path: 'build', operation: 'delete-directory', grade: 'host-verified' }]);
  });

  it('a folder another program makes at the path between the removal and the read-back: not confirmed, uncertain once, not removed again', async () => {
    const h = await deleteHost(afterRemovalOf('build', async (physical) => {
      await fs.mkdir(physical);
      await fs.writeFile(path.join(physical, 'theirs.js'), 'theirs');
    }));
    await fs.mkdir(path.join(h.root, 'build'));
    await fs.writeFile(path.join(h.root, 'build', 'out.js'), 'x');
    const result = await h.tools().run('delete_dir', { path: 'build' });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('Error: the delete of the directory build is not confirmed: after the removal, a folder is at '
      + 'that path. UnodeAi did not remove it again. Look at it before relying on it.');
    expect(result.output).not.toContain('Deleted');
    expect(await fs.readdir(path.join(h.root, 'build'))).toEqual(['theirs.js']);
    expect(h.effects.map(({ path: shown, operation, grade, requestId }) => ({ path: shown, operation, grade, requestId })))
      .toEqual([{ path: 'build', operation: 'delete-directory', grade: 'effect-uncertain', requestId: 'r1' }]);
    const changes = changesOf(h.effects);
    expect(changes.items).toEqual(['build (folder deleted, effect uncertain)']);
    expect(row(changes, 'Host-verified files')).toBe('none');
    expect(row(changes, 'Effect uncertain')).toBe('1');
  });

  it('a look after the folder\'s removal that fails: not confirmed, and uncertain', async () => {
    const h = await deleteHost(afterRemovalOf('tmp', async () => { throw new Error('the disk did not answer'); }));
    await fs.mkdir(path.join(h.root, 'tmp'));
    const result = await h.tools().run('delete_dir', { path: 'tmp' });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('Error: the delete of the directory tmp is not confirmed: after the removal, UnodeAi could not '
      + 'look at that path (the disk did not answer). UnodeAi did not remove it again. Look at it before relying on it.');
    expect(h.effects.map(({ operation, grade }) => ({ operation, grade }))).toEqual([{ operation: 'delete-directory', grade: 'effect-uncertain' }]);
  });
});
