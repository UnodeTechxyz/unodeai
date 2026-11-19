/*
 * v0.9.102 R4a (the Owner's plan A, 2026-11-09; design §3.4, §10 T102-11a/b/c and T102-12a/b/c; R0 gaps G4-G7).
 *
 * A Codex agent's live folder Read + Write grant reaches its native sandbox at the next turn, through the extension's
 * own `access` wiring and the backend's existing restart and resume; an exact-file grant never becomes a sandbox root and
 * is written by the host `write_file`. Real CodexBackend, real grant store and real host file tools; App Server is a fake
 * that behaves as measured: a process keeps the sandbox its first thread request gave the thread, thread/start reports no
 * writable root beyond the working folder, and a resume in a new process reports the roots it was given (0.155.1, 0.163.0).
 * No real App Server runs: an actual native edit is not exercised here.
 */
import { EventEmitter } from 'events';
import { existsSync, readFileSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CODEX_WRITE_FILE_ROUTE, CodexBackend, type CodexBackendDeps } from '../../backend/CodexBackend';
import { SessionLocalReadScopeConsent, type PathGrantRows, type SessionPathAccessGrant } from '../../backend/localReadScope';
import { writeRootsForTrust } from '../../backend/folderAccess';
import type { WorkspaceTools } from '../../backend/WorkspaceTools';
import type { AgentConfig, ConversationSnapshot } from '../../types';
import { saveHost } from '../../backend/__tests__/attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from '../../backend/__tests__/pathSafetyFixtures';
import { fixedCodexProgram } from '../../backend/__tests__/codexProgramFixture';
import { evaluateWiring, extensionWiring } from '../../views/__tests__/support/extensionWiring';
import { codexAccessWithGrants, codexExactFileWrites, codexGrantBoundaryNotice, revokedDuringTurn } from '../codexLiveGrants';

// These flow tests run real persistence, sessions, backends and commands, taking about 0.5-3 s each here and
// several times that on CI. The warm mutation worker keeps Vitest's 5 s default, so the suite's own 30 s budget
// (vitest.config.ts) is set here; CI 42814839194 judged two proofs invalid when a rerun ran past 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterEach(removeTemporaryFolders);

const THREAD = 'thread-1';
const SETTLED = { timeout: 10_000, interval: 5 };

function config(dir: string, patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Dev', role: 'developer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'codex', workingDirectory: dir,
    ...patch,
  };
}

/**
 * App Server as measured: each process keeps, for the thread, the sandbox of the first thread request it served. A
 * thread/start reports no writable root beyond `cwd`; a resume in a new process reports the runtime roots it was given,
 * unless `resumeApplies` is false. Turns are numbered per turn/start.
 */
function measuredAppServer(options: {
  resumeApplies?: boolean;
  /** Runs while a thread request is answered; what it sends arrives after the answer. */
  afterThread?: (method: string, process: number) => void;
  /** Runs before turn/start is answered; what it sends arrives before the answer. */
  beforeTurnReply?: (turnId: string) => void;
} = {}) {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const clientMessages: Array<{ process: number; message: any }> = [];
  const responses: any[] = [];
  const procs: any[] = [];
  let turns = 0;
  let proc: any;
  const emit = (message: unknown) => { const target = proc; queueMicrotask(() => target.stdout.emit('data', `${JSON.stringify(message)}\n`)); };
  const spawn = (_command: string, args: string[]) => {
    proc = new EventEmitter();
    const index = procs.push(proc);
    let held: { readOnly: boolean; writableRoots: string[] } | undefined;
    proc.pid = 4321 + index;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          if (!line) continue;
          const message = JSON.parse(line);
          clientMessages.push({ process: index, message });
          const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
          if (message.method === 'initialize') reply({ userAgent: 'fake' });
          else if (message.method === 'config/read') reply({
            config: {
              model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
              approval_policy: setting(args, 'approval_policy'), approvals_reviewer: setting(args, 'approvals_reviewer'),
              sandbox_mode: setting(args, 'sandbox_mode'),
              sandbox_workspace_write: { network_access: setting(args, 'sandbox_workspace_write.network_access') === true },
              apps: { _default: {
                default_tools_approval_mode: setting(args, 'apps._default.default_tools_approval_mode'),
                approvals_reviewer: setting(args, 'apps._default.approvals_reviewer'),
              } },
            },
            origins: {}, layers: [],
          });
          else if (message.method === 'model/list') reply({ data: [] });
          else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
          else if (message.method === 'skills/list') reply({ data: [] });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') {
            const params = message.params;
            if (!held) {
              held = {
                readOnly: params.sandbox === 'read-only',
                writableRoots: message.method === 'thread/resume' && options.resumeApplies !== false ? [...params.runtimeWorkspaceRoots] : [],
              };
            }
            options.afterThread?.(message.method, index);
            reply({
              thread: { id: THREAD }, cwd: params.cwd, approvalPolicy: params.approvalPolicy,
              approvalsReviewer: params.approvalsReviewer, modelProvider: params.modelProvider,
              runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
              sandbox: held.readOnly ? { type: 'readOnly', networkAccess: false }
                : { type: 'workspaceWrite', writableRoots: held.writableRoots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
            });
          } else if (message.method === 'turn/start') {
            const id = `turn-${++turns}`;
            options.beforeTurnReply?.(id);
            reply({ turn: { id, status: 'inProgress' } });
          } else if (message.id !== undefined && !message.method) responses.push(message);
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  const sent = (method: string) => clientMessages.filter((entry) => entry.message.method === method);
  return {
    spawn: spawn as any, procs, clientMessages, responses, sent,
    notify(method: string, params: unknown) { emit({ jsonrpc: '2.0', method, params }); },
    request(method: string, params: unknown, id: string) { emit({ jsonrpc: '2.0', id, method, params }); },
    toolCall(tool: string, args: Record<string, unknown>, id: string, turnId: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: THREAD, turnId, callId: id, namespace: null, tool, arguments: args } });
    },
  };
}

