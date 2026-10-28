import { describe, expect, it } from 'vitest';
import { MAX_CHANGED_FILES, type RequestRunObservation } from '../../observability/RequestCloseout';
import { RequestCloseoutAccumulator, hostToolName, reviseForClosedRun, reviseForLateRun, reviseForLimits, reviseForRunNow } from '../RequestCloseoutAccumulator';
import type { VerificationCheckOutcome } from '../../backend/CompletionVerificationCheck';
import { parseCompletionCheckObservation } from '../../observability/CompletionCheckObservation';

const IDENTITY = { requestId: 'req-1', rootAgentId: 'dev', originTurnId: 'turn-1', terminalTurnId: 'turn-1' };
const END = { terminal: { kind: 'answered' as const }, recordedAt: '2026-10-08T01:00:18.000Z', eventsCut: false };
const OK = { status: 'success' as const, observedBy: 'host' as const };

function turn(): RequestCloseoutAccumulator {
  const accumulator = new RequestCloseoutAccumulator(IDENTITY);
  accumulator.route({ agentId: 'dev', backend: 'openai-compat', model: 'deepseek-v4.1-flash' });
  return accumulator;
}

describe('hostToolName', () => {
  it('gives a bridged tool its own name and leaves any other name alone', () => {
    expect(hostToolName('mcp__unode_team_bridge_0123456789abcdef0123456789abcdef__run_checks')).toBe('run_checks');
    expect(hostToolName('mcp__unode_integrations_0123456789abcdef0123456789abcdef__exa__web_search_exa')).toBe('exa__web_search_exa');
    expect(hostToolName('run_checks')).toBe('run_checks');
    expect(hostToolName('mcp__other_server__run_checks')).toBe('mcp__other_server__run_checks');
  });
});

