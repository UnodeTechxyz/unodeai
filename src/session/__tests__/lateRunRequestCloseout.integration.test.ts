import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { reviseForLimits, reviseForRunNow, type RequestCloseoutRunSource } from '../RequestCloseoutAccumulator';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { arbitrateAccountabilityAnchors, jobOutcomeAccountabilityAnchor, requestSummaryAnchor } from '../../observability/AccountabilityAnchor';
import { jobOutcomeAnchor } from '../../observability/JobOutcomeAnchor';
import {
  closingTurnCloseout, displayedJobOutcomeView, jobOutcomeWithRequestLimits, projectRequestSummary, requestLimitSection,
  requestSummaryState,
  type RequestCloseoutRecordV1, type RequestLimitsObservation,
} from '../../observability/RequestCloseout';
import { renderJobOutcomeMarkdown, type JobOutcomeViewV1 } from '../../observability/JobOutcome';
import { renderRunEvidencePack } from '../../observability/RunEvidencePack';
import { RequestCloseoutStore } from '../../observability/RequestCloseoutStore';
import { RunLedger } from '../../observability/RunLedger';
import type { AgentConfig, Message } from '../../types';

/*
 * v0.9.94: the session manager, the run ledger and the closeout store wired as the extension wires them. A
 * dispatch is recorded when the teammate takes the task up, and that can be after the dispatching turn has ended.
 * The turn's record is then written with no run. It is given the run when the run is recorded, and the run's
 * close after that.
 */

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { /* the test drives the events */ }
  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void { /* the session ends the turn */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function makeConfig(id: string, role: AgentConfig['role']): AgentConfig {
  return {
    id, name: id, role, skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const noUsage = () => undefined;

describe('a request closeout written before its run was recorded, session, ledger and store together', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let ledger: RunLedger;
  let store: RequestCloseoutStore;
  let backends: Map<string, FakeBackend>;
  /** What the limits host says of the request now; undefined for a request with no limit. */
  let limitsNow: RequestLimitsObservation | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T02:00:00.000Z'));
    bus = new MessageBus();
    backends = new Map();
    limitsNow = undefined;
    const state = new Map<string, unknown>();
    store = new RequestCloseoutStore({ get: (key) => state.get(key), update: (key, value) => { state.set(key, value); } });
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        backends.set(config.id, created);
        return created;
      },
      resolveEnv: async () => ({}),
      // A limits host that holds nothing and reports what the test says it has counted.
      requestLimits: {
        begin: () => undefined, governs: () => false, wouldHold: () => false, markObservedOnly: () => undefined,
        boundary: async () => 'proceed', release: () => undefined, facts: () => limitsNow,
      },
      resolveTurnRunId: (sessionId, correlationId) => ledger.turnRunId(sessionId, correlationId),
      requestRunFacts: (sessionId, correlationId) => ledger.requestRunFacts(sessionId, { correlationId }),
    });
    ledger = new RunLedger([], {
      host: { hostInstanceId: 'window-1', epoch: 'activation-1' },
      activeTurnId: (agentId) => manager.currentTurnId(agentId),
    });
    bus.on('message.sent', (message) => ledger.observeMessage(message as Message));
    manager.on('session.turnEnded', (event) => { ledger.recordTurn(event.sessionId!, event.data); });
    manager.on('session.requestCloseout', (event) => { store.upsert(event.data.record); });
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']] as Array<[string, AgentConfig['role']]>) {
      manager.create(makeConfig(id, role));
      await manager.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** What the extension does each time the ledger or the store changes. */
  function sync(): void {
    const runs: RequestCloseoutRunSource = {
      byId: (agentId, runId) => ledger.requestRunFacts(agentId, { runId }),
      openedBy: (agentId, turnId) => ledger.requestRunFacts(agentId, { openingTurnId: turnId }),
    };
    for (const session of manager.getAll()) {
      for (const record of store.list(session.id)) {
        const revised = reviseForRunNow(record, runs);
        if (revised) store.upsert(revised);
        const limited = reviseForLimits(revised ?? record, limitsNow);
        if (limited) store.upsert(limited);
      }
    }
  }

  function ask(agent: string, instruction: string): Message {
    return bus.send('user', agent, 'ask.question', { instruction, mode: 'act' });
  }

  function reply(agent: string, text: string): void {
    backends.get(agent)!.emit({ kind: 'model_request' });
    backends.get(agent)!.emit({ kind: 'turn_complete', result: { text, isError: false, responseOutcome: { kind: 'reply' } } });
  }

  function admitted(request: Message, handle: string): string {
    return ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: 'Review the diff.',
      originCorrelationId: request.id, originTurnId: request.id, dispatchedAt: new Date().toISOString(),
    })!;
  }

  function cancelled(handle: string): void {
    ledger.recordDelegationCancelled({
      coordinatorId: 'pm', handle, agentId: 'dev', reason: 'Stopped by user.', cancelledAt: new Date().toISOString(),
    });
  }

  const only = (agent: string): RequestCloseoutRecordV1 => {
    const records = store.list(agent);
    expect(records).toHaveLength(1);
    return records[0];
  };
  const rows = (record: RequestCloseoutRecordV1, title: string) =>
    projectRequestSummary(record, { usage: noUsage }).sections.find((section) => section.title === title)!.rows;

  it('gives the dispatching turn its run when the task is taken up, and the close when the job closes', () => {
    const request = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    const written = only('pm');
    expect(written).toMatchObject({ terminalTurnId: request.id, revision: 1, terminal: { kind: 'answered' } });
    expect(written.observations.run).toBeUndefined();
    expect(requestSummaryState(written)).toBe('answered');
    // Nothing is recorded yet, so nothing is made up.
    sync();
    expect(only('pm').revision).toBe(1);

    vi.advanceTimersByTime(4_000);
    const runId = admitted(request, 'h-1');
    sync();
    const running = only('pm');
    expect(running).toMatchObject({
      recordId: written.recordId, revision: 2, recordedAt: written.recordedAt, terminal: { kind: 'answered' }, terminalTurnId: request.id,
    });
    expect(running.observations.run).toMatchObject({ runId, state: 'open', afterTurn: true, tasks: { active: 1 }, handles: ['h-1'] });
    expect(requestSummaryState(running)).toBe('in-progress');
    // The card does not say that the run was open when the turn ended: it was not.
    expect(rows(running, 'Team & routes')).toContainEqual({ label: 'Coordinated run', value: 'opened after this turn ended' });
    expect(rows(running, 'Remaining')).toContainEqual({ label: 'Delegated work', value: '1 task running after this turn ended' });
    // Asked again with nothing new, it changes nothing.
    sync();
    expect(only('pm').revision).toBe(2);

    cancelled('h-1');
    expect(ledger.get(runId)).toMatchObject({ status: 'closed', closingTurnId: request.id });
    sync();
    const closed = only('pm');
    expect(closed).toMatchObject({ revision: 3, recordedAt: written.recordedAt, terminal: { kind: 'answered' } });
    expect(closed.observations.run).toMatchObject({ runId, state: 'closed', tasks: { active: 0, cancelled: 1 } });
    expect(closed.observations.run).not.toHaveProperty('afterTurn');
    expect(requestSummaryState(closed)).toBe('job-closed');
  });

  it('brings the limit facts of the dispatching turn up to date when the request is stopped at its limit, for the Job outcome that stands there', () => {
    // The Owner's field run of 2026-10-10, with a limit of 1. The coordinator's turn was continued once and
    // ended. The teammate reached the limit again, and the person stopped the request.
    limitsNow = { coverage: 'partial', providerTurns: { ceiling: 1, observed: 1, hostCountedTurns: 1 }, crossings: 1, allowances: 1, decision: 'continued' };
    const request = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    const written = only('pm');
    expect(written.observations.limits).toEqual(limitsNow);
    const runId = admitted(request, 'h-1');
    sync();

    // The question is open. Nothing of an open question is written into the record of a turn that has ended.
    limitsNow = { ...limitsNow, providerTurns: { ceiling: 1, observed: 2, hostCountedTurns: 1 }, crossings: 2, decision: 'awaiting' };
    sync();
    expect(only('pm').observations.limits).toEqual(written.observations.limits);
    expect(requestSummaryState(only('pm'))).toBe('in-progress');

    // Stop request: the teammate's task is cancelled, and the job closes at the coordinator's reply.
    limitsNow = { ...limitsNow, decision: 'stopped' };
    cancelled('h-1');
    expect(ledger.get(runId)).toMatchObject({ status: 'closed', closingTurnId: request.id });
    sync();
    const closed = only('pm');
    expect(closed).toMatchObject({ recordId: written.recordId, recordedAt: written.recordedAt, terminal: { kind: 'answered' }, terminalTurnId: request.id });
    expect(closed.observations.limits).toEqual(limitsNow);
    expect(closed.observations.run).toMatchObject({ runId, state: 'closed' });

    // That turn's card is the Job outcome. It reads the limit facts from this record.
    const anchor = jobOutcomeAnchor({ runId, coordinatorId: 'pm', closingTurnId: request.id, endedAt: new Date().toISOString() })!;
    const winners = arbitrateAccountabilityAnchors([requestSummaryAnchor(closed), jobOutcomeAccountabilityAnchor({ state: 'anchored', anchor })!]);
    expect(winners.map((winner) => winner.kind)).toEqual(['job-outcome']);
    const jobView: JobOutcomeViewV1 = {
      schemaVersion: 1, id: anchor.id, runId, available: true,
      headline: [{ text: 'Partial', tone: 'caution' }], sections: [{ title: 'Outcome', rows: [] }], actions: [],
    };
    expect(jobOutcomeWithRequestLimits(jobView, closed).sections.at(-1)).toMatchObject({
      title: 'Request limit',
      rows: [
        { label: 'Model requests and host-counted turns against the limit', value: '2 observed (1 host-counted turn), limit 1' },
        { label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' },
      ],
    });

    // Asked again with nothing new, it changes nothing.
    sync();
    expect(only('pm').revision).toBe(closed.revision);
  });

  it('gives the dispatching turn the final totals of a job that closed below its limit, with no question in between', () => {
    // A limit of 100. The coordinator's turn made one request and ended. The teammate made nineteen more.
    limitsNow = { coverage: 'complete', providerTurns: { ceiling: 100, observed: 1 }, crossings: 0, allowances: 0, decision: 'none' };
    const request = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    const written = only('pm');
    expect(written.observations.limits).toEqual(limitsNow);
    const runId = admitted(request, 'h-1');
    sync();
    const running = only('pm');

    // While the job runs the totals are not followed: no write at every model request.
    limitsNow = { ...limitsNow, providerTurns: { ceiling: 100, observed: 20 } };
    sync();
    expect(only('pm')).toMatchObject({ revision: running.revision });
    expect(only('pm').observations.limits).toEqual(written.observations.limits);

    // The job closes. Nobody was asked anything, and the record takes the request's final facts.
    cancelled('h-1');
    expect(ledger.get(runId)).toMatchObject({ status: 'closed', closingTurnId: request.id });
    sync();
    const closed = only('pm');
    expect(closed).toMatchObject({ recordId: written.recordId, recordedAt: written.recordedAt, terminal: { kind: 'answered' } });
    expect(closed.observations.run).toMatchObject({ runId, state: 'closed' });
    expect(closed.observations.limits).toEqual(limitsNow);
    const jobView: JobOutcomeViewV1 = {
      schemaVersion: 1, id: 'job-outcome:x', runId, available: true,
      headline: [{ text: 'Complete' }], sections: [{ title: 'Outcome', rows: [] }], actions: [],
    };
    expect(jobOutcomeWithRequestLimits(jobView, closed).sections.at(-1)).toMatchObject({
      title: 'Request limit',
      rows: [{ label: 'Model requests against the limit', value: '20 observed, limit 100' }],
    });

    // Every surface is given one view, made from the ledger's own run and the stored records: the card, the
    // evidence report written from it, and the run evidence pack.
    const run = ledger.get(runId)!;
    const records = (agentId: string, turnId: string) => store.ofTurn(agentId, turnId);
    expect(closingTurnCloseout(run, records)).toEqual(closed);
    const shown = displayedJobOutcomeView(jobView, run, records);
    expect(shown).toEqual(jobOutcomeWithRequestLimits(jobView, closed));
    const report = renderJobOutcomeMarkdown(shown, '2026-10-10T03:00:00.000Z');
    expect(report).toContain('## Request limit');
    expect(report).toContain('- Model requests against the limit: **20 observed, limit 100**');
    const pack = renderRunEvidencePack(run, '2026-10-10T03:00:00.000Z', { requestLimits: requestLimitSection(closingTurnCloseout(run, records)) });
    expect(pack).toContain('## Request limit (request closeout facts, not run facts)');
    expect(pack).toContain('- Model requests against the limit: **20 observed, limit 100**');
    expect(pack.indexOf('## Request limit')).toBeLessThan(pack.indexOf('## Evidence limits'));
    // A pack of the same run with no such record says nothing of a limit, and neither does one of another agent's records.
    expect(renderRunEvidencePack(run, '2026-10-10T03:00:00.000Z')).not.toContain('Request limit');
    expect(requestLimitSection(closingTurnCloseout(run, () => undefined))).toBeUndefined();
    expect(displayedJobOutcomeView(jobView, { ...run, coordinatorId: 'dev' }, records)).toBe(jobView);

    // Asked again with nothing new, it changes nothing.
    sync();
    expect(only('pm').revision).toBe(closed.revision);
  });

  it('stops saying that the totals are exact when a later turn ran where the host cannot count, while the job is still open', () => {
    limitsNow = { coverage: 'complete', providerTurns: { ceiling: 100, observed: 1 }, crossings: 0, allowances: 0, decision: 'none' };
    const request = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    const written = only('pm');
    expect(written.coverage.limited).not.toContain('limits');
    const runId = admitted(request, 'h-1');
    sync();

    // The teammate is on a CLI route: its turn is counted as one, and what it does inside cannot be counted.
    limitsNow = { coverage: 'partial', providerTurns: { ceiling: 100, observed: 2, hostCountedTurns: 1 }, crossings: 0, allowances: 0, decision: 'none' };
    sync();
    const qualified = only('pm');
    expect(qualified.observations.run).toMatchObject({ runId, state: 'open' });
    expect(qualified.observations.limits).toEqual(limitsNow);
    expect(qualified.coverage.limited).toContain('limits');
    const usage = projectRequestSummary(qualified, { usage: noUsage }).sections.find((section) => section.title === 'Usage & timing')!;
    expect(usage.rows).toContainEqual({ label: 'Model requests and host-counted turns against the limit', value: '2 observed (1 host-counted turn), limit 100' });
    expect(usage.note).toContain('These totals may be a lower bound.');
  });

  it('takes a run that was recorded and closed before anyone looked: the open state need not be seen', () => {
    const request = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    const written = only('pm');
    const runId = admitted(request, 'h-1');
    cancelled('h-1');
    expect(ledger.get(runId)?.status).toBe('closed');

    sync();
    const closed = only('pm');
    expect(closed).toMatchObject({ revision: 2, recordedAt: written.recordedAt, terminal: { kind: 'answered' } });
    expect(closed.observations.run).toMatchObject({ runId, state: 'closed' });
    expect(closed.observations.run).not.toHaveProperty('afterTurn');
    expect(requestSummaryState(closed)).toBe('job-closed');
  });

  it('gives a stopped turn the job that was recorded after the stop, and one card stands at that turn', () => {
    const request = ask('pm', 'review this');
    backends.get('pm')!.emit({ kind: 'model_request' });
    manager.interrupt('pm');
    expect(only('pm')).toMatchObject({ terminal: { kind: 'stopped' }, revision: 1 });

    const runId = admitted(request, 'h-1');
    sync();
    const open = only('pm');
    expect(open.observations.run).toMatchObject({ runId, state: 'open', afterTurn: true });
    // A stopped turn stays a stopped turn while its job is open.
    expect(requestSummaryState(open)).toBe('stopped');

    cancelled('h-1');
    sync();
    const closed = only('pm');
    expect(closed).toMatchObject({ revision: 3, terminal: { kind: 'stopped' } });
    expect(requestSummaryState(closed)).toBe('job-closed');
    const anchor = jobOutcomeAnchor(ledger.closedRunAnchorFacts()[0])!;
    const shown = arbitrateAccountabilityAnchors([
      requestSummaryAnchor(closed),
      jobOutcomeAccountabilityAnchor({ state: 'anchored', anchor }, true)!,
    ]);
    expect(shown).toEqual([expect.objectContaining({ kind: 'job-outcome', target: { kind: 'user-turn', turnId: request.id } })]);
  });

  it('gives a record only the run its own turn opened', () => {
    const first = ask('pm', 'review this');
    reply('pm', 'Dispatched to the developer.');
    vi.advanceTimersByTime(1_000);
    const second = ask('pm', 'and what is the time?');
    reply('pm', 'It is two.');
    const other = ask('dev', 'look at this');
    reply('dev', 'Looked.');
    expect(store.list('pm').map((record) => record.terminalTurnId)).toEqual([first.id, second.id]);

    const runId = admitted(first, 'h-1');
    sync();
    const [dispatching, unrelated] = store.list('pm');
    expect(dispatching.observations.run).toMatchObject({ runId });
    expect(unrelated).toMatchObject({ terminalTurnId: second.id, revision: 1 });
    expect(unrelated.observations.run).toBeUndefined();
    // Another agent's turn is not given a coordinator's run, whatever turn that run names.
    expect(only('dev')).toMatchObject({ terminalTurnId: other.id, revision: 1 });
    expect(ledger.requestRunFacts('dev', { openingTurnId: first.id })).toBeUndefined();
    expect(ledger.requestRunFacts('pm', { openingTurnId: second.id })).toBeUndefined();
  });

  it('names the earliest of several runs one turn opened', () => {
    const request = ask('pm', 'review this');
    manager.interrupt('pm');
    const first = admitted(request, 'h-1');
    cancelled('h-1');
    const second = admitted(request, 'h-2');
    expect(second).not.toBe(first);
    expect(ledger.requestRunFacts('pm', { openingTurnId: request.id })?.runId).toBe(first);
  });

  it('is wired into the extension by the run a record holds and by the turn that opened a run', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'extension.ts'), 'utf8');
    expect(source).toContain('byId: (agentId, runId) => ledger.requestRunFacts(agentId, { runId }),');
    expect(source).toContain('openedBy: (agentId, turnId) => ledger.requestRunFacts(agentId, { openingTurnId: turnId }),');
    expect(source).toContain('const revised = reviseForRunNow(record, runs);');
  });

  it('is wired into the extension for the limit facts of a request, on one path for the card, the report and the pack', () => {
    const extension = readFileSync(join(__dirname, '..', '..', 'extension.ts'), 'utf8');
    // The record is brought up to date from the limits host, after the run revision of the same pass and by the
    // record's own request id.
    expect(extension).toContain('const limited = reviseForLimits(revised ?? record, requestCeiling?.facts(record.requestId));');
    expect(extension).toContain('if (limited) requestCloseoutStore.upsert(limited);');
    // The records are brought up to date before the cards are read again.
    const pass = extension.slice(extension.indexOf('function syncJobOutcomes(): void {'), extension.indexOf('function syncRequestCloseoutRuns(): void {'));
    expect(pass.indexOf('syncRequestCloseoutRuns();')).toBeGreaterThan(0);
    expect(pass.indexOf('syncRequestCloseoutRuns();')).toBeLessThan(pass.indexOf('chatViewProvider.upsertJobOutcomeAnchors(anchors);'));
    expect(pass.indexOf('syncRequestCloseoutRuns();')).toBeLessThan(pass.indexOf('chatViewProvider.refreshJobOutcomes();'));
    // One function makes the view, with the limit facts of the run's closing turn.
    expect(extension).toContain('return displayedJobOutcomeView(jobOutcomeView(currentJobOutcome(runId), labels), runLedger?.get(runId), storedRequestCloseout);');
    expect(extension).toContain('return requestCloseoutStore?.ofTurn(agentId, terminalTurnId);');
    // The card asks it, and so does the evidence report.
    expect(extension).toContain('return currentJobOutcomeView(runId, anchor);');
    expect(extension).toContain('const md = renderJobOutcomeMarkdown(currentJobOutcomeView(runId), new Date().toISOString());');
    // The run evidence pack takes the same record by the same identity.
    expect(extension).toContain('renderRunEvidencePack(run, undefined, { requestLimits: requestLimitSection(closingTurnCloseout(run, storedRequestCloseout)) }),');
    // Chat adds nothing to the view it is given.
    const chat = readFileSync(join(__dirname, '..', '..', 'views', 'ChatViewProvider.ts'), 'utf8');
    expect(chat).not.toContain('jobOutcomeWithRequestLimits');
    expect(chat).toContain('view: built.view,');
  });
});
