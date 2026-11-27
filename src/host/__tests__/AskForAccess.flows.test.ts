import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
vi.mock('vscode', () => ({}));
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { accessPhysicalPath, SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { AccessTable } from '../AccessTable';
import { fileToolReachesAnotherComputer } from '../namedOutsidePaths';
import { TeamTools, type TeamRosterEntry } from '../../backend/TeamTools';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../orchestration/OrchestrationHostAdapter';
import { RunLedger } from '../../observability/RunLedger';
import { projectJobOutcome } from '../../observability/JobOutcome';
import { pmLiveRelevant, pmLiveStrip } from '../../session/PmLiveStrip';
import { SessionManager } from '../../session/SessionManager';
import { createPathAccessOffer, PathAccessRequestItems, pathAccessItemView, pathAccessNoticeText, type PathAccessItem } from '../PathAccessOffer';
import { endedRequestContinuation } from '../requestContinuation';
import { TaskResumeRefs } from '../TaskResumeRefs';
import { agentConfig, tempFolder } from '../../views/__tests__/support/fileNavigationHost';
import { delegationReceiptEvent, type AgentBackend, type BackendEvent, type BackendEventHandler, type ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { bootWebviewScript, type WebviewBootResult } from '../../views/__tests__/support/webviewBoot';
import { connectPmLive, pmReplyStore } from '../pmLiveView';
import { parseChatTurnTrigger, parseChatVerbatim, parseDelegationCounts } from '../../views/chatHistory';
import { emptyReplyNotice, parseResponseOutcome } from '../../backend/emptyReplyOutcome';
import { parseTurnOutcomeReceipt } from '../../session/turnOutcomeReceipt';
import { parseTurnInterruption } from '../../backend/TurnInterruption';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { TeamMcpBridge } from '../../mcp/TeamMcpBridge';

/**
 * The production wiring itself, read from src/extension.ts (one match each) and run against this harness's objects, so a
 * change to how extension.ts connects them is what the test runs (the technique of ChatViewProvider.responseRetry.test).
 */
const propertyNamed = (name: string) => (node: ts.Node, source: ts.SourceFile) =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === name;
const WIRINGS = {
  // The PM turn that ended with a request waiting: its live strip shows the wait.
  waitingStatusShown: propertyNamed('waitingStatusShown'),
  // What the PM live strip reads from the ledger, and the PM's last final reply.
  coordinatorTaskStatus: propertyNamed('coordinatorTaskStatus'),
  pmRepliedAt: propertyNamed('pmRepliedAt'),
  recordPmReply: propertyNamed('recordPmReply'),
  coordinatorDispatchOutcomes: propertyNamed('coordinatorDispatchOutcomes'),
  // The bus-to-chat reply adapter, and the epoch rule it uses.
  onReply: propertyNamed('onReply'),
  normalizeEpoch: (node: ts.Node, source: ts.SourceFile) => ts.isFunctionDeclaration(node) && node.name?.getText(source) === 'normalizeEpoch',
  // v0.9.103: the adapter shows a reply together with the records and Job outcome it closed.
  deliverReply: (node: ts.Node, source: ts.SourceFile) => ts.isFunctionDeclaration(node) && node.name?.getText(source) === 'deliverReply',
  // v0.9.102: the PM live strip's one connection to the session manager, the access table, the ledger and the chat.
  pmLive: (node: ts.Node, source: ts.SourceFile) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.left.getText(source) === 'pmLive',
  // A turn's dispatch receipt that changed after the turn: its footer, and what is still starting from that turn.
  publishDelegationReceiptChange: propertyNamed('publishDelegationReceiptChange'),
};
type Wiring = keyof typeof WIRINGS;
/** v0.9.103 (G4): each late receipt as the production wiring handed it to its turn's request closeout. */
const closeoutReceipts: Array<{ agentId: string; turnId: string; receipt: unknown }> = [];
let wiringScripts: Map<Wiring, string> | undefined;

/**
 * Reads and parses src/extension.ts once per run of this file, in a beforeAll, so no test pays for it in its own time
 * (a mutation case runs one proof under a 5 s budget, and the parse is slow on a busy runner).
 */
function loadProductionWirings(): void {
  if (wiringScripts) return;
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Map<Wiring, ts.Node[]>(Object.keys(WIRINGS).map((name) => [name as Wiring, []]));
  const visit = (node: ts.Node) => {
    for (const [name, find] of Object.entries(WIRINGS)) if (find(node, source)) found.get(name as Wiring)!.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scripts = new Map<Wiring, string>();
  for (const [name, nodes] of found) {
    expect(nodes, `one ${name} wiring in src/extension.ts`).toHaveLength(1);
    const wiring = ts.isPropertyAssignment(nodes[0]) ? nodes[0].initializer : nodes[0];
    scripts.set(name, ts.transpileModule(`__wired = (${wiring.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  wiringScripts = scripts;
}

function productionWiring(name: Wiring, scope: Record<string, unknown>): unknown {
  expect(wiringScripts, 'loadProductionWirings() runs in a beforeAll of a describe whose host has the chat').toBeDefined();
  const host: Record<string, unknown> = { ...scope, __wired: undefined };
  new Function('host', `with (host) { ${wiringScripts!.get(name)!} }`)(host);
  return host.__wired;
}

/*
 * v0.9.101 (H2a): a dispatch whose only obstacle is access the person has not granted yet waits for it, and a grant
 * that makes it runnable wakes the PM once, in the request that waited. Through the real SessionManager (its turns,
 * requests and wake queue), the real OrchestrationHostAdapter (the input access it judges), TeamTools dispatch_task and
 * cancel_task, the real grant store, the shared PathAccessOffer items, TaskResumeRefs and the RunLedger with its Job
 * outcome. Only the models are scripted: the PM's tool calls are made here, between its turn's start and its end.
 */

/** The access line the PM live strip shows for these waiting needs; undefined when it shows none. */
function accessLine(needs: ReadonlyArray<{ label: string; path: string; access: 'read' | 'readwrite' }>): string | undefined {
  const line = pmLiveStrip({ held: false, tasks: [], repliedAt: new Date().toISOString(), queued: new Set(), starting: 0, waitingForAccess: needs })
    ?.lines.find((row) => row.kind === 'access');
  return line && 'text' in line ? line.text : undefined;
}

const LEASE = 'MASTER LEASE AGREEMENT\nClause 1. The lessee leases the compute.\n';
const REF = /resume_ref (rr-[0-9a-f]{32})/;
const WAIT = /Task "(wait-[0-9a-f]{12})" is prepared and waiting/;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-h2a-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

const flush = async () => {
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
};

class ScriptedBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void {}
  isAlive(): boolean { return this.alive; }
  readonly snapshotKind = 'openai-compat' as const;
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): boolean { return true; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

/** The contract the PM writes: summarise the outside lease into a file of an outside folder. */
function leaseContract(source: string, output: string): Record<string, unknown> {
  return {
    version: 2,
    objective: 'Summarise the lease in English and Traditional Chinese.',
    expected_deliverable: 'A bilingual summary file.',
    effects: { read_files: [], expected_file_effect: 'create' },
    inputs: [{ input_id: 'lease', kind: 'workspacePath', path: source, purpose: 'The contract to summarise', required: true,
      freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] } }],
    outputs: [{ output_id: 'summary', path: output, kind: 'file', required: true }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    execution_strategy: 'delegate-required',
  };
}

type Choice = { permission: 'read' | 'readwrite'; lifetime: 'request' | 'session' };

async function host(options: { readRoots?: (outDir: string) => string[]; chat?: boolean; fullFileAccess?: boolean;
  /** As production's coordinator tools: a dispatch is recorded when its teammate is admitted, not when it is sent. */
  waitForTaskAdmission?: boolean;
  /**
   * As OrchestrationHostAdapter and src/extension.ts: a settled result queues its PM's wake, which first prepares the
   * result's delivery in storage (resultDeliveryHost.prepare); `finishPrepare` ends that wait. Without it, a result waits
   * for the PM's await_tasks.
   */
  wake?: boolean } = {}) {
  const root = folder({ 'notes.md': 'workspace' });
  const outside = folder({ 'lease.txt': LEASE });
  const outDir = folder();
  const source = path.join(outside, 'lease.txt');
  const output = path.join(outDir, 'summary.txt');
  // An output in the workspace: the dispatch needs no grant for it.
  const inside = path.join(root, 'summary.txt');
  // As src/extension.ts: the project's access table holds the deliberate grants as its rows and draws every item.
  let adapterRef: OrchestrationHostAdapter | undefined;
  const table = new AccessTable({
    judge: (consumer, requestId, named, needed, observed) => (configs[consumer.agentId] && adapterRef
      ? adapterRef.judgeAccess(configs[consumer.agentId], requestId, named, needed, observed)
      : { state: 'missing', effective: 'none', source: 'none', granted: 'none', grantIds: [] }),
    identity: (named) => { try { return accessPhysicalPath(named); } catch { return undefined; } },
    remote: (named) => fileToolReachesAnotherComputer(path.resolve(named)),
  });
  const consent = new SessionLocalReadScopeConsent(async () => false, undefined, undefined, table.grantRows);
  const bus = new MessageBus();
  const backends = new Map<string, ScriptedBackend>();
  let refs!: TaskResumeRefs;
  let ledger!: RunLedger;
  // The ledger is made after the manager, as in src/extension.ts: its readers are bound at call time.
  const workspaceState = new Map<string, unknown>();
  const pmReplies = pmReplyStore({ get: <T>(key: string) => workspaceState.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { workspaceState.set(key, structuredClone(value)); } });
  const ledgerPort = {
    inspectTaskStatusWhere: (...args: Parameters<RunLedger['inspectTaskStatusWhere']>) => ledger.inspectTaskStatusWhere(...args),
    dispatchOutcomesBetween: (...args: Parameters<RunLedger['dispatchOutcomesBetween']>) => ledger.dispatchOutcomesBetween(...args),
  };
  const mgr = new SessionManager(5, bus, {
    createBackend: (config) => { const made = new ScriptedBackend(config); backends.set(config.id, made); return made; },
    resolveEnv: async () => ({}),
    threadRunOpen: (coordinatorId, correlationId) => ledger.threadRunOpen(coordinatorId, correlationId),
    // As src/extension.ts wires them.
    requestAwaitingAccess: (requestId) => refs.hasWaiting(requestId),
    waitingRequestsStopped: (scope) => {
      const ended = 'coordinatorId' in scope
        ? refs.endCoordinator(scope.coordinatorId, 'stopped')
        : (refs.hasWaiting(scope.requestId) ? (refs.endRequest(scope.requestId), [scope.requestId]) : []);
      for (const requestId of ended) consent.endPathAccessRequest(requestId);
    },
    coordinatorGone: (coordinatorId) => {
      for (const requestId of refs.endCoordinator(coordinatorId, 'coordinator-gone')) consent.endPathAccessRequest(requestId);
    },
    // With the chat on screen, src/extension.ts's own: the PM turn that ended with a request waiting, what the PM live
    // strip reads from the ledger, and the PM's last final reply, kept in workspace state.
    ...(options.chat ? {
      waitingStatusShown: productionWiring('waitingStatusShown', { accessTable: table }) as never,
      coordinatorTaskStatus: productionWiring('coordinatorTaskStatus', { runLedger: ledgerPort }) as never,
      coordinatorDispatchOutcomes: productionWiring('coordinatorDispatchOutcomes', { runLedger: ledgerPort }) as never,
      pmRepliedAt: productionWiring('pmRepliedAt', { pmReplies }) as never,
      recordPmReply: productionWiring('recordPmReply', { pmReplies }) as never,
    } : {}),
  });
  ledger = new RunLedger([], { activeTurnId: (agentId) => mgr.currentTurnId(agentId) });
  bus.on('message.sent', (message: unknown) => ledger.observeMessage(message as Message));
  // With the chat on screen the PM is the team's coordinator, as a real roster's `pm` is: its replies carry the PM status.
  mgr.create({ id: 'pm', name: 'PM', role: (options.chat ? 'pm' : 'project-manager') as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'claude-sonnet-4-20250514', systemPrompt: '',
    autoApprove: true, allowedTools: [] });
  await mgr.start('pm', { pin: 'take' });
  const pm = backends.get('pm')!;
  pm.emit({ kind: 'ready' });
  // As src/extension.ts: a removed coordinator's waiting work ends, through the same cleanup as a replaced one.
  mgr.on('session.removed', (event) => {
    for (const requestId of refs.endCoordinator(event.sessionId, 'coordinator-gone')) consent.endPathAccessRequest(requestId);
  });

  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
      capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' } },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root }),
  };
  const offers = new Map<string, (named: string, cause?: 'refused' | 'named', access?: 'read' | 'readwrite', consumer?: { agentId: string; handle?: string }) => void>();
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => options.readRoots?.(outDir) ?? [], isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => options.fullFileAccess ?? false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: (agentId) => mgr.currentRequestId(agentId),
    // As src/extension.ts: what the work needs of the target rides the offer.
    offerPathAccess: (agentId, target, access, consumer) => offers.get(agentId)?.(target, 'refused', access, consumer),
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  adapterRef = adapter;
  const store = new ContentAssetStore();
  cleanups.push(() => { void store.dispose(); });
  const resolver = adapter.createTaskInputResolver(store);

  let workerTurn: string | undefined;
  let workerRequest: string | undefined;
  refs = new TaskResumeRefs({
    openDelegationOf: (agentId) => ledger.activeDelegation(agentId === 'dev' ? workerTurn : undefined, agentId),
    grantsFor: (requestId) => consent.pathAccessFor(requestId),
    predecessor: (coordinatorId, handle) => ledger.resumePredecessor(coordinatorId, handle),
    currentRequestOf: (coordinatorId) => mgr.currentRequestId(coordinatorId),
    // As src/extension.ts: the real rule, the adapter's own.
    needMet: (candidateId, requestId, need) => !!configs[candidateId] && adapter.accessNeedMet(configs[candidateId], need, requestId),
    // As src/extension.ts: a waiting step's needs are rows of its own consumer; readiness reads them.
    needRows: {
      declare: (requestId, consumer, needs, step) => table.transact(() => {
        for (const need of needs) {
          table.addNeed(requestId, need.target, consumer, need.access,
            step === 'save' ? (need.access === 'readwrite' ? 'save' : 'source') : need.access === 'readwrite' ? 'output' : 'input');
        }
      }),
      state: (requestId, consumer, need) => table.needState(requestId, need.target, consumer),
      drop: (requestId, consumer) => table.dropConsumer(requestId, consumer),
      close: (requestId, reason) => table.setLifecycle(requestId, 'closed',
        ['stopped', 'abandoned', 'coordinator-gone', 'reload'].includes(reason) ? reason as 'stopped' : 'done'),
    },
    // As src/extension.ts: the request's lifecycle row follows its wait, and the marker records each need's state.
    waitChanged: (change) => {
      if (change.ended?.closeNow) table.setLifecycle(change.requestId, 'closed',
        ['stopped', 'abandoned', 'coordinator-gone', 'reload'].includes(change.ended.reason) ? change.ended.reason as 'stopped' : 'done');
      else if (!change.ended) table.setLifecycle(change.requestId, change.needs.length ? 'waiting' : 'running');
      return ledger.updateAwaitingAccess({
      coordinatorId: change.coordinatorId, correlationId: change.correlationId,
      needs: change.needs.map((need) => {
        const state = table.targetState(change.requestId, need.target);
        return { label: need.label, path: need.target, access: need.access, step: need.step, ...(state ? { state } : {}) };
      }),
      ...(change.ended ? { ended: change.ended } : {}),
      ...(change.abandoned ? { abandoned: change.abandoned } : {}),
      });
    },
  });

  // As src/extension.ts: the run marker records each need's state as it is now.
  table.onChange((change) => refs.restated(change.requests));

  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); workerTurn = message.correlationId; workerRequest = mgr.currentRequestId('pm'); });
  const results = new Map<string, string>();
  const preparing: Array<() => void> = [];
  let receiptChanged: CoordinatorRuntimePort['publishDelegationReceiptChange'];
  const team = new TeamTools('pm', adapter.makeTeamView(), bus, {
    timeoutMs: 60_000, cwd: root, evidenceEnabled: true, taskInputResolver: resolver, taskResume: refs,
    ...(options.waitForTaskAdmission ? { waitForTaskAdmission: true } : {}),
    turnOrigin: () => ({ correlationId: mgr.currentTurnCorrelationId('pm'), turnId: mgr.currentTurnId('pm') }),
    onDelegationRefused: (event) => ledger.recordRefusedDispatch(event),
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched(event),
    onDelegationEvidence: ({ handle, outcome, evidence, agentId, executionEnded }) =>
      ledger.recordDelegationEvidence({ handle, outcome, evidence, agentId, executionEnded }),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    // As OrchestrationHostAdapter forwards it to the runtime port; with the chat on screen, the port is extension.ts's own.
    onTurnDelegationReceiptChanged: (event) => receiptChanged?.('pm', event),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
    // As OrchestrationHostAdapter records them: the result waits for delivery, then is placed into a PM turn.
    onAsyncResultDelivered: (handle, via) => ledger.recordDeliveryDelivered(handle, via),
    onAsyncResultReady: (result) => {
      results.set(result.handle, result.text);
      const identity = ledger.resultIdentity('pm', result.handle);
      if (identity) ledger.recordResultSettlement(identity, result.outcome?.status === 'failed' ? 'failed' : 'ready');
      ledger.recordDeliveryPending(result.handle);
      return options.wake
        ? mgr.queueAsyncDelegationWake('pm', result, () => team.isAsyncResultReady(result.handle), () => team.consumeAsyncResult(result.handle),
          () => new Promise<void>((resolve) => { preparing.push(resolve); }))
        : true;
    },
  });

  // One item per request and target, shared by every agent's offer, as src/extension.ts wires it.
  const wakesQueued: number[] = [];
  const items = new PathAccessRequestItems({ granted: () => {
    const wakes = refs.readyWakes();
    wakesQueued.push(wakes.length);
    for (const wake of wakes) mgr.queueAccessWake(wake.coordinatorId, wake);
  } }, table);
  const shown = new Map<string, PathAccessItem>();
  let chat: ChatViewProvider | undefined;
  const told: Array<{ agentId: string; requestId?: string; text?: string }> = [];
  /** Every notice an offer put up, in order. */
  const presented: Array<{ agentId: string; named: string; cause: string; upgrade?: boolean }> = [];
  let choice: Choice = { permission: 'read', lifetime: 'request' };
  const offerFor = (agentId: string) => createPathAccessOffer({
    owner: consent,
    agentId,
    canOffer: () => true,
    captureRequest: () => {
      const requestId = agentId === 'dev' ? workerRequest : mgr.currentRequestId(agentId);
      return requestId ? { requestId, isCurrent: () => true, requestCurrent: () => mgr.requestOwned(requestId) } : undefined;
    },
    present: async (named, cause, notice) => { presented.push({ agentId, named, cause, upgrade: notice.upgrade }); return false; },
    choose: async () => await choice,
    // As src/extension.ts: the item is drawn in the agent's chat (the chat view runs only when a test asks for it).
    item: (item) => { shown.set(`${agentId} ${item.id}`, item); chat?.showPathAccessItem(agentId, pathAccessItemView(item)); },
    granted: (_grant, _current, requestId) => {
      if (!requestId) return;
      // As src/extension.ts: the waiting work's wake is how its coordinator is told.
      if (refs.waitsOn(agentId, requestId)) { told.push({ agentId, requestId }); return; }
      const notice = refs.grantNotice(agentId, requestId, 'Host scope update: access is now available.');
      told.push({ agentId, requestId, text: notice.text });
      mgr.tellFileAccessGrant(agentId, requestId, notice.text, (report) => notice.report(report));
    },
    unavailable: () => undefined,
    requestEnded: () => undefined,
    refused: (named, request, access) => refs.capture(agentId, request.requestId, named, access),
  }, items);
  offers.set('pm', offerFor('pm'));
  offers.set('dev', offerFor('dev'));

  // The chat, as the person sees it: the real ChatViewProvider in a sidebar view, its page booted from the HTML it
  // serves, every post delivered both ways. The bus-to-chat reply adapter and the status redraw are extension.ts's own.
  let screen: ReturnType<typeof chatScreen> | undefined;
  if (options.chat) {
    const memento = new Map<string, unknown>();
    const normalizeEpoch = productionWiring('normalizeEpoch', {});
    // This harness has no Job outcome refresh of extension.ts waiting for a reply to bring forward.
    const deliverReply = productionWiring('deliverReply', { get chatViewProvider() { return chat; }, flushJobOutcomeSync: () => undefined });
    chat = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'PM', role: 'project-manager' }, { id: 'dev', name: 'Dev', role: 'senior-dev' }],
      send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
      onReply: productionWiring('onReply', {
        messageBus: bus, resolveAgentName: (id: string) => (id === 'pm' ? 'PM' : id), cliRuntimeFailureNotice: () => undefined,
        parseDelegationCounts, parseChatVerbatim, parseResponseOutcome, parseTurnOutcomeReceipt,
        parseChatTurnTrigger, parseTurnInterruption, emptyReplyNotice, normalizeEpoch, deliverReply,
        // v0.9.110: the adapter reads the request of the turn that ended from the real session manager.
        sessionManager: mgr,
      }) as ChatViewDeps['onReply'],
      state: { get: (key: string) => memento.get(key), update: async (key: string, value: unknown) => { memento.set(key, structuredClone(value)); } },
      getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
    } as unknown as ChatViewDeps);
    chat.selectAgent('pm');
    // src/extension.ts's own: the PM live strip, connected to the session manager, the access table, the ledger and the
    // chat; and a late receipt, which patches its reply's footer, counts what is still starting and redraws the strip.
    const live = productionWiring('pmLive', { pmLive: undefined, connectPmLive, sessionManager: mgr, accessTable: table,
      runLedger: ledger, chatViewProvider: chat }) as ReturnType<typeof connectPmLive>;
    cleanups.push(() => live.dispose());
    // v0.9.103 (G4): the receipt also reaches its turn's request closeout; ActivatedExtension.flows proves that through
    // activate(). Here it is recorded only.
    receiptChanged = productionWiring('publishDelegationReceiptChange', { sessionManager: mgr, chatViewProvider: chat, pmLive: live,
      noteCloseoutReceipt: (agentId: string, turnId: string, receipt: unknown) => { closeoutReceipts.push({ agentId, turnId, receipt }); } }) as typeof receiptChanged;
    screen = chatScreen(chat);
  }

  const itemsOf = (agentId: string) => [...shown].filter(([key]) => key.startsWith(`${agentId} `)).map(([, item]) => item);
  const itemFor = (target: string, agentId = 'pm', requestId?: string) => {
    const wanted = path.resolve(target).toLowerCase();
    const found = itemsOf(agentId).filter((item) => path.resolve(item.target).toLowerCase() === wanted
      && (!requestId || item.requestId === requestId));
    return found.at(-1);
  };

  const h = {
    root, source, output, outDir, inside, consent, table, roster, configs, bus, mgr, pm, team, refs, assigned, results, shown, told, wakesQueued, items, presented,
    /** The extension's workspace state, and the PM reply store kept in it. */
    workspaceState, pmReplies,
    /** The PM's chat on screen, when the host was made with `chat`. */
    screen: () => { expect(screen, 'a host made with chat').toBeDefined(); return screen!; },
    /** The backend the manager made last for this agent: after a restart, the new one. */
    backendFor: (id: string) => backends.get(id)!,
    ledger: () => ledger,
    /** Storage has prepared every result wake that waits for it. */
    finishPrepare: async () => { preparing.splice(0).forEach((resolve) => resolve()); await flush(); },
    setChoice: (next: Choice | Promise<Choice | undefined> | undefined) => { choice = next as Choice; },
    itemFor,
    itemsOf,
    offer: (agentId: string, target: string, cause: 'refused' | 'named' = 'refused', access?: 'read' | 'readwrite') =>
      offers.get(agentId)!(target, cause, access),
    /** The person's message to the PM starts a turn of a new request. */
    ask: async (instruction = 'Summarise the lease into the output folder.') => {
      const message = bus.send('user', 'pm', 'ask.question', { instruction }) as Message;
      await flush();
      return { message, requestId: mgr.currentRequestId('pm')! };
    },
    /** The PM's dispatch_task, in its turn now. */
    dispatch: async (args: Record<string, unknown>) => {
      team.beginTurnContentReceipts();
      return (await team.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Summarise the lease.', ...args })).output;
    },
    cancel: async (handle: string) => (await team.runOutcome('cancel_task', { handle })).output,
    /** The PM's turn ends with this reply. */
    reply: async (text = 'Waiting for the user\'s access.') => {
      pm.emit({ kind: 'turn_complete', result: { text, isError: false } } as BackendEvent);
      await flush();
    },
    /** The person chooses Grant access on the item for this target, as it shows in this agent's chat. */
    grant: async (target: string, next: Choice, agentId = 'pm', requestId?: string) => {
      choice = next;
      const item = itemFor(target, agentId, requestId);
      expect(item, `an item for ${target}`).toBeDefined();
      item!.grant();
      await flush();
    },
    /** The worker's real file tools, under the request's grants. */
    worker: () => {
      const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev');
      tools.setLivePathAccess(() => consent.pathAccessFor(workerRequest));
      // As src/extension.ts: a refusal says what the refused call needed.
      tools.setOutsideRootObserver((target, access) => offers.get('dev')!(target, 'refused', access));
      return tools;
    },
    /** The worker's reply for this handle. */
    workerReply: async (handle: string, changedFiles: string[]) => {
      bus.send('dev', 'pm', 'task.complete', { instruction: changedFiles.length ? 'Saved the summary.' : 'Could not save it.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles } } }, 'normal', handle);
      await flush();
      expect(team.consumeAsyncResult(handle)).toBe(true);
    },
    run: (correlationId: string) => ledger.snapshot().find((row) => row.correlationIds.includes(correlationId)),
    job: (correlationId: string) => {
      const run = h.run(correlationId)!;
      const outcome = projectJobOutcome(run.id, ledger.get(run.id), () => undefined);
      if (outcome.state !== 'available') throw new Error(`job outcome ${outcome.state}`);
      return outcome;
    },
  };
  return h;
}

type Host = Awaited<ReturnType<typeof host>>;

/** The chat page of a real ChatViewProvider in a sidebar view: what it shows, and a click on a button it shows. */
function chatScreen(chat: ChatViewProvider) {
  let page: WebviewBootResult | undefined;
  const queued: unknown[] = [];
  let fromPage: ((message: unknown) => void) | undefined;
  const deliver = (message: unknown) => { for (const listener of page?.listeners.message ?? []) listener({ data: message }); };
  const view = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {},
      postMessage: (message: unknown) => { if (page) deliver(message); else queued.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { fromPage = listener; return { dispose() {} }; },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    /** v0.9.103: each time the chat asks VS Code to show this view, with its preserveFocus. */
    shows: [] as Array<boolean | undefined>,
    show(preserveFocus?: boolean) { this.shows.push(preserveFocus); },
  };
  chat.resolveWebviewView(view as never, undefined as never, undefined as never);
  page = bootWebviewScript(view.webview.html);
  let sent = 0;
  const pump = async () => {
    for (const message of queued.splice(0)) deliver(message);
    while (sent < page!.postedMessages.length) fromPage?.(page!.postedMessages[sent++]);
    await flush();
  };
  const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
  const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
  const transcript = () => page!.elements.get('transcript');
  return {
    pump,
    /** v0.9.103: the view's show() calls, and whether it is shown. */
    view,
    /** The text of every reply footer on screen, top to bottom. */
    footers: () => descendants(transcript()).filter((node) => node.className === 'turn-footer').map(text),
    /** The PM live strip above the message box, one entry per line; empty when it is hidden. */
    strip: (): string[] => {
      // v0.9.103 (slice 3 §4.4): #pmLive is the wrapper; its lines are in #pmLiveLines.
      const node = page!.elements.get('pmLive') as any;
      const lines = page!.elements.get('pmLiveLines') as any;
      return !node || node.hidden ? [] : (lines?.children ?? []).map(text);
    },
    /** The person clicks Continue on the strip; returns what the message box then holds. */
    continueFromStrip: (): string => {
      const node = page!.elements.get('pmLiveLines') as any;
      const button = descendants(node).find((child) => child.textContent === 'Continue');
      expect(button, 'Continue on the strip').toBeDefined();
      page!.dispatchElementEvent(button, 'click');
      return String((page!.elements.get('input') as any).value ?? '');
    },
    /** The person clicks the button labelled `label` on the card whose title starts with `title`. */
    click: async (title: string, label: string) => {
      await pump();
      const card = descendants(transcript()).find((node) => String(node.className).includes('outcome-repair')
        && descendants(node).some((child) => String(child.className) === 'appr-title' && String(child.textContent).startsWith(title)));
      expect(card, `a card titled ${title}`).toBeDefined();
      const button = descendants(card).find((node) => node.textContent === label);
      expect(button, `${label} on ${title}`).toBeDefined();
      page!.dispatchElementEvent(button, 'click');
      await pump();
      await flush();
      await pump();
    },
  };
}

/**
 * The PM's first turn: the dispatch waits for the lease, and the PM replies. Returns the waiting request. Its output is in
 * the workspace, so the lease is all it waits for: what these tests look at is the wait itself.
 */
async function waitingForLease(h: Host) {
  const { message, requestId } = await h.ask();
  const result = await h.dispatch({ contract: leaseContract(h.source, h.inside) });
  await h.reply();
  return { message, requestId, result, handle: WAIT.exec(result)?.[1] ?? '' };
}

describe('v0.9.101 H2a: T2 with nothing granted, a dispatch waits for access and resumes in its request', () => {
  it('1. the dispatch waits: needs-access, no teammate, the request stays owned, the run is not closed by the reply, and the outcome says Waiting for access', async () => {
    const h = await host();
    const { message, requestId, result, handle } = await waitingForLease(h);
    expect(result).toBe(`Task "${handle}" is prepared and waiting for the user's Read access to File lease.txt (${h.source}). `
      + 'UnodeAi has asked them. Do not dispatch it again. When it can run, you will be told in this request, with a resume_ref. '
      + `If the user no longer wants it, call cancel_task with handle "${handle}".`);
    expect(result).not.toMatch(/no-executor/);
    expect(h.assigned).toEqual([]);
    // The PM's turn ended normally; nothing runs and nothing is held for the task.
    expect(h.mgr.get('pm')!.status).toBe('idle');
    expect(h.mgr.requestOwned(requestId)).toBe(true);
    expect(h.mgr.requestHasStructuredPreparation('pm', requestId)).toBe(true);
    const run = h.run(message.id)!;
    expect(run.status).toBe('open');
    expect(run.awaitingAccess).toMatchObject({ needs: [{ label: 'File lease.txt', path: h.source, access: 'read', step: 'dispatch' }] });
    expect(run.refusedDispatches).toEqual([expect.objectContaining({ taskState: 'needs-access', handle })]);
    // What the turn waits for, from the real ledger, as the PM's strip says it.
    const outcomes = h.ledger().dispatchOutcomesBetween('pm', new Date(0).toISOString(), new Date(Date.now() + 1000).toISOString(), message.id);
    expect(outcomes.refused).toEqual([]);
    expect(accessLine(outcomes.waitingForAccess ?? [])).toBe(`Waiting for your access: Read for File lease.txt (${h.source}). Choose Grant access on its item.`);
    // The item asks for the lease, once, in the PM's chat.
    expect(h.itemFor(h.source)).toMatchObject({ state: 'needs-access', requestId });
  });

  it('2. the lease\'s Read wakes the PM once in that request with a resume_ref; the dispatch with it is admitted, replaces nothing, and the run no longer waits', async () => {
    const h = await host();
    const { message, requestId, handle } = await waitingForLease(h);
    expect(h.pm.turns).toHaveLength(1);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    const wake = h.pm.turns[1];
    expect(wake).toContain('[UnodeAi] Access granted for your earlier request "Summarise the lease in English and Traditional Chinese.".');
    expect(wake).toContain(`Its task "${handle}" can run now: call dispatch_task with agent "dev", resume_ref`);
    expect(wake).toContain('This turn belongs to that request.');
    // The wake is a turn of the waiting request, on its own thread.
    expect(h.mgr.currentRequestId('pm')).toBe(requestId);
    expect(h.mgr.currentTurnCorrelationId('pm')).toBe(message.id);
    const ref = REF.exec(wake)![1];
    const dispatched = await h.dispatch({ resume_ref: ref });
    expect(dispatched).toMatch(/^Dispatched contract contract-/);
    expect(dispatched).toContain(`The task "${handle}" that waited for access is resumed by this task.`);
    expect(h.assigned).toHaveLength(1);
    const run = h.run(message.id)!;
    expect(run.delegations).toHaveLength(1);
    expect(run.delegations[0].replacesHandle).toBeUndefined();
    expect(run.awaitingAccess?.needs).toEqual([]);
    expect(h.refs.hasWaiting(requestId)).toBe(false);
    // A second dispatch with the same ref is refused: it was used.
    expect(await h.dispatch({ resume_ref: ref })).toMatch(/cannot be used: it was already used\./);
    expect(h.assigned).toHaveLength(1);
  });

  it('4. reverse order: the output\'s Read + Write owes no wake; the lease\'s Read then owes one, and the worker saves in its first attempt; Complete', async () => {
    const h = await host();
    const { message } = await h.ask();
    const result = await h.dispatch({ contract: leaseContract(h.source, h.output) });
    const handle = WAIT.exec(result)![1];
    // The output's folder, as the request's start names it: its own item.
    h.offer('pm', h.outDir, 'named');
    await h.reply();
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    // The dispatch also needs the lease: nothing became runnable, and nothing woke.
    expect(h.wakesQueued).toEqual([0]);
    expect(h.pm.turns).toHaveLength(1);
    // The lease's Read makes the dispatch runnable: one wake.
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    const ref = REF.exec(h.pm.turns[1])![1];
    const dispatched = await h.dispatch({ resume_ref: ref });
    const task = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    // The worker reads the lease and saves the summary in this first attempt: the output was writable already.
    const tools = h.worker();
    expect((await tools.run('read_file', { path: h.source })).status).toBe('success');
    const saved = await tools.run('write_file', { path: h.output, content: 'SUMMARY' });
    expect(saved.status).toBe('success');
    expect(readFileSync(h.output, 'utf8')).toBe('SUMMARY');
    await h.reply('Dispatched.');
    await h.workerReply(task, [saved.path!]);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'accepted' })).toMatch(/^Recorded/);
    h.bus.send('pm', 'user', 'task.complete', { instruction: 'Saved the summary.' }, 'normal', message.id);
    const job = h.job(message.id);
    expect(job.completion).toBe('complete');
    expect(job.remaining.access).toBeUndefined();
    expect(h.pm.turns).toHaveLength(2);
    expect(handle).not.toBe('');
  });

  it('5a. one of two inputs granted owes no wake; the second owes exactly one', async () => {
    const h = await host();
    const annex = path.join(folder({ 'annex.txt': 'ANNEX' }), 'annex.txt');
    await h.ask();
    const contract = leaseContract(h.source, h.inside);
    contract.inputs = [...(contract.inputs as object[]), { input_id: 'annex', kind: 'workspacePath', path: annex, purpose: 'The annex',
      required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] } }];
    const result = await h.dispatch({ contract });
    expect(result).toContain(`Read access to File lease.txt (${h.source}) and Read access to File annex.txt (${annex})`);
    await h.reply();
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.wakesQueued).toEqual([0]);
    expect(h.pm.turns).toHaveLength(1);
    await h.grant(annex, { permission: 'read', lifetime: 'request' });
    expect(h.wakesQueued).toEqual([0, 1]);
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1].match(new RegExp(REF.source, 'g'))).toHaveLength(1);
  });

  it('5b. two waiting tasks made runnable by one grant share one wake, carrying a ref for each', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    const first = WAIT.exec(await h.dispatch({ contract: leaseContract(h.source, h.inside) }))![1];
    const second = WAIT.exec(await h.dispatch({ contract: { ...leaseContract(h.source, path.join(h.root, 'second.txt')),
      objective: 'List the lease\'s parties.' } }))![1];
    expect(first).not.toBe(second);
    await h.reply();
    expect(h.run(h.mgr.requestOriginTurnId(requestId) ?? '')?.awaitingAccess?.needs).toHaveLength(1);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    const wake = h.pm.turns[1];
    expect(wake).toContain(`Its task "${first}" can run now`);
    expect(wake).toContain(`Its task "${second}" can run now`);
    expect(wake.match(new RegExp(REF.source, 'g'))).toHaveLength(2);
    expect(wake.match(/This turn belongs to that request\./g)).toHaveLength(1);
  });

  it('5. a duplicate grant, or one that makes nothing new runnable, owes no wake', async () => {
    const h = await host();
    const { requestId } = await waitingForLease(h);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    // The same target again: its item is granted already, and nothing is chosen or owed.
    h.itemFor(h.source)!.grant();
    await flush();
    // Another grant of the request after the wake was consumed makes nothing new runnable.
    const other = await h.consent.requestPathAccess(h.outDir, { requestId, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    h.items.hooks.granted!(other!, requestId);
    await flush();
    expect(h.wakesQueued.at(-1)).toBe(0);
    expect(h.pm.turns).toHaveLength(2);
  });

  it('a grant revoked after the wake: the ref is refused precisely and the task waits again; a new grant wakes it once more', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    const ref = REF.exec(h.pm.turns[1])![1];
    for (const grant of h.consent.listPathAccess()) h.consent.revokePathAccess(grant.id);
    expect(await h.dispatch({ resume_ref: ref })).toMatch(new RegExp(`^Error: resume_ref ${ref} cannot be used: the file access it was `
      + 'issued for was revoked or has ended\\. Dispatch the work without resume_ref'));
    expect(h.assigned).toEqual([]);
    expect(h.refs.hasWaiting(a.requestId)).toBe(true);
    await h.reply('It still needs the lease.');
    expect(h.run(a.message.id)!.status).toBe('open');
    // A grant that leaves it waiting owes no wake, although its readiness changed since the last one.
    const other = await h.consent.requestPathAccess(h.outDir, { requestId: a.requestId, isCurrent: () => true },
      async () => ({ permission: 'read', lifetime: 'session' }));
    h.items.hooks.granted!(other!, a.requestId);
    await flush();
    expect(h.wakesQueued.at(-1)).toBe(0);
    expect(h.pm.turns).toHaveLength(2);
    await h.grant(h.source, { permission: 'read', lifetime: 'session' });
    expect(h.pm.turns).toHaveLength(3);
    const again = REF.exec(h.pm.turns[2])![1];
    expect(again).not.toBe(ref);
    expect(await h.dispatch({ resume_ref: again })).toMatch(/^Dispatched contract/);
    expect(h.assigned).toHaveLength(1);
  });

  it('a wake queued behind a busy turn is checked again at delivery: access revoked meanwhile delivers nothing, and a later grant owes it again', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    await h.ask('Something else first.');
    await h.grant(h.source, { permission: 'read', lifetime: 'request' }, 'pm', a.requestId);
    expect(h.wakesQueued).toEqual([1]);
    for (const grant of h.consent.listPathAccess()) h.consent.revokePathAccess(grant.id);
    await h.reply('Done with that.');
    // The other request's turn ended; the wake no longer holds, and nothing started.
    expect(h.pm.turns).toHaveLength(2);
    expect(h.mgr.get('pm')!.status).toBe('idle');
    await h.grant(h.source, { permission: 'read', lifetime: 'session' }, 'pm', a.requestId);
    expect(h.pm.turns).toHaveLength(3);
    expect(h.mgr.currentRequestId('pm')).toBe(a.requestId);
  });

  // The Owner, 2026-11-07 (after the smoke of ba309ddb): everything the contract declares is asked for before the work
  // starts. Before, the dispatch ran once the lease was granted, the worker's save was refused, and the work then hung on
  // a second wait (A).
  it('the Owner\'s rule: T2 with nothing granted waits for the lease\'s Read and the output\'s Read + Write; the lease alone owes no wake; the output then owes one; the worker saves in its first attempt; Complete, nothing replaced', async () => {
    const h = await host();
    const { message } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const result = await h.dispatch({ contract: leaseContract(h.source, h.output) });
    const handle = WAIT.exec(result)![1];
    expect(result).toContain(`waiting for the user's Read access to File lease.txt (${h.source}) and Read + Write access to File summary.txt (${h.output}).`);
    expect(h.assigned).toEqual([]);
    await h.reply();
    const outcomes = h.ledger().dispatchOutcomesBetween('pm', new Date(0).toISOString(), new Date(Date.now() + 1000).toISOString(), message.id);
    expect(accessLine(outcomes.waitingForAccess ?? []))
      .toBe(`Waiting for your access: Read for File lease.txt (${h.source}); Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.wakesQueued).toEqual([0]);
    expect(h.pm.turns).toHaveLength(1);
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.wakesQueued).toEqual([0, 1]);
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1]).toContain(`Its task "${handle}" can run now`);
    const dispatched = await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] });
    expect(dispatched).toMatch(/^Dispatched contract/);
    expect(dispatched).not.toMatch(/may not write it yet/);
    const task = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    const tools = h.worker();
    expect((await tools.run('read_file', { path: h.source })).status).toBe('success');
    const saved = await tools.run('write_file', { path: h.output, content: 'SUMMARY' });
    expect(saved.status).toBe('success');
    await h.reply('Dispatched.');
    await h.workerReply(task, [saved.path!]);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'accepted' })).toMatch(/^Recorded/);
    h.bus.send('pm', 'user', 'task.complete', { instruction: 'Saved the summary.' }, 'normal', message.id);
    expect(h.job(message.id).completion).toBe('complete');
    expect(h.run(message.id)!.delegations.map((row) => row.replacesHandle)).toEqual([undefined]);
    expect(h.pm.turns).toHaveLength(2);
  });

  it('the Owner\'s rule: an output alone holds the dispatch: with every input readable, it waits for the output\'s Read + Write and starts on its grant', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const result = await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } });
    const handle = WAIT.exec(result)![1];
    expect(result).toContain(`waiting for the user's Read + Write access to File summary.txt (${h.output}).`);
    expect(h.assigned).toEqual([]);
    expect(h.refs.hasWaiting(requestId)).toBe(true);
    await h.reply();
    // A Read of the folder is not Write: nothing becomes runnable.
    const read = await h.consent.requestPathAccess(h.outDir, { requestId, isCurrent: () => true, requestCurrent: () => h.mgr.requestOwned(requestId) },
      async () => ({ permission: 'read', lifetime: 'request' }));
    h.items.hooks.granted!(read!, requestId);
    await flush();
    expect(h.wakesQueued).toEqual([0]);
    expect(h.pm.turns).toHaveLength(1);
    h.consent.revokePathAccess(read!.id);
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1]).toContain(`Its task "${handle}" can run now`);
    expect(await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] })).toMatch(/^Dispatched contract/);
    expect(h.assigned).toHaveLength(1);
  });

  // Audit of d558ea83: Read chosen for an output the dispatch waits for showed its item as granted, and the same item could
  // not be upgraded: no picker, no wake, no worker.
  it('an output\'s Read keeps its item open: the item asks for Read + Write, the Read stays as chosen, and Read + Write from the same item wakes the PM once and the worker saves', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    const result = await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } });
    const handle = WAIT.exec(result)![1];
    await h.reply();
    await h.grant(h.output, { permission: 'read', lifetime: 'request' });
    // What was chosen is kept, and only that: no silent upgrade.
    expect(h.consent.pathAccessFor(requestId).map((grant) => grant.permission)).toEqual(['read']);
    expect(h.refs.hasWaiting(requestId)).toBe(true);
    expect(h.pm.turns).toHaveLength(1);
    expect(h.itemFor(h.output)).toMatchObject({ state: 'needs-write' });
    await h.grant(h.output, { permission: 'readwrite', lifetime: 'request' });
    expect(h.consent.pathAccessFor(requestId).map((grant) => grant.permission)).toContain('readwrite');
    expect(h.itemFor(h.output)).toMatchObject({ state: 'granted' });
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1]).toContain(`Its task "${handle}" can run now`);
    const dispatched = await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] });
    const task = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    const saved = await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' });
    expect(saved.status).toBe('success');
    await h.reply('Dispatched.');
    await h.workerReply(task, [saved.path!]);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'accepted' })).toMatch(/^Recorded/);
    h.bus.send('pm', 'user', 'task.complete', { instruction: 'Saved the summary.' }, 'normal', message.id);
    expect(h.job(message.id).completion).toBe('complete');
    expect(h.pm.turns).toHaveLength(2);
  });

  it('an output\'s folder named as the request starts and given Read keeps asking for Read + Write once the dispatch waits for it', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    await h.grant(h.outDir, { permission: 'read', lifetime: 'request' });
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted' });
    const contract = { ...leaseContract(h.source, h.output), inputs: [], outputs: [{ output_id: 'summary-dir', path: h.outDir, kind: 'directory', required: true }] };
    expect(await h.dispatch({ contract })).toMatch(WAIT);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'needs-write' });
    await h.reply();
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.consent.pathAccessFor(requestId).map((grant) => grant.permission).sort()).toEqual(['read', 'readwrite']);
    // The Read chosen during the PM's turn owed it a notice turn; the wake comes once that turn ends, never beside it.
    if (h.mgr.get('pm')!.status === 'running') await h.reply('Noted.');
    expect(h.pm.turns.filter((turn) => turn.includes('can run now'))).toHaveLength(1);
  });

  // Smoke of ba309ddb, A: a refused write of a file in the output folder made its wait ask for Read of a file still to be
  // written, and the folder's Read + Write never made it runnable. Here the folder's grant is taken back after the
  // dispatch (the fallback for access lost once the work started): the wait asks for what the refused call needed.
  it('the fallback: a write refused after the output\'s grant was taken back waits for Read + Write of the file, and the folder\'s grant wakes the PM once; the retry saves', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const held = await h.consent.requestPathAccess(h.outDir, { requestId, isCurrent: () => true, requestCurrent: () => h.mgr.requestOwned(requestId) },
      async () => ({ permission: 'readwrite', lifetime: 'request' }));
    const contract = { ...leaseContract(h.source, h.output), inputs: [], outputs: [{ output_id: 'summary-dir', path: h.outDir, kind: 'directory', required: true }] };
    const dispatched = await h.dispatch({ contract });
    expect(dispatched).toMatch(/^Dispatched contract/);
    const handle = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    h.consent.revokePathAccess(held!.id);
    expect((await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' })).status).toBe('refused');
    await h.reply('Dispatched.');
    await h.workerReply(handle, []);
    expect(h.results.get(handle)).toContain(`Task ${handle} did not finish. It waits for the user's Read + Write access to File summary.txt (${h.output}).`);
    expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ path: h.output, access: 'readwrite', step: 'retry' })]);
    await h.reply('The save waits for the folder.');
    const before = h.pm.turns.length;
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.wakesQueued.at(-1)).toBe(1);
    expect(h.pm.turns).toHaveLength(before + 1);
    expect(h.pm.turns.at(-1)).toContain(`Task ${handle} stopped for lack of this access and can be retried now`);
    expect(h.mgr.currentRequestId('pm')).toBe(requestId);
    const retried = await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] });
    expect(retried).toContain(`Task ${handle} will be recorded as replaced by this task`);
    expect((await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' })).status).toBe('success');
    expect(readFileSync(h.output, 'utf8')).toBe('SUMMARY');
  });

  it('existence is not access: a refused read of a file not there yet waits for Read, and its folder\'s Read makes it runnable', async () => {
    const h = await host();
    const { message } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const dispatched = await h.dispatch({ contract: { ...leaseContract(h.source, h.inside), inputs: [] } });
    const handle = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    const notYet = path.join(h.outDir, 'draft-notes.txt');
    expect((await h.worker().run('read_file', { path: notYet })).status).toBe('refused');
    await h.reply('Dispatched.');
    await h.workerReply(handle, []);
    expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ path: notYet, access: 'read', step: 'retry' })]);
    await h.reply('It waits for the folder.');
    const before = h.pm.turns.length;
    await h.grant(h.outDir, { permission: 'read', lifetime: 'request' });
    expect(existsSync(notYet)).toBe(false);
    expect(h.pm.turns).toHaveLength(before + 1);
    expect(h.pm.turns.at(-1)).toContain(`Task ${handle} stopped for lack of this access and can be retried now`);
  });

  it('6. a For this request grant still holds after the PM\'s reply while the request waits, and serves only that request', async () => {
    const h = await host();
    const { requestId } = await waitingForLease(h);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    const grants = h.consent.pathAccessFor(requestId);
    expect(grants.map((grant) => grant.lifetime)).toEqual(['request']);
    // It was chosen after the PM's reply: the waiting request kept it owned, so it was not taken back.
    expect(grants[0].current()).toBe(true);
    expect(h.consent.pathAccessFor('another-request')).toEqual([]);
  });
});

