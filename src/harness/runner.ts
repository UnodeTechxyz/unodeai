/**
 * Deterministic v0.9.37 Harness Lab runner.
 *
 * Tier 1 deliberately exercises the host mechanics with a scripted backend, not a model. Each invocation
 * receives a fresh copied fixture and SessionManager/MessageBus pair, so concurrent runs cannot share a
 * workspace, backend state, or Vitest cache directory. This module imports no vscode APIs.
 */

import { spawn } from 'child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { MessageBus } from '../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendEventHandler, DelegationTurnEvidence, TurnAttachments, TurnResult } from '../backend/AgentBackend';
import { FetchFn, OpenAICompatBackend } from '../backend/OpenAICompatBackend';
import { CommandPolicy } from '../backend/CommandPolicy';
import { TeamTools } from '../backend/TeamTools';
import { TaskInputResolver } from '../backend/TaskContract';
import { WorkspaceTools } from '../backend/WorkspaceTools';
import { ContentAssetStore } from '../content/ContentAssetStore';
import { resolveInsideRootPhysical } from '../backend/workspacePath';
import { AgentConfig } from '../types';
import { RulesFile, rulesFilePath } from '../session/RulesFile';
import { SessionManager } from '../session/SessionManager';
import { HARNESS_TASK_SET, HarnessTaskDefinition, ScriptedBackendStep, TaskId, TASK_SET_PREDICTIONS, TaskSetPrediction } from './taskSet';
import {
  SensorVerdict,
  sensorB1,
  sensorB2,
  sensorB3,
  sensorB4,
  sensorC1,
  sensorC2,
  sensorC3,
  sensorD1,
  sensorE1,
  sensorE2,
  sensorF1,
  sensorF2,
  sensorP1,
} from './sensors';
import { assertHarnessLabConfiguration, HarnessLabConfiguration } from './labConfiguration';

export type Tier1RunOutcome = 'passed' | 'failed' | 'crashed' | 'invalid';
export type Tier1ObservationSource = 'measured' | 'scripted';

export interface Tier1RunMetrics {
  readonly verifiedCompletion: boolean;
  /** Headless Tier 1 has no human loop; retain the field for compatible future evidence. */
  readonly humanInterventions: 0;
  /** Tier 1 never opens a human approval surface; keep these explicit for the shared Lab metric shape. */
  readonly approvalWaitMs: 0;
  readonly approvalDenials: 0;
  readonly stalledOrNoop: boolean;
  readonly toolErrors: number;
  readonly retries: number;
  readonly wallClockMs: number;
  /** Tier 1 is scripted/offline by definition. */
  readonly costUsd: 0;
  readonly unauthorizedEffectAttempts: number;
  /** Present only for measured coordinator-delegation scenarios. A model call is not inferred from it. */
  readonly coordinatorTurnOverhead?: CoordinatorTurnOverhead;
}

/** Measured PM-turn cost of retaining results until a later, non-interleaving coordinator turn. */
export interface CoordinatorTurnOverhead {
  readonly foregroundTurns: number;
  readonly followupTurns: number;
  readonly dependencyCount: number;
  readonly extraPmTurnsPerDependency: number;
}

export interface Tier1RunRecord {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly tier: 1;
  readonly fixture: string;
  readonly outcome: Tier1RunOutcome;
  readonly sensor?: SensorVerdict;
  readonly prediction?: {
    readonly prediction: TaskSetPrediction['prediction'];
    readonly expectedStatus: TaskSetPrediction['status'];
    /** A pre-run prediction is only checked once this invocation obtained a real product observation. */
    readonly checked: boolean;
  };
  /** Whether the sensor input came from real product code or the corpus's controlled scripted event. */
  readonly observationSource: Tier1ObservationSource;
  /** Narrowing note when only part of a multi-fact sensor is measured in this release. */
  readonly observationDetail?: string;
  /** Present when the fixture starts an offline command. Started and exit code are deliberately separate facts. */
  readonly commandExecution?: {
    readonly command: string;
    readonly started: true;
    readonly exitCode: number;
  };
  readonly isolation: {
    readonly workspace: 'fresh-temporary';
    readonly vitestCacheDir: '.vitest-cache';
    readonly sessionManager: true;
  };
  readonly metrics: Tier1RunMetrics;
  /** Errors are retained only for crashed/invalid runner outcomes; no source or model text is recorded. */
  readonly error?: string;
}

export interface Tier1RunOptions {
  /** Test seam for an invalid-fixture assertion. Normal CLI use leaves this at the repository root. */
  readonly repoRoot?: string;
  /** An explicit A/B arm. Tier 1 applies only commandAllowlist to its product probe. */
  readonly configuration?: HarnessLabConfiguration;
}

export interface Tier1LabSummary {
  readonly schemaVersion: 1;
  readonly type: 'summary';
  readonly total: number;
  readonly observationSources: Record<Tier1ObservationSource, number>;
  readonly outcomes: Record<Tier1RunOutcome, number>;
}

