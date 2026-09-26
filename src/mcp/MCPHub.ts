/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCPHub (段2)
 *  Host-owned Model Context Protocol client shared by all backend routes.
 *
 *  Backend-aware design: UnodeAi-managed integrations use this Hub; native user-level calls are separate
 *  and remain owned by each CLI. Claude receives Hub tools through an authenticated
 *  loopback bridge; Codex receives them as App Server dynamic tools.
 *
 *  The MCP client is INJECTED (McpClientFactory) so the Hub's logic — namespacing, default-deny
 *  exposure, tool filtering, secret resolution, timeouts — is unit-testable without the real SDK
 *  or live subprocesses. The real adapter (lazy-loading @modelcontextprotocol/sdk) lives in
 *  RealMcpClient.ts and is only loaded at runtime.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { ToolSpec } from '../backend/WorkspaceTools';
import {
  hostToolFailed,
  hostToolRefused,
  hostToolSucceeded,
  type HostToolOutcome,
} from '../backend/toolSummary';

/** Minimal MCP client surface the Hub needs; the real SDK is adapted to this. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult | string>;
  close(): Promise<void>;
}

/** The protocol result after transport-specific content has been reduced to bounded, model-safe text. */
export interface McpToolResult {
  output: string;
  /** MCP servers use this flag for a completed call whose application-level result is an error. */
  isError: boolean;
}
/** Creates a connected client; only `secretValues` came from SecretStorage placeholders. */
export type McpClientFactory = (
  config: MCPServerConfig,
  env: Record<string, string>,
  secretValues: readonly string[],
) => Promise<McpClient>;

/** Resolve a secret name (e.g. from ${VAR}) to its value, typically from SecretStorage. */
export type SecretResolver = (name: string) => Promise<string | undefined> | string | undefined;
/** Re-enter the host's normal approved mount path after an uncertain tool outcome. */
export type McpRemountRequester = (config: MCPServerConfig) => Promise<void>;

/**
 * One authorized grant of a server's tools to an agent. Produced by SkillResolver from
 * `mcp-server` skills (or an agent's explicit `mcpServers`, as `toolFilter: 'all'`).
 */
export interface McpServerGrant {
  serverId: string;
  toolFilter: 'all' | 'allowlist' | 'denylist';
  toolList?: string[];
}

/** A live resolver lets saved grant changes revoke calls immediately; arrays remain supported for embedders. */
export type McpServerGrants = readonly McpServerGrant[] | (() => readonly McpServerGrant[]);

export function resolveMcpServerGrants(source: McpServerGrants): McpServerGrant[] {
  return [...(typeof source === 'function' ? source() : source)].map((grant) => ({
    ...grant,
    toolList: grant.toolList ? [...grant.toolList] : undefined,
  }));
}

const NS = '__'; // namespace separator: serverId__toolName

interface ServerConn {
  config: MCPServerConfig;
  client: McpClient;
  tools: McpToolDef[];
  ready: boolean;
  quarantined: boolean;
  activeCalls: Set<Promise<unknown>>;
  controllers: Set<AbortController>;
}

interface QuarantinedServer {
  config: MCPServerConfig;
  tools: McpToolDef[];
  connection: ServerConn;
  generation: number;
  recovery?: Promise<void>;
  recoveryError?: string;
}

export class MCPHub {
  private servers = new Map<string, ServerConn>();
  private connecting = new Set<string>();
  private quarantinedServers = new Map<string, QuarantinedServer>();
  private generations = new Map<string, number>();

  constructor(
    private clientFactory: McpClientFactory,
    private resolveSecret: SecretResolver = () => undefined,
    private callTimeoutMs = 60_000,
    private requestRemount?: McpRemountRequester,
  ) {}