describe('v0.9.101 H2a: a waiting request stays separate, and how it ends', () => {
  it('1. while A waits a new message starts B; A\'s grant wakes the PM under A only after B\'s turn, never beside it; A\'s request grant is not B\'s, a session grant is', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    const b = await h.ask('What is the capital of France?');
    expect(b.requestId).not.toBe(a.requestId);
    expect(h.mgr.get('pm')!.status).toBe('running');
    // Granted on A's item while the PM runs B: nothing starts beside B.
    await h.grant(h.source, { permission: 'read', lifetime: 'request' }, 'pm', a.requestId);
    expect(h.pm.turns).toHaveLength(2);
    expect(h.consent.pathAccessFor(b.requestId)).toEqual([]);
    expect(h.consent.pathAccessFor(a.requestId)).toHaveLength(1);
    await h.reply('Paris.');
    // B's turn ended: A's wake runs now, as A's turn.
    expect(h.pm.turns).toHaveLength(3);
    expect(h.pm.turns[2]).toContain('This turn belongs to that request.');
    expect(h.mgr.currentRequestId('pm')).toBe(a.requestId);
    expect(h.mgr.currentTurnCorrelationId('pm')).toBe(a.message.id);
    // B's own reply closed nothing of A.
    expect(h.run(a.message.id)!.status).toBe('open');
    const ref = REF.exec(h.pm.turns[2])![1];
    expect(await h.dispatch({ resume_ref: ref })).toMatch(/^Dispatched contract/);
    expect(h.run(a.message.id)!.delegations).toHaveLength(1);
    // A session grant reaches both requests.
    const session = await h.consent.requestPathAccess(h.outDir, { requestId: a.requestId, isCurrent: () => true },
      async () => ({ permission: 'read', lifetime: 'session' }));
    expect(h.consent.pathAccessFor(b.requestId).map((grant) => grant.id)).toEqual([session!.id]);
  });

  it('2. Stop while A waits ends it: Partial "Stopped while waiting", its request grants revoked, and a later grant on its item starts nothing', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    // A Read for another of A's targets, chosen For this request, before the Stop.
    const held = await h.consent.requestPathAccess(h.outDir, { requestId: a.requestId, isCurrent: () => true, requestCurrent: () => h.mgr.requestOwned(a.requestId) },
      async () => ({ permission: 'read', lifetime: 'request' }));
    expect(held).toBeDefined();
    h.mgr.interrupt('pm');
    await flush();
    expect(h.refs.hasWaiting(a.requestId)).toBe(false);
    expect(h.consent.pathAccessFor(a.requestId)).toEqual([]);
    const run = h.run(a.message.id)!;
    expect(run.status).toBe('closed');
    expect(run.closeoutCompletionState).toBe('partial');
    expect(h.job(a.message.id).remaining.access?.text).toBe(`Stopped while waiting for access: Read for File lease.txt (${h.source}).`);
    // A session grant on A's item afterwards: nothing wakes, nothing is dispatched.
    await h.grant(h.source, { permission: 'read', lifetime: 'session' });
    expect(h.pm.turns).toHaveLength(1);
    expect(h.assigned).toEqual([]);
  });

  it('3. cancel_task on A\'s waiting handle from B\'s turn ends A Partial "Abandoned", and B is untouched', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    const b = await h.ask('Drop the lease summary, I do not need it any more.');
    const cancelled = await h.cancel(a.handle);
    expect(cancelled).toBe(`Abandoned task "${a.handle}": it was waiting for access and never started, so nothing was stopped. A later grant does not start it. Tell the user it was not done.`);
    expect(h.mgr.currentRequestId('pm')).toBe(b.requestId);
    expect(h.mgr.get('pm')!.status).toBe('running');
    const run = h.run(a.message.id)!;
    expect(run.status).toBe('closed');
    expect(h.job(a.message.id).remaining.access?.text).toMatch(/^Abandoned while waiting for access: Read for File lease\.txt/);
    expect(h.job(a.message.id).completion).toBe('partial');
    // The same handle again is no waiting task any more.
    expect(await h.cancel(a.handle)).toMatch(/^Error: no assignment with handle/);
    await h.reply('Dropped it.');
    await h.grant(h.source, { permission: 'read', lifetime: 'session' }, 'pm', a.requestId);
    expect(h.pm.turns).toHaveLength(2);
  });

  it('4. the coordinator removed while A waits: A ends Partial, and a later grant starts nothing', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    await h.mgr.remove('pm');
    await flush();
    expect(h.refs.hasWaiting(a.requestId)).toBe(false);
    const run = h.run(a.message.id)!;
    expect(run.status).toBe('closed');
    expect(h.job(a.message.id).remaining.access?.text).toMatch(/^The wait for access ended because its coordinator is no longer available/);
    const before = h.pm.turns.length;
    await h.grant(h.source, { permission: 'read', lifetime: 'session' });
    expect(h.pm.turns).toHaveLength(before);
    expect(h.assigned).toEqual([]);
  });

  // Audit H2a-1: the person replaced the waiting PM's model through the agent editor. The edit restarted the PM, but
  // the old wait stayed, its request grant stayed live, and a later grant ran the old request on the new backend.
  it('4b. the person replaces the waiting PM\'s model: A ends Partial as coordinator gone, its request grant ends, and a later grant starts nothing on the new backend', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    const held = await h.consent.requestPathAccess(h.outDir, { requestId: a.requestId, isCurrent: () => true,
      requestCurrent: () => h.mgr.requestOwned(a.requestId) }, async () => ({ permission: 'read', lifetime: 'request' }));
    expect(held).toBeDefined();
    h.mgr.get('pm')!.config.model = 'replacement-model';
    await h.mgr.configEdited('pm', { backendKindChanged: false, executionChanged: true });
    await flush();
    expect(h.refs.hasWaiting(a.requestId)).toBe(false);
    expect(h.mgr.requestOwned(a.requestId)).toBe(false);
    const run = h.run(a.message.id)!;
    expect(run.status).toBe('closed');
    expect(run.awaitingAccess?.ended?.reason).toBe('coordinator-gone');
    expect(h.job(a.message.id).remaining.access?.text).toMatch(/^The wait for access ended because its coordinator is no longer available/);
    expect(h.consent.pathAccessFor(a.requestId).some((grant) => grant.id === held!.id && grant.current())).toBe(false);
    const replacement = h.backendFor('pm');
    replacement.emit({ kind: 'ready' });
    await flush();
    await h.grant(h.source, { permission: 'read', lifetime: 'session' });
    expect(replacement.turns).toEqual([]);
    expect(h.assigned).toEqual([]);
  });

  it('4c. an edit that keeps the model and connection (a name, prompt or tools) leaves the wait, and its grant still wakes the PM once', async () => {
    const h = await host();
    const a = await waitingForLease(h);
    h.mgr.get('pm')!.config.name = 'Planner';
    await h.mgr.configEdited('pm', { backendKindChanged: false, executionChanged: false });
    await flush();
    expect(h.refs.hasWaiting(a.requestId)).toBe(true);
    expect(h.run(a.message.id)?.status).toBe('open');
    const restarted = h.backendFor('pm');
    restarted.emit({ kind: 'ready' });
    await flush();
    const before = restarted.turns.length;
    await h.grant(h.source, { permission: 'read', lifetime: 'session' });
    await flush();
    expect(restarted.turns.length).toBe(before + 1);
    expect(restarted.turns.at(-1)).toContain('This turn belongs to that request.');
  });

  it('5. a direct agent\'s ended request: the resend Continue goes only to the agent the message addressed (F1)', async () => {
    const consent = new SessionLocalReadScopeConsent(async () => false);
    const outside = folder({ 'notes.txt': 'notes' });
    const target = path.join(outside, 'notes.txt');
    const items = new PathAccessRequestItems();
    const resent: Array<{ agentId: string; to: string }> = [];
    const original = { id: 'm1', from: 'user', to: 'solo', type: 'ask.question', payload: { instruction: 'Read notes.' } } as unknown as Message;
    const shown = new Map<string, PathAccessItem>();
    let running = true;
    const offerFor = (agentId: string) => createPathAccessOffer({
      owner: consent, canOffer: () => true,
      captureRequest: () => ({ requestId: 'r-solo', isCurrent: () => true, requestCurrent: () => running }),
      present: async () => false, choose: async () => ({ permission: 'read', lifetime: 'session' }),
      item: (item) => { shown.set(agentId, item); },
      granted: () => undefined, unavailable: () => undefined, requestEnded: () => undefined,
      continuation: (requestId) => endedRequestContinuation({ agentId, hasStructuredPreparation: () => false,
        originalRequest: () => original, resubmit: async (request) => { resent.push({ agentId, to: request.to }); return true; } }, requestId),
    }, items);
    const solo = offerFor('solo');
    const helper = offerFor('helper');
    helper(target);
    solo(target);
    await flush();
    // One item for the request's target, shown to both.
    expect(shown.get('solo')!.id).toBe(shown.get('helper')!.id);
    running = false;
    // Granted from the helper's chat: Continue is still the request's own, to the agent it addressed.
    shown.get('helper')!.grant();
    await flush();
    expect(shown.get('helper')).toMatchObject({ state: 'granted', continuation: 'offered' });
    shown.get('helper')!.continueRequest!();
    await flush();
    expect(resent).toEqual([{ agentId: 'solo', to: 'solo' }]);
    // Once: a second click does nothing.
    shown.get('solo')!.continueRequest?.();
    await flush();
    expect(resent).toHaveLength(1);
  });
});

