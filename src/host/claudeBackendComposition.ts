/*---------------------------------------------------------------------------------------------
 *  UnodeAi - how activation composes an agent's review sources and a Claude backend
 *
 *  v0.9.101 (the Owner, 2026-11-05): under Approve for me an ordinary in-scope write or command gets no card. Whether
 *  one does is decided by the live Autonomy policy reaching the Claude gate. These two functions are that link, and
 *  activation's backend factory calls them: a test that calls them exercises the production composition rather
 *  than a copy of it.
 *--------------------------------------------------------------------------------------------*/
import { AgentCommandPolicy } from '../backend/AgentCommandPolicy';
import { ClaudeHeadlessBackend, type ClaudeHeadlessBackendDeps } from '../backend/ClaudeHeadlessBackend';
import type { CommandPolicy } from '../backend/CommandPolicy';
import type { AgentConfig } from '../types';

/** The approval entries of a Claude backend. Only createClaudeBackend sets them. */
export type ClaudeApprovalKey = 'commandPermission' | 'requestToolApproval' | 'writeApprovalAsk' | 'requestWriteApproval' | 'fileWrites';

/** Every other dependency of a Claude backend. Without the approval keys, so the factory cannot set one beside them. */
export type ClaudeBackendBaseDeps = Omit<ClaudeHeadlessBackendDeps, ClaudeApprovalKey>;

/** Where a Claude agent's approvals come from: the live Autonomy policy of its current config and the host's cards. */
export interface ClaudeApprovalSources {
  /** The agent's current saved config (a change in the Autonomy menu applies to the running agent). */
  liveConfig: () => AgentConfig;
  /** The host's Autonomy policy for that config. Its writeReview decides whether an ordinary write asks. */
  autonomyPolicy: (config: AgentConfig) => { writeReview: boolean };
  /** The agent's command policy, from createAgentCommandPolicy. */
  commandPolicy: CommandPolicy;
  approveCommand: NonNullable<NonNullable<ClaudeHeadlessBackendDeps['commandPermission']>['requestApproval']>;
  isTrusted: () => boolean;
  requestToolApproval: NonNullable<ClaudeHeadlessBackendDeps['requestToolApproval']>;
  requestWriteApproval: NonNullable<ClaudeHeadlessBackendDeps['requestWriteApproval']>;
  fileWrites: ClaudeHeadlessBackendDeps['fileWrites'];
}

/** One agent's view of the global command policy: its narrowing, and review exactly when its Autonomy asks for it. */
export function createAgentCommandPolicy(
  globalPolicy: CommandPolicy,
  config: AgentConfig,
  liveConfig: () => AgentConfig,
  autonomyFor: (config: AgentConfig) => { commandReview: boolean },
): AgentCommandPolicy {
  return new AgentCommandPolicy(globalPolicy, config.commandNarrowing, config.name, () => autonomyFor(liveConfig()).commandReview);
}

/** The Claude backend activation starts. The approval entries come only from `approval` and are applied last. */
export function createClaudeBackend(
  config: AgentConfig,
  mcpConfig: ConstructorParameters<typeof ClaudeHeadlessBackend>[1],
  params: ConstructorParameters<typeof ClaudeHeadlessBackend>[2],
  base: ClaudeBackendBaseDeps,
  approval: ClaudeApprovalSources,
): ClaudeHeadlessBackend {
  return new ClaudeHeadlessBackend(config, mcpConfig, params, {
    ...base,
    commandPermission: { policy: approval.commandPolicy, requestApproval: approval.approveCommand, isTrusted: approval.isTrusted },
    // PreToolUse is inherited by Claude native subagents. It uses this same in-panel approval surface for
    // unknown/external native tools, and the existing write card for native Write/Edit previews.
    requestToolApproval: approval.requestToolApproval,
    writeApprovalAsk: () => approval.autonomyPolicy(approval.liveConfig()).writeReview,
    requestWriteApproval: approval.requestWriteApproval,
    fileWrites: approval.fileWrites,
  });
}
