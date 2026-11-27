import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import type { CommandExecResult, CommandExecutionProvider } from '../CommandExecution';
import type { AgentConfig } from '../../types';
import type { LocalMcpTool } from '../../mcp/LocalMcpServer';
import { BASH_SHELL } from './shellFixtures';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function processFixture() {
  const proc = new EventEmitter() as any; proc.pid = 616161; proc.exitCode = null;
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdout.setEncoding = proc.stderr.setEncoding = () => undefined;
  proc.stdin = { writable: true, write: () => true, end: () => undefined }; return proc;
}
async function fixture(options: { allowed?: string[]; mode?: 'none' | 'all'; trusted?: boolean; restrictShell?: boolean;
  result?: CommandExecResult; pendingResult?: Promise<CommandExecResult>; team?: any; start?: boolean; waitForAbort?: boolean } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-s3-claude-command-')));
  const state = { trusted: options.trusted ?? true, acquired: [] as Array<{ signal?: AbortSignal; cwd: string }>, executed: [] as string[], released: 0 };
  const executed = deferred<AbortSignal>();
  const policy = new CommandPolicy(options.mode ?? 'all'); const allowed = new Set(options.allowed ?? ['read', 'write', 'execute']);
  const provider: CommandExecutionProvider = { acquire: async (opts: any) => {
    state.acquired.push(opts); const signal = opts.signal ?? new AbortController().signal;
    return { ok: true, shell: BASH_SHELL, transport: 'direct', environment: {}, signal,
      execute: async (command, _timeout, _continuing, beforeEffect) => {
        const refused = await beforeEffect?.(); if (refused) return { status: 'not-started', code: null, reason: 'disposed', output: refused.message };
        state.executed.push(command); executed.resolve(signal);
        if (options.waitForAbort) return new Promise<CommandExecResult>(resolve => {
          const done = () => resolve({ status: 'not-started', code: null, reason: 'disposed', output: 'Stopped fixture execution.' });
          if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
        });
        return options.pendingResult ?? options.result ?? { status: 'exited', code: 0, output: 'fixture output' };
      }, release: async () => { state.released++; } };
  } };
  const tools = new WorkspaceTools(root, allowed, 'claude-fixture', undefined, policy, 100, undefined, undefined, undefined, provider,
    undefined, undefined, undefined, undefined, undefined, undefined, [], () => state.trusted);
  const config: AgentConfig = { id: 'claude-fixture', name: 'Fixture', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'FIXTURE_ONLY' }, model: 'fixture-model', systemPrompt: '',
    autoApprove: true, allowedTools: [...allowed], backend: 'claude', workingDirectory: root };
  const proc = processFixture();
  const backend = new ClaudeHeadlessBackend(config, undefined, undefined, { hostFileTools: tools, writeRoots: [root], restrictShell: options.restrictShell,
    teamMcpBridge: options.team,
    commandPermission: { policy, isTrusted: () => state.trusted } as any,
    toolGateScriptPath: path.resolve('src/claudeToolGate.cjs'),
    spawn: (() => { setTimeout(() => proc.emit('spawn'), 0); return proc; }) as any,
    terminateProcessTree: async () => { proc.exitCode = 0; proc.emit('exit', 0); return { status: 'confirmed-stopped' }; },
  });
  cleanups.push(async () => { await backend.stop(50); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = backend as any;
  if (options.start) { await backend.start({}, { pin: 'take' }); backend.sendUserTurn('Fixture command turn.'); }
  else runtime.turnBoundaryAbort = new AbortController();
  const bridgeTools = runtime.buildFilesBridgeTools(new WorkspaceTools(root, new Set(['read']))) as LocalMcpTool[];
  const call = (name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) => {
    const tool = bridgeTools.find(tool => tool.name === name); if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.handler(args, { signal });
  };
  return { root, state, policy, allowed, tools, backend, runtime, config, bridgeTools, call, executed };
}
async function bridgeSpec(runtime: any) {
  const config = JSON.parse(await fs.readFile(runtime.mcpConfigPath, 'utf8'));
  return config.mcpServers[runtime.bridgeIds.files] as { url: string; headers: Record<string, string> };
}
function rpc(spec: { url: string; headers: Record<string, string> }, body: unknown): Promise<any> {
  const url = new URL(spec.url); const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: spec.headers.Authorization } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(text);
  });
}

