import { afterEach, describe, expect, it } from 'vitest';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { MessageBus } from '../../../bus/MessageBus';
import { AgentCommandPolicy } from '../../../backend/AgentCommandPolicy';
import { TaskClaimRegistry } from '../../../backend/TaskClaimRegistry';
import type { AgentConfig } from '../../../types';
import type { TeamRosterEntry } from '../../../backend/TeamTools';
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

    const result = await adapter.createCoordinatorTeamTools(coordinator).run('list_agents', {});

    expect(result).toContain('worker');
    expect(result).not.toContain('vscode');
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
    runtime.publishDelegationReceiptUpdate = (_id, text) => published.push(text);
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
    const tools = adapter.createCoordinatorTeamTools(coordinator);
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
    expect(wakes[0]).toMatchObject({ handle, ref: 'worker' });
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
