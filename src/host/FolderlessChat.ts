/*---------------------------------------------------------------------------------------------
 *  v0.9.99: chat and planning in a window with no folder open
 *
 *  Before, a window without a folder ran no agent at all ("Open a workspace folder before running agents"). Now an
 *  OpenAI-compatible agent can run there for chat and planning, in memory: the host gives it no file tools, no
 *  command tools, no Folder Access, no integrations and no skills, and roots it in an empty host-owned temporary
 *  folder that it is never granted. Project state that needs a root (restore points, the saved team, the saved
 *  conversation) is kept only in this window. A CLI agent, whose own tools reach the file system, still needs a folder.
 *--------------------------------------------------------------------------------------------*/

import type { AgentBackendKind, AgentConfig } from '../types';

/** The permissions that reach files or run commands. None is given to an agent in a window without a folder. */
const FILE_AND_COMMAND_TOOLS = new Set(['read', 'write', 'execute']);

/** The one line the user sees the first time an agent runs without a folder. */
export const FOLDERLESS_CHAT_NOTICE = 'No folder is open, so agents chat without file or command tools, and this team and '
  + 'its conversations are kept only in this window. Open a folder to give agents their tools and keep the team.';

/** Why an agent did not start in a window without a folder (a CLI agent), with what still works. */
export const FOLDERLESS_UNAVAILABLE_REASON = 'Open a workspace folder before running this agent. Without a folder, '
  + 'OpenAI-compatible agents can still chat, without file or command tools.';

/** Whether this route can run without a folder: only the OpenAI-compatible route, whose every tool the host serves. */
export function folderlessChatAllowed(kind: AgentBackendKind | undefined): boolean {
  return kind === 'openai-compat';
}

/**
 * The configuration an agent runs with in a window without a folder: the same agent with no file or command
 * tools, no Folder Access, no integrations and no skills, rooted in `transientRoot`, which it is not granted.
 * The saved agent is unchanged; once a folder is open it runs with its own tools again.
 */
export function folderlessChatConfig(config: AgentConfig, transientRoot: string): AgentConfig {
  return {
    ...config,
    workingDirectory: transientRoot,
    // Undefined means every tool; without a folder it means none of them.
    allowedTools: (config.allowedTools ?? []).filter((tool) => !FILE_AND_COMMAND_TOOLS.has(tool)),
    folderAccess: undefined,
    mcpServers: [],
    playbooks: [],
  };
}
