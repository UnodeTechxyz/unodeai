import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { CodexBackend } from '../CodexBackend';
import { FileWritePolicy, type OverwriteDecision, type OverwriteDecisionRequest } from '../fileWritePolicy';
import { CommandPolicy } from '../CommandPolicy';
import { codexProtocolPermissionSettings } from '../CodexSpawnArgs';
import { claudePermissionResponse, decideCommandPermission } from '../commandPermission';
import type { SecurityControlArtifactLocation } from '../../security/SecurityControlArtifacts';
import type { AgentConfig } from '../../types';

const roots: string[] = [];
const backends: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(backends.splice(0).map(backend => backend.stop()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function root() { const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-s3-native-'))); roots.push(value); return value; }
function config(cwd: string, backend: 'claude' | 'codex'): AgentConfig {
  return { id: `${backend}-fixture`, name: 'Native fixture', role: 'developer', skill: '',
    provider: { providerId: backend, apiKeySecretName: 'FIXTURE_ONLY' }, model: 'fixture-model',
    systemPrompt: '', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend, workingDirectory: cwd,
    ...(backend === 'codex' ? { codexPermissionProfile: 'ask-for-approval' as const } : {}) };
}
const before = '{"unode.commandApproval":"ask","editor.fontSize":14}\n';
const after = '{"unode.commandApproval":"all","editor.fontSize":14}\n';
async function nativeFixture(kind: 'claude' | 'codex', decision: (request: OverwriteDecisionRequest) => Promise<OverwriteDecision> = async () => 'once', commandPermission?: any) {
  const cwd = await root(); const file = path.join(cwd, 'settings.json'); await fs.writeFile(file, before);
  const decisions: OverwriteDecisionRequest[] = []; const ordinaryAsk = vi.fn(async () => 'once' as const);
  const policy = new FileWritePolicy({ workspaceId: () => cwd, gitPath: async () => ({ repository: false }),
    securityControls: async () => [{ kind: 'user-settings', path: file }] });
  const writes = policy.forAgent({ agentId: `${kind}-fixture`, base: cwd, requestId: () => 'request', turnId: () => 'turn',
    decide: async request => { decisions.push(request); return decision(request); } });
  const checkpoint = vi.fn(async () => ({ ok: true }));
  const backend = kind === 'claude'
    ? new ClaudeHeadlessBackend(config(cwd, kind), undefined, undefined, { fileWrites: writes, writeApprovalAsk: () => true,
      requestWriteApproval: ordinaryAsk, writeRoots: [cwd], commandPermission })
    : new CodexBackend(config(cwd, kind), undefined, { fileWrites: writes, writeApprovalAsk: () => true,
      requestApproval: async () => { await ordinaryAsk(); return { allow: true }; }, prepareFileCheckpoint: checkpoint,
      access: () => ({ trusted: true, restricted: false, readRoots: [cwd], writeRoots: [cwd] }) });
  backends.push(backend);
  const runtime = backend as any;
  if (kind === 'claude') runtime.turnBoundaryAbort = new AbortController();
  else runtime.managedToolAbortController = new AbortController();
  const propose = async (tool = 'Write', input?: Record<string, unknown>, toolId = `toolu_${Math.random().toString(16).slice(2)}`) => {
    if (kind === 'claude') return runtime.handlePreToolUse({ tool_name: tool, tool_use_id: toolId,
      tool_input: input ?? { file_path: file, content: after } });
    runtime.pendingFileChanges.set('change', [{ path: file, kind: { type: 'update' },
      diff: `@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n`, ...input }]);
    return runtime.fileApproval({ itemId: 'change' }, false);
  };
  return { cwd, file, backend, runtime, writes, propose, decisions, ordinaryAsk, checkpoint };
}

describe('S3 actual native file-control boundaries', () => {
  it('a native shown proposal changed during approval explains the change and new review instead of unresolved preparation', async () => {
    const cwd = await root(); const source = path.join(cwd, 'index.js'); await fs.writeFile(source, 'export const ready = 1;');
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'public-fixture', version: '1.0.0' }));
    let asked = 0;
    const result = await decideCommandPermission('Bash', { command: 'npm publish --ignore-scripts --registry=https://registry.invalid' }, {
      cwd, environment: { HOME: cwd, USERPROFILE: cwd, NPM_CONFIG_USERCONFIG: path.join(cwd, 'no-npmrc') }, policy: new CommandPolicy('all'),
      requestApproval: async () => { asked++; await fs.writeFile(source, 'export const ready = 2;'); return { allow: true }; },
    });
    expect(asked).toBe(1); expect(result).toMatchObject({ behavior: 'deny', reason: 'safety-limit' });
    if (result.behavior !== 'deny') throw new Error('expected changed proposal refusal');
    expect(result.message).toContain('changed while waiting'); expect(result.message).toContain('new request');
    expect(result.message).not.toContain('could not be prepared');
  });
  it('the native permission response quotes the human note while the internal decision message remains clean', async () => {
    const note = 'NATIVE-PERMISSION-INSTRUCTION';
    const decision = await decideCommandPermission('Bash', { command: 'echo fixture' }, { policy: new CommandPolicy('ask'),
      requestApproval: async () => ({ allow: false, note, noteOrigin: 'human' }) });
    expect(decision).toMatchObject({ behavior: 'deny', userNote: note });
    if (decision.behavior !== 'deny') throw new Error('expected decline');
    expect(decision.message).not.toContain(note); expect(claudePermissionResponse(decision)).toMatchObject({ behavior: 'deny', message: expect.stringContaining(`The user said: ${JSON.stringify(note)}`) });
  });
  it('Claude quotes a real security decline to the model and emits only the clean refusal when the CLI echoes it', async () => {
    const note = 'OWNER-NOTE "keep the credential file"';
    const h = await nativeFixture('claude', async () => ({ action: 'deny', userNote: note })); const events: unknown[] = [];
    h.backend.onEvent(event => events.push(event)); const id = 'toolu_declinenote';
    const input = { file_path: h.file, content: after }; const decision = await h.propose('Write', input, id);
    expect(decision).toMatchObject({ allow: false, reason: expect.stringContaining(`The user said: ${JSON.stringify(note)}`) });
    await h.runtime.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input }] } });
    await h.runtime.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: decision.reason, is_error: true }] } });
    expect(JSON.stringify(events)).not.toContain('OWNER-NOTE'); expect(await fs.readFile(h.file, 'utf8')).toBe(before);
  });

  it('ordinary native Bash quotes only a human decline and never a host expiry explanation', async () => {
    for (const noteOrigin of ['human', 'host'] as const) {
      const note = 'EXPLICIT-NOTE "try tomorrow"';
      const h = await nativeFixture('claude', undefined, { policy: new CommandPolicy('ask'),
        requestApproval: async () => ({ allow: false, note, noteOrigin }) });
      const result = await h.propose('Bash', { command: 'echo fixture' });
      expect(result.allow).toBe(false);
      expect(result.reason.includes('EXPLICIT-NOTE')).toBe(noteOrigin === 'human');
      if (noteOrigin === 'human') expect(result.reason).toContain(`The user said: ${JSON.stringify(note)}`);
    }
  });
  it.each(['Write', 'Edit'])('Claude %s uses actual before bytes and one security decision instead of ordinary Ask', async tool => {
    const h = await nativeFixture('claude');
    const input = tool === 'Write' ? { file_path: h.file, content: after }
      : { file_path: h.file, old_string: '"ask"', new_string: '"all"' };
    expect(await h.propose(tool, input)).toMatchObject({ allow: true });
    expect(h.decisions).toHaveLength(1); expect(h.decisions[0]).toMatchObject({ purpose: 'security-control', before, after });
    expect(h.decisions[0].securityChanges).toEqual([expect.objectContaining({ kind: 'user-settings', before, after })]);
    expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(await fs.readFile(h.file, 'utf8')).toBe(before);
  });

  it('Claude Edit derives its exact proposed bytes from the admitted observation, including a change after the initial tool input', async () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = await nativeFixture('claude'); const admitted = before.replace(':14', ':20');
      const observe = h.writes.observe.bind(h.writes); let changed = false;
      vi.spyOn(h.writes, 'observe').mockImplementation(async target => {
        if (!changed) { changed = true; await fs.writeFile(h.file, admitted); }
        return observe(target);
      });
      expect(await h.propose('Edit', { file_path: h.file, old_string: '"ask"', new_string: '"all"' })).toMatchObject({ allow: true });
      expect(h.decisions).toHaveLength(1);
      expect(h.decisions[0]).toMatchObject({ purpose: 'security-control', before: admitted, after: admitted.replace('"ask"', '"all"') });
      expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(await fs.readFile(h.file, 'utf8')).toBe(admitted);
    }
  });

  it('an ordinary native command Ask cannot survive Stop, replacement, Plan or a live no-write restriction', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const ending of ['stop', 'replacement', 'plan', 'write-off', 'trust']) {
      const asked = deferred<AbortSignal | undefined>(); const answer = deferred<{ allow: boolean }>(); let trusted = true;
      const h = await nativeFixture('claude', undefined, { policy: new CommandPolicy('ask'), isTrusted: () => trusted,
        requestApproval: async (_command: string, context: { signal?: AbortSignal }) => { asked.resolve(context.signal); return answer.promise; } });
      const pending = h.propose('Bash', { command: 'echo ordinary-fixture' }); const signal = await asked.promise;
      expect(signal).toBe(h.runtime.turnBoundaryAbort.signal);
      if (ending === 'stop') await h.backend.stop();
      else if (ending === 'replacement') h.runtime.turnBoundaryAbort = new AbortController();
      else if (ending === 'plan') h.runtime.activeTurnMode = 'plan';
      else if (ending === 'write-off') h.runtime.config.allowedTools = ['read'];
      else trusted = false;
      answer.resolve({ allow: true }); const result = await pending;
      expect(result).toMatchObject({ allow: false });
      if (ending === 'plan' || ending === 'write-off' || ending === 'trust') expect(result.reason).toContain('current Plan, trust or file/tool scope');
    }
  }, 30_000);

  it.each(['claude', 'codex'] as const)('%s refuses a declined security proposal without falling through to ordinary Ask', async kind => {
    const h = await nativeFixture(kind, async () => 'deny'); const result = await h.propose();
    expect(result).toMatchObject(kind === 'claude' ? { allow: false } : { decision: 'decline' });
    expect(h.decisions).toHaveLength(1); expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(h.checkpoint).not.toHaveBeenCalled();
    expect(await fs.readFile(h.file, 'utf8')).toBe(before);
  });

  it.each(['claude', 'codex'] as const)('%s derives a harmless font edit faithfully and keeps the chosen ordinary Ask', async kind => {
    const h = await nativeFixture(kind); const font = before.replace(':14', ':18');
    const result = await h.propose('Write', kind === 'claude' ? { file_path: h.file, content: font }
      : { diff: `@@ -1 +1 @@\n-${before.trimEnd()}\n+${font.trimEnd()}\n` });
    expect(result).toMatchObject(kind === 'claude' ? { allow: true } : { decision: 'accept' });
    expect(h.decisions).toEqual([]); expect(h.ordinaryAsk).toHaveBeenCalledTimes(1);
  });

  it('an ordinary Claude Edit uses its admitted after bytes on the existing Ask preview', async () => {
    const h = await nativeFixture('claude'); const font = before.replace(':14', ':18');
    expect(await h.propose('Edit', { file_path: h.file, old_string: ':14', new_string: ':18' })).toMatchObject({ allow: true });
    expect(h.decisions).toEqual([]); expect(h.ordinaryAsk).toHaveBeenCalledWith(expect.objectContaining({ before, after: font }));
    expect(await fs.readFile(h.file, 'utf8')).toBe(before);
  });

  it('Codex applies its diff to actual before bytes before one protected proposal and does not duplicate Ask/checkpoint fallback', async () => {
    const h = await nativeFixture('codex'); expect(await h.propose()).toEqual({ decision: 'accept' });
    expect(h.decisions).toHaveLength(1); expect(h.decisions[0]).toMatchObject({ purpose: 'security-control', before, after });
    expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(h.checkpoint).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(h.file, 'utf8')).toBe(before);
    const bad = await nativeFixture('codex');
    expect(await bad.propose('Write', { diff: '@@ -1 +1 @@\n-WRONG\n+invented\n' })).toEqual({ decision: 'decline' });
    expect(bad.decisions).toEqual([]); expect(bad.ordinaryAsk).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('%s cannot use a late security once answer after Stop', async kind => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const asked = deferred<OverwriteDecisionRequest>(); const answer = deferred<'once' | 'deny'>();
      const h = await nativeFixture(kind, request => { asked.resolve(request); return answer.promise; });
      const pending = h.propose(); const request = await asked.promise;
      expect(request.signal?.aborted).toBe(false); await h.backend.stop(); expect(request.signal?.aborted).toBe(true);
      answer.resolve('once'); expect(await pending).toMatchObject(kind === 'claude' ? { allow: false } : { decision: 'decline' });
      expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(await fs.readFile(h.file, 'utf8')).toBe(before);
    }
  });

  it.each(['claude', 'codex'] as const)('%s rechecks target contents and identity after the security decision', async kind => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const h: Awaited<ReturnType<typeof nativeFixture>> = await nativeFixture(kind,
        async () => { await fs.rename(h.file, `${h.file}.old`); await fs.writeFile(h.file, before); return 'once'; });
      const result = await h.propose(); expect(result).toMatchObject(kind === 'claude' ? { allow: false } : { decision: 'decline' });
      expect(h.decisions).toHaveLength(1); expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(await fs.readFile(h.file, 'utf8')).toBe(before);
    }
  });

  it('Codex rechecks a protected change after checkpoint persistence waits', async () => {
    const h = await nativeFixture('codex'); h.checkpoint.mockImplementation(async () => { await fs.writeFile(h.file, 'newer work'); return { ok: true }; });
    expect(await h.propose()).toEqual({ decision: 'decline' }); expect(h.decisions).toHaveLength(1);
    expect(h.ordinaryAsk).not.toHaveBeenCalled(); expect(await fs.readFile(h.file, 'utf8')).toBe('newer work');
  });
});