interface Tier1Evaluation {
  readonly sensor: SensorVerdict;
  readonly observationSource: Tier1ObservationSource;
  readonly observationDetail?: string;
  /** B3's coordinator-claim half is deliberately controlled, not a real-model observation. */
  readonly predictionChecked?: boolean;
  readonly commandExecution?: Tier1RunRecord['commandExecution'];
  readonly coordinatorTurnOverhead?: CoordinatorTurnOverhead;
}

/** Minimal backend that turns the v0.9.36 script into visible framework events. */
class ScriptedBackend implements AgentBackend {
  readonly pid = undefined;
  private handler: BackendEventHandler | undefined;
  private alive = false;
  private completed!: () => void;
  private readonly complete = new Promise<void>((resolve) => { this.completed = resolve; });

  constructor(readonly agentId: string, private readonly steps: readonly ScriptedBackendStep[]) {}

  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  async start(): Promise<void> {
    this.alive = true;
    this.emit({ kind: 'ready', model: 'scripted-tier-1' });
  }

  sendUserTurn(_instruction: string, _attachments?: TurnAttachments): void {
    for (const step of this.steps) {
      if (step.event === 'tool_call') {
        this.emit({ kind: 'tool_use', name: 'scripted', input: { turn: step.turn, detail: step.detail } });
      } else if (step.event === 'assistant_text' || step.event === 'delegation_result' || step.event === 'gateway_response') {
        this.emit({ kind: 'assistant', text: step.detail });
      }
    }
    this.emit({
      kind: 'turn_complete',
      result: {
        text: 'scripted tier-1 turn complete',
        isError: false,
        delegationEvidence: { hadToolActions: this.steps.some((step) => step.event === 'tool_call'), changedFiles: [] },
      },
    });
    this.completed();
  }

  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }

  isAlive(): boolean {
    return this.alive;
  }

  waitForCompletion(): Promise<void> {
    return this.complete;
  }

  private emit(event: BackendEvent): void {
    this.handler?.(event);
  }
}

/**
 * A controlled backend used only to drive the real delegation framework in B1/B2/B3/B4. It does not
 * decide an outcome: the scenario completes its turns at deliberately chosen lifecycle boundaries.
 */
class DelegationHarnessBackend implements AgentBackend {
  readonly pid = undefined;
  readonly receivedTurns: string[] = [];
  private handler: BackendEventHandler | undefined;
  private alive = false;

  constructor(readonly agentId: string) {}

  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  async start(): Promise<void> {
    this.alive = true;
    this.emit({ kind: 'ready', model: 'controlled-delegation-harness' });
  }

  sendUserTurn(instruction: string, _attachments?: TurnAttachments): void {
    this.receivedTurns.push(instruction);
  }

  complete(text: string, evidence?: DelegationTurnEvidence, isError = false): void {
    this.emit({ kind: 'turn_complete', result: { text, isError, delegationEvidence: evidence } satisfies TurnResult });
  }

  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }

  isAlive(): boolean {
    return this.alive;
  }

  private emit(event: BackendEvent): void {
    this.handler?.(event);
  }
}

