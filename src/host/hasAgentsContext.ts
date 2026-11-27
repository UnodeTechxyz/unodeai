/**
 * v0.9.106 quiet first screen: the `unode.hasAgents` context key is true while the roster holds at least one agent.
 * The manifest reads it to show the Chat and Team title-bar icons and the Activity view only once there is a team;
 * it changes presentation only, never a permission or a stored value.
 */
export const HAS_AGENTS_CONTEXT_KEY = 'unode.hasAgents';

export interface HasAgentsContextDeps {
  /** How many agents the roster holds now. */
  agentCount(): number;
  /** Sets a VS Code context key (`setContext`). */
  setContext(key: string, value: boolean): void;
}

export interface RosterEvents {
  on(event: 'session.created' | 'session.removed', listener: () => void): unknown;
}

export interface HasAgentsContext {
  /** Recomputes the key from the roster and sets it when it differs from the value last set. Returns the value. */
  sync(): boolean;
}

export function createHasAgentsContext(deps: HasAgentsContextDeps): HasAgentsContext {
  let last: boolean | undefined;
  return {
    sync(): boolean {
      const value = deps.agentCount() > 0;
      if (value !== last) {
        last = value;
        deps.setContext(HAS_AGENTS_CONTEXT_KEY, value);
      }
      return value;
    },
  };
}

/** Every agent added to or removed from the roster passes through these two events, so they keep the key current. */
export function followRoster(events: RosterEvents, context: HasAgentsContext): void {
  events.on('session.created', () => { context.sync(); });
  events.on('session.removed', () => { context.sync(); });
}
