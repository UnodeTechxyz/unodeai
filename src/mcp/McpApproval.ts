/*---------------------------------------------------------------------------------------------
 *  UnodeAi - MCP approval gate (P1#4 / MCP design §7.2)
 *  A sensitive MCP server (filesystem can escape the WorkspaceTools sandbox; github carries a PAT)
 *  must get explicit user approval before it is mounted. Approval is remembered (persisted) so the
 *  user is asked once per server, not every activation. This module is the pure decision logic so
 *  it's unit-testable; the actual prompt + persistence live in the extension host.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { createHash } from 'crypto';

/**
 * Approval is scoped to the workspace and the server launch spec. A changed command, URL, env
 * placeholder, or timeout invalidates the old approval so risky config edits cannot inherit trust.
 */
export function approvalKey(cfg: MCPServerConfig, workspaceId: string): string {
  const fingerprint = stableJson({
    id: cfg.id,
    transport: cfg.transport,
    command: cfg.command,
    args: cfg.args ?? [],
    url: cfg.url,
    env: cfg.env ?? {},
    timeoutMs: cfg.timeoutMs,
  });
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
  return `${workspaceId || 'no-workspace'}:${cfg.id}:${hash}`;
}

/**
 * Sensitive-by-default: a local subprocess (stdio) runs arbitrary code on the user's machine, a remote
 * endpoint can exfiltrate, and an env-bearing server carries secrets. These ALWAYS require an explicit
 * approval (the modal shows the exact command/URL) before mount — and crucially `requiresApproval: false`
 * does NOT bypass them. This closes the supply-chain hole where a mutable/hosted catalog entry could swap an
 * MCP command and set requiresApproval:false to suppress the prompt (the catalog defaults to a fetch-on-
 * startup GitHub URL where hosted entries win on id). Only a genuinely non-sensitive server may opt out.
 */
export function shouldRequireApproval(cfg: MCPServerConfig): boolean {
  const sensitive =
    cfg.transport === 'stdio' ||
    cfg.transport === 'streamable-http' ||
    cfg.transport === 'sse' ||
    Object.keys(cfg.env ?? {}).length > 0;
  if (sensitive) {
    return true; // requiresApproval:false cannot bypass a subprocess/remote/env server
  }
  return cfg.requiresApproval === true;
}

/**
 * Whether mounting `cfg` should block on a user confirmation right now.
 * True when the server is sensitive and its workspace-scoped launch fingerprint is not approved.
 */
export function needsApproval(
  cfg: MCPServerConfig,
  approvedKeys: ReadonlySet<string>,
  workspaceId = ''
): boolean {
  return shouldRequireApproval(cfg) && !approvedKeys.has(approvalKey(cfg, workspaceId));
}

/** Servers from a registry that are safe to mount without prompting (given prior approvals). */
export function autoMountable(
  servers: Iterable<MCPServerConfig>,
  approvedKeys: ReadonlySet<string>,
  workspaceId = ''
): MCPServerConfig[] {
  return [...servers].filter((cfg) => !needsApproval(cfg, approvedKeys, workspaceId));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        out[key] = sortForStableJson(child);
      }
    }
    return out;
  }
  return value;
}