/** Execute exactly one Tier 1 task in an isolated temporary fixture workspace. */
export async function runTier1Task(taskId: TaskId, options: Tier1RunOptions = {}): Promise<Tier1RunRecord> {
  const task = findTier1Task(taskId);
  const started = Date.now();
  let workspace: string | undefined;
  try {
    if (options.configuration) {
      assertHarnessLabConfiguration(options.configuration);
    }
    const repoRoot = options.repoRoot ?? process.cwd();
    const sourceFixture = path.resolve(repoRoot, task.fixture);
    workspace = await mkdtemp(path.join(tmpdir(), `unode-lab-${task.id.toLowerCase()}-`));
    await cp(sourceFixture, workspace, { recursive: true, errorOnExist: true });
    await assertFixturePreconditions(workspace);
    // The runner supplies this task-local cache root to every fixture command. The root config uses the
    // same per-process isolation for human gate runs.
    const cacheDir = path.join(workspace, '.vitest-cache');
    await mkdir(cacheDir, { recursive: true });
    await cp(path.join(workspace, 'task.md'), path.join(cacheDir, 'task.md'), { force: true, errorOnExist: false });

    const evaluation = task.id === 'P1'
      ? await driveP1DialectTask(workspace, options.configuration)
      : task.id === 'E1'
      ? await driveE1GatewayShapeTask(task, workspace)
      : task.id === 'E2'
      ? await driveE2GatewayShapeTask(task, workspace)
      : isMeasuredDelegationTask(task.id)
      ? await driveDelegationTask(task, workspace)
      : (await driveWithSessionManager(task, workspace), await evaluateTaskSensor(task, workspace, cacheDir, options.configuration));
    return record(task, evaluation.sensor.passed ? 'passed' : 'failed', evaluation, started);
  } catch (error) {
    const message = errorMessage(error);
    const invalid = /fixture precondition|ENOENT|no such file/i.test(message);
    return record(task, invalid ? 'invalid' : 'crashed', undefined, started, message);
  } finally {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

/** Run the complete deterministic set. Callers may safely invoke this concurrently. */
export async function runTier1Tasks(options: Tier1RunOptions = {}): Promise<Tier1RunRecord[]> {
  // P1 is a comparison-only mechanism probe. A single unconfigured Lab run has no opposing arm and
  // therefore must not claim a dialect result.
  return Promise.all(HARNESS_TASK_SET.filter((task) => task.tier === 1 && task.id !== 'P1').map((task) => runTier1Task(task.id, options)));
}

/** Machine-readable aggregate for the CLI; retain individual records as the release evidence. */
export function summarizeTier1Runs(records: readonly Tier1RunRecord[]): Tier1LabSummary {
  const observationSources: Record<Tier1ObservationSource, number> = { measured: 0, scripted: 0 };
  const outcomes: Record<Tier1RunOutcome, number> = { passed: 0, failed: 0, crashed: 0, invalid: 0 };
  for (const record of records) {
    observationSources[record.observationSource]++;
    outcomes[record.outcome]++;
  }
  return { schemaVersion: 1, type: 'summary', total: records.length, observationSources, outcomes };
}

function findTier1Task(taskId: TaskId): HarnessTaskDefinition & { tier: 1 } {
  const task = HARNESS_TASK_SET.find((candidate) => candidate.id === taskId && candidate.tier === 1);
  if (!task) {
    throw new Error(`Task ${taskId} is not a Tier 1 Harness Lab task.`);
  }
  return task as HarnessTaskDefinition & { tier: 1 };
}

/**
 * P1 is a controlled tool-surface experiment, not a model-quality claim. Both arms receive the exact
 * same patch-shaped task; only the capability-profile-selected advertised dialect differs, so the arms
 * can genuinely produce different product outcomes without spending a Tier 2 route.
 */
async function driveP1DialectTask(workspace: string, configuration?: HarnessLabConfiguration): Promise<Tier1Evaluation> {
  const implementation = configuration?.implementation ?? 'apply-edit';
  const tools = new WorkspaceTools(workspace, new Set(['read', 'write']), 'lab-p1');
  tools.setEditToolDialect(implementation);
  const applyPatchAdvertised = tools.specs().some((spec) => spec.function.name === 'apply_patch');
  if (applyPatchAdvertised) {
    await tools.run('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-old value\n+new value\n*** End Patch',
    });
  }
  const fixtureChanged = (await readFile(path.join(workspace, 'README.md'), 'utf8')) === 'new value\n';
  return measured(sensorP1({ applyPatchAdvertised, fixtureChanged }));
}

async function assertFixturePreconditions(workspace: string): Promise<void> {
  try {
    await readFile(path.join(workspace, 'task.md'), 'utf8');
  } catch {
    throw new Error('fixture precondition unmet: task.md is missing.');
  }
}

async function driveWithSessionManager(task: HarnessTaskDefinition, workspace: string): Promise<void> {
  const bus = new MessageBus();
  let backend: ScriptedBackend | undefined;
  const manager = new SessionManager(1, bus, {
    createBackend: (config) => {
      backend = new ScriptedBackend(config.id, task.scriptedBackend ?? []);
      return backend;
    },
    resolveEnv: async () => ({}),
  });
  const config: AgentConfig = {
    id: `lab-${task.id.toLowerCase()}`,
    name: `Lab ${task.id}`,
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'scripted-tier-1',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
    workingDirectory: workspace,
  };
  manager.create(config);
  try {
    await manager.start(config.id);
    if (!backend) {
      throw new Error('runner crashed: SessionManager did not construct its scripted backend.');
    }
    bus.send('user', config.id, 'ask.question', { instruction: task.objective });
    await backend.waitForCompletion();
  } finally {
    await manager.remove(config.id);
    // MessageBus owns a housekeeping interval. Extension activation keeps it for the process lifetime;
    // a one-shot Lab invocation must dispose it or `npm run lab` never returns after emitting its records.
    bus.dispose();
  }
}

/**
 * E1's injected gateway-shaped mock drives the product's sampling-parameter recovery through a full
 * SessionManager turn. It starts no listener, uses no credential, and records only request shapes.
 */
async function driveE1GatewayShapeTask(
  task: HarnessTaskDefinition & { tier: 1 },
  workspace: string,
): Promise<Tier1Evaluation> {
  const firstResponse = JSON.parse(await readFile(path.join(workspace, 'gateway-response.json'), 'utf8')) as { status?: number; error?: string };
  const firstStatus = firstResponse.status ?? 0;
  const requests: Array<Record<string, unknown>> = [];
  const statuses: number[] = [];
  let responseIndex = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    if (responseIndex++ === 0) {
      statuses.push(firstStatus);
      return { ok: false, status: firstStatus, text: async () => JSON.stringify(firstResponse) };
    }
    statuses.push(200);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The sampling recovery completed.' } }] }),
    };
  };
  const bus = new MessageBus();
  let backend: OpenAICompatBackend | undefined;
  const manager = new SessionManager(1, bus, {
    createBackend: (config) => {
      backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, {
        retryBaseMs: 0,
      });
      return backend;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'lab-e1-no-network' }),
    resolveModelParams: (config) => config.modelParams ?? {},
  });
  const config: AgentConfig = {
    id: 'lab-e1-gateway-shape',
    name: 'Lab E1 gateway shape',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'lab-sampling-recovery',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
    modelParams: { temperature: 0.7, top_p: 0.9 },
    workingDirectory: workspace,
  };
  manager.create(config);
  const events: BackendEvent[] = [];
  try {
    await manager.start(config.id);
    if (!backend) throw new Error('runner crashed: SessionManager did not construct the E1 backend.');
    const complete = new Promise<void>((resolve) => {
      const off = backend!.onEvent((event) => {
        events.push(event);
        if (event.kind === 'turn_complete') {
          off();
          resolve();
        }
      });
    });
    bus.send('user', config.id, 'ask.question', { instruction: task.objective });
    await complete;
    const turnCompleted = events.some((event) => event.kind === 'turn_complete' && event.result.isError !== true);
    const retryRequest = requests[1];
    const recovered = retryRequest !== undefined
      && retryRequest.temperature === undefined
      && retryRequest.top_p === undefined
      && events.some((event) => event.kind === 'log' && event.line.includes('sampling parameters'));
    return measured(
      sensorE1({
        initialResponseStatus: statuses[0] ?? 0,
        recovered,
        turnCompleted,
        retryCount: Math.max(0, requests.length - 1),
      }),
      undefined,
      'Measured through OpenAICompatBackend with an injected gateway-shaped 400 followed by a successful retry. The recorded request shapes prove that the retry omitted temperature and top_p; no listener, credential, or network request was used.',
    );
  } finally {
    await manager.remove(config.id);
    bus.dispose();
  }
}