type Fake = ReturnType<typeof measuredAppServer>;

/** The extension's actual `access` and `exactFileWrites` wiring of its one CodexBackend, over a live grant source. */
function extensionAccessWiring(scope: { workspace: string; grants: () => readonly SessionPathAccessGrant[]; mayWrite?: boolean; trusted?: () => boolean }) {
  const names = {
    codexAccessWithGrants, codexExactFileWrites, writeRootsForTrust,
    vscode: { workspace: { get isTrusted() { return scope.trusted?.() ?? true; } } },
    effectiveRoots: { restricted: false, readRoots: [scope.workspace], writeRoots: [scope.workspace] },
    cliMayWrite: scope.mayWrite ?? true,
    livePathAccess: scope.grants,
  };
  return {
    access: evaluateWiring<NonNullable<CodexBackendDeps['access']>>(extensionWiring('CodexBackend', 2, 'access'), names),
    exactFileWrites: evaluateWiring<NonNullable<CodexBackendDeps['exactFileWrites']>>(extensionWiring('CodexBackend', 2, 'exactFileWrites'), names),
  };
}

async function realFolder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

/** A person's grant through the real grant store, as the Grant access picker makes it. */
async function grant(owner: SessionLocalReadScopeConsent, target: string, permission: 'read' | 'readwrite' = 'readwrite') {
  const made = await owner.requestPathAccess(target, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission, lifetime: 'session' }));
  if (!made) throw new Error(`no grant for ${target}`);
  return made;
}

async function codex(options: {
  workspace: string;
  fake: Fake;
  deps?: Partial<CodexBackendDeps>;
  agent?: Partial<AgentConfig>;
}) {
  const record = { starts: [] as string[], released: 0 };
  const backend = new CodexBackend(config(options.workspace, options.agent), undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe', record as any),
    spawn: options.fake.spawn,
    terminateProcessTree: async () => ({ status: 'confirmed-stopped' }),
    requestApproval: async () => ({ allow: true }),
    ...options.deps,
  });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  await backend.start({ PATH: 'safe' }, { pin: 'take' });
  return { backend, events, record };
}

/** Sends a turn and waits until App Server got its turn/start. */
async function sendTurn(backend: CodexBackend, fake: Fake, text: string, attachments?: any): Promise<any> {
  const before = fake.sent('turn/start').length;
  backend.sendUserTurn(text, attachments);
  await vi.waitFor(() => expect(fake.sent('turn/start').length).toBe(before + 1), SETTLED);
  return fake.sent('turn/start').at(-1)!.message;
}

/** Ends the running turn and waits for the backend's own end event. */
async function endTurn(backend: CodexBackend, fake: Fake, turnId: string): Promise<any> {
  const ended = new Promise<any>((resolve) => {
    const off = backend.onEvent((event) => { if (event.kind === 'turn_complete') { off?.(); resolve(event); } });
  });
  fake.notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: `${turnId}-msg`, delta: 'done' });
  fake.notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'completed', error: null } });
  return ended;
}

async function answer(fake: Fake, id: string): Promise<any> {
  return vi.waitFor(() => {
    const response = fake.responses.find((candidate) => candidate.id === id);
    expect(response).toBeDefined();
    return response;
  }, SETTLED);
}

const sandboxOf = (turn: any) => turn.params.sandboxPolicy;
const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

/** The extension's actual `noticeCodexGrantBoundaries`, over the names it reads. */
function boundaryNotices(names: Record<string, unknown>): () => void {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'noticeCodexGrantBoundaries');
  if (!declaration) throw new Error('Missing actual noticeCodexGrantBoundaries');
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(names), `${code}; return noticeCodexGrantBoundaries;`)(...Object.values(names));
}

describe('an open Security page follows a grant change (v0.9.102, the Owner, field 2026-11-12)', () => {
  it('the extension\'s grant-row change hook redraws an open Security page once per change', () => {
    let redraws = 0;
    const changed = evaluateWiring<() => void>(extensionWiring('SessionLocalReadScopeConsent', 3, 'changed'),
      { accessTable: { grantRows: { changed: () => undefined } }, noticeCodexGrantBoundaries: () => undefined,
        SecurityPanel: { refreshIfOpen: () => { redraws += 1; } } });
    changed();
    expect(redraws).toBe(1);
  });
});

/**
 * The extension's grant-change notice wiring over a real grant store: its `noticeCodexGrantBoundaries`, its grant-row
 * `changed` hook and its `onNativeWriteScope`, with one running request turn.
 */
