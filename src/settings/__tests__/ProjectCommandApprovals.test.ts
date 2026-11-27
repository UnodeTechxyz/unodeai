import { describe, expect, it } from 'vitest';
import {
  PROJECT_COMMAND_APPROVALS_KEY,
  PROJECT_COMMAND_APPROVALS_V2_KEY,
  ProjectCommandApprovals,
  WorkspaceMemento,
} from '../ProjectCommandApprovals';
import { workspaceRootIdentity } from '../../state/WorkspaceRootIdentity';

function memory(seed: Record<string, unknown> = {}): WorkspaceMemento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(seed));
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
}

const ONE = 'C:\\work\\one';

describe('ProjectCommandApprovals', () => {
  it('retains normalized approvals for the same workspace', async () => {
    const store = new ProjectCommandApprovals(memory(), () => ONE);
    await expect(store.approve({ grammar: 'posix', template: ' Git Status ' })).resolves.toBe(true);
    await store.approve({ grammar: 'posix', template: 'git status' });
    expect(store.list()).toEqual([{ grammar: 'posix', template: 'git status' }]);
  });

  it('keeps the same template under two grammars as two separate approvals', async () => {
    const store = new ProjectCommandApprovals(memory(), () => ONE);
    await store.approve({ grammar: 'powershell', template: 'copy-item' });
    await store.approve({ grammar: 'cmd', template: 'npm test' });
    await store.approve({ grammar: 'posix', template: 'npm test' });
    expect(store.list()).toEqual([
      { grammar: 'powershell', template: 'copy-item' },
      { grammar: 'cmd', template: 'npm test' },
      { grammar: 'posix', template: 'npm test' },
    ]);
  });

  it('does not carry an approval to another first workspace folder', async () => {
    const state = memory();
    let root = ONE;
    const store = new ProjectCommandApprovals(state, () => root);
    await store.approve({ grammar: 'cmd', template: 'npm test' });
    root = 'C:\\work\\two';
    expect(store.list()).toEqual([]);
  });

  it('enables execution and seeds approvals only for the current project', async () => {
    const state = memory();
    let root = ONE;
    const store = new ProjectCommandApprovals(state, () => root);
    await expect(store.enableExecution([
      { grammar: 'cmd', template: 'NPM Test' },
      { grammar: 'posix', template: 'git status' },
    ])).resolves.toBe(true);
    expect(store.isExecutionEnabled()).toBe(true);
    expect(store.list()).toEqual([{ grammar: 'cmd', template: 'npm test' }, { grammar: 'posix', template: 'git status' }]);
    root = 'C:\\work\\two';
    expect(store.isExecutionEnabled()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('revokes a saved project approval without affecting execution mode', async () => {
    const store = new ProjectCommandApprovals(memory(), () => ONE);
    await store.enableExecution([{ grammar: 'cmd', template: 'npm test' }, { grammar: 'posix', template: 'npm test' }]);
    await expect(store.revoke({ grammar: 'cmd', template: 'NPM TEST' })).resolves.toBe(true);
    // Exactly the displayed key goes; the same template under another grammar stays.
    expect(store.list()).toEqual([{ grammar: 'posix', template: 'npm test' }]);
    expect(store.isExecutionEnabled()).toBe(true);
    await expect(store.revoke({ grammar: 'powershell', template: 'npm test' })).resolves.toBe(false);
  });

  it('can revoke the project execution opt-in and all commands together', async () => {
    const store = new ProjectCommandApprovals(memory(), () => ONE);
    await store.enableExecution([{ grammar: 'cmd', template: 'npm test' }, { grammar: 'posix', template: 'git status' }]);
    await expect(store.disableExecution()).resolves.toBe(true);
    expect(store.isExecutionEnabled()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('refuses to create a project approval when no folder is open', async () => {
    const store = new ProjectCommandApprovals(memory(), () => undefined);
    await expect(store.approve({ grammar: 'cmd', template: 'npm test' })).resolves.toBe(false);
    expect(store.list()).toEqual([]);
  });

  describe('v1 upgrade (v0.9.96)', () => {
    const v1 = (commands: string[], executionEnabled?: boolean) => ({
      [PROJECT_COMMAND_APPROVALS_KEY]: {
        version: 1,
        workspaceId: workspaceRootIdentity(ONE),
        commands,
        ...(executionEnabled === undefined ? {} : { executionEnabled }),
      },
    });

    it('a v1 record keeps its execution opt-in but grants no command, because it never recorded a shell', () => {
      const store = new ProjectCommandApprovals(memory(v1(['npm test', 'copy-item'], true)), () => ONE);
      expect(store.isExecutionEnabled()).toBe(true);
      expect(store.list()).toEqual([]);
    });

    it('the first update writes a v2 record from the v1 opt-in and leaves the v1 record as it was', async () => {
      const state = memory(v1(['npm test'], true));
      const before = JSON.stringify(state.values.get(PROJECT_COMMAND_APPROVALS_KEY));
      const store = new ProjectCommandApprovals(state, () => ONE);
      await store.approve({ grammar: 'powershell', template: 'Copy-Item' });
      expect(state.values.get(PROJECT_COMMAND_APPROVALS_V2_KEY)).toEqual({
        version: 2,
        workspaceId: workspaceRootIdentity(ONE),
        approvals: [{ grammar: 'powershell', template: 'copy-item' }],
        executionEnabled: true,
      });
      expect(JSON.stringify(state.values.get(PROJECT_COMMAND_APPROVALS_KEY))).toBe(before);
      expect(store.list()).toEqual([{ grammar: 'powershell', template: 'copy-item' }]);
    });

    it('disabling execution clears the v2 grants and a retained v1 record cannot bring them back', async () => {
      const state = memory(v1(['npm test'], true));
      const store = new ProjectCommandApprovals(state, () => ONE);
      await store.enableExecution([{ grammar: 'cmd', template: 'npm test' }]);
      await expect(store.disableExecution()).resolves.toBe(true);
      expect(state.values.get(PROJECT_COMMAND_APPROVALS_KEY)).toBeDefined();
      expect(store.isExecutionEnabled()).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it('a present but malformed v2 record fails closed and does not fall back to v1', () => {
      for (const malformed of [
        'not a record',
        { version: 2, workspaceId: workspaceRootIdentity(ONE), approvals: [{ grammar: 'any', template: 'npm test' }], executionEnabled: true },
        { version: 2, workspaceId: workspaceRootIdentity(ONE), approvals: [{ grammar: 'neutral', template: 'npm test' }], executionEnabled: true },
        { version: 2, workspaceId: workspaceRootIdentity(ONE), approvals: 'npm test', executionEnabled: true },
        { version: 2, workspaceId: workspaceRootIdentity(ONE), approvals: [], executionEnabled: 'yes' },
      ]) {
        const state = memory({ ...v1(['npm test'], true), [PROJECT_COMMAND_APPROVALS_V2_KEY]: malformed });
        const store = new ProjectCommandApprovals(state, () => ONE);
        expect(store.isExecutionEnabled(), JSON.stringify(malformed)).toBe(false);
        expect(store.list(), JSON.stringify(malformed)).toEqual([]);
      }
    });
  });
});