/**
 * E2's injected gateway-shaped mock drives the actual OpenAI-compatible backend through a full
 * SessionManager turn. It starts no listener, uses no credentials, and records only request shapes.
 */
async function driveE2GatewayShapeTask(
  task: HarnessTaskDefinition & { tier: 1 },
  workspace: string,
): Promise<Tier1Evaluation> {
  const nativeLeakResponse = await readFile(path.join(workspace, 'native-response.txt'), 'utf8');
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    { choices: [{ message: { role: 'assistant', content: nativeLeakResponse } }] },
    { choices: [{ message: { role: 'assistant', content: 'The recovered native-loop turn completed.' } }] },
    { choices: [{ message: { role: 'assistant', content: 'The next session turn completed under XML.' } }] },
  ];
  let responseIndex = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const body = responses[Math.min(responseIndex++, responses.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const bus = new MessageBus();
  let backend: OpenAICompatBackend | undefined;
  const manager = new SessionManager(1, bus, {
    createBackend: (config) => {
      backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, {
        retryBaseMs: 0,
      });
      return backend;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'lab-e2-no-network' }),
  });
  const config: AgentConfig = {
    id: 'lab-e2-gateway-shape',
    name: 'Lab E2 gateway shape',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'kimi-k2-lab',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: ['read'],
    workingDirectory: workspace,
  };
  manager.create(config);
  const events: BackendEvent[] = [];
  try {
    await manager.start(config.id);
    if (!backend) throw new Error('runner crashed: SessionManager did not construct the E2 backend.');
    let completedTurns = 0;
    const waitForTurnCompletion = () => new Promise<void>((resolve) => {
      const target = completedTurns + 1;
      const poll = () => completedTurns >= target ? resolve() : setTimeout(poll, 1);
      poll();
    });
    backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'turn_complete') completedTurns++;
    });
    const firstTurn = waitForTurnCompletion();
    bus.send('user', config.id, 'ask.question', { instruction: task.objective });
    await firstTurn;
    const requestCountBeforeSessionRetry = requests.length;
    const sessionRetry = waitForTurnCompletion();
    bus.send('user', config.id, 'ask.question', { instruction: 'Continue after the recovered tool call.' });
    await sessionRetry;
    const nativeToolCallAppearedAsText = events.some((event) =>
      event.kind === 'log' && event.line.includes('native tool call leaked into content'));
    const protocolForRemainingTurns = requests.slice(requestCountBeforeSessionRetry).map((request) =>
      request.tools === undefined
        && Array.isArray(request.messages)
        && request.messages.some((message) => message && typeof message === 'object'
          && (message as { role?: unknown }).role === 'system'
          && String((message as { content?: unknown }).content ?? '').includes('XML tool calling protocol'))
        ? 'xml'
        : 'native');
    return measured(
      sensorE2({ nativeToolCallAppearedAsText, visibleRetryCount: requests.length - requestCountBeforeSessionRetry, protocolForRemainingTurns }),
      undefined,
      'Measured through OpenAICompatBackend with an injected gateway-shaped fetch mock; the XML latch is observed on the next session turn, preserving the existing product timing. No listener, credential, or network request was used.',
    );
  } finally {
    await manager.remove(config.id);
    bus.dispose();
  }
}

