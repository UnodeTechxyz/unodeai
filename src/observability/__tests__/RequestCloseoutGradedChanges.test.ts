/*
 * v0.9.97 P5: the Changes section of a Request summary, from the request's host effect ledger. Each test names the
 * design sentence it realises:
 *  - review resolution §2: the ledger tells `host-verified`, `native-observed` and `effect-uncertain` apart; approvals,
 *    attempts and model claims never count; the closeout says "this request", shows "host-verified files: N" and
 *    "CLI native observed: M" with unique relative paths and their grade; a native change never reads as "none"; with
 *    shell or opaque tools it says other file effects are not fully covered;
 *  - handoff §5: "none" only means no verified commit was observed; a later restore, delete or uncertain effect shows
 *    the final observed state; a rewrite or a retry is not counted twice.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CHANGED_FILES,
  parseRequestCloseoutRecord,
  projectRequestSummary,
  requestSummaryState,
  type RequestCloseoutRecordV1,
  type RequestSummarySection,
} from '../RequestCloseout';
import { noJobUsage } from '../JobOutcomeUsage';
import {
  RequestCloseoutAccumulator,
  RequestFileEffects,
  reviseForFileEffects,
  reviseForRestore,
} from '../../session/RequestCloseoutAccumulator';

const END = { terminal: { kind: 'answered' as const }, recordedAt: '2026-10-20T01:00:18.000Z', eventsCut: false };
const OK = { status: 'success' as const, observedBy: 'host' as const };

function turnOf(effects: RequestFileEffects, turnId = 'turn-1', requestId = 'req-1'): RequestCloseoutAccumulator {
  const turn = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'pm', originTurnId: 'turn-1', terminalTurnId: turnId }, effects);
  turn.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
  return turn;
}

function closed(effects: RequestFileEffects, turnId = 'turn-1', requestId = 'req-1'): RequestCloseoutRecordV1 {
  return turnOf(effects, turnId, requestId).finish(END)!;
}

function changesOf(record: RequestCloseoutRecordV1): RequestSummarySection {
  return projectRequestSummary(record, { usage: noJobUsage }).sections.find((section) => section.title === 'Changes')!;
}

function headlineOf(record: RequestCloseoutRecordV1): string[] {
  return projectRequestSummary(record, { usage: noJobUsage }).headline.map((segment) => segment.text);
}

const row = (section: RequestSummarySection, label: string) => section.rows.find((entry) => entry.label === label);

describe('the Changes section of a request', () => {
  it('shows host-verified and CLI native files apart, each path once with its grade', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'src/a.ts', key: 'k-a', operation: 'write', grade: 'host-verified' });
    effects.effect({ path: 'src/b.ts', key: 'k-b', operation: 'write', grade: 'native-observed' });
    effects.effect({ path: 'src/c.ts', key: 'k-c', operation: 'delete-file', grade: 'native-observed' });
    const record = closed(effects);
    expect(parseRequestCloseoutRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const section = changesOf(record);
    expect(row(section, 'Host-verified files')).toEqual({ label: 'Host-verified files', value: '1' });
    expect(row(section, 'CLI native observed')).toEqual({ label: 'CLI native observed', value: '2' });
    expect(row(section, 'Effect uncertain')).toBeUndefined();
    expect(section.items).toEqual([
      'src/a.ts (written, host-verified)',
      'src/b.ts (written, CLI native observed)',
      'src/c.ts (deleted, CLI native observed)',
    ]);
    expect(section.note).toContain('File changes UnodeAi observed in this request: its own turns and the work its teammates did for it.');
    expect(section.note).toContain('An approval, an attempt, or a reply that says a file was saved is not counted.');
    expect(section.note).toContain('That does not prove who wrote them.');
    expect(headlineOf(record)).toContain('3 files changed');
  });

  it('never says "none" of a request whose CLI changed a file: its count stands beside the verified one', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'notes.md', key: 'k', operation: 'write', grade: 'native-observed' });
    const record = closed(effects);
    const section = changesOf(record);
    expect(row(section, 'Host-verified files')?.value).toBe('none');
    expect(row(section, 'CLI native observed')?.value).toBe('1');
    expect(headlineOf(record)).toContain('1 file changed');
    expect(headlineOf(record).join(' ')).not.toContain('no verified file change observed');
    expect(requestSummaryState(record)).toBe('completed');
  });

  it('says "none" only of verified changes, and does not say nothing changed', () => {
    const record = closed(new RequestFileEffects());
    const section = changesOf(record);
    expect(row(section, 'Host-verified files')?.value).toBe('none');
    expect(row(section, 'CLI native observed')?.value).toBe('none');
    expect(section.note).toContain('"None" means only that no such change was observed.');
    expect(headlineOf(record)).toContain('no verified file change observed');
    expect(JSON.stringify(projectRequestSummary(record, { usage: noJobUsage }))).not.toContain('no workspace changes');
  });

  it('shows an uncertain effect as uncertain, with what to do', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'out/report.pdf', key: 'k', operation: 'write', grade: 'effect-uncertain' });
    const record = closed(effects);
    const section = changesOf(record);
    expect(row(section, 'Effect uncertain')).toEqual({ label: 'Effect uncertain', value: '1', tone: 'caution' });
    expect(section.items).toEqual(['out/report.pdf (written, effect uncertain)']);
    expect(section.note).toContain('Effect uncertain: the change may or may not have happened. Check the file before relying on it.');
    expect(projectRequestSummary(record, { usage: noJobUsage }).headline).toContainEqual({ text: '1 file changed, 1 uncertain', tone: 'caution' });
  });

  it('says that other file effects are not fully covered when a command or a native action ran in the request', () => {
    const effects = new RequestFileEffects();
    const turn = turnOf(effects);
    turn.toolResult('run_command', OK);
    const record = turn.finish(END)!;
    expect(record.observations.changes).toMatchObject({ coverage: 'partial', notCovered: true });
    const section = changesOf(record);
    expect(section.note).toContain('Other file effects are not fully covered: a command or a provider-native action ran in this request, and files it changed are not in this list.');
    expect(row(section, 'Change visibility')).toEqual({ label: 'Change visibility', value: 'partial', tone: 'caution' });
    expect(headlineOf(record)).toContain('no verified file change observed, other effects not covered');
  });

  it('counts a rewrite and a retry of one path once, as its last effect left it', () => {
    const effects = new RequestFileEffects();
    for (let attempt = 0; attempt < 3; attempt++) effects.effect({ path: 'src/a.ts', key: 'k', operation: 'write', grade: 'host-verified' });
    effects.effect({ path: 'src\\a.ts', key: 'k', operation: 'write', grade: 'host-verified' });
    expect(closed(effects).observations.changes).toEqual({
      coverage: 'complete',
      files: [{ path: 'src/a.ts', operation: 'write', evidence: 'host-verified' }],
      omitted: 0,
      droppedPaths: 0,
      grades: { hostVerified: 1, nativeObserved: 0, uncertain: 0 },
    });
    effects.effect({ path: 'src/a.ts', key: 'k', operation: 'delete-file', grade: 'host-verified' });
    expect(changesOf(closed(effects)).items).toEqual(['src/a.ts (deleted, host-verified)']);
  });

  it('counts a file it cannot show once, in its grade, and never lists it', () => {
    const effects = new RequestFileEffects();
    effects.effect({ key: 'outside-1', operation: 'write', grade: 'native-observed' });
    effects.effect({ key: 'outside-1', operation: 'write', grade: 'native-observed' });
    effects.effect({ path: '../elsewhere.txt', key: 'outside-2', operation: 'write', grade: 'host-verified' });
    const record = closed(effects);
    expect(record.observations.changes).toEqual({
      coverage: 'partial', files: [], omitted: 0, droppedPaths: 2, grades: { hostVerified: 1, nativeObserved: 1, uncertain: 0 },
    });
    expect(changesOf(record).note).toContain('2 changed paths could not be shown as relative to the agent\'s folder.');
  });

  it('counts the paths past the list bound in their grades, and lists the bound', () => {
    const effects = new RequestFileEffects();
    for (let index = 0; index < MAX_CHANGED_FILES + 3; index++) {
      effects.effect({ path: `src/f${index}.ts`, key: `k${index}`, operation: 'write', grade: index === 0 ? 'native-observed' : 'host-verified' });
    }
    const record = closed(effects);
    expect(record.observations.changes.files).toHaveLength(MAX_CHANGED_FILES);
    expect(record.observations.changes.omitted).toBe(3);
    expect(record.observations.changes.grades).toEqual({ hostVerified: MAX_CHANGED_FILES + 2, nativeObserved: 1, uncertain: 0 });
    expect(row(changesOf(record), 'Host-verified files')?.value).toBe(String(MAX_CHANGED_FILES + 2));
  });

  it('shows a restore of the person as the final state, and an unconfirmed restore as uncertain', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'a.txt', key: 'ka', operation: 'write', grade: 'host-verified' });
    effects.effect({ path: 'b.txt', key: 'kb', operation: 'write', grade: 'host-verified' });
    effects.effect({ path: 'c.txt', key: 'kc', operation: 'write', grade: 'native-observed' });
    expect(effects.restored('a.txt', 'restored')).toBe(true);
    expect(effects.restored('b.txt', 'removed')).toBe(true);
    expect(effects.restored('c.txt', 'uncertain')).toBe(true);
    expect(effects.restored('never-written.txt', 'restored')).toBe(false);
    const record = closed(effects);
    expect(changesOf(record).items).toEqual([
      'a.txt (written, host-verified; restored by you since)',
      'b.txt (written, host-verified; removed by your restore since)',
      'c.txt (written, effect uncertain; your restore of it was not confirmed)',
    ]);
    expect(record.observations.changes.grades).toEqual({ hostVerified: 2, nativeObserved: 0, uncertain: 1 });
    // A later effect of the request makes the file the request's again.
    effects.effect({ path: 'a.txt', key: 'ka', operation: 'write', grade: 'host-verified' });
    expect(changesOf(closed(effects)).items?.[0]).toBe('a.txt (written, host-verified)');
  });
});

describe('a graded list as stored', () => {
  const effects = new RequestFileEffects();
  effects.effect({ path: 'src/a.ts', key: 'k', operation: 'write', grade: 'host-verified' });
  const valid = closed(effects);
  const withChanges = (changes: Record<string, unknown>) => ({
    ...JSON.parse(JSON.stringify(valid)),
    observations: { ...JSON.parse(JSON.stringify(valid.observations)), changes },
  });

  it.each([
    ['grades that do not count every path once', { ...valid.observations.changes, grades: { hostVerified: 2, nativeObserved: 0, uncertain: 0 } }],
    ['a listed path without its grade', { ...valid.observations.changes, files: [{ path: 'src/a.ts', operation: 'write' }] }],
    ['a grade the listed paths exceed', { ...valid.observations.changes, grades: { hostVerified: 0, nativeObserved: 1, uncertain: 0 } }],
    ['one path twice', { coverage: 'complete', files: [{ path: 'a', operation: 'write', evidence: 'host-verified' }, { path: 'a', operation: 'write', evidence: 'host-verified' }], omitted: 0, droppedPaths: 0, grades: { hostVerified: 2, nativeObserved: 0, uncertain: 0 } }],
    ['an unknown grade', { ...valid.observations.changes, files: [{ path: 'src/a.ts', operation: 'write', evidence: 'model-said-so' }] }],
    ['an unconfirmed restore of a change still called verified', { ...valid.observations.changes, files: [{ path: 'src/a.ts', operation: 'write', evidence: 'host-verified', restore: 'uncertain' }] }],
    ['uncovered effects on a complete list', { ...valid.observations.changes, notCovered: true }],
    ['a partial list with nothing uncovered, left out or hidden', { ...valid.observations.changes, coverage: 'partial' }],
    ['a grade on a list of one turn\'s writes', { coverage: 'complete', files: [{ path: 'a', operation: 'write', evidence: 'host-verified' }], omitted: 0, droppedPaths: 0 }],
  ])('refuses %s', (_name, changes) => {
    expect(parseRequestCloseoutRecord(withChanges(changes as Record<string, unknown>))).toBeUndefined();
  });

  it('still reads a record written before the list was graded, and shows it as it was', () => {
    const legacy = withChanges({ coverage: 'complete', files: [{ path: 'src/a.ts', operation: 'write' }], omitted: 0, droppedPaths: 0 });
    const record = parseRequestCloseoutRecord(legacy)!;
    expect(record.observations.changes.grades).toBeUndefined();
    const section = changesOf(record);
    expect(row(section, 'Files changed')).toEqual({ label: 'Files changed', value: '1' });
    expect(section.items).toEqual(['src/a.ts (written)']);
  });
});

describe('a record of the request revised for its file effects', () => {
  it('takes the request\'s changes as they are now, under its next revision, and keeps its turn', () => {
    const effects = new RequestFileEffects();
    const record = closed(effects);
    effects.effect({ path: 'later.txt', key: 'k', operation: 'write', grade: 'host-verified' });
    const revised = reviseForFileEffects(record, 'req-1', effects.observation())!;
    expect(revised.revision).toBe(record.revision + 1);
    expect(revised.terminalTurnId).toBe(record.terminalTurnId);
    expect(revised.recordedAt).toBe(record.recordedAt);
    expect(revised.observations.changes.files).toEqual([{ path: 'later.txt', operation: 'write', evidence: 'host-verified' }]);
    // The same facts again are no revision.
    expect(reviseForFileEffects(revised, 'req-1', effects.observation())).toBeUndefined();
  });

  it('never revises a record of another request, nor one written before changes were graded', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'x.txt', key: 'k', operation: 'write', grade: 'host-verified' });
    const other = closed(new RequestFileEffects(), 'turn-9', 'req-2');
    expect(reviseForFileEffects(other, 'req-1', effects.observation())).toBeUndefined();
    const legacy = parseRequestCloseoutRecord({
      ...JSON.parse(JSON.stringify(other)),
      requestId: 'req-1',
      recordId: 'request-closeout:req-1:turn-9',
      observations: { ...other.observations, changes: { coverage: 'complete', files: [], omitted: 0, droppedPaths: 0 } },
    })!;
    expect(legacy).toBeDefined();
    expect(reviseForFileEffects(legacy, 'req-1', effects.observation())).toBeUndefined();
  });

  it('marks the restored path on a stored record, and changes its grade only for an unconfirmed restore', () => {
    const effects = new RequestFileEffects();
    effects.effect({ path: 'a.txt', key: 'ka', operation: 'write', grade: 'host-verified' });
    effects.effect({ path: 'b.txt', key: 'kb', operation: 'write', grade: 'native-observed' });
    const record = closed(effects);
    const restored = reviseForRestore(record, 'req-1', 'a.txt', 'restored')!;
    expect(restored.observations.changes.files[0]).toEqual({ path: 'a.txt', operation: 'write', evidence: 'host-verified', restore: 'restored' });
    expect(restored.observations.changes.grades).toEqual(record.observations.changes.grades);
    const unsure = reviseForRestore(restored, 'req-1', 'b.txt', 'uncertain')!;
    expect(unsure.observations.changes.files[1]).toEqual({ path: 'b.txt', operation: 'write', evidence: 'effect-uncertain', restore: 'uncertain' });
    expect(unsure.observations.changes.grades).toEqual({ hostVerified: 1, nativeObserved: 0, uncertain: 1 });
    expect(reviseForRestore(unsure, 'req-2', 'a.txt', 'removed')).toBeUndefined();
    expect(reviseForRestore(unsure, 'req-1', 'not-listed.txt', 'removed')).toBeUndefined();
  });
});
