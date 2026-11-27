import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
/**
 * The real file reader, unchanged, except that a test may have its next reads of one file fail as the reader itself
 * reports a read it could not do (audit H2b-1): a typed `failed/unreadable`, with the file untouched.
 */
const failingReads = vi.hoisted(() => ({ target: '', count: 0, injected: 0 }));
vi.mock('../../backend/workspacePath', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../backend/workspacePath')>();
  return { ...real, readRegularFileInsideRoot: async (...args: Parameters<typeof real.readRegularFileInsideRoot>) => {
    const [root, candidate] = args;
    if (failingReads.count > 0 && path.resolve(root, candidate).toLowerCase() === failingReads.target.toLowerCase()) {
      failingReads.count--;
      failingReads.injected++;
      return { status: 'failed', reason: 'unreadable' } as const;
    }
    return real.readRegularFileInsideRoot(...args);
  } };
});
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { renderDocx, type DocumentZip } from '../../content/document/DocxRenderer';
import type { CanonicalDocumentRequest } from '../../content/document/DocumentContracts';
import { accessPhysicalPath, SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { AccessTable } from '../AccessTable';
import { fileToolReachesAnotherComputer } from '../namedOutsidePaths';
import { TeamTools, type TeamRosterEntry } from '../../backend/TeamTools';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../orchestration/OrchestrationHostAdapter';
import { RunLedger } from '../../observability/RunLedger';
import { projectJobOutcome } from '../../observability/JobOutcome';
import { SessionManager } from '../../session/SessionManager';
import { createPathAccessOffer, PathAccessRequestItems, type PathAccessItem } from '../PathAccessOffer';
import { TaskResumeRefs } from '../TaskResumeRefs';
import { agentConfig, tempFolder } from '../../views/__tests__/support/fileNavigationHost';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, DelegationTaskScope, Message } from '../../types';
import { presentationRouteRenderer } from '../../backend/__tests__/presentationRouteFixtures';
import { removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import type { PresentationRenderer } from '../../office/PresentationRenderer';
import JSZip from 'jszip';
import { PRESENTATION_PNG, assertOriginalPngEmbedded } from '../../backend/__tests__/presentationImageFixtures';
import { workbookRouteReader } from '../../backend/__tests__/workbookRouteFixtures';
import { workbookSumPlan, COMPUTE_CSV } from '../../backend/__tests__/workbookComputeFixtures';
import { documentRouteRenderer, boundDocumentInput } from '../../backend/__tests__/documentRouteFixtures';
import { boundPresentationInput } from '../../backend/__tests__/presentationRouteFixtures';

/*
 * v0.9.101 (H2b, the Owner 2026-11-07: "ask for access, never remove capability"): a teammate prepared the whole
 * document while its destination was not granted, its final save was refused needs-access with every part kept, and its
 * attempt settled. The request does not end: the save waits in it. A grant that makes the save runnable (the output's
 * Read + Write and the Read of each source the draft was digested from) wakes the PM once with a resume_ref, and the
 * resumed task takes over the kept draft at admission and saves it once. The source is compared with the SHA-256 of the
 * bytes first read, at adoption and again at the write boundary of the save.
 *
 * Through the real SessionManager (turns, requests, wake queue), OrchestrationHostAdapter (input and output access, the
 * source check), TeamTools dispatch_task and cancel_task, the teammate's real WorkspaceTools with a real DOCX renderer,
 * the real grant store, PathAccessOffer items, TaskResumeRefs and the RunLedger with its Job outcome. Only the models are
 * scripted: their tool calls are made here.
 */

const LEASE = 'MASTER LEASE AGREEMENT\nClause 1. The lessee leases the compute.\n';
const REF = /resume_ref (rr-[0-9a-f]{32})/;
const WAIT = /Task "(wait-[0-9a-f]{12})" is prepared and waiting/;
const SAVE_WAIT = /call cancel_task with handle "(wait-[0-9a-f]{12})"/;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
afterEach(removeTemporaryFolders);

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-h2b-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

const flush = async () => {
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
};

const renderReal = async (request: CanonicalDocumentRequest) => {
  const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
  return renderDocx(request, () => new yazl.ZipFile());
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

/** Field t2d: summarise the outside lease into a Word file of an outside folder the task scope names. */
function saveContract(source: string, outDir: string, output: string, freshness: 'dispatch-snapshot' | 'current' = 'dispatch-snapshot') {
  return {
    version: 2,
    objective: 'Summarise the lease in English and Traditional Chinese.',
    expected_deliverable: 'A bilingual Word summary.',
    effects: { read_files: [], write_scope: { folder_access: [{ path: outDir, permission: 'readwrite' }] }, expected_file_effect: 'create' },
    inputs: [{ input_id: 'lease', kind: 'workspacePath', path: source, purpose: 'The contract to summarise', required: true,
      freshness, provenance: { kind: 'user-turn', source_refs: [] } }],
    outputs: [{ output_id: 'summary', path: output, kind: 'file', required: true }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    execution_strategy: 'delegate-required',
  };
}

/** One write_document call of the draft `summary`. */
const part = (target: string, text: string, final = false) => ({ schema_version: 1, path: target, format: 'docx', template: 'contract-v1',
  draft: 'summary', ...(final ? { final: true } : {}),
  document: { title: 'Summary', language: 'en', blocks: text ? [{ type: 'clause', label: [{ text }], content: [{ text }] }] : [] } });
const pptPart = (target: string, text: string, final = false) => ({ schema_version: 1, path: target, draft: 'summary', final,
  deck: { title: 'Summary', slides: text ? [{ objects: [{ type: 'text', text, x: 0.5, y: 0.5, w: 10, h: 1 }] }] : [] } });

type Choice = { permission: 'read' | 'readwrite'; lifetime: 'request' | 'session' };

async function host(options: { render?: (request: CanonicalDocumentRequest) => Promise<{ bytes: Uint8Array; stats: any }>;
  presentationRenderer?: Pick<PresentationRenderer, 'render'>; presentationImage?: Uint8Array } = {}) {
  const root = folder({ 'notes.md': 'workspace' });
  const outside = folder({ 'lease.txt': LEASE });
  const outDir = folder();
  const source = path.join(outside, 'lease.txt');
  const output = path.join(outDir, options.presentationRenderer ? 'summary.pptx' : 'summary.docx');
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
  const mgr = new SessionManager(5, bus, {
    createBackend: (config) => { const made = new ScriptedBackend(config); backends.set(config.id, made); return made; },
    resolveEnv: async () => ({}),
    threadRunOpen: (coordinatorId, correlationId) => ledger.threadRunOpen(coordinatorId, correlationId),
    requestAwaitingAccess: (requestId) => refs.hasWaiting(requestId),
    waitingRequestsStopped: (scope) => {
      const ended = 'coordinatorId' in scope
        ? refs.endCoordinator(scope.coordinatorId, 'stopped')
        : (refs.hasWaiting(scope.requestId) ? (refs.endRequest(scope.requestId), [scope.requestId]) : []);
      for (const requestId of ended) consent.endPathAccessRequest(requestId);
    },
  });
  ledger = new RunLedger([], { activeTurnId: (agentId) => mgr.currentTurnId(agentId) });
  bus.on('message.sent', (message: unknown) => ledger.observeMessage(message as Message));
  mgr.create({ id: 'pm', name: 'PM', role: 'project-manager' as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'claude-sonnet-4-20250514', systemPrompt: '',
    autoApprove: true, allowedTools: [] });
  await mgr.start('pm', { pin: 'take' });
  const pm = backends.get('pm')!;
  pm.emit({ kind: 'ready' });

  const capabilities = { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' } as const;
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle', capabilities: { ...capabilities, verificationSensors: [], toolFamilies: ['read', 'write'] } },
    { id: 'dev2', role: 'senior-dev', name: 'Dev Two', status: 'idle', capabilities: { ...capabilities, verificationSensors: [], toolFamilies: ['read', 'write'] } },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root }),
    dev2: agentConfig('dev2', { backend: 'openai-compat', workingDirectory: root }),
  };
  const offers = new Map<string, (named: string, cause?: 'refused' | 'named', access?: 'read' | 'readwrite', consumer?: { agentId: string; handle?: string }) => void>();
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: (agentId) => mgr.currentRequestId(agentId),
    // As src/extension.ts: what the work needs of the target rides the offer.
    offerPathAccess: (agentId, target, access, consumer) => offers.get(agentId)?.(target, 'refused', access, consumer),
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  adapterRef = adapter;
  const store = new ContentAssetStore();
  let imageAssetRef: string | undefined;
  if (options.presentationImage) {
    const asset = await store.storeImage(options.presentationImage, 'tool-result', 'image/png', 'dev');
    if ('error' in asset) throw new Error(asset.error); imageAssetRef = asset.assetId;
  }
  cleanups.push(() => { void store.dispose(); });
  const resolver = adapter.createTaskInputResolver(store);

  let workerTurn: string | undefined;
  let workerRequest: string | undefined;
  refs = new TaskResumeRefs({
    openDelegationOf: (agentId) => ledger.activeDelegation(agentId === 'dev' || agentId === 'dev2' ? workerTurn : undefined, agentId),
    grantsFor: (requestId) => consent.pathAccessFor(requestId),
    predecessor: (coordinatorId, handle) => ledger.resumePredecessor(coordinatorId, handle),
    currentRequestOf: (coordinatorId) => mgr.currentRequestId(coordinatorId),
    // As src/extension.ts: the real rule, the adapter's own.
    needMet: (candidateId, requestId, need) => !!configs[candidateId] && adapter.accessNeedMet(configs[candidateId], need, requestId),
    checkSource: (ownerId, requestId, digests) => adapter.checkTaskSource(configs[ownerId], requestId, digests),
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
  const team = new TeamTools('pm', adapter.makeTeamView(), bus, {
    timeoutMs: 60_000, cwd: root, evidenceEnabled: true, taskInputResolver: resolver, taskResume: refs,
    turnOrigin: () => ({ correlationId: mgr.currentTurnCorrelationId('pm'), turnId: mgr.currentTurnId('pm') }),
    onDelegationRefused: (event) => ledger.recordRefusedDispatch(event),
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched(event),
    onDelegationEvidence: ({ handle, outcome, evidence, agentId, executionEnded }) =>
      ledger.recordDelegationEvidence({ handle, outcome, evidence, agentId, executionEnded }),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
    // As the host's evidence port: a result the PM was handed is delivered.
    onAsyncResultDelivered: (handle, via) => ledger.recordDeliveryDelivered(handle, via),
    onAsyncResultReady: (result) => {
      results.set(result.handle, result.text);
      const identity = ledger.resultIdentity('pm', result.handle);
      if (identity) ledger.recordResultSettlement(identity, result.outcome?.status === 'failed' ? 'failed' : 'ready');
      return true;
    },
  });

  const wakesQueued: number[] = [];
  const items = new PathAccessRequestItems({ granted: () => {
    const wakes = refs.readyWakes();
    wakesQueued.push(wakes.length);
    for (const wake of wakes) mgr.queueAccessWake(wake.coordinatorId, wake);
  } }, table);
  const shown = new Map<string, PathAccessItem>();
  const offered: Array<{ agentId: string; target: string }> = [];
  let choice: Choice = { permission: 'read', lifetime: 'request' };
  const offerFor = (agentId: string) => createPathAccessOffer({
    owner: consent,
    agentId,
    canOffer: () => true,
    captureRequest: () => {
      const requestId = agentId === 'pm' ? mgr.currentRequestId(agentId) : workerRequest;
      return requestId ? { requestId, isCurrent: () => true, requestCurrent: () => mgr.requestOwned(requestId) } : undefined;
    },
    present: async () => false,
    choose: async () => choice,
    item: (item) => { shown.set(`${agentId} ${item.id}`, item); },
    granted: (_grant, _current, requestId) => {
      if (!requestId) return;
      if (refs.waitsOn(agentId, requestId)) return;
      const notice = refs.grantNotice(agentId, requestId, 'Host scope update: access is now available.');
      mgr.tellFileAccessGrant(agentId, requestId, notice.text, (report) => notice.report(report));
    },
    unavailable: () => undefined,
    requestEnded: () => undefined,
    refused: (named, request, access) => refs.capture(agentId, request.requestId, named, access),
  }, items);
  for (const agentId of ['pm', 'dev', 'dev2']) {
    const offer = offerFor(agentId);
    offers.set(agentId, (named, cause, access, consumer) => { offered.push({ agentId, target: named }); offer(named, cause, access, consumer); });
  }

  const itemsOf = (agentId: string) => [...shown].filter(([key]) => key.startsWith(`${agentId} `)).map(([, item]) => item);
  const itemFor = (target: string) => {
    const wanted = path.resolve(target).toLowerCase();
    return [...shown.values()].filter((item) => path.resolve(item.target).toLowerCase() === wanted).at(-1);
  };

  // The teammates' own file tools, one surface per agent across its attempts, as its backend keeps them.
  const renderer = { render: vi.fn(options.render ?? renderReal) };
  const makeTools = (agentId: string) => {
    const toolArgs: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(['read', 'write']), agentId];
    toolArgs[22] = store; // As the extension: file tools and task input resolver share the host asset store.
    const tools = new WorkspaceTools(...toolArgs);
    tools.setLivePathAccess(() => consent.pathAccessFor(workerRequest));
    // As src/extension.ts: a refusal says what the refused call needed.
    tools.setOutsideRootObserver((target, access) => offers.get(agentId)!(target, 'refused', access));
    tools.setDocumentRenderer(renderer);
    tools.setPresentationRenderer(options.presentationRenderer);
    tools.setTaskInputResolver(resolver);
    return tools;
  };
  const tools = new Map<string, WorkspaceTools>([['dev', makeTools('dev')], ['dev2', makeTools('dev2')]]);

  const h = {
    root, source, output, outDir, consent, bus, mgr, pm, team, refs, assigned, results, wakesQueued, items, offered, configs,
    renderer, resolver, tools, adapter, assets: store, imageAssetRef,
    ledger: () => ledger,
    itemFor,
    itemsOf,
    /** Grant access offered for a target, as the request's start names it or a refusal offers it. */
    offer: (agentId: string, target: string, cause: 'refused' | 'named' = 'named') => offers.get(agentId)!(target, cause),
    ask: async (instruction = 'Summarise the lease into the output folder as a Word file.') => {
      const message = bus.send('user', 'pm', 'ask.question', { instruction }) as Message;
      await flush();
      return { message, requestId: mgr.currentRequestId('pm')! };
    },
    dispatch: async (args: Record<string, unknown>, agent = 'dev') => {
      team.beginTurnContentReceipts();
      return (await team.runOutcome('dispatch_task', { agent, instruction: 'Summarise the lease.', ...args })).output;
    },
    cancel: async (handle: string) => (await team.runOutcome('cancel_task', { handle })).output,
    reply: async (text = 'Waiting for the user\'s access.') => {
      pm.emit({ kind: 'turn_complete', result: { text, isError: false } } as BackendEvent);
      await flush();
    },
    /** The person chooses Grant access on the request's item for this target. */
    grant: async (target: string, next: Choice) => {
      choice = next;
      const item = itemFor(target);
      expect(item, `an item for ${target}`).toBeDefined();
      item!.grant();
      await flush();
    },
    /** The teammate's turn for the latest assignment: its attempt card and task scope, as SessionManager hands them over. */
    workerTurn: (agentId = 'dev', message = assigned.at(-1)!) => {
      const surface = tools.get(agentId)!;
      const card = message.payload.taskAttempt as TaskAttemptCard;
      const scope = message.payload.taskScope as DelegationTaskScope | undefined;
      surface.beginTurn();
      surface.setTurnWorkspaceAccess(scope ? adapter.resolveTaskWorkspaceAccess(configs[agentId], scope, workerRequest).access : undefined);
      surface.setTaskAttempt(card);
      return { tools: surface, card, handle: message.correlationId!, instruction: String(message.payload.instruction ?? '') };
    },
    /** The teammate's reply for this handle. */
    workerReply: async (handle: string, changedFiles: string[], agentId = 'dev') => {
      bus.send(agentId, 'pm', 'task.complete', { instruction: changedFiles.length ? 'Saved the summary.' : 'The save waits for access.',
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
    blocksRendered: (call = 0) => (h.renderer.render.mock.calls[call][0] as CanonicalDocumentRequest).document.blocks
      .map((block) => JSON.stringify(block).match(/PART-[A-Z]+/)?.[0]),
  };
  return h;
}

type Host = Awaited<ReturnType<typeof host>>;

/**
 * The save that waits is the fallback for access lost after the dispatch (the Owner, 2026-11-07: everything the contract
 * declares is asked for before the work starts, and the existing flows cover what that misses). The dispatch waits for the
 * lease's Read and the output's Read + Write; the folder's grant owes no wake while the lease is missing, the lease's Read
 * owes one; the re-dispatch is admitted with both. The person then takes the folder's grant back before the teammate's
 * turn: it prepares the whole draft, its final save is refused needs-access and nothing is written; it settles; the
 * request keeps waiting, now for the save.
 */
async function draftWaitingForSave(h: Host, options: { freshness?: 'dispatch-snapshot' | 'current'; readSource?: boolean } = {}) {
  const { message, requestId } = await h.ask();
  h.offer('pm', h.outDir);
  const waiting = await h.dispatch({ contract: saveContract(h.source, h.outDir, h.output, options.freshness) });
  expect(waiting).toMatch(WAIT);
  expect(waiting).toContain(`Read access to File lease.txt (${h.source}) and Read + Write access to File ${path.basename(h.output)} (${h.output})`);
  await h.reply();
  await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
  expect(h.wakesQueued).toEqual([0]);
  await h.grant(h.source, { permission: 'read', lifetime: 'request' });
  expect(h.wakesQueued).toEqual([0, 1]);
  expect(h.pm.turns).toHaveLength(2);
  const dispatched = await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] });
  expect(dispatched).toMatch(/^Dispatched contract/);
  for (const grant of h.consent.listPathAccess()) if (grant.permission === 'readwrite') h.consent.revokePathAccess(grant.id);
  const first = h.workerTurn();
  if (options.readSource !== false) expect((await first.tools.run('read_file', { path: h.source })).status).toBe('success');
  const tool = h.output.endsWith('.pptx') ? 'write_presentation' : 'write_document';
  const makePart = tool === 'write_presentation' ? pptPart : part;
  if (tool === 'write_presentation') expect((await first.tools.run('write_document', part(`${h.output}.docx`, 'WORD-SHADOW'))).status).toBe('success');
  const firstPart = makePart(h.output, 'PART-ONE') as Record<string, any>;
  if (h.imageAssetRef) firstPart.deck.slides[0].objects.push({ type: 'image', asset_ref: h.imageAssetRef, altText: 'Two color pixels', x: 1, y: 1, w: 4, h: 4 });
  const opened = await first.tools.run(tool, firstPart);
  expect(opened.status).toBe('success');
  if (tool === 'write_document') expect(opened.output).toContain('The destination cannot be saved yet');
  expect((await first.tools.run(tool, makePart(h.output, 'PART-TWO'))).status).toBe('success');
  const refused = await first.tools.run(tool, makePart(h.output, 'PART-THREE', true));
  expect(refused).toMatchObject({ status: 'refused', reason: 'needs-access' });
  expect(h.renderer.render).not.toHaveBeenCalled();
  expect(existsSync(h.output)).toBe(false);
  await h.workerReply(first.handle, []);
  await h.reply('The summary is drafted; its save waits for the folder.');
  return { message, requestId, first, saveWait: SAVE_WAIT.exec(h.results.get(first.handle) ?? '')?.[1] ?? '' };
}

/** The output folder's Read + Write wakes the PM once; its dispatch with that ref. */
async function resumeSave(h: Host, agent = 'dev') {
  const before = h.pm.turns.length;
  await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
  expect(h.pm.turns).toHaveLength(before + 1);
  const wake = h.pm.turns.at(-1)!;
  const dispatched = await h.dispatch({ resume_ref: REF.exec(wake)![1] }, agent);
  return { wake, dispatched };
}

describe('v0.9.101 H2b: a prepared draft waits in its request for its save, and the resumed task saves it once', () => {
  it.each([['document', 'access'], ['presentation', 'access'], ['document', 'limit'], ['presentation', 'limit']] as const)(
    'v0.9.107: %s source-bound draft names the actual undigested source for %s', async (format, refusal) => {
    const ppt = format === 'presentation' ? await presentationRouteRenderer() : undefined; const h = await host({ presentationRenderer: ppt });
    const reader = await workbookRouteReader(); const extra = path.join(refusal === 'limit' ? h.root : path.dirname(h.source), 'numbers.csv'); writeFileSync(extra, COMPUTE_CSV);
    const { message } = await h.ask();
    try {
      for (const target of [h.source, ...(refusal === 'access' ? [extra] : []), h.outDir]) { h.offer('pm', target); await h.grant(target, { permission: target === h.outDir ? 'readwrite' : 'read', lifetime: 'request' }); }
      const base = saveContract(h.source, h.outDir, h.output, 'current');
      const contract = { ...base, effects: { ...base.effects, read_files: [extra] },
        inputs: [...base.inputs, { ...base.inputs[0], input_id: 'numbers', path: extra, purpose: 'Optional spreadsheet data', required: false }] };
      expect(await h.dispatch({ contract })).toMatch(/^Dispatched contract/); const first = h.workerTurn();
      first.tools.setWorkbookReader(reader); if (format === 'document') first.tools.setDocumentRenderer(await documentRouteRenderer());
      if (refusal === 'limit') first.tools.setTurnWorkspaceAccess({ pathBase: h.root,
        readRoots: [h.root, path.dirname(h.source)], writeRoots: [h.outDir] });
      expect((await first.tools.run('read_file', { path: h.source })).status).toBe('success');
      const read = await first.tools.run('read_workbook', { path: extra }); expect(read.status, read.output).toBe('success');
      const computed = await first.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success');
      const ref = JSON.parse(computed.output).transformation_ref; const input = format === 'document' ? boundDocumentInput(ref) : boundPresentationInput(ref);
      const tool = format === 'document' ? 'write_document' : 'write_presentation';
      expect((await first.tools.run(tool, { ...input, path: h.output, draft: 'summary' })).status).toBe('success');
      const digests = h.resolver.sourceDigestsOf(first.card.attemptId).digests; expect(digests.map(digest => digest.physical)).toEqual([accessPhysicalPath(h.source)]);
      if (refusal === 'access') {
        const grant = h.consent.listPathAccess().find(grant => accessPhysicalPath(grant.path) === accessPhysicalPath(extra)); expect(grant).toBeDefined(); h.consent.revokePathAccess(grant!.id);
      } else first.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [], writeRoots: [h.outDir] });
      const empty = format === 'document' ? { source_bindings: [], document: { ...boundDocumentInput(ref).document, blocks: [] } } : { deck: { slides: [] } };
      const refused = await first.tools.run(tool, { ...input, ...empty, path: h.output, draft: 'summary', final: true });
      expect(refused.status, refused.output).toBe('refused'); expect(existsSync(h.output)).toBe(false);
      expect(JSON.stringify(refused)).not.toContain('numbers.csv');
      expect(h.resolver.draftCustodianOf(first.card.attemptId)!.awaitingSave(first.card.attemptId)).toMatchObject([{ refusedFor: refusal === 'limit' ? 'source-limit' : 'source-access', stoppedSource: accessPhysicalPath(extra) }]);
      await h.workerReply(first.handle, []); await h.reply('The save waits for spreadsheet Read access.');
      if (refusal === 'limit') {
        const settled = h.results.get(first.handle)!; expect(settled).toContain('numbers.csv'); expect(settled).toContain('Folder Access'); expect(settled).not.toContain('File lease.txt');
        expect(h.run(message.id)!.awaitingAccess?.state).not.toBe('waiting'); return;
      }
      const settled = h.results.get(first.handle)!; expect(settled).toContain('Read access to File numbers.csv'); expect(settled).not.toContain('Read access to File lease.txt');
      expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ label: 'File numbers.csv', access: 'read', step: 'save' })]);
      const turns = h.pm.turns.length; await h.grant(extra, { permission: 'read', lifetime: 'request' });
      expect(h.wakesQueued.at(-1)).toBe(1);
      // The PM may still be answering the earlier scope notice; its queued wake is admitted when that turn ends.
      await h.reply('The spreadsheet grant is available.');
      expect(h.pm.turns).toHaveLength(turns + 1);
      expect(await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] })).toMatch(/^Dispatched contract/);
      const second = h.workerTurn(); const saved = await second.tools.run(tool, { ...input, ...empty, path: h.output, draft: 'summary', final: true });
      expect(saved.status, saved.output).toBe('success'); expect(readFileSync(h.output).subarray(0, 2).toString()).toBe('PK');
      expect(h.resolver.draftCustodianOf(first.card.attemptId)!.awaitingSave(first.card.attemptId)).toEqual([]);
      await h.workerReply(second.handle, [h.output]);
    } finally { await reader.dispose(); }
  });
  it('v0.9.107 PPT: a lost output grant retains all slides, the real grant wakes once, and the new attempt adopts and saves the deck once', async () => {
    const real = await presentationRouteRenderer(); const render = vi.fn((...args: Parameters<typeof real.render>) => real.render(...args));
    const h = await host({ presentationRenderer: { render }, presentationImage: PRESENTATION_PNG });
    const imageHolders = () => ((h.assets as any).assets.get(h.imageAssetRef)?.holders as Set<string> | undefined)?.size;
    const { first, requestId } = await draftWaitingForSave(h);
    expect(render).not.toHaveBeenCalled(); expect(h.refs.hasWaiting(requestId)).toBe(true);
    expect(imageHolders()).toBe(1);
    const { dispatched } = await resumeSave(h); expect(dispatched).toMatch(/^Dispatched contract/);
    const second = h.workerTurn();
    expect(second.instruction).toContain('call write_presentation with draft "summary", final: true and no new slides');
    const custodian = h.resolver.draftCustodianOf(first.card.attemptId)!;
    expect(custodian.standing(first.card.attemptId, 'summary', 'write_presentation')).toEqual({ state: 'gone' });
    expect(custodian.standing(first.card.attemptId, 'summary')).toMatchObject({ state: 'held', draft: { format: 'docx', blocks: 1 } });
    expect(custodian.standing(second.card.attemptId, 'summary', 'write_presentation')).toMatchObject({ state: 'held', draft: { parts: 3, blocks: 3, tool: 'write_presentation' } });
    expect(imageHolders()).toBe(1);
    const result = await second.tools.run('write_presentation', pptPart(h.output, '', true));
    expect(result.status, result.output).toBe('success'); expect(render).toHaveBeenCalledTimes(1);
    const zip = await JSZip.loadAsync(readFileSync(h.output));
    await assertOriginalPngEmbedded(readFileSync(h.output));
    expect(imageHolders()).toBe(0);
    for (const [index, marker] of ['PART-ONE', 'PART-TWO', 'PART-THREE'].entries()) {
      expect(await zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('string')).toContain(marker);
    }
    const repeat = await second.tools.run('write_presentation', pptPart(h.output, '', true));
    expect(repeat.output).toContain('already saved'); expect(render).toHaveBeenCalledTimes(1);
    await h.workerReply(second.handle, [result.path!]);
  });

  it('v0.9.107 PPT: an adopted deck rechecks source bytes after rendering and never commits stale slides', async () => {
    const real = await presentationRouteRenderer();
    const render = vi.fn(async (...args: Parameters<typeof real.render>) => {
      const result = await real.render(...args); writeFileSync(h.source, LEASE + 'User edited the source during rendering.'); return result;
    });
    const h: Host = await host({ presentationRenderer: { render } });
    await draftWaitingForSave(h); await resumeSave(h); const second = h.workerTurn();
    const result = await second.tools.run('write_presentation', pptPart(h.output, '', true));
    expect(result.presentationWrite?.code).toBe('source-changed'); expect(existsSync(h.output)).toBe(false);
    expect(h.resolver.draftCustodianOf(second.card.attemptId)!.standing(second.card.attemptId, 'summary', 'write_presentation')).toEqual({ state: 'gone' });
    await h.workerReply(second.handle, []);
  });
  it('R3 T2 steps 2-3, as the fallback for a grant taken back: the lease Read wakes once; the draft is prepared and its save refused; the folder\'s Read + Write wakes once; the resumed task adopts the draft and saves each block once; Complete, predecessor replaced', async () => {
    const h = await host();
    const { message, requestId, first, saveWait } = await draftWaitingForSave(h);
    // The settled task's result says what waits and what for; the request stays owned, the run open and waiting.
    const settled = h.results.get(first.handle)!;
    expect(settled).toContain(`Task ${first.handle} did not finish. Its draft "summary" is kept with every part (3 parts, 3 blocks), and its save waits for the user's Read + Write access to File summary.docx`);
    expect(settled).toContain('Do not dispatch it again. When it can continue, you will be told in this request, with a resume_ref.');
    expect(settled).not.toMatch(REF);
    expect(saveWait).not.toBe('');
    expect(h.refs.hasWaiting(requestId)).toBe(true);
    expect(h.mgr.requestOwned(requestId)).toBe(true);
    const run = h.run(message.id)!;
    expect(run.status).toBe('open');
    expect(run.awaitingAccess?.needs).toEqual([expect.objectContaining({ label: 'File summary.docx', access: 'readwrite', step: 'save' })]);
    expect(run.awaitingAccess?.ended).toBeUndefined();

    const { wake, dispatched } = await resumeSave(h);
    // The folder's grant before the dispatch owed none, the lease's one; the folder's grant again owes the save's one.
    expect(h.wakesQueued).toEqual([0, 1, 1]);
    expect(wake).toContain(`Task ${first.handle} prepared the draft "summary", which can be saved now: call dispatch_task with agent "dev", resume_ref`);
    expect(h.mgr.currentRequestId('pm')).toBe(requestId);
    expect(dispatched).toContain(`Task ${first.handle} will be recorded as replaced by this task when this worker is admitted.`);
    const second = h.workerTurn();
    expect(second.card.attemptId).not.toBe(first.card.attemptId);
    // Re-keyed in one step: the earlier attempt holds nothing of it any more, the new one holds all of it.
    const custodian = h.resolver.draftCustodianOf(first.card.attemptId)!;
    expect(custodian.standing(first.card.attemptId, 'summary')).toEqual({ state: 'gone' });
    expect(custodian.standing(second.card.attemptId, 'summary')).toMatchObject({ state: 'held', draft: { parts: 3, blocks: 3 } });
    expect(second.instruction).toContain('The draft "summary" that dev prepared for this task in its earlier attempt is yours now, with every part (3 parts, 3 blocks).');
    expect(second.instruction).toContain('call write_document with draft "summary", final: true and no new blocks');
    // The predecessor is replaced in the admission step itself, while the new task still runs.
    const superseded = () => h.ledger().snapshot().flatMap((row) => row.delegations).find((row) => row.handle === first.handle)!.dispositions;
    expect(superseded()).toEqual([expect.objectContaining({ disposition: 'superseded', replacementHandle: second.handle })]);
    const saved = await second.tools.run('write_document', part(h.output, '', true));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(h.renderer.render).toHaveBeenCalledTimes(1);
    expect(h.blocksRendered()).toEqual(['PART-ONE', 'PART-TWO', 'PART-THREE']);
    expect(readFileSync(h.output).subarray(0, 2).toString()).toBe('PK');
    await h.workerReply(second.handle, [saved.path!]);
    h.team.beginTurnContentReceipts();
    expect(await h.team.run('record_task_disposition', { handle: second.handle, disposition: 'accepted' })).toMatch(/^Recorded/);
    h.bus.send('pm', 'user', 'task.complete', { instruction: 'Saved the summary.' }, 'normal', message.id);
    const job = h.job(message.id);
    expect(job.completion).toBe('complete');
    expect(job.remaining.access).toBeUndefined();
    expect(superseded()).toEqual([expect.objectContaining({ disposition: 'superseded', replacementHandle: second.handle })]);
    // Exactly the two wakes: the lease's and the folder's.
    expect(h.pm.turns).toHaveLength(3);
  });

  it('T2b 4: resumed to another teammate, the draft is not used: the card says so and the new attempt prepares again; the draft stays with its owner', async () => {
    const h = await host();
    const { first } = await draftWaitingForSave(h);
    const { dispatched } = await resumeSave(h, 'dev2');
    expect(dispatched).toMatch(/^Dispatched contract .* to dev2\./);
    const other = h.workerTurn('dev2');
    expect(other.instruction).toContain('[UnodeAi] The earlier draft "summary" of this task was not used: it belongs to dev, and this task went to dev2. Prepare the document again from this task\'s contract and save it.');
    // The other teammate naming the draft gets nothing, and nothing is written.
    expect(await other.tools.run('write_document', part(h.output, '', true)))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    expect(existsSync(h.output)).toBe(false);
    expect(h.resolver.draftCustodianOf(first.card.attemptId)!.standing(first.card.attemptId, 'summary')).toMatchObject({ state: 'held' });
  });

  it('T2b 4 / R3 adoption 2: the source changed after the attempt: not adopted, the draft discarded, the work redone', async () => {
    const h = await host();
    const { first } = await draftWaitingForSave(h);
    writeFileSync(h.source, `${LEASE}Clause 2. Added later.\n`);
    await resumeSave(h);
    const second = h.workerTurn();
    expect(second.instruction).toContain('[UnodeAi] The earlier draft "summary" of this task was not used: the contract\'s source changed since it was prepared, so the draft was discarded.');
    expect(h.resolver.draftCustodianOf(first.card.attemptId)!.standing(first.card.attemptId, 'summary')).toEqual({ state: 'gone' });
    expect(await second.tools.run('write_document', part(h.output, '', true)))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    expect(existsSync(h.output)).toBe(false);
  });

  it('R3 adoption 5: the destination is no longer where it was (its folder now leads elsewhere): not adopted, and nothing is written there', async () => {
    const h = await host();
    const { requestId } = await draftWaitingForSave(h);
    const elsewhere = folder();
    rmdirSync(h.outDir);
    symlinkSync(elsewhere, h.outDir, 'junction');
    const grant = await h.consent.requestPathAccess(h.outDir, { requestId, isCurrent: () => true }, async () => ({ permission: 'readwrite', lifetime: 'session' }));
    expect(grant).toBeDefined();
    h.items.hooks.granted!(grant!, requestId);
    await flush();
    expect(h.wakesQueued.at(-1)).toBe(1);
    await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] });
    const second = h.workerTurn();
    expect(second.instruction).toContain('[UnodeAi] The earlier draft "summary" of this task was not used: its destination is no longer where it was when the draft was prepared.');
    expect(await second.tools.run('write_document', part(h.output, '', true)))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('T2b 4: the teammate was retired: its draft is gone with it, and the resumed task is told and prepares again', async () => {
    const h = await host();
    await draftWaitingForSave(h);
    h.tools.get('dev')!.retire();
    // Its backend is replaced; the new one has new file tools.
    const fresh = new WorkspaceTools(h.root, new Set(['read', 'write']), 'dev');
    fresh.setTaskInputResolver(h.resolver);
    h.tools.set('dev', fresh);
    await resumeSave(h);
    const second = h.workerTurn();
    expect(second.instruction).toContain('The earlier draft "summary" of this task was not used: it is no longer held');
    expect(await second.tools.run('write_document', part(h.output, '', true)))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
  });

  it('T2b 4: the draft was already saved by its own attempt: the resumed task is told the receipt and writes nothing again', async () => {
    const h = await host();
    const { first } = await draftWaitingForSave(h);
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    // A late call of the settled attempt (its wait had ended, its teammate kept going) saved the kept draft.
    const late = h.tools.get('dev')!;
    late.setTaskAttempt(first.card);
    const saved = await late.run('write_document', part(h.output, '', true));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    const bytes = readFileSync(h.output);
    const mtime = statSync(h.output).mtimeMs;
    const wake = h.pm.turns.at(-1)!;
    await h.dispatch({ resume_ref: REF.exec(wake)![1] });
    const second = h.workerTurn();
    expect(second.instruction).toContain('[UnodeAi] The earlier draft "summary" of this task was already saved, and nothing is to be written again');
    expect(second.instruction).toContain('do not write it again');
    expect(h.renderer.render).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.output).equals(bytes)).toBe(true);
    expect(statSync(h.output).mtimeMs).toBe(mtime);
  });

  it('T2b 4: a stranger attempt that names the draft gets nothing, and the owner\'s adopted save still writes it once', async () => {
    const h = await host();
    await draftWaitingForSave(h);
    await resumeSave(h);
    const second = h.workerTurn();
    // Another attempt of the same agent, and another agent, naming the same draft.
    const stranger = new WorkspaceTools(h.root, new Set(['read', 'write']), 'dev');
    stranger.setTaskInputResolver(h.resolver);
    stranger.setDocumentRenderer(h.renderer);
    stranger.setTaskAttempt({ ...second.card, attemptId: 'attempt-stranger' } as TaskAttemptCard);
    expect(await stranger.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    const otherAgent = h.workerTurn('dev2', { ...h.assigned.at(-1)!, payload: { ...h.assigned.at(-1)!.payload, taskAttempt: { ...second.card, agentId: 'dev2' } } } as Message);
    expect(await otherAgent.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    expect(existsSync(h.output)).toBe(false);
    const owner = h.workerTurn();
    expect(await owner.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(h.blocksRendered()).toEqual(['PART-ONE', 'PART-TWO', 'PART-THREE']);
  });
});

describe('v0.9.101 H2b (R4): the source, at adoption and at the write boundary', () => {
  it('R4 1: the source\'s Read is lost before the save: needs-access, draft kept, the item asks for the source, nothing says it changed; its regrant wakes once and the same blocks are saved once', async () => {
    const h = await host();
    const { message } = await draftWaitingForSave(h);
    await resumeSave(h);
    const second = h.workerTurn();
    // The lease's request grant is revoked after adoption, before the save.
    const lease = h.consent.listPathAccess().find((grant) => grant.path === h.source)!;
    h.consent.revokePathAccess(lease.id);
    const offeredBefore = h.offered.length;
    const refused = await second.tools.run('write_document', part(h.output, '', true));
    expect(refused).toMatchObject({ status: 'refused', reason: 'needs-access', documentWrite: { code: 'source-needs-access' } });
    expect(refused.output).toContain('nothing says the source changed');
    expect(refused.output).not.toMatch(/source changed since/);
    expect(existsSync(h.output)).toBe(false);
    expect(h.offered.slice(offeredBefore)).toEqual([{ agentId: 'dev', target: h.source }]);
    expect(h.itemFor(h.source)).toMatchObject({ state: 'needs-access' });
    await h.workerReply(second.handle, []);
    await h.reply('The save waits for the lease again.');
    const waiting = h.results.get(second.handle)!;
    expect(waiting).toContain(`Its draft "summary" is kept with every part (3 parts, 3 blocks), and its save waits for the user's Read access to File lease.txt`);
    expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ label: 'File lease.txt', access: 'read', step: 'save' })]);
    const turns = h.pm.turns.length;
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.wakesQueued.at(-1)).toBe(1);
    expect(h.pm.turns).toHaveLength(turns + 1);
    await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] });
    const third = h.workerTurn();
    expect(third.instruction).toContain('is yours now, with every part (3 parts, 3 blocks)');
    expect(await third.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    // The refused save had rendered before its write boundary refused it; the one written renders each block once.
    expect(h.renderer.render).toHaveBeenCalledTimes(2);
    expect(h.blocksRendered(1)).toEqual(['PART-ONE', 'PART-TWO', 'PART-THREE']);
    expect(readFileSync(h.output).subarray(0, 2).toString()).toBe('PK');
  });

  it('R4 2: the source changes while the renderer runs: the write boundary finds it changed, nothing is written, the draft is discarded', async () => {
    let change: (() => void) | undefined;
    const h = await host({ render: async (request) => { change?.(); return renderReal(request); } });
    await draftWaitingForSave(h);
    await resumeSave(h);
    const second = h.workerTurn();
    change = () => writeFileSync(h.source, `${LEASE}Clause 9. Changed during rendering.\n`);
    const stopped = await second.tools.run('write_document', part(h.output, '', true));
    expect(h.renderer.render).toHaveBeenCalledTimes(1);
    expect(stopped).toMatchObject({ status: 'failed', documentWrite: { code: 'source-changed' } });
    expect(stopped.output).toContain('The source changed since this draft was prepared; prepare it again.');
    expect(existsSync(h.output)).toBe(false);
    expect(h.resolver.draftCustodianOf(second.card.attemptId)!.standing(second.card.attemptId, 'summary')).toEqual({ state: 'gone' });
  });

  it('R4 3: the owner\'s Folder Access now excludes the source: needs-action naming the limit, no grant offered, the draft kept', async () => {
    const h = await host();
    const { message } = await draftWaitingForSave(h);
    await resumeSave(h);
    const second = h.workerTurn();
    h.configs.dev = { ...h.configs.dev, folderAccess: [{ path: h.outDir, permission: 'readwrite' }] };
    const offeredBefore = h.offered.length;
    const refused = await second.tools.run('write_document', part(h.output, '', true));
    expect(refused).toMatchObject({ status: 'refused', documentWrite: { code: 'source-limit' } });
    expect(refused.output).toContain('a grant cannot change that');
    expect(h.offered.length).toBe(offeredBefore);
    expect(existsSync(h.output)).toBe(false);
    await h.workerReply(second.handle, []);
    expect(h.results.get(second.handle)).toContain('a grant cannot help it: File lease.txt is outside dev\'s Folder Access; a grant cannot change that.');
    expect(h.refs.hasWaiting(h.mgr.currentRequestId('pm'))).toBe(false);
    await h.reply('Told the user: the lease is outside Dev\'s Folder Access.');
    expect(h.offered.length).toBe(offeredBefore);
    expect(h.resolver.draftCustodianOf(second.card.attemptId)!.standing(second.card.attemptId, 'summary')).toMatchObject({ state: 'held' });
    const job = h.job(message.id);
    expect(job.remaining.access).toMatchObject({ state: 'hard-limit' });
    expect(job.remaining.access!.text).toMatch(/^Needs action: Read for File lease\.txt .* is outside the teammate's Folder Access, and a grant cannot change that\. The prepared draft was kept but not saved\./);
    expect(job.completion).toBe('partial');
  });

  it('R4 4: the save owes no wake while the source is unreadable, nor for the source alone while the output is not writable', async () => {
    const h = await host();
    const { requestId } = await draftWaitingForSave(h);
    // The source's request grant ends; then the source alone is granted again: the output is still not writable.
    const lease = h.consent.listPathAccess().find((grant) => grant.path === h.source)!;
    h.consent.revokePathAccess(lease.id);
    const again = await h.consent.requestPathAccess(h.source, { requestId, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
    h.items.hooks.granted!(again!, requestId);
    await flush();
    expect(h.wakesQueued.at(-1)).toBe(0);
    // Now the source is unreadable and the output is granted: still no wake.
    h.consent.revokePathAccess(again!.id);
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.wakesQueued.at(-1)).toBe(0);
    const turns = h.pm.turns.length;
    // Both: exactly one wake.
    const both = await h.consent.requestPathAccess(h.source, { requestId, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    h.items.hooks.granted!(both!, requestId);
    await flush();
    expect(h.wakesQueued.at(-1)).toBe(1);
    expect(h.pm.turns).toHaveLength(turns + 1);
  });

  it('R4 5: no digest of the source was recorded (a current input the teammate never read): adoption is refused as "could not be confirmed", not "changed"', async () => {
    const h = await host();
    await draftWaitingForSave(h, { freshness: 'current', readSource: false });
    await resumeSave(h);
    const second = h.workerTurn();
    expect(second.instruction).toContain('The earlier draft "summary" of this task was not used: it could not be confirmed against its source');
    expect(second.instruction).not.toMatch(/source changed/);
  });

  it('a current input the teammate read with read_file is digested from those bytes: the draft is adopted and saved once', async () => {
    const h = await host();
    await draftWaitingForSave(h, { freshness: 'current', readSource: true });
    await resumeSave(h);
    const second = h.workerTurn();
    expect(second.instruction).toContain('is yours now, with every part (3 parts, 3 blocks)');
    expect(await second.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
  });

  it('R4 6: a reload ends a save that waited: the outcome says a draft had been prepared, and no turn starts', async () => {
    const h = await host();
    const { message } = await draftWaitingForSave(h);
    const stored = JSON.parse(JSON.stringify(h.ledger().snapshot()));
    const fresh = new RunLedger(stored, { host: { hostInstanceId: 'fresh-host', epoch: 'e2' } as never });
    fresh.reconcileRestoredActiveDelegations();
    expect(fresh.reconcileRestoredAwaitingAccess()).toBe(1);
    const run = fresh.snapshot().find((row) => row.correlationIds.includes(message.id))!;
    expect(run.status).toBe('closed');
    const outcome = projectJobOutcome(run.id, fresh.get(run.id), () => undefined);
    if (outcome.state !== 'available') throw new Error(outcome.state);
    expect(outcome.remaining.access?.text).toMatch(/^The wait for access ended when the window reloaded: Read \+ Write for File summary\.docx .*\. A draft had been prepared; reload did not resume this work or repeat any save, and the draft was not kept\./);
    const turns = h.pm.turns.length;
    await flush();
    expect(h.pm.turns).toHaveLength(turns);
  });
});

describe('v0.9.101 H2b (audit H2b-1): a source that cannot be read now is not a changed source', () => {
  afterEach(() => { failingReads.count = 0; failingReads.injected = 0; });

  it('at adoption: the ref is not used, the draft is kept, nothing says changed, no grant is offered; the same ref later adopts it and saves once', async () => {
    const h = await host();
    const { first } = await draftWaitingForSave(h);
    const before = h.pm.turns.length;
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(before + 1);
    const ref = REF.exec(h.pm.turns.at(-1)!)![1];
    const offeredBefore = h.offered.length;
    Object.assign(failingReads, { target: h.source, count: 1 });
    const result = await h.dispatch({ resume_ref: ref });
    expect(failingReads.injected).toBe(1);
    expect(readFileSync(h.source, 'utf8')).toBe(LEASE);
    expect(result).toMatch(new RegExp(`^Error: resume_ref ${ref} was not used: File lease\\.txt \\(.*\\) could not be read now`));
    expect(result).toContain('Nothing says the source changed, the draft is kept with dev');
    expect(result).not.toMatch(/source changed since|discarded/);
    expect(h.assigned).toHaveLength(1);
    expect(h.offered.length).toBe(offeredBefore);
    expect(h.resolver.draftCustodianOf(first.card.attemptId)!.standing(first.card.attemptId, 'summary')).toMatchObject({ state: 'held' });
    // Read again later: the same ref adopts the draft, and it is saved once.
    expect(await h.dispatch({ resume_ref: ref })).toMatch(/^Dispatched contract/);
    const second = h.workerTurn();
    expect(second.instruction).toContain('is yours now, with every part (3 parts, 3 blocks)');
    expect(await second.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(h.blocksRendered()).toEqual(['PART-ONE', 'PART-TWO', 'PART-THREE']);
  });

  it('at the write boundary: nothing is written, the draft is kept, nothing says changed, no grant is offered; the save tried again writes it once', async () => {
    const h = await host();
    await draftWaitingForSave(h);
    await resumeSave(h);
    const second = h.workerTurn();
    const offeredBefore = h.offered.length;
    Object.assign(failingReads, { target: h.source, count: 1 });
    const stopped = await second.tools.run('write_document', part(h.output, '', true));
    expect(failingReads.injected).toBe(1);
    expect(stopped).toMatchObject({ status: 'failed', documentWrite: { code: 'source-unreadable' } });
    expect(stopped.output).toContain('could not be compared with it; nothing says the source changed. The draft is kept with every part');
    expect(stopped.output).not.toMatch(/source changed since|discarded/);
    expect(existsSync(h.output)).toBe(false);
    expect(h.offered.length).toBe(offeredBefore);
    expect(h.resolver.draftCustodianOf(second.card.attemptId)!.standing(second.card.attemptId, 'summary')).toMatchObject({ state: 'held', draft: { blocks: 3 } });
    expect(await second.tools.run('write_document', part(h.output, '', true))).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(h.blocksRendered(1)).toEqual(['PART-ONE', 'PART-TWO', 'PART-THREE']);
  });

  it('a file status that could not be read (EACCES at the access check\'s stat) is not a changed or missing source: the draft is kept, and a real missing file is still missing-input at dispatch', async () => {
    const h = await host();
    const { first } = await draftWaitingForSave(h);
    const realCheck = h.adapter.checkTaskSource.bind(h.adapter);
    const realAccess = h.adapter.contractInputAccess.bind(h.adapter);
    let comparing = false;
    let injected = 0;
    const check = vi.spyOn(h.adapter, 'checkTaskSource').mockImplementation(async (...args) => {
      comparing = true;
      try { return await realCheck(...args); } finally { comparing = false; }
    });
    // The access check's own stat seam fails once, as the operating system reports it, during the comparison only.
    const access = vi.spyOn(h.adapter, 'contractInputAccess').mockImplementation((config, target, requestId, probe) =>
      comparing && path.resolve(target) === path.resolve(h.source) && injected++ === 0
        ? realAccess(config, target, requestId, { physical: realpathSync.native, stat: () => {
          throw Object.assign(new Error('permission denied reading the file status'), { code: 'EACCES' });
        } })
        : realAccess(config, target, requestId, probe));
    const offeredBefore = h.offered.length;
    try {
      await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'request' });
      const result = await h.dispatch({ resume_ref: REF.exec(h.pm.turns.at(-1)!)![1] });
      expect(injected).toBe(1);
      expect(result).toMatch(/was not used: File lease\.txt \(.*\) could not be read now/);
      expect(result).not.toMatch(/source changed since|discarded/);
    } finally { access.mockRestore(); check.mockRestore(); }
    expect(readFileSync(h.source, 'utf8')).toBe(LEASE);
    expect(h.offered.length).toBe(offeredBefore);
    expect(h.assigned).toHaveLength(1);
    expect(h.resolver.draftCustodianOf(first.card.attemptId)!.standing(first.card.attemptId, 'summary')).toMatchObject({ state: 'held' });
    // The same seam: EACCES could not be inspected; ENOENT is positively missing, as dispatch admission has always said.
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const throwing = (error: Error) => ({ physical: realpathSync.native, stat: () => { throw error; } });
    const requestId = h.mgr.currentRequestId('pm');
    expect(h.adapter.contractInputAccess(h.configs.dev, h.source, requestId, throwing(eacces))).toMatchObject({ status: 'unavailable' });
    expect(h.adapter.contractInputAccess(h.configs.dev, h.source, requestId, throwing(enoent))).toEqual({ status: 'missing-input' });
  });
});

describe('v0.9.101 H2b: ends and the G3 window', () => {
  it('cancel_task on the waiting save ends it: Abandoned, and a later grant starts nothing', async () => {
    const h = await host();
    const { message, saveWait } = await draftWaitingForSave(h);
    await h.ask('Something else.');
    expect(await h.cancel(saveWait)).toBe(`Abandoned task "${saveWait}": its earlier attempt had settled and it was waiting for access, so nothing was stopped. A later grant does not start it, and its prepared draft is not saved. Tell the user it was not done.`);
    await h.reply('Dropped.');
    const turns = h.pm.turns.length;
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'session' });
    expect(h.pm.turns).toHaveLength(turns);
    expect(h.job(message.id).remaining.access?.text).toMatch(/^Abandoned while waiting for access: Read \+ Write for File summary\.docx/);
  });

  it('Stop while the save waits voids it: no wake, no dispatch, and its ref is gone', async () => {
    const h = await host();
    const { message, requestId } = await draftWaitingForSave(h);
    expect(h.refs.hasWaiting(requestId)).toBe(true);
    h.mgr.interrupt('pm');
    await flush();
    expect(h.refs.hasWaiting(requestId)).toBe(false);
    expect(h.run(message.id)!.awaitingAccess?.ended?.reason).toBe('stopped');
    const turns = h.pm.turns.length;
    await h.grant(h.outDir, { permission: 'readwrite', lifetime: 'session' });
    expect(h.pm.turns).toHaveLength(turns);
    expect(h.assigned).toHaveLength(1);
  });

  it('the G3 window: a teammate\'s refused read, settled and granted after the PM\'s turn ended, wakes the PM in that request and the retry replaces the task', async () => {
    const h = await host();
    const { message, requestId } = await h.ask();
    // The output it declares is granted before the dispatch, as the Owner's rule asks; the lease it reads is not declared.
    await h.consent.requestPathAccess(h.outDir, { requestId, isCurrent: () => true }, async () => ({ permission: 'readwrite', lifetime: 'session' }));
    const plain = { ...saveContract(h.source, h.outDir, h.output), inputs: [], effects: { read_files: [], expected_file_effect: 'create' } };
    const dispatched = await h.dispatch({ contract: plain });
    const handle = /Handle: ([^\s.]+)/.exec(dispatched)![1];
    const turn = h.workerTurn();
    expect((await turn.tools.run('read_file', { path: h.source })).status).toBe('refused');
    await h.workerReply(handle, []);
    await h.reply('The teammate could not read the lease.');
    const waiting = h.results.get(handle)!;
    expect(waiting).toContain(`Task ${handle} did not finish. It waits for the user's Read access to File lease.txt`);
    expect(h.refs.hasWaiting(requestId)).toBe(true);
    expect(h.run(message.id)!.status).toBe('open');
    expect(h.run(message.id)!.awaitingAccess?.needs).toEqual([expect.objectContaining({ access: 'read', step: 'retry' })]);
    await h.grant(h.source, { permission: 'read', lifetime: 'request' });
    expect(h.pm.turns).toHaveLength(2);
    expect(h.pm.turns[1]).toContain(`Task ${handle} stopped for lack of this access and can be retried now`);
    expect(h.mgr.currentRequestId('pm')).toBe(requestId);
    const retried = await h.dispatch({ resume_ref: REF.exec(h.pm.turns[1])![1] });
    expect(retried).toContain(`Task ${handle} will be recorded as replaced by this task`);
    const retry = /Handle: ([^\s.]+)/.exec(retried)![1];
    expect(h.run(message.id)!.delegations.find((row) => row.handle === handle)!.dispositions)
      .toEqual([expect.objectContaining({ disposition: 'superseded', replacementHandle: retry })]);
  });
});
