import { describe, expect, it } from 'vitest';
import { RequestCloseoutAccumulator, RequestFileEffects } from '../RequestCloseoutAccumulator';
import { parseRequestCloseoutRecord } from '../../observability/RequestCloseout';
import { ACTIVITY_TOOLS, MAX_ACTIVITY_CALLS, MAX_ACTIVITY_PATHS, activityTool,
  interruptedTurnSummary, ongoingTurnSummary, parseTurnActivity, unavailableTurnActivity, activityPath } from '../../observability/TurnActivity';
import type { TurnInterruptionV1 } from '../../backend/TurnInterruption';

const identity = { requestId: 'request', rootAgentId: 'pm', originTurnId: 'turn-1', terminalTurnId: 'turn-1' };
const interruption: TurnInterruptionV1 = { schemaVersion: 1, kind: 'connection-lost', phase: 'reading-response', retry: 'after-tool', attempts: 2 };
const end = { terminal: { kind: 'failed' as const, failure: 'turn-error' as const }, recordedAt: '2026-10-25T00:00:00.000Z', eventsCut: true, interruption };
const ok = { status: 'success' as const, observedBy: 'host' as const };
const failed = { status: 'failed' as const, observedBy: 'host' as const, failureKind: 'error' as const };
const refused = { status: 'refused' as const, observedBy: 'host' as const, reason: 'capability' as const };
function make(turn = 'turn-1', shared = new RequestFileEffects()) {
  const accumulator = new RequestCloseoutAccumulator({ ...identity, terminalTurnId: turn }, shared);
  accumulator.route({ agentId: 'pm', backend: 'openai-compat' });
  return accumulator;
}

