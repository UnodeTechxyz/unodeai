import { describe, it, expect, beforeEach, vi } from 'vitest';
import { delegatedSourceHandoff, SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { TeamTools, TeamView } from '../../backend/TeamTools';
import {
  AgentBackend,
  BackendEvent,
  BackendEventHandler,
  ConversationSnapshot,
  TurnAttachments,
} from '../../backend/AgentBackend';
import { AgentConfig, Message } from '../../types';
import { assertNoFolderAccessWorktreeConflict, folderAccessWorktreeConflictMessage } from '../folderAccessWorktreeConflict';
import { ROLE_TEMPLATES } from '../../roles/RoleConfig';
import { createTurnContextManifest, delegatedContentManifestSource, textContextSource } from '../TurnContextManifest';
import { createEffectiveExecutionIdentity } from '../EffectiveExecutionIdentity';
import { ARTIFACT_REVIEW_POLICY_ID } from '../../policy/TeamPolicy';

/** A backend that records the turns it receives and lets the test drive its events. */
class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns: string[] = [];
  attachments: Array<TurnAttachments | undefined> = [];
  restored?: ConversationSnapshot;
  aborts = 0;
  stops = 0;
  private handler?: BackendEventHandler;
  private alive = false;

  constructor(config: AgentConfig) {
    this.agentId = config.id;
  }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> {
    this.alive = true;
  }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void {
    this.turns.push(instruction);
    this.attachments.push(attachments);
  }
  async stop(): Promise<void> {
    this.stops++;
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void {
    this.aborts++;
  }
  interjects: string[] = [];
  interject(text: string): void {
    this.interjects.push(text);
  }
  models: string[] = [];
  setModel(model: string): void {
    this.models.push(model);
  }
  isAlive(): boolean {
    return this.alive;
  }
  snapshot(): ConversationSnapshot {
    return { version: 1, messages: [`history of ${this.agentId}`] };
  }
  restore(snap: ConversationSnapshot): void {
    this.restored = snap;
  }
  emit(e: BackendEvent): void {
    this.handler?.(e);
  }
}

class DeferredStartBackend extends FakeBackend {
  resolveStart!: () => void;
  rejectStart!: (err: Error) => void;

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
  }
}

class CompactingBackend extends FakeBackend {
  compactCalls: string[] = [];

  async compactHistory(_summarizer: any, _io: any, economyModel: string): Promise<void> {
    this.compactCalls.push(economyModel);
  }
}

function makeConfig(id: string, role: string): AgentConfig {
  return {
    id,
    name: id,
    role: role as AgentConfig['role'],
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-20250514',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
  };
}

describe('delegated source handoff', () => {
  it('tells a delegate with no source receipt to report the missing user source before web search', () => {
    const handoff = delegatedSourceHandoff(undefined);
    expect(handoff).toContain('required user-supplied source is missing');
    expect(handoff).toContain('Do not web-search for a user-supplied fact before reporting it missing');
  });

  it('names only opaque receipts and their bounded reader for a forwarded source', () => {
    const handoff = delegatedSourceHandoff([{
      assetId: 'content-12', kind: 'user-attachment', label: 'brief.txt', location: 'user text attachment',
      textBytes: 321, mediaKind: 'text',
    }]);
    expect(handoff).toContain('content-12');
    expect(handoff).toContain('read_extracted_content');
    expect(handoff).toContain('Do not web-search for a user-supplied fact before noting the missing source');
  });
});