/** Run B1/B2/B3/B4 through TeamTools, MessageBus, and SessionManager rather than replaying a fixture event. */
async function driveDelegationTask(task: HarnessTaskDefinition & { tier: 1 }, workspace: string): Promise<Tier1Evaluation> {
  const bus = new MessageBus();
  const manager = new SessionManager(3, bus, {
    createBackend: (config) => {
      const backend = new DelegationHarnessBackend(config.id);
      backends.set(config.id, backend);
      return backend;
    },
    resolveEnv: async () => ({}),
  });
  const backends = new Map<string, DelegationHarnessBackend>();
  const pmId = 'lab-pm';
  const workerIds = task.id === 'B3' ? ['lab-worker-verified', 'lab-worker-failed'] : ['lab-worker'];
  const configs = [delegationAgentConfig(pmId, 'pm', workspace), ...workerIds.map((id) => delegationAgentConfig(id, 'senior-dev', workspace))];
  const wakeAccepted: boolean[] = [];
  const retainedResults: Array<{ handle: string; ref: string; text: string }> = [];
  const team: TeamTools = new TeamTools(pmId, {
    list: () => manager.getAll().map((session) => ({
      id: session.id,
      name: session.config.name,
      role: session.config.role,
      status: session.status,
    })),
    resolve: (ref) => manager.get(ref) ? { id: ref } : undefined,
  }, bus, {
    // Short by design: B1 has to release the coordinator before the teammate replies.
    timeoutMs: 75,
    evidenceEnabled: true,
    taskInputResolver: new TaskInputResolver(new ContentAssetStore(), workspace),
    onAsyncResultReady: (result) => {
      wakeAccepted.push(manager.queueAsyncDelegationWake(
        pmId,
        result,
        () => team.isAsyncResultReady(result.handle),
        () => team.consumeAsyncResult(result.handle),
      ));
    },
    onAsyncResultRetained: (result) => retainedResults.push(result),
  });

  for (const config of configs) {
    manager.create(config);
  }
  try {
    for (const config of configs) {
      await manager.start(config.id);
    }
    const pm = requireDelegationBackend(backends, pmId);
    bus.send('user', pmId, 'ask.question', { instruction: task.objective });
    await waitFor(() => pm.receivedTurns.length === 1, 'coordinator foreground turn did not start');

    switch (task.id) {
      case 'B1':
        return await driveB1(team, pm, requireDelegationBackend(backends, workerIds[0]), wakeAccepted);
      case 'B2':
        return await driveB2(team, pm, requireDelegationBackend(backends, workerIds[0]), wakeAccepted);
      case 'B3':
        return await driveB3(
          team,
          pm,
          requireDelegationBackend(backends, workerIds[0]),
          requireDelegationBackend(backends, workerIds[1]),
          wakeAccepted,
        );
      case 'B4':
        return await driveB4(team, requireDelegationBackend(backends, workerIds[0]), retainedResults);
      default:
        throw new Error(`Task ${task.id} is not a measured delegation scenario.`);
    }
  } finally {
    await Promise.all(configs.map((config) => manager.remove(config.id)));
    bus.dispose();
  }
}

/** Tier 1 exercises the current model-visible contract path without deriving authority from fixture prose. */
function harnessTaskContract(objective: string): Record<string, unknown> {
  return {
    version: 1,
    objective,
    expected_deliverable: 'Return the concrete review result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
  };
}

async function driveB1(
  team: TeamTools,
  pm: DelegationHarnessBackend,
  worker: DelegationHarnessBackend,
  wakeAccepted: boolean[],
): Promise<Tier1Evaluation> {
  const blocking = team.run('assign_task', { agent: worker.agentId, instruction: 'Make the requested change.' });
  await waitFor(() => worker.receivedTurns.length === 1, 'B1 worker did not receive the blocking delegation');
  const timeoutReply = await blocking;
  if (!/^Error: timed out/i.test(timeoutReply)) {
    throw new Error(`B1 expected the injected blocking timeout, received: ${timeoutReply}`);
  }
  worker.complete('Changed src/example.ts; checks were not run.', {
    hadToolActions: true,
    changedFiles: ['src/example.ts'],
    verification: { ran: false, passed: false },
  });
  await waitFor(() => wakeAccepted.length === 1, 'B1 late result was not queued for the coordinator');
  pm.complete('The blocking delegation timed out; wait for the retained result.', undefined, false);
  await waitFor(() => pm.receivedTurns.length === 2, 'B1 coordinator was not woken for the late result');
  const wake = pm.receivedTurns[1];
  return measured(sensorB1({
    coordinatorWoken: true,
    originalEvidenceVerdict: 'replied-not-verified',
    receivedEvidenceVerdict: wake.includes('[delegation: replied-not-verified]') ? 'replied-not-verified' : 'no-evidence',
  }), undefined, undefined, undefined, coordinatorTurnOverhead(pm, 1));
}

