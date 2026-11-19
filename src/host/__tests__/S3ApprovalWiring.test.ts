import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDecisionBroker, settleOnAbort, type ApprovalEvent, type ApprovalRequest } from '../../views/approvals';
import { RunLedger } from '../../observability/RunLedger';
import { FileWritePolicy, type OverwriteDecisionRequest } from '../../backend/fileWritePolicy';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { NoopFileCoordinator } from '../../backend/FileCoordinator';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { createUnifiedDiff } from '../../backend/diff';
import { SecurityControlLocationAdapter } from '../../security/SecurityControlLocations';
import type { SecurityControlArtifactLocation } from '../../security/SecurityControlArtifacts';
import { redactSecretText } from '../../security/diagnosticRedaction';
import { modelFacingToolOutput } from '../../backend/toolSummary';

// This file parses and compiles the host functions out of extension.ts and runs real files and processes. On a CI
// runner its baseline did not finish green within the warm mutation worker's 5 s budget.
vi.setConfig({ testTimeout: 30_000 });

// Execute the actual host functions through the real broker/store. Importing extension.ts itself needs VS Code.
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['requestCommandApproval', 'requestOutwardActionApproval', 'requestSecurityControlApproval', 'requestWriteApproval',
  'nativeExactEffectApprovalChoice', 'securityControlApprovalPreview', 'redactApprovalPreview', 'writeDiffPreview',
  'timedApproval', 'abortableBrokeredApproval', 'openBrokeredApproval', 'localApproverIdentity',
  'recordBrokeredApproval', 'recordApprovalMetric', 'approvalMetricDecision',
  'createSecurityControlLocationAdapter', 'publishRuntimeControlFiles', 'makeFileWritePolicy', 'cliHostFileTools'];
