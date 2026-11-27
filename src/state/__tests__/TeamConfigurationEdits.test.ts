import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(), root: '/workspace', available: true,
}));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: state.root } }]; },
    fs: {
      delete: vi.fn(async (uri: { fsPath: string }) => { state.files.delete(uri.fsPath); }),
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => { state.files.set(uri.fsPath, bytes); }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = state.files.get(uri.fsPath);
        if (!bytes) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return bytes;
      }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import * as vscode from 'vscode';
import { PersistenceManager, serializeVersionedTeamFile } from '../PersistenceManager';
import { TeamVerificationConfigurationError, type TeamFileDocument } from '../TeamFileSchema';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import { agentMcpGrants } from '../../roles/SkillResolver';

const TEAM = '/workspace/.unode/team.json';
const document = (): TeamFileDocument => ({ version: '1.0', members: [], mcpServers: [], workflows: [] });
const workflows: TeamFileDocument['workflows'] = [{
  id: 'review', name: 'Review', steps: [{ id: 'read', from: 'pm', to: 'reviewer', action: 'Review the document' }],
}];
function manager() {
  const context = { workspaceState: { get: (_key: string, fallback: unknown) => fallback } } as any;
  return new PersistenceManager(context, undefined, () => (state.available ? '/workspace' : undefined));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function seed(doc: TeamFileDocument = document()) {
  state.files.set(TEAM, Buffer.from(serializeVersionedTeamFile(doc)));
}
const read = () => JSON.parse(Buffer.from(state.files.get(TEAM)!).toString('utf8'));

beforeEach(() => {
  vi.clearAllMocks();
  state.files.clear(); state.root = '/workspace'; state.available = true;
});

describe('warnings about a team file (v0.9.100 field, K6)', () => {
  const widening = (): TeamFileDocument => {
    return { ...document(), members: [{ id: 'dev', name: 'Dev', role: 'senior-dev', skill: 'code-generation',
      provider: { providerId: 'openrouter', apiKeySecretName: 'OPENROUTER_API_KEY' }, model: 'deepseek/deepseek-v4.1-flash', systemPrompt: 'Work.',
      autoApprove: false, allowedTools: ['read', 'write', 'execute'] } as never] };
  };
  const remembering = () => {
    const values = new Map<string, unknown>();
    const global = { get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); } };
    const context = { workspaceState: { get: (_key: string, fallback: unknown) => fallback }, globalState: global } as any;
    return new PersistenceManager(context, undefined, () => '/workspace');
  };
  const warned = () => vi.mocked(vscode.window.showWarningMessage).mock.calls.map((call) => String(call[0]));

  it('the bytes UnodeAi saved itself do not warn about their own tools', async () => {
    const persistence = remembering();
    await persistence.saveTeamConfig(widening());
    await persistence.loadTeamConfig();
    expect(warned()).toEqual([]);
  });

  it('a file anyone else changed still warns', async () => {
    const persistence = remembering();
    await persistence.saveTeamConfig(widening());
    state.files.set(TEAM, Buffer.from(`${Buffer.from(state.files.get(TEAM)!).toString('utf8')}\n`));
    await persistence.loadTeamConfig();
    expect(warned().join(' ')).toContain('allowedTools ignored widening values');
  });
});

