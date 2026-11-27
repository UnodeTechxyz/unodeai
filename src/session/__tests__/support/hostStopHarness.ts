/*
 * v0.9.103 (F1): one team for the host-stop flows. The real SessionManager, TeamTools, RunLedger, TaskInputResolver and
 * TaskClaimRegistry, wired as src/extension.ts and the orchestration host adapter wire them; the coordinator's backend is
 * the production backend the test chooses (OpenAI-compatible, Claude or Codex, each with fake transport); the teammates'
 * backends are fakes that the test drives. Nothing here starts a CLI, a model or an App Server.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MessageBus } from '../../../bus/MessageBus';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { TaskInputResolver, type TaskAttemptCard } from '../../../backend/TaskContract';
import { TaskClaimRegistry } from '../../../backend/TaskClaimRegistry';
import { TeamTools, type TeamView } from '../../../backend/TeamTools';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../../backend/AgentBackend';
import { RunLedger } from '../../../observability/RunLedger';
import { SessionManager } from '../../SessionManager';
import type { AgentConfig, Message } from '../../../types';

export const ORIGIN = 'f1-origin-turn';

/** A teammate's backend the test drives: its turns are recorded, and it ends one only when told to. */
export class FakeWorker implements AgentBackend {
  readonly agentId: string;
  pid = 77;
  turns: Array<{ instruction: string; attachments?: TurnAttachments }> = [];
  stops = 0;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; setTimeout(() => this.emit({ kind: 'ready' }), 0); }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void { this.turns.push({ instruction, attachments }); }
  async stop(): Promise<void> { this.alive = false; this.stops++; }
  abort(): void {}
  setModel(): void {}
  isAlive(): boolean { return this.alive; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

export function agentConfig(id: string, role: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id, name: id === 'pm' ? 'PM' : id === 'dev' ? 'Dev' : 'Writer', role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: `${id}-model`,
    systemPrompt: '', autoApprove: true, allowedTools: [], ...extra,
  };
}

/** A read-only task: no file claim, so several can be out at once. */
export const readContract = (objective: string) => ({
  version: 1, objective, expected_deliverable: 'A short note.',
  effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
  required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
});

/** A task that edits `src/app`: it claims that folder, so a second one waits behind an overlapping claim. */
export const editContract = (objective: string) => ({
  version: 1, objective, expected_deliverable: 'The edit.',
  effects: { read_files: [], write_scope: { folder_access: [{ path: 'src/app', permission: 'readwrite' }] }, expected_file_effect: 'modify' },
  inputs: [], constraints: [], dependencies: [],
  required_capabilities: { version: 1, capabilities: ['write'] }, execution_strategy: 'delegate-required',
});

export const handleOf = (text: string): string => /Handle: ([^\s.]+)/.exec(text)?.[1] ?? '';

export const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let j = 0; j < 4; j++) await Promise.resolve();
  }
};

export interface HostStopHarnessOptions {
  /** The coordinator's production backend, built around the TeamTools of its launch, as the host builds it. */
  coordinator: (config: AgentConfig, team: TeamTools) => AgentBackend;
  /** Session order: the roster as SessionManager iterates it on shutdown. */
  order: readonly string[];
  /** Extra coordinator config (a Claude PM needs its working folder). */
  coordinatorConfig?: Partial<AgentConfig>;
}

