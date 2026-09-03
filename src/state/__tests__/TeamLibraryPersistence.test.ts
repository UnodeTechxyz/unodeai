import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from '../../types';

/**
 * The saved-team round trip against a filesystem, rather than against my belief about one.
 *
 * The pure helpers in `TeamLibrary.test.ts` prove how a name is slugged and which snapshots get pruned.
 * They prove nothing about the part that can actually lose someone's team: that a file written by
 * `saveTeamToLibrary` is still readable by `validateTeamFile`, which is a different function with its own
 * opinion about what a team document may contain. Two extra top-level keys ride in that file. If the
 * validator rejected an unknown key — or if the serialiser dropped one — a saved team would list and then
 * fail to open, and no unit test on either side would have noticed.
 */

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  files: new Map<string, Uint8Array>(),
  workspaceRoot: '/workspace',
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: state.workspaceRoot } }]; },
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => { state.files.set(uri.fsPath, data); }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const value = state.files.get(uri.fsPath);
        if (!value) {
          throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        }
        return value;
      }),
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        const prefix = `${uri.fsPath}/`;
        const names = [...state.files.keys()]
          .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map((path) => [path.slice(prefix.length), 1] as [string, number]);
        if (names.length === 0) {
          throw Object.assign(new Error('Directory not found'), { code: 'FileNotFound' });
        }
        return names;
      }),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        if (!state.files.delete(uri.fsPath)) {
          throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        }
      }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import { PersistenceManager } from '../PersistenceManager';
import { automaticSnapshotSlug } from '../TeamLibrary';

const TEAMS = '/workspace/.unode/teams';
const GLOBAL_TEAMS = '/global/teams';

function agent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
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
    ...overrides,
  } as AgentConfig;
}

function context() {
  return {
    globalStorageUri: { fsPath: '/global' },
    workspaceState: {
      get: <T>(key: string, fallback?: T): T | undefined => state.values.has(key)
        ? state.values.get(key) as T
        : fallback,
      update: async (key: string, value: unknown) => {
        if (value === undefined) { state.values.delete(key); } else { state.values.set(key, value); }
      },
      keys: () => [...state.values.keys()],
    },
  } as any;
}

function fileAt(slug: string): Record<string, unknown> {
  const bytes = state.files.get(`${TEAMS}/${slug}.json`);
  expect(bytes, `${slug}.json should exist`).toBeDefined();
  return JSON.parse(Buffer.from(bytes!).toString('utf8')) as Record<string, unknown>;
}

