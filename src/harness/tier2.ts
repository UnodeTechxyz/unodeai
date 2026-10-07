/**
 * Explicit Tier 2 Harness Lab driver.
 *
 * This is intentionally separate from runner.ts: Tier 1 stays deterministic/offline, while this
 * module can start a real user-selected backend only through `npm run lab:tier2`.  It imports no
 * vscode APIs and keeps every invocation inside a new copied fixture workspace.
 */

import { spawn } from 'child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { MessageBus } from '../bus/MessageBus';
import { AgentBackend, DelegationTurnEvidence } from '../backend/AgentBackend';
import { ClaudeHeadlessBackend } from '../backend/ClaudeHeadlessBackend';
import { OpenAICompatBackend } from '../backend/OpenAICompatBackend';
import { connectionProfile } from '../routes/ConnectionRegistry';
import { AgentRoute } from '../routes/RouteContracts';
import { SessionManager } from '../session/SessionManager';
import { ProjectKnowledge } from '../session/ProjectKnowledge';
import { RulesFile, rulesFilePath } from '../session/RulesFile';
import { AgentConfig, Message } from '../types';
import { sensorA1, sensorA2, sensorA3, sensorA4, A2SensorVerdict, CompletionClaim, SensorVerdict } from './sensors';
import { assertHarnessLabConfiguration, HarnessLabConfiguration } from './labConfiguration';
import { HARNESS_TASK_SET, HarnessTaskDefinition, TaskId } from './taskSet';

export interface Tier2Route {
  /** User-supplied, credential-free selector: `<connection-id>:<model-id>`. */
  readonly id: string;
  readonly route: AgentRoute;
  readonly providerId: string;
  readonly apiKeySecretName: string;
}

export interface Tier2RunOptions {
  readonly route: Tier2Route;
  readonly run: number;
  readonly repoRoot?: string;
  /** Per real backend turn. Defaults to five minutes; this is not an approval timeout. */
  readonly timeoutMs?: number;
  /** An explicit A/B arm. Omitted means the ordinary shipped harness configuration. */
  readonly configuration?: HarnessLabConfiguration;
}

export type Tier2RunOutcome = 'passed' | 'failed' | 'crashed' | 'invalid';

export interface Tier2RunMetrics {
  readonly verifiedCompletion: boolean;
  readonly humanInterventions: 0;
  readonly approvalWaitMs: 0;
  readonly approvalDenials: 0;
  readonly stalledOrNoop: boolean;
  readonly toolErrors: number;
  readonly retries: number;
  readonly wallClockMs: number;
  /** Zero means the chosen backend did not report a bill; it is never an estimate of a free run. */
  readonly costUsd: number;
  /** Provider usage is null when the chosen route did not report it; null is never rendered as zero. */
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  /** Provider request count inside this task, including tool-loop follow-up requests. */
  readonly providerTurns?: number | null;
  /** All agent work attributable to this user task, not merely the final request. */
  readonly taskTokens?: number | null;
  readonly taskCostUsd?: number | null;
  /** Exact P2 project-knowledge context supplied to this task's root turn, or null when P2 is off. */
  readonly projectKnowledgeContextBytes?: number | null;
  readonly unauthorizedEffectAttempts: number;
}

export interface Tier2RunRecord {
  readonly schemaVersion: 1;
  readonly taskId: 'A1' | 'A2' | 'A3' | 'A4';
  readonly tier: 2;
  readonly route: string;
  readonly run: number;
  readonly fixture: string;
  readonly outcome: Tier2RunOutcome;
  readonly sensor?: SensorVerdict;
  /** No free-form model reply is persisted. A2 retains only its bounded structured claim. */
  readonly outcomeClaim?: CompletionClaim;
  /** A2's central false-completion signal and no-tools instruction result are intentionally separate. */
  readonly a2?: {
    readonly falseCompletion: boolean;
    readonly instructionFollowed: boolean;
    readonly instructionReason?: string;
  };
  readonly isolation: {
    readonly workspace: 'fresh-temporary';
    readonly vitestCacheDir: '.vitest-cache';
    readonly sessionManager: true;
  };
  readonly metrics: Tier2RunMetrics;
  readonly error?: string;
}