export function hostStopHarness(options: HostStopHarnessOptions) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'unode-f1-')));
  const bus = new MessageBus();
  let ledger = new RunLedger();
  bus.on('message.sent', (message: unknown) => ledger.observeMessage(message as Message));
  const resolver = new TaskInputResolver(new ContentAssetStore(), root);
  const claims = new TaskClaimRegistry();
  const workers = new Map<string, FakeWorker>();
  const launches: Array<{ team: TeamTools; backend: AgentBackend }> = [];
  const assignments: Message[] = [];
  const stopRequests: Array<{ handle: string; interruption: boolean; recorded?: string }> = [];
  bus.onType('task.assign', (message: Message) => { if (message.from === 'pm') assignments.push(message); });
  // eslint-disable-next-line prefer-const
  let manager!: SessionManager;
  const roster = () => [
    { id: 'pm', role: 'pm', name: 'PM', status: manager.get('pm')?.status ?? 'stopped' },
    ...options.order.filter((id) => id !== 'pm').map((id) => ({
      id, role: 'developer', name: id === 'dev' ? 'Dev' : 'Writer', status: manager.get(id)?.status ?? 'stopped', workspaceRoot: root,
      capabilities: {
        read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'],
        backend: 'openai-compat', taskScope: 'per-turn' as const,
      },
    })),
  ];
  const view: TeamView = {
    list: () => roster() as ReturnType<TeamView['list']>,
    resolve: (ref) => roster().find((entry) => entry.id === ref) ? { id: ref } : undefined,
    preflightTaskScope: () => undefined,
    execution: (agentId, handle) => manager.delegationExecution(agentId, handle),
  };
  /** The coordinator's tools of one launch, wired as OrchestrationHostAdapter and src/extension.ts wire them. */
  const newTeam = () => new TeamTools('pm', view, bus, {
    cwd: root, evidenceEnabled: true, waitForTaskAdmission: true, taskInputResolver: resolver, claims,
    turnOrigin: () => ({ correlationId: ORIGIN }),
    cancelDelegatedWorker: (event) => {
      // What the run record says of the task at the moment its coordinator asks the host to stop it.
      stopRequests.push({ handle: event.handle, interruption: event.interruption === true,
        recorded: ledger.inspectTaskStatus('pm', [event.handle])[0]?.lifecycle });
      return manager.cancelDelegation(event.agentId, event.handle, event.reason, event.interruption ? 'interrupt' : 'cancel');
    },
    stopTeammate: (agentId) => { void manager.stop(agentId, 10000, 'host'); return true; },
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: event.originCorrelationId ?? ORIGIN }),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    onDelegationInterrupted: (event) => ledger.recordDelegationInterrupted(event),
    onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    resultRevisionFor: (handle) => ledger.resultIdentity('pm', handle)?.ref.revision,
    onAsyncResultReady: () => true,
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
  });
  manager = new SessionManager(8, bus, {
    createBackend: (config) => {
      if (config.id === 'pm') {
        const team = newTeam();
        const backend = options.coordinator(config, team);
        launches.push({ team, backend });
        return backend;
      }
      const worker = new FakeWorker(config);
      workers.set(config.id, worker);
      return worker;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'f1-test-key' }),
    admitTaskExecution: () => ({ allowed: true, policyId: 'f1-policy', code: 'allow' }),
    endTaskAttempt: (attemptId) => resolver.endAttempt(attemptId, 'cancelled'),
    resolveTaskWorkspaceAccess: () => ({ access: { pathBase: root, readRoots: [root], writeRoots: [root] } }),
  });

  const h = {
    root, bus, resolver, claims, manager, workers, launches, assignments, stopRequests,
    ledger: () => ledger,
    /** The run records as a new window loads them from what this one stored. */
    reload: () => { ledger = new RunLedger(ledger.snapshot()); return ledger; },
    team: () => launches.at(-1)!.team,
    backend: () => launches.at(-1)!.backend,
    async startAll(): Promise<void> {
      for (const id of options.order) {
        manager.create(id === 'pm'
          ? agentConfig('pm', 'pm', { workingDirectory: root, ...options.coordinatorConfig })
          : agentConfig(id, 'senior-dev', { workingDirectory: root }));
      }
      for (const id of options.order) {
        await manager.start(id, { pin: 'take' });
      }
      await settle();
    },
    /** The coordinator dispatches through its current launch's tools; the tool's own text is returned. */
    async dispatch(agent: string, instruction: string, contract: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
      const team = h.team();
      team.beginTurnContentReceipts();
      const out = await team.run('dispatch_task', { agent, instruction, contract, ...extra });
      await settle();
      return out;
    },
    assignmentOf(handle: string): Message | undefined { return assignments.find((message) => message.correlationId === handle); },
    /** The teammate asks its coordinator on this task and ends its turn waiting: a waiting checkpoint. */
    async waitAtCheckpoint(workerId: string, card: TaskAttemptCard, question: string): Promise<void> {
      const tools = new WorkspaceTools(root, new Set(['message']), workerId, undefined, undefined, undefined, undefined, bus);
      tools.setTaskInputResolver(resolver);
      tools.beginTurn();
      tools.setTaskAttempt(card);
      await tools.runText('send_message', { target: 'coordinator', message: question, kind: 'question' });
      await settle();
      workers.get(workerId)!.emit({ kind: 'turn_complete', result: { text: `Waiting: ${question}`, isError: false } });
      await settle();
    },
    /** The terminal receipts a teammate published for a handle, as its coordinator received them. */
    receiptsOf(handle: string): Message[] {
      return bus.query({ type: 'system.error' }).filter((message) => message.correlationId === handle && message.to === 'pm');
    },
    status(handle: string) { return ledger.inspectTaskStatus('pm', [handle])[0]; },
    delegation(handle: string) { return ledger.snapshot().flatMap((run) => run.delegations).find((row) => row.handle === handle); },
    async cleanup(): Promise<void> {
      try { await manager.shutdown(); } catch { /* best effort */ }
      bus.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

export type HostStopHarness = ReturnType<typeof hostStopHarness>;

/** A replacement dispatch, as a coordinator launch of a new window makes it against the records it loaded. */
export function replacementTeam(ledger: RunLedger, root: string): { team: TeamTools; bus: MessageBus } {
  const bus = new MessageBus();
  const view: TeamView = {
    list: () => [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      ...['dev', 'writer'].map((id) => ({
        id, role: 'developer', name: id, status: 'idle' as const, workspaceRoot: root,
        capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const },
      })),
    ],
    resolve: (ref) => ({ id: ref }),
    preflightTaskScope: () => undefined,
  };
  const team = new TeamTools('pm', view, bus, {
    cwd: root, evidenceEnabled: true, taskInputResolver: new TaskInputResolver(new ContentAssetStore(), root),
    claims: new TaskClaimRegistry(),
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'f1-replacement-turn' }),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
  });
  return { team, bus };
}