describe('RequestCloseoutAccumulator', () => {
  it.each(['passed', 'failed', 'outcome-unknown', 'disabled', 'not-applicable', 'approval-required'] as const)(
    'records a typed %s receipt, without treating unrun/unknown as passed or counting its tool event twice', kind => {
      const context = { source: 'team-document' as const, binding: {
        source: 'team-document' as const, teamKind: 'software' as const, workspaceId: 'workspace-A', policyDigest: 'digest',
      } };
      const check: VerificationCheckOutcome = kind === 'passed'
        ? { ...context, kind, command: 'private-command', output: 'private-output', exitCode: 0 }
        : kind === 'failed' ? { ...context, kind, command: 'private-command', output: 'private-output', reason: 'exit-nonzero' }
          : kind === 'outcome-unknown' ? { ...context, kind, command: 'private-command', output: 'private-output' }
            : { ...context, kind: 'not-run', reason: kind, detail: 'private-error' };
      for (const consumer of ['run-checks', 'completion-gate'] as const) {
        const accumulator = turn();
        accumulator.verificationCheck(check, consumer);
        if (consumer === 'run-checks') accumulator.toolResult('run_checks', kind === 'passed' ? OK : { status: 'failed', observedBy: 'host' });
        const record = accumulator.finish({ ...END, verificationConfigured: true })!;
        expect(record.observations.checks).toMatchObject({
          passed: kind === 'passed' ? 1 : 0, failed: kind === 'failed' ? 1 : 0,
          refused: kind === 'approval-required' ? 1 : 0,
          lastCompletionCheck: { kind: check.kind, source: 'team-document', ...('reason' in check ? { reason: check.reason } : {}) },
        });
        expect(JSON.stringify(record)).not.toMatch(/private-|policyDigest|workspace-A/);
        expect(record.observations.checks.verificationConfigured).toBe(kind === 'disabled' ? false
          : kind === 'not-applicable' || kind === 'approval-required' ? undefined : true);
      }
    },
  );

  it('rejects unknown snapshot enums and strips raw command/output fields on re-read', () => {
    expect(parseCompletionCheckObservation({ kind: 'not-run', reason: 'private-error', source: 'team-document' })).toBeUndefined();
    expect(parseCompletionCheckObservation({ kind: 'passed', source: 'repository' })).toBeUndefined();
    expect(parseCompletionCheckObservation({ kind: 'not-run', source: 'team-document', reason: 'disabled', command: 'private-command' }))
      .toEqual({ kind: 'not-run', source: 'team-document', reason: 'disabled' });
  });
  it('closes a turn that only replied into a complete, empty record', () => {
    const record = turn().finish(END);
    expect(record).toMatchObject({
      recordId: 'request-closeout:req-1:turn-1',
      revision: 1,
      terminal: { kind: 'answered' },
      usageUnitIds: [],
      observations: {
        changes: { coverage: 'complete', files: [], omitted: 0, droppedPaths: 0 },
        checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0 },
        approvals: { coverage: 'complete', decisions: [] },
        context: { coverage: 'complete', sources: 0, estimatedTextTokens: 0 },
        routes: { coverage: 'complete', agents: [{ agentId: 'dev', backend: 'openai-compat', model: 'deepseek-v4.1-flash' }], omitted: 0 },
        reasoning: { visibleItems: 0 },
      },
      // No receipt and no timing were given, and the record says so.
      coverage: { events: 'complete', limited: ['tools', 'timing'] },
    });
  });

  // v0.9.97 (handoff §5: "rewriting the same path is not counted twice, nor are retries"; "a later host restore,
  // delete or uncertain effect shows the final observed state"): one entry per path, with the last effect on it.
  it('lists each changed path once, with forward slashes, as its last effect left it', () => {
    const accumulator = turn();
    accumulator.fileChanged('src\\a.ts', 'write', 'host-verified');
    accumulator.fileChanged('src/a.ts', 'write', 'host-verified');
    accumulator.fileChanged('src/a.ts', 'delete-file', 'host-verified');
    expect(accumulator.finish(END)?.observations.changes).toEqual({
      coverage: 'complete',
      files: [{ path: 'src/a.ts', operation: 'delete-file', evidence: 'host-verified' }],
      omitted: 0,
      droppedPaths: 0,
      grades: { hostVerified: 1, nativeObserved: 0, uncertain: 0 },
    });
  });

  it('counts a path it cannot show and never lists it', () => {
    const accumulator = turn();
    accumulator.fileChanged('C:\\Users\\me\\secret.txt', 'write', 'native-observed');
    accumulator.fileChanged('../outside.txt', 'write', 'host-verified');
    const changes = accumulator.finish(END)!.observations.changes;
    expect(changes).toEqual({
      coverage: 'partial', files: [], omitted: 0, droppedPaths: 2, grades: { hostVerified: 1, nativeObserved: 1, uncertain: 0 },
    });
  });

  it('bounds the list by keeping the first changes and the last, and says how many it left out', () => {
    const accumulator = turn();
    for (let index = 0; index < MAX_CHANGED_FILES + 4; index += 1) accumulator.fileChanged(`src/file-${index}.ts`, 'write', 'host-verified');
    const changes = accumulator.finish(END)!.observations.changes;
    expect(changes.coverage).toBe('partial');
    expect(changes.files).toHaveLength(MAX_CHANGED_FILES);
    expect(changes.files.at(-1)?.path).toBe(`src/file-${MAX_CHANGED_FILES + 3}.ts`);
    expect(changes.omitted).toBe(4);
  });

  it.each([
    ['a host command', 'run_command'],
    ['a native shell', 'Bash'],
    ['a Codex command', 'command_execution'],
    ['a Codex file change', 'file_change'],
  ])('marks changes partial after %s succeeded', (_name, tool) => {
    const accumulator = turn();
    accumulator.toolResult(tool, OK);
    expect(accumulator.finish(END)?.observations.changes.coverage).toBe('partial');
  });

  it('leaves changes complete after a read, and after a command that did not run', () => {
    const accumulator = turn();
    accumulator.toolResult('read_file', OK);
    accumulator.toolResult('run_command', { status: 'refused', observedBy: 'host', reason: 'consent' });
    expect(accumulator.finish(END)?.observations.changes.coverage).toBe('complete');
  });

  it('marks changes partial after provider-native activity, and unavailable when the route records none', () => {
    const native = turn();
    native.nativeActivity();
    expect(native.finish(END)?.observations.changes.coverage).toBe('partial');
    const blind = turn();
    blind.fileChanged('src/a.ts', 'write', 'host-verified');
    blind.changesNotObserved();
    expect(blind.finish(END)?.observations.changes).toEqual({ coverage: 'unavailable', files: [], omitted: 0, droppedPaths: 0 });
  });

  it('counts a host check by its typed result, on either route name', () => {
    const accumulator = turn();
    accumulator.toolResult('run_checks', OK);
    accumulator.toolResult('mcp__unode_team_bridge_0123456789abcdef0123456789abcdef__run_checks', { status: 'failed', observedBy: 'host', failureKind: 'error' });
    accumulator.toolResult('run_checks', { status: 'refused', observedBy: 'host', reason: 'consent' });
    expect(accumulator.finish(END)?.observations.checks).toEqual({ coverage: 'complete', passed: 1, failed: 1, refused: 1 });
  });

  it('does not count a command the agent ran as a check', () => {
    const accumulator = turn();
    accumulator.toolResult('run_command', OK);
    expect(accumulator.finish(END)?.observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0 });
  });

  it('says the checks may be incomplete when the turn was cut short', () => {
    const record = turn().finish({ ...END, terminal: { kind: 'stopped' }, eventsCut: true })!;
    expect(record.observations.checks.coverage).toBe('partial');
    expect(record.coverage).toEqual({ events: 'partial', limited: ['tools', 'checks', 'timing'] });
  });

  it('keeps approvals by kind, in the fixed order', () => {
    const accumulator = turn();
    accumulator.approval('write-approval', 'denied');
    accumulator.approval('command-approval', 'allowed');
    accumulator.approval('command-approval', 'allowed');
    accumulator.approval('unclassified', 'expired');
    expect(accumulator.finish(END)?.observations.approvals.decisions).toEqual([
      { kind: 'command-approval', allowed: 2, denied: 0, expired: 0 },
      { kind: 'write-approval', allowed: 0, denied: 1, expired: 0 },
      { kind: 'unclassified', allowed: 0, denied: 0, expired: 1 },
    ]);
  });

  it('counts a run of reasoning as one item, and a later run as another', () => {
    const accumulator = turn();
    accumulator.reasoningShown();
    accumulator.reasoningShown();
    accumulator.toolResult('read_file', OK);
    accumulator.reasoningShown();
    accumulator.endReasoningItem();
    accumulator.reasoningShown();
    expect(accumulator.finish(END)?.observations.reasoning).toEqual({ visibleItems: 3 });
  });

  it('keeps the latest dispatch receipt, the context inventory and the spend units', () => {
    const accumulator = turn();
    accumulator.delegationReceipt({ accepted: 1, refused: 1, pending: 0 });
    accumulator.delegationReceipt({ accepted: 2, refused: 1, pending: 0 });
    accumulator.contextAttached(8, 1773);
    accumulator.usageUnit('unit-1');
    accumulator.usageUnit('unit-1');
    const record = accumulator.finish(END)!;
    expect(record.observations.delegation).toEqual({ accepted: 2, refused: 1, pending: 0 });
    expect(record.observations.context).toEqual({ coverage: 'complete', sources: 8, estimatedTextTokens: 1773 });
    expect(record.usageUnitIds).toEqual(['unit-1']);
  });

  it('takes a turn receipt only when it is this turn\'s', () => {
    const receipt = {
      schemaVersion: 1 as const, receiptId: 'turn-outcome:turn-9', turnId: 'turn-9', agentId: 'dev', recordedAt: END.recordedAt,
      delivery: { kind: 'reply' as const },
      tools: {
        coverage: 'complete' as const, total: 0, success: 0, refused: 0, failed: 0, failureKinds: {}, refusalReasons: {},
        unmatchedUses: 0, unmatchedResults: 0, excludedNativeActivities: 0, unjoinedHostDecisions: 0, observationGaps: 0,
      },
    };
    expect(turn().finish({ ...END, turnOutcome: receipt })?.turnOutcome).toBeUndefined();
    const own = { ...receipt, receiptId: 'turn-outcome:turn-1', turnId: 'turn-1' };
    expect(turn().finish({ ...END, turnOutcome: own })?.turnOutcome).toEqual(own);
  });

  it('says its teammates are not all named when the turn dispatched and no run was recorded for it', () => {
    const accumulator = turn();
    accumulator.delegationReceipt({ accepted: 0, refused: 0, pending: 1 });
    expect(accumulator.finish(END)?.observations.routes).toMatchObject({ coverage: 'partial', omitted: 0 });
    // With its run recorded the teammates can be named, and a refused dispatch reached nobody.
    const run = { runId: 'run-1', state: 'open' as const, tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 }, refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0 };
    const withRun = turn();
    withRun.delegationReceipt({ accepted: 1, refused: 0, pending: 0 });
    withRun.route({ agentId: 'arch', backend: 'unode', model: 'hy3' });
    expect(withRun.finish({ ...END, run })?.observations.routes).toMatchObject({ coverage: 'complete', agents: [{ agentId: 'dev' }, { agentId: 'arch' }] });
    const refusedOnly = turn();
    refusedOnly.delegationReceipt({ accepted: 0, refused: 2, pending: 0 });
    expect(refusedOnly.finish(END)?.observations.routes.coverage).toBe('complete');
  });

  it('says the route is unavailable when none was named', () => {
    expect(new RequestCloseoutAccumulator(IDENTITY).finish(END)?.observations.routes).toEqual({ coverage: 'unavailable', agents: [], omitted: 0 });
  });
});