function wiredBoundary() {
  const scopes = new Map();
  const posted: Array<{ agentId: string; text: string }> = [];
  const sessionManager = { currentTurnId: () => 'request-turn-1', get: () => ({ config: { name: 'Codex Dev' } }) };
  const notices = boundaryNotices({ codexTurnWriteScopes: scopes, sessionManager, revokedDuringTurn, codexGrantBoundaryNotice,
    chatViewProvider: { postRuntimeNotice: (agentId: string, text: string) => posted.push({ agentId, text }) } });
  const changed = evaluateWiring<() => void>(extensionWiring('SessionLocalReadScopeConsent', 3, 'changed'),
    { accessTable: { grantRows: { changed: () => undefined } }, noticeCodexGrantBoundaries: notices, SecurityPanel: { refreshIfOpen: () => undefined } });
  const owner = new SessionLocalReadScopeConsent(async () => false, undefined, undefined, { map: new Map(), changed, changedLater: () => undefined });
  const onNativeWriteScope = evaluateWiring<NonNullable<CodexBackendDeps['onNativeWriteScope']>>(
    extensionWiring('CodexBackend', 2, 'onNativeWriteScope'), { sessionManager, config: { id: 'codex-1' }, codexTurnWriteScopes: scopes });
  return { owner, posted, onNativeWriteScope };
}

