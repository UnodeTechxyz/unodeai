import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOOL_ALWAYS_ALLOW_KEY, AgentToolAlwaysAllow } from '../AgentToolAlwaysAllow';

function memoryState(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [[AGENT_TOOL_ALWAYS_ALLOW_KEY, initial]]);
  return { values, get: (key: string) => values.get(key), update: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
}

describe('v0.9.99 B7: AgentToolAlwaysAllow', () => {
  it('restores kept answers per agent after a reload and ignores anything malformed', () => {
    const state = memoryState({ dev: ['MCP__GitHub__Create_Issue', 7, ''], qa: 'not-a-list', '': ['x'] });
    const store = new AgentToolAlwaysAllow(state);
    expect(store.forAgent('dev').has('mcp__github__create_issue')).toBe(true);
    expect(store.forAgent('qa').has('mcp__github__create_issue')).toBe(false);
    expect(store.list('dev')).toEqual(['mcp__github__create_issue']);
  });

  it('saves a new answer, forgets one tool or the whole agent, and keeps an answer when the save fails', async () => {
    const state = memoryState();
    const failed = vi.fn();
    const store = new AgentToolAlwaysAllow(state, failed);
    store.forAgent('dev').remember('mcp__docs__search');
    store.forAgent('dev').remember('mcp__docs__fetch');
    await vi.waitFor(() => expect(state.values.get(AGENT_TOOL_ALWAYS_ALLOW_KEY)).toEqual({ dev: ['mcp__docs__fetch', 'mcp__docs__search'] }));
    await expect(store.forget('dev', 'mcp__docs__fetch')).resolves.toBe(true);
    expect(state.values.get(AGENT_TOOL_ALWAYS_ALLOW_KEY)).toEqual({ dev: ['mcp__docs__search'] });
    await expect(store.forget('dev')).resolves.toBe(true);
    expect(state.values.get(AGENT_TOOL_ALWAYS_ALLOW_KEY)).toEqual({});
    state.update.mockRejectedValueOnce(new Error('storage unavailable'));
    store.forAgent('qa').remember('mcp__docs__search');
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(store.forAgent('qa').has('mcp__docs__search')).toBe(true);
  });
});