describe('v0.9.101 H2a, H3: one item per request and target', () => {
  it('the PM\'s named offer and the worker\'s refusal for one target are one item; one grant tells each participant, and no retry Continue exists', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    h.offer('pm', h.output, 'named');
    await flush();
    const pmItem = h.itemFor(h.output, 'pm')!;
    expect(pmItem).toBeDefined();
    // The worker of the same request is refused the same file. The contract does not declare it: the fallback for what
    // the dispatch could not ask for before the work started.
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [], outputs: [] } })).toMatch(/^Dispatched contract/);
    const refused = await h.worker().run('write_file', { path: h.output, content: 'x' });
    expect(refused.status).toBe('refused');
    await flush();
    const devItem = h.itemFor(h.output, 'dev')!;
    expect(devItem.id).toBe(pmItem.id);
    expect(new Set([...h.itemsOf('pm'), ...h.itemsOf('dev')].map((item) => item.id)).size).toBe(1);
    await h.grant(h.output, { permission: 'readwrite', lifetime: 'request' }, 'dev');
    // Both participants were told, in that request; nobody else.
    expect(h.told.map((entry) => entry.agentId).sort()).toEqual(['dev', 'pm']);
    expect(h.told.every((entry) => entry.requestId === requestId)).toBe(true);
    expect(h.itemFor(h.output, 'pm')).toMatchObject({ state: 'granted' });
    expect(h.itemFor(h.output, 'pm')!.continuation).toBeUndefined();
    expect(Object.keys(h.itemFor(h.output, 'pm')!)).not.toContain('continuationKind');
    // The grant is exactly the choice, into that request's store.
    expect(h.consent.pathAccessFor(requestId).map((grant) => [grant.permission, grant.lifetime])).toEqual([['readwrite', 'request']]);
  });

  it('a Read item later needing Read + Write is upgraded in place, and two requests keep separate items', async () => {
    const h = await host();
    const a = await h.ask();
    h.offer('pm', h.outDir, 'named');
    await flush();
    await h.grant(h.outDir, { permission: 'read', lifetime: 'request' });
    const first = h.itemFor(h.outDir, 'pm')!;
    h.offer('pm', h.outDir, 'refused');
    await flush();
    expect(h.itemFor(h.outDir, 'pm')).toMatchObject({ id: first.id, state: 'needs-write' });
    await h.reply('Done.');
    // The grant during A's turn owed A one more turn; it ends too.
    if (h.mgr.get('pm')!.status === 'running') await h.reply('Nothing else is left.');
    const b = await h.ask('Again, please.');
    h.offer('pm', h.outDir, 'named');
    await flush();
    const second = h.itemFor(h.outDir, 'pm', b.requestId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.requestId).toBe(b.requestId);
    expect(h.itemFor(h.outDir, 'pm', a.requestId)!.id).toBe(first.id);
  });

  it('a target named through a link is the same item as its real path', async () => {
    const h = await host();
    await h.ask();
    const link = path.join(folder(), 'linked-out');
    symlinkSync(h.outDir, link, 'junction');
    h.offer('pm', h.outDir, 'named');
    h.offer('pm', link, 'refused');
    await flush();
    const ids = new Set(h.itemsOf('pm').map((item) => item.id));
    expect(ids.size).toBe(1);
  });
});

