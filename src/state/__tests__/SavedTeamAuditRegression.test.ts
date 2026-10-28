import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { AgentBackend, BackendEventHandler } from '../../backend/AgentBackend';

const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), root: '/workspace' }));
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  FileType: { File: 1, Directory: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (uri: { fsPath: string; scheme?: string }, ...parts: string[]) => ({ fsPath: [uri.fsPath, ...parts].join('/'), scheme: 'file' }) },
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: disk.root, scheme: 'file' } }]; }, fs: {
    readFile: vi.fn(async (uri: { fsPath: string }) => {
      const bytes = disk.files.get(uri.fsPath); if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return bytes;
    }),
    readDirectory: vi.fn(async (uri: { fsPath: string }) => {
      const prefix = uri.fsPath + '/';
      const names = [...disk.files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map(k => [k.slice(prefix.length), 1]);
      if (names.length === 0) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return names;
    }),
    createDirectory: vi.fn(async () => {}),
    writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => { disk.files.set(uri.fsPath, Buffer.from(bytes)); }),
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
import { AgentConfigBuilder, ROLE_TEMPLATES, SKILL_LIBRARY } from '../../roles/RoleConfig';
import { SkillResolver } from '../../roles/SkillResolver';
import { savedPermissionSkillIds, shouldReviewSavedPermissions } from '../SavedPermissionReview';
import { automaticSnapshotSlug, automaticSnapshotsToPrune } from '../TeamLibrary';
import { savedCommandPreference, restoredCommandTools } from '../SavedPermissionRestore';

function actualExtensionFunction(name: string, host: object) {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source); expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', 'migrateLegacyCommandTools', 'legacyCommandMigrationNotice', 'outputChannel',
    `with (host) { ${code}; return ${name}; }`)(host, migrateLegacyCommandTools, legacyCommandMigrationNotice, { info: vi.fn() });
}
function document(id: string, mode?: 'auto' | 'disabled'): TeamFileDocument {
  return { version: '1.0', members: [new AgentConfigBuilder().fromTemplate('business-analyst').setId(id).build()],
    workflows: [], mcpServers: [], ...(mode ? { completionVerification: { mode } } : {}) };
}
function fixture() {
  const values = new Map<string, unknown>(); let revision = 0;
  disk.files.set('/workspace/.unode/team.json', Buffer.from(JSON.stringify(document('old', 'auto'), null, 4) + '\n'));
  const update = vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); });
  const persistence = new PersistenceManager({ workspaceState: { get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
    keys: () => [...values.keys()], update }, globalStorageUri: { fsPath: '/global' } } as never, undefined, () => '/workspace');
  const editor = new AgentRosterEdits({ members: () => sessions.getAll().map(s => s.config), revision: () => revision,
    currentWorkspace: () => true, persist: members => persistence.saveAgents(members) });
  const clearSnapshot = vi.fn(async () => {});
  const sessions = new SessionManager(4, new MessageBus(), {
    workspaceAvailable: () => editor.admissionAllowed, rosterChangeAllowed: () => editor.admissionAllowed,
    createBackend: config => {
      const backend = { agentId: config.id, start: vi.fn(async () => { backend.oldHandler?.({ kind: 'ready' }); }), stop: vi.fn(async () => ({ stopped: true })),
        isAlive: () => true, onEvent: (handler: BackendEventHandler) => { backend.oldHandler = handler; return () => {}; },
        oldHandler: undefined as BackendEventHandler | undefined, sendUserTurn: vi.fn(), abort: vi.fn() };
      return backend as AgentBackend;
    }, resolveEnv: async () => ({}), clearSnapshot, clearRuntimePin: async () => {},
  });
  sessions.on('session.created', () => { revision++; }); sessions.on('session.removed', () => { revision++; });
  sessions.create(document('old').members[0]);
  const host: Record<string, unknown> = { agentRosterEdits: editor, sessionManager: sessions, persistence, hostShutdown: { started: false },
    get teamRosterRevision() { return revision; }, set teamRosterRevision(value: number) { revision = value; },
    rosterNotifyTimer: undefined, defaultBackendKind: () => 'openai-compat', effectiveConnectionRegistry: {}, TeamReplacementRecoveryError,
    workflowEngine: { getActiveWorkflows: () => [], cancel: vi.fn() }, worktreeCoordinator: undefined,
    SettingsPanel: { refreshTeamCurrent: vi.fn() }, teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() },
    vscode, showResultNotice: vi.fn(), filterReviewedPermissionWarnings: () => [], savedPermissionSummary: () => 'Saved grants',
    savedCommandPreference, restoredCommandTools, reviewLegacyCommandTools: vi.fn(async () => {}),
    shouldReviewSavedPermissions: () => false, savedPermissionLoadResult: () => 'Loaded.', restoreAllSavedPermissions: vi.fn(),
    automaticSnapshotSlug, automaticSnapshotsToPrune, outputChannel: { error: vi.fn(), info: vi.fn() } };
  Object.assign(host, { ROLE_TEMPLATES, SKILL_LIBRARY, skillResolver: new SkillResolver(SKILL_LIBRARY), savedPermissionSkillIds });
  host.snapshotRosterBeforeReplace = actualExtensionFunction('snapshotRosterBeforeReplace', host);
  host.restoreTeamDocument = actualExtensionFunction('restoreTeamDocument', host);
  const openSavedTeam = actualExtensionFunction('openSavedTeam', host);
  return { persistence, sessions, editor, host, openSavedTeam, update, clearSnapshot };
}

