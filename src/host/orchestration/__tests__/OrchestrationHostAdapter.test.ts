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
    queueAsyncDelegationWake: () => undefined,
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

  it('keeps an explicit native backend out of task-scoped folder access', () => {
    const coordinator = { ...agent('pm', 'pm'), backend: 'claude' as const };
    const adapter = new OrchestrationHostAdapter(runtimeFor([coordinator]), evidence);

    expect(adapter.resolveTaskWorkspaceAccess(coordinator, {
      folderAccess: [{ path: process.cwd(), permission: 'read' }],
    }).reason).toMatch(/native CLI backend/);
  });
});