describe('v0.9.101 H2a: a reload ends a wait for access and says what it waited for', () => {
  it('1. a fresh host with a stored wait naming two targets closes it Partial, names both with the dispatch text, and starts no turn', async () => {
    const h = await host();
    const second = path.join(folder({ 'annex.txt': 'ANNEX' }), 'annex.txt');
    const { message } = await h.ask();
    const contract = leaseContract(h.source, h.inside);
    contract.inputs = [...(contract.inputs as object[]), { input_id: 'annex', kind: 'workspacePath', path: second, purpose: 'The annex',
      required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] } }];
    expect(await h.dispatch({ contract })).toMatch(WAIT);
    await h.reply();
    const stored = JSON.parse(JSON.stringify(h.ledger().snapshot()));
    // The reload: a new host identity, the stored records only.
    const fresh = new RunLedger(stored, { host: { hostInstanceId: 'fresh-host', epoch: 'e2' } as never });
    expect(fresh.reconcileRestoredAwaitingAccess()).toBe(1);
    const run = fresh.snapshot().find((row) => row.correlationIds.includes(message.id))!;
    expect(run.status).toBe('closed');
    expect(run.closeoutCompletionState).toBe('partial');
    const outcome = projectJobOutcome(run.id, fresh.get(run.id), () => undefined);
    if (outcome.state !== 'available') throw new Error(outcome.state);
    expect(outcome.remaining.access?.text).toBe('The wait for access ended when the window reloaded: '
      + `Read for File lease.txt (${h.source}), Read for File annex.txt (${second}). The task had not been dispatched. `
      + 'Reload did not resume it. Send the request again to continue.');
    // Display facts only: no preparation, ref or grant comes back, and no turn starts.
    const turns = h.pm.turns.length;
    await flush();
    expect(h.pm.turns).toHaveLength(turns);
  });

  it('2. a wait whose marker never reached storage: the restored run names no access and claims none', async () => {
    const h = await host();
    const { message } = await h.ask();
    // An earlier task of the request was admitted and stored; the needs-access write after it was not.
    const first = await h.dispatch({ contract: { ...leaseContract(h.source, h.inside), inputs: [] } });
    expect(first).toMatch(/^Dispatched contract/);
    const stored = JSON.parse(JSON.stringify(h.ledger().snapshot()));
    expect(await h.dispatch({ contract: leaseContract(h.source, h.inside) })).toMatch(WAIT);
    expect(h.run(message.id)!.awaitingAccess).toBeDefined();
    const fresh = new RunLedger(stored, { host: { hostInstanceId: 'fresh-host', epoch: 'e2' } as never });
    fresh.reconcileRestoredActiveDelegations();
    expect(fresh.reconcileRestoredAwaitingAccess()).toBe(0);
    const run = fresh.snapshot().find((row) => row.correlationIds.includes(message.id))!;
    expect(run.awaitingAccess).toBeUndefined();
    expect(run.delegations[0].state).toBe('interrupted');
    expect(JSON.stringify(run)).not.toMatch(/waiting for access|lease\.txt \(/i);
  });

  it('the bounded list: nine needs show eight and "and 1 more"; a long path is cut and said to be', async () => {
    const ledger = new RunLedger();
    const long = `/x/${'d'.repeat(1100)}/file.txt`;
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', requestedAgent: 'dev', reason: 'waiting', originCorrelationId: 'c1',
      taskState: 'needs-access', awaitingAccess: [
        { label: 'File file.txt', path: long, access: 'read', step: 'save' },
        ...Array.from({ length: 8 }, (_, index) => ({ label: `File f${index}.txt`, path: `/x/f${index}.txt`, access: 'read' as const, step: 'dispatch' as const })),
      ] });
    const [run] = ledger.snapshot();
    expect(run.awaitingAccess!.needs).toHaveLength(8);
    expect(run.awaitingAccess!.omittedNeeds).toBe(1);
    expect(run.awaitingAccess!.needs[0]).toMatchObject({ shortened: true });
    expect(run.awaitingAccess!.needs[0].path).toHaveLength(1024);
    expect(run.awaitingAccess!.needs[0].path.endsWith('…')).toBe(true);
    const fresh = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot())), { host: { hostInstanceId: 'h2', epoch: 'e' } as never });
    fresh.reconcileRestoredAwaitingAccess();
    const closed = fresh.snapshot()[0];
    const outcome = projectJobOutcome(closed.id, fresh.get(closed.id), () => undefined);
    if (outcome.state !== 'available') throw new Error(outcome.state);
    expect(outcome.remaining.access!.text).toContain(' and 1 more (a path was shortened). A draft had been prepared; reload did not resume this work or repeat any save, and the draft was not kept.');
    expect(existsSync(long)).toBe(false);
  });
});