describe('same-host team configuration edits', () => {
  it('serializes deletion after a pending writer, then allows the editor seed after deletion', async () => {
    seed();
    const persistence = manager(); const entered = deferred(); const release = deferred();
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(async (uri, bytes) => {
      entered.resolve(); await release.promise; state.files.set(uri.fsPath, bytes);
    });
    const write = persistence.saveTeamConfig({ ...document(), completionVerification: { mode: 'disabled' } });
    await entered.promise;
    const remove = persistence.deleteTeamFile();
    const ensure = persistence.ensureTeamFile();
    expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    release.resolve(); await Promise.all([write, remove, ensure]);
    expect(vscode.workspace.fs.delete).toHaveBeenCalledTimes(1);
    expect(read().completionVerification).toBeUndefined();
    expect(read().members).toEqual([]);
  });

  it('editor seed preserves an existing malformed repair target and refuses access failures', async () => {
    const original = Buffer.from('{ malformed'); state.files.set(TEAM, original);
    const persistence = manager(); await persistence.ensureTeamFile();
    expect(state.files.get(TEAM)).toEqual(original);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    await expect(persistence.ensureTeamFile()).rejects.toThrow('denied');
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('a deletion permission failure is visible and does not poison subsequent operations', async () => {
    seed(); const persistence = manager();
    vi.mocked(vscode.workspace.fs.delete).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    await expect(persistence.deleteTeamFile()).rejects.toThrow('denied');
    await persistence.ensureTeamFile();
    expect(state.files.has(TEAM)).toBe(true);
  });
  it.each(['profile-first', 'workflows-first'])('keeps both concurrent workflow/profile edits (%s)', async (order) => {
    seed({ ...document(), completionVerification: { mode: 'command', command: 'npm test' } });
    const persistence = manager();
    const entered = deferred();
    const release = deferred();
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(async (uri, bytes) => {
      entered.resolve();
      await release.promise;
      state.files.set(uri.fsPath, bytes);
    });
    const profile = () => persistence.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } });
    const saveWorkflows = () => persistence.saveCustomWorkflows(workflows);
    const first = order === 'profile-first' ? profile() : saveWorkflows();
    await entered.promise;
    const second = order === 'profile-first' ? saveWorkflows() : profile();
    // The second editor has been called, but must not even read the pre-write document.
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(2);
    expect(read()).toMatchObject({
      completionVerification: { mode: 'command', command: 'npm test' },
      smartCompactionProfiles: { balanced: { windowPercent: 60 } }, workflows,
    });
  });

  it('re-reads after a queued full replacement instead of copying its old policy', async () => {
    seed({ ...document(), completionVerification: { mode: 'auto' } });
    const persistence = manager();
    const replacement = persistence.saveTeamConfig({ ...document(), completionVerification: { mode: 'disabled' } });
    const edit = persistence.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } });
    await Promise.all([replacement, edit]);
    expect(read()).toMatchObject({ completionVerification: { mode: 'disabled' }, smartCompactionProfiles: { balanced: { windowPercent: 60 } } });
  });

  it('freezes a full replacement before it waits on another writer', async () => {
    seed();
    const persistence = manager();
    const entered = deferred(); const release = deferred();
    vi.mocked(vscode.workspace.fs.createDirectory).mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const first = persistence.saveCustomWorkflows([]);
    await entered.promise;
    const doc = { ...document(), completionVerification: { mode: 'command' as const, command: 'npm test' } };
    const second = persistence.saveTeamConfig(doc);
    doc.completionVerification.command = 'node later-mutation.js';
    release.resolve();
    await Promise.all([first, second]);
    expect(read().completionVerification).toEqual({ mode: 'command', command: 'npm test' });
  });

  it.each(['workflows', 'profiles', 'edit'])('refuses malformed input before %s can overwrite it', async (kind) => {
    const original = Buffer.from('{ broken'); state.files.set(TEAM, original);
    const persistence = manager();
    const edit = vi.fn(() => document());
    await expect(kind === 'workflows' ? persistence.saveCustomWorkflows([])
      : kind === 'profiles' ? persistence.saveSmartCompactionProfiles(undefined)
      : persistence.updateTeamConfig(edit)).rejects.toThrow('could not be read');
    expect(edit).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(original);
  });

  it('refuses invalid policy, preserves the bytes, and accepts an edit after explicit repair', async () => {
    const original = Buffer.from('{"completionVerification":{"mode":"Auto"}}'); state.files.set(TEAM, original);
    const persistence = manager();
    await expect(persistence.updateTeamConfig(() => document())).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    expect(state.files.get(TEAM)).toEqual(original);
    seed({ ...document(), completionVerification: { mode: 'disabled' } });
    await persistence.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } });
    expect(read().completionVerification).toEqual({ mode: 'disabled' });
  });

  it('does not treat permission errors as absence, and a failed operation does not poison the queue', async () => {
    seed();
    const persistence = manager();
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    const refused = persistence.saveCustomWorkflows([]);
    const accepted = persistence.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } });
    await expect(refused).rejects.toThrow('could not be read');
    await accepted;
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(read().smartCompactionProfiles).toEqual({ balanced: { windowPercent: 60 } });
  });

  it('does not expose parser/filesystem error payloads through editor failures', async () => {
    seed();
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error('private-command-token'));
    const error = await manager().saveCustomWorkflows([]).then(() => undefined, (failure: unknown) => failure);
    expect(String(error)).toContain('could not be read');
    expect(String(error)).not.toContain('private-command-token');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('keeps the original file after a write failure and allows a later edit', async () => {
    seed(); const original = state.files.get(TEAM);
    const persistence = manager();
    vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('disk full'));
    await expect(persistence.saveSmartCompactionProfiles({ balanced: { windowPercent: 60 } })).rejects.toThrow('disk full');
    expect(state.files.get(TEAM)).toEqual(original);
    await persistence.saveCustomWorkflows([]);
    expect(read().smartCompactionProfiles).toBeUndefined();
  });

  it('does not write when a callback deliberately declines an edit', async () => {
    seed();
    await manager().updateTeamConfig(() => undefined);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('refuses an old roster migration without running its edit, then allows a fresh edit', async () => {
    const incoming = new AgentConfigBuilder().fromTemplate('senior-dev').setId('incoming').build();
    seed({ ...document(), members: [incoming], completionVerification: { mode: 'disabled' } });
    const original = state.files.get(TEAM);
    const persistence = manager(); const edit = vi.fn(() => document());
    await expect(persistence.updateTeamConfig(edit, [])).rejects.toThrow('team roster changed');
    expect(edit).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(original);
    await persistence.saveCustomWorkflows(workflows);
    expect(read()).toMatchObject({ members: [{ id: 'incoming' }], completionVerification: { mode: 'disabled' }, workflows });
  });

  it('does not reject a roster migration merely because the policy or profiles changed', async () => {
    const agent = new AgentConfigBuilder().fromTemplate('senior-dev').setId('same-agent').build();
    seed({ ...document(), members: [agent] });
    const persistence = manager();
    const captured = await persistence.loadTeamConfig({ strict: true });
    await persistence.updateTeamConfig((current) => ({ ...current!, completionVerification: { mode: 'disabled' } }));
    await persistence.updateTeamConfig((current) => ({ ...current!, workflows }), captured!.members);
    expect(read()).toMatchObject({ completionVerification: { mode: 'disabled' }, workflows });
  });

  it('compares roster values rather than JSON property insertion order', async () => {
    const agent = new AgentConfigBuilder().fromTemplate('senior-dev').setId('same-agent').build();
    seed({ ...document(), members: [agent] });
    const persistence = manager();
    const captured = await persistence.loadTeamConfig({ strict: true });
    const reordered = captured!.members.map((member) => Object.fromEntries(Object.entries(member).reverse()));
    await persistence.updateTeamConfig((current) => ({ ...current!, workflows }), reordered as typeof captured.members);
    expect(read().workflows).toEqual(workflows);
  });

  it('freezes queued profile/workflow input before the caller can mutate it', async () => {
    seed(); const persistence = manager();
    const profiles = { balanced: { windowPercent: 60 } };
    const flow = structuredClone(workflows);
    const one = persistence.saveSmartCompactionProfiles(profiles);
    const two = persistence.saveCustomWorkflows(flow);
    profiles.balanced.windowPercent = 80;
    flow[0].name = 'later mutation';
    await Promise.all([one, two]);
    expect(read()).toMatchObject({ smartCompactionProfiles: { balanced: { windowPercent: 60 } }, workflows });
  });

  // v0.9.99 (B12): a change of the editor's first folder does not move the bound root, so a save in flight completes
  // in the project the team works in, is not refused, and writes nothing into the new first folder.
  it.each(['read', 'directory', 'write'])('completes in the bound root when the first folder changes during %s I/O', async (phase) => {
    seed(); const original = state.files.get(TEAM);
    const persistence = manager();
    if (phase === 'read') {
      vi.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(async () => { state.root = '/other'; return original!; });
    } else if (phase === 'directory') {
      vi.mocked(vscode.workspace.fs.createDirectory).mockImplementationOnce(async () => { state.root = '/other'; });
    } else {
      vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(async (uri, bytes) => {
        state.files.set(uri.fsPath, bytes); state.root = '/other';
      });
    }
    await persistence.saveCustomWorkflows(workflows);
    expect(read().workflows).toEqual(workflows);
    expect(state.files.has('/other/.unode/team.json')).toBe(false);
    await persistence.saveCustomWorkflows([]);
    expect(read().workflows).toEqual([]);
    expect(state.files.has('/other/.unode/team.json')).toBe(false);
  });

  it('checks activation-bound workspace liveness again when queued work starts', async () => {
    seed(); const original = state.files.get(TEAM);
    const persistence = manager();
    const entered = deferred(); const release = deferred();
    vi.mocked(vscode.workspace.fs.createDirectory).mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const first = persistence.saveCustomWorkflows([]);
    await entered.promise;
    const edit = vi.fn(() => document());
    const second = persistence.updateTeamConfig(edit);
    // FirstWorkspaceBinding remains stale even if the folder path later returns to A.
    state.available = false;
    release.resolve();
    await expect(first).rejects.toThrow('workspace changed');
    await expect(second).rejects.toThrow('workspace changed');
    expect(edit).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(original);
  });

  it('reports failure if the binding is lost during an already-started write (no rollback claim)', async () => {
    seed();
    const persistence = manager();
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(async (uri, bytes) => {
      state.files.set(uri.fsPath, bytes);
      state.available = false;
    });
    await expect(persistence.saveCustomWorkflows(workflows)).rejects.toThrow('workspace changed');
    // The old-root write happened. Only the success report is refused; nothing was rolled back.
    expect(read().workflows).toEqual(workflows);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(state.files.has('/other/.unode/team.json')).toBe(false);
  });

  it('does not create a team document in a folderless/stale activation', async () => {
    state.available = false;
    await expect(manager().saveCustomWorkflows([])).rejects.toThrow('Open a workspace');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
  });
});

