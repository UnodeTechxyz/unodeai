import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { AgentConfig } from '../../types';
import type { AgentBackend, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';

const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), root: '/workspace',
  write: undefined as undefined | ((name: string, bytes: Uint8Array) => Promise<void>) }));
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (uri: { fsPath: string; scheme?: string }, ...parts: string[]) => ({ fsPath: [uri.fsPath, ...parts].join('/'), scheme: 'file' }) },
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: disk.root, scheme: 'file' } }]; }, fs: {
    readFile: vi.fn(async (uri: { fsPath: string }) => {
      const bytes = disk.files.get(uri.fsPath); if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return bytes;
    }),
    createDirectory: vi.fn(async () => {}),
    writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
      if (disk.write) await disk.write(uri.fsPath, bytes); else disk.files.set(uri.fsPath, Buffer.from(bytes));
    }),
    delete: vi.fn(async (uri: { fsPath: string }) => { disk.files.delete(uri.fsPath); }),
} }, window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
}));
vi.mock('../../backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn(async () => false) }));
import * as vscode from 'vscode';
import { PersistenceManager, TeamReplacementRecoveryError } from '../PersistenceManager';
import { type TeamFileDocument } from '../TeamFileSchema';
import { AgentRosterEdits } from '../../host/AgentRosterEdits';
import { migrateLegacyCommandTools, legacyCommandMigrationNotice } from '../../host/LegacyCommandTools';
import { SessionManager } from '../../session/SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { AgentConfigBuilder, ROLE_TEMPLATES } from '../../roles/RoleConfig';
import { TeamVerificationEditor } from '../../host/TeamVerificationEditor';
import { resolveCompletionVerificationPolicy } from '../../backend/CompletionVerificationPolicy';
import * as dialogs from '../../dialogs';
import { savedCommandPreference, restoredCommandTools, restoreSavedPermissionsIndividually } from '../SavedPermissionRestore';
import { toAgentConfig, mountSkillPlaybooks } from '../../marketplace/install';
import type { AgentCatalogEntry } from '../../marketplace/catalog';

const target = '/workspace/.unode/team.json';
describe('actual saved-team Codex default', () => {
  it.each([false, true])('restores full access only from a verified source (verified=%s)', async verified => {
    const incoming = document('codex');
    incoming.members[0].backend = 'codex'; incoming.members[0].codexPermissionProfile = 'full-access';
    const replaceSavedTeam = vi.fn(async () => true);
    const host = { agentRosterEdits: { replace: (_current: unknown, open: () => Promise<boolean>) => open(), capture: () => () => true, overlayUnsavedOff: (members: AgentConfig[]) => members },
      hostShutdown: { started: false }, teamRosterRevision: 0, rosterNotifyTimer: undefined,
      sessionManager: { getAll: () => [] }, persistence: { replaceSavedTeam },
      defaultBackendKind: () => 'codex', effectiveConnectionRegistry: {},
      SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: undefined, chatViewProvider: undefined };
    const restore = actualExtensionFunction('restoreTeamDocument', host);
    await restore(incoming, () => true, undefined, undefined, verified ? incoming.members : undefined);
    expect(replaceSavedTeam.mock.calls[0][0].members[0].codexPermissionProfile).toBe(verified ? 'full-access' : 'approve-for-me');
  });
});
function actualExtensionFunction(name: string, host: object) {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source); expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', 'migrateLegacyCommandTools', 'legacyCommandMigrationNotice', 'outputChannel', 'ROLE_TEMPLATES',
    `with (host) { ${code}; return ${name}; }`)(host, migrateLegacyCommandTools, legacyCommandMigrationNotice, { info: vi.fn() }, ROLE_TEMPLATES);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function document(id: string, mode?: 'auto' | 'disabled'): TeamFileDocument {
  return { version: '1.0', members: [new AgentConfigBuilder().fromTemplate('business-analyst').setId(id).build()],
    workflows: [], mcpServers: [], ...(mode ? { completionVerification: { mode } } : {}) };
}
function fixture(original: TeamFileDocument | undefined = document('old', 'auto')) {
  const values = new Map<string, unknown>(); let revision = 0; let current = true;
  if (original) disk.files.set(target, Buffer.from(JSON.stringify(original, null, 4) + '\n'));
  const update = vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); });
  const persistence = new PersistenceManager({ workspaceState: { get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
    keys: () => [...values.keys()], update }, globalStorageUri: { fsPath: '/global' } } as never, undefined, () => (current ? '/workspace' : undefined));
  const backends: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; oldHandler?: BackendEventHandler }[] = [];
  const editor = new AgentRosterEdits({ members: () => sessions.getAll().map(s => s.config), revision: () => revision,
    currentWorkspace: () => current, persist: members => persistence.saveAgents(members) });
  const clearSnapshot = vi.fn(async (id: string) => { await persistence.clearSnapshot(id); });
  const clearPin = vi.fn(async (id: string) => { await persistence.clearRuntimePin(id); });
  const forceStopProcessTree = vi.fn(async (_pid: number) => {});
  const sessions = new SessionManager(4, new MessageBus(), {
    forceStopProcessTree,
    workspaceAvailable: () => current && editor.admissionAllowed, rosterChangeAllowed: () => editor.admissionAllowed,
    createBackend: config => {
      const backend = { agentId: config.id, start: vi.fn(async () => { backend.oldHandler?.({ kind: 'ready' }); }), stop: vi.fn(async () => ({ stopped: true })),
        isAlive: () => true, onEvent: (handler: BackendEventHandler) => { backend.oldHandler = handler; return () => {}; },
        oldHandler: undefined as BackendEventHandler | undefined, sendUserTurn: vi.fn(), abort: vi.fn() };
      backends.push(backend); return backend as AgentBackend;
    }, resolveEnv: async () => ({}), clearSnapshot, clearRuntimePin: clearPin,
    saveSnapshot: (id, snapshot) => persistence.saveSnapshot(id, snapshot),
  });
  sessions.on('session.created', () => { revision++; }); sessions.on('session.removed', () => { revision++; });
  for (const member of original?.members ?? document('old').members) sessions.create(member);
  const snapshot = vi.fn(async (_source: TeamFileDocument | undefined) => true);
  const publish = vi.fn((members: AgentConfig[]) => sessions.publishStoppedRoster(members));
  const replace = (incoming: TeamFileDocument, captured = editor.capture()) => editor.replace(captured, async () => {
    revision++;
    const unchanged = editor.capture();
    try {
      return await persistence.replaceSavedTeam(incoming, {
        currentMembers: () => sessions.getAll().map(s => s.config),
        assertCurrent: () => { if (!unchanged()) throw new Error('stale target'); },
        snapshotOutgoing: snapshot, stopAndPrepare: () => sessions.prepareRosterReplacement(), publish,
      });
    } catch (error) { if (error instanceof TeamReplacementRecoveryError) editor.requireRecovery(); throw error; }
    finally { revision++; }
  });
  return { values, update, persistence, sessions, editor, snapshot, publish, replace, clearSnapshot, clearPin, backends,
    forceStopProcessTree, stale: () => { current = false; }, revision: () => revision, setRevision: (value: number) => { revision = value; } };
}

