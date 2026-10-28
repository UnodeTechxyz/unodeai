import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_TURN_SNAPSHOT_HEADER,
  coordinatorTaskNeedsAttention,
  renderCoordinatorTurnSnapshot,
  userMentionedPaths,
  type CoordinatorTurnSnapshotInput,
} from '../CoordinatorTurnSnapshot';
import { SessionManager, coordinatorTurnInputs, type SessionManagerDeps } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { CoordinatorTaskStatus } from '../../backend/TeamTools';
import type { AgentConfig, Message } from '../../types';
import { estimateTokens } from '../../backend/TokenCounter';
import { createTurnContextManifest } from '../TurnContextManifest';

const AS_OF = new Date('2026-10-27T08:00:00.000Z');

const base = (fields: Partial<CoordinatorTurnSnapshotInput> = {}): CoordinatorTurnSnapshotInput => ({
  asOf: AS_OF, requestId: 'req-1', runId: 'run-1', turnId: 'turn-1', tasks: [], inputs: [], roster: [], ...fields,
});

const waiting = (handle: string, fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle, agentId: 'contract-analyst', lifecycle: 'settled', evidenceOutcome: 'verified', terminalAt: '2026-10-27T07:58:00.000Z',
  result: { handle, ref: { handle, revision: 2 }, state: 'awaiting-decision', execution: 'ended', wait: 'settled', nextAction: 'decide', blocksComplete: true } as never,
  ...fields,
});

const running = (handle: string, fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle, agentId: 'translator', lifecycle: 'active', dispatchedAt: '2026-10-27T07:56:48.000Z', execution: { state: 'running' }, ...fields,
});