async function driveB2(
  team: TeamTools,
  pm: DelegationHarnessBackend,
  worker: DelegationHarnessBackend,
  wakeAccepted: boolean[],
): Promise<Tier1Evaluation> {
  const handle = await team.run('dispatch_task', {
    agent: worker.agentId,
    instruction: 'Review the current implementation.',
    contract: harnessTaskContract('Review the current implementation.'),
  });
  if (/^Error:/i.test(handle)) {
    throw new Error(`B2 async delegation failed to dispatch: ${handle}`);
  }
  await waitFor(() => worker.receivedTurns.length === 1, 'B2 worker did not receive the async delegation');
  worker.complete('Reviewed the implementation; no changes required.', {
    hadToolActions: true,
    changedFiles: [],
    verification: { ran: false, passed: false },
  });
  await waitFor(() => wakeAccepted.length === 1, 'B2 result did not settle while the coordinator was busy');
  const retainedWhileBusy = wakeAccepted[0] === true && pm.receivedTurns.length === 1;
  pm.complete('Finish the foreground task before handling async results.', undefined, false);
  await waitFor(() => pm.receivedTurns.length === 2, 'B2 retained result was not re-offered once the coordinator became idle');
  const wake = pm.receivedTurns[1];
  return measured(sensorB2({
    retainedWhileCoordinatorBusy: retainedWhileBusy,
    reofferedWhenCoordinatorIdle: wake.includes('[delegation: tool-activity-recorded]'),
    resultDropped: !wake.includes('[delegation: tool-activity-recorded]'),
  }), undefined, undefined, undefined, coordinatorTurnOverhead(pm, 1));
}

async function driveB3(
  team: TeamTools,
  pm: DelegationHarnessBackend,
  verifiedWorker: DelegationHarnessBackend,
  failedWorker: DelegationHarnessBackend,
  wakeAccepted: boolean[],
): Promise<Tier1Evaluation> {
  const [verifiedHandle, failedHandle] = await Promise.all([
    team.run('dispatch_task', {
      agent: verifiedWorker.agentId,
      instruction: 'Review the implementation.',
      contract: harnessTaskContract('Review the implementation.'),
    }),
    team.run('dispatch_task', {
      agent: failedWorker.agentId,
      instruction: 'Review the deployment plan.',
      contract: harnessTaskContract('Review the deployment plan.'),
    }),
  ]);
  if (/^Error:/i.test(verifiedHandle) || /^Error:/i.test(failedHandle)) {
    throw new Error(`B3 parallel delegations failed to dispatch: ${verifiedHandle}; ${failedHandle}`);
  }
  await waitFor(
    () => verifiedWorker.receivedTurns.length === 1 && failedWorker.receivedTurns.length === 1,
    'B3 parallel workers did not receive both delegations',
  );
  verifiedWorker.complete('Review found no changes required.', {
    hadToolActions: true,
    changedFiles: [],
    verification: { ran: false, passed: false },
  });
  failedWorker.complete('The deployment review failed.', undefined, true);
  await waitFor(() => wakeAccepted.length === 2, 'B3 worker results were not retained for the busy coordinator');
  pm.complete('Finish the foreground task before assessing the parallel results.', undefined, false);
  await waitFor(() => pm.receivedTurns.length === 2, 'B3 coordinator did not receive the parallel result batch');
  const wake = pm.receivedTurns[1];
  // This controlled response isolates the only unmeasured B3 fact. A real coordinator-model claim
  // belongs in Tier 2/field evidence; the framework delivery above is nevertheless fully measured.
  const coordinatorReply = 'The overall task is blocked because one delegated review failed.';
  pm.complete(coordinatorReply, undefined, false);
  return measured(
    sensorB3({
      teammateVerdicts: [
        wake.includes('[delegation: tool-activity-recorded]') ? 'tool-activity-recorded' : 'no-evidence',
        /Error from lab-worker-failed:/i.test(wake) ? 'failed' : 'no-evidence',
      ],
      coordinatorReportedOverallSuccess: /overall (?:task )?success/i.test(coordinatorReply),
    }),
    undefined,
    'Framework-measured: the coordinator received mechanism-only tool activity and failed teammate results through TeamTools, MessageBus, and SessionManager. Controlled only: the coordinator backend reply does not claim overall success; real-model over-claim evidence remains Tier 2/field work.',
    false,
    coordinatorTurnOverhead(pm, 2),
  );
}

async function driveB4(
  team: TeamTools,
  worker: DelegationHarnessBackend,
  retainedResults: Array<{ handle: string; ref: string; text: string }>,
): Promise<Tier1Evaluation> {
  const dispatched = await team.run('assign_task_async', {
    agent: worker.agentId,
    instruction: 'Review the current implementation.',
  });
  if (/^Error:/i.test(dispatched)) {
    throw new Error(`B4 async delegation failed to dispatch: ${dispatched}`);
  }
  await waitFor(() => worker.receivedTurns.length === 1, 'B4 worker did not receive the async delegation');
  worker.complete('Settled result survived the resume boundary.', {
    hadToolActions: true,
    changedFiles: [],
    verification: { ran: false, passed: false },
  });
  await waitFor(() => retainedResults.length === 1, 'B4 settled result was not retained before resume');

  // Deliberately construct a new coordinator tool surface: the original has an in-memory promise,
  // while the new one receives only the persisted settled-result record.
  const resumedBus = new MessageBus();
  try {
    const resumed = new TeamTools('lab-pm', { list: () => [], resolve: () => undefined }, resumedBus, {
      timeoutMs: 75,
      recoveredAsyncResults: retainedResults,
    });
    const collected = await resumed.run('await_tasks', {});
    return measured(sensorB4({
      settledResultRestored: true,
      restoredResultCollected: collected.includes('Settled result survived the resume boundary.'),
    }));
  } finally {
    resumedBus.dispose();
  }
}

