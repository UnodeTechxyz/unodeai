/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ClaudeMcpConfig (段2)
 *  Backend-aware MCP for the Claude headless backend.
 *
 *  Claude keeps its native user/repository MCP configuration. UnodeAi-managed integrations are
 *  separate: the extension host owns their clients and exposes only granted tools through an
 *  authenticated loopback bridge whose identity repository configuration cannot predict.
 *
 *  The legacy translation helper below remains for native/project compatibility. Its env values
 *  keep their ${VAR} placeholders here (no secrets written to disk). Claude
 *  expands them from the process env we hand it at spawn time — so the extension must inject those
 *  vars (resolved from SecretStorage) into the claude process env. See extension.ts resolveEnv.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { LocalMcpServer } from './LocalMcpServer';
import * as crypto from 'node:crypto';

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
/** Host-owned proxy for the exact MCP integrations granted to this agent. */
export const INTEGRATIONS_BRIDGE_SERVER_ID = 'unode_integrations';
/** Host-mediated, per-run-approved executable Skill actions. */
export const SKILL_ACTIONS_SERVER_ID = 'unode_skill_actions';

export interface ClaudeBridgeIds {
  team: string;
  permission: string;
  files: string;
  integrations: string;
  skillActions: string;
}

/** Opaque per-backend bridge identities. The 128-bit suffix is never read from repository content. */
export function createClaudeBridgeIds(randomBytes: (size: number) => Buffer = crypto.randomBytes): ClaudeBridgeIds {
  const suffix = randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(suffix)) throw new Error('Claude bridge identity source returned invalid entropy.');
  return {
    team: `${TEAM_BRIDGE_SERVER_ID}_${suffix}`,
    permission: `${PERMISSION_SERVER_ID}_${suffix}`,
    files: `${FILES_BRIDGE_SERVER_ID}_${suffix}`,
    integrations: `${INTEGRATIONS_BRIDGE_SERVER_ID}_${suffix}`,
    skillActions: `${SKILL_ACTIONS_SERVER_ID}_${suffix}`,
  };
}

export function isClaudeBridgeServerId(serverId: string, kind: keyof ClaudeBridgeIds): boolean {
  const prefix = {
    team: TEAM_BRIDGE_SERVER_ID,
    permission: PERMISSION_SERVER_ID,
    files: FILES_BRIDGE_SERVER_ID,
    integrations: INTEGRATIONS_BRIDGE_SERVER_ID,
    skillActions: SKILL_ACTIONS_SERVER_ID,
  }[kind];
  return new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(serverId);
}

/**
 * Attribute a provider-qualified managed-tool event to its host-owned server without trusting a
 * bridge-like prefix. Claude wraps the ordinary `server__tool` name inside its opaque integrations
 * bridge (`mcp__<bridge>__<server>__<tool>`); Codex/OpenAI-compatible routes use the ordinary forms.
 */
export function managedMcpServerIdFromToolName(
  toolName: string,
  configuredServerIds: Iterable<string>,
  expectedClaudeIntegrationsBridgeId?: string,
): string | undefined {
  const serverIds = [...configuredServerIds];
  if (toolName.startsWith('mcp__')) {
    const qualified = toolName.slice('mcp__'.length);
    const bridgeEnd = qualified.indexOf('__');
    if (bridgeEnd > 0) {
      const possibleBridge = qualified.slice(0, bridgeEnd);
      if (isClaudeBridgeServerId(possibleBridge, 'integrations')) {
        if (!expectedClaudeIntegrationsBridgeId || possibleBridge !== expectedClaudeIntegrationsBridgeId) {
          return undefined;
        }
        const bridgedTool = qualified.slice(bridgeEnd + 2);
        return serverIds.find((serverId) => bridgedTool.startsWith(`${serverId}__`));
      }
    }
  }
  return serverIds.find((serverId) =>
    toolName.startsWith(`${serverId}__`) || toolName.startsWith(`mcp__${serverId}__`));
}

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
