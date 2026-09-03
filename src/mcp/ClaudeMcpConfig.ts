/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ClaudeMcpConfig (段2)
 *  Backend-aware MCP for the Claude headless backend.
 *
 *  Unlike the OpenAICompatBackend (which hosts MCP in-process via MCPHub), the Claude CLI has
 *  NATIVE MCP support: given `--mcp-config <file>`, claude spawns and manages the servers itself.
 *  Our only job is to translate an agent's authorized servers into the JSON shape claude expects.
 *
 *  Secrets: env values keep their ${VAR} placeholders here (no secrets written to disk). claude
 *  expands them from the process env we hand it at spawn time — so the extension must inject those
 *  vars (resolved from SecretStorage) into the claude process env. See extension.ts resolveEnv.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { LocalMcpServer } from './LocalMcpServer';

/** The `mcp-config` document claude reads: a map of server id -> launch spec. */
export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerSpec>;
}
export type ClaudeMcpServerSpec =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export type MCPConfigEntry = ClaudeMcpServerSpec;

export const TEAM_BRIDGE_SERVER_ID = 'unode_team_bridge';
/** Per-agent local server hosting the claude permission-prompt tool (command-approval gate). */
export const PERMISSION_SERVER_ID = 'unode_permission';
/** Per-agent local server exposing UnodeAI-enforced read-only cross-root file tools to Claude. */
export const FILES_BRIDGE_SERVER_ID = 'unode_files';

/**
 * Build claude's mcp-config from the server configs an agent is authorized for. Unknown/invalid
 * servers are skipped. Returns undefined when there is nothing to mount (so the caller omits the
 * --mcp-config flag entirely).
 *
 * Note: claude has no notion of our per-skill tool allow/deny filter — it exposes every tool a
 * server offers. Fine-grained tool filtering is an OpenAICompatBackend/MCPHub capability; for the
 * claude backend, authorization is at the whole-server granularity.
 */
export function buildClaudeMcpConfig(
  servers: MCPServerConfig[],
  teamBridgeConfig?: MCPConfigEntry
): ClaudeMcpConfig | undefined {
  const mcpServers: Record<string, ClaudeMcpServerSpec> = {};
  if (teamBridgeConfig) {
    mcpServers[TEAM_BRIDGE_SERVER_ID] = teamBridgeConfig;
  }
  for (const s of servers) {
    if (s.transport === 'stdio') {
      if (!s.command) {
        continue; // stdio needs a command
      }
      const spec: ClaudeMcpServerSpec = { command: s.command };
      if (s.args && s.args.length > 0) {
        (spec as { args?: string[] }).args = s.args;
      }
      if (s.env && Object.keys(s.env).length > 0) {
        (spec as { env?: Record<string, string> }).env = s.env;
      }
      mcpServers[s.id] = spec;
    } else {
      if (!s.url) {
        continue; // http/sse needs a url
      }
      mcpServers[s.id] = { type: s.transport === 'sse' ? 'sse' : 'http', url: s.url };
    }
  }
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : undefined;
}

export function buildTeamBridgeConfig(localServer: Pick<LocalMcpServer, 'port' | 'token'>): MCPConfigEntry {
  return {
    type: 'http',
    url: `http://127.0.0.1:${localServer.port}/mcp`,
    headers: { Authorization: `Bearer ${localServer.token}` },
  };
}
