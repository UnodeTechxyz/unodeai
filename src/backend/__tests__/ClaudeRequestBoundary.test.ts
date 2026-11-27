import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend, type ClaudeHeadlessBackendDeps } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import type { LocalJsonEndpoint, LocalMcpServer, LocalMcpTool } from '../../mcp/LocalMcpServer';
import type { TeamMcpBridge } from '../../mcp/TeamMcpBridge';
import { MessageBus } from '../../bus/MessageBus';
import { CommandPolicy } from '../CommandPolicy';
import { REQUEST_LIMIT_STOPPED_REFUSAL, type RequestBoundary, type RequestBoundaryDetail, type RequestBoundaryOutcome } from '../requestBoundary';

/* v0.9.94: the request limit boundary on the Claude CLI route. The CLI's own model requests cannot be held, so
   the boundary is asked where the host decides: at the PreToolUse hook and in the bridges the host serves. */

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'pm', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true,
    allowedTools: ['read', 'write', 'execute'], backend: 'claude', workingDirectory: process.cwd(),
    ...overrides,
  };
}

type FakeServer = LocalMcpServer & { localTools: LocalMcpTool[]; jsonEndpoints: LocalJsonEndpoint[] };

function fakeLocalServer(): FakeServer {
  return {
    port: 48123,
    token: 'test-token',
    localTools: [],
    jsonEndpoints: [],
    addLocalTool(tool) { this.localTools.push(tool); },
    addJsonEndpoint(endpoint) { this.jsonEndpoints.push(endpoint); },
    observeToolOutcomes() { /* the tests read the handler's own result */ },
    async start() { /* nothing listens */ },
    async stop() { /* nothing to close */ },
  } as FakeServer;
}

function fakeSpawn() {
  return (_command: string, _args: string[]) => {
    const proc = new EventEmitter() as any;
    proc.pid = 1234;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
}

interface Asked {
  kind: string;
  detail?: RequestBoundaryDetail;
  answer(outcome: RequestBoundaryOutcome): void;
}

function heldBoundary() {
  const asked: Asked[] = [];
  const boundary: RequestBoundary = (kind, detail) => new Promise((resolve) => {
    asked.push({ kind, detail, answer: resolve });
  });
  return { boundary, asked };
}

async function seen<T>(promise: Promise<T>): Promise<T | 'held'> {
  return Promise.race([promise, new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 20))]);
}

const stopping: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stopping.splice(0)) await stop();
});