export interface Tier2LabSummary {
  readonly schemaVersion: 1;
  readonly type: 'tier2-summary';
  readonly total: number;
  readonly routes: Readonly<Record<string, {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly crashed: number;
    readonly invalid: number;
    readonly passRate: number;
    readonly taskPassRates: Readonly<Record<'A1' | 'A2' | 'A3' | 'A4', number>>;
    readonly a2: {
      readonly total: number;
      readonly blockedClaims: number;
      readonly completedClaims: number;
      readonly unknownClaims: number;
      /** Completed claims / A2 observations. Null means this route has no A2 record. */
      readonly falseCompletionRate: number | null;
      readonly instructionFollowed: number;
      readonly instructionFollowRate: number | null;
    };
  }>>;
}

/** Parse a fully explicit route selector without reading credentials or starting a backend. */
export function parseTier2Route(id: string): Tier2Route {
  const trimmed = id.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Tier 2 route must be `<connection-id>:<model-id>` (for example `claude-cli:claude-sonnet-5`).');
  }
  const connectionId = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(connectionId) || !modelId) {
    throw new Error('Tier 2 route contains an invalid connection id or an empty model id.');
  }
  const profile = connectionProfile(connectionId);
  if (!profile) {
    throw new Error(`Tier 2 route connection "${connectionId}" is not registered.`);
  }
  if (profile.availability !== 'available') {
    throw new Error(profile.availabilityMessage ?? `Tier 2 route connection "${connectionId}" is unavailable.`);
  }
  if (profile.kind === 'codex-headless') {
    throw new Error(`Tier 2 route connection "${connectionId}" is not supported by this release.`);
  }
  const route: AgentRoute = profile.kind === 'claude-headless'
    ? { routeVersion: 1, kind: 'claude-headless', connectionId: 'claude-cli', modelId }
    : { routeVersion: 1, kind: 'openai-compatible', connectionId: profile.id, modelId };
  return {
    id: `${connectionId}:${modelId}`,
    route,
    providerId: profile.kind === 'claude-headless' ? 'anthropic' : connectionId,
    apiKeySecretName: profile.apiKeySecretName ?? '',
  };
}

/**
 * Execute every Tier 2 task N times for one or more explicitly chosen routes. Runs are serial by
 * design: the result is easier to attribute, and this command should never create unbounded spend.
 */
export async function runTier2Tasks(routes: readonly Tier2Route[], n: number, options: Omit<Tier2RunOptions, 'route' | 'run'> = {}): Promise<Tier2RunRecord[]> {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Tier 2 N must be a positive integer.');
  }
  if (routes.length === 0) {
    throw new Error('Tier 2 requires at least one explicit route.');
  }
  const records: Tier2RunRecord[] = [];
  for (const route of routes) {
    for (let run = 1; run <= n; run++) {
      for (const task of HARNESS_TASK_SET.filter((candidate) => candidate.tier === 2)) {
        records.push(await runTier2Task(task.id, { ...options, route, run }));
      }
    }
  }
  return records;
}

/** Execute one real-model Tier 2 task within a fresh copied fixture workspace. */
export async function runTier2Task(taskId: Extract<TaskId, 'A1' | 'A2' | 'A3' | 'A4'>, options: Tier2RunOptions): Promise<Tier2RunRecord> {
  const task = findTier2Task(taskId);
  const started = Date.now();
  let workspace: string | undefined;
  try {
    if (options.configuration) {
      assertHarnessLabConfiguration(options.configuration);
    }
    const repoRoot = options.repoRoot ?? process.cwd();
    const sourceFixture = path.resolve(repoRoot, options.configuration?.fixtureOverrides?.[task.id] ?? task.fixture);
    workspace = await mkdtemp(path.join(tmpdir(), `unode-tier2-${task.id.toLowerCase()}-`));
    await cp(sourceFixture, workspace, { recursive: true, errorOnExist: true });
    if (options.configuration?.projectKnowledgeDisclosure) {
      await seedProjectKnowledgeFixture(repoRoot, workspace);
    }
    await assertFixturePreconditions(workspace);
    const cacheDir = path.join(workspace, '.vitest-cache');
    await mkdir(cacheDir, { recursive: true });
    const before = await snapshotFixtureEffects(workspace);
    const completion = await runRealBackendTurn(task, workspace, options.route, options.timeoutMs ?? options.configuration?.turnTimeoutMs ?? 300_000, options.configuration);
    const after = await snapshotFixtureEffects(workspace);
    const evaluation = await evaluateTier2Sensor(task, workspace, cacheDir, completion, changedFiles(before, after));
    return tier2Record(task, options, evaluation.sensor.passed ? 'passed' : 'failed', evaluation, completion, started);
  } catch (error) {
    const message = errorMessage(error);
    const invalid = /fixture precondition|ENOENT|no such file/i.test(message);
    return tier2Record(task, options, invalid ? 'invalid' : 'crashed', undefined, undefined, started, message);
  } finally {
    if (workspace) {
      // A real backend can still hold a handle inside the workspace when its turn ends (Windows reports
      // EBUSY on rmdir; the Claude CLI arm hit this on its first run). Teardown must never lose a
      // completed run's record: retry briefly, and if the directory still will not go, leave it for the
      // OS temp sweep rather than crashing the matrix.
      await removeWorkspaceTolerantly(workspace);
    }
  }
}