describe('reviseForClosedRun', () => {
  const open: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const closed: RequestRunObservation = { ...open, state: 'closed', tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };

  it('gives the record of an open run its next revision when that run has closed, and keeps its time', () => {
    const record = turn().finish({ ...END, run: open })!;
    const revised = reviseForClosedRun(record, closed);
    expect(revised).toMatchObject({ recordId: record.recordId, revision: 2, recordedAt: record.recordedAt });
    expect(revised?.observations.run).toEqual(closed);
    expect(reviseForClosedRun(revised!, closed)).toBeUndefined();
  });

  it('revises nothing for another run, a run still open, or a record without a run', () => {
    const record = turn().finish({ ...END, run: open })!;
    expect(reviseForClosedRun(record, { ...closed, runId: 'run-2' })).toBeUndefined();
    expect(reviseForClosedRun(record, open)).toBeUndefined();
    expect(reviseForClosedRun(turn().finish(END)!, closed)).toBeUndefined();
  });
});

describe('reviseForLateRun', () => {
  const open: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const closed: RequestRunObservation = { ...open, state: 'closed', tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };

  it('gives a record written without a run the run recorded since, marked as recorded after the turn', () => {
    const record = turn().finish(END)!;
    const revised = reviseForLateRun(record, open)!;
    expect(revised).toMatchObject({
      recordId: record.recordId, revision: 2, recordedAt: record.recordedAt, terminal: record.terminal, terminalTurnId: record.terminalTurnId,
    });
    expect(revised.observations.run).toEqual({ ...open, afterTurn: true });
    // Everything else the turn observed is as it was.
    expect({ ...revised.observations, run: undefined }).toEqual({ ...record.observations, run: undefined });
  });

  it('takes a run that has already closed as it is, without having seen it open', () => {
    const record = turn().finish(END)!;
    const revised = reviseForLateRun(record, closed)!;
    expect(revised).toMatchObject({ revision: 2, recordedAt: record.recordedAt });
    expect(revised.observations.run).toEqual(closed);
  });

  it('does not give a record that holds a run another one', () => {
    const record = turn().finish({ ...END, run: open })!;
    expect(reviseForLateRun(record, { ...open, runId: 'run-2' })).toBeUndefined();
    expect(reviseForLateRun(record, closed)).toBeUndefined();
  });
});