const actual = ts.transpileModule(names.map(name => {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing actual ${name}`);
  return node.getText(source);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function actualInitializer(name: string): string {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found?.initializer) throw new Error(`Missing actual ${name} initializer`);
  return ts.transpileModule(`const value = (${found.initializer.getText(source)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const actualAgentWrites = actualInitializer('fileWrites');
const actualCliExecute = actualInitializer('cliMayExecute');

interface ApprovalContext {
  shell: { grammar: string; label: string }; cwd: string; dangerous?: boolean; signal?: AbortSignal;
  outward?: { kind: string; destination: string; content: string }[];
  outwardUnknownReason?: string;
}
interface Handlers {
  requestCommandApproval(command: string, agent: string, context: ApprovalContext, origin: { agentId: string }): Promise<{ allow: boolean; note?: string; withdrawn?: boolean }>;
  requestSecurityControlApproval(request: OverwriteDecisionRequest, agent: string, origin: { agentId: string }): Promise<'once' | 'deny' | { action: 'deny'; userNote: string }>;
  requestWriteApproval(request: OverwriteDecisionRequest, agent: string, origin: { agentId: string }): Promise<'once' | 'always' | 'deny' | { action: 'deny'; userNote: string }>;
  securityControlApprovalPreview(request: Partial<OverwriteDecisionRequest>): string;
  redactApprovalPreview(value: string): string;
  createSecurityControlLocationAdapter(context: unknown): SecurityControlLocationAdapter;
  publishRuntimeControlFiles(agent: string, launch: string, locations: readonly SecurityControlArtifactLocation[]): void;
  makeFileWritePolicy(): FileWritePolicy;
  cliHostFileTools(options: unknown): WorkspaceTools;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const folders: string[] = [];
const brokers: ApprovalDecisionBroker[] = [];
afterEach(async () => {
  brokers.splice(0).forEach(broker => broker.disposeAll());
  vi.useRealTimers();
  await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })));
});
async function folder() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-s3-host-')));
  folders.push(root); return root;
}
function fixture() {
  const broker = new ApprovalDecisionBroker(); brokers.push(broker);
  const events: ApprovalEvent[] = []; broker.subscribe({ onEvent: event => events.push(event) });
  const ledger = new RunLedger();
  // Several independent rows make attribution through the real correlation lookup observable.
  for (const id of ['other-a', 'subject', 'other-b']) ledger.recordDelegationDispatched({ coordinatorId: 'pm',
    handle: id, requestedAgent: 'dev', agentId: `dev-${id}`, instruction: 'Public fixture' });
  const opened = deferred<ApprovalRequest>();
  const values = new Map<string, unknown>();
  const host = {
    approvalBroker: broker, settleOnAbort, runLedger: ledger, HUMAN_APPROVAL_WINDOW_MS: 15 * 60 * 1000,
    sessionManager: {
      timeApproval: async (_id: string, open: () => Promise<unknown>) => ({ startedAtMs: Date.now(), outcome: await open() }),
      recordApprovalOutcome: vi.fn(), currentTurnCorrelationId: () => 'subject', requestRunning: () => true,
      noteFileEffect: vi.fn(), isCurrentBackendLaunch: vi.fn(() => true),
    },
    chatViewProvider: { canPromptApproval: () => true,
      openApproval: (request: Omit<ApprovalRequest, 'id'>, timeoutMs: number) => {
        const pending = broker.open(request, { timeoutMs }); opened.resolve(broker.list()[0]); return pending;
      } },
    vscode: { env: { machineId: 'fixture', remoteName: undefined as string | undefined }, ExtensionKind: { UI: 1, Workspace: 2 },
      workspace: { isTrusted: true, textDocuments: [], notebookDocuments: [] },
      window: { showWarningMessage: vi.fn(async () => 'Deny') } },
    SecurityControlLocationAdapter, FileWritePolicy, WorkspaceTools, NoopFileCoordinator, CommandPolicy,
    createUnifiedDiff, redactSecretText, parseJsonc, firstWorkspaceRoot: () => 'fixture-workspace',
    securityControlLocations: undefined as SecurityControlLocationAdapter | undefined,
    runtimeSecurityControlLocations: new Map<string, readonly SecurityControlArtifactLocation[]>(),
    customGatewayRegistryPath: '', OWN_FILE_EFFECTS_KEY: 'fixture-effects', writeApprovedAll: false,
    rootWorkspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } },
    gitPathStatus: async () => ({ kind: 'outside-git' }), preChangeCheckpoints: undefined,
    recordCheckpoint: undefined, taskInputResolver: undefined, configuredSetting: () => 'none',
    sessionApprovedCommands: { has: vi.fn(() => true), add: vi.fn() },
    isPersistedCommandShellGrammar: () => true, SAFE_COMMAND_TEMPLATES: [], autoAllowSegments: (command: string) => [command],
    confirmDangerousCommand: vi.fn(async () => true), attentionAppearance: vi.fn(), pausingTurnClock: vi.fn(),
  };
  const handlers = new Function('host', `with (host) { ${actual}; return { ${names.join(',')} }; }`)(host) as Handlers;
  return { ...handlers, host, broker, ledger, events, opened };
}
const origin = { agentId: 'dev-subject' };
const context = (signal?: AbortSignal): ApprovalContext => ({ shell: { grammar: 'bash', label: 'Bash' }, cwd: '/fixture', signal,
  outward: [{ kind: 'push', destination: 'https://git.example/public-repo', content: 'main -> refs/heads/release' }] });
const securityRequest = (signal?: AbortSignal): OverwriteDecisionRequest => ({ purpose: 'security-control',
  path: '/private/settings.json', reason: 'security-setting change', operation: 'write',
  before: '{"unode.commandApproval":"ask","password":"PRIVATE-BEFORE"}',
  after: '{"unode.commandApproval":"all","password":"PRIVATE-AFTER"}', signal,
  securityChanges: [{ path: '/private/settings.json', kind: 'user-settings', operation: 'write',
    before: '{"unode.commandApproval":"ask","password":"PRIVATE-BEFORE"}',
    after: '{"unode.commandApproval":"all","password":"PRIVATE-AFTER"}' }] });