describe('SessionManager <-> MessageBus routing', () => {
  let bus: MessageBus;
  let mgr: SessionManager;
  let backends: Map<string, FakeBackend>;

  beforeEach(() => {
    bus = new MessageBus();
    backends = new Map();
    mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = new FakeBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
    });
  });

  it('delivers a task.assign addressed to an agent as a backend turn', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('user', 'dev', 'task.assign', { instruction: 'build X' });

    expect(backends.get('dev')!.turns).toEqual(['build X']);
    expect(mgr.get('dev')!.status).toBe('running');
  });

  it('retains the host-selected memory tier for the active turn and ignores message metadata', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const local = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskTier: () => 'economy',
    });
    local.create(makeConfig('dev', 'senior-dev'));
    await local.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('user', 'dev', 'task.assign', {
      instruction: 'Record a memory note.',
      metadata: { tier: 'premium' },
    });

    expect(local.currentTurnTier('dev')).toBe('economy');
  });

  it('runs final task policy against the Smart Mode identity before backend/progress side effects', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const observedModels: string[] = [];
    const local = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskModel: () => 'smart-selected-model',
      resolveEffectiveExecutionIdentity: (_config, reportedModelId) => {
        observedModels.push(reportedModelId);
        return createEffectiveExecutionIdentity(reportedModelId, 'route-a', 1);
      },
      admitTaskExecution: (_attempt, identity) => ({
        allowed: false,
        applied: true,
        policyId: ARTIFACT_REVIEW_POLICY_ID,
        code: 'refused-same-reported-model',
        reason: `refused ${identity?.reportedModelId}`,
      }),
    });
    local.create(makeConfig('reviewer', 'reviewer'));
    await local.start('reviewer');
    localBackends.get('reviewer')!.emit({ kind: 'ready' });

    localBus.send('pm', 'reviewer', 'task.assign', {
      instruction: '审核这份文档',
      taskAttempt: {
        attemptId: 'attempt-review', contractId: 'contract-review', agentId: 'reviewer', grants: [],
        baselineWorkspaceAuthority: 'independent-agent-authority',
        contract: { review: { inputId: 'artifact' } },
      } as any,
    }, 'high', 'review-handle');

    expect(observedModels).toEqual(['smart-selected-model']);
    expect(localBackends.get('reviewer')!.turns).toEqual([]);
    expect(localBus.query({ type: 'task.admitted' })).toEqual([]);
    expect(localBus.query({ type: 'system.error' }).at(-1)?.payload).toMatchObject({
      instruction: 'refused smart-selected-model',
      metadata: { policyRefused: true, policyId: ARTIFACT_REVIEW_POLICY_ID },
    });
    expect(local.get('reviewer')?.status).toBe('idle');
  });

  it('emits task.admitted only after the exact attempt passes the final evaluator', async () => {
    const admitted: Message[] = [];
    const local = new SessionManager(5, bus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        backends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveEffectiveExecutionIdentity: (_config, model) => createEffectiveExecutionIdentity(model, 'route-a', 1),
      admitTaskExecution: () => ({
        allowed: true, applied: false, policyId: ARTIFACT_REVIEW_POLICY_ID,
        code: 'not-marked', reason: 'not marked',
      }),
    });
    bus.onType('task.admitted', (message) => admitted.push(message));
    local.create(makeConfig('dev', 'senior-dev'));
    await local.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    bus.send('pm', 'dev', 'task.assign', {
      instruction: 'work',
      taskAttempt: { attemptId: 'a', contractId: 'c', agentId: 'dev', grants: [], contract: {}, baselineWorkspaceAuthority: 'independent-agent-authority' } as any,
    }, 'high', 'h');
    expect(admitted).toHaveLength(1);
    expect(backends.get('dev')!.turns).toEqual(['work']);
  });

  it('publishes host-observed timing beside the terminal reply', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('user', 'dev', 'task.assign', { instruction: 'inspect timing' });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'inspected', isError: false } });

    const terminal = bus.query({ type: 'task.complete' }).at(-1);
    expect(terminal?.payload.metadata?.turnTiming).toMatchObject({
      startedAt: expect.any(String),
      settledAt: expect.any(String),
      durationMs: expect.any(Number),
      approvalWaitMs: 0,
    });
  });

  it('carries declared task files as worker attachments without turning them into a scope grant', async () => {
    const scopedBus = new MessageBus();
    const scopedBackends = new Map<string, FakeBackend>();
    const readOnlyScope = {
      pathBase: '/workspace',
      commandCwd: '/workspace/src',
      readRoots: ['/workspace/src'],
      writeRoots: [],
    };
    const scopedManager = new SessionManager(5, scopedBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        scopedBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskWorkspaceAccess: () => ({ access: readOnlyScope }),
    });
    scopedManager.create(makeConfig('dev', 'senior-dev'));
    await scopedManager.start('dev');
    scopedBackends.get('dev')!.emit({ kind: 'ready' });

    scopedBus.send('pm', 'dev', 'task.assign', {
      instruction: 'Inspect the owned file.',
      files: ['src/owned.ts', 'outside/never-writable.ts'],
      taskScope: { folderAccess: [{ path: 'src', permission: 'read' }] },
    });

    expect(scopedBackends.get('dev')!.attachments[0]).toMatchObject({
      files: ['src/owned.ts', 'outside/never-writable.ts'],
      taskWorkspaceAccess: readOnlyScope,
    });
    scopedManager.dispose();
    scopedBus.dispose();
  });

  it('emits one Phase A progress record for a correlated worker task without changing completion routing', async () => {
    const progress: Array<{ correlationId: string; toolCalls: number; modelRequests: number; outcome: string }> = [];
    mgr.on('session.taskProgress', (event) => progress.push({
      correlationId: event.data.correlationId,
      toolCalls: event.data.progress.toolCalls,
      modelRequests: event.data.progress.modelRequests,
      outcome: event.data.progress.outcome,
    }));
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const assignment = bus.send('pm', 'dev', 'task.assign', { instruction: 'Inspect src/app.ts' }, 'normal', 'handle-progress');
    backends.get('dev')!.emit({ kind: 'model_request' });
    backends.get('dev')!.emit({ kind: 'tool_use', name: 'read_file', input: { path: 'src/app.ts' } });
    backends.get('dev')!.emit({
      kind: 'turn_complete',
      result: {
        text: 'Inspected.',
        isError: false,
        delegationEvidence: { hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false } },
      },
    });

    expect(assignment.correlationId).toBe('handle-progress');
    expect(progress).toEqual([{ correlationId: 'handle-progress', toolCalls: 1, modelRequests: 1, outcome: 'framework-evidenced-output' }]);
    expect(bus.query({ type: 'task.complete' }).at(-1)?.correlationId).toBe('handle-progress');
  });

  it('attaches only host-resolved task workspace access and fail-closes a rejected scope', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const access = {
      pathBase: '/workspace', commandCwd: '/workspace/src',
      readRoots: ['/workspace/src'], writeRoots: [],
    };
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskWorkspaceAccess: (_config, msg) =>
        msg.payload.instruction === 'deny scope'
          ? { reason: 'Task scope is outside this agent\'s configured Folder Access.' }
          : { access },
    });
    localMgr.create(makeConfig('dev', 'senior-dev'));
    await localMgr.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('pm', 'dev', 'task.assign', {
      instruction: 'audit scope',
      taskScope: { folderAccess: [{ path: 'src', permission: 'read' }] },
    });
    expect(localBackends.get('dev')!.attachments[0]?.taskWorkspaceAccess).toEqual(access);

    localBackends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    localBus.send('pm', 'dev', 'task.assign', {
      instruction: 'deny scope',
      taskScope: { folderAccess: [{ path: 'outside', permission: 'read' }] },
    });
    expect(localBackends.get('dev')!.turns).toEqual(['audit scope']);
    expect(localBus.query({ type: 'system.error' }).at(-1)?.payload.instruction).toMatch(/outside this agent/i);
    localMgr.dispose();
    localBus.dispose();
  });

  it('lets a coordinator run three read-only audits without changing write-capable agent configuration (R2)', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const agentIds = ['audit-a', 'audit-b', 'audit-c'];
    const readOnlyAccess = {
      pathBase: '/workspace', commandCwd: '/workspace',
      readRoots: ['/workspace'], writeRoots: [],
    };
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskWorkspaceAccess: () => ({ access: readOnlyAccess }),
    });
    for (const id of agentIds) {
      const config = makeConfig(id, 'reviewer');
      // These agents retain their normal write capability. No Agent Builder config is edited for the audit.
      config.allowedTools = ['read', 'write', 'execute'];
      localMgr.create(config);
      await localMgr.start(id);
      localBackends.get(id)!.emit({ kind: 'ready' });
    }
    const view: TeamView = {
      list: () => [
        { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
        ...agentIds.map((id) => ({
          id, role: 'reviewer', name: id, status: 'idle',
          // TeamTools now enforces the same per-turn capability that the SessionManager test
          // resolver supplies below; model the real OpenAI-compatible recipients explicitly.
          capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' as const },
        })),
      ],
      resolve: (ref) => agentIds.includes(ref) ? { id: ref } : undefined,
    };
    const team = new TeamTools('pm', view, localBus, { timeoutMs: 1_000, maxParallelDelegations: 3 });
    const scope = { folderAccess: [{ path: '.', permission: 'read' as const }] };
    for (const id of agentIds) {
      expect(await team.run('assign_task_async', {
        agent: id,
        instruction: 'Audit the assigned files; do not edit.',
        scope,
      })).toMatch(/Dispatched/);
    }
    for (const id of agentIds) {
      expect(localBackends.get(id)!.attachments[0]?.taskWorkspaceAccess).toEqual(readOnlyAccess);
      localBackends.get(id)!.emit({ kind: 'turn_complete', result: { text: `${id} complete`, isError: false } });
    }
    await expect(team.run('await_tasks', {})).resolves.toContain('audit-a complete');
    localMgr.dispose();
    localBus.dispose();
  });

  it('reports delegated progress without emitting task.complete before the worker finishes (R5 mutation gate)', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const assignment = bus.send('pm', 'dev', 'task.assign', { instruction: 'Implement the requested change' });
    backends.get('dev')!.emit({ kind: 'tool_use', name: 'read_file', input: { path: 'src/app.ts' } });

    const statuses = bus.query({ type: 'task.status' });
    expect(statuses.map((message) => message.payload.instruction)).toEqual([
      'Provider request open: Implement the requested change.',
      'read_file · src/app.ts',
    ]);
    expect(statuses.map((message) => (message.payload.metadata as any)?.phase)).toEqual([
      'request-open',
      'tool-running',
    ]);
    expect(statuses.at(-1)?.payload.metadata).toMatchObject({ progress: { source: 'tool', observed: true } });
    // Mutation: changing either progress send above back to task.complete makes this assertion fail.
    expect(bus.query({ type: 'task.complete' })).toEqual([]);

    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(bus.query({ type: 'task.complete' })).toHaveLength(1);
    expect(assignment.type).toBe('task.assign');
  });

  it('emits a periodic delegated heartbeat only after host-observed tool work', async () => {
    vi.useFakeTimers();
    try {
      const localBus = new MessageBus();
      const localBackends = new Map<string, FakeBackend>();
      const localMgr = new SessionManager(5, localBus, {
        createBackend: (config) => {
          const backend = new FakeBackend(config);
          localBackends.set(config.id, backend);
          return backend;
        },
        resolveEnv: async () => ({}),
        delegationProgressHeartbeatMs: 1_000,
      });
      localMgr.create(makeConfig('dev', 'senior-dev'));
      await localMgr.start('dev');
      localBackends.get('dev')!.emit({ kind: 'ready' });

      localBus.send('pm', 'dev', 'task.assign', { instruction: 'Inspect the project' });
      localBackends.get('dev')!.emit({ kind: 'tool_use', name: 'read_file', input: { path: 'src/app.ts' } });
      await vi.advanceTimersByTimeAsync(1_000);

      const heartbeat = localBus.query({ type: 'task.status' }).find((message) =>
        (message.payload.metadata as any)?.progress?.source === 'heartbeat'
      );
      expect(heartbeat?.payload.instruction).toBe('Still working: read_file · src/app.ts');
      expect(heartbeat?.payload.metadata).toMatchObject({ progress: { source: 'heartbeat', observed: false } });

      localBackends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(localBus.query({ type: 'task.status' }).filter((message) =>
        (message.payload.metadata as any)?.progress?.source === 'heartbeat'
      )).toHaveLength(1);
      localMgr.dispose();
      localBus.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports one safe Activity action while retaining a failed tool result in the session transcript (C3/C4)', async () => {
    const config = makeConfig('dev', 'senior-dev');
    config.workingDirectory = 'C:\\workspace';
    const toolEvents: Array<{ phase: 'use' | 'result'; name: string; ok?: boolean; summary?: string }> = [];
    mgr.on('session.tool', (event) => toolEvents.push(event.data));
    mgr.create(config);
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Inspect the contract' }, 'normal', 'contract-task');
    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'mcp__unode_files__read_file',
      input: { path: 'C:\\workspace\\WorkingDocuments\\contract.docx' },
    });
    backends.get('dev')!.emit({
      kind: 'tool_result',
      name: 'mcp__unode_files__read_file',
      ok: false,
      summary: 'document parser failed',
      detail: 'invalid central directory',
    });

    const statuses = bus.query({ type: 'task.status' });
    expect(statuses.map((message) => message.payload.instruction)).toEqual([
      'Provider request open: Inspect the contract.',
      'read_file · WorkingDocuments/contract.docx',
    ]);
    expect(statuses.at(-1)?.payload.metadata).toMatchObject({
      activityIdentity: 'read_file\u0000path\u0000WorkingDocuments/contract.docx',
      progress: { source: 'tool', observed: true },
    });
    expect(toolEvents).toEqual([
      expect.objectContaining({ phase: 'use', name: 'mcp__unode_files__read_file' }),
      expect.objectContaining({ phase: 'result', name: 'mcp__unode_files__read_file', ok: false, summary: 'document parser failed' }),
    ]);
    // A failed result remains visible in session.tool, but cannot create a second action or renew a timeout.
    expect(statuses.filter((message) => (message.payload.metadata as any)?.progress?.observed === true)).toHaveLength(1);
  });

  it('shows only reviewed structural targets and never persists command arguments or arbitrary MCP input (C3/C4j)', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Run the checks' }, 'normal', 'safe-feed');

    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'run_command',
      input: { command: 'TOKEN=top-secret "C:\\Program Files\\node.exe" script.js --token hidden' },
    });
    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'mcp__github__read_file',
      input: { path: 'token-from-an-external-server' },
    });
    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'mcp__new_server__brand_new_action',
      input: { secret: 'never-render-this' },
    });
    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'read_file',
      input: { path: '/outside/machine/private.txt' },
    });

    const activity = bus.query({ type: 'task.status' }).slice(1);
    expect(activity.map((message) => message.payload.instruction)).toEqual([
      'run_command · node.exe',
      'read_file',
      'brand_new_action',
      'read_file',
    ]);
    const persisted = JSON.stringify(activity);
    expect(persisted).not.toContain('top-secret');
    expect(persisted).not.toContain('Program Files');
    expect(persisted).not.toContain('script.js');
    expect(persisted).not.toContain('token-from-an-external-server');
    expect(persisted).not.toContain('never-render-this');
    expect(persisted).not.toContain('/outside/machine');
    expect(persisted).not.toContain('mcp__');
  });

  it('truncates only the middle of a long relative target and keeps the file name (C4e)', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Read the long path' });
    const target = `${'nested-folder/'.repeat(14)}Hosting_Agreement_v3_5.docx`;
    backends.get('dev')!.emit({ kind: 'tool_use', name: 'read_file', input: { path: target } });

    const status = bus.query({ type: 'task.status' }).at(-1)!;
    expect(status.payload.instruction).toContain('…/Hosting_Agreement_v3_5.docx');
    expect(status.payload.instruction).not.toContain(target);
    expect(status.payload.metadata?.activityIdentity).toBe(`read_file\u0000path\u0000${target}`);
  });

  it('never routes task.status into a coordinator turn (C4d)', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });

    bus.send('dev', 'pm', 'task.status', {
      instruction: 'read_file · src/app.ts',
      metadata: { progress: { source: 'tool', observed: true } },
    });

    expect(backends.get('pm')!.turns).toEqual([]);
  });

  it('settles an unfinished delegated turn as a structured partial result (R5 completion mutation gate)', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Implement and verify the change' });
    backends.get('dev')!.emit({
      kind: 'tool_use',
      name: 'update_todos',
      input: { todos: [{ content: 'Run the verification suite', status: 'in_progress' }] },
    });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'partial notes', isError: false } });

    // Mutation: replacing the task.partial branch in SessionManager with task.complete turns this red.
    expect(bus.query({ type: 'task.complete' })).toEqual([]);
    const partial = bus.query({ type: 'task.partial' }).at(-1);
    expect(partial?.payload.instruction).toBe('partial notes');
    expect(partial?.payload.metadata).toMatchObject({
      completionState: 'partial',
      unfinishedActivity: 'Still working on Run the verification suite.',
      midPlan: true,
    });
  });

  it('notifies the task-attempt observer before publishing the partial terminal message', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const order: string[] = [];
    const local = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      onTaskAttemptTerminal: (attemptId) => order.push(`attempt:${attemptId}`),
    });
    localBus.onType('task.partial', () => order.push('message:partial'));
    local.create(makeConfig('dev', 'senior-dev'));
    await local.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('pm', 'dev', 'task.assign', {
      instruction: 'Implement and verify the change.',
      taskAttempt: {
        attemptId: 'attempt-partial', contractId: 'contract-partial', agentId: 'dev', grants: [],
        contract: {}, baselineWorkspaceAuthority: 'independent-agent-authority',
      } as any,
    }, 'normal', 'partial-handle');
    localBackends.get('dev')!.emit({
      kind: 'tool_use', name: 'update_todos',
      input: { todos: [{ content: 'Finish verification', status: 'in_progress' }] },
    });
    localBackends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'Partial report.', isError: false } });

    expect(order).toEqual(['attempt:attempt-partial', 'message:partial']);
  });

  it.each([
    ['task.assign', 'pm'],
    ['ask.question', 'unode'],
    ['agent.message', 'peer'],
    ['handoff', 'peer'],
    ['review.request', 'reviewer'],
    ['review.feedback', 'reviewer'],
  ] as const)('uses task.partial for unfinished directed non-user %s turns', async (type, from) => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    const origin = bus.send(from, 'dev', type, { instruction: 'Do the directed work.' });
    backends.get('dev')!.emit({
      kind: 'tool_use', name: 'update_todos',
      input: { todos: [{ content: 'Finish the evidence table', status: 'in_progress' }] },
    });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: `report from ${type}`, isError: false } });

    const partial = bus.query({ type: 'task.partial' }).at(-1);
    expect(partial).toMatchObject({ from: 'dev', to: from, correlationId: origin.id });
    expect(partial?.payload).toMatchObject({
      instruction: `report from ${type}`,
      metadata: { completionState: 'partial', unfinishedActivity: 'Still working on Finish the evidence table.' },
    });
  });

  it('keeps unfinished direct-user turns on the existing complete path', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    const origin = bus.send('user', 'dev', 'ask.question', { instruction: 'Do the work.' });
    backends.get('dev')!.emit({
      kind: 'tool_use', name: 'update_todos',
      input: { todos: [{ content: 'Finish later', status: 'in_progress' }] },
    });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'direct report', isError: false } });

    expect(bus.query({ type: 'task.partial' })).toEqual([]);
    expect(bus.query({ type: 'task.complete' }).at(-1)).toMatchObject({
      to: 'user', correlationId: origin.id, payload: { instruction: 'direct report' },
    });
  });

  it('emits a read-only context manifest beside the delivered turn', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const manifests: unknown[] = [];
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      getTurnContextManifest: (_config, msg) => createTurnContextManifest([
        textContextSource('user-request', 'Current task', 'chat', msg.payload.instruction, 'message routed to this agent'),
      ]),
    });
    localMgr.on('session.contextManifest', (event) => manifests.push(event.data));
    localMgr.create(makeConfig('dev', 'senior-dev'));
    await localMgr.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    const turn = localBus.send('user', 'dev', 'ask.question', { instruction: 'Inspect src/app.ts', metadata: { turnEpoch: 7 } });

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ epoch: 7, manifest: { sourceCount: 1, estimatedTextTokens: expect.any(Number) } });
    expect((manifests[0] as { correlationId?: string }).correlationId).toBe(turn.id);
    expect(localBackends.get('dev')!.attachments[0]?.contextManifest?.entries[0]?.label).toBe('Current task');
    localBus.dispose();
  });

  it('delivers opaque user-source receipts into a delegated turn manifest without duplicating standing context', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (config) => {
        const backend = new FakeBackend(config);
        localBackends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      getTurnContextManifest: (_config, message) => createTurnContextManifest([
        textContextSource('user-request', 'Current task', 'task.assign', message.payload.instruction, 'message routed to this agent'),
        ...(message.payload.delegationContentSources ?? []).map(delegatedContentManifestSource),
        textContextSource('project-conventions', 'Project conventions', 'workspace metadata', 'Use npm test.', 'fixed project-conventions path'),
      ]),
    });
    localMgr.create(makeConfig('dev', 'senior-dev'));
    await localMgr.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('pm', 'dev', 'task.assign', {
      instruction: 'Verify the customer title.',
      delegationContentSources: [{
        assetId: 'content-3', kind: 'context-mention', label: 'Customer brief', location: '@brief.md',
        textBytes: 88, mediaKind: 'text',
      }],
    });

    expect(localBackends.get('dev')!.turns[0]).toContain('content-3');
    const entries = localBackends.get('dev')!.attachments[0]?.contextManifest?.entries ?? [];
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Delegated user source: Customer brief', kind: 'context-mention', bytes: 88 }),
    ]));
    expect(entries.filter((entry) => entry.kind === 'project-conventions')).toHaveLength(1);
    localMgr.dispose();
    localBus.dispose();
  });

  it('starts a pre-existing template-managed agent with the current template prompt and its playbooks', async () => {
    let backendConfig: AgentConfig | undefined;
    const local = new SessionManager(5, new MessageBus(), {
      createBackend: (config) => {
        backendConfig = config;
        return new FakeBackend(config);
      },
      resolveEnv: async () => ({}),
    });
    const oldTemplate = ROLE_TEMPLATES.pm.systemPrompt;
    ROLE_TEMPLATES.pm.systemPrompt = `${oldTemplate}\n\nA current shipped PM rule.`;
    try {
      // This is a known shipped default, not merely a stale `source: template` label. It is safe
      // to refresh at runtime; an unrecognized text value must instead remain user-owned.
      const config = makeConfig('pm', 'pm');
      config.systemPrompt = oldTemplate;
      config.systemPromptSource = 'template';
      config.playbooks = ['quality-gate-95'];
      local.create(config);

      await local.start('pm');

      expect(backendConfig!.systemPrompt).toContain('A current shipped PM rule.');
      expect(backendConfig!.playbooks).toEqual(['quality-gate-95']);
    } finally {
      ROLE_TEMPLATES.pm.systemPrompt = oldTemplate;
    }
  });

  it('delivers a DIRECTED agent.message (send_message) as a backend turn, framed by sender', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('architect', 'dev', 'agent.message', { message: 'heads up: API shape changed' });

    expect(backends.get('dev')!.turns).toEqual(['Message from architect: heads up: API shape changed']);
  });

  it('does NOT start a turn for a broadcast agent.message (to *) — informational only', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.broadcast('architect', 'agent.message', { message: 'standup in 5' });

    expect(backends.get('dev')!.turns).toEqual([]);
    expect(mgr.get('dev')!.status).toBe('idle');
  });

  it('auto-wakes an idle PM once with all same-tick evidence-framed async results', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    const consumed: string[] = [];

    expect(mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_1', ref: 'dev', text: '[delegation: replied-not-verified]\nchanged files (recorded): src/a.ts\nDo not mark this step done.' },
      () => true,
      () => { consumed.push('async_1'); return true; }
    )).toBe(true);
    expect(mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_2', ref: 'tester', text: '[delegation: verified]\nchanged files (recorded): (none recorded)' },
      () => true,
      () => { consumed.push('async_2'); return true; }
    )).toBe(true);

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backends.get('pm')!.turns).toHaveLength(1);
    expect(backends.get('pm')!.turns[0]).toContain('Async delegation results arrived');
    expect(backends.get('pm')!.turns[0]).toContain('=== dev (async_1) ===');
    expect(backends.get('pm')!.turns[0]).toContain('[delegation: replied-not-verified]');
    expect(backends.get('pm')!.turns[0]).toContain('=== tester (async_2) ===');
    expect(consumed).toEqual(['async_1', 'async_2']);
    expect(mgr.get('pm')!.status).toBe('running');
  });

  it('keeps different run ids out of the same async wake turn', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    const consumed: string[] = [];
    const wakes: Message[] = [];
    bus.onType('ask.question', (message) => {
      if (message.from === 'unode') { wakes.push(message); }
    });

    mgr.queueAsyncDelegationWake(
      'pm', { handle: 'a-1', ref: 'dev', text: 'A result', runId: 'run-a' }, () => true,
      () => { consumed.push('a-1'); return true; }
    );
    mgr.queueAsyncDelegationWake(
      'pm', { handle: 'b-1', ref: 'tester', text: 'B result', runId: 'run-b' }, () => true,
      () => { consumed.push('b-1'); return true; }
    );

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(backends.get('pm')!.turns).toEqual([expect.stringContaining('=== dev (a-1) ===')]);
    expect(backends.get('pm')!.turns[0]).not.toContain('=== tester (b-1) ===');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].correlationId).toBe('run-a');
    expect(consumed).toEqual(['a-1']);

    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'A complete', isError: false } });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(backends.get('pm')!.turns[1]).toContain('=== tester (b-1) ===');
    expect(wakes[1].correlationId).toBe('run-b');
    expect(consumed).toEqual(['a-1', 'b-1']);
  });

  it('retains an async result while the PM is busy, then wakes it when the turn ends', async () => {
    // The defect this replaces: the wake was ONE instantaneous attempt. A teammate that finished while
    // the coordinator happened to be mid-turn had its result dropped, and nothing re-tried when the
    // coordinator went idle a moment later. The documented fallback was that the PM would call
    // `await_tasks` itself — the framework going quiet unless the MODEL remembered to act, which is the
    // failure this release exists to remove.
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'answer the user first' });
    let consumed = false;

    // Accepted for retention. It is NOT a promise to wake now — the PM is busy.
    expect(mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_1', ref: 'dev', text: '[delegation: verified]\nresult' },
      () => true,
      () => { consumed = true; return true; }
    )).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Nothing interrupts the turn in flight, and nothing is consumed by a wake that did not happen.
    expect(backends.get('pm')!.turns).toEqual(['answer the user first']);
    expect(consumed).toBe(false);

    // The turn ends. THIS is the second chance the old code never gave it.
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'answered', isError: false } });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backends.get('pm')!.turns).toHaveLength(2);
    expect(backends.get('pm')!.turns[1]).toContain('=== dev (async_1) ===');
    expect(consumed).toBe(true);
  });

  it('drops a retained wake that await_tasks claimed while the PM was busy', async () => {
    // Retention must not become double delivery: if the PM collected the result itself during its turn,
    // the retained entry is stale and must be pruned rather than replayed at the idle transition.
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    bus.send('user', 'pm', 'ask.question', { instruction: 'answer the user first' });
    let ready = true;
    let consumed = false;

    mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_1', ref: 'dev', text: 'result' },
      () => ready,
      () => { consumed = true; return true; }
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    ready = false; // await_tasks claimed it mid-turn.
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'answered', isError: false } });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backends.get('pm')!.turns).toEqual(['answer the user first']);
    expect(consumed).toBe(false);
  });

  it('does not consume an auto-wake result when the PM becomes busy before the queued wake starts', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    let consumed = false;

    expect(mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_1', ref: 'dev', text: '[delegation: verified]\nresult' },
      () => true,
      () => { consumed = true; return true; }
    )).toBe(true);
    bus.send('user', 'pm', 'ask.question', { instruction: 'user message won the race' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backends.get('pm')!.turns).toEqual(['user message won the race']);
    expect(consumed).toBe(false);
  });

  it('does not wake the PM when a queued delegation was cancelled before injection', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });
    let consumed = false;

    expect(mgr.queueAsyncDelegationWake(
      'pm',
      { handle: 'async_cancelled', ref: 'dev', text: '[delegation: no-evidence]\ncancelled' },
      () => false, // TeamTools.cancelPending removed it before the scheduled wake ran.
      () => { consumed = true; return true; }
    )).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backends.get('pm')!.turns).toEqual([]);
    expect(consumed).toBe(false);
    expect(mgr.get('pm')!.status).toBe('idle');
  });

  it('republishes a turn_complete as task.complete back to the original sender', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const completions: Message[] = [];
    bus.onType('task.complete', (m) => { completions.push(m); });

    const assign = bus.send('architect', 'dev', 'task.assign', { instruction: 'do it' });
    backends.get('dev')!.emit({
      kind: 'turn_complete',
      result: { text: 'done', isError: false, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
    });

    expect(completions).toHaveLength(1);
    expect(completions[0].from).toBe('dev');
    expect(completions[0].to).toBe('architect');
    expect(completions[0].correlationId).toBe(assign.id);
    expect(completions[0].payload.metadata?.turnEpoch).toBe(1);
    expect(mgr.get('dev')!.status).toBe('idle');
    expect(mgr.get('dev')!.usage!.costUsd).toBeCloseTo(0.01);
  });

  it('does not emit task.complete when a coordinator still has a timed-out delegation', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });

    const completions: Message[] = [];
    const errors: Message[] = [];
    bus.onType('task.complete', (message) => completions.push(message));
    bus.onType('system.error', (message) => errors.push(message));

    const assign = bus.send('user', 'pm', 'task.assign', { instruction: 'coordinate the work' });
    backends.get('pm')!.emit({
      kind: 'turn_complete',
      result: { text: 'The developer did not answer before the wait expired.', isError: false, unresolvedReason: 'delegation-timeout' },
    });

    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ from: 'pm', to: 'user', correlationId: assign.id });
    expect(errors[0].payload.metadata).toMatchObject({ isError: true, unresolvedReason: 'delegation-timeout' });
  });

  it('forwards assistant deltas as session.stream events', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const deltas: Array<{ delta: string; epoch: number }> = [];
    mgr.on('session.stream', (e) => deltas.push(e.data));

    bus.send('user', 'dev', 'task.assign', { instruction: 'stream' });
    backends.get('dev')!.emit({ kind: 'assistant_delta', delta: 'hel' });
    backends.get('dev')!.emit({ kind: 'assistant_delta', delta: 'lo' });

    expect(deltas).toEqual([{ delta: 'hel', epoch: 1 }, { delta: 'lo', epoch: 1 }]);
  });

  it('keeps the same epoch across interject because Steer is not cancel', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const epochs: number[] = [];
    mgr.on('session.stream', (e) => epochs.push(e.data.epoch));

    bus.send('user', 'dev', 'task.assign', { instruction: 'stream', metadata: { turnEpoch: 7 } });
    backends.get('dev')!.emit({ kind: 'assistant_delta', delta: 'before steer' });
    mgr.interjectAgent('dev', 'adjust course');
    backends.get('dev')!.emit({ kind: 'assistant_delta', delta: 'after steer' });

    expect(backends.get('dev')!.interjects).toEqual(['adjust course']);
    expect(epochs).toEqual([7, 7]);
  });

  it('forwards tool activity and compaction markers to session events', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const tools: unknown[] = [];
    const compacted: unknown[] = [];
    mgr.on('session.tool', (e) => tools.push(e.data));
    mgr.on('session.compacted', (e) => compacted.push(e.data));

    backends.get('dev')!.emit({ kind: 'tool_use', name: 'read_file', input: { path: 'a.ts' } });
    backends.get('dev')!.emit({ kind: 'tool_result', name: 'read_file', ok: true, summary: 'read_file a.ts', detail: 'content' });
    backends.get('dev')!.emit({ kind: 'compacted', dropped: 3, model: 'economy' });

    expect(tools).toEqual([
      { phase: 'use', name: 'read_file', input: { path: 'a.ts' }, epoch: 0 },
      { phase: 'result', name: 'read_file', ok: true, summary: 'read_file a.ts', detail: 'content', diff: undefined, epoch: 0 },
    ]);
    expect(compacted).toEqual([{ dropped: 3, model: 'economy' }]);
  });

  // "No number" had two unrelated causes and one rendering: a blank pill. Reported on 2026-08-11 as the
  // feature being absent. The meter must distinguish a runtime that cannot report from one that has not
  // started, because the user's next action is different in each case.
  it('separates a runtime that cannot report context from one that has not started', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    mgr.create({
      ...makeConfig('http', 'senior-dev'),
      provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
      model: 'deepseek-v3',
      backend: 'openai-compat',
    });

    // Neither is started. The answers still differ, because only one of these runtimes will EVER report:
    // an unstarted CLI agent is not waiting to fill the meter in, and saying "start it" would be a lie.
    expect(mgr.contextMeter('http')).toEqual({ kind: 'not-started' });
    expect(mgr.contextMeter('dev')).toEqual({ kind: 'unsupported' });
    expect(mgr.contextMeter('nobody')).toBeUndefined();

    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    // Started, but this fake backend has no contextUsage — the CLI-managed case.
    expect(mgr.contextMeter('dev')).toEqual({ kind: 'unsupported' });

    (backends.get('dev') as any).contextUsage = () => ({ tokens: 10, window: 100, ratio: 0.1, source: 'assumed' });
    expect(mgr.contextMeter('dev')).toEqual({
      kind: 'usage',
      usage: { tokens: 10, window: 100, ratio: 0.1, source: 'assumed' },
    });
  });

  // The action must agree with the meter. Codex audit, 2026-08-11: compactSession returned a bare
  // supported:false for an unstarted agent, so the command answered "this backend manages its own context"
  // while the composer beside it said "start the agent" — about the same agent, at the same moment.
  it('tells an unstarted agent apart from a runtime that owns its own context', async () => {
    mgr.create({
      ...makeConfig('http', 'senior-dev'),
      provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
      model: 'deepseek-v3',
      backend: 'openai-compat',
    });
    mgr.create(makeConfig('cli', 'senior-dev'));

    expect(await mgr.compactSession('http')).toMatchObject({ supported: false, reason: 'not-started' });
    expect(await mgr.compactSession('cli')).toMatchObject({ supported: false, reason: 'unsupported' });
    expect(await mgr.compactSession('nobody')).toMatchObject({ supported: false, reason: 'unknown-session' });

    // Started, but this fake backend cannot summarize — the genuine unsupported case, not a startup gap.
    await mgr.start('http');
    backends.get('http')!.emit({ kind: 'ready' });
    expect(await mgr.compactSession('http')).toMatchObject({ supported: false, reason: 'unsupported' });
  });

  // The ceiling has to land on the CONFIG, because that is what the extension persists. Kept in the backend
  // alone it would die with the session, and the agent would relearn its own limit by failing again.
  it('writes a proved context ceiling onto the agent config, not just onto the event', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const observed: unknown[] = [];
    mgr.on('session.contextWindowObserved', (e) => observed.push(e.data));

    backends.get('dev')!.emit({
      kind: 'context_overflow',
      model: 'gateway-model',
      tokens: 96_000,
      observedAt: '2026-08-10T00:00:00.000Z',
    });

    expect(observed).toEqual([{ model: 'gateway-model', tokens: 96_000 }]);
    expect(mgr.get('dev')!.config.observedContextWindow).toEqual({
      model: 'gateway-model',
      tokens: 96_000,
      observedAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('forwards turn context after completion', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const contexts: unknown[] = [];
    mgr.on('session.context', (e) => contexts.push(e.data));

    bus.send('user', 'dev', 'task.assign', { instruction: 'measure' });
    backends.get('dev')!.emit({
      kind: 'turn_complete',
      result: {
        text: 'done',
        isError: false,
        context: { tokens: 50, window: 100, ratio: 0.5 },
      },
    });

    expect(contexts).toEqual([{ tokens: 50, window: 100, ratio: 0.5 }]);
  });

  it('interrupts the backend for the selected agent', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('user', 'dev', 'task.assign', { instruction: 'long turn' });
    mgr.interrupt('dev');

    expect(backends.get('dev')!.aborts).toBe(1);
  });

  it('cancels a stuck turn immediately and ignores stale backend completions', async () => {
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    backends.get('pm')!.emit({ kind: 'ready' });

    const completions: Message[] = [];
    const errors: Message[] = [];
    bus.onType('task.complete', (m) => completions.push(m));
    bus.onType('system.error', (m) => errors.push(m));

    const first = backends.get('pm')!;
    bus.send('user', 'pm', 'ask.question', { instruction: 'long orchestration' });

    mgr.interrupt('pm');

    expect(first.aborts).toBe(1);
    expect(first.stops).toBe(1);
    expect(mgr.get('pm')!.status).toBe('stopped');
    expect(errors).toHaveLength(1);
    expect(errors[0].from).toBe('pm');
    expect(errors[0].to).toBe('user');
    expect(errors[0].payload.instruction).toBe('Stopped by user.');
    expect(errors[0].payload.metadata?.turnEpoch).toBe(2);

    first.emit({ kind: 'turn_complete', result: { text: 'late stale answer', isError: false } });
    expect(completions).toHaveLength(0);

    bus.send('user', 'pm', 'ask.question', { instruction: 'try again' });
    await new Promise((r) => setTimeout(r, 0));
    const replacement = backends.get('pm')!;
    expect(replacement).not.toBe(first);
    replacement.emit({ kind: 'ready' });

    expect(replacement.turns).toEqual(['try again']);
  });

  it('cancels only the delegation identified by its correlation handle and publishes a cancellation receipt', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    const errors: Message[] = [];
    bus.onType('system.error', (message) => errors.push(message));

    const assignment = bus.send('pm', 'dev', 'task.assign', { instruction: 'long delegated work' }, 'high', 'delegation-a');
    expect(mgr.cancelDelegation('dev', assignment.correlationId!, 'Coordinator cancelled delegation-a.')).toBe(true);

    expect(backends.get('dev')!.aborts).toBe(1);
    expect(backends.get('dev')!.stops).toBe(1);
    expect(errors).toEqual([expect.objectContaining({
      from: 'dev', to: 'pm', correlationId: 'delegation-a',
      payload: expect.objectContaining({
        instruction: 'Coordinator cancelled delegation-a.', metadata: expect.objectContaining({ cancelled: true }),
      }),
    })]);
    expect(bus.query({ type: 'task.status', correlationId: 'delegation-a' }).at(-1)?.payload.metadata).toMatchObject({
      phase: 'cancellation-requested',
    });

    // The old backend can still emit, but it no longer owns this turn and cannot publish a completion.
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'late work', isError: false } });
    expect(bus.query({ type: 'task.complete', correlationId: 'delegation-a' })).toEqual([]);
  });

  it('routes Claude idle expiry through the same cancellation receipt path', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    const assignment = bus.send('pm', 'dev', 'task.assign', { instruction: 'silent delegated work' }, 'high', 'delegation-watchdog');

    backends.get('dev')!.emit({ kind: 'watchdog_idle', idleMs: 900_000 });

    const error = bus.query({ type: 'system.error', correlationId: assignment.correlationId }).at(-1);
    expect(error?.payload.instruction).toContain('no host-observed output, tool call, or approval request for 900s');
    expect(error?.payload.metadata).toMatchObject({ cancelled: true });
    expect(backends.get('dev')!.aborts).toBe(1);
    expect(backends.get('dev')!.stops).toBe(1);
  });

  it('interjectAgent steers a BUSY agent mid-turn (G-001)', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' }); // now running

    mgr.interjectAgent('dev', 'use read_file instead');

    expect(backends.get('dev')!.interjects).toEqual(['use read_file instead']);
  });

  it('interjectAgent to an IDLE agent runs it as a normal turn, never as a dropped interjection', async () => {
    // The real OpenAICompatBackend.interject() bails with "interject ignored: agent is idle" — so the old
    // path silently discarded a message sent to an idle agent. It is a normal turn; deliver it.
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    mgr.interjectAgent('dev', 'use read_file instead');

    expect(backends.get('dev')!.turns).toEqual(['use read_file instead']);
    expect(backends.get('dev')!.interjects).toEqual([]);
  });

  it('serializes two tasks to a busy agent and routes each completion to its own sender', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' }); // -> idle

    const completes: Message[] = [];
    bus.onType('task.complete', (m) => completes.push(m));

    // A from alice; while it runs, B from bob arrives — B must queue, not overwrite A's origin.
    const a = bus.send('alice', 'dev', 'task.assign', { instruction: 'A' });
    const b = bus.send('bob', 'dev', 'task.assign', { instruction: 'B' });
    expect(backends.get('dev')!.turns).toEqual(['A']); // one at a time

    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'doneA', isError: false } });
    expect(backends.get('dev')!.turns).toEqual(['A', 'B']); // B delivered after A completes

    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'doneB', isError: false } });

    // Each completion goes to the right original sender — no cross-talk, no broadcast.
    expect(completes.map((m) => [m.to, m.payload.instruction])).toEqual([
      ['alice', 'doneA'],
      ['bob', 'doneB'],
    ]);
    expect(completes.map((m) => m.correlationId)).toEqual([a.id, b.id]);
  });

  it('lazily starts a stopped agent when a message is routed to it', async () => {
    mgr.create(makeConfig('rev', 'reviewer'));
    expect(mgr.get('rev')!.status).toBe('stopped');

    bus.send('user', 'rev', 'review.request', { instruction: 'review this' });
    // start() is async; give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 0));
    backends.get('rev')!.emit({ kind: 'ready' });

    expect(backends.get('rev')!.turns).toEqual(['review this']);
  });

  it('ignores an agent reacting to its own outgoing messages', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('dev', 'dev', 'task.assign', { instruction: 'self' });
    expect(backends.get('dev')!.turns).toEqual([]);
  });

  it('passes resolveTaskModel as a per-turn Smart Mode model without mutating configured model', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveTaskModel: (_config, msg) =>
        (msg.payload?.metadata as { tier?: string } | undefined)?.tier === 'premium' ? 'opus-x' : 'flash-y',
    });
    localMgr.create(makeConfig('rev', 'reviewer'));
    await localMgr.start('rev');
    localBackends.get('rev')!.emit({ kind: 'ready' });

    localBus.send('user', 'rev', 'review.request', { instruction: 'r1' });
    expect(localBackends.get('rev')!.attachments[0]?.model).toBe('flash-y');
    expect(localMgr.get('rev')!.config.model).toBe('claude-sonnet-4-20250514');

    // Complete the first turn so the agent is idle before the next task is delivered (turns serialize).
    localBackends.get('rev')!.emit({ kind: 'turn_complete', result: { text: 'ok', isError: false } });
    localBus.send('user', 'rev', 'task.assign', { instruction: 'big', metadata: { tier: 'premium' } });
    expect(localBackends.get('rev')!.attachments[1]?.model).toBe('opus-x');
    expect(localMgr.get('rev')!.config.model).toBe('claude-sonnet-4-20250514');
  });

  it('freezes Smart Mode identity from the selected tier model rather than config.model', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveTaskModel: () => 'tier-model',
      resolveEffectiveExecutionIdentity: (_config, model) => createEffectiveExecutionIdentity(model, 'unode', 3),
    });
    localMgr.create(makeConfig('rev', 'reviewer'));
    await localMgr.start('rev');
    localBackends.get('rev')!.emit({ kind: 'ready' });

    localBus.send('user', 'rev', 'review.request', { instruction: 'review' });
    expect(localMgr.effectiveExecutionIdentity('rev')).toEqual(createEffectiveExecutionIdentity('tier-model', 'unode', 3));
    expect(localMgr.get('rev')!.config.model).toBe('claude-sonnet-4-20250514');
    localBackends.get('rev')!.emit({ kind: 'turn_complete', result: { text: 'ok', isError: false } });
    expect(localMgr.effectiveExecutionIdentity('rev')).toEqual(createEffectiveExecutionIdentity('tier-model', 'unode', 3));
  });

  it('passes selected Smart Mode tier params through the model-param resolver', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveTaskModelParams: (_config, msg) =>
        (msg.payload?.metadata as { tier?: string } | undefined)?.tier === 'premium'
          ? { reasoning_effort: 'high', temperature: 0.9 }
          : undefined,
      resolveModelParams: (config, tierParams) => ({
        ...tierParams,
        ...config.modelParams,
      }),
    });
    const cfg = makeConfig('rev', 'reviewer');
    cfg.modelParams = { temperature: 0.2 };
    localMgr.create(cfg);
    await localMgr.start('rev');
    localBackends.get('rev')!.emit({ kind: 'ready' });

    localBus.send('user', 'rev', 'task.assign', { instruction: 'big', metadata: { tier: 'premium' } });

    expect(localBackends.get('rev')!.attachments[0]?.modelParams).toEqual({
      reasoning_effort: 'high',
      temperature: 0.2,
    });
  });

  it('estimates Smart Mode turn cost against the per-turn model, not the configured model', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const pricedModels: string[] = [];
    const localMgr = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveTaskModel: () => 'smart-priced-model',
      estimateCost: (model, input, output) => {
        pricedModels.push(model);
        return model === 'smart-priced-model' ? input + output : 0;
      },
    });
    localMgr.create(makeConfig('rev', 'reviewer'));
    await localMgr.start('rev');
    localBackends.get('rev')!.emit({ kind: 'ready' });

    localBus.send('user', 'rev', 'task.assign', { instruction: 'priced' });
    localBackends.get('rev')!.emit({
      kind: 'turn_complete',
      result: { text: 'ok', isError: false, usage: { inputTokens: 2, outputTokens: 3 } },
    });

    expect(pricedModels).toEqual(['smart-priced-model']);
    expect(localMgr.get('rev')!.config.model).toBe('claude-sonnet-4-20250514');
    expect(localMgr.get('rev')!.usage?.costUsd).toBe(5);
  });

  it('passes chat mode to backend attachments and normalizes invalid values to act', async () => {
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('user', 'dev', 'ask.question', { instruction: 'plan this', mode: 'plan' });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'planned', isError: false } });
    bus.send('user', 'dev', 'ask.question', { instruction: 'act fallback', mode: 'oops' as any });

    expect(backends.get('dev')!.attachments.map((a) => a?.mode)).toEqual(['plan', 'act']);
  });

  it('keeps .unode/rules.md project context off the startup system prompt, without mutating config (P1)', async () => {
    const localBus = new MessageBus();
    let seenPrompt = '';
    const mgr2 = new SessionManager(5, localBus, {
      createBackend: (c) => { seenPrompt = c.systemPrompt; return new FakeBackend(c); },
      resolveEnv: async () => ({}),
      getProjectContext: () => 'Use strict TypeScript',
    });
    const cfg = makeConfig('dev', 'senior-dev');
    cfg.systemPrompt = 'You are a dev.';
    mgr2.create(cfg);
    await mgr2.start('dev');

    expect(seenPrompt).toContain('You are a dev.');
    expect(seenPrompt).not.toContain('<project_context>');
    // The stored config remains clean; current rules are attached at the tail of every delivered turn.
    expect(mgr2.get('dev')!.config.systemPrompt).toBe('You are a dev.');
  });

  it('passes the latest project context to every delivered turn (F4)', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    let projectContext = 'v1';
    const mgr2 = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      getProjectContext: () => projectContext,
    });
    mgr2.create(makeConfig('dev', 'senior-dev'));
    await mgr2.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('user', 'dev', 'task.assign', { instruction: 'one' });
    projectContext = 'v2';
    localBackends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    localBus.send('user', 'dev', 'task.assign', { instruction: 'two' });

    expect(localBackends.get('dev')!.attachments.map((a) => a?.projectContext)).toEqual(['v1', 'v2']);
  });

  it('does not attach workspaceContext when the host gatherer returns nothing', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const mgr2 = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      getWorkspaceContext: () => undefined,
    });
    mgr2.create(makeConfig('dev', 'senior-dev'));
    await mgr2.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('user', 'dev', 'task.assign', { instruction: 'one' });
    await new Promise((r) => setTimeout(r, 0));

    expect(localBackends.get('dev')!.attachments[0]?.workspaceContext).toBeUndefined();
  });

  it('attaches formatted workspaceContext returned by the host gatherer', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    const workspaceContext = [
      'Active file: src/app.ts',
      '--- Active editor snippet ---',
      'export const value = 1;',
      '(truncated - use read_file for the rest)',
      '--- Diagnostics ---',
      'src/app.ts:2:5 [error] Cannot find name value',
    ].join('\n');
    const mgr2 = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      getWorkspaceContext: () => workspaceContext,
    });
    mgr2.create(makeConfig('dev', 'senior-dev'));
    await mgr2.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('user', 'dev', 'task.assign', { instruction: 'one' });
    await new Promise((r) => setTimeout(r, 0));

    expect(localBackends.get('dev')!.attachments[0]?.workspaceContext).toBe(workspaceContext);
  });

  it('gathers workspaceContext fresh for each turn', async () => {
    const localBus = new MessageBus();
    const localBackends = new Map<string, FakeBackend>();
    let workspaceContext: string | undefined = 'Active file: src/one.ts';
    const mgr2 = new SessionManager(5, localBus, {
      createBackend: (c) => { const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      getWorkspaceContext: () => workspaceContext,
    });
    mgr2.create(makeConfig('dev', 'senior-dev'));
    await mgr2.start('dev');
    localBackends.get('dev')!.emit({ kind: 'ready' });

    localBus.send('user', 'dev', 'task.assign', { instruction: 'one' });
    await new Promise((r) => setTimeout(r, 0));
    workspaceContext = undefined;
    localBackends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    localBus.send('user', 'dev', 'task.assign', { instruction: 'two' });
    await new Promise((r) => setTimeout(r, 0));

    expect(localBackends.get('dev')!.attachments.map((a) => a?.workspaceContext)).toEqual(['Active file: src/one.ts', undefined]);
  });

  it('resolves workflow refs by role or id', async () => {
    mgr.create(makeConfig('uuid-1', 'tester'));
    expect(mgr.resolveByRoleOrId('tester')!.id).toBe('uuid-1');
    expect(mgr.resolveByRoleOrId('uuid-1')!.config.role).toBe('tester');
    expect(mgr.resolveByRoleOrId('nope')).toBeUndefined();
  });
});