async function started(deps: ClaudeHeadlessBackendDeps, overrides: Partial<AgentConfig> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-boundary-'));
  const gate = fakeLocalServer();
  const bridges: FakeServer[] = [];
  const backend = new ClaudeHeadlessBackend(config({ workingDirectory: dir, ...overrides }), undefined, undefined, {
    spawn: fakeSpawn() as any,
    toolGateServerFactory: () => gate,
    toolBridgeServerFactory: () => { const server = fakeLocalServer(); bridges.push(server); return server; },
    localMcpServerFactory: () => fakeLocalServer(),
    teamMcpBridge: {} as TeamMcpBridge,
    messageBus: new MessageBus(),
    commandPermission: { policy: new CommandPolicy('all') },
    requestToolApproval: async () => ({ allow: true }),
    webAccess: { policy: () => 'allow', requestApproval: async () => ({ allow: true }) },
    ...deps,
  });
  stopping.push(async () => {
    await backend.stop(50);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  const route = gate.jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
  const hook = (tool_name: string, tool_input: Record<string, unknown> = {}, tool_use_id?: string) =>
    route.handler({ tool_name, tool_input, ...(tool_use_id ? { tool_use_id } : {}) }) as Promise<{ allow: boolean; reason?: string }>;
  /** The CLI's own name of a tool one of this backend's bridges serves. */
  const served = (suffix: string): string => {
    const name = ((backend as any).localMcpToolNames() as string[]).find((candidate) => candidate.endsWith(`__${suffix}`));
    expect(name, suffix).toBeTruthy();
    return name!;
  };
  const bridgeTool = (name: string): LocalMcpTool => bridges.flatMap((server) => server.localTools).find((tool) => tool.name === name)!;
  return { backend, events, hook, served, bridgeTool };
}

describe('Claude request boundary at the PreToolUse hook', () => {
  it('asks before a command, before its approval is asked for, and approves nothing while the answer is pending', async () => {
    const { boundary, asked } = heldBoundary();
    const approvals: string[] = [];
    const { hook } = await started({
      requestBoundary: boundary,
      commandPermission: {
        policy: new CommandPolicy('ask'),
        requestApproval: async (command) => { approvals.push(command); return { allow: true }; },
      },
    });
    const pending = hook('Bash', { command: 'npm test' }, 'toolu_1');
    expect(await seen(pending)).toBe('held');
    expect(asked.map(({ kind, detail }) => ({ kind, tool: detail?.tool }))).toEqual([{ kind: 'effect', tool: 'Bash' }]);
    expect(approvals).toEqual([]);

    asked[0].answer('proceed');
    expect(await pending).toMatchObject({ allow: true });
    expect(approvals).toEqual(['npm test']);
    expect(asked).toHaveLength(1);
  });

  it('refuses the call with the typed safety-limit refusal when the person stops the request', async () => {
    const approvals: string[] = [];
    const { backend, events, hook } = await started({
      requestBoundary: async () => 'stopped',
      commandPermission: {
        policy: new CommandPolicy('ask'),
        requestApproval: async (command) => { approvals.push(command); return { allow: true }; },
      },
    });
    (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_stop', name: 'Bash', input: { command: 'npm test' } }] } });
    expect(await hook('Bash', { command: 'npm test' }, 'toolu_stop')).toEqual({ allow: false, reason: REQUEST_LIMIT_STOPPED_REFUSAL });
    expect(approvals).toEqual([]);
    (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: 'denied', is_error: true }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The call's result is the host's refusal, whatever the CLI wrote about it.
    expect(events.find((event) => event.kind === 'tool_result')?.outcome)
      .toEqual({ status: 'refused', observedBy: 'host', reason: 'safety-limit' });
  });

  it('asks for every call that acts and for no local read', async () => {
    const asked: string[] = [];
    const { hook, served } = await started(
      {
        requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'proceed'; },
        mcp: {
          hub: {
            getToolSpecs: () => [{ type: 'function', function: { name: 'docs__lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } } }],
            executeTool: async () => ({ source: 'host', contentSource: 'host', status: 'success', output: 'ok' }),
          },
          grants: [{ serverId: 'docs', toolFilter: 'all' }],
        } as any,
        executableSkills: {
          toolSpec: () => ({ type: 'function', function: { name: 'run_skill_action', description: 'Action.', parameters: { type: 'object', properties: {} } } }),
          run: async () => ({ source: 'host', contentSource: 'host', status: 'success', output: 'ok' }),
        } as any,
      },
    );

    // Local reads, the host's read-only bridge tools, and the team tools that read, record or close out.
    for (const [tool, input] of [
      ['Read', { file_path: 'a.txt' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Grep', { pattern: 'x' }],
      ['ToolSearch', { query: 'x' }],
      ['TaskStop', { id: 't' }],
      [served('read_file'), { path: 'a.txt' }],
      [served('search_files'), { query: 'x' }],
      [served('search_conversation_log'), { query: 'x' }],
      [served('list_agents'), {}],
      [served('collect_ready_tasks'), {}],
      [served('close_assignment'), { outcome: 'blocked', summary: 's' }],
      [served('record_task_disposition'), { handle: 'h', disposition: 'accepted' }],
    ] as const) {
      expect(await hook(tool, input), tool).toMatchObject({ allow: true });
    }
    expect(asked).toEqual([]);

    const acting: Array<[string, Record<string, unknown>]> = [
      ['Bash', { command: 'npm test' }],
      ['Write', { file_path: 'a.txt', content: 'x' }],
      ['Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['WebSearch', { query: 'x' }],
      // A native subagent is dispatched work, and a tool the host does not know may act.
      ['Agent', { prompt: 'do it' }],
      ['SendMessage', { to: 'x' }],
      ['FutureClaudeTool', {}],
      ['mcp__user_server__create_issue', {}],
      [served('dispatch_task'), { agent: 'dev' }],
      [served('broadcast'), { message: 'x' }],
      [served('run_checks'), {}],
      [served('record_task_disposition'), { handle: 'h', disposition: 'needs-rework', reason: 'r' }],
      [served('docs__lookup'), { query: 'x' }],
      [served('run_skill_action'), { name: 'audit' }],
    ];
    for (const [tool, input] of acting) expect(await hook(tool, input), tool).toMatchObject({ allow: true });
    expect(asked).toEqual(acting.map(([tool]) => tool));
  });

  it('denies a call for a reason that needs nobody before it asks about the limit', async () => {
    const asked: string[] = [];
    // No execute capability: the shell tools are removed from this agent.
    const { hook } = await started(
      { requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'proceed'; } },
      { allowedTools: ['read', 'write'] },
    );
    expect(await hook('Bash', { command: 'npm test' })).toMatchObject({ allow: false });
    expect(asked).toEqual([]);
  });

  it('treats a boundary that answers at once as no wait at all, and a held one as a wait for the person', async () => {
    const immediate = await started({ requestBoundary: async () => 'proceed' });
    const quiet = vi.spyOn(immediate.backend as any, 'noteMaterialOutput');
    expect(await immediate.hook('Write', { file_path: 'a.txt', content: 'x' })).toMatchObject({ allow: true });
    expect(quiet).not.toHaveBeenCalled();

    const { boundary, asked } = heldBoundary();
    const held = await started({ requestBoundary: boundary });
    const waiting = vi.spyOn(held.backend as any, 'noteMaterialOutput');
    const pending = held.hook('Write', { file_path: 'a.txt', content: 'x' });
    expect(await seen(pending)).toBe('held');
    // Like a pending approval: the wait holds the watchdog instead of reading as a silent CLI.
    expect(waiting).toHaveBeenCalledTimes(1);
    asked[0].answer('proceed');
    expect(await pending).toMatchObject({ allow: true });
  });

  it('answers the hook when nobody decides within the human window, and runs nothing', async () => {
    const { boundary, asked } = heldBoundary();
    const { backend, events, hook } = await started({
      requestBoundary: boundary,
      humanApprovalTimeoutMs: 60,
      approvalTimerGraceMs: 0,
    });
    (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_late', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }] } });
    const answer = await hook('Write', { file_path: 'a.txt', content: 'x' }, 'toolu_late');
    expect(answer.allow).toBe(false);
    expect(answer.reason).toMatch(/nobody decided within 1 minutes/);
    expect(asked).toHaveLength(1);
    (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_late', content: 'denied', is_error: true }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.find((event) => event.kind === 'tool_result')?.outcome)
      .toEqual({ status: 'refused', observedBy: 'host', reason: 'safety-limit' });
  });

  it('releases a held call when the agent is stopped, and tells the host through the signal', async () => {
    const { boundary, asked } = heldBoundary();
    const { backend, hook } = await started({ requestBoundary: boundary });
    backend.sendUserTurn('go');
    const pending = hook('Write', { file_path: 'a.txt', content: 'x' });
    expect(await seen(pending)).toBe('held');
    expect(asked[0].detail?.signal?.aborted).toBe(false);
    await backend.stop(50);
    expect(await pending).toEqual({ allow: false, reason: REQUEST_LIMIT_STOPPED_REFUSAL });
    expect(asked[0].detail?.signal?.aborted).toBe(true);
  });

  it('releases a held call as soon as Stop is asked for, without waiting for the process to exit', async () => {
    const { boundary } = heldBoundary();
    let exited = false;
    // A process that takes a while to die after it is signalled.
    const slowToExit = (_command: string, _args: string[]) => {
      const proc = fakeSpawn()(_command, _args);
      proc.kill = () => {
        setTimeout(() => { exited = true; proc.exitCode = 0; proc.emit('exit', 0); }, 40);
        return true;
      };
      return proc;
    };
    const { backend, hook } = await started({ requestBoundary: boundary, spawn: slowToExit as any });
    backend.sendUserTurn('go');
    const pending = hook('Write', { file_path: 'a.txt', content: 'x' });
    expect(await seen(pending)).toBe('held');
    const stopped = backend.stop(5000);
    expect(await pending).toEqual({ allow: false, reason: REQUEST_LIMIT_STOPPED_REFUSAL });
    expect(exited).toBe(false);
    await stopped;
    expect(exited).toBe(true);
  });

  it('gives each turn its own stop signal, and ends it when the turn completes', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const { backend, hook } = await started({ requestBoundary: async (_kind, detail) => { signals.push(detail?.signal); return 'proceed'; } });
    backend.sendUserTurn('first');
    await hook('Write', { file_path: 'a.txt', content: 'x' });
    expect(signals[0]?.aborted).toBe(false);
    (backend as any).emitTurnComplete({ text: 'done', isError: false });
    // The turn is over, so nothing of it can still be held, whether or not another turn follows.
    expect(signals[0]?.aborted).toBe(true);
    backend.sendUserTurn('second');
    await hook('Write', { file_path: 'a.txt', content: 'x' });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('changes no decision when no boundary is injected', async () => {
    const { hook } = await started({});
    expect(await hook('Write', { file_path: 'a.txt', content: 'x' })).toMatchObject({ allow: true });
    expect(await hook('Read', { file_path: 'a.txt' })).toMatchObject({ allow: true });
  });
});

describe('Claude request boundary in the bridges the host serves', () => {
  function integrations(calls: string[]) {
    return {
      hub: {
        getToolSpecs: () => [{ type: 'function', function: { name: 'docs__lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } } }],
        executeTool: async (name: string) => { calls.push(name); return { source: 'host', contentSource: 'mixed-external', status: 'success', output: 'managed result' }; },
      },
      grants: [{ serverId: 'docs', toolFilter: 'all' }],
    } as any;
  }
  function skills(calls: string[]) {
    return {
      toolSpec: () => ({ type: 'function', function: { name: 'run_skill_action', description: 'Action.', parameters: { type: 'object', properties: {} } } }),
      run: async () => { calls.push('run_skill_action'); return { source: 'host', contentSource: 'host', status: 'success', output: 'approved receipt' }; },
    } as any;
  }
  const context = { signal: new AbortController().signal };

  it('holds an integration call and a Skill action until the answer, and runs them after Continue', async () => {
    const calls: string[] = [];
    const { boundary, asked } = heldBoundary();
    const { bridgeTool } = await started({ requestBoundary: boundary, mcp: integrations(calls), executableSkills: skills(calls) });
    for (const name of ['docs__lookup', 'run_skill_action']) {
      const before = calls.length;
      const running = bridgeTool(name).handler({}, context);
      expect(await seen(running)).toBe('held');
      expect(asked.at(-1)).toMatchObject({ kind: 'effect', detail: { tool: name } });
      expect(calls).toHaveLength(before);
      asked.at(-1)!.answer('proceed');
      expect(await running).toMatchObject({ outcome: { status: 'success' } });
      expect(calls.at(-1)).toBe(name);
    }
    expect(asked).toHaveLength(2);
  });

  it('refuses both with the typed safety-limit refusal after Stop, and runs neither', async () => {
    const calls: string[] = [];
    const { bridgeTool } = await started({ requestBoundary: async () => 'stopped', mcp: integrations(calls), executableSkills: skills(calls) });
    for (const name of ['docs__lookup', 'run_skill_action']) {
      expect(await bridgeTool(name).handler({}, context)).toEqual({
        text: REQUEST_LIMIT_STOPPED_REFUSAL,
        outcome: { source: 'host', contentSource: 'host', status: 'refused', reason: 'safety-limit', output: REQUEST_LIMIT_STOPPED_REFUSAL },
      });
    }
    expect(calls).toEqual([]);
  });

  it('keeps the earlier refusals of a bridge call ahead of the limit', async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    const { backend, bridgeTool } = await started({
      requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; },
      mcp: integrations(calls),
      executableSkills: skills(calls),
      commandPermission: { policy: new CommandPolicy('all'), isTrusted: () => false },
    });
    expect(await bridgeTool('docs__lookup').handler({}, context)).toMatchObject({ outcome: { status: 'refused', reason: 'trust' } });
    backend.sendUserTurn('plan only', { mode: 'plan' });
    expect(await bridgeTool('run_skill_action').handler({}, context)).toMatchObject({ outcome: { status: 'refused', reason: 'capability' } });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});
