import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from '../../types';

/**
 * v0.9.99 (B12): after a change or reorder of the editor's first folder, UnodeAi keeps working in the folder it
 * started with until the window reloads. Project state must follow that same root: the team file, the project Team
 * Library and the verification policy are written to and read from the activation-time root, never the new first
 * folder. This runs the real FirstWorkspaceBinding and the real PersistenceManager against a real filesystem.
 */

const editor = vi.hoisted(() => ({ folders: [] as string[] }));

vi.mock('vscode', async () => {
  const nodeFs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const notFound = (error: unknown) => {
    const code = (error as { code?: string }).code;
    return code === 'ENOENT' ? Object.assign(new Error('File not found'), { code: 'FileNotFound' }) : error;
  };
  return {
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ scheme: 'file', fsPath: nodePath.join(base.fsPath, ...parts) }),
    },
    FileType: { File: 1, Directory: 2 },
    workspace: {
      get workspaceFolders() {
        return editor.folders.map((folder, index) => ({ index, name: nodePath.basename(folder), uri: { scheme: 'file', fsPath: folder } }));
      },
      fs: {
        createDirectory: async (uri: { fsPath: string }) => { await nodeFs.mkdir(uri.fsPath, { recursive: true }); },
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => { await nodeFs.writeFile(uri.fsPath, bytes); },
        readFile: async (uri: { fsPath: string }) => {
          try { return await nodeFs.readFile(uri.fsPath); } catch (error) { throw notFound(error); }
        },
        stat: async (uri: { fsPath: string }) => {
          try { await nodeFs.stat(uri.fsPath); return { type: 1 }; } catch (error) { throw notFound(error); }
        },
        readDirectory: async (uri: { fsPath: string }) => {
          try {
            const entries = await nodeFs.readdir(uri.fsPath, { withFileTypes: true });
            return entries.map((entry) => [entry.name, entry.isFile() ? 1 : 2]);
          } catch (error) { throw notFound(error); }
        },
        delete: async (uri: { fsPath: string }) => {
          try { await nodeFs.rm(uri.fsPath); } catch (error) { throw notFound(error); }
        },
      },
    },
    window: { showWarningMessage: vi.fn() },
  };
});

import ts from 'typescript';
import * as vscode from 'vscode';
import { FirstWorkspaceBinding } from '../../backend/WorkspaceBinding';
import { isLegacySingletonCustomAgent } from '../../connections/LegacyCustomGatewayMigration';
import { PersistenceManager, serializeVersionedTeamFile } from '../PersistenceManager';
import type { TeamFileDocument } from '../TeamFileSchema';

let base: string;
let oldRoot: string;
let newRoot: string;

function member(id: string): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'reviewer',
    skill: 'read',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-v4-flash',
    backend: 'openai-compat',
    systemPrompt: 'Review.',
    autoApprove: false,
    allowedTools: ['read'],
  };
}

function teamDocument(memberId: string, command?: string): TeamFileDocument {
  return {
    version: '1.0',
    members: [member(memberId)],
    mcpServers: [],
    workflows: [],
    ...(command ? { completionVerification: { mode: 'command', command } } : {}),
  } as TeamFileDocument;
}

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); },
    keys: () => [...values.keys()],
  };
}

/** The extension's composition: the binding is created from the editor's first folder at activation, and
 *  persistence receives the binding's root (extension.ts passes `() => firstWorkspaceRoot()`). */
function activate() {
  const binding = new FirstWorkspaceBinding(editor.folders[0]);
  const context = { workspaceState: memento(), globalStorageUri: { scheme: 'file', fsPath: path.join(base, 'global') } };
  const persistence = new PersistenceManager(context as never, undefined, () => binding.root());
  return { binding, persistence };
}

/** The editor's first folder changes (a reorder keeps the old one open; a switch removes it). */
function changeFirstFolder(binding: FirstWorkspaceBinding, folders: string[]): void {
  editor.folders = folders;
  expect(binding.observe(editor.folders[0])).toBe(true);
  expect(binding.root()).toBe(oldRoot);
}

