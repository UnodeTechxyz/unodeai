import { codexWriteCapable } from '../backend/CodexPermissionProfile';
import type { AgentConfig, AgentBackendKind } from '../types';

/** The existing backend factory's capability projection, shared with read-only policy presentation. */
export function hostFileToolCapabilities(config: AgentConfig, kind: AgentBackendKind, restricted: boolean): { write: boolean; execute: boolean } {
  if (kind === 'openai-compat') return { write: !!config.allowedTools?.includes('write'), execute: !!config.allowedTools?.includes('execute') && !restricted };
  const write = kind === 'codex' ? codexWriteCapable(config.allowedTools, config.toolCeiling)
    : !Array.isArray(config.allowedTools) || config.allowedTools.includes('write');
  const execute = write && config.executePreference !== 'deny' && (kind === 'codex'
    || kind === 'claude' && (!Array.isArray(config.allowedTools) || config.allowedTools.includes('execute')) && !restricted);
  return { write, execute };
}