describe('renderCoordinatorTurnSnapshot', () => {
  it('names the ids, the time, the waiting results and the running tasks', () => {
    const text = renderCoordinatorTurnSnapshot(base({ tasks: [waiting('h-wait'), running('h-run')] }));
    expect(text.split('\n').slice(0, 2)).toEqual([
      COORDINATOR_TURN_SNAPSHOT_HEADER,
      'As of 2026-10-27T08:00:00.000Z · request req-1 · run run-1 · turn turn-1',
    ]);
    expect(text).toContain('Results waiting for your decision (1):\n- h-wait · contract-analyst · result revision 2 · verified · returned 2026-10-27T07:58:00.000Z');
    expect(text).toContain('Running (1):\n- h-run · translator · dispatched 3m 12s ago');
    expect(text).not.toContain('Not shown');
  });

  it('keeps unknown apart from none', () => {
    expect(renderCoordinatorTurnSnapshot(base({ tasks: [] }))).toContain('Running:\n- none recorded');
    const unknown = renderCoordinatorTurnSnapshot(base({ tasks: undefined, runId: undefined }));
    expect(unknown).toContain('Running:\n- unknown: the host has no task records to read');
    expect(unknown).not.toContain('none recorded');
    expect(unknown).toContain('run not yet recorded');
  });

  it('shows interrupted work and a rework in the sections they belong to', () => {
    const text = renderCoordinatorTurnSnapshot(base({
      tasks: [
        { handle: 'h-lost', agentId: 'dev', lifecycle: 'interrupted', terminalAt: '2026-10-27T07:50:00.000Z' },
        running('h-rework', { lifecycle: 'settled', result: { state: 'awaiting-rework' } as never }),
        { handle: 'h-done', agentId: 'dev', lifecycle: 'settled', disposition: { value: 'accepted' } },
      ],
    }));
    expect(text).toContain('- h-lost · dev · interrupted: record superseded or abandoned · returned 2026-10-27T07:50:00.000Z');
    expect(text).toContain('- h-rework · translator · rework, dispatched 3m 12s ago');
    expect(text).not.toContain('h-done');
  });

  it('shows each teammate\'s actual lifecycle, and unknown when there is none', () => {
    const text = renderCoordinatorTurnSnapshot(base({
      roster: [
        { id: 'dev', name: 'Dev', role: 'senior-dev', lifecycle: 'stopped', route: 'openai-compat', model: 'deepseek-v4-flash' },
        { id: 'qa', name: 'QA', role: 'tester', lifecycle: 'starting' },
        { id: 'docs', name: 'Docs', role: 'custom' },
      ],
    }));
    expect(text).toContain('Team (3):\n- dev — Dev (role: senior-dev; openai-compat deepseek-v4-flash) · stopped\n'
      + '- qa — QA (role: tester) · starting\n- docs — Docs (role: custom) · unknown');
  });

  it('reports the previous turn\'s accepted and refused dispatches, and leaves the section out on a first turn', () => {
    const text = renderCoordinatorTurnSnapshot(base({
      previousTurn: { accepted: 1, refused: [{ requestedAgent: 'designer', reason: 'Error: no teammate "designer".' }] },
    }));
    expect(text).toContain('Your previous turn:\n- 1 dispatch accepted, 1 refused\n- refused for designer: Error: no teammate "designer".');
    expect(renderCoordinatorTurnSnapshot(base())).not.toContain('Your previous turn');
  });

  it('lists inputs with where they came from', () => {
    const text = renderCoordinatorTurnSnapshot(base({
      inputs: [
        { label: 'docs/spec.md', source: 'named' },
        { label: 'invoice.pdf', source: 'attached' },
        { label: 'notes/todo.md', source: 'user-mentioned' },
      ],
    }));
    expect(text).toContain('Inputs of this turn (3):\n- docs/spec.md (named with @)\n- invoice.pdf (attached)\n'
      + '- notes/todo.md (mentioned in the request; not opened or verified)');
  });

  it('stays within its budget, fills sections in priority order and says what it left out', () => {
    const tasks = [
      ...Array.from({ length: 100 }, (_, i) => waiting(`wait-${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 60 }, (_, i) => running(`run-${String(i).padStart(2, '0')}`)),
    ];
    const roster = Array.from({ length: 40 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, role: 'custom', lifecycle: 'idle' }));
    const text = renderCoordinatorTurnSnapshot(base({ tasks, roster }));
    expect(estimateTokens(text)).toBeLessThanOrEqual(2_000);
    expect(text).toContain('- wait-00 ·');
    expect(text).not.toContain('Running (');
    expect(text).not.toContain('Team (');
    expect(text).toMatch(/Not shown: \d+ waiting results, 60 running tasks, 40 teammates\. Use inspect_task_status for any task\. This block is a summary, not the full team record\.$/);
    // A record that is shown keeps its whole id.
    for (const line of text.split('\n').filter((row) => row.startsWith('- wait-'))) expect(line).toMatch(/^- wait-\d\d · /);
    // A smaller budget still holds.
    expect(estimateTokens(renderCoordinatorTurnSnapshot(base({ tasks, roster }), 400))).toBeLessThanOrEqual(400);
  });

  it('cuts a long display field on a code point boundary', () => {
    const name = '团队成员😀'.repeat(60);
    const text = renderCoordinatorTurnSnapshot(base({ roster: [{ id: 'm1', name, role: 'custom', lifecycle: 'idle' }] }));
    const shown = /- m1 — (.*) \(role/.exec(text)![1];
    expect([...shown]).toHaveLength(160);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('the inputs of a coordinator turn', () => {
  const msg = (payload: Message['payload'], from = 'user'): Message => ({
    id: 'm1', type: 'ask.question', from, to: 'pm', payload, timestamp: '', priority: 'normal',
  } as Message);

  it('lists structured records first, then paths quoted in a person\'s request as unverified', () => {
    const inputs = coordinatorTurnInputs(msg({
      instruction: 'Compare "docs/spec.md" with 「notes/todo.md」 and "the old plan".',
      contextManifestSources: [
        { kind: 'context-mention', label: 'spec', location: 'docs/spec.md', reason: '@ mention' },
        { kind: 'user-attachment', label: 'invoice.pdf', location: 'attachment', reason: 'attached' },
        { kind: 'repository-instruction', label: 'CLAUDE.md', location: 'CLAUDE.md', reason: 'rules' },
      ],
      files: ['src/app.ts'],
    }));
    expect(inputs).toEqual([
      { label: 'docs/spec.md', source: 'named' },
      { label: 'invoice.pdf', source: 'attached' },
      { label: 'src/app.ts', source: 'named' },
      { label: 'notes/todo.md', source: 'user-mentioned' },
    ]);
  });

  it('does not read paths out of a message that is not a person\'s request', () => {
    expect(coordinatorTurnInputs(msg({ instruction: 'Result: wrote "out/report.md".' }, 'unode'))).toEqual([]);
  });

  it('accepts the quote styles a request uses, and only path-like strings', () => {
    expect(userMentionedPaths('‘a/b.txt’ “c.md” 「d\\e」 『f.docx』 "g.json" "do not remove" "v2.0"')).toEqual(['a/b.txt', 'c.md', 'd\\e', 'f.docx', 'g.json']);
  });
});

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  contexts: Array<TurnAttachments | undefined> = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(_instruction: string, attachments?: TurnAttachments): void { this.contexts.push(attachments); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

const config = (id: string, role: AgentConfig['role'], fields: Partial<AgentConfig> = {}): AgentConfig => ({
  id, name: id === 'pm' ? 'PM' : 'Dev', role, skill: '',
  provider: { providerId: 'openai', apiKeySecretName: 'SECRET_KEY_NAME', baseUrl: 'https://endpoint.example/v1' } as AgentConfig['provider'],
  model: 'deepseek-v4-flash', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'openai-compat', ...fields,
});

describe('the team state a coordinator turn starts with', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let backends: Map<string, FakeBackend>;
  const outcomes: Array<[string, string, string, string | undefined]> = [];
  const keeps: Array<(task: CoordinatorTaskStatus) => boolean> = [];

  async function startTeam(deps: Partial<SessionManagerDeps> = {}): Promise<void> {
    bus = new MessageBus();
    backends = new Map();
    manager = new SessionManager(5, bus, {
      createBackend: (agent) => { const backend = new FakeBackend(agent); backends.set(agent.id, backend); return backend; },
      resolveEnv: async () => ({}),
      getTurnContextBundle: () => ({ projectContext: '', contextManifest: createTurnContextManifest([]) }),
      coordinatorTaskStatus: (_coordinatorId, keep) => {
        keeps.push(keep);
        return [running('h-run', { agentId: 'dev' })];
      },
      coordinatorDispatchOutcomes: (coordinatorId, from, to, correlationId) => {
        outcomes.push([coordinatorId, from, to, correlationId]);
        return { accepted: 2, refused: [] };
      },
      resolveRunId: () => 'run-7',
      ...deps,
    });
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']] as const) {
      manager.create(config(id, role as AgentConfig['role']));
      await manager.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AS_OF); outcomes.length = 0; keeps.length = 0; });
  afterEach(() => { manager?.dispose(); vi.useRealTimers(); });

  it('puts it in a coordinator turn\'s context and manifest, once, without keys or endpoints', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'Review "docs/spec.md".', mode: 'act' });
    const turn = backends.get('pm')!.contexts.at(-1)!;
    const context = turn.projectContext ?? '';
    expect(context.split(COORDINATOR_TURN_SNAPSHOT_HEADER)).toHaveLength(2);
    expect(context).toContain('· request ');
    expect(context).toContain('· run run-7 · turn ');
    expect(context).toContain('Running (1):\n- h-run · dev · dispatched 3m 12s ago');
    expect(context).toContain('- docs/spec.md (mentioned in the request; not opened or verified)');
    expect(context).toContain('- dev — Dev (role: senior-dev; openai-compat deepseek-v4-flash) · idle');
    expect(context).not.toMatch(/SECRET_KEY_NAME|endpoint\.example/);
    expect(turn.contextManifest?.entries.some((entry) => entry.label === 'Team state')).toBe(true);
    // A first turn has no previous turn to report.
    expect(context).not.toContain('Your previous turn');
  });

  // Codex's audit of 4efdab9b, I1: the records are selected by need before any limit, by the session itself.
  it('asks for the records that still need attention, not a newest-N window', async () => {
    await startTeam();
    keeps.length = 0; // v0.9.99: the PM status read at start-up (P5 restore) uses its own selection.
    bus.send('user', 'pm', 'ask.question', { instruction: 'Go.', mode: 'act' });
    expect(keeps).toEqual([coordinatorTaskNeedsAttention]);
    const [keep] = keeps;
    expect(keep(running('h-a'))).toBe(true);
    expect(keep(waiting('h-b'))).toBe(true);
    expect(keep({ handle: 'h-c', lifecycle: 'cancelled' })).toBe(false);
    expect(keep({ handle: 'h-d', lifecycle: 'settled', disposition: { value: 'accepted' } })).toBe(false);
  });

  it('gives a worker turn none', async () => {
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'Fix it.', mode: 'act' });
    expect(backends.get('dev')!.contexts.at(-1)?.projectContext ?? '').not.toContain(COORDINATOR_TURN_SNAPSHOT_HEADER);
  });

  it('reports the previous turn by the span from its start to this turn\'s start', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'First.', mode: 'act' });
    const first = bus.query({ type: 'ask.question', to: 'pm' }).at(-1)!;
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } } as BackendEvent);
    vi.setSystemTime(new Date(AS_OF.getTime() + 60_000));
    bus.send('user', 'pm', 'ask.question', { instruction: 'Second.', mode: 'act' });
    // v0.9.99: the first turn's close also reads its own span, for its PM status; the second turn's start reads it again.
    const second = new Date(AS_OF.getTime() + 60_000).toISOString();
    expect(outcomes.filter((row) => row[2] === second)).toEqual([['pm', AS_OF.toISOString(), second, first.correlationId ?? first.id]]);
    expect(backends.get('pm')!.contexts.at(-1)?.projectContext).toContain('Your previous turn:\n- 2 dispatches accepted, 0 refused');
  });

  it('still starts the turn when the records cannot be read, and says they are unknown', async () => {
    await startTeam({ coordinatorTaskStatus: () => { throw new Error('ledger unavailable'); } });
    bus.send('user', 'pm', 'ask.question', { instruction: 'Go.', mode: 'act' });
    expect(backends.get('pm')!.contexts.at(-1)?.projectContext).toContain('Running:\n- unknown: the host has no task records to read');
  });
});
