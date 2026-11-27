import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
}));

import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { renderDocx, type DocumentZip } from '../../content/document/DocxRenderer';
import type { CanonicalDocumentRequest } from '../../content/document/DocumentContracts';
import { accessPhysicalPath, SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { samePath } from '../../backend/folderAccess';
import { isPathInsideOrEqual } from '../../backend/pathContainment';
import { AccessTable } from '../AccessTable';
import { createPathAccessOffer, PathAccessRequestItems, pathAccessItemView, pathAccessNoticeText } from '../PathAccessOffer';
import { endedRequestContinuation } from '../requestContinuation';
import { namedOutsidePaths, reachesAnotherComputer } from '../namedOutsidePaths';
import { grantNoticeLine, grantWaitingTaskLine } from '../grantNoticeText';
import { TeamTools, type TeamRosterEntry } from '../../backend/TeamTools';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { NoopFileCoordinator } from '../../backend/FileCoordinator';
import { FileWritePolicy } from '../../backend/fileWritePolicy';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../orchestration/OrchestrationHostAdapter';
import { SessionManager } from '../../session/SessionManager';
import { RequestCloseoutStore } from '../../observability/RequestCloseoutStore';
import { projectRequestSummary } from '../../observability/RequestCloseout';
import { jobUsageLookup, noJobUsage } from '../../observability/JobOutcomeUsage';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { bootWebviewScript, type WebviewElement } from '../../views/__tests__/support/webviewBoot';
import { parseChatTurnTrigger, parseChatVerbatim, parseDelegationCounts } from '../../views/chatHistory';
import { emptyReplyNotice, parseResponseOutcome } from '../../backend/emptyReplyOutcome';
import { parseTurnOutcomeReceipt } from '../../session/turnOutcomeReceipt';
import { parseTurnInterruption } from '../../backend/TurnInterruption';
import { agentConfig, tempFolder } from '../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, Message } from '../../types';

// Each flow starts a real Claude backend under a real session manager and renders a DOCX; the warm mutation worker's
// 5 s budget is for unit proofs, and one of these run alone also pays the first parse of src/extension.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/*
 * v0.9.102, the independent audit of e4be588e: the production chain from what the
 * Claude CLI reports to what the person and the PM are told, with only the CLI process faked.
 *
 * Real: SessionManager (its turns, requests, task.assign delivery, terminal task.complete with the turn's evidence, its
 * request closeout accumulator and async result wake), ClaudeHeadlessBackend (its stream-json parsing, its files bridge
 * MCP server reached over HTTP, its turn evidence and turn result), the host file tools as src/extension.ts builds
 * them (its own cliHostFileTools, makeFileWritePolicy and livePathAccess, run against this harness's objects),
 * TeamTools dispatch_task and settlement, the OrchestrationHostAdapter's admission and resolver, the real grant store,
 * the RequestCloseoutStore, and the ChatViewProvider with src/extension.ts's own reply adapter and summary wiring.
 * For file access (fix 7): src/extension.ts's own access table, request items, the agent's offer (fileOutsideRoot, with
 * its present port), the host tools' refusal wiring to it, and the named offer as a request starts.
 *
 * Fake: the Claude CLI process (its stdin is recorded; its stdout lines are the stream-json events a CLI writes, and
 * it calls the files bridge as the CLI does), the PM's model (a scripted backend whose dispatch_task call is made
 * here, in its turn), the DOCX renderer worker (the same renderer run in process), the text checkpoint recorder, and
 * the `vscode` API itself: its warning message records the text the person is shown and is dismissed.
 */

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-pe-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

const flush = async () => {
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
};

/* ---------------------------------------------------------------------------------------------------------------------
 * src/extension.ts's own code, parsed once and run against this harness's objects (the technique of
 * AskForAccess.flows.test and ApproveForMeClaudeDefault.test): a change to how activation wires these is what runs.
 * ------------------------------------------------------------------------------------------------------------------- */
const named = (kind: 'function' | 'property' | 'variable', name: string) => (node: ts.Node, source: ts.SourceFile) =>
  kind === 'function' ? ts.isFunctionDeclaration(node) && node.name?.getText(source) === name
    : kind === 'property' ? ts.isPropertyAssignment(node) && node.name.getText(source) === name
      : ts.isVariableDeclaration(node) && node.name.getText(source) === name;
const WIRINGS = {
  // The host file tools a Claude or Codex agent gets (write_document, save_attachment).
  cliHostFileTools: named('function', 'cliHostFileTools'),
  // The workspace's write policy, which tells a request's closeout each file effect it observed.
  makeFileWritePolicy: named('function', 'makeFileWritePolicy'),
  // An agent's live path grants: its current request's grants from the grant store.
  livePathAccess: named('variable', 'livePathAccess'),
  // The bus-to-chat reply adapter.
  onReply: named('property', 'onReply'),
  // v0.9.103: it shows a reply together with the records and Job outcome the reply closed.
  deliverReply: named('function', 'deliverReply'),
  normalizeEpoch: named('function', 'normalizeEpoch'),
  // Where the chat reads a turn's request closeout record and its summary view.
  requestCloseouts: named('property', 'requestCloseouts'),
  requestSummaryView: named('property', 'requestSummaryView'),
  currentRequestSummaryView: named('function', 'currentRequestSummaryView'),
  // Every ended top-level turn's record is kept in the store.
  keepRequestCloseout: (node: ts.Node, source: ts.SourceFile) => ts.isCallExpression(node)
    && node.expression.getText(source) === 'sessionManager.on' && node.arguments[0]?.getText(source) === "'session.requestCloseout'",
  // The project's access table and its request items, shared by every agent's offer.
  accessTable: named('variable', 'accessTable'),
  requestAccessItems: named('variable', 'requestAccessItems'),
  // An agent's offer of file access: its item in the chat and its notice (the `present` port).
  fileOutsideRoot: named('variable', 'fileOutsideRoot'),
  // A refusal of a Claude or Codex agent's host file tools goes to that offer.
  cliOnFileOutsideRoot: (node: ts.Node, source: ts.SourceFile) => ts.isPropertyAssignment(node)
    && node.name.getText(source) === 'onFileOutsideRoot' && ts.isObjectLiteralExpression(node.parent)
    && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression.getText(source) === 'cliHostFileTools',
  // As a person's request starts, each outside path it names is offered.
  userRequestStarted: named('property', 'userRequestStarted'),
  offerNamedOutsidePaths: named('function', 'offerNamedOutsidePaths'),
};
type Wiring = keyof typeof WIRINGS;
/** Properties of an options object: not written means not given. */
const OPTIONAL_WIRINGS = new Set<Wiring>(['cliOnFileOutsideRoot']);
let wiringScripts: Map<Wiring, string> | undefined;

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
    // An option property activation may leave out is then absent, as it would be in production.
    if (OPTIONAL_WIRINGS.has(name) && nodes.length === 0) { scripts.set(name, '__wired = undefined;'); continue; }
    expect(nodes, `one ${name} in src/extension.ts`).toHaveLength(1);
    const node = nodes[0];
    const text = ts.isFunctionDeclaration(node) ? `${node.getText(source)}\n__wired = ${node.name!.getText(source)};`
      : ts.isPropertyAssignment(node) ? `__wired = (${node.initializer.getText(source)});`
        : ts.isVariableDeclaration(node) ? `__wired = (${node.initializer!.getText(source)});`
          : `__wired = (${node.getText(source)});`;
    scripts.set(name as Wiring, ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  wiringScripts = scripts;
}

/** `scope` is read live, by reference: a getter in it answers when the wired code runs, as a module variable does. */
function productionWiring<T = unknown>(name: Wiring, scope: Record<string, unknown>): T {
  expect(wiringScripts, 'loadProductionWirings() ran in a beforeAll').toBeDefined();
  scope.__wired = undefined;
  new Function('host', `with (host) { ${wiringScripts!.get(name)!} }`)(scope);
  const wired = scope.__wired as T;
  delete scope.__wired;
  return wired;
}

/* ---------------------------------------------------------------------------------------------------------------------
 * The Claude CLI process: what the backend writes to its stdin is recorded, and the test writes the stream-json events
 * a CLI prints to its stdout. A host tool call goes to the backend's files bridge over HTTP, as the CLI makes it.
 * ------------------------------------------------------------------------------------------------------------------- */
class FakeClaudeCli {
  readonly turns: string[] = [];
  private proc: any;
  readonly spawn = () => {
    const proc = new EventEmitter() as any;
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: (text: string) => { this.turns.push(text); return true; }, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    this.proc = proc;
    return proc;
  };
  constructor(private readonly root: string) {}
  /** One stream-json line on the CLI's stdout. */
  print(event: unknown): void { this.proc.stdout.emit('data', `${JSON.stringify(event)}\n`); }
  /** The CLI's tool_use of a files-bridge tool, the call to the bridge it makes, and the tool_result it reports. */
  async bridgeTool(id: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const spec = this.filesBridge();
    this.print({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__${spec.id}__${tool}`, input: args }] } });
    await flush();
    const answer = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args, _meta: { 'claudecode/toolUseId': id } } });
    const output = String(answer.result.content[0].text);
    this.print({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, ...(answer.result.isError ? { is_error: true } : {}) }] } });
    await flush();
    return output;
  }
  /** The CLI's own Bash tool: it ran the command and reports its result, as the CLI's stream does. */
  async bash(id: string, command: string, output: string, isError: boolean): Promise<void> {
    this.print({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    await flush();
    this.print({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] } });
    await flush();
  }
  async finish(text: string): Promise<void> {
    this.print({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.print({ type: 'result', subtype: 'success', result: text });
    await flush();
  }
  private filesBridge(): { id: string; url: string; headers?: Record<string, string> } {
    const root = path.join(this.root, '.unode', 'claude');
    const [file] = existsSync(root) ? readdirSync(root).map((id) => path.join(root, id, 'mcp.json')).filter(existsSync) : [];
    const written = JSON.parse(readFileSync(file, 'utf8'));
    const id = Object.keys(written.mcpServers).find((key) => /^unode_files_[a-f0-9]{32}$/.test(key))!;
    return { id, ...written.mcpServers[id] };
  }
}

function rpc(spec: { url: string; headers?: Record<string, string> }, body: unknown): Promise<any> {
  const url = new URL(spec.url);
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: String(spec.headers?.Authorization ?? '') },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (out += chunk));
      res.on('end', () => resolve(out ? JSON.parse(out) : undefined));
    });
    req.on('error', reject);
    req.end(text);
  });
}

/** The PM's model: its turns are recorded, and its tool calls are made by the test between a turn's start and end. */
class ScriptedPm implements AgentBackend {
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

const docxRenderer = { render: async (request: CanonicalDocumentRequest) =>
  renderDocx(request, () => new (require('yazl') as { ZipFile: new () => DocumentZip }).ZipFile()) };

/**
 * One extension host: a PM (scripted model) and a Claude teammate `dev` (real backend, fake CLI process) under one
 * SessionManager, each built as src/extension.ts's backend factory builds the parts these flows exercise.
 */
async function host(options: { pm?: boolean; parentReadScope?: boolean } = {}) {
  // The workspace and a sibling output folder, in one parent: with the default parent read scope the agent can read
  // the sibling, and write only in its workspace. `outside` is in no folder the agent can read.
  const parent = folder();
  const root = path.join(parent, 'ws');
  mkdirSync(root);
  writeFileSync(path.join(root, 'notes.md'), 'workspace');
  const sibling = path.join(parent, 'out');
  mkdirSync(sibling);
  const outside = folder();
  const bus = new MessageBus();
  // What the person is shown: each warning message's text (it is dismissed), and the chat once a test puts one up.
  const warnings: string[] = [];
  let chatViewProvider: ChatViewProvider | undefined;
  const vscode = {
    workspace: { isTrusted: true, textDocuments: [], notebookDocuments: [], workspaceFolders: [{ uri: { fsPath: root } }] },
    window: {
      showWarningMessage: async (text: string) => { warnings.push(text); return undefined; },
      showQuickPick: async () => undefined,
    },
  };
  // src/extension.ts's own access table and request items.
  const accessTable = productionWiring<AccessTable>('accessTable', {
    AccessTable, get sessionManager() { return mgr; }, get orchestrationHost() { return adapter; },
    reachesAnotherComputer, path, accessPhysicalPath, statSync,
  });
  const requestAccessItems = productionWiring<PathAccessRequestItems>('requestAccessItems',
    { PathAccessRequestItems, queueAccessWakes: () => undefined, accessTable });
  const consent = new SessionLocalReadScopeConsent(async () => false, undefined, undefined, accessTable.grantRows);
  const agentPathAccessOffers = new Map<string, unknown>();
  const memento = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string) => memento.get(key),
    update: async (key: string, value: unknown) => { if (value === undefined) memento.delete(key); else memento.set(key, structuredClone(value)); },
  };
  const cli = new FakeClaudeCli(root);
  let pm: ScriptedPm | undefined;
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { name: 'PM', role: 'project-manager' as AgentConfig['role'], workingDirectory: root,
      provider: { providerId: 'anthropic', apiKeySecretName: 'K' }, model: 'claude-sonnet-4-20250514', skill: '', systemPrompt: '',
      autoApprove: true, allowedTools: [] }),
    dev: agentConfig('dev', { name: 'Dev', role: 'senior-dev' as AgentConfig['role'], backend: 'claude', workingDirectory: root,
      provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5', skill: '',
      systemPrompt: '', autoApprove: true, allowedTools: ['read', 'write'] }),
  };
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
      capabilities: { read: true, write: true, shell: true, verificationSensors: ['recorded-file-effect'], toolFamilies: ['read', 'write'], backend: 'claude', taskScope: 'per-turn' } },
  ];
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => (options.parentReadScope ? [parent] : []), isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: (agentId) => mgr.currentRequestId(agentId),
    offerPathAccess: () => undefined,
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const store = new ContentAssetStore();
  cleanups.push(() => store.dispose());
  const taskInputResolver = adapter.createTaskInputResolver(store);

  // The backend factory of src/extension.ts, for the parts it gives a Claude teammate's host file tools and backend.
  const recorded: unknown[] = [];
  let fileWritePolicy!: FileWritePolicy;
  const createBackend = (config: AgentConfig, launchId: string): AgentBackend => {
    if (config.id === 'pm') return (pm = new ScriptedPm(config));
    const scopedConfig = config;
    const livePathAccess = productionWiring('livePathAccess', { sessionManager: mgr, scopedConfig, vscode, localReadScopeConsent: consent });
    // src/extension.ts's own offer for this agent: its item goes to the chat, its notice to vscode.window.
    const fileOutsideRoot = productionWiring<(...args: unknown[]) => void>('fileOutsideRoot', {
      createPathAccessOffer, localReadScopeConsent: consent, scopedConfig, fullFileAccess: () => false, sessionManager: mgr, launchId,
      get chatViewProvider() { return chatViewProvider; }, vscode, pathAccessNoticeText, pathAccessItemView,
      showResultNotice: (_kind: string, text: string) => { warnings.push(`(result) ${text}`); },
      reachesAnotherComputer, path, statSync, endedRequestContinuation, messageBus: bus, grantNoticeLine, grantWaitingTaskLine,
      requestAccessItems,
      // Stand-ins for the parts no flow here reaches: a grant's wake and a resubmitted request.
      taskResumeRefs: { capture: () => undefined, waitsOn: () => false, grantNotice: (_a: string, _r: string, text: string) => ({ text, report: () => undefined }) },
      userRequests: { resubmit: () => undefined },
    });
    agentPathAccessOffers.set(scopedConfig.id, fileOutsideRoot);
    const fileWrites = fileWritePolicy.forAgent({
      agentId: config.id,
      requestId: () => mgr.currentRequestId(config.id),
      turnId: () => mgr.currentTurnId(config.id),
      notice: () => undefined,
      decide: async () => 'deny',
      base: root,
    });
    const cliHostFileTools = productionWiring<(options: Record<string, unknown>) => WorkspaceTools>('cliHostFileTools', {
      WorkspaceTools, NoopFileCoordinator, vscode, taskInputResolver,
      recordCheckpoint: (entry: unknown) => { recorded.push(entry); },
      configuredSetting: (_key: string, fallback: unknown) => fallback,
    });
    const hostFileTools = cliHostFileTools({
      root, agentId: config.id, mayWrite: true, mayExecute: false, livePathAccess, fullFileAccess: () => false,
      writeApprovalAsk: () => false, onFileOutsideRoot: productionWiring('cliOnFileOutsideRoot', { fileOutsideRoot }),
      writeRoots: [root], approveWrite: async () => 'once',
      fileWrites, requestBoundary: undefined, contentAssets: store, documentRenderer: docxRenderer,
      onDocumentWritten: (receipt: never, requestId: string | undefined) => mgr.noteDocumentWritten(requestId, receipt),
    });
    const backend = new ClaudeHeadlessBackend(config, undefined, undefined, {
      spawn: cli.spawn as never,
      writeRoots: [root],
      livePathAccess,
      taskInputResolver,
      delegationContentAssets: store,
      messageBus: bus,
      fileWrites,
      hostFileTools,
    });
    cleanups.push(() => backend.stop(50));
    return backend;
  };
  const offerNamedOutsidePaths = productionWiring('offerNamedOutsidePaths', {
    agentPathAccessOffers, vscode, localReadScopeConsent: consent, get sessionManager() { return mgr; }, namedOutsidePaths, samePath, isPathInsideOrEqual,
  });
  const mgr: SessionManager = new SessionManager(5, bus, { createBackend, resolveEnv: async () => ({}),
    userRequestStarted: productionWiring('userRequestStarted', { offerNamedOutsidePaths }) });
  fileWritePolicy = productionWiring<() => FileWritePolicy>('makeFileWritePolicy', {
    FileWritePolicy, vscode, sessionManager: mgr, rootWorkspaceState: workspaceState, OWN_FILE_EFFECTS_KEY: 'unode.ownFileEffects.v1',
    securityControlLocations: undefined, firstWorkspaceRoot: () => root, gitPathStatus: undefined, preChangeCheckpoints: undefined, fileWriterLeases: () => undefined,
  })();

  // The PM's TeamTools, as the adapter builds them for the parts these flows use: a settled task's result wakes the
  // PM through the session manager's async-result wake, which is how the PM is handed it.
  const results = new Map<string, string>();
  const team: TeamTools = new TeamTools('pm', adapter.makeTeamView(), bus, {
    timeoutMs: 60_000, cwd: root, evidenceEnabled: true, taskInputResolver,
    turnOrigin: () => ({ correlationId: mgr.currentTurnCorrelationId('pm'), turnId: mgr.currentTurnId('pm') }),
    onAsyncResultReady: (result) => {
      results.set(result.handle, result.text);
      return mgr.queueAsyncDelegationWake('pm', result, () => team.isAsyncResultReady(result.handle), () => team.consumeAsyncResult(result.handle));
    },
  });

  if (options.pm !== false) {
    mgr.create(configs.pm);
    await mgr.start('pm', { pin: 'take' });
    pm!.emit({ kind: 'ready' });
  }
  mgr.create(configs.dev);
  await mgr.start('dev', { pin: 'take' });
  await flush();

  return {
    root, outside, sibling, bus, mgr, consent, cli, team, results, recorded, workspaceState, warnings,
    setChat: (chat: ChatViewProvider) => { chatViewProvider = chat; },
    pm: () => pm!,
    /** The person's message starts a turn of a new request. */
    ask: async (to: string, instruction: string) => {
      bus.send('user', to, 'ask.question', { instruction });
      await flush();
      return mgr.currentRequestId(to)!;
    },
    /** The person's Read + Write for this request, in the real grant store. */
    grant: (target: string, requestId: string) => consent.requestPathAccess(target, { requestId, isCurrent: () => true },
      async () => ({ permission: 'readwrite' as const, lifetime: 'request' as const })),
    dispatch: async (contract: Record<string, unknown>) => {
      team.beginTurnContentReceipts();
      return (await team.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Write the bilingual summary.', contract })).output;
    },
    pmReply: async (text: string) => {
      pm!.emit({ kind: 'turn_complete', result: { text, isError: false } } as BackendEvent);
      await flush();
    },
  };
}

const docx = (target: string) => ({ schema_version: 1, path: target, format: 'docx', template: 'contract-v1',
  document: { title: 'Summary', language: 'en', blocks: [{ type: 'paragraph', content: [{ text: 'SUMMARY' }] }] } });

function summaryContract(target: string): Record<string, unknown> {
  return {
    version: 2,
    objective: 'Write a bilingual summary of the lease.',
    expected_deliverable: 'A bilingual summary document.',
    effects: { read_files: [], expected_file_effect: 'create' },
    inputs: [],
    outputs: [{ output_id: 'summary', path: target, kind: 'file', required: true }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    execution_strategy: 'delegate-required',
    verification_plan: { sensors: ['recorded-file-effect'], none_applies: 'report-no-applicable-sensor' },
  };
}

/*
 * GAP A, field fix 4 (field smoke T2 retest): the contract names an output in an outside folder the person granted
 * Read + Write; the Claude teammate's write_document used the relative "output/..." spelling, and the file landed in
 * the workspace's output folder. Nothing in this flow hands the settlement its evidence: the backend's own turn result
 * carries what its host tools wrote, the session manager sends it with task.complete, and TeamTools settles it.
 */
describe('v0.9.102 field fix 4, production entry: a Claude teammate\'s host write_document reaches the PM\'s settled result', () => {
  beforeAll(() => loadProductionWirings());

  async function delegatedWrite(spelling: (target: string) => string) {
    const h = await host();
    const requestId = await h.ask('pm', 'Summarise the lease into the output folder.');
    await h.grant(h.outside, requestId);
    const target = path.join(h.outside, 'summary.docx');
    const dispatched = await h.dispatch(summaryContract(target));
    expect(dispatched).toMatch(/^Dispatched contract contract-/);
    expect(dispatched).not.toMatch(/Required output/);
    await h.pmReply('Dispatched to Dev.');
    // The session manager delivered the task to the Claude teammate: its turn is on the CLI's stdin.
    await vi.waitFor(() => expect(h.cli.turns.length).toBeGreaterThan(0));
    expect(h.mgr.currentRequestId('dev')).toBe(requestId);
    // The task the model reads names the contract's output where the contract names it.
    const content = JSON.parse(h.cli.turns[0]).message.content;
    expect(typeof content === 'string' ? content : JSON.stringify(content)).toContain(`- summary [file; required]: ${target}`);
    const receipt = await h.cli.bridgeTool('doc-1', 'write_document', docx(spelling(target)));
    await h.cli.finish('Saved the bilingual summary.');
    // The PM's wake turn: what the PM is handed.
    await vi.waitFor(() => expect(h.pm().turns.length).toBe(2));
    const handed = h.pm().turns[1];
    const [handle] = [...h.results.keys()];
    // The evidence the session manager sent with the teammate's task.complete is the backend's own turn result.
    const completes = h.bus.query({}).filter((message: Message) => message.from === 'dev' && message.type === 'task.complete');
    expect(completes).toHaveLength(1);
    const evidence = (completes[0].payload.metadata as { delegationEvidence?: { changedFiles?: string[] } }).delegationEvidence;
    return { h, target, receipt, handed, result: h.results.get(handle)!, changedFiles: evidence?.changedFiles };
  }

  it('field T2: written as output/summary.docx, the file lands in the workspace output folder; the PM is told the output is not at its contract path and where it was written, and the task is verification-failed', async () => {
    const { h, target, receipt, handed, result, changedFiles } = await delegatedWrite(() => 'output/summary.docx');
    const landed = path.join(h.root, 'output', 'summary.docx');
    expect(changedFiles).toEqual(['output/summary.docx']);
    expect(receipt).toContain(`Document written: output/summary.docx\nFull path written: ${landed}\n`);
    expect(readFileSync(landed).subarray(0, 2).toString()).toBe('PK');
    expect(existsSync(target)).toBe(false);

    expect(result).toContain(`[task state: required-output-not-written] required output "summary" not written at ${target}; written instead: ${landed}.`);
    expect(result).toContain('[delegation: verification-failed]');
    expect(result).toContain('verification plan result: failed.');
    expect(result).toContain('A required output of the task contract is not where the contract names it. Do not mark this step done');
    expect(result).not.toContain('[delegation: verified]');
    // The PM's wake turn carries that same settled result.
    expect(handed).toContain(`required output "summary" not written at ${target}; written instead: ${landed}.`);
    expect(handed).toContain('[delegation: verification-failed]');
  });

  it('control: written at the contract\'s absolute path in the granted folder, the PM\'s result has no gap and the task is verified', async () => {
    const { target, receipt, handed, result, changedFiles } = await delegatedWrite((contractPath) => contractPath);
    expect(changedFiles).toHaveLength(1);
    expect(path.resolve(changedFiles![0])).toBe(target);
    expect(receipt).toContain(`Full path written: ${target}\n`);
    expect(readFileSync(target).subarray(0, 2).toString()).toBe('PK');

    expect(result).toContain('[delegation: verified]');
    expect(result).toContain('verification plan result: satisfied.');
    expect(result).not.toContain('required-output-not-written');
    expect(result).not.toContain('verification-failed');
    expect(handed).toContain('[delegation: verified]');
    expect(handed).not.toContain('required-output-not-written');
  });
});

/*
 * GAP B, field fix 1 (field T1/T5): the agent ran its tests with its own Bash tool and the Request summary said only
 * "checks not run". The command result comes from the Claude CLI's stream, through the backend's tool_result and the
 * session's request closeout, to the card the chat renders; nothing here gives the summary an observation.
 */
const kids = (node: WebviewElement | undefined): WebviewElement[] => (Array.isArray(node?.children) ? node.children : []) as WebviewElement[];
const text = (node: WebviewElement | undefined): string => String(node?.textContent ?? '');
const classed = (node: WebviewElement | undefined, name: string): WebviewElement | undefined =>
  kids(node).find((child) => String(child.className).split(' ').includes(name));

/** The Request summary cards the real webview script renders for the sidebar, in transcript order. */
function cards(chat: ChatViewProvider) {
  const boot = bootWebviewScript((chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
  const found: WebviewElement[] = [];
  const walk = (node: WebviewElement): void => {
    if (String(node.className).split(' ').includes('request-summary')) found.push(node);
    else kids(node).forEach(walk);
  };
  walk(boot.elements.get('transcript')!);
  return found.map((card) => {
    const [details] = kids(card);
    const [summary, body] = kids(details);
    return {
      headline: kids(classed(summary, 'job-outcome-line'))
        .filter((part) => String(part.className).startsWith('job-outcome-segment ')).map(text),
      rows: kids(body).flatMap((block) => {
        const cells = kids(classed(block, 'job-outcome-rows'));
        const rows: Array<{ section: string; label: string; value: string }> = [];
        for (let index = 0; index + 1 < cells.length; index += 2) rows.push({ section: text(block.children?.[0] as never), label: text(cells[index]), value: text(cells[index + 1]) });
        return rows;
      }),
    };
  });
}

async function chatHost(options: { parentReadScope?: boolean } = {}) {
  const h = await host({ pm: false, ...options });
  const store = new RequestCloseoutStore(h.workspaceState);
  let chat!: ChatViewProvider;
  const outputChannel = { warn: vi.fn(), info: vi.fn() };
  // src/extension.ts's own: every ended top-level turn's record is kept.
  productionWiring('keepRequestCloseout', { sessionManager: h.mgr, requestCloseoutStore: store, outputChannel, taskHistory: undefined,
    localReadScopeConsent: { endPathAccessRequest: () => undefined }, taskResumeRefs: { endRequest: () => undefined } });
  const currentRequestSummaryView = productionWiring('currentRequestSummaryView', {
    spendHost: undefined, jobUsageLookupCache: undefined, jobUsageLookup, noJobUsage, projectRequestSummary, sessionManager: h.mgr });
  // This host keeps no run ledger, so there is no Job outcome refresh waiting for a reply to bring forward.
  const deliverReply = productionWiring('deliverReply', { get chatViewProvider() { return chat; }, flushJobOutcomeSync: () => undefined });
  chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'dev', name: 'Dev', role: 'senior-dev' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
    onReply: productionWiring('onReply', {
      messageBus: h.bus, resolveAgentName: (id: string) => id, cliRuntimeFailureNotice: () => undefined, deliverReply,
      parseDelegationCounts, parseChatVerbatim, parseResponseOutcome, parseTurnOutcomeReceipt,
      parseChatTurnTrigger, parseTurnInterruption, emptyReplyNotice, normalizeEpoch: productionWiring('normalizeEpoch', {}),
      // v0.9.110: the adapter reads the request of the turn that ended from the real session manager.
      sessionManager: h.mgr,
    }) as ChatViewDeps['onReply'],
    state: h.workspaceState,
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
    requestCloseouts: productionWiring('requestCloseouts', { requestCloseoutStore: store }),
    requestSummaryView: productionWiring('requestSummaryView', { currentRequestSummaryView, outputChannel }),
    clearRequestCloseouts: (agentId: string) => store.clear(agentId),
  } as unknown as ChatViewDeps);
  chat.selectAgent('dev');
  h.setChat(chat);
  return { ...h, chat, store, outputChannel };
}

describe('v0.9.102 field fix 1, production entry: a Claude agent\'s own command reaches the Request summary on screen', () => {
  beforeAll(() => loadProductionWirings());

  /** The person asks the Claude agent; its CLI writes a document and runs a command with its own Bash tool. */
  async function turnWithCommand(h: Awaited<ReturnType<typeof chatHost>>, n: number, isError: boolean) {
    await h.ask('dev', 'Fix the parser and run the tests.');
    await vi.waitFor(() => expect(h.cli.turns.length).toBe(n));
    expect(await h.cli.bridgeTool(`doc-${n}`, 'write_document', docx(`out/notes-${n}.docx`))).toContain('Document written');
    await h.cli.bash(`bash-${n}`, 'npm test', isError ? 'Tests: 1 failed, 2 passed' : 'Tests: 3 passed', isError);
    await h.cli.finish('Done.');
  }

  it('field T1: a Bash command the agent ran says host checks not run, the agent ran 1 command of its own, with the Checks row Agent\'s own commands; one that ended with an error says so', async () => {
    const h = await chatHost();
    await turnWithCommand(h, 1, false);
    await vi.waitFor(() => expect(cards(h.chat)).toHaveLength(1));
    const [first] = cards(h.chat);
    expect(first.headline).toContain('host checks not run; the agent ran 1 command of its own');
    expect(first.headline.join(' · ')).not.toMatch(/passed|tests? /i);
    expect(first.rows).toContainEqual(expect.objectContaining({ label: "Agent's own commands",
      value: "1 ran, 0 ended with an error (not checks; see the agent's command cards)" }));

    await turnWithCommand(h, 2, true);
    await vi.waitFor(() => expect(cards(h.chat)).toHaveLength(2));
    const second = cards(h.chat)[1];
    expect(second.headline).toContain('host checks not run; the agent ran 1 command of its own, 1 ended with an error');
    expect(second.rows).toContainEqual(expect.objectContaining({ label: "Agent's own commands",
      value: "1 ran, 1 ended with an error (not checks; see the agent's command cards)" }));
    expect(h.outputChannel.warn).not.toHaveBeenCalled();
  });
});

/*
 * v0.9.102 field fix 7 (field smoke of edb898a9, T2): the request named an output folder beside the workspace, which the
 * agent can read through the default parent read scope but not write. Its item rightly said it can be read and writing
 * needs Read + Write; then a refused save there put up a notice saying the agent "could not reach it with the file
 * tools". Here the request starts the named offer and the Claude agent's host write_document is refused, through
 * src/extension.ts's own offer, refusal wiring and present port, to the warning message text and the item on screen.
 */
describe('v0.9.102 field fix 7, production entry: a refused save in a folder the agent can read is told as needing Read + Write', () => {
  beforeAll(() => loadProductionWirings());

  /** The file access items the real webview script renders, with the label of each button. */
  function accessItems(chat: ChatViewProvider) {
    const boot = bootWebviewScript((chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
    const found: WebviewElement[] = [];
    const walk = (node: WebviewElement): void => {
      if (String(node.className).includes('outcome-repair')) found.push(node);
      else kids(node).forEach(walk);
    };
    walk(boot.elements.get('transcript')!);
    const all = (node: WebviewElement): WebviewElement[] => kids(node).flatMap((child) => [child, ...all(child)]);
    return found.map((card) => ({
      title: text(all(card).find((node) => String(node.className) === 'appr-title')),
      // The actions the card offers, by their labels (as AskForAccess.flows finds the button it clicks).
      buttons: all(card).map(text).filter((label) => label === 'Grant access' || label === 'Continue'),
    }));
  }

  const READABLE = ' — can be read now; writing to it needs Read + Write';
  const NEEDS_WRITE = ' — has Read; saving needs Read + Write access';

  it('field T2: the named folder\'s item says it can be read, with no notice; a refused save there shows one notice that Dev has Read access and saving needs Read + Write, never that it could not reach it; the item then asks for Read + Write; a second refused save shows no second notice', async () => {
    const h = await chatHost({ parentReadScope: true });
    await h.ask('dev', `Write the bilingual summary into the folder ${h.sibling}`);
    await vi.waitFor(() => expect(h.cli.turns).toHaveLength(1));
    const [named] = accessItems(h.chat);
    expect(named.title.endsWith(READABLE), named.title).toBe(true);
    expect(named.buttons).toContain('Grant access');
    expect(h.warnings).toEqual([]);
    const label = named.title.slice(0, -READABLE.length);

    const target = path.join(h.sibling, 'summary.docx');
    const refused = await h.cli.bridgeTool('doc-1', 'write_document', docx(target));
    expect(refused).not.toContain('Document written');
    expect(existsSync(target)).toBe(false);
    expect(h.warnings).toEqual([`${label} — Dev has Read access; saving there needs Read + Write. Full path: ${h.sibling}`]);
    expect(h.warnings.join('\n')).not.toContain('could not reach it');
    const items = accessItems(h.chat);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe(`${label}${NEEDS_WRITE}`);
    expect(items[0].buttons).toContain('Grant access');

    // The same save refused again: the Read + Write notice is not shown again.
    expect(await h.cli.bridgeTool('doc-2', 'write_document', docx(target))).not.toContain('Document written');
    expect(existsSync(target)).toBe(false);
    expect(h.warnings.filter((warning) => warning.includes('has Read access; saving there needs Read + Write'))).toHaveLength(1);
    await h.cli.finish('I could not save it there.');
  });

  it('control: a folder outside every folder the agent can read still says it could not reach it, after the named notice', async () => {
    const h = await chatHost();
    await h.ask('dev', `Write the bilingual summary into the folder ${h.outside}`);
    await vi.waitFor(() => expect(h.cli.turns).toHaveLength(1));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('your request names it, outside this workspace, and Dev cannot reach it yet.');
    const target = path.join(h.outside, 'summary.docx');
    expect(await h.cli.bridgeTool('doc-1', 'write_document', docx(target))).not.toContain('Document written');
    expect(existsSync(target)).toBe(false);
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[1]).toContain(`Dev could not reach it with the file tools. Current work continues without it. Full path: ${h.outside}`);
    expect(h.warnings.join('\n')).not.toContain('has Read access');
    await h.cli.finish('I could not save it there.');
  });
});