describe('v0.9.101 H2a: what stays as it was', () => {
  it('a candidate with any failure a grant cannot repair stays no-executor, and nothing waits', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    // The annex's folder is granted, and the annex in it does not exist: a missing input, not a missing grant.
    const annexDir = folder();
    const missing = path.join(annexDir, 'annex.txt');
    await h.consent.requestPathAccess(annexDir, { requestId, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    const result = await h.dispatch({ contract: leaseContract(missing, h.output) });
    expect(result).toMatch(/^Error: task state no-executor/);
    expect(result).toMatch(/missing-input/);
    // Beside an ungranted lease: one failure a grant would repair and one it would not. Nothing waits for that either.
    const mixed = leaseContract(h.source, h.output);
    mixed.inputs = [...(mixed.inputs as object[]), { input_id: 'annex', kind: 'workspacePath', path: missing, purpose: 'The annex',
      required: true, freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] } }];
    const both = await h.dispatch({ contract: mixed });
    expect(both).toMatch(/^Error: task state no-executor/);
    expect(both).toMatch(/grant-needed: required input "lease"/);
    expect(both).toMatch(/missing-input: required input "annex"/);
    expect(h.refs.hasWaiting(requestId)).toBe(false);
    await h.reply('It is missing.');
    expect(h.run(message.id)?.awaitingAccess).toBeUndefined();
  });
});

