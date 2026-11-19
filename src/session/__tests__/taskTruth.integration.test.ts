import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type {
  AgentBackend,
  BackendEvent,
  BackendEventHandler,
  ConversationSnapshot,
  TurnAttachments,
} from '../../backend/AgentBackend';
import {
  compileTaskContract,
  TaskInputResolver,
  type CandidateContractAgent,
  type EffectiveTaskContract,
} from '../../backend/TaskContract';
import { TeamTools, type TeamView } from '../../backend/TeamTools';
import { summarizeToolResult } from '../../backend/toolSummary';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { RunLedger } from '../../observability/RunLedger';
import { evaluateReviewPolicy } from '../../policy/ReviewPolicyPreflight';
import { TeamPolicyStore } from '../../policy/TeamPolicy';
import type { AgentConfig, Message } from '../../types';
import { createEffectiveExecutionIdentity } from '../EffectiveExecutionIdentity';
import { SessionManager } from '../SessionManager';

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): void { this.values.set(key, value); }
}

class StubBackend implements AgentBackend {
  pid = 1234;
  readonly turns: string[] = [];
  readonly attachments: Array<TurnAttachments | undefined> = [];
  readonly configuredPrompt: string;
  private handler?: BackendEventHandler;
  private alive = false;

  constructor(config: AgentConfig) {
    this.configuredPrompt = config.systemPrompt;
    this.agentId = config.id;
  }

  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  /** Agents whose start fails, as when their program is missing. */
  static readonly failStartFor = new Set<string>();
  private readonly agentId: string = '';

  async start(): Promise<void> {
    if (StubBackend.failStartFor.has(this.agentId)) throw new Error('spawn worker-cli ENOENT');
    this.alive = true;
  }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void {
    this.turns.push(instruction);
    this.attachments.push(attachments);
  }
  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void { /* deterministic stub */ }
  setModel(): void { /* request-scoped model selection is asserted through the identity resolver */ }
  isAlive(): boolean { return this.alive; }
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): void { /* deterministic stub */ }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function config(id: string, role: AgentConfig['role']): AgentConfig {
  return {
    id,
    name: id,
    role,
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'configured-model',
    systemPrompt: 'Stable team guidance.',
    autoApprove: true,
    allowedTools: [],
  };
}

function compile(root: string, overrides: Record<string, unknown> = {}): EffectiveTaskContract {
  const result = compileTaskContract({
    version: 1,
    objective: 'Process the declared source.',
    expected_deliverable: 'Return a bounded result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
    ...overrides,
  }, 'pm', root);
  if (!result.contract) throw new Error(result.error);
  return result.contract;
}

function candidate(
  agentId: string,
  overrides: Partial<CandidateContractAgent> = {},
): CandidateContractAgent {
  return {
    agentId,
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: [],
    liveContentAssetIds: [],
    readyArtifacts: [],
    ...overrides,
  };
}

function contentTools(root: string, agentId: string, assets: ContentAssetStore): WorkspaceTools {
  return new WorkspaceTools(
    root, new Set(['read']), agentId, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, { policy: () => 'off', requestApproval: async () => ({ allow: false }) },
    'apply-edit', assets,
  );
}