beforeEach(() => {
  disk.files.clear(); disk.root = '/workspace'; disk.write = undefined; vi.clearAllMocks();
  vi.mocked(vscode.window.showInformationMessage).mockReset(); vi.mocked(vscode.window.showWarningMessage).mockReset();
});

function marketplaceFixture() {
  const h = fixture({ ...document('old'), completionVerification: { mode: 'command', command: 'npm run old-check' } });
  const entry: AgentCatalogEntry = { id: 'new-analyst', name: 'New Analyst', role: 'custom', summary: 'Test preset',
    skills: ['documentation'], model: 'test-model', tier: 'premium', systemPrompt: 'Review the work.' };
  const host = { agentRosterEdits: h.editor, sessionManager: h.sessions, persistence: h.persistence,
    hostShutdown: { started: false }, firstWorkspaceRoot: () => '/workspace',
    get teamRosterRevision() { return h.revision(); }, set teamRosterRevision(value) { h.setRevision(value); },
    rosterNotifyTimer: undefined, defaultBackendKind: () => 'openai-compat', effectiveConnectionRegistry: {}, TeamReplacementRecoveryError,
    workflowEngine: { getActiveWorkflows: () => [], cancel: vi.fn() }, worktreeCoordinator: undefined,
    SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() },
    snapshotRosterBeforeReplace: vi.fn(async () => true),
    loadMarketplaceCatalog: vi.fn(async () => ({ agents: [entry], skills: [] })),
    dialogs: { uniqueAgentName: (_deps: unknown, name: string) => name }, dialogDeps: () => ({}),
    toAgentConfig, mountSkillPlaybooks, distinctAgentIcon: (icon: string) => icon, rosterIcons: () => [],
    capabilityViolations: vi.fn((): { message: string }[] => []), notifyPmRosterChange: vi.fn(), vscode,
  };
  const restore = actualExtensionFunction('restoreTeamDocument', host);
  const replace = vi.fn((incoming: TeamFileDocument, current: () => boolean) => restore(incoming, current));
  const install = actualExtensionFunction('handleMarketplaceInstall', host);
  return { ...h, host, replace, install: (target: 'new-team' | 'current-team' = 'new-team') =>
    install({ kind: 'agent', entryId: entry.id, target }, {}, replace) };
}