/**
 * Smoke of 7128f103: the PM's reply that ended its turn with the dispatch waiting for access also said "No assignment
 * close was recorded; no delegation result was recorded. Review the timeline and decide whether to continue or retry."
 * Through the real TeamTools and TaskResumeRefs of the waiting request, the real TeamMcpBridge and the real Claude CLI
 * backend's end of turn: the reply the person reads.
 */
describe('a reply that waits for access is not told to retry', () => {
  const claudePmReply = (h: Host, text: string) => {
    const backend = new ClaudeHeadlessBackend({ ...h.configs.pm, role: 'pm', backend: 'claude' } as AgentConfig, undefined, undefined,
      { teamMcpBridge: new TeamMcpBridge(h.team) });
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    (backend as unknown as { handleEvent(event: unknown): void }).handleEvent({ type: 'result', subtype: 'success', result: text });
    const complete = events.find((event) => event.kind === 'turn_complete') as Extract<BackendEvent, { kind: 'turn_complete' }> | undefined;
    return complete?.result.text;
  };

  it('the dispatch waits for access: the PM\'s reply carries its own words only', async () => {
    const h = await host();
    await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.output) })).toMatch(WAIT);
    expect(h.team.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: false, waitingForAccess: true });
    expect(claudePmReply(h, 'Waiting for your access to the lease and the output folder.'))
      .toBe('Waiting for your access to the lease and the output folder.');
  });

  it('a dispatch refused for another reason, with nothing waiting, still gets the host\'s closeout', async () => {
    const h = await host();
    await h.ask();
    await h.dispatch({ agent: 'nobody', contract: { ...leaseContract(h.source, h.inside), inputs: [] } });
    expect(h.team.coordinatorCloseoutState()).toMatchObject({ assignmentOpen: true, assignmentClosed: false });
    expect(h.team.coordinatorCloseoutState().waitingForAccess).toBeUndefined();
    expect(claudePmReply(h, 'I could not assign it.')).toContain('UnodeAi: No assignment close was recorded; no delegation result was recorded.');
  });
});

/**
 * Smoke of c2ec1f79, A: the person grants in the chat and the PM's reply on screen changes.
 * - src/extension.ts is parsed once, before the test's own time. Parsed in each host, it pushed the E flow past a
 *   mutation proof's 5 s on the CI runner (CI of f7dd744c).
 * - Run alone in a fresh process, as a mutation proof is, this one test also pays the first build of the chat page and
 *   its script. It has the suite's own budget (vitest.config.ts), as CheckpointRestoreSecurityControls.test has.
 */
describe('the waiting access on screen', () => {
  beforeAll(() => loadProductionWirings());

  it('A as the smoke met it (c2ec1f79): Grant access on a chat item changes what the PM\'s live strip says is missing, with no new PM turn and no status in the reply', async () => {
    const h = await host({ chat: true });
    const { requestId } = await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.output) })).toMatch(WAIT);
    await h.reply();
    await h.screen().pump();
    // The PM's turn ended with the wait: the strip names both targets; the reply's footer holds only its turn's facts.
    expect(h.screen().strip()).toEqual([
      `Waiting for your access: Read for File lease.txt (${h.source}); Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`]);
    expect(h.screen().footers().join(' ')).not.toContain('Waiting for');
    // The person clicks Grant access on the lease's item in the chat and picks Read for this request.
    h.setChoice({ permission: 'read', lifetime: 'request' });
    await h.screen().click('File lease.txt', 'Grant access');
    expect(h.consent.pathAccessFor(requestId).map((grant) => grant.permission)).toEqual(['read']);
    // The strip now says what is still missing, and no new PM turn ran.
    await flush();
    await h.screen().pump();
    expect(h.screen().strip()).toEqual([
      `Waiting for your access: Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`]);
    expect(h.pm.turns).toHaveLength(1);
  }, 30_000);

  // v0.9.103 (the Owner's field test of c51e3bb3, item 1): after Grant access the access picker had taken focus, and
  // VS Code did not give it back to the chat, so Tab did nothing there.
  it('after the picker Grant access opened has closed, the chat it was clicked in takes focus back, also when the person dismissed it; a hidden chat is not brought forward', async () => {
    const h = await host({ chat: true });
    await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.output) })).toMatch(WAIT);
    await h.reply();
    await h.screen().pump();
    const view = h.screen().view;
    h.setChoice({ permission: 'read', lifetime: 'request' });
    await h.screen().click('File lease.txt', 'Grant access');
    expect(view.shows).toEqual([false]);
    // Dismissed with Escape: the picker was still shown and has closed, so focus comes back all the same.
    h.setChoice(undefined);
    await h.screen().click('File summary.txt', 'Grant access');
    expect(view.shows).toEqual([false, false]);
    // A chat that is not shown when the picker closes is not brought forward for it.
    view.visible = false;
    await h.screen().click('File summary.txt', 'Grant access');
    expect(view.shows).toEqual([false, false]);
  }, 30_000);

  it("the item's Grant access settles once the choice is over: true when the picker was shown, false for a second click while it is open", async () => {
    const h = await host({ chat: true });
    await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.output) })).toMatch(WAIT);
    await h.reply();
    let answer!: (choice: Choice | undefined) => void;
    h.setChoice(new Promise<Choice | undefined>((resolve) => { answer = resolve; }));
    const item = h.itemFor(h.source)!;
    const first = item.grant() as Promise<boolean>;
    await flush();
    await expect(item.grant() as Promise<boolean>).resolves.toBe(false);
    let settled = false;
    void first.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    answer({ permission: 'read', lifetime: 'request' });
    await expect(first).resolves.toBe(true);
  }, 30_000);
});

/*
 * v0.9.101 (the access table, design R1-R3; the Owner, 2026-11-07): one table of what each request needs, what is granted
 * and what is missing; every view reads it. Each flow checks that the item, the waiting step, the marker and the status
 * line say what the rows say, through the real modules.
 */