const teamFile = (root: string) => path.join(root, '.unode', 'team.json');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-bound-root-')));
  oldRoot = path.join(base, 'project-old');
  newRoot = path.join(base, 'project-new');
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(newRoot, { recursive: true });
  editor.folders = [oldRoot];
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('project persistence after a first-folder change (v0.9.99 B12)', () => {
  it.each([
    ['reordered (the old folder is still open)', () => [newRoot, oldRoot]],
    ['switched (the old folder is no longer open)', () => [newRoot]],
  ])('saves the team into the activation-time root when the first folder is %s', async (_label, folders) => {
    const { binding, persistence } = activate();
    changeFirstFolder(binding, folders());

    await persistence.saveTeamConfig(teamDocument('old-team-member'));

    expect(readJson(teamFile(oldRoot)).members.map((m: AgentConfig) => m.id)).toEqual(['old-team-member']);
    expect(fs.existsSync(path.join(newRoot, '.unode'))).toBe(false);
  });

  it('reads the team and its verification policy from the activation-time root, not the new first folder', async () => {
    fs.mkdirSync(path.join(oldRoot, '.unode'), { recursive: true });
    fs.mkdirSync(path.join(newRoot, '.unode'), { recursive: true });
    fs.writeFileSync(teamFile(oldRoot), serializeVersionedTeamFile(teamDocument('old-member', 'npm test')));
    fs.writeFileSync(teamFile(newRoot), serializeVersionedTeamFile(teamDocument('other-project-member', 'other-project-check')));
    const { binding, persistence } = activate();
    changeFirstFolder(binding, [newRoot, oldRoot]);

    const loaded = await persistence.loadTeamConfig();
    expect(loaded?.members.map((m) => m.id)).toEqual(['old-member']);
    expect(loaded?.completionVerification).toEqual({ mode: 'command', command: 'npm test' });
    expect((await persistence.loadTeamConfigForEdit())?.completionVerification).toEqual({ mode: 'command', command: 'npm test' });
    expect(await persistence.teamFileExists()).toBe(true);
  });

  it('a read/modify/write edit completes in the activation-time root and leaves the other project untouched', async () => {
    fs.mkdirSync(path.join(newRoot, '.unode'), { recursive: true });
    const otherBytes = serializeVersionedTeamFile(teamDocument('other-project-member', 'other-project-check'));
    fs.writeFileSync(teamFile(newRoot), otherBytes);
    const { binding, persistence } = activate();
    await persistence.saveTeamConfig(teamDocument('old-member', 'npm test'));
    changeFirstFolder(binding, [newRoot, oldRoot]);

    // Non-blocking: no "workspace changed / reload" refusal; the edit lands where the team works.
    await persistence.updateTeamConfig((current) => ({ ...current!, completionVerification: { mode: 'disabled' } }));
    await persistence.saveCustomWorkflows([]);

    expect(readJson(teamFile(oldRoot)).completionVerification).toEqual({ mode: 'disabled' });
    expect(fs.readFileSync(teamFile(newRoot), 'utf8')).toBe(otherBytes);
  });

  it('the project Team Library saves, lists and loads in the activation-time root', async () => {
    const { binding, persistence } = activate();
    changeFirstFolder(binding, [newRoot, oldRoot]);
    fs.mkdirSync(path.join(newRoot, '.unode', 'teams'), { recursive: true });
    fs.writeFileSync(path.join(newRoot, '.unode', 'teams', 'other.json'),
      `${JSON.stringify({ label: 'Other project', savedAt: '2026-10-01T00:00:00.000Z', ...JSON.parse(serializeVersionedTeamFile(teamDocument('x'))) })}\n`);

    await persistence.saveTeamToLibrary({ scope: 'workspace', slug: 'mine' }, 'Mine', [member('kept')], '2026-10-27T00:00:00.000Z',
      { document: undefined });

    expect(fs.existsSync(path.join(oldRoot, '.unode', 'teams', 'mine.json'))).toBe(true);
    expect(fs.existsSync(path.join(newRoot, '.unode', 'teams', 'mine.json'))).toBe(false);
    const listed = (await persistence.listSavedTeams()).filter((entry) => entry.scope === 'workspace').map((entry) => entry.slug);
    expect(listed).toEqual(['mine']);
    expect((await persistence.loadSavedTeam({ scope: 'workspace', slug: 'mine' }))?.members.map((m) => m.id)).toEqual(['kept']);
    expect(await persistence.loadSavedTeam({ scope: 'workspace', slug: 'other' })).toBeUndefined();
  });

  it('validates a project save against the activation-time root, so its in-project folder grant is kept', async () => {
    const granted = path.join(oldRoot, 'docs');
    fs.mkdirSync(granted, { recursive: true });
    fs.mkdirSync(path.join(oldRoot, '.unode', 'teams'), { recursive: true });
    const saved = JSON.parse(serializeVersionedTeamFile(teamDocument('with-grant')));
    saved.members[0].folderAccess = [{ path: granted, permission: 'read' }];
    fs.writeFileSync(path.join(oldRoot, '.unode', 'teams', 'granted.json'),
      `${JSON.stringify({ label: 'Granted', savedAt: '2026-10-27T00:00:00.000Z', ...saved })}\n`);
    const { binding, persistence } = activate();
    changeFirstFolder(binding, [newRoot, oldRoot]);

    const loaded = await persistence.loadSavedTeam({ scope: 'workspace', slug: 'granted' });
    expect(loaded?.members[0].folderAccess).toEqual([{ path: granted, permission: 'read' }]);
  });

  it('a window that started without a folder still refuses a team-file write after a folder is added', async () => {
    editor.folders = [];
    const { binding, persistence } = activate();
    editor.folders = [newRoot];
    expect(binding.observe(newRoot)).toBe(true);
    expect(binding.root()).toBeUndefined();

    await expect(persistence.saveTeamConfig(teamDocument('nobody'))).rejects.toThrow('Open a workspace');
    expect(await persistence.loadTeamConfig()).toBeUndefined();
    expect(fs.existsSync(path.join(newRoot, '.unode'))).toBe(false);
  });

  it('a manager built without a root keeps the first folder it saw, never the live one', async () => {
    const context = { workspaceState: memento(), globalStorageUri: { scheme: 'file', fsPath: path.join(base, 'global') } };
    const persistence = new PersistenceManager(context as never);
    await persistence.saveTeamConfig(teamDocument('first'));
    editor.folders = [newRoot, oldRoot];

    await persistence.saveTeamConfig(teamDocument('second'));
    expect(readJson(teamFile(oldRoot)).members.map((m: AgentConfig) => m.id)).toEqual(['second']);
    expect(fs.existsSync(path.join(newRoot, '.unode'))).toBe(false);
  });
});