describe('S3 actual Claude files MCP host commands', () => {
  it('delivers the human note over actual MCP while its echoed tool card uses the clean refusal', async () => {
    const h = await fixture({ start: true }); const spec = await bridgeSpec(h.runtime); const note = 'HUMAN-MCP-NOTE "wait for review"';
    h.policy.reload('ask', []); (h.tools as any).requestApproval = async () => ({ allow: false, note, noteOrigin: 'human' });
    const events: unknown[] = []; h.backend.onEvent(event => events.push(event)); const id = 'toolu_mcpdeclinenote';
    const name = `mcp__${h.runtime.bridgeIds.files}__run_command`; const input = { command: 'npm run build' };
    await h.runtime.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_command', arguments: input,
      _meta: { 'claudecode/toolUseId': id } } });
    const text = result.result.content[0].text;
    expect(text).toContain(`The user said: ${JSON.stringify(note)}`); expect(result.result.isError).toBe(true);
    await h.runtime.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] } });
    expect(JSON.stringify(events)).not.toContain('HUMAN-MCP-NOTE'); expect(h.state.executed).toEqual([]);
  });
  it('registers run/check/kill on the real authenticated files bridge and runs through real WorkspaceTools', async () => {
    const h = await fixture({ start: true }); const spec = await bridgeSpec(h.runtime);
    const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const name of ['run_command', 'check_command', 'kill_command']) expect(listed.result.tools.find((tool: any) => tool.name === name)).toBeDefined();
    expect(listed.result.tools.find((tool: any) => tool.name === 'run_command').description).toContain('does not run an action automatically');
    const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'npm run build' } } });
    expect(result.result.isError).toBeFalsy(); expect(result.result.content[0].text).toContain('[exit 0]');
    expect(h.state.executed).toEqual(['npm run build']); expect(h.state.released).toBe(1);
    expect(h.runtime.turnEvidence.verification).toMatchObject({ ran: true, passed: true, source: 'command-exit-zero' });
  });

  it('advertises no commands from a write-only host tool set and keeps the native effect classification', async () => {
    const h = await fixture({ allowed: ['write'] }); expect(h.bridgeTools.map(tool => tool.name)).not.toContain('run_command');
    const full = await fixture({ start: true });
    for (const name of ['run_command', 'check_command', 'kill_command']) expect(full.bridgeTools.filter(tool => tool.name === name)).toHaveLength(1);
    const native = `mcp__${full.runtime.bridgeIds.files}__run_command`;
    expect(full.runtime.isRequestEffect(native, { command: 'npm run build' })).toBe(true);
    expect(full.runtime.isRequestEffect(`mcp__${full.runtime.bridgeIds.files}__kill_command`, { id: 'bg_1' })).toBe(false);
    expect(full.runtime.isRequestEffect(`mcp__${full.runtime.bridgeIds.files}__check_command`, { id: 'bg_1' })).toBe(false);
    const limit = vi.fn(async () => 'stopped'); full.runtime.deps.requestBoundary = limit;
    for (const name of ['kill_command', 'check_command']) {
      expect(await full.runtime.handlePreToolUse({ tool_name: `mcp__${full.runtime.bridgeIds.files}__${name}`,
        tool_use_id: 'toolu_boundcommand', tool_input: { id: 'bg_1' } })).toEqual({ allow: true });
    }
    expect(limit).not.toHaveBeenCalled();
    expect(await full.runtime.handlePreToolUse({ tool_name: native, tool_use_id: 'toolu_boundrun', tool_input: { command: 'npm run build' } }))
      .toMatchObject({ allow: false }); expect(limit).toHaveBeenCalledTimes(1);
  });

  it.each(['plan', 'write-off', 'execute-off', 'command-off', 'trust', 'folder'] as const)('keeps %s at the actual handler with zero command execution', async floor => {
    const h = await fixture({ restrictShell: floor === 'folder' });
    if (floor === 'plan') h.runtime.activeTurnMode = 'plan';
    if (floor === 'write-off') h.config.allowedTools = ['read', 'execute'];
    if (floor === 'execute-off') h.allowed.delete('execute');
    if (floor === 'command-off') h.policy.reload('none', []);
    if (floor === 'trust') h.state.trusted = false;
    const result = await h.call('run_command', { command: 'npm run build' });
    expect(typeof result).toBe('object'); expect(result).toMatchObject({ outcome: { status: 'refused' } });
    expect(h.state.executed).toEqual([]); expect(h.runtime.turnEvidence.verification.ran).toBe(false);
  });

  it('keeps request limits and task write roots through the real host tools', async () => {
    const h = await fixture(); h.tools.setRequestBoundary(async () => 'stopped');
    expect(await h.call('run_command', { command: 'npm run build' })).toMatchObject({ outcome: { status: 'refused' } });
    expect(h.state.acquired).toEqual([]);
    h.tools.setRequestBoundary(undefined); h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [] });
    // v0.9.100 (the Owner): a read-only scope narrows the file tools; a command runs in the agent's own folder.
    expect(await h.call('run_command', { command: 'npm run build' })).toMatchObject({ outcome: { status: 'success' } });
    expect(h.state.executed).toEqual(['npm run build']);
  });

  it('passes the actual call signal to a held request-limit boundary before command preparation', async () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = await fixture(); const entered = deferred<AbortSignal | undefined>(); const answer = deferred<'proceed' | 'stopped'>();
      h.tools.setRequestBoundary(async (_kind, detail) => { entered.resolve(detail?.signal); return answer.promise; });
      const abort = new AbortController(); const pending = h.call('run_command', { command: 'npm run build' }, abort.signal);
      const boundarySignal = await entered.promise; abort.abort();
      try {
        expect(boundarySignal).toBe(abort.signal); expect(boundarySignal?.aborted).toBe(true);
        // The held human answer remains unresolved: cancellation, not a later answer, ends this call.
        expect(await pending).toMatchObject({ outcome: { status: 'refused' } }); expect(h.state.acquired).toEqual([]);
      } finally { answer.resolve('stopped'); await pending; }
    }
  });

  it('checks a filed coordinator contract and retains the existing reminder when no contract is in force', async () => {
    let attempt: unknown = { contractId: 'fixture-contract' }; const verified = vi.fn();
    const team = { hasTeammates: () => true, currentCoordinatorTaskAttempt: () => attempt, canCoordinatorExecute: () => false,
      noteCoordinatorVerificationPassed: verified };
    const h = await fixture({ team });
    expect(await h.call('run_command', { command: 'npm run build' })).toMatchObject({ outcome: { status: 'refused' } });
    expect(h.state.executed).toEqual([]); attempt = undefined;
    const result = await h.call('run_command', { command: 'npm run build' });
    expect(result).toMatchObject({ outcome: { status: 'success' } }); expect(JSON.stringify(result)).toContain('[host reminder]');
    expect(h.state.executed).toEqual(['npm run build']); expect(verified).toHaveBeenCalledTimes(1);
  });

  it.each(['check', 'kill', 'stop'] as const)('a continued command has no exit-zero credit at start and supports %s without replay', async action => {
    const done = deferred<CommandExecResult>(); const stop = vi.fn(async () => { done.resolve({ status: 'exited', code: null, output: 'stopped' }); return { status: 'confirmed-stopped' as const }; });
    const h = await fixture({ result: { status: 'running', code: null, output: 'initial', continuation: { completion: done.promise, output: () => 'fixture progress', stop } } });
    const started = await h.call('run_command', { command: 'npm run build' });
    expect(h.runtime.turnEvidence.verification).toEqual({ ran: false, passed: false });
    const id = /ID: (bg_\d+)/.exec(JSON.stringify(started))?.[1]; expect(id).toBeDefined();
    expect(await h.call('check_command', { id })).toMatchObject({ outcome: { status: 'success' } });
    if (action === 'check') {
      done.resolve({ status: 'exited', code: 0, output: 'complete' }); await Promise.resolve();
      const checked = await h.call('check_command', { id }); expect(JSON.stringify(checked)).toContain('complete');
    } else if (action === 'kill') expect(await h.call('kill_command', { id })).toMatchObject({ outcome: { status: 'success' } });
    else await h.backend.stop();
    expect(stop).toHaveBeenCalledTimes(action === 'check' ? 0 : 1); expect(h.state.executed).toEqual(['npm run build']);
  });

  it('keeps check and kill available in Plan for an already running host command', async () => {
    const done = deferred<CommandExecResult>(); const stop = vi.fn(async () => { done.resolve({ status: 'exited', code: null, output: 'stopped' }); return { status: 'confirmed-stopped' as const }; });
    const h = await fixture({ result: { status: 'running', code: null, output: 'initial', continuation: { completion: done.promise, output: () => 'progress', stop } } });
    const started = await h.call('run_command', { command: 'npm run build' }); const id = /ID: (bg_\d+)/.exec(JSON.stringify(started))![1];
    h.runtime.activeTurnMode = 'plan';
    expect(await h.call('check_command', { id })).toMatchObject({ outcome: { status: 'success' } });
    expect(await h.call('kill_command', { id })).toMatchObject({ outcome: { status: 'success' } });
    expect(stop).toHaveBeenCalledTimes(1); expect(h.state.executed).toEqual(['npm run build']);
  });

  it('Stop aborts the actual MCP call signal through WorkspaceTools into execution and gives no late exit credit', async () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const h = await fixture({ start: true, waitForAbort: true }); const spec = await bridgeSpec(h.runtime);
      const pending = rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'npm run build' } } }).catch(() => undefined);
      const signal = await h.executed.promise; expect(h.state.acquired[0].signal).toBe(signal); expect(signal.aborted).toBe(false);
      await h.backend.stop(50); expect(signal.aborted).toBe(true); await pending;
      expect(h.state.executed).toEqual(['npm run build']); expect(h.state.released).toBe(1);
      expect(h.runtime.turnEvidence.verification).toEqual({ ran: false, passed: false });
    }
  });

  it('a late zero exit after Stop or a replacement turn gives no verification credit to the new turn', async () => {
    for (let iteration = 0; iteration < 25; iteration++) for (const ending of ['stop', 'new-turn']) {
      const reply = deferred<CommandExecResult>(); const h = await fixture({ pendingResult: reply.promise });
      const pending = h.call('run_command', { command: 'npm run build' }); await h.executed.promise;
      if (ending === 'stop') await h.backend.stop();
      else { h.runtime.turnBoundaryAbort.abort(); h.runtime.turnBoundaryAbort = new AbortController(); }
      reply.resolve({ status: 'exited', code: 0, output: 'late success' }); await pending;
      expect(h.runtime.turnEvidence.verification).toEqual({ ran: false, passed: false });
    }
  });
});