describe('the access table: every view shows its rows', () => {
  const statusOf = (h: Host, requestId: string) => accessLine(h.table.unmet(requestId)
    .map((need) => ({ label: need.label, path: need.path, access: need.needed })));
  const itemIds = (h: Host, requestId: string) => new Set([...h.shown.values()].filter((item) => item.requestId === requestId).map((item) => item.id));

  it('E as the smoke met it: an output file inside the folder the person named is one item; Read on it keeps asking for Read + Write, and the same item completes it', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const result = await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } });
    const handle = WAIT.exec(result)![1];
    await h.reply();
    expect(itemIds(h, requestId).size).toBe(1);
    await h.grant(h.outDir, { permission: 'read', lifetime: 'request' });
    // The Read is kept as chosen; the one item says what is still missing, and so do the marker and the status line.
    expect(h.consent.pathAccessFor(requestId).map((grant) => grant.permission)).toEqual(['read']);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'needs-write', held: 'read' });
    expect(itemIds(h, requestId).size).toBe(1);
    expect(h.pm.turns).toHaveLength(1);
    expect(h.run(message.id)!.awaitingAccess!.needs).toEqual([expect.objectContaining({ path: h.output, access: 'readwrite', state: 'partial' })]);
    expect(statusOf(h, requestId)).toBe(`Waiting for your access: Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`);
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(statusOf(h, requestId)).toBeUndefined();
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1]).toContain(`Its task "${handle}" can run now`);
    const task = /Handle: ([^\s.]+)/.exec(await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] }))![1];
    const saved = await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' });
    expect(saved.status).toBe('success');
    await h.reply('Dispatched.');
    await h.workerReply(task, [saved.path!]);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'accepted' })).toMatch(/^Recorded/);
    h.bus.send('pm', 'user', 'task.complete', { instruction: 'Saved the summary.' }, 'normal', message.id);
    expect(h.job(message.id).completion).toBe('complete');
    // Nothing on screen still says "not granted yet".
    expect([...h.shown.values()].filter((item) => item.requestId === requestId && item.state !== 'granted')).toEqual([]);
  });

  it('A as the smoke met it, in the other order: the file\'s card becomes the folder\'s when the folder is named later, one card with one Grant access, and its Read + Write wakes the work', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } })).toMatch(WAIT);
    const fileCard = h.itemFor(h.output)!;
    expect(fileCard).toMatchObject({ state: 'needs-access' });
    h.offer('pm', h.outDir, 'named');
    await h.reply();
    // Audit of cc0b6bc6, F3: the chat's cards, by id, as the chat keeps them: one, the same card, now the folder's.
    const cards = () => h.itemsOf('pm').filter((item) => item.requestId === requestId);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ id: fileCard.id, target: h.outDir, state: 'needs-access' });
    expect(pathAccessItemView(cards()[0]).actionable).toBe(true);
    h.setChoice({ permission: 'readwrite', lifetime: 'request' });
    cards()[0].grant();
    await flush();
    // The card's Grant access grants the folder it now shows.
    expect(h.consent.pathAccessFor(requestId)).toEqual([expect.objectContaining({ permission: 'readwrite',
      target: expect.objectContaining({ kind: 'directory', realPath: h.outDir }) })]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ id: fileCard.id, state: 'granted', held: 'readwrite' });
    expect(h.pm.turns).toHaveLength(2);
    expect(statusOf(h, requestId)).toBeUndefined();
  });

  it('F3 (re-review of d9da1b74): two file cards in one folder, then the folder named: at once, before any other event or click, one card has Grant access, the folder\'s; the other guides to it', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    const a = path.join(h.outDir, 'a.txt');
    const b = path.join(h.outDir, 'b.txt');
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, a), inputs: [] } })).toMatch(WAIT);
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, b), inputs: [] } })).toMatch(WAIT);
    const cards = () => h.itemsOf('pm').filter((item) => item.requestId === requestId);
    expect(cards().filter((item) => pathAccessItemView(item).actionable)).toHaveLength(2);
    const ids = new Set(cards().map((item) => item.id));
    h.offer('pm', h.outDir, 'named');
    // No reply, no grant, no other table event: the cards as the chat keeps them now.
    expect(cards()).toHaveLength(2);
    expect(new Set(cards().map((item) => item.id))).toEqual(ids);
    const actionable = cards().filter((item) => pathAccessItemView(item).actionable);
    expect(actionable).toEqual([expect.objectContaining({ target: h.outDir, state: 'needs-access' })]);
    const guide = cards().find((item) => item.target !== h.outDir)!;
    expect(guide).toMatchObject({ state: 'merged', shownWith: actionable[0].label });
    expect(pathAccessItemView(guide).actionable).toBe(false);
    // The one Grant access grants the folder; both waiting tasks are reached by it, with one wake.
    h.setChoice({ permission: 'readwrite', lifetime: 'request' });
    await h.reply();
    actionable[0].grant();
    await flush();
    expect(cards().filter((item) => pathAccessItemView(item).actionable)).toEqual([]);
    expect(h.pm.turns.filter((turn) => turn.includes('can run now'))).toHaveLength(1);
  });

  it('smoke of c2ec1f79: an output folder the agent can already read, as the default parent read scope gives, is never called granted; the item asks for Read + Write and a grant then shows granted', async () => {
    const h = await host({ readRoots: (outDir) => [outDir] });
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    // Nothing was granted: the item says the agent can read it already, never that it is granted or that nothing is
    // needed. v0.9.102 (field T2): the request may save there, so the item offers Read + Write at once.
    expect(h.consent.pathAccessFor(requestId)).toEqual([]);
    const reached = h.itemFor(h.outDir)!;
    expect(reached).toMatchObject({ state: 'readable', reach: 'read' });
    expect(reached.held).toBeUndefined();
    expect(pathAccessItemView(reached).title).toBe(`${reached.label} — can be read now; writing to it needs Read + Write`);
    expect(pathAccessItemView(reached).title).not.toContain('granted');
    expect(pathAccessItemView(reached).detail).not.toContain('none is needed');
    expect(pathAccessItemView(reached).actionable).toBe(true);
    // The task writes there: the same item asks for Read + Write, still with nothing called granted.
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } })).toMatch(WAIT);
    const asks = h.itemFor(h.outDir)!;
    expect(asks).toMatchObject({ state: 'needs-write' });
    expect(asks.held).toBeUndefined();
    expect(pathAccessItemView(asks).title).toBe(`${asks.label} — has Read; saving needs Read + Write access`);
    expect(pathAccessItemView(asks).actionable).toBe(true);
    await h.reply();
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(h.pm.turns.filter((turn) => turn.includes('can run now'))).toHaveLength(1);
  });

  it('a named folder the agent can read already is offered Read + Write on its item, with no notice, and a grant from that item shows granted (v0.9.102 field T2)', async () => {
    const h = await host({ readRoots: (outDir) => [outDir] });
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    // The item only: nothing the work needs now is missing, so no notice asks for it.
    expect(h.presented).toEqual([]);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'readable', reach: 'read' });
    // The person grants from the item before any task asks.
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(h.consent.pathAccessFor(requestId)).toEqual([expect.objectContaining({ permission: 'readwrite' })]);
    // A task that then writes there waits for nothing.
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } })).not.toMatch(WAIT);
  });

  it('a refused write to a named folder the agent can read through its own folders says it has Read and saving needs Read + Write, once (v0.9.102 field T2)', async () => {
    const h = await host({ readRoots: (outDir) => [outDir] });
    await h.ask();
    h.offer('pm', h.outDir, 'named');
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'readable', reach: 'read' });
    expect(h.presented).toEqual([]);
    // The agent's real host file tools, wired to the offer as src/extension.ts wires them (onFileOutsideRoot ->
    // fileOutsideRoot(target, 'refused', access)): a write into the folder is refused and reported as needing Read + Write.
    const tools = new WorkspaceTools(h.root, new Set(['read', 'write']));
    tools.setOutsideRootObserver((target, access) => h.offer('pm', target, 'refused', access));
    const target = path.join(h.outDir, 'summary.txt');
    const result = await tools.run('write_file', { path: target, content: 'draft' });
    expect(result.status).not.toBe('success');
    expect(existsSync(target)).toBe(false);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'needs-write' });
    // One notice, in the words for a folder the agent can read: never "could not reach it".
    expect(h.presented).toEqual([expect.objectContaining({ agentId: 'pm', cause: 'refused', upgrade: true })]);
    expect(pathAccessNoticeText('Project Manager', h.outDir, 'refused', { label: 'Folder out', upgrade: true }))
      .toContain('has Read access; saving there needs Read + Write');
    // A second refusal of the same need puts up no second notice.
    await tools.run('write_file', { path: target, content: 'draft' });
    expect(h.presented).toHaveLength(1);
  });

  it('a named folder the agent can already write, under Full access, says so and offers no Grant (v0.9.102 field T2)', async () => {
    const h = await host({ fullFileAccess: true });
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'reachable', reach: 'readwrite' });
    expect(pathAccessItemView(h.itemFor(h.outDir)!).actionable).toBe(false);
    expect(h.presented).toEqual([]);
    expect(h.consent.pathAccessFor(requestId)).toEqual([]);
  });

  it('F1 (audit of cc0b6bc6): an output with no folder named for it is granted, the work resumes and saves, and its item still says granted; a revocation still updates it', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, h.output), inputs: [] } })).toMatch(WAIT);
    await h.reply();
    await h.grant(h.output, { permission: 'readwrite', lifetime: 'request' });
    expect(h.itemFor(h.output)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(h.pm.turns.filter((turn) => turn.includes('can run now'))).toHaveLength(1);
    expect(await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] })).toMatch(/^Dispatched contract/);
    expect(h.itemFor(h.output)).toMatchObject({ state: 'granted', held: 'readwrite' });
    const saved = await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' });
    expect(saved.status).toBe('success');
    expect(h.itemFor(h.output)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(pathAccessItemView(h.itemFor(h.output)!).actionable).toBe(false);
    // Nothing waits on it any more: the status line and the marker list nothing.
    expect(h.table.unmet(requestId)).toEqual([]);
    // The grant is revoked: the item says so at once.
    h.consent.revokePathAccess(h.consent.pathAccessFor(requestId)[0].id);
    await flush();
    expect(h.itemFor(h.output)).toMatchObject({ state: 'needs-access' });
  });

  it('F2 (audit of cc0b6bc6): Stop with two waiting tasks names both outputs still missing, in the outcome and in the table\'s close record', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    const a = path.join(folder(), 'a.txt');
    const b = path.join(folder(), 'b.txt');
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, a), inputs: [] } })).toMatch(WAIT);
    expect(await h.dispatch({ contract: { ...leaseContract(h.source, b), inputs: [] } })).toMatch(WAIT);
    await h.reply();
    expect(h.table.unmet(requestId).map((need) => need.path)).toEqual(expect.arrayContaining([a, b]));
    h.mgr.interrupt('pm');
    await flush();
    expect(h.job(message.id).remaining.access?.text)
      .toBe(`Stopped while waiting for access: Read + Write for File a.txt (${a}), Read + Write for File b.txt (${b}).`);
    expect(h.table.request(requestId)).toMatchObject({ lifecycle: 'closed', closeReason: 'stopped' });
    expect(h.table.request(requestId)!.unmetAtClose!.map((need) => need.path).sort()).toEqual([a, b].sort());
  });

  it('D2: Stop after the lease was granted names only the output, the one still missing', async () => {
    const h = await host();
    const { message } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    expect(await h.dispatch({ contract: leaseContract(h.source, h.output) })).toMatch(WAIT);
    await h.reply();
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(1);
    h.mgr.interrupt('pm');
    await flush();
    expect(h.job(message.id).remaining.access?.text).toBe(`Stopped while waiting for access: Read + Write for File summary.txt (${h.output}).`);
  });

  it('D1: one output folder for two teammates, one limited to Read by its own Folder Access: one grant wakes only the other, and it writes', async () => {
    const h = await host();
    h.roster.push({ id: 'devB', role: 'senior-dev', name: 'Dev B', status: 'idle',
      capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' } });
    h.configs.devB = agentConfig('devB', { backend: 'openai-compat', workingDirectory: h.root, folderAccess: [{ path: h.outDir, permission: 'read' }] });
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    const forA = { ...leaseContract(h.source, path.join(h.outDir, 'a.txt')), inputs: [] };
    const waiting = await h.dispatch({ contract: forA });
    const handle = WAIT.exec(waiting)![1];
    // Dev B's limit is its own: no grant could open it, so nothing of it waits for a grant.
    h.team.beginTurnContentReceipts();
    const forB = (await h.team.runOutcome('dispatch_task', { agent: 'devB', instruction: 'Summarise the lease.',
      contract: { ...leaseContract(h.source, path.join(h.outDir, 'b.txt')), inputs: [] } })).output;
    expect(forB).not.toMatch(WAIT);
    await h.reply();
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.pm.turns.filter((turn) => turn.includes('can run now'))).toHaveLength(1);
    expect(h.pm.turns.at(-1)).toContain(`Its task "${handle}" can run now`);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted' });
    expect(await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] })).toMatch(/^Dispatched contract/);
    expect((await h.worker().run('write_file', { path: path.join(h.outDir, 'a.txt'), content: 'A' })).status).toBe('success');
    // Its waiting step was resumed: its rows went with it.
    expect(h.table.needState(requestId, path.join(h.outDir, 'a.txt'), { agentId: 'dev', handle })).toBeUndefined();
  });

  it('D3: a child that becomes a junction outside the granted tree is refused at use, its item says so, a repair and Grant access restore it, and a late report changes nothing', async () => {
    const h = await host();
    const { requestId } = await h.ask();
    h.offer('pm', h.outDir, 'named');
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'session' });
    const child = path.join(h.outDir, 'child');
    mkdirSync(child);
    const target = path.join(child, 'y.txt');
    const contract = { ...leaseContract(h.source, target), inputs: [], outputs: [{ output_id: 'out', path: child, kind: 'directory', required: true }] };
    expect(await h.dispatch({ contract })).toMatch(/^Dispatched contract/);
    // The child is replaced by a junction to a folder outside the grant.
    const elsewhere = folder();
    rmSync(child, { recursive: true });
    symlinkSync(elsewhere, child, 'junction');
    const refused = await h.worker().run('write_file', { path: target, content: 'Y' });
    expect(refused.status).toBe('refused');
    expect(existsSync(path.join(elsewhere, 'y.txt'))).toBe(false);
    await flush();
    expect(h.table.targetState(requestId, target)).toBe('missing');
    // It leads outside the folder now: its own item asks for it, by where it leads; the folder itself stays granted.
    expect(h.itemFor(target, 'dev')).toMatchObject({ state: 'needs-access' });
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted' });
    const before = h.table.revisionOf(requestId, target)!;
    // Repaired, and the person chooses Grant access on the item: judged again, met; the folder grant already covers it.
    rmSync(child);
    mkdirSync(child);
    h.itemFor(target, 'dev')!.grant();
    await flush();
    expect(h.table.targetState(requestId, target)).toBe('met');
    expect(h.table.findTarget(requestId, target)!.shownOn).toBe(h.table.findTarget(requestId, h.outDir)!.id);
    // Audit of cc0b6bc6, F3: back inside, its own card says the folder's item covers it, with no Grant access of its own.
    expect(h.itemFor(target, 'dev')).toMatchObject({ state: 'merged', shownWith: h.itemFor(h.outDir)!.label });
    expect(pathAccessItemView(h.itemFor(target, 'dev')!).actionable).toBe(false);
    expect(h.itemFor(h.outDir)).toMatchObject({ state: 'granted' });
    // A report taken before the repair arrives late: history only.
    expect(h.table.report({ requestId, consumer: { agentId: 'dev' }, namedPath: target, observedPhysical: path.join(elsewhere, 'y.txt'),
      observedAt: 'late', startRevision: before, outcome: 'access-missing' })).toBe(false);
    expect(h.table.targetState(requestId, target)).toBe('met');
    // Another event judges from the operative identity, never from history: still met.
    const other = folder();
    await h.consent.requestPathAccess(other, { requestId, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    expect(h.table.targetState(requestId, target)).toBe('met');
    expect((await h.worker().run('write_file', { path: target, content: 'Y' })).status).toBe('success');
  });
});

