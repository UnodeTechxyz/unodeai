/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCPHub (段2)
 *  In-process Model Context Protocol host for the OpenAICompatBackend.
 *
 *  Backend-aware design (see docs/MCP_Skills_Integration.md §3): the Claude backend uses claude's
 *  NATIVE MCP support (--mcp-config) and never touches this Hub. Only the in-process
 *  OpenAICompatBackend — which owns its own tool loop — needs a Hub to expose MCP tools and route
 *  calls. Building a Hub for claude agents too would mean two clients connected to one server.
 *
 *  The MCP client is INJECTED (McpClientFactory) so the Hub's logic — namespacing, default-deny
 *  exposure, tool filtering, secret resolution, timeouts — is unit-testable without the real SDK
 *  or live subprocesses. The real adapter (lazy-loading @modelcontextprotocol/sdk) lives in
 *  RealMcpClient.ts and is only loaded at runtime.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { ToolSpec } from '../backend/WorkspaceTools';

/** Minimal MCP client surface the Hub needs; the real SDK is adapted to this. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}
/** Creates a connected client for a server; `env` already has ${VAR} placeholders resolved. */
export type McpClientFactory = (config: MCPServerConfig, env: Record<string, string>) => Promise<McpClient>;

/** Resolve a secret name (e.g. from ${VAR}) to its value, typically from SecretStorage. */
export type SecretResolver = (name: string) => Promise<string | undefined> | string | undefined;

/**
 * One authorized grant of a server's tools to an agent. Produced by SkillResolver from
 * `mcp-server` skills (or an agent's explicit `mcpServers`, as `toolFilter: 'all'`).
 */
export interface McpServerGrant {
  serverId: string;
  toolFilter: 'all' | 'allowlist' | 'denylist';
  toolList?: string[];
}

const NS = '__'; // namespace separator: serverId__toolName

interface ServerConn {
  config: MCPServerConfig;
  client: McpClient;
  tools: McpToolDef[];
  ready: boolean;
}

export class MCPHub {
  private servers = new Map<string, ServerConn>();

  constructor(
    private clientFactory: McpClientFactory,
    private resolveSecret: SecretResolver = () => undefined,
    private callTimeoutMs = 60_000
  ) {}

  /** Connect a server and cache its tool list. Idempotent-ish: re-registering throws. */
  async register(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      throw new Error(`MCP server "${config.id}" already registered.`);
    }
    const env = await this.resolveEnv(config.env);
    const client = await this.clientFactory(config, env);
    const tools = await client.listTools();
    this.servers.set(config.id, { config, client, tools, ready: true });
  }

  async unregister(id: string): Promise<void> {
    const conn = this.servers.get(id);
    if (!conn) {
      return;
    }
    this.servers.delete(id);
    try {
      await conn.client.close();
    } catch {
      /* closing a dead client must not throw */
    }
  }

  isRegistered(id: string): boolean {
    return this.servers.has(id);
  }

  /**
   * OpenAI-format tool declarations an agent may use, given its grants. DEFAULT-DENY: a server
   * contributes nothing unless a grant references it. Tool names are namespaced `serverId__tool`
   * to avoid collisions, and filtered per the grant's allow/deny list. Servers not yet ready
   * (still connecting) are skipped so a slow `npx` cold-start never blocks a turn.
   */
  getToolSpecs(grants: McpServerGrant[]): ToolSpec[] {
    const specs: ToolSpec[] = [];
    const seen = new Set<string>();
    for (const grant of grants) {
      if (seen.has(grant.serverId)) {
        continue; // a server granted twice is exposed once (first grant wins)
      }
      seen.add(grant.serverId);
      const conn = this.servers.get(grant.serverId);
      if (!conn || !conn.ready) {
        continue;
      }
      for (const tool of conn.tools) {
        if (!passesFilter(tool.name, grant)) {
          continue;
        }
        specs.push({
          type: 'function',
          function: {
            name: `${grant.serverId}${NS}${tool.name}`,
            description: tool.description ?? '',
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          },
        });
      }
    }
    return specs;
  }

  /** Whether a (namespaced) tool name belongs to a registered server. */
  hasTool(fullName: string): boolean {
    const parsed = parseToolName(fullName);
    return !!parsed && this.servers.has(parsed.serverId);
  }

  /** Whether this namespaced tool is both real and allowed by the current agent grants. */
  canExecuteTool(fullName: string, grants: McpServerGrant[]): boolean {
    const parsed = parseToolName(fullName);
    if (!parsed) {
      return false;
    }
    const conn = this.servers.get(parsed.serverId);
    if (!conn || !conn.tools.some((t) => t.name === parsed.toolName)) {
      return false;
    }
    const grant = grants.find((g) => g.serverId === parsed.serverId);
    return !!grant && passesFilter(parsed.toolName, grant);
  }

  /** Execute a namespaced MCP tool call, with a per-call timeout. Errors are returned, not thrown. */
  async executeTool(fullName: string, args: Record<string, unknown>, grants?: McpServerGrant[]): Promise<string> {
    const parsed = parseToolName(fullName);
    if (!parsed) {
      return `Error: malformed MCP tool name "${fullName}".`;
    }
    if (grants && !this.canExecuteTool(fullName, grants)) {
      return `Error: MCP tool "${fullName}" is not granted to this agent.`;
    }
    const conn = this.servers.get(parsed.serverId);
    if (!conn) {
      return `Error: MCP server "${parsed.serverId}" is not registered.`;
    }
    if (!conn.tools.some((t) => t.name === parsed.toolName)) {
      return `Error: MCP tool "${fullName}" is not exposed by server "${parsed.serverId}".`;
    }
    const timeoutMs = conn.config.timeoutMs ?? this.callTimeoutMs;
    try {
      return await withTimeout(
        conn.client.callTool(parsed.toolName, args),
        timeoutMs,
        `MCP tool ${fullName} timed out after ${timeoutMs}ms`
      );
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Status snapshot for the UI / diagnostics. */
  listServers(): Array<{ id: string; name: string; ready: boolean; toolCount: number }> {
    return [...this.servers.values()].map((c) => ({
      id: c.config.id,
      name: c.config.name,
      ready: c.ready,
      toolCount: c.tools.length,
    }));
  }

  async stopAll(): Promise<void> {
    const conns = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      conns.map((c) => c.client.close().catch(() => undefined))
    );
  }

  /** Resolve ${VAR} placeholders in a server's env via the secret resolver (NOT process.env). */
  private async resolveEnv(env?: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(env ?? {})) {
      const matches = [...raw.matchAll(/\$\{(\w+)\}/g)];
      let value = raw;
      for (const m of matches) {
        const resolved = (await this.resolveSecret(m[1])) ?? '';
        value = value.replace(m[0], resolved);
      }
      out[key] = value;
    }
    return out;
  }
}

function passesFilter(toolName: string, grant: McpServerGrant): boolean {
  if (grant.toolFilter === 'allowlist') {
    return (grant.toolList ?? []).includes(toolName);
  }
  if (grant.toolFilter === 'denylist') {
    return !(grant.toolList ?? []).includes(toolName);
  }
  return true; // 'all'
}

function parseToolName(fullName: string): { serverId: string; toolName: string } | undefined {
  const sep = fullName.indexOf(NS);
  if (sep <= 0 || sep === fullName.length - NS.length) {
    return undefined;
  }
  return { serverId: fullName.slice(0, sep), toolName: fullName.slice(sep + NS.length) };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
