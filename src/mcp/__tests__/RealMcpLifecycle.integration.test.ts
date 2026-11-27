import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MCPHub, type McpServerGrant } from '../MCPHub';
import { createRealMcpClient } from '../RealMcpClient';
import { testMcpConnection } from '../McpConnectionTest';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../../backend/CodexBackend';
import type { AgentConfig } from '../../types';
import type { LocalMcpTool } from '../LocalMcpServer';
import { fixedCodexProgram } from '../../backend/__tests__/codexProgramFixture';

const grant: McpServerGrant = { serverId: 'fixture', toolFilter: 'all' };

function fixtureConfig(fixture: string, log: string) {
  return {
    id: 'fixture', name: 'Fixture', transport: 'stdio' as const, command: process.execPath,
    args: [fixture], env: { UNODE_MCP_FIXTURE_LOG: log, UNODE_MCP_FIXTURE_TOKEN: '${FIXTURE_TOKEN}' },
  };
}

function agent(backend: 'claude-headless' | 'codex'): AgentConfig {
  return {
    id: `${backend}-fixture`, name: 'Fixture agent', role: 'developer', skill: '',
    provider: { providerId: backend === 'codex' ? 'codex' : 'anthropic', apiKeySecretName: 'unused' },
    model: backend === 'codex' ? CODEX_CLI_DEFAULT_MODEL : 'claude-test', systemPrompt: 'Use the fixture.',
    allowedTools: ['read', 'write', 'execute'], autoApprove: true, backend,
    workingDirectory: process.cwd(),
  };
}