/*
 * v0.9.102 (the Owner's decision): the PM live strip above the message box, on the
 * booted chat page, through src/extension.ts's own connection of it to the real SessionManager, AccessTable, RunLedger and
 * ChatViewProvider. Field T2 met a reply that said "Idle / Nothing is running." while a task started, and a status that
 * was rewritten with another wait: replies now carry no status, and the strip says what is true now.
 */
describe('v0.9.102 the PM live strip on screen', () => {
  beforeAll(() => loadProductionWirings());

  /** The PM's turn ends as every backend ends it: the turn's dispatch receipt, then the reply with its typed outcome. */
  const backendReply = async (h: Host, text: string) => {
    h.pm.emit(delegationReceiptEvent(h.team.turnDelegationReceipt()));
    h.pm.emit({ kind: 'turn_complete', result: { text, isError: false, responseOutcome: { kind: 'reply' } } });
    await flush();
    await h.screen().pump();
  };
  const stripNow = async (h: Host) => { await flush(); await h.screen().pump(); return h.screen().strip(); };
  const RUNNING = /^Running: dev \((under 1 min|\d+ min)\)\.$/;
  const PROMISE = 'The PM reports here when results come back.';
  /** The PM's wake turn after the grant resumes the lease task and ends before the teammate is admitted. */
  const wakeReplyBeforeAdmission = async (h: Host) => {
    const { message } = await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.inside) })).toMatch(WAIT);
    await backendReply(h, 'Waiting for your access to the lease.');
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    const task = /Handle: ([^\s.]+)/.exec(await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] }))![1];
    await backendReply(h, 'The analyst is starting.');
    return { message, task };
  };

  it('the wake turn that resumes the dispatch and ends before its teammate is admitted: the strip says it is starting, then running', async () => {
    const h = await host({ chat: true, waitForTaskAdmission: true });
    const { message, task } = await wakeReplyBeforeAdmission(h);
    // Sent, not admitted: no task record yet, and the strip still says the work is starting.
    expect(h.run(message.id)!.delegations).toEqual([]);
    expect(await stripNow(h)).toEqual(['Starting: 1 task.', PROMISE]);
    // No reply carries a status.
    expect(h.screen().footers().join(' ')).not.toMatch(/PM status|Idle|Nothing is running/);
    // The teammate is admitted after the turn ended: the task is recorded, and the strip says it runs.
    h.bus.send('dev', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', task);
    const running = await stripNow(h);
    expect(running).toHaveLength(2);
    expect(running[0]).toMatch(RUNNING);
    expect(running[1]).toBe(PROMISE);
    // v0.9.103 (G4): the same late receipt reaches that turn's request closeout.
    expect(closeoutReceipts.at(-1)).toMatchObject({ agentId: 'pm', receipt: { accepted: 1, refused: 0, pending: 0 } });
  }, 30_000);

  it('control: a wake turn that dispatches nothing leaves nothing to show', async () => {
    const h = await host({ chat: true, waitForTaskAdmission: true });
    await h.ask();
    expect(await h.dispatch({ contract: leaseContract(h.source, h.inside) })).toMatch(WAIT);
    await backendReply(h, 'Waiting for your access to the lease.');
    expect(await stripNow(h)).toEqual([`Waiting for your access: Read for File lease.txt (${h.source}). Choose Grant access on its item.`]);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    h.team.beginTurnContentReceipts();
    await backendReply(h, 'Noted.');
    expect(await stripNow(h)).toEqual([]);
    expect(h.assigned).toEqual([]);
  }, 30_000);

  it('a result settled with no wake to deliver it is owed, with Continue; reading the strip starts, schedules and records nothing', async () => {
    const h = await host({ chat: true, waitForTaskAdmission: true });
    const { task } = await wakeReplyBeforeAdmission(h);
    h.bus.send('dev', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', task);
    expect((await stripNow(h))[0]).toMatch(RUNNING);
    // The teammate saves the summary and its result settles. Nothing delivers it to the PM in this host.
    expect((await h.worker().run('write_file', { path: h.inside, content: 'SUMMARY' })).status).toBe('success');
    await h.workerReply(task, [h.inside]);
    expect(await stripNow(h)).toEqual(['dev finished, but the PM has not reported on it. Continue']);
    // Continue only fills the message box.
    expect(h.screen().continueFromStrip()).toBe('Please review the finished results and report to me.');
    expect(h.pm.turns).toHaveLength(2);
    expect(h.ledger().inspectTaskStatus('pm', [task]).map((row) => row.result?.reviewContinuation)).toEqual([undefined]);
  }, 30_000);

  it('a result that wakes the PM: about to be reviewed while its delivery is prepared, reviewed in the wake turn, reported by the PM\'s reply, and gone once decided', async () => {
    const h = await host({ chat: true, waitForTaskAdmission: true, wake: true });
    const { task } = await wakeReplyBeforeAdmission(h);
    h.bus.send('dev', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', task);
    expect((await stripNow(h))[0]).toMatch(RUNNING);
    // The result settles and wakes the PM, as OrchestrationHostAdapter queues it.
    expect((await h.worker().run('write_file', { path: h.inside, content: 'SUMMARY' })).status).toBe('success');
    h.bus.send('dev', 'pm', 'task.complete', { instruction: 'Saved the summary.',
      metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [h.inside] } } }, 'normal', task);
    // While the wake's delivery is prepared in storage, the PM is not in a turn yet: its result is on the way.
    expect(await stripNow(h)).toEqual(['dev finished. The PM is about to review it.']);
    expect(h.pm.turns).toHaveLength(2);
    await h.finishPrepare();
    expect(h.pm.turns).toHaveLength(3);
    expect(await stripNow(h)).toEqual(['dev finished. The PM is reviewing it now.']);
    await backendReply(h, 'The summary is saved.');
    // v0.9.102 (Codex's audit of 2ddf9c46, F1b): the reply reported the result; it did not decide it. No automatic review
    // turn is registered in this host, so the decision still owed is a reminder until the PM records one.
    const afterReply = await stripNow(h);
    expect(afterReply).toHaveLength(1);
    expect(afterReply[0]).toMatch(/^Reminder: dev's task .*the PM received it .* and has not recorded a decision on it\./);
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'accepted' })).toContain('Recorded coordinator acceptance');
    expect(await stripNow(h)).toEqual([]);
  }, 30_000);

  it('the PM\'s final reply is kept in workspace state, after the result it reported; a host reading it again owes no report', async () => {
    const h = await host({ chat: true, waitForTaskAdmission: true, wake: true });
    const { task } = await wakeReplyBeforeAdmission(h);
    h.bus.send('dev', 'pm', 'task.admitted', { instruction: 'started' }, 'normal', task);
    expect((await h.worker().run('write_file', { path: h.inside, content: 'SUMMARY' })).status).toBe('success');
    h.bus.send('dev', 'pm', 'task.complete', { instruction: 'Saved the summary.',
      metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [h.inside] } } }, 'normal', task);
    await flush();
    await h.finishPrepare();
    expect(h.pm.turns).toHaveLength(3);
    await backendReply(h, 'The summary is saved.');
    // The reply was kept where src/extension.ts keeps it, no earlier than the result was placed into that turn.
    const kept = h.pmReplies.get('pm')!;
    const delivered = h.ledger().inspectTaskStatus('pm', [task])[0].delivery?.observedAt;
    expect(delivered).toBeDefined();
    expect(Date.parse(kept)).toBeGreaterThanOrEqual(Date.parse(delivered!));
    // A second store over the same saved state, as after a reload, reads the same reply: nothing is owed.
    const reloaded = pmReplyStore({ get: <T>(key: string) => h.workspaceState.get(key) as T | undefined, update: async () => undefined });
    expect(reloaded.get('pm')).toBe(kept);
    // v0.9.102 (Codex's audit of 2ddf9c46, F1b): no report is owed; the decision the reply did not record still is.
    const again = pmLiveStrip({ held: false, tasks: h.ledger().inspectTaskStatusWhere('pm', pmLiveRelevant(kept)), repliedAt: kept,
      queued: new Set(), starting: 0, waitingForAccess: [] })?.lines ?? [];
    expect(again.map((line) => line.kind)).toEqual(['reminder']);
    expect(again.map((line) => ('text' in line ? line.text : '')).join(' ')).not.toContain('has not reported');
  }, 30_000);

  it('a later wait of the same request: the strip shows the wait the request has now, never the one that ended', async () => {
    const h = await host({ chat: true });
    // The teammate is a session, as in production: the work it is sent belongs to the PM's request, and so does the
    // turn its result wakes.
    h.mgr.create({ id: 'dev', name: 'Dev', role: 'senior-dev' as AgentConfig['role'], skill: '',
      provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'claude-sonnet-4-20250514', systemPrompt: '',
      autoApprove: true, allowedTools: [] });
    await h.mgr.start('dev', { pin: 'take' });
    h.backendFor('dev').emit({ kind: 'ready' });
    const { message, requestId } = await h.ask();
    // The first wait: the lease.
    expect(await h.dispatch({ contract: leaseContract(h.source, h.inside) })).toMatch(WAIT);
    await backendReply(h, 'Waiting for your access to the lease.');
    expect(await stripNow(h)).toEqual([`Waiting for your access: Read for File lease.txt (${h.source}). Choose Grant access on its item.`]);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(await stripNow(h)).toEqual([]);
    // The wake resumes the dispatch; the teammate writes outside every grant, and the task settles unfinished.
    expect(h.pm.turns).toHaveLength(2);
    const task = /Handle: ([^\s.]+)/.exec(await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] }))![1];
    expect((await h.worker().run('write_file', { path: h.output, content: 'SUMMARY' })).status).toBe('refused');
    await backendReply(h, 'Dispatched.');
    await h.workerReply(task, []);
    // A new wait of the same request: the strip shows it at once, and never the lease's wait that ended.
    expect(h.table.request(requestId)!.lifecycle).toBe('waiting');
    expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ path: h.output, access: 'readwrite', step: 'retry' })]);
    const retryWait = await stripNow(h);
    expect(retryWait).toContain(`Waiting for your access: Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`);
    expect(retryWait.join(' ')).not.toContain('lease.txt');
    // The result wakes the PM in its request; that turn ends with the new wait, and the strip shows it.
    expect(h.mgr.queueAsyncDelegationWake('pm', { handle: task, ref: 'dev', text: h.results.get(task)!, runId: h.ledger().runIdForDelegation(task) },
      () => true, () => true)).toBe(true);
    await flush();
    expect(h.pm.turns).toHaveLength(3);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: task, disposition: 'deferred', reason: 'It waits for the output.' })).toMatch(/^Recorded/);
    await backendReply(h, 'The retry waits for the output.');
    expect(await stripNow(h)).toContain(
      `Waiting for your access: Read + Write for File summary.txt (${h.output}). Choose Grant access on its item.`);
    await h.grant(h.output, { permission: 'readwrite', lifetime: 'request' }, 'dev', requestId);
    expect((await stripNow(h)).join(' ')).not.toContain('Waiting for your access');
    // No reply on screen carries a status.
    expect(h.screen().footers().join(' ')).not.toMatch(/PM status|Waiting for/);
  }, 30_000);
});
