import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { createLocalMcpServer, LocalMcpServer } from '../LocalMcpServer';
import { TeamMcpBridge, TeamToolset } from '../TeamMcpBridge';
import { ToolSpec } from '../../backend/WorkspaceTools';

let servers: LocalMcpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

function fakeTeam(): TeamToolset {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'list_agents', description: 'List agents', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'assign_task', description: 'Assign task', parameters: { type: 'object', properties: { agent: { type: 'string' } } } } },
    { type: 'function', function: { name: 'broadcast', description: 'Broadcast', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'run_checks', description: 'Run checks', parameters: { type: 'object', properties: {} } } },
  ];
  return {
    specs: () => specs,
    has: (name) => specs.some((s) => s.function.name === name),
    run: async (name, args) => `${name}:${JSON.stringify(args)}`,
  };
}

async function start(): Promise<LocalMcpServer> {
  const server = createLocalMcpServer();
  await server.start(new TeamMcpBridge(fakeTeam()));
  servers.push(server);
  return server;
}

describe('LocalMcpServer', () => {
  it('starts on a loopback random port', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[a-f0-9]{32}$/);
  });

  it('tools/list returns team bridge tool definitions', async () => {
    const server = await start();
    const res = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(200);
    expect(res.body.result.tools.map((t: any) => t.name)).toEqual([
      'list_agents',
      'assign_task',
      'broadcast',
      'run_checks',
    ]);
  });

  it('tools/call routes through the team bridge', async () => {
    const server = await start();
    const res = await rpc(server, {
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'list_agents', arguments: { verbose: true } },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.content[0]).toEqual({ type: 'text', text: 'list_agents:{"verbose":true}' });
  });

  it('rejects requests without the bearer token', async () => {
    const server = await start();
    const res = await post(server.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined);

    expect(res.status).toBe(401);
  });

  it('serves a registered JSON endpoint only with the same bearer token', async () => {
    const server = createLocalMcpServer();
    server.addJsonEndpoint({
      path: '/gate',
      handler: async (body) => ({ allow: body.tool_name === 'Read' }),
    });
    await server.start();
    servers.push(server);

    const denied = await post(server.port, { tool_name: 'Read' }, undefined, '/gate');
    expect(denied.status).toBe(401);
    const allowed = await post(server.port, { tool_name: 'Read' }, server.token, '/gate');
    expect(allowed).toEqual({ status: 200, body: { allow: true } });
  });

  it('rejects oversized authenticated request bodies', async () => {
    const server = await start();
    const res = await post(server.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_agents', arguments: { padding: 'x'.repeat(70 * 1024) } },
    }, server.token);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad request');
  });

  it('releases the port on stop', async () => {
    const server = await start();
    const port = server.port;
    await server.stop();

    await expect(canListen(port)).resolves.toBe(true);
  });

  it('closes the team bridge on stop', async () => {
    const server = createLocalMcpServer();
    let cancelReason = '';
    await server.start(new TeamMcpBridge({
      ...fakeTeam(),
      cancelPending: (reason) => {
        cancelReason = reason ?? '';
        return 1;
      },
    }));
    servers.push(server);

    await server.stop();

    expect(cancelReason).toMatch(/bridge shutdown/);
  });

  // Permission-only server: a teammate (no team bridge) still hosts the claude permission-prompt tool.
  it('serves a local tool with no bridge (permission-prompt server)', async () => {
    const server = createLocalMcpServer();
    let received: Record<string, unknown> | undefined;
    server.addLocalTool({
      name: 'permission_prompt',
      description: 'gate',
      inputSchema: { type: 'object' },
      handler: async (args) => { received = args; return JSON.stringify({ behavior: 'allow', updatedInput: args.input }); },
    });
    await server.start(); // NB: no bridge
    servers.push(server);

    const list = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(['permission_prompt']);

    const call = await rpc(server, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } },
    });
    expect(received).toEqual({ tool_name: 'Bash', input: { command: 'npm test' } });
    expect(JSON.parse(call.body.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
  });

  it('lists local tools before bridge tools and routes calls to the right one', async () => {
    const server = createLocalMcpServer();
    server.addLocalTool({ name: 'permission_prompt', description: 'gate', inputSchema: { type: 'object' }, handler: async () => 'LOCAL' });
    await server.start(new TeamMcpBridge(fakeTeam()));
    servers.push(server);

    const list = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(['permission_prompt', 'list_agents', 'assign_task', 'broadcast', 'run_checks']);

    const local = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permission_prompt', arguments: {} } });
    expect(local.body.result.content[0].text).toBe('LOCAL');
    const bridged = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
    expect(bridged.body.result.content[0].text).toBe('list_agents:{}');
  });
});

function rpc(server: LocalMcpServer, body: unknown): Promise<{ status: number; body: any }> {
  return post(server.port, body, server.token);
}

function post(port: number, body: unknown, token: string | undefined, endpoint = '/mcp'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : undefined }));
      }
    );
    req.on('error', reject);
    req.end(text);
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Bare HTTP request with an arbitrary method — needed to exercise claude's SSE-stream probe (GET /mcp). */
function request(port: number, method: string, token: string | undefined): Promise<{ status: number; headers: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); }
    );
    req.on('error', reject);
    req.end();
  });
}

// Regression: claude 2.1.x could not use ANY of our local MCP bridges (permission gate, team bridge,
// read-only files bridge). Two transport gaps, both proven live against claude 2.1.206:
//   1. `initialize` was unimplemented -> the handshake errored -> "Available MCP tools: none".
//   2. GET /mcp answered 404 -> the Streamable HTTP client treated the missing SSE stream as a fatal
//      transport error and dropped the connection ("Failed to open SSE stream: Not Found").
// The visible symptom was a hung Claude turn: `--permission-prompt-tool ... not found`.
describe('LocalMcpServer speaks enough MCP Streamable HTTP for real clients', () => {
  it('implements the initialize handshake for the supported protocol version', async () => {
    const server = await start();
    const res = await rpc(server, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe('unodeai-local-mcp');
  });

  it('returns its supported version rather than claiming an unsupported client version', async () => {
    const server = await start();
    const res = await rpc(server, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers GET /mcp with 405 (no SSE stream offered), never 404', async () => {
    const server = await start();
    const res = await request(server.port, 'GET', server.token);
    // 404 makes the MCP client drop the whole connection; 405 tells it to proceed without an SSE stream.
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('answers DELETE /mcp with 405 rather than dropping the session', async () => {
    const server = await start();
    expect((await request(server.port, 'DELETE', server.token)).status).toBe(405);
  });

  it('still rejects unauthenticated requests on any method', async () => {
    const server = await start();
    expect((await request(server.port, 'GET', undefined)).status).toBe(401);
  });

  it('acknowledges notifications with 202 and no JSON-RPC body', async () => {
    const server = await start();
    const res = await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });
});