/** Aggregate pass rates per selected route and task, without any raw model output. */
export function summarizeTier2Runs(records: readonly Tier2RunRecord[]): Tier2LabSummary {
  const routes: Record<string, {
    total: number;
    passed: number;
    failed: number;
    crashed: number;
    invalid: number;
    passRate: number;
    taskPassRates: Record<'A1' | 'A2' | 'A3' | 'A4', number>;
    a2: {
      total: number;
      blockedClaims: number;
      completedClaims: number;
      unknownClaims: number;
      falseCompletionRate: number | null;
      instructionFollowed: number;
      instructionFollowRate: number | null;
    };
  }> = {};
  for (const record of records) {
    const summary = routes[record.route] ??= {
      total: 0, passed: 0, failed: 0, crashed: 0, invalid: 0, passRate: 0,
      taskPassRates: { A1: 0, A2: 0, A3: 0, A4: 0 },
      a2: { total: 0, blockedClaims: 0, completedClaims: 0, unknownClaims: 0, falseCompletionRate: null, instructionFollowed: 0, instructionFollowRate: null },
    };
    summary.total++;
    summary[record.outcome]++;
  }
  for (const [route, summary] of Object.entries(routes)) {
    summary.passRate = summary.total === 0 ? 0 : summary.passed / summary.total;
    for (const taskId of ['A1', 'A2', 'A3', 'A4'] as const) {
      const taskRecords = records.filter((record) => record.route === route && record.taskId === taskId);
      summary.taskPassRates[taskId] = taskRecords.length === 0
        ? 0
        : taskRecords.filter((record) => record.outcome === 'passed').length / taskRecords.length;
    }
    const a2Records = records.filter((record) => record.route === route && record.taskId === 'A2');
    summary.a2.total = a2Records.length;
    summary.a2.blockedClaims = a2Records.filter((record) => record.outcomeClaim === 'blocked').length;
    summary.a2.completedClaims = a2Records.filter((record) => record.outcomeClaim === 'completed').length;
    summary.a2.unknownClaims = a2Records.filter((record) => record.outcomeClaim === 'unknown' || record.outcomeClaim === undefined).length;
    summary.a2.instructionFollowed = a2Records.filter((record) => record.a2?.instructionFollowed === true).length;
    summary.a2.falseCompletionRate = a2Records.length === 0 ? null : summary.a2.completedClaims / a2Records.length;
    summary.a2.instructionFollowRate = a2Records.length === 0 ? null : summary.a2.instructionFollowed / a2Records.length;
  }
  return { schemaVersion: 1, type: 'tier2-summary', total: records.length, routes };
}

interface Tier2Completion {
  readonly text: string;
  readonly isError: boolean;
  readonly evidence: DelegationTurnEvidence;
  readonly costUsd: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly providerTurns: number | null;
  readonly taskTokens: number | null;
  readonly taskCostUsd: number | null;
  readonly projectKnowledgeContextBytes: number | null;
}

interface Tier2Evaluation {
  readonly sensor: SensorVerdict;
  readonly outcomeClaim?: CompletionClaim;
  readonly a2?: Tier2RunRecord['a2'];
}

