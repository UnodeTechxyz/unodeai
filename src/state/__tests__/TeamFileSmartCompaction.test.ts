import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  files: new Map<string, Uint8Array>(),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => { state.files.set(uri.fsPath, data); }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const value = state.files.get(uri.fsPath);
        if (!value) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        return value;
      }),
      stat: vi.fn(async (uri: { fsPath: string }) => {
        if (!state.files.has(uri.fsPath)) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        return { type: 1 };
      }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import { AgentConfigBuilder } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';
import { validateTeamFile } from '../TeamFileSchema';
import { PersistenceManager, serializeVersionedTeamFile } from '../PersistenceManager';

const TEAM_FILE = '/workspace/.unode/team.json';

function member(fields: Partial<AgentConfig> = {}): AgentConfig {
  return { ...new AgentConfigBuilder().fromTemplate('market-researcher').setId('researcher').build(), ...fields };
}

function context() {
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T): T | undefined => state.values.has(key) ? state.values.get(key) as T : fallback,
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.values.delete(key);
        else state.values.set(key, value);
      },
      keys: () => [...state.values.keys()],
    },
  } as any;
}

function writtenTeamFile(): Record<string, any> {
  return JSON.parse(Buffer.from(state.files.get(TEAM_FILE)!).toString('utf8'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.files.clear();
});

describe('Smart compaction settings at the team-file boundary', () => {
  it('round-trips the four agent fields and the team table through the writer and the reader', () => {
    const doc = {
      version: '1.0',
      members: [
        member({ smartCompactionProfile: 'deep-build' }),
        member({ id: 'custom', smartCompactionMode: 'custom', smartCompactionWindowPercent: 60, smartCompactionCeilingTokens: 200_000 }),
        member({ id: 'off', smartCompactionMode: 'off' }),
      ],
      mcpServers: [],
      workflows: [],
      smartCompactionProfiles: { balanced: { ceilingTokens: 180_000 }, 'qa-debugging': { windowPercent: 80 } },
    };
    const read = validateTeamFile(JSON.parse(serializeVersionedTeamFile(doc)));
    expect(read.validationWarnings?.filter((w) => w.includes('smartCompaction'))).toEqual([]);
    expect(read.smartCompactionProfiles).toEqual(doc.smartCompactionProfiles);
    expect(read.members.map((m) => [m.smartCompactionMode, m.smartCompactionProfile, m.smartCompactionWindowPercent, m.smartCompactionCeilingTokens]))
      .toEqual([
        [undefined, 'deep-build', undefined, undefined],
        ['custom', undefined, 60, 200_000],
        ['off', undefined, undefined, undefined],
      ]);
  });

  it('drops invalid agent values with a warning and still loads the agent', () => {
    const raw = JSON.parse(serializeVersionedTeamFile({ version: '1.0', members: [member()], mcpServers: [], workflows: [] }));
    Object.assign(raw.members[0], {
      smartCompactionMode: 'turbo', smartCompactionProfile: 'fast', smartCompactionWindowPercent: 5, smartCompactionCeilingTokens: '250000',
    });
    const read = validateTeamFile(raw);
    expect(read.members).toHaveLength(1);
    const [agent] = read.members;
    expect(agent.smartCompactionMode).toBeUndefined();
    expect(agent.smartCompactionProfile).toBeUndefined();
    expect(agent.smartCompactionWindowPercent).toBeUndefined();
    expect(agent.smartCompactionCeilingTokens).toBeUndefined();
    expect(read.validationWarnings?.filter((w) => w.includes('smartCompaction'))).toHaveLength(4);
  });

  it('keeps valid table cells, drops invalid ones, and never rejects the file for them', () => {
    const raw = JSON.parse(serializeVersionedTeamFile({ version: '1.0', members: [member()], mcpServers: [], workflows: [] }));
    raw.smartCompactionProfiles = {
      balanced: { windowPercent: 60, ceilingTokens: 50_000 },
      'deep-build': { ceilingTokens: 400_000, color: 'blue' },
      turbo: { windowPercent: 50 },
    };
    const read = validateTeamFile(raw);
    // balanced: a 50k ceiling puts the bundled 80k target above it, so its token cells go and 60% stays.
    expect(read.smartCompactionProfiles).toEqual({ balanced: { windowPercent: 60 }, 'deep-build': { ceilingTokens: 400_000 } });
    expect(read.members).toHaveLength(1);
    expect(read.validationWarnings?.filter((w) => w.includes('smartCompaction'))).toHaveLength(3);
  });

  it('leaves a legacy agent without fields: Smart with Auto by absence, no rewrite needed', () => {
    const read = validateTeamFile(JSON.parse(serializeVersionedTeamFile({ version: '1.0', members: [member()], mcpServers: [], workflows: [] })));
    expect(Object.keys(read.members[0]).filter((key) => key.startsWith('smartCompaction'))).toEqual([]);
    expect(read.smartCompactionProfiles).toBeUndefined();
  });

  it('admits the same fields from a host-owned library file', () => {
    const raw = { version: '1.0', members: [member({ smartCompactionMode: 'off' })], mcpServers: [], workflows: [] };
    expect(validateTeamFile(JSON.parse(JSON.stringify(raw)), undefined, { authority: 'host-owned' }).members[0].smartCompactionMode).toBe('off');
  });
});

describe('PersistenceManager keeps the team profile table', () => {
  it('writes the table with the team file and keeps it when workflows are saved', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig({
      version: '1.0', members: [member()], mcpServers: [], workflows: [],
      smartCompactionProfiles: { balanced: { ceilingTokens: 180_000 } },
    });
    expect(writtenTeamFile().smartCompactionProfiles).toEqual({ balanced: { ceilingTokens: 180_000 } });
    await manager.saveCustomWorkflows([]);
    expect(writtenTeamFile().smartCompactionProfiles).toEqual({ balanced: { ceilingTokens: 180_000 } });
  });

  it('creates the team file from the current roster on the first table edit, and clears the table on reset', async () => {
    state.values.set('roam.agents', [member()]);
    const manager = new PersistenceManager(context());
    await manager.saveSmartCompactionProfiles({ 'deep-build': { windowPercent: 80 } });
    expect(writtenTeamFile().members.map((m: AgentConfig) => m.id)).toEqual(['researcher']);
    expect(writtenTeamFile().smartCompactionProfiles).toEqual({ 'deep-build': { windowPercent: 80 } });
    await manager.saveSmartCompactionProfiles(undefined);
    expect(writtenTeamFile().smartCompactionProfiles).toBeUndefined();
    expect(writtenTeamFile().members.map((m: AgentConfig) => m.id)).toEqual(['researcher']);
  });

  it('never overwrites a team file it could not read', async () => {
    state.values.set('roam.agents', [member()]);
    state.files.set(TEAM_FILE, Buffer.from('{ not json', 'utf8'));
    const manager = new PersistenceManager(context());
    await expect(manager.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } })).rejects.toThrow(/could not be read/);
    expect(Buffer.from(state.files.get(TEAM_FILE)!).toString('utf8')).toBe('{ not json');
  });
});