function fakeProcess() {
  const proc = new EventEmitter() as any; proc.pid = 515151; proc.exitCode = null;
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = proc.stderr.setEncoding = () => undefined;
  proc.stdin = { write: () => true, end: () => undefined, writable: true }; return proc;
}

function attachFakeAppServer(h: Awaited<ReturnType<typeof nativeFixture>>, afterDecline?: () => void) {
  const messages: any[] = []; const proc = fakeProcess();
  proc.stdin.write = (text: string) => {
    const message = JSON.parse(text); messages.push(message);
    if (message.result?.decision === 'decline') afterDecline?.();
    if (message.method === 'turn/steer') queueMicrotask(() => h.runtime.handleMessage({ id: message.id, result: { turnId: 'turn-note' } }));
    return true;
  };
  h.runtime.deps.spawn = () => proc;
  h.runtime.deps.killProcessTree = async () => { proc.exitCode = 0; proc.emit('exit', 0); };
  h.runtime.runtimeEnv = { CODEX_HOME: path.join(h.cwd, 'fixture-codex-home') }; h.runtime.spawnAppServer('fixture-codex.exe', false);
  h.runtime.threadId = 'thread-note'; h.runtime.turnId = 'turn-note'; h.runtime.turnRun = {};
  return messages;
}

describe('Codex human decline notes on the supported protocol channels', () => {
  it('a replacement during the decline write cannot receive the following model note', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const replacement of ['turn', 'signal']) {
      const h = await nativeFixture('codex'); const messages = attachFakeAppServer(h, () => {
        if (replacement === 'turn') h.runtime.turnId = 'replacement-after-write';
        else h.runtime.managedToolAbortController = new AbortController();
      });
      h.runtime.deps.requestApproval = async () => ({ allow: false, note: 'NOTE-FOR-ORIGINAL-TURN' });
      await h.runtime.handleServerRequest('replace-after-write', 'item/commandExecution/requestApproval', { command: 'echo fixture' });
      expect(messages).toEqual([{ jsonrpc: '2.0', id: 'replace-after-write', result: { decision: 'decline' } }]);
    }
  });
  it('Codex\'s actual fallback expiry declines without quoting or steering its generated explanation', async () => {
    vi.useFakeTimers();
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = await nativeFixture('codex'); const messages = attachFakeAppServer(h); const asked = deferred<void>();
      h.runtime.deps.approvalTimeoutMs = 10; h.runtime.deps.approvalTimerGraceMs = 0;
      h.runtime.deps.requestApproval = async () => { asked.resolve(); return new Promise(() => {}); };
      const pending = h.runtime.handleServerRequest('expiry', 'item/commandExecution/requestApproval', { command: 'echo fixture' });
      await asked.promise; await vi.advanceTimersByTimeAsync(10); await pending;
      expect(messages).toEqual([{ jsonrpc: '2.0', id: 'expiry', result: { decision: 'decline' } }]);
    }
  });
  it.each(['command', 'security'] as const)('writes the modern %s decline schema first, then quotes the note on the same turn/steer channel', async kind => {
    const note = 'HUMAN-CODEX-NOTE "use a draft"';
    const h = await nativeFixture('codex', async () => ({ action: 'deny', userNote: note })); const messages = attachFakeAppServer(h);
    const events: unknown[] = []; h.backend.onEvent(event => events.push(event));
    h.runtime.deps.requestApproval = async () => ({ allow: false, note, noteOrigin: 'human' });
    h.runtime.pendingFileChanges.set('change', [{ path: h.file, kind: { type: 'update' }, diff: `@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n` }]);
    await h.runtime.handleServerRequest('approval-note', kind === 'command' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval',
      kind === 'command' ? { command: 'echo fixture', itemId: 'command-note' } : { itemId: 'change' });
    expect(messages[0]).toEqual({ jsonrpc: '2.0', id: 'approval-note', result: { decision: 'decline' } });
    expect(messages[1]).toMatchObject({ method: 'turn/steer', params: { threadId: 'thread-note', expectedTurnId: 'turn-note',
      input: [{ type: 'text', text: `The user said: ${JSON.stringify(note)}. Adjust accordingly or ask them what to do.`, text_elements: [] }] } });
    expect(messages).toHaveLength(2); expect(JSON.stringify(events)).not.toContain('HUMAN-CODEX-NOTE');
  });

  it('legacy Codex quotes the human note in its existing rejection field and never steers host expiry text', async () => {
    const h = await nativeFixture('codex'); const messages = attachFakeAppServer(h); const note = 'LEGACY-HUMAN-NOTE';
    h.runtime.deps.requestApproval = async () => ({ allow: false, note });
    await h.runtime.handleServerRequest('legacy-note', 'execCommandApproval', { command: ['echo', 'fixture'] });
    expect(messages[0].result.decision.denied.rejection).toBe(`The user said: ${JSON.stringify(note)}. Adjust accordingly or ask them what to do.`);
    expect(messages).toHaveLength(1);
    h.runtime.deps.requestApproval = async () => ({ allow: false, note: 'HOST-EXPIRY', noteOrigin: 'host' });
    await h.runtime.handleServerRequest('expired-note', 'item/commandExecution/requestApproval', { command: 'echo fixture' });
    expect(messages).toHaveLength(2); expect(messages[1]).toMatchObject({ result: { decision: 'decline' } });
  });

  it('a late human decline cannot steer Stop or a replacement thread/turn/run', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const ending of ['stop', 'thread', 'turn', 'run', 'signal']) {
      const h = await nativeFixture('codex'); const messages = attachFakeAppServer(h);
      const asked = deferred<void>(); const answer = deferred<{ allow: boolean; note: string }>();
      h.runtime.deps.requestApproval = async () => { asked.resolve(); return answer.promise; };
      const events: Array<{ kind?: string; line?: string }> = []; h.backend.onEvent(event => events.push(event as never));
      const pending = h.runtime.handleServerRequest('late-note', 'item/commandExecution/requestApproval', { command: 'echo fixture' }); await asked.promise;
      if (ending === 'stop') await h.backend.stop();
      else if (ending === 'thread') h.runtime.threadId = 'replacement-thread';
      else if (ending === 'turn') h.runtime.turnId = 'replacement-turn';
      else if (ending === 'run') h.runtime.turnRun = {};
      else h.runtime.managedToolAbortController = new AbortController();
      answer.resolve({ allow: false, note: 'NEVER-STEER-THIS-LATE-NOTE' }); await pending;
      expect(messages.some(message => message.method === 'turn/steer')).toBe(false);
      // v0.9.103: since a refusal that cannot be written is logged instead of thrown, the stopped-transport guard is seen
      // only here. After Stop the late decline is dropped quietly; it is never tried on the closed transport.
      expect(events.filter(event => event.kind === 'log' && String(event.line).includes('was not answered'))).toEqual([]);
    }
  });
});
function effective(layers: unknown[], profile: Parameters<typeof codexProtocolPermissionSettings>[0] = 'ask-for-approval') {
  const settings = codexProtocolPermissionSettings(profile);
  return { config: { model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
    approval_policy: settings.approvalPolicy, approvals_reviewer: settings.approvalsReviewer, sandbox_mode: settings.sandboxMode,
    sandbox_workspace_write: { network_access: settings.networkAccess },
    apps: { _default: { default_tools_approval_mode: settings.appApprovalMode, approvals_reviewer: settings.appApprovalsReviewer } } }, layers };
}