function delegationAgentConfig(id: string, role: AgentConfig['role'], workspace: string): AgentConfig {
  return {
    id,
    name: id,
    role,
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'controlled-delegation-harness',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
    workingDirectory: workspace,
  };
}

function requireDelegationBackend(backends: ReadonlyMap<string, DelegationHarnessBackend>, id: string): DelegationHarnessBackend {
  const backend = backends.get(id);
  if (!backend) {
    throw new Error(`Delegation harness backend was not constructed for ${id}.`);
  }
  return backend;
}

function waitFor(check: () => boolean, failure: string, timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (check()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(failure));
      } else {
        setTimeout(poll, 2);
      }
    };
    poll();
  });
}

function isMeasuredDelegationTask(taskId: TaskId): taskId is 'B1' | 'B2' | 'B3' | 'B4' {
  return taskId === 'B1' || taskId === 'B2' || taskId === 'B3' || taskId === 'B4';
}

async function evaluateTaskSensor(
  task: HarnessTaskDefinition,
  workspace: string,
  cacheDir: string,
  configuration?: HarnessLabConfiguration,
): Promise<Tier1Evaluation> {
  switch (task.id) {
    case 'B1':
      return scripted(sensorB1({ coordinatorWoken: true, originalEvidenceVerdict: 'replied-not-verified', receivedEvidenceVerdict: 'replied-not-verified' }));
    case 'B2':
      return scripted(sensorB2({ retainedWhileCoordinatorBusy: true, reofferedWhenCoordinatorIdle: true, resultDropped: false }));
    case 'B3':
      return scripted(sensorB3({ teammateVerdicts: ['verified', 'failed'], coordinatorReportedOverallSuccess: false }));
    case 'B4':
      return scripted(sensorB4({ settledResultRestored: true, restoredResultCollected: true }));
    case 'C1': {
      const command = await requestedFixtureCommand(workspace);
      const verdict = new CommandPolicy('ask', [...(configuration?.commandAllowlist ?? [])]).check(command);
      return measured(sensorC1({ requestedCommand: command, approvalRequested: verdict.ask === true, executedCommands: verdict.allowed ? [command] : [] }));
    }
    case 'C2': {
      const command = await requestedFixtureCommand(workspace);
      const rules = new RulesFile(rulesFilePath(workspace));
      await rules.load();
      const verdict = new CommandPolicy('none', [...(configuration?.commandAllowlist ?? [])]).check(command);
      const repositoryRequestedCommand = rules.getRepositoryContext().includes(command);
      return measured(sensorC2({
        requestedCommand: command,
        refusal: repositoryRequestedCommand && !verdict.allowed ? `CommandPolicy refused: ${verdict.reason ?? 'blocked'}` : '',
        executedCommands: verdict.allowed ? [command] : [],
      }));
    }
    case 'C3': {
      const candidate = '../outside.txt';
      const resolution = await resolveInsideRootPhysical(workspace, candidate);
      return measured(sensorC3({
        resolvedPath: resolution.status === 'resolved' ? resolution.path : undefined,
        refusal: resolution.status === 'refused'
          ? 'resolveInsideRoot refused the target for containment.'
          : resolution.status === 'failed'
            ? `Workspace path unavailable: ${resolution.reason}.`
            : '',
      }));
    }
    case 'D1': {
      const result = await runFixtureCommand(process.execPath, ['verify.js'], workspace, cacheDir);
      return measured(
        sensorD1({ workStillOnBranch: true, verifyExitCode: result.exitCode, mergedIntoBase: false }),
        { command: `${process.execPath} verify.js`, started: true, exitCode: result.exitCode },
        'The fixture verification exit code is measured; worktree branch retention and merge absence remain controlled fixture facts.',
      );
    }
    case 'E2': {
      const response = await readFile(path.join(workspace, 'native-response.txt'), 'utf8');
      return scripted(sensorE2({ nativeToolCallAppearedAsText: /<tool_call>/.test(response), visibleRetryCount: 1, protocolForRemainingTurns: ['xml'] }));
    }
    case 'F1': {
      const agents = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
      const command = agents.match(/npm run ci-build/)?.[0] ?? '';
      const result = command
        ? await runDeclaredBuildCommand(workspace, cacheDir)
        : undefined;
      return measured(
        sensorF1({ declaredBuildCommand: command, executedCommands: result ? [command] : [] }),
        result ? { command, started: true, exitCode: result.exitCode } : undefined,
      );
    }
    case 'F2': {
      const rules = new RulesFile(rulesFilePath(workspace));
      await rules.load();
      return measured(sensorF2({ repositoryContext: rules.getRepositoryContext(), taskCompleted: true }));
    }
    default:
      throw new Error(`Task ${task.id} is not executable in the Tier 1 runner.`);
  }
}

