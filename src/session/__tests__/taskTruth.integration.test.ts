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
  }

  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  async start(): Promise<void> { this.alive = true; }
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
      await manager.start('pm');
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
      await manager.start('reviewer');
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