describe('actual S3 host approvals through the real broker', () => {
  it('uses one outward card for an unresolved effect, including the command, shell and actual folder', async () => {
    const h = fixture(); const ctx = { ...context(), outward: [], outwardUnknownReason: 'The publication build scripts determine the artifact at run time.' };
    const pending = h.requestCommandApproval('npm publish', 'Writer', ctx, origin);
    expect(await Promise.race([h.opened.promise.then(() => 'approval'), pending.then(() => 'effect')])).toBe('approval');
    const card = await h.opened.promise;
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Outward action', singleUseOnly: true });
    expect(card.toolDetail).toContain('Destination and content could not be determined before running:');
    expect(card.toolDetail).toContain(ctx.outwardUnknownReason); expect(card.toolDetail).toContain('Command: npm publish');
    expect(card.toolDetail).toContain('Shell: Bash'); expect(card.toolDetail).toContain('Folder: /fixture');
    h.broker.settle(card.id, { action: 'once' }, 'human'); expect(await pending).toEqual({ allow: true });
    expect(h.events.filter(event => event.type === 'pending')).toHaveLength(1); expect(h.host.sessionApprovedCommands.add).not.toHaveBeenCalled();
  });

  it('only a human decline carries a note; deadline and host disposal do not become the user\'s words', async () => {
    for (const by of ['expired', 'host-disposed'] as const) for (const kind of ['outward', 'security']) {
      const h = fixture();
      const pending = kind === 'outward' ? h.requestCommandApproval('git push', 'Writer', context(), origin)
        : h.requestSecurityControlApproval(securityRequest(), 'Writer', origin);
      const card = await h.opened.promise; h.broker.settle(card.id, { action: 'deny', note: 'HOST-GENERATED-NOT-A-USER-NOTE' }, by);
      expect(await pending).toEqual(kind === 'outward' ? { allow: false } : 'deny');
      expect(JSON.stringify(h.ledger.snapshot())).not.toContain('HOST-GENERATED-NOT-A-USER-NOTE');
    }
  });

  it('the existing Write Ask preserves a human decline note without treating host expiry as human text', async () => {
    for (const by of ['human', 'expired', 'host-disposed'] as const) {
      const h = fixture(); const pending = h.requestWriteApproval(securityRequest(), 'Writer', origin); const card = await h.opened.promise;
      h.broker.settle(card.id, { action: 'deny', note: 'WRITE-ASK-INSTRUCTION' }, by);
      expect(await pending).toEqual(by === 'human' ? { action: 'deny', userNote: 'WRITE-ASK-INSTRUCTION' } : 'deny');
      expect(JSON.stringify(h.ledger.snapshot())).not.toContain('WRITE-ASK-INSTRUCTION');
    }
  });
  it('outward consent precedes dangerous and remembered command grants, once for the exact proposal', async () => {
    const h = fixture(); const ctx = { ...context(), dangerous: true };
    const result = h.requestCommandApproval('git push --token PRIVATE-CLI', 'Writer', ctx, origin);
    expect(await Promise.race([h.opened.promise.then(() => 'approval'), result.then(() => 'effect')])).toBe('approval');
    const card = await h.opened.promise;
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Outward action', singleUseOnly: true });
    expect(card.toolDetail).toContain('main -> refs/heads/release');
    expect(card.toolDetail).toContain('https://git.example/public-repo');
    expect(card.toolDetail).toContain('potentially destructive');
    expect(card.toolDetail).toContain('git push'); expect(card.toolDetail).not.toContain('PRIVATE-CLI');
    expect(h.host.confirmDangerousCommand).not.toHaveBeenCalled();
    expect(h.host.sessionApprovedCommands.has).not.toHaveBeenCalled();
    h.broker.settle(card.id, { action: 'once' }, 'human', 'fixture-human');
    expect(await result).toEqual({ allow: true });
    expect(h.host.sessionApprovedCommands.add).not.toHaveBeenCalled();
    const allPermissions = h.ledger.snapshot().flatMap(run => run.permissions);
    expect(allPermissions).toHaveLength(1);
    expect(allPermissions[0]).toMatchObject({ kind: 'outward-action', decision: 'allowed', approverId: 'fixture-human' });
    expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE-CLI|git\.example|main ->|git push/);
    expect(JSON.stringify(h.ledger.snapshot())).not.toContain('PRIVATE-CLI');
  });

  it.each(['session', 'project', 'always', 'safe', 'deny'])('does not accept %s as an exact outward or security grant', async action => {
    for (const kind of ['outward', 'security']) {
      const h = fixture();
      const result = kind === 'outward' ? h.requestCommandApproval('git push', 'Writer', context(), origin)
        : h.requestSecurityControlApproval(securityRequest(), 'Writer', origin);
      const card = await h.opened.promise;
      h.broker.settle(card.id, { action, note: 'PRIVATE-TYPED-REASON' }, 'human');
      expect(await result).toEqual(action === 'deny'
        ? kind === 'outward' ? { allow: false, note: 'PRIVATE-TYPED-REASON', noteOrigin: 'human' }
          : { action: 'deny', userNote: 'PRIVATE-TYPED-REASON' }
        : kind === 'outward' ? { allow: false } : 'deny');
      // The broker's local human event retains the reason; the caller and stored run receive none.
      expect(JSON.stringify(h.ledger.snapshot())).not.toContain('PRIVATE-TYPED-REASON');
    }
  });

  it('security card shows redacted proposed keys and preserves the one combined irreversible folder decision', async () => {
    const h = fixture(); const req = securityRequest();
    req.preview = 'This deletion has no restore point. Approving it also removes the listed security controls.';
    req.foreignFiles = ['/private/report.txt'];
    const result = h.requestSecurityControlApproval(req, 'Writer', origin); const card = await h.opened.promise;
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Security-setting change', singleUseOnly: true });
    expect(card.toolDetail).toContain('unode.commandApproval');
    expect(card.toolDetail).toContain('"ask"'); expect(card.toolDetail).toContain('"all"');
    expect(card.toolDetail).toContain('no restore point'); expect(card.toolDetail).toContain('/private/report.txt');
    expect(card.toolDetail).not.toMatch(/PRIVATE-(BEFORE|AFTER)/);
    h.broker.settle(card.id, { action: 'once' }, 'human'); expect(await result).toBe('once');
    expect(h.ledger.snapshot().flatMap(run => run.permissions)).toEqual([expect.objectContaining({ kind: 'security-setting', decision: 'allowed' })]);
    expect(JSON.stringify(h.events)).not.toMatch(/\/private|commandApproval|PRIVATE-/);
  });

  it('keeps ordinary remembered commands silent while an unrelated exact approval waits', async () => {
    const h = fixture(); const pending = h.requestSecurityControlApproval(securityRequest(), 'Writer', origin);
    const card = await h.opened.promise;
    expect(await h.requestCommandApproval('git status', 'Writer', { ...context(), outward: undefined }, origin)).toEqual({ allow: true });
    expect(h.broker.list()).toHaveLength(1);
    h.broker.settle(card.id, { action: 'deny' }, 'human'); expect(await pending).toBe('deny');
  });

  it('expires exact decisions at the existing deadline and rejects a late allow', async () => {
    vi.useFakeTimers();
    for (let iteration = 0; iteration < 25; iteration++) for (const kind of ['outward', 'security']) {
      const h = fixture(); const pending = kind === 'outward' ? h.requestCommandApproval('git push', 'Writer', context(), origin)
        : h.requestSecurityControlApproval(securityRequest(), 'Writer', origin);
      const card = await h.opened.promise; await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(await pending).toEqual(kind === 'outward' ? { allow: false } : 'deny');
      expect(h.broker.settle(card.id, { action: 'once' }, 'human')).toBe(false);
      expect(h.ledger.snapshot().flatMap(run => run.permissions)).toEqual([expect.objectContaining({ decision: 'expired' })]);
    }
  });

  it('withdraws stopped exact actions and never counts Stop or its late click as a human denial', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const kind of ['outward', 'security']) {
      const h = fixture(); const abort = new AbortController();
      const pending = kind === 'outward' ? h.requestCommandApproval('git push', 'Writer', context(abort.signal), origin)
        : h.requestSecurityControlApproval(securityRequest(abort.signal), 'Writer', origin);
      const card = await h.opened.promise; abort.abort();
      expect(h.broker.isOpen(card.id)).toBe(false);
      expect(await pending).toEqual(kind === 'outward' ? { allow: false, withdrawn: true } : 'deny');
      expect(h.broker.settle(card.id, { action: 'once' }, 'human')).toBe(false);
      expect(h.ledger.snapshot().flatMap(run => run.permissions)).toEqual([]);
      expect(h.host.sessionManager.recordApprovalOutcome).toHaveBeenCalledTimes(1);
    }
  });

  it('a modal uses the same once-only broker and drops a post-expiry answer', async () => {
    vi.useFakeTimers();
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = fixture(); const answer = deferred<string>();
      h.host.chatViewProvider.canPromptApproval = () => false;
      h.host.vscode.window.showWarningMessage.mockImplementation(() => answer.promise);
      const pending = h.requestSecurityControlApproval(securityRequest(), 'Writer', origin);
      await Promise.resolve(); await Promise.resolve();
      expect(h.host.vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.any(String), { modal: true }, 'Deny', 'Allow once');
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000); expect(await pending).toBe('deny');
      answer.resolve('Allow once'); await Promise.resolve(); await Promise.resolve();
      expect(h.ledger.snapshot().flatMap(run => run.permissions)).toEqual([expect.objectContaining({ decision: 'expired' })]);
    }
  });

  it('native fallback accepts only its exact affirmative label', async () => {
    for (const answer of [undefined, 'Deny', 'Allow', 'Allow once']) {
      const h = fixture(); h.host.chatViewProvider.canPromptApproval = () => false;
      h.host.vscode.window.showWarningMessage.mockResolvedValue(answer as string);
      expect(await h.requestSecurityControlApproval(securityRequest(), 'Writer', origin)).toBe(answer === 'Allow once' ? 'once' : 'deny');
    }
  });

  it('requires an active proposal even if a human once answer settles immediately before Stop', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const kind of ['outward', 'security']) {
      const h = fixture(); const abort = new AbortController();
      const pending = kind === 'outward' ? h.requestCommandApproval('git push', 'Writer', context(abort.signal), origin)
        : h.requestSecurityControlApproval(securityRequest(abort.signal), 'Writer', origin);
      const card = await h.opened.promise; h.broker.settle(card.id, { action: 'once' }, 'human'); abort.abort();
      expect(await pending).toEqual(kind === 'outward' ? { allow: false, withdrawn: true } : 'deny');
    }
    const h = fixture(); const abort = new AbortController(); abort.abort();
    expect(await h.requestCommandApproval('git push', 'Writer', context(abort.signal), origin)).toEqual({ allow: false, withdrawn: true });
    expect(await h.requestSecurityControlApproval(securityRequest(abort.signal), 'Writer', origin)).toBe('deny');
    expect(h.broker.list()).toEqual([]); expect(h.events).toEqual([]);
  });

  it('masks credential fields/flags/envs while showing actual security and token-limit values', () => {
    const h = fixture();
    const preview = h.redactApprovalPreview(JSON.stringify({ 'unode.commandApproval': 'all', 'unode.requestLimits.tokens': 4000,
      token: 'PRIVATE-TOKEN', password: 'PRIVATE-PASSWORD', apiKey: 'PRIVATE-KEY', env: { CUSTOM: 'PRIVATE-ENV' } }));
    expect(preview).not.toMatch(/PRIVATE-/); expect(preview).toContain('4000'); expect(preview).toContain('"all"');
    for (const input of ['run --token "PRIVATE-FLAG VALUE"', 'https://host/a?token=PRIVATE-URL', 'CUSTOM_SECRET=PRIVATE-ASSIGN'])
      expect(h.redactApprovalPreview(input)).not.toContain('PRIVATE-');
    const binary = h.securityControlApprovalPreview({ path: '/private/state.vscdb', operation: 'write', before: 'PRIVATE-BINARY', after: 'other',
      securityChanges: [{ path: '/private/state.vscdb', kind: 'global-state', operation: 'write', before: 'PRIVATE-BINARY', after: 'other' }] });
    expect(binary).toContain('whole mixed control artifact'); expect(binary).not.toContain('PRIVATE-BINARY');
    const long = h.securityControlApprovalPreview({ ...securityRequest(), securityChanges: [{ path: '/private/settings.json', kind: 'user-settings', operation: 'write',
      before: JSON.stringify({ ordinary: 'x'.repeat(5000), 'unode.commandApproval': 'ask' }),
      after: JSON.stringify({ ordinary: 'y'.repeat(5000), 'unode.commandApproval': 'all' }) }] });
    expect(long).toContain('"unode.commandApproval": "all"'); expect(long).not.toContain('diff truncated');
  });
});