describe('SessionManager cost estimation', () => {
  it('estimates costUsd from tokens when the backend reports none, and prefers a real cost', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => { const b = new FakeBackend(config); backends.set(config.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveEffectiveExecutionIdentity: (_config, model) => createEffectiveExecutionIdentity(model, 'unode', 1),
      estimateCost: (_model, i, o) => i * 1e-6 + o * 2e-6,
    });

    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    // Turn 1: tokens only, no costUsd -> estimated (1M*1e-6 + 1M*2e-6 = 3.0).
    bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
    backends.get('dev')!.emit({
      kind: 'turn_complete',
      result: { text: '', isError: false, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    });
    expect(mgr.get('dev')!.usage!.costUsd).toBeCloseTo(3.0, 6);

    // Turn 2: backend reports a real cost -> used verbatim, not estimated (3.0 + 0.5).
    bus.send('user', 'dev', 'task.assign', { instruction: 'go2' });
    backends.get('dev')!.emit({
      kind: 'turn_complete',
      result: { text: '', isError: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5 } },
    });
    expect(mgr.get('dev')!.usage!.costUsd).toBeCloseTo(3.5, 6);
  });
});

describe('SessionManager history summarization hook', () => {
  it('runs compactHistory before delivering to a backend that supports it', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, CompactingBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = new CompactingBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
      summarizer: { summarize: async () => 'summary' },
      summarizerIO: () => ({ chatCompletion: async () => 'summary' }),
      summarizerModel: () => 'economy-model',
    });

    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
    expect(backends.get('dev')!.turns).toEqual([]);

    await new Promise((r) => setTimeout(r, 0));

    expect(backends.get('dev')!.compactCalls).toEqual(['economy-model']);
    expect(backends.get('dev')!.turns).toEqual(['go']);
  });

  it('does not summarize backends without the optional compactHistory capability', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = new FakeBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
      summarizer: { summarize: async () => 'summary' },
      summarizerIO: () => ({ chatCompletion: async () => 'summary' }),
      summarizerModel: () => 'economy-model',
    });

    mgr.create(makeConfig('claude-dev', 'senior-dev'));
    await mgr.start('claude-dev');
    backends.get('claude-dev')!.emit({ kind: 'ready' });

    bus.send('user', 'claude-dev', 'task.assign', { instruction: 'go' });

    expect(backends.get('claude-dev')!.turns).toEqual(['go']);
  });
});

