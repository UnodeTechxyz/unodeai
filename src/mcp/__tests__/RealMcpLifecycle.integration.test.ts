import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { MCPHub, type McpServerGrant } from '../MCPHub';
import { createRealMcpClient } from '../RealMcpClient';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CodexBackend, CODEX_CLI_DEFAULT_MODEL } from '../../backend/CodexBackend';
import type { AgentConfig } from '../../types';
import type { LocalMcpTool } from '../LocalMcpServer';

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

  it('drives the production client through Claude\'s loopback handler, including cancellation', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-real-mcp-claude-'));
    const log = path.join(temp, 'calls.jsonl');
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-server.cjs');
    const hub = new MCPHub(createRealMcpClient, () => 'secret-value', 2_000);
    const tools: LocalMcpTool[] = [];
    const local = {
      port: 48123, token: 'test-token',
      addLocalTool(tool: LocalMcpTool) { tools.push(tool); }, addJsonEndpoint() {},
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
        localMcpServerFactory: () => local as any,
        mcp: { hub, grants: () => grants },
      });
      await backend.start({} as NodeJS.ProcessEnv);
      const lookup = tools.find((tool) => tool.name === 'fixture__lookup_code')!;
      const slow = tools.find((tool) => tool.name === 'fixture__slow_echo')!;
      expect(await lookup.handler({ topic: 'claude-route' }, { signal: new AbortController().signal }))
        .toMatchObject({ isError: false, text: expect.stringContaining('claude-route') });

      grants = [];
      expect(await lookup.handler({ topic: 'revoked' }, { signal: new AbortController().signal }))
        .toMatchObject({ isError: true, text: expect.stringMatching(/not granted/i) });
      grants = [grant];
      const controller = new AbortController();
      const pending = slow.handler({ ms: 5_000, text: 'late' }, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      await expect(pending).resolves.toMatchObject({ isError: true, text: expect.stringMatching(/outcome is unknown/i) });
      await backend.stop(50);

      await new Promise((resolve) => setTimeout(resolve, 75));
      const records = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'notifications/cancelled' })]));
    } finally {
      await hub.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(temp, { recursive: true, force: true });
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
        binaryPath: 'C:/tools/codex.exe',
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