/**
 * The same invariant through the actual source of extension.ts: the PersistenceManager root argument the extension
 * passes at activation, and the two other project-state readers that used to read the live first folder.
 */
describe('extension.ts binds project state to the activation-time root (v0.9.99 B12)', () => {
  const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  function persistenceRootArgument(): string {
    const found: ts.NewExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'PersistenceManager') found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found).toHaveLength(1);
    return transpile(`(${found[0].arguments![2].getText(source)})`).trim().replace(/;$/, '');
  }

  function functionSource(name: string): string {
    const found = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    expect(found).toHaveLength(1);
    return transpile(found[0].getText(source));
  }

  function host(binding: FirstWorkspaceBinding, getConfiguration = vi.fn()) {
    const h = {
      // The workspace keeps its live workspaceFolders getter, so a live first-folder read would see the change.
      vscode: { ...vscode, workspace: Object.create(vscode.workspace, { getConfiguration: { value: getConfiguration } }) },
      workspaceBinding: binding,
      isLegacySingletonCustomAgent,
    };
    const names = ['firstWorkspaceRoot', 'boundRootUri', 'executionHookCandidateSetting', 'legacyTeamEndpointOverrides'];
    const body = `${names.map(functionSource).join('\n')}\nreturn { rootArgument: ${persistenceRootArgument()}, ${names.join(', ')} };`;
    return new Function('host', `with (host) { ${body} }`)(h) as {
      rootArgument: () => string | undefined;
      executionHookCandidateSetting: () => { value: unknown; origin: string };
      legacyTeamEndpointOverrides: () => Promise<Map<string, string>>;
    };
  }

  it('the PersistenceManager the extension builds saves and loads in the activation-time root after a change', async () => {
    const binding = new FirstWorkspaceBinding(editor.folders[0]);
    const { rootArgument } = host(binding);
    const context = { workspaceState: memento(), globalStorageUri: { scheme: 'file', fsPath: path.join(base, 'global') } };
    const persistence = new PersistenceManager(context as never, undefined, rootArgument);
    changeFirstFolder(binding, [newRoot, oldRoot]);

    await persistence.saveTeamConfig(teamDocument('old-team-member', 'npm test'));
    expect(readJson(teamFile(oldRoot)).completionVerification).toEqual({ mode: 'command', command: 'npm test' });
    expect(fs.existsSync(path.join(newRoot, '.unode'))).toBe(false);
    expect((await persistence.loadTeamConfig())?.members.map((m) => m.id)).toEqual(['old-team-member']);
  });

  it('reads folder-scoped execution hooks of the activation-time root, not the new first folder', () => {
    const binding = new FirstWorkspaceBinding(editor.folders[0]);
    const inspect = vi.fn(() => ({ defaultValue: [] }));
    const getConfiguration = vi.fn(() => ({ inspect }));
    const { executionHookCandidateSetting } = host(binding, getConfiguration);
    changeFirstFolder(binding, [newRoot, oldRoot]);

    executionHookCandidateSetting();
    expect(getConfiguration).toHaveBeenCalledWith('unode', expect.objectContaining({ fsPath: oldRoot }));
  });

  it('reads legacy per-agent endpoints from the activation-time root team file', async () => {
    const legacy = (id: string, baseUrl: string) => ({ id, baseUrl, provider: { providerId: 'custom' } });
    fs.mkdirSync(path.join(oldRoot, '.unode'), { recursive: true });
    fs.mkdirSync(path.join(newRoot, '.unode'), { recursive: true });
    fs.writeFileSync(teamFile(oldRoot), JSON.stringify({ members: [legacy('agent', 'https://old.example/v1')] }));
    fs.writeFileSync(teamFile(newRoot), JSON.stringify({ members: [legacy('agent', 'https://other.example/v1')] }));
    const binding = new FirstWorkspaceBinding(editor.folders[0]);
    const { legacyTeamEndpointOverrides } = host(binding);
    changeFirstFolder(binding, [newRoot, oldRoot]);

    expect([...(await legacyTeamEndpointOverrides())]).toEqual([['agent', 'https://old.example/v1']]);
  });
});