describe('SessionManager model fallback (P1#6)', () => {
  function setup() {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => { const b = new FakeBackend(config); backends.set(config.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveEffectiveExecutionIdentity: (_config, model) => createEffectiveExecutionIdentity(model, 'unode', 1),
    });
    return { bus, backends, mgr };
  }

  it('switches to fallbackModel after consecutive failures and emits session.modelSwitched', async () => {
    const { bus, backends, mgr } = setup();
    const cfg = makeConfig('dev', 'senior-dev');
    cfg.model = 'primary-x';
    cfg.fallbackModel = 'backup-y';
    mgr.create(cfg);
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const switches: Array<{ from: string; to: string }> = [];
    mgr.on('session.modelSwitched', (e) => switches.push({ from: e.data.from, to: e.data.to }));

    const fail = () => {
      bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
      backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'boom', isError: true } });
    };

    fail(); // 1st failure — still on primary
    expect(mgr.get('dev')!.config.model).toBe('primary-x');
    fail(); // 2nd failure — switch to fallback
    expect(mgr.get('dev')!.config.model).toBe('backup-y');
    expect(mgr.effectiveExecutionIdentity('dev')).toEqual(createEffectiveExecutionIdentity('primary-x', 'unode', 1));
    expect(switches).toEqual([{ from: 'primary-x', to: 'backup-y' }]);
  });

  it('resets the failure counter on a successful turn', async () => {
    const { bus, backends, mgr } = setup();
    const cfg = makeConfig('dev', 'senior-dev');
    cfg.model = 'primary-x';
    cfg.fallbackModel = 'backup-y';
    mgr.create(cfg);
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    const turn = (isError: boolean) => {
      bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
      backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: '', isError } });
    };
    turn(true);   // fail 1
    turn(false);  // success resets
    turn(true);   // fail 1 again — not enough to switch
    expect(mgr.get('dev')!.config.model).toBe('primary-x');
  });

  it('setModel changes the model and records a cost timeline sample per turn', async () => {
    const { bus, backends, mgr } = setup();
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    expect(mgr.setModel('dev', 'new-model')).toBe(true);
    expect(mgr.setModel('dev', 'new-model')).toBe(false); // no-op when unchanged
    expect(mgr.get('dev')!.config.model).toBe('new-model');

    bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: '', isError: false, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } } });
    const timeline = mgr.getCostTimeline();
    expect(timeline.length).toBe(1);
    expect(timeline[0].cost).toBeCloseTo(0.5, 6);
  });
});