describe('S3 actual host control-file publication', () => {
  it('Claude publishes only its real ephemeral gate/settings/MCP files and withdraws them after cleanup', async () => {
    const cwd = await root(); const published: SecurityControlArtifactLocation[][] = [];
    const proc = fakeProcess();
    const backend = new ClaudeHeadlessBackend(config(cwd, 'claude'), undefined, undefined, {
      spawn: (() => { setTimeout(() => proc.emit('spawn'), 0); return proc; }) as any,
      toolGateScriptPath: path.resolve('src/claudeToolGate.cjs'),
      hostFileTools: new (await import('../WorkspaceTools')).WorkspaceTools(cwd, new Set(['write'])),
      onControlFiles: files => published.push(files.map(file => ({ ...file }))),
      terminateProcessTree: async () => { proc.exitCode = 0; proc.emit('exit', 0); return { status: 'confirmed-stopped' }; },
    }); backends.push(backend); await backend.start({}, { pin: 'take' });
    const files = published.at(-1)!;
    expect(files.map(file => file.kind).sort()).toEqual(['claude-gate-settings', 'claude-gate-wrapper', 'claude-mcp-config']);
    for (const file of files) {
      expect(file.path.startsWith(path.join(cwd, '.unode', 'claude') + path.sep)).toBe(true);
      expect((await fs.stat(file.path)).isFile()).toBe(true);
    }
    await backend.stop(50); expect(published.at(-1)).toEqual([]);
    for (const file of files) await expect(fs.stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Codex publishes the final spawn environment before spawn, then its initialized home and actual user-layer file', async () => {
    const cwd = await root(); const published: SecurityControlArtifactLocation[][] = []; const proc = fakeProcess();
    const fallback = path.join(cwd, 'fallback-home'); const initialized = path.join(cwd, 'initialized-home'); const actualConfig = path.join(cwd, 'selected-profile', 'config.toml');
    const backend = new CodexBackend(config(cwd, 'codex'), undefined, {
      spawn: ((_exe: string, _args: string[], options: any) => {
        expect(published.at(-1)).toEqual([{ kind: 'codex-config', path: path.join(fallback, 'config.toml') }, { kind: 'codex-auth', path: path.join(fallback, 'auth.json') }]);
        expect(options.env.CODEX_HOME).toBe(fallback); return proc;
      }) as any, onControlFiles: files => published.push(files.map(file => ({ ...file }))), killProcessTree: async () => { proc.exitCode = 0; proc.emit('exit', 0); },
    }); backends.push(backend); const runtime = backend as any; runtime.runtimeEnv = { CODEX_HOME: fallback };
    runtime.spawnAppServer('fixture-codex.exe', false);
    runtime.request = vi.fn(async (method: string) => method === 'initialize' ? { codexHome: initialized }
      : method === 'config/read' ? effective([{ name: { type: 'system', file: path.join(cwd, 'ignored-system.toml') } },
        { name: { type: 'user', file: actualConfig } }]) : { data: [] });
    await runtime.initializeAppServer();
    expect(published.some(files => files.some(file => file.kind === 'codex-auth' && file.path === path.join(initialized, 'auth.json')))).toBe(true);
    expect(published.at(-1)).toEqual(expect.arrayContaining([{ kind: 'codex-config', path: actualConfig }, { kind: 'codex-auth', path: path.join(initialized, 'auth.json') }]));
    expect(published.at(-1)).toHaveLength(2);
    expect(published.flat().some(file => file.path === path.join(cwd, 'ignored-system.toml'))).toBe(false);
    expect(runtime.request).toHaveBeenCalledWith('config/read', { cwd, includeLayers: true });
    await backend.stop(); expect(published.at(-1)).toHaveLength(2);
  });

  it('Codex rejects malformed control-home and user-layer locations without changing the last verified list', async () => {
    const cwd = await root(); const published: SecurityControlArtifactLocation[][] = [];
    const backend = new CodexBackend(config(cwd, 'codex'), undefined, { onControlFiles: files => published.push([...files]) }); backends.push(backend);
    const runtime = backend as any; runtime.publishCodexControlHome(path.join(cwd, 'actual')); const good = published.at(-1);
    for (const home of ['relative-home', '\\\\.\\pipe\\private']) runtime.publishCodexControlHome(home);
    expect(published).toHaveLength(1);
    runtime.request = async () => effective([{ name: { type: 'user', file: 'relative-config.toml' } },
      ...(process.platform === 'win32' ? [{ name: { type: 'user', file: '\\\\.\\pipe\\fixture-config' } }] : [])], 'approve-for-me');
    await runtime.assertEffectiveProcessConfig(); expect(published).toHaveLength(1); expect(published.at(-1)).toEqual(good);
  });
});