describe('Marketplace roster entry uses the existing saved-team transaction', () => {
  it('stages a new team, snapshots the outgoing policy and atomically replaces it without inheriting the old command', async () => {
    const h = marketplaceFixture(); vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Replace' as never);
    expect(await h.install()).toMatchObject({ ok: true }); expect(h.replace).toHaveBeenCalledOnce();
    expect(h.host.snapshotRosterBeforeReplace).toHaveBeenCalledWith({ document: expect.objectContaining({
      completionVerification: { mode: 'command', command: 'npm run old-check' },
    }) }, undefined);
    expect(h.sessions.get('old')).toBeUndefined(); expect(h.sessions.getAll()).toHaveLength(1);
    const saved = await h.persistence.loadTeamConfig({ strict: true });
    expect(saved?.members.map(member => member.id)).toEqual(h.sessions.getAll().map(session => session.id));
    expect(saved?.completionVerification).toBeUndefined(); expect(h.sessions.getAll()[0].status).toBe('stopped');
    expect(h.editor.admissionAllowed).toBe(true);
  });
  it.each(['Keep current team', undefined])('refuses replacement on non-consent %s without touching any session', async choice => {
    const h = marketplaceFixture(); const old = h.sessions.get('old');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(choice as never);
    expect(await h.install()).toMatchObject({ ok: false }); expect(h.replace).not.toHaveBeenCalled();
    expect(h.sessions.get('old')).toBe(old); expect(h.clearSnapshot).not.toHaveBeenCalled();
  });
  it('rejects a changed roster while the catalog loads before asking to replace it', async () => {
    const h = marketplaceFixture();
    h.host.loadMarketplaceCatalog.mockImplementationOnce(async () => {
      h.sessions.create(document('parallel').members[0]); return { agents: [{ id: 'new-analyst' } as AgentCatalogEntry], skills: [] };
    });
    expect(await h.install()).toMatchObject({ ok: false }); expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.sessions.getAll().map(session => session.id)).toEqual(['old', 'parallel']); expect(h.replace).not.toHaveBeenCalled();
  });
  it('rejects a workspace change during confirmation without publishing or clearing conversations', async () => {
    const h = marketplaceFixture(); vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => { h.stale(); return 'Replace' as never; });
    expect(await h.install()).toMatchObject({ ok: false }); expect(h.replace).not.toHaveBeenCalled();
    expect(h.sessions.get('old')).toBeDefined(); expect(h.clearSnapshot).not.toHaveBeenCalled();
  });
  it('validates the prepared connection before any replacement confirmation or stop', async () => {
    const h = marketplaceFixture(); h.host.capabilityViolations.mockReturnValueOnce([{ message: 'Unsupported connection.' }]);
    expect(await h.install()).toEqual({ ok: false, message: 'Unsupported connection.' });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled();
    expect(h.sessions.get('old')).toBeDefined(); expect(h.clearSnapshot).not.toHaveBeenCalled();
  });
  it('retains outgoing conversations and policy if the new-team roster save fails', async () => {
    const h = marketplaceFixture(); const old = h.sessions.get('old');
    h.values.set('roam.snapshot.old', { messages: ['original conversation'] });
    h.update.mockRejectedValueOnce(new Error('roster save failed'));
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Replace' as never);
    await expect(h.install()).rejects.toThrow('roster save failed');
    expect(h.sessions.get('old')).toBe(old); expect(h.values.get('roam.snapshot.old')).toEqual({ messages: ['original conversation'] });
    expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'command', command: 'npm run old-check' });
    expect(h.editor.admissionAllowed).toBe(true);
  });
  it('continues the confirmed team replacement after an unconfirmed runtime stop', async () => {
    const h = marketplaceFixture(); await h.sessions.start('old', { pin: 'take' });
    h.backends[0].stop.mockResolvedValueOnce({ stopped: false } as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Replace' as never);
    await expect(h.install()).resolves.toMatchObject({ ok: true });
    expect(h.sessions.get('old')).toBeUndefined(); expect(h.clearSnapshot).toHaveBeenCalled();
  });
  it.each([false, true])('adding to the current team publishes only after a successful roster save (failure=%s)', async failure => {
    const h = marketplaceFixture(); if (failure) h.update.mockRejectedValueOnce(new Error('save failed'));
    if (failure) await expect(h.install('current-team')).rejects.toThrow('save failed');
    else expect(await h.install('current-team')).toMatchObject({ ok: true });
    expect(h.sessions.getAll()).toHaveLength(failure ? 1 : 2); expect(h.replace).not.toHaveBeenCalled();
    expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'command', command: 'npm run old-check' });
    expect(h.host.notifyPmRosterChange).toHaveBeenCalledTimes(failure ? 0 : 1);
  });
  it('does not publish a new current-team role if shutdown starts during its roster save', async () => {
    const h = marketplaceFixture(); h.update.mockImplementationOnce(async (key, value) => {
      h.values.set(key, value); h.host.hostShutdown.started = true;
    });
    expect(await h.install('current-team')).toMatchObject({ ok: false });
    expect(h.sessions.getAll().map(session => session.id)).toEqual(['old']);
    expect(h.persistence.loadAgents().map(member => member.id)).toEqual(['old']);
    expect(h.host.notifyPmRosterChange).not.toHaveBeenCalled();
  });
  it('the actual Marketplace registration supplies the shared replacement function to the install callback', async () => {
    const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(source) === 'MarketplacePanel.createOrShow') calls.push(node); ts.forEachChild(node, visit); };
    visit(source); expect(calls).toHaveLength(1);
    const callback = calls[0].arguments[1]; const handle = vi.fn(); const replace = vi.fn(); const uri = {};
    const js = ts.transpileModule(`const run = ${callback.getText(source)}; run(action);`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const action = { kind: 'agent', entryId: 'new-analyst', target: 'new-team' };
    new Function('handleMarketplaceInstall', 'restoreTeamDocument', 'context', 'action', js)(handle, replace, { extensionUri: uri }, action);
    expect(handle).toHaveBeenCalledExactlyOnceWith(action, uri, replace);
  });
});

