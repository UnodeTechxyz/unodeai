import { describe, expect, it } from 'vitest';
import {
  MAX_CHANGED_FILES,
  REQUEST_LIMIT_SOURCE_NOTE,
  REQUEST_SUMMARY_SECTIONS,
  REQUEST_SUMMARY_STATES,
  REQUEST_TERMINAL_KINDS,
  boundedObservations,
  closingTurnCloseout,
  displayedJobOutcomeView,
  jobOutcomeWithRequestLimits,
  limitedCoverageAreas,
  parseRequestCloseoutRecord,
  projectRequestSummary,
  requestCloseoutRecordId,
  requestLimitSection,
  requestSummaryState,
  requestVerification,
  type RequestCloseoutRecordV1,
  type RequestLimitsObservation,
  type RequestRunObservation,
  type RequestSummaryViewV1,
} from '../RequestCloseout';
import { renderJobOutcomeMarkdown, type JobOutcomeViewV1, type JobUsageLookup, type JobUsageUnitFacts } from '../JobOutcome';
import { noJobUsage } from '../JobOutcomeUsage';
import { RequestCloseoutAccumulator } from '../../session/RequestCloseoutAccumulator';

const RECEIPT = {
  schemaVersion: 1,
  receiptId: 'turn-outcome:turn-1',
  turnId: 'turn-1',
  agentId: 'dev',
  correlationId: 'turn-1',
  recordedAt: '2026-10-08T01:00:10.000Z',
  delivery: { kind: 'reply' },
  tools: {
    coverage: 'complete', total: 2, success: 2, refused: 0, failed: 0, failureKinds: {}, refusalReasons: {},
    unmatchedUses: 0, unmatchedResults: 0, excludedNativeActivities: 0, unjoinedHostDecisions: 0, observationGaps: 0,
  },
};

const TIMING = { startedAt: '2026-10-08T01:00:00.000Z', settledAt: '2026-10-08T01:00:18.000Z', durationMs: 18_000, approvalWaitMs: 0 };

/** A valid record of an answered turn that did nothing but reply. Tests change one thing each. */
function record(overrides: Record<string, unknown> = {}, observations: Record<string, unknown> = {}): Record<string, unknown> {
  const built: Record<string, unknown> = {
    schemaVersion: 1,
    recordId: 'request-closeout:req-1:turn-1',
    requestId: 'req-1',
    rootAgentId: 'dev',
    originTurnId: 'turn-1',
    terminalTurnId: 'turn-1',
    recordedAt: '2026-10-08T01:00:18.000Z',
    revision: 1,
    terminal: { kind: 'answered' },
    turnOutcome: RECEIPT,
    timing: TIMING,
    usageUnitIds: ['unit-1'],
    observations: {
      changes: { coverage: 'complete', files: [], omitted: 0, droppedPaths: 0 },
      checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0 },
      approvals: { coverage: 'complete', decisions: [] },
      context: { coverage: 'complete', sources: 0, estimatedTextTokens: 0 },
      routes: { coverage: 'complete', agents: [{ agentId: 'dev', backend: 'claude', model: 'opus' }], omitted: 0 },
      reasoning: { visibleItems: 0 },
      ...observations,
    },
    coverage: { events: 'complete', limited: [] },
    ...overrides,
  };
  // The stored coverage list is a function of the other fields; the fixture keeps it true unless a test sets it.
  if (!('coverage' in overrides)) {
    const draft = built as unknown as RequestCloseoutRecordV1;
    built.coverage = { events: 'complete', limited: limitedCoverageAreas(draft) };
  }
  return built;
}

function parsed(overrides: Record<string, unknown> = {}, observations: Record<string, unknown> = {}): RequestCloseoutRecordV1 {
  const value = parseRequestCloseoutRecord(record(overrides, observations));
  expect(value).toBeDefined();
  return value!;
}

const RUN: RequestRunObservation = {
  runId: 'run-1',
  state: 'open',
  tasks: { active: 2, settled: 0, cancelled: 0, interrupted: 0 },
  refusedDispatches: 0,
  policyRefused: 0,
  handles: ['h-1', 'h-2'],
  omittedHandles: 0,
};

const settled = (rows: JobUsageUnitFacts['rows']): JobUsageLookup => (usageUnitId) =>
  (usageUnitId === 'unit-1' ? { state: 'settled', quarantined: false, unattributed: false, rows } : undefined);
const noUsage: JobUsageLookup = () => undefined;

function view(value: RequestCloseoutRecordV1, usage: JobUsageLookup = noUsage): RequestSummaryViewV1 {
  return projectRequestSummary(value, { usage });
}

const line = (card: RequestSummaryViewV1) => card.headline.map((segment) => segment.text).join(' · ');
const section = (card: RequestSummaryViewV1, title: string) => card.sections.find((entry) => entry.title === title)!;
const everyText = (card: RequestSummaryViewV1) => JSON.stringify(card);

