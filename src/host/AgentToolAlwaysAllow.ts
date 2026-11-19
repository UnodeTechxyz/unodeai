/**
 * v0.9.99: "Always allow this tool" on a Claude agent's approval card, kept across restarts.
 *
 * The card asks about one tool for one agent, so the answer is kept for exactly that: this agent, in this project
 * (workspace storage). It is not machine-wide and not crew-wide. Before v0.9.99 it lasted only as long as the
 * agent's Claude process, so every restart asked about each of the person's own MCP tools again.
 *
 * Only an allow given by a person on the card is stored; a deny is never stored here. The Security panel lists
 * the stored tools per agent and revokes them one by one; removing the agent forgets its tools.
 */

export const AGENT_TOOL_ALWAYS_ALLOW_KEY = 'unode.claudeToolAlwaysAllow.v1';

export interface AgentToolAlwaysAllowState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** What one agent's backend sees: lookups are synchronous, a remembered answer is saved in the background. */
export interface AgentToolMemory {
  has(toolName: string): boolean;
  remember(toolName: string): void;
}

const MAX_TOOL_NAME = 256;

function normalizeTool(toolName: string): string | undefined {
  const key = toolName.trim().toLowerCase();
  return key && key.length <= MAX_TOOL_NAME ? key : undefined;
}

export class AgentToolAlwaysAllow {
  private readonly byAgent = new Map<string, Set<string>>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: AgentToolAlwaysAllowState,
    private readonly onSaveFailed: (error: unknown) => void = () => {},
  ) {
    const raw = state.get(AGENT_TOOL_ALWAYS_ALLOW_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [agentId, tools] of Object.entries(raw as Record<string, unknown>)) {
      if (!agentId || !Array.isArray(tools)) continue;
      const set = new Set(tools.flatMap((tool) => typeof tool === 'string' ? [normalizeTool(tool)].filter((t): t is string => !!t) : []));
      if (set.size > 0) this.byAgent.set(agentId, set);
    }
  }

  forAgent(agentId: string): AgentToolMemory {
    return {
      has: (toolName) => {
        const key = normalizeTool(toolName);
        return !!key && this.byAgent.get(agentId)?.has(key) === true;
      },
      remember: (toolName) => {
        const key = normalizeTool(toolName);
        if (!key) return;
        const tools = this.byAgent.get(agentId) ?? new Set<string>();
        if (tools.has(key)) return;
        tools.add(key);
        this.byAgent.set(agentId, tools);
        void this.save();
      },
    };
  }

  list(agentId: string): string[] {
    return [...(this.byAgent.get(agentId) ?? [])].sort();
  }

  /** Forget one tool, or every tool of the agent when `toolName` is omitted. True when something was forgotten. */
  async forget(agentId: string, toolName?: string): Promise<boolean> {
    const tools = this.byAgent.get(agentId);
    if (!tools) return false;
    let changed: boolean;
    if (toolName === undefined) {
      changed = this.byAgent.delete(agentId);
    } else {
      const key = normalizeTool(toolName);
      changed = !!key && tools.delete(key);
      if (tools.size === 0) this.byAgent.delete(agentId);
    }
    if (changed) await this.save();
    return changed;
  }

  /** Saves are serialised so the last state always wins; a failed save is reported and the answer still holds now. */
  private save(): Promise<void> {
    const snapshot = Object.fromEntries([...this.byAgent].map(([agentId, tools]) => [agentId, [...tools].sort()]));
    this.saving = this.saving
      .then(() => this.state.update(AGENT_TOOL_ALWAYS_ALLOW_KEY, snapshot))
      .catch((error) => this.onSaveFailed(error));
    return this.saving;
  }
}