describe('saved-team policy and roster replacement through real persistence/session boundaries', () => {
  it('persists Off after an unconfirmed stop without trapping the whole team or reviving permission on reload', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' });
    h.backends[0].stop.mockResolvedValueOnce({ stopped: false } as never);
    const current = h.sessions.get('old')!.config;
    const candidate: AgentConfig = { ...current, allowedTools: current.allowedTools?.filter(tool => tool !== 'execute'),
      executePreference: 'deny', builtinToolDefaultsRevision: 1 };
    expect(await h.editor.revokeCommands(candidate, current, h.editor.capture(), () => h.sessions.prepareToolRevocation('old'),
      () => { h.sessions.get('old')!.config = candidate; })).toBe(true);
    expect(current.allowedTools).not.toContain('execute'); expect(h.editor.admissionAllowed).toBe(true);
    expect(h.persistence.loadAgents()[0]).toMatchObject({ executePreference: 'deny' });
    expect(h.persistence.loadAgents()[0].allowedTools).not.toContain('execute');
    await expect(h.sessions.start('old', { pin: 'reuse', onDemand: true })).resolves.toMatchObject({ id: 'old' });
    expect(h.sessions.get('old')!.config.allowedTools).not.toContain('execute');
    expect(h.sessions.get('old')!.config.executePreference).toBe('deny');
    await expect(h.replace(document('new'))).resolves.toBe(true);
    expect(h.backends).toHaveLength(2); expect(h.sessions.get('new')).toBeDefined();
    const unrelated = document('unrelated').members[0]; h.sessions.create(unrelated);
    await expect(h.sessions.start(unrelated.id, { pin: 'take' })).resolves.toMatchObject({ id: unrelated.id });
    expect(h.sessions.get('old')).toBeUndefined();
  });
  it.each(['absent', 'recommended'] as const)('actual preset entry stages and persists %s policy through the saved-team transaction', async policy => {
    const h = fixture({ ...document('old'), completionVerification: { mode: 'command', command: 'npm run old-check' } });
    const action = dialogs.teamActionItems(1).find(item => 'action' in item && item.action === 'preset'
      && (policy === 'recommended' ? !!item.preset.verifyCommand : !item.preset.verifyCommand)) as dialogs.TeamActionItem;
    const host = { agentRosterEdits: h.editor, sessionManager: h.sessions, persistence: h.persistence, hostShutdown: { started: false },
      get teamRosterRevision() { return h.revision(); }, set teamRosterRevision(value) { h.setRevision(value); },
      rosterNotifyTimer: undefined, defaultBackendKind: () => 'openai-compat', effectiveConnectionRegistry: {}, TeamReplacementRecoveryError,
      workflowEngine: { getActiveWorkflows: () => [], cancel: vi.fn() }, snapshotRosterBeforeReplace: vi.fn(async () => true),
      worktreeCoordinator: undefined, SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() },
      dialogs, pickCreateOrLoadTeamAction: async () => action, assertDefaultProviderCanCreateAgents: vi.fn(),
      context: { extensionMode: 3 }, vscode: { ...vscode, ExtensionMode: { Test: 3 } }, syncTeamRulesOnRosterChange: vi.fn(),
      dialogDeps: () => ({ sessionManager: h.sessions, defaultProvider: () => 'unode', defaultBackendKind: () => 'openai-compat',
        secrets: { has: async () => true }, output: { info: vi.fn() }, commandPolicy: { approvalMode: 'none' }, reloadCommandPolicy: vi.fn(),
        suppressInteractivePostCreatePrompts: policy !== 'recommended' }),
    };
    Object.assign(host, { restoreTeamDocument: actualExtensionFunction('restoreTeamDocument', host), openSavedTeam: vi.fn(),
      saveCurrentTeam: vi.fn(), restorePreviousTeam: vi.fn() });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Replace current team' as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Use Verify Command' as never);
    const incoming = await actualExtensionFunction('createOrLoadTeam', host)();
    expect(incoming.length).toBeGreaterThan(1);
    expect(h.sessions.get('old')).toBeUndefined();
    expect(h.sessions.getAll().map(session => session.id)).toEqual(incoming.map((config: AgentConfig) => config.id));
    const loaded = await h.persistence.loadTeamConfig({ strict: true });
    expect(loaded?.completionVerification).toEqual(policy === 'absent' ? undefined : {
      mode: 'command', command: (action as Extract<dialogs.TeamActionItem, { action: 'preset' }>).preset.verifyCommand });
    expect(host.snapshotRosterBeforeReplace).toHaveBeenCalledOnce();
    expect(h.editor.admissionAllowed).toBe(true); expect(h.sessions.getAll().every(session => session.status === 'stopped')).toBe(true);
  });
  it.each(['auto', 'disabled', undefined] as const)('replaces outgoing command with incoming %s, not the old team policy', async mode => {
    const old = { ...document('old'), completionVerification: { mode: 'command' as const, command: 'npm run old-check' } };
    const h = fixture(old); const incoming = document('new', mode);
    expect(await h.replace(incoming)).toBe(true);
    const saved = await h.persistence.loadTeamConfig({ strict: true });
    expect(saved?.completionVerification).toEqual(incoming.completionVerification);
    expect(h.sessions.getAll().map(s => s.id)).toEqual(['new']);
    expect(h.persistence.loadAgents()[0].allowedTools).toContain('execute');
    expect(h.snapshot.mock.calls[0][0]?.completionVerification).toEqual(old.completionVerification);
    const resolution = resolveCompletionVerificationPolicy({ workspaceId: 'workspace', completionVerification: saved?.completionVerification,
      agentSkills: incoming.members.flatMap(m => [m.skill, ...(m.skills?.map(s => s.id) ?? [])]), readLegacyGlobalCommand: () => 'npm run global-check' });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') expect(resolution.effective.policy.mode).toBe(mode ?? 'disabled');
  });
  it('preserves workspace-wide workflows/profiles and ignores those fields from a saved library', async () => {
    const h = fixture(); const old = await h.persistence.loadTeamConfig({ strict: true });
    const workflow = { id: 'local', name: 'Local', steps: [{ id: 'review', from: 'old', to: 'old', action: 'Review' }] };
    // Use the existing normalized document; the workspace-owned table travels through replacement, not the library's empty table.
    disk.files.set(target, Buffer.from(JSON.stringify({ ...old, workflows: [workflow] })));
    expect(await h.replace(document('new', 'disabled'))).toBe(true);
    expect((await h.persistence.loadTeamConfig({ strict: true }))?.workflows).toHaveLength(1);
  });
  it('holds readers, old settings saves, new starts and roster mutations until storage and publication settle', async () => {
    const h = fixture();
    const settings = new TeamVerificationEditor({ workspaceRoot: () => '/workspace', rosterRevision: h.revision,
      isCurrentWorkspace: () => h.editor.admissionAllowed, members: () => h.sessions.getAll().map(s => s.config),
      skills: () => [], configuration: () => ({ inspect: () => ({}) }),
      readDocument: () => h.persistence.loadTeamConfigForEdit(), updateDocument: edit => h.persistence.updateTeamConfig(edit) });
    const view = await settings.prepare(); if (view.kind !== 'ready' || !view.editToken) throw new Error('No form token');
    const written = deferred(); const release = deferred();
    disk.write = async (name, bytes) => { disk.files.set(name, Buffer.from(bytes)); written.resolve(); await release.promise; };
    const replacing = h.replace(document('new', 'disabled')); await written.promise;
    let readFinished = false; const read = h.persistence.loadTeamConfig({ strict: true }).then(value => { readFinished = true; return value; });
    const staleSave = settings.save(view.editToken, { mode: 'auto' }); const rejection = expect(staleSave).rejects.toThrow('save was not performed');
    try {
      await expect(h.sessions.start('old', { pin: 'take' })).rejects.toThrow();
      expect(() => h.sessions.create(document('intruder').members[0])).toThrow('being switched');
      await expect(h.sessions.remove('old')).rejects.toThrow('being switched');
      await Promise.resolve(); expect(readFinished).toBe(false); expect(h.sessions.getAll().map(s => s.id)).toEqual(['old']);
    } finally { release.resolve(); await replacing; await rejection; }
    expect(await replacing).toBe(true);
    expect((await read)?.completionVerification).toEqual({ mode: 'disabled' }); expect(h.editor.admissionAllowed).toBe(true);
  });
  it('stores an outgoing library snapshot using the exact queued policy without a nested read/deadlock', async () => {
    const h = fixture(document('old', 'auto'));
    h.snapshot.mockImplementationOnce(async source => {
      await h.persistence.saveTeamToLibrary({ scope: 'global', slug: 'before' }, 'Before', h.sessions.getAll().map(s => s.config),
        '2026-10-25T00:00:00Z', { document: source }); return true;
    });
    await h.replace(document('new', 'disabled'));
    expect(JSON.parse(Buffer.from(disk.files.get('/global/teams/before.json')!).toString()).completionVerification).toEqual({ mode: 'auto' });
  });
  it('cancelled snapshot leaves the current team running and writes nothing', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' }); h.snapshot.mockResolvedValueOnce(false);
    expect(await h.replace(document('new'))).toBe(false); expect(h.backends[0].stop).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled(); expect(h.sessions.get('old')?.status).toBe('idle');
  });
  it('requires observed process-tree stop rather than treating synchronous Stop/detach as completion', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' }); const stopped = deferred();
    h.backends[0].stop.mockImplementationOnce(async () => { await stopped.promise; return { stopped: true }; });
    const replacing = h.replace(document('new')); await vi.waitFor(() => expect(h.backends[0].stop).toHaveBeenCalledOnce());
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled(); expect(h.sessions.get('old')?.status).toBe('stopped');
    stopped.resolve(); expect(await replacing).toBe(true); expect(h.sessions.get('new')).toBeDefined();
    h.backends[0].oldHandler?.({ kind: 'delta', text: 'late old provider text' });
    expect(h.sessions.get('new')?.status).toBe('stopped'); expect(h.backends).toHaveLength(1);
  });
  it('does not hold the document lock while an old verifier/backend finishes a queued policy read during Stop', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' });
    h.backends[0].stop.mockImplementationOnce(async () => {
      expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'auto' });
      return { stopped: true };
    });
    expect(await h.replace(document('new', 'disabled'))).toBe(true);
    expect(h.sessions.get('new')).toBeDefined();
  }, 2000);
  it('preserves an edit made while stopping and refuses to overwrite it with a prepared incoming document', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' }); const edited = Buffer.from(JSON.stringify(document('external', 'disabled')));
    h.backends[0].stop.mockImplementationOnce(async () => { disk.files.set(target, edited); return { stopped: true }; });
    await expect(h.replace(document('new'))).rejects.toThrow('team file changed before switching');
    expect(disk.files.get(target)).toEqual(edited); expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(h.sessions.get('new')).toBeUndefined(); expect(h.editor.admissionAllowed).toBe(true);
  });
  it('force-stops an unconfirmed old runtime and publishes the new team without starting another backend', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' }); h.sessions.get('old')!.pid = 123456;
    const output: unknown[] = []; h.sessions.on('session.output', event => output.push(event));
    h.backends[0].stop.mockResolvedValueOnce({ stopped: false, detail: 'not observed' } as never);
    await expect(h.replace(document('new'))).resolves.toBe(true);
    expect(h.forceStopProcessTree).toHaveBeenCalledExactlyOnceWith(123456);
    expect(h.sessions.get('new')).toBeDefined(); expect(h.sessions.get('old')).toBeUndefined();
    expect(h.backends).toHaveLength(1); expect(output).toEqual(expect.arrayContaining([expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('force-stop request') }) })]));
  });
  it('after the existing Stop wait, a still-pending old stop no longer refuses the switch', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' }); const stopped = deferred();
    h.backends[0].stop.mockImplementationOnce(async () => { await stopped.promise; return { stopped: true }; });
    vi.useFakeTimers();
    try {
      const replacing = h.replace(document('new'));
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(replacing).resolves.toBe(true); expect(h.sessions.get('new')).toBeDefined();
    } finally { stopped.resolve(); await Promise.resolve(); vi.useRealTimers(); }
  });
  it('invalidates a pending manual merge review and switches teams', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' });
    (h.sessions as unknown as { manualLaneWork: Map<string, object> }).manualLaneWork.set('old', {});
    await expect(h.replace(document('new'))).resolves.toBe(true);
    expect(h.backends[0].stop).toHaveBeenCalledOnce(); expect(h.sessions.get('new')).toBeDefined();
  });
  it.each(['file-before', 'file-after', 'roster', 'publish'] as const)('restores exact old bytes and host roster after %s failure', async failure => {
    const h = fixture(); const original = Buffer.from(disk.files.get(target)!); const old = structuredClone(h.sessions.get('old')!.config);
    if (failure.startsWith('file')) {
      let first = true;
      disk.write = async (name, bytes) => {
        if (!first) { disk.files.set(name, Buffer.from(bytes)); return; } first = false;
        if (failure === 'file-after') disk.files.set(name, Buffer.from(bytes)); throw new Error('write failed');
      };
    }
    if (failure === 'roster') h.update.mockRejectedValueOnce(new Error('roster failed'));
    if (failure === 'publish') h.publish.mockRejectedValueOnce(new Error('publish failed'));
    await expect(h.replace(document('new', 'disabled'))).rejects.toThrow('failed');
    expect(Buffer.from(disk.files.get(target)!)).toEqual(original);
    expect(h.sessions.getAll().map(s => s.config)).toEqual([old]); expect(h.persistence.loadAgents()).toEqual([old]);
    expect(h.editor.admissionAllowed).toBe(true);
  });
  it('a refused roster save preserves the old SessionInfo, conversation snapshot and CLI pin without clearing them', async () => {
    const h = fixture(); const old = h.sessions.get('old');
    const snapshot = { privateConversation: 'do not delete' }; const pin = { privatePin: 'pinned-program' };
    h.values.set('roam.snapshot.old', snapshot); h.values.set('unode.runtimePin.v1.old', pin);
    h.update.mockRejectedValueOnce(new Error('roster failed'));
    await expect(h.replace(document('new'))).rejects.toThrow('roster failed');
    expect(h.sessions.get('old')).toBe(old); expect(h.clearSnapshot).not.toHaveBeenCalled(); expect(h.clearPin).not.toHaveBeenCalled();
    expect(h.values.get('roam.snapshot.old')).toEqual(snapshot); expect(h.values.get('unode.runtimePin.v1.old')).toEqual(pin);
  });
  it('rolls back after the new roster is live and restores storage already deleted by a failed cleanup', async () => {
    const h = fixture(); const snapshot = { privateConversation: 'original' }; const pin = { privatePin: 'original' };
    h.values.set('roam.snapshot.old', snapshot); h.values.set('unode.runtimePin.v1.old', pin);
    h.clearSnapshot.mockImplementationOnce(async id => {
      await h.persistence.clearSnapshot(id);
      expect(h.sessions.getAll().map(s => s.id)).toEqual(['new']); expect(h.editor.admissionAllowed).toBe(false);
      throw new Error('cleanup failed after publication');
    });
    await expect(h.replace(document('new', 'disabled'))).rejects.toThrow('cleanup failed');
    const file = await h.persistence.loadTeamConfig({ strict: true });
    expect(h.sessions.getAll().map(s => s.id)).toEqual(['old']); expect(file?.members.map(m => m.id)).toEqual(['old']);
    expect(file?.completionVerification).toEqual({ mode: 'auto' }); expect(h.editor.admissionAllowed).toBe(true);
    expect(h.values.get('roam.snapshot.old')).toEqual(snapshot); expect(h.values.get('unode.runtimePin.v1.old')).toEqual(pin);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });
  it('drains the last queued conversation save before taking a rollback backup', async () => {
    const h = fixture(); const saved = deferred();
    const latest = { backend: 'openai-compat', messages: [{ role: 'assistant', content: 'last answer' }] } as unknown as ConversationSnapshot;
    h.values.set('roam.snapshot.old', { messages: ['earlier answer'] });
    h.update.mockImplementationOnce(async (key, value) => { await saved.promise; h.values.set(key, structuredClone(value)); });
    // Exercise the real per-agent queue; only its storage boundary is held, not prepareRosterReplacement.
    const saving = (h.sessions as unknown as { saveConversation(id: string, value: ConversationSnapshot): Promise<void> }).saveConversation('old', latest);
    h.clearSnapshot.mockImplementationOnce(async id => { await h.persistence.clearSnapshot(id); throw new Error('cleanup failed'); });
    const replacing = h.replace(document('new')).then(() => undefined, error => error);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.snapshot).toHaveBeenCalledOnce();
      expect(h.publish).not.toHaveBeenCalled(); // K16 would already back up stale data and start publication.
      expect(JSON.parse(Buffer.from(disk.files.get(target)!).toString()).members[0].id).toBe('old');
    } finally { saved.resolve(); await saving; }
    expect(await replacing).toMatchObject({ message: 'cleanup failed' });
    expect(h.values.get('roam.snapshot.old')).toEqual(latest);
    expect(h.sessions.getAll().map(session => session.id)).toEqual(['old']);
  });
  it('restores absence, not a newly materialized policy file, when the original file was missing', async () => {
    const h = fixture(undefined); disk.files.delete(target); h.update.mockRejectedValueOnce(new Error('store failed'));
    await expect(h.replace(document('new'))).rejects.toThrow('store failed'); expect(disk.files.has(target)).toBe(false);
    expect(h.sessions.get('old')).toBeDefined();
  });
  it('leaves external changed bytes alone and fences admission when automatic recovery cannot be proved', async () => {
    const h = fixture(); const external = Buffer.from('{"external":"do not overwrite"}');
    let first = true;
    disk.write = async (name, bytes) => {
      if (first) { first = false; disk.files.set(name, external); throw new Error('uncertain write'); }
      disk.files.set(name, Buffer.from(bytes));
    };
    await expect(h.replace(document('new'))).rejects.toBeInstanceOf(TeamReplacementRecoveryError);
    expect(disk.files.get(target)).toEqual(external); expect(h.editor.admissionAllowed).toBe(true);
    await expect(h.editor.save()).resolves.toBeUndefined(); expect(h.sessions.get('new')).toBeUndefined();
  });
  it('keeps admission open if host-roster recovery itself fails, without reporting success', async () => {
    const h = fixture(); const original = Buffer.from(disk.files.get(target)!);
    h.update.mockRejectedValueOnce(new Error('new roster failed')).mockRejectedValueOnce(new Error('old roster failed'));
    await expect(h.replace(document('new'))).rejects.toBeInstanceOf(TeamReplacementRecoveryError);
    expect(Buffer.from(disk.files.get(target)!)).toEqual(original); expect(h.editor.admissionAllowed).toBe(true);
    expect(h.sessions.get('new')).toBeUndefined();
  });
  it('rejects stale A→B→A picker callbacks and simultaneous replacements', async () => {
    const h = fixture(); const oldTarget = h.editor.capture(); const write = deferred(); const release = deferred();
    disk.write = async (name, bytes) => { disk.files.set(name, Buffer.from(bytes)); write.resolve(); await release.promise; };
    const replacing = h.replace(document('B')); await write.promise;
    await expect(h.replace(document('C'))).rejects.toThrow('team changed'); release.resolve(); await replacing;
    disk.write = undefined; await h.replace(document('old', 'auto'));
    await expect(h.replace(document('stale'), oldTarget)).rejects.toThrow('team changed'); expect(h.sessions.get('stale')).toBeUndefined();
  });
  it('validates incoming and existing policy before stopping any agent', async () => {
    const h = fixture(); await h.sessions.start('old', { pin: 'take' });
    await expect(h.replace({ ...document('new'), completionVerification: { mode: 'invalid' } } as never)).rejects.toThrow();
    disk.files.set(target, Buffer.from('{"completionVerification":{"mode":"invalid"}}'));
    await expect(h.replace(document('new'))).rejects.toThrow('current team configuration is invalid');
    expect(h.backends[0].stop).not.toHaveBeenCalled(); expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
  it('waits for snapshot and runtime-pin clearing before releasing new task admission', async () => {
    const h = fixture(); const cleanup = deferred(); h.clearPin.mockImplementationOnce(async () => cleanup.promise);
    const replacing = h.replace(document('new')); await vi.waitFor(() => expect(h.sessions.get('new')).toBeDefined());
    expect(h.editor.admissionAllowed).toBe(false); await expect(h.sessions.start('new', { pin: 'take' })).rejects.toThrow();
    cleanup.resolve(); await replacing; expect(h.editor.admissionAllowed).toBe(true); expect(h.clearSnapshot).toHaveBeenCalledWith('old');
  });
  it.each(['success', 'recovery-failed'] as const)('actual extension restoreTeamDocument wires policy, snapshot, workflow stop and %s admission', async outcome => {
    const h = fixture(); const rawOldPolicy = { mode: 'auto' };
    const workflowEngine = { getActiveWorkflows: () => [{ id: 'live-workflow', status: 'running' }, { id: 'finished-workflow', status: 'completed' }], cancel: vi.fn() };
    const worktreeDone = deferred(); let releases = 0;
    const worktreeCoordinator = { release: vi.fn(async () => { if (++releases === 2) await worktreeDone.promise; }) };
    const oldRosterNotice = {};
    const host = { agentRosterEdits: h.editor, sessionManager: h.sessions, persistence: h.persistence, hostShutdown: { started: false },
      get teamRosterRevision() { return h.revision(); }, set teamRosterRevision(value) { h.setRevision(value); },
      rosterNotifyTimer: oldRosterNotice as object | undefined, clearTimeout: vi.fn(),
      defaultBackendKind: () => 'openai-compat', effectiveConnectionRegistry: {}, workflowEngine, worktreeCoordinator, TeamReplacementRecoveryError,
      snapshotRosterBeforeReplace: vi.fn(async (source: { document: TeamFileDocument | undefined }) => {
        expect(source.document?.completionVerification).toEqual(rawOldPolicy); return true;
      }), SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() } };
    const restore = actualExtensionFunction('restoreTeamDocument', host);
    if (outcome === 'recovery-failed') {
      h.update.mockRejectedValueOnce(new Error('store failed')).mockRejectedValueOnce(new Error('recovery failed'));
      await expect(restore(document('new'), h.editor.capture())).rejects.toBeInstanceOf(TeamReplacementRecoveryError);
      expect(h.editor.admissionAllowed).toBe(true); return;
    }
    const restoring = restore(document('new', 'disabled'), h.editor.capture());
    await vi.waitFor(() => expect(worktreeCoordinator.release).toHaveBeenCalledTimes(2));
    try { expect(h.editor.admissionAllowed).toBe(false); }
    finally { worktreeDone.resolve(); await restoring; }
    expect(await restoring).toBe(true);
    expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'disabled' });
    expect(h.sessions.getAll().map(s => s.id)).toEqual(['new']);
    expect(workflowEngine.cancel).toHaveBeenCalledExactlyOnceWith('live-workflow');
    expect(host.clearTimeout).toHaveBeenCalledExactlyOnceWith(oldRosterNotice); expect(host.rosterNotifyTimer).toBeUndefined();
    expect(host.SettingsPanel.refreshTeamCurrent).toHaveBeenCalledOnce(); expect(h.editor.admissionAllowed).toBe(true);
  });
  it.each(['global', 'workspace-stale-review', 'source-changed', 'source-changed-during-switch', 'recognised-deny'] as const)('actual openSavedTeam carries the full document and fences %s completion', async route => {
    const h = fixture(); const incoming = document('new', 'disabled'); const ref = { scope: route === 'global' ? 'global' as const : 'workspace' as const, slug: 'saved' };
    const permissionSource = structuredClone(incoming.members);
    if (route === 'recognised-deny') {
      permissionSource[0].executePreference = 'deny'; permissionSource[0].allowedTools = ['read'];
      delete incoming.members[0].executePreference; delete incoming.members[0].builtinToolDefaultsRevision; incoming.members[0].allowedTools = ['read'];
    }
    vi.spyOn(h.persistence, 'listSavedTeams').mockResolvedValue([{ ...ref, label: 'Saved', savedAt: '', memberCount: 1 }]);
    vi.spyOn(h.persistence, 'loadSavedTeamWithTrust').mockResolvedValue({ document: incoming, permissionSource, fingerprintMatched: true });
    const sourceMatches = vi.spyOn(h.persistence, 'savedTeamSourceMatches').mockResolvedValue(route !== 'source-changed');
    if (route === 'source-changed-during-switch') sourceMatches.mockResolvedValue(false).mockResolvedValueOnce(true);
    const host = { agentRosterEdits: h.editor, sessionManager: h.sessions, persistence: h.persistence, hostShutdown: { started: false },
      get teamRosterRevision() { return h.revision(); }, set teamRosterRevision(value) { h.setRevision(value); },
      rosterNotifyTimer: undefined,
      defaultBackendKind: () => 'openai-compat', effectiveConnectionRegistry: {}, TeamReplacementRecoveryError,
      workflowEngine: { getActiveWorkflows: () => [], cancel: vi.fn() }, snapshotRosterBeforeReplace: async () => true,
      worktreeCoordinator: undefined,
      SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() },
      vscode, showResultNotice: vi.fn(), filterReviewedPermissionWarnings: () => [], savedPermissionSummary: () => 'Saved grants',
      savedCommandPreference, restoredCommandTools,
      shouldReviewSavedPermissions: () => false, savedPermissionLoadResult: () => 'Loaded.',
      restoreAllSavedPermissions: vi.fn(async (_members: AgentConfig[], isCurrent: () => boolean) => {
        expect(isCurrent()).toBe(true);
        if (route !== 'recognised-deny') { await h.replace(document('another-team', 'auto')); expect(isCurrent()).toBe(false); }
        return { regainedPermissionAgents: 0, failures: [] };
      }) };
    Object.assign(host, { restoreTeamDocument: actualExtensionFunction('restoreTeamDocument', host) });
    const open = actualExtensionFunction('openSavedTeam', host);
    if (route === 'source-changed-during-switch') {
      await expect(open(ref)).rejects.toThrow('saved team changed while switching');
      expect(h.sessions.getAll().map(s => s.id)).toEqual(['old']); expect(h.editor.admissionAllowed).toBe(true);
      expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'auto' });
      expect(host.restoreAllSavedPermissions).not.toHaveBeenCalled(); return;
    }
    const result = await open(ref);
    if (route === 'global') {
      expect(result.map((config: AgentConfig) => config.id)).toEqual(['new']);
      expect((await h.persistence.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'disabled' });
      expect(host.restoreAllSavedPermissions).not.toHaveBeenCalled();
    } else if (route === 'workspace-stale-review') {
      expect(result).toEqual([]); expect(h.sessions.getAll().map(s => s.id)).toEqual(['another-team']);
      expect(host.showResultNotice).not.toHaveBeenCalled();
    } else if (route === 'recognised-deny') {
      // v0.9.99 B9: a recognised save restores its permissions with no question, and an explicit Run commands Off
      // saved in it stays Off on this path.
      expect(result[0].executePreference).toBe('deny'); expect(result[0].allowedTools).toEqual(['read']);
      expect(host.restoreAllSavedPermissions).toHaveBeenCalledOnce();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual([]); expect(h.sessions.getAll().map(s => s.id)).toEqual(['old']);
      expect(host.showResultNotice).toHaveBeenCalledExactlyOnceWith('warning', expect.stringContaining('saved team changed'));
      expect(host.restoreAllSavedPermissions).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])('actual restore-all mints command context only for verified source=%s, never from permissionSource alone', async trusted => {
    const member = document('new').members[0]; member.executePreference = 'allow';
    const apply = vi.fn(async () => ({ ok: true, message: '', granted: false }));
    const host = { restoreSavedPermissionsIndividually, savedCommandPreference, savedPermissionSkillIds: () => [], applySavedAgentPermissions: apply };
    const sourceCurrent = async () => true; const isCurrent = () => true;
    await actualExtensionFunction('restoreAllSavedPermissions', host)([member], isCurrent, trusted, sourceCurrent);
    expect(apply).toHaveBeenCalledExactlyOnceWith(member, [], member.playbooks, isCurrent,
      trusted ? { roleKey: member.roleTemplateKey, preference: 'allow' } : undefined, sourceCurrent);
  });
});