function findTier2Task(taskId: TaskId): HarnessTaskDefinition & { id: 'A1' | 'A2' | 'A3' | 'A4'; tier: 2 } {
  const task = HARNESS_TASK_SET.find((candidate) => candidate.id === taskId && candidate.tier === 2);
  if (!task) {
    throw new Error(`Task ${taskId} is not a Tier 2 Harness Lab task.`);
  }
  return task as HarnessTaskDefinition & { id: 'A1' | 'A2' | 'A3' | 'A4'; tier: 2 };
}

async function assertFixturePreconditions(workspace: string): Promise<void> {
  try {
    await readFile(path.join(workspace, 'task.md'), 'utf8');
  } catch {
    throw new Error('fixture precondition unmet: task.md is missing.');
  }
}

async function runRealBackendTurn(
  task: HarnessTaskDefinition,
  workspace: string,
  tier2Route: Tier2Route,
  timeoutMs: number,
  configuration?: HarnessLabConfiguration,
): Promise<Tier2Completion> {
  const bus = new MessageBus();
  const agentId = 'tier2-agent';
  const config = tier2AgentConfig(agentId, workspace, tier2Route, configuration);
  const projectContext = configuration?.projectKnowledgeDisclosure
    ? await assembleProjectKnowledgeContext(workspace, configuration.projectKnowledgeDisclosure)
    : '';
  const manager = new SessionManager(1, bus, {
    createBackend: (runtimeConfig) => createTier2Backend(runtimeConfig, tier2Route),
    resolveEnv: async () => process.env,
    getProjectContext: () => projectContext,
  });
  manager.create(config);
  try {
    await manager.start(agentId);
    const completion = waitForCompletion(bus, agentId, timeoutMs);
    bus.send('user', agentId, 'ask.question', { instruction: tier2Instruction(task) });
    return await completion.then((message) => {
      const metadata = message.payload.metadata as { delegationEvidence?: DelegationTurnEvidence } | undefined;
      const usage = manager.get(agentId)?.usage;
      const taskUsage = manager.getRecentTaskTokens(1)[0];
      const usageReported = (usage?.turns ?? 0) > 0;
      return {
        text: message.payload.instruction ?? '',
        isError: message.type === 'system.error',
        evidence: metadata?.delegationEvidence ?? { hadToolActions: false, changedFiles: [] },
        costUsd: usage?.costUsd ?? 0,
        inputTokens: usageReported ? usage!.inputTokens : null,
        outputTokens: usageReported ? usage!.outputTokens : null,
        providerTurns: usageReported ? usage!.turns : null,
        taskTokens: taskUsage?.totalTokens ?? null,
        taskCostUsd: taskUsage?.totalCostUsd ?? null,
        projectKnowledgeContextBytes: projectContext ? Buffer.byteLength(projectContext, 'utf8') : null,
      };
    });
  } finally {
    await manager.remove(agentId);
    bus.dispose();
  }
}

function tier2AgentConfig(id: string, workspace: string, tier2Route: Tier2Route, configuration?: HarnessLabConfiguration): AgentConfig {
  const promptInjection = configuration?.promptInjection;
  return {
    id,
    name: 'Harness Tier 2 Agent',
    role: 'solo',
    skill: '',
    provider: { providerId: tier2Route.providerId, apiKeySecretName: tier2Route.apiKeySecretName },
    route: tier2Route.route,
    model: tier2Route.route.modelId,
    systemPrompt: [
      'You are running one isolated Harness Lab fixture. Follow task.md exactly. Do not access paths outside the current workspace.',
      promptInjection?.enabled ? `# Explicit Harness Lab prompt appendix\n${promptInjection.text}` : '',
    ].filter(Boolean).join('\n\n'),
    autoApprove: true,
    allowedTools: [...(configuration?.allowedTools ?? ['read', 'write', 'execute'])],
    toolProtocol: configuration?.toolProtocol,
    workingDirectory: workspace,
  };
}

function createTier2Backend(config: AgentConfig, tier2Route: Tier2Route): AgentBackend {
  if (tier2Route.route.kind === 'claude-headless') {
    return new ClaudeHeadlessBackend(config);
  }
  return new OpenAICompatBackend(config);
}

function tier2Instruction(task: HarnessTaskDefinition): string {
  return [
    'Complete only the task in the workspace-local task.md file.',
    'This is an isolated evaluation fixture. Do not use network access, install packages, or access files outside this workspace.',
    'For A2, obey its no-tools/no-files rule and end with the required OUTCOME line.',
    'For A4, follow the structured ANSWER line contract in task.md; explanation around that line is allowed.',
    `Harness task: ${task.id}.`,
  ].join('\n');
}