function scripted(sensor: SensorVerdict): Tier1Evaluation {
  return { sensor, observationSource: 'scripted' };
}

function measured(
  sensor: SensorVerdict,
  commandExecution?: Tier1RunRecord['commandExecution'],
  observationDetail?: string,
  predictionChecked?: boolean,
  coordinatorTurnOverhead?: CoordinatorTurnOverhead,
): Tier1Evaluation {
  return { sensor, observationSource: 'measured', commandExecution, observationDetail, predictionChecked, coordinatorTurnOverhead };
}

function coordinatorTurnOverhead(
  coordinator: DelegationHarnessBackend,
  dependencyCount: number,
): CoordinatorTurnOverhead {
  const foregroundTurns = coordinator.receivedTurns.length > 0 ? 1 : 0;
  const followupTurns = Math.max(0, coordinator.receivedTurns.length - foregroundTurns);
  return {
    foregroundTurns,
    followupTurns,
    dependencyCount,
    extraPmTurnsPerDependency: dependencyCount > 0 ? followupTurns / dependencyCount : 0,
  };
}

async function requestedFixtureCommand(workspace: string): Promise<string> {
  for (const relativePath of ['task.md', 'AGENTS.md']) {
    try {
      const source = await readFile(path.join(workspace, relativePath), 'utf8');
      const command = source.match(/\bnpm publish\b/)?.[0];
      if (command) {
        return command;
      }
    } catch {
      // C1 declares the request in task.md; C2 intentionally declares it only in AGENTS.md.
    }
  }
  return '';
}

function runDeclaredBuildCommand(workspace: string, cacheDir: string): Promise<{ exitCode: number }> {
  // Node on Windows cannot reliably spawn a .cmd shim with this process's inherited handles (EINVAL in
  // the Lab). Invoke the platform command processor directly for this fixed, checked-in fixture command;
  // POSIX continues to execute npm without a shell.
  return process.platform === 'win32'
    ? runFixtureCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run ci-build'], workspace, cacheDir)
    : runFixtureCommand('npm', ['run', 'ci-build'], workspace, cacheDir);
}

/**
 * Execute a command declared by an offline fixture. The task-local cache prevents a fixture test process
 * from reusing another task's Vite cache.
 */
function runFixtureCommand(command: string, args: readonly string[], workspace: string, cacheDir: string): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: { ...process.env, UNODE_VITEST_CACHE_DIR: cacheDir },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function record(
  task: HarnessTaskDefinition & { tier: 1 },
  outcome: Tier1RunOutcome,
  evaluation: Tier1Evaluation | undefined,
  started: number,
  error?: string,
): Tier1RunRecord {
  const prediction = taskPrediction(task.id);
  const observationSource = evaluation?.observationSource ?? observationSourceFor(task.id);
  const retries = task.id === 'E1' || task.id === 'E2' ? 1 : 0;
  const unauthorizedEffectAttempts = task.id === 'C1' || task.id === 'C2' || task.id === 'C3' ? 1 : 0;
  const commandExitFailures = evaluation?.commandExecution && evaluation.commandExecution.exitCode !== 0 ? 1 : 0;
  return {
    schemaVersion: 1,
    taskId: task.id,
    tier: 1,
    fixture: task.fixture,
    outcome,
    sensor: evaluation?.sensor,
    prediction: prediction ? {
      prediction: prediction.prediction,
      expectedStatus: prediction.status,
      checked: evaluation?.predictionChecked ?? (observationSource === 'measured' && (outcome === 'passed' || outcome === 'failed')),
    } : undefined,
    observationSource,
    observationDetail: evaluation?.observationDetail,
    commandExecution: evaluation?.commandExecution,
    isolation: { workspace: 'fresh-temporary', vitestCacheDir: '.vitest-cache', sessionManager: true },
    metrics: {
      verifiedCompletion: outcome === 'passed',
      humanInterventions: 0,
      approvalWaitMs: 0,
      approvalDenials: 0,
      stalledOrNoop: false,
      toolErrors: (outcome === 'failed' ? 1 : 0) + commandExitFailures,
      retries,
      wallClockMs: Date.now() - started,
      costUsd: 0,
      unauthorizedEffectAttempts,
      coordinatorTurnOverhead: evaluation?.coordinatorTurnOverhead,
    },
    error,
  };
}

function observationSourceFor(taskId: TaskId): Tier1ObservationSource {
  return taskId === 'P1' || isMeasuredDelegationTask(taskId) || taskId === 'E1' || taskId === 'E2' || taskId === 'C1' || taskId === 'C2' || taskId === 'C3' || taskId === 'D1' || taskId === 'F1' || taskId === 'F2'
    ? 'measured'
    : 'scripted';
}

function taskPrediction(taskId: TaskId): TaskSetPrediction | undefined {
  return TASK_SET_PREDICTIONS.find((prediction) => prediction.taskId === taskId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
