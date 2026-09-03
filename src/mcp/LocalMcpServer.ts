import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { TeamMcpBridge } from './TeamMcpBridge';

/** An in-process tool the local server hosts directly (not via the team bridge), e.g. the claude
 *  permission-prompt tool. handler returns the tool-result text. */
export interface LocalMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** A small authenticated JSON endpoint hosted beside the local MCP endpoint.  It is used by the
 * Claude PreToolUse hook: the hook is a separate node process, so it needs a loopback callback that
 * shares the same random bearer token and lifecycle as the agent's local MCP bridge. */
export interface LocalJsonEndpoint {
  /** Exact loopback path, for example `/gate`. `/mcp` is reserved for MCP transport. */
  path: string;
  /** Receives a JSON object and returns the JSON response body. Throwing returns HTTP 500. */
  handler: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * Optional streaming form for a long-lived, authenticated loopback decision. The handler owns the
   * successful response (including headers and end); throwing before headers produces HTTP 500.
   */
  streamHandler?: (body: Record<string, unknown>, response: http.ServerResponse) => Promise<void>;
}

export interface LocalMcpServer {
  readonly port: number;
  readonly token: string;
  /** Bridge is optional: a permission-only server hosts just its local tools, no team bridge. */
  start(bridge?: TeamMcpBridge): Promise<void>;
  stop(): Promise<void>;
  /** Register an in-process tool, served alongside any bridge tools. Call before/after start. */
  addLocalTool(tool: LocalMcpTool): void;
  /** Register an authenticated JSON endpoint on this server. Call before/after start. */
  addJsonEndpoint(endpoint: LocalJsonEndpoint): void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

const LOOPBACK_HOST = '127.0.0.1';
const MAX_LISTEN_ATTEMPTS = 3;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Fallback when a client omits protocolVersion on `initialize`. */
const SUPPORTED_MCP_PROTOCOL_VERSION = '2025-06-18';

class HttpLocalMcpServer implements LocalMcpServer {
  private server: http.Server | undefined;
  private bridge: TeamMcpBridge | undefined;
  private localTools = new Map<string, LocalMcpTool>();
  private jsonEndpoints = new Map<string, LocalJsonEndpoint>();
  private _port = 0;
  readonly token = crypto.randomBytes(16).toString('hex');

  get port(): number {
    return this._port;
  }

  addLocalTool(tool: LocalMcpTool): void {
    this.localTools.set(tool.name, tool);
  }

  addJsonEndpoint(endpoint: LocalJsonEndpoint): void {
    if (!endpoint.path.startsWith('/') || endpoint.path === '/mcp' || endpoint.path.includes('?')) {
      throw new Error('Local JSON endpoint paths must be absolute, query-free, and distinct from /mcp.');
    }
    this.jsonEndpoints.set(endpoint.path, endpoint);
  }

  async start(bridge?: TeamMcpBridge): Promise<void> {
    this.bridge = bridge;
    if (this.server) {
      return;
    }

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt++) {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      try {
        await listen(server);
        this.server = server;
        this._port = (server.address() as AddressInfo).port;
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        server.close();
      }
    }
    throw lastErr ?? new Error('Failed to start local MCP server.');
  }

  async stop(): Promise<void> {
    const server = this.server;
    const bridge = this.bridge;
    this.server = undefined;
    this._port = 0;
    this.bridge = undefined;
    await bridge?.close().catch(() => undefined);
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, 1000);
      server.close(() => finish());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const endpoint = this.jsonEndpoints.get(req.url ?? '');
    if (endpoint) {
      await this.handleJsonEndpoint(req, res, endpoint);
      return;
    }
    if (req.url !== '/mcp') {
      send(res, 404, { error: 'not found' });
      return;
    }
    // MCP Streamable HTTP: after `initialize`, the client opens a server→client SSE stream with GET, and
    // may terminate the session with DELETE. We offer neither (this server is request/response only).
    // The spec's answer for "no SSE stream offered" is 405 — a compliant client then proceeds without it.
    // Answering 404 makes the client treat it as a fatal transport error and DROP the connection, which
    // surfaced as `--permission-prompt-tool ... not found. Available MCP tools: none` and a hung turn.
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { error: 'bad request' });
      return;
    }

    // A JSON-RPC *notification* has no id and MUST NOT receive a response body.
    const isNotification = request.id === undefined || request.id === null;
    const id = request.id ?? null;
    try {
      const result = await this.dispatch(request);
      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }
      send(res, 200, { jsonrpc: '2.0', id, result });
    } catch (err) {
      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }
      send(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async handleJsonEndpoint(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    endpoint: LocalJsonEndpoint
  ): Promise<void> {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { error: 'bad request' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'request body must be a JSON object' });
      return;
    }
    try {
      if (endpoint.streamHandler) {
        await endpoint.streamHandler(body as Record<string, unknown>, res);
      } else {
        send(res, 200, await endpoint.handler(body as Record<string, unknown>));
      }
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      // The MCP lifecycle handshake. Every client (claude included) calls `initialize` FIRST and treats an
      // error as "server failed to connect" — it then reports zero tools, which is why a missing handshake
      // surfaced as `--permission-prompt-tool ... not found. Available MCP tools: none`.
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        return {
          // Echo only a version this server supports; otherwise make our supported version explicit.
          protocolVersion: requested === SUPPORTED_MCP_PROTOCOL_VERSION
            ? requested
            : SUPPORTED_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'unodeai-local-mcp', version: '1.0.0' },
        };
      }
      // Notifications: acknowledged, never answered with a JSON-RPC result (handled by the caller).
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'ping':
        return {};
      case 'tools/list': {
        const local = [...this.localTools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const bridged = this.bridge ? await this.bridge.listTools() : [];
        return { tools: [...local, ...bridged] };
      }
      case 'tools/call': {
        const name = String(request.params?.name ?? '');
        const args = asRecord(request.params?.arguments);
        const local = this.localTools.get(name);
        if (local) {
          return { content: [{ type: 'text', text: await local.handler(args) }] };
        }
        if (!this.bridge) {
          throw new Error(`Unknown tool "${name}".`);
        }
        return { content: [{ type: 'text', text: await this.bridge.callTool(name, args) }] };
      }
      default:
        throw new Error(`Unknown MCP method "${request.method ?? ''}".`);
    }
  }
}

export function createLocalMcpServer(): LocalMcpServer {
  return new HttpLocalMcpServer();
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_HOST);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        body = '';
        reject(new Error('request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