describe('reviseForLimits', () => {
  // v0.9.94: a record takes its request's limit facts when its turn ends, and the request goes on after that.
  const run: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const closedRun: RequestRunObservation = { ...run, state: 'closed', tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };
  const atTurnEnd = {
    coverage: 'partial' as const, providerTurns: { ceiling: 1, observed: 1, hostCountedTurns: 1 },
    crossings: 1, allowances: 1, decision: 'continued' as const,
  };
  const stopped = { ...atTurnEnd, providerTurns: { ceiling: 1, observed: 2, hostCountedTurns: 1 }, crossings: 2, decision: 'stopped' as const };
  // The turn dispatched and ended; its run is still open.
  const limited = () => turn().finish({ ...END, run, limits: atTurnEnd })!;
  // A request far below its limit: nothing was reached and nobody was asked.
  const below = { coverage: 'complete' as const, providerTurns: { ceiling: 100, observed: 1 }, crossings: 0, allowances: 0, decision: 'none' as const };

  it('takes the facts as the person\'s answer left them, and keeps the terminal fact and the time of the record', () => {
    const record = limited();
    const revised = reviseForLimits(record, stopped)!;
    expect(revised).toMatchObject({
      recordId: record.recordId, revision: 2, recordedAt: record.recordedAt, terminal: record.terminal, terminalTurnId: record.terminalTurnId,
    });
    expect(revised.observations.limits).toEqual(stopped);
    expect({ ...revised.observations, limits: undefined }).toEqual({ ...record.observations, limits: undefined });
    // One more allowance is an answer too.
    const continued = { ...stopped, allowances: 2, decision: 'continued' as const };
    expect(reviseForLimits(record, continued)!.observations.limits).toEqual(continued);
  });

  it('writes nothing of a question that is still open', () => {
    expect(reviseForLimits(limited(), { ...stopped, decision: 'awaiting' })).toBeUndefined();
    // Not for a request that is over either: the question is not one of its facts.
    expect(reviseForLimits(turn().finish({ ...END, run: closedRun, limits: atTurnEnd })!, { ...stopped, decision: 'awaiting' })).toBeUndefined();
  });

  it('does not follow the totals of a run that is still open when the person has not answered since', () => {
    const record = limited();
    expect(reviseForLimits(record, atTurnEnd)).toBeUndefined();
    expect(reviseForLimits(record, { ...atTurnEnd, providerTurns: { ceiling: 1, observed: 5, hostCountedTurns: 1 } })).toBeUndefined();
    expect(reviseForLimits(turn().finish({ ...END, run, limits: below })!, { ...below, providerTurns: { ceiling: 100, observed: 20 } })).toBeUndefined();
  });

  it('takes the final totals of a job that closed below its limit, with no answer in between', () => {
    // The dispatching turn ended at 1 of 100. Teammates made 19 more requests and the job closed. Nobody was asked.
    const final = { ...below, providerTurns: { ceiling: 100, observed: 20 } };
    const record = turn().finish({ ...END, run: closedRun, limits: below })!;
    const revised = reviseForLimits(record, final)!;
    expect(revised).toMatchObject({ revision: 2, recordedAt: record.recordedAt, terminal: record.terminal });
    expect(revised.observations.limits).toEqual(final);
    // The same facts a second time are no revision, so a later pass writes nothing.
    expect(reviseForLimits(revised, final)).toBeUndefined();
    // Tokens are a total too.
    const tokens = { coverage: 'complete' as const, tokens: { ceiling: 50_000, observed: 1_200 }, crossings: 0, allowances: 0, decision: 'none' as const };
    const more = { ...tokens, tokens: { ceiling: 50_000, observed: 31_000 } };
    expect(reviseForLimits(turn().finish({ ...END, run: closedRun, limits: tokens })!, more)!.observations.limits).toEqual(more);
  });

  it('takes the final totals of a request whose turn opened no run', () => {
    const final = { ...below, providerTurns: { ceiling: 100, observed: 2 } };
    const record = turn().finish({ ...END, limits: below })!;
    expect(reviseForLimits(record, final)!.observations.limits).toEqual(final);
    expect(reviseForLimits(record, below)).toBeUndefined();
  });

  it('does not keep a claim of complete coverage that no longer holds, also while the run is open', () => {
    // After the dispatching turn a teammate ran on a CLI route: the host counted its turn as one and cannot count inside it.
    const lowerBound = { ...below, coverage: 'partial' as const, providerTurns: { ceiling: 100, observed: 2, hostCountedTurns: 1 } };
    const record = turn().finish({ ...END, run, limits: below })!;
    expect(record.coverage.limited).not.toContain('limits');
    const revised = reviseForLimits(record, lowerBound)!;
    expect(revised.observations.limits).toEqual(lowerBound);
    // The record's own list of what it could not fully observe now names the limits.
    expect(revised.coverage.limited).toContain('limits');
    // With the coverage already partial, the totals of the open run are not followed further.
    expect(reviseForLimits(revised, { ...lowerBound, providerTurns: { ceiling: 100, observed: 9, hostCountedTurns: 3 } })).toBeUndefined();
  });

  it('refuses facts with fewer crossings or allowances, or with a better coverage: they are not a later state of this request', () => {
    const record = turn().finish({ ...END, limits: stopped })!;
    expect(reviseForLimits(record, { ...stopped, crossings: 1 })).toBeUndefined();
    expect(reviseForLimits(record, { ...stopped, crossings: 3, allowances: 0 })).toBeUndefined();
    // A request's coverage only gets worse. An observation that claims more than the record did is not of this request now.
    expect(reviseForLimits(record, { ...stopped, coverage: 'complete', providerTurns: { ceiling: 1, observed: 9 } })).toBeUndefined();
  });

  it('gives no limit facts to a record of a request that had no limit, and takes none from nothing', () => {
    expect(reviseForLimits(turn().finish(END)!, stopped)).toBeUndefined();
    expect(reviseForLimits(limited(), undefined)).toBeUndefined();
    expect(reviseForLimits(turn().finish({ ...END, run: closedRun, limits: atTurnEnd })!, undefined)).toBeUndefined();
  });
});