describe('Marketplace direct integration grants', () => {
  const dev = (id: string, mcpServers: string[] = []) => ({
    id, name: 'Researcher', role: 'senior-dev', skill: 'code-generation', systemPrompt: 'Work.',
    provider: { providerId: 'openrouter', apiKeySecretName: 'OPENROUTER_API_KEY' },
    model: 'deepseek/deepseek-v4.1-flash', mcpServers,
  }) as TeamFileDocument['members'][number];

  async function setup(members: TeamFileDocument['members']) {
    const values = new Map<string, unknown>();
    const workspaceState = {
      get: (key: string, fallback: unknown) => values.has(key) ? structuredClone(values.get(key)) : fallback,
      update: vi.fn(async (key: string, value: unknown) => { value === undefined ? values.delete(key) : values.set(key, JSON.parse(JSON.stringify(value))); }),
    };
    const reopen = () => new PersistenceManager({ workspaceState } as never, undefined, () => '/workspace');
    const persistence = reopen();
    await persistence.saveAgents(members);
    seed({ ...document(), members, workflows, completionVerification: { mode: 'disabled' } });
    const original = read();
    original.members = original.members.map((member: { id: string }) => ({
      ...member,
      mcpServers: members.find(row => row.id === member.id)?.mcpServers,
    }));
    state.files.set(TEAM, Buffer.from(JSON.stringify(original)));
    return { persistence, reopen, workspaceState, values, original };
  }

  it('revoke direct grant and reload team.json without restoring access', async () => {
    const members = [dev('one'), dev('two', ['other']), dev('three')];
    const { persistence, reopen, original } = await setup(members);
    const publish = vi.fn(() => {
      expect(read().members.map((row: { mcpServers: string[] }) => row.mcpServers)).toEqual([['fixture'], ['other', 'fixture'], []]);
    });
    await persistence.saveIntegrationGrants('fixture', members, [
      { agentId: 'one', granted: true }, { agentId: 'two', granted: true },
    ], ['two'], () => {}, publish);
    expect(publish).toHaveBeenCalledOnce();
    const afterGrant = reopen();
    const revision = afterGrant.codexIntegrationRevision('two');
    expect(revision).toBeTruthy();
    const selected = afterGrant.loadAgents();
    expect(selected.map(row => row.mcpServers)).toEqual([['fixture'], ['other', 'fixture'], []]);
    await afterGrant.saveIntegrationGrants('fixture', selected, [{ agentId: 'two', granted: false }], ['two'], () => {}, () => {});
    const restored = reopen();
    expect(restored.loadAgents().map(row => row.mcpServers)).toEqual([['fixture'], ['other'], []]);
    expect(restored.codexIntegrationRevision('two')).not.toBe(revision);
    expect((await restored.loadTeamConfig())?.members.map(row => row.mcpServers)).toEqual([undefined, undefined, undefined]);
    expect(read()).toMatchObject({ workflows: original.workflows, completionVerification: original.completionVerification });
    expect(read().members.map((row: { mcpServers: string[] }) => row.mcpServers)).toEqual([['fixture'], ['other'], []]);
  });

  it('grant a member outside team.json without rewriting or adding project rows', async () => {
    const members = [dev('in-file', ['other']), dev('host-only')];
    const { persistence, original } = await setup(members);
    const bytes = Buffer.from(JSON.stringify({ ...original, members: original.members.slice(0, 1) }));
    state.files.set(TEAM, bytes);
    await persistence.saveIntegrationGrants('fixture', members, [{ agentId: 'host-only', granted: true }], [], () => {}, () => {});
    expect(persistence.loadAgents().find(member => member.id === 'host-only')?.mcpServers).toEqual(['fixture']);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(bytes);
  });

  it.each(['team write', 'roster write', 'rollback'] as const)(
    'split grant save reports the failed store and cannot widen access on reload (%s)',
    async (failure) => {
      const members = [dev('one', ['fixture', 'other']), dev('two')];
      const { persistence, reopen, workspaceState, values, original } = await setup(members);
      const publish = vi.fn();
      if (failure === 'team write') vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('team write failed'));
      if (failure !== 'team write') {
        workspaceState.update.mockImplementation(async (key, value) => {
          if (key === 'roam.agents') throw new Error('roster write failed');
          value === undefined ? values.delete(key) : values.set(key, JSON.parse(JSON.stringify(value)));
        });
      }
      if (failure === 'rollback') {
        const realWrite = vi.mocked(vscode.workspace.fs.writeFile).getMockImplementation()!;
        vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(realWrite).mockRejectedValueOnce(new Error('rollback failed'));
      }
      await expect(persistence.saveIntegrationGrants('fixture', members, [
        { agentId: 'one', granted: false }, { agentId: 'two', granted: true },
      ], [], () => {}, publish)).rejects.toThrow(failure === 'rollback' ? 'Could not restore the team file' : `${failure} failed`);
      expect(publish).not.toHaveBeenCalled();
      const restored = reopen();
      expect(restored.loadAgents().map(row => row.mcpServers)).toEqual(failure === 'rollback' ? [['other'], []] : [['fixture', 'other'], []]);
      if (failure !== 'rollback') {
        expect(read()).toEqual(original);
        expect(restored.integrationGrantRepairs()).toEqual([]);
      } else {
        expect(restored.integrationGrantRepairs()).toMatchObject([{ serverId: 'fixture', agentIds: ['one', 'two'] }]);
        const skillGrant = { serverId: 'fixture', toolFilter: 'allowlist', toolList: ['lookup'] } as const;
        const live = restored.restrictUnconfirmedGrants(members[0]);
        const resolver = { resolveMcpServerRefs: () => [skillGrant] } as never;
        expect(agentMcpGrants(live, resolver)).toEqual([skillGrant, { serverId: 'other', toolFilter: 'all' }]);
        workspaceState.update.mockImplementation(async (key, value) => { value === undefined ? values.delete(key) : values.set(key, JSON.parse(JSON.stringify(value))); });
        await restored.saveIntegrationGrants('fixture', restored.loadAgents(), [], [], () => {}, () => {});
        expect(reopen().integrationGrantRepairs()).toEqual([]);
        expect(reopen().loadAgents().map(row => row.mcpServers)).toEqual([['other'], []]);
        expect(read().members[1].mcpServers).toEqual([]);
      }
    },
  );
});