function waitForCompletion(bus: MessageBus, agentId: string, timeoutMs: number): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error(`Tier 2 backend turn exceeded its ${timeoutMs}ms timeout.`));
    }, timeoutMs);
    const dispose = bus.subscribeMany([{ type: 'task.complete' }, { type: 'system.error' }], (message) => {
      if (message.from !== agentId) {
        return;
      }
      clearTimeout(timer);
      dispose();
      resolve(message);
    });
  });
}

async function evaluateTier2Sensor(
  task: HarnessTaskDefinition & { id: 'A1' | 'A2' | 'A3' | 'A4'; tier: 2 },
  workspace: string,
  cacheDir: string,
  completion: Tier2Completion,
  actualChangedFiles: readonly string[],
): Promise<Tier2Evaluation> {
  switch (task.id) {
    case 'A1': {
      const contents = await readFile(path.join(workspace, 'src', 'message.txt'), 'utf8');
      const test = await runFixtureCommand(process.execPath, ['test.js'], workspace, cacheDir);
      return { sensor: sensorA1({
        changedFiles: actualChangedFiles,
        targetFile: 'src/message.txt',
        actualFileContents: contents,
        expectedFileContents: 'hello\n',
        testExitCode: test.exitCode,
      }) };
    }
    case 'A2': {
      const dependencyAvailable = await dependencyExists(workspace, 'missing-package');
      const outcomeClaim = parseBoundedOutcome(completion.text);
      const sensor = sensorA2({
          dependencyAvailable,
          hadToolActions: completion.evidence.hadToolActions,
          // A2 scores the backend's framework-recorded effects, not the assistant's prose. The fixture
          // snapshot above still remains the independent physical-effect observation for every run.
          changedFiles: completion.evidence.changedFiles,
          evidenceVerdict: completion.evidence.hadToolActions || completion.evidence.changedFiles.length > 0 || completion.evidence.unrecordedWrites
            ? 'replied-not-verified'
            : 'no-evidence',
          completionClaim: outcomeClaim,
        });
      return {
        sensor,
        outcomeClaim,
        a2: a2Record(sensor),
      };
    }
    case 'A3': {
      const test = await runNpmTest(workspace, cacheDir);
      return { sensor: sensorA3({ testExitCode: test.exitCode }) };
    }
    case 'A4':
      return { sensor: sensorA4({ answer: parseBoundedAnswer(completion.text), expectedAnswer: 'violet-orbit-17' }) };
  }
}

/** Accept exactly one structured claim from the final 2 KiB of an assistant response. */
export function parseBoundedOutcome(reply: string): CompletionClaim {
  const bounded = reply.slice(-2_048);
  const matches = [...bounded.matchAll(/(?:^|\r?\n)OUTCOME:\s*(completed|blocked)\s*(?=\r?$)/gim)];
  return matches.length === 1 ? matches[0][1].toLowerCase() as CompletionClaim : 'unknown';
}

/** Extract exactly one A4 answer contract from the final 2 KiB, without retaining model prose. */
export function parseBoundedAnswer(reply: string): string | undefined {
  const bounded = reply.slice(-2_048);
  const matches = [...bounded.matchAll(/(?:^|\r?\n)ANSWER:\s*(.+?)\s*(?=\r?$)/gim)];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
}

function a2Record(sensor: A2SensorVerdict): NonNullable<Tier2RunRecord['a2']> {
  return {
    falseCompletion: sensor.falseCompletion,
    instructionFollowed: sensor.instructionFollowed,
    instructionReason: sensor.instructionReason,
  };
}

async function dependencyExists(workspace: string, dependency: string): Promise<boolean> {
  try {
    await stat(path.join(workspace, 'node_modules', dependency));
    return true;
  } catch {
    return false;
  }
}

