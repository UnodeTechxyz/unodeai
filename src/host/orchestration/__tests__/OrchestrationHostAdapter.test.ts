import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { MessageBus } from '../../../bus/MessageBus';
import { AgentCommandPolicy } from '../../../backend/AgentCommandPolicy';
import { CommandPolicy } from '../../../backend/CommandPolicy';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import { TaskClaimRegistry } from '../../../backend/TaskClaimRegistry';
import type { AgentConfig } from '../../../types';
import { ENDED_ATTEMPT_REFUSAL, type TeamRosterEntry, type TeamTools } from '../../../backend/TeamTools';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../../backend/AgentBackend';
import { SessionManager } from '../../../session/SessionManager';
import type { FirstActionEvidence } from '../../../session/FirstActionGuard';
import {
  CoordinatorRuntimePort,
  OrchestrationEvidencePort,
  OrchestrationHostAdapter,
  userTurnSources,
} from '../OrchestrationHostAdapter';

const stores: ContentAssetStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
});

function agent(id: string, role = 'developer'): AgentConfig {
  return {
    id,
    name: id,
    role,
    provider: { providerId: 'openai' },
    model: 'test-model',
  } as AgentConfig;
}

class FakeBackend implements AgentBackend {
  pid = 1234;
  private handler?: BackendEventHandler;
  constructor(readonly agentId: string) {}
  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { /* a process the test drives by hand */ }
  sendUserTurn(): void { /* the test emits the provider's events itself */ }
  async stop(): Promise<void> { this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing to abort */ }
  isAlive(): boolean { return true; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function runtimeFor(configs: AgentConfig[]): CoordinatorRuntimePort {
  const byId = new Map(configs.map((config) => [config.id, config]));
  const roster: TeamRosterEntry[] = configs.map((config) => ({
    id: config.id,
    name: config.name,
    role: config.role,
    status: 'idle',
    capabilities: { read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'] },
  }));
  return {
    workspace: () => ({
      root: () => process.cwd(),
      roots: () => [process.cwd()],
      isTrusted: () => true,
      additionalReadRoots: () => [],
    }),
    messageBus: () => new MessageBus(),
    teamEntries: () => roster,
    resolveTeam: (ref) => byId.has(ref) ? { id: ref } : undefined,
    configForAgent: (id) => byId.get(id),
    backendKindFor: (config) => config.backend ?? 'openai-compat',
    commandPolicyFor: () => ({}) as AgentCommandPolicy,
    verifyCommandFor: () => '',
    workingDirectoryFor: () => process.cwd(),
    requestCommandApproval: async () => ({ allow: false }),
    routeNotice: () => undefined,
    commandBlocked: () => undefined,
    verifyCommandOutsideRoot: () => undefined,
    taskClaims: () => new TaskClaimRegistry(),
    escalateToFallback: () => ({ switched: false, reason: 'unknown-agent' }),
    cancelDelegatedWorker: () => false,
    stopTeammate: () => false,
    queueAsyncDelegationWake: () => true,
    recoveredAsyncResults: () => [],
    retainAsyncResult: () => undefined,
    consumeAsyncResult: () => undefined,
    warnUser: () => undefined,
    openRecordedFile: async () => undefined,
  };
}

const evidence: OrchestrationEvidencePort = {
  recordDispatched: () => undefined,
  recordRefused: () => undefined,
  recordEvidence: () => undefined,
  recordDisposition: () => undefined,
  recordLateReworkReply: () => undefined,
  recordCancelled: () => undefined,
  recordDeliveryPending: () => undefined,
  recordDeliveryDelivered: () => undefined,
  inspectTaskStatus: (_coordinatorId, handles) => (handles ?? []).map((handle) => ({ handle, lifecycle: 'unknown' })),
  recordEmptyOutcome: () => undefined,
  runIdForDelegation: () => undefined,
  openHumanReview: () => undefined,
  refreshAfterAsyncResult: () => undefined,
};

describe('OrchestrationHostAdapter', () => {
  it('offers recovered results to the normal wake lane, rechecking revision eligibility at the actual handoff', () => {
    const runtime = runtimeFor([agent('pm', 'pm')]);
    const result = { handle: 'recovered', ref: 'dev', text: 'persisted answer', resultRevision: 2 };
    runtime.recoveredAsyncResults = () => [result];
    runtime.queueAsyncDelegationWake = vi.fn(() => true);
    let eligible = true; runtime.resultEligible = vi.fn(() => eligible); runtime.resultDelivered = vi.fn();
    const delivered = vi.fn(); const adapter = new OrchestrationHostAdapter(runtime, { ...evidence, recordDeliveryDelivered: delivered });
    adapter.offerRecoveredResults('pm');
    const [, queued, ready, consume] = vi.mocked(runtime.queueAsyncDelegationWake).mock.calls[0];
    expect(queued).toEqual(result); expect(ready()).toBe(true);
    eligible = false; expect(consume()).toBe(false); expect(delivered).not.toHaveBeenCalled();
    eligible = true; expect(consume()).toBe(true);
    expect(runtime.resultDelivered).toHaveBeenCalledWith('pm', 'recovered', 'auto-wake', 2);
    expect(delivered).toHaveBeenCalledWith('recovered', 'auto-wake');
    vi.mocked(runtime.queueAsyncDelegationWake).mockClear();
    adapter.offerRecoveredResults('pm', []); expect(runtime.queueAsyncDelegationWake).not.toHaveBeenCalled();
  });

  it('run_checks asks the live host for the calling coordinator, never the selected worker', async () => {
    const coordinator = agent('pm', 'pm');
    const runtime = runtimeFor([coordinator, agent('worker')]);
    runtime.runVerification = vi.fn(async () => ({ kind: 'not-run', reason: 'disabled', detail: 'Team disabled checks.', source: 'team-document' }));
    const adapter = new OrchestrationHostAdapter(runtime, evidence);
    const store = new ContentAssetStore(); stores.push(store); adapter.createTaskInputResolver(store);
    const output = await adapter.createCoordinatorTeamTools(coordinator, { launchId: 'launch-A' }).run('run_checks', {});
    expect(runtime.runVerification).toHaveBeenCalledWith(coordinator, 'launch-A');
    expect(output).toContain('not run (disabled)');
  });
  it('constructs and drives the coordinator surface through test ports without extension activation', async () => {
    const coordinator = agent('pm', 'pm');
    const worker = agent('worker');
    const adapter = new OrchestrationHostAdapter(runtimeFor([coordinator, worker]), evidence);
    const store = new ContentAssetStore();
    stores.push(store);
    adapter.createTaskInputResolver(store);

    const result = await adapter.createCoordinatorTeamTools(coordinator, 'host').run('list_agents', {});

    expect(result).toContain('worker');
    expect(result).not.toContain('vscode');
  });

  // v0.9.99 P4: the PM status reads the outcome of the coordinator's own close_assignment.
  it('tells the host the outcome of each recorded close_assignment', async () => {
    const coordinator = agent('pm', 'pm');
    const runtime = runtimeFor([coordinator, agent('worker')]);
    const closes: string[] = [];
    runtime.assignmentClosed = (coordinatorId, outcome) => { closes.push(`${coordinatorId}:${outcome}`); };
    const adapter = new OrchestrationHostAdapter(runtime, evidence);
    const store = new ContentAssetStore();
    stores.push(store);
    adapter.createTaskInputResolver(store);
    const tools = adapter.createCoordinatorTeamTools(coordinator, 'host');
    await tools.runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered.' });
    await tools.runOutcome('close_assignment', { outcome: 'partial', summary: 'Half.', incomplete: [{ item: 'B', reason: 'blocked by access' }] });
    await tools.runOutcome('close_assignment', { outcome: 'bogus', summary: 'x' });
    expect(closes).toEqual(['pm:complete', 'pm:partial']);
  });

  // v0.9.97 L0: a handle's execution is the host's to report, bound to the handle; the team view carries it unchanged.
  it('gives the team tools the host\'s per-handle execution view, and none when the host has none', () => {
    const runtime = runtimeFor([agent('pm', 'pm'), agent('worker')]);
    expect(new OrchestrationHostAdapter(runtime, evidence).makeTeamView().execution).toBeUndefined();
    const asked: string[] = [];
    runtime.delegationExecution = (agentId, handle) => {
      asked.push(`${agentId}:${handle}`);
      return { state: 'stop-unconfirmed', detail: 'process 7 was still running' };
    };
    const view = new OrchestrationHostAdapter(runtime, evidence).makeTeamView();
    expect(view.execution!('worker', 'h-old')).toEqual({ state: 'stop-unconfirmed', detail: 'process 7 was still running' });
    expect(asked).toEqual(['worker:h-old']);
  });

  it('builds the coordinator\'s candidate snapshot from the roster as it is, and asks the first-action gate with the launch the tools serve', async () => {
    const coordinator = agent('pm', 'pm');
    const worker = agent('worker');
    const members = [coordinator, worker];
    const runtime = runtimeFor(members);
    const gate: string[] = [];
    let open = true;
    runtime.firstActionCallArrived = (coordinatorId, launchId, tool) => {
      gate.push(`arrived:${coordinatorId}:${launchId}:${tool}`);
      return open;
    };
    runtime.firstActionCallAnswered = (coordinatorId, launchId, tool, accepted) => {
      gate.push(`answered:${coordinatorId}:${launchId}:${tool}:${accepted}`);
    };
    const adapter = new OrchestrationHostAdapter(runtime, evidence);
    const store = new ContentAssetStore();
    stores.push(store);
    adapter.createTaskInputResolver(store);

    expect(adapter.candidateSnapshot(coordinator)).toMatch(/^\[Team candidates for this request, supplied by UnodeAi\]\n[\s\S]*\n- worker — /);
    // Built when asked: a teammate added since is in the next one.
    const roster = runtime.teamEntries();
    runtime.teamEntries = () => [...roster, { id: 'second', name: 'second', role: 'developer', status: 'idle' }];
    expect(adapter.candidateSnapshot(coordinator)).toMatch(/\n- worker — [^\n]*\n- second — /);

    // Two sets of tools for the same coordinator, as two starts of its backend build them. Each names its own launch.
    const tools = adapter.createCoordinatorTeamTools(coordinator, { launchId: 'launch-1' });
    const later = adapter.createCoordinatorTeamTools(coordinator, { launchId: 'launch-2' });
    await expect(tools.runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered.' }))
      .resolves.toMatchObject({ status: 'success' });
    await expect(later.runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered again.' }))
      .resolves.toMatchObject({ status: 'success' });
    open = false;
    await expect(tools.runOutcome('close_assignment', { outcome: 'complete', summary: 'Late.' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'safety-limit' });
    expect(gate).toEqual([
      'arrived:pm:launch-1:close_assignment', 'answered:pm:launch-1:close_assignment:true',
      'arrived:pm:launch-2:close_assignment', 'answered:pm:launch-2:close_assignment:true',
      'arrived:pm:launch-1:close_assignment',
    ]);

    // Tools the host builds for an action of its own are no provider's attempt: the gate is not asked.
    gate.length = 0;
    await expect(adapter.createCoordinatorTeamTools(coordinator, 'host')
      .runOutcome('close_assignment', { outcome: 'complete', summary: 'Host.' }))
      .resolves.toMatchObject({ status: 'success' });
    expect(gate).toEqual([]);
  });

  it('keeps quiet turns running, but refuses old launch calls after the user stops and retries', async () => {
    vi.useFakeTimers();
    let manager: SessionManager | undefined;
    try {
      const coordinator = { ...agent('pm', 'pm'), systemPrompt: '', skill: '', autoApprove: true, allowedTools: [] } as AgentConfig;
      const worker = { ...agent('worker'), systemPrompt: '', skill: '', autoApprove: true, allowedTools: [] } as AgentConfig;
      const bus = new MessageBus();
      const runtime = runtimeFor([coordinator, worker]);
      runtime.messageBus = () => bus;
      const dispatched: string[] = [];
      const adapter = new OrchestrationHostAdapter(runtime, {
        ...evidence,
        recordDispatched: (event) => { dispatched.push(event.handle); },
      });
      const store = new ContentAssetStore();
      stores.push(store);
      adapter.createTaskInputResolver(store);

      // Each start of the coordinator's backend gets team tools that name that launch, as the extension builds them.
      const backends: FakeBackend[] = [];
      const toolsOfLaunch: TeamTools[] = [];
      const sessions = new SessionManager(5, bus, {
        createBackend: (config, launchId) => {
          const backend = new FakeBackend(config.id);
          if (config.id === 'pm') {
            backends.push(backend);
            toolsOfLaunch.push(adapter.createCoordinatorTeamTools(config, { launchId }));
          }
          return backend;
        },
        resolveEnv: async () => ({}),
      });
      manager = sessions;
      runtime.firstActionCallArrived = (id, launchId) => sessions.firstActionCallArrived(id, launchId);
      runtime.firstActionCallAnswered = (id, launchId, tool, accepted) =>
        sessions.firstActionCallAnswered(id, launchId, tool, accepted);
      const firstActions: Array<{ turnId: string; evidence: FirstActionEvidence }> = [];
      sessions.on('session.firstAction', (event) => firstActions.push(event.data));
      for (const config of [coordinator, worker]) sessions.create(config);
      await sessions.start('pm', { pin: 'take' });
      backends[0].emit({ kind: 'ready' });

      // Silence produces progress, never a stop. Only the person ends attempt A.
      bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
      backends[0].emit({ kind: 'model_request' });
      vi.advanceTimersByTime(60_000);
      expect(sessions.get('pm')?.status).toBe('running');
      expect(sessions.getTurnPhase('pm')?.progressSummary).toContain('This task is still running.');
      sessions.interrupt('pm');
      expect(sessions.get('pm')?.status).toBe('stopped');

      // The person retries. Turn B is armed on a new launch while A's process is still closing.
      await sessions.start('pm', { pin: 'take' });
      backends[1].emit({ kind: 'ready' });
      const retry = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
      backends[1].emit({ kind: 'model_request' });
      expect(toolsOfLaunch).toHaveLength(2);
      vi.advanceTimersByTime(10_000);

      // A's dispatch and A's close arrive now, through the tools of A's launch. Both are refused and run nothing.
      const refusal = { source: 'host', status: 'refused', reason: 'safety-limit', output: ENDED_ATTEMPT_REFUSAL };
      await expect(toolsOfLaunch[0].runOutcome('dispatch_task', { agent: 'worker', instruction: 'Take it.' }))
        .resolves.toMatchObject(refusal);
      await expect(toolsOfLaunch[0].runOutcome('close_assignment', { outcome: 'complete', summary: 'Late.' }))
        .resolves.toMatchObject(refusal);
      expect(bus.query({ type: 'task.assign' })).toHaveLength(0);
      expect(dispatched).toEqual([]);
      expect(firstActions).toEqual([]);

      // B keeps running through a long quiet period; stale A calls neither satisfy nor stop it.
      vi.advanceTimersByTime(600_000);
      expect(sessions.get('pm')?.status).toBe('running');
      // B's own close, through the tools of B's launch, is let in and is B's first action.
      await expect(toolsOfLaunch[1].runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered.' }))
        .resolves.toMatchObject({ status: 'success' });
      expect(firstActions.map((entry) => [entry.turnId, entry.evidence.source, entry.evidence.kind])).toEqual([
        [retry.id, 'provider', 'assignment-closed'],
      ]);
      vi.advanceTimersByTime(600_000);
      expect(sessions.get('pm')?.status).toBe('running');
    } finally {
      manager?.dispose();
      vi.useRealTimers();
    }
  });

  it('routes a late rework reply through the existing async-result wake', async () => {
    const coordinator = agent('pm', 'pm');
    const worker = agent('worker');
    const bus = new MessageBus();
    const runtime = runtimeFor([coordinator, worker]);
    runtime.messageBus = () => bus;
    const wakes: Array<{ handle: string; ref: string; text: string; isReady: () => boolean; consume: () => boolean }> = [];
    runtime.queueAsyncDelegationWake = (_coordinatorId, result, isReady, consume) => {
      wakes.push({ ...result, isReady, consume });
      return true;
    };
    const published: string[] = [];
    runtime.publishCoordinatorNotice = (_id, text) => published.push(text);
    const lateReplies: Array<{ handle: string; agentId: string }> = [];
    const adapterEvidence: OrchestrationEvidencePort = {
      ...evidence,
      recordLateReworkReply: (event) => {
        lateReplies.push(event);
        return `UnodeAi: ${event.agentId} replied to the PM's rework request. Ask the PM to review it.`;
      },
    };
    const adapter = new OrchestrationHostAdapter(runtime, adapterEvidence);
    const store = new ContentAssetStore();
    stores.push(store);
    adapter.createTaskInputResolver(store);
    const tools = adapter.createCoordinatorTeamTools(coordinator, { launchId: 'launch-1' });
    bus.onType('task.assign', (message) => {
      bus.send('worker', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', message.correlationId);
      bus.send('worker', 'pm', 'task.complete', { instruction: 'Initial result.' }, 'normal', message.correlationId);
    });

    const result = await tools.run('assign_task', { agent: 'worker', instruction: 'Draft the release note.' });
    const handle = /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    await tools.run('record_task_disposition', {
      handle, disposition: 'needs-rework', reason: 'Explain the upgrade path.',
    });
    bus.send('worker', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ handle, ref: 'worker', reason: 'rework-reply' });
    expect(wakes[0].text).toContain('Reworked result.');
    expect(wakes[0].isReady()).toBe(true);
    expect(wakes[0].consume()).toBe(true);
    expect(lateReplies).toEqual([]);
    expect(published).toEqual([]);
  });

  // v0.9.99 (B14): a rework held at the automatic cap reaches the host by the worker's name, with a Continue that
  // sends the held request through these exact tools.
  it('tells the host about a rework held at the cap, and its Continue sends the held request', async () => {
    const coordinator = agent('pm', 'pm');
    const worker = { ...agent('worker'), name: 'Frontend Engineer' };
    const bus = new MessageBus();
    const runtime = runtimeFor([coordinator, worker]);
    runtime.messageBus = () => bus;
    runtime.queueAsyncDelegationWake = () => true;
    const holds: Array<{ coordinatorId: string; agentName: string; rounds: number; continueRework: () => string }> = [];
    runtime.reworkHeld = (coordinatorId, held, continueRework) => { holds.push({ coordinatorId, ...held, continueRework }); };
    const adapter = new OrchestrationHostAdapter(runtime, evidence);
    const store = new ContentAssetStore();
    stores.push(store);
    adapter.createTaskInputResolver(store);
    const tools = adapter.createCoordinatorTeamTools(coordinator, { launchId: 'launch-1' });
    bus.onType('task.assign', (message) => {
      bus.send('worker', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', message.correlationId);
      bus.send('worker', 'pm', 'task.complete', { instruction: 'Initial result.' }, 'normal', message.correlationId);
    });
    const sent: string[] = [];
    bus.onType('agent.message', (message) => {
      if (message.from === 'pm' && message.to === 'worker') sent.push(String(message.payload.instruction));
    });

    const result = await tools.run('assign_task', { agent: 'worker', instruction: 'Draft the release note.' });
    const handle = /Handle: ([^\s.]+)/.exec(result)?.[1]!;
    for (let round = 1; round <= 3; round += 1) {
      await tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: `Fix gap ${round}.` });
      bus.send('worker', 'pm', 'task.complete', { instruction: 'Reworked result.' }, 'normal', handle);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }

    expect(sent).toHaveLength(2);
    expect(holds.map(({ coordinatorId, agentName, rounds }) => ({ coordinatorId, agentName, rounds })))
      .toEqual([{ coordinatorId: 'pm', agentName: 'Frontend Engineer', rounds: 3 }]);
    expect(holds[0].continueRework()).toBe('sent');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain('Reason: Fix gap 3.');
    expect(holds[0].continueRework()).toBe('decided');
  });

  it('does not resolve a workspace target while the host is activating without a folder', async () => {
    const coordinator = agent('pm', 'pm');
    const runtime = runtimeFor([coordinator]);
    runtime.workspace = () => ({
      root: () => { throw new Error('no workspace folder'); },
      roots: () => [],
      isTrusted: () => true,
      additionalReadRoots: () => [],
    });
    const adapter = new OrchestrationHostAdapter(runtime, evidence);
    const store = new ContentAssetStore();
    stores.push(store);

    const resolver = adapter.createTaskInputResolver(store);

    await expect(resolver.beginAttempt({
      contractId: 'no-workspace',
      version: 1,
      proposedBy: 'pm',
      compiledAt: new Date().toISOString(),
      objective: 'do not write outside a workspace',
      expectedDeliverable: 'a refusal',
      effects: { readFiles: [], expectedFileEffect: 'none' },
      inputs: [],
      constraints: [],
      dependencies: [],
      requiredCapabilities: { version: 1, capabilities: [] },
      executionStrategy: 'delegate-preferred',
    }, {
      agentId: 'worker',
      authorizedContentAssetIds: [],
      liveContentAssetIds: [],
      readyArtifacts: [],
    }, 'pm')).resolves.toEqual({
      error: 'task-scope: no workspace folder is bound; the assignment was not started',
    });
  });

  it('keeps an explicit native backend out of task-scoped folder access', () => {
    const coordinator = { ...agent('pm', 'pm'), backend: 'claude' as const };
    const adapter = new OrchestrationHostAdapter(runtimeFor([coordinator]), evidence);

    expect(adapter.resolveTaskWorkspaceAccess(coordinator, {
      folderAccess: [{ path: process.cwd(), permission: 'read' }],
    }).reason).toMatch(/native CLI backend/);
  });

  describe('a task scope that names a file', () => {
    async function scopedWorkspace(trusted = true): Promise<{
      root: string; notes: string; adapter: OrchestrationHostAdapter; coordinator: AgentConfig; worker: AgentConfig;
      runtime: CoordinatorRuntimePort;
    }> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-host-file-scope-'));
      await fs.mkdir(path.join(root, 'docs'));
      const notes = path.join(root, 'docs', 'notes.md');
      await fs.writeFile(notes, 'first line\n', 'utf8');
      await fs.writeFile(path.join(root, 'docs', 'sibling.md'), 'SIBLING\n', 'utf8');
      const coordinator = agent('pm', 'pm');
      const worker = agent('worker');
      const runtime = runtimeFor([coordinator, worker]);
      runtime.workspace = () => ({
        root: () => root,
        roots: () => [root],
        isTrusted: () => trusted,
        additionalReadRoots: () => [],
      });
      return { root, notes, adapter: new OrchestrationHostAdapter(runtime, evidence), coordinator, worker, runtime };
    }

    it('admits it as that exact file with no command directory, for a worker and for the coordinator itself', async () => {
      const { root, notes, adapter, coordinator, worker } = await scopedWorkspace();
      const scope = { folderAccess: [{ path: 'docs/notes.md', permission: 'readwrite' as const }] };
      try {
        const grant = {
          kind: 'file', permission: 'readwrite',
          lexicalPath: path.resolve(notes), realPath: path.resolve(notes), realParent: path.resolve(root, 'docs'),
        };
        for (const config of [worker, coordinator]) {
          const admitted = adapter.resolveTaskWorkspaceAccess(config, scope);
          expect(admitted.reason, config.id).toBeUndefined();
          expect(admitted.access, config.id).toEqual({
            pathBase: path.resolve(root), readRoots: [], writeRoots: [], readFiles: [grant], writeFiles: [grant],
          });
          expect(admitted.access).not.toHaveProperty('commandCwd');
          // The same admission is what a dispatch is preflighted with, for a teammate and for the coordinator's own work.
          expect(adapter.makeTeamView().preflightTaskScope!(config.id, scope)).toBeUndefined();
        }

        // What was admitted is what the worker's tools enforce.
        let executed = 0;
        const tools = new WorkspaceTools(
          root, new Set(['read', 'write', 'execute']), 'worker', undefined, new CommandPolicy('all'),
          undefined, undefined, undefined, undefined, async () => { executed += 1; return { code: 0, output: 'ran' }; },
        );
        tools.setTurnWorkspaceAccess(adapter.resolveTaskWorkspaceAccess(worker, scope).access);
        expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
        expect(await tools.run('write_file', { path: 'docs/notes.md', content: 'written\n' })).toMatchObject({ status: 'success' });
        expect(await fs.readFile(notes, 'utf8')).toBe('written\n');
        expect(await tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(executed).toBe(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('carries the coordinator\'s own file scope from its contract through admission to its file tools', async () => {
      const { root, notes, adapter, coordinator, runtime } = await scopedWorkspace();
      const roster = runtime.teamEntries();
      runtime.teamEntries = () => roster.map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities!, verificationSensors: [], taskScope: 'per-turn' as const },
      }));
      runtime.effectiveExecutionIdentity = () => undefined;
      runtime.admitCoordinatorAttempt = () => ({ allowed: true });
      const store = new ContentAssetStore();
      stores.push(store);
      adapter.createTaskInputResolver(store);
      const team = adapter.createCoordinatorTeamTools(coordinator, 'host');
      const contract = (file: string) => ({
        version: 1,
        objective: 'Correct the notes.',
        expected_deliverable: 'The corrected notes file.',
        effects: {
          read_files: [],
          write_scope: { folder_access: [{ path: file, permission: 'readwrite' }] },
          expected_file_effect: 'modify',
        },
        inputs: [],
        constraints: [],
        dependencies: [],
        required_capabilities: { version: 1, capabilities: ['write'] },
        execution_strategy: 'coordinator-only',
      });
      try {
        // A file that is not there is refused when the contract is submitted, in the words the host uses for a path.
        const missing = await team.run('dispatch_task', {
          agent: 'pm', instruction: 'Correct the notes yourself.', contract: contract('docs/missing.md'),
        });
        expect(missing).toContain('Path does not exist: docs/missing.md');
        expect(missing).not.toMatch(/folder does not exist/i);
        expect(team.currentCoordinatorTaskAttempt()).toBeUndefined();

        const admitted = await team.run('dispatch_task', {
          agent: 'pm', instruction: 'Correct the notes yourself.', contract: contract('docs/notes.md'),
        });
        expect(admitted).toContain('Coordinator execution is authorised');
        const attempt = team.currentCoordinatorTaskAttempt();
        expect(attempt?.contract.effects.writeScope).toEqual({ folderAccess: [{ path: 'docs/notes.md', permission: 'readwrite' }] });

        // The backend applies the admitted contract's scope to the coordinator's own tools when the attempt starts.
        let executed = 0;
        const tools = new WorkspaceTools(
          root, new Set(['read', 'write', 'execute']), 'pm', undefined, new CommandPolicy('all'),
          undefined, undefined, undefined, undefined, async () => { executed += 1; return { code: 0, output: 'ran' }; },
        );
        tools.setTaskAttempt(attempt);
        expect(tools.setContractTaskScope(attempt!.contract.effects.writeScope)).toBe(true);
        expect(await tools.runText('read_file', { path: 'docs/notes.md' })).toBe('first line\n');
        expect(await tools.run('apply_edit', { path: 'docs/notes.md', old_string: 'first', new_string: 'corrected' }))
          .toMatchObject({ status: 'success' });
        expect(await fs.readFile(notes, 'utf8')).toBe('corrected line\n');
        expect(await tools.run('write_file', { path: 'docs/sibling.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(await tools.run('write_file', { path: 'docs/created.md', content: 'no' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(await tools.run('run_command', { command: 'echo hi' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
        expect(executed).toBe(0);
        expect(tools.specs().map((spec) => spec.function.name)).not.toContain('run_command');
        expect((await fs.readdir(path.join(root, 'docs'))).sort()).toEqual(['notes.md', 'sibling.md']);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('refuses a missing path when the task is dispatched, and does not call it a folder', async () => {
      const { root, adapter, coordinator, worker } = await scopedWorkspace();
      const scope = { folderAccess: [{ path: 'docs/missing.md', permission: 'readwrite' as const }] };
      try {
        for (const config of [worker, coordinator]) {
          const refused = adapter.resolveTaskWorkspaceAccess(config, scope);
          expect(refused.access, config.id).toBeUndefined();
          expect(refused.reason, config.id).toBe('Task-scoped folder access was rejected: Path does not exist: docs/missing.md');
          expect(refused.reason).not.toMatch(/folder does not exist/i);
          expect(adapter.makeTeamView().preflightTaskScope!(config.id, scope)).toBe(refused.reason);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('takes its write authority away in an untrusted workspace', async () => {
      const { root, notes, adapter, worker } = await scopedWorkspace(false);
      try {
        const admitted = adapter.resolveTaskWorkspaceAccess(worker, {
          folderAccess: [{ path: 'docs/notes.md', permission: 'readwrite' }],
        });
        expect(admitted.access?.writeFiles).toEqual([]);
        expect(admitted.access?.writeRoots).toEqual([]);
        expect(admitted.access?.readFiles?.map((file) => [file.realPath, file.permission])).toEqual([[path.resolve(notes), 'read']]);
        expect(admitted.access).not.toHaveProperty('commandCwd');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('shares nothing with an agent whose Folder Access names another file', async () => {
      const { root, adapter, worker } = await scopedWorkspace();
      try {
        const confined = { ...worker, folderAccess: [{ path: 'docs/sibling.md', permission: 'readwrite' as const }] };
        const refused = adapter.resolveTaskWorkspaceAccess(confined, {
          folderAccess: [{ path: 'docs/notes.md', permission: 'readwrite' }],
        });
        expect(refused.access).toBeUndefined();
        expect(refused.reason).toBe(
          'Task-scoped folder access shares no readable folder or file with this agent\'s configured Folder Access. The assignment was not started.',
        );
        // A request for the folder around that agent's file narrows to the file, and is admitted.
        expect(adapter.resolveTaskWorkspaceAccess(confined, {
          folderAccess: [{ path: 'docs', permission: 'readwrite' }],
        }).access?.writeFiles?.map((file) => path.basename(file.realPath))).toEqual(['sibling.md']);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

// v0.9.97 ATTACH-CODEX. CHANGELOG [Unreleased]: "Attached context lists an attachment only after the agent's route sent
// it." A chat turn's dispatch manifest names the request and its @ context, never an attachment; the coordinator's
// forwarding copies are kept as before.
describe('userTurnSources (v0.9.97)', () => {
  it('lists no attachment at dispatch, and keeps the forwarding copies of text, PDF and image', async () => {
    const store = new ContentAssetStore();
    stores.push(store);
    const text = 'Read @notes.md and the attachments.';
    const expanded = `${text}\n\n--- @notes.md ---\nfrom the mention`;
    const userAttachments = [
      { name: 'brief.md', mime: 'text/markdown', kind: 'file' as const, dataBase64: Buffer.from('# Brief').toString('base64'), size: 7 },
      { name: 'shot.png', mime: 'image/png', kind: 'image' as const, dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64'), size: 9 },
      { name: 'pack.pdf', mime: 'application/pdf', kind: 'pdf' as const, dataBase64: Buffer.from('%PDF-1.7\nx').toString('base64'), size: 10 },
    ];

    const sources = await userTurnSources(store, { text, expanded, mentions: ['notes.md'], userAttachments });

    expect(sources.contextManifestSources.map((source) => source.kind)).toEqual(['user-request', 'context-mention']);
    expect(sources.contextManifestSources[1]).toMatchObject({ text: '\n\n--- @notes.md ---\nfrom the mention' });
    expect(sources.delegationContentSources.map((source) => [source.kind, source.label, source.mediaKind])).toEqual([
      ['user-request', 'Current task', 'text'],
      ['context-mention', 'Explicit @ context (1)', 'text'],
      ['user-attachment', 'brief.md', 'text'],
      ['user-attachment', 'pack.pdf', 'pdf'],
      ['user-attachment', 'shot.png', 'image'],
    ]);
  });
});