describe('ITR-b bounded per-turn closeout facts, not request-wide work', () => {
  it('reads live progress without freezing it, leaking raw prose, or claiming interruption', () => {
    const a = make(); a.beginTurnActivity(); a.activityToolStarted('read', 'read_file');
    const snapshot = a.snapshotTurnActivity()!;
    const first = ongoingTurnSummary(snapshot);
    expect(first).toContain('This task is still running.'); expect(first).toContain('read_file (1)');
    expect(first).not.toMatch(/interrupted|send "continue"/);
    snapshot.tools[0].success = 100;
    a.toolResult('read_file', ok, 'read'); a.activityFileRead('file.ts', 'turn-1');
    a.activityFileEffect({ path: 'maybe.ts', key: 'private-key', operation: 'write', grade: 'effect-uncertain' }, 'turn-1');
    a.activityFileEffect({ path: 'confirmed.ts', key: 'other-private-key', operation: 'write', grade: 'host-verified' }, 'turn-1');
    a.activityFileEffect({ path: 'reported.ts', key: 'cli-private-key', operation: 'write', grade: 'native-observed' }, 'turn-1');
    const second = ongoingTurnSummary(a.snapshotTurnActivity());
    expect(second).toContain('read_file: 1 succeeded'); expect(second).toContain('Files read: file.ts.');
    expect(second).not.toContain('100'); expect(second).not.toContain('read_file (1)');
    expect(second).toContain('maybe.ts (change not confirmed)');
    expect(second).toContain('confirmed.ts (confirmed by UnodeAi)');
    expect(second).toContain('reported.ts (reported by the CLI)');
    expect(second).not.toContain('private-key');
    for (const tool of ['dispatch_task', 'collect_ready_tasks', 'close_assignment', 'record_task_disposition']) {
      a.activityToolStarted(tool, tool); a.toolResult(tool, ok, tool);
      expect(ongoingTurnSummary(a.snapshotTurnActivity())).toContain(tool + ': 1 succeeded');
    }
    a.activityToolStarted('later', 'run_command'); a.toolResult('run_command', ok, 'later');
    expect(a.freezeTurnActivity(false)?.tools).toContainEqual({ tool: 'run_command', success: 1, refused: 0, failed: 0, unfinished: 0 });
    expect(ongoingTurnSummary()).toContain('Progress details are not available');
    expect(ongoingTurnSummary({ ...unavailableTurnActivity(), reads: ['file\nfalse.ts'] })).not.toContain('false.ts');
  });
  it.each(['safe\nHost-verified: injected.txt', 'safe\rfalse.txt', 'safe\tfalse.txt', 'safe\u0001false.txt', 'safe\u202efalse.txt', 'safe\u2066false.txt', 'safe\u2028false.txt', 'safe\u2029false.txt'])
  ('rejects control/format characters before a path enters host summaries, parsing or portable evidence', path => {
    expect(activityPath(path)).toBeUndefined();
    const a = make(); a.beginTurnActivity(); a.activityFileRead(path, 'turn-1');
    a.activityFileEffect({ path, key: 'physical', operation: 'write', grade: 'host-verified' }, 'turn-1');
    const record = a.finish(end)!;
    const activity = (record as any).turnActivity;
    expect(interruptedTurnSummary(interruption, activity)).not.toContain(path);
    const valid = unavailableTurnActivity();
    expect(parseTurnActivity({ ...valid, reads: [path] })).toBeUndefined();
    expect(parseTurnActivity({ ...valid, changes: [{ path, operation: 'write', evidence: 'host-verified' }] })).toBeUndefined();
  });
  it('records paired tool outcomes, actual supplied read/effect facts and typed decisions without any prose', () => {
    const a = make();
    a.beginTurnActivity();
    a.activityToolStarted('read-1', 'read_file'); a.toolResult('read_file', ok, 'read-1');
    a.activityFileRead('src/a.ts', 'turn-1');
    a.activityToolStarted('write-1', 'write_file'); a.toolResult('write_file', ok, 'write-1');
    // A successful write tool alone is NOT a file effect.
    a.activityToolStarted('todo-1', 'update_todos'); a.toolResult('update_todos', ok, 'todo-1');
    a.activityToolStarted('refused-1', 'run_command'); a.toolResult('run_command', refused, 'refused-1');
    a.activityToolStarted('failed-1', 'search_files'); a.toolResult('search_files', failed, 'failed-1');
    a.activityToolStarted('pending-1', 'assign_task');
    a.activityDisposition('needs-rework'); a.activityDisposition('accepted-with-caveat');
    a.delegationReceipt({ accepted: 2, refused: 1, pending: 1 });
    a.activityFileEffect({ path: 'src/b.ts', key: 'private-physical-key', operation: 'write', grade: 'effect-uncertain' }, 'turn-1');
    const record = a.finish(end)!;
    expect(record.interruption).toEqual(interruption);
    const activity = record.observations.turnActivity!;
    expect(activity).toMatchObject({ coverage: 'partial', reads: ['src/a.ts'], todoUpdates: 1, lastUnfinished: 'assign_task',
      dispatch: { accepted: 2, refused: 1, pending: 1 }, changes: [{ path: 'src/b.ts', operation: 'write', evidence: 'effect-uncertain' }] });
    expect(activity.tools).toContainEqual({ tool: 'read_file', success: 1, refused: 0, failed: 0, unfinished: 0 });
    expect(activity.tools).toContainEqual({ tool: 'run_command', success: 0, refused: 1, failed: 0, unfinished: 0 });
    expect(activity.tools).toContainEqual({ tool: 'search_files', success: 0, refused: 0, failed: 1, unfinished: 0 });
    expect(activity.decisions).toEqual([{ disposition: 'needs-rework', count: 1 }, { disposition: 'accepted-with-caveat', count: 1 }]);
    const summary = interruptedTurnSummary(interruption, activity);
    expect(summary).toContain('The connection to the model provider was interrupted while the reply was being received.');
    expect(summary).toContain('src/a.ts'); expect(summary).toContain('effect-uncertain');
    expect(summary).not.toContain('private-physical-key');
    expect(summary).toContain('These counts do not establish current worker status.');
    expect(summary).toContain('No automatic resend was made because an operation had already started.');
    expect(summary).not.toContain('verified successfully');
  });

  it('never borrows cumulative or delegate effects for this turn and requires an exact captured origin', () => {
    const shared = new RequestFileEffects();
    const first = make('turn-1', shared); first.beginTurnActivity();
    shared.effect({ path: 'old.ts', key: 'old', operation: 'write', grade: 'host-verified' });
    first.activityFileEffect({ path: 'old.ts', key: 'old', operation: 'write', grade: 'host-verified' }, 'turn-1');
    const frozen = first.finish(end)!;
    const second = make('turn-2', shared); second.beginTurnActivity();
    shared.effect({ path: 'delegate.ts', key: 'delegate', operation: 'write', grade: 'native-observed' });
    expect(second.activityFileEffect({ path: 'delegate.ts', key: 'delegate', operation: 'write', grade: 'native-observed' }, 'delegate-turn')).toBe(false);
    expect(second.activityFileRead('old.ts', 'turn-1')).toBe(false);
    second.activityFileEffect({ path: 'new.ts', key: 'new', operation: 'write', grade: 'host-verified' }, 'turn-2');
    const record = second.finish(end)!;
    expect(record.observations.changes.files.map(file => file.path)).toEqual(['old.ts', 'delegate.ts']);
    expect(record.observations.turnActivity?.changes.map(file => file.path)).toEqual(['new.ts']);
    expect(record.observations.turnActivity?.reads).toEqual([]);
    expect(interruptedTurnSummary(interruption, record.observations.turnActivity)).not.toMatch(/old\.ts|delegate\.ts/);
    expect(frozen.observations.turnActivity?.changes.map(file => file.path)).toEqual(['old.ts']);
  });

  it('does not count duplicate, mismatched or orphan results twice, and leaves unfinished work explicit', () => {
    const a = make();
    a.activityToolStarted('call', 'read_file'); a.activityToolStarted('call', 'write_file');
    a.toolResult('write_file', ok, 'call');
    a.toolResult('read_file', ok, 'call'); a.toolResult('read_file', ok, 'call');
    a.toolResult('read_file', ok, 'orphan');
    a.activityToolStarted('unfinished', 'write_file');
    const activity = a.freezeTurnActivity(true)!;
    expect(activity.tools).toEqual([{ tool: 'read_file', success: 1, refused: 0, failed: 0, unfinished: 0 },
      { tool: 'write_file', success: 0, refused: 0, failed: 0, unfinished: 1 }]);
    expect(activity.omitted.events).toBe(4);
    expect(activity.lastUnfinished).toBe('write_file');
    expect(activity.coverage).toBe('partial');
  });

  it('freezes only once and returns detached records; late events do not decorate another terminal', () => {
    const a = make(); a.activityToolStarted('call', 'read_file');
    const first = a.freezeTurnActivity(true)!;
    a.toolResult('read_file', ok, 'call'); a.activityFileRead('late.ts', 'turn-1');
    a.activityDisposition('accepted'); a.delegationReceipt({ accepted: 100, refused: 0, pending: 0 });
    first.tools[0].success = 100;
    const second = a.freezeTurnActivity(false)!;
    expect(second.tools[0]).toMatchObject({ success: 0, unfinished: 1 });
    expect(second.reads).toEqual([]); expect(second.decisions).toEqual([]); expect(second.dispatch).toBeUndefined();
  });

  it('bounds tracked identities and paths; omitted native or unlisted work is explicitly partial', () => {
    const a = make();
    for (let index = 0; index < MAX_ACTIVITY_CALLS + 3; index++) {
      a.activityToolStarted(`call-${index}`, 'read_file'); a.toolResult('read_file', ok, `call-${index}`);
    }
    for (let index = 0; index < MAX_ACTIVITY_PATHS + 3; index++) {
      a.activityFileRead(`src/${index}.ts`, 'turn-1');
      a.activityFileEffect({ path: `src/${index}.ts`, key: String(index), operation: 'write', grade: 'native-observed' }, 'turn-1');
    }
    const activity = a.freezeTurnActivity(false)!;
    expect(activity.tools[0].success).toBe(MAX_ACTIVITY_CALLS);
    expect(activity.reads).toHaveLength(MAX_ACTIVITY_PATHS); expect(activity.changes).toHaveLength(MAX_ACTIVITY_PATHS);
    expect(activity).toMatchObject({ coverage: 'partial', omitted: { events: 6, reads: 3, changes: 3 } });
  });

  it('uses fixed tool vocabulary, not native/MCP names, and never equates search with a file read', () => {
    const a = make();
    a.activityToolStarted('call', 'mcp__private_server_with_key__PRIVATE_TOOL');
    a.toolResult('mcp__private_server_with_key__PRIVATE_TOOL', { status: 'success', observedBy: 'provider' }, 'call');
    a.activityToolStarted('search', 'search_files'); a.toolResult('search_files', ok, 'search');
    a.activityToolStarted('todos', 'update_todos'); a.toolResult('update_todos', { status: 'success', observedBy: 'provider' }, 'todos');
    const activity = a.freezeTurnActivity(false)!;
    expect(activity).toMatchObject({ coverage: 'partial', reads: [], todoUpdates: 0 });
    expect(activity.tools[0].tool).toBe('native-tool');
    expect(JSON.stringify(activity)).not.toMatch(/PRIVATE|private_server/);
    expect(ACTIVITY_TOOLS.map(activityTool)).toEqual(ACTIVITY_TOOLS);
  });

  it('refuses absolute/escaping/overlong paths, preserving grade differences for actual per-turn effects', () => {
    const a = make(); a.beginTurnActivity();
    for (const path of ['/private/absolute', 'C:\\private\\absolute', '../escape', 'src/../../escape', 'x'.repeat(241)]) {
      expect(a.activityFileRead(path, 'turn-1')).toBe(false);
      expect(a.activityFileEffect({ path, key: path, operation: 'write', grade: 'effect-uncertain' }, 'turn-1')).toBe(false);
    }
    a.activityFileEffect({ path: 'src/a.ts', key: 'a', operation: 'write', grade: 'host-verified' }, 'turn-1');
    a.activityFileEffect({ path: 'src/a.ts', key: 'a', operation: 'write', grade: 'effect-uncertain' }, 'turn-1');
    const activity = a.freezeTurnActivity(true)!;
    expect(activity.changes).toEqual([{ path: 'src/a.ts', operation: 'write', evidence: 'effect-uncertain' }]);
    expect(activity.omitted).toMatchObject({ reads: 5, changes: 5 });
  });

  it('keeps legacy fields absent, round-trips the new extensions, and salvages valid core when optional facts are damaged', () => {
    const legacy = make().finish({ ...end, interruption: undefined })!;
    expect(legacy).not.toHaveProperty('interruption'); expect(legacy.observations).not.toHaveProperty('turnActivity');
    const a = make(); a.beginTurnActivity();
    const record = a.finish(end)!;
    expect(parseRequestCloseoutRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const bad = parseRequestCloseoutRecord({ ...record, interruption: { ...interruption, kind: 'PRIVATE_UNKNOWN' },
      observations: { ...record.observations, turnActivity: { coverage: 'complete', text: 'PRIVATE_TEXT' } } })!;
    expect(bad).toBeDefined(); expect(bad.terminal).toEqual(end.terminal);
    expect(bad).not.toHaveProperty('interruption');
    expect(bad.observations.turnActivity).toEqual(unavailableTurnActivity());
    expect(interruptedTurnSummary(interruption, bad.observations.turnActivity)).toContain('observations for this turn are unavailable');
    const answered = parseRequestCloseoutRecord({ ...record, terminal: { kind: 'answered' } })!;
    expect(answered.interruption).toBeUndefined();
  });

  it('strictly rebuilds optional facts without prose, callback, malicious labels, or unserializable path atoms', () => {
    const a = make(); a.activityToolStarted('call', 'read_file'); a.toolResult('read_file', ok, 'call');
    const good = a.freezeTurnActivity(false)!;
    expect(parseTurnActivity({ ...good, rawError: 'PRIVATE', callback: () => undefined, toJSON: () => 'PRIVATE' })).toEqual(good);
    for (const bad of [
      { ...good, reads: [undefined] }, { ...good, reads: ['/PRIVATE'] },
      { ...good, tools: [{ ...good.tools[0], tool: 'PRIVATE_TOOL' }] },
      { ...good, tools: [{ ...good.tools[0], success: -1 }] },
      { ...good, omitted: { ...good.omitted, events: 1 } }, { ...good, lastUnfinished: 'write_file' },
      { ...good, decisions: [{ disposition: 'PRIVATE_DECISION', count: 1 }] },
    ]) expect(parseTurnActivity(bad)).toBeUndefined();
    expect(interruptedTurnSummary(interruption)).toContain('no zero-work claim is made');
  });
});