  /** Connect a server and cache its tool list. Idempotent-ish: re-registering throws. */
  async register(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.id) || this.connecting.has(config.id)) {
      throw new Error(`MCP server "${config.id}" already registered.`);
    }
    this.connecting.add(config.id);
    let client: McpClient | undefined;
    try {
      const resolved = await this.resolveEnv(config.env);
      client = await this.clientFactory(config, resolved.env, resolved.secretValues);
      const tools = await client.listTools();
      this.servers.set(config.id, {
        config,
        client,
        tools,
        ready: true,
        quarantined: false,
        activeCalls: new Set(),
        controllers: new Set(),
      });
      const staleQuarantine = this.quarantinedServers.get(config.id);
      if (staleQuarantine && !staleQuarantine.recovery) this.quarantinedServers.delete(config.id);
    } catch (error) {
      await client?.close().catch(() => undefined);
      throw error;
    } finally {
      this.connecting.delete(config.id);
    }
  }

  async unregister(id: string): Promise<void> {
    this.bumpGeneration(id);
    this.quarantinedServers.delete(id);
    const conn = this.servers.get(id);
    if (!conn) {
      return;
    }
    this.servers.delete(id);
    conn.ready = false;
    conn.quarantined = true;
    for (const controller of conn.controllers) controller.abort();
    await settleActiveCalls(conn.activeCalls);
    try {
      await conn.client.close();
    } catch {
      /* closing a dead client must not throw */
    }
  }

  isRegistered(id: string): boolean {
    return this.servers.has(id);
  }

  /** Snapshot the exact resolved configuration owned by the live connection. */
  registeredConfig(id: string): MCPServerConfig | undefined {
    const config = this.servers.get(id)?.config;
    if (!config) {
      return undefined;
    }
    return {
      ...config,
      args: config.args ? [...config.args] : undefined,
      env: config.env ? { ...config.env } : undefined,
    };
  }

  /**
   * OpenAI-format tool declarations an agent may use, given its grants. DEFAULT-DENY: a server
   * contributes nothing unless a grant references it. Tool names are namespaced `serverId__tool`
   * to avoid collisions, and filtered per the grant's allow/deny list. Servers not yet ready
   * (still connecting) are skipped so a slow `npx` cold-start never blocks a turn.
   */
  getToolSpecs(grants: readonly McpServerGrant[]): ToolSpec[] {
    const specs: ToolSpec[] = [];
    const seen = new Set<string>();
    for (const grant of grants) {
      if (seen.has(grant.serverId)) {
        continue; // a server granted twice is exposed once (first grant wins)
      }
      seen.add(grant.serverId);
      const conn = this.servers.get(grant.serverId);
      if (!conn || !conn.ready || conn.quarantined) {
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
    return !!parsed && (this.servers.has(parsed.serverId) || this.quarantinedServers.has(parsed.serverId));
  }

  /** Whether this namespaced tool is both real and allowed by the current agent grants. */
  canExecuteTool(fullName: string, grants: readonly McpServerGrant[]): boolean {
    const parsed = parseToolName(fullName);
    if (!parsed) {
      return false;
    }
    const conn = this.servers.get(parsed.serverId);
    if (!conn || !conn.ready || conn.quarantined || !conn.tools.some((t) => t.name === parsed.toolName)) {
      return false;
    }
    const grant = grants.find((g) => g.serverId === parsed.serverId);
    return !!grant && passesFilter(parsed.toolName, grant);
  }

  /** Execute one granted namespaced call and report the host-observed outcome without parsing server prose. */
  async executeTool(
    fullName: string,
    args: Record<string, unknown>,
    grants: readonly McpServerGrant[],
    signal?: AbortSignal,
  ): Promise<HostToolOutcome> {
    const parsed = parseToolName(fullName);
    if (!parsed) {
      return hostToolFailed(`Malformed MCP tool name "${fullName}".`);
    }
    const grant = grants.find((item) => item.serverId === parsed.serverId);
    if (!grant || !passesFilter(parsed.toolName, grant)) {
      return hostToolRefused(`MCP tool "${fullName}" is not granted to this agent.`, 'consent');
    }
    if (signal?.aborted) {
      return hostToolFailed(`MCP tool "${fullName}" was cancelled before dispatch.`, { failureKind: 'cancelled' });
    }

    const quarantined = this.quarantinedServers.get(parsed.serverId);
    if (quarantined) {
      const recovery = this.beginQuarantineRecovery(parsed.serverId, quarantined);
      const recovered = await waitForRecovery(recovery, signal);
      if (!recovered) {
        return hostToolFailed(`MCP tool "${fullName}" was cancelled while its integration was reconnecting.`, {
          failureKind: 'cancelled',
        });
      }
    }

    const conn = this.servers.get(parsed.serverId);
    if (!conn || !conn.ready || conn.quarantined) {
      const recoveryError = this.quarantinedServers.get(parsed.serverId)?.recoveryError;
      const detail = recoveryError ? ` Reconnect failed: ${recoveryError}` : '';
      return hostToolFailed(
        `MCP server "${parsed.serverId}" is temporarily unavailable while reconnecting after an uncertain outcome.${detail}`,
        { failureKind: 'not_found' },
      );
    }
    if (!conn.tools.some((t) => t.name === parsed.toolName)) {
      return hostToolFailed(`MCP tool "${fullName}" is not exposed by server "${parsed.serverId}".`, { failureKind: 'not_found' });
    }
    if (signal?.aborted) {
      return hostToolFailed(`MCP tool "${fullName}" was cancelled before dispatch.`, { failureKind: 'cancelled' });
    }
    if (!this.canExecuteTool(fullName, grants)) {
      // The connection or live grant changed while a quarantine recovery was settling. Re-run the
      // authorization distinction so an unavailable server is never mislabeled as revoked access.
      const liveGrant = grants.find((item) => item.serverId === parsed.serverId);
      if (!liveGrant || !passesFilter(parsed.toolName, liveGrant)) {
        return hostToolRefused(`MCP tool "${fullName}" is not granted to this agent.`, 'consent');
      }
      return hostToolFailed(`MCP server "${parsed.serverId}" is unavailable.`, { failureKind: 'not_found' });
    }
    const timeoutMs = conn.config.timeoutMs ?? this.callTimeoutMs;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    conn.controllers.add(controller);
    let dispatched = false;
    let timedOut = false;
    let externallyCancelled = false;
    const onExternalAbort = () => { externallyCancelled = true; };
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new CancelledBeforeDispatchError();
      dispatched = true;
      return conn.client.callTool(parsed.toolName, args, controller.signal);
    });
    conn.activeCalls.add(call);
    let rejectExternalAbort: (() => void) | undefined;
    const rejectAfterAbort = new Promise<never>((_resolve, reject) => {
      rejectExternalAbort = () => reject(new Error(`MCP tool ${fullName} was cancelled`));
      if (signal?.aborted) rejectExternalAbort();
      else signal?.addEventListener('abort', rejectExternalAbort, { once: true });
    });
    try {
      const output = await Promise.race([
        call,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`MCP tool ${fullName} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
        rejectAfterAbort,
      ]);
      const normalized = typeof output === 'string' ? { output, isError: false } : output;
      if (normalized.isError) {
        return hostToolFailed(normalized.output || `MCP tool "${fullName}" reported an error.`, {
          failureKind: 'integration_error',
          contentSource: 'mixed-external',
        });
      }
      return hostToolSucceeded(normalized.output, { contentSource: 'mixed-external' });
    } catch (err) {
      if (!dispatched && (externallyCancelled || err instanceof CancelledBeforeDispatchError)) {
        return hostToolFailed(`MCP tool "${fullName}" was cancelled before dispatch.`, { failureKind: 'cancelled' });
      }
      if (timedOut || externallyCancelled || controller.signal.aborted) {
        this.quarantine(parsed.serverId, conn);
        const reason = timedOut
          ? `MCP tool "${fullName}" timed out after dispatch; its outcome is unknown.`
          : `MCP tool "${fullName}" was cancelled after dispatch; its outcome is unknown.`;
        return hostToolFailed(reason, { failureKind: 'outcome_unknown' });
      }
      return hostToolFailed(`MCP tool "${fullName}" failed: ${err instanceof Error ? err.message : String(err)}`, {
        contentSource: 'mixed-external',
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
      signal?.removeEventListener('abort', onExternalAbort);
      if (rejectExternalAbort) signal?.removeEventListener('abort', rejectExternalAbort);
      conn.controllers.delete(controller);
      conn.activeCalls.delete(call);
      if (conn.quarantined && conn.activeCalls.size === 0) {
        const quarantined = this.quarantinedServers.get(parsed.serverId);
        if (quarantined) void this.beginQuarantineRecovery(parsed.serverId, quarantined);
      }
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
    const ids = new Set([...this.servers.keys(), ...this.quarantinedServers.keys()]);
    for (const id of ids) this.bumpGeneration(id);
    this.servers.clear();
    this.quarantinedServers.clear();
    for (const conn of conns) {
      conn.ready = false;
      conn.quarantined = true;
      for (const controller of conn.controllers) controller.abort();
    }
    await Promise.all(conns.map((conn) => settleActiveCalls(conn.activeCalls)));
    await Promise.all(
      conns.map((c) => c.client.close().catch(() => undefined))
    );
  }

  /** Resolve ${VAR} placeholders in a server's env via the secret resolver (NOT process.env). */
  private async resolveEnv(env?: Record<string, string>): Promise<{
    env: Record<string, string>;
    secretValues: string[];
  }> {
    const out: Record<string, string> = {};
    const resolvedValues = new Map<string, string>();
    const names = new Set<string>();
    for (const raw of Object.values(env ?? {})) {
      for (const match of raw.matchAll(/\$\{(\w+)\}/g)) names.add(match[1]);
    }
    for (const name of names) {
      const resolved = await this.resolveSecret(name);
      if (resolved === undefined) throw new Error(`Required secret ${name} is not configured.`);
      if (resolved.length === 0) throw new Error(`Configured secret ${name} is empty.`);
      resolvedValues.set(name, resolved);
    }
    for (const [key, raw] of Object.entries(env ?? {})) {
      out[key] = raw.replace(/\$\{(\w+)\}/g, (_match, name: string) => resolvedValues.get(name)!);
    }
    return { env: out, secretValues: [...new Set(resolvedValues.values())] };
  }

  private quarantine(id: string, conn: ServerConn): void {
    if (this.servers.get(id) !== conn || conn.quarantined) return;
    conn.ready = false;
    conn.quarantined = true;
    this.quarantinedServers.set(id, {
      config: conn.config,
      tools: [...conn.tools],
      connection: conn,
      generation: this.generation(id),
    });
    this.servers.delete(id);
  }

  private beginQuarantineRecovery(id: string, quarantined: QuarantinedServer): Promise<void> {
    if (quarantined.recovery) return quarantined.recovery;
    const recovery = (async () => {
      try {
        await settleActiveCalls(quarantined.connection.activeCalls);
        await quarantined.connection.client.close().catch(() => undefined);
        if (this.quarantinedServers.get(id) !== quarantined || this.generation(id) !== quarantined.generation) return;
        if (this.requestRemount) await this.requestRemount(quarantined.config);
        else await this.register(quarantined.config);
        if (this.quarantinedServers.get(id) !== quarantined || this.generation(id) !== quarantined.generation) {
          await this.unregister(id);
          return;
        }
        if (!this.servers.has(id)) throw new Error('the approved mount path did not restore the connection');
        this.quarantinedServers.delete(id);
      } catch (error) {
        if (this.quarantinedServers.get(id) === quarantined && this.generation(id) === quarantined.generation) {
          quarantined.recoveryError = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (this.quarantinedServers.get(id) === quarantined) quarantined.recovery = undefined;
      }
    })();
    quarantined.recovery = recovery;
    return recovery;
  }

  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  private bumpGeneration(id: string): void {
    this.generations.set(id, this.generation(id) + 1);
  }
}

class CancelledBeforeDispatchError extends Error {}

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

async function settleActiveCalls(calls: ReadonlySet<Promise<unknown>>): Promise<void> {
  if (calls.size === 0) return;
  await Promise.race([
    Promise.allSettled([...calls]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function waitForRecovery(recovery: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await recovery;
    return true;
  }
  if (signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([recovery.then(() => true), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