describe('SessionManager concurrency cap (B1)', () => {
  function setup(maxConcurrent: number) {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(maxConcurrent, bus, {
      createBackend: (config) => { const b = new FakeBackend(config); backends.set(config.id, b); return b; },
      resolveEnv: async () => ({}),
    });
    return { bus, backends, mgr };
  }

  it('queues a start beyond the cap and auto-starts it when a slot frees', async () => {
    const { backends, mgr } = setup(1);
    mgr.create(makeConfig('a1', 'developer'));
    mgr.create(makeConfig('a2', 'reviewer'));

    const queued: string[] = [];
    mgr.on('session.queued', (e) => queued.push(e.sessionId));

    await mgr.start('a1'); // takes the only slot
    backends.get('a1')!.emit({ kind: 'ready' });
    expect(mgr.getRunningCount()).toBe(1);

    await mgr.start('a2'); // over cap -> queued, not started (no backend, no throw)
    expect(queued).toEqual(['a2']);
    expect(backends.has('a2')).toBe(false);
    expect(mgr.get('a2')!.status).toBe('stopped');

    await mgr.stop('a1'); // frees the slot -> a2 drains and starts
    expect(backends.has('a2')).toBe(true);
    expect(mgr.get('a2')!.status).toBe('starting');
  });

  it('startAll does not throw when more agents than slots are configured', async () => {
    const { backends, mgr } = setup(1);
    mgr.create(makeConfig('a1', 'developer'));
    mgr.create(makeConfig('a2', 'reviewer'));

    await expect(mgr.startAll()).resolves.toBeDefined();
    expect(backends.has('a1')).toBe(true);
    expect(mgr.get('a2')!.status).toBe('stopped'); // queued, not failed
  });

  it('a turn-level error (backend still alive) does NOT free a slot for a queued agent', async () => {
    const { bus, backends, mgr } = setup(1);
    mgr.create(makeConfig('a1', 'developer'));
    mgr.create(makeConfig('a2', 'reviewer'));
    await mgr.start('a1');
    backends.get('a1')!.emit({ kind: 'ready' }); // a1 takes the only slot

    await mgr.start('a2'); // queued (over cap)
    expect(backends.has('a2')).toBe(false);

    // a1 hits a turn error but stays alive (error then turn_complete) — must not start a2.
    bus.send('user', 'a1', 'task.assign', { instruction: 'go' });
    backends.get('a1')!.emit({ kind: 'error', message: 'transient boom' });
    expect(backends.has('a2')).toBe(false); // slot NOT freed
    expect(mgr.getRunningCount()).toBe(1);

    backends.get('a1')!.emit({ kind: 'turn_complete', result: { text: 'recovered', isError: true } });
    expect(mgr.get('a1')!.status).toBe('idle'); // restored, not stuck in error
    expect(backends.has('a2')).toBe(false); // still queued — cap respected
  });

  it('stopAll cancels queued starts instead of starting them when a slot frees', async () => {
    const { backends, mgr } = setup(1);
    mgr.create(makeConfig('a1', 'developer'));
    mgr.create(makeConfig('a2', 'reviewer'));

    await mgr.start('a1');
    backends.get('a1')!.emit({ kind: 'ready' });
    await mgr.start('a2');
    expect(backends.has('a2')).toBe(false);

    await mgr.stopAll();
    expect(backends.has('a2')).toBe(false);
    expect(mgr.get('a2')!.status).toBe('stopped');
  });

  it('drains a queued start when backend.start fails after consuming a slot', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, DeferredStartBackend | FakeBackend>();
    const mgr = new SessionManager(1, bus, {
      createBackend: (config) => {
        const b = config.id === 'a1' ? new DeferredStartBackend(config) : new FakeBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
    });
    mgr.create(makeConfig('a1', 'developer'));
    mgr.create(makeConfig('a2', 'reviewer'));

    const startA1 = mgr.start('a1');
    await new Promise((r) => setTimeout(r, 0));
    await mgr.start('a2');
    expect(backends.has('a2')).toBe(false);

    (backends.get('a1') as DeferredStartBackend).rejectStart(new Error('spawn failed'));
    await expect(startA1).rejects.toThrow('spawn failed');

    expect(backends.has('a2')).toBe(true);
    expect(mgr.get('a2')!.status).toBe('starting');
  });
});

