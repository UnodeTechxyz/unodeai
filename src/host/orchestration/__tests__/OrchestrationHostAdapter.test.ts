import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { MessageBus } from '../../../bus/MessageBus';
import { AgentCommandPolicy } from '../../../backend/AgentCommandPolicy';
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

  it('refuses the late dispatch and close of an attempt the deadline ended while the retried turn is armed, and they run nothing', async () => {
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
      await sessions.start('pm');
      backends[0].emit({ kind: 'ready' });

      // Attempt A: the provider is silent for 60 seconds, and the host ends the attempt.
      const first = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
      backends[0].emit({ kind: 'model_request' });
      vi.advanceTimersByTime(60_000);
      expect(sessions.get('pm')?.status).toBe('stopped');

      // The person retries. Turn B is armed on a new launch while A's process is still closing.
      await sessions.start('pm');
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
      expect(firstActions.map((entry) => entry.evidence.source)).toEqual(['host-deadline']);

      // B's guard is still armed and was not disturbed: its silence, now 10 seconds old, runs out at 60.
      vi.advanceTimersByTime(49_000);
      expect(sessions.get('pm')?.status).toBe('running');
      // B's own close, through the tools of B's launch, is let in and is B's first action.
      await expect(toolsOfLaunch[1].runOutcome('close_assignment', { outcome: 'complete', summary: 'Delivered.' }))
        .resolves.toMatchObject({ status: 'success' });
      expect(firstActions.map((entry) => [entry.turnId, entry.evidence.source, entry.evidence.kind])).toEqual([
        [first.id, 'host-deadline', 'needs-you'],
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
});