describe('parseRequestCloseoutRecord', () => {
  it('rebuilds a record field by field and drops fields it does not know', () => {
    const value = parseRequestCloseoutRecord({ ...record(), replyText: 'all tests pass', prompt: 'secret' });
    expect(value).toEqual(record());
    expect(JSON.stringify(value)).not.toContain('all tests pass');
  });

  it('refuses a record whose id is not the id of its own request and turn', () => {
    expect(parseRequestCloseoutRecord(record({ recordId: 'request-closeout:req-1:turn-2' }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({ recordId: 'request-closeout:req-1' }))).toBeUndefined();
    expect(requestCloseoutRecordId('req-1', 'turn-1')).toBe('request-closeout:req-1:turn-1');
  });

  it('refuses a turn receipt that belongs to another turn', () => {
    expect(parseRequestCloseoutRecord(record({ turnOutcome: { ...RECEIPT, turnId: 'turn-9', receiptId: 'turn-outcome:turn-9' } }))).toBeUndefined();
  });

  it.each([
    ['a revision of zero', { revision: 0 }],
    ['an unknown schema version', { schemaVersion: 2 }],
    ['an unknown terminal kind', { terminal: { kind: 'verified' } }],
    ['a failure on a turn that did not fail', { terminal: { kind: 'answered', failure: 'turn-error' } }],
    ['a failed turn without its cause', { terminal: { kind: 'failed' } }],
    ['a time that is not a time', { recordedAt: 'yesterday' }],
    ['a repeated usage unit', { usageUnitIds: ['unit-1', 'unit-1'] }],
    ['a timing whose phases do not add up', { timing: { ...TIMING, phases: { queuedMs: 1, hostMs: 1, providerWaitMs: 1, providerWaitCount: 1, longestProviderWaitMs: 1, reasoningMs: 1, respondingMs: 1, toolMs: 1 } } }],
  ])('refuses %s', (_name, overrides) => {
    expect(parseRequestCloseoutRecord(record(overrides))).toBeUndefined();
  });

  it('refuses a coverage list that contradicts the record', () => {
    // Complete changes cannot be listed as limited, and a missing timing cannot be left out of the list.
    expect(parseRequestCloseoutRecord(record({ coverage: { events: 'complete', limited: ['changes'] } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({ timing: undefined, coverage: { events: 'complete', limited: [] } }))).toBeUndefined();
    expect(parsed({ timing: undefined }).coverage.limited).toEqual(['timing']);
  });

  it('refuses observations that say more than their coverage allows', () => {
    const file = { path: 'src/a.ts', operation: 'write' };
    expect(parseRequestCloseoutRecord(record({}, { changes: { coverage: 'complete', files: [file], omitted: 1, droppedPaths: 0 } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { changes: { coverage: 'unavailable', files: [file], omitted: 0, droppedPaths: 0 } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { checks: { coverage: 'unavailable', passed: 1, failed: 0, refused: 0 } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { approvals: { coverage: 'excluded', decisions: [{ kind: 'command-approval', allowed: 1, denied: 0, expired: 0 }] } }))).toBeUndefined();
  });

  it.each([
    'C:/Users/me/secret.txt', '/etc/passwd', '../outside.txt', '~/notes.md', 'a//b.ts', '$HOME/x',
  ])('refuses a changed path that is not workspace-relative: %s', (path) => {
    expect(parseRequestCloseoutRecord(record({}, { changes: { coverage: 'complete', files: [{ path, operation: 'write' }], omitted: 0, droppedPaths: 0 } }))).toBeUndefined();
  });

  it('refuses a run whose running handles do not match its running tasks', () => {
    expect(parseRequestCloseoutRecord(record({}, { run: { ...RUN, handles: ['h-1'] } }))).toBeUndefined();
    expect(parsed({}, { run: { ...RUN, handles: ['h-1'], omittedHandles: 1 } }).observations.run?.tasks.active).toBe(2);
  });

  it('refuses a limit decision that no crossing explains', () => {
    const limits = { coverage: 'complete', providerTurns: { ceiling: 10, observed: 4 }, crossings: 0, allowances: 0, decision: 'none' };
    expect(parsed({}, { limits }).observations.limits?.decision).toBe('none');
    expect(parseRequestCloseoutRecord(record({}, { limits: { ...limits, decision: 'awaiting' } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { limits: { ...limits, crossings: 1, decision: 'continued' } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { limits: { ...limits, crossings: 1, allowances: 2, decision: 'continued' } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { limits: { coverage: 'complete', crossings: 0, allowances: 0, decision: 'none' } }))).toBeUndefined();
  });
});

describe('boundedObservations', () => {
  it('keeps the first entries and the last one, and counts the rest', () => {
    const items = Array.from({ length: MAX_CHANGED_FILES + 5 }, (_unused, index) => index);
    const { kept, omitted } = boundedObservations(items, MAX_CHANGED_FILES);
    expect(kept).toHaveLength(MAX_CHANGED_FILES);
    expect(kept.slice(0, 3)).toEqual([0, 1, 2]);
    expect(kept.at(-1)).toBe(MAX_CHANGED_FILES + 4);
    expect(omitted).toBe(5);
    expect(boundedObservations([1, 2], 5)).toEqual({ kept: [1, 2], omitted: 0 });
  });
});

describe('requestSummaryState', () => {
  it('gives every terminal kind a state by name', () => {
    const states = Object.fromEntries(REQUEST_TERMINAL_KINDS.map((kind) => [
      kind,
      requestSummaryState(parsed({ terminal: kind === 'failed' ? { kind, failure: 'turn-error' } : { kind } })),
    ]));
    expect(states).toEqual({
      answered: 'answered',
      'tool-only': 'no-conclusion',
      'empty-reply': 'no-conclusion',
      stopped: 'stopped',
      'host-deadline': 'needs-you',
      failed: 'failed',
      'no-conclusion': 'no-conclusion',
    });
  });

  it('calls an answer completed only when the host observed a change or ran a check', () => {
    expect(requestSummaryState(parsed())).toBe('answered');
    expect(requestSummaryState(parsed({}, { changes: { coverage: 'complete', files: [{ path: 'src/a.ts', operation: 'write' }], omitted: 0, droppedPaths: 0 } }))).toBe('completed');
    expect(requestSummaryState(parsed({}, { checks: { coverage: 'complete', passed: 1, failed: 0, refused: 0 } }))).toBe('completed');
    // A refused check ran nothing.
    expect(requestSummaryState(parsed({}, { checks: { coverage: 'complete', passed: 0, failed: 0, refused: 1 } }))).toBe('answered');
  });

  it('reads an open coordinated run from its typed facts', () => {
    expect(requestSummaryState(parsed({}, { run: RUN }))).toBe('in-progress');
    const idle = { ...RUN, tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };
    expect(requestSummaryState(parsed({}, { run: idle }))).toBe('no-conclusion');
    expect(requestSummaryState(parsed({}, { run: { ...idle, policyRefused: 1 } }))).toBe('blocked');
  });

  it('points at the Job outcome once the run has closed, whatever the turn was', () => {
    const closed = { ...RUN, state: 'closed', tasks: { active: 0, settled: 2, cancelled: 0, interrupted: 0 }, handles: [] };
    expect(requestSummaryState(parsed({}, { run: closed }))).toBe('job-closed');
    expect(requestSummaryState(parsed({ terminal: { kind: 'stopped' } }, { run: closed }))).toBe('job-closed');
  });

  it('needs the person when an approval was not granted or a request limit waits', () => {
    expect(requestSummaryState(parsed({}, { approvals: { coverage: 'complete', decisions: [{ kind: 'command-approval', allowed: 0, denied: 1, expired: 0 }] } }))).toBe('needs-you');
    expect(requestSummaryState(parsed({}, { approvals: { coverage: 'complete', decisions: [{ kind: 'command-approval', allowed: 2, denied: 0, expired: 0 }] } }))).toBe('answered');
    const limits = { coverage: 'complete', tokens: { ceiling: 1000, observed: 1200 }, crossings: 1, allowances: 0, decision: 'awaiting', heldBoundary: 'provider-request' };
    expect(requestSummaryState(parsed({ terminal: { kind: 'stopped' } }, { limits }))).toBe('needs-you');
  });
});

describe('requestVerification', () => {
  it('is verified only by a check the host ran and saw pass', () => {
    const change = { changes: { coverage: 'complete', files: [{ path: 'src/a.ts', operation: 'write' }], omitted: 0, droppedPaths: 0 } };
    expect(requestVerification(parsed())).toBe('not-applicable');
    expect(requestVerification(parsed({}, change))).toBe('not-verified');
    expect(requestVerification(parsed({}, { ...change, checks: { coverage: 'complete', passed: 2, failed: 0, refused: 0 } }))).toBe('verified');
    expect(requestVerification(parsed({}, { ...change, checks: { coverage: 'complete', passed: 2, failed: 1, refused: 0 } }))).toBe('checks-failed');
  });
});

describe('projectRequestSummary', () => {
  it('shows the nine sections in their fixed order', () => {
    expect(view(parsed()).sections.map((entry) => entry.title)).toEqual([...REQUEST_SUMMARY_SECTIONS]);
  });

  it('leads an answer-only turn with what was and was not observed', () => {
    const card = view(parsed(), settled([{ displayClass: 'api-equivalent', inputTokens: 900, cachedInputTokens: 400, outputTokens: 100, nanoUsd: '180000000' }]));
    expect(line(card)).toBe('Answered · no workspace changes observed · $0.18 · 18s');
    expect(section(card, 'Result').note).toBe('A reply was delivered. UnodeAi does not judge whether it is correct.');
    expect(section(card, 'Usage & timing').rows[0]).toEqual({ label: 'Tokens', value: '900 input (400 from cache), 100 output' });
  });

  it('never says verified without a passed check of the host', () => {
    const change = { changes: { coverage: 'complete', files: [{ path: 'src/a.ts', operation: 'write' }, { path: 'old.txt', operation: 'delete-file' }], omitted: 0, droppedPaths: 0 } };
    const unverified = view(parsed({}, change));
    expect(line(unverified)).toBe('Finished — not verified · 2 files changed · checks not run · 18s');
    expect(section(unverified, 'Changes').items).toEqual(['src/a.ts (written)', 'old.txt (deleted)']);
    expect(line(view(parsed({}, { ...change, checks: { coverage: 'complete', passed: 1, failed: 0, refused: 0 } })))).toBe('Verified · 2 files changed · 1 check run passed · 18s');
    expect(line(view(parsed({}, { ...change, checks: { coverage: 'complete', passed: 0, failed: 1, refused: 0 } })))).toBe('Finished — checks failed · 2 files changed · 1 check run failed · 18s');
  });

  it('says that more changes are possible after a command ran, and never says none', () => {
    const card = view(parsed({}, { changes: { coverage: 'partial', files: [], omitted: 0, droppedPaths: 0 } }));
    expect(line(card)).toContain('no workspace changes observed, more possible');
    expect(line(card)).toContain('coverage limited');
    expect(section(card, 'Changes').note).toContain('Files it changed are not in this list');
    const blind = view(parsed({}, { changes: { coverage: 'unavailable', files: [], omitted: 0, droppedPaths: 0 } }));
    expect(line(blind)).toContain('changes not observed on this route');
    expect(section(blind, 'Changes').rows[0]).toEqual({ label: 'Files changed', value: 'not observed', tone: 'caution' });
  });

  it('shows a missing price as tokens only and a missing usage as not recorded', () => {
    const unpriced = view(parsed(), settled([{ displayClass: 'unavailable', inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 }]));
    expect(everyText(unpriced)).not.toContain('$0');
    expect(section(unpriced, 'Usage & timing').rows[1]).toEqual({ label: 'Price unavailable (tokens only)', value: '550 tokens, no price' });
    const missing = view(parsed());
    expect(section(missing, 'Usage & timing').rows[0]).toEqual({ label: 'Usage', value: 'not recorded', tone: 'caution' });
    expect(section(missing, 'Usage & timing').note).toContain('That is not zero usage');
  });

  it('does not add amounts on different bases, and counts cached input once', () => {
    const lookup: JobUsageLookup = (usageUnitId) => (usageUnitId === 'unit-1'
      ? { state: 'settled', quarantined: false, unattributed: false, rows: [
        { displayClass: 'billed', inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100, nanoUsd: '10000000' },
        { displayClass: 'reconstructed', inputTokens: 200, cachedInputTokens: 0, outputTokens: 20, nanoUsd: '2000000' },
      ] }
      : undefined);
    const card = view(parsed(), lookup);
    const usage = section(card, 'Usage & timing');
    expect(usage.rows[0].value).toBe('1,200 input (600 from cache), 120 output');
    expect(usage.rows[1].value).toBe('$0.01 for 1,100 tokens');
    expect(usage.note).toContain('not added into one total');
    expect(line(card)).not.toContain('$');
  });

  it('marks usage partial while a unit is not settled', () => {
    const open: JobUsageLookup = () => ({ state: 'open', quarantined: false, unattributed: false, rows: [{ displayClass: 'billed', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, nanoUsd: '1000' }] });
    const usage = section(view(parsed(), open), 'Usage & timing');
    expect(usage.rows.find((row) => row.label === 'Usage attribution')).toEqual({ label: 'Usage attribution', value: 'partial', tone: 'caution' });
    expect(usage.note).toContain('lower bound');
  });

  it('reports an open run as work in flight, and an idle open run as no conclusion', () => {
    const running = view(parsed({}, { run: RUN, delegation: { accepted: 2, refused: 0, pending: 0 } }));
    expect(line(running)).toBe('In progress · 2 delegated tasks running when this turn ended · no workspace changes observed · 18s');
    expect(section(running, 'Remaining').items).toEqual(['task h-1', 'task h-2']);
    const idle = view(parsed({}, { run: { ...RUN, tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] } }));
    expect(line(idle)).toContain('No conclusion recorded · no live work or next action recorded');
  });

  it('words an open run that was recorded after the turn ended as that, in each of its three places', () => {
    const late = view(parsed({ revision: 2 }, { run: { ...RUN, afterTurn: true }, delegation: { accepted: 2, refused: 0, pending: 0 } }));
    expect(line(late)).toBe('In progress · 2 delegated tasks running after this turn ended · no workspace changes observed · 18s');
    expect(section(late, 'Team & routes').rows).toContainEqual({ label: 'Coordinated run', value: 'opened after this turn ended' });
    expect(section(late, 'Remaining').rows).toContainEqual({ label: 'Delegated work', value: '2 tasks running after this turn ended' });
    expect(everyText(late)).not.toContain('when this turn ended');

    // The same run read as the turn ended keeps its wording.
    const atEnd = view(parsed({}, { run: RUN, delegation: { accepted: 2, refused: 0, pending: 0 } }));
    expect(section(atEnd, 'Team & routes').rows).toContainEqual({ label: 'Coordinated run', value: 'open when this turn ended' });
    expect(section(atEnd, 'Remaining').rows).toContainEqual({ label: 'Delegated work', value: '2 tasks running when this turn ended' });
    expect(everyText(atEnd)).not.toContain('after this turn ended');
  });

  it('keeps the mark of a run recorded after the turn, and refuses a record that gives it any other value', () => {
    expect(parsed({}, { run: { ...RUN, afterTurn: true } }).observations.run).toEqual({ ...RUN, afterTurn: true });
    expect(parsed({}, { run: RUN }).observations.run).not.toHaveProperty('afterTurn');
    expect(parseRequestCloseoutRecord(record({}, { run: { ...RUN, afterTurn: false } }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(record({}, { run: { ...RUN, afterTurn: 'yes' } }))).toBeUndefined();
  });

  it('points at the Job outcome when the run has closed and shows no stale state', () => {
    const closed = view(parsed({ revision: 2 }, { run: { ...RUN, state: 'closed', tasks: { active: 0, settled: 2, cancelled: 0, interrupted: 0 }, handles: [] } }));
    expect(line(closed)).toBe('Job closed · its Job outcome follows the closing reply');
    expect(everyText(closed)).not.toContain('In progress');
    expect(section(closed, 'Remaining').rows).toEqual([{ label: 'Job', value: 'closed; see its Job outcome' }]);
  });

  it('labels a stopped, a failed and a silent turn as what they are', () => {
    const stopped = view(parsed({ terminal: { kind: 'stopped' } }));
    expect(stopped.state).toBe('stopped');
    const cut = view(parsed({ terminal: { kind: 'stopped' }, coverage: { events: 'partial', limited: [] } }));
    expect(line(cut)).toBe('Stopped · no workspace changes observed · 18s · coverage limited');
    expect(section(cut, 'Result').note).toContain('cut short');
    const lost = view(parsed({ terminal: { kind: 'failed', failure: 'process-lost' } }));
    expect(section(lost, 'Result').rows[0].value).toContain('process ended before the turn reported a result');
    const silent = view(parsed({ terminal: { kind: 'tool-only' } }, { reasoning: { visibleItems: 2 } }));
    expect(line(silent)).toContain('No conclusion recorded');
    expect(section(silent, 'Work').rows.at(-1)).toEqual({ label: 'Reasoning shown', value: '2 items; work shown, not a conclusion' });
  });

  it('says when a person was waited for and no approval was recorded', () => {
    const card = view(parsed({ timing: { ...TIMING, settledAt: '2026-10-08T01:00:59.000Z', approvalWaitMs: 41_000 } }));
    expect(section(card, 'Access & approvals').rows[0]).toEqual({ label: 'Approval decisions', value: 'none recorded', tone: 'caution' });
    expect(section(card, 'Access & approvals').note).toContain('41s of waiting for a person');
  });

  it('shows a request limit with what was observed and that it waits', () => {
    const limits = { coverage: 'partial', providerTurns: { ceiling: 5, observed: 7 }, crossings: 1, allowances: 0, decision: 'awaiting', heldBoundary: 'effect' };
    const card = view(parsed({}, { limits }));
    expect(line(card)).toContain('Needs you · request limit reached');
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Model requests against the limit', value: '7 observed, limit 5' });
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Limit reached', value: '1 time; continued 0 times', tone: 'caution' });
    expect(section(card, 'Usage & timing').note).toContain('counts each turn it starts as one (a host-counted turn)');
    expect(section(card, 'Usage & timing').note).toContain('can neither count nor hold the model requests the CLI makes inside a turn');
    expect(section(card, 'Usage & timing').note).toContain('never counted as zero');
    expect(section(card, 'Remaining').rows[0]).toEqual({ label: 'Request limit', value: 'waiting for your decision: stop or continue', tone: 'caution' });
  });

  it('says nothing of a token limit for a request that is limited by model requests alone', () => {
    // The Owner's field run of 2026-10-10, step 4a: a limit of 1 model request, continued once, on a route the
    // host counts exactly. The card closed with a sentence about `the token limit`, and no token limit was set.
    const limits = { coverage: 'complete', providerTurns: { ceiling: 1, observed: 2 }, crossings: 1, allowances: 1, decision: 'continued' };
    const card = view(parsed({}, { limits }));
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Model requests against the limit', value: '2 observed, limit 1' });
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Limit reached', value: '1 time; continued 1 time', tone: 'caution' });
    expect(section(card, 'Usage & timing').note ?? '').not.toContain('token limit');
    // With both limits set, it is said.
    const both = view(parsed({}, { limits: { ...limits, tokens: { ceiling: 50_000, observed: 16_088 } } }));
    expect(section(both, 'Usage & timing').note).toContain('The token limit counts raw tokens, cached input once.');
    // On a Job outcome the section then says whose facts these are and nothing more.
    expect(requestLimitSection(parsed({}, { limits }))!.note).toBe(REQUEST_LIMIT_SOURCE_NOTE);
  });

  it('shows a request stopped at its limit, and says nothing about a lower bound when coverage is complete', () => {
    const limits = { coverage: 'complete', tokens: { ceiling: 50_000, observed: 61_200 }, crossings: 2, allowances: 1, decision: 'stopped', heldBoundary: 'provider-request' };
    const card = view(parsed({ terminal: { kind: 'stopped' } }, { limits }));
    expect(card.state).toBe('stopped');
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Tokens against the limit', value: '61,200 observed, limit 50,000' });
    expect(section(card, 'Usage & timing').rows).toContainEqual({ label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' });
    expect(section(card, 'Usage & timing').note).not.toContain('lower bound');
    expect(section(card, 'Usage & timing').note).toContain('not a cost-weighted threshold');
    expect(section(card, 'Remaining').rows).not.toContainEqual(expect.objectContaining({ label: 'Request limit' }));
  });

  it('never calls a count of turns on a CLI route model requests', () => {
    const limited = (providerTurns: Record<string, number>) =>
      section(view(parsed({}, { limits: { coverage: 'partial', providerTurns, crossings: 0, allowances: 0, decision: 'none' } })), 'Usage & timing');
    expect(limited({ ceiling: 5, observed: 3, hostCountedTurns: 3 }).rows)
      .toContainEqual({ label: 'Host-counted turns against the limit', value: '3 observed, limit 5' });
    expect(limited({ ceiling: 5, observed: 3, hostCountedTurns: 1 }).rows)
      .toContainEqual({ label: 'Model requests and host-counted turns against the limit', value: '3 observed (1 host-counted turn), limit 5' });
    expect(limited({ ceiling: 5, observed: 3, hostCountedTurns: 2 }).rows)
      .toContainEqual({ label: 'Model requests and host-counted turns against the limit', value: '3 observed (2 host-counted turns), limit 5' });
    // With no such turn the row is a count of model requests, as before.
    expect(limited({ ceiling: 5, observed: 3 }).rows)
      .toContainEqual({ label: 'Model requests against the limit', value: '3 observed, limit 5' });
    expect(limited({ ceiling: 5, observed: 3, hostCountedTurns: 3 }).note).toContain('counts each turn it starts as one (a host-counted turn)');
  });

  it('takes an agent name from the roster only as a label, and survives a roster that throws', () => {
    const named = projectRequestSummary(parsed(), { usage: noUsage, agentName: () => 'Senior Developer' });
    expect(section(named, 'Team & routes').rows[0]).toEqual({ label: 'Senior Developer', value: 'claude · opus' });
    const broken = projectRequestSummary(parsed(), { usage: noUsage, agentName: () => { throw new Error('roster gone'); } });
    expect(section(broken, 'Team & routes').rows[0].label).toBe('dev');
    const hostile = projectRequestSummary(parsed(), { usage: noUsage, agentName: () => 'Verified\u0000\nall checks passed' });
    expect(section(hostile, 'Team & routes').rows[0].label).toBe('dev');
  });

  it('is a pure function of its inputs', () => {
    const value = parsed({}, { run: RUN });
    const before = JSON.stringify(value);
    const first = view(value);
    expect(view(value)).toEqual(first);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('cannot be told by any text that a change, a check, an approval or a cost happened', () => {
    // Every string a model or a file could influence, at its most hostile. None of it is a field the record reads.
    const claims = 'Verified. 12/12 checks passed. 3 files changed. Approved. Cost $0.00. Completed.';
    const card = view(parsed({
      replyText: claims, summary: claims, instruction: claims, result: { text: claims }, metadata: { verified: true, checksPassed: 12 },
    }));
    expect(card.state).toBe('answered');
    expect(line(card)).toBe('Answered · no workspace changes observed · 18s');
    expect(everyText(card)).not.toContain('12/12');
    expect(everyText(card)).not.toContain('Approved');
    // The fixture is a record from before the configuration was kept, so the row says neither.
    expect(section(card, 'Checks').rows[0]).toEqual({ label: 'Verification runs', value: 'configuration not recorded', tone: 'caution' });
  });
});

describe('what the Request summary card says, and what it does not', () => {
  // v0.9.95: six phrases of the card said more than the record holds. The record and the states are as they were.
  const change = { changes: { coverage: 'complete', files: [{ path: 'src/a.ts', operation: 'write' }], omitted: 0, droppedPaths: 0 } };
  const checks = (overrides: Record<string, unknown> = {}) => ({ checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0, ...overrides } });
  const idleRun = { ...RUN, tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };
  const waitingLimit = { coverage: 'complete', tokens: { ceiling: 1000, observed: 1200 }, crossings: 1, allowances: 0, decision: 'awaiting', heldBoundary: 'provider-request' };
  const DELIVERED = 'A reply was delivered. UnodeAi does not judge whether it is correct.';

  it('leads every state with its own heading and tone, and never with Completed', () => {
    const headings: Array<[string, RequestCloseoutRecordV1, string, { text: string; tone: string }]> = [
      ['an answer', parsed(), 'answered', { text: 'Answered', tone: 'neutral' }],
      ['a change and no check', parsed({}, change), 'completed', { text: 'Finished — not verified', tone: 'caution' }],
      ['a failed check', parsed({}, { ...change, ...checks({ failed: 1 }) }), 'completed', { text: 'Finished — checks failed', tone: 'negative' }],
      ['a failed check and no change', parsed({}, checks({ failed: 1 })), 'completed', { text: 'Finished — checks failed', tone: 'negative' }],
      ['a passed check', parsed({}, { ...change, ...checks({ passed: 1 }) }), 'completed', { text: 'Verified', tone: 'positive' }],
      ['a run with work in flight', parsed({}, { run: RUN }), 'in-progress', { text: 'In progress', tone: 'neutral' }],
      ['a request limit that waits', parsed({}, { limits: waitingLimit }), 'needs-you', { text: 'Needs you', tone: 'caution' }],
      ['a host deadline', parsed({ terminal: { kind: 'host-deadline' } }), 'needs-you', { text: 'Needs you', tone: 'caution' }],
      ['a dispatch refused by policy', parsed({}, { run: { ...idleRun, policyRefused: 1 } }), 'blocked', { text: 'Blocked', tone: 'caution' }],
      ['a stopped turn', parsed({ terminal: { kind: 'stopped' } }), 'stopped', { text: 'Stopped', tone: 'caution' }],
      ['a failed turn', parsed({ terminal: { kind: 'failed', failure: 'turn-error' } }), 'failed', { text: 'Failed', tone: 'negative' }],
      ['a lost process', parsed({ terminal: { kind: 'failed', failure: 'process-lost' } }), 'failed', { text: 'Failed', tone: 'negative' }],
      ['a tool-only turn', parsed({ terminal: { kind: 'tool-only' } }), 'no-conclusion', { text: 'No conclusion recorded', tone: 'caution' }],
      ['an empty reply', parsed({ terminal: { kind: 'empty-reply' } }), 'no-conclusion', { text: 'No conclusion recorded', tone: 'caution' }],
      ['a turn with no delivery', parsed({ terminal: { kind: 'no-conclusion' } }), 'no-conclusion', { text: 'No conclusion recorded', tone: 'caution' }],
      ['a closed run', parsed({ revision: 2 }, { run: { ...idleRun, state: 'closed' } }), 'job-closed', { text: 'Job closed', tone: 'neutral' }],
    ];
    for (const [name, value, state, heading] of headings) {
      const card = view(value);
      expect(card.state, name).toBe(state);
      expect(card.headline[0], name).toEqual(heading);
      expect(everyText(card), name).not.toContain('Completed');
    }
    // Every state the card can lead with is in the table.
    expect([...new Set(headings.map(([, , state]) => state))].sort()).toEqual([...REQUEST_SUMMARY_STATES].sort());
  });

  it('keeps the stored state completed under the Finished headings', () => {
    const unverified = parsed({}, change);
    expect(requestSummaryState(unverified)).toBe('completed');
    expect(requestVerification(unverified)).toBe('not-verified');
    expect(view(unverified).state).toBe('completed');
    const failed = parsed({}, { ...change, ...checks({ failed: 1 }) });
    expect(requestSummaryState(failed)).toBe('completed');
    expect(requestVerification(failed)).toBe('checks-failed');
  });

  it('says of an answered turn that a reply was delivered, under whatever heading the card has', () => {
    for (const value of [parsed(), parsed({}, change), parsed({}, { ...change, ...checks({ failed: 1 }) }), parsed({}, { ...change, ...checks({ passed: 1 }) })]) {
      const card = view(value);
      expect(section(card, 'Result').note).toBe(DELIVERED);
      // The note explains no state word: the card of a turn that changed a file does not show `Answered`.
      expect(everyText(card)).not.toContain('Answered means');
    }
    // A turn that delivered no reply is not told that one was.
    for (const terminal of [{ kind: 'stopped' }, { kind: 'tool-only' }, { kind: 'failed', failure: 'turn-error' }]) {
      expect(section(view(parsed({ terminal })), 'Result').note ?? '').not.toContain('A reply was delivered');
    }
  });

  it('says nothing about the model route under Access & approvals', () => {
    const card = view(parsed());
    const approvals = section(card, 'Access & approvals');
    expect(approvals).toEqual({ title: 'Access & approvals', rows: [{ label: 'Approval decisions', value: 'none recorded' }] });
    expect(approvals).not.toHaveProperty('note');
    expect(JSON.stringify(approvals)).not.toMatch(/route/i);
    // The route is where it belongs.
    expect(section(card, 'Team & routes').rows[0]).toEqual({ label: 'dev', value: 'claude · opus' });
  });

  it('says that no approval decision was recorded, and names a kind that had one', () => {
    expect(section(view(parsed()), 'Access & approvals').rows).toEqual([{ label: 'Approval decisions', value: 'none recorded' }]);
    const decided = view(parsed({}, { approvals: { coverage: 'complete', decisions: [{ kind: 'command-approval', allowed: 2, denied: 0, expired: 0 }] } }));
    expect(section(decided, 'Access & approvals').rows).toEqual([{ label: 'Commands', value: '2 allowed, 0 denied, 0 expired' }]);
    // The same row under the same name where the route gives no decisions at all.
    for (const coverage of ['unavailable', 'excluded']) {
      const unseen = view(parsed({}, { approvals: { coverage, decisions: [] } }));
      expect(section(unseen, 'Access & approvals').rows).toEqual([{ label: 'Approval decisions', value: 'not observed', tone: 'caution' }]);
    }
  });

  it('names what each of the three coverage rows covers, and says what was complete', () => {
    const complete = view(parsed(), settled([{ displayClass: 'billed', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, nanoUsd: '1000' }]));
    expect(section(complete, 'Work').rows[1]).toEqual({ label: 'Tool event record', value: 'complete: every observed tool call has one result' });
    expect(section(complete, 'Changes').rows[1]).toEqual({ label: 'Change visibility', value: 'complete: every recorded write and delete is listed' });
    expect(section(complete, 'Usage & timing').rows).toContainEqual({ label: 'Usage attribution', value: 'complete: the usage recorded for this turn is settled and attributed' });
    // No row is a bare `coverage complete`.
    const rows = complete.sections.flatMap((entry) => entry.rows);
    expect(rows.filter((row) => /coverage/i.test(row.label))).toEqual([]);
    expect(rows.filter((row) => row.value === 'complete')).toEqual([]);
  });

  it('keeps each coverage row\'s other values, with caution', () => {
    const partialTools = { ...RECEIPT, tools: { ...RECEIPT.tools, coverage: 'partial', excludedNativeActivities: 1 } };
    expect(section(view(parsed({ turnOutcome: partialTools })), 'Work').rows[1]).toEqual({ label: 'Tool event record', value: 'partial', tone: 'caution' });
    const changes = (coverage: string) => section(view(parsed({}, { changes: { coverage, files: [], omitted: 0, droppedPaths: 0 } })), 'Changes').rows[1];
    expect(changes('partial')).toEqual({ label: 'Change visibility', value: 'partial', tone: 'caution' });
    expect(changes('unavailable')).toEqual({ label: 'Change visibility', value: 'not available on this route', tone: 'caution' });
    expect(changes('excluded')).toEqual({ label: 'Change visibility', value: 'not collected for this turn', tone: 'caution' });
    const usage = (facts: Partial<JobUsageUnitFacts>) => section(view(parsed(), () => ({
      state: 'settled', quarantined: false, unattributed: false,
      rows: [{ displayClass: 'billed', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, nanoUsd: '1000' }],
      ...facts,
    })), 'Usage & timing').rows.find((row) => row.label === 'Usage attribution');
    expect(usage({ state: 'open' })).toEqual({ label: 'Usage attribution', value: 'partial', tone: 'caution' });
    expect(usage({ unattributed: true })).toEqual({ label: 'Usage attribution', value: 'partial', tone: 'caution' });
    expect(usage({ quarantined: true })).toEqual({ label: 'Usage attribution', value: 'in conflict', tone: 'caution' });
  });

  it('says whether a verification command was configured when UnodeAi ran none', () => {
    const row = (overrides: Record<string, unknown>) => section(view(parsed({}, { ...change, ...checks(overrides) })), 'Checks').rows[0];
    expect(row({ verificationConfigured: true })).toEqual({ label: 'Verification runs', value: 'configured, not run', tone: 'caution' });
    expect(row({ verificationConfigured: false })).toEqual({ label: 'Verification runs', value: 'not configured', tone: 'caution' });
    // A record from before the fact was kept: it is not read as a turn with no command configured.
    expect(row({})).toEqual({ label: 'Verification runs', value: 'configuration not recorded', tone: 'caution' });
    // The same three on a turn that was cut short, where a run may be missing from the record.
    expect(row({ coverage: 'partial', verificationConfigured: true }).value).toBe('configured, not run');
    expect(row({ coverage: 'partial', verificationConfigured: false }).value).toBe('not configured');
    expect(row({ coverage: 'partial' }).value).toBe('configuration not recorded');
  });

  it('shows the runs UnodeAi made as before, whatever the configuration fact says', () => {
    const row = (overrides: Record<string, unknown>) => section(view(parsed({}, checks(overrides))), 'Checks').rows[0];
    for (const configured of [{ verificationConfigured: true }, { verificationConfigured: false }, {}]) {
      expect(row({ passed: 2, ...configured })).toEqual({ label: 'Verification runs', value: '2 passed, 0 failed' });
      expect(row({ passed: 1, failed: 1, ...configured })).toEqual({ label: 'Verification runs', value: '1 passed, 1 failed', tone: 'negative' });
    }
    // Where the host does not observe checks at all, the row says that and nothing about a configuration.
    expect(section(view(parsed({}, { checks: { coverage: 'unavailable', passed: 0, failed: 0, refused: 0, verificationConfigured: true } })), 'Checks').rows)
      .toEqual([{ label: 'Verification runs', value: 'not observed', tone: 'caution' }]);
  });

  it('still counts only a run UnodeAi itself started, and says so', () => {
    for (const configured of [{ verificationConfigured: true }, { verificationConfigured: false }, {}]) {
      const card = view(parsed({}, { ...change, ...checks(configured) }));
      expect(section(card, 'Checks').note).toBe('Only a run of the configured verification command that UnodeAi itself started counts here. A command the agent ran, or a result it reported in its reply, does not.');
      expect(line(card)).toBe('Finished — not verified · 1 file changed · checks not run · 18s');
    }
  });

  it('takes no state and no verdict from the configuration fact', () => {
    const turns = [checks(), { ...change, ...checks() }, { ...change, ...checks({ refused: 1 }) }, { ...change, ...checks({ failed: 1 }) }];
    for (const observed of turns) {
      const [unrecorded, yes, no] = [{}, { verificationConfigured: true }, { verificationConfigured: false }].map((fact) => {
        const value = parsed({}, { ...observed, checks: { ...observed.checks, ...fact } });
        return {
          state: requestSummaryState(value), verification: requestVerification(value),
          limited: value.coverage.limited, line: line(view(value)),
        };
      });
      expect(yes).toEqual(unrecorded);
      expect(no).toEqual(unrecorded);
    }
  });
});

describe('the verification configuration a record keeps', () => {
  const checks = (verificationConfigured?: unknown) => ({
    checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0, ...(verificationConfigured === undefined ? {} : { verificationConfigured }) },
  });

  it('is kept as a yes or a no, and a record without it is a record', () => {
    expect(parsed({}, checks(true)).observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: true });
    expect(parsed({}, checks(false)).observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: false });
    // A record written before the fact was kept loads as it was written: nothing is added to it.
    const older = parsed({}, checks());
    expect(older.observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0 });
    expect(older.observations.checks).not.toHaveProperty('verificationConfigured');
  });

  it.each([
    ['a word', 'true'], ['a number', 1], ['zero', 0], ['nothing', null], ['a list', [true]], ['an object', { configured: true }],
  ])('refuses the record whole when it is %s', (_name, value) => {
    expect(parseRequestCloseoutRecord(record({}, checks(value)))).toBeUndefined();
  });

  it('survives a second parse unchanged, so a stored record equals the one that was written', () => {
    for (const value of [true, false]) {
      const first = parsed({}, checks(value));
      expect(parseRequestCloseoutRecord(JSON.parse(JSON.stringify(first)))).toEqual(first);
    }
  });
});

describe('a Job outcome that stands in place of a Request summary', () => {
  // The Owner's field run of 2026-10-10: a request stopped at its limit had become a job. Its card was the Job
  // outcome, which had no word of the limit, and the Request summary that has the rows was not shown.
  const limits: RequestLimitsObservation = {
    coverage: 'partial', providerTurns: { ceiling: 1, observed: 2, hostCountedTurns: 1 },
    crossings: 2, allowances: 1, decision: 'stopped',
  };
  const jobView: JobOutcomeViewV1 = {
    schemaVersion: 1, id: 'outcome:run-1', runId: 'run-1', available: true,
    headline: [{ text: 'Partial', tone: 'caution' }],
    sections: [{ title: 'Outcome', rows: [{ label: 'Completion', value: 'Partial' }] }, { title: 'Usage', rows: [] }],
    actions: [],
  };
  const recordWith = (observed?: RequestLimitsObservation): RequestCloseoutRecordV1 => {
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'req-1', rootAgentId: 'pm', originTurnId: 'turn-1', terminalTurnId: 'turn-1' });
    return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-10T19:27:27.000Z', eventsCut: false, ...(observed ? { limits: observed } : {}) })!;
  };

  it('adds the request\'s limit facts as one more section, after the run\'s own', () => {
    const view = jobOutcomeWithRequestLimits(jobView, recordWith(limits));
    expect(view.sections.map((section) => section.title)).toEqual(['Outcome', 'Usage', 'Request limit']);
    expect(view.sections.at(-1)).toEqual({
      title: 'Request limit',
      rows: [
        { label: 'Model requests and host-counted turns against the limit', value: '2 observed (1 host-counted turn), limit 1' },
        { label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' },
      ],
      note: expect.stringContaining('These totals may be a lower bound.'),
    });
    // The run's own sections, its line and its actions are as they were, and the given view is not changed.
    expect(view.sections.slice(0, 2)).toEqual(jobView.sections);
    expect(view.headline).toEqual(jobView.headline);
    expect(jobView.sections).toHaveLength(2);
  });

  it('says it in the Request summary\'s own words', () => {
    const record = recordWith(limits);
    const summary = projectRequestSummary(record, { usage: noJobUsage }).sections.find((section) => section.title === 'Usage & timing')!;
    const added = jobOutcomeWithRequestLimits(jobView, record).sections.at(-1)!;
    for (const row of added.rows) expect(summary.rows).toContainEqual(row);
    // Beside a run's own facts the section first says whose facts these are; the rest is the summary's note.
    expect(added.note!.startsWith(`${REQUEST_LIMIT_SOURCE_NOTE} `)).toBe(true);
    expect(summary.note).toContain(added.note!.slice(REQUEST_LIMIT_SOURCE_NOTE.length + 1));
    expect(summary.note).not.toContain(REQUEST_LIMIT_SOURCE_NOTE);
  });

  it('adds nothing for a request that had no limit, for a turn with no record, or to a card that shows no outcome', () => {
    expect(jobOutcomeWithRequestLimits(jobView, recordWith())).toBe(jobView);
    expect(jobOutcomeWithRequestLimits(jobView, undefined)).toBe(jobView);
    const unavailable: JobOutcomeViewV1 = { ...jobView, available: false };
    expect(jobOutcomeWithRequestLimits(unavailable, recordWith(limits))).toBe(unavailable);
  });

  it('keeps the qualification of the totals out when they are complete, and the token limit when one is set', () => {
    const complete: RequestLimitsObservation = {
      coverage: 'complete', providerTurns: { ceiling: 12, observed: 12 }, tokens: { ceiling: 50000, observed: 61250 },
      crossings: 1, allowances: 0, decision: 'stopped',
    };
    const section = jobOutcomeWithRequestLimits(jobView, recordWith(complete)).sections.at(-1)!;
    expect(section.rows).toEqual([
      { label: 'Model requests against the limit', value: '12 observed, limit 12' },
      { label: 'Tokens against the limit', value: '61,250 observed, limit 50,000' },
      { label: 'Limit reached', value: '1 time; continued 0 times; then stopped', tone: 'caution' },
    ]);
    expect(section.note).not.toContain('lower bound');
    expect(section.note).toContain('The token limit counts raw tokens');
  });
});

describe('the Job outcome as every surface shows it', () => {
  // Codex's audit of 2026-10-10: the card had the limit facts and the evidence report written from the same run
  // had not. Both are now given one view, made here.
  const limits: RequestLimitsObservation = {
    coverage: 'partial', providerTurns: { ceiling: 1, observed: 2, hostCountedTurns: 1 },
    crossings: 2, allowances: 1, decision: 'stopped',
  };
  const jobView: JobOutcomeViewV1 = {
    schemaVersion: 1, id: 'outcome:run-1', runId: 'run-1', available: true,
    headline: [{ text: 'Partial', tone: 'caution' }],
    sections: [{ title: 'Outcome', rows: [{ label: 'Completion', value: 'Partial' }] }],
    actions: [],
  };
  const record = (rootAgentId: string, turnId: string, observed?: RequestLimitsObservation): RequestCloseoutRecordV1 => {
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'req-1', rootAgentId, originTurnId: 'turn-1', terminalTurnId: turnId });
    return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-10T19:27:27.000Z', eventsCut: false, ...(observed ? { limits: observed } : {}) })!;
  };
  /** A store: the record kept for an agent's turn. */
  const kept = (records: RequestCloseoutRecordV1[]) => (agentId: string, turnId: string) =>
    records.find((entry) => entry.rootAgentId === agentId && entry.terminalTurnId === turnId);
  const run = { coordinatorId: 'pm', closingTurnId: 'turn-3' };

  it('finds the record of the run\'s closing turn by that exact turn, among the coordinator\'s own records', () => {
    const closing = record('pm', 'turn-3', limits);
    const records = kept([record('pm', 'turn-1', limits), record('pm', 'turn-2'), closing, record('dev', 'turn-3', limits)]);
    expect(closingTurnCloseout(run, records)).toBe(closing);
    // No closing turn, no record of it, or no run: nothing, and no other turn stands in.
    expect(closingTurnCloseout({ coordinatorId: 'pm' }, records)).toBeUndefined();
    expect(closingTurnCloseout({ coordinatorId: 'pm', closingTurnId: 'turn-9' }, records)).toBeUndefined();
    expect(closingTurnCloseout(undefined, records)).toBeUndefined();
    // What a store hands back is taken only when it is the coordinator's record of that turn.
    expect(closingTurnCloseout(run, () => record('dev', 'turn-3', limits))).toBeUndefined();
    expect(closingTurnCloseout(run, () => record('pm', 'turn-1', limits))).toBeUndefined();
    // It is asked for the coordinator's record of the closing turn, and for nothing else.
    const asked: string[] = [];
    closingTurnCloseout(run, (agentId, turnId) => { asked.push(`${agentId} ${turnId}`); return undefined; });
    expect(asked).toEqual(['pm turn-3']);
  });

  it('gives the section whose rows the card shows, or none for a request that had no limit', () => {
    expect(requestLimitSection(record('pm', 'turn-3', limits))).toEqual({
      title: 'Request limit',
      rows: [
        { label: 'Model requests and host-counted turns against the limit', value: '2 observed (1 host-counted turn), limit 1' },
        { label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' },
      ],
      note: expect.stringContaining(REQUEST_LIMIT_SOURCE_NOTE),
    });
    expect(requestLimitSection(record('pm', 'turn-3'))).toBeUndefined();
    expect(requestLimitSection(undefined)).toBeUndefined();
  });

  it('shows the run\'s view with the limit facts of its closing turn, and the report written from it says the same', () => {
    const shown = displayedJobOutcomeView(jobView, run, kept([record('pm', 'turn-3', limits)]));
    expect(shown.sections.map((section) => section.title)).toEqual(['Outcome', 'Request limit']);
    const report = renderJobOutcomeMarkdown(shown, '2026-10-10T20:00:00.000Z');
    expect(report).toContain('## Request limit');
    // Every row of the card's section is a line of the report, and so is whose facts they are.
    for (const row of shown.sections.at(-1)!.rows) expect(report).toContain(`- ${row.label}: **${row.value}**`);
    expect(report).toContain(REQUEST_LIMIT_SOURCE_NOTE);
    expect(report).toContain('These totals may be a lower bound.');
  });

  it('takes no limit facts from another turn of the conversation, for the card or for its report', () => {
    // The dispatching turn's request had a limit; the turn that closed the run has a record without one.
    const records = kept([record('pm', 'turn-1', limits), record('pm', 'turn-3')]);
    const shown = displayedJobOutcomeView(jobView, run, records);
    expect(shown).toBe(jobView);
    expect(renderJobOutcomeMarkdown(shown, '2026-10-10T20:00:00.000Z')).not.toContain('Request limit');
    // The closing turn has no record at all: the same.
    expect(displayedJobOutcomeView(jobView, run, kept([record('pm', 'turn-1', limits)]))).toBe(jobView);
  });

  it('leaves the run\'s own view when the records cannot be read, and adds nothing to a card that shows no outcome', () => {
    expect(displayedJobOutcomeView(jobView, run, () => { throw new Error('store unavailable'); })).toBe(jobView);
    const unavailable: JobOutcomeViewV1 = { ...jobView, available: false };
    expect(displayedJobOutcomeView(unavailable, run, kept([record('pm', 'turn-3', limits)]))).toBe(unavailable);
  });
});