describe('Marketplace integration configuration edits', () => {
  it.each(['file', 'host', 'none'] as const)(
    'team.json and host-store write failures retain the last committed configuration (%s)',
    async (failedStore) => {
      const values = new Map<string, unknown>();
      const workspaceState = {
        get: (key: string, fallback: unknown) => values.has(key) ? structuredClone(values.get(key)) : fallback,
        update: vi.fn(async (key: string, value: unknown) => { value === undefined ? values.delete(key) : values.set(key, JSON.parse(JSON.stringify(value))); }),
      };
      const persistence = new PersistenceManager({ workspaceState } as never, undefined, () => '/workspace');
      const original = { id: 'time', name: 'Time', transport: 'stdio' as const, command: 'uvx', args: ['old'] };
      const next = { ...original, name: 'New Time', args: ['folder with spaces'] };
      const unrelated = { id: 'other', name: 'Other', transport: 'stdio' as const, command: 'node' };
      await persistence.saveHostMcpServers([original, unrelated]);
      const file = { ...document(), workflows, mcpServers: [original, unrelated] };
      state.files.set(TEAM, Buffer.from(JSON.stringify(file)));
      if (failedStore === 'file') vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('file save failed'));
      if (failedStore === 'host') {
        workspaceState.update.mockImplementation(async (key, value) => {
          if (key === 'unode.hostMcpServers.v1') throw new Error('host save failed');
          value === undefined ? values.delete(key) : values.set(key, JSON.parse(JSON.stringify(value)));
        });
      }
      const publish = vi.fn();
      const operation = persistence.commitIntegrationConfiguration(original.id, original, next, () => {}, publish);
      if (failedStore !== 'none') {
        await expect(operation).rejects.toThrow(`${failedStore} save failed`);
        expect(read()).toEqual(file);
        expect(persistence.loadHostMcpServers()).toEqual([original, unrelated]);
        expect(publish).not.toHaveBeenCalled();
      } else {
        await operation;
        expect(read()).toMatchObject({ workflows, mcpServers: [unrelated] });
        expect(persistence.loadHostMcpServers()).toEqual([unrelated, next]);
        expect(persistence.loadApprovedMcpServers()).toEqual([]);
        expect(publish).toHaveBeenCalledOnce();
      }
      expect(persistence.integrationConfigNeedsRepair(original.id)).toBe(false);
    },
  );
});