describe('a Codex folder grant reaches the next native turn (v0.9.102 R4a)', () => {
  // T102-11a (executor policy), G5, G4: source (the person's grant) -> extension access wiring -> next turn's sandbox.
  it('adds a Read + Write folder grant at the next turn through a restart and resume, and takes it away the same way', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    const file = path.join(await realFolder('unode-r4a-file-'), 'notes.txt');
    await fs.writeFile(file, 'before');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const wiring = extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') });
    const fake = measuredAppServer();
    const { backend, events, record } = await codex({ workspace, fake, deps: wiring });
    try {
      expect(sandboxOf(await sendTurn(backend, fake, 'one')).writableRoots).toEqual([workspace]);
      await endTurn(backend, fake, 'turn-1');

      const folderGrant = await grant(owner, granted);
      const second = await sendTurn(backend, fake, 'two');
      expect(fake.procs).toHaveLength(2);
      expect(record.starts).toEqual(['take', 'reuse']);
      expect(sandboxOf(second).writableRoots.map(key).sort()).toEqual([workspace, granted].map(key).sort());
      // The one resume is in the new process, and it reported the granted folder back.
      expect(fake.sent('thread/resume').map((entry) => entry.process)).toEqual([2]);
      expect(fake.sent('thread/resume')[0].message.params.runtimeWorkspaceRoots.map(key).sort()).toEqual([workspace, granted].map(key).sort());
      expect(events.some((event) => event.kind === 'log' && /being restarted: this agent changed mode or folder access/.test(event.line))).toBe(true);
      await endTurn(backend, fake, 'turn-2');

      // Same grants: same sandbox, no restart. An exact-file grant and a Read grant are not roots and change nothing here.
      await grant(owner, file);
      await grant(owner, await realFolder('unode-r4a-read-'), 'read');
      const third = await sendTurn(backend, fake, 'three');
      expect(fake.procs).toHaveLength(2);
      expect(sandboxOf(third).writableRoots.map(key).sort()).toEqual([workspace, granted].map(key).sort());
      expect(sandboxOf(third).writableRoots.map(key)).not.toContain(key(path.dirname(file)));
      await endTurn(backend, fake, 'turn-3');

      owner.revokePathAccess(folderGrant.id);
      const fourth = await sendTurn(backend, fake, 'four');
      expect(fake.procs).toHaveLength(3);
      expect(sandboxOf(fourth).writableRoots).toEqual([workspace]);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  // G4: what the roots mean decides, not how they are written.
  it('neither restarts nor refuses for roots that differ only in order, repeats, spelling or a covered child root', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    await fs.mkdir(path.join(granted, 'child'));
    let writeRoots = [workspace, granted];
    const fake = measuredAppServer();
    const { backend, events } = await codex({ workspace, fake, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [...writeRoots], writeRoots: [...writeRoots] }),
    } });
    try {
      // A thread/start reports no root beyond the working folder, so the granted one is applied by a resume in a new process.
      const first = await sendTurn(backend, fake, 'one');
      expect(fake.procs).toHaveLength(2);
      expect(fake.sent('thread/start')).toHaveLength(1);
      expect(fake.sent('thread/resume').map((entry) => entry.process)).toEqual([2]);
      expect(sandboxOf(first).writableRoots.map(key).sort()).toEqual([workspace, granted].map(key).sort());
      await endTurn(backend, fake, 'turn-1');
      const respelled = process.platform === 'win32' ? granted.toUpperCase() : `${granted}${path.sep}`;
      writeRoots = [path.join(granted, 'child'), respelled, workspace, granted, workspace];
      await sendTurn(backend, fake, 'two');
      expect(fake.procs).toHaveLength(2);
      expect(fake.sent('thread/resume').map((entry) => entry.process)).toEqual([2, 2]);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  // G4: a resume that does not report the requested write access is a refusal, after one restart.
  it('refuses the turn when the new process still does not apply the granted folder, and restarts only once', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    let writeRoots = [workspace];
    const fake = measuredAppServer({ resumeApplies: false });
    const { backend, events } = await codex({ workspace, fake, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [...writeRoots], writeRoots: [...writeRoots] }),
    } });
    try {
      await sendTurn(backend, fake, 'one');
      await endTurn(backend, fake, 'turn-1');
      writeRoots = [workspace, granted];
      backend.sendUserTurn('two');
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'error')).toBe(true), SETTLED);
      expect(fake.procs).toHaveLength(2);
      expect(fake.sent('turn/start')).toHaveLength(1);
      expect(events.find((event) => event.kind === 'error').message)
        .toBe(`Codex refused to start: App Server did not apply this agent's write access to ${granted}, so it could not write there.`);
    } finally { await backend.stop(); }
  });

  // T102-12c: explicit Off (no write), Plan and Stop.
  it('gives no grant to an agent that may not write or to a Plan turn, and a grant after Stop starts nothing', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    await grant(owner, granted);
    expect(extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1'), mayWrite: false }).access().writeRoots).toEqual([workspace]);
    expect(extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1'), trusted: () => false }).access().writeRoots).toEqual([]);
    const fake = measuredAppServer();
    const { backend } = await codex({ workspace, fake, deps: extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') }) });
    try {
      expect(sandboxOf(await sendTurn(backend, fake, 'plan', { mode: 'plan' }))).toEqual({ type: 'readOnly', networkAccess: false });
      await endTurn(backend, fake, 'turn-1');
    } finally { await backend.stop(); }
    const spawned = fake.procs.length;
    await grant(owner, await realFolder('unode-r4a-later-'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.procs).toHaveLength(spawned);
    expect(fake.sent('turn/start')).toHaveLength(1);
  });
});

describe('a resumed Codex thread does not repeat what an earlier turn did (v0.9.102 R4a, G6)', () => {
  const change = (file: string) => ({ id: 'fc-1', type: 'fileChange', status: 'completed',
    changes: [{ path: file, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-before\n+after\n' }] });

  // Bookkeeping: an item event of an earlier turn, reported again after the policy restart, is not this turn's work.
  it('counts, notes and shows an earlier turn\'s file change once, and keeps this turn\'s items that come before its turn id', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const file = path.join(workspace, 'a.txt');
    await fs.writeFile(file, 'after');
    let writeRoots = [workspace];
    let fake!: Fake;
    fake = measuredAppServer({
      afterThread: (method, process) => {
        if (method !== 'thread/resume' || process !== 2) return;
        // The earlier turn's change, reported again by the new process before any turn of its own.
        queueMicrotask(() => {
          fake.notify('item/started', { threadId: THREAD, turnId: 'turn-1', item: { ...change(file), status: 'inProgress' } });
          fake.notify('item/completed', { threadId: THREAD, turnId: 'turn-1', item: change(file) });
        });
      },
      beforeTurnReply: (turnId) => {
        if (turnId !== 'turn-2') return;
        // While turn/start is unanswered: once more the earlier change, and this turn's own first item.
        fake.notify('item/completed', { threadId: THREAD, turnId: 'turn-1', item: change(file) });
        fake.notify('item/started', { threadId: THREAD, turnId: 'turn-2', item: { id: 'cmd-2', type: 'commandExecution', command: 'git status' } });
      },
    });
    const noted: unknown[] = [];
    const fileWrites = new Proxy({} as any, { get: (_target, name) => (...args: unknown[]) => {
      noted.push(name);
      return name === 'observe' ? Promise.resolve({ state: { exists: false } }) : Promise.resolve(undefined);
    } });
    const { backend, events } = await codex({ workspace, fake, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [...writeRoots], writeRoots: [...writeRoots] }), fileWrites,
    } });
    try {
      await sendTurn(backend, fake, 'one');
      fake.notify('item/started', { threadId: THREAD, turnId: 'turn-1', item: { ...change(file), status: 'inProgress' } });
      fake.notify('item/completed', { threadId: THREAD, turnId: 'turn-1', item: change(file) });
      const first = await endTurn(backend, fake, 'turn-1');
      expect(first.result.delegationEvidence.changedFiles).toEqual([file]);
      const shownAfterFirst = events.filter((event) => event.name === 'file_change').length;
      const notedAfterFirst = noted.length;

      writeRoots = [workspace, await realFolder('unode-r4a-grant-')];
      await sendTurn(backend, fake, 'two');
      expect(fake.procs).toHaveLength(2);
      fake.notify('item/completed', { threadId: THREAD, turnId: 'turn-2', item: { id: 'cmd-2', type: 'commandExecution', command: 'git status', exitCode: 0, aggregatedOutput: '' } });
      const second = await endTurn(backend, fake, 'turn-2');
      expect(second.result.delegationEvidence.changedFiles).toEqual([]);
      expect(events.filter((event) => event.name === 'file_change')).toHaveLength(shownAfterFirst);
      expect(noted).toHaveLength(notedAfterFirst);
      // This turn's own item, which came before its turn id, is kept: its card opens and closes once.
      expect(events.filter((event) => event.name === 'command_execution').map((event) => event.kind)).toEqual(['tool_use', 'tool_result']);
      expect(second.result.delegationEvidence.hadToolActions).toBe(true);
    } finally { await backend.stop(); }
  });

  // Side effects: the host sends App Server nothing that would repeat the earlier turn, and approves nothing of it again.
  it('resumes without the earlier input, and declines an approval of the earlier change asked again', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const file = path.join(workspace, 'a.txt');
    await fs.writeFile(file, 'after');
    let writeRoots = [workspace];
    const fake = measuredAppServer();
    const prepared: unknown[] = [];
    const approvals: unknown[] = [];
    const { backend } = await codex({ workspace, fake, agent: { codexPermissionProfile: 'ask-for-approval' }, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [...writeRoots], writeRoots: [...writeRoots] }),
      writeApprovalAsk: () => true,
      requestApproval: async (request) => { approvals.push(request); return { allow: true }; },
      prepareFileCheckpoint: async (changes) => { prepared.push(changes); return { ok: true }; },
    } });
    try {
      await sendTurn(backend, fake, 'first instruction');
      await endTurn(backend, fake, 'turn-1');
      writeRoots = [workspace, await realFolder('unode-r4a-grant-')];
      const second = await sendTurn(backend, fake, 'second instruction');
      expect(fake.procs).toHaveLength(2);
      const toNewProcess = fake.clientMessages.filter((entry) => entry.process === 2 && entry.message.method);
      expect(toNewProcess.map((entry) => entry.message.method)).toEqual(expect.arrayContaining(['thread/resume', 'turn/start']));
      expect(toNewProcess.find((entry) => entry.message.method === 'thread/resume')!.message.params.input).toBeUndefined();
      expect(JSON.stringify(second.params.input)).toContain('second instruction');
      expect(JSON.stringify(second.params.input)).not.toContain('first instruction');
      // The earlier turn's change, asked for again: the host has no such change of this turn, so it is declined.
      fake.request('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'fc-1' }, 'replayed-approval');
      expect((await answer(fake, 'replayed-approval')).result).toEqual({ decision: 'decline' });
      expect(prepared).toEqual([]);
      expect(approvals).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe('after');
    } finally { await backend.stop(); }
  });
});

