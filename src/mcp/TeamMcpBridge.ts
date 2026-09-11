/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TeamMcpBridge (P2#12, foundation)
 *  Adapts the existing PM delegation tools (TeamTools: list_agents / assign_task / broadcast /
 *  run_checks) to the MCP client surface (listTools / callTool). This is the reusable CORE of
 *  "let a Claude-backed PM delegate too": today TeamTools is injected only into the in-process
 *  OpenAICompatBackend; a claude agent can only get team tools through MCP.
 *
 *  STATUS: this bridge is the transport-agnostic core. To actually hand it to claude it must be
 *  hosted behind an MCP endpoint (a local streamable-http server, or a stdio server subprocess)
 *  and added to claude's --mcp-config. That hosting/IPC layer + live verification is the remaining
 *  work (see docs/STATUS.md P2#12). The bridge itself is unit-tested here so the core logic — tool
 *  discovery + call routing back through the MessageBus — is proven independently of transport.
 *--------------------------------------------------------------------------------------------*/

import { McpClient, McpToolDef } from './MCPHub';
import { ToolSpec } from '../backend/WorkspaceTools';
import { CoordinatorCloseoutState } from '../backend/TeamTools';
import type { PublishedTurnDelivery, TurnContentReceipt } from '../backend/TeamTools';
import type { TaskAttemptCard } from '../backend/TaskContract';
import type { DelegationContentSource } from '../session/TurnContextManifest';

/** The slice of TeamTools the bridge needs (TeamTools satisfies this structurally). */
export interface TeamToolset {
  specs(): ToolSpec[];
  has(name: string): boolean;
  run(name: string, args: Record<string, unknown>): Promise<string>;
  /** Host-visible receipt for a legacy MCP call that was translated to the current async contract. */
  noteCompatibilityAlias?(from: string, to: string): void;
  cancelPending?(reason?: string): number;
  coordinatorCloseoutState?(): CoordinatorCloseoutState;
  /** Framework-observed passing coordinator verification, including a native verification-like shell run. */
  noteCoordinatorVerificationPassed?(observedAt?: number): void;
  setDelegationContentSources?(sources: readonly DelegationContentSource[] | undefined): void;
  /** Starts a fresh turn-local content receipt scope. */
  beginTurnContentReceipts?(): void;
  /** Registers host-returned source bytes under an opaque, current-turn receipt id. */
  registerTurnContentReceipt?(content: string): TurnContentReceipt | undefined;
  /** Consumes a terminal delivery that the backend must publish as the real assistant reply. */
  takePublishedTurnDelivery?(): PublishedTurnDelivery | undefined;
  /** True while a host-published receipt is waiting to replace raw terminal streaming text. */
  hasPendingTurnDelivery?(): boolean;
  hasTeammates?(): boolean;
  canCoordinatorExecute?(toolName: string): boolean;
  currentCoordinatorTaskAttempt?(): TaskAttemptCard | undefined;
  finishCoordinatorAttempt?(state?: 'cancelled' | 'settled'): void;
}

const DELEGATION_RESULT_CONTINUATION_NOTE =
  '[orchestration] The delegated result above is not automatically the final user-facing answer. ' +
  'This is the turn that received the result, so if it completed an implementation step in your active plan, continue now: inspect ' +
  'only if needed, run_checks or send the work to a reviewer, update todos, and delegate any remaining ' +
  'steps. If this was only an informational delegation, summarize the result for the user. ' +
  // The user outranks this note. Once their message could actually REACH a busy agent (it used to be
  // silently dropped), a PM told "drop that task" got this note pulling it the other way and oscillated.
  'THE USER OVERRIDES THIS: if they have since told you to drop, pause, or change this work, do what THEY ' +
  'asked and do not resume the plan — this note never outranks a more recent instruction from the user.';

/**
 * Exposes a TeamToolset as an MCP client. listTools() maps the OpenAI-style tool specs to MCP tool
 * defs; callTool() routes back through TeamTools (which delegates over the MessageBus and awaits).
 */
export class TeamMcpBridge implements McpClient {
  constructor(private team: TeamToolset) {}

  async listTools(): Promise<McpToolDef[]> {
    return this.team.specs().map((s: ToolSpec) => ({
      name: s.function.name,
      description: s.function.description,
      inputSchema: s.function.parameters as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const translated = translateLegacyTeamTool(name);
    if (translated !== name) {
      this.team.noteCompatibilityAlias?.(name, translated);
    }
    if (!this.team.has(translated)) {
      return `Error: unknown team tool "${name}".`;
    }
    const out = await this.team.run(translated, args);
    return shouldAppendDelegationContinuation(translated, out)
      ? `${out}\n\n${DELEGATION_RESULT_CONTINUATION_NOTE}`
      : out;
  }

  async close(): Promise<void> {
    this.team.cancelPending?.('delegation cancelled by team bridge shutdown');
  }

  /** Claude's stream backend needs the same report-only closeout state as the in-process backend. */
  coordinatorCloseoutState(): CoordinatorCloseoutState | undefined {
    return this.team.coordinatorCloseoutState?.();
  }

  /** Let the native Claude shell path discharge only acceptances that pre-date its observed passing check. */
  noteCoordinatorVerificationPassed(observedAt?: number): void {
    this.team.noteCoordinatorVerificationPassed?.(observedAt);
  }

  /** Keep Claude-backed coordinators on the same bounded source-handoff contract as in-process ones. */
  setDelegationContentSources(sources: readonly DelegationContentSource[] | undefined): void {
    this.team.setDelegationContentSources?.(sources);
  }

  /** Keep receipt ids turn-local for Claude-backed coordinators just as for in-process ones. */
  beginTurnContentReceipts(): void {
    this.team.beginTurnContentReceipts?.();
  }

  /** Register files-bridge result bytes without exposing the bytes in the model-facing bridge contract. */
  registerTurnContentReceipt(content: string): TurnContentReceipt | undefined {
    return this.team.registerTurnContentReceipt?.(content);
  }

  /** The accepted terminal protocol payload replaces the CLI's unconstrained result text. */
  takePublishedTurnDelivery(): PublishedTurnDelivery | undefined {
    return this.team.takePublishedTurnDelivery?.();
  }

  hasPendingTurnDelivery(): boolean {
    return this.team.hasPendingTurnDelivery?.() === true;
  }

  hasTeammates(): boolean {
    return this.team.hasTeammates?.() === true;
  }

  canCoordinatorExecute(toolName: string): boolean {
    return this.team.canCoordinatorExecute?.(toolName) === true;
  }

  currentCoordinatorTaskAttempt(): TaskAttemptCard | undefined {
    return this.team.currentCoordinatorTaskAttempt?.();
  }

  finishCoordinatorAttempt(state: 'cancelled' | 'settled' = 'settled'): void {
    this.team.finishCoordinatorAttempt?.(state);
  }
}

function shouldAppendDelegationContinuation(name: string, out: string): boolean {
  return name === 'collect_ready_tasks' && !out.includes(DELEGATION_RESULT_CONTINUATION_NOTE);
}

/** A pre-v0.9.52 bridge can name these aliases after the current manifest stopped advertising them. */
function translateLegacyTeamTool(name: string): string {
  switch (name) {
    case 'assign_task':
    case 'assign_task_async':
      // Keep old clients on the explicit legacy compiler. `dispatch_task` intentionally rejects a
      // missing contract; translating straight to it would either break compatibility or tempt the
      // host to infer a capability contract from prose.
      return 'assign_task_async';
    case 'await_tasks':
      return 'collect_ready_tasks';
    default:
      return name;
  }
}