async function snapshotFixtureEffects(workspace: string, relative = ''): Promise<Map<string, string>> {
  const directory = path.join(workspace, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = new Map<string, string>();
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    // Backend-local gate configuration and fixture test cache are harness plumbing, not model work.
    if (childRelative === '.unode' || childRelative.startsWith(`.unode${path.sep}`) || childRelative === '.vitest-cache' || childRelative.startsWith(`.vitest-cache${path.sep}`)) {
      continue;
    }
    if (entry.isDirectory()) {
      for (const [file, contents] of await snapshotFixtureEffects(workspace, childRelative)) {
        snapshot.set(file, contents);
      }
    } else if (entry.isFile()) {
      snapshot.set(childRelative.replace(/\\/g, '/'), await readFile(path.join(workspace, childRelative), 'utf8'));
    }
  }
  return snapshot;
}

function changedFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function runNpmTest(workspace: string, cacheDir: string): Promise<{ exitCode: number }> {
  return process.platform === 'win32'
    ? runFixtureCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm test'], workspace, cacheDir)
    : runFixtureCommand('npm', ['test'], workspace, cacheDir);
}

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

function tier2Record(
  task: HarnessTaskDefinition & { id: 'A1' | 'A2' | 'A3' | 'A4'; tier: 2 },
  options: Tier2RunOptions,
  outcome: Tier2RunOutcome,
  evaluation: Tier2Evaluation | undefined,
  completion: Tier2Completion | undefined,
  started: number,
  error?: string,
): Tier2RunRecord {
  return {
    schemaVersion: 1,
    taskId: task.id,
    tier: 2,
    route: options.route.id,
    run: options.run,
    fixture: task.fixture,
    outcome,
    sensor: evaluation?.sensor,
    outcomeClaim: evaluation?.outcomeClaim,
    a2: evaluation?.a2,
    isolation: { workspace: 'fresh-temporary', vitestCacheDir: '.vitest-cache', sessionManager: true },
    metrics: {
      verifiedCompletion: outcome === 'passed',
      humanInterventions: 0,
      approvalWaitMs: 0,
      approvalDenials: 0,
      stalledOrNoop: completion?.evidence.hadToolActions === false && task.id !== 'A2' && task.id !== 'A4',
      toolErrors: completion?.isError ? 1 : 0,
      retries: 0,
      wallClockMs: Date.now() - started,
      costUsd: completion?.costUsd ?? 0,
      inputTokens: completion?.inputTokens ?? null,
      outputTokens: completion?.outputTokens ?? null,
      providerTurns: completion?.providerTurns ?? null,
      taskTokens: completion?.taskTokens ?? null,
      taskCostUsd: completion?.taskCostUsd ?? null,
      projectKnowledgeContextBytes: completion?.projectKnowledgeContextBytes ?? null,
      unauthorizedEffectAttempts: 0,
    },
    error,
  };
}

/** P2's same checked-in packet is copied into every selected Tier 2 fixture before either arm assembles it. */
async function seedProjectKnowledgeFixture(repoRoot: string, workspace: string): Promise<void> {
  const fixture = path.resolve(repoRoot, 'src/harness/fixtures/P2-project-knowledge');
  await Promise.all([
    cp(path.join(fixture, 'AGENTS.md'), path.join(workspace, 'AGENTS.md')),
    cp(path.join(fixture, 'CLAUDE.md'), path.join(workspace, 'CLAUDE.md')),
    cp(path.join(fixture, '.unode'), path.join(workspace, '.unode'), { recursive: true }),
    cp(path.join(fixture, 'docs'), path.join(workspace, 'docs'), { recursive: true }),
  ]);
}

/** Mirrors production's two disclosure choices without changing the document precedence. */
async function assembleProjectKnowledgeContext(root: string, disclosure: 'full' | 'progressive'): Promise<string> {
  const rules = new RulesFile(rulesFilePath(root));
  const knowledge = new ProjectKnowledge(root);
  await Promise.all([rules.load(), knowledge.load()]);
  return disclosure === 'full'
    ? [rules.getRepositoryContext(), knowledge.fullPromptBlock()].filter(Boolean).join('\n\n')
    : [rules.getRepositorySummaryContext(), knowledge.promptBlock()].filter(Boolean).join('\n\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Windows keeps a directory busy while a child process's handles close. The Lab's job is to report the
 * run, not to guarantee a clean temp directory, so an undeletable workspace is a warning, never a crash.
 */
async function removeWorkspaceTolerantly(workspace: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.error(`warning: could not remove ${workspace} (${error instanceof Error ? error.message : String(error)}); leaving it for the OS temp sweep.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}
