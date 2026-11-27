/*---------------------------------------------------------------------------------------------
 *  UnodeAi - network for a Codex agent, for this session (v0.9.102, R2, the Owner 2026-11-12)
 *
 *  A Codex agent's sandbox has network off. A card the person answers with "Allow network for this agent for this
 *  session" turns it on for that agent from its next turn. The choice lives in this window's memory only: it is never
 *  written anywhere, so a reload or a new window starts with network off for every agent. Each allow and each removal
 *  changes the agent's revision, so a card or a starting turn that read an older revision cannot use it.
 *--------------------------------------------------------------------------------------------*/

export interface CodexSessionNetworkState {
  allowed: boolean;
  revision: number;
}

export class CodexSessionNetwork {
  private readonly agents = new Map<string, CodexSessionNetworkState>();
  private readonly listeners = new Set<(agentId: string) => void>();
  private counter = 0;

  /** This agent's state now: network off at revision 0 until the person allows it. */
  get(agentId: string): CodexSessionNetworkState {
    return { ...(this.agents.get(agentId) ?? { allowed: false, revision: 0 }) };
  }

  /** The person allowed network for this agent for this session. Returns the new revision. */
  allow(agentId: string): number {
    const revision = ++this.counter;
    this.agents.set(agentId, { allowed: true, revision });
    this.changed(agentId);
    return revision;
  }

  /**
   * Allow from a card that read `expected`: only if nothing changed since (no removal, no other allow). Returns the new
   * revision, or undefined when the card is stale and nothing was changed.
   */
  allowIf(agentId: string, expected: number): number | undefined {
    return this.get(agentId).revision === expected ? this.allow(agentId) : undefined;
  }

  /** The person removed it (Security). The next turn starts without network. Returns whether anything changed. */
  remove(agentId: string): boolean {
    const current = this.agents.get(agentId);
    if (!current?.allowed) return false;
    this.agents.set(agentId, { allowed: false, revision: ++this.counter });
    this.changed(agentId);
    return true;
  }

  /** The agents that have network now, for the Security listing. */
  allowedAgents(): string[] {
    return [...this.agents].filter(([, state]) => state.allowed).map(([agentId]) => agentId);
  }

  onChange(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(agentId: string): void {
    for (const listener of [...this.listeners]) {
      try { listener(agentId); } catch { /* a listener cannot undo the person's choice */ }
    }
  }
}