describe('real MCP client lifecycle', () => {
  it('Test enumerates only and never replaces live clients', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-mcp-test-'));
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const liveLog = path.join(temp, 'live.jsonl');
    const testLog = path.join(temp, 'test.jsonl');
    const hub = new MCPHub(createRealMcpClient, () => 'fixture-secret');
    const config = fixtureConfig(fixture, liveLog);
    try {
      await hub.register(config);
      const testConfig = fixtureConfig(fixture, testLog);
      await expect(testMcpConnection(testConfig, () => 'fixture-secret', new AbortController().signal)).resolves.toBe(3);
      const testMethods = (await fs.readFile(testLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
      expect(testMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      await expect(hub.executeTool('fixture__lookup_code', { topic: 'still live' }, [grant]))
        .resolves.toMatchObject({ status: 'success' });
      expect((await fs.readFile(liveLog, 'utf8')).match(/"method":"initialize"/g)).toHaveLength(1);
      await expect(testMcpConnection({ ...testConfig, env: { ...testConfig.env, UNODE_MCP_FIXTURE_MODE: 'empty-list' } },
        () => 'fixture-secret', new AbortController().signal)).resolves.toBe(0);
      await expect(testMcpConnection({ ...testConfig, env: { ...testConfig.env, UNODE_MCP_FIXTURE_MODE: 'refuse-list' } },
        () => 'fixture-secret', new AbortController().signal)).rejects.toThrow('Listing tools failed');
    } finally {
      await hub.stopAll();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('cancel during hung initialize leaves no test child or descendant', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-mcp-hung-test-'));
    const log = path.join(temp, 'test.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const baseConfig = fixtureConfig(fixture, log);
    const config = { ...baseConfig, env: { ...baseConfig.env, UNODE_MCP_FIXTURE_MODE: 'hang-initialize' } };
    const controller = new AbortController();
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch { return false; }
    };
    const run = testMcpConnection(config, () => 'fixture-secret', controller.signal);
    const stopped = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    let event: { pid: number; childPid: number } | undefined;
    try {
      await expect.poll(async () => {
        const trace = await fs.readFile(log, 'utf8').catch(() => '');
        if (trace.trim()) event = JSON.parse(trace.trim());
        return event?.childPid;
      }).toBeGreaterThan(0);
      controller.abort();
      await stopped;
      await expect.poll(() => alive(event!.pid) || alive(event!.childPid), { timeout: 5_000 }).toBe(false);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('Test ends a hung list at its own SDK phase deadline', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-mcp-test-deadline-'));
    const log = path.join(temp, 'deadline.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const saved = fixtureConfig(fixture, log);
    const deadline = new AbortController();
    const phase = vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => new AbortController().signal)
      .mockImplementationOnce(() => deadline.signal);
    const controller = new AbortController();
    const tested = testMcpConnection({ ...saved, args: [fixture, 'hang-list'] }, () => 'fixture-secret', controller.signal);
    const failed = expect(tested).rejects.toThrow('Listing tools failed');
    try {
      await expect.poll(async () => (await fs.readFile(log, 'utf8').catch(() => '')).includes('"method":"tools/list"')).toBe(true);
      deadline.abort(new Error('The operation timed out'));
      await failed;
      expect(phase.mock.calls.slice(0, 2)).toEqual([[60_000], [60_000]]);
    } finally {
      controller.abort();
      await tested.catch(() => undefined);
      phase.mockRestore();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('connects, resolves a secret, calls, revokes, forwards cancellation and quarantines', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-real-mcp-'));
    const log = path.join(temp, 'calls.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const hub = new MCPHub(createRealMcpClient, (name) => name === 'FIXTURE_TOKEN' ? 'secret-value' : undefined, 2_000);
    try {
      await hub.register(fixtureConfig(fixture, log));
      expect(hub.getToolSpecs([grant]).map((tool) => tool.function.name)).toEqual([
        'fixture__lookup_code', 'fixture__token_status', 'fixture__slow_echo',
      ]);

      const token = await hub.executeTool('fixture__token_status', {}, [grant]);
      expect(token).toMatchObject({ status: 'success' });
      const tokenStatus = JSON.parse(token.output);
      expect(tokenStatus).toEqual({ present: true, length: 12 });
      expect(token.output).not.toContain('secret-value');

      const revoked = await hub.executeTool('fixture__lookup_code', { topic: 'x' }, []);
      expect(revoked).toMatchObject({ status: 'refused', reason: 'consent' });

      const controller = new AbortController();
      const slow = hub.executeTool('fixture__slow_echo', { ms: 5_000, text: 'late' }, [grant], controller.signal);
      setTimeout(() => controller.abort(), 30);
      await expect(slow).resolves.toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
      await expect(hub.executeTool('fixture__lookup_code', { topic: 'after-reconnect' }, [grant]))
        .resolves.toMatchObject({ status: 'success', output: expect.stringContaining('after-reconnect') });
      expect(hub.isRegistered('fixture')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const records = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'tools/call', tool: 'token_status' }),
        expect.objectContaining({ method: 'tools/call', tool: 'slow_echo' }),
        expect.objectContaining({ method: 'notifications/cancelled' }),
      ]));
    } finally {
      await hub.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 15_000);

  // v0.9.99: the MCP SDK's own 60-second request default no longer ends a slow call. The SDK's timer runs on a fake
  // clock moved past 60 s while the real fixture is still working; the call then completes with the server's answer.
  it('a real SDK call is not ended by the SDK\'s 60-second default', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-real-mcp-deadline-'));
    const log = path.join(temp, 'calls.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const hub = new MCPHub(createRealMcpClient, (name) => name === 'FIXTURE_TOKEN' ? 'secret-value' : undefined);
    try {
      await hub.register(fixtureConfig(fixture, log));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const slow = hub.executeTool('fixture__slow_echo', { ms: 400, text: 'answered late' }, [grant]);
      await vi.advanceTimersByTimeAsync(61_000);
      vi.useRealTimers();
      await expect(slow).resolves.toMatchObject({ status: 'success', output: expect.stringContaining('answered late') });
      expect(hub.isRegistered('fixture')).toBe(true);
    } finally {
      vi.useRealTimers();
      await hub.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 15_000);

  it('drives the production client through Claude\'s loopback handler, including cancellation', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-real-mcp-claude-'));
    const log = path.join(temp, 'calls.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const hub = new MCPHub(createRealMcpClient, () => 'secret-value', 2_000);
    const tools: LocalMcpTool[] = [];
    const local = {
      port: 48123, token: 'test-token',
      addLocalTool(tool: LocalMcpTool) { tools.push(tool); }, addJsonEndpoint() {}, observeToolOutcomes() {},
      async start() {}, async stop() {},
    };
    const spawn = () => {
      const proc = new EventEmitter() as any;
      proc.pid = 1234; proc.exitCode = null;
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => undefined; proc.stderr.setEncoding = () => undefined;
      proc.stdin = { write: () => true, end: () => undefined };
      proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
      queueMicrotask(() => proc.emit('spawn'));
      return proc;
    };
    let grants: McpServerGrant[] = [grant];
    try {
      await hub.register(fixtureConfig(fixture, log));
      const backend = new ClaudeHeadlessBackend(agent('claude-headless'), undefined, undefined, {
        spawn: spawn as any,
        toolBridgeServerFactory: () => local as any,
        mcp: { hub, grants: () => grants },
      });
      await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
      const lookup = tools.find((tool) => tool.name === 'fixture__lookup_code')!;
      const slow = tools.find((tool) => tool.name === 'fixture__slow_echo')!;
      // The Hub's typed outcome reaches the loopback server, which decides isError and reports the fact.
      expect(await lookup.handler({ topic: 'claude-route' }, { signal: new AbortController().signal }))
        .toMatchObject({ outcome: { status: 'success' }, text: expect.stringContaining('claude-route') });

      grants = [];
      expect(await lookup.handler({ topic: 'revoked' }, { signal: new AbortController().signal }))
        .toMatchObject({ outcome: { status: 'refused', reason: 'consent' }, text: expect.stringMatching(/not granted/i) });
      grants = [grant];
      const controller = new AbortController();
      const pending = slow.handler({ ms: 5_000, text: 'late' }, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        outcome: { status: 'failed', failureKind: 'outcome_unknown' },
        text: expect.stringMatching(/outcome is unknown/i),
      });
      await backend.stop(50);

      await new Promise((resolve) => setTimeout(resolve, 75));
      const records = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'notifications/cancelled' })]));
    } finally {
      await hub.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A cancelled call's in-flight recovery can finish writing its fixture log while the stale client closes.
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it('drives the production client through Codex\'s dynamic-tool handler with live revocation', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-real-mcp-codex-'));
    const log = path.join(temp, 'calls.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const hub = new MCPHub(createRealMcpClient, () => 'secret-value', 2_000);
    let grants: McpServerGrant[] = [grant];
    try {
      await hub.register(fixtureConfig(fixture, log));
      const backend = new CodexBackend(agent('codex'), undefined, {
        launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
        access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [process.cwd()] }),
        mcp: { hub, grants: () => grants },
      });
      (backend as any).threadId = 'thread-fixture';
      (backend as any).turnId = 'turn-fixture';
      (backend as any).managedToolAbortController = new AbortController();
      const call = (tool: string, args: Record<string, unknown>, callId: string) => (backend as any).dynamicToolCall({
        threadId: 'thread-fixture', turnId: 'turn-fixture', callId, namespace: null, tool, arguments: args,
      });

      await expect(call('fixture__lookup_code', { topic: 'codex-route' }, 'call-1')).resolves.toMatchObject({
        success: true,
        contentItems: [expect.objectContaining({ text: expect.stringContaining('codex-route') })],
      });
      grants = [];
      await expect(call('fixture__lookup_code', { topic: 'revoked' }, 'call-2')).resolves.toMatchObject({ success: false });
      const records = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records.filter((record) => record.tool === 'lookup_code')).toHaveLength(1);
    } finally {
      await hub.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