describe('reviseForRunNow', () => {
  const open: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const closed: RequestRunObservation = { ...open, state: 'closed', tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };

  it('asks for the run a record without one could have opened by the agent and the turn the record closes', () => {
    const asked: string[] = [];
    // A turn the host started for a result: the request began with another turn, and that turn is not asked for.
    const woken = new RequestCloseoutAccumulator({ ...IDENTITY, originTurnId: 'turn-0', terminalTurnId: 'turn-1' });
    woken.route({ agentId: 'dev', backend: 'openai-compat', model: 'deepseek-v4.1-flash' });
    const revised = reviseForRunNow(woken.finish(END)!, {
      byId: () => { throw new Error('a record without a run has no run id to ask by'); },
      openedBy: (agentId, turnId) => { asked.push(`${agentId} ${turnId}`); return open; },
    });
    expect(asked).toEqual(['dev turn-1']);
    expect(revised?.observations.run).toEqual({ ...open, afterTurn: true });
  });

  it('asks for the run a record holds by its exact id, and takes only its close', () => {
    const asked: string[] = [];
    const record = turn().finish({ ...END, run: open })!;
    const source = (now: RequestRunObservation | undefined) => ({
      byId: (agentId: string, runId: string) => { asked.push(`${agentId} ${runId}`); return now; },
      openedBy: () => { throw new Error('a record that holds a run is not given another'); },
    });
    expect(reviseForRunNow(record, source(open))).toBeUndefined();
    expect(reviseForRunNow(record, source(undefined))).toBeUndefined();
    const revised = reviseForRunNow(record, source(closed))!;
    expect(asked).toEqual(['dev run-1', 'dev run-1', 'dev run-1']);
    expect(revised.observations.run).toEqual(closed);
    // A record of a closed run is finished: nothing is asked.
    expect(reviseForRunNow(revised, { byId: () => { throw new Error('asked'); }, openedBy: () => { throw new Error('asked'); } })).toBeUndefined();
  });

  it('changes nothing while no run is recorded for the turn', () => {
    expect(reviseForRunNow(turn().finish(END)!, { byId: () => undefined, openedBy: () => undefined })).toBeUndefined();
  });
});

