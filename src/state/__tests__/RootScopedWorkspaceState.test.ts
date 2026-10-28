import { describe, expect, it } from 'vitest';
import {
  classifyLegacyWorkspaceStateHost,
  GLOBAL_WORKSPACE_STATE_KEYS,
  RootScopedWorkspaceState,
  ROOT_STATE_PREFIX,
  type KeyedWorkspaceMemento,
} from '../RootScopedWorkspaceState';

function memory(initial: Record<string, unknown> = {}): KeyedWorkspaceMemento & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(key: string, fallback?: T): T | undefined => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
    keys: () => [...values.keys()],
  } as KeyedWorkspaceMemento & { values: Map<string, unknown> };
}

describe('RootScopedWorkspaceState', () => {
  it('isolates fixed and dynamic keys in one reused backing bucket', async () => {
    const backing = memory();
    const rootA = new RootScopedWorkspaceState(backing, 'C:\\projects\\a');
    const rootB = new RootScopedWorkspaceState(backing, 'C:\\projects\\b');

    await rootA.update('roam.agents', [{ id: 'a' }]);
    await rootA.update('roam.chat.tools.agent-a', [{ id: 'tool-a' }]);
    await rootB.update('roam.agents', [{ id: 'b' }]);

    expect(rootA.get('roam.agents')).toEqual([{ id: 'a' }]);
    expect(rootB.get('roam.agents')).toEqual([{ id: 'b' }]);
    expect(rootB.get('roam.chat.tools.agent-a', [])).toEqual([]);
    expect(rootA.keys().sort()).toEqual(['roam.agents', 'roam.chat.tools.agent-a']);
    expect(rootB.keys()).toEqual(['roam.agents']);
    expect([...backing.values.keys()].every((key) => key.startsWith(ROOT_STATE_PREFIX))).toBe(true);
  });

  it('keeps content, restore, run, authority, policy and migration state isolated across both switch directions and reload', async () => {
    const backing = memory();
    const rootA = new RootScopedWorkspaceState(backing, 'C:\\projects\\a');
    const rootB = new RootScopedWorkspaceState(backing, 'C:\\projects\\b');
    const planted = new Map<string, unknown>([
      ['roam.agents', [{ id: 'agent-a' }]],
      ['roam.chat.agent-a', [{ role: 'user', text: 'root-a' }]],
      ['roam.chat.tools.agent-a', [{ tool: 'read_file' }]],
      ['roam.chat.reasoning.agent-a', [{ text: 'reason-a' }]],
      ['roam.checkpoints', { nextId: 2, checkpoints: [{ id: 1, path: 'a.txt', before: 'a' }] }],
      ['roam.pendingDelegationResults', [{ handle: 'task-a' }]],
      ['roam.runs.merged.v8', [{ runId: 'run-a' }]],
      ['roam.runs.host.window-a', [{ runId: 'host-run-a' }]],
      ['unode.approvedMcpServers', ['approved-a']],
      ['unode.hostMcpServers.v1', [{ id: 'server-a', command: 'host-a' }]],
      ['unode.teamPolicy.v1', { concurrency: 'sequential' }],
      ['unode.executionHooks.approval.v1', { digest: 'approval-a' }],
      ['unode.integrationEvidence.v1', [{ serverId: 'server-a' }]],
      ['unode.migration.mcpState.v0_9_81', true],
      ['unode.migration.legacyCustomGateway.v1', { phase: 'a' }],
    ]);
    for (const [key, value] of planted) await rootA.update(key, value);

    for (const key of planted.keys()) expect(rootB.get(key)).toBeUndefined();
    await rootB.update('roam.agents', [{ id: 'agent-b' }]);
    await rootB.update('roam.checkpoints', { nextId: 1, checkpoints: [] });
    await rootB.update('unode.approvedMcpServers', ['approved-b']);

    const reloadedA = new RootScopedWorkspaceState(backing, 'C:\\projects\\a');
    for (const [key, value] of planted) expect(reloadedA.get(key)).toEqual(value);
    expect(reloadedA.get('roam.agents')).toEqual([{ id: 'agent-a' }]);
    expect(rootB.get('roam.agents')).toEqual([{ id: 'agent-b' }]);
    expect(rootB.get('unode.approvedMcpServers')).toEqual(['approved-b']);
  });

  it('fails closed without a bound root', async () => {
    const backing = memory({ 'roam.agents': [{ id: 'legacy' }] });
    const state = new RootScopedWorkspaceState(backing, undefined);
    expect(state.get('roam.agents', [])).toEqual([]);
    expect(state.keys()).toEqual([]);
    await expect(state.update('roam.agents', [])).rejects.toThrow(/no project state was written/i);
    expect(backing.values.get('roam.agents')).toEqual([{ id: 'legacy' }]);
  });

  it('stops every read, enumeration, and write after the bound root is invalidated', async () => {
    const backing = memory();
    let available = true;
    const state = new RootScopedWorkspaceState(backing, 'C:\\projects\\a', () => available);
    await state.update('roam.agents', [{ id: 'a' }]);
    available = false;

    expect(state.get('roam.agents', [])).toEqual([]);
    expect(state.keys()).toEqual([]);
    await expect(state.update('roam.messages', [])).rejects.toThrow(/no project state was written/i);
  });

  it.each(['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor']) (
    'imports v0.9.81 workspace-local state for %s without exposing the raw fallback',
    async (appName) => {
      const backing = memory({
        'roam.agents': [{ id: 'legacy' }],
        'roam.chat.agent': [{ role: 'user', text: 'legacy' }],
        'unode.workbenchInspectorOpen': true,
      });
      const state = new RootScopedWorkspaceState(backing, 'C:\\projects\\same');
      const imported = await state.importLegacyWorkspaceLocalState(classifyLegacyWorkspaceStateHost(appName));

      expect(imported.sort()).toEqual(['roam.agents', 'roam.chat.agent']);
      expect(state.get('roam.agents')).toEqual([{ id: 'legacy' }]);
      expect(backing.values.has('roam.agents')).toBe(false);
      expect(backing.values.get('unode.workbenchInspectorOpen')).toBe(true);
      expect(GLOBAL_WORKSPACE_STATE_KEYS.has('unode.workbenchInspectorOpen')).toBe(true);
    },
  );

  it('does not import or fall back to old state in Devin or an unknown host', async () => {
    const backing = memory({
      'roam.agents': [{ id: 'foreign' }],
      'roam.checkpoints': { 1: { path: 'foreign.txt', content: 'foreign' } },
      'unode.approvedMcpServers': ['foreign-server'],
    });
    const state = new RootScopedWorkspaceState(backing, 'C:\\projects\\new-root');

    expect(classifyLegacyWorkspaceStateHost('Devin')).toBe('other');
    await expect(state.importLegacyWorkspaceLocalState(classifyLegacyWorkspaceStateHost('Devin'))).resolves.toEqual([]);
    expect(state.get('roam.agents', [])).toEqual([]);
    expect(state.get('roam.checkpoints')).toBeUndefined();
    expect(state.get('unode.approvedMcpServers', [])).toEqual([]);
    expect(backing.values.has('roam.agents')).toBe(true);
  });

  it('keeps reset-style enumeration inside the current root namespace', async () => {
    const backing = memory();
    const rootA = new RootScopedWorkspaceState(backing, 'C:\\projects\\a');
    const rootB = new RootScopedWorkspaceState(backing, 'C:\\projects\\b');
    await rootA.update('roam.agents', [{ id: 'a' }]);
    await rootA.update('roam.snapshot.a', { messages: [] });
    await rootB.update('roam.agents', [{ id: 'b' }]);

    for (const key of rootA.keys()) await rootA.update(key, undefined);

    expect(rootA.keys()).toEqual([]);
    expect(rootB.get('roam.agents')).toEqual([{ id: 'b' }]);
  });
});