describe('an exact-file grant is written by the host write_file on Codex (v0.9.102 R4a, G7)', () => {
  async function hostCodex(options: { ask?: boolean; profile?: string; snapshot?: ConversationSnapshot; withoutTool?: boolean } = {}) {
    const h = await saveHost({ ask: options.ask });
    const outside = await realFolder('unode-r4a-outside-');
    const target = path.join(outside, 'granted.txt');
    const neighbour = path.join(outside, 'neighbour.txt');
    await fs.writeFile(target, 'old text');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const tools: WorkspaceTools = h.tools('codex-1');
    tools.setLivePathAccess(() => owner.pathAccessFor('r1'));
    const wiring = extensionAccessWiring({ workspace: h.root, grants: () => owner.pathAccessFor('r1') });
    const fake = measuredAppServer();
    const prepared: unknown[] = [];
    const { backend, events } = await codex({ workspace: h.root, fake,
      agent: { codexPermissionProfile: (options.profile ?? 'approve-for-me') as any },
      deps: { ...wiring, hostFileTools: tools, prepareFileCheckpoint: async (changes) => { prepared.push(changes); return { ok: true }; } } });
    if (options.snapshot) expect(backend.restore(options.snapshot)).toBe(true);
    return { h, outside, target, neighbour, owner, tools, fake, backend, events, prepared };
  }

  // T102-11b: a new conversation, Approve for me. Native exact-file scope is NOT SUPPORTED (the Owner); the host writes it.
  it('offers write_file to a new conversation, writes the granted file with a restore point, and not its neighbour', async () => {
    const c = await hostCodex();
    try {
      await grant(c.owner, c.target);
      const turn = await sendTurn(c.backend, c.fake, 'update the granted file');
      const offered = c.fake.sent('thread/start')[0].message.params.dynamicTools.find((tool: any) => tool.name === 'write_file');
      const own = c.tools.specs().find((spec) => spec.function.name === 'write_file')!;
      expect(offered).toEqual({ name: 'write_file', description: `${own.function.description} ${CODEX_WRITE_FILE_ROUTE}`,
        inputSchema: own.function.parameters });
      expect(offered.inputSchema.required).toEqual(['path', 'content']);
      expect(c.backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: expect.stringContaining('"writeFile":true') });
      // The sandbox does not take the file's folder; the turn names the file and the tool.
      expect(sandboxOf(turn).writableRoots).toEqual([c.h.root]);
      const text = turn.params.input[0].text as string;
      expect(text).toContain('[exact file grants]');
      expect(text).toContain(`- ${c.target}`);
      expect(text).toContain('Write them with write_file');

      c.fake.toolCall('write_file', { path: c.target, content: 'new text' }, 'write-granted', 'turn-1');
      expect((await answer(c.fake, 'write-granted')).result.success).toBe(true);
      expect(readFileSync(c.target, 'utf8')).toBe('new text');
      expect(c.h.text.list().some((entry: any) => key(entry.target ?? '') === key(c.target))).toBe(true);
      expect(c.events.find((event) => event.kind === 'tool_result' && event.name === 'write_file').outcome).toMatchObject({ status: 'success', observedBy: 'host' });

      c.fake.toolCall('write_file', { path: c.neighbour, content: 'not granted' }, 'write-neighbour', 'turn-1');
      expect((await answer(c.fake, 'write-neighbour')).result.success).toBe(false);
      expect(existsSync(c.neighbour)).toBe(false);
    } finally { await c.backend.stop(); }
  });

  // T102-11c: the person's own Ask for approval stays; no native route for one file, the host write asks as it always does.
  it('under Ask for approval keeps the profile, declines a native change to the file and writes it through the host card', async () => {
    const c = await hostCodex({ ask: true, profile: 'ask-for-approval' });
    try {
      await grant(c.owner, c.target);
      const turn = await sendTurn(c.backend, c.fake, 'update the granted file');
      expect(turn.params.approvalsReviewer).toBe('user');
      expect(sandboxOf(turn).writableRoots).toEqual([c.h.root]);
      c.fake.notify('item/started', { threadId: THREAD, turnId: 'turn-1', item: { id: 'fc-native', type: 'fileChange', status: 'inProgress',
        changes: [{ path: c.target, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old text\n+native\n' }] } });
      c.fake.request('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'fc-native' }, 'native-change');
      expect((await answer(c.fake, 'native-change')).result).toEqual({ decision: 'decline' });
      expect(c.prepared).toEqual([]);
      expect(readFileSync(c.target, 'utf8')).toBe('old text');

      c.fake.toolCall('write_file', { path: c.target, content: 'host text' }, 'host-write', 'turn-1');
      expect((await answer(c.fake, 'host-write')).result.success).toBe(true);
      expect(c.h.state.approvals).toHaveLength(1);
      expect(readFileSync(c.target, 'utf8')).toBe('host text');
    } finally { await c.backend.stop(); }
  });

  // T102-12b: each host call checks the live grant: a revoked grant refuses the very next write.
  it('refuses the next host write once the file grant is revoked, in the same turn', async () => {
    const c = await hostCodex();
    try {
      const fileGrant = await grant(c.owner, c.target);
      await sendTurn(c.backend, c.fake, 'update the granted file');
      c.owner.revokePathAccess(fileGrant.id);
      c.fake.toolCall('write_file', { path: c.target, content: 'after revoke' }, 'revoked-write', 'turn-1');
      expect((await answer(c.fake, 'revoked-write')).result.success).toBe(false);
      expect(readFileSync(c.target, 'utf8')).toBe('old text');
    } finally { await c.backend.stop(); }
  });

  // G7, the existing conversation: resumed, not reset; told the real route only when an exact-file grant needs it.
  it('resumes a conversation started without write_file, names the New Model Conversation route and writes nothing', async () => {
    const old = await hostCodex();
    let snapshot!: ConversationSnapshot;
    try {
      await sendTurn(old.backend, old.fake, 'hello');
      await endTurn(old.backend, old.fake, 'turn-1');
      // As saved by a version without write_file: the same surface without its bit.
      const saved = JSON.parse(JSON.stringify(old.backend.snapshot()));
      saved.messages[0].codexDynamicTools = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(saved.messages[0].codexDynamicTools))
        .filter(([name]) => name !== 'writeFile')));
      snapshot = { ...saved, version: 3, backend: 'codex', hostTurnState: 'complete' };
    } finally { await old.backend.stop(); }
    const resets: string[] = [];
    const c = await hostCodex({ snapshot });
    c.backend.onEvent((event) => { if (event.kind === 'log' && /fresh conversation/.test(event.line)) resets.push(event.line); });
    try {
      const plain = await sendTurn(c.backend, c.fake, 'no grant yet');
      expect(c.fake.sent('thread/start')).toHaveLength(0);
      expect(c.fake.sent('thread/resume')).toHaveLength(1);
      expect(resets).toEqual([]);
      expect(plain.params.input[0].text).not.toContain('write_file');
      await endTurn(c.backend, c.fake, 'turn-1');

      await grant(c.owner, c.target);
      const told = (await sendTurn(c.backend, c.fake, 'update the granted file')).params.input[0].text as string;
      expect(told).toContain(`- ${c.target}`);
      expect(told).toContain('cannot gain write_file mid-thread');
      expect(told).toContain('New Model Conversation (keep chat)');
      c.fake.toolCall('write_file', { path: c.target, content: 'old thread' }, 'old-thread-write', 'turn-2');
      const refused = await answer(c.fake, 'old-thread-write');
      expect(refused.result.success).toBe(false);
      expect(refused.result.contentItems[0].text).toContain('1. Select this agent');
      expect(refused.result.contentItems[0].text).toContain('Do not claim the file was saved.');
      expect(readFileSync(c.target, 'utf8')).toBe('old text');
    } finally { await c.backend.stop(); }
  });
});

describe('a folder revoked before a Codex turn is sent never reaches that turn (v0.9.102 R4a, audit of cc790b32)', () => {
  // The audit's reproduction: the grant is revoked while App Server answers thread/start, before turn/start is sent.
  it('sends the turn without a folder revoked while the turn was being prepared, and says nothing of it', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    const { owner, posted, onNativeWriteScope } = wiredBoundary();
    const folderGrant = await grant(owner, granted);
    let revoked = false;
    const fake = measuredAppServer({ afterThread: (method) => {
      if (!revoked && method === 'thread/start') { revoked = true; owner.revokePathAccess(folderGrant.id); }
    } });
    const { backend, events } = await codex({ workspace, fake,
      deps: { ...extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') }), onNativeWriteScope } });
    try {
      const turn = await sendTurn(backend, fake, 'work');
      expect(revoked).toBe(true);
      expect(owner.pathAccessFor('r1')).toHaveLength(0);
      expect(sandboxOf(turn).writableRoots).toEqual([workspace]);
      expect(turn.params.runtimeWorkspaceRoots).toEqual([workspace]);
      // The thread was resumed under the sandbox the turn was sent with.
      expect(fake.sent('thread/resume').at(-1)!.message.params.runtimeWorkspaceRoots).toEqual([workspace]);
      expect(posted).toEqual([]);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  /** The runtime roots of the latest thread request, as App Server got them. */
  const lastThreadRoots = (fake: Fake): string[] => fake.clientMessages
    .filter((entry) => entry.message.method === 'thread/start' || entry.message.method === 'thread/resume')
    .at(-1)!.message.params.runtimeWorkspaceRoots.map(key);

  // A second revocation while the first is being applied: applied too, and the turn is sent.
  it('sends the turn without either folder when a second one is revoked while the first revocation is applied', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const first = await realFolder('unode-r4a-grant-');
    const second = await realFolder('unode-r4a-grant-');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const firstGrant = await grant(owner, first);
    const secondGrant = await grant(owner, second);
    let fake!: Fake;
    fake = measuredAppServer({ afterThread: () => {
      const roots = lastThreadRoots(fake);
      if (roots.includes(key(first))) owner.revokePathAccess(firstGrant.id);
      // The resume that applies the first revocation: now the second grant is revoked as well.
      else if (roots.includes(key(second))) owner.revokePathAccess(secondGrant.id);
    } });
    const { backend, events } = await codex({ workspace, fake, deps: extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') }) });
    try {
      const turn = await sendTurn(backend, fake, 'work');
      expect(owner.pathAccessFor('r1')).toHaveLength(0);
      expect(sandboxOf(turn).writableRoots).toEqual([workspace]);
      expect(turn.params.runtimeWorkspaceRoots).toEqual([workspace]);
      expect(fake.sent('thread/resume').at(-1)!.message.params.runtimeWorkspaceRoots).toEqual([workspace]);
      expect(fake.sent('turn/start')).toHaveLength(1);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  // A grant made while a revocation is applied is wider: it waits for the next turn and starts no restart of its own.
  it('sends the turn without a folder granted while a revocation is applied, and gives it to the next turn', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const revoked = await realFolder('unode-r4a-grant-');
    const later = await realFolder('unode-r4a-later-');
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const revokedGrant = await grant(owner, revoked);
    // A real grant of the same store kind, made beforehand so that it can take effect at an exact moment.
    const laterGrant = await grant(new SessionLocalReadScopeConsent(async () => false), later);
    const added: SessionPathAccessGrant[] = [];
    let fake!: Fake;
    fake = measuredAppServer({ afterThread: () => {
      const roots = lastThreadRoots(fake);
      if (roots.includes(key(revoked))) owner.revokePathAccess(revokedGrant.id);
      else if (added.length === 0) added.push(laterGrant);
    } });
    const atDispatch: string[][] = [];
    const { backend, events } = await codex({ workspace, fake, deps: {
      ...extensionAccessWiring({ workspace, grants: () => [...owner.pathAccessFor('r1'), ...added] }),
      onNativeWriteScope: (scope) => { atDispatch.push([...scope.current()].map(key)); },
    } });
    try {
      const turn = await sendTurn(backend, fake, 'work');
      // The new folder was there when the turn was sent, and the turn went without it and without another restart.
      expect(atDispatch[0]).toContain(key(later));
      expect(sandboxOf(turn).writableRoots).toEqual([workspace]);
      const processes = fake.procs.length;
      expect(fake.sent('turn/start')[0].process).toBe(processes);
      await endTurn(backend, fake, 'turn-1');
      const next = await sendTurn(backend, fake, 'next');
      expect(sandboxOf(next).writableRoots.map(key).sort()).toEqual([workspace, later].map(key).sort());
      expect(fake.procs).toHaveLength(processes + 1);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  // The approval settings follow the same rule: a stricter choice made during setup is applied; a looser one waits.
  it('applies a stricter approval chosen during setup to the turn, and keeps a looser one for the next turn', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    let profile = 'approve-for-me';
    let threadRequests = 0;
    const fake = measuredAppServer({ afterThread: () => {
      threadRequests += 1;
      if (threadRequests === 1) profile = 'ask-for-approval';
      else if (threadRequests === 3) profile = 'approve-for-me';
    } });
    // v0.9.102 (the Owner, 2026-11-12): both profiles send `user` to App Server now; they differ in what UnodeAi does
    // with an escape. The profile each turn is held under is what the backend reports at dispatch.
    const held: string[] = [];
    const { backend, events } = await codex({ workspace, fake, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [workspace], writeRoots: [workspace] }),
      permissionProfile: () => profile,
      onNativePolicy: (turnProfile: string) => { held.push(turnProfile); },
    } });
    try {
      // Approve for me when sent for, Ask for approval chosen meanwhile: the turn goes under Ask for approval.
      expect((await sendTurn(backend, fake, 'one')).params.approvalsReviewer).toBe('user');
      expect(fake.sent('thread/resume').at(-1)!.message.params.approvalsReviewer).toBe('user');
      expect(held.at(-1)).toBe('ask-for-approval');
      await endTurn(backend, fake, 'turn-1');
      // Approve for me chosen while the next turn is prepared: that turn keeps Ask for approval, the one after uses it.
      expect((await sendTurn(backend, fake, 'two')).params.approvalsReviewer).toBe('user');
      expect(held.at(-1)).toBe('ask-for-approval');
      expect(threadRequests).toBe(3);
      await endTurn(backend, fake, 'turn-2');
      expect((await sendTurn(backend, fake, 'three')).params.approvalsReviewer).toBe('user');
      expect(held.at(-1)).toBe('approve-for-me');
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });

  it('judges the thread App Server returns by the profile it was asked for, when Full access is chosen meanwhile', async () => {
    // Ask for approval and Approve for me send the same approval settings to App Server, so only a choice with other
    // settings (Full access: approvalPolicy never) shows which profile the thread check compares the answer with.
    const workspace = await realFolder('unode-r4a-ws-');
    let profile = 'ask-for-approval';
    let threadRequests = 0;
    const fake = measuredAppServer({ afterThread: () => {
      threadRequests += 1;
      if (threadRequests === 1) profile = 'full-access';
    } });
    const held: string[] = [];
    const { backend, events } = await codex({ workspace, fake, deps: {
      access: () => ({ trusted: true, restricted: false, readRoots: [workspace], writeRoots: [workspace] }),
      permissionProfile: () => profile,
      onNativePolicy: (turnProfile: string) => { held.push(turnProfile); },
    } });
    try {
      const turn = await sendTurn(backend, fake, 'one');
      expect(fake.sent('thread/start').at(-1)!.message.params.approvalPolicy).toBe('on-request');
      // The looser choice waits for the next turn; the host's own thread request is not refused.
      expect(turn.params.approvalPolicy).toBe('on-request');
      expect(held.at(-1)).toBe('ask-for-approval');
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
  });
});

describe('revoking a folder a running Codex turn started with says so once (v0.9.102 R4a, T102-12a)', () => {
  it('tells the running turn\'s chat once, keeps the turn going, and the next turn starts without the folder', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    const scopes = new Map();
    const posted: Array<{ agentId: string; text: string }> = [];
    let currentTurn: string | undefined = 'request-turn-1';
    const sessionManager = { currentTurnId: () => currentTurn, get: () => ({ config: { name: 'Codex Dev' } }) };
    const notices = boundaryNotices({ codexTurnWriteScopes: scopes, sessionManager, revokedDuringTurn, codexGrantBoundaryNotice,
      chatViewProvider: { postRuntimeNotice: (agentId: string, text: string) => posted.push({ agentId, text }) } });
    // The extension's actual grant-row change hook, over the real grant store.
    const changed = evaluateWiring<() => void>(extensionWiring('SessionLocalReadScopeConsent', 3, 'changed'),
      { accessTable: { grantRows: { changed: () => undefined } }, noticeCodexGrantBoundaries: notices, SecurityPanel: { refreshIfOpen: () => undefined } });
    const rows: PathGrantRows = { map: new Map(), changed, changedLater: () => undefined };
    const owner = new SessionLocalReadScopeConsent(async () => false, undefined, undefined, rows);
    const folderGrant = await grant(owner, granted);
    const fake = measuredAppServer();
    const onNativeWriteScope = evaluateWiring<NonNullable<CodexBackendDeps['onNativeWriteScope']>>(
      extensionWiring('CodexBackend', 2, 'onNativeWriteScope'), { sessionManager, config: { id: 'codex-1' }, codexTurnWriteScopes: scopes });
    const { backend, events } = await codex({ workspace, fake,
      deps: { ...extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') }), onNativeWriteScope } });
    try {
      const running = await sendTurn(backend, fake, 'work in the folder');
      expect(sandboxOf(running).writableRoots.map(key)).toContain(key(granted));
      expect(posted).toEqual([]);
      owner.revokePathAccess(folderGrant.id);
      expect(posted).toEqual([{ agentId: 'codex-1', text: codexGrantBoundaryNotice('Codex Dev', [granted]) }]);
      expect(posted[0].text).toContain('may still write there until that turn ends');
      expect(posted[0].text).toContain('press Stop');
      // Said once: another change of grants during the same turn says nothing more. No interrupt was sent.
      await grant(owner, path.join(await realFolder('unode-r4a-file-'), 'x.txt'));
      expect(posted).toHaveLength(1);
      expect(fake.sent('turn/interrupt')).toEqual([]);
      await endTurn(backend, fake, 'turn-1');
      currentTurn = 'request-turn-2';
      const next = await sendTurn(backend, fake, 'next');
      expect(sandboxOf(next).writableRoots).toEqual([workspace]);
      expect(fake.procs.length).toBeGreaterThan(1);
      expect(events.some((event) => event.kind === 'error')).toBe(false);
    } finally { await backend.stop(); }
    // With no running turn, a change says nothing.
    currentTurn = undefined;
    await grant(owner, await realFolder('unode-r4a-again-'));
    expect(posted).toHaveLength(1);
  });
  // The turn was sent with the folder, and App Server has not answered yet: its scope is the one recorded at dispatch.
  it('tells a turn revoked right after it was sent, before App Server answered it', async () => {
    const workspace = await realFolder('unode-r4a-ws-');
    const granted = await realFolder('unode-r4a-grant-');
    const { owner, posted, onNativeWriteScope } = wiredBoundary();
    const folderGrant = await grant(owner, granted);
    const fake = measuredAppServer({ beforeTurnReply: () => owner.revokePathAccess(folderGrant.id) });
    const { backend } = await codex({ workspace, fake,
      deps: { ...extensionAccessWiring({ workspace, grants: () => owner.pathAccessFor('r1') }), onNativeWriteScope } });
    try {
      const sent = await sendTurn(backend, fake, 'work in the folder');
      expect(sandboxOf(sent).writableRoots.map(key)).toContain(key(granted));
      expect(owner.pathAccessFor('r1')).toHaveLength(0);
      expect(posted).toEqual([{ agentId: 'codex-1', text: codexGrantBoundaryNotice('Codex Dev', [granted]) }]);
    } finally { await backend.stop(); }
  });
});
