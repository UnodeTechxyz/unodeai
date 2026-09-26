import { describe, expect, it } from 'vitest';
import { ProjectCommandApprovals, WorkspaceMemento } from '../ProjectCommandApprovals';

function memory(): WorkspaceMemento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
}

describe('ProjectCommandApprovals', () => {
  it('retains normalized approvals for the same workspace', async () => {
    const store = new ProjectCommandApprovals(memory(), () => 'C:\\work\\one');
    await expect(store.approve(' Git Status ')).resolves.toBe(true);
    await store.approve('git status');
    expect(store.list()).toEqual(['git status']);
  });

  it('does not carry an approval to another first workspace folder', async () => {
    const state = memory();
    let root = 'C:\\work\\one';
    const store = new ProjectCommandApprovals(state, () => root);
    await store.approve('npm test');
    root = 'C:\\work\\two';
    expect(store.list()).toEqual([]);
  });

  it('enables execution and seeds approvals only for the current project', async () => {
    const state = memory();
    let root = 'C:\\work\\one';
    const store = new ProjectCommandApprovals(state, () => root);
    await expect(store.enableExecution(['NPM Test', 'git status'])).resolves.toBe(true);
    expect(store.isExecutionEnabled()).toBe(true);
    expect(store.list()).toEqual(['npm test', 'git status']);
    root = 'C:\\work\\two';
    expect(store.isExecutionEnabled()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('revokes a saved project approval without affecting execution mode', async () => {
    const store = new ProjectCommandApprovals(memory(), () => 'C:\\work\\one');
    await store.enableExecution(['npm test', 'git status']);
    await expect(store.revoke('NPM TEST')).resolves.toBe(true);
    expect(store.list()).toEqual(['git status']);
    expect(store.isExecutionEnabled()).toBe(true);
  });

  it('can revoke the project execution opt-in and all commands together', async () => {
    const store = new ProjectCommandApprovals(memory(), () => 'C:\\work\\one');
    await store.enableExecution(['npm test', 'git status']);
    await expect(store.disableExecution()).resolves.toBe(true);
    expect(store.isExecutionEnabled()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('refuses to create a project approval when no folder is open', async () => {
    const store = new ProjectCommandApprovals(memory(), () => undefined);
    await expect(store.approve('npm test')).resolves.toBe(false);
    expect(store.list()).toEqual([]);
  });
});