describe('SessionManager conversation persistence (L2 recovery)', () => {
  it('saves a snapshot after each turn, restores it on restart, and clears it on remove', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const store = new Map<string, ConversationSnapshot>();

    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = new FakeBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
      loadSnapshot: (id) => store.get(id),
      saveSnapshot: (id, snap) => { store.set(id, snap); },
      clearSnapshot: (id) => { store.delete(id); },
    });

    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });

    // A completed turn persists the backend's snapshot.
    bus.send('user', 'dev', 'task.assign', { instruction: 'do work' });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(store.get('dev')).toEqual({ version: 1, messages: ['history of dev'] });

    // Restarting creates a NEW backend; SessionManager must restore the saved snapshot into it.
    await mgr.stop('dev');
    backends.get('dev')!.emit({ kind: 'exit', code: 0 });
    await mgr.start('dev');
    expect(backends.get('dev')!.restored).toEqual({ version: 1, messages: ['history of dev'] });

    // Removing the agent clears its persisted snapshot.
    await mgr.remove('dev');
    expect(store.has('dev')).toBe(false);
  });
});

describe('SessionManager resolveWorkingDirectory (worktree fan-out)', () => {
  it('roots the agent at the resolved worktree path before building the backend', async () => {
    const bus = new MessageBus();
    let captured: AgentConfig | undefined;
    const mgr = new SessionManager(5, bus, {
      createBackend: (c) => { captured = c; return new FakeBackend(c); },
      resolveEnv: async () => ({}),
      resolveWorkingDirectory: async (c) => `/wt/${c.id}`,
    });
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    expect(captured?.workingDirectory).toBe('/wt/dev');
    // The resolved root is also recorded as the session's runtime truth (not just on the backend) so
    // grounding/preflight read a consistent value — and it is NOT written back to the persisted config.
    const info = mgr.getAll().find((s) => s.config.id === 'dev');
    expect(info?.runtimeWorkingDirectory).toBe('/wt/dev');
    expect(info?.config.workingDirectory).toBeUndefined(); // persisted config stays clean (no worktree path)
  });

  // Runtime invariant (Codex): Smart Mode's per-turn setModel only swaps the model — it must NOT restart the
  // session, recreate the backend, or touch the working directory (root/session state stays put).
  it('setModel swaps the model in place — no restart/recreate, no working-dir mutation', async () => {
    let creates = 0;
    const localBackends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, new MessageBus(), {
      createBackend: (c) => { creates++; const b = new FakeBackend(c); localBackends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      resolveWorkingDirectory: async () => '/runtime/root',
    });
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    expect(creates).toBe(1);
    const info = mgr.getAll().find((s) => s.config.id === 'dev')!;

    mgr.setModel('dev', 'tier-model-x'); // exactly what Smart Mode does per turn

    expect(creates).toBe(1);                                    // no restart / recreate
    expect(localBackends.get('dev')!.models).toEqual(['tier-model-x']); // applied in place
    expect(info.runtimeWorkingDirectory).toBe('/runtime/root'); // root unchanged
    expect(info.config.workingDirectory).toBeUndefined();       // persisted config untouched
  });

  it('falls back to the normal root when resolveWorkingDirectory returns undefined or throws', async () => {
    const bus = new MessageBus();
    let captured: AgentConfig | undefined;
    const mgr = new SessionManager(5, bus, {
      createBackend: (c) => { captured = c; return new FakeBackend(c); },
      resolveEnv: async () => ({}),
      resolveWorkingDirectory: async () => { throw new Error('no git'); },
    });
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    expect(captured?.workingDirectory).toBeUndefined(); // unchanged; backend uses its default root
  });

  it('blocks folderAccess in worktree mode with an actionable error state', async () => {
    const config = {
      ...makeConfig('dev', 'senior-dev'),
      name: 'Dev Agent',
      folderAccess: [{ path: 'src', permission: 'readwrite' as const }],
    };
    const message = folderAccessWorktreeConflictMessage(config);
    expect(message).toContain('Dev Agent');
    expect(message).toContain('Switch unode.concurrencyStrategy off worktree mode');
    expect(message).toContain("clear this agent's Folder Access");
    expect(() => assertNoFolderAccessWorktreeConflict(config, true)).toThrow(message);
    expect(() => assertNoFolderAccessWorktreeConflict(config, false)).not.toThrow();

    let backendCreated = false;
    const mgr = new SessionManager(5, new MessageBus(), {
      createBackend: (c) => { backendCreated = true; return new FakeBackend(c); },
      resolveEnv: async () => ({}),
      resolveWorkingDirectory: async (c) => {
        assertNoFolderAccessWorktreeConflict(c, true);
        return '/should-not-run';
      },
    });
    mgr.create(config);

    await expect(mgr.start('dev')).rejects.toThrow(message);

    const info = mgr.get('dev')!;
    expect(backendCreated).toBe(false);
    expect(info.status).toBe('error');
    expect(info.errorMessage).toBe(message);
  });
});

