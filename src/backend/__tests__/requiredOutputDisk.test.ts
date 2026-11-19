import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markRequiredOutputs, outputsObservedOnDisk, requiredOutputPlaces, statPlace, type OutputKind } from '../requiredOutputDisk';

/*
 * v0.9.103 (field smoke of d71485c5; the Owner: fix): a required output a command made is observed on disk when it was
 * created or changed at its place after dispatch, as the kind the contract names. Codex's audit of 04be3005: a place is
 * looked at only where the teammate may write it; one on another computer is never looked at.
 */
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const folder = () => { const made = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'unode-output-disk-'))); folders.push(made); return made; };
const output = (outputId: string, at: string, required = true, kind: OutputKind = 'file') => ({ outputId, path: at, kind, required });
const anywhere = () => true;

describe('required outputs observed on disk (v0.9.103)', () => {
  it('a file created after the mark is observed; one there before and untouched is not; one changed is', () => {
    const root = folder();
    writeFileSync(path.join(root, 'kept.txt'), 'before');
    writeFileSync(path.join(root, 'changed.txt'), 'before');
    const bases = { contract: root, changes: root };
    const marks = markRequiredOutputs([output('new', 'new.txt'), output('kept', 'kept.txt'), output('changed', 'changed.txt')], bases, anywhere);
    expect(marks.map((mark) => mark.outputId)).toEqual(['new', 'kept', 'changed']);
    writeFileSync(path.join(root, 'new.txt'), 'made by a command');
    writeFileSync(path.join(root, 'changed.txt'), 'after, longer');
    expect(outputsObservedOnDisk(marks, ['new', 'kept', 'changed'], anywhere)).toEqual([
      { outputId: 'new', path: path.join(root, 'new.txt') },
      { outputId: 'changed', path: path.join(root, 'changed.txt') },
    ]);
    // Only the outputs asked about (those no file tool wrote) are judged.
    expect(outputsObservedOnDisk(marks, ['kept'], anywhere)).toEqual([]);
    // Without a mark from dispatch nothing is observed.
    expect(outputsObservedOnDisk(undefined, ['new'], anywhere)).toEqual([]);
  });

  it('a relative output is looked for in the contract folder and in the teammate\'s own; an optional output is not marked', () => {
    const contract = folder();
    const own = folder();
    expect(requiredOutputPlaces('out/a.txt', { contract, changes: own })).toEqual([path.join(contract, 'out', 'a.txt'), path.join(own, 'out', 'a.txt')]);
    const marks = markRequiredOutputs([output('a', 'a.txt'), output('b', 'b.txt', false)], { contract, changes: own }, anywhere);
    expect(marks.map((mark) => mark.outputId)).toEqual(['a']);
    writeFileSync(path.join(own, 'a.txt'), 'in the teammate\'s worktree');
    expect(outputsObservedOnDisk(marks, ['a'], anywhere)).toEqual([{ outputId: 'a', path: path.join(own, 'a.txt') }]);
  });

  // Codex's audit of 04be3005, finding 2.
  it('a folder never stands for a required file, nor a file for a required folder; a required folder made is observed', () => {
    const root = folder();
    const bases = { contract: root };
    const marks = markRequiredOutputs([output('report', 'report.txt'), output('site', 'site', true, 'directory'), output('logs', 'logs', true, 'directory')], bases, anywhere);
    mkdirSync(path.join(root, 'report.txt'));
    writeFileSync(path.join(root, 'site'), 'a file where a folder is required');
    mkdirSync(path.join(root, 'logs'));
    expect(outputsObservedOnDisk(marks, ['report', 'site', 'logs'], anywhere)).toEqual([{ outputId: 'logs', path: path.join(root, 'logs') }]);
  });

  // Codex's audit of 04be3005, finding 1.
  it('looks at no place the teammate may not write, at dispatch or at settlement', () => {
    const root = folder();
    const stat = vi.fn(statPlace);
    // Kept, unlooked: no `before` for it.
    expect(markRequiredOutputs([output('a', 'a.txt')], { contract: root }, () => false, stat, 1_000))
      .toEqual([{ outputId: 'a', kind: 'file', since: 1_000, places: [{ path: path.join(root, 'a.txt') }] }]);
    expect(stat).not.toHaveBeenCalled();
    // Writable at dispatch, no longer at settlement (a grant ended): not looked at again, not observed.
    const marks = markRequiredOutputs([output('a', 'a.txt')], { contract: root }, anywhere, stat);
    writeFileSync(path.join(root, 'a.txt'), 'made');
    stat.mockClear();
    expect(outputsObservedOnDisk(marks, ['a'], () => false, stat)).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    // A judgement that throws is no authority.
    expect(markRequiredOutputs([output('a', 'a.txt')], { contract: root }, () => { throw new Error('no view'); }, stat)[0].places)
      .toEqual([{ path: path.join(root, 'a.txt') }]);
    expect(stat).not.toHaveBeenCalled();
  });

  // Codex's audit of 2b57dbe4, finding 1: access granted during the task. The place was not looked at at dispatch, so
  // what counts is that it is now the right kind and was modified at or after dispatch.
  it('a place the teammate may write only after a grant during the task counts when it was made or changed since dispatch', () => {
    const root = folder();
    const old = path.join(root, 'old.txt');
    writeFileSync(old, 'there before the task');
    const past = new Date(Date.now() - 60_000);
    utimesSync(old, past, past);
    let granted = false;
    const mayLookAt = () => granted;
    const marks = markRequiredOutputs([output('made', 'made.txt'), output('old', 'old.txt'), output('wrong', 'wrong.txt')], { contract: root }, mayLookAt);
    expect(marks.flatMap((mark) => mark.places.map((place) => place.before))).toEqual([undefined, undefined, undefined]);
    writeFileSync(path.join(root, 'made.txt'), 'made by a command after the grant');
    mkdirSync(path.join(root, 'wrong.txt'));
    // Still ungranted at settlement: nothing observed.
    expect(outputsObservedOnDisk(marks, ['made', 'old', 'wrong'], mayLookAt)).toEqual([]);
    granted = true;
    // Granted: the file made since dispatch counts; the older untouched file and a folder at a file's place do not.
    expect(outputsObservedOnDisk(marks, ['made', 'old', 'wrong'], mayLookAt)).toEqual([{ outputId: 'made', path: path.join(root, 'made.txt') }]);
  });

  it('never looks at a place on another computer', () => {
    const stat = vi.fn(statPlace);
    const mayLookAt = vi.fn(anywhere);
    const unreachable = process.platform === 'win32'
      ? ['\\\\203.0.113.7\\share\\done.txt', '\\\\?\\UNC\\203.0.113.7\\share\\done.txt', '\\\\.\\pipe\\done']
      : ['/net/203.0.113.7/done.txt', '//203.0.113.7/share/done.txt'];
    for (const spelling of unreachable) {
      expect(requiredOutputPlaces(spelling, { contract: folder() }), spelling).toEqual([]);
      expect(markRequiredOutputs([output('x', spelling)], { contract: folder() }, mayLookAt, stat), spelling).toEqual([]);
    }
    expect(stat).not.toHaveBeenCalled();
    expect(mayLookAt).not.toHaveBeenCalled();
  });

  it('a place that cannot be looked at is left out at the mark and skipped at settlement', () => {
    const root = folder();
    const failing = () => { throw new Error('EACCES'); };
    expect(markRequiredOutputs([output('a', 'a.txt')], { contract: root }, anywhere, failing)).toEqual([]);
    const marks = markRequiredOutputs([output('a', 'a.txt')], { contract: root }, anywhere);
    writeFileSync(path.join(root, 'a.txt'), 'x');
    expect(outputsObservedOnDisk(marks, ['a'], anywhere, failing)).toEqual([]);
  });
});