async function flushAsyncDelivery(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

describe('v0.9.70 task-truth integrated regressions', () => {
  it('wakes the idle PM through the existing async-result path when a rework reply arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-rework-wake-'));
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, root);
    const bus = new MessageBus();
    const backends = new Map<string, StubBackend>();
    const manager = new SessionManager(2, bus, {
      createBackend: (agentConfig) => {
        const backend = new StubBackend(agentConfig);
        backends.set(agentConfig.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
    });
    let team!: TeamTools;
    try {
      manager.create(config('pm', 'pm'));
      manager.create(config('worker', 'developer'));
      await manager.start('pm', { pin: 'take' });
      await manager.start('worker', { pin: 'take' });
      backends.get('pm')!.emit({ kind: 'ready' });
      backends.get('worker')!.emit({ kind: 'ready' });
      const view: TeamView = {
        list: () => [
          { id: 'pm', role: 'pm', name: 'PM', status: manager.get('pm')?.status ?? 'stopped' },
          {
            id: 'worker', role: 'developer', name: 'Worker', status: manager.get('worker')?.status ?? 'stopped',
            capabilities: {
              read: true, write: false, shell: false, verificationSensors: [],
              toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const,
            },
          },
        ],
        resolve: (ref) => ref === 'worker' ? { id: 'worker' } : undefined,
      };
      team = new TeamTools('pm', view, bus, {
        cwd: root,
        timeoutMs: 1_000,
        taskInputResolver: resolver,
        onAsyncResultReady: (result) => manager.queueAsyncDelegationWake(
          'pm',
          result,
          () => team.isAsyncResultReady(result.handle),
          () => team.consumeAsyncResult(result.handle),
        ),
      });
      let handle = '';
      bus.onType('task.assign', (message) => {
        if (message.to !== 'worker') return;
        handle = message.correlationId ?? '';
        bus.send('worker', 'pm', 'task.complete', { instruction: 'Initial result.' }, 'normal', handle);
      });
      bus.onType('agent.message', (message) => {
        if (message.from !== 'pm' || message.to !== 'worker') return;
        bus.send('worker', 'pm', 'task.complete', { instruction: 'Rework addressed.' }, 'normal', message.correlationId);
      });

      await team.run('assign_task', { agent: 'worker', instruction: 'Draft the release note.' });
      await team.run('record_task_disposition', {
        handle,
        disposition: 'needs-rework',
        reason: 'Explain the upgrade path.',
      });
      await flushAsyncDelivery();

      expect(backends.get('pm')!.turns).toHaveLength(1);
      expect(backends.get('pm')!.turns[0]).toContain('Async delegation result arrived');
      expect(backends.get('pm')!.turns[0]).toContain(`=== worker (${handle}) ===`);
      expect(backends.get('pm')!.turns[0]).toContain('Rework addressed.');
      expect(manager.get('pm')!.status).toBe('running');
    } finally {
      await manager.stopAll();
      bus.dispose();
      await assets.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('settles a worker process exit as a durable interruption and releases the exact attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-interrupted-task-'));
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, root);
    const ledger = new RunLedger();
    const bus = new MessageBus();
    const backends = new Map<string, StubBackend>();
    const manager = new SessionManager(2, bus, {
      createBackend: (agentConfig) => {
        const backend = new StubBackend(agentConfig);
        backends.set(agentConfig.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      onTaskAttemptTerminal: (attemptId) => resolver.endAttempt(attemptId, 'interrupted'),
    });
    const wake = { count: 0 };
    try {
      manager.create(config('worker', 'developer'));
      await manager.start('worker', { pin: 'take' });
      backends.get('worker')!.emit({ kind: 'ready' });
      const view: TeamView = {
        list: () => [{
          id: 'worker', role: 'developer', name: 'Worker', status: manager.get('worker')?.status ?? 'stopped',
          capabilities: {
            read: true, write: false, shell: false, verificationSensors: [],
            toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const,
          },
        }],
        resolve: (ref) => ref === 'worker' ? { id: 'worker' } : undefined,
      };
      const team = new TeamTools('pm', view, bus, {
        cwd: root,
        timeoutMs: 1_000,
        taskInputResolver: resolver,
        onDelegationDispatched: (event) => ledger.recordDelegationDispatched({
          ...event, originCorrelationId: 'root-interrupted',
        }),
        onDelegationInterrupted: (event) => ledger.recordDelegationInterrupted(event),
        onAsyncResultReady: () => { wake.count++; },
        inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
      });

      const dispatched = await team.run('dispatch_task', {
        agent: 'worker', instruction: 'Read the durable inputs.', contract: {
          version: 1,
          objective: 'Read the durable inputs.',
          expected_deliverable: 'Return the bounded result.',
          effects: { read_files: [], expected_file_effect: 'none' },
          inputs: [], constraints: [], dependencies: [],
          required_capabilities: { version: 1, capabilities: ['read'] },
          execution_strategy: 'delegate-required',
        },
      });
      const handle = dispatched.match(/Handle: ([0-9a-f-]+)/i)![1];
      const attemptId = ledger.get(ledger.runIdForDelegation(handle)!)!.delegations[0].attemptId!;
      expect(resolver.isAttemptLive(attemptId, 'worker')).toBe(true);

      backends.get('worker')!.emit({ kind: 'exit', code: 17 });
      await flushAsyncDelivery();

      expect(resolver.isAttemptLive(attemptId, 'worker')).toBe(false);
      expect(ledger.inspectTaskStatus('pm', [handle])[0]).toMatchObject({
        lifecycle: 'interrupted', interruption: { reason: 'worker-lost' },
      });
      expect(await team.run('inspect_task_status', { handles: [handle] }))
        .toMatch(/state: interrupted[\s\S]*next action: do not wait/i);
      expect(wake.count).toBe(0);
    } finally {
      await manager.stopAll();
      bus.dispose();
      await assets.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('carries a successful 6-8 KB read through evidence, auto-wake, and durable non-consuming status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-task-truth-'));
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, root);
    const bus = new MessageBus();
    const ledger = new RunLedger();
    const backends = new Map<string, StubBackend>();
    const manager = new SessionManager(2, bus, {
      createBackend: (agentConfig) => {
        const backend = new StubBackend(agentConfig);
        backends.set(agentConfig.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
    });
    let team!: TeamTools;
    let workerRun: Promise<void> | undefined;
    let readOutput = '';
    let readSummary: ReturnType<typeof summarizeToolResult> | undefined;
    let gapResult = '';
    let handle = '';

    try {
      const source = 'CLAUSE-'.repeat(900); // 6,300 bytes: large enough to truncate only the UI detail.
      await writeFile(join(root, 'order-form.txt'), source, 'utf8');
      manager.create(config('pm', 'pm'));
      await manager.start('pm', { pin: 'take' });
      backends.get('pm')!.emit({ kind: 'ready' });

      const roster = [
        { id: 'pm', role: 'pm', name: 'PM', status: 'idle' },
        {
          id: 'worker', role: 'analyst', name: 'GRC Analyst', status: 'idle', workspaceRoot: root,
          capabilities: {
            read: true, write: false, shell: false, verificationSensors: [],
            toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const,
          },
        },
      ];
      const view: TeamView = { list: () => roster, resolve: (ref) => ref === 'worker' ? { id: 'worker' } : undefined };
      team = new TeamTools('pm', view, bus, {
        cwd: root,
        timeoutMs: 2_000,
        taskInputResolver: resolver,
        evidenceEnabled: true,
        waitForTaskAdmission: true,
        onDelegationDispatched: (event) => {
          handle = event.handle;
          ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'reported-gap-loop' });
        },
        onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
        onAsyncResultRetained: (result) => ledger.recordDeliveryPending(result.handle),
        onAsyncResultDelivered: (resultHandle, via) => ledger.recordDeliveryDelivered(resultHandle, via),
        inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
        onAsyncResultReady: (result) => {
          manager.queueAsyncDelegationWake(
            'pm',
            { ...result, runId: ledger.runIdForDelegation(result.handle) },
            () => team.isAsyncResultReady(result.handle),
            () => team.consumeAsyncResult(result.handle),
          );
        },
      });

      bus.onType('task.assign', (message: Message) => {
        if (message.to !== 'worker') return;
        bus.send('worker', 'pm', 'task.admitted', {}, 'normal', message.correlationId);
        workerRun = (async () => {
          const attempt = message.payload.taskAttempt!;
          const tools = new WorkspaceTools(root, new Set(['read']), 'worker');
          tools.setTaskInputResolver(resolver);
          tools.beginTurn();
          tools.setTaskAttempt(attempt);
          const readExecution = await tools.run('read_file', { path: 'order-form.txt' });
          readOutput = readExecution.output;
          readSummary = summarizeToolResult('read_file', { path: 'order-form.txt' }, readExecution);
          gapResult = (await tools.run('report_context_gap', { inputId: 'order_form', reason: 'unreadable' })).output;
          bus.send('worker', 'pm', 'task.complete', {
            instruction: 'The complete order form was read and reviewed.',
            metadata: {
              delegationEvidence: {
                hadToolActions: true,
                changedFiles: [],
                ...tools.taskAttemptEvidence(),
              },
            },
          }, 'normal', message.correlationId);
        })();
      });

      const rawContract = {
        version: 1,
        objective: 'Review the complete order form.',
        expected_deliverable: 'A bounded GRC review.',
        effects: { read_files: ['order-form.txt'], expected_file_effect: 'none' },
        inputs: [{
          input_id: 'order_form', kind: 'workspacePath', path: 'order-form.txt',
          purpose: 'Authoritative Order Form text', required: true, freshness: 'current',
          provenance: { kind: 'workspace', source_refs: [] },
        }],
        constraints: [], dependencies: [],
        required_capabilities: { version: 1, capabilities: ['read'] },
        execution_strategy: 'delegate-required',
      };
      const dispatched = await team.run('dispatch_task', {
        agent: 'worker', instruction: 'Read the declared order form and report the review.', contract: rawContract,
      });
      expect(dispatched).toContain('Dispatched contract');
      await workerRun;
      await flushAsyncDelivery();

      expect(Buffer.byteLength(readOutput, 'utf8')).toBeGreaterThanOrEqual(6_000);
      expect(Buffer.byteLength(readOutput, 'utf8')).toBeLessThan(8_000);
      expect(readSummary).toMatchObject({ ok: true, detail: expect.stringContaining('[detail truncated') });
      expect(gapResult).toMatch(/successfully read in this attempt/i);
      const attemptId = ledger.get(ledger.runIdForDelegation(handle)!)!.delegations[0].attemptId!;
      expect(resolver.gapsForAttempt(attemptId)).toEqual([]);
      expect(backends.get('pm')!.turns).toHaveLength(1);
      expect(backends.get('pm')!.turns[0]).toContain('The complete order form was read and reviewed.');

      const messageCount = bus.query().length;
      const status = await team.run('inspect_task_status', { handles: [handle] });
      expect(status).toContain('state: settled');
      expect(status).toContain('delivery: delivered via auto-wake');
      expect(status).toContain('input order_form: supplied yes · reachable yes · read receipt observed');
      expect(bus.query()).toHaveLength(messageCount);
      expect(await team.run('inspect_task_status', { handles: [handle] })).toBe(status);
    } finally {
      await manager.stopAll();
      bus.dispose();
      await assets.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces a human-selected review policy on the exact Smart Mode identity and records only a read receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unode-review-truth-'));
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, root);
    const policies = new TeamPolicyStore(new MemoryState(), () => new Date('2026-08-29T12:00:00.000Z'));
    const ledger = new RunLedger();
    const bus = new MessageBus();
    const backends = new Map<string, StubBackend>();
    const selectedModels = ['reported-a', 'reported-b', 'reported-a'];
    const authorIdentity = createEffectiveExecutionIdentity('reported-a', 'producer-route', 1);
    const manager = new SessionManager(2, bus, {
      createBackend: (agentConfig) => {
        const backend = new StubBackend(agentConfig);
        backends.set(agentConfig.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTaskModel: () => selectedModels.shift(),
      resolveEffectiveExecutionIdentity: (_agentConfig, reportedModelId) => createEffectiveExecutionIdentity(
        reportedModelId,
        reportedModelId === 'reported-a' ? 'alternate-review-route' : 'smart-review-route',
        reportedModelId === 'reported-a' ? 2 : 3,
      ),
      admitTaskExecution: (attempt, reviewerIdentity) => {
        resolver.bindAttemptExecutionIdentity(attempt.attemptId, reviewerIdentity);
        const facts = resolver.reviewPolicyFacts(attempt.attemptId);
        const decision = evaluateReviewPolicy({
          review: facts.review,
          policy: policies.current(),
          authorIdentity: facts.authorIdentity,
          reviewerIdentity,
        });
        if (decision.allowed) resolver.recordReviewAdmission(attempt.attemptId, decision);
        return decision;
      },
      onTaskAttemptTerminal: (attemptId) => {
        const observation = resolver.reviewObservationForAttempt(attemptId);
        if (observation) ledger.recordReviewObservation(observation);
      },
    });

    try {
      const source = await assets.storeText('PRODUCER SOURCE');
      if ('error' in source) throw new Error(source.error);
      const producerContract = compile(root, {
        inputs: [{
          input_id: 'source', kind: 'contentAsset', asset_id: source.assetId,
          purpose: 'Producer source', required: true, freshness: 'attempt-start',
          provenance: { kind: 'user-turn', source_refs: [] },
        }],
      });
      const producerAttempt = await resolver.beginAttempt(producerContract, candidate('producer', {
        authorizedContentAssetIds: [source.assetId], liveContentAssetIds: [source.assetId],
      }), 'pm');
      resolver.bindAttemptExecutionIdentity(producerAttempt.card!.attemptId, authorIdentity);
      const producerTools = contentTools(root, 'producer', assets);
      producerTools.setTaskInputResolver(resolver);
      producerTools.beginTurn();
      producerTools.setTaskAttempt(producerAttempt.card);
      expect(await producerTools.runText('read_extracted_content', { assetId: source.assetId, pages: { start: 1, end: 1 } }))
        .toContain('PRODUCER SOURCE');
      expect(await producerTools.runText('publish_task_artifact', { content: 'ARTIFACT X' }))
        .toContain('Published immutable artifact');
      const artifact = resolver.artifactsForAttempt(producerAttempt.card!.attemptId)[0];
      expect(resolver.grantsForAttempt(producerAttempt.card!.attemptId)[0].readAt).toEqual(expect.any(String));
      resolver.endAttempt(producerAttempt.card!.attemptId, 'settled');

      manager.create(config('reviewer', 'reviewer'));
      await manager.start('reviewer', { pin: 'take' });
      const backend = backends.get('reviewer')!;
      backend.emit({ kind: 'ready' });
      const promptBeforePolicy = backend.configuredPrompt;
      expect(await policies.setFromHumanPanel(true)).toBe(true);
      expect(policies.changes()).toEqual([expect.objectContaining({ source: 'human-panel', newValue: true })]);
      expect(backend.configuredPrompt).toBe(promptBeforePolicy);

      const roster = [{
        id: 'reviewer', role: 'reviewer', name: 'Reviewer', status: 'idle', workspaceRoot: root,
        capabilities: {
          read: true, write: false, shell: false, verificationSensors: [],
          toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const,
        },
      }];
      const view: TeamView = { list: () => roster, resolve: () => ({ id: 'reviewer' }) };
      const refusedHandles: string[] = [];
      const team = new TeamTools('pm', view, bus, {
        cwd: root,
        timeoutMs: 2_000,
        taskInputResolver: resolver,
        evidenceEnabled: true,
        waitForTaskAdmission: true,
        onDelegationDispatched: (event) => ledger.recordDelegationDispatched(event),
        onDelegationRefused: (event) => {
          if (event.handle) refusedHandles.push(event.handle);
          ledger.recordRefusedDispatch(event);
        },
        onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
      });
      const reviewContract = {
        version: 1,
        objective: 'Review artifact X.',
        expected_deliverable: 'A bounded review.',
        effects: { read_files: [], expected_file_effect: 'none' },
        inputs: [{
          input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: artifact.artifactId,
          purpose: 'Exact review target', required: true, freshness: 'artifact-ready',
          provenance: { kind: 'upstream-artifact', source_refs: [] },
        }],
        constraints: [], dependencies: [artifact.artifactId],
        required_capabilities: { version: 1, capabilities: ['read'] },
        execution_strategy: 'delegate-required',
        review: { input_id: 'artifact' },
      };

      const refused = await team.run('dispatch_task', {
        agent: 'reviewer', instruction: 'Review X through route 2.', contract: reviewContract,
      });
      expect(refused).toMatch(/policy-refused/);
      expect(backend.turns).toEqual([]);
      expect(refusedHandles).toHaveLength(1);
      expect(ledger.inspectTaskStatus('pm', refusedHandles)).toEqual([
        expect.objectContaining({
          lifecycle: 'policy-refused',
          policyId: 'artifact-review-different-reported-model-v1',
          policyReason: expect.stringContaining('same reported model identity'),
        }),
      ]);

      const admitted = await team.run('dispatch_task', {
        agent: 'reviewer', instruction: 'Review X with Smart-selected B.', contract: reviewContract,
      });
      expect(admitted).toContain('Dispatched contract');
      expect(backend.turns).toHaveLength(1);
      expect(backend.turns[0]).toContain('Review X with Smart-selected B.');
      const reviewAttempt = backend.attachments[0]!.taskAttempt!;
      const reviewAssetId = reviewAttempt.grants.find((grant) => grant.inputId === 'artifact')!.resolvedContentAssetId!;
      const reviewerTools = contentTools(root, 'reviewer', assets);
      reviewerTools.setTaskInputResolver(resolver);
      reviewerTools.beginTurn();
      reviewerTools.setTaskAttempt(reviewAttempt);
      expect(await reviewerTools.runText('read_extracted_content', { assetId: reviewAssetId, pages: { start: 1, end: 1 } }))
        .toContain('ARTIFACT X');
      backend.emit({
        kind: 'turn_complete',
        result: {
          text: 'Review complete.', isError: false,
          delegationEvidence: { hadToolActions: true, changedFiles: [], ...reviewerTools.taskAttemptEvidence() },
        },
      });
      await flushAsyncDelivery();
      const admittedHandle = ledger.snapshot().flatMap((run) => run.delegations)
        .find((delegation) => delegation.attemptId === reviewAttempt.attemptId)!.handle;
      expect(await team.run('collect_ready_tasks', { handles: [admittedHandle] })).toContain('Review complete.');
      const runId = ledger.runIdForDelegation(admittedHandle)!;
      expect(ledger.get(runId)?.reviewObservations).toEqual([expect.objectContaining({
        artifactId: artifact.artifactId,
        reviewerAttemptId: reviewAttempt.attemptId,
        sameReportedModel: false,
        policyDecision: 'allowed-different-reported-model',
      })]);
      expect(JSON.stringify(ledger.get(runId)?.reviewObservations))
        .not.toMatch(/reported-a|reported-b|producer-route|smart-review-route|ARTIFACT X|Review complete/);

      expect(await policies.setFromHumanPanel(false)).toBe(true);
      const restored = await team.run('dispatch_task', {
        agent: 'reviewer', instruction: 'Same identity is admitted while policy is off.', contract: reviewContract,
      });
      expect(restored).toContain('Dispatched contract');
      expect(backend.turns.at(-1)).toContain('Same identity is admitted while policy is off.');
      expect(backend.configuredPrompt).toBe(promptBeforePolicy);
      backend.emit({ kind: 'turn_complete', result: { text: 'Off-policy review ran.', isError: false } });
      await flushAsyncDelivery();
      await team.run('collect_ready_tasks', {});
    } finally {
      await manager.stopAll();
      bus.dispose();
      await assets.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/*
 * v0.9.102 (Codex's audit of dc03880f): a delegation queued behind its teammate's other work, past the coordinator's
 * wait. F1: when it starts and finishes, its result reaches the PM under a recorded identity. F2: when its teammate is
 * stopped or removed before it starts, the attempt ends: its grants go and the coordinator's handle is settled.
 * v0.9.103 (G5): a dispatch_task arms no wait timer, so its queued task runs past the old wait with nothing timed out.
 */
describe('v0.9.102 a delegation still queued when its coordinator wait times out', () => {
  /**
   * `busy`: the teammate runs a direct request of the person's, so the assignment waits in its inbox. `slot`: the
   * concurrent-agent limit (1, a supported setting) is taken by the PM, so the stopped teammate's start is queued.
   */
  async function queuedPastTheWait(waitsFor: 'busy' | 'slot' = 'busy') {
    const root = await mkdtemp(join(tmpdir(), 'unode-queued-late-'));
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, root);
    const bus = new MessageBus();
    const ledger = new RunLedger();
    const backends = new Map<string, StubBackend>();
    const manager = new SessionManager(waitsFor === 'slot' ? 1 : 2, bus, {
      createBackend: (agentConfig) => {
        const backend = new StubBackend(agentConfig);
        backends.set(agentConfig.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      // As the extension wires them: the final admission of a task attempt, and the end of a dropped one.
      admitTaskExecution: () => ({ allowed: true, policyId: 'p', code: 'allow' }),
      endTaskAttempt: (attemptId) => resolver.endAttempt(attemptId, 'cancelled'),
    });
    manager.create(config('pm', 'pm'));
    manager.create(config('worker', 'developer'));
    await manager.start('pm', { pin: 'take' });
    backends.get('pm')!.emit({ kind: 'ready' });
    if (waitsFor === 'busy') {
      await manager.start('worker', { pin: 'take' });
      backends.get('worker')!.emit({ kind: 'ready' });
    }
    const view: TeamView = {
      list: () => [
        { id: 'pm', role: 'pm', name: 'PM', status: manager.get('pm')?.status ?? 'stopped' },
        {
          id: 'worker', role: 'developer', name: 'Worker', status: manager.get('worker')?.status ?? 'stopped', workspaceRoot: root,
          capabilities: {
            read: true, write: false, shell: false, verificationSensors: [],
            toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const,
          },
        },
      ],
      resolve: (ref) => ref === 'worker' ? { id: 'worker' } : undefined,
      // As the orchestration host wires it: the session's own view of a task's execution (queued in its inbox).
      execution: (agentId, handle) => manager.delegationExecution(agentId, handle),
    };
    const recorded: string[] = [];
    let team!: TeamTools;
    team = new TeamTools('pm', view, bus, {
      cwd: root,
      timeoutMs: 50,
      taskInputResolver: resolver,
      evidenceEnabled: true,
      waitForTaskAdmission: true,
      onDelegationDispatched: (event) => {
        recorded.push(event.handle);
        ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'queued-late' });
      },
      onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
      onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
      resultRevisionFor: (handle) => ledger.resultIdentity('pm', handle)?.ref.revision,
      // As production requires: a result is delivered only under the identity its recorded dispatch reserved.
      isAsyncResultEligible: (handle, revision) => revision !== undefined && ledger.resultIdentity('pm', handle)?.ref.revision === revision,
      onAsyncResultReady: (result) => manager.queueAsyncDelegationWake(
        'pm', result, () => team.isAsyncResultReady(result.handle), () => team.consumeAsyncResult(result.handle),
      ),
      inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (message: Message) => { if (message.to === 'worker' && message.from === 'pm') assignment = message; });

    if (waitsFor === 'busy') {
      // The teammate is busy with a direct request of the person's when the PM assigns it work.
      bus.send('user', 'worker', 'task.assign', { instruction: 'Earlier direct work.' }, 'normal');
      await flushAsyncDelivery();
      expect(backends.get('worker')!.turns).toEqual([expect.stringContaining('Earlier direct work.')]);
    }
    const out = await team.run('dispatch_task', {
      agent: 'worker', instruction: 'Write the queued report.', contract: {
        version: 1, objective: 'Write the queued report.', expected_deliverable: 'The report.',
        effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
        required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
      },
    });
    const handle = out.match(/Handle: ([0-9a-f-]+)/i)![1];
    const attemptId = assignment!.payload.taskAttempt!.attemptId;
    // Past the coordinator's old wait while the assignment is still queued. v0.9.103 (G5): nothing times out.
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(recorded).toEqual([]);
    if (waitsFor === 'busy') expect(backends.get('worker')!.turns).toHaveLength(1);
    else expect(manager.get('worker')).toMatchObject({ status: 'stopped', pendingStart: true });
    expect(resolver.isAttemptLive(attemptId, 'worker')).toBe(true);
    expect(await team.run('inspect_task_status', { handles: [handle] })).not.toContain('timed-out');
    const cleanup = async () => {
      team.cancelPending('test cleanup');
      await manager.stopAll();
      bus.dispose();
      await assets.dispose();
      await rm(root, { recursive: true, force: true });
    };
    return { bus, manager, backends, team, resolver, ledger, recorded, handle, attemptId, cleanup };
  }

  it('records a task admitted after the wait, and its finished result wakes the PM', async () => {
    const h = await queuedPastTheWait();
    try {
      const worker = h.backends.get('worker')!;
      worker.emit({ kind: 'turn_complete', result: { text: 'Earlier done.', isError: false, responseOutcome: { kind: 'reply' } } });
      await flushAsyncDelivery();
      // The queued task starts now: its admission records the delegation and reserves its result.
      expect(worker.turns).toHaveLength(2);
      expect(worker.turns[1]).toContain('Write the queued report.');
      expect(h.recorded).toEqual([h.handle]);
      worker.emit({ kind: 'turn_complete', result: { text: 'The queued report.', isError: false, responseOutcome: { kind: 'reply' } } });
      await flushAsyncDelivery();
      await flushAsyncDelivery();
      const pmTurns = h.backends.get('pm')!.turns;
      expect(pmTurns, JSON.stringify(pmTurns)).toHaveLength(1);
      expect(pmTurns[0]).toContain('The queued report.');
      expect(h.ledger.inspectTaskStatus('pm', [h.handle])[0]).toMatchObject({ lifecycle: 'settled' });
      expect(h.resolver.isAttemptLive(h.attemptId, 'worker')).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  // v0.9.103 (field smoke of d71485c5, item 8): the task waiting in its teammate's inbox has no ledger record until its
  // admission; the ledger's unknown row made inspect_task_status say "state: unknown" for it.
  it('the queued task reads queued by its handle, and can be the replacement of a superseded task', async () => {
    const h = await queuedPastTheWait();
    try {
      const status = await h.team.run('inspect_task_status', { handles: [h.handle] });
      expect(status).toContain(`handle ${h.handle} · worker\nstate: queued (it waits for worker to finish its other work, and starts automatically)\n`);
      expect(status).toContain('execution state: queued');
      expect(status).not.toMatch(/state: unknown/);
      expect(status).toContain('next action: end this turn; the host will wake the coordinator when a result arrives');
      // An unrelated handle still reads unknown.
      expect(await h.team.run('inspect_task_status', { handles: ['invented-handle'] })).toMatch(/^handle invented-handle · state: unknown\n/);

      // A recorded task, interrupted, replaced by the queued one.
      h.ledger.recordDelegationDispatched({
        coordinatorId: 'pm', handle: 'lost-q', requestedAgent: 'worker', agentId: 'worker', instruction: 'Write it.', originCorrelationId: 'root-lost-q',
      });
      h.ledger.reconcileRestoredActiveDelegations('2026-11-14T12:00:00.000Z');
      expect(await h.team.run('record_task_disposition', {
        handle: 'lost-q', disposition: 'superseded', reason: 'Redone after the interruption.', replacement_handle: h.handle,
      })).toMatch(new RegExp(`^Recorded lost-q as superseded: .*Replacement ${h.handle} was host-dispatched to worker`));

      // Cancelled before it started: it reads so, and replaces nothing.
      expect(await h.team.run('cancel_task', { handle: h.handle })).not.toMatch(/^Error/);
      expect(await h.team.run('inspect_task_status', { handles: [h.handle] })).toContain(`handle ${h.handle} · worker\nstate: cancelled before it started`);
      h.ledger.recordDelegationDispatched({
        coordinatorId: 'pm', handle: 'lost-r', requestedAgent: 'worker', agentId: 'worker', instruction: 'Write it.', originCorrelationId: 'root-lost-r',
      });
      h.ledger.reconcileRestoredActiveDelegations('2026-11-14T12:00:00.000Z');
      expect(await h.team.run('record_task_disposition', {
        handle: 'lost-r', disposition: 'superseded', reason: 'Redone after the interruption.', replacement_handle: h.handle,
      })).toMatch(/^Error: superseded replacement_handle must identify a different host-observed dispatch_task/);
    } finally {
      await h.cleanup();
    }
  });

  it.each(['stopped', 'removed'] as const)('ends a queued task whose teammate is %s before it starts: its grants and the PM\'s handle', async (end) => {
    const h = await queuedPastTheWait();
    try {
      if (end === 'stopped') await h.manager.stop('worker');
      else await h.manager.remove('worker');
      await flushAsyncDelivery();
      expect(h.resolver.isAttemptLive(h.attemptId, 'worker')).toBe(false);
      const status = await h.team.run('inspect_task_status', { handles: [h.handle] });
      // v0.9.103 (G5): cancelled with no wait ever timed out. v0.9.103 (F1): a removal is the host's stop, so its task is
      // interrupted and can be replaced; the person's Stop still cancels it.
      expect(status).toContain(end === 'stopped' ? 'wait state: cancelled-before-timeout' : 'wait state: interrupted');
      expect(status).not.toContain('timed-out');
      // The coordinator no longer owns a live attempt for it.
      expect(h.team.cancelPending('after the end')).toBe(0);
      expect(h.backends.get('pm')!.turns).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  // Codex's audit of c6424931, finding 1: a task waiting for a free slot whose teammate then fails to start has ended
  // without admission, so the ledger has no row; it must not read as still waiting to start.
  it('a queued task whose teammate fails to start reads ended before it started, and replaces nothing', async () => {
    StubBackend.failStartFor.add('worker');
    const h = await queuedPastTheWait('slot');
    try {
      // The PM's slot frees: the teammate's queued start runs and fails.
      await h.manager.stop('pm');
      await flushAsyncDelivery();
      await flushAsyncDelivery();
      expect(h.backends.get('worker')!.turns).toEqual([]);
      expect(h.recorded).toEqual([]);
      const status = await h.team.run('inspect_task_status', { handles: [h.handle] });
      expect(status).toContain(`handle ${h.handle} · worker\nstate: ended before it started (worker did not take it up; the error it `
        + 'reported says why). Dispatch it again once that is fixed.\n');
      expect(status).toContain('execution state: ended');
      expect(status).not.toContain('not started yet');
      expect(status).not.toContain('state: queued');
      h.ledger.recordDelegationDispatched({
        coordinatorId: 'pm', handle: 'lost-s', requestedAgent: 'worker', agentId: 'worker', instruction: 'Write it.', originCorrelationId: 'root-lost-s',
      });
      h.ledger.reconcileRestoredActiveDelegations('2026-11-14T12:00:00.000Z');
      expect(await h.team.run('record_task_disposition', {
        handle: 'lost-s', disposition: 'superseded', reason: 'Redone after the interruption.', replacement_handle: h.handle,
      })).toMatch(/^Error: superseded replacement_handle must identify a different host-observed dispatch_task/);
    } finally {
      StubBackend.failStartFor.clear();
      await h.cleanup();
    }
  });

  // Codex's audit of 3b403007 (F2): Stop of a teammate still waiting for a free slot never reached the queue cleanup.
  it('ends a queued task whose teammate is stopped while it waits for a free slot, and keeps the person\'s own message', async () => {
    const h = await queuedPastTheWait('slot');
    try {
      // A message of the person's waits in the same queue; Stop leaves it, as before.
      h.bus.send('user', 'worker', 'task.assign', { instruction: 'My own request.', delegationContentSources: [] }, 'normal');
      await flushAsyncDelivery();
      await h.manager.stop('worker');
      await flushAsyncDelivery();
      expect(h.resolver.isAttemptLive(h.attemptId, 'worker')).toBe(false);
      expect(await h.team.run('inspect_task_status', { handles: [h.handle] })).toContain('wait state: cancelled-before-timeout');
      expect(h.team.cancelPending('after the stop')).toBe(0);
      // Started later, the teammate never runs the stopped task; the person's message is still there.
      await h.manager.stop('pm');
      await h.manager.start('worker', { pin: 'take' });
      h.backends.get('worker')!.emit({ kind: 'ready' });
      await flushAsyncDelivery();
      const turns = h.backends.get('worker')!.turns;
      expect(turns.join('\n')).not.toContain('Write the queued report.');
      expect(turns.join('\n')).toContain('My own request.');
    } finally {
      await h.cleanup();
    }
  });
});
