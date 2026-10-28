import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const state = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), values: new Map<string, unknown>(), root: '/workspace' }));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: state.root } }]; },
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => { state.files.set(uri.fsPath, data); }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = state.files.get(uri.fsPath);
        if (!bytes) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        return bytes;
      }),
      stat: vi.fn(async (uri: { fsPath: string }) => {
        if (!state.files.has(uri.fsPath)) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        return { type: 1 };
      }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import { PersistenceManager, serializeVersionedTeamFile } from '../PersistenceManager';
import { validateTeamFile, TeamVerificationConfigurationError, type TeamFileDocument } from '../TeamFileSchema';
import { automaticSnapshotSlug } from '../TeamLibrary';
import { TeamVerificationEditor } from '../../host/TeamVerificationEditor';

const context = () => ({ globalStorageUri: { fsPath: '/global' }, workspaceState: {
  get: (key: string, fallback: unknown) => state.values.get(key) ?? fallback,
  update: async (key: string, value: unknown) => { state.values.set(key, value); }, keys: () => [...state.values.keys()],
} }) as any;
const document = (completionVerification?: TeamFileDocument['completionVerification']): TeamFileDocument => ({
  version: '1.0', members: [], mcpServers: [], workflows: [], ...(completionVerification ? { completionVerification } : {}),
});
const read = (path = `${state.root}/.unode/team.json`) => JSON.parse(Buffer.from(state.files.get(path)!).toString('utf8'));

beforeEach(() => { state.files.clear(); state.values.clear(); state.root = '/workspace'; });

describe('completion verification persistence (SPEC V02/V03)', () => {
  it.each([undefined, { mode: 'disabled' } as const, { mode: 'auto' } as const,
    { mode: 'command', command: 'npm run ci' } as const])('keeps %j through real writers and readers', async (policy) => {
    const manager = new PersistenceManager(context());
    const doc = document(policy);
    expect(validateTeamFile(JSON.parse(serializeVersionedTeamFile(doc))).completionVerification).toEqual(policy);
    await manager.saveTeamConfig(doc);
    expect((await manager.loadTeamConfig())?.completionVerification).toEqual(policy);
    await manager.saveCustomWorkflows([]);
    expect(read().completionVerification).toEqual(policy);
    await manager.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } });
    expect(read().completionVerification).toEqual(policy);
    for (const ref of [
      { scope: 'workspace', slug: 'manual' } as const,
      { scope: 'global', slug: 'shared' } as const,
      { scope: 'workspace', slug: automaticSnapshotSlug(new Date('2026-10-22T00:00:00Z')) } as const,
    ]) {
      await manager.saveTeamToLibrary(ref, 'Test', []);
      const loaded = await manager.loadSavedTeam(ref);
      expect(loaded?.completionVerification).toEqual(policy);
      expect(Object.hasOwn(loaded!, 'completionVerification')).toBe(policy !== undefined);
    }
    expect(Object.hasOwn(read(), 'completionVerification')).toBe(policy !== undefined);
  });

  it('copies a global saved policy into two independently editable workspace documents', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig(document({ mode: 'command', command: 'npm test' }));
    await manager.saveTeamToLibrary({ scope: 'global', slug: 'shared' }, 'Shared', []);
    const savedBytes = Buffer.from(state.files.get('/global/teams/shared.json')!);
    // v0.9.99: a window's persistence stays on the project it started with, so each project is its own window.
    const windows = new Map<string, PersistenceManager>();
    for (const root of ['/one', '/two']) {
      state.root = root;
      const window = new PersistenceManager(context());
      windows.set(root, window);
      await window.saveTeamConfig((await window.loadSavedTeam({ scope: 'global', slug: 'shared' }))!);
    }
    const one = windows.get('/one')!;
    await one.saveTeamConfig({ ...(await one.loadTeamConfig())!, completionVerification: { mode: 'disabled' } });
    expect(read('/one/.unode/team.json').completionVerification).toEqual({ mode: 'disabled' });
    expect(read('/two/.unode/team.json').completionVerification).toEqual({ mode: 'command', command: 'npm test' });
    expect(Buffer.from(state.files.get('/global/teams/shared.json')!)).toEqual(savedBytes);
  });

  it.each([null, {}, { mode: 'auto', allow: true }, { mode: 'command', command: 'npm test\n' }])('invalid %j is not "missing" on load/save or an unrelated edit', async (policy) => {
    const raw = { ...document(), completionVerification: policy };
    expect(() => validateTeamFile(raw)).toThrow(TeamVerificationConfigurationError);
    expect(() => serializeVersionedTeamFile(raw as TeamFileDocument)).toThrow(TeamVerificationConfigurationError);
    const bytes = Buffer.from(JSON.stringify(raw));
    state.files.set('/workspace/.unode/team.json', bytes);
    const manager = new PersistenceManager(context());
    await expect(manager.loadTeamConfig()).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    await expect(manager.saveCustomWorkflows([])).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    await expect(manager.saveSmartCompactionProfiles(undefined)).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    await expect(manager.saveTeamToLibrary({ scope: 'global', slug: 'bad' }, 'Bad', [])).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    expect(state.files.get('/workspace/.unode/team.json')).toEqual(bytes);
    expect(state.files.has('/global/teams/bad.json')).toBe(false);
  });

  it('guards five inline writers and the delegated TeamVerificationEditor writer against the queued document', async () => {
    const source = readFileSync(resolve('src/extension.ts'), 'utf8');
    const tree = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        expect(node.expression.getText(tree)).not.toBe('persistence.saveTeamConfig');
        if (node.expression.getText(tree) === 'persistence.updateTeamConfig') calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    const delegated = calls.filter(call => ts.isArrowFunction(call.parent)
      && ts.isPropertyAssignment(call.parent.parent) && call.parent.parent.name.getText(tree) === 'updateDocument');
    expect(delegated).toHaveLength(1);
    expect(delegated[0].arguments[0].getText(tree)).toBe('edit');
    const inline = calls.filter(call => call !== delegated[0]);
    expect(inline).toHaveLength(5);
    expect(calls).toHaveLength(6);
    for (const call of inline) {
      // Each callback must keep the document it receives INSIDE the admission queue, not an outer read.
      expect(call.arguments[0].getText(tree)).toMatch(/\.\.\.(?:current!?\b|currentTeam\b|completionVerificationFields\(current\))/);
    }
    expect(calls.filter((call) => call.arguments.length === 2)).toHaveLength(3);

    // Execute the real extension delegate AND real editor callback through the real persistence queue.
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig(document({ mode: 'auto' }));
    const callback = ts.transpileModule(delegated[0].parent.getText(tree), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText.trim().replace(/;$/, '');
    const updateDocument = new Function('persistence', `return (${callback});`)(manager);
    const editor = new TeamVerificationEditor({ workspaceRoot: () => state.root, rosterRevision: () => 1,
      isCurrentWorkspace: () => true, skills: () => [], members: () => [], configuration: () => ({ inspect: () => ({}) }),
      readDocument: () => manager.loadTeamConfigForEdit(), updateDocument });
    const view = await editor.prepare();
    if (view.kind !== 'ready' || !view.editToken) throw new Error('editor did not offer a live token');
    await manager.updateTeamConfig(current => ({ ...current!, smartCompactionProfiles: { balanced: { windowPercent: 63 } } }));
    const latest = await manager.loadTeamConfig();
    await editor.save(view.editToken, { mode: 'disabled' });
    expect(await manager.loadTeamConfig()).toEqual({ ...latest, completionVerification: { mode: 'disabled' } });
  });
});