beforeEach(() => { disk.files.clear(); vi.clearAllMocks(); });

describe('audit regression: saved-team snapshots and legacy native command ceilings', () => {
  it.each([true, false])('v0.9.99 B9: a recognised project save loads its saved Codex Full access with no question; a copied file does not (recognised=%s)', async recognised => {
    const h = fixture(); const ref = { scope: 'workspace' as const, slug: 'codex-full' };
    const member = { ...new AgentConfigBuilder().fromTemplate('business-analyst').setProviderById('codex').setId('codex').build(), backend: 'codex' as const, codexPermissionProfile: 'full-access' as const };
    await h.persistence.saveTeamToLibrary(ref, 'Codex Full', [member]);
    const saved = await h.persistence.loadSavedTeamWithTrust(ref);
    vi.spyOn(h.persistence, 'loadSavedTeamWithTrust').mockResolvedValue({ ...saved!, fingerprintMatched: recognised, permissionSource: [member],
      document: { ...saved!.document, members: [{ ...saved!.document.members[0], backend: 'codex', provider: member.provider }] } });
    h.host.savedPermissionSummary = () => 'saved';
    h.host.shouldReviewSavedPermissions = shouldReviewSavedPermissions;
    h.host.reviewSavedPermissions = vi.fn(async () => 0);
    h.host.restoreAllSavedPermissions = vi.fn(async () => ({ regainedPermissionAgents: 1, failures: [] }));
    const loaded = await h.openSavedTeam(ref);
    expect(loaded).toMatchObject([{ id: 'codex', codexPermissionProfile: recognised ? 'full-access' : 'approve-for-me' }]);
    // No "Restore saved permissions / Load read-only" question on either path.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.some(call => (call[1] as { modal?: boolean } | undefined)?.modal)).toBe(false);
    expect(h.host.restoreAllSavedPermissions).toHaveBeenCalledTimes(recognised ? 1 : 0);
    // A copied file still goes to the unticked per-agent review.
    expect(h.host.reviewSavedPermissions).toHaveBeenCalledTimes(recognised ? 0 : 1);
  });
  it('an actual read-only project load keeps built-in commands and excludes them from the removal notice and review', async () => {
    const h = fixture(); const ref = { scope: 'workspace' as const, slug: 'builtin' };
    const desired = document('new').members[0]; desired.allowedTools = ['read', 'execute'];
    await h.persistence.saveTeamToLibrary(ref, 'Built-in', [desired]);
    // An unrecognised project copy uses the explicit unticked review, not trusted restoration.
    const load = await h.persistence.loadSavedTeamWithTrust(ref);
    vi.spyOn(h.persistence, 'loadSavedTeamWithTrust').mockResolvedValue({ ...load!, fingerprintMatched: false, permissionSource: [desired] });
    h.host.shouldReviewSavedPermissions = () => true;
    h.host.permissionToolLabel = actualExtensionFunction('permissionToolLabel', h.host);
    h.host.savedPermissionSummary = actualExtensionFunction('savedPermissionSummary', h.host);
    h.host.permissionPicks = actualExtensionFunction('permissionPicks', h.host);
    h.host.reviewSavedPermissions = vi.fn(async () => 0);
    const members = await h.openSavedTeam(ref);
    expect(members[0].allowedTools).toContain('execute');
    const notice = vi.mocked(h.host.showResultNotice as any).mock.calls.find((call: any[]) => call[0] === 'warning')?.[1];
    expect(notice).toContain('Built-in agents can still run commands; turn it off per agent in Agent Builder.');
    expect(notice).not.toContain('; run commands');
    const summary = (h.host.savedPermissionSummary as any)([desired]); expect(summary).not.toContain('run commands');
    const picks = (h.host.permissionPicks as any)(desired); expect(JSON.stringify(picks)).not.toContain('run commands');
  });
  it('actual snapshot failure is a reminder and never opens another switch confirmation', async () => {
    const h = fixture(); vi.spyOn(h.persistence, 'saveTeamToLibrary').mockRejectedValueOnce(new Error('disk full'));
    const snapshot = actualExtensionFunction('snapshotRosterBeforeReplace', h.host);
    await expect(snapshot({ document: document('old') })).resolves.toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('Switching will continue'));
  });
  it('unknown saved settings show one reminder instead of an extra confirmation', async () => {
    const h = fixture(); const ref = { scope: 'global' as const, slug: 'unknown-settings' };
    await h.persistence.saveTeamToLibrary(ref, 'Unknown settings', document('new').members);
    h.host.filterReviewedPermissionWarnings = () => ['unknown-field'];
    await expect(h.openSavedTeam(ref)).resolves.toMatchObject([{ id: 'new' }]);
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.some(call => (call[1] as { modal?: boolean } | undefined)?.modal)).toBe(false);
    expect(h.host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('will be ignored'));
  });
  it('PROBE-1 restoring the oldest of ten automatic snapshots', async () => {
    const h = fixture();
    const slugs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const when = new Date(Date.UTC(2026, 9, 1 + i));
      const slug = automaticSnapshotSlug(when); slugs.push(slug);
      await h.persistence.saveTeamToLibrary({ scope: 'workspace', slug }, `snap ${i}`, document(`snap${i}`).members, when.toISOString(), { document: document(`snap${i}`, 'disabled') });
    }
    const oldest = { scope: 'workspace' as const, slug: slugs[0] };
    await expect(h.openSavedTeam(oldest)).resolves.toMatchObject([{ id: 'snap0' }]);
    expect(disk.files.has(`/workspace/.unode/teams/${slugs[0]}.json`)).toBe(true);
    expect(h.sessions.getAll().map(s => s.id)).toEqual(['snap0']);
    expect((await h.persistence.listSavedTeams()).filter(entry => entry.scope === 'workspace' && entry.automatic)).toHaveLength(10);
  });
  it.each(['native-default', undefined] as const)('PROBE-3 legacy Codex %s (effective execute) moved to Claude keeps Run commands', async toolCeiling => {
    const { agentBuilderTools } = await import('../../roles/AgentBuilderTools');
    const { SKILL_LIBRARY } = await import('../../roles/RoleConfig');
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
    Object.assign(current, { backend: 'codex', allowedTools: [], toolCeiling });
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const sameBackend = agentBuilderTools({ roleKey: 'contract-analyst', current, skills: [SKILL_LIBRARY.documentation], backend: 'codex' });
    const moved = agentBuilderTools({ roleKey: 'contract-analyst', current, skills: [SKILL_LIBRARY.documentation], backend: 'claude' });
    const movedWithExecuteSkill = agentBuilderTools({ roleKey: 'contract-analyst', current, skills: [SKILL_LIBRARY.testing], backend: 'claude' });
    expect(sameBackend.toolCeiling).toBe('native-default');
    expect(moved.allowedTools).toContain('execute');
    expect(movedWithExecuteSkill.allowedTools).toContain('execute');
  });
  it('PROBE-4 publication that fails after the new roster is live is rolled back to the old roster', async () => {
    const h = fixture();
    h.host.snapshotRosterBeforeReplace = async () => true;
    h.host.restoreTeamDocument = actualExtensionFunction('restoreTeamDocument', h.host);
    h.clearSnapshot.mockRejectedValueOnce(new Error('snapshot clear failed'));
    const out = await (h.host.restoreTeamDocument as (d: TeamFileDocument, c: () => boolean) => Promise<boolean>)(document('new', 'disabled'), h.editor.capture())
      .then(v => `ok ${v}`, (e: Error) => `error ${e.constructor.name}: ${e.message}`);
    const file = await h.persistence.loadTeamConfig({ strict: true });
    expect(out).toContain('snapshot clear failed');
    expect(file?.members.map(m => m.id)).toEqual(['old']);
    expect(h.sessions.getAll().map(s => s.id)).toEqual(file?.members.map(m => m.id));
  });
  it('PROBE-2 a refused switch before publication keeps the outgoing session (no snapshot clear)', async () => {
    const h = fixture();
    h.host.snapshotRosterBeforeReplace = async () => true;
    h.host.restoreTeamDocument = actualExtensionFunction('restoreTeamDocument', h.host);
    const oldInfo = h.sessions.get('old');
    h.update.mockRejectedValueOnce(new Error('new roster failed'));
    await expect((h.host.restoreTeamDocument as (d: TeamFileDocument, c: () => boolean) => Promise<boolean>)(document('new'), h.editor.capture())).rejects.toThrow('new roster failed');
    expect(h.clearSnapshot).not.toHaveBeenCalled();
    expect(h.sessions.get('old')).toBe(oldInfo);
  });
});