describe('whether a verification command was configured when the turn closed', () => {
  // v0.9.95: the host says it once, as the turn closes. The record keeps that answer and nothing changes it later.
  const open: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const closed: RequestRunObservation = { ...open, state: 'closed', tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };
  const limits = { coverage: 'complete' as const, providerTurns: { ceiling: 5, observed: 1 }, crossings: 0, allowances: 0, decision: 'none' as const };

  it('is kept as the host said it, beside the counts of the runs', () => {
    expect(turn().finish({ ...END, verificationConfigured: true })?.observations.checks)
      .toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: true });
    expect(turn().finish({ ...END, verificationConfigured: false })?.observations.checks)
      .toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: false });
    const ran = turn();
    ran.toolResult('run_checks', OK);
    expect(ran.finish({ ...END, verificationConfigured: true })?.observations.checks)
      .toEqual({ coverage: 'complete', passed: 1, failed: 0, refused: 0, verificationConfigured: true });
  });

  it('is left out when the host did not say, and a turn that was cut short keeps it', () => {
    const silent = turn().finish(END)!;
    expect(silent.observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0 });
    expect(silent.observations.checks).not.toHaveProperty('verificationConfigured');
    expect(turn().finish({ ...END, terminal: { kind: 'stopped' }, eventsCut: true, verificationConfigured: false })?.observations.checks)
      .toEqual({ coverage: 'partial', passed: 0, failed: 0, refused: 0, verificationConfigured: false });
  });

  it('limits no coverage area: it is a fact of the host, not an observation that can be incomplete', () => {
    const base = { ...END, timing: { startedAt: '2026-10-08T01:00:00.000Z', settledAt: '2026-10-08T01:00:18.000Z', durationMs: 18_000, approvalWaitMs: 0 } };
    const without = turn().finish(base)!;
    for (const verificationConfigured of [true, false]) {
      expect(turn().finish({ ...base, verificationConfigured })!.coverage).toEqual(without.coverage);
    }
  });

  it.each([true, false])('stays %s through every later revision of the record', (verificationConfigured) => {
    const late = reviseForLateRun(turn().finish({ ...END, verificationConfigured })!, open)!;
    expect(late.revision).toBe(2);
    expect(late.observations.checks.verificationConfigured).toBe(verificationConfigured);
    const closedLater = reviseForClosedRun(late, closed)!;
    expect(closedLater.revision).toBe(3);
    expect(closedLater.observations.checks.verificationConfigured).toBe(verificationConfigured);
    const limited = reviseForLimits(turn().finish({ ...END, limits, verificationConfigured })!, { ...limits, providerTurns: { ceiling: 5, observed: 3 } })!;
    expect(limited.revision).toBe(2);
    expect(limited.observations.checks.verificationConfigured).toBe(verificationConfigured);
  });

  it('is not given to a record that was written without it', () => {
    const revised = reviseForLateRun(turn().finish(END)!, open)!;
    expect(revised.observations.checks).not.toHaveProperty('verificationConfigured');
    expect(reviseForClosedRun(revised, closed)!.observations.checks).not.toHaveProperty('verificationConfigured');
  });
});