describe('a user message ALWAYS goes on the bus (steering is only a delivery strategy)', () => {
  // Field report (Y Zhang): a message sent while the PM was mid-delegation never appeared in the message
  // history and was never answered. Root cause: the steering path bypassed the bus entirely.
  //  - Claude has no interject() -> `?.interject?.()` was a NO-OP: the message was SILENTLY DISCARDED.
  //  - OpenAICompat has interject(), but it only pushed onto a private array INSIDE the backend, so the
  //    message still never reached the bus and never appeared in history.
  // Both are the same design bug. Every user message must be recorded on the bus; how it is delivered
  // (steer mid-turn vs. queue for the next turn) is a separate decision.
  class NoInterjectBackend extends FakeBackend {
    interject: undefined = undefined as never; // models ClaudeHeadlessBackend
  }

  const setup = <T extends FakeBackend>(make: (c: AgentConfig) => T) => {
    const bus = new MessageBus();
    const backends = new Map<string, T>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = make(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
    });
    return { bus, mgr, backends };
  };

  it('records the message on the bus even when the backend steers it mid-turn', async () => {
    const { bus, mgr, backends } = setup((c) => new FakeBackend(c)); // steerable
    const seen: string[] = [];
    bus.onType('ask.question', (m) => { if (m.to === 'dev') { seen.push(String(m.payload.instruction)); } });
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    backends.get('dev')!.emit({ kind: 'ready' });
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' });

    mgr.interjectAgent('dev', 'also do X');

    expect(seen).toContain('also do X');                          // visible in history — the old bug
    expect(backends.get('dev')!.interjects).toEqual(['also do X']); // still steered mid-turn
  });

  it('holds it for the next turn when the backend cannot steer, and never drops it', async () => {
    const { bus, mgr, backends } = setup((c) => new NoInterjectBackend(c)); // Claude-like
    const seen: string[] = [];
    bus.onType('ask.question', (m) => { if (m.to === 'pm') { seen.push(String(m.payload.instruction)); } });
    mgr.create(makeConfig('pm', 'pm'));
    await mgr.start('pm');
    const backend = backends.get('pm')!;
    backend.emit({ kind: 'ready' });
    bus.send('user', 'pm', 'task.assign', { instruction: 'delegate the work' });
    expect(mgr.get('pm')!.status).toBe('running');

    mgr.interjectAgent('pm', 'what files are here?');

    expect(seen).toContain('what files are here?');    // on the bus / in history, not discarded
    expect(backend.turns).toEqual(['delegate the work']); // does not jump the running turn

    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(backend.turns).toContain('what files are here?'); // delivered as a normal turn on idle
  });
});

describe('a steerable backend that REFUSES the steer must not lose the message', () => {
  // Race: the session still reads 'running' but the backend's turn just ended, so its interject() returns
  // false. The old OpenAICompatBackend simply logged "interject ignored: agent is idle" and dropped the text.
  class RefusingBackend extends FakeBackend {
    interject(_text: string): boolean {
      return false; // "I'm not actually mid-turn — you deliver it"
    }
  }

  it('falls back to the inbox and delivers it on the next idle', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, RefusingBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (config) => {
        const b = new RefusingBackend(config);
        backends.set(config.id, b);
        return b;
      },
      resolveEnv: async () => ({}),
    });
    mgr.create(makeConfig('dev', 'senior-dev'));
    await mgr.start('dev');
    const backend = backends.get('dev')!;
    backend.emit({ kind: 'ready' });
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' });

    mgr.interjectAgent('dev', 'and also this');
    expect(backend.turns).toEqual(['work']); // refused the steer; not lost

    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(backend.turns).toContain('and also this'); // delivered as a normal turn
  });
});
