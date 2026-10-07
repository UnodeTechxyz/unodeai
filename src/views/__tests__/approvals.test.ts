import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalDecision, ApprovalDecisionBroker, ApprovalEvent, ApprovalQueue } from '../approvals';

describe('ApprovalQueue', () => {
  it('resolves a request with the user decision and removes it from the queue', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    expect(q.list()).toHaveLength(1);
    expect(q.pendingCount()).toBe(1);

    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'session' })).toBe(true);
    await expect(p).resolves.toEqual({ action: 'session' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('carries a deny note through to the awaiter', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'rm -rf /' });
    q.resolve(q.list()[0].id, { action: 'deny', note: 'use npm run clean' });
    await expect(p).resolves.toEqual({ action: 'deny', note: 'use npm run clean' });
  });

  it('keeps multiple requests independent and resolvable out of order', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'write', agentName: 'A', path: 'a.ts', verb: 'create', diff: '+1' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b.ts', verb: 'overwrite', diff: '+2' });
    expect(q.list()).toHaveLength(2);
    const [idA, idB] = q.list().map((r) => r.id);

    q.resolve(idB, { action: 'always' });
    await expect(b).resolves.toEqual({ action: 'always' });
    expect(q.list().map((r) => r.id)).toEqual([idA]);

    q.resolve(idA, { action: 'once' });
    await expect(a).resolves.toEqual({ action: 'once' });
    expect(q.list()).toHaveLength(0);
  });

  it('resolve() returns false for an unknown or already-resolved id', () => {
    const q = new ApprovalQueue();
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'once' })).toBe(true);
    expect(q.resolve(id, { action: 'once' })).toBe(false);
    expect(q.resolve('nope', { action: 'once' })).toBe(false);
  });

  it('denyAll() resolves everything pending as a deny (so a torn-down panel never hangs)', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'command', agentName: 'A', command: 'x' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b', verb: 'create', diff: '' });
    q.denyAll();
    await expect(a).resolves.toEqual({ action: 'deny' });
    await expect(b).resolves.toEqual({ action: 'deny' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('fires onChange when the queue changes', () => {
    const onChange = vi.fn();
    const q = new ApprovalQueue(onChange);
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    expect(onChange).toHaveBeenCalledTimes(1);
    q.resolve(q.list()[0].id, { action: 'once' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('emits transport-neutral pending and decided events with the approver identity', async () => {
    const events: ApprovalEvent[] = [];
    const q = new ApprovalQueue(undefined, (event) => events.push(event));
    const pending = q.request({
      kind: 'command',
      agentId: 'agent-42',
      sessionId: 'session-42',
      agentName: 'Developer',
      command: 'npm test',
    }, 500);
    const id = q.list()[0].id;

    expect(events[0]).toMatchObject({
      type: 'pending',
      approval: {
        id,
        agent: { id: 'agent-42', name: 'Developer' },
        sessionId: 'session-42',
        action: { kind: 'command', summary: 'Run a command', target: 'npm test' },
        deadline: expect.any(String),
      },
    });
    // The event is ordinary data: safe for a future mobile/web subscriber and contains no editor object.
    expect(JSON.stringify(events[0]).toLowerCase()).not.toContain('vscode');

    q.resolve(id, { action: 'once' }, 'local:owner-1');
    await expect(pending).resolves.toEqual({ action: 'once' });
    expect(events[1]).toMatchObject({
      type: 'decided',
      approvalId: id,
      agent: { id: 'agent-42', name: 'Developer' },
      sessionId: 'session-42',
      decision: { action: 'once' },
      approverId: 'local:owner-1',
    });
  });

  it('returns the host-attached actor only for a contemporaneous human decision', async () => {
    const q = new ApprovalQueue();
    const decided = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    q.resolve(q.list()[0].id, { action: 'once' }, 'local:machine-canary');
    await expect(decided).resolves.toMatchObject({
      action: 'once', approverId: 'local:machine-canary', approvalId: expect.stringMatching(/^appr-/),
    });

    const disposed = q.requestWithIdentity({ kind: 'write', agentName: 'Dev', path: 'a.ts', verb: 'create' });
    q.denyAll();
    await expect(disposed).resolves.toMatchObject({ action: 'deny', approvalId: expect.stringMatching(/^appr-/) });
  });

  it('removes a bounded approval and returns a clean deny when its human window lapses', async () => {
    vi.useFakeTimers();
    try {
      const events: ApprovalEvent[] = [];
      const q = new ApprovalQueue(undefined, (event) => events.push(event));
      const pending = q.requestWithIdentity({ kind: 'tool', agentId: 'researcher', agentName: 'Researcher', toolName: 'Web access' }, 60);
      expect(q.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({
        action: 'deny', note: 'The approval window expired.', expired: true, approvalId: expect.stringMatching(/^appr-/),
      });
      expect(q.pendingCount()).toBe(0);
      expect(q.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'expired',
        agent: { id: 'researcher', name: 'Researcher' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never revives an expired approval as approved or reuses its opaque id', async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue();
      const expired = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const expiredId = q.list()[0].id;
      await vi.advanceTimersByTimeAsync(60);
      await expect(expired).resolves.toMatchObject({ action: 'deny', expired: true, approvalId: expiredId });
      expect(q.resolve(expiredId, { action: 'once' })).toBe(false);

      const fresh = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const freshId = q.list()[0].id;
      expect(freshId).not.toBe(expiredId);
      expect(q.resolve(freshId, { action: 'once' })).toBe(true);
      await expect(fresh).resolves.toMatchObject({ action: 'once', approvalId: freshId });

      // Mutation canary: restoring a resolver in expire(), or resolving the old id after it has left the
      // queue, turns a timed-out consent into an approval without a fresh human decision.
    } finally {
      vi.useRealTimers();
    }
  });
});

// v0.9.88 §5.10: one settlement authority for every approval, card or modal.
describe('ApprovalDecisionBroker', () => {
  const command = (sessionId: string) => ({ kind: 'command' as const, agentName: sessionId, agentId: sessionId, sessionId, command: 'npm test' });

  it('settles a prompt once and drops every later answer', async () => {
    const broker = new ApprovalDecisionBroker();
    const { approvalId, outcome } = broker.open(command('dev'));
    expect(broker.settle(approvalId, { action: 'once' }, 'human', 'local:owner')).toBe(true);
    expect(broker.settle(approvalId, { action: 'always' }, 'human', 'local:owner')).toBe(false);
    await expect(outcome).resolves.toMatchObject({ action: 'once', settledBy: 'human', approverId: 'local:owner' });
    expect(broker.list()).toEqual([]);
  });

  it('expires a native-modal prompt at its deadline and drops the modal answer that comes later', async () => {
    vi.useFakeTimers();
    try {
      const events: ApprovalEvent[] = [];
      const broker = new ApprovalDecisionBroker();
      broker.subscribe({ onEvent: (event) => events.push(event) });
      let answer!: (decision: ApprovalDecision) => void;
      const { outcome } = broker.openModal(command('dev'), 60, () => new Promise((resolve) => { answer = resolve; }), 'local:owner');
      await vi.advanceTimersByTimeAsync(60);
      await expect(outcome).resolves.toMatchObject({ action: 'deny', expired: true, settledBy: 'expired' });
      // The person clicks "Allow for project" on the modal VS Code could not dismiss: nothing happens.
      answer({ action: 'project' });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.map((event) => event.type)).toEqual(['pending', 'expired']);
      expect(broker.list('modal')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets one session leave a shared prompt while the other keeps waiting and alone receives the later allow', async () => {
    const broker = new ApprovalDecisionBroker();
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const { approvalId, outcome: first } = broker.open(command('researcher'), { timeoutMs: 60_000 });
    const second = broker.join(approvalId, 'developer')!;

    expect(broker.leave('researcher')).toBe(1);
    await expect(first).resolves.toMatchObject({ action: 'deny', withdrawn: true, settledBy: 'withdrawn' });
    expect(broker.isOpen(approvalId)).toBe(true);
    expect(broker.list()).toHaveLength(1);

    expect(broker.settle(approvalId, { action: 'always' }, 'human', 'local:owner')).toBe(true);
    await expect(second).resolves.toMatchObject({ action: 'always', settledBy: 'human' });
    await expect(first).resolves.toMatchObject({ settledBy: 'withdrawn' });
    expect(waits).toEqual([
      ['researcher', true],
      ['developer', true],
      ['researcher', false],
      ['developer', false],
    ]);
  });

  it('withdraws a prompt when its last participant leaves, removing the card for good', async () => {
    const broker = new ApprovalDecisionBroker();
    const events: ApprovalEvent[] = [];
    broker.subscribe({ onEvent: (event) => events.push(event) });
    const { approvalId, outcome } = broker.open(command('dev'), { timeoutMs: 60_000 });

    broker.leave('dev');
    await expect(outcome).resolves.toMatchObject({ action: 'deny', withdrawn: true });
    expect(events.map((event) => event.type)).toEqual(['pending', 'withdrawn']);
    expect(broker.list()).toEqual([]);
    // A click that arrives after Stop grants nothing.
    expect(broker.settle(approvalId, { action: 'project' }, 'human', 'local:owner')).toBe(false);
  });

  it('reports one wait per session across overlapping prompts, ending only when the last one settles', () => {
    const broker = new ApprovalDecisionBroker();
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const a = broker.open(command('dev'));
    const b = broker.open({ ...command('dev'), command: 'npm run build' });
    broker.settle(a.approvalId, { action: 'deny' }, 'human');
    expect(waits).toEqual([['dev', true]]);
    broker.settle(b.approvalId, { action: 'once' }, 'human');
    expect(waits).toEqual([['dev', true], ['dev', false]]);
  });

  it('settles everything open as a denial on disposal, with no human approver', async () => {
    const broker = new ApprovalDecisionBroker();
    const card = broker.open(command('dev'));
    const modal = broker.openModal(command('qa'), 60_000, () => new Promise(() => undefined), 'local:owner');
    broker.disposeAll();
    for (const outcome of [card.outcome, modal.outcome]) {
      const settled = await outcome;
      expect(settled).toMatchObject({ action: 'deny', settledBy: 'host-disposed' });
      expect(settled.approverId).toBeUndefined();
    }
    expect(broker.pendingCount()).toBe(0);
  });

  it('shows cards in the chat queue and keeps modal prompts out of it', () => {
    const broker = new ApprovalDecisionBroker();
    const queue = new ApprovalQueue(undefined, undefined, broker);
    queue.request(command('dev'));
    broker.openModal(command('qa'), 60_000, () => new Promise(() => undefined), 'local:owner');
    expect(queue.list().map((request) => request.sessionId)).toEqual(['dev']);
    expect(broker.list('modal').map((request) => request.sessionId)).toEqual(['qa']);
    expect(queue.pendingCount()).toBe(2);
  });

  // v0.9.88 §5.11: the broker is the one place every approval opens, so it raises the attention sound.
  it('sounds once when a card prompt opens, keyed by its id, before any decision', () => {
    const keys: string[] = [];
    const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
    const { approvalId } = broker.open(command('dev'));
    expect(keys).toEqual([`approval:${approvalId}`]);
    broker.settle(approvalId, { action: 'once' }, 'human');
    expect(keys).toHaveLength(1);
  });

  it('sounds a native-modal prompt as it opens, before the modal is shown', async () => {
    const keys: string[] = [];
    const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
    let soundsWhenShown = -1;
    const { outcome } = broker.openModal(command('dev'), 60_000, async () => {
      soundsWhenShown = keys.length;
      return { action: 'deny' };
    }, 'local:owner');
    await outcome;
    expect(soundsWhenShown).toBe(1);
    expect(keys).toHaveLength(1);
  });

  it('adds no sound when another session joins the prompt, when one leaves, or when it expires', async () => {
    vi.useFakeTimers();
    try {
      const keys: string[] = [];
      const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
      const { approvalId, outcome } = broker.open(command('dev'), { timeoutMs: 100 });
      const joined = broker.join(approvalId, 'qa');
      broker.leave('qa');
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      await joined;
      expect(keys).toEqual([`approval:${approvalId}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the prompt even when the sound throws', async () => {
    const broker = new ApprovalDecisionBroker({ attention: () => { throw new Error('player gone'); } });
    const { approvalId, outcome } = broker.open(command('dev'));
    expect(broker.isOpen(approvalId)).toBe(true);
    broker.settle(approvalId, { action: 'deny' }, 'human');
    await expect(outcome).resolves.toMatchObject({ action: 'deny', settledBy: 'human' });
  });
});

// §5.10 point 9: every approval the extension raises names its session, so Stop can withdraw it and the
// waiting state belongs to the right agent.
describe('extension approval call sites', () => {
  it('pass the requesting session into every brokered prompt', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const calls = [...source.matchAll(/(?:brokeredApproval|openBrokeredApproval|chatViewProvider!?\.requestApproval)\(\s*/g)]
      .map((match) => match.index!)
      // Skip the helper definitions themselves.
      .filter((index) => !/function\s+$/.test(source.slice(Math.max(0, index - 12), index)));
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const index of calls) {
      const call = source.slice(index, source.indexOf(');', index) + 2);
      expect(call, call.slice(0, 120)).toMatch(/\.\.\.origin|sessionId: request\.sessionId|\brequest\b,/);
    }
  });

  // `...origin` in the prompt names nobody when the origin is a default. A backend calls its approver with the
  // request alone, so one that is handed the approval function itself asks in no agent's name: the card belongs
  // to no agent, Stop cannot withdraw it, and the person's wait counts as the agent's tool time. The
  // OpenAI-compatible route's write approval was wired that way until a v0.9.92 field run showed a write card
  // reading `Done · 31.6s` under a footer that had excluded only another prompt.
  it('never hand a backend an approval function without the agent it asks for', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const approvals = [
      'requestWriteApproval', 'requestCommandApproval', 'requestExecutableSkillApproval', 'requestClaudeToolApproval',
      'requestCodexApproval', 'egressGate', 'codexEgressGate', 'mediaEgressGate', 'repositoryCliLaunchApproval',
    ];
    for (const name of approvals) {
      // Every mention is a call, the declaration, or a property of that name. None is the function as a value.
      const asValue = [...source.matchAll(new RegExp(`\\b${name}\\b(?![(:])`, 'g'))]
        .map((match) => source.slice(match.index! - 40, match.index! + name.length + 20));
      expect(asValue, name).toEqual([]);
    }
    // Both hosted tool loops ask for a write through the one approver that names the agent.
    expect(source).toContain('const approveWriteForAgent: WriteApprover = (request) => requestWriteApproval(request, scopedConfig.name, approvalOrigin);');
    expect(source).toMatch(/new OpenAICompatBackend\([^\n]*, writeApprovalAsk, approveWriteForAgent, memoryWriter, /);
    expect(source).toContain('requestWriteApproval: approveWriteForAgent,');
    // No default for whose write it is, so the compiler refuses the function where an approver is expected.
    expect(source).toMatch(/async function requestWriteApproval\(\s+req: \{[^}]*\},\s+agentName: string,\s+origin: \{ agentId\?: string; sessionId\?: string \},\s+\): Promise/);
  });

  // v0.9.92: the time a person takes is not the agent's. This covers the approvals that go through the broker or
  // the chat card; the blocking prompts are covered by the next test.
  it('wait for every brokered approval with the turn clock paused', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const prompts = [...source.matchAll(/(?:brokeredApproval|openBrokeredApproval|chatViewProvider!?\.requestApproval)\(/g)]
      .map((match) => match.index!)
      .filter((index) => !/function\s+$/.test(source.slice(Math.max(0, index - 12), index)))
      // `brokeredApproval` only forwards to `openBrokeredApproval`; the wait is at its callers.
      .filter((index) => !source.slice(index).startsWith('openBrokeredApproval(request, timeoutMs, showModal).outcome'));
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    for (const index of prompts) {
      const before = source.slice(Math.max(0, index - 60), index);
      expect(before, source.slice(index, index + 80)).toMatch(/timedApproval\((?:origin|request), \(\) => (?:\{\s+const opened = )?$/);
    }
    // A request that joins a prompt already open waits as long as the one that opened it.
    expect(source).toContain('timedApproval(request, () => joined)');
    expect(source).toMatch(/function timedApproval<T>\([\s\S]{0,160}?return sessionManager\.timeApproval\(origin\.sessionId \?\? origin\.agentId, open\);/);
  });

  // `blockingPrompt` has no default for whose wait a prompt is, so the compiler makes every call state it. This
  // pins what the calls state: the raising agent's turn clock, or for the two prompts that several agents can
  // wait on, the clock of each agent that waits.
  it('pause a turn clock for every blocking prompt: the raising agent\'s, or each waiting agent\'s for a shared one', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const calls = source.match(/\bblockingPrompt\(/g) ?? [];
    const paused = source.match(/\n\s*\), pausingTurnClock\(/g) ?? [];
    const untimed = [...source.matchAll(/\n\s*\), untimedPrompt\('((?:[^'\\]|\\.)*)'\)\);/g)].map((match) => match[1]);
    const mount = source.match(/\n\s*\), mcpMountWaits\.prompt\(cfg\.id\)\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(9);
    expect(paused.length + untimed.length + mount.length).toBe(calls.length);
    // The read-scope prompt pauses nothing itself: each agent's own gate pauses that agent's clock.
    expect(untimed).toEqual([expect.stringContaining('Several agents can wait on this one prompt')]);
    expect(source).toContain('ensure: (root) => localReadScopeConsent.ensure(root, pausingTurnClock(approvalOrigin)),');
    expect(source.match(/localReadScopeConsent: localReadConsentForAgent,/g)).toHaveLength(2);
    // The MCP mount prompt pauses every start that is waiting on that mount, for as long as that start waits.
    expect(mount).toHaveLength(1);
    // A start waits on the mount through `waitAs`, which counts it among the waiters until its deadline and no
    // longer. The combined behaviour, with the lease and a retry behind an old dialog, has its own tests.
    expect(source).toMatch(/const waited = await mcpMountWaits\.waitAs\(cfg\.id, config\.id, lease\.promise, remainingMs\)\s+\.finally\(\(\) => lease\.release\(\)\);/);
    expect(source).toMatch(/const mcpMountWaits = new SharedPromptWaits\(\{\s+approvalStarted: \(sessionId, approvalId\) => sessionManager\.approvalStarted\(sessionId, approvalId\),\s+approvalFinished: \(sessionId, approvalId\) => sessionManager\.approvalFinished\(sessionId, approvalId\),/);
    // A prompt raised inside the coordinator's dispatch_task call pauses the coordinator's clock.
    const brief = source.slice(source.indexOf('async function approveCoordinatorBriefEgress('));
    expect(brief.slice(0, brief.indexOf('\n}\n'))).toContain('), pausingTurnClock({ agentId: coordinator.id, sessionId: coordinator.id }));');
    expect(source).toMatch(/function pausingTurnClock\(origin: \{[^}]*\}\): PromptWait \{\s+return \(wait\) => timedApproval\(origin, async \(\) => wait\(\)\)\.then\(\(\{ outcome \}\) => outcome\);/);
  });
});

// v0.9.92: the host's turn facts reach their two consumers. The ledger keeps every ended turn; the chat shows the phase.
describe('extension turn fact wiring', () => {
  it('hands each ended turn to the run ledger and each live phase to the chat', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(source).toMatch(/sessionManager\.on\('session\.turnEnded', \(e\) => \{\s+if \(e\.sessionId && e\.data\) \{\s+runLedger\.recordTurn\(e\.sessionId, e\.data\);/);
    expect(source).toMatch(/sessionManager\.on\('session\.turnPhase', \(e\) => \{\s+if \(e\.sessionId && e\.data\) \{\s+chatViewProvider\?\.setTurnPhase\(e\.sessionId, e\.data\.phase, e\.data\.epoch\);/);
  });
});