function globalFileAt(slug: string): Record<string, unknown> {
  const bytes = state.files.get(`${GLOBAL_TEAMS}/${slug}.json`);
  expect(bytes, `${slug}.json should exist in the global library`).toBeDefined();
  return JSON.parse(Buffer.from(bytes!).toString('utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  state.values.clear();
  state.files.clear();
  state.workspaceRoot = '/workspace';
});

describe('saving a team and bringing it back', () => {
  it('keeps same-named workspace and global teams distinct, while global saves omit env', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'crew' }, 'Workspace crew', [agent('workspace', { env: { KEEP: 'workspace-only' } })]);
    await manager.saveTeamToLibrary({ scope: 'global', slug: 'crew' }, 'Personal crew', [agent('global', { env: { SECRET: 'never-global' } })]);

    expect((await manager.listSavedTeams()).map((entry) => `${entry.scope}:${entry.slug}`).sort())
      .toEqual(['global:crew', 'workspace:crew']);
    expect((fileAt('crew').members as any[])[0].env).toEqual({ KEEP: 'workspace-only' });
    expect((globalFileAt('crew').members as any[])[0]).not.toHaveProperty('env');
    expect((await manager.loadSavedTeam({ scope: 'workspace', slug: 'crew' }))?.members[0].id).toBe('workspace');
    expect((await manager.loadSavedTeam({ scope: 'global', slug: 'crew' }))?.members[0].id).toBe('global');
  });

  it('strips legacy global MCP and env grants and never places automatic snapshots globally', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamToLibrary({ scope: 'global', slug: 'legacy' }, 'Legacy', [agent('a', { mcpServers: ['same-id'], env: { TOKEN: 'old' } })]);
    const legacy = globalFileAt('legacy');
    (legacy.members as any[])[0].env = { TOKEN: 'from-an-older-global-record' };
    state.files.set(`${GLOBAL_TEAMS}/legacy.json`, Buffer.from(JSON.stringify(legacy), 'utf8'));
    const restored = await manager.loadSavedTeam({ scope: 'global', slug: 'legacy' });
    expect(restored?.members[0]).not.toHaveProperty('mcpServers');
    expect(restored?.members[0]).not.toHaveProperty('env');
    expect(restored?.validationWarnings.join(' ')).toMatch(/0 folder access.*1 MCP.*1 env/i);
    await expect(manager.saveTeamToLibrary({ scope: 'global', slug: automaticSnapshotSlug(new Date()) }, 'Snapshot', [agent('a')]))
      .rejects.toThrow(/always stored in the workspace/i);
  });

  it('re-anchors global folder grants to the target workspace after resolve and realpath', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-global-team-target-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-global-team-outside-'));
    const inside = path.join(target, 'inside');
    const escapeLink = path.join(target, 'escape-link');
    await fs.mkdir(inside);
    await fs.symlink(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    state.workspaceRoot = target;
    try {
      const manager = new PersistenceManager(context());
      await manager.saveTeamToLibrary({ scope: 'global', slug: 'portable' }, 'Portable', [agent('a', {
        folderAccess: [
          { path: outside, permission: 'read' },
          { path: path.join('..', path.basename(outside)), permission: 'read' },
          { path: 'escape-link', permission: 'readwrite' },
          { path: 'inside', permission: 'read' },
        ],
        mcpServers: ['matching-local-id'],
        env: { TOKEN: 'must-not-survive' },
      })]);

      const restored = await manager.loadSavedTeam({ scope: 'global', slug: 'portable' });
      expect(restored?.members[0].folderAccess).toEqual([{ path: 'inside', permission: 'read' }]);
      expect(restored?.members[0]).not.toHaveProperty('mcpServers');
      expect(restored?.members[0]).not.toHaveProperty('env');
      expect(restored?.validationWarnings.join(' ')).toMatch(/3 folder access.*1 MCP.*0 env/i);

      await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'local' }, 'Local', [agent('a', {
        folderAccess: [{ path: outside, permission: 'read' }],
        mcpServers: ['matching-local-id'],
        env: { KEEP: 'workspace-only' },
      })]);
      expect((await manager.loadSavedTeam({ scope: 'workspace', slug: 'local' }))?.members[0])
        .toMatchObject({
          folderAccess: [{ path: outside, permission: 'read' }],
          mcpServers: ['matching-local-id'],
          env: { KEEP: 'workspace-only' },
        });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('survives the full round trip: save, list, open, with the per-agent configuration intact', async () => {
    const manager = new PersistenceManager(context());
    const roster = [
      agent('lead', { name: 'Contract lead', systemPrompt: 'Read the contract first.', maxTokens: 8000 }),
      agent('reviewer', { name: 'Redline reviewer', playbooks: ['skills/legal/clause-playbook-redline'] }),
    ];

    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'contract-crew' }, 'Contract crew', roster, '2026-08-20T09:00:00.000Z');

    const entries = await manager.listSavedTeams();
    expect(entries).toEqual([{
      scope: 'workspace', slug: 'contract-crew', label: 'Contract crew', savedAt: '2026-08-20T09:00:00.000Z', memberCount: 2,
    }]);

    // The part the pure tests could not reach: the validator accepts the file the serialiser wrote.
    const reopened = await manager.loadSavedTeam({ scope: 'workspace', slug: 'contract-crew' });
    expect(reopened?.members.map((member) => member.name)).toEqual(['Contract lead', 'Redline reviewer']);
    expect(reopened?.members[0]).toMatchObject({ systemPrompt: 'Read the contract first.', maxTokens: 8000 });
    expect(reopened?.members[1].playbooks).toEqual(['skills/legal/clause-playbook-redline']);
  });

  // Two keys the team-file schema does not define ride in this file. If it rejected them, or if the reader
  // dropped them, a saved team would list under the wrong name or fail to open at all.
  it('carries its label and date as extra top-level keys the team-file reader tolerates', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'crew' }, 'Crew', [agent('a')], '2026-08-20T09:00:00.000Z');

    const raw = fileAt('crew');
    expect(raw.label).toBe('Crew');
    expect(raw.savedAt).toBe('2026-08-20T09:00:00.000Z');
    expect(raw.version).toBe('1.0');
    await expect(manager.loadSavedTeam({ scope: 'workspace', slug: 'crew' })).resolves.toMatchObject({ members: [{ id: 'a' }] });
  });

  /**
   * A saved team is a roster. Restoring applies `members` and nothing else, so writing the workspace's own
   * MCP servers and workflows into the file would promise a restore that never happens — and would put this
   * workspace's server command lines into a file meant to travel through git to a colleague.
   */
  it('saves the roster only, not the workspace configuration around it', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig({
      members: [agent('a')],
      mcpServers: [{ id: 'private', name: 'Private', transport: 'stdio', command: 'node', args: ['/srv/internal.js'] }],
      workflows: [],
    } as any);

    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'crew' }, 'Crew', [agent('a')]);

    const raw = fileAt('crew');
    expect(raw.mcpServers).toEqual([]);
    expect(raw.workflows).toEqual([]);
    expect(JSON.stringify(raw)).not.toContain('/srv/internal.js');
  });

  it('lists newest first, marks the host-written snapshots, and deletes the one it is asked to', async () => {
    const manager = new PersistenceManager(context());
    const auto = automaticSnapshotSlug(new Date('2026-08-20T11:00:00.000Z'));

    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'older' }, 'Older', [agent('a')], '2026-08-20T09:00:00.000Z');
    await manager.saveTeamToLibrary({ scope: 'workspace', slug: auto }, 'Before switching · 1 agent', [agent('b')], '2026-08-20T11:00:00.000Z');

    expect((await manager.listSavedTeams()).map((entry) => [entry.slug, entry.automatic ?? false]))
      .toEqual([[auto, true], ['older', false]]);

    await manager.deleteSavedTeam({ scope: 'workspace', slug: auto });
    expect((await manager.listSavedTeams()).map((entry) => entry.slug)).toEqual(['older']);
  });

  it('reports nothing rather than throwing when no team has ever been saved', async () => {
    await expect(new PersistenceManager(context()).listSavedTeams()).resolves.toEqual([]);
    await expect(new PersistenceManager(context()).loadSavedTeam({ scope: 'workspace', slug: 'missing' })).resolves.toBeUndefined();
    // Deleting something already gone is the state the caller wanted; it is not an error.
    await expect(new PersistenceManager(context()).deleteSavedTeam({ scope: 'workspace', slug: 'missing' })).resolves.toBeUndefined();
  });

  // A file edited by hand into something the schema refuses must not be offered as restorable: opening it
  // would build a roster the user never saved, which is worse than being told it is missing.
  it('skips a saved file that no longer validates instead of repairing it', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamToLibrary({ scope: 'workspace', slug: 'good' }, 'Good', [agent('a')], '2026-08-20T09:00:00.000Z');
    state.files.set(`${TEAMS}/broken.json`, Buffer.from('{ not json', 'utf8'));

    expect((await manager.listSavedTeams()).map((entry) => entry.slug)).toEqual(['good']);
    await expect(manager.loadSavedTeam({ scope: 'workspace', slug: 'broken' })).resolves.toBeUndefined();
    // Left on disk exactly as it was — the user may want to fix it.
    expect(state.files.has(`${TEAMS}/broken.json`)).toBe(true);
  });
});
