/*
 * v0.9.97 P5: one host effect ledger per request, kept by the session manager under the request authority it already
 * has, and the closeout of ordinary, Solo and PM requests rendered from it. Each test names the sentence it realises:
 *  - review resolution §2: "the effect ledger keeps the existing request authority ... approvals, attempts and model
 *    claims never count"; "the PM aggregates its authorised delegates under the same requestId, and not the agent's
 *    later tasks"; "with shell or opaque tools say other file effects are not fully covered";
 *  - review resolution §5: "a direct turn is bound to its requestId; a coordinated task merges that request's
 *    delegate evidence; other requests of the workspace do not count";
 *  - handoff §5: "a later host restore/delete/uncertain effect shows the final observed state"; §7 row P5: "only the
 *    existing closeout is updated; an old reply does not overwrite a newer receipt".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, LiveTurnResult } from '../../backend/AgentBackend';
import { projectRequestSummary, type RequestChangesObservation, type RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';
import { noJobUsage } from '../../observability/JobOutcomeUsage';
import { reviseForFileEffects, type ObservedFileEffect } from '../RequestCloseoutAccumulator';
import type { AgentConfig } from '../../types';

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns = 0;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { this.turns += 1; }
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

const OK = { status: 'success' as const, observedBy: 'host' as const };
const reply = (overrides: Partial<LiveTurnResult> = {}): BackendEvent => ({
  kind: 'turn_complete',
  result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' }, ...overrides },
});
const write = (path: string, grade: ObservedFileEffect['grade'] = 'host-verified'): ObservedFileEffect => ({ path, key: `key:${path}`, operation: 'write', grade });

describe('the request effect ledger', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let backends: Map<string, FakeBackend>;
  let records: RequestCloseoutRecordV1[];
  let published: Array<{ requestId: string; changes: RequestChangesObservation }>;
  const backend = (id: string) => backends.get(id)!;
  /** As the extension does with each publication: every stored record takes it, and only its own request's changes. */
  const stored = (): RequestCloseoutRecordV1[] => records.map((record) => published.reduce(
    (held, { requestId, changes }) => reviseForFileEffects(held, requestId, changes) ?? held,
    record,
  ));
  const itemsOf = (record: RequestCloseoutRecordV1) =>
    projectRequestSummary(record, { usage: noJobUsage }).sections.find((section) => section.title === 'Changes')!.items ?? [];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T01:00:00.000Z'));
    bus = new MessageBus();
    backends = new Map();
    records = [];
    published = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        backends.set(config.id, created);
        return created;
      },
      resolveEnv: async () => ({}),
    });
    manager.on('session.requestCloseout', (event) => records.push(event.data.record));
    manager.on('session.requestFileEffects', (event) => published.push(event.data));
    for (const [id, role] of [['dev', 'senior-dev'], ['pm', 'pm'], ['solo', 'solo']] as Array<[string, AgentConfig['role']]>) {
      manager.create(makeConfig(id, role));
      await manager.start(id, { pin: 'take' });
      backend(id).emit({ kind: 'ready' });
    }
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it('closes an ordinary request with the host-verified change made for it, path and grade', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'fix the parser', mode: 'act' });
    manager.noteFileEffect(manager.currentRequestId('dev'), write('src/parse.ts'));
    manager.noteFileEffect(manager.currentRequestId('dev'), write('src/parse.ts'));
    backend('dev').emit(reply());
    expect(records).toHaveLength(1);
    expect(records[0].observations.changes).toEqual({
      coverage: 'complete',
      files: [{ path: 'src/parse.ts', operation: 'write', evidence: 'host-verified' }],
      omitted: 0,
      droppedPaths: 0,
      grades: { hostVerified: 1, nativeObserved: 0, uncertain: 0 },
    });
  });

  it('attributes a late document receipt to its captured request, not the agent newer request, without another effect', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'Write a document', mode: 'act' });
    const requestId = manager.currentRequestId('dev')!;
    manager.noteFileEffect(requestId, write('out/report.docx')); backend('dev').emit(reply());
    bus.send('user', 'dev', 'ask.question', { instruction: 'A different request', mode: 'act' });
    const nextId = manager.currentRequestId('dev')!; expect(nextId).not.toBe(requestId);
    manager.noteDocumentWritten(requestId, { kind: 'document-written', version: 1, path: 'out/report.docx', format: 'docx',
      template: 'report-v1', bytes: 123, sha256: 'a'.repeat(64), effect: 'created', blocks: 1, headings: 0, clauses: 0, tables: 0,
      rendererRevision: 2, fontManifestDigest: 'b'.repeat(64), layoutAdmissionPolicy: 'pdf-layout-v1/ucd-17.0.0',
      layoutWarnings: [{ code: 'reader-layout-unverified', scripts: ['Arab'], reasons: ['script'] }] });
    backend('dev').emit(reply());
    const old = stored().find(record => record.requestId === requestId)!;
    expect(old.observations.changes.documents?.[0].path).toBe('out/report.docx');
    expect(old.observations.changes.grades?.hostVerified).toBe(1);
    expect(stored().find(record => record.requestId === nextId)?.observations.changes.documents).toBeUndefined();
  });

  it('closes a Solo request from the same ledger', () => {
    bus.send('user', 'solo', 'ask.question', { instruction: 'save the logo', mode: 'act' });
    manager.noteFileEffect(manager.currentRequestId('solo'), write('assets/logo.png'));
    manager.noteFileEffect(manager.currentRequestId('solo'), write('notes.md', 'native-observed'));
    backend('solo').emit(reply());
    expect(itemsOf(records[0])).toEqual(['assets/logo.png (written, host-verified)', 'notes.md (written, CLI native observed)']);
  });

  it('counts nothing a reply, an approval or an attempt says: a model that claims it saved a file changed none', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'save the report', mode: 'act' });
    const dev = backend('dev');
    dev.emit({ kind: 'tool_use', callId: 'c1', name: 'write_file', input: { path: 'report.pdf' } });
    dev.emit({ kind: 'tool_result', callId: 'c1', name: 'write_file', outcome: OK, summary: 'Wrote report.pdf' });
    manager.recordApprovalOutcome('dev', 100, false, { decision: 'allowed', kind: 'write-approval' });
    dev.emit(reply({ text: 'I saved report.pdf and logo.png to the workspace.' }));
    const changes = records[0].observations.changes;
    expect(changes.files).toEqual([]);
    expect(changes.grades).toEqual({ hostVerified: 0, nativeObserved: 0, uncertain: 0 });
    expect(projectRequestSummary(records[0], { usage: noJobUsage }).headline.map((segment) => segment.text)).toContain('no verified file change observed');
  });

  it('counts a delegate\'s change for the PM\'s request, also after the PM\'s turn ended, and in the PM\'s woken turn', async () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the docs', mode: 'act' });
    const requestId = manager.currentRequestId('pm')!;
    manager.noteFileEffect(requestId, write('PLAN.md'));
    bus.send('pm', 'dev', 'task.assign', { instruction: 'write the guide' }, 'normal', 'h-1');
    expect(manager.currentRequestId('dev')).toBe(requestId);
    manager.noteFileEffect(manager.currentRequestId('dev'), write('docs/guide.md'));
    backend('pm').emit(reply());
    expect(records).toHaveLength(1);
    expect(records[0].terminalTurnId).toBe(request.id);
    expect(itemsOf(records[0])).toEqual(['PLAN.md (written, host-verified)', 'docs/guide.md (written, host-verified)']);

    // The delegate goes on after the PM's turn ended: the PM's record of this request takes it.
    manager.noteFileEffect(manager.currentRequestId('dev'), write('docs/index.md', 'native-observed'));
    expect(published.at(-1)?.requestId).toBe(requestId);
    expect(itemsOf(stored()[0])).toEqual([
      'PLAN.md (written, host-verified)', 'docs/guide.md (written, host-verified)', 'docs/index.md (written, CLI native observed)',
    ]);
    expect(stored()[0].revision).toBeGreaterThan(records[0].revision);
    backend('dev').emit(reply());

    // The PM is woken with the result: the same request, and its record lists all of it.
    manager.queueAsyncDelegationWake('pm', { handle: 'h-1', ref: 'dev', text: 'Guide written.', runId: 'run-1' }, () => true, () => true);
    await Promise.resolve();
    expect(manager.currentRequestId('pm')).toBe(requestId);
    backend('pm').emit(reply());
    expect(records).toHaveLength(2);
    expect(records[1].requestId).toBe(requestId);
    expect(itemsOf(records[1])).toEqual(itemsOf(stored()[0]));
  });

  it('keeps the delegate\'s later task, a request of its own, out of the PM\'s request', () => {
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the docs', mode: 'act' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'write the guide' }, 'normal', 'h-1');
    manager.noteFileEffect(manager.currentRequestId('dev'), write('docs/guide.md'));
    backend('dev').emit(reply());
    backend('pm').emit(reply());
    const pmRecord = records.find((record) => record.rootAgentId === 'pm')!;

    bus.send('user', 'dev', 'ask.question', { instruction: 'and fix the build', mode: 'act' });
    expect(manager.currentRequestId('dev')).not.toBe(pmRecord.requestId);
    manager.noteFileEffect(manager.currentRequestId('dev'), write('build.mjs'));
    backend('dev').emit(reply());
    const later = records.find((record) => record.rootAgentId === 'dev')!;
    expect(itemsOf(later)).toEqual(['build.mjs (written, host-verified)']);
    expect(itemsOf(stored().find((record) => record.rootAgentId === 'pm')!)).toEqual(['docs/guide.md (written, host-verified)']);
  });

  it('says that other effects are not covered when a delegate of the request ran a command', () => {
    bus.send('user', 'pm', 'ask.question', { instruction: 'tidy up', mode: 'act' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'remove the build output' }, 'normal', 'h-1');
    backend('dev').emit({ kind: 'tool_use', callId: 'c1', name: 'run_command', input: { command: 'npm run clean' } });
    backend('dev').emit({ kind: 'tool_result', callId: 'c1', name: 'run_command', outcome: OK, summary: 'exit 0' });
    backend('pm').emit(reply());
    expect(records[0].observations.changes).toMatchObject({ coverage: 'partial', notCovered: true });
  });

  it('counts an effect read back after its turn ended for the request it was planned for', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'edit it', mode: 'act' });
    const requestId = manager.currentRequestId('dev')!;
    backend('dev').emit(reply());
    expect(manager.currentRequestId('dev')).toBeUndefined();
    manager.noteFileEffect(requestId, write('late.ts', 'native-observed'));
    expect(itemsOf(stored()[0])).toEqual(['late.ts (written, CLI native observed)']);
    // Outside any request there is nothing to count it for.
    manager.noteFileEffect(undefined, write('nobody.ts'));
    expect(published.every((entry) => entry.requestId === requestId)).toBe(true);
  });

  it('shows a restore of the person on the request while its ledger is held, and says when it is not', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'edit it', mode: 'act' });
    const requestId = manager.currentRequestId('dev')!;
    manager.noteFileEffect(requestId, write('a.txt'));
    backend('dev').emit(reply());
    expect(manager.noteFileRestored(requestId, 'a.txt', 'restored')).toBe(true);
    expect(itemsOf(stored()[0])).toEqual(['a.txt (written, host-verified; restored by you since)']);
    expect(manager.noteFileRestored('request-not-held', 'a.txt', 'restored')).toBe(false);
  });

  it('lets an old request\'s ledger go only once nothing can continue it and it has been idle for minutes', () => {
    const turn = (path?: string): string => {
      bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
      const requestId = manager.currentRequestId('dev')!;
      if (path) manager.noteFileEffect(requestId, write(path));
      backend('dev').emit(reply());
      return requestId;
    };
    // A coordinator's request whose turn still runs: it can be continued, however long it has been quiet.
    bus.send('user', 'pm', 'ask.question', { instruction: 'a long job', mode: 'act' });
    const running = manager.currentRequestId('pm')!;
    manager.noteFileEffect(running, write('job.txt'));
    const idle = turn('idle.txt');
    vi.advanceTimersByTime(11 * 60_000);
    const recent = turn('recent.txt');
    for (let index = 0; index < 205; index++) turn();
    // The idle one is let go: its stored records take a restore themselves from now on.
    expect(manager.noteFileRestored(idle, 'idle.txt', 'restored')).toBe(false);
    // One used a moment ago is kept although nothing can continue it, so a late read-back still finds it.
    expect(manager.noteFileRestored(recent, 'recent.txt', 'restored')).toBe(true);
    expect(manager.noteFileRestored(running, 'job.txt', 'restored')).toBe(true);
  });

  it('never lets a late effect of an older request revise the record of a newer one', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'one', mode: 'act' });
    const first = manager.currentRequestId('dev')!;
    manager.noteFileEffect(first, write('one.txt'));
    backend('dev').emit(reply());
    bus.send('user', 'dev', 'ask.question', { instruction: 'two', mode: 'act' });
    manager.noteFileEffect(manager.currentRequestId('dev'), write('two.txt'));
    backend('dev').emit(reply());
    const newer = records[1];
    manager.noteFileEffect(first, write('one-late.txt'));
    const [older, newest] = stored();
    expect(itemsOf(older)).toEqual(['one.txt (written, host-verified)', 'one-late.txt (written, host-verified)']);
    expect(newest).toEqual(newer);
  });
});