describe('actual host-derived locations and live CLI bridge wiring', () => {
  it('concurrent protected declines keep each human note on its own model response and out of clean outputs and ledger', async () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const root = await folder(); const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
      const storage = path.join(root, 'User', 'globalStorage', 'unode.unodeai'); await fs.mkdir(storage, { recursive: true });
      const settings = path.join(root, 'User', 'settings.json'); const config = path.join(root, 'config.toml');
      await fs.writeFile(settings, '{"unode.commandApproval":"ask"}'); await fs.writeFile(config, 'a=1'); const h = fixture();
      h.host.securityControlLocations = h.createSecurityControlLocationAdapter({ globalStorageUri: { scheme: 'file', fsPath: storage }, extension: { extensionKind: 1 } });
      h.publishRuntimeControlFiles('fixture', 'launch', [{ kind: 'codex-config', path: config }]);
      const policy = h.makeFileWritePolicy();
      const writes = new Function('host', `with(host) { ${actualAgentWrites}; return value; }`)({ ...h.host, ...h,
        fileWritePolicy: policy, agentCwd: workspace, scopedConfig: { id: origin.agentId, name: 'Writer' }, approvalOrigin: origin,
        sessionManager: { ...h.host.sessionManager, currentRequestId: () => 'fixture-request', currentTurnId: () => 'fixture-turn' },
        confirmFolderDelete: vi.fn(async () => false),
      }) as ReturnType<FileWritePolicy['forAgent']>;
      const tools = h.cliHostFileTools({ root: workspace, agentId: origin.agentId, fileWrites: writes, writeRoots: [workspace],
        fullFileAccess: () => true, fullFileAccessRevision: () => 1, approveWrite: async () => true });
      const both = deferred<void>(); h.broker.subscribe({ onChange: () => { if (h.broker.list().length === 2) both.resolve(); } });
      const a = tools.run('write_file', { path: settings, content: '{"unode.commandApproval":"all"}' });
      const b = tools.run('write_file', { path: config, content: 'a=2' }); await both.promise;
      const cards = h.broker.list(); const aCard = cards.find(card => card.toolDetail?.includes('settings.json'))!;
      const bCard = cards.find(card => card.toolDetail?.includes('config.toml'))!;
      const aNote = 'Keep A: "review first"'; const bNote = 'Keep B: different instruction';
      h.broker.settle(bCard.id, { action: 'deny', note: bNote }, 'human');
      h.broker.settle(aCard.id, { action: 'deny', note: aNote }, 'human');
      const [aResult, bResult] = await Promise.all([a, b]);
      expect(aResult).toMatchObject({ status: 'refused', userNote: aNote }); expect(bResult).toMatchObject({ status: 'refused', userNote: bNote });
      expect(modelFacingToolOutput(aResult)).toContain(`The user said: ${JSON.stringify(aNote)}`);
      expect(modelFacingToolOutput(aResult)).not.toContain(bNote); expect(modelFacingToolOutput(bResult)).toContain(bNote);
      expect(aResult.output).not.toContain(aNote); expect(bResult.output).not.toContain(bNote);
      expect(JSON.stringify(h.ledger.snapshot())).not.toMatch(/Keep A|Keep B/);
      expect(await fs.readFile(settings, 'utf8')).toBe('{"unode.commandApproval":"ask"}'); expect(await fs.readFile(config, 'utf8')).toBe('a=1');
    }
  });
  it('preserves Claude execute-Off, write-Off and Folder Access restrictions in the actual live factory choice', () => {
    const evaluate = (kind: string, cliMayWrite: boolean, allowedTools: string[] | undefined, executePreference?: string, restricted = false): boolean =>
      new Function('host', `with(host) { ${actualCliExecute}; return value; }`)({ kind, cliMayWrite, scopedConfig: { allowedTools, executePreference }, effectiveRoots: { restricted } }) as boolean;
    expect(evaluate('claude', true, ['write', 'execute'])).toBe(true);
    expect(evaluate('claude', true, undefined)).toBe(true);
    expect(evaluate('claude', false, ['execute'])).toBe(false);
    expect(evaluate('claude', true, ['write'])).toBe(false);
    expect(evaluate('claude', true, ['write', 'execute'], 'deny')).toBe(false);
    expect(evaluate('claude', true, ['write', 'execute'], undefined, true)).toBe(false);
    expect(evaluate('codex', true, ['write', 'execute'])).toBe(false);
    expect(evaluate('openai-compat', true, ['write', 'execute'])).toBe(false);
  });
  it('qualifies a local UI extension in a remote window without inventing remote-client settings', async () => {
    const root = await folder(); const h = fixture();
    const storage = path.join(root, 'User', 'globalStorage', 'unode.unodeai'); await fs.mkdir(storage, { recursive: true });
    const uri = { scheme: 'file', fsPath: storage }; h.host.vscode.env.remoteName = 'ssh-remote';
    const local = h.createSecurityControlLocationAdapter({ globalStorageUri: uri, extension: { extensionKind: 1 } });
    expect(await local.getLocations()).toEqual(expect.arrayContaining([{ kind: 'user-settings', path: path.join(root, 'User', 'settings.json') }]));
    const remote = h.createSecurityControlLocationAdapter({ globalStorageUri: uri, extension: { extensionKind: 2 } });
    expect((await remote.getLocations()).filter(value => value.kind === 'user-settings')).toEqual([]);
  });

  it('retains verified runtime paths across Stop, rejects stale publication, and limits cleanup to its launch', () => {
    const h = fixture(); const old = [{ kind: 'codex-config' as const, path: '/private/old/config.toml' }];
    h.publishRuntimeControlFiles('a', 'old', old); old[0].path = '/mutated';
    h.publishRuntimeControlFiles('a', 'new', [{ kind: 'codex-auth', path: '/private/new/auth.json' }]);
    expect(h.host.runtimeSecurityControlLocations.size).toBe(2);
    expect([...h.host.runtimeSecurityControlLocations.values()].flat()).toContainEqual({ kind: 'codex-config', path: '/private/old/config.toml' });
    h.publishRuntimeControlFiles('a', 'old', []);
    expect([...h.host.runtimeSecurityControlLocations.values()].flat()).toEqual([{ kind: 'codex-auth', path: '/private/new/auth.json' }]);
    h.host.sessionManager.isCurrentBackendLaunch.mockReturnValue(false);
    h.publishRuntimeControlFiles('a', 'stale', [{ kind: 'codex-auth', path: '/stale' }]);
    expect(h.host.runtimeSecurityControlLocations.size).toBe(1);
  });

  it('the real host policy and tool preserve User settings until the exact broker decision; ordinary font/no-op edits stay silent', async () => {
    const root = await folder(); const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
    const storage = path.join(root, 'User', 'globalStorage', 'unode.unodeai'); await fs.mkdir(storage, { recursive: true });
    const file = path.join(root, 'User', 'settings.json'); const before = '{"unode.commandApproval":"ask","editor.fontSize":14}';
    await fs.writeFile(file, before); const h = fixture();
    h.host.securityControlLocations = h.createSecurityControlLocationAdapter({ globalStorageUri: { scheme: 'file', fsPath: storage }, extension: { extensionKind: 1 } });
    const policy = h.makeFileWritePolicy();
    const writes = new Function('host', `with(host) { ${actualAgentWrites}; return value; }`)({ ...h.host, ...h,
      fileWritePolicy: policy, agentCwd: workspace, scopedConfig: { id: origin.agentId, name: 'Writer' }, approvalOrigin: origin,
      sessionManager: { ...h.host.sessionManager, currentRequestId: () => 'fixture-request', currentTurnId: () => 'fixture-turn' },
      confirmFolderDelete: vi.fn(async () => false),
    }) as ReturnType<FileWritePolicy['forAgent']>;
    const tools = h.cliHostFileTools({ root: workspace, agentId: origin.agentId, fileWrites: writes, writeRoots: [workspace],
      fullFileAccess: () => true, fullFileAccessRevision: () => 1, approveWrite: async () => true });
    writes.noteRead(file, (await writes.observe(file)).state);
    const after = '{"unode.commandApproval":"all","editor.fontSize":14}';
    const pending = tools.run('write_file', { path: file, content: after });
    expect(await Promise.race([h.opened.promise.then(() => 'approval'), pending.then(() => 'effect')])).toBe('approval');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const card = await h.opened.promise; h.broker.settle(card.id, { action: 'once' }, 'human');
    expect(await pending).toMatchObject({ status: 'success' }); expect(await fs.readFile(file, 'utf8')).toBe(after);
    for (const content of [after, '{"unode.commandApproval":"all","editor.fontSize":18}']) {
      expect(await tools.run('write_file', { path: file, content })).toMatchObject({ status: 'success' });
      expect(h.broker.list()).toHaveLength(0);
    }
    expect(h.events.filter(event => event.type === 'pending')).toHaveLength(1);
  });
});
